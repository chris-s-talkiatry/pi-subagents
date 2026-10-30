import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({ createAgentSession: vi.fn() }));
const resourceMocks = vi.hoisted(() => ({ loaded: [] as any[] }));
const agentDefinitionSource = vi.hoisted(() => ({ value: "project" as "project" | "global" | "builtin" }));
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  return { ...actual, createAgentSession: sessionMocks.createAgentSession };
});
vi.mock("../src/env.js", async () => {
  const actual = await vi.importActual<typeof import("../src/env.js")>("../src/env.js");
  return { ...actual, detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "test" })) };
});
vi.mock("../src/agent-types.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-types.js")>("../src/agent-types.js");
  return {
    ...actual,
    getConfig: vi.fn(() => ({ extensions: false, skills: ["child-skill"], promptMode: "replace" })),
    getAgentConfig: vi.fn(() => ({
      name: "scope-child",
      description: "test child",
      extensions: false,
      skills: ["child-skill"],
      systemPrompt: "Agent restriction: edit only scratch.",
      builtinToolNames: ["read"],
      promptMode: "replace",
      source: agentDefinitionSource.value === "builtin" ? undefined : agentDefinitionSource.value,
      isDefault: agentDefinitionSource.value === "builtin",
    })),
    getToolNamesForType: vi.fn(() => ["read"]),
    getMemoryToolNames: vi.fn(() => []),
    getReadOnlyMemoryToolNames: vi.fn(() => []),
  };
});
vi.mock("../src/skill-loader.js", () => ({ preloadSkills: vi.fn(() => resourceMocks.loaded) }));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { GuardBridgeHost, type GuardBridgeRegistration } from "../src/guard-bridge.js";
import { ctx, makePi } from "./helpers/boot-extension.js";

let events: string[];
let session: any;

function fakeSession() {
  const listeners = new Set<(event: any) => void>();
  const nextSession: any = {
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
      events.push("prompt");
      events.push("tool-dispatch");
      nextSession.messages.push({ role: "assistant", content: [{ type: "text", text: "child response" }] });
    }),
  };
  return nextSession;
}

function registration(enrollResource: (value: any) => void | Promise<void>): GuardBridgeRegistration {
  return {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "1" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource,
      createChildContext: vi.fn(async (value: any) => ({ ...value, bridgeRef: registration(enrollResource) })),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
    },
  };
}

function resolvedSkill() {
  return {
    name: "child-skill",
    sourceIdentity: "/resolved/skills/child-skill/SKILL.md",
    resolved: true,
    content: "Skill restriction: do not commit.",
  };
}

beforeEach(() => {
  events = [];
  agentDefinitionSource.value = "project";
  session = fakeSession();
  resourceMocks.loaded = [resolvedSkill()];
  sessionMocks.createAgentSession.mockReset().mockImplementation(async () => {
    events.push("create-session");
    return { session };
  });
});
afterEach(() => vi.restoreAllMocks());

