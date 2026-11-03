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


def http_get(path, params, token):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    headers = {
        "Authorization": token,
        "Accept": "*/*",
        "Origin": "https://h5.tixiebao.com",
        "Referer": "https://h5.tixiebao.com/",
        "User-Agent": "Mozilla/5.0 miniProgram/wxc25e86ed5cea9257",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=25) as r:
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


def fetch_schedule(token, team2zone):
    """赛程 → schedule + results。

    官方 list 是 { 'YYYY-MM-DD': [比赛...] } 的字典；
    isOver=1 / status='2' 视为已结束，比分有效，否则 hs/as 置 None。
    """
    p = common_params()
    p.update({"pageNum": 1, "pageSize": 300, "params[eventType]": TYPE_ID})
    j = http_get("event/app/event/scheduleList", p, token)
    by_day = j.get("list") or {}
    if not by_day:
        raise ValueError("赛程返回空数据")

    flat = []
    for day, matches in by_day.items():
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
                "_sort": gt or day,
                "_id": m.get("id") or 0,
            })

    # 按开赛时间排序，生成连续序号与轮次
    flat.sort(key=lambda x: (x["_sort"], x["_id"]))
    for i, m in enumerate(flat, 1):
        m["no"] = i
        m["round"] = "第%d轮" % ((i - 1) // PER_ROUND + 1)

    # 精简：去掉内部排序字段，保持与页面字段一致
    schedule = [{
        "no": m["no"], "round": m["round"], "date": m["date"],
        "time": m["time"], "home": m["home"], "away": m["away"],
        "group": m["group"], "hs": m["hs"], "as": m["as"],
    } for m in flat]

    # 赛果：已结束的比赛，按日期倒序
    done = [m for m in flat if m["hs"] is not None]
    done.sort(key=lambda x: (x["_sort"], x["_id"]), reverse=True)
    results = [{
        "date": m["date"], "home": m["home"], "away": m["away"],
        "hs": m["hs"], "as": m["as"], "group": m["group"],
    } for m in done]

    return schedule, results


def build(token, source_label="浙江省篮协大数据平台（官方接口实时同步）"):
    """拉取三个接口，返回完整 data.json 结构。任一步失败即抛异常由上层降级。"""
    if not token:
        raise ValueError("缺少 token")
    groups, team2zone = fetch_standings(token)
    players = fetch_players(token)
    schedule, results = fetch_schedule(token, team2zone)

    played = sum(1 for m in schedule if m["hs"] is not None)
    return {
        "meta": {
            "title": "浙BA 2026 城市篮球争霸赛",
            "subtitle": "2026 浙江省城市篮球联赛 · 省级争霸赛",
            "season": "第二届",
            "updatedAt": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
            "source": source_label,
            "note": "小组赛 4 组 × 7 队主客场双循环，共 14 轮 168 场；各组前四晋级 16 强",
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
    args = ap.parse_args()
    if not args.token:
        sys.exit("请用 --token 或环境变量 TIXIEBAO_TOKEN 提供凭证")
    data = build(args.token)
    out = Path(args.out)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    b = data
    print("[体协宝] 同步成功")
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
