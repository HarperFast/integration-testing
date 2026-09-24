// Harper's file logger prepends `new Date().toISOString()` to every line, so two otherwise
// identical lines (e.g. a repeated poll) differ only in this prefix.
const TIMESTAMP_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*/;

function stripTimestampPrefix(line: string): string {
	return line.replace(TIMESTAMP_PREFIX_PATTERN, '');
}

/**
 * Collapses runs of consecutive lines that are identical once their timestamp prefix is
 * stripped into the first line of the run plus a `(repeated N times)` marker, so a burst of
 * repeated poll/heartbeat lines doesn't crowd out the surrounding context.
 */
export function collapseRepeatedLines(lines: string[]): string[] {
	const collapsed: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const runStart = index;
		const key = stripTimestampPrefix(lines[index]);
		index++;
		while (index < lines.length && stripTimestampPrefix(lines[index]) === key) {
			index++;
		}
		collapsed.push(lines[runStart]);
		const runLength = index - runStart;
		if (runLength > 1) {
			collapsed.push(`(repeated ${runLength} times)`);
		}
	}
	return collapsed;
}

/**
 * Builds the failure-log excerpt printed for a Harper node: collapse repeated lines, then take
 * the last `tailLines` of the collapsed output. `tailLines <= 0` returns the full, uncollapsed
 * log so `HARPER_INTEGRATION_TEST_LOG_TAIL_LINES=0` keeps giving an unmodified dump.
 */
export function buildLogTail(content: string, tailLines: number): { output: string; note: string } {
	if (tailLines <= 0) {
		return { output: content, note: '' };
	}
	const lines = collapseRepeatedLines(content.split('\n'));
	if (lines.length <= tailLines) {
		return { output: lines.join('\n'), note: '' };
	}
	return {
		output: lines.slice(-tailLines).join('\n'),
		note: ` (last ${tailLines} of ${lines.length} lines; set HARPER_INTEGRATION_TEST_LOG_TAIL_LINES=0 for full log)`,
	};
}
