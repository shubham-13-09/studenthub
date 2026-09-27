from flask import request, jsonify, send_from_directory, send_file
from db import get_db
import bcrypt
import os
import re
import uuid
import io
import subprocess
from datetime import datetime
from werkzeug.utils import secure_filename
from openpyxl import Workbook
from openpyxl.styles import Font

from app import app
from auth_middleware import admin_required

# Database backup files yahan save hote hain — project ke bahar (notes/assignments jaisa pattern)
BACKUP_FOLDER = os.path.join(os.path.expanduser('~'), 'studenthub_uploads', 'db_backups')
os.makedirs(BACKUP_FOLDER, exist_ok=True)

# Notice attachments (agar admin file attach kare) yahan save hote hain — project ke bahar, notes ki tarah
NOTICE_UPLOAD_FOLDER = os.path.join(os.path.expanduser('~'), 'studenthub_uploads', 'notices')
os.makedirs(NOTICE_UPLOAD_FOLDER, exist_ok=True)
ALLOWED_NOTICE_EXTENSIONS = {'pdf', 'doc', 'docx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png'}


def _allowed_notice_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_NOTICE_EXTENSIONS


LUNCH_BREAK_START = '13:30'
LUNCH_BREAK_END = '14:00'

# Notes files yahan save hote hain (Backend/uploads/notes/)
# Notes files project folder ke BAHAR save hote hain (user ke home directory me) —
# taaki VS Code Live Server jaisa koi bhi file-watcher tool inhe "file changed" samajh ke
# poora page reload na kar de. Project folder ke andar rakhte to yehi problem aati.
NOTES_UPLOAD_FOLDER = os.path.join(os.path.expanduser('~'), 'studenthub_uploads', 'notes')
os.makedirs(NOTES_UPLOAD_FOLDER, exist_ok=True)
ALLOWED_NOTE_EXTENSIONS = {'pdf', 'doc', 'docx', 'ppt', 'pptx'}


def _allowed_note_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_NOTE_EXTENSIONS


# Assignment attachments (question paper) aur student submissions dono yahan save hote hain — project ke bahar
ASSIGNMENT_UPLOAD_FOLDER = os.path.join(os.path.expanduser('~'), 'studenthub_uploads', 'assignments')
os.makedirs(ASSIGNMENT_UPLOAD_FOLDER, exist_ok=True)
ALLOWED_ASSIGNMENT_EXTENSIONS = {'pdf', 'doc', 'docx', 'ppt', 'pptx'}


def _allowed_assignment_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_ASSIGNMENT_EXTENSIONS


# ============================================================
# DASHBOARD
# ============================================================
@app.route('/api/admin/dashboard-stats', methods=['GET'])
@admin_required
def dashboard_stats():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT COUNT(*) AS c FROM students")
    total_students = cursor.fetchone()['c']

    cursor.execute("SELECT COUNT(*) AS c FROM faculty")
    total_faculty = cursor.fetchone()['c']

    cursor.execute("SELECT COUNT(*) AS c FROM subjects")
    total_subjects = cursor.fetchone()['c']

    cursor.execute("SELECT COUNT(*) AS c FROM notices")
    total_notices = cursor.fetchone()['c']

    cursor.execute("SELECT COUNT(*) AS c FROM notices WHERE created_at >= NOW() - INTERVAL 7 DAY")
    notices_this_week = cursor.fetchone()['c']

    cursor.execute("SELECT COUNT(*) AS c FROM users WHERE role='student' AND status='active'")
    active_students = cursor.fetchone()['c']

    cursor.execute("SELECT COUNT(*) AS c FROM marks_requests WHERE status='pending'")
    pending_marks_requests = cursor.fetchone()['c']

    # Dashboard bar chart ke liye: semester-wise students
    cursor.execute("SELECT semester, COUNT(*) AS c FROM students WHERE semester IS NOT NULL GROUP BY semester ORDER BY semester")
    students_by_semester = [{"semester": r['semester'], "count": r['c']} for r in cursor.fetchall()]

    cursor.close()
    conn.close()

    return jsonify({
        "students_by_semester": students_by_semester,
        "total_students": total_students,
        "total_faculty": total_faculty,
        "total_subjects": total_subjects,
        "total_notices": total_notices,
        "notices_this_week": notices_this_week,
        "active_students": active_students,
        "pending_marks_requests": pending_marks_requests
    }), 200


# ============================================================
# SYSTEM ASSISTANT — halka data-driven assistant (koi external AI nahi).
# Admin dashboard ka card isi endpoint ko call karta hai. Keyword se sawal pehchan ke
# seedha DB se real jawab deta hai — supported: "student <naam/enrollment>",
# "faculty <naam/id>", "system summary", "pending marks requests", "report".
# ============================================================
_ASSISTANT_SKIP_TERMS = {'count', 'total', 'summary', 'list', 'overview', 'kitne', 'number', 'report'}

@app.route('/api/admin/assistant', methods=['POST'])
@admin_required
def admin_assistant():
    data = request.get_json() or {}
    raw = (data.get('message') or '').strip()
    message = raw.lower()
    if not message:
        return jsonify({"reply": "Kuch pooch to sahi! 🙂"}), 200

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        # ---- Student / Faculty lookup: "student rahul", "find faculty shah" ----
        m = re.match(r'^(?:find\s+|search\s+)?(student|faculty)s?\s+(.+)$', raw, re.IGNORECASE)
        if m and m.group(2).strip().lower() not in _ASSISTANT_SKIP_TERMS:
            kind = m.group(1).lower()
            term = '%' + m.group(2).strip() + '%'

            if kind == 'student':
                cursor.execute("""
                    SELECT u.name, u.login_id AS enrollment, u.status,
                           s.department, s.semester, s.division, s.academic_year, s.email, s.mobile
                    FROM users u JOIN students s ON s.user_id = u.id
                    WHERE u.role = 'student' AND (u.name LIKE %s OR u.login_id LIKE %s)
                    ORDER BY u.name LIMIT 5
                """, (term, term))
                rows = cursor.fetchall()
                if not rows:
                    return jsonify({"reply": "No student found with that name or enrollment number."}), 200
                lines = []
                for r in rows:
                    lines.append(
                        f"• {r['name']} ({r['enrollment']}) — Sem {r['semester'] or '-'} / Div {r['division'] or '-'}"
                        f" · {r['department'] or '-'} · {r['academic_year'] or '-'} · {r['status']}"
                        f"\n   {r['email'] or 'no email'} · {r['mobile'] or 'no mobile'}"
                    )
                return jsonify({"reply": "\n".join(lines)}), 200

            cursor.execute("""
                SELECT f.id AS faculty_row_id, u.name, u.login_id AS faculty_id, f.department, f.email, f.short_name
                FROM users u JOIN faculty f ON f.user_id = u.id
                WHERE u.role = 'faculty' AND (u.name LIKE %s OR u.login_id LIKE %s OR f.short_name LIKE %s)
                ORDER BY u.name LIMIT 5
            """, (term, term, term))
            rows = cursor.fetchall()
            if not rows:
                return jsonify({"reply": "No faculty found with that name or ID."}), 200
            lines = []
            for r in rows:
                cursor.execute("""
                    SELECT sub.subject_name, fs.semester, fs.division
                    FROM faculty_subjects fs JOIN subjects sub ON sub.id = fs.subject_id
                    WHERE fs.faculty_id = %s ORDER BY fs.semester LIMIT 6
                """, (r['faculty_row_id'],))
                subs = ", ".join(
                    f"{x['subject_name']} (Sem {x['semester']}{', Div ' + x['division'] if x['division'] else ''})"
                    for x in cursor.fetchall()
                ) or "no subject assigned"
                lines.append(f"• {r['name']} ({r['faculty_id']}) — {r['department'] or '-'} · {r['email'] or 'no email'}\n   Subjects: {subs}")
            return jsonify({"reply": "\n".join(lines)}), 200

        # ---- Pending marks requests ----
        if 'marks' in message and ('request' in message or 'pending' in message):
            cursor.execute("SELECT COUNT(*) AS c FROM marks_requests WHERE status = 'pending'")
            total = cursor.fetchone()['c']
            if not total:
                return jsonify({"reply": "There are no pending marks requests 👍"}), 200
            cursor.execute("""
                SELECT uf.name AS faculty_name, sub.subject_name, mr.exam_type, mr.semester, mr.division
                FROM marks_requests mr
                JOIN faculty f ON f.id = mr.faculty_id
                JOIN users uf ON uf.id = f.user_id
                JOIN subjects sub ON sub.id = mr.subject_id
                WHERE mr.status = 'pending'
                ORDER BY mr.submitted_at DESC LIMIT 5
            """)
            lines = [f"• {r['faculty_name']} — {r['subject_name']} ({r['exam_type']}), Sem {r['semester']} / Div {r['division'] or 'All'}"
                     for r in cursor.fetchall()]
            more = f"\n…and {total - len(lines)} more" if total > len(lines) else ""
            return jsonify({"reply": f"{total} pending marks request(s):\n" + "\n".join(lines) + more}), 200

        # ---- System summary ----
        if 'summary' in message or 'overview' in message or 'system' in message or 'status' in message:
            counts = {}
            for key, q in (
                ('students', "SELECT COUNT(*) AS c FROM students"),
                ('faculty', "SELECT COUNT(*) AS c FROM faculty"),
                ('subjects', "SELECT COUNT(*) AS c FROM subjects"),
                ('notices', "SELECT COUNT(*) AS c FROM notices WHERE created_at >= NOW() - INTERVAL 7 DAY"),
                ('pending', "SELECT COUNT(*) AS c FROM marks_requests WHERE status = 'pending'"),
            ):
                cursor.execute(q)
                counts[key] = cursor.fetchone()['c']
            reply = (f"• Students: {counts['students']}\n• Faculty: {counts['faculty']}\n• Subjects: {counts['subjects']}\n"
                     f"• Notices this week: {counts['notices']}\n• Pending marks requests: {counts['pending']}")
            return jsonify({"reply": reply}), 200

        # ---- Reports ----
        if 'report' in message:
            return jsonify({"reply": "Reports section (sidebar → Reports) me Student, Attendance, Assignment aur Login Activity ke Excel (.xlsx) reports download ho jate hain."}), 200

        return jsonify({"reply": "Main ye pooch sakta hoon:\n• student <naam ya enrollment>\n• faculty <naam ya ID>\n• system summary\n• pending marks requests\n• reports"}), 200
    except Exception as e:
        return jsonify({"reply": "Something went wrong.", "error": str(e)}), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/recent-activity', methods=['GET'])
@admin_required
def recent_activity():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("""
        (SELECT 'student_registered' AS type, u.name AS title, s.department AS detail, u.created_at
         FROM users u JOIN students s ON s.user_id = u.id
         WHERE u.role = 'student' ORDER BY u.created_at DESC LIMIT 5)
        UNION ALL
        (SELECT 'faculty_added' AS type, u.name AS title, f.department AS detail, u.created_at
         FROM users u JOIN faculty f ON f.user_id = u.id
         WHERE u.role = 'faculty' ORDER BY u.created_at DESC LIMIT 5)
        UNION ALL
        (SELECT 'notice_posted' AS type, title, category AS detail, created_at
         FROM notices ORDER BY created_at DESC LIMIT 5)
        ORDER BY created_at DESC LIMIT 8
    """)
    rows = cursor.fetchall()
    cursor.close()
    conn.close()

    for r in rows:
        r['created_at'] = r['created_at'].isoformat() if r['created_at'] else None

    return jsonify(rows), 200


# ============================================================
# STUDENT MANAGEMENT
# ============================================================
@app.route('/api/admin/students', methods=['GET'])
@admin_required
def get_students():
    department = request.args.get('department')
    semester = request.args.get('semester')
    academic_year = request.args.get('academic_year')
    division = request.args.get('division')
    search = request.args.get('search')   # header search box: naam ya enrollment se match

    query = """
        SELECT u.id, u.login_id AS enrollment, u.name, u.status,
               s.email, s.mobile, s.department, s.semester, s.division, s.academic_year, s.gender,
               s.father_name, s.father_mobile, s.mother_name, s.mother_mobile, s.parent_email, s.parent_address
        FROM users u
        JOIN students s ON s.user_id = u.id
        WHERE u.role = 'student'
    """
    params = []
    if department:
        query += " AND s.department = %s"
        params.append(department)
    if semester:
        query += " AND s.semester = %s"
        params.append(semester)
    if academic_year:
        query += " AND s.academic_year = %s"
        params.append(academic_year)
    if division:
        query += " AND s.division = %s"
        params.append(division)
    if search:
        query += " AND (u.name LIKE %s OR u.login_id LIKE %s)"
        like = f"%{search}%"
        params.extend([like, like])
    query += " ORDER BY s.academic_year DESC, s.semester ASC, u.name ASC"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    students = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(students), 200


