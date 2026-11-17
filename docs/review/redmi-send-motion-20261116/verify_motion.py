#!/usr/bin/env python3
"""Check captured send snapshots; video review remains required for transitions between samples."""
import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
args = parser.parse_args()
labels = ['record-initial', 'record-after-send-0', 'record-after-send-1',
          'record-expanded', 'record-after-send-2', 'record-after-send-3', 'record-after-ime']
labels.insert(-1, 'before-ime-close')
rows = []
failures = []
state_path = args.directory / 'real-send-state.json'
state = json.loads(state_path.read_text()) if state_path.exists() else {}
if state.get('expectedSubagentCard') is not False or state.get('openTicketIds') != []:
    failures.append('missing isolated direct-chat context: no open or explicitly viewed task')
message = state.get('message', {})
reply = state.get('reply') or {}
if reply.get('to_msg') != message.get('id') or not reply.get('text'):
    failures.append('missing actual reply associated with the captured send')
if not any(str(decision.get('threadKey', '')).endswith(':' + str(message.get('id')))
           and 'answeredDirectly' in decision.get('reasonCodes', [])
           for decision in state.get('recentDecisions', [])):
    failures.append('captured request has no answeredDirectly decision')
for label in labels:
    path = args.directory / (label + '.xml')
    if not path.exists():
        if label not in ('record-expanded', 'before-ime-close'):
            failures.append(label + ': missing snapshot')
        continue
    nodes = list(ET.parse(path).iter('node'))
    texts = [node.get('text', '') for node in nodes]
    header = next((node.get('bounds', '') for node in nodes if node.get('text') == '☰'), '')
    numbers = list(map(int, re.findall(r'\d+', header)))
    header_visible = len(numbers) == 4 and numbers[2] > numbers[0] and numbers[3] > numbers[1]
    shell = any(text == '子代理' or '个子代理' in text for text in texts)
    loading = [text for text in texts if '读着' in text]
    composer = next((node for node in nodes if node.get('class') == 'android.widget.EditText'), None)
    composer_box = list(map(int, re.findall(r'\d+', composer.get('bounds', '')))) if composer is not None else []
    replies = [node for node in nodes if node.get('text') == reply.get('text')]
    reply_box = list(map(int, re.findall(r'\d+', replies[-1].get('bounds', '')))) if replies else []
    gap = composer_box[1] - reply_box[3] if len(composer_box) == len(reply_box) == 4 else None
    rows.append({'snapshot': label, 'header': header, 'header_visible': header_visible,
                 'subagent_card': shell, 'loading_rows': loading,
                 'composer_height': composer_box[3] - composer_box[1] if len(composer_box) == 4 else None,
                 'reply_composer_gap': gap})
    if not header_visible:
        failures.append(label + ': header outside visible window')
    if shell:
        failures.append(label + ': direct chat exposes an unrelated subagent card')
    if loading:
        failures.append(label + ': loading text inserted into the message list')
visible_headers = {row['header'] for row in rows if row['header_visible']}
if len(visible_headers) > 1:
    failures.append('header moves while keyboard/content state changes')
heights = {row['composer_height'] for row in rows}
if None in heights or len(heights) != 1:
    failures.append('short-text composer height changes between capture states')
late_labels = {'record-after-send-2', 'record-after-send-3', 'before-ime-close', 'record-after-ime'}
gaps = [row['reply_composer_gap'] for row in rows
        if row['snapshot'] in late_labels and row['reply_composer_gap'] is not None]
if len(gaps) < 2:
    failures.append('not enough snapshots of the actual reply to compare its composer gap')
elif min(gaps) < 0 or max(gaps) - min(gaps) > 3:
    failures.append('reply-to-composer gap changes after response/keyboard settles')
result = {'passed': not failures, 'visual_frame_review_required': True,
          'failures': failures, 'snapshots': rows}
(args.directory / 'motion-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
sys.exit(0 if result['passed'] else 1)
