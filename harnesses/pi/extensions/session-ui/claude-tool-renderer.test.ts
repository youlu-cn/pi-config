import assert from "node:assert/strict";
import test from "node:test";
import {
	createBashToolDefinition,
	initTheme,
	type ExtensionAPI,
	type Theme,
	type ToolRenderContext,
	type ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { registerClaudeToolRenderer } from "./claude-tool-renderer.ts";

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text } as Theme;

test("expanded bash results reuse their inner component without adding the wrapper to itself", (t) => {
	let resolve: ToolRendererResolver | undefined;
	const pi = {
		registerToolRenderer(resolver: ToolRendererResolver) { resolve = resolver; },
		registerCommand() {},
		on(event: string, callback: () => void) {
			if (event === "session_shutdown") t.after(() => callback());
		},
	} as unknown as ExtensionAPI;
	registerClaudeToolRenderer(pi, { getGrouping: () => false });
	assert.ok(resolve);
	const renderResult = resolve("bash", () => createBashToolDefinition(process.cwd()))?.renderResult;
	assert.ok(renderResult);
	const options = { expanded: true, isPartial: false };
	const context: ToolRenderContext = {
		...options,
		args: { command: "printf 'ok'" },
		toolCallId: "bash-test",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		showImages: false,
		isError: false,
		durationMs: 10,
		outputPad: 0,
		keyText: () => "",
		keyHint: () => "",
	};
	const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

	const first = renderResult(result("first output"), options, theme, context);
	assert.ok(first instanceof Container);
	assert.equal(first.children.length, 2);
	const inner = first.children[1];
	const second = renderResult(result("second output"), options, theme, { ...context, lastComponent: first });
	assert.equal(second, first);
	assert.ok(!first.children.includes(first), "wrapper must not contain itself");
	assert.equal(first.children[1], inner, "reuse only the previous inner component for the default renderer");
	assert.doesNotThrow(() => first.invalidate());
	const output = stripTerminalSequences(first.render(80).join("\n"));
	assert.match(output, /click \/ ctrl\+o to collapse/);
	assert.match(output, /second output/);
	assert.doesNotMatch(output, /first output/);
});
