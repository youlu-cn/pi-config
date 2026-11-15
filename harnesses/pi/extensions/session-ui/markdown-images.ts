/** Display-only local Markdown image previews using Pi's native image pipeline. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, getImageDimensions, Image, Markdown,
	type ImageDimensions } from "@earendil-works/pi-tui";
import type { SessionUiConfig } from "./config.ts";
import { resolveLocalFileLink } from "./local-file-links.ts";

const PATCH_KEY = Symbol.for("session-ui.markdownImages.patch");
const WIDGET_KEY = "session-ui-markdown-images";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_CHARS = 32 * 1024 * 1024;
const MAX_IMAGES = 16;
const MAX_BLOCK_IMAGES = 4;
const MIME_TYPES: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

export interface LocalImageSource {
	base64: string;
	mimeType: string;
	dimensions: ImageDimensions;
}

export function localImagePath(href: string, cwd: string): string | undefined {
	try {
		const url = new URL(resolveLocalFileLink(href, cwd));
		if (url.protocol !== "file:") return undefined;
		const path = fileURLToPath(url);
		return MIME_TYPES[extname(path).toLowerCase()] ? path : undefined;
	} catch { return undefined; }
}

/** Bound reads even if a file grows, and never block on directories, devices or FIFOs. */
export async function readLocalImage(path: string, signal: AbortSignal): Promise<LocalImageSource | undefined> {
	signal.throwIfAborted();
	const mimeType = MIME_TYPES[extname(path).toLowerCase()];
	if (!mimeType) return undefined;
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) return undefined;
		const buffer = Buffer.alloc(stat.size + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			signal.throwIfAborted();
			const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
			if (!result.bytesRead) break;
			bytes += result.bytesRead;
		}
		if (bytes !== stat.size) return undefined;
		const base64 = buffer.subarray(0, bytes).toString("base64");
		const dimensions = getImageDimensions(base64, mimeType);
		if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1 ||
			dimensions.widthPx * dimensions.heightPx > 20_000_000) return undefined;
		return { base64, mimeType, dimensions };
	} finally { await file.close(); }
}

type Subscriber = { invalidate(): void };
type CacheEntry = { source?: LocalImageSource; done: boolean; subscribers: WeakRef<Subscriber>[]; seen: WeakSet<Subscriber> };

/** Serial, session-bounded loading avoids render-path I/O and cache-eviction/reload loops. */
export class MarkdownImageCache {
	private entries = new Map<string, CacheEntry>();
	private controller = new AbortController();
	private tail = Promise.resolve();
	private chars = 0;

	private refresh: () => void;
	private load: typeof readLocalImage;

	constructor(refresh: () => void, load = readLocalImage) {
		this.refresh = refresh;
		this.load = load;
	}

	get(path: string, owner: Subscriber): LocalImageSource | undefined {
		if (this.controller.signal.aborted) return undefined;
		let entry = this.entries.get(path);
		if (!entry) {
			if (this.entries.size >= MAX_IMAGES) return undefined;
			entry = { done: false, subscribers: [], seen: new WeakSet() };
			this.entries.set(path, entry);
			const pending = entry;
			this.tail = this.tail.then(async () => {
				if (this.controller.signal.aborted) return;
				try {
					const source = await this.load(path, this.controller.signal);
					if (this.controller.signal.aborted) return;
					if (source && this.chars + source.base64.length <= MAX_CACHE_CHARS) {
						this.chars += source.base64.length;
						pending.source = source;
						for (const ref of pending.subscribers) ref.deref()?.invalidate();
						this.refresh();
					}
				} catch { /* Keep the clickable caption when loading or decoding fails. */ }
				finally { pending.done = true; pending.subscribers = []; }
			});
		}
		if (!entry.done && !entry.seen.has(owner)) {
			entry.seen.add(owner);
			entry.subscribers.push(new WeakRef(owner));
		}
		return entry.source;
	}

	settled(): Promise<void> { return this.tail; }
	dispose(): void {
		this.controller.abort();
		this.entries.clear();
	}
}

