// Tests for the frozen line format (cc1 + sasusan consortium, 2026-06-07) and
// the encode/decode round-trip that keeps the bridge wire format in parity with
// the obsidian plugin parser.
//
// The format is FROZEN. If a change breaks these, it breaks the plugin too —
// treat the regex/round-trip as a cross-tool contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAT_RE } from '../lib/watcher.mjs';
import { encodeLine, decodeLine } from '../lib/message-codec.mjs';

// The exact regex cc1's plugin confirmed. FLAT_RE must be equivalent — same
// capture order: date, time, agent, instance, message.
const PLUGIN_REGEX = /^\[(?:(\d{4}-\d{2}-\d{2}) )?(\d{2}:\d{2}) ([^\]#]+?)(?:#(\d+))?\] ?(.*)$/;

test('FLAT_RE matches the plugin-confirmed regex source', () => {
  assert.equal(FLAT_RE.source, PLUGIN_REGEX.source);
});

test('decodeLine — plain dateless line (backward compatible)', () => {
  assert.deepEqual(decodeLine('[14:23 yosef] hey there'),
    { agent: 'yosef', time: '14:23', text: 'hey there', instance: null, date: null });
});

test('decodeLine — no-space #N instance marker', () => {
  assert.deepEqual(decodeLine('[14:23 sherlock#2] second hand'),
    { agent: 'sherlock', time: '14:23', text: 'second hand', instance: '2', date: null });
});

test('decodeLine — optional date prefix', () => {
  assert.deepEqual(decodeLine('[2026-06-07 14:23 yosef] dated'),
    { agent: 'yosef', time: '14:23', text: 'dated', instance: null, date: '2026-06-07' });
});

test('decodeLine — non-flat line returns null', () => {
  assert.equal(decodeLine('## Round 1 — a → b'), null);
  assert.equal(decodeLine('just freeform'), null);
});

test('encodeLine — defaults to dateless [HH:MM agent] (no date bloat)', () => {
  assert.equal(encodeLine({ agent: 'yosef', time: '14:23', text: 'hi' }), '[14:23 yosef] hi');
});

test('encodeLine — appends #N for an instance', () => {
  assert.equal(encodeLine({ agent: 'sherlock', instance: '2', time: '14:23', text: 'hi' }),
    '[14:23 sherlock#2] hi');
});

test('encode→decode round-trips agent, instance, and date', () => {
  for (const c of [
    { agent: 'yosef', time: '14:23', text: 'plain' },
    { agent: 'sherlock', instance: '2', time: '14:23', text: 'second hand' },
    { agent: 'ibn-yosef', date: '2026-06-07', time: '00:05', text: 'dated' },
  ]) {
    const d = decodeLine(encodeLine(c));
    assert.equal(d.agent, c.agent);
    assert.equal(d.instance, c.instance ?? null);
    assert.equal(d.date, c.date ?? null);
    assert.equal(d.text, c.text);
  }
});
