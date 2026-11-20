/**
 * 扩展执行计划确认框：agent 支持 planEdit 时，新会话步骤可换引擎、改首条消息，确认带回 edits；
 * 不改就按原计划（true）；旧 agent 只读展示。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { EngineSummary, ExtPlan } from '@trine/core';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { store } = await import('@/app/runtime.ts');
const { defaultPrefs } = await import('@/lib/storage.ts');
const { ExtDialogsHost } = await import('./ExtDialogs.tsx');
const { requestConfirm } = await import('./use-ext.ts');

const MACHINE = 'mbp';
const engines: EngineSummary[] = [
  { id: 'claude', displayName: 'Claude Code', available: true, capabilities: { interactive: true } },
  {
    id: 'codex',
    displayName: 'Codex',
    available: true,
    capabilities: { interactive: true },
    models: [{ id: 'gpt-5', label: 'GPT-5' }],
    modes: [{ id: 'auto', label: '自动', default: true }],
  },
];
const plan: ExtPlan = {
  ext: 'tasks',
  extName: '任务',
  extVersion: '1',
  actionLabel: '新会话接续',
  steps: [{ type: 'session.create', cwd: '/w', prompt: '继续 task-a', model: 'opus', permissionMode: 'default', links: [] }],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  act(() => store.setState({ prefs: defaultPrefs(), machines: {} }));
});

function mount(planEdit: boolean): void {
  act(() =>
    store.setState({
      prefs: defaultPrefs(),
      machines: {
        [MACHINE]: {
          machineId: MACHINE,
          name: 'MBP',
          online: true,
          info: { name: 'MBP', engines, extensions: { api: 1, rev: 'r', count: 1, ...(planEdit ? { planEdit: true } : {}) } },
        },
      } as never,
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <ExtDialogsHost />
      </MemoryRouter>,
    ),
  );
}

const $ = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const pick = (id: string, attr: string, value: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"][${attr}="${value}"]`)!;

function typeInto(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('计划确认框', () => {
  test('换到 Codex、改消息：确认带回 edits', async () => {
    mount(true);
    let outcome: unknown;
    act(() => {
      void requestConfirm(plan, MACHINE).then((o) => (outcome = o));
    });
    expect($('plan-session-create')!.dataset.editable).toBe('true');
    act(() => pick('plan-engine', 'data-engine', 'codex').click());
    expect(pick('plan-mode', 'data-mode', 'auto').dataset.selected).toBe('true');
    typeInto($('plan-prompt') as HTMLTextAreaElement, '改过的接续');
    await act(async () => $('ext-confirm-ok')!.click());
    expect(outcome).toEqual({
      edits: [{ step: 0, prompt: '改过的接续', engine: 'codex', model: 'default', engineMode: 'auto', effort: null }],
    });
  });

  test('没改动：按原计划（true）；消息清空时不能确认', async () => {
    mount(true);
    let outcome: unknown;
    act(() => {
      void requestConfirm(plan, MACHINE).then((o) => (outcome = o));
    });
    typeInto($('plan-prompt') as HTMLTextAreaElement, '');
    expect($('ext-confirm-ok')!.hasAttribute('disabled')).toBe(true);
    typeInto($('plan-prompt') as HTMLTextAreaElement, '继续 task-a');
    await act(async () => $('ext-confirm-ok')!.click());
    expect(outcome).toBe(true);
  });

  test('旧 agent：只读展示', async () => {
    mount(false);
    let outcome: unknown;
    act(() => {
      void requestConfirm(plan, MACHINE).then((o) => (outcome = o));
    });
    expect($('plan-session-create')!.dataset.editable).toBeUndefined();
    expect($('plan-prompt')).toBeNull();
    await act(async () => $('ext-confirm-ok')!.click());
    expect(outcome).toBe(true);
  });
});
