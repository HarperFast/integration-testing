import { setTimeout as sleep } from 'node:timers/promises';
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { findAcceptingPort } from './portUtils.ts';

// Configuration constants
// The pool starts at 127.0.0.2 by default (rather than 127.0.0.1) to avoid conflicting
// with other servers commonly bound to localhost. Override via the
// HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START environment variable.
const HARPER_LOOPBACK_POOL_START = process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START
	? parseInt(process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START, 10)
	: 2;
if (HARPER_LOOPBACK_POOL_START < 1 || HARPER_LOOPBACK_POOL_START > 255) {
	throw new Error('HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START must be between 1 and 255');
}
const HARPER_LOOPBACK_POOL_COUNT = process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT
	? parseInt(process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT, 10)
	: 32;
const HARPER_LOOPBACK_POOL_MAX = 256 - HARPER_LOOPBACK_POOL_START;
if (HARPER_LOOPBACK_POOL_COUNT < 1 || HARPER_LOOPBACK_POOL_COUNT > HARPER_LOOPBACK_POOL_MAX) {
	throw new Error(`HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT must be between 1 and ${HARPER_LOOPBACK_POOL_MAX}`);
}

/**
 * An address is held exactly while a process listens on this port of it. The kernel enforces one listener per
 * address and port within a network namespace, which is also the scope in which two Harper nodes on one address
 * collide, and closes the listener when its process dies, whatever PID namespace or TMPDIR that process has.
 * Every cooperating runner must use the same value.
 */
