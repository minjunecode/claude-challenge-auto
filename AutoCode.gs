// ============================================
// Claude Max 챌린지 - Google Apps Script
// Hook 기반 자동 사용량 수집 (OAuth 불필요)
// v2.0: Claude + Codex 다중 서비스 지원
// ============================================

// ── 가격 가중치 (v2.0) ──
// 기준 단가: Claude Sonnet 4 input $3/1M = 가중치 1.0
// Claude Sonnet: I=$3 / O=$15 / Cw=$3.75 / Cr=$0.30 per 1M
// Codex (GPT-5.4):  I=$2.50 / O=$15 / Cr=$0.25 per 1M
// 가중치 = price / 3.0
var W_CL_IN = 1.0;        // Claude input
var W_CL_OUT = 5.0;       // Claude output
var W_CL_CW = 1.25;       // Claude cache write
var W_CL_CR = 0.1;        // Claude cache read
var W_CX_IN = 0.8333;     // Codex input  ($2.50 / $3)
var W_CX_OUT = 5.0;       // Codex output ($15 / $3)
var W_CX_CR = 0.0833;     // Codex cache read ($0.25 / $3)

/** v2 통합 가중 스코어. 객체가 claude_ / codex_ 필드를 가지면 사용, 없으면 구 필드로 fallback */
function calcScoreV2_(t) {
  var clIn  = safeInt(t.claude_input_tokens != null ? t.claude_input_tokens : t.input_tokens);
  var clOut = safeInt(t.claude_output_tokens != null ? t.claude_output_tokens : t.output_tokens);
  var clCw  = safeInt(t.claude_cache_creation_tokens != null ? t.claude_cache_creation_tokens : t.cache_creation_tokens);
  var clCr  = safeInt(t.claude_cache_read_tokens != null ? t.claude_cache_read_tokens : t.cache_read_tokens);
  var cxIn  = safeInt(t.codex_input_tokens);
  var cxOut = safeInt(t.codex_output_tokens);
  var cxCr  = safeInt(t.codex_cache_read_tokens);
  return Math.round(
    clIn * W_CL_IN + clOut * W_CL_OUT + clCw * W_CL_CW + clCr * W_CL_CR +
    cxIn * W_CX_IN + cxOut * W_CX_OUT + cxCr * W_CX_CR
  );
}

/** hourly bucket 하나의 가중 스코어. 신형(cl/cx) + 구형(in/out/cc/cr) 모두 처리 */
function calcBucketScoreV2_(b) {
  if (!b) return 0;
  var cl = b.cl || { in: b.in || 0, out: b.out || 0, cc: b.cc || 0, cr: b.cr || 0 };
  var cx = b.cx || { in: 0, out: 0, cr: 0 };
  return Math.round(
    (cl.in || 0) * W_CL_IN + (cl.out || 0) * W_CL_OUT + (cl.cc || 0) * W_CL_CW + (cl.cr || 0) * W_CL_CR +
    (cx.in || 0) * W_CX_IN + (cx.out || 0) * W_CX_OUT + (cx.cr || 0) * W_CX_CR
  );
}

// ── 리그 설정 ──
// 리그 시스템 시작일: 이 날짜 이전 기록은 구 기준(1M/10M/50M) 사용
var LEAGUE_ERA_START = '2026-04-17';
var LEAGUE_1M = '1M';
var LEAGUE_10M = '10M';
// 리그별 포인트 임계값 [1pt, 2pt, 3pt]
var LEAGUE_THRESHOLDS = {
  '1M':  [1000000,  10000000, 25000000],   // 1M / 10M / 25M
  '10M': [10000000, 50000000, 100000000]   // 10M / 50M / 100M
};
// 구 기준 (LEAGUE_ERA_START 이전 기록에 사용)
var LEGACY_THRESHOLDS = [1000000, 10000000, 50000000];

// 리그별 획득 포인트 계산
function calcPointsForLeague_(score, league) {
  var t = LEAGUE_THRESHOLDS[league] || LEAGUE_THRESHOLDS['1M'];
  if (score >= t[2]) return 3;
  if (score >= t[1]) return 2;
  if (score >= t[0]) return 1;
  return 0;
}
// 구 기준 포인트 (LEAGUE_ERA_START 이전)
function calcPointsLegacy_(score) {
  if (score >= LEGACY_THRESHOLDS[2]) return 3;
  if (score >= LEGACY_THRESHOLDS[1]) return 2;
  if (score >= LEGACY_THRESHOLDS[0]) return 1;
  return 0;
}

/** 어떤 형태의 값이든 "YYYY-MM-DD"로 변환 */
function toDateStr(v) {
  if (!v) return '';
  // 1) Utilities.formatDate 시도 (Date 객체)
  try {
    var s = Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
    if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  } catch(e) {}
  // 2) 문자열에서 YYYY-MM-DD 추출
  var str = String(v);
  var m = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  // 3) "Wed Apr 08 2026..." 형식 파싱
  try {
    var d = new Date(str);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
  } catch(e) {}
  return str;
}

/** 어떤 형태의 값이든 "YYYY-MM-DD HH:mm:ss"로 변환 */
function toDateTimeStr(v) {
  if (!v) return '';
  try {
    var s = Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    if (s && s.length >= 19) return s;
  } catch(e) {}
  var str = String(v);
  var m = str.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  if (m) return m[0];
  try {
    var d = new Date(str);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  } catch(e) {}
  return str;
}

/**
 * 시트 헤더 마이그레이션: 구형 → 신형 자동 전환
 * 구형 데이터는 컬럼 위치가 맞지 않으므로 삭제 후 재수집 유도
 */
function migrateSheetIfNeeded_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── 멤버 시트: league(E), participating(F), deposit(G) 컬럼 보장 ──
  var memSheet = ss.getSheetByName('멤버');
  if (memSheet && memSheet.getLastRow() >= 1) {
    var memLastCol = memSheet.getLastColumn();
    // E열: league
    if (memLastCol < 5) {
      memSheet.getRange(1, 5).setValue('league');
    } else {
      var eHeader = String(memSheet.getRange(1, 5).getValue() || '').toLowerCase();
      if (eHeader !== 'league') memSheet.getRange(1, 5).setValue('league');
    }
    // F열: participating ('참여 중' / '참여 안 함')
    if (memSheet.getLastColumn() < 6) {
      memSheet.getRange(1, 6).setValue('participating');
    } else {
      var fHeader = String(memSheet.getRange(1, 6).getValue() || '').toLowerCase();
      if (fHeader !== 'participating') memSheet.getRange(1, 6).setValue('participating');
    }
    // G열: deposit (잔여 보증금, 원)
    if (memSheet.getLastColumn() < 7) {
      memSheet.getRange(1, 7).setValue('deposit');
    } else {
      var gHeader = String(memSheet.getRange(1, 7).getValue() || '').toLowerCase();
      if (gHeader !== 'deposit') memSheet.getRange(1, 7).setValue('deposit');
    }
    // 기존 멤버의 기본값 채우기 (league='1M', participating='참여 중', deposit=50000)
    if (memSheet.getLastRow() > 1) {
      var memRange = memSheet.getRange(2, 5, memSheet.getLastRow() - 1, 3);  // E, F, G
      var memVals = memRange.getValues();
      var changed = false;
      for (var mi = 0; mi < memVals.length; mi++) {
        if (!memVals[mi][0] || String(memVals[mi][0]).trim() === '') {
          memVals[mi][0] = LEAGUE_1M; changed = true;
        }
        if (!memVals[mi][1] || String(memVals[mi][1]).trim() === '') {
          memVals[mi][1] = '참여 중'; changed = true;
        }
        if (memVals[mi][2] === '' || memVals[mi][2] === null || memVals[mi][2] === undefined) {
          memVals[mi][2] = 50000; changed = true;
        }
      }
      if (changed) memRange.setValues(memVals);
    }
  }

  // ── 인증기록 시트: league 컬럼(J=10) 보장 ──
  var recSheet = ss.getSheetByName('인증기록');
  if (recSheet && recSheet.getLastRow() >= 1) {
    var recLastCol = recSheet.getLastColumn();
    if (recLastCol < 10) {
      recSheet.getRange(1, 10).setValue('league');
    } else {
      var jHeader = String(recSheet.getRange(1, 10).getValue() || '').toLowerCase();
      if (jHeader !== 'league') recSheet.getRange(1, 10).setValue('league');
    }
  }

  // ── 리그이동기록 시트: 없으면 생성 ──
  var leagueLogSheet = ss.getSheetByName('리그이동기록');
  if (!leagueLogSheet) {
    leagueLogSheet = ss.insertSheet('리그이동기록');
    leagueLogSheet.appendRow(['timestamp', 'nickname', 'fromLeague', 'toLeague', 'reason']);
  }

  // ── 사용량 시트: 구형(7열) → v1(9열) → v2(12열) → v2+machine_id(13열) ──
  var usageSheet = ss.getSheetByName('사용량');
  if (usageSheet) {
    var uHeaders = usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn()).getValues()[0];
    var uHeaderStr = uHeaders.join(',');
    var uIsV2 = uHeaderStr.indexOf('claude_input_tokens') >= 0;
    var uIsV1 = !uIsV2 && uHeaderStr.indexOf('cache_creation_tokens') >= 0;

    if (uIsV2) {
      // 이미 v2: machine_id 컬럼(M=13)만 보장
      ensureMachineIdColumn_(usageSheet, 13);
    } else if (uIsV1) {
      migrateUsageV1ToV2_(usageSheet, false);
      ensureMachineIdColumn_(usageSheet, 13);
    } else if (uHeaderStr.indexOf('cache_creation_tokens') < 0 && uHeaderStr.indexOf('score') < 0) {
      usageSheet.clear();
      usageSheet.appendRow(USAGE_V2_HEADERS_);
    }
  }

  // ── 사용량_raw 시트: machine_id는 M열(13), hourly는 N열(14) ──
  var rawSheet = ss.getSheetByName('사용량_raw');
  if (rawSheet) {
    var rHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];
    var rHeaderStr = rHeaders.join(',');
    var rIsV2 = rHeaderStr.indexOf('claude_input_tokens') >= 0;
    var rIsV1 = !rIsV2 && rHeaderStr.indexOf('cache_creation_tokens') >= 0;

    if (rIsV2) {
      ensureMachineIdColumnRaw_(rawSheet);
    } else if (rIsV1) {
      migrateUsageV1ToV2_(rawSheet, true);
      ensureMachineIdColumnRaw_(rawSheet);
    } else if (rHeaderStr.indexOf('cache_creation_tokens') < 0 && rHeaderStr.indexOf('score') < 0) {
      rawSheet.clear();
      rawSheet.appendRow(RAW_V2_HEADERS_);
    }
  }
}

/**
 * 사용량 시트에 machine_id 컬럼 보장. 기존 행은 LEGACY_MACHINE_ID로 채움.
 * col = 13 (사용량 시트 기준 M열)
 */
function ensureMachineIdColumn_(sheet, col) {
  if (sheet.getLastColumn() < col) {
    sheet.getRange(1, col).setValue('machine_id');
  } else {
    var h = String(sheet.getRange(1, col).getValue() || '').trim();
    if (h !== 'machine_id') sheet.getRange(1, col).setValue('machine_id');
  }
  // 기존 행: machine_id 값이 비어있으면 'legacy' 채우기
  if (sheet.getLastRow() > 1) {
    var range = sheet.getRange(2, col, sheet.getLastRow() - 1, 1);
    var vals = range.getValues();
    var changed = false;
    for (var i = 0; i < vals.length; i++) {
      if (!vals[i][0] || String(vals[i][0]).trim() === '') {
        vals[i][0] = LEGACY_MACHINE_ID;
        changed = true;
      }
    }
    if (changed) range.setValues(vals);
  }
}

/**
 * 사용량_raw 시트: hourly가 이미 M열에 있을 수 있음.
 * machine_id(M=13) + hourly(N=14) 배치로 마이그레이션.
 * 기존: ..., reportedAt(L=12), hourly(M=13) → ..., reportedAt(L=12), machine_id(M=13), hourly(N=14)
 */
function ensureMachineIdColumnRaw_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var hasMachine = false, hasHourly = false, hourlyCol = -1;
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim();
    if (h === 'machine_id') hasMachine = true;
    if (h === 'hourly') { hasHourly = true; hourlyCol = i + 1; }
  }
  if (hasMachine) return;  // 이미 처리됨

  // hourly가 M열(13)에 있으면 N열(14)로 이동 후 M열에 machine_id 삽입
  if (hasHourly && hourlyCol === 13 && sheet.getLastRow() >= 1) {
    var lastRow = sheet.getLastRow();
    // 1) M열 전체(13) 값을 읽음 (기존 hourly)
    var hourlyVals = sheet.getRange(1, 13, lastRow, 1).getValues();
    // 2) N열(14)에 기존 hourly 값 작성
    sheet.getRange(1, 14, lastRow, 1).setValues(hourlyVals);
    // 3) M열(13) 헤더를 machine_id로, 데이터 행은 legacy 로 채움
    sheet.getRange(1, 13).setValue('machine_id');
    if (lastRow > 1) {
      var legacyVals = [];
      for (var r = 0; r < lastRow - 1; r++) legacyVals.push([LEGACY_MACHINE_ID]);
      sheet.getRange(2, 13, lastRow - 1, 1).setValues(legacyVals);
    }
  } else if (!hasHourly) {
    // hourly도 없으면 M열에 machine_id만 추가
    ensureMachineIdColumn_(sheet, 13);
  } else {
    // hourly가 다른 위치에 있는 예외적 케이스: M열만 기본 채움
    ensureMachineIdColumn_(sheet, 13);
  }
}

// v2 컬럼 헤더
// v2 헤더 (machine_id는 13번째 컬럼 = M열). 2026-04-20: 여러 PC 합산 지원.
// - 사용량 시트: 13컬럼 (hourly 없음)
// - 사용량_raw 시트: 14컬럼 (hourly는 맨 끝)
// machine_id가 비어있는 (레거시) 행은 합산 시 배제 규칙 적용.
var USAGE_V2_HEADERS_ = [
  'nickname', 'date',
  'claude_input_tokens', 'claude_output_tokens', 'claude_cache_creation_tokens', 'claude_cache_read_tokens',
  'codex_input_tokens', 'codex_output_tokens', 'codex_cache_read_tokens',
  'score', 'sessions', 'reportedAt', 'machine_id'
];
var RAW_V2_HEADERS_ = USAGE_V2_HEADERS_.concat(['hourly']);  // raw: hourly가 맨 끝(14번째)
var LEGACY_MACHINE_ID = 'legacy';  // machine_id 없는 구 보고 표시

/**
 * 같은 (nickname, date) 그룹의 PC 행들에서 "집계에 사용할 행 집합"을 결정.
 * 정책: max(legacy 합, machine 합).
 *   - 모두 legacy: legacy 반환 (구 py 유지자 보호)
 *   - 모두 machine: machine 반환 (정상 합산)
 *   - 혼재: score 합이 큰 쪽 선택 (구→신 전환 중이어도 기존 값 보존)
 * 혼재 상황에서 작은 쪽이 일시적으로 숨겨지지만, 모든 PC가 전환 완료되면
 * machine 합이 legacy를 초과하며 자연스럽게 machine 쪽으로 넘어감.
 */
function pickActiveRows_(rows) {
  if (!rows || !rows.length) return [];
  var legacy = [], machine = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.mid === LEGACY_MACHINE_ID) legacy.push(r);
    else machine.push(r);
  }
  if (!legacy.length) return machine;
  if (!machine.length) return legacy;
  var sumL = 0, sumM = 0;
  legacy.forEach(function(r){ sumL += (r.score || 0); });
  machine.forEach(function(r){ sumM += (r.score || 0); });
  return sumL >= sumM ? legacy : machine;
}

/**
 * 사용량/사용량_raw 시트 v1 → v2 in-place 마이그레이션.
 * v1: nickname, date, input, output, cache_creation, cache_read, score, sessions, reportedAt, [hourly]
 * v2: nickname, date, claude_input, claude_output, claude_cc, claude_cr, codex_input, codex_output, codex_cr, score, sessions, reportedAt, [hourly]
 * 기존 Claude 토큰은 claude_* 필드로, codex_* 는 모두 0으로.
 * hourly JSON도 {cl: {...}, cx: {in:0,out:0,cr:0}} 형태로 변환.
 */
function migrateUsageV1ToV2_(sheet, isRaw) {
  var rows = sheet.getDataRange().getValues();
  var newHeaders = isRaw ? RAW_V2_HEADERS_ : USAGE_V2_HEADERS_;
  var newRows = [newHeaders];

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;  // 빈 행 skip
    var nick = r[0];
    var dateStr = toDateStr(r[1]);
    var clIn = safeInt(r[2]);
    var clOut = safeInt(r[3]);
    var clCw = safeInt(r[4]);
    var clCr = safeInt(r[5]);
    var oldScore = safeInt(r[6]);
    var sess = safeInt(r[7]);
    var repAt = toDateTimeStr(r[8]);
    // v2 score 재계산 (codex=0이므로 Claude만)
    var newScore = calcScoreV2_({
      claude_input_tokens: clIn, claude_output_tokens: clOut,
      claude_cache_creation_tokens: clCw, claude_cache_read_tokens: clCr
    });
    var row = [nick, "'" + dateStr, clIn, clOut, clCw, clCr, 0, 0, 0, newScore, sess, repAt];

    if (isRaw) {
      // hourly JSON 변환: {h, in, out, cc, cr} → {h, cl: {in, out, cc, cr}, cx: {in:0, out:0, cr:0}}
      var hourlyStr = r[9] || '';
      var newHourlyStr = '';
      if (hourlyStr) {
        try {
          var parsed = JSON.parse(hourlyStr);
          if (Array.isArray(parsed)) {
            var converted = parsed.map(function(b) {
              // 이미 v2 형식이면 그대로
              if (b && b.cl) return b;
              return {
                h: b.h,
                cl: { in: b.in || 0, out: b.out || 0, cc: b.cc || 0, cr: b.cr || 0 },
                cx: { in: 0, out: 0, cr: 0 }
              };
            });
            newHourlyStr = JSON.stringify(converted);
          }
        } catch (e) { newHourlyStr = hourlyStr; }  // 파싱 실패 시 원본 보존
      }
      row.push(newHourlyStr);
    }
    newRows.push(row);
  }

  sheet.clear();
  sheet.getRange(1, 1, newRows.length, newHeaders.length).setValues(newRows);
}

// ============================================
// 공개 마이그레이션 래퍼 (Apps Script 에디터에서 실행용)
// ============================================

/**
 * [드라이런] 현재 시트 상태를 점검만 하고 변경하지 않음.
 * Apps Script 에디터 → 함수 드롭다운 → dryRunMigration → ▶ 실행
 * 실행 로그에 각 시트의 현재 버전과 행 수가 찍힘.
 */
