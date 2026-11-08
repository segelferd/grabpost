// storage.js — chrome.storage.local üzerine ince bir katman.
// Amaç: Diğer dosyaların chrome.storage API'sinin callback/promise
// detaylarıyla uğraşmadan tek satırda ayar okuyup yazabilmesi.

export const DEFAULT_SETTINGS = {
  folderDestination: "Reddit Downloads",
  filenamePattern: "{subreddit}_{timestamp}_{filename}",
  useGalleryFolders: false,
  markDownloaded: true,
  mediaTypeFilter: "all", // "all" | "images" | "videos"
  scrollDirection: "down", // "down" | "up" (toplu indirmede kaydırma yönü)
  enableDateFilter: false,
  dateFrom: "", // "" = filtre yok, aksi halde "YYYY-MM-DD"
  dateTo: "",
  embedTitleOnImages: false,
  embedTitleOnVideos: false,
  skipDuplicateMedia: false, // aynı medya (baytları aynı) daha önce indirildiyse atla — isteğe bağlı, her dosya için ek ağ isteği gerektirir
  showDownloadedMarkers: true,
  markAsVisited: false,
  forceRedownload: false, // v1.49.4: toplu indirmede (sayfa ve hızlı mod) daha önce indirilenleri de tekrar indir
  language: "", // "" = otomatik algıla (tarayıcı diline göre)
  theme: "", // "" = sistem temasını takip et, "light" | "dark" = manuel zorlama
  checkIntervalHours: 4, // Takip listesi kontrol sıklığı (saat): 0.5 | 1 | 2 | 4 | 8 | 12 | 24
  favoriteIntervalMinutes: 15, // v1.50.0: favori kaynakların kontrol sıklığı (dk): 5 | 10 | 15 | 30 | 60
  autoBackup: true, // v1.48.2: günlük ve her 50 indirmede bir İndirilenler/GrabPost-Yedek klasörüne yedek dosyası
  downloadThroughExtension: true, // v1.47.3: IDM vb. indirme yöneticileriyle çakışmamak için dosyayı eklenti içinde çekip yerel adresle indir
  debugLogs: false, // v1.44.5: ayrıntılı konsol günlüğü (sorun giderme için)
};

/**
 * v1.44.4 YAZMA ÇAKIŞMASI DÜZELTMESİ: Buradaki fonksiyonların çoğu
 * "oku, değiştir, geri yaz" yapıyor. Arka plan (ör. alarmla Takip
 * kontrolü) ve yan panel (ör. elle indirme) AYNI ANDA yazarsa, sonra yazan
 * öncekinin değişikliğini siliyordu (ör. yeni bulunan bekleyen medya
 * kayboluyordu). Artık tüm bu yazmalar tarayıcının Web Locks API'si ile
 * TEK SIRAYA giriyor. Kilit, eklentinin tüm sayfaları (service worker +
 * yan panel) arasında ortak çalışır. Kilit yalnızca dışa açık giriş
 * fonksiyonlarında alınıyor; iç yardımcılar kilitsiz (iç içe kilit
 * kilitlenmeye yol açardı).
 */
const STORAGE_LOCK = "grabpost-storage-write";
export function withStorageLock(fn) {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(STORAGE_LOCK, fn);
  }
  return fn();
}

/** Tüm ayarları getirir, eksik olanları varsayılanla doldurur. */
export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

/** Verilen alanları mevcut ayarların üzerine yazar (kısmi güncelleme). */
export function updateSettings(partial) {
  return withStorageLock(async () => {
    const current = await getSettings();
    const next = { ...current, ...partial };
    await chrome.storage.local.set({ settings: next });
    await mirrorSettingsToSync(next);
    return next;
  });
}

/**
 * v1.48.0 HESABA YEDEK: Ayarlar, Chrome'un kendi senkronizasyon deposuna da
 * (Google hesabı) yazılıyor. Eklenti kaldırılınca yerel depo silinir ama
 * senkron depo hesapta kalır; yeniden kurulumda ayarlar otomatik geri gelir.
 * Takip listesi (kaynaklar, 🔍 kontrol / ⚡ otomatik indir anahtarları ve
 * filtreler) zaten v1.39'dan beri senkron depoda tutuluyor.
 * Not: Chrome'da senkronizasyon kapalıysa bu depo sadece bu cihazda kalır.
 */
export async function mirrorSettingsToSync(settings) {
  try {
    await chrome.storage.sync.set({ settingsSync: { ...settings, savedAt: Date.now() } });
  } catch (error) {
    console.warn("[GrabPost] Ayarlar hesaba yedeklenemedi:", error?.message || error);
  }
}

/**
 * Yerelde hiç ayar yoksa (yeni kurulum / yeniden kurulum) hesaptaki
 * yedekten geri yükler. Dönüş: geri yüklendiyse true.
 */
export function restoreSettingsFromSyncIfFresh() {
  return withStorageLock(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings) return false;
    let synced = null;
    try {
      ({ settingsSync: synced } = await chrome.storage.sync.get("settingsSync"));
    } catch {
      return false;
    }
    if (!synced) return false;
    const { savedAt, ...restored } = synced;
    await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...restored } });
    return true;
  });
}

/**
 * v1.44.4 PERFORMANS: Parmak izi listeleri (her biri 20.000 kayda kadar)
 * önceden HER kontrolde depodan baştan okunuyordu. Artık bu bağlamın
 * belleğinde tutuluyor; başka bir bağlam değiştirirse onChanged ile
 * geçersiz kılınıyor.
 */
