# Architecture

TradeGate is one Node process (the **gateway**), one static web UI, and an optional Rust executor. The
gateway owns the loop, the sqlite state and the HTTP/SSE API; the UI is a pure client of that API; every
exchange credential lives outside the TypeScript process.

```
 ┌─────────────────────────────── gateway (packages/gateway, Node ≥ 24) ───────────────────────────────┐
 │                                                                                                      │
 │  RADAR            THESIS               STRATEGY          RISK             EXECUTION                  │
 │  info.ts          context.ts           strategies.ts     gates.ts         threads.ts                 │
 │  screener.ts      graph.ts             backtest.ts       workflow.ts      execution.ts (paper/demo)  │
 │  radar.ts         schema.ts                              triggers.ts      execution-cli.ts           │
 │  market.ts        brain.ts                                                execution-agent.ts         │
 │  indicators.ts    chat.ts                                                 outcome.ts                 │
 │        └──────────────┴──────── runtime.ts (the loop, queue.ts, fingerprint.ts) ──────┘              │
 │                                    store.ts (sqlite) · http.ts (+ routes-*.ts, SSE)                  │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
          ▲ HTTP + SSE                              │ child processes                    │ UDS (optional)
 ┌────────┴────────┐                    ┌───────────┴───────────┐               ┌────────┴────────┐
 │ webui (Vite/React)│                  │ claude · codex · pi   │               │ execd (Rust)    │
 │ home · intel ·   │                   │ binance-cli           │               │ exec-core       │
 │ screener · …     │                   │ (hold their own auth) │               │ (demo key)      │
 └──────────────────┘                   └───────────────────────┘               └─────────────────┘
```

## The loop

`DemoRuntime` (`runtime.ts`) runs three clocks:

| Clock | Cadence | What wakes up |
|---|---|---|
| Information officer | `info_every_ms` (default 30 min) | `info.ts`: fetch tickers / funding / OI / ratios / RSS → `InformationEvent[]` → cheap-brain summary → `MarketState` |
| K-line close | per `timeframe` (default 15 m) | for every watch-list symbol without an open thread: `triggers.ts` decides whether a **scan** is due (`scan_mode` = `triggered` or `every_close`); open threads get a **review** |
| Tick | 10 s | `threads.ts` re-derives every thread's status from exchange facts (entry order, position, protective legs) and fires the resulting transitions |

Scans and reviews are serialised through `queue.ts` (one model call at a time, heartbeat de-duplicated by
`fingerprint.ts` so a quiet market does not burn judgments). Every model call becomes an **episode**.

## An episode

```
episode {
  id, symbol, mode: scan | review, thread_id?
  evidence[]        E1..En — id, kind, title, text, observed_at, source, stale
  context_text      the exact prompt the model saw  (+ sha256)
  allowed_actions   from graph.ts for this node
  judgment_raw      the model's text
  judgment          parsed + validated, or null
  errors[]          validation / repair-round errors
  gates[]           name, passed, reason  (RISK)
  transition        thread status before → after, or "none"
  usage             tokens, latency, model
}
```

`GET /api/episodes/:id` returns it whole; the judgments page renders it. Nothing is summarised away.

## Station by station

### RADAR

- `info.ts` — sources are pluggable (`GET /api/info/sources`); each event carries its origin so the market
  state's key points can cite `I3`, `I7`.
- `screener.ts` + `bar-metrics.ts` — for each candidate symbol and each active strategy, a deterministic
  **fit score** from bar structure (range position, volume ratio, ATR %, trend agreement …). Three horizons
  (`short`, `swing`, `weekly`) with their own cadence and TTL. Output: a `ScreenRow` and `WatchCandidate`s,
  plus a **watch-list proposal** that a human applies (`POST /api/screener/:id/apply`) — the screener never
  edits risk, leverage or backends.
- `market.ts` / `indicators.ts` — klines, mark price, funding, and a ported technical-indicator library
  (EMA/RMA, RSI, ATR, Bollinger, Keltner, squeeze, Donchian, Supertrend, PSAR, Ichimoku, OBV, VWAP, volume
  profile, swing points, percentile rank). `GET /api/market/indicators` serves the UI overlays.

### THESIS

- `graph.ts` — the judgment graph: for each node (mode × thread status) which edges the model may pick,
  what each edge does and which code gates sit on it. `GET /api/graph` exposes it.
- `context.ts` — renders the evidence registry, the active strategies' rules, the playbook text and the
  contract into `context_text`.
- `schema.ts` — `validateJudgment`: JSON shape, allowed action, cited ids must exist, PROPOSE needs a
  direction / stop / strategy id when strategies were offered.
- `brain.ts` / `cli-launch.ts` — brains are CLIs spawned per call (`claude -p`, `codex exec`, `pi -p`) or the
  built-in stub. The gateway never sees a provider key. `GET /api/brains` probes which are installed.
