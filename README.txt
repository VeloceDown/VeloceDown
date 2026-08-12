VELOCEDOWN v2 — upload-to-MP3 foundation

This build adds a real phone/computer file picker and a backend API endpoint for
video -> MP3 extraction.

RUN LOCALLY
1. Install Node.js.
2. Install FFmpeg and make sure `ffmpeg` works from the command line.
3. In this folder run: npm install
4. Run: npm start
5. Open http://localhost:3000

IMPORTANT
- The browser alone cannot reliably perform server-side MP3 conversion for large
  videos. The server endpoint uses FFmpeg.
- The production backend still needs hosting, HTTPS, storage cleanup, signed
  download URLs, security controls and platform adapters.
- The URL downloader currently has a backend interface/stub. It does not bypass
  DRM, login requirements, paywalls or access controls.
- The ad placeholders are deliberate. A real ad network can be integrated after
  the product and policy review.
- No daily/monthly product download limit is implemented.
