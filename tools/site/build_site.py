#!/usr/bin/env python3
"""GrabPost tanıtım sitesi (GitHub Pages, docs/ klasörü) üreticisi.

Kullanım:  python3 tools/site/build_site.py
Girdi:     tools/site/strings/<dil>.json  (15 dil, anahtarlar en.json ile aynı)
           locales.js                     (sayfadaki demo düğmesinin metinleri eklentinin kendisinden)
Çıktı:     docs/index.html, docs/<slug>/index.html, docs/privacy/, docs/404.html, sitemap.xml, robots.txt

Ekran görüntüleri (docs/assets/img/*_<slug>.webp) ve OG görselleri ayrı üretilir
(tools/site/README.md içinde anlatılıyor); bu betik sadece HTML yazar.
"""
import html, json, pathlib, re, subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
STR = pathlib.Path(__file__).resolve().parent / "strings"
BASE = "https://segelferd.github.io/grabpost/"
RELEASES = "https://github.com/segelferd/grabpost/releases/latest"
REPO = "https://github.com/segelferd/grabpost"
BMC = "https://buymeacoffee.com/segelferd"

# eklenti dil kodu -> (adres klasörü, html lang, yön)
LANGS = [
    ("en", "", "en", "ltr"), ("tr", "tr", "tr", "ltr"), ("de", "de", "de", "ltr"), ("fr", "fr", "fr", "ltr"),
    ("es", "es", "es", "ltr"), ("pt_br", "pt-br", "pt-BR", "ltr"), ("it", "it", "it", "ltr"), ("ru", "ru", "ru", "ltr"),
    ("cs", "cs", "cs", "ltr"), ("ar", "ar", "ar", "rtl"), ("hi", "hi", "hi", "ltr"), ("id", "id", "id", "ltr"),
    ("ja", "ja", "ja", "ltr"), ("ko", "ko", "ko", "ltr"), ("zh_cn", "zh-cn", "zh-CN", "ltr"),
]

ext = json.loads(subprocess.check_output(["node", "-e", """
import(process.argv[1]).then(m => { const o = { names: m.LANGUAGE_NAMES, btn: {} };
  for (const l of m.SUPPORTED_LANGUAGES) { const L = m.LOCALES[l]; o.btn[l] = { idle: L.inPageIdle.replace(/^⬇\\s*/, ''), loading: L.inPageLoading, done: L.inPageDone }; }
  console.log(JSON.stringify(o)); })""", "file://" + str(ROOT / "locales.js")]).decode())

EN = json.loads((STR / "en.json").read_text(encoding="utf-8"))
E = html.escape

ICON = {
    "chrome": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/><path d="M12 8.5h9M8.97 13.75 4.5 6M15.03 13.75 10.5 21.5" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    "firefox": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 9c1-3 4-4 6-3-2 0-3 1-3 2 2-1 5 0 6 2 1 3-1 6-4 6s-5-2-5-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    "github": '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>',
    "folder": '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6c.66 0 1.3.26 1.77.73L12.6 6.5h5.9A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z"/></svg>',
    "replay": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "up": '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 3l6 7h-4v7H8v-7H4z"/></svg>',
    "cm": '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 4h14v9H8l-4 3v-3H3z"/></svg>',
    "dl": '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 17h12"/></svg>',
}
TILE_IC = [
    '<path d="M4 7h11v10H4zM15 10l5-3v10l-5-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6l2.5 2.5h6.9A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="2"/>',
    '<rect x="4" y="4" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>',
    '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    '<circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9v4l3 2M9 2h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" fill="none" stroke="currentColor" stroke-width="2"/>',
]
DEMO_PICS = [
    ("scene4", "itookapicture", "ITAP of the dunes right before sunset"),
    ("scene3", "EarthPorn", "Moonrise above the Dolomites [OC]"),
    ("scene2", "wallpaper", "Green hills after the rain, 3840x2160"),
    ("scene5", "EarthPorn", "Morning fog in the valley, Norway [OC]"),
]


def rel(depth):
    return "../" * depth


def header(L, slug_here, depth, page=""):
    items = []
    for code, slug, hl, _ in LANGS:
        href = rel(depth) + (slug + "/" if slug else "") + page
        cur = ' aria-current="true"' if code == L["_code"] else ""
        items.append(f'<li><a href="{href or "./"}" hreflang="{hl}" lang="{hl}"{cur}>{E(ext["names"][code])}</a></li>')
    home = rel(depth) + (slug_here + "/" if slug_here else "")
    return (f'<div class="wrap"><header class="top"><a class="brand" href="{home or "./"}"><img src="{rel(depth)}assets/img/icon48.png" alt="" width="30" height="30">GrabPost</a>'
            f'<details class="langs"><summary aria-label="{E(L["lang_label"])}">{E(ext["names"][L["_code"]])}</summary><ul>{"".join(items)}</ul></details></header></div>')


