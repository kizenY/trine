/**
 * Web Push 订阅流程（浏览器侧）。
 *
 * 协议帧（push.subscribe / push.config / push.subscribed）见 core transport.ts；
 * 这里只管浏览器 API 的编排：注册 SW → 请求通知权限 → pushManager.subscribe
 * （用服务端下发的 VAPID 公钥）→ 把订阅上报给服务端。
 *
 * ## iOS 前提
 *
 * iOS 16.4+ 且从 Safari「添加到主屏幕」安装的 Web App 才有推送权限；
 * Safari 页签里打开永远 `Notification` 未定义——`pushSupported()` 会如实
 * 返回 false，设置页据此隐藏开关而不是给一个点了必失败的按钮。
 *
 * ## 订阅再上报（boot re-sync）
 *
 * 浏览器可能轮换 subscription（系统升级、权限重授），服务端也可能换库；
 * 每次启动若本地开关是开的，就把**当前**订阅重报一遍（服务端按设备覆盖
 * 存储，幂等），漂移自动收敛。
 */
import type { TrineClient } from './client.ts';

const SW_URL = '/sw.js';
const ENABLED_KEY = 'trine.push.enabled';

/** base64url → Uint8Array（applicationServerKey 要 BufferSource） */
function urlBase64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bytesToUrlBase64(buf: ArrayBuffer | null): string | null {
  if (buf === null) return null;
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

/** 本地开关是否开着（真实状态以权限+订阅为准，这里只是「用户想要」） */
export function pushWanted(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

async function ensureSW(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(SW_URL);
}

export type PushToggleResult =
  | { ok: true }
  | { ok: false; error: string };

/** 打开通知：权限 → 订阅 → 上报。失败时把本地开关还原为关。 */
export async function enablePush(client: TrineClient | null): Promise<PushToggleResult> {
  if (!pushSupported()) {
    return { ok: false, error: '此浏览器或系统不支持推送（iOS 需 16.4+ 并从 Safari 添加到主屏幕）' };
  }
  if (!client) return { ok: false, error: '未连接' };

  const vapid = client.pushVapidKey;
  if (!vapid) return { ok: false, error: '还没收到服务端推送配置，连上后重试' };

  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      return { ok: false, error: '系统通知权限未授予（系统设置里可改）' };
    }
  }

  try {
    const reg = await ensureSW();
    let sub = await reg.pushManager.getSubscription();
    const want = urlBase64ToBytes(vapid);
    // lib.dom 的 PushSubscription 类型没跟上 applicationServerKey（新字段），取值时拓宽
    const appKey = (sub as { applicationServerKey?: ArrayBuffer | null } | null)
      ?.applicationServerKey ?? null;
    const have = sub ? bytesToUrlBase64(appKey) : null;
    if (sub && have !== vapid) {
      // VAPID 公钥变了（服务端换库重建）：旧订阅解不开新密文，重订
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, error: '订阅数据不完整' };
    }
    const sent = client.subscribePush({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
    if (!sent) return { ok: false, error: '未连接，稍后重试' };
    try {
      localStorage.setItem(ENABLED_KEY, '1');
    } catch { /* 隐私模式存不了也没关系,本次会话内仍然有效 */ }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `订阅失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 关闭通知：上报退订 → 浏览器侧退订 → 清本地开关 */
export async function disablePush(client: TrineClient | null): Promise<void> {
  if (!pushSupported()) {
    try {
      localStorage.removeItem(ENABLED_KEY);
    } catch { /* 同上 */ }
    return;
  }
  try {
    const reg = await ensureSW();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      if (client) client.unsubscribePush(sub.endpoint);
      await sub.unsubscribe();
    }
  } catch {
    // SW 注册失败等场景:开关照关,下次打开会重走完整流程
  }
  try {
    localStorage.removeItem(ENABLED_KEY);
  } catch { /* 同上 */ }
}

/** 启动时的再上报：开关开着就把当前订阅重报一遍（幂等,收敛两端漂移） */
export async function resyncPushOnBoot(client: TrineClient): Promise<void> {
  if (!pushSupported() || !pushWanted() || Notification.permission !== 'granted') return;
  try {
    const reg = await ensureSW();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return; // 订阅丢了:等用户下次手动开,别替他弹权限框
    const json = sub.toJSON();
    if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
      client.subscribePush({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
    }
  } catch {
    // 推送是旁路,启动重报失败不值得打扰任何人
  }
}