const CLAIM_PORT = (() => {
	const value = process.env.HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT;
	if (!value) return 9924;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT must be an integer between 1 and 65535 (got ${value})`);
	}
	return parsed;
})();

const RETRY_DELAY_MS = 1000;

const DEFAULT_ACQUIRE_TIMEOUT_MS = 600000;
const ACQUIRE_TIMEOUT_MS = (() => {
	const parsed = parseInt(process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_TIMEOUT_MS || '', 10);
	return Number.isNaN(parsed) || parsed < 1 ? DEFAULT_ACQUIRE_TIMEOUT_MS : parsed;
})();
const WAIT_NOTICE_MS = Math.min(30000, ACQUIRE_TIMEOUT_MS / 4);

function probePortFromEnv(name: string, fallback: number): number {
	const parsed = parseInt(process.env[name] || '', 10);
	// An invalid override must not turn into a `server.listen(NaN)` crash during allocation.
	return Number.isNaN(parsed) || parsed < 0 || parsed > 65535 ? fallback : parsed;
}

// Harper's operations API (`OPERATIONS_API_PORT` in harperLifecycle.ts) and HTTP (`HTTP_PORT`) ports. Besides the
// leftover-node probe below, these two are checked for another process accepting connections on them (see
// ForeignListenerError). Hardcoded rather than imported from harperLifecycle to avoid a circular import.
const CONFLICT_PROBE_PORT = probePortFromEnv('HARPER_INTEGRATION_TEST_CONFLICT_PROBE_PORT', 9925);
const HTTP_CONFLICT_PROBE_PORT = probePortFromEnv('HARPER_INTEGRATION_TEST_HTTP_CONFLICT_PROBE_PORT', 9926);
const FOREIGN_LISTENER_PROBE_PORTS = [...new Set([CONFLICT_PROBE_PORT, HTTP_CONFLICT_PROBE_PORT])];

// Harper's HTTPS, MQTT and MQTTS ports: with the two above, every port startHarper binds on the node's address
// (`ALL_HARPER_PORTS` in harperLifecycle.ts). Not replication: harper-pro's default `replication.securePort` has no
// host, so every node binds it on all interfaces, where it cannot be told apart from a leftover node's.
const OTHER_CONFLICT_PROBE_PORTS = (() => {
	const value = process.env.HARPER_INTEGRATION_TEST_OTHER_CONFLICT_PROBE_PORTS;
	const defaults = [9927, 1883, 8883];
	if (value === undefined) return defaults;
	const ports = value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map(Number);
	return ports.every((port) => Number.isInteger(port) && port >= 0 && port <= 65535) ? ports : defaults;
})();

const CONFLICT_PROBE_PORTS = [...new Set([...FOREIGN_LISTENER_PROBE_PORTS, ...OTHER_CONFLICT_PROBE_PORTS])];
if (CONFLICT_PROBE_PORTS.includes(CLAIM_PORT)) {
	throw new Error(`HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT (${CLAIM_PORT}) must not be one of Harper's ports`);
}

/**
 * An address outside the pool (Linux routes all of 127.0.0.0/8 to lo) for telling a listener on all interfaces from
 * one on a pool address. Each pool address gets its own, which only that address's claim holder binds, so concurrent
 * probes of different addresses cannot mistake each other for such a listener.
 */
function controlAddressFor(loopbackAddress: string): string {
	return loopbackAddress.replace(/^127\.0\.0\./, '127.255.0.');
}

const IDENTITY_PROTOCOL = 'harper-integration-test-loopback-claim/1';
const IDENTITY_SERVE_MS = 2000;
const IDENTITY_QUERY_MS = 1000;
const IDENTITY_MAX_CHARACTERS = 1024;

interface LoopbackAddressError extends Error {
	loopbackAddress: string;
}

// Custom error classes
class LoopbackAddressValidationError extends Error {
	constructor(address: string, cause?: Error, message?: string) {
		super(
			message ??
				`Failed to validate loopback address ${address}. This likely means your system does not have the required loopback addresses configured/enabled. Refer to the Harper Integration Test documentation (integrationTests/README.md) for more information.`
		);
		this.name = 'LoopbackAddressValidationError';
		if (cause) {
			this.cause = cause;
		}
	}
}

class InvalidLoopbackAddressError extends Error {
	constructor(address: string) {
		super(
			`Invalid loopback address format: ${address}. Expected format: 127.0.0.X where X is between ${HARPER_LOOPBACK_POOL_START} and ${HARPER_LOOPBACK_POOL_START + HARPER_LOOPBACK_POOL_COUNT - 1}`
		);
		this.name = 'InvalidLoopbackAddressError';
	}
}

/**
 * Thrown by {@link getNextAvailableLoopbackAddress} when no address became free within
 * `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_TIMEOUT_MS`. The message names the pool range and the processes
 * holding its addresses.
 */
export class LoopbackPoolExhaustedError extends Error {
	constructor(waitedMs: number, poolState: string) {
		super(
			`No loopback address became free within ${Math.round(waitedMs / 1000)}s. ${poolState}\nIf that much queuing is expected, raise HARPER_INTEGRATION_TEST_LOOPBACK_POOL_TIMEOUT_MS (now ${ACQUIRE_TIMEOUT_MS}).`
		);
		this.name = 'LoopbackPoolExhaustedError';
	}
}

const ALLOW_FOREIGN_LISTENERS_ENV = 'HARPER_INTEGRATION_TEST_ALLOW_FOREIGN_LISTENERS';

/**
 * Thrown by {@link getNextAvailableLoopbackAddress} when another process accepts connections on one of
 * a newly allocated address's Harper ports before any Harper node runs there. The usual cause is a
 * service listening on all interfaces, which covers every pool address, so another address would not
 * help.
 */
export class ForeignListenerError extends Error {
	loopbackAddress: string;
	port: number;

	constructor(address: string, port: number) {
		super(
			`Another process accepts connections on ${address}:${port}, a port the Harper node on this address will bind, before that node has started — most likely a service listening on all interfaces, such as a local Harper instance. Whenever the node has no listener of its own there (while it starts, while its HTTP workers restart, after teardown), its clients connect to that process instead, and keep-alive connections stay with it. Stop that process or bind it to a specific address (\`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, or \`netstat -ano | findstr :${port}\` on Windows, names it), or set ${ALLOW_FOREIGN_LISTENERS_ENV}=1 to run anyway.`
		);
		this.name = 'ForeignListenerError';
		this.loopbackAddress = address;
		this.port = port;
	}
}

function foreignListenersAllowed(): boolean {
	const value = process.env[ALLOW_FOREIGN_LISTENERS_ENV];
	return value === '1' || value?.toLowerCase() === 'true';
}

interface Claim {
	server: Server;
	/** Identity queries in flight; release resets them so they cannot hold the claim port open. */
	connections: Set<Socket>;
	/** False while allocation still checks the address's Harper ports, and may yet let it go. */
	accepted: boolean;
}

// Shared by every copy of this module in the process, so release-all keeps meaning "this process".
const CLAIMS_KEY = Symbol.for('@harperfast/integration-testing/loopback-claims');
const claims: Map<string, Claim> = ((globalThis as Record<symbol, unknown>)[CLAIMS_KEY] ??= new Map()) as Map<
	string,
	Claim
>;

function claimKey(address: string): string {
	return `${address}:${CLAIM_PORT}`;
}

function addressAt(index: number): string {
	return `127.0.0.${index + HARPER_LOOPBACK_POOL_START}`;
}

interface HolderIdentity {
	pid: number;
	pidNamespace: string | null;
	hostname: string | null;
	checking?: boolean;
}

let ownIdentity: HolderIdentity | undefined;
function getOwnIdentity(): HolderIdentity {
	if (!ownIdentity) {
		let pidNamespace: string | null = null;
		if (process.platform === 'linux') {
			try {
				pidNamespace = readlinkSync('/proc/self/ns/pid');
			} catch {}
		}
		let ownHostname: string | null = null;
		try {
			ownHostname = hostname();
		} catch {}
		ownIdentity = { pid: process.pid, pidNamespace, hostname: ownHostname };
	}
	return ownIdentity;
}

/** The client closes first, so the claim port never sits in TIME_WAIT on the holder's side. */
function answerIdentity(claim: Claim, socket: Socket): void {
	const { connections } = claim;
	connections.add(socket);
	socket.on('error', () => {});
	socket.unref();
	const timer = setTimeout(() => socket.resetAndDestroy(), IDENTITY_SERVE_MS).unref();
	socket.once('close', () => {
		clearTimeout(timer);
		connections.delete(socket);
	});
	socket.resume();
	socket.write(`${JSON.stringify({ protocol: IDENTITY_PROTOCOL, ...getOwnIdentity(), checking: !claim.accepted })}\n`);
}

/** Resolves the claim, or `null` when another listener already holds the address's claim port. */
function claimAddress(address: string): Promise<Claim | null> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => answerIdentity(claim, socket));
		const claim: Claim = { server, connections: new Set(), accepted: false };
		const onError = (error: NodeJS.ErrnoException) => {
			if (error.code === 'EADDRINUSE') {
				resolve(null);
				return;
			}
			reject(new LoopbackAddressValidationError(address, error));
		};
		server.once('error', onError);
		// `exclusive` keeps a cluster worker from sharing the primary's handle with a sibling worker.
		server.listen({ host: address, port: CLAIM_PORT, exclusive: true }, () => {
			server.off('error', onError);
			// An accept failure (EMFILE) must not crash the holder; the claim stays bound.
			server.on('error', () => {});
			server.unref();
			resolve(claim);
		});
	});
}

