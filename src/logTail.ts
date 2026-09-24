// Harper's file logger prepends `new Date().toISOString()` to every line, so two otherwise
// identical lines (e.g. a repeated poll) differ only in this prefix.
const TIMESTAMP_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*/;
const REPEAT_MARKER_PATTERN = /^\(repeated \d+ times\)$/;

function stripTimestampPrefix(line: string): string {
	return line.replace(TIMESTAMP_PREFIX_PATTERN, '');
}

function formatRepeatMarker(runLength: number): string {
	return `(repeated ${runLength} times)`;
}

export function collapseRepeatedLines(lines: string[]): string[] {
	const collapsed: string[] = [];
	let index = 0;
	let key = lines.length > 0 ? stripTimestampPrefix(lines[0]) : '';
	while (index < lines.length) {
		const runStart = index;
		index++;
		while (index < lines.length) {
			const nextKey = stripTimestampPrefix(lines[index]);
			if (nextKey !== key) {
				key = nextKey;
				break;
			}
			index++;
		}
		collapsed.push(lines[runStart]);
		const runLength = index - runStart;
		if (runLength > 1) {
			collapsed.push(formatRepeatMarker(runLength));
		}
	}
	return collapsed;
}

export function buildLogTail(content: string, tailLines: number): { output: string; note: string } {
	if (tailLines <= 0) {
		return { output: content, note: '' };
	}
	const rawLines = content.split('\n');
	const lines = collapseRepeatedLines(rawLines);
	if (lines.length <= tailLines) {
		return { output: lines.join('\n'), note: '' };
	}
	let start = lines.length - tailLines;
	// A slice boundary landing on a marker would print it detached from the line it counts —
	// pull that line back in rather than show an orphaned "(repeated N times)".
	if (REPEAT_MARKER_PATTERN.test(lines[start])) {
		start--;
	}
	return {
		output: lines.slice(start).join('\n'),
		note: ` (last ${lines.length - start} of ${lines.length} collapsed lines, ${rawLines.length} raw; set HARPER_INTEGRATION_TEST_LOG_TAIL_LINES=0 for full log)`,
	};
}
