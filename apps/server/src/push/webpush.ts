/**
 * Web Push 渠道（PWA 原生通知，RFC 8030/8291/8292）。
 *
 * ## 为什么不走 PushDispatcher
 *
 * dispatcher 是**广播**模型：一条逻辑事件（run_done 等）去抖后只投一次，
 * 渠道拿到的 PushMessage 里刻意没有路由信息（types.ts 的脱敏签名约束）。
 * 而 Web Push 天然是**按设备定向**的：每台手机各自 subscribe 一个 endpoint，
 * 机器↔设备的映射关系服务端并不持有（配对名册在 agent 手里），中转链路里
 * 唯一能见到「这份数据属于哪台设备」的地方是 a2c relay 帧上的
 * `recipientDeviceId`——每收件人一帧。所以本渠道由 hub 在 routeToRecipient
 * 处按帧直调 `deliverTo()`，自带**按设备**的在线抑制与去抖；dispatcher 与
 * Bark 的行为一个字节都不动。
 *
 * ## 抑制与去抖（按设备，不是按机器）
 *
 * - **在线抑制**：目标设备当前有 WS 连接就不推——它正开着 trine，消息走
 *   WS 实时到达，再响一声只是噪音。这比 dispatcher 的全局抑制更准：PC 开着
 *   不该挡手机的推送。
 * - **去抖**：同一 (设备, 机器, 会话, hint) 30s 内只推一次，权限请求风暴
 *   不刷屏（与 dispatcher 同款窗口，独立计数）。
 *
 * ## 脱敏
 *
 * 文案复用 `renderPushMessage`（机器标识 + 事件类型的固定中文），payload 里
 * 额外带 machineId/sessionId 供 SW 点击深链——RFC 8291 加密后推送服务
 * （FCM/Apple）只见得到密文，这与 Bark 把机器标识明文交给第三方服务器相比
 * 反而更收敛。
 *
 * ## 投递
 *
 * 加密与 VAPID 头用久经沙场的 web-push 库生成（`generateRequestDetails`），
 * HTTP 用自己的 fetch（可注入、好测试）：5s 超时、4xx 不重试；404/410 =
 * 订阅已失效，顺手清掉本行。
 */
import {
  generateRequestDetails,
  generateVAPIDKeys,
  setVapidDetails,
} from 'web-push';
import type { Store } from '../store/index.ts';
import type { PushHint } from '@trine/core';
import { renderPushMessage, parseAliases } from './text.ts';

/**
 * VAPID 联系人（RFC 8292 subject）的兜底值：推送服务出问题时找谁。
 * 会被 env TRINE_VAPID_SUBJECT 覆盖。
 *
 * **iOS 注意（实测 2026-11）**：Apple 的推送服务拒绝 `mailto:` 带
 * localhost 域的 subject（HTTP 403 BadJwtToken），且订阅与 VAPID 公钥
 * 绑定（换公钥发报 400 VapidPkHashMismatch）。iOS 场景务必把
 * TRINE_VAPID_SUBJECT 配成自己的 https 地址，如 https://trine.example.com。
 */
const DEFAULT_VAPID_SUBJECT = 'mailto:trine@example.com';

/** 通知存活时长：跑完/待确认的提醒过两小时还没送达就别响了 */
const TTL_BY_HINT: Record<PushHint, number> = {
  permission_pending: 30 * 60,
  question_pending: 30 * 60,
  plan_pending: 30 * 60,
  run_done: 2 * 60 * 60,
  run_error: 2 * 60 * 60,
};

/** 权限类提醒值得立刻叫人，跑完类默认优先级 */
const URGENCY_BY_HINT: Record<PushHint, 'high' | 'normal'> = {
  permission_pending: 'high',
  question_pending: 'high',
  plan_pending: 'high',
  run_done: 'normal',
  run_error: 'normal',
};

/**
 * 提醒类 hint：需要人当场处理的，和「跑完了」这类结果通知分开折叠。
 *
 * 同一会话里「等待权限确认」是待办，「任务完成」是结果；一条顶掉另一条会让
 * 最该处理的那条消失，所以两类用不同 tag。
 */
const PENDING_HINTS: ReadonlySet<PushHint> = new Set<PushHint>([
  'permission_pending',
  'question_pending',
  'plan_pending',
]);

