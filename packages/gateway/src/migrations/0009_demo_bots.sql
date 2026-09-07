-- 0009_demo_bots.sql — Radar screener tables: one row per screen run, one row per (symbol × strategy) candidate.

-- Radar 一次筛选的元数据(哪些币、什么口径、花了多少)。
CREATE TABLE demo_screen (
  id TEXT PRIMARY KEY,
  horizon TEXT NOT NULL,                 -- short | swing | weekly
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,                  -- running | done | failed
  universe TEXT NOT NULL,                -- watchlist+whitelist | top_volume | explicit
  symbols_json TEXT NOT NULL,            -- 实际筛了哪些
  errors_json TEXT NOT NULL,             -- [{symbol, error}]
  run_id TEXT,                           -- screen run id
  handoff_id TEXT,                       -- reserved
  proposal_json TEXT,                    -- { symbols, active_strategies, k, note }
  brain_json TEXT,                       -- { used, model, cost_cny, dropped_lines, note }
  cost_cny REAL NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_demo_screen_horizon ON demo_screen(horizon, started_at DESC);

-- 一次筛选里的一行:某个币 × 某条策略的机会卡(notebook §11.1 的 WatchCandidate)。
CREATE TABLE demo_watch_candidate (
  screen_id TEXT NOT NULL,
  horizon TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  fit_score REAL NOT NULL,               -- 0..1,确定性打分(不是模型给的)
  rank INTEGER NOT NULL,                 -- 1 = 这次筛选里最好的
  reasons_json TEXT NOT NULL,            -- string[](确定性文案;模型那句单独放 card 里)
  card_json TEXT NOT NULL,               -- OpportunityCard
  ttl_at INTEGER NOT NULL,               -- 过了这个时间这张卡就该重算,不该再当依据
  created_at INTEGER NOT NULL,
  PRIMARY KEY (screen_id, symbol, strategy_id)
);
CREATE INDEX idx_demo_watch_candidate_rank ON demo_watch_candidate(screen_id, rank);