function closeClaim(claim: Claim): Promise<void> {
	return new Promise((resolve) => {
		claim.server.close(() => resolve());
		for (const socket of claim.connections) socket.resetAndDestroy();
	});
}

type HolderReport = HolderIdentity | 'unidentified' | 'released';

function parseIdentity(line: string): HolderIdentity | null {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof reply !== 'object' || reply === null) return null;
	const { protocol, pid, pidNamespace, hostname, checking } = reply as Record<string, unknown>;
	if (protocol !== IDENTITY_PROTOCOL || !Number.isSafeInteger(pid) || (pid as number) < 1) return null;
	return {
		pid: pid as number,
		pidNamespace: typeof pidNamespace === 'string' && /^pid:\[\d+\]$/.test(pidNamespace) ? pidNamespace : null,
		hostname: typeof hostname === 'string' && /^[\w.-]{1,253}$/.test(hostname) ? hostname : null,
		checking: checking === true,
	};
}

/** Asks a claim's holder who it is. Whatever answers is untrusted, and only ever described. */
function queryHolder(address: string): Promise<HolderReport> {
	return new Promise((resolve) => {
		const socket = connect({ host: address, port: CLAIM_PORT });
		let reply = '';
		let settled = false;
		const settle = (report: HolderReport) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(report);
		};
		const timer = setTimeout(() => settle('unidentified'), IDENTITY_QUERY_MS);
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			reply += chunk;
			const newline = reply.indexOf('\n');
			if ((newline === -1 ? reply.length : newline) > IDENTITY_MAX_CHARACTERS) settle('unidentified');
			else if (newline !== -1) settle(parseIdentity(reply.slice(0, newline)) ?? 'unidentified');
		});
		socket.on('error', (error: NodeJS.ErrnoException) => settle(error.code === 'ECONNREFUSED' ? 'released' : 'unidentified'));
		socket.on('end', () => settle('unidentified'));
	});
}

