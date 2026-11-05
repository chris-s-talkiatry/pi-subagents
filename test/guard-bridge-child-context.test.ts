import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const cloneSessionMocks = vi.hoisted(() => ({ createAgentSession: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: cloneSessionMocks.createAgentSession };
});

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
const worktreeMocks = vi.hoisted(() => ({
  createWorktree: vi.fn(async () => ({ path: process.cwd(), workPath: process.cwd(), branch: "test-branch", baseSha: "base" })),
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
import { registerAgents } from "../src/agent-types.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";
import { GUARD_SCHEDULE_FIRE_TIMEOUT_MS, type GuardBridgeRegistration, GuardBridgeRejection, type GuardChildContext, type GuardChildContextRequest } from "../src/guard-bridge.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { ctx as extensionCtx, hermeticDir, makePi } from "./helpers/boot-extension.js";


function session() {
  return {
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "child-session" },
    agent: { state: {} },
    messages: [],
    model: undefined,
    thinkingLevel: undefined,
    prompt: vi.fn(async () => {}),
    bindExtensions: vi.fn(async () => {}),

    steer: vi.fn(async () => {}),
    abort: vi.fn(),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as any;
}

const ctx = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "root-session" },
  model: undefined,
  modelRegistry: { find: () => undefined, getAvailable: () => [] },
  getSystemPrompt: () => "root system prompt",
} as any;
const pi = {} as any;
let capturedIngresses: any[] = [];


let contextRevision = 10;
let contextRestrictions = [{ sourceIdentity: "skill:bounded", sourceVersion: "v1", textReference: "do not publish" }];



function registration(
  observe?: (request: GuardChildContextRequest, active: GuardBridgeRegistration) => GuardChildContext | Promise<GuardChildContext>,
): GuardBridgeRegistration {
  let active: GuardBridgeRegistration;
  active = {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "1" },
    callbacks: {
      captureIngress: vi.fn((evidence: any) => { capturedIngresses.push(evidence); }),
      enrollResource: vi.fn(),
      createChildContext: vi.fn((request: GuardChildContextRequest) => observe
        ? observe(request, active)
        : {
            rootId: "root-owned-id",
            parentId: request.parentId,
            childId: request.childId,
            delegationId: request.delegationId,
            taskId: "guard-owned-task",
            scopeRevision: contextRevision++,
            executionEpoch: 4,
            resolvedRestrictions: contextRestrictions,
            origin: request.origin,
            bridgeRef: active,
          }),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
      createScheduleScope: vi.fn(() => ({
        scopeId: "scope-scheduled",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        maxRuns: 3,
        targetBindings: ["target:bounded"],
      })),
    },
    createChildGuardExtension: vi.fn(() => vi.fn()),

  };
  return active;
}

function eventBus() {
  const listeners = new Map<string, Set<(value: any) => unknown>>();
  return {
    on: vi.fn((event: string, handler: (value: any) => unknown) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    }),
    emit: vi.fn((event: string, value: any) => {
      for (const handler of listeners.get(event) ?? []) void handler(value);
    }),
  };
}


function requestLog(reg: GuardBridgeRegistration): GuardChildContextRequest[] {
  return (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request);
}

function contextFor(
  request: GuardChildContextRequest,
  reg: GuardBridgeRegistration,
  extra: Partial<GuardChildContext> = {},
): GuardChildContext {
  return {
    rootId: "guard-root",
    parentId: request.parentId,
    childId: request.childId,
    delegationId: request.delegationId,
    taskId: "guard-task",
    scopeRevision: 0,
    executionEpoch: 0,
    resolvedRestrictions: [],
    origin: request.origin,
    bridgeRef: reg,
    ...extra,
  };
}

function resolveRunner(): void {
  runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
    const childSession = session();
    options.onSessionCreated?.(childSession);
    return { responseText: "done", session: childSession, aborted: false, steered: false };
  });
  runnerMocks.resumeAgent.mockImplementation(async (_session: any, _prompt: string, _options: any) => ({ text: "resumed" }));
}

let managers: AgentManager[] = [];
function manager(reg?: GuardBridgeRegistration, guardExpected = true): AgentManager {
  const value = new AgentManager();
  managers.push(value);
  value.setGuardRegistrant("scope-guard");
  value.setGuardExpected(guardExpected);
  if (reg) value.registerGuard(reg);
  return value;
}

afterEach(async () => {
  for (const value of managers) await value.dispose();
  managers = [];
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  contextRevision = 10;
  cloneSessionMocks.createAgentSession.mockReset();

  contextRestrictions = [{ sourceIdentity: "skill:bounded", sourceVersion: "v1", textReference: "do not publish" }];
  capturedIngresses = [];


});




