import { test } from 'node:test';
import { ok, rejects } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { targz } from '../src/targz.ts';

test('targz packs a directory into a base64-encoded gzip', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'targz-'));
	try {
		writeFileSync(join(dir, 'hello.txt'), 'world');
		const result = await targz(dir);
		ok(result.length > 0, 'should return a non-empty base64 string');
		const bytes = Buffer.from(result, 'base64');
		ok(bytes[0] === 0x1f && bytes[1] === 0x8b, 'should decode to a gzip stream (magic bytes)');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('targz rejects (does not hang) when the source directory is missing', async () => {
	// Regression test: a source-stream error must reject the promise rather than hang.
	await rejects(targz(join(tmpdir(), `targz-missing-${process.pid}-${Date.now()}`)));
});
