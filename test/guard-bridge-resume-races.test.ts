import { afterEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, ...runnerMocks };
});
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  isWorktreeIsolationEnabled: vi.fn(() => false),
  pruneWorktrees: vi.fn(async () => {}),
  setWorktreeIsolationEnabled: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { GroupJoinManager } from "../src/group-join.js";
import type { GuardBridgeRegistration, GuardChildContext, GuardChildContextRequest } from "../src/guard-bridge.js";

const pi = {} as any;
const ctx = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "root-session" },
  model: undefined,
  modelRegistry: { find: () => undefined, getAvailable: () => [] },
} as any;

function session(name: string) {
  return {
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => name },
    agent: { state: {} },
    messages: [],
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    abort: vi.fn(),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as any;
}

function contextFor(request: GuardChildContextRequest, bridgeRef: GuardBridgeRegistration): GuardChildContext {
  return {
    rootId: "root",
    parentId: request.parentId,
    childId: request.childId,
    delegationId: request.delegationId,
    taskId: "task",
    scopeRevision: 0,
    executionEpoch: 0,
    resolvedRestrictions: [],
    origin: request.origin,
    bridgeRef,
  };
}

function registration(
  create?: (request: GuardChildContextRequest, active: GuardBridgeRegistration) => GuardChildContext | Promise<GuardChildContext>,
): GuardBridgeRegistration {
  let active: GuardBridgeRegistration;
  active = {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "1" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource: vi.fn(),
      createChildContext: vi.fn((request: GuardChildContextRequest) => create
        ? create(request, active)
        : contextFor(request, active)),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
    },
    createChildGuardExtension: vi.fn(() => vi.fn()),

  };
  return active;
}

const managers: AgentManager[] = [];
function guardedManager(reg = registration(), onComplete?: (record: any) => void): AgentManager {
  const manager = new AgentManager(onComplete, 4);
  manager.setGuardRegistrant("scope-guard");
  manager.setGuardExpected(true);
  manager.registerGuard(reg);
  managers.push(manager);
  return manager;
}

async function startedChild(manager: AgentManager, prompt: string): Promise<string> {
  runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
    const childSession = session(prompt);
    options.onSessionCreated?.(childSession);
    return { responseText: `done:${prompt}`, session: childSession, aborted: false, steered: false };
  });
  const id = manager.spawn(pi, ctx, "general-purpose", prompt, { description: prompt, isBackground: true });
  await manager.awaitStartup(id);
  await manager.getRecord(id)!.promise;
  return id;
}

afterEach(async () => {
  for (const manager of managers) await manager.dispose();
  managers.length = 0;
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
});

