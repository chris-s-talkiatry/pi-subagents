import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUARD_ENTRY_INGRESS, GUARD_ENTRY_PATHS, GuardBridgeHost, type GuardBridgeRegistration, getGuardBridgeAdvertisement } from "../src/guard-bridge.js";

const runnerMocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  steerAgent: vi.fn(),
  runMentionClone: vi.fn(),
}));

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, ...runnerMocks };
});
vi.mock("../src/mention-clone.js", async () => {
  const actual = await vi.importActual<typeof import("../src/mention-clone.js")>("../src/mention-clone.js");
  return { ...actual, runMentionClone: runnerMocks.runMentionClone };
});

import { AgentManager } from "../src/agent-manager.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { SubagentScheduler } from "../src/schedule.js";
import { FleetList } from "../src/ui/fleet-list.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function createCapture(log: string[] = []) {
  const evidence: any[] = [];
  const registration: GuardBridgeRegistration = {
    registrant: { id: "scope-guard", version: "1" },
    protocolVersion: 1,
    callbacks: {
      captureIngress: vi.fn((value) => { log.push("capture"); evidence.push(value); }),
      enrollResource: vi.fn(),
      createChildContext: vi.fn((value: any) => ({ ...value, bridgeRef: registration })),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
    },
  };
  return { evidence, registration, log };
}

function eventBus() {
  const listeners = new Map<string, Set<(value: any) => unknown>>();
  return {
    on: vi.fn((name: string, handler: (value: any) => unknown) => {
      const group = listeners.get(name) ?? new Set();
      group.add(handler);
      listeners.set(name, group);
      return () => group.delete(handler);
    }),
    emit: vi.fn((name: string, value: any) => {
      for (const listener of listeners.get(name) ?? []) void listener(value);
    }),
  };
}

let hermetic: Hermetic | undefined;
let booted: ReturnType<typeof makePi> | undefined;
let bus: ReturnType<typeof eventBus> | undefined;
let manager: AgentManager | undefined;
let previousManager: unknown;

function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, guardExpected: true, guardRegistrant: "scope-guard", ...settings } });
  previousManager = (globalThis as any)[MANAGER_KEY];
  booted = makePi();
  bus = eventBus();
  booted.pi.events = bus;
  subagentsExtension(booted.pi);
  manager = (globalThis as any)[MANAGER_KEY] as AgentManager;
  return { ...booted, bus, manager };
}

async function registerCapture(current = booted!, capture = createCapture()) {
  await current.lifecycle.get("session_start")?.({}, ctx());
  current.pi.events.emit("subagents:guard:register", capture.registration);
  return capture;
}

function fakeSession(log?: string[]) {
  return {
    messages: [],
    sessionManager: { getSessionFile: vi.fn(() => undefined), getSessionId: vi.fn(() => "child-session") },
    model: undefined,
    thinkingLevel: undefined,
    steer: vi.fn((message: string) => { log?.push("steer"); return Promise.resolve(message); }),
    abort: vi.fn(),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getAllTools: vi.fn(() => []),
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

function seedAgent(currentManager: AgentManager, currentPi: any, status: "running" | "completed" = "running", parentAgentId?: string) {
  const session = fakeSession();
  runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, options: any) =>
    new Promise(() => options.onSessionCreated?.(session)),
  );
  const id = currentManager.spawn(currentPi, ctx(), "explore", "seed prompt", {
    description: "seed agent",
    isBackground: true,
    ...(parentAgentId !== undefined ? { parentAgentId } : {}),
  });
  const record = currentManager.getRecord(id)!;
  record.status = status;
  record.session = session;
  return { id, record, session };
}

beforeEach(() => {
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  runnerMocks.steerAgent.mockReset();
  runnerMocks.runMentionClone.mockReset();
});

afterEach(async () => {
  if (booted) await booted.lifecycle.get("session_shutdown")?.();
  if (previousManager === undefined) delete (globalThis as any)[MANAGER_KEY];
  else (globalThis as any)[MANAGER_KEY] = previousManager;
  hermetic?.restore();
  hermetic = undefined;
  booted = undefined;
  bus = undefined;
  manager = undefined;
  previousManager = undefined;
  vi.restoreAllMocks();
});

