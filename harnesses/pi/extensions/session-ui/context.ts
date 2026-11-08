/**
 * /context — keyboard MVP context breakdown panel.
 * Mouse/SGR paths intentionally omitted; sticky-user-message skips when
 * hasActiveTextPreview() is true so keyboard preview overlays keep input.
 */

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	copyToClipboard,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
	FREE_COLOR,
	OTHER_COLOR,
	type PreviewKey,
	capParts,
	collectContextBreakdown,
	formatContextTokens,
	normalizePreviewText,
	resolveUsedTokens,
} from "./context-core.ts";
import { padLine } from "./shared.ts";

export type DialogBounds = { left: number; top: number; width: number };

const COPY_LABEL = "[copy]";
const ESC_LABEL = "[esc]";

/** 1-based terminal hitbox of [esc] on the dialog title row (row 2 of the box). */
export function escCloseHitbox(bounds: DialogBounds): {
	row: number;
	startCol: number;
	endCol: number;
} {
	return {
		row: bounds.top + 2,
		startCol: bounds.left + bounds.width - 5,
		endCol: bounds.left + bounds.width - 1,
	};
}

/** 1-based terminal hitbox of [copy], one space left of [esc] on the same title row. */
export function copyButtonHitbox(bounds: DialogBounds): {
	row: number;
	startCol: number;
	endCol: number;
} {
	const esc = escCloseHitbox(bounds);
	return {
		row: esc.row,
		startCol: esc.startCol - visibleWidth(COPY_LABEL) - 1,
		endCol: esc.startCol - 2,
	};
}

/** Test-replaceable clipboard; production uses pi's copyToClipboard. */
let copyTextImpl: (text: string) => Promise<void> = (text) => copyToClipboard(text);

export function setPreviewCopyImpl(impl: ((text: string) => Promise<void>) | null): void {
	copyTextImpl = impl ?? ((text) => copyToClipboard(text));
}

let activeContextOverlays = 0;

/** Gate for sticky mouse input while a /context text preview is open. */
export function hasActiveTextPreview(): boolean {
	return activeContextOverlays > 0;
}

type ActionFocus = "none" | "copy" | "esc";

