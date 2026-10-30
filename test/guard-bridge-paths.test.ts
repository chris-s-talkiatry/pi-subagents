import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoSpies = vi.hoisted(() => ({ createHash: vi.fn(), digest: vi.fn() }));
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    createHash: cryptoSpies.createHash,
    webcrypto: { ...actual.webcrypto, subtle: { ...actual.webcrypto.subtle, digest: cryptoSpies.digest } },
  };
});

const managerMocks = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock("../src/agent-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-manager.js")>("../src/agent-manager.js");
  class CapturedAgentManager extends actual.AgentManager {
    constructor(...args: ConstructorParameters<typeof actual.AgentManager>) {
      super(...args);
      managerMocks.instances.push(this);
    }
  }
  return { ...actual, AgentManager: CapturedAgentManager };
});

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
import { GuardBridgeHost, type GuardBridgeRegistration, GuardBridgeRejection, getGuardBridgeAdvertisement } from "../src/guard-bridge.js";
import subagentsExtension from "../src/index.js";
import { runMentionClone } from "../src/mention-clone.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

const managerKey = Symbol.for("pi-subagents:manager");
const registration: GuardBridgeRegistration = {
  registrant: { id: "scope-guard", version: "1" },
  protocolVersion: 1,
  callbacks: {
    captureIngress: vi.fn(),
    enrollResource: vi.fn(),
    createChildContext: vi.fn((value: any) => ({ ...value, bridgeRef: registration })),
    revalidate: vi.fn(() => "allowed"),
    approvalSettled: vi.fn(),
    approvalCancelled: vi.fn(),
    approvalExpired: vi.fn(),
  },
};

function eventBus() {
  const listeners = new Map<string, Set<(value: unknown) => unknown>>();
  return {
    on: vi.fn((event: string, handler: (value: unknown) => unknown) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    }),
    emit: vi.fn((event: string, value: unknown) => {
      for (const listener of listeners.get(event) ?? []) void listener(value);
    }),
  };
}

let hermetic: ReturnType<typeof hermeticDir> | undefined;
let booted: ReturnType<typeof makePi> | undefined;
let bus: ReturnType<typeof eventBus> | undefined;
let previousManager: unknown;
let flags: Record<string, boolean | string> = {};
function bootExtension(settings: Record<string, unknown> = {}, projectSettings?: unknown) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, guardExpected: true, guardRegistrant: "scope-guard", ...settings } });
  if (projectSettings !== undefined) {
    mkdirSync(join(hermetic.dir, ".pi"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "subagents.json"), JSON.stringify(projectSettings));
  }
  previousManager = (globalThis as any)[managerKey];
  booted = makePi(flags);
  bus = eventBus();
  booted.pi.events = bus;
  subagentsExtension(booted.pi);
  return { ...booted, bus, manager: managerMocks.instances.at(-1) };
}

async function shutdown() {
  if (booted) await booted.lifecycle.get("session_shutdown")?.();
  if (booted) {
    if (previousManager === undefined) delete (globalThis as any)[managerKey];
    else (globalThis as any)[managerKey] = previousManager;
  }
  hermetic?.restore();
  hermetic = undefined;
  booted = undefined;
  bus = undefined;
  previousManager = undefined;
  flags = {};
}

beforeEach(() => {
  cryptoSpies.createHash.mockClear();
  cryptoSpies.digest.mockClear();
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  runnerMocks.steerAgent.mockReset();
  runnerMocks.runMentionClone.mockReset();
  managerMocks.instances.length = 0;
  runnerMocks.runAgent.mockImplementation(() => new Promise(() => {}));
});
afterEach(async () => {
  expect(cryptoSpies.createHash).not.toHaveBeenCalled();
  expect(cryptoSpies.digest).not.toHaveBeenCalled();
  await shutdown();
});

