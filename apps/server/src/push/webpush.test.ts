/**
 * Web Push（PWA 通知）单测：订阅存取、按设备在线抑制/去抖、投递请求形态、
 * 订阅失效清理，以及 hub 侧 push.* 帧的接线。
 *
 * 真推送不在单测范围：加密与 VAPID 由久经沙场的 web-push 库负责，
 * 这里验证的是我们自己的编排逻辑。全部注入 fake fetch / 手动时钟，零真网络。
 */
import { describe, expect, test } from 'bun:test';
import { generateVAPIDKeys } from 'web-push';
import { loadConfig, type ServerConfig } from '../config.ts';
import { Store } from '../store/index.ts';
import { WebPushService, pushTag, checkPushEndpoint } from './webpush.ts';
import { RelayHub } from '../ws/hub.ts';
import { ConnectionRegistry, type Conn, type Sendable } from '../ws/registry.ts';

/** 记录每次 fetch 的请求形态，可编排响应 */
class FakeFetch {
  readonly calls: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
  respondWith: (url: string) => { status: number } = () => ({ status: 201 });

  readonly impl = (url: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: new Uint8Array((init?.body ?? new ArrayBuffer(0)) as ArrayBuffer),
    });
    return Promise.resolve(new Response(null, this.respondWith(url)));
  };
}

function makeService(over: {
  store?: Store;
  online?: Set<string>;
  fetch?: FakeFetch;
  now?: () => number;
} = {}): WebPushService {
  return new WebPushService({
    store: over.store ?? new Store(':memory:'),
    isDeviceOnline: (id) => (over.online ?? new Set()).has(id),
    fetchImpl: (over.fetch ?? new FakeFetch()).impl,
    now: over.now ?? (() => 1_000_000),
    log: () => {},
  });
}

// p256dh 必须是合法的 P-256 公钥点(65 字节 → 87 字符 base64url):加密库
// 会真的拿它做 ECDH,假字符串过不了 base64url/长度校验。拿 VAPID 生成器
// 的公钥当客户端公钥用,形状完全一致
const SUB = (() => {
  const k = generateVAPIDKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/dTok',
    keys: {
      p256dh: k.publicKey,
      auth: Buffer.from('0123456789abcdef').toString('base64url'),
    },
  };
})();

// ---------------------------------------------------------------------------

describe('VAPID 密钥管理', () => {
  test('首启自动生成,跨实例稳定(落库)', () => {
    const store = new Store(':memory:');
    const a = makeService({ store });
    const key = a.vapidPublicKey;
    expect(key).toBeTruthy();
    expect(key!.length).toBeGreaterThan(40);
    // 换一个服务实例(如重启)读到同一副密钥
    expect(makeService({ store }).vapidPublicKey).toBe(key);
  });
});

describe('订阅存取', () => {
  test('subscribe 覆盖式存储,unsubscribe 删除,幂等', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    svc.subscribe('phone', SUB);
    expect(store.getPushSubscription('phone')?.endpoint).toBe(SUB.endpoint);
    // 同设备换 endpoint(浏览器轮换) → 覆盖
    svc.subscribe('phone', { ...SUB, endpoint: 'https://fcm.googleapis.com/fcm/send/new' });
    expect(store.getPushSubscription('phone')?.endpoint).toBe('https://fcm.googleapis.com/fcm/send/new');
    svc.unsubscribe('phone');
    expect(store.getPushSubscription('phone')).toBeNull();
    svc.unsubscribe('phone'); // 再删不炸
  });
});

