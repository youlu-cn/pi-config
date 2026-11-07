/**
 * Pure formatters for AskUserQuestion / Codemode / Subagent cards.
 *
 * Presentation ideas adapted from pi-cc-extensions (MIT), simplified for
 * session-ui (text lines only — no hover / fullscreen mouse layer).
 */

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const CODEMODE_TOOL_NAME = "codemode";
export const SUBAGENT_NOTIFICATION_TYPE = "subagent-notification";

const NO_ANSWER = "(no answer)";
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const COLLAPSED_CALL_LIMIT = 8;

export type AskUserAnswer = {
	questionIndex?: unknown;
	question?: unknown;
	kind?: unknown;
	answer?: unknown;
	selected?: unknown;
	notes?: unknown;
};

export type CodemodeNestedCall = {
	name?: unknown;
	args?: unknown;
	status?: unknown;
	durationMs?: unknown;
	error?: unknown;
};

type ThemeFg = { fg(color: string, text: string): string };

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function oneLine(value: unknown, max = 120): string {
	const raw = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

export function askUserAnswers(result: any): AskUserAnswer[] {
	const answers = result?.details?.answers;
	return Array.isArray(answers) ? answers : [];
}

export function askUserAnswerText(answer: AskUserAnswer): string {
	if (answer?.kind === "multi") {
		const selected = Array.isArray(answer.selected)
			? answer.selected.map(text).filter(Boolean)
			: [];
		return selected.length > 0 ? selected.join(", ") : NO_ANSWER;
	}
	return text(answer?.answer) || NO_ANSWER;
}

function orderedAnswers(result: any): AskUserAnswer[] {
	return askUserAnswers(result)
		.map((answer, index) => ({ answer, index }))
		.sort((left, right) => {
			const leftIndex = Number(left.answer.questionIndex);
			const rightIndex = Number(right.answer.questionIndex);
			const leftMissing = !Number.isFinite(leftIndex);
			const rightMissing = !Number.isFinite(rightIndex);
			if (leftMissing || rightMissing) {
				if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
				return left.index - right.index;
			}
			return leftIndex - rightIndex;
		})
		.map((entry) => entry.answer);
}

export function askUserQuestionCount(result: any, args?: any): number | undefined {
	const answered = askUserAnswers(result).length;
	if (answered > 0) return answered;
	const questions = Array.isArray(args?.questions) ? args.questions.length : 0;
	return questions > 0 ? questions : undefined;
}

/** Collapsed Q&A tree + expanded body for ask_user_question. */
export function formatAskUserQuestionResult(
	result: any,
	theme: ThemeFg,
	expanded: boolean,
	pad: string,
	expandHint: string,
	isError = false,
): string {
	const answers = orderedAnswers(result);
	if (expanded) {
		const parts = answers.map((answer) => {
			const lines = [text(answer?.question) || "Question", `  ${askUserAnswerText(answer)}`];
			const notes = text(answer?.notes);
			if (notes) lines.push(`  notes: ${oneLine(notes, 4_000)}`);
			return lines.join("\n");
		});
		const globalNote = text(result?.details?.globalNote);
		if (globalNote) parts.push(`Note: ${oneLine(globalNote, 4_000)}`);
		if (parts.length === 0 && result?.details?.cancelled === true) {
			return `${pad}  ${theme.fg("dim", "└ Declined")}`;
		}
		const body = parts.length > 0 ? parts.join("\n\n") : "Done";
		return [
			`${pad}  ${theme.fg("dim", `└ (${expandHint})`)}`,
			...body.split("\n").map((line) => `${pad}      ${theme.fg("toolOutput", line)}`),
		].join("\n");
	}

	if (answers.length === 0) {
		const label = result?.details?.cancelled === true ? "Declined" : "Done";
		return `${pad}  ${theme.fg("dim", `└ ${label} (${expandHint})`)}`;
	}

	const lines = answers.map((answer, index) => {
		const branch = index === answers.length - 1 ? "└" : "├";
		const question = text(answer?.question) || "Question";
		const answerText = askUserAnswerText(answer);
		return `${pad}  ${theme.fg("dim", branch)} ${theme.fg("muted", oneLine(question, 40))}${theme.fg("dim", " → ")}${theme.fg(isError ? "error" : "success", oneLine(answerText, 48))}`;
	});
	lines.push(
		`${pad}  ${theme.fg("dim", "·")} ${theme.fg("muted", `${answers.length} answered`)} ${theme.fg("dim", `(${expandHint})`)}`,
	);
	return lines.join("\n");
}

export function codemodeCalls(result: any): CodemodeNestedCall[] {
	const calls = result?.details?.calls;
	return Array.isArray(calls) ? calls : [];
}

export function codemodeOutputText(result: any): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	const blocks = content
		.filter((item: any) => item?.type === "text")
		.map((item: any) => String(item?.text ?? ""));
	if (blocks.length > 0 && SCRIPT_HEADER.test(blocks[0]!)) blocks.shift();
	return blocks.join("\n").trim();
}

