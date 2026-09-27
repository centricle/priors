# conditions.jq: a session record -> the conditions a trial started from.
#
# Input: the record as one JSON array of its lines (see `jl` in lib.sh).
# Args:  $room  physical path of the room the trial ran in
#        $sid   the trial's session ID
#        $mask_model  "1" to replace the model's own identity with placeholders,
#                     so records from different models can be compared
#
# Output: the prompt snapshot (system prompt, tools, cliPrefix, rendering
# flags) and every attachment that arrived before the first model response,
# sorted, with the room path, session ID, timestamps and date replaced by
# placeholders. Two trials under the same flags, model and CLI hash equal.
#
# Attachments after the first response are the model's doing (edited-file
# notices and the like), not conditions, so they are left out. credential_org
# is never rendered to the model and carries the org UUID; it is dropped.

def lit: gsub("(?<c>[.*+?^${}()|\\[\\]\\\\])"; "\\\(.c)");
def key_of: gsub("[^A-Za-z0-9]"; "-");

($room | sub("^/private"; "")) as $short
| ($room | key_of) as $key
| def mask:
    walk(if type == "string" then
           gsub($room | lit; "{ROOM}")
           | gsub($short | lit; "{ROOM}")
           | gsub($key | lit; "{ROOM_KEY}")
           | (if $sid == "" then . else gsub($sid | lit; "{SESSION}") end)
           | gsub("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?"; "{TIME}")
           | gsub("[0-9]{4}-[0-9]{2}-[0-9]{2}"; "{DATE}")
         else . end);

. as $lines
| (($lines | map(.type) | index("assistant")) // ($lines | length)) as $first
| ([$lines[] | select(.type == "attachment" and .attachment.type == "prompt_snapshot"
                      and (.attachment.tools | type) == "array")] | first | .attachment) as $snap
| {
    system_prompt: (if $snap == null then null
                    else [$snap.systemPrompt[]? | if type == "string" then . else (.text // tojson) end] end),
    tools: ($snap.tools // null),
    cli_prefix: ($snap.cliPrefix // null),
    snapshot_flags: (if $snap == null then null
                     else $snap | del(.type, .systemPrompt, .tools, .cliPrefix) end),
    attachments: ([$lines[0:$first][]
                   | select(.type == "attachment")
                   | .attachment
                   | select(.type != "prompt_snapshot" and .type != "credential_org")
                   | if $mask_model == "1" and .type == "model"
                     then .identity = "{MODEL}" | .text = "{MODEL}"
                     else . end]
                  | sort_by(.type, tojson))
  }
| mask
