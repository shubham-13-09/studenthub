// ---- Student lists: hamesha enrollment number ke order me (numeric-aware, stable) ----
function sortByEnrollment(list, key = 'enrollment'){
  return [...(list || [])].sort((a, b) =>
    String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true, sensitivity: 'base' })
  );
}

// ---- Date format: DD-MM-YYYY (poore faculty panel me yahi format) ----
function formatDMY(value){
  if(!value) return '';
  let d;
  if(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)){
    d = new Date(value + 'T00:00:00');            // plain date: timezone shift se bachne ke liye local midnight
  }else{
    d = new Date(value);
  }
  if(isNaN(d)) return String(value);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}
function formatDMYWeekday(value){
  const base = formatDMY(value);
  if(!base) return '';
  const d = (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) ? new Date(value + 'T00:00:00') : new Date(value);
  if(isNaN(d)) return base;
  return `${d.toLocaleDateString('en-IN', { weekday: 'short' })}, ${base}`;
}
function formatDMYTime(value){
  const d = new Date(value);
  if(isNaN(d)) return '';
  return `${formatDMY(d)}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

if(!sessionStorage.getItem('token_faculty')){
  window.location.href = '../login_panel/login.html';
}

// ---- API helpers ----
const API_BASE = window.APP_CONFIG.API_BASE;   // set in ../shared/config.js

function authHeaders(){
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty')
  };
}

async function apiRequest(path, options = {}){
  const res = await fetch(API_BASE + path, { ...options, headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || (res.status === 403 && /access required/i.test(data.message || ''))){
    // token invalid/expired or not a faculty — send back to login
    // (other 403s, like "already submitted" / "not yours", are business-rule errors — don't log out)
    sessionStorage.removeItem('token_faculty');
    window.location.href = '../login_panel/login.html';
    throw new Error(data.message || 'Unauthorized');
  }
  if(!res.ok){
    const err = new Error(data.message || 'Request failed');
    err.data = data;      // lets callers read extra fields (e.g. needs_extra_confirm)
    err.status = res.status;
    throw err;
  }
  return data;
}

// For file uploads — we do NOT set the Content-Type header manually here,
// the browser sets it itself with the multipart boundary (FormData body)
async function apiUpload(path, formData){
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') },
    body: formData
  });
  const data = await res.json().catch(() => ({}));
  if(res.status === 401 || (res.status === 403 && /access required/i.test(data.message || ''))){
    sessionStorage.removeItem('token_faculty');
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
  if(name === 'chat') loadChatHistory();
  if(name === 'dashboard') setTimeout(relimitDashLists, 0);
  if(name === 'fees' && typeof loadFacultyFees === 'function' && !feesHasUnsavedChanges()) loadFacultyFees();
  document.querySelectorAll('.nav-item').forEach(i=> i.classList.toggle('active', i.dataset.view===name));
  document.querySelectorAll('.view').forEach(v=> v.classList.toggle('active', v.id==='view-'+name));
  if(name === 'notices'){
    renderFacNoticeGroupList();
    if(facNoticeGroup){
      nfScrollToBottom('facultyNoticesList', false);
      if(facGroupNotices(facNoticeGroup).some(n => !n.is_read && !n.can_manage)) markFacNoticeGroupRead(facNoticeGroup);
    }
  }
  // If you came here from the My Subjects card for "attendance" and a subject context is pending (set by openClass),
  // load the filters + student list for that subject right away
  if(name === 'attendance' && window.selectedSubjectContext) populateAttendanceClassSelect();
}

// ---- Reports ----
function openFacultyReport(type){
  // type: 'attendance' | 'assignment' | 'student' | 'marks' | 'fees'
  const panels = {
    attendance: 'facRepAttendancePanel',
    assignment: 'facRepAssignPanel',
    student: 'facRepStudentPanel',
    marks: 'facRepMarksPanel',
    fees: 'facRepFeesPanel'
  };
  const loaders = {
    attendance: () => populateFacRepAttBatches(),
    assignment: () => populateFacRepAsgBatches(),
    student: () => populateFacRepStuBatches(),
    marks: () => populateFacRepMkBatches(),
    fees: () => populateFacRepFeeBatches()
  };
  if(!panels[type]) return;
  const panel = document.getElementById(panels[type]);
  if(!panel) return;
  Object.keys(panels).forEach(k => {
    if(k !== type){
      const other = document.getElementById(panels[k]);
      if(other) other.classList.add('hidden');
    }
  });
  panel.classList.toggle('hidden');
  if(!panel.classList.contains('hidden')){
    loaders[type]();
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ---- Attendance Report: Batch -> Semester -> Subject -> Division (only this faculty's own subjects) ----
function populateFacRepAttBatches(){
  const batchSel = document.getElementById('facRepAttBatch');
  const years = uniqueSorted(cachedSubjects, 'academic_year').reverse();   // latest batch first
  if(!years.length){
    batchSel.innerHTML = '<option value="">No subjects assigned</option>';
    document.getElementById('facRepAttSem').innerHTML = '<option value="">Select semester</option>';
    document.getElementById('facRepAttSubject').innerHTML = '<option value="">Select semester first</option>';
    document.getElementById('facRepAttDiv').innerHTML = '<option value="">All divisions</option>';
    return;
  }
  const prev = batchSel.value;
  batchSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  batchSel.value = years.includes(prev) ? prev : years[0];
  onFacRepAttBatchChange();
}

function onFacRepAttBatchChange(){
  const batch = document.getElementById('facRepAttBatch').value;
  const semSel = document.getElementById('facRepAttSem');
  const sems = uniqueSorted(cachedSubjects.filter(s => s.academic_year === batch), 'semester');
  semSel.innerHTML = '<option value="">Select semester</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  if(sems.length === 1) semSel.value = String(sems[0]);
  onFacRepAttSemChange();
}

function onFacRepAttSemChange(){
  const batch = document.getElementById('facRepAttBatch').value;
  const sem = document.getElementById('facRepAttSem').value;
  const subjSel = document.getElementById('facRepAttSubject');
  if(!sem){
    subjSel.innerHTML = '<option value="">Select semester first</option>';
    onFacRepAttSubjectChange();
    return;
  }
  // One entry per subject (a subject assigned division-wise has several assignments -> shown once)
  const seen = new Set();
  const options = [];
  cachedSubjects.forEach(s => {
    if(s.academic_year !== batch || String(s.semester) !== sem || seen.has(s.subject_id)) return;
    seen.add(s.subject_id);
    const label = s.subject_code ? `${s.subject_name} (${s.subject_code})` : s.subject_name;
    options.push(`<option value="${s.subject_id}" data-name="${escapeAttr(s.subject_name)}">${escapeAttr(label)}</option>`);
  });
  subjSel.innerHTML = '<option value="">Select subject</option>' + options.join('');
  if(options.length === 1) subjSel.selectedIndex = 1;
  onFacRepAttSubjectChange();
}

function onFacRepAttSubjectChange(){
  const batch = document.getElementById('facRepAttBatch').value;
  const sem = document.getElementById('facRepAttSem').value;
  const subjectId = document.getElementById('facRepAttSubject').value;
  const divSel = document.getElementById('facRepAttDiv');
  const divs = new Set();
  if(subjectId){
    cachedSubjects.forEach(s => {
      if(s.academic_year === batch && String(s.semester) === sem && String(s.subject_id) === subjectId){
        (s.available_divisions || []).forEach(d => divs.add(d));
      }
    });
  }
  divSel.innerHTML = '<option value="">All divisions</option>' +
    [...divs].sort().map(d => `<option value="${d}">Division ${d}</option>`).join('');
}

function onFacRepAttPctChange(){
  const custom = document.getElementById('facRepAttPct').value === 'custom';
  document.getElementById('facRepAttPctRange').classList.toggle('hidden', !custom);
}

function escapeAttr(v){
  return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function downloadFacultyAttendanceReport(format){
  const batch = document.getElementById('facRepAttBatch').value;
  const sem = document.getElementById('facRepAttSem').value;
  const subjSel = document.getElementById('facRepAttSubject');
  const subjectId = subjSel.value;
  const div = document.getElementById('facRepAttDiv').value;
  const pctMode = document.getElementById('facRepAttPct').value;

  if(!batch || !sem || !subjectId){
    alert('Select Batch, Semester and Subject');
    return;
  }

  const params = new URLSearchParams({ academic_year: batch, semester: sem, subject_id: subjectId, format });
  if(div) params.set('division', div);

  if(pctMode === 'below75'){
    params.set('max_percent', '75');
    params.set('max_exclusive', '1');
  }else if(pctMode === 'above75'){
    params.set('min_percent', '75');
  }else if(pctMode === 'custom'){
    const from = document.getElementById('facRepAttPctFrom').value.trim();
    const to = document.getElementById('facRepAttPctTo').value.trim();
    if(!from && !to){
      alert('Enter at least one value in the custom range (From % or To %)');
      return;
    }
    if((from && (Number(from) < 0 || Number(from) > 100)) || (to && (Number(to) < 0 || Number(to) > 100))){
      alert('Percentage must be between 0 and 100');
      return;
    }
    if(from && to && Number(from) > Number(to)){
      alert("'From %' cannot be greater than 'To %'");
      return;
    }
    if(from) params.set('min_percent', from);
    if(to) params.set('max_percent', to);
  }

  const subjName = (subjSel.selectedOptions[0] && subjSel.selectedOptions[0].dataset.name) || 'subject';
  const filename = `attendance_${subjName}_sem${sem}_${batch}${div ? '_div' + div : ''}.${format}`.replace(/[^A-Za-z0-9._-]+/g, '_');

  try{
    const res = await fetch(API_BASE + '/faculty/reports/attendance?' + params.toString(), {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
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
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(dlUrl);
  }catch(err){
    alert('Download error: ' + err.message);
  }
}

// ---- Assignment Report: Batch -> Semester -> Subject -> Division -> Assignment (only this faculty's own subjects) ----
function populateFacRepAsgBatches(){
  const batchSel = document.getElementById('facRepAsgBatch');
  const years = uniqueSorted(cachedSubjects, 'academic_year').reverse();   // latest batch first
  if(!years.length){
    batchSel.innerHTML = '<option value="">No subjects assigned</option>';
    document.getElementById('facRepAsgSem').innerHTML = '<option value="">Select semester</option>';
    document.getElementById('facRepAsgSubject').innerHTML = '<option value="">Select semester first</option>';
    document.getElementById('facRepAsgDiv').innerHTML = '<option value="">All divisions</option>';
    document.getElementById('facRepAsgAssignment').innerHTML = '<option value="">All assignments</option>';
    return;
  }
  const prev = batchSel.value;
  batchSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  batchSel.value = years.includes(prev) ? prev : years[0];
  onFacRepAsgBatchChange();
}

function onFacRepAsgBatchChange(){
  const batch = document.getElementById('facRepAsgBatch').value;
  const semSel = document.getElementById('facRepAsgSem');
  const sems = uniqueSorted(cachedSubjects.filter(s => s.academic_year === batch), 'semester');
  semSel.innerHTML = '<option value="">Select semester</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  if(sems.length === 1) semSel.value = String(sems[0]);
  onFacRepAsgSemChange();
}

function onFacRepAsgSemChange(){
  const batch = document.getElementById('facRepAsgBatch').value;
  const sem = document.getElementById('facRepAsgSem').value;
  const subjSel = document.getElementById('facRepAsgSubject');
  if(!sem){
    subjSel.innerHTML = '<option value="">Select semester first</option>';
    onFacRepAsgSubjectChange();
    return;
  }
  // One entry per subject (a subject assigned division-wise has several assignments -> shown once)
  const seen = new Set();
  const options = [];
  cachedSubjects.forEach(s => {
    if(s.academic_year !== batch || String(s.semester) !== sem || seen.has(s.subject_id)) return;
    seen.add(s.subject_id);
    const label = s.subject_code ? `${s.subject_name} (${s.subject_code})` : s.subject_name;
    options.push(`<option value="${s.subject_id}" data-name="${escapeAttr(s.subject_name)}">${escapeAttr(label)}</option>`);
  });
  subjSel.innerHTML = '<option value="">Select subject</option>' + options.join('');
  if(options.length === 1) subjSel.selectedIndex = 1;
  onFacRepAsgSubjectChange();
}

function onFacRepAsgSubjectChange(){
  const batch = document.getElementById('facRepAsgBatch').value;
  const sem = document.getElementById('facRepAsgSem').value;
  const subjectId = document.getElementById('facRepAsgSubject').value;
  const divSel = document.getElementById('facRepAsgDiv');
  const divs = new Set();
  if(subjectId){
    cachedSubjects.forEach(s => {
      if(s.academic_year === batch && String(s.semester) === sem && String(s.subject_id) === subjectId){
        (s.available_divisions || []).forEach(d => divs.add(d));
      }
    });
  }
  divSel.innerHTML = '<option value="">All divisions</option>' +
    [...divs].sort().map(d => `<option value="${d}">Division ${d}</option>`).join('');
  loadFacRepAsgAssignments();
}

// Fills the Assignment dropdown with this subject's assignments (same endpoint as the Assignments screen)
async function loadFacRepAsgAssignments(){
  const batch = document.getElementById('facRepAsgBatch').value;
  const sem = document.getElementById('facRepAsgSem').value;
  const subjectId = document.getElementById('facRepAsgSubject').value;
  const div = document.getElementById('facRepAsgDiv').value;
  const asgSel = document.getElementById('facRepAsgAssignment');
  const allOpt = '<option value="">All assignments</option>';
  if(!batch || !sem || !subjectId){
    asgSel.innerHTML = allOpt;
    return;
  }
  const params = new URLSearchParams({ academic_year: batch, semester: sem, subject_id: subjectId });
  if(div) params.set('division', div);
  try{
    const res = await fetch(API_BASE + '/faculty/assignments?' + params.toString(), {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
    });
    if(!res.ok){ asgSel.innerHTML = allOpt; return; }
    const list = await res.json();
    asgSel.innerHTML = allOpt + list.map(a => {
      const due = a.due_date ? ' - due ' + formatDMY(a.due_date) : '';
      const dv = a.division ? ` (Div ${a.division})` : '';
      return `<option value="${a.id}">${escapeAttr(a.title + dv + due)}</option>`;
    }).join('');
  }catch(err){
    asgSel.innerHTML = allOpt;
  }
}

async function downloadFacultyAssignmentReport(format){
  const batch = document.getElementById('facRepAsgBatch').value;
  const sem = document.getElementById('facRepAsgSem').value;
  const subjSel = document.getElementById('facRepAsgSubject');
  const subjectId = subjSel.value;
  const div = document.getElementById('facRepAsgDiv').value;
  const assignmentId = document.getElementById('facRepAsgAssignment').value;
  const reportType = document.getElementById('facRepAsgType').value;
  const status = document.getElementById('facRepAsgStatus').value;

  if(!batch || !sem || !subjectId){
    alert('Select Batch, Semester and Subject');
    return;
  }
  if(reportType === 'detail' && !assignmentId){
    alert('Select one assignment for the assignment-wise detail report');
    return;
  }

  const params = new URLSearchParams({ academic_year: batch, semester: sem, subject_id: subjectId, format, report: reportType, status });
  if(div) params.set('division', div);
  if(assignmentId) params.set('assignment_id', assignmentId);

  const subjName = (subjSel.selectedOptions[0] && subjSel.selectedOptions[0].dataset.name) || 'subject';
  const filename = `assignments_${reportType}_${subjName}_sem${sem}_${batch}${div ? '_div' + div : ''}.${format}`.replace(/[^A-Za-z0-9._-]+/g, '_');

  try{
    const res = await fetch(API_BASE + '/faculty/reports/assignments?' + params.toString(), {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
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
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(dlUrl);
  }catch(err){
    alert('Download error: ' + err.message);
  }
}

// ---- Student Report: Batch -> Semester -> Subject -> Division -> Students (only this faculty's own subjects) ----
function populateFacRepStuBatches(){
  const batchSel = document.getElementById('facRepStuBatch');
  const years = uniqueSorted(cachedSubjects, 'academic_year').reverse();   // latest batch first
  if(!years.length){
    batchSel.innerHTML = '<option value="">No subjects assigned</option>';
    document.getElementById('facRepStuSem').innerHTML = '<option value="">Select semester</option>';
    document.getElementById('facRepStuSubject').innerHTML = '<option value="">Select semester first</option>';
    document.getElementById('facRepStuDiv').innerHTML = '<option value="">All divisions</option>';
    document.getElementById('facRepStuOne').innerHTML = '<option value="">Select student</option>';
    return;
  }
  const prev = batchSel.value;
  batchSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  batchSel.value = years.includes(prev) ? prev : years[0];
  onFacRepStuBatchChange();
}

function onFacRepStuBatchChange(){
  const batch = document.getElementById('facRepStuBatch').value;
  const semSel = document.getElementById('facRepStuSem');
  const sems = uniqueSorted(cachedSubjects.filter(s => s.academic_year === batch), 'semester');
  semSel.innerHTML = '<option value="">Select semester</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  if(sems.length === 1) semSel.value = String(sems[0]);
  onFacRepStuSemChange();
}

function onFacRepStuSemChange(){
  const batch = document.getElementById('facRepStuBatch').value;
  const sem = document.getElementById('facRepStuSem').value;
  const subjSel = document.getElementById('facRepStuSubject');
  if(!sem){
    subjSel.innerHTML = '<option value="">Select semester first</option>';
    onFacRepStuSubjectChange();
    return;
  }
  // One entry per subject (a subject assigned division-wise has several assignments -> shown once)
  const seen = new Set();
  const options = [];
  cachedSubjects.forEach(s => {
    if(s.academic_year !== batch || String(s.semester) !== sem || seen.has(s.subject_id)) return;
    seen.add(s.subject_id);
    const label = s.subject_code ? `${s.subject_name} (${s.subject_code})` : s.subject_name;
    options.push(`<option value="${s.subject_id}" data-name="${escapeAttr(s.subject_name)}">${escapeAttr(label)}</option>`);
  });
  subjSel.innerHTML = '<option value="">Select subject</option>' + options.join('');
  if(options.length === 1) subjSel.selectedIndex = 1;
  onFacRepStuSubjectChange();
}

function onFacRepStuSubjectChange(){
  const batch = document.getElementById('facRepStuBatch').value;
  const sem = document.getElementById('facRepStuSem').value;
  const subjectId = document.getElementById('facRepStuSubject').value;
  const divSel = document.getElementById('facRepStuDiv');
  const divs = new Set();
  if(subjectId){
    cachedSubjects.forEach(s => {
      if(s.academic_year === batch && String(s.semester) === sem && String(s.subject_id) === subjectId){
        (s.available_divisions || []).forEach(d => divs.add(d));
      }
    });
  }
  divSel.innerHTML = '<option value="">All divisions</option>' +
    [...divs].sort().map(d => `<option value="${d}">Division ${d}</option>`).join('');
  onFacRepStuFilterChange();
}

// Division / Students dropdown changed: the Student picker is shown only for "One student"
function onFacRepStuFilterChange(){
  const who = document.getElementById('facRepStuWho').value;
  document.getElementById('facRepStuOneWrap').classList.toggle('hidden', who !== 'one');
  if(who === 'one') loadFacRepStuStudents();
}

// Fills the Student dropdown from the same endpoint the Students screen uses (one call per matching subject assignment)
async function loadFacRepStuStudents(){
  const batch = document.getElementById('facRepStuBatch').value;
  const sem = document.getElementById('facRepStuSem').value;
  const subjectId = document.getElementById('facRepStuSubject').value;
  const div = document.getElementById('facRepStuDiv').value;
  const sel = document.getElementById('facRepStuOne');
  const empty = '<option value="">Select student</option>';
  if(!batch || !sem || !subjectId){ sel.innerHTML = empty; return; }

  const matches = cachedSubjects.filter(s =>
    s.academic_year === batch && String(s.semester) === sem && String(s.subject_id) === subjectId &&
    (!div || !s.division || s.division === div));
  if(!matches.length){ sel.innerHTML = empty; return; }

  sel.innerHTML = '<option value="">Loading students...</option>';
  try{
    const lists = await Promise.all(matches.map(async m => {
      const params = new URLSearchParams({ assignment_id: m.assignment_id });
      if(div) params.set('division', div);
      const res = await fetch(API_BASE + '/faculty/students?' + params.toString(), {
        headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
      });
      if(!res.ok) return [];
      const data = await res.json();
      return data.students || [];
    }));
    const byId = new Map();
    lists.flat().forEach(st => byId.set(st.student_id, st));
    const students = sortByEnrollment([...byId.values()]);
    sel.innerHTML = empty + students.map(st =>
      `<option value="${st.student_id}">${escapeAttr(st.enrollment + ' - ' + st.name + (st.division ? ' (Div ' + st.division + ')' : ''))}</option>`
    ).join('');
  }catch(err){
    sel.innerHTML = empty;
  }
}

async function downloadFacultyStudentReport(format){
  const batch = document.getElementById('facRepStuBatch').value;
  const sem = document.getElementById('facRepStuSem').value;
  const subjSel = document.getElementById('facRepStuSubject');
  const subjectId = subjSel.value;
  const div = document.getElementById('facRepStuDiv').value;
  const who = document.getElementById('facRepStuWho').value;
  const studentId = document.getElementById('facRepStuOne').value;
  const parent = document.getElementById('facRepStuParent').checked;

  if(!batch || !sem || !subjectId){
    alert('Select Batch, Semester and Subject');
    return;
  }
  if(who === 'one' && !studentId){
    alert('Select a student for the detailed report');
    return;
  }

  const reportType = who === 'one' ? 'detail' : 'summary';
  const params = new URLSearchParams({ academic_year: batch, semester: sem, subject_id: subjectId, format, report: reportType });
  if(div) params.set('division', div);
  if(who === 'atrisk') params.set('at_risk', '1');
  if(who === 'one') params.set('student_id', studentId);
  if(parent) params.set('include_parent', '1');

  const subjName = (subjSel.selectedOptions[0] && subjSel.selectedOptions[0].dataset.name) || 'subject';
  const filename = `students_${reportType}_${subjName}_sem${sem}_${batch}${div ? '_div' + div : ''}.${format}`.replace(/[^A-Za-z0-9._-]+/g, '_');

  try{
    const res = await fetch(API_BASE + '/faculty/reports/students?' + params.toString(), {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
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
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(dlUrl);
  }catch(err){
    alert('Download error: ' + err.message);
  }
}

// ---- Marks Report: Batch -> Semester -> Subject -> Division (only this faculty's own subjects) ----
function populateFacRepMkBatches(){
  const batchSel = document.getElementById('facRepMkBatch');
  const years = uniqueSorted(cachedSubjects, 'academic_year').reverse();   // latest batch first
  if(!years.length){
    batchSel.innerHTML = '<option value="">No subjects assigned</option>';
    document.getElementById('facRepMkSem').innerHTML = '<option value="">Select semester</option>';
    document.getElementById('facRepMkSubject').innerHTML = '<option value="">Select semester first</option>';
    document.getElementById('facRepMkDiv').innerHTML = '<option value="">All divisions</option>';
    return;
  }
  const prev = batchSel.value;
  batchSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  batchSel.value = years.includes(prev) ? prev : years[0];
  onFacRepMkBatchChange();
}

function onFacRepMkBatchChange(){
  const batch = document.getElementById('facRepMkBatch').value;
  const semSel = document.getElementById('facRepMkSem');
  const sems = uniqueSorted(cachedSubjects.filter(s => s.academic_year === batch), 'semester');
  semSel.innerHTML = '<option value="">Select semester</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  if(sems.length === 1) semSel.value = String(sems[0]);
  onFacRepMkSemChange();
}

function onFacRepMkSemChange(){
  const batch = document.getElementById('facRepMkBatch').value;
  const sem = document.getElementById('facRepMkSem').value;
  const subjSel = document.getElementById('facRepMkSubject');
  if(!sem){
    subjSel.innerHTML = '<option value="">Select semester first</option>';
    onFacRepMkSubjectChange();
    return;
  }
  // One entry per subject (a subject assigned division-wise has several assignments -> shown once)
  const seen = new Set();
  const options = [];
  cachedSubjects.forEach(s => {
    if(s.academic_year !== batch || String(s.semester) !== sem || seen.has(s.subject_id)) return;
    seen.add(s.subject_id);
    const label = s.subject_code ? `${s.subject_name} (${s.subject_code})` : s.subject_name;
    options.push(`<option value="${s.subject_id}" data-name="${escapeAttr(s.subject_name)}">${escapeAttr(label)}</option>`);
  });
  subjSel.innerHTML = '<option value="">Select subject</option>' + options.join('');
  if(options.length === 1) subjSel.selectedIndex = 1;
  onFacRepMkSubjectChange();
}

function onFacRepMkSubjectChange(){
  const batch = document.getElementById('facRepMkBatch').value;
  const sem = document.getElementById('facRepMkSem').value;
  const subjectId = document.getElementById('facRepMkSubject').value;
  const divSel = document.getElementById('facRepMkDiv');
  const divs = new Set();
  if(subjectId){
    cachedSubjects.forEach(s => {
      if(s.academic_year === batch && String(s.semester) === sem && String(s.subject_id) === subjectId){
        (s.available_divisions || []).forEach(d => divs.add(d));
      }
    });
  }
  divSel.innerHTML = '<option value="">All divisions</option>' +
    [...divs].sort().map(d => `<option value="${d}">Division ${d}</option>`).join('');
}

async function downloadFacultyMarksReport(format){
  const batch = document.getElementById('facRepMkBatch').value;
  const sem = document.getElementById('facRepMkSem').value;
  const subjSel = document.getElementById('facRepMkSubject');
  const subjectId = subjSel.value;
  const div = document.getElementById('facRepMkDiv').value;
  const exam = document.getElementById('facRepMkExam').value;
  const result = document.getElementById('facRepMkResult').value;

  if(!batch || !sem || !subjectId){
    alert('Select Batch, Semester and Subject');
    return;
  }

  const params = new URLSearchParams({ academic_year: batch, semester: sem, subject_id: subjectId, format, result });
  if(div) params.set('division', div);
  if(exam) params.set('exam_type', exam);

  const subjName = (subjSel.selectedOptions[0] && subjSel.selectedOptions[0].dataset.name) || 'subject';
  const filename = `marks_${exam || 'all_exams'}_${subjName}_sem${sem}_${batch}${div ? '_div' + div : ''}.${format}`.replace(/[^A-Za-z0-9._-]+/g, '_');

  try{
    const res = await fetch(API_BASE + '/faculty/reports/marks?' + params.toString(), {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
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
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(dlUrl);
  }catch(err){
    alert('Download error: ' + err.message);
  }
}

// ---- Fee Report: Batch -> Semester -> Division (class-level, like the Fees screen - no Subject filter) ----
let facRepFeeSeq = 0;

function populateFacRepFeeBatches(){
  const batchSel = document.getElementById('facRepFeeBatch');
  const years = uniqueSorted((cachedSubjects || []).filter(s => s.semester != null && s.academic_year), 'academic_year').reverse();   // latest batch first
  if(!years.length){
    batchSel.innerHTML = '<option value="">No classes assigned</option>';
    document.getElementById('facRepFeeSem').innerHTML = '<option value="">Select semester</option>';
    document.getElementById('facRepFeeDiv').innerHTML = '<option value="">All divisions</option>';
    document.getElementById('facRepFeeItem').innerHTML = '<option value="">All fee items</option>';
    document.getElementById('facRepFeeHint').textContent = '';
    return;
  }
  const prev = batchSel.value;
  batchSel.innerHTML = years.map(y => `<option value="${escapeAttr(y)}">${escapeAttr(y)}</option>`).join('');
  batchSel.value = years.includes(prev) ? prev : years[0];
  onFacRepFeeBatchChange();
  onFacRepFeeTypeChange();
}

function onFacRepFeeBatchChange(){
  const batch = document.getElementById('facRepFeeBatch').value;
  const semSel = document.getElementById('facRepFeeSem');
  const sems = uniqueSorted((cachedSubjects || []).filter(s => s.academic_year === batch && s.semester != null), 'semester');
  semSel.innerHTML = '<option value="">Select semester</option>' + sems.map(s => `<option value="${s}">Sem ${s}</option>`).join('');
  if(sems.length === 1) semSel.value = String(sems[0]);
  onFacRepFeeSemChange();
}

function onFacRepFeeSemChange(){
  const batch = document.getElementById('facRepFeeBatch').value;
  const sem = document.getElementById('facRepFeeSem').value;
  const divSel = document.getElementById('facRepFeeDiv');
  const divs = new Set();
  if(sem){
    (cachedSubjects || []).forEach(s => {
      if(s.academic_year === batch && String(s.semester) === sem){
        (s.available_divisions || []).forEach(d => divs.add(d));
        if(s.division) divs.add(s.division);
      }
    });
  }
  divSel.innerHTML = '<option value="">All divisions</option>' +
    [...divs].sort().map(d => `<option value="${escapeAttr(d)}">Division ${escapeAttr(d)}</option>`).join('');
  loadFacRepFeeItems();
}

// The fee items are whatever Admin created for that class, so the list is read from the class's own fee records.
async function loadFacRepFeeItems(){
  const batch = document.getElementById('facRepFeeBatch').value;
  const sem = document.getElementById('facRepFeeSem').value;
  const div = document.getElementById('facRepFeeDiv').value;
  const itemSel = document.getElementById('facRepFeeItem');
  const hint = document.getElementById('facRepFeeHint');
  const seq = ++facRepFeeSeq;
  itemSel.innerHTML = '<option value="">All fee items</option>';
  hint.textContent = '';
  if(!batch || !sem) return;
  try{
    let url = '/faculty/fees?semester=' + encodeURIComponent(sem) + '&academic_year=' + encodeURIComponent(batch);
    if(div) url += '&division=' + encodeURIComponent(div);
    const data = await apiRequest(url);
    if(seq !== facRepFeeSeq) return;
    const titles = [...new Set((data.fees || []).map(f => (f.fee_title || '').trim() || 'Untitled'))]
      .sort((a, b) => a.localeCompare(b));
    itemSel.innerHTML = '<option value="">All fee items</option>' +
      titles.map(t => `<option value="${escapeAttr(t)}">${escapeAttr(t)}</option>`).join('');
    if(!titles.length) hint.textContent = 'No fee records for this class yet - Admin has not added fees for it.';
  }catch(err){
    if(seq !== facRepFeeSeq) return;
    hint.textContent = 'Could not load the fee items for this class.';
  }
}

function onFacRepFeeTypeChange(){
  const type = document.getElementById('facRepFeeType').value;
  const statusSel = document.getElementById('facRepFeeStatus');
  // Defaulters always means "unpaid or overdue", so the Status filter is not used there
  if(type === 'defaulters'){ statusSel.value = 'all'; statusSel.disabled = true; }
  else statusSel.disabled = false;
}

async function downloadFacultyFeesReport(format){
  const batch = document.getElementById('facRepFeeBatch').value;
  const sem = document.getElementById('facRepFeeSem').value;
  const div = document.getElementById('facRepFeeDiv').value;
  const item = document.getElementById('facRepFeeItem').value;
  const type = document.getElementById('facRepFeeType').value;
  const status = document.getElementById('facRepFeeStatus').value;

  if(!batch || !sem){
    alert('Select Batch and Semester');
    return;
  }

  const params = new URLSearchParams({ academic_year: batch, semester: sem, format, report: type, status });
  if(div) params.set('division', div);
  if(item) params.set('fee_title', item);

  const filename = `fees_${type}_sem${sem}_${batch}${div ? '_div' + div : ''}.${format}`.replace(/[^A-Za-z0-9._-]+/g, '_');

  try{
    const res = await fetch(API_BASE + '/faculty/reports/fees?' + params.toString(), {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
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
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(dlUrl);
  }catch(err){
    alert('Download error: ' + err.message);
  }
}

// ---- Subject card click -> jump to a class-context view (attendance/students/etc) ----
// Dashboard ke "Mark" buttons (aaj ke lectures + attendance pending) ke liye attendance page ka context.
// Timetable ki lecture kisi khaas division (jaise B) ki hoti hai, par faculty ka assignment "All divisions" ho sakta hai.
// Pehle us assignment ki division khali hone se Division filter "All divisions" par chala jata tha aur saari divisions ke
// students load ho jaate the. Ab lecture ki division filter mein set hoti hai (aur backend ko bhi wahi jati hai).
function facLectureContext(l){
  const subs = cachedSubjects.filter(s => s.subject_id === l.subject_id && String(s.semester) === String(l.semester));
  const sub = subs.find(s => s.division && s.division === l.division) || subs.find(s => !s.division);
  if(!sub) return null;
  return { ...sub, division: sub.division || l.division || '', session_type: l.session_type };
}

function openClass(view, subject){
  window.selectedSubjectContext = subject || null;
  switchView(view);
}

// ---- My Subjects (loaded from backend) ----
let cachedSubjects = [];   // the faculty's assigned subjects (used by both My Subjects and the Students dropdown)
let cachedAllDivisions = [];   // the real divisions (from the students table) of the faculty's semester+batch combos — also useful in the filter for "All divisions" assignments

let facSubjectsSnap = '';
let facSubjectsStruct = '';
// "Structure" = kaun-kaun si subject/division assign hai. avg_attendance / student_count badalna structure change nahi hai.
function facSubjectsStructure(data){
  return (data.subjects || []).map(x => [x.assignment_id, x.academic_year, x.semester, x.subject_id, x.division, x.session_type, (x.available_divisions || []).join('')].join(':')).sort().join('|') + '#' + (data.divisions || []).join(',');
}

// Subject cards ("My Subjects" page) — "N students · X% avg attendance" attendance mark hone par badalta hai
function renderSubjectCards(){
  const grid = document.getElementById('subjectGrid');
  const empty = document.getElementById('subjectGridEmpty');
  if(!grid) return;
  grid.querySelectorAll('.subject-card').forEach(el => el.remove());
  if(cachedSubjects.length === 0){
    if(empty) empty.style.display = 'block';
    return;
  }
  if(empty) empty.style.display = 'none';
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
}

async function loadMySubjects(silent){
  silent = (silent === true);
  const grid = document.getElementById('subjectGrid');
  const empty = document.getElementById('subjectGridEmpty');
  try{
    const data = await apiRequest('/faculty/my-subjects');
    const snap = JSON.stringify(data);
    const struct = facSubjectsStructure(data);
    if(silent){
      if(snap === facSubjectsSnap) return;   // kuch badla nahi
      const structureChanged = struct !== facSubjectsStruct;
      facSubjectsSnap = snap; facSubjectsStruct = struct;
      cachedSubjects = data.subjects || [];
      cachedAllDivisions = data.divisions || [];
      renderDashboardMySubjects();
      renderSubjectCards();
      // Subject/division assign ya hata di gayi: form dropdowns tabhi dobara banao jab faculty dashboard par ho
      // (koi form use mein nahi). Report dropdowns to har baar report panel kholne par naye cachedSubjects se hi bante hain.
      const dash = document.getElementById('view-dashboard');
      if(!(structureChanged && dash && dash.classList.contains('active'))) return;
    }else{
      facSubjectsSnap = snap; facSubjectsStruct = struct;
    }
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
    renderSubjectCards();
  }catch(err){
    if(silent) return;
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
document.addEventListener('DOMContentLoaded', loadFacultyDashboardCharts);
document.addEventListener('DOMContentLoaded', renderDashboardBanner);
document.addEventListener('DOMContentLoaded', loadAttendancePendingDays);
document.addEventListener('DOMContentLoaded', loadCancelledLectures);
document.addEventListener('DOMContentLoaded', refreshFacultyNoticeDot);
document.addEventListener('DOMContentLoaded', loadFacultyProfile);
// ---- Live auto-refresh (page refresh kiye bina admin/students ke updates dikhne ke liye) ----
// Sirf read-only cheezein refresh hoti hain (notices, dashboard, timetable, pending list, marks requests).
// Students / attendance / marks ke form jaan-boojh kar nahi chhede jaate, warna user ka bhara hua data ud jaata.
let facLastBg = 0;
function facBackgroundRefresh(){
  if(document.hidden) return;
  if(Date.now() - facLastBg < 5000) return;
  facLastBg = Date.now();
  refreshFacultyNoticeDot();
  loadFacultyNotices(true);
  loadMySubjects(true);   // subject list + avg attendance; attendance report ke dropdowns isi se bante hain
  // Students page (read-only list) + khula hua student-attendance popup
  const stuView = document.getElementById('view-students');
  if(stuView && stuView.classList.contains('active')) loadFacultyStudents(true);
  const stuAttOv = document.getElementById('stuAttOverlay');
  if(stuAttOv && stuAttOv.classList.contains('open')) loadStudentAttendanceDays(true);
  loadFacultyDashboardSummary();
  const dashView = document.getElementById('view-dashboard');
  if(dashView && dashView.classList.contains('active')) loadFacultyDashboardCharts();   // charts only while the dashboard is open
  loadAttendancePendingDays();
  loadCancelledLectures();
  loadFacultyTimetable();
  loadMyMarksRequests();
  // Attendance form: sirf tab refresh jab page khula ho aur faculty ne koi unsaved click na kiya ho
  // (admin ne attendance edit ki ho to yahan dikh jaaye, bina faculty ke bhare hue marks udaye)
  const attView = document.getElementById('view-attendance');
  if(attView && attView.classList.contains('active') && !facAttDirty && cachedAttendanceAssignmentId) loadFacultyAttendance(true);
}
setInterval(facBackgroundRefresh, 20000);
document.addEventListener('visibilitychange', () => { if(!document.hidden) facBackgroundRefresh(); });
window.addEventListener('focus', facBackgroundRefresh);

let cachedFacultyNotices = [];
let facNoticesSnap = '';

async function loadFacultyNotices(silent){
  const groupList = document.getElementById('facNoticeGroupList');
  if(!groupList) return;
  if(!groupList.children.length) groupList.innerHTML = '<div class="nf-empty" style="padding:18px;">Loading…</div>';
  try{
    const data = await apiRequest('/faculty/notices');
    // background refresh: kuch badla nahi to feed dobara draw na karo (khule/expanded cards collapse ho jaate hain)
    const snap = JSON.stringify(data);
    if(silent === true && snap === facNoticesSnap) return;
    facNoticesSnap = snap;
    cachedFacultyNotices = data.notices || [];
    populateFacultyNoticeSubjectSelect();
    renderFacultyNoticeLists();
  }catch(err){
    if(silent === true) return;   // background refresh fail ho to purani list dikhti rahe
    groupList.innerHTML = '<div class="nf-empty" style="padding:18px;">Notices could not be loaded.</div>';
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
  return formatDMY(d);
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

const NF_CAT_CLASS = { Academic: '', Event: 'event', Important: 'urgent' };

function nfFacScope(n){
  return [n.semester ? 'Sem ' + n.semester : '', n.division ? 'Div ' + n.division : ''].filter(Boolean).join(' · ');
}

// A notice posted by the faculty themselves — "sent bubble" on the right + ✓ / ✓✓ ticks
function nfFacSentCard(n){
  const tagCls = NF_CAT_CLASS[n.category] || '';
  const scope = n.group === 'staff' ? '' : (nfFacScope(n) || 'All classes');
  const seen = (n.seen_count || 0) > 0 || n.admin_seen;
  return `
    <div class="nf-card sent">
      <div class="nf-top">
        <span class="notice-tag ${tagCls}">${nfEsc(n.category || 'Academic')}</span>
        ${scope ? `<span class="nf-scope">${nfEsc(scope)}</span>` : ''}
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
      ${n.file_name ? nfFileChip(n, `nfFacAction('preview', ${n.id})`, `nfFacAction('download', ${n.id})`) : ''}
      <div class="nf-meta">
        ${n.admin_seen ? '<span class="nf-admin-pill" title="Admin has seen this notice">Admin seen</span>' : ''}
        <span>${nfTime(n.created_at)}</span>
        <button class="nf-ticks ${seen ? 'seen' : ''}" onclick="nfFacAction('reads', ${n.id})" title="Seen by">${seen ? '✓✓ ' + (n.seen_count || 0) : '✓ Sent'}</button>
      </div>
    </div>`;
}

// Who sent the notice — "Name" + Admin label for admin, "Prof. Name" + Faculty label for faculty
function nfFacSender(n){
  const name = (n.posted_by_name || '').trim();
  if(!name) return '';
  const isFaculty = n.posted_by_role === 'faculty';
  const label = isFaculty ? 'Prof. ' + name.replace(/^Prof\.?\s*/i, '') : name;
  const roleText = isFaculty ? 'Faculty' : (n.posted_by_role === 'admin' ? 'Admin' : '');
  return `<div class="nf-sender">${nfEsc(label)}${roleText ? ` <small>${roleText}</small>` : ''}</div>`;
}

// A notice from Admin / a personal notice — "received" card on the left
function nfFacReceivedCard(n){
  const tagCls = n.is_personal ? '' : (NF_CAT_CLASS[n.category] || '');
  const scope = nfFacScope(n);
  return `
    <div class="nf-card received ${tagCls ? 'nf-cat-' + tagCls : ''}">
      ${nfFacSender(n)}
      <div class="nf-top">
        <span class="notice-tag ${tagCls}">${n.is_personal ? 'For you' : nfEsc(n.category || 'Academic')}</span>
        ${scope ? `<span class="nf-scope">${nfEsc(scope)}</span>` : ''}
      </div>
      <div class="nf-title">${nfEsc(n.title)}</div>
      ${n.content ? `<div class="nf-body" onclick="nfToggleBody(this)">${nfEsc(n.content)}</div>` : ''}
      ${n.file_name ? nfFileChip(n, `nfFacAction('preview', ${n.id})`, `nfFacAction('download', ${n.id})`) : ''}
      <div class="nf-meta"><span>${nfTime(n.created_at)}</span></div>
    </div>`;
}

// All buttons on the card work by id (so onclick doesn't break when the title has quotes)
function nfFacAction(action, id){
  const n = cachedFacultyNotices.find(x => x.id === id);
  if(!n) return;
  if(action === 'reads') openFacultyNoticeReads(id, n.title);
  else if(action === 'pin') toggleFacultyNoticePin(id, !n.is_pinned);
  else if(action === 'edit') editFacultyNotice(n);
  else if(action === 'delete') deleteFacultyNotice(id, n.title);
  else if(action === 'preview') nfOpenPreview(id, n.file_name);
  else if(action === 'download') downloadFacultyNotice(id, n.file_name);
}

// ---- Notices feed scroll (WhatsApp-style) — for both feeds (posted / received) ----
const NF_SCROLL_BTN = {
  facultyNoticesList: 'facultyNoticesScrollBtn'
};

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
//   staff = "Admin & Faculty"            — faculty and admin can post, students never see it
//   all   = "Students, Faculty & Admin"  — admin broadcasts; READ ONLY for faculty
//   class = "My classes"                 — notices the faculty sent to their own students
// ============================================================
const FAC_NOTICE_GROUPS = {
  staff: { name: 'Admin & Faculty',           sub: 'Staff only — students can’t see this group', icon: '🏫', canPost: true },
  all:   { name: 'Students, Faculty & Admin', sub: 'Announcements — only admin can post here',   icon: '👥', canPost: false },
  class: { name: 'My classes',                sub: 'Notices you send to your students',          icon: '🎓', canPost: true }
};
let facNoticeGroup = null;   // null = the chat list is showing

function facGroupNotices(key){
  return cachedFacultyNotices.filter(n => n.group === key);
}

// "10:30 AM" today, "Yesterday", otherwise "12 Oct 2026" — like the WhatsApp chat list
function nfListTime(iso){
  const label = nfDateLabel(iso);
  return label === 'Today' ? nfTime(iso) : label;
}

function nfFacPreview(n){
  const who = n.can_manage ? 'You' : (n.posted_by_name || '').trim();
  return (who ? who + ': ' : '') + (n.file_name ? '📎 ' : '') + n.title;
}

function renderFacNoticeGroupList(){
  const box = document.getElementById('facNoticeGroupList');
  if(!box) return;
  box.innerHTML = Object.keys(FAC_NOTICE_GROUPS).map(key => {
    const g = FAC_NOTICE_GROUPS[key];
    const list = facGroupNotices(key);
    const last = list.reduce((a, n) => (!a || new Date(n.created_at) > new Date(a.created_at)) ? n : a, null);
    const unread = list.filter(n => !n.is_read && !n.can_manage).length;
    return `
      <button type="button" class="nf-group-row ${unread ? 'unread' : ''}" onclick="openFacNoticeGroup('${key}')">
        <div class="nf-group-avatar">${g.icon}</div>
        <div class="nf-group-main">
          <div class="nf-group-top">
            <span class="nf-group-name">${nfEsc(g.name)}</span>
            <span class="nf-group-time">${last ? nfEsc(nfListTime(last.created_at)) : ''}</span>
          </div>
          <div class="nf-group-bottom">
            <span class="nf-group-preview">${last ? nfEsc(nfFacPreview(last)) : 'No notices yet'}</span>
            ${unread ? `<span class="nf-group-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>
        </div>
      </button>`;
  }).join('');
}

