# Contributing

## Code Organization

```
src/
  harperLifecycle.ts      # startHarper, teardownHarper, killHarper, setupHarperWithFixture, sendOperation, createHarperContext
  loopbackAddressPool.ts  # File-locked cross-process loopback address pool
  run.ts                  # harper-integration-test-run CLI entry point
  targz.ts                # Directory → base64 tar.gz utility
  index.ts                # Public re-exports (the package's only entry point)
scripts/
  setup-loopback.sh       # sudo script to configure loopback aliases (macOS/Windows)
```

The published package includes `dist/`, `scripts/`, `api.md`, and `README.md`.

## Module System

The package is `"type": "module"` — all source files are ESM. TypeScript is configured with `"module": "NodeNext"` and `"rewriteRelativeImportExtensions": true`, which means:

- All relative imports in source use `.ts` extensions (e.g., `import { foo } from './foo.ts'`)
- `tsc` rewrites these to `.js` in the compiled output

Do not use `.js` extensions in source imports.

## TypeScript Configuration

There are two `tsconfig` files:

- `tsconfig.json` — type-checking only (`"noEmit": true`). Used by `npm run check` and editors.
- `tsconfig.build.json` — emits to `dist/` with source maps and declarations. Used by `npm run build`.

`erasableSyntaxOnly: true` is set, meaning TypeScript-only syntax that cannot be stripped (e.g., `enum`, `namespace`) is not allowed.

## Scripts

```sh
npm run check   # Type-check only (no output)
npm run build   # Compile src/ → dist/
```

There are no automated tests in this package. Validation is type-checking plus manual testing via dependent projects.

## Development Setup

1. Install dependencies: `npm install`
2. On macOS or Windows, configure loopback addresses before running integration tests in dependent projects:
   ```sh
   npx harper-integration-test-setup-loopback
   ```
   This requires `sudo`. Defaults to 32 addresses (`127.0.0.1–127.0.0.32`). Override with `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT`.

## Releases

Update the `version` field in `package.json` and publish via `npm publish`. The `files` field in `package.json` controls what is included in the published package.
