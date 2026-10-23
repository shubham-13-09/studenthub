from flask import request, jsonify, send_from_directory, send_file
from db import get_db
import bcrypt
import os
import re
import uuid
import io
import zipfile
import subprocess
import threading
from datetime import datetime, timedelta
from werkzeug.utils import secure_filename
from openpyxl import Workbook
from openpyxl.styles import Font

from app import app, send_plain_emails
from auth_middleware import admin_required, is_default_password
from session_routes import get_admin_session_block_reason, same_text as _same_text
from chatbot_helper import find_faq_answer, get_fallback_reply, log_chat, logged_assistant, get_user_chat_history

# Database backup files are saved here — outside the project (same pattern as notes/assignments)
BACKUP_FOLDER = os.path.join(os.path.expanduser('~'), 'studenthub_uploads', 'db_backups')
os.makedirs(BACKUP_FOLDER, exist_ok=True)

# Notice attachments (if the admin attaches a file) are saved here — outside the project, like notes
NOTICE_UPLOAD_FOLDER = os.path.join(os.path.expanduser('~'), 'studenthub_uploads', 'notices')
os.makedirs(NOTICE_UPLOAD_FOLDER, exist_ok=True)
ALLOWED_NOTICE_EXTENSIONS = {'pdf', 'doc', 'docx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png'}

def _chunks(seq, size=500):
    """Splits a list into pieces of at most `size` (so an IN (...) list never gets huge)."""
    seq = list(seq)
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _norm_id(value):
    """12 and '12' are the same record id (JSON may send either); anything that is not a whole number is kept as it is."""
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return value


def _is_valid_office_zip(file_obj, folder):
    """docx/pptx are zip files: a real one has [Content_Types].xml and a word/ (or ppt/) folder inside.
    A plain .zip (or any other zip-based file) just renamed to .docx/.pptx fails this check."""
    try:
        with zipfile.ZipFile(file_obj) as zf:
            names = zf.namelist()
        return '[Content_Types].xml' in names and any(n.startswith(folder + '/') for n in names)
    except Exception:
        return False
    finally:
        file_obj.seek(0)    # rewind so file.save() later writes the whole file


def _is_valid_file_content(file_or_name, ext):
    """Checks the real file content (magic bytes), not just the extension.
    NOTE: pass the file object itself — if only the filename (a string) is passed, the content check is skipped."""
    if hasattr(file_or_name, 'read') and hasattr(file_or_name, 'seek'):
        header = file_or_name.read(16)
        file_or_name.seek(0)
        if ext == 'pdf' and not header.startswith(b'%PDF'):
            return False
        if ext in ('docx', 'pptx'):
            if not header.startswith(b'PK\x03\x04'):
                return False
            if not _is_valid_office_zip(file_or_name, 'word' if ext == 'docx' else 'ppt'):
                return False
        if ext in ('doc', 'ppt') and not header.startswith(b'\xd0\xcf\x11\xe0'):
            return False
        if ext in ('jpg', 'jpeg') and not header.startswith(b'\xff\xd8\xff'):
            return False
        if ext == 'png' and not header.startswith(b'\x89PNG\r\n\x1a\n'):
            return False
    return True

def _allowed_notice_file(file_or_name):
    filename = file_or_name.filename if hasattr(file_or_name, 'filename') else str(file_or_name)
    if not ('.' in filename):
        return False
    ext = filename.rsplit('.', 1)[1].lower()
    if ext not in ALLOWED_NOTICE_EXTENSIONS:
        return False
    return _is_valid_file_content(file_or_name, ext)


LUNCH_BREAK_START = '13:30'
LUNCH_BREAK_END = '14:00'

# Notes files are saved here (Backend/uploads/notes/)
# Notes files are saved OUTSIDE the project folder (in the user's home directory) —
# so that a file-watcher tool like VS Code Live Server doesn't treat them as "file changed"
# and reload the whole page. Keeping them inside the project folder caused exactly this problem.
NOTES_UPLOAD_FOLDER = os.path.join(os.path.expanduser('~'), 'studenthub_uploads', 'notes')
os.makedirs(NOTES_UPLOAD_FOLDER, exist_ok=True)
ALLOWED_NOTE_EXTENSIONS = {'pdf', 'doc', 'docx', 'ppt', 'pptx'}


def _allowed_note_file(file_or_name):
    filename = file_or_name.filename if hasattr(file_or_name, 'filename') else str(file_or_name)
    if not ('.' in filename):
        return False
    ext = filename.rsplit('.', 1)[1].lower()
    if ext not in ALLOWED_NOTE_EXTENSIONS:
        return False
    return _is_valid_file_content(file_or_name, ext)


# Assignment attachments (question papers) and student submissions are both saved here — outside the project
ASSIGNMENT_UPLOAD_FOLDER = os.path.join(os.path.expanduser('~'), 'studenthub_uploads', 'assignments')
os.makedirs(ASSIGNMENT_UPLOAD_FOLDER, exist_ok=True)
ALLOWED_ASSIGNMENT_EXTENSIONS = {'pdf', 'doc', 'docx', 'ppt', 'pptx'}


def _allowed_assignment_file(file_or_name):
    filename = file_or_name.filename if hasattr(file_or_name, 'filename') else str(file_or_name)
    if not ('.' in filename):
        return False
    ext = filename.rsplit('.', 1)[1].lower()
    if ext not in ALLOWED_ASSIGNMENT_EXTENSIONS:
        return False
    return _is_valid_file_content(file_or_name, ext)


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

    # For the dashboard bar chart: semester-wise students
    cursor.execute("SELECT semester, COUNT(*) AS c FROM students WHERE semester IS NOT NULL GROUP BY semester ORDER BY semester")
    students_by_semester = [{"semester": r['semester'], "count": r['c']} for r in cursor.fetchall()]

    # Dashboard donut chart: fee records paid vs unpaid (count + total amount)
    cursor.execute("SELECT status, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS amt FROM fees GROUP BY status")
    fee_summary = {"paid": {"count": 0, "amount": 0.0}, "unpaid": {"count": 0, "amount": 0.0}}
    for r in cursor.fetchall():
        if r['status'] in fee_summary:
            fee_summary[r['status']] = {"count": r['c'], "amount": float(r['amt'])}

    # Dashboard bar chart: overall attendance % per semester (only semesters that have attendance marked)
    cursor.execute("""
        SELECT s.semester, COUNT(a.id) AS total,
               SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present
        FROM attendance a
        JOIN students s ON s.id = a.student_id
        WHERE s.semester IS NOT NULL
        GROUP BY s.semester
        ORDER BY s.semester
    """)
    attendance_by_semester = [
        {"semester": r['semester'], "total": r['total'],
         "percentage": round(float(r['present'] or 0) * 100 / r['total']) if r['total'] else 0}
        for r in cursor.fetchall() if r['total']
    ]

    # Dashboard line chart: number of logins per day for the last 7 days (days with no login = 0)
    cursor.execute("""
        SELECT DATE(login_time) AS d, COUNT(*) AS c
        FROM login_history
        WHERE login_time >= CURDATE() - INTERVAL 6 DAY
        GROUP BY DATE(login_time)
    """)
    logins_by_day = {r['d']: r['c'] for r in cursor.fetchall()}
    today = datetime.now().date()
    logins_last_7_days = []
    for i in range(6, -1, -1):
        day = today - timedelta(days=i)
        logins_last_7_days.append({"date": day.isoformat(), "count": logins_by_day.get(day, 0)})

    cursor.close()
    conn.close()

    return jsonify({
        "students_by_semester": students_by_semester,
        "fee_summary": fee_summary,
        "attendance_by_semester": attendance_by_semester,
        "logins_last_7_days": logins_last_7_days,
        "total_students": total_students,
        "total_faculty": total_faculty,
        "total_subjects": total_subjects,
        "total_notices": total_notices,
        "notices_this_week": notices_this_week,
        "active_students": active_students,
        "pending_marks_requests": pending_marks_requests
    }), 200


# ============================================================
# SYSTEM ASSISTANT — a lightweight data-driven assistant (no external AI).
# The Admin dashboard card calls this endpoint. It recognises the question by keyword and
# answers directly from the DB with real data — supported: "student <name/enrollment>",
# "faculty <name/id>", "system summary", "pending marks requests", "report".
# ============================================================
_ASSISTANT_SKIP_TERMS = {'count', 'total', 'summary', 'list', 'overview', 'kitne', 'number', 'report'}