function renderFacNoticeFeed(){
  if(!facNoticeGroup) return;
  const list = facGroupNotices(facNoticeGroup);
  const empty = FAC_NOTICE_GROUPS[facNoticeGroup].canPost
    ? 'No notices here yet — type one below to send it.'
    : 'No notices here yet.';
  nfSetFeedHtml('facultyNoticesList', list.length
    ? nfRenderFeed(list, n => n.can_manage ? nfFacSentCard(n) : nfFacReceivedCard(n))
    : `<div class="nf-empty">${empty}</div>`);
}

function renderFacultyNoticeLists(){
  renderFacNoticeGroupList();
  if(facNoticeGroup){
    renderFacNoticeFeed();
    // a new notice arrived while this group is open -> it is seen right away
    if(!facMarkBusy && facGroupNotices(facNoticeGroup).some(n => !n.is_read && !n.can_manage)) markFacNoticeGroupRead(facNoticeGroup);
  }
}

// Read-only group (the "all" group): no message bar. The staff group has no class / division options.
function applyFacNoticeGroupToComposer(){
  const g = FAC_NOTICE_GROUPS[facNoticeGroup];
  document.getElementById('facNoticeComposer').classList.toggle('hidden', !g.canPost);
  document.getElementById('facNoticeReadonly').classList.toggle('hidden', g.canPost);
  document.getElementById('facNoticeClassOpts').classList.toggle('hidden', facNoticeGroup !== 'class');
  document.getElementById('facNoticeOptions').classList.add('hidden');
  document.getElementById('facNoticeScopeLine').classList.remove('open');
}

