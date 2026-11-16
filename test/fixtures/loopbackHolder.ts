// A pool client in its own process. Prints `{"ready":true}` once the pool is loaded, waits for a line on stdin when
// run with --wait-for-go, then prints the allocation's outcome as one JSON line and holds it until stdin ends.
import { createInterface } from 'node:readline';
import { getNextAvailableLoopbackAddress } from '../../src/loopbackAddressPool.ts';

const lines = createInterface({ input: process.stdin });
lines.once('close', () => process.exit(0));
console.log(JSON.stringify({ ready: true }));
if (process.argv.includes('--wait-for-go')) await new Promise((resolve) => lines.once('line', resolve));
try {
	console.log(JSON.stringify({ address: await getNextAvailableLoopbackAddress(), pid: process.pid }));
} catch (error) {
	console.log(JSON.stringify({ error: (error as Error).name, pid: process.pid }));
}
