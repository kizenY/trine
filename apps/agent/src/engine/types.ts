/**
 * 引擎抽象（multi-engine，DECISIONS D20）。
 *
 * 「引擎」指真正跑模型的编码 agent（Claude Code、Codex）；agent 在 trine 里已指机器上的
 * 守护进程。router、manager 只依赖这里的接口，不依赖某个引擎的 SDK。
 */
import type { PermissionMode, SessionState, BgTask, ContextUsage } from '@trine/core';
import type { PreparedInput } from '../bridge/attachments.ts';
import type { PendingPermissionSnapshot, PermissionVerdict } from '../bridge/permission.ts';
import type {
  ClaudeSession,
  SessionRuntimeMeta,
  StopBgTaskResult,
} from '../bridge/session.ts';

/** 一个活跃会话：所有引擎都要提供的操作 */
export interface EngineSession {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly costUsd: number;
  readonly lastActivityAt: number;
  readonly queueLength: number;
  /** 会话当前占着底层进程 / 已加载的 thread（占一个活跃名额） */
  readonly hasProcess: boolean;
  readonly bgRunningCount: number;
  readonly permissionMode: PermissionMode;
  readonly permissions: { snapshot(): readonly PendingPermissionSnapshot[] };

  meta(): SessionRuntimeMeta;
  bgTasks(): BgTask[];
  send(clientMsgId: string, text: string, prepared?: PreparedInput): { duplicate: boolean; uuid?: string };
  recall(clientMsgId: string): boolean;
  respondPermission(verdict: PermissionVerdict): boolean;
  stop(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  stopBgTask(taskId: string): Promise<StopBgTaskResult>;
  close(reason?: string, drainTimeoutMs?: number): Promise<void>;
  /** 订阅限额（账号级，有活跃进程时顺带取）；不支持的引擎不实现 */
  planUsage?(): Promise<unknown> | undefined;
  /** 立即刷新 context 用量；不支持的引擎不实现 */
  refreshContextNow?(): Promise<ContextUsage>;
}

/** 回退需要的额外操作（目前只有 Claude：文件检查点 + 对话截断） */
export type RewindableSession = EngineSession &
  Pick<
    ClaudeSession,
    | 'userMessageUuid'
    | 'clientMsgIdOf'
    | 'pendingRewind'
    | 'rewindBlocker'
    | 'previewFiles'
    | 'restoreFiles'
    | 'rewindConversation'
  >;

export function isRewindable(session: EngineSession): session is RewindableSession {
  return typeof (session as Partial<RewindableSession>).rewindBlocker === 'function';
}
