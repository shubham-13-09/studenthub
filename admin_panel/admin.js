if(!localStorage.getItem('token_admin')){
  window.location.href = '../login_panel/login.html';
}

// ---- API helpers ----
const API_BASE = 'http://localhost:5000/api';

// Department short-code -> full name (yaha naya department add karo to wahi list me bhi add karna)
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
    'Authorization': 'Bearer ' + localStorage.getItem('token_admin')
  };
}

async function apiRequest(path, options = {}){
  const res = await fetch(API_BASE + path, { ...options, headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || res.status === 403){
    // token invalid/expired ya admin nahi hai — wapas login bhej do
    localStorage.removeItem('token_admin');
    window.location.href = '../login_panel/login.html';
    throw new Error(data.message || 'Unauthorized');
  }
  if(!res.ok){
    const err = new Error(data.message || 'Request failed');
    err.detail = data.error;   // backend ka detailed error (jaise mysqldump ka stderr) yahan carry hota hai
    throw err;
  }
  return data;
}

// File upload ke liye — yahan Content-Type header manually set NAHI karte,
// browser khud multipart boundary ke saath set karta hai (FormData body)
async function apiUpload(path, formData){
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_admin') },
    body: formData
  });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || res.status === 403){
    localStorage.removeItem('token_admin');
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
  document.getElementById('studentStatus').value = 'active';
  document.getElementById('studentFatherName').value = '';
  document.getElementById('studentFatherMobile').value = '';
  document.getElementById('studentMotherName').value = '';
  document.getElementById('studentMotherMobile').value = '';
  document.getElementById('studentParentEmail').value = '';
  document.getElementById('studentParentAddress').value = '';
}

async function loadStudents(){
  const tbody = document.getElementById('studentsTableBody');
  tbody.innerHTML = '<tr><td colspan="9">Loading…</td></tr>';

  const dept = document.getElementById('studentFilterDept').value;
  const sem = document.getElementById('studentFilterSem').value;
  const year = document.getElementById('studentFilterYear').value;
  const params = new URLSearchParams();
  if(dept) params.set('department', dept);
  if(sem) params.set('semester', sem);
  if(year) params.set('academic_year', year);

  try{
    const students = await apiRequest('/admin/students?' + params.toString());
    if(!students.length){
      tbody.innerHTML = '<tr><td colspan="9">No students found.</td></tr>';
      return;
    }
    tbody.innerHTML = students.map(s => `
      <tr style="cursor:pointer" onclick='showStudentDetails(${JSON.stringify(s)})'>
        <td>${s.enrollment}</td>
        <td>${s.name}</td>
        <td>${s.semester || '-'}</td>
        <td>${s.division || '-'}</td>
        <td>${s.academic_year || '-'}</td>
        <td>${deptName(s.department)}</td>
        <td>${yearOfStudy(s.semester)}</td>
        <td><span class="pill ${s.status === 'active' ? 'good' : 'warn'}" style="cursor:pointer"
              onclick="event.stopPropagation(); toggleStudentStatus(${s.id}, '${s.status}')">${s.status === 'active' ? 'Active' : 'Inactive'}</span></td>
        <td class="row-actions">
          <button class="icon-action" onclick='event.stopPropagation(); editStudent(${JSON.stringify(s)})'>✎</button>
          <button class="icon-action danger" onclick="event.stopPropagation(); deleteStudent(${s.id}, '${s.name}')">🗑</button>
        </td>
      </tr>
    `).join('');
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="9">Failed to load students: ${err.message}</td></tr>`;
  }
}

async function saveStudent(){
  const editId = document.getElementById('studentEditId').value;
  const payload = {
    name: document.getElementById('studentName').value.trim(),
    enrollment: document.getElementById('studentEnrollment').value.trim(),
    email: document.getElementById('studentEmail').value.trim(),
    mobile: document.getElementById('studentMobile').value.trim(),
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
  if(!payload.father_name || !payload.father_mobile){
    alert("Father's name and mobile number are required");
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
  document.getElementById('studentEnrollment').disabled = true;   // enrollment login_id hai, edit nahi hota
  document.getElementById('studentEmail').value = student.email || '';
  document.getElementById('studentMobile').value = student.mobile || '';
  // Abhi sirf ek hi department (Computer Engineering) supported hai, isliye
  // hamesha usi ko select karo — agar naye departments future me add karo
  // to yahan proper matching logic wapas lagana.
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
  document.getElementById('studentForm').classList.remove('hidden');
}

// ---- Student Details modal (parent details view) ----
function showStudentDetails(student){
  document.getElementById('studentDetailName').textContent = `${student.name} (${student.enrollment})`;
  document.getElementById('studentDetailEnrollment').textContent = student.enrollment;
  document.getElementById('studentDetailStatus').textContent = student.status === 'active' ? 'Active' : 'Inactive';
  document.getElementById('studentDetailEmail').textContent = student.email || '-';
  document.getElementById('studentDetailMobile').textContent = student.mobile || '-';
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

// Recent activity ke liye actual date + time (e.g. "23 Aug 2026, 6:45 PM")
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
  }catch(err){
    console.error('Dashboard stats error:', err.message);
  }
}

// Dashboard par "Students by semester" bar chart (Sem 1-6, jis sem me student nahi wahan 0)
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

// ---- System Assistant (dashboard card) — backend /admin/assistant se real data ----
async function adminAsk(text){
  const box = document.getElementById('adminAskaiReply');
  if(!box) return;
  box.classList.remove('hidden');
  box.textContent = 'Thinking…';
  try{
    const data = await apiRequest('/admin/assistant', { method: 'POST', body: JSON.stringify({ message: text }) });
    box.innerHTML = nfEsc(data.reply || '...').replace(/\n/g, '<br>');
  }catch(err){
    box.textContent = 'Response could not be loaded, try again.';
  }
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

// Dashboard par pending marks requests ki chhoti preview list (Marks Requests screen jaisa hi data, top 5)
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
        <span>Sem ${r.semester} / ${r.division || 'All'} · ${r.student_count} students · ${formatDateTime(r.submitted_at)}</span>
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
      if(r.type === 'student_registered') label = `New student registered — ${r.title}`;
      else if(r.type === 'faculty_added') label = `New faculty account created — ${r.title}`;
      else label = `Notice posted — ${r.title}`;
      const isLast = i === rows.length - 1;
      return `<div class="notice-row"${isLast ? ' style="border-bottom:none;"' : ''}><b>${label}</b><span>${r.detail || ''} · ${formatDateTime(r.created_at)}</span></div>`;
    }).join('');
  }catch(err){
    container.innerHTML = '<div class="notice-row" style="border-bottom:none;"><b>Failed to load</b></div>';
  }
}

function loadDashboard(){
  loadDashboardStats();
  loadRecentActivity();
  loadDashboardPendingMarks();
}

// Student Management view khulte hi list load karo
document.addEventListener('DOMContentLoaded', () => {
  applyStoredDarkMode();
  applyProfileNameToUI();
  refreshNotifBadge();
  setInterval(refreshNotifBadge, 60000);   // har 1 min me naye notification check karo
  loadDashboard();
  loadStudents();
  loadSubjects();     // subjects pehle load karo taaki faculty ka dropdown bhi bhar jaye
  loadFaculty();
  loadTimetable();
  loadExamTimetables();

  if(document.getElementById('attDate')){
    document.getElementById('attDate').value = new Date().toISOString().split('T')[0];   // default: aaj ki date
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
});

// ============================================================
// SUBJECT MANAGEMENT
// ============================================================
let cachedSubjects = [];
let currentFacultySelectedSubjectIds = [];   // checkboxes jo abhi form me checked hain (semester badalne par bhi yaad rakhne ke liye nahi — sirf render ke liye)

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
  document.getElementById('subjectSem').value = '1';
  document.getElementById('subjectBatch').value = '2024-25';
}

async function loadSubjects(){
  const tbody = document.getElementById('subjectsTableBody');
  if(tbody) tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';

  const filterYearEl = document.getElementById('subjectFilterYear');
  const params = new URLSearchParams();
  if(filterYearEl && filterYearEl.value) params.set('academic_year', filterYearEl.value);

  try{
    const subjects = await apiRequest('/admin/subjects?' + params.toString());
    cachedSubjects = subjects;

    if(tbody){
      tbody.innerHTML = subjects.length ? subjects.map(s => `
        <tr>
          <td>${s.subject_code}</td>
          <td>${s.subject_name}</td>
          <td>${deptName(s.department)}</td>
          <td>${s.semester || '-'}</td>
          <td>${s.academic_year || '-'}</td>
          <td class="row-actions">
            <button class="icon-action" onclick='editSubject(${JSON.stringify(s)})'>✎</button>
            <button class="icon-action danger" onclick="deleteSubject(${s.id}, '${s.subject_name}')">🗑</button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="6">No subjects found.</td></tr>';
    }

    // Faculty form ka semester already selected ho to uske subjects checkbox refresh kar do
    if(document.getElementById('facultySubjectsContainer')){
      renderFacultySubjectCheckboxes(document.getElementById('facultySemester').value, currentFacultySelectedSubjectIds);
    }

    // Attendance ka subject dropdown bhi refresh kar do (semester-wise filtered)
    if(document.getElementById('attSubject')){
      populateAttendanceSubjects(document.getElementById('attSemester').value);
    }

    // Notes ke dono dropdowns (upload form + filter) bhi refresh kar do
    if(document.getElementById('noteSubject')){
      populateNoteSubjects(document.getElementById('noteSemester').value);
    }
    if(document.getElementById('noteFilterSubject')){
      populateNoteFilterSubjects(document.getElementById('noteFilterSemester').value);
    }

    // Assignment ke dono dropdowns (upload form + filter) bhi refresh kar do
    if(document.getElementById('assignSubject')){
      populateAssignmentSubjects(document.getElementById('assignSemester').value);
    }
    if(document.getElementById('assignFilterSubject')){
      populateAssignmentFilterSubjects(document.getElementById('assignFilterSemester').value);
    }

    // Marks ka Subject dropdown bhi refresh kar do
    if(document.getElementById('marksSubject')){
      populateMarksSubjects(document.getElementById('marksSemester').value);
    }
  }catch(err){
    if(tbody) tbody.innerHTML = `<tr><td colspan="6">Failed to load subjects: ${err.message}</td></tr>`;
  }
}

