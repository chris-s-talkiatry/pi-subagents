import { randomUUID } from "node:crypto";
import type { EventBus, ExtensionFactory } from "@earendil-works/pi-coding-agent";



/**
 * Versioned, in-process contract between pi-subagents and an optional scope guard.
 * This module intentionally has no process-global registry and no prompt-derived IDs.
 */
export const GUARD_BRIDGE_PROTOCOL_VERSION = 1;

/**
 * Per-child marker attached to the resource-loader event bus. Discovered guard
 * factories can synchronously read the validated context while they initialize.
 */
export const GUARD_CHILD_CONTEXT_EVENT_BUS_MARKER = Symbol("pi-subagents.guard-child-context");
const CHILD_CONTEXT_QUERY_EVENT = "subagents:child-context-query";
/** @deprecated Context refreshes are read from the marker; no public update event is emitted. */
export const GUARD_CHILD_CONTEXT_UPDATED_EVENT = "subagents:child-context-updated";
const childContextByEventBus = new WeakMap<EventBus, { publicContext: GuardChildContext }>();

function publicChildContext(context: GuardChildContext): GuardChildContext {
  const bridge = context.bridgeRef;
  const callbacks = Object.freeze({ ...bridge.callbacks });
  const bridgeRef: GuardBridgeRegistration = Object.freeze({
    protocolVersion: bridge.protocolVersion,
    registrant: Object.freeze({ ...bridge.registrant }),
    callbacks,
  });
  return Object.freeze({ ...context, bridgeRef });
}

export function markGuardChildContext(eventBus: EventBus, context: GuardChildContext): void {
  const existing = childContextByEventBus.get(eventBus);
  if (existing) {
    existing.publicContext = publicChildContext(context);
  } else {
    const state = { publicContext: publicChildContext(context) };
    childContextByEventBus.set(eventBus, state);
    eventBus.on(CHILD_CONTEXT_QUERY_EVENT, value => {
      if (!value || typeof value !== "object") return;
      const respond = Reflect.get(value, "respond") as unknown;
      if (typeof respond === "function") respond(state.publicContext);
    });
    Object.defineProperty(eventBus, GUARD_CHILD_CONTEXT_EVENT_BUS_MARKER, {
      configurable: false,
      enumerable: false,
      get: () => state.publicContext,
    });
  }
}

/** Read the current validated child context from an extension's `pi.events`. */
export function getGuardChildContext(eventBus: EventBus): GuardChildContext | undefined {
  try {
    const marker = Reflect.get(eventBus, GUARD_CHILD_CONTEXT_EVENT_BUS_MARKER) as unknown;
    // The non-configurable marker is authoritative; untrusted query responders
    // cannot replace it with a fabricated child context.
    if (marker !== null && typeof marker === "object") return marker as GuardChildContext;
    let context: unknown;
    let responded = false;
    eventBus.emit(CHILD_CONTEXT_QUERY_EVENT, {
      respond: (value: unknown) => {
        // A marker-backed bus registers its responder before discovered
        // extensions load. First response wins so later listeners cannot spoof it.
        if (responded) return;
        responded = true;
        context = value;
      },
    });
    return context !== null && typeof context === "object" ? context as GuardChildContext : undefined;
  } catch {
    return undefined;
  }
}

/** Private activation-local marker used only to carry a clone's parent context. */
export const MENTION_CLONE_PARENT_CONTEXT = Symbol("pi-subagents.mention-clone-parent-context");


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

const GUARD_ORIGINS = [
  "human", "parent-model-delegation", "extension-request", "package-system-control", "imported-context", "tool-observation",
] as const satisfies readonly GuardOrigin[];

