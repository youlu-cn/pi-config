import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	ScrollView,
	stripTerminalSequences,
	Text,
	TuiAltScreen,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	computeStickyPrompt,
	disposeStickyPromptPatches,
	handleStickyPromptClick,
	installStickyPromptPatches,
	renderStickyPromptScreen,
	resetStickyPromptState,
	setFullscreenActive,
	setStickyPromptTheme,
	STICKY_MESSAGE_END,
	STICKY_MESSAGE_START,
	stickyPromptBar,
	updateStickyPromptHover,
} from "./sticky-user-message.ts";

initTheme("dark");

const START = STICKY_MESSAGE_START;
const END = STICKY_MESSAGE_END;
const VIEWPORT_WIDTH = 80;

/** Message body lines: first row gets START, last gets END; body text at index 1. */
function messageLines(text: string, height: number): string[] {
	const lines = Array.from({ length: height }, (_, index) => (index === 1 ? text : ""));
	lines[0] = START + lines[0];
	lines[height - 1] += END;
	return lines;
}

function assistantLines(height: number): string[] {
	return Array.from({ length: height }, (_, index) => `assistant ${index}`);
}

function plain(line: string): string {
	return stripTerminalSequences(line);
}

/** Fake fullscreen layout: primary scroll box + viewport height + content lines. */
function makeFrame(content: string[], scrollTop: number, viewportHeight: number, clipX = 0) {
	let renders = 0;
	const scrollView: any = {
		scrollTop,
		followEnd: true,
		isFollowingEnd: false,
		isScrollbarVisible: false,
		lastScroll: null as { row: number; options: any } | null,
		scrollTo(row: number, options?: any) {
			scrollView.scrollTop = row;
			scrollView.lastScroll = { row, options };
		},
	};
	const contentBox: any = {
		component: { render: () => content },
		rect: { x: 0, y: -scrollTop, width: VIEWPORT_WIDTH, height: content.length },
		clip: { x: clipX, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
		children: [],
	};
	const scrollBox: any = {
		component: {},
		rect: { x: 0, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
		clip: { x: clipX, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
		children: [contentBox],
		scrollView,
		scrollContentLines: content,
	};
	const layout: any = {
		root: {
			component: {},
			rect: { x: 0, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
			clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
			children: [scrollBox],
		},
		width: VIEWPORT_WIDTH,
		height: viewportHeight,
		lines: [],
		primaryScrollView: scrollView,
	};
	const tui: any = {
		mode: "fullscreen",
		currentLayout: layout,
		getPrimaryScrollView: () => scrollView,
		requestRender() {
			renders += 1;
		},
	};
	return {
		layout,
		scrollView,
		tui,
		screen: Array.from({ length: viewportHeight }, () => ""),
		renders: () => renders,
	};
}

function fakeTheme() {
	const slots: string[] = [];
	return {
		slots,
		theme: {
			fg: (_color: string, text: string) => text,
			bg: (slot: string, text: string) => {
				slots.push(slot);
				return text;
			},
		},
	};
}

/** Restore enabled getter, patches, and cross-frame cache after each case. */
function withSticky<T>(body: (ctl: { setEnabled: (v: boolean) => void }) => T): T {
	let enabled = true;
	installStickyPromptPatches(() => enabled);
	setFullscreenActive(true);
	try {
		return body({
			setEnabled(v) {
				enabled = v;
			},
		});
	} finally {
		disposeStickyPromptPatches();
		resetStickyPromptState();
		setFullscreenActive(true);
	}
}

test("sticky prompt: markers only injected in fullscreen", () => {
	withSticky(() => {
		const text = "Long pasted compiler output";

		setFullscreenActive(true);
		const fullscreen = new UserMessageComponent(text).render(VIEWPORT_WIDTH);
		assert.ok(fullscreen[0]?.endsWith(START), "first line has START marker");
		assert.ok(fullscreen[fullscreen.length - 1]?.endsWith(END), "last line has END marker");
		assert.equal(visibleWidth(fullscreen[0] ?? ""), VIEWPORT_WIDTH);

		setFullscreenActive(false);
		const regular = new UserMessageComponent(text).render(VIEWPORT_WIDTH);
		assert.ok(
			regular.every((line) => !line.includes(START) && !line.includes(END)),
			"regular does not inject markers",
		);
	});
});

test("sticky prompt: tall user message pins its first line at the viewport top", () => {
	withSticky(() => {
		const content = [...messageLines("Long pasted compiler output", 60), ...assistantLines(20)];
		const { layout, tui, screen } = makeFrame(content, 30, 10);
		const { theme, slots } = fakeTheme();
		setStickyPromptTheme(theme);

		const info = computeStickyPrompt(tui, layout);
		assert.equal(info?.row, 0, "sticky row is viewport top");
		assert.equal(info?.jumpRow, 0, "jump target is message start");
		assert.equal(info?.text, "Long pasted compiler output");
		assert.equal(info?.width, VIEWPORT_WIDTH);

		const rendered = renderStickyPromptScreen(tui, screen, layout, VIEWPORT_WIDTH);
		assert.equal(
			plain(rendered[0] ?? ""),
			stickyPromptBar(info!.text, VIEWPORT_WIDTH, false, theme),
		);
		assert.match(plain(rendered[0] ?? ""), /^ Long pasted compiler output/);
		assert.match(plain(rendered[0] ?? ""), /\[click to jump\]$/);
		assert.equal(visibleWidth(rendered[0] ?? ""), VIEWPORT_WIDTH);
		assert.deepEqual([...new Set(slots)], ["userMessageBg"]);
		assert.ok(
			rendered.every((line) => !line.includes(START) && !line.includes(END)),
			"markers must not reach the terminal",
		);
	});
});

test("sticky prompt: any user message pins once its first line scrolls off the top", () => {
	withSticky(() => {
		const content = [...messageLines("short instruction", 3), ...assistantLines(20)];

		const natural = makeFrame(content, 1, 10);
		assert.equal(computeStickyPrompt(natural.tui, natural.layout), null);

		const offTop = makeFrame(content, 2, 10);
		assert.equal(computeStickyPrompt(offTop.tui, offTop.layout)?.text, "short instruction");

		const past = makeFrame(content, 12, 10);
		assert.equal(computeStickyPrompt(past.tui, past.layout)?.text, "short instruction");
	});
});

test("sticky prompt: the next instruction takes over once it scrolls off the top", () => {
	withSticky(() => {
		const content = [
			...messageLines("first instruction", 3),
			...assistantLines(20),
			...messageLines("second instruction", 3),
			...assistantLines(20),
		];

		const firstTurn = makeFrame(content, 10, 10);
		assert.equal(computeStickyPrompt(firstTurn.tui, firstTurn.layout)?.text, "first instruction");
		const beforeNext = makeFrame(content, 22, 10);
		assert.equal(computeStickyPrompt(beforeNext.tui, beforeNext.layout)?.text, "first instruction");

		const nextVisible = makeFrame(content, 24, 10);
		assert.equal(computeStickyPrompt(nextVisible.tui, nextVisible.layout), null);

		const secondTurn = makeFrame(content, 27, 10);
		assert.equal(
			computeStickyPrompt(secondTurn.tui, secondTurn.layout)?.text,
			"second instruction",
		);

		const back = makeFrame(content, 3, 10);
		assert.equal(computeStickyPrompt(back.tui, back.layout)?.text, "first instruction");
	});
});

test("sticky prompt: the header in place does not stick", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(40)];

		const visible = makeFrame(content, 1, 10);
		assert.equal(computeStickyPrompt(visible.tui, visible.layout), null);

		const top = makeFrame(content, 0, 10);
		assert.equal(computeStickyPrompt(top.tui, top.layout), null);
	});
});

