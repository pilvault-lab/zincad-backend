const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3001;

// Keep yt-dlp up to date at startup (non-blocking)
function updateYtDlp() {
  const proc = spawn("yt-dlp", ["--update-to", "stable"], { stdio: "pipe" });
  proc.stdout.on("data", (d) => console.log("[yt-dlp update]", d.toString().trim()));
  proc.stderr.on("data", (d) => console.warn("[yt-dlp update]", d.toString().trim()));
  proc.on("close", (code) => console.log(`[yt-dlp update] exit ${code}`));
}
try { updateYtDlp(); } catch (_) {}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Common yt-dlp flags used across all calls
const BASE_ARGS = [
  "--no-warnings",
  "--no-playlist",
  "--no-check-certificates",
  "--force-ipv4",
  "--user-agent", USER_AGENT,
  "--socket-timeout", "30",
  "--retries", "5",
  "--fragment-retries", "5",
  "--concurrent-fragments", "4",
];

// Platform-specific extra args
function platformArgs(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }

  if (host.includes("youtube.com") || host.includes("youtu.be")) {
    return [
      // Try multiple clients in order — ios tends to work best for age-gated/restricted
      "--extractor-args", "youtube:player_client=ios,android,web,mweb,tv_embedded",
      // Skip broken JS player that triggers bot-detection
      "--extractor-args", "youtube:player_skip=webpage,configs",
      // Use PO token workaround for non-logged-in downloads
      "--extractor-args", "youtube:skip=dash",
    ];
  }

  if (host.includes("instagram.com")) {
    return [
      "--add-header", "Referer:https://www.instagram.com/",
      "--add-header", "X-IG-App-ID:936619743392459",
      "--add-header", "X-IG-WWW-Claim:0",
      "--add-header", "Origin:https://www.instagram.com",
      "--add-header", "X-Requested-With:XMLHttpRequest",
      "--add-header", "Accept:*/*",
      "--add-header", "Accept-Language:en-US,en;q=0.9",
      // Gentle rate limiting to avoid Instagram blocking
      "--sleep-interval", "1",
      "--max-sleep-interval", "3",
    ];
  }

  if (host.includes("tiktok.com")) {
    return [
      "--add-header", "Referer:https://www.tiktok.com/",
      "--add-header", "Accept-Language:en-US,en;q=0.9",
    ];
  }

  if (host.includes("twitter.com") || host.includes("x.com")) {
    return [
      "--add-header", "Authorization:Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
    ];
  }

  return [];
}

app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a minute and try again." },
});

app.use(limiter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Validate URL
function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Detect platform from URL
function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "YouTube";
    if (host.includes("tiktok.com")) return "TikTok";
    if (host.includes("instagram.com")) return "Instagram";
    if (host.includes("twitter.com") || host.includes("x.com")) return "Twitter";
    if (host.includes("facebook.com") || host.includes("fb.watch")) return "Facebook";
    if (host.includes("reddit.com")) return "Reddit";
    if (host.includes("vimeo.com")) return "Vimeo";
    if (host.includes("twitch.tv")) return "Twitch";
    if (host.includes("dailymotion.com")) return "Dailymotion";
  } catch (_) {}
  return "Other";
}

// Format duration from seconds
function formatDuration(seconds) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Sanitize filename for Content-Disposition
function sanitizeFilename(name) {
  return name.replace(/[^\w\s\-_.()]/g, "").replace(/\s+/g, "_").trim() || "download";
}

// Generate a unique temp path
function tmpPath(ext) {
  const id = crypto.randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `zincad-${id}.${ext}`);
}

// Delete file silently, plus common merge artifacts
function deleteFile(filepath) {
  fs.unlink(filepath, () => {});
  const dir = path.dirname(filepath);
  const base = path.basename(filepath, path.extname(filepath));
  for (const ext of [".mp4", ".webm", ".mkv", ".m4a", ".mp3", ".part", ".temp", ".ytdl"]) {
    fs.unlink(path.join(dir, base + ext), () => {});
  }
}

