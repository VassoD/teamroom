# Contributing

## Development

Requires Node 22+ (`nvm use` picks the version in `.nvmrc`).

```sh
npm install
npm run dev        # rebuild on change and restart a local server on :8787
npm run check      # typecheck, lint and tests, the same as CI
npm run format     # fix formatting and import order
```

Other scripts: `build`, `typecheck`, `lint`, `test`, `test:watch`. CI runs `check` and `build` on Node 22 and 24 for every pull request.

Tooling: TypeScript 7 for type checking and builds, Vitest for tests, and Biome for linting and formatting (one dependency instead of ESLint plus Prettier).

## Releasing

Publish a GitHub release with a tag like `v0.1.2` (Releases, then Draft a new release). The `Release` workflow sets the package version from the tag, runs the full check, and publishes to npm with provenance. npm trusts the workflow directly (trusted publishing), so no token or 2FA code is involved. The version in `package.json` is only a placeholder between releases.