test("sticky prompt: hover marks the row and keeps one highlight", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 20, 10);
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 5 } as any), true);
		assert.equal(frame.renders() >= 1, true);
		const hovered = renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);
		assert.match(plain(hovered[0] ?? ""), /^ tall message/);
		assert.equal(updateStickyPromptHover(frame.tui, { row: 4, col: 5 } as any), false);
		const moved = renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);
		assert.equal(moved[0], hovered[0]);
	});
});

test("sticky prompt: scrollbar column is not part of the bar", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 2, 10);
		frame.scrollView.isScrollbarVisible = true;
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		const scrollbarCol = VIEWPORT_WIDTH;
		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: scrollbarCol } as any), false);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: scrollbarCol } as any), false);
		assert.equal(frame.scrollView.lastScroll, null);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 5 } as any), true);
	});
});

test("sticky prompt: the full row stays clickable when no scrollbar is drawn", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: VIEWPORT_WIDTH } as any), true);
		assert.deepEqual(frame.scrollView.lastScroll, { row: 0, options: { disableFollow: true } });
	});
});

test("sticky prompt: a click left of the bar misses", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10, 8);
		frame.scrollView.isScrollbarVisible = true;
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 8 } as any), false);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 8 } as any), false);
		assert.equal(frame.scrollView.lastScroll, null);
		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 9 } as any), true);
	});
});

test("sticky prompt: click jumps to the message top", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		assert.equal(handleStickyPromptClick(frame.tui, { row: 3, col: 1 } as any), false);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 1 } as any), true);
		assert.deepEqual(frame.scrollView.lastScroll, { row: 0, options: { disableFollow: true } });
		assert.equal(
			handleStickyPromptClick(frame.tui, { row: 1, col: 1 } as any),
			false,
			"sticky bar invalidated after jump",
		);
	});
});

