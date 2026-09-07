// Kline history: paged fetch from the public futures API, an on-disk cache per (symbol, timeframe) that also
// remembers which wall-clock spans were already asked for, and small helpers to cut a "visible as of T"
// window out of a bar series (used by the screener, indicators and the context builder).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchKlines, tfToMs } from './market.js';
import type { Kline } from './types.js';

function fapiBase(): string {
  return process.env['TG_DEMO_MARKET_BASE'] ?? 'https://fapi.binance.com';
}
/**
 * Read per call, not once at import: `TG_DEMO_KLINE_CACHE_DIR` is set by tests in `beforeAll`, which
 * runs AFTER this module is imported — a module-level const meant those tests silently read the real
 * ~/.trading-swarm cache and only passed while it happened to be empty (2026-09-05: warming it for the
 * funnel made three blind-replay tests read live BTC bars).
 */
function cacheDir(): string {
  return process.env['TG_DEMO_KLINE_CACHE_DIR'] ?? join(homedir(), '.trading-swarm', 'demo', 'klines');
}


// ---------------------------------------------------------------- kline cache (repeat runs are free)
//
// Two things are cached per (symbol, tf): the bars, and the wall-clock spans we have already ASKED the
// exchange about. The second half is what makes deep history cheap. A span that came back with a hole in
// it — exchange downtime, or simply "this symbol did not exist yet" — stays *covered*, so the next
// request does not re-page the same emptiness; without it, any imperfect range refetched everything on
// every call. Only closed bars are persisted: the still-forming candle would otherwise be frozen into
// the file with a half-finished close.

/** A closed wall-clock interval, inclusive on both ends. */
export interface Span {
  from: number;
  to: number;
}

interface CacheFile {
  symbol: string;
  tf: string;
  bars: Kline[];
  /** Merged, ascending spans already fetched. Absent in files written before this field existed. */
  ranges?: Span[];
}

/** Sort + coalesce overlapping or touching spans. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from).sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to + 1) last.to = Math.max(last.to, s.to);
    else out.push({ from: s.from, to: s.to });
  }
  return out;
}

/** [from, to] minus everything already covered; fragments shorter than one bar are not worth a request. */
export function missingSpans(covered: Span[], from: number, to: number, step: number): Span[] {
  const out: Span[] = [];
  let cursor = from;
  for (const s of mergeSpans(covered)) {
    if (s.to < cursor) continue;
    if (s.from > to) break;
    if (s.from > cursor) out.push({ from: cursor, to: Math.min(to, s.from - 1) });
    cursor = Math.max(cursor, s.to + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) out.push({ from: cursor, to });
  return out.filter((s) => s.to - s.from >= step);
}

/** Coverage implied by the bars alone — the fallback for cache files written before `ranges` existed. */
export function spansFromBars(bars: Kline[], step: number): Span[] {
  const out: Span[] = [];
  let start: number | null = null;
  let prev: Kline | null = null;
  for (const k of bars) {
    if (start === null || (prev && k.open_time - prev.open_time !== step)) {
      if (start !== null && prev) out.push({ from: start, to: prev.close_time });
      start = k.open_time;
    }
    prev = k;
  }
  if (start !== null && prev) out.push({ from: start, to: prev.close_time });
  return mergeSpans(out);
}

/** Union of two bar arrays, deduped on open_time and sorted ascending. */
export function mergeBars(a: Kline[], b: Kline[]): Kline[] {
  const m = new Map<number, Kline>();
  for (const k of a) m.set(k.open_time, k);
  for (const k of b) m.set(k.open_time, k);
  return [...m.values()].sort((x, y) => x.open_time - y.open_time);
}

function sliceBars(bars: Kline[], from: number, to: number): Kline[] {
  return bars.filter((k) => k.close_time >= from && k.open_time <= to);
}

function cachePath(symbol: string, tf: string): string {
  return join(cacheDir(), `${symbol}-${tf}.json`);
}

function readCache(symbol: string, tf: string): { bars: Kline[]; ranges: Span[] | null } {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(symbol, tf), 'utf8')) as CacheFile;
    const bars = Array.isArray(parsed.bars) ? parsed.bars : [];
    return { bars, ranges: Array.isArray(parsed.ranges) ? mergeSpans(parsed.ranges) : null };
  } catch {
    return { bars: [], ranges: null };
  }
}

function writeCache(symbol: string, tf: string, bars: Kline[], ranges: Span[]): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cachePath(symbol, tf), JSON.stringify({ symbol, tf, bars, ranges } satisfies CacheFile));
  } catch {
    // A read-only home is not a reason to fail a backtest; it only costs the next run a refetch.
  }
}

/**
 * Public klines for [from, to], paging backwards with `endTime` (Binance's only cursor on this endpoint)
 * at 1500 per page. `reached_start` says whether the walk actually got back to `from` (or ran out of
 * history trying, which is the same thing for caching purposes) rather than hitting the page cap — only
 * then may the caller record the whole span as covered. A fake/misbehaving server that never moves the
 * cursor back cannot spin this loop.
 */
