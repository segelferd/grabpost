// log.js — seviyeli, kapatılabilir günlük (KickAlert'teki KLog yaklaşımının sade hali).
// v1.44.5: Önceden ~125 console çağrısı her koşulda çalışıyor, ayar ve medya
// nesnelerini bile konsola basıyordu; etiketler de [MediaGrab]/[GrabPost]
// olarak karışıktı. Artık:
//   debug/info -> SADECE Ayarlar > Gelişmiş > "Geliştirici günlüğü" açıksa
//   warn/error -> her zaman (gerçek sorunlar görünür kalsın)
// Tüm satırlar tek biçimde etiketleniyor: [GrabPost:bg], [GrabPost:panel]...

let debugEnabled = false;

if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local
    .get("settings")
    .then((r) => {
      debugEnabled = !!r.settings?.debugLogs;
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) debugEnabled = !!changes.settings.newValue?.debugLogs;
  });
}

export function isDebugEnabled() {
  return debugEnabled;
}

export function createLogger(scope) {
  const prefix = `[GrabPost:${scope}]`;
  return {
    debug: (...args) => {
      if (debugEnabled) console.log(prefix, ...args);
    },
    info: (...args) => {
      if (debugEnabled) console.info(prefix, ...args);
    },
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}
