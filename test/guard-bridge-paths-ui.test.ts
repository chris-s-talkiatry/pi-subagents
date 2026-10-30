import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  steerAgent: vi.fn(),
  runMentionClone: vi.fn(),
}));

const cryptoSpies = vi.hoisted(() => ({ createHash: vi.fn(), digest: vi.fn() }));
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    createHash: cryptoSpies.createHash,
    webcrypto: { ...actual.webcrypto, subtle: { ...actual.webcrypto.subtle, digest: cryptoSpies.digest } },
  };
});
vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, ...runnerMocks };
});
vi.mock("../src/mention-clone.js", async () => {
  const actual = await vi.importActual<typeof import("../src/mention-clone.js")>("../src/mention-clone.js");
  return { ...actual, runMentionClone: runnerMocks.runMentionClone };
});

import { AgentManager } from "../src/agent-manager.js";
import { type GuardBridgeRegistration, GuardBridgeRejection } from "../src/guard-bridge.js";
import subagentsExtension from "../src/index.js";
import { FleetList } from "../src/ui/fleet-list.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

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

function registration(protocolVersion = 1): GuardBridgeRegistration {
  return {
    registrant: { id: "scope-guard", version: "1" },
    protocolVersion,
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource: vi.fn(),
      createChildContext: vi.fn((value: any) => ({ ...value, bridgeRef: registration(1) })),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
    },
  };
}

const session = () => ({
  steer: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  messages: [],
  getActiveToolNames: vi.fn(() => []),
  getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
});

let hermetic: Hermetic | undefined;
let booted: BootedPi | undefined;
let bus: ReturnType<typeof eventBus> | undefined;
let previousManager: unknown;
const managers = new Set<AgentManager>();

function bootExtension(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, guardExpected: false, guardRegistrant: "scope-guard", ...settings } });
  previousManager = (globalThis as any)[MANAGER_KEY];
  booted = makePi();
  bus = eventBus();
  booted.pi.events = bus;
  subagentsExtension(booted.pi);
  return { ...booted, bus };
}

async function startExtensionLive(extension: ReturnType<typeof bootExtension>, type = "general-purpose", prompt = "seed prompt", guardExpected = true) {
  await extension.lifecycle.get("session_start")?.({}, ctx());
  const agentSession = session();
  runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, options: any) =>
    new Promise(() => options.onSessionCreated?.(agentSession)),
  );
  const id = (globalThis as any)[MANAGER_KEY].spawn(extension.pi, ctx(), type, prompt, {
    description: "guard path seed",
    isBackground: true,
  });
  const manager = runnerMocks.runAgent.mock.calls.at(-1)![3].nestedRuntime.manager as AgentManager;
  if (guardExpected) {
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
  }
  return { id, manager, record: manager.getRecord(id)!, session: agentSession };
}

async function startExtensionFinished(extension: ReturnType<typeof bootExtension>, guardExpected = true) {
  await extension.lifecycle.get("session_start")?.({}, ctx());
  const agentSession = session();
  runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
    options.onSessionCreated?.(agentSession);
    return {
      responseText: "seed answer",
      session: agentSession,
      aborted: false,
      steered: false,
      failure: undefined,
    };
  });
  const id = (globalThis as any)[MANAGER_KEY].spawn(extension.pi, ctx(), "general-purpose", "seed prompt", {
    description: "guard path seed",
    isBackground: true,
  });
  const manager = runnerMocks.runAgent.mock.calls.at(-1)![3].nestedRuntime.manager as AgentManager;
  await flush();
  if (guardExpected) {
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
  }
  return { id, manager, record: manager.getRecord(id)!, session: agentSession };
}

function startManagerLiveAgent(manager: AgentManager, prompt: string) {
  const agentSession = session();
  manager.setGuardExpected(false);
  runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, options: any) =>
    new Promise(() => options.onSessionCreated?.(agentSession)),
  );
  const id = manager.spawn({} as any, ctx(), "general-purpose", prompt, {
    description: "guard path seed",
    isBackground: true,
  });
  return { id, record: manager.getRecord(id)!, session: agentSession };
}


