/**
 * 侧栏底部与移动端列表头的「机器」入口：有机器的引擎可更新时右上角带红点，
 * title / aria-label 写明几台（判断口径见 claude-update.ts 的 engineUpdateHints）。
 */
import { NavLink } from 'react-router';
import { MonitorIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { useTrine } from '@/app/runtime.ts';
import { engineUpdateHints } from './claude-update.ts';

/** 有可更新引擎的机器数 */
export function useMachinesWithUpdates(): number {
  return useTrine((s) => Object.values(s.machines).filter((m) => engineUpdateHints(m.info).length > 0).length);
}

export function MachinesNavButton({ testId }: { testId?: string }): React.JSX.Element {
  const count = useMachinesWithUpdates();
  const label = count > 0 ? `机器（${count} 台有新版本）` : '机器';
  return (
    <Button size="icon-sm" variant="ghost" asChild title={label}>
      <NavLink to="/machines" aria-label={label} data-testid={testId} className="relative">
        <MonitorIcon />
        {count > 0 && (
          <span
            aria-hidden
            data-testid="machines-update-badge"
            className="bg-red ring-background absolute top-1 right-1 size-[7px] rounded-full ring-2"
          />
        )}
      </NavLink>
    </Button>
  );
}
