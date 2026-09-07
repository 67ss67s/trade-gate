# Demo video plan (3 minutes)

Setup: `TG_DEMO_SHOWCASE=1 ./start-demo.sh` (1-minute timeframe, 3-minute information officer, narration
on), Claude Code on PATH as the brain, `binance-cli` profile `tgate-demo` created on Demo Trading. Record
at 1440×900, UI language EN (top bar).

| Time | Screen | What you show | What you say |
|---|---|---|---|
| 0:00 | Home | Five station cards with live facts, the pipeline arrows | "TradeGate: the model does the judgment, code does the money. Five stations, every judgment a replayable episode." |
| 0:20 | Intel | Market state: regime, bias, key points citing `I3`, `I7`; click *Run now* | "The information officer turns tickers, funding, OI and news into a cited market state every 30 minutes." |
| 0:40 | Screener | Run the short horizon; fit scores per symbol × strategy; the watch-list proposal; apply it | "Radar scores candidates deterministically and only ever proposes watch-list changes — a human applies them." |
| 1:00 | Judgments | Open the newest episode: evidence `E1..En`, the exact prompt, the raw model answer, every gate with its reason | "The model sees a numbered evidence registry and answers NO_TRADE, WATCH or PROPOSE with citations. Nothing else. Most of the time the right answer is WATCH." |
| 1:25 | Agent | Ask "why not long BTC?"; the agent answers from `get_episode`. Toggle auto-approve off, ask it to propose a trade → confirmation card with one-time token | "The chat desk has the same tools. Anything that moves money becomes an intent you approve." |
| 1:50 | Trade | Place a manual order (margin × leverage → quantity, stop, take-profit); thread goes pending → in position; protective legs in the open-orders list. Top bar shows *binance-cli · Demo Trading* | "Execution through Binance Agent OS: every order goes through the official binance-cli. The stop is mandatory — if it cannot be placed the position is flattened." |
| 2:20 | Trade review | Closed threads with R multiples, the judgment timeline of one trade | "Every trade keeps its judgments; you can ask the agent why." |
| 2:35 | Top bar | Type `HALT`; threads flatten; loop refuses new entries | "Emergency stop, typed confirmation." |
| 2:45 | Home, scroll down + Floor | Layer 2 locked cards; the ops floor with masked desks | "Under the floor: Reviewer, Memory, Strategy Lab with blind replay, Portfolio & Risk Sentinel, Captain. Running in our private build, still in testing, coming to this repo." |
| 2:55 | README | Agent OS section, repo link | "MIT, one command to run, no keys needed for the first run." |

Fallbacks: if no PROPOSE appears during recording, the manual order in step 1:50 carries the execution story;
if the CLI profile is missing, record on `paper` and say so.
