#!/usr/bin/env python3
"""Local-only OpenAI-compatible gateway used by browser regression tests."""

from __future__ import annotations

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


TOKEN_RE = re.compile(r"__MY_SCHOLAR_(?:MATH|SPECIAL_TOKEN)_\d+__")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        payload = json.loads(self.rfile.read(length) or b"{}")
        messages = payload.get("messages") if isinstance(payload, dict) else []
        prompt = str(messages[-1].get("content", "")) if isinstance(messages, list) and messages and isinstance(messages[-1], dict) else ""
        if "只回复 OK" in prompt:
            content = "OK"
        elif "只返回 JSON" in prompt or "只输出合法 JSON" in prompt:
            content = '{"highlights":[]}'
        else:
            tokens = list(dict.fromkeys(TOKEN_RE.findall(prompt)))
            content = "本地测试译文。" + (" " + " ".join(tokens) if tokens else "")
        body = json.dumps({"choices": [{"message": {"role": "assistant", "content": content}}]}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9876)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Mock AI gateway running at http://127.0.0.1:{args.port}/v1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