export async function fetchKlineSpan(symbol: string, tf: string, from: number, to: number): Promise<{ bars: Kline[]; reached_start: boolean }> {
  const out = new Map<number, Kline>();
  let end = to;
  let prevEarliest = Number.POSITIVE_INFINITY;
  let reached = false;
  for (let page = 0; page < 200; page++) {
    const rows = await fetchKlines(symbol, tf, 1500, end);
    if (!rows.length) {
      reached = true; // nothing further back exists — the symbol simply did not trade there
      break;
    }
    for (const k of rows) out.set(k.open_time, k);
    const earliest = rows[0]!.open_time;
    if (earliest <= from || earliest >= prevEarliest) {
      reached = true;
      break;
    }
    prevEarliest = earliest;
    end = earliest - 1;
  }
  return { bars: [...out.values()].sort((a, b) => a.open_time - b.open_time), reached_start: reached };
}

/** Back-compat wrapper: the bars only. */
export async function fetchKlineRange(symbol: string, tf: string, from: number, to: number): Promise<Kline[]> {
  return (await fetchKlineSpan(symbol, tf, from, to)).bars;
}

/** Cached klines for [from, to]; only the spans never asked about cost a request. */
export async function loadKlines(symbol: string, tf: string, from: number, to: number): Promise<Kline[]> {
  const step = tfToMs(tf);
  const cache = readCache(symbol, tf);
  const covered = cache.ranges ?? spansFromBars(cache.bars, step);
  const gaps = missingSpans(covered, from, to, step);
  if (gaps.length === 0) return sliceBars(cache.bars, from, to);

  const now = Date.now();
  let bars = cache.bars;
  const fetched: Span[] = [];
  for (const gap of gaps) {
    const page = await fetchKlineSpan(symbol, tf, gap.from, gap.to);
    bars = mergeBars(bars, page.bars);
    // Coverage stops at the last *closed* bar, and at whatever we actually reached going back.
    const left = page.reached_start ? gap.from : (page.bars[0]?.open_time ?? gap.to);
    const right = Math.min(gap.to, now - 1);
    if (right >= left) fetched.push({ from: left, to: right });
  }
  writeCache(
    symbol,
    tf,
    bars.filter((k) => k.close_time < now),
    mergeSpans([...covered, ...fetched]),
  );
  return sliceBars(bars, from, to);
}

interface FundingPoint {
  at: number;
  rate: string;
}

/**
 * Historical funding (fapi /fundingRate) — the one "market micro-structure" number that IS available
 * for a past timestamp. Best effort: any failure yields an empty history and the funding evidence line
 * is simply omitted from the context rather than filled with a made-up 0.
 */
async function loadFunding(symbol: string, from: number, to: number): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  try {
    let start = from;
    for (let page = 0; page < 20 && start < to; page++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let rows: { fundingTime: number; fundingRate: string }[];
      try {
        const res = await fetch(`${fapiBase()}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${Math.floor(start)}&endTime=${Math.floor(to)}&limit=1000`, { signal: ctrl.signal });
        if (!res.ok) break;
        rows = (await res.json()) as { fundingTime: number; fundingRate: string }[];
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) out.push({ at: Number(r.fundingTime), rate: String(r.fundingRate) });
      const lastAt = out[out.length - 1]!.at;
      if (rows.length < 1000 || lastAt <= start) break;
      start = lastAt + 1;
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- visible-window helpers (the blind edge)

/** Index of the last bar with close_time ≤ t, or -1. Binary search: the walk asks this a lot. */
export function lastClosedIndex(bars: Kline[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.close_time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The last `count` bars closed at or before `t` — the only klines a judgment at `t` may see. */
export function visibleWindow(bars: Kline[], t: number, count: number): Kline[] {
  const end = lastClosedIndex(bars, t);
  if (end < 0) return [];
  return bars.slice(Math.max(0, end - count + 1), end + 1);
}

/** 24h ticker rebuilt from the visible bars (Binance's own /ticker/24hr is a "now" endpoint). */
export function ticker24hFromBars(bars: Kline[], t: number, tf: string): { priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string } {
  const win = visibleWindow(bars, t, Math.max(1, Math.round(86_400_000 / tfToMs(tf))));
  if (!win.length) return { priceChangePercent: '0.000', highPrice: '0', lowPrice: '0', quoteVolume: '0' };
  const first = win[0]!;
  const last = win[win.length - 1]!;
  const o = Number(first.open);
  const c = Number(last.close);
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  let qv = 0;
  for (const k of win) {
    hi = Math.max(hi, Number(k.high));
    lo = Math.min(lo, Number(k.low));
    qv += Number(k.volume) * Number(k.close);
  }
  const d = (last.close.split('.')[1] ?? '').length;
  return { priceChangePercent: (o > 0 ? ((c - o) / o) * 100 : 0).toFixed(3), highPrice: hi.toFixed(d), lowPrice: lo.toFixed(d), quoteVolume: qv.toFixed(2) };
}

// ---------------------------------------------------------------- the series bundle

