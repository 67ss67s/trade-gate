/**
 * Extension point for HTTP route modules. Each feature keeps its routes in its own file
 * (`routes-<feature>.ts`) and registers here with ONE line, so parallel work never collides inside
 * http.ts. `createServer` calls every module after the core routes and before the SSE endpoint.
 */
import type http from 'node:http';
import type { DemoRuntime } from './runtime.js';
import type { DemoStore } from './store.js';
import { indicatorRoutes } from './routes-indicators.js';
import { screenerRoutes } from './routes-screener.js';

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: Record<string, string>) => Promise<void>;

export interface RouteContext {
  route: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, handler: RouteHandler) => void;
  /** Wraps a handler so thrown errors become JSON error responses. */
  guarded: (fn: RouteHandler) => RouteHandler;
  json: (res: http.ServerResponse, status: number, body: unknown) => void;
  fail: (res: http.ServerResponse, status: number, message: string, code?: string) => void;
  readBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>;
  rt: DemoRuntime;
  store: DemoStore;
  /** Broadcast an SSE event (must be listed in http.ts EVENTS). */
  emit: (event: string, data: unknown) => void;
}

export type RouteModule = (ctx: RouteContext) => void;

export const extraRouteModules: RouteModule[] = [
  // ---- register below (one line per module; keep alphabetical)
  indicatorRoutes,
  screenerRoutes,
];
