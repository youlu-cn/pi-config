import test from "node:test";
import assert from "node:assert/strict";
import {
	askUserAnswerText,
	askUserQuestionCount,
	codemodeOutputLineCount,
	codemodeSummaryParts,
	formatAskUserQuestionResult,
	formatCodemodeResult,
	formatSubagentNotification,
	isFailedSubagentStatus,
	measuredStats,
} from "./special-cards-core.ts";

const theme = {
	fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
};

test("askUserAnswerText handles single and multi answers", () => {
	assert.equal(askUserAnswerText({ kind: "single", answer: "yes" }), "yes");
	assert.equal(
		askUserAnswerText({ kind: "multi", selected: ["a", "b"] }),
		"a, b",
	);
	assert.equal(askUserAnswerText({ kind: "multi", selected: [] }), "(no answer)");
});

test("formatAskUserQuestionResult renders collapsed Q&A tree", () => {
	const out = formatAskUserQuestionResult(
		{
			details: {
				answers: [
					{ questionIndex: 0, question: "Ship it?", kind: "single", answer: "yes" },
					{
						questionIndex: 1,
						question: "Targets",
						kind: "multi",
						selected: ["web", "cli"],
					},
				],
			},
		},
		theme,
		false,
		"",
		"click / ctrl+o to expand",
	);
	assert.ok(out.includes("Ship it?"));
	assert.ok(out.includes("yes"));
	assert.ok(out.includes("2 answered"));
	assert.equal(askUserQuestionCount({ details: { answers: [{}, {}] } }), 2);
});

test("formatCodemodeResult summarizes nested calls", () => {
	const result = {
		content: [
			{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text", text: "ok\n" },
		],
		details: {
			calls: [
				{ name: "read", args: "a.ts", status: "ok", durationMs: 12 },
				{ name: "bash", args: "ls", status: "error", durationMs: 40, error: "boom" },
			],
		},
	};
	assert.equal(codemodeOutputLineCount(result), 1);
	assert.deepEqual(codemodeSummaryParts(result.details.calls, 1, false), [
		"2 calls",
		"1 failed",
		"1 line output",
	]);
	const collapsed = formatCodemodeResult(
		result,
		theme,
		false,
		"",
		"click / ctrl+o to expand",
		false,
		false,
	);
	assert.ok(collapsed.includes("read"));
	assert.ok(collapsed.includes("bash"));
	assert.ok(collapsed.includes("failed"));
});

test("formatSubagentNotification renders finished agent card", () => {
	assert.equal(isFailedSubagentStatus("error"), true);
	assert.deepEqual(
		measuredStats({ turnCount: 2, toolUses: 3, totalTokens: 1500, durationMs: 2500 }),
		["2 turns", "3 tool uses", "1.5k tokens", "2.5s"],
	);
	const out = formatSubagentNotification(
		{
			id: "abc",
			description: "Scout repo",
			status: "completed",
			turnCount: 1,
			toolUses: 2,
			totalTokens: 800,
			durationMs: 1200,
			resultPreview: "found 3 modules",
		},
		theme,
		false,
		"",
		"click / ctrl+o to expand",
	);
	assert.ok(out.includes("Scout repo") || out.includes("Subagent"));
	assert.ok(out.includes("1 turn") || out.includes("2 tool"));
});
