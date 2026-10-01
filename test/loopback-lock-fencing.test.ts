import test, { mock } from 'node:test';
import { deepStrictEqual, notStrictEqual, rejects, strictEqual } from 'node:assert';
import { EventEmitter } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let freshImportCounter = 0;

function freshModuleUrl(): string {
	return `../src/loopbackAddressPool.ts?lock-fencing=${++freshImportCounter}`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function createAvailableServer() {
	const emitter = new EventEmitter();
	const server = {
		once(event: string, listener: (...args: unknown[]) => void) {
			emitter.once(event, listener);
			return server;
		},
		off(event: string, listener: (...args: unknown[]) => void) {
			emitter.off(event, listener);
			return server;
		},
		listen(...args: unknown[]) {
			const listener = args.at(-1) as () => void;
			queueMicrotask(listener);
			return server;
		},
		close(listener: () => void) {
			queueMicrotask(listener);
			return server;
		},
	};
	return server;
}

test('a writer superseded after reading cannot erase the successor claim', async () => {
	const isolatedTmpDir = await mkdtemp(join(tmpdir(), 'loopback-lock-fencing-'));
	const poolPath = join(isolatedTmpDir, 'harper-integration-test-loopback-pool.json');
	const lockPath = join(isolatedTmpDir, 'harper-integration-test-loopback-pool.lock');
	const previousEnv = new Map(
		[
			'TMPDIR',
			'TMP',
			'TEMP',
			'HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START',
			'HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT',
		].map((name) => [name, process.env[name]])
	);
	process.env.TMPDIR = isolatedTmpDir;
	process.env.TMP = isolatedTmpDir;
	process.env.TEMP = isolatedTmpDir;
	process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START = '2';
	process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = '3';

	const staleSnapshotRead = deferred();
	const resumeStaleWriter = deferred();
	let pauseFirstPoolRead = true;
	const fsMock = mock.module('node:fs/promises', {
		namedExports: {
			...fsPromises,
			readFile: async (path: string, encoding: BufferEncoding) => {
				const contents = await readFile(path, encoding);
				if (path === poolPath && pauseFirstPoolRead) {
					pauseFirstPoolRead = false;
					staleSnapshotRead.resolve();
					await resumeStaleWriter.promise;
				}
				return contents;
			},
		},
	});
	const netMock = mock.module('node:net', {
		namedExports: {
			...net,
			createServer: createAvailableServer,
		},
	});
	const warn = mock.method(console, 'warn', () => {});

	let staleWriter: Promise<string> | undefined;
	try {
		await writeFile(poolPath, JSON.stringify([null, null, null]));
		const { getNextAvailableLoopbackAddress } = await import(freshModuleUrl());
		staleWriter = getNextAvailableLoopbackAddress();
		await staleSnapshotRead.promise;

		await writeFile(poolPath, JSON.stringify([process.ppid, null, null]));
		const staleTime = new Date(Date.now() - 20000);
		await utimes(lockPath, staleTime, staleTime);

		const successorAddress = await getNextAvailableLoopbackAddress();
		strictEqual(successorAddress, '127.0.0.3');
		await writeFile(lockPath, 'replacement-holder');
		await utimes(lockPath, staleTime, staleTime);
		resumeStaleWriter.resolve();

		const staleWriterAddress = await staleWriter;
		notStrictEqual(staleWriterAddress, successorAddress);
		deepStrictEqual(JSON.parse(await readFile(poolPath, 'utf-8')), [process.ppid, process.pid, process.pid]);
		strictEqual(warn.mock.callCount(), 1);
	} finally {
		resumeStaleWriter.resolve();
		await staleWriter?.catch(() => {});
		fsMock.restore();
		netMock.restore();
		warn.mock.restore();
		for (const [name, value] of previousEnv) restoreEnv(name, value);
		await rm(isolatedTmpDir, { recursive: true, force: true });
	}
});

test('a superseded holder does not unlink the replacement lock', async () => {
	const isolatedTmpDir = await mkdtemp(join(tmpdir(), 'loopback-lock-release-'));
	const lockPath = join(isolatedTmpDir, 'harper-integration-test-loopback-pool.lock');
	const previousTmpEnv = new Map(['TMPDIR', 'TMP', 'TEMP'].map((name) => [name, process.env[name]]));
	for (const name of previousTmpEnv.keys()) process.env[name] = isolatedTmpDir;
	const sectionEntered = deferred();
	const resumeSection = deferred();
	try {
		const { withLock } = await import(freshModuleUrl());
		const staleHolder = withLock(async () => {
			sectionEntered.resolve();
			await resumeSection.promise;
		});
		await sectionEntered.promise;
		await writeFile(lockPath, 'replacement-holder');
		resumeSection.resolve();
		await staleHolder;

		strictEqual(await readFile(lockPath, 'utf-8'), 'replacement-holder');
	} finally {
		resumeSection.resolve();
		for (const [name, value] of previousTmpEnv) restoreEnv(name, value);
		await rm(isolatedTmpDir, { recursive: true, force: true });
	}
});

test('a failed token write does not delete a successor lock', async () => {
	const isolatedTmpDir = await mkdtemp(join(tmpdir(), 'loopback-lock-write-failure-'));
	const lockPath = join(isolatedTmpDir, 'harper-integration-test-loopback-pool.lock');
	const previousTmpEnv = new Map(['TMPDIR', 'TMP', 'TEMP'].map((name) => [name, process.env[name]]));
	for (const name of previousTmpEnv.keys()) process.env[name] = isolatedTmpDir;
	const fsMock = mock.module('node:fs/promises', {
		namedExports: {
			...fsPromises,
			open: async (path: string, flags: string) => {
				if (path !== lockPath) return fsPromises.open(path, flags);
				await writeFile(path, '', { flag: flags });
				return {
					close: async () => {},
					writeFile: async () => {
						await writeFile(lockPath, 'replacement-holder');
						throw new Error('simulated token write failure');
					},
				};
			},
		},
	});
	try {
		const { withLock } = await import(freshModuleUrl());
		await rejects(withLock(async () => {}), /simulated token write failure/);
		strictEqual(await readFile(lockPath, 'utf-8'), 'replacement-holder');
	} finally {
		fsMock.restore();
		for (const [name, value] of previousTmpEnv) restoreEnv(name, value);
		await rm(isolatedTmpDir, { recursive: true, force: true });
	}
});

test('a holder that keeps losing the lock gives up instead of retrying forever', async () => {
	const isolatedTmpDir = await mkdtemp(join(tmpdir(), 'loopback-lock-persistent-loss-'));
	const poolPath = join(isolatedTmpDir, 'harper-integration-test-loopback-pool.json');
	const lockPath = join(isolatedTmpDir, 'harper-integration-test-loopback-pool.lock');
	const previousTmpEnv = new Map(['TMPDIR', 'TMP', 'TEMP'].map((name) => [name, process.env[name]]));
	for (const name of previousTmpEnv.keys()) process.env[name] = isolatedTmpDir;
	const fsMock = mock.module('node:fs/promises', {
		namedExports: {
			...fsPromises,
			readFile: async (path: string, encoding: BufferEncoding) => {
				const contents = await readFile(path, encoding);
				if (path === poolPath) await unlink(lockPath);
				return contents;
			},
		},
	});
	const warn = mock.method(console, 'warn', () => {});
	try {
		const pool = JSON.stringify([process.pid, null, null]);
		await writeFile(poolPath, pool);
		const { releaseAllLoopbackAddressesForCurrentProcess } = await import(freshModuleUrl());
		await rejects(releaseAllLoopbackAddressesForCurrentProcess(), { name: 'LockOwnershipLostError' });
		strictEqual(warn.mock.callCount(), 3);
		strictEqual(await readFile(poolPath, 'utf-8'), pool);
	} finally {
		fsMock.restore();
		warn.mock.restore();
		for (const [name, value] of previousTmpEnv) restoreEnv(name, value);
		await rm(isolatedTmpDir, { recursive: true, force: true });
	}
});
