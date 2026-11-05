/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * There are two independent concurrency pools, never one:
 *
 * - Background (`maxConcurrent`, default 10) bounds detached agents.
 * - Foreground (`maxConcurrentForeground`, default 0 = unlimited) bounds
 *   agents a caller is blocking on inline — `spawnAndWait`.
 *
 * Independent by design: a foreground agent blocks the parent anyway, so
 * charging it to the background pool would let a saturated pool starve the main
 * session of work it could have done itself. Excess agents in either pool are
 * queued and auto-started as slots free up. Nested children take no slot in
 * either — see `occupiesPoolSlot` / `occupiesForegroundSlot`.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { GuardBridgeHost, type GuardBridgeRegistration, GuardBridgeRejection, type GuardBridgeRejectionCode, type GuardChildContext, type GuardChildScopeRefStatus, type GuardEffectDescription, type GuardEffectRequest, type GuardEntryPathId, type GuardIngressEvidence, type GuardIngressInput, type GuardOrigin, isForkReadOnlyGitCommand, type PreparedGuardChildInjection, withGuardChildInjectionTimeout, withGuardScheduleFireTimeout } from "./guard-bridge.js";
import { assignHandle, handleBase } from "./mention.js";
import { describeModel } from "./model-resolver.js";
import type { AgentInvocation, AgentRecord, AgentTombstone, IsolationMode, MentionResolution, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import type { CompiledSchema } from "./workflow/json-schema.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, type WorktreeCleanupResult, type WorktreeEffectHooks } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end`, for EVERY agent this manager owns —
 * top-level and nested alike, spawns and resumes. The one place where each
 * message is seen exactly once: `AgentRecord.lifetimeUsage` is deliberately
 * double-booked into ancestors (see `nested-tools.ts`) so a hidden child's spend
 * shows up on the record a human can see, which makes those records useless as
 * a basis for anything that must not count a message twice — parent-session
 * accounting above all.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/**
 * Default max concurrent background agents.
 *
 * Raised from 4 when top-level spawns started defaulting to background
 * (`backgroundByDefault`): foreground agents bypass this pool entirely, so
 * while foreground was the default a fan-out of six ran six. With background
 * as the default every top-level agent takes a slot, and a limit of 4 would
 * have silently queued the tail of exactly the parallel fan-outs the `Agent`
 * tool description tells the model to send.
 */
const DEFAULT_MAX_CONCURRENT = 10;

/**
 * Default max concurrent foreground (blocking) agents — `0` = unlimited, the
 * extension's existing convention for "no ceiling" (`defaultMaxTurns`).
 *
 * Off by default because nothing here ever bounded foreground work, and pi
 * dispatches a message's tool calls through `Promise.all`, so an unqualified
 * fan-out of blocking `Agent` calls has always run all at once. Users who want
 * it bounded — chiefly local models, where parallel agents thrash the prompt
 * cache (#253) — opt in; everyone else keeps today's behaviour exactly.
 */
const DEFAULT_MAX_CONCURRENT_FOREGROUND = 0;

/**
 * How many evicted agents stay addressable by name. Only a bound on memory —
 * a session that spawns hundreds of agents shouldn't retain every one — and
 * far above the handful anyone keeps in their head.
 */
const MAX_TOMBSTONES = 100;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(
  record: Pick<AgentRecord, "isBackground" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.isBackground && isTopLevelAgent(record);
}

/**
 * Whether a record is one of the session's own agents, rather than something
 * another agent or a workflow owns.
 *
 * The single definition behind every user-facing surface — the fleet list, the
 * widget, the `/agents` menus, `@handle` resolution, and the completion events
 * and session entries. An owned child reports through its owner, so surfacing
 * it separately would double-count the same work in the places a person reads.
 */
export function isTopLevelAgent(
  record: Pick<AgentRecord, "parentAgentId" | "workflowId">,
): boolean {
  return record.parentAgentId === undefined && record.workflowId === undefined;
}

/**
 * Whether a record occupies one of the `maxConcurrentForeground` slots.
 *
 * Keyed on `blocking` — a caller awaiting this record inline — rather than on
 * `isBackground === false`, because `spawn()` is also the funnel for DETACHED
 * starts (cross-extension RPC, `@handle` mentions, the registry) that may pass
 * `isBackground: false` and are documented to run immediately regardless. Those
 * block nobody, so bounding them buys nothing and would park a record with no
 * one waiting to release it.
 *
 * Nested children are excluded for the same reason as `occupiesPoolSlot`, and
 * more sharply: their parent is blocked *awaiting them*, so queueing a child
 * behind its own parent is a guaranteed deadlock rather than a possible one.
 * Enforced here rather than at the call site so no caller can reintroduce it.
 *
 * A workflow's children go out through `spawnAndWait` and so are `blocking`
 * too, and are excluded on the same `isTopLevelAgent` test as the background
 * pool: the run already caps how many of its agents run at once, and charging
 * them here as well would let one fan-out queue behind a limit meant for the
 * session's own work.
 *
 * Like the background pool this bounds width at the top level only — a parent's
 * own fan-out is limited by nothing but its turn budget.
 */
function occupiesForegroundSlot(
  record: Pick<AgentRecord, "blocking" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.blocking && isTopLevelAgent(record);
}

/** Which concurrency pool a spawn is charged to, if any. */
type Pool = "background" | "foreground";

/** Additive external manager-registry spawn options. Scope references are hints, never grants. */
export interface ManagerRegistrySpawnOptions {
  scopeRef?: string;
  [key: string]: unknown;
}


interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

const INTERNAL_SCHEDULED_SPAWN = Symbol("pi-subagents.internal-scheduled-spawn");

interface SpawnOptions {
  [INTERNAL_SCHEDULED_SPAWN]?: object;
  description: string;
  /** Diagnostic entry point; defaults to the manager method. */
  guardEntryPath?: GuardEntryPathId;
  /** Retained frozen registration identity forwarded to child construction. */
  guardBridgeRegistration?: GuardBridgeRegistration;
  guardRegistrationSnapshot?: object;
  /** Evidence captured at the outermost ingress for this child operation. */
  guardIngressEvidence?: GuardIngressEvidence;
  /** Parent context for an ephemeral child-run that has no manager record. */
  guardParentContext?: GuardChildContext;
  /** Optional external scope reference; absence remains explicitly unresolved. */
  /** Retained schedule ingress correlation; used only by the scheduler fire adapter. */
  guardIngressId?: string;
  guardOrigin?: GuardOrigin;

  scopeRef?: string;
  /** Scheduled-scope resolution is explicit and never inferred from disk fields. */
  guardScopeRefStatus?: GuardChildScopeRefStatus;
  scheduled?: { jobId: string; runIndex: number; expiresAt: string };

  /**
   * Optional memorable name for this instance, becoming a second handle
   * (`@auth-audit`) alongside the type-derived one. Slugged, not validated —
   * anything unusable degrades via `handleBase` rather than failing the spawn.
   */
  name?: string;
  /**
   * Reopen this pi session file instead of starting a fresh conversation, so a
   * mention of an evicted agent continues where it left off. The agent's
   * definition is still resolved from its type, so the continuation runs under
   * the type's CURRENT config.
   */
  resumeSessionFile?: string;
  /**
   * Take an evicted agent's names back verbatim instead of allocating fresh
   * ones, so a resumed conversation keeps the handle the user just typed —
   * `handleBase(type)` cannot reproduce a numbered `explore-2`. Safe without an
   * `assignHandle` pass because tombstoned names are excluded from allocation
   * (`takenHandles`), so nothing live can be holding them.
   *
   * Internal capability, like `resumeSessionFile`: a forged handle would
   * duplicate a live agent's name and make `resolveMention` ambiguous, so
   * `spawnTopLevel` strips it from anything a caller sends.
   */
  reclaim?: { handle: string; alias?: string };
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip whichever pool's queue check applies to this spawn — start immediately
   * even if the configured concurrency limit would otherwise queue it. The slot
   * is still COUNTED once the run starts, so a bypassing spawn transiently
   * exceeds the limit rather than being invisible to it.
   *
   * Used by the scheduler, so a fired job can't be deferred past its trigger
   * window, and by the `/agents` agent-file generator, which has no way to
   * cancel a wait (see its call site).
   */
  bypassQueue?: boolean;
  /**
   * A caller is awaiting this record inline (`spawnAndWait`) — what
   * `maxConcurrentForeground` bounds. Set only by `spawnAndWait`; stripped from
   * caller-supplied options by `spawnTopLevel`, since a forged `blocking` would
   * defer a detached start behind a queue its caller cannot see or release.
   */
  blocking?: boolean;
  /**
   * The workflow run this child belongs to, when a workflow spawned it.
   *
   * Ownership, not decoration. A workflow's children are the workflow's — they
   * report through its card, its notification and its dialog, so they are
   * filtered out of every top-level surface exactly as nested children are, and
   * they take no `maxConcurrent` slot: the run has its own concurrency cap, and
   * counting them twice would let one workflow starve the whole session.
   */
  workflowId?: string;
  /**
   * Make the child report through a `StructuredOutput` tool built from this
   * compiled schema. Set only by the workflow host, for `agent({ schema })`.
   */
  structuredOutput?: CompiledSchema;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /**
   * Last chance to look at an isolated agent's worktree, awaited immediately
   * before it is committed to a branch and removed.
   *
   * Exists because that removal happens inside the settle path, before
   * `spawnAndWait` resolves: by the time a caller has the finished record, the
   * directory the child actually wrote in is gone. Anything that must inspect
   * or verify that tree — a workflow `gate` is the motivating case — has to run
   * here or it silently inspects the main tree instead.
   *
   * Fires only on the normal settle path, and only when a worktree was created.
   * Not on the error path and not on the stop-during-copy guard: those are
   * already failing, and delaying cleanup there would leak a copy for no gain.
   * A rejection is swallowed — the hook can never keep the worktree alive.
   */
  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /**
   * Called synchronously once the record is in the map and its promise is set,
   * before `onSessionCreated` fires — where callers attach the output file.
   *
   * Carried on the options rather than parked on the manager for the duration
   * of a spawn: with a foreground queue, `startAgent` can run at drain time,
   * long after any such field would have been restored, and the callback would
   * silently never fire (or fire into an unrelated caller's closure).
   */
  onSpawned?: (id: string) => void;
  /**
   * Called synchronously when the spawn is queued instead of started, with how
   * many entries in its own pool are ahead of it. The foreground UI uses it to
   * say so while it waits; nothing else needs it.
   */
  onQueued?: (id: string, ahead: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
}

interface ResumeOptions {
  /** Diagnostic entry point; defaults to the manager method. */
  guardEntryPath?: GuardEntryPathId;
  /** Retained frozen registration identity forwarded to resumeAgent. */
  guardBridgeRegistration?: GuardBridgeRegistration;
  guardRegistrationSnapshot?: object;
  guardParentContext?: GuardChildContext;

  guardIngressEvidence?: GuardIngressEvidence;
  scopeRef?: string;

  /**
   * Run the resumed turn detached in the background: return immediately with
   * the record still "running" (or "queued" at the concurrency limit) and
   * notify on completion via onComplete, exactly like a background spawn.
   * Default (false/undefined) runs the resume inline and returns the settled
   * record — the historical behavior.
   */
  isBackground?: boolean;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /**
   * Background resume only: called synchronously when the run actually starts —
   * immediately, or later from drainQueue. Callers wire per-run side effects
   * (output-file streaming) here rather than at the call site, so a resume that
   * is stopped while still queued never leaves a subscription behind: `abort()`
   * drops a queued record without reaching `settle()`, which is what would have
   * torn that subscription down.
   */
  onStarted?: () => void;
}

/** Best-effort ceiling on one child's shutdown handlers, so teardown can't strand a quit. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * Close the extension lifecycle `runAgent` opened with `bindExtensions`, then dispose.
 *
 * `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()` — pi emits the event
 * itself in `AgentSessionRuntime.dispose()` beforehand, and this is the one place that binds
 * extensions onto a session without going through that path. Without the emit, everything an
 * extension armed in `session_start` leaks once per spawn, and its next tick throws
 * `assertActive()` from a bare timer callback — an uncaughtException that kills pi (#242).
 */
export async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    // Optional all the way down: on a pi without the getter, or a stubbed session from a
    // partial `onSessionCreated`, skip the emit — the same degrade as before this fix.
    if (runner?.hasHandlers?.("session_shutdown")) {
      // Raced, not awaited outright. `emit` runs every handler serially with no timeout of
      // its own, and dispose() is reached from pi's own `session_shutdown` with the TUI
      // already torn down — one hung handler would leave a dead terminal.
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>(resolve => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS).unref()),
      ]);
    }
  } catch { /* a partial session must degrade, not take the teardown down with it */ }
  // Always, even on timeout: disposal is what this function ultimately exists to do.
  try { session?.dispose?.(); } catch { /* ignore */ }
}

