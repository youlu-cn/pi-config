import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ScanStatusType = "CACHED" | "DIRTY" | "UNSCANNED";

export interface ScanCacheData {
	gitHead: string;
	timestamp: number;
	repoSummary: string;
	scannedFiles?: string[];
}

export interface ScanStatusInfo {
	status: ScanStatusType;
	cache: ScanCacheData | null;
	gitHead: string | null;
	changedFilesCount: number;
	diffSummary?: string;
}

function runGit(cwd: string, command: string): string | null {
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

export function getScanCachePath(cwd: string): string {
	return join(cwd, ".pi", "scan-cache.json");
}

export function loadScanCache(cwd: string): ScanCacheData | null {
	const filePath = getScanCachePath(cwd);
	try {
		if (!existsSync(filePath)) return null;
		const content = readFileSync(filePath, "utf8");
		const data = JSON.parse(content);
		if (data && typeof data.repoSummary === "string" && data.repoSummary.trim().length > 0) {
			return data as ScanCacheData;
		}
		return null;
	} catch {
		return null;
	}
}

export function saveScanCache(cwd: string, data: ScanCacheData): void {
	const filePath = getScanCachePath(cwd);
	try {
		const dir = join(cwd, ".pi");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
	} catch {}
}

export function clearScanCache(cwd: string): boolean {
	const filePath = getScanCachePath(cwd);
	try {
		if (existsSync(filePath)) {
			rmSync(filePath, { force: true });
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

export function checkScanState(cwd: string): ScanStatusInfo {
	const gitHead = runGit(cwd, "rev-parse HEAD");
	const cache = loadScanCache(cwd);

	if (!gitHead) {
		if (cache) {
			return { status: "CACHED", cache, gitHead: "unknown", changedFilesCount: 0 };
		}
		return { status: "UNSCANNED", cache: null, gitHead: null, changedFilesCount: 0 };
	}

	if (!cache) {
		return { status: "UNSCANNED", cache: null, gitHead, changedFilesCount: 0 };
	}

	// 统计未提交修改
	const statusOut = runGit(cwd, "status --porcelain");
	const uncommittedCount = statusOut
		? statusOut.split("\n").filter((l) => l.trim().length > 0).length
		: 0;

	// 检查 HEAD 差异
	if (cache.gitHead !== gitHead) {
		const diffOut = runGit(cwd, `diff --name-only ${cache.gitHead} ${gitHead}`);
		const headDiffCount = diffOut
			? diffOut.split("\n").filter((l) => l.trim().length > 0).length
			: 0;
		const totalChanged = headDiffCount + uncommittedCount;

		// 变更文件数 >= 8 -> 架构已发生较大变化，判定为未扫描
		if (totalChanged >= 8) {
			return {
				status: "UNSCANNED",
				cache,
				gitHead,
				changedFilesCount: totalChanged,
			};
		}

		const diffStat = runGit(cwd, `diff --stat ${cache.gitHead} ${gitHead}`) || "";
		return {
			status: "DIRTY",
			cache,
			gitHead,
			changedFilesCount: totalChanged,
			diffSummary: diffStat.slice(0, 500),
		};
	}

	if (uncommittedCount > 0) {
		const diffStat = runGit(cwd, "diff --stat") || "";
		return {
			status: "DIRTY",
			cache,
			gitHead,
			changedFilesCount: uncommittedCount,
			diffSummary: diffStat.slice(0, 500),
		};
	}

	return {
		status: "CACHED",
		cache,
		gitHead,
		changedFilesCount: 0,
	};
}
