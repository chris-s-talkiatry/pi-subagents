/**
 * schedule.ts — `SubagentScheduler`: timer-driven dispatcher of scheduled subagents.
 *
 * Mirrors the engine shape of pi-cron-schedule/src/scheduler.ts:
 *   - two-Map split (jobs = croner Cron, intervals = setInterval/setTimeout)
 *   - addJob/removeJob/updateJob/scheduleJob/unscheduleJob/executeJob
 *   - static parsers for cron / "+10m" / "5m" / ISO formats
 *
 * Differences vs pi-cron-schedule:
 *   - Persistence is via ScheduleStore (PID-locked, session-scoped, atomic).
 *   - `executeJob` calls `manager.spawn(..., { bypassQueue: true })` instead
 *     of dispatching a user message — schedule fires bypass maxConcurrent so
 *     a 5-minute interval can't be deferred behind 4 long-running agents.
 *   - Result delivery is implicit: spawn → background completion → existing
 *     `subagent-notification` followUp path. No new delivery code.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { nanoid } from "nanoid";
import type { AgentManager } from "./agent-manager.js";
import { normalizeMaxTurns } from "./agent-runner.js";
import { resolveSpawnType } from "./agent-types.js";
import {
  GuardBridgeRejection,
  type GuardOrigin,
  type GuardScheduleScope,
  type GuardScheduleScopeRequest,
} from "./guard-bridge.js";
import { resolveModel } from "./model-resolver.js";
import type { ScheduleStore } from "./schedule-store.js";

export const GUARDED_SCHEDULE_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const GUARDED_SCHEDULE_MAX_RUNS = 100;

const GUARDED_DISPATCH_FIELDS = [
  "name", "description", "schedule", "scheduleType", "intervalMs", "subagent_type", "prompt",
  "model", "thinking", "max_turns", "isolated", "isolation",
] as const satisfies readonly (keyof ScheduledSubagent)[];

type FrozenGuardedJob = {
  scopeId: string;
  expiresAt: string;
  maxRuns: number;
  dispatchValues: readonly unknown[];
};

function dispatchValues(job: ScheduledSubagent): readonly unknown[] {
  return GUARDED_DISPATCH_FIELDS.map(field => job[field]);
}

function sameDispatchValues(job: ScheduledSubagent, frozen: FrozenGuardedJob): boolean {
  const values = dispatchValues(job);
  return values.length === frozen.dispatchValues.length && values.every((value, index) => Object.is(value, frozen.dispatchValues[index]));
}

const GUARD_ORIGINS = [
  "human",
  "parent-model-delegation",
  "extension-request",
  "package-system-control",
  "imported-context",
  "tool-observation",
] as const satisfies readonly GuardOrigin[];

function isGuardOrigin(value: unknown): value is GuardOrigin {
  return typeof value === "string" && GUARD_ORIGINS.includes(value as GuardOrigin);
}

import type { IsolationMode, ScheduledSubagent, SubagentType, ThinkingLevel } from "./types.js";

/** Event emitted on `pi.events` for cross-extension consumers. */
export type ScheduleChangeEvent =
  | { type: "added"; job: ScheduledSubagent }
  | { type: "removed"; jobId: string }
  | { type: "updated"; job: ScheduledSubagent }
  | { type: "fired"; jobId: string; agentId: string; name: string }
  | { type: "error"; jobId: string; error: string };

/** Params accepted at job creation — ID, timestamps, and state are derived. */
export interface NewJobInput {
  name: string;
  description: string;
  schedule: string;
  subagent_type: SubagentType;
  prompt: string;
  sourceIngressId?: string;
  sourceOrigin?: GuardOrigin;
  requestedExpiresAt?: string;
  requestedMaxRuns?: number;

  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;
}

function boundedGuardFailureCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/\b(guard-[a-z0-9-]{1,80})\b/);
  return match?.[1];
}

function scheduleScopeFailure(): GuardBridgeRejection {
  return new GuardBridgeRejection(
    "guard-schedule-scope-failed",
    "agent-tool.schedule-create",
    "guard-schedule-scope-failed: guarded work is unavailable at agent-tool.schedule-create; the scheduled job was not created.",
  );
}

