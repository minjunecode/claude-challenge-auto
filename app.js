// ============================================
// Claude Max 챌린지 - 프론트엔드
// Hook 기반 자동 사용량 수집 (OAuth 불필요)
// ============================================

const API_URL = 'https://script.google.com/macros/s/AKfycbys_MSZz16yoH9065nSLtsl4n9N0IMTYGECsvqzKIoD3EgZ30VlVxLjzOciq-8a6a8_KA/exec';

let currentUser = null;
let dashboardData = null;
let dailyWeekOffset = 0;
let monthOffset = 0;

// ── 레벨 시스템 ──
const LEVELS = [
  { name: 'Rookie', min: 0 },
  { name: 'Beginner', min: 5 },
  { name: 'Regular', min: 15 },
  { name: 'Dedicated', min: 30 },
  { name: 'Pro', min: 60 },
  { name: 'Expert', min: 100 },
  { name: 'Master', min: 150 },
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
  const saved = localStorage.getItem('challengeUser');
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

  // 관리자
  document.getElementById('btn-add-member').addEventListener('click', handleAddMember);

  // 순위 토글
  document.querySelectorAll('.rank-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => switchRankView(btn.dataset.rank));
  });

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
    currentUser = { nickname: nickname || 'Mj', isAdmin: true, hasAutoReport: true };
    localStorage.setItem('challengeUser', JSON.stringify(currentUser));
    showMain();
    return;
  }

  const loginBtn = document.querySelector('#login-form .btn-primary');
  loginBtn.disabled = true;
  loginBtn.textContent = '로그인 중...';

  const result = await apiCall('login', { nickname, password });

  loginBtn.disabled = false;
  loginBtn.textContent = '로그인';

  if (!result) return;
  if (result.success) {
    currentUser = { nickname: result.nickname, isAdmin: result.isAdmin, hasAutoReport: result.hasAutoReport, password };
    localStorage.setItem('challengeUser', JSON.stringify(currentUser));
    showMain();
  } else { errorEl.textContent = result.error; }
}

function handleLogout() {
  currentUser = null; dashboardData = null;
  localStorage.removeItem('challengeUser');
  localStorage.removeItem('dashboardCache');
  document.getElementById('main-view').classList.remove('active');
  document.getElementById('login-view').classList.add('active');
}

async function handleRegister() {
  const nickname = document.getElementById('init-nickname').value.trim();
  const password = document.getElementById('init-password').value.trim();
  const msgEl = document.getElementById('init-msg');
  if (!nickname || !password) { msgEl.textContent = '닉네임과 비밀번호를 입력하세요.'; return; }
  const regBtn = document.getElementById('btn-init');
  regBtn.disabled = true; regBtn.textContent = '가입 중...';
  let result = await apiCall('register', { nickname, password });
  if (result && !result.success && result.error && result.error.includes('초기 설정')) {
    result = await apiCall('init', { nickname, password });
  }
  regBtn.disabled = false; regBtn.textContent = '가입하기';
  if (!result) { msgEl.textContent = '데모 모드: API URL을 설정하세요.'; return; }
  if (result.success) { msgEl.textContent = result.message || '가입 완료! 로그인해주세요.'; msgEl.classList.add('success-msg'); }
  else { msgEl.textContent = result.error; msgEl.classList.remove('success-msg'); }
}

// ── 메인 ──
async function showMain() {
  document.getElementById('login-view').classList.remove('active');
  document.getElementById('main-view').classList.add('active');
  document.getElementById('user-info').textContent = currentUser.nickname + (currentUser.isAdmin ? ' (관리자)' : '');
  document.querySelectorAll('.admin-only').forEach(el => { el.style.display = currentUser.isAdmin ? '' : 'none'; });
  await loadDashboard();
  // URL hash에서 탭 복원 (새로고침 시 현재 탭 유지)
  const hash = location.hash.replace('#', '');
  const validTabs = ['dashboard', 'stats', 'cert', 'admin'];
  const restoredTab = validTabs.includes(hash) ? hash : 'dashboard';
  switchTab(restoredTab);
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');
  // URL hash에 현재 탭 저장 (새로고침 시 복원용)
  location.hash = tabName;
  if (tabName === 'dashboard') renderDashboard();
  if (tabName === 'cert') { renderAutoStatus(); }
  if (tabName === 'stats') {
    // date picker 기본값을 오늘로 (API 응답 전에도 표시)
    const picker = document.getElementById('stats-date-picker');
    if (picker && !picker.value) {
      const now = new Date();
      const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      picker.value = kst.toISOString().split('T')[0];
    }
    loadPersonalStats();
  }
  if (tabName === 'admin') renderAdminTab();
}