export async function showTextPreview(
	ctx: Pick<ExtensionCommandContext, "ui">,
	title: string,
	rawContent: string,
): Promise<void> {
	const content = normalizePreviewText(rawContent);
	activeContextOverlays++;
	try {
		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				let scrollOffset = 0;
				let pageSize = 1;
				let totalLines = 1;
				let actionFocus: ActionFocus = "none";
				const markdownView = new Markdown(content, 0, 0, getMarkdownTheme());

				const scrollTo = (nextOffset: number): void => {
					const next = Math.max(0, Math.min(nextOffset, Math.max(0, totalLines - pageSize)));
					if (next === scrollOffset) return;
					scrollOffset = next;
					tui.requestRender();
				};

				const copyPreview = (): void => {
					void copyTextImpl(content)
						.then(() => {
							const flash = (tui as { flash?: (message: string) => void }).flash;
							if (typeof flash === "function") flash("Copied!");
							else ctx.ui.notify("Copied preview to clipboard", "info");
						})
						.catch((error: unknown) => {
							ctx.ui.notify(
								error instanceof Error ? error.message : "Copy failed",
								"error",
							);
						});
				};

				const cycleFocus = (): void => {
					actionFocus =
						actionFocus === "none" ? "copy" : actionFocus === "copy" ? "esc" : "none";
					tui.requestRender();
				};

				return {
					invalidate() {
						markdownView.invalidate();
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(undefined);
							return;
						}
						if (matchesKey(data, Key.tab)) {
							cycleFocus();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							if (actionFocus === "copy") {
								copyPreview();
								return;
							}
							if (actionFocus === "esc") {
								done(undefined);
								return;
							}
							return;
						}
						if (data === "c" || data === "C" || matchesKey(data, "c") || matchesKey(data, "C")) {
							copyPreview();
							return;
						}
						if (matchesKey(data, Key.up)) scrollTo(scrollOffset - 1);
						else if (matchesKey(data, Key.down)) scrollTo(scrollOffset + 1);
						else if (matchesKey(data, Key.pageUp) || matchesKey(data, "pageUp")) {
							scrollTo(scrollOffset - pageSize);
						} else if (matchesKey(data, Key.pageDown) || matchesKey(data, "pageDown")) {
							scrollTo(scrollOffset + pageSize);
						} else if (matchesKey(data, Key.home)) scrollTo(0);
						else if (matchesKey(data, Key.end)) scrollTo(totalLines - pageSize);
					},
					render(width: number) {
						const inner = Math.max(1, width - 2);
						const actionsWidth = visibleWidth(`${COPY_LABEL} ${ESC_LABEL}`);
						const bodyInner = Math.max(1, inner - 1);
						const bodyWidth = Math.max(1, bodyInner - 1);
						const terminalHeight = Math.max(1, tui.terminal.rows);
						const availableHeight = Math.max(1, terminalHeight - 4);
						const viewportHeight = Math.min(
							30,
							Math.max(1, Math.floor(terminalHeight * 0.8)),
							availableHeight,
						);
						pageSize = Math.max(1, viewportHeight - 6);
						const wrapped = markdownView.render(bodyWidth);
						totalLines = wrapped.length;
						scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));
						const visible = wrapped.slice(scrollOffset, scrollOffset + pageSize);
						const border = (text: string) => theme.fg("border", text);
						const scrollable = totalLines > pageSize;
						const thumbSize = scrollable
							? Math.max(
									Math.min(2, pageSize),
									Math.min(pageSize, Math.round((pageSize * pageSize) / totalLines)),
								)
							: 0;
						const maxScrollOffset = Math.max(0, totalLines - pageSize);
						const thumbStart =
							scrollable && maxScrollOffset > 0
								? Math.round((scrollOffset / maxScrollOffset) * (pageSize - thumbSize))
								: 0;
						const scrollbar = (row: number): string => {
							if (!scrollable) return " ";
							const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
							if (inThumb) return theme.fg("accent", "┃");
							return theme.fg("borderMuted", "│");
						};
						const bodyRows = Array.from({ length: pageSize }, (_, row) => {
							const line = visible[row] ?? "";
							return `${border("│")}${padLine(` ${line}`, bodyInner)}${scrollbar(row)}${border("│")}`;
						});
						const start = totalLines === 0 ? 0 : scrollOffset + 1;
						const end = Math.min(totalLines, scrollOffset + pageSize);
						const status = `${start}-${end} / ${totalLines} lines · ↑↓ PgUp/PgDn Home/End · c copy · Tab focus`;
						const copyFocused = actionFocus === "copy";
						const escFocused = actionFocus === "esc";
						const lines = [
							border(`╭${"─".repeat(inner)}╮`),
							`${border("│")}${padLine(` ${theme.bold(theme.fg("accent", title))}`, inner - actionsWidth)}${theme.fg(copyFocused ? "text" : "muted", COPY_LABEL)} ${theme.fg(escFocused ? "text" : "muted", ESC_LABEL)}${border("│")}`,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							...bodyRows,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							`${border("│")}${padLine(theme.fg("dim", ` ${status}`), inner)}${border("│")}`,
							border(`╰${"─".repeat(inner)}╯`),
						];
						return lines;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "80%",
					minWidth: 50,
					maxHeight: "80%",
					margin: 2,
				},
			},
		);
	} finally {
		activeContextOverlays--;
	}
}

type ContextPreview = {
	key: PreviewKey;
	label: string;
	title: string;
	content: string;
};

