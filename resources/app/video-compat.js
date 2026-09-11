const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { assertRunning, onAbort, stoppedError, currentSignal } = require("./task-runtime");

function ffmpegCandidates() {
  const portableFolders = [
    process.env.PORTABLE_EXECUTABLE_DIR,
    process.env.PORTABLE_EXECUTABLE_FILE ? path.dirname(process.env.PORTABLE_EXECUTABLE_FILE) : "",
    process.execPath ? path.dirname(process.execPath) : "",
    process.cwd()
  ].filter(Boolean);
  const candidates = [
    process.env.META_CANVAS_FFMPEG,
    process.env.META_CANVAS_FFMPEG_CACHE,
    process.resourcesPath ? path.join(process.resourcesPath, "bin", "ffmpeg.exe") : "",
    process.execPath ? path.join(path.dirname(process.execPath), "resources", "bin", "ffmpeg.exe") : "",
    ...portableFolders.flatMap(folder => [
      path.join(folder, "画布运行组件", "ffmpeg.exe"),
      path.join(folder, "元画布运行组件", "ffmpeg.exe"),
      path.join(folder, "bin", "ffmpeg.exe"),
      path.join(folder, "ffmpeg.exe")
    ]),
    path.join(__dirname, ".ffmpeg-deps", "node_modules", "ffmpeg-static", "ffmpeg.exe")
  ].filter(Boolean).map(candidate => path.resolve(candidate));
  return [...new Set(candidates.map(candidate => candidate.toLowerCase()))]
    .map(lower => candidates.find(candidate => candidate.toLowerCase() === lower));
}

function isUsableFfmpeg(file) {
  try { return fs.statSync(file).isFile() && fs.statSync(file).size > 1024 * 1024; } catch { return false; }
}

function bundledFfmpegPath() {
  return ffmpegCandidates().find(isUsableFfmpeg) || "";
}

function ffmpegStatus() {
  const candidates = ffmpegCandidates();
  const executable = candidates.find(isUsableFfmpeg) || "";
  return { ok: Boolean(executable), executable, candidates };
}

function prepareBundledFfmpegCache(target = process.env.META_CANVAS_FFMPEG_CACHE) {
  const destination = target ? path.resolve(target) : "";
  if (!destination) return ffmpegStatus();
  if (isUsableFfmpeg(destination)) return { ...ffmpegStatus(), cached: true };
  const source = ffmpegCandidates().find(candidate => path.resolve(candidate).toLowerCase() !== destination.toLowerCase() && isUsableFfmpeg(candidate));
  if (!source) return ffmpegStatus();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.download`;
  try {
    fs.copyFileSync(source, temporary);
    if (fs.statSync(temporary).size !== fs.statSync(source).size) throw new Error("H.264 转换器缓存文件不完整");
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    fs.renameSync(temporary, destination);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
  return { ...ffmpegStatus(), cached: true, cacheSource: source };
}

function runFfmpeg(args, { timeout = 30 * 60 * 1000, acceptFailure = false } = {}) {
  const executable = bundledFfmpegPath();
  if (!executable) {
    const error = new Error("程序内置的 H.264 转换器缺失；可能被安全软件隔离，请重新解压完整发布包");
    error.code = "VIDEO_FFMPEG_MISSING";
    error.checkedPaths = ffmpegCandidates();
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    assertRunning();
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const detach = onAbort(() => child.kill());
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-160000); });
    child.on("error", error => {
      detach();
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      detach();
      clearTimeout(timer);
      if (currentSignal()?.aborted) return reject(stoppedError());
      if (code === 0 || acceptFailure) resolve({ code, stderr });
      else {
        const error = new Error(stderr.trim().split(/\r?\n/).slice(-6).join(" ") || `FFmpeg 退出码 ${code}`);
        error.code = "VIDEO_FFMPEG_FAILED";
        reject(error);
      }
    });
  });
}

async function probeVideo(file) {
  if (!fs.existsSync(file)) throw new Error(`视频文件不存在：${file}`);
  const result = await runFfmpeg(["-hide_banner", "-i", file], { timeout: 30000, acceptFailure: true });
  const videoLine = result.stderr.split(/\r?\n/).find(line => /Video:\s*/i.test(line)) || "";
  const codecMatch = videoLine.match(/Video:\s*([^,\s]+)/i);
  const pixelMatch = videoLine.match(/,\s*(yuv[a-z0-9]+)(?:\([^)]*\))?\s*[,\s]/i);
  const rawCodec = String(codecMatch?.[1] || "").toLowerCase();
  const codec = /^(?:h264|avc1|avc3)$/.test(rawCodec) ? "h264" : /^(?:hevc|h265|hvc1|hev1)$/.test(rawCodec) ? "h265" : rawCodec || "unknown";
  return { codec, pixelFormat: String(pixelMatch?.[1] || "").toLowerCase(), description: videoLine.trim() };
}

async function ensureH264Mp4(file, log = () => {}) {
  const source = await probeVideo(file);
  if (source.codec === "h264" && (!source.pixelFormat || source.pixelFormat === "yuv420p")) {
    log(`视频编码验证通过：H.264${source.pixelFormat ? ` / ${source.pixelFormat}` : ""}`);
    return { file, converted: false, source, output: source };
  }

  const token = crypto.randomUUID();
  const temporary = path.join(path.dirname(file), `.${path.basename(file, path.extname(file))}.h264-${token}.mp4`);
  const backup = `${file}.source-${token}.bak`;
  log(`检测到 ${source.codec.toUpperCase()}${source.pixelFormat ? ` / ${source.pixelFormat}` : ""}，正在转换为 H.264 / yuv420p……`);
  try {
    await runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "warning", "-i", file,
      "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", temporary
    ]);
    const output = await probeVideo(temporary);
    if (output.codec !== "h264" || output.pixelFormat !== "yuv420p" || fs.statSync(temporary).size < 1024) {
      const error = new Error(`转换后编码校验失败：${output.description || output.codec}`);
      error.code = "VIDEO_H264_VERIFY_FAILED";
      throw error;
    }
    fs.renameSync(file, backup);
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      fs.renameSync(backup, file);
      throw error;
    }
    fs.unlinkSync(backup);
    log("H.264 转换及编码复核完成");
    return { file, converted: true, source, output };
  } catch (cause) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    if (cause.code === "DOUBAO_TASK_STOPPED") throw cause;
    const error = new Error(`视频无法转换为 H.264：${cause.message}`);
    error.code = "VIDEO_H264_CONVERSION_FAILED";
    error.cause = cause;
    error.checkedPaths = cause.checkedPaths || [];
    throw error;
  }
}

module.exports = { bundledFfmpegPath, ensureH264Mp4, ffmpegCandidates, ffmpegStatus, prepareBundledFfmpegCache, probeVideo, runFfmpeg };