@app.route('/api/admin/students', methods=['POST'])
@admin_required
def add_student():
    data = request.get_json()
    name = data.get('name')
    enrollment = data.get('enrollment')
    email = data.get('email')
    mobile = data.get('mobile')
    department = data.get('department')
    semester = data.get('semester')
    division = data.get('division')
    academic_year = data.get('academic_year')
    gender = data.get('gender')
    status = data.get('status', 'active')
    father_name = data.get('father_name')
    father_mobile = data.get('father_mobile')
    mother_name = data.get('mother_name')
    mother_mobile = data.get('mother_mobile')
    parent_email = data.get('parent_email')
    parent_address = data.get('parent_address')

    if not all([name, enrollment, department, semester, division]):
        return jsonify({"message": "Required fields missing"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT id FROM users WHERE login_id = %s", (enrollment,))
    if cursor.fetchone():
        cursor.close()
        conn.close()
        return jsonify({"message": "Enrollment number already exists"}), 409

    # Admin se add hue student ka default password enrollment number hi rakha
    # — student login karke settings se change kar sakta hai.
    default_password = str(enrollment)
    hashed_pw = bcrypt.hashpw(default_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    try:
        cursor.execute(
            "INSERT INTO users (login_id, password_hash, role, name, status) VALUES (%s, %s, 'student', %s, %s)",
            (enrollment, hashed_pw, name, status)
        )
        user_id = cursor.lastrowid

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
        return jsonify({"message": "Failed to add student", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Student added", "default_password": default_password}), 201


@app.route('/api/admin/students/<int:user_id>', methods=['PUT'])
@admin_required
def update_student(user_id):
    data = request.get_json()
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT id FROM users WHERE id = %s AND role='student'", (user_id,))
    if not cursor.fetchone():
        cursor.close()
        conn.close()
        return jsonify({"message": "Student not found"}), 404

    try:
        cursor.execute("UPDATE users SET name = %s WHERE id = %s", (data.get('name'), user_id))
        cursor.execute(
            """UPDATE students SET email=%s, mobile=%s, department=%s, semester=%s,
               division=%s, academic_year=%s, gender=%s,
               father_name=%s, father_mobile=%s, mother_name=%s, mother_mobile=%s,
               parent_email=%s, parent_address=%s WHERE user_id=%s""",
            (data.get('email'), data.get('mobile'), data.get('department'), data.get('semester'),
             data.get('division'), data.get('academic_year'), data.get('gender'),
             data.get('father_name'), data.get('father_mobile'), data.get('mother_name'), data.get('mother_mobile'),
             data.get('parent_email'), data.get('parent_address'), user_id)
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Update failed", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Student updated"}), 200


@app.route('/api/admin/students/<int:user_id>', methods=['DELETE'])
@admin_required
def delete_student(user_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM users WHERE id = %s AND role='student'", (user_id,))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Student not found"}), 404
    return jsonify({"message": "Student deleted"}), 200


@app.route('/api/admin/students/<int:user_id>/status', methods=['PATCH'])
@admin_required
def toggle_student_status(user_id):
    data = request.get_json()
    new_status = data.get('status')   # 'active' or 'inactive'
    if new_status not in ('active', 'inactive'):
        return jsonify({"message": "status must be active or inactive"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET status = %s WHERE id = %s AND role='student'", (new_status, user_id))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Student not found"}), 404
    return jsonify({"message": f"Student marked {new_status}"}), 200


# ============================================================
# Academic term helpers — har semester (1-6) ki apni start/end date
# academic_years table me sem1_start..sem6_end columns me store hoti hai.
# Semester 1,3,5 GTU ke Odd Term (Jul-Dec) me aate hain, 2,4,6 Even Term
# (Jan-June) me — yeh sirf year_label derive karne ke kaam aata hai.
# ============================================================
def _term_for_semester(semester):
    return 'odd' if int(semester) % 2 == 1 else 'even'


def _sem_columns(semester):
    sem = int(semester)
    return f"sem{sem}_start", f"sem{sem}_end"


def _get_academic_year_for_date_semester(cursor, date_str, semester):
    """Diye gaye semester ki date-range me di gayi date fit baithti hai to
    us academic_years row ko return karta hai, warna None."""
    start_col, end_col = _sem_columns(semester)
    cursor.execute(
        f"""SELECT id, year_label, {start_col} AS start_date, {end_col} AS end_date
            FROM academic_years
            WHERE {start_col} IS NOT NULL AND {end_col} IS NOT NULL
              AND %s BETWEEN {start_col} AND {end_col}
            LIMIT 1""",
        (date_str,)
    )
    return cursor.fetchone()


def _derive_year_label(start_date_str, semester):
    """GTU convention: Odd semester (1,3,5 → Jul-Dec) ussi calendar year se
    year_label banta hai (e.g. July 2026 -> '2026-27'); Even semester
    (2,4,6 → Jan-June) pichle calendar year se judta hai (e.g. Jan 2027 -> '2026-27')."""
    year = int(start_date_str[:4])
    if _term_for_semester(semester) == 'odd':
        return f"{year}-{str(year + 1)[2:]}"
    return f"{year - 1}-{str(year)[2:]}"


def _upsert_academic_year_semester_dates(cursor, semester, start_date, end_date):
    """Promote Semester (ya Academic Management se manually) di gayi start/end
    date ko academic_years table ke us semester ke column me save karta hai —
    row already ho to update, warna year_label date se derive karke nayi row
    bana deta hai. Dono jagah (Academic Management + Promote Semester) yehi
    function use karte hain, isliye dono hamesha sync me rehte hain."""
    year_label = _derive_year_label(start_date, semester)
    start_col, end_col = _sem_columns(semester)

    cursor.execute("SELECT id FROM academic_years WHERE year_label = %s", (year_label,))
    existing = cursor.fetchone()

    if existing:
        cursor.execute(
            f"UPDATE academic_years SET {start_col} = %s, {end_col} = %s WHERE id = %s",
            (start_date, end_date, existing['id'])
        )
    else:
        cursor.execute(
            f"INSERT INTO academic_years (year_label, {start_col}, {end_col}) VALUES (%s, %s, %s)",
            (year_label, start_date, end_date)
        )
    return year_label


@app.route('/api/admin/students/promote', methods=['POST'])
@admin_required
def promote_students():
    """
    Bulk-promote selected students by one semester.
    Diploma = 6 semesters. Students already at Sem 6 are marked
    'inactive' (graduated) instead of being pushed to a Sem 7 that
    doesn't exist. academic_year (batch) never changes here — only
    semester/status move.

    Sem 6 se neeche promote karne ke liye naye semester ki Start Date aur
    End Date dena zaroori hai — inhi se Academic Management ka academic_years
    record bhi apne aap ban/update ho jaata hai (dono jagah same data).
    Dates diye bina promotion hoti hi nahi.
    """
    data = request.get_json()
    student_ids = data.get('student_ids')  # list of users.id
    term_start_date = data.get('term_start_date')
    term_end_date = data.get('term_end_date')

    if not student_ids or not isinstance(student_ids, list):
        return jsonify({"message": "student_ids list required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    format_ids = ','.join(['%s'] * len(student_ids))
    cursor.execute(
        f"SELECT user_id, semester FROM students WHERE user_id IN ({format_ids})",
        tuple(student_ids)
    )
    rows = cursor.fetchall()

    # Sem 6 wale sirf graduate hote hain (koi naya semester nahi), unke liye date zaroori nahi.
    # Baaki kisi bhi student ko promote karna hai to date dena hi hoga.
    needs_dates = any(int(r['semester']) < 6 for r in rows)
    if needs_dates:
        if not term_start_date or not term_end_date:
            cursor.close()
            conn.close()
            return jsonify({"message": "Naye semester ki Start Date aur End Date dono dena zaroori hai"}), 400
        if term_start_date > term_end_date:
            cursor.close()
            conn.close()
            return jsonify({"message": "Start date, end date se pehle honi chahiye"}), 400

    promoted, graduated = [], []
    try:
        # Ek hi Promote action ke saare non-graduating students same current-semester
        # (isliye same target semester) ke hote hain — Student Management ki filter
        # list hamesha ek hi Dept+Sem+Batch se populate hoti hai.
        sem_dates_saved = set()
        for row in rows:
            uid = row['user_id']
            sem = int(row['semester'])
            if sem >= 6:
                cursor.execute("UPDATE users SET status = 'inactive' WHERE id = %s", (uid,))
                graduated.append(uid)
                continue

            target_sem = sem + 1

            if target_sem not in sem_dates_saved:
                _upsert_academic_year_semester_dates(cursor, target_sem, term_start_date, term_end_date)
                sem_dates_saved.add(target_sem)

            cursor.execute("UPDATE students SET semester = %s WHERE user_id = %s", (target_sem, uid))
            promoted.append(uid)
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Promotion failed", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({
        "message": f"{len(promoted)} student(s) promoted, {len(graduated)} marked graduated",
        "promoted": promoted,
        "graduated": graduated
    }), 200


# ============================================================
# FACULTY MANAGEMENT
# ============================================================
@app.route('/api/admin/faculty', methods=['GET'])
@admin_required
def get_faculty():
    academic_year = request.args.get('academic_year')
    search = request.args.get('search')   # header search box: naam ya faculty ID se match

    query = """
        SELECT u.id, u.login_id AS faculty_id, u.name, u.status, f.id AS faculty_row_id, f.email, f.department, f.short_name,
               GROUP_CONCAT(DISTINCT CONCAT(sub.subject_code, '::', sub.subject_name, '::', fs.semester, '::', COALESCE(fs.division, 'All')) SEPARATOR '||') AS subjects_assigned,
               MIN(fs.semester) AS default_semester,
               MIN(fs.academic_year) AS default_academic_year,
               MIN(fs.division) AS default_division
        FROM users u
        JOIN faculty f ON f.user_id = u.id
        LEFT JOIN faculty_subjects fs ON fs.faculty_id = f.id
        LEFT JOIN subjects sub ON sub.id = fs.subject_id
        WHERE u.role = 'faculty'
    """
    params = []
    if academic_year:
        # sirf wahi faculty dikhao jinki us batch (academic_year) me koi subject assignment hai
        query += " AND EXISTS (SELECT 1 FROM faculty_subjects fs2 WHERE fs2.faculty_id = f.id AND fs2.academic_year = %s)"
        params.append(academic_year)
    if search:
        query += " AND (u.name LIKE %s OR u.login_id LIKE %s)"
        like = f"%{search}%"
        params.extend([like, like])
    query += """
        GROUP BY u.id, u.login_id, u.name, u.status, f.id, f.email, f.department, f.short_name
        ORDER BY u.id DESC
    """

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    faculty = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(faculty), 200


@app.route('/api/admin/faculty', methods=['POST'])
@admin_required
def add_faculty():
    data = request.get_json()
    name = data.get('name')
    faculty_login_id = data.get('faculty_id')     # e.g. faculty004@123
    email = data.get('email')
    department = data.get('department')
    short_name = (data.get('short_name') or '').strip() or None   # optional

    if not all([name, faculty_login_id, department]):
        return jsonify({"message": "Required fields missing"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT id FROM users WHERE login_id = %s", (faculty_login_id,))
    if cursor.fetchone():
        cursor.close()
        conn.close()
        return jsonify({"message": "Faculty ID already exists"}), 409

    # Default password pattern: faculty#<number-part-of-id> — jaise faculty001@123 -> faculty#001
    digits = ''.join(ch for ch in faculty_login_id if ch.isdigit())
    default_password = f"faculty#{digits}" if digits else "faculty#0000"
    hashed_pw = bcrypt.hashpw(default_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    try:
        cursor.execute(
            "INSERT INTO users (login_id, password_hash, role, name) VALUES (%s, %s, 'faculty', %s)",
            (faculty_login_id, hashed_pw, name)
        )
        user_id = cursor.lastrowid
        cursor.execute(
            "INSERT INTO faculty (user_id, email, department, short_name) VALUES (%s, %s, %s, %s)",
            (user_id, email, department, short_name)
        )
        faculty_row_id = cursor.lastrowid   # faculty.id (not users.id)

        # Optional: assign one or more subjects for a semester right at creation time
        subject_ids = data.get('subject_ids') or ([data.get('subject_id')] if data.get('subject_id') else [])
        semester = data.get('semester')
        academic_year = data.get('academic_year')
        division = data.get('division') or None   # empty string = "All divisions" -> NULL
        for sid in subject_ids:
            if not sid:
                continue
            cursor.execute(
                "INSERT INTO faculty_subjects (faculty_id, subject_id, semester, academic_year, division) VALUES (%s, %s, %s, %s, %s)",
                (faculty_row_id, sid, semester, academic_year, division)
            )
        conn.commit()
    except Exception as e:
        print("ADD FACULTY ERROR:", repr(e))   # terminal me exact error dikhane ke liye
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Failed to add faculty", "error": str(e)}), 500
    cursor.close()
    conn.close()
    return jsonify({"message": "Faculty added", "default_password": default_password}), 201


@app.route('/api/admin/faculty/<int:user_id>', methods=['PUT'])
@admin_required
def update_faculty(user_id):
    data = request.get_json()
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT id FROM users WHERE id = %s AND role='faculty'", (user_id,))
    if not cursor.fetchone():
        cursor.close()
        conn.close()
        return jsonify({"message": "Faculty not found"}), 404

    try:
        cursor.execute("UPDATE users SET name = %s WHERE id = %s", (data.get('name'), user_id))
        cursor.execute(
            "UPDATE faculty SET email=%s, department=%s WHERE user_id=%s",
            (data.get('email'), data.get('department'), user_id)
        )
        # short_name optional hai — key aayi ho tabhi update karo (khali = clear)
        if 'short_name' in data:
            cursor.execute(
                "UPDATE faculty SET short_name=%s WHERE user_id=%s",
                ((data.get('short_name') or '').strip() or None, user_id)
            )

        # Selected semester+batch ke liye subjects replace karo (dusre semesters/batches ke assignments untouched rehte hain)
        semester = data.get('semester')
        subject_ids = data.get('subject_ids')
        academic_year = data.get('academic_year')
        division = data.get('division') or None   # empty string = "All divisions" -> NULL
        if semester is not None and subject_ids is not None:
            cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (user_id,))
            faculty_row = cursor.fetchone()
            faculty_row_id = faculty_row['id']

            # is semester+batch+division ke purane assignments hata do, phir naye checked subjects insert karo
            cursor.execute(
                "DELETE FROM faculty_subjects WHERE faculty_id = %s AND semester = %s AND academic_year = %s AND division <=> %s",
                (faculty_row_id, semester, academic_year, division)
            )
            for sid in subject_ids:
                if not sid:
                    continue
                cursor.execute(
                    "INSERT INTO faculty_subjects (faculty_id, subject_id, semester, academic_year, division) VALUES (%s, %s, %s, %s, %s)",
                    (faculty_row_id, sid, semester, academic_year, division)
                )

        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Update failed", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Faculty updated"}), 200


@app.route('/api/admin/faculty/<int:user_id>/subjects', methods=['GET'])
@admin_required
def get_faculty_subjects_for_semester(user_id):
    """Edit form khulte/semester ya batch badalte waqt is faculty ke us semester+batch+division ke assigned subjects laata hai."""
    semester = request.args.get('semester')
    academic_year = request.args.get('academic_year')
    division = request.args.get('division') or None
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (user_id,))
    faculty_row = cursor.fetchone()
    if not faculty_row:
        cursor.close()
        conn.close()
        return jsonify({"message": "Faculty not found"}), 404

    cursor.execute(
        "SELECT subject_id FROM faculty_subjects WHERE faculty_id = %s AND semester = %s AND academic_year = %s AND division <=> %s",
        (faculty_row['id'], semester, academic_year, division)
    )
    subject_ids = [row['subject_id'] for row in cursor.fetchall()]
    cursor.close()
    conn.close()
    return jsonify({"subject_ids": subject_ids}), 200


@app.route('/api/admin/faculty/<int:user_id>', methods=['DELETE'])
@admin_required
def delete_faculty(user_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM users WHERE id = %s AND role='faculty'", (user_id,))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Faculty not found"}), 404
    return jsonify({"message": "Faculty deleted"}), 200


# ============================================================
# SUBJECT MANAGEMENT
# ============================================================
@app.route('/api/admin/subjects', methods=['GET'])
@admin_required
def get_subjects():
    academic_year = request.args.get('academic_year')

    query = "SELECT * FROM subjects WHERE 1=1"
    params = []
    if academic_year:
        query += " AND academic_year = %s"
        params.append(academic_year)
    query += " ORDER BY id DESC"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    subjects = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(subjects), 200


@app.route('/api/admin/subjects', methods=['POST'])
@admin_required
def add_subject():
    data = request.get_json()
    subject_code = data.get('subject_code')
    subject_name = data.get('subject_name')
    department = data.get('department')
    semester = data.get('semester')
    credits = data.get('credits', 0)
    academic_year = data.get('academic_year')

    if not all([subject_code, subject_name, department, semester]):
        return jsonify({"message": "Required fields missing"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT id FROM subjects WHERE subject_code = %s", (subject_code,))
    if cursor.fetchone():
        cursor.close()
        conn.close()
        return jsonify({"message": "Subject code already exists"}), 409

    try:
        cursor.execute(
            "INSERT INTO subjects (subject_code, subject_name, department, semester, credits, academic_year) VALUES (%s,%s,%s,%s,%s,%s)",
            (subject_code, subject_name, department, semester, credits, academic_year)
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Failed to add subject", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Subject added"}), 201


@app.route('/api/admin/subjects/<int:subject_id>', methods=['PUT'])
@admin_required
def update_subject(subject_id):
    data = request.get_json()
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE subjects SET subject_name=%s, department=%s, semester=%s, credits=%s, academic_year=%s WHERE id=%s",
        (data.get('subject_name'), data.get('department'), data.get('semester'), data.get('credits'), data.get('academic_year'), subject_id)
    )
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Subject not found"}), 404
    return jsonify({"message": "Subject updated"}), 200


@app.route('/api/admin/subjects/<int:subject_id>', methods=['DELETE'])
@admin_required
def delete_subject(subject_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM subjects WHERE id = %s", (subject_id,))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Subject not found"}), 404
    return jsonify({"message": "Subject deleted"}), 200


