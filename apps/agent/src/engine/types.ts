/**
 * 引擎抽象（multi-engine，DECISIONS D20）。
 *
 * 「引擎」指真正跑模型的编码 agent（Claude Code、Codex）；agent 在 trine 里已指机器上的
 * 守护进程。router、manager 只依赖这里的接口，不依赖某个引擎的 SDK。
 */
import type { PermissionMode, RewindMode, SessionState, BgTask, ContextUsage } from '@trine/core';
import type { RewindDone, RewindFailure, RewindPreview } from '../app/rewind.ts';
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
  /** 用户选的推理强度；不支持的引擎不实现 */
  readonly effort?: string | undefined;
  readonly permissions: { snapshot(): readonly PendingPermissionSnapshot[] };

  meta(): SessionRuntimeMeta;
  bgTasks(): BgTask[];
  send(clientMsgId: string, text: string, prepared?: PreparedInput): { duplicate: boolean; uuid?: string };
  recall(clientMsgId: string): boolean;
  respondPermission(verdict: PermissionVerdict): boolean;
  stop(): Promise<void>;
  /** engineMode：非 Claude 引擎自己的权限模式（SessionMeta.engineMode），有就以它为准 */
  setPermissionMode(mode: PermissionMode, engineMode?: string): Promise<void>;
  setModel(model: string): Promise<void>;
  /** 改推理强度，省略 = 回到模型的默认强度；不支持的引擎不实现 */
  setEffort?(effort: string | undefined): Promise<void>;
  stopBgTask(taskId: string): Promise<StopBgTaskResult>;
  close(reason?: string, drainTimeoutMs?: number): Promise<void>;
  /** 订阅限额（账号级，有活跃进程时顺带取）；不支持的引擎不实现 */
  planUsage?(): Promise<unknown> | undefined;
  /** 不重开会话就能换目录的引擎实现它（下一轮生效）；不实现 = 释放后重新 acquire */
  setCwd?(cwd: string): void;
  /** 立即刷新 context 用量；不支持的引擎不实现 */
  refreshContextNow?(): Promise<ContextUsage>;
}

/** 回退需要的额外操作，靠文件检查点 + 转录截断实现（Claude） */
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

/** 引擎自己就能回退对话，定位和执行都由它做（Codex 的 thread/revert） */
export interface ThreadRewindSession extends EngineSession {
  previewThreadRewind(targetMessageId: string): Promise<RewindPreview | RewindFailure>;
  rewindThread(targetMessageId: string, mode: RewindMode): Promise<RewindDone | RewindFailure>;
}

export function isThreadRewindable(session: EngineSession): session is ThreadRewindSession {
  return typeof (session as Partial<ThreadRewindSession>).rewindThread === 'function';
}
