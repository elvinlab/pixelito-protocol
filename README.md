# pixelito-protocol

Versioned `postMessage` protocol between the Pixelito host app and the emulator iframe, with validators and contract tests. MIT licensed. **Draft, version 1, not yet used by the emulator or the app.**

Both sides must:

1. Check the sender with `isTrustedSender`: exact origin from a fixed, compiled-in allowlist **and** the expected window (the iframe for the host, `window.parent` for the emulator). Never read the allowlist from a URL or a message.
2. Validate `event.data` with `parseMessage` before acting. Anything invalid is ignored silently, never answered.
3. Reply with an explicit target origin, never `*`.

Messages in v1 (`{ pixelito: 1, type, ... }`): host to emulator `hello`, `key`, `list-saves`, `export-save`, `import-save`; emulator to host `ready`, `started`, `saves`, `save-data`, `import-result`, `error`. Save bytes travel as `ArrayBuffer`; paths must be `/<app>/rms/<file>` and size limits apply (`MAX_SAVE_FILES`, `MAX_SAVE_FILE_BYTES`, `MAX_SAVE_TOTAL_BYTES`). Design notes and evidence are in the Pixelito docs (`docs/notes/bridge-protocol.md`).

Extra fields are ignored and dropped. Exact key-code validity belongs to the emulator (it answers `error: bad-key`); this package only checks the shape.

## Develop

Requires Node 24 (runs TypeScript directly, no build, no dependencies).

```
pnpm test
```

## Known gaps

- No type checker is wired in yet (adding `typescript` is a dependency decision).
- The ID, path, and size limits (`GAME_ID`, 256-character paths, 4096 px) are guesses to confirm against real emulator behaviour.
- Tests were written by the same author as the code; an independent review is advised before the emulator and app depend on it.
- `load`, `suspend`, `resume`, `volume`, pointer events are not part of v1 yet.
