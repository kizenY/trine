/**
 * 文件书签的界面部分（模型见 lib/file-bookmarks.ts）：
 * - `useFileBookmarks`：这台机器的书签 + 增删（写 prefs，只在本设备）
 * - `BookmarkToggle`：目录 / 文件视图头部的「加入书签 / 移出书签」按钮
 * 跳转入口在「位置」菜单（TrustDir.tsx 的 LocationMenu）。
 */
import { BookmarkCheckIcon, BookmarkPlusIcon } from 'lucide-react';
import { useClient, useTrine } from '@/app/runtime.ts';
import { addBookmark, bookmarksOf, removeBookmark, type FileBookmark, type FileBookmarks } from '@/lib/file-bookmarks.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';

export interface FileBookmarksApi {
  list: readonly FileBookmark[];
  has: (path: string) => boolean;
  add: (bookmark: FileBookmark) => void;
  remove: (path: string) => void;
}

export function useFileBookmarks(machineId: string): FileBookmarksApi {
  const client = useClient();
  const list = useTrine((s) => bookmarksOf(s.prefs.fileBookmarks, machineId));
  // 每次都从 client 读最新的 prefs 再改：连续操作不会基于渲染时的旧快照互相覆盖
  const update = (change: (all: FileBookmarks) => Record<string, FileBookmark[]>): void => {
    if (client === null) return;
    client.updatePrefs({ fileBookmarks: change(client.prefs.fileBookmarks) });
  };
  return {
    list,
    has: (path) => list.some((b) => b.path === path),
    add: (bookmark) => update((all) => addBookmark(all, machineId, bookmark)),
    remove: (path) => update((all) => removeBookmark(all, machineId, path)),
  };
}

export function BookmarkToggle({
  bookmarks,
  path,
  kind,
}: {
  bookmarks: FileBookmarksApi;
  /** 绝对路径；还不知道（加载中）时不显示 */
  path: string | undefined;
  kind: FileBookmark['kind'];
}): React.JSX.Element | null {
  if (path === undefined || !path.startsWith('/')) return null;
  const on = bookmarks.has(path);
  const what = kind === 'dir' ? '目录' : '文件';
  const label = on ? '移出书签' : '加入书签';
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      data-testid="file-bookmark-toggle"
      aria-pressed={on}
      aria-label={label}
      title={on ? `把这个${what}移出书签` : `把这个${what}加入书签（「位置」菜单里可快速跳转）`}
      onClick={() => (on ? bookmarks.remove(path) : bookmarks.add({ path, kind }))}
      className={cn(on && 'text-brand')}
    >
      {on ? <BookmarkCheckIcon /> : <BookmarkPlusIcon />}
    </Button>
  );
}