export function codemodeOutputLineCount(result: any): number {
	const body = codemodeOutputText(result).replace(/\n+$/, "");
	return body ? body.split("\n").length : 0;
}

export function codemodeSummaryParts(
	calls: readonly CodemodeNestedCall[],
	outputLines: number,
	running: boolean,
): string[] {
	const total = calls.length;
	const failed = calls.filter((call) => call?.status === "error").length;
	const runningCount = calls.filter((call) => !call?.status || call?.status === "running").length;
	const parts: string[] = [];
	if (running) {
		if (runningCount) {
			parts.push(`${runningCount} ${runningCount === 1 ? "call" : "calls"} running`);
		}
		const done = total - runningCount;
		if (done) parts.push(`${done} done`);
		if (failed) parts.push(`${failed} failed`);
		return parts.length ? parts : ["running…"];
	}
	if (total) parts.push(`${total} ${total === 1 ? "call" : "calls"}`);
	if (failed) parts.push(`${failed} failed`);
	if (outputLines) parts.push(`${outputLines} ${outputLines === 1 ? "line" : "lines"} output`);
	return parts.length ? parts : ["Done"];
}

function callStatusIcon(status: unknown, theme: ThemeFg): string {
	switch (status) {
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
		default:
			return theme.fg("accent", "●");
	}
}

function formatCallDuration(ms: unknown): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Collapsed nested-call tree + expanded body for codemode. */
export function formatCodemodeResult(
	result: any,
	theme: ThemeFg,
	expanded: boolean,
	pad: string,
	expandHint: string,
	isError = false,
	running = false,
	code?: unknown,
): string {
	const calls = codemodeCalls(result);
	const outputLines = codemodeOutputLineCount(result);

	if (expanded) {
		const parts: string[] = [];
		if (calls.length > 0) {
			parts.push(
				calls
					.map((call) => {
						const name = String(call?.name ?? "tool");
						const raw = typeof call?.args === "string" ? call.args : "";
						const dur = formatCallDuration(call?.durationMs);
						const head = [name, raw, dur].filter(Boolean).join(" ");
						const error =
							typeof call?.error === "string" && call.error
								? `\n    ${call.error.split("\n").join("\n    ")}`
								: "";
						return `${head}${error}`;
					})
					.join("\n"),
			);
		}
		const output = codemodeOutputText(result);
		if (output) parts.push(output);
		if (typeof result?.details?.outputPath === "string" && result.details.outputPath) {
			parts.push(`output: ${result.details.outputPath}`);
		}
		const body = parts.length > 0 ? parts.join("\n\n") : "Done";
		return [
			`${pad}  ${theme.fg("dim", `└ (${expandHint})`)}`,
			...body.split("\n").map((line) => `${pad}      ${theme.fg("toolOutput", line)}`),
		].join("\n");
	}

	const lines: string[] = [];
	const shown = calls.slice(-COLLAPSED_CALL_LIMIT);
	if (shown.length === 0 && typeof code === "string" && code.trim()) {
		const statement = code
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
		if (statement) {
			lines.push(
				`${pad}  ${theme.fg("dim", "│")} ${theme.fg("muted", oneLine(statement, 80))}`,
			);
		}
	}
	if (shown.length < calls.length) {
		const hidden = calls.length - shown.length;
		lines.push(
			`${pad}  ${theme.fg("dim", "├")} ${theme.fg("dim", `… ${hidden} earlier ${hidden === 1 ? "call" : "calls"}`)}`,
		);
	}
	for (let i = 0; i < shown.length; i++) {
		const call = shown[i]!;
		const name = String(call?.name ?? "tool");
		const raw = typeof call?.args === "string" ? oneLine(call.args, 60) : "";
		const dur = formatCallDuration(call?.durationMs);
		const meta = dur ? theme.fg("dim", ` ${dur}`) : "";
		lines.push(
			`${pad}  ${theme.fg("dim", "├")} ${callStatusIcon(call?.status, theme)} ${theme.fg("toolTitle", name)}${raw ? theme.fg("muted", ` ${raw}`) : ""}${meta}`,
		);
	}

	const summary = codemodeSummaryParts(calls, outputLines, running).join(" · ");
	const prefix = lines.length > 0 ? "└" : "└";
	lines.push(
		`${pad}  ${theme.fg("dim", prefix)} ${theme.fg(isError ? "error" : "muted", summary)}${running ? "" : theme.fg("dim", ` (${expandHint})`)}`,
	);
	return lines.join("\n");
}

export type FinishedSubagent = {
	id: string;
	description: string;
	status: string;
	failed: boolean;
	stats: string[];
	resultPreview: string;
	error: string;
	outputFile: string;
};

