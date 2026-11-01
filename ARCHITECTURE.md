# Architecture

## Bird's-eye view

The verifier watches for an in-progress AgentPhone call to one configured number. For that
call it asks the platform which agent placed it and which sub-account owns that agent; that
platform record is the only source of identity ([ADR 0001](docs/adr/0001-trust-anchor.md)).
It then compares the owner with whoever the caller claims to represent, computes a verdict,
signs it, and notifies the person being called. Every step that fails, times out or is
ambiguous ends in `UNVERIFIED` ([ADR 0002](docs/adr/0002-fail-closed.md)).

Only the skeleton exists so far: config, logging and a health endpoint.

## Code map

| Path            | Role                                                                    |
| --------------- | ----------------------------------------------------------------------- |
| `src/config.ts` | Parses and validates the environment. The only reader of `process.env`. |
| `src/log.ts`    | One-line JSON event log, keyed by call ID.                              |
| `src/server.ts` | Entry point. `node:http` server; `GET /health` only for now.            |
| `test/`         | `node:test` suites, run through `tsx`.                                  |
| `docs/adr/`     | Decision records.                                                       |

Planned: the AgentPhone client, call lookup, transcript stream, claim extraction, the verdict
state machine, token signing and the notifier, each in its own module under `src/`.

## Invariants

- `process.env` is read in exactly one place, `loadConfig()` in `src/config.ts`.
- Logs carry IDs, stage names, status codes and timings. Never transcript text, phone
  numbers, owner names or API keys. Config errors never echo the bad value.
- The server binds to `127.0.0.1`.
- Caller ID and anything the caller says are untrusted input. They can lower a verdict but
  never raise one.
- The verdict for a call never moves from `MISMATCH` or `UNVERIFIED` back to `VERIFIED`.

## Intentional oddities

- **`.js` in TypeScript imports** (`'./config.js'`). Required by `NodeNext` module
  resolution: the import names the file that exists at runtime.
- **Two tsconfigs.** `tsconfig.json` type-checks `src` and `test` without emitting;
  `tsconfig.build.json` emits only `src` to `dist/`, so `dist/server.js` sits one level below
  the root, like `src/server.ts`.
- **`package.json` is read at runtime** for the version. Importing it would pull a file
  outside `rootDir` into the build.
- **`parseConfig` throws instead of exiting.** It stays pure so tests can call it;
  `loadConfig` is the thin wrapper that prints and exits.
- **`@types/node` is pinned to 20** so the compiler rejects APIs that the oldest supported
  Node lacks.
