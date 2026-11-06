import { describe, expect, test } from 'bun:test';
import type { EngineSummary } from '@trine/core';
import { capabilitiesOf, engineOf, enginesOf } from './engine-model.ts';

const claude: EngineSummary = {
  id: 'claude',
  displayName: 'Claude Code',
  available: true,
  capabilities: { interactive: true, cost: true },
};
const other: EngineSummary = {
  id: 'other',
  displayName: 'Other',
  available: true,
  capabilities: { interactive: false },
};

describe('engine-model', () => {
  test('旧 agent 不带 engines：只有 Claude，能力齐全', () => {
    expect(enginesOf({}).map((e) => e.id)).toEqual(['claude']);
    expect(enginesOf(null).map((e) => e.id)).toEqual(['claude']);
    const caps = capabilitiesOf({}, { sessionId: 's' } as never);
    expect(caps.interactive).toBe(true);
    expect(caps.rewind).toEqual(['code', 'conversation', 'both']);
  });

  test('meta 省略 engine 即 Claude', () => {
    expect(engineOf({ engines: [claude, other] }, {})?.id).toBe('claude');
  });

  test('按 meta.engine 取能力', () => {
    expect(capabilitiesOf({ engines: [claude, other] }, { engine: 'other' }).interactive).toBe(false);
  });

  test('meta 未到：单引擎机器直接确定，多引擎机器不确定', () => {
    expect(engineOf({ engines: [claude] }, undefined)?.id).toBe('claude');
    expect(engineOf({ engines: [claude, other] }, undefined)).toBeUndefined();
    expect(capabilitiesOf({ engines: [claude, other] }, undefined)).toEqual({});
  });

  test('不认识的引擎什么都不支持', () => {
    expect(engineOf({ engines: [claude] }, { engine: 'future' })).toBeUndefined();
    expect(capabilitiesOf({ engines: [claude] }, { engine: 'future' })).toEqual({});
  });
});
