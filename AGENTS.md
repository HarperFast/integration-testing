# Agent Guidelines: @harperfast/integration-testing

This is the `@harperfast/integration-testing` package — a framework-agnostic library for running Harper integration tests locally and ephemerally. It manages Harper child process lifecycles, allocates loopback addresses safely across concurrent test processes, and provides an optional preconfigured Node.js test runner script.

## Repository Structure

```
src/
  harperLifecycle.ts      # startHarper, teardownHarper, killHarper, setupHarperWithFixture, sendOperation
  loopbackAddressPool.ts  # Cross-process file-locked loopback address pool
  run.ts                  # harper-integration-test-run CLI script (node:test runner)
  targz.ts                # Directory compression utility
  index.ts                # Public exports
scripts/
  setup-loopback.sh       # sudo script to configure loopback addresses on macOS/Windows
dist/                     # Compiled output (do not edit)
```

## Development

**Build:**
```sh
npm run build   # tsc -p tsconfig.build.json
```

**Type-check only:**
```sh
npm run check   # tsc
```

There are no tests in this package itself. Validation is via type-checking and by using the package in dependent projects (e.g., `harperfast/harper/integrationTests`).

**Requirements:** Node.js ≥ 20 (dev: ≥ 22), npm.

## Key Concepts

### Testing Ethos

