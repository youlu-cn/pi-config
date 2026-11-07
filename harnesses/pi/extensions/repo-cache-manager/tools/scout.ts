import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type RepoCacheManagerConfig } from "../config.ts";
import { getGitHead, runGitCmd, saveScanCache, type ScanCacheData } from "../scan-cache.ts";
import { runIsolatedSubagent } from "./subagent-runner.ts";

export interface ScoutParams {
	forceRefresh?: boolean;
	focusPaths?: string[];
	reason?: string;
}

export interface ScoutResult {
	success: boolean;
	repoSummary: string;
	gitHead: string;
	error?: string;
}

export function parseModelSpec(spec: string): { provider: string; model: string } {
	const parts = spec.split("/");
	if (parts.length === 2 && parts[0] && parts[1]) {
		return { provider: parts[0], model: parts[1] };
	}
	return { provider: "antigravity", model: spec };
}

export function extractRepoSummary(text: string, maxChars = 8000): string {
	const match = /<repo_summary>([\s\S]*?)<\/repo_summary>/i.exec(text);
	if (match?.[1]) {
		return match[1].trim().slice(0, maxChars);
	}
	return text.trim().slice(0, maxChars);
}

/**
 * Run Scout Subagent (isolated ephemeral subagent process with read-only tools)
 */
export async function runScoutTask(
	params: ScoutParams,
	ctx: ExtensionContext,
	config: RepoCacheManagerConfig = DEFAULT_CONFIG,
	signal?: AbortSignal,
): Promise<ScoutResult> {
	const gitHead = getGitHead(ctx.cwd) || "unversioned";
	const { provider, model } = parseModelSpec(config.scoutModel || DEFAULT_CONFIG.scoutModel);
	const maxSummaryTokens = config.maxSummaryTokens || DEFAULT_CONFIG.maxSummaryTokens;
	const maxSummaryChars = maxSummaryTokens * 4;

	// Prepare read-only git context for rapid subagent orientation
	const gitStatusShort = runGitCmd(ctx.cwd, "status --short") || "(clean)";
	const gitRecentLogs = runGitCmd(ctx.cwd, "log -n 5 --oneline") || "(no commits)";
	const focusInstruction =
		params.focusPaths && params.focusPaths.length > 0
			? `\nFocus investigation on paths: ${params.focusPaths.join(", ")}`
			: "";

	const prompt = [
		"You are a dedicated repository scout subagent. Your mission is to perform a physically isolated, read-only reconnaissance of the workspace and construct a dense architectural summary.",
		"",
		"=== READ-ONLY GIT CONTEXT ===",
		`HEAD: ${gitHead}`,
		`Recent Commits:\n${gitRecentLogs}`,
		`Status:\n${gitStatusShort}`,
		focusInstruction,
		"",
		"=== INSTRUCTIONS ===",
		"1. Use read, grep, find, and ls to inspect directory hierarchy, configuration files, core entry points, and primary exported interfaces.",
		"2. Strictly read-only: do not attempt to write, edit, or modify any files.",
		`3. Wrap a high-density architectural summary (<${maxSummaryTokens} tokens, ~${maxSummaryChars} chars) inside <repo_summary>...</repo_summary> tags at the end of your response.`,
		"   The summary must cover: technology stack, top-level directory responsibilities, main workflow / runtime lifecycle, and key domain models / protocol signatures.",
	].join("\n");

	try {
		const stdout = await runIsolatedSubagent({
			name: "scout",
			provider,
			model,
			tools: "read,grep,find,ls",
			cwd: ctx.cwd,
			prompt,
			timeoutMs: 120000,
			signal,
		});

		const summary = extractRepoSummary(stdout, maxSummaryChars);
		if (!summary || summary.length < 20) {
			throw new Error("Subagent returned empty or invalid repo summary.");
		}

		// Write summary to workspace .pi/scan-cache.json
		const cacheData: ScanCacheData = {
			gitHead,
			timestamp: Date.now(),
			repoSummary: summary,
		};
		saveScanCache(ctx.cwd, cacheData);

		return {
			success: true,
			repoSummary: summary,
			gitHead,
		};
	} catch (err: any) {
		return {
			success: false,
			repoSummary: "",
			gitHead,
			error: err?.message || String(err),
		};
	}
}
