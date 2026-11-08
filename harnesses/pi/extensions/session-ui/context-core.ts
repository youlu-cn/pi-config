/**
 * Pure context-breakdown math and collection (no TUI).
 * Token formatting matches pi-cc-extensions dialog thresholds (k only, no M).
 */

import {
	type BuildSystemPromptOptions,
	type ExtensionCommandContext,
	type ToolInfo,
	estimateTokens,
	formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { type Color, rgbColor } from "@earendil-works/pi-tui";

export type ContextPart = {
	label: string;
	tokens: number;
	/** Fixed RGB — render with theme.style({ fg: color }). */
	color: Color;
};

export type PreviewKey =
	| "systemPrompt"
	| "memoryFiles"
	| "skills"
	| "tools"
	| "toolResults"
	| "contextFiles";

export type ContextBreakdown = {
	parts: ContextPart[];
	previews: Record<PreviewKey, string>;
};

const tokenEstimate = (value: unknown): number => {
	if (!value) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.max(0, Math.ceil(text.length / 4));
};

/** Only content + sections that enter the request body. Tool schemas are counted separately. */
function systemMessageTokens(message: {
	content?: unknown;
	sections?: Record<string, string | null> | null;
}): number {
	let chars = typeof message.content === "string" ? message.content.length : 0;
	for (const section of Object.values(message.sections ?? {})) {
		if (typeof section === "string") chars += section.length;
	}
	return Math.ceil(chars / 4);
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Count only chunks actually embedded in the system prompt. */
function embeddedTokens(prompt: string, chunk: string): number {
	if (!chunk || !prompt.includes(chunk)) return 0;
	return tokenEstimate(chunk);
}

export function capParts(parts: ContextPart[], target: number, fixedPrefix = 0): ContextPart[] {
	const fixed = parts.slice(0, fixedPrefix);
	const variable = parts.slice(fixedPrefix);
	const fixedTokens = fixed.reduce((sum, part) => sum + part.tokens, 0);
	const variableTarget = Math.max(0, target - fixedTokens);
	const estimated = variable.reduce((sum, part) => sum + part.tokens, 0);
	if (estimated <= variableTarget || estimated === 0) return parts;
	if (variableTarget === 0) {
		return [...fixed, ...variable.map((part) => ({ ...part, tokens: 0 }))];
	}

	let previous = 0;
	let cumulative = 0;
	const capped = variable.map((part, index) => {
		cumulative += part.tokens;
		const next =
			index === variable.length - 1
				? variableTarget
				: Math.round((cumulative / estimated) * variableTarget);
		const tokens = next - previous;
		previous = next;
		return { ...part, tokens };
	});
	return [...fixed, ...capped];
}

/** Dialog token labels: match cc (no M suffix). */
export function formatContextTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

export function resolveUsedTokens(
	usage: { tokens: number | null; percent: number | null } | undefined,
	estimated: number,
	contextWindow: number,
): number {
	const reported = usage?.tokens;
	const fromPercent =
		usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0
			? Math.round((usage.percent / 100) * contextWindow)
			: undefined;
	let resolved = reported ?? fromPercent ?? estimated;
	if (reported !== null && reported !== undefined && fromPercent !== undefined) {
		const tolerance = Math.max(32, Math.round(contextWindow * 0.001));
		if (Math.abs(reported - fromPercent) > tolerance) resolved = fromPercent;
	}
	if (estimated > 0 && resolved < estimated * 0.25) return estimated;
	return resolved;
}

function previewValue(value: unknown): string {
	if (typeof value === "string") return value;
	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function normalizePreviewText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Assemble counts and previews from systemPrompt, tools, and projected messages. */
export function collectContextBreakdown(
	ctx: Pick<ExtensionCommandContext, "sessionManager"> & {
		getSystemPromptOptions?: () => BuildSystemPromptOptions;
		getSystemPrompt?: () => string;
	},
	allTools: ToolInfo[],
): ContextBreakdown {
	const options = (ctx.getSystemPromptOptions?.() ?? {}) as BuildSystemPromptOptions;
	const selectedTools = new Set(options.selectedTools ?? ["read", "bash", "edit", "write"]);
	const toolDefinitionPreview: string[] = [];
	const toolResultPreview: string[] = [];
	const contextPreview: string[] = [];
	const systemPromptPreview: string[] = [];
	let toolDefinitionTokens = 0;
	let toolResultTokens = 0;
	let contextTokens = 0;
	let systemTokens = 0;

	const memoryPreview: string[] = [];
	const contextFiles = options.contextFiles ?? [];
	for (const file of contextFiles) {
		memoryPreview.push(`## ${file.path}\n\n${previewValue(file.content)}`);
	}

	const skills = options.skills ?? [];
	const skillsText = formatSkillsForPrompt(skills).trim();

	for (const tool of allTools) {
		if (!selectedTools.has(tool.name)) continue;
		const definition = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		toolDefinitionTokens += tokenEstimate(definition);
		toolDefinitionPreview.push(`## Definition: ${tool.name}\n\n${previewValue(definition)}`);
	}

	let memoryTokens = 0;
	let skillsTokens = 0;
	for (const projected of ctx.sessionManager.buildSessionProjection().entries) {
		const source = projected.sourceEntry;
		for (const message of projected.messages) {
			if (message.role === "system") {
				systemTokens += systemMessageTokens(message);
				const sections = (message.sections ?? {}) as Record<string, string | null>;
				const projectContext =
					typeof sections.project_context === "string"
						? normalizeLineEndings(sections.project_context)
						: "";
				for (const file of contextFiles) {
					const chunk = `<project_instructions path="${file.path}">\n${normalizeLineEndings(file.content)}\n</project_instructions>`;
					memoryTokens += embeddedTokens(projectContext, chunk);
					systemTokens -= embeddedTokens(projectContext, chunk);
				}
				const skillsSection =
					typeof sections.skills === "string" ? normalizeLineEndings(sections.skills) : "";
				skillsTokens += embeddedTokens(skillsSection, skillsText);
				systemTokens -= embeddedTokens(skillsSection, skillsText);
				systemPromptPreview.push(
					(source.type === "compaction"
						? "## System prompt snapshot at compaction\n\n"
						: "## System prompt update\n\n") +
						previewValue({
							content: message.content,
							sections: message.sections,
							toolsAdded: (message.toolsAdded ?? []).map((tool: { name?: string }) => tool?.name),
							toolsRemoved: (message.toolsRemoved ?? []).map(
								(tool: { name?: string }) => tool?.name,
							),
						}),
				);
			} else if (message.role === "assistant") {
				contextTokens += estimateTokens(message);
				for (const block of message.content) {
					if (block.type === "toolCall") {
						contextPreview.push(
							`## Assistant tool call: ${block.name}\n\n${previewValue(block.arguments)}`,
						);
					} else if (block.type === "text") {
						contextPreview.push(`## Assistant\n\n${block.text}`);
					} else if (block.type === "thinking") {
						contextPreview.push(`## Assistant thinking\n\n${block.thinking}`);
					}
				}
			} else if (message.role === "toolResult") {
				toolResultTokens += estimateTokens(message);
				toolResultPreview.push(
					`## Result: ${message.toolName}\n\n${previewValue(message.content)}`,
				);
			} else if (message.role === "bashExecution") {
				contextTokens += estimateTokens(message);
				contextPreview.push(
					`## Bash\n\nCommand:\n\n${previewValue(message.command)}\n\nOutput:\n\n${previewValue(message.output)}`,
				);
			} else if (message.role === "branchSummary" || message.role === "compactionSummary") {
				contextTokens += estimateTokens(message);
				contextPreview.push(`## ${message.role}\n\n${message.summary}`);
			} else {
				contextTokens += estimateTokens(message);
				contextPreview.push(`## ${message.role}\n\n${previewValue(message.content)}`);
			}
		}
	}

	systemTokens = Math.max(0, systemTokens);
	return {
		parts: [
			{ label: "System prompt", tokens: systemTokens, color: rgbColor(0x79, 0xc0, 0xff) },
			{ label: "Memory", tokens: memoryTokens, color: rgbColor(0xff, 0x7b, 0x72) },
			{ label: "Skills", tokens: skillsTokens, color: rgbColor(0xcb, 0x92, 0x14) },
			{
				label: "Tools definition",
				tokens: toolDefinitionTokens,
				color: rgbColor(0x37, 0xb3, 0x4a),
			},
			{ label: "Tool results", tokens: toolResultTokens, color: rgbColor(0xf7, 0x78, 0xba) },
			{ label: "Context", tokens: contextTokens, color: rgbColor(0xf0, 0x88, 0x3e) },
		] satisfies ContextPart[],
		previews: {
			systemPrompt:
				systemPromptPreview.join("\n\n") ||
				(typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "") ||
				"No system prompt.",
			memoryFiles: memoryPreview.join("\n\n") || "No memory files in context.",
			skills: skillsText || "No skills in context.",
			tools: toolDefinitionPreview.join("\n\n") || "No active tool definitions.",
			toolResults: toolResultPreview.join("\n\n") || "No tool results in the current context.",
			contextFiles: contextPreview.join("\n\n") || "No conversation context.",
		},
	};
}

export const OTHER_COLOR = rgbColor(0x92, 0x9e, 0xab);
export const FREE_COLOR = rgbColor(0x76, 0x84, 0x94);