describe("manager child-context ownership", () => {
  it("passes exact fork-known spawn facts and retains the validated context for the runner", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const ingress = await m.captureIngress({
      rawText: "delegate this exact request",
      coverage: "complete",
      target: "session:root-session",
      origin: "parent-model-delegation",
      entryPath: "agent-tool.spawn-background",
    });
    const id = m.spawn(pi, ctx, "general-purpose", "identical prompt", {
      description: "worker",
      guardEntryPath: "agent-tool.spawn-background",
      guardIngressEvidence: ingress,
      isBackground: true,
      inheritContext: true,
      isolated: true,
      isolation: "worktree",
    });
    await m.awaitStartup(id);

    const request = requestLog(reg)[0];
    expect(request).toMatchObject({
      childId: id,
      parentId: "root:root-session",
      origin: "parent-model-delegation",
      entryPath: "agent-tool.spawn-background",
      operation: "spawn",
      ingressId: ingress!.ingressId,
      inheritContext: true,
      isolatedExtensions: true,
      worktree: true,
      scopeRefStatus: "not-applicable",
    });
    expect(request.delegationId).toMatch(/^sg-del-[0-9a-f-]+-\d+$/);
    expect(request).not.toHaveProperty("scopeRef");
    const record = m.getRecord(id)!;
    const runnerOptions = runnerMocks.runAgent.mock.calls[0][3];
    expect(record.guardChildContext).toEqual(runnerOptions.guardChildContext);
    expect(runnerOptions.guardChildContext).toMatchObject({
      rootId: "root-owned-id",
      taskId: "guard-owned-task",
      childId: id,
      delegationId: request.delegationId,
      scopeRevision: 10,
      executionEpoch: 4,
      resolvedRestrictions: [{ sourceIdentity: "skill:bounded", sourceVersion: "v1", textReference: "do not publish" }],
    });
    expect(Object.isFrozen(runnerOptions.guardChildContext)).toBe(true);
    expect(Object.isFrozen(runnerOptions.guardChildContext.resolvedRestrictions)).toBe(true);
    expect(record.session.agent.state.guardChildContext).toBe(runnerOptions.guardChildContext);
  });

  it("reasserts a new context on resume with current revision and a new delegation id", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "same prompt", { description: "worker", isBackground: true });
    await m.awaitStartup(id);

    await m.getRecord(id)!.promise;
    const first = m.getRecord(id)!.guardChildContext!;
    contextRevision = 27;
    contextRestrictions = [{ sourceIdentity: "skill:parent-updated", sourceVersion: "v2", textReference: "new restriction" }];


    const evidence = await m.captureIngress({
      rawText: "resume this child",
      coverage: "complete",
      target: `agent:${id}`,
      origin: "parent-model-delegation",
      childId: id,
      delegationId: first.delegationId,
      parentId: first.parentId,
      entryPath: "agent-tool.resume-foreground",
    });
    const result = await m.resume(id, "resume prompt", undefined, {
      guardEntryPath: "agent-tool.resume-foreground",
      guardIngressEvidence: evidence,
    });
    expect(result?.status).toBe("completed");
    expect(requestLog(reg)).toHaveLength(2);
    const request = requestLog(reg)[1];
    expect(request).toMatchObject({
      childId: id,
      parentId: first.parentId,
      operation: "resume",
      entryPath: "agent-tool.resume-foreground",
      ingressId: evidence!.ingressId,
      origin: "parent-model-delegation",
    });
    expect(request.delegationId).not.toBe(first.delegationId);
    expect(m.getRecord(id)!.guardChildContext).toMatchObject({
      delegationId: request.delegationId,
      scopeRevision: 27,
      resolvedRestrictions: [{ textReference: "new restriction" }],
    });
    expect(runnerMocks.resumeAgent.mock.calls.at(-1)![2].guardChildContext).toBe(m.getRecord(id)!.guardChildContext);
  });

  it("composes a nested Agent-tool child through the parent's retained context", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const parentId = m.spawn(pi, ctx, "general-purpose", "parent", { description: "parent", isBackground: true });
    await m.awaitStartup(parentId);

    await m.getRecord(parentId)!.promise;
    const parentContext = m.getRecord(parentId)!.guardChildContext!;
    const tools = createNestedSubagentTools({
      manager: m,
      pi,
      parentAgentId: parentId,
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: process.cwd(),
    });
    const agent = tools.find(tool => tool.name === "Agent")!;
    await agent.execute("nested-call", {
      prompt: "nested identical prompt",
      description: "nested worker",
      subagent_type: "general-purpose",
      run_in_background: true,
    }, undefined, undefined, { ...ctx, cwd: process.cwd() } as any);

    const request = requestLog(reg).at(-1)!;
    expect(request).toMatchObject({
      parentId,
      parentContext,
      origin: "parent-model-delegation",
      entryPath: "nested-agent.spawn-background",
      operation: "spawn",
      inheritContext: false,
      isolatedExtensions: false,
      worktree: false,
      scopeRefStatus: "not-applicable",
    });
    expect(request.childId).not.toBe(parentId);
    expect(request.parentContext).toBe(parentContext);
    const child = m.listAgents().find(item => item.parentAgentId === parentId)!;
    await agent.execute("nested-resume", { resume: child.id, prompt: "resume nested child" }, undefined, undefined, { ...ctx, cwd: process.cwd() } as any);
    const resumeRequest = requestLog(reg).at(-1)!;
    expect(resumeRequest).toMatchObject({
      childId: child.id,
      parentId,
      parentContext,
      operation: "resume",
      entryPath: "nested-agent.resume",
      ingressId: capturedIngresses.at(-1)!.ingressId,
    });


  });

  it("creates one spawn context at spawnAndWait and forwards the captured ingress", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const ingress = await m.captureIngress({
      rawText: "foreground request",
      coverage: "complete",
      target: "session:root-session",
      origin: "parent-model-delegation",
      entryPath: "agent-tool.spawn-foreground",
    });
    const { id, record } = await m.spawnAndWait(pi, ctx, "general-purpose", "foreground prompt", {
      description: "foreground",
      guardEntryPath: "agent-tool.spawn-foreground",
      guardIngressEvidence: ingress,
      inheritContext: true,
    });
    expect(record.status).toBe("completed");
    expect(requestLog(reg)).toHaveLength(1);
    expect(requestLog(reg)[0]).toMatchObject({
      childId: id,
      parentId: "root:root-session",
      operation: "spawn",
      entryPath: "agent-tool.spawn-foreground",
      ingressId: ingress!.ingressId,
      inheritContext: true,
      isolatedExtensions: false,
      worktree: false,
      scopeRefStatus: "not-applicable",
    });
  });

  it("creates a queued spawn context only when its slot drains", async () => {
    const reg = registration();
    const m = manager(reg);
    m.setMaxConcurrent(1);

    let finishBlocker!: (result: any) => void;
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, prompt: string, options: any) => {
      const childSession = session();
      options.onSessionCreated?.(childSession);
      if (prompt === "blocker") return new Promise(resolve => { finishBlocker = resolve; });
      return Promise.resolve({ responseText: "done", session: childSession, aborted: false, steered: false });
    });
    const first = m.spawn(pi, ctx, "general-purpose", "blocker", { description: "blocker", isBackground: true });
    await m.awaitStartup(first);
    const queued = m.spawn(pi, ctx, "general-purpose", "queued", { description: "queued", isBackground: true });
    expect(m.getRecord(queued)?.status).toBe("queued");
    expect(requestLog(reg)).toHaveLength(1);

    finishBlocker({ responseText: "done", session: m.getRecord(first)?.session, aborted: false, steered: false });
    await m.getRecord(first)!.promise;
    await m.awaitStartup(queued);
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(2));
    expect(requestLog(reg)[1]).toMatchObject({ childId: queued, operation: "spawn", entryPath: "agent-manager.spawn" });
  });

  it("re-creates a queued resume context at drain with a fresh delegation id", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    m.setMaxConcurrent(1);

    const target = m.spawn(pi, ctx, "general-purpose", "target", { description: "target", isBackground: true });
    await m.awaitStartup(target);
    await m.getRecord(target)!.promise;
    const firstDelegation = m.getRecord(target)!.guardChildContext!.delegationId;

    let finishBlocker!: (result: any) => void;
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, prompt: string, options: any) => {
      const childSession = session();
      options.onSessionCreated?.(childSession);
      if (prompt === "blocker") return new Promise(resolve => { finishBlocker = resolve; });
      return Promise.resolve({ responseText: "done", session: childSession, aborted: false, steered: false });
    });
    const blocker = m.spawn(pi, ctx, "general-purpose", "blocker", { description: "blocker", isBackground: true });
    await m.awaitStartup(blocker);
    const resumed = await m.resume(target, "queued resume", undefined, {
      isBackground: true,
      guardEntryPath: "agent-tool.resume-background",
    });
    expect(resumed?.status).toBe("queued");
    expect(requestLog(reg)).toHaveLength(2);

    finishBlocker({ responseText: "done", session: m.getRecord(blocker)?.session, aborted: false, steered: false });
    await m.getRecord(blocker)!.promise;
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(3));
    const resumeRequest = requestLog(reg)[2];
    expect(resumeRequest).toMatchObject({
      childId: target,
      parentId: m.getRecord(target)!.guardChildContext!.parentId,
      operation: "resume",
      entryPath: "agent-tool.resume-background",
    });
    expect(resumeRequest.delegationId).not.toBe(firstDelegation);
    await vi.waitFor(() => expect(m.getRecord(target)?.status).toBe("completed"));
  });

  it("holds work while child-context creation is pending and rejects a replaced snapshot", async () => {
    let resolveContext!: (context: GuardChildContext) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const pending = new Promise<GuardChildContext>(resolve => { resolveContext = resolve; });
    let original!: GuardBridgeRegistration;
    original = registration(() => { began(); return pending; });
    const m = manager(original);
    const id = m.spawn(pi, ctx, "general-purpose", "held", { description: "held" });
    await started;
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    m.unregisterGuard();
    m.registerGuard(registration());
    const request = requestLog(original)[0];
    resolveContext({
      rootId: "root-owned-id", parentId: request.parentId, childId: request.childId,
      delegationId: request.delegationId, taskId: "guard-owned-task", scopeRevision: 1,
      executionEpoch: 1, resolvedRestrictions: [], origin: request.origin, bridgeRef: original,
    });
    await expect(m.awaitStartup(id)).rejects.toMatchObject({ reasonCode: "guard-missing" });
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });
  it("holds work indefinitely while the child-context callback is unresolved", async () => {
    resolveRunner();

    let release!: (context: GuardChildContext) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const pending = new Promise<GuardChildContext>(resolve => { release = resolve; });
    const reg = registration(_request => { began(); return pending; });
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "never resolve yet", { description: "held" });
    await started;
    await Promise.resolve();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    const request = requestLog(reg)[0];
    release({
      rootId: "root-owned-id", parentId: request.parentId, childId: request.childId,
      delegationId: request.delegationId, taskId: "guard-owned-task", scopeRevision: 0,
      executionEpoch: 0, resolvedRestrictions: [], origin: request.origin, bridgeRef: reg,
    });
    await m.awaitStartup(id);
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
  });



  it("uses the frozen callback snapshot after the mutable registration is changed", async () => {
    resolveRunner();
    const reg = registration();
    const frozenCallback = reg.callbacks.createChildContext;
    const replacement = vi.fn((request: GuardChildContextRequest) => ({
      rootId: "foreign-root", parentId: request.parentId, childId: request.childId,
      delegationId: request.delegationId, taskId: "foreign-task", scopeRevision: 0,
      executionEpoch: 0, resolvedRestrictions: [], origin: request.origin, bridgeRef: reg,
    }));
    const m = manager(reg);
    reg.callbacks.createChildContext = replacement;
    const id = m.spawn(pi, ctx, "general-purpose", "snapshot", { description: "snapshot" });
    await m.awaitStartup(id);
    expect(frozenCallback).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    expect(m.getRecord(id)?.guardChildContext?.rootId).toBe("root-owned-id");
  });


  it("preserves provided and absent scope references without inventing authority", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const knownRef = m.spawn(pi, ctx, "general-purpose", "extension request", {
      description: "registry request",
      guardEntryPath: "manager-registry.spawn",
      scopeRef: "root-scope-reference",
    });
    await m.awaitStartup(knownRef);
    const absentRef = m.spawn(pi, ctx, "general-purpose", "extension request", {
      description: "registry request without scope",
      guardEntryPath: "manager-registry.spawn",
    });
    await m.awaitStartup(absentRef);
    expect(requestLog(reg)[0]).toMatchObject({ scopeRef: "root-scope-reference", scopeRefStatus: "unresolved" });
    expect(requestLog(reg)[1]).toMatchObject({ scopeRefStatus: "not-applicable" });
    expect(requestLog(reg)[1]).not.toHaveProperty("scopeRef");
  });


  it("retains child identity on queued steer evidence and reasserts it at replay", async () => {
    const reg = registration();
    const m = manager(reg);
    let finishRun!: (result: any) => void;
    let runnerOptions: any;
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, options: any) => {
      runnerOptions = options;
      return new Promise(resolve => { finishRun = resolve; });
    });
    const id = m.spawn(pi, ctx, "general-purpose", "slow child", { description: "slow child", isBackground: true });
    await m.awaitStartup(id);
    const record = m.getRecord(id)!;
    const childContext = record.guardChildContext!;
    const evidence = await m.captureIngress({
      rawText: "queue child steer",
      coverage: "complete",
      target: `agent:${id}`,
      origin: "parent-model-delegation",
      childId: childContext.childId,
      delegationId: childContext.delegationId,
      parentId: childContext.parentId,
      entryPath: "agent-tool.steer",
    });
    expect(m.steer(id, "queue child steer", evidence)).toBe(true);
    expect(record.pendingSteerEvidence).toEqual([evidence]);
    const childSession = session();
    runnerOptions.onSessionCreated?.(childSession);
    finishRun({ responseText: "done", session: childSession, aborted: false, steered: false });
    await record.promise;
    expect(childSession.steer).toHaveBeenCalledWith("queue child steer");
    expect(record.pendingSteerEvidence).toBeUndefined();
    expect(capturedIngresses.at(-1)).toMatchObject({
      ingressId: evidence!.ingressId,
      childId: childContext.childId,
      delegationId: childContext.delegationId,
      parentId: childContext.parentId,
    });
  });



  it("routes RPC scope references and unresolved omissions into extension child contexts", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const bus = eventBus();
    const rpcManager = {
      spawn: (rpcPi: any, rpcCtx: any, type: string, prompt: string, options: any, entryPath?: any, evidence?: any) =>
        m.spawn(rpcPi, rpcCtx, type, prompt, {
          ...options,
          guardEntryPath: entryPath ?? "cross-extension-rpc.spawn",
          ...(evidence ? { guardIngressEvidence: evidence } : {}),
        }),
      assertGuard: (entryPath: any) => m.assertGuard(entryPath),
      captureIngress: (input: any) => m.captureIngress(input),
      awaitStartup: (id: string) => m.awaitStartup(id),
      abort: (id: string) => m.abort(id),
      getRecord: (id: string) => m.getRecord(id),
      consumeResult: () => true,
    };
    registerRpcHandlers({ events: bus, pi, getCtx: () => ctx, manager: rpcManager });
    const replies: any[] = [];
    bus.on("subagents:rpc:spawn:reply:scope-present", data => { replies.push(data); });
    bus.emit("subagents:rpc:spawn", {
      requestId: "scope-present", type: "general-purpose", prompt: "extension prompt", scopeRef: "rpc-scope-1",
    });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ success: true });
    expect(requestLog(reg)[0]).toMatchObject({
      origin: "extension-request",
      entryPath: "cross-extension-rpc.spawn",
      operation: "spawn",
      scopeRef: "rpc-scope-1",
      scopeRefStatus: "unresolved",
      ingressId: capturedIngresses.at(-1)!.ingressId,
    });

    bus.on("subagents:rpc:spawn:reply:scope-absent", data => { replies.push(data); });
    bus.emit("subagents:rpc:spawn", {
      requestId: "scope-absent", type: "general-purpose", prompt: "same text without a scope",
    });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(requestLog(reg)[1]).toMatchObject({
      origin: "extension-request",
      entryPath: "cross-extension-rpc.spawn",
      scopeRefStatus: "not-applicable",
    });
    expect(requestLog(reg)[1]).not.toHaveProperty("scopeRef");
  });

  it.each([true, false])("propagates the fork-observed headless fact (%s) in child-context requests", async headless => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    m.setHeadless(headless);
    const id = m.spawn(pi, ctx, "general-purpose", "headless fact", { description: "headless test" });
    await m.awaitStartup(id);
    expect(requestLog(reg)[0].headless).toBe(headless);
  });

  it("bounds a hanging scheduled child-context callback and records its rejection code", async () => {
    vi.useFakeTimers();
    const reg = registration(() => new Promise<GuardChildContext>(() => {}));
    const m = manager(reg);
    m.setHeadless(true);
    const directory = mkdtempSync(join(tmpdir(), "guard-child-scheduled-timeout-"));
    const store = new ScheduleStore(join(directory, "jobs.json"));
    const scheduler = new SubagentScheduler();
    const schedulerPi = { events: { emit: vi.fn() } } as any;
    try {
      scheduler.start(schedulerPi, ctx, m, store);
      const job = await scheduler.addGuardedJob({
        name: "bounded fire", description: "bounded fire", schedule: "1h",
        subagent_type: "general-purpose", prompt: "scheduled prompt",
        sourceIngressId: "created-ingress", sourceOrigin: "parent-model-delegation",
      }, {
        ingressId: "created-ingress", origin: "parent-model-delegation", parentId: "root:root-session", headless: true,
      }, request => m.guardBridgeHost.createScheduleScope(request));

      const spawned = vi.spyOn(m, "spawn");
      (scheduler as any).executeJob(job.id);
      const agentId = spawned.mock.results[0]?.value as string;
      expect(agentId).toBeTruthy();
      await Promise.resolve();
      expect(requestLog(reg)[0]).toMatchObject({
        headless: true,
        scopeRef: "scope-scheduled",
        scopeRefStatus: "provided",
        scheduled: { jobId: job.id, runIndex: 1, expiresAt: job.guardExpiresAt },
      });
      await vi.advanceTimersByTimeAsync(GUARD_SCHEDULE_FIRE_TIMEOUT_MS);
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      expect(m.getRecord(agentId)).toBeUndefined();
      expect(store.get(job.id)).toMatchObject({
        lastStatus: "error",
        guardFailureReason: "guard-child-context-failed",
      });
      expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
      vi.useRealTimers();
      await m.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains schedule-create ingress id and origin through scheduled fire", async () => {
    resolveRunner();
    const reg = registration();
    registerAgents(new Map());

    const m = manager(reg);
    const directory = mkdtempSync(join(tmpdir(), "guard-child-schedule-"));
    const store = new ScheduleStore(join(directory, "jobs.json"));
    const scheduler = new SubagentScheduler();
    const schedulerPi = { events: { emit: vi.fn() } } as any;
    try {
      scheduler.start(schedulerPi, ctx, m, store);
      const source = await m.captureIngress({
        rawText: "run this scheduled task",
        coverage: "complete",
        target: "session:root-session",
        origin: "parent-model-delegation",
        entryPath: "agent-tool.schedule-create",
      });
      const job = await scheduler.addGuardedJob({
        name: "scheduled child",
        description: "scheduled child",
        schedule: "+10m",
        subagent_type: "general-purpose",
        prompt: "scheduled task prompt",
        sourceIngressId: source!.ingressId,
        sourceOrigin: source!.origin,
      }, {
        ingressId: source!.ingressId, origin: source!.origin, parentId: "root:root-session", headless: false,
      }, request => m.guardBridgeHost.createScheduleScope(request));
      (scheduler as any).executeJob(job.id);

      await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
      expect(requestLog(reg)[0]).toMatchObject({
        origin: "parent-model-delegation",
        entryPath: "scheduled-task.fire",
        operation: "spawn",
        ingressId: source!.ingressId,
        scopeRefStatus: "provided",
        scopeRef: "scope-scheduled",
        scheduled: { jobId: job.id, runIndex: 1, expiresAt: job.guardExpiresAt },
      });
    } finally {
      scheduler.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("ignores forged schedule-file provenance and imports restored jobs", async () => {
    resolveRunner();
    const reg = registration();
    registerAgents(new Map());
    const m = manager(reg);
    const directory = mkdtempSync(join(tmpdir(), "guard-child-schedule-forged-"));
    const file = join(directory, "jobs.json");
    const scheduler = new SubagentScheduler();
    const schedulerPi = { events: { emit: vi.fn() } } as any;
    try {
      const store = new ScheduleStore(file);
      scheduler.start(schedulerPi, ctx, m, store);
      const source = await m.captureIngress({
        rawText: "schedule this task",
        coverage: "complete",
        target: "session:root-session",
        origin: "parent-model-delegation",
        entryPath: "agent-tool.schedule-create",
      });
      const job = await scheduler.addGuardedJob({
        name: "restored scheduled child",
        description: "restored scheduled child",
        schedule: "+10m",
        subagent_type: "general-purpose",
        prompt: "scheduled task prompt",
        sourceIngressId: source!.ingressId,
        sourceOrigin: source!.origin,
      }, {
        ingressId: source!.ingressId, origin: source!.origin, parentId: "root:root-session", headless: false,
      }, request => m.guardBridgeHost.createScheduleScope(request));
      const data = JSON.parse(readFileSync(file, "utf8"));
      data.jobs[0].sourceOrigin = "human";
      data.jobs[0].sourceIngressId = "forged-ingress";
      writeFileSync(file, JSON.stringify(data));

      scheduler.stop();
      const restored = new SubagentScheduler();
      restored.start(schedulerPi, ctx, m, new ScheduleStore(file));
      (restored as any).executeJob(job.id);
      await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
      expect(requestLog(reg)[0]).toMatchObject({
        origin: "imported-context",
        entryPath: "scheduled-task.fire",
        operation: "spawn",
        scopeRef: "scope-scheduled",
        scopeRefStatus: "unresolved",
        scheduled: { jobId: job.id, runIndex: 1 },
      });
      expect(requestLog(reg)[0]).not.toHaveProperty("ingressId");
      restored.stop();
    } finally {
      scheduler.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses imported-context for invalid in-memory schedule origins", async () => {
    resolveRunner();
    const reg = registration();
    registerAgents(new Map());
    const m = manager(reg);
    const directory = mkdtempSync(join(tmpdir(), "guard-child-schedule-origin-"));
    const scheduler = new SubagentScheduler();
    const schedulerPi = { events: { emit: vi.fn() } } as any;
    try {
      const store = new ScheduleStore(join(directory, "jobs.json"));
      scheduler.start(schedulerPi, ctx, m, store);
      const job = await scheduler.addGuardedJob({
        name: "invalid scheduled origin",
        description: "invalid scheduled origin",
        schedule: "+10m",
        subagent_type: "general-purpose",
        prompt: "scheduled task prompt",
        sourceIngressId: "untrusted-ingress",
        sourceOrigin: "attacker-origin" as any,
      }, {
        ingressId: "untrusted-ingress", origin: "parent-model-delegation", parentId: "root:root-session", headless: false,
      }, request => m.guardBridgeHost.createScheduleScope(request));
      (scheduler as any).executeJob(job.id);
      await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
      expect(requestLog(reg)[0]).toMatchObject({ origin: "imported-context" });
      expect(requestLog(reg)[0]).not.toHaveProperty("ingressId");
    } finally {
      scheduler.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });



  it("captures workflow-host spawn/resume and preserves workflow origin and parent context", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const parentId = m.spawn(pi, ctx, "general-purpose", "workflow parent", { description: "parent" });
    await m.awaitStartup(parentId);
    await m.getRecord(parentId)!.promise;
    const parentContext = m.getRecord(parentId)!.guardChildContext!;
    const host = createWorkflowHost({
      pi,
      ctx,
      manager: m,
      workflowId: "workflow-run-1",
      guardOrigin: "imported-context",
      guardParentContext: parentContext,
    });
    const spawnResult = await host.spawnAgent({
      agentId: "workflow-worker-1",
      index: 0,
      prompt: "workflow worker prompt",
      label: "worker",
      agentType: "general-purpose",
    } as any);
    expect(spawnResult.ok).toBe(true);
    const spawnRequest = requestLog(reg)[1];
    expect(spawnRequest).toMatchObject({
      parentId: parentContext.childId,
      parentContext,
      origin: "imported-context",
      entryPath: "workflow-host.spawn",
      operation: "spawn",
      ingressId: capturedIngresses.at(-1)!.ingressId,
    });

    const resumeResult = await host.resumeAgent("workflow-worker-1", "workflow resume prompt");
    expect(resumeResult.ok).toBe(true);
    const resumeRequest = requestLog(reg)[2];
    expect(resumeRequest).toMatchObject({
      parentId: parentContext.childId,
      parentContext,
      origin: "imported-context",
      entryPath: "workflow-host.resume",
      operation: "resume",
      ingressId: capturedIngresses.at(-1)!.ingressId,
    });
    expect(resumeRequest.delegationId).not.toBe(spawnRequest.delegationId);
  });


  it("does not add child context fields when optional registration is present but guard is off", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg, false);
    const id = m.spawn(pi, ctx, "general-purpose", "upstream prompt", { description: "unguarded" });
    await m.awaitStartup(id);
    await m.getRecord(id)!.promise;
    expect(reg.callbacks.createChildContext).not.toHaveBeenCalled();
    expect(m.getRecord(id)).not.toHaveProperty("guardChildContext");
    expect(m.getRecord(id)).not.toHaveProperty("guardChildContextOptions");
    expect(runnerMocks.runAgent.mock.calls[0][3]).not.toHaveProperty("guardChildContext");
  });


  it("keeps registered-but-not-expected behavior guard-off", async () => {
    // Docs rule: a registration is optional when guardExpected is false; it
    // must not add child contexts or alter upstream dispatch.
    resolveRunner();
    resolveRunner();
    const reg = registration();
    const m = manager(reg, false);
    const id = m.spawn(pi, ctx, "general-purpose", "upstream prompt", { description: "unguarded" });
    await m.getRecord(id)!.promise;
    expect(reg.callbacks.createChildContext).not.toHaveBeenCalled();
    expect(m.getRecord(id)).not.toHaveProperty("guardChildContext");
    expect(runnerMocks.runAgent.mock.calls[0][3]).not.toHaveProperty("guardChildContext");
  });

  it.each([
    "throw", "reject", "childId", "parentId", "delegationId", "origin", "bridgeRef",
    "scopeRevision", "scopeRevisionNaN", "scopeRevisionInfinity", "scopeRevisionFraction",
    "executionEpoch", "executionEpochNaN", "executionEpochInfinity", "executionEpochFraction",
    "rootIdEmpty", "rootIdTooLong", "taskIdEmpty", "taskIdTooLong",
    "tooManyReferences", "oversizedReference", "oversizedIdentityBytes",
  ] as const)(
    "fails closed when callback response is invalid (%s)", async kind => {
      resolveRunner();
      const reg = registration(async (request, active) => {
        const valid: GuardChildContext = {
          rootId: "root-owned-id",
          parentId: request.parentId,
          childId: request.childId,
          delegationId: request.delegationId,
          taskId: "guard-owned-task",
          scopeRevision: 1,
          executionEpoch: 1,
          resolvedRestrictions: [],
          origin: request.origin,
          bridgeRef: active,
        };
        if (kind === "throw") throw new Error("secret callback detail");
        if (kind === "reject") return Promise.reject(new Error("secret callback detail"));
        if (kind === "childId") return { ...valid, childId: "foreign-child" };
        if (kind === "parentId") return { ...valid, parentId: "foreign-parent" };
        if (kind === "delegationId") return { ...valid, delegationId: "foreign-delegation" };
        if (kind === "origin") return { ...valid, origin: "human" };
        if (kind === "rootIdEmpty") return { ...valid, rootId: "" };
        if (kind === "rootIdTooLong") return { ...valid, rootId: "r".repeat(257) };
        if (kind === "taskIdEmpty") return { ...valid, taskId: "" };
        if (kind === "taskIdTooLong") return { ...valid, taskId: "t".repeat(257) };
        if (kind.startsWith("scopeRevision")) {
          const invalid = kind === "scopeRevisionNaN" ? Number.NaN
            : kind === "scopeRevisionInfinity" ? Number.POSITIVE_INFINITY
              : kind === "scopeRevisionFraction" ? 1.5 : -1;
          return { ...valid, scopeRevision: invalid };
        }
        if (kind.startsWith("executionEpoch")) {
          const invalid = kind === "executionEpochNaN" ? Number.NaN
            : kind === "executionEpochInfinity" ? Number.POSITIVE_INFINITY
              : kind === "executionEpochFraction" ? 1.5 : -1;
          return { ...valid, executionEpoch: invalid };
        }
        if (kind === "tooManyReferences") return { ...valid, resolvedRestrictions: Array.from({ length: 129 }, () => ({ sourceIdentity: "skill", sourceVersion: "v1", textReference: "text" })) };
        if (kind === "oversizedReference") return { ...valid, resolvedRestrictions: [{ sourceIdentity: "skill", sourceVersion: "v1", textReference: "x".repeat(65_537) }] };
        if (kind === "oversizedIdentityBytes") return { ...valid, resolvedRestrictions: [{ sourceIdentity: "é".repeat(257), sourceVersion: "v1", textReference: "" }] };

        return { ...valid, bridgeRef: {} as any };
      });
      const m = manager(reg);
      const id = m.spawn(pi, ctx, "general-purpose", "must not dispatch", { description: "worker" });
      await expect(m.awaitStartup(id)).rejects.toBeInstanceOf(GuardBridgeRejection);
      expect(runnerMocks.runAgent).not.toHaveBeenCalled();
      expect(m.getRecord(id)).toBeUndefined();
    },
  );

  it("claims a background slot before pending child-context callbacks", async () => {
    const gates: Array<(value: GuardChildContext) => void> = [];
    let reg!: GuardBridgeRegistration;
    reg = registration(request => new Promise(resolve => {
      gates.push(() => resolve(contextFor(request, reg)));
    }));
    const m = manager(reg);
    m.setMaxConcurrent(1);
    let active = 0;
    let peak = 0;
    const finishers: Array<() => void> = [];
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, options: any) => {
      active++;
      peak = Math.max(peak, active);
      const childSession = session();
      options.onSessionCreated?.(childSession);
      return new Promise(resolve => finishers.push(() => {
        active--;
        resolve({ responseText: "done", session: childSession, aborted: false, steered: false });
      }));
    });

    const first = m.spawn(pi, ctx, "general-purpose", "first", { description: "first", isBackground: true });
    const second = m.spawn(pi, ctx, "general-purpose", "second", { description: "second", isBackground: true });
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
    expect(m.getRecord(first)?.status).toBe("running");
    expect(m.getRecord(second)?.status).toBe("queued");
    expect(gates).toHaveLength(1);

    gates[0](contextFor(requestLog(reg)[0], reg));
    await m.awaitStartup(first);
    await vi.waitFor(() => expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1));
    expect(requestLog(reg)).toHaveLength(1);
    finishers[0]();
    await m.getRecord(first)!.promise;

    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(2));
    gates[1](contextFor(requestLog(reg)[1], reg));
    await m.awaitStartup(second);
    await vi.waitFor(() => expect(runnerMocks.runAgent).toHaveBeenCalledTimes(2));
    finishers[1]();
    await m.getRecord(second)!.promise;
    expect(peak).toBe(1);
  });

  it("does not dispatch a spawn aborted while child-context creation is pending", async () => {
    resolveRunner();
    let release!: (value: GuardChildContext) => void;
    let reg!: GuardBridgeRegistration;
    reg = registration(request => new Promise(resolve => { release = () => resolve(contextFor(request, reg)); }));
    const m = manager(reg);
    const controller = new AbortController();
    const id = m.spawn(pi, ctx, "general-purpose", "pending", {
      description: "pending",
      isBackground: true,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
    expect(m.abort(id)).toBe(true);
    release();
    await m.awaitStartup(id);
    expect(m.getRecord(id)?.status).toBe("stopped");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it("preserves synchronous guard-off spawn and drain ordering at maxConcurrent=1", async () => {
    const m = manager(undefined, false);
    m.setMaxConcurrent(1);
    let active = 0;
    let peak = 0;
    const finishers: Array<() => void> = [];
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, options: any) => {
      active++;
      peak = Math.max(peak, active);
      const childSession = session();
      options.onSessionCreated?.(childSession);
      return new Promise(resolve => finishers.push(() => {
        active--;
        resolve({ responseText: "done", session: childSession, aborted: false, steered: false });
      }));
    });
    const first = m.spawn(pi, ctx, "general-purpose", "first", { description: "first", isBackground: true });
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
    const second = m.spawn(pi, ctx, "general-purpose", "second", { description: "second", isBackground: true });
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
    expect(m.getRecord(second)?.status).toBe("queued");

    finishers[0]();
    await m.getRecord(first)!.promise;
    await vi.waitFor(() => expect(runnerMocks.runAgent).toHaveBeenCalledTimes(2));
    finishers[1]();
    await m.getRecord(second)!.promise;
    expect(peak).toBe(1);
  });

  it("keeps guard-off background resumes synchronous and bounded by the slot", async () => {
    resolveRunner();
    const m = manager(undefined, false);
    const first = m.spawn(pi, ctx, "general-purpose", "first", { description: "first", isBackground: true });
    const second = m.spawn(pi, ctx, "general-purpose", "second", { description: "second", isBackground: true });
    await Promise.all([m.getRecord(first)!.promise, m.getRecord(second)!.promise]);
    m.setMaxConcurrent(1);

    let active = 0;
    let peak = 0;
    const finishers: Array<() => void> = [];
    runnerMocks.resumeAgent.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      return new Promise(resolve => finishers.push(() => {
        active--;
        resolve({ text: "resumed" });
      }));
    });
    const firstResume = m.resume(first, "resume first", undefined, { isBackground: true });
    expect(runnerMocks.resumeAgent).toHaveBeenCalledTimes(1);
    const secondResume = m.resume(second, "resume second", undefined, { isBackground: true });
    expect(runnerMocks.resumeAgent).toHaveBeenCalledTimes(1);
    await Promise.all([firstResume, secondResume]);

    finishers[0]();
    await m.getRecord(first)!.promise;
    await vi.waitFor(() => expect(runnerMocks.resumeAgent).toHaveBeenCalledTimes(2));
    finishers[1]();
    await m.getRecord(second)!.promise;
    expect(peak).toBe(1);
  });

  it("does not dispatch a background resume aborted during child-context creation", async () => {
    resolveRunner();
    const firstRegistration = registration();
    const m = manager(firstRegistration);
    const id = m.spawn(pi, ctx, "general-purpose", "initial", { description: "child", isBackground: true });
    await m.awaitStartup(id);
    await m.getRecord(id)!.promise;

    let release!: () => void;
    let reg!: GuardBridgeRegistration;
    reg = registration((request, active) => new Promise(resolve => {
      release = () => resolve(contextFor(request, active));
    }));
    m.unregisterGuard();
    m.registerGuard(reg);
    const controller = new AbortController();
    const resume = m.resume(id, "pending resume", controller.signal, {
      isBackground: true,
      guardEntryPath: "agent-tool.resume-background",
    });
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
    expect(m.getRecord(id)?.status).toBe("running");
    expect(m.abort(id)).toBe(true);
    release();
    await resume;
    await m.getRecord(id)!.promise;
    expect(m.getRecord(id)?.status).toBe("stopped");
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
  });

  it("uses a supplied parent context only for the spawn it accompanied", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const ephemeralParent: GuardChildContext = {
      rootId: "root",
      parentId: "root:parent-session",
      childId: "dead-mention-clone",
      delegationId: "old-delegation",
      taskId: "old-task",
      scopeRevision: 1,
      executionEpoch: 2,
      resolvedRestrictions: [],
      origin: "human",
      bridgeRef: reg,
    };
    const id = m.spawn(pi, ctx, "general-purpose", "spawn from clone", {
      description: "clone child",
      isBackground: true,
      guardParentContext: ephemeralParent,
    });
    await m.awaitStartup(id);
    await m.getRecord(id)!.promise;
    expect(requestLog(reg)[0].parentContext).toBe(ephemeralParent);
    expect(m.getRecord(id)).not.toHaveProperty("guardParentContext");

    await m.resume(id, "later root resume");
    expect(requestLog(reg)[1]).not.toHaveProperty("parentContext");
    expect(requestLog(reg)[1].parentId).toBe("root:root-session");
    expect(requestLog(reg)[1].parentId).not.toBe(ephemeralParent.childId);
  });

  it("fails closed when a nested spawn has no retained parent context", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "orphan nested child", {
      description: "orphan",
      parentAgentId: "missing-parent",
    } as any);
    await expect(m.awaitStartup(id)).rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    expect(reg.callbacks.createChildContext).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it("fails closed when a nested resume loses its live parent's retained context", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const parent = m.spawn(pi, ctx, "general-purpose", "parent", { description: "parent", isBackground: true });
    await m.awaitStartup(parent);
    await m.getRecord(parent)!.promise;
    const child = m.spawn(pi, ctx, "general-purpose", "nested child", {
      description: "nested child",
      parentAgentId: parent,
    } as any);
    await m.awaitStartup(child);
    await m.getRecord(child)!.promise;
    delete m.getRecord(parent)!.guardChildContext;

    const result = await m.resume(child, "nested resume", undefined, { guardEntryPath: "nested-agent.resume" });
    expect(result?.status).toBe("error");
    expect(result?.error).toContain("guard-child-context-failed");
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
  });

  it("rejects a guarded foreground resume without replacing an in-flight context", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "initial", { description: "child", isBackground: true });
    await m.awaitStartup(id);
    await m.getRecord(id)!.promise;
    let finish!: (result: any) => void;
    let started!: () => void;
    const resumed = new Promise<void>(resolve => { started = resolve; });
    let resumeCalls = 0;
    runnerMocks.resumeAgent.mockImplementation(async (childSession: any, _prompt: string, options: any) => {
      childSession.agent.state.guardChildContext = options.guardChildContext;
      resumeCalls++;
      if (resumeCalls === 1) {
        started();
        return new Promise(resolve => { finish = resolve; });
      }
      return { text: "unexpected overlapping turn" };
    });
    const detached = m.resume(id, "background turn", undefined, { isBackground: true });
    await resumed;
    const record = m.getRecord(id)!;
    const liveContext = record.guardChildContext;
    const liveSessionContext = record.session!.agent.state.guardChildContext;
    const requestCount = requestLog(reg).length;

    const rejected = await m.resume(id, "overlapping foreground turn");
    expect(rejected).toBeUndefined();
    expect(requestLog(reg)).toHaveLength(requestCount);
    expect(record.guardChildContext).toBe(liveContext);
    expect(record.session!.agent.state.guardChildContext).toBe(liveSessionContext);
    finish({ text: "done" });
    await detached;
    await record.promise;
  });

  it("drops immediate foreground records and completion callbacks on context failure", async () => {
    const completions: any[] = [];
    const m = new AgentManager(record => completions.push(record));
    managers.push(m);
    m.setGuardRegistrant("scope-guard");
    m.setGuardExpected(true);
    m.registerGuard(registration(() => { throw new Error("private callback failure"); }));

    await expect(m.spawnAndWait(pi, ctx, "general-purpose", "foreground failure", { description: "failure" }))
      .rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    expect(completions).toEqual([]);
    expect(m.listAgents()).toHaveLength(0);
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it("marks queued foreground context failures consumed before notifying completion", async () => {
    const completions: any[] = [];
    let contexts = 0;
    let reg!: GuardBridgeRegistration;
    reg = registration((request, active) => {
      contexts++;
      if (contexts > 1) throw new Error("second context failed");
      return contextFor(request, active);
    });
    const m = new AgentManager(record => completions.push(record));
    managers.push(m);
    m.setGuardRegistrant("scope-guard");
    m.setGuardExpected(true);
    m.registerGuard(reg);
    m.setMaxConcurrentForeground(1);

    let finishFirst!: () => void;
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, options: any) => {
      const childSession = session();
      options.onSessionCreated?.(childSession);
      return new Promise(resolve => { finishFirst = () => resolve({ responseText: "done", session: childSession, aborted: false, steered: false }); });
    });
    const first = m.spawnAndWait(pi, ctx, "general-purpose", "first", { description: "first" });
    await vi.waitFor(() => expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1));
    const second = m.spawnAndWait(pi, ctx, "general-purpose", "second", { description: "second" });
    expect(m.listAgents().find(record => record.description === "second")?.status).toBe("queued");

    finishFirst();
    await first;
    await expect(second).rejects.toThrow("guard-child-context-failed");
    const failed = completions.find(record => record.description === "second");
    expect(failed).toMatchObject({ status: "error", resultConsumed: true });
  });

  it("fails closed when the expected host returns no child context", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    vi.spyOn(m.guardBridgeHost, "createChildContext").mockResolvedValue(undefined);
    const id = m.spawn(pi, ctx, "general-purpose", "missing context", { description: "missing" });
    await expect(m.awaitStartup(id)).rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(m.getRecord(id)).toBeUndefined();
  });

  it("rejects individually bounded references whose aggregate UTF-8 bytes exceed 1 MiB", async () => {
    resolveRunner();
    let reg!: GuardBridgeRegistration;
    reg = registration(request => contextFor(request, reg, {
      resolvedRestrictions: Array.from({ length: 17 }, (_, index) => ({
        sourceIdentity: `skill:${index}`,
        sourceVersion: "v1",
        textReference: "x".repeat(65_000),
      })),
    }));
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "aggregate byte limit", { description: "aggregate" });
    await expect(m.awaitStartup(id)).rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it("rejects a restriction array with an own map that tries to bypass entry validation", async () => {
    resolveRunner();
    const sneaky: any = [{ sourceIdentity: 42, sourceVersion: "v1", textReference: "unvalidated" }];
    sneaky.map = () => [{ sourceIdentity: 42, evil: true }];
    let reg!: GuardBridgeRegistration;
    reg = registration(request => contextFor(request, reg, { resolvedRestrictions: sneaky as any }));
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "malformed map", { description: "malformed" });
    await expect(m.awaitStartup(id)).rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    expect(m.getRecord(id)?.guardChildContext).toBeUndefined();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it("captures a restriction array length once and validates indexed entries", async () => {
    resolveRunner();
    const invalid = { sourceIdentity: 42, sourceVersion: "v1", textReference: "invalid" };
    let lengthReads = 0;
    const changingLength = new Proxy([invalid], {
      get(target, property, receiver) {
        if (property === "length") return ++lengthReads === 1 ? 1 : 0;
        return Reflect.get(target, property, receiver);
      },
    });
    let reg!: GuardBridgeRegistration;
    reg = registration(request => contextFor(request, reg, { resolvedRestrictions: changingLength as any }));
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "changing length", { description: "changing length" });
    await expect(m.awaitStartup(id)).rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    expect(lengthReads).toBe(1);
    expect(m.getRecord(id)?.guardChildContext).toBeUndefined();
  });

  it("reads each guard-owned context field exactly once", async () => {
    resolveRunner();
    const reads = { rootId: 0, taskId: 0, scopeRevision: 0, executionEpoch: 0 };
    const returnedValues = { rootId: "snapshot-root", taskId: "snapshot-task", scopeRevision: 8, executionEpoch: 9 };
    let reg!: GuardBridgeRegistration;
    reg = registration(request => {
      const returned = contextFor(request, reg) as any;
      for (const key of Object.keys(reads) as (keyof typeof reads)[]) {
        Object.defineProperty(returned, key, {
          enumerable: true,
          get() {
            reads[key]++;
            return reads[key] === 1 ? returnedValues[key] : key.endsWith("Id") ? {} : Number.NaN;
          },
        });
      }
      return returned;
    });
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "getter fields", { description: "getter fields" });
    await m.awaitStartup(id);
    expect(reads).toEqual({ rootId: 1, taskId: 1, scopeRevision: 1, executionEpoch: 1 });
    expect(m.getRecord(id)?.guardChildContext).toMatchObject(returnedValues);
  });

  it("snapshots the restriction-array property once even if its getter changes", async () => {
    resolveRunner();
    let reads = 0;
    let reg!: GuardBridgeRegistration;
    reg = registration(request => {
      const returned = contextFor(request, reg) as any;
      Object.defineProperty(returned, "resolvedRestrictions", {
        enumerable: true,
        get() {
          reads++;
          return reads === 1 ? [] : [{ sourceIdentity: 42, sourceVersion: "bad", textReference: "bad" }];
        },
      });
      return returned;
    });
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "getter array", { description: "getter array" });
    await m.awaitStartup(id);
    expect(reads).toBe(1);
    expect(m.getRecord(id)?.guardChildContext?.resolvedRestrictions).toEqual([]);
  });

  it("retains a frozen deep copy after the guard mutates its returned context", async () => {
    resolveRunner();
    let returned: any;
    const reg = registration(request => {
      returned = contextFor(request, reg, {
        rootId: "original-root",
        resolvedRestrictions: [{ sourceIdentity: "skill:a", sourceVersion: "v1", textReference: "keep this" }],
      });
      return returned;
    });
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "copy", { description: "copy" });
    await m.awaitStartup(id);
    const retained = m.getRecord(id)!.guardChildContext!;
    returned.rootId = "changed-root";
    returned.resolvedRestrictions[0].textReference = "changed text";
    returned.resolvedRestrictions.push({ sourceIdentity: "evil", sourceVersion: "v2", textReference: "evil" });
    expect(retained.rootId).toBe("original-root");
    expect(retained.resolvedRestrictions).toEqual([
      { sourceIdentity: "skill:a", sourceVersion: "v1", textReference: "keep this" },
    ]);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained.resolvedRestrictions)).toBe(true);
    expect(Object.isFrozen(retained.resolvedRestrictions[0])).toBe(true);
  });

  it("reasserts the captured registration before replaying a pending steer", async () => {
    let options: any;
    let finish!: (result: any) => void;
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, received: any) => {
      options = received;
      return new Promise(resolve => { finish = resolve; });
    });
    const original = registration();
    const m = manager(original);
    const id = m.spawn(pi, ctx, "general-purpose", "steer target", { description: "steer target", isBackground: true });
    await m.awaitStartup(id);
    const childContext = m.getRecord(id)!.guardChildContext!;
    const evidence = await m.captureIngress({
      rawText: "pending steer",
      coverage: "complete",
      target: `agent:${id}`,
      origin: "parent-model-delegation",
      childId: childContext.childId,
      delegationId: childContext.delegationId,
      parentId: childContext.parentId,
      entryPath: "agent-tool.steer",
    });
    expect(m.steer(id, "pending steer", evidence)).toBe(true);
    m.unregisterGuard();
    m.registerGuard(registration());
    const childSession = session();
    let replayError: unknown;
    try {
      options.onSessionCreated?.(childSession);
    } catch (error) {
      replayError = error;
    }
    expect(replayError).toMatchObject({ reasonCode: "guard-missing" });
    expect(childSession.steer).not.toHaveBeenCalled();
    finish({ responseText: "done", session: childSession, aborted: false, steered: false });
    await m.getRecord(id)!.promise;
  });

  it("reasserts ingress evidence in steer after replacing its registration", async () => {
    resolveRunner();
    const original = registration();
    const m = manager(original);
    const id = m.spawn(pi, ctx, "general-purpose", "steer target", { description: "steer target", isBackground: true });
    await m.awaitStartup(id);
    await m.getRecord(id)!.promise;
    const childContext = m.getRecord(id)!.guardChildContext!;
    const evidence = await m.captureIngress({
      rawText: "live steer",
      coverage: "complete",
      target: `agent:${id}`,
      origin: "parent-model-delegation",
      childId: childContext.childId,
      delegationId: childContext.delegationId,
      parentId: childContext.parentId,
      entryPath: "agent-tool.steer",
    });
    m.unregisterGuard();
    m.registerGuard(registration());
    m.getRecord(id)!.status = "running";
    expect(() => m.steer(id, "must not deliver", evidence)).toThrow(GuardBridgeRejection);
    expect(m.getRecord(id)!.session!.steer).not.toHaveBeenCalled();
  });

  it("assigns distinct record and delegation identities to identical prompts", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const first = m.spawn(pi, ctx, "general-purpose", "same prompt", { description: "first" });
    const second = m.spawn(pi, ctx, "general-purpose", "same prompt", { description: "second" });
    await Promise.all([m.awaitStartup(first), m.awaitStartup(second)]);
    await Promise.all([m.getRecord(first)!.promise, m.getRecord(second)!.promise]);
    const requests = requestLog(reg);
    expect(requests).toHaveLength(2);
    expect(requests[0].childId).toBe(first);
    expect(requests[1].childId).toBe(second);
    expect(requests[0].delegationId).not.toBe(requests[1].delegationId);
    expect(m.getRecord(first)!.guardChildContext).not.toBe(m.getRecord(second)!.guardChildContext);
  });
});

  it("keeps index alignment for queued steers when ingress evidence is absent between captures", async () => {
    resolveRunner();
    capturedIngresses = [];
    const home = hermeticDir({ settings: { outputTranscript: false, guardExpected: true, guardRegistrant: "scope-guard" } });
    const managerKey = Symbol.for("pi-subagents:manager");
    const previousManager = (globalThis as any)[managerKey];
    const opened = makePi();
    const bus = eventBus();
    opened.pi.events = bus as any;
    subagentsExtension(opened.pi);
    const callCtx = extensionCtx({ cwd: home.dir });
    let finishRun!: (result: any) => void;
    runnerMocks.runAgent.mockImplementation(() => new Promise(resolve => { finishRun = resolve; }));
    const capture = AgentManager.prototype.captureIngress;
    const captureSpy = vi.spyOn(AgentManager.prototype, "captureIngress");
    let captureCount = 0;
    captureSpy.mockImplementation(function (input) {
      captureCount++;
      if (captureCount === 3) return undefined;
      return capture.call(this, input);
    });
    try {
      await opened.lifecycle.get("session_start")?.({}, callCtx);
      const reg = registration();
      bus.emit("subagents:guard:register", reg);
      const registry = (globalThis as any)[managerKey];
      const agentTool = opened.tools.get("Agent")!;
      const spawned = await agentTool.execute("queued-steer-spawn", {
        prompt: "worker with delayed session",
        description: "queued steer target",
        subagent_type: "general-purpose",
        run_in_background: true,
      }, undefined, undefined, callCtx);
      const id = (spawned.details as any).agentId as string;
      const steerTool = opened.tools.get("steer_subagent")!;
      await steerTool.execute("steer-evidence-one", { agent_id: id, message: "evidence one" }, undefined, undefined, callCtx);
      await steerTool.execute("steer-no-evidence", { agent_id: id, message: "no evidence" }, undefined, undefined, callCtx);
      await steerTool.execute("steer-evidence-two", { agent_id: id, message: "evidence two" }, undefined, undefined, callCtx);

      const record = registry.getRecord(id)!;
      expect(record.pendingSteers).toEqual(["evidence one", "no evidence", "evidence two"]);
      expect(record.pendingSteerEvidence).toEqual([capturedIngresses[1], undefined, capturedIngresses[2]]);
      finishRun({ responseText: "done", session: session(), aborted: false, steered: false });
      await registry.waitForAll();
    } finally {
      captureSpy.mockRestore();
      await opened.lifecycle.get("session_shutdown")?.();
      if (previousManager === undefined) delete (globalThis as any)[managerKey];
      else (globalThis as any)[managerKey] = previousManager;
      home.restore();
    }
  });

  it("rejects a guarded registry spawn promise when context creation fails", async () => {
    resolveRunner();
    const home = hermeticDir({ settings: { outputTranscript: false, guardExpected: true, guardRegistrant: "scope-guard" } });
    const managerKey = Symbol.for("pi-subagents:manager");
    const previousManager = (globalThis as any)[managerKey];
    const opened = makePi();
    const bus = eventBus();
    opened.pi.events = bus as any;
    subagentsExtension(opened.pi);
    const callCtx = extensionCtx({ cwd: home.dir });
    try {
      await opened.lifecycle.get("session_start")?.({}, callCtx);
      const reg = registration(() => { throw new Error("private callback detail"); });
      bus.emit("subagents:guard:register", reg);
      const registry = (globalThis as any)[managerKey];
      const id = registry.spawn(opened.pi, callCtx, "general-purpose", "registry startup failure", {});
      expect(typeof id).toBe("string");
      await registry.waitForAll();
      expect(requestLog(reg)).toHaveLength(1);
      expect(registry.getRecord(id)).toMatchObject({
        status: "error",
        error: expect.stringContaining("guard-child-context-failed"),
      });
    } finally {
      await opened.lifecycle.get("session_shutdown")?.();
      if (previousManager === undefined) delete (globalThis as any)[managerKey];
      else (globalThis as any)[managerKey] = previousManager;
      home.restore();
    }
  });