describe("guard ingress host", () => {
  it("uses the frozen registration snapshot, assigns monotonic non-text IDs, and freezes evidence", async () => {
    const capture = createCapture();
    const host = new GuardBridgeHost(true, "scope-guard");
    host.register(capture.registration);
    const first = await host.captureIngress({
      rawText: "original text",
      transformedText: "rewritten text",
      coverage: "complete",
      target: "agent:child-1",
      origin: "human",
      entryPath: "mention.input-start",
    });
    const second = await host.captureIngress({
      rawText: "original text",
      coverage: "partial",
      target: "session:s1",
      origin: "extension-request",
      entryPath: "cross-extension-rpc.spawn",
    });
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ rawText: "original text", transformedText: "rewritten text", target: "agent:child-1", origin: "human" });
    expect(second).toMatchObject({ rawText: "original text", coverage: "partial", origin: "extension-request" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(new Set([first!.ingressId, second!.ingressId]).size).toBe(2);
    expect(first!.ingressId).toMatch(/^sg-ing-[0-9a-f-]+-1$/);
    expect(second!.ingressId).toMatch(/^sg-ing-[0-9a-f-]+-2$/);
    expect(first!.ingressId).not.toContain("original text");
  });

  it("records bounded, content-free diagnostics for throwing and rejected callbacks", async () => {
    const capture = createCapture();
    capture.registration.callbacks.captureIngress = vi.fn()
      .mockImplementationOnce(() => { throw new Error("private prompt should not enter diagnostics"); })
      .mockImplementationOnce(async () => { throw new Error("private prompt should not enter diagnostics"); });
    const host = new GuardBridgeHost(true, "scope-guard");
    host.register(capture.registration);
    const evidence = {
      rawText: "private prompt",
      coverage: "complete" as const,
      target: "agent:a1",
      origin: "human" as const,
      entryPath: "mention.input-start" as const,
    };
    expect(host.captureIngress(evidence)).toMatchObject({ rawText: "private prompt" });
    await expect(host.captureIngress(evidence)).resolves.toMatchObject({ rawText: "private prompt" });
    const advertisement = getGuardBridgeAdvertisement(host);
    expect(advertisement).toMatchObject({ ingressCaptureFailureCount: 2, ingressCaptureFailures: [expect.stringContaining("mention.input-start"), expect.stringContaining("mention.input-start")] });
    expect(JSON.stringify(advertisement)).not.toContain("private prompt");
    expect(JSON.stringify(advertisement)).not.toContain("private prompt should not enter diagnostics");
  });

  it("is a synchronous no-op without registration when guardExpected is false", () => {
    const host = new GuardBridgeHost(false);
    expect(host.captureIngress({
      rawText: "upstream request",
      coverage: "complete",
      target: "session:s1",
      origin: "human",
      entryPath: "mention.input-start",
    })).toBeUndefined();
    expect(host.getIngressCaptureFailureCount()).toBe(0);
  });
});

