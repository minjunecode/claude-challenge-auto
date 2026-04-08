// ============================================
// Claude Max 챌린지 - Google Apps Script
// Hook 기반 자동 사용량 수집 (OAuth 불필요)
// ============================================

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
    case 'dashboard':    result = handleDashboard(); break;
    case 'reportUsage':  result = handleReportUsage(params); break;
    case 'upload':       result = handleUpload(params); break;
    case 'addMember':    result = handleAddMember(params); break;
    case 'deleteMember': result = handleDeleteMember(params); break;
    case 'personalStats': result = handlePersonalStats(params); break;
    default: result = { success: false, error: '알 수 없는 action: ' + action };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── 로그인 ──
function handleLogin(params) {
  var nickname = (params.nickname || '').trim();
  var password = (params.password || '').trim();
  if (!nickname || !password) return { success: false, error: '닉네임과 비밀번호를 입력하세요.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('멤버');
  if (!sheet) return { success: false, error: '"멤버" 시트를 찾을 수 없습니다.' };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === nickname && String(data[i][1]).trim() === password) {
      var hasAutoReport = checkHasAutoReport(nickname);
      return { success: true, nickname: nickname, isAdmin: data[i][2] === true || data[i][2] === 'TRUE', hasAutoReport: hasAutoReport };
    }
  }
  return { success: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };
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
  sheet.appendRow([nickname, password, false]);
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
    memberSheet.appendRow(['nickname', 'password', 'isAdmin']);
  }
  if (memberSheet.getLastRow() > 1) return { success: false, error: '이미 초기화되어 있습니다.' };
  memberSheet.appendRow([nickname, password, true]);

  var recordSheet = ss.getSheetByName('인증기록');
  if (!recordSheet) {
    recordSheet = ss.insertSheet('인증기록');
    recordSheet.appendRow(['nickname', 'week', 'year', 'type', 'points', 'submittedAt', 'source', 'tokens', 'resetsAt']);
  }

  var usageSheet = ss.getSheetByName('사용량');
  if (!usageSheet) {
    usageSheet = ss.insertSheet('사용량');
    usageSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_tokens', 'sessions', 'reportedAt']);
  }

  var rawSheet = ss.getSheetByName('사용량_raw');
  if (!rawSheet) {
    rawSheet = ss.insertSheet('사용량_raw');
    rawSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_tokens', 'sessions', 'reportedAt']);
  }

  return { success: true, message: '초기 설정 완료!' };
}

// ── 대시보드 ──
function handleDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var memberSheet = ss.getSheetByName('멤버');
  if (!memberSheet) return { success: false, error: '"멤버" 시트를 찾을 수 없습니다.' };

  var memberData = memberSheet.getDataRange().getValues();
  var members = [];
  for (var i = 1; i < memberData.length; i++) {
    if (memberData[i][0]) {
      members.push({
        nickname: memberData[i][0],
        isAdmin: memberData[i][2] === true || memberData[i][2] === 'TRUE',
        hasAutoReport: checkHasAutoReport(memberData[i][0])
      });
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
          resetsAt: recordData[j][8] || ''
        });
      }
    }
  }

  // 사용량 (최근 14일)
  var usageSheet = ss.getSheetByName('사용량');
  var usage = [];
  if (usageSheet && usageSheet.getLastRow() > 1) {
    var usageData = usageSheet.getDataRange().getValues();
    for (var k = 1; k < usageData.length; k++) {
      if (usageData[k][0]) {
        usage.push({
          nickname: String(usageData[k][0]),
          date: toDateStr(usageData[k][1]),
          input_tokens: Number(usageData[k][2]) || 0,
          output_tokens: Number(usageData[k][3]) || 0,
          cache_tokens: Number(usageData[k][4]) || 0,
          sessions: Number(usageData[k][5]) || 0,
          reportedAt: toDateTimeStr(usageData[k][6])
        });
      }
    }
  }

  return { success: true, members: members, submissions: submissions, usage: usage };
}

