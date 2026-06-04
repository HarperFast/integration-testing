import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Checks whether a TCP port can be bound on a given host (i.e. the port is free).
 *
 * Attempts to bind a throwaway server to `host:port`; resolves `true` if the bind
 * succeeds (the server is closed immediately) and `false` if it fails (e.g. the port
 * is still held by another process or socket).
 *
 * @param host The host/address to bind on (e.g. "127.0.0.2")
 * @param port The port to test
 * @returns A promise resolving to `true` if the port is free, `false` otherwise
 */
export function isPortFree(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once('error', () => resolve(false));
		server.listen(port, host, () => {
			server.close(() => resolve(true));
		});
	});
}

/**
 * Polls until every `host:port` in `ports` is free, or `timeoutMs` elapses.
 *
 * Unlike binding to an ephemeral port (which only proves the *address* is usable), this
 * verifies the specific fixed ports a Harper instance binds are actually released, which
 * is what the next test suite needs before it can reuse the address.
 *
 * @param host The host/address the ports are bound on (e.g. "127.0.0.2")
 * @param ports The fixed ports to wait on
 * @param timeoutMs Maximum time to wait for all ports to become free
 * @param pollIntervalMs Delay between polls (default 100ms)
 * @returns `true` if all ports became free within the timeout, `false` if it gave up
 */
export async function waitForPortsFree(
	host: string,
	ports: number[],
	timeoutMs: number,
	pollIntervalMs = 100
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const results = await Promise.all(ports.map((port) => isPortFree(host, port)));
		if (results.every(Boolean)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(pollIntervalMs);
	}
}