function dryRunMigration() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var targets = ['사용량', '사용량_raw'];
  var lines = ['=== 드라이런: 마이그레이션 대상 점검 ==='];

  for (var i = 0; i < targets.length; i++) {
    var name = targets[i];
    var sh = ss.getSheetByName(name);
    if (!sh) { lines.push('[' + name + '] 시트 없음'); continue; }
    var lastCol = sh.getLastColumn();
    var lastRow = sh.getLastRow();
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].join(',');
    var isV2 = headers.indexOf('claude_input_tokens') >= 0;
    var isV1 = !isV2 && headers.indexOf('cache_creation_tokens') >= 0;
    var version = isV2 ? 'v2 (마이그 불필요)' : (isV1 ? 'v1 (v2로 변환 예정)' : '구형 또는 빈 시트 (초기화 예정)');
    lines.push('[' + name + '] 버전=' + version + ' / 행=' + lastRow + ' / 열=' + lastCol);
    lines.push('  헤더: ' + headers);
  }

  // 멤버 시트 리그 컬럼 점검
  var mem = ss.getSheetByName('멤버');
  if (mem) {
    var mLastCol = mem.getLastColumn();
    var mLastRow = mem.getLastRow();
    var eHeader = mLastCol >= 5 ? String(mem.getRange(1, 5).getValue() || '') : '(없음)';
    lines.push('[멤버] 행=' + mLastRow + ' / E열 헤더="' + eHeader + '" (league 여야 함)');
  }

  // 인증기록 시트 league 컬럼 점검
  var rec = ss.getSheetByName('인증기록');
  if (rec) {
    var rLastCol = rec.getLastColumn();
    var rLastRow = rec.getLastRow();
    var jHeader = rLastCol >= 10 ? String(rec.getRange(1, 10).getValue() || '') : '(없음)';
    lines.push('[인증기록] 행=' + rLastRow + ' / J열 헤더="' + jHeader + '" (league 여야 함)');
  }

  var msg = lines.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * [백업+마이그레이션] 사용량/사용량_raw 시트를 복사해 백업한 뒤 v2로 변환.
 * 백업 이름: "사용량_backup_YYYYMMDD_HHMMSS" 등.
 * Apps Script 에디터 → 함수 드롭다운 → migrateWithBackup → ▶ 실행
 */
function migrateWithBackup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ts = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd_HHmmss');
  var backedUp = [];
  var targets = ['사용량', '사용량_raw'];

  for (var i = 0; i < targets.length; i++) {
    var name = targets[i];
    var src = ss.getSheetByName(name);
    if (!src) continue;
    // 이미 v2인 시트는 백업 스킵 (의미 없음)
    var headers = src.getRange(1, 1, 1, src.getLastColumn()).getValues()[0].join(',');
    if (headers.indexOf('claude_input_tokens') >= 0) {
      Logger.log('[' + name + '] 이미 v2 — 백업 스킵');
      continue;
    }
    var copy = src.copyTo(ss);
    var backupName = name + '_backup_' + ts;
    copy.setName(backupName);
    backedUp.push(backupName);
    Logger.log('[' + name + '] 백업 완료 → ' + backupName);
  }

  // 실제 마이그레이션
  migrateSheetIfNeeded_();

  var doneMsg = '=== 마이그레이션 완료 ===\n백업 시트: ' + (backedUp.length > 0 ? backedUp.join(', ') : '(없음, 이미 v2)');
  Logger.log(doneMsg);
  return doneMsg;
}

/**
 * [백업 없이 마이그레이션] 위험. 먼저 dryRunMigration + migrateWithBackup 권장.
 */
function migrateNow() {
  migrateSheetIfNeeded_();
  var msg = '마이그레이션 완료 (백업 없이 실행됨)';
  Logger.log(msg);
  return msg;
}

/** 셀 값을 안전한 정수로 변환 (Date 객체 → 0, 문자열 → 0) */
function safeInt(v) {
  if (!v) return 0;
  if (v instanceof Date) return 0;
  var n = Number(v);
  if (isNaN(n) || n > 10000000000) return 0; // 10B 초과 = 비정상 (epoch 등)
  return Math.round(n);
}

