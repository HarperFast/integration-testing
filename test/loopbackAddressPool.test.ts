import test, { mock } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPoolFile, writePoolFile } from '../src/loopbackAddressPool.ts';

let freshImportCounter = 0;
/** Monotonic cache-busting suffix — millisecond-resolution timestamps can collide. */
function freshModuleUrl(): string {
	return `../src/loopbackAddressPool.ts?fresh=${++freshImportCounter}`;
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'loopback-pool-test-'));
	try {
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const POOL_FILE_NAME = 'harper-integration-test-loopback-pool.json';

/** Makes a file look like it was last written an hour ago, well past the quarantine. */
async function age(path: string): Promise<void> {
	const anHourAgo = new Date(Date.now() - 3600000);
	await utimes(path, anHourAgo, anHourAgo);
}

/**
 * A fresh copy of the pool module whose pool and lock live in `dir` and which hands out only
 * 127.0.0.1. Both canary ports are 0 (an ephemeral bind, always free) so a real Harper on this
 * machine can't make the result depend on the host.
 */
async function importIsolatedPool(dir: string): Promise<typeof import('../src/loopbackAddressPool.ts')> {
	const overrides: Record<string, string> = {
		TMPDIR: dir,
		TMP: dir,
		TEMP: dir,
		HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START: '1',
		HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT: '1',
		HARPER_INTEGRATION_TEST_CONFLICT_PROBE_PORT: '0',
		HARPER_INTEGRATION_TEST_HTTP_CONFLICT_PROBE_PORT: '0',
	};
	const saved = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
	Object.assign(process.env, overrides);
	try {
		return await import(freshModuleUrl());
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test('readPoolFile quarantines an unusable pool file, then reinitializes it once it has gone unmodified long enough', async (t) => {
	t.mock.method(console, 'warn', () => {});
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		for (const content of ['[1,2,nul', '', 'null', '{}', '[]']) {
			await writeFile(poolPath, content);
			strictEqual(await readPoolFile(poolPath), null, `fresh ${JSON.stringify(content)} should be quarantined`);

			await age(poolPath);
			const pool = await readPoolFile(poolPath);
			ok(pool && pool.length > 0 && pool.every((slot) => slot === null), `aged ${JSON.stringify(content)} should reinitialize`);
			deepStrictEqual(JSON.parse(await readFile(poolPath, 'utf-8')), pool, 'the reinitialized pool should be published');
		}
	});
});

test('readPoolFile reads a pool file deleted between its read and its stat as missing', async () => {
	const m = mock.module('node:fs/promises', {
		namedExports: {
			...fsPromises,
			readFile: async () => '[1,2,nul',
			stat: async () => {
				const error = new Error('simulated ENOENT') as NodeJS.ErrnoException;
				error.code = 'ENOENT';
				throw error;
			},
		},
	});
	try {
		const { readPoolFile: freshReadPoolFile } = await import(freshModuleUrl());
		const pool = await freshReadPoolFile('unused');
		ok(pool.length > 0 && pool.every((slot: number | null) => slot === null));
	} finally {
		m.restore();
	}
});

test('a reservation lost to an unusable pool file is not reissued until the quarantine ends', async (t) => {
	const warn = t.mock.method(console, 'warn', () => {});
	await withTempDir(async (dir) => {
		const pool = await importIsolatedPool(dir);
		const poolPath = join(dir, POOL_FILE_NAME);
		strictEqual(await pool.getNextAvailableLoopbackAddress(), '127.0.0.1');

		// A writer that doesn't publish by rename dies mid-write, losing that reservation.
		await writeFile(poolPath, '[');
		const reissued = pool.getNextAvailableLoopbackAddress();
		try {
			strictEqual(await Promise.race([reissued.then(() => 'reissued'), sleep(2500).then(() => 'waiting')]), 'waiting');

			await pool.releaseLoopbackAddress('127.0.0.1');
			await pool.releaseAllLoopbackAddressesForCurrentProcess();
			strictEqual(await readFile(poolPath, 'utf-8'), '[', 'releasing must not end the quarantine');

			await age(poolPath);
			strictEqual(await Promise.race([reissued, sleep(5000).then(() => 'still waiting')]), '127.0.0.1');
		} finally {
			// Unblocks the allocation if an assertion above failed, so the test can't hang.
			await rm(poolPath, { force: true });
			await reissued;
		}
		strictEqual(warn.mock.calls.filter((call) => String(call.arguments[0]).includes('is unusable')).length, 1);
	});
});

test('releaseLoopbackAddress clears only a slot this process holds', async () => {
	await withTempDir(async (dir) => {
		const pool = await importIsolatedPool(dir);
		const poolPath = join(dir, POOL_FILE_NAME);

		strictEqual(await pool.getNextAvailableLoopbackAddress(), '127.0.0.1');
		await pool.releaseLoopbackAddress('127.0.0.1');
		deepStrictEqual(JSON.parse(await readFile(poolPath, 'utf-8')), [null]);

		const otherRunnerPid = process.pid + 1;
		await writeFile(poolPath, JSON.stringify([otherRunnerPid]));
		await pool.releaseLoopbackAddress('127.0.0.1');
		deepStrictEqual(JSON.parse(await readFile(poolPath, 'utf-8')), [otherRunnerPid]);
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
			const { readPoolFile: freshReadPoolFile } = await import(freshModuleUrl());
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

		// A hard kill in this same window (vs. this mocked rejection) bypasses catch/finally and
		// orphans the pending file — the pool has no reaper for that, unlike the instance registry.
		const m = mock.module('node:fs/promises', {
			namedExports: {
				...fsPromises,
				rename: async () => {
					throw new Error('simulated rename failure');
				},
			},
		});
		try {
			const { writePoolFile: freshWritePoolFile } = await import(freshModuleUrl());
			await rejects(() => freshWritePoolFile([1, 2, 3], poolPath), /simulated rename failure/);
		} finally {
			m.restore();
		}

		deepStrictEqual(JSON.parse(await readFile(poolPath, 'utf-8')), original);
		deepStrictEqual(await readdir(dir), ['pool.json']);
	});
});
