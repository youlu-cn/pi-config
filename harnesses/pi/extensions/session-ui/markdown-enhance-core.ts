/**
 * Pure markdown enhance transforms: Mermaid dialect fences, circled-number
 * normalization, and multiline-link whitespace cleanup.
 */

export interface MermaidArt {
	plain: string[];
	width: number;
}

export interface MermaidSourceBox {
	plain: string[];
}

export interface MermaidApi {
	render: (src: string) => MermaidArt;
	sourceBox: (src: string, width: number) => MermaidSourceBox;
}

export interface DiagramRenderContext {
	isStreaming?: boolean;
	availableWidth?: number;
}

// ============================================================================
// Mermaid dialect rendering
// ============================================================================

// Built-in mermaid transformer only accepts ```mermaid; grok-mermaid dialects fill the gap.
const DIAGRAM_FENCE =
	/^(`{3,})\s*(mermaid|statediagram|statediagram-v2|classdiagram|classdiagram-v2|erdiagram|sequencediagram)\s*$/i;
const FENCE_OPEN = /^(`{3,})/;
const FENCE_CLOSE = /^`{3,}\s*$/;

/** Wrap a diagram line as an inline code span (preserve spaces and box chars). */
function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(longestRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

/** On render failure or overflow, show framed source. */
function framedSource(api: MermaidApi, src: string, width: number): string {
	const box = api.sourceBox(src, Math.max(8, width - 2));
	return `\`\`\`\n${box.plain.join("\n")}\n\`\`\``;
}

/** Parse a ```diagram fence; return source + next index, or null if unclosed. */
function collectFence(lines: string[], i: number): { diagram: string; next: number } | null {
	const open = lines[i]!.match(FENCE_OPEN)?.[0] ?? "```";
	const src: string[] = [];
	let j = i + 1;
	while (j < lines.length) {
		if (lines[j]!.match(FENCE_CLOSE) && lines[j]!.startsWith(open)) {
			return { diagram: src.join("\n"), next: j + 1 };
		}
		src.push(lines[j]!);
		j++;
	}
	return null;
}

// ============================================================================
// Circled numbers → half-width parentheses
// ============================================================================

// Nerd Font patched glyphs (U+2460-U+2473) overpaint neighbors under DirectWrite;
// ASCII "(n)" keeps consistent width. Code point offset from U+2460 is the index.
const CIRCLED_RE = /[①-⑳]/g;

const BLOCKQUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const CODE_FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;

type MarkdownFence = { marker: string; blockquoteDepth: number };

function parseFenceLine(line: string): { blockquoteDepth: number; content: string } {
	let content = line;
	let blockquoteDepth = 0;
	while (BLOCKQUOTE_PREFIX.test(content)) {
		content = content.replace(BLOCKQUOTE_PREFIX, "");
		blockquoteDepth++;
	}
	return { blockquoteDepth, content };
}

function scanMarkdownFence(
	line: string,
	fence: MarkdownFence | undefined,
): { protected: boolean; fence: MarkdownFence | undefined } {
	const parsed = parseFenceLine(line);
	if (fence && parsed.blockquoteDepth >= fence.blockquoteDepth) {
		const close = parsed.content.match(CODE_FENCE_CLOSE)?.[1];
		const closed =
			parsed.blockquoteDepth === fence.blockquoteDepth &&
			close?.[0] === fence.marker[0] &&
			close.length >= fence.marker.length;
		return { protected: true, fence: closed ? undefined : fence };
	}
	const marker = parsed.content.match(CODE_FENCE_OPEN)?.[1];
	return {
		protected: Boolean(marker),
		fence: marker ? { marker, blockquoteDepth: parsed.blockquoteDepth } : undefined,
	};
}

export function deCircled(markdown: string): string {
	let fence: MarkdownFence | undefined;
	return markdown
		.split("\n")
		.map((line) => {
			const scanned = scanMarkdownFence(line, fence);
			fence = scanned.fence;
			if (scanned.protected) return line;
			return line.replace(CIRCLED_RE, (ch) => `(${ch.codePointAt(0)! - 0x2460 + 1})`);
		})
		.join("\n");
}