async function saveSubject(){
  const editId = document.getElementById('subjectEditId').value;
  const payload = {
    subject_name: document.getElementById('subjectName').value.trim(),
    subject_code: document.getElementById('subjectCode').value.trim(),
    department: document.getElementById('subjectDept').value,
    semester: document.getElementById('subjectSem').value,
    academic_year: document.getElementById('subjectBatch').value,
    credits: 0
  };

  if(!payload.subject_name || !payload.subject_code){
    alert('Subject name and code are required');
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
  document.getElementById('subjectCode').disabled = true;   // code unique key hai, edit nahi hota
  document.getElementById('subjectDept').value = subject.department || 'Computer Engineering';
  document.getElementById('subjectSem').value = subject.semester || '1';
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
  document.getElementById('facultySemester').value = '1';
  document.getElementById('facultyDivision').value = '';
  document.getElementById('facultyBatch').value = '2024-25';
  currentFacultySelectedSubjectIds = [];
  renderFacultySubjectCheckboxes('1', []);
}

// Semester selected subjects ke checkboxes bharta hai — sirf usi semester ke subjects dikhte hain
function renderFacultySubjectCheckboxes(semester, selectedIds){
  const container = document.getElementById('facultySubjectsContainer');
  if(!container) return;
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem);

  if(!subjectsForSem.length){
    container.innerHTML = '<span class="muted">No subject was found for this semester.</span>';
    return;
  }

  container.innerHTML = subjectsForSem.map(s => `
    <label class="checkbox-item">
      <input type="checkbox" value="${s.id}" ${selectedIds.includes(s.id) ? 'checked' : ''}>
      ${s.subject_name} (${s.subject_code})
    </label>
  `).join('');
}

// Semester dropdown change hote hi us semester ke subjects dikhao.
// Edit mode me ho to is faculty ke us semester me pehle se assigned subjects backend se le kar pre-check karo.
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

