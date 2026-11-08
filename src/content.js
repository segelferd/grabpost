// content.js — Reddit sayfasında çalışır. Her gönderiye bir "İndir" butonu
// ekler. Modül sistemi kullanmaz (Chrome content script kısıtlaması).
//
// ÖNEMLİ MİMARİ NOTU: Medya adresleri Reddit'in API'sine tekrar istek atarak
// DEĞİL, doğrudan sayfadaki HTML'den (görsel src'si, galeri listesi, embed
// bilgisi) okunarak bulunuyor. Bir "gönderi ID'si" gerekmiyor — bu, önceki
// sürümde butonun hiç görünmemesine sebep olan bağımlılıktı.
//
// Buton, gönderinin oy/yorum satırına DEĞİL, doğrudan medya elemanının
// (resim/video/galeri) içine "float: right" ile ekleniyor. Bu sayede hem
// düzeni bozmuyor hem de gönderiyi açan görünmez linkin ÜSTÜNDE kalıyor.

// v1.49.1: Tüm dosya tek bir fonksiyon kapsamında. Güncellemeden sonra
// yeni kopya aynı sekmeye enjekte edildiğinde eski kopyanın const/let
// tanımlarıyla çakışmasın ("Identifier has already been declared").
(() => {
const PROCESSED_ATTR = "data-mediagrab-processed";
// v1.49.1: İndirme mesajı için üst sınır. Arka plandaki en uzun zincir
// (dosyayı çekme + başlık yakma) bundan kısa; bu sadece hiçbir zaman cevap
// gelmezse toplu indirmenin sonsuza kadar beklemesini önleyen güvenlik ağı.
const DOWNLOAD_MESSAGE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * v1.44.5 seviyeli günlük: debug satırları sadece Ayarlar > Gelişmiş >
 * "Geliştirici günlüğü" açıksa yazılır (Reddit sayfasının konsolunu
 * doldurmasın diye). warn/error her zaman görünür. (İçerik betiği modül
 * olmadığı için src/log.js'in küçük bir kopyası.)
 */
const gpLog = {
  debug: (...args) => {
    // cachedSettings aşağıda "let" ile tanımlı; tanımlanmadan önceki bir çağrıda
    // (dosyanın en başı) ReferenceError fırlatmasın diye try içinde okunuyor.
    let enabled = false;
    try {
      enabled = !!cachedSettings.debugLogs;
    } catch {
      /* henüz tanımlı değil */
    }
    if (enabled) console.log("[GrabPost:page]", ...args);
  },
  warn: (...args) => console.warn("[GrabPost:page]", ...args),
  error: (...args) => console.error("[GrabPost:page]", ...args),
};

gpLog.debug("%ccontent.js YÜKLENDİ ✅", "color:#22c55e;font-weight:bold;font-size:14px;");

// ============================================================================
// v1.49.1 İÇERİK BETİĞİ YAŞAM DÖNGÜSÜ VE ASILI KALMA KORUMASI
// Eklenti güncellenince ya da yeniden yüklenince Chrome, açık sekmelerdeki
// eski içerik betiğini kaldırmıyor; betik çalışmaya devam ediyor ama artık
// eklentiyle konuşamıyor ("Extension context invalidated"). Önceden bu
// durumda düğme "İndiriliyor..." durumunda takılı kalıyor, toplu indirme
// döngüsü cevap bekleyip asılı kalabiliyordu.
//   - Arka plana giden her mesaj sendBg() üzerinden: zaman aşımı var,
//     bağlam geçersizse anında { ok:false, error:"context_invalidated" } döner.
//   - Eski kopya bunu fark edince (ya da yeni kopyanın "başladım" mesajını
//     alınca) gözlemcilerini durdurur, toplu indirmeyi keser; yeni kopya
//     varsa kendi düğmelerini kaldırır, yoksa düğmelerde "sayfayı yenileyin"
//     yazar.
//   - Arka plan, güncelleme/yeniden yüklemede açık Reddit sekmelerine yeni
//     kopyayı kendisi enjekte eder (background.js: reinjectContentScripts).
// ============================================================================
const GP_INSTANCE_ID = Math.random().toString(36).slice(2);
let gpInstanceStale = false;
let gpRemovedForNewInstance = false;
const gpCleanups = []; // durdurulacak gözlemci/zamanlayıcılar

function isExtensionAlive() {
  if (gpInstanceStale) return false;
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * chrome.runtime.sendMessage'in güvenli hali. Her zaman çözülür (asla asılı
 * kalmaz, asla fırlatmaz). Cevap yoksa { ok:false, error } döner.
 */
function sendBg(message, timeoutMs = 60 * 1000) {
  return new Promise((resolve) => {
    if (!isExtensionAlive()) {
      handleStaleInstance("self");
      resolve({ ok: false, error: "context_invalidated" });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (response) => {
        let lastErrorMessage = "";
        try {
          lastErrorMessage = chrome.runtime.lastError?.message || "";
        } catch {
          lastErrorMessage = "context invalidated";
        }
        if (/context invalidated/i.test(lastErrorMessage)) {
          handleStaleInstance("self");
          finish({ ok: false, error: "context_invalidated" });
          return;
        }
        finish(response ?? { ok: false, error: lastErrorMessage || "no_response" });
      });
    } catch (error) {
      const invalid = /context invalidated/i.test(error?.message || "") || !isExtensionAlive();
      if (invalid) handleStaleInstance("self");
      finish({ ok: false, error: invalid ? "context_invalidated" : String(error?.message || error) });
    }
  });
}

/** Başarısız bir cevaba göre düğmede gösterilecek kısa hata metni. */
function errorTextFor(response) {
  if (response?.error === "context_invalidated") return tPage("inPageExtUpdated", "Extension updated, reload the page");
  if (response?.error === "timeout") return tPage("inPageTimeout", "No response, try again");
  return tPage("inPageError", "Error, try again");
}

/**
 * Bu kopya artık eklentiyle konuşamıyor. reason:
 *   "self"     -> kendimiz fark ettik; düğmelerde "sayfayı yenileyin" yazsın
 *   "replaced" -> yeni kopya enjekte edildi; düğmelerimizi kaldırıp yeri ona bırak
 */
function handleStaleInstance(reason) {
  if (!gpInstanceStale) {
    gpInstanceStale = true;
    try {
      bulkDownloadStopRequested = true;
    } catch {
      /* henüz tanımlı değil */
    }
    for (const fn of gpCleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* zararsız */
      }
    }
    console.warn("[GrabPost:page] Eklenti güncellendi/yeniden yüklendi; bu sayfadaki eski kopya durduruldu.");
    if (reason !== "replaced") {
      try {
        registeredDownloads.forEach(({ button, oldReddit }) => {
          if (button.dataset.state === "done") return;
          button.dataset.errorText = tPage("inPageExtUpdated", "Extension updated, reload the page");
          if (oldReddit) applyOldRedditButtonState(button, "error");
          else applyButtonState(button, "error");
        });
      } catch {
        /* liste henüz yok */
      }
    }
  }
  if (reason === "replaced" && !gpRemovedForNewInstance) {
    gpRemovedForNewInstance = true;
    try {
      registeredDownloads.forEach(({ button }) => button.remove());
      registeredDownloads.length = 0;
    } catch {
      /* liste henüz yok */
    }
    document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => el.removeAttribute(PROCESSED_ATTR));
    document.querySelectorAll("[data-grabpost-attempts]").forEach((el) => el.removeAttribute("data-grabpost-attempts"));
    document.querySelectorAll("[data-grabpost-comment-btn]").forEach((el) => el.remove());
    document.querySelectorAll("[data-grabpost-comment-img]").forEach((el) => el.removeAttribute("data-grabpost-comment-img"));
  }
}

// Yeni kopya başladığını duyurur; eski kopya (bağlamı ölmüşse) yerini bırakır.
// Bağlam kontrolü, sayfanın kendi betiklerinin bu mesajı taklit edip
// eklentiyi kapatmasını da engelliyor (canlı kopya mesajı yok sayar).
let gpDuplicateOfLive = false;
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.id === GP_INSTANCE_ID) return;
  if (gpDuplicateOfLive) return; // çekilmiş gereksiz kopya hiçbir şeye karışmaz
  if (event.data?.__grabpost === "instance-started") {
    // Sadece bağlamı GERÇEKTEN ölmüş (eklenti güncellenmiş) kopya yerini bırakır.
    let contextDead = false;
    try {
      contextDead = !chrome.runtime?.id;
    } catch {
      contextDead = true;
    }
    if (contextDead) handleStaleInstance("replaced");
    // Canlı bir kopya zaten çalışıyor (ör. sayfa yüklenirken hem bildirimdeki
    // içerik betiği hem yeniden enjeksiyon geldi): yeni gelene haber ver.
    else if (!gpInstanceStale) window.postMessage({ __grabpost: "instance-alive", id: GP_INSTANCE_ID, to: event.data.id }, "*");
  } else if (event.data?.__grabpost === "instance-alive" && event.data.to === GP_INSTANCE_ID) {
    gpDuplicateOfLive = true; // bu kopya gereksiz; düğme eklemeden çekilir
  }
});
window.postMessage({ __grabpost: "instance-started", id: GP_INSTANCE_ID }, "*");

/**
 * content script'ten farklı bir siteye (ör. old.reddit.com sayfasındayken
 * www.reddit.com'a, ya da api.redgifs.com'a) doğrudan fetch() atmak CORS
 * politikası yüzünden engellenebiliyor. background.js ise host_permissions
 * sayesinde bu kısıtlamadan muaf — bu yüzden tüm "farklı site" isteklerini
 * ona yaptırıyoruz.
 */
function bgFetchJson(url, headers) {
  // { ok: true, json } veya { ok: false, ... } (v1.49.1: zaman aşımlı, asla asılı kalmaz)
  return sendBg({ type: "FETCH_JSON", url, headers }, 3 * 60 * 1000);
}

/**
 * Ayarları ve "indirilmiş gönderi kimlikleri" listesini önbellekte tutuyoruz.
 * Bunu her gönderi için ayrı ayrı chrome.storage sorgusu yapmamak için
 * yapıyoruz (sayfada yüzlerce gönderi olabilir, hepsi için ayrı sorgu
 * yavaş olurdu). Değişiklik olduğunda otomatik güncelleniyor.
 */
let cachedSettings = {};
let cachedDownloadedIds = new Set();

/**
 * ÖNEMLİ YENİ DÜZELTME: Aynı gönderi, GÖRÜNTÜLENDİĞİ BAĞLAMA göre farklı
 * bir permalink formatıyla gelebiliyor — ör. bir kullanıcının profilinden
 * bakılırsa "/user/isim/comments/ID/baslik/", subreddit sayfasından
 * bakılırsa "/r/gercek_subreddit/comments/ID/baslik/". İkisi de AYNI
 * gönderi ama tam yol farklı olduğu için "zaten indirildi" kontrolü
 * bunları farklı gönderiler sanıyordu. Karşılaştırmayı, her iki formatta
 * da ORTAK olan gönderi ID'sinin kendisi üzerinden yapıyoruz. (storage.js
 * içindeki aynı fonksiyonun bir kopyası — content script'ler ES modülü
 * paylaşamadığı için burada da tanımlanması gerekiyor.)
 */
function normalizePostKey(key) {
  if (!key) return key;
  const match = String(key).match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
  if (match) return match[1].toLowerCase();
  const fullname = String(key).match(/^t3_([a-z0-9]+)$/i);
  return fullname ? fullname[1].toLowerCase() : key;
}

/**
 * ÖNEMLİ DÜZELTME: Bu fonksiyon eskiden geri çağırım (callback) tabanlıydı
 * ve HİÇ BEKLENMİYORDU — sayfa ilk yüklendiğinde, bu asenkron okuma daha
 * BİTMEDEN butonlar oluşturulup "bu gönderi daha önce indirildi mi"
 * kontrolü yapılıyordu. Sonuç: cachedDownloadedIds henüz BOŞKEN bu kontrol
 * çalışıyordu, yani gerçekten daha önce indirilmiş gönderiler bile "hiç
 * indirilmemiş" sanılıp TEKRAR indiriliyordu. Şimdi Promise döndürüyor,
 * ilk tarama bunun bitmesini BEKLİYOR.
 */
function refreshCache() {
  // v1.44.4: İndirilmiş gönderi belleği artık gönderi başına ayrı anahtar
  // ("dp:<id>"). Sadece anahtar ADLARINI okumak yetiyor (getKeys, Chrome
  // 130+); daha eski Chrome'da tüm depo okunup süzülüyor.
  const readIds = chrome.storage.local.getKeys
    ? chrome.storage.local.getKeys().then((keys) => keys.filter((k) => k.startsWith("dp:")))
    : chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith("dp:")));
  return Promise.all([chrome.storage.local.get("settings"), readIds])
    .then(([result, dpKeys]) => {
      cachedSettings = result.settings || {};
      cachedDownloadedIds = new Set(dpKeys.map((k) => k.slice(3)));
    })
    .catch((error) => gpLog.warn("Önbellek okunamadı:", error));
}
const initialCacheReady = refreshCache();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    const oldLang = cachedSettings.language;
    cachedSettings = changes.settings.newValue || {};
    // ÖNEMLİ: Panelde dil değiştirildiğinde, bu Reddit sekmesi hiç
    // yenilenmese bile buton metinlerinin güncellenmesi için.
    if (pageLocaleModule && cachedSettings.language !== oldLang) {
      pageLang = cachedSettings.language || pageLocaleModule.detectDefaultLanguage();
      refreshIdleButtonTexts();
    }
  }
  // v1.44.4: gönderi başına anahtar ("dp:<id>") eklenince/silinince önbelleği güncelle
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("dp:")) continue;
    if (change.newValue) cachedDownloadedIds.add(key.slice(3));
    else cachedDownloadedIds.delete(key.slice(3));
  }
});

