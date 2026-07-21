import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestPageBundle } from "../src/page-bundle.js";
import { buildBundleFromSavedHtml } from "../src/html-capture.js";

function bundle(ownerAuthorized = true) {
  return {
    schemaVersion: "1.0",
    primaryUrl: "https://example.com/",
    acquisition: { method: "owner-cms-export", sourceName: "Production export", ownerAuthorized },
    pages: [
      {
        url: "https://example.com/",
        title: "Home",
        headings: ["Home"],
        sections: [{ heading: "Home", element: "p", text: "Homepage copy" }],
        links: [{ href: "https://example.com/product", text: "Product", placement: "primary-nav" }]
      },
      {
        url: "https://example.com/product",
        title: "Product",
        headings: ["Product"],
        sections: [{ heading: "Product", element: "p", text: "Product copy" }],
        links: []
      }
    ]
  };
}

async function save(value) {
  const directory = await mkdtemp(join(tmpdir(), "page-bundle-"));
  const path = join(directory, "pages.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("owner-authorized page bundles preserve nav prominence without live crawling", async () => {
  const result = await ingestPageBundle(await save(bundle()), { limits: { analyzed: 2 } });
  const product = result.candidates.find((page) => page.url === "https://example.com/product");
  assert.equal(result.acquisition.method, "owner-cms-export");
  assert.equal(result.selected.length, 2);
  assert.ok(product.placements.includes("primary-nav"));
  assert.equal(product.prominence, 90);
});

test("page bundles require explicit owner authorization", async () => {
  await assert.rejects(ingestPageBundle(await save(bundle(false))), (error) => error.code === "INVALID_PAGE_BUNDLE");
});

test("public manual captures do not require owner authorization", async () => {
  const value = bundle(false);
  value.acquisition.method = "public-manual-capture";
  const result = await ingestPageBundle(await save(value), { limits: { analyzed: 2 } });
  assert.equal(result.acquisition.ownerAuthorized, false);
  assert.equal(result.selected.length, 2);
});

test("saved public HTML converts to a provenance-labelled page bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saved-html-"));
  await writeFile(join(directory, "home.html"), "<!doctype html><html><head><title>Home</title></head><body><header><nav><a href='/product'>Product</a></nav></header><main><h1>Home</h1><p>Visible public copy.</p></main></body></html>");
  const manifestPath = join(directory, "manifest.json");
  const outputPath = join(directory, "bundle.json");
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: "1.0", primaryUrl: "https://example.com/", pages: [{ url: "https://example.com/", file: "home.html" }] }));
  const result = await buildBundleFromSavedHtml(manifestPath, outputPath);
  assert.equal(result.acquisition.method, "public-manual-capture");
  assert.equal(result.acquisition.ownerAuthorized, false);
  assert.equal(result.pages[0].sections[0].text, "Visible public copy.");
  assert.equal(result.pages[0].links[0].placement, "primary-nav");
});
