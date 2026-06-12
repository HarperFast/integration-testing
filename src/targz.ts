import { pack } from 'tar-fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

/**
 * Packs and compresses a directory into a base64-encoded tar.gz string.
 *
 * @param dirPath path to directory to pack and compress
 */
export async function targz(dirPath: string): Promise<string> {
	const chunks: Uint8Array[] = [];
	// pipeline() propagates errors from any stage (e.g. pack() failing on a missing dir) and
	// destroys the whole chain on failure, so the returned promise always settles.
	await pipeline(pack(dirPath), createGzip(), async (source) => {
		for await (const chunk of source) chunks.push(chunk as Uint8Array);
	});
	return Buffer.concat(chunks).toString('base64');
}
