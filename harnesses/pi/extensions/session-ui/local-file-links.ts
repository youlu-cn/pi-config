/** Resolve rendered local links against the session workspace, never the launcher's cwd. */
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, replaceControlCharacters } from "@earendil-works/pi-tui";

interface LocalLinkOptions {
	links?: boolean;
	images?: boolean;
}

const PATCH_KEY = Symbol.for("session-ui.localFileLinks.patch");
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** Leave external URLs, existing file URLs and document anchors untouched. */
export function resolveLocalFileLink(href: string, cwd: string): string {
	if (!href || !cwd || /[\x00-\x1f\x7f]/.test(href) ||
		URI_SCHEME.test(href) || href.startsWith("//") || /^[#?]/.test(href)) return href;
	try {
		const homeRelative = href.startsWith("~/");
		const base = pathToFileURL(resolve(homeRelative ? homedir() : cwd) + sep);
		return new URL(homeRelative ? href.slice(2) : href, base).href;
	} catch {
		return href;
	}
}

/**
 * Patch parsed link tokens, not Markdown source: code, images, reference definitions,
 * nested labels and escaped destinations keep the native parser's exact semantics.
 * Pi exposes no link-destination transform, so guard this private rendering seam.
 */
export function installLocalFileLinks(
	prototype: object,
	getCwd: () => string | undefined,
	options: LocalLinkOptions = {},
): (() => void) | undefined {
	const target = prototype as any;
	target[PATCH_KEY]?.dispose();
	const original = target.renderInlineTokens;
	if (typeof original !== "function") return undefined;
	let active = true;
	const wrapped = function (this: unknown, tokens: any[], ...args: unknown[]) {
		const cwd = active ? getCwd() : undefined;
		const renderedTokens = cwd && Array.isArray(tokens)
			? tokens.map((token) => {
				if (typeof token?.href !== "string") return token;
				if (token.type === "image" && options.images) {
					const label = replaceControlCharacters(token.text || "Image");
					return { ...token, type: "link", href: resolveLocalFileLink(token.href, cwd),
						tokens: [{ type: "text", raw: label, text: label }] };
				}
				return token.type === "link" && options.links !== false
					? { ...token, href: resolveLocalFileLink(token.href, cwd) } : token;
			})
			: tokens;
		return Reflect.apply(original, this, [renderedTokens, ...args]);
	};
	const patch = {
		dispose() {
			active = false;
			if (target[PATCH_KEY] !== patch) return;
			if (target.renderInlineTokens === wrapped) target.renderInlineTokens = original;
			delete target[PATCH_KEY];
		},
	};
	target.renderInlineTokens = wrapped;
	target[PATCH_KEY] = patch;
	return patch.dispose;
}

export function registerLocalFileLinks(pi: ExtensionAPI, options: LocalLinkOptions = {}): void {
	let dispose: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		dispose?.();
		dispose = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		dispose = installLocalFileLinks(Markdown.prototype, () => ctx.cwd, options);
		if (!dispose) ctx.ui.notify("Local file links unavailable: Pi Markdown renderer changed.", "warning");
	});
	pi.on("session_shutdown", () => {
		dispose?.();
		dispose = undefined;
	});
}
