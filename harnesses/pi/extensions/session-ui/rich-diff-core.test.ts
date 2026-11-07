import test from "node:test";
import assert from "node:assert/strict";
import {
	formatRichEditDiff,
	formatRichWritePreview,
	styleChangeCounts,
	DEFAULT_RICH_DIFF_OPTIONS,
} from "./rich-diff-core.ts";

const mockTheme = {
	fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `<b>${text}</b>`,
	inverse: (text: string) => `<i>${text}</i>`,
} as any;

test("styleChangeCounts colors +A -D", () => {
	const text = styleChangeCounts(mockTheme, 3, 2);
	assert.ok(text.includes("[success]+3[/success]"));
	assert.ok(text.includes("[error]-2[/error]"));
});

test("formatRichEditDiff includes bars and collapse hint", () => {
	const out = formatRichEditDiff(
		{ path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
		{ details: { diff: "-  1 foo\n+  1 bar" } },
		mockTheme,
		false,
		"",
		"click / ctrl+o to expand",
		{ ...DEFAULT_RICH_DIFF_OPTIONS, indicatorMode: "bars", editCollapsedLines: 12 },
	);
	assert.ok(out.includes("└"));
	assert.ok(out.includes("click / ctrl+o to expand"));
	assert.ok(out.includes("[success]▌[/success]") || out.includes("▌"));
});

test("formatRichEditDiff compact collapse with zero lines shows hide note", () => {
	const many = Array.from({ length: 5 }, (_, i) => `+  ${i + 1} line${i}`).join("\n");
	const out = formatRichEditDiff(
		{ path: "a.ts" },
		{ details: { diff: many } },
		mockTheme,
		false,
		"",
		"click / ctrl+o to expand",
		{ ...DEFAULT_RICH_DIFF_OPTIONS, editCollapsedLines: 0 },
	);
	assert.ok(out.includes("hidden") || out.includes("└"));
});

test("formatRichWritePreview shows added bars and line numbers", () => {
	const out = formatRichWritePreview(
		{ content: "one\ntwo\nthree" },
		{},
		mockTheme,
		false,
		"",
		"click / ctrl+o to expand",
		{ ...DEFAULT_RICH_DIFF_OPTIONS, writeCollapsedLines: 2 },
	);
	assert.ok(out.includes("Wrote"));
	assert.ok(out.includes("1 │") || out.includes("  1 │"));
	assert.ok(out.includes("+1 more") || out.includes("more lines"));
});

test("split mode pairs remove/add on wide width", () => {
	const out = formatRichEditDiff(
		{ path: "a.ts" },
		{ details: { diff: "-  1 old\n+  1 new" } },
		mockTheme,
		true,
		"",
		"click / ctrl+o to collapse",
		{
			...DEFAULT_RICH_DIFF_OPTIONS,
			viewMode: "split",
			width: 160,
			indicatorMode: "bars",
		},
	);
	assert.ok(out.includes("│"));
});
