import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';

const SUPERVISOR_FAILURE_EXIT_CODE = 70;
const LIVENESS_FD = 3;

type SupervisorMessage =
	| { type: 'harper-spawn'; pid: number }
	| { type: 'harper-exit' };

const [runtime, ...runtimeArgs] = process.argv.slice(2);
if (!runtime) {
	process.stderr.write('[harper-supervisor] Missing Harper runtime\n');
	process.exit(SUPERVISOR_FAILURE_EXIT_CODE);
}

let harperProcess: ChildProcess | undefined;
let harperExited = false;
let terminatingTree = false;

function sendToRunner(message: SupervisorMessage, callback?: () => void): void {
	if (!process.send || !process.connected) {
		callback?.();
		return;
	}
	try {
		process.send(message, (error: Error | null) => {
			if (error) process.stderr.write(`[harper-supervisor] Failed to notify runner: ${error.message}\n`);
			callback?.();
		});
	} catch (error) {
		process.stderr.write(`[harper-supervisor] Failed to notify runner: ${(error as Error).message}\n`);
		callback?.();
	}
}

function terminateHarperTree(): never {
	if (terminatingTree || harperExited) process.exit(SUPERVISOR_FAILURE_EXIT_CODE);
	terminatingTree = true;
	const harperPid = harperProcess?.pid;
	if (process.platform === 'win32') {
		if (harperPid !== undefined) {
			spawnSync('taskkill', ['/pid', String(harperPid), '/T', '/F'], { stdio: 'ignore' });
		}
		process.exit(SUPERVISOR_FAILURE_EXIT_CODE);
	}
	try {
		process.kill(-process.pid, 'SIGKILL');
	} catch {
		if (harperPid !== undefined) {
			try {
				process.kill(harperPid, 'SIGKILL');
			} catch {
				// The Harper process already exited.
			}
		}
	}
	process.exit(SUPERVISOR_FAILURE_EXIT_CODE);
}

function reportUnexpectedFailure(reason: unknown): never {
	const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
	process.stderr.write(`[harper-supervisor] ${message}\n`);
	terminateHarperTree();
}

process.on('uncaughtExceptionMonitor', reportUnexpectedFailure);
process.on('unhandledRejection', reportUnexpectedFailure);
process.once('exit', () => {
	if (!harperExited) terminateHarperTree();
});

const forwardedSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
if (process.platform !== 'win32') forwardedSignals.push('SIGHUP');
for (const signal of forwardedSignals) {
	process.on(signal, () => {
		if (!harperExited) harperProcess?.kill(signal);
	});
}

// The runner is the only holder of the peer endpoint, so EOF is delivered even when it cannot run cleanup code.
const runnerLiveness = new Socket({ fd: LIVENESS_FD, readable: true, writable: false });
runnerLiveness.unref();
runnerLiveness.once('end', terminateHarperTree);
runnerLiveness.once('close', terminateHarperTree);
runnerLiveness.on('error', (error) => {
	process.stderr.write(`[harper-supervisor] Runner-liveness pipe error: ${error.message}\n`);
});
process.channel?.unref();

let spawnedHarperProcess: ChildProcess;
try {
	spawnedHarperProcess = spawn(runtime, runtimeArgs, {
		stdio: ['inherit', 'inherit', 'inherit', 'ignore', 'ignore'],
	});
} catch (error) {
	reportUnexpectedFailure(error);
}
harperProcess = spawnedHarperProcess;

spawnedHarperProcess.once('spawn', () => {
	const harperPid = harperProcess?.pid;
	if (harperPid !== undefined) sendToRunner({ type: 'harper-spawn', pid: harperPid });
});
spawnedHarperProcess.once('error', (error) => {
	process.stderr.write(`[harper-supervisor] Failed to spawn Harper: ${error.message}\n`);
	harperExited = true;
	process.exit(SUPERVISOR_FAILURE_EXIT_CODE);
});
spawnedHarperProcess.once('exit', (statusCode, signal) => {
	harperExited = true;
	const finish = () => {
		if (signal) {
			process.removeAllListeners(signal);
			process.kill(process.pid, signal);
		} else {
			process.exit(statusCode ?? SUPERVISOR_FAILURE_EXIT_CODE);
		}
	};
	sendToRunner({ type: 'harper-exit' }, finish);
});
