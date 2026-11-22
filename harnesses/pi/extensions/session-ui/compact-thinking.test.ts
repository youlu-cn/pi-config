import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { installCompactThinking } from "./compact-thinking.ts";
import { renderShimmerText } from "./compact-thinking-anim.ts";
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

const darkTheme = {
	appearance: "dark" as const,
	getColorMode: () => "truecolor" as const,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

test("the Thinking gradient streams rightward and loops without a pause", () => {
	const frame = (ms: number) => renderShimmerText("Thinking", ms, darkTheme);
	const colors = (ms: number) => frame(ms).match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
	assert.equal(stripTerminalSequences(frame(50)), "Thinking");
	assert.ok(frame(50).startsWith("\x1b[3m") && frame(50).endsWith("\x1b[39m\x1b[23m"));
	assert.notEqual(frame(0), frame(50));
	assert.ok(new Set(colors(50)).size >= 4);
	assert.deepEqual(colors(100).slice(1), colors(0).slice(0, -1));
	assert.notEqual(frame(1150), frame(1200));
	assert.equal(frame(1200), frame(0));
});

test("the Thinking gradient uses the light palette and honors 256-color mode", () => {
	const lightTheme = { ...darkTheme, appearance: "light" as const };
	const lightFrame = renderShimmerText("Thinking", 0, lightTheme);
	assert.match(lightFrame, /\x1b\[38;2;25;101;141mT/);
	assert.notEqual(lightFrame, renderShimmerText("Thinking", 0, darkTheme));
	const indexedFrame = renderShimmerText("Thinking", 0, {
		...lightTheme,
		getColorMode: () => "256color",
	});
	assert.match(indexedFrame, /\x1b\[38;5;\d+m/);
	assert.doesNotMatch(indexedFrame, /\x1b\[38;2;/);
	assert.equal(stripTerminalSequences(indexedFrame), "Thinking");
});

test("compact Thinking requests fresh frames between stream events and stops on completion", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
	const handlers = new Map<string, (...args: any[]) => void>();
	const hooks = installCompactThinking({
		on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
	} as any);
	try {
		let renders = 0;
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: {
				setWidget: (_id: string, factory: (tui: { requestRender(): void }) => { render(): string[] }) => {
					assert.deepEqual(factory({ requestRender: () => { renders++; } }).render(), []);
				},
			},
		};
		handlers.get("session_start")!({}, ctx);
		const msg = makeAssistantThinkingMsg("Checking the diff", 1000);
		const update = (type: string) => handlers.get("message_update")!({
			assistantMessageEvent: { type, partial: { timestamp: 1000, content: [{ type: "thinking" }] } },
		}, ctx);
		update("thinking_start");
		const frame = msg.render(80).join("\n");
		assert.match(stripTerminalSequences(frame), /Thinking ·/);
		assert.equal(renders, 1);
		t.mock.timers.tick(100);
		assert.ok(renders > 1);
		assert.notEqual(msg.render(80).join("\n"), frame);
		update("thinking_end");
		assert.match(msg.render(80).map(stripTerminalSequences).join("\n"), /Thought for/);
		const completedRenders = renders;
		t.mock.timers.tick(100);
		assert.equal(renders, completedRenders);
	} finally {
		hooks.shutdown();
	}
});

const thinkingClick = { type: "click", button: "left", x: 2, y: 1, width: 80, height: 3 } as const;

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
		const res = msg.handleMouse(thinkingClick as any);
		assert.equal(res?.handled, true);
		assert.equal(res?.render, true);

		const expanded = msg.render(80).map(stripTerminalSequences).join("\n");
		assert.match(expanded, /click to collapse/);
		assert.match(expanded, /line1/);
		assert.match(expanded, /line4/);

		msg.handleMouse(thinkingClick as any);
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
		m1.handleMouse(thinkingClick as any);
		const expanded = m1.render(80).map(stripTerminalSequences).join("\n");
		assert.match(expanded, /Checking project diff/);
		assert.match(expanded, /Checking fresh app metadata/);
		assert.match(expanded, /Preparing fresh test build/);
	} finally {
		thinkingHooks.shutdown();
		groupHooks.shutdown();
	}
});
