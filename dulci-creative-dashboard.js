const $ = (selector) => document.querySelector(selector);
const STATIC_DATA_URL = "./data/latest.json";
const REVENUE_METRIC = "dulci_subpur_d14_s2s_w1_revenue_cohort";
const SUBPUR_EVENT_METRIC = "dulci_subpur_d7_s2s_w1_events_cohort";
const EVENT_UNIT_COST_SUFFIX = "__unit_cost";
const CHANNELS = [
  { name: "Facebook", label: "Meta", className: "meta", color: "#637bef" },
  { name: "TikTok for Business", label: "TikTok", className: "tiktok", color: "#252b39" },
  { name: "Google Ads", label: "Google", className: "google", color: "#4285f4" }
];
const GOOGLE_GENERIC_CREATIVES = new Set(["display", "youtube youtubevideos", "search googlesearch", "search searchpartners"]);

const EVENT_METRICS = [
  { key: SUBPUR_EVENT_METRIC, label: "Subpur W1 事件", short: "Subpur W1", selected: true },
  { key: "dulci_open_002t_24h_events", label: "24h 打开 2 次", short: "打开 2 次" },
  { key: "dulci_online_005m_24h_events", label: "24h 在线 5 分钟", short: "在线 5m" },
  { key: "dulci_online_010m_24h_events", label: "24h 在线 10 分钟", short: "在线 10m", selected: true },
  { key: "dulci_online_020m_24h_events", label: "24h 在线 20 分钟", short: "在线 20m" },
  { key: "dulci_online_030m_life_events", label: "生命周期在线 30 分钟", short: "在线 30m" },
  { key: "dulci_online_060m_24h_events", label: "24h 在线 60 分钟", short: "在线 60m" },
  { key: "dulci_msg_001t_24h_events", label: "24h 消息 1 条", short: "消息 1 条", selected: true },
  { key: "dulci_msg_010t_24h_events", label: "24h 消息 10 条", short: "消息 10 条", selected: true },
  { key: "dulci_msg_030t_24h_events", label: "24h 消息 30 条", short: "消息 30 条", selected: true },
  { key: "dulci_msg_050t_24h_events", label: "24h 消息 50 条", short: "消息 50 条" },
  { key: "dulci_purchase_events", label: "Purchase 事件", short: "Purchase" },
  { key: "dulci_purchase_d0_events_cohort", label: "D0 Purchase 同期群", short: "D0 Purchase" },
  { key: "dulci_purchase_d7_s2s_events", label: "Purchase D7 S2S", short: "Purchase D7" },
  { key: "dulci_relogin_24h_d0_events_cohort_cal", label: "D0 24h 回登", short: "24h 回登" },
  { key: "dulci_realsubscription_d0_events_cohort_cal", label: "D0 真实订阅（日历）", short: "真实订阅 Cal" },
  { key: "dulci_realsubscription_d0_events_cohort", label: "D0 真实订阅", short: "真实订阅" },
  { key: "retained_users_d0", label: "D0 留存用户", short: "D0 留存" },
  { key: "retained_users_d1", label: "D1 留存用户", short: "D1 留存用户" }
];

const defaultEvents = EVENT_METRICS.filter((metric) => metric.selected).map((metric) => metric.key);
let savedEvents = [];
try { savedEvents = JSON.parse(localStorage.getItem("dulci-selected-events") || "[]"); } catch {}
const validSavedEvents = savedEvents.filter((key) => EVENT_METRICS.some((metric) => metric.key === key));
const eventSelectionVersion = "20260831-msg001";
if (localStorage.getItem("dulci-event-selection-version") !== eventSelectionVersion) {
  if (!validSavedEvents.includes("dulci_msg_001t_24h_events")) validSavedEvents.push("dulci_msg_001t_24h_events");
  localStorage.setItem("dulci-event-selection-version", eventSelectionVersion);
  localStorage.setItem("dulci-selected-events", JSON.stringify(validSavedEvents));
}

const state = {
  rows: [],
  trend: [],
  filtered: [],
  fetchedAt: "",
  expanded: new Set(),
  expandableKeys: new Set(),
  selectedEvents: new Set(validSavedEvents.length ? validSavedEvents : defaultEvents),
  sortKey: "subpurRevenue",
  sortDirection: "desc",
  metricFilters: new Map(),
  activeMetricFilter: "",
  creativeAssets: new Map(),
  videoConfigured: false,
  videoRecordsScanned: 0,
  videoFetchedAt: "",
  videoError: "",
  videoSource: ""
};
let previewObserver = null;

