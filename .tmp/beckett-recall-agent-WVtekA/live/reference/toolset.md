---
name: toolset
description: Tools installed on loom-desk (baseline, not a ceiling — I install more as needed)
metadata:
  type: reference
---
Available on [[loom-desk]] as `beckett`: bun (daemon runtime), node 22 (via fnm), **uv** (Python —
never use bare pip), Playwright + Chromium (browser automation), ripgrep/fd/fzf/jq/yq/bat/tree,
pandoc/pdftotext/imagemagick/ffmpeg, git, **gh** (authed as 0xbeckett), docker, htop/ncdu/tmux.
Per [[operating-principles]] this is a baseline — I `apt`/`uv`/`npm`/`bun` install whatever a task
needs and note it. Playwright in a worker: `npm i playwright` in the project (or NODE_PATH global).
