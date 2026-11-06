export interface ModelConfig {
	scoutModel: string;
	architectModel: string;
	executeFullModel: string;
	executeFlashModel: string;
}

export const DEFAULT_CONFIG: ModelConfig = {
	scoutModel: "google/gemini-3.8-flash",
	architectModel: "google/gemini-4-argon",
	executeFullModel: "zai/glm-5.3",
	executeFlashModel: "zai/glm-5.3-flash",
};

/**
 * 判断当前时间是否为北京时间 (UTC+8) 工作日 14:00 - 18:00 (Z.ai 高峰期 1x 计费)
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
 * 获取当前 Z.ai 计费时段状态
 */
export function getZaiPricingRate(date = new Date()): string {
	return isPeakHoursBeijing(date) ? "1.0x" : "0.5x";
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
