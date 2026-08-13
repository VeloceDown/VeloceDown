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

app.get("/api/download/:token", (req, res) => {

  const item = files.get(req.params.token);


  if (
    !item ||
    !fs.existsSync(item.path)
  ) {

    return res.status(404).send(
      "File not found or expired."
    );

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
    "VeloceDown download quality:",
    quality,
    "kbps"
  );


  // ----------------------------------------------------------
  // Create temporary MP3 for this specific download.
  // ----------------------------------------------------------

  const downloadToken =
    crypto.randomBytes(16).toString("hex");


  const outputPath =
    path.join(
      outputDir,
      `${downloadToken}-${quality}.mp3`
    );


  const downloadFilename =
    `${item.baseName} - ${quality}kbps.mp3`;


  // ----------------------------------------------------------
  // Convert LOSSLESS master -> requested MP3 bitrate.
  // ----------------------------------------------------------

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

    outputPath

  ]);


  let errorOutput = "";


  ffmpeg.stderr.on("data", data => {

    errorOutput += data.toString();

  });


  ffmpeg.on("error", error => {

    console.error(
      "FFmpeg download conversion error:",
      error
    );

    fs.unlink(outputPath, () => {});

    if (!res.headersSent) {

      res.status(500).send(
        "Could not convert audio."
      );

    }

  });


  ffmpeg.on("close", code => {

    if (code !== 0) {

      console.error(
        "FFmpeg download conversion failed:",
        code
      );

      console.error(errorOutput);

      fs.unlink(outputPath, () => {});

      if (!res.headersSent) {

        res.status(500).send(
          "Could not convert audio."
        );

      }

      return;
    }


    // --------------------------------------------------------
    // Send the converted MP3 to the user.
    // --------------------------------------------------------

    res.download(
      outputPath,
      downloadFilename,
      error => {

        // Delete temporary MP3 after download.
        fs.unlink(outputPath, () => {});

        if (error) {

          console.error(
            "Download error:",
            error
          );

        }

      }
    );

  });

});


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
