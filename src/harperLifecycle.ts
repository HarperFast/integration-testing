import { spawn, ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, cp } from 'node:fs/promises';
import { type SuiteContext, type TestContext } from 'node:test';
import { getNextAvailableLoopbackAddress, releaseLoopbackAddress } from './loopbackAddressPool.ts';
import { ok, equal } from 'node:assert';
import { createRequire } from 'node:module';

/**
 * Minimal context interface required by startHarper/teardownHarper.
 *
 * This is intentionally loose so it can be satisfied by:
 * - node:test SuiteContext/TestContext objects (via ContextWithHarper)
 * - Plain objects (e.g. Playwright worker fixtures: `createHarperContext()`)
 */
export interface HarperTestContext {
	/** Optional name used for log directory naming (e.g. suite name or Playwright worker index). */
	name?: string;
	/** Populated by startHarper(). May be pre-seeded with dataRootDir/hostname to reuse across restarts. */
	harper?: Partial<HarperContext>;
}

/**
 * A started context — harper is fully populated after startHarper() resolves.
 */
export interface StartedHarperTestContext extends HarperTestContext {
	harper: HarperContext;
}

/**
 * Creates a plain object satisfying HarperTestContext, for use outside node:test
 * (e.g. as a Playwright worker fixture).
 *
 * @param name Optional name for log directory naming (e.g. Playwright worker index).
 */
export function createHarperContext(name?: string): HarperTestContext {
	return { name };
}

// Constants
const HTTP_PORT = 9926;
const HTTPS_PORT = 9927;
const MQTT_PORT = 1883;
const MQTTS_PORT = 8883;
export const OPERATIONS_API_PORT = 9925;
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'Abc1234!';
export const DEFAULT_STARTUP_TIMEOUT_MS = parseInt(process.env.HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS || '', 10) || 60000;
const LOG_DIR = process.env.HARPER_INTEGRATION_TEST_LOG_DIR;

/**
 * The runtime to use for running Harper during tests.
 * Set via the HARPER_RUNTIME environment variable ('node' or 'bun').
 * Defaults to 'node'.
 */
export const HARPER_RUNTIME: 'node' | 'bun' = (process.env.HARPER_RUNTIME as any) || 'node';

/**
 * Options for setting up a Harper instance.
 */
export interface StartHarperOptions {
	/**
	 * Timeout in milliseconds to wait for Harper to start.
	 * @default 30000
	 */
	startupTimeoutMs?: number;
	/**
	 * Additional configuration options to pass to the Harper CLI.
	 */
	config?: any;
	/**
	 * Environment variables to set when running Harper.
	 */
	env?: any;
	/**
	 * Explicit path to the Harper CLI script (dist/bin/harper.js).
	 * If not provided, resolution order is:
	 *   1. This option
	 *   2. HARPER_INTEGRATION_TEST_INSTALL_SCRIPT environment variable
	 *   3. Auto-resolved from 'harper' package in node_modules
	 */
	harperBinPath?: string;
}

export interface HarperContext {
	/** Absolute path to the Harper installation directory */
	dataRootDir: string;
	/** Admin credentials for the Harper instance */
	admin: {
		/** Admin username (default: 'admin') */
		username: string;
		/** Admin password (default: 'Abc1234!') */
		password: string;
	};
	/** HTTP URL for the Harper instance (e.g., 'http://127.0.0.2:9926') */
	httpURL: string;
	/** Operations API URL (e.g., 'http://127.0.0.2:9925') */
	operationsAPIURL: string;
	/** Assigned loopback IP address (e.g., '127.0.0.2') */
	hostname: string;
	/** Child process for the Harper instance */
	process: ChildProcess;
	/** Absolute path to the log directory for this suite (only set when HARPER_INTEGRATION_TEST_LOG_DIR is configured) */
	logDir?: string;
	/** Captured stdout/stderr from Harper startup, up to the point it reported ready. */
	startupOutput?: { stdout: string; stderr: string };
}

/**
 * Test context interface with Harper instance details, for use with node:test.
 *
 * This interface is populated by `startHarper()` and contains
 * all necessary information to interact with the test Harper instance.
 *
 * For use outside node:test (e.g. Playwright), use `createHarperContext()` to
 * create a plain object satisfying `HarperTestContext` instead.
 */
