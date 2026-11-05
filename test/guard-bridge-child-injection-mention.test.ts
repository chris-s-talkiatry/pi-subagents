import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({ createAgentSession: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, createAgentSession: sessionMock.createAgentSession };
});

import { DefaultResourceLoader, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.js";
import { GUARD_CHILD_INJECTION_TIMEOUT_MS, type GuardBridgeRegistration, type GuardChildContext, type GuardChildContextRequest, getGuardChildContext, MENTION_CLONE_PARENT_CONTEXT } from "../src/guard-bridge.js";
import { inChildSessionContext } from "../src/index.js";
import { runMentionClone } from "../src/mention-clone.js";
import { hermeticDir, ctx as makeContext } from "./helpers/boot-extension.js";

let home: ReturnType<typeof hermeticDir>;
let manager: AgentManager;
let session: any;
let sessionOptions: any;
let shutdownOrder: string[];

beforeEach(() => {
  home = hermeticDir({ settings: { outputTranscript: false } });
  manager = new AgentManager();
  manager.setGuardRegistrant("scope-guard");
  manager.setGuardExpected(true);
  sessionOptions = undefined;
  shutdownOrder = [];
  session = {
    agent: { state: { messages: [], systemPrompt: "" } },
    messages: [],
    bindExtensions: vi.fn(async () => {}),
    extensionRunner: {
      hasHandlers: vi.fn((event: string) => event === "session_shutdown"),
      emit: vi.fn(async (event: { type: string }) => shutdownOrder.push(event.type)),
    },
    prompt: vi.fn(async () => {
      const tool = sessionOptions.customTools[0];
      await tool.execute("clone-call", {
        prompt: "worker prompt",
        description: "worker",
        subagent_type: "general-purpose",
      }, undefined, undefined, makeContext({ cwd: home.dir }));
    }),
    dispose: vi.fn(() => shutdownOrder.push("dispose")),
  };
  sessionMock.createAgentSession.mockReset().mockImplementation(async options => {
    sessionOptions = options;
    return { session };
  });
});

afterEach(async () => {
  await manager.dispose();
  home.restore();
});

function cloneContext() {
  return makeContext({
    cwd: home.dir,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getLeafId: vi.fn(() => undefined),
    },
    getSystemPrompt: vi.fn(() => "root system prompt"),
  }) as ExtensionContext;
}

