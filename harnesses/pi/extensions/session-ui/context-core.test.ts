import assert from "node:assert/strict";
import test from "node:test";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { rgbColor } from "@earendil-works/pi-tui";
import {
	capParts,
	collectContextBreakdown,
	formatContextTokens,
	resolveUsedTokens,
} from "./context-core.ts";

test("formatContextTokens matches cc dialog thresholds (k only, no M)", () => {
	assert.equal(formatContextTokens(999), "999");
	assert.equal(formatContextTokens(1_000), "1.0k");
	assert.equal(formatContextTokens(35_500), "35.5k");
	assert.equal(formatContextTokens(99_999), "100.0k");
	assert.equal(formatContextTokens(100_000), "100k");
	assert.equal(formatContextTokens(1_000_000), "1000k");
});

test("resolveUsedTokens rejects inconsistent or implausibly small provider usage", () => {
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 7 }, 20_000, 272_000), 19_040);
	assert.equal(resolveUsedTokens({ tokens: 19_000, percent: 7 }, 20_000, 272_000), 19_000);
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 1 / 2_720 }, 20_000, 272_000), 20_000);
	assert.equal(resolveUsedTokens({ tokens: null, percent: null }, 20_000, 272_000), 20_000);
});

test("capParts never produces negative tokens when estimates exceed usage", () => {
	const parts = Array.from({ length: 8 }, (_, index) => ({
		label: String(index),
		tokens: 1,
		color: rgbColor(0x76, 0x84, 0x94),
	}));
	const fitted = capParts(parts, 5);
	assert.equal(
		fitted.reduce((sum, part) => sum + part.tokens, 0),
		5,
	);
	assert.ok(fitted.every((part) => part.tokens >= 0));
});

test("capParts zeroes the variable parts when usage equals the fixed sections", () => {
	const parts = Array.from({ length: 8 }, (_, index) => ({
		label: String(index),
		tokens: 3,
		color: rgbColor(0x76, 0x84, 0x94),
	}));
	const capped = capParts(parts, 4, 4);
	assert.deepEqual(
		capped.map((part) => part.tokens),
		[3, 3, 3, 3, 0, 0, 0, 0],
	);
});

test("context breakdown separates tools, results, and conversation without inflating estimates", () => {
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			contextFiles: [{ path: "AGENTS.md", content: "cccc" }],
			skills: [
				{ name: "ok", description: "desc", filePath: "/v" },
				{
					name: "hidden",
					description: "x".repeat(100),
					filePath: "/hidden",
					disableModelInvocation: true,
				},
			],
		}),
		getSystemPrompt: () => "s".repeat(200),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{
								role: "system",
								content: "",
								sections: { preamble: "s".repeat(200) },
							},
							{ role: "user", content: "uuuuuuuu", timestamp: 0 },
							{
								role: "assistant",
								content: [
									{ type: "text", text: "aaaa" },
									{ type: "toolCall", id: "1", name: "read", arguments: { path: "a" } },
								],
							},
							{
								role: "toolResult",
								toolCallId: "1",
								toolName: "read",
								content: "rrrrrrrr",
								timestamp: 0,
							},
						],
					},
					{
						sourceEntry: { type: "compaction" },
						messages: [{ role: "compactionSummary", summary: "ssss", timestamp: 0 }],
					},
				],
			}),
		},
	} as any;
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object" },
			promptGuidelines: [],
			sourceInfo: {},
		},
	] as any;

	const breakdown = collectContextBreakdown(ctx, tools);
	const parts = breakdown.parts;
	assert.deepEqual(
		parts.map(({ label, color }) => [label, color]),
		[
			["System prompt", rgbColor(0x79, 0xc0, 0xff)],
			["Memory", rgbColor(0xff, 0x7b, 0x72)],
			["Skills", rgbColor(0xcb, 0x92, 0x14)],
			["Tools definition", rgbColor(0x37, 0xb3, 0x4a)],
			["Tool results", rgbColor(0xf7, 0x78, 0xba)],
			["Context", rgbColor(0xf0, 0x88, 0x3e)],
		],
	);
	assert.equal(parts.find((part) => part.label === "System prompt")?.tokens, 50);
	assert.equal(parts.find((part) => part.label === "Memory")?.tokens, 0);
	assert.equal(parts.find((part) => part.label === "Skills")?.tokens, 0);
	assert.match(breakdown.previews.memoryFiles, /## AGENTS\.md/);
	assert.match(breakdown.previews.memoryFiles, /cccc/);
	assert.match(breakdown.previews.skills, /<name>ok<\/name>/);
	assert.doesNotMatch(breakdown.previews.skills, /hidden/);
	assert.equal(parts.find((part) => part.label === "Tool results")?.tokens, 2);
	assert.equal(parts.find((part) => part.label === "Context")?.tokens, 8);
	assert.match(breakdown.previews.systemPrompt, /"preamble": "s{200}"/);
	assert.match(breakdown.previews.tools, /Definition: read/);
	assert.match(breakdown.previews.tools, /"parameters"/);
	assert.doesNotMatch(breakdown.previews.tools, /Call: read/);
	assert.match(breakdown.previews.toolResults, /Result: read/);
	assert.match(breakdown.previews.toolResults, /rrrrrrrr/);
	assert.match(breakdown.previews.contextFiles, /uuuuuuuu/);
	assert.match(breakdown.previews.contextFiles, /aaaa/);
	assert.match(breakdown.previews.contextFiles, /Assistant tool call: read/);
	assert.match(breakdown.previews.contextFiles, /"path": "a"/);
	assert.match(breakdown.previews.contextFiles, /compactionSummary/);

	const fitted = capParts(parts, parts.reduce((sum, part) => sum + part.tokens, 0) + 10);
	assert.deepEqual(fitted, parts, "estimates are not inflated to fill provider usage");
	const fixedTokens = parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
	const capped = capParts(parts, fixedTokens + 5, 4);
	assert.deepEqual(
		capped.slice(0, 4),
		parts.slice(0, 4),
		"system prompt, memory, skills and tools definition stay stable",
	);
	assert.equal(
		capped.reduce((sum, part) => sum + part.tokens, 0),
		fixedTokens + 5,
	);
	const finalParts = [
		...fitted,
		{ label: "Other", tokens: 10, color: rgbColor(0x92, 0x9e, 0xab) },
		{ label: "Free space", tokens: 100, color: rgbColor(0x76, 0x84, 0x94) },
	];
	assert.equal(new Set(finalParts.map((part) => part.color)).size, 8);
});