// ── 자동 리포팅 상태 ──
function renderAutoStatus() {
  if (!dashboardData) return;
  const statusEl = document.getElementById('auto-status');
  const statusText = document.getElementById('auto-status-text');
  const usageDisplay = document.getElementById('auto-usage-display');
  const today = getTodayStr();

  // 내 사용량 데이터 찾기
  const myUsage = (dashboardData.usage || []).filter(u => u.nickname === currentUser.nickname);
  const todayUsage = myUsage.find(u => normalizeDate(u.date) === today);

  // 최근 보고 찾기 (가장 최근)
  const sorted = [...myUsage].sort((a, b) => normalizeDate(b.reportedAt).localeCompare(normalizeDate(a.reportedAt)));
  const lastReport = sorted[0];

  if (lastReport) {
    // 최근 3일 이내 보고가 있으면 "활성"
    const lastDate = normalizeDate(lastReport.date);
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const cutoff = `${threeDaysAgo.getFullYear()}-${String(threeDaysAgo.getMonth()+1).padStart(2,'0')}-${String(threeDaysAgo.getDate()).padStart(2,'0')}`;

    if (lastDate >= cutoff) {
      statusEl.className = 'token-status connected';
      statusText.textContent = '자동 리포팅 활성';
    } else {
      statusEl.className = 'token-status disconnected';
      statusText.textContent = '리포팅 중단됨 (3일 이상 미보고)';
    }

    usageDisplay.classList.remove('hidden');

    // 오늘 토큰 (input+output 기준, cache 제외)
    if (todayUsage) {
      const ioTotal = (todayUsage.input_tokens || 0) + (todayUsage.output_tokens || 0);
      document.getElementById('auto-today-tokens').textContent = formatTokens(ioTotal);
      document.getElementById('auto-today-sessions').textContent = todayUsage.sessions || 0;
    } else {
      document.getElementById('auto-today-tokens').textContent = '-';
      document.getElementById('auto-today-sessions').textContent = '-';
    }

    // 마지막 보고 시간
    const normReported = normalizeDate(lastReport.reportedAt);
    const rawReported = String(lastReport.reportedAt || '');
    const reportTime = rawReported.includes(':') ? rawReported.match(/\d{2}:\d{2}/)?.[0] || '' : '';
    document.getElementById('auto-last-report').textContent = normReported === today && reportTime ? reportTime : normReported;
  } else {
    statusEl.className = 'token-status disconnected';
    statusText.textContent = '미설정';
    usageDisplay.classList.add('hidden');
  }
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
}

// 날짜 정규화: 어떤 형식이든 "YYYY-MM-DD"로 변환
function normalizeDate(v) {
  if (!v) return '';
  const s = String(v);
  // 이미 YYYY-MM-DD 형식이면 그대로
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  // "Wed Apr 08 2026 ..." 같은 Date.toString() 형식
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  return s;
}

