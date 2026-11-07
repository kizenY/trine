import { describe, expect, test } from 'bun:test';
import { ClaudeUpdater, type SpawnFn } from './claude-cli.ts';
import { ClaudeLatestChecker } from './claude-latest.ts';
import {
  detectPackageInstall,
  installSummary,
  latestFromManager,
  parseAptPolicy,
  parseBrewInfo,
  updatePlan,
  type PackageInstall,
} from './package-install.ts';

const stream = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      if (text !== '') controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

/** 按命令回放合成输出，记下调用过什么 */
function fakeSpawn(route: (cmd: string[]) => { out?: string; code?: number } | undefined) {
  const calls: string[][] = [];
  const spawn: SpawnFn = (cmd) => {
    calls.push(cmd);
    const result = route(cmd);
    if (result === undefined) throw new Error(`ENOENT ${cmd[0]}`);
    return { stdout: stream(result.out ?? ''), stderr: stream(''), exited: Promise.resolve(result.code ?? 0), kill: () => {} };
  };
  return { spawn, calls };
}

const brewCask: Extract<PackageInstall, { manager: 'brew' }> = { manager: 'brew', brew: '/opt/homebrew/bin/brew', token: 'claude-code@latest', kind: 'cask' };
const apt: PackageInstall = { manager: 'apt', pkg: 'claude-code' };

