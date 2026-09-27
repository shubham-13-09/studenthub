if(!localStorage.getItem('token_student')){
  window.location.href = '../login_panel/login.html';
}

// ---- API helpers ----
const API_BASE = 'http://localhost:5000/api';

async function apiRequest(path, options = {}){
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + localStorage.getItem('token_student')
    }
  });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || res.status === 403){
    // token invalid/expired ya student nahi hai — wapas login bhej do
    localStorage.removeItem('token_student');
    window.location.href = '../login_panel/login.html';
    throw new Error(data.message || 'Unauthorized');
  }
  if(!res.ok){
    throw new Error(data.message || 'Request failed');
  }
  return data;
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
    if(name === 'timetable' || name === 'Home') refreshStudentTimetable();
    if(name === 'notes') loadStudentNotes();
    if(name === 'assignments') loadStudentAssignments();
    if(name === 'fees') loadStudentFees();
    if(name === 'attendance') loadStudentAttendance();
    if(name === 'results') loadStudentResults();
    if(name === 'notices') markStudentNoticesSeen();
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
    document.getElementById('popup').classList.toggle('hidden');
  }

  // ---- Chat send (backend-connected — /student/assistant) ----
  async function sendChat(inputId, logId){
    const input = document.getElementById(inputId);
    const text = input.value.trim();
    if(!text) return;
    const log = document.getElementById(logId);
    log.insertAdjacentHTML('beforeend', `<div class="msg user">${escapeHtml(text)}</div>`);
    input.value = '';
    log.scrollTop = log.scrollHeight;
    const typingId = 'typing-' + Date.now();
    log.insertAdjacentHTML('beforeend', `<div class="msg bot" id="${typingId}">…</div>`);
    log.scrollTop = log.scrollHeight;
    try{
      const data = await apiRequest('/student/assistant', {
        method: 'POST',
        body: JSON.stringify({ message: text })
      });
      const el = document.getElementById(typingId);
      if(el) el.innerHTML = escapeHtml(data.reply || '...').replace(/\n/g, '<br>');
    }catch(err){
      const el = document.getElementById(typingId);
      if(el) el.textContent = 'Response could not be loaded, try again.';
    }
    log.scrollTop = log.scrollHeight;
  }

  // Dashboard "Ask StudentHub" card + suggestion tags — floating popup hi actual chat surface hai,
  // dashboard card se bheja gaya sawal usi popup me khulta/dikhta hai
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
// Weekly grid (desktop) / din-wise tabs (mobile) / Home "Today's timetable" / exam cards
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
function stDetail(slot){
  return [slot.room_no || 'Room TBA', stFacultyLabel(slot)].filter(Boolean).join(' · ');
}
function stSlotsOfDay(day){
  return stTT.slots.filter(s => s.day_of_week === day).sort((a, b) => stMin(a.start_time) - stMin(b.start_time));
}

// ---- Load ----
async function refreshStudentTimetable(force){
  if(!force && Date.now() - stLastFetch < 30000) { renderStudentTimetable(); return; }
  stLastFetch = Date.now();
  renderStudentBanner();
  const [ttRes, exRes] = await Promise.allSettled([
    apiRequest('/student/timetable'),
    apiRequest('/student/exam-timetable')
  ]);
  if(ttRes.status === 'fulfilled'){
    stTT = { student: ttRes.value.student || null, slots: ttRes.value.slots || [] };
    stTTError = '';
  }else{
    stTTError = ttRes.reason && ttRes.reason.message ? ttRes.reason.message : 'Request failed';
    stLastFetch = 0;
  }
  if(exRes.status === 'fulfilled') stExams = exRes.value.exams || [];
  renderStudentTimetable();
}

function renderStudentTimetable(){
  renderStudentBanner();
  renderStudentHomeToday();
  renderStudentWeekTable();
  renderStudentDayView();
  renderStudentExams();
  renderStudentMidExamStat();
}
// Now/Next highlight update hota rahe (har minute cache se dobara draw)
setInterval(renderStudentTimetable, 60000);