// Parse human-readable yt-dlp error into a user-friendly message
function friendlyError(stderr = "") {
  const s = stderr.toLowerCase();

  if (s.includes("private video") || s.includes("video is private"))
    return "This video is private and cannot be downloaded.";
  if (s.includes("age") && (s.includes("restricted") || s.includes("confirmation")))
    return "This video is age-restricted. Try a different source.";
  if (s.includes("drm") || s.includes("widevine"))
    return "This video is DRM-protected and cannot be downloaded.";
  if (s.includes("login") || s.includes("sign in") || s.includes("log in"))
    return "This video requires a login to access.";
  if (s.includes("not available") || s.includes("unavailable"))
    return "This video is not available in your region or has been removed.";
  if (s.includes("copyright") || s.includes("blocked"))
    return "This video has been blocked due to copyright restrictions.";
  if (s.includes("no video formats found") || s.includes("no format"))
    return "No downloadable formats were found for this video.";
  if (s.includes("unsupported url") || s.includes("is not supported"))
    return "This URL or platform is not supported.";
  if (s.includes("connection") || s.includes("network") || s.includes("timeout"))
    return "Network error while fetching the video. Please try again.";
  if (s.includes("429") || s.includes("rate limit"))
    return "Rate limited by the platform. Please try again in a moment.";

  // Try to surface the raw yt-dlp ERROR line
  const match = stderr.match(/ERROR:\s*(.+)/);
  if (match) return match[1].trim();

  return "Couldn't fetch video info. The URL may be private, DRM-protected, or unsupported.";
}

// POST /api/info — get video metadata and available formats
app.post("/api/info", async (req, res) => {
  const { url } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Please provide a valid URL." });
  }

  console.log(`[info] ${url}`);

  try {
    const { stdout } = await execFileAsync("yt-dlp", [
      "--dump-json",
      ...BASE_ARGS,
      ...platformArgs(url),
      url,
    ], { timeout: 90000, maxBuffer: 20 * 1024 * 1024 });

    const data = JSON.parse(stdout);
    const platform = detectPlatform(url);

    const formats = [];

    const hasVideo = data.formats?.some(f => f.vcodec && f.vcodec !== "none" && f.height);
    const hasAudio = data.formats?.some(f => f.acodec && f.acodec !== "none");

    if (hasVideo) {
      const heights = new Set();
      for (const f of data.formats) {
        if (f.vcodec && f.vcodec !== "none" && f.height) {
          heights.add(f.height);
        }
      }
      const maxHeight = Math.max(...heights, 0);

      const tiers = [
        { label: "4K", height: 2160 },
        { label: "1080p", height: 1080 },
        { label: "720p", height: 720 },
        { label: "480p", height: 480 },
        { label: "360p", height: 360 },
      ];

      for (const tier of tiers) {
        if (tier.height > maxHeight) continue;

        // Find closest filesize estimate for this tier
        let filesize = null;
        const nearby = data.formats.filter(f =>
          f.height && Math.abs(f.height - tier.height) <= tier.height * 0.25
        );
        for (const f of nearby) {
          filesize = f.filesize || f.filesize_approx || filesize;
        }

        formats.push({
          type: "video",
          quality: tier.label,
          ext: "mp4",
          filesize,
          formatStr: `bestvideo[height<=${tier.height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${tier.height}]+bestaudio/best[height<=${tier.height}]/best`,
        });
      }

      // Fallback if nothing matched
      if (formats.length === 0) {
        formats.push({
          type: "video",
          quality: "Best",
          ext: "mp4",
          filesize: null,
          formatStr: "bestvideo+bestaudio/best",
        });
      }
    } else if (!hasVideo) {
      // Video-only or single-stream formats (e.g. some Instagram reels)
      const best = data.formats?.find(f => f.ext === "mp4") || data.formats?.[0];
      if (best) {
        formats.push({
          type: "video",
          quality: best.height ? `${best.height}p` : "Best",
          ext: "mp4",
          filesize: best.filesize || best.filesize_approx || null,
          formatStr: "best[ext=mp4]/best",
        });
      }
    }

    if (hasAudio) {
      formats.push({
        type: "audio",
        quality: "MP3",
        ext: "mp3",
        filesize: null,
        formatStr: "bestaudio/best",
      });
      formats.push({
        type: "audio",
        quality: "M4A",
        ext: "m4a",
        filesize: null,
        formatStr: "bestaudio[ext=m4a]/bestaudio/best",
      });
    }

    if (formats.length === 0) {
      formats.push({
        type: "video",
        quality: "Best",
        ext: "mp4",
        filesize: null,
        formatStr: "best",
      });
    }

    res.json({
      title: data.title || "Untitled",
      duration: formatDuration(data.duration),
      platform,
      formats,
    });
  } catch (err) {
    const stderr = err.stderr || err.message || "";
    console.error("[info error]", stderr.slice(0, 500));

    if (err.killed || (err.message || "").includes("timed out")) {
      return res.status(504).json({ error: "Request timed out — the platform took too long to respond. Please try again." });
    }

    res.status(500).json({ error: friendlyError(stderr) });
  }
});