// "Subjects assigned" column ko horizontal pills me render karta hai, code ke saath
function renderSubjectPills(subjectsAssignedStr){
  if(!subjectsAssignedStr) return '-';
  return `<div class="subject-pills">` + subjectsAssignedStr.split('||').map(entry => {
    const [code, name, sem, division] = entry.split('::');
    const divLabel = division && division !== 'All' ? ` · Division ${division}` : '';
    return `<span class="subject-pill">${name} <b>(${code})</b> · Sem ${sem}${divLabel}</span>`;
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
    tbody.innerHTML = faculty.map(f => `
      <tr>
        <td>${f.faculty_id}</td>
        <td>${f.name}</td>
        <td>${f.short_name || '-'}</td>
        <td>${deptName(f.department)}</td>
        <td class="subjects-col">${renderSubjectPills(f.subjects_assigned)}</td>
        <td class="row-actions">
          <button class="icon-action" onclick='editFaculty(${JSON.stringify(f)})'>✎</button>
          <button class="icon-action danger" onclick="deleteFaculty(${f.id}, '${f.name}')">🗑</button>
        </td>
      </tr>
    `).join('');
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="6">Failed to load faculty: ${err.message}</td></tr>`;
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
    department: document.getElementById('facultyDept').value,
    subject_ids: checkedSubjectIds,          // ek se zyada subjects ek saath
    semester: document.getElementById('facultySemester').value,
    division: document.getElementById('facultyDivision').value,
    academic_year: document.getElementById('facultyBatch').value
  };

  if(!payload.name || !payload.faculty_id){
    alert('Full name and Faculty ID are required');
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
  document.getElementById('facultyLoginId').disabled = true;   // login_id hai, edit nahi hota
  document.getElementById('facultyEmail').value = faculty.email || '';
  document.getElementById('facultyDept').value = faculty.department || 'Computer Engineering';

  // Faculty ka default semester + batch + division wahi rakho jo pehle se assign hai (nahi to semester 1 / 2024-25 / All se start karo)
  const defaultSem = faculty.default_semester || '1';
  document.getElementById('facultySemester').value = defaultSem;
  document.getElementById('facultyBatch').value = faculty.default_academic_year || '2024-25';
  document.getElementById('facultyDivision').value = faculty.default_division || '';

  document.getElementById('facultyForm').classList.remove('hidden');
  await onFacultySemesterChange();   // is semester ke already-assigned subjects checkbox me pre-check ho jayenge
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


// ============================================================
// TIMETABLE MANAGEMENT
// ============================================================
let cachedTimetable = [];
const DAY_LABELS = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday' };
const DAY_ORDER = ['Mon','Tue','Wed','Thu','Fri','Sat'];
const LUNCH_BREAK_START = '13:30';
const LUNCH_BREAK_END = '14:00';
const LUNCH_BREAK_RANGE = `${LUNCH_BREAK_START}-${LUNCH_BREAK_END}`;

// FIXED PERIODS — admin ab custom/free-text time range nahi bana sakta, sirf in me se ek period choose karega.
// Isse har din ke slots hamesha same boundaries follow karenge, grid me overlapping/mismatched time range kabhi nahi banega.
// Naya period add/change karna ho to bas yahi list edit karo — form aur validation dono automatically isi se chalte hain.
const TIMETABLE_PERIODS = [
  { start: '10:30', end: '11:30' },
  { start: '11:30', end: '12:30' },
  { start: '12:30', end: '13:30' },
  { start: '14:00', end: '15:00' },
  { start: '15:00', end: '16:00' },
  { start: '16:00', end: '17:00' },
  { start: '17:00', end: '18:00' }
];

function periodRangeValue(p){ return `${p.start}-${p.end}`; }
function periodLabel(p){ return `${formatTime12(p.start)} - ${formatTime12(p.end)}`; }

// Period dropdown ko TIMETABLE_PERIODS se bharta hai. Agar selectedRange list me exact match nahi karta
// (purana/legacy data jo fixed-period system se pehle bana tha), to ek extra "Existing" option daal deta hai
// taaki admin ko silently kisi aur period par switch na ho jaaye — usse dikh jaaye aur woh khud sahi period chun sake.
function populateTimetablePeriodOptions(selectedRange){
  const select = document.getElementById('ttPeriod');
  let optionsHtml = TIMETABLE_PERIODS.map(p => {
    const range = periodRangeValue(p);
    return `<option value="${range}" ${range === selectedRange ? 'selected' : ''}>${periodLabel(p)}</option>`;
  }).join('');

  const isKnownRange = TIMETABLE_PERIODS.some(p => periodRangeValue(p) === selectedRange);
  if(selectedRange && !isKnownRange){
    optionsHtml += `<option value="${selectedRange}" selected>${formatRangeLabel(selectedRange)} (existing — please re-select a period)</option>`;
  }

  select.innerHTML = optionsHtml;
}

// 12-hour dropdown (hour/minute/AM-PM) ko backend ke liye 24-hour "HH:MM" string me convert karta hai
function to24Hour(hour12, minute, period){
  let h = parseInt(hour12, 10);
  if(period === 'AM'){ if(h === 12) h = 0; }
  else { if(h !== 12) h += 12; }
  return String(h).padStart(2, '0') + ':' + minute;
}

// Backend ka 24-hour "HH:MM" string 12-hour dropdown values (hour/minute/period) me todhta hai — edit form pre-fill ke liye
function to12Hour(time24){
  if(!time24) return { hour: '09', minute: '00', period: 'AM' };
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  let hour12 = h % 12;
  if(hour12 === 0) hour12 = 12;
  return { hour: String(hour12).padStart(2, '0'), minute: String(m).padStart(2, '0'), period };
}

// Table/grid me dikhane ke liye 24-hour "HH:MM" ko "9:00 AM" jaisa banata hai
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
  document.getElementById('ttSemester').value = '1';
  document.getElementById('ttBatch').value = '2024-25';
  document.querySelectorAll('#ttDivisionsContainer input').forEach((cb, i) => cb.checked = (i === 0));  // default: sirf A checked
  document.getElementById('ttDay').value = 'Mon';
  populateTimetablePeriodOptions(periodRangeValue(TIMETABLE_PERIODS[0]));
  document.getElementById('ttRoom').value = '';
  populateTimetableSubjects('1', '');
  populateTimetableFacultyOptions([]);
}

// Semester ke hisaab se sirf usi semester ke subjects dropdown me dikhao
function populateTimetableSubjects(semester, selectedSubjectId){
  const sem = parseInt(semester);
  const select = document.getElementById('ttSubject');
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem);
  select.innerHTML = subjectsForSem.length
    ? subjectsForSem.map(s => `<option value="${s.id}" ${String(s.id)===String(selectedSubjectId)?'selected':''}>${s.subject_name} (${s.subject_code})</option>`).join('')
    : '<option value="">There are no subjects for this semester</option>';
}

function populateTimetableFacultyOptions(facultyList, selectedFacultyId){
  const select = document.getElementById('ttFaculty');
  select.innerHTML = facultyList.length
    ? facultyList.map(f => `<option value="${f.faculty_id}" ${String(f.faculty_id)===String(selectedFacultyId)?'selected':''}>${f.name}</option>`).join('')
    : '<option value="">Assign this subject to a faculty member first</option>';
}

function onTimetableSemesterChange(){
  populateTimetableSubjects(document.getElementById('ttSemester').value, '');
  populateTimetableFacultyOptions([]);
}

// Subject select hote hi sirf wahi faculty dikhao jo woh subject us semester me padhate hain
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
    tbody.innerHTML = `<tr><td colspan="9">Failed to load timetable: ${err.message}</td></tr>`;
  }
}

// "All timetable slots" list ko batch filter ke hisaab se client-side filter karke render karta hai
// (dobara fetch nahi karta, cachedTimetable already poora data rakhta hai — grid isi pattern ko follow karta hai)
function renderTimetableList(){
  const tbody = document.getElementById('timetableTableBody');
  const filterYearEl = document.getElementById('ttListFilterYear');
  const filterYear = filterYearEl ? filterYearEl.value : '';

  const rows = filterYear ? cachedTimetable.filter(t => t.academic_year === filterYear) : cachedTimetable;

  tbody.innerHTML = rows.length ? rows.map(t => `
    <tr>
      <td>${t.semester}</td>
      <td>${(t.division || '').split(',').join(', ')}</td>
      <td>${t.academic_year || '-'}</td>
      <td>${DAY_LABELS[t.day_of_week] || t.day_of_week}</td>
      <td>${formatTime12(t.start_time)} - ${formatTime12(t.end_time)}</td>
      <td>${t.subject_name || '-'} ${t.subject_code ? '('+t.subject_code+')' : ''}</td>
      <td>${t.faculty_name || '-'}</td>
      <td>${t.room_no || '-'}</td>
      <td class="row-actions">
        <button class="icon-action" onclick='editTimetableSlot(${JSON.stringify(t)})'>✎</button>
        <button class="icon-action danger" onclick="deleteTimetableSlot(${t.id})">🗑</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="9">No timetable slot was found.</td></tr>';
}

async function saveTimetableSlot(){
  const editId = document.getElementById('ttEditId').value;
  const divisions = Array.from(document.querySelectorAll('#ttDivisionsContainer input:checked')).map(cb => cb.value);

  const periodValue = document.getElementById('ttPeriod').value;
  const [startTime, endTime] = periodValue.split('-');

  const payload = {
    semester: document.getElementById('ttSemester').value,
    divisions: divisions,
    subject_id: document.getElementById('ttSubject').value,
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
    alert('Error: ' + err.message);   // clash hone par backend ka wahi message dikhega
  }
}

async function editTimetableSlot(slot){
  document.getElementById('ttEditId').value = slot.id;
  document.getElementById('ttSemester').value = slot.semester;
  document.getElementById('ttBatch').value = slot.academic_year || '2024-25';

  const selectedDivisions = (slot.division || '').split(',');
  document.querySelectorAll('#ttDivisionsContainer input').forEach(cb => {
    cb.checked = selectedDivisions.includes(cb.value);
  });

  document.getElementById('ttDay').value = slot.day_of_week;

  populateTimetablePeriodOptions(`${slot.start_time}-${slot.end_time}`);

  document.getElementById('ttRoom').value = slot.room_no || '';

  populateTimetableSubjects(slot.semester, slot.subject_id);
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

// ---- Exam Timetable (Mid-Sem / Remedial — structured, regular timetable ki tarah) ----
let cachedExamTimetable = [];

function populateExamTtSubjects(semester){
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem);
  const select = document.getElementById('examTtSubject');
  if(!select) return;
  select.innerHTML = subjectsForSem.map(s => `<option value="${s.id}">${s.subject_name} (${s.subject_code})</option>`).join('')
    || '<option value="">There are no subjects for this semester</option>';
}

function resetExamTtForm(){
  document.getElementById('examTtEditId').value = '';
  document.getElementById('examTtType').value = 'Mid-Sem';
  document.getElementById('examTtSemester').value = '1';
  populateExamTtSubjects('1');
  document.getElementById('examTtDivision').value = '';
  document.getElementById('examTtBatch').value = '2024-25';
  document.getElementById('examTtDate').value = '';
  document.getElementById('examTtStartHour').value = '09';
  document.getElementById('examTtStartMin').value = '00';
  document.getElementById('examTtStartPeriod').value = 'AM';
  document.getElementById('examTtEndHour').value = '11';
  document.getElementById('examTtEndMin').value = '00';
  document.getElementById('examTtEndPeriod').value = 'AM';
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
    tbody.innerHTML = `<tr><td colspan="9">Failed to load: ${err.message}</td></tr>`;
  }
}

function renderExamTimetableList(){
  const tbody = document.getElementById('examTtTableBody');
  tbody.innerHTML = cachedExamTimetable.length ? cachedExamTimetable.map(r => `
    <tr>
      <td>${r.exam_type}</td>
      <td>${r.exam_date}</td>
      <td>${r.start_time} - ${r.end_time}</td>
      <td>${r.semester}</td>
      <td>${r.division || 'All'}</td>
      <td>${r.academic_year || '-'}</td>
      <td>${r.subject_name ? `${r.subject_name} (${r.subject_code})` : '-'}</td>
      <td>${r.room_no || '-'}</td>
      <td class="row-actions">
        <button class="icon-action" onclick='editExamTimetableSlot(${JSON.stringify(r)})'>✎</button>
        <button class="icon-action danger" onclick="deleteExamTimetableSlot(${r.id})">🗑</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="9">There is no exam timetable slot.</td></tr>';
}

function editExamTimetableSlot(slot){
  document.getElementById('examTtEditId').value = slot.id;
  document.getElementById('examTtType').value = slot.exam_type;
  document.getElementById('examTtSemester').value = slot.semester;
  populateExamTtSubjects(slot.semester);
  document.getElementById('examTtSubject').value = slot.subject_id || '';
  document.getElementById('examTtDivision').value = slot.division || '';
  document.getElementById('examTtBatch').value = slot.academic_year || '2024-25';
  document.getElementById('examTtDate').value = slot.exam_date;
  document.getElementById('examTtRoom').value = slot.room_no || '';

  const [startH24, startM] = slot.start_time.split(':');
  const [endH24, endM] = slot.end_time.split(':');
  const startH = parseInt(startH24), endH = parseInt(endH24);
  document.getElementById('examTtStartHour').value = String(startH % 12 || 12).padStart(2, '0');
  document.getElementById('examTtStartMin').value = startM;
  document.getElementById('examTtStartPeriod').value = startH >= 12 ? 'PM' : 'AM';
  document.getElementById('examTtEndHour').value = String(endH % 12 || 12).padStart(2, '0');
  document.getElementById('examTtEndMin').value = endM;
  document.getElementById('examTtEndPeriod').value = endH >= 12 ? 'PM' : 'AM';

  document.getElementById('examTtForm').classList.remove('hidden');
}

async function saveExamTimetableSlot(){
  const editId = document.getElementById('examTtEditId').value;
  const startTime = to24Hour(
    document.getElementById('examTtStartHour').value,
    document.getElementById('examTtStartMin').value,
    document.getElementById('examTtStartPeriod').value
  );
  const endTime = to24Hour(
    document.getElementById('examTtEndHour').value,
    document.getElementById('examTtEndMin').value,
    document.getElementById('examTtEndPeriod').value
  );

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
  if(endTime <= startTime){
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

// Semester + Division-filter ke hisaab se grid banata hai.
// "ALL" divisions selected ho to uploaded photo jaisa merged grid banta hai (Day ke andar A/B/C sub-columns,
// combined lecture ho to ek cell dono divisions ke upar span ho jata hai).
// Ek specific division select ho to seedha simple Day-wise grid banta hai.
function renderTimetableGrid(){
  const table = document.getElementById('ttGridTable');
  const gridType = document.getElementById('gridType').value;
  const semester = document.getElementById('gridSemester').value;
  const divisionFilter = document.getElementById('gridDivision').value;

  if(gridType !== 'Regular'){
    renderExamGrid(table, gridType, semester, divisionFilter);
    return;
  }

  const slotsInSem = cachedTimetable.filter(t => String(t.semester) === String(semester));

  if(divisionFilter === 'ALL'){
    document.getElementById('ttGridTitle').textContent = `Sem ${semester} · All divisions`;
    renderCombinedDivisionGrid(table, slotsInSem);
  } else {
    document.getElementById('ttGridTitle').textContent = `Sem ${semester} · Division ${divisionFilter}`;
    const slots = slotsInSem.filter(t => (t.division || '').split(',').includes(divisionFilter));
    renderSingleDivisionGrid(table, slots);
  }
}

// Mid-Sem / Remedial exams din-wise repeat nahi hote — date-wise ek baar hote hain,
// isliye inke liye weekly grid ki jagah simple date-sorted list dikhate hain.
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
        <td>${s.exam_date}</td>
        <td>${s.start_time} - ${s.end_time}</td>
        <td>${s.division || 'All'}</td>
        <td>${s.subject_name ? `${s.subject_name} (${s.subject_code})` : '-'}</td>
        <td>${s.room_no || '-'}</td>
      </tr>
    `).join('')}
  `;
}

function renderSingleDivisionGrid(table, slots){
  if(!slots.length){
    table.innerHTML = '<tr><td class="tt-empty-msg">No timetable slot has been created for this semester/division yet.</td></tr>';
    return;
  }
  const timeSlots = [...new Set(slots.map(s => `${s.start_time}-${s.end_time}`))];
  if(!timeSlots.includes(LUNCH_BREAK_RANGE)) timeSlots.push(LUNCH_BREAK_RANGE);   // lunch break hamesha grid me dikhega
  timeSlots.sort();

  let html = '<tr><th class="tt-time-col">Time</th>' + DAY_ORDER.map(d => `<th>${DAY_LABELS[d]}</th>`).join('') + '</tr>';
  timeSlots.forEach(range => {
    html += `<tr><td class="tt-time-col">${formatRangeLabel(range)}</td>`;
    if(range === LUNCH_BREAK_RANGE){
      html += `<td class="tt-break-cell" colspan="${DAY_ORDER.length}">Lunch Break</td>`;
    } else {
      DAY_ORDER.forEach(day => {
        const match = slots.find(s => `${s.start_time}-${s.end_time}` === range && s.day_of_week === day);
        html += match ? `<td class="tt-cell">${cellContent(match)}</td>` : `<td class="tt-cell-empty">—</td>`;
      });
    }
    html += '</tr>';
  });
  table.innerHTML = html;
}

// Photo-style grid: har Day ke andar A/B/C sub-columns, combined lecture ek merged cell (colspan) me dikhta hai
function renderCombinedDivisionGrid(table, slots){
  if(!slots.length){
    table.innerHTML = '<tr><td class="tt-empty-msg">No timetable slot has been created for this semester yet.</td></tr>';
    return;
  }

  // Is semester me actually jitne divisions use ho rahe hain, sirf wahi columns dikhao (A,B,C me se)
  const usedDivisions = new Set();
  slots.forEach(s => (s.division || '').split(',').forEach(d => d && usedDivisions.add(d)));
  const divisionCols = ['A', 'B', 'C'].filter(d => usedDivisions.has(d));
  if(!divisionCols.length) divisionCols.push('A', 'B');

  const timeSlots = [...new Set(slots.map(s => `${s.start_time}-${s.end_time}`))];
  if(!timeSlots.includes(LUNCH_BREAK_RANGE)) timeSlots.push(LUNCH_BREAK_RANGE);   // lunch break hamesha grid me dikhega
  timeSlots.sort();

  // Header row 1: Time | Monday (colspan=divisionCols.length) | Tuesday ... 
  let html = '<tr><th class="tt-time-col" rowspan="2">Time</th>' +
    DAY_ORDER.map(d => `<th colspan="${divisionCols.length}">${DAY_LABELS[d]}</th>`).join('') + '</tr>';
  // Header row 2: A | B | C  (repeated for har day)
  html += '<tr>' + DAY_ORDER.map(() => divisionCols.map(d => `<th class="tt-div-subhead">${d}</th>`).join('')).join('') + '</tr>';

  timeSlots.forEach(range => {
    html += `<tr><td class="tt-time-col">${formatRangeLabel(range)}</td>`;

    if(range === LUNCH_BREAK_RANGE){
      html += `<td class="tt-break-cell" colspan="${DAY_ORDER.length * divisionCols.length}">Lunch Break</td>`;
      html += '</tr>';
      return;
    }

    DAY_ORDER.forEach(day => {
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

        // Ye slot kitne consecutive division-columns cover karta hai, wahi colspan me merge karo
        const matchDivisions = (match.division || '').split(',');
        let span = 0;
        while(i + span < divisionCols.length && matchDivisions.includes(divisionCols[i + span])){
          span++;
        }
        const cellClass = span > 1 ? 'tt-cell tt-cell-combined' : 'tt-cell';
        html += `<td class="${cellClass}" colspan="${span}">${cellContent(match)}</td>`;
        i += span;
      }
    });
    html += '</tr>';
  });

  table.innerHTML = html;
}

function cellContent(slot){
  return `<div class="tt-subject">${slot.subject_name || ''}</div>` +
    `<div class="tt-meta">${slot.faculty_name || ''}${slot.room_no ? ' · ' + slot.room_no : ''}</div>`;
}


// ============================================================
// ATTENDANCE MANAGEMENT
// ============================================================
let cachedAttendanceStudents = [];   // marking-view state: [{student_id, enrollment, name, status}]

// Semester ke hisaab se sirf usi semester ke subjects dropdown me dikhao, "All subjects" bhi top pe
function populateAttendanceSubjects(semester){
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem);
  const select = document.getElementById('attSubject');
  const current = select.value;
  select.innerHTML = '<option value="ALL">All subjects (summary only)</option>' +
    subjectsForSem.map(s => `<option value="${s.id}">${s.subject_name} (${s.subject_code})</option>`).join('');
  if(current && [...select.options].some(o => o.value === current)) select.value = current;
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
      `/admin/attendance?semester=${semester}&divisions=${divisions.join(',')}&academic_year=${academicYear}&subject_id=${subjectId}&date=${date}`
    );
    renderAttendanceRows();
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="6">Failed to load: ${err.message}</td></tr>`;
  }
}

