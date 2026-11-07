/**
 * 引擎是不是包管理器装的（Homebrew、apt），以及对应的更新命令和最新版本。
 *
 * 为什么要管：`claude update` 遇到包管理器安装只打印提示、不升级，退出码还是 0，会被当成
 * 「已是最新」。发布源上的最新版本也不一定是包管理器能装上的：cask 和 apt 源各有自己的渠道和
 * 发布节奏，按发布源比较会一直提示「有新版本」。所以这类安装的更新和版本检查都走包管理器。
 *
 * 识别靠可执行文件的真实路径（`<prefix>/Caskroom/<token>/…`、`<prefix>/Cellar/<name>/…`）和
 * `dpkg-query -S`。不依赖 PATH：systemd、launchd 下 PATH 里常常没有 brew。
 * 命令都是固定形式，包名只来自这里的识别结果，不接受 client 传入。
 */
import { realpathSync } from 'node:fs';
import { defaultSpawn, runCaptured, type SpawnFn } from './claude-cli.ts';

export type PackageInstall =
  | { manager: 'brew'; brew: string; token: string; kind: 'cask' | 'formula' }
  | { manager: 'apt'; pkg: string };

/** 给 ClaudeUpdater 的更新计划 */
export interface UpdatePlan {
  commands: string[][];
  /** 给人看的命令 */
  display: string;
  /** 失败时从输出里认出能说清楚的原因 */
  explainFailure?: (output: string) => string | undefined;
}

export interface ManagerLatest {
  version: string;
  /** 能从包管理器的配置看出渠道时才有（只有 Claude 关心） */
  channel?: 'latest' | 'stable';
}

const QUERY_TIMEOUT_MS = 5_000;
const BREW_UPDATE_TIMEOUT_MS = 60_000;
const BREW_PATH = /^(.*)\/(Caskroom|Cellar)\/([^/]+)\//;
const SEMVER = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

export interface PackageToolOptions {
  spawn?: SpawnFn;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  realpath?: (path: string) => string;
}

async function dpkgOwner(path: string, spawn: SpawnFn, env: Record<string, string | undefined>): Promise<string | undefined> {
  const run = await runCaptured(spawn, ['dpkg-query', '-S', path], { env, timeoutMs: QUERY_TIMEOUT_MS });
  if (run.kind !== 'exit' || run.code !== 0) return undefined;
  // `claude-code: /usr/bin/claude`；可能带架构（`foo:amd64: …`）
  const match = /^([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9-]+)?: /m.exec(run.raw);
  return match?.[1];
}

/** 识别安装方式；不是包管理器装的（或判断不了）返回 undefined，调用方用引擎自己的更新命令 */
export async function detectPackageInstall(
  executable: string | undefined,
  options: PackageToolOptions = {},
): Promise<PackageInstall | undefined> {
  if (executable === undefined) return undefined;
  let real: string;
  try {
    real = (options.realpath ?? realpathSync)(executable);
  } catch {
    return undefined;
  }
  // npm 全局包：可能在 Cellar/node 下，但它不是 node 这个 formula，升级 node 什么也解决不了
  if (real.includes('/node_modules/')) return undefined;
  // 显式指向版本目录（--claude-bin 等）：升级后这个路径会被清理，不替用户做
  if (BREW_PATH.test(executable)) return undefined;
  const brew = BREW_PATH.exec(real);
  if (brew !== null) {
    return { manager: 'brew', brew: `${brew[1]}/bin/brew`, token: brew[3]!, kind: brew[2] === 'Caskroom' ? 'cask' : 'formula' };
  }
  if ((options.platform ?? process.platform) !== 'linux') return undefined;
  const spawn = options.spawn ?? defaultSpawn;
  const env = options.env ?? process.env;
  const pkg = (await dpkgOwner(real, spawn, env)) ?? (real === executable ? undefined : await dpkgOwner(executable, spawn, env));
  return pkg === undefined ? undefined : { manager: 'apt', pkg };
}

/** 更新计划。apt 要 root：不是 root 就用 `sudo -n`，绝不等密码 */
export function updatePlan(install: PackageInstall, isRoot = process.getuid?.() === 0): UpdatePlan {
  if (install.manager === 'brew') {
    const args = install.kind === 'cask' ? ['upgrade', '--cask', install.token] : ['upgrade', install.token];
    return { commands: [[install.brew, ...args]], display: `brew ${args.join(' ')}` };
  }
  const sudo = isRoot ? [] : ['sudo', '-n'];
  const upgrade = ['apt-get', 'install', '--only-upgrade', '-y', install.pkg];
  const commands = [
    [...sudo, 'apt-get', 'update'],
    [...sudo, ...upgrade],
  ];
  // 给人手动跑的：要能输密码，所以没有 -n
  const manual = `sudo apt-get update && sudo ${upgrade.join(' ')}`;
  return {
    commands,
    display: commands.map((c) => c.join(' ')).join(' && '),
    explainFailure: (output) =>
      /sudo: .*(password|密码|not allowed|terminal)|is not in the sudoers/i.test(output)
        ? `这台机器没有配置 agent 可用的免密 sudo，请在机器上运行：${manual}`
        : undefined,
  };
}

