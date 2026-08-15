const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

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
const downloadJobs = new Map();
const videoJobs = new Map();

function safeFilename(name) {
  return (name || "VeloceDown audio")
    .replace(/\.[^/.]+$/, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "VeloceDown audio";
}

const allowedQualities = ["128", "192", "256", "320"];

app.use(express.static(__dirname));


// ============================================================
// EXTRACT AUDIO
// Creates ONE lossless FLAC master.
// Bitrate is NOT selected here.
// ============================================================

app.post("/api/extract-mp3", upload.single("video"), async (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      error: "No video was uploaded."
    });
  }

  const baseName = safeFilename(req.file.originalname);

  const token = crypto.randomBytes(24).toString("hex");

  const masterPath = path.join(
    outputDir,
    `${token}.flac`
  );

  jobs.set(token, {
    progress: 0,
    status: "extracting",
    error: null
  });

  // Tell browser upload is finished and extraction has started.
  res.json({
    jobId: token
  });

  try {

    // --------------------------------------------------------
    // Find video duration for progress reporting.
    // --------------------------------------------------------

    const duration = await new Promise((resolve, reject) => {

      execFile(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          req.file.path
        ],
        (error, stdout) => {

          if (error) {
            return reject(error);
          }

          resolve(
            parseFloat(stdout.trim()) || 0
          );
        }
      );

    });


    // --------------------------------------------------------
    // Extract audio to LOSSLESS FLAC master.
    //
    // This is deliberately NOT MP3.
    // The final MP3 bitrate is chosen later at download time.
    // --------------------------------------------------------

    const ffmpeg = spawn("ffmpeg", [
      "-y",

      "-i",
      req.file.path,

      "-vn",

      "-map",
      "0:a:0",

      "-c:a",
      "flac",

      "-ar",
      "44100",

      "-ac",
      "2",

      "-progress",
      "pipe:1",

      "-nostats",

      masterPath
    ]);


    let progressBuffer = "";


    ffmpeg.stdout.on("data", chunk => {

      progressBuffer += chunk.toString();

      const lines = progressBuffer.split("\n");

      progressBuffer = lines.pop();


      for (const line of lines) {

        const match = line.match(
          /^out_time_ms=(\d+)/
        );

        if (
          match &&
          duration > 0
        ) {

          const seconds =
            Number(match[1]) / 1000000;

          const percent =
            Math.min(
              99,
              Math.max(
                0,
                Math.round(
                  (seconds / duration) * 100
                )
              )
            );

          const job = jobs.get(token);

          if (job) {

            job.progress = percent;
            job.status = "extracting";

          }

        }

      }

    });


    ffmpeg.stderr.on("data", data => {

      // FFmpeg diagnostic output intentionally ignored.

    });


    ffmpeg.on("close", code => {

      // Original uploaded video is no longer needed.
      fs.unlink(req.file.path, () => {});


      if (code !== 0) {

        console.error(
          "FFmpeg extraction exited with code:",
          code
        );

        jobs.set(token, {
          progress: 0,
          status: "error",
          error:
            "Audio extraction failed. Make sure the video contains an audio track."
        });

        fs.unlink(masterPath, () => {});

        return;
      }


      // ------------------------------------------------------
      // Store the LOSSLESS master.
      // ------------------------------------------------------

      files.set(token, {

        path: masterPath,

        filename: `${baseName}.mp3`,

        baseName: baseName,

        created: Date.now()

      });


      jobs.set(token, {

        progress: 100,

        status: "complete",

        error: null,

        url: `/api/download/${token}`,

        filename: `${baseName}.mp3`

      });

    });


  } catch (error) {

    console.error(error);

    fs.unlink(req.file.path, () => {});
    fs.unlink(masterPath, () => {});

    jobs.set(token, {

      progress: 0,

      status: "error",

      error: "Could not process the video."

    });

  }

});


// ============================================================
// DOWNLOAD
//
// The bitrate is selected HERE.
// The FLAC master is converted to the requested MP3 quality.
// ============================================================

