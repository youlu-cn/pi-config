import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = process.env.PI_PACKAGE_ROOT;
let registerWorkAnimation, sessionUi;
if (root) {
	const require = createRequire(resolve(root, "package.json"));
	const { createJiti } = require("jiti");
	const corePath = resolve(root, "dist/index.js");
	const aiPackage = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(corePath));
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		fsCache: false,
		alias: {
			"@earendil-works/pi-coding-agent": corePath,
			"@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
			"@earendil-works/pi-ai": resolve(dirname(aiPackage), "dist/index.js"),
		},
	});
	({ registerWorkAnimation } = await jiti.import(fileURLToPath(new URL("./work-animation.ts", import.meta.url))));
	({ default: sessionUi } = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url))));
}
const options = { skip: !root };

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "session-ui-animation-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return { dir, statePath: join(dir, "state/session-ui.json") };
}

function harness(t, statePath, enabled = true, register) {
	const handlers = new Map(), commands = new Map();
	const notifications = [], visibility = [];
	let working = false, widget;
	const pi = {
		on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerCommand(name, command) { commands.set(name, command); },
		getSessionName() {},
	};
	const ctx = {
		hasUI: true, mode: "tui", cwd: dirname(statePath), isIdle: () => true,
		ui: {
			setWidget(_id, factory) { widget = factory?.({ requestRender() {} }, { fg: (_color, value) => value }); },
			setWorkingVisible(value) { visibility.push(value); },
			setWorkingMessage() {}, setWorkingIndicator() {}, setTitle() {},
			notify(message, level) { notifications.push({ message, level }); },
		},
	};
	if (register) register(pi);
	else registerWorkAnimation(pi, { enabled, placement: "aboveEditor", intervalMs: 180 }, statePath, {
		setAnimationFrame() {}, paint() {}, isWorking: () => working,
		setWorking(value) { working = value; },
	});
	const emit = (event) => { for (const handler of handlers.get(event) ?? []) handler({}, ctx); };
	t.after(() => emit("session_shutdown"));
	return {
		ctx, emit, notifications, visibility,
		command: (arg) => commands.get("work-animation").handler(arg, ctx),
		lines: () => widget?.render(80) ?? [],
	};
}

test("animation switches persist across fresh runtimes and session changes", options, async (t) => {
	const { statePath } = fixture(t);
	const h = harness(t, statePath);
	h.emit("session_start");
	assert.equal(h.visibility.at(-1), false);
	assert.equal(existsSync(statePath), false);
	await h.command("off");
	assert.equal(h.visibility.at(-1), true);
	assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { workAnimation: { enabled: false } });
	const next = harness(t, statePath);
	next.emit("session_start");
	assert.equal(next.visibility.at(-1), true);
	await next.command("on");
	h.emit("session_shutdown");
	h.emit("session_start");
	assert.equal(h.visibility.at(-1), false);
	await h.command("status");
	assert.match(h.notifications.at(-1).message, /^Work animation: on/);
});

test("switching animation while working updates rendering and stops timers", options, async (t) => {
	const { statePath } = fixture(t);
	const h = harness(t, statePath);
	h.emit("session_start");
	h.emit("agent_start");
	assert.equal(h.lines().length, 1);
	await h.command("off");
	assert.deepEqual(h.lines(), []);
	await h.command("on");
	assert.equal(h.lines().length, 1);
	h.emit("agent_settled");
	assert.deepEqual(h.lines(), []);
});

test("invalid state warns once and failed saves retain a temporary switch", options, async (t) => {
	const { statePath } = fixture(t);
	mkdirSync(dirname(statePath));
	writeFileSync(statePath, "{");
	const h = harness(t, statePath);
	h.emit("session_start");
	h.emit("session_start");
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].level, "warning");
	await h.command("off");
	assert.equal(h.visibility.at(-1), true);
	assert.match(h.notifications.at(-1).message, /off for this session only; could not save/);
	assert.equal(readFileSync(statePath, "utf8"), "{");
	await h.command("status");
	assert.match(h.notifications.at(-1).message, /^Work animation: off/);
});

test("session-ui uses the agent state directory without rewriting an override config", options, async (t) => {
	const { dir, statePath } = fixture(t);
	const configPath = join(dir, "custom/config.json");
	mkdirSync(dirname(configPath));
	const config = JSON.stringify({
		toolActivity: { enabled: false }, compactPaste: { enabled: false },
		statusline: { enabled: false }, effort: { enabled: false },
		turnDuration: { enabled: false }, uiMeta: { enabled: false },
		workAnimation: { enabled: true },
	});
	writeFileSync(configPath, config);
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousConfig = process.env.PI_SESSION_UI_CONFIG;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_SESSION_UI_CONFIG = configPath;
	let h;
	try {
		h = harness(t, statePath, true, sessionUi);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousConfig === undefined) delete process.env.PI_SESSION_UI_CONFIG;
		else process.env.PI_SESSION_UI_CONFIG = previousConfig;
	}
	h.emit("session_start");
	await h.command("off");
	assert.equal(readFileSync(configPath, "utf8"), config);
	assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { workAnimation: { enabled: false } });
	assert.equal(existsSync(join(dirname(configPath), "state")), false);
});

test("config fallback notification is emitted once when UI becomes available", options, (t) => {
	const { dir, statePath } = fixture(t);
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, JSON.stringify({
		toolActivity: { enabled: false }, compactPaste: { enabled: false },
		statusline: { enabled: false }, effort: { enabled: false },
		turnDuration: { enabled: false }, uiMeta: { enabled: false },
		workAnimation: false,
	}));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousConfig = process.env.PI_SESSION_UI_CONFIG;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_SESSION_UI_CONFIG = configPath;
	let h;
	try { h = harness(t, statePath, true, sessionUi); }
	finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousConfig === undefined) delete process.env.PI_SESSION_UI_CONFIG;
		else process.env.PI_SESSION_UI_CONFIG = previousConfig;
	}
	h.ctx.hasUI = false;
	h.ctx.mode = "json";
	h.emit("session_start");
	assert.deepEqual(h.notifications, []);
	h.ctx.hasUI = true;
	h.ctx.mode = "tui";
	h.emit("session_start");
	h.emit("session_start");
	assert.equal(h.notifications.length, 1);
	assert.match(h.notifications[0].message, /workAnimation must be an object.*using defaults/);
});