/**
 * 已知推送服务的主机后缀。
 *
 * endpoint 由客户端上报，relay 会拿它发 POST；不设边界的话，一个已认证的
 * client 就能让中转去请求任意 https 地址。这里只放行真实存在的推送服务，
 * 需要接新服务时用 env `TRINE_PUSH_ALLOWED_HOSTS` 追加。
 */
const DEFAULT_ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome / Edge（Android）
  'push.apple.com', // Safari / iOS PWA（web.push.apple.com、*.push.apple.com）
  'push.services.mozilla.com', // Firefox autopush（updates.push.services.mozilla.com）
  'notify.windows.com', // Edge（Windows，WNS）
];

/** VAPID 初始化失败后的静默期：别每来一帧就重试并打一条日志 */
const VAPID_RETRY_MS = 60_000;

/** 内网 / 回环 / 链路本地地址：即便通过了域名白名单也不该被 POST */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (host.includes(':')) {
    // IPv6 字面量：::1、::、fc00::/7（唯一本地）、fe80::/10（链路本地）
    if (host === '::1' || host === '::') return true;
    if (/^f[cd]/.test(host)) return true;
    if (/^fe[89ab]/.test(host)) return true;
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost');
}

/**
 * 订阅端点校验：https + 已知推送服务 + 非内网。
 *
 * 返回错误文案是给人看的（设置页会原样展示回执里的 `error`）。
 */
export function checkPushEndpoint(
  endpoint: string,
  extraHosts: readonly string[] = [],
): { ok: true } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: '推送端点不是合法 URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: '推送端点必须 https' };
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return { ok: false, error: '推送端点指向内网地址' };
  const allowed = [
    ...DEFAULT_ALLOWED_PUSH_HOSTS,
    ...extraHosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== ''),
  ];
  const matches = allowed.some((h) => host === h || host.endsWith(`.${h}`));
  if (!matches) return { ok: false, error: '推送端点不是已知的推送服务' };
  return { ok: true };
}

/**
 * 通知 tag：机器 + 会话 + 类别。
 *
 * tag 相同会替换旧通知（这是 SW 折叠的机制），所以必须细到会话——否则同机器
 * 的会话 B 会把会话 A 的待确认提醒顶掉。没有 sessionId 的机器级事件退回
 * 机器标识（与 Bark 的 group 一致）。
 */
export function pushTag(event: { machineId: string; sessionId?: string; hint: PushHint }, label: string): string {
  if (event.sessionId === undefined) return label;
  const kind = PENDING_HINTS.has(event.hint) ? 'pending' : 'result';
  return `${label}|${event.sessionId}|${kind}`;
}

/** 传给 SW 的 payload（RFC 8291 加密，推送服务读不到） */
interface PushPayload {
  title: string;
  body: string;
  tag: string;
  machineId: string;
  sessionId?: string;
}

/** 最小 fetch 签名（typeof fetch 在 bun 的类型里带 preconnect 等扩展，测试替身难对齐） */
export type PushFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface WebPushDeps {
  store: Store;
  /** 目标设备当前是否有 WS 连接（在线抑制判据，注入便于测试） */
  isDeviceOnline: (deviceId: string) => boolean;
  /** 机器标识别名，与 Bark 渠道同一份 TRINE_PUSH_ALIAS 原串 */
  rawAlias?: string;
  /** 在默认白名单之外追加允许的推送服务主机后缀（env TRINE_PUSH_ALLOWED_HOSTS） */
  allowedHostSuffixes?: readonly string[];
  /** VAPID subject（env TRINE_VAPID_SUBJECT）；iOS 需配 https 域名，见 DEFAULT_VAPID_SUBJECT 注释 */
  vapidSubject?: string;
  fetchImpl?: PushFetch;
  log?: (line: string) => void;
  now?: () => number;
  dedupeWindowMs?: number;
  /** 单次投递超时 */
  timeoutMs?: number;
}

export type DeliverOutcome =
  | { kind: 'sent' }
  | {
      kind: 'skipped';
      reason:
        | 'no_subscription'
        | 'device_online'
        | 'revoked'
        | 'untrusted_endpoint'
        | 'muted'
        | 'deduped'
        | 'disabled';
    }
  | { kind: 'failed'; status?: number };