// ── 사용량 보고 (PC에서 Hook으로 전송) ──
function handleReportUsage(params) {
  var nickname = (params.nickname || '').trim();
  var password = (params.password || '').trim();
  var date = (params.date || '').trim();
  var inputTokens = parseInt(params.input_tokens) || 0;
  var outputTokens = parseInt(params.output_tokens) || 0;
  var cacheTokens = parseInt(params.cache_tokens) || 0;
  var sessions = parseInt(params.sessions) || 0;

  if (!nickname || !password || !date) return { success: false, error: '필수 파라미터가 누락되었습니다.' };

  // 인증 확인
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

  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  var totalTokens = inputTokens + outputTokens + cacheTokens;

  // ① 사용량_raw: 모든 보고를 append (원본 보존)
  var rawSheet = ss.getSheetByName('사용량_raw');
  if (!rawSheet) {
    rawSheet = ss.insertSheet('사용량_raw');
    rawSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_tokens', 'sessions', 'reportedAt']);
  }
  rawSheet.appendRow([nickname, "'" + date, inputTokens, outputTokens, cacheTokens, sessions, now]);

  // ② 사용량: 일별 최종값만 upsert (프론트 표시용)
  var usageSheet = ss.getSheetByName('사용량');
  if (!usageSheet) {
    usageSheet = ss.insertSheet('사용량');
    usageSheet.appendRow(['nickname', 'date', 'input_tokens', 'output_tokens', 'cache_tokens', 'sessions', 'reportedAt']);
  }

  var usageData = usageSheet.getDataRange().getValues();
  var existingRow = -1;
  for (var j = 1; j < usageData.length; j++) {
    if (String(usageData[j][0]) === nickname && toDateStr(usageData[j][1]) === date) {
      existingRow = j + 1; break;
    }
  }

  if (existingRow > 0) {
    usageSheet.getRange(existingRow, 3, 1, 5).setValues([[inputTokens, outputTokens, cacheTokens, sessions, now]]);
  } else {
    usageSheet.appendRow([nickname, "'" + date, inputTokens, outputTokens, cacheTokens, sessions, now]);
  }

  // 자동 인증: 50K → 1pt, 100K → 2pt (하루 최대 2pt)
  var ioTokens = inputTokens + outputTokens;
  var earnedPts = ioTokens >= 100000 ? 2 : (ioTokens >= 50000 ? 1 : 0);
  if (earnedPts > 0) {
    var recordSheet = ss.getSheetByName('인증기록');
    if (recordSheet) {
      var records = recordSheet.getDataRange().getValues();
      var alreadyExists = false;
      for (var k = 1; k < records.length; k++) {
        // resetsAt(col 8) 또는 submittedAt(col 5)에서 날짜 매칭
        var storedDate = toDateStr(records[k][8]) || toDateStr(records[k][5]);
        if (String(records[k][0]) === nickname && String(records[k][6]) === 'auto' && storedDate === date) {
          // 기존 기록의 포인트 + 토큰 업데이트
          recordSheet.getRange(k + 1, 5).setValue(earnedPts);
          recordSheet.getRange(k + 1, 8).setValue(totalTokens);
          recordSheet.getRange(k + 1, 9).setNumberFormat('@').setValue(date);
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

        recordSheet.appendRow([nickname, week, year, 'session', earnedPts, now, 'auto', totalTokens, "'" + date]);
      }
    }
  }

  return { success: true, message: '사용량 보고 완료', date: date, totalTokens: totalTokens };
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
  sheet.appendRow([nickname, password, false]);
  return { success: true };
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
  var rawData = [];
  var rawSheet = ss.getSheetByName('사용량_raw');
  if (rawSheet && rawSheet.getLastRow() > 1) {
    var rows = rawSheet.getDataRange().getValues();
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]).trim() === nickname) {
        rawData.push({
          date: toDateStr(rows[r][1]),
          input_tokens: Number(rows[r][2]) || 0,
          output_tokens: Number(rows[r][3]) || 0,
          cache_tokens: Number(rows[r][4]) || 0,
          sessions: Number(rows[r][5]) || 0,
          reportedAt: toDateTimeStr(rows[r][6])
        });
      }
    }
  }

  // 사용량 (일별 최종)
  var dailyData = [];
  var usageSheet = ss.getSheetByName('사용량');
  if (usageSheet && usageSheet.getLastRow() > 1) {
    var uRows = usageSheet.getDataRange().getValues();
    for (var u = 1; u < uRows.length; u++) {
      if (String(uRows[u][0]).trim() === nickname) {
        dailyData.push({
          date: toDateStr(uRows[u][1]),
          input_tokens: Number(uRows[u][2]) || 0,
          output_tokens: Number(uRows[u][3]) || 0,
          cache_tokens: Number(uRows[u][4]) || 0,
          sessions: Number(uRows[u][5]) || 0,
          reportedAt: toDateTimeStr(uRows[u][6])
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
