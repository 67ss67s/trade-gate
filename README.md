# TradeGate

**An agent-first trading gateway on Binance Agent OS. The model does the judgment; code does the money.**

[![ci](https://github.com/67ss67s/trade-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/67ss67s/trade-gate/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >= 24](https://img.shields.io/badge/node-%E2%89%A5%2024-5a5a5a.svg)](https://nodejs.org)

> Binance Agent OS Mini Hackathon · Track A entry. Five stations that run today —
> `RADAR → THESIS → STRATEGY → RISK → EXECUTION` — with a second, self-evolving layer under the floor.

```
  ┌────────┐    ┌────────┐    ┌──────────┐    ┌────────┐    ┌───────────┐
  │ RADAR  │ →  │ THESIS │ →  │ STRATEGY │ →  │  RISK  │ →  │ EXECUTION │
  │collects│    │ judges │    │  plans   │    │ gates  │    │  sends &  │
  │        │    │ (model)│    │  (code)  │    │ (code) │    │  tracks   │
  └────────┘    └────────┘    └──────────┘    └────────┘    └───────────┘
   info officer  NO_TRADE      versioned       code gates    paper ·
   screener      WATCH         strategy        + sizing      binance-cli ·
   E1..En        PROPOSE       library         reasons       Binance MCP
      │              │              │              │              │
      └──── evidence ┴─── judgment ─┴──── plan ────┴─── verdict ───┘
                     every hand-off is a typed object,
                  every judgment is an immutable episode on disk
```

The model only ever sees a numbered evidence registry (`E1..En`) and may answer `NO_TRADE | WATCH | PROPOSE`
with citations. It never sets a quantity, a leverage or a margin mode. Every judgment is written as an
**episode** — the exact text the model saw, its raw output, the validation errors, every gate's verdict, the
resulting thread transition — and the UI's judgment page *is* the replay.

## Why

Language models are unusually good at the part of trading that is judgment — reading a situation, weighing
contradictory evidence, saying "not this one" — and unusually bad at the part that is money: arithmetic under
pressure, position sizing, remembering that a stop must exist before the position does. TradeGate splits the
two and never lets them mix. The model is handed a registered evidence list for one symbol and returns one
JSON object: a stance, a direction, an entry style, a stop, take-profits and the evidence ids it cites.
Everything downstream is deterministic code you can read: the code gates, the quantity, the leverage, the
order, the stop leg, the reconciliation against exchange facts. `NO_TRADE` is a first-class answer, and most
scans end there — which is the point.

## Quick start

```bash
git clone https://github.com/67ss67s/trade-gate && cd trade-gate
npm install
./start-demo.sh            # gateway on :18800, UI on http://127.0.0.1:5180
```

That is a complete, key-less run: public Binance futures market data, an in-process **paper** account, and
the thesis formed by Claude Code if the `claude` CLI is on your PATH, otherwise by a deterministic stub.
State (sqlite, settings, episodes) lives in `~/.trade-gate`, never in the repository; a fresh clone inherits
nothing. Requires Node ≥ 24. Rust is only needed for the optional `demo` executor.

## Replicate this agent, step by step

1. **Prerequisites** — Node ≥ 24 and npm. Optional: [Claude Code](https://claude.com/claude-code) (`claude` on
   PATH) for a real model brain; Rust only if you want the `demo` executor.
2. **Clone and install**
   ```bash
   git clone https://github.com/67ss67s/trade-gate && cd trade-gate && npm install
   ```
3. **First run, no keys** — `./start-demo.sh`, then open http://127.0.0.1:5180. Public Binance market data,
   an in-process paper account, and the thesis formed by Claude Code if installed, otherwise by a
   deterministic stub. Nothing is written into the repository; state lives in `~/.trade-gate`.
4. **Watch a cycle** — the home page shows the five stations. *Intel* runs the information officer,
   *Screener* scores candidates, *Judgments* shows every model decision with its evidence `E1..En`, the
   exact prompt, the raw answer and every risk gate's reason. Most decisions are `WATCH` / `NO_TRADE`.
5. **Tune the loop** — Agent page → workflow panel: watch list, timeframe, risk % per trade, leverage,
   max threads, daily-loss stop, auto-approve. Everything is bounded and persisted.
6. **Talk to it** — the chat desk exposes the same tools; anything that moves money becomes a pending
   intent you approve with a one-time token.
7. **Switch the brain** — top bar picker or `TG_DEMO_BRAIN=claude|codex|pi|stub`. Model CLIs hold their
   own auth; the gateway never sees a provider key.
8. **Go to Binance Demo Trading through Agent OS** — create a key at https://demo.binance.com, then
   ```bash
   ./node_modules/.bin/binance-cli profile create    # name tgate-demo · env demo
   TG_DEMO_BACKEND=cli ./start-demo.sh
   ```
   or use the Binance MCP Server through Claude Code: `claude "/mcp"` → authenticate `binance-mcp-server`,
   then `TG_DEMO_BACKEND=agent_mcp ./start-demo.sh`. Run the stop-leg canary from the execution panel
   before the first entry.
9. **Replay and iterate** — *Replay* walks history bar by bar with the agent seeing only what was visible;
   *Strategy library* versions every rule change; `npm test` runs ~680 offline tests.
10. **Emergency stop** — type `HALT` in the top bar; everything flattens and new entries are refused until
    you resume.

Full configuration in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md), the Agent OS wiring in
[`docs/AGENT-OS.md`](docs/AGENT-OS.md), a three-minute walkthrough in [`docs/DEMO.md`](docs/DEMO.md).

Then pick your pieces — everything below is switchable live from the UI's workflow panel or with env
variables at start-up (full list in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)):

