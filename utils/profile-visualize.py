#!/usr/bin/env python3
"""
OpenCode LLM 프로파일링 시각화 도구

사용법:
    python3 utils/profile-visualize.py <profile-*.jsonl>
    python3 utils/profile-visualize.py ~/.local/share/opencode/profiling/profile-20260414T120000.jsonl
"""

import json
import sys
import os

def load_profile(path: str) -> list[dict]:
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def print_token_chart(records: list[dict]):
    print("\n" + "=" * 70)
    print("  Token Usage per Iteration (input / output)")
    print("=" * 70)

    max_input = max((r["tokens"]["input"] for r in records), default=1)
    max_output = max((r["tokens"]["output"] for r in records), default=1)
    max_val = max(max_input, max_output, 1)
    bar_width = 40

    print(f"\n  {'Step':<6} {'Input':>8} {'Output':>8}  Chart")
    print(f"  {'─' * 6} {'─' * 8} {'─' * 8}  {'─' * (bar_width + 5)}")

    for i, r in enumerate(records):
        inp = r["tokens"]["input"]
        out = r["tokens"]["output"]
        inp_bar = int(inp / max_val * bar_width)
        out_bar = int(out / max_val * bar_width)
        print(f"  {i + 1:<6} {inp:>8,} {out:>8,}  {'█' * inp_bar}{'░' * out_bar}")

    print(f"\n  Total: input={sum(r['tokens']['input'] for r in records):,}  "
          f"output={sum(r['tokens']['output'] for r in records):,}")


def print_duration_chart(records: list[dict]):
    print("\n" + "=" * 70)
    print("  Duration Breakdown per Iteration (LLM / Tools)")
    print("=" * 70)

    durations = []
    for r in records:
        d = r.get("durationMs", {})
        if isinstance(d, dict):
            durations.append({"total": d.get("total", 0), "llm": d.get("llm", 0), "tools": d.get("tools", 0)})
        else:
            durations.append({"total": d, "llm": d, "tools": 0})

    max_val = max((d["total"] for d in durations), default=1)
    bar_width = 40

    print(f"\n  {'Step':<6} {'Total':>8} {'LLM':>8} {'Tools':>8}  Chart (▓=LLM ░=Tools)")
    print(f"  {'─' * 6} {'─' * 8} {'─' * 8} {'─' * 8}  {'─' * (bar_width + 5)}")

    for i, d in enumerate(durations):
        total = d["total"]
        llm = d["llm"]
        tools = d["tools"]
        llm_bar = int(llm / max_val * bar_width) if max_val > 0 else 0
        tools_bar = int(tools / max_val * bar_width) if max_val > 0 else 0
        print(f"  {i + 1:<6} {total:>7,}ms {llm:>7,}ms {tools:>7,}ms  {'▓' * llm_bar}{'░' * tools_bar}")

    total_all = sum(d["total"] for d in durations)
    llm_all = sum(d["llm"] for d in durations)
    tools_all = sum(d["tools"] for d in durations)
    print(f"\n  Total: {total_all:,}ms  LLM: {llm_all:,}ms ({llm_all * 100 // max(total_all, 1)}%)  "
          f"Tools: {tools_all:,}ms ({tools_all * 100 // max(total_all, 1)}%)")


def print_tool_table(records: list[dict]):
    print("\n" + "=" * 70)
    print("  Tool Calls per Iteration")
    print("=" * 70)

    step_w = 6
    tool_entries = []
    max_tools_len = 10

    for i, r in enumerate(records):
        called = r.get("calledTools", [])
        if called:
            tool_str = ", ".join(called)
        else:
            finish = r.get("finishReason", "")
            tool_str = f"(none — {finish})"
        tool_entries.append((i + 1, len(called), tool_str))
        max_tools_len = max(max_tools_len, len(tool_str))

    tools_w = min(max_tools_len, 55)
    print(f"\n  {'Step':<{step_w}} {'Count':>5}  {'Tools':<{tools_w}}")
    print(f"  {'─' * step_w} {'─' * 5}  {'─' * tools_w}")

    for step, count, tool_str in tool_entries:
        display = tool_str[:tools_w] + ("…" if len(tool_str) > tools_w else "")
        print(f"  {step:<{step_w}} {count:>5}  {display}")

    total_calls = sum(e[1] for e in tool_entries)
    print(f"\n  Total tool calls: {total_calls}")

    # tool frequency summary
    freq: dict[str, int] = {}
    for r in records:
        for t in r.get("calledTools", []):
            freq[t] = freq.get(t, 0) + 1
    if freq:
        print(f"\n  Tool frequency:")
        for tool, count in sorted(freq.items(), key=lambda x: -x[1]):
            print(f"    {tool:<20} {count:>4}x")


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <profile-*.jsonl>")
        print(f"\nExample:")
        print(f"  {sys.argv[0]} ~/.local/share/opencode/profiling/profile-20260414T120000.jsonl")
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"Error: file not found: {path}")
        sys.exit(1)

    records = load_profile(path)
    if not records:
        print("Error: no records found in file")
        sys.exit(1)

    print(f"\nLoaded {len(records)} iterations from {os.path.basename(path)}")
    print(f"Session: {records[0].get('sessionID', 'unknown')}")
    print(f"Model: {records[0].get('modelID', 'unknown')} ({records[0].get('provider', '')})")

    print_token_chart(records)
    print_duration_chart(records)
    print_tool_table(records)
    print()


if __name__ == "__main__":
    main()
