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

A registration has `registrant: { id: string, version: string }`. A guard listens for `subagents:ready` and registers after that signal by emitting `subagents:guard:register` with the object as its event payload. `AgentManager.registerGuard` is host-internal and is not exposed on the public manager registry. The event listener accepts registrations only while a session is active (after `session_start` and before shutdown/switch); pre-start, post-shutdown, and post-switch attempts are rejected diagnostically and never emit readiness. The host retains the first valid registration from the configured expected registrant by reference: same-object registration is idempotent, while a different object is rejected and recorded as `registrationRejected`. A missing, malformed, or mismatched registrant is rejected as `guard-wrong-registrant` without consuming the first-wins slot. Registration also requires integer protocol version `1` and every required callback to be a function. Null/undefined payloads, missing/non-function callbacks, throwing property getters, and throwing Proxy traps are incompatible rather than escaping the listener.

The original registration object's identity is retained by the root host. When present, the manager forwards a compatible registration reference only through the runner's `guardBridgeRegistration` option; this alone does not inject or activate a guard inside a child session. On initial registration, the protocol version, registrant id/version and bound callback function references are copied into a frozen host validation snapshot; later replacement/mutation of fields on the original object does not change validation. A same-object re-registration does not re-read potentially hostile getters. `registrationRejected` is the current rejection headline and is cleared by a later successful registration; `registrationRejectionHistory` retains the bounded recent diagnostics. A rejected event registration re-emits `subagents:ready` at most once per rejection reason and at most three times per session; successful registration never re-emits it. Readiness is emitted once on every active `session_start`, including after `/new` or `/resume`, and never from the registration handler outside the active-session window. The read-only advertisement channel is `subagents:rpc:guard-bridge`.

`guardExpected` is a `subagents.json` boolean setting, default `false`. Set it to `true` to require registration before supported work starts, resumes, steers, or dispatches. When true, `guardRegistrant` must be a non-empty expected registrant id. Differing non-empty global/project values fail closed with `guard-registrant-conflict`; an unset or empty value fails closed with `guard-registrant-unconfigured`. Guard-off users (`guardExpected` false or absent) are not made to configure a registrant; when `guardRegistrant` IS configured, registrations are identity-checked even with `guardExpected` false (setting it opts in to identity checks), and a non-expected registrant is always reported as `guard-wrong-registrant`, including after the expected registrant registered. With no `guardRegistrant` configured no identity check applies. `guardExpected` enablement is monotonic across config layers and programmatic settings: a lower-precedence `false` cannot disable a `true`. The `/agents` snapshot preserves project-owned `guardExpected` and `guardRegistrant` values but never materializes global/programmatic-only values or implicit defaults.

Registrant identity is an accidental/misordering check, not authentication. In-process extensions are fully trusted code; a malicious extension can bypass an in-process guard. `guardExpected` proves only that a registration claiming the expected registrant id was accepted. No bridge field or diagnostic authenticates an extension.

A present non-boolean `guardExpected` value (including `null`) fails closed as `true` and emits a visible warning; its reason is exposed as `guardExpectedDiagnostic` in both readiness and the RPC advertisement. Valid `false` and an absent key remain false. A malformed JSON settings file fails closed when its raw text contains `guardExpected` or `guardRegistrant`; malformed files without those substrings retain the upstream settings fallback behavior. An existing unreadable settings file warns and is ignored without forcing `guardExpected` on. The advertisement's `configDiagnostic` identifies the unreadable path; a guard that expected an effective `guardExpected: true` must treat an observed `false` as unavailable. Queue delay does not preserve old approval to start: manager spawn and background-resume paths re-assert registration at queue drain, before child session creation or resumed-run record mutation, and fail the queued record with the exact guard error if registration no longer passes. With the default `false`, no registration is required and incompatible registrations are not forwarded to child runners.


## Contract types

The public bridge types are in `src/guard-bridge.ts`:

- **Ingress evidence** (`GuardIngressEvidence`): ingress ID, original raw text, optional transformed text, explicit `complete`/`partial`/`unknown` coverage, target, origin and entry-path ID. `GuardOrigin` distinguishes `human`, `parent-model-delegation`, `extension-request`, `package-system-control`, `imported-context`, and `tool-observation`.
- **Resource enrollment** (`GuardResourceEnrollment`): skill, template, or agent-definition identity/version and its restriction-text references. `resolution` is optional and defaults to `resolved` for protocol-version-1 compatibility; unresolved resources carry identity, `sourceVersion: "unresolved"`, and no text references.
- **Child context** (`GuardChildContext`): root/parent/child/delegation/task IDs, scope revision, execution epoch, enrolled restrictions, origin, and the retained bridge registration reference.
- **Approval and revalidation** (`GuardApprovalRequest`, `GuardApprovalResponse`, `GuardBridgeCallbacks`): exact action/targets and authority/evidence references, bound to root/task/optional child identity, input generation, decision revision, execution epoch and an opaque lifetime token; callbacks capture ingress, enroll resources, create child contexts, revalidate, and report settled/cancelled/expired approval requests.

