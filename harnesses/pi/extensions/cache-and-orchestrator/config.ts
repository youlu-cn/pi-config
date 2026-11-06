import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface TimeScheduleRule {
	name?: string;
	days?: number[]; // [1, 2, 3, 4, 5] 表示周一至周五；省略表示每天 0-6
	start: string;   // 本机时间 "HH:mm"，如 "14:00"
	end: string;     // 本机时间 "HH:mm"，如 "18:00"
	model: string;   // 命中的目标模型标识，如 "zai/glm-5.3-flash"
	rate?: string;   // 状态栏费率/时段展示标记，如 "1.0x"
}

export interface OrchestratorConfig {
	scoutModel: string;
	architectModel: string;
	defaultExecuteModel: string;
	defaultRate: string;
	schedules: TimeScheduleRule[];
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
	scoutModel: "google/gemini-3.8-flash",
	architectModel: "google/gemini-4-argon",
	defaultExecuteModel: "zai/glm-5.3",
	defaultRate: "0.5x",
	schedules: [
		{
			name: "peak-hours",
			days: [1, 2, 3, 4, 5],
			start: "14:00",
			end: "18:00",
			model: "zai/glm-5.3-flash",
			rate: "1.0x",
		},
	],
};

function resolveGlobalConfigPath(overrideDir?: string): string {
	const dir = overrideDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
	return join(dir, "state", "cache-and-orchestrator.json");
}

/**
 * 解析 "HH:mm" 为当天自 00:00 起的分钟数 (0..1439)
 */
export function parseTimeToMinutes(timeStr: string): number | undefined {
	const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
	if (!match) return undefined;
	const h = parseInt(match[1]!, 10);
	const m = parseInt(match[2]!, 10);
	if (h < 0 || h > 23 || m < 0 || m > 59) return undefined;
	return h * 60 + m;
}

/**
 * 依据本机时间 (Local Time) 匹配当前生效的时间段规则
 */
export function matchScheduleRule(
	rules: TimeScheduleRule[],
	localDate = new Date(),
): TimeScheduleRule | undefined {
	const currentDay = localDate.getDay(); // 0(周日) .. 6(周六)
	const currentMinutes = localDate.getHours() * 60 + localDate.getMinutes();

	for (const rule of rules) {
		// 1. 检查星期
		if (Array.isArray(rule.days) && rule.days.length > 0) {
			if (!rule.days.includes(currentDay)) {
				continue;
			}
		}

		// 2. 检查时间区间 [start, end)
		const startMin = parseTimeToMinutes(rule.start);
		const endMin = parseTimeToMinutes(rule.end);
		if (startMin === undefined || endMin === undefined) continue;

		if (startMin <= endMin) {
			// 常规区间，如 14:00 - 18:00
			if (currentMinutes >= startMin && currentMinutes < endMin) {
				return rule;
			}
		} else {
			// 跨天区间，如 22:00 - 06:00
			if (currentMinutes >= startMin || currentMinutes < endMin) {
				return rule;
			}
		}
	}

	return undefined;
}

/**
 * 根据配置和当前本机时间，得出初选的主模型与费率信息
 */
export function getScheduledModelSelection(
	config: OrchestratorConfig,
	localDate = new Date(),
): { model: string; rate: string; ruleName?: string } {
	const matched = matchScheduleRule(config.schedules, localDate);
	if (matched) {
		return {
			model: matched.model,
			rate: matched.rate || "1.0x",
			ruleName: matched.name,
		};
	}
	return {
		model: config.defaultExecuteModel,
		rate: config.defaultRate,
	};
}

/**
 * 加载多级配置（工作区 .pi/orchestrator.json > 全局 state/cache-and-orchestrator.json > DEFAULT_CONFIG）
 */
export function loadOrchestratorConfig(cwd: string, overrideStateDir?: string): OrchestratorConfig {
	let config: OrchestratorConfig = {
		...DEFAULT_CONFIG,
		schedules: [...DEFAULT_CONFIG.schedules],
	};

	// 1. 全局配置
	const globalPath = resolveGlobalConfigPath(overrideStateDir);
	try {
		if (existsSync(globalPath)) {
			const parsed = JSON.parse(readFileSync(globalPath, "utf8"));
			config = mergeConfig(config, parsed);
		}
	} catch {}

	// 2. 工作区局部配置 (.pi/orchestrator.json)
	const localPath = join(cwd, ".pi", "orchestrator.json");
	try {
		if (existsSync(localPath)) {
			const parsed = JSON.parse(readFileSync(localPath, "utf8"));
			config = mergeConfig(config, parsed);
		}
	} catch {}

	return config;
}

export function saveOrchestratorConfig(config: OrchestratorConfig, overrideStateDir?: string): void {
	const globalPath = resolveGlobalConfigPath(overrideStateDir);
	try {
		mkdirSync(dirname(globalPath), { recursive: true });
		writeFileSync(globalPath, JSON.stringify(config, null, 2), "utf8");
	} catch {}
}

function mergeConfig(base: OrchestratorConfig, incoming: any): OrchestratorConfig {
	if (!incoming || typeof incoming !== "object") return base;
	return {
		scoutModel: incoming.scoutModel || incoming.models?.scout || base.scoutModel,
		architectModel: incoming.architectModel || incoming.models?.architect || base.architectModel,
		defaultExecuteModel:
			incoming.defaultExecuteModel ||
			incoming.models?.defaultExecute ||
			incoming.executeFullModel ||
			base.defaultExecuteModel,
		defaultRate: incoming.defaultRate || base.defaultRate,
		schedules: Array.isArray(incoming.schedules) ? incoming.schedules : base.schedules,
	};
}

/**
 * 判断模型是否属于昂贵的高成本模型（如 Argon, Opus 等，需要脱水保护）
 */
export function isHighCostModel(modelId?: string): boolean {
	if (!modelId) return false;
	const lower = modelId.toLowerCase();
	return (
		lower.includes("argon") ||
		lower.includes("opus") ||
		lower.includes("gemini-4") ||
		lower.includes("o1") ||
		lower.includes("o3")
	);
}