// ---- Banner (naam + semester + division) ----
function renderStudentBanner(){
  const nameEl = document.getElementById('stuBannerName');
  const eyebrowEl = document.getElementById('stuBannerEyebrow');
  if(!nameEl || !eyebrowEl) return;
  const fullName = (localStorage.getItem('name_student') || 'Student').trim();
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

// ---- Din ke lectures ki list (Home + mobile day view) ----
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
      <div class="tt-row${isNow ? ' now' : ''}${isDone ? ' done' : ''}">
        <div class="tt-bar ${bars[i % 3]}"></div>
        <div class="tt-time"><b>${stFmt(l.start_time)}</b><span>${stFmt(l.end_time)}</span></div>
        <div class="tt-info"><b>${stEsc(l.subject_name || 'Lecture')}</b><span>${stEsc(stDetail(l))}</span></div>
        ${isNow ? '<span class="tt-now-pill">Now</span>' : ''}
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

  // Chip: abhi kaun si chal rahi hai / agli kab hai
  const nowMin = stNowMin();
  const ongoing = list.find(l => stMin(l.start_time) <= nowMin && nowMin < stMin(l.end_time));
  const next = list.find(l => stMin(l.start_time) > nowMin);
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
  const nowMin = stNowMin();

  const seen = new Map();
  slots.forEach(s => seen.set(s.start_time + '-' + s.end_time, { start: s.start_time, end: s.end_time }));
  const ranges = [...seen.values()].sort((a, b) => stMin(a.start) - stMin(b.start));

  const before = ranges.some(r => stMin(r.start) < ST_LUNCH_START);
  const after = ranges.some(r => stMin(r.start) >= ST_LUNCH_END);
  const rows = [];
  let lunchAdded = false;
  ranges.forEach(r => {
    if(before && after && !lunchAdded && stMin(r.start) >= ST_LUNCH_END){ rows.push({ lunch: true }); lunchAdded = true; }
    rows.push(r);
  });

  let html = `<tr><th>Time</th>${days.map(d => `<th class="${d === today ? 'tt-today' : ''}">${ST_DAY_FULL[d]}</th>`).join('')}</tr>`;
  rows.forEach(r => {
    if(r.lunch){
      html += `<tr class="tt-lunch"><td colspan="${days.length + 1}">🍽 Lunch break · 1:30 PM – 2:00 PM</td></tr>`;
      return;
    }
    html += `<tr><td class="tt-slot-time">${stFmt(r.start)} – ${stFmt(r.end)}</td>`;
    days.forEach(d => {
      const here = slots.filter(s => s.day_of_week === d && s.start_time === r.start && s.end_time === r.end);
      const isToday = d === today;
      const isNow = isToday && stMin(r.start) <= nowMin && nowMin < stMin(r.end);
      const cls = `${isToday ? 'tt-today' : ''}${isNow && here.length ? ' tt-now' : ''}`.trim();
      html += here.length
        ? `<td class="${cls}">${here.map(l => `<div class="tt-cell"><b>${stEsc(l.subject_name || 'Lecture')}</b><span>${stEsc(stDetail(l))}</span></div>`).join('')}</td>`
        : `<td class="${cls}"><span class="tt-none">—</span></td>`;
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

// Exam aaj se kitne din baad hai (negative = ho chuka)
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

// Home stat card: agla Mid-Sem exam kitne din baad hai
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

// Page khulte hi load
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

async function loadStudentNotes(){
  const grid = document.getElementById('notesGrid');
  if(!grid) return;
  try{
    const data = await apiRequest('/student/materials');
    stNotesData = data.materials || [];
    populateNotesSubjectFilter();
    renderStudentNotes();
  }catch(err){
    grid.innerHTML = `<div class="tt-msg">Materials could not be loaded: ${escapeHtml(err.message)}</div>`;
  }
}

// Sirf wahi subjects dropdown me dikhao jinka kam se kam ek material ho
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

  // Subject-wise groups: pehli baar jis order me subject aaya, wahi order rakha (extra sort nahi)
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

// id se hi kaam karta hai (title/filename me quotes/apostrophe hone par onclick tootta nahi)
async function downloadStudentMaterial(id){
  const note = stNotesData.find(x => x.id === id);
  const fileName = note ? note.file_name : `material-${id}`;
  try{
    const res = await fetch(API_BASE + `/student/materials/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_student') }
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

async function loadStudentAssignments(){
  const tbody = document.getElementById('assignmentsTableBody');
  try{
    const data = await apiRequest('/student/assignments');
    stAssignmentsData = data.assignments || [];
    if(tbody) renderStudentAssignments();
    updatePendingAssignmentsStat();
  }catch(err){
    if(tbody) tbody.innerHTML = `<tr><td colspan="5">Assignments could not be loaded: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// Dashboard "Pending assignments" stat card — real count nikalta hai, hardcoded nahi.
// Un-submitted assignments count hote hain (chahe due date nikal gayi ho ya na), kyunki
// dono cases me student ko abhi bhi action lena hai.
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

async function loadStudentFees(){
  const tbody = document.getElementById('feesTableBody');
  if(tbody) tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try{
    const data = await apiRequest('/student/fees');
    const fees = data.fees || [];
    updatePendingFeeStat(fees);
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

// Dashboard "Fee status" stat card — amount ki jagah fee ka title + status dikhata hai
// (jo bhi fee sabse pehle due hai). Ek se zyada pending hone par "+N more" bhi jud jaata hai.
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

// id se hi kaam karta hai (title/filename me quotes/apostrophe hone par onclick tootta nahi)
async function downloadStudentAssignment(id){
  const assignment = stAssignmentsData.find(x => x.id === id);
  const fileName = assignment ? assignment.problem_file_name : `assignment-${id}`;
  try{
    const res = await fetch(API_BASE + `/student/assignments/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_student') }
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
// Admin/Faculty hi attendance mark karte hain (`attendance` table);
// student ke liye yeh sirf subject-wise summary dikhata hai, wahi
// jaisa logic Admin ke attendance/summary aur Faculty ke students
// list me % nikaalne ke liye use hota hai.
// ============================================================
function stAttendanceStatus(pct){
  if(pct < 75) return { label: 'Below 75%', cls: 'bad' };
  if(pct < 90) return { label: 'Good', cls: 'warn' };
  return { label: 'Excellent', cls: 'good' };
}

async function loadStudentAttendance(){
  try{
    const data = await apiRequest('/student/attendance');
    renderStudentAttendance(data.subjects || []);
    renderAttendanceDashboardStat(data.overall_percentage || 0);
  }catch(err){
    const tbody = document.getElementById('attendanceTableBody');
    if(tbody) tbody.innerHTML = `<tr><td colspan="5">Attendance could not be loaded: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderStudentAttendance(subjects){
  const tbody = document.getElementById('attendanceTableBody');
  if(!tbody) return;
  if(!subjects.length){
    tbody.innerHTML = '<tr><td colspan="5">No attendance has been recorded for your class yet.</td></tr>';
    return;
  }

  tbody.innerHTML = subjects.map(s => {
    const status = stAttendanceStatus(s.percentage);
    return `
      <tr>
        <td>${escapeHtml(s.subject_name)}</td>
        <td>${s.total_classes}</td>
        <td>${s.attended_classes}</td>
        <td>${s.percentage}%</td>
        <td><span class="pill ${status.cls}">${status.label}</span></td>
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
// Faculty marks bharta hai -> Admin approve karta hai -> Admin
// publish karta hai; student ko sirf published marks dikhte hain.
// ============================================================
const ST_EXAM_COLUMNS = ['Mid-Semester', 'Remedial', 'Internal', 'Practical'];

// Jis exam ke marks published hain sirf uska pill banta hai — us exam ka apna
// pass/fail bhi wahi passing_percentage se decide hota hai jo overall status me use hoti hai.
function stExamCell(exam, passingPct){
  if(!exam) return '—';
  const pct = exam.marks_obtained * 100 / exam.max_marks;
  const cls = pct >= passingPct ? 'pass' : 'fail';
  return `<span class="pill ${cls}">${exam.marks_obtained}/${exam.max_marks}</span>`;
}

async function loadStudentResults(){
  const tbody = document.getElementById('resultsTableBody');
  try{
    const data = await apiRequest('/student/results');
    renderStudentResults(data.subjects || [], data.passing_percentage);
  }catch(err){
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
// Admin/Faculty hi notices post/edit/pin/delete karte hain;
// student sirf apni class ki broadcast notices + apni personal
// notices dekhta hai — "All notices" page ab Admin/Faculty jaisa
// hi WhatsApp-style feed hai (received-card, menu/edit/pin nahi
// kyunki student notice create nahi karta), unread badge/mark-read
// bhi Faculty panel jaisa hi.
// ============================================================
let stNoticesData = [];
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

// Admin/Faculty ke nfFileChip jaisa hi — 📎 icon + filename + size, click pe download
function stNoticeFileChip(n){
  if(!n.file_name) return '';
  return `<div class="nf-file" onclick="stNoticeAction('download', ${n.id})" title="Download">📎 <span class="nf-file-name">${escapeHtml(n.file_name)}</span>${n.file_size ? ` <small>${nfFileSize(n.file_size)}</small>` : ''}</div>`;
}

// Card ke buttons id se kaam karte hain (title/filename me quotes/apostrophe hone par
// onclick attribute tootta nahi) — Admin/Faculty ke nfFacAction jaisa hi pattern.
function stNoticeAction(action, id){
  const n = stNoticesData.find(x => x.id === id);
  if(!n) return;
  if(action === 'download') downloadStudentNotice(id, n.file_name);
}

// Admin/Faculty ke nfFacReceivedCard jaisa hi — student ke liye "received" card
function stNoticeCard(n){
  const tagCls = n.is_personal ? '' : stNoticeTagClass(n.category);
  const scope = stNoticeScope(n);
  return `
    <div class="nf-card ${tagCls ? 'nf-cat-' + tagCls : ''}">
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
    stNoticesData = data.notices || [];
    renderHomeNotices();
    renderAllNotices();
    renderNoticesBadge();
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

// Admin/Faculty ke nfRenderFeed jaisa hi — pinned/date dividers ke saath poori feed
function renderAllNotices(){
  const container = document.getElementById('allNoticesContainer');
  if(!container) return;
  if(!stNoticesData.length){
    container.innerHTML = '<div class="nf-empty">No notices yet.</div>';
    return;
  }
  let html = '';
  let lastLabel = null;
  stNoticesData.forEach(n => {
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
    // silent fail — badge visible rehna harmful nahi hai
  }
}

async function downloadStudentNotice(id, fileName){
  try{
    const res = await fetch(API_BASE + `/student/notices/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_student') }
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
// Sirf woh faculty dikhte hain jo is student ke apne semester/
// division ke subjects padhate hain (Admin ke get_faculty jaisa
// hi data, bas apni class ke hisaab se filtered).
// "Message" ke liye poore project me koi chat/DM system nahi hai
// (Admin/Faculty panel me bhi nahi) — isliye button mailto: link
// banata hai (faculty ke email se), koi naya backend feature nahi.
// ============================================================
function stFacInitials(name){
  const words = (name || '').replace(/^Prof\.?\s*/i, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

let stFacultyData = [];

async function loadStudentFaculty(){
  const grid = document.getElementById('facultyGrid');
  try{
    const data = await apiRequest('/student/faculty');
    stFacultyData = data.faculty || [];
    if(grid) renderStudentFaculty(stFacultyData);
  }catch(err){
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
    const msgBtn = f.email
      ? `<a class="fac-msg" href="mailto:${escapeHtml(f.email)}" style="text-decoration:none; display:inline-block; text-align:center;">Message</a>`
      : '';
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
    document.getElementById('settingsSemester').value = p.semester ? `Semester ${p.semester}` : '-';
    updateProfileHeader(p);
  }catch(err){
    console.error('Profile load error:', err.message);
  }
}

// Sidebar-foot + topbar avatar/name/role ko real profile data se bharta hai
// (hardcoded "Shubham" / "Semester 5 · Student" ki jagah).
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
}

// ============================================================
// Topbar profile dropdown — ek waqt me ek dropdown khula rahe,
// bahar click karne pe band ho jaaye (faculty panel jaisa hi)
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

document.addEventListener('click', closeAllMenus);   // dropdown ke bahar click = band

// ============================================================
// Logout — token/name clear karke login page pe bhej do
// ============================================================
function logout(){
  if(!confirm('Log out?')) return;
  localStorage.removeItem('token_student');
  localStorage.removeItem('name_student');
  window.location.href = '../login_panel/login.html';
}

// ============================================================
// Topbar live search — real loaded data se (subjects/timetable,
// notes, faculty directory). Naya backend endpoint nahi banaya —
// jo data already page pe load ho chuka hai usi me se dhoondta hai.
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

  if(!subjectMatches.length && !noteMatches.length && !facultyMatches.length){
    resultsEl.innerHTML = '<div class="topbar-search-empty">Nothing found</div>';
    resultsEl.classList.add('open');
    return;
  }

  let html = '';
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

  try{
    await apiRequest('/student/profile', {
      method: 'PUT',
      body: JSON.stringify({ name, mobile: mobile || null })
    });
    localStorage.setItem('name_student', name);
    if(typeof renderStudentBanner === 'function') renderStudentBanner();

    // Password sirf tabhi update karo jab New password bhara ho
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
}

document.addEventListener('DOMContentLoaded', function(){
  const noticeT = document.getElementById('settingsNoticeNotif');
  if(noticeT){
    const saved = localStorage.getItem('stuNoticeNotif');
    noticeT.checked = saved === null ? true : saved === '1';   // default ON jab tak user khud badle nahi
  }
  const attT = document.getElementById('settingsAttendanceAlert');
  if(attT){
    const saved = localStorage.getItem('stuAttendanceAlert');
    attT.checked = saved === null ? true : saved === '1';
  }
});

loadStudentProfile();