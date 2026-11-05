# Guard bridge contract

`pi-subagents.guard-bridge` is an in-process, versioned contract between the extension and an optional scope-guard owner. Protocol version **1** describes the boundary only; the bridge does not decide whether work is authorized.

## Advertisement and registration

The protocol header advertised from `subagents:ready` and the read-only `subagents:rpc:guard-bridge` RPC is:

```ts
{
  protocol: "pi-subagents.guard-bridge",
  protocolVersion: 1,
  outcomes: [
    "allowed", "approval-needed", "stopped", "denied", "dismissed",
    "cancelled", "unavailable", "ui-error"
  ]
}
```

The readiness and RPC values also expose the effective `guardExpected` boolean, the configured `guardRegistrant` (or `null`), and `configDiagnostic` (or `null`), alongside registration diagnostics when present. A guard can use these values at startup to verify the fork's effective state.

The readiness advertisement is intentionally additive even when `guardExpected` is false: `subagents:ready` includes a `guardBridge` property containing the effective guard/registrant and registration diagnostics (upstream v0.19.0 emitted `{}`). This is observable to every readiness listener. The read-only guard-bridge RPC similarly advertises the bridge. For guard-off child construction, `runAgent`/`resumeAgent` also receive the internal `guardBridgeHost` and `guardExpected: false` options so a later optional registration can enroll resources; a valid optional registration is forwarded in those internal options. These runner-call options are visible to in-process instrumentation/mocks, not to the manager record, completion event, transcript, or tool result. The fork does not create child-context fields or the `subagents:child-context-query` responder/event bus when the guard is off. `guardRegistrant` is persisted only when explicitly configured in project settings; the fork does not materialize an unset value.

A registration has `registrant: { id: string, version: string }`. A guard listens for `subagents:ready` and registers after that signal by emitting `subagents:guard:register` with the object as its event payload. `AgentManager.registerGuard` is host-internal and is not exposed on the public manager registry. The event listener accepts registrations only while a session is active (after `session_start` and before shutdown/switch); pre-start, post-shutdown, and post-switch attempts are rejected diagnostically and never emit readiness. The host retains the first valid registration from the configured expected registrant by reference: same-object registration is idempotent, while a different object is rejected and recorded as `registrationRejected`. A missing, malformed, or mismatched registrant is rejected as `guard-wrong-registrant` without consuming the first-wins slot. Registration also requires integer protocol version `1` and every required callback to be a function; if present, `createChildGuardExtension` must also be a function. Null/undefined payloads, missing/non-function callbacks, throwing property getters, and throwing Proxy traps are incompatible rather than escaping the listener.

The root host retains the original registration object as the identity checked against callback-owned `GuardChildContext.bridgeRef` values. On first registration, it snapshots the protocol version, registrant, bound required callbacks, and optional `createChildGuardExtension` hook into a frozen validation snapshot, plus a frozen public registration value. The trusted child-context value retains its bridge identity for host-side checks; extension-facing `getGuardChildContext(pi.events)` instead returns a frozen context copy whose `bridgeRef` is a facade without the child-factory hook. Guarded `runAgent` and `resumeAgent` receive that frozen public value and the snapshot identity captured at their manager boundary; a queue drain or later continuation cannot silently switch to a replacement registration. A same-object re-registration does not re-read potentially hostile getters. `registrationRejected` is the current rejection headline and is cleared by a later successful registration; `registrationRejectionHistory` retains the bounded recent diagnostics. A rejected event registration re-emits `subagents:ready` at most once per rejection reason and at most three times per session; successful registration never re-emits it. Readiness is emitted once on every active `session_start`, including after `/new` or `/resume`, and never from the registration handler outside the active-session window. The read-only advertisement channel is `subagents:rpc:guard-bridge`.