# ============================================================
# TIMETABLE MANAGEMENT
# ============================================================

def check_timetable_clash(cursor, day, start, end, faculty_id, room_no, semester, division_list, academic_year=None, exclude_id=None):
    """Same din, overlapping time me faculty/room/division already busy to nahi — teeno check karta hai.
    division_list ek list hai (e.g. ['A','B']) — combined-lecture (multi-division) ko sahi se handle karta hai:
    sirf tabhi clash mana jayega jab divisions overlap karein (A,B wala slot sirf C se free hai, A ya B se clash karega).
    Faculty/room clash HAMESHA check hota hai (batch alag ho tab bhi ek insaan/room do jagah nahi ho sakta),
    lekin division clash sirf usi batch (academic_year) ke andar check hota hai — alag batch ka same Sem+Div
    dar-asal students ka bilkul alag group hai."""
    exclude_clause = "AND id != %s" if exclude_id else ""
    exclude_param = (exclude_id,) if exclude_id else ()

    cursor.execute(
        f"SELECT id, faculty_id, room_no, semester, division, academic_year FROM timetable "
        f"WHERE day_of_week=%s AND start_time<%s AND end_time>%s {exclude_clause}",
        (day, end, start) + exclude_param
    )
    overlapping_rows = cursor.fetchall()

    new_division_set = set(division_list)
    faculty_id_int = int(faculty_id) if faculty_id else None

    for row in overlapping_rows:
        if faculty_id_int is not None and row['faculty_id'] == faculty_id_int:
            return "Ye faculty is din is time par pehle se busy hai"

        if room_no and row['room_no'] == room_no:
            return "Ye room is din is time par pehle se book hai"

        if str(row['semester']) == str(semester) and str(row.get('academic_year') or '') == str(academic_year or ''):
            existing_division_set = set((row['division'] or '').split(','))
            if new_division_set & existing_division_set:   # koi bhi common division ho to clash
                return "In division(s) ka is din is time par pehle se koi aur subject schedule hai"

    return None


@app.route('/api/admin/timetable', methods=['GET'])
@admin_required
def get_timetable():
    academic_year = request.args.get('academic_year')

    query = """
        SELECT t.id, t.semester, t.division, t.academic_year, t.day_of_week, t.room_no,
               TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
               TIME_FORMAT(t.end_time, '%H:%i') AS end_time,
               t.subject_id, sub.subject_name, sub.subject_code,
               t.faculty_id, u.name AS faculty_name
        FROM timetable t
        LEFT JOIN subjects sub ON sub.id = t.subject_id
        LEFT JOIN faculty f ON f.id = t.faculty_id
        LEFT JOIN users u ON u.id = f.user_id
        WHERE 1=1
    """
    params = []
    if academic_year:
        query += " AND t.academic_year = %s"
        params.append(academic_year)
    query += """
        ORDER BY t.semester, t.division,
                 FIELD(t.day_of_week, 'Mon','Tue','Wed','Thu','Fri','Sat'), t.start_time
    """

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/timetable/faculty-options', methods=['GET'])
@admin_required
def get_faculty_options_for_subject():
    """Subject + semester ke hisaab se sirf wahi faculty dikhata hai jo woh subject padhate hain."""
    subject_id = request.args.get('subject_id')
    semester = request.args.get('semester')

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("""
        SELECT DISTINCT f.id AS faculty_id, u.name
        FROM faculty_subjects fs
        JOIN faculty f ON f.id = fs.faculty_id
        JOIN users u ON u.id = f.user_id
        WHERE fs.subject_id = %s AND fs.semester = %s
    """, (subject_id, semester))
    faculty = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(faculty), 200


@app.route('/api/admin/timetable', methods=['POST'])
@admin_required
def add_timetable_slot():
    data = request.get_json()
    semester = data.get('semester')
    division_list = data.get('divisions') or []   # e.g. ["A","B"] — ek se zyada divisions ka combined lecture
    subject_id = data.get('subject_id')
    faculty_id = data.get('faculty_id')
    day_of_week = data.get('day_of_week')
    start_time = data.get('start_time')
    end_time = data.get('end_time')
    room_no = data.get('room_no')
    academic_year = data.get('academic_year')

    if not all([semester, division_list, subject_id, faculty_id, day_of_week, start_time, end_time]):
        return jsonify({"message": "Required fields missing (kam se kam ek division select karo)"}), 400
    if start_time >= end_time:
        return jsonify({"message": "Start time end time se pehle hona chahiye"}), 400
    if start_time < LUNCH_BREAK_END and end_time > LUNCH_BREAK_START:
        return jsonify({"message": "1:30 PM - 2:00 PM lunch break ke liye reserved hai"}), 400

    division_str = ','.join(division_list)

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    clash = check_timetable_clash(cursor, day_of_week, start_time, end_time, faculty_id, room_no, semester, division_list, academic_year)
    if clash:
        cursor.close()
        conn.close()
        return jsonify({"message": clash}), 409

    try:
        cursor.execute("""
            INSERT INTO timetable (department, semester, division, academic_year, day_of_week, start_time, end_time, subject_id, faculty_id, room_no)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, ('computer engineering', semester, division_str, academic_year, day_of_week, start_time, end_time, subject_id, faculty_id, room_no))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Failed to add slot", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Timetable slot added"}), 201


@app.route('/api/admin/timetable/<int:slot_id>', methods=['PUT'])
@admin_required
def update_timetable_slot(slot_id):
    data = request.get_json()
    semester = data.get('semester')
    division_list = data.get('divisions') or []
    subject_id = data.get('subject_id')
    faculty_id = data.get('faculty_id')
    day_of_week = data.get('day_of_week')
    start_time = data.get('start_time')
    end_time = data.get('end_time')
    room_no = data.get('room_no')
    academic_year = data.get('academic_year')

    if not all([semester, division_list, subject_id, faculty_id, day_of_week, start_time, end_time]):
        return jsonify({"message": "Required fields missing (kam se kam ek division select karo)"}), 400
    if start_time >= end_time:
        return jsonify({"message": "Start time end time se pehle hona chahiye"}), 400
    if start_time < LUNCH_BREAK_END and end_time > LUNCH_BREAK_START:
        return jsonify({"message": "1:30 PM - 2:00 PM lunch break ke liye reserved hai"}), 400

    division_str = ','.join(division_list)

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    clash = check_timetable_clash(cursor, day_of_week, start_time, end_time, faculty_id, room_no, semester, division_list, academic_year, exclude_id=slot_id)
    if clash:
        cursor.close()
        conn.close()
        return jsonify({"message": clash}), 409

    try:
        cursor.execute("""
            UPDATE timetable SET semester=%s, division=%s, academic_year=%s, subject_id=%s, faculty_id=%s,
                   day_of_week=%s, start_time=%s, end_time=%s, room_no=%s
            WHERE id=%s
        """, (semester, division_str, academic_year, subject_id, faculty_id, day_of_week, start_time, end_time, room_no, slot_id))
        conn.commit()
        affected = cursor.rowcount
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Update failed", "error": str(e)}), 500

    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Slot not found"}), 404
    return jsonify({"message": "Timetable slot updated"}), 200


@app.route('/api/admin/timetable/<int:slot_id>', methods=['DELETE'])
@admin_required
def delete_timetable_slot(slot_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM timetable WHERE id = %s", (slot_id,))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Slot not found"}), 404
    return jsonify({"message": "Timetable slot deleted"}), 200


# ============================================================
# EXAM TIMETABLE (Mid-Sem / Remedial — structured, regular timetable ki tarah)
# ============================================================
@app.route('/api/admin/exam-timetable', methods=['GET'])
@admin_required
def get_exam_timetable():
    exam_type = request.args.get('exam_type')
    academic_year = request.args.get('academic_year')

    query = """
        SELECT e.id, e.exam_type, e.semester, e.division, e.academic_year, e.exam_date, e.room_no,
               TIME_FORMAT(e.start_time, '%H:%i') AS start_time,
               TIME_FORMAT(e.end_time, '%H:%i') AS end_time,
               e.subject_id, sub.subject_name, sub.subject_code
        FROM exam_timetable e
        LEFT JOIN subjects sub ON sub.id = e.subject_id
        WHERE 1=1
    """
    params = []
    if exam_type:
        query += " AND e.exam_type = %s"
        params.append(exam_type)
    if academic_year:
        query += " AND e.academic_year = %s"
        params.append(academic_year)
    query += " ORDER BY e.exam_date, e.start_time"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
    except Exception as e:
        cursor.close()
        conn.close()
        return jsonify({"message": "Exam timetable load nahi hui — kya 'exam_timetable' table DB me bani hai?", "error": str(e)}), 500
    for r in rows:
        if r['exam_date']:
            r['exam_date'] = r['exam_date'].isoformat()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/exam-timetable', methods=['POST'])
@admin_required
def add_exam_timetable_slot():
    data = request.get_json()
    exam_type = data.get('exam_type')
    semester = data.get('semester')
    division = data.get('division')
    academic_year = data.get('academic_year')
    exam_date = data.get('exam_date')
    start_time = data.get('start_time')
    end_time = data.get('end_time')
    subject_id = data.get('subject_id') or None
    room_no = data.get('room_no')

    if exam_type not in ('Mid-Sem', 'Remedial'):
        return jsonify({"message": "exam_type Mid-Sem ya Remedial hona chahiye"}), 400
    if not (semester and exam_date and start_time and end_time):
        return jsonify({"message": "Semester, date, start aur end time zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO exam_timetable (exam_type, semester, division, academic_year, exam_date, start_time, end_time, subject_id, room_no)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (exam_type, semester, division, academic_year, exam_date, start_time, end_time, subject_id, room_no))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"message": "Exam timetable slot added"}), 201


@app.route('/api/admin/exam-timetable/<int:slot_id>', methods=['PUT'])
@admin_required
def update_exam_timetable_slot(slot_id):
    data = request.get_json()
    exam_type = data.get('exam_type')
    semester = data.get('semester')
    division = data.get('division')
    academic_year = data.get('academic_year')
    exam_date = data.get('exam_date')
    start_time = data.get('start_time')
    end_time = data.get('end_time')
    subject_id = data.get('subject_id') or None
    room_no = data.get('room_no')

    if exam_type not in ('Mid-Sem', 'Remedial'):
        return jsonify({"message": "exam_type Mid-Sem ya Remedial hona chahiye"}), 400
    if not (semester and exam_date and start_time and end_time):
        return jsonify({"message": "Semester, date, start aur end time zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE exam_timetable SET exam_type=%s, semester=%s, division=%s, academic_year=%s,
               exam_date=%s, start_time=%s, end_time=%s, subject_id=%s, room_no=%s
        WHERE id=%s
    """, (exam_type, semester, division, academic_year, exam_date, start_time, end_time, subject_id, room_no, slot_id))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Slot not found"}), 404
    return jsonify({"message": "Exam timetable slot updated"}), 200


@app.route('/api/admin/exam-timetable/<int:slot_id>', methods=['DELETE'])
@admin_required
def delete_exam_timetable_slot(slot_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM exam_timetable WHERE id = %s", (slot_id,))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Slot not found"}), 404
    return jsonify({"message": "Exam timetable slot deleted"}), 200


# ============================================================
# ATTENDANCE MANAGEMENT
# ============================================================

