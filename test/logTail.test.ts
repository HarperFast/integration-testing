import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { buildLogTail, collapseRepeatedLines } from '../src/logTail.ts';

function pollLine(timestamp: string): string {
	return `${timestamp} [main/1] [trace]: search_by_value poll`;
}

test('collapses consecutive identical lines (ignoring timestamp) with a repeat count', () => {
	const lines = [
		pollLine('2026-09-11T12:00:00.000Z'),
		pollLine('2026-09-11T12:00:01.000Z'),
		pollLine('2026-09-11T12:00:02.000Z'),
	];
	deepStrictEqual(collapseRepeatedLines(lines), [pollLine('2026-09-11T12:00:00.000Z'), '(repeated 3 times)']);
});

test('keeps non-consecutive repeats uncollapsed', () => {
	const other = '2026-09-11T12:00:01.000Z [main/1] [info]: something else happened';
	const lines = [pollLine('2026-09-11T12:00:00.000Z'), other, pollLine('2026-09-11T12:00:02.000Z')];
	deepStrictEqual(collapseRepeatedLines(lines), lines);
});

test('tail length applies after collapsing, not before', () => {
	const content = [
		'2026-09-11T12:00:00.000Z [main/1] [error]: the actual failure',
		...Array.from({ length: 50 }, (_, i) => pollLine(`2026-09-11T12:00:${String(i + 1).padStart(2, '0')}.000Z`)),
	].join('\n');

	const { output, note } = buildLogTail(content, 5);
	strictEqual(
		output,
		[
			'2026-09-11T12:00:00.000Z [main/1] [error]: the actual failure',
			pollLine('2026-09-11T12:00:01.000Z'),
			'(repeated 50 times)',
		].join('\n')
	);
	strictEqual(note, '');
});

test('note reports both the collapsed and raw line counts once truncated', () => {
	const lines = Array.from(
		{ length: 10 },
		(_, i) => `2026-09-11T12:00:${String(i).padStart(2, '0')}.000Z [main/1] [info]: step ${i}`
	);
	const { output, note } = buildLogTail(lines.join('\n'), 3);
	strictEqual(output, lines.slice(-3).join('\n'));
	strictEqual(note, ' (last 3 of 10 collapsed lines, 10 raw; set HARPER_INTEGRATION_TEST_LOG_TAIL_LINES=0 for full log)');
});

test('a tail boundary landing on a repeat marker pulls in the line it counts', () => {
	const content = [
		'2026-09-11T12:00:00.000Z [main/1] [error]: the actual failure',
		pollLine('2026-09-11T12:00:01.000Z'),
		pollLine('2026-09-11T12:00:02.000Z'),
		'2026-09-11T12:00:03.000Z [main/1] [info]: line A',
		'2026-09-11T12:00:04.000Z [main/1] [info]: line B',
	].join('\n');
	const { output, note } = buildLogTail(content, 3);
	strictEqual(
		output,
		[
			pollLine('2026-09-11T12:00:01.000Z'),
			'(repeated 2 times)',
			'2026-09-11T12:00:03.000Z [main/1] [info]: line A',
			'2026-09-11T12:00:04.000Z [main/1] [info]: line B',
		].join('\n')
	);
	strictEqual(note, ' (last 4 of 5 collapsed lines, 5 raw; set HARPER_INTEGRATION_TEST_LOG_TAIL_LINES=0 for full log)');
});

test('a trailing newline does not consume a tail slot or count as a raw line', () => {
	const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
	const { output, note } = buildLogTail(lines.join('\n') + '\n', 3);
	strictEqual(output, lines.slice(-3).join('\n'));
	strictEqual(note, ' (last 3 of 5 collapsed lines, 5 raw; set HARPER_INTEGRATION_TEST_LOG_TAIL_LINES=0 for full log)');
});

test('LOG_TAIL_LINES=0 dumps the full, uncollapsed log', () => {
	const content = [pollLine('2026-09-11T12:00:00.000Z'), pollLine('2026-09-11T12:00:01.000Z')].join('\n');
	const { output, note } = buildLogTail(content, 0);
	strictEqual(output, content);
	strictEqual(note, '');
});