const PIVOT_DIMENSIONS = {
  channel: { key: "channel", label: "渠道", value: (row) => row.channel || row.partner_name || "未知渠道", id: (row) => row.channel || row.partner_name || "unknown-channel" },
  campaign: { key: "campaign", label: "Campaign", value: (row) => row.campaign_network || "未命名 Campaign", id: (row) => row.campaign_id_network || row.campaign_network || "unknown-campaign" },
  group: { key: "group", label: "Group", value: (row) => row.adgroup_network || "未命名 Group", id: (row) => row.adgroup_id_network || row.adgroup_network || "unknown-group" },
  creative: { key: "creative", label: "素材", value: (row) => row.creative_network || row.creative_id_network || "未命名素材", id: (row) => row.creative_id_network || row.creative_network || "unknown-creative" }
};

const PIVOT_MODES = {
  creative: { label: "素材", dimensions: [PIVOT_DIMENSIONS.creative] },
  channelCreative: { label: "渠道 → 素材", dimensions: [PIVOT_DIMENSIONS.channel, PIVOT_DIMENSIONS.creative] },
  campaignCreative: { label: "Campaign → 素材", dimensions: [PIVOT_DIMENSIONS.campaign, PIVOT_DIMENSIONS.creative] },
  groupCreative: { label: "Group → 素材", dimensions: [PIVOT_DIMENSIONS.group, PIVOT_DIMENSIONS.creative] },
  full: { label: "渠道 → Campaign → Group → 素材", dimensions: [PIVOT_DIMENSIONS.channel, PIVOT_DIMENSIONS.campaign, PIVOT_DIMENSIONS.group, PIVOT_DIMENSIONS.creative] }
};

