#!/usr/bin/env python3
"""The already-visible latest reply must remain above the composer when IME opens."""
import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
args = parser.parse_args()
reply = json.loads((args.directory / 'before-reply.json').read_text())
rows = []
for label in ('before-focus', 'record-initial'):
    nodes = list(ET.parse(args.directory / (label + '.xml')).iter('node'))
    field = [n for n in nodes if n.get('class') == 'android.widget.EditText'][-1]
    field_box = list(map(int, re.findall(r'\d+', field.get('bounds'))))
    matches = [n for n in nodes if n.get('text') == reply['text']]
    box = list(map(int, re.findall(r'\d+', matches[-1].get('bounds')))) if matches else []
    visible = len(box) == 4 and box[3] > box[1] > 0 and box[3] <= field_box[1]
    rows.append({'phase': label, 'visible': visible, 'bounds': box,
                 'composer_gap': field_box[1] - box[3] if visible else None})
passed = all(row['visible'] for row in rows)
if passed:
    passed = abs(rows[0]['composer_gap'] - rows[1]['composer_gap']) <= 3
result = {'passed': passed, 'previous_reply_id': reply['id'], 'states': rows}
(args.directory / 'focus-anchor-verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
raise SystemExit(0 if passed else 1)
