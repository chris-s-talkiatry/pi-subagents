/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GuardBridgeRejection, type GuardEffectDescription, type GuardEntryPathId, isForkReadOnlyGitCommand } from "./guard-bridge.js";
import type { EnvInfo } from "./types.js";

export async function detectEnv(
  pi: ExtensionAPI,
  cwd: string,
  reviewEffect?: (effect: GuardEffectDescription, entryPath: GuardEntryPathId) => Promise<void>,
  parentWorkspace = cwd,
  signal?: AbortSignal,
  assertEffectActive?: (entryPath: GuardEntryPathId) => void,
): Promise<EnvInfo> {
  let isGitRepo = false;
  let branch = "";

  try {
    if (reviewEffect) await reviewEffect({
      kind: "child-git-observation", command: "git", argv: Object.freeze(["rev-parse", "--is-inside-work-tree"]),
      cwd, envKeys: Object.freeze(Object.keys(process.env).sort()),
      resources: Object.freeze({ parentWorkspace }),
      ownedByPackage: false, boundTo: "unbounded",
      ...(isForkReadOnlyGitCommand("git", ["rev-parse", "--is-inside-work-tree"]) ? { readOnly: true as const } : {}),
    }, "agent-runner.detect-env");
    assertEffectActive?.("agent-runner.detect-env");
    const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000, ...(reviewEffect && signal ? { signal } : {}) });
    isGitRepo = result.code === 0 && result.stdout.trim() === "true";
  } catch (error) {
    if (reviewEffect && error instanceof GuardBridgeRejection) throw error;
    // Not a git repo or git not installed
  }

  if (isGitRepo) {
    try {
      if (reviewEffect) await reviewEffect({
        kind: "child-git-observation", command: "git", argv: Object.freeze(["branch", "--show-current"]),
        cwd, envKeys: Object.freeze(Object.keys(process.env).sort()),
        resources: Object.freeze({ parentWorkspace }),
        ownedByPackage: false, boundTo: "unbounded",
        ...(isForkReadOnlyGitCommand("git", ["branch", "--show-current"]) ? { readOnly: true as const } : {}),
      }, "agent-runner.detect-env");
      assertEffectActive?.("agent-runner.detect-env");
      const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5000, ...(reviewEffect && signal ? { signal } : {}) });
      branch = result.code === 0 ? result.stdout.trim() : "unknown";
    } catch (error) {
      if (reviewEffect && error instanceof GuardBridgeRejection) throw error;
      branch = "unknown";
    }
  }

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}
