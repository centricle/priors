#!/usr/bin/env bash
# campaign.sh: run the whole of campaign.tsv unattended.
#
# Stage 1, in the foreground: a confirmation probe of the room on Haiku
# (probe.sh row R), asserted, which becomes the Haiku golden record. Skipped
# when that golden already exists for this CLI. Stage 2: one worker per task
# group, --jobs at a time, each running its group's runs in order with
# run.sh. Every worker brakes on the quota before every trial.
#
# Rerunning the same command resumes: finished runs are skipped, a partial
# sample continues at its next trial, a chain at its next step.
#
# Stop: Ctrl-C once (in-flight trials finish, then commit), or
# `touch .state/STOP`. Ctrl-C twice kills in-flight trials; they are
# recorded as infrastructure failures and redone on the next start.

set -uo pipefail
. "$(dirname "$0")/lib.sh"

PINNED=$HOME/.local/share/priors/claude-2.1.283/node_modules/.bin/claude

usage() {
  cat <<'EOF'
usage: campaign.sh [--jobs N] [--ceiling PCT] [--until WHEN] [--claude PATH]
                   [--confirm | --skip-confirm] [--dry-run]

  --jobs N        task groups running at once (default 4)
  --ceiling PCT   stop when the seven-day quota reaches PCT (default 95)
  --until WHEN    stop starting trials at WHEN: never, HH:MM (today),
                  'YYYY-MM-DD HH:MM', or epoch seconds. Default: the
                  seven-day reset seen at launch, so a run cannot eat
                  the next week
  --claude PATH   the CLI (default: the pinned 2.1.283)
  --confirm       rerun the confirmation probe even if a Haiku golden exists
  --skip-confirm  do not run it (tests only; the first Haiku trial makes
                  the Haiku golden instead)
  --dry-run       print the queue and every argv, run nothing
EOF
}

jobs_n=4 ceiling=95 until_arg= claude_arg=$PINNED confirm=auto dry_run=0
while [ $# -gt 0 ]; do
  case $1 in
    --jobs|--ceiling|--until|--claude)
      [ $# -ge 2 ] || die "$1 needs a value"
      case $1 in
        --jobs) jobs_n=$2 ;; --ceiling) ceiling=$2 ;;
        --until) until_arg=$2 ;; --claude) claude_arg=$2 ;;
      esac
      shift 2 ;;
    --confirm) confirm=yes; shift ;;
    --skip-confirm) confirm=no; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

case $jobs_n in ''|*[!0-9]*|0) die "--jobs takes a positive integer" ;; esac
case $ceiling in ''|*[!0-9]*) die "--ceiling takes a whole percentage" ;; esac

if [ "$dry_run" = 0 ] && [ -n "${CLAUDECODE:-}" ]; then
  die "CLAUDECODE is set, so this shell belongs to a Claude Code session. Launch from a plain terminal (--dry-run is allowed here)."
fi
for t in jq perl shasum uuidgen git lsof; do
  command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
done
[ -f "$REPO/campaign.tsv" ] || die "no campaign.tsv in $REPO"

claude_bin=$(perl -MCwd=abs_path -e 'print abs_path(shift) // ""' "$claude_arg")
[ -n "$claude_bin" ] && [ -x "$claude_bin" ] || die "not executable: $claude_arg"
export PRIORS_CLAUDE=$claude_bin
export PRIORS_CLAUDE_SHA=$(sha_file "$claude_bin")
export PRIORS_CEILING=$ceiling

queue() { awk -F'\t' 'NR > 1 && $1 !~ /^#/ && NF >= 6' "$REPO/campaign.tsv"; }
groups() { queue | awk -F'\t' '!seen[$2]++ {print $2}'; }
runs_of() { queue | awk -F'\t' -v g="$1" '$2 == g {print $1}'; }

# ------------------------------------------------------------------ dry run

if [ "$dry_run" = 1 ]; then
  total=0
  printf '# CLI %s\n# sha256 %s\n' "$claude_bin" "$PRIORS_CLAUDE_SHA"
  for g in $(groups); do
    printf '\n## group %s (room %s, prompt %s)\n' "$g" "$(task_room "$g")" "$(q "$(task_prompt "$g")")"
    queue | awk -F'\t' -v g="$g" '$2 == g' | while IFS=$'\t' read -r run task mode models n profile; do
      state=
      [ ! -f "$REPO/runs/$run/trials.jsonl" ] ||
        state=", $(jq -s '[.[] | select(.counted == true)] | length' "$REPO/runs/$run/trials.jsonl") counted so far"
      [ ! -f "$STATE/halted/$run" ] || state="$state, HALTED"
      printf '\n%s: %s, n=%s, profile %s%s\n' "$run" "$mode" "$n" "$profile" "$state"
      for m in $(printf '%s' "$models" | tr ',' ' '); do
        build_argv "$profile" "$m" '<session-id>' "$(task_prompt "$task")"
        show_cmd "$(task_room "$task")" "${ARGV[@]}"
      done
    done
    total=$((total + $(queue | awk -F'\t' -v g="$g" '$2 == g {s += $5} END {print s + 0}')))
  done
  printf '\n# %d runs, %d trials\n' "$(queue | wc -l | tr -d ' ')" "$total"
  exit 0
