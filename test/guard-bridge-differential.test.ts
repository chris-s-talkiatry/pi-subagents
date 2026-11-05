import { afterEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
const worktreeMocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  pruneWorktrees: vi.fn(async () => {}),
  setWorktreeIsolationEnabled: vi.fn(),
}));
vi.mock("../src/worktree.js", () => worktreeMocks);
vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, ...runnerMocks };
});

import { AgentManager } from "../src/agent-manager.js";

const ctx = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "root" },
  model: undefined,
  modelRegistry: { find: () => undefined, getAvailable: () => [] },
} as any;
const pi = {} as any;

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

function manager(events: unknown[][]): AgentManager {
  return new AgentManager(
    record => events.push(["complete", record.description, record.status, record.resultConsumed ?? null, record.error ?? null]),
    4,
    record => events.push(["start", record.description, record.status]),
  );
}
function guardedManager(events: unknown[][]): AgentManager {
  const value = manager(events);
  let registration: any;
  registration = {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "1" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource: vi.fn(),
      createChildContext: vi.fn((request: any) => ({
        rootId: "root",
        parentId: request.parentId,
        childId: request.childId,
        delegationId: request.delegationId,
        taskId: "task",
        scopeRevision: 0,
        executionEpoch: 0,
        resolvedRestrictions: [],
        origin: request.origin,
        bridgeRef: registration,
      })),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
    },
    createChildGuardExtension: vi.fn(() => vi.fn()),

  };
  value.setGuardRegistrant("scope-guard");
  value.setGuardExpected(true);
  value.registerGuard(registration);
  return value;
}



afterEach(() => {
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  worktreeMocks.createWorktree.mockReset();
  worktreeMocks.cleanupWorktree.mockReset();
});

