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

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Common yt-dlp flags used across all calls
const BASE_ARGS = [
  "--no-warnings",
  "--no-playlist",
  "--no-check-certificates",
  "--user-agent", USER_AGENT,
  "--extractor-args", "youtube:player_client=web,default",
];

app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
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
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes("youtube.com") || host.includes("youtu.be")) return "YouTube";
  if (host.includes("tiktok.com")) return "TikTok";
  if (host.includes("instagram.com")) return "Instagram";
  if (host.includes("twitter.com") || host.includes("x.com")) return "Twitter";
  if (host.includes("facebook.com") || host.includes("fb.watch")) return "Facebook";
  if (host.includes("reddit.com")) return "Reddit";
  if (host.includes("vimeo.com")) return "Vimeo";
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

// Delete file silently
function deleteFile(filepath) {
  fs.unlink(filepath, () => {});
  // Also try common merge artifacts
  const dir = path.dirname(filepath);
  const base = path.basename(filepath, path.extname(filepath));
  for (const ext of [".mp4", ".webm", ".mkv", ".m4a", ".mp3", ".part", ".temp"]) {
    fs.unlink(path.join(dir, base + ext), () => {});
  }
}

// POST /api/info — get video metadata and available formats
app.post("/api/info", async (req, res) => {
  const { url } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Please provide a valid URL." });
  }

  try {
    const { stdout } = await execFileAsync("yt-dlp", [
      "--dump-json",
      ...BASE_ARGS,
      url,
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });

    const data = JSON.parse(stdout);
    const platform = detectPlatform(url);

    const formats = [];

    const hasVideo = data.formats?.some(f => f.vcodec && f.vcodec !== "none");
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

        let filesize = null;
        for (const f of data.formats) {
          if (f.height && Math.abs(f.height - tier.height) <= tier.height * 0.2) {
            filesize = f.filesize || f.filesize_approx || filesize;
          }
        }

        formats.push({
          type: "video",
          quality: tier.label,
          ext: "mp4",
          filesize,
          formatStr: `bestvideo[height<=${tier.height}]+bestaudio/best[height<=${tier.height}]/best`,
        });
      }

      if (formats.length === 0) {
        formats.push({
          type: "video",
          quality: "Best",
          ext: "mp4",
          filesize: null,
          formatStr: "bestvideo+bestaudio/best",
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
    console.error("Info error:", err.stderr || err.message);
    if (err.killed) {
      return res.status(504).json({ error: "Request timed out. Please try again." });
    }
    res.status(500).json({ error: "Couldn't fetch video info. The URL may be private, DRM-protected, or unsupported." });
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

  // Build yt-dlp args — download to temp file (handles merge properly)
  const args = [
    "-f", formatStr,
    ...BASE_ARGS,
    "-o", outFile,
  ];

  // For video, force mp4 container after merge
  if (ext === "mp4") {
    args.push("--merge-output-format", "mp4");
  }

  // For mp3, extract audio and convert via ffmpeg
  if (ext === "mp3") {
    args.push("--extract-audio", "--audio-format", "mp3");
    // yt-dlp will create the file with .mp3 extension after conversion
  }

  // For m4a, extract audio
  if (ext === "m4a") {
    args.push("--extract-audio", "--audio-format", "m4a");
  }

  args.push(url);

  let aborted = false;

  req.on("close", () => {
    aborted = true;
    deleteFile(outFile);
  });

  console.log(`Download start: ${ext} | ${formatStr} | ${url}`);

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn("yt-dlp", args);
      let stderr = "";

      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      proc.on("close", (code) => {
        if (aborted) return reject(new Error("Client disconnected"));
        if (code !== 0) return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        resolve();
      });

      proc.on("error", reject);

      req.on("close", () => {
        proc.kill();
      });
    });

    if (aborted) return;

    // yt-dlp may change the extension (e.g. extract-audio creates .mp3 from .webm)
    // Try to find the actual output file
    let actualFile = outFile;
    if (!fs.existsSync(actualFile)) {
      // Search for file with same base name but different extension
      const dir = path.dirname(outFile);
      const base = path.basename(outFile, "." + ext);
      const candidates = fs.readdirSync(dir).filter(f => f.startsWith(base));
      if (candidates.length > 0) {
        actualFile = path.join(dir, candidates[0]);
      } else {
        console.error("Output file not found:", outFile);
        return res.status(500).json({ error: "Download failed — output file not found." });
      }
    }

    const stat = fs.statSync(actualFile);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(actualFile);
    stream.pipe(res);

    stream.on("end", () => {
      deleteFile(actualFile);
    });

    stream.on("error", (err) => {
      console.error("Stream error:", err.message);
      deleteFile(actualFile);
      if (!res.headersSent) {
        res.status(500).json({ error: "Download failed." });
      }
    });
  } catch (err) {
    deleteFile(outFile);
    if (aborted) return;
    console.error("Download error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Download failed. Please try a different format." });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Zincad backend running on port ${PORT}`);
});
