# GrabPost Değişiklik Günlüğü

Her düzeltme kendi sürüm numarasını aldı. En yeni en üstte.

## v1.50.3
- İlerleme yüzdesi dile göre gösteriliyor (önceden her dilde '%50'); GitHub Pages tanıtım sitesi (docs/, 15 dil), README.md, NOTICE.md güncellendi

## v1.50.2
- Yeniden enjeksiyon güvenliği: sayfa yüklenirken ikinci bir kopya gelirse kendini geri çekiyor (çift düğme ve çift indirme olmuyor); durdurulmuş kopya mesajlara cevap vermiyor

## v1.50.1
- Açılışta kaçan kontrol: tarayıcı açılınca alarm artık sıfırlanmıyor (eskiden ilk kontrol 'aralık' kadar sonraya kayıyordu); son kontrol aralığı aştıysa 2 dk içinde kendiliğinden kontrol başlıyor

## v1.50.0
- Favori takip: kaynağın yanındaki ★ ile en fazla 10 favori; favoriler ayrı ve daha sık kontrol ediliyor (5/10/15/30/60 dk, Kontrol Ayarları), sonraki favori kontrolü panelde; favoriler hesaba senkronize ve takip listesi dışa/içe aktarmada korunuyor

## v1.49.4
- Toplu indirmede inen gönderi turuncu çerçeveyle vurgulanıyor; Ayarlar > Tarama'da 'Daha önce indirilenleri de tekrar indir' seçeneği (sayfa ve hızlı mod)

## v1.49.3
- Reddit hız sınırı (429): Retry-After kadar bekleyip bir kez tekrar deniyor, uzun kısıtlamada hızlı mod ve Takip kontrolü duruyor (panelde açıklama); tüm Reddit/API isteklerine 20 sn zaman aşımı

## v1.49.2
- Video sesi: DASH listesi okunamazsa ses kanalı Reddit'in HLS ana listesinden (gerçek dosya adıyla) bulunuyor; dosya adı tahmini en son çare

## v1.49.1
- Asılı kalma koruması: sayfadan arka plana giden tüm mesajlar zaman aşımlı; eklenti güncellenince/yeniden yüklenince açık Reddit sekmelerine yeni kopya otomatik enjekte ediliyor, eski kopya kendini kapatıyor (sayfayı yenilemeye gerek yok). Yeni izin: scripting (uyarı göstermez)

## v1.49.0
- Toplu indirme: sıradaki gönderilerin medyası önceden ve gönderi ekrandayken çözülüyor; tarama indirmenin en fazla 12 gönderi önünde gidiyor, hiç görünmemiş gönderi indirilmeden önce ekrana getiriliyor

## v1.48.4
- Sabit eklenti kimliği (manifest key), mağaza ve Firefox paketlerinde anahtar çıkarılıyor

## v1.48.3
- İlk kurulum karşılama ekranı + kurulumda otomatik indirme geçmişi kurtarma

## v1.48.2
- Otomatik yedek dosyası: günlük + her 50 indirmede, İndirilenler/GrabPost-Yedek, üzerine yazar + haftalık kopya, indirme listesinde görünmez; yeni kurulumda eski yedeğin üzerine yazmaz

## v1.48.1
- Her indirmeye görünmez kurtarma etiketi; Ayarlar'da 'Chrome indirme geçmişinden kurtar' (indirildi belleği + Geçmiş, eski indirmeler için Geçmiş)

## v1.48.0
- Ayarlar Chrome hesabına (sync) yedekleniyor; yeniden kurulumda ayarlar ve takip listesi otomatik geri geliyor

## v1.47.5
- Dosya adı çakışması tespiti: başka bir eklenti (IDM) klasör/adı devralırsa Ana Sayfa'da nedenini ve çözümünü anlatan uyarı

## v1.47.4
- Yapıştırma: 📋 Yapıştır düğmesi (pano izni ilk kullanımda istenir), tam Reddit adresi yapıştırınca ad/tür ayıklanır, 'açık sayfayı ekle' düğmesi, yanıltıcı otomatik odak düzeltildi

## v1.47.3
- IDM uyumu: dosyalar eklenti içinde çekilip yerel blob adresiyle indiriliyor (RedditGrab yöntemi); Gelişmiş'te 'İndirme yöneticisi (IDM) uyumluluğu' ayarı, varsayılan açık

