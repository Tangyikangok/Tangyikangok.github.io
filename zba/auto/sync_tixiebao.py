# -*- coding: utf-8 -*-
"""
体协宝官方接口适配器（浙BA 2026）

把 cloud.tixiebao.com 的三个官方接口直接转换成看板 data.json 的完整结构：
  1) 积分榜  GET event/app/bball/statistic/team/allList?name=win...
  2) 球员榜  GET event/app/bball/statistic/player/list?name=pts...
  3) 赛程    GET event/app/event/scheduleList?...

用法：
  - 被 update_data.py 调用：from sync_tixiebao import build
  - 独立验证：python auto/sync_tixiebao.py --token <JWT> [--out ../data.json]

凭证只从参数 / 环境变量读取，绝不写进代码或提交到仓库。
纯标准库，零依赖。
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "https://cloud.tixiebao.com/"
TYPE_ID = 216          # 浙BA 2026 专区
EVENT_ID = 1281        # 本届赛事 ID
BEIJING = timezone(timedelta(hours=8))
TOP_N_PLAYERS = 10     # 得分榜展示人数
PER_ROUND = 12         # 4 组 × 每组 3 场 = 每轮 12 场，用于推断轮次

# 组名规范（官方返回 "A组" 这类，做一次兜底映射）
ZONE_ORDER = {"A组": 0, "B组": 1, "C组": 2, "D组": 3}


def http_get(path, params, token, timeout=45):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    headers = {
        "Authorization": token,
        "Accept": "*/*",
        "Origin": "https://h5.tixiebao.com",
        "Referer": "https://h5.tixiebao.com/",
        "User-Agent": "Mozilla/5.0 miniProgram/wxc25e86ed5cea9257",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def common_params():
    return {"typeId": TYPE_ID, "eventId": EVENT_ID, "eventIds": EVENT_ID}


def fetch_standings(token):
    """积分榜 → groups。返回 (groups, team2zone)。"""
    p = common_params()
    p.update({"name": "win", "schedleSystem": "", "eventZoneName": ""})
    j = http_get("event/app/bball/statistic/team/allList", p, token)
    rows = j.get("data") or []
    if not rows:
        raise ValueError("积分榜返回空数据（token 可能已过期）")

    by_zone = {}
    team2zone = {}
    for r in rows:
        zone = str(r.get("eventZoneName") or "").strip()
        name = str(r.get("teamName") or "").strip()
        if not zone or not name:
            continue
        by_zone.setdefault(zone, []).append({
            "team": name,
            "w": int(r.get("win") or 0),
            "l": int(r.get("lose") or 0),
            "pts": int(r.get("point") or 0),
            "logo": r.get("logoAddress") or "",
        })
        team2zone[name] = zone

    groups = []
    for zone in sorted(by_zone.keys(), key=lambda z: ZONE_ORDER.get(z, 99)):
        teams = sorted(by_zone[zone],
                       key=lambda t: (-t["pts"], -t["w"], t["l"]))
        for i, t in enumerate(teams, 1):
            t["rank"] = i
        groups.append({"name": zone, "teams": teams})
    return groups, team2zone


def fetch_players(token):
    """球员得分榜 → players（前 N）。"""
    p = common_params()
    p.update({"name": "pts", "pageNum": 1, "pageSize": 50})
    j = http_get("event/app/bball/statistic/player/list", p, token)
    rows = j.get("rows") or []
    ranked = sorted(
        [r for r in rows if r.get("playerName")],
        key=lambda r: -(float(r.get("pts") or 0)),
    )[:TOP_N_PLAYERS]
    players = []
    for i, r in enumerate(ranked, 1):
        players.append({
            "rank": i,
            "name": str(r.get("playerName") or "").strip(),
            "team": str(r.get("teamName") or "").strip(),
            "pts": int(float(r.get("pts") or 0)),
        })
    return players


def _flatten(by_day, team2zone):
    """官方 list 字典 → 扁平的比赛列表（含内部排序字段）。

    isOver=1 / status='2' 视为已结束，比分有效，否则 hs/as 置 None。
    """
    flat = []
    for day, matches in (by_day or {}).items():
        if not isinstance(matches, list):
            continue
        for m in matches:
            gt = str(m.get("gameTime") or "").strip()   # "2026-09-04 19:30"
            date_part, _, time_part = gt.partition(" ")
            date_short = date_part[5:] if len(date_part) >= 10 else day[5:]
            time_short = time_part[:5] if time_part else "19:30"
            home = str(m.get("hostTeamName") or "").strip()
            away = str(m.get("guestTeamName") or "").strip()
            if not home or not away:
                continue
            over = (m.get("isOver") == 1 or str(m.get("status")) == "2")
            hs = int(m.get("hostScore") or 0) if over else None
            asc = int(m.get("guestScore") or 0) if over else None
            flat.append({
                "date": date_short,
                "time": time_short,
                "home": home,
                "away": away,
                "group": team2zone.get(home, ""),
                "hs": hs,
                "as": asc,
                # 统一用 MM-DD HH:MM 作排序键：必须与基线条目格式一致，
                # 否则 "2026-11-07" 与 "11-07" 混排会把新数据全推到末尾
                "_sort": "%s %s" % (date_short, time_short),
                "_id": m.get("id") or 0,
            })
    return flat


def _schedule_params(page_num=1, page_size=300):
    p = common_params()
    p.update({"pageNum": page_num, "pageSize": page_size,
              "params[eventType]": TYPE_ID})
    return p


def _fetch_full(token, retries=4):
    """全量拉一页（pageSize=300）。成功返回 by_day 字典，全败返回 None。

    官方赛程接口有个老毛病：返回前会逐场去内部服务查直播，
    只要有一场超时就整页抛 500。所以必须重试。
    """
    for i in range(retries):
        try:
            j = http_get("event/app/event/scheduleList",
                         _schedule_params(1, 300), token)
            if j.get("code") == 200 and j.get("list"):
                print("    [赛程] 全量拉取成功（第 %d 次尝试）" % (i + 1))
                return j
            print("    [赛程] 全量第 %d 次失败：%s"
                  % (i + 1, str(j.get("msg") or "")[:70]))
        except Exception as e:
            print("    [赛程] 全量第 %d 次异常：%s" % (i + 1, str(e)[:70]))
        if i < retries - 1:
            time.sleep(2 + i * 2)
    return None


def _fetch_paged(token, known_keys, retries=4, stop_after_known=8,
                 max_pages=200):
    """降级方案：pageSize=1 逐条拉（列表按日期倒序）。

    条数越少越不容易撞上「查直播超时」，实测单条成功率远高于批量。
    连续 stop_after_known 场都已在本地基线里（即比分都已有）就提前停，
    这样正常情况下只需拉几条，不会把 168 场全跑一遍。
    """
    found = {}
    known_streak = 0
    total = None
    pn = 1
    while pn <= max_pages and (total is None or pn <= total):
        j = None
        for a in range(retries):
            try:
                j = http_get("event/app/event/scheduleList",
                             _schedule_params(pn, 1), token)
                if j.get("code") == 200 and j.get("list"):
                    break
                j = None
            except Exception:
                j = None
            if a < retries - 1:
                time.sleep(1 + a)
        if not j:
            print("    [赛程] 逐条第 %d 条连续失败，停止逐条模式" % pn)
            break

        if total is None:
            total = int(j.get("count") or 0) or None
            print("    [赛程] 逐条模式：共 %s 场，按日期倒序拉取" % total)

        for day, matches in (j.get("list") or {}).items():
            for m in matches:
                gt = str(m.get("gameTime") or "").strip()
                dp, _, _ = gt.partition(" ")
                d_short = dp[5:] if len(dp) >= 10 else day[5:]
                key = (d_short,
                       str(m.get("hostTeamName") or "").strip(),
                       str(m.get("guestTeamName") or "").strip())
                found[key] = (day, m)
                if key in known_keys:
                    known_streak += 1
                else:
                    known_streak = 0

        if known_streak >= stop_after_known:
            print("    [赛程] 已连续 %d 场与本地基线重合，提前结束" % known_streak)
            break
        pn += 1

    if not found:
        return None
    print("    [赛程] 逐条模式共取到 %d 场" % len(found))
    grouped = {}
    for day, m in found.values():
        grouped.setdefault(day, []).append(m)
    return {"list": grouped}


def fetch_schedule(token, team2zone, base_schedule=None):
    """赛程 → (schedule, results, mode)。

    mode: 'full' 全量成功 / 'paged' 逐条降级 / 'base' 接口全挂沿用本地基线

    三级策略：
      1) pageSize=300 全量，重试 4 次
      2) 逐条 pageSize=1，每条重试 4 次，与本地基线重合即停
      3) 仍失败则原样返回 base_schedule（页面数据不回退、不丢历史）
    无论哪种模式，最终都以「本地基线为骨架」合并，只覆盖拉到的新比分，
    避免半途失败把已有 168 场赛程/比分冲掉。
    """
    base_schedule = list(base_schedule or [])
    base_keys = {(m.get("date"), m.get("home"), m.get("away")): m
                 for m in base_schedule}

    j = _fetch_full(token)
    mode = "full"
    if not j:
        print("    [赛程] 全量不可用，降级为逐条拉取")
        j = _fetch_paged(token, set(base_keys.keys()))
        mode = "paged"

    if not j:
        if base_schedule:
            print("    [赛程] 官方接口持续故障，沿用本地基线 %d 场" % len(base_schedule))
            flat = [dict(m, _sort="%s %s" % (m.get("date") or "", m.get("time") or ""),
                         _id=0) for m in base_schedule]
            return base_schedule, _results_from(flat), "base"
        raise ValueError("赛程接口持续失败，且本地无基线可沿用")

    fresh = _flatten(j.get("list"), team2zone)
    if not fresh:
        raise ValueError("赛程返回空数据")

    # --- 合并：基线做骨架，新数据只覆盖比分 ---
    # 注意：官方赛程会调整（改期/换对手），单纯按「日期+主客队」匹配会漏。
    # 所以按「比赛日」处理：
    #   · 新数据某天的场次数 >= 基线该天场次数 → 认为该日被完整取到，整日替换
    #   · 否则只按 (日期, 主队, 客队) 精确匹配补比分，多余的新场次丢弃并记录
    fresh_by_day = {}
    for m in fresh:
        fresh_by_day.setdefault(m["date"], []).append(m)
    base_by_day = {}
    for b in base_schedule:
        base_by_day.setdefault(b.get("date") or "", []).append(b)

    merged = []
    replaced_days = []

    for day, base_items in base_by_day.items():
        new_items = fresh_by_day.pop(day, None)
        if new_items and len(new_items) >= len(base_items):
            merged.extend(new_items)
            replaced_days.append(day)
            continue
        # 部分覆盖：逐场补比分
        idx = {(m["home"], m["away"]): m for m in (new_items or [])}
        for b in base_items:
            item = dict(b)
            n = idx.get((b.get("home"), b.get("away")))
            if n and n["hs"] is not None:
                item["hs"], item["as"] = n["hs"], n["as"]
            item["_sort"] = "%s %s" % (item.get("date") or "", item.get("time") or "")
            item["_id"] = 0
            merged.append(item)
        if new_items:
            missed = len(new_items) - sum(
                1 for m in new_items
                if any((m["home"], m["away"]) == (b.get("home"), b.get("away"))
                       for b in base_items))
            if missed > 0:
                print("    [合并] %s 有 %d 场官方对阵与基线不同且未取全，本次跳过"
                      % (day, missed))

    # 基线里完全没有的日期（新增比赛日）直接追加
    for day, items in fresh_by_day.items():
        merged.extend(items)
        print("    [合并] %s 为新增比赛日，追加 %d 场" % (day, len(items)))

    for day in replaced_days:
        print("    [合并] %s 整日按官方替换" % day)

    merged.sort(key=lambda x: (x.get("_sort") or "", x.get("_id") or 0))
    for i, m in enumerate(merged, 1):
        m["no"] = i
        m["round"] = "第%d轮" % ((i - 1) // PER_ROUND + 1)

    schedule = [{
        "no": m["no"], "round": m["round"], "date": m["date"],
        "time": m["time"], "home": m["home"], "away": m["away"],
        "group": m["group"], "hs": m["hs"], "as": m["as"],
    } for m in merged]

    return schedule, _results_from(merged), mode


def _results_from(flat):
    """已结束比赛 → results（按时间倒序）。"""
    done = [m for m in flat if m.get("hs") is not None]
    done.sort(key=lambda x: (x.get("_sort") or "", x.get("_id") or 0), reverse=True)
    return [{
        "date": m["date"], "home": m["home"], "away": m["away"],
        "hs": m["hs"], "as": m["as"], "group": m.get("group") or "",
    } for m in done]


def build(token, source_label="浙江省篮协大数据平台（官方接口实时同步）",
          base=None):
    """拉取三个接口，返回完整 data.json 结构。

    base：现有 data.json，用作赛程/球员榜的兜底基线。
      - 积分榜失败 → 直接抛异常，由上层降级（积分榜是核心，不能瞎猜）
      - 球员榜失败 → 沿用 base 的球员榜
      - 赛程失败   → 沿用 base 的赛程与赛果，页面不回退、不丢历史

    返回结构里 meta 额外带 syncMode，便于排查本次走的哪条路径。
    """
    if not token:
        raise ValueError("缺少 token")
    base = base or {}

    groups, team2zone = fetch_standings(token)

    try:
        players = fetch_players(token)
    except Exception as e:
        players = base.get("players") or []
        print("[体协宝] 球员榜失败，沿用本地基线 %d 人：%s" % (len(players), e))

    schedule, results, mode = fetch_schedule(
        token, team2zone, base.get("schedule"))

    played = sum(1 for m in schedule if m["hs"] is not None)
    return {
        "meta": {
            "title": "浙BA 2026 城市篮球争霸赛",
            "subtitle": "2026 浙江省城市篮球联赛 · 省级争霸赛",
            "season": "第二届",
            "updatedAt": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
            "source": source_label,
            "note": "小组赛 4 组 × 7 队主客场双循环，共 14 轮 168 场；各组前四晋级 16 强",
            "syncMode": mode,
        },
        "groups": groups,
        "players": players,
        "schedule": schedule,
        "results": results,
    }


def main():
    ap = argparse.ArgumentParser(description="体协宝官方接口同步（独立验证用）")
    ap.add_argument("--token", default=os.environ.get("TIXIEBAO_TOKEN", "").strip())
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data.json"))
    ap.add_argument("--base", default="",
                    help="现有 data.json，作为赛程/球员榜的兜底基线（建议传）")
    args = ap.parse_args()
    if not args.token:
        sys.exit("请用 --token 或环境变量 TIXIEBAO_TOKEN 提供凭证")

    base = None
    bpath = args.base or args.out
    if os.path.exists(bpath):
        try:
            with open(bpath, encoding="utf-8") as f:
                base = json.load(f)
            print("[体协宝] 已加载本地基线：%s（%d 场赛程）"
                  % (bpath, len(base.get("schedule") or [])))
        except Exception as e:
            print("[体协宝] 本地基线读取失败，忽略：%s" % e)

    data = build(args.token, base=base)
    out = Path(args.out)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    b = data
    print("[体协宝] 同步成功（模式：%s）" % b["meta"].get("syncMode"))
    print("  分组 %d 个，共 %d 队" % (
        len(b["groups"]), sum(len(g["teams"]) for g in b["groups"])))
    print("  球员榜 %d 人 | 得分王 %s %s分" % (
        len(b["players"]), b["players"][0]["name"], b["players"][0]["pts"]))
    print("  赛程 %d 场（已结束 %d / 未开赛 %d）" % (
        len(b["schedule"]),
        sum(1 for m in b["schedule"] if m["hs"] is not None),
        sum(1 for m in b["schedule"] if m["hs"] is None)))
    print("  赛果 %d 条 | 最新 %s" % (len(b["results"]), b["results"][0]["date"] if b["results"] else "-"))
    print("  已写入 %s" % out)


if __name__ == "__main__":
    main()
