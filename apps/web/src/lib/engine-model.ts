/**
 * 会话所属引擎及其能力（multi-engine，DECISIONS D20）。
 *
 * 入口是否显示要同时满足两点：这台 agent 够新（各处原有的版本判断）、这个引擎支持
 * （这里）。agent 端也会校验，这里隐藏入口只是体验。
 */
import {
  CLAUDE_ENGINE_ID,
  type EngineCapabilities,
  type EngineRateWindow,
  type EngineSummary,
  type MachineInfo,
  type SessionMeta,
} from '@trine/core';

/** 没带 engines 的旧 agent 只有 Claude Code；能否使用某功能由版本判断决定 */
const CLAUDE_FALLBACK: EngineSummary = {
  id: CLAUDE_ENGINE_ID,
  displayName: 'Claude Code',
  available: true,
  capabilities: {
    interactive: true,
    rewind: ['code', 'conversation', 'both'],
    backgroundTasks: true,
    planMode: true,
    cost: true,
    subagentHistory: true,
    attachments: true,
    mutations: true,
  },
};

type Info = Pick<MachineInfo, 'engines'> | null | undefined;
type Meta = Pick<SessionMeta, 'engine'> | undefined;

export function enginesOf(info: Info): readonly EngineSummary[] {
  return info?.engines ?? [CLAUDE_FALLBACK];
}

/**
 * 会话的引擎；不确定时返回 undefined。meta 还没到时，只有一个引擎的机器可以直接确定
 * （只用 Claude 的机器首屏不闪），多引擎的机器要等 meta。
 */
export function engineOf(info: Info, meta: Meta): EngineSummary | undefined {
  const engines = enginesOf(info);
  if (meta === undefined) return engines.length === 1 ? engines[0] : undefined;
  const id = meta.engine ?? CLAUDE_ENGINE_ID;
  return engines.find((e) => e.id === id);
}

/** 会话的引擎能力；引擎不确定或不认识时为空，即什么都不支持 */
export function capabilitiesOf(info: Info, meta: Meta): EngineCapabilities {
  return engineOf(info, meta)?.capabilities ?? {};
}

/** 列表、头部用的短名：「Claude Code」→「Claude」 */
export function engineTag(engine: Pick<EngineSummary, 'displayName'>): string {
  return engine.displayName.split(/\s+/)[0] ?? engine.displayName;
}

/** 机器上不止一个引擎时才需要在界面上区分；只用 Claude 的界面不变 */
export function hasMultipleEngines(info: Info): boolean {
  return enginesOf(info).length > 1;
}

/** 列表行上的引擎标签；不需要区分时为 undefined。不认识的引擎显示原始 id */
export function sessionEngineTag(info: Info, meta: Meta): string | undefined {
  if (!hasMultipleEngines(info)) return undefined;
  const engine = engineOf(info, meta);
  return engine === undefined ? meta?.engine : engineTag(engine);
}

export interface EngineOption {
  id: string;
  label: string;
}

/** 筛选用：所有机器上的引擎并集；少于两个时为空，不显示筛选 */
export function engineFilterOptions(infos: readonly Info[]): EngineOption[] {
  const out = new Map<string, EngineOption>();
  for (const info of infos) {
    for (const engine of enginesOf(info)) {
      if (!out.has(engine.id)) out.set(engine.id, { id: engine.id, label: engineTag(engine) });
    }
  }
  return out.size > 1 ? [...out.values()] : [];
}

/** 限额窗口的短标签：5h、1w；多桶带桶名；什么都没有时写「限额」 */
export function windowLabel(window: Pick<EngineRateWindow, 'durationMins' | 'bucket'>): string {
  const mins = window.durationMins;
  let span = '';
  if (mins !== undefined) {
    if (mins % 10080 === 0) span = `${mins / 10080}w`;
    else if (mins % 1440 === 0) span = `${mins / 1440}d`;
    else if (mins % 60 === 0) span = `${mins / 60}h`;
    else span = `${mins}m`;
  }
  return [window.bucket, span].filter((p) => p !== undefined && p !== '').join(' ') || '限额';
}

/** 带限额的引擎（Claude 的限额仍在 MachineInfo.rateLimits） */
export function enginesWithLimits(info: Info): readonly EngineSummary[] {
  return enginesOf(info).filter((e) => (e.rateLimits?.windows.length ?? 0) > 0);
}
