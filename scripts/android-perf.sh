#!/usr/bin/env bash
# Scripted jank measurement for the Android shell.
#
#   scripts/android-perf.sh <label>
#
# Cold-starts the app, resets the frame stats, then performs the same fixed
# choreography every time (scroll the dashboard, open Spending, scroll it, go
# back, scroll again). Repeating the identical script is what makes the numbers
# comparable; the emulator's software renderer inflates all of them.
set -u

ADB=${ADB:-/d/android-sdk/platform-tools/adb.exe}
PKG=com.family.planner
LABEL=${1:-run}

$ADB shell am force-stop $PKG
$ADB shell am start -n $PKG/.MainActivity >/dev/null
sleep 8
$ADB shell dumpsys gfxinfo $PKG reset >/dev/null

# dashboard scroll
for i in 1 2 3; do $ADB shell input swipe 540 1800 540 700 250; sleep 0.4; done
for i in 1 2; do $ADB shell input swipe 540 700 540 1800 250; sleep 0.4; done
# Spending tab, then scroll the list
$ADB shell input tap 330 2245; sleep 1.5
for i in 1 2 3; do $ADB shell input swipe 540 1900 540 800 250; sleep 0.4; done
# back to the dashboard
$ADB shell input tap 120 2245; sleep 1.5
for i in 1 2; do $ADB shell input swipe 540 1800 540 800 250; sleep 0.4; done
sleep 1

OUT=".tmp/gfx-$LABEL.txt"
mkdir -p .tmp
# The dump is ~10k lines; keep it in the workspace so it can be inspected.
$ADB shell dumpsys gfxinfo $PKG > "$OUT"
python - "$OUT" "$LABEL" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
def grab(pattern, default='n/a'):
    m = re.search(pattern, text)
    return m.group(1) if m else default
total = grab(r'Total frames rendered:\s*(\d+)')
janky = grab(r'Janky frames:\s*(\d+)')
pct = grab(r'Janky frames \(([\d.]+)%\)')
p50 = grab(r'50th percentile:\s*(\d+)ms')
p90 = grab(r'90th percentile:\s*(\d+)ms')
p95 = grab(r'95th percentile:\s*(\d+)ms')
p99 = grab(r'99th percentile:\s*(\d+)ms')
print(f"{sys.argv[2]}: frames={total} janky={janky} ({pct}%) p50={p50} p90={p90} p95={p95} p99={p99}")
PY
