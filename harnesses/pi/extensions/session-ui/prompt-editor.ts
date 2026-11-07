/**
 * Prompt editor with a Claude Code-style ❯ prefix.
 *
 * Adapted from pi-cc-extensions prompt-editor (MIT):
 * temporarily bump paddingX by 2, render, then replace the first two spaces of
 * the first content line with a colored `❯ `.
 *
 * When compact-paste is also enabled, compose via CompactPastePromptEditor
 * (registered from compact-paste.ts) — do not install a second editor factory.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** `❯ ` always occupies 2 columns: glyph + trailing space. */
const PROMPT_GLYPH = "❯";
const PROMPT_COLS = 2;

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

type PromptPrefixHost = {
	paddingX: number;
	borderColor: (text: string) => string;
};

/**
 * Shared ❯ inject used by PromptEditor and CompactPastePromptEditor so both
 * features can share one editor slot.
 */
export function renderWithPromptPrefix(
	host: PromptPrefixHost,
	baseRender: (width: number) => string[],
	width: number,
): string[] {
	const saved = host.paddingX;
	host.paddingX = saved + PROMPT_COLS;
	try {
		const lines = baseRender(width);
		// Layout: lines[0] top border, lines[1..n-2] content, lines[n-1] bottom border.
		// Inflated content starts with (saved + PROMPT_COLS) spaces; only swap the
		// first PROMPT_COLS so user padding remains after the glyph.
		if (lines.length > 2) {
			const line = lines[1]!;
			let spaces = 0;
			while (spaces < PROMPT_COLS && line[spaces] === " ") spaces++;
			if (spaces === PROMPT_COLS) {
				lines[1] = host.borderColor(PROMPT_GLYPH) + " " + line.slice(PROMPT_COLS);
			}
		}
		return lines;
	} finally {
		host.paddingX = saved;
	}
}

export class PromptEditor extends CustomEditor {
	render(width: number): string[] {
		return renderWithPromptPrefix(
			this as unknown as PromptPrefixHost,
			(w) => super.render(w),
			width,
		);
	}
}

const promptEditorFactory: EditorFactory = (tui, theme, keybindings) =>
	new PromptEditor(tui, theme, keybindings, { embedWorkingStatus: true });

/** Whether we currently own the editor slot; previous factory restored on release. */
let active = false;
let previousEditorFactory: EditorFactory | undefined;

function releasePromptEditor(ctx: ExtensionContext): void {
	if (!active) return;
	const previous = previousEditorFactory;
	active = false;
	previousEditorFactory = undefined;
	// If Pi already reset the slot to our previous factory (/new, /reload), do not write again.
	if (ctx.ui.getEditorComponent?.() === previous) return;
	ctx.ui.setEditorComponent(previous);
}

/**
 * Install the ❯ editor. Avoid calling while an extension dialog is open —
 * setEditorComponent clears the editor container and steals focus.
 */
export function applyPromptEditor(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setEditorComponent !== "function") return;
	if (!enabled) {
		releasePromptEditor(ctx);
		return;
	}
	const current = ctx.ui.getEditorComponent?.();
	if (current === promptEditorFactory) return;
	try {
		previousEditorFactory = current;
		active = true;
		ctx.ui.setEditorComponent(promptEditorFactory);
	} catch (err) {
		active = false;
		previousEditorFactory = undefined;
		ctx.ui.notify(
			`prompt editor error: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

export function clearPromptEditor(ctx: ExtensionContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setEditorComponent !== "function") return;
	releasePromptEditor(ctx);
}

/**
 * Standalone ❯ editor (no compact-paste). Prefer CompactPastePromptEditor when
 * both features are enabled so image paste and the prefix share one slot.
 */
export function registerPromptEditor(pi: ExtensionAPI, getEnabled: () => boolean): void {
	pi.on("session_start", (_event, ctx) => {
		applyPromptEditor(ctx, getEnabled());
	});
	pi.on("session_shutdown", (_event, ctx) => {
		clearPromptEditor(ctx);
	});
}
