import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const runnerMock = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: runnerMock.runAgent };
});

const cryptoSpies = vi.hoisted(() => ({
  createHash: vi.fn(),
  digest: vi.fn(),
}));
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    createHash: cryptoSpies.createHash,
    webcrypto: {
      ...actual.webcrypto,
      subtle: { ...actual.webcrypto.subtle, digest: cryptoSpies.digest },
    },
  };
});

import * as crypto from "node:crypto";
import { AgentManager } from "../src/agent-manager.js";
import {
  GUARD_BRIDGE_PROTOCOL_ADVERTISEMENT,
  GUARD_BRIDGE_PROTOCOL_VERSION,
  GUARD_ENTRY_PATHS,
  GUARD_OUTCOMES,
  type GuardApprovalRequest,
  GuardBridgeHost,
  type GuardBridgeRegistration,
  GuardBridgeRejection,
  type GuardEntryPathId,
  type GuardIngressEvidence,
  getGuardBridgeAdvertisement,
} from "../src/guard-bridge.js";

const ENTRY_PATH_IDS: readonly GuardEntryPathId[] = [
  "agent-manager.spawn",
  "agent-manager.spawn-and-wait",
  "agent-manager.resume",
  "agent-manager.steer",
  "agent-manager.pending-steer",
  "agent-tool.spawn-background",
  "agent-tool.spawn-foreground",
  "agent-tool.resume-background",
  "agent-tool.resume-foreground",
  "agent-tool.steer",
  "nested-agent.spawn-background",
  "nested-agent.spawn-foreground",
  "nested-agent.resume",
  "nested-agent.steer",
  "mention.input-start",
  "mention.input-clone",
  "mention.input-resume",
  "mention.input-steer",
  "cross-extension-rpc.spawn",
  "manager-registry.spawn",
  "scheduled-task.fire",
  "workflow-tool.dispatch",
  "workflow-cli-flag.dispatch",
  "workflow.pi-exec.gate",
  "agents-command.generate-definition",
  "conversation-viewer.steer",
  "fleet-viewer.steer",
  "agent-runner.turn-limit-steer",
  "workflow-host.spawn",
  "workflow-host.resume",
  "agent-tool.schedule-create",
];

const callbacks = {
  captureIngress: vi.fn(),
  enrollResource: vi.fn(),
  createChildContext: vi.fn((context: any) => ({ ...context, bridgeRef: registration })),
  revalidate: vi.fn(() => "allowed" as const),
  approvalSettled: vi.fn(),
  approvalCancelled: vi.fn(),
  approvalExpired: vi.fn(),
};
const registration: GuardBridgeRegistration = { registrant: { id: "scope-guard", version: "1" }, protocolVersion: 1, callbacks };

function rejection(
  host: GuardBridgeHost,
  entryPath: GuardEntryPathId,
  reasonCode: "guard-missing" | "guard-incompatible-protocol" | "guard-wrong-registrant" | "guard-registrant-unconfigured" | "guard-registrant-conflict",
) {
  const result = host.requireGuard(entryPath);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected guard rejection");
  expect(result.rejection).toBeInstanceOf(GuardBridgeRejection);
  expect(result.rejection.name).toBe("GuardBridgeRejection");
  expect(result.rejection.reasonCode).toBe(reasonCode);
  expect(result.rejection.entryPath).toBe(entryPath);
  return result.rejection;
}

