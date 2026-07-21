import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function verifyExecutable(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

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

const provider = flag(process.argv.slice(2), "--provider");
if (provider && !["codex", "claude"].includes(provider)) {
  console.error("--provider must be codex or claude.");
  process.exit(1);
}
if (provider) {
  const command = provider === "codex" ? process.env.CODEX_BIN ?? "codex" : process.env.CLAUDE_BIN ?? "claude";
  try {
    await verifyExecutable(command);
  } catch (error) {
    console.error(`${provider} provider is unavailable: ${error.message}`);
    process.exit(1);
  }
}

console.log(JSON.stringify({ status: "passed", node: process.versions.node, chromium: chromium.executablePath(), provider: provider ?? "not-checked" }));
