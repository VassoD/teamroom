import { createRequire } from "node:module";

// Resolves to the package root from both src/ (tests) and dist/ (the published build),
// so the version always matches the package.json the release workflow stamped.
const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

export const PACKAGE_VERSION = packageJson.version;
