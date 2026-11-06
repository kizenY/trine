/**
 * 会话所属引擎及其能力（multi-engine，DECISIONS D20）。
 *
 * 入口是否显示要同时满足两点：这台 agent 够新（各处原有的版本判断）、这个引擎支持
 * （这里）。agent 端也会校验，这里隐藏入口只是体验。
 */
import {
  CLAUDE_ENGINE_ID,
  type EngineCapabilities,
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
