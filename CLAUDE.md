# Claude Max 챌린지 프로젝트 가이드

친구들끼리 Claude Max 구독 사용량을 경쟁하는 랭킹 사이트.

## 저장소 구조

**단일 레포로 통합됨 (2026-04-11).** 이전에는 `claude-challenge-site`(프론트엔드)와 `claude-challenge-auto`(운영 자산) 두 레포로 분리돼 있었으나, 동기화 누락 문제가 반복되어 `claude-challenge-auto` 단일 레포로 통합.

| 항목 | 위치 |
|------|------|
| 운영 레포 | `claude-challenge-auto` |
| 라이브 URL | https://minjunecode.github.io/claude-challenge-auto/#dashboard |
| 구 레포 | `claude-challenge-site` — **archived**. 더 이상 편집·푸시 금지 |

> ⚠️ 옛 레포 `claude-challenge-site`에 잘못 커밋하지 말 것. 모든 변경은 `claude-challenge-auto`에서 수행.

## 주요 파일

### 프론트엔드
- `app.js` — 모든 렌더링 로직. 대시보드, 내 분석, 인증 탭.
- `index.html` — 단일 페이지. 캐시 버스터 `v=20260409k` 형식으로 관리.
- `style.css` — 스타일 전체.
- `setup-guide.html` — 자동 리포팅 설정 가이드 (멤버 배포용).
- `diagram.html`, `about.html` — 부가 페이지.

### 서버 / 리포터
- `AutoCode.gs` — Google Apps Script 원본. 실제 운영 코드는 Apps Script 에디터에서 **수동 재배포** 필요. 깃에 있는 파일은 소스 백업용.
- `challenge-report.py` — 멤버 PC에서 1시간마다 실행되는 리포터. Claude Code의 `~/.claude/projects/**/*.jsonl`을 파싱해 토큰 수를 집계한 뒤 Apps Script 엔드포인트로 POST.
- `setup-scheduler.bat` — 멤버 PC용 Windows 스케줄러 등록 배치 파일.

## 스코어 공식

가중 스코어 (`score`):
```
score = (input × 1) + (output × 5) + (cache_creation × 1.25) + (cache_read × 0.1)
```
근거: Anthropic 공식 단가 (Claude 3.5 Sonnet) 대비 상대 가중치.

`cache_read`는 가중치가 매우 낮음(0.1). 실제 raw 토큰의 90%+가 cache_read이므로 raw 합계와 가중 스코어가 크게 다를 수 있음 — 이는 정상.

## 포인트 티어

```javascript
const POINT_1_THRESHOLD = 1000000;    // 1pt:  1M+
const POINT_2_THRESHOLD = 10000000;   // 2pt:  10M+
const POINT_3_THRESHOLD = 50000000;   // 3pt:  50M+
```

일간 가중 스코어 기준으로 매일 최대 3pt 획득. 주간 뷰에는 `O` / `OO` / `OOO` 로 표시, `-` 는 포인트 없음, `X` 는 미제출.

## 데이터 흐름

```
멤버 PC
  └─ ~/.claude/projects/**/*.jsonl (Claude Code 세션 로그)
      └─ challenge-report.py (1시간마다 cron/schtasks)
          └─ HTTPS POST → Apps Script (AutoCode.gs)
              ├─ 사용량_raw 시트  (시간별 누적 스냅샷 + hourly JSON)
              ├─ 사용량 시트     (일별 최종값, 대시보드용)
              └─ 인증기록 시트    (포인트·제출시각)
                  └─ doGet?action=dashboard → 프론트엔드 JSON
```

### 시트 컬럼

**사용량_raw** (10열):
`nickname, date, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, score, sessions, reportedAt, hourly`

**사용량** (일별 upsert, 동일 컬럼 구조).

**인증기록**: `nickname, date, ..., points(5열), submittedAt(6열), ..., score(8열), date_str(9열)` — 재보고 시 **submittedAt도 최신 시각으로 갱신**됨.

**hourly** 필드 (JSON 배열):
```json
[{"h": 14, "in": 1007, "out": 181207, "cc": 1527031, "cr": 74404978}, ...]
```
`cc`/`cr`는 2026-04-11 추가됨. 그 이전 데이터는 `cc/cr` 없음 (`item.cc || 0`으로 호환).

## 핵심 규약

### `safeInt(v)` (AutoCode.gs)
Google Sheets가 Date 셀을 epoch ms(1.7e12 등)로 자동 변환하는 문제 방지용 헬퍼.
- Date 객체 → 0
- NaN → 0
- 10,000,000,000 이상 → 0 (Date→epoch 오염으로 간주)
- 그 외 → `Number(v)`

