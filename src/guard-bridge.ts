import { randomUUID } from "node:crypto";


/**
 * Versioned, in-process contract between pi-subagents and an optional scope guard.
 * This module intentionally has no process-global registry and no prompt-derived IDs.
 */
export const GUARD_BRIDGE_PROTOCOL_VERSION = 1;

export const GUARD_OUTCOMES = Object.freeze([
  "allowed",
  "approval-needed",
  "stopped",
  "denied",
  "dismissed",
  "cancelled",
  "unavailable",
  "ui-error",
] as const);

export type GuardOutcome = (typeof GUARD_OUTCOMES)[number];
export type GuardOrigin =
  | "human"
  | "parent-model-delegation"
  | "extension-request"
  | "package-system-control"
  | "imported-context"
  | "tool-observation";

export const GUARD_BRIDGE_PROTOCOL_ADVERTISEMENT = Object.freeze({
  protocol: "pi-subagents.guard-bridge",
  protocolVersion: GUARD_BRIDGE_PROTOCOL_VERSION,
  outcomes: GUARD_OUTCOMES,
});

/** Include registration and configuration diagnostics only when present. */
export function getGuardBridgeAdvertisement(
  host?: Pick<GuardBridgeHost, "guardExpected" | "getGuardRegistrant" | "getConfigDiagnostic" | "getRegistrationRejected" | "getRegistrationRejectionHistory" | "getGuardExpectedDiagnostic" | "getGuardRegistrantDiagnostic" | "getIngressCaptureFailureCount" | "getIngressCaptureFailures">,
) {
  if (!host) return GUARD_BRIDGE_PROTOCOL_ADVERTISEMENT;
  const registrationRejected = host.getRegistrationRejected();
  const registrationRejectionHistory = host.getRegistrationRejectionHistory();
  const guardExpectedDiagnostic = host.getGuardExpectedDiagnostic();
  const guardRegistrantDiagnostic = host.getGuardRegistrantDiagnostic();
  const ingressCaptureFailureCount = host.getIngressCaptureFailureCount();
  const ingressCaptureFailures = host.getIngressCaptureFailures();

  return {
    ...GUARD_BRIDGE_PROTOCOL_ADVERTISEMENT,
    guardExpected: host.guardExpected,
    guardRegistrant: host.getGuardRegistrant() ?? null,
    configDiagnostic: host.getConfigDiagnostic() ?? null,
    ...(registrationRejected !== undefined ? { registrationRejected } : {}),
    ...(registrationRejectionHistory.length > 0 ? { registrationRejectionHistory } : {}),
    ...(guardExpectedDiagnostic !== undefined ? { guardExpectedDiagnostic } : {}),
    ...(guardRegistrantDiagnostic !== undefined ? { guardRegistrantDiagnostic } : {}),
    ...(ingressCaptureFailureCount > 0 ? { ingressCaptureFailureCount, ingressCaptureFailures } : {}),

  };
}

export type GuardEntryPathId =
  | "agent-manager.spawn"
  | "agent-manager.spawn-and-wait"
  | "agent-manager.resume"
  | "agent-manager.steer"
  | "agent-manager.pending-steer"
  | "agent-tool.spawn-background"
  | "agent-tool.spawn-foreground"
  | "agent-tool.resume-background"
  | "agent-tool.resume-foreground"
  | "agent-tool.steer"
  | "nested-agent.spawn-background"
  | "nested-agent.spawn-foreground"
  | "nested-agent.resume"
  | "nested-agent.steer"
  | "mention.input-start"
  | "mention.input-clone"
  | "mention.input-resume"
  | "mention.input-steer"
  | "cross-extension-rpc.spawn"
  | "manager-registry.spawn"
  | "scheduled-task.fire"
  | "workflow-tool.dispatch"
  | "workflow-cli-flag.dispatch"
  | "workflow.pi-exec.gate"
  | "agents-command.generate-definition"
  | "conversation-viewer.steer"
  | "fleet-viewer.steer"
  | "agent-runner.turn-limit-steer"
  | "workflow-host.spawn"
  | "workflow-host.resume"
  | "agent-tool.schedule-create";

