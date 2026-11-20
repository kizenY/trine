/**
 * 引擎卡里的「自动更新」开关（engine-auto-update，agent ≥ 0.31.0：EngineSummary.autoUpdate 有无即能力探测）。
 * 开关存在 agent 上，所有设备同步：这里只发请求，显示的状态以 machine.info 为准（发出后到回来之间显示为切换中）。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import type { EngineAutoUpdate } from '@trine/core';
import { Switch } from '@/components/ui/switch.tsx';
import type { EngineAutoUpdateResult } from '@/lib/client.ts';
import { formatRelativeTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';

/** 最近一次自动更新的一句话；没有为 null */
export function autoUpdateLastLine(last: EngineAutoUpdate['last'], now: number): string | null {
  if (last === undefined) return null;
  const when = formatRelativeTime(last.at, now);
  if (!last.ok) return `${when}自动更新失败：${last.error ?? '未知原因'}`;
  if (last.fromVersion === last.toVersion) return `${when}自动更新：仍是 ${last.toVersion}`;
  return `${when}自动更新：${last.fromVersion} → ${last.toVersion}`;
}

export function EngineAutoUpdateToggle({
  idPrefix,
  engineName,
  machineName,
  online,
  state,
  set,
  now = Date.now(),
}: {
  idPrefix: string;
  engineName: string;
  machineName: string;
  online: boolean | null;
  state: EngineAutoUpdate;
  set: (enabled: boolean) => Promise<EngineAutoUpdateResult>;
  now?: number;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const change = (enabled: boolean): void => {
    setSaving(true);
    void set(enabled)
      .then(
        (res) => {
          if (!res.ok) toast.error(`${machineName}：自动更新设置失败：${res.error?.message ?? '未知原因'}`);
          else if (enabled) toast.success(`${machineName}：已打开 ${engineName} 自动更新，正在检查新版本`);
        },
        (err: unknown) => toast.error(`${machineName}：自动更新设置失败：${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setSaving(false));
  };
  const last = autoUpdateLastLine(state.last, now);
  return (
    <div className="flex flex-col gap-0.5 text-xs" data-testid={`${idPrefix}-auto-update`}>
      <label className="flex w-fit cursor-pointer items-center gap-2">
        <Switch
          size="sm"
          data-testid={`${idPrefix}-auto-update-switch`}
          checked={state.enabled}
          disabled={saving || online === false}
          onCheckedChange={change}
        />
        <span>自动更新</span>
      </label>
      <p className="text-text-3">
        {state.enabled ? '查到新版本（每 6 小时或手动检查）就自动更新，不打断运行中的会话。' : '关闭时只提示有新版本，由你手动更新。'}
      </p>
      {last !== null && (
        <p data-testid={`${idPrefix}-auto-update-last`} className={cn(state.last?.ok === false ? 'text-red' : 'text-text-3')}>
          {last}
        </p>
      )}
    </div>
  );
}
