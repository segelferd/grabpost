// utils.js — dosya adı / klasör şablonlarını gerçek değerlerle değiştiren
// yardımcı fonksiyonlar. Kullanıcı ayarlarındaki {subreddit}, {title} gibi
// yer tutucuları burada dolduruyoruz.

/** Dosya sisteminde sorun çıkaracak karakterleri temizler. */
export function sanitizeForFilesystem(text, maxLength = 80) {
  const cleaned = text
    .replace(/[/\\?%*:|"<>]/g, "-")
    // ÖNEMLİ EK DÜZELTME (orijinal eklentinin kaynak kodunda bulundu):
    // Chrome'un dosya adı geçerlilik kuralı (base::i18n::IsFilenameLegal),
    // görünür olmayan Unicode "kontrol" (Cc) ve "biçim" (Cf) karakterlerini
    // de yasaklıyor. Bu, ÖZELLİKLE karmaşık emoji dizilerini kırıyor —
    // ör. 🤷‍♀️ gibi bir emoji, görünmez bir "sıfır genişlikli birleştirici"
    // (U+200D, Cf kategorisi) içeriyor; aile/cinsiyet varyasyonlu emojilerin
    // neredeyse hepsinde bu var. Bu karakterleri temizleyip görünür emoji
    // glifini koruyoruz (Chrome bunu izin veriyor, sadece görünmez
    // birleştiriciyi reddediyor).
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  // ÖNEMLİ DÜZELTME: .slice(0, maxLength) ham UTF-16 KOD BİRİMLERİ
  // üzerinde çalışıyor — bir emoji (Unicode'da iki kod biriminden oluşan
  // bir "surrogate çifti") TAM ORTASINDA kesilirse, tek başına kalmış
  // GEÇERSİZ bir surrogate (ör. \uD83E) dosya adında kalıyordu. Chrome
  // bunu "Invalid filename" diye reddediyordu. Array.from(), dizgiyi
  // Unicode KOD NOKTALARINA göre ayırıyor (her emoji tek bir birim
  // sayılıyor), bu yüzden kesme işlemi artık asla bir karakterin
  // ortasından geçmiyor.
  const codePoints = Array.from(cleaned);
  let truncated = codePoints.slice(0, maxLength).join("");

  // ÖNEMLİ 2. DÜZELTME: Kesme noktası, orijinal metnin ortasındaki bir
  // BOŞLUĞUN hemen sonrasına denk gelirse, sonuç SONUNDA boşlukla/nokta
  // ile biten bir ad üretiyordu. Windows, "." veya " " ile biten dosya/
  // klasör adlarını KESİNLİKLE reddediyor — bu, "Invalid filename"
  // hatasının emoji sorunundan BAĞIMSIZ, ikinci ve muhtemelen daha sık
  // rastlanan bir sebebiydi (uzun başlıklar sık sık kelime ortasında
  // değil boşlukta kesiliyor).
  truncated = truncated.replace(/[\s.]+$/, "");

  // Windows'un ayrılmış (reserved) cihaz adlarına tam olarak denk gelirse
  // (ör. bir gönderi başlığı "CON" ya da "NUL" olursa) çakışmayı önlemek
  // için sonuna zararsız bir karakter ekliyoruz.
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(truncated)) {
    truncated = `${truncated}_`;
  }

  return truncated || "untitled";
}

/**
 * Klasör YOLLARI için ayrı bir temizleme fonksiyonu. sanitizeForFilesystem
 * "/" işaretini de siliyor (dosya adları için doğru), ama klasör
 * şablonlarında "/" bilerek kullanılıyor — ör. "{user}/{subreddit}" ile
 * iç içe iki klasör oluşturmak için. Bu yüzden önce "/" ile segmentlere
 * ayırıyoruz, HER SEGMENTİ ayrı ayrı temizliyoruz, sonra tekrar birleştiriyoruz
 * — böylece hem geçersiz karakterler temizleniyor hem de klasör ayracı
 * (bölü işareti) korunuyor.
 */
export function sanitizeFolderPath(text, maxSegmentLength = 100) {
  return text
    .split("/")
    .map((segment) => sanitizeForFilesystem(segment, maxSegmentLength))
    .filter(Boolean)
    .join("/");
}

function getExtensionFromUrl(url) {
  const parsed = new URL(url);
  // v1.43.6: preview.redd.it hareketli galeri öğeleri ".gif" yolu taşıyıp
  // "?format=mp4" ile aslında MP4 dönebiliyor; uzantıyı gerçek biçime göre seç.
  const format = parsed.searchParams.get("format");
  if (format === "mp4") return "mp4";
  const match = parsed.pathname.match(/\.([a-z0-9]+)(?:$|\?)/i);
  return match ? match[1].toLowerCase() : "jpg";
}

/**
 * post.date'i güvenle bir "YYYY-AA-GG" metnine çevirir. ÖNEMLİ DÜZELTME:
 * new Date(post.date).toISOString() önceden ÇÖKEBİLİYORDU — eğer
 * post.date beklenmedik bir formatta gelirse (ör. Reddit'in
 * created-timestamp özniteliği ISO metni değil de ham bir Unix zaman
 * damgası verirse), new Date(...) geçersiz bir tarih üretiyor ve
 * .toISOString() bunun üzerinde HATA FIRLATIYORDU. Bu hata, buildFilePath'in
 * tamamını çökertip dosya adı hiç oluşmadan chrome.downloads.download()'a
 * geçilmesine, Chrome'un da bu yüzden varsayılan İndirilenler klasörüne
 * düşmesine sebep oluyordu. Artık ISO metni, saniye/milisaniye cinsinden
 * sayısal zaman damgası — hangisi gelirse gelsin deniyoruz, hiçbiri işe
 * yaramazsa (asla çökmeden) bugünün tarihine düşüyoruz.
 */
function safeDateString(dateValue) {
  const today = () => new Date().toISOString().slice(0, 10);
  if (!dateValue) return today();

  try {
    let d = new Date(dateValue);
    if (isNaN(d.getTime()) && /^\d+$/.test(String(dateValue).trim())) {
      const num = Number(dateValue);
      // 13 haneli/büyük sayılar zaten milisaniye, küçükler (Unix epoch
      // saniye) 1000 ile çarpılıyor.
      d = new Date(num < 1e12 ? num * 1000 : num);
    }
    if (isNaN(d.getTime())) return today();
    return d.toISOString().slice(0, 10);
  } catch {
    return today();
  }
}

/**
 * Şablon + gönderi bilgisinden nihai dosya yolunu üretir.
 * pattern örneği: "{subreddit}_{timestamp}_{filename}"
 *
 * ÖNEMLİ: "timestamp" dışarıdan verilmeli (galeri indirirken TÜM görseller
 * için AYNI zaman damgası kullanılmalı, yoksa her görsel kendi klasörüne
 * düşer). Verilmezse (tekli indirme gibi durumlar için) Date.now() kullanılır.
 */
export function buildFilePath({ folderPattern, filenamePattern, post, url, index, timestamp }) {
  const ts = timestamp ?? Date.now();
  const ext = getExtensionFromUrl(url);
  const safeTitle = sanitizeForFilesystem(post.title || "untitled");
  const filenameBase = `${index ?? 0}`.padStart(2, "0");
  const postDateStr = safeDateString(post.date);

  const replace = (str) =>
    str
      .replaceAll("{subreddit}", post.subreddit || "unknown")
      .replaceAll("{user}", post.author || "unknown")
      .replaceAll("{title}", safeTitle)
      .replaceAll("{timestamp}", String(ts))
      .replaceAll("{date}", postDateStr)
      .replaceAll("{filename}", filenameBase);

  const folder = sanitizeFolderPath(replace(folderPattern));
  const filename = `${sanitizeForFilesystem(replace(filenamePattern), 100)}.${ext}`;

  // SON GÜVENLİK AĞI: Başka bir yerden (ör. Reddit'in kendi verisinde
  // zaten bozuk bir karakter varsa) yarım kalmış bir "surrogate" sızarsa
  // bile, dosya yoluna girmeden hemen önce son bir kez temizliyoruz —
  // "Invalid filename" hatasının bir daha çıkmaması için.
  const stripLoneSurrogates = (str) => str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

  return stripLoneSurrogates(`${folder}/${filename}`);
}
