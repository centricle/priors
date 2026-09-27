#!/usr/bin/env bash
# run.sh <run>: one run of the campaign, a sample or a chain, resumable.
#
# runs/<run>/trials.jsonl is the source of truth: one row per attempt. On
# start, the next step is the one after the last counted step, so a rerun
# continues where the last one stopped. Normally started by campaign.sh,
# which sets PRIORS_CLAUDE and PRIORS_CLAUDE_SHA.
#
# Exit: 0 done, 3 halted (needs a human; .state/halted/<run> says why),
# 4 stopped (the campaign is stopping; rerun to continue), 5 capped (a model
# is at the ceiling on a window of its own; .state/capped/<run> says which,
# and a relaunch after that window resets continues the run).

set -uo pipefail
. "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "usage: run.sh <run>"
run=$1
row=$(campaign_row "$run")
[ -n "$row" ] || die "no run named $run in campaign.tsv"
IFS=$'\t' read -r _ task mode models n profile <<EOF
$row
EOF
IFS=, read -r -a model_list <<EOF
$models
EOF
[ -n "${PRIORS_CLAUDE:-}" ] && [ -n "${PRIORS_CLAUDE_SHA:-}" ] ||
  die "PRIORS_CLAUDE and PRIORS_CLAUDE_SHA are unset; start runs with campaign.sh"
[ -f "$STATE/gate.txt" ] || die "no $STATE/gate.txt; start runs with campaign.sh"

export PRIORS_WHO=$run
dir=$REPO/runs/$run
trials=$dir/trials.jsonl
room=$(task_room "$task")
prompt=$(task_prompt "$task")
records=$BRAIN/records/$run

if [ -f "$STATE/halted/$run" ]; then
  log "skipped: halted earlier ($(cat "$STATE/halted/$run")). Delete .state/halted/$run to retry."
  exit $EXIT_HALT
fi
rm -f "$STATE/capped/$run"
mkdir -p "$dir" "$records" "$STATE/debris/$run"
touch "$trials"

on_signal() {
  local p
  p=$(cat "$STATE/pgids/$PRIORS_WHO" 2>/dev/null)
  [ -z "$p" ] || kill_group "$p"
  log "killed by signal mid-trial; the next start redoes that step"
  exit 143
}
trap on_signal TERM INT

# ---------------------------------------------------------------- helpers

# Counted steps so far: "<last step> <any truncated>".
progress() {
  jq -s -r '[.[] | select(.counted == true)] | "\((map(.step) | max) // 0) \(any(.[]; .truncated == true))"' "$trials"
}

# The model a response returned for this model on this run's first counted
# trial, or nothing.
first_returned() {
  jq -s -r --arg m "$1" '[.[] | select(.counted == true and .model_asked == $m and (.model_returned | length) > 0)] | first | .model_returned[0] // empty' "$trials"
}

commit_pending() {
  if ! commit_run "$run" "$mode" "${1:-}"; then
    halt "$GATE_NOTE (unstaged; nothing committed)" nocommit
  fi
}

halt() {
  printf '%s %s\n' "$(iso)" "$1" > "$STATE/halted/$run"
  notify "$run halted: $1"
  [ "${2:-}" = nocommit ] || commit_run "$run" "$mode" "${3:-}" || log "commit on halt tripped the gate: $GATE_NOTE"
  exit $EXIT_HALT
}

stopping() {
  log "stopping at step $1: $(cat "$STATE/STOP" 2>/dev/null)"
  [ "$mode" = chain ] || commit_pending
  exit $EXIT_STOP
}

# The brake found $model at the ceiling on its own window (BRAKE_CAP). Only
# this run stops; the worker moves on to its next run.
capped() {
  set -- "$1" $BRAKE_CAP
  local why="$model at the ceiling: $2 at $3, resets $(date -r "$4" '+%Y-%m-%d %H:%M')"
  printf '%s step %s: %s\n' "$(iso)" "$1" "$why" > "$STATE/capped/$run"
  log "skipping at step $1: $why"
  notify "$run skipped: $why"
  [ "$mode" = chain ] || commit_pending
  exit $EXIT_CAPPED
}

# A room or step directory that is in the way goes to debris, never rm.
to_debris() {
  local what=$1 name=$2
  [ -e "$what" ] || [ -L "$what" ] || return 0
  mv "$what" "$STATE/debris/$run/$name-$(date +%Y%m%d-%H%M%S)-$$"
  log "moved $what to debris"
}

# -------------------------------------------------------------- one trial

