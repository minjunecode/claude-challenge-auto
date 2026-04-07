// ============================================
// Claude Max 챌린지 (Auto) - 프론트엔드
// OAuth 토큰으로 자동 사용량 수집
// ============================================

const API_URL = 'https://script.google.com/macros/s/AKfycbwrErPYadxObqPoOH82jmNBr9uuv7KabV31YkMPKBh0Si7mWcTP24XdvFbCoj3nEp8vcw/exec';

let currentUser = null;
let dashboardData = null;
let dailyWeekOffset = 0;
let monthOffset = 0;

// ── 레벨 시스템 ──
const LEVELS = [
  { name: 'Rookie', min: 0 },
  { name: 'Beginner', min: 10 },
  { name: 'Regular', min: 25 },
  { name: 'Dedicated', min: 50 },
  { name: 'Pro', min: 80 },
  { name: 'Expert', min: 120 },
  { name: 'Master', min: 170 },
  { name: 'Legend', min: 250 },
];

function getLevel(pts) { let l = LEVELS[0]; for (const x of LEVELS) { if (pts >= x.min) l = x; else break; } return l; }
function getNextLevel(pts) { for (const x of LEVELS) { if (pts < x.min) return x; } return null; }

// ── 멤버 색상 ──
const COLOR_PRESETS = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#8b5cf6', '#111111'];
const DEFAULT_DOT_COLOR = '#d1d5db';
function getMemberColor(n) { return (JSON.parse(localStorage.getItem('memberColors') || '{}'))[n] || DEFAULT_DOT_COLOR; }
function setMemberColor(n, c) { const s = JSON.parse(localStorage.getItem('memberColors') || '{}'); s[n] = c; localStorage.setItem('memberColors', JSON.stringify(s)); }

// ── 초기화 ──
document.addEventListener('DOMContentLoaded', () => {
  const saved = sessionStorage.getItem('challengeUser');
  if (saved) { currentUser = JSON.parse(saved); showMain(); }
  setupEventListeners();
});

function setupEventListeners() {
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('btn-show-init').addEventListener('click', () => document.getElementById('init-section').classList.toggle('hidden'));
  document.getElementById('btn-init').addEventListener('click', handleRegister);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  // 뷰 탭 전환
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.cert-view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`view-${tab.dataset.view}`).classList.add('active');
      if (tab.dataset.view === 'monthly') renderMonthlyCalendar();
    });
  });

  // 주간 네비게이션
  document.getElementById('btn-daily-prev').addEventListener('click', () => { dailyWeekOffset--; renderDashboard(); });
  document.getElementById('btn-daily-next').addEventListener('click', () => { dailyWeekOffset++; renderDashboard(); });

  // 월간 네비게이션
  document.getElementById('btn-month-prev').addEventListener('click', () => { monthOffset--; renderMonthlyCalendar(); });
  document.getElementById('btn-month-next').addEventListener('click', () => { monthOffset++; renderMonthlyCalendar(); });

  // 수동 업로드
  document.getElementById('session-file').addEventListener('change', (e) => handleFileSelect(e, 'session'));
  document.getElementById('btn-upload-session').addEventListener('click', () => handleManualUpload('session'));
  document.getElementById('weekly-file').addEventListener('change', (e) => handleFileSelect(e, 'weekly'));
  document.getElementById('btn-upload-weekly').addEventListener('click', () => handleManualUpload('weekly'));
  setupPasteSupport('session');
  setupPasteSupport('weekly');

  // 토큰 등록
  document.getElementById('btn-register-token').addEventListener('click', handleRegisterToken);
  document.getElementById('btn-refresh-usage').addEventListener('click', refreshUsage);
  document.getElementById('btn-toggle-guide').addEventListener('click', () => {
    const guide = document.getElementById('token-guide-section');
    const btn = document.getElementById('btn-toggle-guide');
    guide.classList.toggle('hidden');
    btn.textContent = guide.classList.contains('hidden') ? '토큰 찾는 법 보기' : '가이드 접기';
  });

  // 관리자
  document.getElementById('btn-add-member').addEventListener('click', handleAddMember);

  // 레벨 툴팁
  const infoBtn = document.getElementById('level-info-btn');
  const tooltip = document.getElementById('level-tooltip');
  infoBtn.addEventListener('mouseenter', () => tooltip.classList.remove('hidden'));
  infoBtn.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  infoBtn.addEventListener('click', () => tooltip.classList.toggle('hidden'));

  // 모달
  document.querySelector('.modal-overlay').addEventListener('click', () => { document.getElementById('image-modal').classList.add('hidden'); });
  document.querySelector('.modal-close').addEventListener('click', () => { document.getElementById('image-modal').classList.add('hidden'); });
}

