import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoSpies = vi.hoisted(() => ({ createHash: vi.fn(), digest: vi.fn() }));
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  cryptoSpies.createHash.mockImplementation((algorithm: string) => actual.createHash(algorithm));
  return {
    ...actual,
    createHash: cryptoSpies.createHash,
    webcrypto: { ...actual.webcrypto, subtle: { ...actual.webcrypto.subtle, digest: cryptoSpies.digest } },
  };
});

const sessionMocks = vi.hoisted(() => ({ createAgentSession: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  return { ...actual, createAgentSession: sessionMocks.createAgentSession };
});
vi.mock("../src/env.js", async () => {
  const actual = await vi.importActual<typeof import("../src/env.js")>("../src/env.js");
  return { ...actual, detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "test" })) };
});

const agentManagerMocks = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock("../src/agent-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-manager.js")>("../src/agent-manager.js");
  class CapturedAgentManager extends actual.AgentManager {
    constructor(...args: ConstructorParameters<typeof actual.AgentManager>) {
      super(...args);
      agentManagerMocks.instances.push(this);
    }
  }
  return { ...actual, AgentManager: CapturedAgentManager };
});


import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { GuardBridgeHost, type GuardBridgeRegistration } from "../src/guard-bridge.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

const managerKey = Symbol.for("pi-subagents:manager");
const missingMessages = {
  "agent-manager.pending-steer": "guard-missing: guarded work is unavailable at agent-manager.pending-steer; no guard bridge registration is present.",
  "agent-tool.resume-background": "guard-missing: guarded work is unavailable at agent-tool.resume-background; no guard bridge registration is present.",
  "agent-tool.resume-foreground": "guard-missing: guarded work is unavailable at agent-tool.resume-foreground; no guard bridge registration is present.",
  "agent-tool.steer": "guard-missing: guarded work is unavailable at agent-tool.steer; no guard bridge registration is present.",
  "nested-agent.spawn-background": "guard-missing: guarded work is unavailable at nested-agent.spawn-background; no guard bridge registration is present.",
  "nested-agent.spawn-foreground": "guard-missing: guarded work is unavailable at nested-agent.spawn-foreground; no guard bridge registration is present.",
  "nested-agent.resume": "guard-missing: guarded work is unavailable at nested-agent.resume; no guard bridge registration is present.",
  "nested-agent.steer": "guard-missing: guarded work is unavailable at nested-agent.steer; no guard bridge registration is present.",
  "agent-runner.turn-limit-steer": "guard-missing: guarded work is unavailable at agent-runner.turn-limit-steer; no guard bridge registration is present.",
  "agents-command.generate-definition": "guard-missing: guarded work is unavailable at agents-command.generate-definition; no guard bridge registration is present.",
} as const;
const incompatibleMessages = {
  "agent-manager.pending-steer": "guard-incompatible-protocol: guarded work is unavailable at agent-manager.pending-steer; expected protocolVersion integer 1, received 999 (typeof number).",
  "agent-tool.resume-background": "guard-incompatible-protocol: guarded work is unavailable at agent-tool.resume-background; expected protocolVersion integer 1, received 999 (typeof number).",
  "agent-tool.resume-foreground": "guard-incompatible-protocol: guarded work is unavailable at agent-tool.resume-foreground; expected protocolVersion integer 1, received 999 (typeof number).",
  "agent-tool.steer": "guard-incompatible-protocol: guarded work is unavailable at agent-tool.steer; expected protocolVersion integer 1, received 999 (typeof number).",
  "nested-agent.spawn-background": "guard-incompatible-protocol: guarded work is unavailable at nested-agent.spawn-background; expected protocolVersion integer 1, received 999 (typeof number).",
  "nested-agent.spawn-foreground": "guard-incompatible-protocol: guarded work is unavailable at nested-agent.spawn-foreground; expected protocolVersion integer 1, received 999 (typeof number).",
  "nested-agent.resume": "guard-incompatible-protocol: guarded work is unavailable at nested-agent.resume; expected protocolVersion integer 1, received 999 (typeof number).",
  "nested-agent.steer": "guard-incompatible-protocol: guarded work is unavailable at nested-agent.steer; expected protocolVersion integer 1, received 999 (typeof number).",
  "agent-runner.turn-limit-steer": "guard-incompatible-protocol: guarded work is unavailable at agent-runner.turn-limit-steer; expected protocolVersion integer 1, received 999 (typeof number).",
  "agents-command.generate-definition": "guard-incompatible-protocol: guarded work is unavailable at agents-command.generate-definition; expected protocolVersion integer 1, received 999 (typeof number).",
} as const;