const memoryCache = { downloadedMediaHashes: null, downloadedPerceptualHashes: null };
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(memoryCache)) {
      if (changes[key]) memoryCache[key] = null;
    }
  });
}
async function getCachedList(key) {
  if (!memoryCache[key]) {
    const stored = await chrome.storage.local.get(key);
    memoryCache[key] = stored[key] || [];
  }
  return memoryCache[key];
}

/** Bu içerik parmak izi (hash) daha önce indirilmiş mi? */
export async function isMediaHashSeen(hash) {
  return (await getCachedList("downloadedMediaHashes")).includes(hash);
}

/** Yeni bir medya parmak izini kaydeder. En fazla son 20.000 kayıt saklanır. */
export function markMediaHashSeen(hash) {
  return withStorageLock(async () => {
    const { downloadedMediaHashes = [] } = await chrome.storage.local.get("downloadedMediaHashes");
    if (downloadedMediaHashes.includes(hash)) return;
    downloadedMediaHashes.push(hash);
    const trimmed = downloadedMediaHashes.length > 20000 ? downloadedMediaHashes.slice(-20000) : downloadedMediaHashes;
    memoryCache.downloadedMediaHashes = trimmed;
    await chrome.storage.local.set({ downloadedMediaHashes: trimmed });
  });
}

/**
 * "Algısal parmak izi" (perceptual hash / dHash): görselin küçük, bulanık
 * bir örneğinden üretilir. İki hash arasındaki fark (Hamming mesafesi)
 * küçükse, muhtemelen aynı (ya da çok benzer) görsel demektir. SHA-256'dan
 * farklı olarak küçük sıkıştırma farklarına dayanıklı.
 */
const PERCEPTUAL_HASH_MATCH_THRESHOLD = 6; // 64 bitlik hash'te en fazla 6 bit fark

const NIBBLE_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
function hammingDistanceHex(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    dist += NIBBLE_BITS[parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16)];
  }
  return dist;
}

/** Bu algısal parmak izine (ya da ona çok yakın birine) daha önce rastlandı mı? */
export async function findSimilarPerceptualHash(hash) {
  const list = await getCachedList("downloadedPerceptualHashes");
  return list.find((h) => hammingDistanceHex(h, hash) <= PERCEPTUAL_HASH_MATCH_THRESHOLD) || null;
}

export function markPerceptualHashSeen(hash) {
  return withStorageLock(async () => {
    const { downloadedPerceptualHashes = [] } = await chrome.storage.local.get("downloadedPerceptualHashes");
    if (downloadedPerceptualHashes.includes(hash)) return;
    downloadedPerceptualHashes.push(hash);
    const trimmed =
      downloadedPerceptualHashes.length > 20000 ? downloadedPerceptualHashes.slice(-20000) : downloadedPerceptualHashes;
    memoryCache.downloadedPerceptualHashes = trimmed;
    await chrome.storage.local.set({ downloadedPerceptualHashes: trimmed });
  });
}

/**
 * Aynı gönderi, görüntülendiği bağlama göre farklı permalink formatıyla
 * gelebiliyor ("/user/isim/comments/ID/..." ya da "/r/sub/comments/ID/...").
 * Karşılaştırma, her iki formatta da ortak olan gönderi ID'si üzerinden
 * yapılıyor. "t3_abc" gibi fullname'ler de aynı ID'ye indirgeniyor.
 */
export function normalizePostKey(key) {
  if (!key) return key;
  const match = String(key).match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
  if (match) return match[1].toLowerCase();
  const fullname = String(key).match(/^t3_([a-z0-9]+)$/i);
  return fullname ? fullname[1].toLowerCase() : key;
}

/**
 * v1.44.4 İNDİRİLMİŞ GÖNDERİ BELLEĞİ YENİ YAPI: Önceden tüm kayıtlar tek
 * bir "downloadedPosts" dizisindeydi (20.000 kayda kadar, ~2 MB). Her
 * "indirildi mi?" kontrolü bu dizinin TAMAMINI okuyup tarıyordu; her
 * indirmede de dizinin tamamı yeniden yazılıyor ve açık her Reddit
 * sekmesine (eski+yeni değer olarak) ~4 MB'lık değişiklik bildirimi
 * gidiyordu. Artık her gönderi kendi küçük anahtarında: "dp:<gönderiID>".
 * Kontrol tek anahtar okuması, yazma tek anahtar yazması. Üst sınır
 * 100.000 kayda çıkarıldı (unlimitedStorage izniyle rahat sığıyor).
 * Eski dizi ilk açılışta otomatik taşınıyor (migrateDownloadedPostsIfNeeded).
 */
export const DOWNLOADED_KEY_PREFIX = "dp:";
const DOWNLOADED_MAX = 100000;

function downloadedStorageKey(postKey) {
  return DOWNLOADED_KEY_PREFIX + normalizePostKey(postKey);
}

async function getAllDownloadedRecords() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(DOWNLOADED_KEY_PREFIX))
    .map(([k, v]) => ({ storageKey: k, ...v }));
}

/** Eski "downloadedPosts" dizisini yeni anahtar başına kayıt yapısına bir kereliğine taşır. */
export function migrateDownloadedPostsIfNeeded() {
  return withStorageLock(async () => {
    const { downloadedPosts } = await chrome.storage.local.get("downloadedPosts");
    if (!Array.isArray(downloadedPosts)) return;
    const batch = {};
    for (const e of downloadedPosts) {
      const rec = typeof e === "string" ? { key: e, subreddit: "unknown", author: "unknown", timestamp: null } : e;
      if (!rec?.key) continue;
      batch[downloadedStorageKey(rec.key)] = {
        key: rec.key,
        subreddit: rec.subreddit || "unknown",
        author: rec.author || "unknown",
        timestamp: rec.timestamp ?? null,
      };
    }
    batch.downloadedCount = Object.keys(batch).length;
    await chrome.storage.local.set(batch);
    await chrome.storage.local.remove("downloadedPosts");
    console.log(`[GrabPost] ${Object.keys(batch).length} indirilmiş gönderi kaydı yeni yapıya taşındı.`);
  });
}