export interface ContextWithHarper extends SuiteContext, TestContext {
	harper: HarperContext;
}

/**
 * Gets the path to the Harper CLI script.
 *
 * Resolution order:
 * 1. `harperBinPath` argument
 * 2. `HARPER_INTEGRATION_TEST_INSTALL_SCRIPT` environment variable
 * 3. Auto-resolved from 'harper' package in node_modules
 *
 * @returns The absolute path to the Harper CLI entry script
 * @throws {AssertionError} If the script cannot be found
 */
function getHarperScript(harperBinPath?: string): string {
	// 1. Explicit option
	if (harperBinPath) {
		ok(existsSync(harperBinPath), `Harper script not found at provided harperBinPath: ${harperBinPath}`);
		return harperBinPath;
	}

	// 2. Environment variable
	const envPath = process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT;
	if (envPath) {
		ok(
			existsSync(envPath),
			`Harper script not found at HARPER_INTEGRATION_TEST_INSTALL_SCRIPT path: ${envPath}`
		);
		return envPath;
	}

	// 3. Auto-resolve from node_modules
	try {
		const require = createRequire(import.meta.url);
		const resolved = require.resolve('harper/dist/bin/harper.js');
		if (existsSync(resolved)) {
			return resolved;
		}
	} catch {
		// harper package not found in node_modules
	}

	throw new Error(
		`Harper CLI script not found. Provide the path via:\n` +
			`  - harperBinPath option: startHarper(ctx, { harperBinPath: '/path/to/dist/bin/harper.js' })\n` +
			`  - HARPER_INTEGRATION_TEST_INSTALL_SCRIPT environment variable\n` +
			`  - Install 'harper' as a dependency in your project`
	);
}

/**
 * Sanitizes a string for use as a filesystem directory name.
 */
function sanitizeForFilesystem(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9_-]/g, '_')
		.replace(/_+/g, '_')
		.substring(0, 100);
}

/**
 * Error thrown when a Harper process fails to start or times out.
 * Includes captured stdout and stderr for diagnostics.
 */
export class HarperStartupError extends Error {
	stdout: string;
	stderr: string;

	constructor(message: string, stdout: string, stderr: string) {
		let fullMessage = message;
		if (stdout) {
			fullMessage += `\n\nstdout:\n${stdout}`;
		}
		if (stderr) {
			fullMessage += `\n\nstderr:\n${stderr}`;
		}
		super(fullMessage);
		this.name = 'HarperStartupError';
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

interface RunHarperCommandOptions {
	args: string[];
	env: any;
	completionMessage?: string;
	/** When set, stdout and stderr are written to files in this directory */
	logDir?: string;
	harperBinPath?: string;
	/** Timeout in milliseconds to wait for the process to complete or emit the completionMessage. Falls back to DEFAULT_STARTUP_TIMEOUT_MS. */
	timeoutMs?: number;
}

interface RunHarperCommandResult {
	process: ChildProcess;
	/** Captured stdout up to the point the process was considered ready or exited. */
	stdout: string;
	/** Captured stderr up to the point the process was considered ready or exited. */
	stderr: string;
}

/**
 * Runs a Harper CLI command and captures output.
 *
 * When `logDir` is provided, stdout and stderr are also written to files
 * (`stdout.log` and `stderr.log`) in that directory.
 *
 * @throws {HarperStartupError} If the command times out or exits with a non-zero status code
 */
function runHarperCommand({
	args,
	env,
	completionMessage,
	logDir,
	harperBinPath,
	timeoutMs,
}: RunHarperCommandOptions): Promise<RunHarperCommandResult> {
	const harperScript = getHarperScript(harperBinPath);
	const runtime = HARPER_RUNTIME;
	const runtimeArgs =
		runtime === 'bun'
			? [harperScript, ...args]
			: ['--trace-warnings', '--force-node-api-uncaught-exceptions-policy=true', harperScript, ...args];
	const proc = spawn(runtime, runtimeArgs, {
		env: { ...process.env, ...env },
	});

	let stdoutStream: WriteStream | undefined;
	let stderrStream: WriteStream | undefined;
	if (logDir) {
		stdoutStream = createWriteStream(join(logDir, 'stdout.log'));
		stderrStream = createWriteStream(join(logDir, 'stderr.log'));
	}

	const effectiveTimeout = timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let timer = setTimeout(() => {
			reject(new HarperStartupError(
				`Harper process timed out after ${effectiveTimeout}ms`,
				stdout,
				stderr
			));
			proc.kill();
		}, effectiveTimeout);

		proc.stdout?.on('data', (data: Buffer) => {
			const dataString = data.toString();
			if (dataString.includes('[38;5;16m')) {
				// Including the dog logo makes it very difficult to decifer the logs
				return;
			}
			stdoutStream?.write(data);
			if (completionMessage && dataString.includes(completionMessage)) {
				clearTimeout(timer);
				resolve({ process: proc, stdout, stderr });
			}
			stdout += dataString;
		});

		proc.stderr?.on('data', (data: Buffer) => {
			stderrStream?.write(data);
			stderr += data.toString();
		});

		proc.on('error', (error) => {
			reject(error);
		});
		proc.on('exit', (statusCode, signal) => {
			clearTimeout(timer);
			if (statusCode === 0) {
				resolve({ process: proc, stdout, stderr });
			} else {
				const errorMessage = `Harper process failed with exit code/signal ${statusCode ?? signal}`;
				stderrStream?.write(errorMessage);
				reject(new HarperStartupError(errorMessage, stdout, stderr));
			}
			stdoutStream?.end();
			stderrStream?.end();
		});
	});
}