| Piece | Options | Set |
|---|---|---|
| **Brain** (forms the thesis) | Claude Code CLI · Codex CLI · `pi` (multi-provider CLI) · rule stub | `TG_DEMO_BRAIN=claude\|codex\|pi\|stub` |
| **Execution** | paper · **`binance-cli`** (Binance Skills Hub, Demo Trading) · **Binance MCP Server** via a Claude Code host · Rust demo executor | `TG_DEMO_BACKEND=paper\|cli\|agent_mcp\|demo` |
| **Loop** | timeframe, watch list, scan mode, information-officer cadence, heartbeat | workflow panel / `TG_DEMO_TF`, `TG_DEMO_WATCHLIST` |

The gateway process holds **no API keys and no model keys**. `binance-cli` keeps the exchange key in its own
profile store, Claude Code keeps the MCP OAuth session, the model CLIs keep their provider auth.

### Binance Agent OS channels

- **Skills Hub → `binance` skill → `binance-cli`.** `TG_DEMO_BACKEND=cli` routes every account read and every
  order through the official CLI with `BINANCE_API_ENV=demo` and a named profile. Conditional stop /
  take-profit legs use the algo-order endpoints.
  ```bash
  ./node_modules/.bin/binance-cli profile create    # name: tgate-demo · env: demo · key from https://demo.binance.com
  TG_DEMO_BACKEND=cli ./start-demo.sh
  ```
- **Binance MCP Server.** The MCP server admits allow-listed hosts (Claude Code among them), so TradeGate
  drives it *through* Claude Code: each write operation is one short host session told exactly which tool to
  call. Log in once — `claude "/mcp"` → `binance-mcp-server` → Authenticate — then
  `TG_DEMO_BACKEND=agent_mcp ./start-demo.sh`.
- **We publish a skill too.** [`skills/trade-gate/SKILL.md`](skills/trade-gate/SKILL.md) lets any host agent
  (Claude Code, Codex, OpenClaw…) drive this gateway over its HTTP API — read the pipeline, propose, close,
  change the watch list.

Details in [`docs/AGENT-OS.md`](docs/AGENT-OS.md).

## The five stations

1. **RADAR** — *Information officer* (every 30 min): market-wide tickers, funding, open interest, long/short
   ratios, taker flow, Fear & Greed, CoinDesk / Cointelegraph RSS, normalised into `InformationEvent`s and a
   `MarketState` (regime, bias, key points that cite their sources, risk events). *Screener* (short / swing /
   weekly horizons): deterministic fit scores of every watch-list and whitelist symbol against the active
   strategies, proposing watch-list changes that a human applies. *Scans* on each K-line close build the
   evidence registry `E1..En` — price, funding, OI, multi-timeframe structure, indicators, market state, news.
2. **THESIS** — the only place a model speaks. A judgment graph declares, per (mode × thread status), which
   actions the model may pick; the context builder renders the registry; the model answers one JSON object.
   Unknown citations, an illegal action, a missing direction → one repair round, then fail-closed to
   `NO_TRADE` (scan) or `HOLD` (review). The chat desk exposes the same tools, and money-moving tools there
   only *propose*.
3. **STRATEGY** — a versioned strategy library (breakout-retest, range mean-reversion, …): rules, parameters,
   trigger kinds and timeframe floors as data. A parameter change creates a new draft version; promotion moves
   one step at a time. The replay page walks historical K-lines bar by bar and shows the judgments the agent
   would have made with only what was visible at the time.