/**
 * Sayfa içindeki butonun metni (İndir/İndiriliyor/vb.) için dil desteği.
 * Content script'ler normal <script type="module"> import'unu desteklemiyor,
 * ama dinamik import() destekleniyor — bunu kullanarak locales.js'i
 * yüklüyoruz. Yüklenene kadar (çok kısa bir an) sabit yedek metinler
 * görünüyordu — ÖNEMLİ DÜZELTME: yükleme bittiğinde bu erken oluşturulmuş
 * butonların metnini de tazeliyoruz (önceden bunu yapmıyorduk, bu yüzden
 * "İndir" butonu her zaman sabit Türkçe kalıyordu).
 */
let pageLocaleModule = null;
let pageLang = "en";

/** Hâlâ "boşta" (idle) durumdaki tüm butonların metnini güncel dile göre tazeler. */
function refreshIdleButtonTexts() {
  if (typeof registeredDownloads === "undefined") return;
  // v1.44.6: "İndirildi" durumundaki butonlar da tazeleniyor. Önceden
  // sadece boştaki butonlar güncelleniyordu; sayfa açılırken dil dosyası
  // yüklenmeden oluşturulan "✓ İndirildi" butonları, İngilizce vb.
  // kullanan kişilerde de Türkçe yedek metinde takılı kalıyordu.
  registeredDownloads.forEach(({ button, oldReddit }) => {
    const state = button.dataset.state || "idle";
    if (state !== "idle" && state !== "done") return;
    // Eski Reddit butonları farklı bir görünüme sahip; yanlış fonksiyonla boyanmasın.
    if (oldReddit) applyOldRedditButtonState(button, state);
    else applyButtonState(button, state);
  });
}

(async () => {
  try {
    pageLocaleModule = await import(chrome.runtime.getURL("locales.js"));
    pageLang = cachedSettings.language || pageLocaleModule.detectDefaultLanguage();
    gpLog.debug("Dil modülü yüklendi, dil:", pageLang);
    refreshIdleButtonTexts();
  } catch (error) {
    gpLog.warn("Dil dosyası yüklenemedi:", error);
  }
})();

function tPage(key, fallback) {
  if (!pageLocaleModule) return fallback;
  return pageLocaleModule.t(pageLang, key);
}

/**
 * Gönderi içindeki "Paylaş"/"Share" butonunu bulmaya çalışır. Öncelik
 * sırası:
 *   1. data-action-bar-action="share" özniteliği (dile bağlı değil, en
 *      güvenilir yöntem — DevTools'ta gerçek Reddit DOM'unda doğrulandı)
 *   2. <shreddit-post-share-button> etiketi (aynı elemanın yedek seçicisi)
 *   3. slot="share-button" özniteliği
 *   4. Metin içeriği "Paylaş"/"Share" (dile bağlı, son çare)
 */
const MEDIA_SELECTORS = {
  video: ["shreddit-player-2", "shreddit-player-static-hlsjs", "shreddit-player"],
  singleImage: "shreddit-media-lightbox-listener",
  gallery: "gallery-carousel",
  redgifs: "shreddit-embed[providername='RedGIFs']",
};

/** Bir <shreddit-post> içindeki asıl medya elemanını bulur (yoksa null). */
function findMediaElement(post) {
  // v1.45.6: Imgur bağlantılı gönderiler. Reddit bunları kendi önizlemesiyle
  // (düşük çözünürlüklü kopya) gösteriyor; asıl dosyayı Imgur'dan almak için
  // gönderi verisi üzerinden çözüyoruz.
  const contentHref = post.getAttribute?.("content-href") || "";
  if (/^https?:\/\/(?:i\.|m\.|www\.)?imgur\.com\//i.test(contentHref)) {
    return { element: post, type: "external" };
  }
  for (const sel of MEDIA_SELECTORS.video) {
    const el = post.querySelector(sel);
    if (el) return { element: el, type: "video" };
  }
  const redgifs = post.querySelector(MEDIA_SELECTORS.redgifs);
  if (redgifs) return { element: redgifs, type: "video" };

  const gallery = post.querySelector(MEDIA_SELECTORS.gallery);
  if (gallery) return { element: gallery, type: "gallery" };

  const single = post.querySelector(MEDIA_SELECTORS.singleImage);
  if (single) return { element: single, type: "image" };

  // Crosspost / alıntı gönderi: içeride gömülü başka bir <shreddit-post>
  // olabilir (ör. r/setups içinde alıntılanmış r/TechsourceYT gönderisi).
  const nestedPost = post.querySelector("shreddit-post");
  if (nestedPost && nestedPost !== post) {
    const nested = findMediaElement(nestedPost);
    if (nested) return nested;
  }

  // Son çare: bilinen hiçbir eleman yoksa, gönderi içindeki ilk "gerçek"
  // (avatar/ikon olmayan) görseli kullan.
  const images = Array.from(post.querySelectorAll("img"));
  const contentImage = images.find((img) => {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    return w > 100 && h > 100;
  });
  if (contentImage) {
    const wrapper = contentImage.closest("figure") || contentImage.parentElement;
    if (wrapper) return { element: wrapper, type: "image" };
  }

  return null;
}

/** srcset içinden en yüksek çözünürlüklü URL'yi seçer. */
function getBestFromSrcset(srcset) {
  if (!srcset?.trim()) return null;
  let bestUrl = null;
  let bestW = 0;
  for (const part of srcset.split(",")) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const m = descriptor?.match(/^(\d+)w$/);
    const w = m ? parseInt(m[1], 10) : 0;
    if (w >= bestW) {
      bestW = w;
      bestUrl = url;
    }
  }
  return bestUrl;
}

/** shreddit-embed HTML'inden Redgifs kimliğini (id) çıkarır, URL değil. */
function getRedgifsId(el) {
  const embed = el.tagName?.toLowerCase() === "shreddit-embed" ? el : el.querySelector("shreddit-embed");
  if (!embed || embed.getAttribute("providername") !== "RedGIFs") return null;
  const html = embed.getAttribute("html");
  if (!html) return null;
  const m = html.match(/src="([^"]*redgifs\.com\/ifr\/([^"?]+))/);
  return m?.[2] || null;
}

/**
 * Redgifs kimliğinden DOĞRUDAN indirilebilir MP4 linkini çeker. Ham
 * "hd.m3u8" adresi bir video dosyası DEĞİL, bir oynatma listesi (manifest) —
 * chrome.downloads ile indirilirse bozuk/oynatılamaz bir metin dosyası
 * olarak iner. Bunun yerine Redgifs'in herkese açık bilgi API'sini
 * kullanıp gerçek .mp4 linkini alıyoruz — FFmpeg'e hiç gerek kalmıyor.
 */
/**
 * Redgifs, artık geçici bir yetkilendirme anahtarı (token) olmadan
 * isteklerini kabul etmiyor. Bu anahtar herkese açık, kullanıcı girişi
 * gerektirmiyor — sadece istekle birlikte gönderilmesi gerekiyor.
 */
async function getRedgifsTempToken() {
  const response = await bgFetchJson("https://api.redgifs.com/v2/auth/temporary");
  if (!response?.ok) {
    gpLog.warn(`Redgifs geçici anahtarı alınamadı: HTTP ${response?.status}, hata: ${response?.error || "yok"}`);
    return null;
  }
  return response.json?.token || null;
}

/**
 * Redgifs kimliğinden DOĞRUDAN indirilebilir MP4 linkini çeker. Ham
 * "hd.m3u8" adresi bir video dosyası DEĞİL, bir oynatma listesi (manifest) —
 * chrome.downloads ile indirilirse bozuk/oynatılamaz bir metin dosyası
 * olarak iner. Bunun yerine Redgifs'in herkese açık bilgi API'sini
 * kullanıp gerçek .mp4 linkini alıyoruz — FFmpeg'e hiç gerek kalmıyor.
 */
async function resolveRedgifsMp4(id) {
  const token = await getRedgifsTempToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  const response = await bgFetchJson(`https://api.redgifs.com/v2/gifs/${id}`, headers);
  if (!response?.ok) {
    gpLog.warn(`Redgifs MP4 linki alınamadı: HTTP ${response?.status}, hata: ${response?.error || "yok"}`);
    return null;
  }
  const urls = response.json?.gif?.urls;
  return urls?.hd || urls?.sd || null;
}

/**
 * HLS (.m3u8) oynatma listesini kendimiz ayrıştırıp en yüksek çözünürlüklü
 * video akışının GERÇEK adresini çıkarır (orijinal eklentinin kaynak
 * kodundan uyarlandı). Ses akışı ayrı bir HLS parçası olarak gelebilir —
 * şimdilik sadece video akışını kullanıyoruz (Reddit'in fallback_url
 * yönteminde de aynı "sessiz video" sınırı var).
 */
async function resolveHlsVideoUrl(m3u8Url) {
  try {
    const res = await fetch(m3u8Url);
    if (!res.ok) return null;
    const playlist = await res.text();
    const lines = playlist.split("\n");
    let bestResolution = 0;
    let bestUrl = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
        if (resMatch) {
          const height = parseInt(resMatch[2], 10);
          const nextLine = lines[i + 1]?.trim();
          if (height > bestResolution && nextLine) {
            bestResolution = height;
            bestUrl = new URL(nextLine, m3u8Url).href;
          }
        }
      }
    }
    return bestUrl;
  } catch (error) {
    gpLog.warn("HLS oynatma listesi çözülemedi:", error);
    return null;
  }
}

function getSingleImageUrl(el) {
  const zoomable = el.querySelector(".lightboxed-content img");
  if (zoomable?.src?.startsWith("https://i.redd.it/")) return zoomable.src;
  const preview = el.querySelector("img") || (el.tagName === "IMG" ? el : null);
  return preview?.src || preview?.getAttribute("data-lazy-src") || null;
}

function getGalleryImageUrls(el) {
  const urls = [];
  const items = el.querySelectorAll("gallery-carousel ul li, ul li");
  items.forEach((li) => {
    const img = li.querySelector("figure img") || li.querySelector("img");
    if (!img) return;
    const srcset = img.getAttribute("srcset") ?? img.getAttribute("data-lazy-srcset") ?? null;
    const url = getBestFromSrcset(srcset) || img.src || img.getAttribute("data-lazy-src");
    if (url && !urls.includes(url)) urls.push(url);
  });
  return urls;
}

/**
 * Gönderinin kalıcı linkini (permalink) bulur. shreddit-post-share-button
 * gibi elemanların "permalink" özniteliği var, ama bunlar shadow DOM içinde
 * olabiliyor — shadow-DOM-delen aramayı kullanıyoruz.
 */
function findPostPermalink(post) {
  // ÖNEMLİ: post.getAttribute("permalink") — elemanın KENDİSİNDE bu
  // öznitelik olabilir, ama querySelector SADECE alt elemanları arar,
  // elemanın kendisini hiç kontrol etmez. Önce doğrudan kendisine bakıyoruz.
  const direct = post.getAttribute?.("permalink");
  if (direct) return direct;
  const el = searchThroughShadowRoots(post, "[permalink]");
  return el?.getAttribute("permalink") || null;
}

/**
 * v1.44.5: Medya çıkarma mantığı artık ORTAK modülde (src/media.js).
 * İçerik betikleri statik import desteklemediği için dinamik import ile
 * yükleniyor (locales.js ile aynı yöntem). Aşağıdaki fonksiyonlar async
 * olduğu için modülün yüklenmesini bekleyebiliyor.
 */
const mediaLibReady = import(chrome.runtime.getURL("src/media.js"));

/**
 * Galeri için TAM ÇÖZÜNÜRLÜKLÜ görsel adreslerini Reddit'in API'sinden
 * çeker. Sayfadaki galeri görüntüleyicisi (carousel) sadece ölçeklendirilmiş
 * önizleme görselleri sunuyor (srcset ile en iyisi bile sınırlı) — gerçek
 * orijinal-çözünürlüklü dosyalar sadece post'un JSON verisindeki
 * media_metadata içinde bulunuyor. Başarısız olursa null döner (çağıran
 * taraf, sayfadan çıkarılan görsellerle devam eder).
 */
async function fetchFullResGalleryUrls(permalink) {
  const response = await bgFetchJson(`https://www.reddit.com${permalink}.json?raw_json=1`);
  if (!response?.ok) {
    gpLog.warn(`Tam çözünürlük galeri isteği başarısız: HTTP ${response?.status}, hata: ${response?.error || "yok"}`);
    return null;
  }

  const post = response.json?.[0]?.data?.children?.[0]?.data;
  if (!post?.media_metadata || !post.gallery_data?.items) return null;
  const mediaLib = await mediaLibReady;

  const urls = post.gallery_data.items
    .map((item) => mediaLib.galleryItemUrl(post.media_metadata?.[item.media_id]))
    .filter(Boolean)
    .map((u) => u.replace(/&amp;/g, "&"));

  return urls.length > 0 ? urls : null;
}