export interface GuardEntryPathDescriptor {
  id: GuardEntryPathId;
  operation: "spawn" | "resume" | "steer" | "dispatch";
  /** Source file and owning function; each concrete callsite is listed. */
  sourceLocations: readonly string[];
}

/** Maintained inventory of the fork's supported child/agent work entry paths. */
export const GUARD_ENTRY_PATHS: readonly GuardEntryPathDescriptor[] = [
  { id: "agent-manager.spawn", operation: "spawn", sourceLocations: ["src/agent-manager.ts: AgentManager.spawn", "src/agent-manager.ts: AgentManager.startAgent"] },
  { id: "agent-manager.spawn-and-wait", operation: "spawn", sourceLocations: ["src/agent-manager.ts: AgentManager.spawnAndWait"] },
  { id: "agent-manager.resume", operation: "resume", sourceLocations: ["src/agent-manager.ts: AgentManager.resume", "src/agent-manager.ts: AgentManager.startResume"] },
  { id: "agent-manager.steer", operation: "steer", sourceLocations: ["src/agent-manager.ts: AgentManager.steer"] },
  { id: "agent-manager.pending-steer", operation: "steer", sourceLocations: ["src/agent-manager.ts: AgentManager.startAgent onSessionCreated"] },
  { id: "agent-tool.spawn-background", operation: "spawn", sourceLocations: ["src/index.ts: Agent.execute background branch"] },
  { id: "agent-tool.spawn-foreground", operation: "spawn", sourceLocations: ["src/index.ts: Agent.execute foreground branch"] },
  { id: "agent-tool.resume-background", operation: "resume", sourceLocations: ["src/index.ts: Agent.execute background resume branch"] },
  { id: "agent-tool.resume-foreground", operation: "resume", sourceLocations: ["src/index.ts: Agent.execute foreground resume branch"] },
  { id: "agent-tool.steer", operation: "steer", sourceLocations: ["src/index.ts: steer_subagent.execute", "src/agent-runner.ts: steerAgent"] },
  { id: "nested-agent.spawn-background", operation: "spawn", sourceLocations: ["src/nested-tools.ts: Agent.execute background branch"] },
  { id: "nested-agent.spawn-foreground", operation: "spawn", sourceLocations: ["src/nested-tools.ts: Agent.execute foreground branch"] },
  { id: "nested-agent.resume", operation: "resume", sourceLocations: ["src/nested-tools.ts: Agent.execute resume branch"] },
  { id: "nested-agent.steer", operation: "steer", sourceLocations: ["src/nested-tools.ts: steerTool.execute"] },
  { id: "mention.input-start", operation: "spawn", sourceLocations: ["src/index.ts: input event handler (direct and clone-fallback branches)"] },
  { id: "mention.input-clone", operation: "dispatch", sourceLocations: ["src/index.ts: input event handler (clone branch)", "src/mention-clone.ts: runMentionClone"] },
  { id: "mention.input-resume", operation: "resume", sourceLocations: ["src/index.ts: input event handler (live and tombstone resume branches)"] },
  { id: "mention.input-steer", operation: "steer", sourceLocations: ["src/index.ts: input event handler (live steer branch)"] },
  { id: "cross-extension-rpc.spawn", operation: "spawn", sourceLocations: ["src/cross-extension-rpc.ts: registerRpcHandlers spawn handler"] },
  { id: "manager-registry.spawn", operation: "spawn", sourceLocations: ["src/index.ts: registryEntry.spawn", "src/index.ts: spawnResolved"] },
  { id: "scheduled-task.fire", operation: "spawn", sourceLocations: ["src/schedule.ts: SubagentScheduler.executeJob"] },
  { id: "workflow-tool.dispatch", operation: "dispatch", sourceLocations: ["src/index.ts: SubagentWorkflow.execute"] },
  { id: "workflow-cli-flag.dispatch", operation: "dispatch", sourceLocations: ["src/index.ts: runWorkflowFlag"] },
  { id: "workflow.pi-exec.gate", operation: "dispatch", sourceLocations: ["src/workflow/host.ts: executeGate"] },
  { id: "agents-command.generate-definition", operation: "spawn", sourceLocations: ["src/index.ts: showGenerateWizard"] },
  { id: "conversation-viewer.steer", operation: "steer", sourceLocations: ["src/index.ts: viewAgentConversation"] },
  { id: "fleet-viewer.steer", operation: "steer", sourceLocations: ["src/ui/fleet-list.ts: FleetList.openSelected"] },
  { id: "agent-runner.turn-limit-steer", operation: "steer", sourceLocations: ["src/agent-runner.ts: runAgent turn_end handler"] },
  { id: "workflow-host.spawn", operation: "spawn", sourceLocations: ["src/workflow/host.ts: spawnAgent"] },
  { id: "workflow-host.resume", operation: "resume", sourceLocations: ["src/workflow/host.ts: resumeAgent", "src/workflow/runtime.ts: runWorkflow.handleAgent"] },
  { id: "agent-tool.schedule-create", operation: "dispatch", sourceLocations: ["src/index.ts: Agent.execute schedule branch"] },
] as const;


