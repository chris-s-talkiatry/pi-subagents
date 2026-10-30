/**
 * skill-loader.ts — Preload named skills.
 *
 * Roots, in precedence order:
 *   - <cwd>/.pi/skills           (project, Pi's standard)
 *   - <cwd>/.agents/skills       (project, cross-tool Agent Skills spec — https://agentskills.io)
 *   - getAgentDir()/skills       (user, default ~/.pi/agent/skills — Pi's standard)
 *   - ~/.agents/skills           (user, cross-tool Agent Skills spec)
 *   - ~/.pi/skills               (legacy global, pre-Pi)
 *
 * Layout per root:
 *   - <root>/<name>.md            (flat file at the top level)
 *   - <root>/.../<name>/SKILL.md  (directory skill, may be nested — Pi's standard)
 *
 * Recursion skips dotfile entries and node_modules. A directory that itself contains
 * SKILL.md is a skill — we don't descend into it (Pi: skills don't nest).
 *
 * Symlinks are rejected for security (deviation from Pi, which follows them).
 */

import type { Dirent } from "node:fs";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSymlink, isUnsafeName, safeReadFile } from "./memory.js";

export interface PreloadedSkill {
  name: string;
  content: string;
  /** Canonical absolute file identity, when the skill could be read. */
  sourceIdentity?: string;
  /** Exact UTF-8 file text, including frontmatter and surrounding whitespace. */
  sourceText?: string;
  resolved?: boolean;
}

export function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[] {
  return skillNames.map((name) => {
    const loaded = loadSkillContent(name, cwd);
    return {
      name,
      content: loaded?.content ?? (isUnsafeName(name)
        ? `(Skill "${name}" skipped: name contains path traversal characters)`
        : `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`),
      ...(loaded ? { sourceIdentity: loaded.sourceIdentity, sourceText: loaded.sourceText, resolved: true } : { resolved: false }),
    };
  });
}

function loadSkillContent(name: string, cwd: string): { content: string; sourceIdentity: string; sourceText: string } | undefined {
  if (isUnsafeName(name)) return undefined;
  const roots = [
    join(cwd, ".pi", "skills"), // project — Pi standard
    join(cwd, ".agents", "skills"), // project — Agent Skills spec
    join(getAgentDir(), "skills"), // user — Pi standard
    join(homedir(), ".agents", "skills"), // user — Agent Skills spec
    join(homedir(), ".pi", "skills"), // legacy global, pre-Pi
  ];
  for (const root of roots) {
    const loaded = findInRoot(root, name);
    if (loaded !== undefined) return loaded;
  }
  return undefined;
}

function findInRoot(root: string, name: string): { content: string; sourceIdentity: string; sourceText: string } | undefined {
  if (isSymlink(root)) return undefined; // reject symlinked roots entirely
  const flatPath = join(root, `${name}.md`);
  const text = safeReadFile(flatPath);
  if (text !== undefined) return makeLoadedSkill(flatPath, text);
  return findSkillDirectory(root, name);
}

function makeLoadedSkill(path: string, sourceText: string): { content: string; sourceIdentity: string; sourceText: string } | undefined {
  try {
    return { content: sourceText.trim(), sourceIdentity: realpathSync(path), sourceText };
  } catch {
    return undefined;
  }
}

/** BFS under `root` for a directory named `name` containing `SKILL.md`. Pi-conforming filters. */
function findSkillDirectory(root: string, name: string): { content: string; sourceIdentity: string; sourceText: string } | undefined {
  if (!existsSync(root)) return undefined;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    // Deterministic byte-order traversal — locale-independent.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      // Symlinked dirs already filtered by entry.isDirectory() — Dirent uses lstat semantics.
      const path = join(current, entry.name);
      const skillMd = join(path, "SKILL.md");
      const isSkillDir = existsSync(skillMd);

      if (isSkillDir) {
        if (entry.name === name) {
          const sourceText = safeReadFile(skillMd);
          if (sourceText !== undefined) return makeLoadedSkill(skillMd, sourceText);
        }
        continue; // Pi rule: skills don't nest — don't descend into a skill dir
      }

      queue.push(path);
    }
  }
  return undefined;
}