/**
 * Post JSON'undan Reddit-hosted (v.redd.it) video bilgisini çeker.
 * fallback_url her zaman oynatılabilir bir MP4'tür ama sesli videolarda ses
 * AYRI bir dosyada gelir (Reddit'in kendi mimarisi) — bunu birleştirmek
 * FFmpeg gerektirir, şimdilik desteklemiyoruz. hasAudio bilgisini de
 * döndürüyoruz ki kullanıcıyı bilgilendirebilelim.
 */
async function fetchRedditVideoInfo(permalink) {
  const response = await bgFetchJson(`https://www.reddit.com${permalink}.json?raw_json=1`);
  if (!response?.ok) {
    gpLog.warn(`Reddit video bilgisi alınamadı: HTTP ${response?.status}, hata: ${response?.error || "yok"}`);
    return null;
  }
  const postData = response.json?.[0]?.data?.children?.[0]?.data;
  const redditVideo = (postData?.media ?? postData?.secure_media)?.reddit_video;
  if (!redditVideo?.fallback_url) return null;

  // v1.43.7: Ses adı artık tahmin edilmiyor; redditVideoMedia() DASH
  // manifesti + bilinen tüm ad adaylarını offscreen'e iletiyor.
  return (await mediaLibReady).redditVideoMedia(redditVideo);
}

/**
 * Medya adres(ler)ini doğrudan sayfadan (DOM'dan) okur; gerekirse (galeri
 * tam çözünürlük, video, redgifs) Reddit/Redgifs API'sine ek istek atar.
 */
async function resolveMediaUrls(post, media) {
  const redgifsId = getRedgifsId(media.element);
  if (redgifsId) {
    const mp4Url = await resolveRedgifsMp4(redgifsId);
    if (!mp4Url) return null;
    return { type: "video", urls: [mp4Url] };
  }

  if (media.type === "external") {
    // Harici kaynak (Imgur): gönderi verisini çekip ortak modülle çöz.
    const permalink = findPostPermalink(post);
    if (!permalink) return null;
    const response = await bgFetchJson(`https://www.reddit.com${permalink}.json?raw_json=1`);
    const postData = response?.json?.[0]?.data?.children?.[0]?.data;
    return postData ? extractMediaFromPostJson(postData) : null;
  }

  if (media.type === "gallery") {
    const domUrls = getGalleryImageUrls(media.element);
    if (domUrls.length === 0) return null;

    // Tam çözünürlük için API'den dene; başarısız olursa sayfadan
    // çıkardığımız (daha düşük çözünürlüklü) adreslerle devam et.
    const permalink = findPostPermalink(post);
    if (permalink) {
      const fullResUrls = await fetchFullResGalleryUrls(permalink);
      if (fullResUrls) {
        gpLog.debug("Tam çözünürlük galeri linkleri kullanılıyor ✅");
        return { type: "gallery", urls: fullResUrls };
      }
    }
    gpLog.debug("Tam çözünürlük alınamadı, sayfadaki görseller kullanılıyor ⚠️");
    return { type: "gallery", urls: domUrls };
  }

  if (media.type === "image") {
    const url = getSingleImageUrl(media.element);
    return url ? { type: "image", urls: [url] } : null;
  }

  if (media.type === "video") {
    const sourceUrl = media.element.getAttribute?.("src") || searchThroughShadowRoots(post, "[src]")?.getAttribute("src");

    // v1.43.7 SIRA DEĞİŞİKLİĞİ: Reddit'in kendi videolarında (v.redd.it) ÖNCE
    // gönderinin JSON verisine bakıyoruz. Oradaki fallback_url her zaman
    // gerçek bir MP4, "has_audio" bilgisi de kesin. Önceden ilk denenen HLS
    // yolu sadece görüntü akışını alıyordu (ses ayrı akışta) ve video+ses
    // birleştirme yeni Reddit'te neredeyse hiç devreye girmiyordu.
    // GIF gibi reddit_video'su olmayan gönderilerde bu adım null döner ve
    // aşağıdaki sayfa-içi yöntemlere geçilir.
    const permalinkForVideo = findPostPermalink(post);
    if (permalinkForVideo) {
      const info = await fetchRedditVideoInfo(permalinkForVideo);
      if (info) {
        gpLog.debug("Video bilgisi gönderi verisinden alındı ✅", info.audioCandidates?.length ? "(ses aranacak)" : "(sessiz video)");
        return info;
      }
    }

    // HLS (.m3u8) oynatma listesi: en yüksek çözünürlüklü akışı çıkarıyoruz.
    // Çıkan adres yine bir oynatma listesiyse (.m3u8) indirilebilir bir dosya
    // DEĞİLDİR (metin dosyası olarak inerdi), bu durumda kullanmıyoruz.
    if (sourceUrl && sourceUrl.includes(".m3u8")) {
      const resolved = await resolveHlsVideoUrl(sourceUrl);
      if (resolved && !/\.m3u8(\?|$)/i.test(resolved)) {
        gpLog.debug("Video adresi HLS oynatma listesinden çözüldü ✅");
        const candidates = (await mediaLibReady).redditAudioCandidates(resolved);
        // v1.49.2: Oynatma listesinin kendisi de ses kaynağı olarak gidiyor;
        // işleme tarafı oradaki gerçek ses kanalını adayların önünde dener.
        return candidates.length
          ? { type: "video", urls: [resolved], audioCandidates: candidates, hlsUrl: sourceUrl }
          : { type: "video", urls: [resolved] };
      }
    }

    // Reddit'in oynatıcı elemanı "packaged-media-json" özniteliğinde hazır
    // MP4 adresleri taşıyabiliyor.
    const packagedJson =
      searchThroughShadowRoots(post, "[packaged-media-json]")?.getAttribute("packaged-media-json") ||
      media.element.getAttribute?.("packaged-media-json");
    if (packagedJson) {
      try {
        const parsed = JSON.parse(packagedJson);
        const mp4s = parsed?.playbackMp4s?.permutations || [];
        if (mp4s.length > 0) {
          const best = mp4s.reduce((a, b) => ((b.source?.dimensions?.width || 0) > (a.source?.dimensions?.width || 0) ? b : a));
          if (best?.source?.url) {
            gpLog.debug("Video adresi doğrudan sayfadan (packaged-media-json) alındı ✅");
            return { type: "video", urls: [best.source.url] };
          }
        }
      } catch (error) {
        gpLog.warn("packaged-media-json ayrıştırılamadı, sıradaki yönteme geçiliyor:", error);
      }
    }

    // GIF'ler ve bazı basit videolar doğrudan düz bir "src" ile sunuluyor.
    if (sourceUrl && !sourceUrl.includes(".m3u8")) {
      gpLog.debug("Video/GIF adresi doğrudan src özniteliğinden alındı ✅");
      return { type: "video", urls: [sourceUrl] };
    }

    return null;
  }

  return null;
}

