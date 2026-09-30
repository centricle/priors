#!/usr/bin/env bash
# render.sh [--force] [-j N] [run ...]: render every artifact trial with shot.sh.
#
#   runs/<run>/NNN/<file>  ->  renders/<run>/NNN.webp
#
# Artifact tasks only (circle, html, svg, replica); text tasks have nothing to
# render. Existing renders are kept unless --force. With no run names, renders
# every run that has a trials.jsonl. Writes renders/README.md with the Chrome
# build, since renders only reproduce on the same build and fonts.
#
# Measured 2026-09-28: a static page renders byte-identically every time. A page
# with CSS animation matched in 4 of 6 renders, and the others differed in
# about 0.2% of pixels (animation phase). A page flagged "nondeterministic" in
# data/trials.csv calls Math.random or the clock; a render may vary.

set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
CHROME=${PRIORS_CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
force=0 jobs=3 runs=()
while [ $# -gt 0 ]; do
  case $1 in
    --force) force=1 ;;
    -j) jobs=$2; shift ;;
    *) runs+=("$1") ;;
  esac
  shift
done
if [ ${#runs[@]} -eq 0 ]; then
  for d in "$REPO"/runs/*/trials.jsonl; do runs+=("$(basename "$(dirname "$d")")"); done
fi

list=$(mktemp "${TMPDIR:-/tmp}/priors-render.XXXXXX")
trap 'rm -f "$list"' EXIT
for run in "${runs[@]}"; do
  task=$(jq -r '.task' "$REPO/runs/$run/trials.jsonl" | head -1)
  case $task in circle|html|svg|replica) ;; *) continue ;; esac
  file=$(ls "$REPO/tasks/$task/seed")
  for room in "$REPO/runs/$run"/[0-9][0-9][0-9]; do
    [ -f "$room/$file" ] || continue
    out=$REPO/renders/$run/$(basename "$room").webp
    [ $force = 1 ] || [ ! -s "$out" ] || continue
    printf '%s\t%s\n' "$room/$file" "$out" >> "$list"
  done
done

total=$(wc -l < "$list" | tr -d ' ')
echo "rendering $total files, $jobs at a time"
# One worker per shard, each reusing a single Chrome profile. A fresh profile
# per render wrote ~9 GB to the SSD over 1120 renders and, with 6 Chromes cold
# booting at once, ran the machine into thermal throttling (2026-09-28).
profiles=$(mktemp -d "${TMPDIR:-/tmp}/priors-profiles.XXXXXX")
trap 'rm -f "$list"; rm -rf "$profiles"' EXIT
for w in $(seq 0 $((jobs - 1))); do
  awk -F'\t' -v w="$w" -v n="$jobs" '(NR - 1) % n == w' "$list" |
    while IFS=$'\t' read -r in out; do
      PRIORS_PROFILE=$profiles/$w "$REPO/bin/shot.sh" "$in" "$out" || echo "FAILED $in" >&2
    done &
done
wait

mkdir -p "$REPO/renders"
cat > "$REPO/renders/README.md" <<EOF
# renders

One WebP per artifact trial, \`renders/<run>/NNN.webp\`, made by
\`bin/render.sh\` with \`bin/shot.sh\`: headless Chrome, offline, an 800x800
viewport, prefers-color-scheme pinned to light, 2000 ms of virtual time, then
\`cwebp -q 80\`.

- Chrome: $("$CHROME" --version 2>/dev/null | tr -s ' ' | sed 's/ $//')
- Rendered: $(date -u +%Y-%m-%d)

Renders only reproduce on the same Chrome build and fonts. Static pages render
byte-identically. Animated pages can differ from one render to the next
(animation phase). Pages flagged \`nondeterministic\` in \`data/trials.csv\`
call Math.random or the clock; a render may vary.

\`pilot-import/\` holds fresh renders of the pilot's outputs, runs 23-26
included. They are not the pilot's original window captures, which were grabs of
a real desktop and are not published.
EOF
echo "done: $(find "$REPO/renders" -name '*.webp' | wc -l | tr -d ' ') renders, $(du -sh "$REPO/renders" | cut -f1)"
