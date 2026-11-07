import test from "node:test";
import assert from "node:assert/strict";
import {
	formatToolHeader,
	formatResultSummary,
	formatErrorLines,
	formatGeminiDots,
	formatEditDiffPreview,
	formatWritePreview,
} from "./claude-tool-renderer-core.ts";

const mockTheme = {
	fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `<b>${text}</b>`,
} as any;

test("formatToolHeader formats tool name and arguments with Claude style and subtle bullet", () => {
	const cwd = "/Users/boris/code/demo";

	// 1. Read tool succeeded (uses solid bullet ●)
	const readHeader = formatToolHeader(
		"read",
		{ path: "/Users/boris/code/demo/server/test/models/User.test.js" },
		cwd,
		mockTheme,
		true,
		false,
	);
	assert.ok(readHeader.includes("[success]● ["));
	assert.ok(readHeader.includes("<b>Read</b>"));
	assert.ok(readHeader.includes("(server/test/models/User.test.js)"));

	// 2. Bash tool failed
	const bashErrorHeader = formatToolHeader(
		"bash",
		{ command: "npm list nyc c8 istanbul" },
		cwd,
		mockTheme,
		true,
		true,
	);
	assert.ok(bashErrorHeader.includes("[error]● ["));
	assert.ok(bashErrorHeader.includes("<b>Bash</b>"));
	assert.ok(bashErrorHeader.includes("(npm list nyc c8 istanbul)"));

	// 3. In-progress Claude starburst animation frame (default style = "claude")
	const runningClaudeHeader = formatToolHeader(
		"bash",
		{ command: "npm test" },
		cwd,
		mockTheme,
		false,
		false,
		1,
		"claude",
	);
	assert.ok(runningClaudeHeader.includes("[accent]✵[/accent]"));
	assert.ok(runningClaudeHeader.includes("<b>Bash</b>"));
	assert.ok(runningClaudeHeader.includes("(esc to interrupt)"));

	// 4. In-progress Gemini sparkle animation frame (style = "gemini")
	const runningGeminiHeader = formatToolHeader(
		"scout",
		{ reason: "init" },
		cwd,
		mockTheme,
		false,
		false,
		1,
		"gemini",
	);
	assert.ok(runningGeminiHeader.includes("[accent]✦[/accent]"));
});

test("formatGeminiDots creates bouncing pulse dots with subtle bullets", () => {
	const f0 = formatGeminiDots(0, mockTheme, 3);
	const f1 = formatGeminiDots(1, mockTheme, 3);
	const f2 = formatGeminiDots(2, mockTheme, 3);
	const f3 = formatGeminiDots(3, mockTheme, 3);

	// Verify 3 dots bouncing back and forth: 0->1->2->1
	assert.equal(f0, "[accent]•[/accent] [dim]·[/dim] [dim]·[/dim]");
	assert.equal(f1, "[dim]·[/dim] [accent]•[/accent] [dim]·[/dim]");
	assert.equal(f2, "[dim]·[/dim] [dim]·[/dim] [accent]•[/accent]");
	assert.equal(f3, "[dim]·[/dim] [accent]•[/accent] [dim]·[/dim]");
});

test("formatResultSummary produces clean folded summaries for various tools", () => {
	// 1. Read: 21 lines
	const readSummary = formatResultSummary(
		"read",
		{ path: "foo.js" },
		{ content: [{ type: "text", text: "line\n".repeat(21).trim() }] } as any,
		150,
	);
	assert.equal(readSummary, "Read 21 lines");

	// 2. Bash: execution duration
	const bashSummary = formatResultSummary(
		"bash",
		{ command: "ls" },
		{ content: [{ type: "text", text: "file1\nfile2" }] } as any,
		400,
	);
	assert.equal(bashSummary, "Done in 0.4s");

	// 3. Edit: replacements count
	const editSummary = formatResultSummary(
		"edit",
		{ edits: [{}, {}, {}] },
		{ content: [] } as any,
		120,
	);
	assert.equal(editSummary, "3 replacements applied");

	// 4. Grep: matches count
	const grepSummary = formatResultSummary(
		"grep",
		{ pattern: "test" },
		{ content: [{ type: "text", text: "match1\nmatch2\nmatch3" }] } as any,
		200,
	);
	assert.equal(grepSummary, "Found 3 matches");
});

test("formatEditDiffPreview renders Claude Code style diff stats and colored lines", () => {
	const preview = formatEditDiffPreview(
		{
			path: "src/app.ts",
			edits: [{ oldText: "const a = 1;", newText: "const a = 2;\nconst b = 3;" }],
		},
		{
			details: {
				diff: " 10 import foo\n-11 const a = 1;\n+11 const a = 2;\n+12 const b = 3;",
			},
		},
		mockTheme,
		false,
	);

	assert.ok(preview.includes("Added 2 lines, removed 1 line"));
	assert.ok(preview.includes("[toolDiffRemoved]-11 const a = 1;[/toolDiffRemoved]"));
	assert.ok(preview.includes("[toolDiffAdded]+11 const a = 2;[/toolDiffAdded]"));
	assert.ok(preview.includes("[toolDiffAdded]+12 const b = 3;[/toolDiffAdded]"));
});

test("formatWritePreview counts args.content lines accurately and renders code preview", () => {
	const preview = formatWritePreview(
		{
			path: "src/hello.ts",
			content: "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n",
		},
		{ content: [{ type: "text", text: "Successfully wrote to src/hello.ts" }] },
		mockTheme,
		false,
	);

	assert.ok(preview.includes("Wrote 3 lines"));
	assert.ok(preview.includes("1 │ [/dim][toolOutput]export const x = 1;"));
	assert.ok(preview.includes("3 │ [/dim][toolOutput]export const z = 3;"));
});

test("formatErrorLines builds tree-structured red error message", () => {
	const errorText = "planka-server@ /Users/boris/code/demo/server\n(empty)";
	const formatted = formatErrorLines(errorText, mockTheme, false);

	assert.ok(formatted.includes("[error]"));
	assert.ok(formatted.includes("└ Error: planka-server@ /Users/boris/code/demo/server"));
	assert.ok(formatted.includes("└── (empty)"));
});