function openFacNoticeGroup(key){
  const g = FAC_NOTICE_GROUPS[key];
  if(!g) return;
  facNoticeGroup = key;
  document.getElementById('facNoticeGroupsCard').classList.add('hidden');
  document.getElementById('facNoticeChatCard').classList.remove('hidden');
  document.getElementById('facNoticeChatAvatar').textContent = g.icon;
  document.getElementById('facNoticeChatName').textContent = g.name;
  document.getElementById('facNoticeChatSub').textContent = g.sub;
  applyFacNoticeGroupToComposer();
  if(g.canPost) resetFacultyNoticeForm();
  document.getElementById('facultyNoticesList').innerHTML = '';   // fresh feed -> opens scrolled to the latest notice
  renderFacNoticeFeed();
  nfScrollToBottom('facultyNoticesList', false);
  if(facGroupNotices(key).some(n => !n.is_read && !n.can_manage)) markFacNoticeGroupRead(key);
}

function closeFacNoticeGroup(){
  facNoticeGroup = null;
  nfCloseMenus();
  resetFacultyNoticeForm();
  document.getElementById('facNoticeChatCard').classList.add('hidden');
  document.getElementById('facNoticeGroupsCard').classList.remove('hidden');
  renderFacNoticeGroupList();
}

// Opening a group = the faculty has seen its notices (so the sender's "Seen by" count includes them)
let facMarkBusy = false;
async function markFacNoticeGroupRead(key){
  if(facMarkBusy) return;
  facMarkBusy = true;
  try{
    await apiRequest('/faculty/notices/mark-read', { method: 'POST', body: JSON.stringify({ group: key }) });
    cachedFacultyNotices.forEach(n => { if(n.group === key) n.is_read = true; });
    renderFacNoticeGroupList();
    refreshFacultyNoticeDot();
  }catch(err){
    // silent fail
  }finally{
    facMarkBusy = false;
  }
}

// ---- Notice "seen by" modal (same as the admin panel) ----
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
        <td>${formatDMYTime(r.seen_at)}</td>
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

// ---- Add student (same form and rules as Admin > Student management) ----
const FAC_STU_FIELDS = ['facStuName','facStuEnrollment','facStuEmail','facStuMobile','facStuWhatsapp','facStuSem','facStuDiv','facStuBatch',
                        'facStuFatherName','facStuFatherMobile','facStuMotherName','facStuMotherMobile','facStuParentEmail','facStuParentAddress'];

function resetFacultyAddStudentForm(){
  FAC_STU_FIELDS.forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });   // selects go back to the placeholder
}

function openFacultyAddStudent(){
  resetFacultyAddStudentForm();
  const form = document.getElementById('facAddStudentForm');
  form.classList.remove('hidden');
  requestAnimationFrame(() => {
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('facStuName').focus({ preventScroll: true });
  });
}

function closeFacultyAddStudent(){
  document.getElementById('facAddStudentForm').classList.add('hidden');
}

async function saveFacultyStudent(){
  const val = id => document.getElementById(id).value.trim();
  const payload = {
    name: val('facStuName'),
    enrollment: val('facStuEnrollment'),
    email: val('facStuEmail'),
    mobile: val('facStuMobile'),
    whatsapp_number: val('facStuWhatsapp'),
    department: val('facStuDept'),
    semester: val('facStuSem'),
    division: val('facStuDiv'),
    academic_year: val('facStuBatch'),
    father_name: val('facStuFatherName'),
    father_mobile: val('facStuFatherMobile'),
    mother_name: val('facStuMotherName'),
    mother_mobile: val('facStuMotherMobile'),
    parent_email: val('facStuParentEmail'),
    parent_address: val('facStuParentAddress')
  };

  if(!payload.name || !payload.enrollment){
    alert('Full name and enrollment number are required');
    return;
  }
  if(!payload.semester || !payload.division || !payload.academic_year){
    alert('Please select semester, division and batch');
    return;
  }
  if(payload.mobile && !/^\d{10}$/.test(payload.mobile)){
    alert('Mobile number must be 10 digits');
    return;
  }
  if(payload.father_mobile && !/^\d{10}$/.test(payload.father_mobile)){
    alert("Father's mobile number must be 10 digits");
    return;
  }
  if(payload.mother_mobile && !/^\d{10}$/.test(payload.mother_mobile)){
    alert("Mother's mobile number must be 10 digits");
    return;
  }
  if(payload.whatsapp_number && !/^\d{10,15}$/.test(payload.whatsapp_number)){
    alert('WhatsApp number must be 10-15 digits (with country code if needed)');
    return;
  }

  const btn = document.getElementById('facStuSaveBtn');
  btn.disabled = true;   // double click par ek hi student bane
  try{
    const res = await apiRequest('/faculty/students', { method: 'POST', body: JSON.stringify(payload) });
    alert(`Student added. Default password: ${res.default_password}`);
    closeFacultyAddStudent();
    resetFacultyAddStudentForm();
    loadFacultyStudents();   // refresh the class list so the new student shows up
  }catch(err){
    alert('Error: ' + err.message);
  }finally{
    btn.disabled = false;
  }
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
  const divs = cachedAllDivisions;   // real divisions (from the students table) — also includes the actual divisions inside "All divisions" subjects

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

  // Subjects with "All divisions" (sub.division empty) always show — the Division filter doesn't hide them,
  // because the students of every division come under them (the backend divFilter will narrow them down further)
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
    loadFacultyStudents();   // divFilter may have changed — reload the list for that new division
  } else {
    loadFacultyStudents();   // the earlier selection is no longer valid (the filter got narrower) — clear the list
  }
}

