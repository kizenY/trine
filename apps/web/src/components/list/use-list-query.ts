/**
 * 把分散在三处的列表查询条件拼成一个 `ListQuery`：
 * - 机器过滤、搜索词、状态 chip → Layout context（返回列表不丢，评审 S4）；
 * - 分组开关 → prefs `listGroupBy`（跨会话记住，评审 M7）；
 * - 是否显示临时会话 → prefs `listShowTemp`（同上）；
 * - 归档视图 → 由调用方（路由）决定。
 */
import { useCallback, useMemo } from 'react';
import { useClient, useTrine } from '@/app/runtime.ts';
import { useListFilters, useMachineFilter } from '@/app/Layout.tsx';
import { engineFilterOptions, type EngineOption } from '@/lib/engine-model.ts';
import type { ListGroupBy, ListQuery } from './filtering.ts';

export function useListGroupBy(): readonly [ListGroupBy, (groupBy: ListGroupBy) => void] {
  const groupBy = useTrine((s) => s.prefs.listGroupBy);
  const client = useClient();
  const set = useCallback((next: ListGroupBy) => client?.updatePrefs({ listGroupBy: next }), [client]);
  return [groupBy, set] as const;
}

export function useListShowTemp(): readonly [boolean, (showTemp: boolean) => void] {
  const showTemp = useTrine((s) => s.prefs.listShowTemp);
  const client = useClient();
  const set = useCallback((next: boolean) => client?.updatePrefs({ listShowTemp: next }), [client]);
  return [showTemp, set] as const;
}

/**
 * 引擎筛选。选项是所有机器上引擎的并集，少于两个时为空、不显示。选中的引擎不在选项里
 * （比如那台机器掉线）时按没选处理，免得列表莫名其妙地空着，又找不到筛选入口。
 */
export function useEngineFilter(): {
  engine: string | null;
  setEngine: (engine: string | null) => void;
  options: EngineOption[];
} {
  const machines = useTrine((s) => s.machines);
  const { engine, setEngine } = useListFilters();
  const options = useMemo(() => engineFilterOptions(Object.values(machines).map((m) => m.info)), [machines]);
  return { engine: options.some((o) => o.id === engine) ? engine : null, setEngine, options };
}

export function useListQuery({ archived }: { archived: boolean }): ListQuery {
  const [machine] = useMachineFilter();
  const { search, status } = useListFilters();
  const { engine } = useEngineFilter();
  const [groupBy] = useListGroupBy();
  const [showTemp] = useListShowTemp();
  return useMemo(
    () => ({ machine, archived, showTemp, status, engine, search, groupBy }),
    [machine, archived, showTemp, status, engine, search, groupBy],
  );
}
