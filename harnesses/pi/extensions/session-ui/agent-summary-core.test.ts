import test from "node:test";
import assert from "node:assert/strict";
import {
	AgentRunSummary,
	classifyTool,
	formatSummaryDuration,
	summarySegments,
} from "./agent-summary-core.ts";

test("classifyTool maps common tool families", () => {
	assert.equal(classifyTool("bash"), "bash");
	assert.equal(classifyTool("powershell"), "bash");
	assert.equal(classifyTool("read"), "read");
	assert.equal(classifyTool("edit"), "edit");
	assert.equal(classifyTool("write"), "write");
	assert.equal(classifyTool("mcp__x__y"), "other");
});

test("AgentRunSummary dedupes read/edit/write paths and counts failures", () => {
	const run = new AgentRunSummary(1_000);
	run.recordToolStart("bash", { command: "ls" });
	run.recordToolResult(false);
	run.recordToolStart("read", { path: "a.ts" });
	run.recordToolResult(false);
	run.recordToolStart("read", { file_path: "a.ts" });
	run.recordToolResult(true);
	run.recordToolStart("edit", { path: "b.ts" });
	run.recordToolResult(false);
	run.recordToolStart("write", { path: "c.ts" });
	run.recordToolResult(false);
	run.recordToolStart("grep", { pattern: "x" });
	run.recordToolResult(false);

	const snap = run.snapshot(16_000);
	assert.equal(snap.commands, 1);
	assert.equal(snap.reads, 1);
	assert.equal(snap.edits, 1);
	assert.equal(snap.writes, 1);
	assert.equal(snap.others, 1);
	assert.equal(snap.failed, 1);
	assert.equal(snap.durationMs, 15_000);

	const segments = summarySegments(snap);
	assert.ok(segments[0]!.text.startsWith("Ran"));
	assert.ok(segments.some((s) => s.text.includes("failed") && s.tone === "failed"));
	assert.equal(formatSummaryDuration(15_000), "15s");
});
