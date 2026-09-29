#!/bin/sh
# shot.sh <in.html|in.svg> <out.webp>: render one trial output, offline, to WebP.
#
# Headless Chrome at a fixed 800x800 viewport with no network (every host
# resolves to NOTFOUND). --virtual-time-budget runs the page's clock for a
# fixed 2000 ms of virtual time before the capture, so CSS animations are
# caught at the same phase every time. Outputs that call Math.random or read
# the clock (tally.mjs flags them "nondeterministic") still differ run to run.
#
# prefers-color-scheme is pinned to light (preferredColorScheme=1). Unpinned,
# headless Chrome follows the OS appearance, so a dark-mode Mac renders every
# page that has a dark variant dark.
#
# Renders are only reproducible on the same Chrome build and fonts: note the
# version (`--version` of the binary below) with any published set.
#
# Adapted from a clean-room screenshot helper. Chrome writes the PNG within
# about a second and then sometimes never exits, so it runs in the background:
# wait for the file to appear and stop growing, then stop Chrome. alarm
# survives exec and is the hard cap at 45 s.
set -eu
CHROME=${PRIORS_CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
[ $# -eq 2 ] || { echo "usage: shot.sh <in> <out.webp>" >&2; exit 2; }
IN=$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")
OUT=$2
test -f "$IN" || { echo "no such file: $IN" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/priors-shot.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
png=$tmp/shot.png

perl -e 'alarm 45; exec @ARGV' "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --no-first-run --no-default-browser-check --disable-extensions --mute-audio \
  --user-data-dir="$tmp/profile" --host-resolver-rules="MAP * ~NOTFOUND" \
  --blink-settings=preferredColorScheme=1 --window-size=800,800 --virtual-time-budget=2000 --screenshot="$png" "file://$IN" >/dev/null 2>&1 &
PID=$!
i=0
while [ $i -lt 440 ]; do
  if [ -s "$png" ]; then
    S1=$(stat -f%z "$png"); sleep 0.3; S2=$(stat -f%z "$png")
    [ "$S1" = "$S2" ] && break
  fi
  kill -0 $PID 2>/dev/null || break
  sleep 0.1; i=$((i+1))
done
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
test -s "$png" || { echo "no render: $IN" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
cwebp -quiet -q 80 -m 6 "$png" -o "$OUT"
