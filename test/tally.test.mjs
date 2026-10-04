// tally.test.mjs: the tally's line counter and answer parsers, on made-up
// input and on the campaign replies that motivated them.
//
//   node --test test/tally.test.mjs
//
// Reads runs/ and tasks/ and never writes: importing bin/tally.mjs does not run
// the tally. The last two tests build the rows (tally() in process, then
// `tally.mjs --check`), which also read renders/ and write nothing either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countLines } from '../bin/lines.mjs';
import { declines, parseColorName, parseGradient, parseHex, parseNumber, parseRgb, parseWord, tally } from '../bin/tally.mjs';

const REPO = new URL('..', import.meta.url).pathname;
const HAIKU = 'claude-haiku-4-5-20251001';

/** The counted trials of one run, from its trials.jsonl. */
const trialsOf = (run) =>
  readFileSync(join(REPO, 'runs', run, 'trials.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((t) => t.counted);
const reply = (run, step) => (trialsOf(run).find((t) => t.step === step)?.result ?? '').trim();

test('countLines: a final newline does not add a line', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines(null), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('\n'), 1);
  assert.equal(countLines('a\n\nb\n'), 3);
  assert.equal(countLines('a\r\nb\r\n'), 2);
});

test('countLines: the circle seed is 30 lines, as wc -l counts it', () => {
  const seed = readFileSync(join(REPO, 'tasks', 'circle', 'seed', '0.html'), 'utf8');
  assert.ok(seed.endsWith('\n'));
  assert.equal(countLines(seed), seed.split('\n').length - 1);
  assert.equal(countLines(seed), 30);
});

test('declines: a question with no bold answer', () => {
  assert.equal(declines('What is the number for?'), true);
  assert.equal(declines('A specific range (like 1-100, or 1-10)?'), true);
  assert.equal(declines('Anything else? If not, I pick **42**.'), false);
  assert.equal(declines('42'), false);
  assert.deepEqual(parseNumber('Like 1-100?', false), { value: '', form: 'none', ok: false });
  assert.deepEqual(parseWord("Could you give me more context? I'll choose one!"), { value: '', form: 'none', ok: false });
  assert.deepEqual(parseNumber('I choose 7.', false), { value: '7', form: 'framed', ok: true });
  assert.deepEqual(parseWord('**lantern**'), { value: 'lantern', form: 'bare', ok: true });
});

test('declines: Haiku number 007 and 055 and word 051 record no answer', () => {
  const number = `number-sample-${HAIKU}-low`, word = `word-sample-${HAIKU}-low`;
  const none = { value: '', form: 'none', ok: false };
  assert.deepEqual(parseNumber(reply(number, 7), false), none);
  assert.deepEqual(parseNumber(reply(number, 55), false), none, 'read "1" out of "like 1-100" before');
  assert.deepEqual(parseWord(reply(word, 51)), none, 'read "one" out of "I\'ll choose one" before');
  // Asks, then commits in bold: an answer, and it stays one.
  assert.deepEqual(parseNumber(reply(number, 18), false), { value: '42', form: 'framed', ok: true });
});

test('declines: exactly those three replies in the campaign', () => {
  const flagged = [];
  for (const run of readdirSync(join(REPO, 'runs')).sort()) {
    if (run === 'pilot' || !existsSync(join(REPO, 'runs', run, 'trials.jsonl'))) continue;
    for (const t of trialsOf(run)) {
      if (['number', 'digit', 'word'].includes(t.task) && declines((t.result ?? '').trim())) flagged.push(`${t.task}/${t.step}`);
    }
  }
  assert.deepEqual(flagged, ['number/7', 'number/55', 'word/51']);
});

test('unchanged: empty for the text tasks, which have no file to leave alone', () => {
  const rows = tally();
  const text = rows.filter((r) => ['number', 'digit', 'word'].includes(r.task));
  assert.ok(text.length > 0);
  // Their room is empty before and after, so the hashes match without meaning anything.
  assert.ok(text.every((r) => r.input_sha256 === r.output_sha256));
  assert.ok(text.every((r) => r.unchanged === null && r.from_seed === null));
  assert.ok(rows.filter((r) => r.file).every((r) => typeof r.unchanged === 'boolean'));
  assert.equal(rows.filter((r) => r.unchanged === null).length, text.length);
});

test('color parsers: hex, rgb and gradient answers all become #rrggbb', () => {
  const none = { value: '', form: 'none', ok: false };
  assert.deepEqual(parseHex('#3B82F6'), { value: '#3b82f6', form: 'bare', ok: true });
  assert.deepEqual(parseHex('`#2A9D8F` — a muted teal.'), { value: '#2a9d8f', form: 'framed', ok: true });
  assert.deepEqual(parseHex('#2E86AB (teal blue) and #F24236 (orange-red)', 2), { value: '#2e86ab #f24236', form: 'framed', ok: true });
  assert.deepEqual(parseHex('#1E3A8A and #F59E0B', 2), { value: '#1e3a8a #f59e0b', form: 'bare', ok: true });
  // Haiku hex2 008 leaves the # off its second color, so it names one.
  assert.deepEqual(parseHex('- **#3498DB** — A vibrant blue\n- **FF6B6B** — A coral', 2), { value: '#3498db', form: 'framed', ok: false });
  assert.deepEqual(parseHex('What is it for?'), none);
  assert.deepEqual(parseRgb('RGB(70, 130, 180) — Steel Blue.'), { value: '#4682b4', form: 'framed', ok: true });
  assert.deepEqual(parseRgb('rgb(42, 157, 143)'), { value: '#2a9d8f', form: 'bare', ok: true });
  assert.equal(parseRgb('(300, 0, 0)').ok, false);
  assert.deepEqual(parseGradient('```css\nbackground: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n```'), { value: '#667eea #764ba2', form: 'bare', ok: true });
  // The first gradient is the answer; a variation after it is not.
  assert.deepEqual(
    parseGradient('Here:\n```css\nbackground: linear-gradient(to right, #ff0000, #00ff00, #0000ff);\n```\nAlso linear-gradient(45deg, #667eea, #764ba2).'),
    { value: '#ff0000 #00ff00 #0000ff', form: 'framed', ok: true });
  assert.equal(parseGradient('background: radial-gradient(circle, rgba(255, 0, 0, 0.5), blue);').value, '#ff0000 blue');
  assert.deepEqual(parseGradient('Which colors?'), none);
});