// 시트 셀(Date 객체 / 'YYYY-MM-DD' / ISO 문자열 / epoch ms)을 ms epoch로 정규화.
// 시간 윈도우 비교용. 실패하면 0 반환 → 윈도우 필터를 skip.
function _toEpochMs_(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  var s = String(v).trim();
  if (!s) return 0;
  // 순수 숫자 (epoch ms 또는 일련번호 — 일련번호는 일반적으로 < 60000)
  var n = Number(s);
  if (!isNaN(n) && n > 1e11) return n;  // 1973년 이후 epoch ms로 가정
  // 'YYYY-MM-DD' 또는 ISO
  if (s.length >= 10) {
    var iso = s.length === 10 ? (s + 'T00:00:00') : s;
    var d = new Date(iso);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return 0;
}

function doGet(e) { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

// 데이터 쓰기 액션 — 성공 시 대시보드 캐시 무효화 대상.
var MUTATION_ACTIONS_ = {
  'reportUsage': 1, 'upload': 1, 'register': 1, 'init': 1,
  'addMember': 1, 'deleteMember': 1, 'setColor': 1,
  'evalStart': 1, 'evalSubmit': 1, 'evalDiscard': 1
};

function handleRequest(e) {
  var params;
  try {
    params = JSON.parse(e.postData ? e.postData.contents : '{}');
  } catch (err) {
    params = e.parameter || {};
  }

  var action = params.action || (e.parameter && e.parameter.action) || '';
  var result;

  switch (action) {
    case 'login':        result = handleLogin(params); break;
    case 'register':     result = handleRegister(params); break;
    case 'init':         result = handleInit(params); break;
    case 'dashboard':    result = handleDashboard(params); break;
    case 'reportUsage':  result = handleReportUsage(params); break;
    case 'upload':       result = handleUpload(params); break;
    case 'addMember':    result = handleAddMember(params); break;
    case 'deleteMember': result = handleDeleteMember(params); break;
    case 'setColor':     result = handleSetColor(params); break;
    case 'personalStats': result = handlePersonalStats(params); break;
    case 'evalStart':    result = handleEvalStart(params); break;
    case 'evalSubmit':   result = handleEvalSubmit(params); break;
    case 'evalFeed':     result = handleEvalFeed(params); break;
    case 'evalStatus':   result = handleEvalStatus(params); break;
    case 'evalDiscard':  result = handleEvalDiscard(params); break;
    default: result = { success: false, error: '알 수 없는 action: ' + action };
  }

  // 쓰기 액션이 성공했으면 대시보드 캐시 무효화 (모든 사용자 대상)
  if (MUTATION_ACTIONS_[action] && result && result.success) {
    try { invalidateDashboardCache_(); } catch (e) {}
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── 대시보드 응답 캐시 (Apps Script CacheService, 30s TTL + 버전 기반 무효화) ──
// 키는 사용자별 (myEvalThisWeek 등 user-specific 필드 포함).
// 쓰기 액션 발생 시 'dashboard:version'을 갱신 → 모든 캐시된 응답이 stale 판정됨.
var DASHBOARD_CACHE_TTL_SEC_ = 30;

function _dashboardCacheKey_(nickname) {
  return 'dashboard:' + (nickname || '_anon');
}

function getCachedDashboard_(nickname) {
  try {
    var cache = CacheService.getScriptCache();
    var raw = cache.get(_dashboardCacheKey_(nickname));
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    var curVer = cache.get('dashboard:version') || '0';
    if (String(parsed.version) !== String(curVer)) return null;
    return parsed.data;
  } catch (err) { return null; }
}

function putCachedDashboard_(nickname, data) {
  try {
    var cache = CacheService.getScriptCache();
    var curVer = cache.get('dashboard:version') || '0';
    var payload = JSON.stringify({ version: curVer, data: data });
    // CacheService 한도: value 100KB. 초과 시 silently throw → 캐싱 포기.
    if (payload.length > 95000) return;
    cache.put(_dashboardCacheKey_(nickname), payload, DASHBOARD_CACHE_TTL_SEC_);
  } catch (err) {}
}

function invalidateDashboardCache_() {
  try {
    CacheService.getScriptCache().put('dashboard:version', String(Date.now()), 3600);
  } catch (err) {}
}

// 비밀번호를 멤버 시트에 안전하게 저장.
// Sheets는 순수 숫자 문자열을 자동으로 Number로 변환해 leading zero("01234"→1234),
// trailing decimal("12.50"→12.5), 16+자리 정밀도를 손실시킨다.
// 비밀번호 셀을 텍스트 포맷(@)으로 강제해 원문 그대로 저장한다.
function writeMemberRow_(sheet, nickname, password, isAdmin) {
  sheet.appendRow([nickname, '', isAdmin, '', LEAGUE_1M, '참여 중', 50000]);
  var newRow = sheet.getLastRow();
  sheet.getRange(newRow, 2).setNumberFormat('@').setValue(password);
}

// 1회용 마이그레이션: 기존 멤버 시트의 비밀번호 컬럼을 텍스트 포맷으로 잠금.
// 이미 숫자로 손상된(leading zero 잃은) 값은 복구 불가지만, 이후 재저장으로 인한
// 추가 손상을 방지한다. Apps Script 에디터에서 수동 1회 실행.
function migrateMemberPasswordsToText() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('멤버');
  if (!sheet) return 'no member sheet';
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 'no rows';
  var range = sheet.getRange(2, 2, lastRow - 1, 1);
  var values = range.getValues().map(function(r) { return [String(r[0])]; });
  range.setNumberFormat('@');
  range.setValues(values);
  return 'migrated ' + (lastRow - 1) + ' rows';
}

// ── 로그인 (dashboard + personalStats 통합 응답) ──
function handleLogin(params) {
  var nickname = (params.nickname || '').trim();
  var password = String(params.password || '').trim();
  if (!nickname || !password) return { success: false, error: '닉네임과 비밀번호를 입력하세요.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('멤버');
  if (!sheet) return { success: false, error: '"멤버" 시트를 찾을 수 없습니다.' };

  var data = sheet.getDataRange().getValues();
  var loginSuccess = false;
  var loginIsAdmin = false;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === nickname && String(data[i][1]).trim() === password) {
      loginSuccess = true;
      loginIsAdmin = data[i][2] === true || data[i][2] === 'TRUE';
      break;
    }
  }
  if (!loginSuccess) return { success: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };

  // 로그인 성공 → dashboard 데이터를 함께 반환 (API 1회로 통합)
  var dashResult = handleDashboard(params);
  var hasAutoReport = checkHasAutoReport(nickname);

  return {
    success: true,
    nickname: nickname,
    isAdmin: loginIsAdmin,
    hasAutoReport: hasAutoReport,
    dashboard: dashResult
  };
}

function handleRegister(params) {
  var nickname = (params.nickname || '').trim();
  var password = String(params.password || '').trim();
  if (!nickname || !password) return { success: false, error: '닉네임과 비밀번호를 입력하세요.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('멤버');
  if (!sheet) return { success: false, error: '초기 설정이 필요합니다.' };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === nickname) return { success: false, error: '이미 존재하는 닉네임입니다.' };
  }
  writeMemberRow_(sheet, nickname, password, false);
  return { success: true };
}

function handleInit(params) {
  var nickname = (params.nickname || '').trim();
  var password = String(params.password || '').trim();
  if (!nickname || !password) return { success: false, error: '닉네임과 비밀번호를 입력하세요.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var memberSheet = ss.getSheetByName('멤버');
  if (!memberSheet) {
    memberSheet = ss.insertSheet('멤버');
    memberSheet.appendRow(['nickname', 'password', 'isAdmin', 'color', 'league', 'participating', 'deposit']);
  }
  if (memberSheet.getLastRow() > 1) return { success: false, error: '이미 초기화되어 있습니다.' };
  writeMemberRow_(memberSheet, nickname, password, true);

  var recordSheet = ss.getSheetByName('인증기록');
  if (!recordSheet) {
    recordSheet = ss.insertSheet('인증기록');
    recordSheet.appendRow(['nickname', 'week', 'year', 'type', 'points', 'submittedAt', 'source', 'tokens', 'resetsAt', 'league']);
  }

  var leagueLogSheet = ss.getSheetByName('리그이동기록');
  if (!leagueLogSheet) {
    leagueLogSheet = ss.insertSheet('리그이동기록');
    leagueLogSheet.appendRow(['timestamp', 'nickname', 'fromLeague', 'toLeague', 'reason']);
  }

  var usageSheet = ss.getSheetByName('사용량');
  if (!usageSheet) {
    usageSheet = ss.insertSheet('사용량');
    usageSheet.appendRow(USAGE_V2_HEADERS_);
  }

  var rawSheet = ss.getSheetByName('사용량_raw');
  if (!rawSheet) {
    rawSheet = ss.insertSheet('사용량_raw');
    rawSheet.appendRow(RAW_V2_HEADERS_);
  }

  getEvalSheet_();  // 평가 시트 lazy 생성

  return { success: true, message: '초기 설정 완료!' };
}

// ── 대시보드 ──
function handleDashboard(params) {
  // 요청자 식별 (myEvalThisWeek 등 본인 전용 필드 계산용)
  var nickname = (params && params.nickname) ? String(params.nickname).trim() : '';

  // 캐시 hit이면 즉시 반환 (30s TTL + 버전 무효화)
  var cached = getCachedDashboard_(nickname);
  if (cached) return cached;

  // 구형 시트 자동 마이그레이션 (1회성)
  migrateSheetIfNeeded_();

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var memberSheet = ss.getSheetByName('멤버');
  if (!memberSheet) return { success: false, error: '"멤버" 시트를 찾을 수 없습니다.' };

  var memberData = memberSheet.getDataRange().getValues();
  var members = [];
  var memberColors = {};
  var memberLeagues = {};
  for (var i = 1; i < memberData.length; i++) {
    if (memberData[i][0]) {
      var mLeague = String(memberData[i][4] || '').trim() || LEAGUE_1M;
      if (mLeague !== LEAGUE_1M && mLeague !== LEAGUE_10M) mLeague = LEAGUE_1M;
      // F열: 참여 여부 원본값을 그대로 전달 (프론트에서 '참여 중' / '참여 안 함' / '주간 면제' 판정)
      var mParticipating = String(memberData[i][5] || '참여 중').trim();
      // G열: 잔여 보증금 (기본 50000). 시트 값이 있으면 우선 사용
      var mDeposit = memberData[i][6];
      mDeposit = (mDeposit === '' || mDeposit === null || mDeposit === undefined)
        ? null
        : safeInt(mDeposit);
      members.push({
        nickname: memberData[i][0],
        isAdmin: memberData[i][2] === true || memberData[i][2] === 'TRUE',
        hasAutoReport: checkHasAutoReport(memberData[i][0]),
        league: mLeague,
        participating: mParticipating,
        deposit: mDeposit  // null이면 프론트에서 자동 계산
      });
      memberLeagues[memberData[i][0]] = mLeague;
      if (memberData[i][3]) memberColors[memberData[i][0]] = String(memberData[i][3]);
    }
  }

  // 인증기록 — 최근 8주만 반환 (대시보드 UI는 길어도 한 달치만 보여줌)
  // 이전 데이터는 시트에 그대로 보존 (audit 일관성), API 응답만 슬림화.
  var DASHBOARD_WINDOW_DAYS = 8 * 7;
  var windowCutoffMs = Date.now() - DASHBOARD_WINDOW_DAYS * 86400 * 1000;
  var recordSheet = ss.getSheetByName('인증기록');
  var submissions = [];
  if (recordSheet && recordSheet.getLastRow() > 1) {
    var recordData = recordSheet.getDataRange().getValues();
    for (var j = 1; j < recordData.length; j++) {
      if (!recordData[j][0]) continue;
      // resetsAt(인덱스 8) 우선, 없으면 submittedAt(인덱스 5)로 윈도우 판정
      var subMs = _toEpochMs_(recordData[j][8]) || _toEpochMs_(recordData[j][5]);
      if (subMs && subMs < windowCutoffMs) continue;
      submissions.push({
        nickname: String(recordData[j][0]),
        week: Number(recordData[j][1]),
        year: Number(recordData[j][2]),
        type: recordData[j][3] || 'session',
        points: Number(recordData[j][4]) || 1,
        submittedAt: toDateTimeStr(recordData[j][5]),
        source: recordData[j][6] || 'auto',
        tokens: Number(recordData[j][7]) || 0,
        resetsAt: recordData[j][8] || '',
        league: String(recordData[j][9] || '').trim()  // 보고 시점의 리그 ('' = legacy)
      });
    }
  }

  // ── 사용량 집계 (v2 + machine_id) ──
  // (nickname, date)로 그룹핑 후 여러 machine 행을 합산.
  // legacy 배제 규칙: 같은 그룹에 machine_id != 'legacy' 행이 1개라도 있으면 legacy 행은 배제.
  var usageSheet = ss.getSheetByName('사용량');
  var usage = [];
  if (usageSheet && usageSheet.getLastRow() > 1) {
    var usageData = usageSheet.getDataRange().getValues();
    var usageHdr0 = usageData[0];
    var isUsageV2 = String(usageHdr0[2] || '').indexOf('claude_') === 0;
    var usageHasV1 = usageHdr0.length >= 9;

    // 1차: (nickname|date)별 각 machine 행 수집
    var groupMap = {};  // key=nickname|date, value={ machines: [{mid, cl...}, ...], hasNonLegacy: bool }
    for (var k = 1; k < usageData.length; k++) {
      if (!usageData[k][0]) continue;
      // 8주 윈도우 필터: 너무 옛 날짜 row는 응답에서 제외 (시트엔 보존)
      var rowDateMs = _toEpochMs_(usageData[k][1]);
      if (rowDateMs && rowDateMs < windowCutoffMs) continue;
      var row = usageData[k];
      var clIn, clOut, clCw, clCr, cxIn, cxOut, cxCr, uSess, uAt, mid;
      if (isUsageV2) {
        clIn  = safeInt(row[2]);  clOut = safeInt(row[3]);
        clCw  = safeInt(row[4]);  clCr  = safeInt(row[5]);
        cxIn  = safeInt(row[6]);  cxOut = safeInt(row[7]);
        cxCr  = safeInt(row[8]);
        uSess = safeInt(row[10]); uAt   = row[11];
        mid   = String(row[12] || '').trim() || LEGACY_MACHINE_ID;
      } else if (usageHasV1) {
        clIn = safeInt(row[2]); clOut = safeInt(row[3]);
        clCw = safeInt(row[4]); clCr = safeInt(row[5]);
        cxIn = 0; cxOut = 0; cxCr = 0;
        uSess = safeInt(row[7]); uAt = row[8]; mid = LEGACY_MACHINE_ID;
      } else {
        clIn = safeInt(row[2]); clOut = safeInt(row[3]);
        clCw = 0; clCr = 0; cxIn = 0; cxOut = 0; cxCr = 0;
        uSess = safeInt(row[5]); uAt = row[6]; mid = LEGACY_MACHINE_ID;
      }
      var nk = String(row[0]);
      var ds = toDateStr(row[1]);
      var key = nk + '|' + ds;
      if (!groupMap[key]) {
        groupMap[key] = { nickname: nk, date: ds, machines: [] };
      }
      // 각 행 score 미리 계산 (pickActiveRows_에서 사용)
      var rowScore = calcScoreV2_({
        claude_input_tokens: clIn, claude_output_tokens: clOut,
        claude_cache_creation_tokens: clCw, claude_cache_read_tokens: clCr,
        codex_input_tokens: cxIn, codex_output_tokens: cxOut,
        codex_cache_read_tokens: cxCr
      });
      groupMap[key].machines.push({
        mid: mid, score: rowScore,
        clIn: clIn, clOut: clOut, clCw: clCw, clCr: clCr,
        cxIn: cxIn, cxOut: cxOut, cxCr: cxCr,
        sess: uSess, at: uAt
      });
    }

    // 2차: 각 그룹을 pickActiveRows_로 필터 후 합산
    Object.keys(groupMap).forEach(function(key) {
      var g = groupMap[key];
      var rows = pickActiveRows_(g.machines);
      if (!rows.length) return;
      var sClIn=0,sClOut=0,sClCw=0,sClCr=0,sCxIn=0,sCxOut=0,sCxCr=0,sSess=0;
      var latestAt = null;
      rows.forEach(function(m) {
        sClIn  += m.clIn;   sClOut += m.clOut;
        sClCw  += m.clCw;   sClCr  += m.clCr;
        sCxIn  += m.cxIn;   sCxOut += m.cxOut;  sCxCr += m.cxCr;
        sSess  += m.sess;
        // reportedAt은 가장 최신 것을 사용
        if (m.at) {
          var t = toDateTimeStr(m.at);
          if (!latestAt || t > latestAt) latestAt = t;
        }
      });
      var uScore = calcScoreV2_({
        claude_input_tokens: sClIn, claude_output_tokens: sClOut,
        claude_cache_creation_tokens: sClCw, claude_cache_read_tokens: sClCr,
        codex_input_tokens: sCxIn, codex_output_tokens: sCxOut,
        codex_cache_read_tokens: sCxCr
      });
      usage.push({
        nickname: g.nickname, date: g.date,
        claude_input_tokens: sClIn, claude_output_tokens: sClOut,
        claude_cache_creation_tokens: sClCw, claude_cache_read_tokens: sClCr,
        codex_input_tokens: sCxIn, codex_output_tokens: sCxOut,
        codex_cache_read_tokens: sCxCr,
        input_tokens: sClIn + sCxIn,
        output_tokens: sClOut + sCxOut,
        cache_creation_tokens: sClCw,
        cache_read_tokens: sClCr + sCxCr,
        score: uScore, sessions: sSess,
        reportedAt: latestAt || '',
        machineCount: rows.length
      });
    });
  }

  // ── 요청자의 personalStats도 함께 반환 (API 호출 1회로 통합) ──
  var myStats = null;
  var reqNickname = (params.nickname || '').trim();
  var reqPassword = String(params.password || '').trim();
  if (reqNickname && reqPassword) {
    // 인증 확인
    var authenticated = false;
    for (var m = 1; m < memberData.length; m++) {
      if (String(memberData[m][0]).trim() === reqNickname && String(memberData[m][1]).trim() === reqPassword) {
        authenticated = true; break;
      }
    }
    if (authenticated) {
      // 사용자의 raw 보고를 (date, machine_id)별 최신으로 dedup 후, date별 합산
      var rawData = [];
      var rawSheet = ss.getSheetByName('사용량_raw');
      if (rawSheet && rawSheet.getLastRow() > 1) {
        var rawRows = rawSheet.getDataRange().getValues();
        var rawHdr0 = rawRows[0];
        var isRawV2 = String(rawHdr0[2] || '').indexOf('claude_') === 0;
        var rawHasV1 = rawHdr0.length >= 10;
        // 컬럼 동적 탐지
        var cAt   = rawHdr0.indexOf('reportedAt');
        var cMid  = rawHdr0.indexOf('machine_id');
        var cHour = rawHdr0.indexOf('hourly');
        if (cAt < 0)   cAt   = isRawV2 ? 11 : (rawHasV1 ? 8 : 6);
        if (cHour < 0) cHour = isRawV2 ? 12 : (rawHasV1 ? 9 : 7);

        // 1) 사용자의 모든 raw 행 수집, (date, machine_id)별 최신만
        var latestByDateMachine = {};  // "date|mid" -> parsed entry
        for (var r = 1; r < rawRows.length; r++) {
          if (String(rawRows[r][0]).trim() !== reqNickname) continue;
          var rClIn, rClOut, rClCw, rClCr, rCxIn, rCxOut, rCxCr, rSess, rAt, rHourlyStr, rMid;
          if (isRawV2) {
            rClIn  = safeInt(rawRows[r][2]);  rClOut = safeInt(rawRows[r][3]);
            rClCw  = safeInt(rawRows[r][4]);  rClCr  = safeInt(rawRows[r][5]);
            rCxIn  = safeInt(rawRows[r][6]);  rCxOut = safeInt(rawRows[r][7]);
            rCxCr  = safeInt(rawRows[r][8]);
            rSess  = safeInt(rawRows[r][10]); rAt = rawRows[r][cAt];
            rHourlyStr = rawRows[r][cHour] || '';
            rMid = cMid >= 0 ? (String(rawRows[r][cMid] || '').trim() || LEGACY_MACHINE_ID) : LEGACY_MACHINE_ID;
          } else if (rawHasV1) {
            rClIn = safeInt(rawRows[r][2]); rClOut = safeInt(rawRows[r][3]);
            rClCw = safeInt(rawRows[r][4]); rClCr = safeInt(rawRows[r][5]);
            rCxIn = 0; rCxOut = 0; rCxCr = 0;
            rSess = safeInt(rawRows[r][7]); rAt = rawRows[r][cAt]; rHourlyStr = rawRows[r][cHour] || '';
            rMid = LEGACY_MACHINE_ID;
          } else {
            rClIn = safeInt(rawRows[r][2]); rClOut = safeInt(rawRows[r][3]);
            rClCw = 0; rClCr = 0; rCxIn = 0; rCxOut = 0; rCxCr = 0;
            rSess = safeInt(rawRows[r][5]); rAt = rawRows[r][cAt]; rHourlyStr = rawRows[r][cHour] || '';
            rMid = LEGACY_MACHINE_ID;
          }
          var hourly = null;
          if (rHourlyStr) {
            try {
              hourly = JSON.parse(rHourlyStr);
              if (Array.isArray(hourly)) {
                hourly = hourly.map(function(b) {
                  if (b && b.cl) return b;
                  return {
                    h: b.h,
                    cl: { in: b.in || 0, out: b.out || 0, cc: b.cc || 0, cr: b.cr || 0 },
                    cx: { in: 0, out: 0, cr: 0 }
                  };
                });
              }
            } catch(e) {}
          }
          var dateStr = toDateStr(rawRows[r][1]);
          var atStr = toDateTimeStr(rAt);
          var key = dateStr + '|' + rMid;
          if (!latestByDateMachine[key] || atStr > latestByDateMachine[key].at) {
            // score도 함께 계산 (pickActiveRows_에서 사용)
            var rowScore = calcScoreV2_({
              claude_input_tokens: rClIn, claude_output_tokens: rClOut,
              claude_cache_creation_tokens: rClCw, claude_cache_read_tokens: rClCr,
              codex_input_tokens: rCxIn, codex_output_tokens: rCxOut,
              codex_cache_read_tokens: rCxCr
            });
            latestByDateMachine[key] = {
              date: dateStr, mid: rMid, at: atStr, score: rowScore,
              clIn: rClIn, clOut: rClOut, clCw: rClCw, clCr: rClCr,
              cxIn: rCxIn, cxOut: rCxOut, cxCr: rCxCr,
              sess: rSess, hourly: hourly
            };
          }
        }

        // 2) date별로 그룹핑 후 pickActiveRows_로 필터, hourly 시간대별 SUM
        var rawByDate = {};
        Object.keys(latestByDateMachine).forEach(function(k) {
          var e = latestByDateMachine[k];
          if (!rawByDate[e.date]) rawByDate[e.date] = { items: [] };
          rawByDate[e.date].items.push(e);
        });

        Object.keys(rawByDate).forEach(function(date) {
          var items = pickActiveRows_(rawByDate[date].items);
          if (!items.length) return;
          var sClIn=0,sClOut=0,sClCw=0,sClCr=0,sCxIn=0,sCxOut=0,sCxCr=0,sSess=0;
          var latestAt = null;
          var buckets = {};
          items.forEach(function(it) {
            sClIn += it.clIn; sClOut += it.clOut;
            sClCw += it.clCw; sClCr += it.clCr;
            sCxIn += it.cxIn; sCxOut += it.cxOut; sCxCr += it.cxCr;
            sSess += it.sess;
            if (!latestAt || it.at > latestAt) latestAt = it.at;
            if (it.hourly && Array.isArray(it.hourly)) {
              it.hourly.forEach(function(b) {
                if (!b || typeof b.h !== 'number') return;
                if (!buckets[b.h]) buckets[b.h] = { h:b.h, cl:{in:0,out:0,cc:0,cr:0}, cx:{in:0,out:0,cr:0} };
                var dst = buckets[b.h];
                var cl = b.cl || {}, cx = b.cx || {};
                dst.cl.in  += cl.in  || 0; dst.cl.out += cl.out || 0;
                dst.cl.cc  += cl.cc  || 0; dst.cl.cr  += cl.cr  || 0;
                dst.cx.in  += cx.in  || 0; dst.cx.out += cx.out || 0;
                dst.cx.cr  += cx.cr  || 0;
              });
            }
          });
          var hourlyMerged = Object.keys(buckets).map(function(h){return buckets[h];})
            .sort(function(a,b){return a.h-b.h;});
          var rScore = calcScoreV2_({
            claude_input_tokens: sClIn, claude_output_tokens: sClOut,
            claude_cache_creation_tokens: sClCw, claude_cache_read_tokens: sClCr,
            codex_input_tokens: sCxIn, codex_output_tokens: sCxOut,
            codex_cache_read_tokens: sCxCr
          });
          rawData.push({
            date: date,
            claude_input_tokens: sClIn, claude_output_tokens: sClOut,
            claude_cache_creation_tokens: sClCw, claude_cache_read_tokens: sClCr,
            codex_input_tokens: sCxIn, codex_output_tokens: sCxOut,
            codex_cache_read_tokens: sCxCr,
            input_tokens: sClIn + sCxIn, output_tokens: sClOut + sCxOut,
            cache_creation_tokens: sClCw, cache_read_tokens: sClCr + sCxCr,
            score: rScore, sessions: sSess,
            reportedAt: latestAt || '',
            hourly: hourlyMerged,
            machineCount: items.length
          });
        });
        // 최신 날짜가 먼저 오도록 정렬
        rawData.sort(function(a,b){ return a.date > b.date ? -1 : (a.date < b.date ? 1 : 0); });
      }
      var dailyData = [];
      for (var u = 0; u < usage.length; u++) {
        if (usage[u].nickname === reqNickname) {
          dailyData.push(usage[u]);
        }
      }
      var pointsData = [];
      if (recordSheet && submissions.length > 0) {
        for (var p = 0; p < submissions.length; p++) {
          if (submissions[p].nickname === reqNickname) {
            pointsData.push({
              date: submissions[p].resetsAt || submissions[p].submittedAt,
              points: submissions[p].points,
              source: submissions[p].source
            });
          }
        }
      }
      myStats = { raw: rawData, daily: dailyData, points: pointsData };
    }
  }

  // ── 멤버별 최근 활동 + 최근 날짜의 다중-PC 합산 hourly ──
  // (nickname, date, machine_id)별 "최신 raw 행"만 수집 → 각 멤버의 가장 최근 날짜를 찾아 그 날의 모든 PC hourly를 시간대별 합산.
  var memberLastActivity = {};
  var memberAllHourly = {}; // nickname -> hourly 배열(v2 형식, 다중 PC 합산)
  var rawSheet2 = ss.getSheetByName('사용량_raw');
  if (rawSheet2 && rawSheet2.getLastRow() > 1) {
    var rawRows2 = rawSheet2.getDataRange().getValues();
    var rawHdr2 = rawRows2[0];
    var rawHdrStr = rawHdr2.map(function(h){return String(h||'');}).join(',');
    // 컬럼 위치를 헤더 기반으로 동적 탐지 (v1/v2/v2+machine 호환)
    var colAt   = rawHdr2.indexOf('reportedAt');
    var colMid  = rawHdr2.indexOf('machine_id');
    var colHour = rawHdr2.indexOf('hourly');
    var isRaw2V2 = rawHdrStr.indexOf('claude_input_tokens') >= 0;
    // 레거시 v1/구형 fallback
    if (colAt < 0)   colAt   = isRaw2V2 ? 11 : (rawHdr2.length >= 10 ? 8 : 6);
    if (colHour < 0) colHour = isRaw2V2 ? 12 : (rawHdr2.length >= 10 ? 9 : 7);

    // (nickname, date, machine_id) -> { at, hourly }
    var latestPerPc = {};
    for (var rr = 1; rr < rawRows2.length; rr++) {
      var rNick = String(rawRows2[rr][0] || '').trim();
      if (!rNick) continue;
      // 8주 윈도우 필터 (대시보드 응답에서 옛 hourly 제외)
      var rawDateMs = _toEpochMs_(rawRows2[rr][1]);
      if (rawDateMs && rawDateMs < windowCutoffMs) continue;
      var rDate = toDateStr(rawRows2[rr][1]);
      var rAt2 = rawRows2[rr][colAt];
      var rMid = colMid >= 0 ? (String(rawRows2[rr][colMid] || '').trim() || LEGACY_MACHINE_ID) : LEGACY_MACHINE_ID;
      var rHourlyStr2 = rawRows2[rr][colHour] || '';
      var rAtStr = toDateTimeStr(rAt2);
      var key = rNick + '|' + rDate + '|' + rMid;
      if (!latestPerPc[key] || rAtStr > latestPerPc[key].at) {
        var rHourly2 = null;
        if (rHourlyStr2) {
          try {
            rHourly2 = JSON.parse(rHourlyStr2);
            if (Array.isArray(rHourly2)) {
              rHourly2 = rHourly2.map(function(b) {
                if (b && b.cl) return b;
                return {
                  h: b.h,
                  cl: { in: b.in || 0, out: b.out || 0, cc: b.cc || 0, cr: b.cr || 0 },
                  cx: { in: 0, out: 0, cr: 0 }
                };
              });
            }
          } catch(e) {}
        }
        // hourly 기반 score 계산 (pickActiveRows_에서 사용)
        var pcScore = 0;
        if (rHourly2 && Array.isArray(rHourly2)) {
          rHourly2.forEach(function(b){ pcScore += calcBucketScoreV2_(b); });
        }
        latestPerPc[key] = { nick: rNick, date: rDate, mid: rMid, at: rAtStr, score: pcScore, hourly: rHourly2 };
      }
    }

    // 닉네임별로 가장 최근 date + 그 date의 machine 목록
    var latestDateByNick = {};  // nick -> { date, at }
    var pcsByNickDate = {};     // "nick|date" -> { items: [] }
    Object.keys(latestPerPc).forEach(function(key) {
      var e = latestPerPc[key];
      if (!e.date) return;
      var cur = latestDateByNick[e.nick];
      if (!cur || e.date > cur.date || (e.date === cur.date && e.at > cur.at)) {
        latestDateByNick[e.nick] = { date: e.date, at: e.at };
      }
      var nd = e.nick + '|' + e.date;
      if (!pcsByNickDate[nd]) pcsByNickDate[nd] = { items: [] };
      pcsByNickDate[nd].items.push(e);
    });

    // 각 닉네임의 최근 날짜에서 pickActiveRows_ 적용 후 hourly 합산
    Object.keys(latestDateByNick).forEach(function(nick) {
      var lat = latestDateByNick[nick];
      var group = pcsByNickDate[nick + '|' + lat.date];
      if (!group) return;
      var pcs = pickActiveRows_(group.items);
      // 시간대별 bucket 합산 (0~23)
      var buckets = {};
      pcs.forEach(function(pc) {
        if (!pc.hourly || !Array.isArray(pc.hourly)) return;
        pc.hourly.forEach(function(b) {
          if (!b || typeof b.h !== 'number') return;
          if (!buckets[b.h]) {
            buckets[b.h] = { h: b.h,
              cl: {in:0,out:0,cc:0,cr:0}, cx: {in:0,out:0,cr:0} };
          }
          var dst = buckets[b.h];
          var cl = b.cl || {}, cx = b.cx || {};
          dst.cl.in  += cl.in  || 0; dst.cl.out += cl.out || 0;
          dst.cl.cc  += cl.cc  || 0; dst.cl.cr  += cl.cr  || 0;
          dst.cx.in  += cx.in  || 0; dst.cx.out += cx.out || 0;
          dst.cx.cr  += cx.cr  || 0;
        });
      });
      var merged = Object.keys(buckets).map(function(h){return buckets[h];})
        .sort(function(a,b){return a.h-b.h;});
      memberAllHourly[nick] = merged.length ? merged : null;
      // 불꽃: 가장 늦은 시간대 bucket의 가중 스코어
      if (merged.length > 0) {
        var maxB = merged[merged.length - 1];
        memberLastActivity[nick] = {
          hour: maxB.h,
          score: calcBucketScoreV2_(maxB),
          reportedAt: lat.at
        };
      }
    });
  }

  // ── 주간 1위 사용자의 hourly (탑 티어 vs 나 비교 차트용) ──
  // 주간 가중 스코어 1위 멤버 계산
  var nowKst = new Date();
  var jsDay = nowKst.getDay();
  var monOff = jsDay === 0 ? 6 : jsDay - 1;
  var monD = new Date(nowKst);
  monD.setDate(monD.getDate() - monOff);
  var monStr = monD.getFullYear() + '-' + ('0' + (monD.getMonth() + 1)).slice(-2) + '-' + ('0' + monD.getDate()).slice(-2);
  var todayStrSv = nowKst.getFullYear() + '-' + ('0' + (nowKst.getMonth() + 1)).slice(-2) + '-' + ('0' + nowKst.getDate()).slice(-2);
  var weeklyScores = {};
  for (var w2 = 0; w2 < usage.length; w2++) {
    var wd = usage[w2].date;
    if (wd >= monStr && wd <= todayStrSv) {
      weeklyScores[usage[w2].nickname] = (weeklyScores[usage[w2].nickname] || 0) + (usage[w2].score || 0);
    }
  }
  var topNick = null, topScore = 0;
  Object.keys(weeklyScores).forEach(function(nk) {
    if (weeklyScores[nk] > topScore) { topScore = weeklyScores[nk]; topNick = nk; }
  });
  var topUser = null;
  if (topNick) {
    topUser = { nickname: topNick, weekScore: topScore, hourly: memberAllHourly[topNick] || null };
  }

  // ── 주간 정산 audit log (벌금 탭의 과거 주차 freeze) ──
  var settlements = [];
  var settlementSh = ss.getSheetByName(WEEKLY_SETTLEMENT_SHEET_);
  if (settlementSh && settlementSh.getLastRow() > 1) {
    var sVals = settlementSh.getRange(2, 1, settlementSh.getLastRow() - 1, WEEKLY_SETTLEMENT_HEADERS_.length).getValues();
    for (var si = 0; si < sVals.length; si++) {
      var sr = sVals[si];
      if (!sr[0]) continue;
      settlements.push({
        nickname: String(sr[0]),
        week: Number(sr[1]) || 0,
        year: Number(sr[2]) || 0,
        status: String(sr[3] || '참여 중'),
        missCount: Number(sr[4]) || 0,
        chargedDays: Number(sr[5]) || 0,
        fineAmount: Number(sr[6]) || 0,
        depositBefore: Number(sr[7]) || 0,
        depositAfter: Number(sr[8]) || 0,
        settledAt: toDateTimeStr(sr[9])
      });
    }
  }

  // ── 평가 랭킹 (대시보드에서 노출용; 평가 sub-tab과 동일 데이터) ──
  var evalRankings = computeEvalRankings_();

  // ── 요청자의 이번 주 활성 IR (주 1회 제한 UI 가드용) ──
  // 가장 최근의 non-abandoned row 반환. 다른 브라우저/기기에서 시작한 경우에도
  // 프런트가 localStorage 없이 상태 복원할 수 있도록.
  var myEvalThisWeek = null;
  var evalShDash = nickname ? ss.getSheetByName(EVAL_SHEET_NAME_) : null;
  if (evalShDash && evalShDash.getLastRow() >= 2) {
    var dashIso = getIsoWeek_(new Date());
    var dashCols = EVAL_HEADERS_.length;
    var evalDashVals = evalShDash.getRange(2, 1, evalShDash.getLastRow() - 1, dashCols).getValues();
    // 역순(최근 행 우선)으로 검색 + lazy reveal flip 적용
    for (var ei = evalDashVals.length - 1; ei >= 0; ei--) {
      var er = evalDashVals[ei];
      if (String(er[1]).trim() !== nickname) continue;
      if (Number(er[2]) !== dashIso.week) continue;
      if (Number(er[3]) !== dashIso.year) continue;
      // 검색 도중에도 reveal flip 적용해 정확한 status 반영
      maybeFlipReveal_(evalShDash, er, ei);
      var est = String(er[20]).trim();
      if (est === 'abandoned' || est === '') continue;
      myEvalThisWeek = {
        evalId: String(er[0]),
        status: est,
        projectName: String(er[6]),
        revealAt: Number(er[23]) || 0
      };
      break;
    }
  }

  var response = {
    success: true,
    members: members,
    submissions: submissions,
    usage: usage,
    myStats: myStats,
    memberLastActivity: memberLastActivity,
    topUser: topUser,
    memberHourly: memberAllHourly,
    memberColors: memberColors,
    settlements: settlements,
    evalRankings: evalRankings,
    myEvalThisWeek: myEvalThisWeek
  };
  // 캐시에 저장 (다음 30s 내 동일 요청은 시트 read 없이 즉시 반환)
  putCachedDashboard_(nickname, response);
  return response;
}

// 평가 시트에서 주간/월간/누적 평가금액 1위를 계산 (handleEvalFeed의 로직과 동일).
// 평가 시트가 없거나 비어있으면 null 반환.
function computeEvalRankings_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var evalSh = ss.getSheetByName(EVAL_SHEET_NAME_);
  if (!evalSh || evalSh.getLastRow() < 2) return null;

  var values = evalSh.getRange(2, 1, evalSh.getLastRow() - 1, EVAL_HEADERS_.length).getValues();
  // Lazy reveal flip (시트 무결성 유지)
  for (var fi = 0; fi < values.length; fi++) {
    maybeFlipReveal_(evalSh, values[fi], fi);
  }
  var now = new Date();
  var iso = getIsoWeek_(now);
  var monthKey = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
  var sums = { week: {}, month: {}, all: {} };
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (String(row[20]).trim() !== 'completed') continue;
    var nick = String(row[1]).trim();
    var krw = Number(row[18]) || 0;
    var compAt = String(row[5]);
    sums.all[nick] = (sums.all[nick] || 0) + krw;
    if (compAt.length >= 7 && compAt.substring(0, 7) === monthKey) {
      sums.month[nick] = (sums.month[nick] || 0) + krw;
    }
    if (Number(row[2]) === iso.week && Number(row[3]) === iso.year) {
      sums.week[nick] = (sums.week[nick] || 0) + krw;
    }
  }
  function top_(map) {
    var best = null;
    Object.keys(map).forEach(function(nick) {
      if (!best || map[nick] > best.krw) best = { nickname: nick, krw: map[nick] };
    });
    return best;
  }
  return { week: top_(sums.week), month: top_(sums.month), all: top_(sums.all) };
}