function attendancePillClass(pct){
  if(pct >= 85) return 'good';
  if(pct >= 75) return 'warn';
  return 'bad';
}

let cachedFacultyStudents = [];   // students of the currently loaded class — the search box filters this list

let facStudentsSnap = '';
async function loadFacultyStudents(silent){
  silent = (silent === true);   // background refresh: search box / list / "Loading..." ko nahi chhedta
  const select = document.getElementById('studentsClassSelect');
  const empty = document.getElementById('studentsEmpty');
  const assignmentId = select.value;
  const divFilter = document.getElementById('studentsFilterDiv').value;

  if(silent && !assignmentId) return;
  if(!silent){
    cachedFacultyStudents = [];
    facStudentsSnap = '';
    document.getElementById('studentsSearch').value = '';
  }

  if(!assignmentId){
    renderFacultyStudentsRows();
    empty.textContent = 'Select a class above.';
    empty.style.display = 'block';
    return;
  }

  if(!silent){
    empty.textContent = 'Loading...';
    empty.style.display = 'block';
  }

  try{
    let url = '/faculty/students?assignment_id=' + encodeURIComponent(assignmentId);
    if(divFilter) url += '&division=' + encodeURIComponent(divFilter);
    const data = await apiRequest(url);
    if(silent){
      // fetch ke dauran class badal gayi ya kuch badla hi nahi -> kuch mat karo
      if(select.value !== assignmentId) return;
      const snap = url + '|' + JSON.stringify(data);
      if(snap === facStudentsSnap) return;
      facStudentsSnap = snap;
    }else{
      facStudentsSnap = url + '|' + JSON.stringify(data);
    }
    cachedFacultyStudents = sortByEnrollment(data.students);
    if(cachedFacultyStudents.length === 0){
      empty.textContent = 'There are no students in this class yet.';
      empty.style.display = 'block';
      return;
    }
    renderFacultyStudentsRows();
  }catch(err){
    if(silent) return;
    empty.textContent = 'Students could not be loaded. Try again.';
    empty.style.display = 'block';
  }
}

// Shows the list filtered by the search box (doesn't reload data, only re-renders)
function renderFacultyStudentsRows(){
  const table = document.querySelector('#view-students table');
  const empty = document.getElementById('studentsEmpty');
  const search = (document.getElementById('studentsSearch').value || '').trim().toLowerCase();

  table.querySelectorAll('tr:not(:first-child)').forEach(row => row.remove());

  if(cachedFacultyStudents.length === 0){
    return;   // the "select a class" / "loading" / error message is already set in the empty div
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
      <td><span class="pill ${attendancePillClass(s.attendance_pct)}">${s.attendance_pct}%</span>${s.attendance_need_more > 0 ? `<div style="font-size:11px;color:var(--muted,#5b6b66);margin-top:3px;">needs ${s.attendance_need_more} more</div>` : ''}</td>
      <td>${s.avg_marks}</td>
      <td><button type="button" class="stu-att-nav-btn" onclick="openStudentAttendance(${Number(s.student_id)})" title="See which days this student was present / absent">📅 View</button></td>
    `;
    table.appendChild(row);
  });
}

// ============================================================
// STUDENT DAY-WISE ATTENDANCE — Students page -> "📅 View"
// Ek student ki us subject mein har din ki attendance: kis din Present, kis din Absent
// (/faculty/student-attendance). Popup khula ho to har 20 sec mein apne aap update hota hai.
// ============================================================
const FAC_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const FAC_WEEKDAY_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
let facStuAtt = { assignmentId: null, studentId: null, year: 0, month: 0, data: null, snap: '', jumped: false, selectedDate: null };

function facPad2(n){ return String(n).padStart(2, '0'); }
function facDateLabel(iso){
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : formatDMYWeekday(iso);
}
function facShortDateLabel(iso){
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : formatDMY(iso);
}

async function openStudentAttendance(studentId){
  const assignmentId = document.getElementById('studentsClassSelect').value;
  const stu = cachedFacultyStudents.find(x => Number(x.student_id) === Number(studentId));
  if(!assignmentId || !stu) return;
  const now = new Date();
  facStuAtt = { assignmentId, studentId: Number(studentId), year: now.getFullYear(), month: now.getMonth() + 1, data: null, snap: '', jumped: false, selectedDate: null };
  document.getElementById('stuAttTitle').textContent = `${stu.name} — Attendance`;
  document.getElementById('stuAttSub').textContent = [stu.enrollment, stu.semester ? 'Sem ' + stu.semester : '', stu.division ? 'Div ' + stu.division : ''].filter(Boolean).join(' · ');
  document.getElementById('stuAttSummary').innerHTML = '';
  document.getElementById('stuAttList').innerHTML = '';
  document.getElementById('stuAttAbsentChips').innerHTML = '';
  document.getElementById('stuAttMonthLabel').textContent = `${FAC_MONTH_NAMES[facStuAtt.month - 1]} ${facStuAtt.year}`;
  document.getElementById('stuAttGrid').innerHTML = '<div class="stu-att-empty">Loading…</div>';
  document.getElementById('stuAttOverlay').classList.add('open');
  await loadStudentAttendanceDays(false);
}

function closeStudentAttendance(){
  document.getElementById('stuAttOverlay').classList.remove('open');
  facStuAtt = { assignmentId: null, studentId: null, year: 0, month: 0, data: null, snap: '', jumped: false, selectedDate: null };
}

function changeStudentAttMonth(delta){
  const st = facStuAtt;
  if(!st.studentId) return;
  st.month += delta;
  if(st.month > 12){ st.month = 1; st.year++; }
  if(st.month < 1){ st.month = 12; st.year--; }
  st.selectedDate = null;
  renderStudentAttendanceDays();
}

// Calendar ke kisi din par click: us din ka Lecture / Lab wise status neeche dikhta hai (dubara click = band)
function selectStudentAttDay(dateStr){
  const st = facStuAtt;
  if(!st.studentId) return;
  st.selectedDate = (st.selectedDate === dateStr) ? null : dateStr;
  renderStudentAttendanceDays();
}

async function loadStudentAttendanceDays(silent){
  const st = facStuAtt;
  if(!st.studentId) return;
  try{
    const data = await apiRequest(`/faculty/student-attendance?assignment_id=${encodeURIComponent(st.assignmentId)}&student_id=${encodeURIComponent(st.studentId)}`);
    if(st !== facStuAtt) return;   // popup band ho gaya ya doosra student khul gaya
    const snap = JSON.stringify(data);
    if(silent && snap === st.snap) return;   // kuch badla nahi
    st.snap = snap;
    st.data = data;
    if(!st.jumped){
      // Pehli baar: agar is mahine ka koi record nahi hai to sabse latest record wale mahine par le jao
      st.jumped = true;
      const recs = data.records || [];
      const cur = `${st.year}-${facPad2(st.month)}`;
      if(recs.length && !recs.some(r => r.date.startsWith(cur))){
        const last = recs[recs.length - 1].date;
        st.year = Number(last.slice(0, 4));
        st.month = Number(last.slice(5, 7));
      }
    }
    renderStudentAttendanceDays();
  }catch(err){
    if(silent) return;
    document.getElementById('stuAttGrid').innerHTML = `<div class="stu-att-empty">Attendance could not be loaded: ${escapeHtml(err.message)}</div>`;
  }
}

function renderStudentAttendanceDays(){
  const st = facStuAtt;
  const data = st.data;
  if(!data) return;
  const { year, month } = st;
  const recs = data.records || [];
  const sum = data.summary || { present: 0, absent: 0, total: 0, percentage: 0 };

  document.getElementById('stuAttTitle').textContent = `${data.student.name} — Attendance`;
  document.getElementById('stuAttSub').textContent = [
    data.student.enrollment,
    data.subject && data.subject.subject_name,
    data.student.semester ? 'Sem ' + data.student.semester : '',
    data.student.division ? 'Div ' + data.student.division : ''
  ].filter(Boolean).join(' · ');

  document.getElementById('stuAttSummary').innerHTML = `
    <span class="pill ${attendancePillClass(sum.percentage)}">${sum.percentage}% attendance</span>
    <span class="pill good">Present: ${sum.present}</span>
    <span class="pill bad">Absent: ${sum.absent}</span>
    <span class="pill">Total classes: ${sum.total}</span>`;

  // is mahine ke records, date ke hisaab se
  const monthPrefix = `${year}-${facPad2(month)}-`;
  const monthRecs = recs.filter(r => r.date.startsWith(monthPrefix));
  const byDate = {};
  monthRecs.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });

  document.getElementById('stuAttMonthLabel').textContent = `${FAC_MONTH_NAMES[month - 1]} ${year}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeekday = new Date(year, month - 1, 1).getDay();   // 0 = Sunday
  let html = '<div class="att-cal-weekdays">' + FAC_WEEKDAY_LABELS.map(d => `<div>${d}</div>`).join('') + '</div><div class="att-cal-days">';
  for(let i = 0; i < startWeekday; i++) html += '<div class="att-cal-day empty"></div>';
  for(let d = 1; d <= daysInMonth; d++){
    const dateStr = `${year}-${facPad2(month)}-${facPad2(d)}`;
    const day = byDate[dateStr];
    let cls = 'none', tip = 'No class';
    if(day){
      const anyAbsent = day.some(r => r.status === 'absent');
      const anyPresent = day.some(r => r.status === 'present');
      cls = anyAbsent && anyPresent ? 'mixed' : (anyAbsent ? 'absent' : 'present');
      tip = day.map(r => `${r.session_type}: ${r.status === 'present' ? 'Present' : 'Absent'}`).join(', ');
    }
    const sel = st.selectedDate === dateStr ? ' selected' : '';
    html += day
      ? `<div class="att-cal-day ${cls} has-rec${sel}" title="${escapeHtml(tip)}" onclick="selectStudentAttDay('${dateStr}')">${d}</div>`
      : `<div class="att-cal-day ${cls}" title="${escapeHtml(tip)}">${d}</div>`;
  }
  html += '</div>';
  document.getElementById('stuAttGrid').innerHTML = html;

  // Chuna hua din (ya mixed din apne aap nahi) — us din ka Lecture / Lab wise status
  const detailEl = document.getElementById('stuAttDayDetail');
  const selRecs = st.selectedDate ? byDate[st.selectedDate] : null;
  detailEl.innerHTML = selRecs
    ? `<b>${escapeHtml(facDateLabel(st.selectedDate))}</b>` + selRecs.map(r => `
        <div class="stu-att-row">
          <span>${escapeHtml(r.session_type)}</span>
          <span class="pill ${r.status === 'present' ? 'good' : 'bad'}">${r.status === 'present' ? 'Present' : 'Absent'}</span>
        </div>`).join('')
    : '';

  // is mahine ki list: kis din kya tha
  document.getElementById('stuAttList').innerHTML = monthRecs.length
    ? Object.keys(byDate).sort().map(date => `
        <div class="stu-att-row" style="align-items:flex-start;">
          <span>${escapeHtml(facDateLabel(date))}</span>
          <span style="display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end;">
            ${byDate[date].map(r => `<span class="pill ${r.status === 'present' ? 'good' : 'bad'}">${escapeHtml(r.session_type)}: ${r.status === 'present' ? 'Present' : 'Absent'}</span>`).join('')}
          </span>
        </div>`).join('')
    : '<div class="stu-att-empty">No attendance recorded in this month.</div>';

  // saare absent din (sab mahine mila ke)
  // Poora din absent -> sirf date. Sirf Lecture ya sirf Lab absent -> date ke saath wo session ka naam
  const allByDate = {};
  recs.forEach(r => { (allByDate[r.date] = allByDate[r.date] || []).push(r); });
  const absentChips = Object.keys(allByDate).sort().filter(d => allByDate[d].some(r => r.status === 'absent')).map(d => {
    const day = allByDate[d];
    const absentTypes = day.filter(r => r.status === 'absent').map(r => r.session_type);
    const partial = absentTypes.length < day.length;
    return `<span class="stu-att-chip">${escapeHtml(facShortDateLabel(d))}${partial ? ` <small>(${escapeHtml(absentTypes.join(', '))} only)</small>` : ''}</span>`;
  });
  document.getElementById('stuAttAbsentChips').innerHTML = absentChips.length
    ? `<div class="stu-att-chips">${absentChips.join('')}</div>`
    : '<div class="stu-att-empty">No absent day — present in every recorded class.</div>';
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
  t.checked = saved === null ? true : saved === '1';   // default ON until the user changes it themselves
});

