import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GUARD_SCHEDULE_FIRE_TIMEOUT_MS,
  GUARD_SCHEDULE_SCOPE_TIMEOUT_MS,
  GuardBridgeHost,
  type GuardBridgeRegistration,
  type GuardChildContext,
  type GuardChildContextRequest,
  type GuardScheduleScopeRequest,
  withGuardScheduleFireTimeout,
} from "../src/guard-bridge.js";
import { GUARDED_SCHEDULE_MAX_LIFETIME_MS, GUARDED_SCHEDULE_MAX_RUNS, SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

let temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories = [];
});

function tempStore(guardExpected = true): { directory: string; store: ScheduleStore; file: string } {
  const directory = mkdtempSync(join(tmpdir(), "guard-schedule-scope-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "jobs.json");
  return { directory, file, store: new ScheduleStore(file, { guardExpected }) };
}

function contextFor(request: GuardChildContextRequest, registration: GuardBridgeRegistration): GuardChildContext {
  return {
    rootId: "guard-root",
    parentId: request.parentId,
    childId: request.childId,
    delegationId: request.delegationId,
    taskId: "guard-task",
    scopeRevision: 1,
    executionEpoch: 2,
    resolvedRestrictions: [],
    origin: request.origin,
    bridgeRef: registration,
  };
}

function makeHost(options: {
  expected?: boolean;
  scheduleScope?: (request: GuardScheduleScopeRequest) => unknown;
  createChildContext?: (request: GuardChildContextRequest, registration: GuardBridgeRegistration) => unknown;
} = {}) {
  const host = new GuardBridgeHost();
  host.setGuardRegistrant("scope-guard");
  host.setGuardExpected(options.expected ?? true);
  let registration!: GuardBridgeRegistration;
  const callbacks: GuardBridgeRegistration["callbacks"] = {
    captureIngress: vi.fn(),
    enrollResource: vi.fn(),
    createChildContext: vi.fn((request: GuardChildContextRequest) =>
      options.createChildContext?.(request, registration) ?? contextFor(request, registration)),
    revalidate: vi.fn(() => "approval-needed"),
    approvalSettled: vi.fn(),
    approvalCancelled: vi.fn(),
    approvalExpired: vi.fn(),
    ...(options.scheduleScope ? { createScheduleScope: vi.fn(options.scheduleScope) as any } : {}),
  };
  registration = {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "1" },
    callbacks,
    createChildGuardExtension: vi.fn((_context, _injection) => () => {}),
  };
  host.register(registration);
  return { host, registration };
}

function scopeRequest(overrides: Partial<GuardScheduleScopeRequest> = {}): GuardScheduleScopeRequest {
  return {
    jobId: "job-1",
    ingressId: "ingress-1",
    schedule: "0 * * * * *",
    scheduleType: "cron",
    nextRun: "2030-01-01T00:01:00.000Z",
    origin: "parent-model-delegation",
    parentId: "root:session-1",
    headless: true,
    ...overrides,
  };
}

function scopeResult(now = Date.now(), overrides: Record<string, unknown> = {}) {
  return {
    scopeId: "opaque-schedule-scope",
    expiresAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
    maxRuns: 8,
    targetBindings: ["target:repo-read"],
    ...overrides,
  };
}

function fakeManager(host: GuardBridgeHost) {
  const calls: any[] = [];
  let sequence = 0;
  const record = { status: "completed", promise: Promise.resolve("") };
  return {
    calls,
    manager: {
      guardBridgeHost: host,
      spawn: vi.fn((_pi: unknown, _ctx: unknown, _type: string, _prompt: string, options: any) => {
        calls.push(options);
        sequence++;
        return `agent-${sequence}`;
      }),
      spawnScheduled: vi.fn((_pi: unknown, _ctx: unknown, _type: string, _prompt: string, options: any) => {
        calls.push(options);
        sequence++;
        return `agent-${sequence}`;
      }),
      awaitStartup: vi.fn(async () => {}),
      getRecord: vi.fn(() => record),
    } as any,
  };
}

function fire(scheduler: SubagentScheduler, jobId: string): void {
  (scheduler as any).executeJob(jobId);
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("guarded schedule scope creation", () => {
  it("passes exact creation facts and stores only the bounded opaque scope metadata", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host, registration } = makeHost({ scheduleScope: () => scopeResult(now, { expiresAt: new Date(now + 36 * 60 * 60 * 1000).toISOString(), maxRuns: 500 }) });
    const { store } = tempStore();
    const { manager } = fakeManager(host);
    const scheduler = new SubagentScheduler({ now: () => now });
    scheduler.start({ events: { emit: vi.fn() } } as any, { modelRegistry: {} } as any, manager, store);

    const job = await scheduler.addGuardedJob({
      name: "bounded", description: "bounded read", schedule: "1h", subagent_type: "general-purpose", prompt: "read only",
      sourceIngressId: "ingress-42", sourceOrigin: "parent-model-delegation",
    }, {
      ingressId: "ingress-42", origin: "parent-model-delegation", parentId: "root:session-1", headless: true,
    }, request => host.createScheduleScope(request));

    const callback = registration.callbacks.createScheduleScope as ReturnType<typeof vi.fn>;
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toEqual({
      jobId: job.id,
      ingressId: "ingress-42",
      schedule: "1h",
      scheduleType: "interval",
      nextRun: new Date(now + 60 * 60 * 1000).toISOString(),
      origin: "parent-model-delegation",
      parentId: "root:session-1",
      headless: true,
    });
    expect(job).toMatchObject({
      guardScopeId: "opaque-schedule-scope",
      guardExpiresAt: new Date(now + GUARDED_SCHEDULE_MAX_LIFETIME_MS).toISOString(),
      guardMaxRuns: GUARDED_SCHEDULE_MAX_RUNS,
      guardRunCount: 0,
    });
    const saved = JSON.parse(readFileSync((store as any).filePath, "utf8")).jobs[0];
    expect(saved).toMatchObject({
      guardScopeId: "opaque-schedule-scope",
      guardMaxRuns: GUARDED_SCHEDULE_MAX_RUNS,
      guardRunCount: 0,
    });
    expect(saved).not.toHaveProperty("targetBindings");
    expect(saved).not.toHaveProperty("scope");
    scheduler.stop();
  });

  it("uses a bounded default when absent and caps requested lifetime and max_runs", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host, registration } = makeHost({ scheduleScope: () => scopeResult(now, {
      expiresAt: new Date(now + 7 * GUARDED_SCHEDULE_MAX_LIFETIME_MS).toISOString(),
      maxRuns: GUARDED_SCHEDULE_MAX_RUNS * 4,
    }) });
    const { store } = tempStore();
    const { manager } = fakeManager(host);
    const scheduler = new SubagentScheduler({ now: () => now });
    scheduler.start({ events: { emit: vi.fn() } } as any, { modelRegistry: {} } as any, manager, store);
    const add = (overrides: Record<string, unknown> = {}) => scheduler.addGuardedJob({
      name: `default-${Math.random()}`, description: "bounded", schedule: "1h", subagent_type: "general-purpose", prompt: "p", ...overrides,
    } as any, { ingressId: "ingress-1", origin: "parent-model-delegation", parentId: "root:session", headless: false }, request => host.createScheduleScope(request));

    const defaultJob = await add();
    expect(defaultJob.guardExpiresAt).toBe(new Date(now + GUARDED_SCHEDULE_MAX_LIFETIME_MS).toISOString());
    expect(defaultJob.guardMaxRuns).toBe(GUARDED_SCHEDULE_MAX_RUNS);

    const explicitExpiry = new Date(now + GUARDED_SCHEDULE_MAX_LIFETIME_MS * 3).toISOString();
    const cappedJob = await add({ requestedExpiresAt: explicitExpiry, requestedMaxRuns: GUARDED_SCHEDULE_MAX_RUNS + 50 });
    expect(cappedJob.guardExpiresAt).toBe(new Date(now + GUARDED_SCHEDULE_MAX_LIFETIME_MS).toISOString());
    expect(cappedJob.guardMaxRuns).toBe(GUARDED_SCHEDULE_MAX_RUNS);
    expect((registration.callbacks.createScheduleScope as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({
      requestedExpiresAt: explicitExpiry,
      requestedMaxRuns: GUARDED_SCHEDULE_MAX_RUNS + 50,
    });

    const narrowJob = await add({ requestedExpiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(), requestedMaxRuns: 2 });
    expect(narrowJob.guardExpiresAt).toBe(new Date(now + 2 * 60 * 60 * 1000).toISOString());
    expect(narrowJob.guardMaxRuns).toBe(2);
    scheduler.stop();
  });

  it("fails closed for missing, throwing, invalid, aborted, timed-out, or replaced callbacks", async () => {
    const missing = makeHost();
    await expect(missing.host.createScheduleScope(scopeRequest())).rejects.toMatchObject({ reasonCode: "guard-schedule-scope-missing" });

    for (const callback of [
      () => { throw new Error("secret"); },
      () => Promise.reject(new Error("secret")),
      () => ({ scopeId: "id", expiresAt: "not-a-date", maxRuns: 1, targetBindings: ["target"] }),
    ]) {
      const configured = makeHost({ scheduleScope: callback });
      await expect(configured.host.createScheduleScope(scopeRequest())).rejects.toMatchObject({ reasonCode: "guard-schedule-scope-failed" });
    }

    vi.useFakeTimers();
    const never = makeHost({ scheduleScope: () => new Promise(() => {}) });
    const timedOut = never.host.createScheduleScope(scopeRequest());
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ reasonCode: "guard-schedule-scope-failed" });
    await vi.advanceTimersByTimeAsync(GUARD_SCHEDULE_SCOPE_TIMEOUT_MS);
    await timeoutAssertion;

    const controller = new AbortController();
    const aborted = never.host.createScheduleScope(scopeRequest(), controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ reasonCode: "guard-schedule-scope-failed" });
  });

  it("uses the frozen callback and rejects a replaced registration after callback settlement", async () => {
    const original = vi.fn(() => scopeResult());
    const configured = makeHost({ scheduleScope: original });
    const mutable = configured.registration.callbacks as any;
    mutable.createScheduleScope = vi.fn(() => scopeResult());
    await configured.host.createScheduleScope(scopeRequest());
    expect(original).toHaveBeenCalledTimes(1);
    expect(mutable.createScheduleScope).not.toHaveBeenCalled();

    let resolve!: (value: unknown) => void;
    const pending = makeHost({ scheduleScope: () => new Promise(resolveResult => { resolve = resolveResult; }) });
    const operation = pending.host.createScheduleScope(scopeRequest());
    await Promise.resolve();
    pending.host.unregister();
    const replacement = makeHost();
    pending.host.setGuardRegistrant("scope-guard");
    pending.host.register(replacement.registration);
    resolve(scopeResult());
    await expect(operation).rejects.toMatchObject({ reasonCode: "guard-schedule-scope-failed" });
  });
});

