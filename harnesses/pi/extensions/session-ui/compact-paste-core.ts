import { basename, extname } from "node:path";

export const PASTE_MARKER_RE =
	/\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const CLIPBOARD_IMAGE_RE = /^pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)$/i;

export function imageMimeType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return "image/png";
	}
}

export function supportsImagePreviewMime(
	protocol: string | undefined,
	mimeType: string,
): boolean {
	// pi-tui currently declares every Kitty payload as PNG (f=100).
	return protocol !== "kitty" || mimeType === "image/png";
}

export function isClipboardImagePath(value: string): boolean {
	return CLIPBOARD_IMAGE_RE.test(basename(value));
}

export function imagePasteLabel(marker: string, imageNumber: number): string {
	const label = `[image #${imageNumber}]`;
	// Both labels are ASCII. Preserve native layout and cursor columns; padding
	// is visual only and never enters the editor's submitted text.
	return label.length <= marker.length ? label.padEnd(marker.length) : marker;
}