function describeHolder(identity: HolderIdentity): string {
	const own = getOwnIdentity();
	if (identity.pid === own.pid && identity.pidNamespace === own.pidNamespace && identity.hostname === own.hostname) {
		return `pid ${own.pid} (this process)`;
	}
	let description = `pid ${identity.pid}`;
	if (identity.pidNamespace && own.pidNamespace && identity.pidNamespace !== own.pidNamespace) {
		description += ` in another PID namespace (${identity.pidNamespace})`;
	}
	if (identity.hostname && own.hostname && identity.hostname !== own.hostname) {
		description += ` on host ${identity.hostname}`;
	}
	return description;
}

/**
 * Validates that a given loopback address can be bound to by creating a temporary
 * TCP server on that address. This ensures the loopback address is actually configured
 * and available on the system before allocating it to a test process.
 *
 * The server is bound to port 0 (random port) just to verify the address exists,
 * then immediately closed.
 *
 * @param loopbackAddress The loopback IP address to validate (e.g., "127.0.0.2")
 * @returns A promise that resolves with the address if valid
 * @throws An error with the loopbackAddress property if binding fails
 */
function validateLoopbackAddress(loopbackAddress: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', (error) => {
			const enhancedError = error as LoopbackAddressError;
			enhancedError.loopbackAddress = loopbackAddress;
			reject(enhancedError);
		});
		server.listen(0, loopbackAddress, () => {
			server.close(() => {
				resolve(loopbackAddress);
			});
		});
	});
}

/**
 * Probes a single port on `loopbackAddress` with an exclusive (non-SO_REUSEPORT) bind.
 * Node's `net` server does not set SO_REUSEPORT, so if a stale/overlapping Harper node still
 * holds this port — even via a SO_REUSEPORT worker socket — the bind fails with EADDRINUSE.
 *
 * Returns `true` if the port appears in use (EADDRINUSE), `false` if it is free.
 * Re-throws any other bind error (e.g. EADDRNOTAVAIL) — that's a real configuration
 * problem the caller should surface, not a transient conflict to skip.
 */
function isPortInUseOnAddress(port: number, loopbackAddress: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		const onError = (error: NodeJS.ErrnoException) => {
			if (error.code === 'EADDRINUSE') {
				resolve(true);
				return;
			}
			const enhancedError = error as LoopbackAddressError;
			enhancedError.loopbackAddress = loopbackAddress;
			reject(enhancedError);
		};
		server.once('error', onError);
		server.listen(port, loopbackAddress, () => {
			// Bind succeeded — the port is free. Drop the error listener so a stray
			// post-bind socket error during close() can't flip the resolved verdict.
			server.off('error', onError);
			server.close(() => {
				resolve(false);
			});
		});
	});
}

/**
 * Whether a bind conflict on `port` comes from a listener on all interfaces. Only Linux refuses an exclusive bind
 * of one address beside such a listener, and there a bind of an address outside the pool conflicts with it too.
 * A `true` cannot rule out a second listener on the pool address itself.
 */
async function isHeldOnAllInterfaces(port: number, loopbackAddress: string): Promise<boolean> {
	if (process.platform !== 'linux') return false;
	try {
		return await isPortInUseOnAddress(port, controlAddressFor(loopbackAddress));
	} catch {
		return false;
	}
}

interface PortConflict {
	port: number;
	/** `address`: a listener on the pool address itself, such as a Harper node that outlived its runner. */
	scope: 'address' | 'all-interfaces';
}

