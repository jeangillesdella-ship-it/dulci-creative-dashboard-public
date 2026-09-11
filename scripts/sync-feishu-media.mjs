import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";

const workspaceRoot = "/Users/leon/Documents/优化建议";
const mediaRoot = join(workspaceRoot, "creative-media");
const videoRoot = join(mediaRoot, "videos");
const thumbnailRoot = join(mediaRoot, "thumbnails");
const folderToken = process.env.FEISHU_DULCI_FOLDER_TOKEN || "Qjf0frYAdlewiRd0rKncv7m3nMg";
const videoPattern = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;

function keychain(service) {
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-w", "-a", "dulci-dashboard", "-s", service], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const appId = process.env.FEISHU_APP_ID || keychain("dulci-feishu-app-id");
const appSecret = process.env.FEISHU_APP_SECRET || keychain("dulci-feishu-app-secret");
if (!appId || !appSecret) throw new Error("缺少飞书 API 凭证");

function safeSegment(value) {
  return String(value || "未命名").normalize("NFKC").replace(/[\\/:*?\"<>|\u0000-\u001f]/g, "_").replace(/^\.+$/, "_");
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text || "{}"); } catch { body = null; }
  if (!response.ok || body?.code !== 0) throw new Error(body?.msg || `${response.status} ${text.slice(0, 160)}`);
  return body;
}

async function tenantToken() {
  const body = await jsonRequest("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!body.tenant_access_token) throw new Error("飞书未返回 tenant_access_token");
  return body.tenant_access_token;
}

async function listFolder(token, currentFolderToken) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ folder_token: currentFolderToken, page_size: "200" });
    if (pageToken) params.set("page_token", pageToken);
    const body = await jsonRequest(`https://open.feishu.cn/open-apis/drive/v1/files?${params}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    files.push(...(body.data?.files || []));
    pageToken = body.data?.has_more ? String(body.data?.next_page_token || body.data?.page_token || "") : "";
  } while (pageToken);
  return files;
}

async function collectVideos(token) {
  const queue = [{ token: folderToken, parts: ["DulCi"] }];
  const seen = new Set();
  const videos = [];
  let foldersScanned = 0;
  while (queue.length) {
    const batch = queue.splice(0, 6).filter((folder) => !seen.has(folder.token));
    batch.forEach((folder) => seen.add(folder.token));
    const results = await Promise.all(batch.map(async (folder) => ({ folder, files: await listFolder(token, folder.token) })));
    for (const { folder, files } of results) {
      foldersScanned += 1;
      for (const file of files) {
        const name = String(file.name || "");
        const itemToken = String(file.token || "");
        if (!itemToken) continue;
        if (file.type === "folder") queue.push({ token: itemToken, parts: [...folder.parts, safeSegment(name)] });
        else if (videoPattern.test(name)) videos.push({ ...file, name, token: itemToken, parts: folder.parts });
      }
    }
    process.stdout.write(`\r扫描飞书目录 ${foldersScanned} 个，发现视频 ${videos.length} 条`);
  }
  process.stdout.write("\n");
  return videos;
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function downloadVideo(token, file, index, total) {
  const destination = join(videoRoot, ...file.parts, safeSegment(file.name));
  await mkdir(dirname(destination), { recursive: true });
  if (await exists(destination)) return { destination, downloaded: false };
  const partial = `${destination}.part`;
  const response = await fetch(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(file.token)}/download`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}: ${file.name}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  await rename(partial, destination);
  console.log(`已下载 ${index + 1}/${total}: ${file.name}`);
  return { destination, downloaded: true };
}

function mediaId(filePath) {
  return createHash("sha256").update(relative(videoRoot, filePath)).digest("hex").slice(0, 24);
}

async function ensureThumbnail(filePath) {
  const thumbnailPath = join(thumbnailRoot, `${mediaId(filePath)}.png`);
  if (await exists(thumbnailPath)) return false;
  await mkdir(thumbnailRoot, { recursive: true });
  const tempDirectory = await mkdtemp(join(tmpdir(), "dulci-preview-"));
  try {
    const result = spawnSync("/usr/bin/qlmanage", ["-t", "-s", "480", "-o", tempDirectory, filePath], {
      stdio: "ignore",
      timeout: 60_000,
    });
    if (result.status !== 0) return false;
    const generated = (await readdir(tempDirectory)).find((name) => name.toLowerCase().endsWith(".png"));
    if (!generated) return false;
    await rename(join(tempDirectory, generated), thumbnailPath);
    return true;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

await mkdir(videoRoot, { recursive: true });
await mkdir(thumbnailRoot, { recursive: true });
const token = await tenantToken();
const videos = await collectVideos(token);
let cursor = 0;
let downloaded = 0;
const results = [];
async function worker() {
  while (cursor < videos.length) {
    const index = cursor++;
    const result = await downloadVideo(token, videos[index], index, videos.length);
    if (result.downloaded) downloaded += 1;
    results.push(result.destination);
  }
}
await Promise.all(Array.from({ length: 3 }, worker));

let thumbnailsCreated = 0;
for (let index = 0; index < results.length; index += 1) {
  if (await ensureThumbnail(results[index])) thumbnailsCreated += 1;
  if ((index + 1) % 20 === 0 || index + 1 === results.length) {
    console.log(`预览图 ${index + 1}/${results.length}`);
  }
}

const localBytes = (await Promise.all(results.map(async (filePath) => (await stat(filePath)).size))).reduce((sum, size) => sum + size, 0);
console.log(JSON.stringify({ foldersScanned: new Set(videos.flatMap((file) => file.parts.join("/"))).size, videosFound: videos.length, downloaded, thumbnailsCreated, localBytes }));
