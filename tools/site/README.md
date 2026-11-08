# Website generator (docs/)

The site at https://segelferd.github.io/grabpost/ is plain static HTML in `docs/`, served by GitHub Pages (Settings → Pages → branch `main`, folder `/docs`).

- `strings/<lang>.json`: page text, one file per extension language (15). Keys must match `en.json`; long dashes are rejected.
- `privacy.html`: body of the privacy page (English).
- `og.html`: template for the 1200x630 share images (`docs/assets/img/og_<slug>.png`).
- `build_site.py`: writes `docs/index.html`, `docs/<slug>/index.html`, `docs/privacy/`, `docs/404.html`, `sitemap.xml`, `robots.txt`. The demo button texts come from `locales.js`, so they always match the extension.
- `convert_images.py <folder>`: turns PNG screenshots named `<kind>_<lang>.png` (kind: post, bulk, follow, history) into `docs/assets/img/<kind>_<slug>.webp`.

After changing texts: `python3 tools/site/build_site.py`.
Screenshots are taken from the real extension in each language with a Playwright script against a local fake Reddit; they only need redoing when the panel changes visibly.
