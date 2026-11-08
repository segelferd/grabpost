#!/usr/bin/env python3
"""Ekran görüntülerini (PNG) siteye WebP olarak koyar. Kullanım: convert_images.py <png klasörü>"""
import sys, pathlib
from PIL import Image
src = pathlib.Path(sys.argv[1]); out = pathlib.Path(__file__).resolve().parents[2] / "docs/assets/img"
slug = {"pt_br": "pt-br", "zh_cn": "zh-cn"}
for p in sorted(src.glob("*.png")):
    kind, lang = p.stem.split("_", 1)
    im = Image.open(p).convert("RGB")
    if kind == "post" and im.width > 1440: im = im.resize((1440, round(im.height * 1440 / im.width)), Image.LANCZOS)
    im.save(out / f"{kind}_{slug.get(lang, lang)}.webp", "WEBP", quality=82, method=6)
print("ok")
