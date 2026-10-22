#!/usr/bin/env node
/**
 * Builds a standalone copy of the FireTales engine for its own public repository,
 * without removing it from Haunt. Output: build/firetales (git-ignored).
 *
 *   node scripts/export-firetales.mjs && cd build/firetales && npm install && npm test
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages/firetales");
const out = path.join(root, "build/firetales");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const entry of ["src", "test", "examples", "README.md", "LICENSE"]) {
  await cp(path.join(source, entry), path.join(out, entry), { recursive: true });
}

// package.json without workspace assumptions, plus the tools to run tests on its own.
const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
const rootPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
pkg.repository = { type: "git", url: "https://github.com/OWNER/firetales.git" };
pkg.keywords = ["interactive-fiction", "storytelling", "voice", "ai", "claude", "amazon-bedrock", "alexa", "mcp"];
pkg.engines = { node: ">=22" };
pkg.files = ["src", "README.md", "LICENSE"];
pkg.scripts = { ...pkg.scripts, typecheck: "tsc -p ." };
pkg.devDependencies = {
  ...pkg.devDependencies,
  "@types/node": rootPkg.devDependencies["@types/node"],
  tsx: rootPkg.devDependencies.tsx,
  typescript: rootPkg.devDependencies.typescript,
};
await writeFile(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

// tsconfig with the shared base inlined.
const base = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
const local = JSON.parse(await readFile(path.join(source, "tsconfig.json"), "utf8"));
const tsconfig = {
  compilerOptions: { ...base.compilerOptions, ...local.compilerOptions },
  include: local.include,
};
await writeFile(path.join(out, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");

await writeFile(path.join(out, ".gitignore"), "node_modules/\nstories/\n*.log\n.env\n");
await writeFile(
  path.join(out, ".env.example"),
  [
    "# Only needed for the examples with a real model. Tests and the default examples run offline.",
    "# FIRETALES_PROVIDER=anthropic   # uses ANTHROPIC_API_KEY",
    "# FIRETALES_PROVIDER=bedrock     # uses your AWS credentials (AWS_PROFILE / AWS_REGION)",
    "# ANTHROPIC_API_KEY=",
    "# AWS_REGION=us-east-1",
    "",
  ].join("\n"),
);
console.log(`FireTales exported to ${path.relative(root, out)}`);
