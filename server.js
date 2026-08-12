const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(os.tmpdir(), "velocedown-uploads");
const outputDir = path.join(os.tmpdir(), "velocedown-output");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 1024 * 1024 * 1024 }
});

const files = new Map();

function safeFilename(name) {
  return (name || "VeloceDown audio")
    .replace(/\.[^/.]+$/, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "VeloceDown audio";
}

app.use(express.static(__dirname));

app.post("/api/extract-mp3", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video was uploaded." });

  const displayName = `${safeFilename(req.file.originalname)}.mp3`;
  const token = crypto.randomBytes(24).toString("hex");
  const outputPath = path.join(outputDir, `${token}.mp3`);

  execFile("ffmpeg", [
    "-y", "-i", req.file.path,
    "-vn", "-codec:a", "libmp3lame", "-q:a", "2",
    outputPath
  ], (error, stdout, stderr) => {
    fs.unlink(req.file.path, () => {});

    if (error) {
      console.error(stderr);
      return res.status(500).json({
        error: "Audio extraction failed. Make sure the video contains an audio track."
      });
    }

    files.set(token, {
      path: outputPath,
      filename: displayName,
      created: Date.now()
    });

    res.json({
      url: `/api/download/${token}`,
      filename: displayName
    });
  });
});

app.get("/api/download/:token", (req, res) => {
  const item = files.get(req.params.token);
  if (!item || !fs.existsSync(item.path)) {
    return res.status(404).send("File not found or expired.");
  }

  res.download(item.path, item.filename, (err) => {
    if (!err) {
      fs.unlink(item.path, () => {});
      files.delete(req.params.token);
    }
  });
});

// Remove abandoned output files after 30 minutes.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [token, item] of files) {
    if (item.created < cutoff) {
      fs.unlink(item.path, () => {});
      files.delete(token);
    }
  }
}, 5 * 60 * 1000);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.code === "LIMIT_FILE_SIZE" ? "File is too large." : err.message
    });
  }
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

app.listen(PORT, () => console.log(`VeloceDown listening on port ${PORT}`));