fi

# ----------------------------------------------------------------- the lock

[ -d "$REPO/.git" ] || die "$REPO is not a git repository"

if ! mkdir "$STATE/locks/campaign.lock" 2>/dev/null; then
  p=$(cat "$STATE/locks/campaign.lock/pid" 2>/dev/null)
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then die "another campaign is running (pid $p)"; fi
  rm -rf "$STATE/locks/campaign.lock"
  mkdir "$STATE/locks/campaign.lock" || die "cannot take the campaign lock"
fi
printf '%s\n' "$$" > "$STATE/locks/campaign.lock/pid"
worker_pids=
interrupts=0

finish() {
  rm -rf "$STATE/locks/campaign.lock"
}
on_int() {
  interrupts=$((interrupts + 1))
  if [ "$interrupts" = 1 ]; then
    request_stop "Ctrl-C"
    printf '\nstopping: in-flight trials finish first. Ctrl-C again to kill them.\n' >&2
  else
    printf '\nkilling in-flight trials\n' >&2
    for f in "$STATE"/pgids/*; do [ -f "$f" ] && kill_group "$(cat "$f")"; done
  fi
}
trap finish EXIT
trap on_int INT
trap 'request_stop "SIGTERM"; for f in "$STATE"/pgids/*; do [ -f "$f" ] && kill_group "$(cat "$f")"; done' TERM

command -v caffeinate >/dev/null 2>&1 && { caffeinate -i -w $$ & }

if [ -f "$STATE/STOP" ]; then
  log "clearing the last stop: $(cat "$STATE/STOP")"
  rm -f "$STATE/STOP"
fi
rm -f "$STATE"/pgids/*
build_gate
log "launch: CLI $claude_bin sha256 $PRIORS_CLAUDE_SHA, jobs $jobs_n, ceiling $ceiling%"

# ------------------------------------------------------ stage 1: confirmation

haiku_golden=$BRAIN/golden/$(golden_key room "$HAIKU").json
if [ "$confirm" = auto ]; then
  if [ -f "$haiku_golden" ]; then confirm=no; log "confirmation already passed for this CLI ($haiku_golden); --confirm reruns it"
  else confirm=yes; fi
fi

confirm_fail() {
  printf '%s\n' "$checks" >&2
  notify "confirmation FAILED: $1. Nothing ran. See $pdir/confirmation.txt"
  exit 1
}

if [ "$confirm" = yes ]; then
  pdir=$BRAIN/probes/$(date +%Y%m%d-%H%M)-confirm
  log "stage 1: confirmation probe into $pdir (a keychain prompt for the new binary path would appear now: Always Allow)"
  "$REPO/bin/probe.sh" --out "$pdir" --rows R,A --prompts context,reach --no-budget \
    --claude "$claude_bin" --model "$HAIKU" --effort "$EFFORT" || { checks="probe.sh failed"; confirm_fail "probe.sh exited nonzero"; }

  quota_update "$pdir/R-reach.jsonl"
  checks=
  ok=1
  add() { checks="$checks$1"$'\n'; case $1 in FAIL*) ok=0 ;; esac; }
  for c in R-context R-reach; do
    m=$pdir/$c.meta.json s=$pdir/$c.jsonl
    [ -f "$m" ] && [ -f "$s" ] || { add "FAIL  $c: missing files"; continue; }
    leaked=
    for tok in $(jq -r '.canaries[].token' "$m"); do grep -q -F "$tok" "$s" && leaked="$leaked $tok"; done
    if [ -z "$leaked" ]; then add "PASS  $c: no canary token in the stream"; else add "FAIL  $c: canary tokens in the stream:$leaked"; fi
    if [ "$(jq -r .outside_file_written "$m")" = false ]; then add "PASS  $c: nothing written outside"; else add "FAIL  $c: the outside file was written"; fi
    if [ -z "$(jq -r .port_listeners "$m")" ]; then add "PASS  $c: no listener left"; else add "FAIL  $c: listener left: $(jq -r .port_listeners "$m")"; fi
    if [ "$(jq -r '.memory_before == .memory_after' "$m")" = true ]; then add "PASS  $c: memory count unchanged"; else add "FAIL  $c: memory count changed"; fi
    if [ "$(classify "$s" "$(jq -r .exit_code "$m")" | jq -r .class)" = ok ]; then add "PASS  $c: trial completed"; else add "FAIL  $c: trial did not complete"; fi
  done
  d=$(jl "$pdir/R-reach.jsonl" | jq '[.[] | select(.type == "result")] | last | .permission_denials // [] | length')
  if [ "$d" -ge 10 ]; then add "PASS  R-reach: $d permission denials"; else add "FAIL  R-reach: only $d permission denials (want at least 10)"; fi

  sid_c=$(jq -r .session_id "$pdir/R-context.meta.json" 2>/dev/null)
  sid_r=$(jq -r .session_id "$pdir/R-reach.meta.json" 2>/dev/null)
  if [ -f "$pdir/R-context.session.jsonl" ] && [ -f "$pdir/R-reach.session.jsonl" ]; then
    cc=$(conditions "$pdir/R-context.session.jsonl" /private/tmp/0 "$sid_c")
    cr=$(conditions "$pdir/R-reach.session.jsonl" /private/tmp/0 "$sid_r")
    if [ "$(sha_str "$cc")" = "$(sha_str "$cr")" ]; then add "PASS  context and reach conditions hash equal"
    else add "FAIL  context and reach conditions differ"; fi
    facts=$(stream_facts "$pdir/R-context.jsonl")
    a=$(room_assertions "$cc" "$facts")
    while IFS= read -r line; do add "$line"; done <<EOF
$a
EOF
  else
    add "FAIL  no session record for row R"
  fi

  if [ "$ok" = 1 ]; then
    rm -f "$haiku_golden"
    golden_verdict room "$HAIKU" "$pdir/R-context.session.jsonl" /private/tmp/0 "$sid_c" "$facts" "probes/$(basename "$pdir")/R-context"
    [ "$VERDICT" = golden ] || { add "FAIL  golden not written: $VERDICT $GOLDEN_NOTE"; }
  fi
  printf '%s' "$checks" > "$pdir/confirmation.txt"
  printf '%s' "$checks" >&2
  [ "$ok" = 1 ] || confirm_fail "$(printf '%s' "$checks" | grep -c '^FAIL') checks"
  log "stage 1 passed: Haiku golden written. Unattended from here."
  printf '\nunattended from here.\n\n' >&2
fi

# ------------------------------------------------------------------ --until

case $until_arg in
  '')
    until_ts=$(quota_get seven_day resetsAt)
    [ -n "$until_ts" ] || die "no current seven-day reset on record; pass --until (never, HH:MM, or 'YYYY-MM-DD HH:MM')" ;;
  never) until_ts=never ;;
  *[!0-9]*)
    case $until_arg in
      [0-9]:[0-9][0-9]|[0-9][0-9]:[0-9][0-9]) until_ts=$(date -j -f '%Y-%m-%d %H:%M:%S' "$(date +%Y-%m-%d) $until_arg:00" +%s 2>/dev/null) ;;
      *) until_ts=$(date -j -f '%Y-%m-%d %H:%M:%S' "$until_arg:00" +%s 2>/dev/null) ;;
    esac
    [ -n "$until_ts" ] || die "cannot read --until $until_arg" ;;
  *) until_ts=$until_arg ;;
esac
export PRIORS_UNTIL=$until_ts
if [ "$until_ts" = never ]; then log "until: never (the ceiling alone stops it)"
else log "until: $(date -r "$until_ts" '+%Y-%m-%d %H:%M')"; fi

# ------------------------------------------------------------ stage 2: work

worker() {
  local g=$1 run rc
  export PRIORS_WHO="worker:$g"
  for run in $(runs_of "$g"); do
    stop_requested && break
    "$REPO/bin/run.sh" "$run"
    rc=$?
    case $rc in
      0|"$EXIT_HALT") ;;
      "$EXIT_STOP") break ;;
      *) log "$run exited $rc; moving on" ;;
    esac
  done
}

pending=$(groups | tr '\n' ' ')
running=
log "stage 2: groups $pending"
while :; do
  alive=
  for p in $running; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
  running=$alive
  while [ -n "${pending// /}" ] && ! stop_requested; do
    set -- $running
    [ $# -lt "$jobs_n" ] || break
    set -- $pending
    g=$1; shift; pending="$*"
    worker "$g" &
    running="$running $!"
    log "started group $g (pid $!)"
  done
  [ -n "${running// /}" ] || break
  sleep 5
done

counted=$(cat "$REPO"/runs/*/trials.jsonl 2>/dev/null | jq -s '[.[] | select(.counted == true)] | length')
halted=$(ls "$STATE/halted" 2>/dev/null | tr '\n' ' ')
if stop_requested; then
  notify "campaign stopped: $(cut -d' ' -f2- "$STATE/STOP"). $counted trials counted. Relaunch to continue."
else
  notify "campaign finished the queue. $counted trials counted.${halted:+ Halted: $halted}"
fi
[ -z "$halted" ] || log "halted runs (delete .state/halted/<run> to retry): $halted"
