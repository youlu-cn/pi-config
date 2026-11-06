import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	parseArgs,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

function isThinkingLevel(value: string): value is ThinkingLevel {
	return parseArgs(["--thinking", value]).thinking === value;
}

function availableLevels(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): ThinkingLevel[] {
	return ctx.model
		? getSupportedThinkingLevels(ctx.model)
		: [pi.getThinkingLevel()];
}

function modelLabel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model)";
}

function centerCell(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "");
	const padding = Math.max(0, width - visibleWidth(clipped));
	const left = Math.floor(padding / 2);
	return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
}

async function pickEffortLevel(
	ctx: ExtensionContext,
	current: ThinkingLevel,
	levels: ThinkingLevel[],
): Promise<ThinkingLevel | undefined> {
	return ctx.ui.custom<ThinkingLevel | undefined>(
		(tui, theme, keybindings, done) => {
			let selectedIndex = Math.max(0, levels.indexOf(current));
			const move = (delta: -1 | 1) => {
				const next = Math.max(
					0,
					Math.min(levels.length - 1, selectedIndex + delta),
				);
				if (next === selectedIndex) return;
				selectedIndex = next;
				tui.requestRender();
			};

			return {
				render(width: number): string[] {
					const maxLabelWidth = Math.max(6, ...levels.map(visibleWidth));
					const targetWidth = Math.min(77, width);
					const segmentWidth = Math.floor(targetWidth / levels.length);
					const panelWidth = segmentWidth * levels.length;
					const statusText = `current: ● ${current}`;
					const useVertical =
						width < 18 ||
						segmentWidth < maxLabelWidth ||
						panelWidth < visibleWidth("Effort") + visibleWidth(statusText) + 2;

					if (useVertical) {
						const lines = [
							theme.fg("accent", theme.bold("Effort")),
							theme.fg("dim", "current: ") +
								theme.fg("success", "●") +
								theme.fg("muted", ` ${current}`),
							"",
						];
						for (let index = 0; index < levels.length; index++) {
							const level = levels[index]!;
							if (index === selectedIndex) {
								lines.push(theme.fg("accent", `→ [ ${level} ]`));
							} else if (level === current) {
								lines.push(theme.fg("success", `  ● ${level}`));
							} else {
								lines.push(theme.fg("muted", `    ${level}`));
							}
						}
						lines.push(
							"",
							theme.fg("dim", "←/→ adjust · enter confirm · esc cancel"),
						);
						return lines.map((line) => truncateToWidth(line, width));
					}

					const title = theme.fg("accent", theme.bold("Effort"));
					const right =
						theme.fg("dim", "current: ") +
						theme.fg("success", "●") +
						theme.fg("muted", ` ${current}`);
					const modelBudget =
						panelWidth - visibleWidth("Effort") - visibleWidth(statusText) - 2;
					const model =
						modelBudget >= 3
							? truncateToWidth(modelLabel(ctx), modelBudget - 2, "…")
							: "";
					const left = title + (model ? theme.fg("dim", `  ${model}`) : "");
					const headerGap = Math.max(
						2,
						panelWidth - visibleWidth(left) - visibleWidth(right),
					);
					const poleLeft = theme.fg("dim", "← Faster");
					const poleRight = theme.fg("dim", "Smarter →");
					const poleGap = Math.max(
						1,
						panelWidth - visibleWidth("← Faster") - visibleWidth("Smarter →"),
					);

					const track: string[] = [];
					const labels: string[] = [];
					for (let index = 0; index < levels.length; index++) {
						const level = levels[index]!;
						const selected = index === selectedIndex;
						const active = level === current;
						const node = selected
							? theme.fg("accent", theme.bold("◆"))
							: active
								? theme.fg("success", "●")
								: theme.fg("dim", "○");
						const leftDash = Math.floor((segmentWidth - 1) / 2);
						const rightDash = segmentWidth - 1 - leftDash;
						track.push(
							theme.fg("dim", "─".repeat(leftDash)) +
								node +
								theme.fg("dim", "─".repeat(rightDash)),
						);

						const bracketed =
							segmentWidth >= level.length + 4
								? `[ ${level} ]`
								: segmentWidth >= level.length + 2
									? `[${level}]`
									: level;
						const centered = centerCell(selected ? bracketed : level, segmentWidth);
						labels.push(
							selected
								? theme.fg("accent", theme.bold(centered))
								: active
									? theme.fg("success", centered)
									: theme.fg("muted", centered),
						);
					}

					return [
						left + " ".repeat(headerGap) + right,
						"",
						poleLeft + " ".repeat(poleGap) + poleRight,
						track.join(""),
						labels.join(""),
						"",
						theme.fg("dim", "←/→ adjust · enter confirm · esc cancel"),
					].map((line) => truncateToWidth(line, width));
				},
				invalidate() {},
				handleInput(data: string) {
					const previous =
						keybindings.matches(data, "tui.editor.cursorLeft") ||
						keybindings.matches(data, "tui.select.up") ||
						data === "h" ||
						data === "k";
					const next =
						keybindings.matches(data, "tui.editor.cursorRight") ||
						keybindings.matches(data, "tui.select.down") ||
						data === "l" ||
						data === "j";
					if (previous) move(-1);
					else if (next) move(1);
					else if (
						keybindings.matches(data, "tui.select.confirm") ||
						data === "\n"
					) {
						done(levels[selectedIndex]);
					} else if (keybindings.matches(data, "tui.select.cancel")) {
						done(undefined);
					}
				},
			};
		},
	);
}

