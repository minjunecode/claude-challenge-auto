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
const COLOR_PRESETS = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6'];
const DEFAULT_DOT_COLOR = '#d1d5db';
function getMemberColor(n) {
  if (dashboardData && dashboardData.memberColors && dashboardData.memberColors[n]) return dashboardData.memberColors[n];
  return DEFAULT_DOT_COLOR;
}
async function setMemberColor(n, c) {
  if (dashboardData) {
    if (!dashboardData.memberColors) dashboardData.memberColors = {};
    dashboardData.memberColors[n] = c;
    // localStorage 캐시도 즉시 갱신 — 새로고침 시 옛 색상 플래시 방지
    try { localStorage.setItem('dashboardCache', JSON.stringify(dashboardData)); } catch { /* ignore */ }
  }
  // apiCall 경유 (Content-Type text/plain — CORS preflight 회피)
  const result = await apiCall('setColor', {
    nickname: currentUser.nickname,
    password: currentUser.password,
    color: c
  });
  if (!result || !result.success) {
    console.warn('setColor 실패:', result && result.error);
  }
}

// ── 초기화 ──
document.addEventListener('DOMContentLoaded', () => {
  // hash를 초기화 전에 먼저 캡처 (showMain에서 쓰임)
  window._savedHash = location.hash.replace('#', '');
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

  // 주간 네비게이션
  document.getElementById('btn-daily-prev').addEventListener('click', () => { dailyWeekOffset--; renderDashboard(); });
  document.getElementById('btn-daily-next').addEventListener('click', () => { dailyWeekOffset++; renderDashboard(); });

  // 월간 네비게이션 (내 분석 탭)
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

  // 스코어 공식 토글
  const scoreToggle = document.getElementById('score-info-toggle');
  if (scoreToggle) {
    scoreToggle.addEventListener('click', () => {
      const detail = document.getElementById('score-info-detail');
      detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    });
  }

  // 모달
  document.querySelector('.modal-overlay').addEventListener('click', () => { document.getElementById('image-modal').classList.add('hidden'); });
  document.querySelector('.modal-close').addEventListener('click', () => { document.getElementById('image-modal').classList.add('hidden'); });

  // 리그 탭
  setupLeagueTabs();
}

// 리그 탭 클릭 + i 툴팁 토글
function setupLeagueTabs() {
  // 저장된 탭 복원 (기본 ALL)
  try {
    const saved = localStorage.getItem('selectedLeagueTab');
    if (saved === LEAGUE_1M || saved === LEAGUE_10M || saved === LEAGUE_ALL) {
      selectedLeagueTab = saved;
    }
  } catch { /* ignore */ }

  document.querySelectorAll('.league-tab-btn').forEach(btn => {
    if (btn.dataset.league === selectedLeagueTab) btn.classList.add('active');
    else btn.classList.remove('active');
    btn.addEventListener('click', () => {
      selectedLeagueTab = btn.dataset.league;
      try { localStorage.setItem('selectedLeagueTab', selectedLeagueTab); } catch {}
      document.querySelectorAll('.league-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.league === selectedLeagueTab));
      renderDashboard();
    });
  });

  // i 아이콘 툴팁
  const lInfoBtn = document.getElementById('league-info-btn');
  const lTip = document.getElementById('league-tooltip');
  if (lInfoBtn && lTip) {
    lInfoBtn.addEventListener('mouseenter', () => lTip.classList.remove('hidden'));
    lInfoBtn.addEventListener('mouseleave', () => lTip.classList.add('hidden'));
    lInfoBtn.addEventListener('click', (e) => { e.stopPropagation(); lTip.classList.toggle('hidden'); });
    document.addEventListener('click', (e) => {
      if (!lTip.classList.contains('hidden') && !lTip.contains(e.target) && e.target !== lInfoBtn) {
        lTip.classList.add('hidden');
      }
    });
  }
}

// 현재 선택된 리그로 멤버 필터링 (ALL이면 전부)
function filterMembersByLeague(members) {
  if (selectedLeagueTab === LEAGUE_ALL) return members;
  return members.filter(m => {
    const lg = (m.league === LEAGUE_10M || m.league === LEAGUE_1M) ? m.league : LEAGUE_1M;
    return lg === selectedLeagueTab;
  });
}

// ── API ──
async function apiCall(action, params = {}) {
  if (API_URL === 'YOUR_APPS_SCRIPT_URL_HERE') { if (!dashboardData) dashboardData = getDemoData(); return null; }
  const body = { action, ...params };
  try {
    const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), redirect: 'follow' });
    return JSON.parse(await response.text());
  } catch { return { success: false, error: '서버 응답 오류' }; }
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

    // 로그인 응답에 dashboard 데이터가 포함되어 있으면 즉시 캐시
    if (result.dashboard && result.dashboard.success) {
      const db = result.dashboard;
      // myStats 분리 저장
      if (db.myStats) {
        const ps = { success: true, raw: db.myStats.raw, daily: db.myStats.daily, points: db.myStats.points };
        personalStatsData = ps;
        personalStatsLoaded = true;
        localStorage.setItem('personalStatsCache', JSON.stringify(ps));
        delete db.myStats;
      }
      dashboardData = db;
      localStorage.setItem('dashboardCache', JSON.stringify(db));
    }

    showMain();
  } else { errorEl.textContent = result.error; }
}