describe("versioned guard bridge contract", () => {
  it("advertises the exact protocol and terminal outcome vocabulary", () => {
    expect(GUARD_BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(GUARD_BRIDGE_PROTOCOL_ADVERTISEMENT).toEqual({
      protocol: "pi-subagents.guard-bridge",
      protocolVersion: 1,
      outcomes: ["allowed", "approval-needed", "stopped", "denied", "dismissed", "cancelled", "unavailable", "ui-error"],
    });
    expect(GUARD_OUTCOMES).toEqual(["allowed", "approval-needed", "stopped", "denied", "dismissed", "cancelled", "unavailable", "ui-error"]);
  });

  it("requires an expected registrant before guarded work and rejects malformed or mismatched identities without consuming the slot", () => {
    const unconfigured = new GuardBridgeHost(true);
    for (const entryPath of ENTRY_PATH_IDS) rejection(unconfigured, entryPath, "guard-registrant-unconfigured");
    expect(getGuardBridgeAdvertisement(unconfigured)).toMatchObject({
      guardExpected: true,
      guardRegistrant: null,
      configDiagnostic: expect.stringContaining("guard-registrant-unconfigured"),
    });
    const conflict = new GuardBridgeHost(true);
    conflict.setGuardRegistrantDiagnostic("guard-registrant-conflict: global and project ids differ.");
    rejection(conflict, "agent-manager.spawn", "guard-registrant-conflict");
    expect(getGuardBridgeAdvertisement(conflict)).toMatchObject({
      guardExpected: true,
      guardRegistrant: null,
      configDiagnostic: expect.stringContaining("guard-registrant-conflict"),
    });

    const host = new GuardBridgeHost(true, "scope-guard");
    const wrong = { ...registration, registrant: { id: "unexpected-extension", version: "1" } };
    expect(host.register(wrong)).toMatchObject({ compatible: false, reasonCode: "guard-wrong-registrant" });
    expect(host.getRegistration()).toBeUndefined();
    expect(host.requireGuard("agent-manager.spawn")).toMatchObject({ ok: false, rejection: { reasonCode: "guard-wrong-registrant" } });

    for (const registrant of ["scope-guard", null, { id: 12, version: "1" }, { id: "scope-guard", version: 1 }]) {
      const malformedHost = new GuardBridgeHost(true, "scope-guard");
      expect(malformedHost.register({ ...registration, registrant })).toMatchObject({
        compatible: false,
        reasonCode: "guard-wrong-registrant",
      });
      expect(malformedHost.getRegistration()).toBeUndefined();
    }

    expect(host.register(registration)).toMatchObject({ compatible: true });
    expect(host.getRegistration()).toBe(registration);
    expect(host.requireGuard("agent-manager.spawn")).toEqual({ ok: true, registration });
    expect(host.register({ ...registration })).toMatchObject({
      compatible: false,
      registrationRejected: expect.stringContaining("different registration object"),
    });
  });

  it("reports a non-expected registrant as wrong even after the expected registrant registered", () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    expect(host.register(registration)).toMatchObject({ compatible: true });
    const evil = { ...registration, registrant: { id: "evil", version: "1" } };
    expect(host.register(evil)).toMatchObject({ compatible: false, reasonCode: "guard-wrong-registrant" });
    expect(host.getRegistration()).toBe(registration);
    // The expected id with a different object keeps the duplicate-object rejection.
    expect(host.register({ ...registration })).toMatchObject({ compatible: false, reasonCode: "guard-incompatible-protocol" });
  });

  it("validates the registrant whenever guardRegistrant is configured, even with guardExpected false, and not otherwise", () => {
    const configured = new GuardBridgeHost(false, "scope-guard");
    const evil = { ...registration, registrant: { id: "evil", version: "1" } };
    expect(configured.register(evil)).toMatchObject({ compatible: false, reasonCode: "guard-wrong-registrant" });
    expect(configured.getRegistration()).toBeUndefined();
    expect(configured.register(registration)).toMatchObject({ compatible: true });
    expect(configured.requireGuard("agent-manager.spawn")).toEqual({ ok: true, registration });

    // Never opted in: no identity check, upstream behavior (guard off, no registrant configured).
    const unconfigured = new GuardBridgeHost(false);
    expect(unconfigured.register(evil)).toMatchObject({ compatible: true });
    expect(unconfigured.requireGuard("agent-manager.spawn")).toEqual({ ok: true, registration: evil });
  });


  it("keeps the registration by reference, re-registers idempotently, and adds no global state", () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    const beforeNames = Object.getOwnPropertyNames(globalThis);
    const beforeSymbols = Object.getOwnPropertySymbols(globalThis);
    const first = host.register(registration);
    const retained = host.getRegistration();
    const second = host.register(registration);

    expect(first).toEqual({ compatible: true });
    expect(second).toEqual({ compatible: true });
    expect(retained).toBe(registration);
    expect(host.getRegistration()).toBe(registration);
    expect(Object.getOwnPropertyNames(globalThis)).toEqual(beforeNames);
    expect(Object.getOwnPropertySymbols(globalThis)).toEqual(beforeSymbols);
    expect(Object.getOwnPropertyNames(host)).toEqual(["expected", "registration", "registrationSnapshot", "registrationRejected", "registrationRejectedReasonCode", "registrationRejectionHistory", "guardExpectedDiagnostic", "guardRegistrant", "guardRegistrantDiagnostic"]);
    expect(Object.getOwnPropertyNames(registration)).toEqual(["registrant", "protocolVersion", "callbacks"]);
    expect(JSON.stringify(host)).not.toContain("identical prompt");
  });

  it("keeps registration rejection history bounded", () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    for (let index = 0; index < 12; index++) host.rejectRegistration(`diagnostic-${index}`);
    expect(host.getRegistrationRejected()).toBe("diagnostic-11");
    expect(host.getRegistrationRejectionHistory()).toEqual(Array.from({ length: 10 }, (_, index) => `diagnostic-${index + 2}`));
  });


  it("exposes ingress coverage and approval lifetime bindings in v1 contract shapes", () => {
    const ingress: GuardIngressEvidence = {
      ingressId: "ingress-1",
      rawText: "raw human request",
      transformedText: "rewritten mention request",
      coverage: "partial",
      target: "explore",
      origin: "human",
      entryPath: "mention.input-start",
    };
    expect(ingress).toMatchObject({
      rawText: "raw human request",
      transformedText: "rewritten mention request",
      coverage: "partial",
    });

    const approval: GuardApprovalRequest = {
      requestId: "approval-1",
      rootId: "root-1",
      taskId: "task-1",
      childId: "child-1",
      inputGeneration: 4,
      decisionRevision: 7,
      executionEpoch: 2,
      lifetimeToken: "opaque-lifetime-token",
      action: "write file",
      targets: ["src/file.ts"],
      authorityGap: "outside current grant",
      evidenceRefs: ["evidence-1"],
      deadline: 123,
    };
    expect(approval).toMatchObject({
      rootId: "root-1",
      taskId: "task-1",
      childId: "child-1",
      inputGeneration: 4,
      decisionRevision: 7,
      executionEpoch: 2,
      lifetimeToken: "opaque-lifetime-token",
    });
  });


  it("requires exact compatible registration at every inventoried entry id", () => {
    expect(GUARD_ENTRY_PATHS.map(({ id }) => id)).toEqual(ENTRY_PATH_IDS);

    for (const entryPath of ENTRY_PATH_IDS) {
      rejection(new GuardBridgeHost(true, "scope-guard"), entryPath, "guard-missing");

      const incompatible = new GuardBridgeHost(true, "scope-guard");
      const incompatibleRegistration = { ...registration, protocolVersion: 999 };
      expect(incompatible.register(incompatibleRegistration)).toMatchObject({ compatible: false });
      rejection(incompatible, entryPath, "guard-incompatible-protocol");

      const compatible = new GuardBridgeHost(true, "scope-guard");
      compatible.register(registration);
      expect(compatible.requireGuard(entryPath)).toEqual({ ok: true, registration });

      const defaultHost = new GuardBridgeHost();
      expect(defaultHost.guardExpected).toBe(false);
      expect(defaultHost.requireGuard(entryPath)).toEqual({ ok: true });
    }
  });

  it("drives identical canary prompts through two real manager paths without prompt association", async () => {
    const manager = new AgentManager();
    const host = manager.guardBridgeHost;
    manager.setGuardRegistrant("scope-guard");
    manager.setGuardExpected(true);
    manager.registerGuard(registration);
    const canary = "guard-bridge-prompt-canary-7f3e";
    runnerMock.runAgent.mockResolvedValue({
      responseText: "done",
      session: {},
      aborted: false,
      steered: false,
    });
    const containsCanary = (root: unknown): boolean => {
      const seen = new Set<object>();
      const visit = (value: unknown): boolean => {
        if (typeof value === "string") return value.includes(canary);
        if (value === null || typeof value !== "object" || seen.has(value)) return false;
        seen.add(value);
        if (value instanceof Map) {
          for (const [key, entry] of value) if (visit(key) || visit(entry)) return true;
        }
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key === "string" && key.includes(canary)) return true;
          if (visit((value as Record<PropertyKey, unknown>)[key])) return true;
        }
        return false;
      };
      return visit(root);
    };
    try {
      manager.spawn({} as any, {} as any, "general-purpose", canary, {
        description: "first route",
        guardEntryPath: "agent-manager.spawn",
      });
      await manager.spawnAndWait({} as any, {} as any, "general-purpose", canary, {
        description: "second route",
        guardEntryPath: "agent-manager.spawn-and-wait",
      });
      expect(runnerMock.runAgent).toHaveBeenCalledTimes(2);
      expect(crypto.createHash).not.toHaveBeenCalled();
      expect(crypto.webcrypto.subtle.digest).not.toHaveBeenCalled();
      for (const object of [host, manager, registration]) expect(containsCanary(object)).toBe(false);
    } finally {
      manager.dispose();
      runnerMock.runAgent.mockReset();
    }
  });

  it("rechecks registration when queued spawns and resumes drain", async () => {
    const manager = new AgentManager(undefined, 1);
    runnerMock.runAgent.mockReset();
    const session = {
      sessionManager: { getSessionFile: vi.fn(() => undefined) },
      dispose: vi.fn(),
    };
    try {
      runnerMock.runAgent.mockImplementationOnce(async (_ctx: any, _type: string, _prompt: string, options: any) => {
        options.onSessionCreated?.(session);
        return { responseText: "first complete", session, aborted: false, steered: false };
      });
      const firstId = manager.spawn({} as any, {} as any, "general-purpose", "first", {
        description: "first",
        isBackground: true,
      });
      await manager.getRecord(firstId)!.promise;

      runnerMock.runAgent.mockImplementation(() => new Promise(() => {}));
      manager.spawn({} as any, {} as any, "general-purpose", "blocker", {
        description: "blocker",
        isBackground: true,
      });
      await vi.waitFor(() => expect(runnerMock.runAgent).toHaveBeenCalledTimes(2));

      manager.setGuardRegistrant("scope-guard");
      manager.setGuardExpected(true);
      manager.registerGuard(registration);
      const queuedSpawnId = manager.spawn({} as any, {} as any, "general-purpose", "queued spawn", {
        description: "queued spawn",
        isBackground: true,
        guardEntryPath: "agent-manager.spawn",
      });
      expect(manager.getRecord(queuedSpawnId)?.status).toBe("queued");
      manager.unregisterGuard();
      manager.setMaxConcurrent(2);
      await vi.waitFor(() => expect(manager.getRecord(queuedSpawnId)?.status).toBe("error"));
      expect(manager.getRecord(queuedSpawnId)?.error).toBe(
        "guard-missing: guarded work is unavailable at agent-manager.spawn; no guard bridge registration is present.",
      );
      expect(runnerMock.runAgent).toHaveBeenCalledTimes(2);

      manager.setMaxConcurrent(1);
      manager.registerGuard(registration);
      const firstRecord = manager.getRecord(firstId)!;
      const queuedResume = await manager.resume(firstId, "queued resume", undefined, {
        isBackground: true,
        guardEntryPath: "agent-manager.resume",
      });
      expect(queuedResume).toBe(firstRecord);
      expect(firstRecord.status).toBe("queued");
      const startedAtBeforeDrain = firstRecord.startedAt;
      manager.unregisterGuard();
      manager.setMaxConcurrent(2);
      await vi.waitFor(() => expect(firstRecord.status).toBe("error"));
      expect(firstRecord.error).toBe(
        "guard-missing: guarded work is unavailable at agent-manager.resume; no guard bridge registration is present.",
      );
      expect(firstRecord.startedAt).toBe(startedAtBeforeDrain);
      expect(runnerMock.runAgent).toHaveBeenCalledTimes(2);
    } finally {
      await manager.dispose();
      runnerMock.runAgent.mockReset();
    }
  });


  it("validates registrations, rejects replacement, and supports explicit unregister", () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    const original = registration;
    expect(host.register(original).compatible).toBe(true);
    expect(host.register(original).compatible).toBe(true);
    const replacement = { ...registration };
    expect(host.register(replacement)).toMatchObject({
      compatible: false,
      registrationRejected: "a different registration object was rejected; the first registration remains active.",
    });
    expect(host.getRegistration()).toBe(original);
    expect(host.getRegistrationRejected()).toContain("different registration object");
    expect(host.register(original)).toEqual({ compatible: true });
    expect(host.getRegistrationRejected()).toBeUndefined();
    expect(getGuardBridgeAdvertisement(host)).not.toHaveProperty("registrationRejected");
    expect(getGuardBridgeAdvertisement(host)).toMatchObject({ registrationRejectionHistory: [expect.stringContaining("different registration object")] });
    host.setGuardExpected(true);
    host.setGuardExpected(false);
    expect(host.guardExpected).toBe(true);

    host.unregister();
    expect(host.getRegistration()).toBeUndefined();
    expect(host.getRegistrationRejected()).toBeUndefined();
    expect(host.register(replacement).compatible).toBe(true);
    expect(host.getRegistration()).toBe(replacement);
  });

  it("rejects nullish and malformed registrations with precise diagnostics", () => {
    for (const value of [null, undefined]) {
      const host = new GuardBridgeHost(true, "scope-guard");
      expect(() => host.register(value)).not.toThrow();
      expect(host.register(value).registrationRejected).toContain(value === null ? "received null" : "received undefined");
      const result = host.requireGuard("agent-manager.spawn");
      expect(result).toMatchObject({ ok: false, rejection: { reasonCode: "guard-incompatible-protocol" } });
    }

    const stringVersionHost = new GuardBridgeHost(true, "scope-guard");
    const stringVersion = { ...registration, protocolVersion: "1" };
    const diagnostic = stringVersionHost.register(stringVersion).registrationRejected;
    expect(diagnostic).toContain("typeof string");
    expect(stringVersionHost.requireGuard("agent-manager.spawn")).toMatchObject({
      ok: false,
      rejection: { reasonCode: "guard-incompatible-protocol", message: expect.stringContaining("typeof string") },
    });

    for (const callbackName of ["captureIngress", "enrollResource", "createChildContext", "revalidate", "approvalSettled", "approvalCancelled", "approvalExpired"] as const) {
      const host = new GuardBridgeHost(true, "scope-guard");
      const malformed = { ...registration, callbacks: { ...callbacks, [callbackName]: undefined } };
      expect(host.register(malformed).registrationRejected).toContain(`callbacks.${callbackName} must be a function`);
    }
  });
  it("snapshots registration properties safely and retains the original identity", () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    let versionReads = 0;
    const onceGetter = Object.defineProperties({ registrant: { id: "scope-guard", version: "1" } }, {
      protocolVersion: { get: () => { versionReads++; if (versionReads > 1) throw new Error("second read"); return 1; } },
      callbacks: { value: callbacks, enumerable: true },
    });
    expect(host.register(onceGetter).compatible).toBe(true);
    expect(host.register(onceGetter)).toEqual({ compatible: true });
    expect(versionReads).toBe(1);
    expect(host.requireGuard("agent-manager.spawn")).toEqual({ ok: true, registration: onceGetter });

    const mutable = { registrant: { id: "scope-guard", version: "1" }, protocolVersion: 1, callbacks: { ...callbacks } };
    const secondHost = new GuardBridgeHost(true, "scope-guard");
    expect(secondHost.register(mutable).compatible).toBe(true);
    mutable.callbacks.captureIngress = "not a callback" as any;
    expect(secondHost.requireGuard("agent-manager.spawn")).toEqual({ ok: true, registration: mutable });

    const frozen = Object.freeze({ registrant: { id: "scope-guard", version: "1" }, protocolVersion: 1, callbacks: Object.freeze({ ...callbacks }) });
    expect(new GuardBridgeHost(true, "scope-guard").register(frozen).compatible).toBe(true);
  });

  it("turns throwing getters and Proxy traps into compatible-protocol diagnostics", () => {
    const throwingGetter = Object.defineProperty({ registrant: { id: "scope-guard", version: "1" }, callbacks }, "protocolVersion", {
      get: () => { throw new Error("getter exploded"); },
    });
    const getterHost = new GuardBridgeHost(true, "scope-guard");
    expect(() => getterHost.register(throwingGetter)).not.toThrow();
    expect(getterHost.register(throwingGetter).registrationRejected).toContain("getter exploded");
    expect(getterHost.requireGuard("agent-manager.spawn")).toMatchObject({
      ok: false,
      rejection: { reasonCode: "guard-incompatible-protocol", message: expect.stringContaining("getter exploded") },
    });

    const proxyHost = new GuardBridgeHost(true, "scope-guard");
    const throwingProxy = new Proxy({}, { get: () => { throw new Error("proxy exploded"); } });
    expect(() => proxyHost.register(throwingProxy)).not.toThrow();
    expect(proxyHost.register(throwingProxy).registrationRejected).toContain("proxy exploded");
    expect(proxyHost.requireGuard("agent-manager.spawn")).toMatchObject({
      ok: false,
      rejection: { reasonCode: "guard-incompatible-protocol", message: expect.stringContaining("proxy exploded") },
    });
  });

  it("does not inspect a registration again on the guard-off hot path", () => {
    const host = new GuardBridgeHost(false);
    let reads = 0;
    const proxy = new Proxy({}, { get: () => { reads++; throw new Error("must not inspect on require"); } });
    expect(host.register(proxy).compatible).toBe(false);
    const afterRegister = reads;
    expect(host.requireGuard("agent-manager.spawn")).toEqual({ ok: true });
    expect(reads).toBe(afterRegister);
  });



  it("does not forward an incompatible registration when the guard is optional", () => {
    const manager = new AgentManager();
    runnerMock.runAgent.mockImplementation(() => new Promise(() => {}));
    const incompatible: GuardBridgeRegistration = { ...registration, protocolVersion: 999 };
    try {
      manager.registerGuard(incompatible);
      const id = manager.spawn({} as any, {} as any, "general-purpose", "optional guard", { description: "optional" });
      expect(manager.getRecord(id)).toBeDefined();
      expect(runnerMock.runAgent.mock.calls.at(-1)![3]).not.toHaveProperty("guardBridgeRegistration");
    } finally {
      manager.dispose();
      runnerMock.runAgent.mockReset();
    }
  });

  it("does not hash or consult process-global state while gating", () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    for (const entryPath of ENTRY_PATH_IDS) {
      host.requireGuard(entryPath);
    }
    host.register(registration);
    for (const entryPath of ENTRY_PATH_IDS) {
      host.requireGuard(entryPath);
    }
    expect(crypto.createHash).not.toHaveBeenCalled();
    expect(crypto.webcrypto.subtle.digest).not.toHaveBeenCalled();
  });

  it("keeps every changed production file free of newly introduced hash/global mechanisms", () => {
    const files = [
      "src/guard-bridge.ts", "src/agent-manager.ts", "src/agent-runner.ts", "src/index.ts",
      "src/nested-tools.ts", "src/schedule.ts", "src/workflow/host.ts", "src/cross-extension-rpc.ts", "src/ui/fleet-list.ts",
    ];
    // These exact existing registry references predate the bridge; count checks
    // detect additions without consulting git diff or broadening their allowlist.
    const existing = new Map([["src/index.ts", { globalThis: 4, symbolFor: 3 }]]);
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      if (file === "src/agent-runner.ts") {
        expect(source.match(/createHash/g) ?? [], `${file} createHash`).toHaveLength(2);
        expect(source).toMatch(/createHash\("sha256"\)\.update\(text, "utf8"\)\.digest\("hex"\)/);
      } else {
        expect(source.match(/createHash/g) ?? [], `${file} createHash`).toHaveLength(0);
      }
      expect(source.match(/crypto\.subtle/g) ?? [], `${file} crypto.subtle`).toHaveLength(0);
      const allowed = existing.get(file);
      expect(source.match(/globalThis/g) ?? [], `${file} globalThis`).toHaveLength(allowed?.globalThis ?? 0);
      expect(source.match(/Symbol\.for/g) ?? [], `${file} Symbol.for`).toHaveLength(allowed?.symbolFor ?? 0);
    }
  });

  it("declares real function owners and keeps the docs table in sync with the inventory", () => {
    const functionNames = (source: string, file: string): Set<string> => {
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const names = new Set<string>();
      const visit = (node: ts.Node) => {
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) names.add(node.name.getText(ast));
        if (ts.isPropertyAssignment(node) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          names.add(node.name.getText(ast).replace(/^['"]|['"]$/g, ""));
        }
        if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          names.add(node.name.getText(ast));
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      return names;
    };
    for (const { id, sourceLocations } of GUARD_ENTRY_PATHS) {
      expect(sourceLocations.length, `${id} must declare a source location`).toBeGreaterThan(0);
      for (const location of sourceLocations) {
        const match = /^(src\/[^:]+\.ts): (.+)$/.exec(location);
        expect(match, `${id} has malformed source location ${location}`).not.toBeNull();
        const [, file, owner] = match!;
        const source = readFileSync(join(process.cwd(), file), "utf8");
        expect(source.length, `${id} references missing source file ${file}`).toBeGreaterThan(0);
        if (owner.startsWith("input event handler")) {
          expect(source).toMatch(/\.on\("input",\s*async \(event, ctx\)/);
          continue;
        }
        const ownerName = owner.includes(".")
          ? owner.slice(owner.lastIndexOf(".") + 1).split(/\s|\(/)[0]
          : owner.split(/\s|\(/)[0];
        expect(functionNames(source, file), `${id} owner ${ownerName} must name an actual function in ${file}`).toContain(ownerName);
      }
    }

    const doc = readFileSync(join(process.cwd(), "docs/guard-bridge.md"), "utf8");
    const table = doc.split("## Supported entry-path inventory")[1]?.split("### Ingress capture ownership")[0] ?? "";
    const documentedIds = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
    expect(new Set(documentedIds)).toEqual(new Set(GUARD_ENTRY_PATHS.map(({ id }) => id)));
    expect(documentedIds).toHaveLength(GUARD_ENTRY_PATHS.length);
  });

  it("scans every production agent-work callsite, not just whether each file is covered", () => {
    const expectedCounts: Record<string, Record<string, number>> = {
      "src/agent-manager.ts": { runAgent: 1, steer: 2, spawn: 1, resumeAgent: 2 },
      "src/agent-runner.ts": { createAgentSession: 1, steer: 3, prompt: 3 },
      "src/index.ts": { spawn: 2, steer: 3, runMentionClone: 1, resume: 2, spawnAndWait: 2, steerAgent: 1, runWorkflow: 1, runWorkflowTask: 2 },
      "src/nested-tools.ts": { resume: 1, spawn: 1, spawnAndWait: 1, steer: 1 },

      "src/schedule.ts": { spawn: 1 },
      "src/cross-extension-rpc.ts": { spawn: 1 },
      "src/workflow/host.ts": { exec: 1, spawnAndWait: 1, resume: 1 },
      "src/workflow/runtime.ts": { resumeAgent: 1 },
      "src/mention-clone.ts": { createAgentSession: 1, prompt: 1 },
      "src/ui/fleet-list.ts": { steer: 2 },
    };
    const sourceRoot = join(process.cwd(), "src");
    const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const fullPath = join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(fullPath) : entry.name.endsWith(".ts") ? [fullPath] : [];
    });
    const knownNonWork = new Set(["src/env.ts", "src/worktree.ts", "src/workflow/task.ts"]);
    const files = sourceFiles(sourceRoot).map(file => file.slice(process.cwd().length + 1)).sort();
    const scanNames = new Set(["spawn", "spawnAndWait", "resume", "steer", "runAgent", "resumeAgent", "steerAgent", "runMentionClone", "runWorkflow", "runWorkflowTask", "exec", "prompt", "createAgentSession", "sendUserMessage", "followUp"]);
    for (const file of files) {
      if (knownNonWork.has(file)) continue;
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const actual: Record<string, number> = {};
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const expression = node.expression;
          const name = ts.isPropertyAccessExpression(expression)
            ? expression.name.text
            : ts.isIdentifier(expression) ? expression.text : "";
          const isAgentExec = name !== "exec" || (ts.isPropertyAccessExpression(expression) && expression.expression.getText(ast) === "pi");
          if (scanNames.has(name) && isAgentExec) actual[name] = (actual[name] ?? 0) + 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(actual, `${file} agent-work callsites must all remain inventoried`).toEqual(expectedCounts[file] ?? {});
    }
  });
});