function applyLevel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	level: ThinkingLevel,
): void {
	const before = pi.getThinkingLevel();
	const levels = availableLevels(pi, ctx);
	if (!levels.includes(level)) {
		ctx.ui.notify(
			`The current model does not support "${level}". Available: ${levels.join(", ")}`,
			"warning",
		);
		return;
	}
	pi.setThinkingLevel(level);
	const after = pi.getThinkingLevel();
	if (after === before) {
		ctx.ui.notify(`Effort is already ${after}`, "info");
	} else if (after === level) {
		ctx.ui.notify(`effort ${before} → ${after}`, "info");
	} else {
		ctx.ui.notify(
			`Effort ${before} → ${after} (requested ${level}; adjusted to model capabilities)`,
			"info",
		);
	}
}

export function registerEffort(pi: ExtensionAPI): void {
	let completionLevels: ThinkingLevel[] = [];

	pi.on("session_start", (_event, ctx) => {
		completionLevels = availableLevels(pi, ctx);
	});
	pi.on("model_select", (event) => {
		completionLevels = getSupportedThinkingLevels(event.model);
	});

	pi.registerCommand("effort", {
		description: "Adjust thinking / reasoning effort",
		getArgumentCompletions(prefix) {
			const raw = prefix.trim().toLowerCase();
			const options = [...completionLevels, "status", "show", "current"];
			const matched = options.filter((item) => item.startsWith(raw));
			return matched.length > 0
				? matched.map((item) => ({ value: item, label: item }))
				: null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const current = pi.getThinkingLevel();
			const levels = availableLevels(pi, ctx);
			if (arg === "status" || arg === "show" || arg === "current") {
				ctx.ui.notify(
					`${modelLabel(ctx)}  effort=${current}  [${levels.join(", ")}]`,
					"info",
				);
				return;
			}
			if (!arg) {
				if (!ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify("/effort requires a level outside TUI mode", "warning");
					return;
				}
				const selected = await pickEffortLevel(ctx, current, levels);
				if (selected) applyLevel(pi, ctx, selected);
				return;
			}
			if (!isThinkingLevel(arg)) {
				ctx.ui.notify(
					`Unknown effort: "${arg}". Available: ${levels.join(", ")} or status`,
					"warning",
				);
				return;
			}
			applyLevel(pi, ctx, arg);
		},
	});
}
