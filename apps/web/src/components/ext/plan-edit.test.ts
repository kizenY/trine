import { describe, expect, test } from 'bun:test';
import type { EngineSummary } from '@trine/core';
import { draftBlocked, draftToEdit, initialDraft, modelChoices, switchEngine, switchModel, type SessionCreateStep } from './plan-edit.ts';

const step: SessionCreateStep = {
  type: 'session.create',
  cwd: '/work/repo',
  prompt: '继续 task-a',
  model: 'opus',
  permissionMode: 'bypassPermissions',
  links: [],
};

const claude: EngineSummary = {
  id: 'claude',
  displayName: 'Claude Code',
  available: true,
  capabilities: { interactive: true, effort: true },
  efforts: ['low', 'high'],
};
const codex: EngineSummary = {
  id: 'codex',
  displayName: 'Codex',
  available: true,
  capabilities: { interactive: true, effort: true },
  models: [
    { id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'], isDefault: true },
    { id: 'mini', label: 'Mini' },
  ],
  modes: [
    { id: 'auto', label: '自动', default: true },
    { id: 'full', label: '完全访问', dangerous: true },
  ],
};
const defaults = { defaultModel: 'sonnet', defaultPermissionMode: 'default' as const, engineDefaults: { codex: { model: 'gpt-5', effort: 'high' } } };

describe('plan-edit', () => {
  test('没改动：不发 edit', () => {
    expect(draftToEdit(0, step, initialDraft(step), claude)).toBeUndefined();
  });

  test('只改首条消息：只带 prompt', () => {
    expect(draftToEdit(1, step, { ...initialDraft(step), prompt: '新的接续' }, claude)).toEqual({ step: 1, prompt: '新的接续' });
  });

  test('改 Claude 的权限模式：带整套配置，强度跟随配置为 null', () => {
    const draft = { ...initialDraft(step), mode: { value: 'plan' as const, pending: null } };
    expect(draftToEdit(0, step, draft, claude)).toEqual({ step: 0, engine: 'claude', model: 'opus', permissionMode: 'plan', effort: null });
  });

  test('换到 Codex：用该引擎保存的默认，模式取目录默认；edit 带 engineMode 不带 permissionMode', () => {
    const draft = switchEngine(initialDraft(step), step, codex, defaults);
    expect(draft).toMatchObject({ engine: 'codex', model: 'gpt-5', engineMode: { value: 'auto' }, effort: 'high', prompt: '继续 task-a' });
    expect(draftToEdit(0, step, draft, codex)).toEqual({ step: 0, engine: 'codex', model: 'gpt-5', engineMode: 'auto', effort: 'high' });
  });

  test('换回原来的引擎：恢复计划的值，保留改过的消息', () => {
    const edited = { ...switchEngine(initialDraft(step), step, codex, defaults), prompt: '改过' };
    expect(switchEngine(edited, step, claude, defaults)).toEqual({ ...initialDraft(step), prompt: '改过' });
  });

  test('换到没有强度的模型：强度回到跟随配置', () => {
    const draft = switchEngine(initialDraft(step), step, codex, defaults);
    expect(switchModel(draft, codex, 'mini').effort).toBeUndefined();
    expect(switchModel(draft, codex, 'gpt-5').effort).toBe('high');
  });

  test('模型候选：目录引擎含「跟随配置」，否则用已知模型；当前值总在里面', () => {
    expect(modelChoices(codex, ['opus'], 'gpt-5').map((m) => m.id)).toEqual(['default', 'gpt-5', 'mini']);
    expect(modelChoices(claude, ['opus', 'sonnet'], 'custom-x').map((m) => m.id)).toEqual(['opus', 'sonnet', 'custom-x']);
  });

  test('空消息、待确认的危险模式：不能确认', () => {
    expect(draftBlocked(initialDraft(step))).toBeNull();
    expect(draftBlocked({ ...initialDraft(step), prompt: '  ' })).toContain('不能为空');
    expect(draftBlocked({ ...initialDraft(step), mode: { value: 'default', pending: 'bypassPermissions' } })).toContain('再点一次');
    // 另一个引擎的待确认不挡（控件不显示）
    expect(draftBlocked({ ...initialDraft(step), engineMode: { value: 'auto', pending: 'full' } })).toBeNull();
  });

  test('Claude 上点了一次 bypass 再换到 Codex：待确认作废，不挡确认', () => {
    const half = { ...initialDraft(step), mode: { value: 'default' as const, pending: 'bypassPermissions' as const } };
    const draft = switchEngine(half, step, codex, defaults);
    expect(draft.mode.pending).toBeNull();
    expect(draftBlocked(draft)).toBeNull();
  });
});
