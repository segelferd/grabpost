// background.js — service worker. content.js artık medya URL'lerini
// DOM'dan çözüp hazır olarak gönderiyor; burada tek iş chrome.downloads
// ile diske yazmak. Reddit API'sine tekrar istek atmıyoruz.

import {
  getSettings,
  markPostDownloaded,
  isPostDownloaded,
  getSubscriptions,
  MAX_FAVORITES,
  updateSubscription,
  migrateSubscriptionsToSyncIfNeeded,
  addPendingPosts,
  clearPendingPosts,
  removePendingPosts,
  withStorageLock,
  migrateDownloadedPostsIfNeeded,
  restoreSettingsFromSyncIfFresh,
  mergeRecoveredRecords,
  exportBackup,
  mirrorSettingsToSync,
  addFailedDownload,
  removeFailedDownload,
  undoDownloadRecord,
  getFailedDownloads,
  isMediaHashSeen,
  markMediaHashSeen,
  findSimilarPerceptualHash,
  markPerceptualHashSeen,
} from "./storage.js";
import { buildFilePath } from "./utils.js";
import { extractMediaFromPostData, postHasMedia } from "./media.js";
import { createLogger } from "./log.js";
import { handleProcessingMessage } from "./processing.js";

const log = createLogger("bg");

/**
 * v1.47.0 FIREFOX UYUMU: Aynı kaynak kod iki tarayıcıda çalışıyor.
 * Firefox'ta: offscreen API yok (işleme arka planda doğrudan yapılıyor),
 * yan panel yerine kenar çubuğu (sidebar) var, onDeterminingFilename yok
 * (dosya adı doğrudan uygulanıyor), bildirimlerde buton desteği yok.
 */
const IS_FIREFOX = typeof browser !== "undefined" && typeof chrome.offscreen === "undefined";

/** Bildirim oluşturur; Firefox'un desteklemediği alanları (buttons, priority) çıkarır. */
function notify(id, options) {
  const opts = { ...options };
  if (IS_FIREFOX) {
    delete opts.buttons;
    delete opts.priority;
  }
  return chrome.notifications.create(id, opts);
}
import { t, tf, detectDefaultLanguage } from "../locales.js";

/** Bildirim metinleri için kullanıcının seçtiği dil (ayar yoksa tarayıcı dili). */
async function getUiLang() {
  const settings = await getSettings();
  return settings.language || detectDefaultLanguage();
}

// Araç çubuğu ikonuna tıklandığında yan paneli (indirme geçmişi) açar.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    log.error("sidePanel.setPanelBehavior hatası:", error);
  });
} else if (typeof browser !== "undefined" && browser.sidebarAction?.toggle) {
  // Firefox: araç çubuğu simgesine tıklayınca kenar çubuğunu (sidebar) aç/kapat.
  chrome.action.onClicked.addListener(() => browser.sidebarAction.toggle());
}

