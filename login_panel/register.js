// ---- Show/Hide password ----
function toggleVis(id, btn){
  const input = document.getElementById(id);
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  btn.textContent = isPwd ? 'Hide' : 'Show';
}

function setErr(wrapId, errId, isError){
  document.getElementById(wrapId).classList.toggle('err', isError);
  document.getElementById(errId).classList.toggle('hidden', !isError);
}

async function handleRegister(e){
  e.preventDefault();
  let valid = true;

  // Personal details
  const name = document.getElementById('rg_name').value.trim();
  if(!name){ setErr('wrap_name','err_name',true); valid=false; } else { setErr('wrap_name','err_name',false); }

  const enroll = document.getElementById('rg_enroll').value.trim();
  if(!/^\d{12}$/.test(enroll)){ setErr('wrap_enroll','err_enroll',true); valid=false; } else { setErr('wrap_enroll','err_enroll',false); }

  const mobile = document.getElementById('rg_mobile').value.trim();
  if(!/^\d{10}$/.test(mobile)){ setErr('wrap_mobile','err_mobile',true); valid=false; } else { setErr('wrap_mobile','err_mobile',false); }

  const email = document.getElementById('rg_email').value.trim();
  if(!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)){ setErr('wrap_email','err_email',true); valid=false; } else { setErr('wrap_email','err_email',false); }

  const whatsapp = document.getElementById('rg_whatsapp').value.trim();
  if(whatsapp && !/^\d{10,15}$/.test(whatsapp)){ setErr('wrap_whatsapp','err_whatsapp',true); valid=false; } else { setErr('wrap_whatsapp','err_whatsapp',false); }

  const genderEl = document.querySelector('input[name="gender"]:checked');
  document.getElementById('err_gender').classList.toggle('hidden', !!genderEl);
  if(!genderEl) valid = false;

  // Academic details
  const dept = document.getElementById('rg_dept').value;
  if(!dept){ setErr('wrap_dept','err_dept',true); valid=false; } else { setErr('wrap_dept','err_dept',false); }

  const sem = document.getElementById('rg_sem').value;
  if(!sem){ setErr('wrap_sem','err_sem',true); valid=false; } else { setErr('wrap_sem','err_sem',false); }

  const div = document.getElementById('rg_div').value;
  if(!div){ setErr('wrap_div','err_div',true); valid=false; } else { setErr('wrap_div','err_div',false); }

  const year = document.getElementById('rg_year').value;
  if(!year){ setErr('wrap_year','err_year',true); valid=false; } else { setErr('wrap_year','err_year',false); }

  // Parent / Guardian details
  const fatherName = document.getElementById('rg_father_name').value.trim();
  if(!fatherName){ setErr('wrap_father_name','err_father_name',true); valid=false; } else { setErr('wrap_father_name','err_father_name',false); }

  const fatherMobile = document.getElementById('rg_father_mobile').value.trim();
  if(!/^\d{10}$/.test(fatherMobile)){ setErr('wrap_father_mobile','err_father_mobile',true); valid=false; } else { setErr('wrap_father_mobile','err_father_mobile',false); }

  const motherName = document.getElementById('rg_mother_name').value.trim();

  const motherMobile = document.getElementById('rg_mother_mobile').value.trim();
  if(motherMobile && !/^\d{10}$/.test(motherMobile)){ setErr('wrap_mother_mobile','err_mother_mobile',true); valid=false; } else { setErr('wrap_mother_mobile','err_mother_mobile',false); }

  const parentEmail = document.getElementById('rg_parent_email').value.trim();
  if(parentEmail && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(parentEmail)){ setErr('wrap_parent_email','err_parent_email',true); valid=false; } else { setErr('wrap_parent_email','err_parent_email',false); }

  const parentAddress = document.getElementById('rg_parent_address').value.trim();

  // Account details
  const pass = document.getElementById('rg_pass').value;
  if(pass.length < 8){ setErr('wrap_pass','err_pass',true); valid=false; } else { setErr('wrap_pass','err_pass',false); }

  const pass2 = document.getElementById('rg_pass2').value;
  if(pass2 !== pass || pass2.length === 0){ setErr('wrap_pass2','err_pass2',true); valid=false; } else { setErr('wrap_pass2','err_pass2',false); }

  const terms = document.getElementById('rg_terms').checked;
  document.getElementById('err_terms').classList.toggle('hidden', terms);
  if(!terms) valid = false;

  if(!valid) return false;

  // ---- Send to backend ----
  const payload = {
    name: name,
    enrollment: enroll,
    email: email,
    mobile: mobile,
    whatsapp_number: whatsapp,
    gender: genderEl.value,
    department: dept,
    semester: sem,
    division: div,
    academic_year: year,
    father_name: fatherName,
    father_mobile: fatherMobile,
    mother_name: motherName,
    mother_mobile: motherMobile,
    parent_email: parentEmail,
    parent_address: parentAddress,
    password: pass
  };

  const submitBtn = document.querySelector('#registerForm button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Registering…';

  try {
    const res = await fetch(window.APP_CONFIG.API_BASE + '/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if(res.ok){
      alert('Registration successful!');
      window.location.href = '../login_panel/login.html';
    } else {
      alert(data.message || 'Registration failed. Please try again.');
    }
  } catch(err){
    alert('Unable to connect to the server. Please check that the backend is running.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = 'Register <span>→</span>';
  }

  return false;
}


// ---- Academic year dropdown: Academic Management ke active batches se bharo ----
// (register.html me hardcoded options sirf fallback hain, agar server na mile)
async function loadRegisterYears(){
  const sel = document.getElementById('rg_year');
  if(!sel) return;
  try{
    const res = await fetch(window.APP_CONFIG.API_BASE + '/academic-years');
    if(!res.ok) return;
    const labels = await res.json();
    if(!Array.isArray(labels) || labels.length === 0) return;
    const placeholder = sel.options[0];   // "Select year"
    sel.innerHTML = '';
    sel.appendChild(placeholder);
    labels.forEach(label => {
      const parts = String(label).split('-');
      const text = parts.length === 2 ? `${parts[0]} - ${parts[0].slice(0, 2)}${parts[1]}` : label;
      const opt = document.createElement('option');
      opt.value = label;
      opt.textContent = text;
      sel.appendChild(opt);
    });
    placeholder.selected = true;
  }catch(err){
    // server off hai to hardcoded fallback options hi rahenge
  }
}
document.addEventListener('DOMContentLoaded', loadRegisterYears);