function guardOriginForEntryPath(entryPath: GuardEntryPathId): GuardOrigin {
  if (entryPath.startsWith("mention.") || entryPath.startsWith("conversation-viewer.") || entryPath.startsWith("fleet-viewer.") || entryPath === "agents-command.generate-definition") return "human";
  if (entryPath === "cross-extension-rpc.spawn" || entryPath === "manager-registry.spawn") return "extension-request";
  if (entryPath === "agent-runner.turn-limit-steer") return "package-system-control";
  if (entryPath === "scheduled-task.fire") return "package-system-control";
  return "parent-model-delegation";
}

function childContextFailure(entryPath: GuardEntryPathId): GuardBridgeRejection {
  return new GuardBridgeRejection(
    "guard-child-context-failed",
    entryPath,
    `guard-child-context-failed: guarded work is unavailable at ${entryPath}; child context callback failed validation; child dispatch was stopped.`,
  );
}

function childInjectionFailure(entryPath: GuardEntryPathId): GuardBridgeRejection {
  return new GuardBridgeRejection(
    "guard-child-injection-failed",
    entryPath,
    `guard-child-injection-failed: guarded work is unavailable at ${entryPath}; child guard injection could not be prepared.`,
  );
}


type AbortRace<T> = { aborted: true } | { aborted: false; value: T };

/** Observe callback rejection even when abort wins, while ignoring any late value. */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<AbortRace<T>> {
  const observed = Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ aborted: true });
    };
    observed.then(
      value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ aborted: false, value });
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}


export class AgentManager {
  /** Direct-reference registration state shared by manager entry paths. */
  readonly guardBridgeHost = new GuardBridgeHost();

  registerGuard(registration: unknown): { compatible: boolean; registrationRejected?: string; reasonCode?: GuardBridgeRejectionCode } {
    return this.guardBridgeHost.register(registration);
  }

  rejectGuardRegistration(reason: string): { compatible: false; registrationRejected: string; reasonCode?: GuardBridgeRejectionCode } {
    return this.guardBridgeHost.rejectRegistration(reason);
  }

  unregisterGuard(): void {
    this.guardBridgeHost.unregister();
  }

  setGuardExpected(expected: boolean): void {
    this.guardBridgeHost.setGuardExpected(expected);
  }

  setGuardExpectedDiagnostic(diagnostic: string | undefined): void {
    this.guardBridgeHost.setGuardExpectedDiagnostic(diagnostic);
  }

  setGuardRegistrant(registrant: string | undefined): void {
    this.guardBridgeHost.setGuardRegistrant(registrant);
  }

  setGuardRegistrantDiagnostic(diagnostic: string | undefined): void {
    this.guardBridgeHost.setGuardRegistrantDiagnostic(diagnostic);
  }

  setHeadless(headless: boolean): void {
    this.headless = headless;
  }


  assertGuard(entryPath: GuardEntryPathId): GuardBridgeRegistration | undefined {
    return this.guardBridgeHost.assertGuard(entryPath);
  }

  /** Capture the exact registration identity used by a process boundary. */
  getGuardEffectSnapshot(childId?: string): object | undefined {
    if (!this.guardBridgeHost.guardExpected) return undefined;
    if (childId !== undefined) {
      const record = this.agents.get(childId);
      return record ? this.guardEffectSnapshots.get(record) : undefined;
    }
    return this.guardBridgeHost.getResourceEnrollmentSnapshotIdentity();
  }

  /** Synchronous last check immediately before a guarded process is started. */
  assertGuardEffectSnapshotActive(snapshot: object | undefined, entryPath: GuardEntryPathId): void {
    if (!this.guardBridgeHost.guardExpected) return;
    try {
      this.guardBridgeHost.assertRegistrationSnapshotActive(snapshot, entryPath);
    } catch {
      throw new GuardBridgeRejection(
        "guard-effect-unavailable", entryPath,
        `guard-effect-unavailable: guarded work is unavailable at ${entryPath}; the validated registration changed before execution.`,
      );
    }
  }

  /** Review one concrete process effect using the registration captured for its child. */
  async reviewGuardEffect(
    effect: GuardEffectDescription,
    options: { entryPath: GuardEntryPathId; childId?: string; ingressId?: string; snapshot?: object; signal?: AbortSignal; childContext?: GuardChildContext; workflowId?: string },
  ): Promise<void> {
    if (!this.guardBridgeHost.guardExpected) return;
    const record = options.childId ? this.agents.get(options.childId) : undefined;
    const snapshot = options.snapshot ?? (record ? this.guardEffectSnapshots.get(record) : this.guardBridgeHost.getResourceEnrollmentSnapshotIdentity());
    if (options.childId && !options.snapshot && !record) {
      this.guardBridgeHost.assertRegistrationSnapshotActive(undefined, options.entryPath);
    }
    const bounded = (value: string | undefined, max: number): value is string | undefined => value === undefined || (value.length <= max && !value.includes("\0"));
    const argv = [...effect.argv];
    const allEnvKeys = [...effect.envKeys].sort();
    const envKeys = allEnvKeys.slice(0, 128);
    const resources = Object.freeze({ ...effect.resources });
    if (
      !bounded(effect.command, 8192) || !bounded(effect.cwd, 4096) || argv.length > 128 ||
      argv.some(value => !bounded(value, 8192)) || allEnvKeys.some(key => !bounded(key, 256)) ||
      Object.values(resources).some(value => !bounded(value, 4096))
    ) {
      throw new GuardBridgeRejection(
        "guard-effect-unavailable", options.entryPath,
        `guard-effect-unavailable: guarded work is unavailable at ${options.entryPath}; the concrete effect request exceeded its bounds.`,
      );
    }
    // Ownership claims are accepted only for explicit fork bookkeeping results.
    const ownedByPackage = effect.ownedByPackage === true && effect.boundTo === "owned-resources";
    const childContext = record?.guardChildContext ?? options.childContext;
    const request: GuardEffectRequest = Object.freeze({
      effectId: randomUUID(),
      entryPath: options.entryPath,
      kind: effect.kind,
      command: effect.command,
      argv: Object.freeze(argv),
      cwd: effect.cwd,
      envKeys: Object.freeze(envKeys),
      ...(allEnvKeys.length > envKeys.length ? { envKeysTruncated: true as const, envKeysTotalCount: allEnvKeys.length } : {}),
      ...(effect.readOnly === true && isForkReadOnlyGitCommand(effect.command, argv) ? { readOnly: true as const } : {}),
      ...(record && this.scheduledSpawnRecords.has(record) ? { scheduled: true as const } : {}),
      headless: this.headless,
      resources,
      ownedByPackage,
      boundTo: ownedByPackage ? "owned-resources" : "unbounded",
      ...(record ? { childId: record.id } : options.childId ? { childId: options.childId } : {}),
      ...(childContext ? {
        parentId: childContext.parentId,
        delegationId: childContext.delegationId,
        childContext,
      } : {}),
      ...(options.ingressId ?? (record ? this.guardEffectIngressIds.get(record) : undefined)
        ? { ingressId: options.ingressId ?? this.guardEffectIngressIds.get(record!) } : {}),
      ...(record?.workflowId ?? options.workflowId ? { workflowId: record?.workflowId ?? options.workflowId } : {}),
    });
    await this.guardBridgeHost.reviewEffect(request, snapshot, options.entryPath, options.signal);
  }

