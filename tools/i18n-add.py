#!/usr/bin/env python3
"""Çeviri ekleme: tools/i18n/*.json dosyalarındaki { anahtar: { dil: metin } } kayıtlarını
locales.js içindeki LOCALES_EXTRA bloğuna işler. Eksik dil varsa hata verir.
Kullanım: python3 tools/i18n-add.py tools/i18n/v1.49.1.json"""
import json, re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
p = root / "locales.js"
s = p.read_text(encoding="utf-8")
langs = json.loads(re.search(r"export const SUPPORTED_LANGUAGES = (\[[^\]]*\]);", s).group(1))
m = re.search(r"(const LOCALES_EXTRA = )(\{.*?\n\});\nfor \(const lang", s, re.S)
extra = json.loads(m.group(2))
for f in sys.argv[1:]:
    data = json.loads(pathlib.Path(f).read_text(encoding="utf-8"))
    for key, tr in data.items():
        missing = [l for l in langs if l not in tr]
        if missing: sys.exit(f"{f}: '{key}' eksik diller: {missing}")
        for l in langs:
            if "—" in tr[l]: sys.exit(f"{f}: '{key}' {l} uzun tire içeriyor")
            extra.setdefault(l, {})[key] = tr[l]
new = m.group(1) + json.dumps(extra, ensure_ascii=False, indent=2) + ";\nfor (const lang"
s = s[: m.start()] + new + s[m.end():]
p.write_text(s, encoding="utf-8")
print("ok", sum(len(json.loads(pathlib.Path(f).read_text(encoding='utf-8'))) for f in sys.argv[1:]), "anahtar")
