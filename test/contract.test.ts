import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, isTrustedSender, MAX_SAVE_FILE_BYTES, MAX_SAVE_FILES, MAX_SAVE_TOTAL_BYTES, parseMessage, PROTOCOL_VERSION } from '../src/protocol.ts';

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

const blob = (path: string, bytes = 4) => ({ path, data: new ArrayBuffer(bytes) });
const GOOD = '/Rally Master Pro/rms/FL_RMP_OPT';

test('save export and import messages round-trip through envelope', () => {
  for (const m of [
    { type: 'export-save' as const, id: 'GAEM', app: 'Rally Master Pro' },
    { type: 'import-save' as const, id: 'GAEM', files: [blob(GOOD)] },
  ]) {
    const r = parseMessage(envelope(m), 'host-to-emulator');
    ok(r);
    assert.deepEqual(r.ok && r.message, m);
  }
  for (const m of [
    { type: 'save-data' as const, id: 'GAEM', files: [blob(GOOD)] },
    { type: 'import-result' as const, id: 'GAEM', imported: 1 },
  ]) {
    const r = parseMessage(envelope(m), 'emulator-to-host');
    ok(r);
    assert.deepEqual(r.ok && r.message, m);
  }
});

test('save paths must stay under /<app>/rms/', () => {
  for (const path of ['/a/rms/../app.jar', '/a/config/x', 'a/rms/x', '/a/rms/', '/a//rms/x', '/a/rms/x\\y', '/rms/x', '/a/rms/./x']) {
    fails(parseMessage(envelope({ type: 'import-save', id: 'GAEM', files: [blob(path)] }), 'host-to-emulator'), 'invalid-fields');
  }
});

test('save bytes must be an ArrayBuffer within the size limits', () => {
  const send = (files: unknown[]) => parseMessage({ pixelito: 1, type: 'import-save', id: 'GAEM', files }, 'host-to-emulator');
  fails(send([{ path: GOOD, data: 'text' }]), 'invalid-fields');
  fails(send([{ path: GOOD, data: new Uint8Array(4) }]), 'invalid-fields');
  fails(send([blob(GOOD, MAX_SAVE_FILE_BYTES + 1)]), 'invalid-fields');
  ok(send([blob(GOOD, MAX_SAVE_FILE_BYTES)]));
  fails(send(Array.from({ length: MAX_SAVE_FILES + 1 }, (_, i) => blob(`/a/rms/${i}`))), 'invalid-fields');
  const files = Array.from({ length: 5 }, (_, i) => blob(`/a/rms/${i}`, MAX_SAVE_FILE_BYTES));
  assert.ok(files.length * MAX_SAVE_FILE_BYTES > MAX_SAVE_TOTAL_BYTES);
  fails(send(files), 'invalid-fields');
});

test('import-result rejects negative, fractional and huge counts', () => {
  for (const imported of [-1, 1.5, MAX_SAVE_FILES + 1, '1']) {
    fails(parseMessage({ pixelito: 1, type: 'import-result', id: 'GAEM', imported }, 'emulator-to-host'), 'invalid-fields');
  }
});

test('save messages are only valid in their own direction and drop extra fields', () => {
  fails(parseMessage(envelope({ type: 'export-save', id: 'GAEM', app: 'A' }), 'emulator-to-host'), 'unknown-type');
  fails(parseMessage(envelope({ type: 'import-result', id: 'GAEM', imported: 1 }), 'host-to-emulator'), 'unknown-type');
  const r = parseMessage({ pixelito: 1, type: 'import-save', id: 'GAEM', files: [{ ...blob(GOOD), extra: 1 }], x: 1 }, 'host-to-emulator');
  ok(r);
  assert.deepEqual(Object.keys(r.ok ? (r.message as { files: object[] }).files[0]! : {}), ['path', 'data']);
});

test('export-save needs a one-segment app name', () => {
  for (const app of ['', '..', '.', 'a/b', '/a', 'a\\b', 'x'.repeat(129), 5, undefined]) {
    fails(parseMessage({ pixelito: 1, type: 'export-save', id: 'GAEM', app }, 'host-to-emulator'), 'invalid-fields');
  }
  ok(parseMessage({ pixelito: 1, type: 'export-save', id: 'GAEM', app: 'Rally Master Pro' }, 'host-to-emulator'));
});
