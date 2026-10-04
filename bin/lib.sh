# lib.sh: shared by run.sh and campaign.sh. Sourced, never run.
#
# One trial: prepare the room, launch claude in it under a watchdog, kill its
# process group, move the room into runs/, write one row to trials.jsonl.
# Around that: the conditions check against a golden record, the quota brake,
# the commit gate and the locks that let several workers share one repo.
#
# Written for bash 3.2, the version macOS ships.

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
BRAIN=${PRIORS_BRAIN:-$HOME/Projects/brain/projects/priors}
STATE=$REPO/.state
ROOM_ROOT=${PRIORS_ROOM_ROOT:-/private/tmp}
CFG=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
WATCHDOG=${PRIORS_WATCHDOG:-300}
EFFORT=low
HAIKU=claude-haiku-4-5-20251001
ROOM_TOOLS='["Bash","Edit","Read","Write"]'
ATTRIBUTION='{"attribution":{"commit":"","pr":""}}'
EXIT_HALT=3 EXIT_STOP=4 EXIT_CAPPED=5

mkdir -p "$STATE/locks" "$STATE/debris" "$STATE/halted" "$STATE/work" "$STATE/pgids" \
  "$STATE/quota" "$STATE/capped"

# ------------------------------------------------------------------ basics

now() { date +%s; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
hires() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') ${PRIORS_WHO:-campaign}: $*"
  printf '%s\n' "$line" >> "$STATE/campaign.log"
  [ "${PRIORS_QUIET:-0}" = 1 ] || printf '%s\n' "$line" >&2
}

