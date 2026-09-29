# pilot-import

The pilot: 32 runs of `claude --model haiku --effort low -p 'improve f7b3.html'`
from 2026-09-25, before the runner existed. It ran in an ordinary Claude Code
setup, not the clean room, so its rows are `profile: "harness"` and
`mode: "pilot"`. The `replica` runs repeat it under controlled conditions.

`bin/pilot-import.sh` rebuilds this directory from the pilot's git history.
Each `NNN/f7b3.html` is that run's output, and `trials.jsonl` has one row per
run in the campaign's columns. Anything the pilot never recorded (argv, CLI
hash, tokens, turns, rate limits) is null.

- **`prompt.sh` is a reconstruction.** It is the loop as it was left on disk
  after the run, edited afterwards, not a verbatim record of what executed.
- **Runs 24 to 27 did not start from the seed.** The loop reset the file only
  after a successful screen capture, and runs 23 to 26 have none, so each of
  the next runs edited the previous output. `input_sha256` records this: those
  four rows differ from the seed's hash.
- **`result` is the commit message**, which is the model's stdout with the
  surrounding whitespace that git trims removed.
- The original screen captures are window grabs of a real desktop and are not
  published. Renders come from `bin/shot.sh`, the same as every other run.
