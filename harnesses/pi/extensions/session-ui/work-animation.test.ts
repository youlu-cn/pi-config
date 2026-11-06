import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { phaseForTool } from "./work-animation-core.ts";
import { loadWorkAnimationState, saveWorkAnimationState } from "./work-animation-state.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "session-ui-state-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, path: join(root, "state", "session-ui.json") };
}

test("phaseForTool maps common tool families", () => {
	assert.equal(phaseForTool("read"), "Reading...");
	assert.equal(phaseForTool("web_search"), "Searching...");
	assert.equal(phaseForTool("lsp_diagnostics"), "Checking code...");
	assert.equal(phaseForTool("bash"), "Running command...");
	assert.equal(phaseForTool("generate_image"), "Processing image...");
	assert.equal(phaseForTool("@@@"), "Using tool...");
});

test("missing state uses the configured default without creating files", (t) => {
	const { path } = fixture(t);
	assert.deepEqual(loadWorkAnimationState(path, true), { enabled: true });
	assert.deepEqual(loadWorkAnimationState(path, false), { enabled: false });
	assert.equal(existsSync(dirname(path)), false);
});

test("persists the switch independently of config and preserves unrelated state", (t) => {
	const { root, path } = fixture(t);
	const configPath = join(root, "config.json");
	const config = '{"workAnimation":{"enabled":true,"intervalMs":200}}\n';
	writeFileSync(configPath, config);
	saveWorkAnimationState(path, false);
	assert.deepEqual(loadWorkAnimationState(path, true), { enabled: false });
	assert.equal(readFileSync(configPath, "utf8"), config);

	writeFileSync(path, JSON.stringify({ other: { value: 1 }, workAnimation: { enabled: false, extra: 2 } }));
	saveWorkAnimationState(path, true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		other: { value: 1 }, workAnimation: { enabled: true, extra: 2 },
	});
	assert.deepEqual(loadWorkAnimationState(path, false), { enabled: true });
	assert.deepEqual(readdirSync(dirname(path)), ["session-ui.json"]);
});

test("missing animation fields use defaults and can be saved", (t) => {
	const { path } = fixture(t);
	mkdirSync(dirname(path));
	for (const raw of [{}, { workAnimation: {} }, { other: true }]) {
		writeFileSync(path, JSON.stringify(raw));
		assert.deepEqual(loadWorkAnimationState(path, false), { enabled: false });
		saveWorkAnimationState(path, true);
		assert.deepEqual(loadWorkAnimationState(path, false), { enabled: true });
	}
});

test("invalid state warns, uses defaults and is not overwritten", (t) => {
	const { path } = fixture(t);
	mkdirSync(dirname(path));
	for (const raw of ["{", "null", "[]", '{"workAnimation":false}', '{"workAnimation":{"enabled":"false"}}']) {
		writeFileSync(path, raw);
		const result = loadWorkAnimationState(path, false);
		assert.equal(result.enabled, false);
		assert.match(result.warning!, /session-ui state.*using configured work animation default \(off\)/);
		assert.ok(result.warning!.includes(path));
		assert.throws(() => saveWorkAnimationState(path, true));
		assert.equal(readFileSync(path, "utf8"), raw);
		assert.deepEqual(readdirSync(dirname(path)), ["session-ui.json"]);
	}
});

test("unreadable state warns and failed writes do not leave temporary files", (t) => {
	const { root, path } = fixture(t);
	mkdirSync(path, { recursive: true });
	assert.ok(loadWorkAnimationState(path, true).warning);
	assert.throws(() => saveWorkAnimationState(path, false));
	assert.deepEqual(readdirSync(dirname(path)), ["session-ui.json"]);

	const blocked = join(root, "blocked");
	writeFileSync(blocked, "not a directory");
	assert.throws(() => saveWorkAnimationState(join(blocked, "session-ui.json"), false));
	assert.equal(readFileSync(blocked, "utf8"), "not a directory");
});