/** urls+title'dan basit bir tekrar-indirmeyi-önleme anahtarı üretir. */
function makeDedupeKey(meta, media) {
  const raw = `${meta.subreddit}|${meta.author}|${meta.title}|${media.urls[0] || ""}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  return `post-${hash}`;
}

/**
 * ÖNEMLİ DÜZELTME: Görsele başlık yazısı ekleme işlemini burada (service
 * worker'da) yapmaya çalışıyorduk ama `URL.createObjectURL()` service
 * worker ortamında HİÇ YOK — Chrome'un bilinen bir Manifest V3 kısıtlaması.
 * Bu yüzden bu özellik her zaman sessizce başarısız oluyordu. Video başlık
 * yazısı için zaten kullandığımız offscreen document çözümünü şimdi
 * görseller için de kullanıyoruz — asıl işlem artık offscreen.js'de,
 * aşağıdaki downloadImageWithTitleOverlay() sadece ona mesaj gönderiyor.
 */
/**
 * ÖNEMLİ: Chrome'un RESMİ dokümantasyonunda açıkça yazıyor: "filename is
 * ignored if there are any onDeterminingFilename listeners registered by
 * any extensions." Yani bu dinleyiciyi eklediğimiz ANDAN itibaren,
 * chrome.downloads.download()'a verdiğimiz `filename` seçeneği artık HİÇ
 * kullanılmıyor — sadece data: URL'ler için değil, TÜM indirmelerimiz
 * için. (İki önceki deneme de bu yüzden başarısız oldu: "argümansız
 * suggest()" Chrome'un kendi URL-tabanlı adını üretmesine sebep oluyordu;
 * "downloadItem.filename" de her zaman Chrome'un o URL-tabanlı adını
 * içeriyor, bizim isteğimizi değil.)
 *
 * Doğru çözüm: TEK bir merkezi liste — indirmeye başlamadan hemen önce,
 * o indirmenin adresini ve istediğimiz dosya adını buraya kaydediyoruz.
 * Bu dinleyici HER indirmemiz için bu listeden gerçek adı bulup suggest()
 * ediyor. Bize ait olmayan (listede bulunmayan) bir indirme gelirse
 * (teorik olarak olmamalı, güvenlik için) hiç karışmıyoruz.
 */
const pendingFilenames = [];
const HAS_FILENAME_HOOK = !!chrome.downloads.onDeterminingFilename; // Firefox'ta yok: orada "filename" seçeneği zaten uygulanıyor
if (HAS_FILENAME_HOOK) chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const idx = pendingFilenames.findIndex((p) => p.url === downloadItem.url);
  if (idx === -1) return; // bize ait olmayan bir indirme, hiç karışma
  const { filename, conflictAction } = pendingFilenames[idx];
  pendingFilenames.splice(idx, 1);
  suggest(conflictAction ? { filename, conflictAction } : { filename });
});

/** Bir indirmeyi, dosya adının GERÇEKTEN uygulanacağından emin olarak başlatır. */
/**
 * v1.48.1 İNDİRME ETİKETİ: Her indirmenin adresine görünmez bir etiket
 * ekleniyor: "#gp=k=<gönderi>&s=<subreddit>&a=<kullanıcı>&t=<başlık>".
 * Adresin "#" sonrası sunucuya hiç gönderilmez (indirmeyi etkilemez) ama
 * Chrome bunu KENDİ indirme geçmişinde saklar. Eklenti kaldırılıp yeniden
 * kurulsa bile (eklenti verisi silinir, Chrome'un indirme geçmişi silinmez)
 * "indirildi" belleği ve Geçmiş listesi bu etiketlerden geri kurulabiliyor
 * (bkz. recoverFromDownloadHistory). Kuyruk tek tek işlendiği için etiket,
 * o an işlenen gönderiye ait.
 */
let activeDownloadTag = null;
const DOWNLOAD_TAG_MARK = "#gp=";

function buildDownloadTag(key, meta) {
  if (!key) return null;
  const q = new URLSearchParams();
  q.set("k", String(key));
  if (meta?.subreddit) q.set("s", String(meta.subreddit));
  if (meta?.author) q.set("a", String(meta.author));
  if (meta?.title) q.set("t", Array.from(String(meta.title)).slice(0, 80).join(""));
  return encodeURIComponent(q.toString());
}

function withDownloadTag(url, tag) {
  if (!tag || /^data:/i.test(url)) return url;
  return url.split("#")[0] + DOWNLOAD_TAG_MARK + tag;
}

async function downloadWithFilename(url, filename, { noTag = false, conflictAction = null } = {}) {
  url = noTag ? url : withDownloadTag(url, activeDownloadTag);
  const opts = conflictAction ? { url, filename, conflictAction } : { url, filename };
  if (!HAS_FILENAME_HOOK) return chrome.downloads.download(opts);
  pendingFilenames.push({ url, filename, conflictAction });
  try {
    return await chrome.downloads.download(opts);
  } catch (error) {
    const idx = pendingFilenames.findIndex((p) => p.url === url);
    if (idx !== -1) pendingFilenames.splice(idx, 1);
    throw error;
  }
}

async function downloadDataUrlWithFilename(dataUrl, filename) {
  pendingFilenames.push({ url: dataUrl, filename });
  try {
    return await chrome.downloads.download({ url: dataUrl, filename });
  } catch (error) {
    // Beklenmedik bir hata olursa bekleyen kaydı temizle (sızıntı olmasın).
    const idx = pendingFilenames.findIndex((p) => p.url === dataUrl);
    if (idx !== -1) pendingFilenames.splice(idx, 1);
    throw error;
  }
}

/**
 * v1.43.7: Offscreen'e mesaj gönderir; yanıt belirtilen sürede gelmezse
 * { ok:false } döner. Önceden yanıt hiç gelmezse (ör. mesaj boyutu sınırı)
 * indirme sonsuza kadar askıda kalıyordu ve global sıra da kilitleniyordu.
 */
function sendToOffscreen(message, timeoutMs) {
  // Firefox: offscreen belgesi yok, işleme modülü arka planda doğrudan çalışıyor.
  const request = IS_FIREFOX
    ? (handleProcessingMessage(message) || Promise.resolve({ ok: false, error: "unknown message" })).catch((error) => ({ ok: false, error: String(error?.message || error) }))
    : chrome.runtime.sendMessage(message).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  return Promise.race([
    request,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `offscreen zaman aşımı (${Math.round(timeoutMs / 1000)} sn)` }), timeoutMs)),
  ]);
}

/** İndirmesi biten (ya da yarıda kalan) blob adreslerini offscreen'de serbest bırakır. */
const blobUrlByDownloadId = new Map();
chrome.downloads.onChanged.addListener((delta) => {
  const blobUrl = blobUrlByDownloadId.get(delta.id);
  if (!blobUrl) return;
  const state = delta.state?.current;
  if (state === "complete" || state === "interrupted") {
    blobUrlByDownloadId.delete(delta.id);
    sendToOffscreen({ type: "REVOKE_BLOB_URL", blobUrl }, 5000).catch(() => {});
  }
});

/** Offscreen'in ürettiği blob: adresini diske indirir (bkz. offscreen.js blobToResponse). */
async function downloadOffscreenResult(result, filename, options) {
  const downloadId = await downloadWithFilename(result.blobUrl, filename, options);
  blobUrlByDownloadId.set(downloadId, result.blobUrl);
  return { ok: true, downloadId };
}

/** Medyanın ayrı ses kaynağı bilgisi (yoksa null). Eski kayıtlardaki tek audioUrl da desteklenir. */
function audioSourcesOf(media) {
  if (!media) return null;
  const { audioUrl, audioCandidates, dashUrl, hlsUrl } = media;
  if (!audioUrl && !audioCandidates?.length && !dashUrl && !hlsUrl) return null;
  return { audioUrl: audioUrl || null, audioCandidates: audioCandidates || [], dashUrl: dashUrl || null, hlsUrl: hlsUrl || null };
}

async function downloadImageWithTitleOverlay(imageUrl, title, filename) {
  await ensureOffscreenDocument();
  const result = await sendToOffscreen({ type: "EMBED_IMAGE_TITLE", imageUrl, title, filename }, 2 * 60 * 1000);
  if (!result?.ok) return result;
  // İndirmeyi BURADA yapıyoruz: offscreen document'ın chrome.downloads'a erişimi yok.
  return downloadOffscreenResult(result, filename);
}

/** Tek bir dosyanın yeniden denenebilir bağlamını saklar (galeride sadece o öğe). */
function rememberDownloadContext(downloadId, media, url, meta, postId, filename) {
  if (downloadId == null) return;
  const single = { ...media, type: media.type === "gallery" ? "image" : media.type, urls: [url] };
  downloadContextById.set(downloadId, { media: single, meta, postId: media.urls.length > 1 ? null : postId, filename });
}

/**
 * v1.47.5 DOSYA ADI ÇAKIŞMASI TESPİTİ: Chrome'da birden fazla eklenti
 * indirme adını belirlemeye çalışırsa (ör. "IDM Integration Module"), SON
 * YÜKLENEN/GÜNCELLENEN eklentinin kararı geçerli oluyor; diğerinin istediği
 * klasör/ad tamamen yok sayılıyor (gerçek Chromium'da test edildi). IDM
 * GrabPost'tan sonra yüklendiyse dosyalar klasörsüz, rastgele adla iniyor.
 * Bunu eklentinin içinden engellemenin bir yolu yok; en azından fark edip
 * paneldeki uyarıyla kullanıcıya nedenini ve çözümünü gösteriyoruz.
 */
function checkNamingConflict(ctx, item) {
  if (!ctx?.filename || !item?.filename) return;
  const wantedDir = ctx.filename.split("/").slice(0, -1).join("/");
  if (!wantedDir) return; // klasör istenmemişse karşılaştıracak bir şey yok
  const actual = item.filename.replace(/\\/g, "/");
  const ok = actual.includes(`/${wantedDir}/`);
  if (ok) {
    chrome.storage.local.remove("namingConflict").catch(() => {});
    return;
  }
  log.warn("Dosya adı/klasör başka bir eklenti tarafından değiştirildi:", { istenen: ctx.filename, gerçekleşen: actual });
  chrome.storage.local.set({ namingConflict: { at: Date.now(), expected: ctx.filename, actual: actual.split("/").pop() } }).catch(() => {});
}

function recordFailure(media, meta, postId, error) {
  addFailedDownload({ media, meta, postId: postId || null, error: String(error || "unknown").slice(0, 300) }).catch(() => {});
}

/**
 * v1.45.2: Chrome'un indirmesi BAŞLADIKTAN sonra yarıda kalanlar (ağ
 * kopması, sunucu hatası, disk hatası) da başarısız listesine düşsün diye
 * her dosyanın bağlamı indirme kimliğiyle eşleştiriliyor. Kullanıcının
 * kendisi iptal ettiyse kaydedilmiyor.
 */
const downloadContextById = new Map();
chrome.downloads.onChanged.addListener((delta) => {
  const ctx = downloadContextById.get(delta.id);
  if (!ctx) return;
  const state = delta.state?.current;
  if (state === "complete") {
    downloadContextById.delete(delta.id);
    chrome.downloads.search({ id: delta.id }).then(([item]) => checkNamingConflict(ctx, item)).catch(() => {});
  }
  if (state === "interrupted") {
    downloadContextById.delete(delta.id);
    chrome.downloads.search({ id: delta.id }).then(([item]) => {
      if (item?.error === "USER_CANCELED") return;
      recordFailure(ctx.media, ctx.meta, ctx.postId, `download_interrupted: ${item?.error || "?"}`);
      // Gönderiyi "indirildi" saymaktan vazgeç (tek dosyalıysa) ve geçmişteki başarılı görünen kaydı kaldır.
      undoDownloadRecord(ctx.postId, delta.id).catch(() => {});
    });
  }
});

/** Offscreen document'ı (video işleme sayfası) yoksa oluşturur, varsa dokunmaz. */
let offscreenCreating = null;
async function ensureOffscreenDocument() {
  if (IS_FIREFOX) return; // Firefox: işleme arka planda doğrudan yapılıyor
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existingContexts.length > 0) return;
  // Aynı anda iki çağrı gelirse ikinci createDocument hata veriyordu; tek söz (promise) paylaşılıyor.
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS", "WORKERS", "CLIPBOARD"],
        justification: "Video dosyalarına FFmpeg.wasm ile başlık yazısı gömmek ve video+ses birleştirmek için.",
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

/** Bir videoya başlık yazısı gömüp indirir (offscreen document üzerinden). Ses kaynağı varsa ses de eklenir. */
async function downloadVideoWithTitleOverlay(videoUrl, title, filename, audio) {
  await ensureOffscreenDocument();
  const result = await sendToOffscreen({ type: "BURN_VIDEO_TITLE", videoUrl, title, filename, audio }, 15 * 60 * 1000);
  if (!result?.ok) return result;
  return downloadOffscreenResult(result, filename);
}

/**
 * Reddit videosunu ayrı sesiyle birleştirip indirir. Ses bulunamazsa
 * { ok:false, noAudio:true } döner; çağıran taraf videoyu düz indirir.
 */
async function downloadVideoWithAudioMerge(videoUrl, audio, filename) {
  await ensureOffscreenDocument();
  const result = await sendToOffscreen({ type: "MERGE_VIDEO_AUDIO", videoUrl, audio }, 10 * 60 * 1000);
  if (!result?.ok) return result;
  return downloadOffscreenResult(result, filename);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const REQUEST_THROTTLE_MS = 1000;

/**
 * ÖNEMLİ YENİ İYİLEŞTİRME: Her istek arasında TAM OLARAK aynı süreyi
 * (hep 1000ms) beklemek, kendi başına bir "bot imzası" olabilir — gerçek
 * bir insan asla bu kadar mekanik bir düzenlilikte tıklamaz, Reddit'in
 * otomasyon tespit sistemleri tam da bu tür kusursuz düzenliliği arıyor
 * olabilir. Bu yüzden sabit bir süre yerine, her seferinde biraz farklı
 * (rastgele) bir süre bekliyoruz — davranış deseni daha az "makine gibi"
 * görünsün diye.
 */
function throttledSleep() {
  const jitter = Math.floor(Math.random() * 1200); // 0-1200ms ekstra rastgelelik
  return sleep(REQUEST_THROTTLE_MS + jitter);
}

/**
 * ÖNEMLİ KESİN DÜZELTME: Önceki denemede her fonksiyona (Takip kontrolü,
 * bekleyenleri indirme vb.) AYRI AYRI 1 saniyelik bekleme eklemiştik —
 * ama her fonksiyon KENDİ İÇİNDE sıralıydı, birbirleriyle değil. Kullanıcı
 * birden fazla abonelik satırına art arda "indir" bastığında, HER TIKLAMA
 * kendi bağımsız indirme akışını başlatıyordu — ikisi de kendi içinde
 * sıralı ama birbirlerine PARALEL çalışıyorlardı, bu da yine Reddit'e
 * aynı anda birden fazla istek gitmesine (ve "ClientGQLNetworkError" ile
 * engellenmeye) sebep oluyordu.
 *
 * Doğru çözüm: hangi özellik tetiklerse tetiklesin, TÜM indirmelerin
 * geçtiği TEK bir global sıra. downloadMedia() — tüm indirme yollarının
 * ortak son noktası — artık doğrudan çalışmıyor, bu sıraya ekleniyor.
 * Böylece aynı anda kaç farklı yerden indirme tetiklenirse tetiklensin,
 * gerçekte HER ZAMAN tek seferde bir tane, aralarında en az 1 saniye
 * olacak şekilde işleniyor.
 */
let globalDownloadQueueTail = Promise.resolve();

async function downloadMedia(media, meta, postId) {
  const runNext = globalDownloadQueueTail
    .then(() => downloadMediaInternal(media, meta, postId))
    .then(
      (result) => {
        // v1.45.2: başarısız indirmeleri Geçmiş > Başarısız listesine kaydet (medyasız gönderiler hariç)
        if (!result?.ok && result?.code !== "NO_MEDIA") recordFailure(media, meta, postId, result?.error);
        return result;
      },
      (error) => {
        recordFailure(media, meta, postId, String(error?.message || error));
        throw error;
      },
    );
  // v1.44.1: Bekleme (1-2.2 sn) artık SIRADAKİ indirmeden önce yapılıyor,
  // bu indirmenin sonucunu çağırana döndürmeden önce değil. Hız sınırı
  // aynı kalıyor ama sayfadaki buton "İndirildi" durumuna 1-2 sn daha
  // erken geçiyor. Hata olsa bile sıra ilerlesin diye hata yutuluyor
  // (gerçek hata runNext üzerinden çağırana iletiliyor).
  globalDownloadQueueTail = runNext.then(throttledSleep, throttledSleep);
  return runNext;
}

async function downloadMediaInternal(media, meta, postId) {
  // v1.48.1: bu gönderinin tüm dosyaları aynı kurtarma etiketini taşısın
  activeDownloadTag = media?.urls?.length
    ? buildDownloadTag(postId || makeDedupeKey({ subreddit: meta?.subreddit || "unknown", author: meta?.author || "unknown", title: meta?.title || "" }, media), meta)
    : null;
  try {
    return await downloadMediaInternalBody(media, meta, postId);
  } finally {
    activeDownloadTag = null;
  }
}

async function downloadMediaInternalBody(media, meta, postId) {
  log.debug("downloadMedia called with:", media, meta, postId);

  const settings = await getSettings();
  log.debug("settings loaded:", settings);

  if (!media?.urls?.length) {
    return { ok: false, error: "Bu gönderide indirilebilir medya bulunamadı.", code: "NO_MEDIA" };
  }

  const useGalleryFolder = settings.useGalleryFolders && media.urls.length > 1;
  const folderPattern = useGalleryFolder
    ? `${settings.folderDestination}/{subreddit}_gallery_{timestamp}`
    : settings.folderDestination;
  log.debug("folderPattern (ayarlardan gelen değer dahil):", folderPattern);

  const postForFilename = {
    subreddit: meta?.subreddit || "unknown",
    author: meta?.author || "unknown",
    title: meta?.title || "",
    date: meta?.date || null, // gönderinin GERÇEK tarihi — {date} şablonu için
  };

  // ÖNEMLİ: Tüm galeri için TEK bir zaman damgası kullanıyoruz. Her dosya
  // için ayrı ayrı hesaplansaydı (eskiden olduğu gibi), 6 görsellik bir
  // galeri 6 farklı klasöre dağılırdı (her biri kendi milisaniyesiyle).
  const sharedTimestamp = Date.now();

  const shouldEmbedTitle =
    settings.embedTitleOnImages && (media.type === "image" || media.type === "gallery") && postForFilename.title;
  const shouldEmbedVideoTitle = settings.embedTitleOnVideos && media.type === "video" && postForFilename.title;

  // TEŞHİS: Başlık yazısı özelliği çalışmıyor gibi göründüğünde, sessizce
  // atlanıp atlanmadığını (ve NEDEN) net görebilelim diye.
  log.debug("Başlık yazısı kontrolü:", {
    "settings.embedTitleOnImages": settings.embedTitleOnImages,
    "settings.embedTitleOnVideos": settings.embedTitleOnVideos,
    "media.type": media.type,
    "postForFilename.title": postForFilename.title,
    shouldEmbedTitle: !!shouldEmbedTitle,
    shouldEmbedVideoTitle: !!shouldEmbedVideoTitle,
  });

  const downloadIds = [];
  for (let i = 0; i < media.urls.length; i++) {
    const originalUrl = media.urls[i];
    let downloadUrl = originalUrl;

    // ÖNEMLİ EK GÜVENLİK: Bu döngü galeri gibi ÇOK DOSYALI gönderilerde
    // birden fazla kez çalışıyor — önceden aralarında hiç bekleme yoktu,
    // bir galerinin TÜM dosyaları (varsa yinelenen medya kontrolü dahil)
    // gecikmesiz art arda işleniyordu. Dış (downloadMedia) sırası sadece
    // AYRI gönderiler arasında bekliyordu, aynı gönderinin İÇİNDEKİ
    // dosyalar arasında değil. Artık galerideki her dosya arasında da
    // (ilk dosya hariç) kısa bir bekleme var.
    if (i > 0) await sleep(500 + Math.floor(Math.random() * 500)); // rastgelelik burada da (bkz. throttledSleep açıklaması)

    // ÖNEMLİ GÜVENLİK AĞI: buildFilePath içinde beklenmedik bir hata
    // (ör. garip bir tarih/başlık formatı) çıkarsa, önceden bu hata tüm
    // indirmeyi çökertip Chrome'un kendi varsayılan İndirilenler
    // klasörüne düşmesine sebep oluyordu — klasör şablonu tamamen yok
    // sayılıyordu. Artık böyle bir hata olursa, en azından basit ama
    // GEÇERLİ bir dosya adıyla devam ediyoruz; sessizce "İndirilenler"e
    // düşmüyoruz.
    let filename;
    try {
      filename = buildFilePath({
        folderPattern,
        filenamePattern: settings.filenamePattern,
        post: postForFilename,
        url: originalUrl,
        index: i,
        timestamp: sharedTimestamp,
      });
    } catch (error) {
      log.error("buildFilePath hatası, güvenli bir ada düşülüyor:", error);
      const ext = originalUrl.split(/[?#]/)[0].split(".").pop() || "jpg";
      filename = `${folderPattern.replace(/\{[^}]+\}/g, "unknown")}/${sharedTimestamp}_${i}.${ext}`;
    }

    // ÖNEMLİ YENİ ÖZELLİK: Aynı kullanıcı, görsel olarak AYNI dosyayı
    // farklı gönderilerde tekrar paylaşmış olabilir — Reddit her paylaşımda
    // FARKLI bir adres ürettiği için adrese bakarak bunu anlayamayız.
    // Dosyanın kendi baytlarının bir "parmak izini" (SHA-256) çıkarıp,
    // daha önce aynı parmak izine sahip bir dosya indirip indirmediğimizi
    // kontrol ediyoruz. İsteğe bağlı — açıksa her dosya için bir kez daha
    // (indirmeden önce, sadece parmak izi çıkarmak için) ağ isteği demek.
    // v1.43.5: Yinelenen medya kontrolü.
    //  - VİDEOLAR artık kontrol edilmiyor: parmak izi için tüm video bir kez
    //    fazladan indiriliyordu (100 MB'lık video = 200 MB trafik).
    //  - GÖRSELLER için SHA-256 (birebir aynı) ve algısal parmak izi
    //    (görsel olarak aynı) artık offscreen'de TEK bir indirmeden birlikte
    //    hesaplanıyor. Önceden görsel 3 kez çekiliyordu (SHA, dHash, asıl
    //    indirme), şimdi 2 kez.
    if (settings.skipDuplicateMedia && media.type !== "video") {
      let duplicate = false;
      try {
        await ensureOffscreenDocument();
        const result = await sendToOffscreen({ type: "COMPUTE_MEDIA_HASHES", imageUrl: originalUrl }, 60 * 1000);
        if (result?.ok) {
          if (result.sha256 && (await isMediaHashSeen(result.sha256))) {
            log.debug("Aynı medya (bayt bayt eşleşti) daha önce indirilmiş, atlanıyor:", originalUrl);
            duplicate = true;
          } else if (result.dhash && (await findSimilarPerceptualHash(result.dhash))) {
            log.debug("Aynı medya (görsel olarak eşleşti) daha önce indirilmiş, atlanıyor:", originalUrl);
            duplicate = true;
          } else {
            if (result.sha256) await markMediaHashSeen(result.sha256);
            if (result.dhash) await markPerceptualHashSeen(result.dhash);
          }
        } else {
          log.warn(`Yinelenen medya kontrolü yapılamadı, yine de indiriliyor: ${result?.error}`);
        }
      } catch (error) {
        log.warn(`Yinelenen medya kontrolü başarısız, yine de indiriliyor: ${error?.message || error}`);
      }
      if (duplicate) continue; // bu dosyayı atla, galerideki bir sonrakine geç
    }

    const audio = media.type === "video" ? audioSourcesOf(media) : null;
    if (shouldEmbedVideoTitle) {
      // Video: offscreen document'ta (FFmpeg.wasm) başlık gömülüyor.
      // v1.43.7: ayrı ses kaynağı varsa o da ekleniyor (önceden sessizdi).
      log.debug("Video başlık yazısıyla işleniyor (deneysel)...");
      const result = await downloadVideoWithTitleOverlay(originalUrl, postForFilename.title, filename, audio);
      if (result?.ok) {
        downloadIds.push(result.downloadId);
        rememberDownloadContext(result.downloadId, media, originalUrl, meta, postId, filename);
        continue;
      }
      log.warn("Video başlık gömme başarısız, düz indirmeye dönülüyor:", result?.error);
      // Başarısız olursa aşağıdaki ses birleştirme / normal indirme akışına devam ediyoruz.
    }
    if (audio) {
      // Reddit'in ayrı sunduğu ses parçasını video ile birleştiriyoruz.
      log.debug("Video+ses birleştiriliyor...");
      const result = await downloadVideoWithAudioMerge(originalUrl, audio, filename);
      if (result?.ok) {
        downloadIds.push(result.downloadId);
        rememberDownloadContext(result.downloadId, media, originalUrl, meta, postId, filename);
        continue;
      }
      if (result?.noAudio) {
        log.debug("Videoda ayrı ses yok, doğrudan indiriliyor.");
      } else {
        log.warn("Video+ses birleştirme başarısız, sessiz indirmeye dönülüyor:", result?.error);
      }
    }

    if (shouldEmbedTitle) {
      // ÖNEMLİ: Görsel başlık yazısı da artık offscreen document üzerinden
      // (video ile aynı sebepten — service worker'da URL.createObjectURL
      // yok). O, hem başlığı gömüyor hem de kendisi indiriyor.
      log.debug("Görsel başlık yazısıyla işleniyor...");
      const result = await downloadImageWithTitleOverlay(originalUrl, postForFilename.title, filename);
      if (result?.ok) {
        downloadIds.push(result.downloadId);
        rememberDownloadContext(result.downloadId, media, originalUrl, meta, postId, filename);
        continue;
      }
      log.warn("Başlık yazısı eklenemedi, orijinal görsel indiriliyor:", result?.error);
      // Başarısız olursa aşağıdaki normal indirme akışına devam ediyoruz.
    }

    // v1.47.3 IDM UYUMU: Dosya önce eklentinin içinde çekilip yerel bir blob:
    // adresi olarak Chrome'a veriliyor (bkz. processing.js fetchToBlob).
    // IDM gibi indirme yöneticileri https:// indirmelerini (özellikle MP4)
    // Chrome'un elinden alıp kendi klasörlerine indirmeye çalışıyordu; bu da
    // klasör şablonunun kaybolmasına ve hatalara yol açıyordu. Çekme
    // başarısız olursa (ör. site izin vermezse) eski yönteme dönülüyor.
    if (settings.downloadThroughExtension !== false) {
      await ensureOffscreenDocument();
      const fetched = await sendToOffscreen({ type: "FETCH_TO_BLOB", url: downloadUrl }, 10 * 60 * 1000);
      if (fetched?.ok) {
        const { downloadId: blobDownloadId } = await downloadOffscreenResult(fetched, filename);
        downloadIds.push(blobDownloadId);
        rememberDownloadContext(blobDownloadId, media, originalUrl, meta, postId, filename);
        continue;
      }
      log.warn("Dosya eklenti içinde çekilemedi, doğrudan indiriliyor:", downloadUrl, fetched?.error);
    }

    log.debug("chrome.downloads.download ->", { url: downloadUrl, filename });
    // ÖNEMLİ DÜZELTME: "Referer" başlığını burada elle eklemeye çalışmıştım
    // ama Chrome bunu da (fetch() gibi) "güvensiz istek başlığı" sayıp
    // TÜM indirmeleri reddediyordu — hem görsel hem video. Kaldırdım.
    const downloadId = await downloadWithFilename(downloadUrl, filename);
    downloadIds.push(downloadId);
    rememberDownloadContext(downloadId, media, originalUrl, meta, postId, filename);

    // TEŞHİS DÜZELTMESİ: chrome.downloads.search()'ü indirmeyi
    // başlattıktan HEMEN sonra çağırıyorduk — ama Chrome o anda dosya
    // adını henüz kesinleştirmemiş oluyor, bu yüzden "filename: ''" (boş)
    // gösteriyordu. Bu HER ZAMAN böyleydi, gerçek bir sorunun kanıtı
    // değildi — bizi (ve sizi) yanlış yöne yönlendirmiş olabilir. Şimdi
    // Chrome'un dosya adını kesinleştirmesini kısa bir süre bekleyip
    // GERÇEK sonucu logluyoruz.
    setTimeout(async () => {
      const [recorded] = await chrome.downloads.search({ id: downloadId });
      log.debug("Chrome'un GERÇEKTEN kaydettiği (1sn sonra):", {
        id: downloadId,
        filename: recorded?.filename,
        state: recorded?.state,
        bizim_istediğimiz: filename,
      });
    }, 1000);
  }

  if (settings.markDownloaded) {
    // ÖNEMLİ: postId (permalink/fullname) verilmişse onu kullanıyoruz —
    // bu, tıklamadan ÖNCE (sayfa taranırken) "bu gönderi indirilmiş mi"
    // kontrolü yapabilmemizi sağlıyor (yeşil tik özelliği için gerekli).
    // Verilmemişse (eski davranış) içerik özetinden hash üretiyoruz.
    const dedupeKey = postId || makeDedupeKey(postForFilename, media);
    await markPostDownloaded(dedupeKey, {
      ...postForFilename,
      count: downloadIds.length,
      downloadIds, // v1.44.4: Geçmiş sekmesinden "klasörde göster" için
    });
  }
  if (downloadIds.length) noteDownloadForAutoBackup();

  log.debug("downloadMedia finished, count:", downloadIds.length);
  return { ok: true, count: downloadIds.length };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  log.debug("message received:", message);

  if (message?.type === "SEND_TEST_NOTIFICATION") {
    sendTestNotification()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true; // async yanıt
  }

  if (message?.type === "CHECK_SUBSCRIPTIONS_NOW") {
    checkAllSubscriptions("manual")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true; // async yanıt
  }

  if (message?.type === "FETCH_JSON") {
    // anonymous: Reddit dışı herkese açık API'ler (ör. Imgur) için çerezsiz istek
    safeFetch(message.url, { headers: message.headers, credentials: message.anonymous ? "omit" : "include" })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, status: res.status });
          return;
        }
        const json = await res.json();
        sendResponse({ ok: true, json });
      })
      .catch((error) => {
        log.warn(`FETCH_JSON hatası: ${error?.message || error}`);
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true; // async yanıt
  }

  if (message?.type !== "DOWNLOAD_MEDIA") return false;

  downloadMedia(message.media, message.meta, message.postId)
    .then(sendResponse)
    .catch((error) => {
      log.error("downloadMedia threw:", error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });

  return true; // async yanıt için kanalı açık tutar
});

// ============================================================================
// TAKİP LİSTESİ (abonelik) sistemi: belirli subreddit/kullanıcıları periyodik
// olarak arka planda kontrol edip yeni medya bulunca bildirim gösterir.
// ============================================================================

// ============================================================================
// v1.49.3 HIZ SINIRI VE ZAMAN AŞIMI
// Reddit çok sık istekte 429 (Too Many Requests) döndürüp kaç saniye
// beklenmesi gerektiğini Retry-After başlığıyla söylüyor. Önceden 429 bir
// hata sayılıp hemen sıradaki isteğe geçiliyordu; bu, kısıtlamayı uzatıyordu.
// Artık:
//   - 429 gelince Retry-After kadar (yoksa 60 sn) TÜM Reddit istekleri
//     bekletiliyor; bekleme kısa ise (en fazla 2 dk) istek bir kez tekrar
//     deneniyor, uzunsa 429 olarak dönüyor (çağıran durur).
//   - Her isteğin 20 sn zaman aşımı var; cevap vermeyen bağlantı artık
//     toplu indirmeyi/Takip kontrolünü kilitlemiyor.
// ============================================================================
const FETCH_TIMEOUT_MS = 20 * 1000;
const RATE_LIMIT_MAX_INLINE_WAIT_MS = 2 * 60 * 1000;
let redditCooldownUntil = 0;

function isRedditHost(url) {
  try {
    return /(^|\.)reddit\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function retryAfterMs(res) {
  const raw = res.headers.get("retry-after");
  if (raw && /^\d+$/.test(raw.trim())) return Number(raw) * 1000;
  const date = raw ? Date.parse(raw) - Date.now() : NaN;
  return Number.isFinite(date) && date > 0 ? date : 60 * 1000;
}

/** Reddit kısıtlamasının bitmesine kalan süre (ms). 0 = kısıtlama yok. */
function redditCooldownRemaining() {
  return Math.max(0, redditCooldownUntil - Date.now());
}

/**
 * fetch() + zaman aşımı + Reddit 429 yönetimi. Ağ hatası/zaman aşımında
 * fırlatır (fetch gibi); 429 sonrası da hâlâ 429 ise o cevabı döndürür.
 */
async function safeFetch(url, init = {}) {
  const reddit = isRedditHost(url);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (reddit) {
      const wait = redditCooldownRemaining();
      if (wait > RATE_LIMIT_MAX_INLINE_WAIT_MS) return new Response("{}", { status: 429, headers: { "retry-after": String(Math.ceil(wait / 1000)) } });
      if (wait > 0) await sleep(wait);
    }
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 429 || !reddit) return res;
    const waitMs = Math.min(retryAfterMs(res), 10 * 60 * 1000);
    redditCooldownUntil = Math.max(redditCooldownUntil, Date.now() + waitMs);
    log.warn(`Reddit istekleri kısıtladı (429), ${Math.round(waitMs / 1000)} sn bekleniyor: ${url}`);
    if (attempt === 1 || waitMs > RATE_LIMIT_MAX_INLINE_WAIT_MS) return res;
  }
}

/** Genel amaçlı, arka plandan (CORS'suz) doğrudan fetch — content.js'in
 * bgFetchJson'ına GEREK YOK çünkü zaten background.js'in kendisindeyiz. */
async function fetchJsonDirect(url, headers) {
  try {
    // ÖNEMLİ: credentials:"include" olmadan fetch() Reddit'teki oturum
    // çerezinizi (cookie) göndermiyor — bu yüzden yaş onayı/giriş gerektiren
    // subredditler (ör. r/gonewild) bize "giriş yapılmamış" muamelesi
    // yapıp 451 (yasal sebeplerle erişilemiyor) hatası döndürüyordu.
    const res = await safeFetch(url, { headers, credentials: "include" });
    if (!res.ok) {
      log.warn("fetchJsonDirect başarısız:", url, res.status);
      return { data: null, status: res.status };
    }
    return { data: await res.json(), status: res.status };
  } catch (error) {
    log.warn(`fetchJsonDirect hatası (${url}): ${error?.message || error}`);
    return { data: null, status: null };
  }
}

async function getRedgifsTempTokenBg() {
  const { data } = await fetchJsonDirect("https://api.redgifs.com/v2/auth/temporary");
  return data?.token || null;
}

async function resolveRedgifsMp4Bg(id) {
  const token = await getRedgifsTempTokenBg();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const { data } = await fetchJsonDirect(`https://api.redgifs.com/v2/gifs/${id}`, headers);
  const urls = data?.gif?.urls;
  return urls?.hd || urls?.sd || null;
}