/**
 * Finds a port of {@link CONFLICT_PROBE_PORTS} already bound on `loopbackAddress`, preferring one held on the
 * address itself. Two shapes of leftover node are caught: one whose main thread still holds the exclusive
 * operations port, and one whose main thread exited while SO_REUSEPORT workers still hold the HTTP port. A plain
 * bind fails against either, which prevents a co-bind that would split connections between two nodes.
 *
 * Re-throws any non-EADDRINUSE bind error (a real configuration problem).
 */
async function findConflictingPort(loopbackAddress: string): Promise<PortConflict | null> {
	let allInterfacesConflict: PortConflict | null = null;
	for (const port of CONFLICT_PROBE_PORTS) {
		if (!(await isPortInUseOnAddress(port, loopbackAddress))) continue;
		if (!(await isHeldOnAllInterfaces(port, loopbackAddress))) return { port, scope: 'address' };
		allInterfacesConflict ??= { port, scope: 'all-interfaces' };
	}
	return allInterfacesConflict;
}

/**
 * This method attempts to validate all loopback addresses in the pool by trying to
 * bind to each one. It returns an object containing arrays of successfully bound
 * loopback addresses and those that failed along with their errors.
 *
 * It will check all loopback addresses from 127.0.0.2 to 127.0.0.33 (by default).
 *
 * Use the HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT environment variable to
 * adjust the number of loopback addresses to validate (up to 254).
 */
export async function validateLoopbackAddressPool(): Promise<{
	successful: string[];
	failed: { loopbackAddress: string; error: Error }[];
}> {
	return Promise.allSettled(
		Array.from({ length: HARPER_LOOPBACK_POOL_COUNT }, (_, i) => validateLoopbackAddress(addressAt(i)))
	).then((results) =>
		results.reduce<{ successful: string[]; failed: { loopbackAddress: string; error: Error }[] }>(
			(acc, result) => {
				if (result.status === 'fulfilled') {
					acc.successful.push(result.value);
				} else {
					const error = result.reason as LoopbackAddressError;
					acc.failed.push({ loopbackAddress: error.loopbackAddress, error });
				}

				return acc;
			},
			{ successful: [], failed: [] }
		)
	);
}

/**
 * @param claimed Indices whose claim port was already bound at the last pass
 * @param conflictPorts Maps an index to the Harper port another node was last found binding there during this wait
 */
async function describePoolState(claimed: readonly number[], conflictPorts: ReadonlyMap<number, number>): Promise<string> {
	const isOwn = (index: number) => claims.has(claimKey(addressAt(index)));
	const ownAddresses = claimed.filter(isOwn).map(addressAt);
	const others = claimed.filter((index) => !isOwn(index));
	const reports = await Promise.all(others.map((index) => queryHolder(addressAt(index))));
	const addressesByHolder = new Map<string, string[]>();
	const addHolder = (holder: string, index: number) =>
		addressesByHolder.set(holder, [...(addressesByHolder.get(holder) ?? []), addressAt(index)]);
	const unidentifiedIndices: number[] = [];
	const occupied = new Map([...conflictPorts].filter(([index]) => !claimed.includes(index)));
	others.forEach((index, i) => {
		const report = reports[i];
		if (report === 'unidentified') {
			unidentifiedIndices.push(index);
			return;
		}
		// A claim given up or still being checked is another allocation trying the address, not a holder of it.
		if (report === 'released' || report.checking) {
			const port = conflictPorts.get(index);
			if (port !== undefined) occupied.set(index, port);
			else if (report !== 'released') addHolder(`${describeHolder(report)} is checking`, index);
			return;
		}
		addHolder(`${describeHolder(report)} holds`, index);
	});
	const lines = [
		`Pool ${addressAt(0)}-${addressAt(HARPER_LOOPBACK_POOL_COUNT - 1)} (${HARPER_LOOPBACK_POOL_COUNT} addresses), each held by a listener on its port ${CLAIM_PORT}:`,
	];
	if (ownAddresses.length > 0) lines.push(`  pid ${process.pid} (this process) holds ${ownAddresses.join(', ')}`);
	for (const [holder, addresses] of addressesByHolder) lines.push(`  ${holder} ${addresses.join(', ')}`);
	if (unidentifiedIndices.length > 0) {
		lines.push(`  held by a process that did not identify itself: ${unidentifiedIndices.map(addressAt).join(', ')}`);
		if (await isHeldOnAllInterfaces(CLAIM_PORT, addressAt(unidentifiedIndices[0]))) {
			lines.push(
				`  port ${CLAIM_PORT} is bound on all interfaces by another program, which holds every address; set HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT to a free port for every run`
			);
		}
	}
	if (occupied.size > 0) {
		const addresses = [...occupied].sort(([a], [b]) => a - b).map(([index, port]) => `${addressAt(index)} (port ${port})`);
		lines.push(`  unclaimed but bound by another Harper node: ${addresses.join(', ')}`);
	}
	lines.push(
		`Each holder is alive: its listener closes when it exits. \`lsof -nP -iTCP@<address>:${CLAIM_PORT} -sTCP:LISTEN\` names a holder by its pid on this host, and \`lsof -nP -iTCP@<address> -sTCP:LISTEN\` what binds an address's Harper ports (\`netstat -ano | findstr <address>:\` on Windows). Stop what leaked.`
	);
	return lines.join('\n');
}