const n = (value) => Number(value) || 0;
const fmt = (value) => n(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const money = (value) => `$${n(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (value) => `${(n(value) * 100).toFixed(1)}%`;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const eventUnitCostKey = (key) => `${key}${EVENT_UNIT_COST_SUFFIX}`;
const eventKeyFromUnitCost = (key) => String(key).endsWith(EVENT_UNIT_COST_SUFFIX) ? String(key).slice(0, -EVENT_UNIT_COST_SUFFIX.length) : "";
const unitMoney = (value) => value == null ? "—" : money(value);

function normalizeCreativeName(value) {
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

function creativeAssetFor(name) {
  return state.creativeAssets.get(normalizeCreativeName(name)) || null;
}

function channelDefinition(name) {
  return CHANNELS.find((channel) => channel.name === name) || { name, label: name, className: "other", color: "#8892a6" };
}

function isMatchableCreativeName(name) {
  return !GOOGLE_GENERIC_CREATIVES.has(String(name || "").trim().toLowerCase());
}

function iso(days = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function derived(row) {
  const cost = n(row.cost);
  const subpurRevenue = n(row[REVENUE_METRIC]);
  return {
    ...row,
    subpurRevenue,
    subpurEvents: n(row[SUBPUR_EVENT_METRIC]),
    roas: cost ? subpurRevenue / cost : 0
  };
}

function totals(rows) {
  const sum = (key) => rows.reduce((total, row) => total + n(row[key]), 0);
  const cost = sum("cost");
  const installs = sum("installs");
  const subpurRevenue = sum(REVENUE_METRIC);
  return {
    cost,
    installs,
    subpurRevenue,
    subpurEvents: sum(SUBPUR_EVENT_METRIC),
    ecpi: installs ? cost / installs : 0,
    roas: cost ? subpurRevenue / cost : 0,
    creatives: new Set(rows.map((row) => row.creative_id_network || row.creative_network).filter(Boolean)).size
  };
}

function rowsForPeriod(rows, start, end) {
  return rows.filter((row) => row.day && row.day >= start && row.day <= end);
}

function aggregateCreativeRows(rows) {
  const dimensions = [
    "partner_name", "channel", "campaign_id_network", "campaign_network",
    "adgroup_id_network", "adgroup_network", "creative_id_network", "creative_network"
  ];
  const additive = [
    "installs", "reattributions", "cost", "dulci_purchase_d0_events_cohort",
    ...EVENT_METRICS.map((metric) => metric.key)
  ];
  const grouped = new Map();
  for (const row of rows) {
    const id = dimensions.map((key) => String(row[key] || "")).join("\u001f");
    if (!grouped.has(id)) grouped.set(id, Object.fromEntries(dimensions.map((key) => [key, row[key] || ""])));
    const current = grouped.get(id);
    for (const key of additive) current[key] = n(current[key]) + n(row[key]);
  }
  return [...grouped.values()].map((row) => ({ ...row, ecpi_all: n(row.installs) ? n(row.cost) / n(row.installs) : 0 }));
}

function option(select, values, allLabel) {
  const current = select.value;
  const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">${allLabel}</option>${options.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;
  if ([...select.options].some((item) => item.value === current)) select.value = current;
}

function suggestions(list, values) {
  const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  list.innerHTML = options.map((value) => `<option value="${esc(value)}"></option>`).join("");
}

function containsFilter(value, query) {
  return !query || String(value || "").toLowerCase().includes(query.toLowerCase());
}

function refreshOptions() {
  const channel = $("#channel").value;
  option($("#channel"), state.rows.map((row) => row.channel || row.partner_name), "全部渠道");
  const base = state.rows.filter((row) => !channel || (row.channel || row.partner_name) === channel);
  suggestions($("#campaignOptions"), base.map((row) => row.campaign_network));
  const campaign = $("#campaign").value.trim();
  suggestions($("#groupOptions"), base.filter((row) => containsFilter(row.campaign_network, campaign)).map((row) => row.adgroup_network));
}

function applyFilters() {
  const channel = $("#channel").value;
  const campaign = $("#campaign").value;
  const group = $("#group").value;
  const videoMatch = $("#videoMatch").value;
  const query = $("#creativeSearch").value.trim().toLowerCase();
  state.filtered = state.rows.filter((row) => {
    const creativeName = row.creative_network || row.creative_id_network || "";
    const hasVideo = Boolean(creativeAssetFor(creativeName));
    return (
    (!channel || (row.channel || row.partner_name) === channel) &&
    containsFilter(row.campaign_network, campaign.trim()) &&
    containsFilter(row.adgroup_network, group.trim()) &&
    (!videoMatch || (videoMatch === "matched" ? hasVideo : !hasVideo)) &&
    (!query || `${row.creative_network} ${row.creative_id_network}`.toLowerCase().includes(query))
    );
  }).map(derived);
  initializePivotExpansion();
  render();
}

function renderEventMenu() {
  $("#eventMenu").innerHTML = `<div class="event-menu-head"><div><b>选择透视表事件列</b><small>每个事件同时展示次数与单价</small></div><button type="button" id="clearEvents">清空</button></div>${EVENT_METRICS.map((metric) => `<label><input type="checkbox" value="${metric.key}" ${state.selectedEvents.has(metric.key) ? "checked" : ""}/><span>${metric.label}</span><small>${metric.key}</small></label>`).join("")}`;
  const selected = EVENT_METRICS.filter((metric) => state.selectedEvents.has(metric.key));
  $("#eventPickerLabel").textContent = selected.length === 1 ? selected[0].short : `已选 ${selected.length} 个事件`;
}

function selectedEventDefinitions() {
  return EVENT_METRICS.filter((metric) => state.selectedEvents.has(metric.key));
}

function renderKpis() {
  const current = totals(state.filtered);
  const cards = [
    ["花费", money(current.cost), "媒体 network cost"],
    ["安装", fmt(current.installs), "Adjust installs"],
    ["eCPI", money(current.ecpi), "花费 ÷ 安装"],
    ["Subpur 事件", fmt(current.subpurEvents), "dulci_subpur_d7_s2s_w1"],
    ["Subpur 收入", money(current.subpurRevenue), "dulci_subpur_d14_s2s_w1"],
    ["Subpur ROAS", pct(current.roas), "Subpur 收入 ÷ 花费"],
    ["素材数", fmt(current.creatives), "去重 Creative ID"],
  ];
  $("#kpis").innerHTML = cards.map((card) => `<div class="kpi"><span>${card[0]}</span><strong>${card[1]}</strong><small>${card[2]}</small></div>`).join("");
}

function renderTrend() {
  const channel = $("#channel").value;
  const narrowed = $("#campaign").value || $("#group").value || $("#creativeSearch").value.trim();
  $("#trendNote").textContent = narrowed ? "渠道级 UTC 趋势；Campaign、Group、素材筛选仅作用于卡片与透视表" : "按 UTC 日期汇总";
  const rows = state.trend.filter((row) => !channel || (row.channel || row.partner_name) === channel);
  const byDay = new Map();
  for (const row of rows) {
    const item = byDay.get(row.day) || { day: row.day, cost: 0, revenue: 0 };
    item.cost += n(row.cost);
    item.revenue += n(row[REVENUE_METRIC]);
    byDay.set(row.day, item);
  }
  const data = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  if (!data.length) {
    $("#trendChart").innerHTML = '<div class="message">当前筛选无趋势数据</div>';
    return;
  }
  const width = 720, height = 225, padding = { left: 35, right: 12, top: 10, bottom: 25 };
  const max = Math.max(1, ...data.flatMap((item) => [item.cost, item.revenue])) * 1.08;
  const step = (width - padding.left - padding.right) / Math.max(1, data.length - 1);
  const points = (key) => data.map((item, index) => `${padding.left + index * step},${padding.top + (height - padding.top - padding.bottom) * (1 - item[key] / max)}`).join(" ");
  $("#trendChart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="每日花费与 Subpur 收入趋势">${[.25, .5, .75, 1].map((value) => `<line class="grid" x1="${padding.left}" x2="${width - padding.right}" y1="${padding.top + (height - padding.top - padding.bottom) * (1 - value)}" y2="${padding.top + (height - padding.top - padding.bottom) * (1 - value)}"/><text x="${padding.left - 5}" y="${padding.top + (height - padding.top - padding.bottom) * (1 - value) + 3}" text-anchor="end">$${Math.round(max * value)}</text>`).join("")}<polyline class="cost-line" points="${points("cost")}"/><polyline class="revenue-line" points="${points("revenue")}"/>${data.map((item, index) => `<text x="${padding.left + index * step}" y="${height - 5}" text-anchor="middle">${item.day.slice(5)}</text>`).join("")}</svg>`;
}