// ── 사용량 보고 (PC에서 Hook으로 전송) ──
// v2: Claude + Codex 분리 필드 + machine_id (여러 PC 합산 지원).
// upsert 키: (nickname, date, machine_id)
// 인증기록 포인트: 해당 (nickname, date)의 모든 machine 합산 score 기준
function handleReportUsage(params) {
  migrateSheetIfNeeded_();

  var nickname = (params.nickname || '').trim();
  var password = String(params.password || '').trim();
  var date = (params.date || '').trim();
  // machine_id: 없거나 공백이면 'legacy' (구 py와 호환)
  var machineId = String(params.machine_id || '').trim() || LEGACY_MACHINE_ID;

  var claudeIn  = parseInt(params.claude_input_tokens != null ? params.claude_input_tokens : params.input_tokens) || 0;
  var claudeOut = parseInt(params.claude_output_tokens != null ? params.claude_output_tokens : params.output_tokens) || 0;
  var claudeCw  = parseInt(params.claude_cache_creation_tokens != null ? params.claude_cache_creation_tokens : params.cache_creation_tokens) || 0;
  var claudeCr  = parseInt(params.claude_cache_read_tokens != null ? params.claude_cache_read_tokens : params.cache_read_tokens) || 0;
  var codexIn  = parseInt(params.codex_input_tokens) || 0;
  var codexOut = parseInt(params.codex_output_tokens) || 0;
  var codexCr  = parseInt(params.codex_cache_read_tokens) || 0;
  var sessions = parseInt(params.sessions) || 0;

  if (!claudeCw && !claudeCr && params.cache_tokens) {
    claudeCw = parseInt(params.cache_tokens) || 0;
  }

  // 이 PC의 score (합산 아님)
  var score = calcScoreV2_({
    claude_input_tokens: claudeIn, claude_output_tokens: claudeOut,
    claude_cache_creation_tokens: claudeCw, claude_cache_read_tokens: claudeCr,
    codex_input_tokens: codexIn, codex_output_tokens: codexOut,
    codex_cache_read_tokens: codexCr
  });

  if (!nickname || !password || !date) return { success: false, error: '필수 파라미터가 누락되었습니다.' };

  // 인증
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var memberSheet = ss.getSheetByName('멤버');
  if (!memberSheet) return { success: false, error: '"멤버" 시트가 없습니다.' };

  var memberData = memberSheet.getDataRange().getValues();
  var authenticated = false;
  var userLeague = LEAGUE_1M;
  for (var i = 1; i < memberData.length; i++) {
    if (String(memberData[i][0]).trim() === nickname && String(memberData[i][1]).trim() === password) {
      authenticated = true;
      var uL = String(memberData[i][4] || '').trim();
      userLeague = (uL === LEAGUE_10M) ? LEAGUE_10M : LEAGUE_1M;
      break;
    }
  }
  if (!authenticated) return { success: false, error: '인증 실패.' };

  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  // ① 사용량_raw: 보고 원본 append (machine_id + hourly 포함)
  var rawSheet = ss.getSheetByName('사용량_raw');
  if (!rawSheet) {
    rawSheet = ss.insertSheet('사용량_raw');
    rawSheet.appendRow(RAW_V2_HEADERS_);
  }
  var hourlyJson = '';
  if (params.hourly) {
    try {
      var hArr = (typeof params.hourly === 'string') ? JSON.parse(params.hourly) : params.hourly;
      if (Array.isArray(hArr)) {
        var normalized = hArr.map(function(b) {
          if (b && b.cl) return b;
          return {
            h: b.h,
            cl: { in: b.in || 0, out: b.out || 0, cc: b.cc || 0, cr: b.cr || 0 },
            cx: { in: 0, out: 0, cr: 0 }
          };
        });
        hourlyJson = JSON.stringify(normalized);
      }
    } catch (e) {
      hourlyJson = typeof params.hourly === 'string' ? params.hourly : JSON.stringify(params.hourly);
    }
  }
  rawSheet.appendRow([
    nickname, "'" + date,
    claudeIn, claudeOut, claudeCw, claudeCr,
    codexIn, codexOut, codexCr,
    score, sessions, now, machineId, hourlyJson
  ]);

  // ② 사용량: (nickname, date, machine_id) upsert + legacy 정리
  var usageSheet = ss.getSheetByName('사용량');
  if (!usageSheet) {
    usageSheet = ss.insertSheet('사용량');
    usageSheet.appendRow(USAGE_V2_HEADERS_);
  }

  var usageData = usageSheet.getDataRange().getValues();
  var existingRow = -1;
  var existingScore = 0;
  for (var j = 1; j < usageData.length; j++) {
    if (String(usageData[j][0]) !== nickname) continue;
    if (toDateStr(usageData[j][1]) !== date) continue;
    var rowMid = String(usageData[j][12] || LEGACY_MACHINE_ID).trim() || LEGACY_MACHINE_ID;
    if (rowMid === machineId) {
      existingRow = j + 1;
      existingScore = safeInt(usageData[j][9]);
      break;
    }
  }

  // ── 데이터 손실 방지 (같은 PC의 재보고만 비교) ──
  if (existingRow > 0 && existingScore > 0 && score < existingScore) {
    return {
      success: true,
      message: 'skip: 기존 값 보존 (new=' + score + ' < existing=' + existingScore + ', machine=' + machineId + ')',
      date: date, score: existingScore, skipped: true
    };
  }

  if (existingRow > 0) {
    usageSheet.getRange(existingRow, 3, 1, 11).setValues([[
      claudeIn, claudeOut, claudeCw, claudeCr,
      codexIn, codexOut, codexCr,
      score, sessions, now, machineId
    ]]);
  } else {
    usageSheet.appendRow([
      nickname, "'" + date,
      claudeIn, claudeOut, claudeCw, claudeCr,
      codexIn, codexOut, codexCr,
      score, sessions, now, machineId
    ]);
  }
  // 주의: legacy 행은 자동 삭제하지 않음. 2대 이상 PC 유저의 "다른 PC가
  // 아직 구 py"일 경우 그 PC 데이터가 손실될 수 있으므로. 합산 시 배제 규칙으로만 처리.

  // ── 자동 인증: (nickname, date)의 pickActiveRows_ 적용 후 합산 score로 포인트 계산 ──
  var usageAfter = usageSheet.getDataRange().getValues();
  var userDayRows = [];
  for (var u = 1; u < usageAfter.length; u++) {
    if (String(usageAfter[u][0]) !== nickname) continue;
    if (toDateStr(usageAfter[u][1]) !== date) continue;
    userDayRows.push({
      mid: String(usageAfter[u][12] || '').trim() || LEGACY_MACHINE_ID,
      score: safeInt(usageAfter[u][9])
    });
  }
  var pickedRows = pickActiveRows_(userDayRows);
  var totalScore = 0;
  pickedRows.forEach(function(r){ totalScore += r.score; });

  var isLegacy = (date < LEAGUE_ERA_START);
  var recordLeague = isLegacy ? '' : userLeague;
  var earnedPts = isLegacy ? calcPointsLegacy_(totalScore) : calcPointsForLeague_(totalScore, userLeague);
  if (earnedPts > 0) {
    var recordSheet = ss.getSheetByName('인증기록');
    if (recordSheet) {
      var records = recordSheet.getDataRange().getValues();
      var alreadyExists = false;
      for (var k = 1; k < records.length; k++) {
        var storedDate = toDateStr(records[k][8]) || toDateStr(records[k][5]);
        if (String(records[k][0]) === nickname && String(records[k][6]) === 'auto' && storedDate === date) {
          recordSheet.getRange(k + 1, 5).setValue(earnedPts);
          recordSheet.getRange(k + 1, 6).setValue(now);
          recordSheet.getRange(k + 1, 8).setValue(totalScore);
          recordSheet.getRange(k + 1, 9).setNumberFormat('@').setValue(date);
          recordSheet.getRange(k + 1, 10).setValue(recordLeague);
          alreadyExists = true;
          break;
        }
      }
      if (!alreadyExists) {
        var parts = date.split('-');
        var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        var utcD = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        var dayNum = utcD.getUTCDay() || 7;
        utcD.setUTCDate(utcD.getUTCDate() + 4 - dayNum);
        var yearStart = new Date(Date.UTC(utcD.getUTCFullYear(), 0, 1));
        var week = Math.ceil(((utcD - yearStart) / 86400000 + 1) / 7);
        var year = d.getFullYear();
        recordSheet.appendRow([nickname, week, year, 'session', earnedPts, now, 'auto', totalScore, "'" + date, recordLeague]);
      }
    }
  }

  return {
    success: true, message: '사용량 보고 완료',
    date: date, score: score, totalScore: totalScore, machine_id: machineId
  };
}

// ── 수동 스크린샷 업로드 ──
function handleUpload(params) {
  var nickname = (params.nickname || '').trim();
  var week = parseInt(params.week);
  var year = parseInt(params.year);
  var type = params.type || 'session';
  var points = type === 'weekly' ? 5 : 1;
  var screenshotTime = params.screenshotTime || '';
  var imageBase64 = params.imageBase64 || '';
  var fileName = params.fileName || 'screenshot.png';

  if (!nickname || !week || !year || !imageBase64) {
    return { success: false, error: '필수 파라미터가 누락되었습니다.' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('인증기록');
  if (!sheet) return { success: false, error: '"인증기록" 시트를 찾을 수 없습니다.' };

  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  var today = now.substring(0, 10);
  var data = sheet.getDataRange().getValues();

  if (type === 'session') {
    var todayCount = 0;
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === nickname && data[i][3] === 'session' && data[i][6] === 'manual') {
        var subDate = String(data[i][5]).substring(0, 10);
        if (subDate === today) todayCount++;
      }
    }
    if (todayCount >= 3) return { success: false, error: '오늘 수동 세션 인증 3회를 이미 사용했습니다.' };
  } else if (type === 'weekly') {
    for (var k = 1; k < data.length; k++) {
      if (data[k][0] === nickname && data[k][1] === week && data[k][2] === year && data[k][3] === 'weekly' && data[k][6] === 'manual') {
        return { success: false, error: '이번 주 수동 주간 인증을 이미 완료했습니다.' };
      }
    }
  }

  var folder = getOrCreateFolder(year, week);
  var blob = Utilities.newBlob(Utilities.base64Decode(imageBase64), 'image/png', nickname + '_' + type + '_week' + week + '_' + fileName);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var imageUrl = 'https://drive.google.com/uc?id=' + file.getId();

  sheet.appendRow([nickname, week, year, type, points, now, 'manual', 0, '']);

  return { success: true, imageUrl: imageUrl, points: points };
}

function getOrCreateFolder(year, week) {
  var rootFolderName = '챌린지_인증스크린샷';
  var folders = DriveApp.getFoldersByName(rootFolderName);
  var rootFolder = folders.hasNext() ? folders.next() : DriveApp.createFolder(rootFolderName);
  var yearFolderName = String(year);
  var yearFolders = rootFolder.getFoldersByName(yearFolderName);
  var yearFolder = yearFolders.hasNext() ? yearFolders.next() : rootFolder.createFolder(yearFolderName);
  var weekFolderName = 'week' + week;
  var weekFolders = yearFolder.getFoldersByName(weekFolderName);
  return weekFolders.hasNext() ? weekFolders.next() : yearFolder.createFolder(weekFolderName);
}

// ── 관리자 ──
function handleAddMember(params) {
  var adminNickname = (params.adminNickname || '').trim();
  var nickname = (params.nickname || '').trim();
  var password = String(params.password || '').trim();
  if (!isAdmin(adminNickname)) return { success: false, error: '관리자 권한이 필요합니다.' };
  if (!nickname || !password) return { success: false, error: '닉네임과 비밀번호를 입력하세요.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('멤버');
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === nickname) return { success: false, error: '이미 존재하는 닉네임입니다.' };
  }
  writeMemberRow_(sheet, nickname, password, false);
  return { success: true };
}

function handleSetColor(params) {
  var nickname = (params.nickname || '').trim();
  var password = String(params.password || '').trim();
  var color = (params.color || '').trim();
  if (!nickname || !password) return { success: false, error: '인증 정보가 필요합니다.' };
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { success: false, error: '올바른 색상 코드가 아닙니다.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('멤버');
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === nickname && String(data[i][1]).trim() === password) {
      sheet.getRange(i + 1, 4).setValue(color);
      return { success: true };
    }
  }
  return { success: false, error: '인증 실패' };
}

function handleDeleteMember(params) {
  var adminNickname = (params.adminNickname || '').trim();
  var nickname = (params.nickname || '').trim();
  if (!isAdmin(adminNickname)) return { success: false, error: '관리자 권한이 필요합니다.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('멤버');
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === nickname) { sheet.deleteRow(i + 1); return { success: true }; }
  }
  return { success: false, error: '해당 멤버를 찾을 수 없습니다.' };
}

// ── 개인 통계 ──
function handlePersonalStats(params) {
  // handleDashboard가 이미 requester의 myStats를 합산 로직으로 계산하므로 위임.
  // (중복 코드 제거 + 다중-PC 합산 로직이 자동 적용됨)
  var full = handleDashboard(params);
  if (!full || !full.success) return full || { success: false, error: 'failed' };
  if (!full.myStats) return { success: false, error: '인증 실패 또는 데이터 없음' };
  return {
    success: true,
    raw:    full.myStats.raw    || [],
    daily:  full.myStats.daily  || [],
    points: full.myStats.points || []
  };
}