// ---- Attendance marking (backend-connected) ----
// facAttDirty: faculty ne list mein koi Present/Absent click kiya hai jo abhi save nahi hua — tab background refresh list ko nahi chhedta
let facAttDirty = false;
document.addEventListener('click', function(e){
  const btn = e.target.closest('.att-btn');
  if(!btn) return;
  facAttDirty = true;
  const row = btn.closest('.att-toggle');
  row.querySelectorAll('.att-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
});

function markAll(present){
  facAttDirty = true;
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
  const divs = cachedAllDivisions;   // real divisions (from the students table) — also includes the actual divisions inside "All divisions" subjects

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

  // Subjects with "All divisions" (sub.division empty) always show — the Division filter doesn't hide them,
  // because the students of every division come under them (the backend divFilter will narrow them down further)
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
  // A lecture this faculty is SUBSTITUTING (not one of his/her own subjects) - only for that date
  const subCtx = window.substituteCtx;
  if(subCtx && document.getElementById('attDate').value === subCtx.date){
    const opt = document.createElement('option');
    opt.value = 'sub:' + subCtx.timetable_id;
    opt.textContent = subCtx.label;
    select.appendChild(opt);
  }

  // If you came from the My Subjects card (openClass context), auto-select that same class
  if(window.selectedSubjectContext && window.selectedSubjectContext.substitute && window.substituteCtx){
    window.selectedSubjectContext = null;
    const sessionEl = document.getElementById('attSessionType');
    if(sessionEl) sessionEl.value = window.substituteCtx.session_type === 'Lab' ? 'Lab' : 'Lecture';
    select.value = 'sub:' + window.substituteCtx.timetable_id;
    loadFacultyAttendance();
    return;
  }

  if(window.selectedSubjectContext){
    const ctx = window.selectedSubjectContext;
    window.selectedSubjectContext = null;
    document.getElementById('attFilterYear').value = ctx.academic_year || '';
    document.getElementById('attFilterSem').value = ctx.semester || '';
    document.getElementById('attFilterDiv').value = ctx.division || '';
    const sessionEl = document.getElementById('attSessionType');
    if(sessionEl) sessionEl.value = ctx.session_type === 'Lab' ? 'Lab' : 'Lecture';
    populateAttendanceClassSelect();   // the filters changed, rebuild the dropdown with the filtered options
    select.value = ctx.assignment_id;
    loadFacultyAttendance();
    return;
  }

  if(prevValue && filteredSubjects.some(s => String(s.assignment_id) === prevValue)){
    select.value = prevValue;
    loadFacultyAttendance();   // divFilter may have changed — reload the list for that new division
  } else {
    loadFacultyAttendance();   // the earlier selection is no longer valid — clear the list
  }
}

let cachedAttendanceAssignmentId = null;   // assignment_id of the currently loaded class — this is what we send when saving

let facAttSnap = '';
async function loadFacultyAttendance(silent){
  silent = (silent === true);   // background refresh: list clear / "Loading..." / error kuch nahi dikhta
  const select = document.getElementById('attClassSelect');
  const dateInput = document.getElementById('attDate');
  const list = document.getElementById('attendanceList');
  const empty = document.getElementById('attendanceEmpty');
  const title = document.getElementById('attClassTitle');
  const assignmentId = select.value;
  const date = dateInput.value;
  const divFilter = document.getElementById('attFilterDiv').value;
  const sessionType = document.getElementById('attSessionType').value || 'Lecture';

  if(!silent){
    cachedAttendanceAssignmentId = null;
    list.innerHTML = '';
    facAttDirty = false;
    facAttSnap = '';
  }

  if(!assignmentId || !date){
    if(silent) return;
    title.textContent = 'Select a subject and date';
    empty.textContent = 'Select a class and date above.';
    empty.style.display = 'block';
    return;
  }

  const isSub = String(assignmentId).startsWith('sub:');
  const subCtx = isSub ? window.substituteCtx : null;
  const sub = isSub ? null : cachedSubjects.find(s => String(s.assignment_id) === assignmentId);
  const effectiveDivision = isSub ? ((subCtx && subCtx.division) || 'All') : ((sub && sub.division) || divFilter || 'All');
  title.textContent = isSub
    ? (subCtx ? subCtx.label : 'Attendance')
    : (sub ? `Division ${effectiveDivision} · ${sub.subject_name} · ${sessionType}` : 'Attendance');

  if(!silent){
    empty.textContent = 'Loading...';
    empty.style.display = 'block';
  }

  try{
    let url;
    if(isSub){
      // Substitute: identified by the timetable slot + date (this faculty has no assignment for the subject)
      url = '/faculty/attendance?timetable_id=' + encodeURIComponent(String(assignmentId).slice(4)) + '&date=' + encodeURIComponent(date);
    }else{
      url = '/faculty/attendance?assignment_id=' + encodeURIComponent(assignmentId) + '&date=' + encodeURIComponent(date) + '&session_type=' + encodeURIComponent(sessionType);
      // divFilter works only when the assignment itself is "All divisions" — a specific-division assignment ignores it
      if(divFilter) url += '&division=' + encodeURIComponent(divFilter);
    }

    const data = await apiRequest(url);
    if(silent){
      // fetch ke dauran class/date badal gayi, ya faculty ne click kar diya, ya kuch badla hi nahi -> kuch mat karo
      if(facAttDirty || select.value !== assignmentId || dateInput.value !== date) return;
      const snap = url + '|' + JSON.stringify(data);
      if(snap === facAttSnap) return;
      facAttSnap = snap;
    }else{
      facAttSnap = url + '|' + JSON.stringify(data);
    }
    if(data.blocked_message){
      // Timetable mein ye session (jaise Lab) is division ke liye hai hi nahi — list dikhayi hi nahi jati
      cachedAttendanceAssignmentId = null;
      list.innerHTML = '';
      empty.textContent = data.blocked_message;
      empty.style.display = 'block';
      return;
    }
    const students = sortByEnrollment(data.students);
    if(students.length === 0){
      empty.textContent = 'There are no students in this class yet.';
      empty.style.display = 'block';
      return;
    }
    cachedAttendanceAssignmentId = assignmentId;
    empty.style.display = 'none';
    // Not in the timetable? Tell the faculty (saving will ask to confirm it as an Extra session)
    const sessionNote = data.extra ? ' · Extra session' : (data.scheduled === false ? ' · Not in timetable' : '');
    if(isSub){
      if(subCtx) title.textContent = `${subCtx.label} · ${students.length} students`;
    }else if(sub){
      // "All divisions" + no filter: backend limits the list to the timetable's division(s) (e.g. only B) — show that in the title
      const shownDivision = (!sub.division && !divFilter && (data.class_divisions || []).length)
        ? data.class_divisions.join(', ') : effectiveDivision;
      title.textContent = `Division ${shownDivision} · ${sub.subject_name} · ${sessionType}${sessionNote} · ${students.length} students`;
    }
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
    if(silent) return;
    empty.textContent = isSub ? ('Attendance could not be loaded: ' + err.message) : 'Attendance could not be loaded. Try again.';
    empty.style.display = 'block';
  }
}

async function saveFacultyAttendance(isExtra){
  const dateInput = document.getElementById('attDate');
  const saveBtn = document.getElementById('attSaveBtn');
  const date = dateInput.value;
  const sessionType = document.getElementById('attSessionType').value || 'Lecture';

  if(!cachedAttendanceAssignmentId || !date){
    alert('Select a subject and date first.');
    return;
  }

  const records = [];
  document.querySelectorAll('#attendanceList .att-row').forEach(row => {
    const studentId = row.dataset.studentId;
    const activeBtn = row.querySelector('.att-btn.active');
    if(!activeBtn) return;   // this student's status is not set yet
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
      body: JSON.stringify(String(cachedAttendanceAssignmentId).startsWith('sub:')
        ? { timetable_id: String(cachedAttendanceAssignmentId).slice(4), session_type: sessionType, date, records }
        : {
            assignment_id: cachedAttendanceAssignmentId, session_type: sessionType, date, records,
            division: document.getElementById('attFilterDiv').value || '',
            is_extra: isExtra === true
          })
    });
    alert(isExtra === true ? 'Attendance saved as an Extra session.' : 'Attendance saved.');
    loadFacultyAttendance();   // refresh so the title shows "Extra session" if it was one
    refreshAfterSessionChange();   // dashboard ki "attendance pending" list + stats turant update ho
  }catch(err){
    if(err.data && err.data.needs_extra_confirm){
      // Not in the timetable — save only if the faculty confirms it is an Extra session
      if(confirm(err.message + '\n\nIs this an Extra session? Click OK to save the attendance as an Extra session.')){
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save attendance';
        return await saveFacultyAttendance(true);
      }
      return;
    }
    alert('Attendance could not be saved: ' + err.message);
  }finally{
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save attendance';
  }
}

// ---- Floating chat popup ----
function togglePopup(){
  const popup = document.getElementById('popup');
  popup.classList.toggle('hidden');
  if(!popup.classList.contains('hidden')) loadChatHistory();
}

// ---- Chat send (backend-connected — /faculty/assistant) ----
// The reply can come back instantly (FAQ answers) - keep the loading dots visible for a moment so the chat feels natural
function chatMinDelay(startedAt, ms = 800){
  const left = ms - (Date.now() - startedAt);
  return left > 0 ? new Promise(r => setTimeout(r, left)) : Promise.resolve();
}

async function sendChat(inputId, logId){
  const input = document.getElementById(inputId);
  const text = input.value.trim();
  if(!text) return;
  const log = document.getElementById(logId);
  log.insertAdjacentHTML('beforeend', `<div class="msg user">${escapeHtml(text)}</div>`);
  input.value = '';
  log.scrollTop = log.scrollHeight;
  const typingId = 'typing-' + Date.now();
  log.insertAdjacentHTML('beforeend', `<div class="msg bot" id="${typingId}"><span class="typing-dots"><i></i><i></i><i></i></span></div>`);
  log.scrollTop = log.scrollHeight;
  const startedAt = Date.now();
  try{
    const data = await apiRequest('/faculty/assistant', {
      method: 'POST',
      body: JSON.stringify({ message: text })
    });
    await chatMinDelay(startedAt);
    const el = document.getElementById(typingId);
    if(el) el.innerHTML = escapeHtml(data.reply || '...').replace(/\n/g, '<br>');
  }catch(err){
    const el = document.getElementById(typingId);
    if(el) el.textContent = 'Response could not be loaded, try again.';
  }
  log.scrollTop = log.scrollHeight;
}

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
    const when = m.created_at ? formatDMYTime(m.created_at) : '';
    return `<div class="msg user" title="${when}">${escapeHtml(m.message || '')}</div>` +
           `<div class="msg bot" title="${when}">${escapeHtml(m.response || '').replace(/\n/g, '<br>')}</div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
}

async function loadChatHistory(){
  try{
    const items = await apiRequest('/faculty/chat-history');
    ['chatLog', 'popupLog'].forEach(id => renderChatHistory(id, items));
  }catch(err){
    /* history is optional - the chat still works without it */
  }
}

document.addEventListener('DOMContentLoaded', loadChatHistory);

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

// ---- Marks entry (backend-connected) ----
function populateMarksFilters(){
  const yearSelect = document.getElementById('marksFilterYear');
  if(!yearSelect) return;
  const semSelect = document.getElementById('marksFilterSem');
  const divSelect = document.getElementById('marksFilterDiv');

  const prevYear = yearSelect.value, prevSem = semSelect.value, prevDiv = divSelect.value;

  const years = uniqueSorted(cachedSubjects, 'academic_year');
  const sems = uniqueSorted(cachedSubjects, 'semester');
  const divs = cachedAllDivisions;   // real divisions (from the students table) — also includes the actual divisions inside "All divisions" subjects

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

  // Subjects with "All divisions" (sub.division empty) always show — the Division filter doesn't hide them,
  // because the students of every division come under them (the backend divFilter will narrow them down further)
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

let cachedMarksAssignmentId = null;   // assignment_id of the currently loaded class — this is what we send when saving
let cachedMarksRequestStatus = null;  // latest request status of the currently loaded exam — null/pending/approved/rejected/published
let cachedMarksDivision = null;       // the currently loaded division (the division chosen above for an "All divisions" assignment) — sent when saving

let cachedMarksRequests = [];   // My submissions list — cached so that clicking a row can open that class

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

// Clicking a notice in "My submissions" -> the filters below get applied for that same class
// and that same subject/exam opens (same pattern as openClass() from the My Subjects card)
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

  populateMarksClassSelect();   // the dropdown will be rebuilt according to the filters

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
    // For an "All divisions" assignment, send the division chosen above to the backend, so that only that division's
    // students and their request status load correctly (like it works in the Students/Attendance tabs)
    if(divFilter) url += '&division=' + encodeURIComponent(divFilter);
    const data = await apiRequest(url);
    const students = sortByEnrollment(data.students);
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
    if(val === '') return;   // this student's marks are not entered yet
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
    loadFacultyMarks();      // reload the status banner + locked state
    loadMyMarksRequests();   // refresh the "My submissions" list too
  }catch(err){
    alert('Marks could not be submitted: ' + err.message);
  }finally{
    saveBtn.disabled = false;
    saveBtn.textContent = 'Submit for approval';
  }
}

// ============================================================
// FEES ENTRY (same folder flow as Admin's Fee Management:
//   Sem + Division + Batch folder  ->  fee-title sub-folder  ->  student-wise records)
// Faculty only toggles paid/unpaid status; the fee item/amount/due date/payment link stay under Admin's control
// ============================================================
let allFacultyFees = [];          // all fee records (of the faculty's assigned classes) matching the current Batch/Sem/Division filters
let feeFolderList = [];           // [{key, semester, division, academic_year, records}] — the cards currently shown at level 1
let feeTitleList = [];            // [{title, records}] — the cards currently shown at level 2
let openFeeFolderKey = null;
let openFeeTitleKey = null;
let cachedFeesContext = null;     // { semester, academic_year, division } of the opened title-folder — this is what we send when saving
let feesLoadSeq = 0;              // so that an older, slower response never overwrites a newer one
let feesYearDefaulted = false;     // the Batch filter starts on the newest batch (once); after that the faculty's own choice - even "All batches" - is kept

function feeFolderKey(f){
  return `${f.semester ?? '-'}|${f.division || '-'}|${f.academic_year || '-'}`;
}

function feeFolderLabel(f){
  return `Sem ${f.semester ?? '-'} • Div ${f.division || 'All'} • ${f.academic_year || '-'}`;
}

function populateFeesFilters(){
  const yearSelect = document.getElementById('feesFilterYear');
  if(!yearSelect) return;
  const semSelect = document.getElementById('feesFilterSem');
  const divSelect = document.getElementById('feesFilterDiv');

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

  // First time the batches are known: show only the newest batch, so the screen does not load the fee records of every
  // old batch the faculty ever taught (that list grows every year). Older batches are one click away in the Batch filter.
  if(!feesYearDefaulted && years.length){
    feesYearDefaulted = true;
    yearSelect.value = years[years.length - 1];   // uniqueSorted() sorts ascending, so the last one is the newest
  }

  // The folders are built from the same subject list — load them as soon as it is available
  // (if the Fees view is open, or the folders were never loaded yet)
  const feesView = document.getElementById('view-fees');
  if((feesView && feesView.classList.contains('active')) || !allFacultyFees.length){
    if(!feesHasUnsavedChanges()) loadFacultyFees();
  }
}

function feesHasUnsavedChanges(){
  const rows = document.querySelectorAll('#feesTableBody .status-select');
  return Array.from(rows).some(sel => sel.value !== sel.dataset.orig);
}

function feesVisibleList(){
  const q = (document.getElementById('feesSearch')?.value || '').trim().toLowerCase();
  if(!q) return allFacultyFees;
  return allFacultyFees.filter(f =>
    String(f.name ?? '').toLowerCase().includes(q) ||
    String(f.enrollment ?? '').toLowerCase().includes(q) ||
    String(f.fee_title ?? '').toLowerCase().includes(q)
  );
}

function feeStatsHtml(recs){
  const paid = recs.filter(r => r.status === 'paid').length;
  const unpaid = recs.length - paid;
  return `<span class="pill good">${paid} Paid</span><span class="pill bad">${unpaid} Unpaid</span>`;
}

function feeRecordsMeta(recs){
  const total = recs.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  return `${recs.length} record${recs.length === 1 ? '' : 's'} · ₹${total.toLocaleString('en-IN')}`;
}

// Loads the fee records of every semester+batch the faculty is assigned to (respecting the Batch/Sem/Division filters)
// and merges them — the backend itself checks that each class really belongs to this faculty.
async function loadFacultyFees(){
  const grid = document.getElementById('feesFolderGrid');
  if(!grid) return;

  const year = document.getElementById('feesFilterYear').value;
  const sem = document.getElementById('feesFilterSem').value;
  const division = document.getElementById('feesFilterDiv').value;

  const seen = new Set();
  const combos = [];
  (cachedSubjects || []).forEach(s => {
    if(s.semester == null || !s.academic_year) return;
    if(year && s.academic_year !== year) return;
    if(sem && String(s.semester) !== String(sem)) return;
    const k = s.semester + '|' + s.academic_year;
    if(seen.has(k)) return;
    seen.add(k);
    combos.push({ semester: s.semester, academic_year: s.academic_year });
  });

  const seq = ++feesLoadSeq;
  if(!allFacultyFees.length) grid.innerHTML = '<div class="empty-state">Loading...</div>';

  if(!combos.length){
    allFacultyFees = [];
    renderFeesLevels();
    return;
  }

  try{
    const results = await Promise.allSettled(combos.map(c => {
      let url = '/faculty/fees?semester=' + encodeURIComponent(c.semester) + '&academic_year=' + encodeURIComponent(c.academic_year);
      if(division) url += '&division=' + encodeURIComponent(division);
      return apiRequest(url);
    }));
    if(seq !== feesLoadSeq) return;

    const ok = results.filter(r => r.status === 'fulfilled');
    // every request failed -> real error (a single 403 for a division that is not assigned in some class is just skipped)
    if(!ok.length && results.length){
      grid.innerHTML = '<div class="empty-state">Fees could not be loaded. Try again.</div>';
      return;
    }
    allFacultyFees = sortByEnrollment(ok.flatMap(r => r.value.fees || []));
    renderFeesLevels();
  }catch(err){
    if(seq !== feesLoadSeq) return;
    grid.innerHTML = '<div class="empty-state">Fees could not be loaded. Try again.</div>';
  }
}

// Re-draws whichever level is open with the freshly loaded data
function renderFeesLevels(){
  renderFeeFolders();
  if(!openFeeFolderKey) return;
  const hasFolder = allFacultyFees.some(f => feeFolderKey(f) === openFeeFolderKey);
  if(!hasFolder){ closeFeeFolder(true); return; }
  if(openFeeTitleKey){
    const hasTitle = allFacultyFees.some(f => feeFolderKey(f) === openFeeFolderKey && (f.fee_title || 'Untitled') === openFeeTitleKey);
    if(hasTitle){ renderFeeRecords(); return; }
    closeFeeTitleFolder(true);
    return;
  }
  renderFeeTitleFolders();
}

function onFeesSearch(){
  // Folder levels are re-drawn; in the records table rows are only hidden/shown so that unsaved status changes are not lost
  if(openFeeTitleKey){
    const q = (document.getElementById('feesSearch').value || '').trim().toLowerCase();
    document.querySelectorAll('#feesTableBody tr').forEach(tr => {
      tr.style.display = !q || tr.dataset.search.includes(q) ? '' : 'none';
    });
    return;
  }
  renderFeeFolders();
  if(openFeeFolderKey) renderFeeTitleFolders();
}

// ---- Level 1: Sem + Division + Batch folders ----
function renderFeeFolders(){
  const grid = document.getElementById('feesFolderGrid');
  if(!grid) return;
  const list = feesVisibleList();

  if(!list.length){
    feeFolderList = [];
    grid.innerHTML = `<div class="empty-state">${allFacultyFees.length ? 'No fee records match your search.' : "Admin hasn't set up any fee item for your classes yet."}</div>`;
    return;
  }

  const groups = {};
  list.forEach(f => {
    const key = feeFolderKey(f);
    if(!groups[key]) groups[key] = { key, semester: f.semester, division: f.division, academic_year: f.academic_year, records: [] };
    groups[key].records.push(f);
  });
  feeFolderList = Object.values(groups).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

  grid.innerHTML = feeFolderList.map((g, i) => `
    <div class="fee-folder-card" onclick="openFeeFolder(${i})">
      <div class="fee-folder-icon">📁</div>
      <div class="fee-folder-name">${escapeHtml(feeFolderLabel(g))}</div>
      <div class="fee-folder-meta">${feeRecordsMeta(g.records)}</div>
      <div class="fee-folder-stats">${feeStatsHtml(g.records)}</div>
    </div>
  `).join('');
}

function openFeeFolder(index){
  const g = feeFolderList[index];
  if(!g) return;
  openFeeFolderKey = g.key;
  openFeeTitleKey = null;
  renderFeeTitleFolders();
  document.getElementById('feesFolderView').classList.add('hidden');
  document.getElementById('feesRecordsView').classList.add('hidden');
  document.getElementById('feesTitleFolderView').classList.remove('hidden');
}

// ---- Level 2: fee-title sub-folders (e.g. "Tuition Fee", "Exam Fee") ----
function renderFeeTitleFolders(){
  const grid = document.getElementById('feesTitleFolderGrid');
  const records = feesVisibleList().filter(f => feeFolderKey(f) === openFeeFolderKey);
  const first = records[0] || allFacultyFees.find(f => feeFolderKey(f) === openFeeFolderKey);
  document.getElementById('feesTitleFolderHeading').textContent = first ? feeFolderLabel(first) : '';

  if(!records.length){
    feeTitleList = [];
    grid.innerHTML = '<div class="empty-state">No fee records match your search.</div>';
    return;
  }

  const titleGroups = {};
  records.forEach(f => {
    const t = f.fee_title || 'Untitled';
    (titleGroups[t] = titleGroups[t] || []).push(f);
  });
  feeTitleList = Object.keys(titleGroups).sort((a, b) => a.localeCompare(b))
    .map(title => ({ title, records: titleGroups[title] }));

  grid.innerHTML = feeTitleList.map((t, i) => `
    <div class="fee-folder-card" onclick="openFeeTitleFolder(${i})">
      <div class="fee-folder-icon">📁</div>
      <div class="fee-folder-name">${escapeHtml(t.title)}</div>
      <div class="fee-folder-meta">${feeRecordsMeta(t.records)}</div>
      <div class="fee-folder-stats">${feeStatsHtml(t.records)}</div>
    </div>
  `).join('');
}

function openFeeTitleFolder(index){
  const t = feeTitleList[index];
  if(!t) return;
  openFeeTitleKey = t.title;
  renderFeeRecords();
  document.getElementById('feesTitleFolderView').classList.add('hidden');
  document.getElementById('feesRecordsView').classList.remove('hidden');
}

// ---- Level 3: student-wise records (status dropdown per student) ----
function renderFeeRecords(){
  const tbody = document.getElementById('feesTableBody');
  const table = document.getElementById('feesTable');
  const empty = document.getElementById('feesEmpty');
  const saveBtn = document.getElementById('feesSaveBtn');
  const records = allFacultyFees.filter(f => feeFolderKey(f) === openFeeFolderKey && (f.fee_title || 'Untitled') === openFeeTitleKey);
  const first = records[0];

  document.getElementById('feesFolderTitle').textContent =
    (first ? feeFolderLabel(first) + ' • ' : '') + openFeeTitleKey;

  if(!records.length){
    tbody.innerHTML = '';
    table.classList.add('hidden');
    empty.classList.remove('hidden');
    saveBtn.classList.add('hidden');
    cachedFeesContext = null;
    return;
  }

  cachedFeesContext = { semester: first.semester, academic_year: first.academic_year, division: first.division || null };
  table.classList.remove('hidden');
  empty.classList.add('hidden');
  saveBtn.classList.remove('hidden');

  tbody.innerHTML = records.map(f => `
    <tr data-fee-id="${f.fee_id}" data-search="${escapeHtml((String(f.name ?? '') + ' ' + String(f.enrollment ?? '') + ' ' + String(f.fee_title ?? '')).toLowerCase())}">
      <td>${escapeHtml(String(f.enrollment ?? ''))}</td>
      <td>${escapeHtml(String(f.name ?? ''))}</td>
      <td>${f.semester ?? '-'}</td>
      <td>${escapeHtml(String(f.division || '-'))}</td>
      <td>${escapeHtml(String(f.academic_year || '-'))}</td>
      <td>${escapeHtml(String(f.fee_title || '-'))}</td>
      <td>₹${f.amount ?? '-'}</td>
      <td>
        <select class="status-select" data-orig="${f.status}">
          <option value="paid" ${f.status === 'paid' ? 'selected' : ''}>Paid</option>
          <option value="unpaid" ${f.status === 'unpaid' ? 'selected' : ''}>Unpaid</option>
        </select>
      </td>
    </tr>
  `).join('');
  onFeesSearch();   // an active search term also filters the rows of the opened title-folder
}

// Back from the records table to the fee-title sub-folders
function closeFeeTitleFolder(force){
  if(force !== true && feesHasUnsavedChanges() && !confirm('You have unsaved status changes. Go back without saving?')) return;
  openFeeTitleKey = null;
  cachedFeesContext = null;
  document.getElementById('feesRecordsView').classList.add('hidden');
  if(openFeeFolderKey){
    renderFeeTitleFolders();
    document.getElementById('feesTitleFolderView').classList.remove('hidden');
  }else{
    document.getElementById('feesFolderView').classList.remove('hidden');
  }
}

// Back from the sub-folders to the top-level (Sem/Div/Batch) folders
function closeFeeFolder(force){
  if(force !== true && feesHasUnsavedChanges() && !confirm('You have unsaved status changes. Go back without saving?')) return;
  openFeeFolderKey = null;
  openFeeTitleKey = null;
  cachedFeesContext = null;
  document.getElementById('feesRecordsView').classList.add('hidden');
  document.getElementById('feesTitleFolderView').classList.add('hidden');
  document.getElementById('feesFolderView').classList.remove('hidden');
  renderFeeFolders();
}

async function saveFacultyFees(){
  const saveBtn = document.getElementById('feesSaveBtn');
  if(!cachedFeesContext){
    alert('Open a fee folder first.');
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
    // keep the local copy in sync, so that folder counts (Paid/Unpaid) are right when going back
    const byId = {};
    updates.forEach(u => { byId[String(u.fee_id)] = u.status; });
    allFacultyFees.forEach(f => { if(byId[String(f.fee_id)]) f.status = byId[String(f.fee_id)]; });
    document.querySelectorAll('#feesTableBody .status-select').forEach(sel => { sel.dataset.orig = sel.value; });

    saveBtn.textContent = 'Saved ✓';
    setTimeout(() => { saveBtn.textContent = 'Save changes'; saveBtn.disabled = false; }, 1200);
  }catch(err){
    alert('Fee status could not be saved: ' + err.message);
    saveBtn.textContent = 'Save changes';
    saveBtn.disabled = false;
  }
}

// ============================================================
// MATERIALS (study materials of the assigned subject — shared with Admin's `notes` table;
// upload/edit/delete is allowed only on materials they uploaded themselves)
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

let cachedMaterialsAssignmentId = null;   // assignment_id of the currently loaded class — this is what we send when uploading
let cachedMaterialsDivision = null;       // the division chosen above for an "All divisions" assignment — sent with the upload
let cachedMaterialsList = [];             // all materials of the currently loaded subject (the search filter runs on this)

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
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
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
// ASSIGNMENTS (assignments of their assigned subjects — Add/Edit/Delete is allowed only on
// assignments they created themselves, and once a submission has arrived
// that assignment can no longer be edited — only submissions/marks can be reviewed)
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
    // This is an "All divisions" subject — the faculty can choose one specific division if they want
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

function editFacultyAssignmentById(id){
  const a = cachedFacultyAssignments.find(x => x.id === id);
  if(a) editFacultyAssignment(a);
}

function deleteFacultyAssignmentById(id){
  const a = cachedFacultyAssignments.find(x => x.id === id);
  deleteFacultyAssignment(id, a ? a.title : '');
}

function openFacultyAssignmentSubmissionsById(id){
  const a = cachedFacultyAssignments.find(x => x.id === id);
  if(a) openFacultyAssignmentSubmissions(id, a.title, a.can_manage);
}

function editFacultyAssignment(a){
  document.getElementById('facAssignEditId').value = a.id;
  document.getElementById('facAssignTitle').value = a.title;
  document.getElementById('facAssignDueDate').value = a.due_date ? a.due_date.split('T')[0] : '';
  document.getElementById('facAssignDescription').value = a.description || '';
  document.getElementById('facAssignFormTitle').textContent = 'Edit assignment details';
  document.getElementById('facAssignFileField').style.display = 'none';   // editing changes only the details, the attachment is not replaced

  const select = document.getElementById('facAssignSubject');
  select.innerHTML = `<option value="">${escapeHtml(a.subject_name)} · Sem ${a.semester} · Division ${a.division || 'All'} · ${a.academic_year}</option>`;
  select.disabled = true;   // subject/class don't change on edit, only when creating a new assignment
  document.getElementById('facAssignDivisionField').style.display = 'none';

  const locked = a.submission_count > 0;
  document.getElementById('facAssignLockedNote').style.display = locked ? 'block' : 'none';
  document.getElementById('facAssignSaveBtn').disabled = locked;

  const formEl = document.getElementById('facAssignForm');
  formEl.classList.remove('hidden');
  formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('facAssignTitle').focus();
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
      const dueLabel = a.due_date ? formatDMY(a.due_date) : '-';
      const locked = a.submission_count > 0;
      return `
        <tr class="${overdue ? 'tt-low-attendance' : ''}">
          <td>${escapeHtml(a.title)}${a.file_name ? ` <span title="${escapeHtml(a.file_name)}">📎</span>` : ''}</td>
          <td>${escapeHtml(a.subject_name || '-')}</td>
          <td>${a.semester}</td>
          <td>${a.division || 'All'}</td>
          <td>${a.academic_year || '-'}</td>
          <td>${dueLabel}${overdue ? ' ⚠' : ''}</td>
          <td><button class="pill warn" onclick="openFacultyAssignmentSubmissionsById(${a.id})">${a.submission_count} submitted</button></td>
          <td class="row-actions">
            ${a.file_name ? `<button class="icon-action" onclick="downloadFacultyAssignmentFile(${a.id}, '${(a.file_name || '').replace(/'/g, "\\'")}')" title="Download attachment">⬇</button>` : ''}
            ${a.can_manage ? `<button class="icon-action" onclick="editFacultyAssignmentById(${a.id})" title="${locked ? 'A submission has already come in, cannot be edited' : 'Edit'}" ${locked ? 'disabled' : ''}>✎</button>` : ''}
            ${a.can_manage ? `<button class="icon-action danger" onclick="deleteFacultyAssignmentById(${a.id})" title="Delete">🗑</button>` : ''}
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
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
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
    cachedFacultySubmissions = sortByEnrollment(await apiRequest(`/faculty/assignments/${currentFacultySubmissionsAssignmentId}/submissions`));
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
        <td>${submitted ? formatDMY(r.submitted_at) : '-'}</td>
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
// TIMETABLE (read-only — the Regular timetable of all semesters/divisions/batches,
// plus the Mid-Sem and Remedial exam timetables. Only Admin does Add/Edit/Delete.)
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