export type GuardEntryIngressDisposition =
  | { kind: "captures-ingress-here" }
  | { kind: "captured-at-outer-path"; outerPaths: readonly string[] }
  | { kind: "no-text-input"; task: "5.x" };

/** Each guarded work boundary is either an ingress owner, an inner boundary, or task-5.x work. */
export const GUARD_ENTRY_INGRESS: Readonly<Record<GuardEntryPathId, GuardEntryIngressDisposition>> = Object.freeze({
  "agent-manager.spawn": { kind: "captured-at-outer-path", outerPaths: ["agent-tool.spawn-background", "agent-tool.spawn-foreground", "nested-agent.spawn-background", "nested-agent.spawn-foreground", "mention.input-start", "mention.input-resume", "cross-extension-rpc.spawn", "manager-registry.spawn", "agents-command.generate-definition"] },
  "agent-manager.spawn-and-wait": { kind: "captured-at-outer-path", outerPaths: ["agent-tool.spawn-foreground", "nested-agent.spawn-foreground", "agents-command.generate-definition"] },
  "agent-manager.resume": { kind: "captured-at-outer-path", outerPaths: ["agent-tool.resume-background", "agent-tool.resume-foreground", "nested-agent.resume", "mention.input-resume"] },
  "agent-manager.steer": { kind: "captured-at-outer-path", outerPaths: ["agent-tool.steer", "nested-agent.steer", "mention.input-steer", "conversation-viewer.steer", "fleet-viewer.steer"] },
  "agent-manager.pending-steer": { kind: "captured-at-outer-path", outerPaths: ["agent-tool.steer", "nested-agent.steer", "mention.input-steer", "conversation-viewer.steer", "fleet-viewer.steer"] },
  "agent-tool.spawn-background": { kind: "captures-ingress-here" },
  "agent-tool.spawn-foreground": { kind: "captures-ingress-here" },
  "agent-tool.resume-background": { kind: "captures-ingress-here" },
  "agent-tool.resume-foreground": { kind: "captures-ingress-here" },
  "agent-tool.steer": { kind: "captures-ingress-here" },
  "nested-agent.spawn-background": { kind: "captures-ingress-here" },
  "nested-agent.spawn-foreground": { kind: "captures-ingress-here" },
  "nested-agent.resume": { kind: "captures-ingress-here" },
  "nested-agent.steer": { kind: "captures-ingress-here" },
  "mention.input-start": { kind: "captures-ingress-here" },
  "mention.input-clone": { kind: "captures-ingress-here" },
  "mention.input-resume": { kind: "captures-ingress-here" },
  "mention.input-steer": { kind: "captures-ingress-here" },
  "cross-extension-rpc.spawn": { kind: "captures-ingress-here" },
  "manager-registry.spawn": { kind: "captures-ingress-here" },
  "scheduled-task.fire": { kind: "no-text-input", task: "5.x" },
  "workflow-tool.dispatch": { kind: "no-text-input", task: "5.x" },
  "workflow-cli-flag.dispatch": { kind: "no-text-input", task: "5.x" },
  "workflow.pi-exec.gate": { kind: "no-text-input", task: "5.x" },
  "agents-command.generate-definition": { kind: "captures-ingress-here" },
  "conversation-viewer.steer": { kind: "captures-ingress-here" },
  "fleet-viewer.steer": { kind: "captures-ingress-here" },
  "agent-runner.turn-limit-steer": { kind: "captures-ingress-here" },
  "workflow-host.spawn": { kind: "no-text-input", task: "5.x" },
  "workflow-host.resume": { kind: "no-text-input", task: "5.x" },
  "agent-tool.schedule-create": { kind: "captures-ingress-here" },
});