describe('识别安装方式', () => {
  const realpath = (real: string) => () => real;

  test('Homebrew：按真实路径认 cask 和 formula，brew 路径不依赖 PATH', async () => {
    const { spawn, calls } = fakeSpawn(() => undefined);
    expect(await detectPackageInstall('/opt/homebrew/bin/claude', { spawn, realpath: realpath('/opt/homebrew/Caskroom/claude-code@latest/2.1.316/claude') })).toEqual(brewCask);
    expect(await detectPackageInstall('/usr/local/bin/codex', { spawn, realpath: realpath('/usr/local/Cellar/codex/1.0.0/bin/codex') })).toEqual({
      manager: 'brew',
      brew: '/usr/local/bin/brew',
      token: 'codex',
      kind: 'formula',
    });
    expect(await detectPackageInstall('/x/codex', { spawn, realpath: realpath('/home/linuxbrew/.linuxbrew/Caskroom/codex/1.0.0/bin/codex') })).toMatchObject({
      brew: '/home/linuxbrew/.linuxbrew/bin/brew',
    });
    expect(calls).toHaveLength(0);
  });

  test('apt：dpkg-query 说了算；Linux 以外不问', async () => {
    const owned = fakeSpawn(() => ({ out: 'claude-code: /usr/bin/claude\n' }));
    expect(await detectPackageInstall('/usr/bin/claude', { spawn: owned.spawn, platform: 'linux', realpath: realpath('/usr/bin/claude') })).toEqual(apt);
    expect(owned.calls).toEqual([['dpkg-query', '-S', '/usr/bin/claude']]);
    const arch = fakeSpawn(() => ({ out: 'claude-code:amd64: /usr/bin/claude\n' }));
    expect(await detectPackageInstall('/usr/bin/claude', { spawn: arch.spawn, platform: 'linux', realpath: realpath('/usr/bin/claude') })).toEqual(apt);
    const mac = fakeSpawn(() => ({ out: 'x: y\n' }));
    expect(await detectPackageInstall('/usr/local/bin/claude', { spawn: mac.spawn, platform: 'darwin', realpath: realpath('/usr/local/bin/claude') })).toBeUndefined();
    expect(mac.calls).toHaveLength(0);
  });

  test('软链：真实路径没人认领时再问原路径', async () => {
    const { spawn, calls } = fakeSpawn((cmd) => (cmd[2] === '/usr/bin/claude' ? { out: 'claude-code: /usr/bin/claude\n' } : { code: 1 }));
    expect(await detectPackageInstall('/usr/bin/claude', { spawn, platform: 'linux', realpath: realpath('/opt/claude/claude') })).toEqual(apt);
    expect(calls).toHaveLength(2);
  });

  test('Cellar 里的 npm 全局包不是 formula；显式指向版本目录的不代为升级', async () => {
    const { spawn } = fakeSpawn(() => ({ code: 1 }));
    expect(
      await detectPackageInstall('/opt/homebrew/bin/claude', {
        spawn,
        platform: 'darwin',
        realpath: realpath('/opt/homebrew/Cellar/node/24.0.0/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
      }),
    ).toBeUndefined();
    const pinned = '/opt/homebrew/Caskroom/claude-code@latest/2.1.316/claude';
    expect(await detectPackageInstall(pinned, { spawn, platform: 'darwin', realpath: realpath(pinned) })).toBeUndefined();
  });

  test('不是包管理器装的、没有 dpkg、文件不存在：都当原生安装', async () => {
    const notOwned = fakeSpawn(() => ({ code: 1 }));
    expect(await detectPackageInstall('/home/u/.local/bin/codex', { spawn: notOwned.spawn, platform: 'linux', realpath: realpath('/home/u/.local/bin/codex') })).toBeUndefined();
    const noDpkg = fakeSpawn(() => undefined);
    expect(await detectPackageInstall('/x/codex', { spawn: noDpkg.spawn, platform: 'linux', realpath: realpath('/x/codex') })).toBeUndefined();
    expect(
      await detectPackageInstall('/gone', {
        realpath: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeUndefined();
    expect(await detectPackageInstall(undefined)).toBeUndefined();
  });
});

describe('更新计划', () => {
  test('brew', () => {
    expect(updatePlan(brewCask).commands).toEqual([['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'claude-code@latest']]);
    expect(updatePlan({ ...brewCask, kind: 'formula', token: 'codex' }).commands).toEqual([['/opt/homebrew/bin/brew', 'upgrade', 'codex']]);
  });

  test('apt：非 root 用 sudo -n，绝不等密码；只升级这一个包；root 不用 sudo', () => {
    expect(updatePlan(apt, false).commands).toEqual([
      ['sudo', '-n', 'apt-get', 'update'],
      ['sudo', '-n', 'apt-get', 'install', '--only-upgrade', '-y', 'claude-code'],
    ]);
    expect(updatePlan(apt, true).commands[1]).toEqual(['apt-get', 'install', '--only-upgrade', '-y', 'claude-code']);
    expect(installSummary(apt)?.manager).toBe('apt');
    expect(installSummary(undefined)).toBeUndefined();
  });

  test('认得出 sudo 要密码，告诉用户该跑什么', () => {
    const explain = updatePlan(apt, false).explainFailure!;
    expect(explain('sudo: a password is required\n')).toContain('sudo apt-get install --only-upgrade -y claude-code');
    expect(explain('E: Could not get lock\n')).toBeUndefined();
    // 显示的是实际执行的；手动命令没有 -n，人才能输密码
    expect(updatePlan(apt, false).display).toBe('sudo -n apt-get update && sudo -n apt-get install --only-upgrade -y claude-code');
    expect(explain('sudo: a password is required\n')).not.toContain('-n');
  });
});

describe('ClaudeUpdater 走更新计划', () => {
  const updater = (spawn: SpawnFn, plan: ReturnType<typeof updatePlan> | undefined) => {
    let version = '1.0.0';
    return {
      bump: () => (version = '1.1.0'),
      run: new ClaudeUpdater({
        executable: '/usr/bin/claude',
        currentVersion: () => '1.0.0',
        detectVersion: async () => version,
        spawn,
        plan: async () => plan,
      }),
    };
  };

  test('逐条执行，不再跑 claude update（它只打印提示，退出码还是 0）', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ out: 'ok\n' }));
    const u = updater(spawn, updatePlan(apt, false));
    expect(await u.run.run()).toMatchObject({ ok: true });
    expect(calls.map((c) => c.join(' '))).toEqual(['sudo -n apt-get update', 'sudo -n apt-get install --only-upgrade -y claude-code']);
  });

  test('sudo 要密码：第一步就停，错误里带要跑的命令', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ out: 'sudo: a password is required\n', code: 1 }));
    const outcome = await updater(spawn, updatePlan(apt, false)).run.run();
    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(outcome.error?.message).toContain('sudo apt-get update');
    expect(outcome.output).toContain('password');
  });

  test('超时算整个流程：前一步用完时间，后一步不再执行', async () => {
    const calls: string[][] = [];
    const spawn: SpawnFn = (cmd) => {
      calls.push(cmd);
      return { stdout: stream(''), stderr: stream(''), exited: Bun.sleep(30).then(() => 0), kill: () => {} };
    };
    const outcome = await new ClaudeUpdater({
      executable: '/usr/bin/claude',
      currentVersion: () => '1.0.0',
      detectVersion: async () => '1.0.0',
      spawn,
      timeoutMs: 20,
      plan: async () => ({ commands: [['a'], ['b']], display: 'a && b' }),
    }).run();
    expect(outcome).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(calls).toEqual([['a']]);
  });

  test('别的失败报实际命令；原生安装照旧', async () => {
    const failed = fakeSpawn(() => ({ code: 100 }));
    expect((await updater(failed.spawn, updatePlan(brewCask)).run.run()).error?.message).toBe('brew upgrade --cask claude-code@latest 退出码 100');
    const native = fakeSpawn(() => ({}));
    await updater(native.spawn, undefined).run.run();
    expect(native.calls).toEqual([['/usr/bin/claude', 'update']]);
  });
});

