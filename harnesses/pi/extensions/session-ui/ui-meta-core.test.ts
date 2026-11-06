import assert from "node:assert/strict";
import test from "node:test";
import {
	extractUiMetaRecords,
	sanitizeUiMetaText,
	stripUiMetaBlocks,
	UI_META_SENTINEL,
	type UiMetaLimits,
} from "./ui-meta-core.ts";

const limits: UiMetaLimits = {
	title: 12,
	sessionName: 16,
};

const meta = (record: object) => `${UI_META_SENTINEL}${JSON.stringify(record)}`;

test("extracts title and naming records from the first non-empty line only", () => {
	const record = {
		v: 1,
		kind: "turn_start",
		title: "Meta design",
		session: { action: "set", name: "Session titles" },
	};
	assert.deepEqual(extractUiMetaRecords(`\n${meta(record)}\nnormal response`, limits), [record]);
	assert.deepEqual(extractUiMetaRecords(`normal response\n${meta(record)}`, limits), []);
	assert.deepEqual(extractUiMetaRecords("", limits), []);
	assert.deepEqual(extractUiMetaRecords("  \n", limits), []);
});

test("ignores unsupported end metadata", () => {
	const record = meta({ v: 1, kind: "turn_end", recap: "Unused" });
	assert.deepEqual(extractUiMetaRecords(record, limits), []);
	assert.deepEqual(extractUiMetaRecords(`Normal response\n${record}`, limits), []);
});

test("ignores task fields and accepts independent title proposals", () => {
	assert.deepEqual(extractUiMetaRecords(meta({
		v: 1, kind: "turn_start", task: { action: "set", name: "Ignored" },
	}), limits), []);
	assert.deepEqual(extractUiMetaRecords(meta({
		v: 1, kind: "turn_start", title: "Inspect", task: { action: "set", name: "Ignored" },
	}), limits), [{ v: 1, kind: "turn_start", title: "Inspect" }]);
});

test("accepts keep and ignores malformed or unsupported records", () => {
	const text = [
		meta({ v: 1, kind: "turn_start", session: { action: "keep" } }),
		meta({ v: 2, kind: "turn_start", title: "wrong version" }),
		`${UI_META_SENTINEL}{not json}`,
		meta({ v: 1, kind: "turn_start", session: { action: "set" } }),
	].join("\n");

	assert.deepEqual(extractUiMetaRecords(text, limits), [
		{ v: 1, kind: "turn_start", session: { action: "keep" } },
	]);
});

test("ignores valid-looking metadata examples away from protocol boundaries", () => {
	const example = `Inline example ${meta({
		v: 1,
		kind: "turn_start",
		title: "Do not apply",
	})} remains body text`;
	assert.deepEqual(extractUiMetaRecords(example, limits), []);
	assert.equal(stripUiMetaBlocks(example), example);
});

test("sanitizes controls, bidi overrides, whitespace, and visible length", () => {
	assert.equal(
		sanitizeUiMetaText("  Fix\u001B]0;owned\u0007\nlogin\u202E state cache  ", 8),
		"Fix log…",
	);
	assert.equal(sanitizeUiMetaText("abcdef", 4), "abc…");
});

test("strips complete metadata without removing the normal response", () => {
	const markdown = [
		meta({ v: 1, kind: "turn_start", title: "Test" }),
		"",
		"Normal response",
		"",
	].join("\n");
	assert.equal(stripUiMetaBlocks(markdown), "Normal response");
});

test("hides unfinished sentinel prefixes only when requested", () => {
	assert.equal(
		stripUiMetaBlocks(`Normal response\n${UI_META_SENTINEL}{"v":1`, true),
		"Normal response",
	);
	assert.equal(stripUiMetaBlocks("", true), "");
	assert.equal(stripUiMetaBlocks("@@PI_UI_", true), "");
	assert.equal(
		stripUiMetaBlocks(`Normal response\n${UI_META_SENTINEL.slice(0, 8)}`, false),
		`Normal response\n${UI_META_SENTINEL.slice(0, 8)}`,
	);
	assert.equal(stripUiMetaBlocks("Result is 1 < 2", true), "Result is 1 < 2");
});

test("keeps malformed protocol lines out after normal prose arrives", () => {
	assert.equal(
		stripUiMetaBlocks(`${UI_META_SENTINEL}{"v":1\nNormal response`, true),
		"Normal response",
	);
	assert.equal(
		stripUiMetaBlocks(
			'<ui_meta>{"v":1,"kind":"turn_start","title":"Test"}_meta>\nNormal response',
			true,
		),
		"Normal response",
	);
});

test("reads and strips legacy one-line records for compatibility", () => {
	const legacy = [
		'<ui_meta>{"v":1,"kind":"turn_start","session":{"action":"keep"}}</ui_meta>',
		"Normal response",
	].join("\n");
	assert.deepEqual(extractUiMetaRecords(legacy, limits), [
		{ v: 1, kind: "turn_start", session: { action: "keep" } },
	]);
	assert.equal(stripUiMetaBlocks(legacy, true), "Normal response");
});
