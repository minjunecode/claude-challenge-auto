"""
Claude Max 챌린지 — 자동 사용량 리포트 (v2.0)
~/.claude/ + ~/.codex/ JSONL에서 오늘의 토큰 사용량을 집계해 챌린지 서버에 전송합니다.
OAuth 토큰 불필요. 로컬 파일만 읽습니다.

v2.0 변경사항:
  - Codex CLI 사용량도 함께 수집 (~/.codex/sessions/**/*.jsonl)
  - Claude/Codex 분리 필드로 전송: claude_*, codex_*
  - 하위 호환: Codex 디렉토리가 없으면 Claude만 보고 (기존 동작 유지)
  - 가격 가중치는 서버 측에서 계산 (이 스크립트는 순수 토큰만 수집)
"""

import json, glob, os, sys, io, time, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

# Windows UTF-8
if sys.platform == "win32":
    os.system("chcp 65001 >nul 2>&1")
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# ── 설정 ──
APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbys_MSZz16yoH9065nSLtsl4n9N0IMTYGECsvqzKIoD3EgZ30VlVxLjzOciq-8a6a8_KA/exec"
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".claude", "challenge-config.json")
LOG_PATH    = os.path.join(os.path.expanduser("~"), ".claude", "challenge-report.log")
KST = timezone(timedelta(hours=9))
HTTP_TIMEOUT = 45
HTTP_RETRIES = 2  # 실패 시 추가 시도 횟수 (총 3회까지)


