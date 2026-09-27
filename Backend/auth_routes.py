from flask import request, jsonify
from db import get_db
import bcrypt
import jwt
import datetime
import random

from app import app, SECRET_KEY, send_otp_email

# ============ REGISTER (Student) ============
@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json()

    name = data.get('name')
    enrollment = data.get('enrollment')     # ye login_id banega
    email = data.get('email')
    mobile = data.get('mobile')
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
            "INSERT INTO users (login_id, password_hash, role, name, status) VALUES (%s, %s, %s, %s, 'pending')",
            (enrollment, hashed_pw, 'student', name)
        )
        user_id = cursor.lastrowid

        # students table me academic + parent details insert
        cursor.execute(
            """INSERT INTO students (user_id, email, mobile, department, semester, division, academic_year, gender,
                                      father_name, father_mobile, mother_name, mother_mobile, parent_email, parent_address)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (user_id, email, mobile, department, semester, division, academic_year, gender,
             father_name, father_mobile, mother_name, mother_mobile, parent_email, parent_address)
        )

        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Registration failed", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Registration successful. Admin approval ke baad login kar paayenge."}), 201


# ============ LOGIN (Student / Faculty / Admin) ============
@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
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
    # (isse student apne enrollment number ke alawa email se bhi login kar payega)
    if not user:
        cursor.execute("""
            SELECT u.* FROM users u
            JOIN students s ON s.user_id = u.id
            WHERE s.email = %s
        """, (login_id,))
        user = cursor.fetchone()

    # Ab bhi match nahi hua, to faculty table me email se check karo
    # (isse faculty apni Faculty ID ke alawa apne registered email se bhi login kar payega)
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
        return jsonify({"message": "Account admin approval ka wait kar raha hai."}), 403

    if not bcrypt.checkpw(password.encode('utf-8'), user['password_hash'].encode('utf-8')):
        return jsonify({"message": "Invalid login ID or password"}), 401

    # JWT token generate karo
    token = jwt.encode({
        'user_id': user['id'],
        'role': user['role'],
        'exp': datetime.datetime.utcnow() + datetime.timedelta(days=1)
    }, SECRET_KEY, algorithm='HS256')

    # Login history me entry — Admin panel ki Security > Login history yahi se aati hai
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
        print("LOGIN HISTORY LOG ERROR:", repr(e))   # login history fail ho to bhi login block nahi hona chahiye

    return jsonify({
        "token": token,
        "role": user['role'],
        "name": user['name']
    }), 200


# Student aur faculty dono ke liye: login_id (ya email) se user dhoondo aur uska
# registered email verify karo. Admin is flow me support nahi hai.
def _resolve_forgot_password_user(cursor, identifier, email):
    # Pehle login_id se try karo (student: enrollment number | faculty: Faculty ID)
    cursor.execute("SELECT id, name, role FROM users WHERE login_id = %s", (identifier,))
    user = cursor.fetchone()

    # Agar login_id se na mile, to identifier khud hi kisi ka registered email ho sakta hai
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

    if not row or row['email'] != email:
        return None

    return user


# Step 2/3 me sirf identifier (login_id ya email) se user_id chahiye hota hai
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
def send_otp():
    data = request.get_json()
    enrollment = data.get('enrollment')   # student ka enrollment number YA faculty ki Faculty ID / email
    email = data.get('email')

    if not enrollment or not email:
        return jsonify({"message": "ID aur email required hai"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    user = _resolve_forgot_password_user(cursor, enrollment, email)

    if not user:
        cursor.close()
        conn.close()
        # Security ke liye generic message rakho - ye batao mat ki ID galat hai ya email
        return jsonify({"message": "Details match nahi hue"}), 404

    otp = str(random.randint(100000, 999999))
    expires_at = datetime.datetime.utcnow() + datetime.timedelta(minutes=2)

    # purane unverified OTPs is user ke clean kar do
    cursor.execute("DELETE FROM password_resets WHERE user_id = %s", (user['id'],))
    cursor.execute(
        "INSERT INTO password_resets (user_id, otp, expires_at) VALUES (%s, %s, %s)",
        (user['id'], otp, expires_at)
    )
    conn.commit()
    cursor.close()
    conn.close()

    try:
        send_otp_email(email, otp)
    except Exception as e:
        print("OTP SEND ERROR:", repr(e))   # terminal me exact error dikhane ke liye
        return jsonify({"message": "OTP email bhejne me error aaya", "error": str(e)}), 500

    return jsonify({"message": "OTP bhej diya gaya hai aapke email par"}), 200


# ============ FORGOT PASSWORD: STEP 2 - VERIFY OTP ============
@app.route('/api/forgot-password/verify-otp', methods=['POST'])
def verify_otp():
    data = request.get_json()
    enrollment = data.get('enrollment')
    otp = data.get('otp')

    if not enrollment or not otp:
        return jsonify({"message": "ID aur OTP required hai"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    user_id = _find_user_id_by_identifier(cursor, enrollment)
    record = None
    if user_id:
        cursor.execute("""
            SELECT id, otp, expires_at FROM password_resets
            WHERE user_id = %s
            ORDER BY created_at DESC LIMIT 1
        """, (user_id,))
        record = cursor.fetchone()

    if not record:
        cursor.close()
        conn.close()
        return jsonify({"message": "Pehle OTP request karo"}), 404

    if datetime.datetime.utcnow() > record['expires_at']:
        cursor.close()
        conn.close()
        return jsonify({"message": "OTP expire ho gaya, dobara request karo"}), 410

    if record['otp'] != otp:
        cursor.close()
        conn.close()
        return jsonify({"message": "Galat OTP"}), 401

    cursor.execute("UPDATE password_resets SET is_verified = TRUE WHERE id = %s", (record['id'],))
    conn.commit()
    cursor.close()
    conn.close()

    return jsonify({"message": "OTP verify ho gaya"}), 200


# ============ FORGOT PASSWORD: STEP 3 - RESET PASSWORD ============
@app.route('/api/forgot-password/reset-password', methods=['POST'])
def reset_password():
    data = request.get_json()
    enrollment = data.get('enrollment')
    new_password = data.get('password')

    if not enrollment or not new_password:
        return jsonify({"message": "ID aur naya password required hai"}), 400

    if len(new_password) < 8:
        return jsonify({"message": "Password kam se kam 8 characters ka hona chahiye"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    resolved_user_id = _find_user_id_by_identifier(cursor, enrollment)
    record = None
    if resolved_user_id:
        cursor.execute("""
            SELECT id, is_verified, user_id FROM password_resets
            WHERE user_id = %s
            ORDER BY created_at DESC LIMIT 1
        """, (resolved_user_id,))
        record = cursor.fetchone()

    if not record or not record['is_verified']:
        cursor.close()
        conn.close()
        return jsonify({"message": "Pehle OTP verify karo"}), 403

    hashed_pw = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    cursor.execute("UPDATE users SET password_hash = %s WHERE id = %s", (hashed_pw, record['user_id']))
    # is user ke saare reset records clean kardo taaki OTP reuse na ho
    cursor.execute("DELETE FROM password_resets WHERE user_id = %s", (record['user_id'],))
    conn.commit()
    cursor.close()
    conn.close()

    return jsonify({"message": "Password successfully update ho gaya"}), 200