function renderChannels() {
  const groups = CHANNELS.map((channel) => ({ ...channel, totals: totals(state.filtered.filter((row) => (row.channel || row.partner_name) === channel.name)) }));
  const maxRoas = Math.max(1, ...groups.map((group) => group.totals.roas));
  $("#channelCompare").innerHTML = groups.map((group) => `<div class="channel-card"><h3><span>${group.label}</span><i style="background:${group.color}"></i></h3><dl><div><dt>花费</dt><dd>${money(group.totals.cost)}</dd></div><div><dt>Subpur 收入</dt><dd>${money(group.totals.subpurRevenue)}</dd></div><div><dt>Subpur 事件</dt><dd>${fmt(group.totals.subpurEvents)}</dd></div><div><dt>Subpur ROAS</dt><dd>${pct(group.totals.roas)}</dd></div></dl><div class="roas-track"><i style="width:${group.totals.roas / maxRoas * 100}%"></i></div></div>`).join("");
}

function renderRanking() {
  const rows = [...state.filtered].sort((a, b) => b.subpurRevenue - a.subpurRevenue).slice(0, 10);
  $("#creativeRanking").innerHTML = rows.length ? rows.map((row, index) => `<div class="rank"><i>${index + 1}</i><div><b title="${esc(row.creative_network)}">${esc(row.creative_network || row.creative_id_network)}</b><small>${esc(row.channel || row.partner_name)} · ${fmt(row.subpurEvents)} Subpur 事件</small></div><strong>${money(row.subpurRevenue)}</strong></div>`).join("") : '<div class="message">当前筛选无素材</div>';
}

function pivotKey(path) {
  return encodeURIComponent(JSON.stringify(path));
}

function currentPivotMode() {
  return PIVOT_MODES[$("#pivotMode").value] || PIVOT_MODES.creative;
}

function buildPivotTree(rows) {
  const dimensions = currentPivotMode().dimensions;
  const root = { level: -1, value: "全部", path: [], rows: [], children: new Map() };
  for (const row of rows) {
    root.rows.push(row);
    let node = root;
    dimensions.forEach((dimension, level) => {
      const value = dimension.value(row);
      const identifier = dimension.id(row);
      if (!node.children.has(identifier)) node.children.set(identifier, { level, value, identifier, dimension, path: [...node.path, `${dimension.key}:${identifier}`], rows: [], children: new Map(), creativeId: dimension.key === "creative" ? row.creative_id_network : "" });
      node = node.children.get(identifier);
      node.rows.push(row);
    });
  }
  return root;
}

function initializePivotExpansion() {
  const tree = buildPivotTree(state.filtered);
  state.expanded.clear();
  if (currentPivotMode().dimensions.length > 1) {
    for (const firstLevel of tree.children.values()) state.expanded.add(pivotKey(firstLevel.path));
  }
}

function nodeSortValue(node) {
  return metricValue(node, state.sortKey);
}

function nodeSummary(node) {
  if (!node.summary) node.summary = totals(node.rows);
  return node.summary;
}

function metricValue(node, key) {
  const current = nodeSummary(node);
  const eventKey = eventKeyFromUnitCost(key);
  if (eventKey) {
    const eventCount = node.rows.reduce((sum, row) => sum + n(row[eventKey]), 0);
    return eventCount ? current.cost / eventCount : null;
  }
  const core = {
    installs: current.installs,
    cost: current.cost,
    ecpi: current.ecpi,
    subpurRevenue: current.subpurRevenue,
    subpurEvents: current.subpurEvents,
    roas: current.roas
  };
  if (Object.hasOwn(core, key)) return core[key];
  return node.rows.reduce((sum, row) => sum + n(row[key]), 0);
}

function metricLabel(key) {
  const eventKey = eventKeyFromUnitCost(key);
  if (eventKey) return `${EVENT_METRICS.find((metric) => metric.key === eventKey)?.short || eventKey} 单价`;
  const labels = { installs: "安装", cost: "花费", ecpi: "eCPI", subpurRevenue: "Subpur 收入", subpurEvents: "Subpur 事件", roas: "Subpur ROAS" };
  return labels[key] || EVENT_METRICS.find((metric) => metric.key === key)?.short || key;
}

function isPercentMetric(key) {
  return key === "roas";
}

function passesMetricFilters(node) {
  for (const [key, range] of state.metricFilters) {
    const value = metricValue(node, key);
    if (value == null) return false;
    if (range.min != null && value < range.min) return false;
    if (range.max != null && value > range.max) return false;
  }
  return true;
}

function sortIndicator(key) {
  if (state.sortKey !== key) return "↕";
  return state.sortDirection === "asc" ? "↑" : "↓";
}

