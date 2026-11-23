import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ controller: undefined as AbortController | undefined, abortOnWorktreeAdd: false }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((command: string, args: string[], options: any, callback: (...values: any[]) => void) => {
      try {
        const stdout = actual.execFileSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8" });
        if (race.abortOnWorktreeAdd && args.includes("worktree") && args.includes("add")) {
          race.abortOnWorktreeAdd = false;
          race.controller?.abort();
        }
        queueMicrotask(() => callback(null, stdout, ""));
      } catch (error) {
        queueMicrotask(() => callback(error, String((error as any).stdout ?? ""), String((error as any).stderr ?? "")));
      }
      return { kill: vi.fn() } as any;
    }),
  };
});

import { cleanupWorktree, createWorktree } from "../src/worktree.js";

const directories: string[] = [];
function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
afterEach(() => {
  race.controller = undefined;
  race.abortOnWorktreeAdd = false;
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("successful guarded command cancellation race", () => {
  it("keeps a worktree when abort is delivered after real git add exits 0 and before the callback", async () => {
    const repo = temp("guard-round2-command-race-");
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Command race");
    git(repo, "config", "user.email", "race@example.invalid");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", "seed.txt");
    git(repo, "commit", "-q", "-m", "seed");
    const controller = new AbortController();
    race.controller = controller;
    race.abortOnWorktreeAdd = true;
    const effects: any[] = [];
    const hooks: any = {
      childId: "command-race-child",
      parentWorkspace: repo,
      signal: controller.signal,
      reviewEffect: async (effect: any) => { effects.push(effect); },
    };
    const pi = { exec: async (command: string, args: string[], options: any) => {
      try { return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" }), stderr: "", code: 0, killed: false }; }
      catch (error: any) { return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: Number(error.status) || 1, killed: false }; }
    } } as any;

    const worktree = await createWorktree(pi, repo, hooks.childId, hooks);

    expect(controller.signal.aborted).toBe(true);
    expect(worktree).toBeDefined();
    expect(worktree && git(repo, "worktree", "list", "--porcelain")).toContain(worktree.path);
    hooks.signal = undefined;
    race.controller = undefined;
    const result = await cleanupWorktree(pi, repo, worktree!, "command race", hooks);
    expect(result.hasChanges).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(worktree!.path);
    expect(effects.some(effect => effect.argv.includes("add"))).toBe(true);
  });
});
