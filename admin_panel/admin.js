if(!sessionStorage.getItem('token_admin')){
  window.location.href = '../login_panel/login.html';
}

// Global HTML escaper to protect all DOM injections against Stored/Reflected XSS
function escapeHtml(str){
  return String(str ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
window.escapeHtml = escapeHtml;
window.escapeHtmlMR = escapeHtml;

// ---- API helpers ----
const API_BASE = window.APP_CONFIG.API_BASE;   // set in ../shared/config.js

// Department short-code -> full name (if you add a new department here, add it to this list as well)
const DEPT_NAMES = {
  'computer engineering': 'Computer Engineering'
};
function deptName(code){
  if(!code) return '-';
  return DEPT_NAMES[code.toLowerCase()] || code;
}

// Diploma = 3 years, 6 semesters. Year of study is derived from current
// semester — never stored in DB, always computed live so promotions
// (semester update) automatically reflect in the year shown.
function yearOfStudy(semester){
  const sem = parseInt(semester);
  if(!sem) return '-';
  if(sem <= 2) return '1st Year';
  if(sem <= 4) return '2nd Year';
  if(sem <= 6) return '3rd Year';
  return '-';
}

function authHeaders(){
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + sessionStorage.getItem('token_admin')
  };
}

async function apiRequest(path, options = {}){
  const res = await fetch(API_BASE + path, { ...options, headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || res.status === 403){
    // token invalid/expired or not an admin — send back to login
    sessionStorage.removeItem('token_admin');
    window.location.href = '../login_panel/login.html';
    throw new Error(data.message || 'Unauthorized');
  }
  if(!res.ok){
    const err = new Error(data.message || 'Request failed');
    err.detail = data.error;   // the backend's detailed error (like mysqldump's stderr) is carried here
    throw err;
  }
  return data;
}

// For file uploads — we do NOT set the Content-Type header manually here,
// the browser sets it itself with the multipart boundary (FormData body)
async function apiUpload(path, formData){
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_admin') },
    body: formData
  });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || res.status === 403){
    sessionStorage.removeItem('token_admin');
    window.location.href = '../login_panel/login.html';
    throw new Error(data.message || 'Unauthorized');
  }
  if(!res.ok){
    throw new Error(data.message || 'Upload failed');
  }
  return data;
}

// ============================================================
// STUDENT MANAGEMENT
// ============================================================
function openAddStudentForm(){
  resetStudentForm();
  const form = document.getElementById('studentForm');
  form.classList.remove('hidden');
}

function resetStudentForm(){
  document.getElementById('studentEditId').value = '';
  document.getElementById('studentName').value = '';
  document.getElementById('studentEnrollment').value = '';
  document.getElementById('studentEnrollment').disabled = false;
  document.getElementById('studentEmail').value = '';
  document.getElementById('studentMobile').value = '';
  document.getElementById('studentWhatsapp').value = '';
  document.getElementById('studentDiv').value = '';       // it will stay on the "Select division" placeholder
  document.getElementById('studentBatch').value = '';     // it will stay on the "Select batch" placeholder
  document.getElementById('studentStatus').value = 'active';
  document.getElementById('studentFatherName').value = '';
  document.getElementById('studentFatherMobile').value = '';
  document.getElementById('studentMotherName').value = '';
  document.getElementById('studentMotherMobile').value = '';
  document.getElementById('studentParentEmail').value = '';
  document.getElementById('studentParentAddress').value = '';
}

// ---- Students list: server-side pagination (25 per page) ----
const STUDENTS_PAGE_SIZE = 25;
let studentsPage = 1;
let studentsFilterSig = null;   // when a filter/search changes, the list goes back to page 1
let studentsReqSeq = 0;         // so that an older, slower response can never overwrite a newer one
let studentsSearchTimer = null;

function onStudentSearchInput(){
  clearTimeout(studentsSearchTimer);
  studentsSearchTimer = setTimeout(() => loadStudents(), 300);   // wait until typing pauses
}

function goToStudentsPage(p){
  studentsPage = p;
  loadStudents();
}

function renderStudentsPager(total, page, totalPages, shown){
  const table = document.getElementById('studentsTableBody').closest('table');
  let pager = document.getElementById('studentsPager');
  if(!pager){
    pager = document.createElement('div');
    pager.id = 'studentsPager';
    pager.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:12px; font-size:13px; color:var(--muted);';
    table.insertAdjacentElement('afterend', pager);
  }
  if(!total){
    pager.innerHTML = '';
    return;
  }
  const from = (page - 1) * STUDENTS_PAGE_SIZE + 1;
  const to = from + shown - 1;
  const info = `<span>Showing ${from}–${to} of ${total} student${total === 1 ? '' : 's'}</span>`;
  const controls = totalPages > 1 ? `
    <span style="display:flex; align-items:center; gap:10px;">
      <button class="btn-ghost" ${page <= 1 ? 'disabled' : ''} onclick="goToStudentsPage(${page - 1})">‹ Prev</button>
      <span>Page ${page} of ${totalPages}</span>
      <button class="btn-ghost" ${page >= totalPages ? 'disabled' : ''} onclick="goToStudentsPage(${page + 1})">Next ›</button>
    </span>` : '';
  pager.innerHTML = info + controls;
}

async function loadStudents(){
  const tbody = document.getElementById('studentsTableBody');
  tbody.innerHTML = '<tr><td colspan="9">Loading…</td></tr>';

  const dept = document.getElementById('studentFilterDept').value;
  const sem = document.getElementById('studentFilterSem').value;
  const year = document.getElementById('studentFilterYear').value;
  const statusFilter = document.getElementById('studentFilterStatus').value;
  const searchBox = document.getElementById('studentSearch');
  const search = searchBox ? searchBox.value.trim() : '';

  // a different filter/search than last time -> start from page 1 (other callers, e.g. after save/delete, keep the current page)
  const sig = [dept, sem, year, statusFilter, search].join('|');
  if(sig !== studentsFilterSig){
    studentsFilterSig = sig;
    studentsPage = 1;
  }

  const params = new URLSearchParams();
  if(dept) params.set('department', dept);
  if(sem) params.set('semester', sem);
  if(year) params.set('academic_year', year);
  if(statusFilter) params.set('status', statusFilter);   // filtered on the server, so each page is already complete
  if(search) params.set('search', search);
  params.set('page', studentsPage);
  params.set('limit', STUDENTS_PAGE_SIZE);

  const seq = ++studentsReqSeq;
  try{
    const res = await apiRequest('/admin/students?' + params.toString());
    if(seq !== studentsReqSeq) return;   // a newer request has been made in the meantime
    const students = res.items;
    studentsPage = res.page;             // the server clamps it (e.g. after deleting the last student of the last page)
    renderStudentsPager(res.total, res.page, res.total_pages, students.length);
    if(!students.length){
      tbody.innerHTML = '<tr><td colspan="9">No students found.</td></tr>';
      return;
    }
    window._studentsCache = new Map(students.map(s => [String(s.id), s]));
    tbody.innerHTML = students.map(s => `
      <tr style="cursor:pointer" onclick="handleStudentRowClick(event, '${s.id}')">
        <td>${escapeHtml(s.enrollment)}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.semester || '-')}</td>
        <td>${escapeHtml(s.division || '-')}</td>
        <td>${escapeHtml(s.academic_year || '-')}</td>
        <td>${escapeHtml(deptName(s.department))}</td>
        <td>${escapeHtml(yearOfStudy(s.semester))}</td>
        <td><span class="pill ${s.status === 'active' ? 'good' : 'warn'}" style="cursor:pointer"
              onclick="event.stopPropagation(); toggleStudentStatus(${s.id}, '${escapeHtml(s.status)}')">${s.status === 'active' ? 'Active' : 'Inactive'}</span></td>
        <td class="row-actions">
          <button class="icon-action" onclick="event.stopPropagation(); editStudentById('${s.id}')">✎</button>
          <button class="icon-action danger" onclick="event.stopPropagation(); deleteStudentById('${s.id}')">🗑</button>
        </td>
      </tr>
    `).join('');
  }catch(err){
    if(seq !== studentsReqSeq) return;
    tbody.innerHTML = `<tr><td colspan="9">Failed to load students: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function handleStudentRowClick(e, id){
  const s = window._studentsCache ? window._studentsCache.get(String(id)) : null;
  if(s) showStudentDetails(s);
}
function editStudentById(id){
  const s = window._studentsCache ? window._studentsCache.get(String(id)) : null;
  if(s) editStudent(s);
}
function deleteStudentById(id){
  const s = window._studentsCache ? window._studentsCache.get(String(id)) : null;
  if(s) deleteStudent(s.id, s.name);
}

async function saveStudent(){
  const editId = document.getElementById('studentEditId').value;
  const payload = {
    name: document.getElementById('studentName').value.trim(),
    enrollment: document.getElementById('studentEnrollment').value.trim(),
    email: document.getElementById('studentEmail').value.trim(),
    mobile: document.getElementById('studentMobile').value.trim(),
    whatsapp_number: document.getElementById('studentWhatsapp').value.trim(),
    department: document.getElementById('studentDept').value,
    semester: document.getElementById('studentSem').value,
    division: document.getElementById('studentDiv').value,
    academic_year: document.getElementById('studentBatch').value,
    status: document.getElementById('studentStatus').value,
    father_name: document.getElementById('studentFatherName').value.trim(),
    father_mobile: document.getElementById('studentFatherMobile').value.trim(),
    mother_name: document.getElementById('studentMotherName').value.trim(),
    mother_mobile: document.getElementById('studentMotherMobile').value.trim(),
    parent_email: document.getElementById('studentParentEmail').value.trim(),
    parent_address: document.getElementById('studentParentAddress').value.trim()
  };

  if(!payload.name || !payload.enrollment){
    alert('Full name and enrollment number are required');
    return;
  }
  if(payload.father_mobile && !/^\d{10}$/.test(payload.father_mobile)){
    alert("Father's mobile number must be 10 digits");
    return;
  }
  if(payload.whatsapp_number && !/^\d{10,15}$/.test(payload.whatsapp_number)){
    alert('WhatsApp number must be 10-15 digits (with country code if needed)');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/admin/students/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      alert('Student updated');
    } else {
      const res = await apiRequest('/admin/students', { method: 'POST', body: JSON.stringify(payload) });
      alert(`Student added. Default password: ${res.default_password}`);
    }
    toggleForm('studentForm');
    resetStudentForm();
    loadStudents();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

function editStudent(student){
  document.getElementById('studentEditId').value = student.id;
  document.getElementById('studentName').value = student.name;
  document.getElementById('studentEnrollment').value = student.enrollment;
  document.getElementById('studentEnrollment').disabled = true;   // enrollment is the login_id, it can't be edited
  document.getElementById('studentEmail').value = student.email || '';
  document.getElementById('studentMobile').value = student.mobile || '';
  document.getElementById('studentWhatsapp').value = student.whatsapp_number || '';
  // Only one department (Computer Engineering) is supported for now, so
  // always select that one — if new departments are added in the future,
  // put the proper matching logic back here.
  document.getElementById('studentDept').value = 'Computer Engineering';
  document.getElementById('studentSem').value = student.semester || '1';
  document.getElementById('studentDiv').value = student.division || 'A';
  document.getElementById('studentBatch').value = student.academic_year || '2024-25';
  document.getElementById('studentStatus').value = student.status;
  document.getElementById('studentFatherName').value = student.father_name || '';
  document.getElementById('studentFatherMobile').value = student.father_mobile || '';
  document.getElementById('studentMotherName').value = student.mother_name || '';
  document.getElementById('studentMotherMobile').value = student.mother_mobile || '';
  document.getElementById('studentParentEmail').value = student.parent_email || '';
  document.getElementById('studentParentAddress').value = student.parent_address || '';
  const studentFormEl = document.getElementById('studentForm');
  studentFormEl.classList.remove('hidden');
  // Edit form is at the top of the page: scroll up to it automatically
  requestAnimationFrame(() => {
    studentFormEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const nameInput = document.getElementById('studentName');
    if(nameInput) nameInput.focus({ preventScroll: true });
  });
}

// ---- Student Details modal (parent details view) ----
function showStudentDetails(student){
  document.getElementById('studentDetailName').textContent = `${student.name} (${student.enrollment})`;
  document.getElementById('studentDetailEnrollment').textContent = student.enrollment;
  document.getElementById('studentDetailStatus').textContent = student.status === 'active' ? 'Active' : 'Inactive';
  document.getElementById('studentDetailEmail').textContent = student.email || '-';
  document.getElementById('studentDetailMobile').textContent = student.mobile || '-';
  document.getElementById('studentDetailWhatsapp').textContent = student.whatsapp_number || '-';
  document.getElementById('studentDetailAcademic').textContent =
    `${deptName(student.department)} · Sem ${student.semester || '-'} · ${student.division || '-'} · ${student.academic_year || '-'}`;

  document.getElementById('studentDetailFatherName').textContent = student.father_name || '-';
  document.getElementById('studentDetailFatherMobile').textContent = student.father_mobile || '-';
  document.getElementById('studentDetailMotherName').textContent = student.mother_name || '-';
  document.getElementById('studentDetailMotherMobile').textContent = student.mother_mobile || '-';
  document.getElementById('studentDetailParentEmail').textContent = student.parent_email || '-';
  document.getElementById('studentDetailParentAddress').textContent = student.parent_address || '-';

  document.getElementById('studentDetailsOverlay').classList.add('open');
}

function closeStudentDetails(){
  document.getElementById('studentDetailsOverlay').classList.remove('open');
}

async function deleteStudent(id, name){
  if(!confirm(`Do you want to delete "${name}"? You cannot undo this action.`)) return;
  try{
    await apiRequest(`/admin/students/${id}`, { method: 'DELETE' });
    loadStudents();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function toggleStudentStatus(id, currentStatus){
  const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
  try{
    await apiRequest(`/admin/students/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
    loadStudents();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ---- Dashboard ----
function timeAgo(isoString){
  if(!isoString) return '';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if(mins < 1) return 'Just now';
  if(mins < 60) return mins + ' min ago';
  const hours = Math.floor(mins / 60);
  if(hours < 24) return hours + ' hour' + (hours > 1 ? 's' : '') + ' ago';
  const days = Math.floor(hours / 24);
  if(days === 1) return 'Yesterday';
  return days + ' days ago';
}

// Actual date + time for recent activity (e.g. "23 Aug 2026, 6:45 PM")
function formatDateTime(isoString){
  if(!isoString) return '';
  const d = new Date(isoString);
  const datePart = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const timePart = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${datePart}, ${timePart}`;
}

async function loadDashboardStats(){
  try{
    const stats = await apiRequest('/admin/dashboard-stats');
    document.getElementById('statTotalStudents').textContent = stats.total_students;
    document.getElementById('statTotalFaculty').textContent = stats.total_faculty;
    document.getElementById('statTotalSubjects').textContent = stats.total_subjects;
    document.getElementById('statNoticesWeek').textContent = stats.notices_this_week;
    document.getElementById('statPendingMarksRequests').textContent = stats.pending_marks_requests;
    renderSemesterChart(stats.students_by_semester);
    renderAdminCharts(stats);
  }catch(err){
    console.error('Dashboard stats error:', err.message);
  }
}

// Dashboard charts (fee status / attendance by semester / logins last 7 days) — drawn by shared/charts.js
function renderAdminCharts(stats){
  if(!window.SHCharts) return;

  const fee = stats.fee_summary || {};
  const paid = fee.paid || { count: 0, amount: 0 };
  const unpaid = fee.unpaid || { count: 0, amount: 0 };
  const rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  const feeTotal = (paid.count || 0) + (unpaid.count || 0);
  SHCharts.donut(document.getElementById('feeStatusChart'), [
    { label: 'Paid',   value: paid.count || 0,   color: SHCharts.colors.good, text: `${paid.count || 0} · ${rupees(paid.amount)}` },
    { label: 'Unpaid', value: unpaid.count || 0, color: SHCharts.colors.warn, text: `${unpaid.count || 0} · ${rupees(unpaid.amount)}` }
  ], {
    center: feeTotal ? Math.round((paid.count || 0) * 100 / feeTotal) + '%' : '',
    sub: 'fees paid',
    label: 'Fees paid versus unpaid',
    empty: 'No fee records yet.'
  });

  SHCharts.columns(document.getElementById('attendanceSemesterChart'),
    (stats.attendance_by_semester || []).map(r => ({
      label: 'Sem ' + r.semester, value: r.percentage,
      title: `Semester ${r.semester} (${r.total} records)`
    })),
    { max: 100, unit: '%', threshold: 75, label: 'Attendance percentage by semester', empty: 'Attendance has not been marked yet.' });

  SHCharts.line(document.getElementById('loginActivityChart'),
    (stats.logins_last_7_days || []).map(r => {
      const d = new Date(r.date + 'T00:00:00');
      return {
        label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        title: d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }),
        value: r.count
      };
    }),
    { label: 'Logins per day for the last 7 days', empty: 'No logins in the last 7 days.' });
}

// The "Students by semester" bar chart on the Dashboard (Sem 1-6, 0 for a semester with no students)
function renderSemesterChart(rows){
  const el = document.getElementById('semesterChart');
  if(!el) return;
  const counts = {};
  (rows || []).forEach(r => { counts[r.semester] = r.count; });
  const sems = [1, 2, 3, 4, 5, 6];
  const total = sems.reduce((sum, s) => sum + (counts[s] || 0), 0);
  if(!total){
    el.innerHTML = '<div class="nf-empty">No students added yet.</div>';
    return;
  }
  const max = Math.max(...sems.map(s => counts[s] || 0));
  el.innerHTML = sems.map((s, i) => {
    const c = counts[s] || 0;
    return `<div class="bar-row"><span class="bar-label">Sem ${s}</span><div class="bar-track"><div class="bar-fill" style="width:${(c / max) * 100}%; animation-delay:${i * 60}ms"></div></div><b class="bar-val">${c}</b></div>`;
  }).join('');
}

// The reply can come back instantly (FAQ answers) - keep the loading dots visible for a moment so the chat feels natural
function chatMinDelay(startedAt, ms = 800){
  const left = ms - (Date.now() - startedAt);
  return left > 0 ? new Promise(r => setTimeout(r, left)) : Promise.resolve();
}

// ---- System Assistant (dashboard card) — real data from the backend /admin/assistant ----
// ---- Chat history: this user's own previous questions & replies are shown in the chat page and the popup ----
const CHAT_GREETINGS = {};

function renderChatHistory(logId, items){
  const log = document.getElementById(logId);
  if(!log) return;
  if(log.querySelector('[id^="typing-"]')) return;   // a reply is loading right now - do not wipe it
  if(CHAT_GREETINGS[logId] === undefined){
    const first = log.querySelector('.msg.bot');
    CHAT_GREETINGS[logId] = first ? first.outerHTML : '';
  }
  log.innerHTML = CHAT_GREETINGS[logId] + items.map(m => {
    const when = m.created_at ? new Date(m.created_at).toLocaleString() : '';
    return `<div class="msg user" title="${when}">${nfEsc(m.message || '')}</div>` +
           `<div class="msg bot" title="${when}">${nfEsc(m.response || '').replace(/\n/g, '<br>')}</div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
}

async function loadMyChatHistory(){
  try{
    const items = await apiRequest('/admin/chat-history');
    ['chatLog', 'popupLog'].forEach(id => renderChatHistory(id, items));
  }catch(err){
    /* history is optional - the chat still works without it */
  }
}

document.addEventListener('DOMContentLoaded', loadMyChatHistory);

async function adminAsk(text){
  const box = document.getElementById('adminAskaiReply');
  if(!box) return;
  box.classList.remove('hidden');
  box.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span>';
  const startedAt = Date.now();
  try{
    const data = await apiRequest('/admin/assistant', { method: 'POST', body: JSON.stringify({ message: text }) });
    await chatMinDelay(startedAt);
    box.innerHTML = nfEsc(data.reply || '...').replace(/\n/g, '<br>');
  }catch(err){
    box.textContent = 'Response could not be loaded, try again.';
  }
}

// ---- Floating chat popup + full "AI Chat" page (same assistant as the dashboard card: /admin/assistant) ----
function togglePopup(){
  const popup = document.getElementById('popup');
  popup.classList.toggle('hidden');
  if(!popup.classList.contains('hidden')){
    loadMyChatHistory();
    const log = document.getElementById('popupLog');
    if(log) log.scrollTop = log.scrollHeight;
    const input = document.getElementById('popupInput');
    if(input) input.focus();
  }
}

async function sendChat(inputId, logId){
  const input = document.getElementById(inputId);
  const text = input.value.trim();
  if(!text) return;
  const log = document.getElementById(logId);
  log.insertAdjacentHTML('beforeend', `<div class="msg user">${nfEsc(text)}</div>`);
  input.value = '';
  log.scrollTop = log.scrollHeight;
  const typingId = 'typing-' + Date.now();
  log.insertAdjacentHTML('beforeend', `<div class="msg bot" id="${typingId}"><span class="typing-dots"><i></i><i></i><i></i></span></div>`);
  log.scrollTop = log.scrollHeight;
  const startedAt = Date.now();
  try{
    const data = await apiRequest('/admin/assistant', { method: 'POST', body: JSON.stringify({ message: text }) });
    await chatMinDelay(startedAt);
    const el = document.getElementById(typingId);
    if(el) el.innerHTML = nfEsc(data.reply || '...').replace(/\n/g, '<br>');
  }catch(err){
    const el = document.getElementById(typingId);
    if(el) el.textContent = 'Response could not be loaded, try again.';
  }
  log.scrollTop = log.scrollHeight;
}

function adminAskFromDashboard(){
  const input = document.getElementById('adminAskaiInput');
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  adminAsk(text);
}

function adminAskTag(text){ adminAsk(text); }

function adminAskPrefill(text){
  const input = document.getElementById('adminAskaiInput');
  input.value = text;
  input.focus();
}

// A small preview list of pending marks requests on the Dashboard (the same data as the Marks Requests screen, top 5)
async function loadDashboardPendingMarks(){
  const container = document.getElementById('dashboardPendingMarksList');
  if(!container) return;
  try{
    const data = await apiRequest('/admin/marks/requests?status=pending');
    const rows = (data.requests || []).slice(0, 5);
    if(rows.length === 0){
      container.innerHTML = '<div class="notice-row" style="border-bottom:none;"><b>There are no pending marks requests</b></div>';
      return;
    }
    container.innerHTML = rows.map((r, i) => {
      const isLast = i === rows.length - 1;
      return `<div class="notice-row"${isLast ? ' style="border-bottom:none;"' : ''}>
        <b>${escapeHtmlMR(r.faculty_name)} — ${escapeHtmlMR(r.subject_name)} (${escapeHtmlMR(r.exam_type)})</b>
        <span>Sem ${escapeHtml(r.semester)} / ${escapeHtml(r.division || 'All')} · ${escapeHtml(r.student_count)} students · ${escapeHtml(formatDateTime(r.submitted_at))}</span>
      </div>`;
    }).join('');
  }catch(err){
    container.innerHTML = '<div class="notice-row" style="border-bottom:none;"><b>Failed to load</b></div>';
  }
}

async function loadRecentActivity(){
  const container = document.getElementById('recentActivityList');
  try{
    const rows = await apiRequest('/admin/recent-activity');
    if(rows.length === 0){
      container.innerHTML = '<div class="notice-row" style="border-bottom:none;"><b>There is no recent activity</b></div>';
      return;
    }
    container.innerHTML = rows.map((r, i) => {
      let label;
      if(r.type === 'student_registered') label = `New student registered — ${escapeHtml(r.title)}`;
      else if(r.type === 'faculty_added') label = `New faculty account created — ${escapeHtml(r.title)}`;
      else label = `Notice posted — ${escapeHtml(r.title)}`;
      const isLast = i === rows.length - 1;
      return `<div class="notice-row"${isLast ? ' style="border-bottom:none;"' : ''}><b>${label}</b><span>${escapeHtml(r.detail || '')} · ${escapeHtml(formatDateTime(r.created_at))}</span></div>`;
    }).join('');
  }catch(err){
    container.innerHTML = '<div class="notice-row" style="border-bottom:none;"><b>Failed to load</b></div>';
  }
}

// ---- Live auto-refresh (page refresh kiye bina faculty/students ke updates dikhne ke liye) ----
// Dashboard, bell badge, notices aur pending marks-requests badge. Tables/forms (students, faculty, fees, marks...)
// jaan-boojh kar nahi chhedi jaati, taaki edit karte waqt user ka kaam na ud jaaye.
let adminLastBg = 0;
async function refreshMarksRequestBadge(){
  const badge = document.getElementById('marksRequestBadge');
  if(!badge) return;
  try{
    const data = await apiRequest('/admin/marks/requests?status=pending');
    const n = (data.requests || []).length;
    if(n > 0){ badge.textContent = n; badge.style.display = ''; } else { badge.style.display = 'none'; }
  }catch(err){ /* silent */ }
}
function adminBackgroundRefresh(){
  if(document.hidden) return;
  if(Date.now() - adminLastBg < 5000) return;
  adminLastBg = Date.now();
  refreshNotifBadge();
  loadDashboard();
  loadNotices(true);
  refreshMarksRequestBadge();
  // Attendance: faculty ne attendance mark ki to admin ki "summary" table (read-only) aur khula hua calendar apne aap update hote hain.
  // Mark karne wali list (attendanceTableBody) nahi chhedi jaati — usme admin ke unsaved Present/Absent clicks hote hain.
  const attView = document.getElementById('view-attendance');
  if(attView && attView.classList.contains('active')){
    if(document.getElementById('attSemester') && document.getElementById('attSemester').value) loadAttendanceSummary(true);
    const calOv = document.getElementById('attCalendarOverlay');
    if(calOv && calOv.classList.contains('open')) loadAttendanceCalendar(true);
  }
}

function loadDashboard(){
  loadDashboardStats();
  loadRecentActivity();
  loadDashboardPendingMarks();
}

// Load the list as soon as the Student Management view opens
document.addEventListener('DOMContentLoaded', () => {
  applyStoredDarkMode();
  applyProfileNameToUI();
  refreshNotifBadge();
  setInterval(refreshNotifBadge, 60000);   // check for new notifications every 1 min
  setInterval(adminBackgroundRefresh, 20000);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) adminBackgroundRefresh(); });
  window.addEventListener('focus', adminBackgroundRefresh);
  loadDashboard();
  loadStudents();
  loadSubjects();     // load subjects first so the faculty dropdown gets filled too
  loadFaculty();
  loadTimetable();
  loadExamTimetables();

  if(document.getElementById('attDate')){
    document.getElementById('attDate').value = new Date().toISOString().split('T')[0];   // default: today's date
    loadAttendanceSummary();
  }

  if(document.getElementById('notesTableBody')){
    populateNoteSubjects(document.getElementById('noteSemester').value);
    loadNotes();
  }

  if(document.getElementById('assignmentsTableBody')){
    populateAssignmentSubjects(document.getElementById('assignSemester').value);
    loadAssignments();
  }

  if(document.getElementById('marksTableBody')){
    populateMarksSubjects(document.getElementById('marksSemester').value);
  }

  if(document.getElementById('marksRequestsTableBody')){
    loadMarksRequests('pending');
  }

  if(document.getElementById('feesTableBody')){
    loadFees();
  }

  if(document.getElementById('noticesListBody')){
    loadNotices();
  }

  if(document.getElementById('settingsCollegeName')){
    loadAdminSettings();
  }

  if(document.getElementById('loginHistoryBody')){
    loadLoginHistory();
  }

  if(document.getElementById('backupsListBody')){
    loadBackupsList();
  }

  if(document.getElementById('academicYearsList')){
    loadAcademicYears();
  }

  if(document.getElementById('divisionsSummaryBody')){
    loadDivisionsSummary();
  }

  if(document.getElementById('faqTableBody')){
    loadFaqs();
  }
});