describe('deliverTo:按设备定向的抑制与去抖', () => {
  test('没订阅 → no_subscription;设备在线 → device_online(且不占去抖名额)', () => {
    const online = new Set<string>();
    const svc = makeService({ online });
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'no_subscription' });
    svc.subscribe('phone', SUB);
    online.add('phone');
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'device_online' });
    // 在线抑制不记去抖:下线后第一条就能推
    online.delete('phone');
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }).kind)
      .toBe('sent');
  });

  test('会话级静音:run.done 不推,机器级事件(无 sessionId)不受影响', () => {
    const svc = makeService();
    svc.subscribe('phone', SUB);
    svc.setMutes('phone', ['s-poll']);
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's-poll', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'muted' });
    // 未静音的会话照推
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's-other', hint: 'run_done' }).kind)
      .toBe('sent');
    // 机器级事件没有 sessionId,静音管不着
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }).kind)
      .toBe('sent');
    // 全量覆盖式更新:清空名单后恢复推送
    svc.setMutes('phone', []);
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's-poll', hint: 'run_done' }).kind)
      .toBe('sent');
  });

  test('同(设备,机器,会话,hint)窗口内去抖,不同会话不去抖', async () => {
    let clock = 1_000_000;
    const svc = makeService({ now: () => clock });
    svc.subscribe('phone', SUB);
    // 去抖只在投递成功后才登记,所以每次投递后要等 FakeFetch 的 promise 落地
    const settle = () => new Promise((r) => setTimeout(r, 10));
    const e1 = svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'permission_pending' });
    expect(e1.kind).toBe('sent');
    await settle();
    clock += 5_000; // 30s 窗口内
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'permission_pending' }))
      .toEqual({ kind: 'skipped', reason: 'deduped' });
    // 另一个会话同时要权限:是另一件事,该推
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's2', hint: 'permission_pending' }).kind)
      .toBe('sent');
    await settle();
    clock += 31_000; // 窗口过期
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'permission_pending' }).kind)
      .toBe('sent');
  });

  test('投递请求:aes128gcm 密文 + TTL + VAPID 头,payload 推送服务读不到明文', async () => {
    const fetch = new FakeFetch();
    const svc = makeService({ fetch });
    svc.subscribe('phone', SUB);
    const out = svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' });
    expect(out.kind).toBe('sent');
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget 落地
    expect(fetch.calls.length).toBe(1);
    const call = fetch.calls[0]!;
    expect(call.url).toBe(SUB.endpoint);
    expect(call.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(call.headers.TTL)).toBe('7200');
    expect(String(call.headers.Authorization)).toContain('vapid t=');
    // 正文是 RFC8291 密文,绝不含明文文案
    const text = Buffer.from(call.body).toString('utf8');
    expect(text).not.toContain('任务完成');
    expect(call.body.length).toBeGreaterThan(64);
  });

  test('404/410 = 订阅失效 → 清行;201 → 保留', async () => {
    const fetch = new FakeFetch();
    const store = new Store(':memory:');
    const svc = makeService({ fetch, store });
    svc.subscribe('phone', SUB);
    fetch.respondWith = () => ({ status: 410 });
    svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getPushSubscription('phone')).toBeNull();
    // 再投一条:订阅已清,不再发请求
    expect(fetch.calls.length).toBe(1);
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'no_subscription' });
  });
});

describe('订阅端点白名单', () => {
  test('已知推送服务放行;内网、非 https、未知域名拒绝', () => {
    expect(checkPushEndpoint('https://fcm.googleapis.com/fcm/send/x').ok).toBe(true);
    expect(checkPushEndpoint('https://web.push.apple.com/x').ok).toBe(true);
    expect(checkPushEndpoint('https://updates.push.services.mozilla.com/x').ok).toBe(true);
    expect(checkPushEndpoint('https://wns2-sg2p.notify.windows.com/x').ok).toBe(true);

    expect(checkPushEndpoint('http://fcm.googleapis.com/x').ok).toBe(false);
    expect(checkPushEndpoint('https://127.0.0.1/x').ok).toBe(false);
    expect(checkPushEndpoint('https://192.168.1.5/x').ok).toBe(false);
    expect(checkPushEndpoint('https://[::1]/x').ok).toBe(false);
    expect(checkPushEndpoint('https://evil.example/x').ok).toBe(false);
    expect(checkPushEndpoint('not a url').ok).toBe(false);
  });

  test('env 追加的白名单后缀生效', () => {
    expect(checkPushEndpoint('https://push.example.com/x').ok).toBe(false);
    expect(checkPushEndpoint('https://push.example.com/x', ['push.example.com']).ok).toBe(true);
    // 后缀匹配只认点在前的子域,不能拿 example.com 冒充别的子串
    expect(checkPushEndpoint('https://notpush.example.com/x', ['push.example.com']).ok).toBe(false);
  });

  test('subscribe 被拒时不落库;库里的旧端点投递前再拦一次', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    const rejected = svc.subscribe('phone', { ...SUB, endpoint: 'https://evil.example/x' });
    expect(rejected.ok).toBe(false);
    expect(store.getPushSubscription('phone')).toBeNull();

    // 白名单生效前写进来的行:投递时复查
    store.upsertPushSubscription(
      { deviceId: 'phone', endpoint: 'https://evil.example/x', p256dh: SUB.keys.p256dh, auth: SUB.keys.auth },
      1,
    );
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'untrusted_endpoint' });
  });
});

