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

import json, glob, os, sys, io, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

# Windows UTF-8
if sys.platform == "win32":
    os.system("chcp 65001 >nul 2>&1")
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# ── 설정 ──
APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbys_MSZz16yoH9065nSLtsl4n9N0IMTYGECsvqzKIoD3EgZ30VlVxLjzOciq-8a6a8_KA/exec"
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".claude", "challenge-config.json")
KST = timezone(timedelta(hours=9))


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


def _parse_kst_hour(ts, today):
    """ISO 타임스탬프를 KST 시(0-23)로 변환. 오늘이 아니면 None."""
    if not ts or "T" not in ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        kst_dt = dt.astimezone(KST)
        if kst_dt.strftime("%Y-%m-%d") != today:
            return None
        return kst_dt.hour
    except Exception:
        return None


def count_claude_tokens(today, hourly, sessions):
    """~/.claude/projects/**/*.jsonl에서 오늘(KST) Claude 토큰 집계."""
    home = os.path.expanduser("~")
    jsonl_files = glob.glob(os.path.join(home, ".claude", "projects", "**", "*.jsonl"), recursive=True)

    total = {"in": 0, "out": 0, "cc": 0, "cr": 0}

    for fpath in jsonl_files:
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    ts = obj.get("timestamp", "")
                    kst_hour = _parse_kst_hour(ts, today)
                    if kst_hour is None:
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

                    total["in"] += inp
                    total["out"] += out
                    total["cc"] += cc
                    total["cr"] += cr

                    hourly[kst_hour]["cl_in"] += inp
                    hourly[kst_hour]["cl_out"] += out
                    hourly[kst_hour]["cl_cc"] += cc
                    hourly[kst_hour]["cl_cr"] += cr

                    sid = obj.get("sessionId", "")
                    if sid:
                        sessions.add(sid)
        except Exception:
            continue

    return total


def count_codex_tokens(today, hourly, sessions):
    """~/.codex/sessions/**/*.jsonl에서 오늘(KST) Codex 토큰 집계.

    Codex 세션 라인 포맷: {type, timestamp, payload}
    token_count 이벤트:
        payload.type == "token_count"
        payload.info.last_token_usage = {
            input_tokens, cached_input_tokens, output_tokens,
            reasoning_output_tokens, total_tokens
        }
    last_token_usage는 해당 턴의 delta이므로 그대로 합산하면 됨.

    디렉토리가 없으면 조용히 0 반환 (Codex 사용 안 하는 유저).
    """
    home = os.path.expanduser("~")
    codex_dir = os.path.join(home, ".codex", "sessions")
    total = {"in": 0, "out": 0, "cr": 0}

    if not os.path.isdir(codex_dir):
        return total

    jsonl_files = glob.glob(os.path.join(codex_dir, "**", "*.jsonl"), recursive=True)

    for fpath in jsonl_files:
        session_id = None
        had_usage = False
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    # 세션 ID 추적 (session_meta 이벤트 or 파일명 fallback)
                    if session_id is None:
                        payload = obj.get("payload", {})
                        if isinstance(payload, dict):
                            sid = payload.get("id") or payload.get("session_id")
                            if sid:
                                session_id = sid

                    # token_count 이벤트만 집계
                    payload = obj.get("payload", {})
                    if not isinstance(payload, dict):
                        continue
                    if payload.get("type") != "token_count":
                        continue

                    ts = obj.get("timestamp", "")
                    kst_hour = _parse_kst_hour(ts, today)
                    if kst_hour is None:
                        continue

                    info = payload.get("info", {}) or {}
                    last = info.get("last_token_usage") or {}
                    if not last:
                        continue

                    # Codex의 input_tokens는 fresh(캐시 아닌) 입력, cached_input_tokens는 별도
                    inp = last.get("input_tokens", 0) or 0
                    cr  = last.get("cached_input_tokens", 0) or 0
                    out = last.get("output_tokens", 0) or 0
                    # reasoning_output_tokens는 이미 output_tokens에 포함됨 (별도 합산 안 함)

                    if inp == 0 and out == 0 and cr == 0:
                        continue
                    had_usage = True

                    total["in"] += inp
                    total["out"] += out
                    total["cr"] += cr

                    hourly[kst_hour]["cx_in"] += inp
                    hourly[kst_hour]["cx_out"] += out
                    hourly[kst_hour]["cx_cr"] += cr
        except Exception:
            continue

        # 세션 ID fallback: 파일명 사용
        if had_usage:
            if session_id is None:
                session_id = os.path.basename(fpath)
            sessions.add("codex:" + str(session_id))

    return total