function register(busRef: ReturnType<typeof eventBus>, mode: "missing" | "incompatible" | "compatible") {
  if (mode === "incompatible") busRef.emit("subagents:guard:register", registration(999));
  if (mode === "compatible") busRef.emit("subagents:guard:register", registration());
}

function snapshot(record: any) {
  return {
    status: record.status,
    result: record.result,
    error: record.error,
    resultConsumed: record.resultConsumed,
    completedAt: record.completedAt,
    toolCallId: record.toolCallId,
  };
}

function assertTypedRejection(spy: ReturnType<typeof vi.spyOn>, reasonCode: string, entryPath: string) {
  const rejection = (spy.mock.results.find(result => result.type === "throw") as any)?.value;
  expect(rejection).toBeInstanceOf(GuardBridgeRejection);
  expect(rejection).toMatchObject({ name: "GuardBridgeRejection", reasonCode, entryPath });
}

async function shutdown() {
  if (booted) await booted.lifecycle.get("session_shutdown")?.();
  for (const manager of managers) manager.dispose();
  managers.clear();
  if (booted) {
    if (previousManager === undefined) delete (globalThis as any)[MANAGER_KEY];
    else (globalThis as any)[MANAGER_KEY] = previousManager;
  }
  hermetic?.restore();
  hermetic = undefined;
  booted = undefined;
  bus = undefined;
  previousManager = undefined;
}

beforeEach(() => {
  cryptoSpies.createHash.mockClear();
  cryptoSpies.digest.mockClear();
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  runnerMocks.steerAgent.mockReset();
  runnerMocks.runMentionClone.mockReset();
  runnerMocks.runAgent.mockImplementation(() => new Promise(() => {}));
  runnerMocks.resumeAgent.mockResolvedValue({ text: "resumed answer", failure: undefined });
  runnerMocks.runMentionClone.mockResolvedValue({ spawned: true });
});
afterEach(async () => {
  expect(cryptoSpies.createHash).not.toHaveBeenCalled();
  expect(cryptoSpies.digest).not.toHaveBeenCalled();
  await shutdown();
});

