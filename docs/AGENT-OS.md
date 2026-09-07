# TradeGate on Binance Agent OS

Agent OS = Binance APIs + Skills Hub + MCP Server (+ Agentic Wallet / x402). TradeGate uses it in three
directions: as a **consumer** of the `binance` skill (`binance-cli`), as a **client** of the Binance MCP
Server through an allow-listed host, and as a **producer** of a skill other agents can install.

## 1. Execution through `binance-cli` (Skills Hub)

`TG_DEMO_BACKEND=cli` — `packages/gateway/src/demo/execution-cli.ts`.

Every account read (balance, positions, open orders, order status) and every write (market / limit entry,
conditional stop and take-profit legs, cancel, flatten) is one invocation of the official CLI with
`BINANCE_API_ENV=demo` and a named profile. The gateway never sees the key:

```bash
./node_modules/.bin/binance-cli profile create   # name tgate-demo · env demo · key/secret from https://demo.binance.com
TG_DEMO_BACKEND=cli ./start-demo.sh
```

`GET /api/execution` reports `cli` availability (binary found, profile present) with the setup steps when
something is missing; the UI's execution panel shows the same. Conditional legs go through the futures
algo-order endpoints, which is what the current futures API requires for stop / take-profit orders.

Before the first real entry the UI asks you to run the **stop-leg canary** (`POST
/api/execution/verify-protection`): a minimal conditional order is placed and cancelled on the live backend
and the receipt is recorded. Until it passes, new entries are blocked on that backend.

## 2. Binance MCP Server through a host agent

`TG_DEMO_BACKEND=agent_mcp` — `packages/gateway/src/demo/execution-agent.ts`.

The Binance MCP Server (`https://agent.binance.com/mcp/agentic`) admits allow-listed OAuth clients; Claude
Code is one of them. So TradeGate does not connect to the MCP server itself — it starts a short host
session per operation and tells it exactly which tool to call and what to return:

```
gateway ──spawn──▶ claude -p --mcp-config … "Call futures_usds_newOrder with {…}. Return only the JSON receipt."
                        │
                        └──▶ Binance MCP Server (OAuth session owned by Claude Code)
```

Log in once with `claude "/mcp"` → `binance-mcp-server` → Authenticate. `POST /api/execution/connect`
re-checks the session; `GET /api/execution` shows `connected | needs_auth | unavailable`. The same
mechanism drives Codex (`TG_EXEC_AGENT_CLI=codex`).

Reads that are cheap and public (mark price, klines, funding, exchange rules) go to the public REST API
directly; only account and order queries cost a host session, and those are cached per tick.

## 3. TradeGate as a skill

[`skills/trade-gate/SKILL.md`](../skills/trade-gate/SKILL.md) is a Skills Hub-style skill any host agent can
load. It teaches the host the gateway's HTTP API and the rules: money-moving calls only propose, sizing and
gates are the gateway's, never call `/api/halt` unless the user asks, quote numbers from the API.

## What the model can and cannot touch

| Model may | Code decides |
|---|---|
| stance (`NO_TRADE` / `WATCH` / `PROPOSE`), direction | quantity, leverage, margin mode |
| entry style (market / limit zone), stop, take-profits | whether the stop is acceptable (side, distance) |
| which strategy from the offered list, thesis, invalidation | every gate, the daily budgets, the emergency stop |
| review verdicts (`HOLD` / `REDUCE` / `EXIT` / `INVALIDATE`) | order placement, reconciliation, the mandatory stop leg |

Credentials: `binance-cli` profile store (cli), Claude Code's OAuth session (agent_mcp), or the Rust
executor's key file (demo). None in the gateway.
