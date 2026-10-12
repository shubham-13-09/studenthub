// ---- View switching (Login <-> Forgot Password) ----
function showView(view) {
  const isLogin = view === 'login';
  document.getElementById('viewLogin').classList.toggle('hidden', !isLogin);
  document.getElementById('viewForgot').classList.toggle('hidden', isLogin);
  if (!isLogin) resetForgotFlow();
}

// ---- Show/Hide password ----
function toggleVis(id, btn) {
  const input = document.getElementById(id);
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  btn.textContent = isPwd ? 'Hide' : 'Show';
}

function setErr(wrapId, errId, isError) {
  document.getElementById(wrapId).classList.toggle('err', isError);
  document.getElementById(errId).classList.toggle('hidden', !isError);
}



// ---- Login form validation (frontend only) ----
async function handleLogin(e) {
  e.preventDefault();
  const idVal = document.getElementById('li_id').value.trim();
  const pass = document.getElementById('li_password').value;

  try {
    const res = await fetch('http://localhost:5000/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: idVal, password: pass })
    });
    const data = await res.json();

    if (res.ok) {
      // Store the token under a role-specific key so that admin, faculty and student
      sessionStorage.setItem('token_' + data.role, data.token);
      sessionStorage.setItem('name_' + data.role, data.name);
      if (data.must_change_password) {
        sessionStorage.setItem('must_change_password_' + data.role, 'true');
      }

      if (data.role === 'student') window.location.href = '../student_panel/student.html';
      else if (data.role === 'faculty') window.location.href = '../faculty_panel/faculty.html';
      else if (data.role === 'admin') window.location.href = '../admin_panel/admin.html';
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert('Unable to connect to the server. Please check that the backend is running.');
  }
  return false;
}

// ---- Forgot password: 3-step OTP flow ----
function resetForgotFlow() {
  document.getElementById('forgotStep1').classList.remove('hidden');
  document.getElementById('forgotStep2').classList.add('hidden');
  document.getElementById('forgotStep3').classList.add('hidden');
  document.getElementById('forgotStepSub').textContent = 'Enter your enrollment number and email to receive an OTP.';
  document.getElementById('fg_otp').value = '';
}

// Keep the enrollment number here so steps 2 and 3 can reuse it
let fg_enrollment = '';

async function sendOtp() {
  const enroll = document.getElementById('fg_enroll').value.trim();
  const email = document.getElementById('fg_email').value.trim();

  if (!enroll) {
    alert('Enter your Enrollment Number / Faculty ID.');
    return;
  }
  if (!/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email)) {
    alert('Enter a valid Gmail address.');
    return;
  }

  const btn = document.querySelector('#forgotStep1 button');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const res = await fetch('http://localhost:5000/api/forgot-password/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollment: enroll, email: email })
    });
    const data = await res.json();

    if (res.ok) {
      fg_enrollment = enroll;
      document.getElementById('forgotStep1').classList.add('hidden');
      document.getElementById('forgotStep2').classList.remove('hidden');
      document.getElementById('forgotStepSub').textContent = 'Check your email for the OTP we just sent.';
    } else {
      alert(data.message || 'Failed to send OTP. Please try again.');
    }
  } catch (err) {
    alert('Unable to connect to the server. Please check that the backend is running.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send OTP'; }
  }
}

async function verifyOtp() {
  const otp = document.getElementById('fg_otp').value.trim();
  if (!/^\d{6}$/.test(otp)) {
    alert('Enter the 6-digit OTP sent to your email.');
    return;
  }

  try {
    const res = await fetch('http://localhost:5000/api/forgot-password/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollment: fg_enrollment, otp: otp })
    });
    const data = await res.json();

    if (res.ok) {
      document.getElementById('forgotStep2').classList.add('hidden');
      document.getElementById('forgotStep3').classList.remove('hidden');
      document.getElementById('forgotStepSub').textContent = 'OTP verified. Set your new password.';
    } else {
      alert(data.message || 'OTP verification failed. Please try again.');
    }
  } catch (err) {
    alert('Unable to connect to the server. Please check that the backend is running.');
  }
}

async function updatePassword() {
  let valid = true;
  const pass = document.getElementById('fg_newpass').value;
  const pass2 = document.getElementById('fg_newpass2').value;

  if (pass.length < 8) { setErr('wrap_newpass', 'err_newpass', true); valid = false; } else { setErr('wrap_newpass', 'err_newpass', false); }
  if (pass2 !== pass || pass2.length === 0) { setErr('wrap_newpass2', 'err_newpass2', true); valid = false; } else { setErr('wrap_newpass2', 'err_newpass2', false); }

  if (!valid) return;

  try {
    const res = await fetch('http://localhost:5000/api/forgot-password/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollment: fg_enrollment, password: pass })
    });
    const data = await res.json();

    if (res.ok) {
      alert('Password updated successfully! Please login with your new password.');
      showView('login');
    } else {
      alert(data.message || 'Password update failed. Please try again.');
    }
  } catch (err) {
    alert('Unable to connect to the server. Please check that the backend is running.');
  }
}