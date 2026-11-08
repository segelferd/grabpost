// processing.js — medya işleme çekirdeği (FFmpeg.wasm ile video+ses
// birleştirme, başlık gömme; görsel başlık bandı; parmak izi hesaplama).
//
// v1.47.0: Bu kod önceden doğrudan offscreen.js içindeydi. Firefox'ta
// "offscreen document" API'si YOK, ama arka plan sayfasının kendisi tam
// bir DOM ortamı (URL.createObjectURL, DOMParser, OffscreenCanvas, Worker
// hepsi var). Bu yüzden işleme mantığı bu ortak modüle taşındı:
//   Chrome : offscreen.js bunu yükleyip mesajlarla çalıştırıyor
//   Firefox: background.js bunu DOĞRUDAN çağırıyor (mesaj yok)
// Davranış iki tarafta da aynı.
// (eski başlık) offscreen.js — video VE görsel başlık yazısı ekleme.
//
// ÖNEMLİ: FFmpeg.wasm dosyaları artık UZAK bir CDN'den DEĞİL, eklentinin
// kendi "libs/" klasöründen yükleniyor. İlk denemede CDN'den yüklemeye
// çalışmıştık ama Chrome (Manifest V3), güvenlik gereği "uzaktan kod
// çalıştırmayı" kesinlikle yasaklıyor — bu yüzden manifest reddedilmişti.
// Şimdi FFmpeg'in gerçek dosyaları (JS + WASM, ~31MB) doğrudan eklenti
// paketinin içinde duruyor, hiçbir uzak adrese istek atmıyoruz.
//
// GÖRSEL başlık yazısı da BURADA işleniyor — önceden bunu background.js
// (service worker) içinde yapmaya çalışıyorduk ama `URL.createObjectURL()`
// service worker ortamında HİÇ YOK (bilinen bir Manifest V3 kısıtlaması),
// bu yüzden her zaman sessizce başarısız oluyordu. Offscreen document'ların
// tam bir pencere/DOM bağlamı var, bu fonksiyon orada sorunsuz çalışıyor.

let ffmpegInstance = null;
const ffmpegLogTail = [];

/**
 * ÖNEMLİ DÜZELTME: "Offscreen document'lar da chrome.downloads
 * kullanabilir" diye yazmıştım ama bu YANLIŞ bir varsayımmış — hiç
 * doğrulamamıştım. Gerçekte offscreen document'ların çoğu Chrome API'sine
 * (chrome.downloads dahil) erişimi YOK. Bu yüzden video/görsel işleme
 * burada bitiyor ama İNDİRME background.js'e (gerçek API erişimi olan
 * yer) devrediliyor. blob: URL'ler bir bağlamdan diğerine taşınamadığı
 * için (her execution context'e özel), sonucu base64 "data:" URL'i olarak
 * gönderiyoruz — bu, herhangi bir bağlamda kullanılabilen, kendi kendine
 * yeten bir format.
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function getFfmpeg() {
  if (ffmpegInstance) return ffmpegInstance;

  const { FFmpeg } = await import(chrome.runtime.getURL("libs/ffmpeg/index.js"));

  const ffmpeg = new FFmpeg();
  // v1.44.5: FFmpeg her kare için satır basıyordu. Artık son 200 satır
  // bellekte tutuluyor ve SADECE işlem başarısız olursa konsola yazılıyor.
  ffmpeg.on("log", ({ message }) => {
    ffmpegLogTail.push(message);
    if (ffmpegLogTail.length > 200) ffmpegLogTail.shift();
  });

  await ffmpeg.load({
    coreURL: chrome.runtime.getURL("libs/core/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("libs/core/ffmpeg-core.wasm"),
  });

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

/** Metni FFmpeg'in "drawtext" filtresinde güvenli kullanılabilecek şekilde kaçışlar. */
function escapeForDrawtext(text) {
  return text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "")
    .slice(0, 90);
}

/** Videonun altına eklenen sabit boyutlu bandın yüksekliği (piksel). */
const VIDEO_BAND_HEIGHT = 60;

