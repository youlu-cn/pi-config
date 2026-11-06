import assert from "node:assert/strict";
import test from "node:test";
import {
	type ActivityLayout,
	type ActivityStatus,
	ActivityTree,
} from "./tool-activity-core.ts";

interface Item {
	name: string;
	status: ActivityStatus;
}

const item = (name: string, status: ActivityStatus = "running"): Item => ({
	name,
	status,
});

function view(layout: ActivityLayout<Item>): string[] {
	return layout.rows.map((row) => {
		const branch = row.nested ? `${row.last ? "└" : "├"} ` : "";
		if (row.kind === "more") return `${branch}… ${row.count}`;
		const calls =
			!row.nested && row.calls
				? ` (${row.calls.total} calls, ${row.calls.failed} failed)`
				: "";
		return `${branch}${row.value.name}${calls}`;
	});
}

test("nests calls under their parent and counts only top-level calls", () => {
	const tree = new ActivityTree<Item>();
	tree.start("c1", item("codemode"));
	tree.start("c1/1", item("read a"), "c1");
	tree.start("c1/2", item("read b"), "c1");
	tree.get("c1/2")!.status = "error";

	const layout = tree.layout(6);
	assert.deepEqual(view(layout), [
		"codemode (2 calls, 1 failed)",
		"├ read a",
		"└ read b",
	]);
	assert.equal(layout.running, 1);
	assert.equal(layout.failed, 0);
	assert.equal(layout.hidden, 0);
});

test("keeps top-level truncation unchanged when there are no nested calls", () => {
	const tree = new ActivityTree<Item>();
	for (let index = 1; index <= 8; index++) tree.start(`t${index}`, item(`t${index}`, "done"));

	const layout = tree.layout(3);
	assert.deepEqual(view(layout), ["t6", "t7", "t8"]);
	assert.equal(layout.running, 0);
	assert.equal(layout.hidden, 5);
});

test("spends leftover rows on the newest parent and collapses earlier nested calls", () => {
	const tree = new ActivityTree<Item>();
	tree.start("r1", item("r1", "done"));
	for (let index = 1; index <= 3; index++) tree.start(`r1/${index}`, item(`r1.${index}`), "r1");
	tree.start("r2", item("r2"));
	for (let index = 1; index <= 10; index++) tree.start(`r2/${index}`, item(`r2.${index}`), "r2");

	assert.deepEqual(view(tree.layout(6)), [
		"r1 (3 calls, 0 failed)",
		"r2 (10 calls, 0 failed)",
		"├ … 7",
		"├ r2.8",
		"├ r2.9",
		"└ r2.10",
	]);
	assert.deepEqual(view(tree.layout(2)), [
		"r1 (3 calls, 0 failed)",
		"r2 (10 calls, 0 failed)",
	]);
	assert.deepEqual(view(tree.layout(3)), [
		"r1 (3 calls, 0 failed)",
		"r2 (10 calls, 0 failed)",
		"└ … 10",
	]);
});

test("closes the branch of every group", () => {
	const tree = new ActivityTree<Item>();
	tree.start("a", item("a"));
	tree.start("a/1", item("a.1"), "a");
	tree.start("a/2", item("a.2"), "a");
	tree.start("b", item("b"));
	tree.start("b/1", item("b.1"), "b");

	assert.deepEqual(view(tree.layout(6)), [
		"a (2 calls, 0 failed)",
		"├ a.1",
		"└ a.2",
		"b (1 calls, 0 failed)",
		"└ b.1",
	]);
});

test("groups deeper calls under the top-level call in start order", () => {
	const tree = new ActivityTree<Item>();
	tree.start("r", item("r"));
	tree.start("r/1", item("r.1"), "r");
	tree.start("r/2", item("r.2", "done"), "r");
	// A nested tool can make its own nested calls, interleaved with its siblings.
	tree.start("r/1/1", item("r.1.1"), "r/1");
	tree.get("r/1/1")!.status = "error";

	assert.deepEqual(view(tree.layout(6)), [
		"r (3 calls, 1 failed)",
		"├ r.1",
		"├ r.2",
		"└ r.1.1",
	]);
	// The latest call stays visible; earlier ones collapse.
	assert.deepEqual(view(tree.layout(3)), [
		"r (3 calls, 1 failed)",
		"├ … 2",
		"└ r.1.1",
	]);
});

test("an untracked parent falls back to top level", () => {
	const tree = new ActivityTree<Item>();
	tree.start("a", item("a"));
	tree.start("orphan", item("orphan"), "missing");

	const layout = tree.layout(6);
	assert.deepEqual(view(layout), ["a", "orphan"]);
	assert.equal(layout.running, 2);
});

test("a restarted call keeps its position and clear removes every call", () => {
	const tree = new ActivityTree<Item>();
	tree.start("a", item("a", "done"));
	tree.start("b", item("b", "done"));
	tree.start("a", item("a again"));

	const layout = tree.layout(6);
	assert.deepEqual(view(layout), ["a again", "b"]);
	assert.equal(layout.running, 1);

	tree.clear();
	assert.deepEqual(view(tree.layout(6)), []);
	assert.equal(tree.get("a"), undefined);
});
