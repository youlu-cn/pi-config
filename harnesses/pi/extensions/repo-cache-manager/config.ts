import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export interface RepoCacheManagerConfig {
	/** Scout subagent model binding (provider/modelId), default: antigravity/gemini-3.8-flash */
	scoutModel: string;
	/** Architect subagent model binding (provider/modelId), default: antigravity/gemini-4-argon */
	architectModel: string;
	/** Git uncommitted changed files threshold; >= this value triggers UNSCANNED, default: 8 */
	maxChangedFiles: number;
	/** Scout summary maximum token budget, default: 2000 tokens (~8000 chars) */
	maxSummaryTokens: number;
	/** Architect context maximum token budget, default: 5000 tokens (~18000 chars) */
	maxArchitectContextTokens: number;
	/** Character threshold for pruning large tool outputs during cross-model switches, default: 1200 chars */
	largeToolOutputCharThreshold: number;
}

export const DEFAULT_CONFIG: RepoCacheManagerConfig = {
	scoutModel: "antigravity/gemini-3.8-flash",
	architectModel: "antigravity/gemini-4-argon",
	maxChangedFiles: 8,
	maxSummaryTokens: 2000,
	maxArchitectContextTokens: 5000,
	largeToolOutputCharThreshold: 1200,
};

export function loadConfig(cwd: string = process.cwd()): RepoCacheManagerConfig {
	const defaultPath = fileURLToPath(new URL("./config.json", import.meta.url));
	const configCandidates = [
		defaultPath,
		join(homedir(), ".pi", "agent", "repo-cache-manager.json"),
		join(cwd, ".pi", "repo-cache-manager.json"),
	];

	let merged = { ...DEFAULT_CONFIG };

	for (const candidate of configCandidates) {
		if (existsSync(candidate)) {
			try {
				const content = readFileSync(candidate, "utf8");
				const parsed = JSON.parse(content);
				merged = { ...merged, ...parsed };
			} catch {
				// Ignore parse failures and fall back to current configuration
			}
		}
	}

	return merged;
}