test("sticky prompt: stale frame state does not act", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);
		frame.tui.currentLayout = { root: null };
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 1 } as any), false);
		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 1 } as any), false);
	});
});

test("sticky prompt: switched off keeps the transcript unchanged", () => {
	withSticky((ctl) => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		ctl.setEnabled(false);
		const rendered = renderStickyPromptScreen(
			frame.tui,
			frame.screen,
			frame.layout,
			VIEWPORT_WIDTH,
		);
		assert.deepEqual(rendered, frame.screen);
		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 1 } as any), false);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 1 } as any), false);
	});
});

test("sticky prompt: frame patch composites through the alt-screen hook and restores", () => {
	disposeStickyPromptPatches();
	const original = (TuiAltScreen.prototype as any).compositeScrollToEndIndicator;
	withSticky(() => {
		const installed = (TuiAltScreen.prototype as any).compositeScrollToEndIndicator;
		assert.notEqual(installed, original, "install wraps the prototype method");

		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		const screen = installed.call(
			{ scrollToEndIndicator: undefined, requestRender() {} },
			frame.screen,
			frame.layout,
			VIEWPORT_WIDTH,
		);
		assert.match(plain(screen[0] ?? ""), /^ tall message/);

		disposeStickyPromptPatches();
		assert.equal(
			(TuiAltScreen.prototype as any).compositeScrollToEndIndicator,
			original,
			"dispose restores prototype method",
		);
		// Re-install so withSticky finally can dispose cleanly.
		installStickyPromptPatches(() => true);
	});
});

test("sticky prompt: a stale dispose leaves the replacement patches alive", async () => {
	// Resolve jiti via pi-coding-agent's dependency tree (not a direct session-ui dep).
	const agentRoot = realpathSync(
		join(dirname(fileURLToPath(import.meta.url)), "node_modules/@earendil-works/pi-coding-agent"),
	);
	const require = createRequire(join(agentRoot, "package.json"));
	const { createJiti } = require("jiti") as { createJiti: (...args: any[]) => any };
	const load = async () => {
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		const path = fileURLToPath(new URL("./sticky-user-message.ts", import.meta.url));
		return (await jiti.import(path)) as any;
	};
	const first = await load();
	const second = await load();
	assert.notEqual(
		first.installStickyPromptPatches,
		second.installStickyPromptPatches,
		"two module instances (reload)",
	);
	const prototype = TuiAltScreen.prototype as any;
	const original = prototype.compositeScrollToEndIndicator;
	const hasMarker = () =>
		new UserMessageComponent("hi").render(40).some((line) => line.includes(START));
	try {
		first.installStickyPromptPatches(() => true);
		first.setFullscreenActive(true);
		first.disposeStickyPromptPatches();
		second.installStickyPromptPatches(() => true);
		second.setFullscreenActive(true);
		assert.equal(hasMarker(), true, "new instance injects markers");

		first.disposeStickyPromptPatches();
		assert.equal(hasMarker(), true, "stale dispose leaves markers");
		assert.notEqual(prototype.compositeScrollToEndIndicator, original);
	} finally {
		second.disposeStickyPromptPatches();
		first.disposeStickyPromptPatches();
		prototype.compositeScrollToEndIndicator = original;
	}
});