function plainVersion(raw: string): string | undefined {
  return SEMVER.exec(raw)?.[0];
}

/** `brew info --json=v2` 的输出 → 版本。stderr 也在里面，只取 JSON 部分 */
export function parseBrewInfo(output: string, install: Extract<PackageInstall, { manager: 'brew' }>): string | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    const info = JSON.parse(output.slice(start, end + 1)) as {
      casks?: { version?: unknown }[];
      formulae?: { versions?: { stable?: unknown } }[];
    };
    const raw = install.kind === 'cask' ? info.casks?.[0]?.version : info.formulae?.[0]?.versions?.stable;
    // cask 的版本可能带构建号：`2.1.316,abcdef`
    return typeof raw === 'string' ? plainVersion(raw.split(',')[0]!) : undefined;
  } catch {
    return undefined;
  }
}

/** `apt-cache policy` 的输出 → 候选版本和渠道（Claude 的源地址是 `…/apt/<channel>`） */
export function parseAptPolicy(output: string): ManagerLatest | undefined {
  const candidate = /^\s*Candidate:\s*(\S+)/m.exec(output)?.[1];
  if (candidate === undefined || candidate === '(none)') return undefined;
  // 去掉 epoch 和 Debian 修订号：`1:2.1.319-1` → `2.1.319`
  const version = plainVersion(candidate.replace(/^\d+:/, '').replace(/-[^-]*$/, ''));
  if (version === undefined) return undefined;
  // 版本表里候选版本那一行后面的第一个源，才是它来自的渠道
  const lines = output.split('\n');
  const row = lines.findIndex((line) => line.trim().replace(/^\*\*\*\s+/, '').startsWith(`${candidate} `));
  const channel = (row < 0 ? undefined : /\/apt\/(latest|stable)\b/.exec(lines[row + 1] ?? '')?.[1]) as 'latest' | 'stable' | undefined;
  return { version, ...(channel === undefined ? {} : { channel }) };
}

/**
 * 包管理器现在能装上的版本。
 * brew 先刷新索引，刷新失败（比如没网）不算错，用本地索引。apt 刷新要 root，这里只读本地索引，
 * 系统的定时任务一般每天刷新，所以可能晚一天；真正更新时会先刷新。
 * @throws 查不到
 */
export async function latestFromManager(install: PackageInstall, options: PackageToolOptions = {}): Promise<ManagerLatest> {
  const spawn = options.spawn ?? defaultSpawn;
  const env = options.env ?? process.env;
  if (install.manager === 'brew') {
    await runCaptured(spawn, [install.brew, 'update', '--quiet'], { env, timeoutMs: BREW_UPDATE_TIMEOUT_MS });
    const run = await runCaptured(
      spawn,
      [install.brew, 'info', '--json=v2', ...(install.kind === 'cask' ? ['--cask'] : ['--formula']), install.token],
      { env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1' }, timeoutMs: BREW_UPDATE_TIMEOUT_MS },
    );
    const version = run.kind === 'exit' && run.code === 0 ? parseBrewInfo(run.raw, install) : undefined;
    if (version === undefined) throw new Error(`brew info 查不到 ${install.token} 的版本`);
    return {
      version,
      // Claude 的 cask：claude-code 是 stable 渠道，claude-code@latest 是 latest
      ...(install.token.endsWith('@latest') ? { channel: 'latest' as const } : install.token === 'claude-code' ? { channel: 'stable' as const } : {}),
    };
  }
  const run = await runCaptured(spawn, ['apt-cache', 'policy', install.pkg], {
    env: { ...env, LC_ALL: 'C' },
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  const latest = run.kind === 'exit' && run.code === 0 ? parseAptPolicy(run.raw) : undefined;
  if (latest === undefined) throw new Error(`apt 源里查不到 ${install.pkg} 的候选版本`);
  return latest;
}

/** machine.info 里给 client 看的安装方式 */
export function installSummary(install: PackageInstall | undefined): { manager: string; command: string } | undefined {
  return install === undefined ? undefined : { manager: install.manager, command: updatePlan(install).display.slice(0, 300) };
}