4. **RISK** — code gates on every proposal: stop side and distance, confidence floor, risk % of equity,
   notional cap, liquidity cap, max open threads, daily opens, daily-loss stop, evidence freshness, daily
   judgment cap. Sizing is `equity × risk% / stop distance`, rounded to exchange step size, refused below the
   exchange minimum. Each gate returns a reason and the episode keeps all of them.
5. **EXECUTION** — strategy threads whose status is re-derived from exchange facts on every 10 s tick: entry
   order state, position, protective legs. Entry filled → the stop is placed, mandatory; if the stop cannot
   be placed the position is flattened. Stop / take-profit hit → thread closed with realised PnL. Unknown order
   outcomes are reconciled by `clientOrderId`, never re-sent blindly.

**Humans stay in the loop.** A manual order panel goes through the same execution chain. A chat desk with
sessions and per-session "may execute" switches. An editable workflow panel (watch list, timeframe, risk %,
leverage, margin mode, thread caps, daily-loss stop, auto-approve, brain, playbook text). Proposals that need
approval come as confirmation cards with one-time tokens. A typed-confirmation emergency stop flattens
everything.

## Layer 2 — under the floor

Open the home page and scroll below the five stations. The second layer watches the first: **Reviewer**
(post-trade attribution in R multiples), **Memory** (human-approved lessons recalled as evidence beside
`E1..En`), **Strategy Lab** (pre-registered experiments on replayable episodes), **Captain & Council**
(daily brief and cross-role hand-offs), **Portfolio & Risk Sentinel** (cluster exposure, correlated stops,
capacity), and the **Ops Floor** (one screen where every role sits at its desk). They exist in our private
build, are being productised, and are not part of this release. [`docs/ROADMAP.md`](docs/ROADMAP.md) says
what each one plugs into.

## Repository map

```
packages/
  gateway/     the runtime (TypeScript, Node ≥ 24, no web framework)
    src/demo/  info.ts · screener.ts · radar.ts · indicators.ts · market.ts   ← RADAR
               context.ts · graph.ts · schema.ts · brain.ts · chat.ts        ← THESIS
               strategies.ts · backtest.ts                                   ← STRATEGY
               gates.ts · workflow.ts · triggers.ts                          ← RISK
               execution*.ts · threads.ts · runtime.ts · http.ts             ← EXECUTION, loop, API
    src/migrations/   sqlite schema
    test/             vitest (≈ 690 tests, no network)
  webui/       Vite + React 18 + Tailwind v4 + shadcn — home, intel, screener, watch params, agent,
               judgments, strategies, replay, trade, history, logs, settings
  contracts/   JSON-schema contracts shared by gateway, UI and the Rust side
crates/        contracts-rs · exec-core (Binance REST executor) · execd (credential holder, optional)
skills/        SKILL.md for host agents
docs/          ARCHITECTURE · AGENT-OS · CONFIGURATION · DEMO · ROADMAP · contracts
```

## HTTP API (selection)

| Method | Path | What |
|---|---|---|
| GET | `/api/overview` | loop state, workflow, account, markets, market state, open threads, queue |
| GET | `/api/events` | SSE stream of every state change |
| GET | `/api/episodes?symbol=&limit=` · `/api/episodes/:id` | judgment replay |
| GET | `/api/threads?status=open\|all` · `/api/threads/:id` | strategy threads |
| POST | `/api/scan-now` `{symbol?}` · `/api/info/run-now` · `/api/screener/run` | run a station now |
| POST | `/api/workflow` `{partial}` | bounded live settings |
| POST | `/api/orders` | manual order through the same chain |
| POST | `/api/intents/:id/confirm-token` → `/approve` · `/reject` | human approval with one-time nonce |
| POST | `/api/halt` `{"confirm":"HALT"}` · `/api/pause` · `/api/resume` | emergency stop, pause |
| GET | `/api/execution` · POST `/api/execution/connect` · `/verify-protection` | backend status, login, stop-leg canary |

The full list is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Safety model, in one breath

The model chooses *direction, entry style, stop, take-profits, reasons*. Code chooses *quantity, leverage,
margin mode, and whether the trade is allowed at all*. Credentials never enter the TypeScript process. Two
invalid model outputs → `NO_TRADE` / `HOLD`. A position never lives without a stop. Unknown order outcome →
reconcile, never blind re-send. `paper` is the default; Demo Trading is the recommended next step; nothing
here is financial advice.

## Development

```bash
npm run typecheck        # tsc -b across the workspace
npm test                 # vitest
npm run build --workspace packages/gateway
npm run dev   --workspace packages/webui
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).

## License

MIT.