app.get("/api/download/:token", async (req, res) => {

  const item = files.get(req.params.token);

  if (
    !item ||
    !fs.existsSync(item.path)
  ) {
    return res.status(404).json({
      error: "File not found or expired."
    });
  }

  // ----------------------------------------------------------
  // Read requested bitrate.
  // ----------------------------------------------------------

  const requestedQuality =
    String(req.query.quality || "192");

  const quality =
    allowedQualities.includes(requestedQuality)
      ? requestedQuality
      : "192";

  console.log(
    "VeloceDown download conversion requested:",
    quality,
    "kbps"
  );

  // ----------------------------------------------------------
  // Create conversion job.
  // ----------------------------------------------------------

  const downloadJobId =
    crypto.randomBytes(24).toString("hex");

  const downloadToken =
    crypto.randomBytes(16).toString("hex");

  const outputPath =
    path.join(
      outputDir,
      `${downloadToken}-${quality}.mp3`
    );

  const downloadFilename =
    `${item.baseName} - ${quality}kbps.mp3`;

  downloadJobs.set(downloadJobId, {
    progress: 0,
    status: "converting",
    error: null,
    outputPath: outputPath,
    filename: downloadFilename
  });

  // ----------------------------------------------------------
  // Find master duration for progress reporting.
  // ----------------------------------------------------------

  try {

    const duration = await new Promise((resolve, reject) => {

      execFile("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        item.path
      ], (error, stdout) => {

        if (error) {
          return reject(error);
        }

        resolve(
          parseFloat(stdout.trim()) || 0
        );

      });

    });

    // --------------------------------------------------------
    // Start FFmpeg conversion.
    // --------------------------------------------------------

    const ffmpeg = spawn("ffmpeg", [

      "-y",

      "-i",
      item.path,

      "-vn",

      "-c:a",
      "libmp3lame",

      "-b:a",
      `${quality}k`,

      "-ar",
      "44100",

      "-ac",
      "2",

      "-progress",
      "pipe:1",

      "-nostats",

      outputPath

    ]);

    let progressBuffer = "";
    let errorOutput = "";

    ffmpeg.stdout.on("data", chunk => {

      progressBuffer += chunk.toString();

      const lines =
        progressBuffer.split("\n");

      progressBuffer = lines.pop();

      for (const line of lines) {

        const match =
          line.match(/^out_time_ms=(\d+)/);

        if (
          match &&
          duration > 0
        ) {

          const seconds =
            Number(match[1]) / 1000000;

          const percent =
            Math.min(
              99,
              Math.max(
                0,
                Math.round(
                  (seconds / duration) * 100
                )
              )
            );

          const job =
            downloadJobs.get(downloadJobId);

          if (job) {
            job.progress = percent;
          }

        }

      }

    });

    ffmpeg.stderr.on("data", data => {

      errorOutput +=
        data.toString();

    });

    ffmpeg.on("error", error => {

      console.error(
        "FFmpeg download conversion error:",
        error
      );

      fs.unlink(outputPath, () => {});

      downloadJobs.set(
        downloadJobId,
        {
          progress: 0,
          status: "error",
          error: "Could not convert audio."
        }
      );

    });

    ffmpeg.on("close", code => {

      const job =
        downloadJobs.get(downloadJobId);

      if (code !== 0) {

        console.error(
          "FFmpeg download conversion failed:",
          code
        );

        console.error(errorOutput);

        fs.unlink(outputPath, () => {});

        if (job) {
          job.progress = 0;
          job.status = "error";
          job.error = "Could not convert audio.";
        }

        return;
      }

      if (job) {

        job.progress = 100;
        job.status = "complete";
        job.error = null;
        job.url =
          `/api/download-file/${downloadJobId}`;

      }

    });

    // --------------------------------------------------------
    // Tell browser that conversion has started.
    // --------------------------------------------------------

    res.json({
      jobId: downloadJobId,
      quality: quality
    });

  } catch (error) {

    console.error(
      "Could not start download conversion:",
      error
    );

    downloadJobs.delete(downloadJobId);

    fs.unlink(outputPath, () => {});

    res.status(500).json({
      error: "Could not start audio conversion."
    });

  }

});


// ============================================================
// DOWNLOAD CONVERSION PROGRESS
// ============================================================

