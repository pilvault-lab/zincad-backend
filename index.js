const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3001;

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
  return name.replace(/[^\w\s\-_.()]/g, "").replace(/\s+/g, " ").trim() || "download";
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
      "--no-warnings",
      "--no-playlist",
      "--no-check-certificates",
      url,
    ], { timeout: 45000, maxBuffer: 10 * 1024 * 1024 });

    const data = JSON.parse(stdout);
    const platform = detectPlatform(url);

    // Build format list using yt-dlp's format selection strings
    // Instead of parsing individual formats, offer preset quality tiers
    // that yt-dlp can merge (video+audio) at download time
    const formats = [];

    const hasVideo = data.formats?.some(f => f.vcodec && f.vcodec !== "none");
    const hasAudio = data.formats?.some(f => f.acodec && f.acodec !== "none");

    if (hasVideo) {
      // Check which resolutions are actually available
      const heights = new Set();
      for (const f of data.formats) {
        if (f.vcodec && f.vcodec !== "none" && f.height) {
          heights.add(f.height);
        }
      }

      const tiers = [
        { label: "4K", height: 2160, format: "bestvideo[height<=2160]+bestaudio/best[height<=2160]" },
        { label: "1080p", height: 1080, format: "bestvideo[height<=1080]+bestaudio/best[height<=1080]" },
        { label: "720p", height: 720, format: "bestvideo[height<=720]+bestaudio/best[height<=720]" },
        { label: "480p", height: 480, format: "bestvideo[height<=480]+bestaudio/best[height<=480]" },
        { label: "360p", height: 360, format: "bestvideo[height<=360]+bestaudio/best[height<=360]" },
      ];

      for (const tier of tiers) {
        // Include this tier if any available height matches or is close
        const available = [...heights].some(h => h >= tier.height * 0.8 && h <= (tier.height === 2160 ? 4320 : tier.height * 1.3));
        if (available || tier.height <= Math.max(...heights)) {
          // Estimate file size from the best matching format
          let filesize = null;
          for (const f of data.formats) {
            if (f.height && f.height >= tier.height * 0.8 && f.height <= tier.height * 1.3) {
              filesize = f.filesize || f.filesize_approx || filesize;
            }
          }

          formats.push({
            type: "video",
            quality: tier.label,
            ext: "mp4",
            filesize,
            formatStr: tier.format,
          });
        }
      }

      // If no tiers matched, add a "Best" option
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
      // Absolute fallback
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
    console.error("Info error:", err.message);
    if (err.killed) {
      return res.status(504).json({ error: "Request timed out. Please try again." });
    }
    res.status(500).json({ error: "Couldn't fetch video info. The URL may be private, DRM-protected, or unsupported." });
  }
});

// GET /api/download — stream the video file through the server
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

  // Determine content type
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
    "--no-warnings",
    "--no-playlist",
    "--no-check-certificates",
    "-o", "-", // output to stdout
  ];

  // For mp3, extract audio and convert
  if (ext === "mp3") {
    args.push("--extract-audio", "--audio-format", "mp3");
    // When extracting audio with -o -, yt-dlp needs to post-process,
    // so we pipe through ffmpeg separately
    args.splice(args.indexOf("--extract-audio"), 2);
    args.splice(args.indexOf("--audio-format"), 2);
  }

  // For mp4 output, merge into mp4 container
  if (ext === "mp4") {
    args.push("--merge-output-format", "mp4");
  }

  args.push(url);

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

  let ytdlp;

  if (ext === "mp3") {
    // Pipe yt-dlp -> ffmpeg for mp3 conversion
    ytdlp = spawn("yt-dlp", [
      "-f", formatStr,
      "--no-warnings",
      "--no-playlist",
      "--no-check-certificates",
      "-o", "-",
      url,
    ]);

    const ffmpeg = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-vn",
      "-ab", "192k",
      "-f", "mp3",
      "pipe:1",
    ]);

    ytdlp.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res);

    ytdlp.stderr.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("ERROR")) console.error("yt-dlp error:", msg);
    });

    ffmpeg.stderr.on("data", () => {
      // ffmpeg outputs progress to stderr, ignore
    });

    const cleanup = (code) => {
      if (code && !res.headersSent) {
        res.status(500).json({ error: "Download failed." });
      }
    };

    ytdlp.on("error", () => cleanup(1));
    ffmpeg.on("error", () => cleanup(1));
    ffmpeg.on("close", cleanup);

    req.on("close", () => {
      ytdlp.kill();
      ffmpeg.kill();
    });
  } else {
    // Direct pipe for video/m4a
    ytdlp = spawn("yt-dlp", args);

    ytdlp.stdout.pipe(res);

    ytdlp.stderr.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("ERROR")) console.error("yt-dlp error:", msg);
    });

    ytdlp.on("error", () => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Download failed." });
      }
    });

    ytdlp.on("close", (code) => {
      if (code && !res.headersSent) {
        res.status(500).json({ error: "Download failed." });
      }
    });

    req.on("close", () => {
      ytdlp.kill();
    });
  }
});

app.listen(PORT, () => {
  console.log(`Zincad backend running on port ${PORT}`);
});
