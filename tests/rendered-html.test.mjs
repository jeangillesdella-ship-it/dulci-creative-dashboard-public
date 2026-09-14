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

test("production dashboard route serves uncached matching HTML", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/dulci-creative-dashboard"),
    {
      ASSETS: {
        fetch: async () => new Response("<html>current dashboard</html>", { headers: { etag: "old" } }),
      },
    },
    testContext,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate, max-age=0");
  assert.equal(response.headers.get("etag"), null);
  assert.match(await response.text(), /current dashboard/);
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
  assert.match(html, /id="videoMatch"/);
  assert.match(html, /id="platform"/);
  assert.match(html, /<option value="ios">iOS<\/option>/);
  assert.match(html, /id="campaignOptions"/);
  assert.match(script, /\/api\/feishu\/creative-assets/);
  assert.match(script, /\/api\/adjust\/dulci-creatives/);
  assert.doesNotMatch(script, /STATIC_DATA_URL/);
  assert.match(script, /class="video-thumb"/);
  assert.match(script, /IntersectionObserver/);
  assert.match(script, /data-preview-src/);
  assert.match(script, /video\.load\(\)/);
  assert.match(script, /preview-ready/);
  assert.match(script, /data-video-url/);
  assert.match(css, /\.video-play \.video-thumb/);
  assert.match(css, /object-fit:contain/);
});

test("live Adjust reports request the complete result set", async () => {
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /full_data:\s*"true"/);
  assert.match(worker, /readable_names:\s*"false"/);
  assert.match(worker, /os_name__in/);
  assert.match(worker, /day,os_name,partner_name,channel/);
  assert.match(worker, /dulci_realrevenue_s2s_events/);
  assert.match(worker, /dulci_realrevenue_s2s_revenue/);
  assert.match(worker, /dulci_realrevenue_s2s_d0_revenue_cohort/);
});

test("creative pivot exposes real revenue and ROI metrics", async () => {
  const script = await readFile(new URL("../public/dulci-creative-dashboard.js", import.meta.url), "utf8");
  assert.match(script, /metricHeader\("realRevenueEvents", "Revenue 事件"\)/);
  assert.match(script, /metricHeader\("realRevenueValue", "Revenue 价值"\)/);
  assert.match(script, /metricHeader\("roi0", "ROI0"\)/);
  assert.match(script, /metricHeader\("cumulativeRoi", "累积 ROI"\)/);
  assert.match(script, /realRevenueD0Value \/ cost/);
  assert.match(script, /realRevenueValue \/ cost/);
});