type EntryPath = keyof typeof missingMessages;
type Scenario = "missing" | "incompatible" | "compatible" | "guard-off";

const registration = (protocolVersion = 1): GuardBridgeRegistration => ({
  registrant: { id: "scope-guard", version: "1" },
  protocolVersion,
  callbacks: {
    captureIngress: vi.fn(),
    enrollResource: vi.fn(),
    createChildContext: vi.fn((value: any) => ({ ...value, bridgeRef: registration() })),
    revalidate: vi.fn(() => "allowed"),
    approvalSettled: vi.fn(),
    approvalCancelled: vi.fn(),
    approvalExpired: vi.fn(),
  },
});

function fakeSession(turnsOnPrompt = 0) {
  const listeners = new Set<(event: any) => void>();
  const session: any = {
    messages: [],
    agent: {},
    sessionManager: { getSessionFile: vi.fn(() => undefined) },
    model: undefined,
    thinkingLevel: undefined,
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    getAllTools: vi.fn(() => []),
    getActiveToolNames: vi.fn(() => []),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    steer: vi.fn(async () => {}),
    abort: vi.fn(),
    dispose: vi.fn(),
    prompt: vi.fn(async () => {
      for (let i = 0; i < turnsOnPrompt; i++) {
        for (const listener of [...listeners]) listener({ type: "turn_end" });
      }
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "agent response" }] });
    }),
  };
  return { session, listeners };
}

interface Booted {
  pi: any;
  tools: Map<string, any>;
  lifecycle: Map<string, any>;
  commands: Map<string, any>;
  manager: AgentManager;
  extensionCtx: any;
  restore: () => Promise<void>;
}

let hermetic: ReturnType<typeof hermeticDir> | undefined;
let current: Booted | undefined;
let previousManager: unknown;
let nextSession: ReturnType<typeof fakeSession> | undefined;

let baselineCwd = "";
let baselineAgentDir: string | undefined;
let baselineHome: string | undefined;
let baselineManager: unknown;

function bootExtension(guardExpected = true): Booted {
  hermetic = hermeticDir({ settings: { outputTranscript: false, guardExpected, guardRegistrant: "scope-guard" } });
  previousManager = (globalThis as any)[managerKey];
  const booted = makePi();
  subagentsExtension(booted.pi);
  const manager = agentManagerMocks.instances.at(-1) as AgentManager;
  const result: Booted = {
    ...booted,
    manager,
    extensionCtx: ctx(),
    restore: async () => {
      await booted.lifecycle.get("session_shutdown")?.();
      if (previousManager === undefined) delete (globalThis as any)[managerKey];
      else (globalThis as any)[managerKey] = previousManager;
      hermetic?.restore();
      hermetic = undefined;
      current = undefined;
      previousManager = undefined;
    },
  };
  current = result;
  return result;
}

async function restoreCurrent(): Promise<void> {
  if (current) await current.restore();
}


function configureScenario(manager: AgentManager, scenario: Scenario): void {
  if (scenario === "missing") {
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
  } else if (scenario === "incompatible") {
    manager.registerGuard(registration(999));
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
  } else if (scenario === "compatible") {
    manager.registerGuard(registration());
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
  } else {
    manager.setGuardExpected(false);
  }
}

async function createRecord(
  manager: AgentManager,
  pi: any,
  extensionCtx: any,
  options: { parentAgentId?: string } = {},
) {
  manager.setGuardExpected(false);
  const id = manager.spawn(pi, extensionCtx, "general-purpose", "seed prompt", {
    description: "seed record",
    isBackground: true,
    isolated: true,
    ...options,
  });
  await manager.awaitStartup(id);
  const record = manager.getRecord(id);
  expect(record).toBeDefined();
  await vi.waitFor(() => expect(record?.session).toBeDefined());
  await vi.waitFor(() => expect(record?.status).toBe("completed"));
  return record!;

}

function snapshotRecord(record: any) {
  return {
    status: record.status,
    result: record.result,
    error: record.error,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    toolCallId: record.toolCallId,
    isBackground: record.isBackground,
    resultConsumed: record.resultConsumed,
    session: record.session,
    pendingSteers: record.pendingSteers ? [...record.pendingSteers] : undefined,
  };
}

