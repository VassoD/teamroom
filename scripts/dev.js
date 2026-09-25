// Rebuilds on every change and restarts a local server, without extra dependencies.
// Usage: npm run dev [-- --port 8787]
import { spawn, spawnSync } from "node:child_process";

const extraServeArgs = process.argv.slice(2);
const tsc = ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"];

const initialBuild = spawnSync(process.execPath, tsc, { stdio: "inherit" });
if (initialBuild.status !== 0) process.exit(initialBuild.status ?? 1);

const children = [
  spawn(process.execPath, [...tsc, "--watch", "--preserveWatchOutput"], { stdio: "inherit" }),
  spawn(
    process.execPath,
    ["--watch-path=dist", "dist/cli/index.js", "serve", "--data-dir", ".teamroom-data", ...extraServeArgs],
    { stdio: "inherit" }
  ),
];

function stopAll() {
  for (const child of children) child.kill("SIGTERM");
}

process.once("SIGINT", stopAll);
process.once("SIGTERM", stopAll);
for (const child of children) {
  child.once("exit", (code) => {
    stopAll();
    process.exitCode = code ?? 0;
  });
}