function extractPostMeta(post) {
  // ÖNEMLİ BÜYÜK DÜZELTME: Reddit'in <shreddit-post> özel elemanının
  // KENDİSİ, ihtiyacımız olan her şeyi doğrudan HTML özniteliği (attribute)
  // olarak taşıyor: author, subreddit-prefixed-name, post-title,
  // created-timestamp, permalink. Bunlar, hangi sayfada olursak olalım
  // (ana sayfa, profil, arama) HER ZAMAN aynı şekilde mevcut — içteki
  // linkleri arayıp bulamama sorunu (ana sayfada "unknown" çıkması,
  // profil sayfasında gönderi linkini yazar sanması gibi) burada hiç
  // yaşanmıyor. Önce bunları deniyoruz, sadece öznitelik yoksa (ör. henüz
  // hiç bilmediğimiz bir sayfa yapısı) eski DOM arama yöntemine düşüyoruz.
  const attrAuthor = post.getAttribute?.("author");
  const attrSubredditPrefixed = post.getAttribute?.("subreddit-prefixed-name");
  const attrTitle = post.getAttribute?.("post-title");
  const attrCreatedTimestamp = post.getAttribute?.("created-timestamp");

  if (attrAuthor) {
    // ÖNEMLİ YENİ EK GÜVENLİK: Rakip eklentinin kaynak kodunu incelerken
    // fark ettim — onlar subreddit adı için bir URL yedeği kullanıyor,
    // biz bunu şimdiye kadar sadece YAZAR (author) için yapıyorduk. Aynı
    // mantığı subreddit'e de ekliyoruz: öznitelik boşsa, sayfanın kendi
    // adresinden (/r/xxx) çıkarmayı deniyoruz, "unknown"a hemen düşmeden.
    let subredditFromAttr = attrSubredditPrefixed?.replace(/^r\//i, "") || null;
    if (!subredditFromAttr) {
      const urlMatch = location.pathname.match(/^\/r\/([^/]+)/);
      if (urlMatch) subredditFromAttr = urlMatch[1];
    }
    return {
      title: attrTitle || "",
      author: attrAuthor,
      subreddit: subredditFromAttr || "unknown",
      date: attrCreatedTimestamp || null,
    };
  }

  // --- Yedek yöntem (öznitelikler bir şekilde yoksa) ---
  const titleEl =
    post.querySelector('[id^="post-title-"]') ||
    post.querySelector('a[slot="title"]') ||
    post.querySelector('[data-testid="post-title-text"], a[data-testid="post-title"]');

  const subredditEl =
    searchThroughShadowRoots(post, 'a[data-testid="subreddit-name"]') ||
    post.querySelector('a[href^="/r/"]');
  const authorEl =
    searchThroughShadowRoots(post, 'a[href*="/user/"]:not([href*="/comments/"])') ||
    post.querySelector('a[href*="/user/"]:not([href*="/comments/"])');

  const title = titleEl?.textContent?.trim() || "";
  let author = authorEl?.textContent?.trim().replace(/^u\//, "") || "unknown";

  if (author === "unknown") {
    const profileMatch = location.pathname.match(/^\/user\/([^/]+)/);
    if (profileMatch) author = profileMatch[1];
  }

  let subreddit = "unknown";
  if (subredditEl) {
    const textMatch = subredditEl.textContent?.trim().match(/^r\/(.+)$/i);
    if (textMatch) {
      subreddit = textMatch[1];
    } else {
      const hrefMatch = subredditEl.getAttribute("href")?.match(/^\/r\/([^/]+)/);
      if (hrefMatch) subreddit = hrefMatch[1];
    }
  }
  if (subreddit === "unknown") {
    const urlMatch = location.pathname.match(/^\/r\/([^/]+)/);
    if (urlMatch) subreddit = urlMatch[1];
  }

  return { title, author, subreddit, date: extractPostDate(post) };
}

/**
 * Butonun görselini tamamen JS ile, satır içi (inline) stil olarak uygular.
 * ÖNEMLİ: Bunu bilerek CSS dosyasına değil buraya koyduk. Buton bazen
 * Reddit'in kendi shadow DOM'unun İÇİNE ekleniyor (action-row bulunduğunda)
 * — ve content.css sadece ana sayfaya enjekte edildiği için oraya ULAŞAMIYOR.
 * Inline stil ise butonun kendi üzerinde durduğu için shadow DOM sınırından
 * etkilenmez, her yerde aynı görünür.
 */
function applyButtonState(button, state) {
  // ÖNEMLİ DÜZELTME: Yinelenen medya kontrolü bir dosyayı atladığında
  // (içerik daha önce indirilmiş), sunucudan count=0 dönüyor — ama
  // "✓ İndirildi (0)" demek kafa karıştırıcı ("0 dosya indirildi" gibi
  // okunuyor, oysa aslında "zaten indirilmişti, atlandı" demek). Bu
  // durumu ayrı, net bir mesajla gösteriyoruz.
  const doneText =
    button.dataset.count === "0"
      ? tPage("inPageAlreadyExists", "✓ Zaten indirilmiş (aynı içerik)")
      : button.dataset.count
        ? `${tPage("inPageDone", "✓ İndirildi")} (${button.dataset.count})`
        : tPage("inPageDone", "✓ İndirildi");

  // ÖNEMLİ TASARIM DEĞİŞİKLİĞİ: Buton artık Reddit'in KENDİ butonlarıyla
  // (oy, yorum, paylaş) aynı şekil/boyutta — şeffaf arka plan, ince
  // kenarlık, küçük dolgu. GrabPost'tan geldiğini belli eden TEK şey:
  // turuncu kenarlık ve turuncu indirme oku simgesi. Metin rengi ise
  // Reddit'in kendi butonlarındaki gibi nötr gri — böylece sayfaya çok
  // daha doğal, "Reddit'in bir parçasıymış gibi" oturuyor.
  const palette = {
    idle: { icon: "⬇", label: tPage("inPageIdle", "⬇ İndir").replace(/^⬇\s*/, ""), iconColor: "#FF4500" },
    loading: { icon: "⬇", label: tPage("inPageLoading", "İndiriliyor..."), iconColor: "#FF4500" },
    done: { icon: "✓", label: doneText.replace(/^✓\s*/, ""), iconColor: "#16a34a" },
    error: {
      icon: "⚠",
      label: button.dataset.errorText || tPage("inPageError", "Hata, tekrar dene"),
      iconColor: "#dc2626",
    },
  };
  const { icon, label, iconColor } = palette[state] || palette.idle;

  button.dataset.state = state;
  button.innerHTML = "";

  const iconSpan = document.createElement("span");
  iconSpan.textContent = icon;
  iconSpan.style.color = iconColor;
  iconSpan.style.fontWeight = "700";

  const labelSpan = document.createElement("span");
  labelSpan.textContent = label;

  button.appendChild(iconSpan);
  button.appendChild(labelSpan);

  Object.assign(button.style, {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "5px 12px",
    fontSize: "12px",
    fontWeight: "700",
    fontFamily: "system-ui, -apple-system, sans-serif",
    // Reddit'in "plain" (dolgusuz) buton stili: şeffaf zemin, sadece
    // metin/ikon rengiyle ayırt ediliyor. Renk, açık/koyu Reddit temasının
    // ikisinde de okunaklı kalan nötr bir gri.
    color: "#878A8C",
    backgroundColor: "transparent",
    border: "1.5px solid #FF4500",
    borderRadius: "999px",
    cursor: "pointer",
    zIndex: "2",
    flexShrink: "0",
    lineHeight: "normal",
    transition: "background-color 0.15s ease",
  });

  // Reddit'in kendi butonlarındaki gibi, üzerine gelince hafif bir zemin
  // rengi belirsin (native buton hissi için).
  button.onmouseenter = () => {
    button.style.backgroundColor = "rgba(255, 69, 0, 0.08)";
  };
  button.onmouseleave = () => {
    button.style.backgroundColor = "transparent";
  };
}

/**
 * Tek bir gönderiyi indirir: medyayı çözer, background'a mesaj yollar,
 * butonun görselini günceller. Hem tek tıklamada hem toplu indirmede aynı
 * kod yolu kullanılsın diye ayrı bir fonksiyona çıkarıldı.
 */
async function downloadPostMedia(post, media, button, preResolved) {
  if (button.dataset.state === "loading") return;

  // ÖNEMLİ: Bu gönderi bu oturumda daha önce "medyasız" bulunduysa, tekrar
  // ağ isteği atmadan direkt hata durumuna geç — Reddit'e gereksiz yük
  // bindirmemek için.
  const earlyPermalink = findPostPermalink(post);
  if (earlyPermalink && unsupportedPermalinks.has(earlyPermalink)) {
    button.dataset.errorText = tPage("inPageUnsupported", "Desteklenmiyor");
    applyButtonState(button, "error");
    return;
  }

  applyButtonState(button, "loading");

  gpLog.debug("Resolving media from DOM...");
  // v1.49.0: Toplu indirmede medya, gönderi henüz ekrandayken önceden
  // çözülmeye başlanıyor (preResolved). Yoksa burada çözülüyor.
  const resolved = preResolved ? await preResolved.catch(() => null) : await resolveMediaUrls(post, media);
  gpLog.debug("Resolved media:", resolved);
  if (resolved?.warning) gpLog.warn("Uyarı:", resolved.warning);

  if (!resolved) {
    if (earlyPermalink) unsupportedPermalinks.add(earlyPermalink);
    button.dataset.errorText = tPage("inPageUnsupported", "Desteklenmiyor");
    applyButtonState(button, "error");
    gpLog.warn("Could not resolve media (video indirme henüz desteklenmiyor olabilir)");
    return;
  }

  const meta = extractPostMeta(post);
  gpLog.debug("Post meta:", meta);
  const postId = findPostPermalink(post);

  const response = await sendBg({ type: "DOWNLOAD_MEDIA", media: resolved, meta, postId }, DOWNLOAD_MESSAGE_TIMEOUT_MS);
  {
    {
      gpLog.debug("Background response:", response);
      if (response?.ok) {
        button.dataset.count = response.count;
        applyButtonState(button, "done");
        // ÖNEMLİ: Ayrı bir yüzen rozet artık EKLEMİYORUZ — buton zaten
        // "✓ İndirildi" durumunu burada gösteriyor, ikinci bir eleman
        // gereksiz ve Reddit'in kendi arayüz öğeleriyle (kullanıcı adı,
        // "Katıl" butonu vb.) çakışma riski taşıyordu.
        if (cachedSettings.markAsVisited) {
          post.style.opacity = "0.55";
          post.style.filter = "grayscale(30%)";
          markPostAsVisitedOnReddit(post); // Reddit'in kendi ziyaret takibini de tetikle
        }
      } else {
        button.dataset.errorText = errorTextFor(response);
        applyButtonState(button, "error");
        gpLog.warn("Download failed:", response?.error);
      }
      return response;
    }
  }
}

// Sayfadaki tüm indirilebilir gönderilerin kaydı — toplu indirme bunu kullanır.
// Her kayıt { button, trigger } şeklinde: trigger() çağrıldığında o gönderi
// indirilir (hem yeni hem eski Reddit için aynı arayüz).
const registeredDownloads = [];

/**
 * ÖNEMLİ YENİ ÖZELLİK (orijinal eklentiden uyarlandı): Bir gönderi
 * "indirilebilir medya yok" sonucuna vardıysa (harici site, metin gönderisi,
 * çözülemeyen bir bağlantı vb.), bu kimliği burada saklıyoruz. Bu sayede,
 * AYNI sayfa oturumunda toplu indirme birden fazla kez çalıştırılırsa, aynı
 * "ölü" gönderiler için gereksiz yere tekrar tekrar ağ isteği atılmıyor —
 * hem gereksiz gecikmeyi hem de Reddit'in hız sınırına takılma riskini
 * azaltıyor. Sayfa yenilenince temizlenir (kalıcı değil).
 */
const unsupportedPermalinks = new Set();

function createDownloadButton(post, media, alreadyDownloaded) {
  const button = document.createElement("button");
  button.type = "button";
  // ÖNEMLİ TASARIM DEĞİŞİKLİĞİ: Önceden, daha önce indirilmiş gönderiler
  // için AYRI, yüzen bir rozet ekliyorduk (sol üst köşe → kullanıcı adını
  // kapatıyordu; sağ üst köşeye taşıdık → bu sefer de "Katıl" butonunu
  // kapladı). İkisi de, Reddit'in kendi arayüzünün NEREYE ne koyacağını
  // tahmin etmeye dayanıyordu, bu da kırılgandı. Doğru çözüm: ayrı bir
  // eleman eklemek yerine, butonun KENDİSİNİ baştan "✓ İndirildi"
  // durumunda oluşturmak — zaten iyi test edilmiş, güvenilir buton
  // konumlandırma mantığını (action-row / medya köşesi) kullanıyor, yeni
  // bir çakışma riski taşımıyor.
  const showAsDownloaded = alreadyDownloaded && cachedSettings.showDownloadedMarkers !== false;
  applyButtonState(button, showAsDownloaded ? "done" : "idle");

  const permalink = findPostPermalink(post);

  registeredDownloads.push({
    button,
    root: post, // v1.45.1: sağ tık menüsü / kısayol, hangi gönderinin hedeflendiğini bulmak için
    mediaType: media.type, // "image" | "gallery" | "video" — medya türü filtresi için
    subreddit: extractPostMeta(post).subreddit, // ilerleme metninde göstermek için
    postDate: extractPostDate(post), // tarih filtresi için
    // ÖNEMLİ: Bu gönderi daha önce indirilmiş mi? Toplu indirme, böyle bir
    // gönderiye ulaştığında DURACAK — orijinal eklentinin de yaptığı gibi
    // (daha önce indirilmiş içeriğe gelince kaydırmayı/indirmeyi kesiyor).
    alreadyDownloaded: !!(permalink && cachedDownloadedIds.has(normalizePostKey(permalink))),
    prepare: () => resolveMediaUrls(post, media),
    trigger: (pre) => downloadPostMedia(post, media, button, pre),
  });

  // capture: true -> bu dinleyici, gönderiyi açan görünmez linkin kendi
  // tıklama dinleyicisinden ÖNCE tetiklenir; preventDefault + stopImmediate
  // Propagation postu açmasını tamamen engeller.
  button.addEventListener(
    "click",
    async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      await downloadPostMedia(post, media, button);
    },
    { capture: true },
  );

  return button;
}

/**
 * Verilen kök (post ya da bir shadow root) içinde, açık (open) shadow
 * root'ların İÇİNE de girerek arama yapar. Normal querySelector shadow DOM
 * sınırlarını geçemiyor — bu fonksiyon her elemanın .shadowRoot'unu tek tek
 * kontrol edip, varsa onun içine de recursive olarak bakıyor.
 */
function searchThroughShadowRoots(root, selector) {
  const direct = root.querySelector(selector);
  if (direct) return direct;

  // ÖNEMLİ DÜZELTME: root'un (ör. <shreddit-post>'un kendisinin) KENDİ
  // shadow root'u varsa, önce oraya bakıyoruz. DevTools'ta doğrulandı:
  // action-row tam olarak burada duruyor, tek katman, başka ara bileşen yok.
  if (root.shadowRoot) {
    const inOwnShadow = searchThroughShadowRoots(root.shadowRoot, selector);
    if (inOwnShadow) return inOwnShadow;
  }

  const all = root.querySelectorAll("*");
  for (const el of all) {
    if (el.shadowRoot) {
      const found = searchThroughShadowRoots(el.shadowRoot, selector);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Gerçek aksiyon satırını (oy/yorum/ödül/paylaş butonlarının olduğu satır)
 * bulur. data-testid="action-row" seçicisi DevTools'ta doğrulandı, ama
 * muhtemelen bir shadow root'un içinde olduğu için normal querySelector'la
 * bulunamıyordu — bu yüzden shadow-DOM-delen aramayı kullanıyoruz.
 */
function findActionRow(post) {
  const found = searchThroughShadowRoots(post, '[data-testid="action-row"]');
  if (found) return found;

  // Post içinde (shadow dahil) bulunamazsa, sayfa genelinde ara ve dikey
  // konumu bu gönderinin sınırları içinde kalanı seç.
  const postRect = post.getBoundingClientRect();
  const all = document.querySelectorAll('[data-testid="action-row"]');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    const center = r.top + r.height / 2;
    if (center >= postRect.top && center <= postRect.bottom) return el;
  }
  return null;
}

/** Butonu post'a doğal akışta ekleyip, olmazsa matematiksel tahmine düşer. */
function attachToPostFallback(post, media, button) {
  post.appendChild(button);
  button.style.alignSelf = "flex-end";

  requestAnimationFrame(() => {
    const mediaRect = media.element.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const landedBelowMedia = buttonRect.top >= mediaRect.bottom - 4;

    if (landedBelowMedia && buttonRect.height > 0) {
      gpLog.debug("Konum: post'a doğal yerleşim ✅", { buttonRect, mediaRect });
    } else {
      gpLog.debug("Konum: doğal yerleşim başarısız, matematiksel tahmine dönülüyor ⚠️");
      if (getComputedStyle(post).position === "static") {
        post.style.position = "relative";
      }
      positionButtonInActionRow(post, media.element, button);
    }
  });
}

/**
 * action-row'u bulup butonu oraya yerleştirmeyi dener. Bulunamazsa, hemen
 * pes etmek yerine birkaç kez gecikmeli tekrar dener (Reddit bazı
 * gönderilerde shadow DOM içeriğini asenkron/gecikmeli dolduruyor olabilir
 * — Paylaş butonu ararken de aynı sorunu yaşamıştık). Tüm denemeler
 * tükenirse, kanıtlanmış yedek yönteme (post'a doğal ekleme) düşer.
 */
function tryAttachButton(post, media, button, attemptsLeft = 6, delay = 300) {
  const actionRow = findActionRow(post);

  if (actionRow) {
    button.style.marginLeft = "auto"; // satır flex-row + justify-start; bizi sona iter
    actionRow.appendChild(button);

    requestAnimationFrame(() => {
      const rect = button.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        gpLog.debug("Konum: action-row'a eklendi ✅", { rect });
      } else {
        gpLog.debug("action-row bulundu ama buton görünmedi, tekrar denenecek ⚠️");
        button.remove();
        button.style.marginLeft = "";
        retryOrFallback();
      }
    });
    return;
  }

  retryOrFallback();

  function retryOrFallback() {
    if (attemptsLeft > 0) {
      setTimeout(() => tryAttachButton(post, media, button, attemptsLeft - 1, delay), delay);
    } else {
      gpLog.debug("action-row bulunamadı (tüm denemeler tükendi), post'a ekleniyor");
      attachToPostFallback(post, media, button);
    }
  }
}

/** Sayfadaki her <shreddit-post> öğesini bulup, içindeki medyaya buton ekler. */
/** Gönderinin sol üst köşesine küçük bir "✓ İndirildi" rozeti ekler. */
/**
 * ÖNEMLİ YENİ ÖZELLİK (orijinal eklentiden uyarlandı): Bir gönderiyi
 * GERÇEKTEN "ziyaret edilmiş" olarak işaretler — gizli bir iframe ile
 * gönderinin linkini yükleyip Reddit'in KENDİ ziyaret takibini tetikliyoruz.
 * Önceki yöntemimiz (sadece CSS ile soluklaştırma) sadece görseldi ve sayfa
 * yenilenince kayboluyordu. Bu yöntemle, sayfa yenilense bile Reddit'in
 * kendi arayüzünde gönderi "ziyaret edilmiş" görünmeye devam ediyor.
 */
function markPostAsVisitedOnReddit(postElement) {
  const link = postElement.querySelector('a[href*="/comments/"]');
  if (!link?.href) return false;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("hidden", "true");
  iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;";
  iframe.src = link.href;

  const remove = () => {
    try {
      iframe.remove();
    } catch {
      /* zararsız — zaten kaldırılmış olabilir */
    }
  };

  iframe.addEventListener("load", remove, { once: true });
  setTimeout(remove, 3000);

  document.body.appendChild(iframe);
  return true;
}

/** Gönderinin tarihini (ISO string) DOM'dan okur — tarih filtresi için. */
function extractPostDate(post) {
  const attrTimestamp = post.getAttribute?.("created-timestamp");
  if (attrTimestamp) return attrTimestamp;
  const timeEl = searchThroughShadowRoots(post, "time[datetime]") || post.querySelector("time[datetime]");
  return timeEl?.getAttribute("datetime") || null;
}

function injectButtons() {
  const posts = document.querySelectorAll("shreddit-post:not([" + PROCESSED_ATTR + "])");
  if (posts.length === 0) return;

  posts.forEach((post) => {
    const media = findMediaElement(post);
    if (!media) {
      // v1.44.2: Medyasız gönderiler (metin, link) önceden her taramada
      // baştan inceleniyordu. Medya geç yüklenebildiği için hemen
      // vazgeçmiyoruz ama 20 denemeden sonra "işlendi" sayıyoruz.
      const attempts = Number(post.getAttribute("data-grabpost-attempts") || 0) + 1;
      post.setAttribute("data-grabpost-attempts", String(attempts));
      if (attempts >= 20) post.setAttribute(PROCESSED_ATTR, "none");
      return;
    }

    post.setAttribute(PROCESSED_ATTR, "true");

    // Bu gönderi daha önce indirilmiş mi kontrol et. Kalıcı kimlik olarak
    // permalink kullanıyoruz (tıklamadan önce de erişilebilir olduğu için).
    // ÖNEMLİ: Artık bunun için ayrı bir yüzen rozet EKLEMİYORUZ — bunun
    // yerine createDownloadButton()'a bu bilgiyi veriyoruz, o da butonu
    // baştan "✓ İndirildi" durumunda oluşturuyor (aşağıda).
    const permalink = findPostPermalink(post);
    const alreadyDownloaded = permalink && cachedDownloadedIds.has(normalizePostKey(permalink));

    if (alreadyDownloaded && cachedSettings.markAsVisited) {
      // ÖNEMLİ DÜZELTME: Bu yorum daha önce "orijinal eklentideki özellik"
      // diyordu ama sadece kozmetik kısmı (soluklaştırma) uygulanmıştı —
      // asıl özellik (Reddit'in kendi ziyaret takibini tetiklemek) eksikti.
      // Artık markPostAsVisitedOnReddit() ile o da tetikleniyor.
      post.style.opacity = "0.55";
      post.style.filter = "grayscale(30%)";
      markPostAsVisitedOnReddit(post);
    }

    const button = createDownloadButton(post, media, alreadyDownloaded);
    tryAttachButton(post, media, button);

    gpLog.debug("Button attached, media type:", media.type);
  });
}

/**
 * ÖNEMLİ TASARIM DEĞİŞİKLİĞİ: Önceden "aksiyon satırını" (oy/yorum/paylaş
 * satırı), görsel ile gönderinin bitişi arasındaki boşluğu ölçerek MATEMATİKLE
 * tahmin ediyorduk. Bu, çoğu durumda çalışıyordu ama bazı gönderilerde
 * (özellikle sayfa kaydırılırken düzen yeniden hesaplandığında) buton gerçek
 * içerikten KOPUP, sayfada anlamsız/boş bir alanda asılı kalabiliyordu —
 * kullanıcı bunu fark etti. Şimdi çok daha SAĞLAM bir yönteme geçiyoruz:
 * buton, doğrudan GÖRSELİN KENDİSİNİN sağ-alt köşesine sabitleniyor. Satır
 * hizası hassasiyetinden vazgeçiyoruz ama buton artık HER ZAMAN gerçek
 * içerikle birlikte hareket ediyor (çünkü doğrudan görselin üzerine
 * bindiriliyor, ayrı bir satırın konumunu tahmin etmeye çalışmıyor).
 */
/**
 * ÖNEMLİ TASARIM DEĞİŞİKLİĞİ: Önceden "aksiyon satırını" (oy/yorum/paylaş
 * satırı), görsel ile gönderinin bitişi arasındaki boşluğu ölçerek MATEMATİKLE
 * tahmin ediyorduk. Bu, çoğu durumda çalışıyordu ama bazı gönderilerde
 * (özellikle sayfa kaydırılırken düzen yeniden hesaplandığında) buton gerçek
 * içerikten KOPUP, sayfada anlamsız/boş bir alanda asılı kalabiliyordu —
 * kullanıcı bunu fark etti. Şimdi çok daha SAĞLAM bir yönteme geçiyoruz:
 * satırı tahmin etmeye çalışmak yerine, butonu doğrudan GÖNDERİNİN sağ-alt
 * köşesine, sabit bir kenar boşluğuyla yerleştiriyoruz. Satır hizası
 * hassasiyetinden vazgeçiyoruz ama matematik artık çok daha basit ve
 * kırılgan olmayan bir referans noktası (gönderinin kendisi) kullanıyor.
 *
 * NOT: Butonu mediaEl'in (gallery-carousel, shreddit-media-lightbox-listener
 * gibi özel bileşenlerin) İÇİNE eklemiyoruz — bu bileşenler shadow DOM
 * kullanıyor ve varsayılan bir <slot> sunmayabilir, bu durumda içine eklenen
 * bir buton hiç GÖRÜNMEZ kalabilir. post'a eklemek kanıtlanmış şekilde
 * güvenli.
 */
function positionButtonInActionRow(post, mediaEl, button) {
  button.style.position = "absolute";

  const reposition = () => {
    if (getComputedStyle(post).position === "static") post.style.position = "relative";
    button.style.top = "";
    button.style.bottom = "10px";
    button.style.right = "10px";
  };

  reposition();

  const resizeObserver = new ResizeObserver(reposition);
  resizeObserver.observe(post);
}

/**
 * Bir Reddit post JSON verisinden (hem yeni hem eski Reddit için ortak)
 * medya bilgisini çıkarır. old.reddit.com'da sayfanın kendisi zengin embed
 * bilgisi sunmadığı için (sadece link + küçük thumbnail var), medya
 * bilgisini DOM'dan değil doğrudan Reddit'in API'sinden alıyoruz.
 */
async function extractMediaFromPostJson(postData) {
  const mediaLib = await mediaLibReady;
  return mediaLib.extractMediaFromPostData(postData, { resolveRedgifsMp4, fetchJson: fetchPublicJsonViaBg });
}

/** Çerezsiz JSON (Imgur API'si gibi herkese açık servisler için), arka plan üzerinden. */
async function fetchPublicJsonViaBg(url) {
  const response = await sendBg({ type: "FETCH_JSON", url, anonymous: true }, 3 * 60 * 1000);
  return response?.ok ? response.json : null;
}

/** fullname (ör. "t3_abc123") üzerinden Reddit API'sinden medya çeker. */
async function fetchPostMediaByFullname(fullname) {
  const id = fullname.replace(/^t3_/, "");
  const response = await bgFetchJson(`https://www.reddit.com/comments/${id}/.json?raw_json=1`);
  if (!response?.ok) {
    gpLog.warn(`old.reddit medya çekme hatası: HTTP ${response?.status}, hata: ${response?.error || "yok"}`);
    return null;
  }
  const postData = response.json?.[0]?.data?.children?.[0]?.data;
  if (!postData) return null;
  return extractMediaFromPostJson(postData);
}

/** old.reddit için tek bir gönderiyi indirir (tek tık ve toplu indirme ortak kullanır). */
async function downloadOldRedditPost(thing, fullname, button) {
  if (button.dataset.state === "loading") return;
  applyOldRedditButtonState(button, "loading");

  gpLog.debug("(old.reddit) Fetching media for", fullname);
  const resolved = await fetchPostMediaByFullname(fullname);
  if (resolved?.warning) gpLog.warn("Uyarı:", resolved.warning);

  if (!resolved) {
    button.dataset.errorText = tPage("inPageUnsupported", "Desteklenmiyor");
    applyOldRedditButtonState(button, "error");
    return;
  }

  const titleEl = thing.querySelector("a.title");
  const subredditEl = thing.querySelector("a.subreddit");
  const authorEl = thing.querySelector("a.author");
  const timeEl = thing.querySelector("time");
  let oldRedditAuthor = authorEl?.textContent?.trim() || "unknown";
  if (oldRedditAuthor === "unknown") {
    const profileMatch = location.pathname.match(/^\/user\/([^/]+)/);
    if (profileMatch) oldRedditAuthor = profileMatch[1];
  }
  const meta = {
    title: titleEl?.textContent?.trim() || "",
    subreddit: subredditEl?.textContent?.trim().replace(/^\/?r\//, "") || "unknown",
    author: oldRedditAuthor,
    date: timeEl?.getAttribute("datetime") || null,
  };

  const response = await sendBg({ type: "DOWNLOAD_MEDIA", media: resolved, meta, postId: fullname }, DOWNLOAD_MESSAGE_TIMEOUT_MS);
  gpLog.debug("(old.reddit) Background response:", response);
  if (response?.ok) {
    button.dataset.count = response.count;
    applyOldRedditButtonState(button, "done");
  } else {
    button.dataset.errorText = errorTextFor(response);
    applyOldRedditButtonState(button, "error");
  }
  return response;
}

/**
 * old.reddit.com desteği. Eski Reddit, shadow DOM/custom element kullanmıyor
 * — klasik, sade HTML. Her gönderi ".thing.link" class'ında bir <div>,
 * gerçek post kimliği "data-fullname" özniteliğinde duruyor. Zengin embed
 * bilgisi sayfada olmadığı için medyayı DOM'dan değil API'den çekiyoruz.
 */
/**
 * old.reddit'in kendi aksiyon satırındaki linkler (paylaş, kaydet, gizle vb.)
 * küçük, sade metin linkleridir — bizim normal Reddit'teki turuncu "hap"
 * butonumuz orada çok göze batıyor, yabancı duruyordu. Bu fonksiyon, o
 * satırın diğer linkleriyle aynı boyut/hizada ama GrabPost'tan geldiğini
 * belli eden turuncu bir renk kullanan, hafif bir buton stili uyguluyor.
 */
function applyOldRedditButtonState(button, state) {
  // ÖNEMLİ DÜZELTME: Yinelenen medya kontrolü bir dosyayı atladığında
  // (içerik daha önce indirilmiş), sunucudan count=0 dönüyor — ama
  // "✓ İndirildi (0)" demek kafa karıştırıcı ("0 dosya indirildi" gibi
  // okunuyor, oysa aslında "zaten indirilmişti, atlandı" demek). Bu
  // durumu ayrı, net bir mesajla gösteriyoruz.
  const doneText =
    button.dataset.count === "0"
      ? tPage("inPageAlreadyExists", "✓ Zaten indirilmiş (aynı içerik)")
      : button.dataset.count
        ? `${tPage("inPageDone", "✓ İndirildi")} (${button.dataset.count})`
        : tPage("inPageDone", "✓ İndirildi");

  const palette = {
    idle: { color: "#FF4500", text: tPage("inPageIdle", "⬇ İndir") },
    loading: { color: "#FF4500", text: tPage("inPageLoading", "İndiriliyor...") },
    done: { color: "#16a34a", text: doneText },
    error: { color: "#dc2626", text: button.dataset.errorText || tPage("inPageError", "Hata, tekrar dene") },
  };
  const { color, text } = palette[state] || palette.idle;

  button.dataset.state = state;
  button.textContent = text;

  Object.assign(button.style, {
    display: "inline",
    background: "none",
    border: "none",
    padding: "0",
    margin: "0",
    font: "inherit", // old.reddit'in kendi küçük yazı tipini/boyutunu miras al
    color,
    fontWeight: "700", // aynı boyutta ama kalın — GrabPost'tan geldiği belli olsun
    cursor: "pointer",
    textDecoration: "none",
  });
}

function injectOldRedditButtons() {
  const things = document.querySelectorAll(".thing.link:not([" + PROCESSED_ATTR + "])");
  if (things.length === 0) return;
  gpLog.debug(`(old.reddit) Scanning ${things.length} new post(s)`);

  things.forEach((thing) => {
    const fullname = thing.getAttribute("data-fullname");
    if (!fullname) return;
    thing.setAttribute(PROCESSED_ATTR, "true");

    const button = document.createElement("button");
    button.type = "button";
    applyOldRedditButtonState(button, "idle");

    registeredDownloads.push({
      button,
      root: thing,
      oldReddit: true, // eski Reddit butonu: kendi görünüm fonksiyonu (applyOldRedditButtonState) kullanılır
      subreddit: thing.querySelector("a.subreddit")?.textContent?.trim().replace(/^\/?r\//, "") || "unknown",
      alreadyDownloaded: cachedDownloadedIds.has(normalizePostKey(fullname)),
      trigger: () => downloadOldRedditPost(thing, fullname, button),
    });

    button.addEventListener(
      "click",
      async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        await downloadOldRedditPost(thing, fullname, button);
      },
      { capture: true },
    );

    // old.reddit'in kendi aksiyon satırı: ".flat-list.buttons" bir <ul>,
    // her buton bir <li>. Aynı yapıya uyup oraya ekliyoruz — shadow DOM
    // olmadığı için burada hiçbir slot/görünürlük sorunu yaşamıyoruz.
    const buttonsRow = thing.querySelector(".flat-list.buttons");
    if (buttonsRow) {
      const li = document.createElement("li");
      li.appendChild(button);
      buttonsRow.appendChild(li);
      gpLog.debug("(old.reddit) Button attached to action row ✅");
    } else {
      thing.appendChild(button);
      gpLog.debug("(old.reddit) .flat-list.buttons bulunamadı, thing'e eklendi ⚠️");
    }
  });
}

/** Hem yeni hem eski Reddit taramasını tetikler. Yanlış olan sadece boş döner. */
// ============================================================================
// ARAMA SONUÇLARI DESTEĞİ. Reddit, arama sayfasında normal "shreddit-post"
// elemanlarını KULLANMIYOR — tamamen farklı bir yapı var. Bu bölümdeki
// seçiciler, orijinal RedditGrab'in ŞUAN ÇALIŞAN, yayınlanmış kaynak kodu
// incelenerek (clean-room referans — hiçbir satır kopyalanmadı, sadece hangi
// seçicilerin işe yaradığı öğrenildi) doğrulandı. Orijinal eklenti bile
// arama sonuçlarına TEK TEK görünür buton koymuyor (sadece toplu indirmede
// arka planda tarıyor) — biz burada bir adım öteye geçip görünür buton da
// ekliyoruz.

const SEARCH_RESULT_ROOT_SELECTOR =
  '[data-testid="search-sdui-post"], [data-testid="search-post-with-content-preview"]';
const SEARCH_MEDIA_TILE_SELECTOR = 'a[href*="/comments/"]';
const SEARCH_COMMENTS_ID_RE = /\/comments\/([a-z0-9]+)/i;

/** Şu an bir Reddit arama sonuçları sayfasında mıyız? */
function isSearchResultsPage() {
  if (location.pathname.includes("/search")) return true;
  return document.querySelector(SEARCH_RESULT_ROOT_SELECTOR) !== null;
}

/** Arama sayfasının "Media" (Medya) sekmesinde miyiz? (Izgara görünümü, farklı yapı.) */
function isMediaSearchTab() {
  if (document.querySelector(SEARCH_RESULT_ROOT_SELECTOR)) return false;
  const type = new URLSearchParams(location.search).get("type");
  if (type === "media") return true;
  return (
    document.querySelector(
      '[data-id="search-media-post-unit"], a[href*="/comments/"] shreddit-aspect-ratio',
    ) !== null
  );
}

/** Media sekmesindeki ızgara kutucukları: her gönderi için birden fazla link olabilir, kimliğe göre tekilleştiriyoruz. */
function getSearchMediaTabRoots() {
  const byId = new Map();
  document.querySelectorAll(SEARCH_MEDIA_TILE_SELECTOR).forEach((anchor) => {
    const id = anchor.getAttribute("href")?.match(SEARCH_COMMENTS_ID_RE)?.[1];
    if (!id) return;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, anchor);
    } else if (anchor.querySelector("img, video") && !existing.querySelector("img, video")) {
      byId.set(id, anchor); // küçük resmi/videosu olan kutucuğu tercih et
    }
  });
  return Array.from(byId.values());
}

/** Sayfadaki tüm arama sonucu köklerini (Posts ya da Media sekmesi) döner. */
function getSearchResultRoots() {
  return isMediaSearchTab()
    ? getSearchMediaTabRoots()
    : Array.from(document.querySelectorAll(SEARCH_RESULT_ROOT_SELECTOR));
}

/** Bir arama sonucu kökünden Reddit gönderi kimliğini (t3_xxx) birkaç yedek yöntemle çıkarır. */
function getSearchThingId(root) {
  const direct = root.getAttribute("data-thingid");
  if (direct) return direct;

  const tracker = root.closest("[data-thingid]");
  if (tracker?.getAttribute("data-thingid")) return tracker.getAttribute("data-thingid");

  const carousel = root.querySelector("gallery-carousel[post-id]");
  const carouselId = carousel?.getAttribute("post-id");
  if (carouselId) return carouselId;

  const titleEl = root.querySelector('[id^="search-post-title-"]');
  const titleId = titleEl?.getAttribute("id");
  if (titleId) return titleId.replace("search-post-title-", "");

  const commentsHref = root.matches(SEARCH_MEDIA_TILE_SELECTOR)
    ? root.getAttribute("href")
    : root.querySelector(SEARCH_MEDIA_TILE_SELECTOR)?.getAttribute("href");
  const commentsId = commentsHref?.match(SEARCH_COMMENTS_ID_RE)?.[1];
  if (commentsId) return `t3_${commentsId}`;

  return null;
}

function getSearchSubredditName(root) {
  const link = root.querySelector('a[href^="/r/"]');
  const match = link?.getAttribute("href")?.match(/^\/r\/([^/]+)/);
  return match ? match[1] : "unknown";
}

/** Arama sonucundan yazar adını çeker (aynı /comments/ hariç tutma kuralıyla). */
function getSearchAuthorName(root) {
  const link = root.querySelector('a[href*="/user/"]:not([href*="/comments/"])');
  const match = link?.getAttribute("href")?.match(/^\/user\/([^/]+)/);
  if (match) return match[1];
  // Kullanıcı profili sayfasındaysak (ör. arama bir profil içinde
  // yapılıyorsa), yazar linki hiç olmayabilir — sayfanın adresinden çıkar.
  const profileMatch = location.pathname.match(/^\/user\/([^/]+)/);
  return profileMatch ? profileMatch[1] : "unknown";
}

function getSearchPostTitle(root) {
  const el = root.querySelector('[data-testid="post-title-text"], a[data-testid="post-title"]');
  return el?.textContent?.trim() || "";
}

function getSearchPostDate(root) {
  const el = root.querySelector("time[datetime]");
  return el?.getAttribute("datetime") || null;
}

/**
 * Bir arama sonucundan indirilebilir medyayı çözer. Galeri varsa sayfadan
 * doğrudan (tam çözünürlük carousel'den), diğer türlerde (video/redgifs/tekli
 * görsel sadece küçük önizleme gösteriyor) Reddit API'sinden çözüyoruz —
 * old.reddit akışıyla aynı `fetchPostMediaByFullname` fonksiyonunu kullanarak.
 */
async function extractSearchResultMedia(root) {
  const thingId = getSearchThingId(root);
  if (!thingId) return null;

  try {
    const carousel = root.querySelector("gallery-carousel");
    if (carousel) {
      const urls = getGalleryImageUrls(root);
      if (urls.length === 0) return null;
      return {
        type: "gallery",
        urls,
        thingId,
        subreddit: getSearchSubredditName(root),
        author: getSearchAuthorName(root),
        title: getSearchPostTitle(root),
        date: getSearchPostDate(root),
      };
    }

    const media = await fetchPostMediaByFullname(thingId);
    if (!media) return null;
    return {
      type: media.type,
      urls: media.urls,
      // v1.43.7: ses kaynağı alanları önceden burada düşürülüyordu (arama sonuçlarından inen videolar sessizdi)
      audioUrl: media.audioUrl,
      audioCandidates: media.audioCandidates,
      dashUrl: media.dashUrl,
      hlsUrl: media.hlsUrl,
      thingId,
      subreddit: getSearchSubredditName(root),
      author: getSearchAuthorName(root),
      title: getSearchPostTitle(root),
      date: getSearchPostDate(root),
    };
  } catch (error) {
    gpLog.warn("Arama sonucu medya çözme hatası:", thingId, error);
    return null;
  }
}

/** Tek bir arama sonucunu indirir (tek tık ve toplu indirme ortak kullanır). */
async function downloadSearchResultPost(root, button, preResolved) {
  if (button.dataset.state === "loading") return;
  applyButtonState(button, "loading");

  const resolved = preResolved ? await preResolved.catch(() => null) : await extractSearchResultMedia(root);
  if (!resolved) {
    button.dataset.errorText = tPage("inPageUnsupported", "Desteklenmiyor");
    applyButtonState(button, "error");
    return;
  }

  const meta = { subreddit: resolved.subreddit, author: resolved.author || "unknown", title: resolved.title, date: resolved.date };

  const response = await sendBg(
    { type: "DOWNLOAD_MEDIA", media: { type: resolved.type, urls: resolved.urls, audioUrl: resolved.audioUrl, audioCandidates: resolved.audioCandidates, dashUrl: resolved.dashUrl, hlsUrl: resolved.hlsUrl }, meta, postId: resolved.thingId },
    DOWNLOAD_MESSAGE_TIMEOUT_MS,
  );
  if (response?.ok) {
    button.dataset.count = response.count;
    applyButtonState(button, "done");
  } else {
    button.dataset.errorText = errorTextFor(response);
    applyButtonState(button, "error");
  }
  return response;
}

/** Butonu, arama sonucu kutucuğunun sağ alt köşesine sabitler. */
function positionSearchResultButton(root, button) {
  if (getComputedStyle(root).position === "static") {
    root.style.position = "relative";
  }
  // ÖNEMLİ: Reddit'in sabit üst menüsü (z-index:4) altında kalsın diye düşük tutuyoruz.
  Object.assign(button.style, { position: "absolute", bottom: "8px", right: "8px", zIndex: "2" });
}

function createSearchResultButton(root) {
  const button = document.createElement("button");
  button.type = "button";
  applyButtonState(button, "idle");

  registeredDownloads.push({
    button,
    root,
    subreddit: getSearchSubredditName(root),
    prepare: () => extractSearchResultMedia(root),
    trigger: (pre) => downloadSearchResultPost(root, button, pre),
  });

  button.addEventListener(
    "click",
    async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      await downloadSearchResultPost(root, button);
    },
    { capture: true },
  );

  return button;
}