/**
 * Sets up a Harper instance with a component pre-installed from a local directory.
 *
 * Copies `fixturePath` into `{dataRootDir}/components/{name}` before Harper starts,
 * so the component is available on the first request without a post-startup deploy.
 * Use this when tests need a known route available at startup (e.g. mTLS cert tests).
 *
 * @param ctx - The test context to populate with Harper instance details
 * @param fixturePath - Absolute path to the component directory to pre-install
 * @param options - Optional configuration for the setup process
 */
export async function setupHarperWithFixture(
	ctx: HarperTestContext,
	fixturePath: string,
	options?: StartHarperOptions
): Promise<StartedHarperTestContext> {
	const dataRootDirPrefix = join(
		process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(),
		'harper-integration-test-'
	);
	const dataRootDir = await mkdtemp(dataRootDirPrefix);
	await cp(fixturePath, join(dataRootDir, 'components', basename(fixturePath)), { recursive: true });
	ctx.harper = { dataRootDir };
	return startHarper(ctx, options);
}

/**
 * Sets up and starts a Harper instance for testing.
 *
 * @param ctx - The test context to populate with Harper instance details
 * @param options - Optional configuration for the setup process
 * @returns The context with the `harper` property populated
 *
 * @example
 * ```ts
 * suite('My tests', (ctx: ContextWithHarper) => {
 *   before(async () => {
 *     await startHarper(ctx);
 *   });
 *
 *   after(async () => {
 *     await teardownHarper(ctx);
 *   });
 *
 *   test('can connect', async () => {
 *     const response = await fetch(ctx.harper.httpURL);
 *     // ...
 *   });
 * });
 * ```
 */