export function registerContextCommand(pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "Show the current context-window distribution",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const tools = pi.getAllTools();
			const breakdown = collectContextBreakdown(ctx, tools);
			const estimated = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
			const fixedTokens = breakdown.parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
			const used = Math.max(resolveUsedTokens(usage, estimated, contextWindow), fixedTokens);
			const parts = capParts(breakdown.parts, used, 4);
			const attributed = parts.reduce((sum, part) => sum + part.tokens, 0);
			const other = Math.max(0, used - attributed);
			const free = Math.max(0, contextWindow - used);
			const allParts = [
				...parts,
				{ label: "Other", tokens: other, color: OTHER_COLOR },
				{ label: "Free space", tokens: free, color: FREE_COLOR },
			];

			if (ctx.mode !== "tui") {
				const lines = allParts.map(
					(part) => `${part.label}: ${formatContextTokens(part.tokens)} tokens`,
				);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const rawPreviews: ContextPreview[] = [
				{
					key: "systemPrompt",
					label: "System prompt",
					title: "System Prompt",
					content: breakdown.previews.systemPrompt,
				},
				{
					key: "memoryFiles",
					label: "Memory",
					title: "Memory Files",
					content: breakdown.previews.memoryFiles,
				},
				{
					key: "skills",
					label: "Skills",
					title: "Skills",
					content: breakdown.previews.skills,
				},
				{
					key: "tools",
					label: "Tools definition",
					title: "Tools definition",
					content: breakdown.previews.tools,
				},
				{
					key: "toolResults",
					label: "Tool results",
					title: "Tool Results",
					content: breakdown.previews.toolResults,
				},
				{
					key: "contextFiles",
					label: "Context",
					title: "Context",
					content: breakdown.previews.contextFiles,
				},
			];
			const previews = rawPreviews.map((preview) => ({
				...preview,
				content: normalizePreviewText(preview.content),
			}));
			const previewByKey = new Map(previews.map((preview) => [preview.key, preview]));
			const visiblePreviews = previews.filter((preview) =>
				allParts.some((part) => part.label === preview.label),
			);
			let selectedPreviewIndex = 0;

			while (true) {
				activeContextOverlays++;
				let action: PreviewKey | undefined;
				try {
					action = await ctx.ui.custom<PreviewKey | undefined>(
						(tui, theme, _keybindings, done) => {
							return {
								invalidate() {},
								handleInput(data: string) {
									if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
										done(undefined);
										return;
									}
									if (matchesKey(data, Key.up) && visiblePreviews.length > 0) {
										selectedPreviewIndex =
											(selectedPreviewIndex - 1 + visiblePreviews.length) %
											visiblePreviews.length;
										tui.requestRender();
										return;
									}
									if (matchesKey(data, Key.down) && visiblePreviews.length > 0) {
										selectedPreviewIndex =
											(selectedPreviewIndex + 1) % visiblePreviews.length;
										tui.requestRender();
										return;
									}
									if (matchesKey(data, Key.enter)) {
										done(visiblePreviews[selectedPreviewIndex]?.key);
									}
								},
								render(width: number) {
									const inner = Math.max(1, width - 2);
									const escWidth = visibleWidth(ESC_LABEL);
									const percent = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
									const title = theme.bold(theme.fg("accent", "Context Usage"));
									const subtitle = `${formatContextTokens(used)} / ${formatContextTokens(contextWindow)} tokens (${percent.toFixed(1)}%)`;
									const barWidth = Math.max(1, Math.min(60, inner - 2));
									let remaining = barWidth;
									const segments = allParts
										.map((part, index) => {
											const cells =
												index === allParts.length - 1
													? remaining
													: Math.min(
															remaining,
															Math.round(
																(part.tokens / Math.max(1, contextWindow)) * barWidth,
															),
														);
											remaining -= cells;
											return theme.style("█".repeat(Math.max(0, cells)), {
												fg: part.color,
											});
										})
										.join("");
									const amountCells = allParts.map((part) => {
										const pct =
											contextWindow > 0 ? (part.tokens / contextWindow) * 100 : 0;
										const tokens = formatContextTokens(part.tokens).padStart(7);
										const pctText = `${pct.toFixed(1).padStart(5)}%`;
										return { tokens, percent: pctText, plain: `${tokens}  ${pctText}` };
									});
									const amountWidth = Math.max(
										...amountCells.map((cell) => visibleWidth(cell.plain)),
									);
									const labelWidth = Math.min(
										24,
										Math.max(...allParts.map((part) => part.label.length)),
										Math.max(1, inner - amountWidth - 5),
									);
									const selectedLabel = visiblePreviews[selectedPreviewIndex]?.label;
									const partRows = allParts.map((part, index) => {
										const swatch = theme.style("■", { fg: part.color });
										const label = part.label.padEnd(labelWidth);
										const amount = amountCells[index];
										const selected = part.label === selectedLabel;
										const prefix = selected ? "› " : "  ";
										const left = `${prefix}${swatch} ${label}`;
										const gap = Math.max(
											1,
											inner - 1 - visibleWidth(left) - visibleWidth(amount?.plain ?? ""),
										);
										const right = `${theme.fg("dim", amount?.tokens ?? "")}  ${amount?.percent ?? ""}`;
										const row = padLine(`${left}${" ".repeat(gap)}${right}`, inner);
										return selected ? theme.bg("selectedBg", row) : row;
									});
									const border = (text: string) => theme.fg("border", text);
									return [
										border(`╭${"─".repeat(inner)}╮`),
										`${border("│")}${padLine(` ${title}  ${theme.fg("dim", subtitle)}`, inner - escWidth)}${theme.fg("muted", ESC_LABEL)}${border("│")}`,
										`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
										`${border("│")}${padLine(` ${segments}`, inner)}${border("│")}`,
										`${border("│")}${" ".repeat(inner)}${border("│")}`,
										...partRows.map((row) => `${border("│")}${row}${border("│")}`),
										`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
										`${border("│")}${padLine(theme.fg("dim", " ↑↓ select · Enter preview · [esc] close"), inner)}${border("│")}`,
										border(`╰${"─".repeat(inner)}╯`),
									];
								},
							};
						},
						{
							overlay: true,
							overlayOptions: {
								anchor: "center",
								width: 64,
								minWidth: 44,
								maxHeight: "90%",
								margin: 1,
							},
						},
					);
				} finally {
					activeContextOverlays--;
				}

				if (!action) break;
				const preview = previewByKey.get(action);
				if (!preview) continue;
				await showTextPreview(ctx, preview.title, preview.content);
			}
		},
	});
}
