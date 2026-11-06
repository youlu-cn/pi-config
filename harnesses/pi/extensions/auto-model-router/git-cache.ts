import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ScanState = "UNSCANNED" | "INCREMENTAL_DIRTY" | "SCANNED";

export interface ScanCacheData {
	gitHead: string;
	timestamp: number;
	repoSummary: string;
	scannedFiles: string[];
}

export interface ScanStatusResult {
	state: ScanState;
	cache: ScanCacheData | null;
	gitHead: string | null;
	dirtyCount: number;
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

/**
 * 依据 Git 树与 .pi/scan-cache.json 判断当前项目扫描状态
 */
export function checkScanState(cwd: string): ScanStatusResult {
	const gitHead = runGit(cwd, "rev-parse HEAD");
	const cache = loadScanCache(cwd);

	// 未获取到 gitHead（可能不是 git 仓库），退化处理
	if (!gitHead) {
		if (cache) {
			return { state: "SCANNED", cache, gitHead: "unknown", dirtyCount: 0 };
		}
		return { state: "UNSCANNED", cache: null, gitHead: null, dirtyCount: 0 };
	}

	// 1. 本地无缓存或者概要为空 -> UNSCANNED
	if (!cache) {
		return { state: "UNSCANNED", cache: null, gitHead, dirtyCount: 0 };
	}

	// 2. 检查本地是否有未提交的变更
	const statusOut = runGit(cwd, "status --porcelain");
	const uncommittedFiles = statusOut
		? statusOut
				.split("\n")
				.map((l) => l.trim().slice(3).trim())
				.filter(Boolean)
		: [];
	const uncommittedCount = uncommittedFiles.length;

	// 3. 检查 HEAD 是否与缓存一致
	if (cache.gitHead !== gitHead) {
		const diffFilesOut = runGit(cwd, `diff --name-only ${cache.gitHead} ${gitHead}`);
		const headChangedCount = diffFilesOut
			? diffFilesOut.split("\n").filter(Boolean).length
			: 0;
		const totalChanged = headChangedCount + uncommittedCount;

		// 变更文件数 >= 8 -> 架构已发生较大变化，判定为 UNSCANNED
		if (totalChanged >= 8) {
			return {
				state: "UNSCANNED",
				cache,
				gitHead,
				dirtyCount: totalChanged,
			};
		}

		// 变更文件在 1 ~ 7 个之间 -> INCREMENTAL_DIRTY
		const diffStat = runGit(cwd, `diff --stat ${cache.gitHead} ${gitHead}`) || "";
		return {
			state: "INCREMENTAL_DIRTY",
			cache,
			gitHead,
			dirtyCount: totalChanged,
			diffSummary: diffStat.slice(0, 500),
		};
	}

	// HEAD 一致的情况下检查本地脏文件
	if (uncommittedCount > 0) {
		const diffStat = runGit(cwd, "diff --stat") || "";
		return {
			state: "INCREMENTAL_DIRTY",
			cache,
			gitHead,
			dirtyCount: uncommittedCount,
			diffSummary: diffStat.slice(0, 500),
		};
	}

	// 缓存命中且无脏状态
	return {
		state: "SCANNED",
		cache,
		gitHead,
		dirtyCount: 0,
	};
}
