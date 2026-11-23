import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/agent-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/agent-runner.js")>();
  return { ...actual, runAgent: runnerMocks.runAgent, resumeAgent: runnerMocks.resumeAgent };
});

import { AgentManager } from "../src/agent-manager.js";
import { GuardBridgeHost, type GuardBridgeRegistration, type GuardChildContextRequest, type GuardEffectDescription, type GuardEffectRequest } from "../src/guard-bridge.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

const directories: string[] = [];
const managers: AgentManager[] = [];
afterEach(async () => {
  vi.useRealTimers();
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function temporaryGitRepo(prefix: string): string {
  const repo = temporaryDirectory(prefix);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Round One Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "round-one@example.invalid"], { cwd: repo });
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  return repo;
}

function createHost(options: {
  now: () => number;
  maxRuns?: number;
  ttlMs?: number;
  reviewEffect?: (request: GuardEffectRequest) => unknown;
}): GuardBridgeHost {
  const host = new GuardBridgeHost();
  host.setGuardRegistrant("scope-guard");
  host.setGuardExpected(true);
  let registration!: GuardBridgeRegistration;
  registration = {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "test" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource: vi.fn(),
      createChildContext: vi.fn((request: GuardChildContextRequest) => ({
        rootId: "root",
        parentId: request.parentId,
        childId: request.childId,
        delegationId: request.delegationId,
        taskId: "task",
        scopeRevision: 1,
        executionEpoch: 1,
        resolvedRestrictions: [],
        origin: request.origin,
        bridgeRef: registration,
      })),
      revalidate: vi.fn(() => "allowed" as const),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
      createScheduleScope: vi.fn(request => ({
        scopeId: `minted-${request.jobId}`,
        expiresAt: new Date(options.now() + (options.ttlMs ?? 60 * 60_000)).toISOString(),
        maxRuns: options.maxRuns ?? 2,
        targetBindings: ["target:bounded"],
      })),
      ...(options.reviewEffect ? { reviewEffect: vi.fn(options.reviewEffect) as any } : { reviewEffect: vi.fn(() => "allowed" as const) }),
    },
    createChildGuardExtension: vi.fn(() => () => {}),
  };
  host.register(registration);
  return host;
}

function fakeScheduleManager(host: GuardBridgeHost) {
  const calls: any[] = [];
  let sequence = 0;
  const record = { status: "completed", promise: Promise.resolve("") };
  const spawnScheduled = vi.fn((_pi: unknown, _ctx: unknown, _type: string, _prompt: string, options: any) => {
    calls.push(options);
    return `scheduled-agent-${++sequence}`;
  });
  return {
    calls,
    manager: {
      guardBridgeHost: host,
      spawn: vi.fn(),
      spawnScheduled,
      awaitStartup: vi.fn(async () => {}),
      getRecord: vi.fn(() => record),
    } as any,
  };
}

function scheduleFixture(options: { now?: () => number; maxRuns?: number; ttlMs?: number } = {}) {
  let now = Date.now();
  const nowFn = options.now ?? (() => now);
  const host = createHost({ now: nowFn, maxRuns: options.maxRuns, ttlMs: options.ttlMs });
  const directory = temporaryDirectory("round1-schedule-");
  const file = join(directory, "jobs.json");
  const store = new ScheduleStore(file, { guardExpected: true });
  const { manager, calls } = fakeScheduleManager(host);
  const scheduler = new SubagentScheduler({ now: nowFn });
  const pi = { events: { emit: vi.fn() } } as any;
  const ctx = { modelRegistry: {}, hasUI: true } as any;
  scheduler.start(pi, ctx, manager, store);
  return {
    calls,
    file,
    host,
    manager,
    now: (value?: number) => { if (value !== undefined) now = value; return now; },
    pi,
    scheduler,
    store,
  };
}

async function addGuardedJob(scheduler: SubagentScheduler, host: GuardBridgeHost, name: string, prompt = "original prompt") {
  return scheduler.addGuardedJob({
    name,
    description: name,
    schedule: "1h",
    subagent_type: "general-purpose",
    prompt,
    sourceIngressId: `ingress-${name}`,
    sourceOrigin: "human",
  }, {
    ingressId: `ingress-${name}`,
    origin: "human",
    parentId: "root:session",
    headless: false,
  }, request => host.createScheduleScope(request));
}

