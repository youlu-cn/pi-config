import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { installCompactThinking } from "./compact-thinking.ts";
import {
	animateDots,
	parseForegroundRgbFromAnsi,
	renderShimmerText,
	shimmerWaveWeights,
} from "./compact-thinking-anim.ts";
import { installToolGrouping } from "./tool-grouping.ts";

initTheme("dark");

function makeAssistantThinkingMsg(
	thinking: string,
	timestamp: number,
	text?: string,
) {
	const content: any[] = [{ type: "thinking", thinking }];
	if (text) content.push({ type: "text", text });
	return new AssistantMessageComponent(
		{
			role: "assistant",
			content,
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
			timestamp,
		},
		true,
	);
}

test("animateDots keeps a fixed 3-column width across frames", () => {
	const widths = [0, 1, 2, 3, 4, 5].map((frame) => animateDots(frame).length);
	assert.deepEqual(widths, [3, 3, 3, 3, 3, 3]);
	assert.equal(animateDots(0), ".  ");
	assert.equal(animateDots(1), ".. ");
	assert.equal(animateDots(2), "...");
	assert.equal(animateDots(3), ".  ");
});

test("parseForegroundRgbFromAnsi decodes truecolor, 256-color and 16-color SGR", () => {
	assert.deepEqual(parseForegroundRgbFromAnsi("\x1b[38;2;12;34;56m"), [12, 34, 56]);
	assert.deepEqual(parseForegroundRgbFromAnsi("\x1b[38;5;232m"), [8, 8, 8]);
	assert.deepEqual(parseForegroundRgbFromAnsi("\x1b[91m"), [255, 0, 0]);
	assert.equal(parseForegroundRgbFromAnsi(""), null);
});

test("shimmerWaveWeights sweeps smoothly across characters over time", () => {
	const early = shimmerWaveWeights(8, 180);
	const mid = shimmerWaveWeights(8, 550);
	const pause = shimmerWaveWeights(8, 1250);

	assert.equal(early.length, 8);
	assert.ok(early[0]! > early[7]!, "early frame highlights left side");
	assert.ok(mid[3]! > mid[0]! && mid[4]! > mid[7]!, "mid frame highlights center");
	assert.deepEqual(pause, [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("renderShimmerText emits smooth truecolor foreground transitions without altering visible text", () => {
	const trueColorTheme = {
		fg: (_color: string, text: string) => text,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		getFgAnsi: (color: string) => {
			if (color === "thinkingText") return "\x1b[38;2;100;100;110m";
			if (color === "accent") return "\x1b[38;2;240;140;80m";
			if (color === "text") return "\x1b[38;2;240;240;245m";
			return "";
		},
	};

	const out = renderShimmerText("Thinking", 450, trueColorTheme);
	assert.equal(stripTerminalSequences(out), "Thinking");
	assert.ok(out.startsWith("\x1b[3m") && out.endsWith("\x1b[23m"));
	const colorMatches = out.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
	assert.ok(new Set(colorMatches).size >= 3, "should emit multiple interpolated foreground steps");
});

test("renderShimmerText falls back cleanly when theme has no getFgAnsi", () => {
	const fallbackTheme = {
		fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	};
	const out = renderShimmerText("Thinking", 550, fallbackTheme);
	assert.ok(out.includes("[accent]"));
	assert.ok(out.includes("[thinkingText]"));
});

test("clicking a compact thinking block toggles expanded/collapsed state", () => {
	const fakePi = { on() {} } as any;
	const hooks = installCompactThinking(fakePi, {
		enabled: true,
		previewLines: 3,
		completedPreviewLines: 1,
		animationIntervalMs: 60,
	});
	try {
		const msg = makeAssistantThinkingMsg("line1\nline2\nline3\nline4", 1001);
		const collapsed = msg.render(80).map(stripTerminalSequences).join("\n");
		assert.match(collapsed, /click to expand/);
		assert.doesNotMatch(collapsed, /line1/);

		// Line 0 is Spacer(1), line 1 is header of ThinkingPreviewBlock
		const res = msg.handleMouse({ type: "click", button: "left", x: 2, y: 1 } as any);
		assert.equal(res?.handled, true);
		assert.equal(res?.render, true);

		const expanded = msg.render(80).map(stripTerminalSequences).join("\n");
		assert.match(expanded, /click to collapse/);
		assert.match(expanded, /line1/);
		assert.match(expanded, /line4/);

		msg.handleMouse({ type: "click", button: "left", x: 2, y: 1 } as any);
		const collapsedAgain = msg.render(80).map(stripTerminalSequences).join("\n");
		assert.match(collapsedAgain, /click to expand/);
		assert.doesNotMatch(collapsedAgain, /line1/);
	} finally {
		hooks.shutdown();
	}
});

test("consecutive thinking-only assistant messages merge into one Thought block", () => {
	const fakePi = { on() {} } as any;
	const groupHooks = installToolGrouping(() => true);
	const thinkingHooks = installCompactThinking(fakePi, {
		enabled: true,
		previewLines: 3,
		completedPreviewLines: 1,
		animationIntervalMs: 60,
	});
	try {
		const chat = new Container();
		const m1 = makeAssistantThinkingMsg("Checking project diff", 2001);
		const m2 = makeAssistantThinkingMsg("Checking fresh app metadata", 2002);
		const m3 = makeAssistantThinkingMsg("Preparing fresh test build", 2003);
		const m4 = makeAssistantThinkingMsg("Final check", 2004, "All checks done.");

		chat.addChild(m1);
		chat.addChild(m2);
		chat.addChild(m3);
		chat.addChild(m4);

		const rendered = chat.render(80).map(stripTerminalSequences).join("\n");
		const thoughtMatches = rendered.match(/Thought · click to expand/g) ?? [];
		// m1+m2+m3 merged into 1 block; m4 has visible prose so it renders its own Thought block
		assert.equal(thoughtMatches.length, 2);

		// Expand the merged block (m1) and confirm all 3 steps are included
		m1.handleMouse({ type: "click", button: "left", x: 2, y: 1 } as any);
		const expanded = m1.render(80).map(stripTerminalSequences).join("\n");
		assert.match(expanded, /Checking project diff/);
		assert.match(expanded, /Checking fresh app metadata/);
		assert.match(expanded, /Preparing fresh test build/);
	} finally {
		thinkingHooks.shutdown();
		groupHooks.shutdown();
	}
});