describe("guarded schedule fire", () => {
  it("passes local scope, scheduled run metadata and increments the run index", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host } = makeHost({ scheduleScope: () => scopeResult(now, { maxRuns: 3 }) });
    const { store } = tempStore(false);
    const { manager, calls } = fakeManager(host);
    const scheduler = new SubagentScheduler({ now: () => now });
    scheduler.start({ events: { emit: vi.fn() } } as any, { modelRegistry: {} } as any, manager, store);
    const job = await scheduler.addGuardedJob({
      name: "local", description: "local", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
      sourceIngressId: "creation-ingress", sourceOrigin: "parent-model-delegation",
    }, { ingressId: "creation-ingress", origin: "parent-model-delegation", parentId: "root:session", headless: false }, request => host.createScheduleScope(request));

    fire(scheduler, job.id);
    await flushPromises();
    fire(scheduler, job.id);
    await flushPromises();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      guardOrigin: "parent-model-delegation",
      guardIngressId: "creation-ingress",
      scopeRef: "opaque-schedule-scope",
      guardScopeRefStatus: "provided",
      scheduled: { jobId: job.id, runIndex: 1, expiresAt: job.guardExpiresAt },
    });
    expect(calls[1].scheduled).toMatchObject({ jobId: job.id, runIndex: 2 });
    expect(store.get(job.id)?.guardRunCount).toBe(2);
    expect(store.get(job.id)?.lastStatus).toBe("success");
    expect(store.get(job.id)?.runCount).toBe(2);
    scheduler.stop();
  });

  it("expires after its deadline or run ceiling, never starts again, and notifies once", async () => {
    let now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host } = makeHost({ scheduleScope: () => scopeResult(now, { maxRuns: 1 }) });
    const { store } = tempStore();
    const { manager, calls } = fakeManager(host);
    const pi = { events: { emit: vi.fn() } } as any;
    const scheduler = new SubagentScheduler({ now: () => now });
    scheduler.start(pi, { modelRegistry: {} } as any, manager, store);
    const job = await scheduler.addGuardedJob({
      name: "expires", description: "expires", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
    }, { ingressId: "ingress", origin: "parent-model-delegation", parentId: "root:session", headless: true }, request => host.createScheduleScope(request));

    fire(scheduler, job.id);
    await flushPromises();
    expect(calls).toHaveLength(1);
    expect(store.get(job.id)?.lastStatus).toBe("expired");
    expect(store.get(job.id)?.guardExpiryReason).toBe("guard-schedule-max-runs");
    fire(scheduler, job.id);
    expect(calls).toHaveLength(1);
    const expirationEvents = pi.events.emit.mock.calls.filter(([, event]: any[]) => event?.type === "error" && event.jobId === job.id);
    expect(expirationEvents).toHaveLength(1);
    (scheduler as any).markGuardExpired(job.id, "guard-schedule-expired");
    const repeatedExpirationEvents = pi.events.emit.mock.calls.filter(([, event]: any[]) => event?.type === "error" && event.jobId === job.id);
    expect(repeatedExpirationEvents).toHaveLength(1);

    const expiryJob = await scheduler.addGuardedJob({
      name: "deadline", description: "deadline", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
      requestedExpiresAt: new Date(now + 1_000).toISOString(),
    }, { ingressId: "ingress-2", origin: "parent-model-delegation", parentId: "root:session", headless: true }, request => host.createScheduleScope({
      ...request,
      // The guard's requested expiry is allowed to be stricter than the default.
      requestedExpiresAt: new Date(now + 1_000).toISOString(),
    }));
    now += 1_001;
    fire(scheduler, expiryJob.id);
    expect(store.get(expiryJob.id)?.guardExpiryReason).toBe("guard-schedule-expired");
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });

  it("loads a prior-session scope as unresolved and refuses forged future expiry / limits", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host } = makeHost({ scheduleScope: () => scopeResult(now) });
    const { store, file } = tempStore();
    const firstScheduler = new SubagentScheduler({ now: () => now });
    const firstManager = fakeManager(host).manager;
    firstScheduler.start({ events: { emit: vi.fn() } } as any, { modelRegistry: {} } as any, firstManager, store);
    const job = await firstScheduler.addGuardedJob({
      name: "restored", description: "restored", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
      sourceIngressId: "original-ingress", sourceOrigin: "human",
    }, { ingressId: "original-ingress", origin: "human", parentId: "root:session", headless: true }, request => host.createScheduleScope(request));
    firstScheduler.stop();

    const secondScheduler = new SubagentScheduler({ now: () => now });
    const { manager, calls } = fakeManager(host);
    secondScheduler.start({ events: { emit: vi.fn() } } as any, { modelRegistry: {} } as any, manager, new ScheduleStore(file, { guardExpected: true }));
    fire(secondScheduler, job.id);
    await flushPromises();
    expect(calls[0]).toMatchObject({
      guardOrigin: "imported-context",
      scopeRef: "opaque-schedule-scope",
      guardScopeRefStatus: "unresolved",
      scheduled: { jobId: job.id, runIndex: 1 },
    });
    expect(calls[0]).not.toHaveProperty("guardIngressId");
    secondScheduler.stop();

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    onDisk.jobs[0].guardScopeId = "forged-scope";
    onDisk.jobs[0].guardExpiresAt = new Date(now + GUARDED_SCHEDULE_MAX_LIFETIME_MS * 1000).toISOString();
    onDisk.jobs[0].guardMaxRuns = 1_000_000;
    onDisk.jobs[0].origin = "human";
    onDisk.jobs[0].sourceOrigin = "human";
    onDisk.jobs[0].sourceIngressId = "forged-ingress";
    onDisk.jobs[0].extraAuthority = { approved: true };
    writeFileSync(file, JSON.stringify(onDisk));

    const forgedScheduler = new SubagentScheduler({ now: () => now });
    const forgedManager = fakeManager(host);
    const forgedPi = { events: { emit: vi.fn() } } as any;
    const forgedStore = new ScheduleStore(file, { guardExpected: true });
    forgedScheduler.start(forgedPi, { modelRegistry: {} } as any, forgedManager.manager, forgedStore);
    expect(forgedStore.get(job.id)).not.toHaveProperty("extraAuthority");
    expect(forgedStore.get(job.id)).not.toHaveProperty("origin");
    expect(forgedStore.get(job.id)).not.toHaveProperty("sourceOrigin");
    fire(forgedScheduler, job.id);
    expect(forgedManager.calls).toHaveLength(0);
    expect(forgedScheduler.list()[0]).toMatchObject({
      enabled: false,
      lastStatus: "expired",
      guardExpiryReason: "guard-schedule-scope-invalid",
    });
    expect(forgedPi.events.emit).toHaveBeenCalledTimes(1);
    forgedScheduler.stop();
  });

  it("disables an edited expiry beyond the policy cap even when every other field is valid", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host } = makeHost({ scheduleScope: () => scopeResult(now) });
    const { store, file } = tempStore();
    const creator = new SubagentScheduler({ now: () => now });
    const creatorManager = fakeManager(host).manager;
    creator.start({ events: { emit: vi.fn() } } as any, { modelRegistry: {} } as any, creatorManager, store);
    const job = await creator.addGuardedJob({
      name: "expiry-cap", description: "expiry-cap", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
    }, { ingressId: "ingress", origin: "parent-model-delegation", parentId: "root:session", headless: false }, request => host.createScheduleScope(request));
    creator.stop();

    const data = JSON.parse(readFileSync(file, "utf8"));
    data.jobs[0].guardExpiresAt = new Date(now + GUARDED_SCHEDULE_MAX_LIFETIME_MS * 2).toISOString();
    writeFileSync(file, JSON.stringify(data));
    const pi = { events: { emit: vi.fn() } } as any;
    const imported = new SubagentScheduler({ now: () => now });
    imported.start(pi, { modelRegistry: {} } as any, fakeManager(host).manager, new ScheduleStore(file, { guardExpected: true }));
    expect(imported.list().find(item => item.id === job.id)).toMatchObject({
      enabled: false,
      lastStatus: "expired",
      guardExpiryReason: "guard-schedule-scope-invalid",
      guardMaxRuns: 8,
    });
    expect(pi.events.emit).toHaveBeenCalledTimes(1);
    imported.stop();
  });

  it("disables an edited maxRuns above the hard ceiling when expiry is still within bounds", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host } = makeHost({ scheduleScope: () => scopeResult(now) });
    const { store, file } = tempStore();
    const creator = new SubagentScheduler({ now: () => now });
    creator.start({ events: { emit: vi.fn() } } as any, { modelRegistry: {} } as any, fakeManager(host).manager, store);
    const job = await creator.addGuardedJob({
      name: "max-run-cap", description: "max-run-cap", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
    }, { ingressId: "ingress", origin: "parent-model-delegation", parentId: "root:session", headless: false }, request => host.createScheduleScope(request));
    creator.stop();

    const data = JSON.parse(readFileSync(file, "utf8"));
    data.jobs[0].guardMaxRuns = GUARDED_SCHEDULE_MAX_RUNS + 1;
    writeFileSync(file, JSON.stringify(data));
    const imported = new SubagentScheduler({ now: () => now });
    const pi = { events: { emit: vi.fn() } } as any;
    imported.start(pi, { modelRegistry: {} } as any, fakeManager(host).manager, new ScheduleStore(file, { guardExpected: true }));
    expect(imported.list().find(item => item.id === job.id)).toMatchObject({
      enabled: false,
      lastStatus: "expired",
      guardExpiryReason: "guard-schedule-scope-invalid",
      guardExpiresAt: job.guardExpiresAt,
    });
    expect(pi.events.emit).toHaveBeenCalledTimes(1);
    imported.stop();
  });

  it("bounds a scheduled fire that cannot obtain child context", async () => {
    vi.useFakeTimers();
    const pending = withGuardScheduleFireTimeout(new Promise<never>(() => {}), "scheduled-task.fire");
    const timeoutAssertion = expect(pending).rejects.toMatchObject({
      name: "GuardBridgeRejection",
      reasonCode: "guard-child-context-failed",
      entryPath: "scheduled-task.fire",
    });
    await vi.advanceTimersByTimeAsync(GUARD_SCHEDULE_FIRE_TIMEOUT_MS);
    await timeoutAssertion;
  });
});

