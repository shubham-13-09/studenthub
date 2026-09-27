if(!localStorage.getItem('token_faculty')){
  window.location.href = '../login_panel/login.html';
}

// ---- API helpers ----
const API_BASE = 'http://localhost:5000/api';

function authHeaders(){
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + localStorage.getItem('token_faculty')
  };
}

async function apiRequest(path, options = {}){
  const res = await fetch(API_BASE + path, { ...options, headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || res.status === 403){
    // token invalid/expired ya faculty nahi hai — wapas login bhej do
    localStorage.removeItem('token_faculty');
    window.location.href = '../login_panel/login.html';
    throw new Error(data.message || 'Unauthorized');
  }
  if(!res.ok){
    throw new Error(data.message || 'Request failed');
  }
  return data;
}

// File upload ke liye — yahan Content-Type header manually set NAHI karte,
// browser khud multipart boundary ke saath set karta hai (FormData body)
async function apiUpload(path, formData){
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_faculty') },
    body: formData
  });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || res.status === 403){
    localStorage.removeItem('token_faculty');
    window.location.href = '../login_panel/login.html';
    throw new Error(data.message || 'Unauthorized');
  }
  if(!res.ok){
    throw new Error(data.message || 'Upload failed');
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
  if(name === 'notices') markFacultyNoticesRead();
  // My Subjects card se "attendance" pe aaye ho aur ek subject-context pending hai (openClass ne set kiya),
  // to filters + student list turant usi subject ke hisaab se load karo
  if(name === 'attendance' && window.selectedSubjectContext) populateAttendanceClassSelect();
}

// ---- Subject card click -> jump to a class-context view (attendance/students/etc) ----
function openClass(view, subject){
  window.selectedSubjectContext = subject || null;
  switchView(view);
}

// ---- My Subjects (loaded from backend) ----
let cachedSubjects = [];   // faculty ke assigned subjects (My Subjects + Students dropdown dono yahan se use karte hain)
let cachedAllDivisions = [];   // faculty ke semester+batch combos ke real divisions (students table se) — "All divisions" assignments ke liye bhi filter me kaam aata hai