app.get("/api/download-progress/:jobId", (req, res) => {

  const job =
    downloadJobs.get(req.params.jobId);

  if (!job) {

    return res.status(404).json({
      error: "Download job not found."
    });

  }

  res.json({
    progress: job.progress,
    status: job.status,
    error: job.error,
    url: job.url || null
  });

});


// ============================================================
// SEND COMPLETED DOWNLOAD
// ============================================================

app.get("/api/download-file/:jobId", (req, res) => {

  const job =
    downloadJobs.get(req.params.jobId);

  if (
    !job ||
    job.status !== "complete" ||
    !job.outputPath ||
    !fs.existsSync(job.outputPath)
  ) {

    return res.status(404).send(
      "Download file not found or expired."
    );

  }

  res.download(
    job.outputPath,
    job.filename,
    error => {

      fs.unlink(
        job.outputPath,
        () => {}
      );

      downloadJobs.delete(
        req.params.jobId
      );

      if (error) {

        console.error(
          "Download error:",
          error
        );

      }

    }
  );

});

// ============================================================
// VIDEO URL INFO
//
// Inspect a supported video URL and return available formats.
// Does NOT download the video.
// ============================================================

app.get("/api/info", async (req, res) => {

  const url =
    String(req.query.url || "").trim();

  if (!/^https?:\/\//i.test(url)) {

    return res.status(400).json({
      error: "Please enter a valid video URL."
    });

  }

  try {

    const { exec } =
      require("youtube-dl-exec");

    const info =
      await exec(url, {
        dumpSingleJson: true,
        noWarnings: true,
        skipDownload: true,
        noCheckCertificates: true
      });

    const formats =
      (info.formats || [])
        .filter(format =>
          format.vcodec !== "none" ||
          format.acodec !== "none"
        )
        .map(format => ({

          id: format.format_id,

          label:
            format.format_note ||
            format.resolution ||
            format.format_id,

          ext:
            format.ext || "",

          resolution:
            format.resolution || "",

          filesize:
            format.filesize || null,

          vcodec:
            format.vcodec || "none",

          acodec:
            format.acodec || "none"

        }));

    res.json({
      title:
        info.title || "VeloceDown video",

      duration:
        info.duration || 0,

      formats
    });

  } catch (error) {

    console.error(
      "Video information error:",
      error
    );

    res.status(500).json({
      error:
        "Could not read video information from this URL."
    });

  }

});

// ============================================================
// VIDEO DOWNLOAD
//
// Downloads the best available video/audio combination,
// merges it into MP4, and reports progress.
// ============================================================