function metricHeader(key, label, className = "") {
  const active = state.metricFilters.has(key);
  return `<th class="metric-column ${className}"><div class="metric-head"><button type="button" class="metric-sort" data-sort-key="${esc(key)}" title="点击排序">${esc(label)}<i>${sortIndicator(key)}</i></button><button type="button" class="metric-filter-trigger ${active ? "active" : ""}" data-filter-key="${esc(key)}" aria-label="筛选 ${esc(label)}" title="筛选 ${esc(label)}">⌄</button></div></th>`;
}

function flattenPivot(tree) {
  const visible = [];
  state.expandableKeys.clear();
  function walk(node) {
    const children = [...node.children.values()].sort((a, b) => {
      const aValue = nodeSortValue(a);
      const bValue = nodeSortValue(b);
      if (aValue == null && bValue != null) return 1;
      if (aValue != null && bValue == null) return -1;
      const difference = state.sortDirection === "asc" ? aValue - bValue : bValue - aValue;
      return difference || String(a.value).localeCompare(String(b.value));
    });
    for (const child of children) {
      const key = pivotKey(child.path);
      visible.push({ ...child, key });
      if (child.children.size) {
        state.expandableKeys.add(key);
        if (state.expanded.has(key)) walk(child);
      }
    }
  }
  walk(tree);
  return visible;
}

function status(roas) {
  return roas >= .7 ? ["good", "优"] : roas >= .35 ? ["watch", "观察"] : ["low", "偏低"];
}

function renderVideoSyncStatus() {
  const names = [...new Set(state.filtered.map((row) => row.creative_network || row.creative_id_network).filter((name) => name && isMatchableCreativeName(name)))];
  const matched = names.filter((name) => creativeAssetFor(name)).length;
  const statusNode = $("#videoSyncStatus");
  statusNode.className = "video-sync-status";
  if (state.videoError) {
    statusNode.classList.add("error");
    statusNode.textContent = `飞书视频读取失败：${state.videoError}`;
    return;
  }
  if (!state.videoConfigured) {
    statusNode.classList.add("pending");
    statusNode.textContent = "公开分享版已连接数据；视频仍保存在本地素材库";
    return;
  }
  statusNode.classList.add("connected");
  statusNode.textContent = `${state.videoSource || "本地素材库"}已连接 · 当前素材匹配 ${matched} / ${names.length} · 已导入 ${state.videoRecordsScanned} 条视频`;
}

function hydrateVideoPreviews() {
  if (previewObserver) previewObserver.disconnect();
  const previews = [...document.querySelectorAll("video.video-thumb[data-preview-src]")];
  const loadPreview = (video) => {
    if (video.src) return;
    const button = video.closest(".video-play");
    const showFrame = () => button?.classList.add("preview-ready");
    video.addEventListener("loadedmetadata", () => {
      try { video.currentTime = Math.min(0.15, Math.max(0, video.duration || 0.15)); } catch {}
    }, { once: true });
    video.addEventListener("loadeddata", showFrame, { once: true });
    video.addEventListener("seeked", showFrame, { once: true });
    video.addEventListener("error", () => button?.classList.add("preview-error"), { once: true });
    video.preload = "auto";
    video.src = video.dataset.previewSrc;
    video.load();
  };
  if (!("IntersectionObserver" in window)) {
    previews.slice(0, 12).forEach(loadPreview);
    return;
  }
  previewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      loadPreview(entry.target);
      previewObserver.unobserve(entry.target);
    }
  }, { rootMargin: "240px 0px" });
  previews.forEach((video) => previewObserver.observe(video));
}