// ============================================================
// SUBJECT MANAGEMENT
// ============================================================
let cachedSubjects = [];
let currentFacultySelectedSubjectIds = [];   // checkboxes that are currently checked in the form (not to remember them when the semester changes — only for rendering)

function openAddSubjectForm(){
  resetSubjectForm();
  document.getElementById('subjectForm').classList.remove('hidden');
}

function resetSubjectForm(){
  document.getElementById('subjectEditId').value = '';
  document.getElementById('subjectName').value = '';
  document.getElementById('subjectCode').value = '';
  document.getElementById('subjectCode').disabled = false;
  document.getElementById('subjectDept').value = 'Computer Engineering';
  document.getElementById('subjectSem').value = '';
  document.getElementById('subjectType').value = 'Theory';
  document.getElementById('subjectBatch').value = '';   // it will stay on the "Select batch" placeholder
}

async function loadSubjects(){
  const tbody = document.getElementById('subjectsTableBody');
  if(tbody) tbody.innerHTML = '<tr><td colspan="7">Loading…</td></tr>';

  const filterYearEl = document.getElementById('subjectFilterYear');
  const params = new URLSearchParams();
  if(filterYearEl && filterYearEl.value) params.set('academic_year', filterYearEl.value);

  try{
    const subjects = await apiRequest('/admin/subjects?' + params.toString());
    cachedSubjects = subjects;

    if(tbody){
      tbody.innerHTML = subjects.length ? subjects.map(s => `
        <tr>
          <td>${escapeHtml(s.subject_code)}</td>
          <td>${escapeHtml(s.subject_name)}</td>
          <td>${escapeHtml(deptName(s.department))}</td>
          <td>${escapeHtml(s.semester || '-')}</td>
          <td>${escapeHtml(s.subject_type || 'Theory')}</td>
          <td>${escapeHtml(s.academic_year || '-')}</td>
          <td class="row-actions">
            <button class="icon-action" onclick="editSubjectById('${s.id}')">✎</button>
            <button class="icon-action danger" onclick="deleteSubjectById('${s.id}')">🗑</button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="7">No subjects found.</td></tr>';
    }

    // If a semester is already selected in the Faculty form, refresh its subjects checkboxes
    if(document.getElementById('facultySubjectsContainer')){
      renderFacultySubjectCheckboxes(document.getElementById('facultySemester').value, currentFacultySelectedSubjectIds);
    }

    // Refresh the Attendance subject dropdown too (filtered semester-wise)
    if(document.getElementById('attSubject')){
      populateAttendanceSubjects(document.getElementById('attSemester').value);
    }

    // Refresh both Notes dropdowns (upload form + filter) too
    if(document.getElementById('noteSubject')){
      populateNoteSubjects(document.getElementById('noteSemester').value);
    }
    if(document.getElementById('noteFilterSubject')){
      populateNoteFilterSubjects(document.getElementById('noteFilterSemester').value);
    }

    // Refresh both Assignment dropdowns (upload form + filter) too
    if(document.getElementById('assignSubject')){
      populateAssignmentSubjects(document.getElementById('assignSemester').value);
    }
    if(document.getElementById('assignFilterSubject')){
      populateAssignmentFilterSubjects(document.getElementById('assignFilterSemester').value);
    }

    // Refresh the Marks Subject dropdown too
    if(document.getElementById('marksSubject')){
      populateMarksSubjects(document.getElementById('marksSemester').value);
    }
  }catch(err){
    if(tbody) tbody.innerHTML = `<tr><td colspan="7">Failed to load subjects: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function saveSubject(){
  const editId = document.getElementById('subjectEditId').value;
  const payload = {
    subject_name: document.getElementById('subjectName').value.trim(),
    subject_code: document.getElementById('subjectCode').value.trim(),
    department: document.getElementById('subjectDept').value,
    semester: document.getElementById('subjectSem').value,
    subject_type: document.getElementById('subjectType').value,
    academic_year: document.getElementById('subjectBatch').value,
    credits: 0
  };

  if(!payload.subject_name || !payload.subject_code){
    alert('Subject name and code are required');
    return;
  }
  if(!payload.semester || !payload.academic_year){
    alert('Select semester and batch');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/admin/subjects/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      alert('Subject updated');
    } else {
      await apiRequest('/admin/subjects', { method: 'POST', body: JSON.stringify(payload) });
      alert('Subject added');
    }
    toggleForm('subjectForm');
    resetSubjectForm();
    loadSubjects();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

function editSubject(subject){
  document.getElementById('subjectEditId').value = subject.id;
  document.getElementById('subjectName').value = subject.subject_name;
  document.getElementById('subjectCode').value = subject.subject_code;
  document.getElementById('subjectCode').disabled = true;   // code is a unique key, it can't be edited
  document.getElementById('subjectDept').value = subject.department || 'Computer Engineering';
  document.getElementById('subjectSem').value = subject.semester || '1';
  document.getElementById('subjectType').value = subject.subject_type || 'Theory';
  document.getElementById('subjectBatch').value = subject.academic_year || '2024-25';
  document.getElementById('subjectForm').classList.remove('hidden');
}

async function deleteSubject(id, name){
  if(!confirm(`Delete the subject ${name}?`)) return;
  try{
    await apiRequest(`/admin/subjects/${id}`, { method: 'DELETE' });
    loadSubjects();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

function editSubjectById(id){
  const s = (cachedSubjects || []).find(x => String(x.id) === String(id));
  if(s) editSubject(s);
}

function deleteSubjectById(id){
  const s = (cachedSubjects || []).find(x => String(x.id) === String(id));
  if(s) deleteSubject(s.id, s.subject_name);
}

// ============================================================
// FACULTY MANAGEMENT
// ============================================================
function openAddFacultyForm(){
  resetFacultyForm();
  document.getElementById('facultyForm').classList.remove('hidden');
}

function resetFacultyForm(){
  document.getElementById('facultyEditId').value = '';
  document.getElementById('facultyName').value = '';
  document.getElementById('facultyShortName').value = '';
  document.getElementById('facultyLoginId').value = '';
  document.getElementById('facultyLoginId').disabled = false;
  document.getElementById('facultyEmail').value = '';
  document.getElementById('facultyWhatsapp').value = '';
  document.getElementById('facultySemester').value = '';
  document.getElementById('facultyDivision').value = '';
  document.getElementById('facultyBatch').value = '';   // it will stay on the "Select batch" placeholder
  currentFacultySelectedSubjectIds = [];
  renderFacultySubjectCheckboxes('', []);
}

// Fills the checkboxes of the selected semester's subjects — only that semester's subjects are shown
function renderFacultySubjectCheckboxes(semester, selectedIds){
  const container = document.getElementById('facultySubjectsContainer');
  if(!container) return;
  const batchEl = document.getElementById('facultyBatch');
  const batch = batchEl ? batchEl.value : '';
  if(!semester){
    container.innerHTML = '<span class="muted">Select a semester to see its subjects…</span>';
    return;
  }
  if(!batch){
    container.innerHTML = '<span class="muted">Select a batch to see its subjects…</span>';
    return;
  }
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem && s.academic_year === batch);

  if(!subjectsForSem.length){
    container.innerHTML = '<span class="muted">No subject was found for this batch/semester.</span>';
    return;
  }

  container.innerHTML = subjectsForSem.map(s => `
    <label class="checkbox-item">
      <input type="checkbox" value="${s.id}" ${selectedIds.includes(s.id) ? 'checked' : ''}>
      ${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})
    </label>
  `).join('');
}

// As soon as the Semester dropdown changes, show that semester's subjects.
// In edit mode, fetch this faculty's already-assigned subjects for that semester from the backend and pre-check them.
async function onFacultySemesterChange(){
  const semester = document.getElementById('facultySemester').value;
  const academicYear = document.getElementById('facultyBatch').value;
  const division = document.getElementById('facultyDivision').value;
  const editId = document.getElementById('facultyEditId').value;

  if(!editId){
    renderFacultySubjectCheckboxes(semester, []);
    return;
  }

  try{
    const res = await apiRequest(`/admin/faculty/${editId}/subjects?semester=${semester}&academic_year=${academicYear}&division=${division}`);
    currentFacultySelectedSubjectIds = res.subject_ids || [];
  }catch(err){
    currentFacultySelectedSubjectIds = [];
  }
  renderFacultySubjectCheckboxes(semester, currentFacultySelectedSubjectIds);
}

// Renders the "Subjects assigned" column as horizontal pills, along with the code
function renderSubjectPills(subjectsAssignedStr){
  if(!subjectsAssignedStr) return '-';
  return `<div class="subject-pills">` + subjectsAssignedStr.split('||').map(entry => {
    const [code, name, sem, division] = entry.split('::');
    const divLabel = division && division !== 'All' ? ` · Division ${division}` : '';
    return `<span class="subject-pill">${escapeHtml(name)} <b>(${escapeHtml(code)})</b> · Sem ${escapeHtml(sem)}${escapeHtml(divLabel)}</span>`;
  }).join('') + `</div>`;
}

async function loadFaculty(){
  const tbody = document.getElementById('facultyTableBody');
  tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';

  const filterYearEl = document.getElementById('facultyFilterYear');
  const params = new URLSearchParams();
  if(filterYearEl && filterYearEl.value) params.set('academic_year', filterYearEl.value);

  try{
    const faculty = await apiRequest('/admin/faculty?' + params.toString());
    if(!faculty.length){
      tbody.innerHTML = '<tr><td colspan="6">No faculty found.</td></tr>';
      return;
    }
    window._facultyCache = new Map(faculty.map(f => [String(f.id), f]));
    tbody.innerHTML = faculty.map(f => `
      <tr>
        <td>${escapeHtml(f.faculty_id)}</td>
        <td>${escapeHtml(f.name)}</td>
        <td>${escapeHtml(f.short_name || '-')}</td>
        <td>${escapeHtml(deptName(f.department))}</td>
        <td class="subjects-col">${renderSubjectPills(f.subjects_assigned)}</td>
        <td class="row-actions">
          <button class="icon-action" onclick="editFacultyById('${f.id}')">✎</button>
          <button class="icon-action danger" onclick="deleteFacultyById('${f.id}')">🗑</button>
        </td>
      </tr>
    `).join('');
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="6">Failed to load faculty: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function saveFaculty(){
  const editId = document.getElementById('facultyEditId').value;
  const checkedSubjectIds = Array.from(
    document.querySelectorAll('#facultySubjectsContainer input[type="checkbox"]:checked')
  ).map(cb => parseInt(cb.value));

  const payload = {
    name: document.getElementById('facultyName').value.trim(),
    short_name: document.getElementById('facultyShortName').value.trim(),   // optional
    faculty_id: document.getElementById('facultyLoginId').value.trim(),
    email: document.getElementById('facultyEmail').value.trim(),
    whatsapp_number: document.getElementById('facultyWhatsapp').value.trim(),
    department: document.getElementById('facultyDept').value,
    subject_ids: checkedSubjectIds,          // more than one subject at once
    semester: document.getElementById('facultySemester').value,
    division: document.getElementById('facultyDivision').value,
    academic_year: document.getElementById('facultyBatch').value
  };

  if(!payload.name || !payload.faculty_id){
    alert('Full name and Faculty ID are required');
    return;
  }
  if(payload.whatsapp_number && !/^\d{10,15}$/.test(payload.whatsapp_number)){
    alert('WhatsApp number must be 10-15 digits (with country code if needed)');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/admin/faculty/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      alert('Faculty updated');
    } else {
      const res = await apiRequest('/admin/faculty', { method: 'POST', body: JSON.stringify(payload) });
      alert(`Faculty added. Default password: ${res.default_password}`);
    }
    toggleForm('facultyForm');
    resetFacultyForm();
    loadFaculty();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function editFaculty(faculty){
  document.getElementById('facultyEditId').value = faculty.id;
  document.getElementById('facultyName').value = faculty.name;
  document.getElementById('facultyShortName').value = faculty.short_name || '';
  document.getElementById('facultyLoginId').value = faculty.faculty_id;
  document.getElementById('facultyLoginId').disabled = true;   // login_id, it can't be edited
  document.getElementById('facultyEmail').value = faculty.email || '';
  document.getElementById('facultyWhatsapp').value = faculty.whatsapp_number || '';
  document.getElementById('facultyDept').value = faculty.department || 'Computer Engineering';

  // Keep the faculty's default semester + batch + division as already assigned (otherwise start from semester 1 / 2024-25 / All)
  const defaultSem = faculty.default_semester || '';
  document.getElementById('facultySemester').value = defaultSem;
  document.getElementById('facultyBatch').value = faculty.default_academic_year || '';
  document.getElementById('facultyDivision').value = faculty.default_division || '';

  document.getElementById('facultyForm').classList.remove('hidden');
  await onFacultySemesterChange();   // this semester's already-assigned subjects will be pre-checked in the checkboxes
}

async function deleteFaculty(id, name){
  if(!confirm(`Delete ${name}?`)) return;
  try{
    await apiRequest(`/admin/faculty/${id}`, { method: 'DELETE' });
    loadFaculty();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

function editFacultyById(id){
  const f = window._facultyCache ? window._facultyCache.get(String(id)) : null;
  if(f) editFaculty(f);
}

function deleteFacultyById(id){
  const f = window._facultyCache ? window._facultyCache.get(String(id)) : null;
  if(f) deleteFaculty(f.id, f.name);
}


// ============================================================
// TIMETABLE MANAGEMENT
// ============================================================
let cachedTimetable = [];
const DAY_LABELS = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday' };
const DAY_ORDER = ['Mon','Tue','Wed','Thu','Fri','Sat'];
// Mon–Fri always; Saturday column only if some slot actually falls on Saturday
function gridDays(slots){
  return DAY_ORDER.filter(d => d !== 'Sat' || slots.some(s => s.day_of_week === 'Sat'));
}
const LUNCH_BREAK_START = '13:30';
const LUNCH_BREAK_END = '14:00';
const LUNCH_BREAK_RANGE = `${LUNCH_BREAK_START}-${LUNCH_BREAK_END}`;

// Timetable time inputs use manual 24-hour HH:MM format.
function populateTimetableTimeOptions(selectedStart = '', selectedEnd = ''){
  const start = document.getElementById('ttStartTime');
  const end = document.getElementById('ttEndTime');
  if(!start || !end) return;
  start.value = selectedStart || '';
  end.value = selectedEnd || '';
}

function onTimetableStartTimeChange(){}

function onTimetableSessionTypeChange(){}

// Converts the 12-hour dropdowns (hour/minute/AM-PM) into a 24-hour "HH:MM" string for the backend
function to24Hour(hour12, minute, period){
  let h = parseInt(hour12, 10);
  if(period === 'AM'){ if(h === 12) h = 0; }
  else { if(h !== 12) h += 12; }
  return String(h).padStart(2, '0') + ':' + minute;
}

// Splits the backend's 24-hour "HH:MM" string into 12-hour dropdown values (hour/minute/period) — to pre-fill the edit form
function to12Hour(time24){
  if(!time24) return { hour: '09', minute: '00', period: 'AM' };
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  let hour12 = h % 12;
  if(hour12 === 0) hour12 = 12;
  return { hour: String(hour12).padStart(2, '0'), minute: String(m).padStart(2, '0'), period };
}

// Turns a 24-hour "HH:MM" into something like "9:00 AM" for display in the table/grid
function formatTime12(time24){
  if(!time24) return '';
  const { hour, minute, period } = to12Hour(time24);
  return `${parseInt(hour, 10)}:${minute} ${period}`;
}

function formatRangeLabel(range){
  const [start, end] = range.split('-');
  return `${formatTime12(start)} - ${formatTime12(end)}`;
}

function openAddTimetableForm(){
  resetTimetableForm();
  document.getElementById('timetableForm').classList.remove('hidden');
}

function resetTimetableForm(){
  document.getElementById('ttEditId').value = '';
  document.getElementById('ttSemester').value = '';
  document.getElementById('ttBatch').value = '';   // it stays on the "Select batch" placeholder, no data shows directly
  document.querySelectorAll('#ttDivisionsContainer input').forEach((cb, i) => cb.checked = (i === 0));  // default: only A checked
  document.getElementById('ttDay').value = 'Mon';
  document.getElementById('ttRoom').value = '';
  document.getElementById('ttSessionType').value = 'Lecture';
  populateTimetableTimeOptions('', '');
  populateTimetableSubjects('', '', '');
  populateTimetableFacultyOptions([]);
}

// Show only the subjects of that batch/semester in the dropdown, according to both Batch + Semester.
// Until a Batch is selected, only "Select batch first" shows — no subject is auto/directly selected.
function populateTimetableSubjects(semester, batch, selectedSubjectId){
  const select = document.getElementById('ttSubject');
  if(!semester){
    select.innerHTML = '<option value="">— Select semester first —</option>';
    populateTimetableFacultyOptions([]);
    return;
  }
  if(!batch){
    select.innerHTML = '<option value="">— Select batch first —</option>';
    populateTimetableFacultyOptions([]);
    return;
  }
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem && s.academic_year === batch);
  const placeholder = `<option value="" ${selectedSubjectId ? '' : 'selected disabled'}>Select subject</option>`;
  select.innerHTML = subjectsForSem.length
    ? placeholder + subjectsForSem.map(s => `<option value="${s.id}" ${String(s.id)===String(selectedSubjectId)?'selected':''}>${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})</option>`).join('')
    : '<option value="" selected disabled>There are no subjects for this batch/semester</option>';
}

function populateTimetableFacultyOptions(facultyList, selectedFacultyId){
  const select = document.getElementById('ttFaculty');
  if(!facultyList.length){
    select.innerHTML = '<option value="">— Select subject first —</option>';
    return;
  }
  const placeholder = `<option value="" ${selectedFacultyId ? '' : 'selected disabled'}>Select faculty</option>`;
  select.innerHTML = placeholder + facultyList.map(f => `<option value="${escapeHtml(f.faculty_id)}" ${String(f.faculty_id)===String(selectedFacultyId)?'selected':''}>${escapeHtml(f.name)}</option>`).join('');
}

function onTimetableBatchChange(){
  populateTimetableSubjects(document.getElementById('ttSemester').value, document.getElementById('ttBatch').value, '');
}

function onTimetableSemesterChange(){
  populateTimetableSubjects(document.getElementById('ttSemester').value, document.getElementById('ttBatch').value, '');
}

// As soon as a subject is selected, show only the faculty who teach that subject in that semester
async function onTimetableSubjectChange(){
  const subjectId = document.getElementById('ttSubject').value;
  const semester = document.getElementById('ttSemester').value;
  if(!subjectId){ populateTimetableFacultyOptions([]); return; }

  try{
    const faculty = await apiRequest(`/admin/timetable/faculty-options?subject_id=${subjectId}&semester=${semester}`);
    populateTimetableFacultyOptions(faculty);
  }catch(err){
    populateTimetableFacultyOptions([]);
  }
}

async function loadTimetable(){
  const tbody = document.getElementById('timetableTableBody');
  try{
    cachedTimetable = await apiRequest('/admin/timetable');
    renderTimetableList();
    renderTimetableGrid();
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="10">Failed to load timetable: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// Renders the "All timetable slots" list, filtered client-side by the batch filter
// (it doesn't fetch again, cachedTimetable already holds all the data — the grid follows the same pattern)
function renderTimetableList(){
  const tbody = document.getElementById('timetableTableBody');
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const filterDay = val('ttListFilterDay');
  const filterSem = val('ttListFilterSem');
  const filterDiv = val('ttListFilterDiv');
  const filterSession = val('ttListFilterSession');
  const filterYear = val('ttListFilterYear');

  const rows = cachedTimetable.filter(t =>
    (!filterDay || t.day_of_week === filterDay) &&
    (!filterSem || String(t.semester) === filterSem) &&
    (!filterDiv || (t.division || '').split(',').map(x => x.trim()).includes(filterDiv)) &&
    (!filterSession || (t.session_type || 'Lecture') === filterSession) &&
    (!filterYear || t.academic_year === filterYear)
  );

  tbody.innerHTML = rows.length ? rows.map(t => `
    <tr>
      <td>${escapeHtml(t.semester)}</td>
      <td>${escapeHtml((t.division || '').split(',').join(', '))}</td>
      <td>${escapeHtml(t.academic_year || '-')}</td>
      <td>${escapeHtml(DAY_LABELS[t.day_of_week] || t.day_of_week)}</td>
      <td>${escapeHtml(formatTime12(t.start_time))} - ${escapeHtml(formatTime12(t.end_time))}</td>
      <td>${escapeHtml(t.subject_name || '-')} ${t.subject_code ? '(' + escapeHtml(t.subject_code) + ')' : ''}</td>
      <td>${escapeHtml(t.session_type || 'Lecture')}</td>
      <td>${escapeHtml(t.faculty_name || '-')}</td>
      <td>${escapeHtml(t.room_no || '-')}</td>
      <td class="row-actions">
        <button class="icon-action" onclick="editTimetableSlotById('${t.id}')">✎</button>
        <button class="icon-action danger" onclick="deleteTimetableSlot(${t.id})">🗑</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="10">No timetable slot was found.</td></tr>';
}

function editTimetableSlotById(id){
  const t = (cachedTimetable || []).find(x => String(x.id) === String(id));
  if(t) editTimetableSlot(t);
}

function resetTimetableListFilters(){
  ['ttListFilterDay','ttListFilterSem','ttListFilterDiv','ttListFilterSession','ttListFilterYear']
    .forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  renderTimetableList();
}

function normalizeTimetableTime(value){
  const v = String(value || '').trim();
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if(hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

async function saveTimetableSlot(){
  const editId = document.getElementById('ttEditId').value;
  const divisions = Array.from(document.querySelectorAll('#ttDivisionsContainer input:checked')).map(cb => cb.value);

  const startTime = normalizeTimetableTime(document.getElementById('ttStartTime').value);
  const endTime = normalizeTimetableTime(document.getElementById('ttEndTime').value);

  const payload = {
    semester: document.getElementById('ttSemester').value,
    divisions: divisions,
    subject_id: document.getElementById('ttSubject').value,
    session_type: document.getElementById('ttSessionType').value,
    faculty_id: document.getElementById('ttFaculty').value,
    day_of_week: document.getElementById('ttDay').value,
    start_time: startTime,
    end_time: endTime,
    room_no: document.getElementById('ttRoom').value.trim(),
    academic_year: document.getElementById('ttBatch').value
  };

  if(!divisions.length){
    alert('Select at least one division');
    return;
  }
  if(!payload.subject_id || !payload.faculty_id){
    alert('Subject and faculty must be selected');
    return;
  }
  if(!startTime || !endTime){
    alert('Enter valid Start Time and End Time in 24-hour HH:MM format (e.g. 14:00 and 16:00)');
    return;
  }
  if(timeToMinutes(endTime) <= timeToMinutes(startTime)){
    alert('End time must be after start time');
    return;
  }
  if(startTime < LUNCH_BREAK_END && endTime > LUNCH_BREAK_START){
    alert('1:30 PM - 2:00 PM is reserved for lunch, so no lecture can be scheduled in this time slot');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/admin/timetable/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      alert('Slot updated');
    } else {
      await apiRequest('/admin/timetable', { method: 'POST', body: JSON.stringify(payload) });
      alert('Slot added');
    }
    toggleForm('timetableForm');
    resetTimetableForm();
    loadTimetable();
  }catch(err){
    alert('Error: ' + err.message);   // on a clash, the backend's own message will be shown
  }
}

async function editTimetableSlot(slot){
  document.getElementById('ttEditId').value = slot.id;
  document.getElementById('ttSemester').value = slot.semester;
  document.getElementById('ttBatch').value = slot.academic_year || '';

  const selectedDivisions = (slot.division || '').split(',');
  document.querySelectorAll('#ttDivisionsContainer input').forEach(cb => {
    cb.checked = selectedDivisions.includes(cb.value);
  });

  document.getElementById('ttDay').value = slot.day_of_week;

  document.getElementById('ttRoom').value = slot.room_no || '';
  document.getElementById('ttSessionType').value = slot.session_type || 'Lecture';
  populateTimetableTimeOptions(slot.start_time, slot.end_time);

  populateTimetableSubjects(slot.semester, slot.academic_year, slot.subject_id);
  try{
    const faculty = await apiRequest(`/admin/timetable/faculty-options?subject_id=${slot.subject_id}&semester=${slot.semester}`);
    populateTimetableFacultyOptions(faculty, slot.faculty_id);
  }catch(err){
    populateTimetableFacultyOptions([]);
  }

  document.getElementById('timetableForm').classList.remove('hidden');
}

async function deleteTimetableSlot(id){
  if(!confirm('Delete this timetable slot?')) return;
  try{
    await apiRequest(`/admin/timetable/${id}`, { method: 'DELETE' });
    loadTimetable();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ---- Exam Timetable (Mid-Sem / Remedial — structured, like the regular timetable) ----
let cachedExamTimetable = [];

function populateExamTtSubjects(semester, selectedSubjectId){
  const select = document.getElementById('examTtSubject');
  if(!select) return;
  const batch = document.getElementById('examTtBatch') ? document.getElementById('examTtBatch').value : '';
  if(!semester){
    select.innerHTML = '<option value="">— Select semester first —</option>';
    return;
  }
  if(!batch){
    select.innerHTML = '<option value="">— Select batch first —</option>';
    return;
  }
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem && s.academic_year === batch);
  const placeholder = `<option value="" ${selectedSubjectId ? '' : 'selected disabled'}>Select subject</option>`;
  select.innerHTML = subjectsForSem.length
    ? placeholder + subjectsForSem.map(s => `<option value="${s.id}" ${String(s.id)===String(selectedSubjectId)?'selected':''}>${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})</option>`).join('')
    : '<option value="" selected disabled>There are no subjects for this batch/semester</option>';
}

function resetExamTtForm(){
  document.getElementById('examTtEditId').value = '';
  document.getElementById('examTtType').value = 'Mid-Sem';
  document.getElementById('examTtSemester').value = '';
  document.getElementById('examTtDivision').value = '';
  document.getElementById('examTtBatch').value = '';   // it will stay on the "Select batch" placeholder
  populateExamTtSubjects('');
  document.getElementById('examTtDate').value = '';
  document.getElementById('examTtStartTime').value = '';
  document.getElementById('examTtEndTime').value = '';
  document.getElementById('examTtRoom').value = '';
}

function openAddExamTimetableForm(){
  resetExamTtForm();
  document.getElementById('examTtForm').classList.remove('hidden');
}

async function loadExamTimetables(){
  const tbody = document.getElementById('examTtTableBody');
  if(!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9">Loading…</td></tr>';
  try{
    cachedExamTimetable = await apiRequest('/admin/exam-timetable');
    renderExamTimetableList();
    if(document.getElementById('ttGridTable')) renderTimetableGrid();
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="9">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderExamTimetableList(){
  const tbody = document.getElementById('examTtTableBody');
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const filterSem = val('examListFilterSem');
  const filterDiv = val('examListFilterDiv');
  const filterBatch = val('examListFilterBatch');

  // A slot with no division applies to all divisions, so it also shows up under Division A / B
  const rows = cachedExamTimetable.filter(r =>
    (!filterSem || String(r.semester) === filterSem) &&
    (!filterDiv || !r.division || r.division === filterDiv) &&
    (!filterBatch || r.academic_year === filterBatch)
  );

  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${escapeHtml(r.exam_type)}</td>
      <td>${escapeHtml(r.exam_date)}</td>
      <td>${escapeHtml(formatTime12(r.start_time))} - ${escapeHtml(formatTime12(r.end_time))}</td>
      <td>${escapeHtml(r.semester)}</td>
      <td>${escapeHtml(r.division || 'All')}</td>
      <td>${escapeHtml(r.academic_year || '-')}</td>
      <td>${r.subject_name ? `${escapeHtml(r.subject_name)} (${escapeHtml(r.subject_code)})` : '-'}</td>
      <td>${escapeHtml(r.room_no || '-')}</td>
      <td class="row-actions">
        <button class="icon-action" onclick="editExamTimetableSlotById('${r.id}')">✎</button>
        <button class="icon-action danger" onclick="deleteExamTimetableSlot(${r.id})">🗑</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="9">There is no exam timetable slot.</td></tr>';
}

function editExamTimetableSlotById(id){
  const r = (cachedExamTimetable || []).find(x => String(x.id) === String(id));
  if(r) editExamTimetableSlot(r);
}

function resetExamListFilters(){
  ['examListFilterSem','examListFilterDiv','examListFilterBatch']
    .forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  renderExamTimetableList();
}

function editExamTimetableSlot(slot){
  document.getElementById('examTtEditId').value = slot.id;
  document.getElementById('examTtType').value = slot.exam_type;
  document.getElementById('examTtSemester').value = slot.semester;
  document.getElementById('examTtDivision').value = slot.division || '';
  document.getElementById('examTtBatch').value = slot.academic_year || '';
  populateExamTtSubjects(slot.semester, slot.subject_id);
  document.getElementById('examTtDate').value = slot.exam_date;
  document.getElementById('examTtRoom').value = slot.room_no || '';

  document.getElementById('examTtStartTime').value = String(slot.start_time || '').slice(0, 5);
  document.getElementById('examTtEndTime').value = String(slot.end_time || '').slice(0, 5);

  document.getElementById('examTtForm').classList.remove('hidden');
}

async function saveExamTimetableSlot(){
  const editId = document.getElementById('examTtEditId').value;
  const startTime = normalizeTimetableTime(document.getElementById('examTtStartTime').value);
  const endTime = normalizeTimetableTime(document.getElementById('examTtEndTime').value);

  const payload = {
    exam_type: document.getElementById('examTtType').value,
    semester: document.getElementById('examTtSemester').value,
    division: document.getElementById('examTtDivision').value || null,
    academic_year: document.getElementById('examTtBatch').value,
    exam_date: document.getElementById('examTtDate').value,
    start_time: startTime,
    end_time: endTime,
    subject_id: document.getElementById('examTtSubject').value || null,
    room_no: document.getElementById('examTtRoom').value.trim()
  };

  if(!payload.exam_date){
    alert('Select the exam date');
    return;
  }
  if(!startTime || !endTime){
    alert('Select a valid Start Time and End Time');
    return;
  }
  if(timeToMinutes(endTime) <= timeToMinutes(startTime)){
    alert('End time must be after the start time');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/admin/exam-timetable/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiRequest('/admin/exam-timetable', { method: 'POST', body: JSON.stringify(payload) });
    }
    toggleForm('examTtForm');
    loadExamTimetables();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function deleteExamTimetableSlot(id){
  if(!confirm('Delete this exam timetable slot?')) return;
  try{
    await apiRequest(`/admin/exam-timetable/${id}`, { method: 'DELETE' });
    loadExamTimetables();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// Builds the grid according to the Semester + Division filter.
// If "ALL" divisions is selected, it builds a merged grid like the uploaded photo (A/B/C sub-columns inside each Day,
// and a combined lecture spans one cell across both divisions).
// If one specific division is selected, it builds a simple Day-wise grid directly.
function renderTimetableGrid(){
  const table = document.getElementById('ttGridTable');
  const gridType = document.getElementById('gridType').value;
  const semester = document.getElementById('gridSemester').value;
  const divisionFilter = document.getElementById('gridDivision').value;
  const batchFilter = document.getElementById('gridBatch')?.value || '';

  if(gridType !== 'Regular'){
    renderExamGrid(table, gridType, semester, divisionFilter);
    return;
  }

  const slotsInSem = cachedTimetable.filter(t =>
    String(t.semester) === String(semester) &&
    (!batchFilter || String(t.academic_year || '') === String(batchFilter))
  );

  if(divisionFilter === 'ALL'){
    document.getElementById('ttGridTitle').textContent = `Sem ${semester} · All divisions${batchFilter ? ' · ' + batchFilter : ''}`;
    renderCombinedDivisionGrid(table, slotsInSem);
  } else {
    document.getElementById('ttGridTitle').textContent = `Sem ${semester} · Division ${divisionFilter}${batchFilter ? ' · ' + batchFilter : ''}`;
    const slots = slotsInSem.filter(t => (t.division || '').split(',').map(x => x.trim()).includes(divisionFilter));
    renderSingleDivisionGrid(table, slots);
  }
}

// Mid-Sem / Remedial exams don't repeat day-wise — they happen once, date-wise,
// so instead of a weekly grid we show a simple date-sorted list for them.
function renderExamGrid(table, examType, semester, divisionFilter){
  document.getElementById('ttGridTitle').textContent = `${examType} · Sem ${semester}${divisionFilter === 'ALL' ? '' : ' · Division ' + divisionFilter}`;

  let slots = cachedExamTimetable.filter(t => t.exam_type === examType && String(t.semester) === String(semester));
  if(divisionFilter !== 'ALL'){
    slots = slots.filter(t => !t.division || t.division === divisionFilter);
  }

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
        <td>${escapeHtml(s.exam_date)}</td>
        <td>${escapeHtml(s.start_time)} - ${escapeHtml(s.end_time)}</td>
        <td>${escapeHtml(s.division || 'All')}</td>
        <td>${s.subject_name ? `${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})` : '-'}</td>
        <td>${escapeHtml(s.room_no || '-')}</td>
      </tr>
    `).join('')}
  `;
}

function timeToMinutes(value){
  const [h,m] = String(value || '').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function minutesToRange(start, end){
  const hhmm = m => `${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`;
  return `${hhmm(start)}-${hhmm(end)}`;
}

// Build a common set of small time rows from all slot boundaries. Long labs/lectures
// are then rendered with rowspan, so an 11:30–1:30 lab occupies the 11:30–12:30
// and 12:30–1:30 rows instead of creating a duplicate 11:30–1:30 row.
function buildGridSegments(slots){
  const boundaries = new Set();
  slots.forEach(s => {
    boundaries.add(timeToMinutes(s.start_time));
    boundaries.add(timeToMinutes(s.end_time));
  });
  boundaries.add(timeToMinutes(LUNCH_BREAK_START));
  boundaries.add(timeToMinutes(LUNCH_BREAK_END));

  const sorted = [...boundaries].filter(Number.isFinite).sort((a,b) => a-b);
  const segments = [];
  for(let i=0;i<sorted.length-1;i++){
    const start = sorted[i], end = sorted[i+1];
    if(end > start) segments.push({start, end, range: minutesToRange(start,end)});
  }
  return segments;
}

function slotForSegment(slots, day, segment, division){
  return slots.find(s =>
    s.day_of_week === day &&
    timeToMinutes(s.start_time) <= segment.start &&
    timeToMinutes(s.end_time) >= segment.end &&
    (!division || (s.division || '').split(',').map(x => x.trim()).includes(division))
  ) || null;
}

function renderSingleDivisionGrid(table, slots){
  if(!slots.length){
    table.innerHTML = '<tr><td class="tt-empty-msg">No timetable slot has been created for this semester/division yet.</td></tr>';
    return;
  }

  const days = gridDays(slots);
  const segments = buildGridSegments(slots);
  let html = '<tr><th class="tt-time-col">Time</th>' + days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('') + '</tr>';

  segments.forEach((segment, rowIndex) => {
    const isLunch = segment.start === timeToMinutes(LUNCH_BREAK_START) && segment.end === timeToMinutes(LUNCH_BREAK_END);
    html += `<tr><td class="tt-time-col">${formatRangeLabel(segment.range)}</td>`;

    if(isLunch){
      html += `<td class="tt-break-cell" colspan="${days.length}">Lunch Break</td></tr>`;
      return;
    }

    days.forEach(day => {
      const match = slotForSegment(slots, day, segment, null);
      if(!match){
        html += '<td class="tt-cell-empty">—</td>';
        return;
      }

      const previousSegment = rowIndex > 0 ? segments[rowIndex - 1] : null;
      const previousMatch = previousSegment && !(previousSegment.start === timeToMinutes(LUNCH_BREAK_START) && previousSegment.end === timeToMinutes(LUNCH_BREAK_END))
        ? slotForSegment(slots, day, previousSegment, null) : null;
      if(previousMatch && String(previousMatch.id) === String(match.id)) return;

      let span = 1;
      for(let j=rowIndex+1;j<segments.length;j++){
        const next = segments[j];
        if(next.start === timeToMinutes(LUNCH_BREAK_START) && next.end === timeToMinutes(LUNCH_BREAK_END)) break;
        const nextMatch = slotForSegment(slots, day, next, null);
        if(nextMatch && String(nextMatch.id) === String(match.id)) span++;
        else break;
      }
      html += `<td class="tt-cell" rowspan="${span}">${cellContent(match)}</td>`;
    });
    html += '</tr>';
  });

  table.innerHTML = html;
}

// All-divisions view: each day has A/B columns. A slot assigned to both A and B
// is horizontally merged; a long slot is vertically merged with rowspan.
function renderCombinedDivisionGrid(table, slots){
  if(!slots.length){
    table.innerHTML = '<tr><td class="tt-empty-msg">No timetable slot has been created for this semester/batch yet.</td></tr>';
    return;
  }

  const usedDivisions = new Set();
  slots.forEach(s => (s.division || '').split(',').map(x => x.trim()).forEach(d => d && usedDivisions.add(d)));
  const divisionCols = ['A','B'].filter(d => usedDivisions.has(d));
  if(!divisionCols.length) divisionCols.push('A','B');

  const days = gridDays(slots);
  const segments = buildGridSegments(slots);
  let html = '<tr><th class="tt-time-col" rowspan="2">Time</th>' +
    days.map(d => `<th colspan="${divisionCols.length}">${DAY_LABELS[d]}</th>`).join('') + '</tr>';
  html += '<tr>' + days.map(() => divisionCols.map(d => `<th class="tt-div-subhead">${d}</th>`).join('')).join('') + '</tr>';

  segments.forEach((segment, rowIndex) => {
    const isLunch = segment.start === timeToMinutes(LUNCH_BREAK_START) && segment.end === timeToMinutes(LUNCH_BREAK_END);
    html += `<tr><td class="tt-time-col">${formatRangeLabel(segment.range)}</td>`;
    if(isLunch){
      html += `<td class="tt-break-cell" colspan="${days.length * divisionCols.length}">Lunch Break</td></tr>`;
      return;
    }

    days.forEach(day => {
      let i = 0;
      while(i < divisionCols.length){
        const div = divisionCols[i];
        const match = slotForSegment(slots, day, segment, div);
        if(!match){
          html += '<td class="tt-cell-empty">—</td>';
          i++;
          continue;
        }

        // Skip a vertically continued cell; its original row already has the rowspan.
        const previousSegment = rowIndex > 0 ? segments[rowIndex - 1] : null;
        const previousMatch = previousSegment && !(previousSegment.start === timeToMinutes(LUNCH_BREAK_START) && previousSegment.end === timeToMinutes(LUNCH_BREAK_END))
          ? slotForSegment(slots, day, previousSegment, div) : null;
        if(previousMatch && String(previousMatch.id) === String(match.id)){
          i++;
          continue;
        }

        // Merge adjacent division columns when the same timetable record covers them.
        let colspan = 1;
        while(i + colspan < divisionCols.length){
          const nextDiv = divisionCols[i + colspan];
          const nextMatch = slotForSegment(slots, day, segment, nextDiv);
          if(nextMatch && String(nextMatch.id) === String(match.id)) colspan++;
          else break;
        }

        let rowspan = 1;
        for(let j=rowIndex+1;j<segments.length;j++){
          const next = segments[j];
          if(next.start === timeToMinutes(LUNCH_BREAK_START) && next.end === timeToMinutes(LUNCH_BREAK_END)) break;
          let same = true;
          for(let k=0;k<colspan;k++){
            const nextMatch = slotForSegment(slots, day, next, divisionCols[i+k]);
            if(!nextMatch || String(nextMatch.id) !== String(match.id)){ same = false; break; }
          }
          if(same) rowspan++;
          else break;
        }

        const combinedClass = colspan > 1 ? ' tt-cell-combined' : '';
        html += `<td class="tt-cell${combinedClass}" colspan="${colspan}" rowspan="${rowspan}">${cellContent(match)}</td>`;
        i += colspan;
      }
    });
    html += '</tr>';
  });

  table.innerHTML = html;
}

function cellContent(slot){
  return `<div class="tt-subject">${escapeHtml(slot.subject_name || '')}</div>` +
    `<div class="tt-session">${escapeHtml(slot.session_type || 'Lecture')}</div>` +
    `<div class="tt-meta">${escapeHtml(slot.faculty_name || '')}${slot.room_no ? ' · ' + escapeHtml(slot.room_no) : ''}</div>`;
}

// ============================================================
// ATTENDANCE MANAGEMENT
// ============================================================
let cachedAttendanceStudents = [];   // marking-view state: [{student_id, enrollment, name, status}]

// Show only the subjects of that batch/semester in the dropdown, according to both Batch + Semester.
// "Select subject" always stays as the first (disabled) option — no subject is directly/auto selected.
function populateAttendanceSubjects(semester, batch){
  const select = document.getElementById('attSubject');
  if(batch === undefined) batch = document.getElementById('attBatch').value;
  if(!semester){
    select.innerHTML = '<option value="" selected disabled>— Select semester first —</option>';
    return;
  }
  if(!batch){
    select.innerHTML = '<option value="" selected disabled>— Select batch first —</option>';
    return;
  }
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem && s.academic_year === batch);
  select.innerHTML = '<option value="" selected disabled>Select subject</option>' +
    '<option value="ALL">All subjects (summary only)</option>' +
    subjectsForSem.map(s => `<option value="${s.id}">${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})</option>`).join('');
}

function getSelectedAttendanceDivisions(){
  return Array.from(document.querySelectorAll('#attDivisionsContainer input:checked')).map(cb => cb.value);
}

function onAttendanceFilterChange(){
  populateAttendanceSubjects(document.getElementById('attSemester').value);
  loadAttendanceList();
  loadAttendanceSummary();
}

function onAttendanceSubjectChange(){
  loadAttendanceList();
  loadAttendanceSummary();
}

async function loadAttendanceList(){
  const tbody = document.getElementById('attendanceTableBody');
  const semester = document.getElementById('attSemester').value;
  const divisions = getSelectedAttendanceDivisions();
  const academicYear = document.getElementById('attBatch').value;
  const subjectId = document.getElementById('attSubject').value;
  const date = document.getElementById('attDate').value;
  const sessionType = document.getElementById('attSessionType').value || 'Lecture';

  if(!divisions.length){
    tbody.innerHTML = '<tr><td colspan="6">Select at least one division.</td></tr>';
    cachedAttendanceStudents = [];
    return;
  }
  if(!subjectId || subjectId === 'ALL' || !date){
    tbody.innerHTML = '<tr><td colspan="6">Select a specific subject and date to mark attendance.</td></tr>';
    cachedAttendanceStudents = [];
    return;
  }

  tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try{
    cachedAttendanceStudents = await apiRequest(
      `/admin/attendance?semester=${semester}&divisions=${divisions.join(',')}&academic_year=${academicYear}&subject_id=${subjectId}&date=${date}&session_type=${sessionType}`
    );
    renderAttendanceRows();
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="6">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// Shows the list filtered by the search box (doesn't reload data, only re-renders)
function renderAttendanceRows(){
  const tbody = document.getElementById('attendanceTableBody');
  const search = (document.getElementById('attSearch').value || '').trim().toLowerCase();

  const filtered = cachedAttendanceStudents.filter(s =>
    !search || s.name.toLowerCase().includes(search) || String(s.enrollment).toLowerCase().includes(search)
  );

  if(!filtered.length){
    tbody.innerHTML = '<tr><td colspan="6">No student was found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const isPresent = s.status === 'present';
    const isAbsent = s.status === 'absent';
    return `
      <tr>
        <td>${escapeHtml(s.enrollment)}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.semester ?? '-')}</td>
        <td>${escapeHtml(s.division)}</td>
        <td>${escapeHtml(s.academic_year || '-')}</td>
        <td>
          <div class="att-toggle">
            <button class="att-btn present ${isPresent ? 'active' : ''}" onclick="setAttendanceStatus(${s.student_id}, 'present')">Present</button>
            <button class="att-btn absent ${isAbsent ? 'active' : ''}" onclick="setAttendanceStatus(${s.student_id}, 'absent')">Absent</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// The Present/Absent button sets the status directly (not a toggle) — it makes editing old attendance easy
function setAttendanceStatus(studentId, status){
  const student = cachedAttendanceStudents.find(s => s.student_id === studentId);
  if(!student) return;
  student.status = status;
  renderAttendanceRows();
}

function markAllPresent(){
  if(!cachedAttendanceStudents.length){
    alert('First select Semester, Division(s), Subject, and Date');
    return;
  }
  cachedAttendanceStudents.forEach(s => s.status = 'present');
  renderAttendanceRows();
}

async function saveAttendance(){
  const subjectId = document.getElementById('attSubject').value;
  const date = document.getElementById('attDate').value;
  const sessionType = document.getElementById('attSessionType').value || 'Lecture';

  if(!subjectId || subjectId === 'ALL' || !date){
    alert('Subject and date must be selected');
    return;
  }

  const records = cachedAttendanceStudents
    .filter(s => s.status === 'present' || s.status === 'absent')
    .map(s => ({ student_id: s.student_id, status: s.status }));

  if(!records.length){
    alert('Mark the status of at least one student (click Present/Absent)');
    return;
  }

  try{
    await apiRequest('/admin/attendance', {
      method: 'POST',
      body: JSON.stringify({ subject_id: subjectId, session_type: sessionType, date, records })
    });
    alert('Attendance saved');
    loadAttendanceSummary();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// Overall attendance % of each student — the row is highlighted red if it is below 75%
let attSummarySnap = '';
async function loadAttendanceSummary(silent){
  silent = (silent === true);   // background refresh: na "Loading…" flash, na error se purani table hatani
  const tbody = document.getElementById('attendanceSummaryBody');
  const semester = document.getElementById('attSemester').value;
  const divisions = getSelectedAttendanceDivisions();
  const academicYear = document.getElementById('attBatch').value;
  const subjectId = document.getElementById('attSubject').value || 'ALL';

  if(!semester){
    tbody.innerHTML = '<tr><td colspan="9">Select a semester to view attendance summary.</td></tr>';
    return;
  }
  if(!divisions.length){
    tbody.innerHTML = '<tr><td colspan="9">Select at least one division.</td></tr>';
    return;
  }

  if(!silent) tbody.innerHTML = '<tr><td colspan="9">Loading…</td></tr>';
  try{
    const reqKey = `${semester}|${divisions.join(',')}|${academicYear}|${subjectId}`;
    const summary = await apiRequest(
      `/admin/attendance/summary?semester=${semester}&divisions=${divisions.join(',')}&academic_year=${academicYear}&subject_id=${subjectId}`
    );
    const snap = reqKey + '|' + JSON.stringify(summary);
    if(silent && snap === attSummarySnap) return;   // kuch badla nahi
    attSummarySnap = snap;

    window._attSummaryStudents = summary;
    tbody.innerHTML = summary.length ? summary.map(s => {
      const total = s.total_classes || 0;
      const present = s.present_classes || 0;
      const pct = total > 0 ? Math.round((present / total) * 100) : null;
      const isLow = pct !== null && pct < 75;
      const calendarCell = subjectId !== 'ALL'
        ? `<button class="icon-action" onclick="openAttendanceCalendarById('${s.student_id}')" title="View calendar">📅</button>`
        : `<span style="color:var(--muted); font-size:12px;" title="Select a specific subject to view the calendar">—</span>`;
      return `
        <tr class="${isLow ? 'tt-low-attendance' : ''}">
          <td>${escapeHtml(s.enrollment)}</td>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.semester ?? '-')}</td>
          <td>${escapeHtml(s.division)}</td>
          <td>${escapeHtml(s.academic_year || '-')}</td>
          <td>${total}</td>
          <td>${present}</td>
          <td>${pct !== null ? pct + '%' : '—'}${isLow ? ` <small style="color:var(--muted);">· needs ${Math.ceil((75 * total - 100 * present) / 25)} more</small>` : ''}</td>
          <td>${calendarCell}</td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="9">No student was found.</td></tr>';
  }catch(err){
    if(silent) return;
    tbody.innerHTML = `<tr><td colspan="9">Failed to load summary: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// E-mails the students of the selected class (and their parents) who are below the minimum attendance.
// Students already alerted in the last 7 days are skipped by the backend.
async function notifyAttendanceShortage(){
  const semester = document.getElementById('attSemester').value;
  const divisions = getSelectedAttendanceDivisions();
  const academicYear = document.getElementById('attBatch').value;
  if(!semester){ alert('Select a semester first.'); return; }
  if(!divisions.length){ alert('Select at least one division.'); return; }
  if(!confirm('E-mail every student of this class who is below the minimum attendance (and their parents)?\nStudents already alerted in the last 7 days are skipped.')) return;

  const btn = document.getElementById('attNotifyBtn');
  const oldText = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = 'Sending…'; }
  try{
    const res = await apiRequest('/admin/attendance/shortage/notify', {
      method: 'POST',
      body: JSON.stringify({ semester, divisions, academic_year: academicYear })
    });
    alert(res.message);
  }catch(err){
    alert('Alerts could not be sent: ' + err.message);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = oldText; }
  }
}

// ---- Attendance Calendar modal ----
let attCalendarState = { studentId: null, studentName: '', year: 0, month: 0 };
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAY_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

function openAttendanceCalendar(studentId, studentName){
  const now = new Date();
  attCalendarState = { studentId, studentName, year: now.getFullYear(), month: now.getMonth() + 1 };
  document.getElementById('attCalendarTitle').textContent = `${studentName} — Attendance Calendar`;
  document.getElementById('attCalendarOverlay').classList.add('open');
  loadAttendanceCalendar();
}

function openAttendanceCalendarById(studentId){
  const s = (window._attSummaryStudents || []).find(x => String(x.student_id) === String(studentId));
  const name = s ? s.name : 'Student';
  openAttendanceCalendar(studentId, name);
}

function closeAttendanceCalendar(){
  document.getElementById('attCalendarOverlay').classList.remove('open');
}

function changeAttendanceCalendarMonth(delta){
  attCalendarState.month += delta;
  if(attCalendarState.month > 12){ attCalendarState.month = 1; attCalendarState.year++; }
  if(attCalendarState.month < 1){ attCalendarState.month = 12; attCalendarState.year--; }
  loadAttendanceCalendar();
}

let attCalSnap = '';
async function loadAttendanceCalendar(silent){
  silent = (silent === true);
  const grid = document.getElementById('attCalendarGrid');
  const { studentId, year, month } = attCalendarState;
  const subjectId = document.getElementById('attSubject').value || 'ALL';

  document.getElementById('attCalendarMonthLabel').textContent = `${MONTH_NAMES[month - 1]} ${year}`;
  if(!silent) grid.innerHTML = 'Loading…';

  try{
    const records = await apiRequest(`/admin/attendance/calendar?student_id=${studentId}&subject_id=${subjectId}&year=${year}&month=${month}`);
    const calSnap = `${studentId}|${subjectId}|${year}|${month}|` + JSON.stringify(records);
    if(silent && calSnap === attCalSnap) return;
    attCalSnap = calSnap;
    const statusByDate = {};
    records.forEach(r => statusByDate[r.attendance_date] = r.status);

    const daysInMonth = new Date(year, month, 0).getDate();
    const startWeekday = new Date(year, month - 1, 1).getDay();   // 0=Sunday

    let html = '<div class="att-cal-weekdays">' + WEEKDAY_LABELS.map(d => `<div>${d}</div>`).join('') + '</div>';
    html += '<div class="att-cal-days">';
    for(let i = 0; i < startWeekday; i++) html += '<div class="att-cal-day empty"></div>';
    for(let d = 1; d <= daysInMonth; d++){
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const status = statusByDate[dateStr];
      const cls = status === 'present' ? 'present' : (status === 'absent' ? 'absent' : 'none');
      html += `<div class="att-cal-day ${cls}">${d}</div>`;
    }
    html += '</div>';
    grid.innerHTML = html;
  }catch(err){
    if(silent) return;
    grid.innerHTML = `Failed to load: ${escapeHtml(err.message)}`;
  }
}


// ---- Promote Semester ----
let promoteStudentsCache = [];

async function loadPromoteList(){
  const dept = document.getElementById('promoteDept').value;
  const sem = document.getElementById('promoteSem').value;
  const year = document.getElementById('promoteYear').value;

  if(!dept || !sem || !year){
    alert('Select the department, current semester, and batch');
    return;
  }
  if(sem === '6' && !confirm('Promoting Sem 6 students will mark them as "graduated" (inactive); their semester will not change. Continue?')){
    return;
  }

  const params = new URLSearchParams({ department: dept, semester: sem, academic_year: year });
  const listCard = document.getElementById('promoteListCard');
  const tbody = document.getElementById('promoteTableBody');

  try{
    const students = await apiRequest('/admin/students?' + params.toString());
    promoteStudentsCache = students;
    if(!students.length){
      tbody.innerHTML = '<tr><td colspan="6">No students were found for this criteria.</td></tr>';
    } else {
      tbody.innerHTML = students.map(s => `
        <tr>
          <td><input type="checkbox" class="promote-check" value="${s.id}" checked></td>
          <td>${escapeHtml(s.enrollment)}</td>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.semester)}</td>
          <td>${escapeHtml(s.division || '-')}</td>
          <td>${escapeHtml(s.academic_year || '-')}</td>
        </tr>
      `).join('');
    }
    listCard.style.display = 'block';

    // If the term (odd/even) of the new semester is already set within some date range
    // (according to today's date), pre-fill that in the promote form —
    // so that the admin doesn't overwrite it by mistake.
    const startEl = document.getElementById('promoteTermStart');
    const endEl = document.getElementById('promoteTermEnd');
    if(sem === '6'){
      startEl.value = '';
      endEl.value = '';
    } else {
      const targetSem = parseInt(sem) + 1;
      try{
        const termInfo = await apiRequest(`/admin/academic-years/term-dates?semester=${targetSem}`);
        startEl.value = termInfo.start || '';
        endEl.value = termInfo.end || '';
      }catch(err){
        startEl.value = '';
        endEl.value = '';
      }
    }
  }catch(err){
    alert('Error loading students: ' + err.message);
  }
}

function toggleSelectAllPromote(checkbox){
  document.querySelectorAll('.promote-check').forEach(c => c.checked = checkbox.checked);
}

async function confirmPromote(){
  const selected = Array.from(document.querySelectorAll('.promote-check:checked')).map(c => parseInt(c.value));
  if(!selected.length){
    alert('Select at least one student');
    return;
  }

  const currentSem = document.getElementById('promoteSem').value;
  const termStart = document.getElementById('promoteTermStart').value;
  const termEnd = document.getElementById('promoteTermEnd').value;

  // Sem 6 students only graduate — no date of a new term is needed for them
  if(currentSem !== '6'){
    if(!termStart || !termEnd){
      alert('Enter both the new semester Term Start Date and End Date — promotion cannot continue without them');
      return;
    }
    if(termStart > termEnd){
      alert('Term start date must be before the end date');
      return;
    }
  }

  if(!confirm(`Promote ${selected.length} student(s)? This cannot be undone.`)) return;

  try{
    const res = await apiRequest('/admin/students/promote', {
      method: 'POST',
      body: JSON.stringify({ student_ids: selected, term_start_date: termStart || null, term_end_date: termEnd || null })
    });
    alert(res.message);
    document.getElementById('promoteListCard').style.display = 'none';
    document.getElementById('promoteTermStart').value = '';
    document.getElementById('promoteTermEnd').value = '';
    promoteStudentsCache = [];
    loadStudents();   // refresh the student list view right away, so the new semester shows immediately
  }catch(err){
    alert('Error promoting students: ' + err.message);
  }
}

// ---- View switching ----
function switchView(name){
  if(name === 'chat') loadMyChatHistory();
  if(name === 'holidays'){ loadHolidays(); loadCancelledSessions(); }
  document.querySelectorAll('.nav-item').forEach(i=> i.classList.toggle('active', i.dataset.view===name));
  document.querySelectorAll('.nav-sub-item').forEach(i=> i.classList.toggle('active', i.dataset.view===name));
  document.querySelectorAll('.view').forEach(v=> v.classList.toggle('active', v.id==='view-'+name));
  if(name === 'notices'){
    loadNotices();
    if(adminNoticeGroup){
      nfScrollToBottom('noticesListBody', false);
      if(nfGroupNotices(adminNoticeGroup).some(n => !n.is_read)) markNoticeGroupRead(adminNoticeGroup);
    }
  }
}

// ============================================================
// HOLIDAYS — /admin/holidays
// A holiday is not a "held" class: faculty are not asked for attendance and
// student percentage is not affected.
// ============================================================
function holEsc(v){
  return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadHolidays(){
  const tbody = document.getElementById('holidaysTableBody');
  if(!tbody) return;
  try{
    const rows = await apiRequest('/admin/holidays');
    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="4">No holidays added yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(h => {
      const scope = !h.semester ? 'Whole college'
        : (h.division ? `Sem ${h.semester} · Div ${holEsc(h.division)}` : `Sem ${h.semester} · All divisions`);
      return `<tr>
        <td>${holEsc(h.holiday_date)}</td>
        <td>${holEsc(h.name)}</td>
        <td>${scope}</td>
        <td><button class="btn-ghost" onclick="deleteHoliday(${h.id})">Delete</button></td>
      </tr>`;
    }).join('');
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="4">Holidays could not be loaded: ${holEsc(err.message)}</td></tr>`;
  }
}

async function addHoliday(){
  const holiday_date = document.getElementById('holDate').value;
  const name = document.getElementById('holName').value.trim();
  const semester = document.getElementById('holSemester').value;
  const division = document.getElementById('holDivision').value.trim().toUpperCase();
  if(!holiday_date || !name){ alert('Date and holiday name are required.'); return; }
  try{
    await apiRequest('/admin/holidays', {
      method: 'POST',
      body: JSON.stringify({ holiday_date, name, semester: semester || null, division: division || null })
    });
    document.getElementById('holName').value = '';
    document.getElementById('holDivision').value = '';
    loadHolidays();
  }catch(err){
    alert(err.message);
  }
}

async function deleteHoliday(id){
  if(!confirm('Delete this holiday? Lectures on that day will count as held again.')) return;
  try{
    await apiRequest('/admin/holidays/' + id, { method: 'DELETE' });
    loadHolidays();
  }catch(err){
    alert(err.message);
  }
}

async function loadCancelledSessions(){
  const tbody = document.getElementById('cancelledSessionsBody');
  if(!tbody) return;
  try{
    const rows = await apiRequest('/admin/cancelled-sessions');
    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="7">No cancelled lectures.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `<tr>
      <td>${holEsc(r.session_date)}</td>
      <td>${holEsc(r.subject_name)}</td>
      <td>${holEsc(r.session_type)}</td>
      <td>Sem ${r.semester} · Div ${holEsc(r.division || 'All')}</td>
      <td>${holEsc(r.faculty_name)}</td>
      <td>${holEsc(r.reason)}</td>
      <td><button class="btn-ghost" data-date="${escapeHtml(r.session_date)}" onclick="adminUncancel(${Number(r.timetable_id)}, this.dataset.date)">Undo</button></td>
    </tr>`).join('');
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="7">Could not be loaded: ${holEsc(err.message)}</td></tr>`;
  }
}

async function adminUncancel(timetableId, date){
  if(!confirm('Undo this cancellation? The lecture will count as held again.')) return;
  try{
    await apiRequest('/admin/session-uncancel', {
      method: 'POST',
      body: JSON.stringify({ timetable_id: timetableId, date })
    });
    loadCancelledSessions();
  }catch(err){
    alert(err.message);
  }
}

// ---- Top-level nav items (Dashboard) ----
document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click', ()=>{
    switchView(item.dataset.view);
    if(window.innerWidth <= 860) closeSidebar();
  });
});

// ---- Collapsible nav groups (Student Management, Faculty Management, etc.) ----
function toggleGroup(headEl){
  const group = headEl.closest('.nav-group');
  const wasOpen = group.classList.contains('open');
  // Close all other groups (accordion behaviour) then toggle this one
  document.querySelectorAll('.nav-group.open').forEach(g => { if(g !== group) g.classList.remove('open'); });
  group.classList.toggle('open', !wasOpen);
}

// ---- Nav sub-items (Add Student, View Students, etc.) ----
document.querySelectorAll('.nav-sub-item').forEach(item=>{
  item.addEventListener('click', (e)=>{
    e.stopPropagation();
    switchView(item.dataset.view);
    if(item.dataset.view === 'chatbot') showChatbotTab(item.dataset.tab || 'faq');
    if(window.innerWidth <= 860) closeSidebar();

    // If this sub-item is an "Add" action, open the matching inline form
    if(item.dataset.action === 'add'){
      const formId = item.dataset.view + 'Form';
      const form = document.getElementById(formId);
      if(form) form.classList.remove('hidden');
      if(item.dataset.view === 'notices'){
        openNoticeGroup('all');
        setTimeout(() => { const box = document.getElementById('noticeContent'); if(box) box.focus(); }, 50);
      }
    }
  });
});

// ---- Inline Add/Edit form toggle ----
function toggleForm(id){
  const form = document.getElementById(id);
  if(form) form.classList.toggle('hidden');
}

// ============================================================
// AI CHATBOT MANAGEMENT (FAQ / Knowledge Base / Chat History)
// ============================================================
let cachedFaqs = [];
let cachedKb = [];
let chatHistoryTimer = null;

function showChatbotTab(tab){
  const tabs = ['faq', 'kb', 'history'];
  document.querySelectorAll('#view-chatbot .pill-tab').forEach((t, i) => t.classList.toggle('active', tabs[i] === tab));
  document.getElementById('chatbotFaq').classList.toggle('hidden', tab !== 'faq');
  document.getElementById('chatbotKb').classList.toggle('hidden', tab !== 'kb');
  document.getElementById('chatbotHistory').classList.toggle('hidden', tab !== 'history');
  if(tab === 'faq') loadFaqs();
  if(tab === 'kb') loadKb();
  if(tab === 'history') loadChatHistory();
}

function setChatbotTab(btn, tab){
  showChatbotTab(tab);
}

function shortText(str, max){
  const t = String(str ?? '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// ---- FAQ ----
async function loadFaqs(){
  const tbody = document.getElementById('faqTableBody');
  tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
  try{
    cachedFaqs = await apiRequest('/admin/chatbot/faqs');
    renderFaqs();
  }catch(err){
    tbody.innerHTML = '<tr><td colspan="4">Failed to load FAQs</td></tr>';
  }
}

function renderFaqs(){
  const tbody = document.getElementById('faqTableBody');
  const q = document.getElementById('faqSearch').value.trim().toLowerCase();
  const rows = cachedFaqs.filter(f => !q ||
    (f.question || '').toLowerCase().includes(q) ||
    (f.answer || '').toLowerCase().includes(q) ||
    (f.category || '').toLowerCase().includes(q));
  if(!rows.length){
    tbody.innerHTML = '<tr><td colspan="4">No FAQs found.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(f => `
    <tr>
      <td>${escapeHtmlMR(f.question)}</td>
      <td>${escapeHtmlMR(shortText(f.answer, 120))}</td>
      <td>${escapeHtmlMR(f.category || '-')}</td>
      <td class="row-actions">
        <button class="icon-action" onclick="editFaq(${f.id})">✎</button>
        <button class="icon-action danger" onclick="deleteFaq(${f.id})">🗑</button>
      </td>
    </tr>`).join('');
}

function openFaqForm(){
  document.getElementById('faqEditId').value = '';
  document.getElementById('faqQuestion').value = '';
  document.getElementById('faqAnswer').value = '';
  document.getElementById('faqCategory').value = '';
  document.getElementById('faqFormTitle').textContent = 'Add FAQ';
  document.getElementById('faqForm').classList.remove('hidden');
  document.getElementById('faqQuestion').focus();
}

function closeFaqForm(){
  document.getElementById('faqForm').classList.add('hidden');
}

function editFaq(id){
  const f = cachedFaqs.find(x => x.id === id);
  if(!f) return;
  document.getElementById('faqEditId').value = f.id;
  document.getElementById('faqQuestion').value = f.question || '';
  document.getElementById('faqAnswer').value = f.answer || '';
  document.getElementById('faqCategory').value = f.category || '';
  document.getElementById('faqFormTitle').textContent = 'Edit FAQ';
  document.getElementById('faqForm').classList.remove('hidden');
  document.getElementById('faqForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveFaq(){
  const editId = document.getElementById('faqEditId').value;
  const payload = {
    question: document.getElementById('faqQuestion').value.trim(),
    answer: document.getElementById('faqAnswer').value.trim(),
    category: document.getElementById('faqCategory').value.trim()
  };
  if(!payload.question || !payload.answer){
    alert('Question and answer are both required');
    return;
  }
  try{
    if(editId){
      await apiRequest(`/admin/chatbot/faqs/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiRequest('/admin/chatbot/faqs', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeFaqForm();
    loadFaqs();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function deleteFaq(id){
  const f = cachedFaqs.find(x => x.id === id);
  if(!confirm(`Delete this FAQ?\n\n${f ? f.question : ''}`)) return;
  try{
    await apiRequest(`/admin/chatbot/faqs/${id}`, { method: 'DELETE' });
    loadFaqs();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ---- Knowledge base ----
async function loadKb(){
  const tbody = document.getElementById('kbTableBody');
  tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
  try{
    cachedKb = await apiRequest('/admin/chatbot/knowledge');
    renderKb();
  }catch(err){
    tbody.innerHTML = '<tr><td colspan="4">Failed to load knowledge base</td></tr>';
  }
}

function renderKb(){
  const tbody = document.getElementById('kbTableBody');
  const q = document.getElementById('kbSearch').value.trim().toLowerCase();
  const rows = cachedKb.filter(k => !q ||
    (k.title || '').toLowerCase().includes(q) ||
    (k.content || '').toLowerCase().includes(q));
  if(!rows.length){
    tbody.innerHTML = '<tr><td colspan="4">No knowledge entries found.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(k => `
    <tr>
      <td>${escapeHtmlMR(k.title)}</td>
      <td>${escapeHtmlMR(shortText(k.content, 140))}</td>
      <td>${formatDateTime(k.created_at)}</td>
      <td class="row-actions">
        <button class="icon-action" onclick="editKb(${k.id})">✎</button>
        <button class="icon-action danger" onclick="deleteKb(${k.id})">🗑</button>
      </td>
    </tr>`).join('');
}

function openKbForm(){
  document.getElementById('kbEditId').value = '';
  document.getElementById('kbTitle').value = '';
  document.getElementById('kbContent').value = '';
  document.getElementById('kbFormTitle').textContent = 'Add knowledge entry';
  document.getElementById('kbForm').classList.remove('hidden');
  document.getElementById('kbTitle').focus();
}

function closeKbForm(){
  document.getElementById('kbForm').classList.add('hidden');
}

function editKb(id){
  const k = cachedKb.find(x => x.id === id);
  if(!k) return;
  document.getElementById('kbEditId').value = k.id;
  document.getElementById('kbTitle').value = k.title || '';
  document.getElementById('kbContent').value = k.content || '';
  document.getElementById('kbFormTitle').textContent = 'Edit knowledge entry';
  document.getElementById('kbForm').classList.remove('hidden');
  document.getElementById('kbForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveKb(){
  const editId = document.getElementById('kbEditId').value;
  const payload = {
    title: document.getElementById('kbTitle').value.trim(),
    content: document.getElementById('kbContent').value.trim()
  };
  if(!payload.title || !payload.content){
    alert('Title and content are both required');
    return;
  }
  try{
    if(editId){
      await apiRequest(`/admin/chatbot/knowledge/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiRequest('/admin/chatbot/knowledge', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeKbForm();
    loadKb();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function deleteKb(id){
  const k = cachedKb.find(x => x.id === id);
  if(!confirm(`Delete the knowledge entry "${k ? k.title : ''}"?`)) return;
  try{
    await apiRequest(`/admin/chatbot/knowledge/${id}`, { method: 'DELETE' });
    loadKb();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ---- Chat history ----
function debounceChatHistory(){
  clearTimeout(chatHistoryTimer);
  chatHistoryTimer = setTimeout(loadChatHistory, 300);
}

async function loadChatHistory(){
  const tbody = document.getElementById('chatHistoryBody');
  tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  const search = document.getElementById('historySearch').value.trim();
  try{
    const rows = await apiRequest('/admin/chatbot/history' + (search ? `?search=${encodeURIComponent(search)}` : ''));
    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="6">No chats found.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${escapeHtmlMR(r.user_name || 'Deleted user')}${r.login_id ? ` <span style="color:var(--muted);font-size:12px;">(${escapeHtmlMR(r.login_id)})</span>` : ''}</td>
        <td>${escapeHtmlMR(r.role || '-')}</td>
        <td>${escapeHtmlMR(shortText(r.message, 100))}</td>
        <td>${escapeHtmlMR(shortText(r.response, 120))}</td>
        <td>${formatDateTime(r.created_at)}</td>
        <td class="row-actions"><button class="icon-action danger" onclick="deleteChatHistory(${r.id})">🗑</button></td>
      </tr>`).join('');
  }catch(err){
    tbody.innerHTML = '<tr><td colspan="6">Failed to load chat history</td></tr>';
  }
}

async function deleteChatHistory(id){
  if(!confirm('Delete this chat?')) return;
  try{
    await apiRequest(`/admin/chatbot/history/${id}`, { method: 'DELETE' });
    loadChatHistory();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function clearChatHistory(){
  if(!confirm('Delete ALL chat history? This cannot be undone.')) return;
  try{
    await apiRequest('/admin/chatbot/history', { method: 'DELETE' });
    loadChatHistory();
  }catch(err){
    alert('Error: ' + err.message);
  }
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
  localStorage.setItem('darkMode', isDark ? 'true' : 'false');   // remember it even after a refresh/navigation
}

function applyStoredDarkMode(){
  const isDark = localStorage.getItem('darkMode') === 'true';
  if(isDark){
    document.body.classList.add('dark');
    document.getElementById('darkBtn').textContent = '☀';
    const t = document.getElementById('settingsDarkToggle');
    if(t) t.checked = true;
  }
}
// ============================================================
// NOTES MANAGEMENT
// ============================================================
let cachedNotes = [];

function populateNoteSubjects(semester, selectedSubjectId){
  const select = document.getElementById('noteSubject');
  if(!select) return;
  const batch = document.getElementById('noteBatch') ? document.getElementById('noteBatch').value : '';
  if(!semester){
    select.innerHTML = '<option value="">— Select semester first —</option>';
    return;
  }
  if(!batch){
    select.innerHTML = '<option value="">— Select batch first —</option>';
    return;
  }
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem && s.academic_year === batch);
  const placeholder = `<option value="" ${selectedSubjectId ? '' : 'selected disabled'}>Select subject</option>`;
  select.innerHTML = subjectsForSem.length
    ? placeholder + subjectsForSem.map(s => `<option value="${s.id}" ${String(s.id)===String(selectedSubjectId)?'selected':''}>${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})</option>`).join('')
    : '<option value="" selected disabled>There are no subjects for this batch/semester</option>';
}

function populateNoteFilterSubjects(semester){
  const select = document.getElementById('noteFilterSubject');
  if(!select) return;
  const current = select.value;
  let subjectsForSem = cachedSubjects;
  if(semester){
    const sem = parseInt(semester);
    subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem);
  }
  select.innerHTML = '<option value="ALL">All subjects</option>' +
    subjectsForSem.map(s => `<option value="${s.id}">${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})</option>`).join('');
  if(current && [...select.options].some(o => o.value === current)) select.value = current;
}

function onNoteFilterChange(){
  populateNoteFilterSubjects(document.getElementById('noteFilterSemester').value);
  loadNotes();
}

function openAddNoteForm(){
  resetNoteForm();
  document.getElementById('notesFormTitle').textContent = 'Upload notes / PDF';
  document.getElementById('noteFileField').style.display = '';
  document.getElementById('notesForm').classList.remove('hidden');
}

function resetNoteForm(){
  document.getElementById('noteEditId').value = '';
  document.getElementById('noteTitle').value = '';
  document.getElementById('noteSemester').value = '';
  document.getElementById('noteDivision').value = '';
  document.getElementById('noteBatch').value = '';   // it will stay on the "Select batch" placeholder
  populateNoteSubjects('');
  document.getElementById('noteDescription').value = '';
  const fileInput = document.getElementById('noteFile');
  if(fileInput) fileInput.value = '';
}

function closeNoteForm(){
  document.getElementById('notesForm').classList.add('hidden');
}

function editNote(note){
  document.getElementById('noteEditId').value = note.id;
  document.getElementById('noteTitle').value = note.title;
  document.getElementById('noteSemester').value = note.semester;
  document.getElementById('noteDivision').value = note.division || '';
  document.getElementById('noteBatch').value = note.academic_year || '';
  populateNoteSubjects(note.semester, note.subject_id);
  document.getElementById('noteDescription').value = note.description || '';
  document.getElementById('notesFormTitle').textContent = 'Edit note details';
  document.getElementById('noteFileField').style.display = 'none';   // editing changes only the details, the file is not replaced
  document.getElementById('notesForm').classList.remove('hidden');
}

async function saveNote(){
  const editId = document.getElementById('noteEditId').value;
  const title = document.getElementById('noteTitle').value.trim();
  const subjectId = document.getElementById('noteSubject').value;
  const semester = document.getElementById('noteSemester').value;
  const division = document.getElementById('noteDivision').value;
  const academicYear = document.getElementById('noteBatch').value;
  const description = document.getElementById('noteDescription').value.trim();

  if(!title || !subjectId){
    alert('Title and Subject are required');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/admin/notes/${editId}`, {
        method: 'PUT',
        body: JSON.stringify({ title, subject_id: subjectId, semester, division, academic_year: academicYear, description })
      });
    }else{
      const fileInput = document.getElementById('noteFile');
      const file = fileInput.files[0];
      if(!file){
        alert('Select a file');
        return;
      }
      if(file.size > 10 * 1024 * 1024){
        alert('The file is larger than 10MB. Please upload a smaller file');
        return;
      }
      const formData = new FormData();
      formData.append('title', title);
      formData.append('subject_id', subjectId);
      formData.append('semester', semester);
      formData.append('division', division);
      formData.append('academic_year', academicYear);
      formData.append('description', description);
      formData.append('file', file);
      await apiUpload('/admin/notes', formData);
    }
    closeNoteForm();
    loadNotes();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

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

async function loadNotes(){
  const tbody = document.getElementById('notesTableBody');
  const semester = document.getElementById('noteFilterSemester').value;
  const subjectId = document.getElementById('noteFilterSubject').value;
  const academicYear = document.getElementById('noteFilterYear').value;
  const search = document.getElementById('noteSearch').value.trim();

  tbody.innerHTML = '<tr><td colspan="9">Loading…</td></tr>';
  try{
    const params = new URLSearchParams();
    if(semester) params.set('semester', semester);
    if(subjectId && subjectId !== 'ALL') params.set('subject_id', subjectId);
    if(academicYear) params.set('academic_year', academicYear);
    if(search) params.set('search', search);

    cachedNotes = await apiRequest(`/admin/notes?${params.toString()}`);

    tbody.innerHTML = cachedNotes.length ? cachedNotes.map(n => `
      <tr>
        <td>${fileIcon(n.file_type)} ${escapeHtml(n.title)}</td>
        <td>${escapeHtml(n.subject_name || '-')}</td>
        <td>${escapeHtml(n.semester)}</td>
        <td>${escapeHtml(n.division || 'All')}</td>
        <td>${escapeHtml(n.academic_year || '-')}</td>
        <td>${escapeHtml(n.file_name)}</td>
        <td>${escapeHtml(formatFileSize(n.file_size))}</td>
        <td>${escapeHtml(new Date(n.uploaded_at).toLocaleDateString('en-IN'))}</td>
        <td class="row-actions">
          <button class="icon-action" onclick="downloadNoteById('${n.id}')" title="Download">⬇</button>
          <button class="icon-action" onclick="editNoteById('${n.id}')" title="Edit">✎</button>
          <button class="icon-action danger" onclick="deleteNoteById('${n.id}')" title="Delete">🗑</button>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="9">No notes were found.</td></tr>';
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="9">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function downloadNoteById(id){
  const n = (cachedNotes || []).find(x => String(x.id) === String(id));
  if(n) downloadNote(n.id, n.file_name);
}
function editNoteById(id){
  const n = (cachedNotes || []).find(x => String(x.id) === String(id));
  if(n) editNote(n);
}
function deleteNoteById(id){
  const n = (cachedNotes || []).find(x => String(x.id) === String(id));
  if(n) deleteNote(n.id, n.title);
}

async function deleteNote(id, title){
  if(!confirm(`Delete the note "${title}"? The file will also be permanently deleted.`)) return;
  try{
    await apiRequest(`/admin/notes/${id}`, { method: 'DELETE' });
    loadNotes();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function downloadNote(id, fileName){
  try{
    const res = await fetch(API_BASE + `/admin/notes/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_admin') }
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
// ASSIGNMENT MANAGEMENT
// ============================================================
let cachedAssignments = [];

function populateAssignmentSubjects(semester, selectedSubjectId){
  const select = document.getElementById('assignSubject');
  if(!select) return;
  const batch = document.getElementById('assignBatch') ? document.getElementById('assignBatch').value : '';
  if(!semester){
    select.innerHTML = '<option value="">— Select semester first —</option>';
    return;
  }
  if(!batch){
    select.innerHTML = '<option value="">— Select batch first —</option>';
    return;
  }
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem && s.academic_year === batch);
  const placeholder = `<option value="" ${selectedSubjectId ? '' : 'selected disabled'}>Select subject</option>`;
  select.innerHTML = subjectsForSem.length
    ? placeholder + subjectsForSem.map(s => `<option value="${s.id}" ${String(s.id)===String(selectedSubjectId)?'selected':''}>${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})</option>`).join('')
    : '<option value="" selected disabled>There are no subjects for this batch/semester</option>';
}

function populateAssignmentFilterSubjects(semester){
  const select = document.getElementById('assignFilterSubject');
  if(!select) return;
  const current = select.value;
  let subjectsForSem = cachedSubjects;
  if(semester){
    const sem = parseInt(semester);
    subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem);
  }
  select.innerHTML = '<option value="ALL">All subjects</option>' +
    subjectsForSem.map(s => `<option value="${s.id}">${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})</option>`).join('');
  if(current && [...select.options].some(o => o.value === current)) select.value = current;
}

function onAssignmentFilterChange(){
  populateAssignmentFilterSubjects(document.getElementById('assignFilterSemester').value);
  loadAssignments();
}

function openAddAssignmentForm(){
  resetAssignmentForm();
  document.getElementById('assignFormTitle').textContent = 'Add assignment';
  document.getElementById('assignFileField').style.display = '';
  document.getElementById('assignForm').classList.remove('hidden');
}

function resetAssignmentForm(){
  document.getElementById('assignEditId').value = '';
  document.getElementById('assignTitle').value = '';
  document.getElementById('assignSemester').value = '';
  document.getElementById('assignDivision').value = '';
  document.getElementById('assignBatch').value = '';   // it will stay on the "Select batch" placeholder
  populateAssignmentSubjects('');
  document.getElementById('assignDueDate').value = '';
  document.getElementById('assignDescription').value = '';
  const fileInput = document.getElementById('assignFile');
  if(fileInput) fileInput.value = '';
}

function closeAssignmentForm(){
  document.getElementById('assignForm').classList.add('hidden');
}

function editAssignment(a){
  document.getElementById('assignEditId').value = a.id;
  document.getElementById('assignTitle').value = a.title;
  document.getElementById('assignSemester').value = a.semester;
  document.getElementById('assignDivision').value = a.division || '';
  document.getElementById('assignBatch').value = a.academic_year || '';
  populateAssignmentSubjects(a.semester, a.subject_id);
  document.getElementById('assignDueDate').value = a.due_date ? a.due_date.split('T')[0] : '';
  document.getElementById('assignDescription').value = a.description || '';
  document.getElementById('assignFormTitle').textContent = 'Edit assignment details';
  document.getElementById('assignFileField').style.display = 'none';   // editing changes only the details, the attachment is not replaced
  document.getElementById('assignForm').classList.remove('hidden');
}

async function saveAssignment(){
  const editId = document.getElementById('assignEditId').value;
  const title = document.getElementById('assignTitle').value.trim();
  const subjectId = document.getElementById('assignSubject').value;
  const semester = document.getElementById('assignSemester').value;
  const division = document.getElementById('assignDivision').value;
  const academicYear = document.getElementById('assignBatch').value;
  const dueDate = document.getElementById('assignDueDate').value;
  const description = document.getElementById('assignDescription').value.trim();

  if(!title || !subjectId){
    alert('Title and Subject are required');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/admin/assignments/${editId}`, {
        method: 'PUT',
        body: JSON.stringify({ title, subject_id: subjectId, semester, division, academic_year: academicYear, due_date: dueDate, description })
      });
    }else{
      const fileInput = document.getElementById('assignFile');
      const file = fileInput.files[0];
      if(file && file.size > 10 * 1024 * 1024){
        alert('The file is larger than 10MB. Please upload a smaller file');
        return;
      }
      const formData = new FormData();
      formData.append('title', title);
      formData.append('subject_id', subjectId);
      formData.append('semester', semester);
      formData.append('division', division);
      formData.append('academic_year', academicYear);
      formData.append('due_date', dueDate);
      formData.append('description', description);
      if(file) formData.append('file', file);
      await apiUpload('/admin/assignments', formData);
    }
    closeAssignmentForm();
    loadAssignments();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

function isOverdue(dueDate){
  if(!dueDate) return false;
  const due = new Date(dueDate);
  const today = new Date();
  due.setHours(0, 0, 0, 0);      // compare only the date, ignore the difference in time
  today.setHours(0, 0, 0, 0);
  return due < today;
}

async function loadAssignments(){
  const tbody = document.getElementById('assignmentsTableBody');
  const semester = document.getElementById('assignFilterSemester').value;
  const subjectId = document.getElementById('assignFilterSubject').value;
  const division = document.getElementById('assignFilterDivision').value;
  const academicYear = document.getElementById('assignFilterYear').value;
  const search = document.getElementById('assignSearch').value.trim();

  tbody.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
  try{
    const params = new URLSearchParams();
    if(semester) params.set('semester', semester);
    if(subjectId && subjectId !== 'ALL') params.set('subject_id', subjectId);
    if(division) params.set('division', division);
    if(academicYear) params.set('academic_year', academicYear);
    if(search) params.set('search', search);

    cachedAssignments = await apiRequest(`/admin/assignments?${params.toString()}`);

    tbody.innerHTML = cachedAssignments.length ? cachedAssignments.map(a => {
      const overdue = isOverdue(a.due_date);
      const dueLabel = a.due_date ? new Date(a.due_date).toLocaleDateString('en-IN') : '-';
      return `
        <tr class="${overdue ? 'tt-low-attendance' : ''}">
          <td>${escapeHtml(a.title)}${a.file_name ? ` <span title="${escapeHtml(a.file_name)}">📎</span>` : ''}</td>
          <td>${escapeHtml(a.subject_name || '-')}</td>
          <td>${escapeHtml(a.semester)}</td>
          <td>${escapeHtml(a.division || 'All')}</td>
          <td>${escapeHtml(a.academic_year || '-')}</td>
          <td>${escapeHtml(dueLabel)}${overdue ? ' ⚠' : ''}</td>
          <td><button class="pill warn" onclick="openAssignmentSubmissionsById('${a.id}')">${escapeHtml(a.submission_count)} submitted</button></td>
          <td class="row-actions">
            ${a.file_name ? `<button class="icon-action" onclick="downloadAssignmentFileById('${a.id}')" title="Download attachment">⬇</button>` : ''}
            <button class="icon-action" onclick="editAssignmentById('${a.id}')" title="Edit">✎</button>
            <button class="icon-action danger" onclick="deleteAssignmentById('${a.id}')" title="Delete">🗑</button>
          </td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="8">No assignments were found.</td></tr>';
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="8">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function openAssignmentSubmissionsById(id){
  const a = (cachedAssignments || []).find(x => String(x.id) === String(id));
  if(a) openAssignmentSubmissions(a.id, a.title);
}
function downloadAssignmentFileById(id){
  const a = (cachedAssignments || []).find(x => String(x.id) === String(id));
  if(a) downloadAssignmentFile(a.id, a.file_name);
}
function editAssignmentById(id){
  const a = (cachedAssignments || []).find(x => String(x.id) === String(id));
  if(a) editAssignment(a);
}
function deleteAssignmentById(id){
  const a = (cachedAssignments || []).find(x => String(x.id) === String(id));
  if(a) deleteAssignment(a.id, a.title);
}

async function deleteAssignment(id, title){
  if(!confirm(`Delete the assignment "${title}"? All student submissions for it will also be permanently deleted.`)) return;
  try{
    await apiRequest(`/admin/assignments/${id}`, { method: 'DELETE' });
    loadAssignments();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function downloadAssignmentFile(id, fileName){
  try{
    const res = await fetch(API_BASE + `/admin/assignments/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_admin') }
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
let currentSubmissionsAssignmentId = null;
let cachedSubmissions = [];
let editingSubmissionStudentId = null;   // which student's row is currently in edit mode

async function openAssignmentSubmissions(assignmentId, title){
  currentSubmissionsAssignmentId = assignmentId;
  editingSubmissionStudentId = null;
  document.getElementById('assignSubmissionsTitle').textContent = `Submissions — ${title}`;
  document.getElementById('submissionFilterStatus').value = '';
  document.getElementById('submissionSearch').value = '';
  document.getElementById('assignSubmissionsOverlay').classList.add('open');
  await loadAssignmentSubmissions();
}

function closeAssignmentSubmissions(){
  document.getElementById('assignSubmissionsOverlay').classList.remove('open');
  currentSubmissionsAssignmentId = null;
  editingSubmissionStudentId = null;
}

function getSubmissionStatus(r){
  const submitted = !!r.submission_id;
  if(!submitted) return { label: 'Pending', cls: 'bad', key: 'pending' };
  if(r.due_date && r.submitted_at > r.due_date) return { label: 'Late', cls: 'warn', key: 'late' };
  return { label: 'Submitted', cls: 'good', key: 'submitted' };
}

async function loadAssignmentSubmissions(){
  const tbody = document.getElementById('assignSubmissionsBody');
  tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try{
    cachedSubmissions = await apiRequest(`/admin/assignments/${currentSubmissionsAssignmentId}/submissions`);
    renderAssignmentSubmissions();
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="6">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// Read-only rows + an editable row for the student who is in edit mode — in the Student panel this same data
// will show READ-ONLY (there will be no edit button there), editing exists only in the Admin/Faculty panel.
function renderAssignmentSubmissions(){
  const tbody = document.getElementById('assignSubmissionsBody');

  if(!cachedSubmissions.length){
    tbody.innerHTML = '<tr><td colspan="6">No student was found in this semester/division.</td></tr>';
    return;
  }

  const statusFilter = document.getElementById('submissionFilterStatus').value;
  const search = (document.getElementById('submissionSearch').value || '').trim().toLowerCase();

  const filtered = cachedSubmissions.filter(r => {
    // The row that is currently being edited must not be hidden by the filter, otherwise the editing will break midway
    if(editingSubmissionStudentId === r.student_id) return true;
    if(statusFilter && getSubmissionStatus(r).key !== statusFilter) return false;
    if(search && !r.name.toLowerCase().includes(search) && !String(r.enrollment).toLowerCase().includes(search)) return false;
    return true;
  });

  if(!filtered.length){
    tbody.innerHTML = '<tr><td colspan="6">No student matched the filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    if(editingSubmissionStudentId === r.student_id){
      const status = getSubmissionStatus(r);
      return `
        <tr>
          <td>${escapeHtml(r.enrollment)}</td>
          <td>${escapeHtml(r.name)}</td>
          <td>
            <select id="editStatus_${r.student_id}" onchange="onEditStatusChange(${r.student_id})" style="padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);">
              <option value="pending" ${status.key==='pending'?'selected':''}>Pending</option>
              <option value="submitted" ${status.key==='submitted'?'selected':''}>Submitted</option>
              <option value="late" ${status.key==='late'?'selected':''}>Late</option>
            </select>
          </td>
          <td><input type="date" id="editDate_${r.student_id}" value="${escapeHtml(r.submitted_at || '')}" ${status.key==='pending'?'disabled':''} style="padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);"></td>
          <td><input type="number" min="0" id="editMarks_${r.student_id}" value="${escapeHtml(r.marks_obtained ?? '')}" ${status.key==='pending'?'disabled':''} style="width:60px; padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);"></td>
          <td class="row-actions">
            <button class="icon-action" onclick="saveSubmissionEdit(${r.student_id})" title="Save">✓</button>
            <button class="icon-action" onclick="cancelSubmissionEdit()" title="Cancel">✕</button>
          </td>
        </tr>
      `;
    }

    const status = getSubmissionStatus(r);
    const submitted = !!r.submission_id;
    return `
      <tr>
        <td>${escapeHtml(r.enrollment)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td><span class="pill ${status.cls}">${status.label}</span></td>
        <td>${submitted ? escapeHtml(new Date(r.submitted_at).toLocaleDateString('en-IN')) : '-'}</td>
        <td>${submitted ? escapeHtml(r.marks_obtained ?? '-') : '-'}</td>
        <td class="row-actions">
          <button class="icon-action" onclick="startSubmissionEdit(${r.student_id})" title="Edit">✎</button>
        </td>
      </tr>
    `;
  }).join('');
}

function startSubmissionEdit(studentId){
  editingSubmissionStudentId = studentId;
  renderAssignmentSubmissions();
}

function cancelSubmissionEdit(){
  editingSubmissionStudentId = null;
  renderAssignmentSubmissions();
}

// If the Status is set to "Pending", disable the Date/Marks fields (they have no meaning then)
function onEditStatusChange(studentId){
  const status = document.getElementById(`editStatus_${studentId}`).value;
  const isPending = status === 'pending';
  document.getElementById(`editDate_${studentId}`).disabled = isPending;
  document.getElementById(`editMarks_${studentId}`).disabled = isPending;
}

async function saveSubmissionEdit(studentId){
  const status = document.getElementById(`editStatus_${studentId}`).value;
  const dateVal = document.getElementById(`editDate_${studentId}`).value;
  const marksVal = document.getElementById(`editMarks_${studentId}`).value;

  const payload = {
    submitted: status !== 'pending',
    submitted_at: status === 'pending' ? null : (dateVal || null),
    marks_obtained: status === 'pending' || marksVal === '' ? null : parseInt(marksVal)
  };

  try{
    await apiRequest(`/admin/assignments/${currentSubmissionsAssignmentId}/submissions/${studentId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    editingSubmissionStudentId = null;
    await loadAssignmentSubmissions();
    loadAssignments();   // also refresh the "X submitted" badge of the list
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ============================================================
// MARKS MANAGEMENT
// ============================================================
let cachedMarksStudents = [];
const PASS_PERCENT = 40;   // you can change the passing % from here

function populateMarksSubjects(semester){
  const select = document.getElementById('marksSubject');
  if(!select) return;
  const batch = document.getElementById('marksBatch') ? document.getElementById('marksBatch').value : '';
  if(!semester){
    select.innerHTML = '<option value="" selected disabled>— Select semester first —</option>';
    return;
  }
  if(!batch){
    select.innerHTML = '<option value="" selected disabled>— Select batch first —</option>';
    return;
  }
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem && s.academic_year === batch);
  select.innerHTML = subjectsForSem.length
    ? '<option value="" selected disabled>Select subject</option>' + subjectsForSem.map(s => `<option value="${s.id}">${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code)})</option>`).join('')
    : '<option value="" selected disabled>There are no subjects for this batch/semester</option>';
}

function onMarksFilterChange(){
  populateMarksSubjects(document.getElementById('marksSemester').value);
  loadMarksClass();
}

// When max marks change, don't reload the whole list — only recalculate the Pass/Fail of the marks
// already typed according to the new max marks, so that unsaved values don't get reset
function onMaxMarksChange(){
  cachedMarksStudents.forEach(s => {
    if(document.getElementById(`marksInput_${s.student_id}`)) updateMarksRowStatus(s.student_id);
  });
}

async function loadMarksClass(){
  const tbody = document.getElementById('marksTableBody');
  const semester = document.getElementById('marksSemester').value;
  const division = document.getElementById('marksDivision').value;
  const subjectId = document.getElementById('marksSubject').value;
  const examType = document.getElementById('marksExamType').value;
  const academicYear = document.getElementById('marksBatch').value;

  document.getElementById('marksListTitle').textContent = `Sem ${semester} · Division ${division} · ${academicYear}`;

  if(!subjectId){
    tbody.innerHTML = '<tr><td colspan="7">There are no subjects for this semester.</td></tr>';
    cachedMarksStudents = [];
    return;
  }

  tbody.innerHTML = '<tr><td colspan="7">Loading…</td></tr>';
  try{
    cachedMarksStudents = await apiRequest(
      `/admin/marks/students?semester=${semester}&division=${division}&subject_id=${subjectId}&exam_type=${encodeURIComponent(examType)}&academic_year=${academicYear}`
    );
    renderMarksTable();
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="7">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// If the input already exists in the DOM, take its live value (so that unsaved typing isn't reset by search/filter), otherwise the cached value
function getCurrentMarksValue(studentId, cachedValue){
  const el = document.getElementById(`marksInput_${studentId}`);
  return el ? el.value : (cachedValue ?? '');
}

function renderMarksTable(){
  const tbody = document.getElementById('marksTableBody');
  const maxMarks = parseFloat(document.getElementById('marksMaxMarks').value) || 0;
  const search = (document.getElementById('marksSearch').value || '').trim().toLowerCase();

  if(!cachedMarksStudents.length){
    tbody.innerHTML = '<tr><td colspan="7">No student was found in this semester/division.</td></tr>';
    updateMarksSummary();
    updatePublishBadge();
    return;
  }

  const filtered = cachedMarksStudents.filter(s =>
    !search || s.name.toLowerCase().includes(search) || String(s.enrollment).toLowerCase().includes(search)
  );

  if(!filtered.length){
    tbody.innerHTML = '<tr><td colspan="7">No student matched the search.</td></tr>';
    updateMarksSummary();
    updatePublishBadge();
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const currentVal = getCurrentMarksValue(s.student_id, s.marks_obtained);
    return `
    <tr>
      <td>${escapeHtml(s.enrollment)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.semester ?? '-')}</td>
      <td>${escapeHtml(s.division || '-')}</td>
      <td>${escapeHtml(s.academic_year || '-')}</td>
      <td>
        <input type="number" min="0" max="${maxMarks}" step="0.5" id="marksInput_${s.student_id}"
               value="${currentVal}" placeholder="/${maxMarks}"
               oninput="updateMarksRowStatus(${s.student_id})"
               style="width:70px; padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);">
      </td>
      <td id="marksStatus_${s.student_id}">${marksStatusPill(currentVal === '' ? null : parseFloat(currentVal), maxMarks)}</td>
    </tr>
  `;
  }).join('');

  updateMarksSummary();
  updatePublishBadge();
}

function marksStatusPill(marks, maxMarks){
  if(marks === null || marks === undefined || marks === '' || !maxMarks) return '-';
  const pct = (marks / maxMarks) * 100;
  return pct < PASS_PERCENT
    ? `<span class="pill bad">Fail</span>`
    : `<span class="pill good">Pass</span>`;
}

// As soon as marks are typed, update that row's Pass/Fail pill right away (it shows live even without saving)
function updateMarksRowStatus(studentId){
  const maxMarks = parseFloat(document.getElementById('marksMaxMarks').value) || 0;
  const val = document.getElementById(`marksInput_${studentId}`).value;
  document.getElementById(`marksStatus_${studentId}`).innerHTML = marksStatusPill(val === '' ? null : parseFloat(val), maxMarks);
  updateMarksSummary();
}

// The class Average / Highest / Lowest — calculated live from whatever values are currently in the input boxes
function updateMarksSummary(){
  const line = document.getElementById('marksSummaryLine');
  if(!line) return;

  const values = cachedMarksStudents
    .map(s => {
      const el = document.getElementById(`marksInput_${s.student_id}`);
      const v = el ? el.value : s.marks_obtained;
      return v === '' || v === null || v === undefined ? null : parseFloat(v);
    })
    .filter(v => v !== null && !isNaN(v));

  if(!values.length){
    line.textContent = 'No marks have been entered yet.';
    return;
  }

  const avg = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
  const max = Math.max(...values);
  const min = Math.min(...values);
  line.textContent = `Average: ${avg} · Highest: ${max} · Lowest: ${min} · Entries: ${values.length}/${cachedMarksStudents.length}`;
}

// Publish badge — shows "Published" only when all entered-marks records have been published
function updatePublishBadge(){
  const badge = document.getElementById('marksPublishBadge');
  const btn = document.getElementById('marksPublishBtn');
  if(!badge) return;

  const withMarks = cachedMarksStudents.filter(s => s.marks_id);
  const allPublished = withMarks.length > 0 && withMarks.every(s => s.published);

  if(allPublished){
    badge.textContent = 'Published';
    badge.className = 'pill good';
    btn.textContent = 'Unpublish result';
  }else{
    badge.textContent = 'Draft';
    badge.className = 'pill bad';
    btn.textContent = 'Publish result';
  }
}

async function saveAllMarks(){
  const semester = document.getElementById('marksSemester').value;
  const subjectId = document.getElementById('marksSubject').value;
  const examType = document.getElementById('marksExamType').value;
  const maxMarks = document.getElementById('marksMaxMarks').value;
  const academicYear = document.getElementById('marksBatch').value;

  if(!subjectId){
    alert('Select a subject');
    return;
  }

  const records = cachedMarksStudents
    .map(s => {
      const el = document.getElementById(`marksInput_${s.student_id}`);
      const val = el ? el.value : '';
      return { student_id: s.student_id, marks_obtained: val === '' ? null : parseFloat(val) };
    })
    .filter(r => r.marks_obtained !== null);

  if(!records.length){
    alert('Enter marks for at least one student');
    return;
  }

  try{
    await apiRequest('/admin/marks/bulk', {
      method: 'POST',
      body: JSON.stringify({ semester, subject_id: subjectId, exam_type: examType, max_marks: maxMarks, academic_year: academicYear, records })
    });
    alert('Marks saved');
    loadMarksClass();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function toggleMarksPublish(){
  const semester = document.getElementById('marksSemester').value;
  const division = document.getElementById('marksDivision').value;
  const subjectId = document.getElementById('marksSubject').value;
  const examType = document.getElementById('marksExamType').value;
  const academicYear = document.getElementById('marksBatch').value;

  if(!subjectId){
    alert('Select a subject');
    return;
  }

  const withMarks = cachedMarksStudents.filter(s => s.marks_id);
  const allPublished = withMarks.length > 0 && withMarks.every(s => s.published);
  const newPublished = !allPublished;

  if(!withMarks.length){
    alert('Save marks for at least one student before publishing');
    return;
  }

  try{
    await apiRequest('/admin/marks/publish', {
      method: 'PUT',
      body: JSON.stringify({ semester, division, subject_id: subjectId, exam_type: examType, academic_year: academicYear, published: newPublished })
    });
    loadMarksClass();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ============================================================
// FEE MANAGEMENT
// ============================================================
let cachedFeeStudents = [];

function openAddFeeForm(){
  resetFeeForm();
  document.getElementById('feesFormTitle').textContent = 'Add fee record';
  document.getElementById('feesForm').classList.remove('hidden');
  populateFeeStudents();
}

function resetFeeForm(){
  document.getElementById('feeEditId').value = '';
  document.getElementById('feeTitle').value = '';
  document.getElementById('feeAmount').value = '';
  document.getElementById('feeDueDate').value = '';
  document.getElementById('feeSemester').value = '';
  document.getElementById('feeDivision').value = '';
  document.getElementById('feeBatch').value = '';
  document.getElementById('feePaymentLink').value = '';
  document.getElementById('feeStatus').value = 'unpaid';
  document.getElementById('feeApplyAll').checked = false;
  document.getElementById('feeApplyAll').disabled = false;
  document.getElementById('feeApplyAllWrap').classList.remove('hidden');
  document.getElementById('feeStudentWrap').classList.remove('hidden');
}

function onFeeApplyAllChange(){
  const applyAll = document.getElementById('feeApplyAll').checked;
  document.getElementById('feeStudentWrap').classList.toggle('hidden', applyAll);
}

async function populateFeeStudents(){
  const sel = document.getElementById('feeStudent');
  if(!sel) return;
  const semester = document.getElementById('feeSemester').value;
  const division = document.getElementById('feeDivision').value;
  const academicYear = document.getElementById('feeBatch').value;

  const params = new URLSearchParams({ semester });
  if(division) params.set('division', division);
  if(academicYear) params.set('academic_year', academicYear);

  try{
    cachedFeeStudents = await apiRequest('/admin/fees/students?' + params.toString());
    sel.innerHTML = cachedFeeStudents.length
      ? cachedFeeStudents.map(s => `<option value="${s.student_id}">${escapeHtml(s.name)} (${escapeHtml(s.enrollment)})</option>`).join('')
      : '<option value="">No students found</option>';
  }catch(err){
    sel.innerHTML = `<option value="">Failed to load students</option>`;
  }
}

// ---- Fee Management: 3 levels (folders -> fee-title folders -> records) ----
// Each level is loaded from the server only when it is shown: the folder cards come with their counts and totals
// (counted by the database), and the records of a title folder come 50 per page. So the page never has to hold
// every fee record of the whole college.
const FEES_PAGE_SIZE = 50;
let feeFolders = [];        // level 1: [{semester, division, academic_year, records, paid, total}]
let feeTitleGroups = [];    // level 2: [{fee_title, records, paid, total}] of the open folder
let openFeeFolderKey = null;
let openFeeTitleKey = null;
let feesPage = 1;
let feesFoldersSeq = 0;     // sequence numbers: an older, slower answer can never overwrite a newer one
let feeTitlesSeq = 0;
let feeRecordsSeq = 0;
let feeSearchTimer = null;

function feeFolderKey(f){
  return `${f.semester || '-'}|${f.division || '-'}|${f.academic_year || '-'}`;
}

function feeFolderLabel(f){
  return `Sem ${f.semester || '-'} • Div ${f.division || 'All'} • ${f.academic_year || '-'}`;
}

function currentFeeFolder(){
  return feeFolders.find(f => feeFolderKey(f) === openFeeFolderKey);
}

function onFeeSearchInput(){
  clearTimeout(feeSearchTimer);
  feeSearchTimer = setTimeout(() => loadFees(), 300);   // wait until typing pauses
}

// The filters of the page (Semester / Division / Batch / Status / search). They are sent with every request,
// so the folder cards, the title folders and the records always agree with each other.
function feePageFilters(){
  const params = new URLSearchParams();
  const semester = document.getElementById('feeFilterSemester').value;
  const division = document.getElementById('feeFilterDivision').value;
  const academicYear = document.getElementById('feeFilterYear').value;
  const status = document.getElementById('feeFilterStatus').value;
  const search = document.getElementById('feeSearch').value.trim();
  if(semester) params.set('semester', semester);
  if(division) params.set('division', division);
  if(academicYear) params.set('academic_year', academicYear);
  if(status) params.set('status', status);
  if(search) params.set('search', search);
  return params;
}

// + the folder that is open ('-' means "not set") and, optionally, the fee-title folder inside it
function feeFolderParams(key, title){
  const params = feePageFilters();
  const [sem, div, year] = key.split('|');
  params.set('folder_semester', sem);
  params.set('folder_division', div);
  params.set('folder_year', year);
  if(title) params.set('fee_title', title);
  return params;
}

async function loadFees(){
  const grid = document.getElementById('feesFolderGrid');
  if(grid) grid.innerHTML = '<div style="color:var(--muted); font-size:13px;">Loading…</div>';

  const seq = ++feesFoldersSeq;
  try{
    const folders = await apiRequest('/admin/fees/folders?' + feePageFilters().toString());
    if(seq !== feesFoldersSeq) return;   // a newer request has been made in the meantime
    feeFolders = folders;
    renderFeeFolders();
    // If a folder / sub-folder was already open, refresh it with the new data.
    if(openFeeFolderKey){
      if(!feeFolders.some(f => feeFolderKey(f) === openFeeFolderKey)){
        closeFeeFolder();
      } else if(openFeeTitleKey){
        await Promise.all([loadFeeTitleGroups(), openFeeTitleFolder(openFeeTitleKey, true)]);
      } else {
        await openFeeFolder(openFeeFolderKey);
      }
    }
  }catch(err){
    if(seq !== feesFoldersSeq) return;
    if(grid) grid.innerHTML = `<div style="color:var(--muted); font-size:13px;">Failed to load fees: ${escapeHtml(err.message)}</div>`;
  }
}

function feeFolderCardHtml(name, records, paid, total, attrs, deleteAttrs){
  const unpaid = records - paid;
  return `
      <div class="fee-folder-card" ${attrs}>
        <button class="icon-action danger fee-folder-delete" title="Delete folder" ${deleteAttrs}>🗑</button>
        <div class="fee-folder-icon">📁</div>
        <div class="fee-folder-name">${escapeHtml(name)}</div>
        <div class="fee-folder-meta">${records} record${records === 1 ? '' : 's'} · ₹${Number(total).toLocaleString('en-IN')}</div>
        <div class="fee-folder-stats">
          <span class="pill good">${paid} Paid</span>
          <span class="pill bad">${unpaid} Unpaid</span>
        </div>
      </div>
    `;
}

function renderFeeFolders(){
  const grid = document.getElementById('feesFolderGrid');
  if(!grid) return;

  if(!feeFolders.length){
    grid.innerHTML = '<div style="color:var(--muted); font-size:13px;">No fee records found.</div>';
    return;
  }

  const sorted = feeFolders.slice().sort((a, b) => feeFolderKey(a).localeCompare(feeFolderKey(b)));
  grid.innerHTML = sorted.map(g => {
    const key = escapeHtml(feeFolderKey(g));
    return feeFolderCardHtml(
      feeFolderLabel(g), g.records, g.paid, g.total,
      `data-key="${key}" onclick="openFeeFolder(this.dataset.key)"`,
      `data-key="${key}" onclick="deleteFeeFolder(this.dataset.key, event)"`
    );
  }).join('');
}

// Deletes all fee records of the whole folder (Sem + Div + Batch group) — across all titles — in one go.
async function deleteFeeFolder(key, event){
  if(event) event.stopPropagation();

  const folder = feeFolders.find(f => feeFolderKey(f) === key);
  if(!folder) return;

  if(!confirm(`Delete all ${folder.records} fee record(s) in "${feeFolderLabel(folder)}"? This cannot be undone.`)) return;

  const params = new URLSearchParams({ semester: folder.semester, academic_year: folder.academic_year });
  if(folder.division) params.set('division', folder.division);

  try{
    await apiRequest('/admin/fees/folder?' + params.toString(), { method: 'DELETE' });
    if(openFeeFolderKey === key) closeFeeFolder();
    loadFees();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// When a Batch folder is opened, instead of records directly, it first shows sub-folders inside that batch
// by fee title (e.g. "Tuition Fee", "Exam Fee" — each title has its own separate folder).
async function openFeeFolder(key){
  openFeeFolderKey = key;
  openFeeTitleKey = null;
  feeTitleGroups = [];

  document.getElementById('feesFolderView').classList.add('hidden');
  document.getElementById('feesRecordsView').classList.add('hidden');
  document.getElementById('feesTitleFolderView').classList.remove('hidden');
  document.getElementById('feesTitleFolderGrid').innerHTML = '<div style="color:var(--muted); font-size:13px;">Loading…</div>';
  const folder = currentFeeFolder();
  document.getElementById('feesTitleFolderHeading').textContent = folder ? feeFolderLabel(folder) : '';

  await loadFeeTitleGroups();
}

// Fetches the fee-title folders of the open folder (counts + totals come from the database) and shows them.
async function loadFeeTitleGroups(){
  const key = openFeeFolderKey;
  if(!key) return;
  const seq = ++feeTitlesSeq;
  try{
    const groups = await apiRequest('/admin/fees/title-folders?' + feeFolderParams(key).toString());
    if(seq !== feeTitlesSeq || openFeeFolderKey !== key) return;
    feeTitleGroups = groups;
    renderFeeTitleFolders(key);
  }catch(err){
    if(seq !== feeTitlesSeq) return;
    document.getElementById('feesTitleFolderGrid').innerHTML =
      `<div style="color:var(--muted); font-size:13px;">Failed to load fees: ${escapeHtml(err.message)}</div>`;
  }
}

function renderFeeTitleFolders(key){
  const grid = document.getElementById('feesTitleFolderGrid');
  const folder = feeFolders.find(f => feeFolderKey(f) === key);
  document.getElementById('feesTitleFolderHeading').textContent = folder ? feeFolderLabel(folder) : '';

  if(!feeTitleGroups.length){
    grid.innerHTML = '<div style="color:var(--muted); font-size:13px;">No fee records found.</div>';
    return;
  }

  const sorted = feeTitleGroups.slice().sort((a, b) => a.fee_title.localeCompare(b.fee_title));
  grid.innerHTML = sorted.map(g => {
    const title = escapeHtml(g.fee_title);
    return feeFolderCardHtml(
      g.fee_title, g.records, g.paid, g.total,
      `data-title="${title}" onclick="openFeeTitleFolder(this.dataset.title)"`,
      `data-title="${title}" onclick="deleteFeeTitleFolder(openFeeFolderKey, this.dataset.title, event)"`
    );
  }).join('');
}

// Deletes all records of one fee-title (sub-folder) inside that batch in one go —
// the records of the other titles are not touched.
async function deleteFeeTitleFolder(key, title, event){
  if(event) event.stopPropagation();
  if(!key || !title) return;

  const folder = feeFolders.find(f => feeFolderKey(f) === key);
  const group = feeTitleGroups.find(g => g.fee_title === title);
  if(!folder || !group) return;

  if(!confirm(`Delete all ${group.records} "${title}" record(s) in this batch? This cannot be undone.`)) return;

  const params = new URLSearchParams({ semester: folder.semester, academic_year: folder.academic_year, fee_title: title });
  if(folder.division) params.set('division', folder.division);

  try{
    await apiRequest('/admin/fees/folder?' + params.toString(), { method: 'DELETE' });
    if(openFeeTitleKey === title) closeFeeTitleFolder();
    loadFees();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

function goToFeesPage(p){
  feesPage = p;
  openFeeTitleFolder(openFeeTitleKey, true);
}

function renderFeesPager(total, page, totalPages, shown){
  const table = document.getElementById('feesTableBody').closest('table');
  let pager = document.getElementById('feesPager');
  if(!pager){
    pager = document.createElement('div');
    pager.id = 'feesPager';
    pager.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:12px; font-size:13px; color:var(--muted);';
    table.insertAdjacentElement('afterend', pager);
  }
  if(!total){
    pager.innerHTML = '';
    return;
  }
  const from = (page - 1) * FEES_PAGE_SIZE + 1;
  const to = from + shown - 1;
  const info = `<span>Showing ${from}–${to} of ${total} record${total === 1 ? '' : 's'}</span>`;
  const controls = totalPages > 1 ? `
    <span style="display:flex; align-items:center; gap:10px;">
      <button class="btn-ghost" ${page <= 1 ? 'disabled' : ''} onclick="goToFeesPage(${page - 1})">‹ Prev</button>
      <span>Page ${page} of ${totalPages}</span>
      <button class="btn-ghost" ${page >= totalPages ? 'disabled' : ''} onclick="goToFeesPage(${page + 1})">Next ›</button>
    </span>` : '';
  pager.innerHTML = info + controls;
}

// When a sub-folder is opened, the actual student-wise records table shows (existing behavior, just that it is now
// also filtered by fee_title) — 50 records per page, loaded from the server.
// keepPage = true when the same table is only being refreshed (after an edit, status change, page change ...).
async function openFeeTitleFolder(title, keepPage){
  openFeeTitleKey = title;
  if(!keepPage) feesPage = 1;
  const key = openFeeFolderKey;
  const tbody = document.getElementById('feesTableBody');

  const folder = currentFeeFolder();
  document.getElementById('feesFolderTitle').textContent = folder ? `${feeFolderLabel(folder)} • ${title}` : title;
  if(!keepPage){
    tbody.innerHTML = '<tr><td colspan="7">Loading…</td></tr>';
    document.getElementById('feesTitleFolderView').classList.add('hidden');
    document.getElementById('feesRecordsView').classList.remove('hidden');
  }

  const params = feeFolderParams(key, title);
  params.set('page', feesPage);
  params.set('limit', FEES_PAGE_SIZE);

  const seq = ++feeRecordsSeq;
  try{
    const res = await apiRequest('/admin/fees?' + params.toString());
    if(seq !== feeRecordsSeq || openFeeFolderKey !== key || openFeeTitleKey !== title) return;
    const records = res.items;
    feesPage = res.page;   // the server clamps it (e.g. after the last record of the last page was deleted)

    // nothing left in this sub-folder (e.g. its last record was deleted, or a filter excludes it): go back
    if(!res.total && keepPage){
      closeFeeTitleFolder();
      return;
    }

    window._feesCache = new Map(records.map(f => [String(f.id), f]));
    tbody.innerHTML = records.length ? records.map(f => `
      <tr>
        <td>${escapeHtml(f.student_name)} (${escapeHtml(f.enrollment)})</td>
        <td>${escapeHtml(f.fee_title)}</td>
        <td>₹${Number(f.amount).toLocaleString('en-IN')}</td>
        <td>${escapeHtml(f.due_date || '-')}</td>
        <td>${f.payment_link ? `<a href="${escapeHtml(f.payment_link)}" target="_blank" rel="noopener" class="card-link">View link</a>` : '-'}</td>
        <td><span class="pill ${f.status === 'paid' ? 'good' : 'bad'}" style="cursor:pointer"
              onclick="toggleFeeStatus(${f.id}, '${escapeHtml(f.status)}')">${f.status === 'paid' ? 'Paid' : 'Unpaid'}</span></td>
        <td class="row-actions">
          <button class="icon-action" onclick="viewFeeDetailsById('${f.id}')" title="View">👁</button>
          <button class="icon-action" onclick="editFeeById('${f.id}')" title="Edit">✎</button>
          <button class="icon-action danger" onclick="deleteFeeById('${f.id}')" title="Delete">🗑</button>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="7">No fee records found.</td></tr>';
    renderFeesPager(res.total, res.page, res.total_pages, records.length);
  }catch(err){
    if(seq !== feeRecordsSeq) return;
    tbody.innerHTML = `<tr><td colspan="7">Failed to load fees: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function viewFeeDetailsById(id){
  const f = window._feesCache && window._feesCache.get(String(id));
  if(f) viewFeeDetails(f);
}
function editFeeById(id){
  const f = window._feesCache && window._feesCache.get(String(id));
  if(f) editFee(f);
}
function deleteFeeById(id){
  const f = window._feesCache && window._feesCache.get(String(id));
  if(f) deleteFee(f.id, f.fee_title);
}

// Back from the records table to the title-sub-folder grid.
function closeFeeTitleFolder(){
  openFeeTitleKey = null;
  document.getElementById('feesRecordsView').classList.add('hidden');
  if(openFeeFolderKey){
    renderFeeTitleFolders(openFeeFolderKey);      // what we already have, straight away ...
    document.getElementById('feesTitleFolderView').classList.remove('hidden');
    loadFeeTitleGroups();                         // ... and the fresh counts (a status may have changed, records deleted)
  } else {
    document.getElementById('feesFolderView').classList.remove('hidden');
  }
}

// Back from the title-sub-folder grid to the top-level (Sem/Div/Batch) folder grid.
function closeFeeFolder(){
  openFeeFolderKey = null;
  openFeeTitleKey = null;
  document.getElementById('feesRecordsView').classList.add('hidden');
  document.getElementById('feesTitleFolderView').classList.add('hidden');
  document.getElementById('feesFolderView').classList.remove('hidden');
}

async function saveFee(){
  const editId = document.getElementById('feeEditId').value;
  const fee_title = document.getElementById('feeTitle').value.trim();
  const amount = document.getElementById('feeAmount').value;
  const due_date = document.getElementById('feeDueDate').value || null;
  const payment_link = document.getElementById('feePaymentLink').value.trim() || null;
  const status = document.getElementById('feeStatus').value;

  if(!fee_title || !amount){
    alert('Fee item and amount are required');
    return;
  }

  try{
    if(editId){
      await apiRequest(`/admin/fees/${editId}`, {
        method: 'PUT',
        body: JSON.stringify({ fee_title, amount, due_date, payment_link, status })
      });
      alert('Fee record updated');
    } else {
      const semester = document.getElementById('feeSemester').value;
      const academic_year = document.getElementById('feeBatch').value || null;
      if(!semester){
        alert('Select semester');
        return;
      }
      const applyAll = document.getElementById('feeApplyAll').checked;

      let student_ids;
      if(applyAll){
        if(!cachedFeeStudents.length){
          alert('No student was found in this semester/division');
          return;
        }
        student_ids = cachedFeeStudents.map(s => s.student_id);
      } else {
        const studentId = document.getElementById('feeStudent').value;
        if(!studentId){
          alert('Select a student');
          return;
        }
        student_ids = [studentId];
      }

      const res = await apiRequest('/admin/fees', {
        method: 'POST',
        body: JSON.stringify({ fee_title, amount, due_date, semester, academic_year, payment_link, status, student_ids })
      });
      alert(res.message || 'Fee record(s) added');
    }
    toggleForm('feesForm');
    resetFeeForm();
    loadFees();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

function viewFeeDetails(fee){
  document.getElementById('feeDetailStudent').textContent = `${fee.student_name} (${fee.enrollment})`;
  document.getElementById('feeDetailTitle').textContent = fee.fee_title;
  document.getElementById('feeDetailAmount').textContent = `₹${Number(fee.amount).toLocaleString('en-IN')}`;
  document.getElementById('feeDetailDueDate').textContent = fee.due_date || '-';
  document.getElementById('feeDetailSemester').textContent = fee.semester || '-';
  document.getElementById('feeDetailDivision').textContent = fee.division || 'All';
  document.getElementById('feeDetailBatch').textContent = fee.academic_year || '-';

  const linkEl = document.getElementById('feeDetailLink');
  linkEl.innerHTML = fee.payment_link
    ? (/^https?:\/\//i.test(fee.payment_link) ? `<a href="${escapeHtml(fee.payment_link)}" target="_blank" rel="noopener noreferrer" class="card-link">${escapeHtml(fee.payment_link)}</a>` : escapeHtml(fee.payment_link))
    : '-';

  document.getElementById('feeDetailStatus').innerHTML =
    `<span class="pill ${fee.status === 'paid' ? 'good' : 'bad'}">${fee.status === 'paid' ? 'Paid' : 'Unpaid'}</span>`;
  document.getElementById('feeDetailPaidAt').textContent = fee.paid_at
    ? new Date(fee.paid_at).toLocaleString('en-IN')
    : '-';

  document.getElementById('feeDetailsOverlay').classList.add('open');
}

function closeFeeDetails(){
  document.getElementById('feeDetailsOverlay').classList.remove('open');
}

function editFee(fee){
  document.getElementById('feeEditId').value = fee.id;
  document.getElementById('feeTitle').value = fee.fee_title;
  document.getElementById('feeAmount').value = fee.amount;
  document.getElementById('feeDueDate').value = fee.due_date || '';
  document.getElementById('feePaymentLink').value = fee.payment_link || '';
  document.getElementById('feeStatus').value = fee.status;
  document.getElementById('feeSemester').value = fee.semester || '1';
  document.getElementById('feeDivision').value = fee.division || '';
  document.getElementById('feeBatch').value = fee.academic_year || '';

  // Edit updates only a single record — the student can't be changed,
  // so the bulk/"apply to whole class" controls are hidden here.
  document.getElementById('feeApplyAllWrap').classList.add('hidden');
  document.getElementById('feeStudentWrap').classList.add('hidden');

  document.getElementById('feesFormTitle').textContent = `Edit fee — ${fee.student_name}`;
  document.getElementById('feesForm').classList.remove('hidden');
}

async function toggleFeeStatus(id, currentStatus){
  const newStatus = currentStatus === 'paid' ? 'unpaid' : 'paid';
  try{
    await apiRequest(`/admin/fees/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
    loadFees();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function deleteFee(id, title){
  if(!confirm(`Delete the fee record "${title}"?`)) return;
  try{
    await apiRequest(`/admin/fees/${id}`, { method: 'DELETE' });
    loadFees();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ============================================================
// NOTICE MANAGEMENT
// ============================================================
const NOTICE_TAG_CLASS = { Academic: '', Event: 'event', Important: 'urgent' };

const NF_ROLE_TEXT = { all: 'Everyone', student: 'Students', faculty: 'Faculty' };
const NFC_MAX_TITLE = 150;   // notices.title is VARCHAR(150)

// "To: Everyone · Sem 3 · Academic" — shows who will get the notice, without opening the options
function updateNoticeScopeLine(){
  const g = id => document.getElementById(id).value;
  const parts = [];
  if(adminNoticeGroup === 'staff'){
    parts.push('Admin & Faculty');
  }else{
    parts.push(NF_ROLE_TEXT[g('noticeTargetRole')] || 'Everyone');
    if(g('noticeSemester')) parts.push('Sem ' + g('noticeSemester'));
    if(g('noticeDivision')) parts.push('Div ' + g('noticeDivision'));
    if(g('noticeBatch')) parts.push(g('noticeBatch'));
  }
  parts.push(g('noticeCategory'));
  if(g('noticePinned') === '1') parts.push('📌 Pinned');
  document.getElementById('noticeScopeText').textContent = 'To: ' + parts.join(' · ');
}

function toggleNoticeOptions(){
  const box = document.getElementById('noticeOptions');
  box.classList.toggle('hidden');
  document.getElementById('noticeScopeLine').classList.toggle('open', !box.classList.contains('hidden'));
}

function nfcAutoGrow(el){
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// Enter = send, Shift+Enter = new line (on phones Enter stays a new line, the ➤ button sends)
function nfcKeyDown(e){
  if(e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.innerWidth > 860){
    e.preventDefault();
    saveNotice();
  }
}

// First line = title, the rest = body (like a WhatsApp message with a heading)
function nfcSplitMessage(text){
  const lines = text.split('\n');
  const first = lines[0].trim();
  const rest = lines.slice(1).join('\n').trim();
  if(first.length <= NFC_MAX_TITLE) return { title: first, content: rest };
  return { title: first.slice(0, NFC_MAX_TITLE - 1).trimEnd() + '…', content: text };
}

let nfcThumbUrl = null;
function nfcRenderFilePreview(){
  const box = document.getElementById('noticeAttachPreview');
  const file = document.getElementById('noticeFile').files[0];
  if(nfcThumbUrl){ URL.revokeObjectURL(nfcThumbUrl); nfcThumbUrl = null; }
  if(!file){
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  let thumb;
  if(nfFileKind(file.name) === 'image'){
    nfcThumbUrl = URL.createObjectURL(file);
    thumb = `<img src="${nfcThumbUrl}" alt="">`;
  }else{
    thumb = `<div class="nf-attach-ic">${nfFileIcon(file.name)}</div>`;
  }
  box.innerHTML = `${thumb}
    <div class="nf-attach-info"><div class="nf-attach-name">${nfEsc(file.name)}</div><span>${nfEsc(nfFileSize(file.size))}</span></div>
    <button type="button" class="nf-attach-x" onclick="nfcClearFile()" title="Remove attachment">✕</button>`;
  box.classList.remove('hidden');
}

function nfcOnFilePicked(){
  nfcRenderFilePreview();
  document.getElementById('noticeContent').focus();
}

function nfcClearFile(){
  document.getElementById('noticeFile').value = '';
  nfcRenderFilePreview();
}

// Composer back to its defaults (after send / cancel edit)
function resetNoticeForm(){
  document.getElementById('noticeEditId').value = '';
  const box = document.getElementById('noticeContent');
  box.value = '';
  nfcAutoGrow(box);
  document.getElementById('noticeCategory').value = 'Academic';
  document.getElementById('noticeTargetRole').value = 'all';
  document.getElementById('noticeSemester').value = '';
  document.getElementById('noticeDivision').value = '';
  document.getElementById('noticeBatch').value = '';
  document.getElementById('noticePinned').value = '0';
  document.getElementById('noticeFile').value = '';
  document.getElementById('noticeEditBanner').classList.add('hidden');
  document.getElementById('noticeAttachBtn').classList.remove('hidden');
  const send = document.getElementById('noticeSendBtn');
  send.textContent = '➤';
  send.title = 'Send notice';
  nfcRenderFilePreview();
  updateNoticeScopeLine();
}

function cancelNoticeEdit(){
  resetNoticeForm();
}

function timeAgo(dateStr){
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if(mins < 60) return `Posted ${mins <= 1 ? 'just now' : mins + ' min ago'}`;
  const hrs = Math.floor(mins / 60);
  if(hrs < 24) return `Posted ${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  if(days === 1) return 'Posted yesterday';
  return `Posted ${days} days ago`;
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

function nfFileChip(n, previewCode, downloadCode){
  return nfAttachmentHtml(n, previewCode, downloadCode);
}

// The backend sends the list as is_pinned DESC, created_at DESC (newest-first), but the feed should
// look like WhatsApp — older on top, newer at the bottom. So we reverse the order here; pinned ones stay
// on top under the "📌 Pinned" divider, and the rest follow the date dividers
function nfRenderFeed(notices, cardFn){
  const pinned = notices.filter(n => n.is_pinned).reverse();
  const others = notices.filter(n => !n.is_pinned).reverse();
  let html = '';
  let lastLabel = null;
  [...pinned, ...others].forEach(n => {
    const label = n.is_pinned ? '📌 Pinned' : nfDateLabel(n.created_at);
    if(label !== lastLabel){
      html += `<div class="nf-divider${n.is_pinned ? ' pinned' : ''}">${nfEsc(label)}</div>`;
      lastLabel = label;
    }
    html += cardFn(n);
  });
  return `<div class="nf-feed">${html}</div>`;
}

function nfCloseMenus(){
  document.querySelectorAll('.nf-menu.open').forEach(m => m.classList.remove('open', 'flip-up'));
  document.querySelectorAll('.nf-card.menu-open').forEach(c => c.classList.remove('menu-open'));
}

function nfToggleMenu(btn, ev){
  ev.stopPropagation();
  const menu = btn.closest('.nf-menu');
  const wasOpen = menu.classList.contains('open');
  nfCloseMenus();
  if(wasOpen) return;
  menu.classList.add('open');

  // An open menu brings its card to the front, so the next card doesn't cover it
  const card = menu.closest('.nf-card');
  if(card) card.classList.add('menu-open');

  // If there is little space below the feed, open the menu upwards (otherwise it gets cut off at the feed's edge)
  const list = menu.querySelector('.nf-menu-list');
  const feed = menu.closest('.notice-feed-scroll');
  if(list && feed){
    const need = list.offsetHeight + 8;
    const feedRect = feed.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const roomBelow = feedRect.bottom - menuRect.bottom;
    const roomAbove = menuRect.top - feedRect.top;
    menu.classList.toggle('flip-up', roomBelow < need && roomAbove > roomBelow);
  }
}
document.addEventListener('click', nfCloseMenus);

function nfToggleBody(el){ el.classList.toggle('expanded'); }

let cachedAdminNotices = [];
const NF_ROLE_LABEL = { student: 'Students', faculty: 'Faculty' };

// Who sent the notice — "Prof. Name" + Faculty label for faculty, "Name" + Admin label for admin
function nfAdminSender(n){
  const name = (n.posted_by_name || '').trim();
  if(!name) return '';
  const isFaculty = n.posted_by_role === 'faculty';
  const label = isFaculty ? 'Prof. ' + name.replace(/^Prof\.?\s*/i, '') : name;
  const roleText = isFaculty ? 'Faculty' : (n.posted_by_role === 'admin' ? 'Admin' : '');
  return `<div class="nf-sender">${nfEsc(label)}${roleText ? ` <small>${roleText}</small>` : ''}</div>`;
}

function nfAdminCard(n){
  const cat = n.category || 'Academic';
  const tagCls = NOTICE_TAG_CLASS[cat] || '';
  const scope = [
    n.target_role && n.target_role !== 'all' ? 'For ' + (NF_ROLE_LABEL[n.target_role] || n.target_role) : '',
    n.semester ? 'Sem ' + n.semester : '',
    n.division ? 'Div ' + n.division : '',
    n.academic_year || ''
  ].filter(Boolean).join(' · ');
  const seen = (n.seen_count || 0) > 0;
  // The admin's own notice — "sent" bubble on the right; faculty's/others' — card on the left, with the sender's name on top
  const cardCls = n.is_mine ? 'sent' : `received ${tagCls ? 'nf-cat-' + tagCls : ''}`;
  return `
    <div class="nf-card ${cardCls}">
      ${n.is_mine ? '' : nfAdminSender(n)}
      <div class="nf-top">
        <span class="notice-tag ${tagCls}">${nfEsc(cat)}</span>
        ${scope ? `<span class="nf-scope">${nfEsc(scope)}</span>` : ''}
        <div class="nf-menu">
          <button class="nf-menu-btn" onclick="nfToggleMenu(this, event)" title="More">⋯</button>
          <div class="nf-menu-list">
            <button onclick="nfAdminAction('reads', ${n.id})">👁 Seen by</button>
            <button onclick="nfAdminAction('pin', ${n.id})">${n.is_pinned ? '📌 Unpin' : '📍 Pin'}</button>
            <button onclick="nfAdminAction('edit', ${n.id})">✎ Edit</button>
            <button class="danger" onclick="nfAdminAction('delete', ${n.id})">🗑 Delete</button>
          </div>
        </div>
      </div>
      <div class="nf-title">${nfEsc(n.title)}</div>
      ${n.content ? `<div class="nf-body" onclick="nfToggleBody(this)">${nfEsc(n.content)}</div>` : ''}
      ${n.file_name ? nfFileChip(n, `nfAdminAction('preview', ${n.id})`, `nfAdminAction('download', ${n.id})`) : ''}
      <div class="nf-meta">
        <span>${nfTime(n.created_at)}</span>
        <button class="nf-ticks ${seen ? 'seen' : ''}" onclick="nfAdminAction('reads', ${n.id})" title="Seen by">${seen ? '✓✓ ' + n.seen_count : '✓ Sent'}</button>
      </div>
    </div>`;
}

// All buttons on the card work by id (so onclick doesn't break when the title has quotes)
function nfAdminAction(action, id){
  const n = cachedAdminNotices.find(x => x.id === id);
  if(!n) return;
  if(action === 'reads') openNoticeReads(id, n.title);
  else if(action === 'pin') toggleNoticePin(id, !!n.is_pinned);
  else if(action === 'edit') editNotice(n);
  else if(action === 'delete') deleteNotice(id, n.title);
  else if(action === 'preview') nfOpenPreview(id, n.file_name);
  else if(action === 'download') downloadNoticeFile(id);
}

// ---- Notices feed scroll (WhatsApp-style) ----
const NF_SCROLL_BTN = { noticesListBody: 'noticesScrollBtn' };

function nfNearBottom(el, threshold = 40){
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function nfUpdateScrollBtn(feedId){
  const el = document.getElementById(feedId);
  const btn = document.getElementById(NF_SCROLL_BTN[feedId]);
  if(!el || !btn) return;
  btn.classList.toggle('hidden', nfNearBottom(el));
}

function nfScrollToBottom(feedId, smooth = true){
  const el = document.getElementById(feedId);
  if(!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  nfUpdateScrollBtn(feedId);
}

Object.keys(NF_SCROLL_BTN).forEach(feedId => {
  const el = document.getElementById(feedId);
  if(el) el.addEventListener('scroll', () => nfUpdateScrollBtn(feedId));
});

// After a re-render: if the user was at the latest (bottom) or the feed was just built for the first time, keep it at the bottom,
// otherwise (they were reading older notices, or pinned/edited) leave their scroll position where it was
function nfSetFeedHtml(feedId, html){
  const el = document.getElementById(feedId);
  if(!el) return;
  const firstRender = !el.querySelector('.nf-feed');
  const wasNearBottom = firstRender || nfNearBottom(el);
  const scrollTopBefore = el.scrollTop;
  el.innerHTML = html;
  el.scrollTop = wasNearBottom ? el.scrollHeight : scrollTopBefore;
  nfUpdateScrollBtn(feedId);
}

// ============================================================
// NOTICE GROUPS (chat list like WhatsApp). The server decides each notice's group (n.group):
//   all   = "Students, Faculty & Admin"  (target_role all / student)
//   staff = "Admin & Faculty"            (target_role faculty — students can never see these)
// ============================================================
const NOTICE_GROUPS = {
  all:   { name: 'Students, Faculty & Admin', sub: 'Announcements for students and faculty', icon: '👥' },
  staff: { name: 'Admin & Faculty',           sub: 'Staff only — students can’t see this group', icon: '🏫' }
};
let adminNoticeGroup = null;   // null = the chat list is showing
let adminNoticesSnap = '';

function nfGroupNotices(key){
  return cachedAdminNotices.filter(n => n.group === key);
}

// "10:30 AM" today, "Yesterday", otherwise "12 Oct 2026" — like the WhatsApp chat list
function nfListTime(iso){
  const label = nfDateLabel(iso);
  return label === 'Today' ? nfTime(iso) : label;
}

function nfAdminPreview(n){
  const who = n.is_mine ? 'You' : (n.posted_by_name || '').trim();
  return (who ? who + ': ' : '') + (n.file_name ? '📎 ' : '') + n.title;
}

function renderNoticeGroupList(){
  const box = document.getElementById('noticeGroupList');
  if(!box) return;
  box.innerHTML = Object.keys(NOTICE_GROUPS).map(key => {
    const g = NOTICE_GROUPS[key];
    const list = nfGroupNotices(key);
    const last = list.reduce((a, n) => (!a || new Date(n.created_at) > new Date(a.created_at)) ? n : a, null);
    const unread = list.filter(n => !n.is_read && !n.is_mine).length;
    return `
      <button type="button" class="nf-group-row ${unread ? 'unread' : ''}" onclick="openNoticeGroup('${key}')">
        <div class="nf-group-avatar">${g.icon}</div>
        <div class="nf-group-main">
          <div class="nf-group-top">
            <span class="nf-group-name">${nfEsc(g.name)}</span>
            <span class="nf-group-time">${last ? nfEsc(nfListTime(last.created_at)) : ''}</span>
          </div>
          <div class="nf-group-bottom">
            <span class="nf-group-preview">${last ? nfEsc(nfAdminPreview(last)) : 'No notices yet'}</span>
            ${unread ? `<span class="nf-group-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>
        </div>
      </button>`;
  }).join('');
}

// The filters (category / semester / division / batch) work on the "Students, Faculty & Admin" group, same rules as before
function nfPassesFilters(n){
  const v = id => document.getElementById(id).value;
  const cat = v('noticeFilterCategory'), sem = v('noticeFilterSemester'), div = v('noticeFilterDivision'), yr = v('noticeFilterBatch');
  if(cat && n.category !== cat) return false;
  if(sem && n.semester != null && String(n.semester) !== sem) return false;
  if(div && n.division && n.division !== div) return false;
  if(yr && n.academic_year && n.academic_year !== yr) return false;
  return true;
}

function renderNoticeFeed(){
  if(!adminNoticeGroup) return;
  let list = nfGroupNotices(adminNoticeGroup);
  if(adminNoticeGroup === 'all') list = list.filter(nfPassesFilters);
  nfSetFeedHtml('noticesListBody', list.length
    ? nfRenderFeed(list, nfAdminCard)
    : '<div class="nf-empty">No notices here yet — type one below to send it.</div>');
}

function onNoticeFilterChange(){
  renderNoticeFeed();
}

// The staff group has no semester / division / batch / audience — those options are hidden there
function applyNoticeGroupToComposer(){
  const isStaff = adminNoticeGroup === 'staff';
  document.querySelectorAll('#noticeOptions [data-opt]').forEach(el => el.classList.toggle('hidden', isStaff));
  document.getElementById('noticeOptions').classList.add('hidden');
  document.getElementById('noticeScopeLine').classList.remove('open');
}

function openNoticeGroup(key){
  const g = NOTICE_GROUPS[key];
  if(!g) return;
  adminNoticeGroup = key;
  document.getElementById('noticeGroupsCard').classList.add('hidden');
  document.getElementById('noticeChatCard').classList.remove('hidden');
  document.getElementById('noticeChatAvatar').textContent = g.icon;
  document.getElementById('noticeChatName').textContent = g.name;
  document.getElementById('noticeChatSub').textContent = g.sub;
  document.getElementById('noticeFilterRow').classList.toggle('hidden', key !== 'all');
  applyNoticeGroupToComposer();
  resetNoticeForm();
  document.getElementById('noticesListBody').innerHTML = '';   // fresh feed -> opens scrolled to the latest notice
  renderNoticeFeed();
  nfScrollToBottom('noticesListBody', false);
  if(nfGroupNotices(key).some(n => !n.is_read)) markNoticeGroupRead(key);
}

function closeNoticeGroup(){
  adminNoticeGroup = null;
  nfCloseMenus();
  resetNoticeForm();
  document.getElementById('noticeChatCard').classList.add('hidden');
  document.getElementById('noticeGroupsCard').classList.remove('hidden');
  renderNoticeGroupList();
}

// Opening a group = the admin has seen its notices (so the 👁 counts of faculty's notices include the admin)
let nfAutoMarkBusy = false;
async function markNoticeGroupRead(key){
  if(nfAutoMarkBusy) return;
  nfAutoMarkBusy = true;
  try{
    await apiRequest('/admin/notices/mark-read', { method: 'POST', body: JSON.stringify({ group: key }) });
    cachedAdminNotices.forEach(n => { if(n.group === key) n.is_read = true; });
    renderNoticeGroupList();
    // the 🔔 badge counts by time, so clear it only when no group has anything unread
    if(!cachedAdminNotices.some(n => !n.is_read)) localStorage.setItem('notifSeenAt', toLocalDbDateTime(new Date()));
    refreshNotifBadge();
    adminNoticesSnap = '';
    await loadNotices(true);
  }catch(err){
    // silent fail
  }finally{
    nfAutoMarkBusy = false;
  }
}

async function loadNotices(silent){
  const list = document.getElementById('noticeGroupList');
  if(list && !list.children.length) list.innerHTML = '<div class="nf-empty" style="padding:18px;">Loading…</div>';

  try{
    const notices = await apiRequest('/admin/notices');
    if(!list) return;
    // background refresh: if nothing changed, don't touch the screen (expanded cards / scroll stay as they are)
    const snap = JSON.stringify(notices);
    if(silent === true && snap === adminNoticesSnap) return;
    adminNoticesSnap = snap;
    cachedAdminNotices = notices;
    renderNoticeGroupList();
    if(adminNoticeGroup){
      renderNoticeFeed();
      // a new notice arrived while this group is open -> it is seen right away
      if(!nfAutoMarkBusy && nfGroupNotices(adminNoticeGroup).some(n => !n.is_read)) markNoticeGroupRead(adminNoticeGroup);
    }
  }catch(err){
    if(silent === true) return;
    if(list) list.innerHTML = `<div class="nf-empty" style="padding:18px;">Failed to load notices: ${escapeHtml(err.message)}</div>`;
  }
}

let nfcSending = false;
async function saveNotice(){
  if(nfcSending) return;
  const editId = document.getElementById('noticeEditId').value;
  const box = document.getElementById('noticeContent');
  const text = box.value.trim();
  const file = document.getElementById('noticeFile').files[0];

  if(!adminNoticeGroup) return;
  const isStaff = adminNoticeGroup === 'staff';   // "Admin & Faculty": audience is fixed, no semester / division / batch
  const role = isStaff ? 'faculty' : document.getElementById('noticeTargetRole').value;
  const sem = isStaff ? '' : document.getElementById('noticeSemester').value;
  const div = isStaff ? '' : document.getElementById('noticeDivision').value;
  const batch = isStaff ? '' : document.getElementById('noticeBatch').value;

  let { title, content } = nfcSplitMessage(text);
  // Only a file, no text -> the file name becomes the title (like sending a document on WhatsApp)
  if(!editId && !title && file){
    title = file.name.length > NFC_MAX_TITLE ? file.name.slice(0, NFC_MAX_TITLE - 1) + '…' : file.name;
    content = '';
  }
  if(!title){
    alert('Type a notice first');
    box.focus();
    return;
  }

  const send = document.getElementById('noticeSendBtn');
  nfcSending = true;
  send.disabled = true;
  try{
    if(editId){
      // The file attachment is not changed on edit — only the details are updated
      const payload = {
        title,
        content,
        category: document.getElementById('noticeCategory').value,
        target_role: role,
        semester: sem || null,
        division: div || null,
        academic_year: batch || null,
        is_pinned: document.getElementById('noticePinned').value === '1'
      };
      await apiRequest(`/admin/notices/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      const formData = new FormData();
      formData.append('title', title);
      formData.append('content', content);
      formData.append('category', document.getElementById('noticeCategory').value);
      formData.append('target_role', role);
      formData.append('semester', sem || '');
      formData.append('division', div || '');
      formData.append('academic_year', batch || '');
      formData.append('is_pinned', document.getElementById('noticePinned').value === '1' ? '1' : '0');
      if(file) formData.append('file', file);
      await apiUpload('/admin/notices', formData);
    }
    resetNoticeForm();
    await loadNotices();
    if(!editId) nfScrollToBottom('noticesListBody');   // their own new notice should show at the bottom
  }catch(err){
    alert('Error: ' + err.message);   // the typed message stays in the box so nothing is lost
  }finally{
    nfcSending = false;
    send.disabled = false;
  }
}

// Edit = the message goes back into the bar (title on the first line, body below it)
function editNotice(notice){
  document.getElementById('noticeEditId').value = notice.id;
  const box = document.getElementById('noticeContent');
  box.value = notice.content ? notice.title + '\n' + notice.content : notice.title;
  document.getElementById('noticeCategory').value = notice.category || 'Academic';
  document.getElementById('noticeTargetRole').value = notice.target_role || 'all';
  document.getElementById('noticeSemester').value = notice.semester || '';
  document.getElementById('noticeDivision').value = notice.division || '';
  document.getElementById('noticeBatch').value = notice.academic_year || '';
  document.getElementById('noticePinned').value = notice.is_pinned ? '1' : '0';
  document.getElementById('noticeFile').value = '';
  nfcRenderFilePreview();
  document.getElementById('noticeAttachBtn').classList.add('hidden');   // attachment is not changed on edit
  document.getElementById('noticeEditText').textContent = '✎ Editing notice' + (notice.file_name ? ' · attachment can’t be changed' : '');
  document.getElementById('noticeEditBanner').classList.remove('hidden');
  const send = document.getElementById('noticeSendBtn');
  send.textContent = '✓';
  send.title = 'Save changes';
  updateNoticeScopeLine();
  nfcAutoGrow(box);
  box.focus();
}

async function toggleNoticePin(id, currentlyPinned){
  try{
    await apiRequest(`/admin/notices/${id}/pin`, { method: 'PATCH', body: JSON.stringify({ is_pinned: !currentlyPinned }) });
    loadNotices();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

async function deleteNotice(id, title){
  if(!confirm(`Delete the notice "${title}"?`)) return;
  try{
    await apiRequest(`/admin/notices/${id}`, { method: 'DELETE' });
    loadNotices();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ============================================================
// NOTICE ATTACHMENT PREVIEW (WhatsApp-style)
// Image (jpg/png) -> shown inline in the notice card, click = full-screen view
// PDF             -> card with a Preview button (opens in a viewer popup) + Download
// Word / PowerPoint -> a browser cannot display these, so they stay download-only
// Files are fetched with the login token and shown through blob URLs (an <img src>
// cannot send the Authorization header). Images load lazily when the card scrolls
// into view, and every loaded image is cached so the 5-sec refresh doesn't reload it.
// ============================================================
const NF_TOKEN_KEY = 'token_admin';
const NF_ENDPOINT = '/admin/notices';
const NF_ESC = s => nfEsc(s);
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
  if(kind === 'file'){ downloadNoticeFile(id, fileName); return; }

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
  document.getElementById('nfViewerDl').onclick = () => downloadNoticeFile(id, fileName);

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

async function downloadNoticeFile(id){
  try{
    const res = await fetch(API_BASE + `/admin/notices/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_admin') }
    });
    if(!res.ok){
      alert('Download failed');
      return;
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const fileName = match ? match[1] : 'attachment';
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

function formatDateTime(dateStr){
  const d = new Date(dateStr);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---- Notice "seen by" modal ----
async function openNoticeReads(noticeId, title){
  document.getElementById('noticeReadsTitle').textContent = `Seen — ${title}`;
  document.getElementById('noticeReadsOverlay').classList.add('open');
  const body = document.getElementById('noticeReadsBody');
  body.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';

  try{
    const data = await apiRequest(`/admin/notices/${noticeId}/reads`);
    document.getElementById('noticeReadsSummary').textContent = `${data.seen_count} of ${data.target_total} seen`;
    body.innerHTML = data.seen_by.length ? data.seen_by.map(r => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.login_id)}</td>
        <td style="text-transform:capitalize;">${escapeHtml(r.role)}</td>
        <td>${escapeHtml(formatDateTime(r.seen_at))}</td>
      </tr>
    `).join('') : '<tr><td colspan="4">No one has viewed this yet.</td></tr>';
  }catch(err){
    body.innerHTML = `<tr><td colspan="4">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function closeNoticeReads(){
  document.getElementById('noticeReadsOverlay').classList.remove('open');
}

// ---- Marks Requests (approval workflow for faculty submissions) ----
function escapeHtmlMR(str){
  return String(str ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

let currentMarksRequestStatus = 'pending';
let currentMarksRequestId = null;

function goToPendingMarksRequests(){
  switchView('marks-requests');
  const pendingBtn = document.querySelector('#view-marks-requests .pill-tab[data-status="pending"]');
  if(pendingBtn) setMarksRequestTab(pendingBtn, 'pending');
}

function setMarksRequestTab(btn, status){
  document.querySelectorAll('#view-marks-requests .pill-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  closeMarksRequestDetail();
  loadMarksRequests(status);
}

async function loadMarksRequests(status){
  currentMarksRequestStatus = status;
  const tbody = document.getElementById('marksRequestsTableBody');
  tbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted);">Loading...</td></tr>';
  try{
    const data = await apiRequest('/admin/marks/requests?status=' + encodeURIComponent(status));
    const requests = data.requests || [];

    const badge = document.getElementById('marksRequestBadge');
    if(status === 'pending'){
      if(requests.length > 0){ badge.textContent = requests.length; badge.style.display = ''; }
      else { badge.style.display = 'none'; }
    }

    if(requests.length === 0){
      tbody.innerHTML = `<tr><td colspan="8" style="color:var(--muted);">There are no ${status} requests.</td></tr>`;
      return;
    }
    tbody.innerHTML = requests.map(r => `
      <tr>
        <td>${escapeHtmlMR(r.faculty_name)}</td>
        <td>${escapeHtmlMR(r.subject_name)}</td>
        <td>${escapeHtmlMR(r.exam_type)}</td>
        <td>Sem ${escapeHtml(r.semester)} / ${escapeHtml(r.division || 'All')}</td>
        <td>${escapeHtmlMR(r.academic_year)}</td>
        <td>${r.student_count}</td>
        <td>${formatDateTime(r.submitted_at)}</td>
        <td><button class="btn-ghost" onclick="openMarksRequestDetail(${r.id})">View</button></td>
      </tr>
    `).join('');
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="8" style="color:red;">Load failed: ${escapeHtmlMR(err.message)}</td></tr>`;
  }
}

async function openMarksRequestDetail(requestId){
  currentMarksRequestId = requestId;
  const panel = document.getElementById('marksRequestDetail');
  const title = document.getElementById('marksRequestDetailTitle');
  const meta = document.getElementById('marksRequestDetailMeta');
  const body = document.getElementById('marksRequestDetailBody');
  const pendingActions = document.getElementById('marksRequestPendingActions');
  const publishBtn = document.getElementById('marksRequestPublishBtn');
  const remarksBox = document.getElementById('marksRequestRemarks');

  panel.classList.remove('hidden');
  title.textContent = 'Loading...';
  body.innerHTML = '';
  remarksBox.value = '';

  try{
    const req = await apiRequest('/admin/marks/requests/' + requestId);
    title.textContent = `${req.subject_name} · ${req.exam_type} · Sem ${req.semester} / ${req.division || 'All'}`;
    meta.textContent = `Faculty: ${req.faculty_name} · Batch: ${req.academic_year} · Max marks: ${req.max_marks} · Submitted: ${formatDateTime(req.submitted_at)} · Status: ${req.status}`
      + (req.remarks ? ` · Remarks: ${req.remarks}` : '');
    body.innerHTML = (req.students || []).map(s => `
      <tr>
        <td>${escapeHtmlMR(s.enrollment)}</td>
        <td>${escapeHtmlMR(s.name)}</td>
        <td>${escapeHtml(s.marks_obtained ?? '—')}</td>
      </tr>
    `).join('') || '<tr><td colspan="3" style="color:var(--muted);">No student was found.</td></tr>';

    // Show the right actions according to the status
    pendingActions.style.display = req.status === 'pending' ? 'flex' : 'none';
    publishBtn.classList.toggle('hidden', req.status !== 'approved');
  }catch(err){
    title.textContent = 'Failed to load';
    meta.textContent = err.message;
  }
}

function closeMarksRequestDetail(){
  document.getElementById('marksRequestDetail').classList.add('hidden');
  currentMarksRequestId = null;
}

async function decideMarksRequest(decision){
  if(!currentMarksRequestId) return;
  const remarks = document.getElementById('marksRequestRemarks').value.trim();
  if(decision === 'rejected' && !confirm('Reject this request?')) return;

  try{
    await apiRequest(`/admin/marks/requests/${currentMarksRequestId}/decision`, {
      method: 'PUT',
      body: JSON.stringify({ decision, remarks: remarks || null })
    });
    alert(`Request ${decision}. A notice has been sent to the faculty.`);
    closeMarksRequestDetail();
    loadMarksRequests(currentMarksRequestStatus);
    loadDashboardStats();
    loadDashboardPendingMarks();
  }catch(err){
    alert('Decision could not be saved: ' + err.message);
  }
}

async function publishMarksRequest(){
  if(!currentMarksRequestId) return;
  if(!confirm('Publishing will make these marks visible to students immediately. Continue?')) return;
  try{
    await apiRequest(`/admin/marks/requests/${currentMarksRequestId}/publish`, { method: 'PUT' });
    alert('Marks published.');
    closeMarksRequestDetail();
    loadMarksRequests(currentMarksRequestStatus);
    loadDashboardStats();
  }catch(err){
    alert('Publish failed: ' + err.message);
  }
}
// ============================================================
// Settings — College & Department info
// ============================================================
async function loadAdminSettings(){
  try{
    const s = await apiRequest('/admin/settings');
    document.getElementById('settingsCollegeName').value = s.college_name || '';
    document.getElementById('settingsCollegeEmail').value = s.college_email || '';
    document.getElementById('settingsCollegeAddress').value = s.college_address || '';
    document.getElementById('settingsDeptName').value = s.department_name || '';
    document.getElementById('settingsHodName').value = s.hod_name || '';
  }catch(err){
    console.error('Settings load error:', err.message);
  }
}

async function saveAdminSettings(){
  const payload = {
    college_name: document.getElementById('settingsCollegeName').value.trim(),
    college_email: document.getElementById('settingsCollegeEmail').value.trim(),
    college_address: document.getElementById('settingsCollegeAddress').value.trim(),
    department_name: document.getElementById('settingsDeptName').value.trim(),
    hod_name: document.getElementById('settingsHodName').value.trim()
  };
  try{
    await apiRequest('/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    alert('Settings saved');
  }catch(err){
    alert('Save failed: ' + err.message);
  }
}

// ============================================================
// Security — Change password + Login history
// ============================================================
async function changeAdminPassword(){
  const current = document.getElementById('secCurrentPassword').value;
  const newPass = document.getElementById('secNewPassword').value;
  const confirm = document.getElementById('secConfirmPassword').value;

  if(!current || !newPass || !confirm){
    alert('Fill in all fields');
    return;
  }
  if(newPass.length < 8){
    alert('New password must be at least 8 characters long');
    return;
  }
  if(newPass !== confirm){
    alert('New password and confirm password do not match');
    return;
  }

  try{
    await apiRequest('/admin/change-password', {
      method: 'PUT',
      body: JSON.stringify({ current_password: current, new_password: newPass })
    });
    alert('Password updated');
    document.getElementById('secCurrentPassword').value = '';
    document.getElementById('secNewPassword').value = '';
    document.getElementById('secConfirmPassword').value = '';
  }catch(err){
    alert('Password update failed: ' + err.message);
  }
}

async function loadLoginHistory(){
  const body = document.getElementById('loginHistoryBody');
  try{
    const rows = await apiRequest('/admin/login-history');
    if(rows.length === 0){
      body.innerHTML = '<tr><td colspan="4">There is no login history</td></tr>';
      return;
    }
    body.innerHTML = rows.map(r => `<tr>
        <td>${escapeHtmlMR(r.name)}</td>
        <td>${escapeHtmlMR(r.role)}</td>
        <td>${formatDateTime(r.login_time)}</td>
        <td>${escapeHtmlMR(r.ip_address || '-')}</td>
      </tr>`).join('');
  }catch(err){
    body.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
  }
}

// ============================================================
// Academic management — Academic Year + live Divisions summary
// ============================================================
// To show a date in a readable format (e.g. "2026-07-01" -> "1 Jul 2026")
function formatShortDate(dateStr){
  if(!dateStr) return '—';
  const d = new Date(dateStr);
  if(isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

let academicYearsCache = [];

async function loadAcademicYears(){
  const container = document.getElementById('academicYearsList');
  try{
    const years = await apiRequest('/admin/academic-years');
    applyAcademicYearsToDropdowns(years);   // all the "Batch (Academic Year)" dropdowns are refreshed from here

    if(years.length === 0){
      container.innerHTML = '<div class="notice-row" style="border-bottom:none;">No academic year has been added</div>';
      return;
    }
    academicYearsCache = years;   // to pre-fill the edit form
    const todayStr = new Date().toISOString().slice(0, 10);

    container.innerHTML = years.map((y, i) => {
      const isLast = i === years.length - 1;

      const semRows = [1,2,3,4,5,6].map(n => {
        const start = y[`sem${n}_start`];
        const end = y[`sem${n}_end`];
        if(!start && !end) return '';   // this semester's date of this year is not set at all — skip
        const running = start && end && todayStr >= start && todayStr <= end;
        return `<div style="margin-top:4px;">
            <b style="color:${running ? 'var(--ink)' : 'var(--muted)'};">Sem ${n}${running ? ' — running now' : ''}</b>:
            ${formatShortDate(start)} – ${formatShortDate(end)}
          </div>`;
      }).join('');

      const semBlock = semRows
        ? `<div style="margin-top:8px; font-size:12.5px; color:var(--muted);">${semRows}</div>`
        : `<div style="margin-top:8px; font-size:12.5px; color:var(--muted);">No semester dates are set</div>`;

      return `<div class="notice-row"${isLast ? ' style="border-bottom:none;"' : ''}>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <b>${escapeHtmlMR(y.year_label)}</b>
            <span>
              <button class="icon-action" title="Edit" onclick="editAcademicYear(${y.id})">✎</button>
              <button class="icon-action danger" title="Delete" onclick="deleteAcademicYear(${y.id}, '${escapeHtmlMR(y.year_label)}')">🗑</button>
            </span>
          </div>
          ${semBlock}
        </div>`;
    }).join('');
  }catch(err){
    container.innerHTML = '<div class="notice-row" style="border-bottom:none;">Failed to load</div>';
  }
}

async function deleteAcademicYear(id, label){
  if(!confirm(`Delete academic year ${label}?\n\nIt will be removed from every Batch dropdown (admin panel and register page). Existing student/subject records are not deleted.`)) return;
  try{
    await apiRequest(`/admin/academic-years/${id}`, { method: 'DELETE' });
    loadAcademicYears();
  }catch(err){
    alert('Delete failed: ' + err.message);
  }
}

function resetAcademicYearForm(){
  document.getElementById('academicYearEditId').value = '';
  const input = document.getElementById('newAcademicYear');
  input.value = '';
  input.disabled = false;
  document.getElementById('academicYearFormTitle').textContent = 'Add academic year';
  for(let n = 1; n <= 6; n++){
    document.getElementById(`newSem${n}Start`).value = '';
    document.getElementById(`newSem${n}End`).value = '';
  }
}

function openAddAcademicYearForm(){
  resetAcademicYearForm();
  document.getElementById('academicYearForm').classList.remove('hidden');
}

function closeAcademicYearForm(){
  resetAcademicYearForm();
  document.getElementById('academicYearForm').classList.add('hidden');
}

function editAcademicYear(id){
  const y = academicYearsCache.find(row => row.id === id);
  if(!y) return;
  document.getElementById('academicYearEditId').value = y.id;
  const input = document.getElementById('newAcademicYear');
  input.value = y.year_label;
  input.disabled = true;   // the label is linked to students/subjects etc., so it can't be edited
  document.getElementById('academicYearFormTitle').textContent = `Edit academic year — ${y.year_label}`;
  for(let n = 1; n <= 6; n++){
    document.getElementById(`newSem${n}Start`).value = y[`sem${n}_start`] ? String(y[`sem${n}_start`]).slice(0, 10) : '';
    document.getElementById(`newSem${n}End`).value = y[`sem${n}_end`] ? String(y[`sem${n}_end`]).slice(0, 10) : '';
  }
  const form = document.getElementById('academicYearForm');
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function addAcademicYear(){
  const editId = document.getElementById('academicYearEditId').value;
  const yearLabel = document.getElementById('newAcademicYear').value.trim();
  if(!yearLabel){
    alert('Enter the academic year (e.g. 2027-28)');
    return;
  }
  const payload = { year_label: yearLabel };
  for(let n = 1; n <= 6; n++){
    const start = document.getElementById(`newSem${n}Start`).value || null;
    const end = document.getElementById(`newSem${n}End`).value || null;
    if(start && end && start > end){
      alert(`Sem ${n}: start date must be before end date`);
      return;
    }
    payload[`sem${n}_start`] = start;
    payload[`sem${n}_end`] = end;
  }
  try{
    await apiRequest(editId ? `/admin/academic-years/${editId}` : '/admin/academic-years', {
      method: editId ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    closeAcademicYearForm();
    loadAcademicYears();
  }catch(err){
    alert('Save failed: ' + err.message);
  }
}

async function loadDivisionsSummary(){
  const body = document.getElementById('divisionsSummaryBody');
  try{
    const rows = await apiRequest('/admin/divisions-summary');
    if(rows.length === 0){
      body.innerHTML = '<tr><td colspan="4">There is no division data</td></tr>';
      return;
    }
    body.innerHTML = rows.map(r => `<tr>
        <td>${escapeHtmlMR(r.division)}</td>
        <td>${escapeHtml(deptName(r.department))}</td>
        <td>Sem ${r.semester}</td>
        <td>${r.student_count}</td>
      </tr>`).join('');
  }catch(err){
    body.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
  }
}

// ============================================================
// Syncs all the "Batch (Academic Year)" dropdowns (Add forms + filters)
// with the academic_years table of Academic Management.
// Where an empty placeholder option like "All batches"/"Any" already
// exists, that is preserved; where there is none, the Active
// (current) academic year is selected by default.
// ============================================================
const BATCH_YEAR_SELECT_IDS = [
  'studentBatch', 'studentFilterYear',
  'facultyBatch', 'facultyFilterYear',
  'subjectBatch', 'subjectFilterYear',
  'gridBatch', 'ttBatch', 'examTtBatch', 'ttListFilterYear',
  'attBatch', 'noteBatch', 'noteFilterYear',
  'assignBatch', 'assignFilterYear',
  'noticeBatch', 'noticeFilterBatch',
  'marksBatch', 'feeBatch', 'feeFilterYear',
  'repStudentBatch', 'repAttendanceBatch', 'repAssignmentBatch', 'repFeeBatch'
];

function formatYearLabel(label){
  // '2026-27' -> '2026 - 2027'
  const parts = String(label).split('-');
  if(parts.length !== 2) return label;
  const century = parts[0].slice(0, 2);
  return `${parts[0]} - ${century}${parts[1]}`;
}

function applyAcademicYearsToDropdowns(years){
  if(!years || years.length === 0) return;

  // The row whose date range (of any semester 1-6) contains today's date
  // is treated as the "current" batch; otherwise the most recent
  // year_label becomes the fallback.
  const todayStr = new Date().toISOString().slice(0, 10);
  const current = years.find(y =>
    [1,2,3,4,5,6].some(n => y[`sem${n}_start`] && y[`sem${n}_end`] && todayStr >= y[`sem${n}_start`] && todayStr <= y[`sem${n}_end`])
  ) || years[0];

  BATCH_YEAR_SELECT_IDS.forEach(id => {
    const sel = document.getElementById(id);
    if(!sel) return;

    const firstOption = sel.options[0];
    const hasPlaceholder = !!firstOption && firstOption.value === '';
    const placeholderText = hasPlaceholder ? firstOption.textContent : null;
    const previousValue = sel.value;   // if the edit form is open, its existing value must be preserved

    sel.innerHTML = '';
    if(hasPlaceholder){
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = placeholderText;
      sel.appendChild(opt);
    }
    years.forEach(y => {
      const opt = document.createElement('option');
      opt.value = y.year_label;
      opt.textContent = formatYearLabel(y.year_label);
      sel.appendChild(opt);
    });

    const stillValid = Array.from(sel.options).some(o => o.value === previousValue);
    if(previousValue && stillValid){
      sel.value = previousValue;
    } else if(!hasPlaceholder){
      sel.value = current.year_label;   // if there is no "All"/"Any" placeholder, select the Active year by default
    }
  });
}

// ============================================================
// Logout — clear token/role/name and send to the login page
// ============================================================
function logout(){
  if(!confirm('Log out?')) return;
  sessionStorage.removeItem('token_admin');
  sessionStorage.removeItem('name_admin');
  window.location.href = '../login_panel/login.html';
}

// Show the 'name' saved in sessionStorage at login in the sidebar +
// profile dropdown (instead of the hardcoded "Admin")
function applyProfileNameToUI(){
  const name = sessionStorage.getItem('name_admin') || 'Admin';
  const initial = name.charAt(0).toUpperCase();
  const nameEls = [document.getElementById('sidebarProfileName'), document.getElementById('profileMenuName')];
  nameEls.forEach(el => { if(el) el.textContent = name; });
  const initialEls = [document.getElementById('sidebarAvatarInitial'), document.getElementById('topbarAvatarInitial')];
  initialEls.forEach(el => { if(el) el.textContent = initial; });
}

// ============================================================
// The 'since' timestamp must be sent in the DB's naive local (IST) datetime format —
// new Date().toISOString() gives UTC, which mismatches the local timestamps of notices/marks_requests
// by 5:30 hours, and even a notice that was already seen keeps showing as unseen.
function toLocalDbDateTime(d){
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Topbar dropdowns — profile menu, global search.
// Only one dropdown stays open at a time, and it closes on clicking outside.
// ============================================================
function closeAllMenus(){
  ['profileMenu', 'globalSearchResults'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.classList.add('hidden');
  });
}

function toggleProfileMenu(e){
  e.stopPropagation();
  const menu = document.getElementById('profileMenu');
  const wasHidden = menu.classList.contains('hidden');
  closeAllMenus();
  if(wasHidden) menu.classList.remove('hidden');
}

// On page load (and every 60 sec) checks the unseen count and shows the number on the red dot
async function refreshNotifBadge(){
  try{
    const since = localStorage.getItem('notifSeenAt') || '';
    const data = await apiRequest('/admin/notifications?since=' + encodeURIComponent(since));
    const dot = document.getElementById('notifDot');
    if(data.unseen_count > 0){
      dot.textContent = data.unseen_count > 99 ? '99+' : data.unseen_count;
      dot.classList.remove('hidden');
    } else {
      dot.classList.add('hidden');
    }
  }catch(err){
    // silent fail — the badge just won't update
  }
}

// ============================================================
// Global search — searches students/faculty by name
// or enrollment/ID from the header search box
// ============================================================
let globalSearchDebounce = null;

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
  document.getElementById('globalSearchResults').classList.add('hidden');
  document.getElementById('globalSearchInput').value = '';
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
  return '<div class="dropdown-item" style="font-weight:600; cursor:default; background:var(--mint-100);">Menu</div>' +
    matches.map((it, i) => `
      <div class="dropdown-item" onclick="goToMenuItem(${i})">
        ${it.icon ? it.icon + ' ' : ''}${escapeHtmlMR(it.label)}${it.parent ? ` <span style="color:var(--muted); font-size:12px;">· ${escapeHtmlMR(it.parent)}</span>` : ''}
      </div>`).join('');
}

function onGlobalSearchInput(){
  clearTimeout(globalSearchDebounce);
  const query = document.getElementById('globalSearchInput').value.trim();
  const resultsBox = document.getElementById('globalSearchResults');

  if(query.length < 2){
    resultsBox.classList.add('hidden');
    return;
  }
  globalSearchDebounce = setTimeout(() => runGlobalSearch(query), 300);
}

async function runGlobalSearch(query){
  const resultsBox = document.getElementById('globalSearchResults');
  closeAllMenus();
  const menuHtml = menuSearchHtml(getMenuMatches(query));   // sidebar titles match instantly, no API call
  resultsBox.classList.remove('hidden');
  resultsBox.innerHTML = menuHtml + '<div class="dropdown-empty">Searching…</div>';

  try{
    const [students, faculty] = await Promise.all([
      apiRequest('/admin/students?limit=5&search=' + encodeURIComponent(query)),
      apiRequest('/admin/faculty?search=' + encodeURIComponent(query))
    ]);

    let html = menuHtml;
    if(students.length){
      html += '<div class="dropdown-item" style="font-weight:600; cursor:default; background:var(--mint-100);">Students</div>';
      html += students.slice(0, 5).map(s => `
        <div class="dropdown-item" data-id="${escapeHtml(s.enrollment)}" onclick="goToSearchResult('student', this.dataset.id)">
          ${escapeHtmlMR(s.name)} <span style="color:var(--muted); font-size:12px;">· ${escapeHtmlMR(s.enrollment)}</span>
        </div>`).join('');
    }
    if(faculty.length){
      html += '<div class="dropdown-item" style="font-weight:600; cursor:default; background:var(--mint-100);">Faculty</div>';
      html += faculty.slice(0, 5).map(f => `
        <div class="dropdown-item" data-id="${escapeHtml(f.faculty_id)}" onclick="goToSearchResult('faculty', this.dataset.id)">
          ${escapeHtmlMR(f.name)} <span style="color:var(--muted); font-size:12px;">· ${escapeHtmlMR(f.faculty_id)}</span>
        </div>`).join('');
    }
    resultsBox.innerHTML = html || '<div class="dropdown-empty">No matches found</div>';
  }catch(err){
    resultsBox.innerHTML = menuHtml + '<div class="dropdown-empty">Search failed</div>';
  }
}

// On clicking a result, goes to that view, finds its row and highlights/scrolls to it
function goToSearchResult(type, idText){
  document.getElementById('globalSearchResults').classList.add('hidden');
  document.getElementById('globalSearchInput').value = '';

  const targetView = type === 'student' ? 'students' : 'faculty';
  const tbodyId = type === 'student' ? 'studentsTableBody' : 'facultyTableBody';
  switchView(targetView);

  if(type === 'student'){
    const box = document.getElementById('studentSearch');
    if(box) box.value = idText;   // the list is paginated, so filter it down to this student (clear the box to see all again)
  }
  const loader = type === 'student' ? loadStudents : loadFaculty;
  loader().then(() => {
    setTimeout(() => {
      const tbody = document.getElementById(tbodyId);
      if(!tbody) return;
      const row = Array.from(tbody.querySelectorAll('tr')).find(tr => tr.textContent.includes(idText));
      if(row){
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.transition = 'background-color 0.3s';
        row.style.backgroundColor = 'var(--mint-200, #fff3cd)';
        setTimeout(() => { row.style.backgroundColor = ''; }, 2000);
      }
    }, 300);
  });
}

document.addEventListener('click', closeAllMenus);   // click outside the dropdown = close

// ============================================================
// REPORTS — dynamically fills the Subject dropdown of the filter panels according to
// the selected Batch+Sem, and triggers the Excel download.
// ============================================================
async function onReportBatchOrSemChange(reportType){
  const batch = document.getElementById(`rep${reportType}Batch`).value;
  const sem = document.getElementById(`rep${reportType}Sem`).value;
  const subjectSel = document.getElementById(`rep${reportType}Subject`);
  const isRequired = reportType === 'Student';

  if(!batch || !sem){
    subjectSel.innerHTML = `<option value="">${isRequired ? 'Select semester first' : 'All subjects'}</option>`;
    return;
  }
  try{
    const subjects = await apiRequest(`/admin/subjects?academic_year=${encodeURIComponent(batch)}`);
    const filtered = subjects.filter(s => String(s.semester) === String(sem));
    const placeholder = isRequired ? '<option value="">Select subject</option>' : '<option value="">All subjects</option>';
    subjectSel.innerHTML = placeholder + filtered.map(s => `<option value="${s.id}">${escapeHtmlMR(s.subject_name)}</option>`).join('');
  }catch(err){
    subjectSel.innerHTML = '<option value="">Failed to load</option>';
  }
}

async function downloadReportFile(url, filenameFallback){
  try{
    const res = await fetch(API_BASE + url, {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_admin') }
    });
    if(!res.ok){
      const err = await res.json().catch(() => ({}));
      alert(err.message || 'Report generation failed');
      return;
    }
    const blob = await res.blob();
    const dlUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = filenameFallback;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(dlUrl);
  }catch(err){
    alert('Download error: ' + err.message);
  }
}

function downloadReport(reportType, format = 'xlsx'){
  const batch = document.getElementById(`rep${reportType}Batch`).value;
  const sem = document.getElementById(`rep${reportType}Sem`).value;
  const div = document.getElementById(`rep${reportType}Div`).value;
  const subject = document.getElementById(`rep${reportType}Subject`).value;

  if(!batch || !sem){
    alert('Select both Batch and Semester');
    return;
  }
  if(reportType === 'Student' && !subject){
    alert('Subject must be selected for the Student Report');
    return;
  }

  const params = new URLSearchParams({ academic_year: batch, semester: sem });
  if(div) params.set('division', div);
  if(subject) params.set('subject_id', subject);
  if(format === 'pdf') params.set('format', 'pdf');

  const endpoint = reportType.toLowerCase();   // 'student' | 'attendance' | 'assignment'
  downloadReportFile(`/admin/reports/${endpoint}s/excel?${params.toString()}`, `${endpoint}_report.${format}`);
}

function downloadLoginActivityReport(format = 'xlsx'){
  const params = new URLSearchParams();
  const from = document.getElementById('repLoginFrom').value;
  const to = document.getElementById('repLoginTo').value;
  const role = document.getElementById('repLoginRole').value;
  if(from) params.set('from_date', from);
  if(to) params.set('to_date', to);
  if(role) params.set('role', role);
  if(format === 'pdf') params.set('format', 'pdf');

  downloadReportFile(`/admin/reports/login-activity/excel?${params.toString()}`, `login_activity_report.${format}`);
}

// ---- Fee Report (any class; same report as the Faculty panel) ----
let adminFeeRepSeq = 0;

function openAdminFeeReport(){
  toggleForm('reportFeePanel');
  const panel = document.getElementById('reportFeePanel');
  if(panel && !panel.classList.contains('hidden')) loadAdminFeeReportItems();
}

// The fee items are whatever was created for that class, so the list comes from the class's own fee records.
async function loadAdminFeeReportItems(){
  const batch = document.getElementById('repFeeBatch').value;
  const sem = document.getElementById('repFeeSem').value;
  const div = document.getElementById('repFeeDiv').value;
  const itemSel = document.getElementById('repFeeItem');
  const hint = document.getElementById('repFeeHint');
  const seq = ++adminFeeRepSeq;
  itemSel.innerHTML = '<option value="">All fee items</option>';
  hint.textContent = '';
  if(!batch || !sem) return;
  try{
    let url = '/admin/fees?semester=' + encodeURIComponent(sem) + '&academic_year=' + encodeURIComponent(batch);
    if(div) url += '&division=' + encodeURIComponent(div);
    const fees = await apiRequest(url);
    if(seq !== adminFeeRepSeq) return;
    const titles = [...new Set((fees || []).map(f => (f.fee_title || '').trim() || 'Untitled'))]
      .sort((a, b) => a.localeCompare(b));
    itemSel.innerHTML = '<option value="">All fee items</option>' +
      titles.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    if(!titles.length) hint.textContent = 'No fee records for this class yet. Add fees first from the Fees section.';
  }catch(err){
    if(seq !== adminFeeRepSeq) return;
    hint.textContent = 'Could not load the fee items for this class.';
  }
}

function onAdminFeeReportTypeChange(){
  const type = document.getElementById('repFeeType').value;
  const statusSel = document.getElementById('repFeeStatus');
  // Defaulters always means "unpaid or overdue", so the Status filter is not used there
  if(type === 'defaulters'){ statusSel.value = 'all'; statusSel.disabled = true; }
  else statusSel.disabled = false;
}

function downloadAdminFeeReport(format){
  const batch = document.getElementById('repFeeBatch').value;
  const sem = document.getElementById('repFeeSem').value;
  const div = document.getElementById('repFeeDiv').value;
  const item = document.getElementById('repFeeItem').value;
  const type = document.getElementById('repFeeType').value;
  const status = document.getElementById('repFeeStatus').value;

  if(!batch || !sem){
    alert('Select both Batch and Semester');
    return;
  }

  const params = new URLSearchParams({ academic_year: batch, semester: sem, format, report: type, status });
  if(div) params.set('division', div);
  if(item) params.set('fee_title', item);

  const filename = `fees_${type}_sem${sem}_${batch}${div ? '_div' + div : ''}.${format}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  downloadReportFile(`/admin/reports/fees?${params.toString()}`, filename);
}

// ============================================================
// Database Backup & Restore
// ============================================================
async function loadBackupsList(){
  const body = document.getElementById('backupsListBody');
  const selectEl = document.getElementById('restoreExistingFile');
  try{
    const backups = await apiRequest('/admin/backups');
    if(backups.length === 0){
      body.innerHTML = '<tr><td colspan="4">No backups are available yet</td></tr>';
      selectEl.innerHTML = '<option value="">-- No backup available --</option>';
      return;
    }
    body.innerHTML = backups.map(b => `
      <tr>
        <td style="word-break:break-all;">${escapeHtmlMR(b.filename)}</td>
        <td>${escapeHtmlMR(b.created_at)}</td>
        <td>${escapeHtml(b.size_kb)} KB</td>
        <td style="white-space:nowrap;">
          <button class="btn-ghost" style="padding:4px 8px; font-size:11px;" data-fn="${escapeHtml(b.filename)}" onclick="downloadBackupFile(this.dataset.fn)">Download</button>
          <button class="btn-ghost" style="padding:4px 8px; font-size:11px; color:var(--danger,#d33);" data-fn="${escapeHtml(b.filename)}" onclick="deleteBackupFile(this.dataset.fn)">Delete</button>
        </td>
      </tr>`).join('');
    selectEl.innerHTML = '<option value="">-- Or upload a new file below --</option>' +
      backups.map(b => `<option value="${escapeHtml(b.filename)}">${escapeHtmlMR(b.filename)} (${escapeHtml(b.created_at)})</option>`).join('');
  }catch(err){
    body.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
  }
}

async function createBackup(){
  if(!confirm('Create a new database backup?')) return;
  try{
    const res = await apiRequest('/admin/backup', { method: 'POST' });
    alert(res.message);
    loadBackupsList();
  }catch(err){
    alert('Backup failed: ' + (err.detail || err.message));
  }
}

async function downloadBackupFile(filename){
  await downloadReportFile(`/admin/backups/${encodeURIComponent(filename)}/download`, filename);
}

async function deleteBackupFile(filename){
  if(!confirm(`Delete "${filename}"? This cannot be undone.`)) return;
  try{
    await apiRequest(`/admin/backups/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    loadBackupsList();
  }catch(err){
    alert('Delete failed: ' + err.message);
  }
}

async function restoreBackup(){
  const existingFile = document.getElementById('restoreExistingFile').value;
  const fileInput = document.getElementById('restoreFileInput');
  const confirmText = document.getElementById('restoreConfirmText').value;

  if(confirmText !== 'RESTORE'){
    alert('Type exactly "RESTORE" in the box to confirm');
    return;
  }
  if(!existingFile && (!fileInput.files || fileInput.files.length === 0)){
    alert('Select a backup from the list or upload a new .sql file');
    return;
  }
  if(!confirm('ARE YOU SURE? This will completely overwrite the current database. A safety backup will be created automatically, but this action will take effect immediately.')) return;

  const formData = new FormData();
  formData.append('confirm', 'RESTORE');
  if(existingFile){
    formData.append('existing_filename', existingFile);
  } else {
    formData.append('file', fileInput.files[0]);
  }

  try{
    const res = await fetch(API_BASE + '/admin/restore', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_admin') },
      body: formData
    });
    const data = await res.json();
    if(!res.ok){
      alert((data.message || 'Restore failed') + (data.error ? '\n\nDetail: ' + data.error : ''));
      return;
    }
    alert(data.message);
    toggleForm('restoreForm');
    document.getElementById('restoreConfirmText').value = '';
    fileInput.value = '';
    loadBackupsList();
  }catch(err){
    alert('Restore error: ' + err.message);
  }
}

// Show/Hide toggle for the Password field (Security page — Change Password)
function toggleVis(id, btn){
  const input = document.getElementById(id);
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  btn.textContent = isPwd ? 'Hide' : 'Show';
}