export interface GuardIngressEvidence {
  ingressId: string;
  rawText: string;
  transformedText?: string;
  coverage: "complete" | "partial" | "unknown";
  target: string;
  origin: GuardOrigin;
  entryPath: GuardEntryPathId;
}

export type GuardIngressInput = Omit<GuardIngressEvidence, "ingressId">;

export interface GuardTextReference {
  sourceIdentity: string;
  sourceVersion: string;
  textReference: string;
}

export interface GuardResourceEnrollment {
  kind: "skill" | "template" | "agent-definition";
  sourceIdentity: string;
  sourceVersion: string;
  /** The stable child agent/session record id when this is a child preload. */
  childId?: string;
  /** Marks resources preloaded for a child before its session starts. */
  provenance?: "child-preload";
  /** Omitted means resolved for protocol-version-1 compatibility. */
  resolution?: "resolved" | "unresolved";
  resolvedRestrictionTextRefs: readonly GuardTextReference[];
}

export interface GuardChildContext {
  rootId: string;
  parentId: string;
  childId: string;
  delegationId: string;
  taskId: string;
  scopeRevision: number;
  executionEpoch: number;
  resolvedRestrictions: readonly GuardTextReference[];
  origin: GuardOrigin;
  /** Retained reference; never reconstructed from prompt text or process state. */
  bridgeRef: GuardBridgeRegistration;
}

export interface GuardApprovalRequest {
  requestId: string;
  rootId: string;
  taskId: string;
  childId?: string;
  inputGeneration: number;
  decisionRevision: number;
  executionEpoch: number;
  /** Opaque lifetime binding; consumers must compare, never interpret, its contents. */
  lifetimeToken: string;
  action: string;
  targets: readonly string[];
  authorityGap: string;
  evidenceRefs: readonly string[];
  deadline: number;
}

export interface GuardApprovalResponse {
  requestId: string;
  outcome: GuardOutcome;
  evidenceRefs: readonly string[];
}

export interface GuardBridgeCallbacks {
  captureIngress(evidence: GuardIngressEvidence): void | Promise<void>;
  enrollResource(enrollment: GuardResourceEnrollment): void | Promise<void>;
  createChildContext(context: Omit<GuardChildContext, "bridgeRef">): GuardChildContext | Promise<GuardChildContext>;
  revalidate(request: GuardApprovalRequest): GuardOutcome | Promise<GuardOutcome>;
  approvalSettled(response: GuardApprovalResponse): void | Promise<void>;
  approvalCancelled(requestId: string, reason: string): void | Promise<void>;
  approvalExpired(requestId: string): void | Promise<void>;
}