@app.route('/api/admin/assistant', methods=['POST'])
@admin_required
@logged_assistant
def admin_assistant():
    data = request.get_json() or {}
    raw = (data.get('message') or '').strip()
    message = raw.lower()
    if not message:
        return jsonify({"reply": "Go ahead, ask me something! 🙂"}), 200

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        # ---- 1) FAQ table first ----
        faq_reply = find_faq_answer(cursor, raw)
        if faq_reply:
            return jsonify({"reply": faq_reply}), 200

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
            faculty_ids = [r['faculty_row_id'] for r in rows]
            format_strings = ','.join(['%s'] * len(faculty_ids))
            cursor.execute(f"""
                SELECT fs.faculty_id, sub.subject_name, fs.semester, fs.division
                FROM faculty_subjects fs JOIN subjects sub ON sub.id = fs.subject_id
                WHERE fs.faculty_id IN ({format_strings}) ORDER BY fs.semester LIMIT 30
            """, tuple(faculty_ids))
            subs_by_fid = {}
            for x in cursor.fetchall():
                subs_by_fid.setdefault(x['faculty_id'], []).append(
                    f"{x['subject_name']} (Sem {x['semester']}{', Div ' + x['division'] if x['division'] else ''})"
                )
            lines = []
            for r in rows:
                assigned = subs_by_fid.get(r['faculty_row_id'], [])
                subs = ", ".join(assigned[:6]) or "no subject assigned"
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
            cursor.execute("""
                SELECT
                    (SELECT COUNT(*) FROM students) AS students,
                    (SELECT COUNT(*) FROM faculty) AS faculty,
                    (SELECT COUNT(*) FROM subjects) AS subjects,
                    (SELECT COUNT(*) FROM notices WHERE created_at >= NOW() - INTERVAL 7 DAY) AS notices,
                    (SELECT COUNT(*) FROM marks_requests WHERE status = 'pending') AS pending
            """)
            counts = cursor.fetchone() or {}
            reply = (f"• Students: {counts.get('students', 0)}\n• Faculty: {counts.get('faculty', 0)}\n• Subjects: {counts.get('subjects', 0)}\n"
                     f"• Notices this week: {counts.get('notices', 0)}\n• Pending marks requests: {counts.get('pending', 0)}")
            return jsonify({"reply": reply}), 200

        # ---- Reports ----
        if 'report' in message:
            return jsonify({"reply": "In the Reports section (sidebar → Reports) you can download the Student, Attendance, Assignment and Login Activity reports as Excel (.xlsx) files."}), 200

        help_text = "I can answer these:\n• student <name or enrollment>\n• faculty <name or ID>\n• system summary\n• pending marks requests\n• reports"
        reply = get_fallback_reply(cursor, raw, request.user['user_id'], 'admin', help_text)
        return jsonify({"reply": reply}), 200
    except Exception as e:
        app.logger.exception("Admin assistant failed")
        return jsonify({"reply": "Something went wrong. Please try again."}), 200
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
    """Student list with filters.
    - Without `page`: returns a plain array (optionally capped with `limit`) — used by the Promote screen and the header search.
    - With `page` (+ optional `limit`, default 25, max 100): returns
      {items, total, page, limit, total_pages}. A `page` beyond the last page is clamped to the last page."""
    department = request.args.get('department')
    semester = request.args.get('semester')
    academic_year = request.args.get('academic_year')
    division = request.args.get('division')
    status = request.args.get('status')   # 'active' / 'inactive' (any other value = no status filter)
    search = request.args.get('search')   # header search box: match by name or enrollment

    from_where = """
        FROM users u
        JOIN students s ON s.user_id = u.id
        WHERE u.role = 'student'
    """
    params = []
    if department:
        from_where += " AND s.department = %s"
        params.append(department)
    if semester:
        from_where += " AND s.semester = %s"
        params.append(semester)
    if academic_year:
        from_where += " AND s.academic_year = %s"
        params.append(academic_year)
    if division:
        from_where += " AND s.division = %s"
        params.append(division)
    if status in ('active', 'inactive'):
        from_where += " AND u.status = %s"
        params.append(status)
    if search:
        from_where += " AND (u.name LIKE %s OR u.login_id LIKE %s)"
        like = f"%{search}%"
        params.extend([like, like])

    select_sql = """
        SELECT u.id, u.login_id AS enrollment, u.name, u.status,
               s.email, s.mobile, s.whatsapp_number, s.department, s.semester, s.division, s.academic_year, s.gender,
               s.father_name, s.father_mobile, s.mother_name, s.mother_mobile, s.parent_email, s.parent_address
    """ + from_where + " ORDER BY s.academic_year DESC, s.semester ASC, u.login_id ASC"

    page = request.args.get('page', type=int)
    limit = request.args.get('limit', type=int)
    paginated = page is not None
    if paginated:
        limit = min(limit, 100) if limit and limit > 0 else 25
    elif limit and limit > 0:
        limit = min(limit, 100)
    else:
        limit = None

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        if paginated:
            cursor.execute("SELECT COUNT(*) AS total " + from_where, tuple(params))
            total = cursor.fetchone()['total']
            total_pages = max(1, (total + limit - 1) // limit)
            page = min(max(page, 1), total_pages)
            cursor.execute(select_sql + " LIMIT %s OFFSET %s", tuple(params) + (limit, (page - 1) * limit))
            students = cursor.fetchall()
            return jsonify({"items": students, "total": total, "page": page,
                            "limit": limit, "total_pages": total_pages}), 200

        if limit:
            cursor.execute(select_sql + " LIMIT %s", tuple(params) + (limit,))
        else:
            cursor.execute(select_sql, tuple(params))
        return jsonify(cursor.fetchall()), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/students', methods=['POST'])
@admin_required
def add_student():
    data = request.get_json() or {}
    name = data.get('name')
    enrollment = data.get('enrollment')
    email = data.get('email')
    mobile = data.get('mobile')
    whatsapp_number = (data.get('whatsapp_number') or '').strip() or None   # optional
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
    if whatsapp_number and (not whatsapp_number.isdigit() or not (10 <= len(whatsapp_number) <= 15)):
        return jsonify({"message": "WhatsApp number must be 10-15 digits (with country code if needed)"}), 400
    father_name = (father_name or '').strip() or None      # optional
    father_mobile = (father_mobile or '').strip() or None  # optional
    if father_mobile and (not father_mobile.isdigit() or len(father_mobile) != 10):
        return jsonify({"message": "Father's mobile number must be 10 digits"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT id FROM users WHERE login_id = %s", (enrollment,))
    if cursor.fetchone():
        cursor.close()
        conn.close()
        return jsonify({"message": "Enrollment number already exists"}), 409

    # The default password of a student added by Admin is kept as the enrollment number
    # — the student must change it on first login.
    default_password = str(enrollment)
    hashed_pw = bcrypt.hashpw(default_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    try:
        cursor.execute(
            "INSERT INTO users (login_id, password_hash, role, name, status, must_change_password) VALUES (%s, %s, 'student', %s, %s, TRUE)",
            (enrollment, hashed_pw, name, status)
        )
        user_id = cursor.lastrowid

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
        app.logger.error("Failed to add student: %s", repr(e))
        return jsonify({"message": "Failed to add student"}), 500

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

    whatsapp_number = (data.get('whatsapp_number') or '').strip() or None   # optional
    if whatsapp_number and (not whatsapp_number.isdigit() or not (10 <= len(whatsapp_number) <= 15)):
        cursor.close()
        conn.close()
        return jsonify({"message": "WhatsApp number must be 10-15 digits (with country code if needed)"}), 400

    try:
        cursor.execute("UPDATE users SET name = %s WHERE id = %s", (data.get('name'), user_id))
        cursor.execute(
            """UPDATE students SET email=%s, mobile=%s, whatsapp_number=%s, department=%s, semester=%s,
               division=%s, academic_year=%s, gender=%s,
               father_name=%s, father_mobile=%s, mother_name=%s, mother_mobile=%s,
               parent_email=%s, parent_address=%s WHERE user_id=%s""",
            (data.get('email'), data.get('mobile'), whatsapp_number, data.get('department'), data.get('semester'),
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
# Academic term helpers — each semester (1-6) has its own start/end date,
# stored in the academic_years table in the sem1_start..sem6_end columns.
# Semesters 1,3,5 fall in GTU's Odd Term (Jul-Dec) and 2,4,6 in the Even Term
# (Jan-June) — this is only used to derive the year_label.
# ============================================================
def _term_for_semester(semester):
    return 'odd' if int(semester) % 2 == 1 else 'even'


def _sem_columns(semester):
    sem = int(semester)
    return f"sem{sem}_start", f"sem{sem}_end"


def _get_academic_year_for_date_semester(cursor, date_str, semester):
    """If the given date fits inside the date range of the given semester,
    returns that academic_years row, otherwise None."""
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
    """GTU convention: an Odd semester (1,3,5 → Jul-Dec) takes its
    year_label from the same calendar year (e.g. July 2026 -> '2026-27'); an Even semester
    (2,4,6 → Jan-June) belongs to the previous calendar year (e.g. Jan 2027 -> '2026-27')."""
    year = int(start_date_str[:4])
    if _term_for_semester(semester) == 'odd':
        return f"{year}-{str(year + 1)[2:]}"
    return f"{year - 1}-{str(year)[2:]}"


def _upsert_academic_year_semester_dates(cursor, semester, start_date, end_date):
    """Saves the given start/end date (from Promote Semester, or manually from Academic Management)
    into that semester's column in the academic_years table —
    updates the row if it already exists, otherwise derives the year_label from the date
    and creates a new row. Both places (Academic Management + Promote Semester) use this
    same function, so the two always stay in sync."""
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

    To promote below Sem 6, the Start Date and End Date of the new semester
    are required — the academic_years record of Academic Management is also
    created/updated automatically from them (same data in both places).
    Promotion does not happen without dates.
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

    # Sem 6 students only graduate (there is no new semester), so no date is needed for them.
    # Any other student being promoted must have a date.
    needs_dates = any(int(r['semester']) < 6 for r in rows)
    if needs_dates:
        if not term_start_date or not term_end_date:
            cursor.close()
            conn.close()
            return jsonify({"message": "Both the Start Date and End Date of the new semester are required"}), 400
        if term_start_date > term_end_date:
            cursor.close()
            conn.close()
            return jsonify({"message": "Start date must be before the end date"}), 400

    promoted, graduated = [], []
    try:
        # All the non-graduating students of a single Promote action are in the same current semester
        # (and therefore the same target semester) — the Student Management filter
        # list is always populated from a single Dept+Sem+Batch.
        sem_dates_saved = set()
        by_target_sem = {}   # new semester -> [user ids]
        for row in rows:
            uid = row['user_id']
            sem = int(row['semester'])
            if sem >= 6:
                graduated.append(uid)
                continue

            target_sem = sem + 1

            if target_sem not in sem_dates_saved:
                _upsert_academic_year_semester_dates(cursor, target_sem, term_start_date, term_end_date)
                sem_dates_saved.add(target_sem)

            by_target_sem.setdefault(target_sem, []).append(uid)
            promoted.append(uid)

        # one UPDATE for all graduates and one per target semester (instead of one UPDATE per student)
        for chunk in _chunks(graduated):
            ph = ','.join(['%s'] * len(chunk))
            cursor.execute(f"UPDATE users SET status = 'inactive' WHERE id IN ({ph})", tuple(chunk))
        for target_sem, uids in by_target_sem.items():
            for chunk in _chunks(uids):
                ph = ','.join(['%s'] * len(chunk))
                cursor.execute(f"UPDATE students SET semester = %s WHERE user_id IN ({ph})", (target_sem,) + tuple(chunk))
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
    search = request.args.get('search')   # header search box: match by name or faculty ID

    query = """
        SELECT u.id, u.login_id AS faculty_id, u.name, u.status, f.id AS faculty_row_id, f.email, f.department, f.short_name, f.whatsapp_number,
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
        # show only the faculty who have a subject assignment in that batch (academic_year)
        query += " AND EXISTS (SELECT 1 FROM faculty_subjects fs2 WHERE fs2.faculty_id = f.id AND fs2.academic_year = %s)"
        params.append(academic_year)
    if search:
        query += " AND (u.name LIKE %s OR u.login_id LIKE %s)"
        like = f"%{search}%"
        params.extend([like, like])
    query += """
        GROUP BY u.id, u.login_id, u.name, u.status, f.id, f.email, f.department, f.short_name, f.whatsapp_number
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
    whatsapp_number = (data.get('whatsapp_number') or '').strip() or None   # optional

    if not all([name, faculty_login_id, department]):
        return jsonify({"message": "Required fields missing"}), 400
    if whatsapp_number and (not whatsapp_number.isdigit() or not (10 <= len(whatsapp_number) <= 15)):
        return jsonify({"message": "WhatsApp number must be 10-15 digits (with country code if needed)"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT id FROM users WHERE login_id = %s", (faculty_login_id,))
    if cursor.fetchone():
        cursor.close()
        conn.close()
        return jsonify({"message": "Faculty ID already exists"}), 409

    # Default password pattern: faculty#<number-part-of-id> — e.g. faculty001@123 -> faculty#001
    digits = ''.join(ch for ch in faculty_login_id if ch.isdigit())
    default_password = f"faculty#{digits}" if digits else "faculty#0000"
    hashed_pw = bcrypt.hashpw(default_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    try:
        cursor.execute(
            "INSERT INTO users (login_id, password_hash, role, name, must_change_password) VALUES (%s, %s, 'faculty', %s, TRUE)",
            (faculty_login_id, hashed_pw, name)
        )
        user_id = cursor.lastrowid
        cursor.execute(
            "INSERT INTO faculty (user_id, email, department, short_name, whatsapp_number) VALUES (%s, %s, %s, %s, %s)",
            (user_id, email, department, short_name, whatsapp_number)
        )
        faculty_row_id = cursor.lastrowid   # faculty.id (not users.id)

        # Optional: assign one or more subjects for a semester right at creation time
        subject_ids = data.get('subject_ids') or ([data.get('subject_id')] if data.get('subject_id') else [])
        semester = data.get('semester')
        academic_year = data.get('academic_year')
        division = data.get('division') or None   # empty string = "All divisions" -> NULL
        subject_rows = [(faculty_row_id, sid, semester, academic_year, division) for sid in subject_ids if sid]
        if subject_rows:
            cursor.executemany(
                "INSERT INTO faculty_subjects (faculty_id, subject_id, semester, academic_year, division) VALUES (%s, %s, %s, %s, %s)",
                subject_rows
            )
        conn.commit()
    except Exception as e:
        print("ADD FACULTY ERROR:", repr(e))   # to show the exact error in the terminal
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
        # short_name is optional — update only if the key was sent (empty = clear)
        if 'short_name' in data:
            cursor.execute(
                "UPDATE faculty SET short_name=%s WHERE user_id=%s",
                ((data.get('short_name') or '').strip() or None, user_id)
            )
        # whatsapp_number is optional — update only if the key was sent (empty = clear)
        if 'whatsapp_number' in data:
            whatsapp_number = (data.get('whatsapp_number') or '').strip() or None
            if whatsapp_number and (not whatsapp_number.isdigit() or not (10 <= len(whatsapp_number) <= 15)):
                cursor.close()
                conn.close()
                return jsonify({"message": "WhatsApp number must be 10-15 digits (with country code if needed)"}), 400
            cursor.execute(
                "UPDATE faculty SET whatsapp_number=%s WHERE user_id=%s",
                (whatsapp_number, user_id)
            )

        # Replace subjects for the selected semester+batch (assignments of other semesters/batches stay untouched)
        semester = data.get('semester')
        subject_ids = data.get('subject_ids')
        academic_year = data.get('academic_year')
        division = data.get('division') or None   # empty string = "All divisions" -> NULL
        if semester is not None and subject_ids is not None:
            cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (user_id,))
            faculty_row = cursor.fetchone()
            faculty_row_id = faculty_row['id']

            # remove the old assignments of this semester+batch+division, then insert the newly checked subjects
            cursor.execute(
                "DELETE FROM faculty_subjects WHERE faculty_id = %s AND semester = %s AND academic_year = %s AND division <=> %s",
                (faculty_row_id, semester, academic_year, division)
            )
            subject_rows = [(faculty_row_id, sid, semester, academic_year, division) for sid in subject_ids if sid]
            if subject_rows:
                cursor.executemany(
                    "INSERT INTO faculty_subjects (faculty_id, subject_id, semester, academic_year, division) VALUES (%s, %s, %s, %s, %s)",
                    subject_rows
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
    """Fetches this faculty's assigned subjects for that semester+batch+division when the edit form opens or the semester/batch changes."""
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
    subject_type = data.get('subject_type') or 'Theory'

    if subject_type not in ('Theory', 'Lab', 'Theory + Lab'):
        return jsonify({"message": "Invalid subject type"}), 400

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
            "INSERT INTO subjects (subject_code, subject_name, department, semester, credits, academic_year, subject_type) VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (subject_code, subject_name, department, semester, credits, academic_year, subject_type)
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
    subject_type = data.get('subject_type') or 'Theory'
    if subject_type not in ('Theory', 'Lab', 'Theory + Lab'):
        cursor.close()
        conn.close()
        return jsonify({"message": "Invalid subject type"}), 400
    cursor.execute(
        "UPDATE subjects SET subject_name=%s, department=%s, semester=%s, credits=%s, academic_year=%s, subject_type=%s WHERE id=%s",
        (data.get('subject_name'), data.get('department'), data.get('semester'), data.get('credits'), data.get('academic_year'), subject_type, subject_id)
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
    """Checks whether faculty/room/division is already busy at the same day in an overlapping time — checks all three.
    division_list is a list (e.g. ['A','B']) — it handles a combined lecture (multi-division) correctly:
    a clash is reported only when the divisions overlap (an A,B slot is free for C only, but clashes with A or B).
    A faculty/room clash is ALWAYS checked (even across batches, one person/room cannot be in two places),
    but a division clash is checked only within the same batch (academic_year) — the same Sem+Div
    of a different batch is actually a completely different group of students."""
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
            return "This faculty is already busy at this time on this day"

        if room_no and row['room_no'] == room_no:
            return "This room is already booked at this time on this day"

        if str(row['semester']) == str(semester) and str(row.get('academic_year') or '') == str(academic_year or ''):
            existing_division_set = set((row['division'] or '').split(','))
            if new_division_set & existing_division_set:   # any common division means a clash
                return "Another subject is already scheduled for these division(s) at this time on this day"

    return None


@app.route('/api/admin/timetable', methods=['GET'])
@admin_required
def get_timetable():
    academic_year = request.args.get('academic_year')

    query = """
        SELECT t.id, t.semester, t.division, t.academic_year, t.day_of_week, t.room_no, t.session_type,
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
    """Shows only the faculty who teach that subject, according to subject + semester."""
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
    division_list = data.get('divisions') or []   # e.g. ["A","B"] — a combined lecture for more than one division
    subject_id = data.get('subject_id')
    faculty_id = data.get('faculty_id')
    day_of_week = data.get('day_of_week')
    start_time = data.get('start_time')
    end_time = data.get('end_time')
    room_no = data.get('room_no')
    academic_year = data.get('academic_year')
    session_type = data.get('session_type') or 'Lecture'

    if session_type not in ('Lecture', 'Lab'):
        return jsonify({"message": "Invalid session type"}), 400

    if not all([semester, division_list, subject_id, faculty_id, day_of_week, start_time, end_time]):
        return jsonify({"message": "Required fields missing (select at least one division)"}), 400
    if start_time >= end_time:
        return jsonify({"message": "Start time must be before end time"}), 400
    if start_time < LUNCH_BREAK_END and end_time > LUNCH_BREAK_START:
        return jsonify({"message": "1:30 PM - 2:00 PM is reserved for the lunch break"}), 400

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
            INSERT INTO timetable (department, semester, division, academic_year, day_of_week, start_time, end_time, subject_id, faculty_id, room_no, session_type)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, ('computer engineering', semester, division_str, academic_year, day_of_week, start_time, end_time, subject_id, faculty_id, room_no, session_type))
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
    session_type = data.get('session_type') or 'Lecture'

    if session_type not in ('Lecture', 'Lab'):
        return jsonify({"message": "Invalid session type"}), 400

    if not all([semester, division_list, subject_id, faculty_id, day_of_week, start_time, end_time]):
        return jsonify({"message": "Required fields missing (select at least one division)"}), 400
    if start_time >= end_time:
        return jsonify({"message": "Start time must be before end time"}), 400
    if start_time < LUNCH_BREAK_END and end_time > LUNCH_BREAK_START:
        return jsonify({"message": "1:30 PM - 2:00 PM is reserved for the lunch break"}), 400

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
                   day_of_week=%s, start_time=%s, end_time=%s, room_no=%s, session_type=%s
            WHERE id=%s
        """, (semester, division_str, academic_year, subject_id, faculty_id, day_of_week, start_time, end_time, room_no, session_type, slot_id))
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
# EXAM TIMETABLE (Mid-Sem / Remedial — structured, like the regular timetable)
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
        return jsonify({"message": "Exam timetable could not be loaded — is the 'exam_timetable' table created in the DB?", "error": str(e)}), 500
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
        return jsonify({"message": "exam_type must be Mid-Sem or Remedial"}), 400
    if not (semester and exam_date and start_time and end_time):
        return jsonify({"message": "Semester, date, start and end time are required"}), 400

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
        return jsonify({"message": "exam_type must be Mid-Sem or Remedial"}), 400
    if not (semester and exam_date and start_time and end_time):
        return jsonify({"message": "Semester, date, start and end time are required"}), 400

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

# ============================================================
# ATTENDANCE SHORTAGE (below the minimum %) — shared by the Admin, Faculty and Student panels
# Minimum % = system_settings key 'attendance_min_percentage' (default 75 = GTU eligibility rule).
# The check is EXACT (no rounding): 74.6% is a shortage even though it is displayed as 75%.
# ============================================================
ATTENDANCE_MIN_DEFAULT = 75
ATTENDANCE_ALERT_MIN_CLASSES = 5      # fewer classes than this held in a subject = too early to judge / mail
ATTENDANCE_ALERT_COOLDOWN_DAYS = 7    # the same student+subject is not mailed again within this many days
_alert_table_ready = False


def get_attendance_min(cursor):
    """The minimum attendance % (system_settings 'attendance_min_percentage', default 75)."""
    try:
        cursor.execute("SELECT setting_value FROM system_settings WHERE setting_key = 'attendance_min_percentage'")
        row = cursor.fetchone()
        value = int(float(row['setting_value'])) if row and row['setting_value'] not in (None, '') else ATTENDANCE_MIN_DEFAULT
        return value if 1 <= value <= 99 else ATTENDANCE_MIN_DEFAULT
    except Exception:
        return ATTENDANCE_MIN_DEFAULT


def attendance_is_short(attended, total, min_pct=ATTENDANCE_MIN_DEFAULT):
    return total > 0 and attended * 100 < min_pct * total


def attendance_need_more(attended, total, min_pct=ATTENDANCE_MIN_DEFAULT):
    """How many more lectures the student must attend (every one of them) to reach min_pct. 0 if not short."""
    if not attendance_is_short(attended, total, min_pct):
        return 0
    # (attended + x) / (total + x) >= min/100   ->   x >= (min*total - 100*attended) / (100 - min)
    need = min_pct * total - 100 * attended
    return -(-need // (100 - min_pct))     # ceil


def attendance_can_miss(attended, total, min_pct=ATTENDANCE_MIN_DEFAULT):
    """How many more lectures can still be missed while staying at or above min_pct. 0 if already short."""
    if total <= 0 or attendance_is_short(attended, total, min_pct):
        return 0
    return (100 * attended - min_pct * total) // min_pct


def _ensure_alert_table(cursor, conn):
    """attendance_alerts is created on first use if the live DB does not have it yet (also listed in schema.sql)."""
    global _alert_table_ready
    if _alert_table_ready:
        return
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS attendance_alerts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            student_id INT NOT NULL,
            subject_id INT NOT NULL,
            percentage DECIMAL(5,2),
            sent_to VARCHAR(255),
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_attendance_alert (student_id, subject_id, sent_at),
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
            FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
        )
    """)
    conn.commit()
    _alert_table_ready = True


def _valid_email(value):
    value = (value or '').strip()
    return value if ('@' in value and ' ' not in value and '.' in value.split('@')[-1]) else None


def _attendance_alert_body(name, enrollment, subs, min_pct, college, for_parent):
    lines = []
    for s in subs:
        pct = f"{s['attended'] * 100 / s['total']:.1f}"
        need = attendance_need_more(s['attended'], s['total'], min_pct)
        lines.append(f"  - {s['subject_name']}: {pct}% (attended {s['attended']} of {s['total']} lectures). "
                     f"Attending the next {need} lecture{'' if need == 1 else 's'} in a row will bring it to {min_pct}%.")
    who = f"Parent/Guardian of {name}" if for_parent else name
    about = f"{name}'s" if for_parent else "Your"
    return (
        f"Dear {who},\n\n"
        f"{about} attendance (Enrollment: {enrollment}) is below the required {min_pct}% in the following subject(s):\n\n"
        + "\n".join(lines) +
        f"\n\nA minimum of {min_pct}% attendance is needed to be eligible for the examination. "
        f"Please make sure the lectures are attended regularly. If you think this is a mistake, contact the class teacher.\n\n"
        f"Regards,\n{college}\n(This is an automated message.)"
    )


def notify_attendance_shortage(student_ids, force=False):
    """E-mails the student AND the parent (if their e-mail ids are saved) when the student is below the
    minimum attendance in a subject of the current semester. A subject is judged only after
    ATTENDANCE_ALERT_MIN_CLASSES classes, and the same student+subject is not mailed again within
    ATTENDANCE_ALERT_COOLDOWN_DAYS (unless force=True). Returns a small summary dict."""
    summary = {"checked": 0, "short": 0, "emailed": 0, "skipped_recent": 0, "no_email": 0, "failed": 0}
    ids = []
    for sid in student_ids or []:
        n = _norm_id(sid)
        if isinstance(n, int) and n not in ids:
            ids.append(n)
    summary["checked"] = len(ids)
    if not ids:
        return summary

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor(dictionary=True)
        _ensure_alert_table(cursor, conn)
        min_pct = get_attendance_min(cursor)
        cursor.execute("SELECT setting_value FROM system_settings WHERE setting_key = 'college_name'")
        row = cursor.fetchone()
        college = (row['setting_value'] if row and row['setting_value'] else None) or "StudentHub"

        outbox = []   # one entry per mail: {student_id, subs, to, subject, body}
        for chunk in _chunks(ids, 300):
            ph = ','.join(['%s'] * len(chunk))
            cursor.execute(f"""
                SELECT a.student_id, a.subject_id, sub.subject_name,
                       COUNT(*) AS total,
                       SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS attended
                FROM attendance a
                JOIN students st ON st.id = a.student_id
                JOIN subjects sub ON sub.id = a.subject_id AND sub.semester = st.semester
                WHERE a.student_id IN ({ph})
                GROUP BY a.student_id, a.subject_id, sub.subject_name
                ORDER BY sub.subject_name
            """, tuple(chunk))
            short = {}
            for r in cursor.fetchall():
                total, attended = int(r['total']), int(r['attended'] or 0)
                if total >= ATTENDANCE_ALERT_MIN_CLASSES and attendance_is_short(attended, total, min_pct):
                    short.setdefault(r['student_id'], []).append({
                        "subject_id": r['subject_id'], "subject_name": r['subject_name'],
                        "attended": attended, "total": total})
            if not short:
                continue
            summary["short"] += len(short)

            short_ids = list(short.keys())
            ph2 = ','.join(['%s'] * len(short_ids))
            recent = set()
            if not force:
                cursor.execute(
                    f"SELECT student_id, subject_id FROM attendance_alerts "
                    f"WHERE student_id IN ({ph2}) AND sent_at >= NOW() - INTERVAL %s DAY",
                    tuple(short_ids) + (ATTENDANCE_ALERT_COOLDOWN_DAYS,))
                recent = {(r['student_id'], r['subject_id']) for r in cursor.fetchall()}
            cursor.execute(f"""
                SELECT st.id, st.email, st.parent_email, u.name, u.login_id
                FROM students st JOIN users u ON u.id = st.user_id
                WHERE st.id IN ({ph2})
            """, tuple(short_ids))
            contacts = {r['id']: r for r in cursor.fetchall()}

            for sid, subs in short.items():
                if all((sid, s['subject_id']) in recent for s in subs):
                    summary["skipped_recent"] += 1
                    continue
                c = contacts.get(sid)
                student_mail, parent_mail = _valid_email(c and c['email']), _valid_email(c and c['parent_email'])
                if not c or not (student_mail or parent_mail):
                    summary["no_email"] += 1
                    continue
                subject_line = f"{college} - Attendance shortage alert"
                if student_mail:
                    outbox.append({"student_id": sid, "subs": subs, "to": student_mail, "subject": subject_line,
                                   "body": _attendance_alert_body(c['name'], c['login_id'], subs, min_pct, college, False)})
                if parent_mail and parent_mail != student_mail:
                    outbox.append({"student_id": sid, "subs": subs, "to": parent_mail, "subject": subject_line,
                                   "body": _attendance_alert_body(c['name'], c['login_id'], subs, min_pct, college, True)})

        if outbox:
            try:
                results = send_plain_emails([(o['to'], o['subject'], o['body']) for o in outbox], sender_name=college)
            except Exception as e:
                print("ATTENDANCE ALERT MAIL ERROR:", repr(e))
                results = [False] * len(outbox)

            delivered = {}   # student_id -> [addresses that really got the mail]
            for o, ok in zip(outbox, results):
                delivered.setdefault(o['student_id'], [])
                if ok:
                    delivered[o['student_id']].append(o['to'])
            log_rows = []
            for sid, sent_to in delivered.items():
                if not sent_to:
                    summary["failed"] += 1
                    continue
                summary["emailed"] += 1
                subs = next(o['subs'] for o in outbox if o['student_id'] == sid)
                for s in subs:
                    log_rows.append((sid, s['subject_id'], round(s['attended'] * 100 / s['total'], 2), ', '.join(sent_to)[:255]))
            if log_rows:
                cursor.executemany(
                    "INSERT INTO attendance_alerts (student_id, subject_id, percentage, sent_to) VALUES (%s, %s, %s, %s)",
                    log_rows)
                conn.commit()
        cursor.close()
    except Exception as e:
        print("ATTENDANCE ALERT ERROR:", repr(e))
        summary["failed"] += 1
    finally:
        if conn and conn.is_connected():
            conn.close()
    return summary


def trigger_attendance_shortage_alerts(student_ids):
    """Called right after attendance is saved. Runs in a background thread so saving stays fast."""
    ids = [i for i in (student_ids or []) if i]
    if ids:
        threading.Thread(target=notify_attendance_shortage, args=(ids,), daemon=True).start()


@app.route('/api/admin/attendance/shortage/notify', methods=['POST'])
@admin_required
def notify_attendance_shortage_admin():
    """Body: { semester, divisions: [..] or "A,B", academic_year }.
    Mails every student of that class who is below the minimum attendance (and the parent).
    Students already alerted within the cooldown are skipped."""
    data = request.get_json() or {}
    semester = data.get('semester')
    divisions = data.get('divisions') or []
    if isinstance(divisions, str):
        divisions = [d for d in divisions.split(',') if d]
    academic_year = data.get('academic_year')
    if not semester or not divisions:
        return jsonify({"message": "semester and divisions are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        ph = ','.join(['%s'] * len(divisions))
        query = f"SELECT id FROM students WHERE semester = %s AND division IN ({ph})"
        params = [semester] + list(divisions)
        if academic_year:
            query += " AND academic_year = %s"
            params.append(academic_year)
        cursor.execute(query, tuple(params))
        ids = [r['id'] for r in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()

    s = notify_attendance_shortage(ids)
    if not ids:
        message = "No student was found for this class."
    elif s['short'] == 0:
        message = "No student in this class is below the minimum attendance (or the classes held are too few to judge yet)."
    else:
        message = (f"{s['short']} student(s) below the minimum attendance — alerted: {s['emailed']}, "
                   f"already alerted in the last {ATTENDANCE_ALERT_COOLDOWN_DAYS} days: {s['skipped_recent']}, "
                   f"no e-mail on file: {s['no_email']}, failed: {s['failed']}.")
    return jsonify({"message": message, "summary": s}), 200


@app.route('/api/admin/attendance', methods=['GET'])
@admin_required
def get_attendance_list():
    """All students of one or more divisions (combined attendance), with their status for the given subject+date."""
    semester = request.args.get('semester')
    divisions = request.args.get('divisions')   # comma-separated, e.g. "A,B"
    academic_year = request.args.get('academic_year')
    subject_id = request.args.get('subject_id')
    date = request.args.get('date')
    session_type = request.args.get('session_type') or 'Lecture'

    if not all([semester, divisions, subject_id, date]):
        return jsonify({"message": "semester, divisions, subject_id and date are all required"}), 400
    if session_type not in ('Lecture', 'Lab'):
        return jsonify({"message": "session_type must be Lecture or Lab"}), 400

    division_list = divisions.split(',')
    placeholders = ','.join(['%s'] * len(division_list))

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    query = f"""
        SELECT s.id AS student_id, u.login_id AS enrollment, u.name, s.semester, s.division, s.academic_year, a.status
        FROM students s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN attendance a ON a.student_id = s.id AND a.subject_id = %s AND a.attendance_date = %s AND a.session_type = %s
        WHERE s.semester = %s AND s.division IN ({placeholders})
    """
    params = [subject_id, date, session_type, semester] + division_list
    if academic_year:
        query += " AND s.academic_year = %s"
        params.append(academic_year)
    query += " ORDER BY s.division ASC, u.login_id ASC"

    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/attendance', methods=['POST'])
@admin_required
def save_attendance():
    """Bulk mark/update — the attendance of the whole class for one day/subject is saved in one go.
    It is saved only if the given date falls inside that subject's semester
    date range (set from Academic Management / Promote Semester)."""
    data = request.get_json()
    subject_id = data.get('subject_id')
    date = data.get('date')
    records = data.get('records') or []   # [{student_id, status}]
    session_type = data.get('session_type') or 'Lecture'

    if not subject_id or not date or not records:
        return jsonify({"message": "subject_id, date and records are required"}), 400
    if session_type not in ('Lecture', 'Lab'):
        return jsonify({"message": "session_type must be Lecture or Lab"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT semester FROM subjects WHERE id = %s", (subject_id,))
    subject = cursor.fetchone()
    if not subject:
        cursor.close()
        conn.close()
        return jsonify({"message": "Subject not found"}), 404

    if not _get_academic_year_for_date_semester(cursor, date, subject['semester']):
        cursor.close()
        conn.close()
        return jsonify({"message": f"This date is not within the date range of Sem {subject['semester']} — first set the start/end date of this semester in Academic Management"}), 400

    # Holiday / cancelled lecture -> was never held, so attendance must not be saved (even by Admin)
    try:
        date_obj = datetime.strptime(date, '%Y-%m-%d').date()
    except (TypeError, ValueError):
        cursor.close()
        conn.close()
        return jsonify({"message": "Invalid date"}), 400
    student_ids = [r.get('student_id') for r in records if r.get('student_id')]
    divisions = []
    if student_ids:
        id_placeholders = ','.join(['%s'] * len(student_ids))
        cursor.execute(f"SELECT DISTINCT division FROM students WHERE id IN ({id_placeholders})", tuple(student_ids))
        divisions = [row['division'] for row in cursor.fetchall()]
    block_reason = get_admin_session_block_reason(cursor, subject_id, subject['semester'], divisions, session_type, date_obj)
    if block_reason:
        cursor.close()
        conn.close()
        return jsonify({"message": block_reason}), 409

    try:
        attendance_rows = [(r.get('student_id'), subject_id, date, session_type, r.get('status'))
                           for r in records
                           if r.get('student_id') and r.get('status') in ('present', 'absent')]
        if attendance_rows:
            # all students in one statement (instead of one INSERT per student)
            cursor.executemany("""
                INSERT INTO attendance (student_id, subject_id, attendance_date, session_type, status)
                VALUES (%s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE status = VALUES(status)
            """, attendance_rows)
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Attendance save failed", "error": str(e)}), 500

    cursor.close()
    conn.close()
    trigger_attendance_shortage_alerts([r.get('student_id') for r in records if r.get('status') in ('present', 'absent')])
    return jsonify({"message": "Attendance saved"}), 200


@app.route('/api/admin/attendance/summary', methods=['GET'])
@admin_required
def get_attendance_summary():
    """Overall attendance % of each student — only for that subject if subject_id is given, or the combined figure for the whole semester if it is 'ALL'.
    More than one division can also be taken together (combined)."""
    semester = request.args.get('semester')
    divisions = request.args.get('divisions')   # comma-separated, e.g. "A,B"
    academic_year = request.args.get('academic_year')
    subject_id = request.args.get('subject_id')   # ID or 'ALL'

    if not semester or not divisions:
        return jsonify({"message": "semester and divisions are required"}), 400

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
    query += " GROUP BY s.id, u.login_id, u.name, s.semester, s.division, s.academic_year ORDER BY s.division ASC, u.login_id ASC"

    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route('/api/admin/attendance/calendar', methods=['GET'])
@admin_required
def get_attendance_calendar():
    """Day-wise status of one student for one month — for that subject if a specific Subject filter is chosen,
    and if it is 'ALL', a day counts as 'absent' if the student was absent in any subject that day."""
    student_id = request.args.get('student_id')
    subject_id = request.args.get('subject_id')   # ID or 'ALL'
    year = request.args.get('year')
    month = request.args.get('month')

    if not all([student_id, year, month]):
        return jsonify({"message": "student_id, year and month are required"}), 400

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
    """multipart/form-data — it comes with a file (not JSON)."""
    title = request.form.get('title')
    subject_id = request.form.get('subject_id')
    semester = request.form.get('semester')
    division = request.form.get('division') or None
    academic_year = request.form.get('academic_year') or None
    description = request.form.get('description') or None
    file = request.files.get('file')

    if not title or not subject_id or not file or file.filename == '':
        return jsonify({"message": "Title, subject and file are required"}), 400

    if not _allowed_note_file(file):
        return jsonify({"message": "Invalid file format. Only valid PDF, DOC, DOCX, PPT, PPTX files are allowed"}), 400

    original_name = secure_filename(file.filename)
    file_ext = original_name.rsplit('.', 1)[1].lower()
    unique_name = f"{uuid.uuid4().hex}.{file_ext}"   # unique name to avoid collisions on disk
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
            os.remove(save_path)   # if the DB save failed, don't leave an orphan file on disk
        return jsonify({"message": "Note could not be saved", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Note uploaded"}), 201


@app.route('/api/admin/notes/<int:note_id>', methods=['PUT'])
@admin_required
def update_note(note_id):
    """Only the details (title/subject/semester/division/description) can be edited — the file cannot be replaced."""
    data = request.get_json()
    title = data.get('title')
    subject_id = data.get('subject_id')
    semester = data.get('semester')
    division = data.get('division') or None
    academic_year = data.get('academic_year') or None
    description = data.get('description') or None

    if not title or not subject_id:
        return jsonify({"message": "Title and subject are required"}), 400

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
        os.remove(file_path)   # delete the actual file along with the DB record

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
        # Assignments of that division + the "All divisions" ones (division NULL) — both are shown,
        # because "All divisions" assignments also apply to the students of this division
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
    """multipart/form-data — the attachment file is OPTIONAL (unlike Notes, an assignment can be saved here even without a file)."""
    title = request.form.get('title')
    subject_id = request.form.get('subject_id')
    semester = request.form.get('semester')
    division = request.form.get('division') or None
    academic_year = request.form.get('academic_year') or None
    description = request.form.get('description') or None
    due_date = request.form.get('due_date') or None
    file = request.files.get('file')

    if not title or not subject_id:
        return jsonify({"message": "Title and subject are required"}), 400

    unique_name = None
    original_name = None
    file_size = None
    file_ext = None

    if file and file.filename:
        if not _allowed_assignment_file(file):
            return jsonify({"message": "Invalid file format. Only valid PDF, DOC, DOCX, PPT, PPTX files are allowed"}), 400
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
        return jsonify({"message": "Assignment could not be saved", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Assignment added"}), 201


@app.route('/api/admin/assignments/<int:assignment_id>', methods=['PUT'])
@admin_required
def update_assignment(assignment_id):
    """Only the details can be edited — the attachment file cannot be replaced (same pattern as Notes)."""
    data = request.get_json()
    title = data.get('title')
    subject_id = data.get('subject_id')
    semester = data.get('semester')
    division = data.get('division') or None
    academic_year = data.get('academic_year') or None
    description = data.get('description') or None
    due_date = data.get('due_date') or None

    if not title or not subject_id:
        return jsonify({"message": "Title and subject are required"}), 400

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
    """When an assignment is deleted, its attachment file and assignment_submissions (the DB removes these itself via CASCADE) go too — but
    the actual files of the submissions must also be removed from disk, so get their paths first."""
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
    """Downloads the assignment's attachment (question paper)."""
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
    """All eligible students of the assignment's semester+division, with their submission status/marks (if submitted)."""
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
    query += " ORDER BY u.login_id ASC"

    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    for row in rows:
        row['due_date'] = assignment['due_date']   # also send due_date in every row, so the frontend can calculate Late vs On-time
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
    """Admin/Faculty manually sets a student's submission status — Submitted/Late/Pending, along with marks.
    Used to manage records even before real uploads arrive from the Student panel (e.g. offline/hardcopy submissions)."""
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
        # Setting it back to "Pending" — just remove the record (if there was one)
        if existing:
            cursor.execute("DELETE FROM assignment_submissions WHERE id = %s", (existing['id'],))
            conn.commit()
        cursor.close()
        conn.close()
        return jsonify({"message": "Marked as pending"}), 200

    if not submitted_at:
        from datetime import date
        submitted_at = date.today().isoformat()   # if no date is given, default to today's date

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
    """Downloads a student's submitted file."""
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
    """All students of a semester+division, with their already-entered marks (if any) for the given subject+exam."""
    semester = request.args.get('semester')
    division = request.args.get('division')
    subject_id = request.args.get('subject_id')
    exam_type = request.args.get('exam_type')
    academic_year = request.args.get('academic_year')

    if not all([semester, division, subject_id, exam_type, academic_year]):
        return jsonify({"message": "semester, division, batch, subject_id and exam_type are all required"}), 400

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
    """Saves/updates the marks of the whole class in one go — like Attendance's bulk-save."""
    data = request.get_json()
    semester = data.get('semester')
    subject_id = data.get('subject_id')
    exam_type = data.get('exam_type')
    max_marks = data.get('max_marks')
    academic_year = data.get('academic_year')
    records = data.get('records') or []   # [{student_id, marks_obtained}]

    if not all([semester, subject_id, exam_type, max_marks, academic_year]) or not records:
        return jsonify({"message": "Semester, subject, exam, batch, max marks and records are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        # The last entry of a student wins (same result as saving the records one after another)
        wanted = {}
        for r in records:
            student_id = r.get('student_id')
            marks_obtained = r.get('marks_obtained')
            if student_id is None or marks_obtained is None or marks_obtained == '':
                continue
            wanted[_norm_id(student_id)] = marks_obtained

        # ONE query finds the marks rows that already exist (instead of one SELECT per student)
        existing = {}   # student id -> marks row id
        for chunk in _chunks(wanted):
            ph = ','.join(['%s'] * len(chunk))
            cursor.execute(
                "SELECT id, student_id FROM marks WHERE subject_id = %s AND exam_type = %s AND semester = %s "
                f"AND academic_year = %s AND student_id IN ({ph}) ORDER BY id",
                (subject_id, exam_type, semester, academic_year) + tuple(chunk)
            )
            for row in cursor.fetchall():
                existing.setdefault(row['student_id'], row['id'])

        # Existing rows are updated in one statement per 500 students: INSERT .. ON DUPLICATE KEY UPDATE on the primary key
        # (every NOT NULL column is supplied, so it also works in MySQL strict mode). New rows go in with one INSERT.
        update_rows = [(existing[sid], sid, subject_id, exam_type, marks, max_marks, semester, academic_year)
                       for sid, marks in wanted.items() if sid in existing]
        insert_rows = [(sid, subject_id, exam_type, marks, max_marks, semester, academic_year)
                       for sid, marks in wanted.items() if sid not in existing]
        for chunk in _chunks(update_rows):
            cursor.executemany(
                "INSERT INTO marks (id, student_id, subject_id, exam_type, marks_obtained, max_marks, semester, academic_year) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON DUPLICATE KEY UPDATE marks_obtained = VALUES(marks_obtained), max_marks = VALUES(max_marks)",
                chunk
            )
        if insert_rows:
            cursor.executemany(
                "INSERT INTO marks (student_id, subject_id, exam_type, marks_obtained, max_marks, semester, academic_year) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                insert_rows
            )
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Marks could not be saved", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Marks saved"}), 200


@app.route('/api/admin/marks/publish', methods=['PUT'])
@admin_required
def toggle_marks_publish():
    """Publishes/unpublishes the entire result of the semester+division+subject+exam currently shown in the filter in one go."""
    data = request.get_json()
    semester = data.get('semester')
    division = data.get('division')
    subject_id = data.get('subject_id')
    exam_type = data.get('exam_type')
    academic_year = data.get('academic_year')
    published = data.get('published', True)

    if not all([semester, division, subject_id, exam_type, academic_year]):
        return jsonify({"message": "semester, division, batch, subject_id and exam_type are required"}), 400

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
# MARKS REQUESTS (approval workflow for faculty submissions)
# pending -> approved (notice to faculty) -> published (visible to students+faculty)
#         -> rejected (notice to faculty, who can edit again)
# ============================================================
def _notify_faculty(cursor, faculty_user_id, title, content):
    """Sends a personal notice to a faculty member (target_user_id set) — it will show in the Notices feed."""
    cursor.execute("""
        INSERT INTO notices (title, content, category, target_role, target_user_id, posted_by)
        VALUES (%s, %s, 'Academic', 'faculty', %s, %s)
    """, (title, content, faculty_user_id, request.user['user_id']))


@app.route('/api/admin/marks/requests', methods=['GET'])
@admin_required
def get_marks_requests():
    """Query param: status (pending/approved/rejected/published). Default: pending.
    The list of all requests — with faculty name, subject, exam, division, number of students and submit date."""
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
    """The marks of every student inside one request — to show while reviewing."""
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
        return jsonify({"message": "Request not found"}), 404

    cursor.execute("""
        SELECT u.login_id AS enrollment, u.name, m.marks_obtained
        FROM marks m
        JOIN students s ON s.id = m.student_id
        JOIN users u ON u.id = s.user_id
        WHERE m.request_id = %s
        ORDER BY u.login_id ASC
    """, (request_id,))
    req['students'] = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(req), 200


@app.route('/api/admin/marks/requests/<int:request_id>/decision', methods=['PUT'])
@admin_required
def decide_marks_request(request_id):
    """Body: { decision: 'approved' | 'rejected', remarks (optional, recommended for rejected) }.
    As soon as it is approved/rejected, a personal notice goes to the faculty."""
    data = request.get_json() or {}
    decision = data.get('decision')
    remarks = data.get('remarks') or None

    if decision not in ('approved', 'rejected'):
        return jsonify({"message": "decision must be 'approved' or 'rejected'"}), 400

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
            return jsonify({"message": "Request not found"}), 404
        if req['status'] != 'pending':
            return jsonify({"message": f"This request is already '{req['status']}'"}), 409

        cursor.execute("""
            UPDATE marks_requests
            SET status = %s, reviewed_at = NOW(), reviewed_by = %s, remarks = %s
            WHERE id = %s
        """, (decision, request.user['user_id'], remarks, request_id))

        if decision == 'approved':
            title = f"Marks request accepted — {req['subject_name']} ({req['exam_type']})"
            content = f"Your marks request for {req['subject_name']} ({req['exam_type']}) has been approved. It will be visible to students as soon as it is published."
        else:
            title = f"Marks request rejected — {req['subject_name']} ({req['exam_type']})"
            content = f"Your marks request for {req['subject_name']} ({req['exam_type']}) has been rejected."
            if remarks:
                content += f" Reason: {remarks}"
            content += " You can edit it and submit again."
        _notify_faculty(cursor, req['faculty_user_id'], title, content)

        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Decision could not be saved", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": f"Request {decision}"}), 200


@app.route('/api/admin/marks/requests/<int:request_id>/publish', methods=['PUT'])
@admin_required
def publish_marks_request(request_id):
    """Only an 'approved' request can be published. As soon as it is published, all marks of this request become visible to students."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT * FROM marks_requests WHERE id = %s", (request_id,))
        req = cursor.fetchone()
        if not req:
            return jsonify({"message": "Request not found"}), 404
        if req['status'] != 'approved':
            return jsonify({"message": "Only an 'approved' request can be published"}), 409

        cursor.execute("UPDATE marks_requests SET status = 'published' WHERE id = %s", (request_id,))
        cursor.execute("UPDATE marks SET published = TRUE WHERE request_id = %s", (request_id,))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Could not publish", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Marks published"}), 200


# ============================================================
# FEE MANAGEMENT
# ============================================================
@app.route('/api/admin/fees/students', methods=['GET'])
@admin_required
def get_fee_students():
    """The list of students for the Student dropdown (and 'apply to whole class') when adding a fee record."""
    semester = request.args.get('semester')
    division = request.args.get('division')
    academic_year = request.args.get('academic_year')

    if not semester:
        return jsonify({"message": "semester is required"}), 400

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
    query += " ORDER BY u.login_id ASC"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


_FEE_FROM = """
        FROM fees f
        JOIN students s ON s.id = f.student_id
        JOIN users u ON u.id = s.user_id
"""


def _fee_where(args, use_folder=False):
    """WHERE part shared by the fee list and the two folder summaries, so their numbers always agree.
    Filters of the page: status, semester, division, academic_year, search.
    With use_folder: the folder that is open on the screen - folder_semester / folder_division / folder_year
    (the screen writes 'not set' as '-') and fee_title (the title folder inside it)."""
    conditions, params = [], []
    for column, name in (("f.status", "status"), ("f.semester", "semester"),
                         ("s.division", "division"), ("f.academic_year", "academic_year")):
        value = args.get(name)
        if value:
            conditions.append(f"{column} = %s")
            params.append(value)
    search = args.get('search')
    if search:
        conditions.append("(u.name LIKE %s OR u.login_id LIKE %s OR f.fee_title LIKE %s)")
        like = f"%{search}%"
        params += [like, like, like]

    if use_folder:
        for name, column, empty_test in (("folder_semester", "f.semester", "(f.semester IS NULL OR f.semester = 0)"),
                                         ("folder_division", "s.division", "(s.division IS NULL OR s.division = '')"),
                                         ("folder_year", "f.academic_year", "(f.academic_year IS NULL OR f.academic_year = '')")):
            value = args.get(name)
            if value is None:
                continue
            if value == '-':
                conditions.append(empty_test)
            else:
                conditions.append(f"{column} = %s")
                params.append(value)
        title = args.get('fee_title')
        if title:
            if title == 'Untitled':
                conditions.append("(f.fee_title IS NULL OR f.fee_title = '' OR f.fee_title = 'Untitled')")
            else:
                conditions.append("f.fee_title = %s")
                params.append(title)

    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    return where, params


def _fee_group_rows(rows):
    return [{**row, "records": int(row["records"]), "paid": int(row["paid"] or 0), "total": float(row["total"] or 0)}
            for row in rows]


@app.route('/api/admin/fees', methods=['GET'])
@admin_required
def get_fees():
    """Fee records.
    - Without `page`: a plain array with every matching row.
    - With `page` (+ optional `limit`, default 50, max 200): {items, total, page, limit, total_pages};
      a page beyond the last one is clamped to the last page.
    Besides the page filters it accepts the open folder (folder_semester / folder_division / folder_year, '-' = not set)
    and fee_title, so the screen only loads the records of the folder it shows."""
    where, params = _fee_where(request.args, use_folder=True)
    # NOTE: seconds are written %S (capital) on purpose. A lowercase %s inside the SQL text is taken for a query
    # parameter by the MySQL driver, which made every filtered request fail with 'Not enough parameters'.
    select_sql = """
        SELECT f.id, f.fee_title, f.amount, DATE_FORMAT(f.due_date, '%Y-%m-%d') AS due_date, f.semester, f.academic_year,
               f.status, f.payment_link, DATE_FORMAT(f.paid_at, '%Y-%m-%d %H:%i:%S') AS paid_at,
               s.id AS student_id, u.login_id AS enrollment, u.name AS student_name, s.division
    """ + _FEE_FROM + where + " ORDER BY f.due_date IS NULL, f.due_date ASC, u.login_id ASC, f.id ASC"

    page = request.args.get('page', type=int)
    limit = request.args.get('limit', type=int)

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        if page is None:
            cursor.execute(select_sql, tuple(params))
            return jsonify(cursor.fetchall()), 200

        limit = min(limit, 200) if limit and limit > 0 else 50
        cursor.execute("SELECT COUNT(*) AS total " + _FEE_FROM + where, tuple(params))
        total = cursor.fetchone()['total']
        total_pages = max(1, (total + limit - 1) // limit)
        page = min(max(page, 1), total_pages)
        cursor.execute(select_sql + " LIMIT %s OFFSET %s", tuple(params) + (limit, (page - 1) * limit))
        return jsonify({"items": cursor.fetchall(), "total": total, "page": page,
                        "limit": limit, "total_pages": total_pages}), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/fees/folders', methods=['GET'])
@admin_required
def get_fee_folders():
    """The top-level folders of Fee Management (Semester + Division + Batch) with their record count, how many are
    paid and the total amount - counted by the database, so the screen does not need to load every fee record."""
    where, params = _fee_where(request.args)
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("""
            SELECT NULLIF(f.semester, 0) AS semester, NULLIF(s.division, '') AS division,
                   NULLIF(f.academic_year, '') AS academic_year,
                   COUNT(*) AS records, SUM(f.status = 'paid') AS paid, SUM(f.amount) AS total
        """ + _FEE_FROM + where + """
            GROUP BY NULLIF(f.semester, 0), NULLIF(s.division, ''), NULLIF(f.academic_year, '')
            ORDER BY semester, division, academic_year
        """, tuple(params))
        return jsonify(_fee_group_rows(cursor.fetchall())), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/fees/title-folders', methods=['GET'])
@admin_required
def get_fee_title_folders():
    """The fee-title sub-folders inside ONE Semester + Division + Batch folder (folder_semester, folder_division,
    folder_year are required; '-' = not set), with record count, paid count and total amount."""
    if any(request.args.get(k) is None for k in ('folder_semester', 'folder_division', 'folder_year')):
        return jsonify({"message": "folder_semester, folder_division and folder_year are required"}), 400
    where, params = _fee_where(request.args, use_folder=True)
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("""
            SELECT COALESCE(NULLIF(f.fee_title, ''), 'Untitled') AS fee_title,
                   COUNT(*) AS records, SUM(f.status = 'paid') AS paid, SUM(f.amount) AS total
        """ + _FEE_FROM + where + """
            GROUP BY COALESCE(NULLIF(f.fee_title, ''), 'Untitled')
            ORDER BY fee_title
        """, tuple(params))
        return jsonify(_fee_group_rows(cursor.fetchall())), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/fees', methods=['POST'])
@admin_required
def add_fee():
    """
    Creates a fee record for one student, or by passing a 'student_ids' list
    you can create them in bulk for a whole class (semester+division) at once.
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
        return jsonify({"message": "Fee item, amount and at least one student are required"}), 400

    if status not in ('paid', 'unpaid'):
        status = 'unpaid'

    conn = get_db()
    cursor = conn.cursor()
    try:
        paid_at_val = datetime.now() if status == 'paid' else None
        fee_rows = [(student_id, fee_title, amount, due_date, semester, academic_year, status, payment_link, paid_at_val)
                    for student_id in student_ids]
        # the whole class in one INSERT (instead of one INSERT per student)
        cursor.executemany("""
            INSERT INTO fees (student_id, fee_title, amount, due_date, semester, academic_year, status, payment_link, paid_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, fee_rows)
        created = len(fee_rows)
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Fee record could not be saved", "error": str(e)}), 500

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
        return jsonify({"message": "Fee item and amount are required"}), 400

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
        return jsonify({"message": "Fee record not found"}), 404
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
        return jsonify({"message": "Fee record not found"}), 404
    return jsonify({"message": f"Fee marked {new_status}"}), 200


@app.route('/api/admin/fees/folder', methods=['DELETE'])
@admin_required
def delete_fee_folder():
    """Deletes all fee records of an entire Fee folder (Semester + Division + Batch group)
    in one go. The fees table itself has no 'division' column (it comes from the
    student's row, like in get_fees()), so we match by joining with students.
    If the division query param is not sent, only records whose student has a NULL
    division (the 'All'/unset division folder) will match.
    If the optional fee_title param is given, only that title's sub-folder inside that batch
    is deleted (not the whole batch) -- for Fee Management's nested folder view."""
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
        return jsonify({"message": "Fee record not found"}), 404
    return jsonify({"message": "Fee record deleted"}), 200


# ============================================================
# Notification bell — new notices + new pending marks requests
# The count is how many new ones arrived after "since" (when the dropdown was last opened).
# As soon as the dropdown opens, the frontend saves a new "since",
# so the red dot goes away once they are seen.
# ============================================================
@app.route('/api/admin/notifications', methods=['GET'])
@admin_required
def get_notifications():
    since = request.args.get('since')   # ISO datetime string or None (first time)
    admin_id = request.user['user_id']

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    # The admin's own posted notices should not be counted in their own notification badge
    # — only notices from others (faculty) count as "new".
    if since:
        cursor.execute(
            "SELECT COUNT(*) AS c FROM notices WHERE created_at > %s AND (posted_by IS NULL OR posted_by <> %s)",
            (since, admin_id)
        )
        unseen_notices = cursor.fetchone()['c']
        cursor.execute("SELECT COUNT(*) AS c FROM marks_requests WHERE status = 'pending' AND submitted_at > %s", (since,))
        unseen_marks = cursor.fetchone()['c']
    else:
        cursor.execute(
            "SELECT COUNT(*) AS c FROM notices WHERE (posted_by IS NULL OR posted_by <> %s)",
            (admin_id,)
        )
        unseen_notices = cursor.fetchone()['c']
        cursor.execute("SELECT COUNT(*) AS c FROM marks_requests WHERE status = 'pending'")
        unseen_marks = cursor.fetchone()['c']

    cursor.execute(
        "SELECT title, created_at FROM notices WHERE (posted_by IS NULL OR posted_by <> %s) ORDER BY created_at DESC LIMIT 5",
        (admin_id,)
    )
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
# ---- Notice chat groups (admin panel) ----
#   all   : "Students, Faculty & Admin" -> target_role 'all' or 'student'
#   staff : "Admin & Faculty"           -> target_role 'faculty'  (students never see these)
ADMIN_NOTICE_GROUPS = ('all', 'staff')
NOTICE_TITLE_MAX = 150
NOTICE_CONTENT_MAX = 5000
NOTICE_CATEGORIES = ('Academic', 'Event', 'Important')


def _clean_admin_notice(title, content, category, semester, division, academic_year):
    """Returns (values dict, error). Shared by add + edit so both apply the same limits."""
    title = (title or '').strip()
    content = (content or '').strip() or None
    category = (category or 'Academic').strip()
    semester = str(semester).strip() if semester not in (None, '') else None
    division = (division or '').strip() or None
    academic_year = (academic_year or '').strip() or None
    if not title:
        return None, "Title is required"
    if len(title) > NOTICE_TITLE_MAX:
        return None, f"Title can be at most {NOTICE_TITLE_MAX} characters"
    if content and len(content) > NOTICE_CONTENT_MAX:
        return None, f"Message can be at most {NOTICE_CONTENT_MAX} characters"
    if category not in NOTICE_CATEGORIES:
        return None, "Invalid category"
    if semester is not None and not (semester.isdigit() and 1 <= int(semester) <= 12):
        return None, "Invalid semester"
    if division and len(division) > 5:
        return None, "Invalid division"
    if academic_year and len(academic_year) > 10:
        return None, "Invalid academic year"
    return {"title": title, "content": content, "category": category,
            "semester": semester, "division": division, "academic_year": academic_year}, None


@app.route('/api/admin/notices', methods=['GET'])
@admin_required
def get_notices():
    category = request.args.get('category')
    target_role = request.args.get('target_role')
    semester = request.args.get('semester')
    division = request.args.get('division')
    academic_year = request.args.get('academic_year')

    query = """SELECT n.id, n.title, n.content, n.category, n.target_role, n.semester, n.division, n.academic_year,
                      n.is_pinned, n.file_name, n.file_size, n.file_type, n.created_at, n.posted_by,
                      (SELECT u.name FROM users u WHERE u.id = n.posted_by) AS posted_by_name,
                      (SELECT u.role FROM users u WHERE u.id = n.posted_by) AS posted_by_role,
                      EXISTS(SELECT 1 FROM notice_reads ar WHERE ar.notice_id = n.id AND ar.user_id = %s) AS is_read,
                      COUNT(nr.id) AS seen_count
               FROM notices n
               LEFT JOIN notice_reads nr ON nr.notice_id = n.id
               WHERE 1=1"""
    params = [request.user['user_id']]   # for the is_read sub-select above
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
    admin_id = request.user['user_id']
    for r in rows:
        posted_by = r.pop('posted_by')
        r['is_mine'] = (posted_by == admin_id)   # a notice they posted themselves will show in a "sent" bubble on the right side
        r['is_read'] = bool(r['is_read']) or r['is_mine'] or posted_by is None   # no poster (system / deleted user) -> nothing to mark
        r['group'] = 'staff' if r['target_role'] == 'faculty' else 'all'
    return jsonify(rows), 200


@app.route('/api/admin/notices', methods=['POST'])
@admin_required
def add_notice():
    """multipart/form-data — the attachment is optional (not JSON, because a file can also come along).
    target_role 'faculty' = the "Admin & Faculty" group (no semester/division/batch, students never see it);
    'all' / 'student' = the "Students, Faculty & Admin" group."""
    target_role = request.form.get('target_role') or 'all'
    is_pinned = request.form.get('is_pinned') in ('1', 'true', 'True')
    file = request.files.get('file')

    if target_role not in ('all', 'student', 'faculty'):
        return jsonify({"message": "target_role must be all, student or faculty"}), 400
    values, error = _clean_admin_notice(
        request.form.get('title'), request.form.get('content'), request.form.get('category'),
        request.form.get('semester'), request.form.get('division'), request.form.get('academic_year'))
    if error:
        return jsonify({"message": error}), 400
    if target_role == 'faculty':
        values['semester'] = values['division'] = values['academic_year'] = None   # a staff notice has no class

    file_path = file_name = file_size = file_type = None
    if file and file.filename:
        # pass the file object (not only the name) so the content is checked too, same as the faculty upload
        if not _allowed_notice_file(file):
            return jsonify({"message": "Only valid PDF, DOC, DOCX, PPT, PPTX, JPG, PNG files are allowed"}), 400
        original_name = secure_filename(file.filename)
        file_ext = original_name.rsplit('.', 1)[1].lower()
        unique_name = f"{uuid.uuid4().hex}.{file_ext}"   # unique name to avoid collisions on disk
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
        """, (values['title'], values['content'], values['category'], target_role, values['semester'], values['division'],
              values['academic_year'], request.user['user_id'], is_pinned, file_path, file_name, file_size, file_type))
        conn.commit()
    except Exception:
        conn.rollback()
        cursor.close()
        conn.close()
        if file_path and os.path.exists(os.path.join(NOTICE_UPLOAD_FOLDER, file_path)):
            os.remove(os.path.join(NOTICE_UPLOAD_FOLDER, file_path))   # if the DB save failed, don't leave an orphan file on disk
        return jsonify({"message": "Notice could not be saved"}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Notice published"}), 201


@app.route('/api/admin/notices/<int:notice_id>', methods=['PUT'])
@admin_required
def update_notice(notice_id):
    """Admin can fix the text of any notice (moderation). The audience (target_role / semester / division / batch)
    can be changed only on a notice the admin posted themselves — a faculty's class or staff notice keeps its audience."""
    data = request.get_json(silent=True) or {}
    target_role = data.get('target_role') or 'all'
    is_pinned = bool(data.get('is_pinned'))

    if target_role not in ('all', 'student', 'faculty'):
        return jsonify({"message": "target_role must be all, student or faculty"}), 400
    values, error = _clean_admin_notice(
        data.get('title'), data.get('content'), data.get('category'),
        data.get('semester'), data.get('division'), data.get('academic_year'))
    if error:
        return jsonify({"message": error}), 400
    if target_role == 'faculty':
        values['semester'] = values['division'] = values['academic_year'] = None

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT posted_by FROM notices WHERE id = %s", (notice_id,))
    notice = cursor.fetchone()
    if not notice:
        cursor.close()
        conn.close()
        return jsonify({"message": "Notice not found"}), 404

    if notice['posted_by'] == request.user['user_id']:
        cursor.execute("""
            UPDATE notices SET title=%s, content=%s, category=%s, target_role=%s, semester=%s, division=%s, academic_year=%s, is_pinned=%s
            WHERE id=%s
        """, (values['title'], values['content'], values['category'], target_role, values['semester'], values['division'],
              values['academic_year'], is_pinned, notice_id))
    else:
        cursor.execute("""
            UPDATE notices SET title=%s, content=%s, category=%s, is_pinned=%s
            WHERE id=%s
        """, (values['title'], values['content'], values['category'], is_pinned, notice_id))
    conn.commit()
    cursor.close()
    conn.close()
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
        return jsonify({"message": "Notice not found"}), 404
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
        return jsonify({"message": "Notice not found"}), 404

    if notice and notice['file_path']:
        file_path = os.path.join(NOTICE_UPLOAD_FOLDER, notice['file_path'])
        if os.path.exists(file_path):
            os.remove(file_path)   # delete the attachment along with the DB record

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
        return jsonify({"message": "Attachment not found"}), 404

    # ?inline=1 -> sent for direct viewing (image / PDF preview inside the notice feed).
    # Any other file type is always sent as a normal download.
    ext = (notice['file_name'] or '').rsplit('.', 1)[-1].lower()
    inline = request.args.get('inline') == '1' and ext in ('jpg', 'jpeg', 'png', 'pdf')
    return send_from_directory(
        NOTICE_UPLOAD_FOLDER,
        notice['file_path'],
        as_attachment=not inline,
        download_name=notice['file_name']
    )


@app.route('/api/admin/notices/mark-read', methods=['POST'])
@admin_required
def mark_admin_notices_read():
    """Called as soon as the Notices tab opens — marks all notices posted by others (e.g. faculty)
    as 'seen' in this admin's name, so the admin shows up in the faculty's 'Seen by' list.
    The admin's own posted notices are skipped (the poster has no seen count of their own)."""
    data = request.get_json(silent=True) or {}
    group = data.get('group')
    if group is not None and group not in ADMIN_NOTICE_GROUPS:
        return jsonify({"message": "Invalid group"}), 400
    # with a group, only that chat group is marked (called when the admin opens it)
    group_sql = {None: "", 'staff': " AND n.target_role = 'faculty'", 'all': " AND n.target_role IN ('all','student')"}[group]

    conn = get_db()
    cursor = conn.cursor()
    try:
        admin_id = request.user['user_id']
        cursor.execute("""
            INSERT IGNORE INTO notice_reads (notice_id, user_id)
            SELECT n.id, %s
            FROM notices n
            WHERE n.posted_by IS NOT NULL AND n.posted_by <> %s""" + group_sql, (admin_id, admin_id))
        conn.commit()
        return jsonify({"message": "Marked as read"}), 200
    except Exception:
        conn.rollback()
        return jsonify({"message": "Failed to mark as read"}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/notices/<int:notice_id>/reads', methods=['GET'])
@admin_required
def get_notice_reads(notice_id):
    """The list of who (students/faculty) has seen this notice + the total count of the target audience."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT * FROM notices WHERE id = %s", (notice_id,))
    notice = cursor.fetchone()
    if not notice:
        cursor.close()
        conn.close()
        return jsonify({"message": "Notice not found"}), 404

    # The list of those who have seen it (name, enrollment/login id, role, when seen)
    cursor.execute("""
        SELECT u.id AS user_id, u.name, u.login_id, u.role, nr.seen_at
        FROM notice_reads nr
        JOIN users u ON u.id = nr.user_id
        WHERE nr.notice_id = %s
        ORDER BY nr.seen_at DESC
    """, (notice_id,))
    seen_by = cursor.fetchall()

    # Total count of the target audience — who was supposed to see the notice
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
        return jsonify({"message": "College email ID is not valid"}), 400

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
        return jsonify({"message": "Both current and new password are required"}), 400
    if len(new_password) < 8:
        return jsonify({"message": "New password must be at least 8 characters"}), 400

    user_id = request.user['user_id']
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT password_hash, login_id, role FROM users WHERE id = %s", (user_id,))
    user = cursor.fetchone()

    if not user or not bcrypt.checkpw(current_password.encode('utf-8'), user['password_hash'].encode('utf-8')):
        cursor.close()
        conn.close()
        return jsonify({"message": "Current password is incorrect"}), 401

    if current_password == new_password:
        cursor.close()
        conn.close()
        return jsonify({"message": "New password must be different from the current password"}), 400
    if is_default_password(user['role'], user['login_id'], new_password):
        cursor.close()
        conn.close()
        return jsonify({"message": "Please choose a password that is not the default one"}), 400

    new_hash = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    cursor.execute("UPDATE users SET password_hash = %s, must_change_password = FALSE WHERE id = %s", (new_hash, user_id))
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
    # login_time must be sent as a plain string, otherwise Flask's jsonify() serializes it
    # as GMT and the browser shows the wrong (ahead) time
    for r in rows:
        if r.get('login_time'):
            r['login_time'] = r['login_time'].strftime('%Y-%m-%d %H:%M:%S')
    return jsonify(rows), 200


# ============================================================
# Academic Year management — the dates of each year's 6 semesters
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
    # send date columns as a plain 'YYYY-MM-DD' string — otherwise Flask serializes them in HTTP-date
    # format, which doesn't work with <input type="date"> and date comparison
    for r in rows:
        for col in _SEM_COLS:
            if r.get(col):
                r[col] = r[col].strftime('%Y-%m-%d')
    return jsonify(rows), 200


@app.route('/api/admin/academic-years/term-dates', methods=['GET'])
@admin_required
def get_term_dates_for_semester():
    """For the Promote Semester form — if the date of the given (target) semester
    is already set in some academic_years row and today's date is within its range,
    returns those dates (to pre-fill the form),
    so that the admin doesn't accidentally overwrite an old date."""
    semester = request.args.get('semester')
    if not semester:
        return jsonify({"message": "semester query param is required"}), 400

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
    """The dates of any semester (1-6) can also be entered manually from Academic Management
    — this updates the same row/columns as Promote Semester,
    so the two always stay in sync."""
    data = request.get_json()
    year_label = (data.get('year_label') or '').strip()

    if not year_label:
        return jsonify({"message": "Academic year is required (e.g. 2027-28)"}), 400

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
        return jsonify({"message": "Could not add", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Academic year saved"}), 201


@app.route('/api/admin/academic-years/<int:year_id>', methods=['PUT'])
@admin_required
def update_academic_year(year_id):
    """Edits the semester dates of an existing academic year.
    year_label is not changed here — tables like students/subjects/timetable
    are linked by the text of the academic_year label, and renaming it would
    leave those records orphaned."""
    data = request.get_json() or {}

    sem_values = {}
    for n in range(1, 7):
        start = data.get(f"sem{n}_start") or None
        end = data.get(f"sem{n}_end") or None
        if start and end and start > end:
            return jsonify({"message": f"Sem {n}: start date must be before the end date"}), 400
        sem_values[f"sem{n}_start"] = start
        sem_values[f"sem{n}_end"] = end

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT id FROM academic_years WHERE id = %s", (year_id,))
    if not cursor.fetchone():
        cursor.close()
        conn.close()
        return jsonify({"message": "Academic year not found"}), 404

    try:
        set_clause = ', '.join(f"{col} = %s" for col in sem_values)
        cursor.execute(
            f"UPDATE academic_years SET {set_clause} WHERE id = %s",
            tuple(sem_values.values()) + (year_id,)
        )
        conn.commit()
    except Exception as e:
        print("UPDATE ACADEMIC YEAR ERROR:", repr(e))
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Could not update", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Academic year updated"}), 200


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
# student count, straight from the `students` table; there is no separate master table)
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
# All reports are downloaded directly as Excel (.xlsx) files.
# ============================================================

# Admin's direct marks-entry form sends "Mid-Sem", Faculty's marks
# submission form sends "Mid-Semester" — both are the same exam, so they are
# normalized here while building the report so that only one column is created.
_EXAM_TYPE_DISPLAY = {
    'mid-sem': 'Mid-Sem',
    'mid-semester': 'Mid-Sem',
    'remedial': 'Remedial',
    'internal': 'Internal',
    'practical': 'Practical',
}


def _normalize_exam_type(exam_type):
    return _EXAM_TYPE_DISPLAY.get((exam_type or '').strip().lower(), exam_type)


# ---- PDF version of the admin reports ----
# Every admin report (Student / Attendance / Assignment / Login Activity) ends in _excel_response(). If the
# request carries ?format=pdf, the very same rows are sent as a PDF table instead of an Excel sheet,
# so the admin gets Excel + PDF for every report, like the faculty panel.
_ADMIN_PDF_TITLES = {
    'students': 'Student Report',
    'attendance': 'Attendance Report',
    'assignments': 'Assignment Report',
    'login-activity': 'Login Activity Report',
}
_ADMIN_PDF_MAX_ROWS = 5000   # a PDF with tens of thousands of rows is not readable; Excel has the full list


def _report_pdf_info():
    """The filter lines printed under the PDF title (taken from the request's query params)."""
    a = request.args
    info = []
    if a.get('academic_year'):
        info.append(f"Batch: {a.get('academic_year')}")
    if a.get('semester'):
        info.append(f"Semester: {a.get('semester')}")
    if a.get('academic_year') or a.get('semester'):
        info.append(f"Division: {a.get('division') or 'All'}")
        subject_name = "All subjects"
        if a.get('subject_id'):
            try:
                conn = get_db()
                cur = conn.cursor(dictionary=True)
                cur.execute("SELECT subject_name FROM subjects WHERE id = %s", (a.get('subject_id'),))
                row = cur.fetchone()
                cur.close()
                conn.close()
                if row:
                    subject_name = row['subject_name']
            except Exception:
                pass
        info.append(f"Subject: {subject_name}")
    if 'login-activity' in request.path:
        info.append(f"From: {a.get('from_date') or 'start'}   To: {a.get('to_date') or 'today'}   Role: {(a.get('role') or 'all').title()}")
    info.append("Generated on: " + datetime.now().strftime('%d-%m-%Y %H:%M'))
    return info


def _report_pdf_response(headers, rows, filename):
    try:
        from xml.sax.saxutils import escape
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib import colors
        from reportlab.lib.units import mm
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    except ImportError:
        return jsonify({"message": "PDF export needs the 'reportlab' package on the server. Run: pip install reportlab"}), 500

    title = next((t for key, t in _ADMIN_PDF_TITLES.items() if f'/reports/{key}/' in request.path), 'Report')
    total_rows = len(rows)
    shown = rows[:_ADMIN_PDF_MAX_ROWS]

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=landscape(A4), leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=16 * mm, title=title)
    styles = getSampleStyleSheet()
    cell = ParagraphStyle('admcell', parent=styles['Normal'], fontSize=9, leading=11)
    head = ParagraphStyle('admhead', parent=cell, textColor=colors.white, fontName='Helvetica-Bold')

    story = [Paragraph(escape(title), styles['Title'])]
    story.append(Paragraph("<br/>".join(escape(line) for line in _report_pdf_info()), styles['Normal']))
    story.append(Spacer(1, 5 * mm))

    if not shown:
        story.append(Paragraph("No records found for the selected filters.", styles['Normal']))
    else:
        # Column widths follow the content length; if the table is wider than the page it is scaled down
        usable = 269.0   # landscape A4 minus margins, in mm
        lens = []
        for c, h in enumerate(headers):
            longest = len(str(h))
            for r in shown[:300]:
                longest = max(longest, len(str(r[c])) if r[c] is not None else 0)
            lens.append(min(max(longest, 4), 40))
        # a column is never narrower than its longest header word (so "Submitted" is not split in two)
        min_w = [max([len(word) for word in str(h).split()] or [4]) * 2.3 + 7 for h in headers]
        widths = [max(n * 1.9 + 6, m) for n, m in zip(lens, min_w)]
        if sum(widths) > usable:
            # shrink only the wide (text-heavy) columns; the short ones keep their size
            narrow = sum(w for w in widths if w <= 35)
            wide = sum(w for w in widths if w > 35)
            scale = (usable - narrow) / wide if wide and usable > narrow else 1
            widths = [w if w <= 35 else max(w * scale, 35 * 0.6) for w in widths]
            if sum(widths) > usable:
                widths = [w * usable / sum(widths) for w in widths]

        data = [[Paragraph(escape(str(h)), head) for h in headers]]
        for r in shown:
            data.append([Paragraph(escape('' if v is None else str(v)), cell) for v in r])
        table = Table(data, repeatRows=1, colWidths=[w * mm for w in widths], hAlign='LEFT')
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0f766e')),
            ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#cbd5d1')),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f1f7f5')]),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        story.append(table)
        story.append(Spacer(1, 4 * mm))
        count_line = f"Total rows: {total_rows}"
        if total_rows > len(shown):
            count_line += f"  (first {len(shown)} shown here - download the Excel file for the full list)"
        story.append(Paragraph("<b>" + escape(count_line) + "</b>", styles['Normal']))

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(colors.HexColor('#5b6b66'))
        canvas.drawString(14 * mm, 8 * mm, "StudentHub - " + title)
        canvas.drawRightString(landscape(A4)[0] - 14 * mm, 8 * mm, f"Page {document.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    buffer.seek(0)
    pdf_name = filename.rsplit('.', 1)[0] + '.pdf'
    return send_file(buffer, as_attachment=True, download_name=pdf_name, mimetype='application/pdf')


def _excel_response(headers, rows, filename):
    """headers: list of column names. rows: list of tuples/lists (same order as headers).
    Sends a bold header row, auto column width, and the .xlsx file directly for download.
    With ?format=pdf in the request the same rows are sent as a PDF instead."""
    if (request.args.get('format') or '').strip().lower() == 'pdf':
        return _report_pdf_response(headers, rows, filename)
    wb = Workbook()
    ws = wb.active
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(row)

    # Column width auto-fit (based on content length, a rough estimate)
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
    """Student Report — required for one specific subject (marks/attendance
    are both stored subject-wise, so selecting a subject is required)."""
    academic_year = request.args.get('academic_year')
    semester = request.args.get('semester')
    division = request.args.get('division')
    subject_id = request.args.get('subject_id')

    if not academic_year or not semester or not subject_id:
        return jsonify({"message": "academic_year, semester and subject_id are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT subject_name, department FROM subjects WHERE id = %s", (subject_id,))
    subject = cursor.fetchone()
    if not subject:
        cursor.close()
        conn.close()
        return jsonify({"message": "Subject not found"}), 404

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
    query += " ORDER BY u.login_id ASC"
    cursor.execute(query, tuple(params))
    students = cursor.fetchall()

    # Attendance % — of this subject only
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

    # Marks — of this subject only, with exam_type normalized
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
    """Attendance Report — if subject_id is given, the % of that subject, otherwise the combined/overall
    % of all subjects of that semester (which is more useful for
    GTU's 75% eligibility check)."""
    academic_year = request.args.get('academic_year')
    semester = request.args.get('semester')
    division = request.args.get('division')
    subject_id = request.args.get('subject_id')

    if not academic_year or not semester:
        return jsonify({"message": "academic_year and semester are required"}), 400

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
            return jsonify({"message": "Subject not found"}), 404
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
    query += " ORDER BY u.login_id ASC"
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
        # Combined attendance of all subjects of that semester+batch
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
    """Assignment Report — one row per student per assignment: whether it was submitted,
    when, whether it was late or on time, and whether marks were received."""
    academic_year = request.args.get('academic_year')
    semester = request.args.get('semester')
    division = request.args.get('division')
    subject_id = request.args.get('subject_id')

    if not academic_year or not semester:
        return jsonify({"message": "academic_year and semester are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    query = """
        SELECT a.id, a.title, a.due_date, a.division, sub.subject_name, sub.department AS subject_department
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
    query += " ORDER BY a.due_date DESC, a.id"   # a.id: assignments due on the same day always come out in the same order
    cursor.execute(query, tuple(params))
    assignments = cursor.fetchall()

    headers = ["Assignment", "Subject", "Due Date", "Student Name", "Enrollment", "Submitted", "Submission Date", "Status", "Marks Obtained"]
    rows = []

    all_students = []
    sub_map = {}   # (assignment id, student user id) -> submission row
    if assignments:
        # ONE query for every student of this semester + batch (instead of one student query per assignment);
        # which of them belong to an assignment is decided below, in Python
        cursor.execute("""
            SELECT u.id AS user_id, u.login_id AS enrollment, u.name, s.department, s.division
            FROM users u
            JOIN students s ON s.user_id = u.id
            WHERE u.role = 'student' AND s.academic_year = %s AND s.semester = %s
            ORDER BY u.login_id ASC
        """, (academic_year, semester))
        all_students = cursor.fetchall()

        # ONE query for the submissions of all these assignments, with the student's user id fetched by a JOIN
        # (instead of one query per assignment plus one more query per submission)
        for chunk in _chunks([a['id'] for a in assignments]):
            ph = ','.join(['%s'] * len(chunk))
            cursor.execute(f"""
                SELECT asub.assignment_id, st.user_id, asub.submitted_at, asub.marks_obtained
                FROM assignment_submissions asub
                JOIN students st ON st.id = asub.student_id
                WHERE asub.assignment_id IN ({ph})
                ORDER BY asub.id
            """, tuple(chunk))
            for row in cursor.fetchall():
                sub_map[(row['assignment_id'], row['user_id'])] = row

    for a in assignments:
        # students of the subject's department; if the assignment is for one division, only that division
        class_students = [st for st in all_students
                          if _same_text(st['department'], a['subject_department'])
                          and (not a['division'] or _same_text(st['division'], a['division']))]

        for st in class_students:
            sub = sub_map.get((a['id'], st['user_id']))
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


# ============================================================
# FEE REPORT - shared code
# Used by the Admin panel (any class, route below) and by the Faculty panel (only the classes the faculty
# teaches; faculty_routes.py imports build_fee_report / fee_report_params_error from here).
# The routes only differ in WHO may see WHICH class and how the fee rows are fetched; everything after that
# (filters, overdue rule, totals, Excel / PDF) is here, so both panels always produce the same report.
# Report types: summary (student-wise) | detail (fee-wise) | defaulters
# Overdue = unpaid + due date already passed. It is never stored; it is worked out from today's date.
# ============================================================
_FEE_REPORT_LABELS = {"summary": "Student-wise Summary", "detail": "Fee-wise Detail", "defaulters": "Defaulters"}
_FEE_STATUS_LABELS = {"all": "All", "paid": "Paid", "unpaid": "Unpaid (incl. overdue)", "overdue": "Overdue"}


def _fee_date(d):
    return d.strftime('%d-%m-%Y') if d else "-"


def _fee_rs(v):
    return f"Rs. {float(v or 0):,.2f}"


def _fee_pct(paid, total):
    return round(paid * 100 / total, 1) if total else 0.0


def _fee_prepare(rows, today):
    """Adds is_paid / is_overdue / label to every fee row."""
    for r in rows:
        r['amount'] = float(r['amount'] or 0)
        r['fee_title'] = (r['fee_title'] or '').strip() or 'Untitled'
        r['is_paid'] = (r['status'] == 'paid')
        r['is_overdue'] = (not r['is_paid']) and r['due_date'] is not None and r['due_date'] < today
        r['label'] = 'Paid' if r['is_paid'] else ('Overdue' if r['is_overdue'] else 'Unpaid')
    return rows


def _fee_student_rows(rows, today):
    """One entry per student with total / paid / pending amounts over the given fee rows."""
    students = {}
    for r in rows:
        s = students.setdefault(r['student_id'], {
            "enrollment": r['enrollment'], "name": r['name'], "division": r['division'],
            "total": 0.0, "paid": 0.0, "pending": 0.0,
            "unpaid_items": 0, "overdue_items": 0, "earliest_due": None, "days_overdue": 0})
        s['total'] += r['amount']
        if r['is_paid']:
            s['paid'] += r['amount']
            continue
        s['pending'] += r['amount']
        s['unpaid_items'] += 1
        if r['due_date'] is not None and (s['earliest_due'] is None or r['due_date'] < s['earliest_due']):
            s['earliest_due'] = r['due_date']
        if r['is_overdue']:
            s['overdue_items'] += 1
            s['days_overdue'] = max(s['days_overdue'], (today - r['due_date']).days)
    out = list(students.values())
    for s in out:
        s['label'] = 'Paid' if s['unpaid_items'] == 0 else ('Overdue' if s['overdue_items'] else 'Pending')
    return out


def _fee_build_table(report, rows, students, today):
    """Returns the table for the chosen report type (rows / students are already filtered and sorted)."""
    if report == 'summary':
        data = [[i, s['enrollment'], s['name'], s['division'] or '-', s['total'], s['paid'], s['pending'], s['label']]
                for i, s in enumerate(students, start=1)]
        return {"headers": ["#", "Enrollment", "Name", "Div", "Total Fee (Rs.)", "Paid (Rs.)", "Pending (Rs.)", "Status"],
                "data": data, "money": [4, 5, 6], "status_col": 7, "wrap": [2],
                "xlsx_widths": [6, 16, 30, 6, 16, 14, 14, 12], "pdf_widths": [12, 32, 80, 14, 32, 32, 32, 30],
                "total": sum(s['total'] for s in students), "paid": sum(s['paid'] for s in students)}
    if report == 'detail':
        data = [[i, r['enrollment'], r['name'], r['division'] or '-', r['fee_title'], r['amount'],
                 _fee_date(r['due_date']), r['label'],
                 r['paid_at'].strftime('%d-%m-%Y %H:%M') if (r['is_paid'] and r['paid_at']) else '-']
                for i, r in enumerate(rows, start=1)]
        return {"headers": ["#", "Enrollment", "Name", "Div", "Fee Item", "Amount (Rs.)", "Due Date", "Status", "Marked paid on"],
                "data": data, "money": [5], "status_col": 7, "wrap": [2, 4],
                "xlsx_widths": [6, 16, 28, 6, 24, 14, 13, 10, 18], "pdf_widths": [11, 28, 62, 12, 48, 26, 26, 22, 34],
                "total": sum(r['amount'] for r in rows), "paid": sum(r['amount'] for r in rows if r['is_paid'])}
    data = [[i, s['enrollment'], s['name'], s['division'] or '-', s['unpaid_items'], s['pending'],
             _fee_date(s['earliest_due']), s['days_overdue'] if s['days_overdue'] else '-', s['label']]
            for i, s in enumerate(students, start=1)]
    return {"headers": ["#", "Enrollment", "Name", "Div", "Unpaid Items", "Pending (Rs.)", "Earliest Due Date", "Days Overdue", "Status"],
            "data": data, "money": [5], "status_col": 8, "wrap": [2],
            "xlsx_widths": [6, 16, 30, 6, 13, 14, 17, 13, 10], "pdf_widths": [11, 28, 70, 12, 24, 32, 34, 28, 28],
            "total": sum(s['total'] for s in students), "paid": sum(s['paid'] for s in students)}


def _build_fee_xlsx(meta, tbl):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "Fee Report"
    ws.append(["Fee Report - " + meta['report']])
    ws['A1'].font = Font(bold=True, size=14)
    info = [("Batch", meta['batch']), ("Semester", meta['semester']), ("Division", meta['division']),
            ("Fee item", meta['fee_item']), ("Status filter", meta['status']), ("Generated on", meta['generated'])]
    for k, v in info:   # label and value in one cell, so the narrow first column never cuts the label
        ws.append([f"{k}: {v}"])
    ws.append([])
    for text in meta['overview']:
        ws.append([text])
        ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
    if meta.get('note'):
        ws.append([meta['note']])
        ws.cell(row=ws.max_row, column=1).font = Font(italic=True)
    ws.append([])
    ws.append(tbl['headers'])
    head_row = ws.max_row
    for cell in ws[head_row]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="0F766E")
    red = Font(color="C00000", bold=True)
    for row in tbl['data']:
        ws.append(row)
        for c in tbl['money']:
            ws.cell(row=ws.max_row, column=c + 1).number_format = '#,##0.00'
        if row[tbl['status_col']] == 'Overdue':
            ws.cell(row=ws.max_row, column=tbl['status_col'] + 1).font = red
    ws.append([])
    for text in meta['totals']:
        ws.append([text])
        ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
    for idx, w in enumerate(tbl['xlsx_widths'], start=1):
        ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = w
    ws.freeze_panes = ws.cell(row=head_row + 1, column=1)

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


def _build_fee_pdf(meta, tbl):
    from xml.sax.saxutils import escape
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=landscape(A4), leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm, title="Fee Report")
    styles = getSampleStyleSheet()
    cell_style = ParagraphStyle('feecell', parent=styles['Normal'], fontSize=9, leading=11)
    story = [Paragraph("Fee Report - " + escape(meta['report']), styles['Title'])]
    info = (
        f"<b>Batch:</b> {escape(str(meta['batch']))} &nbsp;&nbsp; <b>Semester:</b> {escape(str(meta['semester']))} &nbsp;&nbsp; "
        f"<b>Division:</b> {escape(str(meta['division']))}<br/>"
        f"<b>Fee item:</b> {escape(meta['fee_item'])} &nbsp;&nbsp; <b>Status filter:</b> {escape(meta['status'])}<br/>"
        f"<b>Generated on:</b> {escape(meta['generated'])}<br/><br/>"
        + "<br/>".join(f"<b>{escape(t)}</b>" for t in meta['overview'])
    )
    if meta.get('note'):
        info += f"<br/><i>{escape(meta['note'])}</i>"
    story.append(Paragraph(info, styles['Normal']))
    story.append(Spacer(1, 5 * mm))

    wrap = set(tbl['wrap'])
    data = [tbl['headers']]
    red_cells = []
    for i, row in enumerate(tbl['data'], start=1):
        out = []
        for c, v in enumerate(row):
            if c in tbl['money']:
                out.append(f"{float(v):,.2f}")
            elif c in wrap:
                out.append(Paragraph(escape(str(v)), cell_style))
            else:
                out.append(str(v))
        data.append(out)
        if row[tbl['status_col']] == 'Overdue':
            red_cells.append((tbl['status_col'], i))
    table = Table(data, repeatRows=1, colWidths=[w * mm for w in tbl['pdf_widths']])
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0f766e')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#cbd5d1')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f1f7f5')]),
        ('ALIGN', (3, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]
    for col, i in red_cells:
        style.append(('TEXTCOLOR', (col, i), (col, i), colors.HexColor('#C00000')))
        style.append(('FONTNAME', (col, i), (col, i), 'Helvetica-Bold'))
    table.setStyle(TableStyle(style))
    story.append(table)
    story.append(Spacer(1, 5 * mm))
    story.append(Paragraph("<br/>".join(f"<b>{escape(t)}</b>" for t in meta['totals']), styles['Normal']))

    doc.build(story)
    buffer.seek(0)
    return buffer


def fee_report_params_error(semester, academic_year, report, status, fmt):
    """Returns None when the request parameters are fine, otherwise (message, http_status)."""
    if not semester or not academic_year:
        return "Batch and semester are required", 400
    if fmt not in ('xlsx', 'pdf'):
        return "format must be xlsx or pdf", 400
    if report not in _FEE_REPORT_LABELS:
        return "report must be summary, detail or defaulters", 400
    if status not in _FEE_STATUS_LABELS:
        return "status must be all, paid, unpaid or overdue", 400
    if fmt == 'pdf':
        try:
            import reportlab   # noqa: F401  (only checking that it is installed)
        except ImportError:
            return "PDF export needs the 'reportlab' package on the server. Run: pip install reportlab", 500
    return None


def build_fee_report(all_rows, semester, academic_year, division, fee_title, status, report, fmt):
    """all_rows = every fee row of the class (one row per student per fee), already limited to the class the
    caller is allowed to see. Returns (True, (buffer, filename, mimetype)) or (False, (message, http_status))."""
    if not all_rows:
        return False, ("No fee records found for this class. Admin has not added fees for it yet.", 404)

    today = datetime.now().date()
    rows = _fee_prepare(all_rows, today)
    if fee_title:
        rows = [r for r in rows if r['fee_title'] == fee_title]
        if not rows:
            return False, ("No fee records found for the selected fee item.", 404)

    # Class overview = every student of the class (fee item filter applied, status filter NOT applied)
    class_students = _fee_student_rows(rows, today)
    ov_total = sum(s['total'] for s in class_students)
    ov_paid = sum(s['paid'] for s in class_students)
    ov_defaulters = sum(1 for s in class_students if s['unpaid_items'] > 0)
    ov_overdue = sum(1 for s in class_students if s['overdue_items'] > 0)

    # Apply the status filter and sorting for the chosen report type
    students = []
    shown_rows = []
    if report == 'detail':
        if status == 'paid':
            shown_rows = [r for r in rows if r['is_paid']]
        elif status == 'unpaid':
            shown_rows = [r for r in rows if not r['is_paid']]
        elif status == 'overdue':
            shown_rows = [r for r in rows if r['is_overdue']]
        else:
            shown_rows = list(rows)
        shown_rows.sort(key=lambda r: (str(r['enrollment']), r['due_date'] or datetime.max.date(), r['fee_title']))
    elif report == 'summary':
        students = class_students
        if status == 'paid':
            students = [s for s in students if s['unpaid_items'] == 0]
        elif status == 'unpaid':
            students = [s for s in students if s['unpaid_items'] > 0]
        elif status == 'overdue':
            students = [s for s in students if s['overdue_items'] > 0]
        students.sort(key=lambda s: str(s['enrollment']))
    else:   # defaulters: only students with something unpaid, in enrollment order (status filter is not used here)
        students = [s for s in class_students if s['unpaid_items'] > 0]
        students.sort(key=lambda s: str(s['enrollment']))

    if (report == 'detail' and not shown_rows) or (report != 'detail' and not students):
        msg = ("No defaulters found for this class - every selected fee is paid."
               if report == 'defaulters' else "No records match the selected filters.")
        return False, (msg, 404)

    tbl = _fee_build_table(report, shown_rows, students, today)
    shown_pending = tbl['total'] - tbl['paid']
    meta = {
        "report": _FEE_REPORT_LABELS[report],
        "batch": academic_year,
        "semester": semester,
        "division": division or "All",
        "fee_item": fee_title or "All fee items",
        "status": "Not used (defaulters only)" if report == 'defaulters' else _FEE_STATUS_LABELS[status],
        "generated": datetime.now().strftime('%d-%m-%Y %H:%M'),
        "overview": [
            f"Class overview: {len(class_students)} students, {len(rows)} fee records",
            f"Collected {_fee_rs(ov_paid)} of {_fee_rs(ov_total)} ({_fee_pct(ov_paid, ov_total)}%)   "
            f"Pending {_fee_rs(ov_total - ov_paid)}   Defaulters {ov_defaulters} (overdue: {ov_overdue})",
        ],
        "totals": [
            "TOTAL (rows shown)",
            f"Total fee: {_fee_rs(tbl['total'])}",
            f"Collected: {_fee_rs(tbl['paid'])}",
            f"Pending: {_fee_rs(shown_pending)}",
            f"% collected: {_fee_pct(tbl['paid'], tbl['total'])}%",
        ],
        "note": ("Marked paid on = the day the status was set to Paid in the system (not the bank payment date). "
                 "Overdue = unpaid and due date has passed.") if report == 'detail' else
                "Overdue = unpaid and due date has passed.",
    }
    base = secure_filename(
        f"fees_{report}_sem{semester}_{academic_year}" + (f"_div{division}" if division else "")
    ) or "fee_report"

    if fmt == 'pdf':
        return True, (_build_fee_pdf(meta, tbl), base + ".pdf", 'application/pdf')
    return True, (_build_fee_xlsx(meta, tbl), base + ".xlsx",
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


@app.route('/api/admin/reports/fees', methods=['GET'])
@admin_required
def report_fees():
    """Fee Report for any class. Query params: semester, academic_year (required), division (optional),
    fee_title (optional), status ('all' | 'paid' | 'unpaid' | 'overdue'),
    report ('summary' | 'detail' | 'defaulters'), format ('xlsx' | 'pdf').
    Same report as the faculty panel (shared code just above); view-only."""
    semester = request.args.get('semester', type=int)
    academic_year = (request.args.get('academic_year') or '').strip()
    division = (request.args.get('division') or '').strip()
    fee_title = (request.args.get('fee_title') or '').strip()
    status = (request.args.get('status') or 'all').strip().lower()
    report = (request.args.get('report') or 'summary').strip().lower()
    fmt = (request.args.get('format') or 'xlsx').strip().lower()

    err = fee_report_params_error(semester, academic_year, report, status, fmt)
    if err:
        return jsonify({"message": err[0]}), err[1]

    query = """
        SELECT f.id AS fee_id, st.id AS student_id, u.login_id AS enrollment, u.name, st.division,
               f.fee_title, f.amount, f.due_date, f.status, f.paid_at
        FROM fees f
        JOIN students st ON st.id = f.student_id
        JOIN users u ON u.id = st.user_id
        WHERE f.semester = %s AND f.academic_year = %s
    """
    params = [semester, academic_year]
    if division:
        query += " AND st.division = %s"
        params.append(division)
    query += " ORDER BY u.login_id, f.due_date, f.fee_title"

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(query, tuple(params))
        all_rows = cursor.fetchall()
    except Exception as e:
        return jsonify({"message": "Report could not be generated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

    ok, out = build_fee_report(all_rows, semester, academic_year, division, fee_title, status, report, fmt)
    if not ok:
        return jsonify({"message": out[0]}), out[1]
    buffer, filename, mimetype = out
    return send_file(buffer, as_attachment=True, download_name=filename, mimetype=mimetype)


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
# The mysqldump/mysql command-line tools must be in PATH on the server
# (this is already the default in XAMPP/WAMP/local MySQL installs).
# ============================================================
def _get_db_credentials():
    return {
        'host': os.getenv('DB_HOST', 'localhost'),
        'user': os.getenv('DB_USER', 'root'),
        'password': os.getenv('DB_PASSWORD', ''),
        'database': os.getenv('DB_NAME', 'studenthub'),
    }


def _run_mysqldump(filepath):
    """Dumps the current database as a .sql file at the given filepath.
    Returns (True, None) on success and (False, error_message) on failure."""
    creds = _get_db_credentials()
    env = os.environ.copy()
    if creds['password']:
        env['MYSQL_PWD'] = creds['password']   # -p is passed through an env var, not on the command line (so it doesn't show in the process list)

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
        return False, "mysqldump command not found — MySQL client tools must be installed / in PATH on the server"
    except subprocess.TimeoutExpired:
        return False, "Backup timed out (it was taking more than 5 min)"


@app.route('/api/admin/backup', methods=['POST'])
@admin_required
def create_backup():
    timestamp = datetime.now().strftime('%Y-%m-%d_%H%M%S')
    filename = f"studenthub_backup_{timestamp}.sql"
    filepath = os.path.join(BACKUP_FOLDER, filename)

    ok, error = _run_mysqldump(filepath)
    if not ok:
        return jsonify({"message": "Backup failed", "error": error}), 500

    return jsonify({"message": "Backup created", "filename": filename}), 201


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
        return jsonify({"message": "Backup file not found"}), 404
    return send_from_directory(BACKUP_FOLDER, safe_name, as_attachment=True, download_name=safe_name)


@app.route('/api/admin/backups/<path:filename>', methods=['DELETE'])
@admin_required
def delete_backup(filename):
    safe_name = secure_filename(filename)
    fpath = os.path.join(BACKUP_FOLDER, safe_name)
    if not os.path.exists(fpath):
        return jsonify({"message": "Backup file not found"}), 404
    os.remove(fpath)
    return jsonify({"message": "Backup deleted"}), 200


@app.route('/api/admin/restore', methods=['POST'])
@admin_required
def restore_backup():
    """DESTRUCTIVE — the entire current database gets overwritten. Therefore:
    1) typing 'RESTORE' to confirm is required (it comes from the frontend)
    2) a safety backup of the current state is created automatically before the restore,
    so that you can go back even if the restore is done from the wrong file."""
    confirm_text = request.form.get('confirm')
    if confirm_text != 'RESTORE':
        return jsonify({"message": "Confirmation text 'RESTORE' did not match"}), 400

    existing_filename = request.form.get('existing_filename')
    if existing_filename:
        safe_name = secure_filename(existing_filename)
        filepath = os.path.join(BACKUP_FOLDER, safe_name)
        if not os.path.exists(filepath):
            return jsonify({"message": "Backup file not found"}), 404
    else:
        file = request.files.get('file')
        if not file or not file.filename.lower().endswith('.sql'):
            return jsonify({"message": "Please upload a valid .sql file"}), 400
        safe_name = secure_filename(file.filename)
        filepath = os.path.join(BACKUP_FOLDER, f"uploaded_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{safe_name}")
        file.save(filepath)

    # Safety backup — save the state of the current DB right before the restore
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
                "message": "Restore failed — the database is still in its old state (nothing was lost)",
                "error": result.stderr.decode('utf-8', errors='ignore')
            }), 500
    except FileNotFoundError:
        return jsonify({"message": "mysql command not found — MySQL client tools must be installed / in PATH on the server"}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"message": "Restore timed out"}), 500

    return jsonify({
        "message": "Database restored" + (f" (safety backup: {safety_filename})" if safety_ok else " (the safety backup could not be created — be careful)"),
        "safety_backup": safety_filename if safety_ok else None
    }), 200


# ============================================================
# CHATBOT FAQ MANAGEMENT - the admin adds / edits / deletes the questions the chatbot answers from the DB.
# ============================================================
@app.route('/api/admin/chatbot/faqs', methods=['GET'])
@admin_required
def list_chatbot_faqs():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, question, answer, category, created_at FROM chatbot_faqs ORDER BY id DESC")
        return jsonify(cursor.fetchall()), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/chatbot/faqs', methods=['POST'])
@admin_required
def add_chatbot_faq():
    data = request.get_json() or {}
    question = (data.get('question') or '').strip()
    answer = (data.get('answer') or '').strip()
    category = (data.get('category') or '').strip() or None
    if not question or not answer:
        return jsonify({"message": "Question and answer are both required"}), 400
    if len(question) > 255:
        return jsonify({"message": "Question can be at most 255 characters"}), 400
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO chatbot_faqs (question, answer, category) VALUES (%s, %s, %s)",
                       (question, answer, category))
        conn.commit()
        return jsonify({"message": "FAQ added", "id": cursor.lastrowid}), 201
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/chatbot/faqs/<int:faq_id>', methods=['PUT'])
@admin_required
def update_chatbot_faq(faq_id):
    data = request.get_json() or {}
    question = (data.get('question') or '').strip()
    answer = (data.get('answer') or '').strip()
    category = (data.get('category') or '').strip() or None
    if not question or not answer:
        return jsonify({"message": "Question and answer are both required"}), 400
    if len(question) > 255:
        return jsonify({"message": "Question can be at most 255 characters"}), 400
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE chatbot_faqs SET question=%s, answer=%s, category=%s WHERE id=%s",
                       (question, answer, category, faq_id))
        conn.commit()
        return jsonify({"message": "FAQ updated"}), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/chatbot/faqs/<int:faq_id>', methods=['DELETE'])
@admin_required
def delete_chatbot_faq(faq_id):
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM chatbot_faqs WHERE id=%s", (faq_id,))
        conn.commit()
        return jsonify({"message": "FAQ deleted"}), 200
    finally:
        cursor.close()
        conn.close()



# ============================================================
# CHATBOT KNOWLEDGE BASE - longer reference text the chatbot can answer from (table: chatbot_knowledge)
# ============================================================
@app.route('/api/admin/chatbot/knowledge', methods=['GET'])
@admin_required
def list_chatbot_knowledge():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, title, content, created_at FROM chatbot_knowledge ORDER BY id DESC")
        return jsonify(cursor.fetchall()), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/chatbot/knowledge', methods=['POST'])
@admin_required
def add_chatbot_knowledge():
    data = request.get_json() or {}
    title = (data.get('title') or '').strip()
    content = (data.get('content') or '').strip()
    if not title or not content:
        return jsonify({"message": "Title and content are both required"}), 400
    if len(title) > 150:
        return jsonify({"message": "Title can be at most 150 characters"}), 400
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO chatbot_knowledge (title, content) VALUES (%s, %s)", (title, content))
        conn.commit()
        return jsonify({"message": "Knowledge entry added", "id": cursor.lastrowid}), 201
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/chatbot/knowledge/<int:kb_id>', methods=['PUT'])
@admin_required
def update_chatbot_knowledge(kb_id):
    data = request.get_json() or {}
    title = (data.get('title') or '').strip()
    content = (data.get('content') or '').strip()
    if not title or not content:
        return jsonify({"message": "Title and content are both required"}), 400
    if len(title) > 150:
        return jsonify({"message": "Title can be at most 150 characters"}), 400
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE chatbot_knowledge SET title=%s, content=%s WHERE id=%s", (title, content, kb_id))
        conn.commit()
        return jsonify({"message": "Knowledge entry updated"}), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/chatbot/knowledge/<int:kb_id>', methods=['DELETE'])
@admin_required
def delete_chatbot_knowledge(kb_id):
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM chatbot_knowledge WHERE id=%s", (kb_id,))
        conn.commit()
        return jsonify({"message": "Knowledge entry deleted"}), 200
    finally:
        cursor.close()
        conn.close()


# ============================================================
# CHATBOT CHAT HISTORY - review what students / faculty / admins asked (table: chat_history)
# ============================================================
@app.route('/api/admin/chatbot/history', methods=['GET'])
@admin_required
def list_chatbot_history():
    search = (request.args.get('search') or '').strip()
    query = """
        SELECT h.id, h.message, h.response, h.created_at,
               u.name AS user_name, u.login_id, u.role
        FROM chat_history h
        LEFT JOIN users u ON u.id = h.user_id
    """
    params = []
    if search:
        query += " WHERE h.message LIKE %s OR h.response LIKE %s OR u.name LIKE %s OR u.login_id LIKE %s"
        like = f"%{search}%"
        params.extend([like, like, like, like])
    query += " ORDER BY h.id DESC LIMIT 200"
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(query, tuple(params))
        return jsonify(cursor.fetchall()), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/chatbot/history/<int:chat_id>', methods=['DELETE'])
@admin_required
def delete_chatbot_history(chat_id):
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM chat_history WHERE id=%s", (chat_id,))
        conn.commit()
        return jsonify({"message": "Chat deleted"}), 200
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/chatbot/history', methods=['DELETE'])
@admin_required
def clear_chatbot_history():
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM chat_history")
        conn.commit()
        return jsonify({"message": "Chat history cleared"}), 200
    finally:
        cursor.close()
        conn.close()



@app.route('/api/admin/chat-history', methods=['GET'])
@admin_required
def admin_chat_history():
    """This user's own previous chat with the assistant (last 50 exchanges)."""
    return jsonify(get_user_chat_history(request.user['user_id'])), 200