/** Arama sonuçları sayfasındaysak, her sonuca (Posts ya da Media sekmesi) buton ekler. */
function injectSearchResultButtons() {
  if (!isSearchResultsPage()) return;

  const roots = getSearchResultRoots();
  const newRoots = roots.filter((root) => !root.hasAttribute(PROCESSED_ATTR));
  if (newRoots.length === 0) return;
  gpLog.debug(`Arama sonuçları taranıyor: ${newRoots.length} yeni sonuç`);

  newRoots.forEach((root) => {
    root.setAttribute(PROCESSED_ATTR, "true");
    const button = createSearchResultButton(root);
    positionSearchResultButton(root, button);
    root.appendChild(button);
  });
}

/**
 * v1.45.6 YORUMLARDAKİ GÖRSELLER: Yorumlara eklenen görsellerin üzerine
 * küçük bir "⬇" butonu konuyor (fare üzerine gelince belirginleşiyor).
 * Önizleme (preview.redd.it) yerine asıl dosya (i.redd.it) indiriliyor.
 * "İndirildi" kaydı YORUMA özel tutuluyor (comment:<id>); böylece yorumdaki
 * bir görseli indirmek, gönderinin kendisini "indirildi" saymıyor.
 */
const COMMENT_IMG_ATTR = "data-grabpost-comment-img";

