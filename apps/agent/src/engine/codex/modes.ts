/**
 * Codex 的权限模式：approvalPolicy + sandbox 的组合。
 *
 * `permissionMode` 是给旧 client 看的近似值，见 SessionMeta.engineMode。
 */
import type { EngineMode, PermissionMode } from '@trine/core';

export type CodexModeId = 'read-only' | 'workspace' | 'full';

export const DEFAULT_CODEX_MODE: CodexModeId = 'full';

export const CODEX_MODES: EngineMode[] = [
  { id: 'read-only', label: '只读', description: '不能改文件，越界操作要批准' },
  { id: 'workspace', label: '工作区', description: '可改工作目录，越界操作要批准' },
  {
    id: 'full',
    label: '完全访问',
    description: '不再询问，也不受沙箱限制，可以读写这台机器上的任何文件',
    dangerous: true,
    default: true,
  },
];

export function isCodexMode(value: string | undefined): value is CodexModeId {
  return value === 'read-only' || value === 'workspace' || value === 'full';
}

export function modeFromLegacy(mode: PermissionMode): CodexModeId {
  if (mode === 'bypassPermissions') return 'full';
  if (mode === 'plan') return 'read-only';
  return 'workspace';
}

export function legacyFromMode(mode: CodexModeId | undefined): PermissionMode {
  if (mode === 'full') return 'bypassPermissions';
  if (mode === 'read-only') return 'plan';
  return 'default';
}

/** thread/start、thread/resume 的参数（sandbox 是枚举） */
export function threadModeParams(mode: CodexModeId): Record<string, unknown> {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'workspace':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'full':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
}

/** turn/start 的参数（sandboxPolicy 是对象）；可按轮切换 */
export function turnModeParams(mode: CodexModeId): Record<string, unknown> {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
    case 'workspace':
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case 'full':
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
  }
}

/** thread/resume 响应 → 模式；对不上任何一档（用户自己配的组合）返回 undefined */
export function modeFromThreadResponse(response: unknown): CodexModeId | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const r = response as { approvalPolicy?: unknown; sandbox?: unknown };
  const policy = r.sandbox as
    | { type?: unknown; writableRoots?: unknown; networkAccess?: unknown; excludeSlashTmp?: unknown; excludeTmpdirEnvVar?: unknown }
    | null
    | undefined;
  const sandbox = policy?.type;
  if (r.approvalPolicy === 'never' && sandbox === 'dangerFullAccess') return 'full';
  if (r.approvalPolicy === 'on-request' && sandbox === 'workspaceWrite') {
    // 自定义过的工作区沙箱不是这一档，不能说成「工作区」
    const roots = policy?.writableRoots;
    const custom =
      (Array.isArray(roots) && roots.length > 0) ||
      policy?.networkAccess === true ||
      policy?.excludeSlashTmp === true ||
      policy?.excludeTmpdirEnvVar === true;
    return custom ? undefined : 'workspace';
  }
  if (r.approvalPolicy === 'on-request' && sandbox === 'readOnly') return 'read-only';
  return undefined;
}