def collect_usage():
    """오늘(KST)의 Claude + Codex 사용량 집계."""
    today = datetime.now(KST).strftime("%Y-%m-%d")
    hourly = _empty_hourly()
    sessions = set()

    claude = count_claude_tokens(today, hourly, sessions)
    codex  = count_codex_tokens(today, hourly, sessions)

    # 시간대별 리스트 (v2 형식: {h, cl: {...}, cx: {...}})
    hourly_list = []
    for h in range(24):
        b = hourly[h]
        if any(b[k] > 0 for k in b):
            hourly_list.append({
                "h": h,
                "cl": {"in": b["cl_in"], "out": b["cl_out"], "cc": b["cl_cc"], "cr": b["cl_cr"]},
                "cx": {"in": b["cx_in"], "out": b["cx_out"], "cr": b["cx_cr"]},
            })

    return {
        "date": today,
        "claude_input_tokens": claude["in"],
        "claude_output_tokens": claude["out"],
        "claude_cache_creation_tokens": claude["cc"],
        "claude_cache_read_tokens": claude["cr"],
        "codex_input_tokens": codex["in"],
        "codex_output_tokens": codex["out"],
        "codex_cache_read_tokens": codex["cr"],
        "sessions": len(sessions),
        "hourly": hourly_list,
    }


def report_usage(cfg, usage):
    """Apps Script에 사용량 전송"""
    payload = {
        "action": "reportUsage",
        "nickname": cfg["nickname"],
        "password": cfg["password"],
        **usage,
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        APPS_SCRIPT_URL,
        data=data,
        headers={"Content-Type": "text/plain"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            redirect_url = e.headers.get("Location", "")
            if redirect_url:
                req2 = urllib.request.Request(redirect_url)
                with urllib.request.urlopen(req2, timeout=30) as resp2:
                    return json.loads(resp2.read().decode("utf-8"))
        return {"success": False, "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def main():
    cfg = load_config()
    if not cfg.get("nickname") or not cfg.get("password"):
        cfg = setup_config()

    usage = collect_usage()

    cl_total = (usage["claude_input_tokens"] + usage["claude_output_tokens"]
                + usage["claude_cache_creation_tokens"] + usage["claude_cache_read_tokens"])
    cx_total = (usage["codex_input_tokens"] + usage["codex_output_tokens"]
                + usage["codex_cache_read_tokens"])

    print(f"[{datetime.now(KST).strftime('%H:%M')}] {cfg['nickname']} | "
          f"{usage['date']} | "
          f"Claude in:{usage['claude_input_tokens']:,} out:{usage['claude_output_tokens']:,} "
          f"cc:{usage['claude_cache_creation_tokens']:,} cr:{usage['claude_cache_read_tokens']:,} | "
          f"Codex in:{usage['codex_input_tokens']:,} out:{usage['codex_output_tokens']:,} "
          f"cr:{usage['codex_cache_read_tokens']:,} | "
          f"{usage['sessions']} sessions", end="")

    if cl_total == 0 and cx_total == 0:
        print(" | skip (no usage)")
        return

    result = report_usage(cfg, usage)
    if result and result.get("success"):
        print(" | OK")
    else:
        error = result.get("error", "unknown") if result else "no response"
        print(f" | FAIL: {error}")


if __name__ == "__main__":
    main()
