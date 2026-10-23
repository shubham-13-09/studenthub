if(!sessionStorage.getItem('token_student')){
  window.location.href = '../login_panel/login.html';
}

// ---- API helpers ----
const API_BASE = window.APP_CONFIG.API_BASE;   // set in ../shared/config.js

async function apiRequest(path, options = {}){
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + sessionStorage.getItem('token_student')
    }
  });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || res.status === 403){
    // token invalid/expired or not a student — send back to login
    sessionStorage.removeItem('token_student');
    window.location.href = '../login_panel/login.html';
    throw new Error(data.message || 'Unauthorized');
  }
  if(!res.ok){
    throw new Error(data.message || 'Request failed');
  }
  return data;
}

// ---- Live-update helpers ----
// stChanged: backend data pehle jaisa hi hai to UI dobara draw nahi hota (scroll position / open cards disturb nahi hote)
const stCache = {};
function stChanged(key, data){
  const snap = JSON.stringify(data);
  if(stCache[key] === snap) return false;
  stCache[key] = snap;
  return true;
}
// stScrollDown: container ko bilkul neeche tak scroll karta hai (layout settle hone ke baad bhi dobara)
function stScrollDown(id){
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if(!el) return;
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

// ---- Navigation ----
  document.querySelectorAll('.nav-item').forEach(item=>{
    item.addEventListener('click', ()=>{
      switchView(item.dataset.view);
      if(window.innerWidth <= 860) closeSidebar();
    });
  });
  function switchView(name){
    document.querySelectorAll('.nav-item').forEach(i=> i.classList.toggle('active', i.dataset.view===name));
    document.querySelectorAll('.view').forEach(v=> v.classList.toggle('active', v.id==='view-'+name));
    if(name === 'chat'){ loadChatHistory(); stScrollDown('chatLog'); chatUnreadCounts.chatLog = 0; updateScrollBottomBtn('chatLog'); }
    if(name === 'timetable' || name === 'dashboard') refreshStudentTimetable();
    if(name === 'notes') loadStudentNotes();
    if(name === 'assignments') loadStudentAssignments();
    if(name === 'fees') loadStudentFees();
    if(name === 'attendance') loadStudentAttendance();
    if(name === 'results') loadStudentResults();
    if(name === 'notices'){ markStudentNoticesSeen(); stScrollDown('allNoticesContainer'); noticesUnseenNewCount = 0; updateNoticesScrollBtn(); }
    if(name === 'faculty') loadStudentFaculty();
  }

  // ---- Mobile sidebar drawer ----
  function openSidebar(){
    document.querySelector('.sidebar').classList.add('open');
    document.getElementById('overlay').classList.add('open');
  }
  function closeSidebar(){
    document.querySelector('.sidebar').classList.remove('open');
    document.getElementById('overlay').classList.remove('open');
  }

  // ---- Dark mode ----
  function toggleDark(){
    document.body.classList.toggle('dark');
    const isDark = document.body.classList.contains('dark');
    document.getElementById('darkBtn').textContent = isDark ? '☀' : '🌙';
    const t = document.getElementById('settingsDarkToggle');
    if(t) t.checked = isDark;
  }

  // ---- Floating chat popup ----
  function togglePopup(){
    const popup = document.getElementById('popup');
    popup.classList.toggle('hidden');
    if(!popup.classList.contains('hidden')){
      loadChatHistory();
      stScrollDown('popupLog');
      chatUnreadCounts.popupLog = 0;
      updateScrollBottomBtn('popupLog');
    }
  }

  // ---- Chat send (backend-connected — /student/assistant) ----
  // WhatsApp-style scroll: a message you sent always shows at the bottom,
  // but if the user has scrolled up to read older messages, a new/incoming
  // bot reply doesn't disturb them — only the jump-to-bottom arrow shows an
  // unread count badge, which they can click to reach the new messages
  const scrollBtnMap = {
    chatLog: { btn: 'chatScrollBtn', badge: 'chatScrollBadge' },
    popupLog: { btn: 'popupScrollBtn', badge: 'popupScrollBadge' }
  };
  const chatUnreadCounts = { chatLog: 0, popupLog: 0 };

  function isNearBottom(log, threshold = 48){
    return log.scrollHeight - log.scrollTop - log.clientHeight <= threshold;
  }

  function updateScrollBottomBtn(logId){
    const map = scrollBtnMap[logId];
    const log = document.getElementById(logId);
    if(!map || !log) return;
    const btn = document.getElementById(map.btn);
    const badge = document.getElementById(map.badge);
    if(!btn) return;
    const atBottom = isNearBottom(log);
    btn.classList.toggle('hidden', atBottom);
    const unread = chatUnreadCounts[logId] || 0;
    if(badge){
      if(!atBottom && unread > 0){
        badge.textContent = unread > 9 ? '9+' : String(unread);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  }

  // A new message (the user's own or the bot's) arrived — if the user is already near the bottom,
  // scroll straight down, otherwise only increase the unread count (don't jump)
  // wasNear: message add/resize hone se PEHLE ki position (reply lamba ho to baad mein check karna galat hota hai)
  function handleNewChatMessage(logId, wasNear){
    const log = document.getElementById(logId);
    if(!log) return;
    const near = (wasNear === undefined) ? isNearBottom(log) : wasNear;
    if(near){
      stScrollDown(log);
      chatUnreadCounts[logId] = 0;
    } else {
      chatUnreadCounts[logId] = (chatUnreadCounts[logId] || 0) + 1;
    }
    updateScrollBottomBtn(logId);
  }

  function scrollChatToBottom(logId){
    const log = document.getElementById(logId);
    if(!log) return;
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
    chatUnreadCounts[logId] = 0;
    updateScrollBottomBtn(logId);
  }

  // Keep the arrow+badge state updated even when the chat-log/popup-log is scrolled manually
  Object.keys(scrollBtnMap).forEach(logId => {
    const log = document.getElementById(logId);
    if(!log) return;
    log.addEventListener('scroll', () => {
      if(isNearBottom(log)) chatUnreadCounts[logId] = 0;
      updateScrollBottomBtn(logId);
    });
  });

  // The reply can come back instantly (FAQ answers) - keep the loading dots visible for a moment so the chat feels natural
  function chatMinDelay(startedAt, ms = 800){
    const left = ms - (Date.now() - startedAt);
    return left > 0 ? new Promise(r => setTimeout(r, left)) : Promise.resolve();
  }
  
  // Bot reply aane par: pehle check karo user neeche tha ya nahi, phir content badlo, phir scroll
  function finishBotReply(logId, typingId, html){
    const log = document.getElementById(logId);
    const el = document.getElementById(typingId);
    const wasNear = log ? isNearBottom(log, 160) : true;
    if(el) el.innerHTML = html;
    handleNewChatMessage(logId, wasNear);
  }

  async function sendChat(inputId, logId){
    const input = document.getElementById(inputId);
    const text = input.value.trim();
    if(!text) return;
    const log = document.getElementById(logId);
    log.insertAdjacentHTML('beforeend', `<div class="msg user">${escapeHtml(text)}</div>`);
    input.value = '';
    const typingId = 'typing-' + Date.now();
    log.insertAdjacentHTML('beforeend', `<div class="msg bot" id="${typingId}"><span class="typing-dots"><i></i><i></i><i></i></span></div>`);
    // aapka bheja hua message + typing dots hamesha neeche dikhne chahiye (instant scroll, smooth nahi)
    stScrollDown(log);
    chatUnreadCounts[logId] = 0;
    updateScrollBottomBtn(logId);
    const startedAt = Date.now();
    try{
      const data = await apiRequest('/student/assistant', {
        method: 'POST',
        body: JSON.stringify({ message: text })
      });
      await chatMinDelay(startedAt);
      finishBotReply(logId, typingId, escapeHtml(data.reply || '...').replace(/\n/g, '<br>'));
    }catch(err){
      finishBotReply(logId, typingId, 'Response could not be loaded, try again.');
    }
  }

  // ---- Chat history: this user's own previous questions & replies are shown in the chat page and the popup ----
  const CHAT_GREETINGS = {};

  function updateChatGreetings(name){
    const fullName = name || sessionStorage.getItem('name_student') || '';
    const firstName = fullName.trim().split(/\s+/)[0] || 'there';
    document.querySelectorAll('.student-chat-name').forEach(el => {
      el.textContent = firstName;
    });
    const mainGreeting = document.getElementById('chatMainGreeting');
    if(mainGreeting) CHAT_GREETINGS['chatLog'] = mainGreeting.outerHTML;
    const popupGreeting = document.getElementById('chatPopupGreeting');
    if(popupGreeting) CHAT_GREETINGS['popupLog'] = popupGreeting.outerHTML;
  }

  function renderChatHistory(logId, items){
    const log = document.getElementById(logId);
    if(!log) return;
    if(log.querySelector('[id^="typing-"]')) return;   // a reply is loading right now - do not wipe it
    if(CHAT_GREETINGS[logId] === undefined){
      updateChatGreetings();
      const first = log.querySelector('.msg.bot');
      CHAT_GREETINGS[logId] = first ? first.outerHTML : '';
    }
    log.innerHTML = CHAT_GREETINGS[logId] + items.map(m => {
      const when = m.created_at ? new Date(m.created_at).toLocaleString() : '';
      return `<div class="msg user" title="${when}">${escapeHtml(m.message || '')}</div>` +
             `<div class="msg bot" title="${when}">${escapeHtml(m.response || '').replace(/\n/g, '<br>')}</div>`;
    }).join('');
    stScrollDown(log);
    if(typeof chatUnreadCounts !== 'undefined') chatUnreadCounts[logId] = 0;
    if(typeof updateScrollBottomBtn === 'function') updateScrollBottomBtn(logId);
  }

  async function loadChatHistory(){
    updateChatGreetings();
    try{
      const items = await apiRequest('/student/chat-history');
      ['chatLog', 'popupLog'].forEach(id => renderChatHistory(id, items));
    }catch(err){
      /* history is optional - the chat still works without it */
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    updateChatGreetings();
    loadChatHistory();
  });

  // Dashboard "Ask StudentHub" card + suggestion tags — the floating popup is the actual chat surface,
  // a question sent from the dashboard card opens/shows in that same popup
  function askAIFromDashboard(){
    const input = document.getElementById('askaiInput');
    const text = input.value.trim();
    if(!text) return;
    input.value = '';
    openPopupWithQuery(text);
  }
  function askAITag(text){
    openPopupWithQuery(text);
  }
  function openPopupWithQuery(text){
    const popup = document.getElementById('popup');
    if(popup.classList.contains('hidden')) togglePopup();
    const popupInput = document.getElementById('popupInput');
    popupInput.value = text;
    sendChat('popupInput', 'popupLog');
  }
  function escapeHtml(str){
    return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  }


// ============================================================
// TIMETABLE (real data) — /student/timetable + /student/exam-timetable
// Weekly grid (desktop) / day-wise tabs (mobile) / Home "Today's timetable" / exam cards
// ============================================================
const ST_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ST_DAY_FULL = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const ST_LUNCH_START = 13 * 60 + 30;   // 1:30 PM
const ST_LUNCH_END = 14 * 60;          // 2:00 PM

let stTT = { student: null, slots: [] };
let stExams = [];
let stExamMode = 'regular';            // 'regular' | 'Mid-Sem' | 'Remedial'
let stSelectedDay = null;
let stLastFetch = 0;
let stTTError = '';
let stUpcoming = [];                  // cancelled lectures / holidays of the next 30 days

function stEsc(v){ return escapeHtml(String(v ?? '')); }
function stTodayKey(){ return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()]; }
function stMin(t){ const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); }
function stNowMin(){ const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
function stFmt(t){
  if(!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const hour12 = (h % 12) || 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function stFacultyLabel(slot){
  const nm = (slot.faculty_short_name && slot.faculty_short_name.trim()) || slot.faculty_name;
  return nm ? 'Prof. ' + nm : '';
}
function stSessionBadge(slot){
  const type = slot.session_type === 'Lab' ? 'Lab' : 'Lecture';
  return `<em class="tt-type ${type === 'Lab' ? 'is-lab' : 'is-lecture'}">${type}</em>`;
}
const ST_LUNCH_START_STR = '13:30';
const ST_LUNCH_END_STR = '14:00';
// One cell of the weekly grid: subject, Lecture/Lab label, faculty · room (same order as the faculty/admin grid)
function stGridCellHtml(l){
  const type = l.session_type === 'Lab' ? 'Lab' : 'Lecture';
  const meta = [stFacultyLabel(l), l.room_no || 'Room TBA'].filter(Boolean).join(' · ');
  return `<div class="tt-subject${stIsOff(l) ? ' tt-off' : ''}">${stEsc(l.subject_name || 'Lecture')}</div>` +
    `<div class="tt-session ${type === 'Lab' ? 'is-lab' : 'is-lecture'}">${type}</div>` +
    `<div class="tt-meta">${stEsc(meta)}</div>` + stStatusPill(l);
}
function stDetail(slot){
  return [slot.room_no || 'Room TBA', stFacultyLabel(slot)].filter(Boolean).join(' · ');
}
// This week's status of a slot: 'held' | 'cancelled' | 'holiday' (comes from the backend)
function stIsOff(slot){ return slot.status === 'cancelled' || slot.status === 'holiday'; }
function stStatusPill(slot){
  if(slot.status === 'cancelled') return `<span class="tt-status-pill is-cancelled">Cancelled${slot.status_note ? ' · ' + stEsc(slot.status_note) : ''}</span>`;
  if(slot.status === 'holiday') return `<span class="tt-status-pill is-holiday">Holiday${slot.status_note ? ' · ' + stEsc(slot.status_note) : ''}</span>`;
  return '';
}
function stSlotsOfDay(day){
  return stTT.slots.filter(s => s.day_of_week === day).sort((a, b) => stMin(a.start_time) - stMin(b.start_time));
}

// ---- Load ----
async function refreshStudentTimetable(force){
  if(!force && Date.now() - stLastFetch < 30000) { renderStudentTimetable(); return; }
  stLastFetch = Date.now();
  renderStudentBanner();
  const [ttRes, exRes, upRes] = await Promise.allSettled([
    apiRequest('/student/timetable'),
    apiRequest('/student/exam-timetable'),
    apiRequest('/student/upcoming-changes')
  ]);
  if(upRes.status === 'fulfilled') stUpcoming = upRes.value.changes || [];
  if(ttRes.status === 'fulfilled'){
    stTT = { student: ttRes.value.student || null, slots: ttRes.value.slots || [] };
    stTTError = '';
  }else{
    // background refresh fail ho to purana timetable dikhta rahe, error sirf tab jab kuch loaded hi nahi
    if(!stTT.student && !stTT.slots.length) stTTError = ttRes.reason && ttRes.reason.message ? ttRes.reason.message : 'Request failed';
    stLastFetch = 0;
  }
  if(exRes.status === 'fulfilled') stExams = exRes.value.exams || [];
  renderStudentTimetable();
}

function renderStudentTimetable(){
  renderStudentBanner();
  renderStudentUpcoming();
  renderStudentHomeToday();
  renderStudentWeekTable();
  renderStudentDayView();
  renderStudentExams();
  renderStudentMidExamStat();
}
// keep the Now/Next highlight updating (redraw from cache every minute)
setInterval(renderStudentTimetable, 60000);

// ---- Upcoming changes: cancelled lectures / holidays known in advance (next 30 days) ----
function stUpcomingHtml(){
  const byDate = {};
  stUpcoming.forEach(c => { (byDate[c.date] = byDate[c.date] || []).push(c); });
  return Object.keys(byDate).sort().map(date => {
    const d = new Date(date + 'T00:00:00');
    const label = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    const rows = byDate[date].map(c => {
      if(c.status === 'holiday'){
        return `<div style="font-size:12.5px; padding:2px 0;">🎉 No lectures — <b>${stEsc(c.note)}</b> (Holiday)</div>`;
      }
      const type = c.session_type === 'Lab' ? 'Lab' : 'Lecture';
      return `<div style="font-size:12.5px; padding:2px 0;">
        <b class="tt-off">${stEsc(c.subject_name || 'Lecture')}</b>
        <em class="tt-type ${type === 'Lab' ? 'is-lab' : 'is-lecture'}">${type}</em>
        · ${stFmt(c.start_time)}
        <span class="tt-status-pill is-cancelled">Cancelled${c.note ? ' · ' + stEsc(c.note) : ''}</span>
      </div>`;
    }).join('');
    return `<div style="display:flex; gap:12px; padding:8px 0; border-bottom:1px solid var(--line);">
      <div style="min-width:86px; font-weight:600; font-size:12.5px;">${label}</div>
      <div>${rows}</div>
    </div>`;
  }).join('');
}

function renderStudentUpcoming(){
  const homeCard = document.getElementById('homeUpcomingCard');
  const homeBox = document.getElementById('homeUpcoming');
  const ttBox = document.getElementById('ttUpcomingBox');
  const ttList = document.getElementById('ttUpcoming');
  const has = stUpcoming.length > 0;
  const html = has ? stUpcomingHtml() : '';
  if(homeCard) homeCard.classList.toggle('hidden', !has);
  if(homeBox) homeBox.innerHTML = html;
  if(ttBox) ttBox.classList.toggle('hidden', !has);
  if(ttList) ttList.innerHTML = html;
}

// ---- Banner (name + semester + division) ----
function renderStudentBanner(){
  const nameEl = document.getElementById('stuBannerName');
  const eyebrowEl = document.getElementById('stuBannerEyebrow');
  if(!nameEl || !eyebrowEl) return;
  const fullName = (sessionStorage.getItem('name_student') || 'Student').trim();
  nameEl.textContent = `Welcome back, ${fullName}`;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good Morning' : (hour < 17 ? 'Good Afternoon' : 'Good Evening');
  const st = stTT.student;
  const parts = [];
  if(st && st.semester) parts.push(`Semester ${st.semester}`);
  if(st && st.division) parts.push(`Div ${st.division}`);
  parts.push(greeting);
  eyebrowEl.textContent = parts.join(' · ');
}

// ---- List of a day's lectures (Home + mobile day view) ----
function stDayRowsHtml(daySlots, isToday){
  const nowMin = stNowMin();
  const bars = ['bar1', 'bar2', 'bar3'];
  let html = '';
  daySlots.forEach((l, i) => {
    const start = stMin(l.start_time), end = stMin(l.end_time);
    const prev = daySlots[i - 1];
    if(prev && stMin(prev.end_time) <= ST_LUNCH_START && start >= ST_LUNCH_END){
      html += '<div class="tt-lunch-row">🍽 Lunch break · 1:30 PM – 2:00 PM</div>';
    }
    const isNow = isToday && start <= nowMin && nowMin < end;
    const isDone = isToday && end <= nowMin;
    html += `
      <div class="tt-row${isNow && !stIsOff(l) ? ' now' : ''}${isDone || stIsOff(l) ? ' done' : ''}">
        <div class="tt-bar ${bars[i % 3]}"></div>
        <div class="tt-time"><b>${stFmt(l.start_time)}</b><span>${stFmt(l.end_time)}</span></div>
        <div class="tt-info"><b class="${stIsOff(l) ? 'tt-off' : ''}">${stEsc(l.subject_name || 'Lecture')} ${stSessionBadge(l)}</b><span>${stEsc(stDetail(l))}</span>${stStatusPill(l)}</div>
        ${isNow && !stIsOff(l) ? '<span class="tt-now-pill">Now</span>' : ''}
      </div>`;
  });
  return html;
}

function stNoTimetableMsg(){
  if(stTTError) return `Timetable could not be loaded: ${stEsc(stTTError)}`;
  const st = stTT.student;
  if(st && (!st.semester || !st.division)) return 'Your semester / division is not set yet — contact the admin.';
  return 'Timetable has not been published for your class yet.';
}

function renderStudentHomeToday(){
  const box = document.getElementById('homeTodayTT');
  const chip = document.getElementById('homeTTChip');
  if(!box) return;
  if(chip) chip.classList.add('hidden');

  if(!stTT.slots.length){
    box.innerHTML = `<div class="tt-msg">${stNoTimetableMsg()}</div>`;
    return;
  }
  const today = stTodayKey();
  const list = stSlotsOfDay(today);
  if(!list.length){
    box.innerHTML = `<div class="tt-msg">${today === 'Sun' ? "It's Sunday — no lectures today 🎉" : 'No lectures today 🎉'}</div>`;
    return;
  }
  box.innerHTML = stDayRowsHtml(list, true);

  // Chip: which lecture is running right now / when the next one is
  const nowMin = stNowMin();
  const heldList = list.filter(l => !stIsOff(l));
  const ongoing = heldList.find(l => stMin(l.start_time) <= nowMin && nowMin < stMin(l.end_time));
  const next = heldList.find(l => stMin(l.start_time) > nowMin);
  if(chip){
    let text = '';
    if(ongoing) text = `Now: ${ongoing.subject_name || 'Lecture'}`;
    else if(next) text = `Next: ${stFmt(next.start_time)}`;
    else text = 'Done for today';
    chip.textContent = text;
    chip.classList.remove('hidden');
  }
}

// ---- Weekly grid (desktop) ----
// Same algorithm as the admin panel grid: a long slot (e.g. 11:30–1:30 lab) is merged with rowspan
// instead of getting its own duplicate time row.
function stBuildSegments(slots){
  const boundaries = new Set();
  slots.forEach(s => { boundaries.add(stMin(s.start_time)); boundaries.add(stMin(s.end_time)); });
  boundaries.add(ST_LUNCH_START);
  boundaries.add(ST_LUNCH_END);
  const sorted = [...boundaries].filter(Number.isFinite).sort((a, b) => a - b);
  const segs = [];
  for(let i = 0; i < sorted.length - 1; i++){
    if(sorted[i + 1] > sorted[i]) segs.push({ start: sorted[i], end: sorted[i + 1] });
  }
  return segs;
}
function stIsLunchSeg(seg){ return seg && seg.start === ST_LUNCH_START && seg.end === ST_LUNCH_END; }
function stMinToLabel(m){
  const h = Math.floor(m / 60), mm = m % 60;
  return stFmt(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
}
function stSlotForSeg(slots, day, seg){
  return slots.find(s => s.day_of_week === day && stMin(s.start_time) <= seg.start && stMin(s.end_time) >= seg.end) || null;
}
function stSlotKey(s){ return String(s.id ?? [s.day_of_week, s.start_time, s.end_time, s.subject_name, s.session_type].join('|')); }

function renderStudentWeekTable(){
  const table = document.getElementById('ttWeekTable');
  if(!table) return;
  const slots = stTT.slots;
  if(!slots.length){
    table.innerHTML = `<tr><td class="tt-msg">${stNoTimetableMsg()}</td></tr>`;
    return;
  }
  const days = ST_DAYS.filter(d => d !== 'Sat' || slots.some(s => s.day_of_week === 'Sat'));
  const today = stTodayKey();
  const segments = stBuildSegments(slots);

  table.className = 'tt-grid-table';
  let html = `<tr><th class="tt-time-col">Time</th>${days.map(d => `<th class="${d === today ? 'tt-today' : ''}">${ST_DAY_FULL[d]}</th>`).join('')}</tr>`;

  segments.forEach((seg, rowIndex) => {
    html += `<tr><td class="tt-time-col">${stMinToLabel(seg.start)} - ${stMinToLabel(seg.end)}</td>`;
    if(stIsLunchSeg(seg)){
      html += `<td class="tt-break-cell" colspan="${days.length}">Lunch Break</td></tr>`;
      return;
    }
    days.forEach(day => {
      const match = stSlotForSeg(slots, day, seg);
      if(!match){
        html += '<td class="tt-cell-empty">—</td>';
        return;
      }
      const prevSeg = rowIndex > 0 ? segments[rowIndex - 1] : null;
      const prevMatch = prevSeg && !stIsLunchSeg(prevSeg) ? stSlotForSeg(slots, day, prevSeg) : null;
      if(prevMatch && stSlotKey(prevMatch) === stSlotKey(match)) return;   // covered by the rowspan above

      let span = 1;
      for(let j = rowIndex + 1; j < segments.length; j++){
        if(stIsLunchSeg(segments[j])) break;
        const nextMatch = stSlotForSeg(slots, day, segments[j]);
        if(nextMatch && stSlotKey(nextMatch) === stSlotKey(match)) span++;
        else break;
      }
      html += `<td class="tt-gcell" rowspan="${span}">${stGridCellHtml(match)}</td>`;
    });
    html += '</tr>';
  });
  table.innerHTML = html;
}

// ---- Day tabs + list (mobile) ----
function stSelectDay(day){ stSelectedDay = day; renderStudentDayView(); }

function renderStudentDayView(){
  const tabs = document.getElementById('ttDayTabs');
  const list = document.getElementById('ttDayList');
  if(!tabs || !list) return;
  if(!stTT.slots.length){
    tabs.innerHTML = '';
    list.innerHTML = `<div class="tt-msg">${stNoTimetableMsg()}</div>`;
    return;
  }
  const days = ST_DAYS.filter(d => d !== 'Sat' || stTT.slots.some(s => s.day_of_week === 'Sat'));
  const today = stTodayKey();
  if(!stSelectedDay || !days.includes(stSelectedDay)) stSelectedDay = days.includes(today) ? today : days[0];

  tabs.innerHTML = days.map(d =>
    `<button class="${d === stSelectedDay ? 'active' : ''} ${d === today ? 'today' : ''}" onclick="stSelectDay('${d}')">${d}</button>`
  ).join('');

  const daySlots = stSlotsOfDay(stSelectedDay);
  list.innerHTML = daySlots.length
    ? stDayRowsHtml(daySlots, stSelectedDay === today)
    : `<div class="tt-msg">No lectures on ${ST_DAY_FULL[stSelectedDay]}.</div>`;
}

// ---- Exam timetable ----
function stSetTTMode(mode){
  stExamMode = mode;
  document.querySelectorAll('#ttSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('ttRegular').classList.toggle('hidden', mode !== 'regular');
  document.getElementById('ttExam').classList.toggle('hidden', mode === 'regular');
  renderStudentExams();
}

function openStudentExamTimetable(type){
  switchView('timetable');
  stSetTTMode(type);
}

// How many days from today the exam is (negative = already over)
function stExamDiff(e){
  const [y, m, d] = e.exam_date.split('-').map(Number);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - today) / 86400000);
}
function stExamDone(e){
  const diff = stExamDiff(e);
  return diff < 0 || (diff === 0 && stMin(e.end_time) <= stNowMin());
}

function renderStudentExams(){
  const box = document.getElementById('ttExam');
  if(!box || stExamMode === 'regular') return;
  const rows = stExams.filter(e => e.exam_type === stExamMode);
  if(!rows.length){
    box.innerHTML = `<div class="tt-msg">${stExamMode} exam timetable has not been published for your class yet.</div>`;
    return;
  }
  box.innerHTML = `<div class="ex-list">${rows.map(e => {
    const [y, m, d] = e.exam_date.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const diff = stExamDiff(e);
    const done = stExamDone(e);
    let label, cls = '';
    if(done){ label = 'Done'; cls = 'done'; }
    else if(diff === 0){ label = 'Today'; cls = 'soon'; }
    else if(diff === 1){ label = 'Tomorrow'; cls = 'soon'; }
    else { label = `in ${diff} days`; cls = diff <= 3 ? 'soon' : ''; }
    return `
      <div class="ex-card${done ? ' past' : ''}">
        <div class="ex-date"><b>${d}</b><span>${dt.toLocaleDateString('en-IN', { month: 'short' })}</span></div>
        <div class="ex-info">
          <b>${stEsc(e.subject_name || 'Exam')}</b>
          <span>${dt.toLocaleDateString('en-IN', { weekday: 'long' })} · ${stFmt(e.start_time)} – ${stFmt(e.end_time)} · ${stEsc(e.room_no || 'Room TBA')}</span>
        </div>
        <span class="ex-count ${cls}">${label}</span>
      </div>`;
  }).join('')}</div>`;
}

// Home stat card: how many days until the next Mid-Sem exam
function renderStudentMidExamStat(){
  const el = document.getElementById('statMidExam');
  if(!el) return;
  const mid = stExams.filter(e => e.exam_type === 'Mid-Sem');
  if(!mid.length){ el.textContent = 'Not yet'; return; }
  const upcoming = mid.find(e => !stExamDone(e));
  if(!upcoming){ el.textContent = 'Done'; return; }
  const diff = stExamDiff(upcoming);
  el.textContent = diff === 0 ? 'Today' : (diff === 1 ? 'Tomorrow' : `${diff} Days`);
}

// Load as soon as the page opens
refreshStudentTimetable(true);
loadStudentAttendance();
loadStudentResults();
loadStudentNotices();
loadStudentAssignments();
loadStudentNotes();
loadStudentFaculty();
loadStudentFees();

// ============================================================
// NOTES / STUDY MATERIALS (read-only) — /student/materials
// ============================================================
const ST_NOTE_ICONS = { pdf: '📕', doc: '📘', docx: '📘', ppt: '📙', pptx: '📙' };
let stNotesData = [];

function stNoteIcon(fileType){
  return ST_NOTE_ICONS[(fileType || '').toLowerCase()] || '📄';
}

async function loadStudentNotes(silent){
  const grid = document.getElementById('notesGrid');
  if(!grid) return;
  try{
    const data = await apiRequest('/student/materials');
    if(!stChanged('notes', data)) return;
    stNotesData = data.materials || [];
    populateNotesSubjectFilter();
    renderStudentNotes();
  }catch(err){
    if(silent) return;
    grid.innerHTML = `<div class="tt-msg">Materials could not be loaded: ${escapeHtml(err.message)}</div>`;
  }
}

// Show only those subjects in the dropdown that have at least one material
function populateNotesSubjectFilter(){
  const select = document.getElementById('notesSubjectFilter');
  if(!select) return;
  const prev = select.value;
  const subjects = [...new Map(stNotesData.map(m => [m.subject_name || 'Other', m.subject_code])).entries()];
  select.innerHTML = '<option value="">All subjects</option>' +
    subjects.map(([name]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if(subjects.some(([name]) => name === prev)) select.value = prev;
}

function renderStudentNotes(){
  const grid = document.getElementById('notesGrid');
  if(!grid) return;
  if(!stNotesData.length){
    grid.innerHTML = '<div class="tt-msg">No materials have been uploaded for your class yet.</div>';
    return;
  }

  const filterEl = document.getElementById('notesSubjectFilter');
  const filter = filterEl ? filterEl.value : '';
  const materials = filter ? stNotesData.filter(m => (m.subject_name || 'Other') === filter) : stNotesData;

  if(!materials.length){
    grid.innerHTML = '<div class="tt-msg">No materials found for this subject.</div>';
    return;
  }

  // Subject-wise groups: keep the order in which each subject first appeared (no extra sorting)
  const groups = new Map();
  materials.forEach(m => {
    const key = m.subject_name || 'Other';
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });

  grid.innerHTML = [...groups.entries()].map(([subjectName, items]) => `
    <div class="notes-subject-group" style="margin-bottom:20px;">
      <div class="card-title" style="font-size:15px; margin-bottom:10px;">${escapeHtml(subjectName)}${items[0].subject_code ? ' (' + escapeHtml(items[0].subject_code) + ')' : ''}</div>
      <div class="fac-grid">
        ${items.map(m => `
          <div class="fac-card" style="text-align:left;">
            <b style="display:block; margin-bottom:4px;">${stNoteIcon(m.file_type)} ${escapeHtml(m.title)}</b>
            <span>${escapeHtml(m.uploaded_by || 'Admin')}</span>
            <button class="fac-msg" onclick="downloadStudentMaterial(${m.id})">Download ${m.file_type ? m.file_type.toUpperCase() : 'File'}</button>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

// works by id only (so onclick doesn't break when the title/filename has quotes/apostrophes)
async function downloadStudentMaterial(id){
  const note = stNotesData.find(x => x.id === id);
  const fileName = note ? note.file_name : `material-${id}`;
  try{
    const res = await fetch(API_BASE + `/student/materials/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_student') }
    });
    if(!res.ok){
      alert('Download failed');
      return;
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }catch(err){
    alert('Download error: ' + err.message);
  }
}


// ============================================================
// ASSIGNMENTS — /student/assignments
// ============================================================
let stAssignmentsData = [];

function stAssignmentStatus(a){
  if(a.submission_id){
    const submittedDate = (a.submitted_at || '').slice(0, 10);
    const late = a.due_date && a.submitted_at && a.submitted_at > a.due_date;
    return {
      label: submittedDate ? `Submitted on ${submittedDate}` : 'Submitted',
      cls: late ? 'bad' : 'good'
    };
  }
  const late = a.due_date && a.due_date < new Date().toISOString().slice(0, 10);
  return { label: late ? 'Late' : 'Pending', cls: late ? 'bad' : 'warn' };
}

async function loadStudentAssignments(silent){
  const tbody = document.getElementById('assignmentsTableBody');
  try{
    const data = await apiRequest('/student/assignments');
    if(!stChanged('assignments', data)) return;
    stAssignmentsData = data.assignments || [];
    if(tbody) renderStudentAssignments();
    updatePendingAssignmentsStat();
  }catch(err){
    if(silent) return;
    if(tbody) tbody.innerHTML = `<tr><td colspan="5">Assignments could not be loaded: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// Dashboard "Pending assignments" stat card — computes the real count, not hardcoded.
// Un-submitted assignments are counted (whether or not the due date has passed), because
// in both cases the student still has to take action.
function updatePendingAssignmentsStat(){
  const el = document.getElementById('statPendingAssignments');
  if(!el) return;
  el.textContent = stAssignmentsData.filter(a => !a.submission_id).length;
}

function renderStudentAssignments(){
  const tbody = document.getElementById('assignmentsTableBody');
  if(!stAssignmentsData.length){
    tbody.innerHTML = '<tr><td colspan="5">No assignments have been posted for your class yet.</td></tr>';
    return;
  }

  tbody.innerHTML = stAssignmentsData.map(a => {
    const status = stAssignmentStatus(a);
    const problemLink = a.problem_file_name
      ? `<span class="card-link" onclick="downloadStudentAssignment(${a.id})">Download</span>`
      : '—';

    return `
      <tr>
        <td>${escapeHtml(a.title)}</td>
        <td>${escapeHtml(a.subject_name || '-')}</td>
        <td>${a.due_date || '-'}</td>
        <td>${problemLink}</td>
        <td><span class="pill ${status.cls}">${status.label}</span></td>
      </tr>
    `;
  }).join('');
}

async function loadStudentFees(silent){
  const tbody = document.getElementById('feesTableBody');
  if(tbody && !silent && !stCache.fees) tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try{
    const data = await apiRequest('/student/fees');
    if(!stChanged('fees', data)) return;
    const fees = data.fees || [];
    updatePendingFeeStat(fees);
    renderStudentFeeChart(fees);
    if(!tbody) return;
    if(!fees.length){
      tbody.innerHTML = '<tr><td colspan="6">No fee records found yet.</td></tr>';
      return;
    }
    tbody.innerHTML = fees.map(f => {
      const isPaid = f.status === 'paid';
      const payLink = (!isPaid && f.payment_link)
        ? `<a href="${escapeHtml(f.payment_link)}" target="_blank" class="card-link">Pay now →</a>`
        : (isPaid ? '—' : '');
      return `
        <tr>
          <td>${escapeHtml(f.fee_title || '-')}</td>
          <td>Sem ${escapeHtml(String(f.semester ?? '-'))} · ${escapeHtml(f.academic_year || '-')}</td>
          <td>₹${Number(f.amount).toLocaleString('en-IN')}</td>
          <td>${f.due_date || '-'}</td>
          <td><span class="pill ${isPaid ? 'good' : 'bad'}">${isPaid ? 'Paid' : 'Pending'}</span></td>
          <td>${payLink}</td>
        </tr>
      `;
    }).join('');
  }catch(err){
    if(tbody) tbody.innerHTML = `<tr><td colspan="6">Fees could not be loaded: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// Dashboard "Fee status" stat card — shows the fee title + status instead of the amount
// (whichever fee is due first). If more than one is pending, "+N more" is added too.
function updatePendingFeeStat(fees){
  const el = document.getElementById('statPendingFee');
  const statusEl = document.getElementById('statPendingFeeStatus');
  if(!el) return;
  const pending = fees
    .filter(f => f.status !== 'paid')
    .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

  if(!pending.length){
    el.textContent = 'No dues';
    if(statusEl){ statusEl.textContent = 'Paid'; statusEl.className = 'pill good'; }
    return;
  }
  const first = pending[0];
  el.textContent = pending.length > 1
    ? `${first.fee_title} +${pending.length - 1} more`
    : (first.fee_title || 'Fee due');
  if(statusEl){ statusEl.textContent = 'Pending'; statusEl.className = 'pill bad'; }
}

// ---- Dashboard charts (drawn by shared/charts.js, using the same data as the Attendance / Results / Fees pages) ----
// Fee status donut: paid vs pending fee records
function renderStudentFeeChart(fees){
  if(!window.SHCharts) return;
  const rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  const paid = fees.filter(f => f.status === 'paid');
  const pending = fees.filter(f => f.status !== 'paid');
  const sum = list => list.reduce((s, f) => s + (Number(f.amount) || 0), 0);
  SHCharts.donut(document.getElementById('stuFeeChart'), [
    { label: 'Paid',    value: paid.length,    color: SHCharts.colors.good, text: `${paid.length} · ${rupees(sum(paid))}` },
    { label: 'Pending', value: pending.length, color: SHCharts.colors.warn, text: `${pending.length} · ${rupees(sum(pending))}` }
  ], { center: fees.length ? `${paid.length}/${fees.length}` : '', sub: 'fees paid', label: 'Fees paid versus pending', empty: 'No fee records found yet.' });
}

// Attendance bars per subject, with the 75% line (subjects with no attendance marked yet are left out)
function renderStudentAttendanceChart(subjects){
  if(!window.SHCharts) return;
  SHCharts.columns(document.getElementById('stuAttendanceChart'),
    subjects.filter(s => s.total_classes > 0).map(s => ({
      label: s.subject_name, value: s.percentage,
      title: `${s.subject_name} (${s.attended_classes}/${s.total_classes} classes)`
    })),
    { max: 100, unit: '%', threshold: 75, label: 'Attendance percentage by subject', empty: 'No attendance has been recorded for your class yet.' });
}

// Marks bars per subject (published marks only), with the passing-percentage line
function renderStudentMarksChart(subjects, passingPct){
  if(!window.SHCharts) return;
  const pass = Number(passingPct) || 40;
  SHCharts.columns(document.getElementById('stuMarksChart'),
    subjects.filter(s => s.percentage != null).map(s => ({
      label: s.subject_name, value: s.percentage, title: s.subject_name
    })),
    { max: 100, unit: '%', threshold: pass, thresholdLabel: `Pass ${pass}%`, label: 'Marks percentage by subject', empty: 'Marks have not been published yet.' });
}

// works by id only (so onclick doesn't break when the title/filename has quotes/apostrophes)
async function downloadStudentAssignment(id){
  const assignment = stAssignmentsData.find(x => x.id === id);
  const fileName = assignment ? assignment.problem_file_name : `assignment-${id}`;
  try{
    const res = await fetch(API_BASE + `/student/assignments/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_student') }
    });
    if(!res.ok){
      alert('Download failed');
      return;
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }catch(err){
    alert('Download error: ' + err.message);
  }
}

// ============================================================
// ATTENDANCE (read-only) — /student/attendance
// Only Admin/Faculty mark attendance (`attendance` table);
// for the student this only shows a subject-wise summary, using the same
// logic as Admin's attendance/summary and Faculty's students
// list to work out the %.
// ============================================================
function stAttendanceStatus(pct){
  if(pct < 75) return { label: 'Below 75%', cls: 'bad' };
  if(pct < 90) return { label: 'Good', cls: 'warn' };
  return { label: 'Excellent', cls: 'good' };
}

let stAttendanceLast = null;   // last attendance response — kept so the alert can be redrawn when the Settings toggle changes

async function loadStudentAttendance(silent){
  try{
    const data = await apiRequest('/student/attendance');
    if(!stChanged('attendance', data)) return;
    stAttendanceLast = data;
    renderStudentAttendance(data.subjects || []);
    renderAttendanceAlert(data);
    renderAttendanceDashboardStat(data.overall_percentage || 0);
    renderStudentAttendanceChart(data.subjects || []);
  }catch(err){
    if(silent) return;
    const tbody = document.getElementById('attendanceTableBody');
    if(tbody) tbody.innerHTML = `<tr><td colspan="6">Attendance could not be loaded: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// Attendance shortage alert: a red box (dashboard + attendance page) listing every subject that is below the
// minimum %, with how many lectures must be attended to get back. Controlled by Settings > Attendance alerts.
function stAttendanceAlertOn(){
  return localStorage.getItem('stuAttendanceAlert') !== '0';   // default ON, same rule as the Settings toggle
}

function renderAttendanceAlert(data){
  const dash = document.getElementById('attendanceAlertDash');
  const page = document.getElementById('attendanceAlertPage');
  if(!dash && !page) return;
  const low = ((data && data.subjects) || []).filter(s => s.alert);
  if(!low.length || !stAttendanceAlertOn()){
    if(dash) dash.innerHTML = '';
    if(page) page.innerHTML = '';
    return;
  }
  const min = data.min_percentage || 75;
  const items = low.map(s => `
    <li><b>${escapeHtml(s.subject_name)}</b> — ${s.percentage_exact}% · attend the next ${s.need_more} lecture${s.need_more === 1 ? '' : 's'} to reach ${min}%</li>
  `).join('');
  const box = withLink => `
    <div class="att-alert" role="alert">
      <div class="att-alert-ic">⚠️</div>
      <div>
        <div class="att-alert-title">Attendance shortage in ${low.length} subject${low.length === 1 ? '' : 's'}</div>
        <div class="att-alert-sub">Below ${min}% you may not be eligible for the exam. Attend every lecture of these subjects:</div>
        <ul>${items}</ul>
        ${withLink ? `<span class="att-alert-link" onclick="switchView('attendance')">View attendance details →</span>` : ''}
      </div>
    </div>`;
  if(dash) dash.innerHTML = box(true);
  if(page) page.innerHTML = box(false);
}

function renderStudentAttendance(subjects){
  const tbody = document.getElementById('attendanceTableBody');
  if(!tbody) return;
  if(!subjects.length){
    tbody.innerHTML = '<tr><td colspan="6">No attendance has been recorded for your class yet.</td></tr>';
    return;
  }

  tbody.innerHTML = subjects.map(s => {
    const status = stAttendanceStatus(s.percentage);
    let stay = '<span class="att-ok">—</span>';
    if(s.total_classes > 0){
      if(s.short) stay = `<span class="att-need">Attend next ${s.need_more} lecture${s.need_more === 1 ? '' : 's'}</span>`;
      else if(s.can_miss > 0) stay = `<span class="att-ok">Can miss ${s.can_miss} more</span>`;
      else stay = '<span class="att-ok">No spare lectures</span>';
    }
    return `
      <tr>
        <td>${escapeHtml(s.subject_name)}</td>
        <td>${s.total_classes}</td>
        <td>${s.attended_classes}</td>
        <td>${s.percentage}%</td>
        <td><span class="pill ${status.cls}">${status.label}</span></td>
        <td>${stay}</td>
      </tr>
    `;
  }).join('');
}

function renderAttendanceDashboardStat(pct){
  const valueEl = document.getElementById('statAttendance');
  const ringEl = document.getElementById('attendanceRingFill');
  if(valueEl) valueEl.textContent = `${pct}%`;
  if(ringEl) ringEl.setAttribute('stroke-dasharray', `${pct},100`);

  const overallPillEl = document.getElementById('attendanceOverallPill');
  if(overallPillEl){
    const status = stAttendanceStatus(pct);
    overallPillEl.textContent = `${pct}% · ${status.label}`;
    overallPillEl.className = `pill ${status.cls}`;
  }
}

// ============================================================
// RESULTS (read-only) — /student/results
// Faculty enters marks -> Admin approves -> Admin
// publishes; the student only sees published marks.
// ============================================================
const ST_EXAM_COLUMNS = ['Mid-Semester', 'Remedial', 'Internal', 'Practical'];

// A pill is built only for an exam whose marks are published — that exam's own
// pass/fail is also decided by the same passing_percentage used in the overall status.
function stExamCell(exam, passingPct){
  if(!exam) return '—';
  const pct = exam.marks_obtained * 100 / exam.max_marks;
  const cls = pct >= passingPct ? 'pass' : 'fail';
  return `<span class="pill ${cls}">${exam.marks_obtained}/${exam.max_marks}</span>`;
}

async function loadStudentResults(silent){
  const tbody = document.getElementById('resultsTableBody');
  try{
    const data = await apiRequest('/student/results');
    if(!stChanged('results', data)) return;
    renderStudentResults(data.subjects || [], data.passing_percentage);
    renderStudentMarksChart(data.subjects || [], data.passing_percentage);
  }catch(err){
    if(silent) return;
    if(tbody) tbody.innerHTML = `<tr><td colspan="5">Results could not be loaded: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderStudentResults(subjects, passingPct){
  const tbody = document.getElementById('resultsTableBody');
  if(!tbody) return;
  if(!subjects.length){
    tbody.innerHTML = '<tr><td colspan="5">No subjects found for your semester yet.</td></tr>';
    return;
  }

  tbody.innerHTML = subjects.map(s => {
    const examCells = ST_EXAM_COLUMNS.map(et => `<td>${stExamCell(s.exams[et], passingPct)}</td>`).join('');
    return `
      <tr>
        <td>${escapeHtml(s.subject_name)}</td>
        ${examCells}
      </tr>
    `;
  }).join('');
}

// ============================================================
// NOTICES (read-only) — /student/notices
// Only Admin/Faculty post/edit/pin/delete notices;
// a student sees only the broadcast notices of their own class + their own
// personal notices — the "All notices" page is now the same WhatsApp-style
// feed as Admin/Faculty (received-card, no menu/edit/pin
// because a student doesn't create notices), and the unread badge/mark-read
// work the same as in the Faculty panel.
// ============================================================
let stNoticesData = [];
let knownNoticeIds = new Set();
let noticesUnseenNewCount = 0;
const NF_CAT_CLASS = { Academic: '', Event: 'event', Important: 'urgent' };

function stNoticeTagClass(category){
  return NF_CAT_CLASS[category] || '';
}

function stNoticeDateParts(createdAt){
  const d = new Date(createdAt);
  return {
    day: String(d.getDate()).padStart(2, '0'),
    month: d.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase()
  };
}

function nfDateLabel(iso){
  const d = new Date(iso);
  if(isNaN(d)) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if(diff === 0) return 'Today';
  if(diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function nfTime(iso){
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

function nfFileSize(bytes){
  if(!bytes) return '';
  if(bytes < 1024) return bytes + ' B';
  if(bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function nfToggleBody(el){ el.classList.toggle('expanded'); }

function stNoticeScope(n){
  return [n.semester ? 'Sem ' + n.semester : '', n.division ? 'Div ' + n.division : ''].filter(Boolean).join(' · ');
}

// Same as Admin/Faculty's nfFileChip — 📎 icon + filename + size, click to download
function stNoticeFileChip(n){
  if(!n.file_name) return '';
  return nfAttachmentHtml(n, `stNoticeAction('preview', ${n.id})`, `stNoticeAction('download', ${n.id})`);
}

// The card's buttons work by id (so the onclick attribute doesn't break when the
// title/filename has quotes/apostrophes) — same pattern as Admin/Faculty's nfFacAction.
function stNoticeAction(action, id){
  const n = stNoticesData.find(x => x.id === id);
  if(!n) return;
  if(action === 'download') downloadStudentNotice(id, n.file_name);
  else if(action === 'preview') nfOpenPreview(id, n.file_name);
}

// Who sent the notice — "Prof. Name" for faculty, "Name" + Admin label for admin
// (like a sender's name shown above the message in a WhatsApp group)
function stNoticeSender(n){
  const name = (n.posted_by_name || '').trim();
  if(!name) return '';
  const isFaculty = n.posted_by_role === 'faculty';
  const label = isFaculty ? 'Prof. ' + name.replace(/^Prof\.?\s*/i, '') : name;
  const roleText = isFaculty ? 'Faculty' : (n.posted_by_role === 'admin' ? 'Admin' : '');
  return `<div class="nf-sender">${escapeHtml(label)}${roleText ? ` <small>${roleText}</small>` : ''}</div>`;
}

// Same as Admin/Faculty's nfFacReceivedCard — the "received" card for the student
function stNoticeCard(n){
  const tagCls = n.is_personal ? '' : stNoticeTagClass(n.category);
  const scope = stNoticeScope(n);
  return `
    <div class="nf-card ${tagCls ? 'nf-cat-' + tagCls : ''}">
      ${stNoticeSender(n)}
      <div class="nf-top">
        <span class="notice-tag ${tagCls}">${n.is_personal ? 'For you' : escapeHtml(n.category || 'Academic')}</span>
        ${scope ? `<span class="nf-scope">${escapeHtml(scope)}</span>` : ''}
      </div>
      <div class="nf-title">${escapeHtml(n.title)}</div>
      ${n.content ? `<div class="nf-body" onclick="nfToggleBody(this)">${escapeHtml(n.content)}</div>` : ''}
      ${stNoticeFileChip(n)}
      <div class="nf-meta"><span>${nfTime(n.created_at)}</span></div>
    </div>`;
}

async function loadStudentNotices(){
  try{
    const data = await apiRequest('/student/notices');
    stChanged('notices', data);
    stNoticesData = data.notices || [];
    knownNoticeIds = new Set(stNoticesData.map(n => n.id));
    renderHomeNotices();
    renderAllNotices();
    renderNoticesBadge();
    stScrollDown('allNoticesContainer');
    updateNoticesScrollBtn();
  }catch(err){
    const grid = document.getElementById('homeNoticesGrid');
    if(grid) grid.innerHTML = `<div class="tt-msg">Notices could not be loaded: ${escapeHtml(err.message)}</div>`;
    const container = document.getElementById('allNoticesContainer');
    if(container) container.innerHTML = `<div class="nf-empty">Notices could not be loaded: ${escapeHtml(err.message)}</div>`;
  }
}

function renderHomeNotices(){
  const grid = document.getElementById('homeNoticesGrid');
  if(!grid) return;
  if(!stNoticesData.length){
    grid.innerHTML = '<div class="tt-msg">No notices yet.</div>';
    return;
  }
  grid.innerHTML = stNoticesData.slice(0, 3).map(n => {
    const { day, month } = stNoticeDateParts(n.created_at);
    const tagCls = n.is_personal ? '' : stNoticeTagClass(n.category);
    return `
      <div class="notice-card">
        <div class="notice-date"><b>${day}</b><span>${month}</span></div>
        <div>
          <span class="notice-tag ${tagCls}">${n.is_personal ? 'For you' : escapeHtml(n.category || 'Academic')}</span>
          <b>${escapeHtml(n.title)}</b>
          <span class="notice-desc">${escapeHtml(n.content || '')}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Same as Admin/Faculty's nfRenderFeed — the whole feed with pinned/date dividers
function renderAllNotices(){
  const container = document.getElementById('allNoticesContainer');
  if(!container) return;
  if(!stNoticesData.length){
    container.innerHTML = '<div class="nf-empty">No notices yet.</div>';
    return;
  }
  // The backend sends newest-first (Home needs that for its "latest 3"), but
  // like WhatsApp we want older notices on top and newer ones at the bottom here —
  // so we reverse the order only for this feed. Pinned notices always stay on top.
  const pinned = stNoticesData.filter(n => n.is_pinned).reverse();
  const others = stNoticesData.filter(n => !n.is_pinned).reverse();
  let html = '';
  let lastLabel = null;
  [...pinned, ...others].forEach(n => {
    const label = n.is_pinned ? '📌 Pinned' : nfDateLabel(n.created_at);
    if(label !== lastLabel){
      html += `<div class="nf-divider${n.is_pinned ? ' pinned' : ''}">${escapeHtml(label)}</div>`;
      lastLabel = label;
    }
    html += stNoticeCard(n);
  });
  container.innerHTML = `<div class="nf-feed">${html}</div>`;
}

function renderNoticesBadge(){
  const badge = document.getElementById('noticesBadge');
  const topbarDot = document.getElementById('topbarNoticeDot');
  const unread = stNoticesData.filter(n => !n.is_read).length;
  if(badge){
    if(unread > 0){
      badge.textContent = unread;
      badge.style.display = '';
    }else{
      badge.style.display = 'none';
    }
  }
  if(topbarDot){
    topbarDot.textContent = unread > 99 ? '99+' : (unread > 0 ? unread : '');
    topbarDot.classList.toggle('show', unread > 0);
  }
}

async function markStudentNoticesSeen(){
  try{
    await apiRequest('/student/notices/mark-read', { method: 'POST' });
    stNoticesData.forEach(n => n.is_read = true);
    renderNoticesBadge();
  }catch(err){
    // silent fail — it's harmless if the badge stays visible
  }
}

// ---- Notices feed scroll (WhatsApp-style, same as chat) ----
// Older notices on top, newer notices at the bottom. "Reading older notices" means
// the user has scrolled up — the ↓ arrow is there to take them to the latest (bottom)
function isNoticesNearBottom(container, threshold = 40){
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

function updateNoticesScrollBtn(){
  const container = document.getElementById('allNoticesContainer');
  const btn = document.getElementById('noticesScrollBtn');
  const badge = document.getElementById('noticesScrollBadge');
  if(!container || !btn) return;
  const nearBottom = isNoticesNearBottom(container);
  btn.classList.toggle('hidden', nearBottom);
  if(badge){
    if(!nearBottom && noticesUnseenNewCount > 0){
      badge.textContent = noticesUnseenNewCount > 9 ? '9+' : String(noticesUnseenNewCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

function scrollNoticesToBottom(){
  const container = document.getElementById('allNoticesContainer');
  if(!container) return;
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  noticesUnseenNewCount = 0;
  updateNoticesScrollBtn();
}

(function wireNoticesScroll(){
  const container = document.getElementById('allNoticesContainer');
  if(!container) return;
  container.addEventListener('scroll', () => {
    if(isNoticesNearBottom(container)) noticesUnseenNewCount = 0;
    updateNoticesScrollBtn();
  });
})();

// In the background we quietly check for new notices (like a new
// message arriving in chat) — if the user has scrolled up while reading older notices,
// we keep the list where it is without disturbing it and only show the badge
// count on the arrow; if the user is already at the bottom (latest), it scrolls straight down
async function pollStudentNotices(){
  const container = document.getElementById('allNoticesContainer');
  try{
    const data = await apiRequest('/student/notices');
    if(!stChanged('notices', data)) return;   // kuch naya nahi — feed ko chhedo mat (expanded cards / scroll safe)
    const freshNotices = data.notices || [];
    const newCount = freshNotices.filter(n => !knownNoticeIds.has(n.id)).length;

    const wasNearBottom = container ? isNoticesNearBottom(container) : true;
    const scrollTopBefore = container ? container.scrollTop : 0;

    stNoticesData = freshNotices;
    knownNoticeIds = new Set(freshNotices.map(n => n.id));
    renderHomeNotices();
    renderAllNotices();
    renderNoticesBadge();

    if(container){
      if(wasNearBottom){
        // the user is already at the latest — scroll straight down as soon as a new notice arrives
        stScrollDown(container);
        noticesUnseenNewCount = 0;
      } else {
        // the user is reading older notices — the new notices are added below, so
        // keep the position and only increase the unread badge on the arrow
        container.scrollTop = scrollTopBefore;
        if(newCount > 0) noticesUnseenNewCount += newCount;
      }
      updateNoticesScrollBtn();
    }
  }catch(err){
    // this is a background poll — let it fail silently, don't disturb the UI
  }
}
// (notices ka polling ab neeche stBackgroundRefresh ke andar hota hai)

// ============================================================
// NOTICE ATTACHMENT PREVIEW (WhatsApp-style)
// Image (jpg/png) -> shown inline in the notice card, click = full-screen view
// PDF             -> card with a Preview button (opens in a viewer popup) + Download
// Word / PowerPoint -> a browser cannot display these, so they stay download-only
// Files are fetched with the login token and shown through blob URLs (an <img src>
// cannot send the Authorization header). Images load lazily when the card scrolls
// into view, and every loaded image is cached so the 5-sec refresh doesn't reload it.
// ============================================================
const NF_TOKEN_KEY = 'token_student';
const NF_ENDPOINT = '/student/notices';
const NF_ESC = s => escapeHtml(s);
const nfMediaUrls = new Map();       // notice id -> blob URL (loaded image)
const nfMediaPromises = new Map();   // notice id -> in-flight fetch (so it's never fetched twice)
let nfViewerUrl = null;

function nfFileExt(name){
  return (name || '').split('.').pop().toLowerCase();
}

function nfFileKind(name){
  const ext = nfFileExt(name);
  if(['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
  if(ext === 'pdf') return 'pdf';
  return 'file';
}

function nfFileIcon(name){
  const ext = nfFileExt(name);
  if(ext === 'pdf') return '📕';
  if(ext === 'doc' || ext === 'docx') return '📝';
  if(ext === 'ppt' || ext === 'pptx') return '📊';
  return '📎';
}

async function nfFetchFile(id){
  const res = await fetch(`${API_BASE}${NF_ENDPOINT}/${id}/download?inline=1`, {
    headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem(NF_TOKEN_KEY) }
  });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  return res.blob();
}

function nfImageUrl(id){
  if(nfMediaUrls.has(id)) return Promise.resolve(nfMediaUrls.get(id));
  if(nfMediaPromises.has(id)) return nfMediaPromises.get(id);
  const p = nfFetchFile(id).then(blob => {
    const url = URL.createObjectURL(blob);
    nfMediaUrls.set(id, url);
    nfMediaPromises.delete(id);
    return url;
  }).catch(err => {
    nfMediaPromises.delete(id);
    throw err;
  });
  nfMediaPromises.set(id, p);
  return p;
}

// What a notice's attachment looks like inside the card
function nfAttachmentHtml(n, previewCode, downloadCode){
  const name = n.file_name || 'attachment';
  const kind = nfFileKind(name);
  const size = n.file_size ? nfFileSize(n.file_size) : '';

  if(kind === 'image'){
    const cached = nfMediaUrls.get(n.id);
    return `
      <div class="nf-media${cached ? ' loaded' : ''}" data-nf-id="${n.id}" onclick="${previewCode}" title="Click to view">
        <img alt="${NF_ESC(name)}"${cached ? ` src="${cached}"` : ''}>
        <span class="nf-media-state">Loading image…</span>
      </div>
      <div class="nf-media-cap">
        <span class="nf-file-name">${NF_ESC(name)}</span>${size ? `<small>${size}</small>` : ''}
        <button type="button" class="nf-doc-dl" onclick="${downloadCode}" title="Download">⬇</button>
      </div>`;
  }

  const isPdf = kind === 'pdf';
  const typeLabel = isPdf ? 'PDF' : (nfFileExt(name) || 'file').toUpperCase();
  return `
    <div class="nf-doc">
      <div class="nf-doc-main" onclick="${isPdf ? previewCode : downloadCode}" title="${isPdf ? 'Preview' : 'Download'}">
        <span class="nf-doc-ico">${nfFileIcon(name)}</span>
        <span class="nf-doc-info">
          <span class="nf-file-name">${NF_ESC(name)}</span>
          <small>${typeLabel}${size ? ' · ' + size : ''}${isPdf ? ' · tap to preview' : ''}</small>
        </span>
      </div>
      <button type="button" class="nf-doc-dl" onclick="${downloadCode}" title="Download">⬇</button>
    </div>`;
}

// ---- lazy-load the inline images ----
async function nfLoadMedia(el){
  if(el.dataset.state === 'loading' || el.dataset.state === 'done') return;
  el.dataset.state = 'loading';
  try{
    const url = await nfImageUrl(Number(el.dataset.nfId));
    const img = el.querySelector('img');
    if(img) img.src = url;
    el.dataset.state = 'done';
    el.classList.add('loaded');
  }catch(err){
    el.dataset.state = 'error';
    const msg = el.querySelector('.nf-media-state');
    if(msg) msg.textContent = 'Image could not be loaded — click to retry';
  }
}

const nfMediaObserver = ('IntersectionObserver' in window)
  ? new IntersectionObserver(entries => {
      entries.forEach(en => {
        if(en.isIntersecting){
          nfMediaObserver.unobserve(en.target);
          nfLoadMedia(en.target);
        }
      });
    }, { rootMargin: '200px' })
  : null;

function nfScanMedia(){
  document.querySelectorAll('.nf-media:not([data-state])').forEach(el => {
    if(el.classList.contains('loaded')){ el.dataset.state = 'done'; return; }
    el.dataset.state = 'pending';
    if(nfMediaObserver) nfMediaObserver.observe(el); else nfLoadMedia(el);
  });
}

// The feeds re-render with innerHTML from several places (polling, filters, pin/edit...),
// so instead of patching every render function we just watch for new .nf-media boxes.
(function nfWatchMedia(){
  let queued = false;
  const start = () => {
    new MutationObserver(() => {
      if(queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; nfScanMedia(); });
    }).observe(document.body, { childList: true, subtree: true });
    nfScanMedia();
  };
  if(document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

// ---- full-screen viewer (image) / popup viewer (PDF) ----
function nfCloseViewer(){
  const v = document.getElementById('nfViewer');
  if(v) v.remove();
  if(nfViewerUrl){ URL.revokeObjectURL(nfViewerUrl); nfViewerUrl = null; }
  document.removeEventListener('keydown', nfViewerKey);
}

function nfViewerKey(e){
  if(e.key === 'Escape') nfCloseViewer();
}

async function nfOpenPreview(id, fileName){
  const kind = nfFileKind(fileName);
  if(kind === 'file'){ downloadStudentNotice(id, fileName); return; }

  nfCloseViewer();
  const v = document.createElement('div');
  v.id = 'nfViewer';
  v.className = 'nf-viewer';
  v.innerHTML = `
    <div class="nf-viewer-bar">
      <span class="nf-viewer-title">${NF_ESC(fileName)}</span>
      <button type="button" class="nf-viewer-btn" id="nfViewerDl">⬇ Download</button>
      <button type="button" class="nf-viewer-btn" id="nfViewerClose" title="Close (Esc)">✕</button>
    </div>
    <div class="nf-viewer-body" id="nfViewerBody"><div class="nf-viewer-msg">Loading…</div></div>`;
  v.addEventListener('click', e => { if(e.target === v || e.target.id === 'nfViewerBody') nfCloseViewer(); });
  document.body.appendChild(v);
  document.addEventListener('keydown', nfViewerKey);
  document.getElementById('nfViewerClose').onclick = nfCloseViewer;
  document.getElementById('nfViewerDl').onclick = () => downloadStudentNotice(id, fileName);

  try{
    let url;
    if(kind === 'image'){
      url = await nfImageUrl(id);
    }else{
      const blob = await nfFetchFile(id);
      url = URL.createObjectURL(blob);
      if(!document.getElementById('nfViewer')){ URL.revokeObjectURL(url); return; }   // closed while loading
      nfViewerUrl = url;
    }
    const body = document.getElementById('nfViewerBody');
    if(!body) return;
    body.innerHTML = kind === 'image'
      ? `<img src="${url}" alt="${NF_ESC(fileName)}">`
      : `<iframe src="${url}" title="${NF_ESC(fileName)}"></iframe>`;
  }catch(err){
    const body = document.getElementById('nfViewerBody');
    if(body) body.innerHTML = '<div class="nf-viewer-msg">Preview is not available — please use Download.</div>';
  }
}

async function downloadStudentNotice(id, fileName){
  try{
    const res = await fetch(API_BASE + `/student/notices/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_student') }
    });
    if(!res.ok){
      alert('Download failed');
      return;
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }catch(err){
    alert('Download error: ' + err.message);
  }
}


// ============================================================
// FACULTY DIRECTORY (read-only) — /student/faculty
// Shows only the faculty who teach subjects of this student's own semester/
// division (the same data as Admin's get_faculty,
// just filtered for their own class).
// The "Message" button opens a wa.me link to the faculty's WhatsApp number
// (if the faculty has set a WhatsApp number), otherwise falls back to a mailto: email.
// ============================================================
function stFacInitials(name){
  const words = (name || '').replace(/^Prof\.?\s*/i, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

let stFacultyData = [];

async function loadStudentFaculty(silent){
  const grid = document.getElementById('facultyGrid');
  try{
    const data = await apiRequest('/student/faculty');
    if(!stChanged('faculty', data)) return;
    stFacultyData = data.faculty || [];
    if(grid) renderStudentFaculty(stFacultyData);
  }catch(err){
    if(silent) return;
    if(grid) grid.innerHTML = `<div class="tt-msg">Faculty directory could not be loaded: ${escapeHtml(err.message)}</div>`;
  }
}

function renderStudentFaculty(facultyList){
  const grid = document.getElementById('facultyGrid');
  if(!grid) return;
  if(!facultyList.length){
    grid.innerHTML = '<div class="tt-msg">No faculty assigned to your class yet.</div>';
    return;
  }

  grid.innerHTML = facultyList.map(f => {
    const displayName = f.short_name ? `Prof. ${f.short_name}` : f.name;
    const msgBtn = f.whatsapp_number
      ? `<a class="fac-msg" href="https://wa.me/${encodeURIComponent(f.whatsapp_number)}" target="_blank" rel="noopener" style="text-decoration:none; display:inline-block; text-align:center;">Message</a>`
      : (f.email
        ? `<a class="fac-msg" href="mailto:${escapeHtml(f.email)}" style="text-decoration:none; display:inline-block; text-align:center;">Message</a>`
        : '');
    return `
      <div class="fac-card">
        <div class="fac-avatar">${escapeHtml(stFacInitials(f.name))}</div>
        <b>${escapeHtml(displayName)}</b>
        <span>${escapeHtml(f.subjects_taught || '-')}</span>
        ${msgBtn}
      </div>
    `;
  }).join('');
}

// ============================================================
// Student Settings — profile (name + mobile) + change password.
// Enrollment/email/semester/division/batch stay Admin-controlled (disabled inputs).
// ============================================================
async function loadStudentProfile(){
  const nameEl = document.getElementById('settingsFullName');
  if(!nameEl) return;
  try{
    const p = await apiRequest('/student/profile');
    nameEl.value = p.name || '';
    document.getElementById('settingsEnrollment').value = p.enrollment || '';
    const bannerEnrollEl = document.getElementById('stuBannerEnrollment');
    if(bannerEnrollEl) bannerEnrollEl.textContent = p.enrollment ? `Enrollment No. ${p.enrollment}` : '';
    document.getElementById('settingsEmail').value = p.email || '';
    document.getElementById('settingsMobile').value = p.mobile || '';
    document.getElementById('settingsWhatsapp').value = p.whatsapp_number || '';
    document.getElementById('settingsSemester').value = p.semester ? `Semester ${p.semester}` : '-';
    updateProfileHeader(p);
  }catch(err){
    console.error('Profile load error:', err.message);
  }
}

// Fills the sidebar-foot + topbar avatar/name/role from the real profile data
// (instead of the hardcoded "Shubham" / "Semester 5 · Student").
function stInitials(name){
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

function updateProfileHeader(p){
  const role = p.semester ? `Semester ${p.semester}${p.division ? ' · Div ' + p.division : ''}` : 'Student';
  const initial = stInitials(p.name);
  const nameEls = [document.getElementById('sidebarProfileName'), document.getElementById('profileMenuName')];
  nameEls.forEach(el => { if(el) el.textContent = p.name || 'Student'; });
  const roleEls = [document.getElementById('sidebarProfileRole'), document.getElementById('profileMenuRole')];
  roleEls.forEach(el => { if(el) el.textContent = role; });
  const initialEls = [document.getElementById('sidebarAvatarInitial'), document.getElementById('topbarAvatarInitial')];
  initialEls.forEach(el => { if(el) el.textContent = initial; });
  if (typeof updateChatGreetings === 'function') {
    updateChatGreetings(p.name);
  }
}

// ============================================================
// Topbar profile dropdown — only one dropdown stays open at a time,
// and it closes on clicking outside (same as the faculty panel)
// ============================================================
function closeAllMenus(){
  const menu = document.getElementById('profileMenu');
  if(menu) menu.classList.add('hidden');
}

function toggleProfileMenu(e){
  if(e) e.stopPropagation();
  const menu = document.getElementById('profileMenu');
  if(!menu) return;
  const wasHidden = menu.classList.contains('hidden');
  closeAllMenus();
  if(wasHidden) menu.classList.remove('hidden');
}

document.addEventListener('click', closeAllMenus);   // click outside the dropdown = close

// ============================================================
// Logout — clear token/name and send to the login page
// ============================================================
function logout(){
  if(!confirm('Log out?')) return;
  sessionStorage.removeItem('token_student');
  sessionStorage.removeItem('name_student');
  window.location.href = '../login_panel/login.html';
}

// ============================================================
// Topbar live search — from the real loaded data (subjects/timetable,
// notes, faculty directory). No new backend endpoint was added —
// it searches within the data already loaded on the page.
// ============================================================
function onTopbarSearch(){
  const box = document.getElementById('topbarSearchInput');
  const resultsEl = document.getElementById('topbarSearchResults');
  const q = box.value.trim().toLowerCase();
  if(!q){
    resultsEl.classList.remove('open');
    resultsEl.innerHTML = '';
    return;
  }

  const menuMatches = getMenuMatches(q);

  const subjectMap = new Map();
  stTT.slots.forEach(s => {
    if(s.subject_name) subjectMap.set(s.subject_name, s.subject_code || '');
  });
  const subjectMatches = [...subjectMap.entries()]
    .filter(([name, code]) => name.toLowerCase().includes(q) || (code || '').toLowerCase().includes(q))
    .slice(0, 5);

  const noteMatches = (stNotesData || []).filter(n =>
    (n.title || '').toLowerCase().includes(q) || (n.subject_name || '').toLowerCase().includes(q)
  ).slice(0, 5);

  const facultyMatches = (stFacultyData || []).filter(f =>
    (f.name || '').toLowerCase().includes(q) || (f.subjects_taught || '').toLowerCase().includes(q)
  ).slice(0, 5);

  if(!menuMatches.length && !subjectMatches.length && !noteMatches.length && !facultyMatches.length){
    resultsEl.innerHTML = '<div class="topbar-search-empty">Nothing found</div>';
    resultsEl.classList.add('open');
    return;
  }

  let html = menuSearchHtml(menuMatches);
  if(subjectMatches.length){
    html += '<div class="topbar-search-group">Subjects</div>';
    html += subjectMatches.map(([name, code]) => `
      <div class="topbar-search-row" onclick="goToSearchResult('timetable')">
        <span>📆 ${escapeHtml(name)}</span>
        <span>${escapeHtml(code || '')}</span>
      </div>`).join('');
  }
  if(noteMatches.length){
    html += '<div class="topbar-search-group">Notes</div>';
    html += noteMatches.map(n => `
      <div class="topbar-search-row" onclick="goToSearchResult('notes')">
        <span>📖 ${escapeHtml(n.title || 'Untitled')}</span>
        <span>${escapeHtml(n.subject_name || '')}</span>
      </div>`).join('');
  }
  if(facultyMatches.length){
    html += '<div class="topbar-search-group">Faculty</div>';
    html += facultyMatches.map(f => `
      <div class="topbar-search-row" onclick="goToSearchResult('faculty')">
        <span>👨‍🏫 ${escapeHtml(f.name)}</span>
        <span>${escapeHtml(f.subjects_taught || '')}</span>
      </div>`).join('');
  }
  resultsEl.innerHTML = html;
  resultsEl.classList.add('open');
}

// ============================================================
// Sidebar menu search — the header search box also finds sidebar
// titles (menu items / groups / sub-items); clicking a result opens it.
// ============================================================
let menuSearchItems = [];

function getMenuSearchItems(){
  const items = [];
  const clean = el => {
    const c = el.cloneNode(true);
    c.querySelectorAll('.ic, .chev, .nav-badge, .nav-unread-dot, ul').forEach(n => n.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  };
  const iconOf = el => { const ic = el.querySelector('.ic'); return ic ? ic.textContent.trim() : ''; };

  document.querySelectorAll('.sidebar .nav > .nav-item').forEach(el => {
    items.push({ type: 'item', el, label: clean(el), icon: iconOf(el), parent: '' });
  });
  document.querySelectorAll('.sidebar .nav-group').forEach(g => {
    const head = g.querySelector('.nav-group-head');
    if(!head) return;
    const title = clean(head);
    const icon = iconOf(head);
    items.push({ type: 'group', el: g, label: title, icon, parent: '' });
    g.querySelectorAll('.nav-sub-item').forEach(sub => {
      items.push({ type: 'sub', el: sub, label: clean(sub), icon, parent: title });
    });
  });
  return items;
}

function getMenuMatches(q){
  const needle = (q || '').trim().toLowerCase();
  if(!needle){ menuSearchItems = []; return menuSearchItems; }
  menuSearchItems = getMenuSearchItems().filter(it =>
    it.label.toLowerCase().includes(needle) ||
    (it.type === 'sub' && it.parent.toLowerCase().includes(needle))
  ).slice(0, 8);
  return menuSearchItems;
}

function goToMenuItem(i){
  const it = menuSearchItems[i];
  if(!it) return;
  closeTopbarSearch();
  if(it.type === 'group'){
    // Group title: expand that group in the sidebar (and open the drawer on mobile)
    document.querySelectorAll('.nav-group.open').forEach(g => { if(g !== it.el) g.classList.remove('open'); });
    it.el.classList.add('open');
    if(window.innerWidth <= 860) openSidebar();
    return;
  }
  if(it.type === 'sub'){
    const g = it.el.closest('.nav-group');
    if(g){
      document.querySelectorAll('.nav-group.open').forEach(o => { if(o !== g) o.classList.remove('open'); });
      g.classList.add('open');
    }
  }
  it.el.click();   // reuses the sidebar item's own handler (switchView, form open, mobile close…)
}

function menuSearchHtml(matches){
  if(!matches.length) return '';
  return '<div class="topbar-search-group">Menu</div>' + matches.map((it, i) => `
    <div class="topbar-search-row" onclick="goToMenuItem(${i})">
      <span>${it.icon ? it.icon + ' ' : ''}${escapeHtml(it.label)}</span>
      <span>${escapeHtml(it.parent)}</span>
    </div>`).join('');
}

function closeTopbarSearch(){
  const box = document.getElementById('topbarSearchInput');
  const resultsEl = document.getElementById('topbarSearchResults');
  if(box) box.value = '';
  if(resultsEl) resultsEl.classList.remove('open');
}

function goToSearchResult(view){
  closeTopbarSearch();
  switchView(view);
}

document.addEventListener('click', function(e){
  const wrap = document.querySelector('.search');
  if(wrap && !wrap.contains(e.target)) closeTopbarSearch();
});

async function saveStudentSettings(){
  const name = document.getElementById('settingsFullName').value.trim();
  const mobile = document.getElementById('settingsMobile').value.trim();
  const whatsapp = document.getElementById('settingsWhatsapp').value.trim();
  const currentPassword = document.getElementById('settingsCurrentPassword').value;
  const newPassword = document.getElementById('settingsNewPassword').value;
  const confirmPassword = document.getElementById('settingsConfirmPassword').value;

  if(!name){
    alert('Name cannot be empty');
    return;
  }
  if(mobile && !/^\d{10}$/.test(mobile)){
    alert('Mobile number must be 10 digits');
    return;
  }
  if(whatsapp && !/^\d{10,15}$/.test(whatsapp)){
    alert('WhatsApp number must be 10-15 digits (with country code if needed)');
    return;
  }

  try{
    await apiRequest('/student/profile', {
      method: 'PUT',
      body: JSON.stringify({ name, mobile: mobile || null, whatsapp_number: whatsapp || null })
    });
    sessionStorage.setItem('name_student', name);
    if(typeof renderStudentBanner === 'function') renderStudentBanner();

    // Update the password only when a New password has been filled in
    if(newPassword){
      if(!currentPassword){
        alert('Enter your current password to change it');
        return;
      }
      if(newPassword.length < 8){
        alert('New password must be at least 8 characters');
        return;
      }
      if(newPassword !== confirmPassword){
        alert('New password and confirm password do not match');
        return;
      }
      await apiRequest('/student/change-password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
      });
      document.getElementById('settingsCurrentPassword').value = '';
      document.getElementById('settingsNewPassword').value = '';
      document.getElementById('settingsConfirmPassword').value = '';
    }

    alert('Settings saved');
  }catch(err){
    alert('Save failed: ' + err.message);
  }
}

// Show/Hide password toggle (same as admin/faculty/login panels)
function toggleVis(id, btn){
  const input = document.getElementById(id);
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  btn.textContent = isPwd ? 'Hide' : 'Show';
}

// ---- Notice notifications / Attendance alerts preference (saved locally on this device) ----
function toggleNoticeNotif(){
  const t = document.getElementById('settingsNoticeNotif');
  if(!t) return;
  localStorage.setItem('stuNoticeNotif', t.checked ? '1' : '0');
}

function toggleAttendanceAlert(){
  const t = document.getElementById('settingsAttendanceAlert');
  if(!t) return;
  localStorage.setItem('stuAttendanceAlert', t.checked ? '1' : '0');
  if(stAttendanceLast) renderAttendanceAlert(stAttendanceLast);   // show / hide the alert right away
}

document.addEventListener('DOMContentLoaded', function(){
  const noticeT = document.getElementById('settingsNoticeNotif');
  if(noticeT){
    const saved = localStorage.getItem('stuNoticeNotif');
    noticeT.checked = saved === null ? true : saved === '1';   // default ON until the user changes it themselves
  }
  const attT = document.getElementById('settingsAttendanceAlert');
  if(attT){
    const saved = localStorage.getItem('stuAttendanceAlert');
    attT.checked = saved === null ? true : saved === '1';
  }
});

loadStudentProfile();

// ============================================================
// LIVE AUTO-REFRESH — page refresh kiye bina faculty/admin ke updates dikhne ke liye
// Har ST_REFRESH_MS par sab data chupchaap dobara fetch hota hai (sirf tab jab tab visible ho),
// aur tab/window par wapas aate hi turant. UI tabhi redraw hota hai jab data sach mein badla ho.
// ============================================================
const ST_REFRESH_MS = 20000;
let stLastBg = 0;
function stBackgroundRefresh(){
  if(document.hidden) return;
  if(Date.now() - stLastBg < 5000) return;   // focus + visibilitychange dono ek saath fire hon to double call na ho
  stLastBg = Date.now();
  refreshStudentTimetable(true);
  loadStudentAttendance(true);
  loadStudentResults(true);
  loadStudentAssignments(true);
  loadStudentNotes(true);
  loadStudentFaculty(true);
  loadStudentFees(true);
  pollStudentNotices();
}
setInterval(stBackgroundRefresh, ST_REFRESH_MS);
document.addEventListener('visibilitychange', () => { if(!document.hidden) stBackgroundRefresh(); });
window.addEventListener('focus', stBackgroundRefresh);