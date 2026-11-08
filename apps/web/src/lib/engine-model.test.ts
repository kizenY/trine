import { describe, expect, test } from 'bun:test';
import type { EngineSummary } from '@trine/core';
import {
  capabilitiesOf,
  creatableEngines,
  effortOptions,
  preferredEffort,
  engineFilterOptions,
  engineModeLabel,
  engineOf,
  enginesOf,
  enginesWithLimits,
  engineTag,
  sessionEngineTag,
  windowLabel,
} from './engine-model.ts';

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

describe('多引擎展示', () => {
  test('短名取第一个词', () => {
    expect(engineTag({ displayName: 'Claude Code' })).toBe('Claude');
    expect(engineTag({ displayName: 'Codex' })).toBe('Codex');
  });

  test('列表标签：只有一个引擎时不显示', () => {
    expect(sessionEngineTag({ engines: [claude] }, {})).toBeUndefined();
    expect(sessionEngineTag({}, {})).toBeUndefined();
  });

  test('列表标签：多引擎时都标；不认识的显示原始 id', () => {
    const info = { engines: [claude, other] };
    expect(sessionEngineTag(info, {})).toBe('Claude');
    expect(sessionEngineTag(info, { engine: 'other' })).toBe('Other');
    expect(sessionEngineTag(info, { engine: 'future' })).toBe('future');
  });

  test('筛选选项：所有机器的并集，少于两个时为空', () => {
    expect(engineFilterOptions([{ engines: [claude] }, {}])).toEqual([]);
    expect(engineFilterOptions([{ engines: [claude] }, { engines: [claude, other] }])).toEqual([
      { id: 'claude', label: 'Claude' },
      { id: 'other', label: 'Other' },
    ]);
  });

  test('窗口标签按时长换算，多桶带桶名', () => {
    expect(windowLabel({ durationMins: 300 })).toBe('5h');
    expect(windowLabel({ durationMins: 10080 })).toBe('1w');
    expect(windowLabel({ durationMins: 1440 })).toBe('1d');
    expect(windowLabel({ durationMins: 45 })).toBe('45m');
    expect(windowLabel({ durationMins: 300, bucket: 'A' })).toBe('A 5h');
    expect(windowLabel({})).toBe('限额');
  });

  test('只列有窗口的引擎', () => {
    const withLimits = { ...other, rateLimits: { windows: [{ id: 'w', percent: 1 }], updatedAt: 1 } };
    const empty = { ...claude, rateLimits: { windows: [], updatedAt: 1 } };
    expect(enginesWithLimits({ engines: [empty, withLimits] }).map((e) => e.id)).toEqual(['other']);
  });
});

describe('新建与模式', () => {
  test('能新建的引擎：可用且能交互', () => {
    const down = { ...other, id: 'down', available: false, capabilities: { interactive: true } };
    const live = { ...other, id: 'live', capabilities: { interactive: true } };
    expect(creatableEngines({ engines: [claude, other, down, live] }).map((e) => e.id)).toEqual(['claude', 'live']);
  });

  test('模式显示名；目录里没有时显示 id，未知时 undefined', () => {
    const engine = { ...other, modes: [{ id: 'full', label: '完全访问' }] };
    expect(engineModeLabel(engine, 'full')).toBe('完全访问');
    expect(engineModeLabel(engine, 'x')).toBe('x');
    expect(engineModeLabel(engine, undefined)).toBeUndefined();
  });
});


describe('effortOptions', () => {
  const engine: Pick<EngineSummary, 'capabilities' | 'models'> = {
    capabilities: { effort: true },
    models: [
      { id: 'a', label: 'A', efforts: ['low', 'ultra'], defaultEffort: 'low', isDefault: true },
      { id: 'b', label: 'B' },
    ],
  };
  test('按模型给选项；默认模型取 isDefault', () => {
    expect(effortOptions(engine, 'a')).toEqual({ efforts: ['low', 'ultra'], defaultEffort: 'low' });
    expect(effortOptions(engine, 'default')?.efforts).toEqual(['low', 'ultra']);
  });
  test('无模型目录的引擎使用统一选项；保存的默认值仍检查能力和模型', () => {
    const claude: EngineSummary = { id: 'claude', displayName: 'Claude', available: true, capabilities: { effort: true }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
    expect(effortOptions(claude, 'opus[1m]')?.efforts).toContain('max');
    expect(preferredEffort(claude, 'custom-model', 'max')).toBe('max');
    expect(preferredEffort({ ...claude, capabilities: {} }, 'opus', 'max')).toBeUndefined();
    const codex: EngineSummary = { ...engine, id: 'codex', displayName: 'Codex', available: true };
    expect(preferredEffort(codex, 'a', 'ultra')).toBe('ultra');
    expect(preferredEffort(codex, 'a', 'high')).toBeUndefined();
    expect(preferredEffort(codex, 'b', 'ultra')).toBeUndefined();
  });
  test('引擎不支持、模型没有强度、手填的模型：都不显示', () => {
    expect(effortOptions({ ...engine, capabilities: {} }, 'a')).toBeUndefined();
    expect(effortOptions(engine, 'b')).toBeUndefined();
    expect(effortOptions(engine, 'typed-by-hand')).toBeUndefined();
    expect(effortOptions(undefined, 'a')).toBeUndefined();
  });
});