describe("real supported ingress handlers", () => {
  it("captures a handled, transformed human mention before spawning", async () => {
    const opened = boot({ agentMentions: "direct" });
    const capture = await registerCapture(opened);
    const spawn = vi.spyOn(AgentManager.prototype, "spawn").mockImplementation((..._args: any[]) => {
      capture.log.push("spawn");
      return "spawned-agent-id";
    });

    const rawText = "@explore   keep the user's exact words  ";
    const result = await opened.lifecycle.get("input")({ type: "input", text: rawText, source: "interactive" }, ctx());
    expect(result).toEqual({ action: "handled" });
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText,
      transformedText: "keep the user's exact words",
      coverage: "complete",
      target: "session:s1",
      origin: "human",
      entryPath: "mention.input-start",
    });
    expect(capture.log).toEqual(["capture", "spawn"]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("captures clone-mode mentions before starting the model clone", async () => {
    const opened = boot({ agentMentions: "model" });
    const capture = await registerCapture(opened);
    runnerMocks.runMentionClone.mockImplementation(() => {
      capture.log.push("clone");
      return new Promise(() => {});
    });
    const rawText = "@explore ask the clone to inspect this";
    const result = await opened.lifecycle.get("input")({ type: "input", text: rawText, source: "interactive" }, ctx());
    expect(result).toEqual({ action: "handled" });
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText,
      transformedText: "ask the clone to inspect this",
      coverage: "complete",
      origin: "human",
      entryPath: "mention.input-clone",
    });
    expect(capture.log).toEqual(["capture", "clone"]);
  });

  it("captures human mention steers and resumes at their outer input boundary", async () => {
    const opened = boot({ agentMentions: "direct" });
    const capture = await registerCapture(opened);
    const live = seedAgent(opened.manager, opened.pi, "running");

    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const steer = vi.spyOn(AgentManager.prototype, "steer").mockImplementation((_id, message) => {
      capture.log.push("steer");
      live.session.steer(message);
      return true;
    });
    const rawSteer = "@explore redirect it";
    await opened.lifecycle.get("input")({ type: "input", text: rawSteer, source: "interactive" }, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);

    expect(capture.evidence.at(-1)).toMatchObject({
      rawText: rawSteer,
      transformedText: "redirect it",
      target: `agent:${live.id}`,
      origin: "human",
      entryPath: "mention.input-steer",
    });
    expect(capture.log.slice(-2)).toEqual(["capture", "steer"]);
    expect(steer).toHaveBeenCalledTimes(1);

    live.record.status = "completed";

    const resume = vi.spyOn(AgentManager.prototype, "resume").mockImplementation(async () => {
      capture.log.push("resume");
      return live.record;
    });
    const rawResume = "@explore continue from the saved session";
    await opened.lifecycle.get("input")({ type: "input", text: rawResume, source: "interactive" }, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(2);

    expect(capture.evidence.at(-1)).toMatchObject({
      rawText: rawResume,
      transformedText: "continue from the saved session",
      target: `agent:${live.id}`,
      origin: "human",
      entryPath: "mention.input-resume",
    });
    expect(capture.log.slice(-2)).toEqual(["capture", "resume"]);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("captures operator-entered agent-definition text before its generated prompt is spawned", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const spawn = vi.spyOn(AgentManager.prototype, "spawnAndWait").mockImplementation(async () => {
      capture.log.push("spawn");
      return { id: "generated-agent", record: { status: "completed" } as any };
    });
    const select = vi.fn(async (title: string, options: string[]) => {
      if (title === "Agents") return "Create new agent";
      if (title === "Choose location") return options[0];
      if (title === "Creation method") return "Generate with Claude (recommended)";
      return undefined;
    });
    const commandContext = ctx({
      ui: {
        ...ctx().ui,
        select,
        input: vi.fn(async (title: string) => title === "Describe what this agent should do" ? "audit imported data" : "data-auditor"),
        confirm: vi.fn(async () => true),
      },
    });
    await opened.commands.get("agents").handler("", commandContext);
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText: "audit imported data",
      transformedText: expect.stringContaining("Create a custom pi sub-agent definition"),
      target: "session:s1",
      coverage: "complete",
      origin: "human",
      entryPath: "agents-command.generate-definition",
    });
    expect(capture.log).toEqual(["capture", "spawn"]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("captures conversation-viewer input as human evidence before steering its child", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const seeded = seedAgent(opened.manager, opened.pi, "running");

    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const steer = vi.spyOn(AgentManager.prototype, "steer").mockImplementation((_id, message) => {
      capture.log.push("steer");
      seeded.session.steer(message);
      return true;
    });
    let viewer: any;
    let runningSelections = 0;
    let menuSelections = 0;
    const commandRun = opened.commands.get("agents").handler("", ctx({
      ui: {
        ...ctx().ui,
        select: vi.fn(async (title: string, options: string[]) => {
          if (title === "Agents") return menuSelections++ === 0 ? options.find(value => value.startsWith("Running agents (")) : undefined;
          if (title === "Running agents") return runningSelections++ === 0 ? options[0] : undefined;
          return undefined;
        }),
        custom: vi.fn((factory: (...args: any[]) => any) => new Promise(resolve => {
          viewer = factory({ requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } }, theme, undefined, () => resolve(undefined));
        })),
      },
    }));
    await flush();
    expect(viewer).toBeDefined();
    viewer.handleInput("\r");
    for (const character of "human viewer steer") viewer.handleInput(character);
    viewer.handleInput("\r");
    expect(capture.evidence.at(-1)).toMatchObject({
      rawText: "human viewer steer",
      coverage: "complete",
      target: `agent:${seeded.id}`,
      origin: "human",
      entryPath: "conversation-viewer.steer",
    });
    expect(capture.log.slice(-2)).toEqual(["capture", "steer"]);
    expect(steer).toHaveBeenCalledTimes(1);
    viewer.handleInput("q");
    await commandRun;
  });



  it("captures fleet-viewer input before its manager steer", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const seeded = seedAgent(opened.manager, opened.pi, "running");
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const host = new GuardBridgeHost(true, "scope-guard");
    host.register(capture.registration);
    const steer = vi.fn((_id: string, message: string) => {
      capture.log.push("steer");
      seeded.session.steer(message);
      return true;
    });
    const fleetManager = {
      listAgents: () => [seeded.record],
      assertGuard: (entryPath: any) => host.assertGuard(entryPath),
      captureIngress: (input: any) => host.captureIngress(input),
      steer,
      abort: vi.fn(() => true),
    };
    let inputHandler: ((data: string) => unknown) | undefined;
    let viewer: any;
    const ui = {
      setWidget: vi.fn(),
      onTerminalInput: vi.fn((handler: (data: string) => unknown) => { inputHandler = handler; return () => { inputHandler = undefined; }; }),
      getEditorText: vi.fn(() => ""),
      notify: vi.fn(),
      custom: vi.fn((factory: (...args: any[]) => any) => new Promise(resolve => {
        viewer = factory({ requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } }, theme, undefined, () => resolve(undefined));
      })),
    };
    const fleet = new FleetList(fleetManager as any, new Map());
    fleet.setUICtx(ui as any);
    fleet.update();
    inputHandler?.("\x1b[B");
    inputHandler?.("\x1b[B");
    inputHandler?.("\r");
    await flush();
    expect(viewer).toBeDefined();
    viewer.handleInput("\r");
    for (const character of "fleet human steer") viewer.handleInput(character);
    viewer.handleInput("\r");
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence.at(-1)).toMatchObject({
      rawText: "fleet human steer",
      coverage: "complete",
      target: `agent:${seeded.id}`,
      origin: "human",
      entryPath: "fleet-viewer.steer",
    });
    expect(capture.log.slice(-2)).toEqual(["capture", "steer"]);
    expect(steer).toHaveBeenCalledTimes(1);
    viewer.handleInput("q");
    fleet.dispose();
  });

  it("captures parent-model Agent-tool prompts as nonhuman delegation before spawning", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    vi.spyOn(AgentManager.prototype, "spawn").mockImplementation(() => {
      capture.log.push("spawn");
      return "model-child-id";
    });
    await opened.tools.get("Agent").execute("call-1", {
      prompt: "model-authored delegated task",
      description: "delegate task",
      subagent_type: "explore",
      run_in_background: true,
    }, undefined, undefined, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText: "model-authored delegated task",
      coverage: "complete",
      target: "session:s1",
      origin: "parent-model-delegation",
      entryPath: "agent-tool.spawn-background",
    });
    expect(capture.log).toEqual(["capture", "spawn"]);
  });

  it("captures nested model steers as delegation, not human input", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const nestedManager = new AgentManager();
    nestedManager.registerGuard(capture.registration);
    const parent = seedAgent(nestedManager, opened.pi, "running");
    const child = seedAgent(nestedManager, opened.pi, "running", parent.id);
    child.record.session.steer.mockImplementation((message: string) => {
      capture.log.push("steer");
      return Promise.resolve(message);
    });
    const tools = createNestedSubagentTools({
      manager: nestedManager,
      pi: opened.pi,
      parentAgentId: parent.id,
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: process.cwd(),
    });
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    await tools.find(tool => tool.name === "steer_subagent")!.execute("nested-steer", {
      agent_id: child.id,
      message: "parent model says approved",
    });
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence.at(-1)).toMatchObject({
      rawText: "parent model says approved",
      coverage: "complete",
      target: `agent:${child.id}`,
      origin: "parent-model-delegation",
      entryPath: "nested-agent.steer",
    });
    expect(capture.log.slice(-2)).toEqual(["capture", "steer"]);
  });

});


