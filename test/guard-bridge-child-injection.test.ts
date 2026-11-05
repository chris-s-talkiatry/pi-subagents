import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerTypes from "../src/agent-runner.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import type * as WorktreeTypes from "../src/worktree.js";

const piMocks = vi.hoisted(() => ({ createAgentSession: vi.fn() }));
const runnerObservations = vi.hoisted(() => ({ runOptions: [] as unknown[], resumeOptions: [] as unknown[] }));
const worktreeMocks = vi.hoisted(() => ({
  createWorktree: vi.fn(async (_pi: unknown, cwd: string, _id: string) => ({
    path: cwd,
    workPath: cwd,
    branch: "injection-test-branch",
    baseSha: "base-sha",
  })),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  pruneWorktrees: vi.fn(async () => {}),
  setWorktreeIsolationEnabled: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, createAgentSession: piMocks.createAgentSession };
});

vi.mock("../src/agent-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof AgentRunnerTypes>();
  return {
    ...actual,
    runAgent: (...args: Parameters<typeof actual.runAgent>) => {
      runnerObservations.runOptions.push(args[3]);
      return actual.runAgent(...args);
    },
    resumeAgent: (...args: Parameters<typeof actual.resumeAgent>) => {
      runnerObservations.resumeOptions.push(args[2]);
      return actual.resumeAgent(...args);
    },
  };
});

vi.mock("../src/worktree.js", async importOriginal => {
  const actual = await importOriginal<typeof WorktreeTypes>();
  return { ...actual, ...worktreeMocks };
});

import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { GUARD_CHILD_CONTEXT_UPDATED_EVENT, GUARD_CHILD_INJECTION_TIMEOUT_MS, GuardBridgeHost, type GuardBridgeRegistration, type GuardChildContext, type GuardChildContextRequest, type GuardChildGuardFactory, type GuardEntryPathId, getGuardChildContext } from "../src/guard-bridge.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { hermeticDir, ctx as makeContext, makePi } from "./helpers/boot-extension.js";

const TEST_AGENT = "child-injection-probe";
const defaultAgentConfig: AgentConfig = {
  name: TEST_AGENT,
  description: "Child guard injection test agent",
  builtinToolNames: ["read"],
  extensions: false,
  skills: false,
  systemPrompt: "",
  promptMode: "replace",
  persistSession: false,
  source: "project",
};

function registration(options: {
  childGuard?: GuardChildGuardFactory;
  registrant?: { id: string; version: string };
  protocolVersion?: number;
  onContext?: (request: GuardChildContextRequest) => void;
} = {}): GuardBridgeRegistration {
  let active: GuardBridgeRegistration;
  active = {
    protocolVersion: options.protocolVersion ?? 1,
    registrant: options.registrant ?? { id: "scope-guard", version: "1" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource: vi.fn(),
      createChildContext: vi.fn((request: GuardChildContextRequest) => {
        options.onContext?.(request);
        return {
          rootId: "root-owned",
          parentId: request.parentId,
          childId: request.childId,
          delegationId: request.delegationId,
          taskId: "task-owned",
          scopeRevision: 7,
          executionEpoch: 3,
          resolvedRestrictions: [],
          origin: request.origin,
          bridgeRef: active,
        };
      }),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
      reviewEffect: vi.fn(() => "allowed"),
    },
    ...(options.childGuard ? { createChildGuardExtension: options.childGuard } : {}),
  };
  return active;
}

function hostWith(reg: GuardBridgeRegistration): GuardBridgeHost {
  const host = new GuardBridgeHost(true, "scope-guard");
  const result = host.register(reg);
  if (!result.compatible) throw new Error(result.registrationRejected);
  return host;
}

async function makeChildContext(
  host: GuardBridgeHost,
  childId: string,
  entryPath: GuardEntryPathId = "agent-manager.spawn",
  operation: "spawn" | "resume" = "spawn",
  parentContext?: GuardChildContext,
  worktree = false,
): Promise<GuardChildContext> {
  const context = await host.createChildContext({
    childId,
    parentId: parentContext?.childId ?? "root:root-session",
    origin: "parent-model-delegation",
    entryPath,
    operation,
    ...(parentContext ? { parentContext } : {}),
    inheritContext: false,
    isolatedExtensions: false,
    worktree,
    scopeRefStatus: "not-applicable",
  });
  if (!context) throw new Error("expected a guarded child context");
  return context;
}