# trial <step> <attempt> <model>: sets T_COUNTED (true/false), T_CLASS,
# T_HALT (a reason, or empty) and appends one row to trials.jsonl.
trial() {
  local step=$1 attempt=$2 model=$3 nnn sid src input_sha out err started ended
  local cls facts rec argvsha verdict note output_sha dest stream_dest first ret keep
  nnn=$(printf '%03d' "$step")
  sid=$(uuidgen | tr '[:upper:]' '[:lower:]')
  T_HALT=

  to_debris "$room" "room"
  to_debris "$dir/$nnn" "$nnn-stale"
  mkdir "$room" || { T_HALT="cannot create $room"; T_COUNTED=false; T_CLASS=none; return; }

  if [ "$mode" = chain ] && [ "$step" -gt 1 ]; then
    src=$dir/$(printf '%03d' $((step - 1)))
    [ -d "$src" ] || { T_HALT="chain input $src is missing"; T_COUNTED=false; T_CLASS=none; rmdir "$room"; return; }
  else
    src=$REPO/tasks/$task/seed
  fi
  [ ! -d "$src" ] || cp -Rp "$src/." "$room/"
  input_sha=$(tree_sha "$room")

  build_argv "$profile" "$model" "$sid" "$prompt"
  argvsha=$(argv_sha "$sid" "${ARGV[@]}")
  out=$STATE/work/$run.jsonl
  err=$STATE/work/$run.stderr
  started=$(iso)
  launch "$room" "$out" "$err"
  ended=$(iso)

  quota_update "$out" "$model"
  cls=$(classify "$out" "$TRIAL_RC")
  facts=$(stream_facts "$out")
  T_CLASS=$(printf '%s' "$cls" | jq -r .class)
  T_COUNTED=$(printf '%s' "$cls" | jq -r .counted)
  verdict=none note= CONDITIONS_SHA=

  rec=$CFG/projects/$(project_key "$room")/$sid.jsonl
  if [ "$T_COUNTED" = true ]; then
    if [ -f "$rec" ]; then
      golden_verdict "$profile" "$model" "$rec" "$room" "$sid" "$facts" "$run/$nnn"
      verdict=$VERDICT note=$GOLDEN_NOTE
    else
      verdict=no_record note="no session record at $rec"
    fi
    case $verdict in
      rejected|no_record) T_HALT=$note ;;
      mismatch)
        if [ "$profile" = room ]; then
          T_HALT="$note (golden/$(golden_key "$profile" "$model").mismatch.*)"
        elif [ ! -f "$STATE/work/$run.harness-mismatch" ]; then
          touch "$STATE/work/$run.harness-mismatch"
          notify "$run: harness conditions vary between trials; recorded per row, not halted"
        fi ;;
    esac

    ret=$(printf '%s' "$facts" | jq -r '.model_returned | if length > 1 then "MANY:" + join(",") else (.[0] // "") end')
    first=$(first_returned "$model")
    case $ret in
      MANY:*) [ -n "$T_HALT" ] || T_HALT="one trial returned several models: ${ret#MANY:}" ;;
      '') ;;
      *) [ -z "$first" ] || [ "$first" = "$ret" ] || [ -n "$T_HALT" ] ||
           T_HALT="model changed: $model returned $first earlier, $ret now" ;;
    esac
    # A trial that cannot be vouched for is kept, but out of the sample.
    [ -z "$T_HALT" ] || T_COUNTED=false
  fi

  output_sha=$(tree_sha "$room")
  if [ "$T_COUNTED" = true ]; then
    dest=$dir/$nnn
    if [ "$profile" = harness ]; then stream_dest=$records/$nnn.jsonl; else stream_dest=$dir/$nnn.jsonl; fi
  else
    dest=$STATE/debris/$run/$nnn-a$attempt-$(date +%H%M%S)
    stream_dest=$dest.jsonl
  fi
  mv "$room" "$dest"
  mv "$out" "$stream_dest"
  if [ -s "$err" ]; then
    mkdir -p "$STATE/stderr/$run"
    mv "$err" "$STATE/stderr/$run/$nnn-a$attempt.stderr"
  else
    rm -f "$err"
  fi

  # The first session record per run and model goes to brain (decision 7).
  # Records carry the org UUID, so they never enter this repo.
  if [ "$T_COUNTED" = true ] && [ -f "$rec" ] &&
     [ -z "$(jq -s -r --arg m "$model" '[.[] | select(.counted == true and .model_asked == $m)] | first | .step // empty' "$trials")" ]; then
    cp -p "$rec" "$records/$nnn.session.jsonl"
  fi

  jq -n -c \
    --arg run "$run" --arg task "$task" --arg mode "$mode" --argjson step "$step" --argjson attempt "$attempt" \
    --arg model "$model" --arg effort "$EFFORT" --arg profile "$profile" \
    --arg cli_sha "$PRIORS_CLAUDE_SHA" --arg argv_sha "$argvsha" --arg sid "$sid" \
    --arg started "$started" --arg ended "$ended" --argjson wall "$TRIAL_WALL" --argjson rc "$TRIAL_RC" \
    --argjson cls "$cls" --argjson counted "$T_COUNTED" --argjson facts "$facts" \
    --arg input_sha "$input_sha" --arg output_sha "$output_sha" \
    --arg cond_sha "$CONDITIONS_SHA" --arg verdict "$verdict" --arg note "$note" --arg halt "$T_HALT" \
    '{run: $run, task: $task, mode: $mode, step: $step, attempt: $attempt,
      model_asked: $model, model_returned: $facts.model_returned, effort: $effort, profile: $profile,
      cli_version: $facts.cli_version, cli_sha256: $cli_sha, argv_sha256: $argv_sha, session_id: $sid,
      started_utc: $started, ended_utc: $ended, wall_s: $wall, exit_code: $rc,
      class: $cls.class, counted: $counted, truncated: $cls.truncated,
      subtype: $facts.subtype, is_error: $facts.is_error, stop_reason: $facts.stop_reason,
      api_error_status: $facts.api_error_status, turns: $facts.turns, cost_usd: $facts.cost_usd,
      tokens: $facts.tokens, denials: $facts.denials, thinking_blocks: $facts.thinking_blocks,
      tool_calls: $facts.tool_calls, result: $facts.result,
      input_sha256: $input_sha, output_sha256: $output_sha, rate_limit: $facts.rate_limit,
      conditions_sha256: (if $cond_sha == "" then null else $cond_sha end),
      golden: $verdict, golden_note: (if $note == "" then null else $note end),
      halt: (if $halt == "" then null else $halt end)}' >> "$trials"

  log "$nnn a$attempt $model: $T_CLASS${T_COUNTED:+ counted=$T_COUNTED} golden=$verdict $(printf '%s' "$facts" | jq -r '"cost=\(.cost_usd // "n/a") turns=\(.turns // "n/a") 7d=\(.rate_limit.unifiedWindows.seven_day.utilization // "n/a")"') ${TRIAL_WALL}s"
}