/** Bir gönderinin daha önce indirilip indirilmediğini kontrol eder (tek anahtar okuması). */
export async function isPostDownloaded(postId) {
  if (!postId) return false;
  const k = downloadedStorageKey(postId);
  const stored = await chrome.storage.local.get(k);
  return !!stored[k];
}

/**
 * Bir gönderiyi "indirildi" olarak işaretler VE geçmişe (downloadHistory)
 * ekler. Geçmiş kaydında artık gönderinin adresi (permalink) ve Chrome
 * indirme kimlikleri de tutuluyor (Geçmiş sekmesinden gönderiyi açmak ve
 * dosyayı klasörde göstermek için).
 */
export function markPostDownloaded(dedupeKey, entry = {}) {
  return withStorageLock(async () => {
    const k = downloadedStorageKey(dedupeKey);
    const { downloadHistory = [], downloadedCount = 0 } = await chrome.storage.local.get(["downloadHistory", "downloadedCount"]);
    const existing = await chrome.storage.local.get(k);
    const toSet = {};
    if (!existing[k]) {
      toSet[k] = {
        key: dedupeKey,
        subreddit: entry.subreddit || "unknown",
        author: entry.author || "unknown",
        timestamp: Date.now(),
      };
      toSet.downloadedCount = downloadedCount + 1;
    }
    downloadHistory.unshift({
      key: dedupeKey,
      subreddit: entry.subreddit || "unknown",
      title: entry.title || "",
      author: entry.author || "unknown",
      count: entry.count || 1,
      permalink: typeof dedupeKey === "string" && dedupeKey.includes("/comments/") ? dedupeKey : entry.permalink || null,
      downloadIds: entry.downloadIds || [],
      timestamp: Date.now(),
    });
    toSet.downloadHistory = downloadHistory.slice(0, 500); // en yeni 500 kayıt
    await chrome.storage.local.set(toSet);
    if ((toSet.downloadedCount || 0) > DOWNLOADED_MAX) await pruneDownloadedRecordsUnlocked();
  });
}

/** Üst sınır aşılınca en eski %10'u siler (nadiren çalışır). */
async function pruneDownloadedRecordsUnlocked() {
  const records = await getAllDownloadedRecords();
  if (records.length <= DOWNLOADED_MAX) {
    await chrome.storage.local.set({ downloadedCount: records.length });
    return;
  }
  records.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const removeCount = records.length - Math.floor(DOWNLOADED_MAX * 0.9);
  await chrome.storage.local.remove(records.slice(0, removeCount).map((r) => r.storageKey));
  await chrome.storage.local.set({ downloadedCount: records.length - removeCount });
}

/** İndirme geçmişinin tamamını getirir (en yeni en üstte). */
export async function getDownloadHistory() {
  const { downloadHistory = [] } = await chrome.storage.local.get("downloadHistory");
  return downloadHistory;
}

/** Geçmişten tek bir kaydı siler (index'e göre). */
export function removeFromDownloadHistory(index) {
  return withStorageLock(async () => {
    const { downloadHistory = [] } = await chrome.storage.local.get("downloadHistory");
    downloadHistory.splice(index, 1);
    await chrome.storage.local.set({ downloadHistory });
  });
}

/**
 * Sadece görünür GEÇMİŞ listesini temizler. İndirilmiş gönderi belleğine
 * DOKUNMAZ (yeşil "✓ İndirildi" rozeti ve "zaten indirildi, atla" mantığı
 * etkilenmez).
 */
export function clearDownloadHistory() {
  return withStorageLock(() => chrome.storage.local.set({ downloadHistory: [] }));
}

/**
 * SADECE indirilmiş gönderi belleğini temizler. Görünür geçmiş listesine
 * DOKUNMAZ. Önceden indirilmiş gönderilerin yeşil rozetini kaldırır ve
 * toplu indirmede onları tekrar "indirilecekler" listesine sokar.
 */
export function clearProcessedPostsMemory() {
  return withStorageLock(async () => {
    const records = await getAllDownloadedRecords();
    await chrome.storage.local.remove(records.map((r) => r.storageKey));
    await chrome.storage.local.set({ downloadedCount: 0 });
  });
}

/** İndirilmiş gönderi belleğini subreddit ve kullanıcı bazında gruplanmış (sayılarıyla) döner. */
export async function getProcessedPostsSummary() {
  const records = await getAllDownloadedRecords();
  const bySubreddit = new Map();
  const byUser = new Map();
  for (const entry of records) {
    const sub = entry.subreddit || "unknown";
    const user = entry.author || "unknown";
    bySubreddit.set(sub, (bySubreddit.get(sub) || 0) + 1);
    byUser.set(user, (byUser.get(user) || 0) + 1);
  }
  const toSortedArray = (map) =>
    Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  return { total: records.length, subreddits: toSortedArray(bySubreddit), users: toSortedArray(byUser) };
}

async function clearProcessedWhere(predicate) {
  return withStorageLock(async () => {
    const records = await getAllDownloadedRecords();
    const toRemove = records.filter(predicate).map((r) => r.storageKey);
    await chrome.storage.local.remove(toRemove);
    await chrome.storage.local.set({ downloadedCount: records.length - toRemove.length });
    return toRemove.length; // kaç kayıt silindi
  });
}

/** Belirli bir subreddit'e ait indirilmiş gönderi kayıtlarını (SADECE onları) temizler. */
export function clearProcessedPostsBySubreddit(subreddit) {
  return clearProcessedWhere((e) => (e.subreddit || "unknown") === subreddit);
}