function isGuardOrigin(value: unknown): value is GuardOrigin {
  return typeof value === "string" && GUARD_ORIGINS.includes(value as GuardOrigin);
}

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
  | "worktree.create"
  | "worktree.capture"
  | "worktree.remove"
  | "worktree.prune"
  | "agent-runner.detect-env"
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
  { id: "worktree.create", operation: "dispatch", sourceLocations: ["src/worktree.ts: createWorktree git boundaries"] },
  { id: "worktree.capture", operation: "dispatch", sourceLocations: ["src/worktree.ts: cleanupWorktree capture/commit boundaries"] },
  { id: "worktree.remove", operation: "dispatch", sourceLocations: ["src/worktree.ts: removeWorktree"] },
  { id: "worktree.prune", operation: "dispatch", sourceLocations: ["src/worktree.ts: pruneWorktrees"] },
  { id: "agent-runner.detect-env", operation: "dispatch", sourceLocations: ["src/env.ts: detectEnv git observations"] },
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
  "agent-manager.spawn": { kind: "captured-at-outer-path", outerPaths: ["agent-tool.spawn-background", "agent-tool.spawn-foreground", "nested-agent.spawn-background", "nested-agent.spawn-foreground", "mention.input-start", "mention.input-resume", "cross-extension-rpc.spawn", "manager-registry.spawn", "agents-command.generate-definition", "workflow-host.spawn"] },
  "agent-manager.spawn-and-wait": { kind: "captured-at-outer-path", outerPaths: ["agent-tool.spawn-foreground", "nested-agent.spawn-foreground", "agents-command.generate-definition", "workflow-host.spawn"] },
  "agent-manager.resume": { kind: "captured-at-outer-path", outerPaths: ["agent-tool.resume-background", "agent-tool.resume-foreground", "nested-agent.resume", "mention.input-resume", "workflow-host.resume"] },
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
  "worktree.create": { kind: "no-text-input", task: "5.x" },
  "worktree.capture": { kind: "no-text-input", task: "5.x" },
  "worktree.remove": { kind: "no-text-input", task: "5.x" },
  "worktree.prune": { kind: "no-text-input", task: "5.x" },
  "agent-runner.detect-env": { kind: "no-text-input", task: "5.x" },
  "agents-command.generate-definition": { kind: "captures-ingress-here" },
  "conversation-viewer.steer": { kind: "captures-ingress-here" },
  "fleet-viewer.steer": { kind: "captures-ingress-here" },
  "agent-runner.turn-limit-steer": { kind: "captures-ingress-here" },
  "workflow-host.spawn": { kind: "captures-ingress-here" },
  "workflow-host.resume": { kind: "captures-ingress-here" },
  "agent-tool.schedule-create": { kind: "captures-ingress-here" },
});