def log(msg):
    """콘솔 + 파일에 기록. 파일은 최근 500줄만 유지."""
    line = f"[{datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        print(line)
    except Exception:
        pass
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        # 기존 로그 + 새 줄 → 500줄로 trim
        lines = []
        if os.path.exists(LOG_PATH):
            with open(LOG_PATH, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
        lines.append(line + "\n")
        if len(lines) > 500:
            lines = lines[-500:]
        with open(LOG_PATH, "w", encoding="utf-8") as f:
            f.writelines(lines)
    except Exception:
        pass


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_config(cfg):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def setup_config():
    """최초 1회: 닉네임/비밀번호 입력"""
    print("=== Claude Max 챌린지 — 초기 설정 ===")
    print()
    nickname = input("챌린지 닉네임: ").strip()
    password = input("챌린지 비밀번호: ").strip()
    if not nickname or not password:
        print("닉네임과 비밀번호를 입력해주세요.")
        sys.exit(1)
    cfg = {"nickname": nickname, "password": password}
    save_config(cfg)
    print(f"설정 저장 완료: {CONFIG_PATH}")
    return cfg


def _empty_hourly():
    """시간대별 집계 버킷 초기화 (0~23시)"""
    return {h: {"cl_in": 0, "cl_out": 0, "cl_cc": 0, "cl_cr": 0,
                "cx_in": 0, "cx_out": 0, "cx_cr": 0} for h in range(24)}


def _parse_kst_date_hour(ts, target_dates_set):
    """ISO 타임스탬프를 (YYYY-MM-DD, hour) KST로 변환.
    target_dates_set에 없는 날짜면 (None, None)."""
    if not ts or "T" not in ts:
        return (None, None)
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        kst_dt = dt.astimezone(KST)
        d = kst_dt.strftime("%Y-%m-%d")
        if d not in target_dates_set:
            return (None, None)
        return (d, kst_dt.hour)
    except Exception:
        return (None, None)


def _blank_day():
    return {
        "hourly": _empty_hourly(),
        "sessions": set(),
        "claude": {"in": 0, "out": 0, "cc": 0, "cr": 0},
        "codex":  {"in": 0, "out": 0, "cr": 0},
    }


def _scan_claude(target_dates_set, by_date):
    """~/.claude/projects/**/*.jsonl을 1회 스캔하여 target_dates 모두의 버킷에 쌓는다."""
    home = os.path.expanduser("~")
    jsonl_files = glob.glob(os.path.join(home, ".claude", "projects", "**", "*.jsonl"), recursive=True)

    for fpath in jsonl_files:
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    ts = obj.get("timestamp", "")
                    d, h = _parse_kst_date_hour(ts, target_dates_set)
                    if d is None:
                        continue

                    msg = obj.get("message", {})
                    if not isinstance(msg, dict):
                        continue
                    usage = msg.get("usage", {})
                    if not usage or usage.get("output_tokens", 0) <= 0:
                        continue

                    inp = usage.get("input_tokens", 0) or 0
                    out = usage.get("output_tokens", 0) or 0
                    cc  = usage.get("cache_creation_input_tokens", 0) or 0
                    cr  = usage.get("cache_read_input_tokens", 0) or 0

                    day = by_date[d]
                    day["claude"]["in"]  += inp
                    day["claude"]["out"] += out
                    day["claude"]["cc"]  += cc
                    day["claude"]["cr"]  += cr

                    b = day["hourly"][h]
                    b["cl_in"]  += inp
                    b["cl_out"] += out
                    b["cl_cc"]  += cc
                    b["cl_cr"]  += cr

                    sid = obj.get("sessionId", "") or os.path.basename(fpath)
                    if sid:
                        day["sessions"].add(sid)
        except Exception:
            continue


def _scan_codex(target_dates_set, by_date):
    """~/.codex/sessions/**/*.jsonl을 1회 스캔하여 target_dates 모두의 버킷에 쌓는다."""
    home = os.path.expanduser("~")
    codex_dir = os.path.join(home, ".codex", "sessions")
    if not os.path.isdir(codex_dir):
        return

    jsonl_files = glob.glob(os.path.join(codex_dir, "**", "*.jsonl"), recursive=True)

    for fpath in jsonl_files:
        session_id = None
        had_usage_for = set()  # 이 파일에서 사용량이 잡힌 날짜들
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    payload = obj.get("payload", {})
                    if not isinstance(payload, dict):
                        continue
                    if session_id is None:
                        sid = payload.get("id") or payload.get("session_id")
                        if sid:
                            session_id = sid
                    if payload.get("type") != "token_count":
                        continue

                    ts = obj.get("timestamp", "")
                    d, h = _parse_kst_date_hour(ts, target_dates_set)
                    if d is None:
                        continue

                    info = payload.get("info", {}) or {}
                    last = info.get("last_token_usage") or {}
                    if not last:
                        continue

                    inp = last.get("input_tokens", 0) or 0
                    cr  = last.get("cached_input_tokens", 0) or 0
                    out = last.get("output_tokens", 0) or 0
                    if inp == 0 and out == 0 and cr == 0:
                        continue

                    had_usage_for.add(d)

                    day = by_date[d]
                    day["codex"]["in"]  += inp
                    day["codex"]["out"] += out
                    day["codex"]["cr"]  += cr

                    b = day["hourly"][h]
                    b["cx_in"]  += inp
                    b["cx_out"] += out
                    b["cx_cr"]  += cr
        except Exception:
            continue

        if had_usage_for:
            sid = session_id or os.path.basename(fpath)
            for d in had_usage_for:
                by_date[d]["sessions"].add("codex:" + str(sid))


def collect_usage_multi(date_list):
    """여러 날짜의 사용량을 한 번의 파일 스캔으로 집계.
    반환: [{date, claude_input_tokens, ..., hourly}, ...] 입력 순서대로."""
    target_set = set(date_list)
    by_date = {d: _blank_day() for d in date_list}

    _scan_claude(target_set, by_date)
    _scan_codex(target_set, by_date)

    results = []
    for d in date_list:
        day = by_date[d]
        hourly_list = []
        for h in range(24):
            b = day["hourly"][h]
            if any(b[k] > 0 for k in b):
                hourly_list.append({
                    "h": h,
                    "cl": {"in": b["cl_in"], "out": b["cl_out"], "cc": b["cl_cc"], "cr": b["cl_cr"]},
                    "cx": {"in": b["cx_in"], "out": b["cx_out"], "cr": b["cx_cr"]},
                })
        results.append({
            "date": d,
            "claude_input_tokens":            day["claude"]["in"],
            "claude_output_tokens":           day["claude"]["out"],
            "claude_cache_creation_tokens":   day["claude"]["cc"],
            "claude_cache_read_tokens":       day["claude"]["cr"],
            "codex_input_tokens":             day["codex"]["in"],
            "codex_output_tokens":            day["codex"]["out"],
            "codex_cache_read_tokens":        day["codex"]["cr"],
            "sessions": len(day["sessions"]),
            "hourly": hourly_list,
        })
    return results


# 하위 호환: 기존 단일 날짜 호출
def collect_usage(target_date=None):
    if target_date is None:
        target_date = datetime.now(KST).strftime("%Y-%m-%d")
    return collect_usage_multi([target_date])[0]


def _post_once(payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        APPS_SCRIPT_URL,
        data=data,
        headers={"Content-Type": "text/plain"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            redirect_url = e.headers.get("Location", "")
            if redirect_url:
                req2 = urllib.request.Request(redirect_url)
                with urllib.request.urlopen(req2, timeout=HTTP_TIMEOUT) as resp2:
                    return json.loads(resp2.read().decode("utf-8"))
        return {"success": False, "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def report_usage(cfg, usage):
    """Apps Script에 사용량 전송. 실패 시 최대 HTTP_RETRIES만큼 재시도."""
    payload = {
        "action": "reportUsage",
        "nickname": cfg["nickname"],
        "password": str(cfg["password"]),
        **usage,
    }
    last = None
    for attempt in range(HTTP_RETRIES + 1):
        result = _post_once(payload)
        if result and result.get("success"):
            return result
        last = result
        if attempt < HTTP_RETRIES:
            time.sleep(2 ** attempt)  # 1s, 2s backoff
    return last or {"success": False, "error": "no response"}


def _report_one(cfg, usage):
    """1일분 사용량 출력 + 전송. 토큰 0이면 skip."""
    cl_total = (usage["claude_input_tokens"] + usage["claude_output_tokens"]
                + usage["claude_cache_creation_tokens"] + usage["claude_cache_read_tokens"])
    cx_total = (usage["codex_input_tokens"] + usage["codex_output_tokens"]
                + usage["codex_cache_read_tokens"])

    summary = (f"{cfg['nickname']} | {usage['date']} | "
               f"Claude in:{usage['claude_input_tokens']:,} out:{usage['claude_output_tokens']:,} "
               f"cc:{usage['claude_cache_creation_tokens']:,} cr:{usage['claude_cache_read_tokens']:,} | "
               f"Codex in:{usage['codex_input_tokens']:,} out:{usage['codex_output_tokens']:,} "
               f"cr:{usage['codex_cache_read_tokens']:,} | "
               f"{usage['sessions']} sessions")

    if cl_total == 0 and cx_total == 0:
        log(summary + " | skip (no usage)")
        return

    t0 = time.time()
    result = report_usage(cfg, usage)
    elapsed = int((time.time() - t0) * 1000)
    if result and result.get("success"):
        note = " (skipped)" if result.get("skipped") else ""
        log(summary + f" | OK{note} ({elapsed}ms)")
    else:
        error = result.get("error", "unknown") if result else "no response"
        log(summary + f" | FAIL: {error} ({elapsed}ms)")


def main():
    try:
        cfg = load_config()
        if not cfg.get("nickname") or not cfg.get("password"):
            cfg = setup_config()

        now_kst = datetime.now(KST)
        log(f"=== tick start (python {sys.version_info.major}.{sys.version_info.minor} {sys.platform}) ===")

        # 최근 48시간 윈도우 커버 (그제·어제·오늘)
        # JSONL을 1회만 스캔하여 3일치 버킷에 동시에 쌓음 (기존 3배 스캔 → 1배)
        dates = [
            (now_kst - timedelta(days=2)).strftime("%Y-%m-%d"),
            (now_kst - timedelta(days=1)).strftime("%Y-%m-%d"),
            now_kst.strftime("%Y-%m-%d"),
        ]
        t_scan = time.time()
        multi = collect_usage_multi(dates)
        log(f"scan: {len(dates)} days in {int((time.time()-t_scan)*1000)}ms")

        for usage in multi:
            _report_one(cfg, usage)

        log("=== tick end ===")
    except Exception as e:
        # 어떤 예외든 로그에 남기기 (스케줄러에서 조용히 죽는 것 방지)
        log(f"FATAL: {type(e).__name__}: {e}")
        raise


if __name__ == "__main__":
    main()
