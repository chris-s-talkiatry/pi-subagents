import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const V019_PAYLOAD_KEYS: any = JSON.parse(readFileSync(new URL("./fixtures/guard-off-payload-keys-v019.json", import.meta.url), "utf8"));
let hermetic: Hermetic | undefined;
let lifecycle: Map<string, any> | undefined;
const managers: AgentManager[] = [];

afterEach(async () => {
  vi.useRealTimers();
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  worktreeMocks.createWorktree.mockReset();
  worktreeMocks.cleanupWorktree.mockReset();
  for (const manager of managers.splice(0)) await manager.dispose();
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

function bootGuardOff() {
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false, guardExpected: false } });
  const booted = makePi();
  subagentsExtension(booted.pi);
  lifecycle = booted.lifecycle;
  const root = ctx({ cwd: hermetic.dir, sessionManager: { getSessionId: () => "root" } });
  return { booted, root };
}

describe("guard-off archived v0.19.0 differential regressions", () => {
  beforeEach(() => {
    runnerMocks.runAgent.mockReset();
    runnerMocks.resumeAgent.mockReset();
  });

  it("does not add guarded cleanup-pending fields or XML when cleanup throws", async () => {
    const { booted, root } = bootGuardOff();
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const worktree = {
      path: `${hermetic!.dir}/pi-agent-cleanup-failure-12345678`,
      branch: "pi-agent-cleanup-failure",
      baseSha: "base",
      workPath: `${hermetic!.dir}/pi-agent-cleanup-failure-12345678`,
    };
    worktreeMocks.createWorktree.mockResolvedValue(worktree);
    worktreeMocks.cleanupWorktree.mockRejectedValue(new Error("cleanup exploded"));
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, prompt: string, options: any) => {
      const session = fakeSession();
      options.onSessionCreated?.(session);
      return { responseText: `done:${prompt}`, session, aborted: false, steered: false } as any;
    });

    const id = manager.spawn({} as any, root, "general-purpose", "cleanup error", {
      description: "cleanup error",
      isBackground: true,
      isolation: "worktree",
    } as any);
    await manager.waitForAll();
    await flush();
    await vi.waitFor(() => expect(booted.pi.sendMessage).toHaveBeenCalledTimes(1));

    const record = manager.getRecord(id);
    const failed = booted.pi.events.emit.mock.calls.find(([name]: [string]) => name === "subagents:failed")?.[1];
    const notification = booted.pi.sendMessage.mock.calls[0]?.[0];
    const recordEntry = booted.pi.appendEntry.mock.calls.find(([name]: [string]) => name === "subagents:record")?.[1];
    expect(record?.status).toBe("error");
    expect(record?.error).toBe("cleanup exploded");
    expect(record?.worktreeCleanupPending).toBeUndefined();
    expect(Object.keys(failed ?? {})).toEqual(V019_PAYLOAD_KEYS.event);
    expect(Object.keys(notification?.details ?? {})).toEqual(V019_PAYLOAD_KEYS.details);
    expect(Object.keys(recordEntry ?? {})).toEqual(V019_PAYLOAD_KEYS.appendEntry);
    expect(notification.content).not.toContain("worktree-cleanup-pending");
    expect(notification.details.error).toBe("cleanup exploded");
  });

  it("detaches the parent abort listener before guard-off worktree cleanup (v0.19.0 D2)", async () => {
    const manager = new AgentManager();
    managers.push(manager);
    const worktree = {
      path: "/tmp/pi-agent-differential-worktree",
      branch: "pi-agent-differential",
      baseSha: "base",
      workPath: "/tmp/pi-agent-differential-worktree",
    };
    worktreeMocks.createWorktree.mockResolvedValue(worktree);
    let releaseCleanup!: (value: any) => void;
    let cleanupStarted!: () => void;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    worktreeMocks.cleanupWorktree.mockImplementation(() => {
      cleanupStarted();
      return new Promise(resolve => { releaseCleanup = resolve; });
    });
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, prompt: string, options: any) => {
      const session = fakeSession();
      options.onSessionCreated?.(session);
      return { responseText: `done:${prompt}`, session, aborted: false, steered: false } as any;
    });
    const parentSignal = new AbortController();
    const abort = vi.spyOn(manager, "abort");
    const pending = manager.spawnAndWait({} as any, ctx(), "general-purpose", "detach", {
      description: "detach",
      isolation: "worktree",
      signal: parentSignal.signal,
    } as any);
    await started;

    parentSignal.abort();
    expect(abort).not.toHaveBeenCalled();
    releaseCleanup({ hasChanges: false });
    const { record } = await pending;

    // Fresh `git archive v0.19.0` baseline: the listener is detached before the
    // first cleanup await, so a later parent abort produces no manager.abort call.
    expect(abort).toHaveBeenCalledTimes(0);
    expect(record.status).toBe("completed");
  });
});