export interface GuardBridgeRegistration {
  protocolVersion: number;
  registrant: { id: string; version: string };
  callbacks: GuardBridgeCallbacks;
}

export type GuardBridgeRejectionCode =
  | "guard-missing"
  | "guard-incompatible-protocol"
  | "guard-wrong-registrant"
  | "guard-registrant-unconfigured"
  | "guard-registrant-conflict"
  | "guard-enrollment-failed";

export class GuardBridgeRejection extends Error {
  readonly name = "GuardBridgeRejection";

  constructor(
    readonly reasonCode: GuardBridgeRejectionCode,
    readonly entryPath: GuardEntryPathId,
    message: string,
  ) {
    super(message);
  }
}

export type GuardRequirementResult =
  | { ok: true; registration?: GuardBridgeRegistration }
  | { ok: false; rejection: GuardBridgeRejection };

const REQUIRED_CALLBACKS: readonly (keyof GuardBridgeCallbacks)[] = [
  "captureIngress",
  "enrollResource",
  "createChildContext",
  "revalidate",
  "approvalSettled",
  "approvalCancelled",
  "approvalExpired",
];

interface RegistrationSnapshot {
  protocolVersion: number;
  registrant: { id: string; version: string };
  callbacks: GuardBridgeCallbacks;
}

function safeDiagnosticValue(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unprintable value>";
  }
}

function snapshotRegistration(
  value: unknown,
  expectedRegistrantId?: string,
): { snapshot?: RegistrationSnapshot; problem?: string; reasonCode?: GuardBridgeRejectionCode } {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { problem: `registration must be an object, received ${value === null ? "null" : typeof value}.` };
    }
    const registrant = Reflect.get(value, "registrant") as unknown;
    if (registrant === null || typeof registrant !== "object" || Array.isArray(registrant)) {
      return {
        problem: `registrant must be an object with string id and version fields, received ${registrant === null ? "null" : typeof registrant}.`,
        reasonCode: "guard-wrong-registrant",
      };
    }
    const id = Reflect.get(registrant, "id") as unknown;
    const registrantVersion = Reflect.get(registrant, "version") as unknown;
    if (typeof id !== "string" || id.trim() === "" || typeof registrantVersion !== "string" || registrantVersion.trim() === "") {
      return {
        problem: "registrant.id and registrant.version must be non-empty strings.",
        reasonCode: "guard-wrong-registrant",
      };
    }
    if (expectedRegistrantId !== undefined && id !== expectedRegistrantId) {
      return {
        problem: `expected registrant id ${JSON.stringify(expectedRegistrantId)}, received ${JSON.stringify(id)}.`,
        reasonCode: "guard-wrong-registrant",
      };
    }

    const version = Reflect.get(value, "protocolVersion") as unknown;
    if (typeof version !== "number" || !Number.isInteger(version) || version !== GUARD_BRIDGE_PROTOCOL_VERSION) {
      return {
        problem: `expected protocolVersion integer ${GUARD_BRIDGE_PROTOCOL_VERSION}, received ${safeDiagnosticValue(version)} (typeof ${typeof version}).`,
      };
    }
    const callbacks = Reflect.get(value, "callbacks") as unknown;
    if (callbacks === null || typeof callbacks !== "object" || Array.isArray(callbacks)) {
      return { problem: `callbacks must be an object, received ${callbacks === null ? "null" : typeof callbacks}.` };
    }

    const copiedCallbacks = {} as GuardBridgeCallbacks;
    for (const name of REQUIRED_CALLBACKS) {
      const callback = Reflect.get(callbacks, name) as unknown;
      if (typeof callback !== "function") {
        return { problem: `callbacks.${name} must be a function, received ${typeof callback}.` };
      }
      Object.defineProperty(copiedCallbacks, name, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: callback.bind(callbacks),
      });
    }
    return {
      snapshot: Object.freeze({
        protocolVersion: version,
        registrant: Object.freeze({ id, version: registrantVersion }),
        callbacks: Object.freeze(copiedCallbacks),
      }),
    };
  } catch (error) {
    let reason = "unknown property access error";
    try {
      reason = error instanceof Error ? error.message : safeDiagnosticValue(error);
    } catch { /* retain the safe fallback */ }
    return { problem: `registration could not be inspected: ${reason}.` };
  }
}
const ingressCaptureDiagnostics = new WeakMap<GuardBridgeHost, { epoch: string; sequence: number; count: number; failures: string[] }>();