// ============================================================================
// Multiline link normalization
// ============================================================================

// Exclude \x1b so ANSI-colored Mermaid code spans are not treated as link starts (#84).
const MULTILINE_LINK_RE = /(?<!\x1b)\[([^\]\n\x1b]*(?:\n[^\]\n\x1b]*)+)\](?=\()/g;

/** Collapse multiline link labels so trailing pad spaces are not OSC 8 hit targets. */
export function normalizeMultilineLinks(markdown: string): string {
	const out: string[] = [];
	let prose: string[] = [];
	let fence: MarkdownFence | undefined;
	const flush = () => {
		if (prose.length === 0) return;
		out.push(
			prose.join("\n").replace(MULTILINE_LINK_RE, (_match, label: string) => {
				const normalized = label.replace(/[ \t]*\n[ \t]*/g, " ").trim();
				return `[${normalized}]`;
			}),
		);
		prose = [];
	};
	for (const line of markdown.split("\n")) {
		const scanned = scanMarkdownFence(line, fence);
		const opening = !fence && scanned.fence;
		const closing = fence && !scanned.fence;
		fence = scanned.fence;
		if (opening || closing) flush();
		if (scanned.protected) out.push(line);
		else prose.push(line);
	}
	flush();
	return out.join("\n");
}

// ============================================================================
// Diagram render (cached)
// ============================================================================

const ART_CACHE = new Map<string, MermaidArt>();
const ART_CACHE_MAX = 50;

function getArt(api: MermaidApi, src: string): MermaidArt | null {
	const cached = ART_CACHE.get(src);
	if (cached) return cached;
	let art: MermaidArt | null = null;
	try {
		art = api.render(src);
	} catch {
		art = null;
	}
	if (ART_CACHE.size >= ART_CACHE_MAX) ART_CACHE.clear();
	if (art) ART_CACHE.set(src, art);
	return art;
}

/** Clear the mermaid art cache (tests). */
export function clearMermaidArtCache(): void {
	ART_CACHE.clear();
}

/**
 * Mermaid dialect fences → ASCII art. Skips while streaming.
 * When `api` is null (grok-mermaid unavailable), fences are left unchanged.
 */
export function renderDiagrams(
	markdown: string,
	context?: DiagramRenderContext,
	api: MermaidApi | null = null,
): string {
	const { isStreaming = false, availableWidth } = context ?? {};
	if (isStreaming || !api) return markdown;
	const lines = markdown.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const fence = line.match(DIAGRAM_FENCE);
		if (fence) {
			const collected = collectFence(lines, i);
			if (collected) {
				const { diagram, next } = collected;
				const label = fence[2]!;
				const src = label.toLowerCase() === "mermaid" ? diagram : `${label}\n${diagram}`;
				const art = getArt(api, src);
				const width = availableWidth ?? 80;
				if (art && art.width <= width) {
					out.push(art.plain.map(codeSpan).join("  \n"));
				} else {
					out.push(framedSource(api, src, width));
				}
				i = next;
				continue;
			}
		}
		out.push(line);
		i++;
	}
	return out.join("\n");
}

export interface MarkdownEnhanceContext {
	messageType?: string;
	isStreaming?: boolean;
	availableWidth?: number;
}

/** Full enhance pipeline used by the registered transformer. */
export function enhanceMarkdown(
	markdown: string,
	context?: MarkdownEnhanceContext,
	api: MermaidApi | null = null,
): string {
	const { messageType, isStreaming = false } = context ?? {};
	if (messageType === "assistant-thinking") return markdown;
	markdown = normalizeMultilineLinks(markdown);
	if (isStreaming) return markdown;
	markdown = deCircled(markdown);
	return renderDiagrams(markdown, context, api);
}
