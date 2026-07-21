import { access } from "node:fs/promises";
import { chromium } from "playwright";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error("Node.js 20 or newer is required.");
  process.exit(1);
}

try {
  await access(chromium.executablePath());
} catch {
  console.error("Playwright Chromium is not installed. Run: npm run setup-browser");
  process.exit(1);
}

console.log(JSON.stringify({ status: "passed", node: process.versions.node, chromium: chromium.executablePath() }));
