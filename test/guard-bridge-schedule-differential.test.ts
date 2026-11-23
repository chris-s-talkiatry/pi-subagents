import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/agent-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/agent-runner.js")>();
  return { ...actual, ...runnerMocks };
});

import { AgentManager } from "../src/agent-manager.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

const directories: string[] = [];
const managers: AgentManager[] = [];
// Structured observations from a fresh `git archive v0.19.0` at
// 4f572eaa04c09d3dbc16e4a5f13a16b295e84e14; this fixture is not current-source output.
const V019_SCHEDULE_TRACE: unknown = JSON.parse(readFileSync(new URL("./fixtures/guard-off-schedule-v019.json", import.meta.url), "utf8"));

afterEach(async () => {
  vi.useRealTimers();
  runnerMocks.runAgent.mockReset();
  runnerMocks.resumeAgent.mockReset();
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("guard-off real-manager scheduled lifecycle differential", () => {
  it("matches archived upstream values for once, cron, expiry, disable, spawn-error, and runCount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const directory = mkdtempSync(join(tmpdir(), "guard-off-schedule-lifecycle-"));
    directories.push(directory);
    const file = join(directory, "schedule.json");
    const store = new ScheduleStore(file);
    const emitted: any[] = [];
    const pi = { events: { emit: (_name: string, event: any) => emitted.push(event) } } as any;
    const ctx = {
      cwd: directory,
      sessionManager: { getSessionId: () => "root-session" },
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
    } as any;
    const manager = new AgentManager();
    managers.push(manager);
    runnerMocks.runAgent.mockResolvedValue({ responseText: "done", session: undefined, aborted: false, steered: false });
    const originalSpawn = manager.spawn.bind(manager);
    const spawn = vi.spyOn(manager, "spawn");
    spawn.mockImplementation(((piArg: any, ctxArg: any, type: any, prompt: any, options: any) => {
      if (options.description === "spawn error job") throw new Error("spawn failed");
      return originalSpawn(piArg, ctxArg, type, prompt, options);
    }) as any);
    const scheduler = new SubagentScheduler({ now: () => Date.now() });
    scheduler.start(pi, ctx, manager, store);

    const once = scheduler.addJob({
      name: "once", description: "once job", schedule: "2030-01-01T00:00:05.000Z",
      subagent_type: "general-purpose", prompt: "once prompt",
    });
    const cron = scheduler.addJob({
      name: "cron", description: "cron job", schedule: "0 0 * * * *",
      subagent_type: "general-purpose", prompt: "cron prompt",
    });
    const expired = scheduler.addJob({
      name: "expired", description: "expired job", schedule: "1h",
      subagent_type: "general-purpose", prompt: "expired prompt",
    });
    scheduler.updateJob(expired.id, { schedule: "2029-12-31T23:59:59.000Z", scheduleType: "once" });
    const disabled = scheduler.addJob({
      name: "disabled", description: "disabled job", schedule: "1h",
      subagent_type: "general-purpose", prompt: "disabled prompt",
    });
    scheduler.updateJob(disabled.id, { enabled: false });
    const spawnError = scheduler.addJob({
      name: "spawn-error", description: "spawn error job", schedule: "1h",
      subagent_type: "missing-agent-type" as any, prompt: "error prompt",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(store.get(once.id)?.lastStatus).toBe("success"));
    (scheduler as any).executeJob(cron.id);
    (scheduler as any).executeJob(spawnError.id);
    await vi.waitFor(() => expect(store.get(cron.id)?.lastStatus).toBe("success"));
    await vi.waitFor(() => expect(store.get(spawnError.id)?.lastStatus).toBe("error"));

    const idMap = new Map([[once.id, "ONCE-ID"], [cron.id, "CRON-ID"], [expired.id, "EXPIRED-ID"], [disabled.id, "DISABLED-ID"], [spawnError.id, "ERROR-ID"]]);
    const agentIds = new Set<string>(emitted.filter(event => event.type === "fired").map(event => event.agentId));
    const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item !== "string") return item;
      let normalized = item;
      for (const [id, marker] of idMap) normalized = normalized.replaceAll(id, marker);
      for (const id of agentIds) normalized = normalized.replaceAll(id, "AGENT-ID");
      return normalized.replaceAll(directory, "SCHEDULE-DIR");
    }));
    const result = normalize({
      spawns: spawn.mock.calls.map(call => ({ type: call[2], prompt: call[3], options: call[4] })),
      events: emitted,
      jobs: store.list(),
      bytes: readFileSync(file, "utf8"),
      nextRuns: Object.fromEntries([once, cron, expired, disabled, spawnError].map(job => [job.name, scheduler.getNextRun(job.id) ?? null])),
    });
    if (process.env.PI_PRINT_SCHEDULE_TRACE === "1") console.log(JSON.stringify(result, null, 2));
    expect(result).toEqual(V019_SCHEDULE_TRACE);
    expect(spawn.mock.calls).toHaveLength(3);
    expect(store.get(once.id)).toMatchObject({ enabled: false, runCount: 1, lastStatus: "success" });
    expect(store.get(cron.id)).toMatchObject({ enabled: true, runCount: 1, lastStatus: "success" });
    expect(store.get(expired.id)).toMatchObject({ enabled: false, runCount: 0, lastStatus: "error" });
    expect(store.get(disabled.id)).toMatchObject({ enabled: false, runCount: 0 });
    expect(store.get(spawnError.id)).toMatchObject({ enabled: true, runCount: 0, lastStatus: "error" });
    scheduler.stop();
  });
});