describe('可见性:只有在线且可见才抑制', () => {
  test('在线 + visible=false 照推;未上报时沿用在线抑制', () => {
    const online = new Set<string>(['phone']);
    const svc = makeService({ online });
    svc.subscribe('phone', SUB);

    // 老客户端:没上报过可见性 → 在线即抑制
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'device_online' });

    // 锁屏/切后台:连接还在,但明确不可见 → 该推
    svc.setVisibility('phone', false);
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'run_done' }).kind)
      .toBe('sent');

    // 回到前台 → 恢复抑制
    svc.setVisibility('phone', true);
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's2', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'device_online' });
  });
});

describe('去抖只记成功投递', () => {
  test('5xx 不占窗口;成功后才抑制同键', async () => {
    const fetch = new FakeFetch();
    const svc = makeService({ fetch });
    svc.subscribe('phone', SUB);
    const event = { machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'permission_pending' } as const;

    fetch.respondWith = () => ({ status: 500 });
    expect(svc.deliverTo(event).kind).toBe('sent');
    await new Promise((r) => setTimeout(r, 10)); // 等失败的投递落地

    // 失败没有占用窗口:同样的事件立刻还能推
    fetch.respondWith = () => ({ status: 201 });
    expect(svc.deliverTo(event).kind).toBe('sent');
    await new Promise((r) => setTimeout(r, 10)); // 等成功的投递落地

    // 成功之后才进入 30s 去抖
    expect(svc.deliverTo(event)).toEqual({ kind: 'skipped', reason: 'deduped' });
  });
});

describe('通知 tag:折叠范围细到会话与类别', () => {
  test('同机器不同会话不互相覆盖;同一会话 pending 与 result 分开', () => {
    const label = 'mbp';
    const aPending = pushTag({ machineId: 'm', sessionId: 's1', hint: 'permission_pending' }, label);
    const bDone = pushTag({ machineId: 'm', sessionId: 's2', hint: 'run_done' }, label);
    const aDone = pushTag({ machineId: 'm', sessionId: 's1', hint: 'run_done' }, label);
    expect(aPending).not.toBe(bDone); // 会话 B 的提醒不能顶掉会话 A 的
    expect(aPending).not.toBe(aDone); // 待确认不能被后续完成顶掉
    // 同类同会话仍然折叠(去抖之外的重复提醒不堆楼)
    expect(pushTag({ machineId: 'm', sessionId: 's1', hint: 'question_pending' }, label)).toBe(aPending);
    // 机器级事件没有会话维度,退回机器标识
    expect(pushTag({ machineId: 'm', hint: 'run_done' }, label)).toBe(label);
  });
});

describe('吊销设备', () => {
  test('revokeDevice 一并清掉订阅与静音,投递返回 revoked', () => {
    const store = new Store(':memory:');
    store.registerDevice('phone', 'client', 'PK', 1);
    const svc = makeService({ store });
    svc.subscribe('phone', SUB);
    svc.setMutes('phone', ['s1']);
    store.revokeDevice('phone', 2);
    expect(store.getPushSubscription('phone')).toBeNull();
    expect(store.isPushMuted('phone', 's1')).toBe(false);
    // 即便订阅行曾被其他路径写回,投递前的吊销检查也会拦住
    svc.subscribe('phone', SUB);
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'revoked' });
  });
});

// ---------------------------------------------------------------------------
// hub 接线:push.* 帧 + client 上线下发公钥
// ---------------------------------------------------------------------------

class FakeSocket implements Sendable {
  readonly sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { /* 测试里不用 */ }
  frame<T = Record<string, unknown>>(i: number): T { return JSON.parse(this.sent[i]!) as T; }
}

function clientConn(ws: FakeSocket): Conn<FakeSocket> {
  return {
    ws, deviceId: 'phone', role: 'client',
    connectedAt: 1, lastSeenAt: 1, pendingPings: 0,
  };
}

