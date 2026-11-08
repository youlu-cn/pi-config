/** Cycle 1–3 dots, always pad to width 3 so the duration suffix does not jitter. */
export function animateDots(frame: number): string {
	return ".".repeat((frame % 3) + 1).padEnd(3, " ");
}
