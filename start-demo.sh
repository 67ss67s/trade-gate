#!/usr/bin/env bash
# One-command demo: gateway (18800) + web UI dev server (5180). Ctrl-C stops both.
#
# Execution backend (TG_DEMO_BACKEND):
#   paper      in-process simulator, the default when nothing else is configured
#   cli        Binance Agent OS channel: the official binance-cli with BINANCE_API_ENV=demo and a named
#              profile (default tswarm-demo) — create it once with ./node_modules/.bin/binance-cli profile create
#   agent_mcp  Binance MCP Server driven through a Claude Code host session
#   demo       the Rust executor (tswarm-demo-exec) with a demo API key in ~/.trading-swarm/secrets/apikey-demo.json
# Brain (TG_DEMO_BRAIN): claude | codex | pi | stub. Unset = claude when the CLI is on PATH, else stub.
# Ports: TG_UI_PORT (default 5180) and TG_DEMO_PORT (default 18800); both fail loudly if taken.
# State lives in ~/.trading-swarm (override with TG_DEMO_HOME); nothing is written into the repository.
set -euo pipefail
cd "$(dirname "$0")"
export TG_DEMO_TF="${TG_DEMO_TF:-15m}"
export TG_DEMO_RUN_ON_START="${TG_DEMO_RUN_ON_START:-1}"
export TG_DEMO_PORT="${TG_DEMO_PORT:-18800}"
UI_PORT="${TG_UI_PORT:-5180}"
if [ "${TG_DEMO_BACKEND:-}" = "demo" ] && [ ! -x target/exec-core/release/tswarm-demo-exec ]; then
  echo ">> building tswarm-demo-exec (release)"; CARGO_TARGET_DIR=target/exec-core cargo build -p exec-core --bin tswarm-demo-exec --release
fi
npm run build --workspace packages/gateway >/dev/null
node packages/gateway/dist/demo/main.js &
GW=$!
npm run dev --workspace packages/webui -- --host 127.0.0.1 --port "$UI_PORT" --strictPort &
UI=$!
trap 'kill $GW $UI 2>/dev/null; wait 2>/dev/null; exit 0' INT TERM
echo ">> UI http://127.0.0.1:$UI_PORT   API http://127.0.0.1:$TG_DEMO_PORT/api/overview   (ports: TG_UI_PORT / TG_DEMO_PORT)"
wait
