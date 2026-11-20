import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILES_BOOKMARKS_MAX } from '@trine/core';
import { BookmarkError, BookmarkStore, normalizeBookmarkPath } from './bookmark-store.ts';

let base: string;
let file: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trine-bookmarks-test-'));
  file = join(base, 'home', 'bookmarks.json');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof BookmarkError) return err.code;
    throw err;
  }
}

describe('BookmarkStore', () => {
  test('normalizeBookmarkPath：只收绝对路径，去掉 . / .. / 末尾 /', () => {
    expect(normalizeBookmarkPath('/w/./a/../b/')).toBe('/w/b');
    expect(normalizeBookmarkPath('//w//x')).toBe('/w/x');
    expect(normalizeBookmarkPath('/')).toBe('/');
    expect(normalizeBookmarkPath('w/x')).toBeUndefined();
    expect(normalizeBookmarkPath('~/x')).toBeUndefined();
    expect(normalizeBookmarkPath('/w\0x')).toBeUndefined();
  });

  test('新加的在前，重复加入移到最前并以新 kind 为准；落盘 0600 后重载一致', async () => {
    const store = await BookmarkStore.load(file);
    await store.add('/w/a', 'dir', 1);
    await store.add('/w/b.md', 'file', 2);
    await store.add('/w/a/', 'file', 3);
    expect(store.list()).toEqual([
      { path: '/w/a', kind: 'file', addedAt: 3 },
      { path: '/w/b.md', kind: 'file', addedAt: 2 },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await BookmarkStore.load(file)).list()).toEqual(store.list());

    expect(await store.remove('/w/a')).toBe('/w/a');
    expect(await store.remove('/w/none')).toBe('/w/none');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, bookmarks: [{ path: '/w/b.md', kind: 'file', addedAt: 2 }] });
  });

  test('超出上限丢最旧的；非绝对路径 invalid', async () => {
    const store = BookmarkStore.memory();
    for (let i = 0; i <= FILES_BOOKMARKS_MAX; i++) await store.add(`/w/${i}`, 'dir', i);
    const list = store.list();
    expect(list).toHaveLength(FILES_BOOKMARKS_MAX);
    expect(list[0]!.path).toBe(`/w/${FILES_BOOKMARKS_MAX}`);
    expect(list.some((b) => b.path === '/w/0')).toBe(false);
    expect(await code(store.add('rel', 'dir', 1))).toBe('invalid');
    expect(await code(store.remove(''))).toBe('invalid');
  });

  test('并发增删串行执行，不互相覆盖', async () => {
    const store = await BookmarkStore.load(file);
    await Promise.all([store.add('/a', 'dir', 1), store.add('/b', 'dir', 2), store.add('/c', 'dir', 3), store.remove('/a')]);
    expect(store.list().map((b) => b.path)).toEqual(['/c', '/b']);
    expect((await BookmarkStore.load(file)).list().map((b) => b.path)).toEqual(['/c', '/b']);
  });

  test('文件损坏按空列表处理并记日志；写失败时内存不变', async () => {
    const logs: string[] = [];
    rmSync(join(base, 'home'), { recursive: true, force: true });
    const bad = join(base, 'bad.json');
    writeFileSync(bad, '{"v":2}');
    expect((await BookmarkStore.load(bad, { log: (l) => logs.push(l) })).list()).toEqual([]);
    expect(logs.join('\n')).toContain('损坏');

    // 父路径是个普通文件：mkdir 失败
    const blocked = await BookmarkStore.load(join(bad, 'sub', 'bookmarks.json'));
    expect(await code(blocked.add('/w', 'dir', 1))).toBe('failed');
    expect(blocked.list()).toEqual([]);
  });
});
