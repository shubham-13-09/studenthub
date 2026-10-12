from flask import request, jsonify
from db import get_db
import bcrypt
import jwt
import datetime
import secrets

from app import app, SECRET_KEY, send_otp_email, limiter
from auth_middleware import is_default_password

# ============ ACADEMIC YEARS (public — register form dropdown) ============
# Academic Management me jo batches hain wahi register page par dikhengi
# (admin panel ke dropdowns bhi isi academic_years table se bharte hain).
@app.route('/api/academic-years', methods=['GET'])
def public_academic_years():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT year_label FROM academic_years ORDER BY year_label ASC")
    labels = [r[0] for r in cursor.fetchall()]
    cursor.close()
    conn.close()
    return jsonify(labels), 200


# ============ REGISTER (Student) ============
@app.route('/api/register', methods=['POST'])
@limiter.limit("10 per hour")
def register():
    data = request.get_json() or {}

    name = data.get('name')
    enrollment = data.get('enrollment')     # ye login_id banega
    email = data.get('email')
    mobile = data.get('mobile')
    whatsapp_number = (data.get('whatsapp_number') or '').strip() or None   # optional
    gender = data.get('gender')
    department = data.get('department')
    semester = data.get('semester')
    division = data.get('division')
    academic_year = data.get('academic_year')
    father_name = data.get('father_name')
    father_mobile = data.get('father_mobile')
    mother_name = data.get('mother_name')
    mother_mobile = data.get('mother_mobile')
    parent_email = data.get('parent_email')
    parent_address = data.get('parent_address')
    password = data.get('password')

    # Basic validation
    if not all([name, enrollment, email, mobile, gender, department, semester, division, academic_year, father_name, father_mobile, password]):
        return jsonify({"message": "All fields are required"}), 400
    if whatsapp_number and (not whatsapp_number.isdigit() or not (10 <= len(whatsapp_number) <= 15)):
        return jsonify({"message": "WhatsApp number must be 10-15 digits (with country code if needed)"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    # Check karo enrollment number pehle se to nahi hai
    cursor.execute("SELECT id FROM users WHERE login_id = %s", (enrollment,))
    existing = cursor.fetchone()
    if existing:
        cursor.close()
        conn.close()
        return jsonify({"message": "Enrollment number already registered"}), 409

    # Password hash karo
    hashed_pw = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    try:
        # users table me insert — student registration seedhe active nahi, admin approval ke wait me 'pending' rehta hai
        cursor.execute(
            "INSERT INTO users (login_id, password_hash, role, name, status, must_change_password) VALUES (%s, %s, %s, %s, 'pending', FALSE)",
            (enrollment, hashed_pw, 'student', name)
        )
        user_id = cursor.lastrowid

        # students table me academic + parent details insert
        cursor.execute(
            """INSERT INTO students (user_id, email, mobile, whatsapp_number, department, semester, division, academic_year, gender,
                                      father_name, father_mobile, mother_name, mother_mobile, parent_email, parent_address)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (user_id, email, mobile, whatsapp_number, department, semester, division, academic_year, gender,
             father_name, father_mobile, mother_name, mother_mobile, parent_email, parent_address)
        )

        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        app.logger.error("Registration error: %s", repr(e))
        return jsonify({"message": "Registration failed"}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Registration successful. You can log in once an admin approves your account."}), 201


# ============ LOGIN (Student / Faculty / Admin) ============
@app.route('/api/login', methods=['POST'])
@limiter.limit("5 per minute")
def login():
    data = request.get_json() or {}
    login_id = data.get('loginId')
    password = data.get('password')

    if not login_id or not password:
        return jsonify({"message": "Login ID and password required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    # Pehle login_id se match try karo (student: enrollment | faculty/admin: email)
    cursor.execute("SELECT * FROM users WHERE login_id = %s", (login_id,))
    user = cursor.fetchone()

    # Agar match nahi hua, to students table me email se check karo
    if not user:
        cursor.execute("""
            SELECT u.* FROM users u
            JOIN students s ON s.user_id = u.id
            WHERE s.email = %s
        """, (login_id,))
        user = cursor.fetchone()

    # Ab bhi match nahi hua, to faculty table me email se check karo
    if not user:
        cursor.execute("""
            SELECT u.* FROM users u
            JOIN faculty f ON f.user_id = u.id
            WHERE f.email = %s
        """, (login_id,))
        user = cursor.fetchone()

    cursor.close()
    conn.close()

    if not user:
        return jsonify({"message": "Invalid login ID or password"}), 401

    if user['status'] == 'inactive':
        return jsonify({"message": "Account is inactive. Contact admin."}), 403

    if user['status'] == 'pending':
        return jsonify({"message": "Your account is awaiting admin approval."}), 403

    if not bcrypt.checkpw(password.encode('utf-8'), user['password_hash'].encode('utf-8')):
        return jsonify({"message": "Invalid login ID or password"}), 401

    # Check for first-login default passwords or must_change_password flag
    must_change = bool(user.get('must_change_password'))
    if not must_change and is_default_password(user['role'], user['login_id'], password):
        must_change = True
        # Persist the flag so the backend (middleware) enforces it, not just the UI
        try:
            conn_f = get_db()
            cur_f = conn_f.cursor()
            cur_f.execute("UPDATE users SET must_change_password = TRUE WHERE id = %s", (user['id'],))
            conn_f.commit()
            cur_f.close()
            conn_f.close()
        except Exception as e:
            print("MUST CHANGE PASSWORD FLAG ERROR:", repr(e))

    # JWT token generate karo
    token = jwt.encode({
        'user_id': user['id'],
        'role': user['role'],
        'exp': datetime.datetime.utcnow() + datetime.timedelta(days=1)
    }, SECRET_KEY, algorithm='HS256')

    # Login history me entry
    try:
        conn2 = get_db()
        cursor2 = conn2.cursor()
        cursor2.execute(
            "INSERT INTO login_history (user_id, ip_address) VALUES (%s, %s)",
            (user['id'], request.remote_addr)
        )
        conn2.commit()
        cursor2.close()
        conn2.close()
    except Exception as e:
        print("LOGIN HISTORY LOG ERROR:", repr(e))

    return jsonify({
        "token": token,
        "role": user['role'],
        "name": user['name'],
        "must_change_password": must_change
    }), 200


# Student aur faculty dono ke liye: login_id (ya email) se user dhoondo aur uska
# registered email verify karo. Admin is flow me support nahi hai.
def _resolve_forgot_password_user(cursor, identifier, email):
    # Pehle login_id se try karo
    cursor.execute("SELECT id, name, role FROM users WHERE login_id = %s", (identifier,))
    user = cursor.fetchone()

    # Agar login_id se na mile, to identifier registered email ho sakta hai
    if not user:
        cursor.execute("""
            SELECT u.id, u.name, u.role FROM users u
            JOIN students s ON s.user_id = u.id
            WHERE s.email = %s
        """, (identifier,))
        user = cursor.fetchone()
    if not user:
        cursor.execute("""
            SELECT u.id, u.name, u.role FROM users u
            JOIN faculty f ON f.user_id = u.id
            WHERE f.email = %s
        """, (identifier,))
        user = cursor.fetchone()

    if not user or user['role'] not in ('student', 'faculty'):
        return None

    # Role ke hisaab se registered email nikaal kar form wale email se match karo
    if user['role'] == 'student':
        cursor.execute("SELECT email FROM students WHERE user_id = %s", (user['id'],))
    else:
        cursor.execute("SELECT email FROM faculty WHERE user_id = %s", (user['id'],))
    row = cursor.fetchone()

    if not row or row['email'].strip().lower() != email.strip().lower():
        return None

    return user


def _find_user_id_by_identifier(cursor, identifier):
    cursor.execute("SELECT id FROM users WHERE login_id = %s", (identifier,))
    row = cursor.fetchone()
    if row:
        return row['id']

    cursor.execute("""
        SELECT u.id FROM users u JOIN students s ON s.user_id = u.id WHERE s.email = %s
    """, (identifier,))
    row = cursor.fetchone()
    if row:
        return row['id']

    cursor.execute("""
        SELECT u.id FROM users u JOIN faculty f ON f.user_id = u.id WHERE f.email = %s
    """, (identifier,))
    row = cursor.fetchone()
    return row['id'] if row else None


# ============ FORGOT PASSWORD: STEP 1 - SEND OTP ============
@app.route('/api/forgot-password/send-otp', methods=['POST'])
@limiter.limit("5 per minute")
def send_otp():
    data = request.get_json() or {}
    enrollment = data.get('enrollment')
    email = data.get('email')

    if not enrollment or not email:
        return jsonify({"message": "ID and email are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    user = _resolve_forgot_password_user(cursor, enrollment, email)

    # Security: user enumeration rokne ke liye hamesha identical response do
    if not user:
        cursor.close()
        conn.close()
        return jsonify({"message": "If the details match an account, an OTP has been sent to your registered email."}), 200

    # Cryptographically secure 6-digit OTP
    otp = f"{secrets.randbelow(900000) + 100000:06d}"
    hashed_otp = bcrypt.hashpw(otp.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    expires_at = datetime.datetime.utcnow() + datetime.timedelta(minutes=2)

    # Purane unverified OTPs is user ke clean kar do
    cursor.execute("DELETE FROM password_resets WHERE user_id = %s", (user['id'],))
    cursor.execute(
        "INSERT INTO password_resets (user_id, otp, expires_at, attempts) VALUES (%s, %s, %s, 0)",
        (user['id'], hashed_otp, expires_at)
    )
    conn.commit()
    cursor.close()
    conn.close()

    try:
        send_otp_email(email, otp)
    except Exception as e:
        print("OTP SEND ERROR:", repr(e))
        return jsonify({"message": "Failed to send OTP email"}), 500

    return jsonify({"message": "If the details match an account, an OTP has been sent to your registered email."}), 200


# ============ FORGOT PASSWORD: STEP 2 - VERIFY OTP ============
@app.route('/api/forgot-password/verify-otp', methods=['POST'])
@limiter.limit("10 per minute")
def verify_otp():
    data = request.get_json() or {}
    enrollment = data.get('enrollment')
    otp = (data.get('otp') or '').strip()

    if not enrollment or not otp:
        return jsonify({"message": "ID and OTP are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    user_id = _find_user_id_by_identifier(cursor, enrollment)
    record = None
    if user_id:
        cursor.execute("""
            SELECT id, otp, expires_at, attempts FROM password_resets
            WHERE user_id = %s
            ORDER BY created_at DESC LIMIT 1
        """, (user_id,))
        record = cursor.fetchone()

    if not record:
        cursor.close()
        conn.close()
        return jsonify({"message": "Please request an OTP first"}), 404

    # Max attempt enforcement
    attempts = record.get('attempts', 0) or 0
    if attempts >= 5:
        cursor.execute("DELETE FROM password_resets WHERE id = %s", (record['id'],))
        conn.commit()
        cursor.close()
        conn.close()
        return jsonify({"message": "Too many failed attempts. Please request a new OTP."}), 429

    # Expiry enforcement
    if datetime.datetime.utcnow() > record['expires_at']:
        cursor.close()
        conn.close()
        return jsonify({"message": "OTP has expired. Please request a new one."}), 410

    # Secure verification
    match = False
    try:
        if record['otp'].startswith('$2b$') or record['otp'].startswith('$2a$'):
            match = bcrypt.checkpw(otp.encode('utf-8'), record['otp'].encode('utf-8'))
        else:
            match = (record['otp'] == otp)
    except Exception:
        match = (record['otp'] == otp)

    if not match:
        new_attempts = attempts + 1
        if new_attempts >= 5:
            cursor.execute("DELETE FROM password_resets WHERE id = %s", (record['id'],))
            conn.commit()
            cursor.close()
            conn.close()
            return jsonify({"message": "Maximum OTP attempts exceeded. Please request a new OTP."}), 429

        cursor.execute("UPDATE password_resets SET attempts = %s WHERE id = %s", (new_attempts, record['id']))
        conn.commit()
        cursor.close()
        conn.close()
        return jsonify({"message": f"Incorrect OTP. {5 - new_attempts} attempt(s) remaining."}), 401

    # OTP verified: extend session validity by 10 minutes so user can complete password reset
    new_expiry = datetime.datetime.utcnow() + datetime.timedelta(minutes=10)
    cursor.execute("UPDATE password_resets SET is_verified = TRUE, expires_at = %s, attempts = 0 WHERE id = %s", (new_expiry, record['id']))
    conn.commit()
    cursor.close()
    conn.close()

    return jsonify({"message": "OTP verified successfully"}), 200


# ============ FORGOT PASSWORD: STEP 3 - RESET PASSWORD ============
@app.route('/api/forgot-password/reset-password', methods=['POST'])
@limiter.limit("5 per minute")
def reset_password():
    data = request.get_json() or {}
    enrollment = data.get('enrollment')
    new_password = data.get('password')

    if not enrollment or not new_password:
        return jsonify({"message": "ID and new password are required"}), 400

    if len(new_password) < 8:
        return jsonify({"message": "Password must be at least 8 characters"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    resolved_user_id = _find_user_id_by_identifier(cursor, enrollment)
    record = None
    if resolved_user_id:
        cursor.execute("""
            SELECT id, is_verified, user_id, expires_at FROM password_resets
            WHERE user_id = %s
            ORDER BY created_at DESC LIMIT 1
        """, (resolved_user_id,))
        record = cursor.fetchone()

    if not record or not record['is_verified']:
        cursor.close()
        conn.close()
        return jsonify({"message": "Please verify your OTP first"}), 403

    # Expiry verification
    if datetime.datetime.utcnow() > record['expires_at']:
        cursor.execute("DELETE FROM password_resets WHERE id = %s", (record['id'],))
        conn.commit()
        cursor.close()
        conn.close()
        return jsonify({"message": "Reset session expired. Please request a new OTP."}), 410

    hashed_pw = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    cursor.execute("UPDATE users SET password_hash = %s, must_change_password = FALSE WHERE id = %s", (hashed_pw, record['user_id']))
    # Is user ke saare reset records clean kardo taaki OTP reuse na ho
    cursor.execute("DELETE FROM password_resets WHERE user_id = %s", (record['user_id'],))
    conn.commit()
    cursor.close()
    conn.close()

    return jsonify({"message": "Password updated successfully"}), 200