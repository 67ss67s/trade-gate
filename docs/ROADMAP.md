# Roadmap — Layer 2

The five stations in this repository are Layer 1. Layer 2 watches them. Each module below exists in our
private build and plugs into a Layer 1 interface that is already public; none of them is part of this release.

| Module | Status | What it does | Plugs into |
|---|---|---|---|
| **Reviewer** | next | Grades every closed thread after the fact — thesis, timing, exit — separately, in R multiples, against what the market did next. Proposes lessons; never edits anything itself. | consumes `episodes` + `history`; feeds the Thesis prompt and Strategy playbook |
| **Memory** | next | Lessons proposed by the Reviewer or typed by the user, approved by a human, recalled as evidence rows `M1..Mn` beside `E1..En`. A remembered number can never be cited as a market level. | Radar evidence registry (`context.ts`) |
| **Strategy Lab** | planned | Versioned strategies with a promotion ladder, blind bar-by-bar replay, and pre-registered experiments: a parameter change states its expected effect before it runs and only measured wins are promoted. | `strategies.ts` |
| **Captain & Council** | planned | A daily brief and auditable cross-role hand-offs (who asked whom for what, with idempotency keys). Zero model. | the activity feed and intents |
| **Portfolio & Risk Sentinel** | planned | Account-level invariants: cluster exposure, correlated stops, per-symbol capacity from 24 h volume, stop-budget. Alerts carry a button, not a config edit. | Risk gates (`gates.ts`) |
| **Ops Floor** | planned | One screen where every role sits at its desk: presence, hand-offs, who is waiting on a human. | the web UI |

Layer 1 items still open in this release: plan expiry enforcement for resting limit entries, a Windows
launch path for the CLI brains, and exposing `max_notional_pct` in the workflow form.