  captureIngress(input: GuardIngressInput): GuardIngressEvidence | Promise<GuardIngressEvidence> | undefined {
    const capture = this.guardBridgeHost.captureIngress(input);
    if (capture && typeof (capture as Promise<GuardIngressEvidence>).then === "function") {
      return Promise.resolve(capture).then(evidence => {
        this.guardBridgeHost.assertIngressCaptureActive(evidence, input.entryPath);
        return evidence;
      });
    }
    this.guardBridgeHost.assertIngressCaptureActive(capture as GuardIngressEvidence | undefined, input.entryPath);
    return capture;
  }

  assertIngressCaptureActive(evidence: GuardIngressEvidence | undefined, entryPath: GuardEntryPathId): void {
    this.guardBridgeHost.assertIngressCaptureActive(evidence, entryPath);
  }

  async createGuardChildInjection(
    context: GuardChildContext,
    entryPath: GuardEntryPathId,
    snapshot: object | undefined,
    signal?: AbortSignal,
  ): Promise<PreparedGuardChildInjection | undefined> {
    if (!this.guardBridgeHost.guardExpected) return undefined;
    this.guardBridgeHost.assertChildInjectionSnapshot(snapshot, entryPath);
    if (signal?.aborted) return undefined;
    const pending = this.guardBridgeHost.createChildGuardExtension(context, snapshot, entryPath);
    if (!signal) return withGuardChildInjectionTimeout(pending, entryPath);
    const result = await raceWithAbort(pending, signal);
    return result.aborted ? undefined : result.value;
  }



  private disposed = false;
  private readonly scheduledSpawnCapability = Object.freeze({});
  private worktreeLifetimeControllers = new Set<AbortController>();

  private agents = new Map<string, AgentRecord>();
  private guardEffectSnapshots = new WeakMap<AgentRecord, object>();
  private guardEffectIngressIds = new WeakMap<AgentRecord, string>();
  private scheduledSpawnRecords = new WeakSet<AgentRecord>();
  /** Guarded resumes awaiting their child-context callback, before a turn starts. */
  private guardResumeInFlight = new Set<string>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private maxConcurrent: number;
  private maxConcurrentForeground = DEFAULT_MAX_CONCURRENT_FOREGROUND;
  private headless = false;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /**
   * Startup phases, keyed by agent id. `spawn()` still returns synchronously,
   * but an agent using worktree isolation is not running yet when it does —
   * copying the repo is an awaited git call. This is what `awaitStartup` hands
   * callers that must fail their tool call on a startup failure, and what
   * `waitForAll` waits on while a record is "running" with no `promise` yet.
   * Entries are dropped once the run is underway, and kept (rejected) after a
   * startup failure so a late `awaitStartup` still sees it.
   */
  private startups = new Map<string, Promise<void>>();

  /**
   * Evicted agents that can still be reached by name, keyed by handle. Outlives
   * the 10-minute record cleanup — that timer exists to bound memory, not to
   * expire a conversation the user might still want — and is cleared alongside
   * completed records on session start/switch.
   */
  private tombstones = new Map<string, AgentTombstone>();

  /**
   * Agents waiting to start, tagged with the pool they wait on. One queue for
   * both pools: `drainQueue` picks the earliest entry whose own pool has room,
   * so neither can head-of-line-block the other, and every removal path
   * (`abort`, `abortAll`, `dispose`) stays a single filter.
   *
   * `release` wakes a caller blocked in `spawnAndWait`, and is fired once the
   * entry's `start` has SETTLED rather than at drain time: startup is async
   * now, so releasing earlier would wake the caller before `record.promise`
   * exists and it would read a still-starting agent as one that never ran.
   * Removing an entry from this array MUST release it — a queued record has no
   * promise to await, and pi has no tool-execution timeout to bail the caller
   * out.
   */
  private queue: { id: string; pool: Pool; start: () => Promise<void>; release: () => void }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Number of currently running foreground (blocking) agents. */
  private runningForeground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Update the max concurrent foreground (blocking) agents limit. 0 = unlimited. */
  setMaxConcurrentForeground(n: number) {
    // Floor 0, not 1: unlimited is a meaningful value here and the default.
    this.maxConcurrentForeground = Math.max(0, n);
    // Start queued agents if the new limit allows — including everything, when
    // the limit is cleared back to unlimited mid-run.
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.maxConcurrentForeground;
  }

  /**
   * Which pool a spawn is charged to, or undefined for one that is charged to
   * neither (nested children, detached non-background spawns).
   *
   * Nothing here queues when the limit is unset — `poolHasRoom` reports an
   * unlimited pool as always having room, so that alone is what keeps the
   * default path identical. The `> 0` guard is belt and braces on top: it also
   * keeps the counter from churning and the settle path from calling a drain
   * that would find nothing to do. Both are unobservable, which is why no test
   * pins them; the observable half — that the default start stays synchronous —
   * is pinned in `test/foreground-concurrency.test.ts`.
   */
  private poolFor(record: AgentRecord): Pool | undefined {
    if (occupiesPoolSlot(record)) return "background";
    if (this.maxConcurrentForeground > 0 && occupiesForegroundSlot(record)) return "foreground";
    return undefined;
  }

  private poolHasRoom(pool: Pool): boolean {
    return pool === "background"
      ? this.runningBackground < this.maxConcurrent
      : this.maxConcurrentForeground === 0 || this.runningForeground < this.maxConcurrentForeground;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   *
   * The id comes back synchronously, but with `isolation: "worktree"` the agent
   * is not running yet when it does — the repo copy is an awaited git call.
   * Callers that must fail a tool call on a startup failure await
   * `awaitStartup(id)`; everyone else sees it on the record (status "error").
   */
  /** Internal scheduler-only spawn path. Its unforgeable symbol is never an option exposed over RPC. */
  spawnScheduled(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    return this.spawn(pi, ctx, type, prompt, {
      ...options,
      guardEntryPath: "scheduled-task.fire",
      [INTERNAL_SCHEDULED_SPAWN]: this.scheduledSpawnCapability,
    });
  }

  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const internalScheduledSpawn = options[INTERNAL_SCHEDULED_SPAWN] === this.scheduledSpawnCapability;
    if ((options.scheduled !== undefined || options.guardEntryPath === "scheduled-task.fire") && !internalScheduledSpawn) {
      throw new GuardBridgeRejection(
        "guard-effect-unavailable", "scheduled-task.fire",
        "guard-effect-unavailable: guarded work is unavailable at scheduled-task.fire; only the scheduler may fire a scheduled child.",
      );
    }
    const entryPath = options.guardEntryPath ?? "agent-manager.spawn";
    const registration = this.assertGuard(entryPath);
    const registrationSnapshot = this.guardBridgeHost.getResourceEnrollmentSnapshotIdentity();
    const validatedRegistration = this.guardBridgeHost.getValidatedRegistrationSnapshot();
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const currentSessionId = registration !== undefined && this.guardBridgeHost.guardExpected
      ? (ctx as any)?.sessionManager?.getSessionId?.()
      : undefined;
    const rootSessionId = options.rootSessionId ?? (typeof currentSessionId === "string" && currentSessionId ? currentSessionId : undefined);
    const record: AgentRecord = {
      id,
      type,
      // Owned children — nested, or a workflow's — are filtered out of every
      // top-level surface, so no handle: nothing can address them and they must
      // not consume a name a top-level sibling could otherwise take.
      handle: !isTopLevelAgent(options)
        ? undefined
        // A reclaimed handle is used as-is: it belongs to the conversation this
        // spawn is reopening, and re-deriving it would lose the numbering.
        : options.reclaim?.handle ?? assignHandle(handleBase(type), this.takenHandles()),
      description: options.description,
      // Reclaimed here, or filled in below from `name` — in which case it must
      // see the handle this record just took, since both come out of the same
      // namespace.
      alias: isTopLevelAgent(options) ? options.reclaim?.alias : undefined,
      // Overwritten below when the spawn is actually queued; a foreground spawn
      // that queues flips to "queued" there rather than being guessed at here,
      // since the pool decision needs the finished record.
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      // Whether anyone is awaiting this agent is a property of the agent, not
      // of the call that made it — and both settle paths need it long after
      // `options` has stopped being the interesting object.
      blocking: options.blocking,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      workflowId: options.workflowId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId,
      ...(registration !== undefined && this.guardBridgeHost.guardExpected ? {
        guardChildContextOptions: {
          inheritContext: options.inheritContext === true,
          isolatedExtensions: options.isolated === true,
          worktree: options.isolation === "worktree",
        },
      } : {}),

    };
    this.agents.set(id, record);
    if (internalScheduledSpawn) this.scheduledSpawnRecords.add(record);
    // After the insert, so `takenHandles()` already counts this record's own
    // handle — a spawn named after its own type gets `explore-2`, not a
    // duplicate `explore` that would make resolution ambiguous.
    if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
      record.alias = assignHandle(handleBase(options.name), this.takenHandles());
    }