describe("guard registration at real entry paths", () => {
  it("rejects manager spawn, spawn-and-wait, resume, and steer before side effects", async () => {
    const manager = new AgentManager();
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    const expected = [
      ["agent-manager.spawn", () => manager.spawn({} as any, {} as any, "general-purpose", "raw prompt", { description: "test" })],
      ["agent-manager.spawn-and-wait", () => manager.spawnAndWait({} as any, {} as any, "general-purpose", "raw prompt", { description: "test" })],
      ["agent-manager.resume", () => manager.resume("absent", "raw prompt")],
      ["agent-manager.steer", () => manager.steer("absent", "raw prompt")],
    ] as const;
    try {
      for (const [entryPath, invoke] of expected) {
        let caught: unknown;
        try {
          await invoke();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(GuardBridgeRejection);
        expect(caught).toMatchObject({ name: "GuardBridgeRejection", reasonCode: "guard-missing", entryPath });
      }
      expect(runnerMocks.runAgent).not.toHaveBeenCalled();
      expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
      expect(manager.listAgents()).toEqual([]);
    } finally {
      manager.dispose();
    }
  });


  it("rejects a wrong registrant at manager, Agent tool, and mention entry paths", async () => {
    const wrongRegistration = { ...registration, registrant: { id: "other-extension", version: "1" } };
    const manager = new AgentManager();
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    expect(manager.registerGuard(wrongRegistration)).toMatchObject({ compatible: false, reasonCode: "guard-wrong-registrant" });
    expect(() => manager.assertGuard("agent-manager.spawn")).toThrowError(
      expect.objectContaining({ reasonCode: "guard-wrong-registrant" }),
    );
    manager.dispose();

    const opened = bootExtension({ agentMentions: "direct" });
    await opened.lifecycle.get("session_start")({}, ctx());
    opened.bus.emit("subagents:guard:register", wrongRegistration);
    await expect(opened.tools.get("Agent").execute(
      "wrong-registrant-tool",
      { prompt: "raw request", description: "wrong registrant", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    )).rejects.toMatchObject({ reasonCode: "guard-wrong-registrant", entryPath: "agent-tool.spawn-background" });
    const original = { type: "input", text: "@explore raw request", source: "interactive" };
    expect(await opened.lifecycle.get("input")(original, ctx({ mode: "tui" }))).toEqual({ action: "continue" });
    expect(original.text).toBe("@explore raw request");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(opened.manager.listAgents()).toEqual([]);
  });

  it("accepts the expected registrant after rejecting a wrong id and runs guarded work once", () => {
    const manager = new AgentManager();
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    try {
      expect(manager.registerGuard({ ...registration, registrant: { id: "other-extension", version: "1" } }))
        .toMatchObject({ compatible: false, reasonCode: "guard-wrong-registrant" });
      expect(manager.guardBridgeHost.getRegistration()).toBeUndefined();
      expect(manager.registerGuard(registration)).toEqual({ compatible: true });
      const id = manager.spawn({}, {} as any, "general-purpose", "guarded request", { isBackground: true });
      expect(manager.getRecord(id)).toBeDefined();
      expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });


  it("allows manager spawn with compatible registration and with guardExpected defaulted off", () => {
    const pi = {} as any;
    const manager = new AgentManager();
    try {
      manager.setGuardRegistrant("scope-guard");
      manager.setGuardExpected(true);
      manager.registerGuard(registration);
      const id = manager.spawn(pi, {} as any, "general-purpose", "raw prompt", { description: "compatible", isBackground: true });
      expect(manager.getRecord(id)).toBeDefined();
      expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }

    const defaultManager = new AgentManager();
    try {
      const id = defaultManager.spawn(pi, {} as any, "general-purpose", "raw prompt", { description: "default", isBackground: true });
      expect(defaultManager.getRecord(id)).toBeDefined();
      expect(runnerMocks.runAgent).toHaveBeenCalledTimes(2);
    } finally {
      defaultManager.dispose();
    }
  });

  it("rejects the real Agent tool before manager spawn and leaves no record", async () => {
    const { tools, manager } = bootExtension();
    const execute = tools.get("Agent").execute;
    await expect(execute(
      "guard-missing-tool",
      { prompt: "raw request", description: "test", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    )).rejects.toMatchObject({
      name: "GuardBridgeRejection",
      reasonCode: "guard-missing",
      entryPath: "agent-tool.spawn-background",
    });
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(manager.listAgents()).toEqual([]);
  });


  it("rejects a real foreground Agent tool before creating a record", async () => {
    const { tools, manager: registry } = bootExtension();
    await expect(tools.get("Agent").execute(
      "guard-missing-foreground",
      { prompt: "raw request", description: "test", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    )).rejects.toMatchObject({ reasonCode: "guard-missing", entryPath: "agent-tool.spawn-foreground" });
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(registry.listAgents()).toEqual([]);
  });

  it("returns an RPC error envelope for an unregistered real cross-extension spawn", async () => {
    const events = eventBus();
    const bridge = new GuardBridgeHost(true, "scope-guard");
    const spawn = vi.fn(() => "must-not-spawn");
    registerRpcHandlers({
      events,
      pi: {},
      getCtx: () => ({}),
      manager: {
        spawn,
        captureIngress: vi.fn(),

        assertGuard: (entryPath) => bridge.assertGuard(entryPath),
        awaitStartup: vi.fn(),
        abort: vi.fn(),
        getRecord: vi.fn(),
        consumeResult: vi.fn(),
      },
    });
    const reply = vi.fn();
    events.on("subagents:rpc:spawn:reply:r-guard", reply);
    events.emit("subagents:rpc:spawn", { requestId: "r-guard", type: "general-purpose", prompt: "raw RPC prompt" });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({
      success: false,
      error: "guard-missing: guarded work is unavailable at cross-extension-rpc.spawn; no guard bridge registration is present.",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("blocks a real workflow pi.exec gate through the real manager before invoking pi.exec", async () => {
    const manager = new AgentManager();
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    const pi = { exec: vi.fn() } as any;
    const workflowHost = createWorkflowHost({ pi, ctx: ctx(), manager });

    try {
      await expect(workflowHost.runGate("echo should-not-run", { cwd: process.cwd() })).rejects.toMatchObject({
        name: "GuardBridgeRejection",
        reasonCode: "guard-missing",
        entryPath: "workflow.pi-exec.gate",
      });
      expect(pi.exec).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("rejects a real workflow tool dispatch before creating a workflow task", async () => {
    const { tools } = bootExtension({ workflowsEnabled: true });
    const workflow = [...tools.values()].find((tool: any) => tool.label === "SubagentWorkflow");
    expect(workflow).toBeDefined();
    await expect(workflow.execute("workflow-missing", {}, undefined, undefined, ctx())).rejects.toMatchObject({
      reasonCode: "guard-missing",
      entryPath: "workflow-tool.dispatch",
    });
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it("rejects the real workflow CLI flag at session startup before file dispatch", async () => {
    flags = { "subagents-workflow-file": "should-not-be-read.js" };
    const { lifecycle } = bootExtension({ workflowsEnabled: true });
    const extensionContext = ctx();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await lifecycle.get("session_start")({}, extensionContext);
    expect(warning).toHaveBeenCalledWith("[pi-subagents] guard-missing: guarded work is unavailable at workflow-cli-flag.dispatch; no guard bridge registration is present.");
    warning.mockRestore();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it("rejects workflow-host spawn at its actual manager spawn-and-wait boundary", async () => {
    const manager = new AgentManager();
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    const workflowHost = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager });
    try {
      await expect(workflowHost.spawnAgent({
        agentId: "wf-agent-1",
        index: 0,
        prompt: "workflow raw prompt",
        label: "worker",
        agentType: "general-purpose",
      } as any)).resolves.toMatchObject({
        ok: false,
        error: "guard-missing: guarded work is unavailable at workflow-host.spawn; no guard bridge registration is present.",
      });
      expect(runnerMocks.runAgent).not.toHaveBeenCalled();
      expect(manager.listAgents()).toEqual([]);
    } finally {
      manager.dispose();
    }
  });



  it("rejects a scheduled fire through the real scheduler before manager spawn", () => {
    const directory = mkdtempSync(join(tmpdir(), "guard-schedule-"));
    const store = new ScheduleStore(join(directory, "jobs.json"));
    const scheduler = new SubagentScheduler();
    const manager = new AgentManager();
    const pi = { events: { emit: vi.fn() } } as any;
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    try {
      scheduler.start(pi, ctx(), manager, store);
      const job = scheduler.addJob({ name: "guarded task", description: "guarded task", schedule: "+10m", subagent_type: "general-purpose", prompt: "scheduled raw prompt" });
      (scheduler as any).executeJob(job.id);
      expect(store.get(job.id)?.lastStatus).toBe("error");
      expect(manager.listAgents()).toEqual([]);
      expect(runnerMocks.runAgent).not.toHaveBeenCalled();
      expect(pi.events.emit).toHaveBeenLastCalledWith("subagents:scheduled", {
        type: "error",
        jobId: job.id,
        error: "guard-missing: guarded work is unavailable at scheduled-task.fire; no guard bridge registration is present.",
      });
    } finally {

      scheduler.stop();
      manager.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not launch a mention clone when clone registration is missing", async () => {
    const { lifecycle } = bootExtension({ agentMentions: "model" });
    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore raw request", source: "interactive" },
      ctx({ mode: "tui" }),
    );
    expect(result).toEqual({ action: "continue" });
    expect(runMentionClone).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });


  it("returns the original mention to the main input flow when its required guard is missing", async () => {
    const { lifecycle, manager } = bootExtension({ agentMentions: "direct" });
    await lifecycle.get("session_start")({}, ctx());
    const input = lifecycle.get("input");
    const original = { type: "input", text: "@explore raw request", source: "interactive" };
    const result = await input(original, ctx({ mode: "tui" }));
    expect(result).toEqual({ action: "continue" });
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(manager.listAgents()).toEqual([]);
  });
  it("returns unchanged human input for an incompatible mention registration", async () => {
    const { lifecycle, bus } = bootExtension({ agentMentions: "direct" });
    await lifecycle.get("session_start")({}, ctx());
    bus.emit("subagents:guard:register", { ...registration, protocolVersion: 999 });
    const original = { type: "input", text: "@explore identical original text", source: "interactive" };
    const result = await lifecycle.get("input")(original, ctx({ mode: "tui" }));
    expect(result).toEqual({ action: "continue" });
    expect(original.text).toBe("@explore identical original text");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(runMentionClone).not.toHaveBeenCalled();
  });

  it("starts a mention through the real handler after compatible registration", async () => {
    const { lifecycle, bus } = bootExtension({ agentMentions: "direct" });
    await lifecycle.get("session_start")({}, ctx());
    bus.emit("subagents:guard:register", registration);
    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore guarded start", source: "interactive" },
      ctx({ mode: "tui" }),
    );
    expect(result).toEqual({ action: "handled" });
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
  });



  it("retains the event registration and exposes current plus historical diagnostics over ready and RPC", async () => {
    const { lifecycle, bus } = bootExtension();
    const beforeNames = Object.getOwnPropertyNames(globalThis);
    const beforeSymbols = Object.getOwnPropertySymbols(globalThis);
    await lifecycle.get("session_start")({}, ctx());
    bus.emit("subagents:guard:register", { ...registration, protocolVersion: 999 });
    bus.emit("subagents:guard:register", registration);
    const manager = (globalThis as any)[managerKey];
    expect(manager).toBeDefined();
    const originalVersion = registration.protocolVersion;
    registration.protocolVersion = 999;
    const mutatedId = manager.spawn({}, ctx(), "general-purpose", "same text", { isBackground: true });
    expect(manager.getRecord(mutatedId)).toBeDefined();
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
    registration.protocolVersion = originalVersion;
    bus.emit("subagents:guard:register", registration);
    const id = manager.spawn({}, ctx(), "general-purpose", "same text", { isBackground: true });
    expect(manager.getRecord(id)).toBeDefined();
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(2);
    expect(Object.getOwnPropertyNames(globalThis)).toEqual(beforeNames);
    expect(Object.getOwnPropertySymbols(globalThis)).toEqual(beforeSymbols);

    const readyCalls = bus.emit.mock.calls.filter(([event]) => event === "subagents:ready");
    expect(readyCalls).toHaveLength(2);
    const readyAdvertisement = (readyCalls.at(-1)![1] as any).guardBridge;
    expect(readyAdvertisement).toMatchObject({
      protocol: "pi-subagents.guard-bridge",
      protocolVersion: 1,
      outcomes: ["allowed", "approval-needed", "stopped", "denied", "dismissed", "cancelled", "unavailable", "ui-error"],
      registrationRejected: expect.stringContaining("received 999"),
    });
    const reply = vi.fn();
    bus.on("subagents:rpc:guard-bridge:reply:read-only", reply);
    bus.emit("subagents:rpc:guard-bridge", { requestId: "read-only" });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    const rpcAdvertisement = reply.mock.calls[0][0].data;
    expect(rpcAdvertisement).not.toHaveProperty("registrationRejected");
    expect(rpcAdvertisement.registrationRejectionHistory).toEqual(expect.arrayContaining([expect.stringContaining("received 999")]));
  });


  it("unregisters the bridge on session switch so a reloaded guard can register", async () => {
    const opened = bootExtension();
    const validRegistration = { ...registration, protocolVersion: 1 };
    await opened.lifecycle.get("session_start")({}, ctx());
    opened.bus.emit("subagents:guard:register", validRegistration);
    expect(opened.manager.guardBridgeHost.getRegistration()).toBe(validRegistration);
    await opened.lifecycle.get("session_before_switch")?.();
    expect(opened.manager.guardBridgeHost.getRegistration()).toBeUndefined();
    await opened.lifecycle.get("session_start")({}, ctx());
    const next = { ...validRegistration };
    opened.bus.emit("subagents:guard:register", next);
    expect(opened.manager.guardBridgeHost.getRegistration()).toBe(next);
    expect(opened.bus.emit.mock.calls.filter(([event]) => event === "subagents:ready")).toHaveLength(2);
  });
  it("rejects registration before session start, after switch, and after shutdown", async () => {
    const opened = bootExtension();
    const beforeStart = { ...registration };
    opened.bus.emit("subagents:guard:register", beforeStart);
    expect(opened.manager.guardBridgeHost.getRegistration()).toBeUndefined();
    expect(opened.manager.guardBridgeHost.getRegistrationRejected()).toContain("no active session");

    await opened.lifecycle.get("session_start")({}, ctx());
    const active = { ...registration };
    opened.bus.emit("subagents:guard:register", active);
    expect(opened.manager.guardBridgeHost.getRegistration()).toBe(active);

    await opened.lifecycle.get("session_before_switch")?.();
    const afterSwitch = { ...registration };
    opened.bus.emit("subagents:guard:register", afterSwitch);
    expect(opened.manager.guardBridgeHost.getRegistration()).toBeUndefined();
    expect(opened.manager.guardBridgeHost.getRegistrationRejected()).toContain("no active session");
    expect(opened.bus.emit.mock.calls.filter(([event]) => event === "subagents:ready")).toHaveLength(1);

    await opened.lifecycle.get("session_start")({}, ctx());
    const restarted = { ...registration };
    opened.bus.emit("subagents:guard:register", restarted);
    expect(opened.manager.guardBridgeHost.getRegistration()).toBe(restarted);
    await opened.lifecycle.get("session_shutdown")?.();
    const afterShutdown = { ...registration };
    opened.bus.emit("subagents:guard:register", afterShutdown);
    expect(opened.manager.guardBridgeHost.getRegistration()).toBeUndefined();
    expect(opened.manager.guardBridgeHost.getRegistrationRejected()).toContain("no active session");
  });



  it("clears the current registration rejection after a later successful registration", async () => {
    const opened = bootExtension();
    opened.bus.emit("subagents:guard:register", { ...registration });
    const outsideWindowRejection = opened.manager.guardBridgeHost.getRegistrationRejected();
    expect(outsideWindowRejection).toContain("no active session");

    await opened.lifecycle.get("session_start")({}, ctx());
    opened.bus.emit("subagents:guard:register", { ...registration });
    expect(opened.manager.guardBridgeHost.getRegistrationRejected()).toBeUndefined();
    const advertisement = getGuardBridgeAdvertisement(opened.manager.guardBridgeHost);
    expect(advertisement).not.toHaveProperty("registrationRejected");
    expect(advertisement).toMatchObject({ registrationRejectionHistory: [outsideWindowRejection] });

    const reply = vi.fn();
    opened.bus.on("subagents:rpc:guard-bridge:reply:stale-diagnostic", reply);
    opened.bus.emit("subagents:rpc:guard-bridge", { requestId: "stale-diagnostic" });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0][0].data).not.toHaveProperty("registrationRejected");
    expect(reply.mock.calls[0][0].data.registrationRejectionHistory).toContain(outsideWindowRejection);
  });


  it("lets a never-opted-in user spawn normally with an unreadable project settings path", async () => {
    hermetic = hermeticDir();
    mkdirSync(join(hermetic.dir, ".pi", "subagents.json"), { recursive: true });
    previousManager = (globalThis as any)[managerKey];
    booted = makePi();
    bus = eventBus();
    booted.pi.events = bus;
    subagentsExtension(booted.pi);
    const manager = managerMocks.instances.at(-1)!;
    expect(manager.guardBridgeHost.guardExpected).toBe(false);
    expect(manager.guardBridgeHost.getGuardExpectedDiagnostic()).toContain("settings file unreadable:");
    const id = manager.spawn(booted.pi, ctx(), "general-purpose", "unreadable settings fallback", {
      description: "unreadable settings still default off",
      isBackground: true,
    });
    expect(manager.getRecord(id)).toBeDefined();
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
  });


  it("keeps global guard enablement when the project file says false", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false, guardExpected: false } });
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "subagents.json"), JSON.stringify({ guardExpected: true, guardRegistrant: "scope-guard" }));
    previousManager = (globalThis as any)[managerKey];
    booted = makePi();
    bus = eventBus();
    booted.pi.events = bus;
    subagentsExtension(booted.pi);
    const manager = managerMocks.instances.at(-1)!;
    expect(manager.guardBridgeHost.guardExpected).toBe(true);
    expect(() => manager.spawn({}, ctx(), "general-purpose", "global guard", { description: "test" })).toThrowError(
      expect.objectContaining({ reasonCode: "guard-missing", entryPath: "agent-manager.spawn" }),
    );
  });

  it("uses the real RPC gate before a forged registration can spawn", async () => {
    const opened = bootExtension({ guardExpected: false });
    opened.manager.setGuardRegistrant("scope-guard");
    opened.manager.setGuardExpected(true);
    await opened.lifecycle.get("session_start")({}, ctx());
    const reply = vi.fn();
    opened.bus.on("subagents:rpc:spawn:reply:real-gate", reply);
    opened.bus.emit("subagents:rpc:spawn", {
      requestId: "real-gate", type: "general-purpose", prompt: "RPC guarded prompt",
      options: { guardEntryPath: "workflow-tool.dispatch", guardBridgeRegistration: registration },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0][0]).toEqual({
      success: false,
      error: "guard-missing: guarded work is unavailable at cross-extension-rpc.spawn; no guard bridge registration is present.",
    });
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(opened.manager.listAgents()).toEqual([]);
  });

  it("strips forged registration and entry-path fields at the real RPC boundary", async () => {
    const opened = bootExtension({ guardExpected: false });
    const managerSpawn = vi.spyOn(opened.manager, "spawn");
    await opened.lifecycle.get("session_start")({}, ctx());
    const reply = vi.fn();
    opened.bus.on("subagents:rpc:spawn:reply:forged", reply);
    opened.bus.emit("subagents:rpc:spawn", {
      requestId: "forged", type: "general-purpose", prompt: "RPC forged prompt",
      options: { guardEntryPath: "workflow-tool.dispatch", guardBridgeRegistration: registration },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    const spawnOptions = managerSpawn.mock.calls[0][4];
    expect(spawnOptions).not.toHaveProperty("guardBridgeRegistration");
    expect(spawnOptions).not.toHaveProperty("guardEntryPath");
    const options = runnerMocks.runAgent.mock.calls.at(-1)![3];
    expect(options).not.toHaveProperty("guardBridgeRegistration");
    expect(options).not.toHaveProperty("guardEntryPath");
    expect(opened.manager.listAgents()).toHaveLength(1);
  });

  it("ignores forged bridge fields in Agent tool params and gates scheduled job creation", async () => {
    const opened = bootExtension({ guardExpected: false });
    const manager = opened.manager;
    const fakeRegistration = { ...registration, protocolVersion: 1 };
    const spawn = vi.spyOn(manager, "spawn");
    const spawnResult = await opened.tools.get("Agent").execute("forged-tool", {
      prompt: "tool forged prompt", description: "tool forge", subagent_type: "general-purpose",
      run_in_background: true, guardEntryPath: "workflow-tool.dispatch", guardBridgeRegistration: fakeRegistration,
    }, undefined, undefined, ctx());
    expect(spawnResult.isError).not.toBe(true);
    const options = runnerMocks.runAgent.mock.calls.at(-1)![3];
    expect(spawn.mock.calls[0][4].guardEntryPath).toBe("agent-tool.spawn-background");
    expect(options).not.toHaveProperty("guardEntryPath");
    expect(options).not.toHaveProperty("guardBridgeRegistration");

    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    await opened.lifecycle.get("session_start")({}, ctx({ cwd: hermetic!.dir }));
    const storeFile = join(hermetic!.dir, ".pi", "subagent-schedules", "s1.json");
    expect(existsSync(storeFile)).toBe(false);
    await expect(opened.tools.get("Agent").execute("schedule-create", {
      prompt: "schedule prompt", description: "guarded schedule", subagent_type: "general-purpose", schedule: "+10m",
    }, undefined, undefined, ctx({ cwd: hermetic!.dir }))).rejects.toMatchObject({
      reasonCode: "guard-missing", entryPath: "agent-tool.schedule-create",
    });
    expect(existsSync(storeFile)).toBe(false);
  });

  it("surfaces rejected registration diagnostics through RPC and tolerates nullish events", async () => {
    const opened = bootExtension();
    await opened.lifecycle.get("session_start")({}, ctx());
    opened.bus.emit("subagents:guard:register", null);
    opened.bus.emit("subagents:guard:register", undefined);
    const reply = vi.fn();
    opened.bus.on("subagents:rpc:guard-bridge:reply:diag", reply);
    opened.bus.emit("subagents:rpc:guard-bridge", { requestId: "diag" });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0][0]).toMatchObject({
      success: true,
      data: { registrationRejected: expect.stringContaining("received undefined") },
    });
  });

  it("bounds synchronous rejected-registration readiness re-entry to one re-emission", async () => {
    const opened = bootExtension();
    let readyEvents = 0;
    opened.bus.on("subagents:ready", () => {
      readyEvents++;
      if (readyEvents === 2) opened.bus.emit("subagents:guard:register", null);
    });
    await opened.lifecycle.get("session_start")({}, ctx());
    opened.bus.emit("subagents:guard:register", { ...registration, protocolVersion: 999 });
    expect(readyEvents).toBe(2);
    expect(opened.manager.guardBridgeHost.getRegistrationRejected()).toContain("received null");
  });

  it("bounds asynchronous rejected-registration re-emission after microtasks", async () => {
    const opened = bootExtension();
    let readyEvents = 0;
    let retries = 0;
    opened.bus.on("subagents:ready", async () => {
      readyEvents++;
      if (readyEvents === 2) {
        for (let attempt = 0; attempt < 4; attempt++) {
          await Promise.resolve();
          retries++;
          opened.bus.emit("subagents:guard:register", { ...registration, protocolVersion: 999 });
        }
      }
    });
    await opened.lifecycle.get("session_start")({}, ctx());
    opened.bus.emit("subagents:guard:register", { ...registration, protocolVersion: 999 });
    for (let drain = 0; drain < 8; drain++) await Promise.resolve();
    expect(retries).toBe(4);
    expect(readyEvents).toBe(2);
  });

  it("bounds timer-based rejected-registration re-emission", async () => {
    const opened = bootExtension();
    let readyEvents = 0;
    let retries = 0;
    let finishRetries!: () => void;
    const retriesFinished = new Promise<void>((resolve) => { finishRetries = resolve; });
    opened.bus.on("subagents:ready", () => {
      readyEvents++;
      if (readyEvents === 2) {
        const retry = () => {
          retries++;
          opened.bus.emit("subagents:guard:register", { ...registration, protocolVersion: 999 });
          if (retries < 4) setTimeout(retry, 0);
          else finishRetries();
        };
        setTimeout(retry, 0);
      }
    });
    await opened.lifecycle.get("session_start")({}, ctx());
    opened.bus.emit("subagents:guard:register", { ...registration, protocolVersion: 999 });
    await retriesFinished;
    expect(retries).toBe(4);
    expect(readyEvents).toBe(2);
  });

  it("caps distinct rejection-driven readiness emissions and resets the cap after a session switch", async () => {
    const opened = bootExtension();
    await opened.lifecycle.get("session_start")({}, ctx());
    opened.bus.emit("subagents:guard:register", null);
    opened.bus.emit("subagents:guard:register", 17);
    opened.bus.emit("subagents:guard:register", { ...registration, protocolVersion: 999 });
    opened.bus.emit("subagents:guard:register", { registrant: { id: "scope-guard", version: "1" }, protocolVersion: 1, callbacks: {} });
    expect(opened.bus.emit.mock.calls.filter(([event]) => event === "subagents:ready")).toHaveLength(4);

    await opened.lifecycle.get("session_before_switch")?.();
    await opened.lifecycle.get("session_start")({}, ctx());
    opened.bus.emit("subagents:guard:register", null);
    expect(opened.bus.emit.mock.calls.filter(([event]) => event === "subagents:ready")).toHaveLength(6);
  });


  it("saves the /agents settings file without materializing guardExpected", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "subagents.json"), JSON.stringify({ guardExpected: true, guardRegistrant: "scope-guard" }));
    previousManager = (globalThis as any)[managerKey];
    booted = makePi();
    bus = eventBus();
    booted.pi.events = bus;
    subagentsExtension(booted.pi);
    initTheme(undefined, false);
    let taken = false;
    const commandCtx = ctx({
      cwd: hermetic.dir,
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          if (title !== "Agents" || taken) return undefined;
          taken = true;
          return options.find(option => option === "Settings");
        }),
        custom: vi.fn(async (factory: any) => {
          const list = factory({ requestRender: vi.fn() }, {}, {}, () => {});
          list.handleInput(" ");
          return undefined;
        }),
        input: vi.fn(async () => undefined),
      },
    });
    await booted.commands.get("agents").handler("", commandCtx);
    const savedPath = join(hermetic.dir, ".pi", "subagents.json");
    const contents = readFileSync(savedPath, "utf8");
    const saved = JSON.parse(contents);
    expect(saved).not.toHaveProperty("guardExpected");
    expect(saved).not.toHaveProperty("guardRegistrant");
    expect(contents).toBe(JSON.stringify(saved, null, 2));
  });

  it("preserves project-owned guard settings when /agents saves an unrelated setting", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    mkdirSync(join(hermetic.dir, ".pi"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "subagents.json"), JSON.stringify({ guardExpected: true, guardRegistrant: "scope-guard", maxConcurrent: 7 }));
    previousManager = (globalThis as any)[managerKey];
    booted = makePi();
    bus = eventBus();
    booted.pi.events = bus;
    subagentsExtension(booted.pi);
    initTheme(undefined, false);
    let taken = false;
    const commandCtx = ctx({
      cwd: hermetic.dir,
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          if (title !== "Agents" || taken) return undefined;
          taken = true;
          return options.find(option => option === "Settings");
        }),
        custom: vi.fn(async (factory: any) => {
          const list = factory({ requestRender: vi.fn() }, {}, {}, () => {});
          list.handleInput(" ");
          return undefined;
        }),
        input: vi.fn(async () => undefined),
      },
    });
    await booted.commands.get("agents").handler("", commandCtx);
    const contents = readFileSync(join(hermetic.dir, ".pi", "subagents.json"), "utf8");
    const saved = JSON.parse(contents);
    expect(saved).toMatchObject({ guardExpected: true, guardRegistrant: "scope-guard" });
    expect(contents).toBe(JSON.stringify(saved, null, 2));
  });


  it("warns only once for a workflow flag when workflows are disabled", async () => {
    flags = { "subagents-workflow-file": "disabled-workflow.js" };
    const opened = bootExtension({ workflowsEnabled: false });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await opened.lifecycle.get("session_start")({}, ctx());
    await opened.lifecycle.get("session_start")({}, ctx());
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toContain("workflows are off");
    warning.mockRestore();
  });
});