async function expectTypedRejection(promise: Promise<unknown>, entryPath: EntryPath, scenario: "missing" | "incompatible") {
  const reasonCode = scenario === "missing" ? "guard-missing" : "guard-incompatible-protocol";
  const message = scenario === "missing" ? missingMessages[entryPath] : incompatibleMessages[entryPath];
  await expect(promise).rejects.toMatchObject({
    name: "GuardBridgeRejection",
    reasonCode,
    entryPath,
    message,
  });
}

function assertToolError(result: any, entryPath: EntryPath, scenario: "missing" | "incompatible") {
  const message = scenario === "missing" ? missingMessages[entryPath] : incompatibleMessages[entryPath];
  expect(result).toEqual({ content: [{ type: "text", text: message }], isError: true, details: {} });
}

beforeEach(() => {
  baselineCwd = process.cwd();
  baselineAgentDir = process.env.PI_CODING_AGENT_DIR;
  baselineHome = process.env.HOME;
  baselineManager = (globalThis as any)[managerKey];
  agentManagerMocks.instances.length = 0;
  cryptoSpies.createHash.mockClear();
  cryptoSpies.digest.mockClear();
  sessionMocks.createAgentSession.mockReset();
  sessionMocks.createAgentSession.mockImplementation(async () => {
    nextSession = fakeSession();
    return { session: nextSession.session };
  });
  nextSession = undefined;
});
afterEach(async () => {
  await restoreCurrent();
  expect(process.cwd()).toBe(baselineCwd);
  expect(process.env.PI_CODING_AGENT_DIR).toBe(baselineAgentDir);
  expect(process.env.HOME).toBe(baselineHome);
  expect((globalThis as any)[managerKey]).toBe(baselineManager);
  expect(cryptoSpies.createHash.mock.calls.every(([algorithm]) => algorithm === "sha256")).toBe(true);
  expect(cryptoSpies.digest).not.toHaveBeenCalled();
});

