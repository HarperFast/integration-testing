import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export interface ChildListener {
	/** Stops the child and fills its accept queue, so the next connection's handshake never completes. */
	stall(): Promise<void>;
	close(): Promise<void>;
}

/**
 * A listener in a child process with a one-connection backlog. Stopping the child (SIGSTOP, so POSIX
 * only) and filling that backlog makes the kernel drop further handshakes instead of completing them.
 */
export async function startChildListener(host: string, port: number): Promise<ChildListener> {
	const child = spawn(
		process.execPath,
		[
			'-e',
			`require('node:net').createServer().listen({ host: ${JSON.stringify(host)}, port: ${port}, backlog: 1 }, () => console.log('listening'))`,
		],
		{ stdio: ['ignore', 'pipe', 'inherit'] }
	);
	await new Promise<void>((resolve, reject) => {
		child.once('exit', (code) => reject(new Error(`listener on ${host}:${port} exited with ${code}`)));
		child.stdout!.on('data', (data) => {
			if (String(data).includes('listening')) resolve();
		});
	});
	const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
	const fillers: Socket[] = [];
	return {
		async stall() {
			child.kill('SIGSTOP');
			for (let attempt = 0; attempt < 32; attempt++) {
				const socket = connect({ host: connectHost, port });
				socket.on('error', () => {});
				fillers.push(socket);
				const connected = await Promise.race([once(socket, 'connect').then(() => true), sleep(1000).then(() => false)]);
				if (!connected) return;
			}
			throw new Error(`the accept queue of ${host}:${port} never filled`);
		},
		async close() {
			for (const socket of fillers) socket.destroy();
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, 'exit');
				child.kill('SIGKILL');
				await exited;
			}
		},
	};
}
