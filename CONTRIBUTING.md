# Contributing

Contributors are encouraged to communicate with maintainers in issues or other channels (such as our community [Discord](https://harper.fast/discord)) before submitting changes.

## Code Organization

Source files are located in `src/`. These are built to the `dist/` directory. The published package includes `dist/`, `scripts/`, and the regular npm metadata and documentation files.

The `src/index.ts` is the source for the main export. This is the public re-export of all the various utilities from `src/harperLifecycle.ts`, `targz.ts`, and more. The `src/run.ts` is the source for the `harper-integration-test-run` bin script. And the `scripts/setup-loopback.sh` is the source for the `harper-integration-test-setup-loopback` bin script.

The package is `"type": "module"` — all source files are ESM by default.

There are two `tsconfig` files:

- `tsconfig.json` — type-checking only (`"noEmit": true`). Used by `npm run check` and editors.
- `tsconfig.build.json` — emits to `dist/` with source maps and declarations. Used by `npm run build`.

`erasableSyntaxOnly: true` is set, meaning TypeScript-only syntax that cannot be stripped (e.g., `enum`, `namespace`) is not allowed.

## Scripts

```sh
npm run check   # Type-check only (no output)
npm run build   # Compile src/ → dist/
```

There are no automated tests in this package yet. Validation is type-checking plus manual testing via dependent projects.

## Releases

Update the `version` field in `package.json` (recommend using `npm version <major|minor|patch>`) and publish via `npm publish`. The `files` field in `package.json` controls what is included in the published package. Don't forget to push the version commit and tag.