function commentImageFullUrl(src) {
  const m = String(src || "").match(/^https:\/\/(?:preview|i)\.redd\.it\/([^?#/]+\.(?:jpe?g|png|gif|webp))/i);
  return m ? `https://i.redd.it/${m[1]}` : null;
}

async function downloadCommentImage(img, comment, button) {
  const url = commentImageFullUrl(img.currentSrc || img.src) || img.currentSrc || img.src;
  if (!url) return;
  if (button) button.textContent = "…";
  const postEl = document.querySelector("shreddit-post");
  const thingId = comment.getAttribute("thingid") || comment.getAttribute("id") || url;
  const meta = {
    subreddit: postEl?.getAttribute("subreddit-prefixed-name")?.replace(/^r\//i, "") || location.pathname.match(/^\/r\/([^/]+)/)?.[1] || "unknown",
    author: comment.getAttribute("author") || "unknown",
    title: `${postEl?.getAttribute("post-title") || ""} (${tPage("commentLabel", "comment")})`.trim(),
    date: comment.getAttribute("created") || null,
  };
  const response = await sendBg({ type: "DOWNLOAD_MEDIA", media: { type: "image", urls: [url] }, meta, postId: `comment:${thingId}` }, DOWNLOAD_MESSAGE_TIMEOUT_MS);
  if (button) button.textContent = response?.ok ? "✓" : "⚠";
}

function injectCommentImageButtons() {
  const imgs = document.querySelectorAll(`shreddit-comment img:not([${COMMENT_IMG_ATTR}])`);
  imgs.forEach((img) => {
    const src = img.currentSrc || img.src || "";
    // Sadece Reddit'e yüklenmiş içerik görselleri (avatar, emoji, ödül ikonları hariç).
    if (!commentImageFullUrl(src)) return;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w && h && (w < 80 || h < 80)) return;
    img.setAttribute(COMMENT_IMG_ATTR, "1");
    const comment = img.closest("shreddit-comment");
    const host = img.parentElement;
    if (!comment || !host) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const btn = document.createElement("button");
    btn.setAttribute("data-grabpost-comment-btn", "1");
    btn.type = "button";
    btn.textContent = "⬇";
    btn.title = tPage("ctxDownload", "Download with GrabPost");
    btn.style.cssText =
      "position:absolute;top:6px;right:6px;z-index:5;width:26px;height:26px;border-radius:50%;border:none;cursor:pointer;" +
      "background:#FF4500;color:#fff;font-size:13px;line-height:26px;padding:0;opacity:.75;box-shadow:0 1px 3px rgba(0,0,0,.35);";
    btn.addEventListener("mouseenter", () => (btn.style.opacity = "1"));
    btn.addEventListener("mouseleave", () => (btn.style.opacity = ".75"));
    btn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        downloadCommentImage(img, comment, btn);
      },
      { capture: true },
    );
    host.appendChild(btn);
  });
}

function injectAllButtons() {
  injectButtons();
  injectOldRedditButtons();
  injectSearchResultButtons();
  injectCommentImageButtons();
}

/**
 * Toplu indirme: sidepanel'den gelen mesajla tetiklenir. Sayfada şu ana
 * kadar tespit edilmiş (ve henüz indirilmemiş) her gönderiyi SIRAYLA
 * indirir. Sırayla yapıyoruz (hepsini aynı anda değil) ki hem Reddit/Redgifs
 * API'lerini bombardımana tutmayalım hem de indirmeler klasörde karışmasın.
 */

/** Bir gönderinin, mevcut medya türü/tarih filtrelerine uyup uymadığını kontrol eder. */
function passesBulkFilters(entry) {
  const typeFilter = cachedSettings.mediaTypeFilter || "all";
  if (typeFilter !== "all" && entry.mediaType) {
    const isVideo = entry.mediaType === "video";
    if (typeFilter === "images" && isVideo) return false;
    if (typeFilter === "videos" && !isVideo) return false;
  }

  const { dateFrom, dateTo, enableDateFilter } = cachedSettings;
  if (enableDateFilter && (dateFrom || dateTo) && entry.postDate) {
    const postTime = new Date(entry.postDate).getTime();
    if (dateFrom && postTime < new Date(dateFrom).getTime()) return false;
    if (dateTo && postTime > new Date(dateTo).getTime() + 24 * 60 * 60 * 1000 - 1) return false;
  }

  return true;
}

let bulkDownloadRunning = false;
let bulkDownloadStopRequested = false;
const BULK_MAX_BACKLOG = 12; // v1.49.0: tarama indirmenin en fazla bu kadar gönderi önünde olabilir
const BULK_PREFETCH_AHEAD = 2; // v1.49.0: inen gönderiye ek olarak önden çözülen gönderi sayısı

/**
 * Öğe, kaydırma yönünde ekranın henüz ilerisinde mi (hiç görünmedi mi)?
 * extra: ekran yüksekliğinin bu oranı kadar pay (0.5 = yarım ekran ileri kabul).
 */
function isAheadOfViewport(el, extra = 0) {
  const r = el.getBoundingClientRect();
  if (r.height === 0 && r.width === 0) return false;
  const h = window.innerHeight;
  return (cachedSettings.scrollDirection || "down") === "up" ? r.bottom < -h * extra : r.top > h * (1 + extra);
}

/** Sidepanel'e (ve dinleyen herkese) ilerleme durumunu yayınlar. */
function broadcastBulkProgress(payload) {
  // Yan panel açık değilse "receiving end does not exist" döner; zararsız.
  sendBg({ type: "BULK_PROGRESS", ...payload }, 10 * 1000);
}

/**
 * ÖNEMLİ MİMARİ DÜZELTME (2. aşama): Bir önceki halimizde kaydırma ve
 * indirme AYNI döngüdeydi — her gönderiyi bulduğumuzda hemen indirip
 * BİTMESİNİ bekledikten sonra devam ediyorduk. Bu, kaydırmanın indirmeyi
 * beklemesine sebep oluyordu (yüzde çubuğu hep 98-100 arası takılı
 * kalıyordu çünkü aynı anda hep en fazla 1 bekleyen gönderi vardı).
 *
 * Şimdi TAMAMEN AYRI iki döngü var, aynı anda (paralel) çalışıyorlar:
 * - TARAMA döngüsü: sadece kaydırıp yeni gönderi bulmaya devam ediyor,
 *   hiçbir indirmeyi beklemiyor.
 * - İNDİRME döngüsü: tarama ne bulursa arka planda sırayla indiriyor.
 * İkisi de kendi bulk_seen/bulk_queued işaretlerini kullanarak
 * registeredDownloads listesi üzerinden haberleşiyor.
 */
async function runBulkDownload() {
  if (bulkDownloadRunning) {
    gpLog.warn("Toplu indirme zaten çalışıyor (önceki çalıştırma henüz tam durmamış olabilir), yeni istek yok sayıldı");
    return;
  }
  bulkDownloadRunning = true;
  bulkDownloadStopRequested = false;

  // ÖNEMLİ DÜZELTME: Bir önceki çalıştırmadan kalan "bu turda görüldü/
  // kuyruğa alındı" işaretleri (bulkSeen/bulkQueued/bulkDownloadStarted)
  // temizlenmiyordu — bu yüzden "Durdur"a basıp tekrar "İndir" derseniz,
  // zaten görülmüş ama indirilmemiş gönderiler bile taramada "zaten
  // işlendi" sanılıp atlanabiliyordu. Gerçekten indirilmiş olanlar hariç
  // (onlar zaten button state="done" ile ayrı takip ediliyor), her yeni
  // çalıştırmada bu işaretleri sıfırlıyoruz.
  // v1.49.4 "Zorla tekrar indir": açıksa daha önce indirilmiş gönderiler de
  // (bu sayfada indirilenler dahil) yeniden kuyruğa girer, "5 indirilmiş
  // gönderide dur" kuralı uygulanmaz.
  const forceRedownload = !!cachedSettings.forceRedownload;
  registeredDownloads.forEach((d) => {
    if (forceRedownload || d.button.dataset.state !== "done") {
      d.bulkSeen = false;
      d.bulkQueued = false;
      d.bulkDownloadStarted = false;
      d.prepared = null;
    }
  });

  let scanningFinished = false;
  let hitAlreadyDownloaded = false;
  // ÖNEMLİ DÜZELTME: Önceden TEK bir "daha önce indirilmiş" gönderiye
  // rastlamak taramayı anında durduruyordu — orijinal eklentinin mantığı
  // buydu. Ama Reddit'te bir profilin/subreddit'in en üstünde SABİTLENMİŞ
  // (pinned) bir gönderi varsa ve o gönderi daha önce indirilmişse,
  // altında onlarca yepyeni gönderi olsa bile tarama HİÇ BAŞLAMADAN
  // duruyordu. Artık tek bir rastgele eşleşmeye karşı toleranslıyız —
  // gerçekten "içeriğin sonuna ulaştık" diyebilmek için ARKA ARKAYA
  // birden fazla eşleşme gerekiyor.
  let consecutiveAlreadyDownloaded = 0;
  const REQUIRED_CONSECUTIVE_MATCHES = 5;
  let totalFound = 0;
  let totalDownloaded = 0;

  gpLog.debug("Toplu indirme (paralel tarama+indirme) başlıyor...");
  broadcastBulkProgress({ phase: "downloading", completed: 0, total: 0 });

  /** Sadece kaydırıp yeni gönderi bulmaya devam eder — indirmeyi HİÇ beklemez. */
  async function scanLoop() {
    const direction = cachedSettings.scrollDirection || "down";
    const stepSize = Math.round(window.innerHeight * 0.85);
    let lastHeight = document.body.scrollHeight;
    let stableCount = 0;
    // ÖNEMLİ DÜZELTME: 300 tur, 550+ gönderilik bir profilde (her gönderi
    // ekranın önemli bir kısmını kapladığı için) YETERSİZ kalıyordu — daha
    // fazla içerik olduğu halde tarama bu sayıya ulaşınca kendiliğinden
    // duruyordu. Gerçek bir "sonsuz döngü" güvenlik ağı olarak çok daha
    // yüksek bir sınıra çıkardık; normal durumda zaten çok daha erken
    // (sayfanın gerçek sonuna ya da daha önce indirilmiş bir gönderiye
    // ulaşınca) duruyor.
    const maxIterations = 3000;

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (bulkDownloadStopRequested || hitAlreadyDownloaded) break;

        injectAllButtons(); // o an görünen yeni gönderilere buton ekle/kaydet

      const freshlyFound = registeredDownloads.filter(
        (d) => !d.bulkSeen && (forceRedownload || d.button.dataset.state !== "done") && passesBulkFilters(d),
      );
      for (const entry of freshlyFound) {
        entry.bulkSeen = true; // aynı taramada tekrar ele alınmasın
        if (entry.alreadyDownloaded && !forceRedownload) {
          consecutiveAlreadyDownloaded++;
          if (consecutiveAlreadyDownloaded >= REQUIRED_CONSECUTIVE_MATCHES) {
            // Arka arkaya birkaç kez daha önce indirilmiş gönderiye
            // rastladık — bu artık gerçekten "buradan sonrası eski"
            // demek, tek bir sabitlenmiş (pinned) gönderi değil.
            gpLog.debug(
              `[MediaGrab] Arka arkaya ${REQUIRED_CONSECUTIVE_MATCHES} kez daha önce indirilmiş gönderiye ulaşıldı, tarama durduruluyor`,
            );
            hitAlreadyDownloaded = true;
            break;
          }
          // Tek bir eşleşme (muhtemelen sabitlenmiş/tekrar paylaşılmış bir
          // gönderi) — taramayı durdurmadan bu gönderiyi atlayıp devam ediyoruz.
          continue;
        }
        consecutiveAlreadyDownloaded = 0; // yeni bir gönderi bulundu, sayaç sıfırlanır
        entry.bulkQueued = true; // indirme döngüsü bunu görüp sıraya alacak
        totalFound++;
      }

      if (hitAlreadyDownloaded) break;

      // v1.49.0 SINIRLI ÖNDEN TARAMA: Tarama indirmenin çok önüne geçerse
      // kuyruktaki gönderiler ekrandan çok uzakta kalıyor; Reddit bu
      // gönderilerin oynatıcı/görsel öğelerini boşaltabiliyor ve medya
      // çözümü yedek yollara düşüyordu. Bekleyen sayısı sınırı aşınca
      // indirme yetişene kadar kaydırmayı bekletiyoruz.
      while (!bulkDownloadStopRequested && registeredDownloads.filter((d) => d.bulkQueued && !d.bulkDownloadStarted).length >= BULK_MAX_BACKLOG) {
        await new Promise((r) => setTimeout(r, 400));
      }
      if (bulkDownloadStopRequested) break;

      // Şimdi biraz daha kaydır (indirmeyi beklemeden).
      // ÖNEMLİ DÜZELTME: Reddit'in "daha fazla gönderi yükle" isteği
      // bazen 450ms'den uzun sürüyor (ağ + render) — bu sürede sayfa
      // boyutu henüz değişmediği için "daha fazla içerik yok" diye ERKEN
      // karar veriyorduk, taramanın sayfanın tamamını bitirmeden
      // ÖNEMLİ DÜZELTME (orijinal eklentinin kaynak koduna bakılarak):
      // Orijinalde tur sınırı YOK ve "arka arkaya N kez boyut değişmedi,
      // bitti say" mantığı da yok — kullanıcı durdurana kadar (ya da
      // gerçekten en tepeye ulaşılana kadar) kaydırıp beklemeye devam
      // ediyor. Bizim daha önceki "4 tur değişmezse dur" eşiğimiz çok
      // erken pes ediyordu, özellikle uzun/görsel-ağırlıklı profillerde
      // Reddit'in kendi yavaş yüklemesine yetişemiyorduk. Eşiği çok daha
      // sabırlı hale getirdik (20 tur, ~1 saniye aralıklarla — yaklaşık
      // 20 saniyelik sürekli "değişiklik yok" gerekiyor artık).
      if (direction === "up") {
        window.scrollBy({ top: -stepSize, behavior: "smooth" });
        await new Promise((r) => setTimeout(r, 1000));
        if (window.scrollY <= 0) {
          stableCount++;
          if (stableCount >= 20) {
            gpLog.debug("En tepeye ulaşıldı, tarama durduruluyor");
            break;
          }
        } else {
          stableCount = 0;
        }
      } else {
        window.scrollBy({ top: stepSize, behavior: "smooth" });
        await new Promise((r) => setTimeout(r, 1000));
        const newHeight = document.body.scrollHeight;
        const atBottom = window.innerHeight + window.scrollY >= newHeight - 10;
        if (atBottom && newHeight === lastHeight) {
          stableCount++;
          if (stableCount >= 20) {
            gpLog.debug("Sayfanın sonuna ulaşıldı, tarama durduruluyor");
            break;
          }
        } else {
          stableCount = 0;
        }
        lastHeight = newHeight;
      }
      }
    } catch (error) {
      gpLog.warn("Tarama döngüsünde beklenmedik hata:", error);
    } finally {
      scanningFinished = true;
    }
  }

  /** Tarama ne bulursa arka planda sırayla indirir — taramayı hiç beklemez, kuyruğu dinler. */
  async function downloadLoop() {
    while (!bulkDownloadStopRequested) {
      const next = registeredDownloads.find((d) => d.bulkQueued && !d.bulkDownloadStarted);
      if (!next) {
        // Kuyrukta şu an bir şey yok. Tarama bittiyse (ya da zaten daha
        // önce indirilmiş bir gönderiye ulaşıldıysa) artık gelecek bir
        // şey yok demektir — bitir. Yoksa tarama henüz yeni bir şey
        // bulmamış olabilir, kısa bir süre bekleyip tekrar bak.
        if (scanningFinished || hitAlreadyDownloaded) break;
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }

      next.bulkDownloadStarted = true;
      // v1.49.0 ÖNDEN ÇÖZME: Sıradaki birkaç gönderinin medyasını şimdiden
      // çözmeye başla (gönderi hâlâ ekrana yakınken). Biri inerken diğerinin
      // adresi hazırlanıyor; istek sayısı değişmiyor, sadece zamanlaması.
      // Gönderi hiç ekrana gelmediyse (kaydırma, kuyruk dolu diye
      // bekletildiği için ilerisinde kaldıysa) önce onu ekrana getir:
      // Reddit tembel yüklenen görsel/oynatıcı öğelerini ancak gönderi
      // görünür olunca dolduruyor. Kaydırma yönündeki ilerleme buradan devam eder.
      if (next.root?.isConnected && isAheadOfViewport(next.root)) {
        next.root.scrollIntoView({ block: "center" });
        await new Promise((r) => setTimeout(r, 350));
      }
      if (next.prepare && !next.prepared) next.prepared = next.prepare();
      registeredDownloads
        .filter((d) => d.bulkQueued && !d.bulkDownloadStarted && d.prepare && !d.prepared && !(d.root && isAheadOfViewport(d.root, 0.5)))
        .slice(0, BULK_PREFETCH_AHEAD)
        .forEach((d) => {
          d.prepared = d.prepare();
          d.prepared.catch(() => {}); // işlenmemiş hata uyarısı olmasın
        });
      broadcastBulkProgress({
        phase: "downloading",
        completed: totalDownloaded,
        total: totalFound,
        currentIndex: totalDownloaded + 1,
        currentSubreddit: next.subreddit || "unknown",
        currentType: next.mediaType || "",
      });

      // v1.49.4: İnmekte olan gönderiyi turuncu çerçeveyle göster.
      const highlightEl = next.root?.isConnected ? next.root : null;
      const prevOutline = highlightEl?.style.outline;
      const prevOffset = highlightEl?.style.outlineOffset;
      if (highlightEl) {
        highlightEl.style.outline = "3px solid #FF4500";
        highlightEl.style.outlineOffset = "-3px";
      }
      try {
        await next.trigger(next.prepared);
      } catch (error) {
        gpLog.warn("Toplu indirmede hata:", error);
      } finally {
        if (highlightEl) {
          highlightEl.style.outline = prevOutline || "";
          highlightEl.style.outlineOffset = prevOffset || "";
        }
      }
      next.prepared = null;
      totalDownloaded++;
      broadcastBulkProgress({ phase: "downloading", completed: totalDownloaded, total: totalFound });
      // ÖNEMLİ: Orijinal eklentinin kaynak kodunda da AYNI süre (1 saniye)
      // kullanılıyor — "sistemi/Reddit'i boğmamak için". Kullanıcı gerçek
      // bir IP kısıtlaması yaşadığı için 600ms'den 1000ms'ye çıkardık.
      // Ek olarak: HEP tam olarak aynı süreyi beklemek kendi başına bir
      // "bot imzası" olabilir — gerçek bir insan bu kadar mekanik
      // düzenlilikte tıklamaz. Küçük bir rastgelelik ekliyoruz.
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1200)));
    }
  }

  // İkisini AYNI ANDA başlatıyoruz — tarama indirmeyi beklemiyor.
  await Promise.all([scanLoop(), downloadLoop()]);

  const stopped = bulkDownloadStopRequested;
  bulkDownloadRunning = false;
  bulkDownloadStopRequested = false;

  gpLog.debug(
    stopped
      ? "[MediaGrab] Toplu indirme kullanıcı tarafından durduruldu"
      : `[MediaGrab] Toplu indirme tamamlandı (${totalDownloaded}/${totalFound} gönderi indirildi)`,
  );
  broadcastBulkProgress({ phase: stopped ? "stopped" : "finished", completed: totalDownloaded, total: totalFound });
}