// Search box ke hisaab se list filter karke dikhata hai (data reload nahi karta, sirf render)
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
        <td>${s.enrollment}</td>
        <td>${s.name}</td>
        <td>${s.semester ?? '-'}</td>
        <td>${s.division}</td>
        <td>${s.academic_year || '-'}</td>
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

// Present/Absent button seedha status set karta hai (toggle nahi) — purani attendance edit karna aasan
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
      body: JSON.stringify({ subject_id: subjectId, date, records })
    });
    alert('Attendance saved');
    loadAttendanceSummary();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// Har student ka overall attendance % — 75% se kam ho to row red highlight hogi
async function loadAttendanceSummary(){
  const tbody = document.getElementById('attendanceSummaryBody');
  const semester = document.getElementById('attSemester').value;
  const divisions = getSelectedAttendanceDivisions();
  const academicYear = document.getElementById('attBatch').value;
  const subjectId = document.getElementById('attSubject').value || 'ALL';

  if(!divisions.length){
    tbody.innerHTML = '<tr><td colspan="9">Select at least one division.</td></tr>';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="9">Loading…</td></tr>';
  try{
    const summary = await apiRequest(
      `/admin/attendance/summary?semester=${semester}&divisions=${divisions.join(',')}&academic_year=${academicYear}&subject_id=${subjectId}`
    );

    tbody.innerHTML = summary.length ? summary.map(s => {
      const total = s.total_classes || 0;
      const present = s.present_classes || 0;
      const pct = total > 0 ? Math.round((present / total) * 100) : null;
      const isLow = pct !== null && pct < 75;
      const calendarCell = subjectId !== 'ALL'
        ? `<button class="icon-action" onclick="openAttendanceCalendar(${s.student_id}, '${s.name.replace(/'/g, "\\'")}')" title="Calendar dekho">📅</button>`
        : `<span style="color:var(--muted); font-size:12px;" title="Select a specific subject to view the calendar">—</span>`;
      return `
        <tr class="${isLow ? 'tt-low-attendance' : ''}">
          <td>${s.enrollment}</td>
          <td>${s.name}</td>
          <td>${s.semester ?? '-'}</td>
          <td>${s.division}</td>
          <td>${s.academic_year || '-'}</td>
          <td>${total}</td>
          <td>${present}</td>
          <td>${pct !== null ? pct + '%' : '—'}</td>
          <td>${calendarCell}</td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="9">No student was found.</td></tr>';
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="9">Failed to load summary: ${err.message}</td></tr>`;
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

function closeAttendanceCalendar(){
  document.getElementById('attCalendarOverlay').classList.remove('open');
}

function changeAttendanceCalendarMonth(delta){
  attCalendarState.month += delta;
  if(attCalendarState.month > 12){ attCalendarState.month = 1; attCalendarState.year++; }
  if(attCalendarState.month < 1){ attCalendarState.month = 12; attCalendarState.year--; }
  loadAttendanceCalendar();
}

async function loadAttendanceCalendar(){
  const grid = document.getElementById('attCalendarGrid');
  const { studentId, year, month } = attCalendarState;
  const subjectId = document.getElementById('attSubject').value || 'ALL';

  document.getElementById('attCalendarMonthLabel').textContent = `${MONTH_NAMES[month - 1]} ${year}`;
  grid.innerHTML = 'Loading…';

  try{
    const records = await apiRequest(`/admin/attendance/calendar?student_id=${studentId}&subject_id=${subjectId}&year=${year}&month=${month}`);
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
    grid.innerHTML = `Failed to load: ${err.message}`;
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
          <td>${s.enrollment}</td>
          <td>${s.name}</td>
          <td>${s.semester}</td>
          <td>${s.division || '-'}</td>
          <td>${s.academic_year || '-'}</td>
        </tr>
      `).join('');
    }
    listCard.style.display = 'block';

    // Naye semester ka term (odd/even) agar already kisi date range me set hai
    // (aaj ki date ke hisaab se), to promote form me wahi pre-fill kar do —
    // taaki admin galti se overwrite na kar de.
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

  // Sem 6 wale sirf graduate hote hain — unke liye naye term ki date nahi chahiye
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
    loadStudents();   // view student list ko turant refresh karo, taaki naya semester turant dikhe
  }catch(err){
    alert('Error promoting students: ' + err.message);
  }
}

// ---- View switching ----
function switchView(name){
  document.querySelectorAll('.nav-item').forEach(i=> i.classList.toggle('active', i.dataset.view===name));
  document.querySelectorAll('.nav-sub-item').forEach(i=> i.classList.toggle('active', i.dataset.view===name));
  document.querySelectorAll('.view').forEach(v=> v.classList.toggle('active', v.id==='view-'+name));
  if(name === 'notices') markAdminNoticesRead();
}

// Notices tab khulte hi admin ka 'seen' record ho jaata hai, phir list refresh taaki 👁 count update ho
async function markAdminNoticesRead(){
  try{
    await apiRequest('/admin/notices/mark-read', { method: 'POST' });
    loadNotices();
    // Notice dekh li -> header ke 🔔 notification badge ko bhi turant sync karo,
    // warna wahan purana unseen count dikhta rehta hai
    localStorage.setItem('notifSeenAt', toLocalDbDateTime(new Date()));
    refreshNotifBadge();
  }catch(err){
    // silent fail
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
    if(window.innerWidth <= 860) closeSidebar();

    // If this sub-item is an "Add" action, open the matching inline form
    if(item.dataset.action === 'add'){
      const formId = item.dataset.view + 'Form';
      const form = document.getElementById(formId);
      if(form) form.classList.remove('hidden');
    }
  });
});

// ---- Inline Add/Edit form toggle ----
function toggleForm(id){
  const form = document.getElementById(id);
  if(form) form.classList.toggle('hidden');
}

// ---- Chatbot pill tabs (FAQ / Knowledge Base / Chat History) ----
function setChatbotTab(btn, tab){
  document.querySelectorAll('.pill-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('chatbotFaq').classList.toggle('hidden', tab !== 'faq');
  document.getElementById('chatbotKb').classList.toggle('hidden', tab !== 'kb');
  document.getElementById('chatbotHistory').classList.toggle('hidden', tab !== 'history');
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
  localStorage.setItem('darkMode', isDark ? 'true' : 'false');   // refresh/navigate ke baad bhi yaad rahe
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

function populateNoteSubjects(semester){
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem);
  const select = document.getElementById('noteSubject');
  if(!select) return;
  select.innerHTML = subjectsForSem.map(s => `<option value="${s.id}">${s.subject_name} (${s.subject_code})</option>`).join('')
    || '<option value="">There are no subjects for this semester</option>';
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
    subjectsForSem.map(s => `<option value="${s.id}">${s.subject_name} (${s.subject_code})</option>`).join('');
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
  document.getElementById('noteSemester').value = '1';
  populateNoteSubjects('1');
  document.getElementById('noteDivision').value = '';
  document.getElementById('noteBatch').value = '2024-25';
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
  populateNoteSubjects(note.semester);
  document.getElementById('noteSubject').value = note.subject_id || '';
  document.getElementById('noteDivision').value = note.division || '';
  document.getElementById('noteBatch').value = note.academic_year || '2024-25';
  document.getElementById('noteDescription').value = note.description || '';
  document.getElementById('notesFormTitle').textContent = 'Edit note details';
  document.getElementById('noteFileField').style.display = 'none';   // edit sirf details ka hota hai, file replace nahi
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
        <td>${fileIcon(n.file_type)} ${n.title}</td>
        <td>${n.subject_name || '-'}</td>
        <td>${n.semester}</td>
        <td>${n.division || 'All'}</td>
        <td>${n.academic_year || '-'}</td>
        <td>${n.file_name}</td>
        <td>${formatFileSize(n.file_size)}</td>
        <td>${new Date(n.uploaded_at).toLocaleDateString('en-IN')}</td>
        <td class="row-actions">
          <button class="icon-action" onclick="downloadNote(${n.id}, '${n.file_name.replace(/'/g, "\\'")}')" title="Download">⬇</button>
          <button class="icon-action" onclick='editNote(${JSON.stringify(n)})' title="Edit">✎</button>
          <button class="icon-action danger" onclick="deleteNote(${n.id}, '${n.title.replace(/'/g, "\\'")}')" title="Delete">🗑</button>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="9">No notes were found.</td></tr>';
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="9">Failed to load: ${err.message}</td></tr>`;
  }
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
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_admin') }
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

function populateAssignmentSubjects(semester){
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem);
  const select = document.getElementById('assignSubject');
  if(!select) return;
  select.innerHTML = subjectsForSem.map(s => `<option value="${s.id}">${s.subject_name} (${s.subject_code})</option>`).join('')
    || '<option value="">There are no subjects for this semester</option>';
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
    subjectsForSem.map(s => `<option value="${s.id}">${s.subject_name} (${s.subject_code})</option>`).join('');
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
  document.getElementById('assignSemester').value = '1';
  populateAssignmentSubjects('1');
  document.getElementById('assignDivision').value = '';
  document.getElementById('assignBatch').value = '2024-25';
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
  populateAssignmentSubjects(a.semester);
  document.getElementById('assignSubject').value = a.subject_id || '';
  document.getElementById('assignDivision').value = a.division || '';
  document.getElementById('assignBatch').value = a.academic_year || '2024-25';
  document.getElementById('assignDueDate').value = a.due_date ? a.due_date.split('T')[0] : '';
  document.getElementById('assignDescription').value = a.description || '';
  document.getElementById('assignFormTitle').textContent = 'Edit assignment details';
  document.getElementById('assignFileField').style.display = 'none';   // edit sirf details ka hota hai, attachment replace nahi hoti
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
  due.setHours(0, 0, 0, 0);      // sirf date compare karo, time ka farak ignore karo
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
          <td>${a.title}${a.file_name ? ` <span title="${a.file_name}">📎</span>` : ''}</td>
          <td>${a.subject_name || '-'}</td>
          <td>${a.semester}</td>
          <td>${a.division || 'All'}</td>
          <td>${a.academic_year || '-'}</td>
          <td>${dueLabel}${overdue ? ' ⚠' : ''}</td>
          <td><button class="pill warn" onclick="openAssignmentSubmissions(${a.id}, '${a.title.replace(/'/g, "\\'")}')">${a.submission_count} submitted</button></td>
          <td class="row-actions">
            ${a.file_name ? `<button class="icon-action" onclick="downloadAssignmentFile(${a.id}, '${a.file_name.replace(/'/g, "\\'")}')" title="Download attachment">⬇</button>` : ''}
            <button class="icon-action" onclick='editAssignment(${JSON.stringify(a)})' title="Edit">✎</button>
            <button class="icon-action danger" onclick="deleteAssignment(${a.id}, '${a.title.replace(/'/g, "\\'")}')" title="Delete">🗑</button>
          </td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="8">No assignments were found.</td></tr>';
  }catch(err){
    tbody.innerHTML = `<tr><td colspan="8">Failed to load: ${err.message}</td></tr>`;
  }
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
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_admin') }
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
let editingSubmissionStudentId = null;   // abhi kis student ki row edit mode me hai

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
    tbody.innerHTML = `<tr><td colspan="6">Failed to load: ${err.message}</td></tr>`;
  }
}

// Read-only rows + jo student edit mode me hai uske liye editable row — Student panel me yahi data
// sirf READ-ONLY dikhega (wahan koi edit button nahi hoga), edit sirf Admin/Faculty panel me hi hai.
function renderAssignmentSubmissions(){
  const tbody = document.getElementById('assignSubmissionsBody');

  if(!cachedSubmissions.length){
    tbody.innerHTML = '<tr><td colspan="6">No student was found in this semester/division.</td></tr>';
    return;
  }

  const statusFilter = document.getElementById('submissionFilterStatus').value;
  const search = (document.getElementById('submissionSearch').value || '').trim().toLowerCase();

  const filtered = cachedSubmissions.filter(r => {
    // Jo row abhi edit ho rahi hai wo filter se hide nahi honi chahiye, warna editing beech me tut jayegi
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
          <td>${r.enrollment}</td>
          <td>${r.name}</td>
          <td>
            <select id="editStatus_${r.student_id}" onchange="onEditStatusChange(${r.student_id})" style="padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);">
              <option value="pending" ${status.key==='pending'?'selected':''}>Pending</option>
              <option value="submitted" ${status.key==='submitted'?'selected':''}>Submitted</option>
              <option value="late" ${status.key==='late'?'selected':''}>Late</option>
            </select>
          </td>
          <td><input type="date" id="editDate_${r.student_id}" value="${r.submitted_at || ''}" ${status.key==='pending'?'disabled':''} style="padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);"></td>
          <td><input type="number" min="0" id="editMarks_${r.student_id}" value="${r.marks_obtained ?? ''}" ${status.key==='pending'?'disabled':''} style="width:60px; padding:6px; border:1.5px solid var(--line); border-radius:6px; background:var(--paper); color:var(--ink);"></td>
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
        <td>${r.enrollment}</td>
        <td>${r.name}</td>
        <td><span class="pill ${status.cls}">${status.label}</span></td>
        <td>${submitted ? new Date(r.submitted_at).toLocaleDateString('en-IN') : '-'}</td>
        <td>${submitted ? (r.marks_obtained ?? '-') : '-'}</td>
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

// Status "Pending" par set kare to Date/Marks fields disable ho jayein (unka koi matlab nahi rehta)
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
    loadAssignments();   // list ka "X submitted" badge bhi refresh ho jaye
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// ============================================================
// MARKS MANAGEMENT
// ============================================================
let cachedMarksStudents = [];
const PASS_PERCENT = 40;   // yahan se passing % change kar sakte ho

function populateMarksSubjects(semester){
  const sem = parseInt(semester);
  const subjectsForSem = cachedSubjects.filter(s => parseInt(s.semester) === sem);
  const select = document.getElementById('marksSubject');
  if(!select) return;
  const current = select.value;
  select.innerHTML = subjectsForSem.map(s => `<option value="${s.id}">${s.subject_name} (${s.subject_code})</option>`).join('')
    || '<option value="">There are no subjects for this semester</option>';
  if(current && [...select.options].some(o => o.value === current)) select.value = current;
}

function onMarksFilterChange(){
  populateMarksSubjects(document.getElementById('marksSemester').value);
  loadMarksClass();
}

// Max marks badalne par poori list reload nahi karni — sirf already type kiye hue marks ka Pass/Fail
// naye max marks ke hisaab se recalculate karo, taaki unsaved values reset na hon
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
    tbody.innerHTML = `<tr><td colspan="7">Failed to load: ${err.message}</td></tr>`;
  }
}

// DOM me agar input already hai to uski live value lo (taaki search/filter se unsaved typing reset na ho), warna cached value
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
      <td>${s.enrollment}</td>
      <td>${s.name}</td>
      <td>${s.semester ?? '-'}</td>
      <td>${s.division || '-'}</td>
      <td>${s.academic_year || '-'}</td>
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

// Marks type karte hi turant us row ka Pass/Fail pill update karo (bina save kiye bhi live dikhe)
function updateMarksRowStatus(studentId){
  const maxMarks = parseFloat(document.getElementById('marksMaxMarks').value) || 0;
  const val = document.getElementById(`marksInput_${studentId}`).value;
  document.getElementById(`marksStatus_${studentId}`).innerHTML = marksStatusPill(val === '' ? null : parseFloat(val), maxMarks);
  updateMarksSummary();
}

// Class ka Average / Highest / Lowest — abhi jo bhi input boxes me values hain, unse live calculate hota hai
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

// Publish badge — sirf tabhi "Published" dikhega jab sab entered-marks records published ho chuke hon
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
  document.getElementById('feeSemester').value = '1';
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
      ? cachedFeeStudents.map(s => `<option value="${s.student_id}">${s.name} (${s.enrollment})</option>`).join('')
      : '<option value="">No students found</option>';
  }catch(err){
    sel.innerHTML = `<option value="">Failed to load students</option>`;
  }
}

