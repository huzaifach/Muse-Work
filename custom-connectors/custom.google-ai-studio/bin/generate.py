#!/usr/bin/env python3
"""Generate text with Google Gemini via the vault-stored AI Studio key.

The key never touches disk: authd hands this script an hsurr:* surrogate and
Sentinel swaps it for the real key on the approved egress request.

Usage:
  generate.py --prompt-file queue/01-hero.txt [--model gemini-2.5-flash] [--out out.md]
  generate.py --prompt "Say OK"   # quick test
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import (  # noqa: E402
    url_with_surrogate_query_param,
    read_json_response,
    DynamicCredentialError,
)

CREDENTIAL = "custom.google-ai-studio"
HOSTS = ["generativelanguage.googleapis.com"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def generate(prompt: str, model: str, temperature: float, max_tokens: int) -> str:
    base = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    url = url_with_surrogate_query_param(
        base, CREDENTIAL, entry_name="access_token", allowed_hosts=HOSTS
    )
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
        },
    }
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=120) as resp:
            payload = read_json_response(resp)
    except urllib.error.HTTPError as exc:  # noqa: F821 - urllib.request exposes it
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Gemini API HTTP {exc.code}: {detail}") from exc

    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"no candidates in response: {json.dumps(payload)[:500]}")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    # Safety: strip markdown fences if the model added them anyway.
    if text.startswith("```"):
        lines = text.splitlines()
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


def main() -> int:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--prompt-file")
    src.add_argument("--prompt")
    ap.add_argument("--model", default="gemini-3.8-flash")
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--max-tokens", type=int, default=8192)
    ap.add_argument("--out")
    args = ap.parse_args()

    prompt = args.prompt
    if args.prompt_file:
        with open(args.prompt_file, encoding="utf-8") as fh:
            prompt = fh.read()

    try:
        text = generate(prompt, args.model, args.temperature, args.max_tokens)
    except (DynamicCredentialError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