export class WebPushService {
  readonly #store: Store;
  readonly #isDeviceOnline: (deviceId: string) => boolean;
  readonly #aliases: Record<string, string>;
  readonly #fetchImpl: PushFetch;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #dedupeWindowMs: number;
  readonly #timeoutMs: number;
  readonly #subject: string;
  readonly #allowedHosts: readonly string[];
  /** 去抖记录：key = device|machine|session|hint → 上次**成功**推送时刻 */
  readonly #lastSentAt = new Map<string, number>();
  /** 正在投递中的 key：HTTP 完成前不放行同键重入（去抖改为成功后回填） */
  readonly #inflight = new Set<string>();
  /** 页面前后台状态：只有**在线且可见**才做在线抑制 */
  readonly #visible = new Map<string, boolean>();
  #vapid: { publicKey: string; privateKey: string } | null = null;
  #vapidRetryAt = 0;

  constructor(deps: WebPushDeps) {
    this.#store = deps.store;
    this.#isDeviceOnline = deps.isDeviceOnline;
    this.#aliases = parseAliases(deps.rawAlias);
    this.#allowedHosts = deps.allowedHostSuffixes ?? [];
    this.#fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.#log = deps.log ?? (() => {});
    this.#now = deps.now ?? (() => Date.now());
    this.#dedupeWindowMs = deps.dedupeWindowMs ?? 30_000;
    this.#timeoutMs = deps.timeoutMs ?? 5_000;
    this.#subject = deps.vapidSubject ?? DEFAULT_VAPID_SUBJECT;
  }

