/**
 * Codex 引擎（multi-engine，DECISIONS D20）：经 app-server 列会话、读历史、读限额，建和管理
 * thread；活跃会话见 session.ts。列会话、读历史不加载 thread，不占活跃名额。
 */
import type { EngineModel, EngineRateWindow, EngineSummary, HistoryItem, PermissionMode, SessionMeta } from '@trine/core';
import type { CreateSessionArgs } from '../../bridge/manager.ts';
import { AppServerClient, AppServerError, type AppServerClientOptions, type SpawnAppServer } from './app-server.ts';
import { codexItemToHistory } from './history.ts';
import { CODEX_MODES, isCodexMode, legacyFromMode, threadModeParams, DEFAULT_CODEX_MODE } from './modes.ts';
import { CODEX_DEFAULT_MODEL, CODEX_ENGINE_ID } from './ids.ts';
import { CodexSession, type CodexSessionClient, type CodexSessionEvents } from './session.ts';

export { CODEX_ENGINE_ID };

const THREAD_PAGE = 100;
const THREAD_MAX_PAGES = 10;
const ITEM_PAGE = 200;
const ITEM_MAX_PAGES = 50;
/** 查无此 thread 的结果缓存：Claude 会话也会走到 owns()，别每次都问一遍 */
const NOT_OWNED_TTL_MS = 60_000;
/** 列会话时顺带刷新账号信息的最小间隔 */
const ACCOUNT_REFRESH_MS = 5 * 60_000;
const THREAD_NOT_FOUND_CODE = -32600;
/** 列表的等待上限：要小于 client 的请求超时，Codex 卡住也不能拖住 Claude 的列表 */
const LIST_WAIT_MS = 3_000;
/** thread/list 默认只给交互来源；exec 也要，标成临时会话。子 agent 的 thread 不列 */
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer'];

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
function secToMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : undefined;
}

