import assert from "node:assert/strict";
import test from "node:test";
import {
	imagePasteLabel,
	imageMimeType,
	isClipboardImagePath,
	supportsImagePreviewMime,
} from "./compact-paste-core.ts";

test("recognizes Pi clipboard image paths", () => {
	assert.equal(isClipboardImagePath("/tmp/pi-clipboard-dead-beef.png"), true);
	assert.equal(isClipboardImagePath("pi-clipboard-a1b2.jpeg"), true);
	assert.equal(isClipboardImagePath("pi-clipboard-a1b2.webp"), true);
	assert.equal(isClipboardImagePath("pi-clipboard-a1b2.gif"), true);
	assert.equal(isClipboardImagePath("regular-image.png"), false);
	assert.equal(isClipboardImagePath("pi-clipboard-not-hex.png"), false);
});

test("maps image extensions to MIME types", () => {
	assert.equal(imageMimeType("image.png"), "image/png");
	assert.equal(imageMimeType("image.jpg"), "image/jpeg");
	assert.equal(imageMimeType("image.jpeg"), "image/jpeg");
	assert.equal(imageMimeType("image.webp"), "image/webp");
	assert.equal(imageMimeType("image.gif"), "image/gif");
});

test("allows only PNG payloads through the Kitty protocol", () => {
	assert.equal(supportsImagePreviewMime("kitty", "image/png"), true);
	assert.equal(supportsImagePreviewMime("kitty", "image/jpeg"), false);
	assert.equal(supportsImagePreviewMime("kitty", "image/webp"), false);
	assert.equal(supportsImagePreviewMime("iterm2", "image/jpeg"), true);
	assert.equal(supportsImagePreviewMime(undefined, "image/gif"), true);
});

test("image labels are lowercase and preserve native marker width", () => {
	assert.equal(imagePasteLabel("[paste #1]", 1), "[image #1]");
	assert.equal(imagePasteLabel("[paste #12]", 2), "[image #2] ");
	assert.equal(imagePasteLabel("[paste #12]", 12), "[image #12]");
	assert.equal(imagePasteLabel("[paste #1]", 12), "[paste #1]");
});