/** Real frame path: official layout + ScrollView/UserMessageComponent via doRender. */
function realFrame(userText: string, assistantCount: number) {
	const width = 100;
	const height = 20;
	const terminal: any = {
		columns: width,
		rows: height,
		isTTY: true,
		write() {},
		onData: () => () => {},
		setRawMode() {},
		getColorMode: () => "truecolor",
		start() {},
		stop() {},
	};
	const messages = new Container();
	messages.addChild(new UserMessageComponent(userText));
	for (let i = 0; i < assistantCount; i++) messages.addChild(new Text(`assistant line ${i}`));
	const scroll = new ScrollView(messages, { follow: "none", primary: true, scrollbar: "auto" });
	const tui: any = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	tui.altScreenActive = true;
	tui.setLayoutRoot(
		new VStack([
			{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{
				component: new VStack([{ component: new Text("> "), shrink: 1, minSize: 1 }]),
				basis: "auto",
				grow: 0,
				shrink: 1,
				minSize: 1,
			},
		]),
	);
	return {
		tui,
		scroll,
		firstRow: () => stripTerminalSequences(tui.getScreenLines()[0] ?? ""),
		render(top: number) {
			scroll.scrollTo(top, { disableFollow: true });
			tui.doRender();
			return stripTerminalSequences(tui.getScreenLines()[0] ?? "");
		},
	};
}

test("sticky prompt: real alt-screen frame pins the row and strips markers", () => {
	withSticky(() => {
		setFullscreenActive(true);
		const longPrompt = [
			"click 文本前不要有点，同时点击跳转后由于原生 userMessage box 有上有 padding，上方展示不全",
			...Array.from({ length: 40 }, (_, i) => `log ${i}`),
		].join("\n");
		const frame = realFrame(longPrompt, 120);
		const firstRow = () => stripTerminalSequences(frame.tui.getScreenLines()[0] ?? "");

		assert.doesNotMatch(frame.render(0), /\[click to jump\]/);
		assert.doesNotMatch(frame.render(1), /\[click to jump\]/);
		assert.match(frame.render(3), /^ click 文本前/);
		assert.match(firstRow(), /… \[click to jump\]/);
		assert.match(frame.render(100), /^ click 文本前/);
		assert.ok(
			frame.tui.getScreenLines().every((line: string) => !line.includes(START)),
			"markers must not enter the terminal frame",
		);
		const rawRow = frame.tui.getScreenLines()[0] ?? "";
		const barStart = rawRow.indexOf("click 文本前");
		const hintEnd = rawRow.indexOf("[click to jump]") + "[click to jump]".length;
		assert.ok(barStart >= 0 && hintEnd > barStart);
		assert.equal(rawRow.slice(barStart, hintEnd).includes("\x1b[0m"), false);

		frame.render(30);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 5 } as any), true);
		assert.equal(frame.scroll.scrollTop, 0);
		frame.tui.doRender();
		assert.doesNotMatch(firstRow(), /\[click to jump\]/);
	});
});

test("sticky prompt: the scrollbar track on the pinned row does not jump to the top", () => {
	withSticky(() => {
		setFullscreenActive(true);
		const terminal: any = {
			columns: 100,
			rows: 20,
			isTTY: true,
			write() {},
			onData: () => () => {},
			setRawMode() {},
			getColorMode: () => "truecolor",
			start() {},
			stop() {},
		};
		const messages = new Container();
		const prompt = ["pinned prompt", ...Array.from({ length: 40 }, (_, i) => `log ${i}`)];
		messages.addChild(new UserMessageComponent(prompt.join("\n")));
		for (let i = 0; i < 300; i++) messages.addChild(new Text(`assistant line ${i}`));
		const scroll = new ScrollView(messages, {
			follow: "none",
			primary: true,
			scrollbar: "always",
		});
		const tui: any = new TuiAltScreen(terminal, false, undefined, { mouse: true });
		tui.altScreenActive = true;
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: new Text("> "), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		const trackPress = { code: 0, row: 1, col: 100, final: "M" } as any;
		tui.doRender();
		const at = (top: number) => {
			scroll.scrollTo(top, { disableFollow: true });
			tui.doRender();
		};

		at(300);
		assert.match(stripTerminalSequences(tui.getScreenLines()[0] ?? ""), /pinned prompt/);
		assert.equal(handleStickyPromptClick(tui, trackPress), true);
		assert.equal(scroll.scrollTop, 300, "top track press does not jump to session start");

		at(30);
		assert.match(stripTerminalSequences(tui.getScreenLines()[0] ?? ""), /pinned prompt/);
		assert.equal(handleStickyPromptClick(tui, trackPress), false, "thumb at top stays draggable");
		assert.equal(scroll.scrollTop, 30);

		at(0);
		assert.doesNotMatch(
			stripTerminalSequences(tui.getScreenLines()[0] ?? ""),
			/pinned prompt/,
		);
		assert.equal(handleStickyPromptClick(tui, trackPress), false);
		assert.equal(scroll.scrollTop, 0);
	});
});

test("sticky prompt: truncated text keeps the bar styling across the whole row", () => {
	const wrapped: string[] = [];
	let textColor = "";
	const theme = {
		fg: (color: string, text: string) => {
			textColor = color;
			return text;
		},
		bg: (_slot: string, text: string) => {
			wrapped.push(text);
			return text;
		},
	};
	const bar = stickyPromptBar(
		"click 文本前不要有点，同时点击跳转后由于原生 userMessage box 有上有 padding",
		40,
		false,
		theme,
	);
	assert.equal(visibleWidth(bar), 40);
	assert.equal(wrapped.length, 1);
	assert.doesNotMatch(wrapped[0] ?? "", /\x1b\[/);
	assert.match(wrapped[0] ?? "", /\[click to jump\]$/);
	assert.equal(textColor, "dim");
	assert.match(bar, /…/);
});

test("sticky prompt: narrow viewport drops the click hint before the text", () => {
	const { theme } = fakeTheme();
	const narrow = stickyPromptBar("a much longer user message than fits", 16, false, theme);
	assert.equal(visibleWidth(narrow), 16);
	assert.doesNotMatch(narrow, /\[click to jump\]/);
	assert.match(narrow, /^ /);
});
