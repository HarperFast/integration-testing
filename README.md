# @harperfast/integration-testing

Integration testing utilities for Harper-based projects. Provides framework-agnostic Harper instance lifecycle management, a concurrent loopback address pool, directory compression utilities, and an optional preconfigured Node.js test runner script.

## Testing Ethos

There are three distinct levels of testing in the Harper ecosystem:

- **Unit** tests validate isolated logic against source or built code directly, relying on mocks or stubs in place of real dependencies.
- **Integration** tests run against the actual Harper software, but locally and ephemerally. Harper is started as a child process for each test suite, given a temporary install directory, and torn down when the suite finishes. There is no remote infrastructure to manage.
- **End-to-end** tests go further: they target a deployment that mirrors production as closely as possible — think a staging environment with real infrastructure, remote systems, and operational configuration.

This project is strictly for **integration** testing.

The distinction matters because integration tests give you confidence in Harper's actual behavior without the cost and complexity of managing a deployed environment. You get the real software, not mocks, but with fast local iteration.

Regardless of the framework or runner used, integration tests should strive to be:

- **Independent**: No dependency on execution order or shared state with other tests
- **Hermetic**: Self-contained with no external side-effects
- **Deterministic**: The same input always produces the same output

These properties are what make safe concurrent execution possible — without them, parallelization produces flaky, order-dependent failures.

## Installation

```sh
npm install --save-dev @harperfast/integration-testing
```

## Framework Agnosticism

The core lifecycle and loopback pool APIs in this package — `startHarper`, `teardownHarper`, `killHarper`, and the loopback utilities — are **not tied to any specific test runner or framework**. They spawn and manage Harper child processes and allocate loopback addresses safely across concurrent processes using a file-based locking mechanism. This means they can be used with any testing framework that supports async setup and teardown: Node.js `node:test`, Vitest, Playwright, or anything else.

The key responsibility these APIs place on you is **thinking critically about Harper instance scope**. Starting a Harper instance has real cost — it spawns a process, allocates a loopback address from the pool, and creates a temporary install directory. How you scope instances depends on your framework and what you're testing. A single instance shared across many assertions in one logical test block may be perfectly appropriate; spinning up a fresh instance for every individual assertion would be wasteful. What matters is that concurrently executing scopes each have their own instance and loopback address — the pool handles cross-process allocation safely, but your setup and teardown hooks determine the boundaries.

This package also includes a **preconfigured Node.js test runner script** (`harper-integration-test-run`) as a recommended, batteries-included way to run tests written with the `node:test` API. It is documented below, and its [source](./src/run.ts) serves as a reference implementation for anyone integrating these utilities with a different runner.

## Setup: Loopback Addresses

Running Harper integration tests concurrently requires multiple loopback addresses so that each Harper instance can bind to a distinct address without port conflicts.

Linux Ubuntu systems have `127.0.0.1–127.255.255.255` enabled by default. macOS and Windows do not.

Use the included script to configure them:

```sh
npx harper-integration-test-setup-loopback
```

This script requires `sudo` and respects the `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT` environment variable (defaults to 32).

## API

The lifecycle and utility APIs below are framework-agnostic. They manage Harper child processes and a cross-process loopback address pool. Use them in the setup/teardown hooks of whichever test framework you prefer.

### `startHarper(ctx, options?)`

Allocates a loopback address from the pool, creates a temporary install directory, starts a Harper process, and waits for it to be ready. Populates `ctx.harper` with the instance details. Call in a setup/`before()` hook.

The Harper binary is resolved in the following order:

1. `harperBinPath` option passed directly to `startHarper()`
2. `HARPER_INTEGRATION_TEST_INSTALL_SCRIPT` environment variable (path to `dist/bin/harper.js`)
3. Auto-resolved from a `harper` package installed as a project dependency

**Options:**

```ts
interface StartHarperOptions {
  startupTimeoutMs?: number;   // Default: 30000 or HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS
  config?: object;             // Harper config overrides (passed via HARPER_SET_CONFIG)
  env?: object;                // Additional environment variables for the Harper process
  harperBinPath?: string;      // Explicit path to dist/bin/harper.js
}
```

**Environment Variables:**

- `HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS` - Default startup timeout
- `HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR` - Parent directory for temp Harper install dirs (default: OS tmpdir)
- `HARPER_INTEGRATION_TEST_INSTALL_SCRIPT` - Path to Harper CLI script

### `setupHarperWithFixture(ctx, fixturePath, options?)`

Like `startHarper()`, but copies a component directory into the Harper install before starting, so it's available on first boot without a deploy.

### `killHarper(ctx)`

Sends SIGTERM to the Harper process and waits for it to exit. Does not release the loopback address or clean up the install directory. Useful for restart scenarios where the test will call `startHarper` again.

### `teardownHarper(ctx)`

Kills Harper, releases the loopback address back to the pool, and removes the install directory. Call in a teardown/`after()` hook.

### `sendOperation(context, operation)`

Helper to POST an operation to the Operations API and assert HTTP 200.

### `createHarperContext(name?)`

