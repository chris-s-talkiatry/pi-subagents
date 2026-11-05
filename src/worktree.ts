/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 *
 * Ordinary git calls go through `pi.exec` (async) rather than `execFileSync` so
 * worktree copies do not serialize isolated agents on the TUI event loop. Guarded
 * package-owned worktree operations use `execFile` with an explicit sanitized
 * environment because the extension exec API does not expose environment control.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardEffectDescription, GuardEntryPathId } from "./guard-bridge.js";
import { GuardBridgeRejection, isForkReadOnlyGitCommand } from "./guard-bridge.js";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /** Recorded administrative gitdir, when created on a guarded path. */
  gitDir?: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

/** Supplied only on guarded paths; omitting it preserves the upstream process path. */
export interface WorktreeEffectHooks {
  childId: string;
  parentWorkspace: string;
  delegationId?: string;
  signal?: AbortSignal;
  /** Optional command-lifetime signal distinct from review/child cancellation. */
  commandSignal?: AbortSignal;
  reviewEffect: (effect: GuardEffectDescription, entryPath: GuardEntryPathId) => Promise<void>;
  assertSnapshotActive?: (entryPath: GuardEntryPathId) => void;
}

interface OwnedWorktree {
  childId: string;
  delegationId?: string;
  path: string;
  branch: string;
  baseRepo: string;
  commonGitDir: string;
  gitDir: string;
  realPath?: string;
  created: boolean;
}

/** Exact fork-created resources, keyed by child, path, branch, repository, and delegation. */
const ownedWorktrees = new Map<string, OwnedWorktree>();

function ownershipKey(owner: OwnedWorktree): string {
  return JSON.stringify([owner.childId, owner.path, owner.branch, owner.baseRepo, owner.delegationId ?? ""]);
}

function rememberOwner(owner: OwnedWorktree): void {
  for (const [key, value] of ownedWorktrees) if (value === owner) ownedWorktrees.delete(key);
  ownedWorktrees.set(ownershipKey(owner), owner);
}

function forgetOwner(owner: OwnedWorktree): void {
  ownedWorktrees.delete(ownershipKey(owner));
}

function findOwnedWorktree(
  hooks: WorktreeEffectHooks | undefined,
  cwd: string,
  args: readonly string[],
  ownerPath?: string,
): OwnedWorktree | undefined {
  if (!hooks) return undefined;
  const pathArg = ownerPath ?? (args[0] === "worktree" && (args[1] === "remove" || args[1] === "add") ? args[3] : undefined);
  const candidatePath = resolve(pathArg ?? cwd);
  const matches: OwnedWorktree[] = [];
  for (const owner of ownedWorktrees.values()) {
    if (owner.childId !== hooks.childId || owner.path !== candidatePath || owner.delegationId !== hooks.delegationId) continue;
    if (args[0] === "worktree" && (args[1] === "add" || args[1] === "remove" || args[1] === "prune")) {
      if (!insideRoot(cwd, owner.baseRepo)) continue;
    } else if (resolve(cwd) !== owner.path) continue;
    matches.push(owner);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function findOwnerForCleanup(hooks: WorktreeEffectHooks | undefined, worktree: WorktreeInfo): OwnedWorktree | undefined {
  if (!hooks || !worktree.gitDir) return undefined;
  for (const owner of ownedWorktrees.values()) {
    if (owner.childId === hooks.childId && owner.delegationId === hooks.delegationId && owner.gitDir === worktree.gitDir) return owner;
  }
  return undefined;
}

function worktreeGitDirMatches(owner: OwnedWorktree): boolean {
  try {
    const pointer = readFileSync(join(owner.path, ".git"), "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    if (!pointer) return false;
    const actual = realpathSync(isAbsolute(pointer) ? pointer : resolve(owner.path, pointer));
    return actual === owner.gitDir;
  } catch {
    return false;
  }
}

function readCommonGitDir(repo: string): string {
  const marker = join(repo, ".git");
  try {
    if (statSync(marker).isDirectory()) return realpathSync(marker);
  } catch {
    // Continue with linked-worktree `.git` file parsing.
  }
  const markerText = readFileSync(marker, "utf8");
  const gitdirLine = markerText.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!gitdirLine) throw new Error("Unable to record worktree gitdir.");
  const gitdir = realpathSync(isAbsolute(gitdirLine) ? gitdirLine : resolve(repo, gitdirLine));
  const commonFile = join(gitdir, "commondir");
  if (!existsSync(commonFile)) return gitdir;
  const commonLine = readFileSync(commonFile, "utf8").trim();
  return realpathSync(isAbsolute(commonLine) ? commonLine : resolve(gitdir, commonLine));
}

const HARDENED_GIT_ARGS = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.sshCommand=/bin/false",
  "-c", "protocol.allow=never",
  "-c", "commit.gpgsign=false",
] as const;

function hardenedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key) && value !== undefined) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