describe("mention clone child-context lineage", () => {
  it("creates one human ephemeral context, reuses its mention ingress, and forwards it as the spawned child's parent", async () => {
    resolveRunner();
    capturedIngresses = [];
    const home = hermeticDir({ settings: { outputTranscript: false, guardExpected: true, guardRegistrant: "scope-guard", agentMentions: "model" } });
    const managerKey = Symbol.for("pi-subagents:manager");
    const previousManager = (globalThis as any)[managerKey];
    const opened = makePi();
    const bus = eventBus();
    opened.pi.events = bus as any;
    subagentsExtension(opened.pi);
    const callCtx = extensionCtx({ cwd: home.dir, mode: "tui" });
    callCtx.sessionManager.getEntries = () => [];
    callCtx.sessionManager.getLeafId = () => undefined;

    const cloneSession = {
      agent: { state: { messages: [] as any[], systemPrompt: "" } },
      messages: [],
      bindExtensions: vi.fn(async () => {}),

      prompt: vi.fn(async () => {
        const tool = cloneSessionMocks.createAgentSession.mock.calls[0][0].customTools[0];
        const params = { prompt: "clone-authored worker prompt", description: "clone worker", subagent_type: "general-purpose", run_in_background: true };
        await tool.execute("clone-call", params, undefined, undefined, callCtx);
        await tool.execute("clone-call-again", params, undefined, undefined, callCtx);
      }),
      dispose: vi.fn(),
    } as any;
    cloneSessionMocks.createAgentSession.mockImplementation(async () => ({ session: cloneSession }));
    try {
      await opened.lifecycle.get("session_start")?.({}, callCtx);
      const reg = registration();
      bus.emit("subagents:guard:register", reg);
      const inputText = "@explore delegate from the mention";
      const result = await opened.lifecycle.get("input")({ type: "input", text: inputText, source: "interactive" }, callCtx);
      expect(result).toEqual({ action: "handled" });
      await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(2));
      expect(cloneSessionMocks.createAgentSession).toHaveBeenCalledTimes(1);
      expect(cloneSession.dispose).toHaveBeenCalledTimes(1);
      const mentionEvidence = capturedIngresses.find(value => value.entryPath === "mention.input-clone")!;
      expect(capturedIngresses.filter(value => value.entryPath === "mention.input-clone")).toHaveLength(1);
      const ephemeralRequest = requestLog(reg)[0];
      expect(ephemeralRequest).toMatchObject({
        parentId: "root:s1",
        origin: "human",
        entryPath: "mention.input-clone",
        operation: "spawn",
        ingressId: mentionEvidence.ingressId,
        inheritContext: true,
        isolatedExtensions: false,
        worktree: false,
        scopeRefStatus: "not-applicable",
      });
      expect(ephemeralRequest.childId).toMatch(/^[0-9a-f-]+$/);
      const ephemeralContext = (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mock.results[0].value;
      const childRequest = requestLog(reg)[1];
      expect(childRequest).toMatchObject({
        parentId: ephemeralRequest.childId,
        parentContext: ephemeralContext,
        origin: "parent-model-delegation",
        entryPath: "agent-tool.spawn-background",
        operation: "spawn",
      });
    } finally {
      await opened.lifecycle.get("session_shutdown")?.();
      if (previousManager === undefined) delete (globalThis as any)[managerKey];
      else (globalThis as any)[managerKey] = previousManager;
      home.restore();
    }
  });


  it("routes manager-registry scope references with extension-request provenance", async () => {
    resolveRunner();
    capturedIngresses = [];
    const home = hermeticDir({ settings: { outputTranscript: false, guardExpected: true, guardRegistrant: "scope-guard" } });
    const managerKey = Symbol.for("pi-subagents:manager");
    const previousManager = (globalThis as any)[managerKey];
    const opened = makePi();
    const bus = eventBus();
    opened.pi.events = bus as any;
    subagentsExtension(opened.pi);
    const callCtx = extensionCtx({ cwd: home.dir });
    try {
      await opened.lifecycle.get("session_start")?.({}, callCtx);
      const reg = registration();
      bus.emit("subagents:guard:register", reg);
      const registry = (globalThis as any)[managerKey];
      const withScope = await registry.spawn(opened.pi, callCtx, "general-purpose", "registry prompt", { scopeRef: "registry-scope-1" });
      await registry.waitForAll();
      const supplied = requestLog(reg)[0];
      expect(supplied).toMatchObject({
        childId: withScope,
        origin: "extension-request",
        entryPath: "manager-registry.spawn",
        operation: "spawn",
        scopeRef: "registry-scope-1",
        scopeRefStatus: "unresolved",
        ingressId: capturedIngresses.at(-1)!.ingressId,
      });
      const withoutScope = await registry.spawn(opened.pi, callCtx, "general-purpose", "same registry prompt", {});
      await registry.waitForAll();
      expect(requestLog(reg)[1]).toMatchObject({
        childId: withoutScope,
        origin: "extension-request",
        entryPath: "manager-registry.spawn",
        scopeRefStatus: "not-applicable",
      });
      expect(requestLog(reg)[1]).not.toHaveProperty("scopeRef");
    } finally {
      await opened.lifecycle.get("session_shutdown")?.();
      if (previousManager === undefined) delete (globalThis as any)[managerKey];
      else (globalThis as any)[managerKey] = previousManager;
      home.restore();
    }
  });


});



