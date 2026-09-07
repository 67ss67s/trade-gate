# @trade-gate/gateway

TS network/control-plane process. **Foundation layer** (see
§15.1): just the two pieces everything else in the gateway will sit on top of —

- `src/exec-client.ts` — `ExecClient`, the UDS JSON-RPC client for execd (the only thing in this
  process allowed to talk to execd; see the house rule — no exchange credentials or direct
  exchange connections belong anywhere in `packages/gateway`).
- `src/state-db.ts` — `openStateDb`, gateway's own `state.sqlite` (schema + migrator + the
  `events`/`kv` DAOs actually needed right now; every other table from
  docs/contracts/README.md §9 exists as schema only).

Nothing here reads or writes `exec.sqlite` (execd's own database) or exchange credentials.

## `ExecClient`

```ts
import { ExecClient } from '@trade-gate/gateway';

const client = new ExecClient(); // socketPath defaults to ~/.trade-gate/run/execd.sock
const health = await client.call('exec.health', {});
const sub = client.subscribe(0, (event) => console.log(event.event, event.seq));
// ...
sub.unsubscribe();
client.close();
```

- `call(method, params, {timeoutMs?})` — typed per method via `ExecMethods` (from
  `@trade-gate/contracts`); default 10s, 30s for `exec.account.snapshot`
  (docs/contracts/README.md §8). Rejects with `ExecRpcError` (code/kind/retryable/details) on a
  JSON-RPC error frame, or **`ExecTimeout`** if nothing came back in time.
- **A timeout is not a failure.** For a write method (`exec.intent.propose`,
  `exec.intent.authorize`, ...), execd may have already committed the effect before the response
  was lost. Catching `ExecTimeout` on a write means: call `exec.intent.get` (matched by the
  intent/idempotency key you sent) before deciding whether to retry or surface a failure — see
  `ExecTimeout`'s doc comment in `exec-client.ts`. Read methods can typically just be retried.
- `subscribe(sinceSeq, onEvent)` — delivers `exec.event` notifications in strict seq order;
  duplicates and out-of-order arrivals are dropped and counted (`handle.stats()`), never
  buffered/reordered. Survives reconnects by re-issuing `exec.events.subscribe` with the last
  delivered seq once the socket comes back (execd backfills the gap). One subscription per client.
- Reconnects automatically on disconnect with exponential backoff (`minReconnectDelayMs` →
  `maxReconnectDelayMs`, default 250ms → 10s); calls made while disconnected queue and send once
  reconnected, same as calls made before the very first connect completes.
- `client.connected` is true only once the socket's own `'connect'` event has fired — not merely
  "a socket object exists," which is true well before the handshake completes (see the getter's
  doc comment if you're tempted to poll this for anything timing-sensitive: the *server* seeing
  the connection is a separate, independently-ordered event).

## `openStateDb`

```ts
import { openStateDb } from '@trade-gate/gateway';

const db = openStateDb('/path/to/state.sqlite'); // creates the file + runs migrations if needed
db.appendEvent({ event: 'run.started', at: Date.now(), source: 'gateway', json: '{}' });
const recent = db.eventsSince(0);
db.kvSet('policy_version', '3');
db.close();
```

`node:sqlite`'s `DatabaseSync`, WAL journal mode, `foreign_keys=ON`, `busy_timeout=5000`. Migrations
live in `src/migrations/*.sql` (currently just `0001_init.sql`), tracked in `schema_migrations`,
applied one file per transaction, idempotent — re-opening an already-migrated database is a no-op.
Add a new numbered file for further schema changes; don't edit a shipped one (the migrator keys
off the filename, so an edited-in-place file silently never re-runs against existing databases).

`db.db` is the raw `DatabaseSync` handle, for anything beyond the three DAO methods
(`appendEvent`/`eventsSince`/`kvGet`/`kvSet`) this package provides today.

## Tests

```
npm run test
```

`test/helpers/fake-execd.ts` is a minimal hand-rolled NDJSON JSON-RPC server (not a mock of
execd's actual business logic — just enough wire protocol to drive `ExecClient` from the outside)
used by `test/exec-client.test.ts` to cover request/response correlation, `ExecTimeout`, in-order
event delivery with duplicate/out-of-order counting, reconnect-and-resubscribe, and oversized
frames. It listens on a short `/tmp/tg-t-<random>.sock` path — UDS paths are capped at 104 bytes on
macOS, which this session's own scratch directory does not fit under, so tests never use it for
sockets. `test/state-db.test.ts` covers the migrator (including idempotency) and the DAOs against
a temp-directory sqlite file per test.

## Agent 辅助仓位

`demo/sizing-agent.ts` 使用 cheap brain 提供有界意见；`demo/gates.ts` 计算数量并执行名义/流动性上限，组合硬闸仍只拒不改。默认 `workflow.sizing_agent=advise`，详见 `design notes`。离线验证：`npx vitest run`（stub brains + 本地假行情）、`npx tsc -b`。
