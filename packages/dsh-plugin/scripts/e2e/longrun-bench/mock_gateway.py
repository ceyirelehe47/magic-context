#!/usr/bin/env python3
"""Unix-socket budget-gateway integration prototype, MOCK UPSTREAM ONLY.

Supports only a loopback deterministic DSH mock, no HTTPS/vendor URLs, keys or
live mode. Prices below are synthetic unit-test rates, never an actual bill.
"""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import socketserver
import threading
import time

from budget import Ledger, StopRun


ROUTES = {"/r/main/w100000/v1/chat/completions": ("main", "/w100000/v1/chat/completions", 100000, 4096),
          "/r/hist/w200000/v1/chat/completions": ("historian", "/w200000/v1/chat/completions", 200000, 16384)}


def parse_usage(raw, content_type):
    if "text/event-stream" in content_type:
        events = []
        for line in raw.decode("utf-8").splitlines():
            if line.startswith("data:") and line[5:].strip() != "[DONE]":
                events.append(json.loads(line[5:]))
        if not any(line.strip() == "data: [DONE]" for line in raw.decode().splitlines()):
            raise ValueError("unterminated SSE")
        usages = [e["usage"] for e in events if e.get("usage") is not None]
        if not usages:
            raise ValueError("no SSE usage")
        usage = usages[-1]
    else:
        usage = json.loads(raw)["usage"]
    if not isinstance(usage, dict):
        raise ValueError("invalid usage object")
    return usage, usage["prompt_tokens"], usage["completion_tokens"]


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False


class Gateway:
    def __init__(self, socket_path, upstream_port, out, *, seconds=60, max_calls=50):
        if not 1 <= upstream_port <= 65535:
            raise ValueError("invalid local mock port")
        self.socket_path, self.upstream_port = str(socket_path), upstream_port
        self.out, self.deadline = Path(out), time.monotonic() + seconds
        self.out.mkdir(parents=True, exist_ok=True)
        self.ledger = Ledger(self.out / "ledger.jsonl", dollars="10", max_calls=max_calls, seconds=seconds)
        self.log_lock = threading.Lock()
        self.accepting = True
        try:
            self.server = Server(self.socket_path, self.handler())
            os.chmod(self.socket_path, 0o600)
        except Exception:
            self.ledger.close()
            raise

    def log(self, row):
        with self.log_lock, (self.out / "requests.jsonl").open("a") as f:
            f.write(json.dumps({"origin": "mock-gateway", "actual_cost_usd": None, **row}) + "\n")

    def handler(self):
        gateway = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *args):
                pass
            def fail(self, status, reason):
                raw = json.dumps({"error": reason}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except OSError:
                    pass
                self.close_connection = True
            def do_POST(self):
                route = ROUTES.get(self.path)
                if route is None:
                    self.fail(403, "unknown route denied before dispatch")
                    return
                # Clients never supply a usable vendor credential to this bridge.
                if self.headers.get("Authorization"):
                    self.fail(403, "credentials forbidden on mock gateway")
                    return
                try:
                    n = int(self.headers.get("Content-Length", "-1"))
                    if not 0 < n <= 4_000_000:
                        raise ValueError("request length")
                    self.connection.settimeout(10)
                    raw = self.rfile.read(n)
                    if len(raw) != n:
                        raise ValueError("truncated request")
                    body = json.loads(raw)
                    if body.get("model") != "mock-model":
                        raise ValueError("only mock-model is allowed")
                    cap = body.get("max_tokens", body.get("max_completion_tokens"))
                    if isinstance(cap, bool) or not isinstance(cap, int) or not 0 < cap <= route[3]:
                        raise ValueError("missing/excessive output cap")
                    session = self.headers.get("x-opencode-session", "")
                    arm = "plugin" if session.startswith("plugin-") else "baseline"
                    with gateway.ledger.lock:
                        if not gateway.accepting:
                            raise StopRun("gateway sealed for evidence collection")
                        rid = gateway.ledger.admit(arm=arm, kind=route[0], model="mock-model",
                            input_ceiling=route[2], output_ceiling=cap,
                            input_usd_per_million="1", output_usd_per_million="1")
                except (ValueError, StopRun, OSError) as exc:
                    self.fail(429 if isinstance(exc, StopRun) else 400, str(exc))
                    return
                start = time.monotonic()
                conn = None
                try:
                    remaining = gateway.deadline - start
                    if remaining <= 0:
                        raise TimeoutError("global deadline")
                    conn = http.client.HTTPConnection("127.0.0.1", gateway.upstream_port, timeout=min(30, remaining))
                    conn.request("POST", route[1], raw, {"content-type": "application/json", "x-opencode-session": session})
                    response = conn.getresponse()
                    # Buffering is deliberate for this integration prototype. A live
                    # gateway must stream without altering timing and retain raw events.
                    data = response.read(8_000_001)
                    if len(data) > 8_000_000 or time.monotonic() >= gateway.deadline:
                        raise TimeoutError("response size/deadline limit")
                    if response.status != 200:
                        raise ValueError(f"mock status {response.status}; usage uncertain")
                    content_type = response.getheader("Content-Type", "application/json")
                    usage, inp, out = parse_usage(data, content_type)
                    gateway.ledger.settle(rid, input_tokens=inp, output_tokens=out, provider_usage=usage)
                    gateway.log({"id": rid, "kind": route[0], "arm": arm, "status": 200,
                        "state": "settled", "input_tokens": inp, "output_tokens": out,
                        "usage": usage, "elapsed_s": time.monotonic()-start})
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(data)
                except Exception as exc:
                    rec = gateway.ledger.records.get(rid, {})
                    if rec.get("state") == "reserved":
                        try:
                            gateway.ledger.settle(rid, complete=False)
                        except StopRun:
                            pass
                    gateway.log({"id": rid, "kind": route[0], "arm": arm,
                                 "state": rec.get("state"), "error": type(exc).__name__})
                    self.fail(502, "mock upstream failure; new admissions stopped if usage uncertain")
                finally:
                    if conn:
                        conn.close()
                    self.close_connection = True
        return Handler

    def seal_and_collect(self, timeout=5):
        """Stop new admission atomically, then wait boundedly for journal/log drain."""
        with self.ledger.lock:
            self.accepting = False
        end = time.monotonic() + timeout
        while True:
            snapshot = self.ledger.snapshot()
            with self.log_lock:
                path = self.out / "requests.jsonl"
                rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
            if (snapshot['unsettled'] == 0 and len(rows) == snapshot['calls']) or time.monotonic() >= end:
                return snapshot, rows
            time.sleep(.02)

    def close(self):
        self.server.server_close()
        self.ledger.close()
        Path(self.socket_path).unlink(missing_ok=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--socket", type=Path, required=True)
    p.add_argument("--mock-port", type=int, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--seconds", type=int, default=60)
    args = p.parse_args()
    gateway = Gateway(args.socket, args.mock_port, args.out, seconds=args.seconds)
    timer = threading.Timer(args.seconds, gateway.server.shutdown)
    timer.start()
    try:
        print("MOCK ONLY Unix gateway listening", flush=True)
        gateway.server.serve_forever(poll_interval=0.1)
    finally:
        timer.cancel()
        gateway.close()


if __name__ == "__main__":
    main()
