import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GuardBridgeRejection, type GuardEffectDescription } from "../src/guard-bridge.js";
import { cleanupWorktree, createWorktree, type WorktreeEffectHooks } from "../src/worktree.js";

const directories: string[] = [];
const originalPath = process.env.PATH;
const savedEnv = new Map<string, string | undefined>();

function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(prefix: string): string {
  const directory = temp(prefix);
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Guard attack test");
  git(directory, "config", "user.email", "guard-attack@example.invalid");
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  git(directory, "add", "seed.txt");
  git(directory, "commit", "-q", "-m", "seed");
  return directory;
}

function hooks(baseRepo: string, childId: string, effects: GuardEffectDescription[], review?: (effect: GuardEffectDescription) => void): WorktreeEffectHooks {
  return {
    childId,
    parentWorkspace: baseRepo,
    reviewEffect: async effect => {
      effects.push(effect);
      review?.(effect);
    },
  };
}

function realGitExec() {
  return async (command: string, args: string[], options: any) => {
    try {
      return { stdout: execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8" }), stderr: "", code: 0, killed: false };
    } catch (error: any) {
      return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: typeof error.status === "number" ? error.status : 1, killed: false };
    }
  };
}

function logGitExecutions(): string {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = temp("guard-round2-git-bin-");
  const log = join(bin, "argv.log");
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in *" gc --auto "*|*" maintenance run --auto "*) printf ran > "$WORKTREE_TEST_MAINTENANCE_MARKER";; esac\nprintf '%s\\n' "$@" >> "$WORKTREE_TEST_GIT_LOG"\nprintf '%s\\n' '__END_CALL__' >> "$WORKTREE_TEST_GIT_LOG"\nexec "$WORKTREE_TEST_REAL_GIT" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.WORKTREE_TEST_GIT_LOG = log;
  process.env.WORKTREE_TEST_REAL_GIT = realGit;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  return log;
}

function loggedArgv(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("__END_CALL__\n").filter(Boolean).map(call => call.trimEnd().split("\n"));
}

