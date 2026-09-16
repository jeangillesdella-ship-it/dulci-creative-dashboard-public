/** Cloudflare Worker entry point for the public Dulci dashboard. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  ADJUST_API_TOKEN?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_DULCI_FOLDER_TOKEN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type CachedReport = { cachedAt: number; payload: Record<string, unknown> };
const reportCache = new Map<string, CachedReport>();
let feishuTokenCache: { value: string; expiresAt: number } = { value: "", expiresAt: 0 };
let feishuAssetCache: { cachedAt: number; payload: Record<string, unknown> | null } = { cachedAt: 0, payload: null };

type FeishuDriveFile = {
  name?: string;
  type?: string;
  token?: string;
  created_time?: string;
  modified_time?: string;
};

function normalizeCreativeName(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[?#].*$/, "")
    .replace(/[_\s-]*广告名称\s*20\d{2}[-_/]\d{1,2}[-_/]\d{1,2}.*$/i, "")
    .replace(/[_\s-]*ad\s*name\s*20\d{2}[-_/]\d{1,2}[-_/]\d{1,2}.*$/i, "")
    .replace(/[_\s-]*拉踩\s*$/i, "")
    .replace(/\.(mp4|mov|m4v|webm|avi|mkv)$/i, "")
    .replace(/(_\d{3,4}x\d{3,4})_[a-z0-9]{6,12}$/i, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

async function getFeishuToken(env: Env): Promise<string> {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error("飞书素材连接尚未配置");
  if (feishuTokenCache.value && Date.now() < feishuTokenCache.expiresAt) return feishuTokenCache.value;
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const body = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
  if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`飞书鉴权失败：${body.msg || response.status}`);
  }
  feishuTokenCache = {
    value: body.tenant_access_token,
    expiresAt: Date.now() + Math.max(300, Number(body.expire || 7200) - 120) * 1000,
  };
  return feishuTokenCache.value;
}

async function listFeishuFolder(token: string, folderToken: string): Promise<FeishuDriveFile[]> {
  const files: FeishuDriveFile[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ folder_token: folderToken, page_size: "200" });
    if (pageToken) params.set("page_token", pageToken);
    const response = await fetch(`https://open.feishu.cn/open-apis/drive/v1/files?${params}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const body = await response.json() as {
      code?: number;
      msg?: string;
      data?: { files?: FeishuDriveFile[]; has_more?: boolean; next_page_token?: string; page_token?: string };
    };
    if (!response.ok || body.code !== 0) throw new Error(`飞书目录读取失败：${body.msg || response.status}`);
    files.push(...(body.data?.files || []));
    pageToken = body.data?.has_more ? String(body.data?.next_page_token || body.data?.page_token || "") : "";
  } while (pageToken);
  return files;
}

async function readFeishuVideoAssets(env: Env, refresh = false): Promise<Record<string, unknown>> {
  if (!refresh && feishuAssetCache.payload && Date.now() - feishuAssetCache.cachedAt < 10 * 60 * 1000) {
    return { ...feishuAssetCache.payload, cached: true };
  }
  const rootToken = String(env.FEISHU_DULCI_FOLDER_TOKEN || "").trim();
  if (!rootToken) throw new Error("飞书 DulCi 文件夹尚未配置");
  const token = await getFeishuToken(env);
  const queue: Array<{ token: string; path: string }> = [{ token: rootToken, path: "DulCi" }];
  const videos: Array<FeishuDriveFile & { folder: string }> = [];
  let foldersScanned = 0;
  while (queue.length) {
    const batch = queue.splice(0, 8);
    const results = await Promise.all(batch.map(async (folder) => ({ folder, items: await listFeishuFolder(token, folder.token) })));
    for (const { folder, items } of results) {
      foldersScanned += 1;
      for (const item of items) {
        const name = String(item.name || "");
        const itemToken = String(item.token || "");
        if (!itemToken) continue;
        if (item.type === "folder") queue.push({ token: itemToken, path: `${folder.path}/${name}` });
        else if (/\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(name)) videos.push({ ...item, folder: folder.path });
      }
    }
  }
  const unique = new Map<string, Record<string, unknown>>();
  videos
    .sort((a, b) => Number(b.modified_time || b.created_time || 0) - Number(a.modified_time || a.created_time || 0))
    .forEach((file) => {
      const fileName = String(file.name || "");
      const normalizedName = normalizeCreativeName(fileName);
      if (!normalizedName || unique.has(normalizedName)) return;
      unique.set(normalizedName, {
        creativeName: fileName,
        normalizedName,
        fileName,
        folder: file.folder,
        updatedAt: new Date(Number(file.modified_time || file.created_time || 0) * 1000).toISOString(),
        mediaUrl: `/api/feishu/media/${encodeURIComponent(String(file.token || ""))}`,
        thumbnailUrl: "",
        source: "feishu-drive",
      });
    });
  const payload = {
    configured: true,
    assets: [...unique.values()],
    recordsScanned: videos.length,
    foldersScanned,
    fetchedAt: new Date().toISOString(),
    source: "飞书云盘 DulCi",
  };
  feishuAssetCache = { cachedAt: Date.now(), payload };
  return { ...payload, cached: false };
}

async function feishuAssets(request: Request, env: Env): Promise<Response> {
  try {
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return json(await readFeishuVideoAssets(env, refresh));
  } catch (error) {
    return json({ configured: false, assets: [], error: error instanceof Error ? error.message : "飞书素材读取失败" }, 502);
  }
}

async function feishuMedia(request: Request, env: Env, fileToken: string): Promise<Response> {
  try {
    if (!fileToken) throw new Error("素材文件不存在");
    const token = await getFeishuToken(env);
    const requestHeaders: Record<string, string> = { authorization: `Bearer ${token}` };
    const range = request.headers.get("range");
    if (range) requestHeaders.range = range;
    const upstream = await fetch(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`, {
      headers: requestHeaders,
    });
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 180);
      throw new Error(`飞书视频读取失败：${upstream.status} ${detail}`);
    }
    const headers = new Headers();
    ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"].forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    });
    headers.set("cache-control", "public, max-age=300");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "飞书视频读取失败" }, 404);
  }
}

const creativeMetrics = [
  "installs", "reattributions", "cost", "ecpi_all", "impressions", "clicks",
  "dulci_purchase_d0_events_cohort",
  "dulci_open_002t_24h_events", "dulci_online_005m_24h_events",
  "dulci_online_010m_24h_events", "dulci_online_020m_24h_events",
  "dulci_online_030m_life_events", "dulci_online_060m_24h_events",
  "dulci_msg_001t_24h_events", "dulci_msg_010t_24h_events",
  "dulci_msg_030t_24h_events", "dulci_msg_050t_24h_events",
  "dulci_purchase_events", "dulci_purchase_d7_s2s_events",
  "dulci_relogin_24h_d0_events_cohort_cal", "retained_users_d0", "retained_users_d1",
  "dulci_realsubscription_d0_events_cohort_cal", "dulci_realsubscription_d0_events_cohort",
  "dulci_realrevenue_s2s_events", "dulci_realrevenue_s2s_revenue",
  "dulci_realrevenue_s2s_d0_revenue_cohort",
  "dulci_subpur_d7_s2s_w1_events_cohort",
  "dulci_subpur_d14_s2s_w1_revenue_cohort",
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function periodFrom(url: URL): string {
  const start = String(url.searchParams.get("start") || "").trim();
  const end = String(url.searchParams.get("end") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return "-10d:-0d";
  }
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs > 92 * 86400000) {
    throw new Error("日期区间最长支持 93 天");
  }
  return `${start}:${end}`;
}

async function adjustReport(token: string, period: string, dimensions: string, metrics: string, sort?: string, platform = "all") {
  const params = new URLSearchParams({
    date_period: period,
    dimensions,
    metrics,
    app_token__in: "vpis1uwa4dmo",
    partner_name__in: "Facebook,TikTok for Business,Google Ads",
    utc_offset: "+00:00",
    reattributed: "all",
    attribution_source: "dynamic",
    ad_spend_mode: "network",
    cohort_maturity: "immature",
    sandbox: "false",
    format_dates: "false",
    full_data: "true",
    readable_names: "false",
  });
  if (platform === "ios" || platform === "android") params.set("os_name__in", platform);
  if (sort) params.set("sort", sort);
  const response = await fetch(`https://automate.adjust.com/reports-service/report?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Adjust 请求失败：${response.status} ${body.slice(0, 180)}`);
  try {
    const report = JSON.parse(body);
    if (!Array.isArray(report.rows)) throw new Error("Missing report rows");
    return report as { rows: Record<string, unknown>[]; totals?: Record<string, unknown>; warnings?: unknown[] };
  } catch {
    throw new Error("Adjust 返回内容不是合法 JSON");
  }
}

async function dulciReport(request: Request, env: Env): Promise<Response> {
  try {
    if (!env.ADJUST_API_TOKEN) throw new Error("公开看板尚未配置 Adjust 数据连接");
    const url = new URL(request.url);
    const period = periodFrom(url);
    const requestedPlatform = String(url.searchParams.get("platform") || "all").toLowerCase();
    const platform = requestedPlatform === "ios" || requestedPlatform === "android" ? requestedPlatform : "all";
    const refresh = url.searchParams.get("refresh") === "1";
    const cacheKey = `${period}:${platform}`;
    const cached = reportCache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.cachedAt < 5 * 60 * 1000) {
      return json({ ...cached.payload, cached: true });
    }
    const [creativeReport, trendReport] = await Promise.all([
      adjustReport(
        env.ADJUST_API_TOKEN,
        period,
        "os_name,partner_name,channel,campaign_id_network,campaign_network,adgroup_id_network,adgroup_network,creative_id_network,creative_network",
        creativeMetrics.join(","),
        "-cost",
        platform,
      ),
      adjustReport(
        env.ADJUST_API_TOKEN,
        period,
        "day,os_name,partner_name,channel",
        "installs,cost,dulci_subpur_d7_s2s_w1_events_cohort,dulci_subpur_d14_s2s_w1_revenue_cohort,dulci_realrevenue_s2s_revenue,retained_users_d1",
        undefined,
        platform,
      ),
    ]);
    const payload = {
      rows: creativeReport.rows || [],
      totals: creativeReport.totals || {},
      trend: trendReport.rows || [],
      datePeriod: period,
      platform,
      supportedPlatforms: ["all", "ios", "android"],
      source: `Adjust Report Service API · Google + Meta + TikTok · ${platform === "all" ? "iOS + Android" : platform} · creative grain · subpur + real revenue`,
      fetchedAt: new Date().toISOString(),
      dataThrough: (trendReport.rows || []).map(row => String(row.day || "")).filter(Boolean).sort().at(-1) || null,
      warnings: [...(creativeReport.warnings || []), ...(trendReport.warnings || [])],
    };
    reportCache.set(cacheKey, { cachedAt: Date.now(), payload });
    if (reportCache.size > 20) reportCache.delete(reportCache.keys().next().value as string);
    return json({ ...payload, cached: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "数据查询失败";
    console.error("Adjust report failed", message);
    return json({ error: message, failedAt: new Date().toISOString() }, 502);
  }
}

async function dashboardPage(request: Request, env: Env): Promise<Response | null> {
  if (!env.ASSETS) return null;
  const assetUrl = new URL("/dulci-creative-dashboard.html?release=20260911-ios", request.url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  if (!asset.ok) return null;
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.delete("etag");
  return new Response(asset.body, { status: asset.status, headers });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env = env || ({} as Env);
    const url = new URL(request.url);

    if (["/", "/dulci-creative-dashboard", "/dulci-creative-dashboard/", "/dulci-creative-dashboard.html"].includes(url.pathname)) {
      const page = await dashboardPage(request, env);
      if (page) return page;
    }

    if (url.pathname === "/api/adjust/dulci-creatives") return dulciReport(request, env);
    if (url.pathname === "/api/feishu/creative-assets") return feishuAssets(request, env);
    if (url.pathname.startsWith("/api/feishu/media/")) {
      return feishuMedia(request, env, decodeURIComponent(url.pathname.slice("/api/feishu/media/".length)));
    }
    if (url.pathname === "/api/local-media/assets") {
      return json({ assets: [], configured: false, recordsScanned: 0, fetchedAt: new Date().toISOString(), source: "" });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (assetPath) => env.ASSETS.fetch(new Request(new URL(assetPath, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
