import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedSubagent } from "./tools/subagent-runner.ts";
import { runScoutTask } from "./tools/scout.ts";
import { runArchitectTask } from "./tools/architect.ts";
import { loadScanCache } from "./scan-cache.ts";

function fakeCli(t: any, script: string): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-runner-test-"));
	const previousPath = process.env.PATH;
	t.after(() => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(cwd, { recursive: true, force: true });
	});
	for (const [name, content] of Object.entries({ tmux: "exit 1", pi: script })) {
		const path = join(cwd, name);
		writeFileSync(path, `#!/bin/sh\n${content}\n`);
		chmodSync(path, 0o700);
	}
	// Include agentBin so the runner preserves our offline CLI stubs first in PATH.
	process.env.PATH = `${cwd}:${join(homedir(), ".pi", "agent", "bin")}:${previousPath ?? ""}`;
	return cwd;
}

test("partial stdout from a failed child cannot produce a scout cache or architect plan", async (t) => {
	const cwd = fakeCli(t, "printf 'Partial output long enough to look like a successful summary\\n'\nprintf 'Provider failed\\n' >&2\nexit 1");
	const ctx = { cwd } as any;
	const scout = await runScoutTask({}, ctx);
	assert.equal(scout.success, false);
	assert.match(scout.error!, /Provider failed/);
	assert.equal(loadScanCache(cwd), null);
	const architect = await runArchitectTask({ task: "Offline test" }, ctx);
	assert.equal(architect.success, false);
	assert.match(architect.error!, /Provider failed/);
});

test("nonzero child exit without stderr still reports its exit code", async (t) => {
	const cwd = fakeCli(t, "printf 'Partial output\\n'\nexit 2");
	await assert.rejects(runIsolatedSubagent({
		name: "test", provider: "test", model: "test", tools: "read", cwd, prompt: "Offline test", timeoutMs: 2000,
	}), /exited with code 2/);
});

test("successful child stdout remains usable by scout", async (t) => {
	const cwd = fakeCli(t, "printf '<repo_summary>Verified offline repository architecture summary.</repo_summary>\\n'\nexit 0");
	const result = await runScoutTask({}, { cwd } as any);
	assert.equal(result.success, true);
	assert.equal(result.repoSummary, "Verified offline repository architecture summary.");
	assert.equal(loadScanCache(cwd)?.repoSummary, result.repoSummary);
});
