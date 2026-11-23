import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/agent-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/agent-runner.js")>();
  return { ...actual, ...runnerMocks };
});

import { AgentManager } from "../src/agent-manager.js";
import type { GuardBridgeRegistration, GuardChildContextRequest, GuardEffectRequest } from "../src/guard-bridge.js";

const directories: string[] = [];
const managers: AgentManager[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

function makeRepo(): string {
  const repo = temp("guard-round3-dispose-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Guard lifecycle test");
  git(repo, "config", "user.email", "guard-lifecycle@example.invalid");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "seed.txt");
  git(repo, "commit", "-q", "-m", "seed");
  return repo;
}

function realPi(): any {
  return {
    exec: async (command: string, args: string[], options: any) => {
      try {
        const stdout = execFileSync(command, args, { cwd: options?.cwd, env: options?.env, encoding: "utf8" });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (error: any) {
        return {
          stdout: String(error.stdout ?? ""),
          stderr: String(error.stderr ?? ""),
          code: typeof error.status === "number" ? error.status : 1,
          killed: false,
        };
      }
    },
  };
}

function context(cwd: string): any {
  return {
    cwd,
    sessionManager: { getSessionId: () => "root-session" },
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
  };
}

function registration(
  createChildContext: (request: GuardChildContextRequest) => unknown | Promise<unknown>,
  reviewEffect: (request: GuardEffectRequest) => unknown | Promise<unknown> = () => "allowed",
): GuardBridgeRegistration {
  let value!: GuardBridgeRegistration;
  value = {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "test" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource: vi.fn(),
      createChildContext: vi.fn(createChildContext),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
      reviewEffect: vi.fn(reviewEffect),
    },
    createChildGuardExtension: vi.fn(() => () => {}),
  };
  return value;
}

function childContext(request: GuardChildContextRequest, bridgeRef: GuardBridgeRegistration): any {
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

function makeManager(reg: GuardBridgeRegistration): AgentManager {
  const manager = new AgentManager();
  managers.push(manager);
  manager.setGuardRegistrant("scope-guard");
  manager.setGuardExpected(true);
  manager.registerGuard(reg);
  return manager;
}

function fakeSession() {
  return {
    messages: [],
    sessionManager: { getSessionFile: () => undefined },
    agent: { state: {} },
    steer: vi.fn(async () => {}),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as any;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached within five seconds");
    await new Promise(resolve => setImmediate(resolve));
  }
}

afterEach(async () => {
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("guarded startup lifetimes on manager disposal", () => {
  it("stops a spawn whose child-context approval resolves after dispose", async () => {
    let release!: (value: unknown) => void;
    let bridge!: GuardBridgeRegistration;
    const contextStarted = vi.fn();
    bridge = registration(() => {
      contextStarted();
      return new Promise(resolve => { release = resolve; });
    });
    const manager = makeManager(bridge);
    runnerMocks.runAgent.mockResolvedValue({
      responseText: "unexpected",
      session: fakeSession(),
      aborted: false,
      steered: false,
    });
    const id = manager.spawn({} as any, context(process.cwd()), "general-purpose", "child", {
      description: "pending context",
      isBackground: true,
    } as any);
    await waitUntil(() => contextStarted.mock.calls.length === 1);
    const record = manager.getRecord(id)!;
    const startup = manager.awaitStartup(id);

    await manager.dispose();
    await startup;
    release({} as any);
    await new Promise(resolve => setImmediate(resolve));

    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeTypeOf("number");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(manager.runningBackground).toBe(0);
  });

  it("does not launch a worktree child after a late create approval (L12b)", async () => {
    const repo = makeRepo();
    let release!: (value: unknown) => void;
    const effectStarted = vi.fn();
    let bridge!: GuardBridgeRegistration;
    bridge = registration(
      request => childContext(request, bridge),
      request => {
        if (request.kind === "worktree-create" && request.argv.includes("add")) {
          effectStarted();
          return new Promise(resolve => { release = resolve; });
        }
        return "allowed";
      },
    );
    const manager = makeManager(bridge);
    runnerMocks.runAgent.mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(realPi(), context(repo), "general-purpose", "late approval", {
      description: "late approval",
      isBackground: true,
      isolation: "worktree",
    } as any);
    await waitUntil(() => effectStarted.mock.calls.length === 1);
    const record = manager.getRecord(id)!;
    const startup = manager.awaitStartup(id);

    await manager.dispose();
    await startup;
    release("allowed");
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeTypeOf("number");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(manager.runningBackground).toBe(0);
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
  }, 20000);

  it("stops a background resume whose child-context approval resolves after dispose", async () => {
    let bridge!: GuardBridgeRegistration;
    let releaseResume!: (value: unknown) => void;
    const resumeContextStarted = vi.fn();
    bridge = registration(request => {
      if (request.operation === "resume") {
        resumeContextStarted();
        return new Promise(resolve => { releaseResume = resolve; });
      }
      return childContext(request, bridge);
    });
    const manager = makeManager(bridge);
    runnerMocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      const session = fakeSession();
      options.onSessionCreated?.(session);
      return { responseText: "first", session, aborted: false, steered: false };
    });
    runnerMocks.resumeAgent.mockResolvedValue({ text: "unexpected", aborted: false });
    const id = manager.spawn({} as any, context(process.cwd()), "general-purpose", "first", {
      description: "resume target",
      isBackground: true,
    } as any);
    await manager.awaitStartup(id);
    await manager.getRecord(id)!.promise;

    const record = await manager.resume(id, "resume", undefined, { isBackground: true } as any);
    expect(record).toBeDefined();
    await waitUntil(() => resumeContextStarted.mock.calls.length === 1);
    const startup = record!.promise!;
    await manager.dispose();
    await startup;
    releaseResume({} as any);
    await new Promise(resolve => setImmediate(resolve));

    expect(record!.status).toBe("stopped");
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
    expect(manager.runningBackground).toBe(0);
  });

  it("stops scheduler-issued spawn after child-context approval resolves after dispose", async () => {
    let bridge!: GuardBridgeRegistration;
    let release!: (value: unknown) => void;
    const contextStarted = vi.fn();
    bridge = registration(() => {
      contextStarted();
      return new Promise(resolve => { release = resolve; });
    });
    const manager = makeManager(bridge);
    runnerMocks.runAgent.mockResolvedValue({
      responseText: "unexpected",
      session: fakeSession(),
      aborted: false,
      steered: false,
    });
    const id = manager.spawnScheduled({} as any, context(process.cwd()), "general-purpose", "scheduled", {
      description: "scheduled",
      isBackground: true,
      scheduled: { jobId: "job", runIndex: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      guardScopeRefStatus: "unresolved",
    } as any);
    await waitUntil(() => contextStarted.mock.calls.length === 1);
    const record = manager.getRecord(id)!;
    const startup = manager.awaitStartup(id);

    await manager.dispose();
    await startup;
    release({} as any);
    await new Promise(resolve => setImmediate(resolve));

    expect(record.status).toBe("stopped");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(manager.runningBackground).toBe(0);
  });
});
