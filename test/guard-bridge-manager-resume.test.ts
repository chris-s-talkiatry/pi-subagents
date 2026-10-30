import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { type GuardBridgeRegistration } from "../src/guard-bridge.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const session = { dispose: vi.fn(), prompt: vi.fn(async () => {}) } as any;
const enrollment = {
  kind: "skill" as const,
  sourceIdentity: "skill:missing",
  sourceVersion: "unresolved",
  childId: "child-record",
  provenance: "child-preload" as const,
  resolution: "unresolved" as const,
  resolvedRestrictionTextRefs: [],
};

function registration(enrollResource: (value: any) => void | Promise<void>): GuardBridgeRegistration {
  return {
    protocolVersion: 1,
    registrant: { id: "scope-guard", version: "1" },
    callbacks: {
      captureIngress: vi.fn(),
      enrollResource,
      createChildContext: vi.fn(async (value: any) => value),
      revalidate: vi.fn(() => "allowed"),
      approvalSettled: vi.fn(),
      approvalCancelled: vi.fn(),
      approvalExpired: vi.fn(),
    },
  };
}

function rejectWithEnrollmentDiagnostic(manager: AgentManager): void {
  manager.registerGuard(registration(() => { throw new Error("secret child restriction"); }));
  vi.mocked(resumeAgent).mockImplementation(async (_session: any, _prompt: string, options: any) => {
    await options.guardBridgeHost.enrollResource(enrollment, "agent-manager.resume");
    await session.prompt();
    return { text: "continued" };
  });
}

describe("AgentManager resume enrollment failure", () => {
  let manager: AgentManager | undefined;

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    vi.clearAllMocks();
  });

  async function settledChild(): Promise<string> {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "started",
      session,
      aborted: false,
      steered: false,
    } as any);
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "start", {
      description: "child",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    return id;
  }

  it("surfaces inline resume enrollment failure without prompting or callback details", async () => {
    const id = await settledChild();
    const child = manager!.getRecord(id)!;
    const promptsBeforeResume = session.prompt.mock.calls.length;
    rejectWithEnrollmentDiagnostic(manager!);

    const result = await manager!.resume(id, "resume");

    expect(result).toBe(child);
    expect(child.status).toBe("error");
    expect(child.error).toBe("guard-enrollment-failed: guarded work is unavailable at agent-manager.resume; resource enrollment callback failed; child dispatch was stopped.");
    expect(child.error).not.toContain("secret child restriction");
    expect(session.prompt).toHaveBeenCalledTimes(promptsBeforeResume);
  });

  it("surfaces background startResume enrollment failure without prompting or callback details", async () => {
    const id = await settledChild();
    const child = manager!.getRecord(id)!;
    const promptsBeforeResume = session.prompt.mock.calls.length;
    rejectWithEnrollmentDiagnostic(manager!);

    const result = await manager!.resume(id, "resume", undefined, { isBackground: true });
    expect(result).toBe(child);
    await child.promise;

    expect(child.status).toBe("error");
    expect(child.error).toBe("guard-enrollment-failed: guarded work is unavailable at agent-manager.resume; resource enrollment callback failed; child dispatch was stopped.");
    expect(child.error).not.toContain("secret child restriction");
    expect(session.prompt).toHaveBeenCalledTimes(promptsBeforeResume);
  });
});