/**
 * Allocates a loopback address from the pool, safely across concurrent processes that share a network namespace,
 * whatever their PID namespace or TMPDIR. The address stays held until it is released or this process exits. An
 * address whose Harper ports are still bound, such as by a node that outlived its runner, is skipped. If every
 * address is held, waits for one for up to `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_TIMEOUT_MS` (default 10 minutes),
 * logging one warning naming the holders after 30 seconds.
 *
 * @returns A promise that resolves with an allocated loopback address (e.g. "127.0.0.2")
 * @throws {LoopbackAddressValidationError} If the address cannot be bound to, or cannot be checked for
 * another process's listener
 * @throws {ForeignListenerError} If another process accepts connections on the address's Harper ports and
 * `HARPER_INTEGRATION_TEST_ALLOW_FOREIGN_LISTENERS` is not set
 * @throws {LoopbackPoolExhaustedError} If no address became free within the timeout
 */
export async function getNextAvailableLoopbackAddress(): Promise<string> {
	const waitStartedAt = performance.now();
	const warnedConflicts = new Set<string>();
	const conflictPorts = new Map<number, number>();
	let noticed = false;
	while (true) {
		const claimed: number[] = [];
		for (let index = 0; index < HARPER_LOOPBACK_POOL_COUNT; index++) {
			const loopbackAddress = addressAt(index);
			const claim = await claimAddress(loopbackAddress);
			if (!claim) {
				claimed.push(index);
				continue;
			}
			let accepted: boolean;
			try {
				accepted = await checkClaimedAddress(loopbackAddress, index, conflictPorts, warnedConflicts);
			} catch (error) {
				await closeClaim(claim);
				throw error;
			}
			if (accepted) {
				claim.accepted = true;
				claims.set(claimKey(loopbackAddress), claim);
				return loopbackAddress;
			}
			await closeClaim(claim);
		}

		const waitedMs = performance.now() - waitStartedAt;
		if (waitedMs >= ACQUIRE_TIMEOUT_MS) {
			throw new LoopbackPoolExhaustedError(waitedMs, await describePoolState(claimed, conflictPorts));
		}
		if (!noticed && waitedMs >= WAIT_NOTICE_MS) {
			noticed = true;
			console.warn(
				`[loopback-pool] Still waiting for a free loopback address after ${Math.round(waitedMs / 1000)}s; giving up after ${Math.round(ACQUIRE_TIMEOUT_MS / 1000)}s. ${await describePoolState(claimed, conflictPorts)}`
			);
		}
		await sleep(RETRY_DELAY_MS);
	}
}

/**
 * Decides whether a just-claimed address can be handed out. Resolves `false` to skip it for this pass.
 */