function renderPivot() {
  const events = selectedEventDefinitions();
  const mode = currentPivotMode();
  $("#pivotHead").innerHTML = `<th class="dimension-head">${mode.label}</th>${metricHeader("installs", "安装")}${metricHeader("cost", "花费")}${metricHeader("ecpi", "eCPI")}${metricHeader("subpurRevenue", "Subpur 收入")}${metricHeader("roas", "Subpur ROAS")}${events.map((event) => `${metricHeader(event.key, event.short, "event-count-column")}${metricHeader(eventUnitCostKey(event.key), `${event.short} 单价`, "event-unit-cost-column")}`).join("")}`;
  const tree = buildPivotTree(state.filtered);
  const allVisible = flattenPivot(tree);
  const visible = allVisible.filter(passesMetricFilters);
  $("#creativeRows").innerHTML = visible.length ? visible.map((node) => {
    const current = nodeSummary(node);
    const hasChildren = node.children.size > 0;
    const expanded = state.expanded.has(node.key);
    const roasStatus = status(current.roas);
    const isChannel = node.dimension.key === "channel";
    const isCreative = node.dimension.key === "creative";
    const channel = isChannel ? channelDefinition(node.value) : null;
    const asset = isCreative ? creativeAssetFor(node.value) : null;
    const videoControl = isCreative
      ? asset
        ? `<button type="button" class="video-play" data-video-url="${esc(asset.mediaUrl)}" data-video-name="${esc(node.value)}" data-video-file="${esc(asset.fileName || asset.creativeName)}" aria-label="播放素材视频：${esc(node.value)}" title="在面板中播放视频">${asset.thumbnailUrl ? `<img src="${esc(asset.thumbnailUrl)}" alt="" loading="lazy"/>` : `<video class="video-thumb" data-preview-src="${esc(asset.mediaUrl)}" muted playsinline preload="none" aria-hidden="true"></video>`}<span>▶</span></button>`
        : ""
      : "";
    const dimension = isCreative
      ? `<div class="pivot-creative"><b title="${esc(node.value)}">${esc(node.value)}</b><small>${esc(node.creativeId || "—")}</small></div>`
      : `<span class="pivot-level-name">${esc(node.value)}</span>`;
    const rowClass = hasChildren ? `pivot-level-${node.level}` : "pivot-leaf";
    return `<tr class="${rowClass}"><td class="pivot-dimension"><div style="--indent:${node.level}">${hasChildren ? `<button type="button" class="pivot-toggle" data-pivot-key="${node.key}" aria-label="${expanded ? "收起" : "展开"}">${expanded ? "−" : "+"}</button>` : '<span class="pivot-spacer"></span>'}${videoControl}${isChannel ? `<span class="channel-pill ${channel.className}">${esc(channel.label)}</span>` : `<span class="level-tag">${node.dimension.label}</span>`}${dimension}</div></td><td>${fmt(current.installs)}</td><td>${money(current.cost)}</td><td>${money(current.ecpi)}</td><td class="revenue-cell">${money(current.subpurRevenue)}</td><td><span class="status-pill ${roasStatus[0]}">${pct(current.roas)} · ${roasStatus[1]}</span></td>${events.map((event) => { const eventCount = node.rows.reduce((sum, row) => sum + n(row[event.key]), 0); return `<td class="event-count-cell">${fmt(eventCount)}</td><td class="event-unit-cost-cell">${unitMoney(eventCount ? current.cost / eventCount : null)}</td>`; }).join("")}</tr>`;
  }).join("") : `<tr><td colspan="${6 + events.length * 2}">当前筛选无素材数据</td></tr>`;
  const isDirect = mode.dimensions.length === 1;
  $("#expandAllBtn").disabled = $("#collapseAllBtn").disabled = isDirect;
  $("#clearMetricFiltersBtn").disabled = state.metricFilters.size === 0;
  $("#tableMeta").textContent = `${state.filtered.length.toLocaleString("zh-CN")} 条广告组合 · ${mode.label} · 当前显示 ${visible.length} / ${allVisible.length} 行 · ${state.metricFilters.size} 个指标筛选 · ${events.length} 个事件指标`;
  renderVideoSyncStatus();
  hydrateVideoPreviews();
}

function render() {
  renderKpis();
  renderTrend();
  renderChannels();
  renderRanking();
  renderPivot();
}

async function loadCreativeAssets(refresh = false) {
  state.videoError = "";
  try {
    let sourceData = null;
    try {
      const feishuResponse = await fetch(`/api/feishu/creative-assets${refresh ? "?refresh=1" : ""}`, { cache: refresh ? "no-store" : "default" });
      const feishuData = await feishuResponse.json();
      if (feishuResponse.ok && feishuData.assets?.length) sourceData = feishuData;
      else if (!feishuResponse.ok) throw new Error(feishuData.error || "飞书素材读取失败");
    } catch (error) {
      state.videoError = error.message;
    }
    if (!sourceData) {
      const staticResponse = await fetch(`./data/assets.json${refresh ? `?t=${Date.now()}` : ""}`);
      const staticData = await staticResponse.json();
      if (!staticResponse.ok) throw new Error(staticData.error || "素材库读取失败");
      sourceData = staticData;
    }
    const assets = [...(sourceData.assets || [])];
    state.videoConfigured = Boolean(assets.length);
    state.videoRecordsScanned = assets.length;
    state.videoFetchedAt = sourceData.fetchedAt || "";
    state.videoSource = sourceData.source || (assets.length ? "飞书云盘" : "");
    state.creativeAssets = new Map(assets.map((asset) => [asset.normalizedName || normalizeCreativeName(asset.creativeName || asset.fileName), asset]));
  } catch (error) {
    state.videoConfigured = false;
    state.videoError = error.message;
    state.creativeAssets.clear();
  }
}

