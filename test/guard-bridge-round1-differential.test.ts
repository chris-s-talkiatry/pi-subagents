import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/agent-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/agent-runner.js")>();
  return { ...actual, runAgent: runnerMocks.runAgent, resumeAgent: runnerMocks.resumeAgent };
});

import { AgentManager } from "../src/agent-manager.js";
import { detectEnv } from "../src/env.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "../src/worktree.js";

const directories: string[] = [];
const managers: AgentManager[] = [];
let FIXED = "";
beforeEach(() => { FIXED = temp("guard-off-differential-repo-"); });
const HEAD_FINGERPRINTS: Record<string, string> = {
  D1: "b72f683c77a73f30f5663d50cd2787379c021f1ebf65852ae429cf5a2685f5aa",
  D2: "9af01e6237003b2efe2a1240157ff1bc484314ddf695b461b22e4120e08ce2a9",
  D3: "e871bd1a3455e25de97c77cd1fc06e54dc9a0e2be5cbfca8fd48439f5b3b4e9c",
  D4: "bd30929d8cfa4f1112fe9f7b2f055a254b8de32d8a48a2e6888c3a72ee875d9a",
  D5: "fd3b62b3568381ce0d658f12febb309be9d75ba5b36bb4b1cfc97eb278ba3c5a",
  D6: "547a48bd802d2eff921f7e9fb75c847f3f2a8336942e222bc29512df4dd59347",
  D7: "a81f90a71a810667fb1e27ea024d5594ce8df0ba31617ad1ad5274898ddfd7df",
  D8: "2b1b279fbc7e6acff2f936d16d1f3fca58250d3f7fb29c39f809b4654401c655",
};

afterEach(async () => {
  vi.useRealTimers();
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string"
    ? item
      .replace(/pi-agent-[A-Za-z0-9_-]+-[0-9a-f]{8}/g, "pi-agent-ID-SFX")
      .replace(/pi-agent-[A-Za-z0-9_-]{6,}/g, "pi-agent-ID")
      .replace(/\d{13}/g, "TS")
      .replace(FIXED, "FIXED_REPO")
    : typeof item === "function" ? "[fn]" : item));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function expectHead(name: keyof typeof HEAD_FINGERPRINTS, value: unknown): void {
  expect(fingerprint(value)).toBe(HEAD_FINGERPRINTS[name]);
}