/**
 * v1.43.7 SES DÜZELTMESİ: Reddit'in kendi videolarında (v.redd.it) ses
 * ayrı bir dosyada duruyor ve dosya adı yıllar içinde değişti:
 *   eski videolar: DASH_audio.mp4 / audio.mp4
 *   yeni videolar: DASH_AUDIO_128.mp4 / DASH_AUDIO_64.mp4
 * Önceden sadece "DASH_audio.mp4" deneniyordu; yeni videolarda 404 dönüp
 * birleştirme iptal oluyor, video SESSİZ iniyordu. Artık:
 *   1) Önce videonun DASH manifestini (DASHPlaylist.mpd) okuyup Reddit'in
 *      KENDİ bildirdiği ses dosyasını (en yüksek kalite) kullanıyoruz.
 *   2) Manifest okunamazsa bilinen tüm adları sırayla deniyoruz.
 * Ses gerçekten yoksa NO_AUDIO hatası dönüyor; background bu durumda
 * FFmpeg'i hiç yüklemeden videoyu doğrudan indiriyor.
 */
async function fetchOk(url) {
  try {
    const res = await fetch(url, { referrer: "https://www.reddit.com/" });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (type.includes("text/html")) return null; // hata sayfası, medya değil
    return res;
  } catch {
    return null;
  }
}

async function audioUrlsFromDashManifest(dashUrl) {
  const res = await fetchOk(dashUrl);
  if (!res) return [];
  const xml = new DOMParser().parseFromString(await res.text(), "application/xml");
  const found = [];
  for (const set of xml.getElementsByTagName("AdaptationSet")) {
    const setType = `${set.getAttribute("contentType") || ""} ${set.getAttribute("mimeType") || ""}`;
    for (const rep of set.getElementsByTagName("Representation")) {
      const repType = `${setType} ${rep.getAttribute("mimeType") || ""}`;
      if (!/audio/i.test(repType)) continue;
      const base = rep.getElementsByTagName("BaseURL")[0]?.textContent?.trim();
      if (!base) continue;
      found.push({ url: new URL(base, dashUrl).href, bandwidth: Number(rep.getAttribute("bandwidth") || 0) });
    }
  }
  return found.sort((a, b) => b.bandwidth - a.bandwidth).map((f) => f.url);
}

/**
 * v1.49.2 HLS ANA LİSTESİNDEN SES: Reddit her videonun HLS ana listesinde
 * (HLSPlaylist.m3u8) ses kanallarını #EXT-X-MEDIA:TYPE=AUDIO satırlarıyla
 * bildiriyor. DASH listesi okunamadığında dosya adını tahmin etmek yerine
 * buradaki gerçek kanalı kullanıyoruz (RedditGrab'in yöntemi). Kanalın
 * kendi listesi tek bir dosyayı gösteriyorsa (Reddit'te öyle, parçalar aynı
 * dosyanın bayt aralıkları) o dosya; değilse aynı adın .mp4/.aac hali denenir.
 */
async function audioUrlsFromHlsManifest(hlsUrl) {
  const res = await fetchOk(hlsUrl);
  if (!res) return [];
  const lines = (await res.text()).split(/\r?\n/);
  const renditions = [];
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-MEDIA") || !/TYPE=AUDIO/i.test(line)) continue;
    const uri = line.match(/URI="([^"]+)"/)?.[1];
    if (!uri) continue;
    const rank = Number(line.match(/GROUP-ID="(\d+)/)?.[1] || line.match(/(\d+)(?:_K)?\.m3u8/i)?.[1] || 0);
    renditions.push({ url: new URL(uri, hlsUrl).href, rank });
  }
  renditions.sort((a, b) => b.rank - a.rank);
  const out = [];
  for (const { url } of renditions) {
    const media = await fetchOk(url);
    if (media) {
      const files = new Set();
      for (const l of (await media.text()).split(/\r?\n/)) {
        const line = l.trim();
        if (line && !line.startsWith("#")) files.add(new URL(line, url).href.split("#")[0]);
      }
      if (files.size === 1) {
        out.push([...files][0]);
        break; // en iyi kanalın gerçek dosyası bulundu, düşük kaliteleri sormaya gerek yok
      }
    }
    out.push(url.replace(/\.m3u8(\?|$)/i, ".mp4$1"), url.replace(/\.m3u8(\?|$)/i, ".aac$1"));
  }
  return out;
}

async function resolveAudio(sources) {
  if (!sources) return null;
  const { audioUrl, audioCandidates = [], dashUrl, hlsUrl } = sources;
  const ordered = [];
  if (dashUrl) ordered.push(...(await audioUrlsFromDashManifest(dashUrl)));
  if (hlsUrl && ordered.length === 0) ordered.push(...(await audioUrlsFromHlsManifest(hlsUrl)));
  ordered.push(...audioCandidates);
  if (audioUrl) ordered.push(audioUrl);
  const seen = new Set();
  for (const url of ordered) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const res = await fetchOk(url);
    if (res) {
      console.log("[GrabPost:offscreen] Ses dosyası bulundu:", url);
      return new Uint8Array(await res.arrayBuffer());
    }
  }
  return null;
}

