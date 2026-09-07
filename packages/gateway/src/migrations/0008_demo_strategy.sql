-- 0008_demo_strategy.sql — 策略库(design notes;
-- 决定稿 design notes E/F)。
--
-- 一条策略 = 一串不可变版本。触发/清单/规则/参数进 content_hash;status 与 eval_stats 是版本行上的
-- 可变元数据(晋升与回测统计会改它们,但改不了这个版本被判断时用的那份内容)。改任何参数或规则
-- 都要新建版本:旧成交永远指向它当时的 hash。

CREATE TABLE demo_strategy_version (
  id TEXT NOT NULL,                      -- 策略 id(跨版本稳定),如 breakout_retest
  version INTEGER NOT NULL,              -- 从 1 递增
  content_hash TEXT NOT NULL,            -- sha256(name|family|trigger|checklist|rules|params)
  status TEXT NOT NULL,                  -- draft | backtest | shadow | paper | live_capped | retired
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  parent_version INTEGER,                -- 从哪个版本派生(null = 内置初版)
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL,                    -- StrategySpec(strategies.ts)
  PRIMARY KEY (id, version)
);
CREATE INDEX idx_demo_strategy_version_status ON demo_strategy_version(status);
CREATE INDEX idx_demo_strategy_version_hash ON demo_strategy_version(content_hash);

-- 线程记下它跟的是哪条策略(json 里也有,这里出一列是为了直接 GROUP BY 归因)。
ALTER TABLE demo_threads ADD COLUMN strategy_id TEXT;