/** Root-owned host state. Registration identity is retained; callbacks are snapshotted once. */
export class GuardBridgeHost {
  private registration: GuardBridgeRegistration | undefined;
  private registrationSnapshot: RegistrationSnapshot | undefined;
  private registrationRejected: string | undefined;
  private registrationRejectedReasonCode: GuardBridgeRejectionCode | undefined;
  private registrationRejectionHistory: string[] = [];

  private guardExpectedDiagnostic: string | undefined;
  private guardRegistrant: string | undefined;
  private guardRegistrantDiagnostic: string | undefined;

  constructor(private expected: boolean = false, guardRegistrant?: string) {
    ingressCaptureDiagnostics.set(this, { epoch: randomUUID(), sequence: 0, count: 0, failures: [] });
    this.setGuardRegistrant(guardRegistrant);
  }

  get guardExpected(): boolean {
    return this.expected;
  }

  /** A true requirement is sticky: lower-precedence settings cannot turn it off. */
  setGuardExpected(expected: boolean): void {
    if (expected) this.expected = true;
  }

  setGuardRegistrant(registrant: string | undefined): void {
    this.guardRegistrant = typeof registrant === "string" && registrant.trim() !== "" ? registrant.trim() : undefined;
  }

  getGuardRegistrant(): string | undefined {
    return this.guardRegistrant;
  }

  setGuardExpectedDiagnostic(diagnostic: string | undefined): void {
    this.guardExpectedDiagnostic = diagnostic;
  }

  getGuardExpectedDiagnostic(): string | undefined {
    return this.guardExpectedDiagnostic;
  }

  setGuardRegistrantDiagnostic(diagnostic: string | undefined): void {
    this.guardRegistrantDiagnostic = diagnostic;
  }

  getGuardRegistrantDiagnostic(): string | undefined {
    return this.guardRegistrantDiagnostic;
  }

  getConfigDiagnostic(): string | undefined {
    const diagnostics = [this.guardExpectedDiagnostic, this.guardRegistrantDiagnostic].filter(Boolean);
    if (this.expected && this.guardRegistrant === undefined && this.guardRegistrantDiagnostic === undefined) {
      diagnostics.push("guard-registrant-unconfigured: guardRegistrant is unset or empty while guardExpected is true.");
    }
    return diagnostics.join("; ") || undefined;
  }

  register(value: unknown): { compatible: boolean; registrationRejected?: string; reasonCode?: GuardBridgeRejectionCode } {
    if (this.expected && this.guardRegistrant === undefined) {
      const conflict = this.guardRegistrantDiagnostic?.startsWith("guard-registrant-conflict:") === true;
      const reasonCode = conflict ? "guard-registrant-conflict" : "guard-registrant-unconfigured";
      const reason = this.guardRegistrantDiagnostic ?? "guardRegistrant is unset or empty while guardExpected is true.";
      return this.rejectRegistration(`${reasonCode}: guarded work is unavailable; ${reason}`, reasonCode);
    }
    if (this.registration !== undefined) {
      if (value !== this.registration) {
        // A non-expected registrant is reported as such even after the expected one registered.
        if (this.guardRegistrant !== undefined) {
          const { reasonCode: identityReason, problem: identityProblem } = snapshotRegistration(value, this.guardRegistrant);
          if (identityProblem !== undefined && identityReason === "guard-wrong-registrant") {
            return this.rejectRegistration(identityProblem, identityReason);
          }
        }
        return this.rejectRegistration(
          "a different registration object was rejected; the first registration remains active.",
          "guard-incompatible-protocol",
        );
      }
      // The identity and its validated callback snapshot are stable even if the
      // extension later mutates or replaces properties on the original object.
      this.clearCurrentRegistrationRejection();
      return { compatible: true };
    }

    const { snapshot, problem, reasonCode } = snapshotRegistration(value, this.guardRegistrant);
    if (problem !== undefined || snapshot === undefined) {
      return this.rejectRegistration(
        problem ?? "registration could not be inspected.",
        reasonCode ?? "guard-incompatible-protocol",
      );
    }

    this.registration = value as GuardBridgeRegistration;
    this.registrationSnapshot = snapshot;
    this.clearCurrentRegistrationRejection();
    return { compatible: true };
  }