class NoAudioError extends Error {
  constructor() {
    super("NO_AUDIO");
    this.code = "NO_AUDIO";
  }
}

async function safeDelete(ffmpeg, names) {
  for (const name of names) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* dosya yoksa sorun değil */
    }
  }
}

/**
 * FFmpeg komutunu çalıştırır ve çıkış kodunu KONTROL eder. ffmpeg.exec()
 * hata olsa bile fırlatmıyor, sadece sıfırdan farklı bir kod döndürüyor.
 * Önceden kod kontrol edilmediği için başarısız bir işlemde bir ÖNCEKİ
 * işlemden kalan output.mp4 okunup yanlış video indirilebilirdi. Artık
 * çıktı dosyası önce siliniyor ve kod 0 değilse hata fırlatılıyor.
 */
async function runFfmpeg(ffmpeg, args) {
  await safeDelete(ffmpeg, ["output.mp4"]);
  ffmpegLogTail.length = 0;
  const code = await ffmpeg.exec(args);
  if (code !== 0) {
    console.warn("[GrabPost:offscreen] FFmpeg günlüğünün son satırları:\n" + ffmpegLogTail.slice(-40).join("\n"));
    throw new Error(`FFmpeg başarısız (çıkış kodu ${code})`);
  }
}

async function fetchVideoBuffer(videoUrl) {
  const res = await fetch(videoUrl, { referrer: "https://www.reddit.com/" });
  if (!res.ok) throw new Error(`Video indirilemedi: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Reddit videosunu ayrı sesiyle birleştirir (yeniden kodlama yok, "-c copy").
 * Ses bulunamazsa FFmpeg'i hiç yüklemeden NO_AUDIO hatası fırlatır.
 */
async function mergeVideoAudio(videoUrl, audioSources) {
  const audioBuf = await resolveAudio(audioSources);
  if (!audioBuf) throw new NoAudioError();

  const ffmpeg = await getFfmpeg();
  console.log("[GrabPost:offscreen] Video indiriliyor...");
  const videoBuf = await fetchVideoBuffer(videoUrl);
  await ffmpeg.writeFile("video_only.mp4", videoBuf);
  await ffmpeg.writeFile("audio_only.mp4", audioBuf);

  console.log("[GrabPost:offscreen] Video+ses birleştiriliyor (yeniden kodlama yapılmıyor, hızlı)...");
  await runFfmpeg(ffmpeg, ["-i", "video_only.mp4", "-i", "audio_only.mp4", "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest", "output.mp4"]);

  const data = await ffmpeg.readFile("output.mp4");
  await safeDelete(ffmpeg, ["video_only.mp4", "audio_only.mp4", "output.mp4"]);
  return new Blob([data.buffer], { type: "video/mp4" });
}

/**
 * Videonun altına başlık bandı ekler. v1.43.7: Ayrı ses kaynağı verilmişse
 * (Reddit videoları) ses de ikinci girdi olarak eklenir. Önceden bu yol
 * sadece görüntüyü alıyordu, başlıklı videolar HER ZAMAN sessiz iniyordu.
 */
async function burnTitleIntoVideo(videoUrl, title, audioSources) {
  const ffmpeg = await getFfmpeg();

  console.log("[GrabPost:offscreen] Video indiriliyor:", videoUrl);
  const videoBuf = await fetchVideoBuffer(videoUrl);
  await ffmpeg.writeFile("input.mp4", videoBuf);

  const audioBuf = await resolveAudio(audioSources);
  if (audioBuf) await ffmpeg.writeFile("audio_only.mp4", audioBuf);

  // Yazı tipi: eklentiyle birlikte paketlenen gerçek bir TTF dosyası
  // (Roboto Bold), CDN'den değil, tamamen yerel.
  const fontRes = await fetch(chrome.runtime.getURL("assets/fonts/Roboto-Bold.ttf"));
  const fontBuf = new Uint8Array(await fontRes.arrayBuffer());
  await ffmpeg.writeFile("font.ttf", fontBuf);

  const safeTitle = escapeForDrawtext(title || "");
  // Metni videonun üstüne bindirmek yerine "pad" ile altına sabit boyutlu
  // siyah bir bant ekleyip başlığı oraya yazıyoruz; video kırpılmıyor.
  const drawtext =
    `pad=iw:ih+${VIDEO_BAND_HEIGHT}:0:0:black,` +
    `drawtext=fontfile=font.ttf:text='${safeTitle}':fontcolor=white:fontsize=22:` +
    `x=(w-text_w)/2:y=h-${VIDEO_BAND_HEIGHT}+(${VIDEO_BAND_HEIGHT}-th)/2`;

  console.log("[GrabPost:offscreen] FFmpeg işleniyor (bu biraz sürebilir)...");
  const args = audioBuf
    ? ["-i", "input.mp4", "-i", "audio_only.mp4", "-map", "0:v:0", "-map", "1:a:0", "-vf", drawtext, "-c:a", "copy", "-shortest", "output.mp4"]
    : ["-i", "input.mp4", "-vf", drawtext, "-codec:a", "copy", "output.mp4"];
  await runFfmpeg(ffmpeg, args);

  const data = await ffmpeg.readFile("output.mp4");
  await safeDelete(ffmpeg, ["input.mp4", "audio_only.mp4", "output.mp4"]);
  return new Blob([data.buffer], { type: "video/mp4" });
}

/**
 * v1.43.7 BÜYÜK DOSYA DÜZELTMESİ: İşlenen dosya önceden base64 "data:"
 * adresine çevrilip mesajla gönderiliyordu. Chrome'un mesaj boyutu sınırı
 * yüzünden (~64 MB; base64 boyutu %33 şişiriyor) büyük videolarda yanıt
 * HİÇ gelmiyor, indirme sonsuza kadar askıda kalıyordu (test edildi: 70 MB
 * yanıt dönmedi). Artık dosyayı burada bir blob: adresi olarak tutuyoruz ve
 * background'a sadece bu kısa adresi gönderiyoruz; aynı eklenti kökeninde
 * olduğu için chrome.downloads bu adresi doğrudan indirebiliyor (80 MB ile
 * test edildi). İndirme bitince background REVOKE_BLOB_URL ile bellek
 * boşaltılmasını istiyor; unutulursa 30 dk sonra kendiliğinden boşaltılıyor.
 */
const liveBlobUrls = new Map();
function blobToResponse(blob) {
  const blobUrl = URL.createObjectURL(blob);
  const timer = setTimeout(() => revokeBlobUrl(blobUrl), 30 * 60 * 1000);
  liveBlobUrls.set(blobUrl, timer);
  return { ok: true, blobUrl, size: blob.size };
}
function revokeBlobUrl(blobUrl) {
  const timer = liveBlobUrls.get(blobUrl);
  if (timer) clearTimeout(timer);
  liveBlobUrls.delete(blobUrl);
  URL.revokeObjectURL(blobUrl);
}

/**
 * Bir görsele, ALTINA EKLENEN sabit boyutlu siyah bir bant üzerine gönderi
 * başlığını yazarak "başlık yazısı eklenmiş" bir kopya oluşturur.
 * ÖNEMLİ TASARIM DEĞİŞİKLİĞİ: Önceden metni görselin ÜZERİNE bindiriyorduk
 * (içeriğin bir kısmını kapatıyordu) — artık orijinal eklenti gibi
 * tuval'i (canvas) büyütüp görseli hiç değiştirmeden en üste yerleştiriyor,
 * başlığı sadece ALTINA EKLENEN yeni alana yazıyoruz.
 * Offscreen document'ta çalıştığı için OffscreenCanvas VE URL.createObjectURL
 * sorunsuz çalışıyor (service worker'da ikincisi hiç yoktu).
 */
/**
 * Verilen metni, ctx'in geçerli yazı tipiyle ölçerek maxWidth'e sığacak
 * şekilde birden fazla satıra böler (orijinal eklentinin yaklaşımına
 * uyarlandı). maxLines'ı aşarsa, son satırın sonuna "…" eklenir.
 */
function wrapTitleText(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = "";
  let wordIndex = 0;

  while (wordIndex < words.length && lines.length < maxLines) {
    const word = words[wordIndex];
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width <= maxWidth || !currentLine) {
      currentLine = testLine;
      wordIndex++;
    } else {
      lines.push(currentLine);
      currentLine = "";
    }
  }
  if (currentLine) lines.push(currentLine);

  // Tüm kelimeler sığmadıysa, son satırın sonuna "…" ekleyip yeniden sığdır.
  if (wordIndex < words.length && lines.length > 0) {
    let lastLine = lines[lines.length - 1];
    while (lastLine.length > 0 && ctx.measureText(`${lastLine}…`).width > maxWidth) {
      lastLine = lastLine.slice(0, -1).trimEnd();
    }
    lines[lines.length - 1] = `${lastLine}…`;
  }

  return lines;
}

/**
 * ÖNEMLİ YENİ ÖZELLİK: Bir görselin "algısal parmak izini" (dHash)
 * çıkarır — görseli 9x8 piksele küçültüp, her pikseli sağındaki pikselle
 * karşılaştırarak 64 bitlik bir imza üretiyoruz. Bu imza, görselin küçük
 * sıkıştırma/format farklarına (Reddit'in aynı fotoğrafı farklı
 * gönderilerde yeniden işlemesi gibi) DAYANIKLI — SHA-256'nın aksine,
 * görsel içeriği aynı kaldığı sürece bu imza de neredeyse aynı kalıyor.
 */
async function computePerceptualHash(imageUrl) {
  const res = await fetch(imageUrl, { referrer: "https://www.reddit.com/" });
  if (!res.ok) throw new Error(`Görsel indirilemedi: HTTP ${res.status}`);
  const blob = await res.blob();
  return computeDHashFromBlob(blob);
}

/**
 * v1.43.5: Görseli TEK kez indirip hem SHA-256 (birebir kopya) hem de
 * dHash (görsel benzerlik) parmak izini birlikte döner. GIF gibi
 * createImageBitmap'in açamadığı bir biçim gelirse dHash null döner,
 * SHA-256 yine de çalışır.
 */
async function computeMediaHashes(imageUrl) {
  const res = await fetch(imageUrl, { referrer: "https://www.reddit.com/" });
  if (!res.ok) throw new Error(`Görsel indirilemedi: HTTP ${res.status}`);
  const blob = await res.blob();
  const buf = await blob.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const sha256 = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  let dhash = null;
  try {
    dhash = await computeDHashFromBlob(blob);
  } catch (error) {
    console.warn("[GrabPost:offscreen] dHash hesaplanamadı (sadece SHA-256 kullanılacak):", error?.message || error);
  }
  return { sha256, dhash };
}

async function computeDHashFromBlob(blob) {
  const bitmap = await createImageBitmap(blob);

  const w = 9;
  const h = 8;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h); // küçük, bulanık bir örneğe indirger
  const { data } = ctx.getImageData(0, 0, w, h);

  // Griye çevir (basit ortalama).
  const gray = [];
  for (let i = 0; i < data.length; i += 4) {
    gray.push((data[i] + data[i + 1] + data[i + 2]) / 3);
  }

  // dHash: her piksel, hemen sağındaki pikselden daha parlaksa "1", değilse "0".
  let bits = "";
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w - 1; col++) {
      bits += gray[row * w + col] > gray[row * w + col + 1] ? "1" : "0";
    }
  }

  // 64 bitlik ikili diziyi depolamak için hex'e çevir (16 karakter).
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

async function embedTitleIntoImage(imageUrl, title) {
  const res = await fetch(imageUrl, { referrer: "https://www.reddit.com/" });
  if (!res.ok) throw new Error(`Görsel indirilemedi: HTTP ${res.status}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);

  // ÖNEMLİ İYİLEŞTİRME (orijinal eklentiye uyarlandı): Tek satırda kesmek
  // yerine, metni GENİŞLİĞE göre birden fazla satıra bölüp sığdırıyoruz.
  // Yazı boyutu görselin genişliğine göre ölçekleniyor (çok küçük/büyük
  // görsellerde de okunaklı kalması için).
  const fontSize = Math.max(20, Math.min(40, Math.round(bitmap.width / 25)));
  const lineHeight = Math.round(fontSize * 1.3);
  const padding = 16;
  const maxLines = 3;

  // Kaç satır olacağını (dolayısıyla bandın yüksekliğini) bilmeden tuvali
  // oluşturamayız — önce ölçüm için ayrı, küçük bir tuval kullanıyoruz.
  const measureCanvas = new OffscreenCanvas(1, 1);
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.font = `bold ${fontSize}px sans-serif`;
  const maxTextWidth = bitmap.width - padding * 2;
  const lines = wrapTitleText(measureCtx, title, maxTextWidth, maxLines);

  const bandHeight = lines.length * lineHeight + padding * 2;

  // Tuval, görselden DAHA UZUN — görsel hiç küçülmeden/kırpılmadan en
  // üstte duruyor, başlık için altına yeni bir alan ekleniyor.
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height + bandHeight);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0); // görsel, orijinal boyutuyla, üstte

  // Altına eklenen düz siyah bant (üzerine bindirme değil, boyu satır sayısına göre)
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, bitmap.height, bitmap.width, bandHeight);

  // Başlık metni — her satır kendi hizasına yazılıyor
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    const y = bitmap.height + padding + lineHeight * i + lineHeight / 2;
    ctx.fillText(line, padding, y, maxTextWidth);
  });

  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}


