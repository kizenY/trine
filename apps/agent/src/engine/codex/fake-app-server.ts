/** 测试用的假 app-server：按方法名回放合成响应，绝不碰本机的 codex */
import type { AppServerHandlers, SpawnAppServer } from './app-server.ts';

export type FakeRoute = (params: unknown) => unknown;

export class FakeAppServer {
  readonly calls: { method: string; params: unknown }[] = [];
  spawnCount = 0;
  killed = 0;
  /** 真的把这些消息推给客户端（服务端请求、畸形行等） */
  handlers: AppServerHandlers | undefined;
  readonly sent: unknown[] = [];

  constructor(public routes: Record<string, FakeRoute> = {}) {}

  readonly spawn: SpawnAppServer = (handlers) => {
    this.spawnCount += 1;
    this.handlers = handlers;
    return {
      send: (line) => {
        const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
        this.sent.push(message);
        if (message.method === undefined || message.id === undefined) return;
        this.calls.push({ method: message.method, params: message.params });
        const route =
          message.method === 'initialize'
            ? () => ({ userAgent: 'trine/9.9.9 (synthetic)', codexHome: '/synthetic' })
            : this.routes[message.method];
        queueMicrotask(() => {
          if (route === undefined) {
            handlers.onLine(JSON.stringify({ id: message.id, error: { code: -32601, message: 'no route' } }));
            return;
          }
          try {
            handlers.onLine(JSON.stringify({ id: message.id, result: route(message.params) }));
          } catch (err) {
            const error = err as { code?: number; message: string };
            handlers.onLine(JSON.stringify({ id: message.id, error: { code: error.code ?? -32600, message: error.message } }));
          }
        });
      },
      kill: () => {
        this.killed += 1;
      },
    };
  };
}

export function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/** 合成 thread */
export function fakeThread(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    preview: `prompt ${id}`,
    name: null,
    cwd: '/synthetic/project',
    model: 'synthetic-model',
    createdAt: 1000,
    updatedAt: 2000,
    recencyAt: null,
    source: 'cli',
    status: { type: 'notLoaded' },
    gitInfo: { sha: null, branch: 'main', originUrl: null },
    historyMode: 'paginated',
    ...over,
  };
}
