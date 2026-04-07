"""
Claude Max 챌린지 — 자동 사용량 리포트
~/.claude/ JSONL에서 오늘의 토큰 사용량을 집계해 챌린지 서버에 전송합니다.
OAuth 토큰 불필요. 로컬 파일만 읽습니다.
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


def count_today_tokens():
    """~/.claude/ JSONL 파일에서 오늘(KST) 토큰 사용량 집계"""
    home = os.path.expanduser("~")
    jsonl_files = glob.glob(os.path.join(home, ".claude", "projects", "*", "*.jsonl"))

    today = datetime.now(KST).strftime("%Y-%m-%d")
    input_tokens = 0
    output_tokens = 0
    cache_tokens = 0
    sessions = set()

    for fpath in jsonl_files:
        with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                    ts = obj.get("timestamp", "")
                    if not ts.startswith(today):
                        # KST 변환 체크
                        if ts and "T" in ts:
                            try:
                                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                                if dt.astimezone(KST).strftime("%Y-%m-%d") != today:
                                    continue
                            except:
                                continue
                        else:
                            continue

                    msg = obj.get("message", {})
                    if isinstance(msg, dict):
                        usage = msg.get("usage", {})
                        if usage and usage.get("output_tokens", 0) > 0:
                            input_tokens += usage.get("input_tokens", 0)
                            output_tokens += usage.get("output_tokens", 0)
                            cache_tokens += usage.get("cache_creation_input_tokens", 0)
                            cache_tokens += usage.get("cache_read_input_tokens", 0)
                            sid = obj.get("sessionId", "")
                            if sid:
                                sessions.add(sid)
                except:
                    pass

    return {
        "date": today,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_tokens": cache_tokens,
        "sessions": len(sessions),
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
        # Apps Script redirects — follow it
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

    usage = count_today_tokens()
    total = usage["input_tokens"] + usage["output_tokens"] + usage["cache_tokens"]

    print(f"[{datetime.now(KST).strftime('%H:%M')}] {cfg['nickname']} | "
          f"{usage['date']} | "
          f"{total:,} tokens | "
          f"{usage['sessions']} sessions", end="")

    if total == 0:
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