The bridge carries these shapes and callbacks; it does not implement interpretation, authorization, persistence, queueing, or UI behavior.

When a manager-registry `spawn` uses a registered `captureIngress` callback that returns a promise, the registry method returns `Promise<string>` and starts the agent only after capture settles. With no registration (including optional guard-off mode), or with a synchronous callback, it returns the agent ID as a synchronous string. The unbounded wait is intentional: a callback that never resolves leaves work unstarted and does not notify the user.

## Ingress capture

For every owned ingress, the fork calls `captureIngress` at the outermost supported path that still has the original input, before it consumes, rewrites, starts, resumes, or steers work. The host assigns a unique opaque ID using its own epoch plus a per-host monotonic sequence; IDs never derive from prompt text. Evidence is frozen before it reaches the registration callback. `rawText` is the exact original text available at that boundary; `transformedText` is included only when the fork rewrites it. `coverage` is `complete` only when the original evidence is fully available; `partial`/`unknown` remain unresolved rather than being upgraded to human authority (for example, the cross-extension RPC schema has no recognized scope-reference field).

Each physical input is captured exactly once. Inner manager/runner boundaries do not recapture an input already owned by an outer path; the mention-clone fallback also reuses the mention's capture rather than emitting a second ingress when it starts a direct fallback agent. Origins are explicit: human prompts/mentions/viewer entries are `human`; Agent/nested-tool delegation is `parent-model-delegation`; registry/RPC work is `extension-request`; turn-limit steering is `package-system-control`. Captured input must never be treated as approval based on user role, wording, or source labels alone.

A capture callback that throws (synchronously or asynchronously) is non-fatal to the fork path: the host records a bounded, content-free diagnostic (count and at most ten recent messages), then the path continues. A guard must treat the absent callback evidence as unresolved; callback failure is not an allow or grant. A callback that never resolves intentionally fails closed at ingress: the input is held and its consuming action does not run. There is no timeout, and the user is not notified while the callback remains pending. The guard's generic Pi `input` handler may also observe the same physical prompt. Correlation is by host dispatch order/ingress ID, never by matching prompt text. Ordinary conversational prompts are captured by the guard-side generic `input` handler, not by this fork; this fork directly captures only the owned paths below. A generic handler registered later cannot recover text already consumed or transformed by another handler.


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
| `agents-command.generate-definition` | `src/index.ts` — `showGenerateWizard` | command / spawn |
| `conversation-viewer.steer` | `src/index.ts` — `viewAgentConversation` | conversation viewer / steer |
| `fleet-viewer.steer` | `src/ui/fleet-list.ts` — `FleetList.openSelected` | fleet viewer / steer |
| `agent-runner.turn-limit-steer` | `src/agent-runner.ts` — `runAgent` turn-end handler | runner / package-origin steer |
| `workflow-host.spawn` | `src/workflow/host.ts` — `spawnAgent` | workflow host / spawn-and-wait |
| `workflow-host.resume` | `src/workflow/host.ts` — `resumeAgent`; `src/workflow/runtime.ts` — `runWorkflow.handleAgent` resume callback | workflow host / resume |
| `agent-tool.schedule-create` | `src/index.ts` — `Agent.execute` schedule branch | Agent tool / scheduled work creation |

### Ingress capture ownership

The origin column names the evidence captured at that boundary. Manager-level inner paths inherit the origin of their listed outer caller. If `captureIngress` is asynchronous, a deferred steer is delivered only after capture completes and while its guard registration remains valid; a never-resolving callback leaves that input undelivered without notifying the user. Paths marked task 5.x are deliberately not captured in this fork half because they have no new raw text input at the listed dispatch point.

