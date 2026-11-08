#!/usr/bin/env python3
"""Store images for Chrome Web Store and Firefox AMO.

Builds, from the site texts (tools/site/strings) and the real panel screenshots (docs/assets/img):
  out/chrome/<lang>/1..5.png   1280x800 (Chrome screenshots, one set per language)
  out/amo/1..5.png             2400x1500 (AMO screenshots, English)
  out/promo_small_440x280.png, out/promo_marquee_1400x560.png, out/store_icon_128.png
Usage: python3 tools/store/build_store_images.py [out_dir]
"""
import json, sys, shutil, html
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
IMG = ROOT / "docs/assets/img"
CSS_FONTS = ROOT / "docs/assets/fonts"
STR = ROOT / "tools/site/strings"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "store-assets"
LANGS = {"en": "en", "tr": "tr", "de": "de", "fr": "fr", "es": "es", "pt_br": "pt-br", "it": "it", "ru": "ru",
         "cs": "cs", "ar": "ar", "hi": "hi", "id": "id", "ja": "ja", "ko": "ko", "zh_cn": "zh-cn"}
HTML_LANG = {"pt-br": "pt-BR", "zh-cn": "zh-CN"}

BASE_CSS = """
@font-face{font-family:Geist;src:url(FONTS/geist-latin.woff2) format('woff2');font-weight:100 900}
@font-face{font-family:Geist;src:url(FONTS/geist-latin-ext.woff2) format('woff2');font-weight:100 900}
*{box-sizing:border-box}
html,body{margin:0;width:1280px;height:800px;overflow:hidden;color:#f2f4f5;
 font-family:Geist,'Noto Sans',system-ui,sans-serif;
 background:radial-gradient(80% 110% at 88% 0%,#3d1b0b 0%,#15191c 52%,#0e1113 100%)}
:lang(ja) body{font-family:Geist,'Noto Sans CJK JP',sans-serif}
:lang(ko) body{font-family:Geist,'Noto Sans CJK KR',sans-serif}
:lang(zh-CN) body{font-family:Geist,'Noto Sans CJK SC',sans-serif}
:lang(hi) body{font-family:Geist,'Noto Sans Devanagari',sans-serif}
:lang(ar) body{font-family:'Noto Sans Arabic','Noto Sans',sans-serif}
.s{display:grid;grid-template-columns:500px 1fr;gap:56px;align-items:center;height:800px;padding:0 72px}
.b{display:flex;align-items:center;gap:12px;font-weight:700;font-size:24px;margin-bottom:34px;color:#fff}
.b img{width:40px;height:40px}
h1{font-size:50px;line-height:1.08;letter-spacing:-.03em;margin:0 0 24px;font-weight:780}
p{font-size:22px;line-height:1.5;color:#b9c2c7;margin:0}
:lang(ja) h1,:lang(ko) h1,:lang(zh-CN) h1,:lang(hi) h1,:lang(ar) h1{letter-spacing:0;line-height:1.3;font-size:44px}
:lang(ja) h1,:lang(ja) p,:lang(ja) .card b{word-break:auto-phrase}
:lang(ja) p,:lang(ko) p,:lang(zh-CN) p,:lang(hi) p,:lang(ar) p{line-height:1.75;font-size:21px}
.bar{width:64px;height:6px;border-radius:3px;background:#ff4500;margin-bottom:26px}
.shot{display:flex;justify-content:center;align-items:center;height:800px}
.shot img{display:block;border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}
.panel img{height:690px}
.post img{height:690px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.card{background:#1b2125;border:1px solid #2a3237;border-radius:16px;padding:22px 22px 20px}
.card .i{width:38px;height:38px;border-radius:10px;background:rgba(255,69,0,.16);color:#ff6a2b;display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:12px}
.card b{display:block;font-size:20px;margin-bottom:6px;color:#fff}
.card span{font-size:16px;line-height:1.45;color:#aab3b8}
:lang(ja) .card span,:lang(ko) .card span,:lang(zh-CN) .card span,:lang(hi) .card span,:lang(ar) .card span{line-height:1.65}
"""

def page(lang, body, css=""):
    hl = HTML_LANG.get(lang, lang)
    d = ' dir="rtl"' if lang == "ar" else ""
    return (f'<!doctype html><html lang="{hl}"{d}><head><meta charset="utf-8"><style>'
            + BASE_CSS.replace("FONTS", CSS_FONTS.as_uri()) + css + "</style></head><body>" + body + "</body></html>")

def brand():
    return f'<div class="b"><img src="{(IMG/"icon128.png").as_uri()}">GrabPost</div>'

def feature(lang, s, h, p, img, kind):
    e = html.escape
    left = f'<div>{brand()}<div class="bar"></div><h1>{e(s[h])}</h1><p>{e(s[p])}</p></div>'
    right = f'<div class="shot {kind}"><img src="{(IMG/img).as_uri()}"></div>'
    return page(lang, f'<div class="s">{left}{right}</div>')