// ↓ 구 구현은 제거. 아래 더미 가드만 남김 (구문 오류 방지용 블록 닫기)
function _handlePersonalStats_DEPRECATED_(params) {
  if (true) return { success: false, error: 'deprecated' };

  var nickname = (params.nickname || '').trim();
  var password = String(params.password || '').trim();
  if (!nickname || !password) return { success: false, error: '인증 정보가 필요합니다.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var memberSheet = ss.getSheetByName('멤버');
  if (!memberSheet) return { success: false, error: '"멤버" 시트가 없습니다.' };

  var memberData = memberSheet.getDataRange().getValues();
  var authenticated = false;
  for (var i = 1; i < memberData.length; i++) {
    if (String(memberData[i][0]).trim() === nickname && String(memberData[i][1]).trim() === password) {
      authenticated = true; break;
    }
  }
  if (!authenticated) return { success: false, error: '인증 실패.' };

  // 사용량_raw (v2: 13열 / v1: 10열 / 구형: 8열)
  var rawData = [];
  var rawSheet = ss.getSheetByName('사용량_raw');
  if (rawSheet && rawSheet.getLastRow() > 1) {
    var rows = rawSheet.getDataRange().getValues();
    var rawHdr = rows[0];
    var isRawPsV2 = String(rawHdr[2] || '').indexOf('claude_') === 0;
    var hasRawV1 = rawHdr.length >= 10;
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]).trim() === nickname) {
        var prClIn, prClOut, prClCw, prClCr, prCxIn, prCxOut, prCxCr, prSess, prAt, prHourlyStr;
        if (isRawPsV2) {
          prClIn = safeInt(rows[r][2]);  prClOut = safeInt(rows[r][3]);
          prClCw = safeInt(rows[r][4]);  prClCr = safeInt(rows[r][5]);
          prCxIn = safeInt(rows[r][6]);  prCxOut = safeInt(rows[r][7]);
          prCxCr = safeInt(rows[r][8]);
          prSess = safeInt(rows[r][10]); prAt = rows[r][11];
          prHourlyStr = rows[r][12] || '';
        } else if (hasRawV1) {
          prClIn = safeInt(rows[r][2]);  prClOut = safeInt(rows[r][3]);
          prClCw = safeInt(rows[r][4]);  prClCr = safeInt(rows[r][5]);
          prCxIn = 0; prCxOut = 0; prCxCr = 0;
          prSess = safeInt(rows[r][7]); prAt = rows[r][8];
          prHourlyStr = rows[r][9] || '';
        } else {
          prClIn = safeInt(rows[r][2]);  prClOut = safeInt(rows[r][3]);
          prClCw = 0; prClCr = 0; prCxIn = 0; prCxOut = 0; prCxCr = 0;
          prSess = safeInt(rows[r][5]); prAt = rows[r][6];
          prHourlyStr = rows[r][7] || '';
        }
        var prScore = calcScoreV2_({
          claude_input_tokens: prClIn, claude_output_tokens: prClOut,
          claude_cache_creation_tokens: prClCw, claude_cache_read_tokens: prClCr,
          codex_input_tokens: prCxIn, codex_output_tokens: prCxOut,
          codex_cache_read_tokens: prCxCr
        });
        var hourly = null;
        if (prHourlyStr) {
          try {
            hourly = JSON.parse(prHourlyStr);
            if (Array.isArray(hourly)) {
              hourly = hourly.map(function(b) {
                if (b && b.cl) return b;
                return { h: b.h, cl: { in: b.in || 0, out: b.out || 0, cc: b.cc || 0, cr: b.cr || 0 }, cx: { in: 0, out: 0, cr: 0 } };
              });
            }
          } catch(e) {}
        }
        rawData.push({
          date: toDateStr(rows[r][1]),
          claude_input_tokens: prClIn, claude_output_tokens: prClOut,
          claude_cache_creation_tokens: prClCw, claude_cache_read_tokens: prClCr,
          codex_input_tokens: prCxIn, codex_output_tokens: prCxOut,
          codex_cache_read_tokens: prCxCr,
          input_tokens: prClIn + prCxIn,
          output_tokens: prClOut + prCxOut,
          cache_creation_tokens: prClCw,
          cache_read_tokens: prClCr + prCxCr,
          score: prScore,
          sessions: prSess,
          reportedAt: toDateTimeStr(prAt),
          hourly: hourly
        });
      }
    }
  }

  // 사용량 (v2: 12열 / v1: 9열 / 구형: 7열)
  var dailyData = [];
  var usageSheet = ss.getSheetByName('사용량');
  if (usageSheet && usageSheet.getLastRow() > 1) {
    var uRows = usageSheet.getDataRange().getValues();
    var usageHdr = uRows[0];
    var isUsagePsV2 = String(usageHdr[2] || '').indexOf('claude_') === 0;
    var hasUsageV1 = usageHdr.length >= 9;
    for (var u = 1; u < uRows.length; u++) {
      if (String(uRows[u][0]).trim() === nickname) {
        var pdClIn, pdClOut, pdClCw, pdClCr, pdCxIn, pdCxOut, pdCxCr, pdSess, pdAt;
        if (isUsagePsV2) {
          pdClIn = safeInt(uRows[u][2]);  pdClOut = safeInt(uRows[u][3]);
          pdClCw = safeInt(uRows[u][4]);  pdClCr = safeInt(uRows[u][5]);
          pdCxIn = safeInt(uRows[u][6]);  pdCxOut = safeInt(uRows[u][7]);
          pdCxCr = safeInt(uRows[u][8]);
          pdSess = safeInt(uRows[u][10]); pdAt = uRows[u][11];
        } else if (hasUsageV1) {
          pdClIn = safeInt(uRows[u][2]);  pdClOut = safeInt(uRows[u][3]);
          pdClCw = safeInt(uRows[u][4]);  pdClCr = safeInt(uRows[u][5]);
          pdCxIn = 0; pdCxOut = 0; pdCxCr = 0;
          pdSess = safeInt(uRows[u][7]); pdAt = uRows[u][8];
        } else {
          pdClIn = safeInt(uRows[u][2]);  pdClOut = safeInt(uRows[u][3]);
          pdClCw = 0; pdClCr = 0; pdCxIn = 0; pdCxOut = 0; pdCxCr = 0;
          pdSess = safeInt(uRows[u][5]); pdAt = uRows[u][6];
        }
        var pdScore = calcScoreV2_({
          claude_input_tokens: pdClIn, claude_output_tokens: pdClOut,
          claude_cache_creation_tokens: pdClCw, claude_cache_read_tokens: pdClCr,
          codex_input_tokens: pdCxIn, codex_output_tokens: pdCxOut,
          codex_cache_read_tokens: pdCxCr
        });
        dailyData.push({
          date: toDateStr(uRows[u][1]),
          claude_input_tokens: pdClIn, claude_output_tokens: pdClOut,
          claude_cache_creation_tokens: pdClCw, claude_cache_read_tokens: pdClCr,
          codex_input_tokens: pdCxIn, codex_output_tokens: pdCxOut,
          codex_cache_read_tokens: pdCxCr,
          input_tokens: pdClIn + pdCxIn,
          output_tokens: pdClOut + pdCxOut,
          cache_creation_tokens: pdClCw,
          cache_read_tokens: pdClCr + pdCxCr,
          score: pdScore,
          sessions: pdSess,
          reportedAt: toDateTimeStr(pdAt)
        });
      }
    }
  }

  // 인증기록 (포인트)
  var pointsData = [];
  var recordSheet = ss.getSheetByName('인증기록');
  if (recordSheet && recordSheet.getLastRow() > 1) {
    var pRows = recordSheet.getDataRange().getValues();
    for (var p = 1; p < pRows.length; p++) {
      if (String(pRows[p][0]).trim() === nickname) {
        pointsData.push({
          date: toDateStr(pRows[p][8]) || toDateStr(pRows[p][5]),
          points: Number(pRows[p][4]) || 0,
          source: pRows[p][6] || 'auto'
        });
      }
    }
  }

  return { success: true, raw: rawData, daily: dailyData, points: pointsData };
}

// ── 유틸리티 ──
function isAdmin(nickname) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('멤버');
  if (!sheet) return false;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === nickname && (data[i][2] === true || data[i][2] === 'TRUE')) return true;
  }
  return false;
}

function checkHasAutoReport(nickname) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('사용량');
  if (!sheet || sheet.getLastRow() <= 1) return false;
  var data = sheet.getDataRange().getValues();
  // 최근 3일 이내에 보고 기록이 있으면 true
  var now = new Date();
  var threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  var cutoff = Utilities.formatDate(threeDaysAgo, 'Asia/Seoul', 'yyyy-MM-dd');
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === nickname && toDateStr(data[i][1]) >= cutoff) return true;
  }
  return false;
}

// ============================================
// ── 리그 일간 배치 ──
// ============================================
// 매일 00:01 KST 근처 실행 (Apps Script trigger는 ±15분 근사).
// 어제 기준 과거 3일 일일 스코어를 보고,
// - 1M 리그 유저: 3일 모두 >= 10M → 10M 리그로 승격
// - 10M 리그 유저: 3일 모두 < 10M → 1M 리그로 강등
// - 3일 중 하나라도 보고 없음 → 판정 보류 (리그 유지)
// 주의: 오늘은 제외 (dates 계산에서 d=1부터 시작).

function runDailyLeagueBatch_() {
  migrateSheetIfNeeded_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var memberSheet = ss.getSheetByName('멤버');
  var usageSheet = ss.getSheetByName('사용량');
  var logSheet = ss.getSheetByName('리그이동기록');
  if (!memberSheet || !usageSheet || !logSheet) return;

  // 과거 3일 날짜 계산 (어제·그제·그그제, KST) — 오늘은 제외
  var today = new Date();
  var dates = [];
  for (var d = 1; d <= 3; d++) {
    var t = new Date(today.getTime() - d * 24 * 60 * 60 * 1000);
    dates.push(Utilities.formatDate(t, 'Asia/Seoul', 'yyyy-MM-dd'));
  }

  // 각 멤버의 최근 3일 스코어 수집 (v2 형식)
  var usage = usageSheet.getDataRange().getValues();
  var batchHdr = usage[0];
  var isBatchV2 = String(batchHdr[2] || '').indexOf('claude_') === 0;
  var batchHasV1 = batchHdr.length >= 9;
  var scoresByMember = {};  // nick → { date: score }
  for (var i = 1; i < usage.length; i++) {
    var nk = String(usage[i][0]).trim();
    if (!nk) continue;
    var dStr = toDateStr(usage[i][1]);
    if (dates.indexOf(dStr) < 0) continue;
    var bClIn, bClOut, bClCw, bClCr, bCxIn, bCxOut, bCxCr, bMid;
    if (isBatchV2) {
      bClIn = safeInt(usage[i][2]); bClOut = safeInt(usage[i][3]);
      bClCw = safeInt(usage[i][4]); bClCr = safeInt(usage[i][5]);
      bCxIn = safeInt(usage[i][6]); bCxOut = safeInt(usage[i][7]);
      bCxCr = safeInt(usage[i][8]);
      bMid  = String(usage[i][12] || '').trim() || LEGACY_MACHINE_ID;
    } else if (batchHasV1) {
      bClIn = safeInt(usage[i][2]); bClOut = safeInt(usage[i][3]);
      bClCw = safeInt(usage[i][4]); bClCr = safeInt(usage[i][5]);
      bCxIn = 0; bCxOut = 0; bCxCr = 0; bMid = LEGACY_MACHINE_ID;
    } else {
      bClIn = safeInt(usage[i][2]); bClOut = safeInt(usage[i][3]);
      bClCw = 0; bClCr = 0; bCxIn = 0; bCxOut = 0; bCxCr = 0; bMid = LEGACY_MACHINE_ID;
    }
    var sc = calcScoreV2_({
      claude_input_tokens: bClIn, claude_output_tokens: bClOut,
      claude_cache_creation_tokens: bClCw, claude_cache_read_tokens: bClCr,
      codex_input_tokens: bCxIn, codex_output_tokens: bCxOut,
      codex_cache_read_tokens: bCxCr
    });
    // (nickname, date)별 PC 행 수집 (pickActiveRows_ 적용 전)
    if (!scoresByMember[nk]) scoresByMember[nk] = {};
    if (!scoresByMember[nk][dStr]) scoresByMember[nk][dStr] = [];
    scoresByMember[nk][dStr].push({ mid: bMid, score: sc });
  }

  // (nickname, date)별 대표값 (legacy vs machine max 정책)
  function _sumDayScore(nick, d) {
    var rows = scoresByMember[nick] && scoresByMember[nick][d];
    if (!rows || !rows.length) return undefined;
    var picked = pickActiveRows_(rows);
    var sum = 0;
    picked.forEach(function(r){ sum += r.score || 0; });
    return sum;
  }

  var members = memberSheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  var THRESH = 10000000;  // 10M

  for (var mi = 1; mi < members.length; mi++) {
    var nick = String(members[mi][0]).trim();
    if (!nick) continue;
    var curLeague = String(members[mi][4] || '').trim() || LEAGUE_1M;

    // ── 판정 정책 ──
    // 강등(10M → 1M): 미보고일도 0M으로 간주. 보고 회피로 강등을 피하는 우회 차단.
    // 승급(1M → 10M): 3일 모두 보고 + 모두 ≥10M 필요. 데이터 부족 신규 유저 보호.
    var allReported = true;
    var allAbove = true;
    var allBelow = true;
    for (var di = 0; di < 3; di++) {
      var dayScore = _sumDayScore(nick, dates[di]);
      if (dayScore === undefined) {
        allReported = false;
        dayScore = 0;  // 강등 판정 시에는 0M 처리
      }
      if (dayScore < THRESH) allAbove = false;
      if (dayScore >= THRESH) allBelow = false;
    }

    var newLeague = curLeague;
    var reason = '';
    if (curLeague === LEAGUE_1M && allAbove && allReported) {
      newLeague = LEAGUE_10M;
      reason = '3일 연속 10M 이상 → 승격';
    } else if (curLeague === LEAGUE_10M && allBelow) {
      newLeague = LEAGUE_1M;
      reason = allReported
        ? '3일 연속 10M 미만 → 강등'
        : '3일 중 미보고 포함, 모두 10M 미만 → 강등';
    }

    if (newLeague !== curLeague) {
      memberSheet.getRange(mi + 1, 5).setValue(newLeague);
      logSheet.appendRow([now, nick, curLeague, newLeague, reason]);
    }
  }
}

// 자정 트리거 설치 (1회 실행: Apps Script 에디터에서 직접 실행)
function installDailyLeagueBatchTrigger() {
  // 기존 같은 이름 트리거 제거
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runDailyLeagueBatch_') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  // 매일 00:01 KST 근처 실행 (Apps Script nearMinute는 ±15분 근사)
  ScriptApp.newTrigger('runDailyLeagueBatch_')
    .timeBased()
    .everyDays(1)
    .atHour(0)
    .nearMinute(1)
    .inTimezone('Asia/Seoul')
    .create();
  return '리그 배치 트리거 설치 완료 (매일 00:01 KST ±15분)';
}

// 수동 테스트용 (Apps Script 에디터에서 직접 실행 가능)
function manualRunDailyLeagueBatch() {
  runDailyLeagueBatch_();
  return '리그 배치 수동 실행 완료';
}

// ════════════════════════════════════════════════════════
// 주간 벌금 정산 (cron + 시트 audit log)
// ════════════════════════════════════════════════════════
//
// 동작:
//   매주 월요일 00:30 KST에 cron이 지난주를 정산:
//     1) 각 멤버의 그 주 일별 토큰을 사용량/인증기록에서 집계
//     2) 임계값 비교 → missCount → fineAmount 계산 (FINE_FREE_DAYS=2)
//     3) 그 시점의 멤버 F열 status를 정산 시트에 freeze (소급 변경 차단)
//     4) 멤버 G열 deposit에서 fineAmount 자동 차감
//     5) 정산 시트에 audit row 추가
//   이미 정산된 (nickname, week, year)는 skip → idempotent.
//
// 시트: 주간정산 (lazy 생성)
//   nickname, week, year, status, missCount, chargedDays, fineAmount,
//   depositBefore, depositAfter, settledAt

var WEEKLY_SETTLEMENT_SHEET_ = '주간정산';
var WEEKLY_SETTLEMENT_HEADERS_ = [
  'nickname', 'week', 'year', 'status', 'missCount', 'chargedDays',
  'fineAmount', 'depositBefore', 'depositAfter', 'settledAt'
];
var FINE_PER_DAY_ = 10000;
var FINE_FREE_DAYS_ = 2;

function getWeeklySettlementSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(WEEKLY_SETTLEMENT_SHEET_);
  if (!sh) {
    sh = ss.insertSheet(WEEKLY_SETTLEMENT_SHEET_);
    sh.appendRow(WEEKLY_SETTLEMENT_HEADERS_);
  }
  return sh;
}

// 이미 정산된 (nickname, week, year)인지 확인.
function isAlreadySettled_(settlementRows, nickname, week, year) {
  for (var i = 0; i < settlementRows.length; i++) {
    if (String(settlementRows[i][0]).trim() === nickname &&
        Number(settlementRows[i][1]) === week &&
        Number(settlementRows[i][2]) === year) return true;
  }
  return false;
}

// 특정 주차(targetWeek, targetYear)의 모든 멤버를 정산.
// 이미 정산된 멤버는 skip. 정산된 row 수를 반환.
function runWeeklyFineSettlement_(targetWeek, targetYear) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var memberSheet = ss.getSheetByName('멤버');
  if (!memberSheet) throw new Error('멤버 시트 없음');
  var settlementSheet = getWeeklySettlementSheet_();

  // 기존 정산 row 캐시 (idempotency 체크용)
  var settled = [];
  if (settlementSheet.getLastRow() >= 2) {
    settled = settlementSheet.getRange(2, 1, settlementSheet.getLastRow() - 1, 3).getValues();
  }

  // 그 주차의 7일 날짜 문자열
  var weekDates = isoWeekDates_(targetWeek, targetYear);  // ['YYYY-MM-DD' x 7]

  // 사용량 시트 로드 (전체 — 작은 시트라 OK)
  var usageSheet = ss.getSheetByName('사용량');
  var usageMap = {};  // nickname → { date → score }
  if (usageSheet && usageSheet.getLastRow() >= 2) {
    var uVals = usageSheet.getRange(2, 1, usageSheet.getLastRow() - 1, USAGE_V2_HEADERS_.length).getValues();
    uVals.forEach(function(r) {
      var nick = String(r[0]).trim();
      var dateStr = formatDateStr_(r[1]);
      if (!nick || !dateStr) return;
      var score = computeWeightedScoreFromRow_(r);
      if (!usageMap[nick]) usageMap[nick] = {};
      usageMap[nick][dateStr] = score;
    });
  }

  // 인증기록 시트 (리그 정보 추출용)
  var recordSheet = ss.getSheetByName('인증기록');
  var leagueMap = {};  // nickname → { date → league }
  if (recordSheet && recordSheet.getLastRow() >= 2) {
    var rVals = recordSheet.getRange(2, 1, recordSheet.getLastRow() - 1, 10).getValues();
    rVals.forEach(function(r) {
      if (String(r[3]).trim() !== 'session') return;
      var nick = String(r[0]).trim();
      var resetsAt = formatDateStr_(r[8]);
      if (!nick || !resetsAt) return;
      var league = String(r[9] || '').trim();
      if (!league) return;
      if (!leagueMap[nick]) leagueMap[nick] = {};
      leagueMap[nick][resetsAt] = league;
    });
  }

  var members = memberSheet.getDataRange().getValues();
  var nowStr = new Date().toISOString();
  var settledCount = 0;

  for (var mi = 1; mi < members.length; mi++) {
    var nick = String(members[mi][0] || '').trim();
    if (!nick) continue;
    var statusRaw = String(members[mi][5] || '참여 중').trim();
    var depositRaw = members[mi][6];
    var depositBefore = (depositRaw === '' || depositRaw === null || depositRaw === undefined)
      ? 50000 : safeInt(depositRaw);

    if (isAlreadySettled_(settled, nick, targetWeek, targetYear)) continue;

    var curLeague = String(members[mi][4] || LEAGUE_1M).trim();
    if (curLeague !== LEAGUE_10M && curLeague !== LEAGUE_1M) curLeague = LEAGUE_1M;

    // 미달 카운트
    var missCount = 0;
    weekDates.forEach(function(dStr) {
      var tokens = (usageMap[nick] && usageMap[nick][dStr]) || 0;
      var rec = (leagueMap[nick] && leagueMap[nick][dStr]) || curLeague;
      var league = (rec === LEAGUE_10M || rec === LEAGUE_1M) ? rec : curLeague;
      var threshold = (league === LEAGUE_10M) ? 10000000 : 1000000;  // 1pt 임계값
      if (tokens < threshold) missCount++;
    });

    // 상태에 따른 fineAmount
    var chargedDays = 0;
    var fineAmount = 0;
    if (statusRaw === '참여 중' || statusRaw === '') {
      chargedDays = Math.max(0, missCount - FINE_FREE_DAYS_);
      fineAmount = chargedDays * FINE_PER_DAY_;
    } // exempt / 참여 안 함 / 기타 → 0

    var depositAfter = Math.max(0, depositBefore - fineAmount);

    // 정산 시트 row 추가 (status freeze)
    settlementSheet.appendRow([
      nick, targetWeek, targetYear, statusRaw, missCount, chargedDays,
      fineAmount, depositBefore, depositAfter, nowStr
    ]);

    // 멤버 G열 deposit 업데이트
    if (fineAmount > 0) {
      memberSheet.getRange(mi + 1, 7).setValue(depositAfter);
    }

    settledCount++;
  }

  return settledCount;
}

// 사용량 시트 row(13열, USAGE_V2_HEADERS_)에서 가중 스코어 계산.
// inp×1 + out×5 + cc×1.25 + cr×0.1 (Codex 컴포넌트 포함).
function computeWeightedScoreFromRow_(r) {
  var inp = safeInt(r[2]);
  var out = safeInt(r[3]);
  var cc  = safeInt(r[4]);
  var cr  = safeInt(r[5]);
  var cIn = safeInt(r[6]);
  var cOut = safeInt(r[7]);
  var cCr = safeInt(r[8]);
  return Math.round(
    (inp + cIn) * 1 +
    (out + cOut) * 5 +
    cc * 1.25 +
    (cr + cCr) * 0.1
  );
}

