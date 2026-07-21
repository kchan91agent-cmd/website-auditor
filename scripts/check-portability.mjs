import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const required = ["AGENTS.md", "README.md", "package.json", "src/cli.js", "src/audit.js", "src/crawl.js"];
for (const path of required) await readFile(join(root, path));

const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".js", ".mjs", ".md", ".json"].includes(extname(path))) files.push(path);
  }
}
await walk(root);
const forbidden = [
  /\/Users\/[^/\s]+\/(?:Documents|Desktop|Downloads)\//,
  /\/home\/[^/\s]+\//,
  /[A-Za-z]:\\Users\\[^\\\s]+\\/,
  /\.\.\/\.\.\/\.\./
];
const failures = [];
for (const path of files) {
  const value = await readFile(path, "utf8");
  if (forbidden.some((pattern) => pattern.test(value))) failures.push(path.slice(root.length + 1));
}
if (failures.length) {
  console.error(JSON.stringify({ status: "failed", nonPortableFiles: failures }));
  process.exit(1);
}
console.log(JSON.stringify({ status: "passed", checkedFiles: files.length }));
