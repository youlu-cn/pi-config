import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type RepoCacheManagerConfig } from "../config.ts";
import { loadScanCache } from "../scan-cache.ts";
import { parseModelSpec } from "./scout.ts";
import { runIsolatedSubagent } from "./subagent-runner.ts";

export interface ArchitectParams {
	task: string;
	codeSnippets?: string;
}

export interface ArchitectResult {
	success: boolean;
	taskSpec: string;
	modelUsed: string;
	error?: string;
}

export function extractTaskSpec(text: string): string {
	const match = /<task_spec>([\s\S]*?)<\/task_spec>/i.exec(text);
	if (match?.[1]) {
		return match[1].trim();
	}
	return text.trim();
}

/**
 * Assemble pure planning context bounded within token budget (~3.6 chars per token)
 */
export function buildArchitectPrompt(
	repoSummary: string,
	task: string,
	codeSnippets?: string,
	maxChars = 18000,
): string {
	const header = "=== PROJECT ARCHITECTURE SUMMARY ===\n" + repoSummary.trim() + "\n\n";
	const taskSection = "=== TASK OBJECTIVE & REQUIREMENTS ===\n" + task.trim() + "\n\n";
	const footer =
		"=== SPECIFICATION REQUIREMENTS ===\n" +
		"As the principal architect, produce an exhaustive, implementation-ready technical specification formatted inside <task_spec>...</task_spec> tags.\n" +
		"Include:\n" +
		"1. Exact relative file paths to modify or create.\n" +
		"2. Precise function signatures, type definitions, and interface changes.\n" +
		"3. Step-by-step implementation plan with edge cases, concurrency hazards, and protocol details.\n" +
		"Do not call editing tools. The primary agent will execute code changes strictly following your blueprint.";

	const snippetPrefix = "=== KEY CODE SLICES & RELEVANT SIGNATURES ===\n";
	const snippetSuffix = "\n\n";
	const fixedOverhead = header.length + taskSection.length + footer.length;
	const availableForSnippets = Math.max(
		0,
		maxChars - fixedOverhead - snippetPrefix.length - snippetSuffix.length,
	);

	let snippetsSection = "";
	if (codeSnippets && codeSnippets.trim().length > 0 && availableForSnippets > 50) {
		const trimmedSnippets = codeSnippets.trim().slice(0, availableForSnippets);
		snippetsSection = snippetPrefix + trimmedSnippets + snippetSuffix;
	}

	return header + snippetsSection + taskSection + footer;
}

/**
 * Run Architect Subagent (isolated ephemeral subagent process, read-only/reasoning, write/edit strictly forbidden)
 */
export async function runArchitectTask(
	params: ArchitectParams,
	ctx: ExtensionContext,
	config: RepoCacheManagerConfig = DEFAULT_CONFIG,
	signal?: AbortSignal,
): Promise<ArchitectResult> {
	const { provider, model } = parseModelSpec(config.architectModel || DEFAULT_CONFIG.architectModel);
	const maxContextTokens = config.maxArchitectContextTokens || DEFAULT_CONFIG.maxArchitectContextTokens;
	const maxChars = Math.floor(maxContextTokens * 3.6);

	const scan = loadScanCache(ctx.cwd);
	const repoSummary = scan?.repoSummary || "Project summary not available yet. Please inspect key files.";

	// Assemble clean planning prompt strictly constrained under token budget
	const prompt = buildArchitectPrompt(repoSummary, params.task, params.codeSnippets, maxChars);

	try {
		const stdout = await runIsolatedSubagent({
			name: "architect",
			provider,
			model,
			tools: "read,grep,find",
			cwd: ctx.cwd,
			prompt,
			timeoutMs: 240000,
			signal,
		});

		const spec = extractTaskSpec(stdout);
		if (!spec || spec.length < 20) {
			throw new Error("Architect returned empty or invalid task spec.");
		}

		return {
			success: true,
			taskSpec: spec,
			modelUsed: `${provider}/${model}`,
		};
	} catch (err: any) {
		return {
			success: false,
			taskSpec: "",
			modelUsed: `${provider}/${model}`,
			error: err?.message || String(err),
		};
	}
}