// 시트 셀의 날짜 표현(Date 객체 / 문자열 / epoch)을 'YYYY-MM-DD'로 정규화.
function formatDateStr_(v) {
  if (!v) return '';
  if (v instanceof Date) {
    var y = v.getFullYear(), m = v.getMonth() + 1, d = v.getDate();
    return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
  }
  var s = String(v).trim();
  if (s.length >= 10) return s.substring(0, 10);
  return '';
}

// ISO week + year → 그 주의 7일 (월~일) 'YYYY-MM-DD' 배열.
function isoWeekDates_(week, year) {
  // ISO 8601: 1월 4일이 속한 주를 그 해의 1주차로 정의.
  var jan4 = new Date(Date.UTC(year, 0, 4));
  var jan4Day = jan4.getUTCDay() || 7;  // 1=Mon, 7=Sun
  // 1주차 월요일
  var firstMon = new Date(jan4);
  firstMon.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  // 대상 주의 월요일
  var targetMon = new Date(firstMon);
  targetMon.setUTCDate(firstMon.getUTCDate() + (week - 1) * 7);
  var dates = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(targetMon);
    d.setUTCDate(targetMon.getUTCDate() + i);
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
    dates.push(y + '-' + ('0' + m).slice(-2) + '-' + ('0' + dd).slice(-2));
  }
  return dates;
}

// Cron 진입점: 어제(=일요일) 기준 ISO 주차를 정산.
// 매주 월요일 00:30 KST에 실행되도록 트리거 설치.
function runWeeklyFineSettlementCron_() {
  // KST 기준 어제
  var nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  var yesterdayKst = new Date(nowKst);
  yesterdayKst.setDate(nowKst.getDate() - 1);
  var iso = isoWeekFromDate_(yesterdayKst);
  var count = runWeeklyFineSettlement_(iso.week, iso.year);
  Logger.log('주간 정산 완료: ' + iso.year + '-W' + iso.week + ' / ' + count + '건');
}

function isoWeekFromDate_(date) {
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { week: weekNum, year: d.getUTCFullYear() };
}

// 주간 정산 cron 트리거 설치 (admin이 1회 실행).
function installWeeklyFineSettlementTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runWeeklyFineSettlementCron_') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('runWeeklyFineSettlementCron_')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(0)
    .nearMinute(30)
    .inTimezone('Asia/Seoul')
    .create();
  return '주간 정산 트리거 설치 완료 (매주 월요일 00:30 KST ±15분)';
}

// 수동 정산 (admin이 특정 주차를 강제 정산할 때).
function manualRunWeeklyFineSettlement(week, year) {
  var w = Number(week), y = Number(year);
  if (!w || !y) {
    var iso = isoWeekFromDate_(new Date(Date.now() - 24 * 3600 * 1000));  // 어제
    w = iso.week; y = iso.year;
  }
  var count = runWeeklyFineSettlement_(w, y);
  return '정산 완료: ' + y + '-W' + w + ' / ' + count + '건';
}

// ──────────────────────────────────────────────
// v1.0 시트 백업 (Codex 통합 전에 1회 실행)
// ──────────────────────────────────────────────
// 같은 Google Drive 폴더에 전체 시트 사본 생성.
// 원본은 그대로 두고, 'Claude Challenge v1.0 백업 (YYYY-MM-DD)' 이름의 사본이 생성됨.
//
// ⚠️ Apps Script에서 직접 실행할 때는 아래 `runBackupV1` 함수를 선택하세요.
//    (이름이 _로 끝나는 함수는 private이라 드롭다운에 안 보임)
function backupSpreadsheetV1_() {
  var src = SpreadsheetApp.getActiveSpreadsheet();
  var dateStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var backupName = 'Claude Challenge v1.0 백업 (' + dateStr + ')';
  var copy = src.copy(backupName);
  var msg = '✅ 백업 완료\n  이름: ' + backupName + '\n  URL:  ' + copy.getUrl();
  Logger.log(msg);
  return msg;
}

// Apps Script 에디터에서 직접 실행용 (public wrapper)
function runBackupV1() {
  return backupSpreadsheetV1_();
}

// ════════════════════════════════════════════════════════
// 평가 (VC IR 시뮬레이션) 모듈
// ════════════════════════════════════════════════════════
//
// 흐름:
//   1) evalStart  - 사용자가 1차 IR 자료 제출 → LLM 호출 1 → VC 3개 질문 반환 (각 VC 1개씩)
//   2) evalSubmit - 사용자가 3개 답변 제출      → LLM 호출 2 → 3 VC 평가 + 평균 + 종합
//   3) evalFeed   - 완료된 평가 피드 조회
//
// 시트: 평가 (21열, lazy 생성)
// API 키: PropertiesService.ScriptProperties.ANTHROPIC_API_KEY
// 모델:   PropertiesService.ScriptProperties.ANTHROPIC_MODEL (기본 claude-sonnet-4-5)
// 주당 횟수 제한: 2회 (status='completed' 만 카운트)

var EVAL_SHEET_NAME_ = '평가';
// 24열. status=인덱스 20, fileId=21, featuresJson=22, revealAt=23.
// status 진행: questions_pending → answering → evaluation_pending → completed
// revealAt(ms epoch): LLM은 빨리 끝나도 사용자에게 결과 노출은 5~10분 지연 (평가에 무게감 부여).
//                    Date.now() >= revealAt 시점에 status가 'completed'로 lazy flip.
var EVAL_HEADERS_ = [
  'id', 'nickname', 'week', 'year', 'submittedAt', 'completedAt',
  'projectName', 'oneLiner', 'description', 'githubUrl', 'demoUrl',
  'qaJson', 'vc1Krw', 'vc1Note', 'vc2Krw', 'vc2Note', 'vc3Krw', 'vc3Note',
  'avgKrw', 'summary', 'status', 'fileId', 'featuresJson', 'revealAt'
];

var EVAL_REVEAL_DELAY_MIN_MS = 5 * 60 * 1000;   // 5분
var EVAL_REVEAL_DELAY_MAX_MS = 10 * 60 * 1000;  // 10분
var EVAL_KRW_MIN_ = 5000;
var EVAL_KRW_MAX_ = 300000000;
var EVAL_WEEKLY_LIMIT_ = 1;
var EVAL_FILES_FOLDER_NAME_ = 'VC Eval Files';

var VC_NAMES_ = ['VC Vault', 'VC Rocket', 'VC Forge'];

// ── 부트스트랩 앵커 ──────────────────────────────────────
// 시스템 캘리브레이션을 위한 6개 기준점. 1만원~2억원 스펙트럼 커버.
// Phase 2 평가 시 항상 일부가 LLM에 주입되어 "이 정도 프로젝트는 대략 X원" 기준 형성.
// 시간이 지나며 챌린지 내 실제 평가가 추가 앵커로 합류 (자가 강화).
var BOOTSTRAP_ANCHORS_ = [
  {
    name: '매일 영어 단어 카톡봇',
    features: { service_type: 'toy', monetization: 'free', target_market: 'individual', tech_complexity: 'low', validation_stage: 'working' },
    krw: 10000,
    note: '대체재 다수, 진입장벽 0, 매출 모델 부재. 학습용 사이드 프로젝트 영역.'
  },
  {
    name: '친구 그룹 토큰 사용량 랭킹 사이트',
    features: { service_type: 'internal_tool', monetization: 'free', target_market: 'friends', tech_complexity: 'medium', validation_stage: 'working' },
    krw: 370000,
    note: '폐쇄적 친구 그룹 한정. 외부 시장 가치 제한적이나 내부 동기부여 도구로는 잘 작동.'
  },
  {
    name: '개인 코딩 학습 트래커 (LeetCode + GitHub 자동 집계)',
    features: { service_type: 'b2c_saas', monetization: 'freemium', target_market: 'individual', tech_complexity: 'medium', validation_stage: 'working' },
    krw: 7170000,
    note: '시장은 작지만 명확. 차별화·게이미피케이션 추가하면 PMF 가능. 현재는 잠재력 평가.'
  },
  {
    name: 'AI 회의록 요약기 (50인 회사 1곳 실사용)',
    features: { service_type: 'b2b_saas', monetization: 'license', target_market: 'company', tech_complexity: 'medium', validation_stage: 'paying_users' },
    krw: 14000000,
    note: 'B2B 라이선스 가능성 명확. 1곳 실사용. 카피캣 위험 있으나 매출 가시성 높음.'
  },
  {
    name: '개발자 토큰 사용량 알림 SaaS (월 9,900원, 베타 30명)',
    features: { service_type: 'b2b_saas', monetization: 'subscription', target_market: 'individual', tech_complexity: 'medium', validation_stage: 'paying_users' },
    krw: 25000000,
    note: '월 구독 검증 완료. 30명 유료 베타 = 강한 PMF 신호. 개발자 커뮤니티 입소문 가능.'
  },
  {
    name: '엔터프라이즈 프롬프트 관리 SaaS (ARR 1억+, 5+ 기업 고객)',
    features: { service_type: 'b2b_saas', monetization: 'subscription', target_market: 'company', tech_complexity: 'high', validation_stage: 'pmf' },
    krw: 200000000,
    note: '명확한 ICP, ARR 1억+, 기업 고객 5+, 기술 해자 (audit log·RBAC·on-prem). 본격 SaaS.'
  }
];

// admin이 1회 실행 (Apps Script 에디터에서 직접). 키는 깃에 안 담김.
function setAnthropicKey(key) {
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', String(key || '').trim());
  return 'OK';
}

function setAnthropicModel(model) {
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_MODEL', String(model || '').trim());
  return 'OK';
}

function getEvalSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(EVAL_SHEET_NAME_);
  if (!sh) {
    sh = ss.insertSheet(EVAL_SHEET_NAME_);
    sh.appendRow(EVAL_HEADERS_);
    return sh;
  }
  // 기존 시트 마이그레이션: 컬럼 부족 시 헤더 보강
  var lastCol = sh.getLastColumn();
  if (lastCol < EVAL_HEADERS_.length) {
    var missing = EVAL_HEADERS_.slice(lastCol);
    sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

// 첨부 파일을 저장할 Drive 폴더 (lazy 생성).
function getEvalFilesFolder_() {
  var folders = DriveApp.getFoldersByName(EVAL_FILES_FOLDER_NAME_);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(EVAL_FILES_FOLDER_NAME_);
}

// base64 → Drive 파일 저장. 성공 시 fileId, 실패 시 null.
function saveEvalFile_(evalId, base64, fileName, mimeType) {
  if (!base64 || !fileName || !mimeType) return null;
  try {
    var bytes = Utilities.base64Decode(base64);
    var safeName = String(fileName || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
    var blob = Utilities.newBlob(bytes, mimeType, evalId + '_' + safeName);
    var folder = getEvalFilesFolder_();
    var file = folder.createFile(blob);
    return file.getId();
  } catch (err) {
    Logger.log('saveEvalFile_ failed: ' + err.message);
    return null;
  }
}

// fileId → { mimeType, base64 } (LLM vision content용). 실패 시 null.
function getEvalFileBase64_(fileId) {
  if (!fileId) return null;
  try {
    var file = DriveApp.getFileById(fileId);
    var blob = file.getBlob();
    return {
      mimeType: blob.getContentType(),
      base64: Utilities.base64Encode(blob.getBytes())
    };
  } catch (err) {
    Logger.log('getEvalFileBase64_ failed: ' + err.message);
    return null;
  }
}

// imageData가 image/*면 vision content block으로 감싸 반환, 아니면 단일 텍스트.
function buildLLMUserContent_(textPrompt, imageData) {
  if (!imageData) return textPrompt;
  if (!/^image\/(png|jpeg|gif|webp)$/i.test(imageData.mimeType || '')) return textPrompt;
  return [
    { type: 'image', source: { type: 'base64', media_type: imageData.mimeType, data: imageData.base64 } },
    { type: 'text', text: textPrompt }
  ];
}

// 사용자 인증 (login 패턴 동일).
function authenticateMember_(nickname, password) {
  nickname = String(nickname || '').trim();
  password = String(password || '').trim();
  if (!nickname || !password) return { ok: false, error: '닉네임과 비밀번호가 필요합니다.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('멤버');
  if (!sheet) return { ok: false, error: '멤버 시트를 찾을 수 없습니다.' };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === nickname && String(data[i][1]).trim() === password) {
      return { ok: true, nickname: nickname };
    }
  }
  return { ok: false, error: '인증 실패' };
}

// ISO 8601 주차 (Date → {week, year}).
function getIsoWeek_(date) {
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { week: weekNum, year: d.getUTCFullYear() };
}

// 주 1회 제한 카운트.
// 'abandoned'(폐기됨) 외에는 모두 슬롯 점유로 간주:
//   questions_pending → answering → evaluation_pending → completed
// reveal 지연(5~10분) 동안에도 슬롯이 점유되어 중복 제출 차단.
// 'abandoned' 또는 unknown status는 카운트 제외 (폐기 시 슬롯 회수).
function countActiveEvalsThisWeek_(nickname) {
  var sh = getEvalSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var iso = getIsoWeek_(new Date());
  var values = sh.getRange(2, 1, last - 1, EVAL_HEADERS_.length).getValues();
  var ACTIVE = { 'questions_pending': 1, 'answering': 1, 'evaluation_pending': 1, 'completed': 1 };
  var count = 0;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (String(row[1]).trim() === nickname &&
        Number(row[2]) === iso.week &&
        Number(row[3]) === iso.year &&
        ACTIVE[String(row[20]).trim()]) {
      count++;
    }
  }
  return count;
}

// LLM이 코드펜스/잡담을 섞어 보내도 JSON만 추출.
function parseLLMJson_(text) {
  if (!text) return null;
  var s = String(text).trim();
  // ```json ... ``` 또는 ``` ... ``` 제거
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // 첫 { 부터 마지막 } 까지만
  var first = s.indexOf('{');
  var last = s.lastIndexOf('}');
  if (first < 0 || last < 0 || last <= first) return null;
  var jsonText = s.substring(first, last + 1);
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    return null;
  }
}

// 5,000 ~ 300,000,000 범위로 강제. 잘못된 숫자는 5,000.
function clampKrw_(v) {
  var n = Number(v);
  if (!isFinite(n) || isNaN(n)) return EVAL_KRW_MIN_;
  n = Math.round(n);
  if (n < EVAL_KRW_MIN_) return EVAL_KRW_MIN_;
  if (n > EVAL_KRW_MAX_) return EVAL_KRW_MAX_;
  return n;
}

// Anthropic Messages API 호출. 응답 텍스트(첫 content[0].text) 반환.
// userPrompt는 string 또는 content block array (vision용) 모두 가능.
// temperature: 미지정 시 0.7. 분류 작업은 0.0, 평가는 0.3 권장.
function callAnthropic_(systemPrompt, userPrompt, maxTokens, temperature) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Anthropic API 키가 설정되지 않았습니다. (admin: setAnthropicKey 실행 필요)');
  var model = props.getProperty('ANTHROPIC_MODEL') || 'claude-sonnet-4-5';

  var payload = {
    model: model,
    max_tokens: maxTokens || 1000,
    temperature: (typeof temperature === 'number') ? temperature : 0.7,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };

  var resp;
  try {
    resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    throw new Error('Anthropic 호출 실패: ' + err.message);
  }

  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Anthropic 오류 (' + code + '): ' + body.substring(0, 300));
  }
  var json;
  try { json = JSON.parse(body); } catch (e) { throw new Error('Anthropic 응답 파싱 실패'); }
  if (!json.content || !json.content[0] || !json.content[0].text) {
    throw new Error('Anthropic 응답에 content가 없습니다.');
  }
  return json.content[0].text;
}

// 입력 길이 제한 + 안전한 트림.
function clampStr_(v, max) {
  var s = String(v == null ? '' : v).trim();
  if (s.length > max) s = s.substring(0, max);
  return s;
}

// "X는? Y는?"처럼 LLM이 한 entry에 여러 질문 우겨넣은 경우, 첫 물음표까지만 보존.
// 물음표가 없으면 원문 유지.
function normalizeSingleQuestion_(s) {
  s = String(s || '').trim();
  var firstQ = s.indexOf('?');
  if (firstQ >= 0 && firstQ < s.length - 1) {
    s = s.substring(0, firstQ + 1).trim();
  }
  return s;
}

// GitHub URL에서 README 본문을 추출 (사용자 설명의 과장 검증용).
// raw.githubusercontent.com 호출 — auth 없음, 60req/hour 제한이지만 IR당 1회라 충분.
// main → master 순으로 시도. 모두 실패하면 빈 문자열.
function fetchGithubReadme_(url) {
  if (!url) return '';
  var m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
  if (!m) return '';
  var owner = m[1];
  var repo = m[2].replace(/\.git$/i, '').replace(/\/.*$/, '');
  var branches = ['main', 'master'];
  for (var bi = 0; bi < branches.length; bi++) {
    var rawUrl = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branches[bi] + '/README.md';
    try {
      var resp = UrlFetchApp.fetch(rawUrl, { muteHttpExceptions: true, followRedirects: true });
      if (resp.getResponseCode() === 200) {
        var body = resp.getContentText();
        // 4000자로 컷 (앞부분이 보통 가장 중요)
        return body.length > 4000 ? body.substring(0, 4000) + '\n…[truncated]' : body;
      }
    } catch (e) {
      Logger.log('fetchGithubReadme_ branch ' + branches[bi] + ' failed: ' + e.message);
    }
  }
  return '';
}

// 데모 URL의 실제 페이지를 fetch해서 title + meta description + 본문 텍스트 발췌.
// SPA의 경우 초기 HTML만 잡혀 빈약할 수 있으나, 적어도 사이트 존재성·기본 마케팅 카피는 확인됨.
function fetchDemoSnapshot_(url) {
  if (!url) return '';
  try {
    var resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClaudeChallenge/1.0)' }
    });
    if (resp.getResponseCode() !== 200) return '';
    var html = resp.getContentText();
    var parts = [];

    // <title>
    var titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleM) parts.push('TITLE: ' + titleM[1].trim());
    // meta description
    var metaM = html.match(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']+)["']/i);
    if (metaM) parts.push('META: ' + metaM[1].trim());
    // og:description
    var ogM = html.match(/<meta\s+[^>]*property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']+)["']/i);
    if (ogM) parts.push('OG: ' + ogM[1].trim());

    // 본문 텍스트: script/style 제거 후 태그 strip
    var text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--([\s\S]*?)-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      parts.push('BODY: ' + (text.length > 2000 ? text.substring(0, 2000) + '…[truncated]' : text));
    }
    return parts.join('\n');
  } catch (e) {
    Logger.log('fetchDemoSnapshot_ failed: ' + e.message);
    return '';
  }
}