async function makeTree(baseRepo: string, childId: string, effects: GuardEffectDescription[], review?: (effect: GuardEffectDescription) => void) {
  const worktree = await createWorktree({ exec: realGitExec() } as any, baseRepo, childId, hooks(baseRepo, childId, effects, review));
  expect(worktree).toBeDefined();
  directories.push(worktree!.path);
  return worktree!;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  process.env.PATH = originalPath;
  for (const key of ["WORKTREE_TEST_GIT_LOG", "WORKTREE_TEST_REAL_GIT", "WORKTREE_TEST_MAINTENANCE_MARKER", ...savedEnv.keys()]) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe("guarded worktree real-Git attack matrix", () => {
  it.each(["hooksPath", "include", "includeIf", "fsmonitor"] as const)("neutralizes hostile %s config", async attack => {
    const base = repo(`guard-round2-${attack}-`);
    const marker = join(temp("guard-round2-config-marker-"), "ran");
    const hookDir = join(base, "hostile-hooks");
    mkdirSync(hookDir);
    writeFileSync(join(hookDir, "post-commit"), `#!/bin/sh\nprintf ran > '${marker}'\n`);
    chmodSync(join(hookDir, "post-commit"), 0o755);
    const fsmonitor = join(base, "hostile-fsmonitor.sh");
    writeFileSync(fsmonitor, `#!/bin/sh\nprintf ran > '${marker}'\necho token\n`);
    chmodSync(fsmonitor, 0o755);
    if (attack === "hooksPath") git(base, "config", "core.hooksPath", hookDir);
    if (attack === "fsmonitor") git(base, "config", "core.fsmonitor", fsmonitor);
    if (attack === "include" || attack === "includeIf") {
      const included = join(base, "included-evil-config");
      writeFileSync(included, `[core]\n\thooksPath = ${hookDir}\n`);
      if (attack === "include") git(base, "config", "include.path", included);
      else {
        const commonDir = realpathSync(join(base, ".git"));
        git(base, "config", `includeIf.gitdir:${commonDir}/**.path`, included);
      }
    }
    const effects: GuardEffectDescription[] = [];
    const childId = `round2-${attack}`;
    const worktree = await makeTree(base, childId, effects);
    writeFileSync(join(worktree.path, "changed.txt"), "change\n");
    const result = await cleanupWorktree({ exec: realGitExec() } as any, base, worktree, attack, hooks(base, childId, effects));
    expect(result).toMatchObject({ hasChanges: true, branch: worktree.branch });
    expect(existsSync(marker)).toBe(false);
    expect(effects.filter(effect => effect.kind === "worktree-capture" && effect.argv.includes("commit")))
      .toEqual([expect.objectContaining({ ownedByPackage: true, boundTo: "owned-resources" })]);
  });

  it("keeps a submodule-only pointer bump, stages it, and commits the new gitlink", async () => {
    const source = repo("guard-round2-submodule-source-");
    const base = repo("guard-round2-submodule-super-");
    git(base, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
    git(base, "commit", "-q", "-m", "add submodule");
    const oldPointer = git(base, "rev-parse", "HEAD:sub");
    git(source, "commit", "--allow-empty", "-q", "-m", "v2");
    const newPointer = git(source, "rev-parse", "HEAD");
    const effects: GuardEffectDescription[] = [];
    const childId = "round2-submodule-pointer";
    const worktree = await makeTree(base, childId, effects);
    git(worktree.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    git(join(worktree.path, "sub"), "checkout", "-q", newPointer);

    const result = await cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "submodule pointer bump", hooks(base, childId, effects));

    expect(oldPointer).not.toBe(newPointer);
    expect(result).toMatchObject({ hasChanges: true, branch: worktree.branch });
    expect(git(base, "rev-parse", `${worktree.branch}:sub`)).toBe(newPointer);
    expect(effects.find(effect => effect.argv.includes("status"))?.argv.slice(-4)).toEqual([
      "status", "--porcelain", "--ignore-submodules=dirty", "--untracked-files=all",
    ]);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("never runs a child-authored submodule filter while checking status (A1 dirty-mode proof)", async () => {
    const base = repo("guard-round2-submodule-filter-super-");
    const source = repo("guard-round2-submodule-filter-source-");
    git(base, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
    git(base, "commit", "-q", "-m", "add submodule");
    const effects: GuardEffectDescription[] = [];
    const childId = "round2-submodule-filter";
    const worktree = await makeTree(base, childId, effects);
    const sub = join(worktree.path, "sub");
    rmSync(sub, { recursive: true, force: true });
    mkdirSync(sub);
    git(sub, "init", "-q");
    git(sub, "config", "user.name", "Child");
    git(sub, "config", "user.email", "child@example.invalid");
    writeFileSync(join(sub, ".gitattributes"), "*.txt filter=owned\n");
    writeFileSync(join(sub, "victim.txt"), "initial\n");
    git(sub, "add", ".");
    git(sub, "commit", "-q", "-m", "child repo");
    const marker = join(temp("guard-round2-submodule-filter-marker-"), "ran");
    const cleaner = join(sub, "clean.sh");
    writeFileSync(cleaner, `#!/bin/sh\nprintf 'ran\n' >> '${marker}'\ncat\n`);
    chmodSync(cleaner, 0o755);
    git(sub, "config", "filter.owned.clean", `sh '${cleaner}'`);
    writeFileSync(join(sub, "victim.txt"), "changed\n");
    writeFileSync(join(worktree.path, "root-change.txt"), "root\n");
    const captured = hooks(base, childId, effects, effect => {
      if (effect.argv.includes("add")) throw new GuardBridgeRejection("guard-effect-denied", "worktree.capture", "guard-effect-denied: staging denied.");
    });
    await expect(cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "filter", captured)).rejects.toMatchObject({ reasonCode: "guard-effect-denied" });
    const status = effects.find(effect => effect.argv.includes("status"));
    expect(status?.argv).toContain("--ignore-submodules=dirty");
    expect(status).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
    expect(existsSync(marker)).toBe(false);
  });

  it("captures untracked-only files despite status.showUntrackedFiles=no", async () => {
    const base = repo("guard-round2-untracked-config-");
    git(base, "config", "status.showUntrackedFiles", "no");
    const effects: GuardEffectDescription[] = [];
    const childId = "round2-untracked-only";
    const worktree = await makeTree(base, childId, effects);
    writeFileSync(join(worktree.path, "only-untracked.txt"), "retained\n");
    const result = await cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "untracked", hooks(base, childId, effects));
    expect(result.hasChanges).toBe(true);
    expect(git(base, "show", `${worktree.branch}:only-untracked.txt`)).toBe("retained");
  });

  it("keeps a successfully created worktree when abort arrives after git worktree add exits", async () => {
    const base = repo("guard-round2-abort-after-add-");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = temp("guard-round2-abort-wrapper-");
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, `#!/bin/sh\n"$WORKTREE_TEST_REAL_GIT" "$@"\ncode=$?\ncase " $* " in *" worktree add --detach "*) parent=$PPID; (/bin/sleep 0.01; /bin/kill -USR2 "$parent") >/dev/null 2>&1 </dev/null &;; esac\nexit "$code"\n`);
    chmodSync(wrapper, 0o755);
    process.env.WORKTREE_TEST_REAL_GIT = realGit;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    const controller = new AbortController();
    let signalDelivered!: () => void;
    const delivered = new Promise<void>(resolve => { signalDelivered = resolve; });
    const onSignal = () => { controller.abort(); signalDelivered(); };
    process.once("SIGUSR2", onSignal);
    const effects: GuardEffectDescription[] = [];
    const childId = "round2-abort-after-add";
    const worktreeHooks = hooks(base, childId, effects);
    worktreeHooks.signal = controller.signal;
    let worktree: Awaited<ReturnType<typeof createWorktree>>;
    try {
      worktree = await createWorktree({ exec: realGitExec() } as any, base, childId, worktreeHooks);
      await delivered;
    } finally {
      process.removeListener("SIGUSR2", onSignal);
    }
    expect(controller.signal.aborted).toBe(true);
    expect(worktree).toBeDefined();
    expect(existsSync(worktree!.path)).toBe(true);
    worktreeHooks.signal = undefined;
    await expect(cleanupWorktree({ exec: realGitExec() } as any, base, worktree!, "abort after add", worktreeHooks))
      .resolves.toMatchObject({ hasChanges: false });
    expect(existsSync(worktree!.path)).toBe(false);
  });

  it.each(["symbolic-ref", "switch"] as const)("refuses a worktree HEAD rewrite via %s before commit", async attack => {
    const base = repo(`guard-round2-head-${attack}-`);
    const mainBefore = git(base, "rev-parse", "HEAD");
    const effects: GuardEffectDescription[] = [];
    const childId = `round2-head-${attack}`;
    const worktree = await makeTree(base, childId, effects);
    if (attack === "symbolic-ref") git(worktree.path, "symbolic-ref", "HEAD", "refs/heads/main");
    else git(worktree.path, "switch", "--ignore-other-worktrees", "main");
    writeFileSync(join(worktree.path, "change.txt"), "must remain\n");
    await expect(cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "head rewrite", hooks(base, childId, effects)))
      .rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    const capture = effects.find(effect => effect.kind === "worktree-capture");
    expect(capture).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
    expect(git(base, "rev-parse", "HEAD")).toBe(mainBefore);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("refuses a rewritten commondir without using a different repository", async () => {
    const base = repo("guard-round2-commondir-base-");
    const other = repo("guard-round2-commondir-other-");
    const otherHead = git(other, "rev-parse", "HEAD");
    const effects: GuardEffectDescription[] = [];
    const childId = "round2-commondir";
    const worktree = await makeTree(base, childId, effects);
    const adminGitDir = realpathSync(worktree.gitDir!);
    writeFileSync(join(adminGitDir, "commondir"), `${realpathSync(join(other, ".git"))}\n`);
    writeFileSync(join(worktree.path, "change.txt"), "must remain\n");
    await expect(cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "commondir rewrite", hooks(base, childId, effects)))
      .rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    expect(effects.find(effect => effect.kind === "worktree-capture")).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
    expect(git(other, "rev-parse", "HEAD")).toBe(otherHead);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("neutralizes inherited GIT_* environment and preserves reviewed argv == executed argv", async () => {
    const base = repo("guard-round2-env-");
    const effects: GuardEffectDescription[] = [];
    const childId = "round2-git-env";
    const worktree = await makeTree(base, childId, effects);
    const log = logGitExecutions();
    const gitKeys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
    for (const key of gitKeys) {
      if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    }
    process.env.GIT_DIR = "/tmp/attacker.git";
    process.env.GIT_WORK_TREE = "/tmp/attacker-worktree";
    process.env.GIT_INDEX_FILE = "/tmp/attacker-index";
    process.env.GIT_COMMON_DIR = "/tmp/attacker-common";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_0 = "/tmp/attacker-hooks";
    writeFileSync(join(worktree.path, "change.txt"), "safe\n");
    const result = await cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "env", hooks(base, childId, effects));
    const hardenedEffects = effects.filter(effect => effect.envKeys.includes("GIT_CONFIG_NOSYSTEM") && effect.kind !== "worktree-create");
    expect(result.hasChanges).toBe(true);
    expect(hardenedEffects.every(effect => gitKeys.every(key => !effect.envKeys.includes(key)))).toBe(true);
    expect(loggedArgv(log)).toEqual(hardenedEffects.map(effect => [...effect.argv]));
    for (const key of gitKeys) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    expect(git(base, "show", `${worktree.branch}:change.txt`)).toBe("safe");
  });

  it("disables gc/maintenance auto-run despite gc.auto=1 and preserves commit as a single reviewed effect", async () => {
    const base = repo("guard-round2-gc-auto-");
    git(base, "config", "gc.auto", "1");
    git(base, "config", "gc.autoDetach", "true");
    git(base, "config", "maintenance.auto", "true");
    const effects: GuardEffectDescription[] = [];
    const childId = "round2-gc-auto";
    const worktree = await makeTree(base, childId, effects);
    writeFileSync(join(worktree.path, "change.txt"), "safe\n");
    const marker = join(temp("guard-round2-maintenance-marker-"), "ran");
    process.env.WORKTREE_TEST_MAINTENANCE_MARKER = marker;
    const log = logGitExecutions();
    const result = await cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "gc", hooks(base, childId, effects));
    const executedArgv = loggedArgv(log);
    const commit = effects.find(effect => effect.argv.includes("commit"));
    expect(result.hasChanges).toBe(true);
    expect(commit).toMatchObject({ ownedByPackage: true, boundTo: "owned-resources" });
    expect(commit?.argv).toEqual(expect.arrayContaining(["gc.auto=0", "gc.autoDetach=false", "maintenance.auto=false"]));
    expect(git(base, "rev-parse", `${worktree.branch}:change.txt`)).toBeDefined();
    expect(readdirSync(join(base, ".git", "objects", "pack")).filter(name => name.endsWith(".pack"))).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    const guardedCommands = effects.filter(effect => effect.envKeys.includes("GIT_CONFIG_NOSYSTEM") && effect.kind !== "worktree-create");
    expect(executedArgv).toEqual(guardedCommands.map(effect => [...effect.argv]));
  });

  it("keeps .gitattributes clean filters in the explicitly unbounded staging review", async () => {
    const base = repo("guard-round2-attributes-");
    writeFileSync(join(base, ".gitattributes"), "*.txt filter=owned\n");
    writeFileSync(join(base, "victim.txt"), "seed\n");
    git(base, "add", ".gitattributes", "victim.txt");
    git(base, "commit", "-q", "-m", "attributes");
    const effects: GuardEffectDescription[] = [];
    const childId = "round2-gitattributes";
    const worktree = await makeTree(base, childId, effects);
    const marker = join(temp("guard-round2-attributes-marker-"), "ran");
    const cleaner = join(worktree.path, "clean.sh");
    writeFileSync(cleaner, `#!/bin/sh\nprintf 'ran\n' >> '${marker}'\ncat\n`);
    chmodSync(cleaner, 0o755);
    git(worktree.path, "config", "filter.owned.clean", `sh '${cleaner}'`);
    writeFileSync(join(worktree.path, "victim.txt"), "modified\n");
    const effectHooks = hooks(base, childId, effects, effect => {
      if (effect.argv.at(-2) === "add") throw new GuardBridgeRejection("guard-effect-denied", "worktree.capture", "guard-effect-denied: clean-filter staging denied.");
    });
    await expect(cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "attributes", effectHooks))
      .rejects.toMatchObject({ reasonCode: "guard-effect-denied" });
    const add = effects.find(effect => effect.argv.at(-2) === "add");
    expect(add).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
    // Git may invoke clean filters during status itself; it is reviewed as
    // unbounded, and denial of the later add prevents any additional invocation.
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("refuses a rewritten worktree .git file before package-owned effects run", async () => {
    const base = repo("guard-round2-dotgit-");
    const effects: GuardEffectDescription[] = [];
    const childId = "round2-dotgit-rewrite";
    const worktree = await makeTree(base, childId, effects);
    const evilGitDir = join(worktree.path, ".evilgit");
    mkdirSync(evilGitDir);
    writeFileSync(join(evilGitDir, "config"), "[core]\n\thooksPath = /tmp/attacker-hooks\n");
    writeFileSync(join(worktree.path, ".git"), "gitdir: ./.evilgit\n");
    writeFileSync(join(worktree.path, "change.txt"), "must remain\n");
    await expect(cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "dotgit", hooks(base, childId, effects)))
      .rejects.toMatchObject({ reasonCode: "guard-effect-unavailable" });
    expect(effects.find(effect => effect.kind === "worktree-capture")).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
    expect(existsSync(worktree.path)).toBe(true);
  });
  it("owns commit and branch only after allowed staging review, confirmed by a real clean-filter marker", async () => {
    const base = repo("guard-round3-stage-approval-");
    writeFileSync(join(base, ".gitattributes"), "*.txt filter=owned\n");
    writeFileSync(join(base, "victim.txt"), "seed\n");
    git(base, "add", ".gitattributes", "victim.txt");
    git(base, "commit", "-q", "-m", "attributes");
    const effects: GuardEffectDescription[] = [];
    const childId = "round3-stage-approval";
    const worktree = await makeTree(base, childId, effects);
    const marker = join(temp("guard-round3-clean-filter-marker-"), "ran");
    const cleaner = join(worktree.path, "clean.sh");
    writeFileSync(cleaner, `#!/bin/sh\nprintf 'ran\\n' >> '${marker}'\ncat\n`);
    chmodSync(cleaner, 0o755);
    git(worktree.path, "config", "filter.owned.clean", `sh '${cleaner}'`);
    writeFileSync(join(worktree.path, "victim.txt"), "modified\n");

    let markerCallsAtCommitReview = 0;
    const effectHooks = hooks(base, childId, effects, effect => {
      if (effect.argv.includes("commit")) {
        markerCallsAtCommitReview = existsSync(marker) ? readFileSync(marker, "utf8").trim().split(/\r?\n/).length : 0;
      }
    });

    const result = await cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "filter marker", effectHooks);

    const add = effects.find(effect => effect.kind === "worktree-capture" && effect.argv.at(-2) === "add");
    const commit = effects.find(effect => effect.kind === "worktree-capture" && effect.argv.includes("commit"));
    const branch = effects.find(effect => effect.kind === "worktree-capture" && effect.argv.at(-2) === "branch");
    expect(result.hasChanges).toBe(true);
    expect(add).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
    expect(commit).toMatchObject({ ownedByPackage: true, boundTo: "owned-resources" });
    expect(branch).toMatchObject({ ownedByPackage: true, boundTo: "owned-resources" });
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8").trim().split(/\r?\n/).length).toBeGreaterThan(markerCallsAtCommitReview);
  });

  it("leaves branch creation unbounded when this cleanup has no preceding add -A", async () => {
    const base = repo("guard-round3-branch-no-stage-");
    const effects: GuardEffectDescription[] = [];
    const childId = "round3-branch-no-stage";
    const worktree = await makeTree(base, childId, effects);
    writeFileSync(join(worktree.path, "child-commit.txt"), "already committed by child\n");
    git(worktree.path, "add", "child-commit.txt");
    git(worktree.path, "commit", "-q", "-m", "child commit");

    const result = await cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "branch without stage", hooks(base, childId, effects));

    const branch = effects.find(effect => effect.kind === "worktree-capture" && effect.argv.at(-2) === "branch");
    expect(result.hasChanges).toBe(true);
    expect(effects.some(effect => effect.kind === "worktree-capture" && effect.argv.at(-2) === "add")).toBe(false);
    expect(branch).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
  });

  it("classifies the fallback prune during worktree removal as unbounded", async () => {
    const base = repo("guard-round3-fallback-prune-");
    const effects: GuardEffectDescription[] = [];
    const childId = "round3-fallback-prune";
    const worktree = await makeTree(base, childId, effects);
    const effectHooks = hooks(base, childId, effects, effect => {
      if (effect.kind === "worktree-remove") throw new Error("simulate an ordinary git remove failure");
    });

    const result = await cleanupWorktree({ exec: realGitExec() } as any, base, worktree, "fallback prune", effectHooks);

    const prune = effects.find(effect => effect.kind === "worktree-prune");
    expect(result.hasChanges).toBe(false);
    expect(prune).toMatchObject({ ownedByPackage: false, boundTo: "unbounded" });
  });


});
