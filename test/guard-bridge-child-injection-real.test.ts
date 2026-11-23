import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { agentCall, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";


const FORK_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const CHILD_PROMPT = "CHILD_INJECTION_REAL_PI_CHILD_PROMPT";
const homes: string[] = [];

function writeRealChildFixtures(cwd: string, logPath: string, originalPath: string, mutatedPath: string): void {
  const extensionsDir = join(cwd, ".pi", "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
    guardExpected: true,
    guardRegistrant: "scope-guard",
    outputTranscript: false,
  }));
  writeFileSync(originalPath, "ORIGINAL_CHILD_FILE_BYTES");
  writeFileSync(mutatedPath, "MUTATED_CHILD_FILE_BYTES");
  writeFileSync(join(extensionsDir, "discovered-guard.ts"), `
    import { appendFileSync } from "node:fs";
    import { getGuardChildContext, inChildSessionContext } from ${JSON.stringify(FORK_ENTRY)};
    export default function discoveredGuard(pi) {
      const context = getGuardChildContext(pi.events);
      const injectionHandle = undefined;
      appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
        type: "discovered",
        childId: context?.childId,
        hasContext: context !== undefined,
        hasHandle: injectionHandle !== undefined,
        childLoader: inChildSessionContext(),
      }) + "\\n");
      if (context !== undefined && injectionHandle === undefined) return;
      pi.registerTool({ name: "discovered_guard_probe", label: "discovered guard probe", description: "must remain inert in children", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "discovered guard probe" }] }) });
      pi.on("tool_call", event => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ type: "discovered-tool-hook", tool: event.toolName }) + "\\n"));
    }
  `);
  writeFileSync(join(extensionsDir, "read-mutator.ts"), `
    import { appendFileSync } from "node:fs";
    import { getGuardChildContext } from ${JSON.stringify(FORK_ENTRY)};
    export default function mutator(pi) {
      if (getGuardChildContext(pi.events) === undefined) return;
      pi.on("tool_call", event => {
        if (event.toolName !== "read") return;
        appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ type: "mutator", path: event.input.path }) + "\\n");
        event.input.path = ${JSON.stringify(mutatedPath)};
      });
    }
  `);
  writeFileSync(join(extensionsDir, "guard-registration.ts"), `
    import { appendFileSync } from "node:fs";
    import { getGuardChildContext } from ${JSON.stringify(FORK_ENTRY)};

    let registration;
    registration = {
      protocolVersion: 1,
      registrant: { id: "scope-guard", version: "test" },
      callbacks: {
        captureIngress: () => {},
        enrollResource: () => {},
        createChildContext: request => ({
          rootId: "root-from-guard",
          parentId: request.parentId,
          childId: request.childId,
          delegationId: request.delegationId,
          taskId: "task-from-guard",
          scopeRevision: 1,
          executionEpoch: 1,
          resolvedRestrictions: [],
          origin: request.origin,
          bridgeRef: registration,
        }),
        revalidate: () => "allowed",
        approvalSettled: () => {},
        approvalCancelled: () => {},
        approvalExpired: () => {},
        reviewEffect: () => "allowed",
      },
      createChildGuardExtension: (context, injection) => {
        appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
          type: "factory-request",
          childId: context.childId,
          handleChildId: injection.childId,
          tokenType: typeof injection.token,
        }) + "\\n");
        return pi => {
          appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
            type: "injected-init",
            childId: injection.childId,
            markerChildId: getGuardChildContext(pi.events)?.childId,
            tokenType: typeof injection.token,
          }) + "\\n");
          pi.on("tool_call", event => {
            if (event.toolName !== "read") return;
            const context = getGuardChildContext(pi.events);
            appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
              type: "injected-tool-hook",
              childId: injection.childId,
              markerChildId: context?.childId,
              path: event.input.path,
              tokenType: typeof injection.token,
            }) + "\\n");
          });
        };
      },
    };
    export default function registerGuard(pi) {
      pi.events.on("subagents:ready", () => pi.events.emit("subagents:guard:register", registration));
    }
  `);
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("real Pi child guard injection", () => {
  it("runs the child's tool_call hook after a discovered mutator and keeps discovered guard copies inert", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-child-injection-real-"));
    homes.push(cwd);
    const originalPath = join(cwd, "original.txt");
    const mutatedPath = join(cwd, "mutated.txt");
    const logPath = join(cwd, "hook-order.jsonl");
    writeRealChildFixtures(cwd, logPath, originalPath, mutatedPath);

    const run = await runPrintMode({
      cwd,
      prompt: "Delegate this request once and then report the child result.",
      live: false,
      hold: true,
      maxModelCalls: 8,
      respond: routeBySession({
        parentInitial: agentCall({
          prompt: CHILD_PROMPT,
          description: "real injected child",
          subagent_type: "general-purpose",
          run_in_background: false,
        }),
        parentFinal: "parent completed",
        subagent: context => {
          const hasReadResult = context.messages.some(message =>
            message.role === "toolResult" && (message as { toolName?: string }).toolName === "read",
          );
          return hasReadResult ? "child completed" : fauxToolCall("read", { path: originalPath });
        },
      }),
    });
    try {
      const log = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as {
        type: string;
        childId?: string;
        handleChildId?: string;
        markerChildId?: string;
        tokenType?: string;
        hasHandle?: boolean;
        childLoader?: boolean;
        path?: string;
        tool?: string;
        hasContext?: boolean;

      });
      const agentToolResult = run.parentSession.messages.find(message =>
        message.role === "toolResult" && (message as { toolName?: string }).toolName === "Agent",
      ) as { details?: { agentId?: string } } | undefined;
      const child = agentToolResult?.details?.agentId
        ? run.manager?.getRecord(agentToolResult.details.agentId) as {
            id: string;
            session?: {
              messages: Array<{ role: string; content: unknown }>;
              agent: { state: { guardChildContext?: GuardChildContext } };
              extensionRunner: { getExtensionPaths(): string[] };
              getActiveToolNames(): string[];
            };
          } | undefined
        : undefined;
      expect(child).toBeDefined();
      expect(child?.session?.messages.some(message => JSON.stringify(message.content).includes("MUTATED_CHILD_FILE_BYTES"))).toBe(true);
      expect(child?.session?.agent.state.guardChildContext?.childId).toBe(child?.id);
      expect(child?.session?.extensionRunner.getExtensionPaths().at(-1)).toBe("<inline:guard-child-injection>");
      expect(child?.session?.getActiveToolNames()).not.toContain("discovered_guard_probe");


      const discovered = log.find(entry => entry.type === "discovered" && entry.hasContext === true);
      const discoveredCopyWasInert = !log.some(entry => entry.type === "discovered-tool-hook" && entry.childId === child!.id);
      expect(discovered).toMatchObject({ childId: child!.id, hasContext: true, hasHandle: false });
      expect(log.filter(entry => entry.type === "discovered" && entry.hasContext === true)).toHaveLength(1);
      expect(discoveredCopyWasInert).toBe(true);
      expect(log.some(entry => entry.type === "discovered-tool-hook" && entry.childId === child!.id && entry.tool === "read")).toBe(false);

      expect(log.find(entry => entry.type === "factory-request")).toMatchObject({
        childId: child!.id,
        handleChildId: child!.id,
        tokenType: "symbol",
      });
      expect(log.find(entry => entry.type === "injected-init")).toMatchObject({
        childId: child!.id,
        markerChildId: child!.id,
        tokenType: "symbol",
      });
      const mutatorIndex = log.findIndex(entry => entry.type === "mutator");
      const injectedIndex = log.findIndex(entry => entry.type === "injected-tool-hook");
      expect(mutatorIndex).toBeGreaterThanOrEqual(0);
      expect(injectedIndex).toBeGreaterThan(mutatorIndex);
      expect(log[mutatorIndex]?.path).toBe(originalPath);
      expect(log[injectedIndex]?.path).toBe(mutatedPath);
    } finally {
      await run.dispose();
    }
  }, 30_000);

  it.each([
    ["extensions disabled", "tools: bash\nextensions: false"],
    ["extensions allowlist", "tools: bash\nextensions: other"],
    ["ext selector", "tools: bash, ext:other\nextensions: other"],
    ["isolated", "tools: bash\nisolated: true"],
  ])("does not add guard tools with %s and permits a requested built-in override", async (_label, frontmatter) => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-child-tool-scope-"));
    homes.push(cwd);
    const extensionsDir = join(cwd, ".pi", "extensions");
    const agentsDir = join(cwd, ".pi", "agents");
    mkdirSync(extensionsDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
      guardExpected: true,
      guardRegistrant: "scope-guard",
      outputTranscript: false,
    }));
    writeFileSync(join(agentsDir, "narrow.md"), `---\nname: narrow\ndescription: narrow\n${frontmatter}\n---\nnarrow agent\n`);
    writeFileSync(join(extensionsDir, "other.ts"), `export default function other(pi) {
      pi.registerTool({ name: "other_tool", label: "other", description: "other", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "other" }] }) });
    }`);
    writeFileSync(join(extensionsDir, "guard-registration.ts"), `
      let registration;
      registration = {
        protocolVersion: 1,
        registrant: { id: "scope-guard", version: "test" },
        callbacks: {
          captureIngress() {}, enrollResource() {},
          createChildContext: request => ({ rootId: "root", parentId: request.parentId, childId: request.childId, delegationId: request.delegationId, taskId: "task", scopeRevision: 0, executionEpoch: 0, resolvedRestrictions: [], origin: request.origin, bridgeRef: registration }),
          revalidate: () => "allowed", approvalSettled() {}, approvalCancelled() {}, approvalExpired() {},
          reviewEffect: () => "allowed",
        },
        createChildGuardExtension: () => pi => {
          const definition = (name, description) => ({ name, label: name, description, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: name }] }) });
          pi.registerTool(definition("guard_probe", "guard probe"));
          pi.registerTool(definition("bash", "guard bash override"));
        },
      };
      export default function registerGuard(pi) { pi.events.on("subagents:ready", () => pi.events.emit("subagents:guard:register", registration)); }
    `);

    let childToolNames: string[] | undefined;
    const run = await runPrintMode({
      cwd,
      prompt: "spawn the narrow agent",
      live: false,
      hold: true,
      maxModelCalls: 6,
      beforeRun: () => registerAgents(loadCustomAgents(cwd)),
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "child", description: "narrow", subagent_type: "narrow", run_in_background: false }),
        parentFinal: "done",
        subagent: context => {
          childToolNames = (context.tools ?? []).map((tool: { name: string }) => tool.name);
          return "child done";
        },
      }),
    });
    try {
      const result = run.parentSession.messages.find(message =>
        message.role === "toolResult" && (message as { toolName?: string }).toolName === "Agent",
      ) as { details?: { agentId?: string } } | undefined;
      const child = result?.details?.agentId ? run.manager?.getRecord(result.details.agentId) as any : undefined;
      const active = child?.session?.getActiveToolNames() as string[] | undefined;
      const tools = child?.session?.getAllTools() as Array<{ name: string; description?: string }> | undefined;
      expect(child).toBeDefined();
      expect(childToolNames).toContain("bash");
      expect(active).toContain("bash");
      expect(active).not.toContain("guard_probe");
      expect(childToolNames).not.toContain("guard_probe");
      expect(tools?.find(tool => tool.name === "bash")?.description).toBe("guard bash override");
    } finally {
      await run.dispose();
    }
  }, 30_000);
});
