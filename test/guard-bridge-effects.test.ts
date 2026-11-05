import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/agent-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/agent-runner.js")>();
  return { ...actual, runAgent: runnerMocks.runAgent, resumeAgent: runnerMocks.resumeAgent };
});

import { AgentManager } from "../src/agent-manager.js";
import { detectEnv } from "../src/env.js";
import {
  type GuardBridgeRegistration,
  GuardBridgeRejection,
  type GuardEffectDescription,
  type GuardEffectRequest,
  type GuardOutcome,
} from "../src/guard-bridge.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, type WorktreeEffectHooks } from "../src/worktree.js";

const managers: AgentManager[] = [];
const tempDirectories: string[] = [];
const previousCanary = process.env.GUARD_EFFECT_CANARY;
const previousPath = process.env.PATH;

function registration(reviewEffect?: (request: GuardEffectRequest) => GuardOutcome | Promise<GuardOutcome>): GuardBridgeRegistration {
  return {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "test" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource: vi.fn(),
      createChildContext: vi.fn(),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
      ...(reviewEffect ? { reviewEffect: vi.fn(reviewEffect) } : {}),
    },
  };
}

function manager(reviewEffect?: (request: GuardEffectRequest) => GuardOutcome | Promise<GuardOutcome>, guardExpected = true) {
  const value = new AgentManager();
  managers.push(value);
  value.setGuardRegistrant("scope-guard");
  value.setGuardExpected(guardExpected);
  value.registerGuard(registration(reviewEffect));
  return value;
}

function context(cwd: string) {
  return {
    cwd,
    sessionManager: { getSessionId: () => "root-session" },
    model: undefined,
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
  } as any;
}

function temporaryGitRepo(prefix: string): string {
  const repo = temporaryDirectory(prefix);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Guard Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "guard-test@example.invalid"], { cwd: repo });
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  return repo;
}

function installGitArgvLogger(): string {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = temporaryDirectory("guard-git-wrapper-");
  const log = join(bin, "argv.log");
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\n' "$@" >> "$WORKTREE_TEST_GIT_LOG"\nprintf '%s\n' '__END_CALL__' >> "$WORKTREE_TEST_GIT_LOG"\nexec "$WORKTREE_TEST_REAL_GIT" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.WORKTREE_TEST_GIT_LOG = log;
  process.env.WORKTREE_TEST_REAL_GIT = realGit;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return log;
}

function loggedGitArgv(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("__END_CALL__\n").filter(Boolean).map(call => call.trimEnd().split("\n"));
}