async function loadData(refresh = false) {
  $("#queryBtn").disabled = $("#refreshBtn").disabled = true;
  $("#message").className = "message";
  $("#message").textContent = "正在从 Adjust 拉取 Google、Meta 与 TikTok 投放数据…";
  try {
    const response = await fetch(`${STATIC_DATA_URL}${refresh ? `?t=${Date.now()}` : ""}`, { cache: refresh ? "no-store" : "default" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Adjust 查询失败");
    const dailyRows = rowsForPeriod(data.rows || [], $("#startDate").value, $("#endDate").value);
    state.rows = aggregateCreativeRows(dailyRows);
    state.trend = dailyRows;
    state.fetchedAt = data.fetchedAt;
    await loadCreativeAssets(refresh);
    refreshOptions();
    applyFilters();
    $("#sourceDot").className = "ok";
    $("#sourceState").textContent = "Adjust 数据快照";
    $("#freshness").textContent = `更新于 ${new Date(data.fetchedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}${data.cached ? " · 缓存" : ""}`;
    $("#message").className = "message success";
    $("#message").textContent = `已加载 ${state.rows.length} 条投放组合 · Google、Meta 与 TikTok · 当前筛选 ${$("#startDate").value} 至 ${$("#endDate").value} · 数据池 ${data.datePeriod} · 收入仅使用 Subpur 口径`;
  } catch (error) {
    $("#sourceState").textContent = "Adjust 连接失败";
    $("#message").className = "message error";
    $("#message").textContent = error.message;
  } finally {
    $("#queryBtn").disabled = $("#refreshBtn").disabled = false;
  }
}

function exportCsv() {
  if (!state.filtered.length) return;
  const eventColumns = selectedEventDefinitions().flatMap((event) => [
    { label: event.label, value: (row) => row[event.key] },
    { label: `${event.label} 单价`, value: (row) => n(row[event.key]) ? n(row.cost) / n(row[event.key]) : "" }
  ]);
  const columns = [
    { key: "channel", label: "渠道" }, { key: "campaign_network", label: "Campaign" }, { key: "adgroup_network", label: "Group" }, { key: "creative_id_network", label: "Creative ID" }, { key: "creative_network", label: "素材名称" },
    { key: "installs", label: "安装" }, { key: "cost", label: "花费" }, { key: "ecpi_all", label: "eCPI" }, { key: REVENUE_METRIC, label: "Subpur 收入" }, { key: "roas", label: "Subpur ROAS" }, ...eventColumns
  ];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [columns.map((column) => quote(column.label)).join(","), ...state.filtered.map((row) => columns.map((column) => quote(column.value ? column.value(row) : row[column.key])).join(","))].join("\n");
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  anchor.download = `dulci-creative-subpur-${$("#startDate").value}-${$("#endDate").value}.csv`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function syncSortSelect() {
  const select = $("#sortBy");
  select.querySelectorAll("option[data-dynamic]").forEach((option) => option.remove());
  if (![...select.options].some((option) => option.value === state.sortKey)) {
    const option = document.createElement("option");
    option.value = state.sortKey;
    option.textContent = metricLabel(state.sortKey);
    option.dataset.dynamic = "true";
    select.append(option);
  }
  select.value = state.sortKey;
}

function closeMetricFilter() {
  $("#metricFilterPopover").hidden = true;
  state.activeMetricFilter = "";
}

function openVideoModal(button) {
  const video = $("#creativeVideo");
  $("#videoModalTitle").textContent = button.dataset.videoName || "素材视频";
  $("#videoModalMeta").textContent = button.dataset.videoFile || "素材视频";
  video.src = button.dataset.videoUrl;
  $("#videoModal").hidden = false;
  video.play().catch(() => {});
}

function closeVideoModal() {
  const video = $("#creativeVideo");
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("#videoModal").hidden = true;
}

function openMetricFilter(button, key) {
  const popover = $("#metricFilterPopover");
  const current = state.metricFilters.get(key) || {};
  const scale = isPercentMetric(key) ? 100 : 1;
  state.activeMetricFilter = key;
  $("#metricFilterTitle").textContent = `筛选 ${metricLabel(key)}${isPercentMetric(key) ? "（%）" : ""}`;
  $("#metricFilterMin").value = current.min == null ? "" : current.min * scale;
  $("#metricFilterMax").value = current.max == null ? "" : current.max * scale;
  popover.hidden = false;
  const rect = button.getBoundingClientRect();
  const width = 270;
  popover.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width))}px`;
  popover.style.top = `${Math.min(window.innerHeight - 245, rect.bottom + 8)}px`;
}

function applyMetricFilter() {
  const key = state.activeMetricFilter;
  if (!key) return;
  const minInput = $("#metricFilterMin");
  const maxInput = $("#metricFilterMax");
  const scale = isPercentMetric(key) ? 100 : 1;
  const min = minInput.value === "" ? null : Number(minInput.value) / scale;
  const max = maxInput.value === "" ? null : Number(maxInput.value) / scale;
  maxInput.setCustomValidity(min != null && max != null && min > max ? "最大值不能小于最小值" : "");
  if (!maxInput.reportValidity()) return;
  if (min == null && max == null) state.metricFilters.delete(key);
  else state.metricFilters.set(key, { min, max });
  closeMetricFilter();
  renderPivot();
}

$("#startDate").value = iso(-10);
$("#endDate").value = iso(0);
const savedPivotMode = localStorage.getItem("dulci-pivot-mode");
$("#pivotMode").value = PIVOT_MODES[savedPivotMode] ? savedPivotMode : "creative";
renderEventMenu();
$("#queryBtn").onclick = () => loadData();
$("#refreshBtn").onclick = () => loadData(true);
$("#resetBtn").onclick = () => {
  $("#channel").value = $("#campaign").value = $("#group").value = $("#videoMatch").value = $("#creativeSearch").value = "";
  state.metricFilters.clear();
  closeMetricFilter();
  refreshOptions();
  applyFilters();
};
$("#channel").onchange = () => { $("#campaign").value = $("#group").value = ""; refreshOptions(); applyFilters(); };
$("#campaign").oninput = () => { $("#group").value = ""; refreshOptions(); applyFilters(); };
$("#group").oninput = applyFilters;
$("#videoMatch").onchange = applyFilters;
$("#creativeSearch").oninput = applyFilters;
$("#pivotMode").onchange = () => {
  localStorage.setItem("dulci-pivot-mode", $("#pivotMode").value);
  initializePivotExpansion();
  renderPivot();
};
$("#sortBy").onchange = () => {
  state.sortKey = $("#sortBy").value;
  state.sortDirection = "desc";
  renderPivot();
};
$("#exportBtn").onclick = exportCsv;
$("#clearMetricFiltersBtn").onclick = () => {
  state.metricFilters.clear();
  closeMetricFilter();
  renderPivot();
};
$("#expandAllBtn").onclick = () => { state.expandableKeys.forEach((key) => state.expanded.add(key)); renderPivot(); state.expandableKeys.forEach((key) => state.expanded.add(key)); renderPivot(); };
$("#collapseAllBtn").onclick = () => { state.expanded.clear(); renderPivot(); };
$("#creativeRows").onclick = (event) => {
  const videoButton = event.target.closest("[data-video-url]");
  if (videoButton) {
    openVideoModal(videoButton);
    return;
  }
  const button = event.target.closest("[data-pivot-key]");
  if (!button) return;
  const key = button.dataset.pivotKey;
  state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
  renderPivot();
};
$("#pivotHead").onclick = (event) => {
  const sortButton = event.target.closest("[data-sort-key]");
  if (sortButton) {
    const key = sortButton.dataset.sortKey;
    state.sortDirection = state.sortKey === key && state.sortDirection === "desc" ? "asc" : "desc";
    state.sortKey = key;
    syncSortSelect();
    renderPivot();
    return;
  }
  const filterButton = event.target.closest("[data-filter-key]");
  if (filterButton) openMetricFilter(filterButton, filterButton.dataset.filterKey);
};
$("#applyMetricFilter").onclick = applyMetricFilter;
$("#removeMetricFilter").onclick = () => {
  if (state.activeMetricFilter) state.metricFilters.delete(state.activeMetricFilter);
  closeMetricFilter();
  renderPivot();
};
$("#closeMetricFilter").onclick = closeMetricFilter;
$("#closeVideoModal").onclick = closeVideoModal;
$("#videoModal").onclick = (event) => { if (event.target.id === "videoModal") closeVideoModal(); };
$("#eventPickerBtn").onclick = (event) => {
  event.stopPropagation();
  $("#eventMenu").hidden = !$("#eventMenu").hidden;
};
$("#eventMenu").onclick = (event) => {
  event.stopPropagation();
  if (event.target.id === "clearEvents") {
    for (const metric of EVENT_METRICS) {
      state.metricFilters.delete(metric.key);
      state.metricFilters.delete(eventUnitCostKey(metric.key));
    }
    if (EVENT_METRICS.some((metric) => state.sortKey === metric.key || state.sortKey === eventUnitCostKey(metric.key))) {
      state.sortKey = "subpurRevenue";
      state.sortDirection = "desc";
      syncSortSelect();
    }
    state.selectedEvents.clear();
  } else if (event.target.matches('input[type="checkbox"]')) {
    event.target.checked ? state.selectedEvents.add(event.target.value) : state.selectedEvents.delete(event.target.value);
    if (!event.target.checked) {
      state.metricFilters.delete(event.target.value);
      state.metricFilters.delete(eventUnitCostKey(event.target.value));
      if (state.sortKey === event.target.value || state.sortKey === eventUnitCostKey(event.target.value)) {
        state.sortKey = "subpurRevenue";
        state.sortDirection = "desc";
        syncSortSelect();
      }
    }
  } else {
    return;
  }
  localStorage.setItem("dulci-selected-events", JSON.stringify([...state.selectedEvents]));
  renderEventMenu();
  renderPivot();
};
document.addEventListener("click", (event) => {
  if (!event.target.closest(".event-filter")) $("#eventMenu").hidden = true;
  if (!event.target.closest("#metricFilterPopover") && !event.target.closest("[data-filter-key]")) closeMetricFilter();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#videoModal").hidden) closeVideoModal();
});

loadData();
