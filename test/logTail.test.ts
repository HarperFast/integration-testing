import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

	// The collapsed log is only 3 lines (the error, the poll run's first line, its repeat
	// marker), so a tail of 5 keeps the error line instead of cutting it off, which slicing
	// the raw 51-line log to a tail of 5 would.
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

test('LOG_TAIL_LINES=0 dumps the full, uncollapsed log', () => {
	const content = [pollLine('2026-09-11T12:00:00.000Z'), pollLine('2026-09-11T12:00:01.000Z')].join('\n');
	const { output, note } = buildLogTail(content, 0);
	strictEqual(output, content);
	strictEqual(note, '');
});

test('reading a log to build its tail never modifies the log file on disk', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'log-tail-test-'));
	const logPath = join(dir, 'hdb.log');
	const original = [
		pollLine('2026-09-11T12:00:00.000Z'),
		pollLine('2026-09-11T12:00:01.000Z'),
		'2026-09-11T12:00:02.000Z [main/1] [error]: boom',
	].join('\n');
	await writeFile(logPath, original, 'utf8');

	const content = await readFile(logPath, 'utf8');
	buildLogTail(content, 1);
	buildLogTail(content, 0);

	strictEqual(await readFile(logPath, 'utf8'), original);
});
