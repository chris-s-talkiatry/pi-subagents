import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardBridgeRegistration } from "../src/guard-bridge.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const managerKey = Symbol.for("pi-subagents:manager");

type EventBus = {
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
};

function eventBus(): EventBus {
  const listeners = new Map<string, Set<(value: any) => unknown>>();
  return {
    on: vi.fn((event: string, handler: (value: any) => unknown) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(handler);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(handler);
    }),
    emit: vi.fn((event: string, value: any) => {
      for (const listener of listeners.get(event) ?? []) void listener(value);
    }),
  };
}

function registration(): GuardBridgeRegistration {
  let value!: GuardBridgeRegistration;
  value = {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "test" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource: vi.fn(),
      createChildContext: vi.fn(request => ({
        rootId: "root",
        parentId: request.parentId,
        childId: request.childId,
        delegationId: request.delegationId,
        taskId: "task",
        scopeRevision: 0,
        executionEpoch: 0,
        resolvedRestrictions: [],
        origin: request.origin,
        bridgeRef: value,
      })),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
    },
  };
  return value;
}

let hermetic: Hermetic | undefined;
let lifecycle: Map<string, any> | undefined;
let previousManager: unknown;

function bootExtension(guardExpected: boolean) {
  hermetic = hermeticDir({ settings: {
    outputTranscript: false,
    schedulingEnabled: false,
    guardExpected,
    guardRegistrant: "scope-guard",
  } });
  previousManager = (globalThis as any)[managerKey];
  const booted = makePi();
  const bus = eventBus();
  booted.pi.events = bus;
  subagentsExtension(booted.pi);
  lifecycle = booted.lifecycle;
  return { bus, manager: (globalThis as any)[managerKey] };
}

beforeEach(() => {
  lifecycle = undefined;
});

afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  if (previousManager === undefined) delete (globalThis as any)[managerKey];
  else (globalThis as any)[managerKey] = previousManager;
  previousManager = undefined;
  lifecycle = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

describe("registration-driven readiness recovery", () => {
  it("advertises one clean ready after a wrong-registrant rejection is cleared, without a ready loop", async () => {
    const { bus } = bootExtension(true);
    const advertisements: any[] = [];
    let reRegisterFromCleanReady = false;
    const guardRegistration = registration();
    bus.on("subagents:ready", (event: any) => {
      advertisements.push(event.guardBridge);
      if (reRegisterFromCleanReady && !("registrationRejected" in event.guardBridge)) {
        bus.emit("subagents:guard:register", guardRegistration);
      }
    });

    await lifecycle!.get("session_start")({}, ctx());
    bus.emit("subagents:guard:register", guardRegistration);
    expect(advertisements).toHaveLength(1);

    bus.emit("subagents:guard:register", {
      ...guardRegistration,
      registrant: { id: "other-extension", version: "test" },
    });
    expect(advertisements).toHaveLength(2);
    expect(advertisements[1].registrationRejected).toContain('received "other-extension"');

    reRegisterFromCleanReady = true;
    bus.emit("subagents:guard:register", guardRegistration);

    expect(advertisements).toHaveLength(3);
    expect(advertisements[2]).not.toHaveProperty("registrationRejected");
    expect(advertisements[2].registrationRejectionHistory).toEqual([
      expect.stringContaining('received "other-extension"'),
    ]);
  });

  it("bounds rejection and recovery re-emissions together to three per session", async () => {
    const { bus } = bootExtension(true);
    const advertisements: any[] = [];
    const guardRegistration = registration();
    bus.on("subagents:ready", (event: any) => advertisements.push(event.guardBridge));
    await lifecycle!.get("session_start")({}, ctx());
    bus.emit("subagents:guard:register", guardRegistration);

    bus.emit("subagents:guard:register", {
      ...guardRegistration,
      registrant: { id: "wrong-one", version: "test" },
    });
    bus.emit("subagents:guard:register", guardRegistration);
    expect(advertisements).toHaveLength(3); // initial + rejection + clean recovery

    bus.emit("subagents:guard:register", {
      ...guardRegistration,
      registrant: { id: "wrong-two", version: "test" },
    });
    expect(advertisements).toHaveLength(4); // the third permitted re-emission
    expect(advertisements[3].registrationRejected).toContain('received "wrong-two"');

    bus.emit("subagents:guard:register", guardRegistration);
    expect(advertisements).toHaveLength(4); // recovery is suppressed after the shared cap
  });

  it("does not add readiness for successful guard-off registration or rejection recovery", async () => {
    const { bus } = bootExtension(false);
    const advertisements: any[] = [];
    const guardRegistration = registration();
    bus.on("subagents:ready", (event: any) => advertisements.push(event.guardBridge));
    await lifecycle!.get("session_start")({}, ctx());
    bus.emit("subagents:guard:register", guardRegistration);
    bus.emit("subagents:guard:register", guardRegistration);
    expect(advertisements).toHaveLength(1);

    bus.emit("subagents:guard:register", {
      ...guardRegistration,
      registrant: { id: "wrong-optional-guard", version: "test" },
    });
    expect(advertisements).toHaveLength(2); // pre-existing rejection notification
    expect(advertisements[1].registrationRejected).toBeDefined();

    bus.emit("subagents:guard:register", guardRegistration);
    expect(advertisements).toHaveLength(2); // guard-off recovery adds no event
  });
});
