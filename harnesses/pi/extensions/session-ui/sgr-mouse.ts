/**
 * SGR mouse protocol helpers (shared with sticky user-message).
 * Ported from pi-cc-extensions/extensions/utils/sgr-mouse.ts (MIT).
 */

/** SGR mouse packet (code;col;row + M/m terminator). */
export type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

/** Parse a single complete SGR mouse packet (data must be exactly one packet). */
export function parseSgrMousePacket(data: string): SgrMousePacket | null {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return null;
	return {
		code: Number(match[1]),
		col: Number(match[2]),
		row: Number(match[3]),
		final: match[4] as "M" | "m",
	};
}

/**
 * Parse a terminal input chunk into consecutive SGR packets.
 * Returns null if the chunk mixes non-SGR bytes (leave it to the normal input chain).
 */
export function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
	const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
	const packets: SgrMousePacket[] = [];
	let offset = 0;

	for (const match of data.matchAll(pattern)) {
		if (match.index !== offset) return null;
		offset = match.index + match[0].length;
		packets.push({
			code: Number(match[1]),
			col: Number(match[2]),
			row: Number(match[3]),
			final: match[4] as "M" | "m",
		});
	}

	return packets.length > 0 && offset === data.length ? packets : null;
}

/** Left-button press (excludes modifiers; code 32 is motion). */
export function isSgrLeftPress(packet: SgrMousePacket): boolean {
	const baseButton = mouseBaseButton(packet.code);
	return packet.final === "M" && baseButton === 0 && (packet.code & 32) === 0;
}

/** Left-button release. */
export function isSgrLeftRelease(packet: SgrMousePacket): boolean {
	const baseButton = mouseBaseButton(packet.code);
	return packet.final === "m" && baseButton === 0 && (packet.code & 32) === 0;
}

/** Idle pointer motion (DECSET 1003 code 35). Left-drag (32) is not hover. */
export function isSgrIdleMotion(packet: SgrMousePacket): boolean {
	return packet.final === "M" && (packet.code & 32) !== 0 && mouseBaseButton(packet.code) === 3;
}

/** Strip modifier bits (4/8/16/32: shift/meta/ctrl/motion) to get the base button code. */
export function mouseBaseButton(code: number): number {
	return code & ~(4 | 8 | 16 | 32);
}