@app.route('/api/admin/attendance', methods=['GET'])
@admin_required
def get_attendance_list():
    """Ek ya ek se zyada divisions (combined attendance) ke sab students, saath me diye gaye subject+date ka unka status."""
    semester = request.args.get('semester')
    divisions = request.args.get('divisions')   # comma-separated, e.g. "A,B"
    academic_year = request.args.get('academic_year')
    subject_id = request.args.get('subject_id')
    date = request.args.get('date')

    if not all([semester, divisions, subject_id, date]):
        return jsonify({"message": "semester, divisions, subject_id, date sab zaroori hain"}), 400

    division_list = divisions.split(',')
    placeholders = ','.join(['%s'] * len(division_list))

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    query = f"""
        SELECT s.id AS student_id, u.login_id AS enrollment, u.name, s.semester, s.division, s.academic_year, a.status
        FROM students s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN attendance a ON a.student_id = s.id AND a.subject_id = %s AND a.attendance_date = %s
        WHERE s.semester = %s AND s.division IN ({placeholders})
    """
    params = [subject_id, date, semester] + division_list
    if academic_year:
        query += " AND s.academic_year = %s"
        params.append(academic_year)
    query += " ORDER BY s.division ASC, u.name ASC"

    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/attendance', methods=['POST'])
@admin_required
def save_attendance():
    """Bulk mark/update — poori class ka ek din/subject ka attendance ek saath save hota hai.
    Sirf tabhi save hota hai jab diya gaya date us subject ke semester ki apni
    date-range ke andar ho (Academic Management / Promote Semester se set ki gayi)."""
    data = request.get_json()
    subject_id = data.get('subject_id')
    date = data.get('date')
    records = data.get('records') or []   # [{student_id, status}]

    if not subject_id or not date or not records:
        return jsonify({"message": "subject_id, date aur records zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT semester FROM subjects WHERE id = %s", (subject_id,))
    subject = cursor.fetchone()
    if not subject:
        cursor.close()
        conn.close()
        return jsonify({"message": "Subject nahi mila"}), 404

    if not _get_academic_year_for_date_semester(cursor, date, subject['semester']):
        cursor.close()
        conn.close()
        return jsonify({"message": f"Yeh date Sem {subject['semester']} ki date-range me nahi hai — pehle Academic Management me is semester ki start/end date set karo"}), 400

    try:
        for r in records:
            student_id = r.get('student_id')
            status = r.get('status')
            if not student_id or status not in ('present', 'absent'):
                continue
            cursor.execute("""
                INSERT INTO attendance (student_id, subject_id, attendance_date, status)
                VALUES (%s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE status = VALUES(status)
            """, (student_id, subject_id, date, status))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Attendance save failed", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Attendance saved"}), 200


@app.route('/api/admin/attendance/summary', methods=['GET'])
@admin_required
def get_attendance_summary():
    """Har student ka overall attendance % — subject_id diya ho to sirf usi subject ka, 'ALL' ho to poore semester ka combined.
    Ek se zyada divisions bhi ek saath (combined) le sakte hain."""
    semester = request.args.get('semester')
    divisions = request.args.get('divisions')   # comma-separated, e.g. "A,B"
    academic_year = request.args.get('academic_year')
    subject_id = request.args.get('subject_id')   # ID ya 'ALL'

    if not semester or not divisions:
        return jsonify({"message": "semester aur divisions zaroori hain"}), 400

    division_list = divisions.split(',')
    placeholders = ','.join(['%s'] * len(division_list))

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    subject_join = "AND a.subject_id = %s" if (subject_id and subject_id != 'ALL') else ""
    query = f"""
        SELECT s.id AS student_id, u.login_id AS enrollment, u.name, s.semester, s.division, s.academic_year,
               COUNT(a.id) AS total_classes,
               SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present_classes
        FROM students s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN attendance a ON a.student_id = s.id {subject_join}
        WHERE s.semester = %s AND s.division IN ({placeholders})
    """
    params = []
    if subject_id and subject_id != 'ALL':
        params.append(subject_id)
    params.append(semester)
    params += division_list
    if academic_year:
        query += " AND s.academic_year = %s"
        params.append(academic_year)
    query += " GROUP BY s.id, u.login_id, u.name, s.semester, s.division, s.academic_year ORDER BY s.division ASC, u.name ASC"

    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/attendance/calendar', methods=['GET'])
@admin_required
def get_attendance_calendar():
    """Ek student ke ek mahine ka din-wise status — Subject filter specific ho to usi ka,
    'ALL' ho to us din agar kisi bhi subject me absent mila to poora din 'absent' maana jata hai."""
    student_id = request.args.get('student_id')
    subject_id = request.args.get('subject_id')   # ID ya 'ALL'
    year = request.args.get('year')
    month = request.args.get('month')

    if not all([student_id, year, month]):
        return jsonify({"message": "student_id, year, month zaroori hain"}), 400

    subject_clause = "AND subject_id = %s" if (subject_id and subject_id != 'ALL') else ""
    query = f"""
        SELECT DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
               CASE WHEN SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) > 0 THEN 'absent' ELSE 'present' END AS status
        FROM attendance
        WHERE student_id = %s AND YEAR(attendance_date) = %s AND MONTH(attendance_date) = %s {subject_clause}
        GROUP BY attendance_date
    """
    params = [student_id, year, month]
    if subject_id and subject_id != 'ALL':
        params.append(subject_id)

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200

# ============================================================
# NOTES MANAGEMENT
# ============================================================

@app.route('/api/admin/notes', methods=['GET'])
@admin_required
def get_notes():
    semester = request.args.get('semester')
    subject_id = request.args.get('subject_id')
    academic_year = request.args.get('academic_year')
    search = request.args.get('search')

    query = """
        SELECT n.id, n.title, n.description, n.semester, n.division, n.academic_year,
               n.file_name, n.file_size, n.file_type, n.uploaded_at,
               n.subject_id, sub.subject_name
        FROM notes n
        LEFT JOIN subjects sub ON sub.id = n.subject_id
        WHERE 1=1
    """
    params = []
    if semester:
        query += " AND n.semester = %s"
        params.append(semester)
    if subject_id:
        query += " AND n.subject_id = %s"
        params.append(subject_id)
    if academic_year:
        query += " AND n.academic_year = %s"
        params.append(academic_year)
    if search:
        query += " AND n.title LIKE %s"
        params.append(f"%{search}%")
    query += " ORDER BY n.uploaded_at DESC"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/notes', methods=['POST'])
