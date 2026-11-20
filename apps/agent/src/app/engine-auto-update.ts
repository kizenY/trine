/**
 * 引擎自动更新（engine-auto-update）：每个引擎一个开关，存在 `~/.trine/engine-auto-update.json`，
 * 机器级、所有已配对设备共享，经 `EngineSummary.autoUpdate` 下发，用 `machine.engine.autoupdate.set` 开关。
 *
 * ## 什么时候更新
 *
 * 版本检查（claude-latest.ts / codex update.ts：启动后约 30 秒、之后每 6 小时，或手动「检查更新」）
 * 每次成功后调 `onChecked(engine, latest)`：开关开着、查到的版本比当前新，就跑一次该引擎的更新
 * （与机器页手动更新同一个单飞 updater，进行中就跳过）。打开开关时立即查一次。
 * 没有退避：失败的更新等下一次检查再试（最多 6 小时一次，手动检查另算）。
 *
 * 运行中的会话不受影响（与手动更新相同：Claude 新会话才用新版；Codex 的 app-server 等会话都结束再换）。
 * 环境里关了自动检查（DISABLE_AUTOUPDATER 等）时没有自动检查，也就只在手动检查后更新。
 *
 * 文件：`{ v: 1, engines: { <id>: { enabled, last? } } }`。坏文件改名留底后按全关启动。
 */
import { z } from 'zod';
import { EngineAutoUpdateSchema, EngineIdSchema, type EngineAutoUpdate } from '@trine/core';
import { loadJsonFile, writeAtomic } from '../ext/json-file.ts';
import type { ClaudeUpdateOutcome } from './claude-cli.ts';

const FileSchema = z.object({
  v: z.literal(1),
  engines: z.record(EngineIdSchema, EngineAutoUpdateSchema),
});
type AutoUpdateFile = z.infer<typeof FileSchema>;

/** 一个能自动更新的引擎 */
export interface AutoUpdateTarget {
  /** 当前版本号（如 `2.1.282`）；未知为 undefined */
  currentVersion(): string | undefined;
  /** 跑一次更新（单飞 updater，进行中回 busy）。不抛 */
  update(): Promise<ClaudeUpdateOutcome>;
  /** 立即查一次最新版本（打开开关时用）；查完要经 onChecked 回来 */
  check(): Promise<unknown>;
}

export type AutoUpdateSetOutcome =
  | { ok: true; enabled: boolean }
  | { ok: false; enabled: boolean; error: { code: 'not_found' | 'failed'; message: string } };

/** 开头的 `x.y.z[-pre]`；没有为 undefined */
export function versionNumber(raw: string | undefined): string | undefined {
  return /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(raw ?? '')?.[1];
}

