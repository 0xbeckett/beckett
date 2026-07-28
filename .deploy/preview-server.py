#!/usr/bin/env python3
"""Static preview server for web/public.

Adds the one thing `python -m http.server` doesn't do and Cloudflare Pages
does: extensionless routing, so the nav's /federation resolves to
federation.html. Used by the review preview unit, not by production.

usage: preview-server.py <root> <port>
"""

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        resolved = super().translate_path(path)
        if not os.path.exists(resolved) and os.path.isfile(resolved + ".html"):
            return resolved + ".html"
        return resolved


if __name__ == "__main__":
    root, port = sys.argv[1], int(sys.argv[2])
    os.chdir(root)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