/** v1.44.5: Medya çıkarma artık ortak modülde (src/media.js); burada sadece arka plana özgü bağımlılıklar veriliyor. */
function extractMediaFromPostDataBg(postData) {
  return extractMediaFromPostData(postData, { resolveRedgifsMp4: resolveRedgifsMp4Bg, fetchJson: fetchPublicJson });
}

/**
 * v1.45.6: Çerezsiz (credentials olmadan) JSON isteği. Imgur API'si gibi
 * "Access-Control-Allow-Origin: *" dönen servisler, çerezli istekleri CORS
 * gereği reddeder; bu yüzden Reddit dışı herkese açık API'ler bununla çağrılır.
 */
async function fetchPublicJson(url) {
  try {
    const res = await safeFetch(url, { credentials: "omit" });
    return res.ok ? await res.json() : null;
  } catch (error) {
    log.debug("fetchPublicJson başarısız:", url, error?.message || error);
    return null;
  }
}

/**
 * v1.45.5 ABONELİK FİLTRELERİ: Her takip kaynağı için ayrı ayrı
 *   - medya türü: tümü / sadece görsel / sadece video
 *   - NSFW: tümü / sadece NSFW / NSFW hariç
 *   - anahtar kelime: başlıkta geçmesi gereken kelimeler (virgülle ayrılmış, herhangi biri yeterli)
 * Filtreye uymayan yeni gönderiler bildirilmez ve otomatik indirilmez.
 * (İlk öneri listesindeki "minimum skor" filtresi bilerek eklenmedi: yeni
 * gönderilerin skoru kontrol anında neredeyse hep 1 olduğu için, filtre
 * iyi gönderileri de kalıcı olarak elerdi.)
 */
function postIsVideo(postData) {
  const p = postData.crosspost_parent_list?.[0] || postData;
  const provider = (p.media ?? p.secure_media)?.oembed?.provider_name;
  return !!(p.is_video || p.domain === "redgifs.com" || provider === "RedGIFs" || /\.(gifv|mp4)(\?|$)/i.test(p.url || ""));
}

function passesSubscriptionFilters(sub, postData) {
  const mediaFilter = sub.filterMedia || "all";
  if (mediaFilter !== "all") {
    const isVideo = postIsVideo(postData);
    if (mediaFilter === "images" && isVideo) return false;
    if (mediaFilter === "videos" && !isVideo) return false;
  }
  const nsfw = sub.filterNsfw || "all";
  if (nsfw === "only" && !postData.over_18) return false;
  if (nsfw === "skip" && postData.over_18) return false;
  const keywords = String(sub.filterKeywords || "")
    .split(",")
    .map((k) => k.trim().toLocaleLowerCase())
    .filter(Boolean);
  if (keywords.length) {
    const title = String(postData.title || "").toLocaleLowerCase();
    if (!keywords.some((k) => title.includes(k))) return false;
  }
  return true;
}

