# AGENTS.md

Review the `README.md` and `CONTRIBUTING.md` for all relevant repository information.

## Development Tips
- Ensure you're on at least Node.js v22.18 or greater when contributing (native TypeScript stripping for `npm test` requires it; see `devEngines`)
- Use `npm install` to install dependencies
- Use `npm run build` to build the project
- Do not run `npm version` or `npm publish`; these commands are for humans only.
- When updating core code, make sure to update relevant documentation.
  - Public API and usage docs are in `README.md`
  - Internal documentation is in `CONTRIBUTING.md`
  - If you change the public API surface in `src/index.ts`, update `README.md#api`.
- Do not edit files in `dist/`; it is compiled output and gitignored.

## Code Style
- Use ESM and TypeScript
- Use erasable syntax only (no `enum` or `namespace`)
- There is currently no linter or formatter for this project

## Testing Tips
- Use `npm link` in this directory and `npm link @harperfast/integration-testing` in other project directories to test out changes locally
- Use `npm run check` to type-check the project without generating a build output
- Use `npm test` to run the unit tests (`node --test` over `src/**/*.test.ts`). Tests are excluded from the build (`tsconfig.build.json`) so they are not published.
  - To keep them runnable without a real Harper, internal-only helpers are exported from their modules (e.g. `runHarperCommand` in `harperLifecycle.ts`) but intentionally NOT re-exported from `index.ts`, so they stay out of the public API.