Creates a plain object satisfying `HarperTestContext`, for use outside `node:test` (e.g. Playwright worker fixtures). The `name` is optional and used for log directory naming.

```ts
// Playwright example
const ctx = createHarperContext(`worker-${workerInfo.workerIndex}`);
await startHarper(ctx);
```

### Types

There are four related TypeScript types — it helps to understand how they compose.

**`HarperContext`** is the instance data object stored at `ctx.harper` after `startHarper()` resolves. It describes a running Harper instance:

```ts
interface HarperContext {
  dataRootDir: string;          // absolute path to the Harper install directory
  admin: { username: string; password: string };
  httpURL: string;              // e.g. 'http://127.0.0.2:9926'
  operationsAPIURL: string;     // e.g. 'http://127.0.0.2:9925'
  hostname: string;             // e.g. '127.0.0.2'
  process: ChildProcess;
  logDir?: string;              // set when HARPER_INTEGRATION_TEST_LOG_DIR is configured
}
```

**`HarperTestContext`** is the minimal context shape accepted by `startHarper()`, `setupHarperWithFixture()`, `killHarper()`, and `teardownHarper()`. It is intentionally loose so it can be satisfied by a plain object or a `node:test` context:

```ts
interface HarperTestContext {
  name?: string;                // used for log directory naming
  harper?: Partial<HarperContext>;  // populated by startHarper()
}
```

**`StartedHarperTestContext`** is the same as `HarperTestContext` but with `harper` guaranteed to be a fully populated `HarperContext`. It is the return type of `startHarper()` and `setupHarperWithFixture()`, and the required parameter type of `killHarper()` and `teardownHarper()`:

```ts
interface StartedHarperTestContext extends HarperTestContext {
  harper: HarperContext;
}
```

**`ContextWithHarper`** is for `node:test` only. It extends both `SuiteContext` and `TestContext` from `node:test` with `harper: HarperContext`, so you can use it as the typed context parameter in a `suite()` callback:

```ts
// node:test usage
suite('my suite', (ctx: ContextWithHarper) => {
  before(async () => { await startHarper(ctx); });
  after(async () => { await teardownHarper(ctx); });

  test('example', async () => {
    const res = await fetch(ctx.harper.httpURL);
  });
});
```

If you are not using `node:test`, use `createHarperContext()` to create a plain `HarperTestContext` instead.

### Server Log Capture

When `HARPER_INTEGRATION_TEST_LOG_DIR` is set, each Harper instance writes its logs to a per-suite subdirectory. Logs from passing suites are automatically cleaned up; only failing suite logs are retained.

```sh
HARPER_INTEGRATION_TEST_LOG_DIR=/tmp/harper-test-logs npx harper-integration-test-run "integrationTests/**/*.test.ts"
```

### `targz(dirPath)`

Packs and compresses a directory into a base64-encoded tar.gz string. Useful for `deploy_component` Operations API calls.

### Loopback Pool Utilities

These are used internally by `startHarper` and `teardownHarper`, but are exported for advanced use cases or custom runner integrations.

- `validateLoopbackAddressPool(): Promise<{ successful: string[]; failed: { loopbackAddress: string; error: Error }[] }>` - Validates all pool addresses can be bound to
- `getNextAvailableLoopbackAddress(): Promise<string>` - Allocates an address from the pool
- `releaseLoopbackAddress(address: string): Promise<void>` - Returns an address to the pool
- `releaseAllLoopbackAddressesForCurrentProcess(): Promise<void>` - Releases all addresses held by this process

## Node.js Test Runner

> Tests executed by this runner must use the `node:test` API. If you're using a different test framework, use the [lifecycle APIs](#api) directly and refer to the [runner source](./src/run.ts) as a reference implementation.

