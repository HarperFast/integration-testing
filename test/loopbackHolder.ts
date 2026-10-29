import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/loopbackHolder.ts', import.meta.url));
const PID_NAMESPACE_COMMAND = ['unshare', '--user', '--map-root-user', '--pid', '--fork', '--mount-proc'];

export interface HolderOutcome {
	address?: string;
	error?: string;
	pid: number;
}

export interface Holder {
	child: ChildProcess;
	/** Resolves once the child has loaded the pool; rejects if it exits first. */
	ready: Promise<void>;
	/** The allocation's outcome; rejects if the child exits without one. */
	outcome: Promise<HolderOutcome>;
	go(): void;
	/** Ends stdin, which makes the holder exit, and waits for it. */
	stop(): Promise<void>;
	kill(): Promise<void>;
}

export interface HolderOptions {
	env?: Record<string, string>;
	waitForGo?: boolean;
	/** Run the holder in its own PID namespace (Linux; see {@link pidNamespaceUnavailable}). */
	pidNamespace?: boolean;
}

/** A process that allocates from the pool with the parent's pool settings plus `env`. */
export function startHolder({ env = {}, waitForGo = false, pidNamespace = false }: HolderOptions = {}): Holder {
	const args = [FIXTURE, ...(waitForGo ? ['--wait-for-go'] : [])];
	const [command, ...commandArgs] = pidNamespace ? [...PID_NAMESPACE_COMMAND, process.execPath, ...args] : [process.execPath, ...args];
	const child = spawn(command, commandArgs, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
	const exited = once(child, 'exit');
	let resolveReady!: () => void;
	let resolveOutcome!: (outcome: HolderOutcome) => void;
	const ready = new Promise<void>((resolve) => (resolveReady = resolve));
	const outcome = new Promise<HolderOutcome>((resolve) => (resolveOutcome = resolve));
	createInterface({ input: child.stdout! }).on('line', (line) => {
		const message = JSON.parse(line);
		if (message.ready) resolveReady();
		else resolveOutcome(message);
	});
	const exitedEarly = exited.then(([code]) => {
		throw new Error(`the holder exited (code ${code}) before reporting`);
	});
	const readyOrExit = Promise.race([ready, exitedEarly]);
	const outcomeOrExit = Promise.race([outcome, exitedEarly]);
	// A caller that stops at the first rejection would otherwise leave the other one unhandled.
	readyOrExit.catch(() => {});
	outcomeOrExit.catch(() => {});
	return {
		child,
		ready: readyOrExit,
		outcome: outcomeOrExit,
		go: () => child.stdin!.write('go\n'),
		async stop() {
			child.stdin!.end();
			if (child.exitCode === null && child.signalCode === null) await exited;
		},
		async kill() {
			child.kill('SIGKILL');
			if (child.exitCode === null && child.signalCode === null) await exited;
		},
	};
}

/** Why a holder cannot run in its own PID namespace here, or false when it can. */
export function pidNamespaceUnavailable(): string | false {
	if (process.platform !== 'linux') return 'PID namespaces are Linux-only';
	const probe = spawnSync(PID_NAMESPACE_COMMAND[0], [...PID_NAMESPACE_COMMAND.slice(1), 'true'], { encoding: 'utf8' });
	if (probe.error) return `cannot run unshare: ${probe.error.message}`;
	if (probe.status !== 0) return `unshare cannot create a PID namespace here: ${probe.stderr.trim()}`;
	return false;
}
