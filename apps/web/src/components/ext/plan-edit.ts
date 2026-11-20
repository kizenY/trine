/**
 * 扩展执行计划确认框里「新建会话并发送」的编辑（ext.action.commit.edits，agent ≥ 0.31.0 的
 * MachineExtensionsSummary.planEdit）：切换引擎 / 模型 / 推理强度 / 权限模式，改首条消息。
 * 纯逻辑，React 胶水在 ExtDialogs.tsx。
 *
 * 初值是计划里 agent 固定下来的值；换引擎时与新建会话 sheet 同一套默认（设置页的新会话默认值），
 * 换回计划原来的引擎则恢复计划里的值。没改动的步骤不发 edit，agent 按原计划执行。
 */
import { CLAUDE_ENGINE_ID, type EngineSummary, type ExtPlanEdit, type ExtPlanStep, type PermissionMode } from '@trine/core';
import { effortOptions, ENGINE_DEFAULT_MODEL, preferredEffort } from '@/lib/engine-model.ts';
import {
  initialEngineMode,
  initialModeState,
  isPermissionMode,
  type EngineModePickerState,
  type ModePickerState,
} from '@/components/sheets/permission-mode.ts';

export type SessionCreateStep = Extract<ExtPlanStep, { type: 'session.create' }>;

export interface SessionDraft {
  prompt: string;
  engine: string;
  model: string;
  /** Claude 的四档权限模式 */
  mode: ModePickerState;
  /** 其他引擎自己的权限模式（EngineSummary.modes） */
  engineMode: EngineModePickerState;
  /** undefined = 跟随引擎配置 */
  effort: string | undefined;
}

/** 换引擎时用的默认值（设置页的新会话默认值） */
export interface DraftDefaults {
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  engineDefaults: Readonly<Record<string, { model?: string | undefined; mode?: string | undefined; effort?: string | undefined }>>;
}

export function initialDraft(step: SessionCreateStep): SessionDraft {
  return {
    prompt: step.prompt,
    engine: step.engine ?? CLAUDE_ENGINE_ID,
    model: step.model,
    mode: initialModeState(isPermissionMode(step.permissionMode) ? step.permissionMode : 'default'),
    engineMode: { value: step.engineMode, pending: null },
    effort: step.effort,
  };
}

/** 换引擎：其他引擎的模型名、模式在这里没有意义，换成那个引擎的默认；换回原来的引擎恢复计划里的值 */
export function switchEngine(draft: SessionDraft, step: SessionCreateStep, engine: EngineSummary, defaults: DraftDefaults): SessionDraft {
  if (engine.id === draft.engine) return draft;
  if (engine.id === (step.engine ?? CLAUDE_ENGINE_ID)) return { ...initialDraft(step), prompt: draft.prompt };
  if (engine.modes === undefined) {
    return {
      ...draft,
      engine: engine.id,
      model: defaults.defaultModel,
      mode: initialModeState(defaults.defaultPermissionMode),
      engineMode: { value: undefined, pending: null },
      effort: undefined,
    };
  }
  const saved = defaults.engineDefaults[engine.id];
  const model = saved?.model ?? ENGINE_DEFAULT_MODEL;
  return {
    ...draft,
    // 另一个引擎的待确认点击作废（它的控件已经不显示了）
    mode: { value: draft.mode.value, pending: null },
    engine: engine.id,
    model,
    engineMode: { value: initialEngineMode(engine.modes, saved?.mode), pending: null },
    effort: preferredEffort(engine, model, saved?.effort),
  };
}

/** 换模型：强度不在新模型的选项里就回到跟随配置 */
export function switchModel(draft: SessionDraft, engine: EngineSummary | undefined, model: string): SessionDraft {
  const keep = draft.effort !== undefined && effortOptions(engine, model)?.efforts.includes(draft.effort) === true;
  return { ...draft, model, effort: keep ? draft.effort : undefined };
}

/** 模型候选：有目录的引擎用目录（含「跟随配置」），否则用本设备的已知模型；当前值总在里面 */
export function modelChoices(engine: EngineSummary | undefined, knownModels: readonly string[], current: string): { id: string; label: string }[] {
  const labels = new Map<string, string>();
  if (engine?.modes !== undefined) {
    labels.set(ENGINE_DEFAULT_MODEL, '跟随配置');
    for (const m of engine.models ?? []) labels.set(m.id, m.label);
  } else {
    for (const m of knownModels) labels.set(m, m);
  }
  if (current !== '' && !labels.has(current)) labels.set(current, current);
  return [...labels].map(([id, label]) => ({ id, label }));
}

/** 当前引擎还有待二次确认的危险模式、或首条消息为空：不能确认 */
export function draftBlocked(draft: SessionDraft): string | null {
  if (draft.prompt.trim() === '') return '首条消息不能为空';
  const pending = draft.engine === CLAUDE_ENGINE_ID ? draft.mode.pending : draft.engineMode.pending;
  if (pending !== null) return '请再点一次确认所选的权限模式';
  return null;
}

/**
 * 草稿 → commit 的 edit；和计划一样时为 undefined（不发）。
 * 引擎配置改了就把整套配置一起发（agent 要求换引擎时带模型），首条消息改了才带 prompt。
 */
export function draftToEdit(index: number, step: SessionCreateStep, draft: SessionDraft, engine: EngineSummary | undefined): ExtPlanEdit | undefined {
  const base = initialDraft(step);
  const promptChanged = draft.prompt !== base.prompt;
  const isClaude = draft.engine === CLAUDE_ENGINE_ID;
  const effort = draft.effort !== undefined && effortOptions(engine, draft.model)?.efforts.includes(draft.effort) === true ? draft.effort : undefined;
  const configChanged =
    draft.engine !== base.engine ||
    draft.model !== base.model ||
    effort !== base.effort ||
    (isClaude ? draft.mode.value !== base.mode.value : draft.engineMode.value !== base.engineMode.value);
  if (!promptChanged && !configChanged) return undefined;
  return {
    step: index,
    ...(promptChanged ? { prompt: draft.prompt } : {}),
    ...(configChanged
      ? {
          engine: draft.engine,
          model: draft.model,
          ...(isClaude ? { permissionMode: draft.mode.value } : {}),
          ...(!isClaude && draft.engineMode.value !== undefined ? { engineMode: draft.engineMode.value } : {}),
          effort: effort ?? null,
        }
      : {}),
  };
}
