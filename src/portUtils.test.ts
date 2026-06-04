import { test } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { createServer, type Server } from 'node:net';
import { isPortFree, waitForPortsFree } from './portUtils.ts';

const HOST = '127.0.0.1';

/** Binds a server to host:port and resolves once it is listening. */
function listen(host: string, port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(port, host, () => resolve(server));
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** Asks the OS for a free port by binding to port 0 and reading the assigned port. */
async function getEphemeralPort(host: string): Promise<number> {
	const server = await listen(host, 0);
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	await close(server);
	return port;
}

test('isPortFree returns true for an unbound port', async () => {
	const port = await getEphemeralPort(HOST);
	strictEqual(await isPortFree(HOST, port), true);
});

test('isPortFree returns false for a bound port', async () => {
	const port = await getEphemeralPort(HOST);
	const server = await listen(HOST, port);
	try {
		strictEqual(await isPortFree(HOST, port), false);
	} finally {
		await close(server);
	}
});

test('waitForPortsFree resolves true immediately when all ports are free', async () => {
	const a = await getEphemeralPort(HOST);
	const b = await getEphemeralPort(HOST);
	const start = Date.now();
	const freed = await waitForPortsFree(HOST, [a, b], 1000, 50);
	ok(freed, 'expected ports to be reported free');
	ok(Date.now() - start < 500, 'should not have polled/waited');
});

test('waitForPortsFree waits until a held port is released, then resolves true', async () => {
	const port = await getEphemeralPort(HOST);
	const server = await listen(HOST, port);
	// Release the port shortly after we start waiting.
	setTimeout(() => void close(server), 200);
	const freed = await waitForPortsFree(HOST, [port], 2000, 50);
	ok(freed, 'expected the port to become free before the timeout');
});

test('waitForPortsFree resolves false when a port stays held past the timeout', async () => {
	const port = await getEphemeralPort(HOST);
	const server = await listen(HOST, port);
	try {
		const freed = await waitForPortsFree(HOST, [port], 300, 50);
		strictEqual(freed, false);
	} finally {
		await close(server);
	}
});
