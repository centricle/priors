// The 60 columns of data/trials.csv, in header order, for the /data/ glossary.
//
// The column set is frozen upstream (bin/tally.mjs appends, never renames or
// reorders), and data.ts refuses to load a CSV whose header differs from this
// list, so a new column cannot reach the site without a glossary entry.

export type ColumnGroup =
  | 'identity'
  | 'cost'
  | 'lineage'
  | 'file'
  | 'features'
  | 'answers'
  | 'self-report'
  | 'spelling';

export interface Column {
  name: string;
  group: ColumnGroup;
  meaning: string;
}

export const COLUMNS: Column[] = [
  // identity
  { name: 'run', group: 'identity', meaning: 'Run name: task, mode, model and effort, e.g. circle-sample-claude-haiku-4-5-20251001-low. pilot-import holds the 32 pilot trials.' },
  { name: 'task', group: 'identity', meaning: 'What the model was given: circle, html, svg, replica, sentence, number, digit or word.' },
  { name: 'mode', group: 'identity', meaning: 'sample (independent trials from the same seed), chain (each step starts from the previous step’s output) or pilot (the original 32-trial pilot).' },
  { name: 'profile', group: 'identity', meaning: 'room (stripped Claude Code: four tools, no user config) or harness (the everyday Claude Code setup with the full user config).' },
  { name: 'step', group: 'identity', meaning: 'Trial number within the run, from 1. In a chain it is also the position in the chain.' },
  { name: 'model', group: 'identity', meaning: 'Model id the CLI reports as having answered. In relay runs it rotates by step.' },
  { name: 'model_asked', group: 'identity', meaning: 'Model id or alias passed to the CLI. Differs from model only for the pilot and harness replica, which asked for the alias haiku.' },
  { name: 'effort', group: 'identity', meaning: 'Reasoning effort setting. low on every row.' },
  { name: 'cli_version', group: 'identity', meaning: 'Claude Code CLI version that ran the trial.' },
  { name: 'session_id', group: 'identity', meaning: 'Session UUID of the trial.' },
  { name: 'started_utc', group: 'identity', meaning: 'When the trial started, UTC, ISO 8601.' },

  // cost and behavior
  { name: 'wall_s', group: 'cost', meaning: 'Wall-clock seconds for the trial.' },
  { name: 'cost_usd', group: 'cost', meaning: 'Cost in US dollars as the CLI reported it (API-equivalent value, not a bill).' },
  { name: 'turns', group: 'cost', meaning: 'Number of model turns in the session. Empty for the pilot.' },
  { name: 'output_tokens', group: 'cost', meaning: 'Output tokens the model generated, thinking included. Empty for the pilot.' },
  { name: 'thinking_blocks', group: 'cost', meaning: 'Count of thinking blocks in the session. Empty for the pilot.' },
  { name: 'denials', group: 'cost', meaning: 'Tool calls the permission system refused, such as a Bash command in the stripped room. Empty for the pilot.' },
  { name: 'tool_calls', group: 'cost', meaning: 'Total tool calls the model made.' },
  { name: 'bash_calls', group: 'cost', meaning: 'Bash tool calls (allowed or denied).' },
  { name: 'edit_calls', group: 'cost', meaning: 'Edit plus Write tool calls.' },

  // lineage
  { name: 'input_sha256', group: 'lineage', meaning: 'SHA-256 of the room the trial started with. For a chain step after the first, the previous step’s output.' },
  { name: 'output_sha256', group: 'lineage', meaning: 'SHA-256 of the room after the trial.' },
  { name: 'from_seed', group: 'lineage', meaning: 'True when the input room is byte-identical to the task’s seed. Empty for text tasks, which have no seed file.' },
  { name: 'unchanged', group: 'lineage', meaning: 'True when input and output hashes match: the model left the room exactly as it found it. Empty for text tasks, which have no file.' },

  // the output file
  { name: 'file', group: 'file', meaning: 'Name of the file the model was asked to improve: 0.html, 0.svg, 0.txt or f7b3.html. Empty for text tasks that answer in chat.' },
  { name: 'bytes', group: 'file', meaning: 'Size of the output file in bytes.' },
  { name: 'lines', group: 'file', meaning: 'Lines of text in the output file. A final newline does not add a line: this is wc -l, plus one when the last line has no newline, and 0 for an empty file.' },
  { name: 'extra_files', group: 'file', meaning: 'Files in the room besides the output file, such as scratch files the model created.' },

  // features (artifact tasks)
  { name: 'glow_or_shadow', group: 'features', meaning: 'Output matches box-shadow, drop-shadow, text-shadow, feGaussianBlur, feDropShadow or glow (case-insensitive).' },
  { name: 'glow', group: 'features', meaning: 'Output contains the word glow.' },
  { name: 'keyframes', group: 'features', meaning: 'Output contains @keyframes.' },
  { name: 'radial_gradient', group: 'features', meaning: 'Output uses radial-gradient (CSS) or radialGradient (SVG).' },
  { name: 'linear_gradient', group: 'features', meaning: 'Output uses linear-gradient (CSS) or linearGradient (SVG).' },
  { name: 'pulse', group: 'features', meaning: 'Output contains the word pulse.' },
  { name: 'gradient_667eea', group: 'features', meaning: 'Output contains both #667eea and #764ba2, the purple gradient pair.' },
  { name: 'script', group: 'features', meaning: 'Output contains a <script> tag.' },
  { name: 'nondeterministic', group: 'features', meaning: 'Output calls Math.random or the clock: it contains Math.random, Date.now, new Date, performance.now or getRandomValues. The flag says nothing about whether the render varies.' },
  { name: 'svg_filter', group: 'features', meaning: 'Output contains an SVG <filter> element.' },
  { name: 'hex_count', group: 'features', meaning: 'Number of distinct hex colors in the output.' },
  { name: 'hex_colors', group: 'features', meaning: 'The distinct hex colors, space-separated, lowercase #rrggbb (shorthand expanded, alpha dropped), in order of first appearance.' },

  // text answers
  { name: 'answer_raw', group: 'answers', meaning: 'The model’s answer verbatim: its final message for number, digit and word; the trimmed sentence file for sentence.' },
  { name: 'answer_value', group: 'answers', meaning: 'The answer normalized: a bare number, a lowercase word, or for sentence the sentence itself. Empty when nothing could be extracted.' },
  { name: 'answer_form', group: 'answers', meaning: 'bare when the reply was just the value, framed when it was wrapped in prose, none when no value was found.' },
  { name: 'answer_ok', group: 'answers', meaning: 'Whether the answer met the task’s rule: any number for number, a single digit for digit, a word for word, exactly one word added and none removed for sentence. False when no value was found.' },
  { name: 'words', group: 'answers', meaning: 'Word count of the sentence after the trial (sentence task only).' },
  { name: 'added', group: 'answers', meaning: 'Words added compared with the previous sentence, space-separated (sentence task only).' },
  { name: 'removed', group: 'answers', meaning: 'Words removed compared with the previous sentence, space-separated (sentence task only).' },

  // self-report
  { name: 'result_chars', group: 'self-report', meaning: 'Length in characters of the model’s final message.' },
  { name: 'mentions_server', group: 'self-report', meaning: 'The final message contains server as a whole word (case-insensitive). In the pilot, usually an offer or request to start one.' },

  // spelling
  { name: 'color_p_uk', group: 'spelling', meaning: 'British (-our) forms of the word color and its inflections in the model’s prose: its text messages across the session, code excluded. For the pilot and harness replica, which have no transcript, the final message only.' },
  { name: 'color_p_us', group: 'spelling', meaning: 'American forms of color (color, colored, ...) in the model’s prose, as for color_p_uk.' },
  { name: 'center_p_uk', group: 'spelling', meaning: 'British (-re) forms of the word center and its inflections in prose, as for color_p_uk.' },
  { name: 'center_p_us', group: 'spelling', meaning: 'American forms of center (center, centered, ...) in prose, as for color_p_uk.' },
  { name: 'gray_p_uk', group: 'spelling', meaning: 'British (-ey) forms of the word gray and its inflections in prose, as for color_p_uk.' },
  { name: 'gray_p_us', group: 'spelling', meaning: 'American forms of gray (gray, grayed, grayish) in prose, as for color_p_uk.' },
  { name: 'ize_p_uk', group: 'spelling', meaning: 'British -ise forms of common design verbs (the counterparts of optimize, emphasize, organize and the like) in prose, as for color_p_uk.' },
  { name: 'ize_p_us', group: 'spelling', meaning: '-ize forms of the same verbs (optimize, emphasize, organize, ...) in prose, as for color_p_uk.' },
  { name: 'spell_c_uk', group: 'spelling', meaning: 'British forms across all four families inside the model’s tool inputs (file contents, edits, commands). Empty when the trial has no transcript.' },
  { name: 'spell_c_us', group: 'spelling', meaning: 'American forms across all four families inside the model’s tool inputs. Empty when the trial has no transcript.' },

  // appended after the spelling columns; the glossary lists it under lineage
  { name: 'same_picture', group: 'lineage', meaning: 'True when the trial’s render is pixel-identical to the render of its input (the seed, or the previous chain step), whether or not the file changed. Empty for tasks without a render (the text tasks and sentence).' },
];