async function checkClaimedAddress(
	loopbackAddress: string,
	index: number,
	conflictPorts: Map<number, number>,
	warnedConflicts: Set<string>
): Promise<boolean> {
	let conflict: PortConflict | null;
	try {
		conflict = await findConflictingPort(loopbackAddress);
	} catch (error) {
		throw new LoopbackAddressValidationError(loopbackAddress, error as Error);
	}
	if (conflict?.scope === 'address') {
		conflictPorts.set(index, conflict.port);
		const warning = `${loopbackAddress}:${conflict.port}`;
		if (!warnedConflicts.has(warning)) {
			warnedConflicts.add(warning);
			console.warn(
				`[loopback-pool] ${loopbackAddress} is still in use by another Harper node (port ${conflict.port} bound); skipping to avoid an SO_REUSEPORT co-bind.`
			);
		}
		return false;
	}
	if (conflict) {
		if (!foreignListenersAllowed()) throw new ForeignListenerError(loopbackAddress, conflict.port);
		console.warn(
			`[loopback-pool] Another process listens on ${loopbackAddress}:${conflict.port} through a listener on all interfaces; continuing because ${ALLOW_FOREIGN_LISTENERS_ENV} is set. This node's clients reach that process whenever the node has no listener of its own there, and a Harper node still bound to ${loopbackAddress} itself cannot be ruled out.`
		);
		return true;
	}
	// macOS and Windows let the exclusive bind above succeed beside a listener on all interfaces; Linux refuses it.
	if (process.platform === 'linux') return true;

	let shadowedPort: number | null;
	try {
		shadowedPort = await findAcceptingPort(loopbackAddress, FOREIGN_LISTENER_PROBE_PORTS);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (foreignListenersAllowed()) {
			console.warn(
				`[loopback-pool] Could not check ${loopbackAddress} for another process's listener (${reason}); continuing because ${ALLOW_FOREIGN_LISTENERS_ENV} is set.`
			);
			return true;
		}
		throw new LoopbackAddressValidationError(
			loopbackAddress,
			error as Error,
			`Could not check whether another process accepts connections on ${loopbackAddress}'s Harper ports (${reason}). Set ${ALLOW_FOREIGN_LISTENERS_ENV}=1 to skip this check.`
		);
	}
	if (shadowedPort === null) return true;
	if (!foreignListenersAllowed()) throw new ForeignListenerError(loopbackAddress, shadowedPort);
	console.warn(
		`[loopback-pool] Another process accepts connections on ${loopbackAddress}:${shadowedPort}; continuing because ${ALLOW_FOREIGN_LISTENERS_ENV} is set. This node's clients reach that process whenever the node has no listener of its own there.`
	);
	return true;
}

/**
 * Validates the format of a loopback address and extracts the pool index.
 *
 * @param address The loopback address to parse (e.g., "127.0.0.2")
 * @returns The 0-based pool index for this address
 * @throws {InvalidLoopbackAddressError} If the address format is invalid or out of range
 */
function parseLoopbackAddress(address: string): number {
	const parts = address.split('.');
	if (parts.length !== 4 || parts[0] !== '127' || parts[1] !== '0' || parts[2] !== '0') {
		throw new InvalidLoopbackAddressError(address);
	}

	const index = parseInt(parts[3], 10) - HARPER_LOOPBACK_POOL_START;
	if (isNaN(index) || index < 0 || index >= HARPER_LOOPBACK_POOL_COUNT) {
		throw new InvalidLoopbackAddressError(address);
	}

	return index;
}

/**
 * Releases a loopback address back to the pool, making it available for other processes. Only an
 * address this process holds is released.
 *
 * @param address The loopback address to release (e.g., "127.0.0.2")
 * @throws InvalidLoopbackAddressError if the address format is invalid
 */
export async function releaseLoopbackAddress(address: string): Promise<void> {
	parseLoopbackAddress(address);
	const key = claimKey(address);
	const claim = claims.get(key);
	if (!claim) return;
	claims.delete(key);
	await closeClaim(claim);
}

/**
 * Releases all loopback addresses held by the current process.
 * Useful for cleanup during graceful shutdown.
 */
export async function releaseAllLoopbackAddressesForCurrentProcess(): Promise<void> {
	const held = [...claims.values()];
	claims.clear();
	await Promise.all(held.map(closeClaim));
}