def footer(L, depth):
    return (f'<footer><div class="wrap"><nav><a href="{rel(depth)}privacy/">{E(L["privacy_link"])}</a>'
            f'<a href="{REPO}/blob/main/CHANGELOG.md" rel="noopener">{E(L["changelog_link"])}</a>'
            f'<a href="{REPO}" rel="noopener">{E(L["source_link"])}</a><a href="{BMC}" rel="noopener">Buy Me a Coffee</a></nav>'
            f'<p>{E(L["disclaimer"])}</p></div></footer>')


def head(L, hl, dirn, depth, url, title, desc, og):
    alts = "".join(f'<link rel="alternate" hreflang="{h}" href="{BASE}{s + "/" if s else ""}">' for _, s, h, _ in LANGS)
    return f"""<!doctype html>
<html lang="{hl}" dir="{dirn}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{E(title)}</title>
<meta name="description" content="{E(desc)}">
<link rel="canonical" href="{url}">
{alts}<link rel="alternate" hreflang="x-default" href="{BASE}">
<meta property="og:type" content="website">
<meta property="og:title" content="{E(title)}">
<meta property="og:description" content="{E(desc)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{BASE}assets/img/{og}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0e1113">
<link rel="icon" type="image/png" href="{rel(depth)}favicon.png">
<link rel="stylesheet" href="{rel(depth)}assets/site.css">
<script>document.documentElement.className+=" js"</script>
</head>
<body>
<a class="skip" href="#main">{E(L["skip"])}</a>
"""


def stores(L, cls=""):
    return (f'<div class="stores {cls}"><a class="store primary" href="{RELEASES}" rel="noopener">{ICON["chrome"]}<span>{E(L["cta_main"])}</span></a>'
            f'<a class="store" href="{RELEASES}" rel="noopener">{ICON["firefox"]}<span>{E(L["cta_ff"])}</span></a></div>')


