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
const jobs = new Map();

function safeFilename(name) {
  return (name || "VeloceDown audio")
    .replace(/\.[^/.]+$/, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "VeloceDown audio";
}

app.use(express.static(__dirname));

app.post("/api/extract-mp3", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video was uploaded." });
  }

  const displayName = `${safeFilename(req.file.originalname)}.mp3`;

const allowedQualities = ["128", "192", "256", "320"];
const quality = allowedQualities.includes(req.body.quality)
  ? req.body.quality
  : "192";
  
  const token = crypto.randomBytes(24).toString("hex");
  const outputPath = path.join(outputDir, `${token}.mp3`);

  jobs.set(token, {
    progress: 0,
    status: "extracting",
    error: null
  });

  // Tell the browser that the upload has completed and extraction has begun.
  res.json({
    jobId: token
  });

  try {
    const duration = await new Promise((resolve, reject) => {
      execFile("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        req.file.path
      ], (error, stdout) => {
        if (error) return reject(error);
        resolve(parseFloat(stdout.trim()) || 0);
      });
    });

    const ffmpeg = require("child_process").spawn("ffmpeg", [
  "-y",
  "-i", req.file.path,
  "-vn",
  "-codec:a", "libmp3lame",
  "-b:a", `${quality}k`,
  "-minrate", `${quality}k`,
  "-maxrate", `${quality}k`,
  "-bufsize", `${Number(quality) * 2}k`,
  "-ar", "44100",
  "-ac", "2",
  "-progress", "pipe:1",
  "-nostats",
  outputPath
]);

    let progressBuffer = "";

    ffmpeg.stdout.on("data", chunk => {
      progressBuffer += chunk.toString();

      const lines = progressBuffer.split("\n");
      progressBuffer = lines.pop();

      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)/);

        if (match && duration > 0) {
          const seconds = Number(match[1]) / 1000000;
          const percent = Math.min(
            99,
            Math.max(0, Math.round((seconds / duration) * 100))
          );

          const job = jobs.get(token);

          if (job) {
            job.progress = percent;
            job.status = "extracting";
          }
        }
      }
    });

    ffmpeg.on("close", code => {
      fs.unlink(req.file.path, () => {});

      if (code !== 0) {
        console.error("FFmpeg exited with code:", code);

        jobs.set(token, {
          progress: 0,
          status: "error",
          error: "Audio extraction failed. Make sure the video contains an audio track."
        });

        fs.unlink(outputPath, () => {});
        return;
      }

      files.set(token, {
        path: outputPath,
        filename: displayName,
        created: Date.now()
      });

      jobs.set(token, {
        progress: 100,
        status: "complete",
        error: null,
        url: `/api/download/${token}`,
        filename: displayName
      });
    });

    ffmpeg.stderr.on("data", data => {
      // FFmpeg diagnostic output intentionally ignored.
    });

  } catch (error) {
    console.error(error);

    fs.unlink(req.file.path, () => {});
    fs.unlink(outputPath, () => {});

    jobs.set(token, {
      progress: 0,
      status: "error",
      error: "Could not process the video."
    });
  }
});

app.get("/api/download/:token", (req, res) => {
  const item = files.get(req.params.token);

  if (!item || !fs.existsSync(item.path)) {
    return res.status(404).send("File not found or expired.");
  }

  res.download(item.path, item.filename, (err) => {
    if (err) {
      console.error("Download error:", err);
    }
  });
});
app.get("/api/progress/:token", (req, res) => {
  const job = jobs.get(req.params.token);

  if (!job) {
    return res.status(404).json({
      error: "Job not found."
    });
  }

  res.json(job);

  if (job.status === "complete" || job.status === "error") {
    setTimeout(() => jobs.delete(req.params.token), 10 * 60 * 1000);
  }
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

