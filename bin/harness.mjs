// harness.mjs --block NAME [--write FILE] <golden.json>...: what the harness
// put in front of the model, as Markdown tables taken from golden records.
//
// A golden record (bin/lib.sh golden_verdict) holds the conditions a trial
// started from: the CLI's prefix sentence, every system-prompt block, every
// tool with its description, and the attachments that arrived before the
// first reply. The records hold the full text. This prints only what the
// README publishes: each block's heading and size in characters, each tool's
// name and description size, the attachment types and their keys, and the
// model identity sentence. The README is never hand-edited in those places;
// rerun this when a golden changes.
//
// The model is read from the key, <profile>-<model>-<effort>-<cli sha12>, and
// the column is labeled with the marketing name the record itself carries.
// Columns run Haiku, Sonnet, Opus, Fable, then any harness-profile record.
//
//   --block NAME   the marker pair to fill: <!-- harness:NAME --> ... <!-- /harness:NAME -->
//   --write FILE   replace the text between the markers in FILE; without it,
//                  print the block to stdout
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
let block = null;
let write = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--block') block = args[++i];
  else if (args[i] === '--write') write = args[++i];
  else files.push(args[i]);
}
if (!block || files.length === 0) {
  console.error('usage: harness.mjs --block NAME [--write FILE] <golden.json>...');
  process.exit(2);
}

const FAMILY = ['haiku', 'sonnet', 'opus', 'fable'];
const KEY = /^([a-z]+)-(.+)-([a-z]+)-([0-9a-f]{12})$/;

const records = files.map((f) => {
  const g = JSON.parse(readFileSync(f, 'utf8'));
  const m = KEY.exec(g.key || '');
  if (!m) throw new Error(`${basename(f)}: key ${JSON.stringify(g.key)} is not <profile>-<model>-<effort>-<sha12>`);
  const [, profile, model] = m;
  const family = FAMILY.findIndex((x) => model.includes(x));
  const identity = (g.conditions.attachments || []).find((a) => a.type === 'model');
  const name = identity?.identity?.marketingName || model;
  return {
    file: f,
    key: g.key,
    made: g.made_utc,
    cliSha: g.cli_sha256,
    profile,
    model,
    label: profile === 'room' ? name : profile === 'harness' ? `${name}, harness replica` : `${name}, ${profile} profile`,
    order: (profile === 'room' ? 0 : 10) + (family < 0 ? 9 : family),
    c: g.conditions,
  };
});
records.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

const fmt = (n) => n.toLocaleString('en-US');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

// A block's label: its heading line, or its first words in a code span so
// that a tag-shaped opening survives a Markdown renderer.
function labelOf(text) {
  const t = text.trim();
  if (t === '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__') return 'Dynamic boundary marker';
  const first = t.split('\n')[0].trim();
  if (/^#+\s/.test(first)) return first.replace(/^#+\s*/, '');
  const words = first.split(/\s+/);
  return '`' + words.slice(0, 7).join(' ') + (words.length > 7 ? ' …' : '') + '`';
}

// Rows in first-seen order across the columns; a repeated label gets a suffix.
function blockRows() {
  const rows = [];
  const index = new Map();
  for (const r of records) {
    const seen = new Map();
    for (const text of r.c.system_prompt || []) {
      let label = labelOf(text);
      const n = (seen.get(label) || 0) + 1;
      seen.set(label, n);
      if (n > 1) label = `${label} (${n})`;
      if (!index.has(label)) {
        index.set(label, rows.length);
        rows.push({ label, sizes: new Map() });
      }
      rows[index.get(label)].sizes.set(r.key, text.length);
    }
  }
  return rows;
}

function table(head, rows) {
  const out = [];
  out.push(`| ${head.map(cell).join(' | ')} |`);
  out.push(`|${head.map(() => '---').join('|')}|`);
  for (const r of rows) out.push(`| ${r.map(cell).join(' | ')} |`);
  return out.join('\n');
}

const columns = records.map((r) => r.label);
const lines = [];

lines.push('Taken from the golden records, one per model:');
lines.push('');
for (const r of records) lines.push(`- \`${r.key}\`, made ${r.made}`);
const shas = [...new Set(records.map((r) => r.cliSha))];
lines.push('');
lines.push(`CLI binary sha256: ${shas.map((s) => `\`${s}\``).join(', ')}.`);
lines.push('');

const prefixes = [...new Set(records.map((r) => r.c.cli_prefix).filter(Boolean))];
if (prefixes.length === 1) {
  lines.push('Every system prompt opens with the CLI prefix sentence:');
  lines.push('');
  lines.push(`> ${prefixes[0]}`);
} else {
  lines.push('The CLI prefix sentence differs by record:');
  lines.push('');
  for (const r of records) lines.push(`- ${r.label}: ${r.c.cli_prefix ?? '(none)'}`);
}
lines.push('');

lines.push('**System prompt blocks**, size in characters. A blank cell means the block was not in that model\'s prompt.');
lines.push('');
const rows = blockRows().map((row) => [row.label, ...records.map((r) => (row.sizes.has(r.key) ? fmt(row.sizes.get(r.key)) : ''))]);
rows.push(['**Blocks**', ...records.map((r) => fmt((r.c.system_prompt || []).length))]);
rows.push(['**Characters**', ...records.map((r) => fmt((r.c.system_prompt || []).reduce((s, t) => s + t.length, 0)))]);
lines.push(table(['Block', ...columns], rows));
lines.push('');

lines.push('**Tools**, description size in characters. A blank cell means the tool was not offered.');
lines.push('');
const toolNames = [];
for (const r of records) for (const t of r.c.tools || []) if (!toolNames.includes(t.name)) toolNames.push(t.name);
toolNames.sort();
const toolRows = toolNames.map((name) => [
  name,
  ...records.map((r) => {
    const t = (r.c.tools || []).find((x) => x.name === name);
    return t ? fmt((t.description || '').length) : '';
  }),
]);
lines.push(table(['Tool', ...columns], toolRows));
lines.push('');

lines.push('**Attached before the first reply**, by type. The environment block is a snapshot with these keys; the model block is the sentence shown.');
lines.push('');
for (const r of records) {
  const parts = [];
  for (const a of r.c.attachments || []) {
    switch (a.type) {
      case 'environment': parts.push(`environment (${Object.keys(a.snapshot || {}).sort().join(', ')})`); break;
      case 'model': parts.push(`model: “${a.text}”`); break;
      case 'session_context': parts.push(`session_context (${Object.keys(a.context || {}).sort().join(', ')})`); break;
      case 'date': parts.push('date'); break;
      default: parts.push(Object.keys(a).filter((k) => k !== 'type').length ? `${a.type} (${Object.keys(a).filter((k) => k !== 'type').sort().join(', ')})` : a.type);
    }
  }
  lines.push(`- **${r.label}:** ${parts.join('; ')}.`);
}

const body = lines.join('\n') + '\n';

if (!write) {
  process.stdout.write(body);
} else {
  const open = `<!-- harness:${block} -->`;
  const close = `<!-- /harness:${block} -->`;
  const src = readFileSync(write, 'utf8');
  const a = src.indexOf(open);
  const b = src.indexOf(close);
  if (a < 0 || b < 0 || b < a) {
    console.error(`${write}: markers ${open} … ${close} not found`);
    process.exit(1);
  }
  const next = src.slice(0, a + open.length) + '\n' + body + src.slice(b);
  if (next !== src) writeFileSync(write, next);
  console.error(`${write}: ${block} ${next === src ? 'unchanged' : 'written'}, ${records.length} records`);
}