async function fire(scheduler: SubagentScheduler, id: string): Promise<void> {
  (scheduler as any).executeJob(id);
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

describe("guarded schedule disk-forgery defenses", () => {
  it("does not extend a minted expiry or run limit from an in-session disk edit (R1)", async () => {
    const fixture = scheduleFixture({ maxRuns: 2, ttlMs: 60 * 60_000 });
    const { scheduler, host, store, file, calls } = fixture;
    const job = await addGuardedJob(scheduler, host, "r1");
    await fire(scheduler, job.id);
    expect(calls).toHaveLength(1);

    const persisted = JSON.parse(readFileSync(file, "utf8"));
    const forged = persisted.jobs.find((item: any) => item.id === job.id);
    forged.guardMaxRuns = 100;
    forged.guardExpiresAt = new Date(fixture.now() + 23 * 60 * 60_000).toISOString();
    writeFileSync(file, JSON.stringify(persisted));
    store.add({
      id: "unrelated", name: "unrelated", description: "unrelated", schedule: "1h", scheduleType: "interval",
      intervalMs: 60 * 60_000, subagent_type: "general-purpose", prompt: "p", enabled: false,
      createdAt: new Date(fixture.now()).toISOString(), runCount: 0,
    });

    await fire(scheduler, job.id);
    expect(calls).toHaveLength(1);
    expect(store.get(job.id)).toMatchObject({
      enabled: false,
      lastStatus: "expired",
      guardExpiryReason: "guard-schedule-snapshot-mismatch",
    });
    scheduler.stop();
  });

  it("disables a minted job whose dispatch prompt changes on disk (R2)", async () => {
    const fixture = scheduleFixture();
    const { scheduler, host, store, file, calls } = fixture;
    const job = await addGuardedJob(scheduler, host, "r2", "read only");
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    persisted.jobs[0].prompt = "git push --force origin main";
    writeFileSync(file, JSON.stringify(persisted));
    store.add({
      id: "unrelated", name: "unrelated", description: "unrelated", schedule: "1h", scheduleType: "interval",
      intervalMs: 60 * 60_000, subagent_type: "general-purpose", prompt: "p", enabled: false,
      createdAt: new Date(fixture.now()).toISOString(), runCount: 0,
    });

    await fire(scheduler, job.id);
    expect(calls).toHaveLength(0);
    expect(store.get(job.id)).toMatchObject({ enabled: false, guardExpiryReason: "guard-schedule-snapshot-mismatch" });
    scheduler.stop();
  });

  it("rechecks unique job names after concurrent scope creation returns (R10)", async () => {
    const fixture = scheduleFixture();
    const { scheduler, store } = fixture;
    const resolvers: Array<(scope: any) => void> = [];
    const createScope = (_request: any) => new Promise(resolve => {
      resolvers.push(scope => resolve(scope));
    });
    const input = {
      name: "same-name", description: "same", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
    };
    const requestBase = { ingressId: "i", origin: "human" as const, parentId: "root:session", headless: false };
    const first = scheduler.addGuardedJob(input, requestBase, createScope);
    const second = scheduler.addGuardedJob(input, requestBase, createScope);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers.forEach((resolve, index) => {
      resolve({
        scopeId: `scope-${index}`, expiresAt: new Date(fixture.now() + 60 * 60_000).toISOString(),
        maxRuns: 2, targetBindings: ["target:bounded"],
      });
    });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(store.list().filter(job => job.name === "same-name")).toHaveLength(1);
    scheduler.stop();
  });

  it("uses the monotonic in-memory run count after a file reset (M5)", async () => {
    const fixture = scheduleFixture({ maxRuns: 3 });
    const { scheduler, host, store, file, calls } = fixture;
    const job = await addGuardedJob(scheduler, host, "m5");
    await fire(scheduler, job.id);
    await fire(scheduler, job.id);
    expect(calls.map(call => call.scheduled.runIndex)).toEqual([1, 2]);

    const persisted = JSON.parse(readFileSync(file, "utf8"));
    const resetJob = persisted.jobs.find((item: any) => item.id === job.id);
    resetJob.guardRunCount = 0;
    resetJob.runCount = 0;
    writeFileSync(file, JSON.stringify(persisted));
    store.add({
      id: "unrelated", name: "unrelated", description: "unrelated", schedule: "1h", scheduleType: "interval",
      intervalMs: 60 * 60_000, subagent_type: "general-purpose", prompt: "p", enabled: false,
      createdAt: new Date(fixture.now()).toISOString(), runCount: 0,
    });
    await fire(scheduler, job.id);
    await fire(scheduler, job.id);
    expect(calls.map(call => call.scheduled.runIndex)).toEqual([1, 2, 3]);
    expect(store.get(job.id)).toMatchObject({ lastStatus: "expired", guardRunCount: 3, runCount: 3 });
    scheduler.stop();
  });

  it("enforces the 24-hour cap again at fire time for imported data (M7)", async () => {
    const now = Date.now();
    const fixture = scheduleFixture({ now: () => now });
    const imported = {
      id: "imported", name: "imported", description: "imported", schedule: "1h", scheduleType: "interval",
      intervalMs: 60 * 60_000, subagent_type: "general-purpose", prompt: "p", enabled: true,
      createdAt: new Date(now).toISOString(), guardScopeId: "imported-scope",
      guardExpiresAt: new Date(now + 12 * 60 * 60_000).toISOString(), guardMaxRuns: 4, guardRunCount: 0,
      runCount: 0,
    };
    writeFileSync(fixture.file, JSON.stringify({ version: 1, jobs: [imported] }));
    const store = new ScheduleStore(fixture.file, { guardExpected: true });
    fixture.scheduler.stop();
    const scheduler = new SubagentScheduler({ now: () => now });
    scheduler.start(fixture.pi, { modelRegistry: {}, hasUI: true } as any, fixture.manager, store);
    const edited = JSON.parse(readFileSync(fixture.file, "utf8"));
    edited.jobs[0].guardExpiresAt = new Date(now + 25 * 60 * 60_000).toISOString();
    writeFileSync(fixture.file, JSON.stringify(edited));
    store.add({
      id: "unrelated", name: "unrelated", description: "unrelated", schedule: "1h", scheduleType: "interval",
      intervalMs: 60 * 60_000, subagent_type: "general-purpose", prompt: "p", enabled: false,
      createdAt: new Date(now).toISOString(), runCount: 0,
    });
    await fire(scheduler, "imported");
    expect(fixture.calls).toHaveLength(0);
    expect(store.get("imported")).toMatchObject({ enabled: false, guardExpiryReason: "guard-schedule-scope-invalid" });
    scheduler.stop();
  });

  it("drops unsafe authority and extra keys, including __proto__, NaN-like, negative, and huge values", () => {
    const directory = temporaryDirectory("round1-invalid-scope-");
    const file = join(directory, "jobs.json");
    writeFileSync(file, `{"version":1,"__proto__":{"polluted":true},"jobs":[
      {"id":"huge","name":"huge","description":"x","schedule":"1h","scheduleType":"interval","intervalMs":3600000,"subagent_type":"general-purpose","prompt":"p","enabled":true,"createdAt":"${new Date().toISOString()}","guardScopeId":"s","guardExpiresAt":"${new Date(Date.now()+3600000).toISOString()}","guardMaxRuns":1e100,"guardRunCount":0,"runCount":0,"extraAuthority":{"approved":true},"__proto__":{"polluted":true}},
      {"id":"negative","name":"negative","description":"x","schedule":"1h","scheduleType":"interval","intervalMs":3600000,"subagent_type":"general-purpose","prompt":"p","enabled":true,"createdAt":"${new Date().toISOString()}","guardScopeId":"s","guardExpiresAt":"${new Date(Date.now()+3600000).toISOString()}","guardMaxRuns":-1,"guardRunCount":0,"runCount":0},
      {"id":"nan","name":"nan","description":"x","schedule":"1h","scheduleType":"interval","intervalMs":3600000,"subagent_type":"general-purpose","prompt":"p","enabled":true,"createdAt":"${new Date().toISOString()}","guardScopeId":"s","guardExpiresAt":"${new Date(Date.now()+3600000).toISOString()}","guardMaxRuns":null,"guardRunCount":0,"runCount":0}
    ]}`);
    const store = new ScheduleStore(file, { guardExpected: true });
    expect(store.get("huge")).not.toHaveProperty("extraAuthority");
    expect(store.get("huge")).not.toHaveProperty("__proto__");
    expect(({} as any).polluted).toBeUndefined();
    const host = createHost({ now: Date.now });
    const fake = fakeScheduleManager(host).manager;
    const scheduler = new SubagentScheduler();
    scheduler.start({ events: { emit: vi.fn() } } as any, { modelRegistry: {}, hasUI: false } as any, fake, store);
    for (const id of ["huge", "negative", "nan"]) {
      expect(store.get(id)).toMatchObject({ enabled: false, lastStatus: "expired", guardExpiryReason: "guard-schedule-scope-invalid" });
    }
    scheduler.stop();
  });
});

describe("schedule-store guard-off compatibility", () => {
  it("preserves unknown keys and their original order when the guard is off", () => {
    const directory = temporaryDirectory("round1-store-order-");
    const file = join(directory, "jobs.json");
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [{ id: "job", zeta: 1, name: "before", extra: 2, prompt: "p" }] }, null, 2));
    const store = new ScheduleStore(file);
    expect(Object.keys(store.get("job")!)).toEqual(["id", "zeta", "name", "extra", "prompt"]);
    store.update("job", { name: "after" });
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(persisted.jobs[0])).toEqual(["id", "zeta", "name", "extra", "prompt"]);
    expect(persisted.jobs[0]).toMatchObject({ zeta: 1, name: "after", extra: 2, prompt: "p" });
  });

  it("allow-lists and reorders fields only when guardExpected is enabled", () => {
    const directory = temporaryDirectory("round1-store-allowlist-");
    const file = join(directory, "jobs.json");
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [{ id: "job", zeta: 1, name: "before", extra: 2, prompt: "p" }] }, null, 2));
    const store = new ScheduleStore(file, { guardExpected: true });
    expect(store.get("job")).not.toHaveProperty("zeta");
    expect(store.get("job")).not.toHaveProperty("extra");
    expect(Object.keys(store.get("job")!)).toEqual(["id", "name", "prompt"]);
    store.update("job", { description: "bounded" });
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).jobs[0])).toEqual(["id", "name", "description", "prompt"]);
  });
});

