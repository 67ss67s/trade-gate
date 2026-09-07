# Contributing

```bash
npm install
npm run typecheck        # tsc -b
npm test                 # vitest, no network
npm run build --workspace packages/gateway && node packages/gateway/dist/demo/main.js
npm run dev --workspace packages/webui
```

Rules of the house:

- The model never decides money. Anything that touches quantity, leverage, margin mode or whether an order
  is sent belongs in `gates.ts` / `threads.ts` and needs a test.
- Thread status is derived from exchange facts, never from what the agent said or what we sent.
- No exchange or model credentials in `packages/gateway` or `packages/webui`. CLIs and executors hold them.
- Contracts first: change `packages/contracts/schema/*.json`, run `npm run generate`, then the code.
- One judgment = one episode. Do not summarise the prompt or the raw output away.
- Adding a strategy: a new entry in `strategies.ts` built-ins (params with ranges, rules text, trigger kinds,
  timeframe floor) plus a screener fit function in `bar-metrics.ts` and a test.
- Adding a gate: `evaluateGates` in `gates.ts`, a reason string, a test that flips it.
- Adding an execution backend: implement the `ExecBackend` interface in a new `execution-*.ts`, register it
  in `main.ts`, and make the stop-leg canary pass.

PRs: keep the description to what changed and why, include the test you added, and run `npm run check`.
