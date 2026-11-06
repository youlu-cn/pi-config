import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type RouterPhase = "SCOUT" | "PLAN" | "EXECUTE";

export interface ModelPoolConfig {
	scout: string;
	plan: string;
	executeFull: string;
	executeFlash: string;
}

export const DEFAULT_MODEL_POOL: ModelPoolConfig = {
	scout: "google/gemini-3.8-flash",
	plan: "google/gemini-4-argon",
	executeFull: "zai/glm-5.3",
	executeFlash: "zai/glm-5.3-flash",
};

export interface RouterState {
	autoEnabled: boolean;
	modelPool: ModelPoolConfig;
}

function resolveStatePath(overrideDir?: string): string {
	const dir = overrideDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
	return join(dir, "state", "auto-model-router.json");
}

export function loadRouterState(cwd: string, stateDir?: string): RouterState {
	let autoEnabled = true;
	let modelPool: ModelPoolConfig = { ...DEFAULT_MODEL_POOL };

	// 1. 全局配置
	const globalPath = resolveStatePath(stateDir);
	try {
		if (existsSync(globalPath)) {
			const parsed = JSON.parse(readFileSync(globalPath, "utf8"));
			if (typeof parsed.autoEnabled === "boolean") autoEnabled = parsed.autoEnabled;
			if (parsed.modelPool) modelPool = { ...modelPool, ...parsed.modelPool };
		}
	} catch {}

	// 2. 工作区局部配置 (.pi/model-router.json)
	const localPath = join(cwd, ".pi", "model-router.json");
	try {
		if (existsSync(localPath)) {
			const parsed = JSON.parse(readFileSync(localPath, "utf8"));
			if (typeof parsed.autoEnabled === "boolean") autoEnabled = parsed.autoEnabled;
			if (parsed.modelPool) modelPool = { ...modelPool, ...parsed.modelPool };
		}
	} catch {}

	return { autoEnabled, modelPool };
}

export function saveRouterState(state: RouterState, stateDir?: string): void {
	const globalPath = resolveStatePath(stateDir);
	try {
		mkdirSync(dirname(globalPath), { recursive: true });
		writeFileSync(globalPath, JSON.stringify(state, null, 2), "utf8");
	} catch {}
}

/**
 * 判断当前时间是否为北京时间 (UTC+8) 周一至周五 14:00 - 18:00
 */
export function isPeakHoursBeijing(date = new Date()): boolean {
	const utcMs = date.getTime() + date.getTimezoneOffset() * 60_000;
	const beijingDate = new Date(utcMs + 8 * 3600_000);

	const day = beijingDate.getDay(); // 0 是周日，1-5 是周一至周五
	const isWeekday = day >= 1 && day <= 5;
	const hour = beijingDate.getHours();

	return isWeekday && hour >= 14 && hour < 18;
}

/**
 * 获取当前 Z.ai 费率与时段状态
 */
export function getZaiPricingStatus(date = new Date()): {
	isPeak: boolean;
	label: string;
	rate: string;
} {
	const isPeak = isPeakHoursBeijing(date);
	return {
		isPeak,
		label: isPeak ? "Peak" : "Off-Peak",
		rate: isPeak ? "1x" : "0.5x",
	};
}