/** Belirli bir kullanıcıya ait indirilmiş gönderi kayıtlarını (SADECE onları) temizler. */
export function clearProcessedPostsByUser(author) {
  return clearProcessedWhere((e) => (e.author || "unknown") === author);
}

/**
 * TAKİP LİSTESİ (abonelik) yönetimi. Her abonelik dışa şu şekilde görünür:
 * { id, type: "subreddit"|"user", name, enabled, lastSeenId, lastCheckedAt, pendingPosts }
 *
 * ÖNEMLİ YENİ ÖZELLİK: Bu bilgi artık İKİ AYRI yerde saklanıyor:
 * 1) KİMLİK (id, type, name, enabled) → chrome.storage.SYNC — kullanıcı
 *    Chrome'a Google hesabıyla giriş yapmışsa, bu otomatik olarak TÜM
 *    cihazlarına/tarayıcılarına senkronize oluyor. Tarayıcıyı kaldırıp
 *    yeniden yüklediğinizde ya da başka bir bilgisayarda GrabPost'u
 *    kurduğunuzda, takip listeniz kendiliğinden geri geliyor — hiçbir
 *    sunucu/giriş ekranı kurmamıza gerek kalmadan (Chrome'un kendi
 *    senkronizasyon altyapısını kullanıyoruz).
 * 2) DURUM (lastSeenId, lastCheckedAt, pendingPosts) → chrome.storage.LOCAL
 *    — cihaza özel kalıyor. Bunun sebebi: chrome.storage.sync çok küçük
 *    bir kotaya sahip (toplam 100KB, öğe başı 8KB) — bekleyen medya
 *    listesi gibi büyüyebilen veriler buraya asla sığmaz. Ayrıca bu
 *    veriler zaten cihaza özel olması daha mantıklı (bir cihazda
 *    indirdiğiniz bir şeyin "bekleyen" durumu başka bir cihazda anlamsız).
 */

/**
 * ÖNEMLİ TEK SEFERLİK GEÇİŞ: Önceki sürümlerde tüm abonelik verisi
 * (kimlik + durum bir arada) chrome.storage.local'daki tek bir
 * "subscriptions" anahtarında saklanıyordu. Yeni bölünmüş modele
 * (kimlik→sync, durum→local) geçerken, bu ESKİ veriyi hiç kaybetmeden
 * yeni formata taşımamız gerekiyor — yoksa güncelleme yapan herkes
 * takip listesini bir anda kaybederdi.
 */
export function migrateSubscriptionsToSyncIfNeeded() {
  return withStorageLock(async () => {
    const { subscriptions: legacy } = await chrome.storage.local.get("subscriptions");
    if (!legacy || legacy.length === 0) return; // eski veri yok, geçişe gerek yok

    const identity = minimalIdentity(legacy);
    const state = {};
    for (const sub of legacy) {
      state[sub.id] = {
        lastSeenId: sub.lastSeenId ?? null,
        lastCheckedAt: sub.lastCheckedAt ?? null,
        pendingPosts: sub.pendingPosts ?? [],
      };
    }

    await setSubscriptionsIdentity(identity);
    await chrome.storage.local.set({ subscriptionsState: state });
    await chrome.storage.local.remove("subscriptions"); // eski formatı temizle
    console.log(`[GrabPost] ${legacy.length} abonelik yeni (senkronize) formata taşındı.`);
  });
}

/**
 * v1.45.5 SENKRONİZE TAKİP LİSTESİ SAĞLAMLAŞTIRMASI
 * Önceki durum: tüm liste chrome.storage.sync'te TEK anahtardaydı. Chrome
 * sync'te anahtar başına 8 KB sınırı var (yaklaşık 90 kaynak). Sınır
 * aşılınca yazma başarısız olup yerel yedeğe yazılıyordu, AMA okuma her
 * zaman önce sync'e bakıp (eski ama boş olmayan) listeyi döndürüyordu.
 * Sonuç: 90+ kaynakta yeni eklenen/değiştirilen kaynaklar sessizce
 * "kayboluyordu".
 * Yeni durum:
 *   - Liste ~7 KB'lık parçalara bölünüp "subsChunk_0..N" anahtarlarına
 *     yazılıyor (sync toplam sınırı 100 KB, binlerce kaynağa yeter).
 *   - Her yazmada YEREL bir kopya da tutuluyor; sync yazması başarısız
 *     olursa bu işaretleniyor ve okuma yerel kopyayı esas alıyor.
 *   - Eski tek anahtar ("subscriptionsIdentity") okunabiliyor ve ilk
 *     yazmada parçalı yapıya taşınıyor.
 */
const SUB_IDENTITY_KEYS = ["id", "type", "name", "enabled", "autoDownload", "filterMedia", "filterNsfw", "filterKeywords", "favorite"];
// v1.50.0: Favori kaynaklar daha sık kontrol ediliyor; Reddit'e yük bindirmemek için en fazla 10.
export const MAX_FAVORITES = 10;
const SYNC_CHUNK_BYTES = 7000;

function minimalIdentity(list) {
  return list.map((s) => {
    const m = { id: s.id, type: s.type, name: s.name, enabled: s.enabled !== false, autoDownload: !!s.autoDownload };
    // Filtreler sadece varsayılandan farklıysa saklanır (sync alanı küçük).
    if (s.filterMedia && s.filterMedia !== "all") m.filterMedia = s.filterMedia;
    if (s.filterNsfw && s.filterNsfw !== "all") m.filterNsfw = s.filterNsfw;
    if (s.filterKeywords && String(s.filterKeywords).trim()) m.filterKeywords = String(s.filterKeywords).trim().slice(0, 200);
    if (s.favorite) m.favorite = true;
    return m;
  });
}

