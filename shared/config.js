/* =====================================================================
   StudentHub - common frontend config.
   This is the ONLY place where the backend address is written.
   Loaded by every page BEFORE its own scripts (login, register, admin,
   faculty, student panels and shared/force_password.js).

   Before deploying, change API_BASE to your server's API address, e.g.
     API_BASE: 'https://api.yourcollege.in/api'
   (and add the website's address to ALLOWED_ORIGINS in Backend/.env).
   ===================================================================== */
window.APP_CONFIG = {
  API_BASE: 'http://localhost:5000/api'
};
window.APP_CONFIG.API_BASE = window.APP_CONFIG.API_BASE.replace(/\/+$/, '');   // no trailing slash
