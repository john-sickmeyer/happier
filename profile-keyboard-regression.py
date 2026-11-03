#!/usr/bin/env python3
"""Measure a focused Android profile field against the real IME surface.

Requires a logged-in disposable Happier development client. Navigate to a new
profile, put Add Variable near the bottom of the viewport, and run this script.
Unlike hierarchy-only visibility checks, this detects an IME covering the text caret. The keyboard controller
promises caret visibility; the native EditText also includes background padding.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--adb', default='adb')
parser.add_argument('--serial', default='emulator-5556')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--tap-add', action='store_true')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)

def adb(*command):
    return subprocess.check_output([args.adb, '-s', args.serial, *command])

def layout():
    adb('shell', 'uiautomator', 'dump', '/sdcard/happier89-regression.xml')
    return adb('exec-out', 'cat', '/sdcard/happier89-regression.xml')

def bounds(node):
    return list(map(int, re.findall(r'\d+', node.get('bounds', ''))))

if args.tap_add:
    nodes = list(ET.fromstring(layout()).iter('node'))
    trigger = next(n for n in nodes if n.get('resource-id') == 'profile-environment-add')
    x1, y1, x2, y2 = bounds(trigger)
    (args.output / 'before.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
    time.sleep(2)

raw = layout()
window = adb('shell', 'dumpsys', 'window').decode()
ime = re.search(r'type=ime frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\][^\n]* visible=true', window)
assert ime, 'Test setup: the IME must be visible'
focused = next((n for n in ET.fromstring(raw).iter('node')
                if n.get('focused') == 'true' and n.get('class') == 'android.widget.EditText'), None)
assert focused is not None, 'Test setup: a native EditText must have focus'
assert focused.get('resource-id') == 'profile-environment-add-name', 'Test setup: focus the new variable Name field'
field = bounds(focused)
ime_top = int(ime[2])
# A fully covered field cannot have a visible caret (the recorded RED case).
field_intersects_viewport = field[1] < ime_top and field[3] > 0
method = adb('shell', 'dumpsys', 'input_method').decode()
cursor = next((line for line in method.splitlines()
               if 'appMonitorInfo:' in line
               and f"fingerprint={focused.get('package')}/" in line
               and 'mInsertionMarkerTop=' in line), '')
assert cursor, 'Test setup: Gboard must publish the active CursorAnchorInfo'
def number(name):
    match = re.search(name + r'=(-?[\d.]+)', cursor)
    assert match, f'Test setup: missing {name}'
    return float(match[1])
matrix = re.search(r'mMatrix=\[([^]]+)\]', cursor)
assert matrix, 'Test setup: missing cursor transformation'
m = [float(v) for v in matrix[1].split(',')]
x = number('mInsertionMarkerHorizontal')
caret_top = m[3]*x + m[4]*number('mInsertionMarkerTop') + m[5]
caret_bottom = m[3]*x + m[4]*number('mInsertionMarkerBottom') + m[5]
assert field[1] <= caret_top <= caret_bottom <= field[3], 'Test setup: stale caret does not belong to the focused field'
result = {'focused_test_id': focused.get('resource-id'), 'field_bounds': field,
          'ime_top': ime_top, 'caret_top': caret_top, 'caret_bottom': caret_bottom,
          'caret_clearance_px': ime_top-caret_bottom,
          'field_fully_above_keyboard': field[3] <= ime_top,
          'pass': field_intersects_viewport and caret_top >= 0 and caret_bottom <= ime_top}
(args.output / 'focused.png').write_bytes(adb('exec-out', 'screencap', '-p'))
(args.output / 'geometry.json').write_text(json.dumps(result, indent=2)+'\n')
(args.output / 'hierarchy.xml').write_bytes(raw)
print(json.dumps(result))
assert result['pass'], f"Focused Name caret bottom {caret_bottom} is covered by IME starting at {ime_top}"
