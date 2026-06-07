import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORRWAIT = join(__dirname, '..', 'bin', 'corrwait.mjs');

function makeChatFixture(agent = 'testbot') {
  const dir = mkdtempSync(join(tmpdir(), 'corrwait-write-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, '');
  writeFileSync(
    `${file}.access.json`,
    JSON.stringify({
      owner: 'treebird',
      agents: {
        [agent]: {
          allowed: true,
          joined_at: '2026-05-07T00:00:00.000Z',
        },
      },
    }, null, 2) + '\n'
  );
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runWrite(file, agent, message) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CORRWAIT,
      file,
      '--as',
      agent,
      '--write',
      message,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('corrwait --write appends a flat chat line', async () => {
  const { file, cleanup } = makeChatFixture();
  try {
    const result = await runWrite(file, 'testbot', 'hello');
    assert.equal(result.code, 0);

    const content = readFileSync(file, 'utf8');
    assert.match(content, /^\[\d{2}:\d{2} testbot\] hello\n$/);
  } finally {
    cleanup();
  }
});

test('corrwait --write keeps concurrent writes as complete lines', async () => {
  const { file, cleanup } = makeChatFixture();
  try {
    const [first, second] = await Promise.all([
      runWrite(file, 'testbot', 'first message'),
      runWrite(file, 'testbot', 'second message'),
    ]);

    assert.equal(first.code, 0);
    assert.equal(second.code, 0);

    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(line, /^\[\d{2}:\d{2} testbot\] .+$/);
    }

    const messages = lines
      .map((line) => line.replace(/^\[\d{2}:\d{2} testbot\] /, ''))
      .sort();
    assert.deepEqual(messages, ['first message', 'second message']);
  } finally {
    cleanup();
  }
});

test('corrwait --write emits a WROTE confirmation with verification status', async () => {
  const { file, cleanup } = makeChatFixture();
  try {
    const result = await runWrite(file, 'testbot', 'hello');
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout.trim());
    assert.equal(json.reason, 'WROTE');
    assert.equal(json.agent, 'testbot');
    assert.equal(json.message, 'hello');
    // --as identity is self-claimed → unverified
    assert.equal(json.verified, false);
  } finally {
    cleanup();
  }
});

test('corrwait warns when --as is overridden by an env identity', async () => {
  // ACL allows both names so we reach the write path and observe the warning,
  // rather than bouncing on ACL first.
  const dir = mkdtempSync(join(tmpdir(), 'corrwait-prec-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, '');
  writeFileSync(`${file}.access.json`, JSON.stringify({
    owner: 'treebird',
    agents: { testbot: { allowed: true }, otherbot: { allowed: true } },
  }) + '\n');
  try {
    const result = await new Promise((res, rej) => {
      const child = spawn(process.execPath,
        [CORRWAIT, file, '--as', 'testbot', '--write', 'hi'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ENVOAK_AGENT_LABEL: 'otherbot-m5' } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', rej);
      child.on('close', (code) => res({ code, stdout, stderr }));
    });
    assert.match(result.stderr, /--as testbot ignored/);
    // env identity wins → line is authored by otherbot, and it's verified
    const json = JSON.parse(result.stdout.trim());
    assert.equal(json.agent, 'otherbot');
    assert.equal(json.verified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