describe("guarded resume lifecycle", () => {
  it("clears the in-flight guard after each successful foreground resume", async () => {
    const reg = registration();
    const manager = guardedManager(reg);
    const id = await startedChild(manager, "sequential resumes");
    runnerMocks.resumeAgent.mockResolvedValue({ text: "resumed" });

    const first = await manager.resume(id, "first");
    const second = await manager.resume(id, "second");

    expect(first?.status).toBe("completed");
    expect(second?.status).toBe("completed");
    expect(runnerMocks.resumeAgent).toHaveBeenCalledTimes(2);
    expect((reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.operation))
      .toEqual(["spawn", "resume", "resume"]);
  });

  it("refuses a background resume after abort while guarded context is still in flight", async () => {
    let resolveResumeContext!: (context: GuardChildContext) => void;
    const reg = registration((request, active) => request.operation === "resume"
      ? new Promise(resolve => { resolveResumeContext = resolve; })
      : contextFor(request, active));
    const manager = guardedManager(reg);
    const id = await startedChild(manager, "abort pending resume");
    const pendingForeground = manager.resume(id, "foreground pending");
    await vi.waitFor(() => expect(reg.callbacks.createChildContext).toHaveBeenCalledTimes(2));

    expect(manager.abort(id)).toBe(true);
    const overlapping = manager.resume(id, "background overlap", undefined, { isBackground: true });
    expect(await overlapping).toBeUndefined();
    resolveResumeContext(contextFor(
      (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.calls[1]![0],
      reg,
    ));
    await pendingForeground;

    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
    expect(manager.getRecord(id)?.status).toBe("stopped");
  });

  it("rejects a foreground resume while a background resume of the same agent is queued", async () => {
    const reg = registration();
    const manager = guardedManager(reg);
    manager.setMaxConcurrent(1);
    let finishBlocker!: (result?: any) => void;
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, prompt: string, options: any) => {
      const childSession = session(prompt);
      options.onSessionCreated?.(childSession);
      if (prompt === "slot blocker") {
        return new Promise(resolve => {
          finishBlocker = (result = {}) => resolve({
            responseText: "blocker done",
            session: childSession,
            aborted: false,
            steered: false,
            ...result,
          });
        });
      }
      return Promise.resolve({ responseText: `done:${prompt}`, session: childSession, aborted: false, steered: false });
    });
    const targetId = manager.spawn(pi, ctx, "general-purpose", "resume target", {
      description: "resume target",
      isBackground: true,
    });
    await manager.awaitStartup(targetId);
    await manager.getRecord(targetId)!.promise;
    const blockerId = manager.spawn(pi, ctx, "general-purpose", "slot blocker", {
      description: "slot blocker",
      isBackground: true,
    });
    await manager.awaitStartup(blockerId);

    runnerMocks.resumeAgent.mockResolvedValue({ text: "resumed" });

    const queued = await manager.resume(targetId, "queued background", undefined, { isBackground: true });
    expect(queued?.status).toBe("queued");
    expect(await manager.resume(targetId, "overlapping foreground")).toBeUndefined();
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();

    finishBlocker();
    await manager.getRecord(blockerId)!.promise;
    await manager.getRecord(targetId)!.promise;
    expect(runnerMocks.resumeAgent).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(targetId)?.status).toBe("completed");
  });

  it("stops a background resume when its parent signal was already aborted", async () => {
    const manager = guardedManager();
    const id = await startedChild(manager, "pre-aborted resume");
    const controller = new AbortController();
    controller.abort();

    const record = await manager.resume(id, "must not resume", controller.signal, { isBackground: true });
    await record?.promise;

    expect(record?.status).toBe("stopped");
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
  });

  it("reports an aborted context-pending spawn to group join exactly once", async () => {
    const reg = registration(() => new Promise<GuardChildContext>(() => {}));
    const delivered: string[][] = [];
    const group = new GroupJoinManager(records => delivered.push(records.map(record => record.status)), 1000);
    const completions: string[] = [];
    const manager = guardedManager(reg, record => {
      completions.push(record.status);
      group.onAgentComplete(record);
    });
    const id = manager.spawn(pi, ctx, "general-purpose", "pending context", {
      description: "pending context",
      isBackground: true,
    });
    group.registerGroup("single-spawn", [id]);
    await vi.waitFor(() => expect(reg.callbacks.createChildContext).toHaveBeenCalledTimes(1));

    expect(manager.abort(id)).toBe(true);
    await manager.awaitStartup(id);

    expect(completions).toEqual(["stopped"]);
    expect(delivered).toEqual([["stopped"]]);
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    group.dispose();
  });

  it("does not run a spawn stopped in the microtask after context resolution", async () => {
    let manager!: AgentManager;
    const reg = registration(request => new Promise(resolve => {
      setTimeout(() => {
        resolve(contextFor(request, reg));
        queueMicrotask(() => {
          const record = manager.getRecord(request.childId);
          if (record) {
            record.status = "stopped";
            record.completedAt = Date.now();
          }
        });
      }, 0);
    }));
    manager = guardedManager(reg);
    const id = manager.spawn(pi, ctx, "general-purpose", "microtask stop", {
      description: "microtask stop",
      isBackground: true,
    });
    await manager.awaitStartup(id);

    expect(manager.getRecord(id)?.status).toBe("stopped");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect((manager as any).runningBackground).toBe(0);
  });

  it("does not start a spawn after disposal while context creation is pending", async () => {
    let resolveContext!: (context: GuardChildContext) => void;
    const reg = registration((request, active) => new Promise(resolve => {
      resolveContext = context => resolve(context);
      void active;
      void request;
    }));
    const manager = guardedManager(reg);
    const id = manager.spawn(pi, ctx, "general-purpose", "dispose spawn", {
      description: "dispose spawn",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await vi.waitFor(() => expect(reg.callbacks.createChildContext).toHaveBeenCalledTimes(1));

    await manager.dispose();
    resolveContext(contextFor(
      (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.calls[0]![0],
      reg,
    ));
    await vi.waitFor(() => expect((manager as any).runningBackground).toBe(0));

    expect(record.status).toBe("stopped");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it("does not call resumeAgent after disposal while foreground context creation is pending", async () => {
    let resolveContext!: (context: GuardChildContext) => void;
    const reg = registration();
    const manager = guardedManager(reg);
    const id = await startedChild(manager, "dispose foreground resume");
    (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mockImplementation((request: GuardChildContextRequest) =>
      request.operation === "resume"
        ? new Promise(resolve => { resolveContext = resolve; })
        : contextFor(request, reg));
    runnerMocks.resumeAgent.mockResolvedValue({ text: "must not run" });
    const pending = manager.resume(id, "resume while disposing");
    const record = manager.getRecord(id)!;
    await vi.waitFor(() => expect(reg.callbacks.createChildContext).toHaveBeenCalledTimes(2));

    await manager.dispose();
    resolveContext(contextFor(
      (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.calls[1]![0],
      reg,
    ));
    await pending;

    expect(record.status).toBe("stopped");
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
  });

  it("does not call resumeAgent after disposal while background context creation is pending", async () => {
    let resolveContext!: (context: GuardChildContext) => void;
    const reg = registration();
    const manager = guardedManager(reg);
    const id = await startedChild(manager, "dispose background resume");
    (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mockImplementation((request: GuardChildContextRequest) =>
      request.operation === "resume"
        ? new Promise(resolve => { resolveContext = resolve; })
        : contextFor(request, reg));
    runnerMocks.resumeAgent.mockResolvedValue({ text: "must not run" });
    const record = await manager.resume(id, "resume while disposing", undefined, { isBackground: true });
    await vi.waitFor(() => expect(reg.callbacks.createChildContext).toHaveBeenCalledTimes(2));

    await manager.dispose();
    resolveContext(contextFor(
      (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.calls[1]![0],
      reg,
    ));
    await record?.promise;

    expect(record?.status).toBe("stopped");
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
    expect((manager as any).runningBackground).toBe(0);
  });

  it("rejects a resume whose retained parent context belongs to a replaced registration", async () => {
    const original = registration();
    const manager = guardedManager(original);
    const parentId = await startedChild(manager, "parent child context");
    const childId = manager.spawn(pi, ctx, "general-purpose", "nested child", {
      description: "nested child",
      isBackground: true,
      parentAgentId: parentId,
      guardEntryPath: "nested-agent.spawn-background",
    });
    await manager.awaitStartup(childId);
    await manager.getRecord(childId)!.promise;
    const replacement = registration();
    manager.unregisterGuard();
    manager.registerGuard(replacement);
    runnerMocks.resumeAgent.mockResolvedValue({ text: "must not run" });

    const result = await manager.resume(childId, "resume nested child", undefined, { guardEntryPath: "nested-agent.resume" });

    expect(result?.status).toBe("error");
    expect(replacement.callbacks.createChildContext).not.toHaveBeenCalled();
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
  });
});