/** semver 比较（只看 x.y.z 与预发布段）；解析不了为 null */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): { core: number[]; pre: string[] } | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    return m === null ? null : { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') };
  };
  const va = parse(a);
  const vb = parse(b);
  if (va === null || vb === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = va.core[i]! - vb.core[i]!;
    if (d !== 0) return d;
  }
  if (va.pre.length === 0 || vb.pre.length === 0) return vb.pre.length - va.pre.length;
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export class EngineAutoUpdater {
  readonly #path: string | undefined;
  readonly #targets = new Map<string, AutoUpdateTarget>();
  readonly #running = new Set<string>();
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #data: AutoUpdateFile;
  #chain: Promise<unknown> = Promise.resolve();
  #disposed = false;
  /** 状态变了（开关、最近一次结果）：app 广播 machine.info */
  onChange: () => void = () => {};

  private constructor(path: string | undefined, data: AutoUpdateFile, options: { now?: () => number; log?: (line: string) => void }) {
    this.#path = path;
    this.#data = data;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  /** 不落盘（测试、echo agent） */
  static memory(options: { now?: () => number; log?: (line: string) => void } = {}): EngineAutoUpdater {
    return new EngineAutoUpdater(undefined, { v: 1, engines: {} }, options);
  }

  static async load(path: string, options: { now?: () => number; log?: (line: string) => void } = {}): Promise<EngineAutoUpdater> {
    const now = options.now ?? Date.now;
    const data = await loadJsonFile(path, FileSchema, () => ({ v: 1 as const, engines: {} }), {
      log: options.log ?? (() => {}),
      now,
      tag: 'auto-update',
    });
    return new EngineAutoUpdater(path, data, options);
  }

  /** 登记一个能自动更新的引擎（app 启动时）；没登记的引擎不出现 autoUpdate 字段 */
  register(engine: string, target: AutoUpdateTarget): void {
    this.#targets.set(engine, target);
  }

  /** 放进 EngineSummary.autoUpdate；不支持为 undefined */
  state(engine: string): EngineAutoUpdate | undefined {
    if (!this.#targets.has(engine)) return undefined;
    const stored = this.#data.engines[engine];
    return { enabled: stored?.enabled === true, ...(stored?.last === undefined ? {} : { last: { ...stored.last } }) };
  }

  /** 打开 / 关闭；打开时立即查一次（不等结果） */
  async set(engine: string, enabled: boolean): Promise<AutoUpdateSetOutcome> {
    const target = this.#targets.get(engine);
    if (target === undefined) {
      return { ok: false, enabled: false, error: { code: 'not_found', message: `这台机器不能自动更新引擎 ${engine}` } };
    }
    const before = this.#data.engines[engine]?.enabled === true;
    try {
      await this.#write((data) => {
        const prev = data.engines[engine];
        data.engines[engine] = { ...prev, enabled };
      });
    } catch (err) {
      return { ok: false, enabled: before, error: { code: 'failed', message: `保存设置失败：${(err as Error).message}`.slice(0, 300) } };
    }
    this.#log(`[auto-update] ${engine} 自动更新${enabled ? '已打开' : '已关闭'}`);
    this.onChange();
    if (enabled && !before) void target.check();
    return { ok: true, enabled };
  }

  /**
   * 版本检查成功后调：开着且有新版就更新（不等结果）。返回是否开始了更新（测试用）。
   */
  onChecked(engine: string, latest: string): Promise<boolean> {
    const target = this.#targets.get(engine);
    if (target === undefined || this.#disposed || this.#data.engines[engine]?.enabled !== true) return Promise.resolve(false);
    if (this.#running.has(engine)) return Promise.resolve(false);
    const current = versionNumber(target.currentVersion());
    const cmp = current === undefined ? null : compareVersions(current, latest);
    if (cmp === null || cmp >= 0) return Promise.resolve(false);
    this.#running.add(engine);
    this.#log(`[auto-update] ${engine} 有新版本 ${current} → ${latest}，开始自动更新`);
    return target
      .update()
      .catch((err: unknown): ClaudeUpdateOutcome => ({
        ok: false,
        fromVersion: current ?? '',
        toVersion: current ?? '',
        output: '',
        outputTruncated: false,
        error: { code: 'failed', message: String(err) },
      }))
      .then(async (outcome) => {
        // 另一个更新正在进行（多半是机器页的手动更新）：不算这次自动更新的结果
        if (!outcome.ok && outcome.error?.code === 'busy') return false;
        const last: NonNullable<EngineAutoUpdate['last']> = {
          at: this.#now(),
          ok: outcome.ok,
          fromVersion: (versionNumber(outcome.fromVersion) ?? outcome.fromVersion).slice(0, 64),
          toVersion: (versionNumber(outcome.toVersion) ?? outcome.toVersion).slice(0, 64),
          ...(outcome.ok ? {} : { error: (outcome.error?.message ?? '更新失败').slice(0, 300) }),
        };
        this.#log(`[auto-update] ${engine} 自动更新${outcome.ok ? '完成' : `失败：${last.error}`}（${last.fromVersion} → ${last.toVersion}）`);
        await this.#write((data) => {
          const prev = data.engines[engine];
          data.engines[engine] = { enabled: prev?.enabled === true, last };
        }).catch((err: unknown) => this.#log(`[auto-update] 保存结果失败：${(err as Error).message}`));
        if (!this.#disposed) this.onChange();
        return true;
      })
      .finally(() => this.#running.delete(engine));
  }

  dispose(): void {
    this.#disposed = true;
  }

  /** 串行写：并发的开关与结果各自基于最新内容 */
  #write(mutate: (data: AutoUpdateFile) => void): Promise<void> {
    const task = this.#chain.then(async () => {
      const next: AutoUpdateFile = structuredClone(this.#data);
      mutate(next);
      if (this.#path !== undefined) await writeAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`);
      this.#data = next;
    });
    this.#chain = task.catch(() => {});
    return task;
  }
}
