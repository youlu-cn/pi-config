import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RouterPhase } from "./config.ts";

const PLAN_SYSTEM_PROMPT = `
[SYSTEM DIRECTIVE: TOP-LEVEL ARCHITECTURAL PLANNING (PLAN MODE)]
你当前处于顶层架构规划模式 (PLAN)。
请基于上方提供的项目架构指纹摘要与用户意图，制定全局修改方案。
约束规则：
1. 直接输出精确到文件路径、函数签名和修改逻辑的 <task_spec>...</task_spec> 规范。
2. 严禁调用 write/edit 等文件修改工具，尽量在 1 轮回复内完成全局规划。
3. 你的输出将作为下游执行模型 (Z.ai) 的实施蓝图。
`.trim();

const EXECUTE_DIRECTIVE_PROMPT = `
[SYSTEM DIRECTIVE: IMPLEMENTATION & EXECUTION (EXECUTE MODE)]
你当前处于代码实施模式 (EXECUTE)。
请直接基于上方的项目全局架构指纹与已确认的任务蓝图 (Task Spec) 进行代码修改、文件编写及测试验证。
约束规则：
1. 项目架构已知，严禁重复进行全库盲目扫描。
2. 严格遵循 Task Spec 中的步骤与模块划分进行针对性修改。
`.trim();

/**
 * 为 Argon 规划阶段重组并折叠上下文（极简、无工具残留、强约束）
 */
export function collapseContextForPlan(
	messages: AgentMessage[],
	repoSummary: string,
	dirtyDiff?: string,
): AgentMessage[] {
	// 1. 过滤掉所有工具执行结果与中间 tool 消息
	const nonToolMessages = messages.filter((m: any) => {
		if (m.role === "tool" || m.role === "toolResult") return false;
		return true;
	});

	// 2. 提取最近最多 2 轮的用户与助手消息
	const userIndices: number[] = [];
	for (let i = 0; i < nonToolMessages.length; i++) {
		if ((nonToolMessages[i] as any)?.role === "user") {
			userIndices.push(i);
		}
	}

	const keepStartIndex =
		userIndices.length > 2 ? userIndices[userIndices.length - 2]! : 0;
	const recentMessages = nonToolMessages.slice(keepStartIndex);

	// 3. 构建浓缩架构摘要前置块
	const contextParts: string[] = [];
	if (repoSummary && repoSummary.trim().length > 0) {
		contextParts.push(`[PROJECT ARCHITECTURE SUMMARY]\n${repoSummary.trim()}`);
	}
	if (dirtyDiff && dirtyDiff.trim().length > 0) {
		contextParts.push(`[RECENT UNCOMMITTED CHANGES]\n${dirtyDiff.trim()}`);
	}

	const contextHeader = contextParts.join("\n\n");

	// 4. 将架构上下文注入第一条保留的 user 消息前面
	const collapsed: AgentMessage[] = [];

	if (contextHeader.length > 0) {
		collapsed.push({
			role: "user",
			content: `${contextHeader}\n\n请参考上述项目全局架构信息。`,
		} as any);
		collapsed.push({
			role: "assistant",
			content: "已收到项目架构摘要与当前变更状态，已进入顶层架构规划就绪模式。",
		} as any);
	}

	// 5. 追加最近消息，并在最后一条 user 消息注入 PLAN 模式指令
	for (let i = 0; i < recentMessages.length; i++) {
		const msg = recentMessages[i] as any;
		const isLast = i === recentMessages.length - 1;

		if (isLast && msg.role === "user") {
			const originalText = extractMessageText(msg);
			const augmentedContent = `${originalText}\n\n${PLAN_SYSTEM_PROMPT}`;
			collapsed.push({
				...msg,
				content: augmentedContent,
			});
		} else {
			collapsed.push(msg);
		}
	}

	return collapsed;
}

/**
 * 为 Z.ai 执行阶段优化上下文（携带架构指纹与 Task Spec，压缩冗余历史 tool outputs，避免重复扫库）
 */
