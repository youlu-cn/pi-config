import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, getCellDimensions, getOsc8LinkAtColumn, Markdown, ScrollView, setCapabilities,
	setCellDimensions, stripTerminalSequences, Text, TuiAltScreen, visibleWidth, VStack } from "@earendil-works/pi-tui";
import { DEFAULT_SESSION_UI_CONFIG } from "./config.ts";
import { installLocalFileLinks } from "./local-file-links.ts";
import { installMarkdownImages, localImagePath, MarkdownImageCache, readLocalImage,
	registerMarkdownImages, type LocalImageSource } from "./markdown-images.ts";

initTheme("dark", false);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=";
const source: LocalImageSource = { base64: PNG, mimeType: "image/png", dimensions: { widthPx: 1920, heightPx: 1080 } };
const config = DEFAULT_SESSION_UI_CONFIG.markdownImages;
const cwd = resolve("image-test-workspace");
const url = pathToFileURL(join(cwd, "preview.png")).href;
const hasImage = (lines: string[]) => lines.some((line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File="));
const links = (lines: string[]) => [...new Set(lines.flatMap((line) => Array.from({ length: visibleWidth(line) },
	(_, col) => getOsc8LinkAtColumn(line, col)).filter(Boolean)))];

function fixture(t: any, loader = async () => source, images: "kitty" | "iterm2" | null = "kitty", previewConfig = config) {
	const caps = getCapabilities();
	const cell = getCellDimensions();
	setCapabilities({ ...caps, images, hyperlinks: true });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	let refreshes = 0;
	const cache = new MarkdownImageCache(() => refreshes++, loader);
	const captions = installLocalFileLinks(Markdown.prototype, () => cwd, { images: true });
	const previews = installMarkdownImages(Markdown.prototype, cache, () => cwd, previewConfig);
	assert.ok(captions && previews);
	t.after(() => { previews(); captions(); cache.dispose(); setCapabilities(caps); setCellDimensions(cell); });
	return { cache, refreshes: () => refreshes,
		markdown: (text: string) => new Markdown(text, 0, 0, getMarkdownTheme()) };
}

test("local image destinations reject remote origins, unsupported formats and invalid URLs", () => {
	for (const href of ["preview.png", "./preview.png", "file://localhost" + join(cwd, "preview.png")]) {
		assert.equal(localImagePath(href, cwd), join(cwd, "preview.png"));
	}
	for (const href of ["https://example.com/a.png", "//example.com/a.png", "file://remote/a.png",
		"data:image/png;base64,x", "javascript:alert(1)", "image.svg", "file:///tmp/a%2Fb.png"]) {
		assert.equal(localImagePath(href, cwd), undefined);
	}
});

test("file loading bounds bytes and dimensions and always rejects non-images", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-markdown-image-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "valid.png");
	writeFileSync(path, Buffer.from(PNG, "base64"));
	const loaded = await readLocalImage(path, new AbortController().signal);
	assert.deepEqual(loaded?.dimensions, { widthPx: 1, heightPx: 1 });
	assert.equal(loaded?.base64, PNG);
	const invalid = join(dir, "invalid.png");
	writeFileSync(invalid, "not an image");
	assert.equal(await readLocalImage(invalid, new AbortController().signal), undefined);
	truncateSync(invalid, 8 * 1024 * 1024 + 1);
	assert.equal(await readLocalImage(invalid, new AbortController().signal), undefined);
	const directory = join(dir, "directory.png");
	mkdirSync(directory);
	assert.equal(await readLocalImage(directory, new AbortController().signal), undefined);
	const bomb = Buffer.from(PNG, "base64");
	bomb.writeUInt32BE(100_000, 16); bomb.writeUInt32BE(100_000, 20);
	writeFileSync(path, bomb);
	assert.equal(await readLocalImage(path, new AbortController().signal), undefined);
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(readLocalImage(path, aborted.signal), /abort/i);
});

for (const protocol of ["kitty", "iterm2"] as const) {
	test(`Markdown images load asynchronously below their clickable caption (${protocol})`, async (t) => {
		let loads = 0;
		const f = fixture(t, async () => { loads++; return source; }, protocol);
		const markdown = f.markdown("![效果图](preview.png)");
		const first = markdown.render(80);
		assert.equal(hasImage(first), false);
		assert.deepEqual(links(first), [url]);
		await f.cache.settled();
		const rendered = markdown.render(80);
		assert.ok(hasImage(rendered));
		assert.deepEqual(links(rendered), [url]);
		assert.ok(stripTerminalSequences(rendered[0]!).includes("效果图"));
		assert.ok(rendered.length <= config.maxHeightCells + 1);
		assert.equal(f.refreshes(), 1);
		assert.equal(loads, 1);
		assert.deepEqual(markdown.render(80), rendered);
		assert.equal((markdown as any).text, "![效果图](preview.png)");
	});
}

