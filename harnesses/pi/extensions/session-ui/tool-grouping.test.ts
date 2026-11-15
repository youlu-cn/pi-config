import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import { installToolGrouping, ToolGroupComponent } from "./tool-grouping.ts";
import {
	buildGroupLines,
	classifyGroupCategory,
	formatMergedRanges,
	mergeLineRanges,
} from "./tool-grouping-core.ts";

initTheme("dark");

const mockTheme = {
	fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	bold: (text: string) => `<b>${text}</b>`,
};

const mockUi = {
	requestRender() {},
};

function makeAssistantMessage(parts: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: any }>) {
	return new AssistantMessageComponent(
		{
			role: "assistant",
			content: parts as any,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
		true,
	);
}

function makeTool(name: string, id: string, args: any, result?: any) {
	const comp = new ToolExecutionComponent(name, id, args, {}, undefined, mockUi as any, "/repo");
	if (result) {
		comp.updateResult(result, false);
	}
	return comp;
}

test("classifyGroupCategory groups explore, change, bash and leaves ask_user_question standalone", () => {
	assert.equal(classifyGroupCategory("read"), "explore");
	assert.equal(classifyGroupCategory("grep"), "explore");
	assert.equal(classifyGroupCategory("find"), "explore");
	assert.equal(classifyGroupCategory("ls"), "explore");
	assert.equal(classifyGroupCategory("edit"), "change");
	assert.equal(classifyGroupCategory("write"), "change");
	assert.equal(classifyGroupCategory("bash"), "bash");
	assert.equal(classifyGroupCategory("ask_user_question"), null);
});

test("mergeLineRanges merges adjacent and overlapping ranges and preserves gaps", () => {
	const merged = mergeLineRanges([
		{ start: 81, end: 160 },
		{ start: 1, end: 80 },
		{ start: 220, end: 260 },
		{ start: 240, end: 280 },
	]);
	assert.deepEqual(merged, [
		{ start: 1, end: 160 },
		{ start: 220, end: 280 },
	]);
	assert.equal(formatMergedRanges(merged), "1-160, 220-280");
	assert.equal(mergeLineRanges([{ start: 1, end: 50 }, "full"]), "full");
});

test("buildGroupLines aggregates same-file reads and multi-file reads", () => {
	const lines = buildGroupLines(
		[
			{
				toolName: "read",
				args: { path: "/repo/src/a.ts", offset: 1, limit: 80 },
				cwd: "/repo",
				result: { content: [{ type: "text", text: "x\n".repeat(80) }] },
			},
			{
				toolName: "read",
				args: { path: "/repo/src/a.ts", offset: 81, limit: 80 },
				cwd: "/repo",
				result: { content: [{ type: "text", text: "x\n".repeat(80) }] },
			},
			{
				toolName: "read",
				args: { path: "/repo/src/b.ts", offset: 10, limit: 20 },
				cwd: "/repo",
				result: { content: [{ type: "text", text: "x\n".repeat(20) }] },
			},
		],
		mockTheme,
		false,
	);
	const joined = lines.join("\n");
	assert.match(joined, /<b>Read 2 files<\/b>/);
	assert.match(joined, /3 reads/);
	assert.match(joined, /180 lines/);
	assert.match(joined, /src\/a\.ts:1-160/);
	assert.match(joined, /src\/b\.ts:10-29/);
});

test("buildGroupLines aggregates same-file edits and writes", () => {
	const lines = buildGroupLines(
		[
			{
				toolName: "edit",
				args: { path: "/repo/src/a.ts" },
				cwd: "/repo",
				result: { details: { diff: "-1 a\n+1 b\n+2 c" } },
			},
			{
				toolName: "edit",
				args: { path: "/repo/src/a.ts" },
				cwd: "/repo",
				result: { details: { diff: "-10 x\n-11 y\n+10 z" } },
			},
			{
				toolName: "write",
				args: { path: "/repo/src/new.ts", content: "a\nb\nc\n" },
				cwd: "/repo",
				result: { content: [{ type: "text", text: "ok" }] },
			},
		],
		mockTheme,
		false,
	);
	const joined = lines.join("\n");
	assert.match(joined, /<b>Edit & Write 2 files<\/b>/);
	assert.match(joined, /src\/a\.ts.*\[success\]\+3\[\/success\].*\[error\]-3\[\/error\].*2 batches/);
	assert.match(joined, /Write.*src\/new\.ts.*\[success\]\+3\[\/success\]/);
});

test("installToolGrouping merges consecutive same-category tools across thinking-only turns and splits on category or prose", () => {
	const hooks = installToolGrouping(() => true);
	hooks.setTheme(mockTheme);
	try {
		const chat = new Container();

		// Turn 1: thinking-only + read a.ts:1-50
		chat.addChild(makeAssistantMessage([{ type: "thinking", thinking: "read a first" }]));
		chat.addChild(makeTool("read", "t1", { path: "/repo/a.ts", offset: 1, limit: 50 }, { content: [{ type: "text", text: "a\n".repeat(50) }] }));

		// Turn 2: thinking-only + read a.ts:51-100 -> merges with t1 and moves group to bottom
		chat.addChild(makeAssistantMessage([{ type: "thinking", thinking: "read rest of a" }]));
		chat.addChild(makeTool("read", "t2", { path: "/repo/a.ts", offset: 51, limit: 50 }, { content: [{ type: "text", text: "a\n".repeat(50) }] }));

		// Turn 3: thinking-only + write b.ts -> different category ("change"), starts a new block
		chat.addChild(makeAssistantMessage([{ type: "thinking", thinking: "now write b" }]));
		chat.addChild(makeTool("write", "t3", { path: "/repo/b.ts", content: "hello\n" }, { content: [{ type: "text", text: "ok" }] }));

		// Turn 4: spacer + edit b.ts -> same category ("change"), merges with t3
		chat.addChild(new Spacer(1));
		chat.addChild(makeTool("edit", "t4", { path: "/repo/b.ts" }, { content: [], details: { diff: "-1 old\n+1 new" } }));

		// Turn 5: assistant prose text + read c.ts -> visible prose blocks merging
		chat.addChild(makeAssistantMessage([{ type: "text", text: "Let me check c.ts as well." }]));
		chat.addChild(makeTool("read", "t5", { path: "/repo/c.ts" }, { content: [{ type: "text", text: "c" }] }));

		const groups = chat.children.filter((c) => c instanceof ToolGroupComponent) as ToolGroupComponent[];
		assert.equal(groups.length, 2);
		assert.equal(groups[0]!.category, "explore");
		assert.equal(groups[0]!.toolCount, 2);
		assert.equal(groups[1]!.category, "change");
		assert.equal(groups[1]!.toolCount, 2);

		// Verify t5 remained a standalone ToolExecutionComponent
		assert.ok(chat.children[chat.children.length - 1] instanceof ToolExecutionComponent);
	} finally {
		hooks.shutdown();
	}
});

test("buildGroupLines scales truncation budget proportionally with terminal width", () => {
	const longCmd =
		'export PATH="$HOME/fvm/default/bin:$HOME/flutter/bin:/opt/homebrew/bin:$PATH" && cd mediaforge-pro && flutter gen-l10n && flutter analyze --no-pub';
	const narrow = buildGroupLines(
		[{ toolName: "bash", args: { command: longCmd }, result: { durationMs: 1200 } }],
		mockTheme,
		false,
		80,
	).join("\n");
	const wide = buildGroupLines(
		[{ toolName: "bash", args: { command: longCmd }, result: { durationMs: 1200 } }],
		mockTheme,
		false,
		200,
	).join("\n");

	assert.ok(narrow.includes("…"), "narrow terminal truncates long bash command");
	assert.ok(!wide.includes("…"), "wide terminal preserves full bash command");
	assert.ok(wide.includes("flutter analyze --no-pub"));
});