**모든 시트 읽기 경로**에서 `Number()` 대신 `safeInt()` 사용.

### `getScore(d)` (프론트엔드)
컴포넌트가 있으면 **항상** 공식으로 재계산. `d.score`는 10B 미만일 때만 fallback.
```javascript
function getScore(d) {
  const inp = d.input_tokens || 0;
  const out = d.output_tokens || 0;
  const cc  = d.cache_creation_tokens || 0;
  const cr  = d.cache_read_tokens || 0;
  if (inp > 0 || out > 0) {
    return Math.round((inp * 1) + (out * 5) + (cc * 1.25) + (cr * 0.1));
  }
  if (d.score && typeof d.score === 'number' && d.score < 10000000000) return d.score;
  return 0;
}
```

### 캐시 버스터
`index.html`의 `<link rel="stylesheet" href="style.css?v=20260409k">` / `<script src="app.js?v=20260409k">` 를 파일 변경마다 증가. 사용자는 Ctrl+Shift+R 필요할 수 있음.

localStorage에 `dashboardCache`, `personalStatsCache` 저장. 이슈 디버깅 시 `localStorage.clear()` 권장.

### 시간 처리
`getTodayStr()`는 **로컬(KST) 시간** 기준. `new Date().toISOString().split('T')[0]`은 UTC라 9시 이전엔 어제가 반환되므로 금지.

## 주요 UI 컴포넌트

- **대시보드 주간뷰**: `renderDailyTable` — 월~오늘, 각 셀은 `OOO/OO/O/-/X`. 멤버명 옆에는 직전 1시간 가중 스코어 ≥500K 인 사람만 🔥 표시 (`dashboardData.memberLastActivity` 사용). 기존 'auto' 텍스트 배지는 제거됨.
- **TOP 3 순위표**: `renderPodium` — `포인트 | 주간 토큰 | 월간 토큰` 3개 탭.
- **일간 사용량 차트**: `renderDailyTrendChart` — 최근 14일 수평 바. 스케일 60M 고정. 1M/10M/50M 3개 임계선 표시. 티어별 색상: 회색/파랑/초록/골드.
- **시간대별 사용량**: `renderHourlyChart` — 24시간 스택 바 (input/output/cc/cr 4개 세그먼트). 날짜 선택기는 raw 데이터가 있는 최신 날짜를 자동 선택.
- **탑 티어 vs 나 비교 차트**: `renderHourlyCompareChart` — 내 분석 탭. 24시간 페어 바, 노란 막대 = 주간 1위 사용자(`dashboardData.topUser`)의 hourly, 보라 막대 = 본인 raw 최신 hourly. 내가 1위면 비교 대상 없음 메시지.
- **월간 캘린더**: `renderMonthlyCalendar` — **내 분석 탭으로 이동됨** (구 대시보드 월간 뷰). 본인 데이터 우선 (`personalStatsData.daily`), 없으면 `dashboardData.usage` fallback.
- **게이지 바** (`stats-goal-fill`): 오늘 스코어를 50M 대비 진행률로 표시. 2%(1M)/20%(10M)/100%(50M) 위치에 마커.

### 대시보드 vs 내 분석 구분
- **대시보드 탭**: 타인/랭킹과의 비교. TOP3, 주간 표, 활동 피드.
- **내 분석 탭**: 개인 사용량 분석. 월간 캘린더, 일간 트렌드, 시간대별, 활동 패턴, 탑 티어 비교.
- 구 `view-tabs` (주간/월간 토글)는 제거됨.

## 배포 체크리스트

코드 변경 시:
1. `claude-challenge-auto`에서 편집·테스트 (프리뷰 서버: `.claude/launch.json`).
2. 프론트엔드 변경 시 캐시 버스터 버전 증가 (`v=20260409X` 다음 문자).
3. `git commit && git push` — GitHub Pages가 자동 재배포.
4. `AutoCode.gs` 변경 시: Apps Script 에디터에서 **새 배포 만들기** (배포 > 배포 관리 > 새 버전). URL은 유지됨.
5. `challenge-report.py` 변경 시: 각 멤버가 `git pull` 또는 파일 재다운로드 필요 (가이드 참고).

## 자주 발생한 이슈

