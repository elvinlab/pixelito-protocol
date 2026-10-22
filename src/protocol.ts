/**
 * Pixelito bridge protocol, version 1.
 *
 * Messages travel between the host app and the emulator iframe with
 * `postMessage`. Every message is a plain object: `{ pixelito: 1, type, ...fields }`.
 * Receivers must validate with `parseMessage` and check the sender with
 * `isTrustedSender` before acting on anything.
 */

export const PROTOCOL_VERSION = 1;

export type Direction = 'host-to-emulator' | 'emulator-to-host';

export type ErrorCode = 'unknown-type' | 'bad-key';

export interface SaveFile {
  path: string;
}

export type HostMessage =
  | { type: 'hello' }
  | { type: 'key'; action: 'down' | 'up'; code: string }
  | { type: 'list-saves'; id: string };

export type EmulatorMessage =
  | { type: 'ready'; capabilities: string[] }
  | { type: 'started'; width: number; height: number }
  | { type: 'saves'; id: string; files: SaveFile[] }
  | { type: 'error'; code: ErrorCode };

export type Message = HostMessage | EmulatorMessage;

export type ParseFailure = 'not-envelope' | 'unsupported-version' | 'unknown-type' | 'invalid-fields';

export type ParseResult<M> = { ok: true; message: M } | { ok: false; reason: ParseFailure };

const MAX_STRING = 256;
const MAX_LIST = 1024;
const MAX_DIMENSION = 4096;
const KEY_CODE = /^[A-Za-z0-9]{1,32}$/;
const GAME_ID = /^[A-Za-z0-9._-]{1,64}$/;

type Fields = Record<string, unknown>;
type Validator = (m: Fields) => boolean;

const isString = (v: unknown, max = MAX_STRING): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isDimension = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_DIMENSION;

const hostValidators: Record<HostMessage['type'], Validator> = {
  hello: () => true,
  key: (m) => (m.action === 'down' || m.action === 'up') && typeof m.code === 'string' && KEY_CODE.test(m.code),
  'list-saves': (m) => typeof m.id === 'string' && GAME_ID.test(m.id),
};

const emulatorValidators: Record<EmulatorMessage['type'], Validator> = {
  ready: (m) => Array.isArray(m.capabilities) && m.capabilities.length <= MAX_LIST && m.capabilities.every((c) => isString(c, 64)),
  started: (m) => isDimension(m.width) && isDimension(m.height),
  saves: (m) =>
    typeof m.id === 'string' &&
    GAME_ID.test(m.id) &&
    Array.isArray(m.files) &&
    m.files.length <= MAX_LIST &&
    m.files.every((f) => isPlainObject(f) && isString((f as Fields).path)),
  error: (m) => m.code === 'unknown-type' || m.code === 'bad-key',
};

function isPlainObject(v: unknown): v is Fields {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate a received `event.data`. Extra fields are ignored for forward
 * compatibility; the returned message contains only the known fields.
 */
export function parseMessage(data: unknown, direction: 'host-to-emulator'): ParseResult<HostMessage>;
export function parseMessage(data: unknown, direction: 'emulator-to-host'): ParseResult<EmulatorMessage>;
export function parseMessage(data: unknown, direction: Direction): ParseResult<Message> {
  if (!isPlainObject(data) || !Object.hasOwn(data, 'pixelito')) return { ok: false, reason: 'not-envelope' };
  if (data.pixelito !== PROTOCOL_VERSION) return { ok: false, reason: 'unsupported-version' };
  const validators: Record<string, Validator> = direction === 'host-to-emulator' ? hostValidators : emulatorValidators;
  const type = data.type;
  if (typeof type !== 'string' || !Object.hasOwn(validators, type)) return { ok: false, reason: 'unknown-type' };
  if (!validators[type]!(data)) return { ok: false, reason: 'invalid-fields' };
  return { ok: true, message: pick(type, data) as Message };
}

const KNOWN_FIELDS: Record<string, string[]> = {
  hello: [],
  key: ['action', 'code'],
  'list-saves': ['id'],
  ready: ['capabilities'],
  started: ['width', 'height'],
  saves: ['id', 'files'],
  error: ['code'],
};

function pick(type: string, data: Fields): Fields {
  const out: Fields = { type };
  for (const k of KNOWN_FIELDS[type]!) out[k] = k === 'files' ? (data.files as Fields[]).map((f) => ({ path: f.path })) : data[k];
  return out;
}

/** Build a message with the protocol version attached. */
export function envelope<M extends Message>(message: M): M & { pixelito: typeof PROTOCOL_VERSION } {
  return { pixelito: PROTOCOL_VERSION, ...message };
}

export interface SenderCheck {
  origin: string;
  source: unknown;
}

/**
 * A sender is trusted only when its origin matches one of the fixed allowed
 * origins exactly AND its window is the one we expect (the iframe for the
 * host, `window.parent` for the emulator). The allowlist must be compiled in,
 * never read from a URL or from a message.
 */
export function isTrustedSender(event: SenderCheck, allowedOrigins: readonly string[], expectedSource: unknown): boolean {
  if (expectedSource === null || expectedSource === undefined) return false;
  if (event.source !== expectedSource) return false;
  return allowedOrigins.includes(event.origin);
}
