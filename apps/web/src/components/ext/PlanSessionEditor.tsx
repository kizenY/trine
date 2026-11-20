/**
 * 执行计划确认框里可编辑的「新建会话并发送」（agent 支持 planEdit 时）：引擎 / 模型 / 推理强度 /
 * 权限模式 / 首条消息。纯逻辑在 plan-edit.ts；危险模式与新建会话 sheet 一样要两击确认。
 */
import { useMemo, useState } from 'react';
import type { EngineSummary } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Chip } from '@/components/shell/StatusDot.tsx';
import { EngineIcon } from '@/components/shell/EngineIcon.tsx';
import { useTrine } from '@/app/runtime.ts';
import { effortOptions } from '@/lib/engine-model.ts';
import { clickEngineMode, clickMode, engineModeWarning, PERMISSION_MODE_OPTIONS, pendingWarning } from '@/components/sheets/permission-mode.ts';
import { cn } from '@/lib/utils.ts';
import { modelChoices, switchEngine, switchModel, type SessionCreateStep, type SessionDraft } from './plan-edit.ts';

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="text-text-3 w-16 shrink-0">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-text-3 mt-1.5 text-[11px]">{children}</div>;
}

export function PlanSessionEditor({
  step,
  draft,
  engines,
  onChange,
}: {
  step: SessionCreateStep;
  draft: SessionDraft;
  /** 这台机器上能新建会话的引擎 */
  engines: readonly EngineSummary[];
  onChange: (next: SessionDraft) => void;
}): React.JSX.Element {
  const knownModels = useTrine((s) => s.prefs.knownModels);
  const defaultModel = useTrine((s) => s.prefs.defaultModel);
  const defaultPermissionMode = useTrine((s) => s.prefs.defaultPermissionMode);
  const engineDefaults = useTrine((s) => s.prefs.engineDefaults);
  const [customModel, setCustomModel] = useState('');
  const engine = engines.find((e) => e.id === draft.engine);
  const models = useMemo(() => modelChoices(engine, knownModels, draft.model), [engine, knownModels, draft.model]);
  const efforts = effortOptions(engine, draft.model);
  const modes = engine?.modes;
  const warning = modes === undefined ? pendingWarning(draft.mode) : engineModeWarning(draft.engineMode, modes);

  const applyCustomModel = (): void => {
    const name = customModel.trim();
    if (name === '') return;
    onChange(switchModel(draft, engine, name));
    setCustomModel('');
  };

  return (
    <div className="border-border flex flex-col gap-1 rounded-xl border p-3" data-testid="plan-session-create" data-editable="true">
      <div className="font-medium">新建会话并发送</div>
      <Row label="目录">{step.cwd}</Row>
      {step.title !== undefined && <Row label="标题">{step.title}</Row>}
      {step.links.length > 0 && <Row label="关联">{step.links.map((l) => l.label).join('、')}</Row>}

      {engines.length > 1 && (
        <>
          <SectionLabel>引擎</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {engines.map((e) => (
              <Chip
                key={e.id}
                data-testid="plan-engine"
                data-engine={e.id}
                selected={draft.engine === e.id}
                onClick={() => onChange(switchEngine(draft, step, e, { defaultModel, defaultPermissionMode, engineDefaults }))}
              >
                <EngineIcon engineId={e.id} className="size-3" />
                {e.displayName}
              </Chip>
            ))}
          </div>
        </>
      )}

      <SectionLabel>模型</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {models.map((m) => (
          <Chip
            key={m.id}
            data-testid="plan-model"
            data-model={m.id}
            selected={draft.model === m.id}
            className="font-mono"
            onClick={() => onChange(switchModel(draft, engine, m.id))}
          >
            {m.label}
          </Chip>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          data-testid="plan-custom-model"
          className="h-7 font-mono text-xs"
          placeholder="自定义模型名"
          value={customModel}
          onChange={(e) => setCustomModel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            applyCustomModel();
          }}
        />
        <Button size="sm" variant="outline" type="button" className="h-7" disabled={customModel.trim() === ''} onClick={applyCustomModel}>
          使用
        </Button>
      </div>

      {efforts !== undefined && (
        <>
          <SectionLabel>推理强度</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            <Chip data-testid="plan-effort" selected={draft.effort === undefined} onClick={() => onChange({ ...draft, effort: undefined })}>
              默认{efforts.defaultEffort === undefined ? '' : ` (${efforts.defaultEffort})`}
            </Chip>
            {efforts.efforts.map((e) => (
              <Chip
                key={e}
                data-testid="plan-effort"
                data-effort={e}
                selected={draft.effort === e}
                className="font-mono"
                onClick={() => onChange({ ...draft, effort: e })}
              >
                {e}
              </Chip>
            ))}
          </div>
        </>
      )}

      <SectionLabel>权限模式</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {modes?.map((mode) => (
          <Chip
            key={mode.id}
            data-testid="plan-mode"
            data-mode={mode.id}
            title={mode.description}
            selected={draft.engineMode.value === mode.id}
            className={cn(draft.engineMode.pending === mode.id && 'border-red bg-red-soft text-red font-medium')}
            onClick={() => onChange({ ...draft, engineMode: clickEngineMode(draft.engineMode, mode.id, modes) })}
          >
            {mode.label}
          </Chip>
        ))}
        {modes === undefined &&
          PERMISSION_MODE_OPTIONS.map((opt) => (
            <Chip
              key={opt.value}
              data-testid="plan-mode"
              data-mode={opt.value}
              selected={draft.mode.value === opt.value}
              className={cn(draft.mode.pending === opt.value && 'border-red bg-red-soft text-red font-medium')}
              onClick={() => onChange({ ...draft, mode: clickMode(draft.mode, opt.value) })}
            >
              {opt.label}
            </Chip>
          ))}
      </div>
      {warning !== '' && (
        <p data-testid="plan-mode-warning" className="text-red text-[11.5px]">
          {warning}
        </p>
      )}

      <SectionLabel>首条消息</SectionLabel>
      <Textarea
        data-testid="plan-prompt"
        className="max-h-64 min-h-24 font-mono text-[12px]"
        value={draft.prompt}
        onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
      />
    </div>
  );
}