- `chat.ts` — the desk. Tools: `get_state`, `list_threads`, `get_thread`, `get_episode`, `list_history`,
  `propose_thread`, `close_thread`, `set_workflow`, `run_scan`, `run_info`, `run_review`, `get_screen`,
  `run_screen`, `list_intents`, plus `approve_intent` / `reject_intent` / `request_execution`. Anything that
  moves money creates a pending **intent**; approval needs a one-time confirm token from the UI.

### STRATEGY

- `strategies.ts` — the versioned library. A strategy is data: params with ranges, rules text, trigger
  kinds, timeframe floor, status (`draft → backtest → paper → live`), `eval_stats`. Editing params creates
  a new draft version; `promote` moves exactly one step; `retire` is terminal.
- `backtest.ts` — the blind replay: walk historical klines, rebuild the evidence registry at each close with
  only what was visible then, ask the brain, apply the same gates, simulate fills. Cost is estimated first
  (`POST /api/backtest/estimate`) because every step is a model call.

### RISK

- `gates.ts` — `evaluateGates` and `computeSizing`. Gates: emergency stop, paused, stop side, stop
  distance min/max, confidence floor, max open threads, max opens per day, daily-loss stop, evidence
  freshness, daily judgment cap, symbol already open, liquidity notional cap. Sizing: `equity × risk% /
  |entry − stop|`, notional cap after leverage, floored to step size, refused below exchange minimums.
- `workflow.ts` — the single editable settings object with bounds; `POST /api/workflow` clamps and reports
  `errors[]`. Some fields (risk %, leverage, caps, auto-approve) can only be changed from the UI, never by
  the chat agent.

### EXECUTION

- `threads.ts` — the thread state machine: `pending_entry → in_position → closed | canceled`, every
  transition driven by an exchange fact. `reconcileThread` matches orders by `clientOrderId`
  (`tg-{intent}-{leg}{n}-{attempt}`); foreign orders on the same symbol block new entries until reconciled.
- Backends implement one interface (`execution.ts`): `paper` (in-process fills at mark price, protective
  legs honoured each tick), `cli` (`execution-cli.ts`, the official `binance-cli`), `agent_mcp`
  (`execution-agent.ts`, a Claude Code / Codex session per write op against Binance's MCP server), `demo`
  (the Rust `tgate-demo-exec` on `demo-fapi.binance.com`).
- `POST /api/execution/verify-protection` runs a **stop-leg canary** on the live backend before the first
  real entry: place and cancel a tiny conditional order, record the receipt, unblock.

## Persistence

One sqlite file (`~/.trade-gate/demo/state.sqlite`, override with `TG_DEMO_HOME` / `TG_DEMO_DB`). Migrations
in `packages/gateway/src/migrations/` are applied in order on boot. Tables: episodes, threads, intents,
orders, equity points, information events, market states, workflow (kv), strategies + versions, backtests,
screens + candidates, chat sessions + messages, logs, activity.

## Contracts

`packages/contracts` holds the JSON schemas (intent, order, thread, judgment, client-order-id scheme) that
gateway, UI and `crates/contracts-rs` are generated from. `npm run generate:check` fails CI if generated
code drifts from the schemas.

## Full route list

```
GET  /api/overview  /api/events (SSE)  /api/logs  /api/activity  /api/history  /api/graph  /api/symbols
GET  /api/episodes  /api/episodes/:id  /api/threads  /api/threads/:id  /api/intents
GET  /api/market-state  /api/market-state/history  /api/info/events  /api/info/sources
GET  /api/market/klines  /api/market/klines/history  /api/market/indicators  /api/market/indicators/sets  /api/market/regime
GET  /api/screener/latest  /api/screener/history  /api/screener/:id
GET  /api/strategies  /api/strategies/active  /api/strategies/:id  /api/backtest  /api/backtest/:id
GET  /api/workflow  /api/workflow/proposals  /api/brains  /api/execution  /api/execution/protection
GET  /api/orders/open  /api/positions  /api/chat/messages  /api/chat/sessions
POST /api/run-now  /api/scan-now  /api/info/run-now  /api/screener/run  /api/screener/:id/apply
POST /api/threads/:id/review  /api/threads/:id/close  /api/positions/:symbol/adopt
POST /api/intents/:id/confirm-token  /api/intents/:id/approve  /api/intents/:id/reject  /api/intents/:id/cancel
POST /api/workflow  /api/workflow/proposals/:id/{confirm-token,apply,reject}  /api/settings
POST /api/strategies  /api/strategies/:id/{promote,propose-version,retire}
POST /api/backtest  /api/backtest/estimate  /api/backtest/:id/cancel
POST /api/orders  /api/execution/{check,connect,net-check,verify-protection}
POST /api/brains/test  /api/chat/messages  /api/chat/reset  /api/chat/sessions  /api/chat/sessions/:id
POST /api/pause  /api/resume  /api/halt
```
