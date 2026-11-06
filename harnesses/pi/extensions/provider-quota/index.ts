/**
 * provider-quota — Modular multi-provider quota and rate-limit monitor.
 *
 * Architecture:
 * - Microkernel scheduler with dynamic Adapter Registry
 * - Per-provider adapters for normalized quota calculation
 * - Fail-safe queries with background throttling & TTL caching
 * - Emits standard "subscription-usage/status/v1" events for session-ui statusline
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatQuotaReport } from "./format.ts";
import { AdapterRegistry } from "./registry.ts";
import { QuotaScheduler } from "./scheduler.ts";

export default function providerQuota(pi: ExtensionAPI): void {
	const registry = new AdapterRegistry();
	const scheduler = new QuotaScheduler(pi, registry);

	// 注册 /quota 查询命令
	pi.registerCommand("quota", {
		description: "Display subscription quotas and reset countdowns for configured AI providers",
		async handler(_args, ctx) {
			const active = ctx.model?.provider;
			const report = await scheduler.refreshActiveProvider(ctx);

			if (!report) {
				const supported = registry
					.getAllConfigured(ctx)
					.map((a) => a.displayName)
					.join(", ");
				ctx.ui.notify(
					`No quota information available for provider: ${active || "none"}. Configured: ${supported || "none"}`,
					"info",
				);
				return;
			}

			const formatted = formatQuotaReport(report, ctx.model?.id);
			ctx.ui.notify(formatted, "info");
		},
	});

	// 生命周期监听
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI && ctx.mode === "tui") {
			scheduler.start(ctx);
		}
	});

	pi.on("model_select", (_event, ctx) => {
		scheduler.refreshActiveProvider(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		scheduler.refreshActiveProvider(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		scheduler.refreshActiveProvider(ctx);
	});

	pi.on("session_shutdown", () => {
		scheduler.stop();
	});
}