function handleLogout() {
  currentUser = null; dashboardData = null;
  personalStatsData = null; personalStatsLoaded = false;
  localStorage.removeItem('challengeUser');
  localStorage.removeItem('dashboardCache');
  history.replaceState(null, '', location.pathname);
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
  // ① 페이지 로드 시 캡처한 hash 사용 (switchTab이 덮어쓰기 전)
  const hash = window._savedHash || location.hash.replace('#', '');
  window._savedHash = '';  // 사용 후 초기화
  const validTabs = ['dashboard', 'stats', 'cert', 'admin'];
  const restoredTab = validTabs.includes(hash) ? hash : 'dashboard';

  document.getElementById('login-view').classList.remove('active');
  document.getElementById('main-view').classList.add('active');
  document.getElementById('user-info').textContent = currentUser.nickname + (currentUser.isAdmin ? ' (관리자)' : '');
  document.querySelectorAll('.admin-only').forEach(el => { el.style.display = currentUser.isAdmin ? '' : 'none'; });

  // ② dashboardData 캐시를 먼저 복원 (switchTab에서 stats 렌더 시 필요)
  if (!dashboardData) {
    const cached = localStorage.getItem('dashboardCache');
    if (cached) { try { dashboardData = JSON.parse(cached); } catch { /* ignore */ } }
  }

  // ③ 탭 전환 (즉시 UI 표시) → API는 백그라운드
  switchTab(restoredTab);
  loadDashboard();
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');
  // URL hash에 현재 탭 저장 (새로고침 시 복원용)
  history.replaceState(null, '', '#' + tabName);
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

    // 오늘 토큰 (가중 스코어)
    if (todayUsage) {
      const ioTotal = getScore(todayUsage);
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

// 가중치 스코어: score 필드 있으면 사용, 없으면 가중치 공식 적용
function getScore(d) {
  // 항상 컴포넌트에서 직접 계산 (Date→epoch 오염 방지)
  const inp = d.input_tokens || 0;
  const out = d.output_tokens || 0;
  const cc = d.cache_creation_tokens || 0;
  const cr = d.cache_read_tokens || 0;
  // 컴포넌트가 있으면 공식으로 계산
  if (inp > 0 || out > 0) {
    return Math.round((inp * 1) + (out * 5) + (cc * 1.25) + (cr * 0.1));
  }
  // 컴포넌트 없고 score만 있는 경우 — 10B 이하만 신뢰
  if (d.score && typeof d.score === 'number' && d.score < 10000000000) {
    return d.score;
  }
  return 0;
}
// 포인트 기준 (가중 스코어 기반)
// ── 구 기준 (legacy, LEAGUE_ERA_START 이전 기록 + 내 분석 일부 호환용)
const POINT_1_THRESHOLD = 1000000;    // 1pt: 1M
const POINT_2_THRESHOLD = 10000000;   // 2pt: 10M
const POINT_3_THRESHOLD = 50000000;   // 3pt: 50M

// ── 리그 시스템 ──
const LEAGUE_ERA_START = '2026-04-17';
const LEAGUE_1M = '1M';
const LEAGUE_10M = '10M';
const LEAGUE_ALL = 'ALL';  // "전체 리그" 탭 (필터 없음)
// 리그별 포인트 임계값 [1pt, 2pt, 3pt]
const LEAGUE_THRESHOLDS = {
  '1M':  [1000000,  10000000, 25000000],   // 1M / 10M / 25M
  '10M': [10000000, 50000000, 100000000]   // 10M / 50M / 100M
};
const LEGACY_THRESHOLDS = [1000000, 10000000, 50000000];

// 멤버의 현재 리그 반환 (기본 1M)
function getMemberLeague(nickname) {
  if (!dashboardData || !dashboardData.members) return LEAGUE_1M;
  const m = dashboardData.members.find(x => x.nickname === nickname);
  if (m && (m.league === LEAGUE_10M || m.league === LEAGUE_1M)) return m.league;
  return LEAGUE_1M;
}

// 특정 날짜/리그 조합에서 사용할 임계값 반환 (과거 데이터 호환)
function getThresholdsFor(date, league) {
  // LEAGUE_ERA_START 이전 → 무조건 legacy
  if (date && date < LEAGUE_ERA_START) return LEGACY_THRESHOLDS;
  return LEAGUE_THRESHOLDS[league] || LEAGUE_THRESHOLDS[LEAGUE_1M];
}

// 현재 선택된 리그 탭 (ALL = 전체)
let selectedLeagueTab = LEAGUE_ALL;

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
  if (!dashboardData) {
    const cached = localStorage.getItem('dashboardCache');
    if (cached) {
      try { dashboardData = JSON.parse(cached); } catch { /* ignore */ }
    }
  }
  if (dashboardData) renderDashboard();

  if (!personalStatsLoaded) {
    const psCached = localStorage.getItem('personalStatsCache');
    if (psCached) {
      try {
        const ps = JSON.parse(psCached);
        if (ps && ps.success) { personalStatsData = ps; personalStatsLoaded = true; }
      } catch { /* ignore */ }
    }
  }

  // 2) 백그라운드에서 최신 데이터 가져오기
  const params = {};
  if (currentUser && currentUser.nickname) params.nickname = currentUser.nickname;
  if (currentUser && currentUser.password) params.password = currentUser.password;
  const result = await apiCall('dashboard', params);
  if (result && result.success) {
    // myStats가 포함되어 있으면 personalStats 캐시도 갱신
    if (result.myStats) {
      const ps = { success: true, raw: result.myStats.raw, daily: result.myStats.daily, points: result.myStats.points };
      personalStatsData = ps;
      personalStatsLoaded = true;
      localStorage.setItem('personalStatsCache', JSON.stringify(ps));
      // 현재 내 분석 탭이 열려있으면 즉시 렌더
      if (document.getElementById('tab-stats').classList.contains('active')) {
        renderPersonalStats();
      }
      delete result.myStats; // dashboardCache에는 저장 안 함 (용량 절약)
    }
    dashboardData = result;
    localStorage.setItem('dashboardCache', JSON.stringify(result));
    // dashboardData 갱신 후 stats 탭 활성 시 피어 비교 재렌더 (members/memberHourly 필요)
    if (personalStatsLoaded && document.getElementById('tab-stats').classList.contains('active')) {
      renderPersonalStats();
    }
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
        if (!dailyMap[s.nickname][dateStr]) dailyMap[s.nickname][dateStr] = { done: true, tokens: 0, allTokens: 0, source: s.source };
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
        const ioTokens = getScore(u);
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
    // 오늘 500K+ 가중 스코어를 보고한 멤버에게 🔥 표시 (서버 시간 기준, 모든 사용자 동일)
    if (dashboardData && dashboardData.memberLastActivity) {
      const act = dashboardData.memberLastActivity[m.nickname];
      if (act && act.score >= 500000 && act.reportedAt) {
        const reportedDate = act.reportedAt.substring(0, 10);
        const today = getTodayStr();
        if (reportedDate === today) {
          const fire = document.createElement('span');
          fire.className = 'fire-badge';
          fire.textContent = '🔥';
          fire.title = `오늘 ${(act.score / 1000).toFixed(0)}K (가중)`;
          nameTd.appendChild(fire);
        }
      }
    }
    tr.appendChild(nameTd);

    // 멤버의 현재 리그 (LEAGUE_ERA_START 이후 임계값 결정용)
    const memLeague = (m.league === LEAGUE_10M || m.league === LEAGUE_1M) ? m.league : LEAGUE_1M;
    days.forEach(d => {
      const td = document.createElement('td');
      const info = dailyMap[m.nickname][d.date];
      const tokens = info ? info.tokens : 0;
      // 날짜+리그에 맞는 임계값 (legacy 기간엔 1M/10M/50M)
      const t = getThresholdsFor(d.date, memLeague);
      if (d.date > today) {
        td.classList.add('daily-td-future');
      } else if (d.date === today) {
        td.classList.add('daily-td-today');
        if (tokens >= t[2]) {
          td.classList.add('daily-td-done');
          td.textContent = 'OOO';
        } else if (tokens >= t[1]) {
          td.classList.add('daily-td-done');
          td.textContent = 'OO';
        } else if (tokens >= t[0]) {
          td.classList.add('daily-td-done');
          td.textContent = 'O';
        } else {
          td.classList.add('daily-td-pending');
          td.textContent = '-';
        }
      } else {
        if (tokens >= t[2]) {
          td.classList.add('daily-td-done');
          td.textContent = 'OOO';
        } else if (tokens >= t[1]) {
          td.classList.add('daily-td-done');
          td.textContent = 'OO';
        } else if (tokens >= t[0]) {
          td.classList.add('daily-td-done');
          td.textContent = 'O';
        } else {
          td.classList.add('daily-td-miss');
          td.textContent = 'X';
        }
      }
      if (tokens > 0) {
        td.title = `가중 스코어: ${tokens.toLocaleString()} (${memLeague} 리그 기준)`;
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
  if (!currentUser) return;
  const grid = document.getElementById('calendar-grid');
  if (!grid) return; // 내 분석 탭이 렌더링되기 전이면 종료
  const today = getTodayStr();
  const now = new Date();
  const targetDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth();

  document.getElementById('month-label').textContent = `${year}년 ${month + 1}월`;

  // 데이터 소스 우선순위: personalStatsData.daily (내 분석 전용) → dashboardData.usage (fallback)
  const tokenMap = {};
  if (personalStatsData && personalStatsData.daily) {
    personalStatsData.daily.forEach(d => {
      const ioTokens = getScore(d);
      if (ioTokens > 0) tokenMap[normalizeDate(d.date)] = ioTokens;
    });
  } else if (dashboardData && dashboardData.usage) {
    dashboardData.usage.forEach(u => {
      if (u.nickname === currentUser.nickname) {
        const ioTokens = getScore(u);
        if (ioTokens > 0) tokenMap[normalizeDate(u.date)] = ioTokens;
      }
    });
  }

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
  const myLeague = getMemberLeague(currentUser.nickname);

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
        // 날짜+리그 기준 임계값
        const t = getThresholdsFor(dateStr, myLeague);

        let innerHtml = `<span class="cal-num">${dayNum}</span>`;
        if (tokens > 0) innerHtml += `<span class="cal-tokens">${formatTokens(tokens)}</span>`;
        el.innerHTML = innerHtml;

        if (dateStr > today) el.classList.add('future');
        else if (dateStr === today) {
          el.classList.add('today');
          el.classList.add(tokens >= t[0] ? 'done' : 'pending');
        } else {
          el.classList.add(tokens >= t[0] ? 'done' : 'miss');
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
  const { members: allMembers, submissions } = dashboardData;
  // 리그 필터 적용 (주간뷰/TOP3/주간토큰만 영향, 1:1 비교는 전체 유지)
  const members = filterMembersByLeague(allMembers);
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

  const ranked = members.map(m => ({ nickname: m.nickname, hasAutoReport: m.hasAutoReport, league: m.league, ...scores[m.nickname] })).sort((a, b) => b.total - a.total);

  // 일간 토큰 순위 계산
  const now2 = new Date();
  const todayStr2 = getTodayStr();
  const dailyTokens = {};
  members.forEach(m => { dailyTokens[m.nickname] = 0; });
  if (dashboardData.usage) {
    dashboardData.usage.forEach(u => {
      if (normalizeDate(u.date) === todayStr2 && dailyTokens[u.nickname] !== undefined) {
        dailyTokens[u.nickname] += getScore(u);
      }
    });
  }
  const dailyTokenRanked = members.map(m => ({ nickname: m.nickname, hasAutoReport: m.hasAutoReport, league: m.league, dayTokens: dailyTokens[m.nickname] || 0, ...scores[m.nickname] })).sort((a, b) => b.dayTokens - a.dayTokens);

  // 주간 토큰 순위 계산
  const dow = now2.getDay(); // 0=Sun
  const monOff = dow === 0 ? 6 : dow - 1;
  const mon = new Date(now2);
  mon.setDate(mon.getDate() - monOff);
  const monStr = `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
  const weeklyTokens = {};
  members.forEach(m => { weeklyTokens[m.nickname] = 0; });
  if (dashboardData.usage) {
    dashboardData.usage.forEach(u => {
      const ud = normalizeDate(u.date);
      if (ud >= monStr && ud <= todayStr2 && weeklyTokens[u.nickname] !== undefined) {
        weeklyTokens[u.nickname] += getScore(u);
      }
    });
  }
  const weeklyTokenRanked = members.map(m => ({ nickname: m.nickname, hasAutoReport: m.hasAutoReport, league: m.league, weekTokens: weeklyTokens[m.nickname] || 0, ...scores[m.nickname] })).sort((a, b) => b.weekTokens - a.weekTokens);

  // 월간 토큰 순위 계산
  const curMonth = `${now2.getFullYear()}-${String(now2.getMonth()+1).padStart(2,'0')}`;
  const monthlyTokens = {};
  members.forEach(m => { monthlyTokens[m.nickname] = 0; });
  if (dashboardData.usage) {
    dashboardData.usage.forEach(u => {
      if (normalizeDate(u.date).startsWith(curMonth) && monthlyTokens[u.nickname] !== undefined) {
        monthlyTokens[u.nickname] += getScore(u);
      }
    });
  }
  const tokenRanked = members.map(m => ({ nickname: m.nickname, hasAutoReport: m.hasAutoReport, league: m.league, monthTokens: monthlyTokens[m.nickname] || 0, ...scores[m.nickname] })).sort((a, b) => b.monthTokens - a.monthTokens);

  // 저장 (renderPodium에서 사용)
  dashboardData._ranked = ranked;
  dashboardData._dailyTokenRanked = dailyTokenRanked;
  dashboardData._weeklyTokenRanked = weeklyTokenRanked;
  dashboardData._tokenRanked = tokenRanked;

  // 일간 테이블 (필터된 멤버 전달)
  renderDailyTable(members, submissions);

  // ── 내 현황은 '내 분석' 탭에서 렌더하지만, 대시보드 진입 시점에도 캐시된 personalStatsData가 있으면
  //   닉네임/포인트 카드를 갱신해 둔다. 여기서는 항상 전체 멤버 기준으로 누적 포인트를 계산.
  updateMyStatusCard(allMembers, submissions, currentWeek, currentYear);

  // TOP 3 — 현재 선택된 뷰로 렌더
  const activeView = document.querySelector('.rank-toggle-btn.active')?.dataset.rank || 'points';
  renderPodium(activeView);

  // 1:1 피어 비교
  const myRaw = personalStatsData ? personalStatsData.raw : [];
  initPeerCompare(myRaw);

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

// 내 분석 탭의 상단 닉네임/포인트/레벨 카드 갱신.
// 누적 포인트 순위는 항상 '전체 멤버 기준'으로 계산.
function updateMyStatusCard(allMembers, submissions, currentWeek, currentYear) {
  if (!currentUser) return;
  const allScores = {};
  allMembers.forEach(m => { allScores[m.nickname] = { weekly: 0, total: 0, streak: 0 }; });
  submissions.forEach(s => {
    const pts = s.points || (s.type === 'weekly' ? 5 : 1);
    if (allScores[s.nickname]) {
      allScores[s.nickname].total += pts;
      if (s.year === currentYear && s.week === currentWeek) allScores[s.nickname].weekly += pts;
    }
  });
  allMembers.forEach(m => { allScores[m.nickname].streak = getStreak(m.nickname, submissions, currentWeek, currentYear); });
  const allRanked = allMembers.map(m => ({ nickname: m.nickname, ...allScores[m.nickname] })).sort((a, b) => b.total - a.total);
  const myIdx = allRanked.findIndex(r => r.nickname === currentUser.nickname);
  const my = myIdx >= 0 ? allRanked[myIdx] : { weekly: 0, total: 0, streak: 0 };
  const myLevel = getLevel(my.total);
  const myNext = getNextLevel(my.total);
  const myLeague = getMemberLeague(currentUser.nickname);

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  setText('my-rank-badge', myIdx >= 0 ? myIdx + 1 : '-');
  setText('my-status-name', currentUser.nickname);
  setText('my-status-level', myLevel.name);
  setText('my-weekly-pts', my.weekly);
  setText('my-total-pts', my.total);
  setText('my-streak', my.streak);

  // 리그 뱃지
  const badge = document.getElementById('my-league-badge');
  if (badge) {
    badge.textContent = myLeague + ' 리그';
    badge.classList.toggle('league-10M', myLeague === LEAGUE_10M);
  }

  setText('level-current', myLevel.name);
  const fill = document.getElementById('level-progress-fill');
  if (myNext) {
    setText('level-next', myNext.name);
    if (fill) fill.style.width = `${Math.min(100, ((my.total - myLevel.min) / (myNext.min - myLevel.min)) * 100)}%`;
    setText('level-progress-text', `${myNext.min - my.total}pt more to ${myNext.name}`);
  } else {
    setText('level-next', 'MAX');
    if (fill) fill.style.width = '100%';
    setText('level-progress-text', 'Maximum level reached');
  }

  // 레벨 툴팁 푸터: 내 리그 기준 임계값 노출
  const tooltipFooter = document.getElementById('level-tooltip-footer');
  const t = LEAGUE_THRESHOLDS[myLeague] || LEAGUE_THRESHOLDS[LEAGUE_1M];
  if (tooltipFooter) {
    tooltipFooter.textContent = `${formatTokens(t[0])}+ → 1pt · ${formatTokens(t[1])}+ → 2pt · ${formatTokens(t[2])}+ → 3pt / 일 (${myLeague} 리그 기준)`;
  }
  // 토큰 산정 방식 안내 푸터
  const sptText = document.getElementById('score-points-text');
  if (sptText) {
    sptText.textContent = `1pt = ${formatTokens(t[0])} · 2pt = ${formatTokens(t[1])} · 3pt = ${formatTokens(t[2])} (${myLeague} 리그 · 일간 가중 스코어 기준)`;
  }
}

// ── 관리자 ──
function switchRankView(view) {
  document.querySelectorAll('.rank-toggle-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.rank-toggle-btn[data-rank="${view}"]`).classList.add('active');
  renderPodium(view);
}

function renderPodium(view) {
  if (!dashboardData) return;
  const ranked = view === 'tokens' ? (dashboardData._tokenRanked || [])
    : view === 'weeklyTokens' ? (dashboardData._weeklyTokenRanked || [])
    : view === 'dailyTokens' ? (dashboardData._dailyTokenRanked || [])
    : (dashboardData._ranked || []);

  const podium = document.getElementById('podium');
  podium.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉'];
  ranked.slice(0, 3).forEach((r, i) => {
    const level = getLevel(r.total);
    const card = document.createElement('div');
    card.className = `podium-card${i === 0 ? ' first' : ''}`;
    let mainStat;
    if (view === 'tokens') {
      mainStat = `<div class="podium-pts">${formatTokens(r.monthTokens)}</div><div class="podium-weekly">이번 달 토큰</div>`;
    } else if (view === 'weeklyTokens') {
      mainStat = `<div class="podium-pts">${formatTokens(r.weekTokens)}</div><div class="podium-weekly">이번 주 토큰</div>`;
    } else if (view === 'dailyTokens') {
      mainStat = `<div class="podium-pts">${formatTokens(r.dayTokens)}</div><div class="podium-weekly">오늘 토큰</div>`;
    } else {
      mainStat = `<div class="podium-pts">${r.total}pt</div><div class="podium-weekly">this week +${r.weekly}</div>`;
    }
    card.innerHTML = `
      <div class="podium-medal">${medals[i]}</div>
      <div class="podium-name">${escapeHtml(r.nickname)}</div>
      <div class="podium-level">${level.name}</div>
      ${mainStat}
      ${view === 'points' && r.streak > 0 ? `<span class="podium-streak${r.streak >= 3 ? ' hot' : ''}">${r.streak}w streak</span>` : ''}
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
      const statText = view === 'tokens' ? formatTokens(r.monthTokens) : view === 'weeklyTokens' ? formatTokens(r.weekTokens) : view === 'dailyTokens' ? formatTokens(r.dayTokens) : `${r.total}pt`;
      item.innerHTML = `
        <span class="rest-rank-num">${i + 4}</span>
        <div class="rest-rank-info">
          <div class="rest-rank-name">${escapeHtml(r.nickname)}</div>
          <div class="rest-rank-level">${level.name}${view === 'points' && r.streak > 0 ? ` · ${r.streak}w streak` : ''}</div>
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
    const lg = (m.league === LEAGUE_10M || m.league === LEAGUE_1M) ? m.league : LEAGUE_1M;
    const lgBadge = `<span class="my-league-badge ${lg === LEAGUE_10M ? 'league-10M' : ''}">${lg}</span>`;
    li.innerHTML = `<span><span class="member-name">${escapeHtml(m.nickname)}</span>${lgBadge}${m.isAdmin ? '<span class="member-badge">관리자</span>' : ''}${m.hasAutoReport ? '<span class="auto-badge">auto</span>' : ''}</span>`;
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
  const container = document.querySelector('.stats-container');
  if (!container) return;

  if (!currentUser || !currentUser.nickname) return;

  // 1) 이미 loadDashboard에서 데이터를 받았으면 즉시 렌더
  if (personalStatsLoaded && personalStatsData) {
    renderPersonalStats();
    return;
  }

  // 2) 캐시에서 표시
  const cached = localStorage.getItem('personalStatsCache');
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.success) {
        personalStatsData = parsed;
        personalStatsLoaded = true;
        renderPersonalStats();
        return; // dashboard API가 백그라운드에서 갱신해줄 것
      }
    } catch { /* ignore */ }
  }

  // 3) 캐시도 없고 데이터도 없으면 — password 확인 후 별도 API 호출
  if (!currentUser.password) {
    container.innerHTML =
      '<div class="stats-placeholder" style="padding:40px;text-align:center;">' +
      '내 분석 기능을 사용하려면 재로그인이 필요합니다.<br><br>' +
      '<button onclick="handleLogout()" class="btn btn-primary" style="display:inline-block;width:auto;padding:8px 24px;">재로그인</button></div>';
    return;
  }

  container.querySelectorAll('.stats-placeholder').forEach(el => { el.textContent = '데이터 로딩 중...'; });

  const data = await apiCall('personalStats', { nickname: currentUser.nickname, password: currentUser.password });

  if (data && data.success) {
    personalStatsData = data;
    personalStatsLoaded = true;
    localStorage.setItem('personalStatsCache', JSON.stringify(data));
    renderPersonalStats();
  } else if (!personalStatsLoaded) {
    // Only show error if we have no cached data
    if (data && data.error) {
      container.innerHTML =
        '<div class="stats-placeholder" style="padding:40px;text-align:center;">' + data.error + '</div>';
    } else {
      container.innerHTML =
        '<div class="stats-placeholder" style="padding:40px;text-align:center;">서버 연결 실패. 잠시 후 다시 시도해주세요.</div>';
    }
  }
}

function renderPersonalStats() {
  if (!personalStatsData) return;
  const { raw, daily, points } = personalStatsData;

  // 닉네임/포인트/레벨 카드 동기화 (대시보드에서 이동됨)
  if (dashboardData && dashboardData.members && dashboardData.submissions) {
    const cw = getISOWeek(new Date());
    const cy = new Date().getFullYear();
    updateMyStatusCard(dashboardData.members, dashboardData.submissions, cw, cy);
  }

  renderMonthlyCalendar();
  renderStatsSummary(daily, points);
  renderDailyTrendChart(daily);
  renderActivityPattern(raw);

  // 날짜 선택기 초기화 — 기본값: raw 데이터가 있는 최신 날짜 (없으면 오늘)
  const picker = document.getElementById('stats-date-picker');
  if (picker && !picker.dataset.init) {
    const latestRawDate = raw.length > 0
      ? [...raw].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0].date
      : null;
    if (latestRawDate) {
      picker.value = normalizeDate(latestRawDate);
    } else {
      const today = new Date();
      const kst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
      picker.value = kst.toISOString().split('T')[0];
    }
    picker.addEventListener('change', () => renderHourlyChart(raw, picker.value));
    picker.dataset.init = '1';
  }
  if (picker) renderHourlyChart(raw, picker.value);
}

// ── 요약 카드 (오늘 / 이번 주 / 이번 달) ──
function renderStatsSummary(daily, points) {
  const today = getTodayStr();

  // ── 오늘 토큰 + 목표 프로그레스 ──
  const todayData = daily.find(d => normalizeDate(d.date) === today);
  const todayTokens = todayData ? getScore(todayData) : 0;
  document.getElementById('stats-today-tokens').textContent = formatTokens(todayTokens);

  // 내 리그 기준 임계값
  const myLeague = currentUser ? getMemberLeague(currentUser.nickname) : LEAGUE_1M;
  const t = getThresholdsFor(today, myLeague);
  // 게이지 스케일 — 3pt 임계값 기준 (110%까지 허용)
  const goalMax = t[2];

  // Goal progress bar
  const goalFill = document.getElementById('stats-goal-fill');
  if (goalFill) {
    const pct = Math.min((todayTokens / goalMax) * 100, 110);
    goalFill.style.width = pct + '%';
    goalFill.className = 'stat-goal-fill' +
      (todayTokens >= t[2] ? ' goal-3pt' : todayTokens >= t[1] ? ' goal-100k' : todayTokens >= t[0] ? ' goal-50k' : '');
  }

  // 동적 라벨 (0 / 1pt / 2pt / 3pt 위치)
  const goalLabels = document.getElementById('stats-goal-labels');
  if (goalLabels) {
    const pct1 = Math.min((t[0] / goalMax) * 100, 100);
    const pct2 = Math.min((t[1] / goalMax) * 100, 100);
    goalLabels.innerHTML = `
      <span style="left:0%;transform:translateX(0);">0</span>
      <span style="left:${pct1}%;">${formatTokens(t[0])}</span>
      <span style="left:${pct2}%;">${formatTokens(t[1])}</span>
      <span style="left:100%;transform:translateX(-100%);">${formatTokens(t[2])}</span>
    `;
  }

  // Point badge
  const badge = document.getElementById('stats-today-badge');
  if (badge) {
    const pts = todayTokens >= t[2] ? 3 : todayTokens >= t[1] ? 2 : todayTokens >= t[0] ? 1 : 0;
    badge.textContent = pts + 'pt';
    badge.className = 'stat-point-badge badge-' + Math.min(pts, 2);
  }

  // ── 이번 주 (월~일) ──
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  // Get current week's Monday (로컬 시간 기준)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(monday.getDate() - mondayOffset);
  const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;

  const weekDays = sorted.filter(d => normalizeDate(d.date) >= mondayStr && normalizeDate(d.date) <= today);
  const weekTotal = weekDays.reduce((s, d) => s + getScore(d), 0);
  const weekAvg = weekDays.length > 0 ? Math.round(weekTotal / weekDays.length) : 0;
  document.getElementById('stats-weekly-total').textContent = formatTokens(weekTotal);
  document.getElementById('stats-weekly-avg').textContent = formatTokens(weekAvg);

  // ── 이번 달 ──
  const curMonth = today.substring(0, 7);
  const monthDays = sorted.filter(d => normalizeDate(d.date).startsWith(curMonth));
  const monthTotal = monthDays.reduce((s, d) => s + getScore(d), 0);
  const monthPts = points
    .filter(p => (normalizeDate(p.date) || '').startsWith(curMonth))
    .reduce((s, p) => s + p.points, 0);
  document.getElementById('stats-monthly-total').textContent = formatTokens(monthTotal);
  document.getElementById('stats-month-pts').textContent = monthPts + 'pt';
}

// ── 시간대별 차트 ──
function renderHourlyChart(raw, date) {
  const container = document.getElementById('stats-hourly-chart');

  const dayRecords = raw
    .filter(r => normalizeDate(r.date) === date)
    .sort((a, b) => (a.reportedAt || '').localeCompare(b.reportedAt || ''));

  if (dayRecords.length === 0) {
    container.innerHTML = '<div class="stats-placeholder">해당 날짜의 보고 데이터가 없습니다.</div>';
    return;
  }

  // Check if ANY record for this date has hourly data
  const latest = dayRecords[dayRecords.length - 1];
  const hasHourly = latest.hourly && Array.isArray(latest.hourly) && latest.hourly.length > 0;

  if (!hasHourly) {
    // No hourly data — show informational message instead of faking it
    const total = getScore(latest);
    container.innerHTML =
      '<div class="stats-info-msg">' +
      '시간대별 데이터는 자동 리포팅 업데이트 후 수집됩니다.<br>' +
      '<span style="font-size:0.7rem;margin-top:6px;display:inline-block;">이 날짜 총 사용량: ' + formatTokens(total) + '</span>' +
      '</div>';
    return;
  }

  // Build hourly data from the latest report (가중 스코어 적용)
  const hourlyScores = {};
  for (let h = 0; h < 24; h++) { hourlyScores[h] = { inp: 0, out: 0, cc: 0, cr: 0, total: 0 }; }
  latest.hourly.forEach(item => {
    const h = item.h;
    if (h >= 0 && h < 24) {
      const inp = (item.in || 0) * 1;
      const out = (item.out || 0) * 5;
      const cc = (item.cc || 0) * 1.25;
      const cr = (item.cr || 0) * 0.1;
      hourlyScores[h] = { inp, out, cc, cr, total: inp + out + cc + cr };
    }
  });

  const max = Math.max(...Array.from({length: 24}, (_, h) => hourlyScores[h].total), 1);

  // Snap max to nice breakpoint for consistent scale
  const barBreaks = [1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000];
  const niceMax = barBreaks.find(b => b >= max) || max;

  let html = '<div class="bar-chart">';
  for (let h = 0; h < 24; h++) {
    const s = hourlyScores[h];
    const total = s.total;
    const totalPct = Math.min((total / niceMax) * 100, 100);
    const barHeight = total > 0 ? Math.max(totalPct, 4) : 0;
    html += `<div class="bar-col" title="${h}시: ${formatTokens(total)} (I×1+O×5+Cw×1.25+Cr×0.1)">`;
    if (total > 0) html += `<div class="bar-value">${formatTokens(total)}</div>`;
    html += `<div class="bar-stack" style="height:${barHeight}%">`;
    // 아래→위: cache_read, cache_write, output, input
    if (total > 0) {
      html += `<div class="bar-seg-cr" style="height:${(s.cr/total)*100}%"></div>`;
      html += `<div class="bar-seg-cc" style="height:${(s.cc/total)*100}%"></div>`;
      html += `<div class="bar-seg-output" style="height:${(s.out/total)*100}%"></div>`;
      html += `<div class="bar-seg-input" style="height:${(s.inp/total)*100}%"></div>`;
    }
    html += `</div>`;
    html += `<div class="bar-label">${h}</div>`;
    html += `</div>`;
  }
  html += '</div>';
  // Legend
  html += '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:6px;font-size:0.65rem;color:var(--text-muted);">';
  html += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(129,140,248,0.25);vertical-align:middle;margin-right:3px;"></span>input ×1</span>';
  html += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(129,140,248,0.5);vertical-align:middle;margin-right:3px;"></span>output ×5</span>';
  html += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(167,139,250,0.4);vertical-align:middle;margin-right:3px;"></span>cache write ×1.25</span>';
  html += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(167,139,250,0.2);vertical-align:middle;margin-right:3px;"></span>cache read ×0.1</span>';
  html += '</div>';
  container.innerHTML = html;
}

// ── 일간 사용량 (최근 14일, 수평 바 차트) ──
function renderDailyTrendChart(daily) {
  const container = document.getElementById('stats-daily-chart');
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);

  if (sorted.length === 0) {
    container.innerHTML = '<div class="stats-placeholder">사용량 데이터가 없습니다.</div>';
    return;
  }

  // 내 리그 기준 임계값 (오늘 기준)
  const today = getTodayStr();
  const myLeague = currentUser ? getMemberLeague(currentUser.nickname) : LEAGUE_1M;
  const t = getThresholdsFor(today, myLeague);

  // 스케일: 3pt 임계값에 20% 여유
  const maxTotal = Math.max(t[2] * 1.2, 60000000);

  // Build threshold positions
  const pct1pt = (t[0] / maxTotal) * 100;
  const pct2pt = (t[1] / maxTotal) * 100;
  const pct3pt = (t[2] / maxTotal) * 100;

  let html = '<div class="hbar-chart">';

  // Scale label (max value on the right + 리그 표시)
  html += `<div class="hbar-scale-header"><span style="font-size:0.6rem;color:var(--text-muted);">${myLeague} 리그 기준</span><span class="hbar-scale-max">${formatTokens(maxTotal)}</span></div>`;

  // Threshold lines container (positioned over the track area)
  html += '<div style="position:relative;margin-left:58px;margin-right:56px;height:0;pointer-events:none;z-index:2;">';
  if (pct1pt <= 100) {
    html += `<div style="position:absolute;left:${pct1pt}%;top:0;bottom:0;width:0;border-left:1.5px dashed rgba(129,140,248,0.5);height:${sorted.length * 26 + 4}px;z-index:5;">
      <span style="position:absolute;top:-14px;left:2px;font-size:0.5rem;color:var(--primary);opacity:0.8;white-space:nowrap;">${formatTokens(t[0])} (1pt)</span></div>`;
  }
  if (pct2pt <= 100) {
    html += `<div style="position:absolute;left:${pct2pt}%;top:0;bottom:0;width:0;border-left:1.5px dashed rgba(234,88,12,0.5);height:${sorted.length * 26 + 4}px;z-index:5;">
      <span style="position:absolute;top:-14px;left:2px;font-size:0.5rem;color:rgba(234,88,12,0.8);opacity:1;white-space:nowrap;">${formatTokens(t[1])} (2pt)</span></div>`;
  }
  if (pct3pt <= 100) {
    html += `<div style="position:absolute;left:${pct3pt}%;top:0;bottom:0;width:0;border-left:1.5px dashed rgba(220,38,38,0.5);height:${sorted.length * 26 + 4}px;z-index:5;">
      <span style="position:absolute;top:-14px;left:2px;font-size:0.5rem;color:rgba(220,38,38,0.8);opacity:1;white-space:nowrap;">${formatTokens(t[2])} (3pt)</span></div>`;
  }
  html += '</div>';

  sorted.forEach(d => {
    const total = getScore(d);
    // 행별 임계값 — 과거 날짜는 legacy, era 이후는 내 리그 기준
    const tr = getThresholdsFor(normalizeDate(d.date), myLeague);
    const tier = total >= tr[2] ? 'gold' : total >= tr[1] ? 'green' : total >= tr[0] ? 'blue' : 'gray';
    const totalPct = (total / maxTotal) * 100;
    const dateLabel = d.date.substring(5); // MM-DD

    html += `<div class="hbar-row hbar-tier-${tier}" title="${d.date}: ${formatTokens(total)}">`;
    html += `<div class="hbar-date">${dateLabel}</div>`;
    html += `<div class="hbar-track">`;
    html += `<div class="hbar-fill-input" style="width:${totalPct}%"></div>`;
    html += `</div>`;
    html += `<div class="hbar-amount">${formatTokens(total)}</div>`;
    html += `</div>`;
  });

  html += '</div>';
  container.innerHTML = html;
}

// ── 활동 패턴 (7일 x 24시간 히트맵) ──
function renderActivityPattern(raw) {
  const container = document.getElementById('stats-activity-pattern');
  if (!raw || raw.length === 0) {
    container.innerHTML = '<div class="stats-placeholder">보고 데이터가 없습니다.</div>';
    return;
  }

  // 날짜별 최신 보고 추출
  const byDate = {};
  raw.forEach(r => {
    const d = normalizeDate(r.date);
    if (!byDate[d] || (r.reportedAt || '') > (byDate[d].reportedAt || '')) {
      byDate[d] = r;
    }
  });

  // 요일(0=월~6=일) x 시간(0~23) 집계
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const dayLabels = ['월', '화', '수', '목', '금', '토', '일'];

  Object.entries(byDate).forEach(([dateStr, r]) => {
    if (!r.hourly || !Array.isArray(r.hourly)) return;
    const dt = new Date(dateStr + 'T00:00:00+09:00');
    const jsDay = dt.getDay(); // 0=Sun
    const dow = jsDay === 0 ? 6 : jsDay - 1; // 0=Mon
    r.hourly.forEach(item => {
      if (item.h >= 0 && item.h < 24) {
        grid[dow][item.h] += ((item.in || 0) * 1) + ((item.out || 0) * 5);
      }
    });
  });

  const allVals = grid.flat();
  const max = Math.max(...allVals, 1);

  // Check if we have any data at all
  const hasData = allVals.some(v => v > 0);
  if (!hasData) {
    container.innerHTML = '<div class="stats-info-msg">시간대별 데이터가 수집되면 활동 패턴이 표시됩니다.</div>';
    return;
  }

  let html = '<div class="activity-heatmap">';
  html += '<div class="activity-heatmap-grid">';

  // Header row: empty corner + 24 hour labels
  html += '<div class="activity-heatmap-header"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="activity-heatmap-header">${h}</div>`;
  }

  // 7 rows (월~일)
  for (let dow = 0; dow < 7; dow++) {
    html += `<div class="activity-heatmap-day-label">${dayLabels[dow]}</div>`;
    for (let h = 0; h < 24; h++) {
      const val = grid[dow][h];
      const level = val === 0 ? 0 : val <= max * 0.25 ? 1 : val <= max * 0.5 ? 2 : val <= max * 0.75 ? 3 : 4;
      html += `<div class="activity-cell level-${level}" title="${dayLabels[dow]} ${h}시: ${formatTokens(val)}"></div>`;
    }
  }

  html += '</div>';

  // Legend
  html += '<div class="activity-heatmap-legend">';
  html += '<span>적음</span>';
  for (let l = 0; l <= 4; l++) {
    html += `<div class="activity-legend-cell level-${l} activity-cell"></div>`;
  }
  html += '<span>많음</span>';
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;
}

// ── 1:1 피어 비교 ──
let _peerRaw = null; // initPeerCompare에서 저장, 드롭다운 클릭 시 사용

function initPeerCompare(raw) {
  const btn = document.getElementById('peer-dropdown-btn');
  const menu = document.getElementById('peer-dropdown-menu');
  const area = document.getElementById('peer-compare-area');
  if (!btn || !menu || !area || !dashboardData) return;
  _peerRaw = raw;

  const myNick = currentUser ? currentUser.nickname : '';
  const members = (dashboardData.members || []).filter(m => m.nickname !== myNick);
  const topNick = dashboardData.topUser ? dashboardData.topUser.nickname : '';

  // 메뉴 항목 생성
  menu.innerHTML = '';
  members.forEach(m => {
    const item = document.createElement('div');
    item.className = 'peer-dropdown-item';
    item.dataset.nick = m.nickname;

    // 활동 지표 뱃지
    const act = dashboardData.memberLastActivity ? dashboardData.memberLastActivity[m.nickname] : null;
    const isActive = act && act.score >= 500000 && act.reportedAt && (Date.now() - new Date(act.reportedAt).getTime()) <= 3600000;

    let label = escapeHtml(m.nickname);
    if (m.nickname === topNick) label += ' <span class="peer-tag peer-tag-top">주간 1위</span>';
    if (isActive) label += ' <span class="peer-tag peer-tag-fire">🔥</span>';

    item.innerHTML = label;
    item.addEventListener('click', () => {
      selectPeer(m.nickname);
      closeDropdown();
    });
    menu.appendChild(item);
  });

  // 기본값: 주간 1위 (본인이 아니면)
  if (topNick && topNick !== myNick) {
    selectPeer(topNick);
  }

  // 토글
  btn.onclick = (e) => {
    e.stopPropagation();
    const dd = document.getElementById('peer-dropdown');
    dd.classList.toggle('open');
  };
  // 외부 클릭 시 닫기
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('peer-dropdown');
    if (dd && !dd.contains(e.target)) dd.classList.remove('open');
  });
}