function runHardenedGit(args: string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
  return new Promise(resolveResult => {
    execFile("git", args, { cwd, env, timeout, signal, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
        ? (error as NodeJS.ErrnoException & { code: number }).code
        : error ? 1 : 0;
      resolveResult({ stdout: String(stdout), stderr: String(stderr), code, killed: Boolean((error as NodeJS.ErrnoException & { killed?: boolean } | null)?.killed) });
    });
  });
}
/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * `subagents.json`). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path if it was kept. */
  path?: string;
}

function insideRoot(candidate: string, root: string): boolean {
  if (!isAbsolute(candidate) || candidate.split(sep).includes("..")) return false;
  let absoluteCandidate = resolve(candidate);
  let absoluteRoot = resolve(root);
  try {
    // Resolve existing paths so `/tmp` aliases work, while the recorded root and
    // exact-worktree check still reject any symlink whose target escapes it.
    if (existsSync(candidate) && existsSync(root)) {
      absoluteCandidate = realpathSync(candidate);
      absoluteRoot = realpathSync(root);
    }
  } catch {
    return false;
  }
  const rel = relative(absoluteRoot, absoluteCandidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sameOwnedWorktree(candidate: string, owner: OwnedWorktree): boolean {
  if (!owner.realPath || candidate.split(sep).includes("..") || resolve(candidate) !== owner.path || !existsSync(candidate)) return false;
  try {
    return realpathSync(candidate) === owner.realPath;
  } catch {
    return false;
  }
}

function effectKind(kind: GuardEffectDescription["kind"]): GuardEntryPathId {
  switch (kind) {
    case "worktree-create": return "worktree.create";
    case "worktree-capture": return "worktree.capture";
    case "worktree-remove": return "worktree.remove";
    case "worktree-prune": return "worktree.prune";
    case "child-git-observation": return "agent-runner.detect-env";
    default: return "workflow.pi-exec.gate";
  }
}

function canHardenCommand(
  kind: GuardEffectDescription["kind"],
  command: string,
  args: readonly string[],
  cwd: string,
  owner: OwnedWorktree | undefined,
  hooks: WorktreeEffectHooks | undefined,
): boolean {
  if (!hooks || !owner || owner.childId !== hooks.childId || owner.delegationId !== hooks.delegationId || command !== "git") return false;
  const exactBaseRepo = insideRoot(cwd, owner.baseRepo);
  if (kind === "worktree-create") {
    return !owner.created && exactBaseRepo && args[0] === "worktree" && args[1] === "add" &&
      args[2] === "--detach" && args[3] === owner.path && args[4] === "HEAD" &&
      !existsSync(owner.path) && owner.branch === `pi-agent-${owner.childId}`;
  }
  if (!owner.created || !worktreeGitDirMatches(owner)) return false;
  if (kind === "worktree-capture") {
    if (!sameOwnedWorktree(cwd, owner)) return false;
    if (args[0] === "status") return args.length === 2 && args[1] === "--porcelain";
    if (args[0] === "add") return args.length === 2 && args[1] === "-A";
    if (args[0] === "commit") return args.length === 4 && args[1] === "--no-verify" && args[2] === "-m";
    if (args[0] === "rev-parse") return args.length === 2 && args[1] === "HEAD";
    if (args[0] === "branch") return args.length === 2 && typeof args[1] === "string" && args[1].length > 0;
    return false;
  }
  if (kind === "worktree-remove") {
    return exactBaseRepo && args.length === 4 && args[0] === "worktree" && args[1] === "remove" &&
      args[2] === "--force" && args[3] === owner.path && sameOwnedWorktree(owner.path, owner);
  }
  if (kind === "worktree-prune") {
    return exactBaseRepo && args.length === 2 && args[0] === "worktree" && args[1] === "prune";
  }
  return false;
}

function packageOwnsCommand(
  kind: GuardEffectDescription["kind"],
  command: string,
  args: readonly string[],
  cwd: string,
  owner: OwnedWorktree | undefined,
  hooks: WorktreeEffectHooks | undefined,
  declaredBranch?: string,
): boolean {
  if (!canHardenCommand(kind, command, args, cwd, owner, hooks)) return false;
  // `git add` can invoke child-selected clean filters from .gitattributes and
  // local filter config; hardening prevents hooks but cannot bound those filters.
  if (kind === "worktree-capture" && args[0] === "add") return false;
  return declaredBranch === undefined || declaredBranch === owner?.branch;
}

function environmentKeys(): readonly string[] {
  return Object.keys(process.env).sort();
}

/**
 * Run git and return its trimmed stdout, throwing on failure so callers keep
 * the try/catch control flow `execFileSync` gave them.
 *
 * `pi.exec` never rejects — it reports failure in the result — and a command
 * killed by its timeout comes back as `killed` with an exit code of 0, so both
 * have to be checked to reproduce `execFileSync`'s "throws on anything but a
 * clean exit".
 */
async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeout: number,
  kind: GuardEffectDescription["kind"],
  hooks?: WorktreeEffectHooks,
  declaredBranch?: string,
  ownerPath?: string,
): Promise<string> {
  const owner = findOwnedWorktree(hooks, cwd, args, ownerPath);
  const ownedByPackage = packageOwnsCommand(kind, "git", args, cwd, owner, hooks, declaredBranch);
  const hardened = !!hooks && canHardenCommand(kind, "git", args, cwd, owner, hooks);
  const actualArgs = hardened
    ? [
        ...HARDENED_GIT_ARGS,
        `--git-dir=${kind === "worktree-create" ? owner!.commonGitDir : owner!.gitDir}`,
        `--work-tree=${kind === "worktree-create" ? owner!.baseRepo : owner!.path}`,
        ...args,
      ]
    : args;
  const env = hardened ? hardenedEnvironment() : undefined;
  if (hooks) {
    const branch = declaredBranch ?? owner?.branch;
    await hooks.reviewEffect({
      kind,
      command: "git",
      argv: Object.freeze([...actualArgs]),
      cwd,
      envKeys: Object.freeze(hardened ? Object.keys(env!).sort() : environmentKeys()),
      resources: Object.freeze({
        ...(owner ? { worktreePath: owner.path, baseRepo: owner.baseRepo } : {}),
        ...(branch ? { branch } : {}),
        parentWorkspace: hooks.parentWorkspace,
      }),
      ownedByPackage,
      boundTo: ownedByPackage ? "owned-resources" : "unbounded",
      ...(!hardened && isForkReadOnlyGitCommand("git", args) ? { readOnly: true as const } : {}),
    }, effectKind(kind));
    hooks.assertSnapshotActive?.(effectKind(kind));
    if (owner && ["worktree-capture", "worktree-remove", "worktree-prune"].includes(kind) && !worktreeGitDirMatches(owner)) {
      throw new GuardBridgeRejection(
        "guard-effect-unavailable", effectKind(kind),
        `guard-effect-unavailable: guarded work is unavailable at ${effectKind(kind)}; the recorded worktree gitdir changed before execution.`,
      );
    }
    if (ownedByPackage && !packageOwnsCommand(kind, "git", args, cwd, owner, hooks, declaredBranch)) {
      throw new GuardBridgeRejection(
        "guard-effect-unavailable", effectKind(kind),
        `guard-effect-unavailable: guarded work is unavailable at ${effectKind(kind)}; package ownership changed before execution.`,
      );
    }
    const cleanupOperation = kind === "worktree-capture" || kind === "worktree-remove" ||
      (kind === "worktree-prune" && ownerPath !== undefined);
    const packageWorktreeAdd = kind === "worktree-create" && args[0] === "worktree" && args[1] === "add";
    if ((cleanupOperation || packageWorktreeAdd) && !hardened) {
      throw new GuardBridgeRejection(
        "guard-effect-unavailable", effectKind(kind),
        `guard-effect-unavailable: guarded work is unavailable at ${effectKind(kind)}; no exact recorded gitdir was available to harden the command.`,
      );
    }
      const commandSignal = hooks.commandSignal ?? hooks.signal;
    if (commandSignal?.aborted) {
      throw new GuardBridgeRejection(
        "guard-effect-cancelled", effectKind(kind),
        `guard-effect-cancelled: guarded work is unavailable at ${effectKind(kind)}; the concrete effect was not executed.`,
      );
    }
  }
  const commandSignal = hooks?.commandSignal ?? hooks?.signal;
  const result = hardened
    ? await runHardenedGit(actualArgs, cwd, timeout, env!, commandSignal)
    : await pi.exec("git", actualArgs, { cwd, timeout, ...(commandSignal ? { signal: commandSignal } : {}) });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${actualArgs.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
  hooks?: WorktreeEffectHooks,
): Promise<WorktreeInfo | undefined> {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  let topLevel: string;
  try {
    await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 5000, "worktree-create", hooks);
    baseSha = await git(pi, cwd, ["rev-parse", "HEAD"], 5000, "worktree-create", hooks);
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    topLevel = await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000, "worktree-create", hooks);
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch (error) {
    if (hooks && error instanceof GuardBridgeRejection) throw error;
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);
  if (hooks && existsSync(worktreePath)) return undefined;
  let ownership: OwnedWorktree | undefined;
  try {
    if (hooks) {
      const baseRepo = realpathSync(topLevel);
      const commonGitDir = readCommonGitDir(baseRepo);
      ownership = {
        childId: agentId,
        delegationId: hooks.delegationId,
        path: resolve(worktreePath),
        branch,
        baseRepo,
        commonGitDir,
        gitDir: join(commonGitDir, "worktrees", basename(worktreePath)),
        created: false,
      };
      rememberOwner(ownership);
    }
  } catch {
    return undefined;
  }

  try {
    // Create detached worktree at HEAD. Its package-assigned target path and
    // branch are explicitly reserved above and the reservation is per child.
    await git(pi, cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], 30000, "worktree-create", hooks);
    if (ownership) {
      ownership.created = true;
      ownership.realPath = realpathSync(worktreePath);
      ownership.gitDir = realpathSync(ownership.gitDir);
      if (!worktreeGitDirMatches(ownership)) throw new Error("Created worktree gitdir did not match the recorded gitdir.");
    }
    return { path: worktreePath, branch, baseSha, ...(ownership ? { gitDir: ownership.gitDir } : {}), workPath: subdir ? join(worktreePath, subdir) : worktreePath };
  } catch (error) {
    if (ownership) forgetOwner(ownership);
    if (hooks && error instanceof GuardBridgeRejection) throw error;
    // If worktree creation fails, return undefined (agent runs in normal cwd).
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
  hooks?: WorktreeEffectHooks,
): Promise<WorktreeCleanupResult> {
  const owner = findOwnedWorktree(hooks, worktree.path, ["status", "--porcelain"], worktree.path) ??
    findOwnerForCleanup(hooks, worktree);
  try {
    if (!existsSync(worktree.path)) return { hasChanges: false };

    try {
      const status = await git(pi, worktree.path, ["status", "--porcelain"], 10000, "worktree-capture", hooks, worktree.branch, worktree.path);
      if (status) {
        await git(pi, worktree.path, ["add", "-A"], 10000, "worktree-capture", hooks, worktree.branch, worktree.path);
        const safeDesc = agentDescription.slice(0, 200);
        const commitMsg = `pi-agent: ${safeDesc}`;
        await git(pi, worktree.path, ["commit", "--no-verify", "-m", commitMsg], 10000, "worktree-capture", hooks, worktree.branch, worktree.path);
      } else {
        const currentSha = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000, "worktree-capture", hooks, worktree.branch, worktree.path);
        if (currentSha === worktree.baseSha) {
          await removeWorktree(pi, cwd, worktree.path, hooks, worktree.branch);
          return { hasChanges: false };
        }
      }

      let branchName = worktree.branch;
      try {
        await git(pi, worktree.path, ["branch", branchName], 5000, "worktree-capture", hooks, branchName, worktree.path);
      } catch (error) {
        if (hooks && error instanceof GuardBridgeRejection) throw error;
        branchName = `${worktree.branch}-${Date.now()}`;
        if (owner && hooks && worktree.branch === owner.branch) {
          owner.branch = branchName;
          rememberOwner(owner);
        }
        await git(pi, worktree.path, ["branch", branchName], 5000, "worktree-capture", hooks, branchName, worktree.path);
      }
      worktree.branch = branchName;
      await removeWorktree(pi, cwd, worktree.path, hooks, worktree.branch);
      return { hasChanges: true, branch: worktree.branch, path: worktree.path };
    } catch (error) {
      if (hooks && error instanceof GuardBridgeRejection) throw error;
      try { await removeWorktree(pi, cwd, worktree.path, hooks, worktree.branch); } catch { /* best effort */ }
      return { hasChanges: false };
    }
  } finally {
    if (owner) forgetOwner(owner);
  }
}

/**
 * Force-remove a worktree.
 */
async function removeWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktreePath: string,
  hooks?: WorktreeEffectHooks,
  branch?: string,
): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "remove", "--force", worktreePath], 10000, "worktree-remove", hooks, branch, worktreePath);
  } catch (error) {
    if (hooks && error instanceof GuardBridgeRejection) throw error;
    // If git worktree remove fails, try pruning
    try {
      await git(pi, cwd, ["worktree", "prune"], 5000, "worktree-prune", hooks, branch, worktreePath);
    } catch (pruneError) {
      if (hooks && pruneError instanceof GuardBridgeRejection) throw pruneError;
      // best effort
    }
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export async function pruneWorktrees(pi: ExtensionAPI, cwd: string, hooks?: WorktreeEffectHooks): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "prune"], 5000, "worktree-prune", hooks);
  } catch { /* best effort; a rejected review leaves git untouched */ }
}
