/**
 * 文件书签：目录 / 文件头部的书签按钮写进 prefs（按机器），「位置」菜单列出书签、点了跳转、
 * 叉号删除不跳转；旧 agent（没有信任目录）也有位置菜单，只是没有信任一节。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { FileBookmark, FilesRoot, FsFile } from '@trine/core';
import type { Prefs } from '@/lib/storage.ts';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { runtimeState, store } = await import('@/app/runtime.ts');
const { defaultPrefs } = await import('@/lib/storage.ts');
const { FilePanel } = await import('./FilePanel.tsx');

const MACHINE = 'mbp';
const HOME = '/home/u';
const CWD = '/home/u/w/repo';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => {
    runtimeState.setState({ client: null });
    store.setState({ prefs: defaultPrefs() });
  });
});

interface SetupResult {
  prefs: () => Prefs;
  /** agent 端的书签（server 模式下 setFileBookmark 改它并「重发 machine.info」） */
  server: () => FileBookmark[] | undefined;
  calls: Array<{ path: string; kind: FileBookmark['kind'] | null }>;
}

function setup(
  options: {
    roots?: FilesRoot[] | undefined;
    bookmarks?: Prefs['fileBookmarks'];
    /** 给了 = 新 agent（machine.info.files.bookmarks），书签存在 agent */
    server?: FileBookmark[];
    /** setFileBookmark 的应答闸门：给了就等它 resolve 再应答 */
    gate?: Promise<void>;
    fail?: boolean;
  } = {},
): SetupResult {
  let prefs: Prefs = { ...defaultPrefs(), fileBookmarks: options.bookmarks ?? {} };
  let server = options.server;
  const calls: SetupResult['calls'] = [];
  const filesInfo = (): Record<string, unknown> => ({
    maxBytes: 1024,
    ...('roots' in options && options.roots === undefined ? {} : { roots: options.roots ?? [], home: HOME }),
    ...(server === undefined ? {} : { bookmarks: server }),
  });
  const machine = (): Record<string, unknown> => ({
    machineId: MACHINE,
    name: 'MBP',
    online: true,
    lastSeenAt: 1,
    parkedCount: 0,
    info: { name: 'MBP', files: filesInfo() },
    cwd: null,
    lastError: null,
    stats: null,
    statsHistory: [],
  });
  const file = (path: string): FsFile => ({
    path,
    root: CWD,
    name: path.slice(path.lastIndexOf('/') + 1),
    size: 5,
    mtime: 1,
    mime: 'text/plain',
    kind: 'text',
    blobId: 'b'.repeat(26),
    key: 'k',
  } as FsFile);
  const client = {
    on: () => () => {},
    get prefs() {
      return prefs;
    },
    updatePrefs: (patch: Partial<Prefs>) => {
      prefs = { ...prefs, ...patch };
      store.setState({ prefs });
    },
    listFiles: async (_m: string, _s: string, path?: string) => ({
      path: path ?? CWD,
      root: CWD,
      entries: [{ name: 'a.txt', type: 'file', size: 1, mtime: 1 }],
      truncated: false,
    }),
    // 相对路径由 agent 解析成绝对路径（书签存的是它）
    openFile: async (_m: string, _s: string, path: string) => ({
      file: file(path.startsWith('/') ? path : `${CWD}/${path}`),
      blob: new Blob(['hello']),
      url: 'blob:x',
    }),
    // 模拟 agent：先改列表、重发 machine.info，再回应答
    setFileBookmark: async (_m: string, path: string, kind: FileBookmark['kind'] | null) => {
      calls.push({ path, kind });
      if (options.gate !== undefined) await options.gate;
      if (options.fail === true) throw new Error('离线');
      const rest = (server ?? []).filter((b) => b.path !== path);
      server = kind === null ? rest : [{ path, kind, addedAt: 1 }, ...rest];
      store.setState({ machines: { [MACHINE]: machine() } as never });
      return path;
    },
  };
  act(() => {
    runtimeState.setState({ client: client as never });
    store.setState({ prefs, machines: { [MACHINE]: machine() } as never, sessions: {} });
  });
  return { prefs: () => prefs, server: () => server, calls };
}