async function loadMySubjects(){
  const grid = document.getElementById('subjectGrid');
  const empty = document.getElementById('subjectGridEmpty');
  try{
    const data = await apiRequest('/faculty/my-subjects');
    cachedSubjects = data.subjects || [];
    cachedAllDivisions = data.divisions || [];
    renderDashboardMySubjects();
    populateStudentsFilters();
    populateStudentsClassSelect();
    populateAttendanceFilters();
    populateAttendanceClassSelect();
    populateMarksFilters();
    populateMarksClassSelect();
    populateFeesFilters();
    populateMaterialsFilters();
    populateMaterialsClassSelect();
    populateFacultyAssignmentFilters();
    populateFacultyAssignmentSubjectSelect();
    loadFacultyAssignments();
    populateFacultyNoticeSubjectSelect();
    if(!grid) return;
    grid.querySelectorAll('.subject-card').forEach(el => el.remove());
    if(cachedSubjects.length === 0){
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    cachedSubjects.forEach(sub => {
      const divLabel = sub.division || 'All';
      const tagClass = sub.division === 'A' ? 'mint' : (sub.division === 'B' ? 'amber' : 'mint');
      const card = document.createElement('div');
      card.className = 'subject-card';
      card.onclick = () => openClass('attendance', sub);
      card.innerHTML = `
        <div class="subject-card-top"><span class="subj-tag ${tagClass}">Sem ${sub.semester} · Division ${divLabel}</span><span class="subj-more">⋯</span></div>
        <b>${escapeHtml(sub.subject_name)}</b>
        <span class="subject-card-sub">${sub.student_count} students · ${sub.avg_attendance}% avg attendance</span>
      `;
      grid.appendChild(card);
    });
  }catch(err){
    if(empty){
      empty.textContent = 'Subjects could not be loaded. Refresh the page and try again.';
      empty.style.display = 'block';
    }
  }
}
document.addEventListener('DOMContentLoaded', loadMySubjects);
document.addEventListener('DOMContentLoaded', loadFacultyNotices);
document.addEventListener('DOMContentLoaded', loadMyMarksRequests);
document.addEventListener('DOMContentLoaded', loadFacultyTimetable);
document.addEventListener('DOMContentLoaded', loadFacultyDashboardSummary);
document.addEventListener('DOMContentLoaded', renderDashboardBanner);
document.addEventListener('DOMContentLoaded', refreshFacultyNoticeDot);
document.addEventListener('DOMContentLoaded', loadFacultyProfile);
setInterval(refreshFacultyNoticeDot, 45000);   // naya notice aane par bhi dot dikhta rahe, bina page reload kiye

let cachedFacultyNotices = [];

async function loadFacultyNotices(){
  const receivedList = document.getElementById('facultyNoticesList');
  const postedList = document.getElementById('facultyPostedNoticesList');
  if(!receivedList) return;
  try{
    const data = await apiRequest('/faculty/notices');
    cachedFacultyNotices = data.notices || [];
    populateFacultyNoticeSubjectSelect();
    renderFacultyNoticeLists();
  }catch(err){
    receivedList.innerHTML = '<div class="notice-row" style="border-bottom:none;">Notices could not be loaded.</div>';
    if(postedList) postedList.innerHTML = '<div class="notice-row" style="border-bottom:none;">Notices could not be loaded.</div>';
  }
}

// ============================================================
// NOTICE FEED (WhatsApp-inspired cards) — shared helpers
// ============================================================
function nfEsc(s){
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

function nfFileChip(n, onclickCode){
  return `<div class="nf-file" onclick="${onclickCode}" title="Download">📎 <span class="nf-file-name">${nfEsc(n.file_name)}</span>${n.file_size ? ` <small>${nfFileSize(n.file_size)}</small>` : ''}</div>`;
}

// List pehle se is_pinned DESC, created_at DESC aati hai — pinned ek "📌 Pinned" divider ke neeche, baaki date ke hisab se
function nfRenderFeed(notices, cardFn){
  let html = '';
  let lastLabel = null;
  notices.forEach(n => {
    const label = n.is_pinned ? '📌 Pinned' : nfDateLabel(n.created_at);
    if(label !== lastLabel){
      html += `<div class="nf-divider${n.is_pinned ? ' pinned' : ''}">${nfEsc(label)}</div>`;
      lastLabel = label;
    }
    html += cardFn(n);
  });
  return `<div class="nf-feed">${html}</div>`;
}

function nfToggleMenu(btn, ev){
  ev.stopPropagation();
  const menu = btn.closest('.nf-menu');
  const wasOpen = menu.classList.contains('open');
  document.querySelectorAll('.nf-menu.open').forEach(m => m.classList.remove('open'));
  if(!wasOpen) menu.classList.add('open');
}
document.addEventListener('click', () => {
  document.querySelectorAll('.nf-menu.open').forEach(m => m.classList.remove('open'));
});

function nfToggleBody(el){ el.classList.toggle('expanded'); }

const NF_CAT_CLASS = { Academic: '', Event: 'event', Important: 'urgent' };

function nfFacScope(n){
  return [n.semester ? 'Sem ' + n.semester : '', n.division ? 'Div ' + n.division : ''].filter(Boolean).join(' · ');
}

// Faculty ki apni post ki hui notice — right side "sent bubble" + ✓ / ✓✓ ticks
function nfFacSentCard(n){
  const tagCls = NF_CAT_CLASS[n.category] || '';
  const scope = nfFacScope(n) || 'All classes';
  const seen = (n.seen_count || 0) > 0 || n.admin_seen;
  return `
    <div class="nf-card sent">
      <div class="nf-top">
        <span class="notice-tag ${tagCls}">${nfEsc(n.category || 'Academic')}</span>
        <span class="nf-scope">${nfEsc(scope)}</span>
        <div class="nf-menu">
          <button class="nf-menu-btn" onclick="nfToggleMenu(this, event)" title="More">⋯</button>
          <div class="nf-menu-list">
            <button onclick="nfFacAction('reads', ${n.id})">👁 Seen by</button>
            <button onclick="nfFacAction('pin', ${n.id})">${n.is_pinned ? '📌 Unpin' : '📍 Pin'}</button>
            <button onclick="nfFacAction('edit', ${n.id})">✎ Edit</button>
            <button class="danger" onclick="nfFacAction('delete', ${n.id})">🗑 Delete</button>
          </div>
        </div>
      </div>
      <div class="nf-title">${nfEsc(n.title)}</div>
      ${n.content ? `<div class="nf-body" onclick="nfToggleBody(this)">${nfEsc(n.content)}</div>` : ''}
      ${n.file_name ? nfFileChip(n, `nfFacAction('download', ${n.id})`) : ''}
      <div class="nf-meta">
        ${n.admin_seen ? '<span class="nf-admin-pill" title="Admin has seen this notice">Admin seen</span>' : ''}
        <span>${nfTime(n.created_at)}</span>
        <button class="nf-ticks ${seen ? 'seen' : ''}" onclick="nfFacAction('reads', ${n.id})" title="Seen by">${seen ? '✓✓ ' + (n.seen_count || 0) : '✓ Sent'}</button>
      </div>
    </div>`;
}

// Admin se aayi / personal notice — left side "received" card
function nfFacReceivedCard(n){
  const tagCls = n.is_personal ? '' : (NF_CAT_CLASS[n.category] || '');
  const scope = nfFacScope(n);
  return `
    <div class="nf-card received ${tagCls ? 'nf-cat-' + tagCls : ''}">
      <div class="nf-top">
        <span class="notice-tag ${tagCls}">${n.is_personal ? 'For you' : nfEsc(n.category || 'Academic')}</span>
        ${scope ? `<span class="nf-scope">${nfEsc(scope)}</span>` : ''}
      </div>
      <div class="nf-title">${nfEsc(n.title)}</div>
      ${n.content ? `<div class="nf-body" onclick="nfToggleBody(this)">${nfEsc(n.content)}</div>` : ''}
      ${n.file_name ? nfFileChip(n, `nfFacAction('download', ${n.id})`) : ''}
      <div class="nf-meta"><span>${nfTime(n.created_at)}</span></div>
    </div>`;
}

// Card ke saare buttons id se kaam karte hain (title me quotes hone par onclick tootta nahi)
function nfFacAction(action, id){
  const n = cachedFacultyNotices.find(x => x.id === id);
  if(!n) return;
  if(action === 'reads') openFacultyNoticeReads(id, n.title);
  else if(action === 'pin') toggleFacultyNoticePin(id, !n.is_pinned);
  else if(action === 'edit') editFacultyNotice(n);
  else if(action === 'delete') deleteFacultyNotice(id, n.title);
  else if(action === 'download') downloadFacultyNotice(id, n.file_name);
}

function renderFacultyNoticeLists(){
  const receivedList = document.getElementById('facultyNoticesList');
  const postedList = document.getElementById('facultyPostedNoticesList');

  const posted = cachedFacultyNotices.filter(n => n.can_manage);
  const received = cachedFacultyNotices.filter(n => !n.can_manage);

  postedList.innerHTML = posted.length ? nfRenderFeed(posted, nfFacSentCard) : '<div class="nf-empty">You have not posted any notice yet.</div>';

  receivedList.innerHTML = received.length ? nfRenderFeed(received, nfFacReceivedCard) : '<div class="nf-empty">No notices yet.</div>';
}

// ---- Notice "seen by" modal (admin panel jaisa) ----
async function openFacultyNoticeReads(noticeId, title){
  document.getElementById('facNoticeReadsTitle').textContent = `Seen — ${title}`;
  document.getElementById('facNoticeReadsSummary').textContent = '-';
  document.getElementById('facNoticeReadsOverlay').classList.add('open');
  const body = document.getElementById('facNoticeReadsBody');
  body.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';

  try{
    const data = await apiRequest(`/faculty/notices/${noticeId}/reads`);
    document.getElementById('facNoticeReadsSummary').textContent = `${data.seen_count} of ${data.target_total} seen`;
    body.innerHTML = data.seen_by.length ? data.seen_by.map(r => `
      <tr>
        <td>${escapeHtml(r.name)}${r.role === 'admin' ? ' <span class="notice-tag" style="margin:0;">Admin</span>' : ''}</td>
        <td>${escapeHtml(r.login_id)}</td>
        <td>${new Date(r.seen_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      </tr>
    `).join('') : '<tr><td colspan="3">No one has viewed this yet.</td></tr>';
  }catch(err){
    body.innerHTML = `<tr><td colspan="3">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function closeFacultyNoticeReads(){
  document.getElementById('facNoticeReadsOverlay').classList.remove('open');
}

function timeAgo(dateStr){
  if(!dateStr) return '';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if(mins < 60) return mins <= 1 ? 'just now' : `${mins} mins ago`;
  const hrs = Math.floor(mins / 60);
  if(hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

// ---- Students (class list for one assigned subject) ----
function uniqueSorted(arr, key){
  return [...new Set(arr.map(x => x[key]).filter(v => v !== null && v !== undefined && v !== ''))].sort();
}

function populateStudentsFilters(){
  const yearSelect = document.getElementById('studentsFilterYear');
  if(!yearSelect) return;
  const semSelect = document.getElementById('studentsFilterSem');
  const divSelect = document.getElementById('studentsFilterDiv');

  const prevYear = yearSelect.value, prevSem = semSelect.value, prevDiv = divSelect.value;

  const years = uniqueSorted(cachedSubjects, 'academic_year');
  const sems = uniqueSorted(cachedSubjects, 'semester');
  const divs = cachedAllDivisions;   // real divisions (students table se) — "All divisions" wale subjects ke andar ki asli divisions bhi shaamil

  yearSelect.innerHTML = '<option value="">All batches</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  semSelect.innerHTML = '<option value="">All semesters</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  divSelect.innerHTML = '<option value="">All divisions</option>' + divs.map(d => `<option value="${d}">Division ${d}</option>`).join('');

  if(years.includes(prevYear)) yearSelect.value = prevYear;
  if(sems.map(String).includes(prevSem)) semSelect.value = prevSem;
  if(divs.includes(prevDiv)) divSelect.value = prevDiv;
}

function onStudentsFilterChange(){
  populateStudentsClassSelect();
}

function populateStudentsClassSelect(){
  const select = document.getElementById('studentsClassSelect');
  if(!select) return;
  const prevValue = select.value;

  const yearFilter = document.getElementById('studentsFilterYear').value;
  const semFilter = document.getElementById('studentsFilterSem').value;
  const divFilter = document.getElementById('studentsFilterDiv').value;

  // "All divisions" (sub.division khali) wale subjects hamesha dikhte hain — Division filter unhe hide nahi karta,
  // kyunki unke andar hi har division ke students aate hain (backend divFilter se unhe aage narrow kar dega)
  const filteredSubjects = cachedSubjects.filter(sub =>
    (!yearFilter || sub.academic_year === yearFilter) &&
    (!semFilter || String(sub.semester) === semFilter) &&
    (!divFilter || !sub.division || sub.division === divFilter)
  );

  select.innerHTML = '<option value="">Select subject</option>';
  filteredSubjects.forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub.assignment_id;
    opt.textContent = `${sub.subject_name} · Sem ${sub.semester} · Division ${sub.division || 'All'}`;
    select.appendChild(opt);
  });

  if(prevValue && filteredSubjects.some(s => String(s.assignment_id) === prevValue)){
    select.value = prevValue;
    loadFacultyStudents();   // divFilter badla ho sakta hai — list ko us naye division ke hisaab se dobara load karo
  } else {
    loadFacultyStudents();   // pehle ki selection ab valid nahi rahi (filter narrow ho gaya) — list clear karo
  }
}

function attendancePillClass(pct){
  if(pct >= 85) return 'good';
  if(pct >= 75) return 'warn';
  return 'bad';
}

let cachedFacultyStudents = [];   // currently loaded class ke students — search box isi list ko filter karta hai

async function loadFacultyStudents(){
  const select = document.getElementById('studentsClassSelect');
  const empty = document.getElementById('studentsEmpty');
  const assignmentId = select.value;
  const divFilter = document.getElementById('studentsFilterDiv').value;

  cachedFacultyStudents = [];
  document.getElementById('studentsSearch').value = '';

  if(!assignmentId){
    renderFacultyStudentsRows();
    empty.textContent = 'Select a class above.';
    empty.style.display = 'block';
    return;
  }

  empty.textContent = 'Loading...';
  empty.style.display = 'block';

  try{
    let url = '/faculty/students?assignment_id=' + encodeURIComponent(assignmentId);
    if(divFilter) url += '&division=' + encodeURIComponent(divFilter);
    const data = await apiRequest(url);
    cachedFacultyStudents = data.students || [];
    if(cachedFacultyStudents.length === 0){
      empty.textContent = 'There are no students in this class yet.';
      empty.style.display = 'block';
      return;
    }
    renderFacultyStudentsRows();
  }catch(err){
    empty.textContent = 'Students could not be loaded. Try again.';
    empty.style.display = 'block';
  }
}

// Search box ke hisaab se list filter karke dikhata hai (data reload nahi karta, sirf render)
function renderFacultyStudentsRows(){
  const table = document.querySelector('#view-students table');
  const empty = document.getElementById('studentsEmpty');
  const search = (document.getElementById('studentsSearch').value || '').trim().toLowerCase();

  table.querySelectorAll('tr:not(:first-child)').forEach(row => row.remove());

  if(cachedFacultyStudents.length === 0){
    return;   // "select a class" / "loading" / error message empty div me already set hai
  }

  const filtered = cachedFacultyStudents.filter(s =>
    !search || s.name.toLowerCase().includes(search) || String(s.enrollment).toLowerCase().includes(search)
  );

  if(filtered.length === 0){
    empty.textContent = 'No student found.';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  filtered.forEach(s => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(s.enrollment)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.semester ?? '-'}</td>
      <td>${s.division || '-'}</td>
      <td>${s.academic_year || '-'}</td>
      <td><span class="pill ${attendancePillClass(s.attendance_pct)}">${s.attendance_pct}%</span></td>
      <td>${s.avg_marks}</td>
    `;
    table.appendChild(row);
  });
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

// ---- Submission notifications preference (saved locally on this device) ----
function toggleSubmissionNotif(){
  const t = document.getElementById('settingsSubmissionNotif');
  if(!t) return;
  localStorage.setItem('facSubmissionNotif', t.checked ? '1' : '0');
}
document.addEventListener('DOMContentLoaded', function(){
  const t = document.getElementById('settingsSubmissionNotif');
  if(!t) return;
  const saved = localStorage.getItem('facSubmissionNotif');
  t.checked = saved === null ? true : saved === '1';   // default ON jab tak user khud badle nahi
});

// ---- Attendance marking (backend-connected) ----
document.addEventListener('click', function(e){
  const btn = e.target.closest('.att-btn');
  if(!btn) return;
  const row = btn.closest('.att-toggle');
  row.querySelectorAll('.att-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
});

function markAll(present){
  document.querySelectorAll('#attendanceList .att-toggle').forEach(row=>{
    row.querySelectorAll('.att-btn').forEach(b => b.classList.remove('active'));
    const target = row.querySelector(present ? '.att-btn.present' : '.att-btn.absent');
    if(target) target.classList.add('active');
  });
}

// Default date = today
(function setDefaultAttendanceDate(){
  const dateInput = document.getElementById('attDate');
  if(dateInput && !dateInput.value){
    dateInput.value = new Date().toISOString().slice(0, 10);
  }
})();

function populateAttendanceFilters(){
  const yearSelect = document.getElementById('attFilterYear');
  if(!yearSelect) return;
  const semSelect = document.getElementById('attFilterSem');
  const divSelect = document.getElementById('attFilterDiv');

  const prevYear = yearSelect.value, prevSem = semSelect.value, prevDiv = divSelect.value;

  const years = uniqueSorted(cachedSubjects, 'academic_year');
  const sems = uniqueSorted(cachedSubjects, 'semester');
  const divs = cachedAllDivisions;   // real divisions (students table se) — "All divisions" wale subjects ke andar ki asli divisions bhi shaamil

  yearSelect.innerHTML = '<option value="">All batches</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  semSelect.innerHTML = '<option value="">All semesters</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  divSelect.innerHTML = '<option value="">All divisions</option>' + divs.map(d => `<option value="${d}">Division ${d}</option>`).join('');

  if(years.includes(prevYear)) yearSelect.value = prevYear;
  if(sems.map(String).includes(prevSem)) semSelect.value = prevSem;
  if(divs.includes(prevDiv)) divSelect.value = prevDiv;
}

function onAttendanceFilterChange(){
  populateAttendanceClassSelect();
}

function populateAttendanceClassSelect(){
  const select = document.getElementById('attClassSelect');
  if(!select) return;
  const prevValue = select.value;

  const yearFilter = document.getElementById('attFilterYear').value;
  const semFilter = document.getElementById('attFilterSem').value;
  const divFilter = document.getElementById('attFilterDiv').value;

  // "All divisions" (sub.division khali) wale subjects hamesha dikhte hain — Division filter unhe hide nahi karta,
  // kyunki unke andar hi har division ke students aate hain (backend divFilter se unhe aage narrow kar dega)
  const filteredSubjects = cachedSubjects.filter(sub =>
    (!yearFilter || sub.academic_year === yearFilter) &&
    (!semFilter || String(sub.semester) === semFilter) &&
    (!divFilter || !sub.division || sub.division === divFilter)
  );

  select.innerHTML = '<option value="">Select subject</option>';
  filteredSubjects.forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub.assignment_id;
    opt.textContent = `${sub.subject_name} · Sem ${sub.semester} · Division ${sub.division || 'All'}`;
    select.appendChild(opt);
  });

  // Agar My Subjects card se aaye ho (openClass context), wahi class auto-select karo
  if(window.selectedSubjectContext){
    const ctx = window.selectedSubjectContext;
    window.selectedSubjectContext = null;
    document.getElementById('attFilterYear').value = ctx.academic_year || '';
    document.getElementById('attFilterSem').value = ctx.semester || '';
    document.getElementById('attFilterDiv').value = ctx.division || '';
    populateAttendanceClassSelect();   // filters change ho gaye, dropdown dobara filtered options ke saath banao
    select.value = ctx.assignment_id;
    loadFacultyAttendance();
    return;
  }

  if(prevValue && filteredSubjects.some(s => String(s.assignment_id) === prevValue)){
    select.value = prevValue;
    loadFacultyAttendance();   // divFilter badla ho sakta hai — list ko us naye division ke hisaab se dobara load karo
  } else {
    loadFacultyAttendance();   // pehle ki selection ab valid nahi rahi — list clear karo
  }
}

let cachedAttendanceAssignmentId = null;   // currently loaded class ki assignment_id — save karte waqt isi ko bhejte hain

async function loadFacultyAttendance(){
  const select = document.getElementById('attClassSelect');
  const dateInput = document.getElementById('attDate');
  const list = document.getElementById('attendanceList');
  const empty = document.getElementById('attendanceEmpty');
  const title = document.getElementById('attClassTitle');
  const assignmentId = select.value;
  const date = dateInput.value;
  const divFilter = document.getElementById('attFilterDiv').value;

  cachedAttendanceAssignmentId = null;
  list.innerHTML = '';

  if(!assignmentId || !date){
    title.textContent = 'Select a subject and date';
    empty.textContent = 'Select a class and date above.';
    empty.style.display = 'block';
    return;
  }

  const sub = cachedSubjects.find(s => String(s.assignment_id) === assignmentId);
  const effectiveDivision = (sub && sub.division) || divFilter || 'All';
  title.textContent = sub
    ? `Division ${effectiveDivision} · ${sub.subject_name}`
    : 'Attendance';

  empty.textContent = 'Loading...';
  empty.style.display = 'block';

  try{
    let url = '/faculty/attendance?assignment_id=' + encodeURIComponent(assignmentId) + '&date=' + encodeURIComponent(date);
    // divFilter sirf tab kaam karta hai jab assignment khud "All divisions" ho — specific-division assignment isse ignore karega
    if(divFilter) url += '&division=' + encodeURIComponent(divFilter);

    const data = await apiRequest(url);
    const students = data.students || [];
    if(students.length === 0){
      empty.textContent = 'There are no students in this class yet.';
      empty.style.display = 'block';
      return;
    }
    cachedAttendanceAssignmentId = assignmentId;
    empty.style.display = 'none';
    if(sub) title.textContent = `Division ${effectiveDivision} · ${sub.subject_name} · ${students.length} students`;
    list.innerHTML = students.map((s, i) => `
      <div class="att-row" data-student-id="${s.student_id}">
        <span class="att-enrollment">${escapeHtml(s.enrollment || '')}</span>
        <span class="att-name">${escapeHtml(s.name)}</span>
        <span class="att-sem">${s.semester ?? '-'}</span>
        <span class="att-div">${s.division || '-'}</span>
        <span class="att-batch">${s.academic_year || '-'}</span>
        <div class="att-toggle">
          <button class="att-btn present ${s.status === 'present' ? 'active' : ''}">Present</button>
          <button class="att-btn absent ${s.status === 'absent' ? 'active' : ''}">Absent</button>
        </div>
      </div>
    `).join('');
  }catch(err){
    empty.textContent = 'Attendance could not be loaded. Try again.';
    empty.style.display = 'block';
  }
}

async function saveFacultyAttendance(){
  const dateInput = document.getElementById('attDate');
  const saveBtn = document.getElementById('attSaveBtn');
  const date = dateInput.value;

  if(!cachedAttendanceAssignmentId || !date){
    alert('Select a subject and date first.');
    return;
  }

  const records = [];
  document.querySelectorAll('#attendanceList .att-row').forEach(row => {
    const studentId = row.dataset.studentId;
    const activeBtn = row.querySelector('.att-btn.active');
    if(!activeBtn) return;   // is student ka status abhi set nahi kiya
    records.push({
      student_id: studentId,
      status: activeBtn.classList.contains('present') ? 'present' : 'absent'
    });
  });

  if(records.length === 0){
    alert("Set at least one student's status.");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  try{
    await apiRequest('/faculty/attendance', {
      method: 'POST',
      body: JSON.stringify({ assignment_id: cachedAttendanceAssignmentId, date, records })
    });
    alert('Attendance saved.');
  }catch(err){
    alert('Attendance could not be saved: ' + err.message);
  }finally{
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save attendance';
  }
}

// ---- Floating chat popup ----
function togglePopup(){
  document.getElementById('popup').classList.toggle('hidden');
}

// ---- Chat send (backend-connected — /faculty/assistant) ----
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
    const data = await apiRequest('/faculty/assistant', {
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

// ---- Marks entry (backend-connected) ----
function populateMarksFilters(){
  const yearSelect = document.getElementById('marksFilterYear');
  if(!yearSelect) return;
  const semSelect = document.getElementById('marksFilterSem');
  const divSelect = document.getElementById('marksFilterDiv');

  const prevYear = yearSelect.value, prevSem = semSelect.value, prevDiv = divSelect.value;

  const years = uniqueSorted(cachedSubjects, 'academic_year');
  const sems = uniqueSorted(cachedSubjects, 'semester');
  const divs = cachedAllDivisions;   // real divisions (students table se) — "All divisions" wale subjects ke andar ki asli divisions bhi shaamil

  yearSelect.innerHTML = '<option value="">All batches</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  semSelect.innerHTML = '<option value="">All semesters</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  divSelect.innerHTML = '<option value="">All divisions</option>' + divs.map(d => `<option value="${d}">Division ${d}</option>`).join('');

  if(years.includes(prevYear)) yearSelect.value = prevYear;
  if(sems.map(String).includes(prevSem)) semSelect.value = prevSem;
  if(divs.includes(prevDiv)) divSelect.value = prevDiv;
}

function onMarksFilterChange(){
  populateMarksClassSelect();
}

function populateMarksClassSelect(){
  const select = document.getElementById('marksClassSelect');
  if(!select) return;
  const prevValue = select.value;

  const yearFilter = document.getElementById('marksFilterYear').value;
  const semFilter = document.getElementById('marksFilterSem').value;
  const divFilter = document.getElementById('marksFilterDiv').value;

  // "All divisions" (sub.division khali) wale subjects hamesha dikhte hain — Division filter unhe hide nahi karta,
  // kyunki unke andar hi har division ke students aate hain (backend divFilter se unhe aage narrow kar dega)
  const filteredSubjects = cachedSubjects.filter(sub =>
    (!yearFilter || sub.academic_year === yearFilter) &&
    (!semFilter || String(sub.semester) === semFilter) &&
    (!divFilter || !sub.division || sub.division === divFilter)
  );

  select.innerHTML = '<option value="">Select subject</option>';
  filteredSubjects.forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub.assignment_id;
    opt.textContent = `${sub.subject_name} · Sem ${sub.semester} · Division ${sub.division || 'All'}`;
    select.appendChild(opt);
  });

  if(prevValue && filteredSubjects.some(s => String(s.assignment_id) === prevValue)){
    select.value = prevValue;
  }
  loadFacultyMarks();
}

let cachedMarksAssignmentId = null;   // currently loaded class ki assignment_id — save karte waqt isi ko bhejte hain
let cachedMarksRequestStatus = null;  // currently loaded exam ki latest request status — null/pending/approved/rejected/published
let cachedMarksDivision = null;       // currently loaded division ("All divisions" assignment ke liye upar chuni gayi division) — save karte waqt bhejte hain

let cachedMarksRequests = [];   // My submissions list — row click se class open karne ke liye cache karte hain

async function loadMyMarksRequests(){
  const list = document.getElementById('myMarksRequestsList');
  if(!list) return;
  try{
    const data = await apiRequest('/faculty/marks/requests');
    const requests = data.requests || [];
    cachedMarksRequests = requests;
    if(requests.length === 0){
      list.innerHTML = '<div style="color:var(--muted); font-size:12.5px;">No marks submitted yet.</div>';
      return;
    }
    list.innerHTML = requests.map((r, i) => {
      const info = MARKS_STATUS_INFO[r.status] || { bg: '#eee', color: '#555', text: r.status };
      let extra = r.status === 'rejected' && r.remarks ? ` — ${escapeHtml(r.remarks)}` : '';
      return `
        <div class="marks-request-row" style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line, #eee); font-size:12.5px; cursor:pointer;" onclick="openMarksRequestRow(${i})">
          <span>${escapeHtml(r.subject_name)} · ${escapeHtml(r.exam_type)} · Sem ${r.semester} / ${r.division || 'All'} · ${escapeHtml(r.academic_year || '-')}</span>
          <span style="padding:3px 10px; border-radius:12px; background:${info.bg}; color:${info.color}; font-weight:600; white-space:nowrap;">
            ${r.status.charAt(0).toUpperCase() + r.status.slice(1)}${extra}
          </span>
        </div>
      `;
    }).join('');
  }catch(err){
    list.innerHTML = '<div style="color:red; font-size:12.5px;">Could not be loaded.</div>';
  }
}

// "My submissions" me kisi notice pe click -> neeche ke filters usi class ke hisaab se lag jaate hain
// aur wahi subject/exam khul jaata hai (My Subjects card jaise openClass() jaisa hi pattern)
function openMarksRequestRow(i){
  const r = cachedMarksRequests[i];
  if(!r) return;

  const matchedSub = cachedSubjects.find(sub =>
    sub.subject_name === r.subject_name &&
    String(sub.semester) === String(r.semester) &&
    sub.academic_year === r.academic_year &&
    (sub.division === r.division || !sub.division)
  );

  document.getElementById('marksFilterYear').value = r.academic_year || '';
  document.getElementById('marksFilterSem').value = r.semester != null ? String(r.semester) : '';
  document.getElementById('marksFilterDiv').value = r.division || '';
  document.getElementById('marksExamType').value = r.exam_type || 'Mid-Semester';
  if(r.max_marks) document.getElementById('marksMaxMarks').value = r.max_marks;

  populateMarksClassSelect();   // filters ke hisaab se dropdown dobara banega

  if(matchedSub){
    document.getElementById('marksClassSelect').value = matchedSub.assignment_id;
  }
  loadFacultyMarks();

  document.querySelector('#view-marks .card:not(#myMarksRequestsCard)')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const MARKS_STATUS_INFO = {
  pending:   { text: "⏳ Pending — awaiting admin review. Can't be edited now.", bg: '#fff8e1', color: '#8a6d00' },
  approved:  { text: "✅ Approved — awaiting admin publish. Can't be edited now.", bg: '#e8f5e9', color: '#2e7d32' },
  published: { text: '🔒 Published — visible to students. Only Admin can edit it now.', bg: '#e3f2fd', color: '#1565c0' },
  rejected:  { text: '❌ Rejected — edit below and resubmit.', bg: '#ffebee', color: '#c0392b' }
};

async function loadFacultyMarks(){
  const select = document.getElementById('marksClassSelect');
  const examSelect = document.getElementById('marksExamType');
  const maxMarksInput = document.getElementById('marksMaxMarks');
  const table = document.getElementById('marksTable');
  const tbody = document.getElementById('marksTableBody');
  const colHead = document.getElementById('marksColHead');
  const empty = document.getElementById('marksEmpty');
  const title = document.getElementById('marksClassTitle');
  const banner = document.getElementById('marksStatusBanner');
  const saveBtn = document.getElementById('marksSaveBtn');
  const assignmentId = select.value;
  const examType = examSelect.value;
  const maxMarks = maxMarksInput.value;
  const divFilter = document.getElementById('marksFilterDiv').value;

  cachedMarksAssignmentId = null;
  cachedMarksRequestStatus = null;
  cachedMarksDivision = null;
  tbody.innerHTML = '';
  table.style.display = 'none';
  banner.style.display = 'none';
  saveBtn.style.display = '';
  saveBtn.textContent = 'Submit for approval';

  if(!assignmentId || !examType){
    title.textContent = 'Select a subject and exam';
    empty.textContent = 'Select a class and exam above.';
    empty.style.display = 'block';
    return;
  }

  const sub = cachedSubjects.find(s => String(s.assignment_id) === assignmentId);
  const divLabel = sub ? (sub.division || divFilter || 'All') : '';
  title.textContent = sub
    ? `Division ${divLabel} · ${sub.subject_name} · ${examType} (out of ${maxMarks})`
    : 'Marks entry';

  empty.textContent = 'Loading...';
  empty.style.display = 'block';

  try{
    let url = '/faculty/marks?assignment_id=' + encodeURIComponent(assignmentId) + '&exam_type=' + encodeURIComponent(examType);
    // "All divisions" wale assignment ke liye upar chuni gayi division backend ko bhejo, taaki sirf usi division ke
    // students aur unki request-status sahi tarah se load ho (jaise Students/Attendance tabs me hota hai)
    if(divFilter) url += '&division=' + encodeURIComponent(divFilter);
    const data = await apiRequest(url);
    const students = data.students || [];
    if(students.length === 0){
      empty.textContent = 'There are no students in this class yet.';
      empty.style.display = 'block';
      return;
    }
    cachedMarksAssignmentId = assignmentId;
    cachedMarksRequestStatus = data.request_status;   // null | pending | approved | rejected | published
    cachedMarksDivision = sub && sub.division ? sub.division : (divFilter || null);
    empty.style.display = 'none';
    colHead.textContent = `Marks (/${maxMarks})`;
    if(sub) title.textContent = `Division ${divLabel} · ${sub.subject_name} · ${examType} (out of ${maxMarks}) · ${students.length} students`;

    const isLocked = ['pending', 'approved', 'published'].includes(data.request_status);
    if(data.request_status && MARKS_STATUS_INFO[data.request_status]){
      const info = MARKS_STATUS_INFO[data.request_status];
      let text = info.text;
      if(data.request_status === 'rejected' && data.remarks) text += ` (Reason: ${escapeHtml(data.remarks)})`;
      banner.textContent = text;
      banner.style.background = info.bg;
      banner.style.color = info.color;
      banner.style.display = 'block';
    }
    saveBtn.style.display = isLocked ? 'none' : '';

    tbody.innerHTML = students.map(s => `
      <tr data-student-id="${s.student_id}">
        <td>${escapeHtml(s.enrollment)}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${s.semester ?? '-'}</td>
        <td>${s.division || '-'}</td>
        <td>${s.academic_year || '-'}</td>
        <td><input type="number" class="marks-input" value="${s.marks_obtained ?? ''}" max="${maxMarks}" min="0" ${isLocked ? 'disabled' : ''}></td>
      </tr>
    `).join('');
    table.style.display = '';
  }catch(err){
    empty.textContent = 'Marks could not be loaded. Try again.';
    empty.style.display = 'block';
  }
}

async function saveFacultyMarks(){
  const examSelect = document.getElementById('marksExamType');
  const maxMarksInput = document.getElementById('marksMaxMarks');
  const saveBtn = document.getElementById('marksSaveBtn');
  const examType = examSelect.value;
  const maxMarks = maxMarksInput.value;

  if(!cachedMarksAssignmentId || !examType || !maxMarks){
    alert('Select a subject, exam and max marks first.');
    return;
  }
  if(['pending', 'approved', 'published'].includes(cachedMarksRequestStatus)){
    alert('A request for this exam is already ' + cachedMarksRequestStatus + " — can't resubmit right now.");
    return;
  }

  const records = [];
  let invalid = false;
  document.querySelectorAll('#marksTableBody tr').forEach(row => {
    const studentId = row.dataset.studentId;
    const input = row.querySelector('.marks-input');
    const val = input.value.trim();
    if(val === '') return;   // is student ka marks abhi nahi bhara
    const num = Number(val);
    if(isNaN(num) || num < 0 || num > Number(maxMarks)){
      invalid = true;
      input.style.borderColor = 'red';
      return;
    }
    input.style.borderColor = '';
    records.push({ student_id: studentId, marks_obtained: num });
  });

  if(invalid){
    alert('Some marks are below 0 or above max marks — check those rows.');
    return;
  }
  if(records.length === 0){
    alert('Fill in marks for at least one student.');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Submitting...';
  try{
    await apiRequest('/faculty/marks', {
      method: 'POST',
      body: JSON.stringify({ assignment_id: cachedMarksAssignmentId, exam_type: examType, max_marks: maxMarks, division: cachedMarksDivision, records })
    });
    alert('Marks submitted to admin for review.');
    loadFacultyMarks();      // status banner + locked state dobara load karo
    loadMyMarksRequests();   // "My submissions" list bhi refresh karo
  }catch(err){
    alert('Marks could not be submitted: ' + err.message);
  }finally{
    saveBtn.disabled = false;
    saveBtn.textContent = 'Submit for approval';
  }
}

// ============================================================
// FEES ENTRY (assigned class ke fee records — sirf status paid/unpaid toggle karte hain;
// fee item/amount/due date/payment link Admin ke control me hi rehta hai)
// ============================================================
function populateFeesFilters(){
  const yearSelect = document.getElementById('feesFilterYear');
  if(!yearSelect) return;
  const semSelect = document.getElementById('feesFilterSem');
  const divSelect = document.getElementById('feesFilterDiv');

  const prevYear = yearSelect.value, prevSem = semSelect.value, prevDiv = divSelect.value;

  const years = uniqueSorted(cachedSubjects, 'academic_year');
  const sems = uniqueSorted(cachedSubjects, 'semester');
  const divs = cachedAllDivisions;

  yearSelect.innerHTML = '<option value="">Select batch</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  semSelect.innerHTML = '<option value="">Select semester</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  divSelect.innerHTML = '<option value="">All divisions</option>' + divs.map(d => `<option value="${d}">Division ${d}</option>`).join('');

  if(years.includes(prevYear)) yearSelect.value = prevYear;
  if(sems.map(String).includes(prevSem)) semSelect.value = prevSem;
  if(divs.includes(prevDiv)) divSelect.value = prevDiv;
}

function onFeesFilterChange(){
  loadFacultyFees();
}

let cachedFeesContext = null;   // { semester, academic_year, division } jis list ke fee records abhi load hain — save karte waqt isi ko bhejte hain

async function loadFacultyFees(){
  const yearSelect = document.getElementById('feesFilterYear');
  const semSelect = document.getElementById('feesFilterSem');
  const divSelect = document.getElementById('feesFilterDiv');
  const table = document.getElementById('feesTable');
  const tbody = document.getElementById('feesTableBody');
  const empty = document.getElementById('feesEmpty');
  const title = document.getElementById('feesClassTitle');
  const saveBtn = document.getElementById('feesSaveBtn');

  const academicYear = yearSelect.value;
  const semester = semSelect.value;
  const division = divSelect.value;

  cachedFeesContext = null;
  tbody.innerHTML = '';
  table.style.display = 'none';
  saveBtn.style.display = '';

  if(!academicYear || !semester){
    title.textContent = 'Select a batch and semester';
    empty.textContent = 'Select a batch and semester above.';
    empty.style.display = 'block';
    return;
  }

  title.textContent = `Sem ${semester} · ${academicYear} · Division ${division || 'All'}`;
  empty.textContent = 'Loading...';
  empty.style.display = 'block';

  try{
    let url = '/faculty/fees?semester=' + encodeURIComponent(semester) + '&academic_year=' + encodeURIComponent(academicYear);
    if(division) url += '&division=' + encodeURIComponent(division);
    const data = await apiRequest(url);
    const fees = data.fees || [];
    if(fees.length === 0){
      empty.textContent = "Admin hasn't set up any fee item for this class yet.";
      empty.style.display = 'block';
      saveBtn.style.display = 'none';
      return;
    }
    cachedFeesContext = { semester, academic_year: academicYear, division: division || null };
    empty.style.display = 'none';
    title.textContent = `Sem ${semester} · ${academicYear} · Division ${division || 'All'} · ${fees.length} records`;
    tbody.innerHTML = fees.map(f => `
      <tr data-fee-id="${f.fee_id}">
        <td>${escapeHtml(f.enrollment || '')}</td>
        <td>${escapeHtml(f.name)}</td>
        <td>${f.semester ?? '-'}</td>
        <td>${f.division || '-'}</td>
        <td>${f.academic_year || '-'}</td>
        <td>${escapeHtml(f.fee_title || '-')}</td>
        <td>₹${f.amount ?? '-'}</td>
        <td>
          <select class="status-select">
            <option value="paid" ${f.status === 'paid' ? 'selected' : ''}>Paid</option>
            <option value="unpaid" ${f.status === 'unpaid' ? 'selected' : ''}>Unpaid</option>
          </select>
        </td>
      </tr>
    `).join('');
    table.style.display = '';
  }catch(err){
    empty.textContent = 'Fees could not be loaded. Try again.';
    empty.style.display = 'block';
    saveBtn.style.display = 'none';
  }
}

async function saveFacultyFees(){
  const saveBtn = document.getElementById('feesSaveBtn');
  if(!cachedFeesContext){
    alert('Select a batch and semester first.');
    return;
  }

  const updates = [];
  document.querySelectorAll('#feesTableBody tr').forEach(row => {
    updates.push({
      fee_id: row.dataset.feeId,
      status: row.querySelector('.status-select').value
    });
  });

  if(updates.length === 0) return;

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  try{
    await apiRequest('/faculty/fees', {
      method: 'POST',
      body: JSON.stringify({ ...cachedFeesContext, updates })
    });
    saveBtn.textContent = 'Saved ✓';
    setTimeout(() => { saveBtn.textContent = 'Save changes'; saveBtn.disabled = false; }, 1200);
  }catch(err){
    alert('Fee status could not be saved: ' + err.message);
    saveBtn.textContent = 'Save changes';
    saveBtn.disabled = false;
  }
}

// ============================================================
// MATERIALS (assigned subject ke study materials — Admin ke `notes` table se shared;
// upload/edit/delete sirf apne khud ke upload kiye hue materials pe milta hai)
// ============================================================
function formatFileSize(bytes){
  if(!bytes) return '-';
  if(bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fileIcon(type){
  if(type === 'pdf') return '📕';
  if(type === 'doc' || type === 'docx') return '📘';
  if(type === 'ppt' || type === 'pptx') return '📙';
  return '📄';
}

function populateMaterialsFilters(){
  const yearSelect = document.getElementById('matFilterYear');
  if(!yearSelect) return;
  const semSelect = document.getElementById('matFilterSem');
  const divSelect = document.getElementById('matFilterDiv');

  const prevYear = yearSelect.value, prevSem = semSelect.value, prevDiv = divSelect.value;

  const years = uniqueSorted(cachedSubjects, 'academic_year');
  const sems = uniqueSorted(cachedSubjects, 'semester');
  const divs = cachedAllDivisions;

  yearSelect.innerHTML = '<option value="">All batches</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  semSelect.innerHTML = '<option value="">All semesters</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  divSelect.innerHTML = '<option value="">All divisions</option>' + divs.map(d => `<option value="${d}">Division ${d}</option>`).join('');

  if(years.includes(prevYear)) yearSelect.value = prevYear;
  if(sems.map(String).includes(prevSem)) semSelect.value = prevSem;
  if(divs.includes(prevDiv)) divSelect.value = prevDiv;
}

function onMaterialsFilterChange(){
  populateMaterialsClassSelect();
}

function populateMaterialsClassSelect(){
  const select = document.getElementById('matClassSelect');
  if(!select) return;
  const prevValue = select.value;

  const yearFilter = document.getElementById('matFilterYear').value;
  const semFilter = document.getElementById('matFilterSem').value;
  const divFilter = document.getElementById('matFilterDiv').value;

  const filteredSubjects = cachedSubjects.filter(sub =>
    (!yearFilter || sub.academic_year === yearFilter) &&
    (!semFilter || String(sub.semester) === semFilter) &&
    (!divFilter || !sub.division || sub.division === divFilter)
  );

  select.innerHTML = '<option value="">Select subject</option>';
  filteredSubjects.forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub.assignment_id;
    opt.textContent = `${sub.subject_name} · Sem ${sub.semester} · Division ${sub.division || 'All'}`;
    select.appendChild(opt);
  });

  if(prevValue && filteredSubjects.some(s => String(s.assignment_id) === prevValue)){
    select.value = prevValue;
  }
  loadFacultyMaterials();
}

let cachedMaterialsAssignmentId = null;   // currently loaded class ki assignment_id — upload karte waqt isi ko bhejte hain
let cachedMaterialsDivision = null;       // "All divisions" assignment ke liye upar chuni gayi division — upload me bhejte hain
let cachedMaterialsList = [];             // currently loaded subject ke saare materials (search filter isi pe chalti hai)

async function loadFacultyMaterials(){
  const select = document.getElementById('matClassSelect');
  const list = document.getElementById('materialsList');
  const empty = document.getElementById('materialsEmpty');
  const title = document.getElementById('matClassTitle');
  const toggleBtn = document.getElementById('matToggleUploadBtn');
  const searchWrap = document.getElementById('matSearchWrap');
  const searchInput = document.getElementById('matSearchTitle');
  const assignmentId = select.value;
  const divFilter = document.getElementById('matFilterDiv').value;

  cachedMaterialsAssignmentId = null;
  cachedMaterialsDivision = null;
  cachedMaterialsList = [];
  list.innerHTML = '';
  toggleBtn.style.display = 'none';
  searchWrap.style.display = 'none';
  searchInput.value = '';
  toggleMaterialUploadForm(false);

  if(!assignmentId){
    title.textContent = 'Select a subject';
    empty.textContent = 'Select a subject above.';
    empty.style.display = 'block';
    return;
  }

  const sub = cachedSubjects.find(s => String(s.assignment_id) === assignmentId);
  const divLabel = sub ? (sub.division || divFilter || 'All') : '';
  title.textContent = sub ? `Division ${divLabel} · ${sub.subject_name}` : 'Materials';

  empty.textContent = 'Loading...';
  empty.style.display = 'block';

  try{
    let url = '/faculty/materials?assignment_id=' + encodeURIComponent(assignmentId);
    if(divFilter) url += '&division=' + encodeURIComponent(divFilter);
    const data = await apiRequest(url);
    const materials = data.materials || [];

    cachedMaterialsAssignmentId = assignmentId;
    cachedMaterialsDivision = (sub && sub.division) || divFilter || null;
    cachedMaterialsList = materials;
    toggleBtn.style.display = '';

    if(materials.length === 0){
      searchWrap.style.display = 'none';
      empty.textContent = 'No material has been uploaded for this subject yet.';
      empty.style.display = 'block';
      return;
    }
    searchWrap.style.display = '';
    title.textContent = `Division ${divLabel} · ${sub.subject_name} · ${materials.length} files`;
    renderFacultyMaterials(materials);
  }catch(err){
    searchWrap.style.display = 'none';
    empty.textContent = 'Materials could not be loaded. Try again.';
    empty.style.display = 'block';
  }
}

function renderFacultyMaterials(materials){
  const list = document.getElementById('materialsList');
  const empty = document.getElementById('materialsEmpty');

  if(materials.length === 0){
    list.innerHTML = '';
    empty.textContent = 'No material found with this title.';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = materials.map(m => `
    <div class="notice-row">
      <b>${fileIcon(m.file_type)} ${escapeHtml(m.title)}</b>
      <span style="display:flex; align-items:center; gap:10px;">
        <span>${escapeHtml(m.file_name || '')} · ${formatFileSize(m.file_size)} · ${timeAgo(m.uploaded_at)} · Uploaded by ${escapeHtml(m.uploaded_by)}</span>
        <span class="row-actions">
          <button class="icon-action" onclick="downloadFacultyMaterial(${m.id}, '${(m.file_name || '').replace(/'/g, "\\'")}')" title="Download">⬇</button>
          ${m.can_manage ? `<button class="icon-action" onclick='openMaterialEdit(${JSON.stringify({id: m.id, title: m.title, description: m.description})})' title="Edit">✎</button>` : ''}
          ${m.can_manage ? `<button class="icon-action danger" onclick="deleteFacultyMaterial(${m.id})" title="Delete">🗑</button>` : ''}
        </span>
      </span>
    </div>
  `).join('');
}

function filterFacultyMaterials(){
  const query = document.getElementById('matSearchTitle').value.trim().toLowerCase();
  if(!query){
    renderFacultyMaterials(cachedMaterialsList);
    return;
  }
  const filtered = cachedMaterialsList.filter(m => (m.title || '').toLowerCase().includes(query));
  renderFacultyMaterials(filtered);
}

function toggleMaterialUploadForm(show){
  const card = document.getElementById('matUploadCard');
  const shouldShow = show === undefined ? card.style.display === 'none' : show;
  card.style.display = shouldShow ? '' : 'none';
  if(!shouldShow){
    document.getElementById('matTitle').value = '';
    document.getElementById('matDescription').value = '';
    document.getElementById('matFile').value = '';
  }
}

async function uploadFacultyMaterial(){
  const uploadBtn = document.getElementById('matUploadBtn');
  const title = document.getElementById('matTitle').value.trim();
  const description = document.getElementById('matDescription').value.trim();
  const fileInput = document.getElementById('matFile');
  const file = fileInput.files[0];

  if(!cachedMaterialsAssignmentId){
    alert('Select a subject first.');
    return;
  }
  if(!title || !file){
    alert('Title and file are both required.');
    return;
  }

  const formData = new FormData();
  formData.append('assignment_id', cachedMaterialsAssignmentId);
  formData.append('title', title);
  if(description) formData.append('description', description);
  if(cachedMaterialsDivision) formData.append('division', cachedMaterialsDivision);
  formData.append('file', file);

  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading...';
  try{
    await apiUpload('/faculty/materials', formData);
    toggleMaterialUploadForm(false);
    loadFacultyMaterials();
  }catch(err){
    alert('Upload failed: ' + err.message);
  }finally{
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload';
  }
}

function openMaterialEdit(m){
  document.getElementById('matEditId').value = m.id;
  document.getElementById('matEditTitle').value = m.title || '';
  document.getElementById('matEditDescription').value = m.description || '';
  document.getElementById('matEditOverlay').classList.add('open');
}
function closeMaterialEdit(){
  document.getElementById('matEditOverlay').classList.remove('open');
}
async function saveMaterialEdit(){
  const id = document.getElementById('matEditId').value;
  const title = document.getElementById('matEditTitle').value.trim();
  const description = document.getElementById('matEditDescription').value.trim();
  if(!title){
    alert('Title is required.');
    return;
  }
  try{
    await apiRequest(`/faculty/materials/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ title, description })
    });
    closeMaterialEdit();
    loadFacultyMaterials();
  }catch(err){
    alert('Update failed: ' + err.message);
  }
}

async function deleteFacultyMaterial(id){
  if(!confirm('Delete this material?')) return;
  try{
    await apiRequest(`/faculty/materials/${id}`, { method: 'DELETE' });
    loadFacultyMaterials();
  }catch(err){
    alert('Delete failed: ' + err.message);
  }
}

async function downloadFacultyMaterial(id, fileName){
  try{
    const res = await fetch(API_BASE + `/faculty/materials/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_faculty') }
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
// ASSIGNMENTS (apni assigned subjects ki assignments — Add/Edit/Delete sirf khud
// banayi hui assignment pe milta hai, aur ek baar submission aane ke baad
// us assignment ko edit nahi kiya ja sakta — sirf submissions/marks review ho sakti hai)
// ============================================================
let cachedFacultyAssignments = [];

function populateFacultyAssignmentFilters(){
  const semSelect = document.getElementById('facAssignFilterSem');
  if(!semSelect) return;
  const subjSelect = document.getElementById('facAssignFilterSubject');
  const divSelect = document.getElementById('facAssignFilterDiv');
  const yearSelect = document.getElementById('facAssignFilterYear');

  const prevSem = semSelect.value, prevSubj = subjSelect.value, prevDiv = divSelect.value, prevYear = yearSelect.value;

  const sems = uniqueSorted(cachedSubjects, 'semester');
  const years = uniqueSorted(cachedSubjects, 'academic_year');
  const seenSubjects = new Map();
  cachedSubjects.forEach(s => { if(!seenSubjects.has(s.subject_id)) seenSubjects.set(s.subject_id, s.subject_name); });

  semSelect.innerHTML = '<option value="">All semesters</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  subjSelect.innerHTML = '<option value="">All subjects</option>' +
    [...seenSubjects.entries()].map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
  divSelect.innerHTML = '<option value="">All divisions</option>' + cachedAllDivisions.map(d => `<option value="${d}">Division ${d}</option>`).join('');
  yearSelect.innerHTML = '<option value="">All batches</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');

  if(sems.map(String).includes(prevSem)) semSelect.value = prevSem;
  if(prevSubj && [...seenSubjects.keys()].map(String).includes(prevSubj)) subjSelect.value = prevSubj;
  if(cachedAllDivisions.includes(prevDiv)) divSelect.value = prevDiv;
  if(years.includes(prevYear)) yearSelect.value = prevYear;
}

function onFacultyAssignmentFilterChange(){
  loadFacultyAssignments();
}

function populateFacultyAssignmentSubjectSelect(){
  const select = document.getElementById('facAssignSubject');
  if(!select) return;
  select.innerHTML = cachedSubjects.map(sub =>
    `<option value="${sub.assignment_id}">${escapeHtml(sub.subject_name)} · Sem ${sub.semester} · Division ${sub.division || 'All'} · ${sub.academic_year}</option>`
  ).join('') || '<option value="">No subject assigned</option>';
  onFacAssignSubjectChange();
}

function onFacAssignSubjectChange(){
  const select = document.getElementById('facAssignSubject');
  const divField = document.getElementById('facAssignDivisionField');
  const divSelect = document.getElementById('facAssignDivision');
  if(!select || !select.value){
    divField.style.display = 'none';
    return;
  }
  const sub = cachedSubjects.find(s => String(s.assignment_id) === select.value);
  if(sub && !sub.division){
    // "All divisions" wala subject hai — faculty chahe to ek specific division choose kar sakta hai
    divField.style.display = '';
    divSelect.innerHTML = '<option value="">All divisions</option>' +
      cachedAllDivisions.map(d => `<option value="${d}">Division ${d}</option>`).join('');
  }else{
    divField.style.display = 'none';
    divSelect.value = '';
  }
}

function openAddFacultyAssignmentForm(){
  resetFacultyAssignmentForm();
  document.getElementById('facAssignFormTitle').textContent = 'Add assignment';
  document.getElementById('facAssignFileField').style.display = '';
  document.getElementById('facAssignSubject').disabled = false;
  document.getElementById('facAssignLockedNote').style.display = 'none';
  document.getElementById('facAssignSaveBtn').disabled = false;
  document.getElementById('facAssignForm').classList.remove('hidden');
}

function resetFacultyAssignmentForm(){
  document.getElementById('facAssignEditId').value = '';
  document.getElementById('facAssignTitle').value = '';
  document.getElementById('facAssignDueDate').value = '';
  document.getElementById('facAssignDescription').value = '';
  const fileInput = document.getElementById('facAssignFile');
  if(fileInput) fileInput.value = '';
  populateFacultyAssignmentSubjectSelect();
}

function closeFacultyAssignmentForm(){
  document.getElementById('facAssignForm').classList.add('hidden');
}

function editFacultyAssignment(a){
  document.getElementById('facAssignEditId').value = a.id;
  document.getElementById('facAssignTitle').value = a.title;
  document.getElementById('facAssignDueDate').value = a.due_date ? a.due_date.split('T')[0] : '';
  document.getElementById('facAssignDescription').value = a.description || '';
  document.getElementById('facAssignFormTitle').textContent = 'Edit assignment details';
  document.getElementById('facAssignFileField').style.display = 'none';   // edit sirf details ka hota hai, attachment replace nahi hoti

  const select = document.getElementById('facAssignSubject');
  select.innerHTML = `<option value="">${escapeHtml(a.subject_name)} · Sem ${a.semester} · Division ${a.division || 'All'} · ${a.academic_year}</option>`;
  select.disabled = true;   // subject/class edit pe change nahi karte, sirf naya assignment banate waqt
  document.getElementById('facAssignDivisionField').style.display = 'none';

  const locked = a.submission_count > 0;
  document.getElementById('facAssignLockedNote').style.display = locked ? 'block' : 'none';
  document.getElementById('facAssignSaveBtn').disabled = locked;

  document.getElementById('facAssignForm').classList.remove('hidden');
}

async function saveFacultyAssignment(){
  const editId = document.getElementById('facAssignEditId').value;
  const title = document.getElementById('facAssignTitle').value.trim();
  const dueDate = document.getElementById('facAssignDueDate').value;
  const description = document.getElementById('facAssignDescription').value.trim();

  if(!title){
    alert('Title is required');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/faculty/assignments/${editId}`, {
        method: 'PUT',
        body: JSON.stringify({ title, due_date: dueDate, description })
      });
    }else{
      const assignmentId = document.getElementById('facAssignSubject').value;
      if(!assignmentId){
        alert('Select a subject');
        return;
      }
      const division = document.getElementById('facAssignDivision').value;
      const fileInput = document.getElementById('facAssignFile');
      const file = fileInput.files[0];
      if(file && file.size > 10 * 1024 * 1024){
        alert('File is larger than 10MB, upload a smaller file');
        return;
      }
      const formData = new FormData();
      formData.append('assignment_id', assignmentId);
      formData.append('title', title);
      if(division) formData.append('division', division);
      if(dueDate) formData.append('due_date', dueDate);
      if(description) formData.append('description', description);
      if(file) formData.append('file', file);
      await apiUpload('/faculty/assignments', formData);
    }
    closeFacultyAssignmentForm();
    loadFacultyAssignments();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

function isFacultyAssignmentOverdue(dueDate){
  if(!dueDate) return false;
  const due = new Date(dueDate);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return due < today;
}

async function loadFacultyAssignments(){
  const tbody = document.getElementById('facAssignmentsTableBody');
  if(!tbody) return;
  const semester = document.getElementById('facAssignFilterSem').value;
  const subjectId = document.getElementById('facAssignFilterSubject').value;
  const division = document.getElementById('facAssignFilterDiv').value;
  const academicYear = document.getElementById('facAssignFilterYear').value;
  const search = document.getElementById('facAssignSearch').value.trim();

  tbody.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
  try{
    const params = new URLSearchParams();
    if(semester) params.set('semester', semester);
    if(subjectId) params.set('subject_id', subjectId);
    if(division) params.set('division', division);
    if(academicYear) params.set('academic_year', academicYear);
    if(search) params.set('search', search);

    cachedFacultyAssignments = await apiRequest(`/faculty/assignments?${params.toString()}`);

    tbody.innerHTML = cachedFacultyAssignments.length ? cachedFacultyAssignments.map(a => {
      const overdue = isFacultyAssignmentOverdue(a.due_date);
      const dueLabel = a.due_date ? new Date(a.due_date).toLocaleDateString('en-IN') : '-';
      const locked = a.submission_count > 0;
      return `
        <tr class="${overdue ? 'tt-low-attendance' : ''}">
          <td>${escapeHtml(a.title)}${a.file_name ? ` <span title="${escapeHtml(a.file_name)}">📎</span>` : ''}</td>
          <td>${escapeHtml(a.subject_name || '-')}</td>
          <td>${a.semester}</td>
          <td>${a.division || 'All'}</td>
          <td>${a.academic_year || '-'}</td>
          <td>${dueLabel}${overdue ? ' ⚠' : ''}</td>
          <td><button class="pill warn" onclick='openFacultyAssignmentSubmissions(${a.id}, ${JSON.stringify(a.title)}, ${a.can_manage})'>${a.submission_count} submitted</button></td>
          <td class="row-actions">
            ${a.file_name ? `<button class="icon-action" onclick="downloadFacultyAssignmentFile(${a.id}, '${(a.file_name || '').replace(/'/g, "\\'")}')" title="Download attachment">⬇</button>` : ''}
            ${a.can_manage ? `<button class="icon-action" onclick='editFacultyAssignment(${JSON.stringify(a)})' title="${locked ? 'A submission has already come in, cannot be edited' : 'Edit'}" ${locked ? 'disabled' : ''}>✎</button>` : ''}
            ${a.can_manage ? `<button class="icon-action danger" onclick="deleteFacultyAssignment(${a.id}, ${JSON.stringify(a.title)})" title="Delete">🗑</button>` : ''}
          </td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="8">No assignment found.</td></tr>';
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="8">Failed to load: ${err.message}</td></tr>`;
  }
}

async function deleteFacultyAssignment(id, title){
  if(!confirm(`Delete "${title}" assignment? All student submissions for it will also be permanently deleted.`)) return;
  try{
    await apiRequest(`/faculty/assignments/${id}`, { method: 'DELETE' });
    loadFacultyAssignments();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function downloadFacultyAssignmentFile(id, fileName){
  try{
    const res = await fetch(API_BASE + `/faculty/assignments/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_faculty') }
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

// ---- Assignment Submissions modal ----
let currentFacultySubmissionsAssignmentId = null;
let currentFacultySubmissionsCanManage = false;
let cachedFacultySubmissions = [];
let editingFacultySubmissionStudentId = null;

async function openFacultyAssignmentSubmissions(assignmentId, title, canManage){
  currentFacultySubmissionsAssignmentId = assignmentId;
  currentFacultySubmissionsCanManage = !!canManage;
  editingFacultySubmissionStudentId = null;
  document.getElementById('facAssignSubmissionsTitle').textContent = `Submissions — ${title}`;
  document.getElementById('facSubmissionFilterStatus').value = '';
  document.getElementById('facSubmissionSearch').value = '';
  document.getElementById('facAssignSubmissionsOverlay').classList.add('open');
  await loadFacultyAssignmentSubmissions();
}

function closeFacultyAssignmentSubmissions(){
  document.getElementById('facAssignSubmissionsOverlay').classList.remove('open');
  currentFacultySubmissionsAssignmentId = null;
  editingFacultySubmissionStudentId = null;
}

function getFacultySubmissionStatus(r){
  const submitted = !!r.submission_id;
  if(!submitted) return { label: 'Pending', cls: 'bad', key: 'pending' };
  if(r.due_date && r.submitted_at > r.due_date) return { label: 'Late', cls: 'warn', key: 'late' };
  return { label: 'Submitted', cls: 'good', key: 'submitted' };
}

async function loadFacultyAssignmentSubmissions(){
  const tbody = document.getElementById('facAssignSubmissionsBody');
  tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try{
    cachedFacultySubmissions = await apiRequest(`/faculty/assignments/${currentFacultySubmissionsAssignmentId}/submissions`);
    renderFacultyAssignmentSubmissions();
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="6">Failed to load: ${err.message}</td></tr>`;
  }
}

function renderFacultyAssignmentSubmissions(){
  const tbody = document.getElementById('facAssignSubmissionsBody');

  if(!cachedFacultySubmissions.length){
    tbody.innerHTML = '<tr><td colspan="6">No student found in this semester/division.</td></tr>';
    return;
  }

  const statusFilter = document.getElementById('facSubmissionFilterStatus').value;
  const search = (document.getElementById('facSubmissionSearch').value || '').trim().toLowerCase();

  const filtered = cachedFacultySubmissions.filter(r => {
    if(editingFacultySubmissionStudentId === r.student_id) return true;
    if(statusFilter && getFacultySubmissionStatus(r).key !== statusFilter) return false;
    if(search && !r.name.toLowerCase().includes(search) && !String(r.enrollment).toLowerCase().includes(search)) return false;
    return true;
  });

  if(!filtered.length){
    tbody.innerHTML = '<tr><td colspan="6">No student matches the filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    if(editingFacultySubmissionStudentId === r.student_id){
      const status = getFacultySubmissionStatus(r);
      return `
        <tr>
          <td>${escapeHtml(r.enrollment)}</td>
          <td>${escapeHtml(r.name)}</td>
          <td>
            <select id="facEditStatus_${r.student_id}" onchange="onFacultyEditStatusChange(${r.student_id})" style="padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);">
              <option value="pending" ${status.key==='pending'?'selected':''}>Pending</option>
              <option value="submitted" ${status.key==='submitted'?'selected':''}>Submitted</option>
              <option value="late" ${status.key==='late'?'selected':''}>Late</option>
            </select>
          </td>
          <td><input type="date" id="facEditDate_${r.student_id}" value="${r.submitted_at || ''}" ${status.key==='pending'?'disabled':''} style="padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);"></td>
          <td><input type="number" min="0" id="facEditMarks_${r.student_id}" value="${r.marks_obtained ?? ''}" ${status.key==='pending'?'disabled':''} style="width:60px; padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);"></td>
          <td class="row-actions">
            <button class="icon-action" onclick="saveFacultySubmissionEdit(${r.student_id})" title="Save">✓</button>
            <button class="icon-action" onclick="cancelFacultySubmissionEdit()" title="Cancel">✕</button>
          </td>
        </tr>
      `;
    }

    const status = getFacultySubmissionStatus(r);
    const submitted = !!r.submission_id;
    return `
      <tr>
        <td>${escapeHtml(r.enrollment)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td><span class="pill ${status.cls}">${status.label}</span></td>
        <td>${submitted ? new Date(r.submitted_at).toLocaleDateString('en-IN') : '-'}</td>
        <td>${submitted ? (r.marks_obtained ?? '-') : '-'}</td>
        <td class="row-actions">
          ${currentFacultySubmissionsCanManage ? `<button class="icon-action" onclick="startFacultySubmissionEdit(${r.student_id})" title="Edit">✎</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

function startFacultySubmissionEdit(studentId){
  editingFacultySubmissionStudentId = studentId;
  renderFacultyAssignmentSubmissions();
}

function cancelFacultySubmissionEdit(){
  editingFacultySubmissionStudentId = null;
  renderFacultyAssignmentSubmissions();
}

function onFacultyEditStatusChange(studentId){
  const status = document.getElementById(`facEditStatus_${studentId}`).value;
  const isPending = status === 'pending';
  document.getElementById(`facEditDate_${studentId}`).disabled = isPending;
  document.getElementById(`facEditMarks_${studentId}`).disabled = isPending;
}

async function saveFacultySubmissionEdit(studentId){
  const status = document.getElementById(`facEditStatus_${studentId}`).value;
  const dateVal = document.getElementById(`facEditDate_${studentId}`).value;
  const marksVal = document.getElementById(`facEditMarks_${studentId}`).value;

  const payload = {
    submitted: status !== 'pending',
    submitted_at: status === 'pending' ? null : (dateVal || null),
    marks_obtained: status === 'pending' || marksVal === '' ? null : parseInt(marksVal)
  };

  try{
    await apiRequest(`/faculty/assignments/${currentFacultySubmissionsAssignmentId}/submissions/${studentId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    editingFacultySubmissionStudentId = null;
    await loadFacultyAssignmentSubmissions();
    loadFacultyAssignments();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ============================================================
// TIMETABLE (read-only — sab semester/division/batch ki Regular timetable,
// saath hi Mid-Sem aur Remedial exam timetable bhi. Add/Edit/Delete sirf Admin karta hai.)
// ============================================================
let cachedFacultyTimetable = [];
let cachedFacultyExamTimetable = [];
const FAC_DAY_LABELS = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday' };
const FAC_DAY_ORDER = ['Mon','Tue','Wed','Thu','Fri','Sat'];
const FAC_LUNCH_BREAK_RANGE = '13:30-14:00';

function formatFacultyTime12(time24){
  if(!time24) return '';
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  let hour12 = h % 12;
  if(hour12 === 0) hour12 = 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

function formatFacultyRangeLabel(range){
  const [start, end] = range.split('-');
  return `${formatFacultyTime12(start)} - ${formatFacultyTime12(end)}`;
}

async function loadFacultyTimetable(){
  const table = document.getElementById('facTtGridTable');
  if(!table) return;
  try{
    const [regular, exams] = await Promise.all([
      apiRequest('/faculty/timetable'),
      apiRequest('/faculty/exam-timetable')
    ]);
    cachedFacultyTimetable = regular;
    cachedFacultyExamTimetable = exams;

    const yearSelect = document.getElementById('facTtFilterYear');
    const years = uniqueSorted([...cachedFacultyTimetable, ...cachedFacultyExamTimetable], 'academic_year');
    const prevYear = yearSelect.value;
    yearSelect.innerHTML = '<option value="">All batches</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
    if(years.includes(prevYear)) yearSelect.value = prevYear;

    renderFacultyTimetableGrid();
  }catch(err){
    table.innerHTML = `<tr><td class="tt-empty-msg">Timetable could not be loaded: ${err.message}</td></tr>`;
  }
}

function facultyCellContent(slot){
  return `<div class="tt-subject">${escapeHtml(slot.subject_name || '')}</div>` +
    `<div class="tt-meta">${escapeHtml(slot.faculty_name || '')}${slot.room_no ? ' · ' + escapeHtml(slot.room_no) : ''}</div>`;
}

function renderFacultyTimetableGrid(){
  const table = document.getElementById('facTtGridTable');
  const gridType = document.getElementById('facTtType').value;
  const semester = document.getElementById('facTtSemester').value;
  const divisionFilter = document.getElementById('facTtDivision').value;
  const yearFilter = document.getElementById('facTtFilterYear').value;
  const scopeFilter = document.getElementById('facTtScope').value;

  if(gridType !== 'Regular'){
    renderFacultyExamGrid(table, gridType, semester, divisionFilter, yearFilter, scopeFilter);
    return;
  }

  let slotsInSem = cachedFacultyTimetable.filter(t => String(t.semester) === String(semester));
  if(yearFilter) slotsInSem = slotsInSem.filter(t => t.academic_year === yearFilter);
  if(scopeFilter === 'MINE') slotsInSem = slotsInSem.filter(t => Number(t.is_mine) === 1);

  const scopeLabel = scopeFilter === 'MINE' ? ' · My subjects' : '';
  if(divisionFilter === 'ALL'){
    document.getElementById('facTtGridTitle').textContent = `Sem ${semester} · All divisions${scopeLabel}`;
    renderFacultyCombinedDivisionGrid(table, slotsInSem);
  }else{
    document.getElementById('facTtGridTitle').textContent = `Sem ${semester} · Division ${divisionFilter}${scopeLabel}`;
    const slots = slotsInSem.filter(t => (t.division || '').split(',').includes(divisionFilter));
    renderFacultySingleDivisionGrid(table, slots);
  }
}

// Mid-Sem / Remedial exams din-wise repeat nahi hote — date-wise ek baar hote hain,
// isliye inke liye weekly grid ki jagah simple date-sorted list dikhate hain.
function renderFacultyExamGrid(table, examType, semester, divisionFilter, yearFilter, scopeFilter){
  const scopeLabel = scopeFilter === 'MINE' ? ' · My subjects' : '';
  document.getElementById('facTtGridTitle').textContent = `${examType} · Sem ${semester}${divisionFilter === 'ALL' ? '' : ' · Division ' + divisionFilter}${scopeLabel}`;

  let slots = cachedFacultyExamTimetable.filter(t => t.exam_type === examType && String(t.semester) === String(semester));
  if(yearFilter) slots = slots.filter(t => t.academic_year === yearFilter);
  if(divisionFilter !== 'ALL'){
    slots = slots.filter(t => !t.division || t.division === divisionFilter);
  }
  if(scopeFilter === 'MINE') slots = slots.filter(t => Number(t.is_mine) === 1);

  if(!slots.length){
    table.innerHTML = `<tr><td class="tt-empty-msg">No ${examType} slot has been created for this semester/division yet.</td></tr>`;
    return;
  }

  table.innerHTML = `
    <tr>
      <th>Date</th>
      <th>Time</th>
      <th>Division</th>
      <th>Subject</th>
      <th>Room</th>
    </tr>
    ${slots.map(s => `
      <tr>
        <td>${s.exam_date}</td>
        <td>${formatFacultyRangeLabel(`${s.start_time}-${s.end_time}`)}</td>
        <td>${s.division || 'All'}</td>
        <td>${s.subject_name ? `${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code || '')})` : '-'}</td>
        <td>${s.room_no || '-'}</td>
      </tr>
    `).join('')}
  `;
}

function renderFacultySingleDivisionGrid(table, slots){
  if(!slots.length){
    table.innerHTML = '<tr><td class="tt-empty-msg">No timetable slot has been created for this semester/division yet.</td></tr>';
    return;
  }
  const timeSlots = [...new Set(slots.map(s => `${s.start_time}-${s.end_time}`))];
  if(!timeSlots.includes(FAC_LUNCH_BREAK_RANGE)) timeSlots.push(FAC_LUNCH_BREAK_RANGE);
  timeSlots.sort();

  let html = '<tr><th class="tt-time-col">Time</th>' + FAC_DAY_ORDER.map(d => `<th>${FAC_DAY_LABELS[d]}</th>`).join('') + '</tr>';
  timeSlots.forEach(range => {
    html += `<tr><td class="tt-time-col">${formatFacultyRangeLabel(range)}</td>`;
    if(range === FAC_LUNCH_BREAK_RANGE){
      html += `<td class="tt-break-cell" colspan="${FAC_DAY_ORDER.length}">Lunch Break</td>`;
    }else{
      FAC_DAY_ORDER.forEach(day => {
        const match = slots.find(s => `${s.start_time}-${s.end_time}` === range && s.day_of_week === day);
        html += match ? `<td class="tt-cell">${facultyCellContent(match)}</td>` : `<td class="tt-cell-empty">—</td>`;
      });
    }
    html += '</tr>';
  });
  table.innerHTML = html;
}

// Photo-style grid: har Day ke andar A/B/C sub-columns, combined lecture ek merged cell (colspan) me dikhta hai
function renderFacultyCombinedDivisionGrid(table, slots){
  if(!slots.length){
    table.innerHTML = '<tr><td class="tt-empty-msg">No timetable slot has been created for this semester yet.</td></tr>';
    return;
  }

  const usedDivisions = new Set();
  slots.forEach(s => (s.division || '').split(',').forEach(d => d && usedDivisions.add(d)));
  const divisionCols = ['A', 'B', 'C'].filter(d => usedDivisions.has(d));
  if(!divisionCols.length) divisionCols.push('A', 'B');

  const timeSlots = [...new Set(slots.map(s => `${s.start_time}-${s.end_time}`))];
  if(!timeSlots.includes(FAC_LUNCH_BREAK_RANGE)) timeSlots.push(FAC_LUNCH_BREAK_RANGE);
  timeSlots.sort();

  let html = '<tr><th class="tt-time-col" rowspan="2">Time</th>' +
    FAC_DAY_ORDER.map(d => `<th colspan="${divisionCols.length}">${FAC_DAY_LABELS[d]}</th>`).join('') + '</tr>';
  html += '<tr>' + FAC_DAY_ORDER.map(() => divisionCols.map(d => `<th class="tt-div-subhead">${d}</th>`).join('')).join('') + '</tr>';

  timeSlots.forEach(range => {
    html += `<tr><td class="tt-time-col">${formatFacultyRangeLabel(range)}</td>`;

    if(range === FAC_LUNCH_BREAK_RANGE){
      html += `<td class="tt-break-cell" colspan="${FAC_DAY_ORDER.length * divisionCols.length}">Lunch Break</td>`;
      html += '</tr>';
      return;
    }

    FAC_DAY_ORDER.forEach(day => {
      let i = 0;
      while(i < divisionCols.length){
        const div = divisionCols[i];
        const match = slots.find(s =>
          `${s.start_time}-${s.end_time}` === range &&
          s.day_of_week === day &&
          (s.division || '').split(',').includes(div)
        );

        if(!match){
          html += `<td class="tt-cell-empty">—</td>`;
          i += 1;
          continue;
        }

        const matchDivisions = (match.division || '').split(',');
        let span = 0;
        while(i + span < divisionCols.length && matchDivisions.includes(divisionCols[i + span])){
          span++;
        }
        const cellClass = span > 1 ? 'tt-cell tt-cell-combined' : 'tt-cell';
        html += `<td class="${cellClass}" colspan="${span}">${facultyCellContent(match)}</td>`;
        i += span;
      }
    });
    html += '</tr>';
  });

  table.innerHTML = html;
}

// ============================================================
// NOTICES — apni assigned class ko notice post karna (Assignments jaisa hi pattern:
// Add/Edit/Delete/Pin sirf khud ki post ki hui notice pe milta hai)
// ============================================================
function populateFacultyNoticeSubjectSelect(){
  const select = document.getElementById('facNoticeSubject');
  if(!select) return;
  select.innerHTML = cachedSubjects.map(sub =>
    `<option value="${sub.assignment_id}">${escapeHtml(sub.subject_name)} · Sem ${sub.semester} · Division ${sub.division || 'All'} · ${sub.academic_year}</option>`
  ).join('') || '<option value="">No subject assigned</option>';
  onFacNoticeSubjectChange();
}

function onFacNoticeSubjectChange(){
  const select = document.getElementById('facNoticeSubject');
  const divField = document.getElementById('facNoticeDivisionField');
  const divSelect = document.getElementById('facNoticeDivision');
  if(!select || !select.value){
    divField.style.display = 'none';
    return;
  }
  const sub = cachedSubjects.find(s => String(s.assignment_id) === select.value);
  if(sub && !sub.division){
    divField.style.display = '';
    divSelect.innerHTML = '<option value="">All divisions</option>' +
      cachedAllDivisions.map(d => `<option value="${d}">Division ${d}</option>`).join('');
  }else{
    divField.style.display = 'none';
    divSelect.value = '';
  }
}

// "+ Post notice" dabane par hi form khulta hai
function openFacultyNoticeForm(){
  resetFacultyNoticeForm();
  const card = document.getElementById('facNoticeFormCard');
  card.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeFacultyNoticeForm(){
  resetFacultyNoticeForm();
  document.getElementById('facNoticeFormCard').classList.add('hidden');
}

function resetFacultyNoticeForm(){
  document.getElementById('facNoticeEditId').value = '';
  document.getElementById('facNoticeTitle').value = '';
  document.getElementById('facNoticeMessage').value = '';
  document.getElementById('facNoticeCategory').value = 'Academic';
  const fileInput = document.getElementById('facNoticeFile');
  if(fileInput) fileInput.value = '';
  document.getElementById('facNoticeFormTitle').textContent = 'Post a notice to your class';
  document.getElementById('facNoticeSaveBtn').textContent = 'Post notice';
  document.getElementById('facNoticeSubject').disabled = false;
  document.getElementById('facNoticeFileField').style.display = '';
  populateFacultyNoticeSubjectSelect();
}

function editFacultyNotice(n){
  document.getElementById('facNoticeEditId').value = n.id;
  document.getElementById('facNoticeTitle').value = n.title;
  document.getElementById('facNoticeMessage').value = n.content || '';
  document.getElementById('facNoticeCategory').value = n.category || 'Academic';
  document.getElementById('facNoticeFormTitle').textContent = 'Edit notice';
  document.getElementById('facNoticeSaveBtn').textContent = 'Save changes';
  document.getElementById('facNoticeFileField').style.display = 'none';   // edit pe attachment change nahi hoti

  const select = document.getElementById('facNoticeSubject');
  select.innerHTML = `<option value="">Sem ${n.semester} · Division ${n.division || 'All'}</option>`;
  select.disabled = true;
  document.getElementById('facNoticeDivisionField').style.display = 'none';

  const card = document.getElementById('facNoticeFormCard');
  card.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveFacultyNotice(){
  const editId = document.getElementById('facNoticeEditId').value;
  const title = document.getElementById('facNoticeTitle').value.trim();
  const content = document.getElementById('facNoticeMessage').value.trim();
  const category = document.getElementById('facNoticeCategory').value;

  if(!title){
    alert('Title is required');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/faculty/notices/${editId}`, {
        method: 'PUT',
        body: JSON.stringify({ title, content, category })
      });
    }else{
      const assignmentId = document.getElementById('facNoticeSubject').value;
      if(!assignmentId){
        alert('Select a class');
        return;
      }
      const division = document.getElementById('facNoticeDivision').value;
      const fileInput = document.getElementById('facNoticeFile');
      const file = fileInput.files[0];
      if(file && file.size > 10 * 1024 * 1024){
        alert('File is larger than 10MB, upload a smaller file');
        return;
      }
      const formData = new FormData();
      formData.append('assignment_id', assignmentId);
      formData.append('title', title);
      formData.append('content', content);
      formData.append('category', category);
      if(division) formData.append('division', division);
      if(file) formData.append('file', file);
      await apiUpload('/faculty/notices', formData);
    }
    closeFacultyNoticeForm();
    loadFacultyNotices();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function deleteFacultyNotice(id, title){
  if(!confirm(`Delete "${title}" notice?`)) return;
  try{
    await apiRequest(`/faculty/notices/${id}`, { method: 'DELETE' });
    loadFacultyNotices();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function toggleFacultyNoticePin(id, pin){
  try{
    await apiRequest(`/faculty/notices/${id}/pin`, {
      method: 'PATCH',
      body: JSON.stringify({ is_pinned: pin })
    });
    loadFacultyNotices();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function downloadFacultyNotice(id, fileName){
  try{
    const res = await fetch(API_BASE + `/faculty/notices/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_faculty') }
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

// ---- Sidebar unread-notice dot ----
async function refreshFacultyNoticeDot(){
  const dot = document.getElementById('facultyNoticeDot');
  const topbarDot = document.getElementById('facTopbarNoticeDot');
  if(!dot && !topbarDot) return;
  try{
    const data = await apiRequest('/faculty/notices/unread-count');
    const count = data.unread_count || 0;
    const hasUnread = count > 0;
    if(dot) dot.classList.toggle('show', hasUnread);
    if(topbarDot){
      topbarDot.textContent = count > 99 ? '99+' : (hasUnread ? count : '');
      topbarDot.classList.toggle('show', hasUnread);
    }
  }catch(err){
    // silent fail — dot bas purani state me rehne dete hain
  }
}

async function markFacultyNoticesRead(){
  const dot = document.getElementById('facultyNoticeDot');
  const topbarDot = document.getElementById('facTopbarNoticeDot');
  if(dot) dot.classList.remove('show');   // turant hata do, dobara dikhna hai to refreshFacultyNoticeDot khud lagayega
  if(topbarDot) topbarDot.classList.remove('show');
  try{
    await apiRequest('/faculty/notices/mark-read', { method: 'POST' });
  }catch(err){
    // silent fail
  }
}

// ---- Topbar search (subjects + currently loaded students list) ----
function onTopbarSearch(){
  const box = document.getElementById('topbarSearchInput');
  const resultsEl = document.getElementById('topbarSearchResults');
  const q = box.value.trim().toLowerCase();
  if(!q){
    resultsEl.classList.remove('open');
    resultsEl.innerHTML = '';
    return;
  }

  const subjectMatches = cachedSubjects.filter(s =>
    s.subject_name.toLowerCase().includes(q) || (s.subject_code || '').toLowerCase().includes(q)
  ).slice(0, 5);

  const studentMatches = (cachedFacultyStudents || []).filter(s =>
    (s.name || '').toLowerCase().includes(q) || (s.enrollment || '').toLowerCase().includes(q)
  ).slice(0, 5);

  if(subjectMatches.length === 0 && studentMatches.length === 0){
    resultsEl.innerHTML = '<div class="topbar-search-empty">Nothing found</div>';
    resultsEl.classList.add('open');
    return;
  }

  let html = '';
  if(subjectMatches.length){
    html += '<div class="topbar-search-group">Subjects</div>';
    html += subjectMatches.map(s => `
      <div class="topbar-search-row" onclick='goToSubjectFromSearch(${JSON.stringify(s)})'>
        <span>📚 ${escapeHtml(s.subject_name)}</span>
        <span>Sem ${s.semester} · Div ${s.division || 'All'}</span>
      </div>`).join('');
  }
  if(studentMatches.length){
    html += '<div class="topbar-search-group">Students (loaded class)</div>';
    html += studentMatches.map(s => `
      <div class="topbar-search-row" onclick="goToStudentFromSearch('${(s.enrollment || '').replace(/'/g, "\\'")}')">
        <span>👤 ${escapeHtml(s.name)}</span>
        <span>${escapeHtml(s.enrollment || '')}</span>
      </div>`).join('');
  }
  resultsEl.innerHTML = html;
  resultsEl.classList.add('open');
}

function closeTopbarSearch(){
  document.getElementById('topbarSearchInput').value = '';
  document.getElementById('topbarSearchResults').classList.remove('open');
}

function goToSubjectFromSearch(sub){
  closeTopbarSearch();
  switchView('students');
  document.getElementById('studentsFilterYear').value = '';
  document.getElementById('studentsFilterSem').value = '';
  document.getElementById('studentsFilterDiv').value = '';
  populateStudentsClassSelect();
  document.getElementById('studentsClassSelect').value = sub.assignment_id;
  loadFacultyStudents();
}

function goToStudentFromSearch(enrollment){
  closeTopbarSearch();
  switchView('students');
  const searchBox = document.getElementById('studentsSearch');
  if(searchBox){
    searchBox.value = enrollment;
    renderFacultyStudentsRows();
  }
}

document.addEventListener('click', function(e){
  const wrap = document.querySelector('.search');
  if(wrap && !wrap.contains(e.target)) closeTopbarSearch();
});

// ============================================================
// DASHBOARD (welcome banner, stat cards, aaj ki lectures, my subjects mini-grid — sab real data se)
// ============================================================
function renderDashboardBanner(){
  const nameEl = document.getElementById('dashBannerName');
  const eyebrowEl = document.getElementById('dashBannerEyebrow');
  if(!nameEl) return;

  const name = localStorage.getItem('name_faculty') || 'Faculty';
  nameEl.textContent = `Welcome, Prof. ${name}`;

  const now = new Date();
  const dateLabel = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : (hour < 17 ? 'Good afternoon' : 'Good evening');
  eyebrowEl.textContent = `${dateLabel} · ${greeting}`;
}

function renderDashboardMySubjects(){
  const grid = document.getElementById('dashMySubjectsMini');
  if(!grid) return;
  if(!cachedSubjects.length){
    grid.innerHTML = '<div class="empty-state">No subject has been assigned yet.</div>';
    return;
  }
  grid.innerHTML = cachedSubjects.slice(0, 4).map(sub => {
    const tagClass = sub.division === 'A' ? 'mint' : (sub.division === 'B' ? 'amber' : 'mint');
    return `
      <div class="subject-mini" onclick="openClass('subjects', ${JSON.stringify(sub)})"><span class="subj-dot ${tagClass}"></span>
        <div><b>${escapeHtml(sub.subject_name)}</b><span>Sem ${sub.semester} · Div ${sub.division || 'All'}</span></div>
      </div>
    `;
  }).join('');
}

// Banner me "abhi kaun si lecture chal rahi hai / agli kaun si hai" line
function renderDashboardNextLecture(lectures){
  const el = document.getElementById('dashBannerNext');
  if(!el) return;
  if(!lectures || !lectures.length){
    el.textContent = 'No lecture is scheduled today.';
    return;
  }
  const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const sorted = [...lectures].sort((a, b) => toMin(a.start_time) - toMin(b.start_time));
  const ongoing = sorted.find(l => toMin(l.start_time) <= nowMin && nowMin < toMin(l.end_time));
  const next = sorted.find(l => toMin(l.start_time) > nowMin);
  const where = l => `${l.subject_name} · Sem ${l.semester}${l.division ? ' · Div ' + l.division : ''}${l.room_no ? ' · ' + l.room_no : ''}`;
  if(ongoing) el.textContent = `Now: ${where(ongoing)} (till ${formatFacultyTime12(ongoing.end_time)})`;
  else if(next) el.textContent = `Next lecture: ${where(next)} at ${formatFacultyTime12(next.start_time)}`;
  else el.textContent = 'All lectures are done for today.';
}

async function loadFacultyDashboardSummary(){
  const lecturesEl = document.getElementById('dashTodayLectures');
  if(!lecturesEl) return;
  try{
    const data = await apiRequest('/faculty/dashboard-summary');

    document.getElementById('dashStatSubjects').textContent = data.subjects_count;
    document.getElementById('dashStatLecturesLeft').textContent = data.lectures_left_today;
    document.getElementById('dashStatAttendancePending').textContent = data.attendance_pending_today;
    document.getElementById('dashStatSubmissions').textContent = data.submissions_to_check;

    const lectures = data.lectures_today || [];
    renderDashboardNextLecture(lectures);
    if(!lectures.length){
      lecturesEl.innerHTML = '<div class="empty-state">No lecture is scheduled today.</div>';
      return;
    }

    const barClasses = ['bar1', 'bar2', 'bar3'];
    lecturesEl.innerHTML = lectures.map((l, i) => {
      const matchingSub = cachedSubjects.find(s => s.subject_id === l.subject_id && String(s.semester) === String(l.semester) && (s.division === l.division || !s.division));
      const markBtn = l.attendance_marked
        ? `<button class="tt-action done" disabled>Marked</button>`
        : `<button class="tt-action" onclick='openClass("attendance", ${JSON.stringify(matchingSub || null)})'>Mark</button>`;
      return `
        <div class="tt-row">
          <div class="tt-bar ${barClasses[i % barClasses.length]}"></div>
          <div class="tt-time"><b>${formatFacultyTime12(l.start_time)}</b><span>${formatFacultyTime12(l.end_time)}</span></div>
          <div class="tt-info"><b>${escapeHtml(l.subject_name)}</b><span>Sem ${l.semester} · Division ${l.division || 'All'} · ${l.room_no ? escapeHtml(l.room_no) : 'Room TBA'}</span></div>
          ${markBtn}
        </div>
      `;
    }).join('');
  }catch(err){
    lecturesEl.innerHTML = `<div class="empty-state">Dashboard could not be loaded: ${err.message}</div>`;
  }
}
// ============================================================
// Settings — Profile (full name) + Change password
// ============================================================
async function loadFacultyProfile(){
  const nameEl = document.getElementById('settingsFullName');
  try{
    const p = await apiRequest('/faculty/profile');
    applyProfileNameToUI(p.name, p.department, p.short_name);
    if(!nameEl) return;
    nameEl.value = p.name || '';
    document.getElementById('settingsShortName').value = p.short_name || '';
    document.getElementById('settingsFacultyId').value = p.faculty_id || '';
    document.getElementById('settingsEmail').value = p.email || '';
    document.getElementById('settingsDepartment').value = p.department || '';
  }catch(err){
    console.error('Profile load error:', err.message);
  }
}

// Naam + department ko sidebar profile-mini aur topbar profile dropdown me daal do
// (hardcoded "Prof. R. Mehta" ki jagah — admin panel jaisa hi behaviour).
// Sidebar/topbar jaisi tight jagah pe short name use hoti hai (agar bhara ho),
// warna full name pe fallback — dono ke aage hamesha "Prof." laga hua.
function applyProfileNameToUI(name, department, shortName){
  name = name || 'Faculty';
  const compactName = (shortName && shortName.trim()) ? shortName.trim() : name;
  const initial = name.charAt(0).toUpperCase();
  const nameEls = [document.getElementById('sidebarProfileName'), document.getElementById('profileMenuName')];
  nameEls.forEach(el => { if(el) el.textContent = 'Prof. ' + compactName; });
  if(department){
    const roleEls = [document.getElementById('sidebarProfileRole'), document.getElementById('profileMenuRole')];
    roleEls.forEach(el => { if(el) el.textContent = department; });
  }
  const initialEls = [document.getElementById('sidebarAvatarInitial'), document.getElementById('topbarAvatarInitial')];
  initialEls.forEach(el => { if(el) el.textContent = initial; });
}

// ============================================================
// Topbar profile dropdown — admin panel jaisa hi (ek waqt me ek
// dropdown khula rahe, bahar click karne pe band ho jaaye)
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
// Logout — token/role/name clear karke login page pe bhej do
// ============================================================
function logout(){
  if(!confirm('Log out?')) return;
  localStorage.removeItem('token_faculty');
  localStorage.removeItem('name_faculty');
  window.location.href = '../login_panel/login.html';
}

async function saveFacultySettings(){
  const name = document.getElementById('settingsFullName').value.trim();
  const shortName = document.getElementById('settingsShortName').value.trim();
  const currentPassword = document.getElementById('settingsCurrentPassword').value;
  const newPassword = document.getElementById('settingsNewPassword').value;
  const confirmPassword = document.getElementById('settingsConfirmPassword').value;

  if(!name){
    alert('Name cannot be empty');
    return;
  }

  try{
    await apiRequest('/faculty/profile', {
      method: 'PUT',
      body: JSON.stringify({ name, short_name: shortName })
    });
    applyProfileNameToUI(name, document.getElementById('settingsDepartment').value, shortName);
    localStorage.setItem('name_faculty', name);

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
      await apiRequest('/faculty/change-password', {
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
// Show/Hide password toggle (same as admin/login panels)
function toggleVis(id, btn){
  const input = document.getElementById(id);
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  btn.textContent = isPwd ? 'Hide' : 'Show';
}