---
name: video-pipeline-shorts
description: "standing directive — video pipeline contributors get pointed to the VID design doc first, keep renders short (1-1.5 min shorts)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b436bc2e-4167-468b-b301-5b851e335746
---

While ro (owner) is away, anyone who wants to work on the video pipeline should be pointed to the VID board design doc (from OPS-93, in `0xbeckett/beckett` repo) FIRST, and told to keep videos SHORT — 1 to 1.5 minutes, like shorts.

**Why:** short renders let people build on the pipeline and have fun without the heavy multi-minute ffmpeg renders that kept tripping the worker watchdog (see [[ffmpeg-render-trips-worker-alarm]]). Shorts sidestep the whole silent-render wedge saga.

**How to apply:** when staffing / advising video work, lead with the design doc and cap render length at ~1-1.5 min. Building on the pipeline shouldn't need a daemon restart — but if something genuinely needs one, @ ro to approve it ([[self-restart-on-owner-request]]).