// ── API ──
async function apiCall(action, params = {}) {
  if (API_URL === 'YOUR_APPS_SCRIPT_URL_HERE') { if (!dashboardData) dashboardData = getDemoData(); return null; }
  const body = { action, ...params };
  const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  try { return JSON.parse(await response.text()); } catch { return { success: false, error: '서버 응답 오류' }; }
}

// ── 로그인 ──
async function handleLogin(e) {
  e.preventDefault();
  const nickname = document.getElementById('login-nickname').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  if (API_URL === 'YOUR_APPS_SCRIPT_URL_HERE') {
    currentUser = { nickname: nickname || 'Mj', isAdmin: true, hasToken: true };
    sessionStorage.setItem('challengeUser', JSON.stringify(currentUser));
    showMain();
    return;
  }

  const result = await apiCall('login', { nickname, password });
  if (!result) return;
  if (result.success) {
    currentUser = { nickname: result.nickname, isAdmin: result.isAdmin, hasToken: result.hasToken };
    sessionStorage.setItem('challengeUser', JSON.stringify(currentUser));
    showMain();
  } else { errorEl.textContent = result.error; }
}

function handleLogout() {
  currentUser = null; dashboardData = null;
  sessionStorage.removeItem('challengeUser');
  document.getElementById('main-view').classList.remove('active');
  document.getElementById('login-view').classList.add('active');
}

async function handleRegister() {
  const nickname = document.getElementById('init-nickname').value.trim();
  const password = document.getElementById('init-password').value.trim();
  const msgEl = document.getElementById('init-msg');
  if (!nickname || !password) { msgEl.textContent = '닉네임과 비밀번호를 입력하세요.'; return; }
  const result = await apiCall('register', { nickname, password });
  if (!result) { msgEl.textContent = '데모 모드: API URL을 설정하세요.'; return; }
  if (result.success) { msgEl.textContent = '가입 완료! 로그인해주세요.'; msgEl.classList.add('success-msg'); }
  else { msgEl.textContent = result.error; msgEl.classList.remove('success-msg'); }
}

// ── 메인 ──
async function showMain() {
  document.getElementById('login-view').classList.remove('active');
  document.getElementById('main-view').classList.add('active');
  document.getElementById('user-info').textContent = currentUser.nickname + (currentUser.isAdmin ? ' (관리자)' : '');
  document.querySelectorAll('.admin-only').forEach(el => { el.style.display = currentUser.isAdmin ? '' : 'none'; });
  await loadDashboard();
  switchTab('dashboard');
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');
  if (tabName === 'dashboard') renderDashboard();
  if (tabName === 'cert') { renderUploadTab(); renderTokenTab(); }
  if (tabName === 'admin') renderAdminTab();
}

// ── 토큰 등록 ──
async function handleRegisterToken() {
  const token = document.getElementById('token-input').value.trim();
  const msgEl = document.getElementById('token-msg');
  if (!token) { msgEl.textContent = '토큰을 입력하세요.'; return; }

  msgEl.textContent = '토큰 확인 중...';
  msgEl.classList.remove('success-msg', 'error-msg');

  const result = await apiCall('registerToken', { nickname: currentUser.nickname, token });
  if (!result) { msgEl.textContent = '데모 모드: API URL을 설정하세요.'; return; }

  if (result.success) {
    msgEl.textContent = result.message;
    msgEl.classList.add('success-msg');
    currentUser.hasToken = true;
    sessionStorage.setItem('challengeUser', JSON.stringify(currentUser));
    document.getElementById('token-input').value = '';
    renderTokenTab();
    if (result.usage) updateUsageDisplay(result.usage);
  } else {
    msgEl.textContent = result.error;
    msgEl.classList.add('error-msg');
  }
}