let allFees = [];
let openFeeFolderKey = null;
let openFeeTitleKey = null;

function feeFolderKey(f){
  return `${f.semester || '-'}|${f.division || '-'}|${f.academic_year || '-'}`;
}

async function loadFees(){
  const grid = document.getElementById('feesFolderGrid');
  if(grid) grid.innerHTML = '<div style="color:var(--muted); font-size:13px;">Loading…</div>';

  const semester = document.getElementById('feeFilterSemester').value;
  const division = document.getElementById('feeFilterDivision').value;
  const academicYear = document.getElementById('feeFilterYear').value;
  const status = document.getElementById('feeFilterStatus').value;
  const search = document.getElementById('feeSearch').value.trim();
  const params = new URLSearchParams();
  if(semester) params.set('semester', semester);
  if(division) params.set('division', division);
  if(academicYear) params.set('academic_year', academicYear);
  if(status) params.set('status', status);
  if(search) params.set('search', search);

  try{
    allFees = await apiRequest('/admin/fees?' + params.toString());
    renderFeeFolders();
    // Agar koi folder/sub-folder pehle se khula hua tha, use naye data ke saath refresh karo.
    if(openFeeFolderKey){
      const stillHasFolder = allFees.some(f => feeFolderKey(f) === openFeeFolderKey);
      if(!stillHasFolder){
        closeFeeFolder();
      } else if(openFeeTitleKey){
        const stillHasTitle = allFees.some(f => feeFolderKey(f) === openFeeFolderKey && f.fee_title === openFeeTitleKey);
        stillHasTitle ? openFeeTitleFolder(openFeeTitleKey) : closeFeeTitleFolder();
      } else {
        openFeeFolder(openFeeFolderKey);
      }
    }
  }catch(err){
    if(grid) grid.innerHTML = `<div style="color:var(--muted); font-size:13px;">Failed to load fees: ${err.message}</div>`;
  }
}

