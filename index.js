const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { execFile } = require("child_process");
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
      url,
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });

    const data = JSON.parse(stdout);
    const platform = detectPlatform(url);

    // Build format list
    const formats = [];
    const seen = new Set();

    if (data.formats) {
      for (const f of data.formats) {
        // Video formats
        if (f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.height) {
          const label = f.height >= 2160 ? "4K" :
                        f.height >= 1080 ? "1080p" :
                        f.height >= 720 ? "720p" :
                        f.height >= 480 ? "480p" : "360p";
          const key = `video-${label}-${f.ext}`;
          if (!seen.has(key)) {
            seen.add(key);
            formats.push({
              type: "video",
              quality: label,
              ext: f.ext,
              filesize: f.filesize || f.filesize_approx || null,
              itag: f.format_id,
              height: f.height,
            });
          }
        }

        // Audio-only formats
        if (f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none")) {
          const ext = f.ext === "m4a" ? "m4a" : f.ext === "webm" ? "webm" : f.ext;
          const key = `audio-${ext}-${f.abr || ""}`;
          if (!seen.has(key) && (ext === "m4a" || ext === "webm" || ext === "mp3")) {
            seen.add(key);
            formats.push({
              type: "audio",
              quality: f.abr ? `${Math.round(f.abr)}kbps` : "Audio",
              ext,
              filesize: f.filesize || f.filesize_approx || null,
              itag: f.format_id,
              abr: f.abr || 0,
            });
          }
        }
      }
    }

    // Sort video by height descending, audio by bitrate descending
    formats.sort((a, b) => {
      if (a.type !== b.type) return a.type === "video" ? -1 : 1;
      if (a.type === "video") return (b.height || 0) - (a.height || 0);
      return (b.abr || 0) - (a.abr || 0);
    });

    // Deduplicate: keep best per quality label for video
    const deduped = [];
    const qualitySeen = new Set();
    for (const f of formats) {
      const dedupeKey = f.type === "video" ? `${f.type}-${f.quality}` : `${f.type}-${f.ext}`;
      if (!qualitySeen.has(dedupeKey)) {
        qualitySeen.add(dedupeKey);
        deduped.push(f);
      }
    }

    res.json({
      title: data.title || "Untitled",
      thumbnail: data.thumbnail || null,
      duration: formatDuration(data.duration),
      platform,
      formats: deduped,
    });
  } catch (err) {
    console.error("Info error:", err.message);
    if (err.killed) {
      return res.status(504).json({ error: "Request timed out. Please try again." });
    }
    res.status(500).json({ error: "Couldn't fetch video info. The URL may be private, DRM-protected, or unsupported." });
  }
});

// POST /api/download — get direct download URL
app.post("/api/download", async (req, res) => {
  const { url, itag, ext } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Please provide a valid URL." });
  }

  if (!itag) {
    return res.status(400).json({ error: "Please select a format." });
  }

  try {
    const { stdout } = await execFileAsync("yt-dlp", [
      "--get-url",
      "--no-warnings",
      "--no-playlist",
      "-f", String(itag),
      url,
    ], { timeout: 30000 });

    const directUrl = stdout.trim().split("\n")[0];

    if (!directUrl) {
      return res.status(404).json({ error: "No downloadable URL found for this format." });
    }

    // Get filename
    let filename = "download";
    try {
      const { stdout: nameOut } = await execFileAsync("yt-dlp", [
        "--get-filename",
        "--no-warnings",
        "--no-playlist",
        "-f", String(itag),
        "-o", `%(title)s.%(ext)s`,
        url,
      ], { timeout: 15000 });
      filename = nameOut.trim() || "download";
    } catch {
      // fallback filename
    }

    res.json({ directUrl, filename });
  } catch (err) {
    console.error("Download error:", err.message);
    if (err.killed) {
      return res.status(504).json({ error: "Request timed out. Please try again." });
    }
    res.status(500).json({ error: "Couldn't get download link. Please try a different format." });
  }
});

app.listen(PORT, () => {
  console.log(`Zincad backend running on port ${PORT}`);
});
