/**
 * Markdown enhance registration — Mermaid dialects + circled-number normalization.
 *
 * Pi allows one markdownTransformer slot per extension. Callers must compose this
 * with other session-ui transformers (e.g. ui-meta strip) before registering.
 */

import { createRequire, findPackageJSON } from "node:module";
import type {
	ExtensionAPI,
	MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import {
	enhanceMarkdown,
	type MermaidApi,
} from "./markdown-enhance-core.ts";

/** Soft-load grok-mermaid from beside @earendil-works/pi-coding-agent. */
export function loadGrokMermaid(): MermaidApi | null {
	try {
		const piPkg = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
		if (!piPkg) return null;
		const req = createRequire(piPkg);
		const mod = req("grok-mermaid") as MermaidApi;
		if (typeof mod?.render !== "function" || typeof mod?.sourceBox !== "function") {
			return null;
		}
		return mod;
	} catch {
		return null;
	}
}

/** Build the enhance transform (diagram render soft-fails if grok-mermaid is missing). */
export function createMarkdownEnhanceTransform(
	api: MermaidApi | null = loadGrokMermaid(),
): MarkdownTransformer {
	return (markdown, context) => enhanceMarkdown(markdown, context, api);
}

/**
 * Register enhance alone. Prefer composing via index when ui-meta is also enabled
 * so only one `registerMarkdownTransformer` call owns the extension slot.
 */
export function registerMarkdownEnhance(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer(createMarkdownEnhanceTransform());
}