describe('包管理器的最新版本', () => {
  test('brew info：带构建号、带 stderr 噪音都能解析；坏输出不当版本', () => {
    expect(parseBrewInfo('Warning: x\n{"casks":[{"version":"2.1.316,abc123"}],"formulae":[]}\n', brewCask)).toBe('2.1.316');
    expect(parseBrewInfo('{"casks":[],"formulae":[{"versions":{"stable":"1.2.3"}}]}', { ...brewCask, kind: 'formula' })).toBe('1.2.3');
    expect(parseBrewInfo('{"casks":[{"version":"latest"}]}', brewCask)).toBeUndefined();
    expect(parseBrewInfo('not json', brewCask)).toBeUndefined();
  });

  test('apt-cache policy：候选版本去掉 epoch 和修订号，源地址给出渠道', () => {
    const policy = (candidate: string) =>
      `claude-code:\n  Installed: 2.1.316-1\n  Candidate: ${candidate}\n  Version table:\n     2.1.319-1 500\n        500 https://downloads.claude.ai/claude-code/apt/latest latest/main amd64 Packages\n`;
    expect(parseAptPolicy(policy('2.1.319-1'))).toEqual({ version: '2.1.319', channel: 'latest' });
    expect(parseAptPolicy(policy('1:2.1.319-0ubuntu1'))).toMatchObject({ version: '2.1.319' });
    expect(parseAptPolicy(policy('(none)'))).toBeUndefined();
    const pinned = 'x:\n  Candidate: 2.1.310-1\n  Version table:\n     2.1.319-1 500\n        500 https://h/claude-code/apt/latest latest/main amd64 Packages\n     2.1.310-1 990\n        990 https://h/claude-code/apt/stable stable/main amd64 Packages\n';
    expect(parseAptPolicy(pinned)).toEqual({ version: '2.1.310', channel: 'stable' });
    expect(parseAptPolicy('')).toBeUndefined();
  });

  test('brew：刷新索引失败不算错；渠道看 cask 名', async () => {
    const { spawn, calls } = fakeSpawn((cmd) => (cmd[1] === 'update' ? { code: 1 } : { out: '{"casks":[{"version":"2.1.320"}]}' }));
    expect(await latestFromManager(brewCask, { spawn })).toEqual({ version: '2.1.320', channel: 'latest' });
    expect(calls[1]).toEqual(['/opt/homebrew/bin/brew', 'info', '--json=v2', '--cask', 'claude-code@latest']);
    expect(await latestFromManager({ ...brewCask, token: 'claude-code' }, { spawn })).toMatchObject({ channel: 'stable' });
    expect((await latestFromManager({ ...brewCask, token: 'codex' }, { spawn })).channel).toBeUndefined();
  });

  test('查不到就抛', async () => {
    const { spawn } = fakeSpawn(() => ({ code: 1 }));
    await expect(latestFromManager(apt, { spawn })).rejects.toThrow('候选版本');
    await expect(latestFromManager(brewCask, { spawn })).rejects.toThrow('brew info');
  });
});

describe('ClaudeLatestChecker 问包管理器', () => {
  test('不访问发布源；渠道、版本和安装方式都来自包管理器', async () => {
    let fetched = 0;
    const checker = new ClaudeLatestChecker({
      fetchImpl: (async () => {
        fetched += 1;
        return new Response('9.9.9');
      }) as unknown as typeof fetch,
      configDir: '/nonexistent',
      detectInstall: async () => ({ ...brewCask, token: 'claude-code' }),
      managerLatest: async () => ({ version: '2.1.300', channel: 'stable' }),
      now: () => 7,
    });
    expect(await checker.check()).toEqual({ ok: true, version: '2.1.300', channel: 'stable' });
    expect(fetched).toBe(0);
    expect(checker.current).toEqual({
      channel: 'stable',
      version: '2.1.300',
      checkedAt: 7,
      install: { manager: 'brew', command: 'brew upgrade --cask claude-code' },
    });
  });

  test('启动时就知道安装方式；查询失败也保留', async () => {
    let changes = 0;
    const checker = new ClaudeLatestChecker({
      configDir: '/nonexistent',
      detectInstall: async () => apt,
      managerLatest: async () => {
        throw new Error('no candidate');
      },
      onChange: () => (changes += 1),
    });
    await checker.loadInstall();
    expect(checker.current.install?.manager).toBe('apt');
    expect(changes).toBe(1);
    expect(await checker.check()).toMatchObject({ ok: false });
    expect(checker.current).toMatchObject({ install: { manager: 'apt' }, error: expect.stringContaining('no candidate') });
  });

  test('原生安装照旧查发布源，界面数据不变', async () => {
    const checker = new ClaudeLatestChecker({
      fetchImpl: (async () => new Response('2.1.400')) as unknown as typeof fetch,
      configDir: '/nonexistent',
      detectInstall: async () => undefined,
      now: () => 7,
    });
    await checker.loadInstall();
    await checker.check();
    expect(checker.current).toEqual({ channel: 'latest', version: '2.1.400', checkedAt: 7 });
  });
});