describe("manager-registry scheduled capability hardening", () => {
  it("strips forged scheduled-fire authority from manager-registry spawn options", async () => {
    resolveRunner();
    capturedIngresses = [];
    const home = hermeticDir({ settings: { outputTranscript: false, guardExpected: true, guardRegistrant: "scope-guard" } });
    const managerKey = Symbol.for("pi-subagents:manager");
    const previousManager = (globalThis as any)[managerKey];
    const opened = makePi();
    const bus = eventBus();
    opened.pi.events = bus as any;
    subagentsExtension(opened.pi);
    const callCtx = extensionCtx({ cwd: home.dir });
    try {
      await opened.lifecycle.get("session_start")?.({}, callCtx);
      const reg = registration();
      bus.emit("subagents:guard:register", reg);
      const registry = (globalThis as any)[managerKey];
      const id = await registry.spawn(opened.pi, callCtx, "general-purpose", "caller chosen prompt", {
        guardEntryPath: "scheduled-task.fire",
        guardOrigin: "human",
        guardIngressId: "forged-ingress",
        guardScopeRefStatus: "provided",
        scopeRef: "  forged-scope  ",
        scheduled: { jobId: "live-job", runIndex: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });
      await registry.waitForAll();
      expect(requestLog(reg)[0]).toMatchObject({
        childId: id,
        origin: "extension-request",
        entryPath: "manager-registry.spawn",
        scopeRef: "forged-scope",
        scopeRefStatus: "unresolved",
        ingressId: capturedIngresses.at(-1)!.ingressId,
      });
      expect(requestLog(reg)[0]).not.toHaveProperty("scheduled");
      expect(requestLog(reg)[0].ingressId).not.toBe("forged-ingress");

      const replies: any[] = [];
      bus.on("subagents:rpc:spawn:reply:rpc-forged", reply => { replies.push(reply); });
      bus.emit("subagents:rpc:spawn", {
        requestId: "rpc-forged",
        type: "general-purpose",
        prompt: "RPC caller chosen prompt",
        options: {
          guardEntryPath: "scheduled-task.fire",
          guardOrigin: "human",
          guardIngressId: "rpc-forged-ingress",
          guardScopeRefStatus: "provided",
          scopeRef: "  rpc-forged-scope  ",
          scheduled: { jobId: "another-live-job", runIndex: 2, expiresAt: new Date(Date.now() + 60_000).toISOString() },
        },
      });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]).toMatchObject({ success: true });
      await registry.waitForAll();
      expect(requestLog(reg)[1]).toMatchObject({
        origin: "extension-request",
        entryPath: "cross-extension-rpc.spawn",
        scopeRef: "rpc-forged-scope",
        scopeRefStatus: "unresolved",
        ingressId: capturedIngresses.at(-1)!.ingressId,
      });
      expect(requestLog(reg)[1]).not.toHaveProperty("scheduled");
      expect(requestLog(reg)[1].ingressId).not.toBe("rpc-forged-ingress");
    } finally {
      await opened.lifecycle.get("session_shutdown")?.();
      if (previousManager === undefined) delete (globalThis as any)[managerKey];
      else (globalThis as any)[managerKey] = previousManager;
      home.restore();
    }
  });
});

