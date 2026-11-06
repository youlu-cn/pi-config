import type { ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, isHighCostModel } from "../config.ts";
import { loadScanCache } from "../scan-cache.ts";

function findArgonModel(ctx: ExtensionContext, customSpec?: string): Model<any> | undefined {
	const spec = customSpec || DEFAULT_CONFIG.architectModel;
	const parts = spec.split("/");
	if (parts.length === 2) {
		const [provider, id] = parts;
		const m = ctx.modelRegistry.find(provider!, id!);
		if (m) return m;
		if (provider === "google") {
			const ag = ctx.modelRegistry.find("antigravity", id!);
			if (ag) return ag;
		}
		if (provider === "antigravity") {
			const g = ctx.modelRegistry.find("google", id!);
			if (g) return g;
		}
	}

	const all = ctx.modelRegistry.getAll();
	return all.find((m) => m.id.toLowerCase().includes("argon")) || all.find((m) => isHighCostModel(m.id));
}

export function extractTaskSpec(text: string): string {
	const match = /<task_spec>([\s\S]*?)<\/task_spec>/i.exec(text);
	return match?.[1] ? match[1].trim() : text.trim();
}

export interface ArchitectParams {
	task: string;
	codeSnippets?: string;
}

export async function runArchitectTask(
	params: ArchitectParams,
	ctx: ExtensionContext,
	customModelSpec?: string,
): Promise<{ success: boolean; taskSpec: string; modelUsed: string; error?: string }> {
	const argonModel = findArgonModel(ctx, customModelSpec);
	const targetModel = argonModel || ctx.model;

	if (!targetModel) {
		return {
			success: false,
			taskSpec: "",
			modelUsed: "none",
			error: "No available model found for architectural planning.",
		};
	}

	const scan = loadScanCache(ctx.cwd);
	const repoSummary = scan?.repoSummary || "Project summary not available yet.";

	// 拼装严格控制在 5K Tokens 范围内的纯净单轮上下文
	const promptSections: string[] = [
		"[PROJECT ARCHITECTURE SUMMARY]",
		repoSummary,
		"",
	];

	if (params.codeSnippets && params.codeSnippets.trim().length > 0) {
		promptSections.push("[KEY CODE SLICES & RECENT CHANGES]");
		promptSections.push(params.codeSnippets.trim().slice(0, 8000));
		promptSections.push("");
	}

	promptSections.push("[TASK OBJECTIVE & REQUIREMENTS]");
	promptSections.push(params.task.trim());
	promptSections.push("");
	promptSections.push(
		"请作为顶层架构师，输出精确到【修改文件相对路径】、【函数签名变化】与【执行步骤】的技术实施方案，并用 <task_spec>...</task_spec> 标签包裹。",
	);

	const promptContent = promptSections.join("\n");

	try {
		const messages: any[] = [
			{
				role: "system",
				content:
					"你处于独立物理隔离的架构规划单轮会话中 (Architect)。严禁调用任何代码编写工具，直接输出高保真技术规格书。",
			},
			{
				role: "user",
				content: promptContent,
			},
		];

		const response = await ctx.modelRegistry.complete(targetModel, { messages } as any);
		let responseText = "";
		if (typeof response.content === "string") {
			responseText = response.content;
		} else if (Array.isArray(response.content)) {
			responseText = response.content
				.filter((c: any) => c && c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
		}

		const taskSpec = extractTaskSpec(responseText);
		return {
			success: true,
			taskSpec,
			modelUsed: `${targetModel.provider}/${targetModel.id}`,
		};
	} catch (error) {
		return {
			success: false,
			taskSpec: "",
			modelUsed: `${targetModel.provider}/${targetModel.id}`,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
