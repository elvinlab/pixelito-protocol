import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, isTrustedSender, parseMessage, PROTOCOL_VERSION } from '../src/protocol.ts';

const ok = (r: { ok: boolean }) => assert.equal(r.ok, true);
const fails = (r: { ok: boolean; reason?: string }, reason: string) => {
  assert.equal(r.ok, false);
  assert.equal(r.reason, reason);
};

test('protocol version is 1', () => assert.equal(PROTOCOL_VERSION, 1));

test('every host message type parses and round-trips through envelope', () => {
  for (const m of [
    { type: 'hello' as const },
    { type: 'key' as const, action: 'down' as const, code: 'F1' },
    { type: 'key' as const, action: 'up' as const, code: 'Digit5' },
    { type: 'list-saves' as const, id: 'GAEM' },
  ]) {
    const r = parseMessage(envelope(m), 'host-to-emulator');
    ok(r);
    assert.deepEqual(r.ok && r.message, m);
  }
});

test('every emulator message type parses and round-trips through envelope', () => {
  for (const m of [
    { type: 'ready' as const, capabilities: ['key', 'list-saves'] },
    { type: 'started' as const, width: 240, height: 320 },
    { type: 'saves' as const, id: 'GAEM', files: [{ path: '/GAEM/rms/SAVE0' }] },
    { type: 'error' as const, code: 'bad-key' as const },
    { type: 'error' as const, code: 'unknown-type' as const },
  ]) {
    const r = parseMessage(envelope(m), 'emulator-to-host');
    ok(r);
    assert.deepEqual(r.ok && r.message, m);
  }
});

test('non-envelopes are rejected', () => {
  for (const v of [null, undefined, 'x', 7, [], [{ pixelito: 1 }], {}, { type: 'hello' }, new Date(), Object.create({ pixelito: 1, type: 'hello' })]) {
    fails(parseMessage(v, 'host-to-emulator'), 'not-envelope');
  }
});

test('other protocol versions are rejected, including string "1"', () => {
  for (const v of [0, 2, '1', null, true]) fails(parseMessage({ pixelito: v, type: 'hello' }, 'host-to-emulator'), 'unsupported-version');
});

test('unknown types are rejected, including inherited property names', () => {
  for (const t of ['nope', '', 'constructor', '__proto__', 'toString', 5, undefined]) {
    fails(parseMessage({ pixelito: 1, type: t }, 'host-to-emulator'), 'unknown-type');
  }
});

test('a message is only valid in its own direction', () => {
  fails(parseMessage(envelope({ type: 'hello' as const }), 'emulator-to-host'), 'unknown-type');
  fails(parseMessage(envelope({ type: 'started' as const, width: 1, height: 1 }), 'host-to-emulator'), 'unknown-type');
});

test('key messages reject bad actions and codes', () => {
  const k = (o: object) => parseMessage({ pixelito: 1, type: 'key', ...o }, 'host-to-emulator');
  fails(k({ action: 'press', code: 'F1' }), 'invalid-fields');
  fails(k({ action: 'down' }), 'invalid-fields');
  for (const code of ['', 'F 1', '../x', 'a'.repeat(33), 5, null, 'F1\n']) fails(k({ action: 'down', code }), 'invalid-fields');
});

test('game ids reject path-like and oversized values', () => {
  for (const id of ['', '../etc', 'a/b', 'a b', 'x'.repeat(65), 1, undefined]) {
    fails(parseMessage({ pixelito: 1, type: 'list-saves', id }, 'host-to-emulator'), 'invalid-fields');
  }
});

test('started rejects non-integer, zero, negative and huge sizes', () => {
  for (const [width, height] of [[0, 1], [1, 0], [-1, 5], [1.5, 2], [5000, 2], ['240', 320], [NaN, 1]]) {
    fails(parseMessage({ pixelito: 1, type: 'started', width, height }, 'emulator-to-host'), 'invalid-fields');
  }
});

test('saves rejects malformed file lists', () => {
  const s = (files: unknown) => parseMessage({ pixelito: 1, type: 'saves', id: 'GAEM', files }, 'emulator-to-host');
  for (const files of ['x', null, [null], [{}], [{ path: '' }], [{ path: 5 }], [{ path: 'x'.repeat(257) }], new Array(1025).fill({ path: '/a' })]) {
    fails(s(files), 'invalid-fields');
  }
});

test('error rejects codes outside the known set', () => {
  fails(parseMessage({ pixelito: 1, type: 'error', code: 'boom' }, 'emulator-to-host'), 'invalid-fields');
});

test('extra fields are ignored and dropped from the result', () => {
  const r = parseMessage({ pixelito: 1, type: 'key', action: 'down', code: 'F1', evil: '<script>' }, 'host-to-emulator');
  ok(r);
  assert.deepEqual(r.ok && r.message, { type: 'key', action: 'down', code: 'F1' });
});

test('an own "__proto__" property in the payload does not reach the result', () => {
  const data = JSON.parse('{"pixelito":1,"type":"key","action":"down","code":"F1","__proto__":{"polluted":true}}');
  const r = parseMessage(data, 'host-to-emulator');
  ok(r);
  assert.deepEqual(r.ok && r.message, { type: 'key', action: 'down', code: 'F1' });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('the saves result does not share or leak extra file fields', () => {
  const r = parseMessage({ pixelito: 1, type: 'saves', id: 'G', files: [{ path: '/a', secret: 'x' }] }, 'emulator-to-host');
  ok(r);
  assert.deepEqual(r.ok && r.message, { type: 'saves', id: 'G', files: [{ path: '/a' }] });
});

test('isTrustedSender needs the exact origin AND the expected window', () => {
  const win = {};
  const other = {};
  const allowed = ['https://app.example'];
  assert.equal(isTrustedSender({ origin: 'https://app.example', source: win }, allowed, win), true);
  assert.equal(isTrustedSender({ origin: 'https://evil.example', source: win }, allowed, win), false);
  assert.equal(isTrustedSender({ origin: 'https://app.example', source: other }, allowed, win), false);
  assert.equal(isTrustedSender({ origin: 'https://app.example.evil.com', source: win }, allowed, win), false);
  assert.equal(isTrustedSender({ origin: 'https://app.example/', source: win }, allowed, win), false);
  assert.equal(isTrustedSender({ origin: 'null', source: win }, allowed, win), false);
  assert.equal(isTrustedSender({ origin: 'https://app.example', source: win }, [], win), false);
});

test('isTrustedSender rejects when there is no expected window (source null or undefined)', () => {
  assert.equal(isTrustedSender({ origin: 'https://app.example', source: null }, ['https://app.example'], null), false);
  assert.equal(isTrustedSender({ origin: 'https://app.example', source: undefined }, ['https://app.example'], undefined), false);
});
