import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

export interface ScanCacheData {
	gitHead: string;
	timestamp: number;
	repoSummary: string;
	scannedDirtyFiles?: string[];
}

export type ScanStatusResult =
	| {
			status: "SCANNED";
			head: string;
			repoSummary: string;
			changedFiles: string[];
	  }
	| {
			status: "UNSCANNED";
			reason: "no_cache" | "head_mismatch" | "too_many_changes";
			changedFilesCount: number;
			changedFiles: string[];
			head: string | null;
	  };

export function getScanCachePath(cwd: string): string {
	return join(cwd, ".pi", "scan-cache.json");
}

export function loadScanCache(cwd: string): ScanCacheData | null {
	const cachePath = getScanCachePath(cwd);
	if (!existsSync(cachePath)) return null;

	try {
		const raw = readFileSync(cachePath, "utf8");
		const data = JSON.parse(raw);
		if (data && typeof data.gitHead === "string" && typeof data.repoSummary === "string") {
			return data as ScanCacheData;
		}
	} catch {
		// Treat corrupted cache file as absent
	}
	return null;
}

export function saveScanCache(cwd: string, data: ScanCacheData): void {
	const dir = join(cwd, ".pi");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const payload: ScanCacheData = {
		...data,
		scannedDirtyFiles: data.scannedDirtyFiles ?? getGitChangedFiles(cwd),
	};
	writeFileSync(getScanCachePath(cwd), JSON.stringify(payload, null, 2), "utf8");
}

export function clearScanCache(cwd: string): boolean {
	const cachePath = getScanCachePath(cwd);
	if (existsSync(cachePath)) {
		try {
			unlinkSync(cachePath);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

export function runGitCmd(cwd: string, command: string): string | null {
	try {
		return execSync(`git ${command}`, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		}).trim();
	} catch {
		return null;
	}
}

export function getGitHead(cwd: string): string | null {
	return runGitCmd(cwd, "rev-parse HEAD");
}

export function getGitChangedFiles(cwd: string): string[] {
	const out = runGitCmd(cwd, "status --porcelain");
	if (!out) return [];

	return out
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			// Porcelain format is "XY filename" or "R  old -> new"
			const parts = line.split(/\s+/);
			return parts.length >= 2 ? parts.slice(1).join(" ") : line;
		});
}

/**
 * Core scan status evaluator:
 * - Cache exists, gitHead matches, and newly changed files since scan < maxChangedFiles (default: 8) => SCANNED
 * - Otherwise => UNSCANNED (missing cache, HEAD mismatch, or dirty files delta >= maxChangedFiles)
 */
export function checkScanStatus(cwd: string, maxChangedFiles = 8): ScanStatusResult {
	const currentHead = getGitHead(cwd);
	const changedFiles = getGitChangedFiles(cwd);
	const cache = loadScanCache(cwd);

	if (!cache) {
		return {
			status: "UNSCANNED",
			reason: "no_cache",
			changedFilesCount: changedFiles.length,
			changedFiles,
			head: currentHead,
		};
	}

	if (currentHead && cache.gitHead !== currentHead) {
		return {
			status: "UNSCANNED",
			reason: "head_mismatch",
			changedFilesCount: changedFiles.length,
			changedFiles,
			head: currentHead,
		};
	}

	// Calculate changes that occurred after the cache was generated
	const scannedDirtySet = new Set(cache.scannedDirtyFiles || []);
	const unindexedChanges = changedFiles.filter((f) => !scannedDirtySet.has(f));

	if (unindexedChanges.length >= maxChangedFiles) {
		return {
			status: "UNSCANNED",
			reason: "too_many_changes",
			changedFilesCount: unindexedChanges.length,
			changedFiles,
			head: currentHead,
		};
	}

	return {
		status: "SCANNED",
		head: cache.gitHead,
		repoSummary: cache.repoSummary,
		changedFiles,
	};
}