describe("remaining owned ingress paths", () => {
  it.each(["background", "foreground"] as const)("captures Agent-tool %s resume before manager resume", async (mode) => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const existing = seedAgent(opened.manager, opened.pi, "completed");
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const resume = vi.spyOn(AgentManager.prototype, "resume").mockImplementation(async (_id, _prompt) => {
      capture.log.push("resume");
      return existing.record;
    });
    const rawText = `parent delegates ${mode} resume`;
    await opened.tools.get("Agent").execute(`resume-${mode}`, {
      prompt: rawText, description: "resume delegated work", subagent_type: "explore", resume: existing.id,
      run_in_background: mode === "background",
    }, undefined, undefined, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText, coverage: "complete", target: `agent:${existing.id}`, origin: "parent-model-delegation",
      entryPath: mode === "background" ? "agent-tool.resume-background" : "agent-tool.resume-foreground",
    });
    expect(capture.log).toEqual(["capture", "resume"]);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("captures schedule-create as model delegation before the scheduler consumes it", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    vi.spyOn(SubagentScheduler.prototype, "addJob").mockImplementation((input: any) => {
      capture.log.push("schedule");
      return { id: "scheduled-job", name: input.name, scheduleType: "once" } as any;
    });
    vi.spyOn(SubagentScheduler.prototype, "getNextRun").mockReturnValue("later");
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const rawText = "model-authored scheduled prompt";
    await opened.tools.get("Agent").execute("schedule-create", {
      prompt: rawText, description: "scheduled work", subagent_type: "explore", schedule: "+10m",
    }, undefined, undefined, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText, coverage: "complete", target: "session:s1", origin: "parent-model-delegation",
      entryPath: "agent-tool.schedule-create",
    });
    expect(capture.log).toEqual(["capture", "schedule"]);
  });

  it("captures foreground Agent-tool spawn before spawnAndWait", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const spawn = vi.spyOn(AgentManager.prototype, "spawnAndWait").mockImplementation(async () => {
      capture.log.push("spawnAndWait");
      return { record: { id: "foreground-agent", status: "completed", result: "done" } } as any;
    });
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const rawText = "parent model foreground task";
    await opened.tools.get("Agent").execute("foreground", {
      prompt: rawText, description: "foreground delegated work", subagent_type: "explore", run_in_background: false,
    }, undefined, undefined, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText, coverage: "complete", target: "session:s1", origin: "parent-model-delegation", entryPath: "agent-tool.spawn-foreground",
    });
    expect(capture.log).toEqual(["capture", "spawnAndWait"]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("captures top-level Agent-tool steer before delivery, and does not capture a rejected steer", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const live = seedAgent(opened.manager, opened.pi, "running");
    runnerMocks.steerAgent.mockImplementation(async () => { capture.log.push("steer"); });
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const rawText = "parent model steer";
    await opened.tools.get("steer_subagent").execute("steer", { agent_id: live.id, message: rawText }, undefined, undefined, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText, coverage: "complete", target: `agent:${live.id}`, origin: "parent-model-delegation", entryPath: "agent-tool.steer",
    });
    expect(capture.log).toEqual(["capture", "steer"]);

    live.record.status = "completed";
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    await opened.tools.get("steer_subagent").execute("not-running", { agent_id: live.id, message: "not delivered" }, undefined, undefined, ctx());
    expect(capture.registration.callbacks.captureIngress).not.toHaveBeenCalled();
    expect(capture.log).toEqual([]);
  });

  it("captures a queued Agent-tool steer before placing it in pendingSteers", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const live = seedAgent(opened.manager, opened.pi, "running");
    live.record.session = undefined;
    live.record.pendingSteers = { push: vi.fn(() => capture.log.push("queue")) } as any;
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const rawText = "queue this parent steer";
    await opened.tools.get("steer_subagent").execute("queued-steer", { agent_id: live.id, message: rawText }, undefined, undefined, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText, coverage: "complete", target: `agent:${live.id}`, origin: "parent-model-delegation", entryPath: "agent-tool.steer",
    });
    expect(capture.log).toEqual(["capture", "queue"]);
    expect(live.record.pendingSteers.push).toHaveBeenCalledWith(rawText);
  });

  it.each(["background", "foreground"] as const)("captures nested %s spawn before the manager consumes it", async (mode) => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const nestedManager = new AgentManager();
    nestedManager.registerGuard(capture.registration);
    nestedManager.setGuardExpected(true);
    nestedManager.setGuardRegistrant("scope-guard");
    const parent = seedAgent(nestedManager, opened.pi, "running");
    const tools = createNestedSubagentTools({ manager: nestedManager, pi: opened.pi, parentAgentId: parent.id, depth: 1, maxSubagentDepth: 3, allowedSubagents: "all", configCwd: process.cwd() });
    const action = mode === "background"
      ? vi.spyOn(nestedManager, "spawn").mockImplementation(() => { capture.log.push("spawn"); return "nested-spawn"; })
      : vi.spyOn(nestedManager, "spawnAndWait").mockImplementation(async () => { capture.log.push("spawn"); return { record: { id: "nested-spawn", status: "completed", result: "ok" } } as any; });
    vi.spyOn(nestedManager, "awaitStartup").mockResolvedValue(undefined);
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const rawText = `nested delegated ${mode} task`;
    await tools[0].execute("nested-spawn", {
      prompt: rawText, description: "nested task", subagent_type: "explore", run_in_background: mode === "background",
    }, undefined, undefined, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText, coverage: "complete", target: "session:s1", origin: "parent-model-delegation",
      entryPath: mode === "background" ? "nested-agent.spawn-background" : "nested-agent.spawn-foreground",
    });
    expect(capture.log).toEqual(["capture", "spawn"]);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("captures nested resume before manager resume", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const nestedManager = new AgentManager();
    nestedManager.registerGuard(capture.registration);
    nestedManager.setGuardExpected(true);
    nestedManager.setGuardRegistrant("scope-guard");
    const parent = seedAgent(nestedManager, opened.pi, "running");
    const existing = seedAgent(nestedManager, opened.pi, "completed", parent.id);
    const resume = vi.spyOn(nestedManager, "resume").mockImplementation(async () => {
      capture.log.push("resume");
      return existing.record;
    });
    const tools = createNestedSubagentTools({ manager: nestedManager, pi: opened.pi, parentAgentId: parent.id, depth: 1, maxSubagentDepth: 3, allowedSubagents: "all", configCwd: process.cwd() });
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const rawText = "nested resume delegated prompt";
    await tools[0].execute("nested-resume", { prompt: rawText, resume: existing.id }, undefined, undefined, ctx());
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText, coverage: "complete", target: `agent:${existing.id}`, origin: "parent-model-delegation", entryPath: "nested-agent.resume",
    });
    expect(capture.log).toEqual(["capture", "resume"]);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("captures tombstone mention resume as human evidence before reopening the session", async () => {
    const opened = boot({ agentMentions: "direct" });
    const capture = await registerCapture(opened);
    const entry = { handle: "explore", alias: undefined, sessionFile: process.cwd(), type: "explore", description: "tombstoned agent" };
    vi.spyOn(AgentManager.prototype, "resolveMention").mockReturnValue({ kind: "tombstone", entry } as any);
    vi.spyOn(AgentManager.prototype, "spawn").mockImplementation(() => { capture.log.push("spawn"); return "reopened-agent"; });
    vi.spyOn(AgentManager.prototype, "awaitStartup").mockResolvedValue(undefined);
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const rawText = "@explore continue from the saved conversation";
    const result = await opened.lifecycle.get("input")({ type: "input", text: rawText, source: "interactive" }, ctx());
    expect(result).toEqual({ action: "handled" });
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText, transformedText: "continue from the saved conversation", coverage: "complete", target: `session:${entry.sessionFile}`,
      origin: "human", entryPath: "mention.input-resume",
    });
    expect(capture.log).toEqual(["capture", "spawn"]);
  });

  it("handles a fleet-viewer capture that settles after guard unregister without steering", async () => {
    const opened = boot();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const capture = createCapture();
    capture.registration.callbacks.captureIngress = vi.fn((evidence: any) => {
      capture.log.push("capture");
      capture.evidence.push(evidence);
      if (evidence.entryPath === "fleet-viewer.steer") return pending;
      return undefined;
    });
    await registerCapture(opened, capture);
    const seeded = seedAgent(opened.manager, opened.pi, "running");
    const host = new GuardBridgeHost(true, "scope-guard");
    host.register(capture.registration);
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const notify = vi.fn();
    const steer = vi.fn();
    let inputHandler: ((data: string) => unknown) | undefined;
    let viewer: any;
    const ui = {
      setWidget: vi.fn(),
      onTerminalInput: vi.fn((handler: (data: string) => unknown) => { inputHandler = handler; return () => { inputHandler = undefined; }; }),
      getEditorText: vi.fn(() => ""),
      notify,
      custom: vi.fn((factory: (...args: any[]) => any) => new Promise(resolve => {
        viewer = factory({ requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } }, theme, undefined, () => resolve(undefined));
      })),
    };
    const fleetManager = {
      listAgents: () => [seeded.record],
      guardBridgeHost: host,
      assertGuard: (entryPath: any) => host.assertGuard(entryPath),
      captureIngress: (input: any) => host.captureIngress(input),
      steer,
      abort: vi.fn(() => true),
    };
    const fleet = new FleetList(fleetManager as any, new Map());
    fleet.setUICtx(ui as any);
    fleet.update();
    inputHandler?.("\x1b[B");
    inputHandler?.("\x1b[B");
    inputHandler?.("\r");
    await flush();
    viewer.handleInput("\r");
    for (const character of "fleet pending steer") viewer.handleInput(character);
    viewer.handleInput("\r");
    host.unregister();
    release();
    await flush();
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText: "fleet pending steer", coverage: "complete", target: `agent:${seeded.id}`, origin: "human", entryPath: "fleet-viewer.steer",
    });
    expect(steer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("guard-missing"), "warning");
    expect(capture.log).toEqual(["capture"]);
    viewer.handleInput("q");
    fleet.dispose();
  });

  it("returns a synchronous registry ID without async capture and a promise with async capture", async () => {
    const optional = boot({ guardExpected: false });
    const spawn = vi.spyOn(AgentManager.prototype, "spawn").mockImplementation(() => "sync-registry-id");
    const syncResult = (globalThis as any)[MANAGER_KEY].spawn(optional.pi, ctx(), "explore", "optional registry prompt", { isBackground: true });
    expect(syncResult).toBe("sync-registry-id");
    await optional.lifecycle.get("session_shutdown")?.();
    hermetic?.restore();
    hermetic = undefined;

    const opened = boot();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const capture = createCapture();
    capture.registration.callbacks.captureIngress = vi.fn(async () => { await pending; });
    await registerCapture(opened, capture);
    spawn.mockClear().mockImplementation(() => "async-registry-id");
    const asyncResult = (globalThis as any)[MANAGER_KEY].spawn(opened.pi, ctx(), "explore", "async registry prompt", { isBackground: true });
    expect(asyncResult).toBeInstanceOf(Promise);
    release();
    await expect(asyncResult).resolves.toBe("async-registry-id");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("drops a deferred viewer steer if registration is removed before capture completes (guardExpected=%s)", async (guardExpected) => {
    const opened = boot({ guardExpected });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const capture = createCapture();
    capture.registration.callbacks.captureIngress = vi.fn((evidence: any) => {
      capture.log.push("capture");
      if (evidence.entryPath === "conversation-viewer.steer") return pending;
      return undefined;
    });
    await registerCapture(opened, capture);
    seedAgent(opened.manager, opened.pi, "running");
    capture.log.length = 0;
    capture.evidence.length = 0;
    (capture.registration.callbacks.captureIngress as any).mockClear();
    const steer = vi.spyOn(AgentManager.prototype, "steer").mockImplementation(() => { capture.log.push("steer"); return true; });
    let viewer: any;
    let runningSelections = 0;
    let menuSelections = 0;
    const notify = vi.fn();
    const commandRun = opened.commands.get("agents").handler("", ctx({ ui: {
      ...ctx().ui,
      notify,
      select: vi.fn(async (title: string, options: string[]) => {
        if (title === "Agents") return menuSelections++ === 0 ? options.find(value => value.startsWith("Running agents (")) : undefined;
        if (title === "Running agents") return runningSelections++ === 0 ? options[0] : undefined;
        return undefined;
      }),
      custom: vi.fn((factory: (...args: any[]) => any) => new Promise(resolve => {
        viewer = factory({ requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } }, theme, undefined, () => resolve(undefined));
      })),
    } }));
    await flush();
    expect(viewer).toBeDefined();
    viewer.handleInput("\r");
    for (const character of "pending viewer steer") viewer.handleInput(character);
    viewer.handleInput("\r");
    await opened.lifecycle.get("session_before_switch")?.();
    release();
    await flush();
    expect(steer).not.toHaveBeenCalled();
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    if (guardExpected) expect(notify).toHaveBeenCalledWith(expect.stringContaining("guard-missing"), "warning");
    else expect(notify).not.toHaveBeenCalled();
    expect(capture.log).toEqual(["capture"]);
    viewer.handleInput("q");
    await commandRun;
  });
});

