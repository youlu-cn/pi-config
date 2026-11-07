import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type RepoCacheManagerConfig } from "./config.ts";
import { checkScanStatus, clearScanCache, type ScanStatusResult } from "./scan-cache.ts";
import { runScoutTask } from "./tools/scout.ts";
import { runArchitectTask } from "./tools/architect.ts";
import { ContextGuard } from "./context-guard.ts";
import { CacheAuditCardView } from "./cache-audit-view.ts";
import {
	DEFAULT_TELEMETRY_CONFIG,
	TurnTelemetryCollector,
	estimateMessagesTokens,
	estimateTokensFromChars,
	extractMessageText,
	formatAuditCardText,
	isHeavyModel,
	shouldShowAuditCard,
	type CacheAuditCard,
	type DehydrationSnapshot,
	type RepoCacheInjectStatus,
	type TelemetryConfig,
} from "./telemetry.ts";

export const CACHE_AUDIT_ENTRY_TYPE = "repo-cache-audit";

function toTelemetryConfig(config: RepoCacheManagerConfig): TelemetryConfig {
	return {
		...DEFAULT_TELEMETRY_CONFIG,
		enabled: config.telemetryEnabled,
		heavyModelPattern: config.telemetryHeavyModelPattern,
		dehydrationNotifyRatio: config.telemetryDehydrationNotifyRatio,
		dehydrationMinOmittedTools: config.telemetryDehydrationMinOmittedTools,
		cacheBustHitRateFloor: config.telemetryCacheBustHitRateFloor,
		alwaysShow: config.telemetryAlwaysShow,
	};
}

function currentModelId(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
}

function buildDehydrationSnapshot(
	rawEstTokens: number,
	sentEstTokens: number,
	omittedTools: number,
	omittedSavedTokens: number,
): DehydrationSnapshot {
	const omittedSavedRatio =
		rawEstTokens > 0 ? Math.max(0, rawEstTokens - sentEstTokens) / rawEstTokens : null;
	return {
		rawEstTokens,
		sentEstTokens,
		omittedTools,
		omittedSavedTokens,
		omittedSavedRatio,
	};
}