describe("mention-clone child guard injection", () => {
  it("loads the injected factory last, marks the clone before binding, and forwards its child context to Agent", async () => {
    const initializedInChild: boolean[] = [];
    let factoryContext: GuardChildContext | undefined;
    const injectedFactory = vi.fn((pi: any) => {
      initializedInChild.push(inChildSessionContext());
      factoryContext = getGuardChildContext(pi.events);
    });
    const registration = {
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
      createChildGuardExtension: vi.fn((_context: GuardChildContext, handle: { childId: string; token: symbol }) => {
        expect(handle.childId).toBe(_context.childId);
        expect(typeof handle.token).toBe("symbol");
        return injectedFactory;
      }),
    } as any;
    manager.registerGuard(registration);
    const ingress = await manager.captureIngress({
      rawText: "@explore do the task",
      coverage: "complete",
      target: "session:root",
      origin: "human",
      entryPath: "mention.input-clone",
    });
    const context = await manager.guardBridgeHost.createChildContext({
      childId: "mention-clone-child",
      parentId: "root:root-session",
      origin: "human",
      entryPath: "mention.input-clone",
      operation: "spawn",
      ...(ingress ? { ingressId: ingress.ingressId } : {}),
      inheritContext: true,
      isolatedExtensions: false,
      worktree: false,
      scopeRefStatus: "not-applicable",
    }, ingress);
    if (!context) throw new Error("expected mention-clone child context");
    const snapshot = manager.guardBridgeHost.getResourceEnrollmentSnapshotIdentity();
    const validatedRegistration = manager.guardBridgeHost.getValidatedRegistrationSnapshot();
    const injection = await manager.createGuardChildInjection(context, "mention.input-clone", snapshot);
    if (!injection) throw new Error("expected mention-clone child factory");

    const receivedContexts: ExtensionContext[] = [];
    const agentTool = {
      name: "Agent",
      execute: vi.fn(async (...args: unknown[]) => {
        receivedContexts.push(args[4] as ExtensionContext);
        return { content: [{ type: "text", text: "started" }], details: undefined, isError: false };
      }),
    } as unknown as ToolDefinition;
    const result = await runMentionClone({
      ctx: cloneContext(),
      type: "general-purpose",
      message: "do the task",
      agentTool,
      guardExpected: true,
      guardBridgeHost: manager.guardBridgeHost,
      guardBridgeRegistration: validatedRegistration,
      guardRegistrationSnapshot: snapshot,
      guardChildContext: context,
      guardChildInjection: injection,
    });

    expect(result.spawned).toBe(true);
    expect(sessionMock.createAgentSession).toHaveBeenCalledTimes(1);
    expect(sessionOptions.tools).toEqual(["Agent"]);
    expect(sessionOptions.resourceLoader.getExtensions().extensions.at(-1)?.path).toBe("<inline:guard-child-injection>");
    expect(sessionOptions.resourceLoader.getExtensions().extensions.filter((extension: { path: string }) =>
      extension.path === "<inline:guard-child-injection>",
    )).toHaveLength(1);
    expect(session.agent.state.guardChildContext).toBe(context);
    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(initializedInChild).toEqual([true]);
    expect(factoryContext).toMatchObject({ childId: context.childId, delegationId: context.delegationId });
    expect((factoryContext!.bridgeRef as any).createChildGuardExtension).toBeUndefined();
    expect(receivedContexts).toHaveLength(1);
    expect((receivedContexts[0] as any)[MENTION_CLONE_PARENT_CONTEXT]).toBe(context);
    expect(agentTool.execute).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(shutdownOrder).toEqual(["session_shutdown", "dispose"]);
  });

  it("rejects a missing prepared injection rather than prompting an unguarded clone", async () => {
    const result = await runMentionClone({
      ctx: cloneContext(),
      type: "general-purpose",
      message: "must remain guarded",
      agentTool: { name: "Agent", execute: vi.fn() } as unknown as ToolDefinition,
      guardExpected: true,
      guardBridgeHost: manager.guardBridgeHost,
      guardBridgeRegistration: undefined,
      guardRegistrationSnapshot: undefined,
      guardChildContext: undefined,
      guardChildInjection: undefined,
    });
    expect(result).toMatchObject({ spawned: false, error: expect.stringContaining("guard-child-injection-failed") });
    expect(sessionMock.createAgentSession).not.toHaveBeenCalled();
  });

  it("bounds child factory preparation without an input abort signal", async () => {
    vi.useFakeTimers();
    try {
      let registration: GuardBridgeRegistration;
      registration = {
        protocolVersion: 1,
        registrant: { id: "scope-guard", version: "1" },
        callbacks: {
          captureIngress: vi.fn(), enrollResource: vi.fn(),
          createChildContext: vi.fn((request: GuardChildContextRequest) => ({
            rootId: "root", parentId: request.parentId, childId: request.childId,
            delegationId: request.delegationId, taskId: "task", scopeRevision: 1,
            executionEpoch: 1, resolvedRestrictions: [], origin: request.origin, bridgeRef: registration,
          })),
          revalidate: vi.fn(() => "allowed"), approvalSettled: vi.fn(), approvalCancelled: vi.fn(), approvalExpired: vi.fn(),
        },
        createChildGuardExtension: () => new Promise(() => {}),
      };
      manager.registerGuard(registration);
      const context = await manager.guardBridgeHost.createChildContext({
        childId: "idle-mention-clone", parentId: "root:session", origin: "human",
        entryPath: "mention.input-clone", operation: "spawn", inheritContext: true,
        isolatedExtensions: false, worktree: false, scopeRefStatus: "not-applicable",
      });
      if (!context) throw new Error("expected child context");
      let settled = false;
      const pending = manager.createGuardChildInjection(
        context,
        "mention.input-clone",
        manager.guardBridgeHost.getResourceEnrollmentSnapshotIdentity(),
      ).then(() => { settled = true; }, error => { settled = true; return error; });
      await vi.advanceTimersByTimeAsync(GUARD_CHILD_INJECTION_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await pending;
      expect(error).toMatchObject({ reasonCode: "guard-child-injection-failed", entryPath: "mention.input-clone" });
      expect(String(error.message)).not.toContain("private");
      expect(sessionMock.createAgentSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });


  it("fails closed when the inline factory throws during Pi resource loading", async () => {
    let registration: GuardBridgeRegistration;
    registration = {
      protocolVersion: 1,
      registrant: { id: "scope-guard", version: "1" },
      callbacks: {
        captureIngress: vi.fn(), enrollResource: vi.fn(),
        createChildContext: vi.fn((request: GuardChildContextRequest) => ({
          rootId: "root", parentId: request.parentId, childId: request.childId,
          delegationId: request.delegationId, taskId: "task", scopeRevision: 1,
          executionEpoch: 1, resolvedRestrictions: [], origin: request.origin, bridgeRef: registration,
        })),
        revalidate: vi.fn(() => "allowed"), approvalSettled: vi.fn(), approvalCancelled: vi.fn(), approvalExpired: vi.fn(),
      },
      createChildGuardExtension: () => () => { throw new Error("private clone load detail"); },
    };
    manager.registerGuard(registration);
    const context = await manager.guardBridgeHost.createChildContext({
      childId: "clone-load-failure", parentId: "root:session", origin: "human",
      entryPath: "mention.input-clone", operation: "spawn", inheritContext: true,
      isolatedExtensions: false, worktree: false, scopeRefStatus: "not-applicable",
    });
    if (!context) throw new Error("expected child context");
    const snapshot = manager.guardBridgeHost.getResourceEnrollmentSnapshotIdentity();
    const injection = await manager.createGuardChildInjection(context, "mention.input-clone", snapshot);
    if (!injection) throw new Error("expected prepared injection");
    const agentTool = { name: "Agent", execute: vi.fn() } as unknown as ToolDefinition;

    const result = await runMentionClone({
      ctx: cloneContext(),
      type: "general-purpose",
      message: "must not run unguarded",
      agentTool,
      guardExpected: true,
      guardBridgeHost: manager.guardBridgeHost,
      guardBridgeRegistration: manager.guardBridgeHost.getValidatedRegistrationSnapshot(),
      guardRegistrationSnapshot: snapshot,
      guardChildContext: context,
      guardChildInjection: injection,
    });

    expect(result).toMatchObject({
      spawned: false,
      error: "guard-child-injection-failed: guarded work is unavailable at mention.input-clone; child guard injection could not be prepared.",
    });
    expect(result.error).not.toContain("private clone load detail");
    expect(sessionMock.createAgentSession).not.toHaveBeenCalled();
    expect(agentTool.execute).not.toHaveBeenCalled();
  });


  it.each(["duplicate", "not-last"] as const)("rejects a %s inline clone guard entry", async mutation => {
    let registration: GuardBridgeRegistration;
    registration = {
      protocolVersion: 1,
      registrant: { id: "scope-guard", version: "1" },
      callbacks: {
        captureIngress: vi.fn(), enrollResource: vi.fn(),
        createChildContext: vi.fn((request: GuardChildContextRequest) => ({
          rootId: "root", parentId: request.parentId, childId: request.childId,
          delegationId: request.delegationId, taskId: "task", scopeRevision: 1,
          executionEpoch: 1, resolvedRestrictions: [], origin: request.origin, bridgeRef: registration,
        })),
        revalidate: vi.fn(() => "allowed"), approvalSettled: vi.fn(), approvalCancelled: vi.fn(), approvalExpired: vi.fn(),
      },
      createChildGuardExtension: () => () => {},
    };
    manager.registerGuard(registration);
    const context = await manager.guardBridgeHost.createChildContext({
      childId: `clone-${mutation}`, parentId: "root:session", origin: "human",
      entryPath: "mention.input-clone", operation: "spawn", inheritContext: true,
      isolatedExtensions: false, worktree: false, scopeRefStatus: "not-applicable",
    });
    if (!context) throw new Error("expected child context");
    const snapshot = manager.guardBridgeHost.getResourceEnrollmentSnapshotIdentity();
    const injection = await manager.createGuardChildInjection(context, "mention.input-clone", snapshot);
    if (!injection) throw new Error("expected prepared injection");
    const original = DefaultResourceLoader.prototype.getExtensions;
    const getExtensions = vi.spyOn(DefaultResourceLoader.prototype, "getExtensions").mockImplementation(function (this: DefaultResourceLoader) {
      const loaded = original.call(this);
      const inline = loaded.extensions.find(extension => extension.path === "<inline:guard-child-injection>");
      if (!inline) return loaded;
      const extra = mutation === "duplicate"
        ? { ...inline }
        : { ...inline, path: "<after:guard-child-injection>" };
      return { ...loaded, extensions: [...loaded.extensions, extra] };
    });
    try {
      const result = await runMentionClone({
        ctx: cloneContext(), type: "general-purpose", message: "must not run", agentTool: { name: "Agent", execute: vi.fn() } as unknown as ToolDefinition,
        guardExpected: true, guardBridgeHost: manager.guardBridgeHost,
        guardBridgeRegistration: manager.guardBridgeHost.getValidatedRegistrationSnapshot(),
        guardRegistrationSnapshot: snapshot, guardChildContext: context, guardChildInjection: injection,
      });
      expect(result).toMatchObject({ spawned: false, error: expect.stringContaining("guard-child-injection-failed") });
      expect(sessionMock.createAgentSession).not.toHaveBeenCalled();
    } finally {
      getExtensions.mockRestore();
    }
  });

});