describe("guard-off schedule compatibility", () => {
  it("does not call the optional callback or add authority metadata to jobs or spawn options", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host, registration } = makeHost({ expected: false, scheduleScope: () => scopeResult(now) });
    const { store } = tempStore();
    const { manager, calls } = fakeManager(host);
    const scheduler = new SubagentScheduler({ now: () => now });
    const pi = { events: { emit: vi.fn() } } as any;
    scheduler.start(pi, { modelRegistry: {} } as any, manager, store);
    const job = scheduler.addJob({
      name: "upstream", description: "upstream", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
      requestedExpiresAt: new Date(now + 5_000).toISOString(), requestedMaxRuns: 2,
    });
    expect(registration.callbacks.createScheduleScope).not.toHaveBeenCalled();
    expect(job).not.toHaveProperty("guardScopeId");
    expect(job).not.toHaveProperty("guardExpiresAt");
    expect(job).not.toHaveProperty("guardMaxRuns");
    expect(job).not.toHaveProperty("guardRunCount");
    fire(scheduler, job.id);
    await flushPromises();
    expect(calls).toHaveLength(1);
    for (const key of ["guardOrigin", "guardIngressId", "scopeRef", "guardScopeRefStatus", "scheduled", "headless"]) {
      expect(calls[0]).not.toHaveProperty(key);
    }
    scheduler.stop();
  });
});