`guardExpected` is a `subagents.json` boolean setting, default `false`. Set it to `true` to require registration before supported work starts, resumes, steers, or dispatches. A guarded child session additionally requires the optional `createChildGuardExtension` registration hook; see [Child guard injection](#child-guard-injection-task-53). When true, `guardRegistrant` must be a non-empty expected registrant id. Differing non-empty global/project values fail closed with `guard-registrant-conflict`; an unset or empty value fails closed with `guard-registrant-unconfigured`. Guard-off users (`guardExpected` false or absent) are not made to configure a registrant; when `guardRegistrant` IS configured, registrations are identity-checked even with `guardExpected` false (setting it opts in to identity checks), and a non-expected registrant is always reported as `guard-wrong-registrant`, including after the expected registrant registered. With no `guardRegistrant` configured no identity check applies. `guardExpected` enablement is monotonic across config layers and programmatic settings: a lower-precedence `false` cannot disable a `true`. The `/agents` snapshot preserves project-owned `guardExpected` and `guardRegistrant` values but never materializes global/programmatic-only values or implicit defaults.

Registrant identity is an accidental/misordering check, not authentication. In-process extensions are fully trusted code; a malicious extension can bypass an in-process guard. `guardExpected` proves only that a registration claiming the expected registrant id was accepted. No bridge field or diagnostic authenticates an extension.

A present non-boolean `guardExpected` value (including `null`) fails closed as `true` and emits a visible warning; its reason is exposed as `guardExpectedDiagnostic` in both readiness and the RPC advertisement. Valid `false` and an absent key remain false. A malformed JSON settings file fails closed when its raw text contains `guardExpected` or `guardRegistrant`; malformed files without those substrings retain the upstream settings fallback behavior. An existing unreadable settings file warns and is ignored without forcing `guardExpected` on. The advertisement's `configDiagnostic` identifies the unreadable path; a guard that expected an effective `guardExpected: true` must treat an observed `false` as unavailable. Queue delay does not preserve old approval to start: manager spawn and background-resume paths re-assert registration at queue drain, before child session creation or resumed-run record mutation, and fail the queued record with the exact guard error if registration no longer passes. With the default `false`, no registration is required and incompatible registrations are not forwarded to child runners.


## Contract types

The public bridge types are in `src/guard-bridge.ts`:
- **Ingress evidence** (`GuardIngressEvidence`): ingress ID, original raw text, optional transformed text, explicit `complete`/`partial`/`unknown` coverage, target, origin and entry-path ID; optional `childId`/`delegationId`/`parentId` attach input to an existing child without minting a new context.
- **Resource enrollment** (`GuardResourceEnrollment`): skill, template, or agent-definition identity/version and its restriction-text references. `resolution` is optional and defaults to `resolved` for protocol-version-1 compatibility; unresolved resources carry identity, `sourceVersion: "unresolved"`, and no text references.
- **Child context** (`GuardChildContextRequest`, `GuardChildContext`): fork-known delegation facts are requested from the guard; the guard returns root/task identities, scope revision/epoch, and narrowed resolved restriction references.

- **Child injection** (`GuardChildInjection`, `GuardChildGuardFactory`, `PreparedGuardChildInjection`): a per-session symbol handle and a prepared inline factory, bound to a validated child context.
- **Approval and revalidation** (`GuardApprovalRequest`, `GuardApprovalResponse`, `GuardBridgeCallbacks`): exact action/targets and authority/evidence references, bound to root/task/optional child identity, input generation, decision revision, execution epoch and an opaque lifetime token; callbacks capture ingress, enroll resources, create child contexts, revalidate, and report settled/cancelled/expired approval requests.
- **Scheduled scope** (`GuardScheduleScopeRequest`, `GuardScheduleScope`): guard-minted opaque scope ID, bounded expiry/run limit and target bindings for unattended work; target bindings are validated then discarded by the fork.

The bridge carries these shapes and callbacks; it does not implement interpretation, authorization, persistence, queueing, or UI behavior.

A manager-registry `spawn` with synchronous ingress capture returns the agent ID synchronously, including when `guardExpected` is true. Because this shape cannot reject after returning, a guarded context-creation failure is retained on the ID's record as `status: "error"` and `error`, accessible through `getRecord(id)`. When the registered `captureIngress` callback returns a promise, `spawn` returns `Promise<string>`, starts only after capture settles, and awaits startup; startup failure rejects that promise. A never-resolving capture callback leaves work unstarted and does not notify the user.
## Child context ownership (task 5.1)

A child context is created once before each child spawn or resume when `guardExpected` is true and the active registration exists. The callback is taken from the immutable registration snapshot, not re-read from the mutable registration object. The manager claims the applicable concurrency slot and arms abort handling before awaiting this callback, so pending context creation remains bounded and abortable. A context callback that resolves without a valid context fails closed. Protocol version remains **1**. The callback parameter is an additive v1 type change: consumers typed against `Omit<GuardChildContext, "bridgeRef">` must update to `GuardChildContextRequest`; the protocol advertisement is unchanged.

```ts
export type GuardChildScopeRefStatus = "provided" | "unresolved" | "not-applicable";

export interface GuardChildContextRequest {
  childId: string;
  parentId: string;
  delegationId: string;
  origin: GuardOrigin;
  entryPath: GuardEntryPathId;
  operation: "spawn" | "resume";
  ingressId?: string;
  parentContext?: GuardChildContext;
  inheritContext: boolean;
  isolatedExtensions: boolean;
  worktree: boolean;
  scopeRef?: string;
  scopeRefStatus: GuardChildScopeRefStatus;
  /** Fork-observed fact; true when the root ExtensionContext.hasUI is false. */
  headless: boolean;
  scheduled?: { jobId: string; runIndex: number; expiresAt: string };
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
  /** Fork-observed root UI availability, forwarded to the injected guard. */
  headless?: boolean;
  bridgeRef: GuardBridgeRegistration;
}

createChildContext(request: GuardChildContextRequest): GuardChildContext | Promise<GuardChildContext>;
```

| Entry-path ID | Context behavior and origin | Correlation / parent |
| --- | --- | --- |
| `agent-manager.spawn` | Creates context for each guarded spawn; inherits outer origin. | Outer ingress ID; parent record context when nested, otherwise `root:<session id>`. |
| `agent-manager.spawn-and-wait` | Same context creation as spawn. | Outer ingress ID and nested parent context where applicable. |
| `agent-manager.resume` | Recreates context before resume; inherits current parent scope. | Resume ingress ID and current parent context. |
| `agent-manager.steer` | No new context; attach existing child identity to ingress. | Existing `childId`, `delegationId`, `parentId`. |
| `agent-manager.pending-steer` | No new context; validate queued evidence against its captured registration before replay. | Existing child identity and retained ingress evidence. |
| `agent-tool.spawn-background` | Spawn context; `parent-model-delegation`. | Captured Agent prompt ingress ID. |
| `agent-tool.spawn-foreground` | Spawn context; `parent-model-delegation`. | Captured Agent prompt ingress ID. |
| `agent-tool.resume-background` | New resume context; `parent-model-delegation`. | Resume ingress ID and existing child identity in evidence. |
| `agent-tool.resume-foreground` | New resume context; `parent-model-delegation`. | Resume ingress ID and existing child identity in evidence. |
| `agent-tool.steer` | No new context; `parent-model-delegation`. | Existing child identity on ingress evidence. |
| `nested-agent.spawn-background` | Spawn context; `parent-model-delegation`. | Captured ingress ID and retained parent child context. |
| `nested-agent.spawn-foreground` | Spawn context; `parent-model-delegation`. | Captured ingress ID and retained parent child context. |
| `nested-agent.resume` | New resume context; `parent-model-delegation`. | Resume ingress ID and retained parent child context. |
| `nested-agent.steer` | No new context; `parent-model-delegation`. | Existing child identity on ingress evidence. |
| `mention.input-start` | Context for direct start or direct fallback; `human`. | Reuses the one mention ingress capture. |
| `mention.input-clone` | Creates one ephemeral in-memory clone context; `human`. | Reuses mention ingress capture; spawned agent receives it as parent context. |
| `mention.input-resume` | Context for live resume or tombstone reopen; `human`. | Reuses mention ingress and existing child identity when live. |
| `mention.input-steer` | No new context; `human`. | Existing child identity on ingress evidence. |
| `cross-extension-rpc.spawn` | Spawn context; `extension-request`. | RPC ingress ID; optional scope reference is only a hint. |
| `manager-registry.spawn` | Spawn context; `extension-request`. | Registry ingress ID; optional scope reference is only a hint. |
| `scheduled-task.fire` | Spawn context; passes the persisted scope reference as `provided` only for a scope minted in this process, otherwise `unresolved`; uses retained scheduled origin only for locally minted scopes, else `imported-context`. | In-memory schedule-creation ingress ID only; jobs restored from disk have no ingress correlation. Carries `{jobId, runIndex, expiresAt}`. |
| `workflow-tool.dispatch` | Dispatch wrapper; actual child contexts are created at `workflow-host.spawn`. | Workflow origin passed to the host. |
| `workflow-cli-flag.dispatch` | Dispatch wrapper; actual child contexts are created at `workflow-host.spawn`. | Imported workflow context. |
| `workflow.pi-exec.gate` | No child context: this is a concrete `pi.exec` effect, not a child run. | Concrete effect authorization. |
| `worktree.create`, `worktree.capture`, `worktree.remove`, `worktree.prune` | No new child context; attach existing child identity/context where available. | Concrete package-owned git effects; prune is unbounded. |
| `agent-runner.detect-env` | Existing child context when present. | Concrete unbounded child git observation. |
| `agents-command.generate-definition` | Spawn context; `human`. | Captured description ingress ID. |
| `conversation-viewer.steer` | No new context; origin remains `human`, including when aimed at a child. | Existing child identity on ingress evidence. |
| `fleet-viewer.steer` | No new context; origin remains `human`, including when aimed at a child. | Existing child identity on ingress evidence. |
| `agent-runner.turn-limit-steer` | No new context; `package-system-control`. | Existing child identity on ingress evidence. |
| `workflow-host.spawn` | Spawn context with inherited workflow origin. | Captured worker-prompt ingress ID and optional workflow parent context. |
| `workflow-host.resume` | New resume context with inherited workflow origin. | Captured resume-prompt ingress ID and existing parent context. |
| `agent-tool.schedule-create` | Under `guardExpected`, requires `createScheduleScope` to mint the job's explicit bounded scope; does not create a child context yet. | Captures prompt ingress and creator context for scope creation and later fire correlation. |

No child-context callback runs and no child-context identity or context fields are added to records or runner options when `guardExpected` is false, even if an optional registration exists. `runAgent`/`resumeAgent` do retain the internal host and false flag described above for guard-off resource enrollment, and pass an optional registration only when one is active. The readiness `guardBridge` advertisement remains publicly visible. The fork does not install the child-context-query responder/event bus unless guarded child construction is enabled. This preserves upstream work/record behavior apart from those documented bridge-discovery and internal-option surfaces. If `guardExpected` is true, a missing registration or a callback that returns no valid context is a failure, not an unguarded fallback.


**Fork-owned facts:** manager record `childId` (or host-generated ephemeral ID for the mention clone), record/root-marker `parentId`, host-generated `delegationId` (`sg-del-<epoch>-<sequence>`, sharing the ingress sequence), origin, entry path, operation, ingress correlation, isolation flags, parent context, and optional scope-reference hint. None derive from prompt text. Schedule creation origin and ingress correlation are retained only in process memory for the session that created a job; they are not trusted from schedule files. Restored jobs use `imported-context` without ingress correlation, and `human` is available for a scheduled fire only when captured from a human-origin creation in that process.

**Guard-owned facts:** returned `rootId`, `taskId`, `scopeRevision`, `executionEpoch`, and `resolvedRestrictions`. The fork cannot infer grants or mint human authority. `scopeRefStatus: "provided"` is emitted only from the fork's in-memory bookkeeping for a schedule scope minted in this process; extension/RPC scope hints are trimmed, marked `unresolved`, and never promote themselves to `provided`. Human mention/viewer input aimed at a child stays `human`; expansion beyond delegated scope remains for the root approval path.

**Validation and failure:** the host requires an object response, exact requested `childId`/`parentId`/`delegationId`/`origin`, exact active `bridgeRef`, non-empty bounded `rootId` and `taskId`, non-negative safe-integer revision/epoch, and at most 128 restriction references. Each reference identity/version is at most 512 characters and 512 UTF-8 bytes; each text reference is at most 65,536 UTF-8 bytes. The aggregate bound counts the complete UTF-8 bytes of every entry (including identity and version even when text is empty) and is 1 MiB. The host reads each returned field once, walks a captured array length by index, and retains a fresh frozen deep copy. Throw, rejection, missing/malformed fields, identity mismatch, foreign bridge reference, or out-of-bound references yield content-free `guard-child-context-failed`; the child is not started/resumed. A supplied parent context must belong to the currently active registration. Snapshot replacement rejects the pending continuation. The callback is raced against the run's abort signal: abort releases the slot, drains eligible queued work, settles the operation as stopped, and ignores a late callback result or rejection. Without an abort, an ordinary spawn/resume context callback has no timeout and continues to hold its slot; scheduled fires additionally use the 10-second fire-time bound below.

**Resume and steer:** every accepted resume creates a new delegation ID/context so the guard can apply current parent restrictions. With `guardExpected` enabled, a resume of a record that is already running, queued, or awaiting its context callback is rejected before another callback or session-state mutation; guard-off behavior remains unchanged. A supplied parent context is operation-scoped and is not retained on the resumed child record. Nested children instead resolve their parent from the live parent record's current validated context on each operation. Steer does not mint a context or delegation; it carries existing child identity on fresh ingress evidence. Package turn-limit steering remains `package-system-control`. Queued steers retain evidence and reassert the captured registration before replay. The mention clone's ephemeral context is only forwarded to the child operation that it accompanies; later resumes do not reuse its scope revision, epoch, or child ID.
**Explicit limits:** registration identity is not authentication. Child-mode guard injection/inert discovery is specified below; workflow `pi.exec` effect guarding is task 5.4; scheduled-scope enforcement is task 5.5. The ephemeral mention clone is a host-tracked in-memory context, not a persistent manager record.


## Child guard injection (task 5.3)

A valid v1 registration may carry the additive optional hook:

```ts
export type GuardChildGuardFactory = (
  context: GuardChildContext,
  injection: GuardChildInjection,
) => ExtensionFactory | Promise<ExtensionFactory>;

export interface GuardChildInjection {
  childId: string;
  /** Fork-observed fact copied from GuardChildContextRequest.headless. */
  headless: boolean;
  /** Per-session symbol; not serialized into prompts or transcripts. */
  token: symbol;
}
```

`ExtensionFactory` is Pi's `(pi: ExtensionAPI) => void | Promise<void>`. The fork invokes the hook from the active frozen registration snapshot, after it has created and validated that session's child context. The returned value must be a function. The fork appends exactly one named `guard-child-injection` inline factory as the last extension factory in the child's `DefaultResourceLoader`; Pi binds its `tool_call` hook after the ordinary discovered extension hooks. The child is not prompted unless the inline factory loaded successfully. Protocol version and the `subagents:ready` advertisement remain v1; `createChildGuardExtension` is optional in guard-off deployments and required only when `guardExpected: true` is constructing a child session.

| Construction path | Injection ownership |
| --- | --- |
| Spawn, foreground spawn, nested spawn, worktree, and `isolated: true` / `extensions: false` | `AgentManager.startAgent` forwards the frozen snapshot and validated context to `runAgent`; `runAgent` prepares one factory before creating the child session. |
| Resume that opens a new session file (including a mention tombstone reopen) | Same `runAgent` construction path; the new session receives its own injection. |
| Resume/re-prompt of an already-created session | `resumeAgent` never calls the child factory again. It checks that the session's original injection snapshot is still active, then uses the fresh resume context. A replaced or missing snapshot cannot continue the session. |
| Mention clone | `runMentionClone` creates a separate inline factory for the ephemeral cloned session and keeps its one-tool `Agent` allowlist unchanged. |
| Workflow-host spawn | Uses manager spawn-and-wait and therefore the ordinary `runAgent` injection path. |

The injected factory is the only authorization owner in a guarded child. The fork does not add tools: tools the inline guard registers are kept only when their names are already in the child's effective active tool set. This lets the guard wrap/override a built-in or extension tool the child was actually given without adding guard-only tools. It does not widen `tools:` allowlists, restore excluded extension paths, or re-enable built-ins under extension-disabled isolation. Ordinary tools remain exactly under the existing `tools`, `disallowed_tools`, `extensions`, and `exclude_extensions` gates; only the inline guard factory is mandatory. Worktree `cwd` and `configCwd` selection are unchanged.

Ordinarily discovered guard copies must opt into the child-inert contract. During child resource loading, the fork marks that child's own extension event bus with its validated context. A discovered extension can synchronously query the marker with the public `getGuardChildContext(pi.events)` helper (also exported from `src/index.ts`); `undefined` means there is no child marker. When the non-configurable marker exists, it is authoritative; the marker-backed query responder is installed before child extensions load and its first response wins over later query responders. Its frozen context copy keeps `GuardChildContext.bridgeRef` source-compatible but exposes a frozen registration facade without `createChildGuardExtension`; the injected instance alone receives the `GuardChildInjection` handle in its factory closure; the fork tracks issued handle objects in a module-private `WeakSet` and validates that capability when the inline factory runs. A discovered copy has no handle and must return without installing policy or UI when it sees a child context. `inChildSessionContext()` remains source-compatible as a supplemental host-local signal, but separately loaded extensions must use the event-bus marker as their child-context signal. The marker is per-session, not prompt text, a global lookup registry, or authentication. On resume, the marker is updated before the next prompt, so the injected guard should read it when handling the next operation. The deprecated `GUARD_CHILD_CONTEXT_UPDATED_EVENT` export remains for source compatibility, but the fork no longer emits a public bus event for refreshes.

This is load-order hygiene and capability separation between ordinary discovered copies and the injected instance, not authentication or a sandbox. In-process extensions are trusted code; this hardens accidental/misordered use and reduces accidental access to the injection hook, but does not defend against deliberately hostile extensions with other in-process access.

Absence of the hook, a synchronous throw/rejection, a non-function result, an unloaded or misplaced/duplicated inline factory, or a registration snapshot replacement/unregister before construction fails with content-free `guard-child-injection-failed`. A never-settling hook is raced against the run's abort signal where available; on paths without an abort signal (including idle mention-clone preparation), the fork applies `GUARD_CHILD_INJECTION_TIMEOUT_MS`, a code-configurable 10-second default, then fails closed with the same bounded error. Late settlement is ignored. Guarded mention clones emit bounded `session_shutdown` before disposal, just like other fork-created sessions that bind extensions. Wrong registrants and incompatible protocol/callback registrations fail earlier with their registration rejection code. No child tool or prompt starts on any of these failures.

This is load-order hygiene for the hooks Pi exposes, not a complete dispatch-integrity proof. Dynamically registered handlers, retained mutable argument references, or a third-party hook installed after session construction remain outside this injection contract; they are not made protected by this feature. In-process extensions remain trusted code.


## Ingress capture

For every owned ingress, the fork calls `captureIngress` at the outermost supported path that still has the original input, before it consumes, rewrites, starts, resumes, or steers work. The host assigns a unique opaque ID using its own epoch plus a per-host monotonic sequence; IDs never derive from prompt text. Evidence is frozen before it reaches the registration callback. `rawText` is the exact original text available at that boundary; `transformedText` is included only when the fork rewrites it. `coverage` is `complete` only when the original evidence is fully available; `partial`/`unknown` remain unresolved rather than being upgraded to human authority. The RPC and manager-registry spawn envelopes accept an optional `scopeRef`; without one the child context request is explicitly unresolved, and even a provided reference is only a hint for the guard to recognize.

Each physical input is captured exactly once. Inner manager/runner boundaries do not recapture an input already owned by an outer path; the mention-clone fallback also reuses the mention's capture rather than emitting a second ingress when it starts a direct fallback agent. Origins are explicit: human prompts/mentions/viewer entries are `human`; Agent/nested-tool delegation is `parent-model-delegation`; registry/RPC work is `extension-request`; turn-limit steering is `package-system-control`. Captured input must never be treated as approval based on user role, wording, or source labels alone.

A capture callback that throws (synchronously or asynchronously) is non-fatal to the fork path: the host records a bounded, content-free diagnostic (count and at most ten recent messages), then the path continues. A guard must treat the absent callback evidence as unresolved; callback failure is not an allow or grant. Capture evidence is bound to the exact frozen registration snapshot that received it. The host rejects capture settlement if that snapshot was unregistered or replaced, and every consuming continuation must verify that same capture binding; a fresh `assertGuard` alone is insufficient because it could accept a replacement that never saw the input. A callback that never resolves intentionally fails closed at ingress: the input is held and its consuming action does not run. There is no timeout, and the user is not notified while the callback remains pending. The guard's generic Pi `input` handler may also observe the same physical prompt. Correlation is by host dispatch order/ingress ID, never by matching prompt text. Ordinary conversational prompts are captured by the guard-side generic `input` handler, not by this fork; this fork directly captures only the owned paths below. A generic handler registered later cannot recover text already consumed or transformed by another handler.


## Supported entry-path inventory

| Entry-path ID | Source location | Gate kind |
| --- | --- | --- |
| `agent-manager.spawn` | `src/agent-manager.ts` — `AgentManager.spawn`, `AgentManager.startAgent` (initial and queue-drain re-check) | manager boundary / spawn |
| `agent-manager.spawn-and-wait` | `src/agent-manager.ts` — `AgentManager.spawnAndWait` | manager boundary / foreground spawn |
| `agent-manager.resume` | `src/agent-manager.ts` — `AgentManager.resume`, `AgentManager.startResume` (initial and queue-drain re-check) | manager boundary / resume |
| `agent-manager.steer` | `src/agent-manager.ts` — `AgentManager.steer` | manager boundary / steer |
| `agent-manager.pending-steer` | `src/agent-manager.ts` — `AgentManager.startAgent` session-created callback | manager boundary / queued steer |
| `agent-tool.spawn-background` | `src/index.ts` — `Agent.execute` background branch | tool / spawn |
| `agent-tool.spawn-foreground` | `src/index.ts` — `Agent.execute` foreground branch | tool / spawn-and-wait |
| `agent-tool.resume-background` | `src/index.ts` — `Agent.execute` background resume branch | tool / resume |
| `agent-tool.resume-foreground` | `src/index.ts` — `Agent.execute` foreground resume branch | tool / resume |
| `agent-tool.steer` | `src/index.ts` — `steer_subagent.execute`; `src/agent-runner.ts` — `steerAgent` | tool / steer |
| `nested-agent.spawn-background` | `src/nested-tools.ts` — nested `Agent.execute` background branch | nested tool / spawn |
| `nested-agent.spawn-foreground` | `src/nested-tools.ts` — nested `Agent.execute` foreground branch | nested tool / spawn-and-wait |
| `nested-agent.resume` | `src/nested-tools.ts` — nested `Agent.execute` resume branch | nested tool / resume |
| `nested-agent.steer` | `src/nested-tools.ts` — `steerTool.execute` | nested tool / steer |
| `mention.input-start` | `src/index.ts` — input mention handler start and clone-fallback branches | input / spawn |
| `mention.input-clone` | `src/index.ts` — input mention handler `runMentionClone` branch | input / clone dispatch |
| `mention.input-resume` | `src/index.ts` — input mention handler live resume and tombstone reopen branches | input / resume |
| `mention.input-steer` | `src/index.ts` — input mention handler live steer branch | input / steer |
| `cross-extension-rpc.spawn` | `src/cross-extension-rpc.ts` — `registerRpcHandlers` spawn handler | RPC / spawn |
| `manager-registry.spawn` | `src/index.ts` — manager registry `spawn` | programmatic registry / spawn |
| `scheduled-task.fire` | `src/schedule.ts` — `SubagentScheduler.executeJob` | scheduler / spawn |
| `workflow-tool.dispatch` | `src/index.ts` — `SubagentWorkflow.execute` | workflow tool / dispatch |
| `workflow-cli-flag.dispatch` | `src/index.ts` — `runWorkflowFlag` | CLI flag / dispatch |
| `workflow.pi-exec.gate` | `src/workflow/host.ts` — `executeGate` | workflow host / `pi.exec` gate |
| `worktree.create` | `src/worktree.ts` — create preflight and `git worktree add` | concrete git / worktree setup |
| `worktree.capture` | `src/worktree.ts` — status, stage, commit and local branch capture | concrete git / worktree capture |
| `worktree.remove` | `src/worktree.ts` — exact registered worktree removal | concrete git / worktree removal |
| `worktree.prune` | `src/worktree.ts` — crash-recovery prune, always unbounded | concrete git / prune |
| `agent-runner.detect-env` | `src/env.ts` — `git rev-parse` and branch observation | child runner / git observation |
| `agents-command.generate-definition` | `src/index.ts` — `showGenerateWizard` | command / spawn |
| `conversation-viewer.steer` | `src/index.ts` — `viewAgentConversation` | conversation viewer / steer |
| `fleet-viewer.steer` | `src/ui/fleet-list.ts` — `FleetList.openSelected` | fleet viewer / steer |
| `agent-runner.turn-limit-steer` | `src/agent-runner.ts` — `runAgent` turn-end handler | runner / package-origin steer |
| `workflow-host.spawn` | `src/workflow/host.ts` — `spawnAgent` | workflow host / spawn-and-wait |
| `workflow-host.resume` | `src/workflow/host.ts` — `resumeAgent`; `src/workflow/runtime.ts` — `runWorkflow.handleAgent` resume callback | workflow host / resume |
| `agent-tool.schedule-create` | `src/index.ts` — `Agent.execute` schedule branch | Agent tool / scheduled work creation |

## Concrete orchestration-effect review (task 5.4)

Protocol v1 has an additive optional callback. It is read once into the validated registration snapshot and invoked through that frozen callback; replacing/unregistering the snapshot while a review waits fails closed. `guardExpected: true` requires this callback at every instrumented effect boundary. Guard-off execution neither calls the callback nor adds request fields or process options. A never-settling review holds the effect's existing caller/child operation until its abort signal or bounded review timeout releases it; no effect command runs. Headless, scheduler-issued and no-abort-signal requests use the 10-second bound. There is intentionally no workflow-source pre-scan or source-text-derived allowlist.

```ts
reviewEffect(request: GuardEffectRequest): GuardOutcome | Promise<GuardOutcome>; // optional registration callback

interface GuardEffectRequest {
  effectId: string;
  kind: "workflow-exec" | "worktree-create" | "worktree-capture" |
        "worktree-remove" | "worktree-prune" | "child-git-observation";
  command: string;
  argv: readonly string[];
  cwd: string;
  envKeys: readonly string[]; // sorted names only; capped at 128
  envKeysTruncated?: true;
  envKeysTotalCount?: number;
  readOnly?: true; // exact fork allow-list of read-only git argv shapes
  scheduled?: true; // private manager-issued scheduler path
  headless?: boolean; // fork-observed root UI fact for bounded reviews
  resources: { worktreePath?: string; branch?: string; baseRepo?: string; parentWorkspace?: string };
  entryPath: GuardEntryPathId;
  childId?: string; parentId?: string; delegationId?: string; ingressId?: string;
  workflowId?: string; childContext?: GuardChildContext;
  ownedByPackage: boolean;
  boundTo: "owned-resources" | "unbounded";
}
```

The fork creates a fresh worktree path/branch reservation per child and records the exact resulting worktree path, administrative `.git/worktrees/<name>` gitdir, branch, base repository and delegation. Only a matching child id, resolved path, base repo, branch and command at the concrete git boundary is declared `ownedByPackage: true, boundTo: "owned-resources"`; for capture `commit` and `branch`, this additionally requires that a preceding `git add -A` for the same worktree in the same cleanup invocation received a successful `allowed` review. Without that prior allowed stage review (including a new cleanup invocation), commit/branch are `ownedByPackage: false, boundTo: "unbounded"`. Traversal, symlink escape, a sibling (even one sharing a path prefix), a changed branch (even one sharing a branch prefix), a different base-repository cwd, or a worktree `.git` pointer that no longer names the recorded gitdir cannot match. Each hardened worktree-add/capture/cleanup invocation is executed with the exact reviewed argv, including explicit `--git-dir`/`--work-tree`, `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, `-c core.sshCommand=/bin/false`, `-c protocol.allow=never`, `-c commit.gpgsign=false`, `-c gc.auto=0`, `-c gc.autoDetach=false`, and `-c maintenance.auto=false`. Before package-owned capture/removal, the administrative gitdir must still resolve from the worktree `.git` pointer, its real `commondir` must equal the recorded common gitdir, and `HEAD` must be detached at a SHA or point exactly at the intended `pi-agent-<child>` branch. A mismatch is refused and left for recovery. The child environment strips inherited `GIT_*` variables and sets `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`; the reviewed `envKeys` list is the deterministic sorted list actually passed to the command. Capture `git status` uses `--ignore-submodules=dirty`, but is always reviewed as `ownedByPackage: false, boundTo: "unbounded"` because repository-local attributes and filters can execute child-authored code. `git add -A` is also always unbounded for the same reason. A mismatched `.git` pointer is reviewed as unbounded and refused before git runs. Both the fallback prune inside `removeWorktree` and the dispose-time crash-recovery prune are unbounded because prune can affect repository-wide registrations. Any mismatched resource request remains visible to the guard as unbounded and cannot receive a package auto-allow.

| Concrete process boundary | Kind / entry path | Ownership declaration |
| --- | --- | --- |
| Workflow `gate:` command, both pre-cleanup and fallback `runGate` routes | `workflow-exec` / `workflow.pi-exec.gate` | Always unbounded, including `gh api -X POST`, `curl -X POST`, `git push`, or a gate running in a child worktree. It is reviewed before `pi.exec`; only `allowed` runs the exact shell argv/cwd once. |
| Worktree setup (`rev-parse`, then `worktree add`) | `worktree-create` / `worktree.create` | Exact read-only git probes carry `readOnly: true` while remaining `boundTo: "unbounded"`. The add command is bounded only to the fresh package reservation and exact base repo/path/branch. |
| Worktree capture (`status`, `add -A`, local `commit`, local `branch`) | `worktree-capture` / `worktree.capture` | Guarded `status` runs as `status --porcelain --ignore-submodules=dirty --untracked-files=all` and is always unbounded because repo-relative attributes/filters can execute child-authored code; it is not `readOnly`. `add -A` is also explicitly unbounded because child-authored clean filters from `.gitattributes`/local Git config cannot be made package-owned. Both use the hardened argv/environment and require guard review before execution. Commit and branch are package-owned only after a preceding `add -A` for the same worktree in the same cleanup invocation was reviewed and allowed; otherwise they are unbounded. No parent checkout/reset/stash/merge/push is part of this helper.
| Worktree removal | `worktree-remove` / `worktree.remove` | Bounded only for the exact recorded worktree path and base repo with the exact recorded child branch. |
| Worktree prune | `worktree-prune` / `worktree.prune` | Always unbounded, both in the `removeWorktree` fallback after removal fails and in the manager's dispose-time crash recovery, because it may touch registrations beyond one child-owned path. |
| Child startup git environment observation | `child-git-observation` / `agent-runner.detect-env` | Exact allow-listed read-only `rev-parse` / `branch --show-current` argv carries `readOnly: true` while remaining unbounded, and is reviewed before process execution. |

The worktree capture commit argv includes the bounded `agentDescription` text as the commit-message value (`pi-agent: ` plus at most 200 characters), and that exact argv is reviewed before execution. The process audit found no package execution of `git merge`, `apply`, `checkout`, `reset`, `stash`, `git push`, other remote git operations, or publication. The worktree cleanup's local commit and branch capture and its exact `git worktree remove` are the only parent-repository metadata paths; each is described at its concrete process boundary. The suggested merge command in a completion message is text for the user, not an executed command.

**Coverage is the concrete boundaries above, not a claim that parsing workflow text enumerates all future effects.** Not instrumented: effects inside arbitrary tools/processes of other extensions; direct effects inside tools used by a workflow's child agents (those are governed by that child's injected guard); commands an external workflow/extension runs outside this package; native filesystem/network effects that do not cross one of these package-owned `pi.exec` calls. In-process extensions are not sandboxed. The task-5.4 callback covers these boundaries only.

Rejection codes are `guard-effect-review-missing` (no optional callback under an expected guard), `guard-effect-denied` (`denied`/`stopped`), `guard-effect-approval-needed` (`approval-needed`), `guard-effect-cancelled` (`cancelled` outcome or abort), and `guard-effect-unavailable` (dismissed/unavailable/ui-error, throw/reject, invalid outcome, timeout, or replaced snapshot). Headless, scheduled, and no-abort-signal reviews are bounded at 10 seconds; the timeout fails closed. For guarded cleanup, each UI-root review is cancellable by Stop, abortAll, Esc/parent abort, and has a documented 10-minute cap; timeout/abort leaves the worktree and records bounded cleanup-pending coordinates (path, intended branch, branch-created flag, reason). Cancellation affects a pending review only, never an already-running Git command. Headless reviews retain their 10-second bound. Worktree creation and cleanup reviews do not consume the 30-second per-command deadline; that deadline starts only after approval. Every rejection prevents the corresponding process call. Environment values and full workflow source files/text are never copied into a request. Environment key names are sorted and capped at 128; when capped, `envKeysTruncated: true` and `envKeysTotalCount` report the original count. The concrete gate command itself is included because exact argv is required; requests otherwise contain cwd, bounded environment key names, declared resources and correlation identifiers. Environment values are omitted, but this is not a general detector/redactor for secrets embedded directly in command arguments.

### Bounded scheduled scopes and headless roots (task 5.5)

Protocol v1 has one additive optional callback, snapshotted and bound at registration:

```ts
interface GuardScheduleScopeRequest {
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
interface GuardScheduleScope {
  scopeId: string;
  expiresAt: string;
  maxRuns: number;
  targetBindings: readonly string[];
}
```

When `guardExpected` is true, creation requires this callback. The Agent tool exposes `expires_at` and `max_runs` only when `guardExpected` is true; guard-off tool definitions retain upstream shape. It receives the one captured prompt-ingress ID, normalized schedule/next run, optional `expires_at` / `max_runs` tool values, and the creator's fork-owned parent/child identity and validated context. The guard returns an opaque scope ID, expiry, run limit and 1–128 bounded opaque target bindings (each at most 512 UTF-8 bytes). The host snapshots callback functions once, bounds the call at 10 seconds (also raced against the Agent tool's abort signal), validates the response, and rejects a changed registration. Missing, throwing, rejecting, invalid, timed-out or aborted callbacks fail closed with `guard-schedule-scope-missing` or `guard-schedule-scope-failed`; no job is written or armed.

The fork's fixed code defaults are a **24-hour maximum lifetime** and **100-run maximum**; they are not currently settings-configurable. Missing `expires_at` / `max_runs` use those limits. Supplied values can only narrow them: expiry must parse as a future timestamp and is capped at creation time + 24 hours; `max_runs` must be a positive integer and is capped at 100. A stricter guard-returned expiry/run limit narrows further. The schedule file contains only `guardScopeId`, the fork-enforced `guardExpiresAt`, `guardMaxRuns` and `guardRunCount` among authority-related fields; target bindings are checked then discarded, not persisted. This schedule file is user-editable and is never authority: on load, malformed/missing scope metadata, an expiry beyond now + 24 hours, an invalid run limit/count, or an expired/exhausted job disables it with a bounded reason and emits one existing `subagents:scheduled` error notification. For a job minted in this process, the fork also keeps an immutable in-memory copy of its scope ID, expiry, run ceiling and spawn-affecting fields; any in-session edit to those fields disables the job with `guard-schedule-snapshot-mismatch`. Per-process counts are monotonic; lifetime and run ceilings are rechecked from frozen values before every fire.

At fire, `createChildContext` receives the opaque scope ID plus `scopeRefStatus: "provided"` only if the scope was minted in this process. A disk-loaded job always passes its stored ID as `scopeRefStatus: "unresolved"` and `origin: "imported-context"`, with no stored ingress ID or origin; the guard must decide whether that reference still resolves. A locally created job uses its in-memory creation origin/ingress. The request includes `scheduled: { jobId, runIndex, expiresAt }` with a 1-based incrementing run index. Expiry/exhaustion prevents dispatch, disables the job and emits one bounded error notification. Scheduled fire-time child-context acquisition is bounded at `GUARD_SCHEDULE_FIRE_TIMEOUT_MS` (10 seconds); timeout fails the child startup with `guard-child-context-failed` and is recorded by the scheduler, never waiting for another UI turn.

**Headless is a fork-observed fact, not a policy result.** For every guarded child request, `headless` is `!ExtensionContext.hasUI` for the currently bound root session. Print mode and every other mode without Pi's supported UI report `true`, even if a caller can still invoke an extension/RPC path; a TUI context with `hasUI` reports `false`. The host copies this fact into the validated child context and `GuardChildInjection.headless`, so the injected guard can return `approval-needed` immediately when human approval is needed and no supported root UI exists. The fork does not itself grant or approve work.

With `guardExpected: false` (with or without optional registration), schedule creation does not call `createScheduleScope`; the fork adds no scope/expiry/run/headless/scheduled fields to jobs or child-context requests and leaves the upstream scheduling path unchanged. The schedule-store format remains v1/backward-compatible: guard-off loads and writes preserve unknown job properties and their key order exactly as upstream; the allow-list and canonical field order are applied only when `guardExpected` is true. When guarded, authority-related fields are optional in the persisted format; old valid jobs load with unresolved scope status, while invalid/expired jobs are disabled rather than receiving ambient authority.

### Ingress capture ownership

The origin column names the evidence captured at that boundary. Manager-level inner paths inherit the origin of their listed outer caller. Workflow-host spawn/resume capture their worker prompt at that owned boundary, using the workflow's inherited origin. If `captureIngress` is asynchronous, a deferred steer is delivered only after capture completes and while its guard registration remains valid; a never-resolving callback leaves that input undelivered without notifying the user.

| Entry-path ID | Origin | Capture ownership |
| --- | --- | --- |
| `agent-manager.spawn` | inherited from outer path | captured at outer path `agent-tool.spawn-background`, `agent-tool.spawn-foreground`, `nested-agent.spawn-background`, `nested-agent.spawn-foreground`, `mention.input-start`, `mention.input-resume`, `cross-extension-rpc.spawn`, `manager-registry.spawn`, `agents-command.generate-definition`, or `workflow-host.spawn` |
| `agent-manager.spawn-and-wait` | inherited from outer path | captured at outer path `agent-tool.spawn-foreground`, `nested-agent.spawn-foreground`, `agents-command.generate-definition`, or `workflow-host.spawn` |
| `agent-manager.resume` | inherited from outer path | captured at outer path `agent-tool.resume-background`, `agent-tool.resume-foreground`, `nested-agent.resume`, `mention.input-resume`, or `workflow-host.resume` |
| `agent-manager.steer` | inherited from outer path | captured at outer path `agent-tool.steer`, `nested-agent.steer`, `mention.input-steer`, `conversation-viewer.steer`, or `fleet-viewer.steer` |
| `agent-manager.pending-steer` | inherited from outer path | captured at outer path `agent-tool.steer`, `nested-agent.steer`, `mention.input-steer`, `conversation-viewer.steer`, or `fleet-viewer.steer` |
| `agent-tool.spawn-background` | parent-model-delegation | captures ingress here |
| `agent-tool.spawn-foreground` | parent-model-delegation | captures ingress here |
| `agent-tool.resume-background` | parent-model-delegation | captures ingress here |
| `agent-tool.resume-foreground` | parent-model-delegation | captures ingress here |
| `agent-tool.steer` | parent-model-delegation | captures ingress here |
| `nested-agent.spawn-background` | parent-model-delegation | captures ingress here |
| `nested-agent.spawn-foreground` | parent-model-delegation | captures ingress here |
| `nested-agent.resume` | parent-model-delegation | captures ingress here |
| `nested-agent.steer` | parent-model-delegation | captures ingress here |
| `mention.input-start` | human | captures ingress here, before direct spawn or clone-fallback handling |
| `mention.input-clone` | human | captures ingress here, before clone dispatch |
| `mention.input-resume` | human | captures ingress here, before live resume or tombstone reopen |
| `mention.input-steer` | human | captures ingress here, before live steer |
| `cross-extension-rpc.spawn` | extension-request | captures ingress here; prompt coverage is partial and scope is unresolved when `scopeRef` is absent |
| `manager-registry.spawn` | extension-request | captures ingress here; missing scope reference remains unresolved |
| `scheduled-task.fire` | retained scheduled origin (task 5.x), or `imported-context` after restore | no text input (task 5.x); in-memory creation ingress only, disk fields ignored |
| `workflow-tool.dispatch` | inherited workflow/delegation origin (task 5.x) | no text input (task 5.x) |
| `workflow-cli-flag.dispatch` | CLI/workflow origin (task 5.x) | no text input (task 5.x) |
| `workflow.pi-exec.gate` | workflow/tool-observation origin | no text input (task 5.x); concrete effect request only, no workflow-source parsing |
| `worktree.create` | package-system-control | no text input (task 5.x); concrete worktree git effects |
| `worktree.capture` | package-system-control | no text input (task 5.x); concrete worktree git effects |
| `worktree.remove` | package-system-control | no text input (task 5.x); concrete worktree git effects |
| `worktree.prune` | package-system-control | no text input (task 5.x); concrete unbounded git prune |
| `agent-runner.detect-env` | package-system-control | no text input (task 5.x); concrete child git observation |
| `agents-command.generate-definition` | human | captures ingress here, preserving the description before prompt generation |
| `conversation-viewer.steer` | human | captures ingress here, before steering |
| `fleet-viewer.steer` | human | captures ingress here, before steering |
| `agent-runner.turn-limit-steer` | package-system-control | captures ingress here; the generated limit message is never human evidence |
| `workflow-host.spawn` | inherited workflow origin | captures ingress here for the worker prompt |
| `workflow-host.resume` | inherited workflow origin | captures ingress here for the resume prompt |
| `agent-tool.schedule-create` | parent-model-delegation | captures ingress here for the prompt stored in the scheduled job |


## Rejections and non-goals

- `guard-missing`: guarded work reached an entry path without a registration.
- `guard-incompatible-protocol`: a registration was present but invalid or could not be safely inspected — wrong protocol version, null/undefined payload, callbacks missing or non-functions, or throwing getter/Proxy access.
- `guard-enrollment-failed`: the snapshotted `enrollResource` callback threw or rejected; the child prompt/dispatch is not started. The error does not include callback exception content.
- `guard-child-context-failed`: `createChildContext` threw/rejected or returned a malformed, mismatched, foreign, or over-bound context; the child is not started/resumed. Scheduled fire-time callbacks also fail with this code after the documented 10-second bound. Diagnostics never include callback exception contents.
- `guard-schedule-scope-missing`: guarded schedule creation had no snapshotted `createScheduleScope` callback; the job is not created.
- `guard-schedule-scope-failed`: schedule-scope creation threw/rejected/timed out/aborted, the registration changed, or the response was malformed; the job is not created. Expiry/exhaustion uses bounded job reasons `guard-schedule-expired`, `guard-schedule-max-runs`, or `guard-schedule-scope-invalid` and is reported once through `subagents:scheduled` (`type: "error").
- `guard-child-injection-failed`: the required child factory was absent, failed, returned a non-function, failed to load, or its frozen registration snapshot changed before child construction. The child session/prompt is not started, and diagnostics contain no callback exception content.
- `guard-effect-review-missing`, `guard-effect-denied`, `guard-effect-approval-needed`, `guard-effect-cancelled`, and `guard-effect-unavailable`: concrete effect review is absent, non-allowing, approval-required, aborted, timed out, malformed/failed, or bound to a replaced snapshot. The process call does not run; details are content-free. `worktree-capture` status and `add -A` must remain unbounded and require review; guarded status uses `--ignore-submodules=dirty --untracked-files=all` and is not classified as read-only.

Configuration diagnostics are separately reported as `guardExpectedDiagnostic`.



The bridge uses no prompt-derived keys, hashes, process-global registry, or implicit fallback. Identical prompt text does not associate children or approvals. Unrelated third-party extension commands and private extension internals are unsupported and are not covered by this inventory. This contract adds no decision logic; task **5.4** adds concrete fork-owned effect reporting without claiming universal effect interception.

### Resource enrollment ownership

The fork enrolls preloaded child resources through the frozen registration snapshot before creating/binding the child session and before its first prompt: each configured preloaded skill is enrolled as `kind: "skill"`, and the resolved agent definition as `kind: "agent-definition"`. Every such enrollment carries `provenance: "child-preload"` and the manager-allocated child record id in `childId`. This is data for guard-side interpretation only; enrolled text never counts as authorization.

For a resolved skill, `sourceIdentity` is `skill:` followed by the real absolute path of its skill file (directory `SKILL.md` or flat `.md` file); a missing/unreadable skill retains `skill:<configured-name>` as its unresolved identity. The skill `sourceVersion` is lowercase, unprefixed SHA-256 hex of the exact UTF-8 file text, including frontmatter and surrounding whitespace. Its text reference is that same file text. For an agent definition, `sourceIdentity` is `agent-definition:<source>:<name>`, where `<source>` is `project` or `global` for custom definitions and `builtin` for embedded defaults. The fork derives those values from the agent config's `source` (`project`/`global`/`default`) and `isDefault` fields; `default` maps to `builtin`. The agent-definition `sourceVersion` is lowercase, unprefixed SHA-256 hex of the exact resolved `systemPrompt` text. The fork's UTF-8 resource-reference limit is exactly 65,536 bytes (64 KiB), with an explicit truncation marker; the digest always covers the full text. Truncated resources are marked `resolution: "unresolved"` and retain their full-text digest. A guard may impose a lower cap on text it stores and must treat content larger than its own cap as unresolved. A skill the fork cannot resolve/read is also enrolled `unresolved` with its identity, the `"unresolved"` version sentinel, and an empty reference list rather than being silently omitted.

A child session retains its resource/version enrollments per frozen guard-registration snapshot. Resume skips any `(sourceIdentity, sourceVersion)` already enrolled for the current snapshot; after unregistering and registering a new snapshot, the same child's preloads are enrolled again for the new registration. A child first started with guard-off/no registration can therefore enroll its pending resources if a registration is present on a later resume. With no registration and `guardExpected: false`, enrollment is a no-op and upstream child behavior is unchanged. Each startup/resume enrollment batch uses one snapshot for all resources and verifies that snapshot is still active after the final await. If a non-empty snapshot changes, the whole batch is rejected with a content-free guard error; it is not restarted, because earlier callbacks may already have observed part of the batch. If startup began with no registration and `guardExpected` becomes true before the first prompt, the complete batch is enrolled under the first active snapshot before dispatch. A throwing or rejecting callback with a registration present fails closed: the child startup/resumed prompt does not run, and the child record surfaces the bounded, content-free `guard-enrollment-failed` diagnostic. Missing required registration remains the ordinary guard rejection. Enrollment never waits for another human turn.

| Entry path | Enrollment point | Enrolled resources |
| --- | --- | --- |
| `agent-manager.spawn` | `src/agent-runner.ts` — `runAgent`, after resolving child config/skills and before resource-loader/session creation | preloaded skills and resolved agent definition |
| `agent-manager.resume` | `src/agent-runner.ts` — `resumeAgent`, before the next prompt, only for resources not already enrolled for that child | pending preloaded skills and agent definition |