  private clearCurrentRegistrationRejection(): void {
    this.registrationRejected = undefined;
    this.registrationRejectedReasonCode = undefined;
  }

  rejectRegistration(
    reason: string,
    reasonCode: GuardBridgeRejectionCode = "guard-incompatible-protocol",
  ): { compatible: false; registrationRejected: string; reasonCode: GuardBridgeRejectionCode } {
    this.registrationRejected = reason;
    this.registrationRejectedReasonCode = reasonCode;
    this.registrationRejectionHistory.push(reason);
    if (this.registrationRejectionHistory.length > 10) this.registrationRejectionHistory.shift();
    return { compatible: false, registrationRejected: reason, reasonCode };
  }

  getRegistration(): GuardBridgeRegistration | undefined {
    return this.registration;
  }

  getRegistrationRejected(): string | undefined {
    return this.registrationRejected;
  }

  getRegistrationRejectionHistory(): readonly string[] {
    return [...this.registrationRejectionHistory];
  }
  /** Clear extension-owned registration state when its session is torn down. */
  unregister(): void {
    this.registration = undefined;
    this.registrationSnapshot = undefined;
    this.registrationRejected = undefined;
    this.registrationRejectedReasonCode = undefined;
  }

  getIngressCaptureFailureCount(): number {
    return ingressCaptureDiagnostics.get(this)?.count ?? 0;
  }

  getIngressCaptureFailures(): readonly string[] {
    return [...(ingressCaptureDiagnostics.get(this)?.failures ?? [])];
  }

  /** Record content-free failures from deferred work that outlives registration. */
  recordIngressContinuationFailure(entryPath: GuardEntryPathId, error: unknown): void {
    const diagnostics = ingressCaptureDiagnostics.get(this);
    if (!diagnostics) return;
    diagnostics.count++;
    let errorKind = "unknown";
    try { errorKind = error instanceof Error ? error.name || "Error" : typeof error; } catch { /* safe fallback */ }
    diagnostics.failures.push(`deferred ingress continuation stopped at ${entryPath} (${errorKind}).`);
    if (diagnostics.failures.length > 10) diagnostics.failures.shift();
  }