export default function repoCacheManagerExtension(pi: ExtensionAPI): void {
	let config = loadConfig();
	let guard = new ContextGuard(config.largeToolOutputCharThreshold);
	const telemetry = new TurnTelemetryCollector();
	let turnActive = false;

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

	function emitAuditCard(ctx: ExtensionContext): void {
		const telCfg = toTelemetryConfig(config);
		if (!telCfg.enabled) return;

		const card = telemetry.buildCard(telCfg);
		if (!card) return;
		if (!shouldShowAuditCard(card.triggers, telCfg)) return;

		pi.appendEntry<CacheAuditCard>(CACHE_AUDIT_ENTRY_TYPE, card);

		if (ctx.hasUI) {
			const level =
				card.triggers.includes("cache_bust") || card.prefix.status === "busted"
					? "warning"
					: "info";
			// Short toast only; full card lives in the collapsed session entry.
			const hit =
				card.cloudCacheHitRate != null
					? `${(card.cloudCacheHitRate * 100).toFixed(0)}%`
					: "?";
			ctx.ui.notify(`Cache Audit ${card.prefix.label} hit=${hit}`, level);
		}
	}

	pi.registerEntryRenderer<CacheAuditCard>(CACHE_AUDIT_ENTRY_TYPE, (entry, { expanded, keyText }, theme) => {
		const card = entry.data;
		if (!card) return undefined;
		// Own MouseRegion so left-click toggles like tool/skill messages (host entry has no click).
		return new CacheAuditCardView(
			card,
			theme,
			expanded,
			keyText?.("app.tools.expand") ?? "ctrl+o",
		);
	});

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
		turnActive = false;
		// Clear legacy telemetry footer; session-ui already shows cache hit rates.
		if (ctx.hasUI) ctx.ui.setStatus("repo-cache-tel", undefined);
		updateStatusBar(ctx);
	});

	// 4. Before agent run: inspect scan status; inject summary only when policy says so (default: heavy models)
	pi.on("before_agent_start", async (event, ctx) => {
		refreshConfig(ctx.cwd);
		guard.syncFromSessionEntries(ctx);
		const scan = checkScanStatus(ctx.cwd, config.maxChangedFiles);
		updateStatusBar(ctx, scan);

		telemetry.resetForNewTurn();
		turnActive = true;
		const modelId = currentModelId(ctx);
		telemetry.modelId = modelId;

		const heavy = isHeavyModel(modelId, config.telemetryHeavyModelPattern);
		const shouldInject =
			config.injectRepoCacheOn === "always" ||
			(config.injectRepoCacheOn === "heavy" && heavy);

		let injectedSection = "";
		let repoCacheStatus: RepoCacheInjectStatus = "none";

		if (!shouldInject) {
			// Light / never: pay zero summary tax; disk cache + dehydration still available for later heavy turns.
			repoCacheStatus = config.injectRepoCacheOn === "never" ? "none" : "deferred";
			if (event.systemPromptOptions?.sections) {
				delete event.systemPromptOptions.sections.repo_cache;
			}
		} else if (scan.status === "SCANNED") {
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

			injectedSection = promptSection;
			repoCacheStatus = "injected";

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
			injectedSection = promptSection;
			repoCacheStatus = "unindexed";

			if (event.systemPromptOptions && event.systemPromptOptions.sections) {
				event.systemPromptOptions.sections.repo_cache = promptSection;
			}
		}

		const sysPrompt =
			typeof (ctx as any).getSystemPrompt === "function"
				? String((ctx as any).getSystemPrompt() || event.systemPrompt || "")
				: String(event.systemPrompt || injectedSection);

		telemetry.recordInjection({
			repoCacheStatus,
			repoCacheInjectedTokens: estimateTokensFromChars(injectedSection.length),
			sysPrompt: sysPrompt || injectedSection,
		});
	});

	// 5. Context hook: prune bulky tool outputs only across manual model switches + dehydration telemetry
	pi.on("context", (event, ctx) => {
		const modelId = currentModelId(ctx);
		telemetry.modelId = modelId || telemetry.modelId;

		const rawEstTokens = estimateMessagesTokens(event.messages);
		const pruned = guard.protectContextOnModelSwitch(event.messages, modelId);
		const dehydStats = guard.getLastDehydrationStats();

		if (pruned) {
			const sentEstTokens = estimateMessagesTokens(pruned);
			telemetry.recordContext(
				pruned,
				buildDehydrationSnapshot(
					rawEstTokens,
					sentEstTokens,
					dehydStats.omittedTools,
					dehydStats.omittedSavedTokens,
				),
			);
			return { messages: pruned };
		}

		telemetry.recordContext(
			event.messages,
			buildDehydrationSnapshot(rawEstTokens, rawEstTokens, 0, 0),
		);
		// When using the same model, return undefined so Pi takes the fast path without replaying system messages
		return;
	});

	// 6. Provider request: start latency clock
	pi.on("before_provider_request", (_event, ctx) => {
		telemetry.modelId = currentModelId(ctx) || telemetry.modelId;
		telemetry.markRequestStart();
		telemetry.recordContextUsage(ctx.getContextUsage?.());
	});

	// 7. Stream updates: capture TTFT on first assistant token
	pi.on("message_update", (event) => {
		if (!turnActive) return;
		const msg = event.message as { role?: string };
		if (msg?.role === "assistant") {
			telemetry.markFirstToken();
		}
	});

	// 8. Assistant message end: capture cloud usage + thinking tax
	pi.on("message_end", (event) => {
		if (!turnActive) return;
		const msg = event.message as {
			role?: string;
			usage?: unknown;
			content?: unknown;
		};
		if (msg?.role !== "assistant") return;

		const visibleChars = extractMessageText(msg.content).length;
		telemetry.recordAssistantUsage(msg.usage, visibleChars);
		telemetry.markComplete();
	});

	// 9. Turn end: emit audit card when triggers fire, sync status
	pi.on("turn_end", (_event, ctx) => {
		guard.syncFromSessionEntries(ctx);
		telemetry.recordContextUsage(ctx.getContextUsage?.());
		telemetry.markComplete();
		if (turnActive) {
			emitAuditCard(ctx);
			telemetry.finishTurn();
		}
		turnActive = false;
		updateStatusBar(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		guard.onModelSelect(event);
		updateStatusBar(ctx);
	});

	// 10. Register /rescan command: clear .pi/scan-cache.json and immediately trigger scout subagent
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

	// 11. /cache-audit — force-show last turn metrics (or explain if none)
	pi.registerCommand("cache-audit", {
		description: "Show the latest cache/context telemetry audit card",
		handler: async (_args, ctx) => {
			refreshConfig(ctx.cwd);
			const card = telemetry.lastCard;
			if (!card) {
				ctx.ui.notify(
					"No cache audit data yet. Send a message first so telemetry can collect a turn.",
					"info",
				);
				return;
			}
			pi.appendEntry<CacheAuditCard>(CACHE_AUDIT_ENTRY_TYPE, card);
			ctx.ui.notify(formatAuditCardText(card), "info");
		},
	});
}