/** Inspect parsed tokens, never code examples; count only supported local image paths. */
function imagePaths(token: any, cwd: string, expandLinks: boolean, found = new Set<string>()): Set<string> {
	if (!token || found.size >= MAX_BLOCK_IMAGES) return found;
	if (Array.isArray(token)) {
		for (const child of token) imagePaths(child, cwd, expandLinks, found);
	} else if (!["code", "codespan", "html"].includes(token.type)) {
		if ((token.type === "image" || (expandLinks && token.type === "link")) && typeof token.href === "string") {
			const path = localImagePath(token.href, cwd);
			if (path) found.add(path);
		}
		for (const key of ["tokens", "items", "header", "rows"]) imagePaths(token[key], cwd, expandLinks, found);
	}
	return found;
}

export function installMarkdownImages(prototype: object, cache: MarkdownImageCache,
	getCwd: () => string | undefined, config: SessionUiConfig["markdownImages"]): (() => void) | undefined {
	const target = prototype as any;
	target[PATCH_KEY]?.dispose();
	const original = target.renderBlock;
	if (typeof original !== "function") return undefined;
	let active = true;
	const images = new WeakMap<object, Map<string, { width: number; height: number; image: Image }>>();
	const wrapped = function (this: any, block: any, token: any, next: unknown, width: number, contentWidth: number) {
		const result = Reflect.apply(original, this, [block, token, next, width, contentWidth]);
		const cwd = active ? getCwd() : undefined;
		if (!cwd || !config.enabled || !getCapabilities().images || !Array.isArray(block.lines)) return result;
		for (const path of imagePaths(token, cwd, config.expandImageLinks)) {
			const source = cache.get(path, this);
			if (!source) continue;
			const cell = getCellDimensions();
			const maxWidth = Math.max(1, Math.min(contentWidth, config.maxWidthCells, Math.floor(source.dimensions.widthPx / cell.widthPx)));
			const maxHeight = Math.max(1, Math.min(config.maxHeightCells, Math.floor(source.dimensions.heightPx / cell.heightPx)));
			let owned = images.get(this);
			if (!owned) { owned = new Map(); images.set(this, owned); }
			let cached = owned.get(path);
			if (!cached || cached.width !== maxWidth || cached.height !== maxHeight) {
				cached = { width: maxWidth, height: maxHeight,
					image: new Image(source.base64, source.mimeType, { fallbackColor: (text) => text },
						{ filename: path, maxWidthCells: maxWidth, maxHeightCells: maxHeight }, source.dimensions) };
				owned.set(path, cached);
			}
			const lines = cached.image.render(contentWidth);
			if (lines.some((line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File="))) block.lines.push(...lines);
		}
		return result;
	};
	const patch = { dispose() {
		active = false;
		if (target[PATCH_KEY] !== patch) return;
		if (target.renderBlock === wrapped) target.renderBlock = original;
		delete target[PATCH_KEY];
	} };
	target.renderBlock = wrapped;
	target[PATCH_KEY] = patch;
	return patch.dispose;
}

export function registerMarkdownImages(pi: ExtensionAPI, config: SessionUiConfig["markdownImages"]): void {
	if (!config.enabled) return;
	let dispose: (() => void) | undefined;
	let cache: MarkdownImageCache | undefined;
	let refresh: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		dispose?.(); cache?.dispose();
		dispose = undefined; cache = undefined; refresh = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		cache = new MarkdownImageCache(() => refresh?.());
		dispose = installMarkdownImages(Markdown.prototype, cache, () => ctx.cwd, config);
		if (!dispose) { cache.dispose(); ctx.ui.notify("Markdown image previews unavailable: Pi renderer changed.", "warning"); return; }
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			const render = () => tui.requestRender();
			refresh = render;
			return { render: () => [], invalidate() {}, dispose() { if (refresh === render) refresh = undefined; } };
		});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		dispose?.(); cache?.dispose();
		dispose = undefined; cache = undefined; refresh = undefined;
		if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
