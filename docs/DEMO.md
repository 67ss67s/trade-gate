# Three-minute demo

Run `TG_DEMO_SHOWCASE=1 ./start-demo.sh` so everything happens inside ten minutes (1-minute timeframe,
3-minute information officer, narration on). Open http://127.0.0.1:5180.

1. **Home** — five stations in a row, live facts on each card. Scroll: the second layer is under the floor.
2. **Intel (Radar)** — the information officer's latest market state: regime, bias, key points citing `I3`,
   `I7`. Click *run now*.
3. **Screener (Radar)** — run the short horizon; fit scores per symbol × strategy; a watch-list proposal you
   apply by hand.
4. **Judgments (Thesis)** — open the newest episode: the evidence registry `E1..En`, the exact prompt, the
   raw model answer, every gate with its reason. Most will be `WATCH` or `NO_TRADE`; that is correct behaviour.
5. **Trade (Execution)** — place a manual order (margin × leverage → quantity, stop, take-profit) and watch
   the thread go from *pending entry* to *in position* with its protective legs listed.
6. **Agent (Thesis)** — ask "why not long BTC?"; the agent answers from `get_episode`. Turn auto-approve off
   in the workflow panel, ask it to propose a trade, and a confirmation card appears.
7. **Top bar** — type `HALT`. Everything flattens; the loop refuses new entries until you resume.
8. Switch the execution backend to `binance-cli` (Demo Trading) or the Binance MCP Server and repeat step 5.