ICONS = ["🔊", "📁", "🧬", "⬇", "⏳", "🌍"]

def details(lang, s):
    e = html.escape
    cards = "".join(f'<div class="card"><div class="i">{ICONS[i-1]}</div><b>{e(s[f"g{i}_h"])}</b><span>{e(s[f"g{i}_p"])}</span></div>' for i in range(1, 7))
    left = f'<div>{brand()}<div class="bar"></div><h1>{e(s["grid_h"])}</h1><p>{e(s["privacy_h"])}</p><p style="margin-top:12px;color:#ff8a5c">{e(s["p1"])}</p></div>'
    return page(lang, f'<div class="s" style="grid-template-columns:420px 1fr">{left}<div class="grid">{cards}</div></div>')

def slides(lang, slug, s):
    return [
        feature(lang, s, "f1_h", "f1_p", f"post_{slug}.webp", "post"),
        feature(lang, s, "f2_h", "f2_p", f"bulk_{slug}.webp", "panel"),
        feature(lang, s, "f3_h", "f3_p", f"follow_{slug}.webp", "panel"),
        feature(lang, s, "f4_h", "f4_p", f"history_{slug}.webp", "panel"),
        details(lang, s),
    ]

PROMO_CSS = """html,body{width:W;height:H}
.p{display:flex;align-items:center;height:100%;padding:0 PADpx;gap:GAPpx}
.p .t b{display:block;font-size:FSpx;font-weight:780;letter-spacing:-.03em;line-height:1.05}
.p .t span{display:block;color:#b9c2c7;font-size:SSpx;margin-top:10px;line-height:1.3}
.p img.ic{width:ICpx;height:ICpx}
.p .pill{display:inline-block;background:#ff4500;color:#fff;font-weight:650;border-radius:999px;padding:8px 18px;font-size:PLpx;margin-top:16px}
"""

def promo(w, h, pad, gap, fs, ss, ic, pl, title, sub, shot=None):
    css = PROMO_CSS
    for k, v in {"W": f"{w}px", "H": f"{h}px", "PAD": pad, "GAP": gap, "FS": fs, "SS": ss, "IC": ic, "PL": pl}.items():
        css = css.replace(k, str(v))
    extra = ""
    if shot:
        css += ".p{position:relative}.p .sh{position:absolute;right:80px;top:50px;height:460px;border-radius:18px;transform:rotate(-3deg);box-shadow:0 30px 80px rgba(0,0,0,.55)}.p .sh2{right:370px;top:110px;height:400px;transform:rotate(2deg)}"
        extra = "".join(f'<img class="sh {c}" src="{(IMG/f).as_uri()}">' for f, c in shot)
    body = (f'<div class="p"><img class="ic" src="{(IMG/"icon128.png").as_uri()}"><div class="t"><b>{title}</b>'
            f'<span>{sub}</span><div class="pill">Chrome · Edge · Firefox</div></div>{extra}</div>')
    return page("en", body, css)

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "_html"; tmp.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        def shoot(markup, path, w, h, scale=1):
            f = tmp / (path.stem + "_" + path.parent.name + ".html"); f.write_text(markup, encoding="utf-8")
            ctx = br.new_context(viewport={"width": w, "height": h}, device_scale_factor=scale)
            pg = ctx.new_page(); pg.goto(f.as_uri()); pg.wait_for_timeout(250)
            path.parent.mkdir(parents=True, exist_ok=True)
            pg.screenshot(path=str(path)); ctx.close()
        for lang, slug in LANGS.items():
            s = json.loads((STR / f"{lang}.json").read_text(encoding="utf-8"))
            hl = slug if slug in ("pt-br", "zh-cn") else lang
            for i, m in enumerate(slides(hl, slug, s), 1):
                shoot(m, OUT / "chrome" / lang / f"{i}.png", 1280, 800)
                if lang == "en":
                    shoot(m, OUT / "amo" / f"{i}.png", 1280, 800, scale=1.875)
            print("ok", lang)
        shoot(promo(440, 280, 30, 20, 40, 17, 84, 14, "GrabPost", "Download from Reddit<br>in one click"), OUT / "promo_small_440x280.png", 440, 280)
        shoot(promo(1400, 560, 90, 34, 72, 26, 128, 20, "GrabPost", "Reddit images, videos with sound<br>and galleries in one click",
                    shot=[("bulk_en.webp", ""), ("follow_en.webp", "sh2")]), OUT / "promo_marquee_1400x560.png", 1400, 560)
        br.close()
    shutil.copy(IMG / "icon128.png", OUT / "store_icon_128.png")
    shutil.rmtree(tmp)

if __name__ == "__main__":
    main()
