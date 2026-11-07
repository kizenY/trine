import { describe, expect, test } from 'bun:test';
import { CodexLatestChecker, codexVersionNumber, fetchLatestCodexVersion } from './update.ts';

const fetchOf = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('Codex 最新版本', () => {
  test('tag 解析', async () => {
    expect(await fetchLatestCodexVersion(fetchOf({ tag_name: 'rust-v0.167.0' }))).toBe('0.167.0');
    expect(await fetchLatestCodexVersion(fetchOf({ tag_name: 'rust-v1.0.0-beta.1' }))).toBe('1.0.0-beta.1');
    await expect(fetchLatestCodexVersion(fetchOf({ tag_name: 'v1' }))).rejects.toThrow('认不出');
    await expect(fetchLatestCodexVersion(fetchOf({}, 403))).rejects.toThrow('403');
  });

  test('版本行', () => {
    expect(codexVersionNumber('codex-cli 0.166.0')).toBe('0.166.0');
    expect(codexVersionNumber('unknown')).toBe('unknown');
  });

  test('失败保留上次的版本并记下原因；成功清掉原因；都通知', async () => {
    let body: unknown = { tag_name: 'rust-v0.2.0' };
    let status = 200;
    let changes = 0;
    const checker = new CodexLatestChecker({
      fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
      onChange: () => (changes += 1),
      now: () => 42,
    });
    expect(await checker.check()).toEqual({ ok: true, version: '0.2.0' });
    expect(checker.current).toEqual({ version: '0.2.0', checkedAt: 42 });
    status = 500;
    expect(await checker.check()).toMatchObject({ ok: false });
    expect(checker.current).toMatchObject({ version: '0.2.0', checkedAt: 42, error: expect.stringContaining('500') });
    status = 200;
    body = { tag_name: 'rust-v0.3.0' };
    await checker.check();
    expect(checker.current).toEqual({ version: '0.3.0', checkedAt: 42 });
    expect(changes).toBe(3);
  });
});