function fakeSession(activeTools: string[] = ["read"]): AgentRecord["session"] {
  const currentTools = [...activeTools];
  const availableTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  return {
    agent: { state: { messages: [], systemPrompt: "" } },
    messages: [],
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "child-session" },
    model: undefined,
    thinkingLevel: "off",
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    getAllTools: vi.fn(() => availableTools.map(name => ({ name }))),
    getActiveToolNames: vi.fn(() => [...currentTools]),
    setActiveToolsByName: vi.fn((names: string[]) => {
      currentTools.splice(0, currentTools.length, ...names);
    }),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    abort: vi.fn(),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as AgentRecord["session"];
}

let home: ReturnType<typeof hermeticDir>;
let pi: ReturnType<typeof makePi>["pi"];
let ctx: ReturnType<typeof makeContext>;
let sessions: NonNullable<AgentRecord["session"]>[];
let managers: AgentManager[];

beforeEach(() => {
  home = hermeticDir();
  pi = makePi().pi;
  ctx = makeContext({
    cwd: home.dir,
    getSystemPrompt: () => "root system prompt",
    model: undefined,
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    sessionManager: { getSessionId: () => "root-session", getSessionFile: () => undefined },
  });
  sessions = [];
  managers = [];
  runnerObservations.runOptions.length = 0;
  runnerObservations.resumeOptions.length = 0;
  worktreeMocks.createWorktree.mockImplementation(async (_pi: unknown, cwd: string) => ({
    path: cwd,
    workPath: cwd,
    branch: "injection-test-branch",
    baseSha: "base-sha",
  }));
  worktreeMocks.cleanupWorktree.mockResolvedValue({ hasChanges: false });
  piMocks.createAgentSession.mockReset().mockImplementation(async options => {
    const session = fakeSession(options.tools ?? ["read", "bash", "edit", "write"]);
    sessions.push(session);
    return { session };
  });
  registerAgents(new Map([[TEST_AGENT, defaultAgentConfig]]));
});

afterEach(async () => {
  for (const manager of managers) await manager.dispose();
  registerAgents(new Map());
  home.restore();
});