/** Tek bir aboneliği (subreddit/kullanıcı) kontrol eder, yeni medya varsa bildirim gösterir. */
async function checkSubscription(sub) {
  // ÖNEMLİ YENİ DÜZELTME: Bekleyen (henüz indirilmemiş sanılan) gönderiler
  // arasında, kullanıcının BAŞKA bir yoldan (manuel tek-tık indirme,
  // profilinden bulup indirme vb.) zaten indirdiği olabilir. Önceki
  // düzeltmemiz sadece YENİ keşfedilen gönderilerin bekleyen listeye
  // eklenmesini engelliyordu — zaten listede duran, sonradan başka
  // yoldan indirilmiş olanları hiç temizlemiyordu. Bu yüzden "Şimdi
  // Kontrol Et" desek bile bekleyen sayısı düşmüyordu. Her kontrolde,
  // yeni içerik bulunsun bulunmasın, mevcut bekleyen listeyi genel
  // "zaten indirildi" kaydına göre yeniden doğruluyoruz.
  if (sub.pendingPosts?.length > 0) {
    const stillPending = [];
    for (const post of sub.pendingPosts) {
      if (post.postId && (await isPostDownloaded(post.postId))) continue; // artık indirilmiş, listeden düş
      stillPending.push(post);
    }
    if (stillPending.length !== sub.pendingPosts.length) {
      log.debug(
        `[GrabPost:bg] ${sub.type}:${sub.name} — ${sub.pendingPosts.length - stillPending.length} bekleyen gönderi başka yoldan indirilmiş, listeden çıkarıldı`,
      );
      // v1.44.4: tüm listeyi yeniden yazmak yerine sadece indirilmişleri çıkar (eşzamanlı eklemeler silinmesin)
      const keep = new Set(stillPending.map((p) => p.postId));
      await removePendingPosts(sub.id, sub.pendingPosts.filter((p) => !keep.has(p.postId)).map((p) => p.postId));
      sub.pendingPosts = stillPending; // bu fonksiyonun devamının güncel veriyle çalışması için
      await refreshExtensionBadge();
    }
  }

  const url =
    sub.type === "subreddit"
      ? `https://www.reddit.com/r/${sub.name}/new.json?limit=25&raw_json=1`
      : `https://www.reddit.com/user/${sub.name}/submitted.json?limit=25&sort=new&raw_json=1`;

  const { data: json, status } = await fetchJsonDirect(url);

  if (status === 451) {
    // Yaş onayı/giriş gerektiren subreddit (ör. r/gonewild) — tarayıcı
    // güvenliği (SameSite çerez kısıtlaması) yüzünden arka plandan bunu
    // aşamıyoruz. Sessizce tekrar tekrar denemek yerine, kullanıcının
    // panelde görebileceği net bir durum kaydediyoruz.
    await updateSubscription(sub.id, { lastCheckedAt: Date.now(), lastError: "age_restricted" });
    log.warn(`${sub.type}:${sub.name} yaş onayı gerektiriyor, arka plandan kontrol edilemiyor`);
    return;
  }

  const rawChildren = json?.data?.children || [];
  // ÖNEMLİ KESİN DÜZELTME: Reddit, SABİTLENMİŞ (pinned/stickied) bir
  // gönderiyi `sort=new` versek bile HER ZAMAN 0. sırada döndürüyor —
  // bu, sadece bizim sayfa taramamızda değil, Reddit'in KENDİ API'sinde de
  // geçerli. Kullanıcı, canlı testte kanıtladı: API'nin "en yeni" saydığı
  // gönderi, kullanıcının profilinde SABİTLEDİĞİ eski bir gönderiydi. Bu
  // yüzden lastSeenId hep bu sabit gönderiye takılı kalıyor, hiç
  // ilerlemiyordu — TEK SEFERLİK değil, KALICI bir tıkanmaydı. Çözüm:
  // sabitlenmiş gönderileri karşılaştırma mantığına hiç dahil etmiyoruz.
  // ÖNEMLİ 2. DÜZELTME: Reddit'te İKİ AYRI alan var — "stickied" (subreddit
  // içinde moderatörün sabitlediği) ve "pinned" (kullanıcının KENDİ
  // profiline sabitlediği). Sadece stickied'e bakıyorduk; kullanıcının
  // kendi profiline sabitlediği ama subreddit'te stickied OLMAYAN
  // gönderiler (canlı testte kanıtlandı: pinned:true, stickied:false)
  // filtreden kaçıyordu. Artık ikisini de hariç tutuyoruz.
  const children = rawChildren.filter((c) => !c.data?.stickied && !c.data?.pinned);
  if (rawChildren.length !== children.length) {
    log.debug(
      `[GrabPost:bg] ${sub.type}:${sub.name} — ${rawChildren.length - children.length} sabitlenmiş (pinned) gönderi karşılaştırmadan hariç tutuldu`,
    );
  }
  // ÖNEMLİ KESİN DÜZELTME: Canlı testte kanıtlandı — Reddit'in
  // /user/{isim}/submitted.json uç noktası, sort=new İSTESEK BİLE
  // sonuçları GÜVENİLİR şekilde kronolojik sırada döndürmüyor (muhtemelen
  // popülerlik/etkileşim puanını da karıştırıyor). Örnek: 2025 tarihli,
  // yüksek puanlı bir gönderi, GERÇEKTEN daha yeni (2026 tarihli) bir
  // gönderiden ÖNCE listeleniyordu. Artık Reddit'in döndürdüğü sıraya
  // hiç güvenmiyoruz — kendi tarafımızda created_utc'ye göre (en yeni
  // önce) yeniden sıralıyoruz, karşılaştırmayı bu güvenilir sırayla yapıyoruz.
  children.sort((a, b) => (b.data?.created_utc || 0) - (a.data?.created_utc || 0));
  const newestChild = children[0]?.data;
  log.debug(
    `[GrabPost:bg] ${sub.type}:${sub.name} — API'den ${children.length} gönderi çekildi (limit 25), lastSeenId: ${sub.lastSeenId || "(ilk kontrol)"}`,
  );
  log.debug(`İstek URL: ${url}`);
  if (newestChild) {
    log.debug(
      `[GrabPost:bg] ${sub.type}:${sub.name} — API'nin EN YENİ saydığı gönderi: "${newestChild.title?.slice(0, 60)}" (id: ${newestChild.id}, tarih: ${new Date(newestChild.created_utc * 1000).toLocaleString("tr-TR")})`,
    );
  }

  if (children.length === 0) {
    await updateSubscription(sub.id, { lastCheckedAt: Date.now(), lastError: status && status !== 200 ? `http_${status}` : null });
    return;
  }

  const newestId = children[0]?.data?.id;
  const newestCreated = children[0]?.data?.created_utc || null;

  if (!sub.lastSeenId && !sub.lastSeenCreatedUtc) {
    // İlk kez takip ediliyor: geçmişteki gönderiler için bildirim GÖNDERME,
    // sadece "buradan sonrasını izle" referans noktasını kaydet.
    await updateSubscription(sub.id, { lastSeenId: newestId, lastSeenCreatedUtc: newestCreated, lastCheckedAt: Date.now(), lastError: null });
    log.debug(`${sub.type}:${sub.name} ilk kez takibe alındı, referans: ${newestId}`);
    return;
  }

  // TEŞHİS: lastSeenId, çekilen 25 gönderi arasında GERÇEKTEN var mı?
  // Yoksa (ör. çok gönderi arada geçtiği için 25'in dışına düştüyse) döngü
  // hiç durmadan TÜM 25 gönderiyi "yeni" sayar — bu da yanlış sonuçlara yol
  // açabilir. Bunu görünür kılıyoruz.
  const lastSeenIndex = children.findIndex((c) => c.data.id === sub.lastSeenId);
  log.debug(
    `[GrabPost:bg] ${sub.type}:${sub.name} — lastSeenId listede ${lastSeenIndex === -1 ? "BULUNAMADI (25 sınırının dışına düşmüş olabilir)" : `${lastSeenIndex}. sırada bulundu`}`,
  );

  // v1.44.3: "Yeni" kararı artık ZAMAN DAMGASINA göre. Önceden referans
  // gönderiye (lastSeenId) rastlayana kadar olan her şey yeni sayılıyordu;
  // referans gönderi silinir ya da 25'lik pencereden düşerse, çekilen
  // 25 gönderinin HEPSİ "yeni" sanılıyordu. Artık referans gönderinin
  // tarihinden (lastSeenCreatedUtc) sonra atılanlar yeni sayılıyor. Eski
  // sürümden gelen aboneliklerde tarih yoksa bir kereliğine eski yöntem
  // kullanılıyor, sonra tarih kaydediliyor.
  const watermark = sub.lastSeenCreatedUtc || null;
  const newPostsData = [];
  const skippedNoMedia = [];
  for (const child of children) {
    if (watermark ? (child.data.created_utc || 0) <= watermark : child.data.id === sub.lastSeenId) break;
    if (postHasMedia(child.data)) {
      if (passesSubscriptionFilters(sub, child.data)) newPostsData.push(child.data);
      else log.debug(`${sub.type}:${sub.name} — "${child.data.title?.slice(0, 50)}" abonelik filtresine uymadı, atlandı`);
    } else {
      skippedNoMedia.push({ id: child.data.id, title: child.data.title, domain: child.data.domain, post_hint: child.data.post_hint });
    }
  }

  if (skippedNoMedia.length > 0) {
    log.debug(
      `[GrabPost:bg] ${sub.type}:${sub.name} — ${skippedNoMedia.length} yeni gönderi vardı ama medyasız/desteklenmeyen tür sayıldı:`,
      skippedNoMedia,
    );
  }

  await updateSubscription(sub.id, {
    lastSeenId: newestId,
    // Filigran asla geriye gitmesin (en yeni gönderi silinmişse daha eski bir tarih gelebilir).
    lastSeenCreatedUtc: Math.max(newestCreated || 0, watermark || 0) || null,
    lastCheckedAt: Date.now(),
    lastError: null,
  });

  if (newPostsData.length === 0) return;
  log.debug(`${sub.type}:${sub.name} için ${newPostsData.length} yeni medyalı gönderi bulundu`);

  // Medya bilgilerini ŞİMDİDEN çözüp bildirimle ilişkilendirerek saklıyoruz —
  // kullanıcı "İndir"e bastığında tekrar Reddit'e sormaya gerek kalmasın
  // (lastSeenId zaten ilerledi, o an tekrar sorsak "yeni" görünmezlerdi).
  const resolvedPosts = [];
  for (const postData of newPostsData) {
    // ÖNEMLİ ÇİFT DÜZELTME:
    // 1) Burada "https://www.reddit.com" önekiyle MUTLAK bir adres
    //    oluşturuyorduk, ama content.js'teki manuel indirme akışı GÖRELİ
    //    permalink kullanıyor (ör. "/r/sub/comments/xxx/"). Bu format
    //    farkı yüzünden iki sistem birbirini HİÇ tanımıyordu — aynı
    //    gönderi biri tarafından indirilmiş olsa bile diğeri bunu asla
    //    bilemiyordu. Artık ikisi de aynı (göreli) formatı kullanıyor.
    // 2) Bu gönderi daha önce (manuel/toplu indirme yoluyla) zaten
    //    indirilmiş mi diye GENEL kayda bakıyoruz — sadece aboneliğin
    //    KENDİ lastSeenId'sine güvenmek yeterli değilmiş, tam da bugün
    //    yaşadığınız soruna sebep oldu.
    if (await isPostDownloaded(postData.permalink)) {
      log.debug(`${sub.type}:${sub.name} — "${postData.title?.slice(0, 50)}" zaten indirilmiş (genel kayıt), atlanıyor`);
      continue;
    }
    const media = await extractMediaFromPostDataBg(postData);
    if (media) {
      resolvedPosts.push({
        media,
        meta: {
          subreddit: postData.subreddit || sub.name,
          author: postData.author || "unknown",
          title: postData.title || "",
          date: postData.created_utc ? postData.created_utc * 1000 : null,
        },
        postId: postData.permalink,
      });
    }
  }
  if (resolvedPosts.length === 0) return;

  // ÖNEMLİ YENİ ÖZELLİK: Her aboneliğin kendi "Otomatik İndir" anahtarı
  // var — bu açıksa, yeni bulunan medyayı "bekleyen" listesine koyup
  // kullanıcının "İndir"e basmasını beklemek yerine HEMEN indiriyoruz.
  // downloadMedia() zaten global sıradan geçtiği için (bkz. yukarısı),
  // bu otomatik indirmeler de diğer tüm indirmelerle aynı hız
  // sınırlamasına (rastgele aralıklı 1-2 saniye) tabi oluyor — Reddit'i
  // boğma riski yok.
  if (sub.autoDownload) {
    log.debug(`${sub.type}:${sub.name} — Otomatik İndir açık, ${resolvedPosts.length} gönderi hemen indiriliyor`);
    for (const post of resolvedPosts) {
      try {
        await downloadMedia(post.media, post.meta, post.postId);
      } catch (error) {
        log.warn(`Otomatik indirme başarısız (${post.postId}):`, error?.message || error);
      }
    }
    const prefix = sub.type === "subreddit" ? "r/" : "u/";
    const lang = await getUiLang();
    notify(`sub-auto-${sub.id}-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/128.png"),
      title: `${prefix}${sub.name}`,
      message: tf(lang, "notifAutoDownloaded", { n: resolvedPosts.length }),
    });
    return; // "bekleyen" akışına hiç girmiyor, bildirimdeki "İndir" butonuna gerek yok
  }

  // ÖNEMLİ: Bildirimi KAÇIRSANIZ BİLE (ör. bilgisayar kapalıydı, bildirimi
  // gördünüz ama tıklamadınız), bu gönderiler artık aboneliğin kendisinde
  // KALICI olarak saklanıyor — panelde "N yeni medya" rozeti ve o kaynağa
  // özel "İndir" butonu olarak görünüyor.
  await addPendingPosts(sub.id, resolvedPosts);
  await refreshExtensionBadge(); // yeni bekleyen medya eklendi, rozeti güncelle

  const notificationId = `sub-${sub.id}-${Date.now()}`;
  await savePendingNotification(notificationId, {
    subscriptionId: sub.id,
    subName: sub.name,
    subType: sub.type,
    posts: resolvedPosts,
  });

  const prefix = sub.type === "subreddit" ? "r/" : "u/";
  const lang = await getUiLang();
  notify(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: `${prefix}${sub.name}`,
    message: tf(lang, "notifNewMedia", { n: resolvedPosts.length }),
    buttons: [{ title: t(lang, "notifBtnDownload") }, { title: t(lang, "notifBtnOpenPage") }],
    priority: 2,
  });
}

/**
 * Reddit'teki gerçek oturum çerezlerinizi okuyup, arka plandan attığımız
 * isteklere declarativeNetRequest ile ENJEKTE EDİYORUZ. Normal fetch()'in
 * "Cookie" başlığını elle ayarlamasına izin verilmiyor (tarayıcı güvenliği),
 * ama declarativeNetRequest'in modifyHeaders eylemi buna özel olarak izin
 * veriyor — bu, r/gonewild gibi yaş onayı gereken subredditlerdeki 451
 * hatasını gerçekten çözebilecek tek yöntem.
 */
// ÖNEMLİ: Çerez kuralının gerçekten uygulandığını doğrulayan teşhis
// dinleyicisini (onRuleMatchedDebug) kaldırdım — artık gerekli değildi ve
// SADECE bizim isteklerimizde değil, sayfanın kendi TÜM normal trafiğinde
// (her graphql/events isteğinde) tetiklendiği için konsolu doldurup asıl
// hataları bulmayı zorlaştırıyordu (bir önceki hata avında bunu yaşadık).

async function updateRedditCookieRule() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "reddit.com" });
    if (!cookies.length) {
      log.debug("Reddit çerezi bulunamadı (giriş yapılmamış olabilir)");
      return;
    }
    // TEŞHİS: hangi çerezlerin (isim olarak, değer değil) okunduğunu
    // gösteriyoruz — yaş onayı çerezi (genelde "over18" veya benzeri
    // bir isim taşır) burada var mı yok mu görmek için.
    log.debug("Okunan çerez isimleri:", cookies.map((c) => c.name));

    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // ÖNEMLİ: "tabIds" ile filtreleme (aşağıda) SADECE oturum (session)
    // kapsamlı kurallarda destekleniyor — kalıcı "dynamic" kurallarda
    // desteklenmiyor (sessizce yok sayılabiliyor). Bu yüzden
    // updateDynamicRules yerine updateSessionRules kullanıyoruz. Sorun
    // değil — biz zaten bu kuralı ihtiyaç oldukça (her kontrolden önce)
    // yeniden oluşturuyoruz, kalıcı olmasına gerek yok.
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Cookie", operation: "set", value: cookieHeader }],
          },
          condition: {
            urlFilter: "||reddit.com",
            resourceTypes: ["xmlhttprequest", "other"],
            // ÖNEMLİ KRİTİK DÜZELTME: Bu kural önceden HERHANGİ bir
            // reddit.com isteğini hedefliyordu — SADECE bizim arka plan
            // isteklerimizi değil, Reddit'in KENDİ sayfasının yaptığı
            // istekleri de! Bu yüzden Reddit'in kendi oturum çerezini,
            // bizim yakaladığımız (ve güncel olmayabilecek) bir çerezle
            // EZİYORDUK — bu da Reddit'in kendi API isteklerinin
            // bozulmasına ("Request failed", geçersiz JSON hatası) sebep
            // oluyordu. "-1" değeri, HİÇBİR sekmeyle ilişkili olmayan
            // istekleri temsil ediyor — yani tam olarak bizim arka plan
            // servisimizin (background.js) kendi fetch() çağrıları. Gerçek
            // bir Reddit sekmesinden gelen istekler her zaman GERÇEK bir
            // sekme kimliğine sahip olduğu için bu kural onları hiç
            // etkilemiyor artık.
            tabIds: [-1],
          },
        },
      ],
    });

    // TEŞHİS: kuralın gerçekten kayıtlı olduğunu doğrudan Chrome'a sorup
    // doğruluyoruz (varsayım değil, kesin kontrol).
    const registeredRules = await chrome.declarativeNetRequest.getSessionRules();
    log.debug(`Reddit çerez kuralı güncellendi (${cookies.length} çerez). Kayıtlı kural sayısı:`, registeredRules.length);
  } catch (error) {
    log.warn(`Çerez kuralı güncellenemedi: ${error?.message || error}`);
  }
}

/**
 * TEST BİLDİRİMİ: gerçek yeni gönderi gelene kadar beklemeden, mevcut bir
 * takip listesindeki EN SON gönderiyi kullanarak (lastSeenId'yi hesaba
 * katmadan) tüm bildirim + indirme akışını uçtan uca hemen test etmeyi
 * sağlar. Sahte/kozmetik bir bildirim değil — gerçek veriyle çalışıyor,
 * "İndir" butonuna basınca gerçekten indirir.
 */
async function sendTestNotification() {
  await updateRedditCookieRule();
  const lang = await getUiLang();

  const subs = await getSubscriptions();
  const testSub = subs.find((s) => s.enabled) || subs[0];

  if (!testSub) {
    notify(`test-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/128.png"),
      title: "GrabPost (Test)",
      message: t(lang, "notifTestNoSubs"),
      priority: 2,
    });
    return { ok: true, note: "no_subscriptions" };
  }

  const url =
    testSub.type === "subreddit"
      ? `https://www.reddit.com/r/${testSub.name}/new.json?limit=10&raw_json=1`
      : `https://www.reddit.com/user/${testSub.name}/submitted.json?limit=10&sort=new&raw_json=1`;

  const { data: json, status } = await fetchJsonDirect(url);
  const children = (json?.data?.children || [])
    .filter((c) => !c.data?.stickied && !c.data?.pinned)
    .sort((a, b) => (b.data?.created_utc || 0) - (a.data?.created_utc || 0));
  const mediaChild = children.find((c) => postHasMedia(c.data));
  const prefix = testSub.type === "subreddit" ? "r/" : "u/";

  if (!mediaChild) {
    notify(`test-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/128.png"),
      title: `${prefix}${testSub.name} (Test)`,
      message: status === 451 ? t(lang, "notifTestAgeRestricted") : t(lang, "notifTestNoMedia"),
      priority: 2,
    });
    return { ok: true, note: "no_media_found", status };
  }

  const postData = mediaChild.data;
  const media = await extractMediaFromPostDataBg(postData);
  const notificationId = `test-${Date.now()}`;

  const resolvedPosts = media
    ? [
        {
          media,
          meta: {
            subreddit: postData.subreddit || testSub.name,
            author: postData.author || "unknown",
            title: postData.title || "",
            date: postData.created_utc ? postData.created_utc * 1000 : null,
          },
          postId: postData.permalink,
        },
      ]
    : [];

  await savePendingNotification(notificationId, {
    subscriptionId: testSub.id,
    subName: testSub.name,
    subType: testSub.type,
    posts: resolvedPosts,
  });

  notify(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: `${prefix}${testSub.name} (TEST)`,
    message: tf(lang, "notifTestTrying", { title: (postData.title || "").slice(0, 50) }),
    buttons: [{ title: t(lang, "notifBtnDownload") }, { title: t(lang, "notifBtnOpenPage") }],
    priority: 2,
  });

  return { ok: true, note: "sent", hasMedia: !!media };
}

/**
 * ÖNEMLİ YENİ DÜZELTME: Kullanıcı, indirme sonrası Reddit'in IP'sini kısa
 * süreli engellediğini fark etti (upvote/takip gibi işlemler bile
 * başarısız oluyordu). Orijinal eklentinin kaynak kodunu inceledim —
 * onlar HER indirme arasında 1 saniyelik bir bekleme koyuyor ("sistemi
 * boğmamak için"). Bizim toplu indirme döngümüzde (content.js) buna
 * benzer bir bekleme zaten vardı, ama Takip sisteminin abonelik kontrol
 * döngüsünde VE bekleyen medyaları indiren üç fonksiyonda (aşağıda)
 * HİÇ yoktu — onlarca abonelik/gönderi art arda, gecikmesiz istek
 * atıyordu. Bu, Reddit'e tam olarak bot/kazıyıcı davranışı gibi
 * görünüyor olabilir. Artık hepsine aynı bekleme uygulanıyor (sleep/
 * REQUEST_THROTTLE_MS, downloadMedia()'nın hemen üstünde TEK bir yerde
 * tanımlı — ayrıca downloadMedia'nın kendisi artık global bir sıradan
 * geçtiği için bu buradaki bekleme sadece EK bir güvenlik payı).
 */

/**
 * v1.50.0: Aynı anda tek kontrol. Favori kontrolü sürerken tam kontrol
 * gelirse onu bekler; tam kontrol sürerken favori kontrolü gelirse atlanır
 * (favoriler zaten tam kontrolde de var).
 */
let subsCheckInFlight = null;
let subsCheckKind = null;

let fullCheckPending = null;

function checkAllSubscriptions(reason = "scheduled") {
  // Zaten bir tam kontrol sürüyorsa ya da sıradaysa ona katıl (çift kontrol yok).
  if (subsCheckKind === "all") return subsCheckInFlight;
  if (fullCheckPending) return fullCheckPending;
  const pending = (async () => {
    while (subsCheckInFlight) await subsCheckInFlight.catch(() => {}); // favori kontrolü bitsin
    subsCheckKind = "all";
    subsCheckInFlight = runSubscriptionCheck({ onlyFavorites: false, reason }).finally(() => {
      subsCheckInFlight = null;
      subsCheckKind = null;
    });
    return subsCheckInFlight;
  })();
  fullCheckPending = pending;
  pending.finally(() => {
    if (fullCheckPending === pending) fullCheckPending = null;
  }).catch(() => {});
  return pending;
}

function checkFavoriteSubscriptions() {
  if (subsCheckInFlight) return Promise.resolve({ skipped: "busy" });
  subsCheckKind = "favorites";
  subsCheckInFlight = runSubscriptionCheck({ onlyFavorites: true, reason: "favorites" }).finally(() => {
    subsCheckInFlight = null;
    subsCheckKind = null;
  });
  return subsCheckInFlight;
}

async function runSubscriptionCheck({ onlyFavorites, reason }) {
  await updateRedditCookieRule(); // isteklerden ÖNCE güncel çerezi enjekte et

  const settings = await getSettings();
  const favoriteMs = (settings.favoriteIntervalMinutes || 15) * 60 * 1000;
  const startedAt = Date.now();
  const subs = await getSubscriptions();
  let enabledSubs = subs.filter((s) => s.enabled);
  if (onlyFavorites) {
    enabledSubs = enabledSubs.filter((s) => s.favorite).slice(0, MAX_FAVORITES);
    if (!enabledSubs.length) return { checked: 0 };
  } else if (reason === "scheduled") {
    // Favoriler kendi sık kontrolünde zaten yeni kontrol edildiyse tekrar sorgulanmaz.
    enabledSubs = enabledSubs.filter((s) => !(s.favorite && s.lastCheckedAt && startedAt - s.lastCheckedAt < favoriteMs));
  }
  log.debug(`Takip listesi kontrol ediliyor (${reason}): ${enabledSubs.length} kaynak`);

  for (const sub of enabledSubs) {
    // v1.49.3: Reddit uzun süreli kısıtlama verdiyse kalan kaynakları şimdi
    // sorgulamıyoruz (kısıtlamayı uzatırdı); bir sonraki kontrolde sıra gelir.
    if (redditCooldownRemaining() > RATE_LIMIT_MAX_INLINE_WAIT_MS) {
      log.warn("Reddit kısıtlaması sürüyor, kalan kaynaklar bir sonraki kontrole bırakıldı");
      break;
    }
    try {
      await checkSubscription(sub);
    } catch (error) {
      log.warn(`Abonelik kontrol hatası (${sub?.type}:${sub?.name}): ${error?.message || error}`);
    }
    await throttledSleep(); // Reddit'i art arda, gecikmesiz istekle boğmamak için
  }
  if (!onlyFavorites) await chrome.storage.local.set({ lastFullCheckAt: startedAt });
  else await chrome.storage.local.set({ lastFavoriteCheckAt: startedAt });
  return { checked: enabledSubs.length };
}

/**
 * v1.49.1: Eklenti güncellenince/yeniden yüklenince Chrome açık sekmelerdeki
 * içerik betiğini yenilemiyor; eski kopya eklentiyle konuşamaz hale geliyor
 * ve sayfa yenilenene kadar düğmeler çalışmıyordu. Açık Reddit sekmelerine
 * yeni kopyayı biz enjekte ediyoruz; eski kopya bunu görüp yerini bırakıyor
 * (content.js: handleStaleInstance). İlk kurulumda da işe yarıyor: kurulumdan
 * önce açık olan Reddit sekmeleri yenilemeden çalışıyor.
 */
async function reinjectContentScripts(details) {
  if (!chrome.scripting?.executeScript) return;
  if (details && !["install", "update"].includes(details.reason)) return;
  const tabs = await chrome.tabs.query({ url: ["*://*.reddit.com/*"] });
  let injected = 0;
  for (const tab of tabs) {
    if (tab.discarded || tab.status === "unloaded") continue; // yüklenince bildirimdeki içerik betiği zaten çalışır
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["css/content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
      injected++;
    } catch (error) {
      log.debug(`Sekmeye enjekte edilemedi (${tab.id}): ${error?.message || error}`);
    }
  }
  if (injected) log.debug(`İçerik betiği ${injected} açık Reddit sekmesine yeniden enjekte edildi`);
}

/**
 * Ayarlardaki aralığa göre (chrome.alarms) periyodik kontrolü kurar/günceller.
 *
 * v1.50.1 DÜZELTME: Önceden bu fonksiyon tarayıcı HER açıldığında
 * (onStartup) çağrılıyor ve alarmı sıfırdan kuruyordu; alarm ilk kez
 * "şimdi + aralık" sonra çalıştığı için (ör. 4 saat) açılışta gecikmiş bir
 * kontrol hiç yapılmıyor, elle "Şimdi kontrol et" gerekiyordu. Artık:
 *   - Aynı aralıkla kurulu sağlam bir alarm varsa ona dokunulmuyor.
 *   - Kurulması gerekiyorsa ilk çalışma "son kontrol + aralık" anına
 *     konuyor (geçmişte kaldıysa 1 dk sonraya).
 *   - Açılışta son kontrol aralığı aştıysa ayrıca en geç birkaç dakika
 *     içinde bir telafi kontrolü yapılıyor (catchUpOnStartup).
 */
async function setupSubscriptionAlarm({ force = false } = {}) {
  const settings = await getSettings();
  const hours = settings.checkIntervalHours || 4;
  const periodInMinutes = hours * 60;
  const existing = await chrome.alarms.get("checkSubscriptions");
  if (existing && !force && existing.periodInMinutes === periodInMinutes) return;
  const { lastFullCheckAt = 0 } = await chrome.storage.local.get("lastFullCheckAt");
  const when = Math.max(Date.now() + 60 * 1000, (lastFullCheckAt || Date.now()) + periodInMinutes * 60 * 1000);
  chrome.alarms.create("checkSubscriptions", { when, periodInMinutes });
  log.debug(`Takip kontrolü kuruldu: her ${hours} saatte bir, ilk: ${new Date(when).toLocaleString()}`);
}

/** v1.50.0: Favori kaynakların sık kontrol alarmı (ayarlardaki dakika aralığıyla). */
async function setupFavoritesAlarm({ force = false } = {}) {
  const settings = await getSettings();
  const periodInMinutes = Math.max(5, Number(settings.favoriteIntervalMinutes) || 15);
  const existing = await chrome.alarms.get("checkFavorites");
  if (existing && !force && existing.periodInMinutes === periodInMinutes) return;
  chrome.alarms.create("checkFavorites", { delayInMinutes: periodInMinutes, periodInMinutes });
}

/**
 * v1.50.1 AÇILIŞTA TELAFİ KONTROLÜ: Tarayıcı açıldığında son tam kontrolün
 * üzerinden ayarlanan aralıktan fazla zaman geçtiyse, ağın ve Reddit
 * oturumunun hazır olması için kısa bir süre bekleyip (en fazla 5 dk)
 * kontrol kendiliğinden başlatılıyor.
 */
const STARTUP_CATCHUP_DELAY_MIN = 2;
const CATCHUP_GRACE_MS = 15 * 60 * 1000;
async function catchUpOnStartup() {
  const settings = await getSettings();
  const periodMs = (settings.checkIntervalHours || 4) * 60 * 60 * 1000;
  const { lastFullCheckAt = 0 } = await chrome.storage.local.get("lastFullCheckAt");
  const subs = await getSubscriptions();
  if (!subs.some((s) => s.enabled)) return;
  // Son tam kontrol aralığı (+15 dk pay) aşmadıysa gecikme yok.
  if (Date.now() - lastFullCheckAt < periodMs + CATCHUP_GRACE_MS) return;
  if (subsCheckInFlight || (await chrome.alarms.get("startupCatchup"))) return;
  // Ana alarm zaten birkaç dakika içinde çalışacaksa ayrıca planlamaya gerek yok.
  const main = await chrome.alarms.get("checkSubscriptions");
  if (main && main.scheduledTime - Date.now() < 5 * 60 * 1000) return;
  chrome.alarms.create("startupCatchup", { delayInMinutes: STARTUP_CATCHUP_DELAY_MIN });
  log.debug(`Son kontrol gecikmiş (${lastFullCheckAt ? new Date(lastFullCheckAt).toLocaleString() : "hiç"}); ${STARTUP_CATCHUP_DELAY_MIN} dk sonra otomatik kontrol`);
}

/**
 * ÖNEMLİ YENİ GÜVENLİK AĞI: Kullanıcı, tarayıcı 20+ saat açık kaldığı
 * halde Takip kontrolünün HİÇ çalışmadığını fark etti. Araştırdım —
 * Chrome'un kendi geliştirici ekibi, "alarm kalıcılığının tarayıcı
 * yeniden başlatmalarında GARANTİ olmadığını, bu yüzden servis çalışanı
 * her başladığında alarmı kontrol etmek gerektiğini" açıkça belirtiyor.
 * Bizim kodumuz alarmı SADECE onInstalled/onStartup anlarında kuruyordu
 * — eğer alarm herhangi bir sebeple (Chrome'un kendi iç yönetimi,
 * beklenmedik bir servis çalışanı sıfırlanması vb.) kaybolursa, gerçek
 * bir tarayıcı yeniden başlatmasına kadar KİMSE bunu fark edip
 * düzeltmiyordu. Artık servis çalışanı HER uyandığında (herhangi bir
 * sebeple — bir mesaj gelmesi, bir alarmın ateşlenmesi vb.) alarmın
 * gerçekten var olup olmadığını kontrol ediyoruz. ÖNEMLİ: sadece
 * KAYIPSA yeniden kuruyoruz — zaten var olan, sağlıklı bir alarmı
 * gereksiz yere SIFIRLAMIYORUZ (chrome.alarms.create() aynı isimde bir
 * alarm varsa onu iptalöip yeniden zamanlıyor; bunu her uyanışta
 * çağırsaydık alarm hiçbir zaman gerçek ateşlenme anına ulaşamazdı).
 */
async function ensureSubscriptionAlarmExists() {
  try {
    const existing = await chrome.alarms.get("checkSubscriptions");
    if (!existing) {
      log.warn("Takip kontrolü alarmı kayıp bulundu, yeniden kuruluyor...");
      await setupSubscriptionAlarm();
    }
    if (!(await chrome.alarms.get("checkFavorites"))) await setupFavoritesAlarm();
  } catch (error) {
    log.warn("Alarm kontrolü başarısız:", error?.message || error);
  }
}
ensureSubscriptionAlarmExists() // servis çalışanı her yüklendiğinde/uyandığında hemen kontrol et
  // v1.50.1: Tarayıcı açılışı (ve uykudan dönüş) servis çalışanını uyandırıyor;
  // onStartup her ortamda güvenilir tetiklenmediği için gecikme kontrolü burada da yapılıyor.
  .then(() => catchUpOnStartup())
  .catch((error) => log.warn("Gecikmiş kontrol denetimi başarısız:", error?.message || error));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkSubscriptions") checkAllSubscriptions("scheduled");
  if (alarm.name === "checkFavorites") checkFavoriteSubscriptions();
  if (alarm.name === "startupCatchup") {
    // Bu arada (ör. elle) bir kontrol yapıldıysa tekrar etme.
    chrome.storage.local.get("lastFullCheckAt").then(({ lastFullCheckAt = 0 }) => {
      if (Date.now() - lastFullCheckAt > 10 * 60 * 1000) checkAllSubscriptions("startup");
    });
  }
  if (alarm.name === "autoBackup") runAutoBackup("daily").catch((error) => log.warn("Otomatik yedek hatası:", error?.message || error));
});

// ============================================================================
// v1.48.2 OTOMATİK YEDEK DOSYASI
// Eklenti kaldırılınca Chrome eklentinin tüm yerel verisini siler; bunu
// eklentinin içinden engellemek mümkün değil. Bu yüzden veriler düzenli
// olarak İndirilenler/GrabPost-Yedek klasörüne bir JSON dosyası olarak
// yazılıyor; dosya diskte kaldığı için eklenti silinse de kaybolmuyor.
//   - Günde bir kez ve her 50 indirmede bir
//   - "GrabPost-otomatik-yedek.json" (her seferinde üzerine yazılır) +
//     haftalık kopya "GrabPost-haftalik-yedek-YYYY-Www.json"
//   - Chrome'un indirme listesinde görünmesin diye kayıt listeden silinir
//     (dosyanın kendisi diskte kalır)
//   - GÜVENLİK: Eklenti yeni kurulduysa ve henüz geri yükleme yapılmadıysa
//     (veri boş ya da çok az), eski iyi yedeğin ÜZERİNE YAZILMAZ; yedek
//     ayrı bir "...-yeni-kurulum.json" dosyasına yazılır.
// ============================================================================
const AUTO_BACKUP_EVERY_N_DOWNLOADS = 50;
const AUTO_BACKUP_FOLDER = "GrabPost-Yedek";
const autoBackupDownloadIds = new Set();

function isoWeekTag(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function setupAutoBackupAlarm() {
  const existing = await chrome.alarms.get("autoBackup");
  if (!existing) chrome.alarms.create("autoBackup", { periodInMinutes: 24 * 60, delayInMinutes: 10 });
}
setupAutoBackupAlarm().catch(() => {});

async function noteDownloadForAutoBackup() {
  try {
    const { autoBackupCounter = 0 } = await chrome.storage.local.get("autoBackupCounter");
    const next = autoBackupCounter + 1;
    if (next >= AUTO_BACKUP_EVERY_N_DOWNLOADS) {
      await chrome.storage.local.set({ autoBackupCounter: 0 });
      runAutoBackup("downloads").catch((error) => log.warn("Otomatik yedek hatası:", error?.message || error));
    } else {
      await chrome.storage.local.set({ autoBackupCounter: next });
    }
  } catch {
    /* sayaç kritik değil */
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!autoBackupDownloadIds.has(delta.id)) return;
  const state = delta.state?.current;
  if (state === "complete" || state === "interrupted") {
    autoBackupDownloadIds.delete(delta.id);
    // Dosya diskte kalır; sadece Chrome'un indirme listesinden kaldırılır.
    if (state === "complete") chrome.downloads.erase({ id: delta.id }).catch(() => {});
  }
});

async function runAutoBackup(reason, { force = false } = {}) {
  const settings = await getSettings();
  if (settings.autoBackup === false && !force) return { ok: false, skipped: "disabled" };
  const data = await exportBackup();
  const downloadedTotal = Object.keys(data.downloaded || {}).length;
  const isEmpty = downloadedTotal === 0 && !(data.downloadHistory || []).length && !(data.subscriptionsIdentity || []).length;
  if (isEmpty && !force) return { ok: false, skipped: "empty" };
  const { freshInstall } = await chrome.storage.local.get("freshInstall");
  const mainName = freshInstall ? "GrabPost-otomatik-yedek-yeni-kurulum.json" : "GrabPost-otomatik-yedek.json";
  await ensureOffscreenDocument();
  const text = JSON.stringify(data);
  const names = [`${AUTO_BACKUP_FOLDER}/${mainName}`];
  if (!freshInstall) names.push(`${AUTO_BACKUP_FOLDER}/GrabPost-haftalik-yedek-${isoWeekTag()}.json`);
  for (const name of names) {
    // Her dosya için ayrı blob: biri bitince serbest bırakılan blob diğerini bozmasın.
    const made = await sendToOffscreen({ type: "MAKE_BLOB", text, mime: "application/json" }, 60 * 1000);
    if (!made?.ok) return { ok: false, error: made?.error };
    const { downloadId } = await downloadOffscreenResult(made, name, { noTag: true, conflictAction: "overwrite" });
    autoBackupDownloadIds.add(downloadId);
  }
  await chrome.storage.local.set({ lastAutoBackup: { at: Date.now(), reason, file: names[0], posts: downloadedTotal } });
  log.debug("Otomatik yedek alındı:", names, reason);
  return { ok: true, file: names[0] };
}

/**
 * ÖNEMLİ YENİ ÖZELLİK: Takip edilen kaynaklarda henüz indirilmemiş
 * (bekleyen) medya varsa, bunu eklenti simgesinin üzerinde küçük bir
 * sayı rozeti olarak gösteriyoruz — Gmail/Slack gibi uzantıların
 * "okunmamış" rozetine benzer. Tüm aboneliklerdeki bekleyen medya
 * sayısını toplayıp gösteriyoruz, 0 ise rozeti tamamen kaldırıyoruz.
 */
async function refreshExtensionBadge() {
  const subs = await getSubscriptions();
  const total = subs.reduce((sum, s) => sum + (s.pendingPosts?.length || 0), 0);
  await chrome.action.setBadgeText({ text: total > 0 ? String(total) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#FF4500" });
  // ÖNEMLİ DÜZELTME: Chrome, metin rengini otomatik seçiyordu ve bu bazı
  // durumlarda siyah çıkıp turuncu zemin üzerinde okunması zor oluyordu.
  // Artık açıkça beyaz olarak sabitliyoruz.
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  }
}

/**
 * ÖNEMLİ TEMİZLİK: Önceki sürümlerde bu kural (id:1) KALICI (dynamic) bir
 * kural olarak kaydediliyordu ve TÜM reddit.com isteklerini (Reddit'in
 * kendi sayfası dahil) hedefliyordu — ciddi bir hataya (Reddit sayfasının
 * kendisinin çökmesi) sebep oluyordu. Yeni kodumuz artık sadece OTURUM
 * (session) kurallarını yönetiyor, ama bu ESKİ kalıcı kural kendiliğinden
 * silinmiyor — dynamic ve session kuralları Chrome'da iki AYRI, birbirinden
 * bağımsız kayıt defteri. Bu yüzden güncelleme sonrası sorun devam
 * ediyordu: eski kalıcı kural hâlâ oradaydı. Artık her başlangıçta (ve
 * hemen şimdi, servis çalışanı her uyandığında) olası eski kalıcı kuralı
 * temizliyoruz.
 */
async function cleanupLegacyDynamicRule() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] });
  } catch (error) {
    log.warn("Eski kalıcı kural temizlenemedi:", error?.message || error);
  }
}
cleanupLegacyDynamicRule(); // servis çalışanı her yüklendiğinde hemen çalışsın

/**
 * v1.45.1 SAĞ TIK MENÜSÜ: Reddit sayfalarındaki görsel, video ve
 * bağlantılarda "GrabPost ile indir". İçerik betiği gönderiyi bulursa
 * normal indirme akışı çalışır; bulamazsa dosyanın kendisi indirilir.
 */
const CONTEXT_MENU_ID = "grabpost-download";
async function setupContextMenu() {
  const lang = await getUiLang();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create(
    {
      id: CONTEXT_MENU_ID,
      title: t(lang, "ctxDownload"),
      contexts: ["image", "video", "link"],
      documentUrlPatterns: ["*://*.reddit.com/*"],
    },
    () => void chrome.runtime.lastError,
  );
}

/** preview.redd.it önizleme adresini (mümkünse) tam çözünürlüklü i.redd.it adresine çevirir. */
function toFullResRedditUrl(url) {
  const m = String(url).match(/^https:\/\/preview\.redd\.it\/([^?#]+\.(?:jpe?g|png|gif|webp))/i);
  return m ? `https://i.redd.it/${m[1]}` : url;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "CONTEXT_DOWNLOAD", srcUrl: info.srcUrl, linkUrl: info.linkUrl }, { frameId: info.frameId ?? 0 });
    if (res?.handled) return;
  } catch (error) {
    log.debug("Sağ tık: içerik betiğine ulaşılamadı, dosya doğrudan indirilecek:", error?.message || error);
  }
  if (!info.srcUrl || !/^https?:/i.test(info.srcUrl)) return;
  const subreddit = (tab.url || "").match(/reddit\.com\/r\/([^/?#]+)/i)?.[1] || "unknown";
  const author = (tab.url || "").match(/reddit\.com\/(?:user|u)\/([^/?#]+)/i)?.[1] || "unknown";
  downloadMedia({ type: info.mediaType === "video" ? "video" : "image", urls: [toFullResRedditUrl(info.srcUrl)] }, { subreddit, author, title: "" }, null).catch(
    (error) => log.warn("Sağ tık indirme başarısız:", error?.message || error),
  );
});

/** v1.45.1 KLAVYE KISAYOLU: ekranın ortasındaki gönderiyi indir (varsayılan Alt+Shift+D). */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "download-focused-post") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/reddit\.com/i.test(tab.url || "")) return;
  chrome.tabs.sendMessage(tab.id, { type: "DOWNLOAD_FOCUSED_POST" }).catch(() => {});
});

/**
 * v1.48.0: Yeni kurulumda ayarları hesaptaki (sync) yedekten geri getir ve
 * paneldeki "verilerini geri getir" kutusu için bir işaret bırak.
 */
async function handleFreshInstall(details) {
  const restoredSettings = await restoreSettingsFromSyncIfFresh().catch(() => false);
  if (details?.reason === "install") {
    // v1.48.3: Chrome'un indirme geçmişinde önceki kurulumdan etiketli
    // indirmeler varsa "indirildi" belleğini ve Geçmiş'i hemen geri kur.
    let recovered = null;
    try {
      recovered = await recoverFromDownloadHistory();
    } catch (error) {
      log.warn("Kurulumda indirme geçmişinden kurtarma başarısız:", error?.message || error);
    }
    await chrome.storage.local.set({ freshInstall: { at: Date.now(), restoredSettings, recovered } });
  } else if (details?.reason === "update") {
    // Mevcut ayarları hesaba bir kez yansıt (önceki sürümlerde sync'e yazılmıyordu).
    const { settings } = await chrome.storage.local.get("settings");
    if (settings) await mirrorSettingsToSync(settings);
  }
}
chrome.runtime.onInstalled.addListener((details) => {
  handleFreshInstall(details).catch((error) => log.warn("Kurulum sonrası geri yükleme hatası:", error?.message || error));
});
chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onInstalled.addListener((details) => reinjectContentScripts(details).catch((error) => log.warn("İçerik betiği yeniden enjekte edilemedi:", error?.message || error)));
chrome.runtime.onStartup.addListener(setupContextMenu);

chrome.runtime.onInstalled.addListener(() => setupSubscriptionAlarm());
chrome.runtime.onInstalled.addListener(() => setupFavoritesAlarm());
// v1.50.1: Açılışta alarm SIFIRLANMIYOR (eksikse kuruluyor), gecikme varsa telafi kontrolü planlanıyor.
chrome.runtime.onStartup.addListener(() => setupSubscriptionAlarm());
chrome.runtime.onStartup.addListener(() => setupFavoritesAlarm());
chrome.runtime.onStartup.addListener(() => catchUpOnStartup().catch((error) => log.warn("Açılış kontrolü planlanamadı:", error?.message || error)));
chrome.runtime.onInstalled.addListener(refreshExtensionBadge);
chrome.runtime.onStartup.addListener(refreshExtensionBadge);
chrome.runtime.onInstalled.addListener(cleanupLegacyDynamicRule);
chrome.runtime.onStartup.addListener(cleanupLegacyDynamicRule);
// ÖNEMLİ: Takip listesini eski formattan yeni (senkronize) formata
// taşıyoruz — hem güncelleme anında hem servis çalışanı her uyandığında
// (garanti olsun diye, zararsız — eski veri yoksa hiçbir şey yapmıyor).
chrome.runtime.onInstalled.addListener(migrateSubscriptionsToSyncIfNeeded);
migrateSubscriptionsToSyncIfNeeded();
// v1.44.4: indirilmiş gönderi belleğini yeni (anahtar başına) yapıya taşı; eski veri yoksa hiçbir şey yapmaz.
migrateDownloadedPostsIfNeeded().catch((error) => log.warn("İndirme belleği taşınamadı:", error?.message || error));
// ÖNEMLİ: Çerez kuralı artık OTURUM kapsamlı (bkz. yukarıdaki düzeltme),
// yani tarayıcı her yeniden başladığında sıfırlanıyor. Önceden KALICI
// olduğu için bu sorun yoktu. Bu farkı kapatmak için, tarayıcı her
// başladığında kuralı hemen yeniden oluşturuyoruz — yoksa ilk zamanlanmış
// Takip kontrolüne kadar yaş onaylı (18+) kaynaklar için kontrol
// çalışmayabilirdi.
chrome.runtime.onStartup.addListener(updateRedditCookieRule);

// Ayarlarda kontrol sıklığı değiştirilirse alarmı yeniden kur.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const oldHours = changes.settings.oldValue?.checkIntervalHours;
  const newHours = changes.settings.newValue?.checkIntervalHours;
  if (oldHours !== newHours) setupSubscriptionAlarm({ force: true });
  if (changes.settings.oldValue?.favoriteIntervalMinutes !== changes.settings.newValue?.favoriteIntervalMinutes) setupFavoritesAlarm({ force: true });
  // Dil değişince sağ tık menüsü başlığını da güncelle.
  if (changes.settings.oldValue?.language !== changes.settings.newValue?.language) setupContextMenu();
});

