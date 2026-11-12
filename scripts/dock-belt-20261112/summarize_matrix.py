"""把 result-before.json / result-after.json 汇总成 7 页 × 5 位置矩阵。

用法：
    python scripts/dock-belt-20261112/summarize_matrix.py
    python scripts/dock-belt-20261112/summarize_matrix.py --json   # 只出 JSON 摘要

口径：
- 单元格数值 = 该滚动位置下 `maxArea`（底栏与内容块相交面积，px²），越大越糟。
- `barGap` = 滚到底（ratio=100）时最后一块内容与底栏的间距 px。
"""

import argparse
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BASE = os.path.join(ROOT, "scripts", "dock-belt-20261112")
PAGES = ["记账", "进货", "库存", "报表", "更多", "商品管理", "设置"]
RATIOS = [0, 25, 50, 75, 100]


def load(name: str) -> dict:
    with open(os.path.join(BASE, name), encoding="utf-8") as fh:
        return json.load(fh)


def index(page_entries: list) -> dict:
    """按 ratio 索引；缺失的位置记为 None（不臆造 0）。"""
    out = {}
    for entry in page_entries:
        out[round(float(entry.get("ratio", -1)) * 100)] = entry
    return out


def fmt(value) -> str:
    if value is None:
        return "—"
    return f"{value:.1f}".rstrip("0").rstrip(".")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="输出 JSON 摘要")
    args = parser.parse_args()

    data = {"before": load("result-before.json"), "after": load("result-after.json")}
    summary = {}

    for page in PAGES:
        summary[page] = {}
        for phase in ("before", "after"):
            entries = data[phase]["pages"].get(page) or []
            if not entries:
                print(f"[warn] {phase} 缺少页面：{page}", file=sys.stderr)
            idx = index(entries)
            cells = {r: (idx[r].get("maxArea") if r in idx else None) for r in RATIOS}
            last = idx.get(100) or {}
            summary[page][phase] = {
                "cells": cells,
                "max": max([v for v in cells.values() if v is not None], default=None),
                "barGap": last.get("barGap"),
                "lastLeafGap": last.get("lastLeafGap"),
                "hasBar": last.get("hasBar"),
                "bar": last.get("bar"),
                "dock": last.get("dock"),
                "shellRows": last.get("shellRows"),
                "dockVsBar": last.get("dockVsBar"),
            }

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    # 表 1：改后逐位置 + 该页改前最大值（按要求格式）
    print("| 页面 | 0% | 25% | 50% | 75% | 100% | 改前最大 |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for page in PAGES:
        after = summary[page]["after"]
        cells = " | ".join(fmt(after["cells"][r]) for r in RATIOS)
        print(f"| {page} | {cells} | {fmt(summary[page]['before']['max'])} |")

    # 表 2：改前逐位置明细（同一口径，供回溯）
    print()
    print("| 页面 | 0% | 25% | 50% | 75% | 100% | 改后最大 |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for page in PAGES:
        before = summary[page]["before"]
        cells = " | ".join(fmt(before["cells"][r]) for r in RATIOS)
        print(f"| {page} | {cells} | {fmt(summary[page]['after']['max'])} |")

    # 表 3：滚到底时的间距
    print()
    print("| 页面 | 改前 barGap | 改后 barGap | 改前末行 gap | 改后末行 gap |")
    print("|---|---:|---:|---:|---:|")
    for page in PAGES:
        b, a = summary[page]["before"], summary[page]["after"]
        print(
            f"| {page} | {fmt(b['barGap'])} | {fmt(a['barGap'])} | "
            f"{fmt(b['lastLeafGap'])} | {fmt(a['lastLeafGap'])} |"
        )

    # 全局限值
    all_before = [summary[p]["before"]["max"] for p in PAGES if summary[p]["before"]["max"] is not None]
    all_after = [summary[p]["after"]["max"] for p in PAGES if summary[p]["after"]["max"] is not None]
    nonzero_after = sum(
        1 for p in PAGES for v in summary[p]["after"]["cells"].values() if v not in (None, 0)
    )
    nonzero_before = sum(
        1 for p in PAGES for v in summary[p]["before"]["cells"].values() if v not in (None, 0)
    )
    print()
    print(f"改前最大 = {fmt(max(all_before))} px²；改后最大 = {fmt(max(all_after))} px²")
    print(f"非 0 记录：改前 {nonzero_before} 条 / 改后 {nonzero_after} 条（共 {len(PAGES) * len(RATIOS)} 条）")

    rects = {
        (summary[p]["after"]["bar"]["w"], summary[p]["after"]["bar"]["h"])
        for p in PAGES
        if summary[p]["after"]["bar"]
    }
    shapes = ", ".join(f"{w}×{h}" for w, h in sorted(rects))
    print(f"改后底栏尺寸集合 = {shapes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())