// ============================================
// Claude Max 챌린지 - Google Apps Script
// Hook 기반 자동 사용량 수집 (OAuth 불필요)
// ============================================

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

  // ── 멤버 시트: league 컬럼(E) 보장 ──
  var memSheet = ss.getSheetByName('멤버');
  if (memSheet && memSheet.getLastRow() >= 1) {
    var memLastCol = memSheet.getLastColumn();
    // E열(5번째) 헤더가 'league'가 아니면 추가
    if (memLastCol < 5) {
      memSheet.getRange(1, 5).setValue('league');
    } else {
      var eHeader = String(memSheet.getRange(1, 5).getValue() || '').toLowerCase();
      if (eHeader !== 'league') memSheet.getRange(1, 5).setValue('league');
    }
    // 기존 멤버 중 league가 비어있으면 '1M' 기본값 할당
    if (memSheet.getLastRow() > 1) {
      var memRange = memSheet.getRange(2, 5, memSheet.getLastRow() - 1, 1);
      var memVals = memRange.getValues();
      var changed = false;
      for (var mi = 0; mi < memVals.length; mi++) {
        if (!memVals[mi][0] || String(memVals[mi][0]).trim() === '') {
          memVals[mi][0] = LEAGUE_1M;
          changed = true;
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

  // ── 사용량 시트: 구형(7열) → 신형(9열) ──
  var usageSheet = ss.getSheetByName('사용량');
  if (usageSheet) {
    var uHeaders = usageSheet.getRange(1, 1, 1, usageSheet.getLastColumn()).getValues()[0];
    var uHeaderStr = uHeaders.join(',');
    // 구형 판별: cache_creation_tokens 헤더가 없으면 구형
    if (uHeaderStr.indexOf('cache_creation_tokens') < 0 && uHeaderStr.indexOf('score') < 0) {
      // 데이터 삭제 (헤더 포함 전부)
      usageSheet.clear();
      usageSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'score', 'sessions', 'reportedAt']);
    }
  }

  // ── 사용량_raw 시트: 구형(8열) → 신형(10열) ──
  var rawSheet = ss.getSheetByName('사용량_raw');
  if (rawSheet) {
    var rHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];
    var rHeaderStr = rHeaders.join(',');
    if (rHeaderStr.indexOf('cache_creation_tokens') < 0 && rHeaderStr.indexOf('score') < 0) {
      rawSheet.clear();
      rawSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'score', 'sessions', 'reportedAt', 'hourly']);
    }
  }
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
  var password = (params.password || '').trim();
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
  var password = (params.password || '').trim();
  if (!nickname || !password) return { success: false, error: '닉네임과 비밀번호를 입력하세요.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('멤버');
  if (!sheet) return { success: false, error: '초기 설정이 필요합니다.' };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === nickname) return { success: false, error: '이미 존재하는 닉네임입니다.' };
  }
  sheet.appendRow([nickname, password, false, '', LEAGUE_1M]);
  return { success: true };
}

