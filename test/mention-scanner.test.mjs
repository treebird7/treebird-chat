import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanForMentions, shortName } from '../lib/mention-scanner.mjs';

describe('shortName', () => {
  it('strips machine suffix', () => {
    assert.equal(shortName('birdsan-m2'), 'birdsan');
    assert.equal(shortName('watsan-m5'), 'watsan');
    assert.equal(shortName('yosef'), 'yosef');
  });
});

describe('scanForMentions', () => {
  const lines = [
    '# header line — not a flat line',
    '[10:00 yosef] hello everyone',
    '[10:01 treebird] @birdsan can you check the bridge?',
    '[10:02 birdsan] on it',
    '[10:03 yosef] @birdsan-m2 one more thing',
    '[10:04 sherlocksan] @watsan take a look at this',
    '[10:05 yosef] @BirdSan case insensitive check',
    '[10:06 treebird] talking about @birdsanother project',
    '[10:07 treebird] no mention here',
  ];

  it('finds all @birdsan and @birdsan-m2 mentions', () => {
    const { mentions } = scanForMentions(lines, 'birdsan-m2', 0);
    assert.equal(mentions.length, 3);
    assert.deepEqual(mentions.map(m => m.author), ['treebird', 'yosef', 'yosef']);
    assert.deepEqual(mentions.map(m => m.time), ['10:01', '10:03', '10:05']);
  });

  it('skips self-authored lines', () => {
    const { mentions } = scanForMentions(lines, 'birdsan-m2', 0);
    assert.ok(mentions.every(m => m.author !== 'birdsan'));
  });

  it('does not match @birdsanother (prefix check)', () => {
    const { mentions } = scanForMentions(lines, 'birdsan-m2', 0);
    assert.ok(mentions.every(m => !m.text.includes('birdsanother')));
  });

  it('respects fromLine cursor', () => {
    // fromLine=4 skips lines 0-3; first match is line 4 (@birdsan-m2)
    const { mentions } = scanForMentions(lines, 'birdsan-m2', 4);
    assert.equal(mentions.length, 2);
    assert.equal(mentions[0].time, '10:03');
    assert.equal(mentions[1].time, '10:05');
  });

  it('returns newCursor = lines.length', () => {
    const { newCursor } = scanForMentions(lines, 'birdsan-m2', 0);
    assert.equal(newCursor, lines.length);
  });

  it('returns empty for agent with no mentions', () => {
    const { mentions } = scanForMentions(lines, 'spidersan-m5', 0);
    assert.equal(mentions.length, 0);
  });

  it('does not match mentions of a different agent', () => {
    const { mentions } = scanForMentions(lines, 'watsan-m2', 0);
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].author, 'sherlocksan');
  });

  it('fromLine past end returns empty', () => {
    const { mentions, newCursor } = scanForMentions(lines, 'birdsan-m2', 999);
    assert.equal(mentions.length, 0);
    assert.equal(newCursor, lines.length);
  });

  it('does not fire on @mention inside backticks', () => {
    const backtickLines = [
      '[10:10 yosef] run `@birdsan` to invoke the tool',
      '[10:11 yosef] or use ``@birdsan-m2`` as shown',
    ];
    const { mentions } = scanForMentions(backtickLines, 'birdsan-m2', 0);
    assert.equal(mentions.length, 0, 'backtick-wrapped @mentions must not fire');
  });

  it('still fires on @mention outside backticks in same line', () => {
    const mixedLines = [
      '[10:12 yosef] see `code` then @birdsan can you check?',
    ];
    const { mentions } = scanForMentions(mixedLines, 'birdsan-m2', 0);
    assert.equal(mentions.length, 1);
  });
});
