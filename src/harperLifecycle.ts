import { spawn, ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, cp } from 'node:fs/promises';
import { type SuiteContext, type TestContext } from 'node:test';
import { getNextAvailableLoopbackAddress, releaseLoopbackAddress } from './loopbackAddressPool.ts';
import { waitForPortsFree } from './portUtils.ts';
import { ok, equal } from 'node:assert';
import { createRequire } from 'node:module';
import {
	buildInstanceEnv,
	deregisterHarperInstance,
	nextInstanceId,
	registerHarperInstance,
} from './harperInstanceRegistry.ts';

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

/** Every fixed port a Harper test instance may bind, all on its assigned loopback address. */
const ALL_HARPER_PORTS = [OPERATIONS_API_PORT, HTTP_PORT, HTTPS_PORT, MQTT_PORT, MQTTS_PORT];

/** Whether we appear to be running in CI (most CI providers set CI=true). */
const IS_CI = !!process.env.CI;

/**
 * Maximum time to wait between chunks of Harper startup output before treating the process
 * as hung. The startup watchdog resets this window on every chunk of output, so the limit is
 * time-since-last-progress rather than total boot time: a slow-but-healthy boot that keeps
 * logging never trips it — only true silence does. Higher under CI, matching
 * {@link DEFAULT_STARTUP_MAX_MS}'s CI scaling — shared/contended runners can go quiet between
 * log lines for longer without actually being hung (e.g. native module load/RocksDB open
 * competing with sibling concurrently-booting Harper instances for CPU).
 *
 * Override with `HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS`. Default 60s (150s under CI).
 */
export const DEFAULT_STARTUP_TIMEOUT_MS =
	parseInt(process.env.HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS || '', 10) || (IS_CI ? 150000 : 60000);

/**
 * Absolute ceiling on total startup time, regardless of ongoing output — a generous backstop
 * so a process that chatters forever without ever reporting ready still fails. Higher under CI,
 * where shared/contended runners boot more slowly.
 *
 * Override with `HARPER_INTEGRATION_TEST_STARTUP_MAX_MS`. Default 120s (300s under CI).
 */
export const DEFAULT_STARTUP_MAX_MS = parseInt(process.env.HARPER_INTEGRATION_TEST_STARTUP_MAX_MS || '', 10) || (IS_CI ? 300000 : 120000);

/**
 * Grace period after SIGTERM before escalating to SIGKILL during teardown, giving Harper time
 * to shut down cleanly (flush RocksDB, release ports, reap worker children).
 *
 * Override with `HARPER_INTEGRATION_TEST_TEARDOWN_GRACE_MS`. Default 5s.
 */
export const DEFAULT_TEARDOWN_GRACE_MS = parseInt(process.env.HARPER_INTEGRATION_TEST_TEARDOWN_GRACE_MS || '', 10) || 5000;

/**
 * Time teardown's safety assertion waits for Harper's fixed ports to be free before recycling the
 * loopback address. Killing Harper's process tree (and waiting for exit) should free them
 * immediately, so this normally returns on the first check; it only matters if a child process
 * escaped the kill. If the ports are still in use at the deadline, the address is recycled anyway
 * (no worse than not waiting) and a warning is logged.
 *
 * Override with `HARPER_INTEGRATION_TEST_PORT_RELEASE_TIMEOUT_MS`. Default 5s.
 */
export const DEFAULT_PORT_RELEASE_TIMEOUT_MS = parseInt(process.env.HARPER_INTEGRATION_TEST_PORT_RELEASE_TIMEOUT_MS || '', 10) || 5000;

/** Short backstop wait for the process 'exit' event after sending SIGKILL during teardown. */
const SIGKILL_EXIT_WAIT_MS = 1000;

/**
 * The runtime to use for running Harper during tests.
 * Set via the HARPER_RUNTIME environment variable ('node' or 'bun').
 * Defaults to 'node'.
 */
export const HARPER_RUNTIME: 'node' | 'bun' = (process.env.HARPER_RUNTIME as any) || 'node';