export class SubagentScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private store: ScheduleStore | undefined;
  private pi: ExtensionAPI | undefined;
  private ctx: ExtensionContext | undefined;
  private manager: AgentManager | undefined;
  /** Provenance for jobs created by this scheduler in the currently bound session. */
  private creationProvenance = new Map<string, { origin: GuardOrigin; ingressId?: string }>();
  /** Scope IDs created by this process; persisted values are always unresolved. */
  private liveScopeIds = new Map<string, { scopeId: string; snapshot?: object }>();
  /** Monotonic per-process guarded run counts prevent an edited file from lowering authority state. */
  private guardRunCounts = new Map<string, number>();
  /** Monotonic display counts for guarded jobs; persisted edits cannot roll back a live count. */
  private runCounts = new Map<string, number>();
  /** Immutable authority and dispatch snapshot for scopes minted by this process. */
  private guardedJobSnapshots = new Map<string, FrozenGuardedJob>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }
  /** Start the scheduler: bind to a session's store and arm enabled jobs. */
  start(pi: ExtensionAPI, ctx: ExtensionContext, manager: AgentManager, store: ScheduleStore): void {
    this.pi = pi;
    this.ctx = ctx;
    this.manager = manager;
    this.store = store;
    store.setGuardExpected(manager.guardBridgeHost?.guardExpected === true);
    this.creationProvenance.clear();
    this.liveScopeIds.clear();
    this.guardRunCounts.clear();
    this.runCounts.clear();
    this.guardedJobSnapshots.clear();

    for (const job of store.list()) {
      if (manager.guardBridgeHost?.guardExpected) {
        this.validateLoadedGuardJob(job);
        this.runCounts.set(job.id, Number.isSafeInteger(job.runCount) && job.runCount >= 0 ? job.runCount : 0);
        if (Number.isSafeInteger(job.guardRunCount) && (job.guardRunCount ?? -1) >= 0) {
          this.guardRunCounts.set(job.id, job.guardRunCount!);
        }
      }
      const refreshed = store.get(job.id) ?? job;
      if (refreshed.enabled) this.scheduleJob(refreshed);
    }
  }

  /** Stop all timers; drop refs. Safe to call repeatedly. */
  stop(): void {
    for (const cron of this.jobs.values()) cron.stop();
    this.jobs.clear();
    for (const t of this.intervals.values()) clearTimeout(t);
    this.intervals.clear();
    this.creationProvenance.clear();
    this.liveScopeIds.clear();
    this.guardRunCounts.clear();
    this.runCounts.clear();
    this.guardedJobSnapshots.clear();
    this.store = undefined;
    this.pi = undefined;
    this.ctx = undefined;
    this.manager = undefined;
  }


  /** True if start() has bound a store and the scheduler is active. */
  isActive(): boolean {
    return this.store !== undefined;
  }

  list(): ScheduledSubagent[] {
    return this.store?.list() ?? [];
  }

  /**
   * Build a `ScheduledSubagent` from user input. Validates the schedule
   * format and tags `scheduleType`. Throws on invalid input.
   */
  buildJob(input: NewJobInput): ScheduledSubagent {
    const detected = SubagentScheduler.detectSchedule(input.schedule);
    return {
      id: nanoid(10),
      name: input.name,
      description: input.description,
      schedule: detected.normalized,
      scheduleType: detected.type,
      intervalMs: detected.intervalMs,
      subagent_type: input.subagent_type,
      prompt: input.prompt,
      model: input.model,
      thinking: input.thinking,
      max_turns: input.max_turns,
      isolated: input.isolated,
      isolation: input.isolation,
      enabled: true,
      createdAt: new Date(this.now()).toISOString(),
      runCount: 0,
    };
  }

  /** Add a job, persist, and arm if enabled. Returns the stored job. */
  addJob(input: NewJobInput): ScheduledSubagent {
    const store = this.requireStore();
    if (store.hasName(input.name)) {
      throw new Error(`A scheduled job named "${input.name}" already exists.`);
    }
    const job = this.buildJob(input);
    store.add(job);
    if (isGuardOrigin(input.sourceOrigin)) {
      this.creationProvenance.set(job.id, {
        origin: input.sourceOrigin,
        ...(typeof input.sourceIngressId === "string" && input.sourceIngressId ? { ingressId: input.sourceIngressId } : {}),
      });
    }
    if (job.enabled) this.scheduleJob(job);

    this.emit({ type: "added", job });
    return job;
  }

  /** Create a guarded schedule only after the frozen guard mints bounded authority. */
  async addGuardedJob(
    input: NewJobInput,
    requestBase: Omit<GuardScheduleScopeRequest, "jobId" | "schedule" | "scheduleType" | "nextRun">,
    createScope: (request: GuardScheduleScopeRequest) => Promise<GuardScheduleScope>,
    assertScopeActive?: () => void,
    scopeSnapshot?: object,
  ): Promise<ScheduledSubagent> {
    const store = this.requireStore();
    if (store.hasName(input.name)) throw new Error(`A scheduled job named "${input.name}" already exists.`);
    const job = this.buildJob(input);
    const now = this.now();
    const policyExpiry = now + GUARDED_SCHEDULE_MAX_LIFETIME_MS;
    let requestedExpiry = policyExpiry;
    if (input.requestedExpiresAt !== undefined) {
      const parsed = Date.parse(input.requestedExpiresAt);
      if (!Number.isFinite(parsed) || parsed <= now) throw scheduleScopeFailure();
      requestedExpiry = Math.min(parsed, policyExpiry);
    }
    let requestedMaxRuns = GUARDED_SCHEDULE_MAX_RUNS;
    if (input.requestedMaxRuns !== undefined) {
      if (!Number.isSafeInteger(input.requestedMaxRuns) || input.requestedMaxRuns < 1) throw scheduleScopeFailure();
      requestedMaxRuns = Math.min(input.requestedMaxRuns, GUARDED_SCHEDULE_MAX_RUNS);
    }
    const nextRun = this.nextRunForJob(job, now);
    if (!nextRun) throw scheduleScopeFailure();
    const request: GuardScheduleScopeRequest = Object.freeze({
      ...requestBase,
      headless: !this.ctx?.hasUI,
      jobId: job.id,
      schedule: job.schedule,
      scheduleType: job.scheduleType,
      nextRun,
      ...(input.requestedExpiresAt !== undefined ? { requestedExpiresAt: input.requestedExpiresAt } : {}),
      ...(input.requestedMaxRuns !== undefined ? { requestedMaxRuns: input.requestedMaxRuns } : {}),
    });
    const scope = await createScope(request);
    assertScopeActive?.();
    if (store.hasName(input.name)) throw new Error(`A scheduled job named "${input.name}" already exists.`);
    const scopeExpiry = Date.parse(scope.expiresAt);
    if (!Number.isFinite(scopeExpiry) || scopeExpiry <= now || !Number.isSafeInteger(scope.maxRuns) || scope.maxRuns < 1) {
      throw scheduleScopeFailure();
    }
    job.guardScopeId = scope.scopeId;
    job.guardExpiresAt = new Date(Math.min(scopeExpiry, requestedExpiry)).toISOString();
    job.guardMaxRuns = Math.min(scope.maxRuns, requestedMaxRuns, GUARDED_SCHEDULE_MAX_RUNS);
    job.guardRunCount = 0;
    assertScopeActive?.();
    store.add(job);
    this.liveScopeIds.set(job.id, { scopeId: scope.scopeId, ...(scopeSnapshot ? { snapshot: scopeSnapshot } : {}) });
    this.guardRunCounts.set(job.id, 0);
    this.runCounts.set(job.id, 0);
    this.guardedJobSnapshots.set(job.id, Object.freeze({
      scopeId: scope.scopeId,
      expiresAt: job.guardExpiresAt,
      maxRuns: job.guardMaxRuns,
      dispatchValues: Object.freeze([...dispatchValues(job)]),
    }));
    this.creationProvenance.set(job.id, {
      origin: isGuardOrigin(input.sourceOrigin) ? input.sourceOrigin : "imported-context",
      ...(isGuardOrigin(input.sourceOrigin) ? { ingressId: requestBase.ingressId } : {}),
    });
    if (job.enabled) this.scheduleJob(job);
    this.emit({ type: "added", job });
    return job;
  }

  removeJob(id: string): boolean {
    const store = this.requireStore();
    if (!store.get(id)) return false;
    this.unscheduleJob(id);
    const ok = store.remove(id);
    if (ok) {
      this.creationProvenance.delete(id);
      this.liveScopeIds.delete(id);
      this.guardRunCounts.delete(id);
      this.runCounts.delete(id);
      this.guardedJobSnapshots.delete(id);
      this.emit({ type: "removed", jobId: id });
    }
    return ok;
  }

  /** Toggle / mutate a job. Re-arms based on the new `enabled` state. */
  updateJob(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    const store = this.requireStore();
    const updated = store.update(id, patch);
    if (!updated) return undefined;
    this.unscheduleJob(id);
    if (updated.enabled) this.scheduleJob(updated);
    this.emit({ type: "updated", job: updated });
    return updated;
  }

  /** Next-run time as ISO, or undefined if not currently armed. */
  getNextRun(jobId: string): string | undefined {
    const cron = this.jobs.get(jobId);
    if (cron) return cron.nextRun()?.toISOString();
    const job = this.store?.get(jobId);
    if (!job?.enabled) return undefined;
    if (job.scheduleType === "once") return job.schedule;
    if (job.scheduleType === "interval" && job.intervalMs) {
      // Before the first fire there's no `lastRun`, so fall back to "now" —
      // accurate at create time (setInterval was just armed) and within
      // intervalMs of correct in any pre-first-fire view.
      const base = job.lastRun ? new Date(job.lastRun).getTime() : this.now();
      return new Date(base + job.intervalMs).toISOString();
    }
    return undefined;
  }

  // ── Scheduling primitives ────────────────────────────────────────────

  private scheduleJob(job: ScheduledSubagent): void {
    const store = this.store;
    if (!store) return;
    try {
      if (job.scheduleType === "interval" && job.intervalMs) {
        const t = setInterval(() => this.executeJob(job.id), job.intervalMs);
        this.intervals.set(job.id, t);
      } else if (job.scheduleType === "once") {
        const target = new Date(job.schedule).getTime();
        const delay = target - this.now();
        if (delay > 0) {
          const t = setTimeout(() => {
            this.executeJob(job.id);
            // Auto-disable one-shots after they fire (mirrors pi-cron-schedule)
            store.update(job.id, { enabled: false });
            const updated = store.get(job.id);
            if (updated) this.emit({ type: "updated", job: updated });
          }, delay);
          this.intervals.set(job.id, t);
        } else {
          // Past timestamp — disable, mark error, never fire
          store.update(job.id, { enabled: false, lastStatus: "error" });
          this.emit({ type: "error", jobId: job.id, error: `Scheduled time ${job.schedule} is in the past` });
        }
      } else {
        const cron = new Cron(job.schedule, () => this.executeJob(job.id));
        this.jobs.set(job.id, cron);
      }
    } catch (err) {
      this.emit({ type: "error", jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }
    const t = this.intervals.get(id);
    if (t) {
      clearTimeout(t);
      clearInterval(t);
      this.intervals.delete(id);
    }
  }

  /**
   * Fire a job: persist running state, spawn (bypassing the concurrency
   * queue), persist completion. Fire-and-forget: the timer tick returns
   * immediately so other jobs keep firing.
   */
  private executeJob(id: string): void {
    const store = this.store;
    const pi = this.pi;
    const ctx = this.ctx;
    const manager = this.manager;
    if (!store || !pi || !ctx || !manager) return;
    let job = store.get(id);
    if (!job?.enabled) return;
    const guarded = manager.guardBridgeHost?.guardExpected === true;
    let runIndex: number | undefined;
    let localScope = false;
    if (guarded) {
      const frozen = this.guardedJobSnapshots.get(job.id);
      const liveScope = this.liveScopeIds.get(job.id);
      const snapshotMismatch = frozen !== undefined && (
        job.guardScopeId !== frozen.scopeId || job.guardExpiresAt !== frozen.expiresAt || job.guardMaxRuns !== frozen.maxRuns ||
        !sameDispatchValues(job, frozen)
      );
      if (snapshotMismatch) {
        this.markGuardSnapshotMismatch(job.id);
        return;
      }
      const effectiveScopeId = frozen?.scopeId ?? job.guardScopeId;
      const effectiveExpiryText = frozen?.expiresAt ?? job.guardExpiresAt;
      const effectiveMaxRuns = frozen?.maxRuns ?? job.guardMaxRuns;
      const storedRunCount = job.guardRunCount;
      const inMemoryRunCount = this.guardRunCounts.get(job.id) ?? 0;
      const validStoredRunCount = Number.isSafeInteger(storedRunCount) && (storedRunCount ?? -1) >= 0
        ? storedRunCount!
        : inMemoryRunCount;
      const guardRunCount = frozen ? inMemoryRunCount : Math.max(validStoredRunCount, inMemoryRunCount);
      const expiry = typeof effectiveExpiryText === "string" ? Date.parse(effectiveExpiryText) : Number.NaN;
      if (!effectiveScopeId || !Number.isFinite(expiry) || !Number.isSafeInteger(effectiveMaxRuns) ||
        (effectiveMaxRuns ?? 0) < 1 || (effectiveMaxRuns ?? GUARDED_SCHEDULE_MAX_RUNS + 1) > GUARDED_SCHEDULE_MAX_RUNS ||
        !Number.isSafeInteger(guardRunCount) || guardRunCount < 0 || guardRunCount > effectiveMaxRuns!) {
        this.markGuardExpired(job.id, "guard-schedule-scope-invalid");
        return;
      }
      if (expiry > this.now() + GUARDED_SCHEDULE_MAX_LIFETIME_MS) {
        this.markGuardExpired(job.id, "guard-schedule-scope-invalid");
        return;
      }
      if (expiry <= this.now()) {
        this.markGuardExpired(job.id, "guard-schedule-expired");
        return;
      }
      if (guardRunCount >= effectiveMaxRuns!) {
        this.markGuardExpired(job.id, "guard-schedule-max-runs");
        return;
      }
      runIndex = guardRunCount + 1;
      this.guardRunCounts.set(job.id, runIndex);
      localScope = frozen !== undefined && liveScope?.scopeId === frozen.scopeId &&
        (liveScope.snapshot === undefined || manager.guardBridgeHost?.getResourceEnrollmentSnapshotIdentity?.() === liveScope.snapshot);
      const updated = store.update(id, {
        ...(frozen ? {
          guardScopeId: frozen.scopeId,
          guardExpiresAt: frozen.expiresAt,
          guardMaxRuns: frozen.maxRuns,
        } : {}),
        guardRunCount: runIndex,
        lastStatus: "running",
      });
      if (updated) {
        job = updated;
        if (frozen && (job.guardScopeId !== frozen.scopeId || job.guardExpiresAt !== frozen.expiresAt ||
          job.guardMaxRuns !== frozen.maxRuns || !sameDispatchValues(job, frozen))) {
          this.markGuardSnapshotMismatch(job.id);
          return;
        }
      }
    } else {
      store.update(id, { lastStatus: "running" });
    }

    // Resolve model at fire time — registry contents may have changed since the
    // job was created (auth added/removed). Fall back silently to spawn-default
    // if resolution fails; the spawn path handles undefined model gracefully.
    let resolvedModel: any | undefined;
    if (job.model) {
      const r = resolveModel(job.model, ctx.modelRegistry);
      if (typeof r !== "string") resolvedModel = r;
    }

    let agentId: string;
    try {
      // Re-resolve at fire time against the registry as it stands. This does not
      // reload from disk (the scheduler has no reason to rebuild process-global
      // state from a timer), so it catches changes that went through /agents or
      // an Agent call — not a file deleted directly from a shell. The catch below turns
      // this into lastStatus: "error" plus an error event, like any other
      // fire-time failure.
      const dispatch = resolveSpawnType(job.subagent_type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      const provenance = localScope ? this.creationProvenance.get(job.id) : undefined;

      if (guarded && typeof manager.spawnScheduled !== "function") throw scheduleScopeFailure();
      const spawnOptions = {
        description: job.description,
        guardEntryPath: "scheduled-task.fire" as const,
        ...(guarded ? {
          ...(provenance?.ingressId ? { guardIngressId: provenance.ingressId } : {}),
          guardOrigin: localScope ? provenance?.origin ?? "parent-model-delegation" : "imported-context",
          scopeRef: this.guardedJobSnapshots.get(job.id)?.scopeId ?? job.guardScopeId,
          guardScopeRefStatus: localScope ? "provided" as const : "unresolved" as const,
          scheduled: {
            jobId: job.id,
            runIndex: runIndex!,
            expiresAt: this.guardedJobSnapshots.get(job.id)?.expiresAt ?? job.guardExpiresAt!,
          },
        } : {}),

        isBackground: true,
        bypassQueue: true,
        model: resolvedModel,
        maxTurns: job.max_turns,
        isolated: job.isolated,
        thinkingLevel: job.thinking,
        isolation: job.isolation,
        // A scheduled run has no tool call to build this, so without it the
        // conversation viewer shows nothing about how the job was configured.
        // The model is left out on purpose: agent-manager fills in the effective
        // one when the session reports it, and naming the pre-session pick here
        // would only be right until then.
        invocation: {
          thinking: job.thinking,
          // Normalized like the Agent tool's own snapshot: `0` means unlimited,
          // and rendering it as "max turns: 0" would read as a limit of none.
          maxTurns: normalizeMaxTurns(job.max_turns),
          isolated: job.isolated,
          runInBackground: true,
          isolation: job.isolation,
        },
      };
      agentId = guarded
        ? manager.spawnScheduled(pi, ctx, dispatch.type, job.prompt, spawnOptions)
        : manager.spawn(pi, ctx, dispatch.type, job.prompt, spawnOptions);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const reason = guarded ? boundedGuardFailureCode(error) : undefined;
      store.update(id, {
        lastRun: new Date(this.now()).toISOString(),
        lastStatus: "error",
        ...(reason ? { guardFailureReason: reason } : {}),
      });
      this.emit({ type: "error", jobId: id, error: reason ?? error });
      return;
    }

    this.emit({ type: "fired", jobId: id, agentId, name: job.name });

    const finalize = (status: "success" | "error", startupError?: unknown) => {
      const next = this.getNextRun(id);
      const current = store.get(id);
      const record = manager.getRecord(agentId);
      const failureReason = guarded && status === "error"
        ? boundedGuardFailureCode(record?.error) ?? boundedGuardFailureCode(startupError instanceof Error ? startupError.message : startupError)
        : undefined;
      const runCount = guarded
        ? (this.runCounts.get(id) ?? 0) + 1
        : (current?.runCount ?? 0) + 1;
      if (guarded) this.runCounts.set(id, runCount);
      store.update(id, {
        lastRun: new Date(this.now()).toISOString(),
        lastStatus: status,
        runCount,
        nextRun: next,
        ...(failureReason ? { guardFailureReason: failureReason } : {}),
      });
      if (failureReason) this.emit({ type: "error", jobId: id, error: failureReason });
      if (guarded && runIndex !== undefined && runIndex >= (this.guardedJobSnapshots.get(id)?.maxRuns ?? current?.guardMaxRuns ?? GUARDED_SCHEDULE_MAX_RUNS)) {
        this.markGuardExpired(id, "guard-schedule-max-runs");
      }
    };

    // AgentManager's promise resolves either way (its .catch returns ""), so we
    // can't infer success/failure from the promise — read record.status instead.
    // Terminal states: completed/steered = success; error/aborted/stopped = error.
    // awaitStartup first: with isolation: "worktree" the run promise only exists
    // once the repo copy is made, and a failed copy rejects here.
    manager.awaitStartup(agentId)
      .then(() => manager.getRecord(agentId)?.promise)
      .then(() => {
        const r = manager.getRecord(agentId);
        const failed = r?.status === "error" || r?.status === "aborted" || r?.status === "stopped";
        finalize(failed ? "error" : "success");
      })
      .catch(error => finalize("error", error));
  }

  private nextRunForJob(job: ScheduledSubagent, now: number): string | undefined {
    if (job.scheduleType === "once") return job.schedule;
    if (job.scheduleType === "interval" && job.intervalMs) return new Date(now + job.intervalMs).toISOString();
    try {
      const cron = new Cron(job.schedule, () => {});
      const next = cron.nextRun()?.toISOString();
      cron.stop();
      return next;
    } catch {
      return undefined;
    }
  }

  private validateLoadedGuardJob(job: ScheduledSubagent): void {
    const now = this.now();
    const expiresAt = typeof job.guardExpiresAt === "string" ? Date.parse(job.guardExpiresAt) : Number.NaN;
    const validRuns = Number.isSafeInteger(job.guardMaxRuns) && (job.guardMaxRuns ?? 0) >= 1 &&
      (job.guardMaxRuns ?? GUARDED_SCHEDULE_MAX_RUNS + 1) <= GUARDED_SCHEDULE_MAX_RUNS;
    const validRunCount = Number.isSafeInteger(job.guardRunCount) && (job.guardRunCount ?? -1) >= 0 &&
      (job.guardRunCount ?? Infinity) <= (job.guardMaxRuns ?? 0);
    if (!job.guardScopeId || typeof job.guardScopeId !== "string" || !job.guardScopeId.trim() || job.guardScopeId.length > 512 ||
      !Number.isFinite(expiresAt) || !validRuns || !validRunCount || expiresAt > now + GUARDED_SCHEDULE_MAX_LIFETIME_MS) {
      this.markGuardExpired(job.id, "guard-schedule-scope-invalid");
    } else if (expiresAt <= now) {
      this.markGuardExpired(job.id, "guard-schedule-expired");
    } else if (job.guardRunCount === job.guardMaxRuns) {
      this.markGuardExpired(job.id, "guard-schedule-max-runs");
    }
  }

  private markGuardSnapshotMismatch(id: string): void {
    const store = this.store;
    if (!store) return;
    this.unscheduleJob(id);
    store.update(id, {
      enabled: false,
      lastStatus: "expired",
      guardExpiryReason: "guard-schedule-snapshot-mismatch",
    });
    this.emit({ type: "error", jobId: id, error: "guard-schedule-snapshot-mismatch" });
  }

  private markGuardExpired(id: string, reason: "guard-schedule-scope-invalid" | "guard-schedule-expired" | "guard-schedule-max-runs"): void {
    const store = this.store;
    if (!store) return;
    const current = store.get(id);
    if (!current || current.lastStatus === "expired") return;
    this.unscheduleJob(id);
    store.update(id, { enabled: false, lastStatus: "expired", guardExpiryReason: reason });
    this.emit({ type: "error", jobId: id, error: reason });
  }

  private emit(event: ScheduleChangeEvent): void {
    if (this.pi) this.pi.events.emit("subagents:scheduled", event);
  }

  private requireStore(): ScheduleStore {
    if (!this.store) throw new Error("Scheduler not started — no active session.");
    return this.store;
  }

  // ── Format detection / parsers (statics — pure) ──────────────────────

  /**
   * Sniff a schedule string and tag its type. Throws on invalid input.
   * Order matters: relative ("+10m") and interval ("5m") both match digit+unit;
   * relative requires the leading "+" to disambiguate.
   */
  static detectSchedule(s: string): { type: "cron" | "once" | "interval"; intervalMs?: number; normalized: string } {
    const trimmed = s.trim();
    // "+10m" — relative one-shot
    const rel = SubagentScheduler.parseRelativeTime(trimmed);
    if (rel !== null) return { type: "once", normalized: rel };
    // "5m" — interval
    const ivl = SubagentScheduler.parseInterval(trimmed);
    if (ivl !== null) return { type: "interval", intervalMs: ivl, normalized: trimmed };
    // ISO timestamp — one-shot. Reject past timestamps upfront so we never
    // create a dead-on-arrival record (scheduleJob's safety net still catches
    // micro-races from `+0s`-style relatives).
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        if (d.getTime() <= Date.now()) {
          throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
        }
        return { type: "once", normalized: d.toISOString() };
      }
    }
    // Cron — 6-field
    const cronCheck = SubagentScheduler.validateCronExpression(trimmed);
    if (cronCheck.valid) return { type: "cron", normalized: trimmed };
    throw new Error(
      `Invalid schedule "${s}". Use 6-field cron (e.g. "0 0 9 * * 1" — 9am every Monday), interval ("5m"/"1h"), or one-shot ("+10m" / ISO).`
    );
  }

  /** 6-field cron — 'second minute hour dom month dow'. */
  static validateCronExpression(expr: string): { valid: boolean; error?: string } {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 0 9 * * 1" for 9am every Monday.`,
      };
    }
    try {
      // Croner validates by construction.
      new Cron(expr, () => {});
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : "Invalid cron expression" };
    }
  }

  /** "+10s"/"+5m"/"+1h"/"+2d" → ISO timestamp. */
  static parseRelativeTime(s: string): string | null {
    const m = s.match(/^\+(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const ms = parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
    return new Date(Date.now() + ms).toISOString();
  }

  /** "10s"/"5m"/"1h"/"2d" → milliseconds. */
  static parseInterval(s: string): number | null {
    const m = s.match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    return parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  }
}