The included `harper-integration-test-run` script is the recommended way to run Harper integration tests. It is built on the Node.js `node:test` API and handles the concurrency configuration described in the [original parallelization analysis](https://github.com/Ethan-Arrowood/node-test-runner-parallelization-analysis): because each integration test spawns a resource-intensive Harper process, the safe default concurrency is roughly half of available system parallelism rather than Node.js's default of `availableParallelism() - 1`.

The runner executes each test **file** in its own process, which means files are the unit of isolation. For this to work safely and predictably, each test file must adhere to the independent, hermetic, and deterministic properties described in the [Testing Ethos](#testing-ethos). Strictly following these properties enables files to run concurrently without interfering with each other. When a test breaks, that file can be run in isolation to iterate on a fix without re-running everything.

The [Harper integration tests](https://github.com/HarperFast/harper/tree/main/integrationTests) are an open source example of this runner and framework in production use.

### Running Tests

```sh
npx harper-integration-test-run "integrationTests/**/*.test.ts"
```

Or add to your `package.json`:

```json
{
  "scripts": {
    "test:integration": "harper-integration-test-run integrationTests/**/*.test.ts"
  }
}
```

### Runner Options

All CLI arguments can be overridden using the associative `HARPER_INTEGRATION_TEST_*` environment variable.

| CLI Argument | Environment Variable | Default | Description |
|---|---|---|---|
| `--concurrency=N` | `HARPER_INTEGRATION_TEST_CONCURRENCY` | `floor(parallelism/2)+1` | Number of concurrent test processes |
| `--isolation=mode` | `HARPER_INTEGRATION_TEST_ISOLATION` | `process` | `process` or `none` |
| `--shard=index/total` | `HARPER_INTEGRATION_TEST_SHARD` | `1/1` | Test sharding for CI |
| `--only` | `HARPER_INTEGRATION_TEST_ONLY` | `false` | Run only tests marked with `.only` |

Example - run sequentially without loopback pool:

```sh
npx harper-integration-test-run --isolation=none "integrationTests/**/*.test.ts"
```

Example - CI sharding across 4 jobs:

```sh
npm run test:integration -- --shard=1/4
npm run test:integration -- --shard=2/4
npm run test:integration -- --shard=3/4
npm run test:integration -- --shard=4/4
```

### Writing Tests

Test files should be written in ESM TypeScript, end in `.test.ts`, and begin with a comment block describing what they verify. File names should be short and hyphen-separated — e.g., `install.test.ts` or `application-management.test.ts`.

Tests should use `suite`/`describe`, `test`/`it`, and lifecycle methods (`before`, `beforeEach`, `after`, `afterEach`) from `node:test`, with assertions from `node:assert/strict`.

A test file can contain multiple suites. Suites always run **sequentially**. Tests within a suite run **sequentially by default**, but can be made concurrent with `{ concurrency: true }` — in which case each individual test within that suite must itself be independent, hermetic, and deterministic.

Since these tests interact with a running Harper instance, they often validate actual application output: standard streams (`stdout`/`stderr`), network responses, or file system state.

#### Suite Concurrency Example

This file contains two suites with two 1-second tests each. The first suite enables `{ concurrency: true }`, the second does not.

```ts
import { suite, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

suite('Concurrency Enabled', { concurrency: true }, () => {
  test('1 second', async () => {
    await sleep(1000);
  });

  test('1 second', async () => {
    await sleep(1000);
  });
});

suite('Concurrency Disabled', () => {
  test('1 second', async () => {
    await sleep(1000);
  });

  test('1 second', async () => {
    await sleep(1000);
  });
});
```

- The first suite's tests run concurrently → ~1 second
- The second suite's tests run sequentially → ~2 seconds
- Suites always run sequentially → **total ~3 seconds**

```
▶ Concurrency Enabled
  ✔ 1 second (1001.359083ms)
  ✔ 1 second (1001.860375ms)
✔ Concurrency Enabled (1002.26125ms)
▶ Concurrency Disabled
  ✔ 1 second (1001.122166ms)
  ✔ 1 second (1000.5495ms)
✔ Concurrency Disabled (2001.850625ms)
ℹ tests 4
ℹ duration_ms 3087.786041
```

#### Template

```ts
/**
 * Description of what this test file verifies.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

suite('short description', (ctx: ContextWithHarper) => {
  before(async () => {
    await startHarper(ctx);
  });

  after(async () => {
    await teardownHarper(ctx);
  });

  test('test description', async () => {
    const response = await fetch(ctx.harper.httpURL);
    strictEqual(response.status, 200);
  });
});
```

### Using Other Frameworks

The lifecycle APIs work with any framework that supports async setup and teardown. The [runner source](./src/run.ts) is a concrete reference for how the Node.js `node:test` integration is wired up, including concurrency configuration and shard support. Use it as a starting point when building an integration for another framework.

## GitHub Actions Workflow Parallelization

Integration tests should run efficiently and reliably on CI, not just locally. As the number of test files grows — further compounded by verifying multiple operating systems or runtime versions — even a modest test suite can become a large CI operation. The goal is to strike a balance between cost and thoroughness. Tests must always run reliably; correctness is never compromised for speed. Overloaded runners cause flaky failures.

**Default GitHub Actions runners have limited performance.** They can reasonably handle a single integration test, but parallelizing many of them will often exceed the runner's capabilities. A recommended strategy is to **parallelize across multiple runners using workflow matrix jobs** combined with **test sharding** — distributing test files across runners rather than running them all on one.

Larger runners are available but come at a meaningful cost increase. The right trade-off depends on your organization's total CI job volume, since parallel job execution is typically capped at the org level. When wait time for available runners starts to exceed the time saved by parallelization, fewer jobs on larger runners may be more effective.

It's also worth being deliberate about *when* the full integration suite runs. Running every test across all supported configurations on every commit of every open PR can quickly exhaust concurrency limits. Strategies like file path filter triggers, manually triggered workflows, and limiting the full matrix to merge-time checks can keep CI responsive without sacrificing coverage.

A **merge queue** is worth considering for this last point — running the complete matrix only after a PR passes initial checks (e.g., a single configuration), then verifying the full matrix before merge. This allows for faster PR iteration while keeping the main branch thoroughly tested.

The [Harper integration tests workflow](https://github.com/HarperFast/harper/blob/main/.github/workflows/integration-tests.yml) is a real-world example of these strategies in practice.

## License

Apache-2.0
