/**
 * 引擎自动更新开关：状态以 agent 给的为准、切换时发请求、离线禁用、最近一次结果的文案。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { EngineAutoUpdate } from '@trine/core';
import type { EngineAutoUpdateResult } from '@/lib/client.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EngineAutoUpdateToggle, autoUpdateLastLine } = await import('./EngineAutoUpdateToggle.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(state: EngineAutoUpdate, set: (enabled: boolean) => Promise<EngineAutoUpdateResult>, online: boolean | null = true): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <EngineAutoUpdateToggle idPrefix="codex" engineName="Codex" machineName="MBP" online={online} state={state} set={set} now={3_600_000 * 3} />,
    ),
  );
}

function $(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

function reply(enabled: boolean, ok = true): EngineAutoUpdateResult {
  return { type: 'machine.engine.autoupdate.response', ts: 1, seq: 1, dir: 'a2c', reqId: 'q', engine: 'codex', ok, enabled };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('EngineAutoUpdateToggle', () => {
  test('显示 agent 的状态；点击发出相反的值', async () => {
    const calls: boolean[] = [];
    render({ enabled: false }, async (enabled) => {
      calls.push(enabled);
      return reply(enabled);
    });
    const sw = $('codex-auto-update-switch')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await act(async () => sw.click());
    expect(calls).toEqual([true]);
  });

  test('离线时禁用', () => {
    render({ enabled: true }, async (e) => reply(e), false);
    expect($('codex-auto-update-switch')!.hasAttribute('disabled')).toBe(true);
  });

  test('最近一次结果', () => {
    render({ enabled: true, last: { at: 3_600_000 * 2, ok: false, fromVersion: '1.0.0', toVersion: '1.0.0', error: '网络不通' } }, async (e) => reply(e));
    expect($('codex-auto-update-last')!.textContent).toContain('自动更新失败：网络不通');
  });

  test('autoUpdateLastLine', () => {
    expect(autoUpdateLastLine(undefined, 0)).toBeNull();
    expect(autoUpdateLastLine({ at: 0, ok: true, fromVersion: '1.0.0', toVersion: '1.1.0' }, 0)).toContain('1.0.0 → 1.1.0');
    expect(autoUpdateLastLine({ at: 0, ok: true, fromVersion: '1.1.0', toVersion: '1.1.0' }, 0)).toContain('仍是 1.1.0');
  });
});