/**
 * v1.43.4: Tek bir bekleyen gönderiyi güvenle indirir. Başarı: true,
 * başarısızlık (hata fırlatma ya da ok:false): false. Hata ASLA dışarı
 * sızmaz; böylece döngüler yarıda kesilmez.
 */
async function downloadPendingPostSafely(post) {
  // Bu gönderi, beklerken BAŞKA bir yoldan (ör. manuel tek tık) zaten
  // indirilmiş olabilir; indirmeden hemen önce bir kez daha kontrol.
  if (post.postId && (await isPostDownloaded(post.postId))) {
    log.debug("Bekleyen gönderi zaten indirilmiş (genel kayıt), atlanıyor:", post.postId);
    return true;
  }
  try {
    const result = await downloadMedia(post.media, post.meta, post.postId);
    if (result?.ok) return true;
    log.warn("Bekleyen gönderi indirilemedi, listede tutuluyor:", post.postId, result?.error);
  } catch (error) {
    log.warn("Bekleyen gönderi indirilemedi, listede tutuluyor:", post.postId, error?.message || error);
  }
  return false;
}

/** Bildirime bağlı bekleyen gönderileri indirir (background'daki downloadMedia'yı tekrar kullanır). */
async function downloadPendingNotificationPosts(entry) {
  const succeeded = [];
  for (const post of entry.posts) {
    if (await downloadPendingPostSafely(post)) succeeded.push(post.postId);
  }
  // Sadece BAŞARIYLA inenleri bekleyen listesinden çıkar. Önceden tüm liste
  // siliniyordu: indirilemeyenler ve bu bildirimde olmayan eski bekleyenler
  // de kayboluyordu.
  if (entry.subscriptionId) await removePendingPosts(entry.subscriptionId, succeeded);
  await refreshExtensionBadge();
}