describe("guard-off differential against upstream HEAD", () => {
  it("matches HEAD for spawnAndWait with an already-aborted signal (D2)", async () => {
    const events: unknown[][] = [];
    const m = manager(events);
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, prompt: string, options: any) => {
      events.push(["runAgent", prompt, options.signal.aborted]);
      const child = session(prompt);
      options.onSessionCreated?.(child);
      return { responseText: `done:${prompt}`, session: child, aborted: false, steered: false };
    });
    const controller = new AbortController();
    controller.abort();

    const { record } = await m.spawnAndWait(pi, ctx, "general-purpose", "x", {
      description: "x",
      signal: controller.signal,
    });
    events.push(["result", record.status, record.result]);

    expect(events).toEqual([
      ["start", "x", "running"],
      ["runAgent", "x", true],
      ["complete", "x", "stopped", true, null],
      ["result", "stopped", "done:x"],
    ]);
    await m.dispose();
  });

  it("matches HEAD when a signal aborts during worktree creation (D3)", async () => {
    const events: unknown[][] = [];
    const m = manager(events);
    let resolveWorktree!: (value: any) => void;
    worktreeMocks.createWorktree.mockImplementation(() => new Promise(resolve => { resolveWorktree = resolve; }));
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, prompt: string, options: any) => {
      events.push(["runAgent", prompt, options.signal.aborted]);
      const child = session(prompt);
      options.onSessionCreated?.(child);
      return { responseText: `done:${prompt}`, session: child, aborted: false, steered: false };
    });
    const controller = new AbortController();
    const pending = m.spawnAndWait(pi, ctx, "general-purpose", "w", {
      description: "w",
      isolation: "worktree",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(worktreeMocks.createWorktree).toHaveBeenCalledTimes(1));
    const record = m.listAgents()[0]!;
    controller.abort();
    events.push(["afterAbort", record.status, !!record.promise]);
    resolveWorktree({ path: process.cwd(), workPath: process.cwd(), branch: "test", baseSha: "base" });
    const result = await pending;
    events.push(["result", result.record.status]);

    expect(events).toEqual([
      ["afterAbort", "running", false],
      ["start", "w", "running"],
      ["runAgent", "w", true],
      ["complete", "w", "stopped", true, null],
      ["result", "stopped"],
    ]);
    await m.dispose();
  });

  it("drains the next queued spawn after a guarded worktree startup failure (D6)", async () => {
    const events: unknown[][] = [];
    const m = guardedManager(events);
    m.setMaxConcurrent(1);
    worktreeMocks.createWorktree.mockImplementation(async () => undefined);
    let finishBlocker!: () => void;
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, prompt: string, options: any) => {
      events.push(["runAgent", prompt, options.signal.aborted]);
      const child = session(prompt);
      options.onSessionCreated?.(child);
      if (prompt === "h") {
        return new Promise(resolve => {
          finishBlocker = () => resolve({ responseText: "done:h", session: child, aborted: false, steered: false });
        });
      }
      return Promise.resolve({ responseText: `done:${prompt}`, session: child, aborted: false, steered: false });
    });

    const blocker = m.spawn(pi, ctx, "general-purpose", "h", { description: "h", isBackground: true });
    await m.awaitStartup(blocker);
    const failed = m.spawn(pi, ctx, "general-purpose", "q1", {
      description: "q1",
      isBackground: true,
      isolation: "worktree",
    });
    const next = m.spawn(pi, ctx, "general-purpose", "q2", { description: "q2", isBackground: true });
    await vi.waitFor(() => expect(events).toContainEqual(["runAgent", "h", false]));

    finishBlocker();
    await m.getRecord(blocker)!.promise;
    await vi.waitFor(() => expect(m.getRecord(next)?.status).toBe("completed"));
    expect(m.getRecord(failed)?.status).toBe("error");

    expect(events).toEqual([
      ["start", "h", "running"],
      ["runAgent", "h", false],
      ["complete", "h", "completed", null, null],
      ["complete", "q1", "error", null, 'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. Initialize git and commit at least once, or omit `isolation`.'],
      ["start", "q2", "running"],
      ["runAgent", "q2", false],
      ["complete", "q2", "completed", null, null],
    ]);
    await m.dispose();
  });

  it("matches HEAD by ignoring an already-aborted parent signal for background resume (D4)", async () => {
    const events: unknown[][] = [];
    const m = manager(events);
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, prompt: string, options: any) => {
      events.push(["runAgent", prompt, options.signal.aborted]);
      const child = session(prompt);
      options.onSessionCreated?.(child);
      return { responseText: `done:${prompt}`, session: child, aborted: false, steered: false };
    });
    runnerMocks.resumeAgent.mockImplementation(async (_session: any, prompt: string, options: any) => {
      events.push(["resumeAgent", prompt, options.signal.aborted]);
      return { text: `resumed:${prompt}` };
    });
    const id = m.spawn(pi, ctx, "general-purpose", "a", { description: "a", isBackground: true });
    await m.awaitStartup(id);
    await m.getRecord(id)!.promise;
    events.length = 0;
    const controller = new AbortController();
    controller.abort();

    await m.resume(id, "rc", controller.signal, { isBackground: true });
    await m.getRecord(id)!.promise;

    expect(events).toEqual([
      ["start", "a", "running"],
      ["resumeAgent", "rc", false],
      ["complete", "a", "completed", false, null],
    ]);
    expect(m.getRecord(id)?.status).toBe("completed");
    await m.dispose();
  });
  it("matches the upstream HEAD E4 worktree-startup rejection sequence with guard off", async () => {
    const events: unknown[][] = [];
    const m = manager(events);
    m.setMaxConcurrent(1);
    worktreeMocks.createWorktree.mockImplementation(async () => { throw new Error("git exploded"); });

    const id = m.spawn(pi, ctx, "general-purpose", "i1", {
      description: "i1",
      isBackground: true,
      isolation: "worktree",
    });
    const startup = await m.awaitStartup(id).then(() => "ok", err => String(err));
    events.push(["i1", startup, m.listAgents().map(record => record.description), [
      (m as any).runningBackground,
      (m as any).runningForeground,
      (m as any).queue.length,
    ]]);

    expect(events).toEqual([["i1", "Error: git exploded", [], [1, 0, 0]]]);
    await m.dispose();
  });


});
