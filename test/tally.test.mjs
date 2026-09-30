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
import { declines, parseNumber, parseWord, tally } from '../bin/tally.mjs';

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

test('tally --check: pilot acceptance counts, seed hashes and input renders', () => {
  const out = execFileSync(process.execPath, [join(REPO, 'bin', 'tally.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /^ok: /);
});