@admin_required
def add_note():
    """multipart/form-data — file ke saath aata hai (JSON nahi)."""
    title = request.form.get('title')
    subject_id = request.form.get('subject_id')
    semester = request.form.get('semester')
    division = request.form.get('division') or None
    academic_year = request.form.get('academic_year') or None
    description = request.form.get('description') or None
    file = request.files.get('file')

    if not title or not subject_id or not file or file.filename == '':
        return jsonify({"message": "Title, subject aur file zaroori hain"}), 400

    if not _allowed_note_file(file.filename):
        return jsonify({"message": "Sirf PDF, DOC, DOCX, PPT, PPTX files allowed hain"}), 400

    original_name = secure_filename(file.filename)
    file_ext = original_name.rsplit('.', 1)[1].lower()
    unique_name = f"{uuid.uuid4().hex}.{file_ext}"   # disk pe collision se bachne ke liye unique naam
    save_path = os.path.join(NOTES_UPLOAD_FOLDER, unique_name)

    file.save(save_path)
    file_size = os.path.getsize(save_path)

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT INTO notes (subject_id, title, description, semester, division, academic_year, file_path, file_name, file_size, file_type)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (subject_id, title, description, semester, division, academic_year, unique_name, original_name, file_size, file_ext))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        if os.path.exists(save_path):
            os.remove(save_path)   # DB save fail hua to orphan file disk pe mat chodo
        return jsonify({"message": "Note save nahi hua", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Note uploaded"}), 201


@app.route('/api/admin/notes/<int:note_id>', methods=['PUT'])
@admin_required
def update_note(note_id):
    """Sirf details edit hoti hain (title/subject/semester/division/description) — file replace nahi hoti."""
    data = request.get_json()
    title = data.get('title')
    subject_id = data.get('subject_id')
    semester = data.get('semester')
    division = data.get('division') or None
    academic_year = data.get('academic_year') or None
    description = data.get('description') or None

    if not title or not subject_id:
        return jsonify({"message": "Title aur subject zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE notes SET title=%s, subject_id=%s, semester=%s, division=%s, academic_year=%s, description=%s
        WHERE id=%s
    """, (title, subject_id, semester, division, academic_year, description, note_id))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()

    if affected == 0:
        return jsonify({"message": "Note not found"}), 404
    return jsonify({"message": "Note updated"}), 200


@app.route('/api/admin/notes/<int:note_id>', methods=['DELETE'])
@admin_required
def delete_note(note_id):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT file_path FROM notes WHERE id = %s", (note_id,))
    note = cursor.fetchone()
    if not note:
        cursor.close()
        conn.close()
        return jsonify({"message": "Note not found"}), 404

    cursor.execute("DELETE FROM notes WHERE id = %s", (note_id,))
    conn.commit()
    cursor.close()
    conn.close()

    file_path = os.path.join(NOTES_UPLOAD_FOLDER, note['file_path'])
    if os.path.exists(file_path):
        os.remove(file_path)   # DB record ke saath actual file bhi delete karo

    return jsonify({"message": "Note deleted"}), 200


@app.route('/api/admin/notes/<int:note_id>/download', methods=['GET'])
@admin_required
def download_note(note_id):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT file_path, file_name FROM notes WHERE id = %s", (note_id,))
    note = cursor.fetchone()
    cursor.close()
    conn.close()

    if not note:
        return jsonify({"message": "Note not found"}), 404

    return send_from_directory(
        NOTES_UPLOAD_FOLDER,
        note['file_path'],
        as_attachment=True,
        download_name=note['file_name']
    )


# ============================================================
# ASSIGNMENT MANAGEMENT
# ============================================================

@app.route('/api/admin/assignments', methods=['GET'])
@admin_required
def get_assignments():
    semester = request.args.get('semester')
    subject_id = request.args.get('subject_id')
    division = request.args.get('division')
    academic_year = request.args.get('academic_year')
    search = request.args.get('search')

    query = """
        SELECT a.id, a.title, a.description, a.semester, a.division, a.academic_year,
               DATE_FORMAT(a.due_date, '%Y-%m-%d') AS due_date,
               a.file_name, a.file_size, a.file_type, a.created_at,
               a.subject_id, sub.subject_name,
               COUNT(DISTINCT asub.id) AS submission_count
        FROM assignments a
        LEFT JOIN subjects sub ON sub.id = a.subject_id
        LEFT JOIN assignment_submissions asub ON asub.assignment_id = a.id
        WHERE 1=1
    """
    params = []
    if semester:
        query += " AND a.semester = %s"
        params.append(semester)
    if subject_id:
        query += " AND a.subject_id = %s"
        params.append(subject_id)
    if division:
        # Us division ki assignments + "All divisions" wali (division NULL) — dono dikhengi,
        # kyunki "All divisions" wali bhi is division ke students pe apply hoti hain
        query += " AND (a.division = %s OR a.division IS NULL)"
        params.append(division)
    if academic_year:
        query += " AND a.academic_year = %s"
        params.append(academic_year)
    if search:
        query += " AND a.title LIKE %s"
        params.append(f"%{search}%")
    query += " GROUP BY a.id, a.title, a.description, a.semester, a.division, a.academic_year, a.due_date, a.file_name, a.file_size, a.file_type, a.created_at, a.subject_id, sub.subject_name"
    query += " ORDER BY a.due_date ASC, a.created_at DESC"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/assignments', methods=['POST'])
@admin_required
def add_assignment():
    """multipart/form-data — attachment file OPTIONAL hai (Notes ke ulat, yahan file na ho tab bhi assignment save ho sakti hai)."""
    title = request.form.get('title')
    subject_id = request.form.get('subject_id')
    semester = request.form.get('semester')
    division = request.form.get('division') or None
    academic_year = request.form.get('academic_year') or None
    description = request.form.get('description') or None
    due_date = request.form.get('due_date') or None
    file = request.files.get('file')

    if not title or not subject_id:
        return jsonify({"message": "Title aur subject zaroori hain"}), 400

    unique_name = None
    original_name = None
    file_size = None
    file_ext = None

    if file and file.filename:
        if not _allowed_assignment_file(file.filename):
            return jsonify({"message": "Sirf PDF, DOC, DOCX, PPT, PPTX files allowed hain"}), 400
        original_name = secure_filename(file.filename)
        file_ext = original_name.rsplit('.', 1)[1].lower()
        unique_name = f"{uuid.uuid4().hex}.{file_ext}"
        save_path = os.path.join(ASSIGNMENT_UPLOAD_FOLDER, unique_name)
        file.save(save_path)
        file_size = os.path.getsize(save_path)

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT INTO assignments (subject_id, title, description, semester, division, academic_year, due_date, file_path, file_name, file_size, file_type)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (subject_id, title, description, semester, division, academic_year, due_date, unique_name, original_name, file_size, file_ext))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        if unique_name:
            save_path = os.path.join(ASSIGNMENT_UPLOAD_FOLDER, unique_name)
            if os.path.exists(save_path):
                os.remove(save_path)
        return jsonify({"message": "Assignment save nahi hui", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Assignment added"}), 201


@app.route('/api/admin/assignments/<int:assignment_id>', methods=['PUT'])
@admin_required
def update_assignment(assignment_id):
    """Sirf details edit hoti hain — attachment file replace nahi hoti (Notes wale pattern jaisa)."""
    data = request.get_json()
    title = data.get('title')
    subject_id = data.get('subject_id')
    semester = data.get('semester')
    division = data.get('division') or None
    academic_year = data.get('academic_year') or None
    description = data.get('description') or None
    due_date = data.get('due_date') or None

    if not title or not subject_id:
        return jsonify({"message": "Title aur subject zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE assignments SET title=%s, subject_id=%s, semester=%s, division=%s, academic_year=%s, description=%s, due_date=%s
        WHERE id=%s
    """, (title, subject_id, semester, division, academic_year, description, due_date, assignment_id))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()

    if affected == 0:
        return jsonify({"message": "Assignment not found"}), 404
    return jsonify({"message": "Assignment updated"}), 200


@app.route('/api/admin/assignments/<int:assignment_id>', methods=['DELETE'])
@admin_required
def delete_assignment(assignment_id):
    """Assignment delete hone par uski attachment file, aur assignment_submissions (CASCADE se DB khud hata dega) — lekin
    submissions ki actual files disk se bhi hatani padengi, isliye pehle unke paths le lo."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT file_path FROM assignments WHERE id = %s", (assignment_id,))
    assignment = cursor.fetchone()
    if not assignment:
        cursor.close()
        conn.close()
        return jsonify({"message": "Assignment not found"}), 404

    cursor.execute("SELECT file_path FROM assignment_submissions WHERE assignment_id = %s", (assignment_id,))
    submission_files = [row['file_path'] for row in cursor.fetchall() if row['file_path']]

    cursor.execute("DELETE FROM assignments WHERE id = %s", (assignment_id,))
    conn.commit()
    cursor.close()
    conn.close()

    if assignment['file_path']:
        p = os.path.join(ASSIGNMENT_UPLOAD_FOLDER, assignment['file_path'])
        if os.path.exists(p):
            os.remove(p)
    for fp in submission_files:
        p = os.path.join(ASSIGNMENT_UPLOAD_FOLDER, fp)
        if os.path.exists(p):
            os.remove(p)

    return jsonify({"message": "Assignment deleted"}), 200


@app.route('/api/admin/assignments/<int:assignment_id>/download', methods=['GET'])
@admin_required
def download_assignment(assignment_id):
    """Assignment ka attachment (question paper) download karta hai."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT file_path, file_name FROM assignments WHERE id = %s", (assignment_id,))
    assignment = cursor.fetchone()
    cursor.close()
    conn.close()

    if not assignment or not assignment['file_path']:
        return jsonify({"message": "File not found"}), 404

    return send_from_directory(
        ASSIGNMENT_UPLOAD_FOLDER,
        assignment['file_path'],
        as_attachment=True,
        download_name=assignment['file_name']
    )


@app.route('/api/admin/assignments/<int:assignment_id>/submissions', methods=['GET'])
@admin_required
def get_assignment_submissions(assignment_id):
    """Assignment ke semester+division ke sab eligible students, saath me unka submission status/marks (agar submit kiya ho)."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT semester, division, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date FROM assignments WHERE id = %s", (assignment_id,))
    assignment = cursor.fetchone()
    if not assignment:
        cursor.close()
        conn.close()
        return jsonify({"message": "Assignment not found"}), 404

    query = """
        SELECT s.id AS student_id, u.login_id AS enrollment, u.name,
               asub.id AS submission_id, DATE_FORMAT(asub.submitted_at, '%Y-%m-%d') AS submitted_at,
               asub.marks_obtained
        FROM students s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN assignment_submissions asub ON asub.student_id = s.id AND asub.assignment_id = %s
        WHERE s.semester = %s
    """
    params = [assignment_id, assignment['semester']]
    if assignment['division']:
        query += " AND s.division = %s"
        params.append(assignment['division'])
    query += " ORDER BY u.name ASC"

    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    for row in rows:
        row['due_date'] = assignment['due_date']   # har row me due_date bhi bhej do, taaki frontend Late vs On-time calculate kar sake
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/assignments/submissions/<int:submission_id>/marks', methods=['PUT'])
@admin_required
def update_submission_marks(submission_id):
    data = request.get_json()
    marks = data.get('marks_obtained')

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE assignment_submissions SET marks_obtained = %s WHERE id = %s", (marks, submission_id))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()

    if affected == 0:
        return jsonify({"message": "Submission not found"}), 404
    return jsonify({"message": "Marks updated"}), 200


@app.route('/api/admin/assignments/<int:assignment_id>/submissions/<int:student_id>', methods=['PUT'])
@admin_required
def upsert_submission(assignment_id, student_id):
    """Admin/Faculty manually ek student ka submission status set karta hai — Submitted/Late/Pending, saath me marks.
    Student panel se real upload aane se pehle bhi records manage karne ke liye (jaise offline/hardcopy submission)."""
    data = request.get_json()
    submitted = data.get('submitted', True)
    submitted_at = data.get('submitted_at')   # 'YYYY-MM-DD'
    marks = data.get('marks_obtained')

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute(
        "SELECT id FROM assignment_submissions WHERE assignment_id = %s AND student_id = %s",
        (assignment_id, student_id)
    )
    existing = cursor.fetchone()

    if not submitted:
        # "Pending" par wapas set karna hai — record hi hata do (agar tha)
        if existing:
            cursor.execute("DELETE FROM assignment_submissions WHERE id = %s", (existing['id'],))
            conn.commit()
        cursor.close()
        conn.close()
        return jsonify({"message": "Marked as pending"}), 200

    if not submitted_at:
        from datetime import date
        submitted_at = date.today().isoformat()   # date nahi di to aaj ki date default

    if existing:
        cursor.execute(
            "UPDATE assignment_submissions SET submitted_at = %s, marks_obtained = %s WHERE id = %s",
            (submitted_at, marks, existing['id'])
        )
    else:
        cursor.execute(
            "INSERT INTO assignment_submissions (assignment_id, student_id, submitted_at, marks_obtained) VALUES (%s,%s,%s,%s)",
            (assignment_id, student_id, submitted_at, marks)
        )
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"message": "Submission updated"}), 200


@app.route('/api/admin/assignments/submissions/<int:submission_id>/download', methods=['GET'])
@admin_required
def download_submission(submission_id):
    """Ek student ki submitted file download karta hai."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT file_path, file_name FROM assignment_submissions WHERE id = %s", (submission_id,))
    submission = cursor.fetchone()
    cursor.close()
    conn.close()

    if not submission or not submission['file_path']:
        return jsonify({"message": "File not found"}), 404

    return send_from_directory(
        ASSIGNMENT_UPLOAD_FOLDER,
        submission['file_path'],
        as_attachment=True,
        download_name=submission['file_name']
    )

# ============================================================
# MARKS MANAGEMENT
# ============================================================

@app.route('/api/admin/marks/students', methods=['GET'])
@admin_required
def get_marks_students():
    """Ek semester+division ke sab students, saath me diye gaye subject+exam ka unka already-entered marks (agar ho)."""
    semester = request.args.get('semester')
    division = request.args.get('division')
    subject_id = request.args.get('subject_id')
    exam_type = request.args.get('exam_type')
    academic_year = request.args.get('academic_year')

    if not all([semester, division, subject_id, exam_type, academic_year]):
        return jsonify({"message": "semester, division, batch, subject_id, exam_type sab zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("""
        SELECT s.id AS student_id, u.login_id AS enrollment, u.name, s.semester, s.division, s.academic_year,
               m.id AS marks_id, m.marks_obtained, m.max_marks, m.published
        FROM students s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN marks m ON m.student_id = s.id AND m.subject_id = %s AND m.exam_type = %s
                          AND m.semester = %s AND m.academic_year = %s
        WHERE s.semester = %s AND s.division = %s AND s.academic_year = %s
        ORDER BY u.login_id
    """, (subject_id, exam_type, semester, academic_year, semester, division, academic_year))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/marks/bulk', methods=['POST'])
@admin_required
def save_marks_bulk():
    """Poori class ke marks ek saath save/update karta hai — jaise Attendance ka bulk-save."""
    data = request.get_json()
    semester = data.get('semester')
    subject_id = data.get('subject_id')
    exam_type = data.get('exam_type')
    max_marks = data.get('max_marks')
    academic_year = data.get('academic_year')
    records = data.get('records') or []   # [{student_id, marks_obtained}]

    if not all([semester, subject_id, exam_type, max_marks, academic_year]) or not records:
        return jsonify({"message": "Semester, subject, exam, batch, max marks aur records zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        for r in records:
            student_id = r.get('student_id')
            marks_obtained = r.get('marks_obtained')
            if student_id is None or marks_obtained is None or marks_obtained == '':
                continue

            cursor.execute(
                "SELECT id FROM marks WHERE student_id = %s AND subject_id = %s AND exam_type = %s AND semester = %s AND academic_year = %s",
                (student_id, subject_id, exam_type, semester, academic_year)
            )
            existing = cursor.fetchone()

            if existing:
                cursor.execute(
                    "UPDATE marks SET marks_obtained = %s, max_marks = %s WHERE id = %s",
                    (marks_obtained, max_marks, existing['id'])
                )
            else:
                cursor.execute(
                    "INSERT INTO marks (student_id, subject_id, exam_type, marks_obtained, max_marks, semester, academic_year) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (student_id, subject_id, exam_type, marks_obtained, max_marks, semester, academic_year)
                )
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Marks save nahi hui", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Marks saved"}), 200


@app.route('/api/admin/marks/publish', methods=['PUT'])
@admin_required
def toggle_marks_publish():
    """Filter me jo semester+division+subject+exam currently dikh raha hai, uska poora result ek saath publish/unpublish karta hai."""
    data = request.get_json()
    semester = data.get('semester')
    division = data.get('division')
    subject_id = data.get('subject_id')
    exam_type = data.get('exam_type')
    academic_year = data.get('academic_year')
    published = data.get('published', True)

    if not all([semester, division, subject_id, exam_type, academic_year]):
        return jsonify({"message": "semester, division, batch, subject_id, exam_type zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE marks m
        JOIN students s ON s.id = m.student_id
        SET m.published = %s
        WHERE m.semester = %s AND m.subject_id = %s AND m.exam_type = %s AND m.academic_year = %s AND s.division = %s
    """, (published, semester, subject_id, exam_type, academic_year, division))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    return jsonify({"message": "Publish status updated", "affected": affected}), 200


# ============================================================
# MARKS REQUESTS (faculty submissions ka approval workflow)
# pending -> approved (faculty ko notice) -> published (students+faculty ko dikhta hai)
#         -> rejected (faculty ko notice, wapas edit kar sakta hai)
# ============================================================
def _notify_faculty(cursor, faculty_user_id, title, content):
    """Faculty ke naam ek personal notice bhejta hai (target_user_id set) — Notices feed me dikhega."""
    cursor.execute("""
        INSERT INTO notices (title, content, category, target_role, target_user_id, posted_by)
        VALUES (%s, %s, 'Academic', 'faculty', %s, %s)
    """, (title, content, faculty_user_id, request.user['user_id']))


@app.route('/api/admin/marks/requests', methods=['GET'])
@admin_required
def get_marks_requests():
    """Query param: status (pending/approved/rejected/published). Default: pending.
    Sabhi requests ki list — faculty naam, subject, exam, division, kitne students, submit date ke saath."""
    status = request.args.get('status', 'pending')

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("""
        SELECT
            mr.id, mr.exam_type, mr.semester, mr.division, mr.academic_year,
            mr.max_marks, mr.status, mr.submitted_at, mr.reviewed_at, mr.remarks,
            uf.name AS faculty_name,
            sub.subject_name, sub.subject_code,
            (SELECT COUNT(*) FROM marks m WHERE m.request_id = mr.id) AS student_count
        FROM marks_requests mr
        JOIN faculty f ON f.id = mr.faculty_id
        JOIN users uf ON uf.id = f.user_id
        JOIN subjects sub ON sub.id = mr.subject_id
        WHERE mr.status = %s
        ORDER BY mr.submitted_at DESC
    """, (status,))
    requests_list = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify({"requests": requests_list}), 200


@app.route('/api/admin/marks/requests/<int:request_id>', methods=['GET'])
@admin_required
def get_marks_request_detail(request_id):
    """Ek request ke andar har student ka marks — review karte waqt dikhane ke liye."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("""
        SELECT
            mr.id, mr.exam_type, mr.semester, mr.division, mr.academic_year, mr.max_marks,
            mr.status, mr.submitted_at, mr.remarks,
            uf.name AS faculty_name,
            sub.subject_name, sub.subject_code
        FROM marks_requests mr
        JOIN faculty f ON f.id = mr.faculty_id
        JOIN users uf ON uf.id = f.user_id
        JOIN subjects sub ON sub.id = mr.subject_id
        WHERE mr.id = %s
    """, (request_id,))
    req = cursor.fetchone()
    if not req:
        cursor.close()
        conn.close()
        return jsonify({"message": "Request nahi mili"}), 404

    cursor.execute("""
        SELECT u.login_id AS enrollment, u.name, m.marks_obtained
        FROM marks m
        JOIN students s ON s.id = m.student_id
        JOIN users u ON u.id = s.user_id
        WHERE m.request_id = %s
        ORDER BY u.name ASC
    """, (request_id,))
    req['students'] = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(req), 200


@app.route('/api/admin/marks/requests/<int:request_id>/decision', methods=['PUT'])
@admin_required
def decide_marks_request(request_id):
    """Body: { decision: 'approved' | 'rejected', remarks (optional, rejected ke liye recommended) }.
    Approve/Reject karte hi faculty ko personal notice chala jaata hai."""
    data = request.get_json() or {}
    decision = data.get('decision')
    remarks = data.get('remarks') or None

    if decision not in ('approved', 'rejected'):
        return jsonify({"message": "decision 'approved' ya 'rejected' hona chahiye"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("""
            SELECT mr.*, uf.id AS faculty_user_id, sub.subject_name
            FROM marks_requests mr
            JOIN faculty f ON f.id = mr.faculty_id
            JOIN users uf ON uf.id = f.user_id
            JOIN subjects sub ON sub.id = mr.subject_id
            WHERE mr.id = %s
        """, (request_id,))
        req = cursor.fetchone()
        if not req:
            return jsonify({"message": "Request nahi mili"}), 404
        if req['status'] != 'pending':
            return jsonify({"message": f"Yeh request already '{req['status']}' hai"}), 409

        cursor.execute("""
            UPDATE marks_requests
            SET status = %s, reviewed_at = NOW(), reviewed_by = %s, remarks = %s
            WHERE id = %s
        """, (decision, request.user['user_id'], remarks, request_id))

        if decision == 'approved':
            title = f"Marks request accepted — {req['subject_name']} ({req['exam_type']})"
            content = f"Aapki {req['subject_name']} ke {req['exam_type']} marks ki request accept ho gayi hai. Publish hote hi students ko dikhegi."
        else:
            title = f"Marks request rejected — {req['subject_name']} ({req['exam_type']})"
            content = f"Aapki {req['subject_name']} ke {req['exam_type']} marks ki request reject ho gayi hai."
            if remarks:
                content += f" Reason: {remarks}"
            content += " Aap dobara edit karke submit kar sakte hain."
        _notify_faculty(cursor, req['faculty_user_id'], title, content)

        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Decision save nahi hui", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": f"Request {decision}"}), 200


@app.route('/api/admin/marks/requests/<int:request_id>/publish', methods=['PUT'])
@admin_required
def publish_marks_request(request_id):
    """Sirf 'approved' request publish ho sakti hai. Publish hote hi is request ke sab marks students ko dikhne lagte hain."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT * FROM marks_requests WHERE id = %s", (request_id,))
        req = cursor.fetchone()
        if not req:
            return jsonify({"message": "Request nahi mili"}), 404
        if req['status'] != 'approved':
            return jsonify({"message": "Sirf 'approved' request publish ho sakti hai"}), 409

        cursor.execute("UPDATE marks_requests SET status = 'published' WHERE id = %s", (request_id,))
        cursor.execute("UPDATE marks SET published = TRUE WHERE request_id = %s", (request_id,))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Publish nahi hua", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Marks published"}), 200