# A macOS notification as well as a log line. For halts, stops and the end.
notify() {
  log "NOTIFY $*"
  [ "${PRIORS_NOTIFY:-1}" = 1 ] || return 0
  local m=${*//\\/\\\\}
  m=${m//\"/\\\"}
  osascript -e "display notification \"$m\" with title \"priors\"" >/dev/null 2>&1 || true
}

die() { printf '%s: %s\n' "$(basename "$0")" "$*" >&2; exit 2; }

sha_file() { shasum -a 256 "$1" | cut -c1-64; }
sha_str() { printf '%s' "$1" | shasum -a 256 | cut -c1-64; }

# A .jsonl file as one JSON array, skipping lines that do not parse.
jl() {
  if [ -s "$1" ]; then
    jq -R -s -c '[split("\n")[] | select(length > 0) | (try fromjson catch empty)]' "$1"
  else
    echo '[]'
  fi
}

# sha256 over a directory tree: paths, file contents, symlink targets and
# empty directories. The same tree always hashes the same.
tree_sha() {
  perl -MFile::Find -MDigest::SHA -e '
    my $root = shift; my @e;
    find({no_chdir => 1, wanted => sub {
      my $r = substr($File::Find::name, length $root); $r =~ s{^/}{};
      return if $r eq "";
      if (-l $_) { push @e, "l $r " . readlink($_) }
      elsif (-f _) { push @e, "f $r " . Digest::SHA->new(256)->addfile($_)->hexdigest }
      elsif (-d _) { push @e, "d $r" }
    }}, $root);
    print Digest::SHA::sha256_hex(join("\n", sort @e)), "\n";' "$1"
}

# The directory Claude Code keeps a cwd's session records in.
project_key() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }

# ------------------------------------------------------------------- locks
# mkdir is atomic. A lock whose holder is dead is broken and retaken.

lock() {
  local d=$STATE/locks/$1.lock p
  while ! mkdir "$d" 2>/dev/null; do
    p=$(cat "$d/pid" 2>/dev/null)
    if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then rm -rf "$d"; continue; fi
    sleep 0.2
  done
  printf '%s\n' "${LOCK_PID:-$$}" > "$d/pid"
}
unlock() { rm -rf "$STATE/locks/$1.lock"; }

# ------------------------------------------------------------ the campaign

# The manifest: campaign.tsv unless campaign.sh was given --campaign. That
# file stays the first campaign's alone, because the site checks every run it
# lists against data/trials.csv and fails the build on one with no rows. A
# later campaign gets a file of its own, and its runs reach the site only
# when the tally and the site are taught its tasks.
CAMPAIGN=${PRIORS_CAMPAIGN:-$REPO/campaign.tsv}

# Manifest fields: run task mode models n profile. Prints the row for a run.
campaign_row() { awk -F'\t' -v r="$1" '$1 == r' "$CAMPAIGN"; }

task_prompt() { cat "$REPO/tasks/$1/prompt.txt"; }
task_room() { printf '%s/%s' "$ROOM_ROOT" "$(tr -d '[:space:]' < "$REPO/tasks/$1/room")"; }

# ------------------------------------------------------------------- brake

# quota_update <stream-json> [model]: called after every trial. The last
# rate_limit_event becomes .state/quota.json, and with a model also
# .state/quota/<model>.json. The second exists because some windows belong to
# one model: Fable's events carry seven_day_overage_included, which no other
# model's event does, so the shared file loses it whenever another model's
# trial ends last. The five-hour and seven-day windows are the account's and
# ride on every event, so the shared file stays right for those.
quota_update() {
  local info
  info=$(jl "$1" | jq -c '[.[] | select(.type == "rate_limit_event") | .rate_limit_info] | last // empty')
  [ -n "$info" ] || return 0
  info=$(printf '%s' "$info" | jq -c --argjson at "$(now)" '. + {at: $at}')
  lock quota
  printf '%s\n' "$info" > "$STATE/quota.json.tmp" && mv "$STATE/quota.json.tmp" "$STATE/quota.json"
  if [ -n "${2:-}" ]; then
    printf '%s\n' "$info" > "$STATE/quota/$2.json.tmp" && mv "$STATE/quota/$2.json.tmp" "$STATE/quota/$2.json"
  fi
  unlock quota
}

# model_cap <model> <ceiling>: the first window of this model's own (any but
# five_hour and seven_day) that has not reset and is at the ceiling, as
# "name utilization resetsAt", or nothing.
model_cap() {
  [ -f "$STATE/quota/$1.json" ] || return 0
  jq -r --argjson now "$(now)" --argjson c "$2" '
    .unifiedWindows // {} | to_entries[]
    | select(.key != "five_hour" and .key != "seven_day")
    | select((.value.resetsAt // 0) > $now and (.value.utilization // 0) * 100 >= $c)
    | "\(.key) \(.value.utilization) \(.value.resetsAt)"' "$STATE/quota/$1.json" 2>/dev/null | head -1
}

# One number from quota.json, or nothing when absent or when that window has
# already reset (a reading from before a reset says nothing about now).
quota_get() {
  [ -f "$STATE/quota.json" ] || return 0
  jq -r --arg w "$1" --arg f "$2" --argjson now "$(now)" '
    .unifiedWindows[$w] // empty
    | select((.resetsAt // 0) > $now)
    | .[$f] // empty' "$STATE/quota.json" 2>/dev/null
}

request_stop() {
  lock stop
  if [ ! -f "$STATE/STOP" ]; then
    printf '%s %s\n' "$(iso)" "$*" > "$STATE/STOP"
    notify "stopping: $*"
  fi
  unlock stop
}
stop_requested() { [ -f "$STATE/STOP" ]; }

# brake [model]: before every trial. Returns 0 to go on, 1 when the campaign
# is stopping, 2 when this model is at the ceiling on a window of its own
# (BRAKE_CAP says which). A model cap stops only that model: the account
# still has room, so the other models carry on. Sleeps through a five-hour
# limit that resets before --until.
brake() {
  local u r t ceiling=${PRIORS_CEILING:-95} until=${PRIORS_UNTIL:-never}
  BRAKE_CAP=
  while :; do
    stop_requested && return 1
    t=$(now)
    if [ "$until" != never ] && [ "$t" -ge "$until" ]; then
      request_stop "reached --until ($(date -r "$until" '+%Y-%m-%d %H:%M'))"; return 1
    fi
    u=$(quota_get seven_day utilization)
    if [ -n "$u" ] && perl -e 'exit !($ARGV[0] * 100 >= $ARGV[1])' "$u" "$ceiling"; then
      request_stop "seven-day quota at $u, ceiling $ceiling%"; return 1
    fi
    if [ -n "${1:-}" ]; then
      BRAKE_CAP=$(model_cap "$1" "$ceiling")
      [ -z "$BRAKE_CAP" ] || return 2
    fi
    u=$(quota_get five_hour utilization)
    if [ -n "$u" ] && perl -e 'exit !($ARGV[0] >= 0.95)' "$u"; then
      r=$(quota_get five_hour resetsAt)
      if [ "$until" != never ] && [ "$r" -gt "$until" ]; then
        request_stop "five-hour quota at $u, resets after --until"; return 1
      fi
      log "five-hour quota at $u, sleeping until $(date -r "$r" '+%H:%M')"
      while [ "$(now)" -lt "$((r + 30))" ]; do stop_requested && return 1; sleep 30; done
      continue
    fi
    return 0
  done
}

# Five infrastructure failures in a row, across all workers, stop everything.
infra_streak() {
  local n
  lock streak
  n=$(cat "$STATE/infra_streak" 2>/dev/null || echo 0)
  case $1 in reset) n=0 ;; bump) n=$((n + 1)) ;; esac
  printf '%s\n' "$n" > "$STATE/infra_streak"
  unlock streak
  printf '%s' "$n"
}

# ------------------------------------------------------------------ binary

# The pinned CLI must not change under a running campaign.
check_binary() {
  [ -x "$PRIORS_CLAUDE" ] || { log "binary missing: $PRIORS_CLAUDE"; return 1; }
  local s
  s=$(sha_file "$PRIORS_CLAUDE")
  [ "$s" = "$PRIORS_CLAUDE_SHA" ] || { log "binary changed: $PRIORS_CLAUDE is $s, launched with $PRIORS_CLAUDE_SHA"; return 1; }
}

# ------------------------------------------------------------------- argv

# Sets ARGV for one trial. profile room: the clean room (decisions 10 to 14).
# profile harness: the pilot's own argv plus what it takes to record it.
build_argv() {
  local profile=$1 model=$2 sid=$3 prompt=$4
  case $profile in
    room)
      ARGV=(--safe-mode --strict-mcp-config --tools Read,Write,Edit,Bash --restricted
        --settings "$ATTRIBUTION"
        --model "$model" --effort "$EFFORT" --permission-mode acceptEdits
        --permission-prompts none --session-id "$sid"
        --output-format stream-json --verbose -p "$prompt") ;;
    harness)
      ARGV=(--model "$model" --effort "$EFFORT" --session-id "$sid"
        --output-format stream-json --verbose -p "$prompt") ;;
    *) die "unknown profile: $profile" ;;
  esac
}

