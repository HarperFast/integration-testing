import { spawn, spawnSync } from 'node:child_process';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/**
 * Cross-process registry of running Harper test instances, and the singleton monitor process that
 * reaps them.
 *
 * Every Harper instance the harness starts is detached (its own process-group leader) so that a
 * test runner dying without running cleanup — `SIGKILL`, a hard crash, a cancelled CI job — leaves
 * Harper alive holding its fixed ports. Instead of pairing every instance with its own sidecar,
 * each instance publishes explicit metadata here and a single shared monitor (one per registry
 * directory, i.e. per machine by default) reaps whatever is orphaned or overdue.
 *
 * The registry is the contract between the two halves: `harperLifecycle.ts` registers and
 * deregisters instances, `harperMonitor.ts` scans and reaps them. Both agree on tunables through
 * the environment, which the monitor inherits from whichever runner first spawned it.
 *
 * POSIX only. Reaping is `kill(-pgid)`, which Windows has no equivalent for; on Windows
 * registration is skipped and the runner-side cleanup handlers in `harperLifecycle.ts` remain the
 * only protection.
 */

/** Marker passed on the monitor's command line so `ps -ef | grep` finds it. */
export const MONITOR_ARGV_MARKER = '--harper-integration-test-monitor';

/** Marks the environment of a Harper process the harness owns (visible in `/proc/<pid>/environ`). */
export const INSTANCE_ENV_KIND = 'HARPER_IT_KIND';
export const INSTANCE_ENV_KIND_VALUE = 'harper-instance';
export const INSTANCE_ENV_ID = 'HARPER_IT_INSTANCE_ID';
export const INSTANCE_ENV_OWNER_PID = 'HARPER_IT_OWNER_PID';

const LOCK_STALE_TIMEOUT_MS = 10000;
const LOCK_RETRY_DELAY_MS = 50;

let lockTokenCounter = 0;