describe("mandatory child guard factory", () => {
  it("calls the frozen hook once with its validated context and a private per-session handle, then loads it last", async () => {
    const mutatorPath = join(home.dir, "mutator.ts");
    const observerPath = join(home.dir, "observer.ts");
    writeFileSync(mutatorPath, "export default (pi) => { pi.on('tool_call', () => {}); };\n");
    writeFileSync(observerPath, "export default (pi) => { pi.on('tool_call', () => {}); };\n");
    registerAgents(new Map([[TEST_AGENT, { ...defaultAgentConfig, extensions: [mutatorPath, observerPath] }]]));

    const factory = vi.fn(() => {});
    const hook = vi.fn((_context: GuardChildContext, _handle: { childId: string; token: symbol }) => factory);
    const reg = registration({ childGuard: hook });
    const host = hostWith(reg);
    const childContext = await makeChildContext(host, "child-one");
    const mutatedOriginalHook = vi.fn(() => { throw new Error("mutable original must not run"); });
    reg.createChildGuardExtension = mutatedOriginalHook;

    const result = await runAgent(ctx, TEST_AGENT, "inspect", {
      pi,
      guardBridgeHost: host,
      guardExpected: true,
      guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
      guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
      guardChildContext: childContext,
      agentId: childContext.childId,
      nested: true,
      cwd: home.dir,
      configCwd: home.dir,
    });


    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toBe(childContext);
    const handle = hook.mock.calls[0][1];
    expect(handle).toMatchObject({ childId: "child-one" });
    expect(typeof handle.token).toBe("symbol");
    expect(Object.isFrozen(handle)).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);

    const paths = (piMocks.createAgentSession.mock.calls[0]![0].resourceLoader as DefaultResourceLoader)
      .getExtensions().extensions.map(extension => extension.path);
    expect(paths.some(path => path.includes("mutator.ts"))).toBe(true);
    expect(paths.some(path => path.includes("observer.ts"))).toBe(true);
    expect(paths.at(-1)).toBe("<inline:guard-child-injection>");
    expect(paths.filter(path => path === "<inline:guard-child-injection>")).toHaveLength(1);
    expect(result.session?.agent.state.guardChildContext).toBe(childContext);
    expect(mutatedOriginalHook).not.toHaveBeenCalled();
  });

  it("does not reinject on same-session resume, but gives every newly constructed session its own injection", async () => {
    const hookCalls: Array<{ context: GuardChildContext; token: symbol }> = [];
    const factory = vi.fn(() => {});
    const reg = registration({
      childGuard: (context, handle) => {
        hookCalls.push({ context, token: handle.token });
        return factory;
      },
    });
    const host = hostWith(reg);
    const firstContext = await makeChildContext(host, "session-one");
    const baseOptions = {
      pi,
      guardBridgeHost: host,
      guardExpected: true,
      guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
      guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
      nested: true,
      cwd: home.dir,
      configCwd: home.dir,
    };
    const first = await runAgent(ctx, TEST_AGENT, "first", {
      ...baseOptions,
      guardChildContext: firstContext,
      agentId: firstContext.childId,
    });
    const resumeContext = await makeChildContext(host, "session-one", "agent-manager.resume", "resume");
    await resumeAgent(first.session!, "again", {
      guardBridgeHost: host,
      guardExpected: true,
      guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
      guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
      guardChildContext: resumeContext,
    });
    expect(hookCalls).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(1);

    const secondContext = await makeChildContext(host, "session-two");
    await runAgent(ctx, TEST_AGENT, "second", {
      ...baseOptions,
      guardChildContext: secondContext,
      agentId: secondContext.childId,
    });
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[1]!.context).toBe(secondContext);
    expect(hookCalls[1]!.token).not.toBe(hookCalls[0]!.token);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("rejects a child when Pi drops the inline extension after its returned factory throws", async () => {
    const host = hostWith(registration({ childGuard: () => () => { throw new Error("private load-time secret"); } }));
    const childContext = await makeChildContext(host, "load-time-failure");
    const run = runAgent(ctx, TEST_AGENT, "must remain guarded", {
      pi,
      guardBridgeHost: host,
      guardExpected: true,
      guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
      guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
      guardChildContext: childContext,
      nested: true,
      cwd: home.dir,
    });
    await expect(run).rejects.toMatchObject({
      reasonCode: "guard-child-injection-failed",
      message: "guard-child-injection-failed: guarded work is unavailable at agent-manager.spawn; child guard injection could not be prepared.",
    });
    await run.catch(error => { expect(String(error.message)).not.toContain("private load-time secret"); });
    expect(piMocks.createAgentSession).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "not-last"] as const)("rejects a %s inline guard loader entry", async mutation => {
    const host = hostWith(registration({ childGuard: () => () => {} }));
    const childContext = await makeChildContext(host, `loader-${mutation}`);
    const original = DefaultResourceLoader.prototype.getExtensions;
    const getExtensions = vi.spyOn(DefaultResourceLoader.prototype, "getExtensions").mockImplementation(function (this: DefaultResourceLoader) {
      const loaded = original.call(this);
      const inline = loaded.extensions.find(extension => extension.path === "<inline:guard-child-injection>");
      if (!inline) return loaded;
      const injected = mutation === "duplicate"
        ? { ...inline }
        : { ...inline, path: "<after:guard-child-injection>" };
      return { ...loaded, extensions: [...loaded.extensions, injected] };
    });
    try {
      await expect(runAgent(ctx, TEST_AGENT, "must not start", {
        pi,
        guardBridgeHost: host,
        guardExpected: true,
        guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
        guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
        guardChildContext: childContext,
        nested: true,
        cwd: home.dir,
      })).rejects.toMatchObject({ reasonCode: "guard-child-injection-failed" });
      expect(piMocks.createAgentSession).not.toHaveBeenCalled();
    } finally {
      getExtensions.mockRestore();
    }
  });

  it("refreshes the injected guard's marker on resume without a public update event", async () => {
    let childEvents: ExtensionAPI["events"] | undefined;
    const host = hostWith(registration({ childGuard: () => piApi => { childEvents = piApi.events; } }));
    const childContext = await makeChildContext(host, "resume-context");
    const first = await runAgent(ctx, TEST_AGENT, "first", {
      pi,
      guardBridgeHost: host,
      guardExpected: true,
      guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
      guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
      guardChildContext: childContext,
      agentId: childContext.childId,
      nested: true,
      cwd: home.dir,
    });
    expect(childEvents).toBeDefined();
    expect(getGuardChildContext(childEvents as any)?.scopeRevision).toBe(childContext.scopeRevision);
    const publicUpdate = vi.fn();
    (childEvents as any).on(GUARD_CHILD_CONTEXT_UPDATED_EVENT, publicUpdate);
    (childEvents as any).on("subagents:child-context-query", (query: { respond: (value: unknown) => void }) => {
      query.respond({ childId: "spoofed-resume-context" });
    });

    const resumeContext = await makeChildContext(host, childContext.childId, "agent-manager.resume", "resume");
    await resumeAgent(first.session!, "resume", {
      guardBridgeHost: host,
      guardExpected: true,
      guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
      guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
      guardChildContext: resumeContext,
    });

    expect(getGuardChildContext(childEvents as any)).toMatchObject({
      childId: childContext.childId,
      scopeRevision: resumeContext.scopeRevision,
      delegationId: resumeContext.delegationId,
    });
    expect((getGuardChildContext(childEvents as any)!.bridgeRef as any).createChildGuardExtension).toBeUndefined();
    expect(Object.isFrozen(getGuardChildContext(childEvents as any)!.bridgeRef)).toBe(true);
    expect(publicUpdate).not.toHaveBeenCalled();
  });

  it("times out a never-resolving factory when runner preparation has no abort signal", async () => {
    vi.useFakeTimers();
    try {
      const entered = vi.fn();
      const host = hostWith(registration({ childGuard: () => { entered(); return new Promise<AgentRunnerTypes.ExtensionFactory>(() => {}); } }));
      const childContext = await makeChildContext(host, "timeout-child");
      let settled = false;
      const pending = runAgent(ctx, TEST_AGENT, "must time out", {
        pi,
        guardBridgeHost: host,
        guardExpected: true,
        guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
        guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
        guardChildContext: childContext,
        nested: true,
        cwd: home.dir,
      }).then(() => { settled = true; }, error => { settled = true; return error; });
      expect(entered).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(GUARD_CHILD_INJECTION_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await pending;
      expect(error).toMatchObject({ reasonCode: "guard-child-injection-failed", entryPath: "agent-manager.spawn" });
      expect(String(error.message)).not.toContain("secret");
      expect(piMocks.createAgentSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for absent, throwing, rejecting, and non-function child hooks", async () => {
    const cases: Array<[string, GuardChildGuardFactory | undefined]> = [
      ["absent", undefined],
      ["throws", () => { throw new Error("private factory detail"); }],
      ["rejects", async () => { throw new Error("private async detail"); }],
      ["returns non-function", () => 17 as unknown as (pi: ExtensionAPI) => void],
    ];
    for (const [label, childGuard] of cases) {
      const reg = registration(childGuard ? { childGuard } : {});
      const host = hostWith(reg);
      const childContext = await makeChildContext(host, `failure-${label}`);
      await expect(runAgent(ctx, TEST_AGENT, "must not start", {
        pi,
        guardBridgeHost: host,
        guardExpected: true,
        guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
        guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
        guardChildContext: childContext,
        nested: true,
        cwd: home.dir,
      })).rejects.toMatchObject({
        name: "GuardBridgeRejection",
        reasonCode: "guard-child-injection-failed",
        entryPath: "agent-manager.spawn",
        message: "guard-child-injection-failed: guarded work is unavailable at agent-manager.spawn; child guard injection could not be prepared.",
      });
    }
    expect(piMocks.createAgentSession).not.toHaveBeenCalled();

    const nonFunction = { ...registration(), createChildGuardExtension: 12 } as unknown as GuardBridgeRegistration;
    const host = new GuardBridgeHost(true, "scope-guard");
    expect(host.register(nonFunction)).toMatchObject({ compatible: false, reasonCode: "guard-incompatible-protocol" });
    await expect(runAgent(ctx, TEST_AGENT, "incompatible", {
      pi,
      guardBridgeHost: host,
      guardExpected: true,
    })).rejects.toMatchObject({ reasonCode: "guard-incompatible-protocol" });
    expect(piMocks.createAgentSession).not.toHaveBeenCalled();
  });
  it("rejects a registration replaced while the frozen child factory is pending", async () => {
    let hookEntered!: () => void;
    let finishHook!: (factory: AgentRunnerTypes.ExtensionFactory) => void;
    const entered = new Promise<void>(resolve => { hookEntered = resolve; });
    const pendingFactory = new Promise<AgentRunnerTypes.ExtensionFactory>(resolve => { finishHook = resolve; });
    const host = hostWith(registration({
      childGuard: () => {
        hookEntered();
        return pendingFactory;
      },
    }));
    const oldContext = await makeChildContext(host, "replaced-during-hook");
    const oldSnapshot = host.getResourceEnrollmentSnapshotIdentity();
    const oldRegistration = host.getValidatedRegistrationSnapshot();
    const run = runAgent(ctx, TEST_AGENT, "must not construct", {
      pi,
      guardExpected: true,
      guardBridgeHost: host,
      guardBridgeRegistration: oldRegistration,
      guardRegistrationSnapshot: oldSnapshot,
      guardChildContext: oldContext,
      nested: true,
      cwd: home.dir,
    });
    await entered;
    host.unregister();
    host.register(registration({ childGuard: () => () => {} }));
    finishHook(() => {});
    await expect(run).rejects.toMatchObject({
      name: "GuardBridgeRejection",
      reasonCode: "guard-child-injection-failed",
      entryPath: "agent-manager.spawn",
      message: "guard-child-injection-failed: guarded work is unavailable at agent-manager.spawn; the validated guard registration changed before child construction.",
    });
    expect(piMocks.createAgentSession).not.toHaveBeenCalled();
  });



  it("rejects wrong registrants, incompatible protocols, and replaced snapshots before session creation", async () => {
    const wrongHost = new GuardBridgeHost(true, "scope-guard");
    expect(wrongHost.register(registration({ registrant: { id: "other", version: "1" } })))
      .toMatchObject({ compatible: false, reasonCode: "guard-wrong-registrant" });
    await expect(runAgent(ctx, TEST_AGENT, "wrong", {
      pi,
      guardBridgeHost: wrongHost,
      guardExpected: true,
    })).rejects.toMatchObject({ reasonCode: "guard-wrong-registrant" });

    const incompatibleHost = new GuardBridgeHost(true, "scope-guard");
    expect(incompatibleHost.register(registration({ protocolVersion: 999 })))
      .toMatchObject({ compatible: false, reasonCode: "guard-incompatible-protocol" });
    await expect(runAgent(ctx, TEST_AGENT, "incompatible", {
      pi,
      guardBridgeHost: incompatibleHost,
      guardExpected: true,
    })).rejects.toMatchObject({ reasonCode: "guard-incompatible-protocol" });

    const oldRegistration = registration({ childGuard: () => () => {} });
    const replacedHost = hostWith(oldRegistration);
    const oldContext = await makeChildContext(replacedHost, "stale-child");
    const oldSnapshot = replacedHost.getResourceEnrollmentSnapshotIdentity();
    const oldFrozenRegistration = replacedHost.getValidatedRegistrationSnapshot();
    replacedHost.unregister();
    replacedHost.register(registration({ childGuard: () => () => {} }));
    await expect(runAgent(ctx, TEST_AGENT, "stale", {
      pi,
      guardBridgeHost: replacedHost,
      guardExpected: true,
      guardBridgeRegistration: oldFrozenRegistration,
      guardRegistrationSnapshot: oldSnapshot,
      guardChildContext: oldContext,
      nested: true,
      cwd: home.dir,
    })).rejects.toMatchObject({ reasonCode: "guard-child-injection-failed" });
    expect(piMocks.createAgentSession).not.toHaveBeenCalled();
  });

  it("keeps guard-off resource loaders unchanged and never invokes the optional hook", async () => {
    const mutatorPath = join(home.dir, "mutator.ts");
    writeFileSync(mutatorPath, "export default (pi) => { pi.on('tool_call', () => {}); };\n");
    registerAgents(new Map([[TEST_AGENT, { ...defaultAgentConfig, extensions: [mutatorPath] }]]));
    const hook = vi.fn(() => vi.fn());
    const reg = registration({ childGuard: hook });
    const host = new GuardBridgeHost(false, "scope-guard");
    host.register(reg);

    await runAgent(ctx, TEST_AGENT, "guard off", {
      pi,
      guardBridgeHost: host,
      guardExpected: false,
      guardBridgeRegistration: reg,
      nested: true,
      cwd: home.dir,
    });
    const pathsWithOptionalRegistration = (piMocks.createAgentSession.mock.calls[0]![0].resourceLoader as DefaultResourceLoader)
      .getExtensions().extensions.map(extension => extension.path);
    expect(pathsWithOptionalRegistration.some(path => path.includes("mutator.ts"))).toBe(true);
    expect(pathsWithOptionalRegistration).not.toContain("<inline:guard-child-injection>");
    expect(hook).not.toHaveBeenCalled();

    await runAgent(ctx, TEST_AGENT, "guard off without registration", {
      pi,
      guardBridgeHost: new GuardBridgeHost(false),
      guardExpected: false,
      nested: true,
      cwd: home.dir,
    });
    const pathsWithoutRegistration = (piMocks.createAgentSession.mock.calls[1]![0].resourceLoader as DefaultResourceLoader)
      .getExtensions().extensions.map(extension => extension.path);
    expect(pathsWithoutRegistration).toEqual(pathsWithOptionalRegistration);
    expect(hook).not.toHaveBeenCalled();
  });

  it("injects under isolated/extension-disabled mode without widening the built-in tool allowlist", async () => {
    const excludedPath = join(home.dir, "excluded.ts");
    writeFileSync(excludedPath, "export default (pi) => { pi.registerTool({ name: 'excluded-tool' }); };\n");
    registerAgents(new Map([[TEST_AGENT, {
      ...defaultAgentConfig,
      extensions: [excludedPath],
      disallowedTools: ["write"],
    }]]));
    const factory = vi.fn(() => {});
    const hook = vi.fn(() => factory);
    const host = hostWith(registration({ childGuard: hook }));
    const childContext = await makeChildContext(host, "isolated-child");
    await runAgent(ctx, TEST_AGENT, "isolated", {
      pi,
      guardBridgeHost: host,
      guardExpected: true,
      guardBridgeRegistration: host.getValidatedRegistrationSnapshot(),
      guardRegistrationSnapshot: host.getResourceEnrollmentSnapshotIdentity(),
      guardChildContext: childContext,
      isolated: true,
      nested: true,
      cwd: home.dir,
    });
    const options = piMocks.createAgentSession.mock.calls[0]![0];
    const loadedPaths = (options.resourceLoader as DefaultResourceLoader).getExtensions().extensions.map(extension => extension.path);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(options.tools).toEqual(["read"]);
    expect(options.tools).not.toContain("write");
    expect(options.tools).not.toContain("bash");
    expect(loadedPaths).toEqual(["<inline:guard-child-injection>"]);
  });

  it("runs workflow-host, nested, and worktree children through the snapshot-bound runner", async () => {
    const events: Array<{ context: GuardChildContext; handle: { childId: string; token: symbol } }> = [];
    const hook = vi.fn((context: GuardChildContext, handle: { childId: string; token: symbol }) => {
      events.push({ context, handle });
      return () => {};
    });
    const reg = registration({ childGuard: hook, onContext: () => {} });
    const manager = new AgentManager(undefined, 10);
    managers.push(manager);
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    manager.registerGuard(reg);

    const parentId = manager.spawn(pi, ctx, TEST_AGENT, "parent", {
      description: "parent",
      isBackground: true,
      guardEntryPath: "agent-tool.spawn-background",
    });
    await manager.awaitStartup(parentId);
    await manager.getRecord(parentId)!.promise;
    const parent = manager.getRecord(parentId)!;
    const nestedId = manager.spawn(pi, ctx, TEST_AGENT, "nested", {
      description: "nested",
      isBackground: true,
      parentAgentId: parentId,
      guardEntryPath: "nested-agent.spawn-background",
    });
    await manager.awaitStartup(nestedId);
    await manager.getRecord(nestedId)!.promise;
    const nestedRequest = (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(nestedRequest.parentContext).toBe(parent.guardChildContext);

    const worktreeId = manager.spawn(pi, ctx, TEST_AGENT, "worktree", {
      description: "worktree",
      isBackground: true,
      isolation: "worktree",
      guardEntryPath: "agent-tool.spawn-background",
    });
    await manager.awaitStartup(worktreeId);
    await manager.getRecord(worktreeId)!.promise;
    const worktreeRequest = (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    const factoriesBeforeResume = events.length;
    const resumed = await manager.resume(worktreeId, "resume worktree child");
    expect(resumed?.status).toBe("completed");
    expect(events).toHaveLength(factoriesBeforeResume);
    expect(runnerObservations.resumeOptions.at(-1)).toMatchObject({
      guardBridgeRegistration: hostRegistrationSnapshot(manager),
      guardRegistrationSnapshot: manager.guardBridgeHost.getResourceEnrollmentSnapshotIdentity(),
    });

    expect(worktreeRequest.worktree).toBe(true);

    const workflow = createWorkflowHost({
      pi,
      ctx,
      manager,
      workflowId: "workflow-injection-test",
      guardOrigin: "imported-context",
    });
    const result = await workflow.spawnAgent({
      agentId: "wf-agent-1",
      index: 0,
      prompt: "workflow child",
      label: "workflow child",
      agentType: TEST_AGENT,
    });
    expect(result.ok).toBe(true);
    const workflowRequest = (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(workflowRequest).toMatchObject({ entryPath: "workflow-host.spawn", origin: "imported-context", worktree: false });
    expect(events.map(event => event.context.childId)).toEqual([parentId, nestedId, worktreeId, workflowRequest.childId]);
    for (const options of runnerObservations.runOptions as Array<AgentRunnerTypes.RunOptions>) {
      expect(options.guardBridgeRegistration).toBe(hostRegistrationSnapshot(manager));
      expect(options.guardRegistrationSnapshot).toBe(manager.guardBridgeHost.getResourceEnrollmentSnapshotIdentity());
    }
    await manager.dispose();
    managers = managers.filter(value => value !== manager);
  });

  it("waits abortably for a never-resolving child hook and frees its manager slot", async () => {
    let hookCalls = 0;
    let entered!: () => void;
    const hookEntered = new Promise<void>(resolve => { entered = resolve; });
    const never = new Promise<AgentRunnerTypes.ExtensionFactory>(() => {});
    const hook = vi.fn((_context: GuardChildContext) => {
      hookCalls++;
      if (hookCalls === 1) {
        entered();
        return never;
      }
      return () => {};
    });
    const manager = new AgentManager(undefined, 1);
    managers.push(manager);
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    manager.registerGuard(registration({ childGuard: hook }));

    const first = manager.spawn(pi, ctx, TEST_AGENT, "pending hook", { description: "pending hook", isBackground: true });
    await hookEntered;
    const second = manager.spawn(pi, ctx, TEST_AGENT, "next child", { description: "next child", isBackground: true });
    expect(manager.getRecord(second)?.status).toBe("queued");
    manager.abort(first);
    await vi.waitFor(() => expect(hookCalls).toBe(2));
    await manager.awaitStartup(second);
    await manager.getRecord(second)!.promise;
    const drainedRunOptions = runnerObservations.runOptions as Array<AgentRunnerTypes.RunOptions>;
    expect(drainedRunOptions).toHaveLength(2);
    expect(drainedRunOptions[1]!.guardBridgeRegistration).toBe(manager.guardBridgeHost.getValidatedRegistrationSnapshot());
    expect(drainedRunOptions[1]!.guardRegistrationSnapshot).toBe(manager.guardBridgeHost.getResourceEnrollmentSnapshotIdentity());

    expect(manager.getRecord(first)?.status).toBe("stopped");
    expect(manager.getRecord(second)?.status).toBe("completed");
    expect(manager.getRecord(second)?.status).not.toBe("queued");
    expect(piMocks.createAgentSession).toHaveBeenCalledTimes(1);
  });
});

function hostRegistrationSnapshot(manager: AgentManager): GuardBridgeRegistration | undefined {
  return manager.guardBridgeHost.getValidatedRegistrationSnapshot();
}