# sha256 over the argv with the session ID taken out, so it is constant
# across the trials of one run and model.
argv_sha() {
  local sid=$1 a out=
  shift
  for a in "$@"; do [ "$a" = "$sid" ] && a='{SESSION}'; out="$out$a"$'\x1f'; done
  sha_str "$out"
}

# Shell-quote one argument for display.
q() {
  case $1 in
    *$'\n'*) printf '%q' "$1" ;;
    '' | *[!A-Za-z0-9_./,:=@%+-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# The full command line for a trial, as the dry run prints it.
show_cmd() {
  local room=$1 a line
  shift
  line="cd $(q "$room") && env -u ANTHROPIC_API_KEY DISABLE_AUTOUPDATER=1 perl -e $(q "setpgrp; alarm $WATCHDOG; exec @ARGV or die \"exec: \$!\"") $(q "$PRIORS_CLAUDE")"
  for a in "$@"; do line="$line $(q "$a")"; done
  printf '%s\n' "$line"
}

# ------------------------------------------------------------------ launch

# Runs one trial in $1 with ARGV, stream-json to $2, stderr to $3. The perl
# shim makes the trial its own process group and arms the watchdog; after it
# exits the whole group is killed, so a server the model started dies too.
# Sets TRIAL_RC and TRIAL_WALL.
launch() {
  local room=$1 out=$2 err=$3 pid t0 t1 pids
  t0=$(hires)
  (cd "$room" && exec env -u ANTHROPIC_API_KEY DISABLE_AUTOUPDATER=1 \
    perl -e "setpgrp; alarm $WATCHDOG; exec @ARGV or die \"exec: \$!\"" \
    "$PRIORS_CLAUDE" "${ARGV[@]}") </dev/null >"$out" 2>"$err" &
  pid=$!
  printf '%s\n' "$pid" > "$STATE/pgids/$PRIORS_WHO"
  wait "$pid"
  TRIAL_RC=$?
  t1=$(hires)
  TRIAL_WALL=$(perl -e 'printf "%.3f", $ARGV[1] - $ARGV[0]' "$t0" "$t1")
  kill_group "$pid"
  rm -f "$STATE/pgids/$PRIORS_WHO"
  # Anything still holding the room open escaped the group.
  pids=$(lsof -t +d "$room" 2>/dev/null | sort -u | tr '\n' ' ')
  if [ -n "${pids// /}" ]; then
    log "killing strays in $room: $pids"
    kill -9 $pids 2>/dev/null
  fi
}