test("web links, remote images, code examples and unsupported files never load", async (t) => {
	let loads = 0;
	const f = fixture(t, async () => { loads++; return source; });
	for (const text of ["[网页](https://example.com)", "[远程图片](https://example.com/private.png)",
		"[文档](report.pdf)", "[说明](README.md)", "![远程](https://example.com/private.png)",
		"`[图片](preview.png)`",
		"`![示例](preview.png)`", "```md\n![示例](preview.png)\n```", "![矢量](preview.svg)"]) {
		assert.equal(hasImage(f.markdown(text).render(80)), false);
	}
	await f.cache.settled();
	assert.equal(loads, 0);
	assert.deepEqual(links(f.markdown("![远程](https://example.com/private.png)").render(80)), ["https://example.com/private.png"]);
});

test("ordinary local image links expand by default without rewriting their caption or source", async (t) => {
	const f = fixture(t);
	const text = "[查看效果](preview.png)";
	const markdown = f.markdown(text);
	markdown.render(80);
	await f.cache.settled();
	const rendered = markdown.render(80);
	assert.ok(hasImage(rendered));
	assert.deepEqual(links(rendered), [url]);
	assert.ok(stripTerminalSequences(rendered[0]!).includes("查看效果"));
	assert.equal((markdown as any).text, text);
});

test("opting out keeps ordinary image links collapsed but still previews Markdown images", async (t) => {
	let loads = 0;
	const f = fixture(t, async () => { loads++; return source; }, "kitty", { ...config, expandImageLinks: false });
	const link = f.markdown("[查看效果](preview.png)");
	link.render(80);
	await f.cache.settled();
	assert.equal(loads, 0);
	assert.equal(hasImage(link.render(80)), false);
	const image = f.markdown("![查看效果](preview.png)");
	image.render(80);
	await f.cache.settled();
	assert.equal(loads, 1);
	assert.ok(hasImage(image.render(80)));
});

test("non-image links do not consume the block preview limit, and aliases are deduplicated", async (t) => {
	let loads = 0;
	const f = fixture(t, async () => { loads++; return source; });
	const markdown = f.markdown(Array.from({ length: 5 }, (_, i) => `[网页](https://example.com/${i})`).join(" ") +
		" [效果图](preview.png) ![同一图片](./preview.png)");
	markdown.render(80);
	await f.cache.settled();
	const rendered = markdown.render(80);
	assert.ok(hasImage(rendered));
	assert.equal(loads, 1);
	assert.equal(rendered.filter((line) => line.includes("\x1b_G")).length, 1);
});

test("unsupported terminals preserve the caption link without reading the image", async (t) => {
	let loads = 0;
	const f = fixture(t, async () => { loads++; return source; }, null);
	const rendered = f.markdown("![图片](preview.png)").render(40);
	assert.deepEqual(links(rendered), [url]);
	await f.cache.settled();
	assert.equal(loads, 0);
	assert.equal(hasImage(rendered), false);
});

test("preview can be disabled independently while preserving the clickable caption", async (t) => {
	let loads = 0;
	const f = fixture(t, async () => { loads++; return source; }, "kitty", { ...config, enabled: false });
	const rendered = f.markdown("![图片](preview.png)").render(80);
	await f.cache.settled();
	assert.deepEqual(links(rendered), [url]);
	assert.equal(hasImage(rendered), false);
	assert.equal(loads, 0);
});