export function collapseContextForExecute(
	messages: AgentMessage[],
	repoSummary: string,
	taskSpec?: string,
	dirtyDiff?: string,
): AgentMessage[] {
	// 构建前置指导块：项目架构 + 规划任务规范
	const contextParts: string[] = [];
	if (repoSummary && repoSummary.trim().length > 0) {
		contextParts.push(`[PROJECT ARCHITECTURE SUMMARY]\n${repoSummary.trim()}`);
	}
	if (taskSpec && taskSpec.trim().length > 0) {
		contextParts.push(`[ACTIVE TASK SPEC (ARCHITECTURAL BLUEPRINT)]\n${taskSpec.trim()}`);
	}
	if (dirtyDiff && dirtyDiff.trim().length > 0) {
		contextParts.push(`[RECENT UNCOMMITTED CHANGES]\n${dirtyDiff.trim()}`);
	}

	const contextHeader = contextParts.join("\n\n");

	// 压缩过早轮次的超大 toolResult，只保留最近 2 轮的真实工具结果
	const userIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if ((messages[i] as any)?.role === "user") {
			userIndices.push(i);
		}
	}
	const cutoffIndex =
		userIndices.length > 2 ? userIndices[userIndices.length - 2]! : 0;

	const pruned: AgentMessage[] = [];

	// 若有架构信息或任务规范，前置注入
	if (contextHeader.length > 0) {
		pruned.push({
			role: "user",
			content: `${contextHeader}\n\n请基于上述架构背景与任务规划执行。`,
		} as any);
		pruned.push({
			role: "assistant",
			content: "已同步项目架构指纹与 Task Spec 蓝图，准备进入针对性代码实施循环。",
		} as any);
	}

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as any;
		const isOlder = i < cutoffIndex;

		// 早期冗余工具输出折叠为摘要，减轻新模型 prefill 压力
		if (isOlder && msg.role === "toolResult") {
			const text = extractMessageText(msg);
			if (text.length > 400) {
				pruned.push({
					...msg,
					content: [
						{
							type: "text",
							text: `[Prior tool output omitted (${text.split("\n").length} lines) - refer to architecture summary]`,
						},
					],
				});
				continue;
			}
		}

		// 在最近一条 user 消息注入执行防重扫指令
		const isLast = i === messages.length - 1;
		if (isLast && msg.role === "user") {
			const originalText = extractMessageText(msg);
			pruned.push({
				...msg,
				content: `${originalText}\n\n${EXECUTE_DIRECTIVE_PROMPT}`,
			});
		} else {
			pruned.push(msg);
		}
	}

	return pruned;
}

/**
 * 通用跨阶段上下文蒸馏分流器
 */
export function distillContextForPhase(
	phase: RouterPhase,
	messages: AgentMessage[],
	repoSummary: string,
	taskSpec?: string,
	dirtyDiff?: string,
): AgentMessage[] {
	if (phase === "PLAN") {
		return collapseContextForPlan(messages, repoSummary, dirtyDiff);
	}
	if (phase === "EXECUTE") {
		return collapseContextForExecute(messages, repoSummary, taskSpec, dirtyDiff);
	}
	return messages;
}

// 兼容别名
export const collapseContextForArgon = collapseContextForPlan;

function extractMessageText(msg: any): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

/**
 * 从文本中提取 <repo_summary>...</repo_summary>
 */
export function extractRepoSummary(text: string): string | null {
	const match = /<repo_summary>([\s\S]*?)<\/repo_summary>/i.exec(text);
	return match?.[1] ? match[1].trim() : null;
}

/**
 * 从文本中提取 <task_spec>...</task_spec>
 */
export function extractTaskSpec(text: string): string | null {
	const match = /<task_spec>([\s\S]*?)<\/task_spec>/i.exec(text);
	return match?.[1] ? match[1].trim() : null;
}
