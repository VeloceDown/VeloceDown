const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TMP = path.join(ROOT, "tmp");
const OUT = path.join(ROOT, "output");

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

app.use(express.json());
app.use(express.static(ROOT));

const upload = multer({
  dest: TMP,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

app.get("/api/health", (_, res) => {
  res.json({ ok: true, service: "VeloceDown" });
});

app.get("/api/info", async (req, res) => {
  const url = String(req.query.url || "");
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  // Placeholder until the platform adapters are implemented.
  res.json({
    title: "VeloceDown source",
    formats: [
      { id: "best", label: "Best available", ext: "MP4", requiresAd: true },
      { id: "720p", label: "720p", ext: "MP4", requiresAd: false },
      { id: "1080p", label: "1080p / Full HD", ext: "MP4", requiresAd: true },
      { id: "mp3", label: "MP3 audio", ext: "MP3", requiresAd: false }
    ]
  });
});

app.post("/api/extract-mp3", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video uploaded" });

  const id = crypto.randomBytes(12).toString("hex");
  const output = path.join(OUT, `${id}.mp3`);

  const ffmpeg = spawn(ffmpegPath, [
    "-y",
    "-i", req.file.path,
    "-vn",
    "-codec:a", "libmp3lame",
    "-q:a", "2",
    output
  ]);

  let stderr = "";
  ffmpeg.stderr.on("data", d => stderr += d.toString());

  ffmpeg.on("close", code => {
    fs.rm(req.file.path, { force: true }, () => {});

    if (code !== 0) {
      console.error(stderr);
      return res.status(500).json({ error: "FFmpeg conversion failed" });
    }

    res.json({ downloadUrl: `/api/file/${path.basename(output)}` });
  });
});

app.get("/api/file/:name", (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(OUT, name);

  if (!fs.existsSync(file)) return res.status(404).end();

  res.download(file, name, err => {
    // Temporary output cleanup.
    fs.rm(file, { force: true }, () => {});
    if (err) console.error("Download error:", err.message);
  });
});

app.listen(PORT, () => {
  console.log(`VeloceDown listening on port ${PORT}`);
});
