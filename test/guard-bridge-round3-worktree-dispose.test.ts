import { afterEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
const worktreeMocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  pruneWorktrees: vi.fn(async () => {}),
  setWorktreeIsolationEnabled: vi.fn(),
}));
vi.mock("../src/agent-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/agent-runner.js")>();
  return { ...actual, ...runnerMocks };
});
vi.mock("../src/worktree.js", () => worktreeMocks);

import { AgentManager } from "../src/agent-manager.js";
import type { GuardBridgeRegistration } from "../src/guard-bridge.js";

const managers: AgentManager[] = [];

afterEach(async () => {
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  worktreeMocks.createWorktree.mockReset();
  worktreeMocks.cleanupWorktree.mockReset();
  for (const manager of managers.splice(0)) await manager.dispose();
});

function makeManager(): AgentManager {
  const manager = new AgentManager();
  managers.push(manager);
  manager.setGuardRegistrant("scope-guard");
  manager.setGuardExpected(true);
  let registration!: GuardBridgeRegistration;
  registration = {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "test" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource: vi.fn(),
      createChildContext: vi.fn(request => ({
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
      reviewEffect: vi.fn(() => "allowed"),
    },
    createChildGuardExtension: vi.fn(() => () => {}),
  };
  manager.registerGuard(registration);
  return manager;
}

describe("late worktree creation settlement after manager disposal", () => {
  it("cleans up a created worktree and never launches its child", async () => {
    const manager = makeManager();
    let release!: (worktree: any) => void;
    worktreeMocks.createWorktree.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    worktreeMocks.cleanupWorktree.mockResolvedValue({ hasChanges: false });
    runnerMocks.runAgent.mockResolvedValue({ responseText: "must not run", session: undefined, aborted: false, steered: false });
    const context = {
      cwd: "/tmp/parent-repo",
      sessionManager: { getSessionId: () => "root" },
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
    } as any;
    const id = manager.spawn({} as any, context, "general-purpose", "late worktree", {
      description: "late worktree",
      isBackground: true,
      isolation: "worktree",
    } as any);
    await vi.waitFor(() => expect(worktreeMocks.createWorktree).toHaveBeenCalledTimes(1));
    const record = manager.getRecord(id)!;
    const startup = manager.awaitStartup(id);

    await manager.dispose();
    release({
      path: "/tmp/created-after-dispose",
      branch: `pi-agent-${id}`,
      baseSha: "base",
      workPath: "/tmp/created-after-dispose",
    });
    await startup;

    expect(record.status).toBe("stopped");
    expect(record.worktree?.path).toBe("/tmp/created-after-dispose");
    expect(worktreeMocks.cleanupWorktree).toHaveBeenCalledTimes(1);
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(manager.runningBackground).toBe(0);
  });
});