# ------------------------------------------------------------------ main

read -r last truncated <<EOF
$(progress)
EOF
if [ "$mode" = chain ] && [ "$truncated" = true ]; then
  halt "chain has a truncated step; a human decides whether it continues" nocommit
fi

# Step directories with no counted row are leftovers of an interrupted trial.
for d in "$dir"/[0-9][0-9][0-9]; do
  [ -d "$d" ] || continue
  s=$((10#$(basename "$d")))
  [ "$s" -le "$last" ] || to_debris "$d" "$(basename "$d")-uncounted"
done

if [ "$last" -ge "$n" ]; then
  commit_pending
  exit 0
fi
[ "$last" = 0 ] || log "resuming at step $((last + 1)) of $n"

step=$((last + 1))
while [ "$step" -le "$n" ]; do
  if [ "$mode" = chain ] && [ "${#model_list[@]}" -gt 1 ]; then
    model=${model_list[$(( (step - 1) % ${#model_list[@]} ))]}
  else
    model=${model_list[0]}
  fi

  attempt=1
  while :; do
    brake "$model"
    case $? in 0) ;; 2) capped "$step" ;; *) stopping "$step" ;; esac
    check_binary || { request_stop "the pinned binary changed or vanished"; stopping "$step"; }
    trial "$step" "$attempt" "$model"
    [ -z "$T_HALT" ] || halt "step $step: $T_HALT"
    if [ "$T_COUNTED" = true ]; then
      infra_streak reset >/dev/null
      break
    fi
    streak=$(infra_streak bump)
    if [ "$streak" -ge 5 ]; then
      request_stop "five infrastructure failures in a row (last: $run step $step, $T_CLASS)"
      stopping "$step"
    fi
    [ "$attempt" -lt 3 ] || halt "step $step: three infrastructure failures (last: $T_CLASS)"
    set -- ${PRIORS_RETRY_WAITS:-30 120}
    wait_s=$1
    [ "$attempt" = 1 ] || wait_s=$2
    log "step $step attempt $attempt: $T_CLASS; retrying in ${wait_s}s"
    t_end=$(( $(now) + wait_s ))
    while [ "$(now)" -lt "$t_end" ]; do stop_requested && stopping "$step"; sleep 1; done
    attempt=$((attempt + 1))
  done

  if [ "$mode" = chain ]; then
    commit_pending "$(printf '%03d' "$step")"
    if [ "$(tail -1 "$trials" | jq -r .truncated)" = true ]; then
      halt "step $step hit a cap (truncated); the chain waits for a human" nocommit
    fi
  fi
  step=$((step + 1))
done

[ "$mode" = chain ] || commit_pending
log "done: $n steps"
exit 0