# ============================================================
# FEE MANAGEMENT
# ============================================================
@app.route('/api/admin/fees/students', methods=['GET'])
@admin_required
def get_fee_students():
    """Fee record add karte waqt Student dropdown (aur 'apply to whole class') ke liye students ki list."""
    semester = request.args.get('semester')
    division = request.args.get('division')
    academic_year = request.args.get('academic_year')

    if not semester:
        return jsonify({"message": "semester zaroori hai"}), 400

    query = """
        SELECT s.id AS student_id, u.login_id AS enrollment, u.name
        FROM students s
        JOIN users u ON u.id = s.user_id
        WHERE s.semester = %s AND u.status = 'active'
    """
    params = [semester]
    if division:
        query += " AND s.division = %s"
        params.append(division)
    if academic_year:
        query += " AND s.academic_year = %s"
        params.append(academic_year)
    query += " ORDER BY u.name ASC"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/fees', methods=['GET'])
@admin_required
def get_fees():
    status = request.args.get('status')
    semester = request.args.get('semester')
    division = request.args.get('division')
    academic_year = request.args.get('academic_year')
    search = request.args.get('search')

    query = """
        SELECT f.id, f.fee_title, f.amount, DATE_FORMAT(f.due_date, '%Y-%m-%d') AS due_date, f.semester, f.academic_year,
               f.status, f.payment_link, DATE_FORMAT(f.paid_at, '%Y-%m-%d %H:%i:%s') AS paid_at,
               s.id AS student_id, u.login_id AS enrollment, u.name AS student_name, s.division
        FROM fees f
        JOIN students s ON s.id = f.student_id
        JOIN users u ON u.id = s.user_id
        WHERE 1=1
    """
    params = []
    if status:
        query += " AND f.status = %s"
        params.append(status)
    if semester:
        query += " AND f.semester = %s"
        params.append(semester)
    if division:
        query += " AND s.division = %s"
        params.append(division)
    if academic_year:
        query += " AND f.academic_year = %s"
        params.append(academic_year)
    if search:
        query += " AND (u.name LIKE %s OR u.login_id LIKE %s OR f.fee_title LIKE %s)"
        like = f"%{search}%"
        params += [like, like, like]
    query += " ORDER BY f.due_date IS NULL, f.due_date ASC, u.name ASC"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/fees', methods=['POST'])
@admin_required
def add_fee():
    """
    Ek student ke liye fee record banata hai, ya 'student_ids' list de kar
    poori class (semester+division) ke liye ek saath (bulk) bana sakte ho.
    """
    data = request.get_json()
    fee_title = data.get('fee_title')
    amount = data.get('amount')
    due_date = data.get('due_date') or None
    semester = data.get('semester') or None
    academic_year = data.get('academic_year') or None
    payment_link = data.get('payment_link') or None
    status = data.get('status') or 'unpaid'

    student_ids = data.get('student_ids')
    if not student_ids:
        single_id = data.get('student_id')
        student_ids = [single_id] if single_id else []

    if not fee_title or amount in (None, '') or not student_ids:
        return jsonify({"message": "Fee item, amount aur kam se kam ek student zaroori hai"}), 400

    if status not in ('paid', 'unpaid'):
        status = 'unpaid'

    conn = get_db()
    cursor = conn.cursor()
    try:
        created = 0
        paid_at_val = datetime.now() if status == 'paid' else None
        for student_id in student_ids:
            cursor.execute("""
                INSERT INTO fees (student_id, fee_title, amount, due_date, semester, academic_year, status, payment_link, paid_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                student_id, fee_title, amount, due_date, semester, academic_year, status, payment_link,
                paid_at_val
            ))
            created += 1
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Fee record save nahi hua", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": f"{created} fee record(s) created"}), 201


@app.route('/api/admin/fees/<int:fee_id>', methods=['PUT'])
@admin_required
def update_fee(fee_id):
    data = request.get_json()
    fee_title = data.get('fee_title')
    amount = data.get('amount')
    due_date = data.get('due_date') or None
    payment_link = data.get('payment_link') or None
    status = data.get('status')

    if not fee_title or amount in (None, ''):
        return jsonify({"message": "Fee item aur amount zaroori hai"}), 400

    conn = get_db()
    cursor = conn.cursor()

    if status in ('paid', 'unpaid'):
        cursor.execute("""
            UPDATE fees
            SET fee_title=%s, amount=%s, due_date=%s, payment_link=%s, status=%s,
                paid_at = CASE WHEN %s='paid' AND status='unpaid' THEN CURRENT_TIMESTAMP
                               WHEN %s='unpaid' THEN NULL
                               ELSE paid_at END
            WHERE id=%s
        """, (fee_title, amount, due_date, payment_link, status, status, status, fee_id))
    else:
        cursor.execute("""
            UPDATE fees SET fee_title=%s, amount=%s, due_date=%s, payment_link=%s WHERE id=%s
        """, (fee_title, amount, due_date, payment_link, fee_id))

    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Fee record nahi mila"}), 404
    return jsonify({"message": "Fee record updated"}), 200


@app.route('/api/admin/fees/<int:fee_id>/status', methods=['PATCH'])
@admin_required
def toggle_fee_status(fee_id):
    data = request.get_json()
    new_status = data.get('status')
    if new_status not in ('paid', 'unpaid'):
        return jsonify({"message": "status must be paid or unpaid"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE fees SET status=%s, paid_at = CASE WHEN %s='paid' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=%s",
        (new_status, new_status, fee_id)
    )
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Fee record nahi mila"}), 404
    return jsonify({"message": f"Fee marked {new_status}"}), 200


@app.route('/api/admin/fees/folder', methods=['DELETE'])
@admin_required
def delete_fee_folder():
    """Ek poore Fee folder (Semester + Division + Batch group) ke saare fee records
    ek saath delete karta hai. Fees table me khud 'division' column nahi hai (woh
    student ki row se aata hai, get_fees() ki tarah), isliye students se join karke
    match karte hain. division query param na bheja jaye to sirf woh records match
    honge jinke student ki division NULL hai ('All'/unset division waala folder).
    Optional fee_title param diya jaye to us batch ke andar sirf us title ke sub-folder
    ka delete hota hai (poora batch nahi) -- Fee Management ki nested folder view ke liye."""
    semester = request.args.get('semester')
    academic_year = request.args.get('academic_year')
    division = request.args.get('division') or None
    fee_title = request.args.get('fee_title') or None

    if not semester or not academic_year:
        return jsonify({"message": "semester and academic_year are required"}), 400

    conn = get_db()
    cursor = conn.cursor()
    try:
        query = """
            DELETE f FROM fees f
            JOIN students s ON s.id = f.student_id
            WHERE f.semester = %s AND f.academic_year = %s
        """
        params = [semester, academic_year]
        if division:
            query += " AND s.division = %s"
            params.append(division)
        else:
            query += " AND s.division IS NULL"
        if fee_title:
            query += " AND f.fee_title = %s"
            params.append(fee_title)

        cursor.execute(query, tuple(params))
        deleted = cursor.rowcount
        conn.commit()
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Folder could not be deleted", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

    if deleted == 0:
        return jsonify({"message": "No fee records found for this folder"}), 404
    return jsonify({"message": f"{deleted} fee record(s) deleted"}), 200


@app.route('/api/admin/fees/<int:fee_id>', methods=['DELETE'])
@admin_required
def delete_fee(fee_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM fees WHERE id=%s", (fee_id,))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Fee record nahi mila"}), 404
    return jsonify({"message": "Fee record deleted"}), 200


# ============================================================
# Notification bell — naye notices + naye pending marks requests
# "since" (last dropdown khola tha) ke baad kitne naye aaye, wahi count
# hota hai. Dropdown khulte hi frontend naya "since" save kar deta hai,
# isliye seen karte hi red dot chala jaata hai.
# ============================================================
@app.route('/api/admin/notifications', methods=['GET'])
@admin_required
def get_notifications():
    since = request.args.get('since')   # ISO datetime string ya None (pehli baar)

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    if since:
        cursor.execute("SELECT COUNT(*) AS c FROM notices WHERE created_at > %s", (since,))
        unseen_notices = cursor.fetchone()['c']
        cursor.execute("SELECT COUNT(*) AS c FROM marks_requests WHERE status = 'pending' AND submitted_at > %s", (since,))
        unseen_marks = cursor.fetchone()['c']
    else:
        cursor.execute("SELECT COUNT(*) AS c FROM notices")
        unseen_notices = cursor.fetchone()['c']
        cursor.execute("SELECT COUNT(*) AS c FROM marks_requests WHERE status = 'pending'")
        unseen_marks = cursor.fetchone()['c']

    cursor.execute("SELECT title, created_at FROM notices ORDER BY created_at DESC LIMIT 5")
    recent_notices = cursor.fetchall()

    cursor.execute("""
        SELECT mr.id, mr.exam_type, mr.submitted_at, sub.subject_name
        FROM marks_requests mr
        JOIN subjects sub ON sub.id = mr.subject_id
        WHERE mr.status = 'pending'
        ORDER BY mr.submitted_at DESC LIMIT 5
    """)
    recent_marks_requests = cursor.fetchall()

    cursor.close()
    conn.close()
    return jsonify({
        "unseen_count": unseen_notices + unseen_marks,
        "recent_notices": recent_notices,
        "recent_marks_requests": recent_marks_requests
    }), 200


# ============================================================
# NOTICE MANAGEMENT
# ============================================================
@app.route('/api/admin/notices', methods=['GET'])
@admin_required
def get_notices():
    category = request.args.get('category')
    target_role = request.args.get('target_role')
    semester = request.args.get('semester')
    division = request.args.get('division')
    academic_year = request.args.get('academic_year')

    query = """SELECT n.id, n.title, n.content, n.category, n.target_role, n.semester, n.division, n.academic_year,
                      n.is_pinned, n.file_name, n.file_size, n.file_type, n.created_at, COUNT(nr.id) AS seen_count
               FROM notices n
               LEFT JOIN notice_reads nr ON nr.notice_id = n.id
               WHERE 1=1"""
    params = []
    if category:
        query += " AND category = %s"
        params.append(category)
    if target_role:
        query += " AND target_role = %s"
        params.append(target_role)
    if semester:
        query += " AND (semester = %s OR semester IS NULL)"
        params.append(semester)
    if division:
        query += " AND (division = %s OR division IS NULL)"
        params.append(division)
    if academic_year:
        query += " AND (academic_year = %s OR academic_year IS NULL)"
        params.append(academic_year)
    query += " GROUP BY n.id ORDER BY n.is_pinned DESC, n.created_at DESC"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/notices', methods=['POST'])
@admin_required
def add_notice():
    """multipart/form-data — attachment optional hai (JSON nahi, kyunki file bhi aa sakti hai)."""
    title = request.form.get('title')
    content = request.form.get('content')
    category = request.form.get('category') or 'Academic'
    target_role = request.form.get('target_role') or 'all'
    semester = request.form.get('semester') or None
    division = request.form.get('division') or None
    academic_year = request.form.get('academic_year') or None
    is_pinned = request.form.get('is_pinned') in ('1', 'true', 'True')
    file = request.files.get('file')

    if not title:
        return jsonify({"message": "Title zaroori hai"}), 400
    if target_role not in ('all', 'student', 'faculty'):
        return jsonify({"message": "target_role must be all, student or faculty"}), 400

    file_path = file_name = file_size = file_type = None
    if file and file.filename:
        if not _allowed_notice_file(file.filename):
            return jsonify({"message": "Sirf PDF, DOC, DOCX, PPT, PPTX, JPG, PNG files allowed hain"}), 400
        original_name = secure_filename(file.filename)
        file_ext = original_name.rsplit('.', 1)[1].lower()
        unique_name = f"{uuid.uuid4().hex}.{file_ext}"   # disk pe collision se bachne ke liye unique naam
        save_path = os.path.join(NOTICE_UPLOAD_FOLDER, unique_name)
        file.save(save_path)
        file_path = unique_name
        file_name = original_name
        file_size = os.path.getsize(save_path)
        file_type = file_ext

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT INTO notices (title, content, category, target_role, semester, division, academic_year, posted_by, is_pinned, file_path, file_name, file_size, file_type)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (title, content, category, target_role, semester, division, academic_year, request.user['user_id'], is_pinned, file_path, file_name, file_size, file_type))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        if file_path and os.path.exists(os.path.join(NOTICE_UPLOAD_FOLDER, file_path)):
            os.remove(os.path.join(NOTICE_UPLOAD_FOLDER, file_path))   # DB save fail hua to orphan file disk pe mat chodo
        return jsonify({"message": "Notice save nahi hua", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Notice published"}), 201


@app.route('/api/admin/notices/<int:notice_id>', methods=['PUT'])
@admin_required
def update_notice(notice_id):
    data = request.get_json()
    title = data.get('title')
    content = data.get('content')
    category = data.get('category') or 'Academic'
    target_role = data.get('target_role') or 'all'
    semester = data.get('semester') or None
    division = data.get('division') or None
    academic_year = data.get('academic_year') or None
    is_pinned = bool(data.get('is_pinned'))

    if not title:
        return jsonify({"message": "Title zaroori hai"}), 400
    if target_role not in ('all', 'student', 'faculty'):
        return jsonify({"message": "target_role must be all, student or faculty"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE notices SET title=%s, content=%s, category=%s, target_role=%s, semester=%s, division=%s, academic_year=%s, is_pinned=%s
        WHERE id=%s
    """, (title, content, category, target_role, semester, division, academic_year, is_pinned, notice_id))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Notice nahi mila"}), 404
    return jsonify({"message": "Notice updated"}), 200


@app.route('/api/admin/notices/<int:notice_id>/pin', methods=['PATCH'])
@admin_required
def toggle_notice_pin(notice_id):
    data = request.get_json()
    is_pinned = bool(data.get('is_pinned'))

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE notices SET is_pinned=%s WHERE id=%s", (is_pinned, notice_id))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Notice nahi mila"}), 404
    return jsonify({"message": f"Notice {'pinned' if is_pinned else 'unpinned'}"}), 200


