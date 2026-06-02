import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const cleanOnly = process.argv.includes("--clean");

await rm(dist, { recursive: true, force: true });
if (cleanOnly) {
  console.log("Cleaned dist/");
  process.exit(0);
}

await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  outfile: path.join(dist, "index.js"),
  format: "iife",
  target: ["es2020"],
  platform: "browser",
  external: ["premierepro", "uxp", "fs"],
  sourcemap: true,
  legalComments: "none",
  banner: {
    js: "/* Subtitle QA - Adobe Premiere Pro UXP panel bundle */"
  }
});

for (const item of ["manifest.json", "index.html", "styles.css", "icons"]) {
  const from = path.join(root, "plugin", item);
  const to = path.join(dist, item);
  if (existsSync(from)) {
    await cp(from, to, { recursive: true });
  }
}

if (existsSync(path.join(root, "glossary"))) {
  await cp(path.join(root, "glossary"), path.join(dist, "glossary"), { recursive: true });
}

console.log("Built UXP plugin to dist/");