kill_group() {
  kill -TERM -- "-$1" 2>/dev/null || return 0
  sleep 1
  kill -KILL -- "-$1" 2>/dev/null
  return 0
}

# ---------------------------------------------------------------- classify

# The class of a finished trial (B3.7), as JSON: {class, counted, truncated}.
# Infrastructure is retried and never counted. Cap hits count and stop a
# chain. Everything else counts: refusals, questions and no-ops included.
classify() {
  jl "$1" | jq -c --argjson rc "$2" '
    ([.[] | select(.type == "result")] | last) as $r
    | ([.[] | select(.type == "rate_limit_event") | .rate_limit_info] | last) as $rl
    | if $rc == 142 then {class: "infra:watchdog"}
      elif $r == null then
        (if ($rl.status // "") == "rejected" then {class: "infra:rate_limited"} else {class: "infra:no_result"} end)
      elif ($r.subtype == "error_max_turns" or $r.subtype == "error_max_budget_usd") then {class: "truncated"}
      elif $r.subtype == "error_during_execution" then {class: "infra:error_during_execution"}
      elif $r.stop_reason == "refusal" then {class: "refusal"}
      elif $r.is_error == true then
        (if ($rl.status // "") == "rejected" then {class: "infra:rate_limited"} else {class: "infra:api_error"} end)
      else {class: "ok"} end
    | . + {counted: (.class | startswith("infra:") | not), truncated: (.class == "truncated")}'
}

# The measurements a trial row carries from its stream-json.
stream_facts() {
  jl "$1" | jq -c '
    ([.[] | select(.type == "result")] | last) as $r
    | ([.[] | select(.type == "system" and .subtype == "init")] | first) as $init
    | [.[] | select(.type == "assistant")] as $a
    | {
        model_returned: ([$a[] | .message.model // empty | select(. != "<synthetic>")] | unique),
        cli_version: ($init.claude_code_version // null),
        subtype: ($r.subtype // null),
        is_error: ($r.is_error // null),
        stop_reason: ($r.stop_reason // null),
        api_error_status: ($r.api_error_status // null),
        turns: ($r.num_turns // null),
        cost_usd: ($r.total_cost_usd // null),
        tokens: (if $r.usage == null then null else {
          input: $r.usage.input_tokens, output: $r.usage.output_tokens,
          cache_read: $r.usage.cache_read_input_tokens,
          cache_creation: $r.usage.cache_creation_input_tokens,
          thinking: ($r.usage.output_tokens_details.thinking_tokens // null)} end),
        denials: ($r.permission_denials // null | if . == null then null else length end),
        thinking_blocks: ([$a[] | .message.content[]? | select(type == "object" and (.type == "thinking" or .type == "redacted_thinking"))] | length),
        tool_calls: ([$a[] | .message.content[]? | select(type == "object" and .type == "tool_use") | .name] | group_by(.) | map({key: .[0], value: length}) | from_entries),
        result: ($r.result // null),
        rate_limit: ([.[] | select(.type == "rate_limit_event") | .rate_limit_info] | last),
        init_memory_paths: ($init.memory_paths // null),
        init_mcp_servers: ($init.mcp_servers // null)
      }'
}

# -------------------------------------------------------------- conditions

# Normalized conditions of a session record (see conditions.jq), compact and
# key-sorted, so the text itself is what gets hashed.
conditions() {
  local rec=$1 room=$2 sid=$3 mask=${4:-0}
  jl "$rec" | jq -S -c --arg room "$room" --arg sid "$sid" --arg mask_model "$mask" -f "$REPO/bin/conditions.jq"
}

golden_key() { printf '%s-%s-%s-%s' "$1" "$2" "$EFFORT" "$(printf '%s' "$PRIORS_CLAUDE_SHA" | cut -c1-12)"; }

# Goldens are per manifest: a campaign is held to the conditions its own
# first trial saw, not to an earlier campaign's. The pinned binary is not the
# whole of the conditions. The CLI is served system prompt sections, and
# between the first campaign and the second both Fable's and Opus's changed
# under the same binary, which halted every one of their runs at trial 1.
# campaign.tsv keeps the top level, where its goldens have always been.
golden_dir() {
  local name
  name=$(basename "$CAMPAIGN" .tsv)
  if [ "$name" = campaign ]; then printf '%s/golden' "$BRAIN"; else printf '%s/golden/%s' "$BRAIN" "$name"; fi
}
# The same, relative to brain, for notes and messages.
golden_rel() { local d; d=$(golden_dir); printf '%s' "${d#"$BRAIN"/}"; }

# The checks a human would make on a room-profile golden (decision 20).
# $1: conditions JSON (unmasked); $2: the init event's facts from stream_facts.
# Prints one line per check, PASS or FAIL. Returns 1 if any failed.
room_assertions() {
  jq -n -r --argjson c "$1" --argjson f "$2" --argjson want "$ROOM_TOOLS" '
    def chk($name; $ok; $detail): "\(if $ok then "PASS" else "FAIL" end)  \($name)\(if $ok then "" else ": \($detail)" end)";
    [$c.attachments[]? | .type] as $types
    | ($c.attachments | tostring) as $atext
    | chk("tools are exactly Bash, Edit, Read, Write"; ([$c.tools[]?.name] | sort) == $want; [$c.tools[]?.name]),
      chk("no instructions attachment"; ([$types[] | select(test("instruction|claude_md|nested_memory"; "i"))] | length) == 0; $types),
      chk("no memory block in the system prompt"; ([$c.system_prompt[]? | select(test("^\\s*#\\s*auto memory"; "i"))] | length) == 0; "auto memory block present"),
      chk("no memory attachment"; ([$types[] | select(test("memory"; "i"))] | length) == 0; $types),
      chk("no memory_paths in init"; ($f.init_memory_paths == null or $f.init_memory_paths == [] or $f.init_memory_paths == {}); $f.init_memory_paths),
      chk("no skill, agent or MCP attachment"; ([$types[] | select(test("skill|agent|mcp|deferred"; "i"))] | length) == 0; $types),
      chk("no MCP servers in init"; ($f.init_mcp_servers == null or $f.init_mcp_servers == []); $f.init_mcp_servers),
      chk("no attribution reminder"; ([$c.attachments[]? | select(.type == "remote_session_change" and (((.commit // "") != "") or ((.pr // "") != "")))] | length) == 0 and ($atext | test("Co-Authored-By") | not); "remote_session_change carries attribution"),
      chk("no budget line"; ($types | index("budget_usd")) == null and ($atext | test("USD budget") | not); $types),
      chk("system prompt present"; ($c.system_prompt | type) == "array" and ($c.system_prompt | length) > 0; "no prompt_snapshot with tools")
  ' | tee "$STATE/work/assert.$$"
  ! grep -q '^FAIL' "$STATE/work/assert.$$"
  local rc=$?
  rm -f "$STATE/work/assert.$$"
  return $rc
}

# Compare a trial's conditions with its key's golden, making the golden if
# there is none. Sets VERDICT: golden, match, mismatch, or
# rejected (a would-be golden failed its assertions). Also sets GOLDEN_NOTE.
#   $1 profile  $2 model asked  $3 session record  $4 room  $5 sid
#   $6 facts JSON  $7 where (run/step, for the record)
golden_verdict() {
  local profile=$1 model=$2 rec=$3 room=$4 sid=$5 facts=$6 where=$7
  local key gdir grel gfile cond sha gsha checks hk hfile masked hmasked first
  GOLDEN_NOTE=
  key=$(golden_key "$profile" "$model")
  gdir=$(golden_dir)
  grel=$(golden_rel)
  gfile=$gdir/$key.json
  mkdir -p "$gdir"
  cond=$(conditions "$rec" "$room" "$sid")
  CONDITIONS_SHA=$(sha_str "$cond")

  lock golden
  if [ -f "$gfile" ]; then
    unlock golden
    gsha=$(jq -r .sha256 "$gfile")
    if [ "$gsha" = "$CONDITIONS_SHA" ]; then VERDICT=match; return; fi
    printf '%s' "$cond" > "$gdir/$key.mismatch.$(printf '%s' "$where" | tr / _).json"
    GOLDEN_NOTE="conditions $CONDITIONS_SHA differ from golden $gsha"
    VERDICT=mismatch; return
  fi

  if [ "$profile" = room ]; then
    checks=$(room_assertions "$cond" "$facts")
    if [ $? -ne 0 ]; then
      unlock golden
      printf '%s\n' "$checks" > "$gdir/$key.rejected.$(printf '%s' "$where" | tr / _).txt"
      GOLDEN_NOTE="golden assertions failed: $(printf '%s\n' "$checks" | grep '^FAIL' | sed 's/^FAIL  //' | tr '\n' ';')"
      VERDICT=rejected; return
    fi
  else
    checks="(harness profile: no assertions; the full user config is the point)"
  fi

  # Cross-model: with the model's identity masked, a room golden should
  # equal the Haiku golden from the confirmation. A difference is a fact
  # about the harness, not contamination, so it is recorded, not halted on.
  if [ "$profile" = room ] && [ "$model" != "$HAIKU" ]; then
    hk=$(golden_key room "$HAIKU")
    hfile=$gdir/$hk.json
    if [ -f "$hfile" ]; then
      masked=$(printf '%s' "$cond" | jq -S -c '.attachments |= map(if .type == "model" then .identity = "{MODEL}" | .text = "{MODEL}" else . end)')
      hmasked=$(jq -S -c '.conditions | .attachments |= map(if .type == "model" then .identity = "{MODEL}" | .text = "{MODEL}" else . end)' "$hfile")
      if [ "$masked" = "$hmasked" ]; then
        checks="$checks"$'\n'"PASS  identical to the Haiku golden with model identity masked"
      else
        checks="$checks"$'\n'"DIFF  differs from the Haiku golden with model identity masked (see $key.vs-haiku.diff)"
        diff <(printf '%s' "$hmasked" | jq -S .) <(printf '%s' "$masked" | jq -S .) > "$gdir/$key.vs-haiku.diff"
        GOLDEN_NOTE="differs from the Haiku golden (masked); recorded in $grel/$key.vs-haiku.diff"
      fi
    else
      checks="$checks"$'\n'"SKIP  no Haiku golden to compare with"
    fi
  fi

  # Cross-campaign: under a later manifest, the same key's golden from the
  # first campaign. A difference is what the CLI was served on another day,
  # so it is recorded, not halted on, and comparisons across the two
  # campaigns have to carry it.
  first=$BRAIN/golden/$key.json
  if [ "$gdir" != "$BRAIN/golden" ] && [ -f "$first" ]; then
    if [ "$(jq -r .sha256 "$first")" = "$CONDITIONS_SHA" ]; then
      checks="$checks"$'\n'"PASS  identical to the first campaign's golden"
    else
      checks="$checks"$'\n'"DIFF  differs from the first campaign's golden (see $key.vs-campaign.diff)"
      diff <(jq -S .conditions "$first") <(printf '%s' "$cond" | jq -S .) > "$gdir/$key.vs-campaign.diff"
      GOLDEN_NOTE="${GOLDEN_NOTE:+$GOLDEN_NOTE; }differs from the first campaign's golden; recorded in $grel/$key.vs-campaign.diff"
    fi
  fi

  jq -n -S --arg key "$key" --arg source "$where" --arg sha "$CONDITIONS_SHA" \
    --arg cli "$PRIORS_CLAUDE_SHA" --arg made "$(iso)" --argjson conditions "$cond" \
    '{key: $key, source: $source, sha256: $sha, cli_sha256: $cli, made_utc: $made, conditions: $conditions}' > "$gfile.tmp" &&
    mv "$gfile.tmp" "$gfile"
  printf '%s\n' "$checks" > "$gdir/$key.checks.txt"
  unlock golden
  log "golden $key from $where${GOLDEN_NOTE:+ ($GOLDEN_NOTE)}"
  VERDICT=golden
}

# ------------------------------------------------------------------ commit

# Stage one run, gate it, commit it. Serialized: workers share the index.
# Returns 1 (with GATE_NOTE set, nothing committed) if the gate trips.
commit_run() {
  local run=$1 kind=$2 step=${3:-} dir=runs/$1 n msg hits ign odd
  GATE_NOTE=
  lock git
  (cd "$REPO" && git add -A -- "$dir") || { unlock git; GATE_NOTE="git add failed"; return 1; }
  if (cd "$REPO" && git diff --cached --quiet -- "$dir"); then unlock git; return 0; fi

  hits=$(cd "$REPO" && git grep --cached -I -l -F -f "$STATE/gate.txt" -- "$dir" 2>/dev/null)
  ign=$(cd "$REPO" && git status --porcelain --ignored -- "$dir" | grep '^!!')
  odd=$(cd "$REPO" && find "$dir" -mindepth 1 \( -name .git -o -name .gitignore -o -name .gitattributes \) -print 2>/dev/null)
  if [ -n "$hits$ign$odd" ]; then
    (cd "$REPO" && git reset -q -- "$dir")
    unlock git
    GATE_NOTE="gate:${hits:+ private text in $(printf '%s' "$hits" | tr '\n' ' ')}${ign:+ ignored files $(printf '%s' "$ign" | tr '\n' ' ')}${odd:+ git files $(printf '%s' "$odd" | tr '\n' ' ')}"
    return 1
  fi

  if [ "$kind" = chain ] && [ -n "$step" ]; then
    msg="Add step $step to $run"
  else
    n=$(cd "$REPO" && git diff --cached --name-only --diff-filter=A -- "$dir" |
      sed -n "s#^$dir/\([0-9][0-9][0-9]\)[/.].*#\1#p" | sort -u | wc -l | tr -d ' ')
    case $n in
      0) msg="Record failed attempts on $run" ;;
      1) msg="Add 1 trial to $run" ;;
      *) msg="Add $n trials to $run" ;;
    esac
  fi
  (cd "$REPO" && git commit -q -m "$msg" -- "$dir") || { unlock git; GATE_NOTE="git commit failed"; return 1; }
  unlock git
  log "committed: $msg"
}

# The gate's patterns: what is private (decision 9). Built at launch into
# .state/gate.txt, which never leaves this machine.
build_gate() {
  local f=$STATE/gate.txt org v
  {
    org=$(jq -r '.oauthAccount.organizationUuid // empty' "$HOME/.claude.json" 2>/dev/null)
    [ -z "$org" ] || printf '%s\n' "$org"
    if [ -d "$HOME/Clients" ]; then
      (cd "$HOME/Clients" && for d in */; do d=${d%/}; [ "$d" = tmp ] || printf '%s\n' "Clients/$d" "$d"; done)
    fi
    # Distinctive lines of the user-level CLAUDE.md, the harness profile's
    # instruction file, read at launch so none of its text lives in this
    # repo. Anything quoting it verbatim carries one of these.
    [ ! -f "$HOME/.claude/CLAUDE.md" ] ||
      sed -E 's/^[[:space:]>*#|-]+//; s/[[:space:]|]+$//' "$HOME/.claude/CLAUDE.md" | awk 'length >= 40'
    # Secret prefixes.
    printf '%s\n' 'sk-ant-' 'ghp_' 'gho_' 'github_pat_' 'xoxb-' 'xoxp-' 'AKIA' \
      'BEGIN OPENSSH PRIVATE KEY' 'BEGIN RSA PRIVATE KEY' 'BEGIN PRIVATE KEY'
    # Values of exported secrets.
    env | sed -n -E 's/^[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD|PAT)[A-Za-z_]*=(.*)$/\2/p' | while IFS= read -r v; do
      [ "${#v}" -ge 12 ] && printf '%s\n' "$v"
    done
    [ -z "${PRIORS_GATE_EXTRA:-}" ] || printf '%s\n' "$PRIORS_GATE_EXTRA"
  } | grep -v '^$' | sort -u > "$f.tmp"
  mv "$f.tmp" "$f"
}
