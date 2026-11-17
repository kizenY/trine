import { describe, expect, test } from 'bun:test';
import {
  addBookmark,
  bookmarkDisplayPath,
  bookmarkName,
  bookmarksOf,
  BOOKMARKS_MAX,
  isBookmarked,
  removeBookmark,
} from './file-bookmarks.ts';
import { defaultPrefs, PrefsSchema } from './storage.ts';

describe('文件书签模型', () => {
  test('按机器分组；新加的在前，重复加入挪到最前', () => {
    let all = addBookmark({}, 'm1', { path: '/w/a', kind: 'dir' });
    all = addBookmark(all, 'm1', { path: '/w/b.md', kind: 'file' });
    all = addBookmark(all, 'm2', { path: '/w/a', kind: 'dir' });
    expect(bookmarksOf(all, 'm1').map((b) => b.path)).toEqual(['/w/b.md', '/w/a']);
    all = addBookmark(all, 'm1', { path: '/w/a', kind: 'dir' });
    expect(bookmarksOf(all, 'm1').map((b) => b.path)).toEqual(['/w/a', '/w/b.md']);
    expect(isBookmarked(all, 'm2', '/w/a')).toBe(true);
    expect(isBookmarked(all, 'm2', '/w/b.md')).toBe(false);
  });

  test('删到空就删掉这台机器的键；没有书签时返回同一个空数组', () => {
    const all = addBookmark({}, 'm1', { path: '/w/a', kind: 'dir' });
    expect(removeBookmark(all, 'm1', '/w/a')).toEqual({});
    expect(bookmarksOf({}, 'x')).toBe(bookmarksOf({}, 'y'));
  });

  test('超过上限丢最旧的', () => {
    let all = {};
    for (let i = 0; i <= BOOKMARKS_MAX; i++) all = addBookmark(all, 'm', { path: `/d/${i}`, kind: 'dir' });
    const list = bookmarksOf(all, 'm');
    expect(list.length).toBe(BOOKMARKS_MAX);
    expect(list[0]!.path).toBe(`/d/${BOOKMARKS_MAX}`);
    expect(list.some((b) => b.path === '/d/0')).toBe(false);
  });

  test('显示名与 ~ 路径', () => {
    expect(bookmarkName('/home/u/w/repo')).toBe('repo');
    expect(bookmarkName('/')).toBe('/');
    expect(bookmarkDisplayPath('/home/u/w', '/home/u')).toBe('~/w');
    expect(bookmarkDisplayPath('/home/u', '/home/u')).toBe('~');
    expect(bookmarkDisplayPath('/home/uu/w', '/home/u')).toBe('/home/uu/w');
    expect(bookmarkDisplayPath('/srv/x', undefined)).toBe('/srv/x');
  });

  test('prefs：旧数据没有 fileBookmarks 得到空表；坏数据整张丢弃', () => {
    const { fileBookmarks: _b, ...old } = defaultPrefs();
    expect(PrefsSchema.parse(old).fileBookmarks).toEqual({});
    expect(PrefsSchema.parse({ ...old, fileBookmarks: { m: [{ path: 'rel', kind: 'dir' }] } }).fileBookmarks).toEqual({});
    const ok = { m: [{ path: '/a', kind: 'file' as const }] };
    expect(PrefsSchema.parse({ ...old, fileBookmarks: ok }).fileBookmarks).toEqual(ok);
  });
});
