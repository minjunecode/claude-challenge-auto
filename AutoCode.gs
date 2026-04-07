// ============================================
// Claude Max 챌린지 (자동) - Google Apps Script
// OAuth 토큰으로 사용량 자동 수집
// ============================================

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
    case 'login':       result = handleLogin(params); break;
    case 'register':    result = handleRegister(params); break;
    case 'init':        result = handleInit(params); break;
    case 'dashboard':   result = handleDashboard(); break;
    case 'registerToken': result = handleRegisterToken(params); break;
    case 'checkUsage':  result = handleCheckUsage(params); break;
    case 'upload':      result = handleUpload(params); break;
    case 'addMember':   result = handleAddMember(params); break;
    case 'deleteMember': result = handleDeleteMember(params); break;
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
    if (data[i][0] === nickname && data[i][1] === password) {
      // 토큰 등록 여부 확인
      var hasToken = checkHasToken(nickname);
      return { success: true, nickname: nickname, isAdmin: data[i][2] === true || data[i][2] === 'TRUE', hasToken: hasToken };
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
    recordSheet.appendRow(['nickname', 'week', 'year', 'type', 'points', 'submittedAt', 'source', 'utilization', 'resetsAt']);
  }

  var tokenSheet = ss.getSheetByName('토큰');
  if (!tokenSheet) {
    tokenSheet = ss.insertSheet('토큰');
    tokenSheet.appendRow(['nickname', 'oauthToken', 'lastChecked', 'lastFiveHour', 'lastSevenDay']);
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
        hasToken: checkHasToken(memberData[i][0])
      });
    }
  }

  var recordSheet = ss.getSheetByName('인증기록');
  var submissions = [];
  if (recordSheet && recordSheet.getLastRow() > 1) {
    var recordData = recordSheet.getDataRange().getValues();
    for (var j = 1; j < recordData.length; j++) {
      if (recordData[j][0]) {
        submissions.push({
          nickname: recordData[j][0],
          week: recordData[j][1],
          year: recordData[j][2],
          type: recordData[j][3] || 'session',
          points: recordData[j][4] || 1,
          submittedAt: recordData[j][5],
          source: recordData[j][6] || 'auto',
          utilization: recordData[j][7] || 0,
          resetsAt: recordData[j][8] || ''
        });
      }
    }
  }

  return { success: true, members: members, submissions: submissions };
}

// ── 토큰 등록/갱신 ──
function handleRegisterToken(params) {
  var nickname = (params.nickname || '').trim();
  var token = (params.token || '').trim();
  if (!nickname || !token) return { success: false, error: '닉네임과 토큰을 입력하세요.' };

  // 토큰 유효성 검증
  var usage = fetchUsage(token);
  if (!usage) return { success: false, error: '토큰 검증 실패: 서버 연결 오류' };
  if (usage.error) return { success: false, error: '유효하지 않은 토큰입니다. ' + usage.error };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('토큰');
  if (!sheet) {
    sheet = ss.insertSheet('토큰');
    sheet.appendRow(['nickname', 'oauthToken', 'lastChecked', 'lastFiveHour', 'lastSevenDay']);
  }

  var data = sheet.getDataRange().getValues();
  var existingRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === nickname) { existingRow = i + 1; break; }
  }

  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  if (existingRow > 0) {
    sheet.getRange(existingRow, 2).setValue(token);
    sheet.getRange(existingRow, 3).setValue(now);
  } else {
    sheet.appendRow([nickname, token, now, '', '']);
  }

  return {
    success: true,
    usage: usage,
    message: '토큰 등록 완료! 자동 인증이 활성화됩니다.'
  };
}

// ── 실시간 사용량 조회 ──
function handleCheckUsage(params) {
  var nickname = (params.nickname || '').trim();
  if (!nickname) return { success: false, error: '닉네임이 필요합니다.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('토큰');
  if (!sheet) return { success: false, error: '토큰이 등록되지 않았습니다.' };

  var data = sheet.getDataRange().getValues();
  var token = null;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === nickname) { token = data[i][1]; break; }
  }

  if (!token) return { success: false, error: '토큰이 등록되지 않았습니다.' };

  var usage = fetchUsage(token);
  if (!usage) return { success: false, error: '사용량 조회 실패. 토큰이 만료되었을 수 있습니다.' };

  return { success: true, usage: usage };
}

