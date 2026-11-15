import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
	Container, getCapabilities, getOsc8LinkAtColumn, Markdown, ScrollView,
	setCapabilities, stripTerminalSequences, Text, TuiAltScreen, visibleWidth, VStack,
} from "@earendil-works/pi-tui";
import { installLocalFileLinks, registerLocalFileLinks, resolveLocalFileLink } from "./local-file-links.ts";

initTheme("dark", false);
const cwd = resolve("test-workspace");
const expected = (path: string) => new URL(path, pathToFileURL(cwd + sep)).href;

function patchRenderer(t: any) {
	const capabilities = getCapabilities();
	setCapabilities({ ...capabilities, hyperlinks: true });
	const dispose = installLocalFileLinks(Markdown.prototype, () => cwd);
	assert.ok(dispose);
	t.after(() => { dispose(); setCapabilities(capabilities); });
}

function renderedLinks(lines: string[]): string[] {
	return [...new Set(lines.flatMap((line) => Array.from({ length: visibleWidth(line) },
		(_, col) => getOsc8LinkAtColumn(line, col)).filter((url): url is string => Boolean(url))))];
}

test("local destinations resolve against the workspace, with encoding and URL suffixes intact", () => {
	for (const href of [".pi/previews/rendered-symbols-editor-light.png", "./preview.png", "../preview.png",
		"docs/中文 图片.png", "docs/space%20name.png", "docs/a(b).png", "preview.html?view=light#result"]) {
		assert.equal(resolveLocalFileLink(href, cwd), expected(href));
	}
	assert.equal(resolveLocalFileLink("/tmp/preview image.png", cwd), "file:///tmp/preview%20image.png");
	assert.equal(resolveLocalFileLink("~/preview.png", cwd), pathToFileURL(resolve(homedir(), "preview.png")).href);
});

test("external URLs, existing file URLs, anchors and invalid control characters are not rewritten", () => {
	for (const href of ["", "https://example.com/a", "http://localhost:3000", "file:///tmp/preview.png",
		"mailto:user@example.com", "vscode://file/tmp/a.ts", "#section", "?view=light", "//example.com/a", "bad\x1bpath"]) {
		assert.equal(resolveLocalFileLink(href, cwd), href);
	}
	assert.equal(resolveLocalFileLink("preview.png", ""), "preview.png");
});

test("the guarded token patch is immutable and uses the latest workspace", () => {
	let workspace: string | undefined = cwd;
	const prototype = { renderInlineTokens: (tokens: unknown[]) => tokens };
	const original = prototype.renderInlineTokens;
	const tokens = Object.freeze([
		Object.freeze({ type: "link", href: "preview.png", tokens: [{ type: "text", text: "preview" }] }),
		Object.freeze({ type: "codespan", text: "[example](preview.png)" }),
	]);
	const dispose = installLocalFileLinks(prototype, () => workspace)!;
	try {
		const result = prototype.renderInlineTokens(tokens as any) as any[];
		assert.equal(result[0].href, expected("preview.png"));
		assert.equal((tokens[0] as any).href, "preview.png");
		assert.equal(result[1], tokens[1]);
		workspace = resolve(cwd, "next");
		assert.equal((prototype.renderInlineTokens(tokens as any) as any[])[0].href,
			pathToFileURL(resolve(workspace, "preview.png")).href);
		workspace = undefined;
		assert.equal(prototype.renderInlineTokens(tokens as any), tokens);
	} finally { dispose(); }
	assert.equal(prototype.renderInlineTokens, original);
});

test("replacement patches survive stale disposal and unsupported renderers fail closed", () => {
	const prototype = { renderInlineTokens: (tokens: unknown[]) => tokens };
	const original = prototype.renderInlineTokens;
	const first = installLocalFileLinks(prototype, () => cwd)!;
	const second = installLocalFileLinks(prototype, () => cwd)!;
	const replacement = prototype.renderInlineTokens;
	first();
	assert.equal(prototype.renderInlineTokens, replacement);
	second();
	assert.equal(prototype.renderInlineTokens, original);
	assert.equal(installLocalFileLinks({}, () => cwd), undefined);
});

test("native Markdown emits absolute file URLs for inline and reference links, not code examples", (t) => {
	patchRenderer(t);
	const source = [
		"[查看效果](.pi/previews/rendered-symbols-editor-light.png)",
		"", "[**参考图片**][preview]", "", "[preview]: <docs/中文 图片.png> \"Image title\"",
		"", "`[代码示例](code.png)`", "", "```md", "[围栏示例](fenced.png)", "```",
		"", "[网络](https://example.com) [本地](file:///tmp/existing.png)",
	].join("\n");
	const markdown = new Markdown(source, 0, 0, getMarkdownTheme());
	const lines = markdown.render(100);
	assert.deepEqual(renderedLinks(lines), [expected(".pi/previews/rendered-symbols-editor-light.png"),
		expected("docs/中文 图片.png"), "https://example.com", "file:///tmp/existing.png"]);
	assert.ok(lines.some((line) => stripTerminalSequences(line).includes("[代码示例](code.png)")));
	assert.ok(lines.some((line) => stripTerminalSequences(line).includes("[围栏示例](fenced.png)")));
});

for (const href of [".pi/previews/rendered-symbols-editor-light.png", "/tmp/preview.png",
	"file:///tmp/preview.png", "https://example.com/preview"]) {
	test(`real fullscreen click opens ${href}`, (t) => {
		patchRenderer(t);
		const opened: string[] = [];
		const terminal: any = {
			columns: 90, rows: 15, isTTY: true, write() {}, onData: () => () => {},
			setRawMode() {}, getColorMode: () => "truecolor", start() {}, stop() {}, showCursor() {},
		};
		const messages = new Container();
		messages.addChild(new Markdown(`[查看效果](${href})`, 0, 0, getMarkdownTheme()));
		const scroll = new ScrollView(messages, { follow: "none", primary: true });
		const tui: any = new TuiAltScreen(terminal, false, undefined, { mouse: true, openUrl: (url) => opened.push(url) });
		t.after(() => tui.stop());
		tui.altScreenActive = true;
		tui.setLayoutRoot(new VStack([
			{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: new Text("> "), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]));
		tui.doRender();
		const lines = tui.getScreenLines();
		const row = lines.findIndex((line: string) => stripTerminalSequences(line).includes("查看效果"));
		assert.ok(row >= 0);
		const plain = stripTerminalSequences(lines[row]);
		const col = visibleWidth(plain.slice(0, plain.indexOf("查看效果")));
		assert.equal(getOsc8LinkAtColumn(lines[row], col), expected(href));
		tui.handleViewportInput(`\x1b[<0;${col + 1};${row + 1}M`);
		assert.deepEqual(opened, []);
		tui.handleViewportInput(`\x1b[<0;${col + 1};${row + 1}m`);
		assert.deepEqual(opened, [expected(href)]);
	});
}

test("registration is TUI-only and restores the renderer on shutdown", () => {
	const handlers = new Map<string, Function>();
	registerLocalFileLinks({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any);
	const prototype = Markdown.prototype as any;
	const original = prototype.renderInlineTokens;
	const ctx = { cwd, hasUI: true, mode: "rpc", ui: { notify: () => assert.fail("Unexpected warning") } };
	handlers.get("session_start")!({}, ctx);
	assert.equal(prototype.renderInlineTokens, original);
	ctx.mode = "tui";
	try {
		handlers.get("session_start")!({}, ctx);
		assert.notEqual(prototype.renderInlineTokens, original);
	} finally { handlers.get("session_shutdown")!(); }
	assert.equal(prototype.renderInlineTokens, original);
});
