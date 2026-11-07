/**
 * 「更新 Claude」的纯逻辑（claude-update）：能力探测、最新版本比较 + 把应答整理成给人看的结论。
 * React 胶水在 MachineDetailView，这里零 React 依赖、可直接单测。
 *
 * 能力探测同 session-actions.ts：旧 agent 对不认识的 c2a type 静默丢弃，web
 * 只能等（6 分钟的）超时——所以 `agentVersion >= 0.4.0` 才给入口，版本号解析
 * 不了或还没收到 machine.info 一律当不支持。
 */
import type { EngineInstall, EngineSummary, MachineInfo } from '@trine/core';
import { compareVersions } from '@/components/list/session-actions.ts';
import type { ClaudeUpdateResult } from '@/lib/client.ts';

/** 首个支持 machine.claude.update.request 的 agent 版本 */
export const CLAUDE_UPDATE_MIN_AGENT = '0.4.0';

export function supportsClaudeUpdate(info: Pick<MachineInfo, 'agentVersion'> | null | undefined): boolean {
  if (info === null || info === undefined) return false;
  const cmp = compareVersions(info.agentVersion, CLAUDE_UPDATE_MIN_AGENT);
  return cmp !== null && cmp >= 0;
}

/** `2.1.282 (Claude Code)` → `2.1.282`；别的形状（含 `(SDK 内置)`）原样 */
export function shortClaudeVersion(version: string): string {
  return version.replace(/\s*\(Claude Code\)\s*$/, '').trim();
}

export interface ClaudeUpdateSummary {
  tone: 'success' | 'info' | 'error';
  /** 一句话结论（toast 与结果区标题共用） */
  title: string;
  /** 补充说明（可无） */
  detail?: string;
  /** agent 回来的输出尾部（可能为空） */
  output: string;
  outputTruncated: boolean;
}

/** 运行中的会话不会被重启——结果里必须讲明，否则用户会以为当前会话已是新版 */
export const RUNNING_SESSIONS_NOTE = '运行中的会话仍是旧版本，新开（或空闲回收后重新打开）的会话才会用上新版。';

/** Codex 所有活跃会话共用一个 app-server 进程，要它们都结束才换 */
export const CODEX_RUNNING_NOTE = '有活跃会话时 Codex 进程不会重启，会话都结束后才用上新版。';

/** 更新应答中各引擎共有的部分 */
export type UpdateResult = Pick<ClaudeUpdateResult, 'ok' | 'fromVersion' | 'toVersion' | 'output' | 'outputTruncated' | 'error'>;

export function summarizeClaudeUpdate(res: UpdateResult, engineName = 'Claude', runningNote = RUNNING_SESSIONS_NOTE): ClaudeUpdateSummary {
  const from = shortClaudeVersion(res.fromVersion);
  const to = shortClaudeVersion(res.toVersion);
  const output = res.output;
  const outputTruncated = res.outputTruncated === true;
  if (!res.ok) {
    const message = res.error?.message ?? 'agent 未给出原因';
    return { tone: 'error', title: `更新失败：${message}`, output, outputTruncated };
  }
  if (res.fromVersion === res.toVersion) {
    return { tone: 'info', title: `${engineName} 已是最新（${to}）`, output, outputTruncated };
  }
  return { tone: 'success', title: `${engineName} 已更新：${from} → ${to}`, detail: runningNote, output, outputTruncated };
}

/** 请求本身失败（离线 / 未配对 / 等不到应答） */
export function summarizeClaudeUpdateError(err: unknown): ClaudeUpdateSummary {
  const message = err instanceof Error ? err.message : String(err);
  return { tone: 'error', title: `更新失败：${message}`, output: '', outputTruncated: false };
}

// ---------------------------------------------------------------------------
// 检查最新版本（claude-latest，agent ≥ 0.19.0：machine.info.claudeLatest 有无即能力探测）
// ---------------------------------------------------------------------------