const tick = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 0)));
const $ = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const $$ = (id: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

type Nav = { kind: 'dir' | 'file'; path: string | undefined };

async function mountPanel(initial: Nav): Promise<{ nav: Nav[] }> {
  const nav: Nav[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (v: Nav): void =>
    root!.render(
      <MemoryRouter>
        <FilePanel
          machineId={MACHINE}
          sessionId="s1"
          view={v.kind === 'file' ? { kind: 'file', path: v.path! } : { kind: 'dir', ...(v.path === undefined ? {} : { path: v.path }) }}
          onNavigate={(next) => {
            const n: Nav = { kind: next.kind, path: next.path };
            nav.push(n);
            act(() => render(n));
          }}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
  act(() => render(initial));
  await tick();
  return { nav };
}

/** Radix 下拉菜单靠 pointerdown（左键、无 Ctrl）打开 */
async function openLocations(): Promise<void> {
  const trigger = $('file-locations')!;
  act(() => void trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false, pointerType: 'mouse' })));
  await tick();
}

describe('文件书签', () => {
  test('目录头部的书签按钮：加入 / 移出当前目录（绝对路径，按机器存）', async () => {
    const { prefs } = setup();
    await mountPanel({ kind: 'dir', path: undefined });
    const toggle = (): HTMLElement => $('file-bookmark-toggle')!;
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    act(() => toggle().click());
    expect(prefs().fileBookmarks).toEqual({ [MACHINE]: [{ path: CWD, kind: 'dir' }] });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    act(() => toggle().click());
    expect(prefs().fileBookmarks).toEqual({});
  });

  test('文件头部的书签按钮：存 agent 解析后的绝对路径', async () => {
    const { prefs } = setup();
    await mountPanel({ kind: 'file', path: 'docs/a.txt' });
    act(() => $('file-bookmark-toggle')!.click());
    expect(prefs().fileBookmarks).toEqual({ [MACHINE]: [{ path: `${CWD}/docs/a.txt`, kind: 'file' }] });
  });

  test('位置菜单：列出书签，目录就地浏览、文件打开；叉号只删除不跳转', async () => {
    const { prefs } = setup({
      bookmarks: {
        [MACHINE]: [
          { path: '/home/u/notes', kind: 'dir' },
          { path: '/home/u/notes/todo.md', kind: 'file' },
        ],
        other: [{ path: '/elsewhere', kind: 'dir' }],
      },
    });
    const { nav } = await mountPanel({ kind: 'dir', path: undefined });
    await openLocations();
    const items = $$('file-bookmark');
    expect(items.map((i) => [i.dataset['path'], i.dataset['kind']])).toEqual([
      ['/home/u/notes', 'dir'],
      ['/home/u/notes/todo.md', 'file'],
    ]);
    // home 之下显示成 ~
    expect(items[0]!.textContent).toContain('~/notes');
    act(() => (items[1]!.querySelector('[data-testid="file-bookmark-remove"]') as HTMLElement).click());
    await tick();
    expect(nav).toEqual([]);
    expect(prefs().fileBookmarks[MACHINE]).toEqual([{ path: '/home/u/notes', kind: 'dir' }]);
    // 别的机器的书签不受影响
    expect(prefs().fileBookmarks['other']).toEqual([{ path: '/elsewhere', kind: 'dir' }]);
    act(() => $$('file-bookmark')[0]!.click());
    await tick();
    expect(nav).toEqual([{ kind: 'dir', path: '/home/u/notes' }]);
  });

  test('位置菜单里点文件书签：打开文件', async () => {
    setup({ bookmarks: { [MACHINE]: [{ path: '/home/u/notes/todo.md', kind: 'file' }] } });
    const { nav } = await mountPanel({ kind: 'dir', path: undefined });
    await openLocations();
    act(() => $$('file-bookmark')[0]!.click());
    await tick();
    expect(nav).toEqual([{ kind: 'file', path: '/home/u/notes/todo.md' }]);
  });

  test('旧 agent（没有信任目录）：位置菜单仍在，有书签、没有信任一节', async () => {
    setup({ roots: undefined, bookmarks: { [MACHINE]: [{ path: '/home/u/notes', kind: 'dir' }] } });
    await mountPanel({ kind: 'dir', path: undefined });
    await openLocations();
    expect($$('file-bookmark').length).toBe(1);
    expect($('file-locations-manage')).toBeNull();
    expect($('file-trust-current')).toBeNull();
  });
});

