import { execSync } from "node:child_process";
import type { ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../config.ts";
import { saveScanCache, type ScanCacheData } from "../scan-cache.ts";

function findScoutModel(ctx: ExtensionContext, customSpec?: string): Model<any> | undefined {
	const spec = customSpec || DEFAULT_CONFIG.scoutModel;
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
	return (
		all.find((m) => m.id.toLowerCase().includes("flash")) ||
		all.find((m) => m.id.toLowerCase().includes("3.8")) ||
		ctx.model
	);
}

function runGitCmd(cwd: string, command: string): string | null {
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

export function extractRepoSummary(text: string): string {
	const match = /<repo_summary>([\s\S]*?)<\/repo_summary>/i.exec(text);
	return match?.[1] ? match[1].trim() : text.trim().slice(0, 4000);
}

export interface ScoutParams {
	forceRefresh?: boolean;
	focusPaths?: string[];
}

export async function runScoutTask(
	params: ScoutParams,
	ctx: ExtensionContext,
): Promise<{ success: boolean; repoSummary: string; gitHead: string; error?: string }> {
	const gitHead = runGitCmd(ctx.cwd, "rev-parse HEAD") || "unknown";
	const scoutModel = findScoutModel(ctx);

	// 1. 尝试使用 subagent CLI 启动只读独立子会话进行深探
	try {
		const modelFlag = scoutModel ? `--model ${scoutModel.id} --provider ${scoutModel.provider}` : "";
		const prompt =
			"请执行代码库全量侦察：使用 read、grep、find 查看目录结构、模块入口及配置，总结核心架构（技术栈、顶层目录职责、核心接口、关键数据流），并在最后用 <repo_summary>...</repo_summary> 包裹在 2000 Tokens 以内的浓缩摘要。";

		const spawnCmd = `subagent spawn --name "scout-recon" ${modelFlag} --tools read,grep,find,ls --cwd "${ctx.cwd}" --prompt "${prompt.replace(/"/g, '\\"')}"`;
		const spawnOut = execSync(spawnCmd, { encoding: "utf8", timeout: 5000 }).trim();

		const handleMatch = /([a-z0-9]{6,12})/i.exec(spawnOut);
		if (handleMatch?.[1]) {
			const handle = handleMatch[1];
			// 等待子 Agent 执行完毕（最多 60 秒）
			const waitOut = execSync(`subagent wait ${handle} --timeout 60`, {
				encoding: "utf8",
				timeout: 65000,
			});
			execSync(`subagent stop ${handle}`, { stdio: "ignore" });

			const summary = extractRepoSummary(waitOut);
			if (summary.length > 20) {
				const cacheData: ScanCacheData = {
					gitHead,
					timestamp: Date.now(),
					repoSummary: summary,
				};
				saveScanCache(ctx.cwd, cacheData);
				return { success: true, repoSummary: summary, gitHead };
			}
		}
	} catch {
		// 子 Agent 调度失败时退回使用内置轻量调用
	}

	// 2. 回退机制：收集关键文件清单与 git 概况，直接通过 Flash 模型提取架构摘要
	try {
		const gitFiles = runGitCmd(ctx.cwd, "ls-files")?.split("\n").slice(0, 100).join("\n") || "";
		const gitStatus = runGitCmd(ctx.cwd, "status --short") || "";
		const rootPkg = runGitCmd(ctx.cwd, "show HEAD:package.json") || "";

		const prompt = `
请分析以下项目文件树与入口配置，生成 2000 Tokens 以内的精炼架构摘要，必须用 <repo_summary>...</repo_summary> 标签包裹：
[PROJECT ROOT FILES]
${gitFiles.slice(0, 3000)}

[GIT STATUS]
${gitStatus.slice(0, 1000)}

[PACKAGE / CONFIG]
${rootPkg.slice(0, 1500)}
`.trim();

		const targetModel = scoutModel || ctx.model;
		if (!targetModel) {
			throw new Error("No model available for scout execution.");
		}

		const messages: any[] = [
			{ role: "system", content: "你是一个专业的全库架构侦察模型 (Scout)。严禁修改代码，直接输出架构指纹。" },
			{ role: "user", content: prompt },
		];

		const res = await ctx.modelRegistry.complete(targetModel, { messages } as any);
		let outText = "";
		if (typeof res.content === "string") outText = res.content;
		else if (Array.isArray(res.content)) {
			outText = res.content
				.filter((c: any) => c && c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
		}

		const summary = extractRepoSummary(outText);
		const cacheData: ScanCacheData = {
			gitHead,
			timestamp: Date.now(),
			repoSummary: summary,
		};
		saveScanCache(ctx.cwd, cacheData);
		return { success: true, repoSummary: summary, gitHead };
	} catch (err) {
		return {
			success: false,
			repoSummary: "",
			gitHead,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