async function refreshUsage() {
  const result = await apiCall('checkUsage', { nickname: currentUser.nickname });
  if (!result) {
    // 데모 모드
    updateUsageDisplay({ fiveHour: { utilization: 72, resetsAt: new Date(Date.now() + 3*3600*1000).toISOString() }, sevenDay: { utilization: 45, resetsAt: new Date(Date.now() + 3*86400*1000).toISOString() } });
    return;
  }
  if (result.success) updateUsageDisplay(result.usage);
  else document.getElementById('token-msg').textContent = result.error;
}

function updateUsageDisplay(usage) {
  document.getElementById('usage-display').classList.remove('hidden');

  // 5시간
  const u5 = Math.round(usage.fiveHour.utilization);
  document.getElementById('usage-5h-value').textContent = u5 + '%';
  const bar5 = document.getElementById('usage-5h-bar');
  bar5.style.width = Math.min(100, u5) + '%';
  bar5.className = 'usage-bar-fill' + (u5 >= 95 ? ' full' : u5 >= 80 ? ' critical' : u5 >= 50 ? ' warn' : '');
  if (usage.fiveHour.resetsAt) {
    const reset = new Date(usage.fiveHour.resetsAt);
    document.getElementById('usage-5h-reset').textContent = `리셋: ${reset.toLocaleString('ko-KR')}`;
  }

  // 7일
  const u7 = Math.round(usage.sevenDay.utilization);
  document.getElementById('usage-7d-value').textContent = u7 + '%';
  const bar7 = document.getElementById('usage-7d-bar');
  bar7.style.width = Math.min(100, u7) + '%';
  bar7.className = 'usage-bar-fill' + (u7 >= 95 ? ' full' : u7 >= 80 ? ' critical' : u7 >= 50 ? ' warn' : '');
  if (usage.sevenDay.resetsAt) {
    const reset = new Date(usage.sevenDay.resetsAt);
    document.getElementById('usage-7d-reset').textContent = `리셋: ${reset.toLocaleString('ko-KR')}`;
  }
}

function renderTokenTab() {
  const statusEl = document.getElementById('token-status');
  const statusText = document.getElementById('token-status-text');

  if (currentUser.hasToken) {
    statusEl.className = 'token-status connected';
    statusText.textContent = '자동 인증 활성';
    refreshUsage();
  } else {
    statusEl.className = 'token-status disconnected';
    statusText.textContent = '토큰 미등록';
    document.getElementById('usage-display').classList.add('hidden');
  }
}

// ── 대시보드 ──
async function loadDashboard() {
  const result = await apiCall('dashboard');
  if (result && result.success) dashboardData = result;
  else if (!dashboardData) dashboardData = getDemoData();
  renderDashboard();
}

function getWeekDates(week, year) {
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  const days = [];
  const dayLabels = ['월', '화', '수', '목', '금', '토', '일'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ label: dayLabels[i], dayNum: d.getDate(), month: d.getMonth() + 1, date: dateStr });
  }
  return days;
}