// GET /api/download — download to temp file, then stream to client
app.get("/api/download", async (req, res) => {
  const { url, format: formatStr, filename } = req.query;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Please provide a valid URL." });
  }

  if (!formatStr) {
    return res.status(400).json({ error: "Please select a format." });
  }

  const ext = req.query.ext || "mp4";
  const safeName = sanitizeFilename(filename || "download") + "." + ext;
  const outFile = tmpPath(ext);

  const contentTypes = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
  };
  const contentType = contentTypes[ext] || "application/octet-stream";

  // Build yt-dlp args
  const args = [
    "-f", formatStr,
    ...BASE_ARGS,
    ...platformArgs(url),
    "-o", outFile,
  ];

  // Force mp4 container after merge
  if (ext === "mp4") {
    args.push("--merge-output-format", "mp4");
    args.push("--postprocessor-args", "ffmpeg:-c:v copy -c:a aac -movflags +faststart");
  }

  // Audio extraction
  if (ext === "mp3") {
    args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "0");
  }

  if (ext === "m4a") {
    args.push("--extract-audio", "--audio-format", "m4a", "--audio-quality", "0");
  }

  args.push(url);

  let aborted = false;

  req.on("close", () => {
    aborted = true;
  });

  console.log(`[download] ${ext} | ${formatStr} | ${url}`);

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn("yt-dlp", args);
      let stderr = "";

      proc.stderr.on("data", (d) => {
        const chunk = d.toString();
        stderr += chunk;
        // Log progress lines but not excessively
        if (chunk.includes("%")) {
          process.stdout.write("\r" + chunk.trim().slice(0, 80));
        }
      });

      proc.on("close", (code) => {
        if (aborted) return reject(new Error("Client disconnected"));
        if (code !== 0) return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        resolve();
      });

      proc.on("error", reject);

      req.on("close", () => {
        proc.kill("SIGTERM");
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} }, 3000);
      });
    });

    if (aborted) {
      deleteFile(outFile);
      return;
    }

    // yt-dlp may change the extension (e.g. extract-audio creates .mp3 from .webm)
    let actualFile = outFile;
    if (!fs.existsSync(actualFile)) {
      const dir = path.dirname(outFile);
      const base = path.basename(outFile, "." + ext);
      const candidates = fs.readdirSync(dir)
        .filter(f => f.startsWith(base) && !f.endsWith(".part"))
        .sort();
      if (candidates.length > 0) {
        actualFile = path.join(dir, candidates[0]);
      } else {
        console.error("[download] Output file not found:", outFile);
        return res.status(500).json({ error: "Download failed — output file not found." });
      }
    }

    const stat = fs.statSync(actualFile);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "no-cache");

    const stream = fs.createReadStream(actualFile);
    stream.pipe(res);

    stream.on("end", () => deleteFile(actualFile));
    stream.on("error", (err) => {
      console.error("[stream error]", err.message);
      deleteFile(actualFile);
      if (!res.headersSent) {
        res.status(500).json({ error: "Download failed." });
      }
    });
  } catch (err) {
    deleteFile(outFile);
    if (aborted) return;
    console.error("[download error]", err.message?.slice(0, 500));
    if (!res.headersSent) {
      res.status(500).json({ error: "Download failed. Please try a different quality or format." });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Zincad backend running on port ${PORT}`);
});
