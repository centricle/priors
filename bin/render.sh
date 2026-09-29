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
# about 0.2% of pixels (animation phase). Pages flagged "nondeterministic" in
# data/trials.csv differ by design.

set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
CHROME=${PRIORS_CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
force=0 jobs=6 runs=()
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
# shellcheck disable=SC2016
tr '\t' '\n' < "$list" | xargs -n 2 -P "$jobs" sh -c '"$0" "$1" "$2" || echo "FAILED $1" >&2' "$REPO/bin/shot.sh"

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
byte-identically. Animated pages can differ by a fraction of a percent of pixels
(animation phase), and pages flagged \`nondeterministic\` in
\`data/trials.csv\` (Math.random or the clock) differ on every load.

\`pilot-import/\` holds fresh renders of the pilot's outputs, runs 23-26
included. They are not the pilot's original window captures, which were grabs of
a real desktop and are not published.
EOF
echo "done: $(find "$REPO/renders" -name '*.webp' | wc -l | tr -d ' ') renders, $(du -sh "$REPO/renders" | cut -f1)"