// 사용자에게 보여지는 note/summary에서 내부 메커니즘(앵커) 언급 제거.
// LLM이 프롬프트 어겨도 안전망 — "앵커 #1 대비 -24%" 같은 패턴을 자동 strip.
function stripAnchorMentions_(text) {
  if (!text) return '';
  var s = String(text);
  // "앵커 #N (이름)" 또는 "앵커 #N" 또는 "앵커 #1번"
  s = s.replace(/앵커\s*#?\s*\d+\s*(?:번)?\s*(?:\([^)]*\))?\s*/g, '');
  // "앵커" 단독 + 한국어 조사
  s = s.replace(/앵커(?:들|는|은|을|를|와|과|의|로|에|에서|에게|보다|랑)?\s*/g, '');
  // "벤치마크", "기준점", "비교 대상" 같은 동의어
  s = s.replace(/(?:벤치마크|기준점|비교 ?대상)(?:와|과|는|은|을|를|의|로|에)?\s*/g, '');
  // "대비 [+-]X%" or "대비 ±X%" 또는 "대비 +200%"
  s = s.replace(/\s*대비\s*[+\-±]?\s*\d+(?:\.\d+)?\s*%/g, '');
  // 시작 부분에 남은 punctuation/whitespace 정리
  s = s.replace(/^[\s,.;:\-—·]+/, '');
  // 연속 공백
  s = s.replace(/\s{2,}/g, ' ').trim();
  // 끝의 공백+점 정리 (". ." 등)
  s = s.replace(/(\s*\.)+\s*\.?$/, '.');
  return s;
}

// ── Phase 0: 특성 추출 (앵커 매칭용 5차원 분류) ──
// LLM에게 프로젝트의 본질을 정해진 라벨로만 분류하게 함 (deterministic, temp=0).
// 실패 시 null 반환 → 평가는 부트스트랩 앵커만으로 계속 진행 (gracefully degrade).
function extractFeatures_(projectName, oneLiner, description, githubUrl, demoUrl) {
  var systemPrompt =
    '이 프로젝트의 본질을 분류하세요. 차원별 정해진 enum 값만 사용:\n\n' +
    'service_type: toy | internal_tool | b2c_saas | b2b_saas | marketplace | platform | content\n' +
    '  - toy: 학습용·개인 사이드 프로젝트\n' +
    '  - internal_tool: 친구·팀 내부 도구 (외부 매출 가능성 거의 없음)\n' +
    '  - b2c_saas: 일반 소비자 대상 SaaS\n' +
    '  - b2b_saas: 기업·전문가 대상 SaaS\n' +
    '  - marketplace: 양면 시장\n' +
    '  - platform: 플랫폼/인프라\n' +
    '  - content: 콘텐츠·미디어\n\n' +
    'monetization: free | ad | subscription | transaction | license | freemium\n\n' +
    'target_market: individual | friends | team | company | industry | mass\n' +
    '  - individual: 개인 사용자 (대중 X)\n' +
    '  - friends: 폐쇄적 친구 그룹\n' +
    '  - team: 5~50인 팀\n' +
    '  - company: 회사 단위\n' +
    '  - industry: 특정 산업·전문 도메인\n' +
    '  - mass: 일반 대중\n\n' +
    'tech_complexity: low | medium | high\n' +
    '  - low: 누구나 1~2시간이면 만듦 (cron + API call 등)\n' +
    '  - medium: 며칠~몇 주 작업, 일반 풀스택\n' +
    '  - high: 진짜 기술적 깊이 (분산 시스템·ML·인프라 등)\n\n' +
    'validation_stage: idea | working | beta_users | paying_users | pmf\n' +
    '  - idea: 아이디어만\n' +
    '  - working: 동작은 함\n' +
    '  - beta_users: 무료 베타 사용자 있음\n' +
    '  - paying_users: 유료 사용자 1명+\n' +
    '  - pmf: 명확한 PMF 신호 (반복 구매·NPS 높음·ARR 가시성)\n\n' +
    '반드시 JSON으로만 응답:\n' +
    '{"service_type":"...","monetization":"...","target_market":"...","tech_complexity":"...","validation_stage":"..."}';

  var userPrompt =
    '프로젝트명: ' + projectName + '\n' +
    '한줄 설명: ' + oneLiner + '\n' +
    '상세 설명: ' + description + '\n' +
    'GitHub: ' + (githubUrl || '(미제출)') + '\n' +
    '데모: ' + (demoUrl || '(미제출)');

  try {
    var raw = callAnthropic_(systemPrompt, userPrompt, 200, 0.0);
    var parsed = parseLLMJson_(raw);
    if (!parsed) return null;
    return {
      service_type: String(parsed.service_type || '').trim(),
      monetization: String(parsed.monetization || '').trim(),
      target_market: String(parsed.target_market || '').trim(),
      tech_complexity: String(parsed.tech_complexity || '').trim(),
      validation_stage: String(parsed.validation_stage || '').trim()
    };
  } catch (err) {
    Logger.log('extractFeatures_ failed: ' + err.message);
    return null;
  }
}

// ── 앵커 검색 + 유사도 ──
// service_type 매칭이 가장 큰 가중치 (×3), 나머지 차원은 ×1~2.
function scoreFeatureSimilarity_(a, b) {
  if (!a || !b) return 0;
  var s = 0;
  if (a.service_type && a.service_type === b.service_type) s += 3;
  if (a.monetization && a.monetization === b.monetization) s += 2;
  if (a.target_market && a.target_market === b.target_market) s += 1;
  if (a.tech_complexity && a.tech_complexity === b.tech_complexity) s += 1;
  if (a.validation_stage && a.validation_stage === b.validation_stage) s += 1;
  return s;
}

// 새 평가에 적용할 앵커 셋트 반환.
// 우선순위:
//   1) 챌린지 내 완료된 같은 service_type 평가 — 상위 유사도 3개
//   2) 부트스트랩 앵커 — 같은 service_type 우선 + 가치 spread 보장 위해 다른 티어 포함
function getRelevantAnchors_(features, currentEvalId) {
  var realAnchors = [];
  try {
    var sh = getEvalSheet_();
    var last = sh.getLastRow();
    if (last >= 2 && features) {
      var values = sh.getRange(2, 1, last - 1, EVAL_HEADERS_.length).getValues();
      var scored = [];
      for (var i = 0; i < values.length; i++) {
        var row = values[i];
        if (String(row[0]) === currentEvalId) continue;  // 자기 자신 제외
        if (String(row[20]).trim() !== 'completed') continue;
        var fJson = String(row[22] || '');
        if (!fJson) continue;
        var rowFeat = null;
        try { rowFeat = JSON.parse(fJson); } catch (e) { continue; }
        var sc = scoreFeatureSimilarity_(features, rowFeat);
        if (sc >= 3) {  // 최소 service_type 매칭 필수
          scored.push({
            score: sc,
            name: String(row[6]),
            features: rowFeat,
            krw: Number(row[18]) || 0,
            note: clampStr_(String(row[19]), 120)
          });
        }
      }
      scored.sort(function(a, b) { return b.score - a.score; });
      realAnchors = scored.slice(0, 3);
    }
  } catch (err) {
    Logger.log('getRelevantAnchors_ real read failed: ' + err.message);
  }

  // 부트스트랩: 같은 service_type 우선, 부족하면 가치 분포 spread 위해 다른 티어 추가
  var sameType = [], otherType = [];
  BOOTSTRAP_ANCHORS_.forEach(function(a) {
    if (features && features.service_type && a.features.service_type === features.service_type) sameType.push(a);
    else otherType.push(a);
  });
  // 다른 티어를 가치 차이가 큰 순으로 정렬해 일부 포함
  otherType.sort(function(a, b) { return b.krw - a.krw; });
  var bootAnchors;
  if (sameType.length >= 2) {
    // 같은 타입이 충분: 같은 타입 2 + 가치 spread 위해 극단(저/고) 1개씩
    bootAnchors = sameType.slice(0, 2);
    if (otherType.length > 0) bootAnchors.push(otherType[0]);                                  // 가장 비싼
    if (otherType.length > 1) bootAnchors.push(otherType[otherType.length - 1]);              // 가장 싼
  } else {
    // 같은 타입 부족: 모든 부트스트랩 6개 사용 (전체 스펙트럼 캘리브레이션)
    bootAnchors = sameType.concat(otherType);
  }

  return { real: realAnchors, bootstrap: bootAnchors };
}

function featuresInline_(f) {
  if (!f) return '(미분류)';
  return [f.service_type, f.monetization, f.target_market, f.tech_complexity, f.validation_stage]
    .filter(function(x) { return !!x; }).join(' / ');
}

function formatAnchorsForPrompt_(anchorsObj) {
  var lines = [];
  var idx = 1;

  if (anchorsObj.real && anchorsObj.real.length > 0) {
    lines.push('▼ 챌린지 내 평가된 유사 프로젝트 (실제 데이터)');
    anchorsObj.real.forEach(function(a) {
      lines.push('[앵커 #' + idx + '] ' + a.name);
      lines.push('  특성: ' + featuresInline_(a.features));
      lines.push('  평가: ' + a.krw.toLocaleString('ko-KR') + '원');
      lines.push('  근거: ' + a.note);
      idx++;
    });
    lines.push('');
  }

  lines.push('▼ 시스템 캘리브레이션 앵커 (가치 스펙트럼 기준점)');
  anchorsObj.bootstrap.forEach(function(a) {
    lines.push('[앵커 #' + idx + '] ' + a.name);
    lines.push('  특성: ' + featuresInline_(a.features));
    lines.push('  기준 가치: ' + a.krw.toLocaleString('ko-KR') + '원');
    lines.push('  근거: ' + a.note);
    idx++;
  });

  return lines.join('\n');
}

// ── evalStart ─────────────────────────────────────
// 흐름:
//   1) 검증 + rate limit
//   2) 첨부 파일 Drive 저장
//   3) 시트 row 삽입 (status='questions_pending')
//   4) LLM 호출 (이미지면 vision 포함)
//   5) row 업데이트: qaJson(빈 답변), status='answering'
//   6) 응답 반환
//
// 클라이언트가 fetch를 await하지 않더라도 서버는 끝까지 처리하므로,
// 클라이언트가 도중에 reload해도 evalStatus 폴링으로 결과 회수 가능.
function handleEvalStart(params) {
  var auth = authenticateMember_(params.nickname, params.password);
  if (!auth.ok) return { success: false, error: auth.error };
  var nickname = auth.nickname;

  var projectName = clampStr_(params.projectName, 30);
  var oneLiner    = clampStr_(params.oneLiner, 100);
  var description = clampStr_(params.description, 1000);
  var githubUrl   = clampStr_(params.githubUrl, 200);
  var demoUrl     = clampStr_(params.demoUrl, 200);
  var fileBase64  = String(params.fileBase64 || '');
  var fileName    = clampStr_(params.fileName, 100);
  var fileType    = clampStr_(params.fileType, 80);
  var hasFile     = !!(fileBase64 && fileName && fileType);

  if (!projectName || !oneLiner || !description) {
    return { success: false, error: '프로젝트명, 한줄 설명, 상세 설명은 필수입니다.' };
  }
  if (description.length < 30) {
    return { success: false, error: '상세 설명은 최소 30자 이상 작성해주세요.' };
  }
  // GitHub URL / 데모 URL / 파일 셋 중 최소 1개는 필수
  if (!githubUrl && !demoUrl && !hasFile) {
    return { success: false, error: 'GitHub URL · 데모 URL · 파일 첨부 중 최소 한 가지는 제출해야 합니다.' };
  }

  var weekCount = countActiveEvalsThisWeek_(nickname);
  if (weekCount >= EVAL_WEEKLY_LIMIT_) {
    return { success: false, error: '이번 주 평가 횟수(' + EVAL_WEEKLY_LIMIT_ + '회)를 모두 사용했습니다.' };
  }

  // 1단계: row 먼저 삽입 (status=questions_pending)
  var evalId = Utilities.getUuid();
  var iso = getIsoWeek_(new Date());
  var nowIso = new Date().toISOString();
  var sh = getEvalSheet_();

  var fileId = '';
  if (hasFile) {
    fileId = saveEvalFile_(evalId, fileBase64, fileName, fileType) || '';
  }

  var row = new Array(EVAL_HEADERS_.length);
  for (var k = 0; k < row.length; k++) row[k] = '';
  row[0] = evalId;
  row[1] = nickname;
  row[2] = iso.week;
  row[3] = iso.year;
  row[4] = nowIso;
  row[6] = projectName;
  row[7] = oneLiner;
  row[8] = description;
  row[9] = githubUrl;
  row[10] = demoUrl;
  row[20] = 'questions_pending';
  row[21] = fileId;
  sh.appendRow(row);
  var insertedRowNum = sh.getLastRow();

  // 1.5단계: Phase 0 — 특성 추출 (앵커 매칭용 5차원 분류)
  // 실패해도 평가는 계속 진행 (gracefully degrade — 부트스트랩 앵커만 사용)
  var features = extractFeatures_(projectName, oneLiner, description, githubUrl, demoUrl);
  if (features) {
    sh.getRange(insertedRowNum, 23).setValue(JSON.stringify(features));  // featuresJson (column W = 23, 1-indexed)
  }

  // 2단계: LLM 호출 (vision 가능)
  var fileLabel = hasFile ? ('첨부: ' + fileName + ' (' + fileType + (/^image\//i.test(fileType) ? ', VC가 직접 확인합니다' : '') + ')') : '(첨부 없음)';

  var systemPrompt =
    '당신은 한국 VC 패널입니다. 멤버는 3명이며 각자의 시각이 다릅니다:\n\n' +
    '1. VC Vault (보수 엔터프라이즈): 매출 모델, 유료 전환, 운영 비용 중시. 토이 프로젝트는 박하게.\n' +
    '2. VC Rocket (얼리 그로스): 시장 잠재력, 바이럴, UX 중시. PMF 보이면 후하게.\n' +
    '3. VC Forge (기술 시드): 코드 품질, 엔지니어링 깊이, 기술 해자 중시. 클론은 박하게.\n\n' +
    '각 VC가 IR 후속 질문을 1개씩(총 3개) 작성합니다.\n\n' +
    '★ 절대 규칙 ★\n' +
    '- 각 VC당 정확히 1개의 질문 — 물음표("?")는 정확히 1번만 사용.\n' +
    '- "X는? Y는?"처럼 한 항목에 여러 궁금증을 몰아넣는 것은 금지.\n' +
    '- 한 질문당 30자 이내, 한 문장으로 끝낼 것.\n' +
    '- 각 VC의 시각이 명확히 드러나도록.\n' +
    '- 평가에 결정적인 단 하나의 정보를 끌어내는 질문일 것.\n\n' +
    '반드시 JSON으로만 응답 (다른 텍스트 금지):\n' +
    '{"questions":[{"vc":"VC Vault","q":"..."},{"vc":"VC Rocket","q":"..."},{"vc":"VC Forge","q":"..."}]}';

  var userText =
    '프로젝트명: ' + projectName + '\n' +
    '한줄 설명: ' + oneLiner + '\n' +
    '상세 설명: ' + description + '\n' +
    'GitHub: ' + (githubUrl || '(미제출)') + '\n' +
    '데모: ' + (demoUrl || '(미제출)') + '\n' +
    fileLabel;

  var imageData = fileId ? getEvalFileBase64_(fileId) : null;
  var userContent = buildLLMUserContent_(userText, imageData);

  var rawText;
  try {
    rawText = callAnthropic_(systemPrompt, userContent, 600);
  } catch (err) {
    // LLM 실패 → row를 abandoned 처리하고 에러 반환
    sh.getRange(insertedRowNum, 21).setValue('abandoned');
    return { success: false, error: err.message };
  }

  var parsed = parseLLMJson_(rawText);
  if (!parsed || !parsed.questions || !parsed.questions.length) {
    sh.getRange(insertedRowNum, 21).setValue('abandoned');
    return { success: false, error: 'VC 질문 생성에 실패했습니다. 다시 시도해주세요.' };
  }

  // 질문 정규화 (vc 이름 정확하지 않으면 순서대로 매핑)
  // + 첫 물음표 이후는 잘라내서 단일 질문 강제 (LLM이 규칙 어겨도 안전)
  var questions = [];
  for (var i = 0; i < parsed.questions.length && questions.length < 3; i++) {
    var q = parsed.questions[i] || {};
    var vc = String(q.vc || '').trim();
    if (VC_NAMES_.indexOf(vc) < 0) vc = VC_NAMES_[questions.length];
    var qText = clampStr_(q.q || q.question || '', 80);
    qText = normalizeSingleQuestion_(qText);
    if (!qText) continue;
    questions.push({ vc: vc, question: qText });
  }
  if (questions.length < 3) {
    sh.getRange(insertedRowNum, 21).setValue('abandoned');
    return { success: false, error: 'VC 질문이 부족합니다. 다시 시도해주세요.' };
  }

  // 3단계: 시트에 questions 저장 + status=answering
  var qaSeed = questions.map(function(q) { return { vc: q.vc, question: q.question, answer: '' }; });
  sh.getRange(insertedRowNum, 12).setValue(JSON.stringify(qaSeed)); // qaJson (column L = 12, 1-indexed)
  sh.getRange(insertedRowNum, 21).setValue('answering');             // status (column U = 21)

  return {
    success: true,
    evalId: evalId,
    status: 'answering',
    questions: questions
  };
}

// ── evalSubmit ────────────────────────────────────
// 흐름:
//   1) 검증, row 찾기
//   2) qaJson에 답변 저장 + status='evaluation_pending' (즉시 반영)
//   3) LLM 호출 (vision 포함)
//   4) row 업데이트: 평가 결과 + status='completed'
//   5) 응답 반환
//
// 클라이언트가 fetch를 await하지 않더라도 evalStatus 폴링으로 결과 회수 가능.
function handleEvalSubmit(params) {
  var auth = authenticateMember_(params.nickname, params.password);
  if (!auth.ok) return { success: false, error: auth.error };
  var nickname = auth.nickname;

  var evalId = String(params.evalId || '').trim();
  if (!evalId) return { success: false, error: 'evalId가 필요합니다.' };

  var answers = Array.isArray(params.answers) ? params.answers : [];
  if (answers.length < 3) return { success: false, error: '3개 답변이 모두 필요합니다.' };

  // 시트에서 row 찾기
  var sh = getEvalSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { success: false, error: '평가 기록이 없습니다.' };
  var values = sh.getRange(2, 1, last - 1, EVAL_HEADERS_.length).getValues();
  var rowIdx = -1;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === evalId) { rowIdx = i; break; }
  }
  if (rowIdx < 0) return { success: false, error: '평가를 찾을 수 없습니다.' };
  var row = values[rowIdx];
  if (String(row[1]).trim() !== nickname) return { success: false, error: '본인 평가만 제출할 수 있습니다.' };
  var curStatus = String(row[20]).trim();
  if (curStatus === 'completed') return { success: false, error: '이미 완료된 평가입니다.' };
  if (curStatus === 'evaluation_pending') return { success: false, error: '이미 평가가 진행 중입니다. 잠시 후 다시 확인해주세요.' };
  if (curStatus !== 'answering') return { success: false, error: '답변을 받을 수 있는 단계가 아닙니다. (현재: ' + curStatus + ')' };

  var projectName = String(row[6]);
  var oneLiner    = String(row[7]);
  var description = String(row[8]);
  var githubUrl   = String(row[9]);
  var demoUrl     = String(row[10]);
  var fileId      = String(row[21] || '');

  // Q&A 정규화
  var qa = [];
  for (var j = 0; j < Math.min(answers.length, 3); j++) {
    var a = answers[j] || {};
    var vc = VC_NAMES_.indexOf(String(a.vc || '')) >= 0 ? a.vc : VC_NAMES_[j];
    qa.push({
      vc: vc,
      question: clampStr_(a.question, 80),
      answer: clampStr_(a.answer, 200)
    });
  }

  // 즉시 status='evaluation_pending'로 표시 (폴링 클라이언트가 진행 상태를 볼 수 있도록)
  var sheetRow = rowIdx + 2;  // 1-indexed + header
  sh.getRange(sheetRow, 12).setValue(JSON.stringify(qa)); // qaJson
  sh.getRange(sheetRow, 21).setValue('evaluation_pending');
  SpreadsheetApp.flush();

  // 특성 + 앵커 로딩 (Phase 0 결과 활용)
  var featuresJsonRaw = String(row[22] || '');
  var features = null;
  try { features = JSON.parse(featuresJsonRaw); } catch (e) { features = null; }
  var anchors = getRelevantAnchors_(features, evalId);
  var anchorsText = formatAnchorsForPrompt_(anchors);

  var systemPrompt =
    '당신은 한국 VC 패널 VC Vault / VC Rocket / VC Forge입니다.\n\n' +
    '페르소나 (반드시 차별화하여 평가):\n' +
    '- VC Vault (보수 엔터프라이즈): 매출 모델·유료 전환·운영 비용 중시. 같은 앵커 보고도 가장 박하게 평가.\n' +
    '- VC Rocket (얼리 그로스): 시장 잠재력·바이럴·UX 중시. PMF 보이면 가장 후하게 평가.\n' +
    '- VC Forge (기술 시드): 코드 품질·엔지니어링 깊이·기술 해자 중시. 클론은 박하게, 진짜 기술은 후하게.\n\n' +
    '═══════════════════════════════════════\n' +
    '★ 평가 핵심 원칙 — 앵커 기반 비교 평가 ★\n' +
    '═══════════════════════════════════════\n\n' +
    '아래 앵커들은 이 챌린지의 평가 기준점입니다. 새 프로젝트는 반드시 이 앵커들과 비교하여 정량적 위치를 결정하세요.\n\n' +
    anchorsText + '\n\n' +
    '═══════════════════════════════════════\n' +
    '★ 가장 중요한 원칙 — 실제 콘텐츠 우선 신뢰 ★\n' +
    '═══════════════════════════════════════\n' +
    '사용자가 작성한 설명은 과장될 수 있습니다. user prompt 후반부에 GitHub README 발췌나 데모 페이지 스냅샷이 첨부되어 있다면, 그것이 가장 신뢰할 수 있는 평가 근거입니다.\n\n' +
    '판단 규칙:\n' +
    '- 설명과 실제 콘텐츠가 일치 → 정상 평가\n' +
    '- 설명은 화려한데 실제 콘텐츠 빈약·미완성 → 명확히 박하게 (과장 페널티)\n' +
    '- 설명은 겸손한데 실제 콘텐츠 완성도 높음 → 가산점\n' +
    '- 첨부 스냅샷이 비어있거나 fetch 실패 표시 → URL 제출만으로 가치 인정하되, 검증 부족 → 보수적 평가\n' +
    '- "PMF/유료 사용자" 주장 vs 실제 코드/페이지가 토이 수준이면 → 가차없이 박하게.\n\n' +
    '═══════════════════════════════════════\n' +
    '★ 내부 사고 규칙 (사용자에게 공개 금지) ★\n' +
    '═══════════════════════════════════════\n' +
    '1. 내부적으로: 새 프로젝트의 특성과 가장 유사한 앵커를 1~2개 식별.\n' +
    '2. 그 앵커 대비 본질적 우열 판단:\n' +
    '   - 더 좋다면: 앵커 가치 +20% ~ +200%\n' +
    '   - 비슷하지만 작은 차이: ±5% ~ ±20%\n' +
    '   - 나쁘다면: -20% ~ -80%\n' +
    '3. 절대 금지: 앵커와 동일 KRW 부여. 미묘한 차이라도 가격에 반영.\n' +
    '4. 절대 금지: 모든 VC가 동일 KRW. 페르소나에 따라 명확히 다르게 (VC 간 ±20%~50% 차이).\n\n' +
    '═══════════════════════════════════════\n' +
    '★ note 작성 규칙 (사용자가 직접 보는 텍스트) ★\n' +
    '═══════════════════════════════════════\n' +
    '- 프로젝트의 본질적 강점/약점만 한줄 평가 (60자 이내).\n' +
    '- 절대 금지 단어/표현: "앵커", "#1", "#2", "#3", "대비 +N%", "대비 -N%", "벤치마크", "비교 대상".\n' +
    '- 비교 대상이 아닌 프로젝트 자체의 특성으로 표현.\n' +
    '   ❌ "앵커 #1 대비 -24%. 매출 모델 약함"\n' +
    '   ✅ "매출 모델 부재로 외부 가치 제한적"\n' +
    '- summary도 동일 규칙 (앵커 언급 절대 금지). 3 VC의 결론과 차이를 자연스럽게 종합.\n\n' +
    '═══════════════════════════════════════\n' +
    '★ 절대 상한 ★\n' +
    '═══════════════════════════════════════\n' +
    '- 5,000원 이상 ~ 300,000,000원 이하 정수만 가능.\n' +
    '- note는 60자 이내, summary는 120자 이내.\n\n' +
    '═══════════════════════════════════════\n' +
    '★ 응답 형식 (JSON만, 다른 텍스트 금지) ★\n' +
    '═══════════════════════════════════════\n' +
    '{\n' +
    ' "evaluations":[\n' +
    '   {"vc":"VC Vault","krw":<int>,"note":"<프로젝트 자체의 특성·강약점, 앵커 언급 금지>"},\n' +
    '   {"vc":"VC Rocket","krw":<int>,"note":"..."},\n' +
    '   {"vc":"VC Forge","krw":<int>,"note":"..."}\n' +
    ' ],\n' +
    ' "summary":"<3 VC의 결론과 차이를 자연스럽게 종합. 앵커 언급 금지.>"\n' +
    '}';

  // 실제 URL 콘텐츠 fetch — 사용자 설명의 과장 검증용
  var githubSnapshot = githubUrl ? fetchGithubReadme_(githubUrl) : '';
  var demoSnapshot = demoUrl ? fetchDemoSnapshot_(demoUrl) : '';

  var userText = '[사용자가 작성한 1차 자료 — 과장 가능성 있음, 실제 콘텐츠로 검증할 것]\n' +
    '프로젝트명: ' + projectName + '\n' +
    '한줄 설명: ' + oneLiner + '\n' +
    '상세 설명: ' + description + '\n' +
    'GitHub: ' + (githubUrl || '(미제출)') + '\n' +
    '데모: ' + (demoUrl || '(미제출)') + '\n' +
    (fileId ? '첨부 파일: 있음 (image면 직접 확인)\n' : '첨부 파일: 없음\n') +
    '\n[추출된 특성]\n' + featuresInline_(features) + '\n';

  // ── 실제 URL 콘텐츠 (가장 신뢰할 수 있는 근거) ──
  if (githubSnapshot) {
    userText += '\n[★ GitHub README 실제 내용 — 가장 신뢰할 만한 근거 ★]\n' + githubSnapshot + '\n';
  } else if (githubUrl) {
    userText += '\n[GitHub README fetch 실패 또는 비공개/없음 — 검증 부족으로 보수적 평가]\n';
  }
  if (demoSnapshot) {
    userText += '\n[★ 데모 페이지 실제 스냅샷 — 가장 신뢰할 만한 근거 ★]\n' + demoSnapshot + '\n';
  } else if (demoUrl) {
    userText += '\n[데모 URL fetch 실패 또는 빈 페이지 — 검증 부족으로 보수적 평가]\n';
  }

  userText += '\n[Q&A]\n';
  for (var q = 0; q < qa.length; q++) {
    userText += qa[q].vc + ' Q: ' + qa[q].question + '\nA: ' + qa[q].answer + '\n';
  }

  var imageData2 = fileId ? getEvalFileBase64_(fileId) : null;
  var userContent2 = buildLLMUserContent_(userText, imageData2);

  var rawText;
  try {
    // temperature 0.3: 일관성 우선 (앵커 기반 평가의 안정성 확보)
    rawText = callAnthropic_(systemPrompt, userContent2, 1500, 0.3);
  } catch (err) {
    // LLM 실패 → 답변 단계로 되돌림 (사용자가 다시 시도 가능)
    sh.getRange(sheetRow, 21).setValue('answering');
    return { success: false, error: err.message };
  }

  var parsed = parseLLMJson_(rawText);
  if (!parsed || !Array.isArray(parsed.evaluations) || parsed.evaluations.length < 3) {
    sh.getRange(sheetRow, 21).setValue('answering');
    return { success: false, error: 'VC 평가 생성에 실패했습니다. 다시 시도해주세요.' };
  }

  // VC 이름 매핑 (순서 보장)
  function findEval(name) {
    for (var idx = 0; idx < parsed.evaluations.length; idx++) {
      if (String(parsed.evaluations[idx].vc || '').trim() === name) return parsed.evaluations[idx];
    }
    return parsed.evaluations[0];
  }
  var eVault  = findEval('VC Vault');
  var eRocket = findEval('VC Rocket');
  var eForge  = findEval('VC Forge');

  var k1 = clampKrw_(eVault && eVault.krw);
  var k2 = clampKrw_(eRocket && eRocket.krw);
  var k3 = clampKrw_(eForge && eForge.krw);
  // note/summary는 사용자에게 직접 노출되므로 앵커 언급 제거 (안전망)
  var n1 = stripAnchorMentions_(clampStr_(eVault && eVault.note, 100));
  var n2 = stripAnchorMentions_(clampStr_(eRocket && eRocket.note, 100));
  var n3 = stripAnchorMentions_(clampStr_(eForge && eForge.note, 100));
  var avg = Math.round((k1 + k2 + k3) / 3);
  var summary = stripAnchorMentions_(clampStr_(parsed.summary, 200));

  // 시트에 평가 결과 저장. status는 'evaluation_pending' 유지 — revealAt 도달 시 lazy flip.
  // 사용자에게는 5~10분 사이에 평가가 "지연 노출"되어 묵직한 검토 시간감을 줌.
  var revealAt = Date.now() + EVAL_REVEAL_DELAY_MIN_MS +
    Math.floor(Math.random() * (EVAL_REVEAL_DELAY_MAX_MS - EVAL_REVEAL_DELAY_MIN_MS));

  sh.getRange(sheetRow, 13).setValue(k1);
  sh.getRange(sheetRow, 14).setValue(n1);
  sh.getRange(sheetRow, 15).setValue(k2);
  sh.getRange(sheetRow, 16).setValue(n2);
  sh.getRange(sheetRow, 17).setValue(k3);
  sh.getRange(sheetRow, 18).setValue(n3);
  sh.getRange(sheetRow, 19).setValue(avg);
  sh.getRange(sheetRow, 20).setValue(summary);
  sh.getRange(sheetRow, 21).setValue('evaluation_pending');  // reveal 전까지 pending 유지
  sh.getRange(sheetRow, 24).setValue(revealAt);              // revealAt (column X)
  // completedAt은 reveal 시점에 evalStatus/evalFeed가 lazy 설정

  // 클라이언트는 폴링으로 reveal을 회수. 응답에 result 포함하지 않음.
  return {
    success: true,
    status: 'evaluation_pending',
    revealAt: revealAt
  };
}

// 평가가 reveal 시점에 도달하면 status='completed'로 flip + completedAt 설정.
// row는 sh.getRange(2,1,...,EVAL_HEADERS_.length).getValues()의 0-indexed row 객체.
// rowIdx는 그 row의 0-indexed 위치. 시트 1-indexed 행 번호는 rowIdx+2.
// 반환: 실제로 flip이 일어났는지 여부. row 객체도 in-place 갱신함.
function maybeFlipReveal_(sh, row, rowIdx) {
  if (String(row[20]).trim() !== 'evaluation_pending') return false;
  var revealAtVal = Number(row[23]) || 0;
  if (!revealAtVal || Date.now() < revealAtVal) return false;
  var sheetRowNum = rowIdx + 2;
  var revealIso = new Date(revealAtVal).toISOString();
  sh.getRange(sheetRowNum, 6).setValue(revealIso);     // completedAt
  sh.getRange(sheetRowNum, 21).setValue('completed');  // status flip
  row[5] = revealIso;
  row[20] = 'completed';
  return true;
}

// ── evalFeed ──────────────────────────────────────
function handleEvalFeed(params) {
  var auth = authenticateMember_(params.nickname, params.password);
  if (!auth.ok) return { success: false, error: auth.error };

  var offset = Math.max(0, parseInt(params.offset, 10) || 0);
  var limit = Math.max(1, Math.min(50, parseInt(params.limit, 10) || 20));

  var sh = getEvalSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { success: true, items: [], total: 0, hasMore: false };

  var values = sh.getRange(2, 1, last - 1, EVAL_HEADERS_.length).getValues();
  // Lazy reveal flip: revealAt 도달한 evaluation_pending row를 일괄 completed로 전환
  for (var fi = 0; fi < values.length; fi++) {
    maybeFlipReveal_(sh, values[fi], fi);
  }
  var completed = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][20]).trim() === 'completed') completed.push(values[i]);
  }
  // completedAt(인덱스 5) DESC
  completed.sort(function(a, b) {
    return String(b[5]).localeCompare(String(a[5]));
  });

  var total = completed.length;
  var slice = completed.slice(offset, offset + limit);
  // 본인 row에만 GitHub/데모/파일 정보 노출. 타인 row는 소스 보호 차원에서 제외.
  // ("내 평가 피드" sub-tab에서는 본인만 필터링되므로 정상 표시됨)
  var requesterNick = auth.nickname;
  var items = slice.map(function(r) {
    var rowNick = String(r[1]);
    var isOwn = (rowNick === requesterNick);
    return {
      evalId:      String(r[0]),
      nickname:    rowNick,
      completedAt: String(r[5]),
      projectName: String(r[6]),
      oneLiner:    String(r[7]),
      description: String(r[8]),
      githubUrl:   isOwn ? String(r[9])  : '',
      demoUrl:     isOwn ? String(r[10]) : '',
      hasFile:     isOwn ? !!String(r[21] || '') : false,
      evaluations: [
        { vc: 'VC Vault',  krw: Number(r[12]) || 0, note: String(r[13]) },
        { vc: 'VC Rocket', krw: Number(r[14]) || 0, note: String(r[15]) },
        { vc: 'VC Forge',  krw: Number(r[16]) || 0, note: String(r[17]) }
      ],
      avgKrw:  Number(r[18]) || 0,
      summary: String(r[19])
    };
  });

  // ── 랭킹 계산 (주간/월간/누적, 멤버별 avgKrw 합계 1위) ──
  var now = new Date();
  var iso = getIsoWeek_(now);
  var monthKey = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
  var sums = { week: {}, month: {}, all: {} };
  completed.forEach(function(r) {
    var nick = String(r[1]).trim();
    var krw = Number(r[18]) || 0;
    var compAt = String(r[5]);
    sums.all[nick] = (sums.all[nick] || 0) + krw;
    if (compAt.length >= 7 && compAt.substring(0, 7) === monthKey) {
      sums.month[nick] = (sums.month[nick] || 0) + krw;
    }
    var rWeekRaw = Number(r[2]); var rYearRaw = Number(r[3]);
    if (rWeekRaw === iso.week && rYearRaw === iso.year) {
      sums.week[nick] = (sums.week[nick] || 0) + krw;
    }
  });
  function topMember_(map) {
    var best = null;
    Object.keys(map).forEach(function(nick) {
      if (!best || map[nick] > best.krw) best = { nickname: nick, krw: map[nick] };
    });
    return best;
  }
  var rankings = {
    week:  topMember_(sums.week),
    month: topMember_(sums.month),
    all:   topMember_(sums.all)
  };

  return {
    success: true,
    items: items,
    total: total,
    hasMore: offset + limit < total,
    rankings: rankings
  };
}