test('parseColorName: opening with a color or picking one is an answer, mentioning one is not', () => {
  const none = { value: '', form: 'none', ok: false };
  const blue = { value: 'blue', form: 'framed', ok: true };
  assert.deepEqual(parseColorName('Teal.'), { value: 'teal', form: 'bare', ok: true });
  assert.deepEqual(parseColorName("Blue. It's calming and versatile."), blue);
  assert.deepEqual(parseColorName("I'll go with **slate blue** – a nice balanced color."), blue);
  assert.deepEqual(parseColorName("I don't experience color, but if I had to pick, I'd say deep blue: the shade of the sky just after sunset."), blue);
  assert.equal(parseColorName('Probably a deep blue-green, like teal.').value, 'blue-green');
  assert.equal(parseColorName("I don't have one in the way you do, but if I had to pick: a deep teal.").value, 'teal');
  assert.deepEqual(parseColorName("That's subjective. If it helps, blue is the most commonly preferred color across surveys."), none);
  assert.deepEqual(parseColorName('It depends:\n- **For design**: **blue** is often cited\n- **For visibility**: yellow'), none);
  assert.deepEqual(parseColorName("I don't have personal preferences like a favorite color—I'm an AI assistant."), none);
});

test('campaign 2: the counts the color parsers were written against', () => {
  const rows = tally(join(REPO, 'campaign-2.tsv'));
  const F = 'claude-fable-5-1', O = 'claude-opus-5-5', S = 'claude-sonnet-5';
  const of = (task, model) => rows.filter((r) => r.task === task && r.model_asked === model);
  const count = (task, model, value) => of(task, model).filter((r) => r.answer_value === value).length;
  const none = (task, model) => of(task, model).filter((r) => r.answer_form === 'none').length;
  assert.equal(rows.length, 3792);
  for (const m of [F, O, S]) assert.equal(count('color', m, 'teal'), 100);
  assert.equal(count('color', HAIKU, 'blue'), 87);
  assert.equal(count('gradient', S, '#667eea #764ba2'), 98);
  for (const m of [F, O, S, HAIKU]) assert.equal(count('hex', m, '#667eea'), 0);
  for (const m of [F, O]) assert.equal(count('button', m, '#2563eb'), 100);
  // Sonnet and Haiku decline both questions; Fable and Opus answer both.
  assert.deepEqual([none('favorite', S), none('favorite', HAIKU), none('best', S), none('best', HAIKU)], [94, 99, 98, 100]);
  assert.deepEqual([none('favorite', F), none('favorite', O), none('best', F), none('best', O)], [0, 0, 0, 0]);
  assert.equal(rows.filter((r) => r.task === 'hex2' && !r.answer_ok).length, 1);
  assert.ok(of('colorize', F).every((r) => r.answer_ok && r.unchanged === false));
});

test('campaign 2: a seed no trial left alone borrows its render from the first campaign', () => {
  const rows = tally(join(REPO, 'campaign-2.tsv'));
  const of = (task) => rows.filter((r) => r.task === task);
  assert.deepEqual([of('colorize').length, of('html').length, of('svg').length], [128, 32, 32]);
  // Every colorize and control html trial changed its file, so neither has a render of its own seed.
  assert.ok([...of('colorize'), ...of('html')].every((r) => r.unchanged === false));
  // Colorize always changes the picture. The control's html edits never do: a blank page stays blank.
  assert.ok(of('colorize').every((r) => r.same_picture === false));
  assert.ok(of('html').every((r) => r.same_picture === true));
  // The svg control has seed renders of its own: 22 files left alone, 6 pictures changed.
  assert.equal(of('svg').filter((r) => r.unchanged).length, 22);
  assert.equal(of('svg').filter((r) => r.same_picture === false).length, 6);
  const out = execFileSync(process.execPath, [join(REPO, 'bin', 'tally.mjs'), '--campaign', join(REPO, 'campaign-2.tsv'), '--check'], { encoding: 'utf8' });
  assert.match(out, /^ok: 3792 rows/);
});

test('tally: the default covers campaign.tsv and the imported pilot, nothing later', () => {
  const listed = new Set(readFileSync(join(REPO, 'campaign.tsv'), 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')[0]));
  const rows = tally();
  assert.ok(rows.every((r) => listed.has(r.run) || r.run === 'pilot-import'));
  assert.equal(rows.filter((r) => r.mode !== 'pilot').length, 2608);
  assert.equal(rows.filter((r) => r.mode === 'pilot').length, 32);
});

test('tally --check: pilot acceptance counts, seed hashes and input renders', () => {
  const out = execFileSync(process.execPath, [join(REPO, 'bin', 'tally.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /^ok: /);
});
