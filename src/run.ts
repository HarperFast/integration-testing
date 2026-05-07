#!/usr/bin/env node
import { run } from 'node:test';
import { availableParallelism, tmpdir } from 'node:os';
import { spec } from 'node:test/reporters';
import { parseArgs } from 'node:util';
import { validateLoopbackAddressPool } from './loopbackAddressPool.ts';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readFileSync, rmSync, existsSync } from 'node:fs';

/**
 * Important! This script should not be required to execute integration tests.

 * Thus, it should not be responsible for any stateful management or setup/teardown logic.
 * All such logic should be contained within the individual test suites or utility functions.
 * Tests (individuals or multiples) should be executable directly via the Node.js Test Runner CLI and
 * parallelization should still work.
 *
 * The main purpose of this script is to reduce the boilerplate required to run integration tests, or having
 * developers manually specify CLI arguments each time.
 *
 * This script configures and runs the Node.js Test Runner with sensible defaults for Harper integration tests.
 *
 * It supports environment variables to override defaults, allowing flexibility for CI environments or specific use cases.
 *
 * Usage: harper-integration-test-run [options] <glob-pattern> [<glob-pattern> ...]
 *
 * At least one glob pattern positional argument is required.
 */

// Imitating the Node.js Test Runner CLI arguments for consistency except we drop the `test-` prefix
const { values, positionals } = parseArgs({
	options: {
		concurrency: { type: 'string' },
		isolation: { type: 'string' },
		shard: { type: 'string' },
		only: { type: 'boolean' },
	},
	allowPositionals: true,
});

if (positionals.length === 0) {
	console.error(
		'Error: At least one glob pattern is required.\n' +
			'Usage: harper-integration-test-run [options] <glob-pattern> [<glob-pattern> ...]\n' +
			'Example: harper-integration-test-run "integrationTests/**/*.test.ts"'
	);
	process.exit(1);
}

// https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-concurrency
const concurrencyOption = process.env.HARPER_INTEGRATION_TEST_CONCURRENCY || values.concurrency
const CONCURRENCY = concurrencyOption
	? parseInt(concurrencyOption, 10) 
	: Math.max(1, Math.floor(availableParallelism() / 2) + 1);
// https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-isolationmode
const ISOLATION = process.env.HARPER_INTEGRATION_TEST_ISOLATION || values.isolation || 'process';
// https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-shard
const [SHARD_INDEX, SHARD_TOTAL] = (process.env.HARPER_INTEGRATION_TEST_SHARD || values.shard || '1/1')
	.split('/')
	.map((v) => parseInt(v, 10));
// https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-only
const ONLY = parseBoolean(process.env.HARPER_INTEGRATION_TEST_ONLY) ?? values.only ?? false;

const TEST_FILES = positionals;

// Loopback Address Check
if (ISOLATION !== 'none' && CONCURRENCY > 1) {
	const result = await validateLoopbackAddressPool();
	if (result.failed.length > 0) {
		console.error('Failed to bind loopback address pool required for integration tests:');
		for (const failure of result.failed) {
			console.error(`- ${failure.loopbackAddress}: ${failure.error.message}`);
		}
		console.error(
			'Run the setup script to configure loopback addresses:\n' +
				'  harper-integration-test-setup-loopback\n' +
				'Or run integration tests sequentially using `--isolation=none` to avoid this requirement.'
		);
		process.exit(1);
	}
}

let createdTempLogDir: string | undefined;
if (!process.env.HARPER_INTEGRATION_TEST_LOG_DIR) {
	createdTempLogDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-logs-'));
	process.env.HARPER_INTEGRATION_TEST_LOG_DIR = createdTempLogDir;
}

const fileToLogDirs = new Map<string, Set<string>>();
const failedFiles = new Set<string>();

const runner = run({
	concurrency: ISOLATION === 'none' ? undefined : CONCURRENCY,
	// @ts-expect-error - ignore until we do better env var / cli arg handling/validation
	isolation: ISOLATION,
	globPatterns: TEST_FILES,
	only: ONLY,
	shard: {
		index: SHARD_INDEX,
		total: SHARD_TOTAL,
	},
});

runner.on('test:stdout', (data: any) => {
	const msg = data.message;
	if (typeof msg === 'string' && msg.includes('[Harper] Logs for this instance will be stored in:')) {
		const match = msg.match(/\[Harper\] Logs for this instance will be stored in: (.*)/);
		if (match && data.file) {
			const logDir = match[1].trim();
			const normalizedFile = resolve(data.file);
			let dirs = fileToLogDirs.get(normalizedFile);
			if (!dirs) {
				dirs = new Set();
				fileToLogDirs.set(normalizedFile, dirs);
			}
			dirs.add(logDir);
		}
	}
});

runner.on('test:fail', (data: any) => {
	process.exitCode = 1;
	if (data.file && data.details?.type === 'test') {
		failedFiles.add(resolve(data.file));
	}
});

// @ts-expect-error - spec reporter type compatibility
runner.compose(spec).pipe(process.stdout);

process.on('exit', () => {
	if (failedFiles.size > 0) {
		console.log('\n\n' + '='.repeat(80));
		console.log('--- TEST FAILURES DETECTED: HARPER LOGS ---');
		console.log('='.repeat(80));

		for (const file of failedFiles) {
			const dirs = fileToLogDirs.get(file);
			if (dirs && dirs.size > 0) {
				for (const dir of dirs) {
					const hdbLogPath = join(dir, 'hdb.log');
					if (existsSync(hdbLogPath)) {
						try {
							const content = readFileSync(hdbLogPath, 'utf8');
							// Capture the last 200 lines to avoid spamming the console too much, but enough to see context
							const lines = content.split('\n');
							const lastLines = lines.slice(-200).join('\n');
							console.log(`\n--- Log for instance in ${file} ---`);
							console.log(`Directory: ${dir}`);
							console.log('-'.repeat(80));
							console.log(lastLines);
							console.log('-'.repeat(80));
						} catch (e) {
							console.error(`Failed to read log file ${hdbLogPath}:`, e);
						}
					}
				}
			}
		}
	}

	if (createdTempLogDir) {
		try {
			rmSync(createdTempLogDir, { recursive: true, force: true });
		} catch (e) {
			console.error(`Failed to clean up temporary log directory ${createdTempLogDir}:`, e);
		}
	}
});

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (value.toLowerCase() === 'true' || value === '1') return true;
	if (value.toLowerCase() === 'false' || value === '0') return false;
	return undefined;
}
