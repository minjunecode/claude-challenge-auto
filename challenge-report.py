"""
Claude Max 챌린지 — 자동 사용량 리포트 (v2.2)
~/.claude/ + ~/.codex/ JSONL에서 오늘의 토큰 사용량을 집계해 챌린지 서버에 전송합니다.
OAuth 토큰 불필요. 로컬 파일만 읽습니다.

v2.2 (증분 스캔):
  - 파일별 mtime+size 시그니처 캐시 (~/.claude/challenge-scan-cache.json)
  - 시그니처 일치 → 캐시된 기여(contribution) 재사용, 파일 read 스킵
  - 헤비 사용자 스캔 시간 90%+ 단축 (수 초 → 수백 ms)

v2.1 (실행 시간 단축):
  - 3일치 HTTP POST를 병렬로 전송 (순차 → 동시) — 약 3배 빠름
  - JSONL 파일 mtime 사전 필터: 4일 이전 마지막 수정 파일 스킵
  - HTTP timeout 45→20초, 재시도 2→1회 — 최악 시나리오 시간 절반

v2.0:
  - Codex CLI 사용량도 함께 수집 (~/.codex/sessions/**/*.jsonl)
  - Claude/Codex 분리 필드로 전송: claude_*, codex_*
  - 하위 호환: Codex 디렉토리가 없으면 Claude만 보고 (기존 동작 유지)
  - 가격 가중치는 서버 측에서 계산 (이 스크립트는 순수 토큰만 수집)
"""

import json, glob, os, sys, io, time, uuid, ssl, platform, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta


def _create_ssl_context():
    """SSL 컨텍스트 생성. macOS python.org Python은 시스템 keychain을 사용하지 않아
    인증서 검증 실패가 자주 발생함. certifi가 설치돼 있으면 그 번들을 명시적으로 사용해
    'Install Certificates.command' 미실행 환경도 자동 우회한다.
    certifi 없으면 시스템 기본 (Linux/Windows/Homebrew Python은 보통 정상 작동)."""
    try:
        import certifi  # pip 설치 Python에는 보통 포함됨
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


SSL_CONTEXT = _create_ssl_context()

# Windows UTF-8
if sys.platform == "win32":
    os.system("chcp 65001 >nul 2>&1")
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# ── 설정 ──
APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbys_MSZz16yoH9065nSLtsl4n9N0IMTYGECsvqzKIoD3EgZ30VlVxLjzOciq-8a6a8_KA/exec"
CONFIG_PATH     = os.path.join(os.path.expanduser("~"), ".claude", "challenge-config.json")
LOG_PATH        = os.path.join(os.path.expanduser("~"), ".claude", "challenge-report.log")
MACHINE_ID_PATH = os.path.join(os.path.expanduser("~"), ".claude", "challenge-machine-id")
SCAN_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".claude", "challenge-scan-cache.json")
KST = timezone(timedelta(hours=9))
HTTP_TIMEOUT = 20  # Apps Script 평소 1~5초. 20초면 정상 케이스 충분, 최악 한도는 짧게.
HTTP_RETRIES = 1   # 실패 시 추가 시도 횟수 (총 2회까지)
SCAN_FRESHNESS_DAYS = 4  # 마지막 수정이 N일 이전인 JSONL은 윈도우(어제·오늘)와 무관 → 스킵
SCAN_CACHE_VERSION = 2   # 캐시 스키마 버전 (변경 시 강제 재계산)