function measured(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export function isFailedSubagentStatus(status: string): boolean {
	return status === "error" || status === "aborted";
}

export function measuredStats(details: Record<string, unknown>): string[] {
	const stats: string[] = [];
	const turns = measured(details.turnCount);
	if (turns) stats.push(plural(turns, "turn"));
	const toolUses = measured(details.toolUses);
	if (toolUses) stats.push(plural(toolUses, "tool use"));
	const tokens = measured(details.totalTokens) ?? measured(details.tokens);
	if (tokens) {
		stats.push(
			tokens < 1000
				? `${tokens} tokens`
				: tokens < 1_000_000
					? `${(tokens / 1000).toFixed(1)}k tokens`
					: `${(tokens / 1_000_000).toFixed(1)}M tokens`,
		);
	}
	const duration = measured(details.durationMs);
	if (duration) {
		stats.push(duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`);
	}
	return stats;
}

function toFinishedSubagent(details: Record<string, unknown>): FinishedSubagent {
	const status = text(details.status);
	const error = text(details.error);
	return {
		id: text(details.id),
		description: text(details.description),
		status,
		failed: status ? isFailedSubagentStatus(status) : Boolean(error),
		stats: measuredStats(details),
		resultPreview: text(details.resultPreview),
		error,
		outputFile: text(details.outputFile),
	};
}

export function finishedSubagents(details: unknown): FinishedSubagent[] {
	const first =
		typeof details === "object" && details !== null && !Array.isArray(details)
			? (details as Record<string, unknown>)
			: {};
	const others = Array.isArray(first.others)
		? first.others.filter(
				(item): item is Record<string, unknown> =>
					typeof item === "object" && item !== null && !Array.isArray(item),
			)
		: [];
	return [first, ...others].map(toFinishedSubagent);
}

function outcomeText(status: string): string {
	return status === "steered" ? "completed (steered)" : status;
}

function statusIcon(subagent: FinishedSubagent, theme: ThemeFg): string {
	if (subagent.failed) return theme.fg("error", "✗");
	if (subagent.status === "stopped") return theme.fg("warning", "⚠");
	return theme.fg("success", "✓");
}

/** Collapsed / expanded text for subagent-notification custom messages. */
export function formatSubagentNotification(
	details: unknown,
	theme: ThemeFg,
	expanded: boolean,
	pad: string,
	expandHint: string,
): string {
	const agents = finishedSubagents(details).filter(
		(agent) =>
			agent.id ||
			agent.description ||
			agent.status ||
			agent.resultPreview ||
			agent.error ||
			agent.outputFile ||
			agent.stats.length > 0,
	);
	if (agents.length === 0) return "";
	if (!expanded) {
		return agents
			.map((agent, index) => {
				const title = agent.id
					? `${theme.fg("toolTitle", "Subagent Finished")} ${theme.fg("muted", agent.id)}`
					: theme.fg("toolTitle", "Subagent Finished");
				const outcome =
					agent.status && agent.status !== "completed"
						? ` ${theme.fg("dim", "·")} ${theme.fg(agent.failed ? "error" : "warning", outcomeText(agent.status))}`
						: "";
				const stats = agent.stats.map((stat) => ` ${theme.fg("dim", "·")} ${theme.fg("dim", stat)}`).join("");
				const hint =
					index === agents.length - 1 ? theme.fg("dim", ` · (${expandHint})`) : "";
				return `${pad}${statusIcon(agent, theme)} ${title}${outcome}${stats}${hint}`;
			})
			.join("\n");
	}

	const blocks = agents.map((agent) => {
		const lines: string[] = [
			`${pad}${statusIcon(agent, theme)} ${theme.fg("toolTitle", "Subagent Finished")}${agent.id ? ` ${theme.fg("muted", agent.id)}` : ""}`,
		];
		if (agent.description) {
			lines.push(`${pad}  ${theme.fg("accent", "Description")}`);
			lines.push(`${pad}    ${theme.fg("text", agent.description)}`);
		}
		if (agent.status) {
			lines.push(`${pad}  ${theme.fg("accent", "Status")}`);
			lines.push(
				`${pad}    ${theme.fg(agent.failed ? "error" : "muted", outcomeText(agent.status))}`,
			);
			if (agent.stats.length) {
				lines.push(`${pad}    ${theme.fg("dim", agent.stats.join(" · "))}`);
			}
		}
		if (agent.resultPreview) {
			lines.push(`${pad}  ${theme.fg("accent", "Saved result preview")}`);
			for (const row of agent.resultPreview.split("\n").slice(0, 40)) {
				lines.push(`${pad}    ${theme.fg("toolOutput", row)}`);
			}
		}
		if (agent.error) {
			lines.push(`${pad}  ${theme.fg("accent", "Error")}`);
			lines.push(`${pad}    ${theme.fg("error", agent.error)}`);
		}
		if (agent.outputFile) {
			lines.push(`${pad}  ${theme.fg("accent", "Transcript")}`);
			lines.push(`${pad}    ${theme.fg("dim", agent.outputFile)}`);
		}
		return lines.join("\n");
	});
	return blocks.join("\n\n");
}
