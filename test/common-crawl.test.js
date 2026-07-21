import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { ingestCommonCrawl, parseCdxLines, warcRecordUrl } from "../src/common-crawl.js";

function warc(html) {
  const payload = `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
  return gzipSync(`WARC/1.0\r\nWARC-Type: response\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
}

test("CDX parsing keeps the newest same-host HTTPS record", () => {
  const records = parseCdxLines([
    JSON.stringify({ url: "https://example.com/product", status: "200", timestamp: "20260101000000", filename: "old.gz", offset: "0", length: "100" }),
    JSON.stringify({ url: "https://example.com/product", status: "200", timestamp: "20260201000000", filename: "new.gz", offset: "0", length: "100" }),
    JSON.stringify({ url: "https://other.example/product", status: "200", timestamp: "20260301000000", filename: "other.gz", offset: "0", length: "100" })
  ].join("\n"), "example.com", 10);
  assert.equal(records.length, 1);
  assert.equal(records[0].filename, "new.gz");
});

test("Common Crawl acquisition builds an analyzable archive bundle without target requests", async () => {
  const home = warc("<!doctype html><html><head><title>Home</title></head><body><header><nav><a href='/product'>Product</a></nav></header><main><h1>Home</h1><p>Archived homepage copy.</p></main></body></html>");
  const product = warc("<!doctype html><html><head><title>Product</title></head><body><main><h1>Product</h1><p>Archived product copy.</p></main></body></html>");
  const rows = [
    { url: "https://example.com/", status: "200", mime: "text/html", timestamp: "20260701000000", filename: "home.warc.gz", offset: "0", length: String(home.length) },
    { url: "https://example.com/product", status: "200", mime: "text/html", timestamp: "20260630000000", filename: "product.warc.gz", offset: "0", length: String(product.length) }
  ];
  const requestedHosts = [];
  const safeFetch = async (value) => {
    const url = new URL(value);
    requestedHosts.push(url.hostname);
    if (url.pathname === "/collinfo.json") return { buffer: Buffer.from(JSON.stringify([{ id: "CC-MAIN-TEST", "cdx-api": "https://index.commoncrawl.org/CC-MAIN-TEST-index" }])) };
    if (url.hostname === "index.commoncrawl.org") return { buffer: Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n")) };
    if (url.pathname.endsWith("home.warc.gz")) return { buffer: home };
    if (url.pathname.endsWith("product.warc.gz")) return { buffer: product };
    throw new Error(`Unexpected URL ${value}`);
  };
  const result = await ingestCommonCrawl({ domain: "https://example.com/", limits: { discovered: 20, fetched: 10, analyzed: 10 } }, { safeFetch });
  assert.equal(result.acquisition.method, "common-crawl");
  assert.equal(result.archive.acquiredRecords, 2);
  assert.equal(result.selected.length, 2);
  assert.ok(result.candidates.find((page) => page.url === "https://example.com/product").placements.includes("primary-nav"));
  assert.deepEqual([...new Set(requestedHosts)].sort(), ["data.commoncrawl.org", "index.commoncrawl.org"]);
});

test("WARC ranges reject oversized archive records", () => {
  assert.throws(() => warcRecordUrl({ filename: "record.gz", offset: "0", length: String(6 * 1024 * 1024) }), (error) => error.code === "INVALID_ARCHIVE_RECORD");
});