def get_machine_id():
    """영구 machine_id. 최초 1회 생성 후 파일에 저장.
    형식: <hostname>_<8자 uuid>  (예: 'mjm-macbook_3a7f92b1')
    - hostname은 사람이 어느 PC인지 식별하기 쉽도록
    - uuid는 hostname이 같아도 충돌 방지
    """
    try:
        if os.path.exists(MACHINE_ID_PATH):
            with open(MACHINE_ID_PATH, "r", encoding="utf-8") as f:
                mid = f.read().strip()
            if mid:
                return mid
    except Exception:
        pass
    host = platform.node() or "pc"
    # 특수문자 제거 (시트 저장 안전성)
    host = "".join(c for c in host if c.isalnum() or c in "-_") or "pc"
    mid = f"{host}_{uuid.uuid4().hex[:8]}"
    try:
        os.makedirs(os.path.dirname(MACHINE_ID_PATH), exist_ok=True)
        with open(MACHINE_ID_PATH, "w", encoding="utf-8") as f:
            f.write(mid)
    except Exception:
        pass
    return mid


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


def _is_stale_file(fpath):
    """파일 mtime이 SCAN_FRESHNESS_DAYS 이전이면 True. 윈도우 외 데이터라 스킵 가능.
    JSONL은 append-only가 일반적이라 마지막 수정 시각이 곧 마지막 쓰기 시각."""
    try:
        cutoff = time.time() - SCAN_FRESHNESS_DAYS * 86400
        return os.path.getmtime(fpath) < cutoff
    except Exception:
        return False  # mtime 못 읽으면 안전하게 스캔


# ── 스캔 캐시 (파일 시그니처 + 기여도) ────────────────────────────────────
# 구조: { version, files: { fpath: { mtime, size, contrib: { date: {...} } } } }
# 기여 구조 (claude):  { claude: {in,out,cc,cr}, hourly: { "14": {cl_in,...}, ... }, sessions: [...] }
# 기여 구조 (codex):   { codex:  {in,out,cr},    hourly: { "14": {cx_in,...}, ... }, sessions: [...] }
# 캐시 hit 조건: mtime + size가 정확히 일치 (append-only JSONL은 새 줄 시 size 변함).

def _load_scan_cache():
    try:
        with open(SCAN_CACHE_PATH, "r", encoding="utf-8") as f:
            c = json.load(f)
        if c.get("version") != SCAN_CACHE_VERSION:
            return {"version": SCAN_CACHE_VERSION, "claude": {}, "codex": {}}
        # 누락 키 보강
        c.setdefault("claude", {})
        c.setdefault("codex", {})
        return c
    except Exception:
        return {"version": SCAN_CACHE_VERSION, "claude": {}, "codex": {}}


