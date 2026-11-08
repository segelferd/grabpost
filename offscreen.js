// offscreen.js — (sadece Chrome) offscreen document giriş noktası.
// Asıl işleme kodu src/processing.js içinde (Firefox'ta arka plan onu
// doğrudan çağırıyor). Burada sadece background'dan gelen mesajları ona
// iletiyoruz.
import { handleProcessingMessage } from "./src/processing.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const pending = handleProcessingMessage(message);
  if (!pending) return false;
  pending.then(sendResponse);
  return message?.type !== "REVOKE_BLOB_URL"; // REVOKE yanıt beklemez
});

console.log("[GrabPost:offscreen] Hazır (yerel FFmpeg dosyalarıyla), işleme mesajları bekleniyor.");