describe("real top-level Agent-tool child-context paths", () => {
  it("carries exact ingress and operation fields through background/foreground spawn and resume", async () => {
    resolveRunner();
    const home = hermeticDir({ settings: { outputTranscript: false, guardExpected: true, guardRegistrant: "scope-guard" } });
    const managerKey = Symbol.for("pi-subagents:manager");
    const previousManager = (globalThis as any)[managerKey];
    const opened = makePi();
    const bus = eventBus();
    opened.pi.events = bus as any;

    subagentsExtension(opened.pi);
    const callCtx = extensionCtx({ cwd: home.dir });
    try {
      await opened.lifecycle.get("session_start")?.({}, callCtx);
      const reg = registration();
      bus.emit("subagents:guard:register", reg);
      const manager = (globalThis as any)[managerKey] as AgentManager;
      const tool = opened.tools.get("Agent")!;
      const makeParams = (description: string, background: boolean, resume?: string) => ({
        prompt: `${description} prompt`,
        description,
        subagent_type: "general-purpose",
        run_in_background: background,
        ...(resume ? { resume } : {}),
      });
      const assertRequest = (index: number, record: any, entryPath: string, operation: "spawn" | "resume") => {
        const request = requestLog(reg)[index];
        expect(request).toMatchObject({
          childId: record.id,
          parentId: "root:s1",
          origin: "parent-model-delegation",
          entryPath,
          operation,
          ingressId: capturedIngresses.at(-1)!.ingressId,
          inheritContext: false,
          isolatedExtensions: false,
          worktree: false,
          scopeRefStatus: "not-applicable",
        });
        expect(request.delegationId).toMatch(/^sg-del-[0-9a-f-]+-\d+$/);
        return request;
      };

      const backgroundResult = await tool.execute("agent-background", makeParams("background spawn", true), undefined, undefined, callCtx);
      const backgroundId = (backgroundResult.details as any).agentId as string;
      await manager.waitForAll();
      const background = manager.getRecord(backgroundId)!;
      assertRequest(0, background, "agent-tool.spawn-background", "spawn");


      const foregroundResult = await tool.execute("agent-foreground", makeParams("foreground spawn", false), undefined, undefined, callCtx);
      const foreground = manager.getRecord((foregroundResult.details as any).agentId)!;
      assertRequest(1, foreground, "agent-tool.spawn-foreground", "spawn");

      await tool.execute("resume-background", makeParams("background resume", true, background.id), undefined, undefined, callCtx);
      await manager.waitForAll();
      await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(3));
      const backgroundResume = assertRequest(2, background, "agent-tool.resume-background", "resume");
      await background.promise;

      await tool.execute("resume-foreground", makeParams("foreground resume", false, foreground.id), undefined, undefined, callCtx);

      const foregroundResume = assertRequest(3, foreground, "agent-tool.resume-foreground", "resume");
      expect(backgroundResume.delegationId).not.toBe(requestLog(reg)[0].delegationId);
      expect(foregroundResume.delegationId).not.toBe(requestLog(reg)[1].delegationId);
    } finally {
      await opened.lifecycle.get("session_shutdown")?.();
      if (previousManager === undefined) delete (globalThis as any)[managerKey];
      else (globalThis as any)[managerKey] = previousManager;
      home.restore();
    }
  });
  it("preserves human origin and existing child identity across mention start, resume, and steer", async () => {
    resolveRunner();
    capturedIngresses = [];
    const home = hermeticDir({ settings: { outputTranscript: false, guardExpected: true, guardRegistrant: "scope-guard", agentMentions: "direct" } });
    const managerKey = Symbol.for("pi-subagents:manager");
    const previousManager = (globalThis as any)[managerKey];
    const opened = makePi();
    const bus = eventBus();
    opened.pi.events = bus as any;
    subagentsExtension(opened.pi);
    const callCtx = extensionCtx({ cwd: home.dir, mode: "tui" });
    try {
      await opened.lifecycle.get("session_start")?.({}, callCtx);
      const reg = registration();
      bus.emit("subagents:guard:register", reg);
      const registry = (globalThis as any)[managerKey];

      await opened.lifecycle.get("input")({ type: "input", text: "@general-purpose initial human start", source: "interactive" }, callCtx);
      await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
      const startRequest = requestLog(reg)[0];
      expect(startRequest).toMatchObject({
        origin: "human",
        entryPath: "mention.input-start",
        operation: "spawn",
        ingressId: capturedIngresses[0].ingressId,
        scopeRefStatus: "not-applicable",
      });
      const record = registry.getRecord(startRequest.childId)!;
      await record.promise;

      await opened.lifecycle.get("input")({ type: "input", text: "@general-purpose resume as human", source: "interactive" }, callCtx);
      await registry.waitForAll();
      await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(2));
      const resumeRequest = requestLog(reg)[1];
      expect(resumeRequest).toMatchObject({
        childId: record.id,
        parentId: startRequest.parentId,
        origin: "human",
        entryPath: "mention.input-resume",
        operation: "resume",
        ingressId: capturedIngresses.at(-1)!.ingressId,
      });
      expect(resumeRequest.delegationId).not.toBe(startRequest.delegationId);

      record.status = "running";
      await opened.lifecycle.get("input")({ type: "input", text: "@general-purpose human steer", source: "interactive" }, callCtx);
      const steerEvidence = capturedIngresses.at(-1)!;
      expect(steerEvidence).toMatchObject({
        origin: "human",
        entryPath: "mention.input-steer",
        childId: record.guardChildContext!.childId,
        delegationId: record.guardChildContext!.delegationId,
        parentId: record.guardChildContext!.parentId,
      });
      expect(requestLog(reg)).toHaveLength(2);
    } finally {
      await opened.lifecycle.get("session_shutdown")?.();
      if (previousManager === undefined) delete (globalThis as any)[managerKey];
      else (globalThis as any)[managerKey] = previousManager;
      home.restore();
    }
  });


});



