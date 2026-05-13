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
  if (params.password != null) params.password = String(params.password);
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
  if (tabName === 'fine') renderFineTab();
  if (tabName === 'admin') renderAdminTab();
  if (tabName === 'eval') renderEval();
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

// ── v2 가중치 (Claude + Codex 통합) ──
// Claude Sonnet 기준 단가 $3/1M = weight 1.0
// Codex (GPT-5.4): I=$2.50, O=$15, Cr=$0.25 per 1M
const W_CL_IN = 1.0, W_CL_OUT = 5.0, W_CL_CW = 1.25, W_CL_CR = 0.1;
const W_CX_IN = 0.8333, W_CX_OUT = 5.0, W_CX_CR = 0.0833;

// 가중치 스코어 (v2: 7필드 Claude+Codex, 구 필드 fallback)
function getScore(d) {
  const clIn  = d.claude_input_tokens != null ? d.claude_input_tokens : (d.input_tokens || 0);
  const clOut = d.claude_output_tokens != null ? d.claude_output_tokens : (d.output_tokens || 0);
  const clCw  = d.claude_cache_creation_tokens != null ? d.claude_cache_creation_tokens : (d.cache_creation_tokens || 0);
  const clCr  = d.claude_cache_read_tokens != null ? d.claude_cache_read_tokens : (d.cache_read_tokens || 0);
  const cxIn  = d.codex_input_tokens || 0;
  const cxOut = d.codex_output_tokens || 0;
  const cxCr  = d.codex_cache_read_tokens || 0;

  if (clIn > 0 || clOut > 0 || cxIn > 0 || cxOut > 0) {
    return Math.round(
      clIn * W_CL_IN + clOut * W_CL_OUT + clCw * W_CL_CW + clCr * W_CL_CR +
      cxIn * W_CX_IN + cxOut * W_CX_OUT + cxCr * W_CX_CR
    );
  }
  if (d.score && typeof d.score === 'number' && d.score < 10000000000) {
    return d.score;
  }
  return 0;
}

// 레코드를 v2 7필드로 정규화 (Codex 누락 = 0)
function normalizeRecord(d) {
  if (!d) return d;
  return Object.assign({}, d, {
    claude_input_tokens: d.claude_input_tokens != null ? d.claude_input_tokens : (d.input_tokens || 0),
    claude_output_tokens: d.claude_output_tokens != null ? d.claude_output_tokens : (d.output_tokens || 0),
    claude_cache_creation_tokens: d.claude_cache_creation_tokens != null ? d.claude_cache_creation_tokens : (d.cache_creation_tokens || 0),
    claude_cache_read_tokens: d.claude_cache_read_tokens != null ? d.claude_cache_read_tokens : (d.cache_read_tokens || 0),
    codex_input_tokens: d.codex_input_tokens || 0,
    codex_output_tokens: d.codex_output_tokens || 0,
    codex_cache_read_tokens: d.codex_cache_read_tokens || 0
  });
}

// hourly bucket의 통합 가중 스코어 (v2/v1 포맷 모두 처리)
function getBucketScore(b) {
  if (!b) return 0;
  const cl = b.cl || { in: b.in || 0, out: b.out || 0, cc: b.cc || 0, cr: b.cr || 0 };
  const cx = b.cx || { in: 0, out: 0, cr: 0 };
  return Math.round(
    (cl.in || 0) * W_CL_IN + (cl.out || 0) * W_CL_OUT + (cl.cc || 0) * W_CL_CW + (cl.cr || 0) * W_CL_CR +
    (cx.in || 0) * W_CX_IN + (cx.out || 0) * W_CX_OUT + (cx.cr || 0) * W_CX_CR
  );
}