/**
 * v1.45.1 SAĞ TIK MENÜSÜ VE KLAVYE KISAYOLU
 * - Sağ tık > "GrabPost ile indir": tıklanan görsel/video/bağlantının ait
 *   olduğu gönderi bulunup o gönderinin normal indirme akışı çalıştırılır
 *   (tam çözünürlük, galeri, ses dahil). Gönderi bulunamazsa false döner;
 *   arka plan bu durumda dosyanın kendisini indirir.
 * - Alt+Shift+D: ekranın ortasındaki gönderi indirilir.
 */
function findRegisteredEntryFor(element) {
  if (!element) return null;
  return registeredDownloads.find((d) => d.root && (d.root === element || d.root.contains(element))) || null;
}

function findElementBySrc(url) {
  if (!url) return null;
  const esc = CSS.escape(url);
  const direct = document.querySelector(`img[src="${esc}"], video[src="${esc}"], source[src="${esc}"]`);
  if (direct) return direct;
  const all = document.querySelectorAll("img, video");
  for (const el of all) if (el.currentSrc === url || el.src === url) return el;
  return searchThroughShadowRoots(document.body, `img[src="${esc}"], video[src="${esc}"]`);
}

function findElementByLink(url) {
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    return document.querySelector(`a[href="${CSS.escape(url)}"], a[href="${CSS.escape(path)}"]`);
  } catch {
    return null;
  }
}

