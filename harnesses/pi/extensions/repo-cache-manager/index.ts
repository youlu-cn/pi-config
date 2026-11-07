import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { checkScanStatus, clearScanCache, type ScanStatusResult } from "./scan-cache.ts";
import { runScoutTask } from "./tools/scout.ts";
import { runArchitectTask } from "./tools/architect.ts";
import { ContextGuard } from "./context-guard.ts";

export default function repoCacheManagerExtension(pi: ExtensionAPI): void {
	let config = loadConfig();
	let guard = new ContextGuard(config.largeToolOutputCharThreshold);

	function refreshConfig(cwd: string): void {
		config = loadConfig(cwd);
	}

	function updateStatusBar(ctx: ExtensionContext, scan?: ScanStatusResult): void {
		const currentScan = scan || checkScanStatus(ctx.cwd, config.maxChangedFiles);
		if (currentScan.status === "SCANNED") {
			const shortHead = currentScan.head.slice(0, 7);
			const diffNote =
				currentScan.changedFiles.length > 0 ? ` +${currentScan.changedFiles.length} dirty` : "";
			ctx.ui.setStatus("repo-cache", `📦 Repo: Cached (HEAD: ${shortHead}${diffNote})`);
		} else {
			const reasonNote =
				currentScan.reason === "no_cache"
					? "No Cache"
					: currentScan.reason === "head_mismatch"
						? "HEAD Changed"
						: `Dirty >= ${config.maxChangedFiles}`;
			ctx.ui.setStatus("repo-cache", `📦 Repo: Uncached (${reasonNote})`);
		}
	}

	// 1. Register dedicated scout tool (read-only reconnaissance, writes summary to .pi/scan-cache.json)
	pi.registerTool({
		name: "scout",
		label: "Scout Reconnaissance",
		description:
			"Scan repository architecture in an isolated context using gemini-3.8-flash, extract key components, and write 2000-token summary to .pi/scan-cache.json.",
		parameters: {
			type: "object",
			properties: {
				reason: {
					type: "string",
					description: "Trigger reason for scanning, e.g. project unindexed or major git changes",
				},
				focusPaths: {
					type: "array",
					items: { type: "string" },
					description: "Optional specific paths to prioritize",
				},
			},
		} as any,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx.cwd);
			const res = await runScoutTask(params || {}, ctx, config, signal);
			if (res.success) {
				updateStatusBar(ctx);
				return {
					content: [
						{
							type: "text",
							text: `[SCOUT SUCCESS] Project architecture scanned and cached to .pi/scan-cache.json (HEAD: ${res.gitHead.slice(0, 7)}).\nSummary:\n${res.repoSummary}`,
						},
					],
				};
			}
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `[SCOUT FAILED] Could not complete reconnaissance: ${res.error || "Unknown error"}`,
					},
				],
			};
		},
	});

	// 2. Register dedicated architect tool (top-level architectural planning, single-turn isolation, no write/edit)
	pi.registerTool({
		name: "architect",
		label: "Architect Planning",
		description:
			"Consult gemini-4-argon in a clean, isolated single-turn context (<5K tokens) to generate a precise <task_spec> implementation blueprint without file modification tools.",
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "Complex requirements, refactoring goals, or protocol/deadlock design details",
				},
				codeSnippets: {
					type: "string",
					description: "Key relevant code slices or signature definitions needed for planning",
				},
			},
			required: ["task"],
		} as any,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx.cwd);
			const res = await runArchitectTask(params as any, ctx, config, signal);
			if (res.success) {
				return {
					content: [
						{
							type: "text",
							text: `[ARCHITECT PLAN GENERATED via ${res.modelUsed}]\n\n<task_spec>\n${res.taskSpec}\n</task_spec>\n\nExecute file modifications following the specification above.`,
						},
					],
				};
			}
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `[ARCHITECT PLAN FAILED via ${res.modelUsed}]: ${res.error || "Unknown error"}`,
					},
				],
			};
		},
	});

	// 3. Session initialization: update status bar and sync message model mapping
	pi.on("session_start", async (_event, ctx) => {
		refreshConfig(ctx.cwd);
		guard = new ContextGuard(config.largeToolOutputCharThreshold);
		guard.syncFromSessionEntries(ctx);
		updateStatusBar(ctx);
	});

	// 4. Before agent run: inspect scan status and inject into system prompt sections
	pi.on("before_agent_start", async (event, ctx) => {
		refreshConfig(ctx.cwd);
		guard.syncFromSessionEntries(ctx);
		const scan = checkScanStatus(ctx.cwd, config.maxChangedFiles);
		updateStatusBar(ctx, scan);

		if (scan.status === "SCANNED") {
			const dirtyNote =
				scan.changedFiles.length > 0
					? `\n\n[Uncommitted Changed Files (${scan.changedFiles.length})]:\n${scan.changedFiles.map((f) => `- ${f}`).join("\n")}`
					: "";

			const promptSection = [
				`Repository architecture summary is mounted below. Avoid full-codebase scanning. Proceed directly with routine tasks; for complex refactoring or system architecture design, invoke the \`architect\` subagent tool.`,
				"",
				`[REPOSITORY ARCHITECTURE SUMMARY (HEAD: ${scan.head.slice(0, 7)})]`,
				scan.repoSummary,
				dirtyNote,
			].join("\n");

			if (event.systemPromptOptions && event.systemPromptOptions.sections) {
				event.systemPromptOptions.sections.repo_cache = promptSection;
			}
		} else {
			const reasonDesc =
				scan.reason === "no_cache"
					? "no cache file found"
					: scan.reason === "head_mismatch"
						? "git HEAD commit changed"
						: `too many uncommitted changes (${scan.changedFilesCount} >= ${config.maxChangedFiles})`;

			const promptSection = `Workspace architecture cache is currently unindexed (${reasonDesc}). Please call the \`scout\` subagent tool first to scan the codebase and generate .pi/scan-cache.json.`;

			if (event.systemPromptOptions && event.systemPromptOptions.sections) {
				event.systemPromptOptions.sections.repo_cache = promptSection;
			}
		}
	});

	// 5. Context hook: prune bulky tool outputs only across manual model switches
	pi.on("context", (event, ctx) => {
		const currentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		const pruned = guard.protectContextOnModelSwitch(event.messages, currentModelId);
		if (pruned) {
			return { messages: pruned };
		}
		// When using the same model, return undefined so Pi takes the fast path without replaying system messages
		return;
	});

	// 6. Turn end and model select: synchronize status bar and message attribution
	pi.on("turn_end", (_event, ctx) => {
		guard.syncFromSessionEntries(ctx);
		updateStatusBar(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		guard.onModelSelect(event);
		updateStatusBar(ctx);
	});

	// 7. Register /rescan command: clear .pi/scan-cache.json and immediately trigger scout subagent
	pi.registerCommand("rescan", {
		description: "Clear repository cache and trigger scout reconnaissance immediately",
		async handler(_args, ctx) {
			clearScanCache(ctx.cwd);
			ctx.ui.setStatus("repo-cache", "📦 Repo: Scanning...");
			ctx.ui.notify("Starting scout reconnaissance in background subagent...", "info");
			refreshConfig(ctx.cwd);

			try {
				const res = await runScoutTask({}, ctx, config);
				if (res.success) {
					updateStatusBar(ctx);
					ctx.ui.notify(
						`Scout reconnaissance complete (HEAD: ${res.gitHead.slice(0, 7)}). Cache mounted.`,
						"info",
					);
				} else {
					updateStatusBar(ctx);
					ctx.ui.notify(`Scout reconnaissance failed: ${res.error}`, "error");
				}
			} catch (err: any) {
				updateStatusBar(ctx);
				ctx.ui.notify(`Scout error: ${err.message}`, "error");
			}
		},
	});
}
