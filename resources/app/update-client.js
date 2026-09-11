const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { app, net } = require("electron");
const { LICENSE_SERVER, APP_TOKEN } = require("./license-client");

function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || "0"; }
  catch { return "0"; }
}

function compareVersion(left, right) {
  const a = String(left || "0").split(".").map(part => Number.parseInt(part, 10) || 0);
  const b = String(right || "0").split(".").map(part => Number.parseInt(part, 10) || 0);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return 1;
    if ((a[i] || 0) < (b[i] || 0)) return -1;
  }
  return 0;
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: "GET", url: `${LICENSE_SERVER}${pathname}` });
    request.setHeader("X-Jx-Token", APP_TOKEN);
    const timer = setTimeout(() => {
      try { request.abort(); } catch {}
      reject(new Error("检查更新超时"));
    }, 15000);
    request.on("response", response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("更新接口返回无法识别")); }
      });
    });
    request.on("error", () => {
      clearTimeout(timer);
      reject(new Error("无法连接更新服务器"));
    });
    request.end();
  });
}

async function checkUpdate() {
  const current = localVersion();
  const remote = await getJson("/v1/update");
  const latest = String(remote.version || "").trim();
  const newer = Boolean(latest && remote.hasFile && compareVersion(latest, current) > 0);
  return {
    ok: true,
    current,
    latest: latest || current,
    notes: remote.notes || "",
    newer,
    hasFile: Boolean(remote.hasFile),
    size: Number(remote.size || 0),
    message: newer ? `发现新版本 ${latest}` : "已是最新版本"
  };
}

function downloadUpdate(onProgress) {
  return new Promise((resolve, reject) => {
    const dir = path.join(os.tmpdir(), "jx-canvas-update");
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, "app.zip");
    const request = net.request({ method: "GET", url: `${LICENSE_SERVER}/updates/app.zip` });
    request.setHeader("X-Jx-Token", APP_TOKEN);
    request.on("response", response => {
      if (response.statusCode !== 200) {
        reject(new Error("下载更新包失败"));
        return;
      }
      const total = Number(response.headers["content-length"] || 0);
      let received = 0;
      const file = fs.createWriteStream(zip);
      response.on("data", chunk => {
        received += chunk.length;
        file.write(chunk);
        if (onProgress) onProgress({ received, total });
      });
      response.on("end", () => {
        file.end();
        file.on("finish", () => resolve({ zip, dir, sha256: hashFile(zip) }));
      });
      response.on("error", error => {
        try { file.close(); } catch {}
        reject(error);
      });
    });
    request.on("error", () => reject(new Error("无法下载更新包")));
    request.end();
  });
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xf", zip, "-C", dest], { windowsHide: true, timeout: 120000 });
  const names = fs.readdirSync(dest);
  if (names.includes("main.js") || names.includes("package.json")) return dest;
  if (names.length === 1) {
    const inner = path.join(dest, names[0]);
    if (fs.statSync(inner).isDirectory()) return inner;
  }
  return dest;
}

function writeApplyScript(extracted, appDir, exePath) {
  const bat = path.join(os.tmpdir(), "jx-canvas-apply-update.bat");
  const text = [
    "@echo off",
    "chcp 65001 >nul",
    "ping 127.0.0.1 -n 3 >nul",
    `xcopy /E /Y /I "${extracted}\\*" "${appDir}\\"`,
    `start "" "${exePath}"`,
    "del \"%~f0\""
  ].join("\r\n");
  fs.writeFileSync(bat, text, "utf8");
  return bat;
}

async function applyUpdate(sendProgress) {
  const status = await checkUpdate();
  if (!status.newer) return status;
  sendProgress?.({ stage: "download", message: "正在下载更新包" });
  const packed = await downloadUpdate(info => sendProgress?.({ stage: "download", ...info }));
  const extractDir = path.join(os.tmpdir(), "jx-canvas-update", "extracted");
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
  sendProgress?.({ stage: "extract", message: "正在解压" });
  const extracted = extractZip(packed.zip, extractDir);
  if (!fs.existsSync(path.join(extracted, "main.js")) && !fs.existsSync(path.join(extracted, "package.json"))) {
    throw new Error("更新包内容不对，缺少程序文件");
  }
  const bat = writeApplyScript(extracted, __dirname, process.execPath);
  spawn("cmd.exe", ["/c", bat], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  setTimeout(() => app.quit(), 400);
  return { ok: true, restarting: true, message: "正在安装并重启" };
}

module.exports = { checkUpdate, applyUpdate, localVersion };
