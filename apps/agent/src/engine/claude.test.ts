import { describe, expect, test } from 'bun:test';
import { MachineInfoSchema } from '@trine/core';
import { buildMachineInfo } from '../app/machine-info.ts';
import { claudeEngineSummary } from './claude.ts';

describe('claudeEngineSummary', () => {
  test('进 machine.info 且过 schema', () => {
    const info = buildMachineInfo({
      name: 'm',
      claudeVersion: '2.1.0',
      activeSessionCount: 0,
      maxSessions: 10,
      engines: [claudeEngineSummary('2.1.0')],
    });
    const parsed = MachineInfoSchema.parse(info);
    expect(parsed.engines?.[0]).toMatchObject({ id: 'claude', version: '2.1.0', available: true });
    expect(parsed.engines?.[0]?.capabilities.interactive).toBe(true);
    expect(parsed.engines?.[0]?.capabilities.effort).toBe(true);
    expect(parsed.engines?.[0]?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(parsed.engines?.[0]?.capabilities.rewind).toEqual(['code', 'conversation', 'both']);
  });

  test('版本未知时不带 version', () => {
    expect(claudeEngineSummary('').version).toBeUndefined();
  });
});
