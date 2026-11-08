import assert from "node:assert/strict";
import test from "node:test";
import { animateDots } from "./compact-thinking-anim.ts";

test("animateDots keeps a fixed 3-column width across frames", () => {
	const widths = [0, 1, 2, 3, 4, 5].map((frame) => animateDots(frame).length);
	assert.deepEqual(widths, [3, 3, 3, 3, 3, 3]);
	assert.equal(animateDots(0), ".  ");
	assert.equal(animateDots(1), ".. ");
	assert.equal(animateDots(2), "...");
	assert.equal(animateDots(3), ".  ");
});