// hourly bucket을 v2 형식으로 정규화
function normalizeBucket(b) {
  if (!b) return b;
  if (b.cl) return b;
  return {
    h: b.h,
    cl: { in: b.in || 0, out: b.out || 0, cc: b.cc || 0, cr: b.cr || 0 },
    cx: { in: 0, out: 0, cr: 0 }
  };
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

  // submissions에서 날짜별 인증 여부 (league는 보고 시점 리그)
  // dateStr은 사용량 '해당 일자'(resetsAt) 우선. 없으면 submittedAt fallback.
  // 48h 윈도우로 4/24 사용량을 4/26에 보고하는 경우 league가 잘못된 셀에 매핑되는 문제 방지.
  submissions.forEach(s => {
    if (s.type === 'session') {
      const dateStr = normalizeDate(s.resetsAt || s.submittedAt);
      if (dateStr && dailyMap[s.nickname]) {
        if (!dailyMap[s.nickname][dateStr]) dailyMap[s.nickname][dateStr] = { done: true, tokens: 0, allTokens: 0, source: s.source, league: '' };
        dailyMap[s.nickname][dateStr].done = true;
        if (s.source === 'auto' && s.tokens) dailyMap[s.nickname][dateStr].tokens = s.tokens;
        if (s.league) dailyMap[s.nickname][dateStr].league = s.league;
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
        if (!dailyMap[u.nickname][uDate]) dailyMap[u.nickname][uDate] = { done: false, tokens: 0, allTokens: 0, source: '', league: '' };
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
    // 직전 2시간 내 500K+ 가중 스코어를 보고한 멤버에게 🔥 표시
    if (dashboardData && dashboardData.memberLastActivity) {
      const act = dashboardData.memberLastActivity[m.nickname];
      if (act && act.score >= 500000 && act.reportedAt &&
          (Date.now() - new Date(act.reportedAt).getTime()) <= 7200000) {
        const fire = document.createElement('span');
        fire.className = 'fire-badge';
        fire.textContent = '🔥';
        fire.title = `직전 2시간 내 ${(act.score / 1000).toFixed(0)}K (가중)`;
        nameTd.appendChild(fire);
      }
    }
    tr.appendChild(nameTd);

    // 멤버의 현재 리그 (fallback 용, 실제로는 각 셀의 보고 시점 리그 우선)
    const currLeague = (m.league === LEAGUE_10M || m.league === LEAGUE_1M) ? m.league : LEAGUE_1M;
    days.forEach(d => {
      const td = document.createElement('td');
      const info = dailyMap[m.nickname][d.date];
      const tokens = info ? info.tokens : 0;
      // 보고 시점 리그 우선 (없으면 현재 리그로 fallback)
      const recordedLeague = (info && info.league === LEAGUE_10M) ? LEAGUE_10M :
                             (info && info.league === LEAGUE_1M) ? LEAGUE_1M :
                             currLeague;
      // 날짜+리그에 맞는 임계값 (legacy 기간엔 1M/10M/50M)
      const t = getThresholdsFor(d.date, recordedLeague);
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
        td.title = `가중 스코어: ${tokens.toLocaleString()} (${recordedLeague} 리그 기준)`;
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

  // 평가 랭킹 (대시보드 상단) — 백엔드 응답에서 받은 데이터로 즉시 렌더
  // 프리뷰는 데모 데이터로 fallback
  if (EVAL_IS_PREVIEW && typeof computeDemoRankings === 'function') {
    renderEvalRankings(computeDemoRankings(EVAL_DEMO_FEED));
  } else if (dashboardData.evalRankings) {
    renderEvalRankings(dashboardData.evalRankings);
  }

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
  const activeView = document.querySelector('.rank-toggle-btn.active')?.dataset.rank || 'dailyTokens';
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
  // 토큰 산정 방식 안내 푸터 - 내 리그 표시 + 표에서 내 리그 행 하이라이트
  const sptText = document.getElementById('score-points-text');
  if (sptText) {
    sptText.innerHTML = `* 하루 최대 3pt. 내 리그: <strong>${myLeague}</strong>`;
  }
  const sptTable = document.querySelector('.score-points-table');
  if (sptTable) {
    sptTable.querySelectorAll('tr').forEach((tr, idx) => {
      tr.classList.remove('score-my-league');
      if (idx === 0) return; // header
      const badge = tr.querySelector('.my-league-badge');
      if (!badge) return;
      const rowLeague = badge.textContent.trim();
      if (rowLeague === myLeague) tr.classList.add('score-my-league');
    });
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

// ── 벌금 탭 ──
let fineWeekOffset = 0;
// 벌금 기록 조회 가능한 최소 주차의 월요일 (2026 4월 4주차 = 2026-04-20).
// 그 이전 주차는 챌린지 시작 전 / 사전 운영 데이터라 노출하지 않음.
const FINE_MIN_MONDAY = new Date(2026, 3, 20);  // month=3 → April
const FINE_DEPOSIT = 50000;
const FINE_PER_DAY = 10000;
const FINE_FREE_DAYS = 2;

// 참여 상태 판정: 시트 F열 원본값 → 4가지 상태 중 하나
//   'active'   : '참여 중' (정상 벌금 계산)
//   'exempt'   : '주간 면제' (모든 미달이 '면제'로 표시, 벌금 0)
//   'inactive' : '참여 안 함' (회색 처리, 벌금 집계 제외)
//   'unknown'  : 그 외 임의 값 → inactive와 동일하게 회색 처리
function getFineState(raw) {
  const s = String(raw || '').trim();
  if (s === '' || s === '참여 중') return 'active';
  if (s === '주간 면제') return 'exempt';
  if (s === '참여 안 함') return 'inactive';
  return 'unknown';
}

// ISO 주차 계산 (Mon=1 ~ Sun=7 기준).
function fineIsoWeekFromDate(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

function renderFineTab() {
  if (!dashboardData) return;
  // 주 시작(월요일) 계산 (dailyWeekOffset과 독립)
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  let monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1 + fineWeekOffset * 7);

  // 최소 주차 클램프: 2026-04-20 (4월 4주차) 이전은 노출 금지
  if (monday < FINE_MIN_MONDAY) {
    // offset을 FINE_MIN_MONDAY에 맞게 보정
    const todayMonday = new Date(now);
    todayMonday.setDate(now.getDate() - dayOfWeek + 1);
    fineWeekOffset = Math.round((FINE_MIN_MONDAY - todayMonday) / (7 * 24 * 3600 * 1000));
    monday = new Date(FINE_MIN_MONDAY);
  }

  // 이전 버튼 활성/비활성 (이미 최소 주차면 더 이상 못 감)
  // monday는 현재 시각의 시·분·초를 가지므로 날짜만 비교.
  const prevBtn = document.getElementById('btn-fine-prev');
  if (prevBtn) {
    const mondayDateOnly = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
    const isAtMin = (mondayDateOnly.getTime() <= FINE_MIN_MONDAY.getTime());
    prevBtn.disabled = isAtMin;
    prevBtn.classList.toggle('daily-nav-btn-disabled', isAtMin);
  }

  const today = getTodayStr();

  // 표시 중인 주차의 ISO week / year (정산 시트와 매칭용)
  const displayedIso = fineIsoWeekFromDate(monday);
  const currentIso = fineIsoWeekFromDate(new Date());
  // 과거 주차 여부 (정산이 적용된 주차)
  const isPastWeek = (displayedIso.year < currentIso.year) ||
                     (displayedIso.year === currentIso.year && displayedIso.week < currentIso.week);

  // 정산 시트의 (nickname, week, year) 매칭용 인덱스
  const settlements = dashboardData.settlements || [];
  const settlementByKey = {};
  settlements.forEach(s => {
    settlementByKey[`${s.nickname}__${s.year}-W${s.week}`] = s;
  });
  const getSettlement = (nick) => settlementByKey[`${nick}__${displayedIso.year}-W${displayedIso.week}`];

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
  const weekInMonth = Math.ceil(thursday.getDate() / 7);
  document.getElementById('fine-week-label').textContent = `${thursday.getMonth() + 1}월 ${weekInMonth}주차`;

  // 멤버별 날짜별 토큰/리그 수집 (주간뷰 로직 재사용)
  const members = dashboardData.members || [];
  const submissions = dashboardData.submissions || [];
  const dailyMap = {};
  members.forEach(m => { dailyMap[m.nickname] = {}; });
  submissions.forEach(s => {
    if (s.type !== 'session') return;
    // 사용량 일자(resetsAt) 우선, 없으면 submittedAt fallback
    const dateStr = normalizeDate(s.resetsAt || s.submittedAt);
    if (!dateStr || !dailyMap[s.nickname]) return;
    if (!dailyMap[s.nickname][dateStr]) dailyMap[s.nickname][dateStr] = { tokens: 0, league: '' };
    if (s.source === 'auto' && s.tokens) dailyMap[s.nickname][dateStr].tokens = s.tokens;
    if (s.league) dailyMap[s.nickname][dateStr].league = s.league;
  });
  (dashboardData.usage || []).forEach(u => {
    if (!dailyMap[u.nickname]) return;
    const uDate = normalizeDate(u.date);
    if (!dailyMap[u.nickname][uDate]) dailyMap[u.nickname][uDate] = { tokens: 0, league: '' };
    dailyMap[u.nickname][uDate].tokens = getScore(u);
  });

  // 헤더
  const headerRow = document.getElementById('fine-header-row');
  headerRow.innerHTML = '<th>멤버</th><th class="fine-th-summary">참여</th>';
  days.forEach(d => {
    const th = document.createElement('th');
    th.textContent = `${d.month}/${d.dayNum}(${d.label})`;
    if (d.date === today) th.classList.add('fine-th-today');
    headerRow.appendChild(th);
  });
  const thMiss = document.createElement('th'); thMiss.textContent = '미달'; thMiss.className = 'fine-th-summary'; headerRow.appendChild(thMiss);
  const thFine = document.createElement('th'); thFine.textContent = '벌금'; thFine.className = 'fine-th-summary'; headerRow.appendChild(thFine);
  const thRem  = document.createElement('th'); thRem.textContent  = '잔여'; thRem.className  = 'fine-th-summary'; headerRow.appendChild(thRem);

  // 본문
  const tbody = document.getElementById('fine-body-row');
  tbody.innerHTML = '';
  let myAmount = 0, myRemaining = FINE_DEPOSIT;
  members.forEach(m => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.className = 'fine-td-name';
    const dot = document.createElement('span');
    dot.className = 'member-color-dot';
    dot.style.background = getMemberColor(m.nickname);
    nameTd.appendChild(dot);
    nameTd.appendChild(document.createTextNode(' ' + m.nickname));
    tr.appendChild(nameTd);

    // 과거 주차에 대해서는 정산 시트의 freeze된 status를 우선 사용 (소급 변경 차단).
    const settlement = getSettlement(m.nickname);
    const statusForWeek = (isPastWeek && settlement) ? settlement.status : m.participating;
    const state = getFineState(statusForWeek);

    const partTd = document.createElement('td');
    partTd.className = 'fine-td-summary fine-td-participating';
    if (state === 'active') {
      partTd.textContent = '참여 중';
    } else if (state === 'exempt') {
      partTd.textContent = '주간 면제';
      partTd.classList.add('fine-td-exempt');
    } else {
      // inactive 또는 unknown (임의 값도 회색 처리)
      partTd.textContent = state === 'inactive' ? '참여 안 함' : (statusForWeek || '참여 안 함');
      partTd.classList.add('fine-td-not-participating');
    }
    tr.appendChild(partTd);

    const currLeague = (m.league === LEAGUE_10M || m.league === LEAGUE_1M) ? m.league : LEAGUE_1M;
    let missCount = 0;

    days.forEach(d => {
      const td = document.createElement('td');
      td.className = 'fine-cell';
      const info = dailyMap[m.nickname][d.date];
      const tokens = info ? info.tokens : 0;
      const recordedLeague = (info && (info.league === LEAGUE_10M || info.league === LEAGUE_1M)) ? info.league : currLeague;
      const t = getThresholdsFor(d.date, recordedLeague);

      if (state === 'inactive' || state === 'unknown') {
        td.textContent = '-';
        td.classList.add('fine-cell-pending');
      } else if (d.date > today) {
        td.textContent = '-';
        td.classList.add('fine-cell-pending');
      } else if (tokens >= t[0]) {
        td.textContent = 'O';
        td.classList.add('fine-cell-ok');
      } else {
        missCount += 1;
        if (state === 'exempt') {
          // 주간 면제: 모든 미달이 '면제'
          td.textContent = '면제';
          td.classList.add('fine-cell-exempt');
        } else if (missCount <= FINE_FREE_DAYS) {
          td.textContent = '면제';
          td.classList.add('fine-cell-exempt');
        } else {
          td.textContent = 'X';
          td.classList.add('fine-cell-fine');
        }
      }
      tr.appendChild(td);
    });

    // 과거 주차 + 정산 row 존재 시: 정산 시트의 freeze된 값 사용 (소급 변경 차단)
    // 그 외: 실시간 계산
    let fineAmount, chargedDays, remaining;
    if (isPastWeek && settlement) {
      fineAmount = settlement.fineAmount;
      chargedDays = settlement.chargedDays;
      missCount = settlement.missCount;
      remaining = settlement.depositAfter;
    } else {
      chargedDays = (state === 'active') ? Math.max(0, missCount - FINE_FREE_DAYS) : 0;
      fineAmount = chargedDays * FINE_PER_DAY;
      // 시트 deposit 값은 "이번 주 시작 보증금"으로 해석 → 여기서 벌금 차감
      const baseDeposit = (typeof m.deposit === 'number') ? m.deposit : FINE_DEPOSIT;
      remaining = Math.max(0, baseDeposit - fineAmount);
    }

    const tdMiss = document.createElement('td');
    tdMiss.textContent = (state === 'inactive' || state === 'unknown') ? '-' : `${missCount}일`;
    tdMiss.className = 'fine-td-summary';
    tr.appendChild(tdMiss);

    const tdFine = document.createElement('td');
    if (state === 'inactive' || state === 'unknown') {
      tdFine.textContent = '-';
      tdFine.className = 'fine-td-summary';
    } else {
      tdFine.textContent = fineAmount > 0 ? `-${fineAmount.toLocaleString()}원` : '0원';
      tdFine.className = 'fine-td-summary ' + (fineAmount > 0 ? 'fine-td-fine' : 'fine-td-clean');
    }
    tr.appendChild(tdFine);

    const tdRem = document.createElement('td');
    tdRem.textContent = `${remaining.toLocaleString()}원`;
    tdRem.className = 'fine-td-summary fine-td-remaining';
    tr.appendChild(tdRem);

    if (state === 'inactive' || state === 'unknown') tr.classList.add('fine-tr-inactive');
    if (state === 'exempt') tr.classList.add('fine-tr-exempt');
    if (currentUser && m.nickname === currentUser.nickname) {
      tr.classList.add('fine-tr-me');
      myAmount = (state === 'active') ? fineAmount : 0;
      myRemaining = remaining;
    }

    tbody.appendChild(tr);
  });

  document.getElementById('fine-my-amount').innerHTML = `${myAmount.toLocaleString()}<span class="fine-stat-unit">원</span>`;
  document.getElementById('fine-my-remaining').innerHTML = `${myRemaining.toLocaleString()}<span class="fine-stat-unit">원</span>`;
}

// 벌금 탭 주간 네비게이션
document.addEventListener('DOMContentLoaded', () => {
  const prev = document.getElementById('btn-fine-prev');
  const next = document.getElementById('btn-fine-next');
  if (prev) prev.addEventListener('click', () => {
    // 최소 주차 도달 시 클릭 무시 (renderFineTab에서 클램프되지만 이중 안전)
    const now = new Date();
    const dayOfWeek = now.getDay() || 7;
    const candidateMonday = new Date(now);
    candidateMonday.setDate(now.getDate() - dayOfWeek + 1 + (fineWeekOffset - 1) * 7);
    const candidateDateOnly = new Date(candidateMonday.getFullYear(), candidateMonday.getMonth(), candidateMonday.getDate());
    if (candidateDateOnly < FINE_MIN_MONDAY) return;
    fineWeekOffset--;
    renderFineTab();
  });
  if (next) next.addEventListener('click', () => { fineWeekOffset++; renderFineTab(); });
});

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
  // 뷰 드롭다운 이벤트 바인딩 (1회)
  const viewSel = document.getElementById('stats-hourly-view');
  if (viewSel && !viewSel.dataset.init) {
    viewSel.addEventListener('change', () => renderHourlyChart(raw, picker ? picker.value : getTodayStr()));
    viewSel.dataset.init = '1';
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

// ── 시간대별 차트 (v2: 6뷰 지원) ──
// 필드 고정 색상 (세련된 주황/파랑)
const HOURLY_COLORS = {
  cl_in:  '#F5A623', // Claude input — 앰버
  cl_out: '#D97706', // Claude output — 진한 오렌지
  cl_cw:  '#EAB308', // Claude cache write — 머스터드
  cl_cr:  '#FCD34D', // Claude cache read — 크림 옐로
  cx_in:  '#60A5FA', // Codex input — 스카이
  cx_out: '#2563EB', // Codex output — 딥 블루
  cx_cr:  '#BFDBFE'  // Codex cache read — 페일 블루
};
const HOURLY_LABELS = {
  cl_in: 'Input ×1',           cl_out: 'Output ×5',
  cl_cw: 'Cache write ×1.25',  cl_cr: 'Cache read ×0.1',
  cx_in: 'Input ×0.83',        cx_out: 'Output ×5',
  cx_cr: 'Cache read ×0.08'
};
const HOURLY_WEIGHTS = {
  cl_in: W_CL_IN, cl_out: W_CL_OUT, cl_cw: W_CL_CW, cl_cr: W_CL_CR,
  cx_in: W_CX_IN, cx_out: W_CX_OUT, cx_cr: W_CX_CR
};

// 뷰 모드 → 스택 순서 (아래→위 렌더 순서, 맨 앞이 바닥)
const HOURLY_VIEWS = {
  all:    ['cl_cr', 'cx_cr', 'cl_cw', 'cl_in', 'cx_in', 'cl_out', 'cx_out'],
  claude: ['cl_cr', 'cl_cw', 'cl_in', 'cl_out'],
  codex:  ['cx_cr', 'cx_in', 'cx_out'],
  input:  ['cl_in', 'cx_in'],
  output: ['cl_out', 'cx_out'],
  cache:  ['cl_cr', 'cx_cr', 'cl_cw']
};

function renderHourlyChart(raw, date) {
  const container = document.getElementById('stats-hourly-chart');

  const dayRecords = raw
    .filter(r => normalizeDate(r.date) === date)
    .sort((a, b) => (a.reportedAt || '').localeCompare(b.reportedAt || ''));

  if (dayRecords.length === 0) {
    container.innerHTML = '<div class="stats-placeholder">해당 날짜의 보고 데이터가 없습니다.</div>';
    return;
  }

  const latest = dayRecords[dayRecords.length - 1];
  const hasHourly = latest.hourly && Array.isArray(latest.hourly) && latest.hourly.length > 0;

  if (!hasHourly) {
    const total = getScore(latest);
    container.innerHTML =
      '<div class="stats-info-msg">' +
      '시간대별 데이터는 자동 리포팅 업데이트 후 수집됩니다.<br>' +
      '<span style="font-size:0.7rem;margin-top:6px;display:inline-block;">이 날짜 총 사용량: ' + formatTokens(total) + '</span>' +
      '</div>';
    return;
  }

  // 뷰 모드
  const viewSel = document.getElementById('stats-hourly-view');
  const view = (viewSel && viewSel.value) || 'all';
  const stackKeys = HOURLY_VIEWS[view] || HOURLY_VIEWS.all;

  // 시간대별 raw 토큰 집계 (v2 {cl, cx} 형식 / 구 {in, out, cc, cr} 모두 처리)
  const hourlyTokens = {};
  for (let h = 0; h < 24; h++) {
    hourlyTokens[h] = { cl_in: 0, cl_out: 0, cl_cw: 0, cl_cr: 0, cx_in: 0, cx_out: 0, cx_cr: 0 };
  }
  latest.hourly.forEach(raw_item => {
    const item = normalizeBucket(raw_item);
    const h = item.h;
    if (h >= 0 && h < 24) {
      const cl = item.cl || {};
      const cx = item.cx || {};
      hourlyTokens[h] = {
        cl_in:  cl.in  || 0, cl_out: cl.out || 0, cl_cw: cl.cc || 0, cl_cr: cl.cr || 0,
        cx_in:  cx.in  || 0, cx_out: cx.out || 0, cx_cr: cx.cr || 0
      };
    }
  });

  // 가중 적용한 뷰별 스코어
  const hourlyWeighted = {};
  for (let h = 0; h < 24; h++) {
    const t = hourlyTokens[h];
    const seg = {};
    let total = 0;
    for (const key of stackKeys) {
      const v = (t[key] || 0) * HOURLY_WEIGHTS[key];
      seg[key] = v; total += v;
    }
    hourlyWeighted[h] = { seg, total };
  }

  const max = Math.max(...Array.from({length: 24}, (_, h) => hourlyWeighted[h].total), 1);
  const barBreaks = [1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000];
  const niceMax = barBreaks.find(b => b >= max) || max;

  let html = '<div class="bar-chart">';
  for (let h = 0; h < 24; h++) {
    const { seg, total } = hourlyWeighted[h];
    const totalPct = Math.min((total / niceMax) * 100, 100);
    const barHeight = total > 0 ? Math.max(totalPct, 4) : 0;
    // tooltip: 뷰에 포함된 필드의 원시 토큰 요약
    const tipParts = stackKeys.map(k => {
      const raw = hourlyTokens[h][k] || 0;
      return raw > 0 ? `${HOURLY_LABELS[k].split(' ')[0]}:${formatTokens(raw)}` : null;
    }).filter(Boolean);
    const tip = `${h}시 · ${formatTokens(total)}` + (tipParts.length ? ` (${tipParts.join(' / ')})` : '');
    html += `<div class="bar-col" title="${tip}">`;
    if (total > 0) html += `<div class="bar-value">${formatTokens(total)}</div>`;
    html += `<div class="bar-stack" style="height:${barHeight}%">`;
    if (total > 0) {
      // stackKeys 순서대로 바닥부터 쌓기 (DOM 순서: 첫번째가 맨 아래)
      for (const key of stackKeys) {
        const v = seg[key];
        if (v > 0) {
          html += `<div class="bar-seg" style="height:${(v/total)*100}%;background:${HOURLY_COLORS[key]}"></div>`;
        }
      }
    }
    html += `</div>`;
    html += `<div class="bar-label">${h}</div>`;
    html += `</div>`;
  }
  html += '</div>';

  // Legend: Claude 행 / Codex 행 분리
  const claudeKeys = stackKeys.filter(k => k.startsWith('cl_'));
  const codexKeys  = stackKeys.filter(k => k.startsWith('cx_'));
  const renderLegendRow = (label, keys) => {
    if (keys.length === 0) return '';
    let row = `<div class="hourly-legend-row"><span class="hourly-legend-group">${label}</span>`;
    for (const key of keys) {
      row += `<span><span class="legend-swatch" style="background:${HOURLY_COLORS[key]}"></span>${HOURLY_LABELS[key]}</span>`;
    }
    row += '</div>';
    return row;
  };
  html += '<div class="hourly-legend">';
  html += renderLegendRow('Claude', claudeKeys);
  html += renderLegendRow('Codex',  codexKeys);
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
    r.hourly.forEach(raw => {
      const item = normalizeBucket(raw);
      if (item.h >= 0 && item.h < 24) {
        const cl = item.cl || {}, cx = item.cx || {};
        grid[dow][item.h] += ((cl.in||0)*W_CL_IN)+((cl.out||0)*W_CL_OUT)+((cl.cc||0)*W_CL_CW)+((cl.cr||0)*W_CL_CR)
                           + ((cx.in||0)*W_CX_IN)+((cx.out||0)*W_CX_OUT)+((cx.cr||0)*W_CX_CR);
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
    const isActive = act && act.score >= 500000 && act.reportedAt && (Date.now() - new Date(act.reportedAt).getTime()) <= 7200000;

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
    hourly.forEach(raw => {
      const item = normalizeBucket(raw);
      const h = item.h;
      if (h >= 0 && h < 24) {
        const cl = item.cl || {}, cx = item.cx || {};
        arr[h] += ((cl.in||0)*W_CL_IN)+((cl.out||0)*W_CL_OUT)+((cl.cc||0)*W_CL_CW)+((cl.cr||0)*W_CL_CR)
                + ((cx.in||0)*W_CX_IN)+((cx.out||0)*W_CX_OUT)+((cx.cr||0)*W_CX_CR);
      }
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

// ════════════════════════════════════════════════════════
// 평가 (VC IR 시뮬레이션) 탭 — 비차단 + 폴링
// ════════════════════════════════════════════════════════
//
// 상태 머신 (status):
//   idle → questions_pending → answering → evaluation_pending → completed
//
// UX 흐름:
//   1) 사용자가 IR 폼 제출 → 즉시 진행 패널 노출 ("질문 작성 중")
//      백엔드 fetch는 await하지 않고 fire-and-forget. 응답 받으면 UI 갱신.
//      이탈해도 OK — 다시 들어오면 evalStatus 폴링으로 현재 상태 회수.
//   2) 질문 도착 → "답변 대기 중" 상태로 표시. 답변 폼 노출.
//   3) 답변 제출 → "평가 중" 상태로 표시. fire-and-forget.
//   4) 평가 완료 → 결과 카드 노출.

const EVAL_FEED_PAGE_SIZE = 10;
let evalFeedOffset = 0;
let evalFeedHasMore = false;
let evalFeedItems = [];

// 프리뷰(localhost) 환경 감지 → 데모 피드 + 백엔드 미배포 시 우아한 동작
const EVAL_IS_PREVIEW = (typeof location !== 'undefined') &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

// 5,000원 ~ 3억원 범위에 맞춘 통일 한국어 포맷.
//   - 1만 미만: "5,000원" / "9,500원"
//   - 1만 이상 ~ 1억 미만: "N만원" (반올림, 8만원 / 25만원 / 80만원 / 250만원)
//   - 1억 이상: "N억 N,NNN만원" or "N억원"
function formatKRW(n) {
  n = Math.round(Number(n) || 0);
  if (n < 10000) return n.toLocaleString('ko-KR') + '원';
  if (n < 100000000) {
    const man = Math.round(n / 10000);
    return man.toLocaleString('ko-KR') + '만원';
  }
  const eok = Math.floor(n / 100000000);
  const remainMan = Math.round((n - eok * 100000000) / 10000);
  if (remainMan === 0) return eok + '억원';
  return eok + '억 ' + remainMan.toLocaleString('ko-KR') + '만원';
}

// 평균 표시용: 백원 단위 내림 (366,667 → 366,600).
function formatAvgKRW(n) {
  const floored = Math.floor((Number(n) || 0) / 100) * 100;
  return formatKRW(floored);
}

const EVAL_LS_KEY = 'evalInProgress';

function evalGetInProgress() {
  try { return JSON.parse(localStorage.getItem(EVAL_LS_KEY) || 'null'); } catch { return null; }
}
function evalSetInProgress(v) {
  if (v == null) localStorage.removeItem(EVAL_LS_KEY);
  else localStorage.setItem(EVAL_LS_KEY, JSON.stringify(v));
}

// 진행 패널이 어떤 상태로 노출되는지: questions_pending / answering / evaluation_pending / completed
function evalShowStep(name) {
  ['form', 'questions', 'result'].forEach(s => {
    const el = document.getElementById('eval-step-' + s);
    if (el) el.style.display = (s === name) ? '' : 'none';
  });
}

function renderEval() {
  if (!currentUser) return;
  bindEvalHandlersOnce();
  evalRenderFromState();
  // 피드 로딩
  evalFeedOffset = 0;
  evalFeedItems = [];
  loadEvalFeed(true);
}

// 현재 localStorage state에 따라 UI 분기. 호출될 때마다 idempotent.
function evalRenderFromState() {
  const ip = evalGetInProgress();
  const panel = document.getElementById('eval-progress-panel');
  if (!ip || !ip.evalId || ip.nickname !== currentUser.nickname) {
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    evalShowStep('form');
    evalStopPolling();
    return;
  }

  // 진행 패널 노출
  renderEvalProgressPanel(ip);

  // 본문 영역 분기
  if (ip.status === 'completed' && ip.result) {
    renderEvalResult(ip.result, ip.project);
    evalShowStep('result');
    evalStopPolling();
  } else if (ip.status === 'answering' && Array.isArray(ip.questions)) {
    renderEvalQuestions(ip.questions, ip.evalId, ip.answers || {});
    evalShowStep('questions');
    evalStopPolling();
  } else {
    // questions_pending 또는 evaluation_pending → 폼 숨기고 진행 패널만
    evalShowStep('form');
    document.getElementById('eval-step-form').style.display = 'none';
    evalStartPolling();
  }
}

function renderEvalProgressPanel(ip) {
  const panel = document.getElementById('eval-progress-panel');
  if (!panel) return;
  const proj = ip.project || {};
  let badge = '', actionBtn = '', subtitle = '', icon = '';
  switch (ip.status) {
    case 'questions_pending':
      badge = '<span class="eval-progress-badge eval-progress-waiting">VC가 질문 작성 중</span>';
      subtitle = '잠시 기다려주세요. 다른 탭으로 이동하셔도 결과는 보존됩니다.';
      icon = '⏳';
      break;
    case 'answering':
      badge = '<span class="eval-progress-badge eval-progress-ready">답변 대기 중</span>';
      actionBtn = '<button class="eval-btn-secondary" data-eval-action="continue-answer">이어서 답변하기</button>';
      icon = '✍️';
      break;
    case 'evaluation_pending':
      badge = '<span class="eval-progress-badge eval-progress-waiting">VC 패널이 평가 중</span>';
      subtitle = (() => {
        if (ip.revealAt) {
          const remainMs = ip.revealAt - Date.now();
          if (remainMs > 0) {
            const mins = Math.max(1, Math.ceil(remainMs / 60000));
            return `약 ${mins}분 후 결과가 공개됩니다. 다른 탭으로 이동하셔도 결과는 보존됩니다.`;
          }
        }
        return 'VC 패널이 검토 중입니다. 다른 탭으로 이동하셔도 결과는 보존됩니다.';
      })();
      icon = '⏳';
      break;
    case 'completed':
      badge = '<span class="eval-progress-badge eval-progress-done">평가 완료</span>';
      actionBtn = '<button class="eval-btn-secondary" data-eval-action="show-result">결과 보기</button>';
      icon = '✅';
      break;
    default:
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
  }
  const isWaiting = (ip.status === 'questions_pending' || ip.status === 'evaluation_pending');
  panel.style.display = '';
  panel.className = 'eval-progress-panel' + (isWaiting ? ' eval-progress-waiting-panel' : '');
  panel.innerHTML = `
    <div class="eval-progress-row">
      <div class="eval-progress-icon">${icon}</div>
      <div class="eval-progress-main">
        <div class="eval-progress-project">${escapeHtml(proj.projectName || '진행 중인 IR')}</div>
        <div class="eval-progress-status">${badge}</div>
        ${subtitle ? `<div class="eval-progress-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <div class="eval-progress-actions">
        ${actionBtn}
        <button class="eval-btn-link" data-eval-action="discard">폐기</button>
      </div>
    </div>
  `;
  // 패널 내부 버튼 핸들러 (위임)
  panel.querySelectorAll('[data-eval-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.evalAction;
      if (a === 'continue-answer') { evalShowStep('questions'); }
      else if (a === 'show-result') { evalShowStep('result'); }
      else if (a === 'discard') {
        if (!confirm('진행 중인 IR을 폐기합니다. (주 1회 제한엔 카운트되지 않습니다)')) return;
        const cur = evalGetInProgress();
        if (cur && cur.evalId) discardEvalOnServer(cur.evalId);
        evalSetInProgress(null);
        evalRenderFromState();
      }
    });
  });
}

// 진행 중인 IR을 백엔드에 'abandoned' 마킹하여 주간 카운트에서 제외시킴.
// 임시 evalId('temp-…')는 서버에 row가 없으니 호출 생략.
async function discardEvalOnServer(evalId) {
  if (!evalId || String(evalId).startsWith('temp-')) return;
  try {
    await apiCall('evalDiscard', {
      nickname: currentUser.nickname,
      password: currentUser.password,
      evalId: evalId
    });
  } catch (err) {
    console.warn('evalDiscard 호출 실패 (서버 row는 그대로 남음):', err);
  }
}

let evalHandlersBound = false;
function bindEvalHandlersOnce() {
  if (evalHandlersBound) return;
  evalHandlersBound = true;
  document.getElementById('eval-start-btn').addEventListener('click', submitEvalStep1);
  document.getElementById('eval-submit-btn').addEventListener('click', submitEvalStep2);
  document.getElementById('eval-restart-btn').addEventListener('click', () => {
    if (!confirm('진행 중인 IR을 폐기하고 처음부터 다시 시작합니다. (주 1회 제한엔 카운트되지 않습니다)')) return;
    const cur = evalGetInProgress();
    if (cur && cur.evalId) discardEvalOnServer(cur.evalId);
    evalSetInProgress(null);
    evalRenderFromState();
  });
  document.getElementById('eval-new-btn').addEventListener('click', () => {
    evalSetInProgress(null);
    ['eval-project-name', 'eval-one-liner', 'eval-description', 'eval-github-url', 'eval-demo-url'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const fileInput = document.getElementById('eval-file-input');
    if (fileInput) fileInput.value = '';
    document.getElementById('eval-file-info').style.display = 'none';
    evalRenderFromState();
  });
  document.getElementById('eval-feed-more').addEventListener('click', () => loadEvalFeed(false));
  document.getElementById('eval-file-input').addEventListener('change', onEvalFileChange);
  // Sub-tab nav
  document.querySelectorAll('.eval-subtab').forEach(btn => {
    btn.addEventListener('click', () => switchEvalSubtab(btn.dataset.evalSubtab));
  });
}

let currentEvalSubtab = 'submit';
function switchEvalSubtab(name) {
  currentEvalSubtab = name;
  document.querySelectorAll('.eval-subtab').forEach(b => b.classList.toggle('active', b.dataset.evalSubtab === name));
  document.querySelectorAll('.eval-subcontent').forEach(d => d.classList.toggle('active', d.dataset.evalSubcontent === name));
  if (name === 'feed') {
    // 피드 탭: 랭킹 + 컴팩트 카드
    loadEvalFeed(true);
  } else if (name === 'my') {
    renderEvalMyFeed();
  }
}

const EVAL_FILE_MAX_BYTES = 1.5 * 1024 * 1024; // 1.5MB

function onEvalFileChange() {
  const inp = document.getElementById('eval-file-input');
  const info = document.getElementById('eval-file-info');
  const f = inp.files && inp.files[0];
  if (!f) {
    info.style.display = 'none';
    info.textContent = '';
    return;
  }
  if (f.size > EVAL_FILE_MAX_BYTES) {
    info.style.display = '';
    info.className = 'eval-file-info eval-file-info-error';
    info.textContent = `파일이 너무 큽니다 (${Math.round(f.size/1024)}KB). 최대 1.5MB까지 첨부 가능합니다.`;
    inp.value = '';
    return;
  }
  info.style.display = '';
  info.className = 'eval-file-info';
  info.textContent = `${f.name} · ${Math.round(f.size/1024)}KB · ${f.type}`;
}

// File → base64 (data URL의 base64 부분만)
function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.substring(idx + 1) : '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function submitEvalStep1() {
  const errEl = document.getElementById('eval-form-error');
  errEl.style.display = 'none';
  const projectName = document.getElementById('eval-project-name').value.trim();
  const oneLiner    = document.getElementById('eval-one-liner').value.trim();
  const description = document.getElementById('eval-description').value.trim();
  const githubUrl   = document.getElementById('eval-github-url').value.trim();
  const demoUrl     = document.getElementById('eval-demo-url').value.trim();
  const fileInput   = document.getElementById('eval-file-input');
  const file        = fileInput && fileInput.files && fileInput.files[0];

  if (!projectName || !oneLiner || !description) {
    errEl.textContent = '프로젝트명, 한줄 설명, 상세 설명은 필수입니다.';
    errEl.style.display = '';
    return;
  }
  if (description.length < 30) {
    errEl.textContent = '상세 설명은 최소 30자 이상 작성해주세요.';
    errEl.style.display = '';
    return;
  }
  if (!githubUrl && !demoUrl && !file) {
    errEl.textContent = 'GitHub URL · 데모 URL · 파일 첨부 중 최소 한 가지는 제출해주세요.';
    errEl.style.display = '';
    return;
  }

  // 파일을 base64로 미리 읽기
  let fileBase64 = '', fileName = '', fileType = '';
  if (file) {
    if (file.size > EVAL_FILE_MAX_BYTES) {
      errEl.textContent = '파일이 너무 큽니다 (최대 1.5MB).';
      errEl.style.display = '';
      return;
    }
    try {
      fileBase64 = await readFileBase64(file);
      fileName = file.name;
      fileType = file.type || 'application/octet-stream';
    } catch (e) {
      errEl.textContent = '파일을 읽지 못했습니다.';
      errEl.style.display = '';
      return;
    }
  }

  // 임시 evalId (서버 응답 전까지). 서버 응답 받으면 진짜 evalId로 교체.
  const tempId = 'temp-' + Date.now();
  evalSetInProgress({
    evalId: tempId,
    nickname: currentUser.nickname,
    project: { projectName, oneLiner, description, githubUrl, demoUrl, hasFile: !!file },
    status: 'questions_pending',
    questions: null,
    answers: {},
    result: null,
    startedAt: Date.now()
  });
  evalRenderFromState();

  // fire-and-forget — await하지 않음. 응답 도착하면 핸들러가 처리.
  apiCall('evalStart', {
    nickname: currentUser.nickname,
    password: currentUser.password,
    projectName, oneLiner, description, githubUrl, demoUrl,
    fileBase64, fileName, fileType
  }).then(res => {
    const ip = evalGetInProgress();
    if (!ip || ip.evalId !== tempId) return; // 사용자가 폐기/다른 IR 시작 등
    if (!res || !res.success) {
      evalSetInProgress(null);
      errEl.textContent = (res && res.error) || '서버 오류';
      errEl.style.display = '';
      evalRenderFromState();
      return;
    }
    ip.evalId = res.evalId;
    ip.questions = res.questions;
    ip.status = 'answering';
    evalSetInProgress(ip);
    if (location.hash === '#eval' || isEvalTabActive()) evalRenderFromState();
  }).catch(err => {
    const ip = evalGetInProgress();
    if (!ip || ip.evalId !== tempId) return;
    // 네트워크 오류도 서버는 처리 중일 수 있으므로, evalId가 임시면 상태 유지 + 폴링
    // (만약 서버가 진짜 받지 못했으면 폴링이 답을 못 찾고, 사용자가 직접 폐기해야 함)
    console.warn('evalStart fetch error (서버는 처리 중일 수 있음):', err);
  });
}

function isEvalTabActive() {
  const t = document.getElementById('tab-eval');
  return t && t.classList.contains('active');
}

function renderEvalQuestions(questions, evalId, savedAnswers) {
  const list = document.getElementById('eval-questions-list');
  list.innerHTML = '';
  questions.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'eval-question-card eval-vc-' + (q.vc || '').replace(/\s+/g, '-').toLowerCase();
    const prev = savedAnswers && savedAnswers[idx] ? savedAnswers[idx] : '';
    card.innerHTML = `
      <div class="eval-q-header">
        <span class="eval-q-vc">${escapeHtml(q.vc)}</span>
        <span class="eval-q-num">Q${idx + 1}</span>
      </div>
      <div class="eval-q-text">${escapeHtml(q.question)}</div>
      <textarea class="eval-q-answer" data-idx="${idx}" maxlength="200" rows="3" placeholder="200자 이내">${escapeHtml(prev)}</textarea>
    `;
    list.appendChild(card);
  });
  // 답변 변경 시 localStorage에 자동 저장
  list.querySelectorAll('.eval-q-answer').forEach(t => {
    t.addEventListener('input', () => {
      const inProgress = evalGetInProgress();
      if (!inProgress) return;
      inProgress.answers = inProgress.answers || {};
      inProgress.answers[t.dataset.idx] = t.value;
      evalSetInProgress(inProgress);
    });
  });
}

async function submitEvalStep2() {
  const errEl = document.getElementById('eval-questions-error');
  errEl.style.display = 'none';

  const inProgress = evalGetInProgress();
  if (!inProgress || !inProgress.evalId || !Array.isArray(inProgress.questions)) {
    errEl.textContent = '진행 중인 IR이 없습니다. 다시 시작해주세요.';
    errEl.style.display = '';
    return;
  }
  const questions = inProgress.questions;
  const textareas = document.querySelectorAll('.eval-q-answer');
  const answers = [];
  for (let i = 0; i < questions.length; i++) {
    const ta = textareas[i];
    const v = (ta && ta.value || '').trim();
    if (!v) {
      errEl.textContent = `Q${i + 1} 답변이 비어있습니다.`;
      errEl.style.display = '';
      return;
    }
    answers.push({ vc: questions[i].vc, question: questions[i].question, answer: v });
  }

  // 즉시 status를 evaluation_pending으로 — UI는 진행 패널만 보여줌
  inProgress.status = 'evaluation_pending';
  inProgress.qa = answers;
  evalSetInProgress(inProgress);
  evalRenderFromState();

  // fire-and-forget — 응답이 와도 즉시 결과로 flip하지 않음.
  // 백엔드는 LLM 평가 후 5~10분 random reveal 지연을 두고 status를 'evaluation_pending'으로 유지.
  // 프론트는 폴링(evalStatus)이 status='completed'를 가져올 때까지 대기 화면 유지.
  apiCall('evalSubmit', {
    nickname: currentUser.nickname,
    password: currentUser.password,
    evalId: inProgress.evalId,
    answers
  }).then(res => {
    const ip = evalGetInProgress();
    if (!ip || ip.evalId !== inProgress.evalId) return;
    if (!res || !res.success) {
      // 실패 → answering으로 복구
      ip.status = 'answering';
      evalSetInProgress(ip);
      const e = document.getElementById('eval-questions-error');
      if (e) {
        e.textContent = (res && res.error) || '서버 오류';
        e.style.display = '';
      }
      evalRenderFromState();
      return;
    }
    // 성공 응답: revealAt 정보만 캐시. status는 'evaluation_pending' 유지.
    if (res.revealAt) ip.revealAt = res.revealAt;
    evalSetInProgress(ip);
    // 화면은 이미 evaluation_pending 패널 노출 중 — 폴링이 reveal 시점에 'completed'로 flip해줌
  }).catch(err => {
    console.warn('evalSubmit fetch error (서버는 처리 중일 수 있음):', err);
    // 폴링이 결과를 잡아줌
  });
}

function renderEvalResult(result, project) {
  const panel = document.getElementById('eval-result-panel');
  if (!panel) return;
  const evalsHtml = result.evaluations.map(ev => `
    <div class="vc-card vc-card-${(ev.vc || '').replace(/\s+/g, '-').toLowerCase()}">
      <div class="vc-card-name">${escapeHtml(ev.vc)}</div>
      <div class="vc-card-krw">${formatKRW(ev.krw)}</div>
      <div class="vc-card-note">${escapeHtml(ev.note || '')}</div>
    </div>
  `).join('');
  panel.innerHTML = `
    <div class="eval-result-project">
      <div class="eval-result-name">${escapeHtml(project ? project.projectName : '')}</div>
      <div class="eval-result-oneliner">${escapeHtml(project ? project.oneLiner : '')}</div>
    </div>
    <div class="eval-result-avg">
      <div class="eval-result-avg-label">VC 패널 평균 추정 가치</div>
      <div class="eval-result-avg-value">${formatAvgKRW(result.avgKrw)}</div>
    </div>
    <div class="vc-card-grid">${evalsHtml}</div>
    <div class="eval-result-summary">
      <div class="eval-result-summary-label">패널 종합</div>
      <div class="eval-result-summary-text">${escapeHtml(result.summary || '')}</div>
    </div>
  `;
}

// ── 폴링 ──
let evalPollTimer = null;
let evalPollAttempts = 0;
const EVAL_POLL_INTERVAL_MS = 5000;
const EVAL_POLL_MAX_ATTEMPTS = 60; // 5분

function evalStopPolling() {
  if (evalPollTimer) { clearInterval(evalPollTimer); evalPollTimer = null; }
  evalPollAttempts = 0;
}

function evalStartPolling() {
  if (evalPollTimer) return;
  evalPollAttempts = 0;
  evalPollTimer = setInterval(evalPollOnce, EVAL_POLL_INTERVAL_MS);
}

async function evalPollOnce() {
  evalPollAttempts++;
  if (evalPollAttempts > EVAL_POLL_MAX_ATTEMPTS) { evalStopPolling(); return; }

  const ip = evalGetInProgress();
  if (!ip || !ip.evalId) { evalStopPolling(); return; }
  // 임시 evalId면 아직 서버에 반영 안 됨 → 스킵
  if (String(ip.evalId).startsWith('temp-')) return;

  try {
    const res = await apiCall('evalStatus', {
      nickname: currentUser.nickname,
      password: currentUser.password,
      evalId: ip.evalId
    });
    if (!res || !res.success) return;
    let changed = false;
    if (res.status && res.status !== ip.status) {
      ip.status = res.status;
      changed = true;
    }
    if (res.questions && (!ip.questions || ip.questions.length !== res.questions.length)) {
      ip.questions = res.questions;
      changed = true;
    }
    if (res.result && !ip.result) {
      ip.result = res.result;
      changed = true;
    }
    if (res.revealAt && res.revealAt !== ip.revealAt) {
      ip.revealAt = res.revealAt;
      // revealAt만 변하고 status 변화 없을 때도 진행 패널 부제(분 카운트) 갱신
      if (!changed) changed = true;
    }
    if (changed) {
      evalSetInProgress(ip);
      if (isEvalTabActive()) evalRenderFromState();
      if (ip.status === 'completed') {
        evalStopPolling();
        // 피드 갱신
        evalFeedOffset = 0;
        evalFeedItems = [];
        loadEvalFeed(true);
      }
    }
  } catch (err) {
    // 무시 - 다음 폴링에서 재시도
  }
}

// ── 피드 (멤버 평가 피드 sub-tab) ──
async function loadEvalFeed(reset) {
  const listEl = document.getElementById('eval-feed-list');
  const moreBtn = document.getElementById('eval-feed-more');
  if (!listEl) return;
  if (reset) {
    evalFeedOffset = 0;
    evalFeedItems = [];
    listEl.innerHTML = '<div class="eval-feed-loading">피드를 불러오는 중...</div>';
  }

  // 프리뷰: 데모 데이터로 즉시 채움
  if (EVAL_IS_PREVIEW) {
    listEl.innerHTML = '';
    EVAL_DEMO_FEED.forEach(item => listEl.appendChild(renderEvalCompactFeedCard(item)));
    moreBtn.style.display = 'none';
    evalFeedItems = EVAL_DEMO_FEED.slice();
    renderEvalRankings(computeDemoRankings(EVAL_DEMO_FEED));
    return;
  }

  try {
    const res = await apiCall('evalFeed', {
      nickname: currentUser.nickname,
      password: currentUser.password,
      offset: evalFeedOffset,
      limit: EVAL_FEED_PAGE_SIZE
    });
    if (!res || !res.success) {
      listEl.innerHTML = '<div class="eval-feed-empty">피드를 불러오지 못했습니다.</div>';
      moreBtn.style.display = 'none';
      return;
    }
    if (reset) listEl.innerHTML = '';
    if (res.items.length === 0 && evalFeedItems.length === 0) {
      listEl.innerHTML = '<div class="eval-feed-empty">아직 평가된 프로젝트가 없습니다. 첫 평가의 주인공이 되어보세요.</div>';
      moreBtn.style.display = 'none';
      renderEvalRankings(res.rankings || {});
      return;
    }
    res.items.forEach(item => {
      evalFeedItems.push(item);
      listEl.appendChild(renderEvalCompactFeedCard(item));
    });
    evalFeedOffset += res.items.length;
    evalFeedHasMore = !!res.hasMore;
    moreBtn.style.display = evalFeedHasMore ? '' : 'none';
    if (res.rankings) renderEvalRankings(res.rankings);
  } catch (err) {
    listEl.innerHTML = '<div class="eval-feed-empty">네트워크 오류</div>';
    moreBtn.style.display = 'none';
  }
}

// 데모 데이터로 랭킹 계산 (백엔드와 동일한 로직).
function computeDemoRankings(items) {
  const now = new Date();
  const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  // ISO 주차 (frontend)
  function isoWeek(d) {
    const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = x.getUTCDay() || 7;
    x.setUTCDate(x.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
    return { week: Math.ceil((((x - yearStart) / 86400000) + 1) / 7), year: x.getUTCFullYear() };
  }
  const nowIso = isoWeek(now);
  const sums = { week: {}, month: {}, all: {} };
  items.forEach(it => {
    const krw = it.avgKrw || 0;
    const dt = new Date(it.completedAt);
    sums.all[it.nickname] = (sums.all[it.nickname] || 0) + krw;
    const mk = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
    if (mk === monthKey) sums.month[it.nickname] = (sums.month[it.nickname] || 0) + krw;
    const wk = isoWeek(dt);
    if (wk.week === nowIso.week && wk.year === nowIso.year) sums.week[it.nickname] = (sums.week[it.nickname] || 0) + krw;
  });
  function top(map) {
    let best = null;
    Object.keys(map).forEach(n => {
      if (!best || map[n] > best.krw) best = { nickname: n, krw: map[n] };
    });
    return best;
  }
  return { week: top(sums.week), month: top(sums.month), all: top(sums.all) };
}

function renderEvalRankings(rankings) {
  rankings = rankings || {};
  ['week', 'month', 'all'].forEach(p => {
    // 대시보드 + 평가 sub-tab 양쪽 패널을 모두 갱신
    const cards = document.querySelectorAll(`.eval-ranking-card[data-period="${p}"]`);
    cards.forEach(card => {
      const body = card.querySelector('.eval-ranking-body');
      if (!body) return;
      const r = rankings[p];
      if (r && r.nickname) {
        body.innerHTML = `<div class="eval-ranking-nick">${escapeHtml(r.nickname)}</div><div class="eval-ranking-krw">${formatAvgKRW(r.krw)}</div>`;
      } else {
        body.innerHTML = '<span class="eval-ranking-empty">기록 없음</span>';
      }
    });
  });
}

// 컴팩트 카드 (멤버 피드용): 닉네임·날짜·링크·VC 3 카드만. 제목/한줄/요약 없음.
// 멤버 평가 피드용 컴팩트 카드.
// 본인 외 다른 멤버의 GitHub/데모/파일 첨부 링크는 노출하지 않음 (소스 보호 + 사칭 방지).
// 내 평가 피드(renderEvalDetailFeedCard)에서는 본인 자료라 그대로 노출.
function renderEvalCompactFeedCard(item) {
  const card = document.createElement('div');
  card.className = 'feed-card feed-card-compact';
  const dateStr = (item.completedAt || '').slice(0, 10);
  const evalsHtml = (item.evaluations || []).map(ev => `
    <div class="vc-card-mini vc-card-${(ev.vc || '').replace(/\s+/g, '-').toLowerCase()}">
      <div class="vc-mini-name">${escapeHtml(ev.vc)}</div>
      <div class="vc-mini-krw">${formatKRW(ev.krw)}</div>
      <div class="vc-mini-note">${escapeHtml(ev.note || '')}</div>
    </div>
  `).join('');
  card.innerHTML = `
    <div class="feed-card-header">
      <span class="feed-card-nick">${escapeHtml(item.nickname)}</span>
      <span class="feed-card-date">${dateStr}</span>
    </div>
    <div class="vc-card-grid vc-card-grid-mini">${evalsHtml}</div>
    <div class="feed-card-avg-mini">평균 ${formatAvgKRW(item.avgKrw)}</div>
  `;
  return card;
}

// ── 내 평가 피드 sub-tab ──
function renderEvalMyFeed() {
  const listEl = document.getElementById('eval-my-list');
  if (!listEl) return;
  const items = EVAL_IS_PREVIEW
    ? EVAL_DEMO_FEED.filter(it => it.nickname === currentUser.nickname)
    : evalFeedItems.filter(it => it.nickname === currentUser.nickname);
  // 프리뷰에서 evalFeedItems가 비어있으면 자동 로드
  if (!EVAL_IS_PREVIEW && items.length === 0 && evalFeedItems.length === 0) {
    listEl.innerHTML = '<div class="eval-feed-loading">불러오는 중...</div>';
    loadEvalFeed(true).then(() => renderEvalMyFeed());
    return;
  }
  if (items.length === 0) {
    listEl.innerHTML = '<div class="eval-feed-empty">아직 제출한 IR이 없습니다. "IR 자료 제출" 탭에서 첫 평가를 받아보세요.</div>';
    return;
  }
  listEl.innerHTML = '';
  items.forEach(item => listEl.appendChild(renderEvalDetailFeedCard(item)));
}

// 상세 카드 (내 피드용): 제목·한줄설명·상세설명·VC 카드·평균·종합·링크.
function renderEvalDetailFeedCard(item) {
  const card = document.createElement('div');
  card.className = 'feed-card feed-card-detail';
  const dateStr = (item.completedAt || '').slice(0, 10);
  const githubLink = item.githubUrl ? `<a href="${escapeHtml(item.githubUrl)}" target="_blank" rel="noopener" class="feed-link">GitHub</a>` : '';
  const demoLink = item.demoUrl ? `<a href="${escapeHtml(item.demoUrl)}" target="_blank" rel="noopener" class="feed-link">데모</a>` : '';
  const fileTag = item.hasFile ? `<span class="feed-link feed-link-file">📎 첨부</span>` : '';
  const links = [githubLink, demoLink, fileTag].filter(Boolean).join(' · ');
  const evalsHtml = (item.evaluations || []).map(ev => `
    <div class="vc-card-mini vc-card-${(ev.vc || '').replace(/\s+/g, '-').toLowerCase()}">
      <div class="vc-mini-name">${escapeHtml(ev.vc)}</div>
      <div class="vc-mini-krw">${formatKRW(ev.krw)}</div>
      <div class="vc-mini-note">${escapeHtml(ev.note || '')}</div>
    </div>
  `).join('');
  card.innerHTML = `
    <div class="feed-card-header">
      <span class="feed-card-nick">${escapeHtml(item.nickname)} · 내 IR</span>
      <span class="feed-card-date">${dateStr}</span>
    </div>
    <div class="feed-card-project">${escapeHtml(item.projectName || '')}</div>
    <div class="feed-card-oneliner">${escapeHtml(item.oneLiner || '')}</div>
    ${item.description ? `<div class="feed-card-desc">${escapeHtml(item.description)}</div>` : ''}
    ${links ? `<div class="feed-card-links">${links}</div>` : ''}
    <div class="feed-card-avg">
      <span class="feed-card-avg-label">평균</span>
      <span class="feed-card-avg-value">${formatAvgKRW(item.avgKrw)}</span>
    </div>
    <div class="vc-card-grid vc-card-grid-mini">${evalsHtml}</div>
    ${item.summary ? `<div class="feed-card-summary"><span class="feed-card-summary-label">패널 종합</span> ${escapeHtml(item.summary)}</div>` : ''}
  `;
  return card;
}

// ── 프리뷰 데모 피드 (localhost 전용) ──
const EVAL_DEMO_FEED = [
  {
    evalId: 'demo-1',
    nickname: '민준',
    completedAt: '2026-04-20T13:42:00.000Z',  // 지난달 — 누적엔 잡히지만 월간/주간엔 X
    projectName: '일일 토큰 알림봇',
    oneLiner: '하루 토큰 사용 한도 90% 도달 시 슬랙으로 알림.',
    description: '개인 개발자 대상 SaaS. Anthropic API 사용량을 모니터링하고 한도 초과 위험을 감지하면 슬랙·이메일로 즉시 알림. 월 9,900원 구독 모델, 현재 베타 사용자 30명.',
    githubUrl: 'https://github.com/example/token-alert',
    demoUrl: 'https://token-alert.example.com',
    hasFile: false,
    evaluations: [
      { vc: 'VC Vault',  krw: 18000000, note: '월 구독 모델 명확. 30명 베타도 PMF 신호.' },
      { vc: 'VC Rocket', krw: 38000000, note: '개발자 커뮤니티 입소문 가능성 높음.' },
      { vc: 'VC Forge',  krw: 19000000, note: 'API hooking 구조는 클린. 차별점은 약함.' }
    ],
    avgKrw: 25000000,
    summary: '명확한 페인 포인트와 실제 유료 사용자가 있어 견조한 가치. 경쟁 진입은 시간 문제.'
  },
  {
    evalId: 'demo-2',
    nickname: '민준',
    completedAt: '2026-05-02T11:00:00.000Z',  // 이번달, 지난주
    projectName: 'Claude 챌린지 사이트',
    oneLiner: '친구들끼리 Claude Max 사용량을 경쟁하는 랭킹 사이트.',
    description: '5명 친구 그룹의 토큰 사용량을 매시간 자동 집계하고 일/주/월 단위로 시각화. 벌금 시스템과 IR 평가까지 포함된 내부용 동기부여 도구.',
    githubUrl: 'https://github.com/example/claude-challenge-site',
    demoUrl: 'https://minjunecode.github.io/claude-challenge-site',
    hasFile: false,
    evaluations: [
      { vc: 'VC Vault',  krw: 50000,    note: '내부 친목용. 유료 전환 가능성 거의 없음.' },
      { vc: 'VC Rocket', krw: 800000,   note: '챌린지 모티브는 흥미. 폐쇄적 친구 그룹 한계.' },
      { vc: 'VC Forge',  krw: 250000,   note: 'Apps Script + 정적 사이트 — 구현은 깔끔.' }
    ],
    avgKrw: 366667,
    summary: '친구 그룹 내부 동기 부여 도구로 잘 작동. 외부 시장 가치는 제한적.'
  },
  {
    evalId: 'demo-3',
    nickname: '서연',
    completedAt: '2026-05-07T22:15:00.000Z',  // 이번주
    projectName: 'AI 회의록 요약기',
    oneLiner: 'Zoom 녹음을 자동으로 요약·할일 추출하는 사내 도구.',
    description: 'Whisper로 트랜스크립트 추출 → Claude로 요약 + 액션 아이템 자동 생성. 사내 슬랙에 자동 게시. 50인 규모 회사 1곳에서 실제 운영 중이며 만족도 높음.',
    githubUrl: '',
    demoUrl: 'https://meet-summary.example.com',
    hasFile: true,
    evaluations: [
      { vc: 'VC Vault',  krw: 12000000, note: '명확한 페인 포인트. B2B 라이선스 가능성 있음.' },
      { vc: 'VC Rocket', krw: 25000000, note: '바이럴 잠재력. 팀 도입 후 입소문 강함.' },
      { vc: 'VC Forge',  krw: 5000000,  note: 'Whisper + Claude 조합 — 기술 차별화 약함.' }
    ],
    avgKrw: 14000000,
    summary: 'B2B 사내 도구로 명확한 가치. 기술 해자가 약해 카피캣 위험 있음.'
  },
  {
    evalId: 'demo-4',
    nickname: '지훈',
    completedAt: '2026-05-08T15:00:00.000Z',  // 이번주
    projectName: '코딩 학습 트래커',
    oneLiner: '매일 푼 LeetCode 문제 + 학습 시간을 자동 기록·분석.',
    description: 'GitHub commit과 LeetCode 활동을 크롤링하여 시간대별·언어별 패턴 시각화. 주간 리포트 PDF 자동 생성.',
    githubUrl: 'https://github.com/example/code-tracker',
    demoUrl: '',
    hasFile: false,
    evaluations: [
      { vc: 'VC Vault',  krw: 4000000, note: '월정액 5천원 정도면 수요 있음. 시장은 작음.' },
      { vc: 'VC Rocket', krw: 15000000, note: '게이미피케이션 추가하면 훅이 생김.' },
      { vc: 'VC Forge',  krw: 2500000, note: '크롤링 + 차트 — 기술적 난이도 낮음.' }
    ],
    avgKrw: 7166667,
    summary: '개발자 학습 보조 도구로 가능성. 차별화 포인트와 커뮤니티 효과가 관건.'
  },
  {
    evalId: 'demo-5',
    nickname: '도현',
    completedAt: '2026-05-09T09:30:00.000Z',  // 이번주 (오늘)
    projectName: '매일 영어 단어장',
    oneLiner: '매일 5개 단어를 카톡으로 보내주는 봇.',
    description: '카카오톡 챗봇 기반 영단어 학습. 사용자가 제출한 단어 + GPT가 추천한 동의어 5개를 매일 아침 발송. 무료 운영.',
    githubUrl: 'https://github.com/example/word-bot',
    demoUrl: '',
    hasFile: false,
    evaluations: [
      { vc: 'VC Vault',  krw: 8000,    note: '월정액 1만원 받기도 어려운 수준. 무료 대체재 너무 많음.' },
      { vc: 'VC Rocket', krw: 30000,   note: '카톡 채널 = 지속성 의문. 학습 데이터 없음.' },
      { vc: 'VC Forge',  krw: 5000,    note: '단순 cron + API 호출. 누구나 1시간이면 만듦.' }
    ],
    avgKrw: 14333,
    summary: '학습 동기는 좋지만 차별점·해자가 모두 부재. 토이 프로젝트 영역.'
  },
  {
    evalId: 'demo-mj-1',
    nickname: 'Mj',
    completedAt: '2026-05-09T08:00:00.000Z',  // 이번주
    projectName: '바이브 코딩 평가 사이트',
    oneLiner: '챌린지 멤버 결과물을 가상 VC가 IR 형식으로 평가.',
    description: '친구들끼리 만든 사이드 프로젝트의 경제 가치를 정량적으로 비교하기 위한 가상 VC 패널 평가 시스템. 챌린지 참여 멤버 5명을 대상으로 개발. 메인 토큰 챌린지 사이트의 평가 sub-tab으로 통합.',
    githubUrl: 'https://github.com/example/vc-eval',
    demoUrl: 'https://challenge.example.com',
    hasFile: false,
    evaluations: [
      { vc: 'VC Vault',  krw: 200000,  note: '내부 도구. 외부 매출 가능성 매우 낮음.' },
      { vc: 'VC Rocket', krw: 3000000, note: '아이디어는 흥미. 실제 시장 검증 안 됨.' },
      { vc: 'VC Forge',  krw: 800000,  note: 'LLM 프롬프트 엔지니어링 + 폴링 패턴 — 무난.' }
    ],
    avgKrw: 1333333,
    summary: '재미있는 메타 프로젝트. 친구 그룹 한정의 가치이며 외부 확장은 어려움.'
  }
];

// ── 포인트 이력 ──
