import test, { mock } from 'node:test';
import { deepStrictEqual, ok, rejects } from 'node:assert';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPoolFile, writePoolFile } from '../src/loopbackAddressPool.ts';

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'loopback-pool-test-'));
	try {
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('readPoolFile reinitializes instead of throwing on a truncated/corrupt pool file', async () => {
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		await writeFile(poolPath, '[1,2,nul');

		const pool = await readPoolFile(poolPath);

		ok(Array.isArray(pool));
		ok(pool.length > 0);
		ok(pool.every((slot) => slot === null));
	});
});

test('readPoolFile reinitializes on valid JSON that is not a pool array', async () => {
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		await writeFile(poolPath, 'null');

		const pool = await readPoolFile(poolPath);

		ok(Array.isArray(pool));
		ok(pool.every((slot) => slot === null));
	});
});

test('readPoolFile still rethrows errors unrelated to a missing/corrupt file', async () => {
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		const m = mock.module('node:fs/promises', {
			// @types/node 22.0.0 only knows `namedExports`; `exports` isn't in its types yet.
			namedExports: {
				...fsPromises,
				readFile: async () => {
					const error = new Error('simulated EACCES') as NodeJS.ErrnoException;
					error.code = 'EACCES';
					throw error;
				},
			},
		});
		try {
			const { readPoolFile: freshReadPoolFile } = await import(`../src/loopbackAddressPool.ts?fresh=${Date.now()}`);
			await rejects(() => freshReadPoolFile(poolPath), /simulated EACCES/);
		} finally {
			m.restore();
		}
	});
});

test('writePoolFile round-trips through readPoolFile and leaves no leftover pending file', async () => {
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		const pool = [null, 123, null, 456];

		await writePoolFile(pool, poolPath);

		deepStrictEqual(await readPoolFile(poolPath), pool);
		deepStrictEqual(await readdir(dir), ['pool.json']);
	});
});

test('writePoolFile never leaves a partially-written file visible at the pool path', async () => {
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		const original = [null, null, null];
		await writeFile(poolPath, JSON.stringify(original));

		// Faults the publish step after the pending write already completed, proving poolPath
		// itself is untouched. This exercises the catchable-error branch of cleanup, not immunity
		// to an actual SIGKILL — a hard kill in this window bypasses catch/finally and does orphan
		// the pending file (accepted gap: the pool has no reaper, unlike the instance registry).
		const m = mock.module('node:fs/promises', {
			namedExports: {
				...fsPromises,
				rename: async () => {
					throw new Error('simulated rename failure');
				},
			},
		});
		try {
			const { writePoolFile: freshWritePoolFile } = await import(`../src/loopbackAddressPool.ts?fresh=${Date.now()}`);
			await rejects(() => freshWritePoolFile([1, 2, 3], poolPath), /simulated rename failure/);
		} finally {
			m.restore();
		}

		deepStrictEqual(JSON.parse(await readFile(poolPath, 'utf-8')), original);
		deepStrictEqual(await readdir(dir), ['pool.json']);
	});
});