test("native fullscreen displays the image and opens the original only on caption click", async (t) => {
	const f = fixture(t, async () => ({ ...source, dimensions: { widthPx: 1, heightPx: 1 } }));
	const opened: string[] = [], output: string[] = [];
	const terminal: any = { columns: 80, rows: 20, isTTY: true, write: (text: string) => output.push(text),
		onData: () => () => {}, setRawMode() {}, getColorMode: () => "truecolor", start() {}, stop() {}, showCursor() {} };
	const markdown = f.markdown("[效果图](preview.png)\n\nImage follows the link.");
	const messages = new Container(); messages.addChild(markdown);
	const scroll = new ScrollView(messages, { follow: "none", primary: true });
	const tui: any = new TuiAltScreen(terminal, false, undefined, { mouse: true, openUrl: (href) => opened.push(href) });
	t.after(() => tui.stop());
	tui.altScreenActive = true; tui.imageProtocol = "kitty";
	tui.setLayoutRoot(new VStack([
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: new Text("> "), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]));
	tui.doRender();
	await f.cache.settled();
	tui.doRender();
	assert.ok(hasImage(tui.getScreenLines()));
	assert.ok(hasImage(output));
	assert.deepEqual(opened, []);
	const lines = tui.getScreenLines();
	const row = lines.findIndex((line: string) => stripTerminalSequences(line).includes("效果图"));
	assert.ok(row >= 0);
	const plain = stripTerminalSequences(lines[row]);
	const col = visibleWidth(plain.slice(0, plain.indexOf("效果图")));
	tui.handleViewportInput(`\x1b[<0;${col + 1};${row + 1}M`);
	tui.handleViewportInput(`\x1b[<0;${col + 1};${row + 1}m`);
	assert.deepEqual(opened, [url]);
});

test("missing or corrupt files retain a clickable caption and do not retry on each render", async (t) => {
	let loads = 0;
	const f = fixture(t, async () => { loads++; throw new Error("missing or corrupt"); });
	const markdown = f.markdown("![图片](preview.png)");
	markdown.render(80);
	await f.cache.settled();
	markdown.invalidate();
	const rendered = markdown.render(60);
	await f.cache.settled();
	assert.deepEqual(links(rendered), [url]);
	assert.equal(hasImage(rendered), false);
	assert.equal(loads, 1);
});

test("reference images, lists and table cells use parsed tokens without touching code", async (t) => {
	const f = fixture(t);
	for (const text of ["![图片][ref]\n\n[ref]: preview.png", "- ![图片](preview.png)",
		"| Image |\n|---|\n| ![图片](preview.png) |", "> ![图片](preview.png)"]) {
		const markdown = f.markdown(text);
		markdown.render(80);
		await f.cache.settled();
		assert.ok(hasImage(markdown.render(80)), text);
	}
});

test("small images occupy at most a cell and resizing never exceeds configured height", async (t) => {
	const f = fixture(t, async () => ({ ...source, dimensions: { widthPx: 1, heightPx: 1 } }));
	const markdown = f.markdown("![tiny](preview.png)");
	markdown.render(80);
	await f.cache.settled();
	assert.ok(markdown.render(80).length <= 2);
	for (const width of [4, 12, 80]) assert.ok(markdown.render(width).length <= config.maxHeightCells + 2);
});

test("loading is singleflight and session-bounded, and shutdown ignores late results", async () => {
	let loads = 0, invalidations = 0, refreshes = 0;
	const owner = { invalidate: () => invalidations++ };
	const cache = new MarkdownImageCache(() => refreshes++, async () => { loads++; return source; });
	for (let i = 0; i < 20; i++) { cache.get(`${i}.png`, owner); cache.get(`${i}.png`, owner); }
	await cache.settled();
	assert.equal(loads, 16);
	assert.equal(invalidations, 16);
	assert.equal(refreshes, 16);
	cache.dispose();
	let finish!: (value: LocalImageSource) => void;
	const late = new MarkdownImageCache(() => assert.fail("Refresh after shutdown"), () => new Promise((done) => { finish = done; }));
	late.get("late.png", owner);
	await Promise.resolve();
	late.dispose();
	finish(source);
	await late.settled();
	assert.equal(invalidations, 16);
});

test("the image rendering patch is guarded, reload-safe and TUI-only", () => {
	const prototype = { renderBlock() {} };
	const original = prototype.renderBlock;
	const cache = new MarkdownImageCache(() => {});
	const first = installMarkdownImages(prototype, cache, () => cwd, config)!;
	const second = installMarkdownImages(prototype, cache, () => cwd, config)!;
	const replacement = prototype.renderBlock;
	first(); assert.equal(prototype.renderBlock, replacement);
	second(); assert.equal(prototype.renderBlock, original);
	assert.equal(installMarkdownImages({}, cache, () => cwd, config), undefined);
	cache.dispose();
	const handlers = new Map<string, Function>();
	registerMarkdownImages({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any, config);
	const native = (Markdown.prototype as any).renderBlock;
	const ctx = { hasUI: true, mode: "rpc", cwd, ui: { setWidget: () => assert.fail("Widget in RPC") } };
	handlers.get("session_start")!({}, ctx);
	assert.equal((Markdown.prototype as any).renderBlock, native);
	handlers.get("session_shutdown")!({}, ctx);
});