function renderFeeFolders(){
  const grid = document.getElementById('feesFolderGrid');
  if(!grid) return;

  if(!allFees.length){
    grid.innerHTML = '<div style="color:var(--muted); font-size:13px;">No fee records found.</div>';
    return;
  }

  const groups = {};
  allFees.forEach(f => {
    const key = feeFolderKey(f);
    if(!groups[key]){
      groups[key] = {
        semester: f.semester || '-',
        division: f.division || 'All',
        academic_year: f.academic_year || '-',
        records: []
      };
    }
    groups[key].records.push(f);
  });

  const sortedKeys = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  grid.innerHTML = sortedKeys.map(key => {
    const g = groups[key];
    const paidCount = g.records.filter(r => r.status === 'paid').length;
    const unpaidCount = g.records.length - paidCount;
    const total = g.records.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    return `
      <div class="fee-folder-card" onclick="openFeeFolder('${key}')">
        <button class="icon-action danger fee-folder-delete" title="Delete folder"
          onclick="deleteFeeFolder('${key}', event)">🗑</button>
        <div class="fee-folder-icon">📁</div>
        <div class="fee-folder-name">Sem ${g.semester} • Div ${g.division} • ${g.academic_year}</div>
        <div class="fee-folder-meta">${g.records.length} record${g.records.length === 1 ? '' : 's'} · ₹${total.toLocaleString('en-IN')}</div>
        <div class="fee-folder-stats">
          <span class="pill good">${paidCount} Paid</span>
          <span class="pill bad">${unpaidCount} Unpaid</span>
        </div>
      </div>
    `;
  }).join('');
}