| 증상 | 원인 | 해결 |
|------|------|------|
| 주간뷰 안 뜸 (TypeError: allTokens undefined) | `dailyMap`에 `allTokens` 초기값 누락 | 초기 객체에 `allTokens: 0` 추가 + tooltip safe access |
| 서버 포인트가 새 기준 미반영 | AutoCode.gs 재배포 안 됨 | Apps Script에서 새 버전 배포 |
| "오늘 토큰 0" | `toISOString()` UTC 사용 | `getTodayStr()` 로컬 시간으로 교체 |
| 인증기록 시간이 최초 제출 시각 유지 | `submittedAt` 갱신 누락 | `recordSheet.getRange(k+1, 6).setValue(now)` 추가 |
| 과거 score가 epoch ms (1.7e12) | Date 컬럼을 Number로 읽음 | `safeInt()` 적용 |
| 브라우저가 옛날 코드 서빙 | 캐시 | 캐시 버스터 bump + Ctrl+Shift+R + localStorage.clear() |

## 프리뷰 개발 서버

`.claude/launch.json`에 정의된 `challenge-site`:
```json
{ "name": "challenge-site", "runtimeExecutable": "python", "runtimeArgs": ["-m", "http.server", "8080"], "port": 8080 }
```
`mcp__Claude_Preview__preview_start` 로 실행. 로그인은 test 계정 사용 가능.

---

## 현재 상태 (2026-04-12 기준)

### 최근 주요 변경사항
- **🔥 활성 멤버 표시** — 주간 표 멤버명 옆 'auto' 텍스트 배지 → 🔥 이모지로 교체. 직전 1시간 가중 스코어 ≥500K 인 멤버만 표시 (`dashboardData.memberLastActivity` 신규 응답 필드 기반).
- **탑 티어 vs 나 비교 차트** — 내 분석 탭에 24시간 페어 바 차트 추가. 주간 1위 사용자의 hourly와 본인 hourly 비교. 서버는 `dashboardData.topUser = {nickname, weekScore, hourly}` 필드 신규 반환.
- **월간 캘린더 → 내 분석 탭으로 이동** — 구 대시보드 월간 뷰 제거. `view-tabs` (주간/월간 토글) 자체 삭제. 캘린더는 본인 daily 우선 사용.
- **AutoCode.gs handleDashboard 확장** — `사용량_raw` 시트 전체 순회하며 멤버별 최신 hourly 추출. 마지막 보고의 가장 최근 시간 버킷에서 가중 스코어를 계산해 `memberLastActivity[nick] = {hour, score, reportedAt}` 생성. 주간 1위 닉의 전체 hourly를 `topUser.hourly`로 응답.
- **50M=3pt 티어 추가** — `POINT_3_THRESHOLD = 50000000`. 주간뷰 `OOO`, 일간 차트 gold 티어, 게이지 바 50M 기준.
- **시간대별 차트 cache 가중치 반영** — `hourly` 데이터에 `cc`/`cr` 필드 추가. 4개 컴포넌트 스택 바 (`I×1 + O×5 + Cw×1.25 + Cr×0.1`).
- **`challenge-report.py` 업데이트** — Python 리포터가 hourly에 `cc`/`cr` 전송하도록 수정.
- **일간 차트 스케일 50M → 60M** — 50M(3pt) 라인이 우측 값 텍스트와 겹치는 문제 해결.
- **TOP 3 순위표 주간 토큰 탭 추가** — `포인트 / 주간 토큰 / 월간 토큰` 3개 뷰.
- **인증기록 `submittedAt` 갱신** — 재보고 시 최초 시각이 아닌 최신 시각으로 업데이트.
- **UTC→로컬 시간 버그 수정** — `getTodayStr()` 사용으로 KST 기준 "오늘 토큰" 정상 표시.
- **주간뷰 crash 수정** — `dailyMap` 초기 객체에 `allTokens: 0` 추가 (TypeError 해결).

### 보류 / 멤버 액션 필요
- **AutoCode.gs 재배포 필요** — Apps Script 에디터에서 새 배포 생성해야 서버 측 50M=3pt 기준 + submittedAt 갱신 적용됨.
- **멤버 PC `challenge-report.py` 업데이트 필요** — 가이드대로 새로 받거나 `git pull` 필요. 안 하면 hourly에 `cc`/`cr` 누락된 채로 계속 보고됨 (기존 데이터는 호환됨).
- **인증기록 시트 수동 보정** — 옛 임계값으로 잘못 부여된 포인트가 있을 수 있음 (필요 시 수동 조정).
- **`claude-challenge-site` 레포 archive 필요** — GitHub UI에서 Settings → Archive (그리고 GitHub Pages 비활성화 권장).

### 캐시 버스터 현재 버전
`v=20260412l` — 다음 변경 시 `m`으로 증가.