export interface ClaudeLatestView {
  /** 会话所用 claude 的版本号（去掉后缀）；未知为 null */
  current: string | null;
  /** 发布源上的最新版本；还没查到为 null */
  latest: string | null;
  /** Claude 才有渠道 */
  channel?: 'latest' | 'stable';
  /** 由包管理器安装时才有 */
  install?: EngineInstall;
  checkedAt: number | null;
  /** 最近一次检查失败的原因 */
  error: string | null;
  /** true = 有新版本；false = 已是最新（或比渠道更新）；null = 无从判断 */
  updateAvailable: boolean | null;
}

/** `2.1.282 (Claude Code)` / `2.1.251 (SDK 内置)` → 开头的版本号；没有为 null */
export function claudeVersionNumber(version: string | undefined): string | null {
  const m = /^\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(version ?? '');
  return m === null ? null : m[1]!;
}

/** machine.info → 最新版本视图；agent 不支持（没有 claudeLatest）→ null */
export function claudeLatestView(
  info: Pick<MachineInfo, 'claudeVersion' | 'claudeLatest'> | null | undefined,
): ClaudeLatestView | null {
  const latest = info?.claudeLatest;
  if (latest === undefined) return null;
  const current = claudeVersionNumber(info?.claudeVersion);
  const version = latest.version ?? null;
  const cmp = current === null || version === null ? null : compareVersions(current, version);
  return {
    current,
    latest: version,
    channel: latest.channel,
    checkedAt: latest.checkedAt ?? null,
    error: latest.error ?? null,
    updateAvailable: cmp === null ? null : cmp < 0,
    ...(latest.install === undefined ? {} : { install: latest.install }),
  };
}

const MANAGER_LABEL: Record<string, string> = { brew: 'Homebrew', apt: 'apt' };

/** 包管理器的显示名；不认识的原样显示 */
export function managerLabel(manager: string): string {
  return MANAGER_LABEL[manager] ?? manager;
}

/** 引擎目录里的版本信息 → 同一个视图；引擎不能更新时为 null */
export function engineLatestView(engine: Pick<EngineSummary, 'version' | 'latest' | 'capabilities' | 'install'>): ClaudeLatestView | null {
  if (engine.capabilities.update !== true) return null;
  const current = claudeVersionNumber(engine.version);
  const version = engine.latest?.version ?? null;
  const cmp = current === null || version === null ? null : compareVersions(current, version);
  return {
    current,
    latest: version,
    checkedAt: engine.latest?.checkedAt ?? null,
    error: engine.latest?.error ?? null,
    updateAvailable: cmp === null ? null : cmp < 0,
    ...(engine.install === undefined ? {} : { install: engine.install }),
  };
}

/** 有新版本时给机器卡的提示（如 `claude 可更新 → 2.1.308`）；否则空串 */
export function claudeUpdateHint(info: Pick<MachineInfo, 'claudeVersion' | 'claudeLatest'> | null | undefined): string {
  const view = claudeLatestView(info);
  return view?.updateAvailable === true && view.latest !== null ? `claude 可更新 → ${view.latest}` : '';
}

/** 手动检查的结论（toast 用） */
export interface CheckResult {
  ok: boolean;
  currentVersion?: string | undefined;
  latest?: { version: string } | undefined;
  error?: { code?: string; message: string } | undefined;
}

export function summarizeClaudeCheck(res: CheckResult, engineName = 'Claude'): { tone: 'success' | 'info' | 'error'; title: string } {
  if (!res.ok || res.latest === undefined) {
    return { tone: 'error', title: res.error?.message ?? '检查失败：agent 未给出原因' };
  }
  const current = claudeVersionNumber(res.currentVersion);
  const cmp = current === null ? null : compareVersions(current, res.latest.version);
  if (cmp !== null && cmp < 0) return { tone: 'success', title: `${engineName} 有新版本：${current} → ${res.latest.version}` };
  if (cmp === null) return { tone: 'info', title: `${engineName} 最新版本是 ${res.latest.version}` };
  return { tone: 'info', title: `${engineName} 已是最新（${current}）` };
}
