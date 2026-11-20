/**
 * 文件书签的界面部分（模型见 lib/file-bookmarks.ts）：
 * - `useFileBookmarks`：这台机器的书签 + 增删。agent 支持（machine.info.files.bookmarks 存在）时
 *   存在 agent、所有设备同步；旧 agent 写 prefs，只在本设备
 * - `BookmarkToggle`：目录 / 文件视图头部的「加入书签 / 移出书签」按钮
 * 跳转入口在「位置」菜单（TrustDir.tsx 的 LocationMenu）。
 */
import { useEffect, useState } from 'react';
import { BookmarkCheckIcon, BookmarkPlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useClient, useTrine } from '@/app/runtime.ts';
import { FilesBookmarkError, type TrineClient } from '@/lib/client.ts';
import { addBookmark, BOOKMARKS_MAX, bookmarksOf, removeBookmark, type FileBookmark, type FileBookmarks } from '@/lib/file-bookmarks.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';

export interface FileBookmarksApi {
  list: readonly FileBookmark[];
  has: (path: string) => boolean;
  add: (bookmark: FileBookmark) => void;
  remove: (path: string) => void;
}

/** 正在把本设备旧书签传给 agent 的机器（同一台机器只跑一份，多个视图同时挂着也不重复上传） */
const migrating = new Set<string>();

/**
 * 升级到支持书签同步的 agent 后，把本设备 prefs 里的旧书签传上去（从最旧的开始，保持顺序），
 * 成功的从本地删掉。agent 上已有的不再传（免得被挪到最前）。失败的留在本地，下次再试。
 */
export async function migrateLocalBookmarks(client: TrineClient, machineId: string, onServer: readonly FileBookmark[]): Promise<void> {
  if (migrating.has(machineId)) return;
  const local = bookmarksOf(client.prefs.fileBookmarks, machineId);
  if (local.length === 0) return;
  migrating.add(machineId);
  const done: string[] = [];
  try {
    const known = new Set(onServer.map((b) => b.path));
    for (const b of [...local].reverse()) {
      if (!known.has(b.path)) {
        try {
          await client.setFileBookmark(machineId, b.path, b.kind);
        } catch (err) {
          // agent 不认的路径传不上去，留着也没用；别的错误（离线、超时）停下，下次再试
          if (!(err instanceof FilesBookmarkError && err.code === 'invalid')) throw err;
        }
      }
      done.push(b.path);
    }
  } catch {
    // 留给下次
  } finally {
    migrating.delete(machineId);
    if (done.length > 0) {
      let all: FileBookmarks = client.prefs.fileBookmarks;
      for (const path of done) all = removeBookmark(all, machineId, path);
      client.updatePrefs({ fileBookmarks: all as Record<string, FileBookmark[]> });
    }
  }
}

/** 本地（旧 agent）存储：每次都从 client 读最新的 prefs 再改，连续操作不会基于渲染时的旧快照互相覆盖 */
function localApi(client: TrineClient | null, machineId: string, list: readonly FileBookmark[]): FileBookmarksApi {
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

export function useFileBookmarks(machineId: string): FileBookmarksApi {
  const client = useClient();
  const local = useTrine((s) => bookmarksOf(s.prefs.fileBookmarks, machineId));
  /** undefined = agent 不支持（旧版或关闭了文件查看），退回本设备存储 */
  const server = useTrine((s) => s.machines[machineId]?.info?.files?.bookmarks);
  // 发出去还没应答的增删（path → 要加的 kind / null 表示删）：先按预期显示，应答到了以 machine.info 为准
  const [pending, setPending] = useState<ReadonlyMap<string, { kind: FileBookmark['kind'] | null }>>(new Map());

  const hasLocal = local.length > 0;
  useEffect(() => {
    if (client === null || server === undefined || !hasLocal) return;
    void migrateLocalBookmarks(client, machineId, server);
  }, [client, machineId, server, hasLocal]);

  if (server === undefined) return localApi(client, machineId, local);

  const list: FileBookmark[] = server.filter((b) => !pending.has(b.path));
  for (const [path, op] of pending) if (op.kind !== null) list.unshift({ path, kind: op.kind });
  list.splice(BOOKMARKS_MAX);
  const send = (path: string, kind: FileBookmark['kind'] | null): void => {
    if (client === null) return;
    const op = { kind };
    setPending((m) => new Map(m).set(path, op));
    client
      .setFileBookmark(machineId, path, kind)
      .catch((err: unknown) => {
        toast.error(`${kind === null ? '移出' : '加入'}书签失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() =>
        setPending((m) => {
          if (m.get(path) !== op) return m; // 期间又点了一次：等最后那次的应答
          const next = new Map(m);
          next.delete(path);
          return next;
        }),
      );
  };
  return {
    list,
    has: (path) => list.some((b) => b.path === path),
    add: (bookmark) => send(bookmark.path, bookmark.kind),
    remove: (path) => send(path, null),
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
