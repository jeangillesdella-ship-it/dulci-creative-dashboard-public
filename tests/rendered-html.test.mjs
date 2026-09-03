import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const testEnv = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const testContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("root redirects to the Dulci dashboard", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    testEnv,
    testContext,
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/dulci-creative-dashboard.html");
});

test("Feishu assets endpoint fails safely when secrets are absent", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/feishu/creative-assets"),
    testEnv,
    testContext,
  );
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.configured, false);
  assert.deepEqual(body.assets, []);
  assert.match(body.error, /飞书/);
});

test("dashboard loads Feishu assets and renders inline video previews", async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL("../public/dulci-creative-dashboard.html", import.meta.url), "utf8"),
    readFile(new URL("../public/dulci-creative-dashboard.js", import.meta.url), "utf8"),
    readFile(new URL("../public/dulci-creative-dashboard.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="videoModal"/);
  assert.match(html, /id="creativeVideo"/);
  assert.match(script, /\/api\/feishu\/creative-assets/);
  assert.match(script, /class="video-thumb"/);
  assert.match(script, /data-video-url/);
  assert.match(css, /\.video-play \.video-thumb/);
});
