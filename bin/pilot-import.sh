#!/usr/bin/env bash
# pilot-import.sh: flatten the Haiku pilot into runs/pilot-import/, shaped
# like a campaign run, so that tally.mjs reads it like any other run.
#
# The pilot (2026-09-25) predates the runner: a shell loop in a git repo,
# one commit per run, the model's stdout as the commit message. Its history
# survives as a git bundle in the private archive (archive/pilot/), and its
# per-session facts as sessions.tsv beside the private session records. This
# reads both and writes:
#
#   runs/pilot-import/NNN/f7b3.html   that run's output (the file it edited)
#   runs/pilot-import/trials.jsonl    one row per run, mode "pilot"
#
# Rows use the campaign's columns. What the pilot never recorded (argv, CLI
# hash, tokens, turns, rate limits, conditions) is null, not guessed.
#
# Idempotent: it refuses to overwrite an existing import unless --force.

set -uo pipefail
. "$(dirname "$0")/lib.sh"

BUNDLE=${PRIORS_PILOT_BUNDLE:-$REPO/archive/pilot/pilot.bundle}
SESSIONS=${PRIORS_PILOT_SESSIONS:-$BRAIN/pilot/sessions.tsv}
OUT=$REPO/runs/pilot-import
SEED_COMMIT=34d1261

# The loop reset f7b3.html to the seed only after a successful screencapture
# (`... && screencapture ... && git checkout 34d1261 -- f7b3.html`). Runs 23
# to 26 have no capture, so the runs after them (24 to 27) started from the
# previous run's output instead of the seed.
NO_RESET_AFTER=" 23 24 25 26 "

[ "${1:-}" = --force ] && rm -rf "$OUT"
[ ! -e "$OUT" ] || die "$OUT exists; pass --force to rebuild it"
[ -f "$BUNDLE" ] || die "no bundle at $BUNDLE"
[ -f "$SESSIONS" ] || die "no sessions.tsv at $SESSIONS"
git bundle verify -q "$BUNDLE" 2>/dev/null || die "bundle does not verify: $BUNDLE"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/pilot-import.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
git clone -q "$BUNDLE" "$tmp/pilot" || die "cannot clone $BUNDLE"
P=$tmp/pilot

# The pilot's seed must be the replica task's seed, byte for byte.
[ "$(git -C "$P" rev-parse "$SEED_COMMIT:f7b3.html")" = \
  "$(git hash-object "$REPO/tasks/replica/seed/f7b3.html")" ] ||
  die "pilot seed differs from tasks/replica/seed/f7b3.html"

mkdir -p "$OUT"
commits=$(git -C "$P" rev-list --reverse HEAD | tail -n +2)
[ "$(printf '%s\n' "$commits" | wc -l | tr -d ' ')" = 32 ] || die "expected 32 run commits"

prev_out=
step=0
for h in $commits; do
  step=$((step + 1))
  nnn=$(printf '%03d' "$step")
  short=$(git -C "$P" rev-parse --short=7 "$h")

  # Input room: the seed, or the previous output when the reset was skipped.
  mkdir "$tmp/in"
  if [ -n "$prev_out" ] && [ "${NO_RESET_AFTER#* $((step - 1)) }" != "$NO_RESET_AFTER" ]; then
    cp -p "$prev_out/f7b3.html" "$tmp/in/"
  else
    git -C "$P" show "$SEED_COMMIT:f7b3.html" > "$tmp/in/f7b3.html"
  fi
  input_sha=$(tree_sha "$tmp/in")
  rm -rf "$tmp/in"

  mkdir "$OUT/$nnn"
  git -C "$P" show "$h:f7b3.html" > "$OUT/$nnn/f7b3.html"
  output_sha=$(tree_sha "$OUT/$nnn")
  prev_out=$OUT/$nnn

  line=$(awk -F'\t' -v c="$short" '$5 == c' "$SESSIONS")
  [ -n "$line" ] || die "no sessions.tsv row for commit $short"
  IFS=$'\t' read -r label sid start end _ _ cost dur tools _ <<EOF
$line
EOF
  [ "$label" = "run-$(printf '%02d' "$step")" ] || die "commit $short is $label, expected run $step"

  git -C "$P" log -1 --format=%B "$h" | jq -R -s -c \
    --arg run pilot-import --argjson step "$step" --arg sid "$sid" \
    --arg start "${start%.*}Z" --arg end "${end%.*}Z" \
    --argjson wall "$dur" --argjson cost "$cost" --arg tools "$tools" \
    --arg input_sha "$input_sha" --arg output_sha "$output_sha" \
    --arg note "pilot commit $short; run by a shell loop, not campaign.sh" \
    '{run: $run, task: "replica", mode: "pilot", step: $step, attempt: 1,
      model_asked: "haiku", model_returned: ["claude-haiku-4-5-20251001"],
      effort: "low", profile: "harness",
      cli_version: "2.1.283", cli_sha256: null, argv_sha256: null, session_id: $sid,
      started_utc: $start, ended_utc: $end, wall_s: $wall, exit_code: 0,
      class: "ok", counted: true, truncated: false,
      subtype: null, is_error: null, stop_reason: null,
      api_error_status: null, turns: null, cost_usd: $cost,
      tokens: null, denials: null, thinking_blocks: null,
      tool_calls: ($tools | split(",") | map(split("×") | {(.[0]): (.[1] | tonumber)}) | add),
      result: (sub("\n+$"; "")),
      input_sha256: $input_sha, output_sha256: $output_sha, rate_limit: null,
      conditions_sha256: null, golden: null, golden_note: $note, halt: null}' \
    >> "$OUT/trials.jsonl"
done

echo "imported $step runs into $OUT"
