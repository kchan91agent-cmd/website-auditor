import test from "node:test";
import assert from "node:assert/strict";
import { ingestWayback, parseWaybackCdx, waybackReplayUrl } from "../src/wayback.js";

const HEADER = ["timestamp", "original", "mimetype", "statuscode", "digest", "length"];

function cdx(rows, resumeKey = null) {
  return JSON.stringify([HEADER, ...rows, ...(resumeKey ? [[], [resumeKey]] : [])]);
}

function row(timestamp, original, digest = "DIGEST") {
  return [timestamp, original, "text/html", "200", digest, "1000"];
}

test("Wayback CDX parsing normalizes same-host HTTP captures and reads a resumption key", () => {
  const parsed = parseWaybackCdx(cdx([
    row("20260101000000", "http://example.com/product?utm_source=archive"),
    row("20260201000000", "https://other.example/product")
  ], "resume-token"), "example.com");
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].url, "https://example.com/product");
  assert.equal(parsed.records[0].original, "http://example.com/product?utm_source=archive");
  assert.equal(parsed.resumeKey, "resume-token");
});

test("Wayback CDX parsing decodes a server-issued resumption key for safe reuse", () => {
  const parsed = parseWaybackCdx(cdx([row("20260101000000", "https://example.com/")], "com%2Cexample%29%2F+20260101000000%21"), "example.com");
  assert.equal(parsed.resumeKey, "com,example)/ 20260101000000!");
});

test("Wayback acquisition retrieves analyzable public archive pages without target-host requests", async () => {
  const homeOld = row("20250101000000", "https://example.com/", "HOME-OLD");
  const productOld = row("20250102000000", "https://example.com/product", "PRODUCT-OLD");
  const nextData = row("20250103000000", "https://example.com/_next/data/build/product.json", "NEXT-DATA");
  const homepageVariant = row("20250104000000", "https://example.com/?category=News", "HOME-VARIANT");
  const emptyOld = row("20250105000000", "https://example.com/empty", "EMPTY-OLD");
  const homeNew = row("20260701000000", "https://example.com/", "HOME-NEW");
  const productNew = row("20260630000000", "https://example.com/product", "PRODUCT-NEW");
  const emptyNew = row("20260629000000", "https://example.com/empty", "EMPTY-NEW");
  const requestedHosts = [];
  const archiveBoundaries = [];
  const safeFetch = async (value, options = {}) => {
    const url = new URL(value);
    requestedHosts.push(url.hostname);
    archiveBoundaries.push(options.allowedHosts);
    if (url.pathname === "/cdx/search/cdx" && url.searchParams.get("matchType") === "host") {
      return { buffer: Buffer.from(cdx([homeOld, productOld, nextData, homepageVariant, emptyOld])) };
    }
    if (url.pathname === "/cdx/search/cdx" && url.searchParams.get("url") === "https://example.com/") {
      return { buffer: Buffer.from(cdx([homeNew])) };
    }
    if (url.pathname === "/cdx/search/cdx" && url.searchParams.get("url") === "https://example.com/product") {
      return { buffer: Buffer.from(cdx([productNew])) };
    }
    if (url.pathname === "/cdx/search/cdx" && url.searchParams.get("url") === "https://example.com/empty") {
      return { buffer: Buffer.from(cdx([emptyNew])) };
    }
    if (url.pathname.includes("20260701000000id_")) {
      return { buffer: Buffer.from("<!doctype html><html><head><title>Home</title></head><body><header><nav><a href='/product'>Product</a></nav></header><main><h1>Home</h1><p>Archived homepage copy.</p></main></body></html>"), mimeType: "text/html" };
    }
    if (url.pathname.includes("20260630000000id_")) {
      return { buffer: Buffer.from("<!doctype html><html><head><title>Product</title><link rel='canonical' href='https://other.example/product'></head><body><main><h1>Product</h1><p>Archived product copy.</p></main></body></html>"), mimeType: "text/html" };
    }
    if (url.pathname.includes("20260629000000id_")) {
      return { buffer: Buffer.from("<!doctype html><html><head><title>Empty</title></head><body></body></html>"), mimeType: "text/html" };
    }
    throw new Error(`Unexpected URL ${value}`);
  };
  const result = await ingestWayback({ domain: "https://example.com/", limits: { discovered: 20, fetched: 10, analyzed: 10 } }, { safeFetch });
  assert.equal(result.acquisition.method, "wayback");
  assert.equal(result.archive.acquiredRecords, 2);
  assert.equal(result.archive.requestedRecords, 3);
  assert.equal(result.archive.failures.length, 1);
  assert.equal(result.archive.failures[0].code, "INVALID_ARCHIVE_RECORD");
  assert.equal(result.selected.length, 2);
  assert.equal(result.candidates.find((page) => page.url === "https://example.com/").archive.digest, "HOME-NEW");
  assert.equal(result.candidates.find((page) => page.url === "https://example.com/product").canonicalUrl, "https://example.com/product");
  assert.ok(result.candidates.find((page) => page.url === "https://example.com/product").placements.includes("primary-nav"));
  assert.deepEqual([...new Set(requestedHosts)], ["web.archive.org"]);
  assert.ok(archiveBoundaries.every((hosts) => hosts?.length === 1 && hosts[0] === "web.archive.org"));
});

test("Wayback replay URLs preserve timestamp and archived original", () => {
  assert.equal(
    waybackReplayUrl({ timestamp: "20260701010203", original: "https://example.com/pricing?plan=team" }),
    "https://web.archive.org/web/20260701010203id_/https://example.com/pricing?plan=team"
  );
});
