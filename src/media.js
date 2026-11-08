// media.js — Reddit gönderi verisinden (JSON) indirilebilir medya çıkaran
// ORTAK modül. v1.44.5'e kadar bu mantığın iki ayrı kopyası vardı
// (background.js ve content.js). Kopyalardan biri güncellenip diğeri
// unutulunca Takip listesinden inen videolar sessiz kalmıştı. Artık tek
// kaynak burası:
//   - background.js statik "import" ile,
//   - content.js ise (içerik betikleri statik import desteklemediği için)
//     locales.js'teki gibi dinamik import() ile kullanıyor.
// Bu dosya HİÇBİR Chrome API'si ya da DOM kullanmaz; ağ isteği gereken
// yerlerde (Redgifs) çağıran taraf kendi fetch yöntemini parametre olarak verir.

/** Galeri öğesinin en iyi adresi. Hareketli öğelerde (GIF/MP4) s.u yok, s.gif / s.mp4 var. */
export function galleryItemUrl(meta) {
  if (!meta || meta.status === "failed") return null;
  return meta.s?.u || meta.s?.gif || meta.s?.mp4 || null;
}

const VREDDIT_BASE_RE = /^(https:\/\/v\.redd\.it\/[^/?#]+\/)/;

/**
 * Reddit videosunun ayrı ses dosyası için aday adresler. Ad yıllar içinde
 * değişti: yeni videolar DASH_AUDIO_128.mp4 / DASH_AUDIO_64.mp4, eskiler
 * DASH_audio.mp4 / audio.mp4. Offscreen önce DASH manifestine bakar, sonra
 * bunları sırayla dener.
 */
export function redditAudioCandidates(videoUrl) {
  const m = String(videoUrl || "").match(VREDDIT_BASE_RE);
  if (!m) return [];
  return ["DASH_AUDIO_128.mp4", "DASH_AUDIO_64.mp4", "DASH_audio.mp4", "audio.mp4", "audio"].map((name) => m[1] + name);
}

/** reddit_video nesnesinden medya nesnesi üretir. has_audio=false ise ses hiç aranmaz. */
export function redditVideoMedia(redditVideo) {
  const url = redditVideo.fallback_url;
  if (!redditVideo.has_audio) return { type: "video", urls: [url] };
  const base = String(url).match(VREDDIT_BASE_RE)?.[1];
  return {
    type: "video",
    urls: [url],
    audioCandidates: redditAudioCandidates(url),
    dashUrl: redditVideo.dash_url || (base ? `${base}DASHPlaylist.mpd` : null),
    // v1.49.2: HLS ana listesi; DASH listesi okunamazsa gerçek ses kanalı buradan bulunur.
    hlsUrl: redditVideo.hls_url || (base ? `${base}HLSPlaylist.m3u8` : null),
  };
}

/** Gönderi JSON'unun indirilebilir medya içerme ihtimali var mı (hızlı ön kontrol)? */
export function postHasMedia(postData) {
  if (!postData) return false;
  return !!(
    postData.post_hint === "image" ||
    postData.domain === "i.redd.it" ||
    postData.is_gallery ||
    postData.is_video ||
    postData.domain === "redgifs.com" ||
    (postData.media ?? postData.secure_media)?.oembed?.provider_name === "RedGIFs" ||
    isImgurUrl(postData.url) ||
    postData.crosspost_parent_list?.[0]
  );
}

// ---------------------------------------------------------------------------
// Imgur (v1.45.6)
// Reddit'te hâlâ yaygın. Doğrudan dosya bağlantıları (i.imgur.com/ID.jpg,
// .gifv) API'siz çözülüyor; albüm/galeri/tekli sayfa bağlantıları Imgur'un
// kendi web sitesinin kullandığı herkese açık API ile çözülüyor. Bu API
// CORS'a açık olduğu için eklentiye yeni bir site izni EKLENMEDİ (yeni izin,
// güncellemede Chrome'un eklentiyi devre dışı bırakıp onay istemesine yol
// açardı). API başarısız olursa tekli bağlantılar için doğrudan dosya
// adresi deneniyor; albüm çözülemezse null dönüyor (eski davranış).
// ---------------------------------------------------------------------------
const IMGUR_CLIENT_ID = "546c25a59c58ad7"; // imgur.com web arayüzünün herkese açık istemci kimliği

export function isImgurUrl(url) {
  return /^https?:\/\/(?:i\.|m\.|www\.)?imgur\.com\//i.test(String(url || ""));
}

function imgurMediaToResult(items) {
  const urls = (items || []).map((m) => m.url).filter(Boolean);
  if (!urls.length) return null;
  if (urls.length > 1) return { type: "gallery", urls };
  return { type: /\.mp4(\?|$)/i.test(urls[0]) ? "video" : "image", urls };
}

/**
 * @param url Imgur bağlantısı
 * @param fetchJson async (url) => json | null
 */
export async function resolveImgurMedia(url, fetchJson) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  // 1) Doğrudan dosya: i.imgur.com/ID.ext
  const direct = path.match(/^\/([A-Za-z0-9]+)\.(jpe?g|png|gif|gifv|mp4|webp)$/i);
  if (direct) {
    const [, id, ext] = direct;
    if (/^(gifv|mp4)$/i.test(ext)) return { type: "video", urls: [`https://i.imgur.com/${id}.mp4`] };
    return { type: "image", urls: [`https://i.imgur.com/${id}.${ext.toLowerCase()}`] };
  }
  // 2) Albüm / galeri: /a/ID, /gallery/ID, /gallery/baslik-kelimeleri-ID
  const album = path.match(/^\/(a|gallery|t\/[^/]+)\/([^/]+)$/i);
  if (album) {
    const id = album[2].split("-").pop();
    // /a/ -> albüm; /gallery/ -> önce gönderi, olmazsa albüm olarak dene
    const endpoints = album[1].toLowerCase() === "a" ? ["albums"] : ["posts", "albums"];
    for (const endpoint of endpoints) {
      const json = fetchJson ? await fetchJson(`https://api.imgur.com/post/v1/${endpoint}/${id}?client_id=${IMGUR_CLIENT_ID}&include=media`) : null;
      const result = imgurMediaToResult(json?.media);
      if (result) return result;
    }
    return null;
  }
  // 3) Tekli sayfa: imgur.com/ID
  const single = path.match(/^\/([A-Za-z0-9]{5,10})$/);
  if (single) {
    const id = single[1];
    const json = fetchJson ? await fetchJson(`https://api.imgur.com/post/v1/media/${id}?client_id=${IMGUR_CLIENT_ID}&include=media`) : null;
    return imgurMediaToResult(json?.media) || { type: "image", urls: [`https://i.imgur.com/${id}.jpg`] };
  }
  return null;
}

/**
 * Gönderi JSON verisinden medya çıkarır.
 * @param postData Reddit "t3" gönderi verisi (data.children[i].data)
 * @param deps.resolveRedgifsMp4(id) -> Promise<string|null>
 * @param deps.fetchJson(url) -> Promise<json|null>  (Imgur albümleri için, isteğe bağlı)
 */
export async function extractMediaFromPostData(postData, deps = {}) {
  if (!postData) return null;
  if (!postData.media && !postData.secure_media && !postData.url && postData.crosspost_parent_list?.[0]) {
    return extractMediaFromPostData(postData.crosspost_parent_list[0], deps);
  }

  const media = postData.media ?? postData.secure_media;
  const provider = media?.oembed?.provider_name;
  const oembedHtml = media?.oembed?.html;

  if (postData.domain === "redgifs.com" || provider === "RedGIFs") {
    const fromHtml = oembedHtml?.match(/redgifs\.com\/ifr\/([^"?&/]+)/);
    const fromUrl = postData.url?.match(/redgifs\.com\/(?:watch|ifr)\/([^/?#]+)/i);
    const id = fromHtml?.[1] || fromUrl?.[1];
    if (id && deps.resolveRedgifsMp4) {
      const mp4Url = await deps.resolveRedgifsMp4(id);
      if (mp4Url) return { type: "video", urls: [mp4Url] };
    }
  }

  if (postData.is_gallery && postData.media_metadata && postData.gallery_data?.items) {
    const urls = postData.gallery_data.items
      .map((item) => galleryItemUrl(postData.media_metadata?.[item.media_id]))
      .filter(Boolean)
      .map((u) => u.replace(/&amp;/g, "&"));
    if (urls.length > 0) return { type: "gallery", urls };
  }

  if ((postData.post_hint === "image" || postData.domain === "i.redd.it") && postData.url && !/\.gifv(\?|$)/i.test(postData.url)) {
    return { type: "image", urls: [postData.url] };
  }

  const redditVideo = media?.reddit_video;
  if (redditVideo?.fallback_url) return redditVideoMedia(redditVideo);

  if (isImgurUrl(postData.url)) {
    const imgur = await resolveImgurMedia(postData.url, deps.fetchJson);
    if (imgur) return imgur;
  }

  // Crosspost: dış gönderide medya bulunamadıysa asıl gönderiye bak.
  if (postData.crosspost_parent_list?.[0]) {
    return extractMediaFromPostData(postData.crosspost_parent_list[0], deps);
  }

  return null;
}