describe("real agent entry handlers require guard registration", () => {
  it.each(["agent-tool.resume-background", "agent-tool.resume-foreground", "agent-tool.steer"] as const)(
    "%s rejects missing and incompatible registration, proceeds once when compatible, and preserves guard-off behavior",
    async (entryPath) => {
      for (const scenario of ["missing", "incompatible", "compatible", "guard-off"] as const) {
        const { pi, tools, manager, extensionCtx } = bootExtension(false);
        const record = await createRecord(manager, pi, extensionCtx);
        if (entryPath === "agent-tool.steer") record.status = "running";
        else record.status = "completed";
        configureScenario(manager, scenario);
        const before = snapshotRecord(record);
        const promptsBefore = nextSession!.session.prompt.mock.calls.length;
        const steersBefore = nextSession!.session.steer.mock.calls.length;
        const createsBefore = sessionMocks.createAgentSession.mock.calls.length;
        const execute = entryPath === "agent-tool.steer" ? tools.get("steer_subagent").execute : tools.get("Agent").execute;
        const invocation = entryPath === "agent-tool.steer"
          ? execute("tool-steer", { agent_id: record.id, message: "same raw prompt" }, undefined, undefined, ctx())
          : execute("tool-resume", {
              prompt: "same raw prompt",
              description: "resume record",
              subagent_type: "general-purpose",
              resume: record.id,
              run_in_background: entryPath === "agent-tool.resume-background",
            }, undefined, undefined, ctx());

        if (scenario === "missing" || scenario === "incompatible") {
          await expectTypedRejection(invocation, entryPath, scenario);
          expect(snapshotRecord(record)).toEqual(before);
          expect(nextSession!.session.prompt).toHaveBeenCalledTimes(promptsBefore);
          expect(nextSession!.session.steer).toHaveBeenCalledTimes(steersBefore);
          expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(createsBefore);
        } else {
          const result = await invocation;
          expect(result.isError).not.toBe(true);
          expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(createsBefore);
          if (entryPath === "agent-tool.steer") {
            expect(nextSession!.session.steer).toHaveBeenCalledTimes(steersBefore + 1);
            expect(nextSession!.session.prompt).toHaveBeenCalledTimes(promptsBefore);
          } else {
            if (entryPath === "agent-tool.resume-background") {
              await vi.waitFor(() => expect(nextSession!.session.prompt).toHaveBeenCalledTimes(promptsBefore + 1));
            }

            expect(nextSession!.session.prompt).toHaveBeenCalledTimes(promptsBefore + 1);
            expect(nextSession!.session.steer).toHaveBeenCalledTimes(steersBefore);
          }
          if (scenario === "compatible") {
            if (entryPath === "agent-tool.steer") expect(nextSession!.session.steer).toHaveBeenCalledTimes(1);
            else expect(nextSession!.session.prompt).toHaveBeenCalledTimes(2);
          }
        }
        await restoreCurrent();

      }
    },
  );

  it.each([
    ["nested-agent.spawn-background", "background"],
    ["nested-agent.spawn-foreground", "foreground"],
    ["nested-agent.resume", "resume"],
    ["nested-agent.steer", "steer"],
  ] as const)("%s gates the real nested tool handler for all registration states", async (entryPath, mode) => {
    for (const scenario of ["missing", "incompatible", "compatible", "guard-off"] as const) {
      const { pi, manager, extensionCtx } = bootExtension(false);
      let record: any;
      if (mode === "resume" || mode === "steer") {
        record = await createRecord(manager, pi, extensionCtx, { parentAgentId: "parent-agent" });
        record.status = mode === "steer" ? "running" : "completed";
      }
      configureScenario(manager, scenario);
      const tools = createNestedSubagentTools({
        manager,
        pi,
        parentAgentId: "parent-agent",
        depth: 1,
        maxSubagentDepth: 2,
        allowedSubagents: "all",
        configCwd: process.cwd(),
      });
      const agent = tools.find((tool) => tool.name === "Agent")!;
      const steerTool = tools.find((tool) => tool.name === "steer_subagent")!;
      const beforeRecords = manager.listAgents().map((item) => item.id);
      const before = record ? snapshotRecord(record) : undefined;
      const activeSession = record?.session ?? nextSession?.session;
      const promptsBefore = activeSession?.prompt.mock.calls.length ?? 0;
      const steersBefore = activeSession?.steer.mock.calls.length ?? 0;
      const createsBefore = sessionMocks.createAgentSession.mock.calls.length;
      const invoke = mode === "steer"
        ? steerTool.execute("nested-steer", { agent_id: record.id, message: "same raw prompt" }, undefined, undefined, ctx())
        : agent.execute("nested-agent", mode === "resume"
            ? { resume: record.id, prompt: "same raw prompt", description: "resume" }
            : { prompt: "same raw prompt", description: "nested spawn", subagent_type: "general-purpose", run_in_background: mode === "background", isolated: true },
          undefined, undefined, ctx());

      if (scenario === "missing" || scenario === "incompatible") {
        if (mode === "background" || mode === "foreground") {
          assertToolError(await invoke, entryPath, scenario);
        } else {
          await expectTypedRejection(invoke, entryPath, scenario);
        }
        expect(manager.listAgents().map((item) => item.id)).toEqual(beforeRecords);
        if (record) expect(snapshotRecord(record)).toEqual(before);
        if (activeSession) {
          expect(activeSession.prompt).toHaveBeenCalledTimes(promptsBefore);
          expect(activeSession.steer).toHaveBeenCalledTimes(steersBefore);
        }
        expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(createsBefore);
      } else {
        await expect(invoke).resolves.toMatchObject({ isError: false });
        if (mode === "background" || mode === "foreground") {
          expect(manager.listAgents()).toHaveLength(beforeRecords.length + 1);
          await vi.waitFor(() => expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(createsBefore + 1));
          expect(manager.listAgents()).toHaveLength(beforeRecords.length + 1);
        } else if (mode === "resume") {
          expect(manager.listAgents().map((item) => item.id)).toEqual(beforeRecords);
          expect(record.session.prompt).toHaveBeenCalledTimes(promptsBefore + 1);
        } else {
          expect(manager.listAgents().map((item) => item.id)).toEqual(beforeRecords);
          expect(record.session.steer).toHaveBeenCalledTimes(steersBefore + 1);
        }
        if (scenario === "compatible") {
          if (mode === "background" || mode === "foreground") expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(createsBefore + 1);
          if (mode === "resume") expect(record.session.prompt).toHaveBeenCalledTimes(promptsBefore + 1);
          if (mode === "steer") expect(record.session.steer).toHaveBeenCalledTimes(steersBefore + 1);
        }
      }
      await restoreCurrent();

    }
  });

  it.each(["missing", "incompatible", "compatible", "guard-off"] as const)(
    "pending-steer replay uses the real AgentManager session-created handler (%s)",
    async (scenario) => {
      const { pi, manager, extensionCtx } = bootExtension(false);
      manager.setGuardExpected(false);
      let releaseSession!: (value: { session: any }) => void;
      sessionMocks.createAgentSession.mockImplementationOnce(() => new Promise((resolve) => { releaseSession = resolve; }));
      const id = manager.spawn(pi, extensionCtx, "general-purpose", "pending raw prompt", {
        description: "pending steer",
        isBackground: true,
        isolated: true,
      });
      await vi.waitFor(() => expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(1));
      const record = manager.getRecord(id)!;
      manager.steer(id, "queued identical prompt text");
      expect(record.pendingSteers).toEqual(["queued identical prompt text"]);
      const beforeSession = record.session;
      configureScenario(manager, scenario);
      const session = fakeSession().session;
      releaseSession({ session });

      if (scenario === "missing" || scenario === "incompatible") {
        await vi.waitFor(() => expect(record.status).toBe("error"));
        expect(record.error).toBe(scenario === "missing" ? missingMessages["agent-manager.pending-steer"] : incompatibleMessages["agent-manager.pending-steer"]);

        expect(session.steer).not.toHaveBeenCalled();
        expect(record.session).toBe(beforeSession);
        expect(session.dispose).toHaveBeenCalledTimes(1);
        expect(record.pendingSteers).toEqual(["queued identical prompt text"]);
        expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(1);
        expect(session.prompt).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

        await manager.awaitStartup(id);
        expect(session.steer).toHaveBeenCalledTimes(1);
        expect(session.steer).toHaveBeenCalledWith("queued identical prompt text");
        expect(record.pendingSteers).toBeUndefined();
        expect(session.prompt).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["missing", "incompatible", "compatible", "guard-off"] as const)(
    "turn-limit package-origin steer runs through actual runAgent turn_end (%s)",
    async (scenario) => {
      const events: string[] = [];
      const host = new GuardBridgeHost(scenario !== "guard-off", "scope-guard");
      const bridgeRegistration = registration();
      const captureIngress = vi.fn((_evidence: any) => { events.push("capture"); });
      bridgeRegistration.callbacks.captureIngress = captureIngress;
      if (scenario === "incompatible") host.register(registration(999));
      if (scenario === "compatible") host.register(bridgeRegistration);
      nextSession = fakeSession(1);
      nextSession.session.steer.mockImplementation(async () => { events.push("steer"); });
      sessionMocks.createAgentSession.mockImplementationOnce(async () => ({ session: nextSession!.session }));
      const prompt = nextSession.session.prompt;
      const run = runAgent(ctx(), "general-purpose", "turn-limit prompt", {
        pi: makePi().pi,
        isolated: true,
        maxTurns: 1,
        guardBridgeHost: host,
      });
      if (scenario === "missing" || scenario === "incompatible") {
        await expect(run).rejects.toMatchObject({
          name: "GuardBridgeRejection",
          reasonCode: scenario === "missing" ? "guard-missing" : "guard-incompatible-protocol",
          entryPath: "agent-manager.spawn",
        });
        // Child restriction enrollment now requires a usable registration before
        // constructing the session, so the turn-limit path is never reached.
        expect(prompt).not.toHaveBeenCalled();
        expect(nextSession.session.steer).not.toHaveBeenCalled();
        expect(sessionMocks.createAgentSession).not.toHaveBeenCalled();
        expect(captureIngress).not.toHaveBeenCalled();
      } else {
        await expect(run).resolves.toMatchObject({ steered: true });
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(nextSession.session.steer).toHaveBeenCalledTimes(1);
        if (scenario === "compatible") {
          expect(captureIngress).toHaveBeenCalledTimes(1);
          expect(captureIngress).toHaveBeenCalledWith(expect.objectContaining({
            rawText: "You have reached your turn limit. Wrap up immediately — provide your final answer now.",
            coverage: "complete",
            origin: "package-system-control",
            entryPath: "agent-runner.turn-limit-steer",
          }));
          expect(events).toEqual(["capture", "steer"]);
        }
      }
    },
  );

  it.each(["unregister", "replace"] as const)("records a diagnostic and suppresses a turn-limit steer after registration %s", async (change) => {
    const host = new GuardBridgeHost(true, "scope-guard");
    const bridgeRegistration = registration();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    bridgeRegistration.callbacks.captureIngress = vi.fn(() => pending);
    host.register(bridgeRegistration);
    nextSession = fakeSession(1);
    sessionMocks.createAgentSession.mockImplementationOnce(async () => ({ session: nextSession!.session }));
    const run = runAgent(ctx(), "general-purpose", "turn-limit prompt", {
      pi: makePi().pi,
      isolated: true,
      maxTurns: 1,
      guardBridgeHost: host,
      guardExpected: true,
    });
    await expect(run).resolves.toMatchObject({ steered: true });
    host.unregister();
    if (change === "replace") host.register(registration());
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(nextSession.session.steer).not.toHaveBeenCalled();
    expect(host.getIngressCaptureFailures()).toEqual([expect.stringContaining("agent-runner.turn-limit-steer")]);
    expect(host.getIngressCaptureFailures().join(" ")).not.toContain("turn-limit prompt");
  });

  it.each(["missing", "incompatible", "compatible", "guard-off"] as const)(
    "the real /agents generate-definition command gates before spawning (%s)",
    async (scenario) => {
      const { commands, manager } = bootExtension(false);
      configureScenario(manager, scenario);
      const selectValues: Record<string, string[]> = {
        Agents: ["Create new agent"],
        "Choose location": ["Project (.pi/agents/)"],
        "Creation method": ["Generate with Claude (recommended)"],
      };
      const commandCtx = ctx({
        ui: {
          ...ctx().ui,
          select: vi.fn(async (title: string) => selectValues[title].shift()),
          input: vi.fn(async (title: string) => title === "Describe what this agent should do" ? "write a helper" : "guard-helper"),
          confirm: vi.fn(async () => true),
        },
      });
      const spawn = vi.spyOn(manager, "spawn");
      const createsBefore = sessionMocks.createAgentSession.mock.calls.length;
      const handler = commands.get("agents").handler;
      const invocation = handler("", commandCtx);
      if (scenario === "missing" || scenario === "incompatible") {
        await expectTypedRejection(invocation, "agents-command.generate-definition", scenario);
        expect(spawn).not.toHaveBeenCalled();
        expect(manager.listAgents()).toEqual([]);
        expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(createsBefore);
      } else {
        await expect(invocation).resolves.toBeUndefined();
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0][4]).toMatchObject({ guardEntryPath: "agents-command.generate-definition" });
        expect(manager.listAgents()).toHaveLength(1);
        expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(createsBefore + 1);
        if (scenario === "compatible") expect(spawn).toHaveBeenCalledTimes(1);
      }
    },
  );


  it("passes the registered host through the real manager-to-runner path", async () => {
    const { pi, manager, extensionCtx } = bootExtension(true);
    manager.registerGuard(registration());
    nextSession = fakeSession(1);
    sessionMocks.createAgentSession.mockImplementationOnce(async () => ({ session: nextSession!.session }));
    const id = manager.spawn(pi, extensionCtx, "general-purpose", "runner guard wiring canary", {
      description: "guard runner wiring",
      isBackground: true,
      isolated: true,
      maxTurns: 1,
    });
    const record = manager.getRecord(id)!;
    await vi.waitFor(() => expect(record.status).toBe("steered"));
    expect(record.error).toBeUndefined();
    expect(nextSession.session.steer).toHaveBeenCalledTimes(1);
    expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a turn-limit steer after registration disappears through real manager.spawn", async () => {
    const { pi, manager, extensionCtx } = bootExtension(true);
    manager.registerGuard(registration());
    nextSession = fakeSession(1);
    const prompt = nextSession.session.prompt;
    nextSession.session.prompt = vi.fn(async (...args: any[]) => {
      manager.unregisterGuard();
      await prompt(...args);
    });
    sessionMocks.createAgentSession.mockImplementationOnce(async () => ({ session: nextSession!.session }));

    const id = manager.spawn(pi, extensionCtx, "general-purpose", "turn-limit missing registration", {
      description: "turn-limit guard wiring missing registration",
      isBackground: true,
      isolated: true,
      maxTurns: 1,
    });
    const record = manager.getRecord(id)!;
    await vi.waitFor(() => expect(record.status).toBe("error"));
    expect(record.error).toContain("guard-missing: guarded work is unavailable at agent-runner.turn-limit-steer");
    expect(nextSession.session.steer).not.toHaveBeenCalled();
  });


  it("fails closed when a required runner host is absent", async () => {
    nextSession = fakeSession(1);
    sessionMocks.createAgentSession.mockImplementationOnce(async () => ({ session: nextSession!.session }));
    await expect(runAgent(ctx(), "general-purpose", "missing host prompt", {
      pi: makePi().pi,
      isolated: true,
      maxTurns: 1,
      guardExpected: true,
    })).rejects.toThrow("no guard bridge host is present in runner options");
    expect(nextSession.session.steer).not.toHaveBeenCalled();
  });
});