export async function startHarper(ctx: HarperTestContext, options?: StartHarperOptions): Promise<StartedHarperTestContext> {
	const dataRootDirPrefix = join(
		process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(),
		`harper-integration-test-`
	);
	const dataRootDir = ctx.harper?.dataRootDir ?? (await mkdtemp(dataRootDirPrefix));

	const loopbackAddress = ctx.harper?.hostname ?? (await getNextAvailableLoopbackAddress());

	// Set up per-suite log directory when HARPER_INTEGRATION_TEST_LOG_DIR is configured
	let logDir: string | undefined;
	if (LOG_DIR) {
		const suiteName = sanitizeForFilesystem(ctx.name || 'unknown');
		logDir = join(LOG_DIR, `${suiteName}-${sanitizeForFilesystem(loopbackAddress)}`);
		await mkdir(logDir, { recursive: true });
	}

	// Point Harper's log directory to the suite log dir so hdb.log is preserved for upload
	const config = { ...options?.config };
	if (logDir) {
		config.logging = { ...config.logging, root: logDir };
	}

	const args = [
		`--ROOTPATH=${dataRootDir}`,
		`--AUTHENTICATION_AUTHORIZELOCAL=true`,
		`--HDB_ADMIN_USERNAME=${DEFAULT_ADMIN_USERNAME}`,
		`--HDB_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD}`,
		'--THREADS_COUNT=1',
		'--THREADS_DEBUG=false',
		`--NODE_HOSTNAME=${loopbackAddress}`,
		`--HTTP_PORT=${loopbackAddress}:${HTTP_PORT}`,
		`--OPERATIONSAPI_NETWORK_PORT=${loopbackAddress}:${OPERATIONS_API_PORT}`,
		`--MQTT_NETWORK_PORT=${loopbackAddress}:${MQTT_PORT}`,
		`--MQTT_NETWORK_SECUREPORT=${loopbackAddress}:${MQTTS_PORT}`,
		'--LOGGING_LEVEL=debug',
		'--LOGGING_STDSTREAMS=false',
	];

	// Bind secure port if HTTPS is needed (mTLS or other TLS config present)
	if (options?.config?.http?.mtls !== undefined || options?.config?.tls !== undefined) {
		args.push(`--HTTP_SECUREPORT=${loopbackAddress}:${HTTPS_PORT}`);
	}

	// HARPER_SET_CONFIG must be passed as an environment variable, not a CLI arg,
	// because applyRuntimeEnvVarConfig reads from process.env.HARPER_SET_CONFIG
	const harperEnv = {
		HARPER_SET_CONFIG: JSON.stringify(config),
		...options?.env,
	};

	const result = await runHarperCommand({
		args,
		env: harperEnv,
		completionMessage: 'successfully started',
		logDir,
		harperBinPath: options?.harperBinPath,
		timeoutMs: options?.startupTimeoutMs,
	});

	ctx.harper = {
		dataRootDir,
		admin: {
			username: DEFAULT_ADMIN_USERNAME,
			password: DEFAULT_ADMIN_PASSWORD,
		},
		httpURL: `http://${loopbackAddress}:${HTTP_PORT}`,
		operationsAPIURL: `http://${loopbackAddress}:${OPERATIONS_API_PORT}`,
		hostname: loopbackAddress,
		process: result.process,
		logDir,
		startupOutput: { stdout: result.stdout, stderr: result.stderr },
	};

	return ctx as StartedHarperTestContext;
}

/**
 * Kill harper process (can be used for teardown, or killing it before a restart)
 * @param ctx
 */
export async function killHarper(ctx: StartedHarperTestContext): Promise<void> {
	if (!ctx.harper?.process) return;
	await new Promise<void>((resolve) => {
		let timer: NodeJS.Timeout;
		ctx.harper.process.on('exit', () => {
			resolve();
			clearTimeout(timer);
		});
		ctx.harper.process.kill();
		timer = setTimeout(() => {
			try {
				ctx.harper.process.kill('SIGKILL');
			} catch {
				// possible that the process terminated but the exit event hasn't fired yet
			}
			resolve();
		}, 200);
	});
}

/**
 * Tears down a Harper instance and cleans up all resources.
 *
 * This function stops the Harper instance, releases the loopback address,
 * and removes the installation directory.
 * @param ctx - The test context with Harper instance details
 *
 * @example
 * ```ts
 * suite('My tests', (ctx: ContextWithHarper) => {
 *   before(async () => {
 *     await startHarper(ctx);
 *   });
 *
 *   after(async () => {
 *     await teardownHarper(ctx);
 *   });
 * });
 * ```
 */
export async function teardownHarper(ctx: StartedHarperTestContext): Promise<void> {
	if (!ctx.harper) return;
	await killHarper(ctx);

	await releaseLoopbackAddress(ctx.harper.hostname);

	// a few retries are typically necessary, might take a sec for a process to finish, especially since rocksdb may be flushing
	await rm(ctx.harper.dataRootDir, { recursive: true, force: true, maxRetries: 4 });
}

export async function sendOperation(context: HarperContext, operation: any) {
	const response = await fetch(context.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	const responseData = await response.json();
	equal(response.status, 200, JSON.stringify(responseData));
	return responseData;
}
