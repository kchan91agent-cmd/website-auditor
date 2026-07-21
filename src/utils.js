import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

export function cleanText(value = "") {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function stableId(prefix, ...values) {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16)}`;
}

export function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function writeExclusive(path, value) {
  await writeFile(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export async function readJson(path, label = "JSON file") {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw Object.assign(new Error(`${label} could not be read as JSON.`), { code: "INPUT_UNREADABLE" });
  }
}

export async function mapLimit(values, concurrency, work) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export function errorRecord(error) {
  return {
    code: error?.code ?? "UNEXPECTED_ERROR",
    message: error?.message ?? "Unexpected failure."
  };
}
