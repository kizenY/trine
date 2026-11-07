/**
 * Codex 的版本：查发布源上的最新版本（不安装），实际更新由 `codex update` 做（复用 ClaudeUpdater）。
 *
 * Codex 自己的检查结果缓存在 `~/.codex/version.json`，只在它运行 TUI 时才刷新，可能很旧，所以
 * 这里直接查它的发布源：GitHub 的 latest release，tag 形如 `rust-v0.167.0`。
 * 由 Homebrew、apt 安装时改问包管理器（见 package-install.ts），cask 通常比 GitHub 晚一点。
 * 自动检查的节奏同 claude-latest.ts（启动后约 30 秒、之后每 6 小时），只由 cli 开启，测试不碰网络。
 */
import { CLAUDE_LATEST_FIRST_DELAY_MS, CLAUDE_LATEST_INTERVAL_MS } from '../../app/claude-latest.ts';
import { installSummary, latestFromManager, type ManagerLatest, type PackageInstall } from '../../app/package-install.ts';

export const CODEX_RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const FETCH_TIMEOUT_MS = 15_000;
const TAG_RE = /^rust-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export type EngineCheckOutcome = { ok: true; version: string } | { ok: false; message: string };

export interface CodexLatest {
  version?: string;
  checkedAt?: number;
  error?: string;
  install?: { manager: string; command: string };
}

/** `codex-cli 0.166.0` → `0.166.0`；认不出就原样（可能是 unknown） */
export function codexVersionNumber(line: string): string {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(line)?.[1] ?? line;
}

/** @throws 网络错误 / 超时 / 非 2xx / tag 认不出 */
export async function fetchLatestCodexVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(CODEX_RELEASES_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'trine-agent' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`发布源返回 HTTP ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown };
  const match = typeof body.tag_name === 'string' ? TAG_RE.exec(body.tag_name) : null;
  if (match === null) throw new Error('发布源返回的 tag 认不出');
  return match[1]!;
}

export class CodexLatestChecker {
  readonly #fetch: typeof fetch | undefined;
  readonly #onChange: () => void;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #state: CodexLatest = {};
  #inflight: Promise<EngineCheckOutcome> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  readonly #detectInstall: (() => Promise<PackageInstall | undefined>) | undefined;
  readonly #managerLatest: (install: PackageInstall) => Promise<ManagerLatest>;

  constructor(
    options: {
      fetchImpl?: typeof fetch;
      onChange?: () => void;
      now?: () => number;
      log?: (line: string) => void;
      detectInstall?: () => Promise<PackageInstall | undefined>;
      managerLatest?: (install: PackageInstall) => Promise<ManagerLatest>;
    } = {},
  ) {
    this.#detectInstall = options.detectInstall;
    this.#managerLatest = options.managerLatest ?? latestFromManager;
    this.#fetch = options.fetchImpl;
    this.#onChange = options.onChange ?? (() => {});
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  get current(): CodexLatest {
    return this.#state;
  }

  /** 启动时调一次：不等第一次检查，界面就能显示实际的更新命令 */
  async loadInstall(): Promise<void> {
    const install = installSummary(await this.#detectInstall?.().catch(() => undefined));
    if (install === undefined || this.#disposed) return;
    this.#state = { ...this.#state, install };
    this.#onChange();
  }

  /** 查一次；进行中则共用。不抛 */
  check(): Promise<EngineCheckOutcome> {
    this.#inflight ??= this.#run().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  startAuto(firstDelayMs = CLAUDE_LATEST_FIRST_DELAY_MS, intervalMs = CLAUDE_LATEST_INTERVAL_MS): void {
    if (this.#disposed || this.#timer !== undefined) return;
    const tick = (delay: number): void => {
      this.#timer = setTimeout(() => {
        void this.check().finally(() => {
          if (!this.#disposed) tick(intervalMs);
        });
      }, delay);
      (this.#timer as { unref?: () => void }).unref?.();
    };
    tick(firstDelayMs);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #run(): Promise<EngineCheckOutcome> {
    let outcome: EngineCheckOutcome;
    const packageInstall = await this.#detectInstall?.().catch(() => undefined);
    const install = installSummary(packageInstall);
    const withInstall = install === undefined ? {} : { install };
    try {
      const version = packageInstall === undefined ? await fetchLatestCodexVersion(this.#fetch) : (await this.#managerLatest(packageInstall)).version;
      outcome = { ok: true, version };
      this.#state = { version, checkedAt: this.#now(), ...withInstall };
    } catch (err) {
      const message = `检查 Codex 最新版本失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      outcome = { ok: false, message };
      // 上次查到的版本仍有参考价值
      this.#state = { ...this.#state, error: message, ...withInstall };
      this.#log(`[codex] ${message}`);
    }
    if (!this.#disposed) this.#onChange();
    return outcome;
  }
}