describe("guarded worktree cleanup and cancellation", () => {
  function realPi() {
    return {
      exec: (command: string, args: string[], options: any) => new Promise(resolve => {
        execFile(command, args, {
          cwd: options?.cwd,
          timeout: options?.timeout,
          signal: options?.signal,
          encoding: "utf8",
        }, (error, stdout, stderr) => {
          const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (error as NodeJS.ErrnoException & { code: number }).code
            : error ? 1 : 0;
          resolve({ stdout: String(stdout), stderr: String(stderr), code, killed: Boolean((error as NodeJS.ErrnoException & { killed?: boolean } | null)?.killed) });
        });
      }),
    } as any;
  }

  it("captures and removes after abort without reusing the child's aborted signal (R4)", async () => {
    const repo = temporaryGitRepo("round1-abort-repo-");
    const effects: GuardEffectRequest[] = [];
    const host = createHost({ now: Date.now, reviewEffect: request => { effects.push(request); return "allowed"; } });
    const completed = vi.fn();
    const manager = new AgentManager(completed);
    managers.push(manager);
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    // Register the same active bridge on the manager used by the effect callback.
    const registration = host.getRegistration() as GuardBridgeRegistration;
    manager.registerGuard(registration);
    const ctx = {
      cwd: repo,
      hasUI: true,
      sessionManager: { getSessionId: () => "root" },
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
    } as any;
    let childRelease!: () => void;
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      await new Promise<void>(resolve => {
        childRelease = resolve;
        options.signal.addEventListener("abort", resolve, { once: true });
      });
      writeFileSync(join(options.cwd, "changed-after-abort.txt"), "change\n");
      return { responseText: "aborted", session: undefined, aborted: true, steered: false };
    });
    const id = manager.spawn(realPi(), ctx, "general-purpose", "change", {
      description: "aborted worker",
      isBackground: true,
      isolation: "worktree",
    } as any);
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    const worktreePath = record.worktree!.path;
    expect(existsSync(worktreePath)).toBe(true);
    expect(manager.abort(id)).toBe(true);
    childRelease();
    await record.promise;
    expect(effects.some(effect => effect.kind === "worktree-capture" && effect.argv.includes("commit"))).toBe(true);
    expect(effects.some(effect => effect.kind === "worktree-remove")).toBe(true);
    expect(record.worktreeResult).toMatchObject({ hasChanges: true });
    expect(existsSync(worktreePath)).toBe(false);
    expect(record.error).toBeUndefined();
    expect(completed).toHaveBeenCalledWith(record);
  });

  it("marks manager-issued schedule effects and bounds them even with a live UI", async () => {
    vi.useFakeTimers();
    const manager = new AgentManager();
    managers.push(manager);
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    const requests: GuardEffectRequest[] = [];
    let registration!: GuardBridgeRegistration;
    registration = {
      protocolVersion: 1,
      registrant: { id: "scope-guard", version: "test" },
      callbacks: {
        captureIngress: vi.fn(), enrollResource: vi.fn(),
        createChildContext: vi.fn((request: GuardChildContextRequest) => ({
          rootId: "root", parentId: request.parentId, childId: request.childId, delegationId: request.delegationId,
          taskId: "task", scopeRevision: 1, executionEpoch: 1, resolvedRestrictions: [], origin: request.origin,
          bridgeRef: registration,
        })),
        revalidate: vi.fn(() => "allowed" as const), approvalSettled: vi.fn(), approvalCancelled: vi.fn(), approvalExpired: vi.fn(),
        reviewEffect: vi.fn((request: GuardEffectRequest) => {
          requests.push(request);
          return new Promise<never>(() => {});
        }),
      },
    };
    manager.registerGuard(registration);
    const effect: GuardEffectDescription = {
      kind: "workflow-exec", command: "/bin/sh", argv: ["-c", "true"], cwd: "/tmp", envKeys: [],
      resources: { parentWorkspace: "/tmp" }, ownedByPackage: false, boundTo: "unbounded",
    };
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      await manager.reviewGuardEffect(effect, {
        entryPath: "workflow.pi-exec.gate", childId: options.agentId, signal: options.signal,
      });
      return { responseText: "done", session: undefined, aborted: false, steered: false };
    });
    const id = manager.spawnScheduled({} as any, {
      cwd: "/tmp", hasUI: true, sessionManager: { getSessionId: () => "root" }, modelRegistry: {},
    } as any, "general-purpose", "scheduled", {
      description: "scheduled", isBackground: true,
      scopeRef: "minted", guardScopeRefStatus: "provided",
      scheduled: { jobId: "job", runIndex: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    } as any);
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    const rejection = expect(record.promise).resolves.toBe("");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ scheduled: true, headless: false });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(record.error).toContain("guard-effect-unavailable");
  });

  it("drains and calls onComplete when a child stops during guarded worktree creation", async () => {
    const repo = temporaryGitRepo("round1-create-stop-");
    let releaseReview!: () => void;
    let requestedAdd = false;
    const host = createHost({ now: Date.now, reviewEffect: request => {
      if (request.kind === "worktree-create" && request.argv.includes("add")) {
        requestedAdd = true;
        return new Promise(resolve => { releaseReview = () => resolve("allowed"); });
      }
      return "allowed";
    } });
    const completed = vi.fn();
    const manager = new AgentManager(completed);
    managers.push(manager);
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    const registration = host.getRegistration() as GuardBridgeRegistration;
    manager.registerGuard(registration);
    const drain = vi.spyOn(manager as any, "drainQueue");
    const ctx = {
      cwd: repo,
      hasUI: true,
      sessionManager: { getSessionId: () => "root" },
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
    } as any;
    const id = manager.spawn(realPi(), ctx, "general-purpose", "stop during creation", {
      description: "creation stop",
      isBackground: true,
      isolation: "worktree",
    } as any);
    await vi.waitFor(() => expect(requestedAdd).toBe(true));
    expect(manager.abort(id)).toBe(true);
    await manager.awaitStartup(id);
    expect(manager.getRecord(id)?.status).toBe("stopped");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    releaseReview(); // The callback may settle late; it cannot authorize a command.
  });
});