describe("programmatic ingress and path inventory", () => {
  it("captures extension RPC requests once with unresolved scope before spawning", async () => {
    const capture = createCapture();
    const host = new GuardBridgeHost(true, "scope-guard");
    host.register(capture.registration);
    const events = eventBus();
    const reply = vi.fn();
    const manager = {
      assertGuard: (entryPath: any) => host.assertGuard(entryPath),
      captureIngress: (input: any) => host.captureIngress(input),
      spawn: vi.fn(() => { capture.log.push("spawn"); return "rpc-agent"; }),
      awaitStartup: vi.fn(async () => {}),
      abort: vi.fn(() => true),
      getRecord: vi.fn(),
      consumeResult: vi.fn(() => true),
    };
    registerRpcHandlers({ events, pi: {}, getCtx: () => ctx(), manager });
    events.on("subagents:rpc:spawn:reply:request-1", reply);
    events.emit("subagents:rpc:spawn", { requestId: "request-1", type: "explore", prompt: "extension request without scope", options: {} });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText: "extension request without scope",
      coverage: "partial",
      target: "session:s1",
      origin: "extension-request",
      entryPath: "cross-extension-rpc.spawn",
    });
    expect(capture.log).toEqual(["capture", "spawn"]);
  });


  it("captures manager-registry requests exactly once with unresolved scope before spawning", async () => {
    const opened = boot();
    const capture = await registerCapture(opened);
    const spawn = vi.spyOn(AgentManager.prototype, "spawn").mockImplementation(() => {
      capture.log.push("spawn");
      return "registry-agent";
    });
    const registry = (globalThis as any)[MANAGER_KEY];
    await registry.spawn(opened.pi, ctx(), "explore", "registry request without scope", { isBackground: true });
    expect(capture.registration.callbacks.captureIngress).toHaveBeenCalledTimes(1);
    expect(capture.evidence[0]).toMatchObject({
      rawText: "registry request without scope",
      coverage: "partial",
      target: "session:s1",
      origin: "extension-request",
      entryPath: "manager-registry.spawn",
    });
    expect(capture.log).toEqual(["capture", "spawn"]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps ingress capture optional for ordinary input when guardExpected is false", async () => {
    const opened = boot({ guardExpected: false, agentMentions: "direct" });
    const spawn = vi.spyOn(AgentManager.prototype, "spawn").mockImplementation(() => "unguarded-agent");
    const rawText = "@explore ordinary upstream behavior";
    const result = await opened.lifecycle.get("input")({ type: "input", text: rawText, source: "interactive" }, ctx());
    expect(result).toEqual({ action: "handled" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][3]).toBe("ordinary upstream behavior");
    expect((globalThis as any)[MANAGER_KEY]).toBeDefined();
  });

  it("classifies every guarded work path and synchronizes the documented ingress table", () => {
    expect(Object.keys(GUARD_ENTRY_INGRESS).sort()).toEqual(GUARD_ENTRY_PATHS.map(({ id }) => id).sort());
    const document = require("node:fs").readFileSync("docs/guard-bridge.md", "utf8");
    const table = document.split("### Ingress capture ownership")[1]?.split("### Resource enrollment ownership")[0]?.split("## Rejections")[0] ?? "";
    const rows = [...table.matchAll(/^\| `([^`]+)` \| ([^|]+) \| (.+) \|$/gm)];
    expect(rows.map(([, id]) => id).sort()).toEqual(GUARD_ENTRY_PATHS.map(({ id }) => id).sort());
    expect(rows).toHaveLength(GUARD_ENTRY_PATHS.length);
    for (const [, id, origin, classification] of rows) {
      const disposition = GUARD_ENTRY_INGRESS[id as keyof typeof GUARD_ENTRY_INGRESS];
      if (disposition.kind === "captures-ingress-here") expect(classification).toMatch(/^captures ingress here/);
      else if (disposition.kind === "captured-at-outer-path") expect(classification).toMatch(/^captured at outer path/);
      else expect(classification).toMatch(/^no text input \(task 5\.x\)/);
      if (id.startsWith("mention.") || id.startsWith("conversation-viewer.") || id.startsWith("fleet-viewer.") || id === "agents-command.generate-definition") {
        expect(origin).toBe("human");
      }
      if (id === "cross-extension-rpc.spawn" || id === "manager-registry.spawn") expect(origin).toBe("extension-request");
      if (id === "agent-runner.turn-limit-steer") expect(origin).toBe("package-system-control");
      if (id.startsWith("agent-tool.") && id !== "agent-tool.schedule-create") expect(origin).toBe("parent-model-delegation");
      if (id.startsWith("nested-agent.")) expect(origin).toBe("parent-model-delegation");
      if (id.startsWith("agent-manager.")) expect(origin).toBe("inherited from outer path");
    }
  });
});
