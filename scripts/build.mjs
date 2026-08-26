import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const entries = {
  "content/injector": "src/content/injector.ts",
  "content/main": "src/content/main.ts",
  "bridge": "src/bridge/bridge.ts",
  "offscreen": "src/offscreen/offscreen.ts",
  "background": "src/background.ts",
  "popup/popup": "src/popup/popup.ts",
  "options/options": "src/options/options.ts"
};

await build({
  entryPoints: entries,
  outdir: dist,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome116",
  sourcemap: false,
  minify: false,
  logLevel: "info"
});

for (const [source, destination] of [
  ["public/manifest.json", "manifest.json"],
  ["public/bridge.html", "bridge.html"],
  ["public/offscreen.html", "offscreen.html"],
  ["public/content.css", "content/content.css"],
  ["public/popup.html", "popup/popup.html"],
  ["public/popup.css", "popup/popup.css"],
  ["public/options.html", "options/options.html"],
  ["public/options.css", "options/options.css"]
]) {
  const target = path.join(dist, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, source), target);
}

await cp(path.join(root, "public/icons"), path.join(dist, "icons"), { recursive: true });

const manifestPath = path.join(dist, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built extension at ${dist}`);
