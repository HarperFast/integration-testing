import { connect, createServer } from 'node:net';
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
 * Checks whether something accepts TCP connections on `host:port`.
 *
 * Resolves `true` once a handshake completes and `false` when the connection is refused. No answer
 * within `timeoutMs` is inconclusive and also resolves `false`. Any other failure means the check
 * could not be made, so it rejects with that error. The connection is closed as soon as it opens,
 * before anything is sent.
 *
 * @param host The host/address to connect to (e.g. "127.0.0.2")
 * @param port The port to connect to
 * @param timeoutMs How long to wait for the handshake (default 1000ms)
 * @returns A promise resolving to `true` if a connection was accepted, `false` if it was refused or timed out
 */
export function acceptsConnections(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		let settled = false;
		const settle = (outcome: boolean | Error) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
		};
		socket.setTimeout(timeoutMs, () => settle(false));
		socket.once('connect', () => settle(true));
		socket.on('error', (error: NodeJS.ErrnoException) => settle(error.code === 'ECONNREFUSED' ? false : error));
	});
}

/**
 * Returns the first of `ports` on `host` that accepts a TCP connection (see
 * {@link acceptsConnections}), or `null` if none does. The ports are probed concurrently, and a probe
 * that could not be made rejects the whole call.
 *
 * @param host The host/address to connect to (e.g. "127.0.0.2")
 * @param ports The ports to probe
 * @param timeoutMs How long to wait for each handshake
 */
export async function findAcceptingPort(host: string, ports: number[], timeoutMs?: number): Promise<number | null> {
	const accepted = await Promise.all(ports.map((port) => acceptsConnections(host, port, timeoutMs)));
	const index = accepted.indexOf(true);
	return index === -1 ? null : ports[index];
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
	while (true) {
		const results = await Promise.all(ports.map((port) => isPortFree(host, port)));
		if (results.every(Boolean)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(pollIntervalMs);
	}
}