// Poore folder (Sem + Div + Batch group) ke saare fee records — sab titles milaake — ek saath delete karta hai.
async function deleteFeeFolder(key, event){
  if(event) event.stopPropagation();

  const records = allFees.filter(f => feeFolderKey(f) === key);
  if(!records.length) return;
  const first = records[0];
  const label = `Sem ${first.semester || '-'} • Div ${first.division || 'All'} • ${first.academic_year || '-'}`;

  if(!confirm(`Delete all ${records.length} fee record(s) in "${label}"? This cannot be undone.`)) return;

  const params = new URLSearchParams({ semester: first.semester, academic_year: first.academic_year });
  if(first.division) params.set('division', first.division);

  try{
    await apiRequest('/admin/fees/folder?' + params.toString(), { method: 'DELETE' });
    if(openFeeFolderKey === key) closeFeeFolder();
    loadFees();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// Batch folder khulne par seedha records nahi, pehle us batch ke andar fee-title ke hisaab se
// sub-folders dikhaata hai (e.g. "Tuition Fee", "Exam Fee" — har title ka apna alag folder).
function openFeeFolder(key){
  openFeeFolderKey = key;
  openFeeTitleKey = null;
  renderFeeTitleFolders(key);

  document.getElementById('feesFolderView').classList.add('hidden');
  document.getElementById('feesRecordsView').classList.add('hidden');
  document.getElementById('feesTitleFolderView').classList.remove('hidden');
}

function renderFeeTitleFolders(key){
  const records = allFees.filter(f => feeFolderKey(f) === key);
  const grid = document.getElementById('feesTitleFolderGrid');

  const first = records[0];
  const heading = first
    ? `Sem ${first.semester || '-'} • Div ${first.division || 'All'} • ${first.academic_year || '-'}`
    : '';
  document.getElementById('feesTitleFolderHeading').textContent = heading;

  if(!records.length){
    grid.innerHTML = '<div style="color:var(--muted); font-size:13px;">No fee records found.</div>';
    return;
  }

  const titleGroups = {};
  records.forEach(f => {
    const t = f.fee_title || 'Untitled';
    if(!titleGroups[t]) titleGroups[t] = [];
    titleGroups[t].push(f);
  });

  const titles = Object.keys(titleGroups).sort((a, b) => a.localeCompare(b));

  grid.innerHTML = titles.map(title => {
    const recs = titleGroups[title];
    const paidCount = recs.filter(r => r.status === 'paid').length;
    const unpaidCount = recs.length - paidCount;
    const total = recs.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const safeTitle = title.replace(/'/g, "\\'");
    return `
      <div class="fee-folder-card" onclick="openFeeTitleFolder('${safeTitle}')">
        <button class="icon-action danger fee-folder-delete" title="Delete this folder"
          onclick="deleteFeeTitleFolder('${openFeeFolderKey}', '${safeTitle}', event)">🗑</button>
        <div class="fee-folder-icon">📁</div>
        <div class="fee-folder-name">${title}</div>
        <div class="fee-folder-meta">${recs.length} record${recs.length === 1 ? '' : 's'} · ₹${total.toLocaleString('en-IN')}</div>
        <div class="fee-folder-stats">
          <span class="pill good">${paidCount} Paid</span>
          <span class="pill bad">${unpaidCount} Unpaid</span>
        </div>
      </div>
    `;
  }).join('');
}

// Us batch ke andar ek fee-title (sub-folder) ke saare records ek saath delete karta hai —
// baaki titles ke records touch nahi hote.
async function deleteFeeTitleFolder(key, title, event){
  if(event) event.stopPropagation();
  if(!key || !title) return;

  const records = allFees.filter(f => feeFolderKey(f) === key && f.fee_title === title);
  if(!records.length) return;
  const first = records[0];

  if(!confirm(`Delete all ${records.length} "${title}" record(s) in this batch? This cannot be undone.`)) return;

  const params = new URLSearchParams({ semester: first.semester, academic_year: first.academic_year, fee_title: title });
  if(first.division) params.set('division', first.division);

  try{
    await apiRequest('/admin/fees/folder?' + params.toString(), { method: 'DELETE' });
    if(openFeeTitleKey === title) closeFeeTitleFolder();
    loadFees();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

// Sub-folder khulne par asli student-wise records table dikhta hai (existing behavior, bas ab
// fee_title se bhi filter hota hai).
function openFeeTitleFolder(title){
  openFeeTitleKey = title;
  const records = allFees.filter(f => feeFolderKey(f) === openFeeFolderKey && f.fee_title === title);
  const tbody = document.getElementById('feesTableBody');

  const first = records[0];
  const heading = first
    ? `Sem ${first.semester || '-'} • Div ${first.division || 'All'} • ${first.academic_year || '-'} • ${title}`
    : title;
  document.getElementById('feesFolderTitle').textContent = heading;

  tbody.innerHTML = records.length ? records.map(f => `
      <tr>
        <td>${f.student_name} (${f.enrollment})</td>
        <td>${f.fee_title}</td>
        <td>₹${Number(f.amount).toLocaleString('en-IN')}</td>
        <td>${f.due_date || '-'}</td>
        <td>${f.payment_link ? `<a href="${f.payment_link}" target="_blank" class="card-link">View link</a>` : '-'}</td>
        <td><span class="pill ${f.status === 'paid' ? 'good' : 'bad'}" style="cursor:pointer"
              onclick="toggleFeeStatus(${f.id}, '${f.status}')">${f.status === 'paid' ? 'Paid' : 'Unpaid'}</span></td>
        <td class="row-actions">
          <button class="icon-action" onclick='viewFeeDetails(${JSON.stringify(f)})' title="View">👁</button>
          <button class="icon-action" onclick='editFee(${JSON.stringify(f)})' title="Edit">✎</button>
          <button class="icon-action danger" onclick="deleteFee(${f.id}, '${f.fee_title}')" title="Delete">🗑</button>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="7">No fee records found.</td></tr>';

  document.getElementById('feesTitleFolderView').classList.add('hidden');
  document.getElementById('feesRecordsView').classList.remove('hidden');
}

// Records table se wapas title-sub-folder grid par.
function closeFeeTitleFolder(){
  openFeeTitleKey = null;
  document.getElementById('feesRecordsView').classList.add('hidden');
  if(openFeeFolderKey){
    renderFeeTitleFolders(openFeeFolderKey);
    document.getElementById('feesTitleFolderView').classList.remove('hidden');
  } else {
    document.getElementById('feesFolderView').classList.remove('hidden');
  }
}

// Title-sub-folder grid se wapas top-level (Sem/Div/Batch) folder grid par.
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
    ? `<a href="${fee.payment_link}" target="_blank" class="card-link">${fee.payment_link}</a>`
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

  // Edit me sirf ek hi record update hota hai — student badla nahi ja sakta,
  // isliye bulk/"apply to whole class" controls yahan chhupa dete hain.
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

function openAddNoticeForm(){
  resetNoticeForm();
  document.getElementById('noticeFormTitle').textContent = 'Add notice';
  document.getElementById('noticeForm').classList.remove('hidden');
}

function resetNoticeForm(){
  document.getElementById('noticeEditId').value = '';
  document.getElementById('noticeTitle').value = '';
  document.getElementById('noticeContent').value = '';
  document.getElementById('noticeCategory').value = 'Academic';
  document.getElementById('noticeTargetRole').value = 'all';
  document.getElementById('noticeSemester').value = '';
  document.getElementById('noticeDivision').value = '';
  document.getElementById('noticeBatch').value = '';
  document.getElementById('noticePinned').value = '0';
  document.getElementById('noticeFile').value = '';
  document.getElementById('noticeExistingFile').textContent = '';
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

let cachedAdminNotices = [];
const NF_ROLE_LABEL = { student: 'Students', faculty: 'Faculty' };

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
  return `
    <div class="nf-card nf-full ${tagCls ? 'nf-cat-' + tagCls : ''}">
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
      ${n.file_name ? nfFileChip(n, `nfAdminAction('download', ${n.id})`) : ''}
      <div class="nf-meta">
        <span>${nfTime(n.created_at)}</span>
        <button class="nf-ticks ${seen ? 'seen' : ''}" onclick="nfAdminAction('reads', ${n.id})" title="Seen by">${seen ? '✓✓ ' + n.seen_count : '✓ Sent'}</button>
      </div>
    </div>`;
}

// Card ke saare buttons id se kaam karte hain (title me quotes hone par onclick tootta nahi)
function nfAdminAction(action, id){
  const n = cachedAdminNotices.find(x => x.id === id);
  if(!n) return;
  if(action === 'reads') openNoticeReads(id, n.title);
  else if(action === 'pin') toggleNoticePin(id, !!n.is_pinned);
  else if(action === 'edit') editNotice(n);
  else if(action === 'delete') deleteNotice(id, n.title);
  else if(action === 'download') downloadNoticeFile(id);
}

async function loadNotices(){
  const container = document.getElementById('noticesListBody');
  if(container) container.innerHTML = '<div class="notice-row"><span>Loading…</span></div>';

  const category = document.getElementById('noticeFilterCategory').value;
  const semester = document.getElementById('noticeFilterSemester').value;
  const division = document.getElementById('noticeFilterDivision').value;
  const academicYear = document.getElementById('noticeFilterBatch').value;
  const params = new URLSearchParams();
  if(category) params.set('category', category);
  if(semester) params.set('semester', semester);
  if(division) params.set('division', division);
  if(academicYear) params.set('academic_year', academicYear);

  try{
    const notices = await apiRequest('/admin/notices?' + params.toString());
    if(!container) return;
    cachedAdminNotices = notices;
    container.innerHTML = notices.length ? nfRenderFeed(notices, nfAdminCard) : '<div class="nf-empty">No notices found.</div>';
  }catch(err){
    if(container) container.innerHTML = `<div class="notice-row"><span>Failed to load notices: ${err.message}</span></div>`;
  }
}

async function saveNotice(){
  const editId = document.getElementById('noticeEditId').value;
  const title = document.getElementById('noticeTitle').value.trim();

  if(!title){
    alert('Title is required');
    return;
  }

  try{
    if(editId){
      // Edit me file attachment change nahi hoti — sirf details update hoti hain
      const payload = {
        title,
        content: document.getElementById('noticeContent').value.trim(),
        category: document.getElementById('noticeCategory').value,
        target_role: document.getElementById('noticeTargetRole').value,
        semester: document.getElementById('noticeSemester').value || null,
        division: document.getElementById('noticeDivision').value || null,
        academic_year: document.getElementById('noticeBatch').value || null,
        is_pinned: document.getElementById('noticePinned').value === '1'
      };
      await apiRequest(`/admin/notices/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      alert('Notice updated');
    } else {
      const formData = new FormData();
      formData.append('title', title);
      formData.append('content', document.getElementById('noticeContent').value.trim());
      formData.append('category', document.getElementById('noticeCategory').value);
      formData.append('target_role', document.getElementById('noticeTargetRole').value);
      formData.append('semester', document.getElementById('noticeSemester').value || '');
      formData.append('division', document.getElementById('noticeDivision').value || '');
      formData.append('academic_year', document.getElementById('noticeBatch').value || '');
      formData.append('is_pinned', document.getElementById('noticePinned').value === '1' ? '1' : '0');
      const fileInput = document.getElementById('noticeFile');
      if(fileInput.files[0]) formData.append('file', fileInput.files[0]);

      await apiUpload('/admin/notices', formData);
      alert('Notice published');
    }
    toggleForm('noticeForm');
    resetNoticeForm();
    loadNotices();
  }catch(err){
    alert('Error: ' + err.message);
  }
}

function editNotice(notice){
  document.getElementById('noticeEditId').value = notice.id;
  document.getElementById('noticeTitle').value = notice.title;
  document.getElementById('noticeContent').value = notice.content || '';
  document.getElementById('noticeCategory').value = notice.category || 'Academic';
  document.getElementById('noticeTargetRole').value = notice.target_role || 'all';
  document.getElementById('noticeSemester').value = notice.semester || '';
  document.getElementById('noticeDivision').value = notice.division || '';
  document.getElementById('noticeBatch').value = notice.academic_year || '';
  document.getElementById('noticePinned').value = notice.is_pinned ? '1' : '0';
  document.getElementById('noticeFile').value = '';
  document.getElementById('noticeExistingFile').textContent = notice.file_name
    ? `Current attachment: ${notice.file_name} (naya upload abhi supported nahi, sirf details edit hoti hain)`
    : '';
  document.getElementById('noticeFormTitle').textContent = 'Edit notice';
  document.getElementById('noticeForm').classList.remove('hidden');
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

async function downloadNoticeFile(id){
  try{
    const res = await fetch(API_BASE + `/admin/notices/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_admin') }
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
        <td>${r.name}</td>
        <td>${r.login_id}</td>
        <td style="text-transform:capitalize;">${r.role}</td>
        <td>${formatDateTime(r.seen_at)}</td>
      </tr>
    `).join('') : '<tr><td colspan="4">No one has viewed this yet.</td></tr>';
  }catch(err){
    body.innerHTML = `<tr><td colspan="4">Failed to load: ${err.message}</td></tr>`;
  }
}

function closeNoticeReads(){
  document.getElementById('noticeReadsOverlay').classList.remove('open');
}

// ---- Marks Requests (faculty submissions ka approval workflow) ----
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
        <td>Sem ${r.semester} / ${r.division || 'All'}</td>
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
        <td>${s.marks_obtained ?? '—'}</td>
      </tr>
    `).join('') || '<tr><td colspan="3" style="color:var(--muted);">No student was found.</td></tr>';

    // Status ke hisaab se sahi actions dikhao
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
// Date ko readable format me dikhane ke liye (e.g. "2026-07-01" -> "1 Jul 2026")
function formatShortDate(dateStr){
  if(!dateStr) return '—';
  const d = new Date(dateStr);
  if(isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function loadAcademicYears(){
  const container = document.getElementById('academicYearsList');
  try{
    const years = await apiRequest('/admin/academic-years');
    applyAcademicYearsToDropdowns(years);   // saare "Batch (Academic Year)" dropdowns yahi se refresh hote hain

    if(years.length === 0){
      container.innerHTML = '<div class="notice-row" style="border-bottom:none;">No academic year has been added</div>';
      return;
    }
    const todayStr = new Date().toISOString().slice(0, 10);

    container.innerHTML = years.map((y, i) => {
      const isLast = i === years.length - 1;

      const semRows = [1,2,3,4,5,6].map(n => {
        const start = y[`sem${n}_start`];
        const end = y[`sem${n}_end`];
        if(!start && !end) return '';   // is year ke is semester ki date set hi nahi hai — skip
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
          <b>${escapeHtmlMR(y.year_label)}</b>
          ${semBlock}
        </div>`;
    }).join('');
  }catch(err){
    container.innerHTML = '<div class="notice-row" style="border-bottom:none;">Failed to load</div>';
  }
}

async function addAcademicYear(){
  const input = document.getElementById('newAcademicYear');
  const yearLabel = input.value.trim();
  if(!yearLabel){
    alert('Enter the academic year (e.g. 2027-28)');
    return;
  }
  const payload = { year_label: yearLabel };
  for(let n = 1; n <= 6; n++){
    payload[`sem${n}_start`] = document.getElementById(`newSem${n}Start`).value || null;
    payload[`sem${n}_end`] = document.getElementById(`newSem${n}End`).value || null;
  }
  try{
    await apiRequest('/admin/academic-years', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    input.value = '';
    for(let n = 1; n <= 6; n++){
      document.getElementById(`newSem${n}Start`).value = '';
      document.getElementById(`newSem${n}End`).value = '';
    }
    toggleForm('academicYearForm');
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
        <td>${deptName(r.department)}</td>
        <td>Sem ${r.semester}</td>
        <td>${r.student_count}</td>
      </tr>`).join('');
  }catch(err){
    body.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
  }
}

// ============================================================
// Saare "Batch (Academic Year)" dropdowns (Add forms + filters) ko
// Academic Management ke academic_years table se sync karta hai.
// Jahan "All batches"/"Any" jaisa koi khaali placeholder option pehle
// se hai wahan wahi preserve hota hai; jahan nahi hai wahan Active
// (current) academic year default-select ho jaata hai.
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
  'repStudentBatch', 'repAttendanceBatch', 'repAssignmentBatch'
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

  // Jis row ke kisi bhi semester (1-6) ki date-range me aaj ki date fit
  // baithti hai wahi "current" batch maana jaata hai; warna sabse recent
  // year_label fallback ban jaata hai.
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
    const previousValue = sel.value;   // agar edit form khula hai to uski existing value preserve karni hai

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
      sel.value = current.year_label;   // "All"/"Any" wale placeholder nahi hai to Active year default select karo
    }
  });
}

// ============================================================
// Logout — token/role/name clear karke login page pe bhej do
// ============================================================
function logout(){
  if(!confirm('Log out?')) return;
  localStorage.removeItem('token_admin');
  localStorage.removeItem('name_admin');
  window.location.href = '../login_panel/login.html';
}

// Login ke waqt jo 'name' localStorage me save hota hai, use sidebar +
// profile dropdown me dikha do (hardcoded "Admin" ki jagah)
function applyProfileNameToUI(){
  const name = localStorage.getItem('name_admin') || 'Admin';
  const initial = name.charAt(0).toUpperCase();
  const nameEls = [document.getElementById('sidebarProfileName'), document.getElementById('profileMenuName')];
  nameEls.forEach(el => { if(el) el.textContent = name; });
  const initialEls = [document.getElementById('sidebarAvatarInitial'), document.getElementById('topbarAvatarInitial')];
  initialEls.forEach(el => { if(el) el.textContent = initial; });
}

// ============================================================
// 'since' timestamp ko DB ke naive local (IST) datetime format me bhejna zaroori hai —
// new Date().toISOString() UTC deta hai, jo notices/marks_requests ke local timestamps
// se 5:30 ghante mismatch kar deta hai aur "seen" kiya hua bhi unseen dikhta rehta hai.
function toLocalDbDateTime(d){
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Topbar dropdowns — profile menu, global search.
// Sirf ek dropdown ek waqt pe khula rahe, aur bahar click karne pe band ho jaaye.
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

// Page load pe (aur har 60 sec me) unseen count check karke red dot pe number dikhata hai
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
    // silent fail — badge bas nahi update hoga
  }
}

// ============================================================
// Global search — header search box se students/faculty naam
// ya enrollment/ID se dhundta hai
// ============================================================
let globalSearchDebounce = null;

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
  resultsBox.classList.remove('hidden');
  resultsBox.innerHTML = '<div class="dropdown-empty">Searching…</div>';

  try{
    const [students, faculty] = await Promise.all([
      apiRequest('/admin/students?search=' + encodeURIComponent(query)),
      apiRequest('/admin/faculty?search=' + encodeURIComponent(query))
    ]);

    let html = '';
    if(students.length){
      html += '<div class="dropdown-item" style="font-weight:600; cursor:default; background:var(--mint-100);">Students</div>';
      html += students.slice(0, 5).map(s => `
        <div class="dropdown-item" onclick="goToSearchResult('student', '${s.enrollment}')">
          ${escapeHtmlMR(s.name)} <span style="color:var(--muted); font-size:12px;">· ${escapeHtmlMR(s.enrollment)}</span>
        </div>`).join('');
    }
    if(faculty.length){
      html += '<div class="dropdown-item" style="font-weight:600; cursor:default; background:var(--mint-100);">Faculty</div>';
      html += faculty.slice(0, 5).map(f => `
        <div class="dropdown-item" onclick="goToSearchResult('faculty', '${f.faculty_id}')">
          ${escapeHtmlMR(f.name)} <span style="color:var(--muted); font-size:12px;">· ${escapeHtmlMR(f.faculty_id)}</span>
        </div>`).join('');
    }
    resultsBox.innerHTML = html || '<div class="dropdown-empty">No matches found</div>';
  }catch(err){
    resultsBox.innerHTML = '<div class="dropdown-empty">Search failed</div>';
  }
}

// Result pe click karte hi us view pe jaake, uski row dhund ke highlight/scroll kar deta hai
function goToSearchResult(type, idText){
  document.getElementById('globalSearchResults').classList.add('hidden');
  document.getElementById('globalSearchInput').value = '';

  const targetView = type === 'student' ? 'students' : 'faculty';
  const tbodyId = type === 'student' ? 'studentsTableBody' : 'facultyTableBody';
  switchView(targetView);

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

document.addEventListener('click', closeAllMenus);   // dropdown ke bahar click = band

// ============================================================
// REPORTS — filter panels ke Subject dropdown ko selected Batch+Sem
// ke hisaab se dynamically bharta hai, aur Excel download trigger karta hai.
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
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_admin') }
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

function downloadReport(reportType){
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

  const endpoint = reportType.toLowerCase();   // 'student' | 'attendance' | 'assignment'
  downloadReportFile(`/admin/reports/${endpoint}s/excel?${params.toString()}`, `${endpoint}_report.xlsx`);
}

function downloadLoginActivityReport(){
  const params = new URLSearchParams();
  const from = document.getElementById('repLoginFrom').value;
  const to = document.getElementById('repLoginTo').value;
  const role = document.getElementById('repLoginRole').value;
  if(from) params.set('from_date', from);
  if(to) params.set('to_date', to);
  if(role) params.set('role', role);

  downloadReportFile(`/admin/reports/login-activity/excel?${params.toString()}`, 'login_activity_report.xlsx');
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
        <td>${b.size_kb} KB</td>
        <td style="white-space:nowrap;">
          <button class="btn-ghost" style="padding:4px 8px; font-size:11px;" onclick="downloadBackupFile('${b.filename}')">Download</button>
          <button class="btn-ghost" style="padding:4px 8px; font-size:11px; color:var(--danger,#d33);" onclick="deleteBackupFile('${b.filename}')">Delete</button>
        </td>
      </tr>`).join('');
    selectEl.innerHTML = '<option value="">-- Or upload a new file below --</option>' +
      backups.map(b => `<option value="${b.filename}">${escapeHtmlMR(b.filename)} (${b.created_at})</option>`).join('');
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
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token_admin') },
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

// Password field ka Show/Hide toggle (Security page — Change Password)
function toggleVis(id, btn){
  const input = document.getElementById(id);
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  btn.textContent = isPwd ? 'Hide' : 'Show';
}