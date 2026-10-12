/* =====================================================================
   Forced password change on first login (student / faculty / admin).
   Included in every panel BEFORE the panel's own script.

   - If login says the account still has a default password, a blocking
     popup is shown and the user cannot use the panel until it is changed.
   - The backend enforces the same rule: every other API route answers
     HTTP 428 {code: 'PASSWORD_CHANGE_REQUIRED'} until the password is
     changed, so skipping the popup does not help.
   - Styling uses the StudentHub theme variables (--teal-*, --mint-*,
     --paper, --line, --ink ...) so it follows light/dark mode too.
   ===================================================================== */
(function () {
  var p = location.pathname.toLowerCase();
  var role = p.indexOf('student_panel') > -1 ? 'student'
           : p.indexOf('faculty_panel') > -1 ? 'faculty'
           : p.indexOf('admin_panel') > -1 ? 'admin' : null;
  if (!role) return;

  var FLAG = 'must_change_password_' + role;
  var API = 'http://localhost:5000/api';
  var shown = false;
  var rawFetch = window.fetch.bind(window);

  /* ---------- theme styles (StudentHub look) ---------- */
  var CSS = [
    '.fp-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
    '  padding:16px;background:rgba(13,44,38,.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);',
    '  font-family:var(--font-body,"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);}',
    '.fp-card{width:100%;max-width:440px;max-height:calc(100vh - 32px);overflow:auto;background:var(--paper,#fff);',
    '  color:var(--ink,#12241f);border:1px solid var(--line,#e3e8e6);border-radius:14px;',
    '  box-shadow:0 24px 60px rgba(13,44,38,.35);position:relative;}',
    '.fp-body{padding:24px 26px 24px;}',
    '.fp-brand{display:flex;align-items:center;gap:10px;margin-bottom:14px;}',
    '.fp-brand img{height:34px;width:auto;display:block;}',
    '.fp-brand span{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--teal-700,#0f6b52);',
    '  background:var(--mint-100,#eafaf3);border:1px solid var(--mint-200,#c7f3e2);padding:4px 10px;border-radius:999px;}',
    '.fp-title{font-family:var(--font-display,"Fraunces",Georgia,serif);font-size:24px;font-weight:600;line-height:1.2;',
    '  color:var(--ink,#12241f);margin:0 0 6px;}',
    '.fp-sub{font-size:13.5px;line-height:1.5;color:var(--muted,#5b6b66);margin:0 0 18px;}',
    '.fp-field{margin-bottom:14px;}',
    '.fp-field label{display:block;font-size:12.5px;font-weight:600;color:var(--ink,#12241f);margin-bottom:6px;}',
    '.fp-input-wrap{position:relative;}',
    '.fp-input-wrap input{width:100%;padding:11px 62px 11px 13px;font:inherit;font-size:14px;color:var(--ink,#12241f);',
    '  background:var(--paper,#fff);border:1px solid var(--line,#e3e8e6);border-radius:9px;outline:none;',
    '  transition:border-color .15s ease,box-shadow .15s ease;}',
    '.fp-input-wrap input:focus{border-color:var(--teal-600,#137a5e);box-shadow:0 0 0 3px var(--mint-200,#c7f3e2);}',
    '.fp-toggle{position:absolute;top:6px;bottom:6px;right:6px;margin:0;display:flex;align-items:center;justify-content:center;',
    '  border:0;background:transparent;cursor:pointer;font:inherit;font-size:12px;font-weight:600;line-height:1;',
    '  color:var(--teal-700,#0f6b52);padding:0 10px;border-radius:6px;transform:none !important;',
    '  transition:background-color .2s ease,color .2s ease;}',
    '.fp-toggle:hover{background:var(--mint-100,#eafaf3);color:var(--teal-600,#137a5e);transform:none !important;}',
    '.fp-toggle:active{background:var(--mint-200,#c7f3e2);transform:none !important;}',
    '.fp-toggle:focus-visible{outline:2px solid var(--teal-600,#137a5e);outline-offset:1px;}',
    '.fp-hint{font-size:12px;color:var(--muted,#5b6b66);margin:-4px 0 14px;line-height:1.45;}',
    '.fp-msg{display:none;font-size:13px;line-height:1.4;padding:10px 12px;border-radius:9px;margin:0 0 14px;}',
    '.fp-msg.err{display:block;color:var(--danger,#b42318);background:var(--danger-bg,#fdecea);',
    '  border:1px solid var(--danger,#b42318);}',
    '.fp-msg.ok{display:block;color:var(--teal-700,#0f6b52);background:var(--mint-100,#eafaf3);',
    '  border:1px solid var(--mint-300,#9fe8cd);}',
    '.fp-actions{display:flex;gap:10px;justify-content:flex-end;align-items:center;margin-top:4px;}',
    '.fp-btn{font:inherit;font-size:13.5px;font-weight:700;border-radius:9px;padding:11px 20px;cursor:pointer;',
    '  transition:background .15s ease,transform .1s ease,border-color .15s ease;}',
    '.fp-btn:active{transform:translateY(1px);}',
    '.fp-primary{background:var(--teal-700,#0f6b52);color:#fff;border:0;}',
    '.fp-primary:hover{background:var(--teal-600,#137a5e);}',
    '.fp-primary:disabled{background:var(--mint-300,#9fe8cd);cursor:not-allowed;}',
    '.fp-ghost{background:transparent;color:var(--muted,#5b6b66);border:1px solid var(--line,#e3e8e6);}',
    '.fp-ghost:hover{border-color:var(--teal-600,#137a5e);color:var(--teal-700,#0f6b52);}',
    '@media (max-width:480px){.fp-body{padding:20px 18px;}.fp-actions{flex-direction:column-reverse;}.fp-btn{width:100%;}}'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('fpStyles')) return;
    var st = document.createElement('style');
    st.id = 'fpStyles';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // If the backend ever says "change your password first", show the popup (even if the flag was lost).
  window.fetch = function (input) {
    // While the popup is pending, do not even send the panel's API calls to the server
    // (they would all be refused with 428 anyway and fill the server log with red lines).
    // They simply wait; the page reloads right after the password is changed.
    var url = typeof input === 'string' ? input : ((input && input.url) || '');
    if (sessionStorage.getItem(FLAG) === 'true' && url.indexOf(API) === 0 && url.indexOf('/change-password') === -1) {
      return new Promise(function () {});
    }
    return rawFetch.apply(null, arguments).then(function (res) {
      if (res.status === 428 && !shown) {
        res.clone().json().then(function (d) {
          if (d && d.code === 'PASSWORD_CHANGE_REQUIRED') {
            sessionStorage.setItem(FLAG, 'true');
            showModal();
          }
        }).catch(function () {});
      }
      return res;
    });
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function logoutNow() {
    sessionStorage.removeItem('token_' + role);
    sessionStorage.removeItem('name_' + role);
    sessionStorage.removeItem(FLAG);
    window.location.href = '../login_panel/login.html';
  }

  function showModal() {
    if (shown || !document.body) return;
    shown = true;
    injectStyles();

    var overlay = el('div', 'fp-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'fpTitle');

    var card = el('div', 'fp-card');
    var body = el('div', 'fp-body');
    card.appendChild(body);

    // brand row: logo (same file every panel already has) + small badge
    var brand = el('div', 'fp-brand');
    var logo = document.createElement('img');
    logo.src = 'studenthub.png';
    logo.alt = 'StudentHub';
    logo.onerror = function () { logo.style.display = 'none'; };
    brand.appendChild(logo);
    brand.appendChild(el('span', '', 'Security check'));
    body.appendChild(brand);

    var title = el('h2', 'fp-title', 'Set a new password');
    title.id = 'fpTitle';
    body.appendChild(title);
    body.appendChild(el('p', 'fp-sub',
      'You are signed in with a default password. Please choose a new one to continue to your ' + role + ' panel.'));

    function field(label, id, autocomplete) {
      var wrap = el('div', 'fp-field');
      var l = el('label', '', label);
      l.setAttribute('for', id);
      var box = el('div', 'fp-input-wrap');
      var i = document.createElement('input');
      i.type = 'password'; i.id = id; i.autocomplete = autocomplete;
      var t = el('button', 'fp-toggle', 'Show');
      t.type = 'button';
      t.setAttribute('aria-label', 'Show or hide password');
      t.onclick = function () {
        var hidden = i.type === 'password';
        i.type = hidden ? 'text' : 'password';
        t.textContent = hidden ? 'Hide' : 'Show';
      };
      box.appendChild(i); box.appendChild(t);
      wrap.appendChild(l); wrap.appendChild(box);
      body.appendChild(wrap);
      return i;
    }
    var cur = field('Current (default) password', 'fpCurrent', 'current-password');
    var nw = field('New password', 'fpNew', 'new-password');
    body.appendChild(el('div', 'fp-hint', 'At least 8 characters. It must be different from your default password.'));
    var cf = field('Confirm new password', 'fpConfirm', 'new-password');

    var msg = el('div', 'fp-msg');
    msg.setAttribute('aria-live', 'polite');
    body.appendChild(msg);

    var row = el('div', 'fp-actions');
    var out = el('button', 'fp-btn fp-ghost', 'Log out');
    out.type = 'button';
    out.onclick = logoutNow;
    var go = el('button', 'fp-btn fp-primary', 'Update password');
    go.type = 'button';
    row.appendChild(out); row.appendChild(go);
    body.appendChild(row);

    function setMsg(t, ok) {
      msg.textContent = t || '';
      msg.className = 'fp-msg' + (t ? (ok ? ' ok' : ' err') : '');
    }

    async function submit() {
      if (!cur.value || !nw.value || !cf.value) return setMsg('Please fill in all three fields.');
      if (nw.value.length < 8) return setMsg('New password must be at least 8 characters.');
      if (nw.value !== cf.value) return setMsg('New password and confirmation do not match.');
      if (nw.value === cur.value) return setMsg('New password must be different from the current one.');
      go.disabled = true; setMsg('Updating your password…', true);
      try {
        var res = await rawFetch(API + '/' + role + '/change-password', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sessionStorage.getItem('token_' + role) },
          body: JSON.stringify({ current_password: cur.value, new_password: nw.value })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          if (res.status === 401 && /token|expired|invalid/i.test(data.message || '') && !/password/i.test(data.message || '')) {
            return logoutNow();
          }
          throw new Error(data.message || 'Could not update the password.');
        }
        sessionStorage.removeItem(FLAG);
        setMsg('Password updated. Loading your panel…', true);
        setTimeout(function () { window.location.reload(); }, 700);
      } catch (e) {
        setMsg(e.message || 'Could not update the password.');
        go.disabled = false;
      }
    }
    go.onclick = submit;
    [cur, nw, cf].forEach(function (i) { i.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); }); });
    overlay.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') ev.stopPropagation(); });

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(function () { cur.focus(); }, 50);
  }

  function init() {
    if (sessionStorage.getItem(FLAG) === 'true' && sessionStorage.getItem('token_' + role)) showModal();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();