describe("real input-handler guard rejection preserves human mentions", () => {
  it.each([
    ["missing", "guard-missing", "guard-missing: guarded work is unavailable at mention.input-start; no guard bridge registration is present."],
    ["incompatible", "guard-incompatible-protocol", "guard-incompatible-protocol: guarded work is unavailable at mention.input-start; expected protocolVersion integer 1, received 999 (typeof number)."],
  ] as const)("keeps exact original input for direct start with %s registration", async (mode, reasonCode, message) => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionLive(opened);
    register(opened.bus, mode);
    runnerMocks.runAgent.mockClear();
    const spawn = vi.spyOn(seeded.manager, "spawn");
    const assertGuard = vi.spyOn(seeded.manager, "assertGuard");
    const before = snapshot(seeded.record);
    const original = { type: "input", text: "@explore preserve this exact request", source: "interactive" };
    const inputCtx = ctx();
    const result = await opened.lifecycle.get("input")(original, inputCtx);

    expect(result).toEqual({ action: "continue" });
    expect(original).toEqual({ type: "input", text: "@explore preserve this exact request", source: "interactive" });
    expect(inputCtx.ui.notify).toHaveBeenCalledWith(message, "warning");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(seeded.manager.listAgents()).toHaveLength(1);
    expect(snapshot(seeded.record)).toEqual(before);
    assertTypedRejection(assertGuard, reasonCode, "mention.input-start");
  });

  it.each([
    ["compatible", true],
    ["disabled", false],
  ] as const)("starts directly exactly once with %s guard state", async (mode, guarded) => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionLive(opened, "general-purpose", "seed prompt", guarded);
    if (mode === "compatible") register(opened.bus, "compatible");
    runnerMocks.runAgent.mockClear();
    const spawn = vi.spyOn(seeded.manager, "spawn");
    const original = { type: "input", text: "@explore compatible direct start", source: "interactive" };
    const result = await opened.lifecycle.get("input")(original, ctx());

    expect(result).toEqual({ action: "handled" });
    expect(original.text).toBe("@explore compatible direct start");
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][4]).toMatchObject({ guardEntryPath: "mention.input-start" });
    expect(seeded.manager.listAgents()).toHaveLength(2);
  });

  it.each([
    ["missing", "guard-missing"],
    ["incompatible", "guard-incompatible-protocol"],
  ] as const)("keeps exact input unchanged when mention.input-clone has %s registration", async (mode, reasonCode) => {
    const opened = bootExtension({ agentMentions: "model" });
    const seeded = await startExtensionLive(opened);
    register(opened.bus, mode);
    runnerMocks.runAgent.mockClear();
    const spawn = vi.spyOn(seeded.manager, "spawn");
    const assertGuard = vi.spyOn(seeded.manager, "assertGuard");
    const before = snapshot(seeded.record);
    const original = { type: "input", text: "@explore clone must not eat this", source: "interactive" };
    const inputCtx = ctx();
    const result = await opened.lifecycle.get("input")(original, inputCtx);

    expect(result).toEqual({ action: "continue" });
    expect(original).toEqual({ type: "input", text: "@explore clone must not eat this", source: "interactive" });
    expect(inputCtx.ui.notify).toHaveBeenCalledWith(
      reasonCode === "guard-missing"
        ? "guard-missing: guarded work is unavailable at mention.input-clone; no guard bridge registration is present."
        : "guard-incompatible-protocol: guarded work is unavailable at mention.input-clone; expected protocolVersion integer 1, received 999 (typeof number).",
      "warning",
    );
    expect(runnerMocks.runMentionClone).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(seeded.manager.listAgents()).toHaveLength(1);
    expect(snapshot(seeded.record)).toEqual(before);
    assertTypedRejection(assertGuard, reasonCode, "mention.input-clone");
  });

  it.each([
    ["compatible", true],
    ["disabled", false],
  ] as const)("dispatches the mention clone exactly once with %s guard state", async (mode, guarded) => {
    const opened = bootExtension({ agentMentions: "model" });
    const seeded = await startExtensionLive(opened, "general-purpose", "seed prompt", guarded);
    if (mode === "compatible") register(opened.bus, "compatible");
    runnerMocks.runAgent.mockClear();
    const spawn = vi.spyOn(seeded.manager, "spawn");
    const original = { type: "input", text: "@explore clone this request", source: "interactive" };
    const result = await opened.lifecycle.get("input")(original, ctx());

    expect(result).toEqual({ action: "handled" });
    expect(original.text).toBe("@explore clone this request");
    expect(runnerMocks.runMentionClone).toHaveBeenCalledTimes(1);
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(seeded.manager.listAgents()).toHaveLength(1);
  });


  it("still falls back from a real failed clone through mention.input-start exactly once", async () => {
    const opened = bootExtension({ agentMentions: "model" });
    const seeded = await startExtensionLive(opened);
    register(opened.bus, "compatible");
    runnerMocks.runAgent.mockClear();
    const spawn = vi.spyOn(seeded.manager, "spawn");
    runnerMocks.runMentionClone.mockResolvedValue({ spawned: false, error: "no session file" });
    const original = { type: "input", text: "@explore fall back once", source: "interactive" };
    const result = await opened.lifecycle.get("input")(original, ctx());
    await flush();

    expect(result).toEqual({ action: "handled" });
    expect(original.text).toBe("@explore fall back once");
    expect(runnerMocks.runMentionClone).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][4]).toMatchObject({ guardEntryPath: "mention.input-start" });
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
    expect(seeded.manager.listAgents()).toHaveLength(2);
  });
});