function execResult(overrides: Partial<{ stdout: string; stderr: string; code: number; killed: boolean }> = {}) {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function workflowHost(
  managerValue: AgentManager,
  cwd: string,
  exec: ReturnType<typeof vi.fn>,
  signal?: AbortSignal,
) {
  return createWorkflowHost({ pi: { exec } as any, ctx: context(cwd), manager: managerValue, ...(signal ? { signal } : {}) });
}

afterEach(async () => {
  for (const value of managers) await value.dispose();
  managers.length = 0;
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (previousCanary === undefined) delete process.env.GUARD_EFFECT_CANARY;
  else process.env.GUARD_EFFECT_CANARY = previousCanary;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  delete process.env.WORKTREE_TEST_GIT_LOG;
  delete process.env.WORKTREE_TEST_REAL_GIT;
});

describe("concrete workflow effect authorization", () => {
  it("reviews exact shell argv/cwd once before a remote-mutating gate and omits source text and env values", async () => {
    process.env.GUARD_EFFECT_CANARY = "secret-value-must-not-cross";
    const seen: GuardEffectRequest[] = [];
    const guarded = manager(request => { seen.push(request); return "allowed"; });
    const exec = vi.fn(async () => execResult({ stdout: "validated" }));
    const host = workflowHost(guarded, "/parent/workspace", exec);
    const workflowSource = "export async function run() { /* private full workflow source */ }";
    const command = "gh api -X POST /repos/acme/project/issues -f title=publish";

    const result = await host.runGate(command, { agentId: "workflow-agent-1", cwd: "/tmp/child-tree" });

    expect(result).toEqual({ ok: true, output: "validated" });
    expect(seen).toHaveLength(1);
    expect(seen[0].effectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]).toMatchObject({
      kind: "workflow-exec",
      command: process.platform === "win32" ? "cmd" : "sh",
      argv: [process.platform === "win32" ? "/c" : "-c", command],
      cwd: "/tmp/child-tree",
      entryPath: "workflow.pi-exec.gate",
      resources: { parentWorkspace: "/parent/workspace" },
      ownedByPackage: false,
      boundTo: "unbounded",
    });
    expect(seen[0].envKeys).toContain("GUARD_EFFECT_CANARY");
    expect(JSON.stringify(seen[0])).not.toContain("secret-value-must-not-cross");
    expect(JSON.stringify(seen[0])).not.toContain(workflowSource);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0].argv)).toBe(true);
    expect(Object.isFrozen(seen[0].envKeys)).toBe(true);
    expect(Object.isFrozen(seen[0].resources)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      process.platform === "win32" ? "cmd" : "sh",
      [process.platform === "win32" ? "/c" : "-c", command],
      expect.objectContaining({ cwd: "/tmp/child-tree" }),
    );
  });

  it.each([
    ["denied", "guard-effect-denied"],
    ["stopped", "guard-effect-denied"],
    ["approval-needed", "guard-effect-approval-needed"],
    ["dismissed", "guard-effect-unavailable"],
    ["cancelled", "guard-effect-cancelled"],
    ["unavailable", "guard-effect-unavailable"],
    ["ui-error", "guard-effect-unavailable"],
    ["invalid", "guard-effect-unavailable"],
    ["throw", "guard-effect-unavailable"],
    ["reject", "guard-effect-unavailable"],
  ] as const)("does not run a gate for outcome %s", async (outcome, code) => {
    const review = () => {
      if (outcome === "throw") throw new Error("private callback detail");
      if (outcome === "reject") return Promise.reject(new Error("private callback detail"));
      return (outcome === "invalid" ? "future-outcome" : outcome) as GuardOutcome;
    };
    const guarded = manager(review);
    const exec = vi.fn(async () => execResult());
    const host = workflowHost(guarded, "/workspace", exec);

    const result = await host.runGate("curl -X POST https://example.invalid/resource", {
      agentId: "workflow-agent-2",
      cwd: "/workspace",
    });

    expect(result).toEqual({ ok: false, output: code });
    expect(exec).not.toHaveBeenCalled();
  });

  it("reviews parent-workspace publication at the gate boundary and blocks it when denied", async () => {
    const seen: GuardEffectRequest[] = [];
    const workspace = "/parent/repo";
    const guarded = manager(request => { seen.push(request); return "denied"; });
    const exec = vi.fn(async () => execResult());
    const host = workflowHost(guarded, workspace, exec);

    expect(await host.runGate("git push origin main", { agentId: "workflow-parent-publish", cwd: workspace }))
      .toEqual({ ok: false, output: "guard-effect-denied" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "workflow-exec", argv: [process.platform === "win32" ? "/c" : "-c", "git push origin main"],
      cwd: workspace, resources: { parentWorkspace: workspace },
      ownedByPackage: false, boundTo: "unbounded",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails closed when reviewEffect is missing under guardExpected", async () => {
    const guarded = manager(undefined);
    const exec = vi.fn(async () => execResult());
    const host = workflowHost(guarded, "/workspace", exec);

    const result = await host.runGate("git push", { agentId: "workflow-agent-3", cwd: "/workspace" });

    expect(result).toEqual({ ok: false, output: "guard-effect-review-missing" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("cancels an unresolved review on abort and ignores its late allow", async () => {
    let release!: (value: GuardOutcome) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const guarded = manager(() => new Promise(resolve => { release = resolve; started(); }));
    const controller = new AbortController();
    const exec = vi.fn(async () => execResult());
    const host = workflowHost(guarded, "/workspace", exec, controller.signal);
    const pending = host.runGate("git push origin main", { agentId: "workflow-agent-4", cwd: "/workspace" });

    await began;
    controller.abort();
    expect(await pending).toEqual({ ok: false, output: "guard-effect-cancelled" });
    release("allowed");
    await Promise.resolve();
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not use a replaced registration snapshot after a pending review", async () => {
    let release!: (value: GuardOutcome) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const guarded = manager(() => new Promise(resolve => { release = resolve; started(); }));
    const exec = vi.fn(async () => execResult());
    const host = workflowHost(guarded, "/workspace", exec);
    const pending = host.runGate("curl -X POST https://example.invalid", { agentId: "workflow-agent-5", cwd: "/workspace" });

    await began;
    guarded.unregisterGuard();
    guarded.registerGuard(registration(() => "allowed"));
    release("allowed");

    expect(await pending).toEqual({ ok: false, output: "guard-effect-unavailable" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects a pending review when its registration snapshot changes (M11)", async () => {
    let release!: (value: GuardOutcome) => void;
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const guarded = manager(() => new Promise(resolve => { release = resolve; begin(); }));
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const effect: GuardEffectDescription = {
      kind: "child-git-observation", command: "git", argv: ["rev-parse", "--is-inside-work-tree"],
      cwd: "/tmp", envKeys: [], resources: { parentWorkspace: "/tmp" },
      ownedByPackage: false, boundTo: "unbounded",
    };
    const pending = guarded.reviewGuardEffect(effect, { entryPath: "agent-runner.detect-env", snapshot });
    const rejection = expect(pending).rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    await started;
    guarded.unregisterGuard();
    guarded.registerGuard(registration(() => "allowed"));
    release("allowed");
    await rejection;
    await guarded.dispose();
  });

  it("correlates an effect with its guarded child, delegation, ingress, workflow and frozen context", async () => {
    const seen: GuardEffectRequest[] = [];
    let active!: GuardBridgeRegistration;
    active = {
      protocolVersion: 1,
      registrant: { id: "scope-guard", version: "test" },
      callbacks: {
        captureIngress: vi.fn(),
        enrollResource: vi.fn(),
        createChildContext: vi.fn(request => ({
          rootId: "guard-root",
          parentId: request.parentId,
          childId: request.childId,
          delegationId: request.delegationId,
          taskId: "guard-task",
          scopeRevision: 3,
          executionEpoch: 4,
          resolvedRestrictions: [],
          origin: request.origin,
          bridgeRef: active,
        })),
        revalidate: vi.fn(() => "allowed"),
        approvalSettled: vi.fn(),
        approvalCancelled: vi.fn(),
        approvalExpired: vi.fn(),
        reviewEffect: vi.fn(request => { seen.push(request); return "allowed" as const; }),
      },
    };
    const guarded = new AgentManager();
    managers.push(guarded);
    guarded.setGuardRegistrant("scope-guard");
    guarded.setGuardExpected(true);
    guarded.registerGuard(active);
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      const session = {
        sessionManager: { getSessionFile: () => undefined },
        agent: { state: {} },
        model: undefined,
        thinkingLevel: undefined,
        prompt: vi.fn(async () => {}),
        bindExtensions: vi.fn(async () => {}),
        steer: vi.fn(async () => {}),
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      };
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    const cwd = temporaryDirectory("guard-effect-workflow-correlation-");
    const exec = vi.fn(async () => execResult());
    const host = createWorkflowHost({ pi: { exec } as any, ctx: context(cwd), manager: guarded, workflowId: "workflow-effect-run" });
    const spawned = await host.spawnAgent({
      agentId: "workflow-agent-correlated", index: 0, prompt: "worker request", label: "worker", agentType: "general-purpose",
    } as any);
    expect(spawned.ok).toBe(true);
    const recordId = guarded.listAgents().find(record => record.workflowId === "workflow-effect-run")!.id;

    await host.runGate("gh api -X POST /repos/acme/project/issues", { agentId: "workflow-agent-correlated", cwd });

    expect(seen).toHaveLength(1);
    expect(seen[0].childId).toBe(recordId);
    expect(seen[0].parentId).toBe("root:root-session");
    expect(seen[0].delegationId).toMatch(/^sg-del-/);
    expect(seen[0].ingressId).toMatch(/^sg-ing-/);
    expect(seen[0].workflowId).toBe("workflow-effect-run");
    expect(seen[0].childContext).toMatchObject({
      childId: recordId, parentId: "root:root-session", delegationId: seen[0].delegationId,
      rootId: "guard-root", taskId: "guard-task", scopeRevision: 3, executionEpoch: 4,
    });
    expect(Object.isFrozen(seen[0].childContext)).toBe(true);
    expect(seen[0].childContext).not.toHaveProperty("rawText");
  });

  it("uses the immutable callback snapshot if the registration object's callback is replaced", async () => {
    const original = vi.fn(() => "allowed" as const);
    const active = registration(original);
    const guarded = new AgentManager();
    managers.push(guarded);
    guarded.setGuardRegistrant("scope-guard");
    guarded.setGuardExpected(true);
    guarded.registerGuard(active);
    const replacement = vi.fn(() => "denied" as const);
    active.callbacks.reviewEffect = replacement;
    const exec = vi.fn(async () => execResult());
    const host = workflowHost(guarded, "/workspace", exec);

    expect(await host.runGate("npm test", { agentId: "workflow-agent-snapshot", cwd: "/workspace" })).toMatchObject({ ok: true });
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("reviews child runner git observations as concrete unbounded commands", async () => {
    const seen: GuardEffectRequest[] = [];
    const guarded = manager(request => { seen.push(request); return "allowed"; });
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const cwd = temporaryDirectory("guard-effect-env-");
    const exec = vi.fn()
      .mockResolvedValueOnce(execResult({ stdout: "true" }))
      .mockResolvedValueOnce(execResult({ stdout: "feature/guard-effects" }));
    const review = (effect: any, entryPath: any) => guarded.reviewGuardEffect(effect, {
      entryPath, childId: "observed-child", snapshot,
    });

    await expect(detectEnv({ exec } as any, cwd, review, "/parent/repo")).resolves.toMatchObject({
      isGitRepo: true, branch: "feature/guard-effects",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      kind: "child-git-observation", command: "git", argv: ["rev-parse", "--is-inside-work-tree"],
      cwd, entryPath: "agent-runner.detect-env", childId: "observed-child",
      resources: { parentWorkspace: "/parent/repo" },
      ownedByPackage: false, boundTo: "unbounded", readOnly: true,
    });
    expect(seen[1]).toMatchObject({ argv: ["branch", "--show-current"], readOnly: true });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][1]).toEqual(["rev-parse", "--is-inside-work-tree"]);
    expect(exec.mock.calls[1][1]).toEqual(["branch", "--show-current"]);
  });

  it("rechecks the exact registration snapshot synchronously before pi.exec", async () => {
    const guarded = manager(() => "allowed");
    const prior = guarded.reviewGuardEffect.bind(guarded);
    vi.spyOn(guarded, "reviewGuardEffect").mockImplementation(async (...args) => {
      await prior(...args);
      guarded.unregisterGuard();
      guarded.registerGuard(registration(() => "allowed"));
    });
    const exec = vi.fn(async () => execResult());
    const host = workflowHost(guarded, "/workspace", exec);

    expect(await host.runGate("git push", { agentId: "workflow-agent-last-check", cwd: "/workspace" }))
      .toEqual({ ok: false, output: "guard-effect-unavailable" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps guard-off behavior free of review and preserves direct gate sequencing", async () => {
    const callback = vi.fn(() => "allowed" as const);
    const guarded = manager(callback, false);
    const exec = vi.fn(async () => execResult({ stdout: "same result" }));
    const host = workflowHost(guarded, "/workspace", exec);

    expect(await host.runGate("npm test", { agentId: "workflow-agent-6", cwd: "/workspace" }))
      .toEqual({ ok: true, output: "same result" });
    expect(callback).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toEqual([process.platform === "win32" ? "/c" : "-c", "npm test"]);
  });

  it("truncates large effect environment key lists deterministically", async () => {
    const seen: GuardEffectRequest[] = [];
    const guarded = manager(request => { seen.push(request); return "allowed"; });
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const keys = Array.from({ length: 180 }, (_, index) => `ROUND1_ENV_${String(index).padStart(3, "0")}`);
    const effect: GuardEffectDescription = {
      kind: "child-git-observation", command: "git", argv: ["rev-parse", "--is-inside-work-tree"],
      cwd: "/tmp", envKeys: keys, resources: { parentWorkspace: "/tmp" },
      ownedByPackage: false, boundTo: "unbounded", readOnly: true,
    };
    await expect(guarded.reviewGuardEffect(effect, { entryPath: "agent-runner.detect-env", snapshot })).resolves.toBeUndefined();
    expect(seen[0]?.envKeys).toEqual(keys.slice().sort().slice(0, 128));
    expect(seen[0]).toMatchObject({ envKeysTruncated: true, envKeysTotalCount: 180, readOnly: true });
    await guarded.dispose();
  });

  it("allows detectEnv with more than 128 process environment keys (R5)", async () => {
    const seen: GuardEffectRequest[] = [];
    const guarded = manager(request => { seen.push(request); return "allowed"; });
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const keys = Array.from({ length: 160 }, (_, index) => `ROUND1_PROCESS_ENV_${String(index).padStart(3, "0")}`);
    const prior = new Map(keys.map(key => [key, process.env[key]]));
    try {
      keys.forEach(key => { process.env[key] = "test-value"; });
      const total = Object.keys(process.env).length;
      const exec = vi.fn()
        .mockResolvedValueOnce(execResult({ stdout: "true" }))
        .mockResolvedValueOnce(execResult({ stdout: "main" }));
      const review = (effect: any, entryPath: any) => guarded.reviewGuardEffect(effect, { entryPath, snapshot });
      await expect(detectEnv({ exec } as any, "/tmp", review)).resolves.toMatchObject({ isGitRepo: true, branch: "main" });
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({ envKeysTruncated: true, envKeysTotalCount: total, readOnly: true });
      expect(seen[0]?.envKeys).toHaveLength(128);
      expect(exec).toHaveBeenCalledTimes(2);
    } finally {
      for (const key of keys) {
        const value = prior.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await guarded.dispose();
    }
  });

  it("bounds a never-settling headless effect review at ten seconds", async () => {
    vi.useFakeTimers();
    const guarded = manager(() => new Promise<GuardOutcome>(() => {}));
    guarded.setHeadless(true);
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const effect: GuardEffectDescription = {
      kind: "workflow-exec", command: "/bin/sh", argv: ["-c", "true"], cwd: "/tmp", envKeys: [],
      resources: { parentWorkspace: "/tmp" }, ownedByPackage: false, boundTo: "unbounded",
    };
    const pending = guarded.reviewGuardEffect(effect, { entryPath: "workflow.pi-exec.gate", snapshot, signal: new AbortController().signal });
    const rejection = expect(pending).rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    await guarded.dispose();
  });

  it("bounds a never-settling effect review when no abort signal exists", async () => {
    vi.useFakeTimers();
    const guarded = manager(() => new Promise<GuardOutcome>(() => {}));
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const effect: GuardEffectDescription = {
      kind: "worktree-prune", command: "git", argv: ["worktree", "prune"], cwd: "/tmp", envKeys: [],
      resources: { parentWorkspace: "/tmp" }, ownedByPackage: false, boundTo: "unbounded",
    };
    const pending = guarded.reviewGuardEffect(effect, { entryPath: "worktree.prune", snapshot });
    const rejection = expect(pending).rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    await guarded.dispose();
  });

  it("asserts the detectEnv snapshot before each read-only git observation", async () => {
    const guarded = manager(() => "allowed");
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const exec = vi.fn(async () => execResult({ stdout: "true" }));
    const assertActive = () => {
      guarded.unregisterGuard();
      guarded.registerGuard(registration(() => "allowed"));
      guarded.assertGuardEffectSnapshotActive(snapshot, "agent-runner.detect-env");
    };
    await expect(detectEnv({ exec } as any, "/tmp", async () => {}, "/tmp", undefined, assertActive))
      .rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    expect(exec).not.toHaveBeenCalled();
    await guarded.dispose();
  });

  it("reviews a workflow gate with no agent id instead of executing it unguarded", async () => {
    const seen: GuardEffectRequest[] = [];
    const guarded = manager(request => { seen.push(request); return "allowed"; });
    const exec = vi.fn(async () => execResult({ stdout: "ok" }));
    const host = workflowHost(guarded, "/workspace", exec);
    await expect(host.runGate("echo ok", { cwd: "/workspace" })).resolves.toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "workflow-exec", ownedByPackage: false, boundTo: "unbounded" });
    expect(exec).toHaveBeenCalledTimes(1);
    await guarded.dispose();
  });
});

function fakeGit(piCalls: Array<{ command: string; args: string[]; options: any }>, baseRepo: string) {
  return vi.fn(async (command: string, args: string[], options: any) => {
    piCalls.push({ command, args: [...args], options });
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return execResult({ stdout: "true" });
    if (args[0] === "rev-parse" && args[1] === "HEAD") return execResult({ stdout: "base-sha" });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return execResult({ stdout: baseRepo });
    if (args[0] === "worktree" && args[1] === "add") {
      mkdirSync(args[3], { recursive: true });
      tempDirectories.push(args[3]);
      return execResult();
    }
    if (args[0] === "status") return execResult({ stdout: " M source.ts\n" });
    return execResult();
  });
}

describe("package-owned worktree effect boundaries", () => {
  it("describes create, capture/commit, and remove with exact owned resources", async () => {
    const captured: GuardEffectRequest[] = [];
    const guarded = manager(request => { captured.push(request); return "allowed"; });
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const repo = temporaryGitRepo("guard-effect-repo-");
    const executionLog = installGitArgvLogger();
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    const pi = { exec: fakeGit(calls, repo) } as any;
    const childId = "effect-child-1";
    const hooks: WorktreeEffectHooks = {
      childId,
      parentWorkspace: repo,
      reviewEffect: (effect, entryPath) => guarded.reviewGuardEffect(effect, { entryPath, childId, snapshot }),
    };

    const worktree = await createWorktree(pi, repo, childId, hooks);
    expect(worktree).toBeDefined();
    tempDirectories.push(worktree!.path);
    writeFileSync(join(worktree!.path, "changed.txt"), "change\n");
    await cleanupWorktree(pi, repo, worktree!, "worker description", hooks);

    const add = captured.find(request => request.kind === "worktree-create" && request.argv.includes("add"))!;
    expect(add).toMatchObject({
      kind: "worktree-create",
      command: "git",
      cwd: repo,
      entryPath: "worktree.create",
      childId,
      resources: { worktreePath: worktree!.path, branch: worktree!.branch, baseRepo: realpathSync(repo), parentWorkspace: repo },
      ownedByPackage: true,
      boundTo: "owned-resources",
    });
    expect(add.argv.slice(-5)).toEqual(["worktree", "add", "--detach", worktree!.path, "HEAD"]);
    expect(add.argv).toEqual(expect.arrayContaining([
      "-c", "core.hooksPath=/dev/null", "core.fsmonitor=false", "core.sshCommand=/bin/false",
      "protocol.allow=never", "commit.gpgsign=false", `--git-dir=${realpathSync(join(repo, ".git"))}`,
      `--work-tree=${realpathSync(repo)}`,
    ]));
    expect(add.envKeys).toContain("GIT_CONFIG_NOSYSTEM");
    expect(add.envKeys).toContain("GIT_CONFIG_GLOBAL");
    expect(add.envKeys).not.toContain("GIT_DIR");
    const captures = captured.filter(request => request.kind === "worktree-capture");
    expect(captures.length).toBeGreaterThanOrEqual(4);
    const staging = captures.find(request => request.argv.slice(-2)[0] === "add");
    expect(staging).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
    expect(staging?.envKeys).toContain("GIT_CONFIG_NOSYSTEM");
    const boundedCaptures = captures.filter(request => request !== staging);
    expect(boundedCaptures.every(request => request.entryPath === "worktree.capture" && request.ownedByPackage && request.boundTo === "owned-resources")).toBe(true);
    expect(captures.every(request => request.cwd === worktree!.path && request.resources.worktreePath === worktree!.path)).toBe(true);
    const remove = captured.find(request => request.kind === "worktree-remove")!;
    expect(remove).toMatchObject({
      kind: "worktree-remove",
      argv: expect.arrayContaining(["-c", "core.hooksPath=/dev/null", `--git-dir=${worktree!.gitDir}`, `--work-tree=${worktree!.path}`, "worktree", "remove", "--force", worktree!.path]),
      entryPath: "worktree.remove",
      childId,
      resources: { worktreePath: worktree!.path, branch: worktree!.branch, baseRepo: realpathSync(repo), parentWorkspace: repo },
      ownedByPackage: true,
      boundTo: "owned-resources",
    });
    expect(Object.isFrozen(add.argv)).toBe(true);
    expect(Object.isFrozen(add.resources)).toBe(true);
    const executedArgv = loggedGitArgv(executionLog);
    const reviewedArgv = captured.filter(request => request.envKeys.includes("GIT_CONFIG_NOSYSTEM")).map(request => [...request.argv]);
    expect(executedArgv).toEqual(reviewedArgv);
    expect(snapshot).toBeDefined();
  });

  it("denies worktree creation before invoking the concrete git add", async () => {
    const guarded = manager(request => request.kind === "worktree-create" && request.argv.includes("add") ? "denied" : "allowed");
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const repo = temporaryGitRepo("guard-effect-denied-repo-");
    const executionLog = installGitArgvLogger();
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    const pi = { exec: fakeGit(calls, repo) } as any;
    const childId = "effect-child-denied";
    const hooks: WorktreeEffectHooks = {
      childId,
      parentWorkspace: repo,
      reviewEffect: (effect, entryPath) => guarded.reviewGuardEffect(effect, { entryPath, childId, snapshot }),
    };

    await expect(createWorktree(pi, repo, childId, hooks)).rejects.toMatchObject({ reasonCode: "guard-effect-denied" });
    expect(loggedGitArgv(executionLog)).toHaveLength(0);
  });

  it.each(["dotdot", "sibling-prefix", "symlink-escape", "branch-prefix", "parent-repo-cwd"] as const)(
    "marks mismatched %s worktree resources unbounded instead of package-owned",
    async adversary => {
      const captured: GuardEffectRequest[] = [];
      const guarded = manager(request => { captured.push(request); return "allowed"; });
      const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
      const repo = temporaryGitRepo(`guard-effect-${adversary}-`);
      const calls: Array<{ command: string; args: string[]; options: any }> = [];
      const pi = { exec: fakeGit(calls, repo) } as any;
      const childId = `effect-child-${adversary}`;
      const hooks: WorktreeEffectHooks = {
        childId,
        parentWorkspace: repo,
        reviewEffect: (effect, entryPath) => guarded.reviewGuardEffect(effect, { entryPath, childId, snapshot }),
      };
      const worktree = await createWorktree(pi, repo, childId, hooks);
      expect(worktree).toBeDefined();
      tempDirectories.push(worktree!.path);

      const cleanupCwd = repo;
      if (adversary === "dotdot") worktree!.path = `${worktree!.path}/../${worktree!.path.split("/").at(-1)!}`;
      if (adversary === "sibling-prefix") {
        worktree!.path = `${worktree!.path}-sibling`;
        mkdirSync(worktree!.path, { recursive: true });
        tempDirectories.push(worktree!.path);
      }
      if (adversary === "symlink-escape") {
        const outside = temporaryDirectory("guard-effect-outside-");
        rmSync(worktree!.path, { recursive: true, force: true });
        symlinkSync(outside, worktree!.path);
      }
      if (adversary === "branch-prefix") worktree!.branch = `${worktree!.branch}-attacker`;
      if (adversary === "parent-repo-cwd") worktree!.path = repo;

      const cleanup = cleanupWorktree(pi, cleanupCwd, worktree!, "adversarial", hooks);
      if (["dotdot", "sibling-prefix", "symlink-escape", "parent-repo-cwd"].includes(adversary)) {
        await expect(cleanup).rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
      } else {
        await cleanup;
      }
      const relevant = captured.filter(request => request.kind === "worktree-capture" || request.kind === "worktree-remove");
      expect(relevant.length).toBeGreaterThan(0);
      expect(relevant.every(request => request.ownedByPackage === false && request.boundTo === "unbounded")).toBe(true);
      if (adversary === "parent-repo-cwd") {
        expect(relevant.some(request => request.kind === "worktree-capture" && request.cwd === repo && request.boundTo === "unbounded")).toBe(true);
      }
      if (adversary === "branch-prefix") {
        expect(relevant.some(request => request.resources.branch === worktree!.branch && request.boundTo === "unbounded")).toBe(true);
      }
    },
  );

  it("rechecks package ownership after a review changes the reserved worktree path (M2/M14)", async () => {
    const captured: GuardEffectRequest[] = [];
    const repo = temporaryGitRepo("guard-effect-post-review-");
    const executionLog = installGitArgvLogger();
    const childId = "effect-child-post-review";
    const hooks: WorktreeEffectHooks = {
      childId,
      parentWorkspace: repo,
      reviewEffect: async effect => {
        captured.push(effect as GuardEffectRequest);
        if (effect.kind === "worktree-create" && effect.argv.includes("add")) {
          const path = effect.resources.worktreePath!;
          mkdirSync(path, { recursive: true });
          tempDirectories.push(path);
        }
      },
    };
    await expect(createWorktree({ exec: fakeGit([], repo) } as any, repo, childId, hooks))
      .rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    const add = captured.find(effect => effect.kind === "worktree-create" && effect.argv.includes("add"));
    expect(add).toMatchObject({ ownedByPackage: true, boundTo: "owned-resources" });
    expect(loggedGitArgv(executionLog)).toHaveLength(0);
  });

  it("fails closed when the registration is replaced during worktree-add review (M3/M11)", async () => {
    const captured: GuardEffectRequest[] = [];
    let guarded!: AgentManager;
    guarded = manager(request => {
      captured.push(request);
      if (request.argv.includes("add")) {
        guarded.unregisterGuard();
        guarded.registerGuard(registration(() => "allowed"));
      }
      return "allowed";
    });
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const repo = temporaryGitRepo("guard-effect-registration-repo-");
    const executionLog = installGitArgvLogger();
    const childId = "effect-child-registration";
    const hooks: WorktreeEffectHooks = {
      childId,
      parentWorkspace: repo,
      reviewEffect: (effect, entryPath) => guarded.reviewGuardEffect(effect, { entryPath, childId, snapshot }),
      assertSnapshotActive: entryPath => guarded.assertGuardEffectSnapshotActive(snapshot, entryPath),
    };
    await expect(createWorktree({ exec: fakeGit([], repo) } as any, repo, childId, hooks))
      .rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    expect(captured.some(effect => effect.kind === "worktree-create" && effect.argv.includes("add"))).toBe(true);
    expect(loggedGitArgv(executionLog)).toHaveLength(0);
  });

  it("rechecks the registration snapshot after a worktree effect review (M3)", async () => {
    const captured: GuardEffectDescription[] = [];
    const repo = temporaryGitRepo("guard-effect-snapshot-");
    const childId = "effect-child-snapshot";
    let replaced = false;
    const hooks: WorktreeEffectHooks = {
      childId,
      parentWorkspace: repo,
      reviewEffect: async effect => {
        captured.push(effect);
        if (effect.kind === "worktree-create" && effect.argv.includes("add")) replaced = true;
      },
      assertSnapshotActive: entryPath => {
        if (replaced) {
          throw new GuardBridgeRejection(
            "guard-effect-unavailable", entryPath,
            `guard-effect-unavailable: guarded work is unavailable at ${entryPath}; snapshot changed.`,
          );
        }
      },
    };
    await expect(createWorktree({ exec: fakeGit([], repo) } as any, repo, childId, hooks))
      .rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    expect(captured.some(effect => effect.kind === "worktree-create" && effect.argv.includes("add"))).toBe(true);
  });

  it("prevents real prepare-commit-msg and post-commit hooks and reviews the exact executed git argv", async () => {
    const captured: GuardEffectRequest[] = [];
    const guarded = manager(request => { captured.push(request); return "allowed"; });
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const repo = temporaryGitRepo("guard-effect-hooks-repo-");
    const executionLog = installGitArgvLogger();
    const markerDir = temporaryDirectory("guard-effect-hook-marker-");
    const marker = join(markerDir, "hooks-ran");
    const hookEnvKeys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
    const previous = new Map(hookEnvKeys.map(key => [key, process.env[key]]));
    const childId = "effect-child-hooks";
    const hooks: WorktreeEffectHooks = {
      childId,
      parentWorkspace: repo,
      reviewEffect: (effect, entryPath) => guarded.reviewGuardEffect(effect, { entryPath, childId, snapshot }),
    };
    try {
      const worktree = await createWorktree({ exec: fakeGit([], repo) } as any, repo, childId, hooks);
      expect(worktree).toBeDefined();
      tempDirectories.push(worktree!.path);
      const hookDir = join(worktree!.path, ".husky", "_");
      mkdirSync(hookDir, { recursive: true });
      for (const name of ["prepare-commit-msg", "post-commit"]) {
        const hook = join(hookDir, name);
        writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' ${name} >> '${marker}'\n`);
        chmodSync(hook, 0o755);
      }
      execFileSync("git", ["-C", repo, "config", "core.hooksPath", hookDir]);
      process.env.WORKTREE_TEST_HOOK_MARKER = marker;
      process.env.GIT_DIR = "/tmp/attacker.git";
      process.env.GIT_WORK_TREE = "/tmp/attacker-worktree";
      process.env.GIT_INDEX_FILE = "/tmp/attacker-index";
      process.env.GIT_COMMON_DIR = "/tmp/attacker-common";
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
      process.env.GIT_CONFIG_VALUE_0 = "/tmp/attacker-hooks";
      writeFileSync(join(worktree!.path, "child-change.txt"), "child change\\n");

      await cleanupWorktree({ exec: fakeGit([], repo) } as any, repo, worktree!, "worker", hooks);
      expect(existsSync(marker)).toBe(false);
      const hardenedRequests = captured.filter(request => request.envKeys.includes("GIT_CONFIG_NOSYSTEM"));
      expect(hardenedRequests.some(request => request.argv.includes("commit") && request.ownedByPackage)).toBe(true);
      expect(hardenedRequests.some(request => request.argv.slice(-2)[0] === "add" && !request.ownedByPackage && request.boundTo === "unbounded")).toBe(true);
      expect(hardenedRequests.every(request => request.envKeys.includes("GIT_CONFIG_GLOBAL"))).toBe(true);
      expect(hardenedRequests.every(request => hookEnvKeys.every(key => !request.envKeys.includes(key)))).toBe(true);
      expect(loggedGitArgv(executionLog).filter(argv => argv[0] !== "-C")).toEqual(hardenedRequests.map(request => [...request.argv]));
    } finally {
      for (const key of hookEnvKeys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env.WORKTREE_TEST_HOOK_MARKER;
    }
  });

  it("refuses a rewritten worktree .git pointer as unbounded without running its hooks", async () => {
    const captured: GuardEffectRequest[] = [];
    const guarded = manager(request => { captured.push(request); return "allowed"; });
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const repo = temporaryGitRepo("guard-effect-pointer-repo-");
    const marker = join(temporaryDirectory("guard-effect-pointer-marker-"), "ran");
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    const pi = { exec: fakeGit(calls, repo) } as any;
    const childId = "effect-child-pointer";
    const hooks: WorktreeEffectHooks = {
      childId,
      parentWorkspace: repo,
      reviewEffect: (effect, entryPath) => guarded.reviewGuardEffect(effect, { entryPath, childId, snapshot }),
    };
    const worktree = await createWorktree(pi, repo, childId, hooks);
    expect(worktree).toBeDefined();
    tempDirectories.push(worktree!.path);
    const evilGitDir = join(worktree!.path, ".evilgit");
    const hookDir = join(worktree!.path, ".evil-hooks");
    mkdirSync(hookDir, { recursive: true });
    const hook = join(hookDir, "prepare-commit-msg");
    writeFileSync(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`);
    chmodSync(hook, 0o755);
    mkdirSync(evilGitDir, { recursive: true });
    writeFileSync(join(evilGitDir, "config"), `[core]\n\thooksPath = ${hookDir}\n`);
    writeFileSync(join(worktree!.path, ".git"), "gitdir: ./.evilgit\n");
    writeFileSync(join(worktree!.path, "child-change.txt"), "child change\\n");

    await expect(cleanupWorktree(pi, repo, worktree!, "worker", hooks)).rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    const rejectedCapture = captured.find(request => request.kind === "worktree-capture");
    expect(rejectedCapture).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
    expect(calls).toHaveLength(3); // only the pre-creation read-only probes ran
    expect(existsSync(marker)).toBe(false);
  });

  it("routes prune as an unbounded concrete effect", async () => {
    const captured: GuardEffectRequest[] = [];
    const guarded = manager(request => { captured.push(request); return "allowed"; });
    const snapshot = guarded.guardBridgeHost.getResourceEnrollmentSnapshotIdentity()!;
    const repo = temporaryDirectory("guard-effect-prune-");
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    const pi = { exec: fakeGit(calls, repo) } as any;
    const childId = "";
    await pruneWorktrees(pi, repo, {
      childId,
      parentWorkspace: repo,
      reviewEffect: (effect, entryPath) => guarded.reviewGuardEffect(effect, { entryPath, snapshot }),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      kind: "worktree-prune",
      argv: ["worktree", "prune"],
      cwd: repo,
      entryPath: "worktree.prune",
      ownedByPackage: false,
      boundTo: "unbounded",
    });
    expect(calls).toHaveLength(1);
  });
});