function fakeExec(log: unknown[], options: { sameSha?: boolean; branchFails?: boolean; removeFails?: boolean } = {}) {
  return vi.fn(async (command: string, args: string[], execOptions: any) => {
    log.push({ command, args: [...args], cwd: execOptions?.cwd, timeout: execOptions?.timeout, keys: Object.keys(execOptions ?? {}).sort() });
    const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return ok("true");
    if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("base");
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(FIXED);
    if (args[0] === "branch" && args[1] === "--show-current") return ok("main");
    if (args[0] === "worktree" && args[1] === "add") {
      mkdirSync(args[3]!, { recursive: true });
      directories.push(args[3]!);
      return ok();
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      if (options.removeFails) return { stdout: "", stderr: "nope", code: 1, killed: false };
      rmSync(args[3]!, { recursive: true, force: true });
      return ok();
    }
    if (args[0] === "status") return ok(options.sameSha ? "" : " M a\n");
    if (args[0] === "branch" && options.branchFails && !/-\d+$/.test(args[1] ?? "")) {
      return { stdout: "", stderr: "exists", code: 128, killed: false };
    }
    if (command === "sh") return ok("gate-out");
    return ok();
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe("guard-off differential against git archive HEAD (D1-D8)", () => {
  it("D1: workflow gate execution", async () => {
    const log: unknown[] = [];
    const manager = new AgentManager();
    managers.push(manager);
    const host = createWorkflowHost({
      pi: { exec: fakeExec(log) } as any,
      ctx: { cwd: FIXED, sessionManager: { getSessionId: () => "s" } } as any,
      manager,
    });
    const first = await host.runGate("npm test", { agentId: "a", cwd: FIXED });
    const second = await host.runGate("false", { cwd: undefined });
    expectHead("D1", normalize({ log, r1: first, r2: second }));
  });

  it("D2: changed worktree capture and remove", async () => {
    const log: unknown[] = [];
    const pi = { exec: fakeExec(log) } as any;
    const worktree = await createWorktree(pi, FIXED, "child1");
    const result = await cleanupWorktree(pi, FIXED, worktree!, "desc ".repeat(60));
    expectHead("D2", { log, wt: worktree, res: result });
  });

  it("D3: unchanged worktree removal", async () => {
    const log: unknown[] = [];
    const pi = { exec: fakeExec(log, { sameSha: true }) } as any;
    const worktree = await createWorktree(pi, FIXED, "child2");
    const result = await cleanupWorktree(pi, FIXED, worktree!, "d");
    expectHead("D3", { log, res: result });
  });

  it("D4: branch collision and failed remove fall back to prune", async () => {
    const log: unknown[] = [];
    const pi = { exec: fakeExec(log, { branchFails: true, removeFails: true }) } as any;
    const worktree = await createWorktree(pi, FIXED, "child3");
    const result = await cleanupWorktree(pi, FIXED, worktree!, "d");
    await pruneWorktrees(pi, FIXED);
    expectHead("D4", { log, res: result });
  });

  it("D5: environment detection", async () => {
    const log: unknown[] = [];
    const env = await detectEnv({ exec: fakeExec(log) } as any, FIXED);
    expectHead("D5", { log, env });
  });

  it("D6: guard-off schedule create/fire/expire and serialized bytes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const directory = temp("guard-off-schedule-");
    const file = join(directory, "s.json");
    const store = new ScheduleStore(file);
    const spawns: unknown[] = [];
    const events: unknown[] = [];
    const record = { status: "completed", promise: Promise.resolve("") };
    const manager = {
      spawn: vi.fn((_pi: any, _ctx: any, type: any, prompt: any, options: any) => {
        spawns.push({ t: type, prompt, o: options });
        return "agent1";
      }),
      awaitStartup: vi.fn(async () => {}),
      getRecord: vi.fn(() => record),
    } as any;
    const scheduler = new SubagentScheduler();
    scheduler.start({ events: { emit: (name: string, event: unknown) => events.push({ n: name, e: event }) } } as any,
      { modelRegistry: { find: () => undefined, getAvailable: () => [] } } as any, manager, store);
    const once = scheduler.addJob({
      name: "once", description: "once", schedule: "2030-01-01T00:00:05.000Z",
      subagent_type: "general-purpose", prompt: "p1", isolation: "worktree",
    });
    const interval = scheduler.addJob({
      name: "iv", description: "iv", schedule: "10s", subagent_type: "general-purpose", prompt: "p2", max_turns: 3,
    });
    await vi.advanceTimersByTimeAsync(11_000);
    await flush();
    scheduler.stop();
    const bytes = readFileSync(file, "utf8").replaceAll(once.id, "ONCE").replaceAll(interval.id, "IV");
    const normalizedEvents = JSON.parse(JSON.stringify(events).replaceAll(once.id, "ONCE").replaceAll(interval.id, "IV"));
    vi.useRealTimers();
    expectHead("D6", { spawns, events: normalizedEvents, bytes });
  });

  it("D7: guard-off schedule store round-trip keeps extra keys and key order", () => {
    const directory = temp("guard-off-store-order-");
    const file = join(directory, "s.json");
    const original = {
      version: 1,
      jobs: [{
        runCount: 2, id: "J1", name: "n", lastStatus: "success", description: "d", schedule: "1h",
        scheduleType: "interval", intervalMs: 3_600_000, subagent_type: "general-purpose", prompt: "p",
        enabled: true, createdAt: "2030-01-01T00:00:00.000Z", userNote: "keep me", lastRun: "2030-01-01T01:00:00.000Z",
      }],
    };
    writeFileSync(file, JSON.stringify(original, null, 2));
    const store = new ScheduleStore(file);
    store.update("J1", { enabled: false });
    expectHead("D7", { bytes: readFileSync(file, "utf8"), got: store.get("J1") });
  });

  it("D8: guard-off worktree spawn and abort", async () => {
    const log: unknown[] = [];
    runnerMocks.runAgent.mockImplementation(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      await new Promise<void>(resolve => options.signal?.addEventListener("abort", resolve, { once: true }));
      return { responseText: "", session: undefined, aborted: true, steered: false };
    });
    const manager = new AgentManager();
    managers.push(manager);
    const ctx = {
      cwd: FIXED,
      sessionManager: { getSessionId: () => "s" },
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
    } as any;
    const id = manager.spawn({ exec: fakeExec(log) } as any, ctx, "general-purpose", "w", {
      description: "x", isolation: "worktree",
    } as any);
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    manager.abort(id);
    await record.promise;
    await flush();
    expectHead("D8", { log, status: record.status, wtr: record.worktreeResult, error: record.error ?? null });
  });
});