function facultySessionBadge(slot){
  const type = slot.session_type === 'Lab' ? 'Lab' : 'Lecture';
  return `<em class="tt-type ${type === 'Lab' ? 'is-lab' : 'is-lecture'}">${type}</em>`;
}

function facultyCellContent(slot){
  return `<div class="tt-subject">${escapeHtml(slot.subject_name || '')}</div>` +
    `<div class="tt-session ${slot.session_type === 'Lab' ? 'is-lab' : 'is-lecture'}">${escapeHtml(slot.session_type || 'Lecture')}</div>` +
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

// Mid-Sem / Remedial exams don't repeat day-wise — they happen once, date-wise,
// so instead of a weekly grid we show a simple date-sorted list for them.
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
        <td>${formatDMY(s.exam_date)}</td>
        <td>${formatFacultyRangeLabel(`${s.start_time}-${s.end_time}`)}</td>
        <td>${s.division || 'All'}</td>
        <td>${s.subject_name ? `${escapeHtml(s.subject_name)} (${escapeHtml(s.subject_code || '')})` : '-'}</td>
        <td>${s.room_no || '-'}</td>
      </tr>
    `).join('')}
  `;
}

// ---- Grid helpers — same algorithm as the admin panel: a long slot (e.g. 11:30–1:30 lab) is
// merged with rowspan instead of getting its own duplicate time row. ----
const FAC_LUNCH_START = '13:30';
const FAC_LUNCH_END = '14:00';

