#!/usr/bin/env bash
# release-data.sh: put the tallies on the fixed GitHub release `data`, where
# the Data page's download buttons point.
#
#   data/trials.csv, data/campaign-2.csv  ->  releases/download/data/<file>
#
# One release, re-cut in place: created once, then every run replaces its
# assets (--clobber) and rewrites its notes with the commit the files came
# from. The download URLs never change, so a link shared today keeps working
# after the next campaign lands. Releases have no bandwidth cap; a CSV served
# by Netlify counts against the team's.
#
# Safe during a campaign: it runs no local git. gh is told the repo by name
# and reads absolute paths. It refuses a file whose bytes are not on origin
# main, by comparing each file's git blob sha (computed here, in node) with
# what the GitHub contents API reports for the same path, so the release can
# never carry a tally that is not in the repo. Push first, then release.
#
# The list mirrors CAMPAIGNS in site/src/lib/data.ts, on purpose: never
# data/*.csv, so a scratch file under data/ cannot become a public download.
# When a campaign adds a file there, add it here; site/scripts/check-assets.mjs
# fails the build until the release carries every file the page links.

set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
GH_REPO=centricle/priors
TAG=data
FILES=(trials.csv campaign-2.csv)

blob_sha() {
  node -e '
    const { readFileSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    const bytes = readFileSync(process.argv[1]);
    process.stdout.write(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"));
  ' "$1"
}

echo "release-data: checking ${#FILES[@]} files against origin main"
rows=
for f in "${FILES[@]}"; do
  path=$REPO/data/$f
  [ -f "$path" ] || { echo "release-data: $path is missing" >&2; exit 1; }
  local_sha=$(blob_sha "$path")
  remote_sha=$(gh api "repos/$GH_REPO/contents/data/$f" --jq .sha 2>/dev/null || true)
  if [ -z "$remote_sha" ]; then
    echo "release-data: data/$f is not on origin main; push it first" >&2
    exit 1
  fi
  if [ "$local_sha" != "$remote_sha" ]; then
    echo "release-data: data/$f differs from origin main (local $local_sha, remote $remote_sha); commit and push it first" >&2
    exit 1
  fi
  bytes=$(stat -f %z "$path" 2>/dev/null || stat -c %s "$path")
  rows+="| \`data/$f\` | \`$local_sha\` | $bytes |"$'\n'
  echo "  data/$f  blob $local_sha  $bytes bytes  ok"
done

head_sha=$(gh api "repos/$GH_REPO/commits/HEAD" --jq .sha)
notes="The tallies, one row per counted trial, as committed at ${GH_REPO}@${head_sha:0:12} ($(date -u +%Y-%m-%d)). Columns: https://centricle.com/curios/priors/data/

| file | git blob | bytes |
|---|---|---|
${rows}
Re-cut in place by \`bin/release-data.sh\`; the download URLs never change."

if gh release view "$TAG" -R "$GH_REPO" >/dev/null 2>&1; then
  echo "release-data: release $TAG exists; replacing its assets"
else
  echo "release-data: creating release $TAG"
  # Not the repository's "latest": that badge belongs to a versioned release,
  # if the repo ever cuts one.
  gh release create "$TAG" -R "$GH_REPO" --title "Data" --notes "$notes" --latest=false
fi

for f in "${FILES[@]}"; do
  gh release upload "$TAG" "$REPO/data/$f" --clobber -R "$GH_REPO"
done
gh release edit "$TAG" -R "$GH_REPO" --notes "$notes" >/dev/null

echo "release-data: verifying downloads"
for f in "${FILES[@]}"; do
  url=https://github.com/$GH_REPO/releases/download/$TAG/$f
  code=$(curl -sIL -o /dev/null -w '%{http_code}' "$url")
  echo "  $url  $code"
  [ "$code" = 200 ] || { echo "release-data: expected 200" >&2; exit 1; }
done
echo "release-data: done; notes name ${head_sha:0:12}"
