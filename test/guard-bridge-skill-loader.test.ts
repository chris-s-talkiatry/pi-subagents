import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preloadSkills } from "../src/skill-loader.js";

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("skill loader guard-enrollment source text", () => {
  it("preserves canonical file identity and exact text including frontmatter", () => {
    root = mkdtempSync(join(tmpdir(), "guard-skill-source-"));
    const skillFile = join(root, ".pi", "skills", "source-identity", "SKILL.md");
    mkdirSync(join(root, ".pi", "skills", "source-identity"), { recursive: true });
    const sourceText = "---\nname: source-identity\n---\nRestriction text.\n";
    writeFileSync(skillFile, sourceText, "utf8");

    const skill = preloadSkills(["source-identity"], root)[0];

    expect(skill).toMatchObject({
      name: "source-identity",
      sourceIdentity: realpathSync(skillFile),
      sourceText,
      resolved: true,
    });
    expect(skill.content).toBe(sourceText.trim());
  });

  it("marks missing skills unresolved instead of presenting fallback text as resolved", () => {
    root = mkdtempSync(join(tmpdir(), "guard-skill-missing-"));
    const missingName = `missing-${process.pid}-${Date.now()}`;

    const skill = preloadSkills([missingName], root)[0];

    expect(skill.name).toBe(missingName);
    expect(skill.resolved).toBe(false);
    expect(skill.sourceIdentity).toBeUndefined();
    expect(skill.sourceText).toBeUndefined();
    expect(skill.content).toContain("not found");
  });
});