app.get("/api/video-download", async (req, res) => {

  const url =
    String(req.query.url || "").trim();

  if (!/^https?:\/\//i.test(url)) {

    return res.status(400).json({
      error: "Please enter a valid video URL."
    });

  }

  const videoJobId =
    crypto.randomBytes(24).toString("hex");

  const videoToken =
    crypto.randomBytes(16).toString("hex");

  const outputPath =
    path.join(
      outputDir,
      `${videoToken}.mp4`
    );

  videoJobs.set(videoJobId, {
    progress: 0,
    status: "downloading",
    error: null,
    outputPath: outputPath,
    filename: "VeloceDown Video.mp4"
  });

  res.json({
    jobId: videoJobId
  });

  try {

    const youtubedl =
      require("youtube-dl-exec");

    const quality = req.query.quality === "hd"
  ? 720
  : 360;

const formatSelector =
  `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;

const subprocess =
  youtubedl.exec(
    url,
    {
      format: formatSelector,

      mergeOutputFormat: "mp4",

      output: outputPath,

      noWarnings: true,

      noCheckCertificates: true,

      newline: true,

      progress: true
    }
  );

    let outputBuffer = "";

    subprocess.stdout.on("data", data => {

      outputBuffer +=
        data.toString();

      const lines =
        outputBuffer.split("\n");

      outputBuffer = lines.pop();

      for (const line of lines) {

        const match =
          line.match(/(\d+(?:\.\d+)?)%/);

        if (!match) {
          continue;
        }

        const percent =
          Math.min(
            99,
            Math.max(
              0,
              Math.round(
                Number(match[1])
              )
            )
          );

        const job =
          videoJobs.get(videoJobId);

        if (job) {
          job.progress = percent;
        }

      }

    });

    subprocess.stderr.on("data", data => {

      // yt-dlp may write progress and diagnostics
      // to stderr depending on the source.

      const text =
        data.toString();

      const matches =
        text.match(
          /(\d+(?:\.\d+)?)%/g
        );

      if (!matches || !matches.length) {
        return;
      }

      const lastMatch =
        matches[matches.length - 1];

      const percent =
        Math.min(
          99,
          Math.max(
            0,
            Math.round(
              parseFloat(
                lastMatch
              )
            )
          )
        );

      const job =
        videoJobs.get(videoJobId);

      if (job) {
        job.progress = percent;
      }

    });

    subprocess.on("error", error => {

      console.error(
        "Video download error:",
        error
      );

      fs.unlink(
        outputPath,
        () => {}
      );

      const job =
        videoJobs.get(videoJobId);

      if (job) {

        job.progress = 0;
        job.status = "error";
        job.error =
          "Could not download the video.";

      }

    });

    subprocess.on("close", code => {

      const job =
        videoJobs.get(videoJobId);

      if (!job) {
        return;
      }

      if (
        code !== 0 ||
        !fs.existsSync(outputPath)
      ) {

        console.error(
          "yt-dlp video download failed:",
          code
        );

        fs.unlink(
          outputPath,
          () => {}
        );

        job.progress = 0;
        job.status = "error";
        job.error =
          "Could not download the video.";

        return;
      }

      job.progress = 100;
      job.status = "complete";
      job.error = null;
      job.url =
        `/api/video-download-file/${videoJobId}`;

    });

  } catch (error) {

    console.error(
      "Could not start video download:",
      error
    );

    fs.unlink(
      outputPath,
      () => {}
    );

    const job =
      videoJobs.get(videoJobId);

    if (job) {

      job.progress = 0;
      job.status = "error";
      job.error =
        "Could not start video download.";

    }

  }

});


// ============================================================
// VIDEO DOWNLOAD PROGRESS
// ============================================================

app.get(
  "/api/video-download-progress/:jobId",
  (req, res) => {

    const job =
      videoJobs.get(req.params.jobId);

    if (!job) {

      return res.status(404).json({
        error: "Video download job not found."
      });

    }

    res.json({
      progress: job.progress,
      status: job.status,
      error: job.error,
      url: job.url || null
    });

  }
);


// ============================================================
// SEND COMPLETED VIDEO
// ============================================================

app.get(
  "/api/video-download-file/:jobId",
  (req, res) => {

    const job =
      videoJobs.get(req.params.jobId);

    if (
      !job ||
      job.status !== "complete" ||
      !job.outputPath ||
      !fs.existsSync(job.outputPath)
    ) {

      return res.status(404).send(
        "Video file not found or expired."
      );

    }

    res.download(
      job.outputPath,
      job.filename,
      error => {

        fs.unlink(
          job.outputPath,
          () => {}
        );

        videoJobs.delete(
          req.params.jobId
        );

        if (error) {

          console.error(
            "Video download error:",
            error
          );

        }

      }
    );

  }
);

// ============================================================
// PROGRESS
// ============================================================

app.get("/api/progress/:token", (req, res) => {

  const job =
    jobs.get(req.params.token);


  if (!job) {

    return res.status(404).json({
      error: "Job not found."
    });

  }


  res.json(job);


  if (
    job.status === "complete" ||
    job.status === "error"
  ) {

    setTimeout(() => {

      jobs.delete(req.params.token);

    }, 10 * 60 * 1000);

  }

});


// ============================================================
// CLEANUP
//
// Remove old FLAC master files after 30 minutes.
// ============================================================

setInterval(() => {

  const cutoff =
    Date.now() -
    30 * 60 * 1000;


  for (const [token, item] of files) {

    if (item.created < cutoff) {

      fs.unlink(item.path, () => {});

      files.delete(token);

    }

  }

}, 5 * 60 * 1000);


// ============================================================
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {

  if (err instanceof multer.MulterError) {

    return res.status(400).json({

      error:
        err.code === "LIMIT_FILE_SIZE"
          ? "File is too large."
          : err.message

    });

  }


  console.error(err);

  res.status(500).json({
    error: "Server error."
  });

});


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => console.log(
    `VeloceDown listening on port ${PORT}`
  )
);