See [README.md#testing-ethos](./README.md#testing-ethos). This package is strictly for **integration** tests — Harper runs as a real child process, not a mock. Tests must be:

- **Independent** — no shared state or ordering dependencies
- **Hermetic** — no external side effects
- **Deterministic** — same inputs, same outputs

These properties are what make safe concurrent execution possible.

### Loopback Address Pool

Each concurrent Harper instance needs a distinct IP to avoid port conflicts. The pool tracks `127.0.0.1–127.0.0.N` (default N=32) in a JSON file at `$TMPDIR/harper-integration-test-loopback-pool.json`, protected by a file-based lock at `$TMPDIR/harper-integration-test-loopback-pool.lock`.

On macOS/Windows, these addresses are not enabled by default. Run setup first:
```sh
npx harper-integration-test-setup-loopback
```

The pool is managed transparently by `startHarper`/`teardownHarper`. The exported pool utilities (`getNextAvailableLoopbackAddress`, `releaseLoopbackAddress`, etc.) are for advanced or custom runner use only.

### Harper Binary Resolution

`startHarper()` resolves the Harper binary in this order:
1. `harperBinPath` option passed to `startHarper()`
2. `HARPER_INTEGRATION_TEST_INSTALL_SCRIPT` env var
3. Auto-resolved from `harper` package in `node_modules`

## Public API

All exports are re-exported from `src/index.ts`. See [README.md#api](./README.md#api) for full documentation.

**Lifecycle functions** (framework-agnostic):
- `startHarper(ctx, options?)` — allocates loopback address, creates temp dir, starts Harper, resolves when ready
- `setupHarperWithFixture(ctx, fixturePath, options?)` — like `startHarper` but pre-installs a component directory
- `killHarper(ctx)` — sends SIGTERM, waits for exit; does NOT release loopback or clean up install dir
- `teardownHarper(ctx)` — kills Harper, releases loopback address, removes install dir
- `sendOperation(context, operation)` — POST to Operations API, asserts HTTP 200
- `createHarperContext(name?)` — creates a plain `HarperTestContext` for use outside `node:test` (e.g., Playwright)

**Key types:**
- `HarperTestContext` — minimal shape accepted by all lifecycle functions; intentionally loose
- `HarperContext` — fully populated instance data at `ctx.harper` after `startHarper()` resolves
- `StartedHarperTestContext` — `HarperTestContext` with `harper: HarperContext` guaranteed
- `ContextWithHarper` — for `node:test` only; extends `SuiteContext & TestContext` with `harper: HarperContext`

**Harper instance defaults** (set by `startHarper`):
- HTTP port: `9926`
- HTTPS port: `9927` (only bound when TLS/mTLS config is present)
- Operations API port: `9925`
- Admin credentials: `admin` / `Abc1234!`
- `--DEFAULTS_MODE=dev`, `--THREADS_COUNT=1`

## Writing Tests (node:test)

See [README.md#writing-tests](./README.md#writing-tests) for the full template and examples.

Key rules:
- Test files: ESM TypeScript, end in `.test.ts`, begin with a comment block describing what they verify
- File names: short, hyphen-separated (e.g., `install.test.ts`, `application-management.test.ts`)
- Use `suite`/`test`/`before`/`after` from `node:test`, assertions from `node:assert/strict`
- Suites always run **sequentially**; tests within a suite run **sequentially by default** (opt into `{ concurrency: true }` per suite when safe)
- Each test file runs in its own process — files are the unit of isolation

**Minimal template:**
```ts
/**
 * Description of what this test file verifies.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

suite('short description', (ctx: ContextWithHarper) => {
  before(async () => { await startHarper(ctx); });
  after(async () => { await teardownHarper(ctx); });

  test('test description', async () => {
    const response = await fetch(ctx.harper.httpURL);
    strictEqual(response.status, 200);
  });
});
```

## Running Tests (node:test runner)

See [README.md#node-js-test-runner](./README.md#node-js-test-runner) for full documentation.

```sh
npx harper-integration-test-run "integrationTests/**/*.test.ts"
```

Default concurrency is `floor(availableParallelism() / 2) + 1` — intentionally conservative because each Harper instance is resource-intensive.

**Runner options** (all overridable via `HARPER_INTEGRATION_TEST_*` env vars):

| CLI | Env var | Default |
|-----|---------|---------|
| `--concurrency=N` | `HARPER_INTEGRATION_TEST_CONCURRENCY` | `floor(parallelism/2)+1` |
| `--isolation=mode` | `HARPER_INTEGRATION_TEST_ISOLATION` | `process` |
| `--shard=index/total` | `HARPER_INTEGRATION_TEST_SHARD` | `1/1` |
| `--only` | `HARPER_INTEGRATION_TEST_ONLY` | `false` |

Run sequentially (no loopback pool needed):
```sh
npx harper-integration-test-run --isolation=none "integrationTests/**/*.test.ts"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS` | Harper startup timeout (default: 30000) |
| `HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR` | Parent dir for temp Harper install dirs (default: OS tmpdir) |
| `HARPER_INTEGRATION_TEST_INSTALL_SCRIPT` | Explicit path to Harper CLI script |
| `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT` | Pool size, 1–255 (default: 32) |
| `HARPER_INTEGRATION_TEST_LOG_DIR` | If set, Harper logs are written per suite; passing suite logs are auto-deleted |
| `HARPER_INTEGRATION_TEST_CONCURRENCY` | Override runner concurrency |
| `HARPER_INTEGRATION_TEST_ISOLATION` | Override runner isolation mode |
| `HARPER_INTEGRATION_TEST_SHARD` | Override runner shard (e.g., `2/4`) |
| `HARPER_INTEGRATION_TEST_ONLY` | Override runner `--only` flag |

## CI / GitHub Actions

See [README.md#github-actions-workflow-parallelization](./README.md#github-actions-workflow-parallelization) for strategy guidance. Key points:

- Default GitHub Actions runners are limited — parallelize across runners using matrix jobs + sharding, not within a single runner
- Be deliberate about when the full suite runs; consider path filters, manual triggers, or merge queues
- The [Harper integration tests workflow](https://github.com/HarperFast/harper/blob/main/.github/workflows/integration-tests.yml) is a real-world reference

## Using Other Frameworks

The lifecycle APIs work with any framework that supports async setup/teardown. For use outside `node:test` (e.g., Playwright), use `createHarperContext()` instead of `ContextWithHarper`:

```ts
const ctx = createHarperContext(`worker-${workerInfo.workerIndex}`);
await startHarper(ctx);
// ...
await teardownHarper(ctx);
```

`src/run.ts` is the reference implementation for wiring these utilities into a runner, including concurrency and shard configuration.
