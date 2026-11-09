/**
 * trine Web Push service worker（PWA 通知）。
 *
 * 只干两件事，刻意不缓存任何应用资源——中转架构下离线页面也没数据可显示
 * （DECISIONS：没有离线聊天承诺），SW 存在的唯一理由是接收 Web Push。
 *
 * - push：payload 是服务端用 RFC 8291 加密、只有本设备解得开的 JSON
 *   { title, body, tag, machineId?, sessionId? }——文案本身已是脱敏的
 *   （机器标识 + 事件类型），推送服务只见密文。
 * - notificationclick：聚焦已开的窗口并导航到对应会话（深链复用 /s/:m/:s），
 *   没有窗口就新开（iOS 主屏 Web App 从通知唤起走的就是这条路）。
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const d = data && typeof data === 'object' ? data : {};
  event.waitUntil(
    self.registration.showNotification(d.title || 'trine', {
      body: d.body || '',
      // tag 让同一机器的连续提醒合并成一条,不在通知中心堆楼
      tag: d.tag || 'trine',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { machineId: d.machineId, sessionId: d.sessionId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url =
    d.machineId && d.sessionId
      ? `/s/${d.machineId}/${d.sessionId}`
      : d.machineId
        ? `/m/${d.machineId}`
        : '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const win of wins) {
        try {
          await win.focus();
          if ('navigate' in win) await win.navigate(url);
          return;
        } catch {
          // 跨源/未受控的窗口导航不了:换下一个,实在不行新开
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
