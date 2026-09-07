# Security

- The gateway process holds no exchange keys and no model provider keys. `binance-cli` keeps its profile
  store, Claude Code keeps its OAuth session, the Rust executor keeps its key file under `~/.trade-gate/secrets`.
- The HTTP API binds 127.0.0.1 and has no authentication. Do not expose it; put it behind your own auth if
  you must.
- Use Binance **Demo Trading** (`BINANCE_API_ENV=demo`) until you have read `gates.ts` and `threads.ts` and
  agree with every line.
- Report vulnerabilities through GitHub security advisories on this repository rather than public issues.