/** thread（thread/list、thread/read 的元素）→ SessionMeta；缺关键字段返回 undefined */
export function threadToMeta(thread: unknown): SessionMeta | undefined {
  if (!isRecord(thread)) return undefined;
  const sessionId = str(thread['id']);
  if (sessionId === undefined) return undefined;
  const preview = str(thread['preview']);
  const createdAt = secToMs(thread['createdAt']);
  const updatedAt = secToMs(thread['recencyAt']) ?? secToMs(thread['updatedAt']) ?? createdAt ?? 0;
  const git = thread['gitInfo'];
  const branch = isRecord(git) ? str(git['branch']) : undefined;
  return {
    sessionId,
    title: str(thread['name']) ?? preview ?? '',
    state: 'idle',
    lastActivityAt: updatedAt,
    cwd: str(thread['cwd']) ?? '',
    model: str(thread['model']) ?? '',
    // 只读阶段拿不到这个 thread 的权限设置；Codex 会话的真值之后放 engineMode
    permissionMode: 'default',
    costUsd: 0,
    engine: CODEX_ENGINE_ID,
    ...(preview === undefined ? {} : { lastEvent: preview, firstPrompt: preview }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(branch === undefined ? {} : { gitBranch: branch }),
    ...(thread['source'] === 'exec' ? { headless: true } : {}),
  };
}

function windowOf(raw: unknown, id: string, bucket: string | undefined): EngineRateWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const percent = raw['usedPercent'];
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return undefined;
  const duration = raw['windowDurationMins'];
  const resetsAt = secToMs(raw['resetsAt']);
  return {
    id,
    percent,
    ...(bucket === undefined ? {} : { bucket }),
    ...(typeof duration === 'number' && Number.isInteger(duration) && duration > 0 ? { durationMins: duration } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** account/rateLimits/read → 窗口列表。多个桶才标桶名，常见的单桶不占显示位置 */
export function rateWindows(response: unknown): EngineRateWindow[] {
  if (!isRecord(response)) return [];
  const byId = response['rateLimitsByLimitId'];
  const snapshots: [string, unknown][] = isRecord(byId) ? Object.entries(byId) : [['default', response['rateLimits']]];
  const multiple = snapshots.length > 1;
  const out: EngineRateWindow[] = [];
  for (const [limitId, snapshot] of snapshots) {
    if (!isRecord(snapshot)) continue;
    const bucket = multiple ? (str(snapshot['limitName']) ?? limitId).slice(0, 64) : undefined;
    for (const key of ['primary', 'secondary']) {
      const window = windowOf(snapshot[key], `${limitId}:${key}`.slice(0, 64), bucket);
      if (window !== undefined) out.push(window);
    }
  }
  return out.slice(0, 16);
}

export type CodexClient = Pick<AppServerClient, 'call' | 'userAgent' | 'dispose'> &
  Partial<Pick<AppServerClient, 'hold' | 'release'>>;

export interface CodexEngineOptions {
  /** 给了 client 就用它（只测目录时）；否则按 spawn 建一个，并接上通知与审批 */
  client?: CodexClient;
  spawn?: SpawnAppServer;
  clientVersion?: string;
  clientOptions?: Pick<AppServerClientOptions, 'callTimeoutMs' | 'idleMs' | 'startRetryMs'>;
  now?: () => number;
  log?: (line: string) => void;
  /** summary 变了（登录状态、版本、限额）：调用方广播 machine.info */
  onChange?: () => void;
}

export class CodexEngine implements CodexSessionClient {
  readonly #client: CodexClient;
  /** threadId → 活跃会话 */
  readonly #sessions = new Map<string, CodexSessionEvents>();
  #models: EngineModel[] = [];
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #onChange: () => void;
  readonly #owned = new Map<string, SessionMeta>();
  readonly #notOwned = new Map<string, number>();
  #accountAt: number | undefined;
  #refreshing: Promise<void> | undefined;
  #unavailableReason: string | undefined;
  #windows: EngineRateWindow[] = [];
  #rateAt = 0;
  #version: string | undefined;

  constructor(options: CodexEngineOptions) {
    this.#now = options.now ?? Date.now;
    this.#client =
      options.client ??
      new AppServerClient({
        spawn: options.spawn ?? (() => {
          throw new AppServerError('没有 codex 可执行文件');
        }),
        clientVersion: options.clientVersion ?? '0',
        ...options.clientOptions,
        now: this.#now,
        ...(options.log === undefined ? {} : { log: options.log }),
        onNotification: (method, params) => this.#onNotification(method, params),
        onServerRequest: (id, method, params, reply) => {
          const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : undefined;
          const session = threadId === undefined ? undefined : this.#sessions.get(threadId);
          return session?.onServerRequest(id, method, params, reply) ?? false;
        },
        onExit: () => {
          for (const session of this.#sessions.values()) session.onExit();
        },
      });
    this.#log = options.log ?? (() => {});
    this.#onChange = options.onChange ?? (() => {});
  }

  summary(): EngineSummary {
    return {
      id: CODEX_ENGINE_ID,
      displayName: 'Codex',
      ...(this.#version === undefined ? {} : { version: this.#version }),
      available: this.#unavailableReason === undefined,
      ...(this.#unavailableReason === undefined ? {} : { unavailableReason: this.#unavailableReason.slice(0, 300) }),
      capabilities: { interactive: true, attachments: true, mutations: true },
      ...(this.#models.length === 0 ? {} : { models: this.#models }),
      modes: CODEX_MODES,
      ...(this.#windows.length === 0 ? {} : { rateLimits: { windows: this.#windows, updatedAt: this.#rateAt } }),
    };
  }

  call(method: string, params: unknown): Promise<unknown> {
    return this.#client.call(method, params);
  }

  attach(threadId: string, session: CodexSessionEvents): void {
    if (!this.#sessions.has(threadId)) this.#client.hold?.();
    this.#sessions.set(threadId, session);
  }

  detach(threadId: string, session: CodexSessionEvents): boolean {
    if (this.#sessions.get(threadId) !== session) return false;
    this.#sessions.delete(threadId);
    this.#client.release?.();
    return true;
  }

  /** 建一个新 thread。thread 的 id 只能由 Codex 生成，首条消息之前不落盘（spike.md） */
  async startThread(args: {
    cwd: string;
    model: string;
    engineMode?: string | undefined;
  }): Promise<{ threadId: string; model: string; engineMode: string; permissionMode: PermissionMode }> {
    const mode = isCodexMode(args.engineMode) ? args.engineMode : DEFAULT_CODEX_MODE;
    const result = await this.#client.call('thread/start', {
      cwd: args.cwd,
      approvalsReviewer: 'user',
      ...threadModeParams(mode),
      ...(args.model === CODEX_DEFAULT_MODEL || args.model === '' ? {} : { model: args.model }),
    });
    const thread = isRecord(result) ? result['thread'] : undefined;
    const threadId = isRecord(thread) ? str(thread['id']) : undefined;
    if (threadId === undefined) throw new AppServerError('thread/start 没有返回 thread id');
    const model = (isRecord(result) ? str(result['model']) : undefined) ?? args.model;
    return { threadId, model, engineMode: mode, permissionMode: legacyFromMode(mode) };
  }

  createSession(args: CreateSessionArgs): CodexSession {
    return new CodexSession({
      sessionId: args.sessionId,
      cwd: args.cwd,
      model: args.model,
      permissionMode: args.permissionMode,
      engineMode: args.engineMode,
      resume: args.resume === true,
      client: this,
      emit: args.emit,
      onMeta: args.onMeta,
      onIdle: args.onIdle,
      log: this.#log,
      now: this.#now,
    });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    try {
      await this.#client.call('thread/name/set', { threadId: sessionId, name: title });
    } catch (err) {
      // 首条消息之前 thread 还没落盘：转成 mutations 认识的「not found」，标题先记着
      if (err instanceof AppServerError && err.code === THREAD_NOT_FOUND_CODE) throw new Error(`thread not found: ${sessionId}`);
      throw err;
    }
    const meta = this.#owned.get(sessionId);
    if (meta !== undefined) this.#owned.set(sessionId, { ...meta, title });
  }

  async delete(sessionId: string): Promise<void> {
    await this.#client.call('thread/delete', { threadId: sessionId });
    this.#owned.delete(sessionId);
  }

  #onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'account/rateLimits/updated') {
      this.#applyRateUpdate(params['rateLimits']);
      return;
    }
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : undefined;
    if (method === 'thread/name/updated' && threadId !== undefined) {
      const meta = this.#owned.get(threadId);
      const name = str(params['threadName']) ?? str(params['name']);
      if (meta !== undefined && name !== undefined) this.#owned.set(threadId, { ...meta, title: name });
    }
    if (threadId !== undefined) this.#sessions.get(threadId)?.onNotification(method, params);
  }

  /** 更新是稀疏的：只替换这一桶带来的窗口，没带的保留。没见过的桶重读一次拿全 */
  #applyRateUpdate(snapshot: unknown): void {
    if (!isRecord(snapshot)) return;
    const limitId = str(snapshot['limitId']);
    if (limitId === undefined) return;
    const bucketWindows = this.#windows.filter((w) => w.id.startsWith(`${limitId}:`));
    if (bucketWindows.length === 0) {
      void this.refresh();
      return;
    }
    const before = JSON.stringify(this.#windows);
    const bucket = bucketWindows[0]?.bucket;
    const next = [...this.#windows];
    for (const key of ['primary', 'secondary']) {
      const window = windowOf(snapshot[key], `${limitId}:${key}`.slice(0, 64), bucket);
      if (window === undefined) continue;
      const index = next.findIndex((w) => w.id === window.id);
      if (index >= 0) next[index] = window;
      else next.push(window);
    }
    this.#windows = next;
    this.#rateAt = this.#now();
    if (JSON.stringify(next) !== before) this.#onChange();
  }

  /** 全部会话；app-server 不可用时抛错，调用方决定怎么降级 */
  async listSessions(): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < THREAD_MAX_PAGES; page++) {
      const result = await this.#client.call('thread/list', {
        limit: THREAD_PAGE,
        sortKey: 'updated_at',
        useStateDbOnly: true,
        sourceKinds: SOURCE_KINDS,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!isRecord(result) || !Array.isArray(result['data'])) break;
      for (const thread of result['data']) {
        const meta = threadToMeta(thread);
        if (meta !== undefined) metas.push(meta);
      }
      cursor = str(result['nextCursor']);
      if (cursor === undefined) break;
    }
    this.#owned.clear();
    for (const meta of metas) this.#owned.set(meta.sessionId, meta);
    if (this.#accountAt === undefined || this.#now() - this.#accountAt >= ACCOUNT_REFRESH_MS) {
      void this.refresh();
    }
    return metas;
  }

  /**
   * 给列表用：等一小会儿，来不及或失败就用上次的结果。没等到的那次仍会跑完并更新缓存，
   * 下次列表就有了。
   */
  listSessionsBounded(waitMs = LIST_WAIT_MS): Promise<SessionMeta[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.cachedSessions()), waitMs);
      this.listSessions().then(
        (metas) => {
          clearTimeout(timer);
          resolve(metas);
        },
        (err: unknown) => {
          clearTimeout(timer);
          this.#log(`[codex] 列会话失败：${err instanceof Error ? err.message : String(err)}`);
          resolve(this.cachedSessions());
        },
      );
    });
  }

  /** 最近一次成功的结果；app-server 不可用时列表退回它 */
  cachedSessions(): SessionMeta[] {
    return [...this.#owned.values()];
  }

  /** 最近一次列表或查询到的 meta（同步：manager 的 snapshot / metaOf 用） */
  metaOf(sessionId: string): SessionMeta | undefined {
    return this.#owned.get(sessionId);
  }

  /** 这个 id 是不是 Codex 的会话。app-server 不可用时抛错 */
  async owns(sessionId: string): Promise<boolean> {
    if (this.#owned.has(sessionId)) return true;
    const missAt = this.#notOwned.get(sessionId);
    if (missAt !== undefined && this.#now() - missAt < NOT_OWNED_TTL_MS) return false;
    try {
      const result = await this.#client.call('thread/read', { threadId: sessionId });
      const meta = threadToMeta(isRecord(result) ? result['thread'] : undefined);
      if (meta !== undefined && meta.sessionId === sessionId) {
        this.#owned.set(sessionId, meta);
        this.#notOwned.delete(sessionId);
        return true;
      }
    } catch (err) {
      // 只有「invalid request」表示没有这个 thread（实测 -32600 thread not loaded）。
      // 内部错误、进程起不来、超时都不能当「不存在」：GC 会据此清掉归档和置顶标记
      if (!(err instanceof AppServerError) || err.code !== THREAD_NOT_FOUND_CODE) throw err;
    }
    this.#notOwned.set(sessionId, this.#now());
    return false;
  }

  /** 完整历史（旧的在前），分页由调用方做 */
  async history(sessionId: string): Promise<HistoryItem[]> {
    const fallbackTs = this.#owned.get(sessionId)?.createdAt ?? 0;
    const raw = await this.#readItems(sessionId);
    let ts = fallbackTs;
    const items: HistoryItem[] = [];
    for (const item of raw) {
      const converted = codexItemToHistory(item, ts);
      if (converted === undefined) continue;
      ts = converted.ts;
      items.push(converted);
    }
    return items;
  }

  async #readItems(sessionId: string): Promise<unknown[]> {
    try {
      return await this.#readPaginatedItems(sessionId);
    } catch (err) {
      // legacy thread 没有分页接口（-32601）：退回一次读完整个 thread
      if (!(err instanceof AppServerError) || err.code !== -32601) throw err;
    }
    const result = await this.#client.call('thread/read', { threadId: sessionId, includeTurns: true });
    const thread = isRecord(result) ? result['thread'] : undefined;
    const turns = isRecord(thread) && Array.isArray(thread['turns']) ? thread['turns'] : [];
    return turns.flatMap((turn: unknown) => (isRecord(turn) && Array.isArray(turn['items']) ? turn['items'] : []));
  }

  async #readPaginatedItems(sessionId: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ITEM_MAX_PAGES; page++) {
      const result = await this.#client.call('thread/items/list', {
        threadId: sessionId,
        limit: ITEM_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!isRecord(result) || !Array.isArray(result['data'])) break;
      for (const entry of result['data']) {
        if (!isRecord(entry) || !isRecord(entry['item'])) continue;
        // 时间戳在外层，条目本身可能不带
        out.push({ startedAtMs: entry['startedAtMs'], ...entry['item'] });
      }
      cursor = str(result['nextCursor']);
      if (cursor === undefined) break;
    }
    return out;
  }

  /** 刷新登录状态、版本、限额；只读 app-server，不调模型。失败写进 summary，不抛 */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const before = JSON.stringify(this.summary());
    this.#accountAt = this.#now();
    try {
      const account = await this.#client.call('account/read', {});
      const signedIn = isRecord(account) && isRecord(account['account']);
      const needsAuth = isRecord(account) && account['requiresOpenaiAuth'] === true;
      this.#unavailableReason = !signedIn && needsAuth ? 'Codex 未登录：在这台机器上运行 codex login' : undefined;
      const match = /\/(\d+\.\d+\.\d+[^\s]*)/.exec(this.#client.userAgent ?? '');
      if (match !== null) this.#version = match[1]!.slice(0, 64);
      const models = await this.#client.call('model/list', { limit: 64 }).catch(() => undefined);
      const data = isRecord(models) && Array.isArray(models['data']) ? models['data'] : [];
      const list: EngineModel[] = [];
      for (const model of data) {
        if (!isRecord(model) || model['hidden'] === true) continue;
        const id = str(model['id']);
        if (id !== undefined) list.push({ id: id.slice(0, 128), label: (str(model['displayName']) ?? id).slice(0, 128) });
      }
      if (list.length > 0) this.#models = list.slice(0, 64);
      if (this.#unavailableReason === undefined) {
        // API key 等账号没有订阅限额，这里报错是正常的
        const limits = await this.#client.call('account/rateLimits/read', null).catch(() => undefined);
        if (limits !== undefined) {
          this.#windows = rateWindows(limits);
          this.#rateAt = this.#now();
        }
      } else {
        this.#windows = [];
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log(`[codex] 刷新账号信息失败：${message}`);
      this.#unavailableReason = `Codex 不可用：${message}`;
    }
    if (JSON.stringify(this.summary()) !== before) this.#onChange();
  }

  dispose(): void {
    this.#sessions.clear();
    this.#client.dispose();
  }
}