describe("real mention resume and steer handlers", () => {
  it.each([
    ["missing", "guard-missing", "guard-missing: guarded work is unavailable at mention.input-steer; no guard bridge registration is present."],
    ["incompatible", "guard-incompatible-protocol", "guard-incompatible-protocol: guarded work is unavailable at mention.input-steer; expected protocolVersion integer 1, received 999 (typeof number)."],
  ] as const)("returns the original live-steer input on %s registration", async (mode, reasonCode, message) => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionLive(opened);
    register(opened.bus, mode);
    runnerMocks.runAgent.mockClear();
    seeded.record.resultConsumed = true;
    const before = snapshot(seeded.record);
    const assertGuard = vi.spyOn(seeded.manager, "assertGuard");
    const steer = vi.spyOn(seeded.manager, "steer");
    const original = { type: "input", text: "@general-purpose keep the live task", source: "interactive" };
    const inputCtx = ctx();
    const result = await opened.lifecycle.get("input")(original, inputCtx);

    expect(result).toEqual({ action: "continue" });
    expect(original).toEqual({ type: "input", text: "@general-purpose keep the live task", source: "interactive" });
    expect(inputCtx.ui.notify).toHaveBeenCalledWith(message, "warning");
    expect(steer).not.toHaveBeenCalled();
    expect(seeded.session.steer).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
    expect(snapshot(seeded.record)).toEqual(before);
    assertTypedRejection(assertGuard, reasonCode, "mention.input-steer");
  });

  it.each([
    ["compatible", true],
    ["disabled", false],
  ] as const)("preserves upstream live-steer behavior with %s guard state", async (mode, guarded) => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionLive(opened, "general-purpose", "seed prompt", guarded);
    if (mode === "compatible") register(opened.bus, "compatible");
    runnerMocks.runAgent.mockClear();
    const steer = vi.spyOn(seeded.manager, "steer");
    const result = await opened.lifecycle.get("input")(
      { type: "input", text: "@general-purpose proceed once", source: "interactive" },
      ctx(),
    );

    expect(result).toEqual({ action: "handled" });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(seeded.id, "proceed once");
    expect(seeded.session.steer).toHaveBeenCalledTimes(1);
    expect(seeded.session.steer).toHaveBeenCalledWith("proceed once");
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "guard-missing", "guard-missing: guarded work is unavailable at mention.input-resume; no guard bridge registration is present."],
    ["incompatible", "guard-incompatible-protocol", "guard-incompatible-protocol: guarded work is unavailable at mention.input-resume; expected protocolVersion integer 1, received 999 (typeof number)."],
  ] as const)("returns the original live-resume input on %s registration", async (mode, reasonCode, message) => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionFinished(opened);
    register(opened.bus, mode);
    runnerMocks.runAgent.mockClear();
    seeded.record.resultConsumed = true;
    const before = snapshot(seeded.record);
    const resume = vi.spyOn(seeded.manager, "resume");
    const assertGuard = vi.spyOn(seeded.manager, "assertGuard");
    const original = { type: "input", text: "@general-purpose continue the finished task", source: "interactive" };
    const inputCtx = ctx();
    const result = await opened.lifecycle.get("input")(original, inputCtx);

    expect(result).toEqual({ action: "continue" });
    expect(original).toEqual({ type: "input", text: "@general-purpose continue the finished task", source: "interactive" });
    expect(inputCtx.ui.notify).toHaveBeenCalledWith(message, "warning");
    expect(resume).not.toHaveBeenCalled();
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(seeded.session.steer).not.toHaveBeenCalled();
    expect(snapshot(seeded.record)).toEqual(before);
    assertTypedRejection(assertGuard, reasonCode, "mention.input-resume");
  });

  it.each([
    ["compatible", true],
    ["disabled", false],
  ] as const)("resumes a live record exactly once with %s guard state", async (mode, guarded) => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionFinished(opened, guarded);
    if (mode === "compatible") register(opened.bus, "compatible");
    runnerMocks.runAgent.mockClear();
    const resume = vi.spyOn(seeded.manager, "resume");
    const result = await opened.lifecycle.get("input")(
      { type: "input", text: "@general-purpose resume once", source: "interactive" },
      ctx(),
    );

    expect(result).toEqual({ action: "handled" });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(seeded.id, "resume once", undefined, expect.objectContaining({
      isBackground: true,
      guardEntryPath: "mention.input-resume",
    }));
    expect(runnerMocks.resumeAgent).toHaveBeenCalledTimes(1);
    expect(seeded.session.steer).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "guard-missing", "guard-missing: guarded work is unavailable at mention.input-resume; no guard bridge registration is present."],
    ["incompatible", "guard-incompatible-protocol", "guard-incompatible-protocol: guarded work is unavailable at mention.input-resume; expected protocolVersion integer 1, received 999 (typeof number)."],
  ] as const)("preserves exact input for tombstone reopen on %s registration", async (mode, reasonCode, message) => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionLive(opened, "Plan", "seed prompt", false);
    const sessionFile = join(process.cwd(), "reopen-session.jsonl");
    writeFileSync(sessionFile, "session transcript\n");
    const entry = {
      handle: "explore",
      id: "evicted-agent-id",
      type: "Explore",
      description: "evicted agent",
      sessionFile,
      completedAt: Date.now(),
    };
    (seeded.manager as any).tombstones.set(entry.handle, entry);
    seeded.manager.setGuardRegistrant("scope-guard");
    seeded.manager.setGuardExpected(true);
    register(opened.bus, mode);
    runnerMocks.runAgent.mockClear();
    const spawn = vi.spyOn(seeded.manager, "spawn");
    const assertGuard = vi.spyOn(seeded.manager, "assertGuard");
    const original = { type: "input", text: "@explore reopen exact text", source: "interactive" };
    const inputCtx = ctx();
    const before = snapshot(seeded.record);
    const result = await opened.lifecycle.get("input")(original, inputCtx);

    expect(existsSync(sessionFile)).toBe(true);
    expect(result).toEqual({ action: "continue" });
    expect(original).toEqual({ type: "input", text: "@explore reopen exact text", source: "interactive" });
    expect(inputCtx.ui.notify).toHaveBeenCalledWith(message, "warning");
    expect(seeded.manager.listAgents()).toHaveLength(1);
    expect(seeded.manager.listTombstones()).toEqual([entry]);
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
    expect(snapshot(seeded.record)).toEqual(before);
    assertTypedRejection(assertGuard, reasonCode, "mention.input-resume");
  });

  it.each([
    ["compatible", true],
    ["disabled", false],
  ] as const)("reopens the real tombstone exactly once with %s guard state", async (mode, guarded) => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionLive(opened, "Plan", "seed prompt", guarded);
    const sessionFile = join(process.cwd(), "reopen-session.jsonl");
    writeFileSync(sessionFile, "session transcript\n");
    const entry = {
      handle: "explore",
      id: "evicted-agent-id",
      type: "Explore",
      description: "evicted agent",
      sessionFile,
      completedAt: Date.now(),
    };
    (seeded.manager as any).tombstones.set(entry.handle, entry);
    if (mode === "compatible") register(opened.bus, "compatible");
    runnerMocks.runAgent.mockClear();
    const spawn = vi.spyOn(seeded.manager, "spawn");
    runnerMocks.runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, options: any) =>
      new Promise(() => options.onSessionCreated?.(session())),
    );
    const result = await opened.lifecycle.get("input")(
      { type: "input", text: "@explore reopen once", source: "interactive" },
      ctx(),
    );

    expect(result).toEqual({ action: "handled" });
    expect(runnerMocks.runAgent).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][4]).toMatchObject({
      guardEntryPath: "mention.input-resume",
      resumeSessionFile: sessionFile,
    });
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
    expect(seeded.manager.listAgents()).toHaveLength(2);
  });
});

