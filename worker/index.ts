/** Cloudflare Worker entry point for the public Dulci dashboard. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  ADJUST_API_TOKEN?: string;
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

const creativeMetrics = [
  "installs", "reattributions", "cost", "ecpi_all",
  "dulci_purchase_d0_events_cohort",
  "dulci_open_002t_24h_events", "dulci_online_005m_24h_events",
  "dulci_online_010m_24h_events", "dulci_online_020m_24h_events",
  "dulci_online_030m_life_events", "dulci_online_060m_24h_events",
  "dulci_msg_001t_24h_events", "dulci_msg_010t_24h_events",
  "dulci_msg_030t_24h_events", "dulci_msg_050t_24h_events",
  "dulci_purchase_events", "dulci_purchase_d7_s2s_events",
  "dulci_relogin_24h_d0_events_cohort_cal", "retained_users_d0", "retained_users_d1",
  "dulci_realsubscription_d0_events_cohort_cal", "dulci_realsubscription_d0_events_cohort",
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

async function adjustReport(token: string, period: string, dimensions: string, metrics: string, sort?: string) {
  const params = new URLSearchParams({
    date_period: period,
    dimensions,
    metrics,
    app_token__in: "vpis1uwa4dmo",
    partner_name__in: "Facebook,TikTok for Business",
    utc_offset: "+00:00",
    reattributed: "all",
    attribution_source: "dynamic",
    ad_spend_mode: "network",
    cohort_maturity: "immature",
    sandbox: "false",
    format_dates: "false",
  });
  if (sort) params.set("sort", sort);
  const response = await fetch(`https://automate.adjust.com/reports-service/report?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Adjust 请求失败：${response.status} ${body.slice(0, 180)}`);
  try {
    return JSON.parse(body) as { rows?: unknown[]; totals?: Record<string, unknown>; warnings?: unknown[] };
  } catch {
    throw new Error("Adjust 返回内容不是合法 JSON");
  }
}

async function dulciReport(request: Request, env: Env): Promise<Response> {
  try {
    if (!env.ADJUST_API_TOKEN) throw new Error("公开看板尚未配置 Adjust 数据连接");
    const url = new URL(request.url);
    const period = periodFrom(url);
    const refresh = url.searchParams.get("refresh") === "1";
    const cached = reportCache.get(period);
    if (!refresh && cached && Date.now() - cached.cachedAt < 5 * 60 * 1000) {
      return json({ ...cached.payload, cached: true });
    }
    const [creativeReport, trendReport] = await Promise.all([
      adjustReport(
        env.ADJUST_API_TOKEN,
        period,
        "partner_name,channel,campaign_id_network,campaign_network,adgroup_id_network,adgroup_network,creative_id_network,creative_network",
        creativeMetrics.join(","),
        "-dulci_subpur_d14_s2s_w1_revenue_cohort",
      ),
      adjustReport(
        env.ADJUST_API_TOKEN,
        period,
        "day,partner_name,channel",
        "installs,cost,dulci_subpur_d7_s2s_w1_events_cohort,dulci_subpur_d14_s2s_w1_revenue_cohort,retained_users_d1",
      ),
    ]);
    const payload = {
      rows: creativeReport.rows || [],
      totals: creativeReport.totals || {},
      trend: trendReport.rows || [],
      datePeriod: period,
      source: "Adjust Report Service API · Meta + TikTok · creative grain · subpur revenue",
      fetchedAt: new Date().toISOString(),
      warnings: [...(creativeReport.warnings || []), ...(trendReport.warnings || [])],
    };
    reportCache.set(period, { cachedAt: Date.now(), payload });
    if (reportCache.size > 20) reportCache.delete(reportCache.keys().next().value as string);
    return json({ ...payload, cached: false });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "数据查询失败" }, 400);
  }
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/adjust/dulci-creatives") return dulciReport(request, env);
    if (url.pathname === "/api/local-media/assets" || url.pathname === "/api/feishu/creative-assets") {
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
