import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

const root = process.env.PI_PACKAGE_ROOT;
let registerToolActivity, theme, visibleWidth;
if (root) {
	const load = (path) => import(pathToFileURL(resolve(root, path)).href);
	const themeModule = await load("dist/modes/interactive/theme/theme.js");
	themeModule.initTheme("dark", false);
	theme = themeModule.theme;
	const require = createRequire(resolve(root, "package.json"));
	const tuiPath = require.resolve("@earendil-works/pi-tui");
	({ visibleWidth } = await import(pathToFileURL(tuiPath).href));
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			return nextResolve(specifier === "@earendil-works/pi-tui" ? tuiPath : specifier, context);
		},
	});
	try {
		({ registerToolActivity } = await import("./tool-activity.ts"));
	} finally {
		hooks.deregister();
	}
}

function harness(maxItems = 6) {
	const handlers = new Map();
	let widget;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { setWidget: (_id, factory) => { widget = factory?.({ requestRender() {} }, theme); } },
	};
	registerToolActivity({ on: (event, handler) => handlers.set(event, handler) },
		{ enabled: true, placement: "aboveEditor", maxItems });
	const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
	emit("session_start");
	const text = (value) => ({ content: [{ type: "text", text: value }] });
	return {
		emit,
		start: (toolCallId, toolName, args, parentToolCallId) =>
			emit("tool_execution_start", { toolCallId, toolName, args, parentToolCallId }),
		end: (toolCallId, output, isError = false) =>
			emit("tool_execution_end", { toolCallId, result: text(output), isError }),
		lines: (width = 100) => widget.render(width),
		plain: (width = 100) => widget.render(width).map(stripVTControlCharacters),
	};
}

test("renders codemode nested calls under their call against installed Pi", { skip: !root }, () => {
	const h = harness(4);
	h.start("c", "codemode", { code: "await Promise.all([])" });
	h.start("c/1", "read", { path: "src/a.ts" }, "c");
	h.start("c/2", "bash", { command: "git status" }, "c");
	// A nested tool makes its own nested call after its sibling started.
	h.start("c/1/1", "grep", { pattern: "todo", path: "src" }, "c/1");
	h.end("c/1", "42 lines");
	h.end("c/2", "fatal: not a git repository", true);

	assert.deepEqual(h.plain(), [
		"Activity · 1 running",
		"◆ Codemode · 3 calls, 1 failed",
		"├ ◇ Inspect src/a.ts · 42 lines",
		"├ ✗ Run git status · fatal: not a git repository",
		"└ ◆ Search todo in src",
	]);

	h.end("c/1/1", "3 matches");
	h.start("d", "read", { path: "README.md" });
	assert.deepEqual(h.plain(), [
		"Activity · 2 running",
		"◆ Codemode · 3 calls, 1 failed",
		"├ … 2 earlier calls",
		"└ ◇ Search todo in src · 3 matches",
		"◆ Inspect README.md",
	]);
	for (const line of h.lines(24)) assert.ok(visibleWidth(line) <= 24, line);
});

test("clears nested calls at turn end so reused ids start fresh", { skip: !root }, () => {
	const h = harness();
	h.start("c", "codemode", { code: "1" });
	h.start("c/1", "read", { path: "a" }, "c");
	h.emit("turn_end");
	assert.deepEqual(h.plain(), []);

	h.end("c/1", "late result");
	assert.deepEqual(h.plain(), []);
	h.start("c", "codemode", { code: "2" });
	h.start("c/1", "read", { path: "b" }, "c");
	assert.deepEqual(h.plain(), ["Activity · 1 running", "◆ Codemode · 1 call", "└ ◆ Inspect b"]);
});