function selectPeer(nick) {
  const btnText = document.querySelector('#peer-dropdown-btn .peer-dropdown-text');
  if (btnText) btnText.textContent = nick;

  // 선택된 항목 하이라이트
  document.querySelectorAll('.peer-dropdown-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.nick === nick);
  });

  renderPeerCompare(nick, _peerRaw);
}

function closeDropdown() {
  const dd = document.getElementById('peer-dropdown');
  if (dd) dd.classList.remove('open');
}

function renderPeerCompare(peerNick, raw) {
  const area = document.getElementById('peer-compare-area');
  if (!area || !dashboardData) return;
  const myNick = currentUser ? currentUser.nickname : '';
  const usage = dashboardData.usage || [];
  const today = getTodayStr();

  // ── 날짜 유틸 ──
  const now = new Date();
  const dow = now.getDay() || 7;
  const mon = new Date(now); mon.setDate(now.getDate() - dow + 1);
  const monStr = `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
  const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const d7ago = new Date(now); d7ago.setDate(now.getDate() - 6);
  const d7str = `${d7ago.getFullYear()}-${String(d7ago.getMonth()+1).padStart(2,'0')}-${String(d7ago.getDate()).padStart(2,'0')}`;

  // ── 멤버별 집계 ──
  function aggregate(nick) {
    const rows = usage.filter(u => u.nickname === nick);
    let todayScore = 0, weekScore = 0, monthScore = 0, activeDays7 = 0, bestDay = 0, totalScore = 0;
    const days7set = new Set();
    rows.forEach(u => {
      const d = normalizeDate(u.date);
      const sc = getScore(u);
      totalScore += sc;
      if (sc > bestDay) bestDay = sc;
      if (d === today) todayScore = sc;
      if (d >= monStr && d <= today) weekScore += sc;
      if (d.startsWith(curMonth)) monthScore += sc;
      if (d >= d7str && d <= today && sc > 0) days7set.add(d);
    });
    activeDays7 = days7set.size;
    return { todayScore, weekScore, monthScore, activeDays7, bestDay, totalScore };
  }

  const me = aggregate(myNick);
  const peer = aggregate(peerNick);

  // ── 지표 정의 ──
  const metrics = [
    { label: '오늘 사용량', myVal: me.todayScore, peerVal: peer.todayScore, fmt: formatTokens },
    { label: '이번 주 사용량', myVal: me.weekScore, peerVal: peer.weekScore, fmt: formatTokens },
    { label: '이번 달 사용량', myVal: me.monthScore, peerVal: peer.monthScore, fmt: formatTokens },
    { label: '최근 7일 활동일수', myVal: me.activeDays7, peerVal: peer.activeDays7, fmt: v => v + '일' },
    { label: '최고 일간 기록', myVal: me.bestDay, peerVal: peer.bestDay, fmt: formatTokens },
  ];

  // ── 승패 요약 ──
  let wins = 0, losses = 0;
  metrics.forEach(m => { if (m.myVal > m.peerVal) wins++; else if (m.myVal < m.peerVal) losses++; });

  let html = '';

  // 요약 배너
  const summaryClass = wins > losses ? 'peer-summary-win' : wins < losses ? 'peer-summary-lose' : 'peer-summary-draw';
  const summaryText = wins > losses ? `${wins}:${losses} 앞서고 있어요! 💪` : wins < losses ? `${losses}:${wins} 뒤처지고 있어요... 🔥` : `${wins}:${losses} 동률입니다`;
  html += `<div class="peer-summary ${summaryClass}">`;
  html += `<span class="peer-summary-label">나 vs ${escapeHtml(peerNick)}</span>`;
  html += `<span class="peer-summary-score">${summaryText}</span>`;
  html += `</div>`;

  // 지표 카드들
  html += '<div class="peer-metrics">';
  metrics.forEach(m => {
    const max = Math.max(m.myVal, m.peerVal, 1);
    const myPct = (m.myVal / max) * 100;
    const peerPct = (m.peerVal / max) * 100;
    const isWin = m.myVal > m.peerVal;
    const isLose = m.myVal < m.peerVal;
    const statusIcon = isWin ? '🟢' : isLose ? '🔴' : '⚪';

    html += `<div class="peer-metric-card">`;
    html += `<div class="peer-metric-label">${statusIcon} ${m.label}</div>`;
    html += `<div class="peer-metric-bars">`;
    // 내 바
    html += `<div class="peer-bar-row">`;
    html += `<span class="peer-bar-nick">나</span>`;
    html += `<div class="peer-bar-track"><div class="peer-bar-fill peer-bar-me${isWin ? ' peer-bar-winner' : ''}" style="width:${Math.max(myPct, 3)}%"></div></div>`;
    html += `<span class="peer-bar-val${isWin ? ' peer-val-win' : ''}">${m.fmt(m.myVal)}</span>`;
    html += `</div>`;
    // 상대 바
    html += `<div class="peer-bar-row">`;
    html += `<span class="peer-bar-nick">${escapeHtml(peerNick)}</span>`;
    html += `<div class="peer-bar-track"><div class="peer-bar-fill peer-bar-opponent${isLose ? ' peer-bar-winner' : ''}" style="width:${Math.max(peerPct, 3)}%"></div></div>`;
    html += `<span class="peer-bar-val${isLose ? ' peer-val-lose' : ''}">${m.fmt(m.peerVal)}</span>`;
    html += `</div>`;
    html += `</div>`;
    html += `</div>`;
  });
  html += '</div>';

  // ── 시간대별 비교 차트 ──
  const peerHourly = dashboardData.memberHourly ? dashboardData.memberHourly[peerNick] : (dashboardData.topUser && dashboardData.topUser.nickname === peerNick ? dashboardData.topUser.hourly : null);
  let myHourly = null;
  if (raw && raw.length > 0) {
    const sorted = [...raw].sort((a, b) => {
      const ad = normalizeDate(a.date), bd = normalizeDate(b.date);
      if (ad !== bd) return bd.localeCompare(ad);
      return (b.reportedAt || '').localeCompare(a.reportedAt || '');
    });
    for (const r of sorted) {
      if (r.hourly && Array.isArray(r.hourly) && r.hourly.length > 0) { myHourly = r.hourly; break; }
    }
  }

  function toBuckets(hourly) {
    const arr = new Array(24).fill(0);
    if (!hourly) return arr;
    hourly.forEach(item => {
      const h = item.h;
      if (h >= 0 && h < 24) arr[h] += ((item.in||0)*1)+((item.out||0)*5)+((item.cc||0)*1.25)+((item.cr||0)*0.1);
    });
    return arr;
  }

  if (peerHourly || myHourly) {
    const pBuckets = toBuckets(peerHourly);
    const mBuckets = toBuckets(myHourly);
    const bMax = Math.max(...pBuckets, ...mBuckets, 1);
    const barBreaks = [10000, 50000, 100000, 500000, 1000000, 5000000, 10000000];
    const niceMax = barBreaks.find(b => b >= bMax) || bMax;

    html += '<div class="peer-metric-card" style="margin-top:4px;">';
    html += '<div class="peer-metric-label">⏰ 시간대별 비교 (최근 보고)</div>';
    html += '<div class="bar-chart compare-chart">';
    for (let h = 0; h < 24; h++) {
      const p = pBuckets[h], m = mBuckets[h];
      const pH = p > 0 ? Math.max(Math.min((p/niceMax)*100,100), 4) : 0;
      const mH = m > 0 ? Math.max(Math.min((m/niceMax)*100,100), 4) : 0;
      html += `<div class="bar-col bar-col-compare" title="${h}시 — ${peerNick}: ${formatTokens(p)} / 나: ${formatTokens(m)}">`;
      html += `<div class="bar-pair">`;
      html += `<div class="bar-stack bar-compare-top" style="height:${pH}%"></div>`;
      html += `<div class="bar-stack bar-compare-me" style="height:${mH}%"></div>`;
      html += `</div>`;
      html += `<div class="bar-label">${h}</div>`;
      html += `</div>`;
    }
    html += '</div>';
    html += '<div style="display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap;margin-top:6px;font-size:0.65rem;color:var(--text-muted);">';
    html += `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(234,179,8,0.7);vertical-align:middle;margin-right:3px;"></span>${escapeHtml(peerNick)}</span>`;
    html += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(129,140,248,0.7);vertical-align:middle;margin-right:3px;"></span>나</span>';
    html += '</div>';
    html += '</div>';
  } else {
    html += '<div class="peer-metric-card" style="margin-top:4px;">';
    html += '<div class="peer-metric-label">⏰ 시간대별 비교</div>';
    html += '<div class="stats-info-msg">시간대별 데이터는 자동 리포팅 업데이트 후 수집됩니다.</div>';
    html += '</div>';
  }

  area.innerHTML = html;
}

// ── 포인트 이력 ──
