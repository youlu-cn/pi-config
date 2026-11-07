/**
 * session-ui — composable Pi session presentation.
 *
 * Design constraints:
 * - Never replace tool execution. Tool lifecycle events feed ephemeral UI projections.
 * - Paste placeholders reuse Pi's native editor registry behind runtime guards.
 * - Footer modules are registered segments whose order is controlled by config.
 * - UI metadata, work state, and animation frames share one terminal-title owner.
 *
 * Installed configuration: ./config.json
 * Override path: PI_SESSION_UI_CONFIG=/absolute/path/to/config.json
 *
 * Commands:
 *   /effort [level|status]
 *   /statusline
 *   /work-animation [on|off|status]
 *   /tool-style [on|compact|off|status]
 *   /clear · /exit
 */

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentSummary } from "./agent-summary.ts";
import { registerAliases } from "./aliases.ts";
import { registerCompactPasteEditor } from "./compact-paste.ts";
import { registerClaudeToolRenderer } from "./claude-tool-renderer.ts";
import { installCompactThinking } from "./compact-thinking.ts";
import { loadSessionUiConfig } from "./config.ts";
import { registerEffort } from "./effort.ts";
import { registerPromptEditor } from "./prompt-editor.ts";
import { registerSpecialCards } from "./special-cards.ts";
import { registerStatusline } from "./statusline.ts";
import { registerSessionTitleController } from "./title-controller.ts";
import { registerToolActivity } from "./tool-activity.ts";
import { registerTurnSummary } from "./turn-summary.ts";
import { registerUiMeta } from "./ui-meta.ts";
import { registerWorkAnimation } from "./work-animation.ts";

export default function sessionUi(pi: ExtensionAPI): void {
	const loaded = loadSessionUiConfig();
	const { config } = loaded;
	const titleController = registerSessionTitleController(pi);

	if (config.turnSummary.enabled) registerTurnSummary(pi, config.turnSummary);
	if (config.agentSummary.enabled) {
		registerAgentSummary(pi, config.agentSummary);
	}
	if (
		config.uiMeta.enabled &&
		(config.uiMeta.title.enabled || config.uiMeta.sessionName.enabled)
	) {
		registerUiMeta(pi, config.uiMeta, titleController);
	}
	const workAnimController = registerWorkAnimation(
		pi,
		config.workAnimation,
		join(getAgentDir(), "state", "session-ui.json"),
		titleController,
	);
	// Always install so /reload can tear down the previous updateContent patch via
	// CompactThinkingHooks.shutdown (also hooked inside installCompactThinking).
	installCompactThinking(pi, {
		...config.compactThinking,
		enabled: config.compactThinking.enabled,
	});

	// One editor slot: compose ❯ into CompactPaste when both are on.
	if (config.compactPaste.enabled) {
		registerCompactPasteEditor(pi, { promptPrefix: config.editorPrefix.enabled });
	} else if (config.editorPrefix.enabled) {
		registerPromptEditor(pi, () => config.editorPrefix.enabled);
	}
	if (config.aliases.enabled) registerAliases(pi);
	if (config.specialCards.enabled) registerSpecialCards(pi);
	if (config.claudeToolStyle?.enabled ?? true) {
		registerClaudeToolRenderer(pi, {
			getStyle: () => config.claudeToolStyle.style ?? workAnimController.getStyle(),
			getIntervalMs: () =>
				config.claudeToolStyle.intervalMs ?? workAnimController.getIntervalMs(),
			getMode: () => config.claudeToolStyle.mode ?? "on",
			getGrouping: () => config.claudeToolStyle.grouping ?? true,
			getSpecialCards: () => config.specialCards.enabled,
			getDiffOptions: () => ({
				viewMode: config.claudeToolStyle.diffViewMode ?? "auto",
				indicatorMode: config.claudeToolStyle.diffIndicatorMode ?? "bars",
				splitMinWidth: config.claudeToolStyle.diffSplitMinWidth ?? 120,
				editCollapsedLines: config.claudeToolStyle.editDiffCollapsedLines ?? 12,
				writeCollapsedLines: config.claudeToolStyle.writeDiffCollapsedLines ?? 8,
			}),
			onModeChange: (mode) => {
				config.claudeToolStyle.mode = mode;
			},
		});
	}
	if (config.toolActivity.enabled) {
		registerToolActivity(pi, config.toolActivity);
	}
	if (config.statusline.enabled) registerStatusline(pi, config.statusline);
	if (config.effort.enabled) registerEffort(pi);

	if (loaded.warnings.length > 0) {
		let notified = false;
		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI || notified) return;
			notified = true;
			ctx.ui.notify(
				`session-ui config (${loaded.path}): ${loaded.warnings.join("; ")}; using defaults for invalid or missing values`,
				"warning",
			);
		});
	}
}
