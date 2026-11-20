/**
 * 文件书签：把常看的目录 / 文件记下来，在文件面板的「位置」菜单里一键跳转。
 *
 * - 按机器分组（路径只在那台机器上有意义），同一台机器的所有会话共用；
 * - agent ≥ 0.30.0（machine.info.files.bookmarks 存在）：存在 agent 上，所有已配对设备同步；
 *   旧 agent：只存本设备（prefs.fileBookmarks）。升级后本设备的旧书签自动传给 agent 再清掉
 *   （见 components/files/Bookmarks.tsx）；
 * - 不影响可浏览范围——书签指向范围外时照样走范围外的说明与信任流程；
 * - 存绝对路径；新加的排最前，每台机器最多 BOOKMARKS_MAX 个（超出丢最旧的）。
 *
 * 下面的增删函数只用于本设备存储（旧 agent 与待迁移的数据）。
 */
import { FILES_BOOKMARKS_MAX, FileBookmarkSchema, type FileBookmark } from '@trine/core';

export const BOOKMARKS_MAX = FILES_BOOKMARKS_MAX;
export { FileBookmarkSchema, type FileBookmark };

/** machineId → 书签（新的在前） */
export type FileBookmarks = Readonly<Record<string, readonly FileBookmark[]>>;

/** 没有书签时返回同一个空数组：给 store selector 用，引用稳定才不会反复重渲染 */
const NONE: readonly FileBookmark[] = Object.freeze([]);

export function bookmarksOf(all: FileBookmarks, machineId: string): readonly FileBookmark[] {
  return all[machineId] ?? NONE;
}

export function isBookmarked(all: FileBookmarks, machineId: string, path: string): boolean {
  return bookmarksOf(all, machineId).some((b) => b.path === path);
}

export function addBookmark(all: FileBookmarks, machineId: string, bookmark: FileBookmark): Record<string, FileBookmark[]> {
  const rest = bookmarksOf(all, machineId).filter((b) => b.path !== bookmark.path);
  return { ...(all as Record<string, FileBookmark[]>), [machineId]: [bookmark, ...rest].slice(0, BOOKMARKS_MAX) };
}

/** 删掉后这台机器没有书签了就把键也删掉，不让记录无限增长 */
export function removeBookmark(all: FileBookmarks, machineId: string, path: string): Record<string, FileBookmark[]> {
  const next: Record<string, FileBookmark[]> = { ...all } as Record<string, FileBookmark[]>;
  const rest = bookmarksOf(all, machineId).filter((b) => b.path !== path);
  if (rest.length === 0) delete next[machineId];
  else next[machineId] = rest;
  return next;
}

/** 书签的显示名：最后一段（`/` 本身显示 `/`） */
export function bookmarkName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || '/';
}

/** 书签的完整路径：home 之下显示成 `~/…` */
export function bookmarkDisplayPath(path: string, home: string | undefined): string {
  if (home === undefined || home === '' || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