describe('文件书签 · 存在 agent（machine.info.files.bookmarks）', () => {
  test('加入 / 移出走 agent，不写 prefs；列表以 machine.info 为准', async () => {
    const h = setup({ server: [{ path: '/home/u/notes', kind: 'dir', addedAt: 1 }] });
    await mountPanel({ kind: 'dir', path: undefined });
    const toggle = (): HTMLElement => $('file-bookmark-toggle')!;
    act(() => toggle().click());
    await tick();
    expect(h.calls).toEqual([{ path: CWD, kind: 'dir' }]);
    expect(h.server()?.map((b) => b.path)).toEqual([CWD, '/home/u/notes']);
    expect(h.prefs().fileBookmarks).toEqual({});
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    await openLocations();
    expect($$('file-bookmark').map((i) => i.dataset['path'])).toEqual([CWD, '/home/u/notes']);
    act(() => ($$('file-bookmark')[1]!.querySelector('[data-testid="file-bookmark-remove"]') as HTMLElement).click());
    await tick();
    expect(h.calls.at(-1)).toEqual({ path: '/home/u/notes', kind: null });
    expect($$('file-bookmark').map((i) => i.dataset['path'])).toEqual([CWD]);
  });

  test('应答前先按预期显示；失败后恢复原样', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    setup({ server: [], gate, fail: true });
    await mountPanel({ kind: 'dir', path: undefined });
    const toggle = (): HTMLElement => $('file-bookmark-toggle')!;
    act(() => toggle().click());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    open();
    await tick();
    await tick();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  test('本设备的旧书签自动传给 agent（保持顺序、已有的跳过），成功后从 prefs 删掉', async () => {
    const h = setup({
      server: [{ path: '/home/u/b', kind: 'dir', addedAt: 1 }],
      bookmarks: {
        [MACHINE]: [
          { path: '/home/u/a', kind: 'dir' },
          { path: '/home/u/b', kind: 'dir' },
          { path: '/home/u/c.md', kind: 'file' },
        ],
        other: [{ path: '/elsewhere', kind: 'dir' }],
      },
    });
    await mountPanel({ kind: 'dir', path: undefined });
    await tick();
    expect(h.calls).toEqual([
      { path: '/home/u/c.md', kind: 'file' },
      { path: '/home/u/a', kind: 'dir' },
    ]);
    expect(h.server()?.map((b) => b.path)).toEqual(['/home/u/a', '/home/u/c.md', '/home/u/b']);
    expect(h.prefs().fileBookmarks).toEqual({ other: [{ path: '/elsewhere', kind: 'dir' }] });
  });

  test('迁移失败（离线）：本地书签留着，下次再试', async () => {
    const h = setup({ server: [], fail: true, bookmarks: { [MACHINE]: [{ path: '/home/u/a', kind: 'dir' }] } });
    await mountPanel({ kind: 'dir', path: undefined });
    await tick();
    expect(h.calls).toHaveLength(1);
    expect(h.prefs().fileBookmarks[MACHINE]).toEqual([{ path: '/home/u/a', kind: 'dir' }]);
  });
});