function subscriptionPageUrl(entry) {
  return entry.subType === "subreddit"
    ? `https://www.reddit.com/r/${entry.subName}/new/`
    : `https://www.reddit.com/user/${entry.subName}/submitted/`;
}

/**
 * v1.43.3 DÜZELTME (bildirim kaydı sızıntısı): Bildirime bağlı gönderi
 * verisi (medya adresleri dahil) storage'a yazılıyor, ama bildirim hiç
 * tıklanmadan kapatılırsa (X, zaman aşımı, Windows bildirim merkezinden
 * silme) bu kayıt HİÇ silinmiyordu ve zamanla birikiyordu. Artık:
 *   1) Bildirim kapanınca (onClosed) kayıt siliniyor.
 *   2) Her yeni kayıtta 7 günden eski kayıtlar budanıyor ve en fazla 50
 *      kayıt tutuluyor (onClosed her durumda tetiklenmeyebilir, ör.
 *      tarayıcı kapalıyken).
 * Bekleyen medya zaten aboneliğin kendisinde (pendingPosts) kalıcı
 * saklandığı için bu kayıtların silinmesi hiçbir medyayı kaybettirmez.
 */
const NOTIFICATION_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NOTIFICATION_RECORD_MAX_COUNT = 50;

function notificationTimestamp(notificationId) {
  const m = String(notificationId).match(/-(\d{12,})$/);
  return m ? Number(m[1]) : 0;
}