  /**
   * Capture through the immutable registration snapshot before an owned input is consumed.
   * No registration in optional mode is a synchronous no-op; callback failures are recorded
   * and converted to success so they cannot crash the host or authorize the input.
   */
  captureIngress(input: GuardIngressInput): GuardIngressEvidence | Promise<GuardIngressEvidence> | undefined {
    const requirement = this.requireGuard(input.entryPath);
    if (!requirement.ok) throw requirement.rejection;
    const snapshot = this.registrationSnapshot;
    if (!snapshot) return undefined;

    const hostDiagnostics = ingressCaptureDiagnostics.get(this)!;
    const evidence: GuardIngressEvidence = Object.freeze({
      ingressId: `sg-ing-${hostDiagnostics.epoch}-${++hostDiagnostics.sequence}`,
      rawText: input.rawText,
      ...(input.transformedText !== undefined && input.transformedText !== input.rawText ? { transformedText: input.transformedText } : {}),
      coverage: input.coverage,
      target: input.target,
      origin: input.origin,
      entryPath: input.entryPath,
    });

    const recordFailure = (error: unknown): void => {
      const diagnostics = ingressCaptureDiagnostics.get(this)!;
      diagnostics.count++;
      let errorKind = "unknown";
      try {
        errorKind = error instanceof Error ? error.name || "Error" : typeof error;
      } catch { /* keep a content-free fallback */ }
      diagnostics.failures.push(`captureIngress failed at ${input.entryPath} (${evidence.ingressId}; ${errorKind}).`);
      if (diagnostics.failures.length > 10) diagnostics.failures.shift();
    };

    try {
      const result = snapshot.callbacks.captureIngress(evidence);
      if (result && typeof (result as Promise<void>).then === "function") {
        return Promise.resolve(result).then(
          () => evidence,
          error => {
            recordFailure(error);
            return evidence;
          },
        );
      }
    } catch (error) {
      recordFailure(error);
    }
    return evidence;
  }


  /** Current frozen enrollment-registration identity, used to scope child deduplication. */
  getResourceEnrollmentSnapshotIdentity(): object | undefined {
    return this.registrationSnapshot;
  }

  /** Enroll applicable child resources through the frozen registration snapshot. */
  async enrollResource(
    enrollment: GuardResourceEnrollment,
    entryPath: GuardEntryPathId = "agent-manager.spawn",
  ): Promise<boolean> {
    const requirement = this.requireGuard(entryPath);
    if (!requirement.ok) throw requirement.rejection;
    const snapshot = this.registrationSnapshot;
    if (!snapshot) return false;

    try {
      await snapshot.callbacks.enrollResource(enrollment);
      return true;
    } catch {
      throw new GuardBridgeRejection(
        "guard-enrollment-failed",
        entryPath,
        `guard-enrollment-failed: guarded work is unavailable at ${entryPath}; resource enrollment callback failed; child dispatch was stopped.`,
      );
    }
  }

  requireGuard(entryPath: GuardEntryPathId): GuardRequirementResult {
    // Optional mode must not inspect any untrusted registration object on the hot path.
    if (!this.expected) {
      return { ok: true, ...(this.registration !== undefined ? { registration: this.registration } : {}) };
    }
    if (this.guardRegistrant === undefined) {
      const conflict = this.guardRegistrantDiagnostic?.startsWith("guard-registrant-conflict:") === true;
      const reasonCode = conflict ? "guard-registrant-conflict" : "guard-registrant-unconfigured";
      const detail = this.guardRegistrantDiagnostic ?? "guardRegistrant is unset or empty while guardExpected is true.";
      return {
        ok: false,
        rejection: new GuardBridgeRejection(
          reasonCode,
          entryPath,
          `${reasonCode}: guarded work is unavailable at ${entryPath}; ${detail}`,
        ),
      };
    }
    if (this.registration === undefined || this.registrationSnapshot === undefined) {
      if (this.registrationRejected !== undefined) {
        const reasonCode = this.registrationRejectedReasonCode ?? "guard-incompatible-protocol";
        return {
          ok: false,
          rejection: new GuardBridgeRejection(
            reasonCode,
            entryPath,
            `${reasonCode}: guarded work is unavailable at ${entryPath}; ${this.registrationRejected}`,
          ),
        };
      }
      return {
        ok: false,
        rejection: new GuardBridgeRejection(
          "guard-missing",
          entryPath,
          `guard-missing: guarded work is unavailable at ${entryPath}; no guard bridge registration is present.`,
        ),
      };
    }
    return { ok: true, registration: this.registration };
  }

  assertGuard(entryPath: GuardEntryPathId): GuardBridgeRegistration | undefined {
    const result = this.requireGuard(entryPath);
    if (!result.ok) throw result.rejection;
    return result.registration;
  }
}
