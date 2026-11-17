#!/usr/bin/env python3
"""Compare Redmi menu ROI in every original video frame to its first frame.
Presence is checked separately in screenshots/XML; this measures movement, not UI semantics.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('video', type=Path)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.parent.mkdir(parents=True, exist_ok=True)
stats = args.output.with_suffix('.stats.txt').resolve()
# 1440px Redmi menu [85,220][142,312], mapped to its native 720px recording.
filters = ("[0:v]crop=30:46:42:110,lut=y='if(lt(val,128),0,255)',split[roi][source];"
           '[source]trim=end_frame=1,loop=loop=-1:size=1:start=0,setpts=N/30/TB[reference];'
           '[roi][reference]blend=all_mode=difference:shortest=1,signalstats,'
           'metadata=print:file=' + str(stats))
process = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(args.video),
                '-filter_complex', filters, '-fps_mode', 'passthrough', '-enc_time_base', '1:1000000',
                '-f', 'null', '-'], capture_output=True, timeout=45)
assert process.returncode == 0, process.stderr.decode()
frames = []
for block in re.split(r'(?m)(?=^frame:)', stats.read_text()):
    timestamp = re.search(r'pts_time:([\d.]+)', block)
    difference = re.search(r'lavfi.signalstats.YAVG=([\d.]+)', block)
    if timestamp and difference:
        frames.append({'pts': float(timestamp.group(1)), 'difference': float(difference.group(1))})
assert frames, 'No original frames measured'
probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
    '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', str(args.video)], text=True))
count = int(probe['streams'][0]['nb_read_frames'])
assert len(frames) == count, 'Comparison must retain every original frame without resampling'
# Allow <=32 dark-edge pixels in the 1380px ROI for codec/subpixel variation;
# an actual vertical menu translation or disappearance exceeds this bound.
threshold = 6.0
violations = [frame for frame in frames if frame['difference'] > threshold]
result = {'roi_stable': not violations, 'presence_requires_visual_review': True,
          'source_frames': count, 'measured_frames': len(frames),
          'max_luma_difference': max(frame['difference'] for frame in frames),
          'threshold': threshold, 'violations': violations, 'frames': frames}
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: value for key, value in result.items() if key not in ('frames', 'violations')}, ensure_ascii=False))
raise SystemExit(0 if result['roi_stable'] else 1)