/**
 * v1.47.3 İNDİRME YÖNETİCİSİ (IDM) UYUMU: Dosyayı eklentinin kendisi çekip
 * bir blob: adresi olarak döner. Chrome'a "https://..." adresi yerine bu
 * yerel adres verildiğinde, IDM gibi indirme yöneticileri indirmeyi ele
 * geçiremiyor (yerel blob adresini kendileri indiremedikleri için
 * dokunmuyorlar). Referans aldığımız RedditGrab da tüm indirmelerini bu
 * yolla yapıyor; IDM ile sorun yaşamamasının sebebi bu.
 */
async function fetchToBlob(url) {
  const res = await fetch(url, { referrer: "https://www.reddit.com/" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (type.includes("text/html")) throw new Error("HTML hata sayfası döndü");
  const blob = await res.blob();
  if (!blob.size) throw new Error("boş dosya");
  return blob;
}

/**
 * Tek giriş noktası. Bilinen bir mesaj türüyse yanıt sözü (Promise) döner,
 * değilse null (çağıran taraf başka dinleyicilere bırakır).
 */
export function handleProcessingMessage(message) {
  const safe = async (fn, label) => {
    try {
      return await fn();
    } catch (error) {
      console.error(`[GrabPost:processing] ${label} hatası:`, error);
      return { ok: false, error: String(error?.message || error) };
    }
  };
  switch (message?.type) {
    case "EMBED_IMAGE_TITLE":
      return safe(async () => blobToResponse(await embedTitleIntoImage(message.imageUrl, message.title)), "Görsel işleme");
    case "BURN_VIDEO_TITLE":
      return safe(async () => blobToResponse(await burnTitleIntoVideo(message.videoUrl, message.title, message.audio)), "Video işleme");
    case "MERGE_VIDEO_AUDIO":
      return (async () => {
        try {
          return blobToResponse(await mergeVideoAudio(message.videoUrl, message.audio));
        } catch (error) {
          if (error?.code === "NO_AUDIO") return { ok: false, error: "NO_AUDIO", noAudio: true };
          console.error("[GrabPost:processing] Video+ses birleştirme hatası:", error);
          return { ok: false, error: String(error?.message || error) };
        }
      })();
    case "COMPUTE_MEDIA_HASHES":
      return safe(async () => ({ ok: true, ...(await computeMediaHashes(message.imageUrl)) }), "Medya parmak izi");
    case "COMPUTE_PERCEPTUAL_HASH":
      return safe(async () => ({ ok: true, hash: await computePerceptualHash(message.imageUrl) }), "Algısal parmak izi");
    case "MAKE_BLOB":
      // v1.48.2: otomatik yedek dosyası (service worker blob adresi oluşturamıyor)
      return safe(async () => blobToResponse(new Blob([message.text || ""], { type: message.mime || "application/octet-stream" })), "Dosya oluşturma");
    case "FETCH_TO_BLOB":
      return safe(async () => blobToResponse(await fetchToBlob(message.url)), "Dosya çekme");
    case "READ_CLIPBOARD":
      // v1.47.4: Yan panel klavye odağı alamadığında panoyu buradan okuyoruz
      // (clipboardRead izniyle eklenti sayfalarında execCommand("paste") çalışır).
      return safe(async () => {
        const area = document.createElement("textarea");
        document.body.appendChild(area);
        area.focus();
        const ok = document.execCommand("paste");
        const text = area.value;
        area.remove();
        return { ok, text };
      }, "Pano okuma");
    case "REVOKE_BLOB_URL":
      if (message.blobUrl) revokeBlobUrl(message.blobUrl);
      return Promise.resolve({ ok: true });
    default:
      return null;
  }
}
