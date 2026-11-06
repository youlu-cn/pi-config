import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	Image,
	type ImageDimensions,
	type OverlayHandle,
	type OverlayOptions,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	imagePasteLabel,
	imageMimeType,
	isClipboardImagePath,
	PASTE_MARKER_RE,
	supportsImagePreviewMime,
} from "./compact-paste-core.ts";

export {
	imageMimeType,
	isClipboardImagePath,
	supportsImagePreviewMime,
} from "./compact-paste-core.ts";

const IMAGE_PREVIEW_MAX_SCREEN_WIDTH_RATIO = 0.9;
const IMAGE_PREVIEW_MAX_SCREEN_HEIGHT_RATIO = 0.75;
const IMAGE_PREVIEW_MIN_FRAME_WIDTH = 24;
const IMAGE_PREVIEW_FRAME_CHROME_HEIGHT = 3;
const IMAGE_PREVIEW_SOURCE_CACHE_LIMIT = 4;

type EditorPasteRegistry = {
	pastes: Map<number, string>;
	pasteCounter: number;
};

type EditorStateAccess = {
	state: {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
};

type ImagePreviewTarget = {
	pasteId: number;
	imageNumber: number;
	path: string;
};

type ImagePreviewSource = {
	path: string;
	base64Data: string;
	mimeType: string;
	filename: string;
	dimensions: ImageDimensions;
};

type PasteLabelIndex = {
	text: string;
	registry: Map<number, string>;
	imageNumbers: Map<number, number>;
};

type ImagePreviewCellSize = {
	width: number;
	height: number;
};

type RenderedTuiState = {
	previousLines?: string[];
	previousViewportTop?: number;
	previousScreen?: string[];
};

type ScreenPosition = {
	row: number;
	col: number;
};

function imageLabelScreenPosition(
	tui: TUI,
	imageNumber: number,
): ScreenPosition | undefined {
	// Pi's regular and fullscreen renderers retain their most recent frame under
	// different private fields. Reading that frame lets this local adapter place
	// the preview beside the actual rendered label instead of guessing from the
	// terminal center. Runtime guards preserve the fallback if Pi changes them.
	// SAFETY: Both Pi TUI implementations own these frame fields at runtime; all
	// values are validated below before they influence overlay positioning.
	const state = tui as unknown as RenderedTuiState;
	const lines =
		tui.mode === "fullscreen" ? state.previousScreen : state.previousLines;
	if (!Array.isArray(lines)) {
		throw new Error(`${tui.mode} TUI render frame is unavailable`);
	}
	if (lines.length === 0) return undefined;

	const fallbackViewportTop = Math.max(0, lines.length - tui.terminal.rows);
	const savedViewportTop = state.previousViewportTop;
	let viewportTop = fallbackViewportTop;
	if (tui.mode === "fullscreen") {
		viewportTop = 0;
	} else if (Number.isInteger(savedViewportTop)) {
		viewportTop = Math.max(
			0,
			Math.min(Number(savedViewportTop), fallbackViewportTop),
		);
	}
	const viewportBottom = Math.min(lines.length, viewportTop + tui.terminal.rows);
	const label = `[image #${imageNumber}]`;

	for (
		let lineIndex = viewportBottom - 1;
		lineIndex >= viewportTop;
		lineIndex--
	) {
		const line = lines[lineIndex] ?? "";
		const labelIndex = line.lastIndexOf(label);
		if (labelIndex === -1) continue;
		return {
			row: lineIndex - viewportTop,
			col: visibleWidth(line.slice(0, labelIndex)),
		};
	}
	return undefined;
}

function isTerminalImageLine(line: string): boolean {
	return line.includes("\u001b_G") || line.includes("\u001b]1337;File=");
}

async function loadImagePreviewSource(
	path: string,
): Promise<ImagePreviewSource> {
	const base64Data = (await readFile(path)).toString("base64");
	const mimeType = imageMimeType(path);
	return {
		path,
		base64Data,
		mimeType,
		filename: basename(path),
		dimensions: getImageDimensions(base64Data, mimeType) ?? {
			widthPx: 800,
			heightPx: 600,
		},
	};
}

class ImagePreviewOverlay {
	private source?: ImagePreviewSource;
	private image?: Image;
	private label = "image";
	private maxWidthCells?: number;
	private maxHeightCells?: number;

	constructor(private readonly currentTheme: () => Theme) {}

	hasSource(path: string): boolean {
		return this.source?.path === path;
	}

	setLabel(imageNumber: number): void {
		this.label = `image #${imageNumber}`;
	}

	setTarget(target: ImagePreviewTarget, source: ImagePreviewSource): void {
		this.setLabel(target.imageNumber);
		this.source = source;
		this.image = undefined;
		this.maxWidthCells = undefined;
		this.maxHeightCells = undefined;
	}

	getOriginalCellSize(): ImagePreviewCellSize | undefined {
		if (!this.source) return undefined;
		const cell = getCellDimensions();
		return {
			// Floor keeps the image at or below its native pixel size. Terminal
			// graphics occupy whole cells, so a sub-cell image still uses one cell.
			width: Math.max(
				1,
				Math.floor(this.source.dimensions.widthPx / cell.widthPx),
			),
			height: Math.max(
				1,
				Math.floor(this.source.dimensions.heightPx / cell.heightPx),
			),
		};
	}

	setDisplaySize(maxWidthCells: number, maxHeightCells: number): void {
		if (!this.source) return;
		const width = Math.max(1, Math.floor(maxWidthCells));
		const height = Math.max(1, Math.floor(maxHeightCells));
		if (
			this.image &&
			this.maxWidthCells === width &&
			this.maxHeightCells === height
		) {
			return;
		}

		this.maxWidthCells = width;
		this.maxHeightCells = height;
		this.image = new Image(
			this.source.base64Data,
			this.source.mimeType,
			{
				fallbackColor: (text) => this.currentTheme().fg("muted", text),
			},
			{
				filename: this.source.filename,
				maxWidthCells: width,
				maxHeightCells: height,
			},
			this.source.dimensions,
		);
	}

	invalidate(): void {
		this.image?.invalidate();
	}

	render(width: number): string[] {
		const theme = this.currentTheme();
		const safeWidth = Math.max(4, width);
		const innerWidth = safeWidth - 2;
		const title = truncateToWidth(` ${this.label} `, innerWidth, "");
		const titleWidth = visibleWidth(title);
		const top =
			theme.fg("border", "╭") +
			theme.fg("accent", theme.bold(title)) +
			theme.fg("border", `${"─".repeat(Math.max(0, innerWidth - titleWidth))}╮`);
		const borderLeft = theme.fg("border", "│");
		const borderRight = theme.fg("border", "│");
		const imageRows = (this.image?.render(safeWidth) ?? []).map((line) => {
			// Kitty/iTerm image rows have zero visible width but still occupy cells.
			// Prefixing the left border moves the graphic one cell into the frame;
			// rendering every reserved row keeps both vertical borders continuous.
			const content = isTerminalImageLine(line)
				? line
				: truncateToWidth(line, innerWidth, "");
			return (
				borderLeft +
				content +
				" ".repeat(Math.max(0, innerWidth - visibleWidth(content))) +
				borderRight
			);
		});
		const hintText = truncateToWidth(
			" move cursor away to close ",
			innerWidth,
			"",
		);
		const hint =
			borderLeft +
			theme.fg("dim", hintText) +
			" ".repeat(Math.max(0, innerWidth - visibleWidth(hintText))) +
			borderRight;
		const bottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
		return [top, ...imageRows, hint, bottom];
	}
}

function pasteRegistry(editor: CustomEditor): EditorPasteRegistry {
	// Reuse Pi's native registry so submission, undo, deletion, and history still
	// expand placeholders through the normal editor path. Runtime guards keep
	// private-editor changes from breaking input.
	// SAFETY: CustomEditor inherits Pi Editor's runtime `pastes` and
	// `pasteCounter` fields; the Map guard below validates them before use.
	const candidate = editor as unknown as Partial<EditorPasteRegistry>;
	if (!(candidate.pastes instanceof Map)) {
		throw new Error("Pi editor paste registry is unavailable");
	}
	return candidate as EditorPasteRegistry;
}

export class CompactPasteEditor extends CustomEditor {
	onCompatibilityFallback?: (reason: string) => void;
	private compatibilityWarningShown = false;
	private imagePreviewTheme?: () => Theme;
	private imagePreviewOverlay?: ImagePreviewOverlay;
	private imagePreviewHandle?: OverlayHandle;
	private imagePreviewDisabled = false;
	private imagePreviewLoadGeneration = 0;
	private loadingImagePath?: string;
	private readonly imagePreviewSourceCache = new Map<
		string,
		Promise<ImagePreviewSource>
	>();
	private pasteLabelIndex?: PasteLabelIndex;
	private readonly imagePreviewOptions: OverlayOptions = {
		width: IMAGE_PREVIEW_MIN_FRAME_WIDTH,
		margin: 0,
		nonCapturing: true,
		visible: (terminalWidth, terminalHeight) =>
			terminalWidth >= 28 && terminalHeight >= 12,
	};

	setImagePreviewTheme(currentTheme: () => Theme): void {
		this.imagePreviewTheme = currentTheme;
	}

	disposeImagePreview(): void {
		this.imagePreviewLoadGeneration++;
		this.loadingImagePath = undefined;
		this.imagePreviewSourceCache.clear();
		this.imagePreviewHandle?.hide();
		this.imagePreviewHandle = undefined;
		this.imagePreviewOverlay = undefined;
	}

	checkCompatibility(): void {
		try {
			pasteRegistry(this);
			// SAFETY: CustomEditor inherits Pi Editor's runtime state; every field
			// used by this adapter is validated immediately below.
			const internal = this as unknown as Partial<EditorStateAccess>;
			if (
				!internal.state ||
				!Array.isArray(internal.state.lines) ||
				!Number.isInteger(internal.state.cursorLine) ||
				!Number.isInteger(internal.state.cursorCol)
			) {
				throw new Error("editor state is unavailable");
			}
		} catch (error) {
			this.reportCompatibilityFallback(
				error instanceof Error ? error.message : "unknown editor change",
			);
		}
	}

	private reportCompatibilityFallback(reason: string): void {
		if (this.compatibilityWarningShown) return;
		this.compatibilityWarningShown = true;
		queueMicrotask(() => {
			try {
				this.onCompatibilityFallback?.(reason);
			} catch {
				// A compatibility warning must never break the editor.
			}
		});
	}

	override insertTextAtCursor(text: string): void {
		if (!isClipboardImagePath(text)) {
			super.insertTextAtCursor(text);
			this.pasteLabelIndex = undefined;
			this.syncImagePreview();
			return;
		}

		try {
			const registry = pasteRegistry(this);
			const pasteId = registry.pasteCounter + 1;
			const marker = `[paste #${pasteId}]`;

			// Insert first so Editor's undo snapshot captures the registry before the image.
			super.insertTextAtCursor(marker);
			registry.pasteCounter = pasteId;
			registry.pastes.set(pasteId, text);
		} catch (error) {
			this.reportCompatibilityFallback(
				error instanceof Error ? error.message : "image placeholder unavailable",
			);
			// Preserve Pi's native path behavior if its private paste registry changes.
			super.insertTextAtCursor(text);
		}
		this.pasteLabelIndex = undefined;
		this.syncImagePreview();
	}

	override setText(text: string): void {
		super.setText(text);
		this.pasteLabelIndex = undefined;
		this.syncImagePreview();
	}

	override handleInput(data: string): void {
		const previousText = this.getText();
		// Text paste content, spacing and markers belong to the native editor.
		super.handleInput(data);

		if (this.getText() !== previousText) this.pasteLabelIndex = undefined;
		this.syncImagePreview();
	}

	private getPasteLabelIndex(registry: EditorPasteRegistry): PasteLabelIndex {
		const text = this.getText();
		const cached = this.pasteLabelIndex;
		if (cached?.text === text && cached.registry === registry.pastes) {
			return cached;
		}

		const imageNumbers = new Map<number, number>();
		let nextImageNumber = 1;
		for (const match of text.matchAll(PASTE_MARKER_RE)) {
			const pasteId = Number(match[1]);
			const content = registry.pastes.get(pasteId);
			if (!content) continue;
			if (isClipboardImagePath(content)) {
				imageNumbers.set(pasteId, nextImageNumber++);
			}
		}

		const index = {
			text,
			registry: registry.pastes,
			imageNumbers,
		};
		this.pasteLabelIndex = index;
		return index;
	}

	private imagePreviewTarget(): ImagePreviewTarget | undefined {
		const registry = pasteRegistry(this);
		const { imageNumbers } = this.getPasteLabelIndex(registry);
		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";

		for (const match of currentLine.matchAll(PASTE_MARKER_RE)) {
			if (match.index === undefined) continue;
			const markerStart = match.index;
			const markerEnd = markerStart + match[0].length;
			if (col < markerStart || col >= markerEnd) continue;

			const pasteId = Number(match[1]);
			const path = registry.pastes.get(pasteId);
			const imageNumber = imageNumbers.get(pasteId);
			if (path && imageNumber && isClipboardImagePath(path)) {
				return { pasteId, imageNumber, path };
			}
		}
		return undefined;
	}

	private getImagePreviewSource(path: string): Promise<ImagePreviewSource> {
		const existing = this.imagePreviewSourceCache.get(path);
		if (existing) {
			this.imagePreviewSourceCache.delete(path);
			this.imagePreviewSourceCache.set(path, existing);
			return existing;
		}

		while (
			this.imagePreviewSourceCache.size >= IMAGE_PREVIEW_SOURCE_CACHE_LIMIT
		) {
			const oldest = this.imagePreviewSourceCache.keys().next().value;
			if (typeof oldest !== "string") break;
			this.imagePreviewSourceCache.delete(oldest);
		}

		let cached!: Promise<ImagePreviewSource>;
		cached = loadImagePreviewSource(path).catch((error) => {
			if (this.imagePreviewSourceCache.get(path) === cached) {
				this.imagePreviewSourceCache.delete(path);
			}
			throw error;
		});
		this.imagePreviewSourceCache.set(path, cached);
		return cached;
	}

	private syncImagePreview(): void {
		if (this.imagePreviewDisabled) return;
		try {
			const target = this.imagePreviewTarget();
			const protocol = getCapabilities().images;
			if (
				!target ||
				!this.imagePreviewTheme ||
				!protocol ||
				!supportsImagePreviewMime(protocol, imageMimeType(target.path))
			) {
				this.hideImagePreview();
				return;
			}

			if (!this.imagePreviewOverlay) {
				this.imagePreviewOverlay = new ImagePreviewOverlay(this.imagePreviewTheme);
			}
			if (this.imagePreviewOverlay.hasSource(target.path)) {
				this.imagePreviewOverlay.setLabel(target.imageNumber);
				this.showImagePreview(target);
				return;
			}

			this.hideImagePreview();
			this.startImagePreviewLoad(target);
		} catch (error) {
			this.imagePreviewDisabled = true;
			this.disposeImagePreview();
			this.reportCompatibilityFallback(
				error instanceof Error ? error.message : "image preview unavailable",
			);
		}
	}

	private startImagePreviewLoad(target: ImagePreviewTarget): void {
		if (this.loadingImagePath === target.path) return;
		const generation = ++this.imagePreviewLoadGeneration;
		this.loadingImagePath = target.path;

		void this.getImagePreviewSource(target.path)
			.then((source) => {
				if (generation !== this.imagePreviewLoadGeneration) return;
				this.loadingImagePath = undefined;
				try {
					const current = this.imagePreviewTarget();
					const protocol = getCapabilities().images;
					if (
						!current ||
						current.path !== target.path ||
						!this.imagePreviewTheme ||
						!protocol ||
						!supportsImagePreviewMime(protocol, source.mimeType)
					) {
						return;
					}
					if (!this.imagePreviewOverlay) {
						this.imagePreviewOverlay = new ImagePreviewOverlay(
							this.imagePreviewTheme,
						);
					}
					this.imagePreviewOverlay.setTarget(current, source);
					this.showImagePreview(current);
				} catch (error) {
					this.imagePreviewDisabled = true;
					this.disposeImagePreview();
					this.reportCompatibilityFallback(
						error instanceof Error ? error.message : "image preview unavailable",
					);
				}
			})
			.catch(() => {
				if (generation !== this.imagePreviewLoadGeneration) return;
				this.loadingImagePath = undefined;
				this.hideImagePreview();
			});
	}

	private showImagePreview(target: ImagePreviewTarget): void {
		if (!this.positionImagePreview(target)) {
			this.hideImagePreview();
			return;
		}
		if (!this.imagePreviewOverlay) return;
		if (!this.imagePreviewHandle) {
			this.imagePreviewHandle = this.tui.showOverlay(
				this.imagePreviewOverlay,
				this.imagePreviewOptions,
			);
		} else if (this.imagePreviewHandle.isHidden()) {
			this.imagePreviewHandle.setHidden(false);
		} else {
			this.tui.requestRender();
		}
	}

	private hideImagePreview(): void {
		if (this.imagePreviewHandle && !this.imagePreviewHandle.isHidden()) {
			this.imagePreviewHandle.setHidden(true);
		}
	}

	private positionImagePreview(target: ImagePreviewTarget): boolean {
		if (!this.imagePreviewOverlay) return false;
		const labelPosition = imageLabelScreenPosition(this.tui, target.imageNumber);
		const originalSize = this.imagePreviewOverlay.getOriginalCellSize();
		if (!labelPosition || !originalSize || labelPosition.row <= 0) return false;

		const terminalWidth = this.tui.terminal.columns;
		const terminalHeight = this.tui.terminal.rows;
		const maxFrameWidth = Math.max(
			1,
			Math.min(
				terminalWidth,
				Math.floor(terminalWidth * IMAGE_PREVIEW_MAX_SCREEN_WIDTH_RATIO),
			),
		);
		const maxFrameHeight = Math.max(
			1,
			Math.min(
				labelPosition.row,
				Math.floor(terminalHeight * IMAGE_PREVIEW_MAX_SCREEN_HEIGHT_RATIO),
			),
		);
		if (maxFrameHeight <= IMAGE_PREVIEW_FRAME_CHROME_HEIGHT) return false;

		const maxImageWidth = Math.max(1, maxFrameWidth - 2);
		const maxImageHeight = Math.max(
			1,
			maxFrameHeight - IMAGE_PREVIEW_FRAME_CHROME_HEIGHT,
		);
		const scale = Math.min(
			1,
			maxImageWidth / originalSize.width,
			maxImageHeight / originalSize.height,
		);
		const imageWidth = Math.max(1, Math.floor(originalSize.width * scale));
		const imageHeight = Math.max(1, Math.floor(originalSize.height * scale));
		this.imagePreviewOverlay.setDisplaySize(imageWidth, imageHeight);

		const previewWidth = Math.min(
			maxFrameWidth,
			Math.max(IMAGE_PREVIEW_MIN_FRAME_WIDTH, imageWidth + 2),
		);
		const previewHeight = Math.min(
			maxFrameHeight,
			this.imagePreviewOverlay.render(previewWidth).length,
		);
		if (previewHeight <= 0) return false;

		this.imagePreviewOptions.width = previewWidth;
		this.imagePreviewOptions.row = labelPosition.row - previewHeight;
		this.imagePreviewOptions.col = Math.max(
			0,
			Math.min(labelPosition.col, terminalWidth - previewWidth),
		);
		this.imagePreviewOptions.maxHeight = previewHeight;
		return true;
	}

	override render(width: number): string[] {
		let registry: EditorPasteRegistry;
		try {
			registry = pasteRegistry(this);
		} catch (error) {
			this.reportCompatibilityFallback(
				error instanceof Error ? error.message : "paste rendering unavailable",
			);
			return super.render(width);
		}

		const { imageNumbers } = this.getPasteLabelIndex(registry);

		return super.render(width).map((line) =>
			line.replace(PASTE_MARKER_RE, (marker, rawId: string) => {
				const pasteId = Number(rawId);
				const imageNumber = imageNumbers.get(pasteId);
				return imageNumber ? imagePasteLabel(marker, imageNumber) : marker;
			}),
		);
	}
}

export function registerCompactPasteEditor(pi: ExtensionAPI): void {
	let activeEditor: CompactPasteEditor | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new CompactPasteEditor(tui, theme, keybindings);
			activeEditor = editor;
			editor.setImagePreviewTheme(() => ctx.ui.theme);
			editor.onCompatibilityFallback = (reason) => {
				ctx.ui.notify(
					`Paste UI enhancement disabled (${reason}); native paste submission remains active.`,
					"warning",
				);
			};
			editor.checkCompatibility();
			return editor;
		});
	});

	pi.on("session_shutdown", () => {
		activeEditor?.disposeImagePreview();
		activeEditor = undefined;
	});
}