describe("real conversation and fleet viewer steer composers", () => {
  async function openExtensionViewer(boot: ReturnType<typeof bootExtension>, guardExpected = true) {
    const seeded = await startExtensionLive(boot, "general-purpose", "seed prompt", guardExpected);
    const command = boot.commands.get("agents");
    let agentEntryTaken = false;
    let runningSelectionTaken = false;
    let viewer: any;
    const commandCtx = ctx({
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          if (title === "Agents") {
            if (agentEntryTaken) return undefined;
            agentEntryTaken = true;
            return options.find(option => option.startsWith("Running agents ("));
          }
          if (title === "Running agents") {
            if (runningSelectionTaken) return undefined;
            runningSelectionTaken = true;
          }
          return options[0];
        }),
        custom: vi.fn((factory: (...args: any[]) => any) => new Promise(resolve => {
          viewer = factory(
            { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } },
            theme,
            undefined,
            () => resolve(undefined),
          );
        })),
      },
    });
    const commandRun = command.handler("", commandCtx);
    await vi.waitFor(() => expect(viewer).toBeDefined());
    return { seeded, viewer, commandCtx, commandRun };
  }

  it.each([
    ["missing", "guard-missing", "guard-missing: guarded work is unavailable at conversation-viewer.steer; no guard bridge registration is present."],
    ["incompatible", "guard-incompatible-protocol", "guard-incompatible-protocol: guarded work is unavailable at conversation-viewer.steer; expected protocolVersion integer 1, received 999 (typeof number)."],
  ] as const)("notifies exact conversation-viewer rejection on %s registration", async (mode, reasonCode, message) => {
    const opened = bootExtension();
    const { seeded, viewer, commandCtx, commandRun } = await openExtensionViewer(opened);
    register(opened.bus, mode);
    seeded.record.resultConsumed = true;
    const before = snapshot(seeded.record);
    const assertGuard = vi.spyOn(seeded.manager, "assertGuard");
    const steer = vi.spyOn(seeded.manager, "steer");

    viewer.handleInput("\r");
    for (const char of "do not send") viewer.handleInput(char);
    expect(() => viewer.handleInput("\r")).not.toThrow();

    expect(commandCtx.ui.notify).toHaveBeenCalledWith(message, "warning");
    expect(steer).not.toHaveBeenCalled();
    expect(seeded.session.steer).not.toHaveBeenCalled();
    expect(snapshot(seeded.record)).toEqual(before);
    assertTypedRejection(assertGuard, reasonCode, "conversation-viewer.steer");
    viewer.handleInput("q");
    await commandRun;
  });

  it.each([
    ["compatible", true],
    ["disabled", false],
  ] as const)("steers through conversation viewer exactly once with %s guard state", async (mode, guarded) => {
    const opened = bootExtension();
    const { seeded, viewer, commandRun } = await openExtensionViewer(opened, guarded);
    if (mode === "compatible") register(opened.bus, "compatible");
    const steer = vi.spyOn(seeded.manager, "steer");

    viewer.handleInput("\r");
    for (const char of "proceed once") viewer.handleInput(char);
    viewer.handleInput("\r");

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(seeded.id, "proceed once");
    expect(seeded.session.steer).toHaveBeenCalledTimes(1);
    expect(seeded.session.steer).toHaveBeenCalledWith("proceed once");
    viewer.handleInput("q");
    await commandRun;
  });

  it("rethrows non-guard errors from the conversation viewer callback", async () => {
    const openedViewer = bootExtension();
    const { seeded, viewer, commandRun } = await openExtensionViewer(openedViewer);
    vi.spyOn(seeded.manager, "assertGuard").mockImplementation(() => { throw new Error("unexpected viewer guard failure"); });
    viewer.handleInput("\r");
    for (const char of "do not swallow viewer error") viewer.handleInput(char);
    expect(() => viewer.handleInput("\r")).toThrow("unexpected viewer guard failure");
    viewer.handleInput("q");
    await commandRun;
  });

  async function openFleetViewer(manager: AgentManager) {
    let inputHandler: ((data: string) => unknown) | undefined;
    let viewer: any;
    const ui = {
      setWidget: vi.fn(),
      onTerminalInput: vi.fn((handler: (data: string) => unknown) => { inputHandler = handler; return () => { inputHandler = undefined; }; }),
      getEditorText: vi.fn(() => ""),
      notify: vi.fn(),
      custom: vi.fn((factory: (...args: any[]) => any) => new Promise(resolve => {
        viewer = factory(
          { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } },
          theme,
          undefined,
          () => resolve(undefined),
        );
      })),
    };
    const fleet = new FleetList(manager, new Map());
    fleet.setUICtx(ui as any);
    fleet.update();
    inputHandler?.("\x1b[B");
    inputHandler?.("\x1b[B");
    inputHandler?.("\r");
    await vi.waitFor(() => expect(viewer).toBeDefined());
    return { viewer, ui, fleet };
  }

  it.each([
    ["missing", "guard-missing", "guard-missing: guarded work is unavailable at fleet-viewer.steer; no guard bridge registration is present."],
    ["incompatible", "guard-incompatible-protocol", "guard-incompatible-protocol: guarded work is unavailable at fleet-viewer.steer; expected protocolVersion integer 1, received 999 (typeof number)."],
  ] as const)("notifies exact fleet-viewer rejection on %s registration", async (mode, reasonCode, message) => {
    const manager = new AgentManager();
    managers.add(manager);
    const seeded = startManagerLiveAgent(manager, "fleet seed");
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    if (mode === "incompatible") manager.registerGuard(registration(999));
    const assertGuard = vi.spyOn(manager, "assertGuard");
    const steer = vi.spyOn(manager, "steer");
    const { viewer, ui, fleet } = await openFleetViewer(manager);
    const before = snapshot(seeded.record);

    viewer.handleInput("\r");
    for (const char of "do not fleet steer") viewer.handleInput(char);
    expect(() => viewer.handleInput("\r")).not.toThrow();

    expect(ui.notify).toHaveBeenCalledWith(message, "warning");
    expect(steer).not.toHaveBeenCalled();
    expect(seeded.session.steer).not.toHaveBeenCalled();
    expect(snapshot(seeded.record)).toEqual(before);
    assertTypedRejection(assertGuard, reasonCode, "fleet-viewer.steer");
    viewer.handleInput("q");
    fleet.dispose();
  });

  it.each([
    ["compatible", true],
    ["disabled", false],
  ] as const)("steers through fleet viewer exactly once with %s guard state", async (mode, guarded) => {
    const manager = new AgentManager();
    managers.add(manager);
    const seeded = startManagerLiveAgent(manager, "fleet seed");
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(guarded);
    if (mode === "compatible") manager.registerGuard(registration());
    const steer = vi.spyOn(manager, "steer");
    const { viewer, fleet } = await openFleetViewer(manager);

    viewer.handleInput("\r");
    for (const char of "fleet proceed once") viewer.handleInput(char);
    viewer.handleInput("\r");

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(seeded.id, "fleet proceed once");
    expect(seeded.session.steer).toHaveBeenCalledTimes(1);
    expect(seeded.session.steer).toHaveBeenCalledWith("fleet proceed once");
    viewer.handleInput("q");
    fleet.dispose();
  });
});