function savePendingNotification(notificationId, entry) {
  return withStorageLock(() => savePendingNotificationUnlocked(notificationId, entry));
}

async function savePendingNotificationUnlocked(notificationId, entry) {
  const { pendingSubscriptionNotifications = {} } = await chrome.storage.local.get("pendingSubscriptionNotifications");
  pendingSubscriptionNotifications[notificationId] = { ...entry, createdAt: Date.now() };
  const now = Date.now();
  const kept = Object.entries(pendingSubscriptionNotifications)
    .filter(([id, e]) => now - (e.createdAt || notificationTimestamp(id)) < NOTIFICATION_RECORD_MAX_AGE_MS)
    .sort((a, b) => (b[1].createdAt || notificationTimestamp(b[0])) - (a[1].createdAt || notificationTimestamp(a[0])))
    .slice(0, NOTIFICATION_RECORD_MAX_COUNT);
  await chrome.storage.local.set({ pendingSubscriptionNotifications: Object.fromEntries(kept) });
}

chrome.notifications.onClosed.addListener((notificationId) => {
  // 5 sn gecikme: bazı işletim sistemlerinde (ör. Windows yerel
  // bildirimleri) bir BUTONA tıklamak bildirimi de kapatıyor ve onClosed,
  // onButtonClicked ile neredeyse aynı anda gelebiliyor. Hemen silseydik
  // "İndir" butonu kaydı bulamayıp hiçbir şey yapmayabilirdi.
  setTimeout(() => consumePendingNotification(notificationId).catch(() => {}), 5000);
});

function consumePendingNotification(notificationId) {
  return withStorageLock(async () => {
    const { pendingSubscriptionNotifications = {} } = await chrome.storage.local.get("pendingSubscriptionNotifications");
    const entry = pendingSubscriptionNotifications[notificationId];
    if (entry) {
      delete pendingSubscriptionNotifications[notificationId];
      await chrome.storage.local.set({ pendingSubscriptionNotifications });
    }
    return entry;
  });
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  const entry = await consumePendingNotification(notificationId);
  if (!entry) return;

  if (buttonIndex === 0) {
    log.debug("Bildirimden 'İndir' seçildi:", entry.subName);
    await downloadPendingNotificationPosts(entry);
  } else {
    chrome.tabs.create({ url: subscriptionPageUrl(entry) });
  }

  chrome.notifications.clear(notificationId);
});

// Bildirimin gövdesine (butonlara değil) tıklanırsa sayfaya git.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const entry = await consumePendingNotification(notificationId);
  if (!entry) return;
  chrome.tabs.create({ url: subscriptionPageUrl(entry) });
  chrome.notifications.clear(notificationId);
});

/** Panelden: tek bir aboneliğin bekleyen (henüz indirilmemiş) medyalarını indirir. */
async function downloadSubscriptionPending(subscriptionId) {
  const subs = await getSubscriptions();
  const sub = subs.find((s) => s.id === subscriptionId);
  if (!sub?.pendingPosts?.length) return { ok: false, error: "Bekleyen medya yok" };

  const succeeded = [];
  for (const post of sub.pendingPosts) {
    if (await downloadPendingPostSafely(post)) succeeded.push(post.postId);
  }
  await removePendingPosts(subscriptionId, succeeded);
  await refreshExtensionBadge();
  const failed = sub.pendingPosts.length - succeeded.length;
  return { ok: true, count: succeeded.length, failed };
}

/**
 * Panelden: TÜM aboneliklerin bekleyen medyalarını indirir (üstteki toplu
 * buton). ÖNEMLİ: Durdurulabilir ve ilerleme bildirir — 197 gibi büyük
 * sayılarda kullanıcının yarıda durdurabilmesi gerekiyordu, önceden bu
 * eksikti.
 */
let pendingDownloadAllRunning = false;
let pendingDownloadAllStopRequested = false;

function broadcastPendingDownloadProgress(payload) {
  chrome.runtime.sendMessage({ type: "PENDING_DOWNLOAD_PROGRESS", ...payload }, () => {
    void chrome.runtime.lastError; // panel kapalıysa hata verir, zararsız
  });
}

async function downloadAllPending() {
  if (pendingDownloadAllRunning) return;
  pendingDownloadAllRunning = true;
  pendingDownloadAllStopRequested = false;
  // v1.43.4 DÜZELTME: Önceden döngü içinde bir hata fırlarsa
  // pendingDownloadAllRunning "true" olarak kalıyor, servis çalışanı
  // yeniden başlayana kadar "Tümünü indir" hiç çalışmıyordu. Artık gövde
  // try/finally içinde; bayrak her durumda sıfırlanıyor.
  try {
    await downloadAllPendingInner();
  } catch (error) {
    log.warn("Tümünü indir beklenmedik hata:", error?.message || error);
    broadcastPendingDownloadProgress({ phase: "stopped", completed: 0, total: 0 });
  } finally {
    pendingDownloadAllRunning = false;
    pendingDownloadAllStopRequested = false;
  }
}

async function downloadAllPendingInner() {

  const subs = await getSubscriptions();
  const total = subs.reduce((sum, s) => sum + (s.pendingPosts?.length || 0), 0);
  let completed = 0;
  broadcastPendingDownloadProgress({ phase: "downloading", completed, total });

  for (const sub of subs) {
    if (!sub.pendingPosts?.length) continue;

    if (pendingDownloadAllStopRequested) continue; // bu ve sonraki abonelikler dokunulmadan kalsın

    const succeeded = [];
    for (let i = 0; i < sub.pendingPosts.length; i++) {
      if (pendingDownloadAllStopRequested) break;
      const post = sub.pendingPosts[i];
      broadcastPendingDownloadProgress({
        phase: "downloading",
        completed,
        total,
        currentSubreddit: post.meta?.subreddit || sub.name,
      });
      if (await downloadPendingPostSafely(post)) succeeded.push(post.postId);
      completed++;
      broadcastPendingDownloadProgress({ phase: "downloading", completed, total });
    }

    // Sadece başarıyla inenleri çıkar: durdurulunca kalanlar ve
    // indirilemeyenler listede kalır, hiçbir şey kaybolmaz.
    await removePendingPosts(sub.id, succeeded);
    await refreshExtensionBadge();
  }

  const stopped = pendingDownloadAllStopRequested;
  broadcastPendingDownloadProgress({ phase: stopped ? "stopped" : "finished", completed, total });
}

