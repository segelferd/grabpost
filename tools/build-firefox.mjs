// build-firefox.mjs — Chrome kaynak kodundan Firefox paketini üretir.
//
// Kullanım (tools klasöründe):  npm install  &&  npm run firefox
// Çıktı: ../../grabpost-firefox/  (klasör)  ve  ../../outputs/grabpost-firefox-vX.Y.Z.zip
//
// Kaynak kod TEK: platform farkları çalışma anında algılanıyor (IS_FIREFOX).
// Bu betik sadece şunları yapar:
//   1) Arka plan modüllerini esbuild ile tek dosyaya paketler (Firefox'ta
//      ES modül arka plan desteğine güvenmemek için klasik betik).
//   2) manifest.json'u Firefox'a uyarlar: service_worker -> scripts,
//      side_panel -> sidebar_action, Chrome'a özel izinler çıkarılır,
//      gecko kimliği ve veri toplama beyanı ("none") eklenir.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");
const OUT = path.resolve(SRC, "..", "grabpost-firefox");
const ZIP_DIR = path.resolve(SRC, "..", "outputs");

const EXCLUDE = new Set([".git", "tools", "keys", "node_modules", "docs", ".DS_Store", ".gitignore"]);

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true, filter: (p) => !EXCLUDE.has(path.basename(p)) });

// 1) Arka planı tek klasik betiğe paketle
await build({
  entryPoints: [path.join(SRC, "src/background.js")],
  outfile: path.join(OUT, "src/background.bundle.js"),
  bundle: true,
  format: "iife",
  target: ["firefox128"],
  charset: "utf8",
  legalComments: "none",
  logLevel: "warning",
});

// 2) Manifest
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
// Chrome geliştirme kimliği anahtarı Firefox'ta anlamsız, çıkar
delete manifest.key;
manifest.background = { scripts: ["src/background.bundle.js"] };
manifest.permissions = manifest.permissions.filter((p) => !["offscreen", "sidePanel"].includes(p));
delete manifest.side_panel;
manifest.sidebar_action = {
  default_panel: "sidepanel.html",
  default_title: "GrabPost",
  default_icon: { 16: "icons/16.png", 32: "icons/32.png" },
  open_at_install: false,
};
manifest.commands = {
  ...(manifest.commands || {}),
  _execute_sidebar_action: { suggested_key: { default: "Alt+Shift+G" }, description: "Open GrabPost sidebar" },
};
manifest.browser_specific_settings = {
  gecko: {
    id: "grabpost@segelferd",
    strict_min_version: "128.0",
    data_collection_permissions: { required: ["none"] },
  },
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 3));

// Paketlenmiş arka planın modül kaynağı Firefox'ta kullanılmıyor (tek dosya bundle var).
// Diğer src/ modülleri kalıyor: yan panel ve içerik betiği onları doğrudan yüklüyor.
fs.rmSync(path.join(OUT, "src/background.js"), { force: true });
// Firefox'ta offscreen belgesi kullanılmıyor (işleme arka planda); offscreen
// dosyaları zararsız, sadece Chrome'da yükleniyorlar.

fs.mkdirSync(ZIP_DIR, { recursive: true });
const zipPath = path.join(ZIP_DIR, `grabpost-firefox-v${manifest.version}.zip`);
fs.rmSync(zipPath, { force: true });
// Firefox paketi: manifest.json ZIP'in KÖKÜNDE olmalı (klasörsüz).
execSync(`cd "${OUT}" && zip -qr "${zipPath}" . -x "*.DS_Store"`);
console.log("Firefox paketi hazır:", zipPath);
