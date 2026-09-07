// Public surface of the demo runtime for tooling (evals, scripts). Import as `import { demo } from '@trade-gate/gateway'`.
export * from './types.js';
export { buildContext, PROMPT_VERSION, type EpisodeInputs, type BuiltContext } from './context.js';
export { validateJudgment, extractJson, validateMarketState, findMemoryNumberLeaks, type ValidationResult } from './schema.js';
export { evaluateGates, computeSizing, DEFAULT_GATES, type GateConfig, type GateContext, type SymbolRules } from './gates.js';
export { ema, atr, tfFeatures, tfToMs, nextCloseAfter, fetchKlines, fetchMarketView, fetchPremiumIndex, fetchOpenInterest, fetchOpenInterestHist, fetchTicker24h, fetchExchangeInfo, dailyRegime, trimDecimal, type TfFeatures } from './market.js';
export { detectTriggers, sessionInfo, windowMovePct, type TriggerInputs } from './triggers.js';
export { newThread, reconcileThread, reduceReview, allowedReviewActions, openingBlockers, threadClientPrefix, isOpen, OPEN_STATUSES, type ThreadFacts, type ReconcileResult, type ReviewDecision } from './threads.js';
export { DEFAULT_WORKFLOW, DEFAULT_PLAYBOOK, WORKFLOW_BOUNDS, BRAINS, BACKENDS, AGENT_CLIS, MODEL_ID_RE, applyWorkflowPatch, cliCommandError, loadWorkflow, estimateCallsPerHour } from './workflow.js';
export { resolveCliLaunch, cliSpawnArgs, cliLaunchStatus, commandWord, defaultCliCommand, defaultCliCommands, loginShell, onPath as cliOnPath, stripShellNoise, resetCliLaunchStatusCache, CLI_NAMES, CLI_COMMAND_MAX_CHARS, type CliLaunch, type CliLaunchVia, type CliName, type CliResolved, type CliCommands } from './cli-launch.js';
export { scanChecklist, reviewMetrics, trendAgreement, tfDirection, parseInvalidationPrice, priceDecimals, ATR_PCT_FLOOR, atrPctFloor, CHASE_ATR_MAX, RETEST_VOL_MIN, type ScanChecklist, type ReviewMetrics, type ReviewMetricsInput } from './review-metrics.js';
export { sma, ema as emaSeries, wma, dema, tema, rma, stdev, rsi, macd, bollinger, keltner, squeeze, donchian, atr as atrSeries, trueRange, adx, supertrend, psar, ichimoku, vwap, volumeProfile, stochastic, stochRsi, obv, chaikinAd, cci, mfi, williamsR, momentum, roc, trix, aroon, percentileRank, swingPoints, indicatorSnapshot, describeIndicators, trendStrengthOf, decimalsFor, last as lastOf, closes, highs, lows, opens, volumes, typicalPrices, type IndicatorSnapshot, type MacdPoint, type BollingerPoint, type KeltnerPoint, type SqueezePoint, type DonchianPoint, type AdxPoint, type SupertrendPoint, type PsarPoint, type IchimokuPoint, type StochPoint, type AroonPoint, type SwingPoints, type VwapAnchor, type VolumeProfile, type Trend, type TrendStrength } from './indicators.js';
export { indicatorRoutes, seriesFor, parseSets, INDICATOR_SETS, OVERLAY_SETS, DEFAULT_SETS, type IndicatorSet } from './routes-indicators.js';
export { JUDGMENT_GRAPH, GRAPH_VERSION, nodeFor, allowedActions, edgeFor, eventEdgeFor, guardIdForGate, guardsFromGates, validateGraph, toMermaid, graphMarkdown, type JudgmentGraph, type NodeId, type ModelEdge, type EventEdge, type GuardId, type Effect } from './graph.js';
export { piBrain, claudeBrain, codexBrain, stubBrain, makeBrain, brainFromEnv, brainCatalog, commandForKind, testBrain, DEFAULT_MODELS, BRAIN_PRICES_CNY, priceFor, estimateCny, type Brain, type BrainResult } from './brain.js';
export { parseRss, assetsInText, sanitizeUntrusted, collectInfo, buildInfoPrompt, runInformationOfficer, INFO_PROMPT_VERSION, type InfoSnapshot } from './info.js';
export { BrainQueue, type Job } from './queue.js';
export { parseToolLine, runChatTurn, type ChatTools, type ChatDeps } from './chat.js';
export { PaperBackend, DemoBackend, defaultDemoExecBin, type ExecBackend, type OrderReceipt, type OrderStatusView, type PaperEvent, type EntryRequest } from './execution.js';
export { CliBackend, defaultBinanceCliBin } from './execution-cli.js';
export { AgentMcpBackend, probeMcpConnection, claudeLoginCommand, CLAUDE_LOGIN_COMMAND, lastJsonObject, commandOnPath, defaultAgentSpawn, claudeLoginInstructions, codexLoginInstructions, CODEX_MCP_BLOCKED_DETAIL, DEFAULT_MCP_NAME, DEFAULT_MCP_URL, type AgentCli, type AgentMcpOptions, type AgentSpawn, type McpConnection, type SpawnResult } from './execution-agent.js';
export { simulateOutcome, missedMove, openTrade, stepTrade, tradeR, findFill, type Outcome, type OutcomeInput, type OutcomeStatus, type OpenTrade, type TradeStep } from './outcome.js';
export { loadKlines, lastClosedIndex, visibleWindow, mergeBars, mergeSpans, missingSpans, spansFromBars, fetchKlineRange, fetchKlineSpan, ticker24hFromBars, type Span } from './klines.js';
export {
  StrategyLibrary,
  BUILTIN_STRATEGIES,
  BUILTIN_IDS,
  DEFAULT_ACTIVE_STRATEGIES,
  STATUS_ORDER,
  STATUS_LABEL as STRATEGY_STATUS_LABEL,
  FAMILY_LABEL as STRATEGY_FAMILY_LABEL,
  EMPTY_EVAL_STATS,
  strategyContentHash,
  strategyWakes,
  strategyEvidence,
  renderStrategy,
  renderStrategies,
  fundingZScore,
  tfMinutes,
  type StrategySpec,
  type StrategyStatus,
  type StrategyFamily,
  type StrategyParam,
  type StrategyEvalStats,
  type StrategyEvidenceInput,
  type StrategyEvidenceLine,
} from './strategies.js';
export { reversionStats, reversionCell, emaSeries as reversionEmaSeries, atrSeries as reversionAtrSeries, DEFAULT_KS, DEFAULT_HORIZONS, MIN_BARS as REVERSION_MIN_BARS, type ReversionStats, type ReversionCell } from './reversion-stats.js';
export { DemoStore } from './store.js';
export { DemoRuntime, type RuntimeOptions } from './runtime.js';
export { createServer } from './http.js';