export interface GuardIngressEvidence {
  ingressId: string;
  rawText: string;
  transformedText?: string;
  coverage: "complete" | "partial" | "unknown";
  target: string;
  origin: GuardOrigin;
  /** Identity of the child targeted by resume/steer or child-originated input. */
  childId?: string;
  delegationId?: string;
  parentId?: string;
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
  /** Fork-observed root UI availability; optional in legacy callback values. */
  headless?: boolean;
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

export type GuardEffectKind =
  | "workflow-exec"
  | "worktree-create"
  | "worktree-capture"
  | "worktree-remove"
  | "worktree-prune"
  | "child-git-observation";
export type GuardEffectBoundTo = "owned-resources" | "unbounded";
const READ_ONLY_GIT_ARGV = new Set([
  JSON.stringify(["rev-parse", "--is-inside-work-tree"]),
  JSON.stringify(["rev-parse", "HEAD"]),
  JSON.stringify(["rev-parse", "--show-toplevel"]),
  JSON.stringify(["branch", "--show-current"]),
]);

export function isForkReadOnlyGitCommand(command: string, argv: readonly string[]): boolean {
  return command === "git" && READ_ONLY_GIT_ARGV.has(JSON.stringify(argv));
}

export interface GuardEffectResources {
  worktreePath?: string;
  branch?: string;
  baseRepo?: string;
  parentWorkspace?: string;
}
/** Concrete, content-minimal details supplied at the process execution boundary. */
export interface GuardEffectDescription {
  kind: GuardEffectKind;
  command: string;
  argv: readonly string[];
  cwd: string;
  /** Environment variable names only. Values are never part of this protocol. */
  envKeys: readonly string[];
  resources: GuardEffectResources;
  ownedByPackage: boolean;
  boundTo: GuardEffectBoundTo;
  /** Fork-computed exact allow-list classification for deterministic read-only git inspection. */
  readOnly?: true;
}
/** A frozen authorization request for one concrete fork-owned process effect. */
export interface GuardEffectRequest extends GuardEffectDescription {
  /** The manager issued this request from the private scheduled-fire path. */
  scheduled?: true;
  /** The fork observed a headless root; effect reviews are bounded accordingly. */
  headless?: boolean;
  /** True when envKeys was deterministically truncated to its bounded prefix. */
  envKeysTruncated?: true;
  /** Total number of environment key names before truncation. */
  envKeysTotalCount?: number;
  effectId: string;
  entryPath: GuardEntryPathId;
  childId?: string;
  parentId?: string;
  delegationId?: string;
  ingressId?: string;
  workflowId?: string;
  childContext?: GuardChildContext;
}
export type GuardChildScopeRefStatus = "provided" | "unresolved" | "not-applicable";

/** Fork-known facts supplied to the guard before it assigns authority state. */
export interface GuardChildContextRequest {
  childId: string;
  parentId: string;
  delegationId: string;
  origin: GuardOrigin;
  entryPath: GuardEntryPathId;
  operation: "spawn" | "resume";
  ingressId?: string;
  /** Present for a nested child or an ephemeral child-run that delegates onward. */
  parentContext?: GuardChildContext;
  inheritContext: boolean;
  isolatedExtensions: boolean;
  worktree: boolean;
  /** Fork-observed fact: the root has no supported approval UI. */
  headless: boolean;
  scopeRef?: string;
  scopeRefStatus: GuardChildScopeRefStatus;
  scheduled?: { jobId: string; runIndex: number; expiresAt: string };
}

export interface GuardChildInjection {
  childId: string;
  /** Fork-observed root UI availability, copied from the validated request. */
  headless: boolean;
  /** Per-session token; never serialized into prompts or session transcripts. */
  token: symbol;
}

export type GuardChildGuardFactory = (
  context: GuardChildContext,
  injection: GuardChildInjection,
) => ExtensionFactory | Promise<ExtensionFactory>;

export interface PreparedGuardChildInjection {
  extensionFactory: ExtensionFactory;
  handle: GuardChildInjection;
}


/** Bounded schedule facts and creator provenance supplied when a guarded job is created. */
export interface GuardScheduleScopeRequest {
  jobId: string;
  ingressId: string;
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  nextRun: string;
  requestedExpiresAt?: string;
  requestedMaxRuns?: number;
  origin: GuardOrigin;
  parentId: string;
  creatingChildId?: string;
  parentContext?: GuardChildContext;
  headless: boolean;
}

/** Guard-owned schedule token; target bindings are validated but never persisted by the fork. */
export interface GuardScheduleScope {
  scopeId: string;
  expiresAt: string;
  maxRuns: number;
  targetBindings: readonly string[];
}

export interface GuardBridgeCallbacks {
  captureIngress(evidence: GuardIngressEvidence): void | Promise<void>;
  enrollResource(enrollment: GuardResourceEnrollment): void | Promise<void>;
  createChildContext(request: GuardChildContextRequest): GuardChildContext | Promise<GuardChildContext>;
  revalidate(request: GuardApprovalRequest): GuardOutcome | Promise<GuardOutcome>;
  approvalSettled(response: GuardApprovalResponse): void | Promise<void>;
  approvalCancelled(requestId: string, reason: string): void | Promise<void>;
  approvalExpired(requestId: string): void | Promise<void>;
  /** Review one concrete fork-owned effect immediately before execution. */
  reviewEffect?(request: GuardEffectRequest): GuardOutcome | Promise<GuardOutcome>;
  /** Mint an explicit bounded authority reference for one scheduled task. */
  createScheduleScope?(request: GuardScheduleScopeRequest): GuardScheduleScope | Promise<GuardScheduleScope>;
}

export interface GuardBridgeRegistration {
  protocolVersion: number;
  registrant: { id: string; version: string };
  callbacks: GuardBridgeCallbacks;
  /** Optional factory used only by the fork for guarded child sessions. */
  createChildGuardExtension?: GuardChildGuardFactory;
}

export type GuardBridgeRejectionCode =
  | "guard-missing"
  | "guard-incompatible-protocol"
  | "guard-wrong-registrant"
  | "guard-registrant-unconfigured"
  | "guard-registrant-conflict"
  | "guard-enrollment-failed"
  | "guard-child-context-failed"
  | "guard-schedule-scope-missing"
  | "guard-schedule-scope-failed"
  | "guard-child-injection-failed"
  | "guard-effect-review-missing"
  | "guard-effect-denied"
  | "guard-effect-approval-needed"
  | "guard-effect-cancelled"
  | "guard-effect-unavailable";

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

/** Code-configurable ceiling; defaults to ten seconds for child guard setup. */
export const GUARD_CHILD_INJECTION_TIMEOUT_MS = 10_000;
export const GUARD_EFFECT_REVIEW_TIMEOUT_MS = 10_000;
/** Max time a guarded unattended schedule may spend obtaining fire-time context. */
export const GUARD_SCHEDULE_FIRE_TIMEOUT_MS = 10_000;
/** Schedule-scope creation is bounded independently from the prompt's lifetime. */
export const GUARD_SCHEDULE_SCOPE_TIMEOUT_MS = 10_000;

/** Bound a child injection hook even on entry paths without a caller abort signal. */
export async function withGuardChildInjectionTimeout<T>(
  pending: Promise<T>,
  entryPath: GuardEntryPathId,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(pending),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new GuardBridgeRejection(
          "guard-child-injection-failed",
          entryPath,
          `guard-child-injection-failed: guarded work is unavailable at ${entryPath}; child guard injection could not be prepared.`,
        )), GUARD_CHILD_INJECTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Bound scheduled fire-time child context creation even without a UI turn to release it. */
export async function withGuardScheduleFireTimeout<T>(
  pending: Promise<T>,
  entryPath: GuardEntryPathId,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(pending),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new GuardBridgeRejection(
          "guard-child-context-failed",
          entryPath,
          `guard-child-context-failed: guarded work is unavailable at ${entryPath}; scheduled context was not obtained within ${GUARD_SCHEDULE_FIRE_TIMEOUT_MS}ms.`,
        )), GUARD_SCHEDULE_FIRE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
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

// The object identity, not the visible childId/token fields, is the capability.
const issuedGuardChildInjectionHandles = new WeakSet<object>();

interface RegistrationSnapshot {
  protocolVersion: number;
  registrant: { id: string; version: string };
  callbacks: GuardBridgeCallbacks;
  createChildGuardExtension?: GuardChildGuardFactory;
  registration: GuardBridgeRegistration;
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
    const childGuardHook = Reflect.get(value, "createChildGuardExtension") as unknown;
    if (childGuardHook !== undefined && typeof childGuardHook !== "function") {
      return { problem: "createChildGuardExtension must be a function when present." };
    }
    const createChildGuardExtension = typeof childGuardHook === "function"
      ? childGuardHook.bind(value) as GuardChildGuardFactory
      : undefined;
    const reviewEffect = Reflect.get(callbacks, "reviewEffect") as unknown;
    if (reviewEffect !== undefined && typeof reviewEffect !== "function") {
      return { problem: "callbacks.reviewEffect must be a function when present." };
    }
    if (typeof reviewEffect === "function") {
      Object.defineProperty(copiedCallbacks, "reviewEffect", {
        configurable: false, enumerable: true, writable: false, value: reviewEffect.bind(callbacks),
      });
    }
    const createScheduleScope = Reflect.get(callbacks, "createScheduleScope") as unknown;
    if (createScheduleScope !== undefined && typeof createScheduleScope !== "function") {
      return { problem: "callbacks.createScheduleScope must be a function when present." };
    }
    if (typeof createScheduleScope === "function") {
      Object.defineProperty(copiedCallbacks, "createScheduleScope", {
        configurable: false, enumerable: true, writable: false, value: createScheduleScope.bind(callbacks),
      });
    }
    const frozenCallbacks = Object.freeze(copiedCallbacks);
    const frozenRegistrant = Object.freeze({ id, version: registrantVersion });
    const registration: GuardBridgeRegistration = Object.freeze({
      protocolVersion: version,
      registrant: frozenRegistrant,
      callbacks: frozenCallbacks,
      ...(createChildGuardExtension ? { createChildGuardExtension } : {}),
    });
    return {
      snapshot: Object.freeze({
        protocolVersion: version,
        registrant: frozenRegistrant,
        callbacks: frozenCallbacks,
        ...(createChildGuardExtension ? { createChildGuardExtension } : {}),
        registration,
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
  private ingressSnapshots = new WeakMap<GuardIngressEvidence, object>();
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

  /** Frozen validated registration passed into child construction. */
  getValidatedRegistrationSnapshot(): GuardBridgeRegistration | undefined {
    return this.registrationSnapshot?.registration;
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
      ...(input.childId !== undefined ? { childId: input.childId } : {}),
      ...(input.delegationId !== undefined ? { delegationId: input.delegationId } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    });
    this.ingressSnapshots.set(evidence, snapshot);

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

    const assertCaptureSnapshot = (): GuardIngressEvidence => {
      this.assertRegistrationSnapshotActive(snapshot, input.entryPath);
      return evidence;
    };
    try {
      const result = snapshot.callbacks.captureIngress(evidence);
      if (result && typeof (result as Promise<void>).then === "function") {
        return Promise.resolve(result).then(
          assertCaptureSnapshot,
          error => {
            recordFailure(error);
            return assertCaptureSnapshot();
          },
        );
      }
    } catch (error) {
      recordFailure(error);
    }
    return assertCaptureSnapshot();
  }

  /**
   * Review a frozen concrete effect through the exact registration snapshot that
   * owned its execution path. A pending review holds its caller's existing slot
   * and is released only by the caller's abort signal or callback settlement.
   */
  async reviewEffect(
    request: GuardEffectRequest,
    snapshot: object | undefined,
    entryPath: GuardEntryPathId,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.expected) return;
    this.assertRegistrationSnapshotActive(snapshot, entryPath);
    const registrationSnapshot = this.registrationSnapshot;
    const reject = (reasonCode: GuardBridgeRejectionCode): never => {
      throw new GuardBridgeRejection(
        reasonCode,
        entryPath,
        `${reasonCode}: guarded work is unavailable at ${entryPath}; the concrete effect was not executed.`,
      );
    };
    const callback = registrationSnapshot?.callbacks.reviewEffect;
    if (typeof callback !== "function") reject("guard-effect-review-missing");
    if (signal?.aborted) reject("guard-effect-cancelled");

    const boundedReview = request.scheduled === true || request.entryPath === "scheduled-task.fire" || request.headless === true || signal === undefined;
    const pending = Promise.resolve().then(() => callback!(request));
    let abortListener: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const races: Promise<GuardOutcome>[] = [pending];
      if (signal) {
        races.push(new Promise<never>((_resolve, rejectAbort) => {
          abortListener = () => rejectAbort(new GuardBridgeRejection(
            "guard-effect-cancelled", entryPath,
            `guard-effect-cancelled: guarded work is unavailable at ${entryPath}; the concrete effect was not executed.`,
          ));
          signal.addEventListener("abort", abortListener, { once: true });
          if (signal.aborted) abortListener();
        }));
      }
      if (boundedReview) {
        races.push(new Promise<never>((_resolve, rejectTimeout) => {
          timeout = setTimeout(() => rejectTimeout(new GuardBridgeRejection(
            "guard-effect-unavailable", entryPath,
            `guard-effect-unavailable: guarded work is unavailable at ${entryPath}; effect review exceeded 10 seconds.`,
          )), GUARD_EFFECT_REVIEW_TIMEOUT_MS);
        }));
      }
      const outcome = await Promise.race(races);
      this.assertRegistrationSnapshotActive(snapshot, entryPath);
      if (signal?.aborted) reject("guard-effect-cancelled");
      if (!(GUARD_OUTCOMES as readonly unknown[]).includes(outcome)) reject("guard-effect-unavailable");
      if (outcome !== "allowed") {
        if (outcome === "denied" || outcome === "stopped") reject("guard-effect-denied");
        if (outcome === "cancelled") reject("guard-effect-cancelled");
        if (outcome === "approval-needed") reject("guard-effect-approval-needed");
        reject("guard-effect-unavailable");
      }
    } catch (error) {
      if (error instanceof GuardBridgeRejection) {
        if (error.reasonCode === "guard-effect-cancelled" || error.reasonCode === "guard-effect-approval-needed") throw error;
        if (error.reasonCode === "guard-effect-denied" || error.reasonCode === "guard-effect-review-missing" || error.reasonCode === "guard-effect-unavailable") throw error;
      }
      try { this.assertRegistrationSnapshotActive(snapshot, entryPath); }
      catch { reject("guard-effect-unavailable"); }
      reject("guard-effect-unavailable");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
    }
  }

