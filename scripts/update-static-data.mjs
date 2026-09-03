import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.ADJUST_API_TOKEN;
if (!token) throw new Error("Missing ADJUST_API_TOKEN");

const metrics = [
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

const params = new URLSearchParams({
  date_period: "-92d:-0d",
  dimensions: "day,partner_name,channel,campaign_id_network,campaign_network,adgroup_id_network,adgroup_network,creative_id_network,creative_network",
  metrics: metrics.join(","),
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
});

const response = await fetch(`https://automate.adjust.com/reports-service/report?${params}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const body = await response.text();
if (!response.ok) throw new Error(`Adjust request failed: ${response.status} ${body.slice(0, 180)}`);
const report = JSON.parse(body);
const payload = {
  rows: report.rows || [],
  fetchedAt: new Date().toISOString(),
  datePeriod: "最近 93 天（UTC，每 30 分钟自动更新）",
  source: "Adjust Report Service API · Google + Meta + TikTok · daily creative grain · subpur revenue",
  warnings: report.warnings || [],
};

await mkdir("public/data", { recursive: true });
await writeFile("public/data/latest.json", JSON.stringify(payload));
console.log(`Saved ${payload.rows.length} daily creative rows at ${payload.fetchedAt}`);