@app.route('/api/admin/notices/<int:notice_id>', methods=['DELETE'])
@admin_required
def delete_notice(notice_id):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT file_path FROM notices WHERE id = %s", (notice_id,))
    notice = cursor.fetchone()

    cursor.execute("DELETE FROM notices WHERE id=%s", (notice_id,))
    conn.commit()
    affected = cursor.rowcount
    cursor.close()
    conn.close()
    if affected == 0:
        return jsonify({"message": "Notice nahi mila"}), 404

    if notice and notice['file_path']:
        file_path = os.path.join(NOTICE_UPLOAD_FOLDER, notice['file_path'])
        if os.path.exists(file_path):
            os.remove(file_path)   # DB record ke saath attachment bhi delete karo

    return jsonify({"message": "Notice deleted"}), 200


@app.route('/api/admin/notices/<int:notice_id>/download', methods=['GET'])
@admin_required
def download_notice_file(notice_id):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT file_path, file_name FROM notices WHERE id = %s", (notice_id,))
    notice = cursor.fetchone()
    cursor.close()
    conn.close()

    if not notice or not notice['file_path']:
        return jsonify({"message": "Attachment nahi mila"}), 404

    return send_from_directory(
        NOTICE_UPLOAD_FOLDER,
        notice['file_path'],
        as_attachment=True,
        download_name=notice['file_name']
    )


@app.route('/api/admin/notices/mark-read', methods=['POST'])
@admin_required
def mark_admin_notices_read():
    """Notices tab khulte hi call hota hai — dusron (jaise faculty) ki post ki hui sabhi notices
    ko is admin ke naam se 'seen' mark karta hai, taaki faculty ko 'Seen by' list me admin dikhe.
    Admin ki apni post ki hui notices skip hoti hain (poster ka khud ka seen count nahi hota)."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        admin_id = request.user['user_id']
        cursor.execute("""
            INSERT IGNORE INTO notice_reads (notice_id, user_id)
            SELECT n.id, %s
            FROM notices n
            WHERE n.posted_by IS NOT NULL AND n.posted_by <> %s
        """, (admin_id, admin_id))
        conn.commit()
        return jsonify({"message": "Marked as read"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Failed to mark as read", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/notices/<int:notice_id>/reads', methods=['GET'])
@admin_required
def get_notice_reads(notice_id):
    """Kis kis (student/faculty) ne ye notice dekh liya hai, uski list + target audience ka total count."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT * FROM notices WHERE id = %s", (notice_id,))
    notice = cursor.fetchone()
    if not notice:
        cursor.close()
        conn.close()
        return jsonify({"message": "Notice nahi mila"}), 404

    # Jinhone dekh liya, unki list (naam, enrollment/login id, role, kab dekha)
    cursor.execute("""
        SELECT u.id AS user_id, u.name, u.login_id, u.role, nr.seen_at
        FROM notice_reads nr
        JOIN users u ON u.id = nr.user_id
        WHERE nr.notice_id = %s
        ORDER BY nr.seen_at DESC
    """, (notice_id,))
    seen_by = cursor.fetchall()

    # Target audience ka total count — kise notice dikhna chahiye tha
    target_total = 0
    if notice['target_role'] in ('all', 'student'):
        q = "SELECT COUNT(*) AS c FROM students WHERE 1=1"
        p = []
        if notice['semester'] is not None:
            q += " AND semester = %s"
            p.append(notice['semester'])
        if notice['division']:
            q += " AND division = %s"
            p.append(notice['division'])
        if notice['academic_year']:
            q += " AND academic_year = %s"
            p.append(notice['academic_year'])
        cursor.execute(q, tuple(p))
        target_total += cursor.fetchone()['c']
    if notice['target_role'] in ('all', 'faculty'):
        cursor.execute("SELECT COUNT(*) AS c FROM faculty")
        target_total += cursor.fetchone()['c']

    cursor.close()
    conn.close()
    return jsonify({
        "notice_id": notice_id,
        "seen_count": len(seen_by),
        "target_total": target_total,
        "seen_by": seen_by
    }), 200

# ============================================================
# Admin Settings — College & Department info (system_settings key-value table)
# ============================================================
ADMIN_SETTINGS_KEYS = ['college_name', 'college_address', 'college_email', 'department_name', 'hod_name']

@app.route('/api/admin/settings', methods=['GET'])
@admin_required
def get_admin_settings():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    placeholders = ','.join(['%s'] * len(ADMIN_SETTINGS_KEYS))
    cursor.execute(f"SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ({placeholders})", tuple(ADMIN_SETTINGS_KEYS))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()

    settings = {k: '' for k in ADMIN_SETTINGS_KEYS}
    for row in rows:
        settings[row['setting_key']] = row['setting_value']
    return jsonify(settings), 200


@app.route('/api/admin/settings', methods=['PUT'])
@admin_required
def update_admin_settings():
    data = request.get_json() or {}

    college_email = data.get('college_email')
    if college_email and ('@' not in college_email or '.' not in college_email.split('@')[-1]):
        return jsonify({"message": "College email ID valid nahi hai"}), 400

    conn = get_db()
    cursor = conn.cursor()
    try:
        for key in ADMIN_SETTINGS_KEYS:
            if key in data:
                cursor.execute(
                    "INSERT INTO system_settings (setting_key, setting_value) VALUES (%s, %s) "
                    "ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
                    (key, data.get(key))
                )
        conn.commit()
    except Exception as e:
        print("UPDATE ADMIN SETTINGS ERROR:", repr(e))
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Failed to save settings", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Settings saved"}), 200


# ============================================================
# Admin Security — Change password + Login history
# ============================================================
@app.route('/api/admin/change-password', methods=['PUT'])
@admin_required
def admin_change_password():
    data = request.get_json()
    current_password = data.get('current_password')
    new_password = data.get('new_password')

    if not current_password or not new_password:
        return jsonify({"message": "Current aur new password dono required hain"}), 400
    if len(new_password) < 8:
        return jsonify({"message": "New password kam se kam 8 characters ka hona chahiye"}), 400

    user_id = request.user['user_id']
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT password_hash FROM users WHERE id = %s", (user_id,))
    user = cursor.fetchone()

    if not user or not bcrypt.checkpw(current_password.encode('utf-8'), user['password_hash'].encode('utf-8')):
        cursor.close()
        conn.close()
        return jsonify({"message": "Current password galat hai"}), 401

    new_hash = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    cursor.execute("UPDATE users SET password_hash = %s WHERE id = %s", (new_hash, user_id))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"message": "Password updated"}), 200


@app.route('/api/admin/login-history', methods=['GET'])
@admin_required
def get_login_history():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        """SELECT lh.login_time, lh.ip_address, u.name, u.role
           FROM login_history lh
           JOIN users u ON u.id = lh.user_id
           WHERE lh.login_time >= (NOW() - INTERVAL 1 MONTH)
           ORDER BY lh.login_time DESC"""
    )
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    # login_time ko plain string bhejna zaroori hai, warna Flask ka jsonify() ise
    # GMT maan ke serialize kar deta hai aur browser me time galat (aage) dikhta hai
    for r in rows:
        if r.get('login_time'):
            r['login_time'] = r['login_time'].strftime('%Y-%m-%d %H:%M:%S')
    return jsonify(rows), 200


# ============================================================
# Academic Year management — har year ke 6 semesters ki apni-apni date
# ============================================================
_SEM_COLS = [f"sem{n}_start" for n in range(1, 7)] + [f"sem{n}_end" for n in range(1, 7)]


@app.route('/api/admin/academic-years', methods=['GET'])
@admin_required
def get_academic_years():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        f"SELECT id, year_label, {', '.join(_SEM_COLS)} FROM academic_years ORDER BY year_label DESC"
    )
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/academic-years/term-dates', methods=['GET'])
@admin_required
def get_term_dates_for_semester():
    """Promote Semester form ke liye — diye gaye (target) semester ki date
    already kisi academic_years row me set hai aur aaj ki date uske range
    me hai, to woh dates wapas karta hai (form me pre-fill hone ke liye),
    taaki admin galti se purani date overwrite na kar de."""
    semester = request.args.get('semester')
    if not semester:
        return jsonify({"message": "semester query param required hai"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    today = datetime.now().strftime('%Y-%m-%d')
    year_row = _get_academic_year_for_date_semester(cursor, today, semester)
    cursor.close()
    conn.close()

    if not year_row:
        return jsonify({"start": None, "end": None}), 200
    return jsonify({"start": str(year_row['start_date']), "end": str(year_row['end_date'])}), 200


@app.route('/api/admin/academic-years', methods=['POST'])
@admin_required
def add_academic_year():
    """Academic Management se manually bhi kisi bhi semester (1-6) ki date daali
    ja sakti hai — yeh Promote Semester wale hi row/columns update karta hai,
    isliye dono jagah hamesha sync me rehte hain."""
    data = request.get_json()
    year_label = (data.get('year_label') or '').strip()

    if not year_label:
        return jsonify({"message": "Academic year required hai (e.g. 2027-28)"}), 400

    sem_values = {}
    for n in range(1, 7):
        sem_values[f"sem{n}_start"] = data.get(f"sem{n}_start") or None
        sem_values[f"sem{n}_end"] = data.get(f"sem{n}_end") or None

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT id FROM academic_years WHERE year_label = %s", (year_label,))
    existing = cursor.fetchone()

    try:
        if existing:
            set_clause = ', '.join(f"{col} = %s" for col in sem_values)
            cursor.execute(
                f"UPDATE academic_years SET {set_clause} WHERE id = %s",
                tuple(sem_values.values()) + (existing['id'],)
            )
        else:
            cols = ', '.join(sem_values.keys())
            placeholders = ', '.join(['%s'] * len(sem_values))
            cursor.execute(
                f"INSERT INTO academic_years (year_label, {cols}) VALUES (%s, {placeholders})",
                (year_label,) + tuple(sem_values.values())
            )
        conn.commit()
    except Exception as e:
        print("ADD ACADEMIC YEAR ERROR:", repr(e))
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Add nahi hua", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Academic year saved"}), 201


@app.route('/api/admin/academic-years/<int:year_id>', methods=['DELETE'])
@admin_required
def delete_academic_year(year_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM academic_years WHERE id = %s", (year_id,))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"message": "Academic year deleted"}), 200


# ============================================================
# Divisions — live summary (department + semester + division wise
# student count, seedha `students` table se; koi alag master table nahi)
# ============================================================
@app.route('/api/admin/divisions-summary', methods=['GET'])
@admin_required
def get_divisions_summary():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        """SELECT department, semester, division, COUNT(*) AS student_count
           FROM students
           WHERE division IS NOT NULL AND division != ''
           GROUP BY department, semester, division
           ORDER BY department, semester, division"""
    )
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


# ============================================================
# REPORTS — Student, Attendance, Assignment, Login Activity
# Saare reports Excel (.xlsx) file ke roop me directly download hote hain.
# ============================================================

# Admin ka direct marks-entry form "Mid-Sem" bhejta hai, Faculty ka marks
# submission form "Mid-Semester" bhejta hai — dono same exam hain, isliye
# report banate waqt yahan normalize kar dete hain taaki ek hi column bane.
_EXAM_TYPE_DISPLAY = {
    'mid-sem': 'Mid-Sem',
    'mid-semester': 'Mid-Sem',
    'remedial': 'Remedial',
    'internal': 'Internal',
    'practical': 'Practical',
}


def _normalize_exam_type(exam_type):
    return _EXAM_TYPE_DISPLAY.get((exam_type or '').strip().lower(), exam_type)


def _excel_response(headers, rows, filename):
    """headers: list of column names. rows: list of tuples/lists (same order as headers).
    Bold header row, auto column width, aur .xlsx file seedha download ke liye bhej deta hai."""
    wb = Workbook()
    ws = wb.active
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(row)

    # Column width auto-fit (content ki lambai ke hisaab se, rough estimate)
    for col_idx, header in enumerate(headers, start=1):
        max_len = len(str(header))
        for row in rows:
            val = row[col_idx - 1]
            max_len = max(max_len, len(str(val)) if val is not None else 0)
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = min(max_len + 4, 40)

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return send_file(
        buffer,
        as_attachment=True,
        download_name=filename,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )


@app.route('/api/admin/reports/students/excel', methods=['GET'])
@admin_required
def report_students_excel():
    """Student Report — ek specific subject ke liye required (marks/attendance
    dono subject-wise store hote hain, isliye subject select karna zaroori hai)."""
    academic_year = request.args.get('academic_year')
    semester = request.args.get('semester')
    division = request.args.get('division')
    subject_id = request.args.get('subject_id')

    if not academic_year or not semester or not subject_id:
        return jsonify({"message": "academic_year, semester aur subject_id zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT subject_name, department FROM subjects WHERE id = %s", (subject_id,))
    subject = cursor.fetchone()
    if not subject:
        cursor.close()
        conn.close()
        return jsonify({"message": "Subject nahi mila"}), 404

    query = """
        SELECT u.id AS user_id, u.login_id AS enrollment, u.name
        FROM users u
        JOIN students s ON s.user_id = u.id
        WHERE u.role = 'student' AND s.academic_year = %s AND s.semester = %s AND s.department = %s
    """
    params = [academic_year, semester, subject['department']]
    if division:
        query += " AND s.division = %s"
        params.append(division)
    query += " ORDER BY u.name ASC"
    cursor.execute(query, tuple(params))
    students = cursor.fetchall()

    # Attendance % — sirf isi subject ka
    cursor.execute("""
        SELECT s.user_id,
               SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present_count,
               COUNT(*) AS total_count
        FROM attendance a
        JOIN students s ON s.id = a.student_id
        WHERE a.subject_id = %s
        GROUP BY s.user_id
    """, (subject_id,))
    attendance_map = {row['user_id']: row for row in cursor.fetchall()}

    # Marks — sirf isi subject ke, exam_type normalize karke
    cursor.execute("""
        SELECT s.user_id, m.exam_type, m.marks_obtained, m.max_marks
        FROM marks m
        JOIN students s ON s.id = m.student_id
        WHERE m.subject_id = %s AND m.published = TRUE
    """, (subject_id,))
    marks_map = {}
    for row in cursor.fetchall():
        marks_map.setdefault(row['user_id'], {})[_normalize_exam_type(row['exam_type'])] = row['marks_obtained']

    cursor.close()
    conn.close()

    headers = ["Name", "Enrollment", "Attendance %", "Mid-Sem", "Remedial", "Internal", "Practical"]
    rows = []
    for st in students:
        uid = st['user_id']
        att = attendance_map.get(uid)
        att_pct = round((att['present_count'] / att['total_count']) * 100, 1) if att and att['total_count'] else 'N/A'
        marks = marks_map.get(uid, {})
        rows.append([
            st['name'], st['enrollment'], att_pct,
            marks.get('Mid-Sem', '-'), marks.get('Remedial', '-'),
            marks.get('Internal', '-'), marks.get('Practical', '-')
        ])

    filename = f"student_report_{subject['subject_name']}_sem{semester}_{academic_year}.xlsx".replace(' ', '_')
    return _excel_response(headers, rows, filename)


@app.route('/api/admin/reports/attendance/excel', methods=['GET'])
@admin_required
def report_attendance_excel():
    """Attendance Report — subject_id diya to us subject ka %, warna us
    semester ke saare subjects ka combined/overall % (jo GTU ki 75% eligibility
    check ke liye zyada kaam ka hota hai)."""
    academic_year = request.args.get('academic_year')
    semester = request.args.get('semester')
    division = request.args.get('division')
    subject_id = request.args.get('subject_id')

    if not academic_year or not semester:
        return jsonify({"message": "academic_year aur semester zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    dept_filter = ""
    dept_params = []
    if subject_id:
        cursor.execute("SELECT department FROM subjects WHERE id = %s", (subject_id,))
        subj = cursor.fetchone()
        if not subj:
            cursor.close()
            conn.close()
            return jsonify({"message": "Subject nahi mila"}), 404
        dept_filter = " AND s.department = %s"
        dept_params = [subj['department']]

    query = f"""
        SELECT u.id AS user_id, u.login_id AS enrollment, u.name
        FROM users u
        JOIN students s ON s.user_id = u.id
        WHERE u.role = 'student' AND s.academic_year = %s AND s.semester = %s {dept_filter}
    """
    params = [academic_year, semester] + dept_params
    if division:
        query += " AND s.division = %s"
        params.append(division)
    query += " ORDER BY u.name ASC"
    cursor.execute(query, tuple(params))
    students = cursor.fetchall()

    if subject_id:
        cursor.execute("""
            SELECT s.user_id,
                   SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present_count,
                   COUNT(*) AS total_count
            FROM attendance a
            JOIN students s ON s.id = a.student_id
            WHERE a.subject_id = %s
            GROUP BY s.user_id
        """, (subject_id,))
    else:
        # Us semester+batch ke saare subjects ka combined attendance
        cursor.execute("""
            SELECT s.user_id,
                   SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present_count,
                   COUNT(*) AS total_count
            FROM attendance a
            JOIN students s ON s.id = a.student_id
            JOIN subjects sub ON sub.id = a.subject_id
            WHERE sub.semester = %s AND sub.academic_year = %s
            GROUP BY s.user_id
        """, (semester, academic_year))
    attendance_map = {row['user_id']: row for row in cursor.fetchall()}

    cursor.close()
    conn.close()

    headers = ["Name", "Enrollment", "Attendance %"]
    rows = []
    for st in students:
        att = attendance_map.get(st['user_id'])
        att_pct = round((att['present_count'] / att['total_count']) * 100, 1) if att and att['total_count'] else 'N/A'
        rows.append([st['name'], st['enrollment'], att_pct])

    scope = "subject" if subject_id else "overall"
    filename = f"attendance_report_{scope}_sem{semester}_{academic_year}.xlsx".replace(' ', '_')
    return _excel_response(headers, rows, filename)


@app.route('/api/admin/reports/assignments/excel', methods=['GET'])
@admin_required
def report_assignments_excel():
    """Assignment Report — ek row per student per assignment: submit kiya ya
    nahi, kab kiya, late tha ya on-time, marks mile ya nahi."""
    academic_year = request.args.get('academic_year')
    semester = request.args.get('semester')
    division = request.args.get('division')
    subject_id = request.args.get('subject_id')

    if not academic_year or not semester:
        return jsonify({"message": "academic_year aur semester zaroori hain"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    query = """
        SELECT a.id, a.title, a.due_date, a.division, sub.subject_name
        FROM assignments a
        JOIN subjects sub ON sub.id = a.subject_id
        WHERE a.academic_year = %s AND a.semester = %s
    """
    params = [academic_year, semester]
    if division:
        query += " AND (a.division = %s OR a.division IS NULL)"
        params.append(division)
    if subject_id:
        query += " AND a.subject_id = %s"
        params.append(subject_id)
    query += " ORDER BY a.due_date DESC"
    cursor.execute(query, tuple(params))
    assignments = cursor.fetchall()

    headers = ["Assignment", "Subject", "Due Date", "Student Name", "Enrollment", "Submitted", "Submission Date", "Status", "Marks Obtained"]
    rows = []

    for a in assignments:
        student_query = """
            SELECT u.id AS user_id, u.login_id AS enrollment, u.name
            FROM users u
            JOIN students s ON s.user_id = u.id
            JOIN subjects sub ON sub.department = s.department
            WHERE u.role = 'student' AND s.academic_year = %s AND s.semester = %s AND sub.id = (
                SELECT subject_id FROM assignments WHERE id = %s
            )
        """
        sparams = [academic_year, semester, a['id']]
        if a['division']:
            student_query += " AND s.division = %s"
            sparams.append(a['division'])
        student_query += " ORDER BY u.name ASC"
        cursor.execute(student_query, tuple(sparams))
        class_students = cursor.fetchall()

        cursor.execute("""
            SELECT student_id, submitted_at, marks_obtained
            FROM assignment_submissions WHERE assignment_id = %s
        """, (a['id'],))
        sub_map = {}
        for row in cursor.fetchall():
            cursor.execute("SELECT user_id FROM students WHERE id = %s", (row['student_id'],))
            uid_row = cursor.fetchone()
            if uid_row:
                sub_map[uid_row['user_id']] = row

        for st in class_students:
            sub = sub_map.get(st['user_id'])
            if sub:
                submitted_date = sub['submitted_at'].strftime('%Y-%m-%d') if sub['submitted_at'] else '-'
                status = 'Late' if a['due_date'] and sub['submitted_at'] and sub['submitted_at'].date() > a['due_date'] else 'On-time'
                rows.append([a['title'], a['subject_name'], str(a['due_date']) if a['due_date'] else '-',
                             st['name'], st['enrollment'], 'Yes', submitted_date, status,
                             sub['marks_obtained'] if sub['marks_obtained'] is not None else '-'])
            else:
                rows.append([a['title'], a['subject_name'], str(a['due_date']) if a['due_date'] else '-',
                             st['name'], st['enrollment'], 'No', '-', 'Not Submitted', '-'])

    cursor.close()
    conn.close()

    filename = f"assignment_report_sem{semester}_{academic_year}.xlsx".replace(' ', '_')
    return _excel_response(headers, rows, filename)


@app.route('/api/admin/reports/login-activity/excel', methods=['GET'])
@admin_required
def report_login_activity_excel():
    from_date = request.args.get('from_date')
    to_date = request.args.get('to_date')
    role = request.args.get('role')

    query = """
        SELECT u.name, u.role, u.login_id, lh.login_time, lh.ip_address
        FROM login_history lh
        JOIN users u ON u.id = lh.user_id
        WHERE 1=1
    """
    params = []
    if from_date:
        query += " AND lh.login_time >= %s"
        params.append(from_date + " 00:00:00")
    if to_date:
        query += " AND lh.login_time <= %s"
        params.append(to_date + " 23:59:59")
    if role:
        query += " AND u.role = %s"
        params.append(role)
    query += " ORDER BY lh.login_time DESC"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    logs = cursor.fetchall()
    cursor.close()
    conn.close()

    headers = ["Name", "Role", "Login ID", "Date", "Time", "IP Address"]
    rows = [
        [l['name'], l['role'].title(), l['login_id'],
         l['login_time'].strftime('%Y-%m-%d'), l['login_time'].strftime('%H:%M:%S'), l['ip_address'] or '-']
        for l in logs
    ]

    filename = "login_activity_report.xlsx"
    return _excel_response(headers, rows, filename)


# ============================================================
# Database Backup & Restore
# mysqldump/mysql command-line tools server pe PATH me hone chahiye
# (XAMPP/WAMP/local MySQL install me yeh default already hota hai).
# ============================================================
def _get_db_credentials():
    return {
        'host': os.getenv('DB_HOST', 'localhost'),
        'user': os.getenv('DB_USER', 'root'),
        'password': os.getenv('DB_PASSWORD', ''),
        'database': os.getenv('DB_NAME', 'studenthub'),
    }


def _run_mysqldump(filepath):
    """Current database ko diye gaye filepath pe .sql dump kar deta hai.
    Success par (True, None), fail par (False, error_message) return karta hai."""
    creds = _get_db_credentials()
    env = os.environ.copy()
    if creds['password']:
        env['MYSQL_PWD'] = creds['password']   # -p command-line pe nahi, env var se (process list me na dikhe)

    try:
        with open(filepath, 'wb') as f:
            result = subprocess.run(
                ['mysqldump', '-h', creds['host'], '-u', creds['user'], creds['database']],
                stdout=f, stderr=subprocess.PIPE, env=env, timeout=300
            )
        if result.returncode != 0:
            if os.path.exists(filepath):
                os.remove(filepath)
            return False, result.stderr.decode('utf-8', errors='ignore')
        return True, None
    except FileNotFoundError:
        return False, "mysqldump command nahi mila — MySQL client tools server pe install/PATH me hone chahiye"
    except subprocess.TimeoutExpired:
        return False, "Backup timeout ho gaya (5 min se zyada le raha tha)"


@app.route('/api/admin/backup', methods=['POST'])
@admin_required
def create_backup():
    timestamp = datetime.now().strftime('%Y-%m-%d_%H%M%S')
    filename = f"studenthub_backup_{timestamp}.sql"
    filepath = os.path.join(BACKUP_FOLDER, filename)

    ok, error = _run_mysqldump(filepath)
    if not ok:
        return jsonify({"message": "Backup fail hua", "error": error}), 500

    return jsonify({"message": "Backup ban gaya", "filename": filename}), 201


@app.route('/api/admin/backups', methods=['GET'])
@admin_required
def list_backups():
    files = []
    for fname in os.listdir(BACKUP_FOLDER):
        if fname.endswith('.sql'):
            fpath = os.path.join(BACKUP_FOLDER, fname)
            stat = os.stat(fpath)
            files.append({
                "filename": fname,
                "size_kb": round(stat.st_size / 1024, 1),
                "created_at": datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M:%S')
            })
    files.sort(key=lambda f: f['created_at'], reverse=True)
    return jsonify(files), 200


@app.route('/api/admin/backups/<path:filename>/download', methods=['GET'])
@admin_required
def download_backup(filename):
    safe_name = secure_filename(filename)
    if not os.path.exists(os.path.join(BACKUP_FOLDER, safe_name)):
        return jsonify({"message": "Backup file nahi mila"}), 404
    return send_from_directory(BACKUP_FOLDER, safe_name, as_attachment=True, download_name=safe_name)


@app.route('/api/admin/backups/<path:filename>', methods=['DELETE'])
@admin_required
def delete_backup(filename):
    safe_name = secure_filename(filename)
    fpath = os.path.join(BACKUP_FOLDER, safe_name)
    if not os.path.exists(fpath):
        return jsonify({"message": "Backup file nahi mila"}), 404
    os.remove(fpath)
    return jsonify({"message": "Backup deleted"}), 200


@app.route('/api/admin/restore', methods=['POST'])
@admin_required
def restore_backup():
    """DESTRUCTIVE — poora current database overwrite ho jaata hai. Isliye:
    1) 'RESTORE' likh ke confirm karna zaroori hai (frontend se aata hai)
    2) Restore se pehle current state ka ek safety backup khud-ba-khud ban jaata hai,
       taaki restore galat file se ho jaaye to bhi wapas aaya ja sake."""
    confirm_text = request.form.get('confirm')
    if confirm_text != 'RESTORE':
        return jsonify({"message": "Confirmation text 'RESTORE' match nahi hua"}), 400

    existing_filename = request.form.get('existing_filename')
    if existing_filename:
        safe_name = secure_filename(existing_filename)
        filepath = os.path.join(BACKUP_FOLDER, safe_name)
        if not os.path.exists(filepath):
            return jsonify({"message": "Backup file nahi mila"}), 404
    else:
        file = request.files.get('file')
        if not file or not file.filename.lower().endswith('.sql'):
            return jsonify({"message": "Valid .sql file upload karo"}), 400
        safe_name = secure_filename(file.filename)
        filepath = os.path.join(BACKUP_FOLDER, f"uploaded_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{safe_name}")
        file.save(filepath)

    # Safety backup — restore se theek pehle current DB ki state save kar lo
    safety_filename = f"studenthub_pre_restore_safety_{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.sql"
    safety_path = os.path.join(BACKUP_FOLDER, safety_filename)
    safety_ok, _ = _run_mysqldump(safety_path)

    creds = _get_db_credentials()
    env = os.environ.copy()
    if creds['password']:
        env['MYSQL_PWD'] = creds['password']

    try:
        with open(filepath, 'rb') as f:
            result = subprocess.run(
                ['mysql', '-h', creds['host'], '-u', creds['user'], creds['database']],
                stdin=f, stderr=subprocess.PIPE, env=env, timeout=300
            )
        if result.returncode != 0:
            return jsonify({
                "message": "Restore fail hua — database purani state me hi hai (koi nuksan nahi hua)",
                "error": result.stderr.decode('utf-8', errors='ignore')
            }), 500
    except FileNotFoundError:
        return jsonify({"message": "mysql command nahi mila — MySQL client tools server pe install/PATH me hone chahiye"}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"message": "Restore timeout ho gaya"}), 500

    return jsonify({
        "message": "Database restore ho gaya" + (f" (safety backup: {safety_filename})" if safety_ok else " (safety backup nahi ban paya — dhyan rakhna)"),
        "safety_backup": safety_filename if safety_ok else None
    }), 200