describe('hub:push.* 帧接线', () => {
  function makeHub(over: { webpush?: WebPushService } = {}): {
    hub: RelayHub<FakeSocket>;
    store: Store;
    config: ServerConfig;
  } {
    const store = new Store(':memory:');
    const config = loadConfig({ dbPath: ':memory:' });
    const hub = new RelayHub<FakeSocket>({
      store,
      registry: new ConnectionRegistry<FakeSocket>(),
      config,
      ...(over.webpush ? { webpush: over.webpush } : {}),
      now: () => 1_000_000,
    });
    return { hub, store, config };
  }

  test('client 上线即收到 push.config(带 VAPID 公钥)', () => {
    const svc = makeService();
    const key = svc.vapidPublicKey;
    expect(key).toBeTruthy();
    const { hub } = makeHub({ webpush: svc });
    const ws = new FakeSocket();
    hub.onClientOnline(clientConn(ws));
    const cfg = ws.frame(0) as { type: string; vapidPublicKey?: string };
    expect(cfg.type).toBe('push.config');
    expect(cfg.vapidPublicKey).toEqual(key ?? undefined);
  });

  test('push.subscribe 按连接身份归档并回执;agent 发则拒', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    const { hub } = makeHub({ webpush: svc });
    const ws = new FakeSocket();
    const outcome = hub.handleFrame(clientConn(ws), {
      type: 'push.subscribe', endpoint: SUB.endpoint, keys: SUB.keys,
    });
    expect(outcome.kind).toBe('ignored');
    const ack = ws.frame(0) as { type: string; ok: boolean };
    expect(ack).toEqual({ type: 'push.subscribed', ok: true });
    expect(store.getPushSubscription('phone')?.endpoint).toBe(SUB.endpoint);

    const agentWs = new FakeSocket();
    const rejected = hub.handleFrame(
      { ws: agentWs, deviceId: 'mbp', role: 'agent', machineId: 'mbp', connectedAt: 1, lastSeenAt: 1, pendingPings: 0 },
      { type: 'push.subscribe', endpoint: SUB.endpoint, keys: SUB.keys },
    );
    expect(rejected).toEqual({ kind: 'rejected', reason: 'push_sub_from_agent' });
  });

  test('push.unsubscribe 删行并回执', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    const { hub } = makeHub({ webpush: svc });
    svc.subscribe('phone', SUB);
    const ws = new FakeSocket();
    hub.handleFrame(clientConn(ws), { type: 'push.unsubscribe', endpoint: SUB.endpoint });
    expect(store.getPushSubscription('phone')).toBeNull();
    expect((ws.frame(0) as { ok: boolean }).ok).toBe(true);
  });

  test('push.mute 全量覆盖静音名单(无回执,幂等)', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    const { hub } = makeHub({ webpush: svc });
    const ws = new FakeSocket();
    hub.handleFrame(clientConn(ws), { type: 'push.mute', sessionIds: ['a', 'b'] });
    expect(store.isPushMuted('phone', 'a')).toBe(true);
    expect(store.isPushMuted('phone', 'b')).toBe(true);
    expect(ws.sent.length).toBe(0); // 静音没有回执
    hub.handleFrame(clientConn(ws), { type: 'push.mute', sessionIds: ['a'] });
    expect(store.isPushMuted('phone', 'b')).toBe(false); // 全量覆盖
    // agent 发 push.mute 直接拒
    const rejected = hub.handleFrame(
      { ws: new FakeSocket(), deviceId: 'mbp', role: 'agent', machineId: 'mbp', connectedAt: 1, lastSeenAt: 1, pendingPings: 0 },
      { type: 'push.mute', sessionIds: ['a'] },
    );
    expect(rejected.kind).toBe('rejected');
  });

  test('push.visibility 无回执,但影响在线抑制', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store, online: new Set(['phone']) });
    const { hub } = makeHub({ webpush: svc });
    svc.subscribe('phone', SUB);
    const ws = new FakeSocket();
    const outcome = hub.handleFrame(clientConn(ws), { type: 'push.visibility', visible: false });
    expect(outcome.kind).toBe('ignored');
    expect(ws.sent.length).toBe(0); // 可见性无回执
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'run_done' }).kind)
      .toBe('sent');
  });

  test('push.subscribe 端点不在白名单:回执 ok:false 并带原因', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    const { hub } = makeHub({ webpush: svc });
    const ws = new FakeSocket();
    hub.handleFrame(clientConn(ws), {
      type: 'push.subscribe', endpoint: 'https://evil.example/x', keys: SUB.keys,
    });
    const ack = ws.frame(0) as { type: string; ok: boolean; error?: string };
    expect(ack.ok).toBe(false);
    expect(ack.error).toBeTruthy();
    expect(store.getPushSubscription('phone')).toBeNull();
  });

  test('未启用 webpush 的 hub:订阅回执 ok:false,client 上线不下发 config', () => {
    const { hub } = makeHub();
    const ws = new FakeSocket();
    hub.onClientOnline(clientConn(ws));
    expect(ws.sent.length).toBe(0); // 没有任何机器,也就没有 status 帧;重点是没有 push.config
    hub.handleFrame(clientConn(ws), { type: 'push.subscribe', endpoint: SUB.endpoint, keys: SUB.keys });
    expect((ws.frame(0) as { ok: boolean; error?: string }).ok).toBe(false);
  });
});