## v1.47.2
- Takip listesi dışa/içe aktarma (JSON, düz metin, Reddit adresleri); 'u/ad' ve tam adres yazınca tür otomatik seçiliyor

## v1.47.1
- Takip listesi sürükle-bırak sırası artık kaydediliyor (bırakma kartın üstünde olunca kaydedilmiyordu, ilk otomatik kontrolde eski sıra dönüyordu)

## v1.47.0
- Firefox sürümü: ortak işleme modülü (src/processing.js), platform algılama, Firefox derleme betiği (tools/), innerHTML temizliği (madde 21b)

## v1.46.0
- Hızlı mod: sayfa kaydırmadan API ile toplu indirme (subreddit, profil, multireddit, arama, ana sayfa) + Kaydedilenlerimi indir (madde 15, 16)

## v1.45.7
- Yorumlardaki görsellere indirme butonu (madde 19b)

## v1.45.6
- Imgur desteği: doğrudan dosya, .gifv, tekli sayfa, albüm/galeri (sayfa, Takip ve eski Reddit yollarında) (madde 19a)

## v1.45.5
- Abonelik filtreleri (medya türü, NSFW, anahtar kelime); senkronize takip listesi 90+ kaynakta kaybolmuyor (madde 20b + ek bulgu)

## v1.45.4
- Yedeği dışa/içe aktarma (JSON, birleştirerek) (madde 17)

## v1.45.3
- Yarıda kalan indirme artık 'indirildi' sayılmıyor, geçmişte başarılı görünmüyor

## v1.45.2
- Geçmiş: arama, gönderiyi aç, klasörde göster; başarısız indirmeler listesi + tekrar dene (madde 18)

## v1.45.1
- Sağ tık 'GrabPost ile indir' menüsü ve Alt+Shift+D kısayolu (madde 21)

## v1.45.0
- Takip kontrol aralığına 30 dk ve 1 saat eklendi; geçmişteki göreli zaman 15 dilde (madde 20a)

## v1.44.6
- Sayfa dili yüklenince İndirildi butonları da çevriliyor; eski Reddit butonları doğru görünümle tazeleniyor (test sırasında bulundu)

## v1.44.5
- Ortak medya modülü (src/media.js) ve seviyeli günlük + Gelişmiş'te 'Geliştirici günlüğü' ayarı (madde 14)

## v1.44.4
- Depolama: yazma kilidi (Web Locks), gönderi başına indirme kaydı + otomatik taşıma, parmak izi önbelleği, 100k sınır (madde 9, 10)

## v1.44.3
- Takip kontrolü zaman damgası filigranı kullanıyor (madde 11); paneldeki abonelik hata uyarısı yeniden görünüyor (ek bulgu)

## v1.44.2
- Sayfa taraması 150 ms toplu çalışıyor, medyasız gönderiler sınırlı deneniyor; unlimitedStorage izni (madde 8, 9a)

## v1.44.1
- İndirme sonucu hız sınırı beklemesinden önce dönüyor, buton daha erken güncelleniyor

## v1.44.0
- Ses düzeltmeleri (DASH manifest + yeni ses adları, Takip/arama yollarında ses, başlıklı videoda ses, video çözümleme sırası) ve büyük videolar için blob aktarımı + zaman aşımı + FFmpeg çıkış kodu kontrolü (madde 1-4)

## v1.43.6
- GIF/video içeren galerilerdeki hareketli öğeler artık atlanmıyor (madde 13)

## v1.43.5
- Yinelenen medya kontrolü videoları atlıyor, görseller 3 yerine 2 kez indiriliyor (madde 12)

## v1.43.4
- Tümünü indir kilitlenmesi giderildi; indirilemeyen ve bildirim dışı bekleyenler artık silinmiyor (madde 5)

## v1.43.3
- Kapatılan bildirimlerin kayıtları artık siliniyor, 7 gün/50 kayıt sınırı (madde 6)

## v1.43.2
- Bildirimler ve panel hata metinleri 15 dile çevrildi (madde 7)

## Firefox paketi
- Aynı kaynak koddan `tools/build-firefox.mjs` ile üretilir (`cd tools && npm install && npm run firefox`).
