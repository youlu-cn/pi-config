import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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

/**
 * Atomically write scan cache to .pi/scan-cache.json via temporary file rename.
 */
export function saveScanCache(cwd: string, data: ScanCacheData): void {
	const dir = join(cwd, ".pi");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const payload: ScanCacheData = {
		...data,
		scannedDirtyFiles: data.scannedDirtyFiles ?? getGitChangedFiles(cwd),
	};
	const targetPath = getScanCachePath(cwd);
	const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
		renameSync(tmpPath, targetPath);
	} catch (err) {
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch {}
		throw err;
	}
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

/**
 * Execute git safely using execFileSync without invoking a shell.
 */
export function runGitArgs(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
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
	return runGitArgs(cwd, ["rev-parse", "HEAD"]);
}

/**
 * Parse a single line of `git status --porcelain` accurately,
 * preserving spaces, handling renames (`R  old -> new`), and unquoting paths.
 */
export function parsePorcelainLine(line: string): string | null {
	if (!line || line.length < 3) return null;
	// Standard porcelain v1 line: XY<space>PATH or XY<space>ORIG -> PATH
	const rawPath = line.slice(3).trim();
	if (!rawPath) return null;

	const arrowIdx = rawPath.indexOf(" -> ");
	const effectivePath = arrowIdx !== -1 ? rawPath.slice(arrowIdx + 4).trim() : rawPath;

	if (effectivePath.startsWith('"') && effectivePath.endsWith('"') && effectivePath.length >= 2) {
		return effectivePath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return effectivePath;
}

export function getGitChangedFiles(cwd: string): string[] {
	try {
		const out = execFileSync("git", ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		});
		if (!out) return [];

		return out
			.split("\n")
			.map((line) => parsePorcelainLine(line))
			.filter((item): item is string => Boolean(item && item.length > 0));
	} catch {
		return [];
	}
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