| Entry-path ID | Origin | Capture ownership |
| --- | --- | --- |
| `agent-manager.spawn` | inherited from outer path | captured at outer path `agent-tool.spawn-background`, `agent-tool.spawn-foreground`, `nested-agent.spawn-background`, `nested-agent.spawn-foreground`, `mention.input-start`, `mention.input-resume`, `cross-extension-rpc.spawn`, `manager-registry.spawn`, or `agents-command.generate-definition` |
| `agent-manager.spawn-and-wait` | inherited from outer path | captured at outer path `agent-tool.spawn-foreground`, `nested-agent.spawn-foreground`, or `agents-command.generate-definition`; workflow-host use is task 5.x |
| `agent-manager.resume` | inherited from outer path | captured at outer path `agent-tool.resume-background`, `agent-tool.resume-foreground`, `nested-agent.resume`, or `mention.input-resume`; workflow-host use is task 5.x |
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
| `cross-extension-rpc.spawn` | extension-request | captures ingress here; coverage is partial when no recognized scope reference is present |
| `manager-registry.spawn` | extension-request | captures ingress here; coverage is partial when the request envelope is incomplete |
| `scheduled-task.fire` | retained scheduled origin (task 5.x) | no text input (task 5.x) |
| `workflow-tool.dispatch` | inherited workflow/delegation origin (task 5.x) | no text input (task 5.x) |
| `workflow-cli-flag.dispatch` | CLI/workflow origin (task 5.x) | no text input (task 5.x) |
| `workflow.pi-exec.gate` | workflow/tool-observation origin (task 5.x) | no text input (task 5.x) |
| `agents-command.generate-definition` | human | captures ingress here, preserving the description before prompt generation |
| `conversation-viewer.steer` | human | captures ingress here, before steering |
| `fleet-viewer.steer` | human | captures ingress here, before steering |
| `agent-runner.turn-limit-steer` | package-system-control | captures ingress here; the generated limit message is never human evidence |
| `workflow-host.spawn` | inherited workflow origin (task 5.x) | no text input (task 5.x) |
| `workflow-host.resume` | inherited workflow origin (task 5.x) | no text input (task 5.x) |
| `agent-tool.schedule-create` | parent-model-delegation | captures ingress here for the prompt stored in the scheduled job |


## Rejections and non-goals

- `guard-missing`: guarded work reached an entry path without a registration.
- `guard-incompatible-protocol`: a registration was present but invalid or could not be safely inspected — wrong protocol version, null/undefined payload, callbacks missing or non-functions, or throwing getter/Proxy access.
- `guard-enrollment-failed`: the snapshotted `enrollResource` callback threw or rejected; the child prompt/dispatch is not started. The error does not include callback exception content.

Configuration diagnostics are separately reported as `guardExpectedDiagnostic`.



The bridge uses no prompt-derived keys, hashes, process-global registry, or implicit fallback. Identical prompt text does not associate children or approvals. Unrelated third-party extension commands and private extension internals are unsupported and are not covered by this inventory. This contract adds no decision logic; subsequent tasks **3.x–5.x** add guard behavior beyond this integration boundary.

### Resource enrollment ownership

The fork enrolls preloaded child resources through the frozen registration snapshot before creating/binding the child session and before its first prompt: each configured preloaded skill is enrolled as `kind: "skill"`, and the resolved agent definition as `kind: "agent-definition"`. Every such enrollment carries `provenance: "child-preload"` and the manager-allocated child record id in `childId`. This is data for guard-side interpretation only; enrolled text never counts as authorization.

For a resolved skill, `sourceIdentity` is `skill:` followed by the real absolute path of its skill file (directory `SKILL.md` or flat `.md` file); a missing/unreadable skill retains `skill:<configured-name>` as its unresolved identity. The skill `sourceVersion` is lowercase, unprefixed SHA-256 hex of the exact UTF-8 file text, including frontmatter and surrounding whitespace. Its text reference is that same file text. For an agent definition, `sourceIdentity` is `agent-definition:<source>:<name>`, where `<source>` is `project` or `global` for custom definitions and `builtin` for embedded defaults. The fork derives those values from the agent config's `source` (`project`/`global`/`default`) and `isDefault` fields; `default` maps to `builtin`. The agent-definition `sourceVersion` is lowercase, unprefixed SHA-256 hex of the exact resolved `systemPrompt` text. The fork's UTF-8 resource-reference limit is exactly 65,536 bytes (64 KiB), with an explicit truncation marker; the digest always covers the full text. Truncated resources are marked `resolution: "unresolved"` and retain their full-text digest. A guard may impose a lower cap on text it stores and must treat content larger than its own cap as unresolved. A skill the fork cannot resolve/read is also enrolled `unresolved` with its identity, the `"unresolved"` version sentinel, and an empty reference list rather than being silently omitted.

A child session retains its resource/version enrollments per frozen guard-registration snapshot. Resume skips any `(sourceIdentity, sourceVersion)` already enrolled for the current snapshot; after unregistering and registering a new snapshot, the same child's preloads are enrolled again for the new registration. A child first started with guard-off/no registration can therefore enroll its pending resources if a registration is present on a later resume. With no registration and `guardExpected: false`, enrollment is a no-op and upstream child behavior is unchanged. A throwing or rejecting callback with a registration present fails closed: the child startup/resumed prompt does not run, and the child record surfaces the bounded, content-free `guard-enrollment-failed` diagnostic. Missing required registration remains the ordinary guard rejection. Enrollment never waits for another human turn.

| Entry path | Enrollment point | Enrolled resources |
| --- | --- | --- |
| `agent-manager.spawn` | `src/agent-runner.ts` — `runAgent`, after resolving child config/skills and before resource-loader/session creation | preloaded skills and resolved agent definition |
| `agent-manager.resume` | `src/agent-runner.ts` — `resumeAgent`, before the next prompt, only for resources not already enrolled for that child | pending preloaded skills and agent definition |