describe("preloaded child resource enrollment", () => {
  it("awaits async enrollment before creating a child session or prompting", async () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    const enrollmentEvents: any[] = [];
    let releaseEnrollment!: () => void;
    let markStarted!: () => void;
    const enrollmentGate = new Promise<void>((resolve) => { releaseEnrollment = resolve; });
    const enrollmentStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    host.register(registration(async (value) => {
      events.push(`enroll:${value.kind}`);
      enrollmentEvents.push(value);
      if (value.kind === "skill") {
        markStarted();
        await enrollmentGate;
      }
    }));

    const run = runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      agentId: "child-record-42",
      guardBridgeHost: host,
      guardExpected: true,
    });
    await enrollmentStarted;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sessionMocks.createAgentSession).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(events).toEqual(["enroll:skill"]);

    releaseEnrollment();
    await run;
    expect(events).toEqual([
      "enroll:skill",
      "enroll:agent-definition",
      "create-session",
      "prompt",
      "tool-dispatch",
    ]);
    expect(enrollmentEvents).toEqual([
      {
        kind: "skill",
        sourceIdentity: "skill:/resolved/skills/child-skill/SKILL.md",
        sourceVersion: "604bb12e5cd86bc67b897a276c3249e2a08e0cebacd8090ccf720c2708e33ee2",
        childId: "child-record-42",
        provenance: "child-preload",
        resolvedRestrictionTextRefs: [{
          sourceIdentity: "skill:/resolved/skills/child-skill/SKILL.md",
          sourceVersion: "604bb12e5cd86bc67b897a276c3249e2a08e0cebacd8090ccf720c2708e33ee2",
          textReference: "Skill restriction: do not commit.",
        }],
      },
      {
        kind: "agent-definition",
        sourceIdentity: "agent-definition:project:scope-child",
        sourceVersion: "0a015ff879cd8f5c2030e79382646eccee0c178f0738372d00bc448de93c3f05",
        childId: "child-record-42",
        provenance: "child-preload",
        resolvedRestrictionTextRefs: [{
          sourceIdentity: "agent-definition:project:scope-child",
          sourceVersion: "0a015ff879cd8f5c2030e79382646eccee0c178f0738372d00bc448de93c3f05",
          textReference: "Agent restriction: edit only scratch.",
        }],
      },
    ]);
  });

  it.each([
    ["project", "agent-definition:project:scope-child"],
    ["global", "agent-definition:global:scope-child"],
    ["builtin", "agent-definition:builtin:scope-child"],
  ] as const)("qualifies the agent-definition identity with its %s source", async (source, sourceIdentity) => {
    agentDefinitionSource.value = source;
    const host = new GuardBridgeHost(true, "scope-guard");
    const enrollments: any[] = [];
    host.register(registration((value) => enrollments.push(value)));

    await runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      guardBridgeHost: host,
      guardExpected: true,
    });

    const agentDefinition = enrollments.find((value) => value.kind === "agent-definition");
    expect(agentDefinition).toMatchObject({
      sourceIdentity,
      resolvedRestrictionTextRefs: [{ sourceIdentity }],
    });
  });
  it("enrolls unresolved preloaded skill identity without inventing text references", async () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    const enrollResource = vi.fn();
    host.register(registration((value) => enrollResource(value)));
    resourceMocks.loaded = [{ name: "child-skill", content: "not found", resolved: false }];

    await runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      agentId: "child-record-43",
      guardBridgeHost: host,
      guardExpected: true,
    });

    expect(enrollResource).toHaveBeenCalledWith(expect.objectContaining({
      kind: "skill",
      sourceIdentity: "skill:child-skill",
      sourceVersion: "unresolved",
      childId: "child-record-43",
      provenance: "child-preload",
      resolution: "unresolved",
      resolvedRestrictionTextRefs: [],
    }));
  });


  it("retains full-text digest and marks oversized references unresolved", async () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    const enrollmentEvents: any[] = [];
    host.register(registration((value) => enrollmentEvents.push(value)));
    const fullText = `---\nname: child-skill\n---\n${"restriction-data-".repeat(5_000)}`;
    resourceMocks.loaded = [{ ...resolvedSkill(), content: fullText, sourceText: fullText }];

    await runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      agentId: "child-record-44",
      guardBridgeHost: host,
      guardExpected: true,
    });

    const skill = enrollmentEvents.find((value) => value.kind === "skill");
    const digest = createHash("sha256").update(fullText, "utf8").digest("hex");
    expect(skill).toMatchObject({
      sourceIdentity: "skill:/resolved/skills/child-skill/SKILL.md",
      sourceVersion: digest,
      childId: "child-record-44",
      provenance: "child-preload",
      resolution: "unresolved",
    });
    expect(skill.resolvedRestrictionTextRefs[0]).toMatchObject({
      sourceVersion: digest,
      textReference: expect.stringContaining("[truncated: restriction text reference limited to 64 KiB]"),
    });
    expect(skill.resolvedRestrictionTextRefs[0].textReference.startsWith("---\nname: child-skill\n---\n")).toBe(true);
    expect(Buffer.byteLength(skill.resolvedRestrictionTextRefs[0].textReference, "utf8")).toBeLessThanOrEqual(65_536);
  });


  it("fails closed on resume enrollment rejection before prompting", async () => {
    const host = new GuardBridgeHost(false);
    await runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      agentId: "child-record-resume-failure",
      guardBridgeHost: host,
      guardExpected: false,
    });
    const promptsBeforeResume = session.prompt.mock.calls.length;
    host.register(registration(() => { throw new Error("private enrollment failure"); }));

    await expect(resumeAgent(session, "resume child task", { guardBridgeHost: host, guardExpected: false }))
      .rejects.toMatchObject({
        name: "GuardBridgeRejection",
        reasonCode: "guard-enrollment-failed",
        entryPath: "agent-manager.resume",
        message: "guard-enrollment-failed: guarded work is unavailable at agent-manager.resume; resource enrollment callback failed; child dispatch was stopped.",
      });
    expect(session.prompt).toHaveBeenCalledTimes(promptsBeforeResume);
    expect(session.prompt).not.toHaveBeenCalledWith(expect.stringContaining("private enrollment failure"));
  });

  it("fails closed on callback rejection before creating a child session or prompting", async () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    host.register(registration(() => { events.push("enroll:skill"); throw new Error("secret callback detail"); }));

    await expect(runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      guardBridgeHost: host,
      guardExpected: true,
    })).rejects.toMatchObject({
      name: "GuardBridgeRejection",
      reasonCode: "guard-enrollment-failed",
      message: "guard-enrollment-failed: guarded work is unavailable at agent-manager.spawn; resource enrollment callback failed; child dispatch was stopped.",
    });
    expect(sessionMocks.createAgentSession).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(events).toEqual(["enroll:skill"]);
  });

  it("leaves upstream behavior unchanged without a registration when guardExpected is false", async () => {
    const host = new GuardBridgeHost(false);
    await runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      guardBridgeHost: host,
      guardExpected: false,
    });
    expect(events).toEqual(["create-session", "prompt", "tool-dispatch"]);
    expect(sessionMocks.createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("does not re-enroll the same child resource versions on resume", async () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    const enrollResource = vi.fn();
    host.register(registration((value) => {
      events.push(`enroll:${value.kind}`);
      enrollResource(value);
    }));
    await runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      guardBridgeHost: host,
      guardExpected: true,
    });
    const enrollCount = enrollResource.mock.calls.length;
    await resumeAgent(session, "resume child task", { guardBridgeHost: host, guardExpected: true });
    expect(enrollResource).toHaveBeenCalledTimes(enrollCount);
    expect(events.slice(-2)).toEqual(["prompt", "tool-dispatch"]);
  });

  it("re-enrolls preloads for a new registration but remains idempotent for the same registration", async () => {
    const host = new GuardBridgeHost(true, "scope-guard");
    const firstRegistrationEnrollments = vi.fn();
    host.register(registration(firstRegistrationEnrollments));
    await runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      agentId: "child-record-registration-reload",
      guardBridgeHost: host,
      guardExpected: true,
    });
    expect(firstRegistrationEnrollments).toHaveBeenCalledTimes(2);

    await resumeAgent(session, "resume under same registration", { guardBridgeHost: host, guardExpected: true });
    expect(firstRegistrationEnrollments).toHaveBeenCalledTimes(2);

    host.unregister();
    const secondRegistrationEnrollments = vi.fn();
    host.register(registration(secondRegistrationEnrollments));
    await resumeAgent(session, "resume under replacement registration", { guardBridgeHost: host, guardExpected: true });
    expect(firstRegistrationEnrollments).toHaveBeenCalledTimes(2);
    expect(secondRegistrationEnrollments).toHaveBeenCalledTimes(2);

    await resumeAgent(session, "resume again under replacement registration", { guardBridgeHost: host, guardExpected: true });
    expect(secondRegistrationEnrollments).toHaveBeenCalledTimes(2);
  });

  it("enrolls resources that were pending when an unguarded child is resumed after registration", async () => {
    const host = new GuardBridgeHost(false);
    await runAgent(ctx(), "scope-child", "child task", {
      pi: makePi().pi,
      guardBridgeHost: host,
      guardExpected: false,
    });
    const enrollResource = vi.fn((value) => events.push(`enroll:${value.kind}`));
    host.register(registration(enrollResource));
    const beforeResume = events.length;
    await resumeAgent(session, "resume child task", { guardBridgeHost: host, guardExpected: false });
    expect(events.slice(beforeResume, beforeResume + 2)).toEqual(["enroll:skill", "enroll:agent-definition"]);
    expect(events.slice(-2)).toEqual(["prompt", "tool-dispatch"]);
    await resumeAgent(session, "resume again", { guardBridgeHost: host, guardExpected: false });
    expect(enrollResource).toHaveBeenCalledTimes(2);
  });
});
