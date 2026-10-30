import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuardBridgeHost, getGuardBridgeAdvertisement } from "../src/guard-bridge.js";
import { getGuardExpectedDiagnostic, getGuardRegistrantDiagnostic, loadSettings } from "../src/settings.js";

describe("guardExpected configuration fails closed when malformed", () => {
  let globalDir: string;
  let projectDir: string;
  let oldAgentDir: string | undefined;
  let warning: ReturnType<typeof vi.spyOn>;

  const writeGlobal = (text: string) => writeFileSync(join(globalDir, "subagents.json"), text);
  const writeProject = (text: string) => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "subagents.json"), text);
  };

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "guard-settings-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "guard-settings-project-"));
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
    warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warning.mockRestore();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it.each([
    ["string", '"true"'],
    ["number", "1"],
    ["null", "null"],
  ])("fails closed for a project guardExpected %s", (_kind, value) => {
    writeProject(`{"guardExpected":${value},"maxConcurrent":7}`);
    const settings = loadSettings(projectDir);
    expect(settings.guardExpected).toBe(true);
    expect(getGuardExpectedDiagnostic()).toContain("guardExpected must be a boolean");
    expect(warning).toHaveBeenCalledTimes(1);

    const host = new GuardBridgeHost(settings.guardExpected);
    host.setGuardExpectedDiagnostic(getGuardExpectedDiagnostic());
    expect(getGuardBridgeAdvertisement(host)).toMatchObject({
      guardExpectedDiagnostic: expect.stringContaining("guardExpected must be a boolean"),
    });
  });

  it("fails closed for invalid global configuration despite a valid project false", () => {
    writeGlobal('{"guardExpected":"yes"}');
    writeProject('{"guardExpected":false}');
    expect(loadSettings(projectDir).guardExpected).toBe(true);
    expect(getGuardExpectedDiagnostic()).toContain("guardExpected must be a boolean");
  });

  it("ignores an unreadable settings path without opting the user into guardExpected", () => {
    mkdirSync(join(projectDir, ".pi", "subagents.json"), { recursive: true });
    const settings = loadSettings(projectDir);
    expect(settings.guardExpected ?? false).toBe(false);
    expect(getGuardExpectedDiagnostic()).toContain(`settings file unreadable: ${join(projectDir, ".pi", "subagents.json")}`);
    expect(warning).toHaveBeenCalledTimes(1);

    const host = new GuardBridgeHost(settings.guardExpected === true, settings.guardRegistrant);
    host.setGuardExpectedDiagnostic(getGuardExpectedDiagnostic());
    expect(getGuardBridgeAdvertisement(host)).toMatchObject({
      guardExpected: false,
      configDiagnostic: expect.stringContaining("settings file unreadable:"),
    });
  });


  it("leaves valid false and absent settings permissive", () => {
    writeProject('{"guardExpected":false}');
    expect(loadSettings(projectDir).guardExpected).toBe(false);
    expect(getGuardExpectedDiagnostic()).toBeUndefined();

    writeProject('{"maxConcurrent":7}');
    expect(loadSettings(projectDir).guardExpected ?? false).toBe(false);
    expect(getGuardExpectedDiagnostic()).toBeUndefined();
  });

  it("fails closed for malformed JSON only when the raw file names guardExpected", () => {
    writeProject('{"guardExpected": true, broken');
    expect(loadSettings(projectDir).guardExpected).toBe(true);
    expect(getGuardExpectedDiagnostic()).toContain("contains guardExpected");
    expect(warning).toHaveBeenCalledTimes(1);

    warning.mockClear();
    writeProject('{"maxConcurrent": 7, broken');
    expect(loadSettings(projectDir).guardExpected ?? false).toBe(false);
    expect(getGuardExpectedDiagnostic()).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toContain("Ignoring malformed settings");
  });

  it("also fails closed for a malformed global file naming guardExpected", () => {
    writeGlobal('{ broken "guardExpected"');
    expect(loadSettings(projectDir).guardExpected).toBe(true);
    expect(getGuardExpectedDiagnostic()).toContain("guardExpected");
  });
  it("fails closed on conflicting registrant layers and advertises effective guard state", () => {
    writeGlobal('{"guardExpected":true,"guardRegistrant":"global-guard"}');
    writeProject('{"guardExpected":false,"guardRegistrant":"project-guard"}');
    const settings = loadSettings(projectDir);
    expect(settings.guardExpected).toBe(true);
    expect(settings.guardRegistrant).toBeUndefined();

    const host = new GuardBridgeHost(settings.guardExpected, settings.guardRegistrant);
    host.setGuardExpectedDiagnostic(getGuardExpectedDiagnostic());
    host.setGuardRegistrantDiagnostic(getGuardRegistrantDiagnostic());
    expect(host.requireGuard("agent-manager.spawn")).toMatchObject({
      ok: false,
      rejection: { reasonCode: "guard-registrant-conflict" },
    });
    expect(getGuardBridgeAdvertisement(host)).toMatchObject({
      guardExpected: true,
      guardRegistrant: null,
      configDiagnostic: expect.stringContaining("guard-registrant-conflict"),
    });
  });

  it("requires a configured registrant only when guardExpected is true", () => {
    writeProject('{"guardExpected":true}');
    const expected = loadSettings(projectDir);
    const guardedHost = new GuardBridgeHost(expected.guardExpected, expected.guardRegistrant);
    expect(guardedHost.requireGuard("agent-manager.spawn")).toMatchObject({
      ok: false,
      rejection: { reasonCode: "guard-registrant-unconfigured" },
    });

    writeProject('{"guardExpected":false}');
    const optional = loadSettings(projectDir);
    const optionalHost = new GuardBridgeHost(optional.guardExpected, optional.guardRegistrant);
    expect(optionalHost.requireGuard("agent-manager.spawn")).toEqual({ ok: true });
  });

  it("rejects malformed guardRegistrant settings and treats unparsable mentions as guarded", () => {
    writeProject('{"guardExpected":true,"guardRegistrant":null}');
    expect(loadSettings(projectDir).guardRegistrant).toBeUndefined();
    expect(getGuardRegistrantDiagnostic()).toContain("guardRegistrant must be a string");

    writeProject('{ broken "guardRegistrant"');
    expect(loadSettings(projectDir).guardExpected).toBe(true);
    expect(getGuardRegistrantDiagnostic()).toContain("guard-registrant-unconfigured");
  });


});