// ── evalStatus ────────────────────────────────────
// 진행 중인 IR의 현재 상태 + 가능한 데이터 (questions / result)를 반환.
// 클라이언트가 evalStart/evalSubmit 응답을 놓쳤을 때 (reload 등) 폴링용.
function handleEvalStatus(params) {
  var auth = authenticateMember_(params.nickname, params.password);
  if (!auth.ok) return { success: false, error: auth.error };
  var nickname = auth.nickname;

  var evalId = String(params.evalId || '').trim();
  if (!evalId) return { success: false, error: 'evalId가 필요합니다.' };

  var sh = getEvalSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { success: false, error: '평가를 찾을 수 없습니다.' };
  var values = sh.getRange(2, 1, last - 1, EVAL_HEADERS_.length).getValues();
  var row = null;
  var rowIdx = -1;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === evalId) { row = values[i]; rowIdx = i; break; }
  }
  if (!row) return { success: false, error: '평가를 찾을 수 없습니다.' };
  if (String(row[1]).trim() !== nickname) return { success: false, error: '본인 평가만 조회할 수 있습니다.' };

  // Lazy reveal flip: revealAt 도달한 evaluation_pending → completed
  maybeFlipReveal_(sh, row, rowIdx);

  var status = String(row[20]).trim();
  var resp = {
    success: true,
    evalId: evalId,
    status: status,
    revealAt: Number(row[23]) || 0,
    project: {
      projectName: String(row[6]),
      oneLiner: String(row[7]),
      description: String(row[8]),
      githubUrl: String(row[9]),
      demoUrl: String(row[10]),
      hasFile: !!String(row[21] || '')
    }
  };

  // qaJson 파싱 → status가 answering 이상이면 questions 노출
  var qa = null;
  try { qa = JSON.parse(String(row[11] || '[]')); } catch (e) { qa = []; }
  if (status === 'answering' || status === 'evaluation_pending' || status === 'completed') {
    resp.questions = (qa || []).map(function(q) { return { vc: q.vc, question: q.question }; });
    resp.answers = (qa || []).map(function(q) { return q.answer || ''; });
  }

  if (status === 'completed') {
    resp.result = {
      evaluations: [
        { vc: 'VC Vault',  krw: Number(row[12]) || 0, note: String(row[13]) },
        { vc: 'VC Rocket', krw: Number(row[14]) || 0, note: String(row[15]) },
        { vc: 'VC Forge',  krw: Number(row[16]) || 0, note: String(row[17]) }
      ],
      avgKrw:  Number(row[18]) || 0,
      summary: String(row[19])
    };
  }

  return resp;
}

// ── evalDiscard ────────────────────────────────────
// 진행 중(또는 답변 단계)의 IR을 'abandoned'로 마킹하여 주간 카운트에서 제외.
// 이미 'completed'된 평가는 폐기 불가 (audit 일관성).
function handleEvalDiscard(params) {
  var auth = authenticateMember_(params.nickname, params.password);
  if (!auth.ok) return { success: false, error: auth.error };
  var nickname = auth.nickname;

  var evalId = String(params.evalId || '').trim();
  if (!evalId) return { success: false, error: 'evalId가 필요합니다.' };

  var sh = getEvalSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { success: false, error: '평가를 찾을 수 없습니다.' };
  var values = sh.getRange(2, 1, last - 1, EVAL_HEADERS_.length).getValues();
  var rowIdx = -1;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === evalId) { rowIdx = i; break; }
  }
  if (rowIdx < 0) return { success: false, error: '평가를 찾을 수 없습니다.' };
  if (String(values[rowIdx][1]).trim() !== nickname) {
    return { success: false, error: '본인 평가만 폐기할 수 있습니다.' };
  }
  var curStatus = String(values[rowIdx][20]).trim();
  if (curStatus === 'completed') {
    return { success: false, error: '이미 완료된 평가는 폐기할 수 없습니다.' };
  }
  if (curStatus === 'abandoned') {
    return { success: true };  // idempotent
  }

  sh.getRange(rowIdx + 2, 21).setValue('abandoned');
  return { success: true };
}