function envInt(name: string, fallback: number): number {
	const parsed = parseInt(process.env[name] || '', 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * Directory holding the registry, its lock, and the monitor log. Resolved on every call rather
 * than at module load so a test (or a caller isolating a run) can point it somewhere private
 * after import, and so the value the monitor inherits always matches its parent's.
 *
 * Override with `HARPER_INTEGRATION_TEST_MONITOR_DIR`.
 */
export function getRegistryDir(): string {
	return process.env.HARPER_INTEGRATION_TEST_MONITOR_DIR || join(tmpdir(), 'harper-integration-test-monitor');
}

export function getRegistryPath(): string {
	return join(getRegistryDir(), 'registry.json');
}

function getLockPath(): string {
	return join(getRegistryDir(), 'registry.lock');
}

export function getMonitorLogPath(): string {
	return join(getRegistryDir(), 'monitor.log');
}

/** How often the monitor rescans the registry. Default 2s. */
export function getMonitorScanIntervalMs(): number {
	return envInt('HARPER_INTEGRATION_TEST_MONITOR_INTERVAL_MS', 2000);
}

/** How long the registry must stay empty before the monitor shuts itself down. Default 60s. */
export function getMonitorIdleExitMs(): number {
	return envInt('HARPER_INTEGRATION_TEST_MONITOR_IDLE_MS', 60000);
}

/** Grace period between the monitor's `SIGTERM` and its `SIGKILL` escalation. Default 5s. */
export function getReapGraceMs(): number {
	return envInt('HARPER_INTEGRATION_TEST_MONITOR_REAP_GRACE_MS', 5000);
}

/**
 * Backstop lifetime for a registered instance. The sharp signal is owner death; this only catches
 * the pathological case where the runner's PID was recycled by a long-lived process, so it is
 * deliberately far longer than any plausible suite. Default 4h.
 */
export function getInstanceMaxLifetimeMs(): number {
	return envInt('HARPER_INTEGRATION_TEST_INSTANCE_MAX_LIFETIME_MS', 4 * 60 * 60 * 1000);
}

/** Whether instances should be registered with a monitor at all. */
export function isInstanceMonitorEnabled(): boolean {
	return process.platform !== 'win32' && process.env.HARPER_INTEGRATION_TEST_MONITOR !== 'off';
}

/** Identifies a process well enough to survive PID reuse: the PID plus its wall-clock start time. */
export interface ProcessIdentity {
	pid: number;
	/**
	 * `ps` start time (e.g. `Mon Aug 24 09:09:38 2026`). Absolute wall clock, so it stays valid
	 * across reboots, unlike the boot-relative tick counts in `/proc`. Undefined when `ps` was
	 * unavailable, in which case liveness degrades to a plain PID check.
	 */
	startTime?: string;
}

export interface HarperInstanceRecord extends ProcessIdentity {
	/** Stable id, also exported to the process as `HARPER_IT_INSTANCE_ID`. */
	id: string;
	/** The test runner that started this instance; its death is what makes the instance an orphan. */
	owner: ProcessIdentity;
	/** Loopback address the instance was assigned, for diagnostics in the monitor log. */
	hostname?: string;
	registeredAt: number;
	/** Wall-clock deadline after which the monitor reaps the instance regardless of owner liveness. */
	expiresAt: number;
}

export interface InstanceRegistry {
	/** The monitor currently responsible for this registry, if any. */
	monitor?: ProcessIdentity;
	instances: HarperInstanceRecord[];
}

/**
 * Reads the wall-clock start time of each PID in a single `ps` call.
 *
 * Absence from the result means the PID does not exist. A present-but-different value means the
 * PID was recycled — the case that makes a bare `kill(-pgid)` dangerous, since the group we
 * recorded may now belong to something unrelated.
 */
export function readProcessStartTimes(pids: number[]): Map<number, string> {
	const startTimes = new Map<number, string>();
	const uniquePids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
	if (uniquePids.length === 0) return startTimes;
	const result = spawnSync('ps', ['-o', 'pid=,lstart=', '-p', uniquePids.join(',')], { encoding: 'utf8' });
	// A non-zero status just means none of the PIDs exist; only a missing `ps` is worth noticing,
	// and there the empty map degrades callers to a plain PID check rather than reporting deaths.
	if (result.error || typeof result.stdout !== 'string') return startTimes;
	for (const line of result.stdout.split('\n')) {
		const parsed = line.trim().match(/^(\d+)\s+(.*\S)$/);
		if (parsed) startTimes.set(Number(parsed[1]), parsed[2]);
	}
	return startTimes;
}

export function readProcessIdentity(pid: number): ProcessIdentity {
	return { pid, startTime: readProcessStartTimes([pid]).get(pid) };
}

/**
 * Whether `identity` still refers to the same live process, given start times already collected
 * for this scan. When `ps` produced nothing at all (no start times for any PID) we cannot
 * distinguish "gone" from "unmeasurable", so fall back to a signal-0 existence check.
 */
export function isSameProcessAlive(identity: ProcessIdentity, startTimes: Map<number, string>): boolean {
	const currentStartTime = startTimes.get(identity.pid);
	if (currentStartTime === undefined) return startTimes.size === 0 && pidExists(identity.pid);
	return identity.startTime === undefined || identity.startTime === currentStartTime;
}

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else — still alive.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Acquires the registry lock, mirroring the `wx` create-or-fail mutex the loopback pool uses.
 * Critical sections here are a read/modify/write of one small file, so the retry delay is much
 * shorter than the pool's.
 */
async function acquireLock(): Promise<string> {
	const lockPath = getLockPath();
	const token = `${process.pid}-${++lockTokenCounter}-${Math.random().toString(36).slice(2)}`;
	await mkdir(getRegistryDir(), { recursive: true });
	while (true) {
		try {
			const lockFileHandle = await open(lockPath, 'wx');
			await lockFileHandle.writeFile(token);
			await lockFileHandle.close();
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			try {
				const lockFileStat = await stat(lockPath);
				// A holder that died mid-section would otherwise wedge every runner on the machine.
				if (Date.now() - lockFileStat.mtimeMs > LOCK_STALE_TIMEOUT_MS) await unlink(lockPath);
			} catch {
				// Another process removed it first; just retry.
			}
			await sleep(LOCK_RETRY_DELAY_MS);
		}
	}
}

export async function withRegistryLock<T>(callback: () => Promise<T>): Promise<T> {
	const token = await acquireLock();
	try {
		return await callback();
	} finally {
		try {
			// Release only a lock we still hold. A critical section that overran the stale timeout has
			// already been superseded, and unlinking then would remove the *new* holder's lock and let
			// a third process into the section alongside it.
			if ((await readFile(getLockPath(), 'utf-8')) === token) await unlink(getLockPath());
		} catch {
			// Already released (e.g. reclaimed as stale).
		}
	}
}

/**
 * Reads the registry. Only call while holding the lock. An absent file reads as empty — the first
 * registration on this machine, or a registry directory someone cleared. `writeRegistryFile`
 * publishes by rename, so a half-written file is never observable here.
 */
export async function readRegistryFile(): Promise<InstanceRegistry> {
	let contents: string;
	try {
		contents = await readFile(getRegistryPath(), 'utf-8');
	} catch (error) {
		// Only a missing file means an empty registry. Every other read failure has to propagate:
		// reporting one as empty is what turns a transient problem into the caller writing that
		// emptiness back, erasing live instances other runners are relying on us to reap.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { instances: [] };
		throw error;
	}
	let parsed: InstanceRegistry;
	try {
		parsed = JSON.parse(contents) as InstanceRegistry;
	} catch (error) {
		throw new Error(
			`Harper instance registry at ${getRegistryPath()} is not valid JSON (delete it to reset monitoring): ${(error as Error).message}`
		);
	}
	return { monitor: parsed.monitor, instances: Array.isArray(parsed.instances) ? parsed.instances : [] };
}

let pendingWriteCounter = 0;

/**
 * Writes the registry. Only call while holding the lock.
 *
 * Publishes by writing a complete file alongside the registry and renaming it into place, so
 * readers only ever see the old registry or the new one. Writing the live file in place would
 * truncate it first, and a writer that died in that window — the `SIGKILL` this whole mechanism
 * exists to survive — would leave torn JSON that `readRegistryFile` reads as an empty registry,
 * discarding every reap target on the machine including other runners'.
 *
 * The pending file's name is unique per write, because a fixed one could be truncated underneath
 * us by a second writer that reclaimed the lock as stale — reintroducing exactly the tearing the
 * rename removes. A writer killed between the two steps leaves its pending file behind; it is
 * inert, and lives in a directory that is already per-machine scratch.
 */
export async function writeRegistryFile(registry: InstanceRegistry): Promise<void> {
	await mkdir(getRegistryDir(), { recursive: true });
	const registryPath = getRegistryPath();
	const pendingPath = `${registryPath}.${process.pid}.${++pendingWriteCounter}.pending`;
	try {
		await writeFile(pendingPath, JSON.stringify(registry));
		await rename(pendingPath, registryPath);
	} catch (error) {
		await unlink(pendingPath).catch(() => {});
		throw error;
	}
}

function getMonitorScript(): string {
	const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
	return fileURLToPath(new URL(`./harperMonitor.${extension}`, import.meta.url));
}

/**
 * Starts a monitor. Safe to call speculatively: a monitor that finds a live one already recorded
 * in the registry exits immediately, so a race between two runners costs one short-lived process
 * rather than a second reaper.
 *
 * Detached and unref'd so it outlives the runner that happened to start it — the whole point is to
 * still be there when that runner dies.
 */
function spawnMonitor(): void {
	try {
		const monitor = spawn(process.execPath, [getMonitorScript(), MONITOR_ARGV_MARKER], {
			detached: true,
			stdio: 'ignore',
			env: process.env,
		});
		monitor.on('error', (error) => {
			console.warn(`[harper-monitor] Failed to start the Harper instance monitor: ${error.message}`);
		});
		monitor.unref();
	} catch (error) {
		console.warn(`[harper-monitor] Failed to start the Harper instance monitor: ${(error as Error).message}`);
	}
}

let instanceCounter = 0;

/**
 * Environment markers identifying a Harper process as harness-owned. The registry is the
 * authoritative list; these make an individual process self-describing for anyone inspecting it
 * directly (`tr '\0' '\n' < /proc/<pid>/environ | grep HARPER_IT_`).
 */
export function buildInstanceEnv(instanceId: string): Record<string, string> {
	return {
		[INSTANCE_ENV_KIND]: INSTANCE_ENV_KIND_VALUE,
		[INSTANCE_ENV_ID]: instanceId,
		[INSTANCE_ENV_OWNER_PID]: String(process.pid),
	};
}

/** Allocates the id used for both the instance's environment markers and its registry record. */
export function nextInstanceId(): string {
	return `${process.pid}-${++instanceCounter}`;
}

/**
 * Registers a running Harper instance with the shared monitor, starting one if none is live.
 *
 * The liveness check and the insert happen in a single critical section, which is what keeps the
 * monitor's idle shutdown from racing a new registration: the monitor only exits while holding the
 * lock with an empty registry, so either we see it alive and it sees our instance, or we see it
 * gone and start a replacement.
 */
export async function registerHarperInstance(instance: {
	id: string;
	pid: number;
	hostname?: string;
}): Promise<void> {
	if (!isInstanceMonitorEnabled()) return;
	const startTimes = readProcessStartTimes([instance.pid, process.pid]);
	const now = Date.now();
	const record: HarperInstanceRecord = {
		id: instance.id,
		pid: instance.pid,
		startTime: startTimes.get(instance.pid),
		owner: { pid: process.pid, startTime: startTimes.get(process.pid) },
		hostname: instance.hostname,
		registeredAt: now,
		expiresAt: now + getInstanceMaxLifetimeMs(),
	};

	const monitorNeeded = await withRegistryLock(async () => {
		const registry = await readRegistryFile();
		registry.instances = registry.instances.filter((existing) => existing.id !== record.id);
		registry.instances.push(record);
		await writeRegistryFile(registry);
		return !(registry.monitor && isSameProcessAlive(registry.monitor, readProcessStartTimes([registry.monitor.pid])));
	});

	// Outside the lock: the monitor claims its slot under the same lock and would otherwise wait
	// out our critical section before it could start.
	if (monitorNeeded) spawnMonitor();
}

/**
 * Removes an instance from the registry after normal teardown.
 *
 * Best-effort — a record left behind by an abrupt exit is pruned by the monitor as soon as the
 * Harper PID is gone, so a missed deregistration costs a log line, not a stale reap target.
 */
export async function deregisterHarperInstance(id: string): Promise<void> {
	if (!isInstanceMonitorEnabled()) return;
	try {
		await withRegistryLock(async () => {
			const registry = await readRegistryFile();
			const remaining = registry.instances.filter((instance) => instance.id !== id);
			if (remaining.length === registry.instances.length) return;
			registry.instances = remaining;
			await writeRegistryFile(registry);
		});
	} catch (error) {
		console.warn(`[harper-monitor] Failed to deregister Harper instance ${id}: ${(error as Error).message}`);
	}
}

/**
 * Signals a whole process group. Instances are spawned detached, so the instance PID is also its
 * process-group id and this reaches Harper plus anything it spawned.
 */
export function signalProcessGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// The group is already gone.
	}
}