test("context breakdown attributes embedded memory and skills once", () => {
	const memory = "cccc";
	const skills = [{ name: "ok", description: "desc", filePath: "/v" }];
	const skillsText = formatSkillsForPrompt(skills as any).trim();
	const chunk = `<project_instructions path="AGENTS.md">\n${memory}\n</project_instructions>`;
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: [],
			contextFiles: [{ path: "AGENTS.md", content: memory }],
			skills,
		}),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{
								role: "system",
								content: "",
								sections: {
									preamble: "base",
									project_context: `<project_context>\n${chunk}\n</project_context>`,
									skills: `<skills>\n${skillsText}\n</skills>`,
								},
							},
						],
					},
				],
			}),
		},
	} as any;

	const breakdown = collectContextBreakdown(ctx, []);
	const systemTokens = breakdown.parts.find((part) => part.label === "System prompt")?.tokens ?? -1;
	const memoryTokens = breakdown.parts.find((part) => part.label === "Memory")?.tokens ?? -1;
	const skillsTokens = breakdown.parts.find((part) => part.label === "Skills")?.tokens ?? -1;
	assert.equal(memoryTokens, Math.ceil(chunk.length / 4));
	assert.equal(skillsTokens, Math.ceil(skillsText.length / 4));
	const sectionsText = [
		"base",
		`<project_context>\n${chunk}\n</project_context>`,
		`<skills>\n${skillsText}\n</skills>`,
	].join("");
	assert.equal(systemTokens + memoryTokens + skillsTokens, Math.ceil(sectionsText.length / 4));
	assert.ok(systemTokens < Math.ceil(sectionsText.length / 4));
});

test("context breakdown counts tool schemas once", () => {
	const definition = {
		name: "read",
		description: "Read a file",
		parameters: { type: "object" },
	};
	const removed = {
		name: "bash",
		description: "x".repeat(400),
		parameters: { type: "object" },
	};
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read"],
		}),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{
								role: "system",
								content: "base",
								toolsAdded: [definition],
								toolsRemoved: [removed],
							},
						],
					},
				],
			}),
		},
	} as any;
	const tools = [{ ...definition, promptGuidelines: [], sourceInfo: {} }] as any;

	const breakdown = collectContextBreakdown(ctx, tools);
	const systemTokens = breakdown.parts.find((part) => part.label === "System prompt")?.tokens;
	const toolTokens = breakdown.parts.find((part) => part.label === "Tools definition")?.tokens;
	assert.equal(systemTokens, Math.ceil("base".length / 4));
	assert.equal(toolTokens, Math.ceil(JSON.stringify(definition).length / 4));
	assert.equal(
		(systemTokens ?? 0) + (toolTokens ?? 0),
		Math.ceil("base".length / 4) + Math.ceil(JSON.stringify(definition).length / 4),
	);
});

test("context breakdown keeps thinking, bash output and summaries in the preview", () => {
	const ctx = {
		getSystemPromptOptions: () => ({ cwd: "/repo", selectedTools: [] }),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{ role: "user", content: "uuuu", timestamp: 0 },
							{
								role: "assistant",
								content: [{ type: "thinking", thinking: "pondering" }],
							},
							{
								role: "bashExecution",
								command: "ls -la",
								output: "total 0",
								timestamp: 0,
							},
							{ role: "branchSummary", summary: "older branch", timestamp: 0 },
						],
					},
				],
			}),
		},
	} as any;

	const breakdown = collectContextBreakdown(ctx, []);
	const preview = breakdown.previews.contextFiles;
	assert.match(preview, /## Assistant thinking\n\npondering/);
	assert.match(preview, /## Bash\n\nCommand:\n\nls -la/);
	assert.match(preview, /## branchSummary\n\nolder branch/);
});