// ── Anthropic Usage API 호출 ──
function fetchUsage(token) {
  try {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20'
      },
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    if (code !== 200) return { error: 'API 응답 코드: ' + code + ' - ' + response.getContentText().substring(0, 200) };

    var data = JSON.parse(response.getContentText());
    return {
      fiveHour: {
        utilization: data.five_hour ? data.five_hour.utilization : 0,
        resetsAt: data.five_hour ? data.five_hour.resets_at : null
      },
      sevenDay: {
        utilization: data.seven_day ? data.seven_day.utilization : 0,
        resetsAt: data.seven_day ? data.seven_day.resets_at : null
      }
    };
  } catch (e) {
    return null;
  }
}

// ── 자동 체크 (시간 트리거로 30분마다 실행) ──
function autoCheck() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tokenSheet = ss.getSheetByName('토큰');
  if (!tokenSheet || tokenSheet.getLastRow() <= 1) return;

  var recordSheet = ss.getSheetByName('인증기록');
  if (!recordSheet) return;

  var tokenData = tokenSheet.getDataRange().getValues();
  var recordData = recordSheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  // ISO week 계산
  var today = new Date();
  var d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var currentWeek = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  var currentYear = today.getFullYear();

  for (var i = 1; i < tokenData.length; i++) {
    var nickname = tokenData[i][0];
    var token = tokenData[i][1];
    if (!nickname || !token) continue;

    var usage = fetchUsage(token);
    if (!usage) continue;

    // 토큰 시트 업데이트
    tokenSheet.getRange(i + 1, 3).setValue(now);
    tokenSheet.getRange(i + 1, 4).setValue(usage.fiveHour.utilization);
    tokenSheet.getRange(i + 1, 5).setValue(usage.sevenDay.utilization);

    // 세션 인증: 5시간 utilization >= 95
    if (usage.fiveHour.utilization >= 95) {
      var resetsAt = usage.fiveHour.resetsAt || '';
      // 같은 resets_at 윈도우에 이미 기록했는지 확인
      var alreadyRecorded = false;
      for (var r = 1; r < recordData.length; r++) {
        if (recordData[r][0] === nickname && recordData[r][3] === 'session' && recordData[r][6] === 'auto' && recordData[r][8] === resetsAt) {
          alreadyRecorded = true;
          break;
        }
      }
      if (!alreadyRecorded) {
        recordSheet.appendRow([nickname, currentWeek, currentYear, 'session', 1, now, 'auto', usage.fiveHour.utilization, resetsAt]);
        // recordData 갱신
        recordData.push([nickname, currentWeek, currentYear, 'session', 1, now, 'auto', usage.fiveHour.utilization, resetsAt]);
      }
    }

    // 주간 인증: 7일 utilization >= 95
    if (usage.sevenDay.utilization >= 95) {
      var weeklyExists = false;
      for (var w = 1; w < recordData.length; w++) {
        if (recordData[w][0] === nickname && recordData[w][1] === currentWeek && recordData[w][2] === currentYear && recordData[w][3] === 'weekly') {
          weeklyExists = true;
          break;
        }
      }
      if (!weeklyExists) {
        var weeklyResetsAt = usage.sevenDay.resetsAt || '';
        recordSheet.appendRow([nickname, currentWeek, currentYear, 'weekly', 5, now, 'auto', usage.sevenDay.utilization, weeklyResetsAt]);
        recordData.push([nickname, currentWeek, currentYear, 'weekly', 5, now, 'auto', usage.sevenDay.utilization, weeklyResetsAt]);
      }
    }
  }
}

// ── 트리거 설정 (한 번만 실행) ──
function setupAutoCheckTrigger() {
  // 기존 트리거 삭제
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'autoCheck') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // 30분마다 실행
  ScriptApp.newTrigger('autoCheck')
    .timeBased()
    .everyMinutes(30)
    .create();
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

  // 인증기록 컬럼: nickname, week, year, type, points, submittedAt, source, utilization, resetsAt
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

function checkHasToken(nickname) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('토큰');
  if (!sheet) return false;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === nickname && data[i][1]) return true;
  }
  return false;
}
