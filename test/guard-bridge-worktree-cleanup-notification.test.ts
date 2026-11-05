import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, runAgent } from "../src/agent-runner.js";

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

import { type GuardBridgeRegistration, GuardBridgeRejection } from "../src/guard-bridge.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let lifecycle: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  worktreeMocks.createWorktree.mockReset();
  worktreeMocks.cleanupWorktree.mockReset();
});

afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  lifecycle = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    sessionManager: { getSessionFile: () => undefined },
    agent: { state: {} },
  } as any;
}

function registration(): GuardBridgeRegistration {
  let value!: GuardBridgeRegistration;
  value = {
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
        bridgeRef: value,
      })),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
      reviewEffect: vi.fn(() => "denied"),
    },
    createChildGuardExtension: vi.fn(() => () => {}),
  };
  return value;
}

describe("guarded worktree cleanup recovery notification", () => {
  it("records bounded path/branch/reason and includes them in the completion notification", async () => {
    hermetic = hermeticDir({ settings: {
      outputTranscript: false,
      schedulingEnabled: false,
      guardExpected: true,
      guardRegistrant: "scope-guard",
    } });
    const booted = makePi();
    subagentsExtension(booted.pi);
    lifecycle = booted.lifecycle;
    const root = ctx({ cwd: hermetic.dir, sessionManager: { getSessionId: () => "root" } });
    await lifecycle.get("session_start")({}, root);

    const handler = booted.pi.events.on.mock.calls.find(([name]: [string]) => name === "subagents:guard:register")?.[1];
    expect(handler).toBeTypeOf("function");
    handler(registration());
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const worktree = {
      path: `${hermetic.dir}/pi-agent-child-12345678`,
      branch: "pi-agent-child",
      baseSha: "base",
      workPath: `${hermetic.dir}/pi-agent-child-12345678`,
    };
    worktreeMocks.createWorktree.mockResolvedValue(worktree);
    worktreeMocks.cleanupWorktree.mockImplementation(async (_pi: any, _cwd: string, captured: any) => {
      captured.branchCreated = true;
      throw new GuardBridgeRejection(
        "guard-effect-denied", "worktree.remove", "guard-effect-denied: cleanup was refused.",
      );
    });
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      options.onSessionCreated?.(fakeSession());
      return { responseText: "work done", session: fakeSession(), aborted: false, steered: false } as any;
    });

    const id = await manager.spawn({} as any, root, "general-purpose", "work", {
      description: "cleanup test",
      isBackground: true,
      isolation: "worktree",
    } as any);
    await manager.waitForAll();
    await flush();
    await new Promise(resolve => setTimeout(resolve, 250));

    const record = manager.getRecord(id);
    const pending = {
      path: worktree.path.slice(0, 4096),
      branch: worktree.branch.slice(0, 256),
      branchCreated: true,
      reason: "guard-effect-denied",
    };
    expect(record?.worktreeCleanupPending).toEqual(pending);
    expect(record?.error).toContain(worktree.path);
    expect(record?.error).toContain(worktree.branch);
    expect(record?.error).toContain("intended branch");
    expect(record?.error).toContain("created: yes");
    expect(record?.error).not.toContain("cleanup was refused");
    expect(booted.pi.events.emit).toHaveBeenCalledWith("subagents:completed", expect.objectContaining({ worktreeCleanupPending: pending }));
    expect(booted.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(booted.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "subagent-notification",
      content: expect.stringContaining(`<worktree-cleanup-pending><path>${worktree.path}</path><branch>${worktree.branch}</branch><branch-created>true</branch-created><reason>guard-effect-denied</reason></worktree-cleanup-pending>`),
      details: expect.objectContaining({ worktreeCleanupPending: pending }),
    }), expect.objectContaining({ triggerTurn: true }));
  });

  it("returns cleanup-pending coordinates in the foreground Agent result", async () => {
    hermetic = hermeticDir({ settings: {
      outputTranscript: false,
      schedulingEnabled: false,
      guardExpected: true,
      guardRegistrant: "scope-guard",
    } });
    const booted = makePi();
    subagentsExtension(booted.pi);
    lifecycle = booted.lifecycle;
    const root = ctx({ cwd: hermetic.dir, sessionManager: { getSessionId: () => "root" } });
    await lifecycle.get("session_start")({}, root);
    const handler = booted.pi.events.on.mock.calls.find(([name]: [string]) => name === "subagents:guard:register")?.[1];
    handler(registration());
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const worktree = {
      path: `${hermetic.dir}/pi-agent-foreground-12345678`,
      branch: "pi-agent-foreground",
      baseSha: "base",
      workPath: `${hermetic.dir}/pi-agent-foreground-12345678`,
    };
    worktreeMocks.createWorktree.mockResolvedValue(worktree);
    worktreeMocks.cleanupWorktree.mockRejectedValue(new GuardBridgeRejection(
      "guard-effect-denied", "worktree.capture", "guard-effect-denied: cleanup refused.",
    ));
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      options.onSessionCreated?.(fakeSession());
      return { responseText: "foreground done", session: fakeSession(), aborted: false, steered: false } as any;
    });

    const result = await booted.tools.get("Agent").execute("foreground-cleanup", {
      prompt: "work", description: "foreground cleanup", subagent_type: "general-purpose",
      run_in_background: false, isolation: "worktree",
    }, undefined, undefined, root);

    expect(result.content[0].text).toContain("foreground done");
    expect(result.content[0].text).toContain(worktree.path);
    expect(result.content[0].text).toContain(worktree.branch);
    expect(result.content[0].text).toContain("Intended branch");
    expect(result.content[0].text).toContain("created: no");
    expect(result.details.worktreeCleanupPending).toMatchObject({
      path: worktree.path, branch: worktree.branch, branchCreated: false, reason: "guard-effect-denied",
    });
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
    expect(manager.getRecord(result.details.agentId)?.resultConsumed).toBe(true);
  });

});