describe("real workflow-host resume handler", () => {
  async function makeWorkflowResume(guardExpected = true) {
    const manager = new AgentManager();
    managers.add(manager);
    const agentSession = session();
    manager.setGuardExpected(false);
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      options.onSessionCreated?.(agentSession);
      return {
        responseText: "workflow first answer",
        session: agentSession,
        aborted: false,
        steered: false,
        failure: undefined,
      };
    });
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager });
    const spawned = await host.spawnAgent({
      agentId: "workflow-agent-1",
      index: 0,
      prompt: "workflow initial prompt",
      label: "workflow worker",
      agentType: "general-purpose",
    } as any);
    expect(spawned.ok).toBe(true);
    const record = manager.listAgents()[0];
    if (guardExpected) {
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
  }
    runnerMocks.runAgent.mockClear();
    return { manager, host, record, session: agentSession };
  }

  it.each([
    ["missing", "guard-missing"],
    ["incompatible", "guard-incompatible-protocol"],
  ] as const)("rejects workflow-host.resume before any resume side effect (%s)", async (mode, reasonCode) => {
    const state = await makeWorkflowResume();
    if (mode === "incompatible") state.manager.registerGuard(registration(999));
    const before = snapshot(state.record);
    const assertGuard = vi.spyOn(state.manager, "assertGuard");
    const resume = vi.spyOn(state.manager, "resume");

    await expect(state.host.resumeAgent("workflow-agent-1", "workflow follow up")).rejects.toMatchObject({
      name: "GuardBridgeRejection",
      reasonCode,
      entryPath: "workflow-host.resume",
      message: mode === "missing"
        ? "guard-missing: guarded work is unavailable at workflow-host.resume; no guard bridge registration is present."
        : "guard-incompatible-protocol: guarded work is unavailable at workflow-host.resume; expected protocolVersion integer 1, received 999 (typeof number).",
    });
    expect(resume).not.toHaveBeenCalled();
    expect(runnerMocks.resumeAgent).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
    expect(state.session.steer).not.toHaveBeenCalled();
    expect(snapshot(state.record)).toEqual(before);
    assertTypedRejection(assertGuard, reasonCode, "workflow-host.resume");
  });

  it.each([
    ["compatible", true],
    ["disabled", false],
  ] as const)("resumes the workflow-owned record exactly once with %s guard state", async (mode, guarded) => {
    const state = await makeWorkflowResume(guarded);
    if (mode === "compatible") state.manager.registerGuard(registration());
    const resume = vi.spyOn(state.manager, "resume");

    const result = await state.host.resumeAgent("workflow-agent-1", "workflow follow up");

    expect(result).toMatchObject({ ok: true, text: "resumed answer" });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(state.record.id, "workflow follow up", undefined);
    expect(runnerMocks.resumeAgent).toHaveBeenCalledTimes(1);
    expect(state.session.steer).not.toHaveBeenCalled();
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });
});

