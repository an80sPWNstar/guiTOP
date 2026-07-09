#!/usr/bin/env python3
"""Delegate a coding task to the local Qwen3.6 model (thinking OFF).

Usage:
  python3 ask_local.py "prompt text"            # prompt as arg
  echo "prompt" | python3 ask_local.py          # prompt on stdin
  python3 ask_local.py -f prompt.txt            # prompt from file
Options:
  --max N      max tokens (default 1200)
  --temp F     temperature (default 0.1)
  --think      enable thinking (default off)
  --raw        print raw content (default: extract first code block if present)
"""
import sys, json, time, urllib.request, re, argparse

URL = "http://127.0.0.1:8080/v1/chat/completions"

def ask(prompt, max_tokens=1200, temperature=0.1, think=False):
    body = {"model":"local","messages":[{"role":"user","content":prompt}],
            "max_tokens":max_tokens,"temperature":temperature,"stream":False,
            "chat_template_kwargs":{"enable_thinking":think}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type":"application/json"})
    t0=time.time()
    with urllib.request.urlopen(req, timeout=600) as r: out=json.load(r)
    dt=time.time()-t0
    m=out["choices"][0]["message"]; u=out["usage"]
    fr=out["choices"][0].get("finish_reason")
    return (m.get("content") or ""), dt, u.get("completion_tokens",0), fr

def extract_code(text):
    blocks=re.findall(r"```(?:[a-zA-Z]+)?\s*(.*?)```", text, re.DOTALL)
    return blocks[0].strip() if blocks else text.strip()

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?")
    ap.add_argument("-f","--file")
    ap.add_argument("--max", type=int, default=1200)
    ap.add_argument("--temp", type=float, default=0.1)
    ap.add_argument("--think", action="store_true")
    ap.add_argument("--raw", action="store_true")
    a=ap.parse_args()
    if a.file:
        prompt=open(a.file).read()
    elif a.prompt:
        prompt=a.prompt
    else:
        prompt=sys.stdin.read()
    content,dt,ct,fr=ask(prompt, a.max, a.temp, a.think)
    sys.stderr.write(f"[local-llm] {dt:.1f}s | {ct} tok | {ct/dt if dt else 0:.1f} tok/s | finish={fr}\n")
    print(content if a.raw else extract_code(content))
