---
name: ffmpeg-render-trips-worker-alarm
description: heavy ffmpeg renders run silent for minutes and trip the worker no-activity alarm — spec heartbeats + fast preset + smoke test
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1b8ed512-a57c-4b01-84a9-013a3f03cdf7
---

Long/heavy ffmpeg renders (multi-minute 1080p, animated per-frame filter_complex, libass subtitle burns) run with ZERO stdout for many minutes, which looks like a hang and trips the worker's ~10min no-activity alarm every retry. On OPS-89 (beckett-yt pipeline) an 8.7-min 1080p render with animated `mod(t*...)` drawboxes + double subtitle burn chewed a core 15+ min, stalled, and never wrote a valid moov. It was NOT a hang or a download — pure render perf + silence.

**Why:** the failure reads as "worker crashed/stalled" and burns 3 retries, when the pipeline is actually correct. This is a sibling of [[worker-timeout-silent-wedge]].

**How to apply:** when filing/steering any ffmpeg/video/render ticket, require in the spec: (1) fast render — `-preset ultrafast`, sane res (720p for v1), cut per-frame animated filter expressions; (2) a heartbeat — `-progress pipe:1 -stats_period 10` or `-stats`, print progress every ~10-15s so the worker never looks dead; (3) a smoke mode that renders ~20-30s and produces a playable mp4 (ffprobe shows moov + duration) BEFORE the full render, and never mark done on a file with no moov. Cast render/systems work like this to pi @ high (real perf decisions).

**PROVEN FIX (OPS-91, landed Jul 7 2026):** the winning pattern is CHUNKING — split the timeline into short per-scene segments (~30-60s), render each as its OWN short ffmpeg call to segment_NNN.mp4 (identical codec/params across all), print a log line after each, then join with the concat demuxer `-c copy` (near-instant, no re-encode). No single ffmpeg call runs long or silent, so the watchdog never fires. Bonus durability: segments are resumable — if a worker dies mid-render, ffprobe-gate the valid segments (check moov, not just non-zero size) and re-render only the missing tail. This is what finally landed the first beckett-yt video after ~5 stall cycles. Default all future render tickets to chunked-segment + concat.