  /** Re-check the exact callback snapshot immediately before a job is persisted. */
  assertScheduleScopeSnapshotActive(snapshot: object | undefined): void {
    try {
      this.assertRegistrationSnapshotActive(snapshot, "agent-tool.schedule-create");
    } catch {
      throw new GuardBridgeRejection(
        "guard-schedule-scope-failed",
        "agent-tool.schedule-create",
        "guard-schedule-scope-failed: guarded work is unavailable at agent-tool.schedule-create; the scheduled job was not created.",
      );
    }
  }

  /** Mint and validate a bounded schedule scope through the frozen registration. */
  async createScheduleScope(
    input: GuardScheduleScopeRequest,
    signal?: AbortSignal,
    expectedSnapshot: object | undefined = this.registrationSnapshot,
  ): Promise<GuardScheduleScope> {
    const entryPath = "agent-tool.schedule-create" as const;
    const requirement = this.requireGuard(entryPath);
    if (!requirement.ok) throw requirement.rejection;
    const snapshot = expectedSnapshot as RegistrationSnapshot | undefined;
    this.assertScheduleScopeSnapshotActive(snapshot);
    const callback = snapshot?.callbacks.createScheduleScope;
    const reject = (reasonCode: "guard-schedule-scope-missing" | "guard-schedule-scope-failed"): never => {
      throw new GuardBridgeRejection(
        reasonCode,
        entryPath,
        `${reasonCode}: guarded work is unavailable at ${entryPath}; the scheduled job was not created.`,
      );
    };
    if (typeof callback !== "function") reject("guard-schedule-scope-missing");
    if (signal?.aborted) reject("guard-schedule-scope-failed");
    if (
      typeof input.jobId !== "string" || !input.jobId || input.jobId.length > 256 ||
      typeof input.ingressId !== "string" || !input.ingressId || input.ingressId.length > 256 ||
      typeof input.schedule !== "string" || !input.schedule || input.schedule.length > 512 ||
      !["cron", "once", "interval"].includes(input.scheduleType) ||
      !Number.isFinite(Date.parse(input.nextRun)) ||
      !isGuardOrigin(input.origin) ||
      typeof input.parentId !== "string" || !input.parentId || input.parentId.length > 256 ||
      typeof input.headless !== "boolean" ||
      (input.requestedExpiresAt !== undefined && (typeof input.requestedExpiresAt !== "string" || input.requestedExpiresAt.length > 128 || !Number.isFinite(Date.parse(input.requestedExpiresAt)))) ||
      (input.requestedMaxRuns !== undefined && (!Number.isSafeInteger(input.requestedMaxRuns) || input.requestedMaxRuns < 1)) ||
      (input.creatingChildId !== undefined && (typeof input.creatingChildId !== "string" || !input.creatingChildId || input.creatingChildId.length > 256)) ||
      (input.parentContext !== undefined && (input.parentContext.bridgeRef !== this.registration || input.parentContext.childId !== input.creatingChildId || input.parentId !== input.parentContext.childId))
    ) reject("guard-schedule-scope-failed");

    const request = Object.freeze({
      ...input,
      ...(input.parentContext ? { parentContext: input.parentContext } : {}),
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const pending = Promise.resolve().then(() => callback!(request));
      const waits: Promise<never>[] = [new Promise<never>((_resolve, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error("timeout")), GUARD_SCHEDULE_SCOPE_TIMEOUT_MS);
      })];
      if (signal) waits.push(new Promise<never>((_resolve, rejectAbort) => {
        abortListener = () => rejectAbort(new Error("aborted"));
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      }));
      const returned: unknown = await Promise.race([pending, ...waits]);
      this.assertScheduleScopeSnapshotActive(snapshot);
      if (signal?.aborted) reject("guard-schedule-scope-failed");
      if (returned === null || typeof returned !== "object" || Array.isArray(returned)) reject("guard-schedule-scope-failed");
      const value = returned as GuardScheduleScope;
      const scopeId = value.scopeId;
      const expiresAt = value.expiresAt;
      const maxRuns = value.maxRuns;
      const targetBindings = value.targetBindings;
      if (
        typeof scopeId !== "string" || !scopeId.trim() || scopeId.length > 512 || Buffer.byteLength(scopeId, "utf8") > 512 || scopeId.includes("\0") ||
        typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) ||
        typeof maxRuns !== "number" || !Number.isSafeInteger(maxRuns) || maxRuns < 1 ||
        !Array.isArray(targetBindings) || targetBindings.length < 1 || targetBindings.length > 128
      ) reject("guard-schedule-scope-failed");
      const bindings: string[] = [];
      const bindingCount = targetBindings.length;
      for (let index = 0; index < bindingCount; index++) {
        const binding = targetBindings[index];
        if (typeof binding !== "string" || !binding.trim() || binding.length > 512 || Buffer.byteLength(binding, "utf8") > 512) {
          reject("guard-schedule-scope-failed");
        }
        bindings.push(binding);
      }
      this.assertScheduleScopeSnapshotActive(snapshot);
      return Object.freeze({ scopeId, expiresAt, maxRuns, targetBindings: Object.freeze(bindings) });
    } catch {
      try { this.assertScheduleScopeSnapshotActive(snapshot); }
      catch { return reject("guard-schedule-scope-failed"); }
      return reject("guard-schedule-scope-failed");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
    }
  }

  /** Create an immutable, validated context through the exact active snapshot. */
  async createChildContext(
    input: Omit<GuardChildContextRequest, "delegationId">,
    evidence?: GuardIngressEvidence,
  ): Promise<GuardChildContext | undefined> {
    const requirement = this.requireGuard(input.entryPath);
    if (!requirement.ok) throw requirement.rejection;
    if (!this.expected) return undefined;
    const snapshot = evidence
      ? (this.ingressSnapshots.get(evidence) as RegistrationSnapshot | undefined)
      : this.registrationSnapshot;
    if (evidence) this.assertIngressCaptureActive(evidence, input.entryPath);

    if (!snapshot) return undefined;

    const diagnostics = ingressCaptureDiagnostics.get(this)!;
    const request: GuardChildContextRequest = Object.freeze({
      ...input,
      delegationId: `sg-del-${diagnostics.epoch}-${++diagnostics.sequence}`,
    });
    const fail = (): never => {
      throw new GuardBridgeRejection(
        "guard-child-context-failed",
        input.entryPath,
        `guard-child-context-failed: guarded work is unavailable at ${input.entryPath}; child context callback failed validation; child dispatch was stopped.`,
      );
    };

    let returned: unknown;
    try {
      returned = await snapshot.callbacks.createChildContext(request);
    } catch {
      this.assertRegistrationSnapshotActive(snapshot, input.entryPath);
      return fail();
    }
    this.assertRegistrationSnapshotActive(snapshot, input.entryPath);
    if (returned === null || typeof returned !== "object" || Array.isArray(returned)) return fail();

    try {
      const value = returned as GuardChildContext;
      // Read callback-owned properties once. In-process callbacks can return
      // accessors/proxies, so validating one read and retaining another is not
      // safe; all validation and copying below uses these snapshots.
      const rootId = value.rootId;
      const parentId = value.parentId;
      const childId = value.childId;
      const delegationId = value.delegationId;
      const taskId = value.taskId;
      const scopeRevision = value.scopeRevision;
      const executionEpoch = value.executionEpoch;
      const resolvedRestrictions = value.resolvedRestrictions;
      const origin = value.origin;
      const bridgeRef = value.bridgeRef;
      if (
        childId !== request.childId || parentId !== request.parentId ||
        delegationId !== request.delegationId || origin !== request.origin ||
        bridgeRef !== this.registration ||
        typeof rootId !== "string" || rootId.length === 0 || rootId.length > 256 ||
        typeof taskId !== "string" || taskId.length === 0 || taskId.length > 256 ||
        typeof scopeRevision !== "number" || !Number.isSafeInteger(scopeRevision) || scopeRevision < 0 ||
        typeof executionEpoch !== "number" || !Number.isSafeInteger(executionEpoch) || executionEpoch < 0 ||
        !Array.isArray(resolvedRestrictions)
      ) return fail();

      const restrictionCount = resolvedRestrictions.length;
      if (restrictionCount > 128) return fail();
      let totalReferenceBytes = 0;
      const restrictions: GuardTextReference[] = [];
      for (let index = 0; index < restrictionCount; index++) {
        const reference = resolvedRestrictions[index] as GuardTextReference | undefined;
        if (!reference || typeof reference !== "object") return fail();
        const sourceIdentity = reference.sourceIdentity;
        const sourceVersion = reference.sourceVersion;
        const textReference = reference.textReference;
        if (
          typeof sourceIdentity !== "string" || sourceIdentity.length === 0 || sourceIdentity.length > 512 ||
          typeof sourceVersion !== "string" || sourceVersion.length === 0 || sourceVersion.length > 512 ||
          typeof textReference !== "string"
        ) return fail();
        const sourceIdentityBytes = Buffer.byteLength(sourceIdentity, "utf8");
        const sourceVersionBytes = Buffer.byteLength(sourceVersion, "utf8");
        const textReferenceBytes = Buffer.byteLength(textReference, "utf8");
        const entryBytes = sourceIdentityBytes + sourceVersionBytes + textReferenceBytes;
        totalReferenceBytes += entryBytes;
        if (
          sourceIdentityBytes > 512 || sourceVersionBytes > 512 || textReferenceBytes > 65_536 ||
          entryBytes > 66_560 || totalReferenceBytes > 1_048_576
        ) return fail();
        restrictions.push(Object.freeze({ sourceIdentity, sourceVersion, textReference }));
      }
      const context: GuardChildContext = Object.freeze({
        rootId,
        parentId: request.parentId,
        childId: request.childId,
        delegationId: request.delegationId,
        taskId,
        scopeRevision,
        executionEpoch,
        resolvedRestrictions: Object.freeze(restrictions),
        origin: request.origin,
        headless: request.headless,
        bridgeRef: this.registration!,
      });
      this.assertRegistrationSnapshotActive(snapshot, input.entryPath);
      return context;
    } catch {
      return fail();
    }
  }



  /** Current frozen enrollment-registration identity, used to scope child deduplication. */
  /** Current frozen enrollment-registration identity, used to scope child deduplication. */
  getResourceEnrollmentSnapshotIdentity(): object | undefined {
    return this.registrationSnapshot;
  }

  /** Fail closed if child construction no longer owns the exact validated registration. */
  assertChildInjectionSnapshot(snapshot: object | undefined, entryPath: GuardEntryPathId): void {
    if (!this.expected) return;
    if (snapshot === this.registrationSnapshot && snapshot !== undefined) return;
    throw new GuardBridgeRejection(
      "guard-child-injection-failed",
      entryPath,
      `guard-child-injection-failed: guarded work is unavailable at ${entryPath}; the validated guard registration changed before child construction.`,
    );
  }

  /** Resolve one child-mode factory from the exact frozen registration snapshot. */
  async createChildGuardExtension(
    context: GuardChildContext,
    snapshot: object | undefined,
    entryPath: GuardEntryPathId,
  ): Promise<PreparedGuardChildInjection> {
    this.assertChildInjectionSnapshot(snapshot, entryPath);
    const registrationSnapshot = snapshot as RegistrationSnapshot;
    const createFactory = registrationSnapshot.createChildGuardExtension;
    const fail = (): never => {
      throw new GuardBridgeRejection(
        "guard-child-injection-failed",
        entryPath,
        `guard-child-injection-failed: guarded work is unavailable at ${entryPath}; child guard injection could not be prepared.`,
      );
    };
    if (context.bridgeRef !== this.registration || !Object.isFrozen(context)) return fail();

    if (typeof createFactory !== "function") return fail();
    const handle: GuardChildInjection = Object.freeze({
      childId: context.childId,
      headless: context.headless === true,
      token: Symbol("pi-subagents.guard-child-injection"),
    });
    issuedGuardChildInjectionHandles.add(handle);
    let extensionFactory: unknown;
    try {
      extensionFactory = await createFactory(context, handle);
    } catch {
      this.assertChildInjectionSnapshot(snapshot, entryPath);
      return fail();
    }
    this.assertChildInjectionSnapshot(snapshot, entryPath);
    if (typeof extensionFactory !== "function") return fail();
    const childFactory = extensionFactory as ExtensionFactory;
    const capabilityCheckedFactory: ExtensionFactory = (api) => {
      if (
        !issuedGuardChildInjectionHandles.has(handle) ||
        handle.childId !== context.childId ||
        getGuardChildContext(api.events)?.childId !== handle.childId
      ) return fail();
      return childFactory(api);
    };
    return Object.freeze({ extensionFactory: capabilityCheckedFactory, handle });
  }


  /** Assert that capture evidence is still bound to its original frozen registration. */
  assertIngressCaptureActive(evidence: GuardIngressEvidence | undefined, entryPath: GuardEntryPathId): void {
    if (!evidence) return;
    const snapshot = this.ingressSnapshots.get(evidence);
    if (!snapshot) {
      throw new GuardBridgeRejection(
        "guard-missing",
        entryPath,
        `guard-missing: guarded work is unavailable at ${entryPath}; ingress evidence is not bound to this guard registration.`,
      );
    }
    this.assertRegistrationSnapshotActive(snapshot, entryPath);
  }

  /** Reject work if the exact frozen registration captured before an await is no longer active. */
  assertRegistrationSnapshotActive(snapshot: object | undefined, entryPath: GuardEntryPathId): void {
    if (this.registrationSnapshot === snapshot) {
      if (snapshot === undefined && this.expected) this.assertGuard(entryPath);
      return;
    }
    if (this.expected && this.registrationSnapshot === undefined) this.assertGuard(entryPath);
    throw new GuardBridgeRejection(
      "guard-missing",
      entryPath,
      `guard-missing: guarded work is unavailable at ${entryPath}; the guard registration changed while the operation was pending.`,
    );
  }

  /** Enroll through one caller-selected frozen registration snapshot. */
  async enrollResourceForSnapshot(
    enrollment: GuardResourceEnrollment,
    entryPath: GuardEntryPathId,
    snapshot: object | undefined,
  ): Promise<boolean> {
    const requirement = this.requireGuard(entryPath);
    if (!requirement.ok) throw requirement.rejection;
    this.assertRegistrationSnapshotActive(snapshot, entryPath);
    if (!snapshot) return false;

    // The identity is opaque to callers; the host owns the concrete immutable snapshot.
    const registrationSnapshot = this.registrationSnapshot;
    if (registrationSnapshot !== snapshot) this.assertRegistrationSnapshotActive(snapshot, entryPath);
    try {
      await (registrationSnapshot as RegistrationSnapshot).callbacks.enrollResource(enrollment);
      this.assertRegistrationSnapshotActive(snapshot, entryPath);
      return true;
    } catch (error) {
      if (error instanceof GuardBridgeRejection) throw error;
      throw new GuardBridgeRejection(
        "guard-enrollment-failed",
        entryPath,
        `guard-enrollment-failed: guarded work is unavailable at ${entryPath}; resource enrollment callback failed; child dispatch was stopped.`,
      );
    }
  }

  /** Enroll applicable child resources through the currently active snapshot. */
  async enrollResource(
    enrollment: GuardResourceEnrollment,
    entryPath: GuardEntryPathId = "agent-manager.spawn",
  ): Promise<boolean> {
    return this.enrollResourceForSnapshot(enrollment, entryPath, this.registrationSnapshot);
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