describe("guarded child-context cancellation and resume reservation", () => {
  it("releases a spawn slot and drains queued work when context creation is aborted", async () => {
    resolveRunner();
    let calls = 0;
    let reg!: GuardBridgeRegistration;
    reg = registration((request, active) => {
      calls++;
      return calls === 1 ? new Promise<GuardChildContext>(() => {}) : contextFor(request, active);
    });
    const m = manager(reg);
    m.setMaxConcurrent(1);
    const first = m.spawn(pi, ctx, "general-purpose", "pending context", { description: "pending", isBackground: true });
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
    expect(m.abort(first)).toBe(true);

    const second = m.spawn(pi, ctx, "general-purpose", "next child", { description: "next", isBackground: true });
    await vi.waitFor(() => expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1));
    expect(m.getRecord(first)?.status).toBe("stopped");
    expect(m.getRecord(second)?.status).not.toBe("queued");
  });

  it("settles spawnAndWait when its signal aborts a pending child context", async () => {
    const reg = registration(() => new Promise<GuardChildContext>(() => {}));
    const m = manager(reg);
    const controller = new AbortController();
    const pending = m.spawnAndWait(pi, ctx, "general-purpose", "foreground", {
      description: "foreground",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
    controller.abort();

    const result = await Promise.race([
      pending.then(({ record }) => record.status, () => "rejected"),
      new Promise<string>(resolve => setTimeout(() => resolve("pending"), 100)),
    ]);
    expect(result).toBe("stopped");
  });

  it("ignores a late context rejection after abort and leaves the record stopped", async () => {
    let rejectContext!: (error: Error) => void;
    const reg = registration(() => new Promise<GuardChildContext>((_resolve, reject) => { rejectContext = reject; }));
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "pending", { description: "pending", isBackground: true });
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));
    expect(m.abort(id)).toBe(true);
    await m.awaitStartup(id);
    rejectContext(new Error("late private callback failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(m.getRecord(id)?.status).toBe("stopped");
    expect(m.getRecord(id)?.error).toBeUndefined();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });
  it("keeps the record stopped when context rejection is unwinding as abort lands", async () => {
    const reg = registration(() => Promise.reject(new Error("private callback failure")));
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "rejecting context", {
      description: "rejecting context",
      isBackground: true,
    });
    // The callback rejection reaches the abort race first; the manager's await
    // continuation is queued behind this test continuation, so stop lands before
    // the startup catch decides whether to publish the callback failure.
    await Promise.resolve();
    expect(m.abort(id)).toBe(true);
    await m.awaitStartup(id);
    expect(m.getRecord(id)?.status).toBe("stopped");
    expect(m.getRecord(id)?.error).toBeUndefined();
  });



  it("rejects overlapping foreground and background resumes while context creation is pending", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "initial", { description: "child", isBackground: true });
    await m.awaitStartup(id);
    await m.getRecord(id)!.promise;

    let release!: (context: GuardChildContext) => void;
    (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mockImplementation((_request: GuardChildContextRequest) =>
      new Promise<GuardChildContext>(resolve => { release = context => resolve(context); }),
    );
    const first = m.resume(id, "first foreground resume");
    const second = m.resume(id, "overlapping foreground resume");
    const third = m.resume(id, "overlapping background resume", undefined, { isBackground: true });
    expect(await second).toBeUndefined();
    expect(await third).toBeUndefined();
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(2));
    expect(m.getRecord(id)?.status).toBe("running");
    release(contextFor(requestLog(reg)[1], reg));
    expect((await first)?.status).toBe("completed");
    expect(runnerMocks.resumeAgent).toHaveBeenCalledTimes(1);
    expect(requestLog(reg)).toHaveLength(2);
  });

  it("lets abort() stop a foreground resume awaiting its context callback", async () => {
    resolveRunner();
    const reg = registration();
    const m = manager(reg);
    const id = m.spawn(pi, ctx, "general-purpose", "initial", { description: "child", isBackground: true });
    await m.awaitStartup(id);
    await m.getRecord(id)!.promise;

    let release!: (context: GuardChildContext) => void;
    (reg.callbacks.createChildContext as ReturnType<typeof vi.fn>).mockImplementation((_request: GuardChildContextRequest) =>
      new Promise<GuardChildContext>(resolve => { release = context => resolve(context); }),
    );
    const pending = m.resume(id, "foreground resume");
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(2));
    expect(m.getRecord(id)?.status).toBe("running");
    expect(m.abort(id)).toBe(true);
    release(contextFor(requestLog(reg)[1], reg));
    expect((await pending)?.status).toBe("stopped");
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
  });

  it("frees a spawn slot after child-context failure", async () => {
    resolveRunner();
    let calls = 0;
    let reg!: GuardBridgeRegistration;
    reg = registration((request, active) => {
      if (++calls === 1) throw new Error("first context fails");
      return contextFor(request, active);
    });
    const m = manager(reg);
    m.setMaxConcurrent(1);
    const failed = m.spawn(pi, ctx, "general-purpose", "fails", { description: "fails", isBackground: true });
    await expect(m.awaitStartup(failed)).rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    const next = m.spawn(pi, ctx, "general-purpose", "next", { description: "next", isBackground: true });
    await vi.waitFor(() => expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1));
    expect(m.getRecord(next)?.status).not.toBe("queued");
  });

  it("frees a background-resume slot after child-context failure", async () => {
    resolveRunner();
    let calls = 0;
    let reg!: GuardBridgeRegistration;
    reg = registration((request, active) => {
      if (++calls === 2) throw new Error("resume context fails");
      return contextFor(request, active);
    });
    const m = manager(reg);
    m.setMaxConcurrent(1);
    const target = m.spawn(pi, ctx, "general-purpose", "initial", { description: "target", isBackground: true });
    await m.awaitStartup(target);
    await m.getRecord(target)!.promise;

    const resume = await m.resume(target, "failed resume", undefined, { isBackground: true });
    await m.getRecord(target)!.promise;
    expect(resume?.status).toBe("error");
    const next = m.spawn(pi, ctx, "general-purpose", "next", { description: "next", isBackground: true });
    await vi.waitFor(() => expect(runnerMocks.runAgent).toHaveBeenCalledTimes(2));
    expect(m.getRecord(next)?.status).not.toBe("queued");
  });

  it("fails closed when the parent context belongs to a replaced registration", async () => {
    resolveRunner();
    const oldRegistration = registration();
    const m = manager(oldRegistration);
    const parent = m.spawn(pi, ctx, "general-purpose", "parent", { description: "parent", isBackground: true });
    await m.awaitStartup(parent);
    await m.getRecord(parent)!.promise;

    m.unregisterGuard();
    const activeRegistration = registration();
    m.registerGuard(activeRegistration);
    const child = m.spawn(pi, ctx, "general-purpose", "nested child", {
      description: "nested child",
      parentAgentId: parent,
    } as any);
    await expect(m.awaitStartup(child)).rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    expect(activeRegistration.callbacks.createChildContext).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a mention-clone parent context belongs to a replaced registration", async () => {
    resolveRunner();
    const oldRegistration = registration();
    const m = manager(oldRegistration);
    const ephemeralParent = contextFor({
      childId: "mention-clone",
      parentId: "root:root-session",
      delegationId: "mention-delegation",
      origin: "human",
    } as GuardChildContextRequest, oldRegistration);

    m.unregisterGuard();
    const activeRegistration = registration();
    m.registerGuard(activeRegistration);
    const child = m.spawn(pi, ctx, "general-purpose", "mention child", {
      description: "mention child",
      guardParentContext: ephemeralParent,
      isBackground: true,
    });
    await expect(m.awaitStartup(child)).rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    expect(activeRegistration.callbacks.createChildContext).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });
  it("drops every immediate background spawn whose child-context creation fails", async () => {
    const completions: any[] = [];
    const m = new AgentManager(record => completions.push(record));
    managers.push(m);
    m.setGuardRegistrant("scope-guard");
    m.setGuardExpected(true);
    m.registerGuard(registration(() => { throw new Error("private context failure"); }));

    const id = m.spawn(pi, ctx, "general-purpose", "background failure", {
      description: "background failure",
      isBackground: true,
    });
    await expect(m.awaitStartup(id)).rejects.toMatchObject({ reasonCode: "guard-child-context-failed" });
    expect(m.listAgents()).toHaveLength(0);
    expect(completions).toEqual([]);
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });


  const abortingRoutes = ["spawn", "background resume", "foreground resume"] as const;
  const abortingOutcomes = ["rejects", "resolves invalid context"] as const;

  async function pendingContextAttempt(route: typeof abortingRoutes[number]) {
    const completions: any[] = [];
    const m = new AgentManager(record => completions.push(record));
    managers.push(m);
    m.setGuardRegistrant("scope-guard");
    m.setGuardExpected(true);

    let resolveContext!: (context: GuardChildContext) => void;
    let rejectContext!: (error: Error) => void;
    const pendingRegistration = () => registration(() => new Promise<GuardChildContext>((resolve, reject) => {
      resolveContext = resolve;
      rejectContext = reject;
    }));

    let id: string;
    let reg: GuardBridgeRegistration;
    if (route === "spawn") {
      reg = pendingRegistration();
      m.registerGuard(reg);
      id = m.spawn(pi, ctx, "general-purpose", "pending child context", {
        description: "pending child context",
        isBackground: true,
      });
    } else {
      resolveRunner();
      m.registerGuard(registration());
      id = m.spawn(pi, ctx, "general-purpose", "initial child", {
        description: "initial child",
        isBackground: true,
      });
      await m.awaitStartup(id);
      await m.getRecord(id)!.promise;
      completions.length = 0;
      m.unregisterGuard();
      reg = pendingRegistration();
      m.registerGuard(reg);
    }

    let operation: Promise<unknown>;
    if (route === "spawn") {
      operation = m.awaitStartup(id);
    } else if (route === "background resume") {
      await m.resume(id, "pending background resume", undefined, { isBackground: true });
      operation = m.getRecord(id)!.promise!;
    } else {
      operation = m.resume(id, "pending foreground resume");
    }
    await vi.waitFor(() => expect(requestLog(reg)).toHaveLength(1));

    return { m, id, reg, completions, operation, resolveContext, rejectContext };
  }

  const contextAbortCases = abortingRoutes.flatMap(route => abortingOutcomes.map(outcome => ({ route, outcome })));

  it.each(contextAbortCases)("keeps $route stopped when it aborts before the callback $outcome", async ({ route, outcome }) => {
    const { m, id, completions, operation, resolveContext, rejectContext } = await pendingContextAttempt(route);
    expect(m.abort(id)).toBe(true);

    if (outcome === "rejects") rejectContext(new Error("late private callback failure"));
    else resolveContext({} as GuardChildContext);

    await operation.catch(() => undefined);
    await m.getRecord(id)?.promise?.catch(() => undefined);
    await Promise.resolve();
    const record = m.getRecord(id);
    expect(record?.status).toBe("stopped");
    expect(record?.error).toBeUndefined();
    expect(completions.filter(completed => completed.id === id).every(completed => completed.status === "stopped")).toBe(true);
    expect(completions.filter(completed => completed.id === id).length).toBeLessThanOrEqual(1);
    if (route === "spawn") expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    else expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
  });

  it.each(contextAbortCases)("does not publish $route as failed when callback $outcome is unwinding as abort lands", async ({ route, outcome }) => {
    const { m, id, completions, operation, resolveContext, rejectContext } = await pendingContextAttempt(route);
    if (outcome === "rejects") rejectContext(new Error("private callback failure"));
    else resolveContext({} as GuardChildContext);

    // Let the callback rejection / context validation rejection enter the abort
    // race, then stop the record before startAgent/startResume handles it.
    for (let i = 0; i < (route === "spawn" ? 2 : 3); i++) await Promise.resolve();
    expect(m.getRecord(id)?.status).toBe("running");
    expect(m.abort(id)).toBe(true);

    await operation.catch(() => undefined);
    await m.getRecord(id)?.promise?.catch(() => undefined);
    const record = m.getRecord(id);
    expect(record?.status).toBe("stopped");
    expect(record?.error).toBeUndefined();
    const notifications = completions.filter(completed => completed.id === id);
    expect(notifications.every(completed => completed.status === "stopped")).toBe(true);
    expect(notifications.length).toBeLessThanOrEqual(1);
    if (route === "spawn") expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    else expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
  });

});