describe("mention tombstone guard ordering and unrelated errors", () => {
  it.each(["missing-session", "unavailable-agent"] as const)("preserves tombstone state before %s rejection", async (caseName) => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionLive(opened, "Plan", "seed prompt", false);
    seeded.manager.setGuardRegistrant("scope-guard");
    seeded.manager.setGuardExpected(true);
    const sessionFile = join(process.cwd(), "tombstone-session.jsonl");
    if (caseName === "unavailable-agent") writeFileSync(sessionFile, "transcript\n");
    const entry = {
      handle: "explore",
      id: "actual-tombstone-id",
      type: caseName === "unavailable-agent" ? "removed-agent-type" : "Explore",
      description: "tombstone entry",
      sessionFile: caseName === "missing-session" ? join(process.cwd(), "absent-tombstone-session.jsonl") : sessionFile,
      completedAt: Date.now(),
    };
    (seeded.manager as any).tombstones.set(entry.handle, entry);
    runnerMocks.runAgent.mockClear();
    const before = seeded.manager.listTombstones();
    const result = await opened.lifecycle.get("input")(
      { type: "input", text: "@explore preserve this tombstone", source: "interactive" }, ctx(),
    );
    expect(result).toEqual({ action: "continue" });
    expect(seeded.manager.listTombstones()).toEqual(before);
    expect(seeded.manager.listAgents()).toHaveLength(1);
    expect(runnerMocks.runAgent).not.toHaveBeenCalled();
  });

  it("surfaces non-guard errors through the mention catch", async () => {
    const opened = bootExtension({ agentMentions: "direct" });
    const seeded = await startExtensionLive(opened, "Plan", "seed prompt", false);
    const sessionFile = join(process.cwd(), "non-guard-session.jsonl");
    writeFileSync(sessionFile, "transcript\n");
    const tombstone = {
      handle: "explore", id: "non-guard-tombstone", type: "Explore", description: "non-guard failure",
      sessionFile, completedAt: Date.now(),
    };
    (seeded.manager as any).tombstones.set(tombstone.handle, tombstone);
    seeded.manager.setGuardRegistrant("scope-guard");
    seeded.manager.setGuardExpected(true);
    const fault = new Error("unexpected guard host failure");
    vi.spyOn(seeded.manager, "assertGuard").mockImplementation(() => { throw fault; });
    const inputCtx = ctx();
    const result = await opened.lifecycle.get("input")(
      { type: "input", text: "@explore continue", source: "interactive" }, inputCtx,
    );
    expect(result).toEqual({ action: "handled" });
    expect(inputCtx.ui.notify).toHaveBeenCalledWith("Could not resume @explore: unexpected guard host failure", "warning");
    expect(seeded.manager.listTombstones()).toEqual([tombstone]);
  });

});

