# Claude Max 챌린지 프로젝트 가이드

친구들끼리 Claude Max 구독 사용량을 경쟁하는 랭킹 사이트.

## 저장소 구조

두 개의 Git 저장소가 쌍으로 운영됨:

| 저장소 | 역할 | 배포 |
|--------|------|------|
| `claude-challenge-site` | GitHub Pages 프론트엔드 | https://minjunecode.github.io/claude-challenge-site |
| `claude-challenge-auto` | 리포터 스크립트 + Apps Script 원본 | — |

두 레포 모두 `app.js`, `index.html`, `style.css`를 갖고 있으며 **항상 동기화**해야 함. `claude-challenge-site`를 편집한 뒤 `cp`로 `claude-challenge-auto`에 복사하고 양쪽 모두 커밋·푸시.

## 주요 파일

### 프론트엔드 (`claude-challenge-site`)
- `app.js` — 모든 렌더링 로직. 대시보드, 내 분석, 인증 탭.
- `index.html` — 단일 페이지. 캐시 버스터 `v=20260409k` 형식으로 관리.
- `style.css` — 스타일 전체.
- `setup-guide.html` — 자동 리포팅 설정 가이드 (멤버 배포용).
- `diagram.html`, `about.html` — 부가 페이지.

### 서버 (`claude-challenge-auto`)
- `AutoCode.gs` — Google Apps Script 원본. 실제 운영 코드는 Apps Script 에디터에서 **수동 재배포** 필요. 깃에 있는 파일은 소스 백업용.
- `challenge-report.py` — 멤버 PC에서 1시간마다 실행되는 리포터. Claude Code의 `~/.claude/projects/**/*.jsonl`을 파싱해 토큰 수를 집계한 뒤 Apps Script 엔드포인트로 POST.

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

- **대시보드 주간뷰**: `renderDailyTable` — 월~오늘, 각 셀은 `OOO/OO/O/-/X`.
- **TOP 3 순위표**: `renderPodium` — `포인트 | 주간 토큰 | 월간 토큰` 3개 탭.
- **일간 사용량 차트**: `renderDailyTrendChart` — 최근 14일 수평 바. 스케일 60M 고정. 1M/10M/50M 3개 임계선 표시. 티어별 색상: 회색/파랑/초록/골드.
- **시간대별 사용량**: `renderHourlyChart` — 24시간 스택 바 (input/output/cc/cr 4개 세그먼트). 날짜 선택기는 raw 데이터가 있는 최신 날짜를 자동 선택.
- **게이지 바** (`stats-goal-fill`): 오늘 스코어를 50M 대비 진행률로 표시. 2%(1M)/20%(10M)/100%(50M) 위치에 마커.

## 배포 체크리스트

코드 변경 시:
1. `claude-challenge-site`에서 편집·테스트 (프리뷰 서버: `launch.json`의 `challenge-site`).
2. 캐시 버스터 버전 증가 (`v=20260409X` 다음 문자).
3. `cp app.js style.css index.html ../claude-challenge-auto/` 로 동기화.
4. 양쪽 레포에 커밋·푸시.
5. `AutoCode.gs` 변경 시: Apps Script 에디터에서 **새 배포 만들기** (배포 > 배포 관리 > 새 버전). URL은 유지됨.
6. `challenge-report.py` 변경 시: 각 멤버가 `git pull` 또는 파일 재다운로드 필요 (가이드 참고).

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

## 현재 상태 (2026-05-10 기준)

### 평가 (VC IR 시뮬레이션) 탭 — 앵커 기반 평가 시스템 (BETA)

**아키텍처 3단 파이프라인** (AutoCode.gs):
1. **Phase 0** — `extractFeatures_`: LLM이 프로젝트를 5차원 enum으로 분류 (temp 0.0)
   - service_type / monetization / target_market / tech_complexity / validation_stage
   - `평가` 시트의 `featuresJson` 컬럼(W, index 22)에 저장
2. **Phase 1** — VC 3개 후속 질문 생성 (각 VC 1개씩, temp 0.7)
3. **Phase 2** — 앵커 기반 평가 (temp 0.3, 일관성)
   - `BOOTSTRAP_ANCHORS_` (6개 정밀 캘리브레이션, 1만원~2억원 스펙트럼)
   - 챌린지 내 같은 service_type 완료 평가 상위 3개 (자가 강화)
   - 프롬프트가 "앵커 대비 ±X% 위치 결정" 강제, 동일 KRW 부여 금지

**주요 함수**:
- `extractFeatures_`, `getRelevantAnchors_`, `scoreFeatureSimilarity_`, `formatAnchorsForPrompt_`
- `callAnthropic_(systemPrompt, userPrompt, maxTokens, temperature)` — 4번째 인자로 temp 제어

**상수**: `BOOTSTRAP_ANCHORS_` (배열, 6개) — 신규 카테고리 등장 시 admin이 추가 가능.

**Rate limit**: 주 1회 (`EVAL_WEEKLY_LIMIT_`).

### 최근 주요 변경사항
- **앵커 기반 평가 시스템 도입** — 위 참조. 평가 휘발성 해결: 같은 프로젝트 → 비슷한 결과 (앵커 + temp 0.3), 다른 프로젝트 → 차별화된 결과 (동일 KRW 금지 규칙).
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

### 캐시 버스터 현재 버전
`v=20260409k` — 다음 변경 시 `l`로 증가.