function renderDailyTable(members, submissions) {
  const today = getTodayStr();
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1 + dailyWeekOffset * 7);

  const days = [];
  const dayLabels = ['일', '월', '화', '수', '목', '금', '토'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push({
      label: dayLabels[d.getDay()],
      dayNum: d.getDate(),
      month: d.getMonth() + 1,
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    });
  }

  // 주차 라벨
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const thuMonth = thursday.getMonth() + 1;
  const weekInMonth = Math.ceil(thursday.getDate() / 7);
  document.getElementById('weekly-label').textContent = `${thuMonth}월 ${weekInMonth}주차`;

  // 멤버별 날짜별 세션 인증
  const dailyMap = {};
  members.forEach(m => { dailyMap[m.nickname] = new Set(); });
  submissions.forEach(s => {
    if (s.type === 'session') {
      const dateStr = (s.submittedAt || '').slice(0, 10);
      if (dateStr && dailyMap[s.nickname]) dailyMap[s.nickname].add(dateStr);
    }
  });

  const headerRow = document.getElementById('daily-header');
  headerRow.innerHTML = '<th></th>';
  days.forEach(d => {
    const th = document.createElement('th');
    if (d.date === today) {
      th.textContent = `${d.month}/${d.dayNum}(${d.label})`;
      th.classList.add('daily-th-today');
      th.title = '오늘';
    } else { th.textContent = `${d.month}/${d.dayNum}(${d.label})`; }
    headerRow.appendChild(th);
  });

  const tbody = document.getElementById('daily-body');
  tbody.innerHTML = '';
  members.forEach((m, mIdx) => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'member-color-dot';
    dot.style.background = getMemberColor(m.nickname);
    if (currentUser && m.nickname === currentUser.nickname) {
      dot.classList.add('editable');
      dot.addEventListener('click', (e) => { e.stopPropagation(); showColorPicker(dot, m.nickname); });
    }
    nameTd.appendChild(dot);
    nameTd.appendChild(document.createTextNode(m.nickname));
    if (m.hasToken) {
      const badge = document.createElement('span');
      badge.className = 'auto-badge';
      badge.textContent = 'auto';
      nameTd.appendChild(badge);
    }
    tr.appendChild(nameTd);

    days.forEach(d => {
      const td = document.createElement('td');
      if (d.date > today) { td.classList.add('daily-td-future'); }
      else if (d.date === today) {
        td.classList.add(dailyMap[m.nickname].has(d.date) ? 'daily-td-done' : 'daily-td-pending');
        td.textContent = dailyMap[m.nickname].has(d.date) ? 'O' : '-';
        td.classList.add('daily-td-today');
      } else {
        td.classList.add(dailyMap[m.nickname].has(d.date) ? 'daily-td-done' : 'daily-td-miss');
        td.textContent = dailyMap[m.nickname].has(d.date) ? 'O' : 'X';
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function showColorPicker(dot, nickname) {
  document.querySelectorAll('.color-picker-popup').forEach(p => p.remove());
  const popup = document.createElement('div');
  popup.className = 'color-picker-popup';
  const rect = dot.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 6}px`;
  const presets = document.createElement('div');
  presets.className = 'color-presets';
  COLOR_PRESETS.forEach(c => {
    const btn = document.createElement('div');
    btn.className = 'color-preset';
    btn.style.background = c;
    btn.addEventListener('click', () => { setMemberColor(nickname, c); dot.style.background = c; popup.remove(); renderDashboard(); });
    presets.appendChild(btn);
  });
  const input = document.createElement('input');
  input.type = 'text'; input.placeholder = '#hex'; input.value = getMemberColor(nickname) || '';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && /^#[0-9a-fA-F]{3,6}$/.test(input.value.trim())) {
      setMemberColor(nickname, input.value.trim()); dot.style.background = input.value.trim(); popup.remove(); renderDashboard();
    }
  });
  popup.appendChild(presets); popup.appendChild(input);
  document.body.appendChild(popup);
  setTimeout(() => { document.addEventListener('click', function cl(e) { if (!popup.contains(e.target) && e.target !== dot) { popup.remove(); document.removeEventListener('click', cl); } }); }, 0);
}

function renderMonthlyCalendar() {
  if (!dashboardData || !currentUser) return;
  const today = getTodayStr();
  const now = new Date();
  const targetDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth();

  document.getElementById('month-label').textContent = `${year}년 ${month + 1}월`;

  const myDates = new Set();
  dashboardData.submissions.forEach(s => {
    if (s.nickname === currentUser.nickname && s.type === 'session') {
      const dateStr = (s.submittedAt || '').slice(0, 10);
      if (dateStr) myDates.add(dateStr);
    }
  });

  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  const dayHeaders = ['', '월', '화', '수', '목', '금', '토', '일'];
  dayHeaders.forEach(dh => {
    const el = document.createElement('div');
    el.className = dh === '' ? 'cal-week-label' : 'cal-header';
    el.textContent = dh;
    grid.appendChild(el);
  });

  const firstDay = targetDate.getDay();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  function getWeekLabel(dayNum) {
    const d = new Date(year, month, dayNum);
    const dow = d.getDay() || 7;
    const thu = new Date(d); thu.setDate(d.getDate() + (4 - dow));
    return `${thu.getMonth() + 1}월 ${Math.ceil(thu.getDate() / 7)}주차`;
  }

  let dayNum = 1 - startOffset;
  while (dayNum <= daysInMonth) {
    const labelEl = document.createElement('div');
    labelEl.className = 'cal-week-label';
    const labelDay = Math.max(1, Math.min(daysInMonth, dayNum + 3));
    labelEl.textContent = getWeekLabel(labelDay);
    grid.appendChild(labelEl);

    for (let col = 0; col < 7; col++) {
      const el = document.createElement('div');
      el.className = 'cal-day';
      if (dayNum < 1 || dayNum > daysInMonth) { el.classList.add('empty'); }
      else {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
        el.innerHTML = `<span class="cal-num">${dayNum}</span>`;
        if (dateStr > today) el.classList.add('future');
        else if (dateStr === today) { el.classList.add('today'); el.classList.add(myDates.has(dateStr) ? 'done' : 'pending'); }
        else el.classList.add(myDates.has(dateStr) ? 'done' : 'miss');
      }
      grid.appendChild(el);
      dayNum++;
    }
  }
}

function getStreak(nickname, submissions, currentWeek, currentYear) {
  const weeklySet = new Set();
  submissions.forEach(s => { if (s.nickname === nickname) weeklySet.add(`${s.year}_${s.week}`); });
  let streak = 0;
  for (let w = currentWeek; w >= 1; w--) { if (weeklySet.has(`${currentYear}_${w}`)) streak++; else break; }
  return streak;
}

function renderDashboard() {
  if (!dashboardData) return;
  const { members, submissions } = dashboardData;
  const currentWeek = getISOWeek(new Date());
  const currentYear = new Date().getFullYear();

  const scores = {};
  members.forEach(m => { scores[m.nickname] = { weekly: 0, total: 0, streak: 0 }; });
  submissions.forEach(s => {
    const pts = s.points || (s.type === 'weekly' ? 5 : 1);
    if (scores[s.nickname]) {
      scores[s.nickname].total += pts;
      if (s.year === currentYear && s.week === currentWeek) scores[s.nickname].weekly += pts;
    }
  });
  members.forEach(m => { scores[m.nickname].streak = getStreak(m.nickname, submissions, currentWeek, currentYear); });

  const ranked = members.map(m => ({ nickname: m.nickname, hasToken: m.hasToken, ...scores[m.nickname] })).sort((a, b) => b.total - a.total);

  // 일간 테이블
  renderDailyTable(members, submissions);

  // 내 현황
  const myIdx = ranked.findIndex(r => r.nickname === currentUser.nickname);
  const my = myIdx >= 0 ? ranked[myIdx] : { weekly: 0, total: 0, streak: 0 };
  const myLevel = getLevel(my.total);
  const myNext = getNextLevel(my.total);

  document.getElementById('my-rank-badge').textContent = myIdx >= 0 ? myIdx + 1 : '-';
  document.getElementById('my-status-name').textContent = currentUser.nickname;
  document.getElementById('my-status-level').textContent = myLevel.name;
  document.getElementById('my-weekly-pts').textContent = my.weekly;
  document.getElementById('my-total-pts').textContent = my.total;
  document.getElementById('my-streak').textContent = my.streak;

  document.getElementById('level-current').textContent = myLevel.name;
  if (myNext) {
    document.getElementById('level-next').textContent = myNext.name;
    document.getElementById('level-progress-fill').style.width = `${Math.min(100, ((my.total - myLevel.min) / (myNext.min - myLevel.min)) * 100)}%`;
    document.getElementById('level-progress-text').textContent = `${myNext.min - my.total}pt more to ${myNext.name}`;
  } else {
    document.getElementById('level-next').textContent = 'MAX';
    document.getElementById('level-progress-fill').style.width = '100%';
    document.getElementById('level-progress-text').textContent = 'Maximum level reached';
  }

  // TOP 3
  const podium = document.getElementById('podium');
  podium.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉'];
  ranked.slice(0, 3).forEach((r, i) => {
    const level = getLevel(r.total);
    const card = document.createElement('div');
    card.className = `podium-card${i === 0 ? ' first' : ''}`;
    card.innerHTML = `
      <div class="podium-medal">${medals[i]}</div>
      <div class="podium-name">${escapeHtml(r.nickname)}</div>
      <div class="podium-level">${level.name}</div>
      <div class="podium-pts">${r.total}pt</div>
      <div class="podium-weekly">this week +${r.weekly}</div>
      ${r.streak > 0 ? `<span class="podium-streak${r.streak >= 3 ? ' hot' : ''}">${r.streak}w streak</span>` : ''}
    `;
    podium.appendChild(card);
  });

  // 나머지 순위
  const restRanking = document.getElementById('rest-ranking');
  restRanking.innerHTML = '';
  const rest = ranked.slice(3);
  if (rest.length > 0) {
    const listEl = document.createElement('div');
    listEl.className = 'rest-rank-list';
    rest.forEach((r, i) => {
      const level = getLevel(r.total);
      const item = document.createElement('div');
      item.className = 'rest-rank-item';
      item.innerHTML = `
        <span class="rest-rank-num">${i + 4}</span>
        <div class="rest-rank-info">
          <div class="rest-rank-name">${escapeHtml(r.nickname)}</div>
          <div class="rest-rank-level">${level.name}${r.streak > 0 ? ` · ${r.streak}w streak` : ''}</div>
        </div>
        <span class="rest-rank-pts">${r.total}pt</span>
      `;
      listEl.appendChild(item);
    });
    const isExpanded = restRanking.dataset.expanded === 'true';
    listEl.style.display = isExpanded ? '' : 'none';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'rest-rank-toggle';
    toggleBtn.textContent = isExpanded ? '접기' : `${rest.length}명 더 보기`;
    toggleBtn.addEventListener('click', () => {
      const showing = listEl.style.display !== 'none';
      listEl.style.display = showing ? 'none' : '';
      toggleBtn.textContent = showing ? `${rest.length}명 더 보기` : '접기';
      restRanking.dataset.expanded = !showing;
    });
    restRanking.appendChild(toggleBtn);
    restRanking.appendChild(listEl);
  }

  // 최근 인증
  const activityList = document.getElementById('activity-list');
  activityList.innerHTML = '';
  const recent = [...submissions].sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || '')).slice(0, 10);
  if (recent.length === 0) { activityList.innerHTML = '<div class="activity-item" style="color:var(--text-muted);justify-content:center;">아직 인증 내역이 없습니다.</div>'; return; }
  recent.forEach(s => {
    const pts = s.points || (s.type === 'weekly' ? 5 : 1);
    const typeLabel = s.type === 'weekly' ? '주간' : '세션';
    const typeClass = s.type === 'weekly' ? 'weekly' : 'session';
    const dateStr = (s.submittedAt || '').slice(0, 10);
    const timeStr = (s.submittedAt || '').slice(11, 16);
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.innerHTML = `
      <span class="activity-type ${typeClass}">${typeLabel}</span>
      <span class="activity-name">${escapeHtml(s.nickname)}</span>
      ${s.source === 'auto' ? '<span class="auto-badge">auto</span>' : '<span class="manual-badge">manual</span>'}
      <span class="activity-date">${dateStr}${timeStr ? ' ' + timeStr : ''}</span>
      <span class="activity-points">+${pts}pt</span>
    `;
    activityList.appendChild(item);
  });
}

// ── 수동 업로드 ──
const MIN_SESSION_INTERVAL_HOURS = 2;
const uploadState = {
  session: { base64: null, fileName: null, screenshotTime: null },
  weekly: { base64: null, fileName: null, screenshotTime: null },
};

function setupPasteSupport(type) {
  const card = document.getElementById(`${type}-card`);
  card.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) { e.preventDefault(); processFile(item.getAsFile(), type); return; }
    }
  });
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault(); card.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) processFile(file, type);
  });
}

function processFile(file, type) {
  const now = Date.now();
  const fileTime = file.lastModified || now;
  const fileAge = now - fileTime;
  const msgEl = document.getElementById(`${type}-msg`);
  const screenshotDate = new Date(fileTime);
  uploadState[type].screenshotTime = formatDateTime(screenshotDate);

  if (fileAge > 24 * 60 * 60 * 1000) {
    msgEl.textContent = `이 파일은 약 ${Math.round(fileAge / 3600000)}시간 전에 생성되었습니다.`;
    msgEl.classList.remove('success-msg'); msgEl.classList.add('error-msg');
  } else {
    msgEl.textContent = `스크린샷 시각: ${uploadState[type].screenshotTime}`;
    msgEl.classList.remove('error-msg'); msgEl.classList.add('success-msg');
  }

  const name = file.name || `paste_${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.png`;
  document.getElementById(`${type}-file-name`).textContent = name;
  uploadState[type].fileName = name;

  const reader = new FileReader();
  reader.onload = (ev) => {
    uploadState[type].base64 = ev.target.result.split(',')[1];
    document.getElementById(`${type}-preview`).src = ev.target.result;
    document.getElementById(`${type}-preview-wrapper`).classList.remove('hidden');
    const btn = document.getElementById(`btn-upload-${type}`);
    if (btn.textContent !== '오늘 완료' && btn.textContent !== '이번 주 완료') btn.disabled = false;
  };
  reader.readAsDataURL(file);
}

function handleFileSelect(e, type) {
  const file = e.target.files[0];
  if (file) processFile(file, type);
}

function formatDateTime(date) {
  const y = date.getFullYear(), mo = String(date.getMonth()+1).padStart(2,'0'), d = String(date.getDate()).padStart(2,'0');
  const h = String(date.getHours()).padStart(2,'0'), mi = String(date.getMinutes()).padStart(2,'0'), s = String(date.getSeconds()).padStart(2,'0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function renderUploadTab() {
  if (!dashboardData) return;
  const week = getISOWeek(new Date()), year = new Date().getFullYear(), today = getTodayStr();
  const mySubs = dashboardData.submissions.filter(s => s.nickname === currentUser.nickname);

  const sessionToday = mySubs.filter(s => s.type === 'session' && s.source === 'manual' && (s.submittedAt || '').startsWith(today)).length;
  const sessionLeft = Math.max(0, 3 - sessionToday);
  const sessionStatus = document.getElementById('session-status');
  sessionStatus.textContent = `오늘 ${sessionToday}/3회 사용`;
  sessionStatus.classList.toggle('maxed', sessionLeft === 0);
  const btnSession = document.getElementById('btn-upload-session');
  if (sessionLeft === 0) { btnSession.disabled = true; btnSession.textContent = '오늘 완료'; }
  else { btnSession.disabled = !uploadState.session.base64; btnSession.textContent = '업로드'; }

  const weeklyDone = mySubs.some(s => s.type === 'weekly' && s.source === 'manual' && s.week === week && s.year === year);
  const weeklyStatus = document.getElementById('weekly-status');
  weeklyStatus.textContent = weeklyDone ? '이번 주 인증 완료' : '이번 주 0/1회';
  weeklyStatus.classList.toggle('maxed', weeklyDone);
  const btnWeekly = document.getElementById('btn-upload-weekly');
  if (weeklyDone) { btnWeekly.disabled = true; btnWeekly.textContent = '이번 주 완료'; }
  else { btnWeekly.disabled = !uploadState.weekly.base64; btnWeekly.textContent = '업로드'; }

  document.getElementById('session-msg').textContent = '';
  document.getElementById('weekly-msg').textContent = '';
}

async function handleManualUpload(type) {
  if (!uploadState[type].base64) return;
  const week = getISOWeek(new Date()), year = new Date().getFullYear();
  const msgEl = document.getElementById(`${type}-msg`);
  const progressEl = document.getElementById(`${type}-progress`);
  const btn = document.getElementById(`btn-upload-${type}`);
  const points = type === 'weekly' ? 5 : 1;

  msgEl.textContent = ''; progressEl.classList.remove('hidden'); btn.disabled = true;

  const result = await apiCall('upload', {
    nickname: currentUser.nickname, week, year, type, points,
    screenshotTime: uploadState[type].screenshotTime || formatDateTime(new Date()),
    imageBase64: uploadState[type].base64, fileName: uploadState[type].fileName,
  });

  progressEl.classList.add('hidden');
  if (result && result.success) {
    msgEl.textContent = `+${points}pt 인증 완료!`; msgEl.classList.add('success-msg'); msgEl.classList.remove('error-msg');
    uploadState[type] = { base64: null, fileName: null, screenshotTime: null };
    document.getElementById(`${type}-file-name`).textContent = '선택된 파일 없음';
    document.getElementById(`${type}-preview-wrapper`).classList.add('hidden');
    await loadDashboard(); renderUploadTab();
  } else if (result) { msgEl.textContent = result.error || '업로드 실패'; btn.disabled = false; }
  else { msgEl.textContent = '데모 모드: API URL을 설정하세요.'; btn.disabled = false; }
}

// ── 관리자 ──
function renderAdminTab() {
  if (!dashboardData) return;
  const list = document.getElementById('member-list');
  list.innerHTML = '';
  dashboardData.members.forEach(m => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="member-name">${escapeHtml(m.nickname)}</span>${m.isAdmin ? '<span class="member-badge">관리자</span>' : ''}${m.hasToken ? '<span class="auto-badge">auto</span>' : ''}</span>`;
    if (!m.isAdmin) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-small';
      delBtn.textContent = '삭제';
      delBtn.addEventListener('click', () => handleDeleteMember(m.nickname));
      li.appendChild(delBtn);
    }
    list.appendChild(li);
  });
}

async function handleAddMember() {
  const nickname = document.getElementById('new-member-nickname').value.trim();
  const password = document.getElementById('new-member-password').value.trim();
  const msgEl = document.getElementById('admin-msg');
  if (!nickname || !password) { msgEl.textContent = '닉네임과 비밀번호를 입력하세요.'; return; }
  const result = await apiCall('addMember', { adminNickname: currentUser.nickname, nickname, password });
  if (result && result.success) {
    msgEl.textContent = `${nickname} 추가 완료!`; msgEl.classList.add('success-msg');
    document.getElementById('new-member-nickname').value = '';
    document.getElementById('new-member-password').value = '';
    await loadDashboard(); renderAdminTab();
  } else if (result) { msgEl.textContent = result.error; }
}

async function handleDeleteMember(nickname) {
  if (!confirm(`${nickname} 삭제?`)) return;
  const result = await apiCall('deleteMember', { adminNickname: currentUser.nickname, nickname });
  if (result && result.success) { await loadDashboard(); renderAdminTab(); }
}

// ── 유틸리티 ──
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }

