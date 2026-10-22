#!/usr/bin/env node
/**
 * Builds the production Lambda artifact that deploy/serverless/template.yaml ships as `CodeUri: build/`.
 *
 *   node scripts/build-lambda.mjs [outputDir]          default: deploy/serverless/build
 *
 * Output layout (what the template's handler `apps/server/src/lambda.handler` and the runtime paths expect):
 *
 *   <outputDir>/package.json                          { "type": "module" }
 *   <outputDir>/apps/server/src/lambda.js             one self-contained ESM bundle: every npm dependency is inside it
 *   <outputDir>/apps/views/dist/scene.html            read at runtime from ROOT_DIR/apps/views/dist (config.ts, mcp.ts)
 *
 * ROOT_DIR is resolved from the bundle's own location (../../.. from apps/server/src), so the layout above is the contract.
 *
 * Failure: any error (bundling, a missing input, a dependency the bundle could not include) exits nonzero and leaves the output
 * directory removed rather than half written. The script never touches anything outside <outputDir>.
 *
 * Prerequisite: the views build (`npm run build -w @haunt/views`), which produces apps/views/dist/scene.html.
 */
import { build } from "esbuild";
import { access, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, process.argv[2] ?? "deploy/serverless/build");
/** Built here first; swapped into outDir only when every check has passed. */
const stagingDir = `${outDir}.staging-${process.pid}`;
const entry = path.join(root, "apps/server/src/lambda.ts");
const sceneSource = path.join(root, "apps/views/dist/scene.html");

/** Node built-ins, with and without the node: prefix. Anything else the bundle imports at runtime is a failure. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

async function requireFile(file, hint) {
  try {
    await access(file);
  } catch {
    throw new Error(`Missing ${path.relative(root, file)}. ${hint}`);
  }
}

async function main() {
  await requireFile(entry, "The Lambda entry point must exist.");
  await requireFile(sceneSource, "Run `npm run build -w @haunt/views` first.");

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(path.join(stagingDir, "apps/server/src"), { recursive: true });
  await mkdir(path.join(stagingDir, "apps/views/dist"), { recursive: true });

  const bundleFile = path.join(stagingDir, "apps/server/src/lambda.js");
  const result = await build({
    entryPoints: [entry],
    outfile: bundleFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Everything, including the S3 SDK, the presigned-POST packages and @codegenie/serverless-express, is inlined.
    packages: "bundle",
    // ESM bundles have no `require`; some bundled CommonJS packages call it, so provide one (as the earlier artifact did).
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    metafile: true,
    logLevel: "warning",
    legalComments: "none",
  });

  // Every import the finished bundle still makes must be a Node built-in. Anything else would need node_modules at runtime.
  const missing = [];
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !BUILTINS.has(imported.path)) missing.push(imported.path);
    }
  }
  if (missing.length) {
    throw new Error(`The bundle would need packages at runtime that are not inside it: ${[...new Set(missing)].join(", ")}`);
  }

  await writeFile(path.join(stagingDir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  await copyFile(sceneSource, path.join(stagingDir, "apps/views/dist/scene.html"));

  // Every check has passed: replace the previous artifact in one step.
  await rm(outDir, { recursive: true, force: true });
  await rename(stagingDir, outDir);

  console.log(`Lambda artifact written to ${path.relative(root, outDir) || "."}`);
  console.log(`  apps/server/src/lambda.js          ${(await stat(path.join(outDir, "apps/server/src/lambda.js"))).size} bytes`);
  console.log("  apps/views/dist/scene.html");
}

main().catch(async (error) => {
  console.error(`build-lambda failed: ${error.message}`);
  // Remove only the partial build. The previous artifact in outDir is left as it was.
  await rm(stagingDir, { recursive: true, force: true });
  process.exitCode = 1;
});
