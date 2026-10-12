#!/usr/bin/env python3
"""List today's Claude Code sessions: user prompts (intent) + final assistant message (outcome).

Filters by message timestamps inside each transcript, not file mtime —
a file touched today may belong to an older session.
"""
import json
import sys
from datetime import date
from pathlib import Path

PROJECTS = Path.home() / ".claude" / "projects"
TODAY = date.today().isoformat() if len(sys.argv) < 2 else sys.argv[1]


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


for path in sorted(PROJECTS.glob("*/*.jsonl")):
    if "memory" in path.parts or "subagents" in path.parts:
        continue
    users, last_assistant, started_today = [], None, False
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = d.get("timestamp", "")
                if d.get("type") == "user":
                    t = text_of(d.get("message", {}).get("content")).strip()
                    # skip tool results, system reminders and skill-content injections
                    if t and not t.startswith("<") and "Base directory for this skill" not in t:
                        if not users and ts.startswith(TODAY):
                            started_today = True
                        users.append(t.replace("\n", " ")[:250])
                elif d.get("type") == "assistant":
                    t = text_of(d.get("message", {}).get("content")).strip()
                    if t:
                        last_assistant = t
    except OSError:
        continue
    if not started_today or not users:
        continue
    print(f"\n{'=' * 70}\nSESSION {path.stem}")
    for u in users[:8]:
        print(f"  USER: {u}")
    if last_assistant:
        print(f"  OUTCOME: {last_assistant[:1500]}")