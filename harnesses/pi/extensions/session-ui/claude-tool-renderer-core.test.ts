import test from "node:test";
import assert from "node:assert/strict";
import {
	formatToolHeader,
	formatResultSummary,
	formatErrorLines,
	formatGeminiDots,
} from "./claude-tool-renderer-core.ts";

const mockTheme = {
	fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `<b>${text}</b>`,
} as any;

test("formatToolHeader formats tool name and arguments with Claude style", () => {
	const cwd = "/Users/boris/code/demo";

	// 1. Read 工具成功
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

	// 2. Bash 工具失败
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

	// 3. 进行中 Gemini 动画帧
	const runningHeader = formatToolHeader(
		"bash",
		{ command: "npm test" },
		cwd,
		mockTheme,
		false,
		false,
		1,
	);
	assert.ok(runningHeader.includes("[accent]●[/accent]"));
	assert.ok(runningHeader.includes("[dim]·[/dim]"));
	assert.ok(runningHeader.includes("<b>Bash</b>"));
	assert.ok(runningHeader.includes("(esc to interrupt)"));
});

test("formatGeminiDots creates bouncing pulse dots", () => {
	const f0 = formatGeminiDots(0, mockTheme, 3);
	const f1 = formatGeminiDots(1, mockTheme, 3);
	const f2 = formatGeminiDots(2, mockTheme, 3);
	const f3 = formatGeminiDots(3, mockTheme, 3);

	// 验证 3 点来回往返: 0->1->2->1
	assert.equal(f0, "[accent]●[/accent] [dim]·[/dim] [dim]·[/dim]");
	assert.equal(f1, "[dim]·[/dim] [accent]●[/accent] [dim]·[/dim]");
	assert.equal(f2, "[dim]·[/dim] [dim]·[/dim] [accent]●[/accent]");
	assert.equal(f3, "[dim]·[/dim] [accent]●[/accent] [dim]·[/dim]");
});

test("formatResultSummary produces clean folded summaries for various tools", () => {
	// 1. Read: 21 行
	const readSummary = formatResultSummary(
		"read",
		{ path: "foo.js" },
		{ content: [{ type: "text", text: "line\n".repeat(21).trim() }] } as any,
		150,
	);
	assert.equal(readSummary, "Read 21 lines");

	// 2. Bash: 耗时
	const bashSummary = formatResultSummary(
		"bash",
		{ command: "ls" },
		{ content: [{ type: "text", text: "file1\nfile2" }] } as any,
		400,
	);
	assert.equal(bashSummary, "Done in 0.4s");

	// 3. Edit: 替换数量
	const editSummary = formatResultSummary(
		"edit",
		{ edits: [{}, {}, {}] },
		{ content: [] } as any,
		120,
	);
	assert.equal(editSummary, "3 replacements applied");

	// 4. Grep: 匹配数量
	const grepSummary = formatResultSummary(
		"grep",
		{ pattern: "test" },
		{ content: [{ type: "text", text: "match1\nmatch2\nmatch3" }] } as any,
		200,
	);
	assert.equal(grepSummary, "Found 3 matches");
});

test("formatErrorLines builds tree-structured red error message", () => {
	const errorText = "planka-server@ /Users/boris/code/demo/server\n(empty)";
	const formatted = formatErrorLines(errorText, mockTheme, false);

	assert.ok(formatted.includes("[error]"));
	assert.ok(formatted.includes("└ Error: planka-server@ /Users/boris/code/demo/server"));
	assert.ok(formatted.includes("└── (empty)"));
});