def _save_scan_cache(cache):
    try:
        os.makedirs(os.path.dirname(SCAN_CACHE_PATH), exist_ok=True)
        with open(SCAN_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
    except Exception:
        pass


def _file_sig(fpath):
    """파일 시그니처: (mtime, size). 캐시 무효화 판정용."""
    try:
        st = os.stat(fpath)
        return {"mtime": st.st_mtime, "size": st.st_size}
    except Exception:
        return None


def _scan_claude_file_contrib(fpath):
    """한 파일의 모든 날짜별 Claude 기여도를 계산. 캐시 저장용 (target_dates 무관).
    이후 merge 시 현재 target_dates_set에 해당하는 날짜만 사용."""
    contrib = {}
    try:
        with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                ts = obj.get("timestamp", "")
                if not ts or "T" not in ts:
                    continue
                try:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    kst_dt = dt.astimezone(KST)
                    d = kst_dt.strftime("%Y-%m-%d")
                    h = kst_dt.hour
                except Exception:
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

                if d not in contrib:
                    contrib[d] = {"claude": {"in": 0, "out": 0, "cc": 0, "cr": 0},
                                  "hourly": {}, "sessions": []}
                day = contrib[d]
                day["claude"]["in"]  += inp
                day["claude"]["out"] += out
                day["claude"]["cc"]  += cc
                day["claude"]["cr"]  += cr

                hkey = str(h)
                if hkey not in day["hourly"]:
                    day["hourly"][hkey] = {"cl_in": 0, "cl_out": 0, "cl_cc": 0, "cl_cr": 0}
                hb = day["hourly"][hkey]
                hb["cl_in"]  += inp
                hb["cl_out"] += out
                hb["cl_cc"]  += cc
                hb["cl_cr"]  += cr

                sid = obj.get("sessionId", "") or os.path.basename(fpath)
                if sid and sid not in day["sessions"]:
                    day["sessions"].append(sid)
    except Exception:
        return {}
    return contrib


def _scan_claude(target_dates_set, by_date, scan_cache):
    """파일별 캐시를 활용해 Claude 기여도를 by_date에 누적."""
    home = os.path.expanduser("~")
    jsonl_files = glob.glob(os.path.join(home, ".claude", "projects", "**", "*.jsonl"), recursive=True)

    file_cache = scan_cache.setdefault("claude", {})
    new_cache = {}

    for fpath in jsonl_files:
        if _is_stale_file(fpath):
            continue
        sig = _file_sig(fpath)
        if not sig:
            continue

        cached = file_cache.get(fpath)
        if cached and cached.get("mtime") == sig["mtime"] and cached.get("size") == sig["size"]:
            contrib = cached.get("contrib") or {}
        else:
            contrib = _scan_claude_file_contrib(fpath)

        new_cache[fpath] = {"mtime": sig["mtime"], "size": sig["size"], "contrib": contrib}

        for d, c in contrib.items():
            if d not in target_dates_set:
                continue
            day = by_date[d]
            day["claude"]["in"]  += c["claude"]["in"]
            day["claude"]["out"] += c["claude"]["out"]
            day["claude"]["cc"]  += c["claude"]["cc"]
            day["claude"]["cr"]  += c["claude"]["cr"]
            for hkey, hb in c.get("hourly", {}).items():
                h = int(hkey)
                b = day["hourly"][h]
                b["cl_in"]  += hb["cl_in"]
                b["cl_out"] += hb["cl_out"]
                b["cl_cc"]  += hb["cl_cc"]
                b["cl_cr"]  += hb["cl_cr"]
            for sid in c.get("sessions", []):
                day["sessions"].add(sid)

    scan_cache["claude"] = new_cache


def _scan_codex_file_contrib(fpath):
    """한 파일의 모든 날짜별 Codex 기여도를 계산. 캐시 저장용."""
    contrib = {}
    session_id = None
    fname_fallback = os.path.basename(fpath)
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
                if not ts or "T" not in ts:
                    continue
                try:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    kst_dt = dt.astimezone(KST)
                    d = kst_dt.strftime("%Y-%m-%d")
                    h = kst_dt.hour
                except Exception:
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

                if d not in contrib:
                    contrib[d] = {"codex": {"in": 0, "out": 0, "cr": 0},
                                  "hourly": {}, "sessions": []}
                day = contrib[d]
                day["codex"]["in"]  += inp
                day["codex"]["out"] += out
                day["codex"]["cr"]  += cr

                hkey = str(h)
                if hkey not in day["hourly"]:
                    day["hourly"][hkey] = {"cx_in": 0, "cx_out": 0, "cx_cr": 0}
                hb = day["hourly"][hkey]
                hb["cx_in"]  += inp
                hb["cx_out"] += out
                hb["cx_cr"]  += cr
    except Exception:
        return {}

    # 세션 ID 후처리 — 파일당 1개 sid를 모든 날짜에 부여
    if contrib:
        sid_label = "codex:" + str(session_id or fname_fallback)
        for d in contrib:
            contrib[d]["sessions"] = [sid_label]
    return contrib


def _scan_codex(target_dates_set, by_date, scan_cache):
    """파일별 캐시를 활용해 Codex 기여도를 by_date에 누적."""
    home = os.path.expanduser("~")
    codex_dir = os.path.join(home, ".codex", "sessions")
    if not os.path.isdir(codex_dir):
        return

    jsonl_files = glob.glob(os.path.join(codex_dir, "**", "*.jsonl"), recursive=True)

    file_cache = scan_cache.setdefault("codex", {})
    new_cache = {}

    for fpath in jsonl_files:
        if _is_stale_file(fpath):
            continue
        sig = _file_sig(fpath)
        if not sig:
            continue

        cached = file_cache.get(fpath)
        if cached and cached.get("mtime") == sig["mtime"] and cached.get("size") == sig["size"]:
            contrib = cached.get("contrib") or {}
        else:
            contrib = _scan_codex_file_contrib(fpath)

        new_cache[fpath] = {"mtime": sig["mtime"], "size": sig["size"], "contrib": contrib}

        for d, c in contrib.items():
            if d not in target_dates_set:
                continue
            day = by_date[d]
            day["codex"]["in"]  += c["codex"]["in"]
            day["codex"]["out"] += c["codex"]["out"]
            day["codex"]["cr"]  += c["codex"]["cr"]
            for hkey, hb in c.get("hourly", {}).items():
                h = int(hkey)
                b = day["hourly"][h]
                b["cx_in"]  += hb["cx_in"]
                b["cx_out"] += hb["cx_out"]
                b["cx_cr"]  += hb["cx_cr"]
            for sid in c.get("sessions", []):
                day["sessions"].add(sid)

    scan_cache["codex"] = new_cache


def collect_usage_multi(date_list):
    """여러 날짜의 사용량을 한 번의 파일 스캔으로 집계.
    파일별 캐시 (~/.claude/challenge-scan-cache.json)를 활용해 변경 없는 파일은 재스캔 스킵.
    반환: [{date, claude_input_tokens, ..., hourly}, ...] 입력 순서대로."""
    target_set = set(date_list)
    by_date = {d: _blank_day() for d in date_list}

    scan_cache = _load_scan_cache()
    _scan_claude(target_set, by_date, scan_cache)
    _scan_codex(target_set, by_date, scan_cache)
    _save_scan_cache(scan_cache)

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
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT, context=SSL_CONTEXT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            redirect_url = e.headers.get("Location", "")
            if redirect_url:
                req2 = urllib.request.Request(redirect_url)
                with urllib.request.urlopen(req2, timeout=HTTP_TIMEOUT, context=SSL_CONTEXT) as resp2:
                    return json.loads(resp2.read().decode("utf-8"))
        return {"success": False, "error": f"HTTP {e.code}"}
    except Exception as e:
        msg = str(e)
        # macOS python.org Python의 흔한 SSL 인증서 문제 — 친절한 안내 메시지 추가
        if "CERTIFICATE_VERIFY_FAILED" in msg:
            msg = ("SSL 인증서 검증 실패. macOS python.org Python 사용자라면 터미널에서 "
                   "'pip3 install --upgrade certifi' 실행 후 다시 시도하세요. "
                   "(원본 오류: " + msg + ")")
        return {"success": False, "error": msg}


def report_usage(cfg, usage):
    """Apps Script에 사용량 전송. 실패 시 최대 HTTP_RETRIES만큼 재시도."""
    payload = {
        "action": "reportUsage",
        "nickname": cfg["nickname"],
        "password": str(cfg["password"]),
        "machine_id": cfg.get("machine_id") or get_machine_id(),
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
        cfg["machine_id"] = get_machine_id()
        log(f"=== tick start (python {sys.version_info.major}.{sys.version_info.minor} {sys.platform}, machine={cfg['machine_id']}) ===")

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

        # 3일치를 병렬로 POST (순차 → 동시) — 가장 큰 wall-time 단축 포인트.
        # _report_one은 내부에서 log() 호출 — 로그는 시간 순으로 인터리브될 수 있음 (의도된 동작).
        with ThreadPoolExecutor(max_workers=len(multi) or 1) as executor:
            list(executor.map(lambda u: _report_one(cfg, u), multi))

        log("=== tick end ===")
    except Exception as e:
        # 어떤 예외든 로그에 남기기 (스케줄러에서 조용히 죽는 것 방지)
        log(f"FATAL: {type(e).__name__}: {e}")
        raise


if __name__ == "__main__":
    main()