function facTimeToMin(value){
  const [h, m] = String(value || '').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function facMinToRange(start, end){
  const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${hhmm(start)}-${hhmm(end)}`;
}

function facBuildSegments(slots){
  const boundaries = new Set();
  slots.forEach(s => {
    boundaries.add(facTimeToMin(s.start_time));
    boundaries.add(facTimeToMin(s.end_time));
  });
  boundaries.add(facTimeToMin(FAC_LUNCH_START));
  boundaries.add(facTimeToMin(FAC_LUNCH_END));
  const sorted = [...boundaries].filter(Number.isFinite).sort((a, b) => a - b);
  const segments = [];
  for(let i = 0; i < sorted.length - 1; i++){
    const start = sorted[i], end = sorted[i + 1];
    if(end > start) segments.push({ start, end, range: facMinToRange(start, end) });
  }
  return segments;
}

function facIsLunchSeg(seg){
  return seg && seg.start === facTimeToMin(FAC_LUNCH_START) && seg.end === facTimeToMin(FAC_LUNCH_END);
}

function facSlotDivisions(s){
  return (s.division || '').split(',').map(x => x.trim()).filter(Boolean);
}

function facSlotForSegment(slots, day, seg, division){
  return slots.find(s =>
    s.day_of_week === day &&
    facTimeToMin(s.start_time) <= seg.start &&
    facTimeToMin(s.end_time) >= seg.end &&
    (!division || facSlotDivisions(s).includes(division))
  ) || null;
}

// Mon–Fri always; Saturday column only if some slot actually falls on Saturday
function facGridDays(slots){
  return FAC_DAY_ORDER.filter(d => d !== 'Sat' || slots.some(s => s.day_of_week === 'Sat'));
}

function renderFacultySingleDivisionGrid(table, slots){
  if(!slots.length){
    table.innerHTML = '<tr><td class="tt-empty-msg">No timetable slot has been created for this semester/division yet.</td></tr>';
    return;
  }

  const days = facGridDays(slots);
  const segments = facBuildSegments(slots);
  let html = '<tr><th class="tt-time-col">Time</th>' + days.map(d => `<th>${FAC_DAY_LABELS[d]}</th>`).join('') + '</tr>';

  segments.forEach((segment, rowIndex) => {
    html += `<tr><td class="tt-time-col">${formatFacultyRangeLabel(segment.range)}</td>`;
    if(facIsLunchSeg(segment)){
      html += `<td class="tt-break-cell" colspan="${days.length}">Lunch Break</td></tr>`;
      return;
    }

    days.forEach(day => {
      const match = facSlotForSegment(slots, day, segment, null);
      if(!match){
        html += '<td class="tt-cell-empty">—</td>';
        return;
      }
      const prevSeg = rowIndex > 0 ? segments[rowIndex - 1] : null;
      const prevMatch = prevSeg && !facIsLunchSeg(prevSeg) ? facSlotForSegment(slots, day, prevSeg, null) : null;
      if(prevMatch && String(prevMatch.id) === String(match.id)) return;   // already covered by the rowspan above

      let span = 1;
      for(let j = rowIndex + 1; j < segments.length; j++){
        if(facIsLunchSeg(segments[j])) break;
        const nextMatch = facSlotForSegment(slots, day, segments[j], null);
        if(nextMatch && String(nextMatch.id) === String(match.id)) span++;
        else break;
      }
      html += `<td class="tt-cell" rowspan="${span}">${facultyCellContent(match)}</td>`;
    });
    html += '</tr>';
  });
  table.innerHTML = html;
}

// All-divisions view: each day has A/B(/C) sub-columns. A slot shared by several divisions is merged
// horizontally (colspan); a long slot is merged vertically (rowspan).
function renderFacultyCombinedDivisionGrid(table, slots){
  if(!slots.length){
    table.innerHTML = '<tr><td class="tt-empty-msg">No timetable slot has been created for this semester yet.</td></tr>';
    return;
  }

  const usedDivisions = new Set();
  slots.forEach(s => facSlotDivisions(s).forEach(d => usedDivisions.add(d)));
  const divisionCols = ['A', 'B', 'C'].filter(d => usedDivisions.has(d));
  if(!divisionCols.length) divisionCols.push('A', 'B');

  const days = facGridDays(slots);
  const segments = facBuildSegments(slots);
  let html = '<tr><th class="tt-time-col" rowspan="2">Time</th>' +
    days.map(d => `<th colspan="${divisionCols.length}">${FAC_DAY_LABELS[d]}</th>`).join('') + '</tr>';
  html += '<tr>' + days.map(() => divisionCols.map(d => `<th class="tt-div-subhead">${d}</th>`).join('')).join('') + '</tr>';

  segments.forEach((segment, rowIndex) => {
    html += `<tr><td class="tt-time-col">${formatFacultyRangeLabel(segment.range)}</td>`;
    if(facIsLunchSeg(segment)){
      html += `<td class="tt-break-cell" colspan="${days.length * divisionCols.length}">Lunch Break</td></tr>`;
      return;
    }

    days.forEach(day => {
      let i = 0;
      while(i < divisionCols.length){
        const div = divisionCols[i];
        const match = facSlotForSegment(slots, day, segment, div);
        if(!match){
          html += '<td class="tt-cell-empty">—</td>';
          i++;
          continue;
        }

        const prevSeg = rowIndex > 0 ? segments[rowIndex - 1] : null;
        const prevMatch = prevSeg && !facIsLunchSeg(prevSeg) ? facSlotForSegment(slots, day, prevSeg, div) : null;
        if(prevMatch && String(prevMatch.id) === String(match.id)){
          i++;
          continue;
        }

        let colspan = 1;
        while(i + colspan < divisionCols.length){
          const nextMatch = facSlotForSegment(slots, day, segment, divisionCols[i + colspan]);
          if(nextMatch && String(nextMatch.id) === String(match.id)) colspan++;
          else break;
        }

        let rowspan = 1;
        for(let j = rowIndex + 1; j < segments.length; j++){
          if(facIsLunchSeg(segments[j])) break;
          let same = true;
          for(let k = 0; k < colspan; k++){
            const nextMatch = facSlotForSegment(slots, day, segments[j], divisionCols[i + k]);
            if(!nextMatch || String(nextMatch.id) !== String(match.id)){ same = false; break; }
          }
          if(same) rowspan++;
          else break;
        }

        const combinedClass = colspan > 1 ? ' tt-cell-combined' : '';
        html += `<td class="tt-cell${combinedClass}" colspan="${colspan}" rowspan="${rowspan}">${facultyCellContent(match)}</td>`;
        i += colspan;
      }
    });
    html += '</tr>';
  });

  table.innerHTML = html;
}

// ============================================================
// NOTICES — posting a notice to their own assigned class (same pattern as Assignments:
// Add/Edit/Delete/Pin is allowed only on notices they posted themselves)
// ============================================================
function populateFacultyNoticeSubjectSelect(){
  const select = document.getElementById('facNoticeSubject');
  if(!select) return;
  if(document.getElementById('facNoticeEditId').value) return;   // while editing, the class is fixed — don't rebuild it in a background refresh
  const prevClass = select.value;
  const prevDivision = document.getElementById('facNoticeDivision').value;
  select.innerHTML = cachedSubjects.map(sub =>
    `<option value="${sub.assignment_id}">${escapeHtml(sub.subject_name)} · Sem ${sub.semester} · Division ${sub.division || 'All'} · ${sub.academic_year}</option>`
  ).join('') || '<option value="">No subject assigned</option>';
  // keep the class they had chosen while typing (a refresh must not reset it)
  if(prevClass && [...select.options].some(o => o.value === prevClass)) select.value = prevClass;
  onFacNoticeSubjectChange();
  const divSelect = document.getElementById('facNoticeDivision');
  if(prevDivision && [...divSelect.options].some(o => o.value === prevDivision)){
    divSelect.value = prevDivision;
    updateFacNoticeScopeLine();
  }
}

function onFacNoticeSubjectChange(){
  const select = document.getElementById('facNoticeSubject');
  const divField = document.getElementById('facNoticeDivisionField');
  const divSelect = document.getElementById('facNoticeDivision');
  if(!select || !select.value){
    divField.style.display = 'none';
    updateFacNoticeScopeLine();
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
  updateFacNoticeScopeLine();
}

// "To: Maths · Sem 3 · Division A · 2025-26 · Academic" — always visible above the bar
function updateFacNoticeScopeLine(){
  const parts = [];
  if(facNoticeGroup === 'staff'){
    parts.push('Admin & Faculty');
  }else{
    const select = document.getElementById('facNoticeSubject');
    const opt = select.options[select.selectedIndex];
    parts.push(opt ? opt.text : 'your class');
    const div = document.getElementById('facNoticeDivision').value;
    if(div && document.getElementById('facNoticeDivisionField').style.display !== 'none') parts.push('Div ' + div);
  }
  parts.push(document.getElementById('facNoticeCategory').value);
  document.getElementById('facNoticeScopeText').textContent = 'To: ' + parts.join(' · ');
}

function toggleFacNoticeOptions(){
  const box = document.getElementById('facNoticeOptions');
  box.classList.toggle('hidden');
  document.getElementById('facNoticeScopeLine').classList.toggle('open', !box.classList.contains('hidden'));
}

// ---- message-bar helpers (same as the admin panel) ----
const NFC_MAX_TITLE = 150;   // notices.title is VARCHAR(150)

function nfcAutoGrow(el){
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// Enter = send, Shift+Enter = new line (on phones Enter stays a new line, the ➤ button sends)
function nfcKeyDown(e){
  if(e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.innerWidth > 860){
    e.preventDefault();
    saveFacultyNotice();
  }
}

// First line = title, the rest = body
function nfcSplitMessage(text){
  const lines = text.split('\n');
  const first = lines[0].trim();
  const rest = lines.slice(1).join('\n').trim();
  if(first.length <= NFC_MAX_TITLE) return { title: first, content: rest };
  return { title: first.slice(0, NFC_MAX_TITLE - 1).trimEnd() + '…', content: text };
}

let nfcThumbUrl = null;
function nfcRenderFilePreview(){
  const box = document.getElementById('facNoticeAttachPreview');
  const file = document.getElementById('facNoticeFile').files[0];
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
  const input = document.getElementById('facNoticeFile');
  const file = input.files[0];
  if(file && file.size > 10 * 1024 * 1024){
    alert('File is larger than 10MB, upload a smaller file');
    input.value = '';
  }
  nfcRenderFilePreview();
  document.getElementById('facNoticeMessage').focus();
}

function nfcClearFile(){
  document.getElementById('facNoticeFile').value = '';
  nfcRenderFilePreview();
}

// Bar back to its defaults after send / cancel edit (the chosen class stays, so they can post again to the same class)
function resetFacultyNoticeForm(){
  document.getElementById('facNoticeEditId').value = '';
  const box = document.getElementById('facNoticeMessage');
  box.value = '';
  nfcAutoGrow(box);
  document.getElementById('facNoticeCategory').value = 'Academic';
  document.getElementById('facNoticeDivision').value = '';
  document.getElementById('facNoticeFile').value = '';
  document.getElementById('facNoticeEditBanner').classList.add('hidden');
  document.getElementById('facNoticeAttachBtn').classList.remove('hidden');
  document.getElementById('facNoticeSubject').disabled = false;
  const send = document.getElementById('facNoticeSaveBtn');
  send.textContent = '➤';
  send.title = 'Send notice';
  nfcRenderFilePreview();
  populateFacultyNoticeSubjectSelect();
}

function cancelFacultyNoticeEdit(){
  resetFacultyNoticeForm();
}

// Edit = the message goes back into the bar (title on the first line, body below it)
function editFacultyNotice(n){
  document.getElementById('facNoticeEditId').value = n.id;
  const box = document.getElementById('facNoticeMessage');
  box.value = n.content ? n.title + '\n' + n.content : n.title;
  document.getElementById('facNoticeCategory').value = n.category || 'Academic';
  document.getElementById('facNoticeFile').value = '';
  nfcRenderFilePreview();
  document.getElementById('facNoticeAttachBtn').classList.add('hidden');   // the attachment is not changed on edit
  document.getElementById('facNoticeEditText').textContent = '✎ Editing notice' + (n.file_name ? ' · attachment can’t be changed' : '');
  document.getElementById('facNoticeEditBanner').classList.remove('hidden');

  const select = document.getElementById('facNoticeSubject');
  select.innerHTML = `<option value="">Sem ${n.semester} · Division ${n.division || 'All'}</option>`;
  select.disabled = true;
  document.getElementById('facNoticeDivisionField').style.display = 'none';

  const send = document.getElementById('facNoticeSaveBtn');
  send.textContent = '✓';
  send.title = 'Save changes';
  updateFacNoticeScopeLine();
  nfcAutoGrow(box);
  box.focus();
}

let nfcSending = false;
async function saveFacultyNotice(){
  if(nfcSending) return;
  if(facNoticeGroup !== 'staff' && facNoticeGroup !== 'class') return;   // the "all" group is read-only for faculty
  const isStaff = facNoticeGroup === 'staff';
  const editId = document.getElementById('facNoticeEditId').value;
  const box = document.getElementById('facNoticeMessage');
  const text = box.value.trim();
  const category = document.getElementById('facNoticeCategory').value;
  const file = document.getElementById('facNoticeFile').files[0];

  let { title, content } = nfcSplitMessage(text);
  // Only a file, no text -> the file name becomes the title
  if(!editId && !title && file){
    title = file.name.length > NFC_MAX_TITLE ? file.name.slice(0, NFC_MAX_TITLE - 1) + '…' : file.name;
    content = '';
  }
  if(!title){
    alert('Type a notice first');
    box.focus();
    return;
  }

  const send = document.getElementById('facNoticeSaveBtn');
  try{
    if(editId){
      nfcSending = true;
      send.disabled = true;
      await apiRequest(`/faculty/notices/${editId}`, {
        method: 'PUT',
        body: JSON.stringify({ title, content, category })
      });
    }else{
      const assignmentId = document.getElementById('facNoticeSubject').value;
      if(!isStaff && !assignmentId){
        alert('Select a class');
        return;
      }
      if(file && file.size > 10 * 1024 * 1024){
        alert('File is larger than 10MB, upload a smaller file');
        return;
      }
      nfcSending = true;
      send.disabled = true;
      const formData = new FormData();
      formData.append('group', facNoticeGroup);   // 'staff' or 'class' — the server decides who can see it
      formData.append('title', title);
      formData.append('content', content);
      formData.append('category', category);
      if(!isStaff){
        formData.append('assignment_id', assignmentId);
        const division = document.getElementById('facNoticeDivision').value;
        if(division) formData.append('division', division);
      }
      if(file) formData.append('file', file);
      await apiUpload('/faculty/notices', formData);
    }
    resetFacultyNoticeForm();
    await loadFacultyNotices();
    if(!editId) nfScrollToBottom('facultyNoticesList');   // their own new notice should show at the bottom
  }catch(err){
    alert('Error: ' + err.message);   // the typed message stays in the box so nothing is lost
  }finally{
    nfcSending = false;
    send.disabled = false;
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

// ============================================================
// NOTICE ATTACHMENT PREVIEW (WhatsApp-style)
// Image (jpg/png) -> shown inline in the notice card, click = full-screen view
// PDF             -> card with a Preview button (opens in a viewer popup) + Download
// Word / PowerPoint -> a browser cannot display these, so they stay download-only
// Files are fetched with the login token and shown through blob URLs (an <img src>
// cannot send the Authorization header). Images load lazily when the card scrolls
// into view, and every loaded image is cached so the 5-sec refresh doesn't reload it.
// ============================================================
const NF_TOKEN_KEY = 'token_faculty';
const NF_ENDPOINT = '/faculty/notices';
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
  if(kind === 'file'){ downloadFacultyNotice(id, fileName); return; }

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
  document.getElementById('nfViewerDl').onclick = () => downloadFacultyNotice(id, fileName);

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

async function downloadFacultyNotice(id, fileName){
  try{
    const res = await fetch(API_BASE + `/faculty/notices/${id}/download`, {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token_faculty') }
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
    if(dot){
      dot.textContent = count > 99 ? '99+' : (hasUnread ? count : '');
      dot.classList.toggle('show', hasUnread);
    }
    if(topbarDot){
      topbarDot.textContent = count > 99 ? '99+' : (hasUnread ? count : '');
      topbarDot.classList.toggle('show', hasUnread);
    }
  }catch(err){
    // silent fail — just let the dot stay in its old state
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

  const menuMatches = getMenuMatches(q);

  const subjectMatches = cachedSubjects.filter(s =>
    s.subject_name.toLowerCase().includes(q) || (s.subject_code || '').toLowerCase().includes(q)
  ).slice(0, 5);

  const studentMatches = (cachedFacultyStudents || []).filter(s =>
    (s.name || '').toLowerCase().includes(q) || (s.enrollment || '').toLowerCase().includes(q)
  ).slice(0, 5);

  if(menuMatches.length === 0 && subjectMatches.length === 0 && studentMatches.length === 0){
    resultsEl.innerHTML = '<div class="topbar-search-empty">Nothing found</div>';
    resultsEl.classList.add('open');
    return;
  }

  let html = menuSearchHtml(menuMatches);
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
// DASHBOARD (welcome banner, stat cards, today's lectures, my subjects mini-grid — all from real data)
// ============================================================
function renderDashboardBanner(){
  const nameEl = document.getElementById('dashBannerName');
  const eyebrowEl = document.getElementById('dashBannerEyebrow');
  if(!nameEl) return;

  const name = sessionStorage.getItem('name_faculty') || 'Faculty';
  nameEl.textContent = `Welcome, Prof. ${name}`;

  const now = new Date();
  const dateLabel = `${now.toLocaleDateString('en-IN', { weekday: 'long' })}, ${formatDMY(now)}`;
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

// The line in the banner: "which lecture is running right now / which one is next"
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
  const where = l => `${l.subject_name} (${l.session_type || 'Lecture'}) · Sem ${l.semester}${l.division ? ' · Div ' + l.division : ''}${l.room_no ? ' · ' + l.room_no : ''}`;
  if(ongoing) el.textContent = `Now: ${where(ongoing)} (till ${formatFacultyTime12(ongoing.end_time)})`;
  else if(next) el.textContent = `Next lecture: ${where(next)} at ${formatFacultyTime12(next.start_time)}`;
  else el.textContent = 'All lectures are done for today.';
}

// Dashboard charts: attendance % per assigned class + assignment submissions checked vs to check (shared/charts.js)
async function loadFacultyDashboardCharts(){
  const attEl = document.getElementById('facAttendanceChart');
  const subEl = document.getElementById('facSubmissionChart');
  if(!attEl || !subEl || !window.SHCharts) return;
  try{
    const data = await apiRequest('/faculty/dashboard-charts');

    SHCharts.columns(attEl, (data.attendance_by_class || []).map(c => ({
      label: `${c.subject_code || c.subject_name} · S${c.semester}${c.division ? c.division : ''}`,
      title: `${c.subject_name} — Sem ${c.semester}${c.division ? ' Div ' + c.division : ''} (${c.total} records)`,
      value: c.percentage
    })), { max: 100, unit: '%', threshold: 75, label: 'Attendance percentage by class', empty: 'Attendance has not been marked yet.' });

    const s = data.submissions || { to_check: 0, checked: 0 };
    const all = (s.to_check || 0) + (s.checked || 0);
    SHCharts.donut(subEl, [
      { label: 'Checked',  value: s.checked || 0,  color: SHCharts.colors.good },
      { label: 'To check', value: s.to_check || 0, color: SHCharts.colors.warn }
    ], { center: all ? Math.round((s.checked || 0) * 100 / all) + '%' : '', sub: 'checked', label: 'Assignment submissions checked versus to check', empty: 'No submissions received yet.' });
  }catch(err){
    // a failed background refresh must not wipe a chart that is already drawn
    if(!attEl.dataset.shSig) SHCharts.message(attEl, 'Chart could not be loaded.');
    if(!subEl.dataset.shSig) SHCharts.message(subEl, 'Chart could not be loaded.');
  }
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
      const todayStr = new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD (local)
      let markBtn;
      if(l.is_substitute){
        // This faculty is substituting another faculty's lecture today
        markBtn = l.session_status === 'holiday'
          ? `<button class="tt-action done" disabled>Holiday${l.status_note ? ' · ' + escapeHtml(l.status_note) : ''}</button>`
          : (l.attendance_marked
              ? `<button class="tt-action done" disabled>Marked</button>`
              : `<button class="tt-action" onclick='openSubstituteAttendance(${JSON.stringify(l)}, "${todayStr}")'>Mark</button>`);
      }else if(l.session_status === 'holiday'){
        markBtn = `<button class="tt-action done" disabled>Holiday${l.status_note ? ' · ' + escapeHtml(l.status_note) : ''}</button>`;
      }else if(l.session_status === 'cancelled'){
        markBtn = `<button class="tt-action done" disabled>Cancelled${l.status_note ? ' · ' + escapeHtml(l.status_note) : ''}</button>
                   <button class="tt-action" onclick="uncancelLecture(${l.id}, '${todayStr}')">Undo</button>`;
      }else if(l.session_status === 'substituted'){
        markBtn = `<button class="tt-action done" disabled>Substitute${l.status_note ? ' · ' + escapeHtml(l.status_note) : ''}</button>
                   <button class="tt-action" onclick="unsubstituteLecture(${l.id}, '${todayStr}')">Undo</button>`;
      }else if(l.attendance_marked){
        markBtn = `<button class="tt-action done" disabled>Marked</button>`;
      }else{
        markBtn = `<button class="tt-action" onclick='openClass("attendance", ${JSON.stringify(facLectureContext(l))})'>Mark</button>
                   <button class="tt-action" onclick="cancelLecture(${l.id}, '${todayStr}')">Cancel</button>
                   <button class="tt-action" onclick="openSubstituteDialog(${l.id}, '${todayStr}')">Substitute</button>`;
      }
      return `
        <div class="tt-row">
          <div class="tt-bar ${barClasses[i % barClasses.length]}"></div>
          <div class="tt-time"><b>${formatFacultyTime12(l.start_time)}</b><span>${formatFacultyTime12(l.end_time)}</span></div>
          <div class="tt-info"><b>${escapeHtml(l.subject_name)} ${facultySessionBadge(l)}</b><span>Sem ${l.semester} · Division ${l.division || 'All'} · ${l.room_no ? escapeHtml(l.room_no) : 'Room TBA'}${l.is_substitute ? ' · Substitute for ' + escapeHtml(l.substitute_for || 'another faculty') : ''}</span></div>
          ${markBtn}
        </div>
      `;
    }).join('');
  }catch(err){
    lecturesEl.innerHTML = `<div class="empty-state">Dashboard could not be loaded: ${err.message}</div>`;
  }
}

// Dashboard lists (Attendance pending / Cancelled lectures): sirf pehli 5 rows dikhao, uske baad scroll bar.
// Rows ki height alag-alag hoti hai (text wrap, multiple lectures), isliye 5th row ke bottom tak ka
// exact height measure karke max-height set karte hain.
const DASH_LIST_VISIBLE_ROWS = 5;
function limitDashListRows(container, maxRows = DASH_LIST_VISIBLE_ROWS){
  if(!container) return;
  container.classList.add('dash-scroll-list');
  container.style.maxHeight = '';
  const rows = Array.from(container.children).filter(el => !el.classList.contains('empty-state'));
  if(rows.length <= maxRows){ container.style.maxHeight = 'none'; container.style.overflowY = ''; return; }
  const top = rows[0].getBoundingClientRect().top;
  const bottom = rows[maxRows - 1].getBoundingClientRect().bottom;
  const h = Math.ceil(bottom - top);
  if(h > 0){
    container.style.maxHeight = h + 'px';
    container.style.overflowY = 'auto';
  }
  // h === 0 => dashboard abhi hidden hai; CSS ka fallback max-height lagega, aur dashboard khulne par dobara measure hoga.
}
function relimitDashLists(){
  limitDashListRows(document.getElementById('dashAttendancePendingList'));
  limitDashListRows(document.getElementById('dashCancelledList'));
}
window.addEventListener('resize', relimitDashLists);

// "Attendance pending" card — a date-wise list of the dates in the last 14 days whose attendance
// has not been marked yet (the today stat-card shows only today's count,
// this card shows the whole backlog)
async function loadAttendancePendingDays(){
  const container = document.getElementById('dashAttendancePendingList');
  if(!container) return;
  try{
    const data = await apiRequest('/faculty/attendance-pending-days');
    const days = data.pending_days || [];

    if(!days.length){
      container.innerHTML = '<div class="empty-state">All caught up — no pending attendance in the last two weeks. ✅</div>';
      return;
    }

    container.innerHTML = days.map(day => {
      const d = new Date(day.date + 'T00:00:00');
      const dateLabel = formatDMY(day.date);
      const lecturesHtml = day.lectures.map(l => {
        const matchingSub = cachedSubjects.find(s => s.subject_id === l.subject_id && String(s.semester) === String(l.semester) && (s.division === l.division || !s.division));
        if(l.is_substitute){
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:5px 0;">
              <span style="font-size:12.5px;"><b>${escapeHtml(l.subject_name)}</b> ${facultySessionBadge(l)} · Sem ${l.semester} · Div ${l.division || 'All'} · ${formatFacultyTime12(l.start_time)}
                <span style="color:var(--muted);"> — Substitute for ${escapeHtml(l.substitute_for || 'another faculty')}</span></span>
              <span style="display:flex; gap:6px;">
                <button class="tt-action" onclick='openSubstituteAttendance(${JSON.stringify(l)}, "${day.date}")'>Mark</button>
              </span>
            </div>
          `;
        }
        return `
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:5px 0;">
            <span style="font-size:12.5px;"><b>${escapeHtml(l.subject_name)}</b> ${facultySessionBadge(l)} · Sem ${l.semester} · Div ${l.division || 'All'} · ${formatFacultyTime12(l.start_time)}</span>
            <span style="display:flex; gap:6px;">
              <button class="tt-action" onclick='openAttendanceForDate(${JSON.stringify(facLectureContext(l))}, "${day.date}")'>Mark</button>
              <button class="tt-action" onclick="cancelLecture(${l.timetable_id}, '${day.date}')">Cancel</button>
              <button class="tt-action" onclick="openSubstituteDialog(${l.timetable_id}, '${day.date}')">Substitute</button>
            </span>
          </div>
        `;
      }).join('');
      return `
        <div class="tt-row" style="align-items:flex-start;">
          <div class="tt-bar bar3"></div>
          <div class="tt-time"><b>${day.day_name}</b><span>${dateLabel}</span></div>
          <div class="tt-info">${lecturesHtml}</div>
        </div>
      `;
    }).join('');
    limitDashListRows(container);
  }catch(err){
    container.innerHTML = `<div class="empty-state">Pending attendance could not be loaded: ${err.message}</div>`;
  }
}