// ── 대시보드 ──
async function loadDashboard() {
  // 1) 캐시에서 즉시 렌더
  const cached = localStorage.getItem('dashboardCache');
  if (cached) {
    try {
      dashboardData = JSON.parse(cached);
      renderDashboard();
    } catch { /* ignore */ }
  }

  // 2) API에서 최신 데이터 가져오기
  const result = await apiCall('dashboard');
  if (result && result.success) {
    dashboardData = result;
    localStorage.setItem('dashboardCache', JSON.stringify(result));
  } else if (!dashboardData) {
    dashboardData = getDemoData();
  }
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

  // 멤버별 날짜별 인증 + 토큰
  const dailyMap = {};
  members.forEach(m => { dailyMap[m.nickname] = {}; });

  // submissions에서 날짜별 인증 여부
  submissions.forEach(s => {
    if (s.type === 'session') {
      const dateStr = normalizeDate(s.submittedAt);
      if (dateStr && dailyMap[s.nickname]) {
        if (!dailyMap[s.nickname][dateStr]) dailyMap[s.nickname][dateStr] = { done: true, tokens: 0, source: s.source };
        dailyMap[s.nickname][dateStr].done = true;
        if (s.source === 'auto' && s.tokens) dailyMap[s.nickname][dateStr].tokens = s.tokens;
      }
    }
  });

  // usage 데이터에서 토큰 수 보강
  if (dashboardData.usage) {
    dashboardData.usage.forEach(u => {
      if (dailyMap[u.nickname]) {
        const uDate = normalizeDate(u.date);
        const ioTokens = (u.input_tokens || 0) + (u.output_tokens || 0);
        const allTokens = ioTokens + (u.cache_tokens || 0);
        if (!dailyMap[u.nickname][uDate]) dailyMap[u.nickname][uDate] = { done: false, tokens: 0, allTokens: 0, source: '' };
        dailyMap[u.nickname][uDate].tokens = ioTokens;
        dailyMap[u.nickname][uDate].allTokens = allTokens;
      }
    });
  }

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
  members.forEach((m) => {
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
    if (m.hasAutoReport) {
      const badge = document.createElement('span');
      badge.className = 'auto-badge';
      badge.textContent = 'auto';
      nameTd.appendChild(badge);
    }
    tr.appendChild(nameTd);

    days.forEach(d => {
      const td = document.createElement('td');
      const info = dailyMap[m.nickname][d.date];
      const tokens = info ? info.tokens : 0;
      if (d.date > today) {
        td.classList.add('daily-td-future');
      } else if (d.date === today) {
        td.classList.add('daily-td-today');
        if (tokens >= 100000) {
          td.classList.add('daily-td-done');
          td.textContent = 'OO';
        } else if (tokens >= 50000) {
          td.classList.add('daily-td-done');
          td.textContent = 'O';
        } else if (tokens > 0) {
          td.classList.add('daily-td-partial');
          td.textContent = formatTokens(tokens);
        } else {
          td.classList.add('daily-td-pending');
          td.textContent = '-';
        }
      } else {
        if (tokens >= 100000) {
          td.classList.add('daily-td-done');
          td.textContent = 'OO';
        } else if (tokens >= 50000) {
          td.classList.add('daily-td-done');
          td.textContent = 'O';
        } else if (tokens > 0) {
          td.classList.add('daily-td-partial');
          td.textContent = formatTokens(tokens);
        } else {
          td.classList.add('daily-td-miss');
          td.textContent = 'X';
        }
      }
      if (tokens > 0) {
        const all = info ? info.allTokens : 0;
        td.title = `in+out: ${tokens.toLocaleString()}\ncache 포함: ${all.toLocaleString()}`;
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

  // Build a map of date -> ioTokens from usage data
  const tokenMap = {};
  if (dashboardData.usage) {
    dashboardData.usage.forEach(u => {
      if (u.nickname === currentUser.nickname) {
        const ioTokens = (u.input_tokens || 0) + (u.output_tokens || 0);
        if (ioTokens > 0) tokenMap[normalizeDate(u.date)] = ioTokens;
      }
    });
  }

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

  let monthlyTotal = 0;

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
        const tokens = tokenMap[dateStr] || 0;
        if (tokens > 0) monthlyTotal += tokens;

        let innerHtml = `<span class="cal-num">${dayNum}</span>`;
        if (tokens > 0) innerHtml += `<span class="cal-tokens">${formatTokens(tokens)}</span>`;
        el.innerHTML = innerHtml;

        if (dateStr > today) el.classList.add('future');
        else if (dateStr === today) {
          el.classList.add('today');
          el.classList.add(tokens >= 50000 ? 'done' : 'pending');
        } else {
          el.classList.add(tokens >= 50000 ? 'done' : 'miss');
        }
      }
      grid.appendChild(el);
      dayNum++;
    }
  }

  // Monthly total
  const monthTotalEl = document.getElementById('month-total');
  if (monthTotalEl) {
    monthTotalEl.innerHTML = `${month + 1}월 총 사용량: <span class="month-total-value">${formatTokens(monthlyTotal)}</span> tokens`;
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

  const ranked = members.map(m => ({ nickname: m.nickname, hasAutoReport: m.hasAutoReport, ...scores[m.nickname] })).sort((a, b) => b.total - a.total);

  // 월간 토큰 순위 계산
  const now2 = new Date();
  const curMonth = `${now2.getFullYear()}-${String(now2.getMonth()+1).padStart(2,'0')}`;
  const monthlyTokens = {};
  members.forEach(m => { monthlyTokens[m.nickname] = 0; });
  if (dashboardData.usage) {
    dashboardData.usage.forEach(u => {
      if (normalizeDate(u.date).startsWith(curMonth) && monthlyTokens[u.nickname] !== undefined) {
        monthlyTokens[u.nickname] += (u.input_tokens || 0) + (u.output_tokens || 0);
      }
    });
  }
  const tokenRanked = members.map(m => ({ nickname: m.nickname, hasAutoReport: m.hasAutoReport, monthTokens: monthlyTokens[m.nickname] || 0, ...scores[m.nickname] })).sort((a, b) => b.monthTokens - a.monthTokens);

  // 저장 (renderPodium에서 사용)
  dashboardData._ranked = ranked;
  dashboardData._tokenRanked = tokenRanked;

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

  // TOP 3 — 현재 선택된 뷰로 렌더
  const activeView = document.querySelector('.rank-toggle-btn.active')?.dataset.rank || 'points';
  renderPodium(activeView);

  // 최근 활동
  const activityList = document.getElementById('activity-list');
  activityList.innerHTML = '';
  const recent = [...submissions].sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || '')).slice(0, 10);
  if (recent.length === 0) { activityList.innerHTML = '<div class="activity-item" style="color:var(--text-muted);justify-content:center;">아직 활동 내역이 없습니다.</div>'; return; }
  recent.forEach(s => {
    const pts = s.points || (s.type === 'weekly' ? 5 : 1);
    const typeLabel = s.type === 'weekly' ? '주간' : '세션';
    const typeClass = s.type === 'weekly' ? 'weekly' : 'session';
    const dateStr = (s.submittedAt || '').slice(0, 10);
    const timeStr = (s.submittedAt || '').slice(11, 16);
    const tokens = s.tokens > 0 ? ` · ${formatTokens(s.tokens)}` : '';
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.innerHTML = `
      <span class="activity-type ${typeClass}">${typeLabel}</span>
      <span class="activity-name">${escapeHtml(s.nickname)}</span>
      ${s.source === 'auto' ? '<span class="auto-badge">auto</span>' : '<span class="manual-badge">manual</span>'}
      <span class="activity-date">${dateStr}${timeStr ? ' ' + timeStr : ''}${tokens}</span>
      <span class="activity-points">+${pts}pt</span>
    `;
    activityList.appendChild(item);
  });
}

function formatDateTime(date) {
  const y = date.getFullYear(), mo = String(date.getMonth()+1).padStart(2,'0'), d = String(date.getDate()).padStart(2,'0');
  const h = String(date.getHours()).padStart(2,'0'), mi = String(date.getMinutes()).padStart(2,'0'), s = String(date.getSeconds()).padStart(2,'0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

// ── 관리자 ──
function switchRankView(view) {
  document.querySelectorAll('.rank-toggle-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.rank-toggle-btn[data-rank="${view}"]`).classList.add('active');
  renderPodium(view);
}

function renderPodium(view) {
  if (!dashboardData) return;
  const isTokens = view === 'tokens';
  const ranked = isTokens ? (dashboardData._tokenRanked || []) : (dashboardData._ranked || []);

  const podium = document.getElementById('podium');
  podium.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉'];
  ranked.slice(0, 3).forEach((r, i) => {
    const level = getLevel(r.total);
    const card = document.createElement('div');
    card.className = `podium-card${i === 0 ? ' first' : ''}`;
    const mainStat = isTokens
      ? `<div class="podium-pts">${formatTokens(r.monthTokens)}</div><div class="podium-weekly">이번 달 토큰</div>`
      : `<div class="podium-pts">${r.total}pt</div><div class="podium-weekly">this week +${r.weekly}</div>`;
    card.innerHTML = `
      <div class="podium-medal">${medals[i]}</div>
      <div class="podium-name">${escapeHtml(r.nickname)}</div>
      <div class="podium-level">${level.name}</div>
      ${mainStat}
      ${!isTokens && r.streak > 0 ? `<span class="podium-streak${r.streak >= 3 ? ' hot' : ''}">${r.streak}w streak</span>` : ''}
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
      const statText = isTokens ? formatTokens(r.monthTokens) : `${r.total}pt`;
      item.innerHTML = `
        <span class="rest-rank-num">${i + 4}</span>
        <div class="rest-rank-info">
          <div class="rest-rank-name">${escapeHtml(r.nickname)}</div>
          <div class="rest-rank-level">${level.name}${!isTokens && r.streak > 0 ? ` · ${r.streak}w streak` : ''}</div>
        </div>
        <span class="rest-rank-pts">${statText}</span>
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
}

function renderAdminTab() {
  if (!dashboardData) return;
  const list = document.getElementById('member-list');
  list.innerHTML = '';
  dashboardData.members.forEach(m => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="member-name">${escapeHtml(m.nickname)}</span>${m.isAdmin ? '<span class="member-badge">관리자</span>' : ''}${m.hasAutoReport ? '<span class="auto-badge">auto</span>' : ''}</span>`;
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
  const subs = [];
  const usage = [];

  function addAuto(nick, daysAgo, hour, type, pts) {
    const d = new Date(); d.setDate(d.getDate() - daysAgo);
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const w = getISOWeek(d);
    // 실제 비율 반영: input 1%, output 40~60%, cache가 대부분
    const outputTokens = Math.round(5000 + Math.random() * 175000);
    const inputTokens = Math.round(outputTokens * 0.01);
    const cacheTokens = Math.round(outputTokens * (15 + Math.random() * 50));
    const ioTokens = inputTokens + outputTokens;
    subs.push({ nickname: nick, week: w, year, type, points: pts, submittedAt: `${ds} ${String(hour).padStart(2,'0')}:00:00`, source: 'auto', tokens: type === 'session' ? ioTokens : 0, resetsAt: '' });
    if (type === 'session') {
      usage.push({ nickname: nick, date: ds, input_tokens: inputTokens, output_tokens: outputTokens, cache_tokens: cacheTokens, sessions: 1 + Math.floor(Math.random()*4), reportedAt: `${ds} ${String(hour).padStart(2,'0')}:30:00` });
    }
  }

  for (let i = 0; i < 14; i++) addAuto('Mj', i, 9 + (i % 8), 'session', 1);
  addAuto('Mj', 0, 20, 'weekly', 5);
  addAuto('Mj', 7, 20, 'weekly', 5);

  [0,1,2,4,5,7,8].forEach(i => addAuto('Dc', i, 11, 'session', 1));
  addAuto('Dc', 1, 21, 'weekly', 5);

  [0,2,3,5,6].forEach(i => addAuto('S', i, 14, 'session', 1));
  addAuto('S', 3, 19, 'weekly', 5);

  [0,1,3,6].forEach(i => addAuto('L', i, 10, 'session', 1));
  [0,1].forEach(i => addAuto('Jh', i, 15, 'session', 1));

  [0,1,2,3,5,6].forEach(i => addAuto('Jc', i, 13, 'session', 1));
  addAuto('Jc', 2, 22, 'weekly', 5);

  [0,3,5].forEach(i => addAuto('Dg', i, 16, 'session', 1));

  return {
    success: true,
    members: [
      { nickname: 'Mj', isAdmin: true, hasAutoReport: true },
      { nickname: 'Dc', isAdmin: false, hasAutoReport: true },
      { nickname: 'S', isAdmin: false, hasAutoReport: true },
      { nickname: 'L', isAdmin: false, hasAutoReport: false },
      { nickname: 'Jh', isAdmin: false, hasAutoReport: false },
      { nickname: 'Jc', isAdmin: false, hasAutoReport: true },
      { nickname: 'Dg', isAdmin: false, hasAutoReport: false },
    ],
    submissions: subs,
    usage: usage,
  };
}


// ══════════════════════════════════
// ── 내 분석 (Personal Stats) ──
// ══════════════════════════════════

let personalStatsData = null;
let personalStatsLoaded = false;

async function loadPersonalStats() {
  // 이미 로드했으면 다시 렌더만
  if (personalStatsLoaded && personalStatsData) {
    renderPersonalStats();
    return;
  }

  if (!currentUser || !currentUser.nickname) return;
  const nickname = currentUser.nickname;
  const password = currentUser.password;

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'personalStats', nickname, password }),
      redirect: 'follow'
    });
    const data = await resp.json();
    if (data.success) {
      personalStatsData = data;
      personalStatsLoaded = true;
      renderPersonalStats();
    }
  } catch (e) {
    console.error('personalStats error:', e);
  }
}

function renderPersonalStats() {
  if (!personalStatsData) return;
  const { raw, daily, points } = personalStatsData;

  renderStatsSummary(daily, points);
  renderDailyTrendChart(daily);
  renderHourHeatmap(raw);

  // 날짜 선택기 초기화 — 기본값: 오늘
  const picker = document.getElementById('stats-date-picker');
  if (picker && !picker.dataset.init) {
    const today = new Date();
    const kst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
    picker.value = kst.toISOString().split('T')[0];
    picker.addEventListener('change', () => renderHourlyChart(raw, picker.value));
    picker.dataset.init = '1';
  }
  // 매번 렌더 시 현재 선택된 날짜로 차트 갱신
  if (picker) renderHourlyChart(raw, picker.value);
}

// ── 요약 카드 ──
function renderStatsSummary(daily, points) {
  const today = normalizeDate(new Date().toISOString().split('T')[0]);

  // 오늘 토큰
  const todayData = daily.find(d => normalizeDate(d.date) === today);
  const todayTokens = todayData ? (todayData.input_tokens + todayData.output_tokens) : 0;
  document.getElementById('stats-today-tokens').textContent = formatTokens(todayTokens);

  // 주간 평균 (최근 7일)
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const last7 = sorted.slice(-7);
  const weekAvg = last7.length > 0 ? last7.reduce((s, d) => s + d.input_tokens + d.output_tokens, 0) / last7.length : 0;
  document.getElementById('stats-weekly-avg').textContent = formatTokens(Math.round(weekAvg));

  // 연속 사용일 (스트릭)
  let streak = 0;
  const dateSet = new Set(daily.map(d => normalizeDate(d.date)));
  const d = new Date();
  const kstNow = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  let checkDate = new Date(kstNow);
  while (true) {
    const ds = checkDate.toISOString().split('T')[0];
    if (dateSet.has(ds)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }
  document.getElementById('stats-streak').textContent = streak + '일';

  // 이번 달 포인트
  const curMonth = today.substring(0, 7);
  const monthPts = points
    .filter(p => (normalizeDate(p.date) || '').startsWith(curMonth))
    .reduce((s, p) => s + p.points, 0);
  document.getElementById('stats-month-pts').textContent = monthPts + 'pt';
}

// ── 시간대별 차트 ──
function renderHourlyChart(raw, date) {
  const container = document.getElementById('stats-hourly-chart');

  // 해당 날짜의 가장 마지막(최신) 보고에서 hourly 데이터 사용
  const dayRecords = raw
    .filter(r => normalizeDate(r.date) === date)
    .sort((a, b) => (a.reportedAt || '').localeCompare(b.reportedAt || ''));

  if (dayRecords.length === 0) {
    container.innerHTML = '<div class="stats-placeholder">해당 날짜의 보고 데이터가 없습니다.</div>';
    return;
  }

  // 가장 마지막 보고의 hourly 데이터 사용 (가장 완전한 데이터)
  const latest = dayRecords[dayRecords.length - 1];
  const hourly = {};
  for (let h = 0; h < 24; h++) hourly[h] = 0;

  if (latest.hourly && Array.isArray(latest.hourly)) {
    latest.hourly.forEach(item => {
      const h = item.h;
      if (h >= 0 && h < 24) {
        hourly[h] = (item.in || 0) + (item.out || 0);
      }
    });
  } else {
    // hourly 데이터가 없는 경우 (이전 방식 보고) — 전체 토큰을 보고 시간에 표시
    const hour = parseInt((latest.reportedAt || '').substring(11, 13)) || 0;
    hourly[hour] = latest.input_tokens + latest.output_tokens;
  }

  const max = Math.max(...Object.values(hourly), 1);

  let html = '<div class="bar-chart">';
  for (let h = 0; h < 24; h++) {
    const val = hourly[h];
    const pct = (val / max) * 100;
    html += `<div class="bar-col">`;
    if (val > 0) html += `<div class="bar-value">${formatTokens(val)}</div>`;
    html += `<div class="bar-fill" style="height:${Math.max(pct, val > 0 ? 3 : 0)}%"></div>`;
    html += `<div class="bar-label">${h}</div>`;
    html += `</div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

// ── 일간 추이 (최근 30일) ──
function renderDailyTrendChart(daily) {
  const container = document.getElementById('stats-daily-chart');
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);

  if (sorted.length === 0) {
    container.innerHTML = '<div class="stats-placeholder">사용량 데이터가 없습니다.</div>';
    return;
  }

  const values = sorted.map(d => d.input_tokens + d.output_tokens);
  const max = Math.max(...values, 1);

  // 50K, 100K 기준선 위치
  const line50 = Math.min((50000 / max) * 100, 100);
  const line100 = Math.min((100000 / max) * 100, 100);

  let html = '<div class="bar-chart" style="position:relative;">';

  // 기준선
  if (max >= 50000) {
    html += `<div style="position:absolute;left:0;right:0;bottom:${line50}%;border-top:1px dashed rgba(129,140,248,0.3);pointer-events:none;z-index:1;">
      <span style="position:absolute;left:0;top:-14px;font-size:0.5rem;color:var(--primary);opacity:0.6;">50K</span></div>`;
  }
  if (max >= 100000) {
    html += `<div style="position:absolute;left:0;right:0;bottom:${line100}%;border-top:1px dashed rgba(52,211,153,0.3);pointer-events:none;z-index:1;">
      <span style="position:absolute;left:0;top:-14px;font-size:0.5rem;color:var(--accent);opacity:0.6;">100K</span></div>`;
  }

  sorted.forEach((d, i) => {
    const val = values[i];
    const pct = (val / max) * 100;
    const isAccent = val >= 100000;
    html += `<div class="bar-col" title="${d.date}: ${val.toLocaleString()} tokens">`;
    html += `<div class="bar-fill${isAccent ? ' bar-accent' : ''}" style="height:${Math.max(pct, val > 0 ? 2 : 0)}%"></div>`;
    // 5일 간격으로 라벨
    if (i % 5 === 0 || i === sorted.length - 1) {
      html += `<div class="bar-label">${d.date.substring(5)}</div>`;
    } else {
      html += `<div class="bar-label"></div>`;
    }
    html += `</div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

// ── 활동 시간대 히트맵 ──
function renderHourHeatmap(raw) {
  const container = document.getElementById('stats-hour-heatmap');
  if (!raw || raw.length === 0) {
    container.innerHTML = '<div class="stats-placeholder">보고 데이터가 없습니다.</div>';
    return;
  }

  // 시간대별 총 토큰 집계 (hourly 데이터 기반, 각 날짜의 최신 보고만)
  const tokensByHour = {};
  for (let h = 0; h < 24; h++) tokensByHour[h] = 0;

  // 날짜별 최신 보고 추출
  const byDate = {};
  raw.forEach(r => {
    const d = normalizeDate(r.date);
    if (!byDate[d] || (r.reportedAt || '') > (byDate[d].reportedAt || '')) {
      byDate[d] = r;
    }
  });

  Object.values(byDate).forEach(r => {
    if (r.hourly && Array.isArray(r.hourly)) {
      r.hourly.forEach(item => {
        if (item.h >= 0 && item.h < 24) {
          tokensByHour[item.h] += (item.in || 0) + (item.out || 0);
        }
      });
    }
  });

  const max = Math.max(...Object.values(tokensByHour), 1);

  let html = '<div class="hour-heatmap">';
  for (let h = 0; h < 24; h++) {
    const val = tokensByHour[h];
    const level = val === 0 ? 0 : val <= max * 0.25 ? 1 : val <= max * 0.5 ? 2 : val <= max * 0.75 ? 3 : 4;
    html += `<div class="hour-cell level-${level}" title="${h}시: ${formatTokens(val)}">${val > 0 ? formatTokens(val) : ''}</div>`;
  }
  html += '</div>';

  html += '<div class="hour-hour-labels">';
  for (let h = 0; h < 24; h++) {
    html += `<div class="hour-hour-label">${h}</div>`;
  }
  html += '</div>';

  container.innerHTML = html;
}

// ── 포인트 이력 ──
