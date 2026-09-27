#!/usr/bin/env bash
# run-tests.sh <scratch-dir>: exercise the runner against stub-claude.sh.
#
# Builds a throwaway copy of this repo (bin, tasks, test) in the scratch
# directory, with its own campaign.tsv per scenario, its own brain, rooms
# and CLAUDE_CONFIG_DIR, and runs campaign.sh with --claude pointing at the
# stub. The real claude is never invoked.

set -uo pipefail
[ $# -eq 1 ] || { echo "usage: run-tests.sh <scratch-dir>" >&2; exit 2; }
SRC=$(cd "$(dirname "$0")/.." && pwd -P)
BASE=$1
mkdir -p "$BASE"
BASE=$(cd "$BASE" && pwd -P)
STUB=$SRC/test/stub-claude.sh
F=claude-fable-5-1 O=claude-opus-5-5 S=claude-sonnet-5 H=claude-haiku-4-5-20251001
PLANT=4b1d5e2a-9c3f-4e8b-a7d6-1f0e2c3b4a59
pass=0 fail=0

ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$*"; }
no() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$*"; }
check() { local d=$1; shift; if "$@"; then ok "$d"; else no "$d"; fi; }
eq() { [ "$1" = "$2" ] || { printf '      got %s, want %s\n' "$1" "$2"; return 1; }; }

# setup <name> <tsv rows...>: a fresh repo at $T.
setup() {
  T=$BASE/$1
  shift
  rm -rf "$T"
  mkdir -p "$T/brain" "$T/rooms" "$T/config"
  cp -Rp "$SRC/bin" "$SRC/tasks" "$SRC/test" "$T/"
  printf '/.state/\n' > "$T/.gitignore"
  { printf 'run\ttask\tmode\tmodels\tn\tprofile\n'; printf '%s\n' "$@"; } > "$T/campaign.tsv"
  (cd "$T" && git init -q && git add -A && git commit -q -m "Test fixture")
}

camp() {
  (cd "$T" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$T/config" PRIORS_BRAIN="$T/brain" \
    PRIORS_ROOM_ROOT="$T/rooms" PRIORS_NOTIFY=0 PRIORS_QUIET=1 PRIORS_WATCHDOG=20 \
    PRIORS_RETRY_WAITS="1 1" PRIORS_GATE_EXTRA="$PLANT" STUB_COUNTER="$T/counter" \
    bin/campaign.sh --claude "$STUB" --skip-confirm --until never --jobs "${JOBS:-1}" "$@") >"$T/out.txt" 2>&1
}

rows() { cat "$T/runs/$1/trials.jsonl" 2>/dev/null | jq -s -r "$2"; }
commits() { (cd "$T" && git log --oneline -- "runs/$1" | wc -l | tr -d ' '); }

# ------------------------------------------------------------- sample, 3

setup sample "digit-sample-$H-low	digit	sample	$H	3	room" \
  "replica-harness-haiku-low	replica	sample	haiku	2	harness"
camp
r=digit-sample-$H-low
check "sample: 3 counted rows" eq "$(rows $r '[.[] | select(.counted)] | length')" 3
check "sample: 3 step directories" eq "$(ls -d "$T/runs/$r"/[0-9][0-9][0-9] | wc -l | tr -d ' ')" 3
check "sample: 3 transcripts" eq "$(ls "$T/runs/$r"/[0-9][0-9][0-9].jsonl | wc -l | tr -d ' ')" 3
check "sample: room gone" test ! -e "$T/rooms/$(cat "$T/tasks/digit/room")"
check "sample: 1 commit" eq "$(commits $r)" 1
check "sample: commit message" eq "$(cd "$T" && git log -1 --format=%s -- "runs/$r")" "Add 3 trials to $r"
check "sample: first is golden, rest match" eq "$(rows $r '[.[].golden] | join(",")')" "golden,match,match"
check "sample: golden written to brain" test -f "$T/brain/golden/room-$H-low-$(shasum -a 256 "$STUB" | cut -c1-12).json"
check "sample: first record archived to brain" eq "$(ls "$T/brain/records/$r" | tr '\n' ' ')" "001.session.jsonl "
check "sample: no record in the repo" eq "$(cd "$T" && git ls-files | grep -c session)" 0
check "sample: effort and argv recorded" eq "$(rows $r '[.[] | .effort + " " + (.argv_sha256 | length | tostring)] | unique | join(",")')" "low 64"
h=replica-harness-haiku-low
check "harness: 2 counted" eq "$(rows $h '[.[] | select(.counted)] | length')" 2
check "harness: transcripts in brain, not repo" eq "$(ls "$T/brain/records/$h"/*.jsonl | grep -vc session) $(ls "$T/runs/$h" | grep -c '\.jsonl$')" "2 1"
check "harness: returned model recorded" eq "$(rows $h '[.[].model_returned[0]] | unique | join(",")')" "$H"

# ------------------------------------------------ chain, 3, killed mid-step

setup chain "sentence-chain-$H-low	sentence	chain	$H	3	room"
r=sentence-chain-$H-low
(cd "$T" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$T/config" PRIORS_BRAIN="$T/brain" \
  PRIORS_ROOM_ROOT="$T/rooms" PRIORS_NOTIFY=0 PRIORS_QUIET=1 PRIORS_WATCHDOG=120 \
  STUB_COUNTER="$T/counter" STUB_MODE=first-2:slow STUB_SLEEP=60 \
  bin/campaign.sh --claude "$STUB" --skip-confirm --until never --jobs 1) >"$T/out.txt" 2>&1 &
cpid=$!
# First call is slow too (first-2), so wait for step 1 to be recorded
# only after it finishes; instead kill during call 1, then again during call 2.
for i in $(seq 1 40); do [ -e "$T/rooms/$(cat "$T/tasks/sentence/room")" ] && [ "$(cat "$T/counter" 2>/dev/null)" = 1 ] && break; sleep 0.5; done
pkill -9 -f "bin/campaign.sh --claude $STUB"; pkill -9 -f "$T/bin/run.sh"; pkill -9 -f "$STUB"; wait $cpid 2>/dev/null
check "chain: killed with no row written" eq "$(rows $r 'length')" 0
check "chain: room left behind by the kill" test -e "$T/rooms/$(cat "$T/tasks/sentence/room")"
STUB_MODE=first-2:slow STUB_SLEEP=1 camp
check "chain: 3 counted steps" eq "$(rows $r '[.[] | select(.counted) | .step] | join(",")')" "1,2,3"
check "chain: step 2 input is step 1 output" eq "$(rows $r '.[1].input_sha256 == .[0].output_sha256 and .[2].input_sha256 == .[1].output_sha256')" true
check "chain: step 1 input is the seed" eq "$(rows $r '.[0].input_sha256')" "$(perl -MFile::Find -MDigest::SHA -e 'print Digest::SHA::sha256_hex("f 0.txt " . Digest::SHA->new(256)->addfile(shift)->hexdigest), "\n"' "$T/tasks/sentence/seed/0.txt")"
check "chain: leftover room went to debris" eq "$(ls "$T/.state/debris/$r" | grep -c '^room-')" 1
check "chain: 3 commits" eq "$(commits $r)" 3
check "chain: step commit message" eq "$(cd "$T" && git log -1 --format=%s -- "runs/$r")" "Add step 003 to $r"
check "chain: step 3 holds three stub lines" eq "$(grep -c '^stub' "$T/runs/$r/003/0.txt")" 3

# -------------------------------------------------------------- relay, 5

setup relay "digit-sample-$H-low	digit	sample	$H	1	room" "sentence-chain-relay-low	sentence	chain	$F,$O,$S,$H	5	room"
camp
r=sentence-chain-relay-low
check "relay: models rotate" eq "$(rows $r '[.[].model_asked] | join(",")')" "$F,$O,$S,$H,$F"
check "relay: 5 counted, no halt" eq "$(rows $r '[.[] | select(.counted)] | length') $(ls "$T/.state/halted" | wc -l | tr -d ' ')" "5 0"
check "relay: one golden per model" eq "$(ls "$T/brain/golden" | grep -c '\.json$')" 4
check "relay: Fable matches the Haiku golden, masked" grep -q '^PASS  identical to the Haiku golden' "$T/brain/golden/room-$F-low-$(shasum -a 256 "$STUB" | cut -c1-12).checks.txt"

# ----------------------------------------------------- failures and brakes

setup noresult "digit-sample-$H-low	digit	sample	$H	2	room"
STUB_MODE=noresult camp
r=digit-sample-$H-low
check "noresult: three attempts, none counted" eq "$(rows $r '[.[] | "\(.attempt):\(.class):\(.counted)"] | join(",")')" "1:infra:no_result:false,2:infra:no_result:false,3:infra:no_result:false"
check "noresult: run halted" test -f "$T/.state/halted/$r"
check "noresult: attempts committed as rows only" eq "$(cd "$T" && git log --format=%s -- "runs/$r")" "Record failed attempts on $r"

setup watchdog "digit-sample-$H-low	digit	sample	$H	2	room"
STUB_MODE=first-1:exit142 camp
check "exit 142: infrastructure, then retried" eq "$(rows $r '[.[] | "\(.step).\(.attempt):\(.exit_code):\(.class)"] | join(",")')" "1.1:142:infra:watchdog,1.2:0:ok,2.1:0:ok"

setup quota "digit-sample-$H-low	digit	sample	$H	5	room" "word-sample-$H-low	word	sample	$H	5	room"
STUB_MODE=quota96 camp
check "quota 0.96: one trial, then stop" eq "$(rows $r '[.[] | select(.counted)] | length')" 1
check "quota 0.96: STOP says why" grep -q 'seven-day quota at 0.96' "$T/.state/STOP"
check "quota 0.96: the next run never started" test ! -e "$T/runs/word-sample-$H-low"
check "quota 0.96: committed on stop" eq "$(commits $r)" 1

setup gate "digit-sample-$H-low	digit	sample	$H	2	room"
STUB_MODE=plant STUB_PLANT=$PLANT camp
check "gate: run halted" grep -q 'gate' "$T/.state/halted/$r"
check "gate: nothing committed" eq "$(commits $r)" 0
check "gate: nothing staged" eq "$(cd "$T" && git diff --cached --name-only | wc -l | tr -d ' ')" 0

setup golden "digit-sample-$H-low	digit	sample	$H	1	room"
camp
printf 'number-sample-%s-low\tnumber\tsample\t%s\t2\troom\n' "$H" "$H" >> "$T/campaign.tsv"
STUB_MODE=sysprompt camp
check "golden: a changed system prompt halts the run" grep -q 'differ from golden' "$T/.state/halted/number-sample-$H-low"
check "golden: the odd trial is not counted" eq "$(rows number-sample-$H-low '[.[] | "\(.golden):\(.counted)"] | join(",")')" "mismatch:false"

setup golden2 "digit-sample-$H-low	digit	sample	$H	2	room"
STUB_MODE=first-1:sysprompt camp
check "golden: a later mismatch also halts" eq "$(rows $r '[.[] | "\(.golden):\(.counted)"] | join(",")')" "golden:true,mismatch:false"

# -------------------------------------------------------------- dry run

(cd "$SRC" && bin/campaign.sh --dry-run) > "$BASE/dry-run.txt" 2>&1
check "dry run: every run listed" eq "$(grep -E -c ': (sample|chain), ' "$BASE/dry-run.txt")" "$(awk 'NR > 1' "$SRC/campaign.tsv" | wc -l | tr -d ' ')"
check "dry run: 2608 trials" grep -q '# 41 runs, 2608 trials' "$BASE/dry-run.txt"
check "dry run: room argv" grep -q -- "--safe-mode --strict-mcp-config --tools Read,Write,Edit,Bash --restricted --settings" "$BASE/dry-run.txt"
check "dry run: no budget flag anywhere" eq "$(grep -c -- --max-budget-usd "$BASE/dry-run.txt")" 0

# --------------------------------------------- conditions on real records

P=$HOME/Projects/brain/projects/priors/probes/20260927-1425
if [ -d "$P" ]; then
  . "$SRC/bin/lib.sh" 2>/dev/null
  hc() { sha_str "$(conditions "$P/$1.session.jsonl" /private/tmp/0 "$(jq -r .session_id "$P/$1.meta.json")")"; }
  for row in E F G; do
    check "probe $row: context and reach hash equal" eq "$(hc $row-context)" "$(hc $row-reach)"
  done
  check "probe: rows E and F differ" test "$(hc E-context)" != "$(hc F-context)"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
