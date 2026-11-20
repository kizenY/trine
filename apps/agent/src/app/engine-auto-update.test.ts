import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeUpdateOutcome } from './claude-cli.ts';
import { compareVersions, EngineAutoUpdater, versionNumber, type AutoUpdateTarget } from './engine-auto-update.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-auto-update-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeTarget(initial: string, outcome?: Partial<ClaudeUpdateOutcome>) {
  let version = initial;
  const calls = { update: 0, check: 0 };
  const target: AutoUpdateTarget = {
    currentVersion: () => version,
    update: async () => {
      calls.update++;
      const from = version;
      if (outcome?.ok !== false) version = outcome?.toVersion ?? '2.0.0';
      return { ok: true, fromVersion: from, toVersion: version, output: '', outputTruncated: false, ...outcome };
    },
    check: async () => {
      calls.check++;
    },
  };
  return { target, calls };
}

describe('versionNumber / compareVersions', () => {
  test('取开头的版本号', () => {
    expect(versionNumber('2.1.282 (Claude Code)')).toBe('2.1.282');
    expect(versionNumber('0.166.0')).toBe('0.166.0');
    expect(versionNumber('unknown')).toBeUndefined();
    expect(versionNumber(undefined)).toBeUndefined();
  });
  test('semver 比较', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('x', '1.0.0')).toBeNull();
  });
});

describe('EngineAutoUpdater', () => {
  test('没登记的引擎：没有状态，set 回 not_found', async () => {
    const au = EngineAutoUpdater.memory();
    expect(au.state('codex')).toBeUndefined();
    expect(await au.set('codex', true)).toEqual({ ok: false, enabled: false, error: { code: 'not_found', message: expect.any(String) } });
  });

  test('默认关；关着时查到新版也不更新', async () => {
    const au = EngineAutoUpdater.memory();
    const { target, calls } = fakeTarget('1.0.0');
    au.register('claude', target);
    expect(au.state('claude')).toEqual({ enabled: false });
    expect(await au.onChecked('claude', '2.0.0')).toBe(false);
    expect(calls.update).toBe(0);
  });

  test('打开：落盘、广播、立即查一次；查到新版就更新并记下结果', async () => {
    const path = join(dir, 'engine-auto-update.json');
    let t = 1000;
    const au = await EngineAutoUpdater.load(path, { now: () => t });
    let changes = 0;
    au.onChange = () => changes++;
    const { target, calls } = fakeTarget('1.0.0 (Claude Code)');
    au.register('claude', target);
    expect(await au.set('claude', true)).toEqual({ ok: true, enabled: true });
    expect(calls.check).toBe(1);
    expect(changes).toBe(1);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ v: 1, engines: { claude: { enabled: true } } });

    t = 2000;
    expect(await au.onChecked('claude', '2.0.0')).toBe(true);
    expect(calls.update).toBe(1);
    expect(changes).toBe(2);
    expect(au.state('claude')).toEqual({ enabled: true, last: { at: 2000, ok: true, fromVersion: '1.0.0', toVersion: '2.0.0' } });

    // 已是最新：不再更新
    expect(await au.onChecked('claude', '2.0.0')).toBe(false);
    expect(calls.update).toBe(1);

    // 重新加载仍记得
    const again = await EngineAutoUpdater.load(path);
    again.register('claude', target);
    expect(again.state('claude')).toEqual({ enabled: true, last: { at: 2000, ok: true, fromVersion: '1.0.0', toVersion: '2.0.0' } });
  });

  test('已经开着再打开：不重复检查', async () => {
    const au = EngineAutoUpdater.memory();
    const { target, calls } = fakeTarget('1.0.0');
    au.register('codex', target);
    await au.set('codex', true);
    await au.set('codex', true);
    expect(calls.check).toBe(1);
  });

  test('更新失败：记下原因，开关不变', async () => {
    const au = EngineAutoUpdater.memory({ now: () => 5 });
    const { target } = fakeTarget('1.0.0', { ok: false, toVersion: '1.0.0', error: { code: 'failed', message: '网络不通' } });
    au.register('codex', target);
    await au.set('codex', true);
    expect(await au.onChecked('codex', '1.1.0')).toBe(true);
    expect(au.state('codex')).toEqual({
      enabled: true,
      last: { at: 5, ok: false, fromVersion: '1.0.0', toVersion: '1.0.0', error: '网络不通' },
    });
  });

  test('手动更新正在进行（busy）：不记结果', async () => {
    const au = EngineAutoUpdater.memory();
    const { target } = fakeTarget('1.0.0', { ok: false, error: { code: 'busy', message: '进行中' } });
    au.register('codex', target);
    await au.set('codex', true);
    expect(await au.onChecked('codex', '1.1.0')).toBe(false);
    expect(au.state('codex')).toEqual({ enabled: true });
  });

  test('同一引擎同时只跑一次', async () => {
    const au = EngineAutoUpdater.memory();
    let release!: () => void;
    let updates = 0;
    au.register('codex', {
      currentVersion: () => '1.0.0',
      update: () => {
        updates++;
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, fromVersion: '1.0.0', toVersion: '1.1.0', output: '', outputTruncated: false });
        });
      },
      check: async () => {},
    });
    await au.set('codex', true);
    const first = au.onChecked('codex', '1.1.0');
    expect(await au.onChecked('codex', '1.1.0')).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(updates).toBe(1);
  });

  test('版本未知：不更新', async () => {
    const au = EngineAutoUpdater.memory();
    const { target, calls } = fakeTarget('unknown');
    au.register('codex', target);
    await au.set('codex', true);
    expect(await au.onChecked('codex', '1.1.0')).toBe(false);
    expect(calls.update).toBe(0);
  });

  test('坏文件：按全关启动', async () => {
    const path = join(dir, 'engine-auto-update.json');
    await writeFile(path, '{not json');
    const au = await EngineAutoUpdater.load(path, { now: () => 1 });
    au.register('claude', fakeTarget('1.0.0').target);
    expect(au.state('claude')).toEqual({ enabled: false });
  });
});
