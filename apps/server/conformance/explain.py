"""Prints why each module of an exported plan failed, warned or stalled: the failing conditions with their messages,
and for the browser (WebRunner) the URL it was on. Reads the zips run-test-plan.py --export-dir writes."""
import json
import sys
import zipfile
from pathlib import Path

KEEP = ('msg', 'error', 'error_description', 'url', 'current_url', 'page_source', 'expected', 'actual', 'requirements')


def entries(doc):
    if isinstance(doc, list):
        return doc
    for key in ('results', 'logs', 'log'):
        if isinstance(doc.get(key), list):
            return doc[key]
    return []


for z in sorted(Path(sys.argv[1]).glob('*.zip')):
    with zipfile.ZipFile(z) as zf:
        for name in zf.namelist():
            if not name.endswith('.json'):
                continue
            try:
                doc = json.loads(zf.read(name))
            except ValueError:
                continue
            info = doc.get('testInfo', {}) if isinstance(doc, dict) else {}
            rows = entries(doc)
            bad = [e for e in rows if isinstance(e, dict) and (e.get('result') in ('FAILURE', 'WARNING') or e.get('src') == 'WebRunner')]
            if not bad and info.get('status') == 'FINISHED':
                continue
            print(f"== {info.get('testName', name)} {info.get('status', '')} {info.get('result', '')}")
            for e in bad[:12]:
                print('  -', e.get('src'), e.get('result', ''), {k: str(e[k])[:600] for k in KEEP if k in e})
            if info.get('status') not in (None, 'FINISHED'):
                for e in rows[-6:]:
                    if isinstance(e, dict):
                        print('  ~', e.get('src'), str(e.get('msg', ''))[:300])