    const spawnOptions = { ...options };
    delete spawnOptions.guardBridgeRegistration;
    delete spawnOptions.guardRegistrationSnapshot;
    if (registration !== undefined) {
      spawnOptions.guardBridgeRegistration = this.guardBridgeHost.guardExpected
        ? validatedRegistration
        : registration;
      if (this.guardBridgeHost.guardExpected) spawnOptions.guardRegistrationSnapshot = registrationSnapshot;
    }
    const args: SpawnArgs = { pi, ctx, type, prompt, options: spawnOptions };

    const pool = this.poolFor(record);
    if (pool !== undefined && !options.bypassQueue && !this.poolHasRoom(pool)) {
      // Queue it — started when a running agent in the same pool completes.
      // Idempotent for background (already "queued"); the flip that matters is
      // a blocking foreground spawn, optimistically marked "running" above.
      record.status = "queued";
      // A queued record never reaches startAgent's signal wiring, so arm the
      // parent abort here or Esc could not release the position.
      if (!this.armQueuedAbort(id, options.signal)) return id;
      let release!: () => void;
      record.startGate = new Promise<void>(resolve => { release = resolve; });
      this.queue.push({
        id,
        pool,
        start: () => this.launch(id, record, args, pool),
        release: () => release(),
      });
      options.onQueued?.(id, this.queue.filter(e => e.pool === pool).length - 1);
      return id;
    }

