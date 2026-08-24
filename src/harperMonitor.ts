import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	getMonitorIdleExitMs,
	getMonitorLogPath,
	getMonitorScanIntervalMs,
	getReapGraceMs,
	getRegistryPath,
	isSameProcessAlive,
	readProcessIdentity,
	readProcessStartTimes,
	readRegistryFile,
	signalProcessGroup,
	withRegistryLock,
	writeRegistryFile,
	type HarperInstanceRecord,
} from './harperInstanceRegistry.ts';

/**
 * The singleton Harper instance monitor.
 *
 * One of these runs per registry directory, shared by every concurrent test runner on the machine.
 * It periodically scans the registry written by `harperLifecycle.ts` and reaps any instance whose
 * owning runner has died or which has outlived its budget, then shuts itself down once the
 * registry has been empty long enough. See `harperInstanceRegistry.ts` for the shared contract.
 *
 * Runs detached with no stdio, so diagnostics go to `monitor.log` in the registry directory.
 */

const scanIntervalMs = getMonitorScanIntervalMs();
const idleExitMs = getMonitorIdleExitMs();
const reapGraceMs = getReapGraceMs();

/** Instances already sent `SIGTERM`, mapped to the time we escalate to `SIGKILL`. */
const escalationDeadlines = new Map<string, number>();
let idleSince: number | undefined;
let running = true;

async function log(message: string): Promise<void> {
	try {
		await appendFile(getMonitorLogPath(), `${new Date().toISOString()} [${process.pid}] ${message}\n`);
	} catch {
		// The registry directory is gone; the next loop iteration notices and shuts us down.
	}
}

/**
 * Takes ownership of the registry, or reports that someone else already has it.
 *
 * Two runners starting at once can each decide a monitor is needed; the loser exits here rather
 * than double-reaping. Recording our own identity (not just our PID) means a later monitor can
 * tell "still running" from "PID recycled".
 */
async function claimMonitorSlot(): Promise<boolean> {
	// A registrant always writes the registry before starting us, so a missing file means the run
	// we were spawned for was already torn down. Stand down rather than recreate its directory.
	if (!existsSync(getRegistryPath())) return false;
	return withRegistryLock(async () => {
		const registry = await readRegistryFile();
		const existing = registry.monitor;
		if (existing && isSameProcessAlive(existing, readProcessStartTimes([existing.pid]))) return false;
		registry.monitor = readProcessIdentity(process.pid);
		await writeRegistryFile(registry);
		return true;
	});
}

/** Gives up ownership so the next registration starts a fresh monitor rather than trusting a dead one. */
async function releaseMonitorSlot(): Promise<void> {
	try {
		await withRegistryLock(async () => {
			const registry = await readRegistryFile();
			if (registry.monitor?.pid !== process.pid) return;
			delete registry.monitor;
			await writeRegistryFile(registry);
		});
	} catch {
		// Best-effort: a stale slot is detected by the liveness check on the next registration.
	}
}

interface ReapTarget {
	instance: HarperInstanceRecord;
	reason: string;
}

/**
 * Prunes records whose process is gone and returns the ones that should be reaped.
 *
 * Reaped instances stay in the registry until their process actually disappears, so a monitor
 * killed mid-grace leaves a target its successor picks straight back up.
 */
async function scanRegistry(): Promise<{ live: HarperInstanceRecord[]; targets: ReapTarget[] }> {
	return withRegistryLock(async () => {
		const registry = await readRegistryFile();
		const startTimes = readProcessStartTimes(
			registry.instances.flatMap((instance) => [instance.pid, instance.owner.pid])
		);
		const live: HarperInstanceRecord[] = [];
		const targets: ReapTarget[] = [];
		const now = Date.now();
		for (const instance of registry.instances) {
			if (!isSameProcessAlive(instance, startTimes)) continue;
			live.push(instance);
			if (!isSameProcessAlive(instance.owner, startTimes)) {
				targets.push({ instance, reason: `owning runner ${instance.owner.pid} is gone` });
			} else if (now > instance.expiresAt) {
				targets.push({
					instance,
					reason: `exceeded its ${Math.round((instance.expiresAt - instance.registeredAt) / 1000)}s lifetime budget`,
				});
			}
		}
		if (live.length !== registry.instances.length) {
			registry.instances = live;
			await writeRegistryFile(registry);
		}
		return { live, targets };
	});
}

/**
 * Terminates an instance's process group: `SIGTERM` first so Harper can flush and release its
 * ports cleanly, escalating to `SIGKILL` on a later scan if it is still alive after the grace
 * period. Killing by group id is safe here because the record's start time already proved the
 * group leader is the process we registered, not a recycled PID.
 */
async function reap({ instance, reason }: ReapTarget): Promise<void> {
	const escalateAt = escalationDeadlines.get(instance.id);
	if (escalateAt === undefined) {
		await log(`Reaping Harper ${instance.pid}${instance.hostname ? ` (${instance.hostname})` : ''}: ${reason}. SIGTERM.`);
		escalationDeadlines.set(instance.id, Date.now() + reapGraceMs);
		signalProcessGroup(instance.pid, 'SIGTERM');
		return;
	}
	if (Date.now() < escalateAt) return;
	await log(`Harper ${instance.pid} survived SIGTERM for ${reapGraceMs}ms; escalating to SIGKILL.`);
	// Push the next escalation past this scan's horizon so a process stuck in D-state does not
	// produce a SIGKILL (and a log line) on every tick.
	escalationDeadlines.set(instance.id, Date.now() + reapGraceMs);
	signalProcessGroup(instance.pid, 'SIGKILL');
}

/** Shuts down once the registry has been empty for the idle window, under the lock so a concurrent registration wins. */
async function exitIfIdle(): Promise<boolean> {
	if (idleSince === undefined || Date.now() - idleSince < idleExitMs) return false;
	const released = await withRegistryLock(async () => {
		const registry = await readRegistryFile();
		if (registry.instances.length > 0) return false;
		if (registry.monitor?.pid === process.pid) delete registry.monitor;
		await writeRegistryFile(registry);
		return true;
	});
	if (!released) idleSince = undefined;
	return released;
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
	process.once(signal, () => {
		running = false;
		void releaseMonitorSlot().then(() => process.exit(0));
	});
}

if (!(await claimMonitorSlot())) process.exit(0);
await log(`Monitor started (scan ${scanIntervalMs}ms, idle exit ${idleExitMs}ms, reap grace ${reapGraceMs}ms).`);

while (running) {
	// Someone removed the registry out from under us (a cleaned-up run, or a developer clearing
	// tmp): there is nothing left to supervise, and recreating it would strand an empty directory.
	if (!existsSync(getRegistryPath())) process.exit(0);
	try {
		const { live, targets } = await scanRegistry();
		for (const id of escalationDeadlines.keys()) {
			if (!live.some((instance) => instance.id === id)) escalationDeadlines.delete(id);
		}
		for (const target of targets) await reap(target);

		if (live.length > 0) idleSince = undefined;
		else idleSince ??= Date.now();
		if (await exitIfIdle()) {
			await log('Monitor exiting: no registered Harper instances.');
			process.exit(0);
		}
	} catch (error) {
		// Never let one bad scan take the monitor down — it is the last line of defence against
		// orphaned instances, and the next scan may well succeed.
		await log(`Scan failed: ${(error as Error).stack || (error as Error).message}`);
	}
	await sleep(scanIntervalMs);
}