  /**
   * VAPID 公钥：首启自动生成并落库（跨重启稳定），之后每次 client 连上
   * 由 hub 用它发 push.config。库内部状态（setVapidDetails）同步在这里初始化。
   */
  get vapidPublicKey(): string | null {
    if (this.#vapid === null) {
      const now = this.#now();
      // 失败后静默一分钟再试：每来一帧都重试既白费也刷日志
      if (now < this.#vapidRetryAt) return null;
      try {
        this.#vapid = this.#store.getOrInitVapid(() => {
          const keys = generateVAPIDKeys();
          return { publicKey: keys.publicKey, privateKey: keys.privateKey };
        }, now);
        setVapidDetails(
          this.#subject, this.#vapid.publicKey, this.#vapid.privateKey,
        );
      } catch (err) {
        // 推送是旁路，初始化失败只记日志：订阅/投递会各自返回 disabled/failed
        this.#vapidRetryAt = now + VAPID_RETRY_MS;
        this.#log(`[webpush] VAPID 初始化失败：${String((err as Error).message ?? err)}`);
        return null;
      }
    }
    return this.#vapid.publicKey;
  }

  /** client 上报订阅（hub 在 push.subscribe 帧处调用，deviceId 来自连接身份） */
  subscribe(
    deviceId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): { ok: true } | { ok: false; error: string } {
    // endpoint 是 relay 的出站目标：只允许已知推送服务，别让它变成任意地址的 POST 代理
    const check = checkPushEndpoint(sub.endpoint, this.#allowedHosts);
    if (!check.ok) {
      this.#log(`[webpush] 拒绝订阅 ${deviceId}：${check.error}`);
      return check;
    }
    this.#store.upsertPushSubscription(
      { deviceId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      this.#now(),
    );
    this.#log(`[webpush] 设备已订阅 ${deviceId}`);
    return { ok: true };
  }

  /**
   * 页面前后台状态（hub 在 push.visibility 帧处调用）。
   * `hidden` 时不做在线抑制：锁屏/切后台正是要收通知的时候。
   */
  setVisibility(deviceId: string, visible: boolean): void {
    this.#visible.set(deviceId, visible);
  }

  /** client 退订；endpoint 对不上也无妨（幂等，删的是该设备的行） */
  unsubscribe(deviceId: string): void {
    this.#store.removePushSubscription(deviceId);
    this.#log(`[webpush] 设备已退订 ${deviceId}`);
  }

  /** 全量覆盖该设备的会话静音名单（push.mute；轮询会话防骚扰） */
  setMutes(deviceId: string, sessionIds: readonly string[]): void {
    this.#store.setPushMutes(deviceId, sessionIds, this.#now());
    this.#log(`[webpush] 设备静音名单更新 ${deviceId}（${sessionIds.length} 个会话）`);
  }

  /**
   * 一条 a2c relay 帧带 pushHint 时，向**那一帧的收件设备**投一次通知。
   * 同步返回判定结果，真正的 HTTP fire-and-forget——绝不阻塞中转主链路。
   */
  deliverTo(event: {
    machineId: string;
    recipientDeviceId: string;
    sessionId?: string;
    hint: PushHint;
  }): DeliverOutcome {
    if (this.vapidPublicKey === null) return { kind: 'skipped', reason: 'disabled' };

    // 吊销检查放在最前：吊销行还在（没删设备）也不该继续收通知
    if (this.#store.getDevice(event.recipientDeviceId)?.revokedAt != null) {
      return { kind: 'skipped', reason: 'revoked' };
    }

    const sub = this.#store.getPushSubscription(event.recipientDeviceId);
    if (sub === null) return { kind: 'skipped', reason: 'no_subscription' };
    // 库里可能有白名单生效前写入的旧端点，投递前再查一次
    if (!checkPushEndpoint(sub.endpoint, this.#allowedHosts).ok) {
      return { kind: 'skipped', reason: 'untrusted_endpoint' };
    }

    // 在线抑制只在「在线且可见」时生效：锁屏/切后台后 WebSocket 可能半死
    // 到 idleTimeoutMs，那段时间不收通知恰好错过主场景。老客户端不上报
    // 可见性（get 为 undefined）时沿用原行为
    if (this.#isDeviceOnline(event.recipientDeviceId)
      && this.#visible.get(event.recipientDeviceId) !== false) {
      // 在线设备不推也**不记去抖**（与 dispatcher 同款细节：否则人一下线，
      // 本该推的第一条会被抑制期的记录压掉）
      return { kind: 'skipped', reason: 'device_online' };
    }

    // 会话级静音（push.mute）：机器级事件没有 sessionId，不受静音影响
    if (event.sessionId !== undefined
      && this.#store.isPushMuted(event.recipientDeviceId, event.sessionId)) {
      return { kind: 'skipped', reason: 'muted' };
    }

    const key = [
      event.recipientDeviceId, event.machineId, event.sessionId ?? '', event.hint,
    ].join('\u0000');
    const now = this.#now();
    const last = this.#lastSentAt.get(key);
    if (last !== undefined && now - last < this.#dedupeWindowMs) {
      return { kind: 'skipped', reason: 'deduped' };
    }
    // 同一 key 的上一发还在路上：别并发重发（去抖改为成功后回填，
    // 这里补上窗口内重入保护）
    if (this.#inflight.has(key)) return { kind: 'skipped', reason: 'deduped' };

    const message = renderPushMessage(
      { machineId: event.machineId, hint: event.hint, at: now },
      this.#aliases,
    );
    const payload: PushPayload = {
      title: message.title,
      body: message.body,
      tag: pushTag(event, message.group),
      machineId: event.machineId,
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    };

    try {
      const req = generateRequestDetails(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: TTL_BY_HINT[event.hint], urgency: URGENCY_BY_HINT[event.hint] },
      );
      this.#inflight.add(key);
      this.#post(key, event.recipientDeviceId, req.endpoint as string, req.headers as Record<string, string>, req.body as Buffer)
        .catch(() => { /* 错误在 #post 内已处理 */ })
        .finally(() => { this.#inflight.delete(key); });
    } catch (err) {
      this.#log(`[webpush] 构造请求失败：${String((err as Error).message ?? err)}`);
      return { kind: 'failed' };
    }
    return { kind: 'sent' };
  }

  /** 单次投递：5s 超时；4xx 不重试；404/410 = 订阅失效，清掉 */
  async #post(
    key: string,
    deviceId: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<void> {
    try {
      const res = await this.#fetchImpl(url, {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (res.status === 404 || res.status === 410) {
        // 推送服务明确说订阅没了（卸载/权限收回/key 轮换）：清行，别再白发
        this.#store.removePushSubscription(deviceId);
        this.#log(`[webpush] 订阅已失效（${res.status}），清理 ${deviceId}`);
        return;
      }
      if (!res.ok) {
        this.#log(`[webpush] 投递失败 HTTP ${res.status}`);
        return;
      }
      // 只有送达才占用去抖窗口：超时/5xx 不该挡住紧接着的下一条事件
      const now = this.#now();
      this.#lastSentAt.set(key, now);
      if (this.#lastSentAt.size > 256) this.#sweepDedupe(now);
    } catch (err) {
      this.#log(`[webpush] 投递异常：${String((err as Error).message ?? err)}`);
    }
  }

  #sweepDedupe(now: number): void {
    for (const [key, at] of this.#lastSentAt) {
      if (now - at >= this.#dedupeWindowMs) this.#lastSentAt.delete(key);
    }
  }
}
