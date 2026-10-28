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

/** A save file with its bytes, as moved by `export-save` and `import-save`. */
export interface SaveBlob extends SaveFile {
  data: ArrayBuffer;
}

export type HostMessage =
  | { type: 'hello' }
  | { type: 'key'; action: 'down' | 'up'; code: string }
  | { type: 'list-saves'; id: string }
  | { type: 'export-save'; id: string; app: string }
  | { type: 'import-save'; id: string; files: SaveBlob[] };

export type EmulatorMessage =
  | { type: 'ready'; capabilities: string[] }
  | { type: 'started'; width: number; height: number }
  | { type: 'saves'; id: string; files: SaveFile[] }
  | { type: 'save-data'; id: string; files: SaveBlob[] }
  | { type: 'import-result'; id: string; imported: number }
  | { type: 'error'; code: ErrorCode };

export type Message = HostMessage | EmulatorMessage;

export type ParseFailure = 'not-envelope' | 'unsupported-version' | 'unknown-type' | 'invalid-fields';

export type ParseResult<M> = { ok: true; message: M } | { ok: false; reason: ParseFailure };

const MAX_STRING = 256;
const MAX_LIST = 1024;
const MAX_DIMENSION = 4096;
/** Limits for save bytes; a message over any of them is refused whole, never truncated. */
export const MAX_SAVE_FILES = 64;
export const MAX_SAVE_FILE_BYTES = 1024 * 1024;
export const MAX_SAVE_TOTAL_BYTES = 4 * 1024 * 1024;
const KEY_CODE = /^[A-Za-z0-9]{1,32}$/;
const GAME_ID = /^[A-Za-z0-9._-]{1,64}$/;

type Fields = Record<string, unknown>;
type Validator = (m: Fields) => boolean;

const isString = (v: unknown, max = MAX_STRING): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isDimension = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_DIMENSION;

/** A save path is `/<app name>/rms/<file>`: absolute, no `..`, no empty segments, no backslashes. */
export function isSavePath(v: unknown): v is string {
  if (!isString(v) || v.includes('\\') || v.includes('\0')) return false;
  const parts = v.split('/');
  return parts.length >= 4 && parts[0] === '' && parts[2] === 'rms' && parts.slice(1).every((p) => p !== '' && p !== '.' && p !== '..');
}

const isSaveBlobs = (v: unknown): boolean => {
  if (!Array.isArray(v) || v.length > MAX_SAVE_FILES) return false;
  let total = 0;
  for (const f of v) {
    if (!isPlainObject(f) || !isSavePath((f as Fields).path) || !((f as Fields).data instanceof ArrayBuffer)) return false;
    const size = ((f as Fields).data as ArrayBuffer).byteLength;
    total += size;
    if (size > MAX_SAVE_FILE_BYTES || total > MAX_SAVE_TOTAL_BYTES) return false;
  }
  return true;
};

/** The game's save directory name, one path segment: the part between the first two slashes of a save path. */
export const isAppName = (v: unknown): v is string =>
  isString(v, 128) && v !== '.' && v !== '..' && !v.includes('/') && !v.includes('\\') && !v.includes('\0');

const isGameId = (v: unknown): boolean => typeof v === 'string' && GAME_ID.test(v);

const hostValidators: Record<HostMessage['type'], Validator> = {
  hello: () => true,
  key: (m) => (m.action === 'down' || m.action === 'up') && typeof m.code === 'string' && KEY_CODE.test(m.code),
  'list-saves': (m) => typeof m.id === 'string' && GAME_ID.test(m.id),
  'export-save': (m) => isGameId(m.id) && isAppName(m.app),
  'import-save': (m) => isGameId(m.id) && isSaveBlobs(m.files),
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
  'save-data': (m) => isGameId(m.id) && isSaveBlobs(m.files),
  'import-result': (m) => isGameId(m.id) && Number.isInteger(m.imported) && (m.imported as number) >= 0 && (m.imported as number) <= MAX_SAVE_FILES,
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
  'export-save': ['id', 'app'],
  'import-save': ['id', 'files'],
  'save-data': ['id', 'files'],
  'import-result': ['id', 'imported'],
  ready: ['capabilities'],
  started: ['width', 'height'],
  saves: ['id', 'files'],
  error: ['code'],
};

function pick(type: string, data: Fields): Fields {
  const out: Fields = { type };
  const withBytes = type === 'import-save' || type === 'save-data';
  for (const k of KNOWN_FIELDS[type]!) {
    out[k] = k === 'files' ? (data.files as Fields[]).map((f) => (withBytes ? { path: f.path, data: f.data } : { path: f.path })) : data[k];
  }
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
