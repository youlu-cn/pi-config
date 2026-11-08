import assert from "node:assert/strict";
import test from "node:test";
import {
	clearMermaidArtCache,
	deCircled,
	enhanceMarkdown,
	normalizeMultilineLinks,
	type MermaidApi,
} from "./markdown-enhance-core.ts";
import { loadGrokMermaid } from "./markdown-enhance.ts";

const mermaid = loadGrokMermaid();
const hasMermaid = Boolean(mermaid);

const ctx = {
	messageType: "assistant",
	isStreaming: false,
	availableWidth: 100,
};

function run(
	md: string,
	context = ctx,
	api: MermaidApi | null = mermaid,
): string {
	return enhanceMarkdown(md, context, api);
}

test.afterEach(() => {
	clearMermaidArtCache();
});

test("mermaid dialect rendering", { skip: !hasMermaid }, () => {
	assert.ok(run("```sequenceDiagram\nA->>B: hi\n```").includes("┌"));
	assert.ok(run("```stateDiagram-v2\n[*] --> S\n```").includes("╭"));
	assert.ok(run("```classDiagram\nclass A\n```").includes("┌"));
	assert.ok(run("```mermaid\ngraph LR\nA --> B\n```").includes("┌"));
});

test("four-backtick fences", { skip: !hasMermaid }, () => {
	assert.ok(run("````mermaid\ngraph LR\nA --> B\n````").includes("┌"));
});

test("unclosed fence keeps original", { skip: !hasMermaid }, () => {
	const out = run("```mermaid\ngraph LR\nA --> B");
	assert.ok(out.includes("```mermaid") && out.includes("A --> B"));
});

test("diagram lines use hard breaks", { skip: !hasMermaid }, () => {
	const out = run("```mermaid\ngraph LR\nA --> B\n```");
	const lines = out.split("\n").filter((l) => l.startsWith("`┌") || l.includes("┌────"));
	assert.ok(lines.length >= 1, JSON.stringify(out.slice(0, 80)));
});

test("narrow width frames source", { skip: !hasMermaid }, () => {
	const out = run("```erdiagram\nCUSTOMER ||--o{ ORDER : places\n```", {
		messageType: "assistant",
		isStreaming: false,
		availableWidth: 10,
	});
	assert.ok(out.includes("╭"));
});

test("streaming skips diagram and circled transforms", () => {
	const md = "```mermaid\ngraph LR\nA --> B\n```\n圈数字 ①";
	const out = run(md, {
		messageType: "assistant",
		isStreaming: true,
		availableWidth: 100,
	});
	assert.ok(out.includes("```mermaid"));
	assert.ok(out.includes("①"));
});

test("thinking blocks are unchanged", () => {
	const md = "```mermaid\ngraph LR\nA --> B\n```\n\n圈数字 ①\n\n看 https://example.com";
	assert.equal(
		run(md, {
			messageType: "assistant-thinking",
			isStreaming: false,
			availableWidth: 100,
		}),
		md,
	);
});

test("bare URLs and tip callouts are left alone", () => {
	assert.equal(
		run("访问 https://example.com/docs. 结束"),
		"访问 https://example.com/docs. 结束",
	);
	assert.equal(run("> [!NOTE] 提示\n> 续行"), "> [!NOTE] 提示\n> 续行");
});

test("ANSI-colored Mermaid output is not swallowed by a later link (#84)", () => {
	const ESC = "\x1b[38;5;240m";
	const RST = "\x1b[0m";
	const md = [
		"Intro.",
		"",
		`\`${ESC}┌────┐${RST}\`  `,
		`\`${ESC}│ A  │${RST}\`  `,
		"",
		"Some paragraph.",
		"",
		"Another paragraph, then a [link](https://example.com).",
	].join("\n");
	const out = run(md, ctx, null);
	assert.deepEqual(out.split("\n"), md.split("\n"), JSON.stringify(out));
});

test("streaming multiline links collapse blank OSC 8 hit targets", () => {
	const md = "前缀 [\n](https://example.com)\n```md\n[代码\n链接](https://code.example)\n```";
	const out = run(md, {
		messageType: "assistant",
		isStreaming: true,
		availableWidth: 100,
	});
	assert.ok(out.includes("前缀 [](https://example.com)"), JSON.stringify(out));
	assert.ok(out.includes("[代码\n链接](https://code.example)"), JSON.stringify(out));
});

test("circled numbers become half-width parentheses", () => {
	assert.equal(run("方案②引入，共⑩项", ctx, null), "方案(2)引入，共(10)项");
	assert.ok(run("① ② ⑳", ctx, null).includes("(1) (2) (20)"));
	assert.equal(deCircled("①"), "(1)");
});

test("code inside quotes and longer fences is not rewritten", () => {
	const quoted = run("> ```ts\n> const n = ①\n> ```\nplain ①", ctx, null);
	assert.match(quoted, /> const n = ①/);
	assert.match(quoted, /plain \(1\)/);

	const longer = run("````\n```\nstill code ①\n````\nafter ①", ctx, null);
	assert.match(longer, /still code ①/);
	assert.match(longer, /after \(1\)/);

	const tilde = run("~~~\ncode ①\n~~~\nafter ①", ctx, null);
	assert.match(tilde, /code ①/);
	assert.match(tilde, /after \(1\)/);

	const indented = run("   ```\n  code ①\n   ```\nafter ①", ctx, null);
	assert.match(indented, /code ①/);
	assert.match(indented, /after \(1\)/);
});

test("missing mermaid API still normalizes links and circled numbers", () => {
	const md = "① and [a\nb](https://ex.com)\n```mermaid\ngraph LR\nA --> B\n```";
	const out = enhanceMarkdown(md, ctx, null);
	assert.ok(out.includes("(1)"));
	assert.ok(out.includes("[a b](https://ex.com)"));
	assert.ok(out.includes("```mermaid"));
});

test("normalizeMultilineLinks skips fenced content", () => {
	const md = "前缀 [\n](https://example.com)\n```md\n[代码\n链接](https://code.example)\n```";
	const out = normalizeMultilineLinks(md);
	assert.ok(out.includes("前缀 [](https://example.com)"));
	assert.ok(out.includes("[代码\n链接](https://code.example)"));
});
