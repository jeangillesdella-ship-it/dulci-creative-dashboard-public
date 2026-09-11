import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

const owner = "jeangillesdella-ship-it";
const repo = "dulci-creative-dashboard-public";
const tag = "dulci-media";
const projectRoot = "/Users/leon/Documents/优化建议/dulci-public-site";
const videoRoot = "/Users/leon/Documents/优化建议/creative-media/videos";
const thumbnailRoot = "/Users/leon/Documents/优化建议/creative-media/thumbnails";
const videoPattern = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;

function githubCredential() {
  const raw = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  const credential = Object.fromEntries(raw.trim().split(/\n/).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  if (!credential.password) throw new Error("未找到 GitHub 凭证");
  return credential.password;
}

const token = githubCredential();

async function github(pathname, options = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "dulci-media-publisher",
      ...(options.headers || {}),
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let body;
  try { body = JSON.parse(text || "{}"); } catch { body = text; }
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}: ${typeof body === "string" ? body.slice(0, 180) : body.message}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function ensureRelease() {
  try {
    return await github(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    return github(`/repos/${owner}/${repo}/releases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag_name: tag, name: "DulCi 公开素材库", body: "DulCi 看板公开视频与预览图。由自动同步任务维护。", draft: false, prerelease: false }),
    });
  }
}

async function listReleaseAssets(releaseId) {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(`/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`);
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

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

function mediaId(filePath) {
  return createHash("sha256").update(relative(videoRoot, filePath)).digest("hex").slice(0, 24);
}

function contentType(filePath) {
  return ({
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".png": "image/png",
  })[extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function uploadAsset(uploadUrl, filePath, assetName) {
  const bytes = await readFile(filePath);
  const url = `${uploadUrl.replace(/\{.*$/, "")}?name=${encodeURIComponent(assetName)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": contentType(filePath),
      "content-length": String(bytes.length),
      "x-github-api-version": "2022-11-28",
      "user-agent": "dulci-media-publisher",
    },
    body: bytes,
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 180);
    try { message = JSON.parse(text).message || message; } catch {}
    throw new Error(`上传 ${assetName} 失败：${response.status} ${message}`);
  }
}

const release = await ensureRelease();
const existing = new Map((await listReleaseAssets(release.id)).map((asset) => [asset.name, asset]));
const videoFiles = (await walk(videoRoot)).filter((filePath) => videoPattern.test(filePath));
const records = [];
const uploadQueue = [];

for (const filePath of videoFiles) {
  const id = mediaId(filePath);
  const videoName = `${id}${extname(filePath).toLowerCase()}`;
  const thumbnailPath = join(thumbnailRoot, `${id}.png`);
  const thumbnailName = `${id}.png`;
  const fileStat = await stat(filePath);
  const currentVideo = existing.get(videoName);
  if (!currentVideo || Number(currentVideo.size) !== fileStat.size) {
    if (currentVideo) await github(`/repos/${owner}/${repo}/releases/assets/${currentVideo.id}`, { method: "DELETE" });
    uploadQueue.push({ filePath, assetName: videoName });
  }
  let hasThumbnail = false;
  try {
    const thumbnailStat = await stat(thumbnailPath);
    hasThumbnail = true;
    const currentThumbnail = existing.get(thumbnailName);
    if (!currentThumbnail || Number(currentThumbnail.size) !== thumbnailStat.size) {
      if (currentThumbnail) await github(`/repos/${owner}/${repo}/releases/assets/${currentThumbnail.id}`, { method: "DELETE" });
      uploadQueue.push({ filePath: thumbnailPath, assetName: thumbnailName });
    }
  } catch {}
  const fileName = basename(filePath);
  const encodedTag = encodeURIComponent(tag);
  records.push({
    creativeName: fileName,
    normalizedName: normalizeCreativeName(fileName),
    fileName,
    folder: relative(videoRoot, filePath).split("/").slice(0, -1).join("/"),
    size: fileStat.size,
    updatedAt: fileStat.mtime.toISOString(),
    mediaUrl: `https://github.com/${owner}/${repo}/releases/download/${encodedTag}/${encodeURIComponent(videoName)}`,
    thumbnailUrl: hasThumbnail ? `https://github.com/${owner}/${repo}/releases/download/${encodedTag}/${encodeURIComponent(thumbnailName)}` : "",
    source: "public-github-release",
  });
}

console.log(`素材 ${records.length} 条，待上传文件 ${uploadQueue.length} 个`);
let cursor = 0;
let completed = 0;
async function uploader() {
  while (cursor < uploadQueue.length) {
    const item = uploadQueue[cursor++];
    await uploadAsset(release.upload_url, item.filePath, item.assetName);
    completed += 1;
    if (completed % 10 === 0 || completed === uploadQueue.length) console.log(`已上传 ${completed}/${uploadQueue.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, uploader));

const unique = new Map();
records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).forEach((record) => {
  if (record.normalizedName && !unique.has(record.normalizedName)) unique.set(record.normalizedName, record);
});
const manifest = {
  assets: [...unique.values()],
  configured: unique.size > 0,
  recordsScanned: records.length,
  source: "DulCi 公开素材库",
  fetchedAt: new Date().toISOString(),
};
await writeFile(join(projectRoot, "public/data/assets.json"), JSON.stringify(manifest));
console.log(JSON.stringify({ release: release.html_url, assets: unique.size, uploaded: completed, manifest: "public/data/assets.json" }));
