#!/usr/bin/env bash
# stub-claude.sh: a fake `claude` for testing the runner without quota.
#
# Accepts the real argv, edits files in the cwd, prints stream-json with a
# result and a rate_limit_event, and writes a session record shaped like the
# real one. It refuses to run unless CLAUDE_CONFIG_DIR is set, so a test can
# never write into the real ~/.claude.
#
# STUB_MODE: ok (default), noresult, exit142, quota96, plant, sysprompt, slow.
# A mode may be prefixed "first-N:" to apply only to the first N calls
# counted in STUB_COUNTER, e.g. first-1:exit142. STUB_PLANT is the text
# `plant` writes; STUB_SLEEP is how long `slow` sleeps.

set -u
[ -n "${CLAUDE_CONFIG_DIR:-}" ] || { echo "stub-claude: CLAUDE_CONFIG_DIR must be set" >&2; exit 2; }

model= sid= prompt=
while [ $# -gt 0 ]; do
  case $1 in
    --version) echo "2.1.283 (Claude Code)"; exit 0 ;;
    --model) model=$2; shift 2 ;;
    --session-id) sid=$2; shift 2 ;;
    -p) prompt=$2; shift 2 ;;
    --settings|--tools|--effort|--permission-mode|--permission-prompts|--output-format|--max-budget-usd) shift 2 ;;
    *) shift ;;
  esac
done
[ "$model" != haiku ] || model=claude-haiku-4-5-20251001
[ -n "$sid" ] || sid=$(uuidgen | tr '[:upper:]' '[:lower:]')

mode=${STUB_MODE:-ok}
calls=0
if [ -n "${STUB_COUNTER:-}" ]; then
  calls=$(( $(cat "$STUB_COUNTER" 2>/dev/null || echo 0) + 1 ))
  printf '%s\n' "$calls" > "$STUB_COUNTER"
fi
case $mode in
  first-*:*) k=${mode#first-}; k=${k%%:*}; if [ "$calls" -le "$k" ]; then mode=${mode#*:}; else mode=ok; fi ;;
esac

cwd=$(pwd -P)
t=$(date +%s)

# The work: one line appended to every file in the room, or a new file.
found=0
for f in "$cwd"/*; do
  [ -f "$f" ] || continue
  found=1
  printf '\nstub %s %s' "$model" "$sid" >> "$f"
done
[ "$found" = 1 ] || printf 'stub %s %s\n' "$model" "$sid" > "$cwd/out.txt"
[ "$mode" != plant ] || printf '\n%s\n' "${STUB_PLANT:-planted}" >> "$cwd/out.txt"

# The session record.
sp='["You are a stub.", "# Environment\n - nothing to see"]'
[ "$mode" != sysprompt ] || sp='["You are a stub.", "# Environment\n - nothing to see", "an extra block"]'
key=$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9]/-/g')
mkdir -p "$CLAUDE_CONFIG_DIR/projects/$key"
jq -n -c --arg cwd "$cwd" --arg model "$model" --arg sid "$sid" --arg date "$(date +%Y-%m-%d)" --argjson sp "$sp" '
  {type: "user", sessionId: $sid, cwd: $cwd, message: {role: "user", content: "prompt"}},
  {type: "attachment", attachment: {type: "environment", snapshot: {workingDirectory: $cwd, isGitRepo: false, platform: "darwin"}}},
  {type: "attachment", attachment: {type: "model", identity: {modelId: $model, marketingName: $model, knowledgeCutoff: "never"}, text: "You are \($model)."}},
  {type: "attachment", attachment: {type: "date", date: $date}},
  {type: "attachment", attachment: {type: "session_context", context: {userEmail: "wile.e.coyote@acme.example"}}},
  {type: "attachment", attachment: {type: "credential_org", organizationUuid: "00000000-0000-0000-0000-000000000000"}},
  {type: "attachment", attachment: {type: "prompt_snapshot", systemPrompt: $sp, contextRendering: "announced"}},
  {type: "attachment", attachment: {type: "prompt_snapshot", systemPrompt: $sp, contextRendering: "announced",
    tools: [{name: "Bash"}, {name: "Edit"}, {name: "Read"}, {name: "Write"}], cliPrefix: "You are a stub."}},
  {type: "assistant", sessionId: $sid, message: {model: $model, content: [{type: "text", text: "Done."}]}},
  {type: "attachment", attachment: {type: "edited_text_file", filename: "\($cwd)/out.txt"}}
' > "$CLAUDE_CONFIG_DIR/projects/$key/$sid.jsonl"

# The stream.
seven=0.50
[ "$mode" != quota96 ] || seven=0.96
jq -n -c --arg cwd "$cwd" --arg model "$model" --arg sid "$sid" '
  {type: "system", subtype: "init", cwd: $cwd, session_id: $sid, tools: ["Bash", "Edit", "Read", "Write"],
   mcp_servers: [], model: $model, claude_code_version: "2.1.283"},
  {type: "assistant", message: {model: $model, content: [{type: "thinking", thinking: "hm"}]}},
  {type: "assistant", message: {model: $model, content: [{type: "text", text: "Done."}]}}'
jq -n -c --argjson t "$t" --argjson seven "$seven" '
  {type: "rate_limit_event", rate_limit_info: {status: "allowed", unifiedWindows: {
    five_hour: {utilization: 0.10, resetsAt: ($t + 3600)}, seven_day: {utilization: $seven, resetsAt: ($t + 86400)}}}}'

case $mode in
  noresult) exit 1 ;;
  exit142) kill -ALRM $$ ;;
  slow) sleep "${STUB_SLEEP:-60}" ;;
esac

jq -n -c '{type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.",
  total_cost_usd: 0.001, stop_reason: "end_turn", permission_denials: [],
  usage: {input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}}'
exit 0