// ── 데모 데이터 ──
function getDemoData() {
  const week = getISOWeek(new Date());
  const year = new Date().getFullYear();
  const today = getTodayStr();
  const subs = [];

  function addAuto(nick, daysAgo, hour, type, pts) {
    const d = new Date(); d.setDate(d.getDate() - daysAgo);
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const w = getISOWeek(d);
    subs.push({ nickname: nick, week: w, year, type, points: pts, submittedAt: `${ds} ${String(hour).padStart(2,'0')}:00:00`, source: 'auto', utilization: 95 + Math.round(Math.random()*5), resetsAt: '' });
  }

  // Mj: 매일 세션 (14일간) + 주간
  for (let i = 0; i < 14; i++) addAuto('Mj', i, 9 + (i % 8), 'session', 1);
  addAuto('Mj', 0, 20, 'weekly', 5);
  addAuto('Mj', 7, 20, 'weekly', 5);

  // Dc: 10일 중 7일
  [0,1,2,4,5,7,8].forEach(i => addAuto('Dc', i, 11, 'session', 1));
  addAuto('Dc', 1, 21, 'weekly', 5);

  // S: 5일
  [0,2,3,5,6].forEach(i => addAuto('S', i, 14, 'session', 1));
  addAuto('S', 3, 19, 'weekly', 5);

  // L: 4일
  [0,1,3,6].forEach(i => addAuto('L', i, 10, 'session', 1));

  // Jh: 2일
  [0,1].forEach(i => addAuto('Jh', i, 15, 'session', 1));

  // Jc: 6일
  [0,1,2,3,5,6].forEach(i => addAuto('Jc', i, 13, 'session', 1));
  addAuto('Jc', 2, 22, 'weekly', 5);

  // Dg: 3일
  [0,3,5].forEach(i => addAuto('Dg', i, 16, 'session', 1));

  return {
    success: true,
    members: [
      { nickname: 'Mj', isAdmin: true, hasToken: true },
      { nickname: 'Dc', isAdmin: false, hasToken: true },
      { nickname: 'S', isAdmin: false, hasToken: true },
      { nickname: 'L', isAdmin: false, hasToken: false },
      { nickname: 'Jh', isAdmin: false, hasToken: false },
      { nickname: 'Jc', isAdmin: false, hasToken: true },
      { nickname: 'Dg', isAdmin: false, hasToken: false },
    ],
    submissions: subs,
  };
}