function handleInit(params) {
  var nickname = (params.nickname || '').trim();
  var password = (params.password || '').trim();
  if (!nickname || !password) return { success: false, error: '닉네임과 비밀번호를 입력하세요.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var memberSheet = ss.getSheetByName('멤버');
  if (!memberSheet) {
    memberSheet = ss.insertSheet('멤버');
    memberSheet.appendRow(['nickname', 'password', 'isAdmin', 'color', 'league']);
  }
  if (memberSheet.getLastRow() > 1) return { success: false, error: '이미 초기화되어 있습니다.' };
  memberSheet.appendRow([nickname, password, true, '', LEAGUE_1M]);

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
    usageSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'score', 'sessions', 'reportedAt']);
  }

  var rawSheet = ss.getSheetByName('사용량_raw');
  if (!rawSheet) {
    rawSheet = ss.insertSheet('사용량_raw');
    rawSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'score', 'sessions', 'reportedAt', 'hourly']);
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
      members.push({
        nickname: memberData[i][0],
        isAdmin: memberData[i][2] === true || memberData[i][2] === 'TRUE',
        hasAutoReport: checkHasAutoReport(memberData[i][0]),
        league: mLeague
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

  // 사용량
  var usageSheet = ss.getSheetByName('사용량');
  var usage = [];
  if (usageSheet && usageSheet.getLastRow() > 1) {
    var usageData = usageSheet.getDataRange().getValues();
    var usageHasScore = usageData[0].length >= 9;
    for (var k = 1; k < usageData.length; k++) {
      if (usageData[k][0]) {
        var uInp = safeInt(usageData[k][2]);
        var uOut = safeInt(usageData[k][3]);
        var uCC = usageHasScore ? safeInt(usageData[k][4]) : 0;
        var uCR = usageHasScore ? safeInt(usageData[k][5]) : 0;
        var uScore = usageHasScore ? safeInt(usageData[k][6]) : 0;
        // score 항상 공식으로 재계산 (Date→epoch 오염 방지)
        uScore = Math.round((uInp * 1) + (uOut * 5) + (uCC * 1.25) + (uCR * 0.1));
        usage.push({
          nickname: String(usageData[k][0]),
          date: toDateStr(usageData[k][1]),
          input_tokens: uInp,
          output_tokens: uOut,
          cache_creation_tokens: uCC,
          cache_read_tokens: uCR,
          score: uScore,
          sessions: safeInt(usageHasScore ? usageData[k][7] : usageData[k][5]),
          reportedAt: toDateTimeStr(usageHasScore ? usageData[k][8] : usageData[k][6])
        });
      }
    }
  }

  // ── 요청자의 personalStats도 함께 반환 (API 호출 1회로 통합) ──
  var myStats = null;
  var reqNickname = (params.nickname || '').trim();
  var reqPassword = (params.password || '').trim();
  if (reqNickname && reqPassword) {
    // 인증 확인
    var authenticated = false;
    for (var m = 1; m < memberData.length; m++) {
      if (String(memberData[m][0]).trim() === reqNickname && String(memberData[m][1]).trim() === reqPassword) {
        authenticated = true; break;
      }
    }
    if (authenticated) {
      var rawData = [];
      var rawSheet = ss.getSheetByName('사용량_raw');
      if (rawSheet && rawSheet.getLastRow() > 1) {
        var rawRows = rawSheet.getDataRange().getValues();
        // 새 형식(10열): nickname,date,input,output,cache_creation,cache_read,score,sessions,reportedAt,hourly
        // 구 형식(8열): nickname,date,input,output,cache_tokens,sessions,reportedAt,hourly
        var rawHasNewFmt = (rawRows[0].length >= 10) || (String(rawRows[0][4] || '').indexOf('cache_creation') >= 0);
        for (var r = 1; r < rawRows.length; r++) {
          if (String(rawRows[r][0]).trim() === reqNickname) {
            var rInp = safeInt(rawRows[r][2]);
            var rOut = safeInt(rawRows[r][3]);
            var rCC, rCR, rScore, rSess, rAt, rHourlyStr;
            if (rawHasNewFmt) {
              rCC = safeInt(rawRows[r][4]);
              rCR = safeInt(rawRows[r][5]);
              rSess = safeInt(rawRows[r][7]);
              rAt = rawRows[r][8];
              rHourlyStr = rawRows[r][9] || '';
            } else {
              rCC = 0; rCR = 0;
              rSess = safeInt(rawRows[r][5]);
              rAt = rawRows[r][6];
              rHourlyStr = rawRows[r][7] || '';
            }
            // 항상 컴포넌트에서 재계산 (Date→epoch 오염 방지)
            rScore = Math.round((rInp * 1) + (rOut * 5) + (rCC * 1.25) + (rCR * 0.1));
            var hourly = null;
            if (rHourlyStr) { try { hourly = JSON.parse(rHourlyStr); } catch(e) {} }
            rawData.push({
              date: toDateStr(rawRows[r][1]),
              input_tokens: rInp,
              output_tokens: rOut,
              cache_creation_tokens: rCC,
              cache_read_tokens: rCR,
              score: rScore,
              sessions: rSess,
              reportedAt: toDateTimeStr(rAt),
              hourly: hourly
            });
          }
        }
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

  // ── 멤버별 최근 활동 (불꽃 표시용) + 주간 1위 hourly (비교 차트용) ──
  // 모든 멤버의 가장 최근 raw 보고에서 hourly의 마지막 bucket 가중 스코어를 계산
  var memberLastActivity = {};
  var memberAllHourly = {}; // nickname -> 가장 최근 raw row의 hourly 배열
  var rawSheet2 = ss.getSheetByName('사용량_raw');
  if (rawSheet2 && rawSheet2.getLastRow() > 1) {
    var rawRows2 = rawSheet2.getDataRange().getValues();
    var rawHasNewFmt2 = (rawRows2[0].length >= 10) || (String(rawRows2[0][4] || '').indexOf('cache_creation') >= 0);
    // 가장 최근 row를 닉네임별로 추적 (reportedAt 기준)
    var latestByMember = {};
    for (var rr = 1; rr < rawRows2.length; rr++) {
      var rNick = String(rawRows2[rr][0] || '').trim();
      if (!rNick) continue;
      var rAt2 = rawHasNewFmt2 ? rawRows2[rr][8] : rawRows2[rr][6];
      var rAtStr = toDateTimeStr(rAt2);
      if (!latestByMember[rNick] || rAtStr > latestByMember[rNick].at) {
        var rHourlyStr2 = rawHasNewFmt2 ? (rawRows2[rr][9] || '') : (rawRows2[rr][7] || '');
        var rHourly2 = null;
        if (rHourlyStr2) { try { rHourly2 = JSON.parse(rHourlyStr2); } catch(e) {} }
        latestByMember[rNick] = { at: rAtStr, hourly: rHourly2 };
      }
    }
    Object.keys(latestByMember).forEach(function(nick) {
      var lat = latestByMember[nick];
      memberAllHourly[nick] = lat.hourly;
      // 가장 최근 hourly bucket 가중 스코어
      if (lat.hourly && lat.hourly.length > 0) {
        // 가장 큰 h 값을 가진 bucket을 "최근 활동"으로 간주
        var maxH = -1, maxBucket = null;
        for (var hh = 0; hh < lat.hourly.length; hh++) {
          if (lat.hourly[hh].h > maxH) { maxH = lat.hourly[hh].h; maxBucket = lat.hourly[hh]; }
        }
        if (maxBucket) {
          var bScore = ((maxBucket.in || 0) * 1) + ((maxBucket.out || 0) * 5) + ((maxBucket.cc || 0) * 1.25) + ((maxBucket.cr || 0) * 0.1);
          memberLastActivity[nick] = { hour: maxH, score: Math.round(bScore), reportedAt: lat.at };
        }
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
// 가중치 스코어: (input×1) + (output×5) + (cache_creation×1.25) + (cache_read×0.1)
function handleReportUsage(params) {
  // 구형 시트 자동 마이그레이션 (1회성)
  migrateSheetIfNeeded_();

  var nickname = (params.nickname || '').trim();
  var password = (params.password || '').trim();
  var date = (params.date || '').trim();
  var inputTokens = parseInt(params.input_tokens) || 0;
  var outputTokens = parseInt(params.output_tokens) || 0;
  var cacheCreationTokens = parseInt(params.cache_creation_tokens) || 0;
  var cacheReadTokens = parseInt(params.cache_read_tokens) || 0;
  var score = parseInt(params.score) || 0;
  var sessions = parseInt(params.sessions) || 0;

  // 하위 호환: 이전 스크립트가 cache_tokens 하나로 보내는 경우
  if (!cacheCreationTokens && !cacheReadTokens && params.cache_tokens) {
    cacheCreationTokens = parseInt(params.cache_tokens) || 0;
  }
  // score가 없으면 서버에서 계산
  if (!score) {
    score = Math.round((inputTokens * 1) + (outputTokens * 5) + (cacheCreationTokens * 1.25) + (cacheReadTokens * 0.1));
  }

  if (!nickname || !password || !date) return { success: false, error: '필수 파라미터가 누락되었습니다.' };

  // 인증 확인
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

  // ① 사용량_raw: 보고 원본 + 시간대별 데이터 보존
  var rawSheet = ss.getSheetByName('사용량_raw');
  if (!rawSheet) {
    rawSheet = ss.insertSheet('사용량_raw');
    rawSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'score', 'sessions', 'reportedAt', 'hourly']);
  }
  var hourlyJson = params.hourly ? JSON.stringify(params.hourly) : '';
  rawSheet.appendRow([nickname, "'" + date, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, score, sessions, now, hourlyJson]);

  // ② 사용량: 일별 최종값만 upsert (프론트 표시용)
  var usageSheet = ss.getSheetByName('사용량');
  if (!usageSheet) {
    usageSheet = ss.insertSheet('사용량');
    usageSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'score', 'sessions', 'reportedAt']);
  }

  var usageData = usageSheet.getDataRange().getValues();
  var existingRow = -1;
  for (var j = 1; j < usageData.length; j++) {
    if (String(usageData[j][0]) === nickname && toDateStr(usageData[j][1]) === date) {
      existingRow = j + 1; break;
    }
  }

  if (existingRow > 0) {
    usageSheet.getRange(existingRow, 3, 1, 7).setValues([[inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, score, sessions, now]]);
  } else {
    usageSheet.appendRow([nickname, "'" + date, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, score, sessions, now]);
  }

  // 자동 인증: 리그별 포인트 계산
  // 보고 날짜가 LEAGUE_ERA_START 이전이면 구 기준(1M/10M/50M), 이후면 해당 멤버의 리그 기준
  var isLegacy = (date < LEAGUE_ERA_START);
  var recordLeague = isLegacy ? '' : userLeague;  // legacy 기록은 league 컬럼 비움
  var earnedPts = isLegacy ? calcPointsLegacy_(score) : calcPointsForLeague_(score, userLeague);
  if (earnedPts > 0) {
    var recordSheet = ss.getSheetByName('인증기록');
    if (recordSheet) {
      var records = recordSheet.getDataRange().getValues();
      var alreadyExists = false;
      for (var k = 1; k < records.length; k++) {
        var storedDate = toDateStr(records[k][8]) || toDateStr(records[k][5]);
        if (String(records[k][0]) === nickname && String(records[k][6]) === 'auto' && storedDate === date) {
          recordSheet.getRange(k + 1, 5).setValue(earnedPts);
          recordSheet.getRange(k + 1, 6).setValue(now);  // submittedAt도 최신 보고 시간으로 갱신
          recordSheet.getRange(k + 1, 8).setValue(score);
          recordSheet.getRange(k + 1, 9).setNumberFormat('@').setValue(date);
          recordSheet.getRange(k + 1, 10).setValue(recordLeague); // 보고 시점의 리그 갱신
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

        recordSheet.appendRow([nickname, week, year, 'session', earnedPts, now, 'auto', score, "'" + date, recordLeague]);
      }
    }
  }

  return { success: true, message: '사용량 보고 완료', date: date, score: score };
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
  var password = (params.password || '').trim();
  if (!isAdmin(adminNickname)) return { success: false, error: '관리자 권한이 필요합니다.' };
  if (!nickname || !password) return { success: false, error: '닉네임과 비밀번호를 입력하세요.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('멤버');
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === nickname) return { success: false, error: '이미 존재하는 닉네임입니다.' };
  }
  sheet.appendRow([nickname, password, false, '', LEAGUE_1M]);
  return { success: true };
}

function handleSetColor(params) {
  var nickname = (params.nickname || '').trim();
  var password = (params.password || '').trim();
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
  var nickname = (params.nickname || '').trim();
  var password = (params.password || '').trim();
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

  // 사용량_raw (시간별 스냅샷)
  // 새 컬럼: nickname, date, input, output, cache_creation, cache_read, score, sessions, reportedAt, hourly
  // 구 컬럼: nickname, date, input, output, cache_tokens, sessions, reportedAt, hourly
  var rawData = [];
  var rawSheet = ss.getSheetByName('사용량_raw');
  if (rawSheet && rawSheet.getLastRow() > 1) {
    var rows = rawSheet.getDataRange().getValues();
    var rawHeaders = rows[0];
    var hasScore = rawHeaders.length >= 10; // 새 형식 (score 컬럼 있음)
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]).trim() === nickname) {
        var prInp = safeInt(rows[r][2]);
        var prOut = safeInt(rows[r][3]);
        var prCC, prCR, prScore, prSess, prAt, prHourlyStr;
        if (hasScore) {
          prCC = safeInt(rows[r][4]);
          prCR = safeInt(rows[r][5]);
          prScore = safeInt(rows[r][6]);
          prSess = Number(rows[r][7]) || 0;
          prAt = rows[r][8];
          prHourlyStr = rows[r][9] || '';
        } else {
          prCC = 0; prCR = 0; prScore = 0;
          prSess = Number(rows[r][5]) || 0;
          prAt = rows[r][6];
          prHourlyStr = rows[r][7] || '';
        }
        // score 항상 공식으로 재계산
        prScore = Math.round((prInp * 1) + (prOut * 5) + (prCC * 1.25) + (prCR * 0.1));
        var hourly = null;
        if (prHourlyStr) { try { hourly = JSON.parse(prHourlyStr); } catch(e) {} }
        rawData.push({
          date: toDateStr(rows[r][1]),
          input_tokens: prInp,
          output_tokens: prOut,
          cache_creation_tokens: prCC,
          cache_read_tokens: prCR,
          score: prScore,
          sessions: prSess,
          reportedAt: toDateTimeStr(prAt),
          hourly: hourly
        });
      }
    }
  }

  // 사용량 (일별 최종)
  // 새 컬럼: nickname, date, input, output, cache_creation, cache_read, score, sessions, reportedAt
  // 구 컬럼: nickname, date, input, output, cache_tokens, sessions, reportedAt
  var dailyData = [];
  var usageSheet = ss.getSheetByName('사용량');
  if (usageSheet && usageSheet.getLastRow() > 1) {
    var uRows = usageSheet.getDataRange().getValues();
    var usageHeaders = uRows[0];
    var hasUsageScore = usageHeaders.length >= 9;
    for (var u = 1; u < uRows.length; u++) {
      if (String(uRows[u][0]).trim() === nickname) {
        var pdInp = safeInt(uRows[u][2]);
        var pdOut = safeInt(uRows[u][3]);
        var pdCC = hasUsageScore ? safeInt(uRows[u][4]) : 0;
        var pdCR = hasUsageScore ? safeInt(uRows[u][5]) : 0;
        // 항상 컴포넌트에서 재계산 (Date→epoch 오염 방지)
        var pdScore = Math.round((pdInp * 1) + (pdOut * 5) + (pdCC * 1.25) + (pdCR * 0.1));
        dailyData.push({
          date: toDateStr(uRows[u][1]),
          input_tokens: pdInp,
          output_tokens: pdOut,
          cache_creation_tokens: pdCC,
          cache_read_tokens: pdCR,
          score: pdScore,
          sessions: safeInt(hasUsageScore ? uRows[u][7] : uRows[u][5]),
          reportedAt: toDateTimeStr(hasUsageScore ? uRows[u][8] : uRows[u][6])
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
// ── 리그 자정 배치 ──
// ============================================
// 매일 00:00 KST 실행. 최근 3일 (오늘 포함) 일일 스코어를 보고,
// - 1M 리그 유저: 3일 모두 >= 10M → 10M 리그로 승격
// - 10M 리그 유저: 3일 모두 < 10M → 1M 리그로 강등
// - 3일 중 하나라도 보고 없음 → 판정 보류 (리그 유지)

function runDailyLeagueBatch_() {
  migrateSheetIfNeeded_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var memberSheet = ss.getSheetByName('멤버');
  var usageSheet = ss.getSheetByName('사용량');
  var logSheet = ss.getSheetByName('리그이동기록');
  if (!memberSheet || !usageSheet || !logSheet) return;

  // 최근 3일 날짜 계산 (오늘 포함, KST)
  var today = new Date();
  var dates = [];
  for (var d = 0; d < 3; d++) {
    var t = new Date(today.getTime() - d * 24 * 60 * 60 * 1000);
    dates.push(Utilities.formatDate(t, 'Asia/Seoul', 'yyyy-MM-dd'));
  }

  // 각 멤버의 최근 3일 스코어 수집
  var usage = usageSheet.getDataRange().getValues();
  var usageHasScore = usage[0].length >= 9;
  var scoresByMember = {};  // nick → { date: score }
  for (var i = 1; i < usage.length; i++) {
    var nk = String(usage[i][0]).trim();
    if (!nk) continue;
    var dStr = toDateStr(usage[i][1]);
    if (dates.indexOf(dStr) < 0) continue;
    var uInp = safeInt(usage[i][2]);
    var uOut = safeInt(usage[i][3]);
    var uCC = usageHasScore ? safeInt(usage[i][4]) : 0;
    var uCR = usageHasScore ? safeInt(usage[i][5]) : 0;
    var sc = Math.round((uInp * 1) + (uOut * 5) + (uCC * 1.25) + (uCR * 0.1));
    if (!scoresByMember[nk]) scoresByMember[nk] = {};
    scoresByMember[nk][dStr] = sc;
  }

  var members = memberSheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  var THRESH = 10000000;  // 10M

  for (var mi = 1; mi < members.length; mi++) {
    var nick = String(members[mi][0]).trim();
    if (!nick) continue;
    var curLeague = String(members[mi][4] || '').trim() || LEAGUE_1M;
    var memberScores = scoresByMember[nick] || {};

    // 3일 모두 보고가 있는지 확인
    var allReported = true;
    var allAbove = true;
    var allBelow = true;
    for (var di = 0; di < 3; di++) {
      var dayScore = memberScores[dates[di]];
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
  // 매일 0시 ~ 1시 사이 실행 (Apps Script의 일간 트리거 정밀도)
  ScriptApp.newTrigger('runDailyLeagueBatch_')
    .timeBased()
    .everyDays(1)
    .atHour(0)
    .inTimezone('Asia/Seoul')
    .create();
  return '리그 자정 배치 트리거 설치 완료';
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