async function handleContextDownload({ srcUrl, linkUrl }) {
  // Önce yorum görseli mi? (kendi indirme yolu var)
  const el = findElementBySrc(srcUrl) || findElementByLink(linkUrl);
  const commentHost = el?.closest?.("shreddit-comment");
  if (commentHost && srcUrl && typeof downloadCommentImage === "function") {
    await downloadCommentImage(el, commentHost, null);
    return true;
  }
  const entry = findRegisteredEntryFor(el?.closest?.("shreddit-post, .thing, [data-testid='search-post-unit']") || el);
  if (entry) {
    await entry.trigger();
    return true;
  }
  // Bir gönderi bağlantısına sağ tıklandıysa: gönderi verisini çekip indir.
  const permalinkMatch = linkUrl && String(linkUrl).match(/\/r\/[^/]+\/comments\/[a-z0-9]+\/[^?#]*/i);
  if (permalinkMatch) {
    const response = await bgFetchJson(`https://www.reddit.com${permalinkMatch[0].replace(/\/?$/, "/")}.json?raw_json=1`);
    const postData = response?.json?.[0]?.data?.children?.[0]?.data;
    const media = postData ? await extractMediaFromPostJson(postData) : null;
    if (media) {
      const meta = {
        subreddit: postData.subreddit || "unknown",
        author: postData.author || "unknown",
        title: postData.title || "",
        date: postData.created_utc ? postData.created_utc * 1000 : null,
      };
      await sendBg({ type: "DOWNLOAD_MEDIA", media, meta, postId: postData.permalink }, DOWNLOAD_MESSAGE_TIMEOUT_MS);
      return true;
    }
  }
  return false;
}

function downloadFocusedPost() {
  const centerY = window.innerHeight / 2;
  let best = null;
  let bestDist = Infinity;
  for (const entry of registeredDownloads) {
    if (!entry.root?.isConnected) continue;
    const r = entry.root.getBoundingClientRect();
    if (r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
    const dist = r.top <= centerY && r.bottom >= centerY ? 0 : Math.min(Math.abs(r.top - centerY), Math.abs(r.bottom - centerY));
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  if (!best) return false;
  const prevOutline = best.root.style.outline;
  best.root.style.outline = "2px solid #FF4500";
  setTimeout(() => (best.root.style.outline = prevOutline), 800);
  best.trigger();
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (gpInstanceStale) return false; // v1.50.2: durdurulmuş/gereksiz kopya mesajlara cevap vermez
  if (message?.type === "CONTEXT_DOWNLOAD") {
    handleContextDownload(message)
      .then((handled) => sendResponse({ handled }))
      .catch((error) => {
        gpLog.warn("Sağ tık indirme hatası:", error);
        sendResponse({ handled: false });
      });
    return true;
  }
  if (message?.type === "DOWNLOAD_FOCUSED_POST") {
    sendResponse({ handled: downloadFocusedPost() });
    return false;
  }
  return false;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (gpInstanceStale) return false; // v1.50.2: durdurulmuş/gereksiz kopya mesajlara cevap vermez
  if (message?.type === "BULK_DOWNLOAD") {
    // ÖNEMLİ: İşlemin bitmesini BEKLEMİYORUZ (dakikalar sürebilir, mesaj
    // kanalı bu kadar uzun açık kalamıyor — "kanal kapandı" hatasının
    // sebebi buydu). Hemen "başladı" diye onaylıyoruz, gerçek ilerlemeyi
    // ayrı bir kanaldan (BULK_PROGRESS mesajları) zaten yayınlıyoruz.
    runBulkDownload();
    sendResponse({ ok: true, started: true });
    return false;
  }
  if (message?.type === "STOP_BULK_DOWNLOAD") {
    bulkDownloadStopRequested = true;
    gpLog.debug("Durdurma isteği alındı");
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "GET_BULK_STATUS") {
    sendResponse({
      running: bulkDownloadRunning,
      total: registeredDownloads.length,
      done: registeredDownloads.filter((d) => d.button.dataset.state === "done").length,
    });
    return false;
  }
  return false;
});

// İlk yükleme — ÖNEMLİ: buton oluşturmadan (ve "daha önce indirildi mi"
// kontrolü yapmadan) önce hafıza önbelleğinin (cachedDownloadedIds) gerçekten
// yüklenmiş olduğundan emin oluyoruz. Bunu beklemezsek, sayfa her
// yenilendiğinde daha önce indirilmiş gönderiler "hiç indirilmemiş" sanılıp
// tekrar indiriliyordu.
(async () => {
  await initialCacheReady;
  // v1.49.1: Güncellemeden sonra enjekte edildiysek eski kopyanın kendi
  // düğmelerini kaldırması için bir an bekle (aynı gönderiye iki düğme olmasın).
  await new Promise((r) => setTimeout(r, 60));
  if (gpInstanceStale) return;
  if (gpDuplicateOfLive) {
    gpInstanceStale = true;
    for (const fn of gpCleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* zararsız */
      }
    }
    return;
  }
  injectAllButtons();

  // Reddit sonsuz kaydırma ile yeni gönderileri DOM'a sonradan ekliyor;
  // bu yüzden değişiklikleri izleyip yeni gelen postlara da buton koyuyoruz.
  // v1.44.2 PERFORMANS: Önceden Reddit'in HER DOM değişikliğinde (saniyede
  // onlarca; bizim buton eklememiz dahil) tüm tarama anında yeniden
  // çalışıyordu. Artık değişiklikler 150 ms toplanıp tek taramada
  // işleniyor; sürekli değişen sayfada da en geç 600 ms'de bir tarama
  // garanti. Uzun profillerde takılmayı azaltır.
  let scanTimer = null;
  let firstPendingAt = 0;
  const scheduleScan = () => {
    const now = Date.now();
    if (!firstPendingAt) firstPendingAt = now;
    clearTimeout(scanTimer);
    const wait = now - firstPendingAt >= 600 ? 0 : 150;
    scanTimer = setTimeout(() => {
      firstPendingAt = 0;
      injectAllButtons();
    }, wait);
  };
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  gpCleanups.push(() => observer.disconnect(), () => clearTimeout(scanTimer));
})();

/**
 * ÖNEMLİ HATA DÜZELTMESİ: Reddit, sayfalar arası geçişte TAM SAYFA
 * YENİLEMESİ yapmıyor (tek sayfa uygulaması / SPA). Yani ana sayfadan bir
 * gönderiye, oradan bir kullanıcı profiline geçerken content.js hiç yeniden
 * yüklenmiyor — aynı script, oturum boyunca çalışmaya devam ediyor ve
 * "registeredDownloads" listesi TÜM gezinti geçmişindeki gönderileri
 * biriktiriyordu. "Bu sayfadaki her şeyi indir" dendiğinde de o birikmiş
 * listenin tamamı kullanılıyordu, sadece o an görünen sayfa değil.
 *
 * Çözüm: URL değişikliğini izleyip, gerçekten farklı bir sayfaya
 * geçildiğinde bu listeyi sıfırlıyoruz.
 *
 * 2. HATA DÜZELTMESİ (daha sonra bulundu): location.href'in TAMAMINI
 * (sorgu parametreleri dahil) karşılaştırıyorduk. Ama kullanıcı profili
 * gibi sayfalarda, siz kaydırdıkça Reddit'in kendisi URL'ye sayfalama
 * imleci ekliyor (ör. "?after=...") — GERÇEK bir sayfa değişikliği
 * olmadan. Biz bunu "sayfa değişti" sanıp registeredDownloads'ı
 * sıfırlıyorduk, bu da "daha önce indirildi" bilgisinin toplu indirme
 * SIRASINDA (her kaydırmada) kaybolmasına sebep oluyordu — işte
 * kullanıcının fark ettiği "hep en baştan indiriyor" sorununun kökeni
 * buydu. Şimdi sadece SAYFA YOLU (pathname) değişirse sıfırlıyoruz,
 * sorgu parametresi/sayfalama imleci değişikliklerini görmezden geliyoruz.
 */
let lastUrl = location.pathname;
const gpUrlWatch = setInterval(() => {
  // v1.49.1: Eklenti güncellendiyse/yeniden yüklendiyse bu kopyayı durdur.
  if (!isExtensionAlive()) {
    handleStaleInstance("self");
    return;
  }
  if (location.pathname !== lastUrl) {
    gpLog.debug("Sayfa değişti (SPA gezinme), kayıtlar sıfırlanıyor:", location.pathname);
    lastUrl = location.pathname;
    registeredDownloads.length = 0; // const olsa da içeriği temizlemek mümkün
  }
}, 500);
gpCleanups.push(() => clearInterval(gpUrlWatch));
})();