/**
 * Marker emitted on stdout by startHarper() so the test runner (run.ts) can map
 * a Harper instance's log directory to the currently executing test file via
 * the node:test `test:stdout` event.
 */
export const LOG_DIR_MARKER_PREFIX = '[Harper] Logs for this instance will be stored in:';

/**
 * Options for setting up a Harper instance.
 */
export interface StartHarperOptions {
	/**
	 * Maximum time (ms) to wait between chunks of startup output before treating Harper as hung.
	 * Resets on every chunk of output, so it bounds silence rather than total boot time.
	 * Falls back to {@link DEFAULT_STARTUP_TIMEOUT_MS} (60s locally, 150s under CI).
	 */
	startupTimeoutMs?: number;
	/**
	 * Absolute ceiling (ms) on total startup time, regardless of ongoing output.
	 * Falls back to {@link DEFAULT_STARTUP_MAX_MS} (120s locally, 300s under CI).
	 */
	startupMaxMs?: number;
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

/**
 * Build the environment for the spawned Harper child process. Exported for testing.
 *
 * `HOME`/`USERPROFILE` are applied LAST so the dataRootDir isolation always takes precedence over
 * caller-supplied `env` (and over a spread of `process.env`, which contains HOME) — otherwise a caller could
 * clobber it and re-expose the developer's real home. The isolation keeps Harper's global boot pointer
 * (`$HOME/.harperdb/hdb_boot_properties.file`) and generated license keys inside the throwaway dataRootDir:
 * cleaned up with it, never touching the real home, and isolated across concurrent suites. On first start
 * Harper records its rootPath in that global boot file and — with an explicit `--ROOTPATH` — never overwrites
 * it again; teardown removes only dataRootDir, so without this isolation the developer's real `~/.harperdb`
 * would be left pointing at a since-deleted temp install, silently breaking the next `harper dev`/`harper run`
 * anywhere on the machine.
 */
export function buildHarperChildEnv(dataRootDir: string, config: any, env?: any): Record<string, string | undefined> {
	return {
		HARPER_SET_CONFIG: JSON.stringify(config),
		...env,
		HOME: dataRootDir,
		USERPROFILE: dataRootDir,
	};
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
	/** Child process handle for the Harper instance */
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
 * 4. Auto-resolved from current directory or ancestors ('dist/bin/harper.js')
 *
 * @returns The absolute path to the Harper CLI entry script
 * @throws {AssertionError} If the script cannot be found
 */
function getHarperScript(harperBinPath?: string): string {
	// 1. Explicit option
	if (harperBinPath) {
		ok(existsSync(harperBinPath), `Harper script not found at provided harperBinPath: ${harperBinPath}`);
		return logResolvedHarperScript(harperBinPath, 'harperBinPath option');
	}

	// 2. Environment variable
	const envPath = process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT;
	if (envPath) {
		ok(
			existsSync(envPath),
			`Harper script not found at HARPER_INTEGRATION_TEST_INSTALL_SCRIPT path: ${envPath}`
		);
		return logResolvedHarperScript(envPath, 'HARPER_INTEGRATION_TEST_INSTALL_SCRIPT');
	}

	// 3. Auto-resolve from node_modules
	try {
		const require = createRequire(import.meta.url);
		const resolved = require.resolve('harper/dist/bin/harper.js');
		if (existsSync(resolved)) {
			return logResolvedHarperScript(resolved, 'node_modules');
		}
	} catch {
		// harper package not found in node_modules
	}

	// 4. Auto-resolve from current directory or ancestors
	let currentDir = process.cwd();
	while (true) {
		const potentialPath = join(currentDir, 'dist/bin/harper.js');
		if (existsSync(potentialPath)) {
			return logResolvedHarperScript(potentialPath, 'ancestor dist');
		}
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			break;
		}
		currentDir = parentDir;
	}

	throw new Error(
		`Harper CLI script not found. Provide the path via:\n` +
			`  - harperBinPath option: startHarper(ctx, { harperBinPath: '/path/to/dist/bin/harper.js' })\n` +
			`  - HARPER_INTEGRATION_TEST_INSTALL_SCRIPT environment variable\n` +
			`  - Install 'harper' as a dependency in your project\n` +
			`  - Run tests within a directory containing 'dist/bin/harper.js'`
	);
}

const loggedHarperScripts = new Set<string>();

/**
 * Logs which Harper binary was resolved and how, once per distinct path.
 *
 * Which binary runs is the single most consequential (and previously invisible)
 * decision the harness makes: resolving a stale `harper` package from
 * node_modules while the caller expected their local build produces confusing
 * wholesale test failures with no hint of the cause. When the `node_modules`
 * path wins while `./dist/bin/harper.js` also exists, warn with the override.
 */
function logResolvedHarperScript(scriptPath: string, source: string): string {
	if (loggedHarperScripts.has(scriptPath)) return scriptPath;
	loggedHarperScripts.add(scriptPath);
	console.log(`[integration-testing] Using Harper at ${scriptPath} (via ${source})`);
	if (source === 'node_modules') {
		// Mirror resolution step 4's ancestor walk so the warning fires even when
		// tests run from a subdirectory of the repo that holds the local build.
		let currentDir = process.cwd();
		while (true) {
			const localDist = join(currentDir, 'dist/bin/harper.js');
			if (existsSync(localDist) && localDist !== scriptPath) {
				console.warn(
					`[integration-testing] Warning: resolved the 'harper' package from node_modules, but ${localDist} also exists. ` +
						`If you meant to test the local build, set HARPER_INTEGRATION_TEST_INSTALL_SCRIPT=${localDist}.`
				);
				break;
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
	}
	return scriptPath;
}

/**
 * Strips ANSI escape sequences (colors, bold, underline, cursor movement, etc.) from a string.
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;
function stripAnsi(str: string): string {
	return str.replace(ANSI_REGEX, '');
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
	/** Idle timeout (ms): max time between output chunks before treating the process as hung. Resets on output. Falls back to DEFAULT_STARTUP_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Absolute timeout (ms): ceiling on total time regardless of output. Falls back to DEFAULT_STARTUP_MAX_MS. */
	maxMs?: number;
	/** Loopback address this instance is bound to; recorded with the instance monitor for diagnostics. */
	hostname?: string;
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
 *
 * Exported for unit testing; not part of the public API (not re-exported from `index.ts`).
 */
export function runHarperCommand({
	args,
	env,
	completionMessage,
	logDir,
	harperBinPath,
	timeoutMs,
	maxMs,
	hostname,
}: RunHarperCommandOptions): Promise<RunHarperCommandResult> {
	const harperScript = getHarperScript(harperBinPath);
	const runtime = HARPER_RUNTIME;
	const runtimeArgs =
		runtime === 'bun'
			? [harperScript, ...args]
			: ['--trace-warnings', '--force-node-api-uncaught-exceptions-policy=true', harperScript, ...args];
	const instanceId = nextInstanceId();
	const proc = spawn(runtime, runtimeArgs, {
		env: { ...process.env, ...env, ...buildInstanceEnv(instanceId) },
		// On POSIX, run Harper as its own process-group leader so both teardown and the shared
		// instance monitor can signal the whole group (parent + any worker children), not just the
		// direct child. Windows has no process groups; killHarper uses `taskkill /T` there instead.
		// stdio stays piped (not detached), and we never unref, so output capture and lifetime
		// management are unchanged.
		detached: process.platform !== 'win32',
	});

	// Publishes the instance to the shared monitor, which reaps it if this runner dies without
	// running cleanup, and installs the runner-side handlers covering cooperative exits.
	const trackedProcess = trackHarperProcess(proc, instanceId, hostname);

	let stdoutStream: WriteStream | undefined;
	let stderrStream: WriteStream | undefined;
	if (logDir) {
		stdoutStream = createWriteStream(join(logDir, 'stdout.log'));
		stderrStream = createWriteStream(join(logDir, 'stderr.log'));
	}

	const idleTimeoutMs = timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
	const maxTimeoutMs = maxMs ?? DEFAULT_STARTUP_MAX_MS;

	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		let readinessDetected = false;
		let idleTimer: NodeJS.Timeout;
		let maxTimer: NodeJS.Timeout;

		const clearTimers = () => {
			clearTimeout(idleTimer);
			clearTimeout(maxTimer);
		};

		const failStartup = (message: string) => {
			if (settled) return;
			settled = true;
			clearTimers();
			reject(new HarperStartupError(message, stdout, stderr));
			// Harper is the detached group leader, so reap the whole group rather than only it.
			signalHarperTree(proc, 'SIGKILL');
		};

		const succeed = () => {
			if (settled || readinessDetected) return;
			readinessDetected = true;
			// Left armed across registration, these would let registry-lock contention time out — and
			// kill — an instance that already booted successfully.
			clearTimers();
			// Resolve only once the instance is durably registered, so a runner killed the moment
			// startHarper returns still leaves the monitor a record to act on. Registration always
			// settles: `acquireLock` is bounded and `trackHarperProcess` absorbs its failures.
			void trackedProcess.registered.then(() => {
				if (settled) return;
				settled = true;
				resolve({ process: proc, stdout, stderr });
			});
		};

		// Startup ends at readiness, not at resolution: the watchdog and the `startupOutput` snapshot
		// both stop here, while resolution waits on registration for a little longer.
		const startupFinished = () => settled || readinessDetected;

		// Reset on every chunk of output so the limit is time-since-last-progress, not total boot
		// time: a slow-but-healthy boot that keeps logging never trips it, only true silence does.
		const resetIdleTimer = () => {
			if (startupFinished()) return;
			clearTimeout(idleTimer);
			idleTimer = setTimeout(
				() => failStartup(`Harper produced no startup output for ${idleTimeoutMs}ms before reporting ready (likely hung)`),
				idleTimeoutMs
			);
		};

		// Absolute backstop, regardless of ongoing output.
		maxTimer = setTimeout(
			() => failStartup(`Harper did not report ready within the maximum startup time of ${maxTimeoutMs}ms`),
			maxTimeoutMs
		);
		resetIdleTimer();

		proc.stdout?.on('data', (data: Buffer) => {
			const dataString = stripAnsi(data.toString());
			stdoutStream?.write(dataString);
			// Once ready, keep streaming logs to disk but stop the watchdog and capture: the
			// returned startupOutput is a snapshot taken at readiness, and the server may run
			// (and log) for the rest of the suite.
			if (startupFinished()) return;
			resetIdleTimer();
			stdout += dataString;
			// Match against the accumulated output, not just this chunk, so a marker split across
			// two stream chunks is still detected.
			if (completionMessage && stdout.includes(completionMessage)) {
				succeed();
			}
		});

		proc.stderr?.on('data', (data: Buffer) => {
			const dataString = stripAnsi(data.toString());
			stderrStream?.write(dataString);
			if (startupFinished()) return;
			resetIdleTimer();
			stderr += dataString;
		});

		proc.on('error', (error) => {
			if (settled) return;
			settled = true;
			clearTimers();
			// 'exit' won't fire for a failed spawn, so close the log streams here to avoid leaking FDs.
			stdoutStream?.end();
			stderrStream?.end();
			reject(error);
		});
		proc.on('exit', (statusCode, signal) => {
			if (!settled) {
				settled = true;
				clearTimers();
				if (statusCode === 0) {
					resolve({ process: proc, stdout, stderr });
				} else {
					const errorMessage = `Harper process failed with exit code/signal ${statusCode ?? signal}`;
					stderrStream?.write(errorMessage);
					reject(new HarperStartupError(errorMessage, stdout, stderr));
				}
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
	assertHarperTestContext(ctx, 'setupHarperWithFixture', START_FROM_THE_CONTEXT);
	const dataRootDirPrefix = join(
		process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(),
		'harper-integration-test-'
	);
	const dataRootDir = await mkdtemp(dataRootDirPrefix);
	await cp(fixturePath, join(dataRootDir, 'components', basename(fixturePath)), { recursive: true, dereference: true });
	publishHarperNode(ctx, { dataRootDir });
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
	assertHarperTestContext(ctx, 'startHarper', START_FROM_THE_CONTEXT);
	const dataRootDirPrefix = join(
		process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(),
		`harper-integration-test-`
	);
	const dataRootDir = ctx.harper?.dataRootDir ?? (await mkdtemp(dataRootDirPrefix));

	const loopbackAddress = ctx.harper?.hostname ?? (await getNextAvailableLoopbackAddress());

	// Set up per-suite log directory when HARPER_INTEGRATION_TEST_LOG_DIR is configured
	const logDirEnv = process.env.HARPER_INTEGRATION_TEST_LOG_DIR;
	let logDir: string | undefined;
	if (logDirEnv) {
		const suiteName = sanitizeForFilesystem(ctx.name || 'unknown');
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		logDir = join(logDirEnv, `${suiteName}-${sanitizeForFilesystem(loopbackAddress)}-${timestamp}`);
		await mkdir(logDir, { recursive: true });

		// Output for the test runner (e.g. run.ts) to map this log dir to the current test file
		process.stdout.write(`${LOG_DIR_MARKER_PREFIX} ${logDir}\n`);
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

	// HARPER_SET_CONFIG must be passed as an environment variable, not a CLI arg, because
	// applyRuntimeEnvVarConfig reads from process.env.HARPER_SET_CONFIG. buildHarperChildEnv also isolates the
	// child's HOME into dataRootDir so Harper's global boot pointer never lands in the developer's real home.
	const harperEnv = buildHarperChildEnv(dataRootDir, config, options?.env);

	const result = await runHarperCommand({
		args,
		env: harperEnv,
		completionMessage: 'successfully started',
		logDir,
		harperBinPath: options?.harperBinPath,
		timeoutMs: options?.startupTimeoutMs,
		maxMs: options?.startupMaxMs,
		hostname: loopbackAddress,
	});

	publishHarperNode(ctx, {
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
	});

	return ctx as StartedHarperTestContext;
}

function signalWindowsProcessTree(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
	const args = ['/pid', String(pid), '/T'];
	if (signal === 'SIGKILL') args.push('/F');
	spawn('taskkill', args, { stdio: 'ignore' }).on('error', () => {});
}

/**
 * Signals Harper's entire process tree, not just the direct child.
 *
 * Harper is the detached POSIX process-group leader, with anything it spawns in that group, so a
 * negative PID reaches the whole tree. Windows has no process groups, so `taskkill /T` is used
 * there. Errors are best-effort because the target may already have exited.
 */
function signalHarperTree(proc: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
	const pid = proc.pid;
	if (pid === undefined) return;
	if (process.platform === 'win32') {
		try {
			signalWindowsProcessTree(pid, signal);
		} catch {
			try {
				proc.kill(signal);
			} catch {
				// process already gone
			}
		}
		return;
	}
	try {
		// Negative PID => signal the whole process group (proc is the group leader via `detached`).
		process.kill(-pid, signal);
	} catch {
		// Group already gone, or (defensively) not a group leader — fall back to the direct child.
		try {
			proc.kill(signal);
		} catch {
			// process already gone
		}
	}
}

interface TrackedHarperProcess {
	/** Settles once the instance is recorded with the shared monitor (or registration was skipped). */
	registered: Promise<void>;
}

/**
 * Tracks live Harper processes so that if the test runner exits or is interrupted before teardown
 * runs (Ctrl+C, or a CI job killing the runner), their process trees are reaped instead of left
 * orphaned holding the fixed ports. Harper is spawned detached (its own process group), so it
 * would otherwise survive signals delivered to the runner's group.
 *
 * These parent-side hooks cover every exit the runner can still run JavaScript for. Death it
 * cannot observe — `SIGKILL`, a hard crash, a cancelled CI job — is covered by the shared instance
 * monitor, which reaps whatever the registry says is orphaned. See `harperInstanceRegistry.ts`.
 */
const liveHarperProcesses = new Set<ChildProcess>();
let runnerCleanupRegistered = false;

function trackHarperProcess(proc: ChildProcess, instanceId: string, hostname?: string): TrackedHarperProcess {
	liveHarperProcesses.add(proc);
	// A failed spawn leaves no PID and nothing to reap; the caller rejects on the 'error' event.
	const registered =
		proc.pid === undefined
			? Promise.resolve()
			: registerHarperInstance({ id: instanceId, pid: proc.pid, hostname }).catch((error: Error) => {
					console.warn(`[harper-monitor] Failed to register Harper instance ${instanceId}: ${error.message}`);
				});
	const trackedProcess: TrackedHarperProcess = { registered };

	proc.once('exit', () => {
		liveHarperProcesses.delete(proc);
		// Chained on registration so a fast exit cannot deregister before the record exists. Best
		// effort either way: the monitor prunes records whose process is gone.
		void registered.then(() => deregisterHarperInstance(instanceId));
	});

	if (runnerCleanupRegistered) return trackedProcess;
	runnerCleanupRegistered = true;

	const reapAll = () => {
		for (const child of liveHarperProcesses) signalHarperTree(child, 'SIGKILL');
	};
	process.once('exit', reapAll);
	// These signals don't fire 'exit'; reap, then re-raise so the runner still terminates normally.
	const cleanupSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
	if (process.platform !== 'win32') cleanupSignals.push('SIGHUP');
	for (const signal of cleanupSignals) {
		process.once(signal, () => {
			reapAll();
			process.kill(process.pid, signal);
		});
	}
	return trackedProcess;
}

/** Identifies the objects published as `ctx.harper`; a shallow copy of a node does not carry it. */
const HARPER_NODE = Symbol('harperNode');

/**
 * The one place a node becomes `ctx.harper`, so every published node carries the brand.
 * Exported for tests, not from `index.ts`.
 */
export function publishHarperNode(ctx: HarperTestContext, node: Partial<HarperContext>): void {
	ctx.harper = markHarperNode(node);
}

/** Exported for tests, not from `index.ts`. */
export function markHarperNode<T extends object>(node: T): T {
	return Object.defineProperty(node, HARPER_NODE, { value: true, enumerable: false });
}

/**
 * Rejects the node where the context belongs. Brand rather than field names: this runs when
 * `ctx.harper` is falsy, the same path a failed `before` hook takes, so rejecting on a name a
 * caller's own context might use (`hostname`, `httpURL`, `process`) would bury the real error.
 */
function assertHarperTestContext(ctx: unknown, fnName: string, remedy: string): void {
	if (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx)) {
		// An array reaches the no-op the same way a node does: `[a, b].harper` is undefined.
		const isArray = Array.isArray(ctx);
		const received = ctx === null ? 'null' : isArray ? 'an array' : typeof ctx;
		const advice = isArray ? ' Pass each context separately.' : '';
		throw new TypeError(`${fnName}(ctx) requires a test context object, received ${received}.${advice}`);
	}
	if (HARPER_NODE in ctx) {
		throw new TypeError(`${fnName}(ctx) expects the test context, but received the Harper node it holds. ${remedy}`);
	}
}

/**
 * Remedies are per-direction, not generated from the function name: telling a caller who reached a
 * *start* function with a live node to wrap it would have them overwrite `ctx.harper` and abandon the
 * instance already running on it.
 */
const WRAP_THE_NODE = (fnName: string) =>
	`Wrap it: ${fnName}({ harper: node }) — otherwise the node keeps running until the runner exits.`;
const START_FROM_THE_CONTEXT =
	'Pass the context the node came from. Starting from the node itself would publish a fresh one over it and abandon the instance already running.';

/**
 * Kill harper process (can be used for teardown, or killing it before a restart).
 *
 * Sends SIGTERM to Harper's whole process tree first and gives it a grace period to shut down
 * cleanly (flush RocksDB, release ports, reap worker children) before escalating to SIGKILL.
 * After SIGKILL it waits briefly for the process to actually exit, so callers can rely on it
 * being gone — and, since a dead process releases its listening sockets, on its ports being free.
 *
 * @param ctx
 * @param options.graceMs Time to wait after SIGTERM before sending SIGKILL. Defaults to
 *   {@link DEFAULT_TEARDOWN_GRACE_MS}.
 */
export async function killHarper(ctx: StartedHarperTestContext, options?: { graceMs?: number }): Promise<void> {
	assertHarperTestContext(ctx, 'killHarper', WRAP_THE_NODE('killHarper'));
	const proc = ctx.harper?.process;
	if (!proc) return;
	// Already exited — nothing to do.
	if (proc.exitCode !== null || proc.signalCode !== null) return;

	const graceMs = options?.graceMs ?? DEFAULT_TEARDOWN_GRACE_MS;

	await new Promise<void>((resolve) => {
		let done = false;
		let sigkillTimer: NodeJS.Timeout;
		let backstopTimer: NodeJS.Timeout;

		const finish = () => {
			if (done) return;
			done = true;
			proc.off('exit', finish);
			clearTimeout(sigkillTimer);
			clearTimeout(backstopTimer);
			resolve();
		};

		proc.once('exit', finish);

		// Ask the whole Harper tree to shut down cleanly first.
		signalHarperTree(proc, 'SIGTERM');

		// If it hasn't exited within the grace period, force-kill the tree and wait briefly for the
		// 'exit' event before resolving (with a backstop in case it never fires).
		sigkillTimer = setTimeout(() => {
			signalHarperTree(proc, 'SIGKILL');
			backstopTimer = setTimeout(finish, SIGKILL_EXIT_WAIT_MS);
		}, graceMs);
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
	assertHarperTestContext(ctx, 'teardownHarper', WRAP_THE_NODE('teardownHarper'));
	if (!ctx.harper) return;
	await killHarper(ctx);

	// Safety assertion: killHarper waits for Harper's process tree to exit, which releases its
	// listening sockets, so the fixed ports should already be free here. We still verify before
	// recycling the address (the pool only guarantees the *address* is bindable, not that these
	// specific ports are free) and warn if anything is somehow still holding them — that warning
	// is a signal that a Harper child process escaped the tree kill, not normal operation. The
	// address is recycled regardless.
	if (ctx.harper.hostname) {
		const portsFreed = await waitForPortsFree(ctx.harper.hostname, ALL_HARPER_PORTS, DEFAULT_PORT_RELEASE_TIMEOUT_MS);
		if (portsFreed) {
			await releaseLoopbackAddress(ctx.harper.hostname);
		} else {
			// A Harper child escaped the tree kill and still holds this address's ports. Do NOT
			// recycle the address — under SO_REUSEPORT a later suite could silently co-bind it
			// (the exact failure the loopback pool exists to prevent). Leave the slot parked under
			// this process's PID; it is reclaimed when this (per-file) process exits and its PID
			// goes dead. The conflict canary in getNextAvailableLoopbackAddress is the backstop if
			// the address is somehow handed out before then.
			console.warn(
				`Harper ports on ${ctx.harper.hostname} still in use after teardown (${DEFAULT_PORT_RELEASE_TIMEOUT_MS}ms); NOT recycling the address (a Harper child outlived the kill). The slot will be reclaimed when this process exits.`
			);
		}
	}

	// a few retries are typically necessary, might take a sec for a process to finish, especially since rocksdb may be flushing
	try {
		await rm(ctx.harper.dataRootDir, { recursive: true, force: true, maxRetries: 10 });
	} catch(error) {
		console.error('Error removing directory', error);
	}
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