/** Favori sınırını uygular: listede ilk MAX_FAVORITES favori kalır, fazlası kaldırılır. */
function capFavorites(list) {
  let n = 0;
  return list.map((s) => {
    if (!s.favorite) return s;
    if (++n <= MAX_FAVORITES) return s;
    const { favorite, ...rest } = s;
    return rest;
  });
}

function chunkForSync(list) {
  const chunks = [];
  let current = [];
  let size = 2;
  for (const item of list) {
    const itemSize = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (current.length && size + itemSize > SYNC_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function readSyncIdentity() {
  const all = await chrome.storage.sync.get(null);
  if (typeof all.subsChunkCount === "number") {
    const list = [];
    for (let i = 0; i < all.subsChunkCount; i++) list.push(...(all[`subsChunk_${i}`] || []));
    return list;
  }
  return all.subscriptionsIdentity || [];
}

async function getSubscriptionsIdentity() {
  const local = await chrome.storage.local.get(["subscriptionsIdentityFallback", "subsSyncFailed"]);
  if (local.subsSyncFailed && Array.isArray(local.subscriptionsIdentityFallback)) return local.subscriptionsIdentityFallback;
  let synced = [];
  try {
    synced = await readSyncIdentity();
  } catch {
    /* sync okunamadıysa yerel kopyaya düş */
  }
  if (synced.length) return synced;
  return local.subscriptionsIdentityFallback || [];
}

async function setSubscriptionsIdentity(list) {
  const minimal = minimalIdentity(capFavorites(list));
  // Yerel kopya her zaman güncel.
  await chrome.storage.local.set({ subscriptionsIdentityFallback: minimal });
  try {
    const chunks = chunkForSync(minimal);
    const previous = await chrome.storage.sync.get(null);
    const toSet = { subsChunkCount: chunks.length };
    chunks.forEach((c, i) => (toSet[`subsChunk_${i}`] = c));
    await chrome.storage.sync.set(toSet);
    const stale = Object.keys(previous).filter((k) => (/^subsChunk_\d+$/.test(k) && Number(k.split("_")[1]) >= chunks.length) || k === "subscriptionsIdentity");
    if (stale.length) await chrome.storage.sync.remove(stale);
    await chrome.storage.local.set({ subsSyncFailed: false });
  } catch (error) {
    // Kota/ağ hatası: bu cihazda yerel kopya esas alınır, bir sonraki
    // başarılı yazmada sync yeniden güncellenir.
    console.warn("[GrabPost] Takip listesi senkronize edilemedi, yerel kopya kullanılıyor:", error?.message || error);
    await chrome.storage.local.set({ subsSyncFailed: true });
  }
}

async function getSubscriptionsState() {
  const { subscriptionsState = {} } = await chrome.storage.local.get("subscriptionsState");
  return subscriptionsState;
}

async function setSubscriptionState(id, partialState) {
  const state = await getSubscriptionsState();
  state[id] = { ...state[id], ...partialState };
  await chrome.storage.local.set({ subscriptionsState: state });
}

export async function getSubscriptions() {
  const identity = await getSubscriptionsIdentity(); // sync / yerel kopya seçimi burada yapılıyor
  const state = await getSubscriptionsState();
  return identity.map((item) => ({
    ...item,
    lastSeenId: state[item.id]?.lastSeenId ?? null,
    lastSeenCreatedUtc: state[item.id]?.lastSeenCreatedUtc ?? null,
    // v1.44.3 DÜZELTME: lastError kaydediliyordu ama burada DÖNDÜRÜLMÜYORDU;
    // bu yüzden panelde "yaş onayı gerekiyor" / HTTP hata uyarısı v1.39'dan
    // beri hiç görünmüyordu.
    lastError: state[item.id]?.lastError ?? null,
    lastCheckedAt: state[item.id]?.lastCheckedAt ?? null,
    pendingPosts: state[item.id]?.pendingPosts ?? [],
  }));
}

export function addSubscription(type, name) {
  return withStorageLock(async () => {
    // v1.47.2: "u/ad", "r/ad" ya da tam Reddit adresi yazıldıysa türü oradan al
    // (önceden "u/bob" yazıp listede r/ seçiliyse "r/bob" diye ekleniyordu).
    const parsed = parseFollowEntry(name);
    if (parsed?.type) type = parsed.type;
    const cleanName = parsed ? parsed.name : name.trim().replace(/^\/?(r|u)\//i, "");
    const id = `${type}:${cleanName.toLowerCase()}`;
    const identity = await getSubscriptionsIdentity();
    if (identity.some((s) => s.id === id)) return getSubscriptions(); // zaten takip ediliyor

    identity.push({ id, type, name: cleanName, enabled: true, autoDownload: false });
    await setSubscriptionsIdentity(identity);
    return getSubscriptions();
  });
}

export function removeSubscription(id) {
  return withStorageLock(async () => {
    const identity = await getSubscriptionsIdentity();
    const next = identity.filter((s) => s.id !== id);
    await setSubscriptionsIdentity(next);
    // Kalıcı takip durumunu da temizleyelim (artık gereksiz, yer kaplamasın).
    const state = await getSubscriptionsState();
    delete state[id];
    await chrome.storage.local.set({ subscriptionsState: state });
    return getSubscriptions();
  });
}

/**
 * ÖNEMLİ YENİ ÖZELLİK: Takip listesini sürükle-bırak ile yeniden
 * sıralama. "orderedIds", kullanıcının panelde bıraktığı YENİ sırayla
 * gönderi kimliklerinin listesi — biz de kimlik dizisini (subreddits
 * identity) buna göre yeniden diziyoruz. Sıra bilgisi de senkronize
 * depoda tutulduğu için (identity'nin kendisi zaten sync'te), yeniden
 * sıralama da diğer cihazlara senkronize oluyor.
 */
export function reorderSubscriptions(orderedIds) {
  return withStorageLock(async () => {
    const identity = await getSubscriptionsIdentity();
    const byId = new Map(identity.map((s) => [s.id, s]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    // Güvenlik: orderedIds içinde eksik kalan (ör. eşzamanlı bir değişiklik
    // yüzünden) varsa, onları da sona ekleyip hiçbir aboneliği kaybetmeyelim.
    const missing = identity.filter((s) => !orderedIds.includes(s.id));
    await setSubscriptionsIdentity([...reordered, ...missing]);
    return getSubscriptions();
  });
}

/**
 * v1.50.0: Bir kaynağı favoriye ekler/çıkarır. Sınır doluysa eklemez:
 * { ok:false, error:"FAVORITE_LIMIT" } döner.
 */
export function setSubscriptionFavorite(id, on) {
  return withStorageLock(async () => {
    const identity = await getSubscriptionsIdentity();
    if (on && !identity.find((s) => s.id === id)?.favorite && identity.filter((s) => s.favorite).length >= MAX_FAVORITES) {
      return { ok: false, error: "FAVORITE_LIMIT" };
    }
    await setSubscriptionsIdentity(identity.map((s) => (s.id === id ? { ...s, favorite: !!on } : s)));
    return { ok: true };
  });
}

export function updateSubscription(id, partial) {
  return withStorageLock(async () => {
    // "type/name/enabled" gibi KİMLİK alanları senkronize listeye,
    // "lastSeenId/lastCheckedAt/pendingPosts" gibi DURUM alanları yerel
    // depoya yazılır — çağıran taraf bunu bilmek zorunda değil, biz
    // otomatik ayırıyoruz.
    const IDENTITY_KEYS = SUB_IDENTITY_KEYS.filter((k) => k !== "id");
    const identityFields = {};
    const stateFields = {};
    for (const [key, value] of Object.entries(partial)) {
      if (IDENTITY_KEYS.includes(key)) identityFields[key] = value;
      else stateFields[key] = value;
    }

    if (Object.keys(identityFields).length > 0) {
      const identity = await getSubscriptionsIdentity();
      const next = identity.map((s) => (s.id === id ? { ...s, ...identityFields } : s));
      await setSubscriptionsIdentity(next);
    }
    if (Object.keys(stateFields).length > 0) {
      await setSubscriptionState(id, stateFields);
    }
    return getSubscriptions();
  });
}

/**
 * Bir aboneliğe yeni bulunan medyalı gönderileri BİRİKTİREREK ekler
 * (üzerine yazmaz — kullanıcı henüz indirmediyse, sonraki kontrolde bulunan
 * yeni gönderiler öncekilere EKLENİR). Aynı gönderi (postId) tekrar
 * eklenmez.
 */
export function addPendingPosts(id, newPosts) {
  return withStorageLock(async () => {
    const state = await getSubscriptionsState();
    const existing = state[id]?.pendingPosts || [];
    const existingIds = new Set(existing.map((p) => p.postId));
    const merged = [...existing, ...newPosts.filter((p) => !existingIds.has(p.postId))];
    await setSubscriptionState(id, { pendingPosts: merged });
    return getSubscriptions();
  });
}

/**
 * v1.43.4: Bekleyen listeden SADECE verilen gönderileri çıkarır. Önceden
 * indirme sonrası liste tamamen temizleniyordu; bu da (a) indirilemeyen
 * gönderilerin kaybolmasına, (b) bildirimden indirirken o bildirimde
 * olmayan daha eski bekleyenlerin de silinmesine sebep oluyordu.
 */
export function removePendingPosts(id, postIds) {
  return withStorageLock(async () => {
    const remove = new Set(postIds);
    const state = await getSubscriptionsState();
    const existing = state[id]?.pendingPosts || [];
    await setSubscriptionState(id, { pendingPosts: existing.filter((p) => !remove.has(p.postId)) });
    return getSubscriptions();
  });
}

/** Bir aboneliğin biriken "yeni medya" listesini temizler (indirildikten sonra). */
export async function clearPendingPosts(id) {
  return updateSubscription(id, { pendingPosts: [] });
}

/**
 * v1.45.2 BAŞARISIZ İNDİRMELER: Bir indirme başarısız olursa (ağ hatası,
 * dosya reddi, işleme hatası) kaydı burada tutulur; Geçmiş sekmesinden
 * tek tek ya da topluca tekrar denenebilir. En fazla 100 kayıt.
 */
const FAILED_MAX = 100;

export async function getFailedDownloads() {
  const { failedDownloads = [] } = await chrome.storage.local.get("failedDownloads");
  return failedDownloads;
}

export function addFailedDownload(record) {
  return withStorageLock(async () => {
    const { failedDownloads = [] } = await chrome.storage.local.get("failedDownloads");
    // Aynı dosya/gönderi zaten listedeyse yenisiyle değiştir (tekrarlı kayıt olmasın).
    const sameKey = (r) => (r.postId || r.media?.urls?.[0]) === (record.postId || record.media?.urls?.[0]);
    const next = [{ id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, timestamp: Date.now(), ...record }, ...failedDownloads.filter((r) => !sameKey(r))];
    await chrome.storage.local.set({ failedDownloads: next.slice(0, FAILED_MAX) });
  });
}

export function removeFailedDownload(id) {
  return withStorageLock(async () => {
    const { failedDownloads = [] } = await chrome.storage.local.get("failedDownloads");
    await chrome.storage.local.set({ failedDownloads: failedDownloads.filter((r) => r.id !== id) });
  });
}

export function clearFailedDownloads() {
  return withStorageLock(() => chrome.storage.local.set({ failedDownloads: [] }));
}

/**
 * v1.45.3: Chrome indirmesi yarıda kaldığında (ağ/sunucu hatası) o gönderi
 * yanlışlıkla "indirildi" sayılıyordu: yeşil rozet çıkıyor, toplu indirme
 * ve Takip onu atlıyor, Geçmiş'te başarılı gibi duruyordu. Bu fonksiyon
 * o kaydı geri alır: indirme kimliğini içeren geçmiş kaydı silinir ve
 * (tek dosyalı gönderilerde) gönderi yeniden indirilebilir hale gelir.
 */
export function undoDownloadRecord(postKey, downloadId) {
  return withStorageLock(async () => {
    const { downloadHistory = [], downloadedCount = 0 } = await chrome.storage.local.get(["downloadHistory", "downloadedCount"]);
    const nextHistory = downloadHistory.filter((h) => !(h.downloadIds || []).includes(downloadId));
    const toSet = {};
    if (nextHistory.length !== downloadHistory.length) toSet.downloadHistory = nextHistory;
    if (postKey) {
      const k = downloadedStorageKey(postKey);
      const existing = await chrome.storage.local.get(k);
      if (existing[k]) {
        await chrome.storage.local.remove(k);
        toSet.downloadedCount = Math.max(0, downloadedCount - 1);
      }
    }
    if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  });
}

/**
 * v1.45.4 YEDEKLEME: Ayarlar, takip listesi, indirilmiş gönderi belleği,
 * geçmiş, parmak izleri ve başarısız indirmeler tek bir JSON dosyasına
 * aktarılır. Chrome senkronizasyonu sadece takip listesinin adlarını
 * taşıyordu; bilgisayar değişince "zaten indirildi" belleği kayboluyordu.
 */
const BACKUP_FORMAT = "grabpost-backup";
const BACKUP_VERSION = 1;

export async function exportBackup() {
  const all = await chrome.storage.local.get(null);
  const identity = await getSubscriptionsIdentity();
  const downloaded = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(DOWNLOADED_KEY_PREFIX)) downloaded[k] = v;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    settings: all.settings || {},
    subscriptionsIdentity: identity.length ? identity : all.subscriptionsIdentityFallback || [],
    subscriptionsState: all.subscriptionsState || {},
    downloaded,
    downloadHistory: all.downloadHistory || [],
    downloadedMediaHashes: all.downloadedMediaHashes || [],
    downloadedPerceptualHashes: all.downloadedPerceptualHashes || [],
    failedDownloads: all.failedDownloads || [],
  };
}

/**
 * Yedeği mevcut verilerle BİRLEŞTİREREK içe aktarır (hiçbir şey silinmez):
 * ayarlar yedektekiyle güncellenir, takip listesine eksik kaynaklar eklenir,
 * indirilmiş gönderi belleği/geçmiş/parmak izleri birleştirilir.
 * Dönüş: { subscriptionsAdded, downloadedAdded, historyAdded }
 */
export function importBackup(data) {
  return withStorageLock(async () => {
    if (!data || data.format !== BACKUP_FORMAT) throw new Error("INVALID_BACKUP");
    const all = await chrome.storage.local.get(null);
    const toSet = {};

    if (data.settings && typeof data.settings === "object") {
      toSet.settings = { ...(all.settings || {}), ...data.settings };
      await mirrorSettingsToSync(toSet.settings);
    }

    // Takip listesi: kimliği olmayanları ekle; durumları sadece yeni eklenenler için al.
    const identity = await getSubscriptionsIdentity();
    const known = new Set(identity.map((x) => x.id));
    const added = (data.subscriptionsIdentity || []).filter((x) => x?.id && !known.has(x.id));
    if (added.length) {
      await setSubscriptionsIdentity([...identity, ...added]);
      const state = all.subscriptionsState || {};
      for (const sub of added) if (data.subscriptionsState?.[sub.id]) state[sub.id] = data.subscriptionsState[sub.id];
      toSet.subscriptionsState = state;
    }

    // İndirilmiş gönderi belleği
    let downloadedAdded = 0;
    for (const [k, v] of Object.entries(data.downloaded || {})) {
      if (!k.startsWith(DOWNLOADED_KEY_PREFIX) || all[k]) continue;
      toSet[k] = v;
      downloadedAdded++;
    }
    if (downloadedAdded) toSet.downloadedCount = (all.downloadedCount || 0) + downloadedAdded;

    // Geçmiş: aynı (key + zaman) kaydı tekrar ekleme; en yeni 500.
    const history = all.downloadHistory || [];
    const seen = new Set(history.map((h) => `${h.key}|${h.timestamp}`));
    const newHistory = (data.downloadHistory || []).filter((h) => !seen.has(`${h.key}|${h.timestamp}`));
    if (newHistory.length) {
      toSet.downloadHistory = [...history, ...newHistory].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 500);
    }

    const union = (a = [], b = []) => Array.from(new Set([...a, ...b])).slice(-20000);
    if (data.downloadedMediaHashes?.length) toSet.downloadedMediaHashes = union(all.downloadedMediaHashes, data.downloadedMediaHashes);
    if (data.downloadedPerceptualHashes?.length) toSet.downloadedPerceptualHashes = union(all.downloadedPerceptualHashes, data.downloadedPerceptualHashes);

    await chrome.storage.local.set(toSet);
    return { subscriptionsAdded: added.length, downloadedAdded, historyAdded: newHistory.length };
  });
}

/**
 * v1.47.2: Kullanıcının yazdığı/yapıştırdığı metinden takip kaynağı çıkarır.
 * Kabul edilenler: "r/pics", "/r/pics", "u/bob", "user/bob", tam Reddit
 * adresleri (www/old/new/np.reddit.com, ör. adres çubuğundan kopyalanan
 * https://www.reddit.com/r/pics/comments/... ya da .../user/bob/submitted/).
 * Ön eki olmayan düz bir ad için type null döner (arayüzdeki seçim kullanılır).
 * Geçersizse null.
 */
export function parseFollowEntry(raw) {
  let text = String(raw || "").trim().replace(/^["'<(\[]+|["'>)\],;]+$/g, "");
  if (!text) return null;
  const urlMatch = text.match(/reddit\.com(\/[^\s?#]*)/i);
  if (urlMatch) text = urlMatch[1];
  let m = text.match(/^\/?r\/([A-Za-z0-9_]{2,21})(?:[/?#].*)?$/i);
  if (m) return { type: "subreddit", name: m[1] };
  m = text.match(/^\/?(?:u|user)\/([A-Za-z0-9_-]{3,20})(?:[/?#].*)?$/i);
  if (m) return { type: "user", name: m[1] };
  m = text.match(/^@?([A-Za-z0-9_-]{2,21})$/);
  if (m) return { type: null, name: m[1] };
  return null;
}

/** v1.47.2: Takip listesini (filtreleriyle birlikte) taşınabilir JSON olarak döner. */
export async function exportFollowList() {
  const identity = minimalIdentity(await getSubscriptionsIdentity());
  return {
    format: "grabpost-follow-list",
    version: 1,
    appVersion: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    items: identity.map(({ id, ...rest }) => rest),
  };
}

/**
 * v1.47.2: Takip listesini içe aktarır (BİRLEŞTİREREK; mevcut kaynaklar
 * silinmez, zaten takip edilenler atlanır, yeni olanlar listenin sonuna
 * eklenir). Kabul edilen girdiler:
 *   - GrabPost takip listesi JSON'u (format: grabpost-follow-list)
 *   - GrabPost tam yedek JSON'u (subscriptionsIdentity alanı)
 *   - Düz metin: her satırda (ya da virgülle ayrılmış) r/ad, u/ad veya Reddit adresi
 * Ön eksiz düz adlar defaultType ile eklenir.
 */
export function importFollowList(input, defaultType = "subreddit") {
  return withStorageLock(async () => {
    let candidates = [];
    let parsedJson = null;
    if (typeof input === "string") {
      try {
        parsedJson = JSON.parse(input);
      } catch {
        parsedJson = null;
      }
    } else {
      parsedJson = input;
    }
    let invalid = 0;
    if (parsedJson && typeof parsedJson === "object") {
      const list = parsedJson.format === "grabpost-follow-list" ? parsedJson.items : parsedJson.subscriptionsIdentity;
      if (!Array.isArray(list)) throw new Error("INVALID_FOLLOW_LIST");
      for (const it of list) {
        const parsed = it?.type && it?.name ? { type: it.type === "user" ? "user" : "subreddit", name: String(it.name) } : null;
        if (parsed && /^[A-Za-z0-9_-]{2,21}$/.test(parsed.name)) candidates.push({ ...it, ...parsed });
        else invalid++;
      }
    } else {
      for (const token of String(input || "").split(/[\r\n,;\t]+/)) {
        if (!token.trim()) continue;
        const parsed = parseFollowEntry(token);
        if (parsed) candidates.push({ type: parsed.type || defaultType, name: parsed.name });
        else invalid++;
      }
    }
    const identity = await getSubscriptionsIdentity();
    const known = new Set(identity.map((x) => x.id));
    const additions = [];
    let skipped = 0;
    for (const c of candidates) {
      const id = `${c.type}:${c.name.toLowerCase()}`;
      if (known.has(id)) {
        skipped++;
        continue;
      }
      known.add(id);
      additions.push({ ...c, id, enabled: c.enabled !== false, autoDownload: !!c.autoDownload, favorite: !!c.favorite });
    }
    if (additions.length) await setSubscriptionsIdentity([...identity, ...additions]);
    return { added: additions.length, skipped, invalid };
  });
}

/**
 * v1.48.1: Kurtarılan kayıtları mevcut verilerle BİRLEŞTİRİR (hiçbir şey
 * silinmez, var olan kayıtların üzerine yazılmaz).
 * @param records [{ key, subreddit, author, timestamp }]  -> "indirildi" belleği
 * @param history [{ key, subreddit, title, author, count, permalink, downloadIds, timestamp }]
 */
export function mergeRecoveredRecords(records, history) {
  return withStorageLock(async () => {
    const all = await chrome.storage.local.get(null);
    const toSet = {};
    let downloadedAdded = 0;
    for (const r of records) {
      const k = downloadedStorageKey(r.key);
      if (all[k] || toSet[k]) continue;
      toSet[k] = { key: r.key, subreddit: r.subreddit || "unknown", author: r.author || "unknown", timestamp: r.timestamp || null };
      downloadedAdded++;
    }
    if (downloadedAdded) toSet.downloadedCount = (all.downloadedCount || 0) + downloadedAdded;
    const current = all.downloadHistory || [];
    const seenIds = new Set(current.flatMap((h) => h.downloadIds || []));
    const fresh = history.filter((h) => !(h.downloadIds || []).some((id) => seenIds.has(id)));
    if (fresh.length) {
      toSet.downloadHistory = [...current, ...fresh].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 500);
    }
    if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
    return { downloadedAdded, historyAdded: fresh.length };
  });
}
