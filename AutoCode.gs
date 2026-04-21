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

function doGet(e) { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

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
    default: result = { success: false, error: '알 수 없는 action: ' + action };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
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
    if (data[i][0] === nickname) return { success: false, error: '이미 존재하는 닉네임입니다.' };
  }
  sheet.appendRow([nickname, password, false, '', LEAGUE_1M, '참여 중', 50000]);
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
  memberSheet.appendRow([nickname, password, true, '', LEAGUE_1M, '참여 중', 50000]);

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

  return { success: true, message: '초기 설정 완료!' };
}

// ── 대시보드 ──
function handleDashboard(params) {
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

  // 인증기록
  var recordSheet = ss.getSheetByName('인증기록');
  var submissions = [];
  if (recordSheet && recordSheet.getLastRow() > 1) {
    var recordData = recordSheet.getDataRange().getValues();
    for (var j = 1; j < recordData.length; j++) {
      if (recordData[j][0]) {
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
        groupMap[key] = {
          nickname: nk, date: ds, machines: [], hasNonLegacy: false
        };
      }
      var g = groupMap[key];
      if (mid !== LEGACY_MACHINE_ID) g.hasNonLegacy = true;
      g.machines.push({
        mid: mid,
        clIn: clIn, clOut: clOut, clCw: clCw, clCr: clCr,
        cxIn: cxIn, cxOut: cxOut, cxCr: cxCr,
        sess: uSess, at: uAt
      });
    }

    // 2차: 각 그룹을 합산해서 usage[] 로
    Object.keys(groupMap).forEach(function(key) {
      var g = groupMap[key];
      // legacy 배제 규칙
      var rows = g.hasNonLegacy
        ? g.machines.filter(function(m) { return m.mid !== LEGACY_MACHINE_ID; })
        : g.machines;
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
            latestByDateMachine[key] = {
              date: dateStr, mid: rMid, at: atStr,
              clIn: rClIn, clOut: rClOut, clCw: rClCw, clCr: rClCr,
              cxIn: rCxIn, cxOut: rCxOut, cxCr: rCxCr,
              sess: rSess, hourly: hourly
            };
          }
        }

        // 2) date별로 그룹핑 + legacy 배제 + 합산 (hourly 시간대별 SUM)
        var rawByDate = {};
        Object.keys(latestByDateMachine).forEach(function(k) {
          var e = latestByDateMachine[k];
          if (!rawByDate[e.date]) rawByDate[e.date] = { items: [], hasNonLegacy: false };
          if (e.mid !== LEGACY_MACHINE_ID) rawByDate[e.date].hasNonLegacy = true;
          rawByDate[e.date].items.push(e);
        });

        Object.keys(rawByDate).forEach(function(date) {
          var g = rawByDate[date];
          var items = g.hasNonLegacy
            ? g.items.filter(function(x){return x.mid !== LEGACY_MACHINE_ID;})
            : g.items;
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
        latestPerPc[key] = { nick: rNick, date: rDate, mid: rMid, at: rAtStr, hourly: rHourly2 };
      }
    }

    // 닉네임별로 가장 최근 date + 그 date의 machine 목록
    var latestDateByNick = {};  // nick -> { date, at }
    var pcsByNickDate = {};     // "nick|date" -> { items: [{mid, hourly, at}], hasNonLegacy }
    Object.keys(latestPerPc).forEach(function(key) {
      var e = latestPerPc[key];
      if (!e.date) return;
      // 최근 date 추적 (at 기준이 아니라 date string 기준이 더 직관적. 동률이면 at 우선)
      var cur = latestDateByNick[e.nick];
      if (!cur || e.date > cur.date || (e.date === cur.date && e.at > cur.at)) {
        latestDateByNick[e.nick] = { date: e.date, at: e.at };
      }
      var nd = e.nick + '|' + e.date;
      if (!pcsByNickDate[nd]) pcsByNickDate[nd] = { items: [], hasNonLegacy: false };
      if (e.mid !== LEGACY_MACHINE_ID) pcsByNickDate[nd].hasNonLegacy = true;
      pcsByNickDate[nd].items.push(e);
    });

    // 각 닉네임의 최근 날짜에서 hourly 합산
    Object.keys(latestDateByNick).forEach(function(nick) {
      var lat = latestDateByNick[nick];
      var group = pcsByNickDate[nick + '|' + lat.date];
      if (!group) return;
      var pcs = group.hasNonLegacy
        ? group.items.filter(function(x) { return x.mid !== LEGACY_MACHINE_ID; })
        : group.items;
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

  return {
    success: true,
    members: members,
    submissions: submissions,
    usage: usage,
    myStats: myStats,
    memberLastActivity: memberLastActivity,
    topUser: topUser,
    memberHourly: memberAllHourly,
    memberColors: memberColors
  };
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

  // ── 자동 인증: 해당 (nickname, date)의 모든 machine 합산 score로 포인트 계산 ──
  // (upsert + legacy 삭제 이후 재조회해서 합산)
  var totalScore = 0;
  var usageAfter = usageSheet.getDataRange().getValues();
  for (var u = 1; u < usageAfter.length; u++) {
    if (String(usageAfter[u][0]) !== nickname) continue;
    if (toDateStr(usageAfter[u][1]) !== date) continue;
    totalScore += safeInt(usageAfter[u][9]);
  }

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
    if (data[i][0] === nickname) return { success: false, error: '이미 존재하는 닉네임입니다.' };
  }
  sheet.appendRow([nickname, password, false, '', LEAGUE_1M, '참여 중', 50000]);
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
    // (nickname, date)별 PC 스코어를 따로 수집. legacy 배제 규칙은 아래에서.
    if (!scoresByMember[nk]) scoresByMember[nk] = {};
    if (!scoresByMember[nk][dStr]) scoresByMember[nk][dStr] = { byMid: {}, hasNonLegacy: false };
    scoresByMember[nk][dStr].byMid[bMid] = sc;
    if (bMid !== LEGACY_MACHINE_ID) scoresByMember[nk][dStr].hasNonLegacy = true;
  }

  // (nickname, date)별 합산 score (legacy 배제)
  function _sumDayScore(nick, d) {
    var e = scoresByMember[nick] && scoresByMember[nick][d];
    if (!e) return undefined;
    var sum = 0;
    Object.keys(e.byMid).forEach(function(mid) {
      if (e.hasNonLegacy && mid === LEGACY_MACHINE_ID) return;
      sum += e.byMid[mid] || 0;
    });
    return sum;
  }

  var members = memberSheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  var THRESH = 10000000;  // 10M

  for (var mi = 1; mi < members.length; mi++) {
    var nick = String(members[mi][0]).trim();
    if (!nick) continue;
    var curLeague = String(members[mi][4] || '').trim() || LEAGUE_1M;

    // 3일 모두 보고가 있는지 확인 (multi-PC 합산 기준)
    var allReported = true;
    var allAbove = true;
    var allBelow = true;
    for (var di = 0; di < 3; di++) {
      var dayScore = _sumDayScore(nick, dates[di]);
      if (dayScore === undefined) {
        allReported = false;
        break;
      }
      if (dayScore < THRESH) allAbove = false;
      if (dayScore >= THRESH) allBelow = false;
    }
    if (!allReported) continue;

    var newLeague = curLeague;
    var reason = '';
    if (curLeague === LEAGUE_1M && allAbove) {
      newLeague = LEAGUE_10M;
      reason = '3일 연속 10M 이상 → 승격';
    } else if (curLeague === LEAGUE_10M && allBelow) {
      newLeague = LEAGUE_1M;
      reason = '3일 연속 10M 미만 → 강등';
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
