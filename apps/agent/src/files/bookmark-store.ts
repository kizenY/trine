/**
 * 文件书签：`~/.trine/bookmarks.json`（file-bookmarks）。机器级、所有已配对设备共享，
 * 经 `machine.info.files.bookmarks` 下发，可远程增删（`files.bookmark.add / remove`）。
 *
 * `{ v: 1, bookmarks: [{ path, kind, addedAt }] }`，新加的在前，最多 FILES_BOOKMARKS_MAX 个（超出丢最旧的）。
 * 书签只是快捷入口，**不参与可浏览范围的判断**（那是 TrustStore / FileAccess 的事），所以这里不查路径存不存在。
 *
 * 文件坏了 → warn + 回到空列表，不阻止启动。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { z } from 'zod';
import { FILES_BOOKMARKS_MAX, FileBookmarkSchema, type FileBookmark } from '@trine/core';

const BookmarkFileSchema = z.object({
  v: z.literal(1),
  bookmarks: z.array(FileBookmarkSchema.required({ addedAt: true })).max(FILES_BOOKMARKS_MAX),
});
type BookmarkFile = z.infer<typeof BookmarkFileSchema>;
export type StoredBookmark = BookmarkFile['bookmarks'][number];

export class BookmarkError extends Error {
  readonly code: 'invalid' | 'failed';
  constructor(code: 'invalid' | 'failed', message: string) {
    super(message);
    this.name = 'BookmarkError';
    this.code = code;
  }
}

/** 规范化书签路径：必须是绝对路径、不含 NUL；去掉 `.` / `..` / 重复的 `/` 和末尾 `/`。不合法返回 undefined */
export function normalizeBookmarkPath(input: string): string | undefined {
  const s = input.trim();
  if (s === '' || s.includes('\0') || !s.startsWith('/')) return undefined;
  const p = posix.normalize(s);
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export class BookmarkStore {
  #data: BookmarkFile;
  /** 串行化写入：并发的 add / remove 各自基于最新列表，不互相覆盖 */
  #chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly path: string | undefined,
    data: BookmarkFile,
  ) {
    this.#data = data;
  }

  /** 不落盘（测试、echo agent） */
  static memory(initial: readonly StoredBookmark[] = []): BookmarkStore {
    return new BookmarkStore(undefined, { v: 1, bookmarks: initial.map((b) => ({ ...b })) });
  }

  static async load(path: string, options: { log?: (line: string) => void } = {}): Promise<BookmarkStore> {
    const log = options.log ?? (() => {});
    const empty: BookmarkFile = { v: 1, bookmarks: [] };
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[files] 书签读取失败，按空列表处理：${(err as Error).message}`);
      return new BookmarkStore(path, empty);
    }
    try {
      return new BookmarkStore(path, BookmarkFileSchema.parse(JSON.parse(raw)));
    } catch (err) {
      log(`[files] 书签文件损坏，按空列表处理：${(err as Error).message}`);
      return new BookmarkStore(path, empty);
    }
  }

  list(): FileBookmark[] {
    return this.#data.bookmarks.map((b) => ({ ...b }));
  }

  /**
   * 加入（已存在则移到最前，kind 以这次为准）。
   * @returns 存下的路径
   */
  add(input: string, kind: FileBookmark['kind'], at: number): Promise<string> {
    const path = normalizeBookmarkPath(input);
    if (path === undefined) return Promise.reject(new BookmarkError('invalid', '书签必须是绝对路径'));
    return this.#update((list) => [{ path, kind, addedAt: at }, ...list.filter((b) => b.path !== path)].slice(0, FILES_BOOKMARKS_MAX)).then(
      () => path,
    );
  }

  /** 删除（不在列表里也算成功）。@returns 规范化后的路径 */
  remove(input: string): Promise<string> {
    const path = normalizeBookmarkPath(input);
    if (path === undefined) return Promise.reject(new BookmarkError('invalid', '书签必须是绝对路径'));
    return this.#update((list) => list.filter((b) => b.path !== path)).then(() => path);
  }

  #update(change: (list: readonly StoredBookmark[]) => StoredBookmark[]): Promise<void> {
    const run = this.#chain.then(async () => {
      const next: BookmarkFile = { ...this.#data, bookmarks: change(this.#data.bookmarks) };
      try {
        await this.#persist(next);
      } catch (err) {
        throw new BookmarkError('failed', `保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
      this.#data = next;
    });
    this.#chain = run.catch(() => {});
    return run;
  }

  /** 先写盘再改内存：写失败时列表不变 */
  async #persist(data: BookmarkFile): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
