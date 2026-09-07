# Configuration

Two layers: **environment variables** read once at start-up (`packages/gateway/src/demo/main.ts`), and the
**workflow** — a single settings object persisted in sqlite and editable live from the UI or
`POST /api/workflow`. Env variables only seed the workflow on a fresh state; after that the persisted value
wins unless the variable is set again.

## Where state lives

| Path | What |
|---|---|
| `~/.trade-gate/demo/state.sqlite` | everything: episodes, threads, intents, workflow, strategies, screens, chat, logs |
| `~/.trade-gate/secrets/apikey-demo.json` | only for the optional Rust `demo` backend (`{"api_key","api_secret"}` from demo.binance.com) |
| `~/.trade-gate/run/execd.sock` | only when `execd` runs |

`TG_DEMO_HOME` moves the whole directory, `TG_DEMO_DB` the database alone. Nothing is written into the
repository. **Factory reset** = delete `~/.trade-gate/demo/state.sqlite`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TG_DEMO_PORT` | `18800` | gateway HTTP port (binds 127.0.0.1) |
| `TG_DEMO_HOME` | `~/.trade-gate` | state directory |
| `TG_DEMO_DB` | `<home>/demo/state.sqlite` | database path |
| `TG_DEMO_BRAIN` | `claude` if the CLI is on PATH, else `stub` | initial judgment brain: `claude` · `codex` · `pi` · `stub` |
| `TG_DEMO_CHEAP_BRAIN` | same as brain | brain for the information officer and screener one-liners |
| `TG_DEMO_CLAUDE_MODEL` | `sonnet` | model passed to `claude -p --model` |
| `TG_DEMO_CODEX_MODEL` | (CLI default) | model passed to `codex exec -m` |
| `TG_DEMO_PI_PROVIDER` / `TG_DEMO_PI_MODEL` | unset | `provider/model` for the `pi` CLI; both required to use `pi` |
| `TG_DEMO_BACKEND` | `auto` | `paper` · `cli` · `agent_mcp` · `demo`; `auto` = `demo` iff the demo key file exists, else the last persisted backend, else `paper` |
| `TG_DEMO_CLI_PROFILE` | `tgate-demo` | `binance-cli` profile name for the `cli` backend |
| `TG_EXEC_AGENT_CLI` / `TG_EXEC_AGENT_MODEL` | `claude` / `sonnet` | host CLI and model for the `agent_mcp` backend |
| `TG_DEMO_TF` | `15m` | initial timeframe (`1m` … `1d`) |
| `TG_DEMO_WATCHLIST` | `BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT` | initial watch list, comma-separated |
| `TG_DEMO_AUTO_APPROVE` | `1` | `0` = every PROPOSE waits for a human confirmation card |
| `TG_DEMO_RUN_ON_START` | `1` | run the information officer and a first scan on boot |
| `TG_DEMO_JUDGMENT_CAP` | `300` | daily judgment cap (0 = unlimited) |
| `TG_DEMO_SHOWCASE` | unset | `1` = 1-minute timeframe, 3-minute information officer, narration on — everything visible within ~10 minutes |
| `BINANCE_API_ENV` | `demo` | passed through to `binance-cli`; keep `demo` |

Model CLIs can be launched through a shell alias or an env-prefixed command: edit `cli_commands` in the
workflow (or the settings page) — e.g. `claude` → `my-claude-wrapper`. The gateway validates the command
resolves before it is saved.

## Workflow (live settings)

`GET /api/workflow` returns it; `POST /api/workflow {partial}` merges, clamps to bounds and returns
`{ workflow, errors[] }`. Fields:

| Field | Bounds / values | Notes |
|---|---|---|
| `watchlist` | ≤ `watchlist_max` (default 60, max 300) USDT perpetuals | screener proposals only ever touch this |
| `watch_only` | symbols | scanned but never proposed |
| `timeframe` | `1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1d` | the K-line-close clock |
| `scan_mode` | `triggered` · `every_close` | `triggered` = only when a code trigger fires (breakout, volume, fast move, session, heartbeat) |
| `fast_move_pct` | 0.3 – 10 | fast-move trigger threshold |
| `heartbeat_every_ms` | ≥ 5 min | a scan even when nothing triggered (fingerprint-deduplicated) |
| `info_every_ms` | ≥ 5 min | information-officer cadence |
| `review_every_close` | bool | review open threads on every close, not only on events |
| `invalidation_confirm_bars` / `invalidation_buffer_atr` | | how many closes beyond the invalidation level (with an ATR buffer) before a thread is invalidated |
| `risk_pct` | 0.1 – 5 | % of equity lost if the stop is hit — **UI only** |
| `leverage` | 1 – 20 | **UI only** |
| `margin_mode` | `cross` · `isolated` | **UI only** |
| `max_open_threads` | 1 – 10 | **UI only** |
| `max_opens_per_day` | 1 – 50 | **UI only** |
| `daily_loss_stop_pct` | 0.5 – 20 | realised daily loss that halts new entries — **UI only** |
| `daily_judgment_cap` | 0 – 5000 | model-call budget per UTC day |
| `auto_approve` | bool | `false` = PROPOSE → confirmation card |
| `chat_requires_approval` | bool | `true` = the chat agent's `approve_intent` only pushes a card |
| `execution` | `paper` · `cli` · `agent_mcp` · `demo` | switching runs a connection check first |
| `brain` / `cheap_brain` / `*_model` | `claude` · `codex` · `pi` · `stub` | |
| `cli_commands` | `{claude, codex, pi}` | launch commands / aliases |
| `active_strategies` | ≤ 6 ids from the library | rendered into the prompt; PROPOSE must name one |
| `playbook_text` | ≤ 4000 chars | free-text guidance appended to the contract |
| `screener_enabled`, `screener_short_every_ms`, `screener_swing_every_ms`, `screener_universe`, `screener_symbols`, `screener_whitelist`, `screener_max_symbols`, `screener_use_brain`, `screener_apply`, `screener_expectancy` | | Radar screener cadence and scope; `screener_apply=auto` applies proposals without a human |
| `narrate` | bool | the agent narrates its actions into the chat feed |
| `paused` | bool | no model calls, no new entries; open threads still tracked |

"UI only" fields are rejected when the chat agent's `set_workflow` tool tries to change them.

## Emergency stop

`POST /api/halt {"confirm":"HALT"}` flattens every thread and refuses new entries until
`POST /api/resume {"confirm":"RESUME"}`. The halted flag is persisted and survives restarts — if a fresh
boot refuses everything, check the top bar.
