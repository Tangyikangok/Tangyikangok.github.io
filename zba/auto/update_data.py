# -*- coding: utf-8 -*-
"""
浙BA 看板数据自动更新脚本（纯标准库，零依赖）

数据流：
  可选远程 API (DATA_SOURCE_URL)  ─┐
  增量输入 auto/feed.json        ─┼─→ 合并 / 重算 / 校验 ─→ 仓库根 data.json
  现有基线 data.json             ─┘

在 GitHub Actions 里由 .github/workflows/update.yml 定时调用；
也可以在本地直接运行：python auto/update_data.py
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data.json"
FEED_FILE = ROOT / "auto" / "feed.json"
BEIJING = timezone(timedelta(hours=8))


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def fetch_remote(url):
    """调用外部 API 取数，支持 GET/POST、表单/JSON 请求体、JWT 鉴权。

    环境变量：
      DATA_SOURCE_URL        完整接口地址（含路径）
      DATA_SOURCE_METHOD     GET / POST，默认 GET
      DATA_SOURCE_BODY       表单串（a=1&b=2）或 JSON 串（以 { 开头）
      DATA_SOURCE_TOKEN      鉴权 token；未设时回退到 TIXIEBAO_TOKEN
      DATA_SOURCE_SAVE_RAW   设为 1 时把第三方原始响应存到 auto/raw/ 供分析
      DATA_SOURCE_RAW_NAME   原始响应文件名，默认 response

    失败一律返回 None，不中断流程（看板会继续用本地数据）。
    """
    # 注：官方三接口同步走 sync_tixiebao.build()，在 main() 中优先执行；
    # 本通用 fetch_remote 仅作为「单一自定接口」的备用通道。
    if not url:
        return None
    method = os.environ.get("DATA_SOURCE_METHOD", "GET").strip().upper()
    body_raw = os.environ.get("DATA_SOURCE_BODY", "").strip()
    token = (os.environ.get("DATA_SOURCE_TOKEN")
             or os.environ.get("TIXIEBAO_TOKEN") or "").strip()

    headers = {"User-Agent": "zba-dashboard/1.0", "Accept": "application/json"}
    if token:
        headers["Authorization"] = token
    data = None
    if method == "POST" and body_raw:
        if body_raw.startswith("{"):
            headers["Content-Type"] = "application/json"
        else:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = body_raw.encode("utf-8")

    try:
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=20) as r:
            text = r.read().decode("utf-8")
        payload = json.loads(text)

        if os.environ.get("DATA_SOURCE_SAVE_RAW") == "1":
            name = os.environ.get("DATA_SOURCE_RAW_NAME", "response").strip() or "response"
            raw_dir = ROOT / "auto" / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            raw_file = raw_dir / (name + ".json")
            write_json(raw_file, payload)
            print(f"[API] 原始响应已保存: {raw_file.relative_to(ROOT)}")

        print(f"[API] 拉取成功: {method} {url}")
        return payload if isinstance(payload, dict) else None
    except Exception as e:
        print(f"[API] 拉取失败，已跳过: {e}")
        return None


def merge_results(base, incoming):
    """按 日期+主队+客队 去重合并，incoming 覆盖同场次旧值。"""
    idx = {}
    out = []
    for m in list(base) + list(incoming):
        if not isinstance(m, dict) or not all(k in m for k in ("date", "home", "away")):
            continue
        key = (str(m["date"]), str(m["home"]), str(m["away"]))
        if key in idx:
            out[idx[key]] = m
        else:
            idx[key] = len(out)
            out.append(m)
    out.sort(key=lambda m: str(m.get("date", "")), reverse=True)
    return out


def sync_schedule(schedule, results):
    """把新赛果回填到赛程表里对应的场次。"""
    lookup = {(str(m["date"]), str(m["home"]), str(m["away"])): m for m in results}
    n = 0
    for s in schedule:
        key = (str(s.get("date", "")), str(s.get("home", "")), str(s.get("away", "")))
        m = lookup.get(key)
        if m and m.get("hs") is not None and m.get("as") is not None:
            if s.get("hs") != m.get("hs") or s.get("as") != m.get("as"):
                s["hs"], s["as"] = m["hs"], m["as"]
                n += 1
    return n


def merge_standings(groups, incoming):
    """按组名整体替换积分榜，并重排 rank。未提供的组保持原样。"""
    n = 0
    for g in groups:
        name = g.get("name")
        if name in incoming and isinstance(incoming[name], list):
            teams = sorted(incoming[name], key=lambda t: (
                -int(t.get("pts", 0) or 0),
                -int(t.get("w", 0) or 0),
                int(t.get("l", 0) or 0),
            ))
            for i, t in enumerate(teams, 1):
                t["rank"] = i
            g["teams"] = teams
            n += 1
    return n


def validate(d):
    """基本结构校验，坏数据直接报错退出，避免把页面搞崩。"""
    for key in ("meta", "groups", "players", "schedule", "results"):
        if key not in d:
            raise ValueError(f"data.json 缺少顶层字段: {key}")
    if not isinstance(d["groups"], list) or not d["groups"]:
        raise ValueError("groups 不能为空")
    for g in d["groups"]:
        if not g.get("name") or not isinstance(g.get("teams"), list):
            raise ValueError(f"分组数据异常: {g.get('name')}")
        for t in g["teams"]:
            for k in ("team", "w", "l", "pts"):
                if k not in t:
                    raise ValueError(f"队伍缺少字段 {k}: {t}")
    for m in d["results"]:
        if not all(k in m for k in ("date", "home", "away")):
            raise ValueError(f"赛果字段不全: {m}")
    print("[校验] 结构 OK")


def main():
    if not DATA_FILE.exists():
        sys.exit(f"[错误] 找不到 {DATA_FILE}")

    data = read_json(DATA_FILE)
    feed = read_json(FEED_FILE) if FEED_FILE.exists() else {}

    # ===== 优先：体协宝官方三接口全量同步 =====
    # 配了 TIXIEBAO_TOKEN 就走官方接口拉真实数据；失败自动降级，
    # 不影响下面 feed.json 增量逻辑与现有 data.json 基线。
    tixiebao_ok = False
    tixiebao_token = os.environ.get("TIXIEBAO_TOKEN", "").strip()
    if tixiebao_token:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from sync_tixiebao import build as tixiebao_build
            # 传入现有 data.json 作为基线：赛程接口故障时页面不回退、不丢历史
            fresh = tixiebao_build(tixiebao_token, base=data)
            # 保留本地 meta 的自定义文字（若用户改过标题）
            for k in ("title", "subtitle", "season", "note"):
                if data.get("meta", {}).get(k):
                    fresh["meta"][k] = data["meta"][k]
            mode = fresh.get("meta", {}).get("syncMode", "-")
            data = fresh
            tixiebao_ok = True
            print("[体协宝] 官方接口同步成功（模式：%s）：%d 组 / %d 场赛程 / %d 条赛果" % (
                mode, len(data["groups"]), len(data["schedule"]), len(data["results"])))
            if mode == "base":
                print("[体协宝] 警告：赛程接口本次完全不可用，比分沿用本地基线，仅积分榜/球员榜已更新")
        except Exception as e:
            print("[体协宝] 官方接口同步失败，降级到本地基线：%s" % e)

    # ===== 备用：单一自定接口（通用增量通道）=====
    remote = None
    if not tixiebao_ok:
        remote = fetch_remote(os.environ.get("DATA_SOURCE_URL", "").strip())
        if remote and "groups" in remote:
            data = remote
            print("[API] 已用远程数据替换基线")

    changed = []

    if tixiebao_ok:
        # 官方全量数据即最终权威，跳过 feed/远程增量，避免旧数据污染。
        # 仅允许用户通过 feed.meta 覆盖少量自定义文案。
        changed.append("官方接口全量同步")
        if isinstance(feed.get("meta"), dict):
            patch = {k: v for k, v in feed["meta"].items() if not k.startswith("_")}
            data.setdefault("meta", {}).update(patch)
    else:
        # 1) 赛果增量（远程里若带 results 也一并合并）
        extra = list(feed.get("results") or [])
        if remote and isinstance(remote.get("results"), list):
            extra += remote["results"]
        if extra:
            before = len(data["results"])
            data["results"] = merge_results(data.get("results", []), extra)
            changed.append(f"赛果 {before} → {len(data['results'])} 条")

        # 2) 赛果回填赛程
        filled = sync_schedule(data.get("schedule", []), data.get("results", []))
        if filled:
            changed.append(f"回填赛程比分 {filled} 场")

        # 3) 积分榜覆盖（远程 standings 优先，feed 可再覆盖）
        standings = {}
        if remote and isinstance(remote.get("standings"), dict):
            standings.update(remote["standings"])
        if isinstance(feed.get("standings"), dict):
            standings.update(feed["standings"])
        if standings:
            n = merge_standings(data["groups"], standings)
            changed.append(f"更新积分榜 {n} 个组")

        # 4) 球员榜
        players = feed.get("players") or (remote.get("players") if remote else None)
        if players:
            data["players"] = players
            changed.append(f"更新球员榜 {len(players)} 人")

        # 5) 元信息
        meta_patch = {}
        if remote and isinstance(remote.get("meta"), dict):
            meta_patch.update(remote["meta"])
        if isinstance(feed.get("meta"), dict):
            meta_patch.update({k: v for k, v in feed["meta"].items() if not k.startswith("_")})
        data.setdefault("meta", {}).update(meta_patch)

    if changed:
        if not tixiebao_ok:
            data["meta"]["updatedAt"] = datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M")
            if remote:
                data["meta"]["source"] = data["meta"].get("source", "") + "（API 同步）"
        print("[更新] " + "；".join(changed))
    else:
        print("[更新] 无新增数据，保持原状")

    validate(data)
    write_json(DATA_FILE, data)
    print(f"[完成] 已写入 {DATA_FILE}，更新时间 {data['meta'].get('updatedAt')}")


if __name__ == "__main__":
    main()