    this.launch(id, record, args, undefined);
    return id;
  }

  /**
   * Wire a parent abort signal for a record that is about to be QUEUED.
   * `startAgent` does this for running agents, and a queued record never gets
   * there, so without this Esc could not release a queue position.
   *
   * Returns false when the signal is ALREADY aborted, in which case the record
   * is stopped here and must not be enqueued: `addEventListener` never fires on
   * an aborted signal, so a `spawnAndWait` on it would wait forever — pi has no
   * tool-execution timeout to bail it out.
   *
   * The listener is left in place when the agent starts. `startAgent` adds its
   * own, so both fire on a later abort, but `abort()` on an already-stopped
   * record is a no-op — so detaching would only be tidiness, and tidiness the
   * `abortAll`/`dispose` paths could not offer anyway.
   */
  private armQueuedAbort(id: string, signal?: AbortSignal): boolean {
    if (signal === undefined) return true;
    if (signal.aborted) {
      const record = this.agents.get(id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
      }
      return false;
    }
    signal.addEventListener("abort", () => this.abort(id), { once: true });
    return true;
  }

  /**
   * Kick off an agent's startup and register it under `startups`. The returned
   * promise never rejects — the failure is delivered through `awaitStartup`,
   * and to the record.
   *
   * @param queuedPool - The pool this start was QUEUED on, or undefined for an
   *   immediate start. A queue drain can be minutes after `spawn()` returned,
   *   and nobody is awaiting `awaitStartup` by then, so a failure has to live
   *   on the record as status "error" — what drainQueue did when the throw was
   *   still synchronous. An immediate start instead drops the record, exactly
   *   as the throw out of `spawn()` did: no orphan in `listAgents()`, and the
   *   handle goes back.
   */
  private launch(id: string, record: AgentRecord, args: SpawnArgs, queuedPool: Pool | undefined): Promise<void> {
    const startup = this.startAgent(id, record, args).then(
      () => { this.startups.delete(id); },
      (err) => {
        this.startups.delete(id);
        if (err instanceof GuardBridgeRejection && (err.reasonCode === "guard-child-context-failed" || err.reasonCode === "guard-child-injection-failed")) {
          if (record.blocking && queuedPool === "foreground") record.resultConsumed = true;
          if (queuedPool === undefined && args.options.guardEntryPath === "manager-registry.spawn") {
            record.status = "error";
            record.error = err.message;
            record.completedAt = Date.now();
            this.onComplete?.(record);
          } else if (queuedPool === undefined) {
            this.agents.delete(id);
          } else {
            record.status = "error";

            record.error = err.message;
            record.completedAt = Date.now();
            this.onComplete?.(record);
          }
        } else if (queuedPool !== undefined) {

          // Mirrors settleRun: an inline caller gets this failure as a throw
          // out of spawnAndWait, so an unconsumed record would ALSO nudge the
          // session about it — the same failure reported twice.
          if (queuedPool === "foreground") record.resultConsumed = true;
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
          this.onComplete?.(record);
        } else {
          this.agents.delete(id);
        }
        // The agent never kept its slot (startAgent gives it back on failure),
        // so anything queued behind it can go now.
        this.drainQueue();
        throw err;
      },
    );
    this.startups.set(id, startup);
    // Nothing is obliged to await `startups` — swallow the rejection once here
    // so an unawaited startup can't take the process down, and hand callers
    // (drainQueue) that swallowed promise.
    return startup.catch(() => {});
  }

  /**
   * Resolves once the agent is actually running, and rejects with the startup
   * failure (strict worktree isolation) that `spawn()` used to throw before the
   * repo copy became async. Resolves immediately for an agent that is already
   * running, still queued, or unknown — so callers can await it unconditionally.
   *
   * Call it in the same tick as the `spawn()` it belongs to: a failed startup
   * takes its record (and this entry) with it, exactly as the throw did.
   */
  awaitStartup(id: string): Promise<void> {
    return this.startups.get(id) ?? Promise.resolve();
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private async startAgent(
    id: string,
    record: AgentRecord,
    args: SpawnArgs,
  ) {
    const { pi, ctx, type, prompt } = args;
    const entryPath = args.options.guardEntryPath ?? "agent-manager.spawn";
    const internalScheduledSpawn = args.options[INTERNAL_SCHEDULED_SPAWN] === this.scheduledSpawnCapability;
    if ((args.options.scheduled !== undefined || entryPath === "scheduled-task.fire") && !internalScheduledSpawn) {
      throw new GuardBridgeRejection(
        "guard-effect-unavailable", "scheduled-task.fire",
        "guard-effect-unavailable: guarded work is unavailable at scheduled-task.fire; only the scheduler may fire a scheduled child.",
      );
    }
    if (this.guardBridgeHost.guardExpected) {
      this.guardBridgeHost.assertChildInjectionSnapshot(args.options.guardRegistrationSnapshot, entryPath);
      if (args.options.guardBridgeRegistration !== this.guardBridgeHost.getValidatedRegistrationSnapshot()) {
        throw childInjectionFailure(entryPath);
      }
    }
    // Queue wait can outlive the guard registration captured by spawn(). Re-check
    // at drain time before touching the record or creating a child session.
    const registration = this.assertGuard(entryPath);
    if (this.guardBridgeHost.guardExpected && args.options.guardRegistrationSnapshot) {
      this.guardEffectSnapshots.set(record, args.options.guardRegistrationSnapshot);
    }
    const effectIngressId = args.options.guardIngressEvidence?.ingressId ?? args.options.guardIngressId;
    if (effectIngressId) this.guardEffectIngressIds.set(record, effectIngressId);

    const options = { ...args.options };
    delete options[INTERNAL_SCHEDULED_SPAWN];
    delete options.guardBridgeRegistration;
    delete options.guardRegistrationSnapshot;
    delete options.guardEntryPath;

    if (registration !== undefined && !this.guardBridgeHost.guardExpected) options.guardBridgeRegistration = registration;
    if (this.guardBridgeHost.guardExpected) {
      options.guardBridgeRegistration = args.options.guardBridgeRegistration;
      options.guardRegistrationSnapshot = args.options.guardRegistrationSnapshot;
    }

    delete options.guardIngressEvidence;
    delete options.guardParentContext;
    delete options.scopeRef;
    delete options.guardIngressId;
    delete options.guardOrigin;


    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);

    // Claim the slot before the child-context callback can await. A pending
    // guard callback must neither let another queued spawn take this slot nor
    // leave abort() unable to reach this startup.
    const pool = this.poolFor(record);
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      if (pool === "background") this.runningBackground--;
      else if (pool === "foreground") this.runningForeground--;
    };
    record.status = "running";
    record.startedAt = Date.now();
    record.startGate = undefined;
    if (pool === "background") this.runningBackground++;
    else if (pool === "foreground") this.runningForeground++;

    let detachParentSignal: (() => void) | undefined;
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };
    const wireParentSignal = () => {
      if (!options.signal) return;
      if (options.signal.aborted) this.abort(id);
      else {
        const onParentAbort = () => this.abort(id);
        options.signal.addEventListener("abort", onParentAbort, { once: true });
        detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
      }
    };
    const guardedContextRequired = registration !== undefined && this.guardBridgeHost.guardExpected;
    const finishAbortedContextStartup = () => {
      detach();
      releaseSlot();
      if (record.blocking) record.resultConsumed = true;
      this.drainQueue();
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    };

    // Guarded context creation must be abortable before user code can start. Keep
    // the upstream signal-wiring point below for guard-off differential parity.
    if (guardedContextRequired) {
      wireParentSignal();
      if (record.status !== "running") {
        finishAbortedContextStartup();
        return;
      }
      try {
        const evidence = args.options.guardIngressEvidence;
        if (evidence) this.guardBridgeHost.assertIngressCaptureActive(evidence, entryPath);
        const parentRecord = args.options.parentAgentId !== undefined ? this.agents.get(args.options.parentAgentId) : undefined;
        const parentContext = args.options.guardParentContext ?? parentRecord?.guardChildContext;
        if (args.options.parentAgentId !== undefined && !parentContext) throw childContextFailure(entryPath);
        if (parentContext && parentContext.bridgeRef !== registration) throw childContextFailure(entryPath);
        const internalScheduledSpawn = args.options[INTERNAL_SCHEDULED_SPAWN] === this.scheduledSpawnCapability;
        const scheduled = internalScheduledSpawn ? args.options.scheduled : undefined;
        const scopeRef = typeof args.options.scopeRef === "string" ? args.options.scopeRef.trim().slice(0, 512) : undefined;
        const origin = evidence?.origin ?? args.options.guardOrigin ?? guardOriginForEntryPath(entryPath);
        const rootMarker = args.options.rootSessionId ?? record.rootSessionId ?? "unknown";
        const callback = this.guardBridgeHost.createChildContext({
          childId: id,
          parentId: args.options.parentAgentId ?? parentContext?.childId ?? `root:${rootMarker}`,
          origin,
          entryPath,
          operation: "spawn",
          ...((evidence?.ingressId ?? args.options.guardIngressId) ? { ingressId: evidence?.ingressId ?? args.options.guardIngressId } : {}),
          ...(parentContext ? { parentContext } : {}),
          inheritContext: args.options.inheritContext === true,
          isolatedExtensions: args.options.isolated === true,
          worktree: args.options.isolation === "worktree",
          headless: this.headless,
          ...(scheduled && scopeRef ? { scopeRef } : origin === "extension-request" && scopeRef ? { scopeRef } : {}),
          scopeRefStatus: scheduled
            ? args.options.guardScopeRefStatus === "provided" ? "provided" : "unresolved"
            : origin === "extension-request" ? (scopeRef ? "unresolved" : "not-applicable") : "not-applicable",
          ...(scheduled ? { scheduled: Object.freeze({ ...scheduled }) } : {}),
        }, evidence);
        const boundedCallback = args.options.scheduled ? withGuardScheduleFireTimeout(callback, entryPath) : callback;
        const outcome = await raceWithAbort(boundedCallback, record.abortController!.signal);
        if (this.disposed && record.status === "running") {
          record.status = "stopped";
          record.completedAt = Date.now();
        }
        if (outcome.aborted || record.status !== "running") {
          finishAbortedContextStartup();
          return;
        }
        if (!outcome.value) throw childContextFailure(entryPath);
        record.guardChildContext = outcome.value;
      } catch (err) {
        if (this.disposed && record.status === "running") {
          record.status = "stopped";
          record.completedAt = Date.now();
          finishAbortedContextStartup();
          return;
        }
        detach();
        releaseSlot();
        this.drainQueue();
        if (record.status !== "running") return;
        throw err;
      }
    }

    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done BEFORE
    // the run is kicked off so a failure doesn't leave a half-running agent.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    const effectReviewer = guardedContextRequired
      ? (effect: GuardEffectDescription, effectEntryPath: GuardEntryPathId, signal: AbortSignal = record.abortController!.signal) => this.reviewGuardEffect(effect, {
          entryPath: effectEntryPath, childId: id, ingressId: effectIngressId,
          snapshot: args.options.guardRegistrationSnapshot, signal,
          childContext: record.guardChildContext, workflowId: record.workflowId,
        })
      : undefined;
    const worktreeHooks: WorktreeEffectHooks | undefined = effectReviewer ? {
      childId: id,
      delegationId: record.guardChildContext?.delegationId,
      parentWorkspace: ctx.cwd,
      signal: record.abortController!.signal,
      reviewEffect: effectReviewer,
      assertSnapshotActive: effectEntryPath => this.assertGuardEffectSnapshotActive(args.options.guardRegistrationSnapshot, effectEntryPath),
    } : undefined;
    const createWorktreeLifetime = (): { signal: AbortSignal; release: () => void } => {
      const controller = new AbortController();
      this.worktreeLifetimeControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 30_000);
      timeout.unref?.();
      return {
        signal: controller.signal,
        release: () => {
          clearTimeout(timeout);
          this.worktreeLifetimeControllers.delete(controller);
        },
      };
    };
    const createCleanupHooks = (): { hooks?: WorktreeEffectHooks; release: () => void } => {
      if (!worktreeHooks || !effectReviewer) return { release: () => {} };
      const lifetime = createWorktreeLifetime();
      return {
        hooks: {
          ...worktreeHooks,
          signal: lifetime.signal,
          reviewEffect: (effect, entryPath) => effectReviewer(effect, entryPath, lifetime.signal),
        },
        release: lifetime.release,
      };
    };

    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
      let wt: Awaited<ReturnType<typeof createWorktree>>;
      const creationLifetime = worktreeHooks ? createWorktreeLifetime() : undefined;
      try {
        wt = worktreeHooks
          ? await createWorktree(pi, baseCwd, id, { ...worktreeHooks, commandSignal: creationLifetime!.signal })
          : await createWorktree(pi, baseCwd, id);
      } catch (err) {
        if (guardedContextRequired && record.status !== "running") {
          record.error = err instanceof Error ? err.message.slice(0, 512) : "Worktree creation stopped.";
          finishAbortedContextStartup();
          return;
        }
        if (guardedContextRequired) {
          detach();
          releaseSlot();
        }
        throw err;
      } finally {
        creationLifetime?.release();
      }
      if (!wt) {
        if (guardedContextRequired && record.status !== "running") {
          finishAbortedContextStartup();
          return;
        }
        detach();
        releaseSlot();
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);

      // No longer "running" means a stop landed while the copy was being made
      // (abort(), abortAll()) — a window that did not exist when creation was
      // synchronous. The record is already terminal, so launching the run would
      // burn tokens on work nobody is waiting for: discard the fresh (and by
      // definition unchanged) worktree instead.
      if (record.status !== "running") {
        if (!worktreeHooks) {
          detach();
          releaseSlot();
          record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description);
          this.drainQueue();
          return;
        }
        const cleanup = createCleanupHooks();
        try {
          record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description, cleanup.hooks);
        } catch (error) {
          const reason = error instanceof Error ? error.message.slice(0, 256) : "guarded worktree cleanup was denied";
          record.error = `Worktree cleanup incomplete: ${reason}`;
        } finally {
          cleanup.release();
          finishAbortedContextStartup();
        }
        return;
      }
    }

    this.onStart?.(record);
    if (!guardedContextRequired) wireParentSignal();

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      structuredOutput: options.structuredOutput,
      resumeSessionFile: options.resumeSessionFile,
      ...(options.guardBridgeRegistration !== undefined ? { guardBridgeRegistration: options.guardBridgeRegistration } : {}),
      ...(options.guardRegistrationSnapshot !== undefined ? { guardRegistrationSnapshot: options.guardRegistrationSnapshot } : {}),

      ...(record.guardChildContext !== undefined ? { guardChildContext: record.guardChildContext } : {}),

      guardBridgeHost: this.guardBridgeHost,
      guardExpected: this.guardBridgeHost.guardExpected,
      ...(effectReviewer ? {
        reviewGuardEffect: effectReviewer,
        assertGuardEffectActive: (effectEntryPath: GuardEntryPathId) =>
          this.assertGuardEffectSnapshotActive(args.options.guardRegistrationSnapshot, effectEntryPath),
      } : {}),
      nested: options.parentAgentId !== undefined,
      workflow: options.workflowId !== undefined,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      // Set iff a worktree was created (see above) — names the directory the
      // copy came from, so the prompt can tell the agent not to work there.
      worktreeBase: worktreeCwd ? baseCwd : undefined,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        if (record.pendingSteers?.length) this.assertGuard("agent-manager.pending-steer");

        record.session = session;
        if (record.guardChildContext && session.agent?.state) {
          (session.agent.state as typeof session.agent.state & { guardChildContext?: GuardChildContext }).guardChildContext = record.guardChildContext;
        }

        // Capture now, while the session object exists: after eviction this
        // path is the only thing that can reopen the conversation, and an
        // in-memory session reports undefined, which correctly means
        // "nothing to come back to".
        // Optional chaining, not defensiveness for its own sake: this is the
        // only field read off the session at creation, so an older pi or a
        // stubbed session must degrade to "not resumable" rather than throw
        // and take the whole spawn down with it.
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        // Same reason, different field: the model and thinking level are only
        // knowable once pi has resolved its defaults and clamped the level to
        // what the model supports. Writing them back here makes the record
        // authoritative, so every surface reads one place instead of each
        // re-deriving "session, else the request" for itself.
        if (session.model) {
          record.invocation ??= {};
          // Read the kept request first: a caller's level survives being clamped
          // AND, one line later, being replaced by the effective one.
          const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
          Object.assign(record.invocation, describeModel(session.model));
          // Guarded for the reason above: a session that reports no level keeps
          // the request rather than losing it. Overwriting unconditionally would
          // turn an older or stubbed session into a blank `thinking:` tag, which
          // is worse than the stale-but-true value it replaced.
          if (session.thinkingLevel) {
            record.invocation.thinking = session.thinkingLevel;
            if (requested && requested !== session.thinkingLevel) {
              record.invocation.requestedThinking = requested;
            }
          }
        }
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (let index = 0; index < record.pendingSteers.length; index++) {
            const evidence = record.pendingSteerEvidence?.[index];
            if (evidence) this.guardBridgeHost.assertIngressCaptureActive(evidence, "agent-manager.pending-steer");
            session.steer(record.pendingSteers[index]).catch(() => {});
          }
          record.pendingSteers = undefined;
          record.pendingSteerEvidence = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(async ({ responseText, session, aborted, steered, failure, structuredJson, structuredRetried }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.result = responseText;
        // Kept beside `result`, never inside it: `result` is prose meant for a
        // reader — it is previewed, transcribed, and appended to below — while
        // this is a machine-readable payload one caller asked for by schema.
        record.structuredJson = structuredJson;
        record.structuredRetried = structuredRetried;
        record.session = session;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          // The one moment the child's tree still exists and the child is done
          // writing to it. try/catch, not decoration: a hook that throws must
          // not leave the worktree behind.
          if (options.onBeforeWorktreeCleanup) {
            try {
              await options.onBeforeWorktreeCleanup(record.worktree.path);
            } catch { /* ignore — never block cleanup */ }
          }
          const cleanup = createCleanupHooks();
          let wtResult: WorktreeCleanupResult | undefined;
          try {
            if (cleanup.hooks) wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description, cleanup.hooks);
            else wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch (error) {
            if (!worktreeHooks) throw error;
            const reason = error instanceof Error ? error.message.slice(0, 256) : "guarded worktree cleanup was denied";
            record.error = [record.error, `Worktree cleanup incomplete: ${reason}`].filter(Boolean).join("; ").slice(0, 1024);
          } finally {
            cleanup.release();
          }
          if (wtResult?.hasChanges && wtResult.branch) {
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            // Appended to the prose only. A structured child's caller parses
            // `structuredJson`, which stays untouched — but `result` is also
            // what a human reads, so the note still belongs on it.
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
          }
        }

        this.abortOwnedChildren(id);

        this.settleRun(record, true, pool);
        return responseText;
      })
      .catch(async (err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          const cleanup = createCleanupHooks();
          try {
            const wtResult = cleanup.hooks
              ? await cleanupWorktree(pi, baseCwd, record.worktree, options.description, cleanup.hooks)
              : await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch (error) {
            const reason = error instanceof Error ? error.message.slice(0, 256) : "guarded worktree cleanup was denied";
            record.error = [record.error, `Worktree cleanup incomplete: ${reason}`].filter(Boolean).join("; ").slice(0, 1024);
          } finally {
            cleanup.release();
          }
        }

        this.abortOwnedChildren(id);

        this.settleRun(record, false, pool);
        return "";
      });

    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming
    // starts. Read off the options, so a spawn that started from a queue drain
    // still reaches the caller that queued it.
    options.onSpawned?.(id);
  }

  /**
   * The shared tail of both settle paths: release whatever pool slot the run
   * held, notify, and let the queue drain into the freed slot.
   *
   * The decrement lives HERE and nowhere else. `abort()` on a running record
   * only fires its controller and leaves the run to settle normally, so
   * decrementing there too would double-free — permanently lifting the limit.
   *
   * Foreground agents fire `onComplete` for lifecycle symmetry, with
   * `resultConsumed` set so the callback skips notifications the inline result
   * already delivered.
   *
   * @param guardCallback swallow a throwing `onComplete` (the success path does;
   *   the error path historically did not, and keeps not doing so).
   * @param pool the pool this run was CHARGED TO at start time — passed in, not
   *   recomputed, so a mid-run change to `maxConcurrentForeground` can't make
   *   the release disagree with the acquire.
   */
  private settleRun(record: AgentRecord, guardCallback: boolean, pool: Pool | undefined): void {
    if (!record.isBackground) record.resultConsumed = true;
    if (pool === "background") this.runningBackground--;
    else if (pool === "foreground") this.runningForeground--;

    if (guardCallback) {
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    } else {
      this.onComplete?.(record);
    }

    // The isBackground half reproduces the pre-pool condition exactly — a
    // background settle has always drained, even for a nested child that held
    // no slot — so that path is unchanged whether or not the foreground pool is
    // on. The `pool` half only adds the drain a freed FOREGROUND slot needs.
    // A drain with nothing freed is a no-op anyway, but "no-op" is a claim
    // about reachability, and matching the old condition needs no such claim.
    if (record.isBackground || pool !== undefined) this.drainQueue();
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  /**
   * Start queued agents up to each pool's concurrency limit.
   *
   * `findIndex` on the entry's OWN pool rather than `shift`: with one queue
   * serving two independent limits, a saturated foreground pool at the head
   * would otherwise stall every background agent behind it. Taking the earliest
   * eligible entry keeps FIFO within each pool, which is what callers see.
   */
  private drainQueue() {
    for (;;) {
      const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
      if (i === -1) return;
      const [next] = this.queue.splice(i, 1);
      const record = this.agents.get(next.id);
      // Stale entries (aborted while queued) are not started — but are still
      // released, since nothing else will.
      if (!record || record.status !== "queued") { next.release(); continue; }
      // Detached, and never rejects: a late failure (e.g. strict worktree
      // isolation) lands on the record inside `launch`, exactly as the
      // synchronous throw did here before, and draining continues either way.
      //
      // The release waits for that startup to SETTLE rather than firing here.
      // Startup is async now, so a release at drain time would wake a blocked
      // `spawnAndWait` while `record.promise` was still undefined, and it would
      // read a perfectly healthy agent as one that never ran.
      void next.start().then(() => next.release(), () => next.release());
    }
  }

  /**
   * Remove queued entries and wake anyone blocked on them. The single point
   * that enforces "leaving the queue releases the waiter" — a missed release is
   * an unbounded hang, not a failed call.
   */
  private dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue = kept;
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Charged to the foreground pool (`maxConcurrentForeground`), which is
   * unlimited by default; never to the background one.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously once the run is kicked off, before
   *   onSessionCreated fires. Use this to set record.outputFile so
   *   streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    const guardEntryPath = options.guardEntryPath ?? "agent-manager.spawn-and-wait";
    const registration = this.assertGuard(guardEntryPath);
    // `blocking` is what maxConcurrentForeground bounds, and this is its only
    // source. onSpawned rides on the options rather than on a field of this
    // manager: a queued spawn starts at drain time, long after any install/
    // restore pair around this call would have put the field back — and it now
    // fires after an await (worktree creation) even on the immediate path.
    const id = this.spawn(pi, ctx, type, prompt, {
      ...options,
      ...(options.guardEntryPath !== undefined ? { guardEntryPath } : {}),
      ...(registration !== undefined ? { guardBridgeRegistration: registration } : {}),
      isBackground: false,
      blocking: true,
      onSpawned,
    });
    const record = this.agents.get(id)!;

    // Queued: nothing to await yet — the promise appears when the drain starts
    // it. The gate resolves (never rejects) on every path out of the queue,
    // start and abort alike, so a rejection can never escape into the caller's
    // tool `execute` and take down pi's whole Promise.all tool batch.
    if (record.status === "queued") await record.startGate;

    // The run promise only exists once startup is past its awaited repo copy —
    // without this the call would return before the agent had started at all.
    // A startup failure (strict worktree isolation) rejects here, which is what
    // the immediate path owes its caller: pi only marks a tool result failed
    // when `execute` throws. A queued spawn's failure landed on the record
    // instead (nobody was awaiting `startups` at drain time) and is rethrown
    // below, so the contract is the same either way.
    await this.awaitStartup(id);

    // undefined when it was aborted while queued, or stopped mid-copy, and so
    // never ran — the record is already terminal with a completedAt, which is
    // what the caller renders.
    if (record.promise) await record.promise;

    // A record that ended "error" without ever getting a promise never ran: the
    // same startup failure spawn() rethrows on the immediate path (#179). Keep
    // one contract rather than letting queue pressure decide whether a strict
    // worktree failure throws or returns as a result.
    if (record.promise === undefined && record.status === "error") {
      throw new Error(record.error ?? "Agent failed to start");
    }
    return { id, record };
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  private async createResumeChildContext(
    record: AgentRecord,
    entryPath: GuardEntryPathId,
    options: ResumeOptions,
  ): Promise<GuardChildContext | undefined> {
    const registration = this.assertGuard(entryPath);
    if (registration === undefined || !this.guardBridgeHost.guardExpected) return undefined;
    const evidence = options.guardIngressEvidence;
    if (evidence) this.guardBridgeHost.assertIngressCaptureActive(evidence, entryPath);
    const parentRecord = record.parentAgentId !== undefined ? this.agents.get(record.parentAgentId) : undefined;
    const parentContext = options.guardParentContext ?? parentRecord?.guardChildContext;
    if (record.parentAgentId !== undefined && !parentContext) throw childContextFailure(entryPath);
    if (parentContext && parentContext.bridgeRef !== registration) throw childContextFailure(entryPath);
    const retained = record.guardChildContextOptions;
    const origin = evidence?.origin ?? guardOriginForEntryPath(entryPath);
    const scopeRef = typeof options.scopeRef === "string" ? options.scopeRef.trim() : undefined;
    const rootMarker = record.rootSessionId ?? "unknown";
    const context = await this.guardBridgeHost.createChildContext({
      childId: record.id,
      parentId: record.parentAgentId ?? parentContext?.childId ?? `root:${rootMarker}`,
      origin,
      entryPath,
      operation: "resume",
      ...(evidence?.ingressId ? { ingressId: evidence.ingressId } : {}),
      ...(parentContext ? { parentContext } : {}),
      inheritContext: retained?.inheritContext ?? false,
      isolatedExtensions: retained?.isolatedExtensions ?? false,
      worktree: retained?.worktree ?? false,
      headless: this.headless,
      ...(origin === "extension-request" && scopeRef ? { scopeRef } : {}),
      scopeRefStatus: origin === "extension-request" ? (scopeRef ? "provided" : "unresolved") : "not-applicable",
    }, evidence);
    if (!context) throw childContextFailure(entryPath);
    record.guardChildContext = context;
    record.guardChildContextOptions = {
      inheritContext: retained?.inheritContext ?? false,
      isolatedExtensions: retained?.isolatedExtensions ?? false,
      worktree: retained?.worktree ?? false,
    };
    return context;
  }


  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    const entryPath = options?.guardEntryPath ?? "agent-manager.resume";
    const registration = this.assertGuard(entryPath);
    const registrationSnapshot = this.guardBridgeHost.getResourceEnrollmentSnapshotIdentity();
    const validatedRegistration = this.guardBridgeHost.getValidatedRegistrationSnapshot();
    if (this.guardBridgeHost.guardExpected) {
      this.guardBridgeHost.assertChildInjectionSnapshot(registrationSnapshot, entryPath);
    }
    let resumeOptions = options;
    if (registration !== undefined) {
      resumeOptions = {
        ...options,
        guardBridgeRegistration: this.guardBridgeHost.guardExpected ? validatedRegistration : registration,
        ...(this.guardBridgeHost.guardExpected ? { guardRegistrationSnapshot: registrationSnapshot } : {}),
      };
    }
    const record = this.agents.get(id);
    if (!record?.session) return undefined;
    if (this.guardBridgeHost.guardExpected && (
      this.guardResumeInFlight.has(id) || record.status === "running" || record.status === "queued"
    )) {
      return undefined;
    }

    // Background resume: settle asynchronously and notify on completion exactly
    // like a background spawn, returning immediately with the record still
    // "running" — or "queued" when at the concurrency limit. Previously
    // run_in_background was ignored on resume (the Agent tool's resume branch
    // returned before its background branch, and resume() only ever awaited
    // inline), so a resumed agent always blocked the caller until it finished.
    if (options?.isBackground) {
      // Never re-enter a run that is still in flight. Detaching means the caller
      // gets control back while the record stays "running", so nothing stops the
      // model from resuming the same agent again. Starting a second run would
      // overwrite record.abortController — orphaning the live run beyond the
      // reach of `/agents` stop and abortAll() — double-count the pool slot, and
      // then reject from session.prompt() with "Agent is already processing",
      // whose settle path would abort the LIVE run's children and report a
      // failure for a run that is still going. Refuse instead, leaving the
      // record untouched; the caller decides whether to wait or steer.
      if (record.status === "running" || record.status === "queued") return undefined;

      record.isBackground = true;
      record.resultConsumed = false;
      record.result = undefined;
      record.error = undefined;
      record.completedAt = undefined;
      record.status = "queued";

      const start = async () => {
        const operation = this.startResume(id, record, prompt, signal, resumeOptions ?? {});
        record.promise = operation.then(() => record.result ?? "", () => "");
        try {
          await operation;
        } catch (err) {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
          try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
        }
      };


      if (occupiesPoolSlot(record) && !this.poolHasRoom("background")) {
        // At the concurrency limit — queue it, drains when a slot frees. A
        // detached resume has no inline caller, hence nothing to release. The
        // queue is shared with spawns, whose startup is async, so entries are
        // promise-shaped even though a resume starts synchronously; failures
        // land on the record here, since drainQueue no longer catches.
        this.queue.push({
          id,
          pool: "background",
          start: async () => {
            try {
              await start();
            } catch (err) {
              record.status = "error";
              record.error = err instanceof Error ? err.message : String(err);
              record.completedAt = Date.now();
              this.onComplete?.(record);
            }
          },
          release: () => {},
        });
      } else {
        void start();
      }
      return record;
    }

    const guardedContextRequired = registration !== undefined && this.guardBridgeHost.guardExpected;
    let childContext: GuardChildContext | undefined;
    let guardedAbortController: AbortController | undefined;
    let detachGuardAbort: (() => void) | undefined;
    if (guardedContextRequired) {
      // Claim the record synchronously before the callback's first await. This
      // rejects overlapping foreground/background resumes and lets abort() stop
      // a pending context request just like a running turn.
      record.status = "running";
      record.startedAt = Date.now();
      record.completedAt = undefined;
      record.result = undefined;
      record.error = undefined;
      guardedAbortController = new AbortController();
      record.abortController = guardedAbortController;
      if (signal) {
        if (signal.aborted) this.abort(id);
        else {
          const onParentAbort = () => this.abort(id);
          signal.addEventListener("abort", onParentAbort, { once: true });
          detachGuardAbort = () => signal.removeEventListener("abort", onParentAbort);
        }
      }
      this.guardResumeInFlight.add(id);
      try {
        if (record.status !== "running") {
          detachGuardAbort?.();
          detachGuardAbort = undefined;
          return record;
        }
        const callback = this.createResumeChildContext(
          record,
          options?.guardEntryPath ?? "agent-manager.resume",
          resumeOptions ?? {},
        );
        const outcome = await raceWithAbort(callback, guardedAbortController.signal);
        if (outcome.aborted || record.status !== "running" || this.disposed) {
          if (this.disposed && record.status === "running") {
            record.status = "stopped";
            record.completedAt = Date.now();
          }
          detachGuardAbort?.();
          detachGuardAbort = undefined;
          return record;
        }
        childContext = outcome.value;
        if (!childContext) throw childContextFailure(options?.guardEntryPath ?? "agent-manager.resume");
      } catch (err) {
        detachGuardAbort?.();
        detachGuardAbort = undefined;
        if (this.disposed) {
          record.status = "stopped";
          record.completedAt ??= Date.now();
        } else if ((record.status as string) !== "stopped") {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
        }
        return record;
      } finally {
        this.guardResumeInFlight.delete(id);
      }
    }

    // Foreground resume: run inline and return the settled record.
    if (!guardedContextRequired) {
      record.status = "running";
      record.startedAt = Date.now();
      record.completedAt = undefined;
      record.result = undefined;
      record.error = undefined;
    }

    try {
      const { text, failure, aborted } = await resumeAgent(record.session, prompt, {
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          resumeOptions?.onToolActivity?.(activity);
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          this.onUsage?.(record, usage);
          resumeOptions?.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
          resumeOptions?.onCompaction?.(info);
        },
        signal: guardedAbortController?.signal ?? signal,
        ...(registration !== undefined ? { guardBridgeRegistration: resumeOptions?.guardBridgeRegistration ?? registration } : {}),
        ...(resumeOptions?.guardRegistrationSnapshot !== undefined ? { guardRegistrationSnapshot: resumeOptions.guardRegistrationSnapshot } : {}),
        ...(childContext !== undefined ? { guardChildContext: childContext } : {}),

        guardBridgeHost: this.guardBridgeHost,
        guardExpected: this.guardBridgeHost.guardExpected,
      });
      // Same contract as the spawn path (#144): a failed final turn is an
      // error, not a completion — but the resumed text stays available.
      if ((record.status as string) !== "stopped") {
        record.status = aborted ? "aborted" : failure ? "error" : "completed";
      }
      if (failure) record.error = failure;
      record.result = text;
      record.completedAt = Date.now();
    } catch (err) {
      if (!guardedContextRequired || record.status !== "stopped") {
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
      }
      record.completedAt ??= Date.now();
    } finally {
      detachGuardAbort?.();
    }

    // Same contract as the spawn settle paths: children spawned during the
    // resumed turn must not outlive it — nothing else can see or reach them.
    this.abortOwnedChildren(id);

    return record;
  }

  /**
   * Start a background resume run: detached, settling and notifying like
   * startAgent's background path. Invoked immediately, or from drainQueue when
   * a concurrency slot frees. The session already exists (resume reuses it), so
   * there is no onSessionCreated to hang per-run wiring off — callers use
   * `options.onStarted`, which fires on both the immediate and the drained path.
   */
  private async startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    requestedOptions: ResumeOptions,
  ) {
    // A queued resume can outlive the registration captured when it was queued.
    // Re-check before changing the record or invoking the existing session.
    const entryPath = requestedOptions.guardEntryPath ?? "agent-manager.resume";

    if (this.guardBridgeHost.guardExpected) {
      this.guardBridgeHost.assertChildInjectionSnapshot(requestedOptions.guardRegistrationSnapshot, entryPath);
    }
    const registration = this.assertGuard(entryPath);
    const options = { ...requestedOptions };
    delete options.guardIngressEvidence;
    delete options.guardParentContext;

    delete options.scopeRef;
    delete options.guardBridgeRegistration;
    delete options.guardRegistrationSnapshot;
    if (registration !== undefined && !this.guardBridgeHost.guardExpected) options.guardBridgeRegistration = registration;
    if (this.guardBridgeHost.guardExpected) {
      options.guardBridgeRegistration = requestedOptions.guardBridgeRegistration;
      options.guardRegistrationSnapshot = requestedOptions.guardRegistrationSnapshot;
    }
    if (!record.session) return;

    // Claim the pool slot, controller, and running state before awaiting a
    // guarded context callback. This keeps drainQueue bounded and lets abort()
    // reach the operation while enrollment is pending.
    const pool = occupiesPoolSlot(record) ? "background" : undefined;
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      if (pool === "background") this.runningBackground--;
    };
    record.status = "running";
    record.startedAt = Date.now();
    const abortController = new AbortController();
    record.abortController = abortController;
    const guardedContextRequired = registration !== undefined && this.guardBridgeHost.guardExpected;
    let detachParentSignal: (() => void) | undefined;
    if (parentSignal) {
      // Preserve upstream guard-off behavior: an already-aborted parent signal
      // is ignored because adding a listener after abort does not replay it.
      if (guardedContextRequired && parentSignal.aborted) this.abort(id);
      else {
        const onParentAbort = () => this.abort(id);
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
        detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
      }
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };
    if (pool === "background") this.runningBackground++;
    const finishAbortedContextResume = () => {
      detach();
      releaseSlot();
      this.drainQueue();
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    };
    if (record.status !== "running") {
      detach();
      releaseSlot();
      this.drainQueue();
      if (guardedContextRequired) {
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      }
      return;
    }

    let childContext: GuardChildContext | undefined;
    if (guardedContextRequired) {
      this.guardResumeInFlight.add(id);
      try {
        const callback = this.createResumeChildContext(record, entryPath, requestedOptions);
        const outcome = await raceWithAbort(callback, abortController.signal);
        if (outcome.aborted || record.status !== "running" || this.disposed) {
          if (this.disposed && record.status === "running") {
            record.status = "stopped";
            record.completedAt = Date.now();
          }
          finishAbortedContextResume();
          return;
        }
        childContext = outcome.value;
        if (!childContext) throw childContextFailure(entryPath);
      } catch (err) {
        if (this.disposed && record.status === "running") {
          record.status = "stopped";
          record.completedAt = Date.now();
          finishAbortedContextResume();
          return;
        }
        detach();
        releaseSlot();
        this.drainQueue();
        if (record.status !== "running") return;
        throw err;
      }
      finally {
        this.guardResumeInFlight.delete(id);
      }
    }
    if (record.status !== "running" || (guardedContextRequired && abortController.signal.aborted)) {
      if (guardedContextRequired && (record.status as string) === "stopped") finishAbortedContextResume();
      else {
        detach();
        releaseSlot();
        this.drainQueue();
      }
      return;
    }

    this.onStart?.(record);

    // Fresh abort controller so /agents stop and steering target THIS run rather
    // than the previous one's settled controller.
    // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
    // After the record is in its running shape, before the run is kicked off.
    try { options.onStarted?.(); } catch { /* ignore caller wiring errors */ }

    const settle = () => {
      detach();
      // Final flush of streaming output file
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      // Children spawned during the resumed turn must not outlive it.
      this.abortOwnedChildren(id);
      releaseSlot();
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      this.drainQueue();
    };

    const promise = resumeAgent(record.session, prompt, {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      signal: abortController.signal,
      ...(options.guardBridgeRegistration !== undefined ? { guardBridgeRegistration: options.guardBridgeRegistration } : {}),
      ...(options.guardRegistrationSnapshot !== undefined ? { guardRegistrationSnapshot: options.guardRegistrationSnapshot } : {}),
      ...(childContext !== undefined ? { guardChildContext: childContext } : {}),

      guardBridgeHost: this.guardBridgeHost,
      guardExpected: this.guardBridgeHost.guardExpected,
    })
      .then(({ text, failure, aborted }) => {
        // Don't overwrite status if externally stopped via abort().
        if (record.status !== "stopped") {
          // Same contract as the spawn path (#144): a failed final turn is an
          // error, not a completion — but the resumed text stays available.
          record.status = aborted ? "aborted" : failure ? "error" : "completed";
          if (failure) record.error = failure;
        }
        record.result = text;
        record.completedAt ??= Date.now();
        settle();
        return text;
      })
      .catch((err) => {
        if (record.status !== "stopped") {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.completedAt ??= Date.now();
        settle();
        return "";
      });

    record.promise = promise;
    await promise;

  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string, evidence?: GuardIngressEvidence): boolean {
    this.assertGuard("agent-manager.steer");
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (evidence) this.guardBridgeHost.assertIngressCaptureActive(evidence, "agent-manager.steer");
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
      if (evidence && !record.pendingSteerEvidence) {
        record.pendingSteerEvidence = Array.from({ length: record.pendingSteers.length - 1 }, () => undefined);
      }
      if (record.pendingSteerEvidence) record.pendingSteerEvidence.push(evidence);

    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
  private takenHandles(): Set<string> {
    const taken = new Set<string>();
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
      if (record.alias) taken.add(record.alias);
    }
    // Tombstones hold their names too: an evicted `@explore` is still
    // resurrectable, so a later Explore must become `explore-2` rather than
    // shadowing a conversation the user can still reach.
    for (const entry of this.tombstones.values()) {
      taken.add(entry.handle);
      if (entry.alias) taken.add(entry.alias);
    }
    return taken;
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started (which is the one a resume should continue), then
   * falls back to an exact agent id so `@<agentId>` works too.
   */
  resolveMention(name: string): MentionResolution | undefined {
    const wanted = name.toLowerCase();
    let fallback: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      if (record.parentAgentId !== undefined) continue;
      // Handle and alias share one namespace, so at most one agent answers a
      // name and it makes no difference which of the two matched.
      if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
      if (record.status === "running" || record.status === "queued") return { kind: "live", record };
      if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
    }
    if (fallback) return { kind: "live", record: fallback };
    const byId = this.agents.get(name);
    if (byId?.parentAgentId === undefined && byId !== undefined) return { kind: "live", record: byId };
    // Only once nothing live answers: a tombstone is a conversation to reopen,
    // and reopening one while its record still exists would fork the session.
    for (const entry of this.tombstones.values()) {
      if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
        return { kind: "tombstone", entry };
      }
    }
    return undefined;
  }

  /**
   * Forget an evicted agent, by handle. For the case where its session file has
   * gone: the entry can then only ever fail, while still holding the name
   * against the type that would otherwise start a fresh agent under it.
   *
   * A *successful* resume does not drop its tombstone — the live record it
   * creates already wins in `resolveMention`, and overwrites the entry in place
   * when it is itself evicted.
   */
  dropTombstone(handle: string): void {
    this.tombstones.delete(handle);
  }

  /** Evicted agents whose conversation can still be reopened, newest first. */
  listTombstones(): AgentTombstone[] {
    return [...this.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued. No decrement — the slot was never taken —
    // and no onComplete, matching what a queued background abort has always
    // done; a blocking caller learns of the stop from its own tool result.
    if (record.status === "queued") {
      this.dequeue(q => q.id === id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.tombstone(record);
    const session = record.session;
    // Detached before the shutdown starts, so the record leaves the map at once and
    // nothing can observe a session that is half torn down.
    record.session = undefined;
    this.agents.delete(id);
    // A failed startup keeps its (rejected) entry so a late awaitStartup still
    // sees it; drop it with the record so the map can't grow unbounded.
    this.startups.delete(id);
    // Fire-and-forget is right here and only here: this runs from the 60s cleanup timer
    // and from `clearCompleted()` on session boundaries, with the process staying alive,
    // so handlers get their full window. The quit path awaits instead — see dispose().
    void shutdownChildSession(session);
  }

  /**
   * Preserve enough of a departing record for `@handle` to reopen its
   * conversation later. Nothing to keep unless it has both a handle to be
   * addressed by and a session file to reopen — an in-memory session leaves no
   * transcript, so the mention would have nothing to continue from.
   */
  private tombstone(record: AgentRecord): void {
    if (!record.handle || !record.sessionFile) return;
    this.tombstones.set(record.handle, {
      handle: record.handle,
      alias: record.alias,
      id: record.id,
      type: record.type,
      description: record.description,
      sessionFile: record.sessionFile,
      completedAt: record.completedAt ?? Date.now(),
    });
    // Bound the memory a long session can accumulate. Oldest first, since the
    // agent someone still wants to reach is the one they used most recently.
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = [...this.tombstones.values()].reduce((a, b) => (a.completedAt <= b.completedAt ? a : b));
      this.tombstones.delete(oldest.handle);
    }
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    // Unconditional: both callers are session boundaries (`session_start` and
    // `session_before_switch`), and `skipUnconsumed` only spares records whose
    // results the LLM has yet to read — it does not make the sweep partial in
    // the sense that matters here. A new session means new handles, or
    // `@explore` would silently reach an agent the user never started. Claude
    // Code resets its registry on `/clear` for the same reason.
    this.tombstones.clear();
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.dequeue(() => true);
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending: Promise<unknown>[] = [];
      for (const record of this.agents.values()) {
        if (record.status !== "running" && record.status !== "queued") continue;
        // An agent whose worktree is still being created is "running" with no
        // `promise` yet — without its startup the wait would return too early.
        const startup = this.startups.get(record.id);
        if (startup) pending.push(startup);
        if (record.promise) pending.push(record.promise);
      }
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /**
   * @param pi - Needed to run `git worktree prune`, which is async now and so
   *   cannot be reached through a stored spawn argument at shutdown. Omitting
   *   it (tests, teardown of a manager that never spawned) skips the prune.
   */
  async dispose(pi?: ExtensionAPI): Promise<void> {
    this.disposed = true;
    clearInterval(this.cleanupInterval);
    for (const controller of this.worktreeLifetimeControllers) controller.abort();
    this.worktreeLifetimeControllers.clear();
    // Clear queue — via dequeue, so anyone blocked in spawnAndWait is woken
    // rather than left awaiting a gate nothing will ever resolve.
    this.dequeue(() => true);
    const sessions = [...this.agents.values()].map(record => record.session);
    this.agents.clear();
    this.startups.clear();
    if (pi) {
      // Prune any orphaned git worktrees (crash recovery). Detached: dispose runs
      // on the shutdown path, which cannot wait for git. Started before the awaited
      // shutdown below rather than after it, so the git calls have that window to
      // finish in instead of racing the process exit that follows.
      const prune = (repo: string) => {
        const snapshot = this.guardBridgeHost.getResourceEnrollmentSnapshotIdentity();
        const hooks: WorktreeEffectHooks | undefined = this.guardBridgeHost.guardExpected ? {
          childId: "", parentWorkspace: repo,
          reviewEffect: (effect, entryPath) => this.reviewGuardEffect(effect, { entryPath, snapshot }),
          assertSnapshotActive: entryPath => this.assertGuardEffectSnapshotActive(snapshot, entryPath),
        } : undefined;
        (hooks ? pruneWorktrees(pi, repo, hooks) : pruneWorktrees(pi, repo)).catch(() => {});
      };
      prune(process.cwd());
      // Also prune repos that caller-supplied cwds created worktrees in — a clean
      // exit with in-flight agents would otherwise leave stale registrations there.
      for (const repo of this.worktreeRepos) prune(repo);
    }
    // Awaited, unlike the eviction path: pi awaits this extension's `session_shutdown`
    // handler and the process exits right after it returns, so anything left unawaited
    // here never runs at all. Bounded — each call carries its own ceiling, concurrently.
    await Promise.all(sessions.map(session => shutdownChildSession(session)));
  }
}