def index_page(L, code, slug, hl, dirn):
    depth = 1 if slug else 0
    r = rel(depth)
    url = BASE + (slug + "/" if slug else "")
    b = ext["btn"][code]
    img = lambda name, alt, w, h, panel=False: (f'<div class="shot{" panel" if panel else ""} reveal"><img src="{r}assets/img/{name}_{slug or "en"}.webp" alt="{E(alt)}" width="{w}" height="{h}" loading="lazy"></div>')
    tiles = "".join(f'<div class="tile"><div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">{TILE_IC[i]}</svg></div><h3>{E(L[f"g{i+1}_h"])}</h3><p>{E(L[f"g{i+1}_p"])}</p></div>' for i in range(6))
    tiles = re.sub(r"\{(subreddit|user|date|title)\}", r"<code>{\1}</code>", tiles)
    faq = "".join(f'<details><summary>{E(L[f"q{i}"])}</summary><p>{E(L[f"a{i}"])}</p></details>' for i in range(1, 6))
    faq_ld = json.dumps({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": L[f"q{i}"], "acceptedAnswer": {"@type": "Answer", "text": L[f"a{i}"]}} for i in range(1, 6)]}, ensure_ascii=False)
    app_ld = json.dumps({"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "GrabPost", "applicationCategory": "BrowserApplication", "operatingSystem": "Chrome, Edge, Brave, Opera", "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"}, "description": L["desc"], "url": url, "inLanguage": hl}, ensure_ascii=False)
    demo_data = json.dumps({"idle": b["idle"], "loading": b["loading"], "done": b["done"], "folder": "Downloads/Reddit Downloads/",
                            "pics": [{"src": f"{r}assets/img/{p}.webp", "s": s, "t": t} for p, s, t in DEMO_PICS]}, ensure_ascii=False)
    first = DEMO_PICS[0]
    out = head(L, hl, dirn, depth, url, L["title"], L["desc"], f"og_{slug or 'en'}.png")
    out += header(L, slug, depth)
    out += f"""<main id="main">
<div class="wrap hero">
<div><h1>{E(L["h1"])}</h1><p class="lead">{E(L["lead"])}</p>{stores(L)}<p class="soon">{E(L["cta_note"])}</p></div>
<div class="demo" dir="ltr"><div class="rpost"><div class="hd"><span class="sav">r/</span><b>r/{first[1]}</b><span>•</span><span>6h</span></div>
<div class="ttl">{E(first[2])}</div><div class="pic"><img src="{r}assets/img/{first[0]}.webp" alt="" width="1200" height="760"></div>
<div class="rrow"><span class="pill">{ICON["up"]}4.8k</span><span class="pill">{ICON["cm"]}212</span><button class="gp" type="button">{ICON["dl"]}<span class="lbl">{E(b["idle"])}</span><i class="bar"></i></button></div></div>
<div class="demo-foot"><div class="folder">{ICON["folder"]}<span>Downloads/Reddit Downloads/{first[1]}</span><b class="count">0</b></div><button class="replay" type="button" aria-label="{E(L["replay"])}">{ICON["replay"]}{E(L["replay"])}</button></div>
<p class="hint" dir="{dirn}">{E(L["demo_hint"])}</p></div>
</div>
<section class="feature wrap"><div><h2>{E(L["f1_h"])}</h2><p>{E(L["f1_p"])}</p></div>
{img("post", L["alt_post"], 1440, 1122)}</section>
<section class="feature wrap"><div><h2>{E(L["f2_h"])}</h2><p>{E(L["f2_p"])}</p></div>
{img("bulk", L["alt_bulk"], 800, 1520, True)}</section>
<section class="feature wrap"><div><h2>{E(L["f3_h"])}</h2><p>{E(L["f3_p"])}</p></div>
{img("follow", L["alt_follow"], 800, 1520, True)}</section>
<section class="feature wrap"><div><h2>{E(L["f4_h"])}</h2><p>{E(L["f4_p"])}</p></div>
{img("history", L["alt_history"], 800, 1520, True)}</section>
<section class="section wrap"><h2>{E(L["grid_h"])}</h2><div class="grid">{tiles}</div></section>
<section class="section wrap"><h2>{E(L["privacy_h"])}</h2><ul class="privacy"><li>{E(L["p1"])}</li><li>{E(L["p2"])}</li><li>{E(L["p3"])}</li><li>{E(L["p4"])}</li></ul></section>
<section class="section wrap" id="install"><h2>{E(L["install_h"])}</h2><p class="sub">{E(L["install_sub"])}</p>
<ol class="steps"><li>{L["s1"]}</li><li>{L["s2"]}</li><li>{L["s3"]}</li><li>{L["s4"]}</li></ol>
<p class="note">{E(L["update_note"])}</p><p class="note">{E(L["ff_note"])}</p></section>
<section class="section wrap faq"><h2>{E(L["faq_h"])}</h2>{faq}</section>
<section class="install wrap"><h2>{E(L["install_again"])}</h2>{stores(L)}<p class="soon">{E(L["cta_note"])}</p></section>
</main>
<script type="application/ld+json">{app_ld}</script>
<script type="application/ld+json">{faq_ld}</script>
<script id="demo-data" type="application/json">{demo_data}</script>
<script src="{r}assets/site.js" defer></script>
{footer(L, depth)}
</body>
</html>
"""
    return out


def privacy_page():
    L = dict(EN, _code="en")
    body = (ROOT / "tools/site/privacy.html").read_text(encoding="utf-8")
    out = head(L, "en", "ltr", 1, BASE + "privacy/", "GrabPost privacy policy", "What GrabPost stores, what it sends and where. Short answer: nothing leaves your browser except requests to Reddit and its media hosts.", "og_en.png")
    out += header(L, "", 1, "privacy/") + f'<main id="main" class="wrap legal">{body}</main>' + footer(L, 1) + "\n</body>\n</html>\n"
    return out


def notfound_page():
    L = dict(EN, _code="en")
    out = head(L, "en", "ltr", 0, BASE, "GrabPost", L["desc"], "og_en.png")
    # 404 sayfası her adreste açılabildiği için mutlak yollar
    out = out.replace('href="favicon.png"', f'href="{BASE}favicon.png"').replace('href="assets/site.css"', f'href="{BASE}assets/site.css"')
    out += (f'<main id="main" class="wrap nf"><h1>{E(L["notfound_h"])}</h1><p>{E(L["notfound_p"])}</p>'
            f'<div class="stores" style="justify-content:center"><a class="store primary" href="{BASE}">{E(L["notfound_back"])}</a></div></main></body></html>\n')
    return out


def main():
    urls = []
    for code, slug, hl, dirn in LANGS:
        p = STR / f"{code}.json"
        L = json.loads(p.read_text(encoding="utf-8"))
        missing = [k for k in EN if k not in L]
        if missing:
            raise SystemExit(f"{code}: eksik anahtarlar {missing}")
        for k, v in L.items():
            if "—" in v:
                raise SystemExit(f"{code}.{k}: uzun tire")
        L["_code"] = code
        d = DOCS / slug if slug else DOCS
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(index_page(L, code, slug, hl, dirn), encoding="utf-8")
        urls.append(BASE + (slug + "/" if slug else ""))
    (DOCS / "privacy").mkdir(exist_ok=True)
    (DOCS / "privacy/index.html").write_text(privacy_page(), encoding="utf-8")
    (DOCS / "404.html").write_text(notfound_page(), encoding="utf-8")
    urls.append(BASE + "privacy/")
    (DOCS / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"  <url><loc>{u}</loc></url>\n" for u in urls) + "</urlset>\n", encoding="utf-8")
    (DOCS / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {BASE}sitemap.xml\n", encoding="utf-8")
    (DOCS / ".nojekyll").write_text("", encoding="utf-8")
    print("site hazır:", len(LANGS), "dil +", "gizlilik, 404, sitemap")


if __name__ == "__main__":
    main()
