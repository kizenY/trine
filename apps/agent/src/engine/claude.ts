/** Claude Code 引擎的描述（能力清单给 client 决定显示哪些入口） */
import { CLAUDE_EFFORT_LEVELS, CLAUDE_ENGINE_ID, type EngineSummary } from '@trine/core';

export function claudeEffort(value: string | undefined): (typeof CLAUDE_EFFORT_LEVELS)[number] | undefined {
  if (value === undefined) return undefined;
  const effort = CLAUDE_EFFORT_LEVELS.find((level) => level === value);
  if (effort === undefined) throw new Error(`Claude 不支持推理强度 ${value}`);
  return effort;
}

export function claudeEngineSummary(version: string): EngineSummary {
  return {
    id: CLAUDE_ENGINE_ID,
    displayName: 'Claude Code',
    ...(version === '' ? {} : { version: version.slice(0, 64) }),
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
      contextRefresh: true,
      effort: true,
    },
    efforts: [...CLAUDE_EFFORT_LEVELS],
  };
}