// Cancel a lecture that did not happen (meeting, leave, ...). It is then NOT counted as a held class
// and disappears from "Attendance pending". Students' percentage is not affected.
const CANCEL_REASONS = ['Meeting', 'Faculty leave', 'Substitute unavailable', 'Other'];
async function cancelLecture(timetableId, date){
  const choice = prompt('Why was this lecture not held?\n1 = Meeting\n2 = Faculty leave\n3 = Substitute unavailable\n4 = Other\n\nEnter 1-4:', '1');
  if(choice === null) return;
  const reason = CANCEL_REASONS[parseInt(choice, 10) - 1];
  if(!reason){ alert('Please enter a number from 1 to 4.'); return; }
  try{
    await apiRequest('/faculty/session-cancel', {
      method: 'POST',
      body: JSON.stringify({ timetable_id: timetableId, date, reason })
    });
    loadAttendancePendingDays();
    loadCancelledLectures();
    if(typeof loadFacultyDashboardSummary === 'function') loadFacultyDashboardSummary();
  }catch(err){
    alert(err.message);
  }
}

async function uncancelLecture(timetableId, date){
  if(!confirm('Undo the cancellation? The lecture will count as held again.')) return;
  try{
    await apiRequest('/faculty/session-uncancel', {
      method: 'POST',
      body: JSON.stringify({ timetable_id: timetableId, date })
    });
    loadAttendancePendingDays();
    loadCancelledLectures();
    if(typeof loadFacultyDashboardSummary === 'function') loadFacultyDashboardSummary();
  }catch(err){
    alert(err.message);
  }
}

// Leave known in advance: cancels all of this faculty's lectures/labs in the date range (today or later).
// Students see them in advance under "Upcoming changes".
async function markFacultyLeave(){
  const from_date = document.getElementById('leaveFrom').value;
  const to_date = document.getElementById('leaveTo').value || from_date;
  const reason = document.getElementById('leaveReason').value;
  if(!from_date){ alert('Select the From date.'); return; }
  if(!confirm(`Cancel all your lectures/labs from ${formatDMY(from_date)} to ${formatDMY(to_date)} (${reason})? Students will be able to see this.`)) return;
  try{
    const res = await apiRequest('/faculty/leave', {
      method: 'POST',
      body: JSON.stringify({ from_date, to_date, reason })
    });
    alert(res.message);
    loadCancelledLectures();
    loadAttendancePendingDays();
    if(typeof loadFacultyDashboardSummary === 'function') loadFacultyDashboardSummary();
  }catch(err){
    alert(err.message);
  }
}

// "Cancelled lectures" card — every lecture/lab this faculty cancelled (last 60 days + upcoming),
// with an Undo button. Undo makes the lecture count as held again (it shows up in "Attendance pending").
async function loadCancelledLectures(){
  const container = document.getElementById('dashCancelledList');
  if(!container) return;
  try{
    const rows = await apiRequest('/faculty/cancelled-sessions');
    let subs = { given: [], taking: [] };
    try{ subs = await apiRequest('/faculty/substituted-sessions'); }catch(e){ /* the cancelled list still works */ }
    const fmtDate = ds => formatDMYWeekday(ds);
    const givenHtml = (subs.given || []).map(r => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--line);">
          <span style="font-size:12.5px;">
            <b>${escapeHtml(r.subject_name || '')}</b> ${facultySessionBadge(r)} · Sem ${r.semester} · Div ${escapeHtml(r.division || 'All')}
            · ${fmtDate(r.session_date)} · ${formatFacultyTime12(r.start_time)}
            <span style="color:var(--muted);"> — Substitute: ${escapeHtml(r.substitute_name || '')}</span>
          </span>
          <button class="tt-action" onclick="unsubstituteLecture(${r.timetable_id}, '${r.session_date}')">Undo</button>
        </div>`).join('');
    const takingHtml = (subs.taking || []).map(r => `
        <div style="padding:8px 0; border-bottom:1px solid var(--line); font-size:12.5px;">
          <b>${escapeHtml(r.subject_name || '')}</b> ${facultySessionBadge(r)} · Sem ${r.semester} · Div ${escapeHtml(r.division || 'All')}
          · ${fmtDate(r.session_date)} · ${formatFacultyTime12(r.start_time)}
          <span style="color:var(--muted);"> — You are the substitute for ${escapeHtml(r.original_faculty_name || 'another faculty')}</span>
        </div>`).join('');
    if(!rows.length && !givenHtml && !takingHtml){
      container.innerHTML = '<div class="empty-state">No cancelled or substituted lectures.</div>';
      return;
    }
    const cancelledHtml = rows.map(r => {
      const d = new Date(r.session_date + 'T00:00:00');
      const dateLabel = formatDMYWeekday(r.session_date);
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--line);">
          <span style="font-size:12.5px;">
            <b>${escapeHtml(r.subject_name || '')}</b> ${facultySessionBadge(r)} · Sem ${r.semester} · Div ${escapeHtml(r.division || 'All')}
            · ${dateLabel} · ${formatFacultyTime12(r.start_time)}
            <span style="color:var(--muted);"> — ${escapeHtml(r.reason || '')}</span>
          </span>
          <button class="tt-action" onclick="uncancelLecture(${r.timetable_id}, '${r.session_date}')">Undo</button>
        </div>`;
    }).join('');
    container.innerHTML = cancelledHtml + givenHtml + takingHtml;
    limitDashListRows(container);
  }catch(err){
    container.innerHTML = `<div class="empty-state">Cancelled lectures could not be loaded: ${err.message}</div>`;
  }
}

// ---- Substitute session: another faculty takes one lecture/lab on one date ----
let cachedColleagues = null;

function refreshAfterSessionChange(){
  loadAttendancePendingDays();
  loadCancelledLectures();
  if(typeof loadFacultyDashboardSummary === 'function') loadFacultyDashboardSummary();
  if(typeof loadFacultyDashboardCharts === 'function') loadFacultyDashboardCharts();
}

async function openSubstituteDialog(timetableId, date){
  try{
    if(!cachedColleagues) cachedColleagues = await apiRequest('/faculty/colleagues');
  }catch(err){
    alert('Faculty list could not be loaded: ' + err.message);
    return;
  }
  if(!cachedColleagues.length){ alert('No other faculty found.'); return; }

  const old = document.getElementById('substituteDialog');
  if(old) old.remove();
  const options = cachedColleagues.map(f =>
    `<option value="${f.id}">${escapeHtml(f.name)}${f.department ? ' (' + escapeHtml(f.department) + ')' : ''}</option>`).join('');
  const overlay = document.createElement('div');
  overlay.id = 'substituteDialog';
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; z-index:9999;';
  overlay.innerHTML = `
    <div style="background:var(--card, #fff); color:inherit; padding:20px; border-radius:12px; width:min(380px, 92vw); box-shadow:0 10px 30px rgba(0,0,0,.25);">
      <h3 style="margin:0 0 4px;">Set a substitute</h3>
      <p style="margin:0 0 14px; font-size:12.5px; color:var(--muted);">Date: ${escapeHtml(formatDMY(date))}. The substitute will mark the attendance of this lecture.</p>
      <label style="font-size:12.5px;">Substitute faculty</label>
      <select id="substituteFaculty" style="width:100%; margin:4px 0 12px; padding:8px;">${options}</select>
      <label style="font-size:12.5px;">Reason</label>
      <select id="substituteReason" style="width:100%; margin:4px 0 16px; padding:8px;">
        <option>Faculty leave</option><option>Meeting</option><option>Other</option>
      </select>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button class="tt-action" id="substituteCancelBtn">Close</button>
        <button class="tt-action" id="substituteOkBtn">Set substitute</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('substituteCancelBtn').onclick = () => overlay.remove();
  document.getElementById('substituteOkBtn').onclick = async () => {
    const okBtn = document.getElementById('substituteOkBtn');
    okBtn.disabled = true;
    try{
      const res = await apiRequest('/faculty/session-substitute', {
        method: 'POST',
        body: JSON.stringify({
          timetable_id: timetableId, date,
          substitute_faculty_id: document.getElementById('substituteFaculty').value,
          reason: document.getElementById('substituteReason').value
        })
      });
      overlay.remove();
      alert(res.message);
      refreshAfterSessionChange();
    }catch(err){
      okBtn.disabled = false;
      alert(err.message);
    }
  };
}

async function unsubstituteLecture(timetableId, date){
  if(!confirm('Remove the substitute? The lecture will be yours again.')) return;
  try{
    await apiRequest('/faculty/session-unsubstitute', {
      method: 'POST',
      body: JSON.stringify({ timetable_id: timetableId, date })
    });
    refreshAfterSessionChange();
  }catch(err){
    alert(err.message);
  }
}

// Mark attendance of a lecture this faculty is SUBSTITUTING (the subject is not in his/her own assignments),
// so the attendance view is opened with the timetable slot + date instead of an assignment
function openSubstituteAttendance(l, date){
  const tid = l.id || l.timetable_id;
  window.substituteCtx = {
    timetable_id: tid,
    date,
    session_type: l.session_type,
    division: l.division,
    label: `Division ${l.division || 'All'} · ${l.subject_name} · ${l.session_type || 'Lecture'} · Substitute for ${l.substitute_for || 'another faculty'}`
  };
  window.selectedSubjectContext = { substitute: true };
  const dateInput = document.getElementById('attDate');
  if(dateInput) dateInput.value = date;
  switchView('attendance');
}

// The "Mark" button of the "Attendance pending" card opens the attendance view, the subject
// is auto-selected (similar to the openClass flow from My Subjects) and the date is also
// set to that pending day (openClass keeps only today's date, hence a separate function)
function openAttendanceForDate(subject, date){
  window.selectedSubjectContext = subject || null;
  switchView('attendance');
  const dateInput = document.getElementById('attDate');
  if(dateInput){
    dateInput.value = date;
    loadFacultyAttendance();
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
    document.getElementById('settingsWhatsapp').value = p.whatsapp_number || '';
  }catch(err){
    console.error('Profile load error:', err.message);
  }
}

// Put the name + department into the sidebar profile-mini and the topbar profile dropdown
// (instead of the hardcoded "Prof. R. Mehta" — same behaviour as the admin panel).
// In tight spaces like the sidebar/topbar the short name is used (if filled),
// otherwise it falls back to the full name — "Prof." is always put in front of both.
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
// Topbar profile dropdown — same as the admin panel (only one
// dropdown stays open at a time, and it closes on clicking outside)
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
// Logout — clear token/role/name and send to the login page
// ============================================================
function logout(){
  if(!confirm('Log out?')) return;
  sessionStorage.removeItem('token_faculty');
  sessionStorage.removeItem('name_faculty');
  window.location.href = '../login_panel/login.html';
}

async function saveFacultySettings(){
  const name = document.getElementById('settingsFullName').value.trim();
  const shortName = document.getElementById('settingsShortName').value.trim();
  const whatsapp = document.getElementById('settingsWhatsapp').value.trim();
  const currentPassword = document.getElementById('settingsCurrentPassword').value;
  const newPassword = document.getElementById('settingsNewPassword').value;
  const confirmPassword = document.getElementById('settingsConfirmPassword').value;

  if(!name){
    alert('Name cannot be empty');
    return;
  }
  if(whatsapp && !/^\d{10,15}$/.test(whatsapp)){
    alert('WhatsApp number must be 10-15 digits (with country code if needed)');
    return;
  }

  try{
    await apiRequest('/faculty/profile', {
      method: 'PUT',
      body: JSON.stringify({ name, short_name: shortName, whatsapp_number: whatsapp || null })
    });
    applyProfileNameToUI(name, document.getElementById('settingsDepartment').value, shortName);
    sessionStorage.setItem('name_faculty', name);

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