/** v1.45.2: Başarısız bir indirmeyi (ya da hepsini) yeniden dener. Başarılı olanlar listeden silinir. */
async function retryFailedDownloads(ids) {
  const all = await getFailedDownloads();
  const targets = ids ? all.filter((r) => ids.includes(r.id)) : all;
  let succeeded = 0;
  for (const rec of targets) {
    await removeFailedDownload(rec.id); // yeniden başarısız olursa downloadMedia tekrar kaydeder
    try {
      const result = await downloadMedia(rec.media, rec.meta, rec.postId);
      if (result?.ok) succeeded++;
    } catch {
      /* downloadMedia hatayı zaten kaydetti */
    }
  }
  return { ok: true, succeeded, total: targets.length };
}

// ============================================================================
// v1.46.0 HIZLI MOD (API ile toplu indirme) + KAYDEDİLENLER
// Sayfayı kaydırmak yerine Reddit'in JSON listelerini (after= ile sayfa
// sayfa) okuyup indirir. Avantajları: çok daha hızlı, Reddit sekmesinin
// açık/görünür kalması gerekmez, Reddit'in sayfa tasarımı değişse de
// etkilenmez. Sayfa kaydırmalı mod (content.js) yedek olarak aynen duruyor.
// ============================================================================

/**
 * Sekme adresinden okunacak Reddit listesini çıkarır. Desteklenenler:
 * /r/X (+ hot/new/top/rising/controversial), /user/X (+ submitted/saved/
 * upvoted), çoklu subreddit (/user/X/m/Y), /r/X/search ve /search, ana sayfa.
 * Tek bir gönderi sayfası liste değildir: null döner.
 */
function listingFromUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return null;
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const params = new URLSearchParams();
  for (const key of ["t", "q", "sort", "restrict_sr", "type"]) if (u.searchParams.get(key)) params.set(key, u.searchParams.get(key));
  if (/\/comments\//i.test(path)) return null;

  let m = path.match(/^\/r\/([^/]+)(?:\/(hot|new|top|rising|controversial))?$/i);
  if (m) return { path: `/r/${m[1]}${m[2] ? "/" + m[2].toLowerCase() : ""}`, params, label: `r/${m[1]}` };
  m = path.match(/^\/r\/([^/]+)\/search$/i);
  if (m) {
    params.set("restrict_sr", "1");
    params.set("type", "link");
    return { path: `/r/${m[1]}/search`, params, label: `r/${m[1]} 🔍` };
  }
  m = path.match(/^\/(?:user|u)\/([^/]+)\/m\/([^/]+)(?:\/(hot|new|top|rising))?$/i);
  if (m) return { path: `/user/${m[1]}/m/${m[2]}${m[3] ? "/" + m[3] : ""}`, params, label: `m/${m[2]}` };
  m = path.match(/^\/(?:user|u)\/([^/]+)(?:\/(submitted|saved|upvoted|overview|comments|posts))?$/i);
  if (m) {
    const section = (m[2] || "submitted").toLowerCase();
    const mapped = section === "saved" || section === "upvoted" ? section : "submitted";
    return { path: `/user/${m[1]}/${mapped}`, params, label: `u/${m[1]}` };
  }
  if (path === "/search") {
    params.set("type", "link");
    return { path: "/search", params, label: "🔍" };
  }
  if (path === "/" || /^\/(best|hot|new|top|rising)$/i.test(path)) return { path, params, label: "reddit.com" }; // "/" -> "/.json" (ana sayfa)
  return null;
}

/** Oturum açmış kullanıcının adı (Kaydedilenler için). Oturum yoksa null. */
async function getLoggedInUsername() {
  await updateRedditCookieRule();
  const { data } = await fetchJsonDirect("https://www.reddit.com/api/me.json?raw_json=1");
  return data?.data?.name || data?.name || null;
}

function passesBulkFiltersBg(settings, postData) {
  const typeFilter = settings.mediaTypeFilter || "all";
  if (typeFilter !== "all") {
    const isVideo = postIsVideo(postData);
    if (typeFilter === "images" && isVideo) return false;
    if (typeFilter === "videos" && !isVideo) return false;
  }
  if (settings.enableDateFilter && (settings.dateFrom || settings.dateTo) && postData.created_utc) {
    const time = postData.created_utc * 1000;
    if (settings.dateFrom && time < new Date(settings.dateFrom).getTime()) return false;
    if (settings.dateTo && time > new Date(settings.dateTo).getTime() + 24 * 60 * 60 * 1000 - 1) return false;
  }
  return true;
}

const apiBulkState = { running: false, stopRequested: false, last: null };

function broadcastApiBulk(payload) {
  apiBulkState.last = payload;
  chrome.runtime.sendMessage({ type: "API_BULK_PROGRESS", ...payload }, () => void chrome.runtime.lastError);
}

async function runApiBulk({ listing, maxPosts = 100 }) {
  if (apiBulkState.running) return { ok: false, error: "RUNNING" };
  apiBulkState.running = true;
  apiBulkState.stopRequested = false;
  let scanned = 0;
  let found = 0;
  let completed = 0;
  let skippedDownloaded = 0;
  let consecutiveDownloaded = 0;
  let stopReason = null;
  try {
    await updateRedditCookieRule();
    const settings = await getSettings();
    let after = null;
    let pages = 0;
    broadcastApiBulk({ phase: "scrolling", completed: 0, total: 0, label: listing.label });
    outer: while (!apiBulkState.stopRequested && pages < 100) {
      const qs = new URLSearchParams(listing.params);
      qs.set("limit", "100");
      qs.set("raw_json", "1");
      if (after) qs.set("after", after);
      const url = `https://www.reddit.com${listing.path}.json?${qs}`;
      const { data, status } = await fetchJsonDirect(url);
      if (!data) {
        stopReason = status === 451 ? "age_restricted" : status === 403 ? "forbidden" : status === 429 ? "rate_limited" : `http_${status ?? "network"}`;
        break;
      }
      pages++;
      const children = data?.data?.children || [];
      for (const child of children) {
        if (apiBulkState.stopRequested) break outer;
        if (child.kind !== "t3") continue; // Kaydedilenlerdeki yorumlar vb.
        scanned++;
        const postData = child.data;
        if (!postHasMedia(postData) || !passesBulkFiltersBg(settings, postData)) continue;
        // v1.49.4: "Zorla tekrar indir" açıksa indirilmiş gönderiler atlanmaz.
        if (!settings.forceRedownload && (await isPostDownloaded(postData.permalink))) {
          skippedDownloaded++;
          // Sayfa modundaki gibi: arka arkaya 5 indirilmiş gönderi = "buradan sonrası eski".
          // Sabitlenmiş gönderiler bu sayaca dahil edilmez.
          if (!postData.stickied && !postData.pinned && ++consecutiveDownloaded >= 5) {
            stopReason = "reached_downloaded";
            break outer;
          }
          continue;
        }
        consecutiveDownloaded = 0;
        const media = await extractMediaFromPostDataBg(postData);
        if (!media) continue;
        found++;
        broadcastApiBulk({ phase: "downloading", completed, total: found, currentIndex: found, currentSubreddit: postData.subreddit, label: listing.label });
        try {
          await downloadMedia(
            media,
            {
              subreddit: postData.subreddit || "unknown",
              author: postData.author || "unknown",
              title: postData.title || "",
              date: postData.created_utc ? postData.created_utc * 1000 : null,
            },
            postData.permalink,
          );
        } catch (error) {
          log.warn("Hızlı mod: indirme hatası:", postData.permalink, error?.message || error);
        }
        completed++;
        broadcastApiBulk({ phase: "downloading", completed, total: found, label: listing.label });
        if (found >= maxPosts) {
          stopReason = "limit";
          break outer;
        }
      }
      after = data?.data?.after;
      if (!after) break;
      await throttledSleep(); // sayfa istekleri arasında da hız sınırı
    }
  } catch (error) {
    log.warn("Hızlı mod beklenmedik hata:", error?.message || error);
    stopReason = stopReason || "error";
  } finally {
    const stopped = apiBulkState.stopRequested;
    apiBulkState.running = false;
    apiBulkState.stopRequested = false;
    broadcastApiBulk({ phase: stopped ? "stopped" : "finished", completed, total: found, scanned, skippedDownloaded, stopReason, label: listing.label });
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "API_BULK_START") {
    (async () => {
      let listing = null;
      if (message.source === "saved") {
        const name = await getLoggedInUsername();
        if (!name) return sendResponse({ ok: false, error: "NOT_LOGGED_IN" });
        listing = { path: `/user/${name}/saved`, params: new URLSearchParams(), label: "⭐ saved" };
      } else {
        listing = listingFromUrl(message.url);
        if (!listing) return sendResponse({ ok: false, error: "NOT_LISTING" });
      }
      if (apiBulkState.running) return sendResponse({ ok: false, error: "RUNNING" });
      // Tamamlanmasını beklemiyoruz (dakikalar sürebilir); ilerleme API_BULK_PROGRESS ile yayınlanıyor.
      runApiBulk({ listing, maxPosts: Math.min(Math.max(Number(message.maxPosts) || 100, 1), 5000) });
      sendResponse({ ok: true, label: listing.label });
    })();
    return true;
  }
  if (message?.type === "API_BULK_STOP") {
    apiBulkState.stopRequested = true;
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "API_BULK_STATUS") {
    sendResponse({ running: apiBulkState.running, last: apiBulkState.last });
    return false;
  }
  return false;
});

/**
 * v1.48.1 CHROME İNDİRME GEÇMİŞİNDEN KURTARMA
 * Eklenti verisi silinse bile Chrome'un indirme listesi durur. Buradan:
 *  1) Etiketli indirmeler (v1.48.1+, "#gp=" etiketi): "indirildi" belleği
 *     (yeşil rozet / tekrar indirme engeli) ve Geçmiş tam olarak geri kurulur.
 *  2) Etiketsiz eski indirmeler (GrabPost'un yaptığı, v1.48.1 öncesi): sadece
 *     Geçmiş listesine dosya adıyla eklenir; hangi gönderiye ait oldukları
 *     bilinmediği için "indirildi" belleğine eklenemez.
 * Chrome'un indirme geçmişi "Tarama verilerini temizle" ile silinmişse
 * kurtarılacak bir şey kalmaz; bunun için otomatik yedek dosyası var.
 */
async function recoverFromDownloadHistory() {
  const items = await chrome.downloads.search({ limit: 0, orderBy: ["startTime"] });
  const records = [];
  const historyByKey = new Map();
  const legacy = [];
  let tagged = 0;
  for (const item of items) {
    if (item.state === "interrupted") continue;
    const url = item.url || "";
    const base = (item.filename || "").replace(/\\/g, "/");
    const basename = base.split("/").pop() || "";
    const ts = Date.parse(item.startTime) || Date.now();
    const markAt = url.indexOf(DOWNLOAD_TAG_MARK);
    if (markAt !== -1) {
      let q;
      try {
        q = new URLSearchParams(decodeURIComponent(url.slice(markAt + DOWNLOAD_TAG_MARK.length)));
      } catch {
        continue;
      }
      const key = q.get("k");
      if (!key) continue;
      tagged++;
      const meta = { subreddit: q.get("s") || "unknown", author: q.get("a") || "unknown", title: q.get("t") || basename };
      records.push({ key, subreddit: meta.subreddit, author: meta.author, timestamp: ts });
      const h = historyByKey.get(key);
      if (h) {
        h.count++;
        h.downloadIds.push(item.id);
      } else {
        historyByKey.set(key, {
          key,
          subreddit: meta.subreddit,
          title: meta.title,
          author: meta.author,
          count: 1,
          permalink: key.includes("/comments/") ? key : null,
          downloadIds: [item.id],
          timestamp: ts,
          recovered: true,
        });
      }
      continue;
    }
    // Etiketsiz ama GrabPost'un yaptığı eski indirme (yedek dosyaları hariç)
    if (/^GrabPost/i.test(item.byExtensionName || "") && !/GrabPost-(backup|yedek|otomatik|follow)/i.test(basename)) {
      const parent = base.split("/").slice(-2, -1)[0] || "";
      legacy.push({
        key: `legacy:${item.id}`,
        subreddit: "unknown",
        title: parent ? `${parent} / ${basename}` : basename,
        author: "unknown",
        count: 1,
        permalink: null,
        downloadIds: [item.id],
        timestamp: ts,
        recovered: true,
      });
    }
  }
  const result = await mergeRecoveredRecords(records, [...historyByKey.values(), ...legacy]);
  log.debug("İndirme geçmişinden kurtarma:", { tagged, legacy: legacy.length, ...result });
  return { ok: true, tagged, legacy: legacy.length, ...result };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RUN_AUTO_BACKUP") {
    runAutoBackup("manual", { force: true })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "RECOVER_FROM_DOWNLOADS") {
    recoverFromDownloadHistory()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "RETRY_FAILED") {
    retryFailedDownloads(message.ids || null)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "READ_CLIPBOARD") {
    // v1.47.4: paneldeki 📋 düğmesi için (panel odak alamadığında yedek yol)
    ensureOffscreenDocument()
      .then(() => sendToOffscreen({ type: "READ_CLIPBOARD" }, 5000))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "DOWNLOAD_WITH_NAME") {
    // Panelden (ör. yedek dosyası): onDeterminingFilename dinleyicimiz olduğu için
    // dosya adının uygulanması bu yoldan geçmek zorunda.
    downloadWithFilename(message.url, message.filename, { noTag: true })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "DOWNLOAD_SUBSCRIPTION_PENDING") {
    downloadSubscriptionPending(message.subscriptionId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "DOWNLOAD_ALL_PENDING") {
    // ÖNEMLİ: Tamamlanmasını BEKLEMİYORUZ (197 öğede dakikalar sürebilir —
    // mesaj kanalı bu kadar uzun açık kalamıyordu, "kanal kapandı" hatasının
    // sebebi bu olmuştu). Hemen "başladı" diye onaylıyoruz, ilerlemeyi ayrı
    // bir kanaldan (PENDING_DOWNLOAD_PROGRESS) yayınlıyoruz.
    downloadAllPending();
    sendResponse({ ok: true, started: true });
    return false;
  }
  if (message?.type === "STOP_DOWNLOAD_ALL_PENDING") {
    pendingDownloadAllStopRequested = true;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