describe("guarded schedule dispatch revalidation", () => {
  it("marks a scope unresolved after the registration snapshot changes before fire (N12)", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host } = makeHost({ scheduleScope: () => scopeResult(now) });
    const scopeSnapshot = host.getResourceEnrollmentSnapshotIdentity()!;
    const { store } = tempStore(true);
    const { manager, calls } = fakeManager(host);
    const scheduler = new SubagentScheduler({ now: () => now });
    scheduler.start({ events: { emit: vi.fn() } } as any, { modelRegistry: {} } as any, manager, store);
    const job = await scheduler.addGuardedJob({
      name: "registration-replaced", description: "revalidate origin", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p", sourceIngressId: "creation-ingress",
      sourceOrigin: "parent-model-delegation",
    }, {
      ingressId: "creation-ingress", origin: "parent-model-delegation", parentId: "root:session", headless: false,
    }, request => host.createScheduleScope(request, undefined, scopeSnapshot),
    () => host.assertScheduleScopeSnapshotActive(scopeSnapshot), scopeSnapshot);

    const replacement = makeHost().registration;
    host.unregister();
    expect(host.register(replacement).compatible).toBe(true);
    fire(scheduler, job.id);
    await flushPromises();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      guardOrigin: "imported-context",
      guardScopeRefStatus: "unresolved",
    });
    expect(calls[0]).not.toHaveProperty("guardIngressId");
    scheduler.stop();
  });

  it("disables a job whose persisted prompt changed after it was loaded, before dispatch", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { host } = makeHost({ scheduleScope: () => scopeResult(now) });
    const { store, file } = tempStore(true);
    const { manager, calls } = fakeManager(host);
    const events: any[] = [];
    const scheduler = new SubagentScheduler({ now: () => now });
    scheduler.start({ events: { emit: (_name: string, event: any) => events.push(event) } } as any,
      { modelRegistry: {} } as any, manager, store);
    const job = await scheduler.addGuardedJob({
      name: "edited-on-disk", description: "immutable dispatch", schedule: "1h",
      subagent_type: "general-purpose", prompt: "ORIGINAL",
    }, {
      ingressId: "ingress", origin: "parent-model-delegation", parentId: "root:session", headless: true,
    }, request => host.createScheduleScope(request));

    // The scheduler keeps its loaded object in memory. ScheduleStore.update
    // re-reads disk under lock; this simulates a direct edit after that load.
    const disk = JSON.parse(readFileSync(file, "utf8"));
    disk.jobs[0].prompt = "FORGED";
    writeFileSync(file, JSON.stringify(disk));
    fire(scheduler, job.id);
    await flushPromises();

    expect(calls).toHaveLength(0);
    expect(manager.spawnScheduled).not.toHaveBeenCalled();
    expect(store.get(job.id)).toMatchObject({
      prompt: "FORGED",
      enabled: false,
      lastStatus: "expired",
      guardExpiryReason: "guard-schedule-snapshot-mismatch",
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "error", error: "guard-schedule-snapshot-mismatch" }));
    scheduler.stop();
  });
});

describe("headless fact propagation", () => {
  it.each([false, true])("derives scheduled-scope headless from ExtensionContext.hasUI=%s", async hasUI => {
    const requests: GuardScheduleScopeRequest[] = [];
    const { host } = makeHost({ scheduleScope: request => {
      requests.push(request);
      return scopeResult();
    } });
    const { store } = tempStore(true);
    const scheduler = new SubagentScheduler();
    const manager = fakeManager(host).manager;
    const pi = { events: { emit: vi.fn() } } as any;
    scheduler.start(pi, { modelRegistry: {}, hasUI } as any, manager, store);
    await scheduler.addGuardedJob({
      name: `headless-${hasUI}`, description: "headless", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    }, {
      ingressId: "ingress", origin: "parent-model-delegation", parentId: "root:session",
      headless: hasUI, // Deliberately contradict the bound ExtensionContext.
    }, request => host.createScheduleScope(request));
    expect(requests[0]?.headless).toBe(!hasUI);
    scheduler.stop();
  });
});
