from flask import request, jsonify, send_from_directory, send_file
from db import get_db
import bcrypt
import io
import os
import uuid
from datetime import datetime, timedelta
from werkzeug.utils import secure_filename

from app import app
from auth_middleware import faculty_required, is_default_password
from session_routes import DAY_ABBR, split_divisions, get_holiday, get_holiday_for_slot, get_cancelled_override, get_session_block_reason, has_scheduled_slot, get_extra_session, record_extra_session, get_substitute_override, get_substitute_target, get_substitute_slots_between, SessionCalendar
from chatbot_helper import find_faq_answer, get_fallback_reply, log_chat, logged_assistant, get_user_chat_history
from admin_routes import get_attendance_min, attendance_need_more, trigger_attendance_shortage_alerts, _chunks, _norm_id, NOTES_UPLOAD_FOLDER, _allowed_note_file, ASSIGNMENT_UPLOAD_FOLDER, _allowed_assignment_file, NOTICE_UPLOAD_FOLDER, _allowed_notice_file, _get_academic_year_for_date_semester, fee_report_params_error, build_fee_report


def _get_faculty_id(cursor, user_id):
    """Gets faculty.id from the JWT's user_id (users.id)."""
    cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (user_id,))
    row = cursor.fetchone()
    return row['id'] if row else None


def _real_divisions(cursor, semester, academic_year):
    """The real divisions from the students table for that semester+batch (sorted, duplicate-free)."""
    cursor.execute("""
        SELECT DISTINCT division FROM students
        WHERE semester = %s AND academic_year = %s
          AND division IS NOT NULL AND division <> ''
        ORDER BY division
    """, (semester, academic_year))
    return [r['division'] for r in cursor.fetchall()]


def _resolve_division(cursor, assignment, chosen_division):
    """If the assignment has its own division, that one is used; otherwise (the assignment is "All divisions")
    the division picked in the Division dropdown — but only if it really exists in that semester+batch.
    Returns (division, error_message)."""
    if assignment['division']:
        return assignment['division'], None
    if not chosen_division:
        return None, None
    if chosen_division not in _real_divisions(cursor, assignment['semester'], assignment['academic_year']):
        return None, f"Division {chosen_division} does not exist for Sem {assignment['semester']} ({assignment['academic_year']})"
    return chosen_division, None


def _class_division_scope(cursor, faculty_id, semester, academic_year, division):
    """For class-level screens such as Fees: whether the faculty teaches that semester+batch(+division).
    Returns (allowed, sql_clause, params). Even when "All divisions" is chosen, the faculty only sees their assigned
    divisions (unless none of their assignments is an "All divisions" one)."""
    cursor.execute("""
        SELECT division FROM faculty_subjects
        WHERE faculty_id = %s AND semester = %s AND academic_year = %s
    """, (faculty_id, semester, academic_year))
    rows = cursor.fetchall()
    if not rows:
        return False, "", ()
    assigned = {r['division'] for r in rows}
    if None in assigned:
        if division:
            return True, "AND st.division = %s", (division,)
        return True, "", ()
    if division:
        if division not in assigned:
            return False, "", ()
        return True, "AND st.division = %s", (division,)
    ordered = tuple(sorted(assigned))
    placeholders = ",".join(["%s"] * len(ordered))
    return True, f"AND st.division IN ({placeholders})", ordered


# ============================================================
# MY SUBJECTS
# ============================================================
@app.route('/api/faculty/my-subjects', methods=['GET'])
@faculty_required
def get_my_subjects():
    """Subjects assigned to the logged-in faculty (with semester + division + batch),
    with the student count and average attendance % for each subject.
    Also returns the real divisions (from the students table) of all those semester+batch combos,
    so that the division-filter dropdown can show the actual divisions for "All divisions" assignments too."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("""
            SELECT
                fs.id AS assignment_id,
                s.id AS subject_id,
                s.subject_code,
                s.subject_name,
                fs.semester,
                fs.division,
                fs.academic_year,
                (
                    SELECT COUNT(*) FROM students st
                    WHERE st.semester = fs.semester
                      AND st.academic_year = fs.academic_year
                      AND (fs.division IS NULL OR st.division = fs.division)
                ) AS student_count,
                (
                    SELECT ROUND(AVG(CASE WHEN att.status = 'present' THEN 100 ELSE 0 END))
                    FROM attendance att
                    WHERE att.subject_id = s.id
                ) AS avg_attendance
            FROM faculty_subjects fs
            JOIN subjects s ON s.id = fs.subject_id
            WHERE fs.faculty_id = %s
            ORDER BY fs.academic_year DESC, fs.semester, fs.division, s.subject_name
        """, (faculty_id,))
        subjects = cursor.fetchall()

        for row in subjects:
            row['avg_attendance'] = row['avg_attendance'] if row['avg_attendance'] is not None else 0

        # Each subject gets its available_divisions: an assignment with a specific division -> only that one division;
        # an "All divisions" assignment (division NULL) -> all the real divisions of that semester+batch (from the students table).
        # The top-level `divisions` is the union of all of these, so the dropdown doesn't list divisions not assigned to the faculty.
        real_div_cache = {}
        divisions = set()
        for row in subjects:
            if row['division']:
                row['available_divisions'] = [row['division']]
            else:
                key = (row['semester'], row['academic_year'])
                if key not in real_div_cache:
                    real_div_cache[key] = _real_divisions(cursor, row['semester'], row['academic_year'])
                row['available_divisions'] = real_div_cache[key]
            divisions.update(row['available_divisions'])

        return jsonify({"subjects": subjects, "divisions": sorted(divisions), "faculty_id": faculty_id}), 200
    except Exception as e:
        return jsonify({"message": "Subjects could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# DASHBOARD (today's summary — subjects, today's lectures, pending attendance, ungraded submissions)
# ============================================================
@app.route('/api/faculty/dashboard-summary', methods=['GET'])
@faculty_required
def get_faculty_dashboard_summary():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("SELECT COUNT(*) AS cnt FROM faculty_subjects WHERE faculty_id = %s", (faculty_id,))
        subjects_count = cursor.fetchone()['cnt']

        day_abbr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        today_day = day_abbr[datetime.now().weekday()]

        cursor.execute("""
            SELECT t.id, t.semester, t.division, t.room_no, t.session_type,
                   TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(t.end_time, '%H:%i') AS end_time,
                   t.subject_id, sub.subject_name,
                   EXISTS (
                       SELECT 1 FROM attendance a
                       WHERE a.faculty_id = %s AND a.subject_id = t.subject_id AND a.attendance_date = CURDATE()
                         AND a.session_type = t.session_type
                   ) AS attendance_marked
            FROM timetable t
            JOIN subjects sub ON sub.id = t.subject_id
            WHERE t.faculty_id = %s AND t.day_of_week = %s
            ORDER BY t.start_time
        """, (faculty_id, faculty_id, today_day))
        lectures_today = cursor.fetchall()
        today_date = datetime.now().date()
        # today's holidays + cancellations/substitutions: 2 queries (instead of up to 3 per lecture)
        cal = SessionCalendar(cursor, today_date, today_date, [l['id'] for l in lectures_today])
        for l in lectures_today:
            l['attendance_marked'] = bool(l['attendance_marked'])
            holiday = cal.holiday_for_slot(today_date, l['semester'], l['division'])
            cancelled = None if holiday else cal.cancelled(l['id'], today_date)
            substituted = None if (holiday or cancelled) else cal.substitute(l['id'], today_date)
            l['session_status'] = ('holiday' if holiday else ('cancelled' if cancelled
                                   else ('substituted' if substituted else 'held')))
            l['status_note'] = (holiday['name'] if holiday else (cancelled['reason'] if cancelled
                                else (substituted['substitute_name'] if substituted else None)))
            l['is_substitute'] = False

        # Lectures of OTHER faculty that this faculty is substituting today
        sub_slots = get_substitute_slots_between(cursor, faculty_id, today_date, today_date)
        if sub_slots:
            cursor.execute("""
                SELECT subject_id, session_type FROM attendance
                WHERE faculty_id = %s AND attendance_date = CURDATE()
            """, (faculty_id,))
            marked_today = {(r['subject_id'], r['session_type']) for r in cursor.fetchall()}
            for sl in sub_slots:
                holiday = cal.holiday_for_slot(today_date, sl['semester'], sl['division'])
                lectures_today.append({
                    "id": sl['timetable_id'], "semester": sl['semester'], "division": sl['division'],
                    "room_no": sl['room_no'], "session_type": sl['session_type'],
                    "start_time": sl['start_time'], "end_time": sl['end_time'],
                    "subject_id": sl['subject_id'], "subject_name": sl['subject_name'],
                    "attendance_marked": (sl['subject_id'], sl['session_type']) in marked_today,
                    "session_status": 'holiday' if holiday else 'held',
                    "status_note": holiday['name'] if holiday else None,
                    "is_substitute": True, "substitute_for": sl['original_faculty_name']
                })
        lectures_today.sort(key=lambda x: x['start_time'])

        now_time = datetime.now().strftime('%H:%M')
        active_today = [l for l in lectures_today if l['session_status'] == 'held']
        lectures_left_today = sum(1 for l in active_today if l['end_time'] > now_time)
        attendance_pending_today = sum(1 for l in active_today if not l['attendance_marked'] and l['start_time'] <= now_time)

        cursor.execute("""
            SELECT COUNT(*) AS cnt
            FROM assignment_submissions asub
            JOIN assignments a ON a.id = asub.assignment_id
            WHERE a.faculty_id = %s AND asub.marks_obtained IS NULL
        """, (faculty_id,))
        submissions_to_check = cursor.fetchone()['cnt']

        return jsonify({
            "subjects_count": subjects_count,
            "lectures_today": lectures_today,
            "lectures_left_today": lectures_left_today,
            "attendance_pending_today": attendance_pending_today,
            "submissions_to_check": submissions_to_check
        }), 200
    except Exception as e:
        return jsonify({"message": "Dashboard summary could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# DASHBOARD CHARTS — (1) attendance % per assigned class, (2) assignment submissions checked vs still to check
# ============================================================
@app.route('/api/faculty/dashboard-charts', methods=['GET'])
@faculty_required
def get_faculty_dashboard_charts():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        # Same class rule as /my-subjects: students of that semester + batch (+ division if the assignment has one)
        cursor.execute("""
            SELECT fs.id AS assignment_id, sub.subject_name, sub.subject_code, fs.semester, fs.division,
                   COUNT(a.id) AS total,
                   SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present
            FROM faculty_subjects fs
            JOIN subjects sub ON sub.id = fs.subject_id
            LEFT JOIN students st ON st.semester = fs.semester
                 AND st.academic_year = fs.academic_year
                 AND (fs.division IS NULL OR st.division = fs.division)
            LEFT JOIN attendance a ON a.student_id = st.id AND a.subject_id = fs.subject_id
            WHERE fs.faculty_id = %s
            GROUP BY fs.id, sub.subject_name, sub.subject_code, fs.semester, fs.division
            ORDER BY fs.semester, fs.division, sub.subject_name
        """, (faculty_id,))
        attendance_by_class = []
        for r in cursor.fetchall():
            if not r['total']:
                continue   # attendance not marked yet for this class -> no bar (a 0% bar would be misleading)
            attendance_by_class.append({
                "assignment_id": r['assignment_id'],
                "subject_name": r['subject_name'],
                "subject_code": r['subject_code'],
                "semester": r['semester'],
                "division": r['division'],
                "total": r['total'],
                "percentage": round(float(r['present'] or 0) * 100 / r['total'])
            })

        cursor.execute("""
            SELECT
                COALESCE(SUM(CASE WHEN asub.marks_obtained IS NULL THEN 1 ELSE 0 END), 0) AS to_check,
                COALESCE(SUM(CASE WHEN asub.marks_obtained IS NOT NULL THEN 1 ELSE 0 END), 0) AS checked
            FROM assignment_submissions asub
            JOIN assignments a ON a.id = asub.assignment_id
            WHERE a.faculty_id = %s
        """, (faculty_id,))
        sub_row = cursor.fetchone() or {}

        return jsonify({
            "attendance_by_class": attendance_by_class,
            "submissions": {
                "to_check": int(sub_row.get('to_check') or 0),
                "checked": int(sub_row.get('checked') or 0)
            }
        }), 200
    except Exception as e:
        return jsonify({"message": "Dashboard charts could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# DASHBOARD — "Attendance pending" card: list of dates in the last N days
# whose scheduled lectures have already happened but attendance is not yet marked
# ============================================================
ATTENDANCE_PENDING_WINDOW_DAYS = 14

@app.route('/api/faculty/attendance-pending-days', methods=['GET'])
@faculty_required
def get_faculty_attendance_pending_days():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("""
            SELECT t.id AS timetable_id, t.day_of_week, t.semester, t.division, t.room_no, t.session_type,
                   TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(t.end_time, '%H:%i') AS end_time,
                   t.subject_id, sub.subject_name
            FROM timetable t
            JOIN subjects sub ON sub.id = t.subject_id
            WHERE t.faculty_id = %s
        """, (faculty_id,))
        timetable_rows = cursor.fetchall()

        by_day = {}
        for row in timetable_rows:
            by_day.setdefault(row['day_of_week'], []).append(row)

        day_abbr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        today = datetime.now().date()
        now_time = datetime.now().strftime('%H:%M')

        pending_days = []
        total_pending = 0

        start_date = today - timedelta(days=ATTENDANCE_PENDING_WINDOW_DAYS - 1)
        cursor.execute("""
            SELECT subject_id, attendance_date, session_type
            FROM attendance
            WHERE faculty_id = %s AND attendance_date BETWEEN %s AND %s
        """, (faculty_id, start_date, today))
        marked_attendance_set = {
            (r['subject_id'], r['attendance_date'].isoformat() if hasattr(r['attendance_date'], 'isoformat') else str(r['attendance_date']), r['session_type'])
            for r in cursor.fetchall()
        }

        # holidays + cancellations/substitutions of the whole window: 2 queries (instead of up to 3 per lecture per day)
        cal = SessionCalendar(cursor, start_date, today, [r['timetable_id'] for r in timetable_rows])

        for offset in range(ATTENDANCE_PENDING_WINDOW_DAYS - 1, -1, -1):
            d = today - timedelta(days=offset)
            d_str = d.isoformat()
            rows_today = by_day.get(day_abbr[d.weekday()], [])
            if not rows_today:
                continue

            day_pending = []
            for row in rows_today:
                if d == today and row['start_time'] > now_time:
                    continue  # today's lecture hasn't happened yet
                # Holiday / cancelled slots were never held -> never "pending"
                if cal.holiday_for_slot(d, row['semester'], row['division']):
                    continue
                if cal.cancelled(row['timetable_id'], d):
                    continue
                if cal.substitute(row['timetable_id'], d):
                    continue   # someone else takes this lecture - it is his/her attendance to mark
                if (row['subject_id'], d_str, row['session_type']) not in marked_attendance_set:
                    day_pending.append({
                        "timetable_id": row['timetable_id'],
                        "subject_id": row['subject_id'],
                        "subject_name": row['subject_name'],
                        "session_type": row['session_type'],
                        "semester": row['semester'],
                        "division": row['division'],
                        "start_time": row['start_time'],
                        "end_time": row['end_time'],
                        "room_no": row['room_no']
                    })

            if day_pending:
                pending_days.append({
                    "date": d_str,
                    "day_name": day_abbr[d.weekday()],
                    "pending_count": len(day_pending),
                    "lectures": day_pending
                })
                total_pending += len(day_pending)

        # Lectures of other faculty that this faculty is substituting and has not marked yet
        by_date = {pd['date']: pd for pd in pending_days}
        for sl in get_substitute_slots_between(cursor, faculty_id, start_date, today):
            d = datetime.strptime(sl['session_date'], '%Y-%m-%d').date()
            if d == today and sl['start_time'] > now_time:
                continue
            if cal.holiday_for_slot(d, sl['semester'], sl['division']):
                continue
            if (sl['subject_id'], sl['session_date'], sl['session_type']) in marked_attendance_set:
                continue
            entry = by_date.get(sl['session_date'])
            if not entry:
                entry = {"date": sl['session_date'], "day_name": day_abbr[d.weekday()],
                         "pending_count": 0, "lectures": []}
                by_date[sl['session_date']] = entry
                pending_days.append(entry)
            entry['lectures'].append({
                "timetable_id": sl['timetable_id'], "subject_id": sl['subject_id'],
                "subject_name": sl['subject_name'], "session_type": sl['session_type'],
                "semester": sl['semester'], "division": sl['division'],
                "start_time": sl['start_time'], "end_time": sl['end_time'], "room_no": sl['room_no'],
                "is_substitute": True, "substitute_for": sl['original_faculty_name']
            })
            entry['pending_count'] += 1
            total_pending += 1

        pending_days.sort(key=lambda x: x['date'], reverse=True)  # most recent pending day on top

        return jsonify({"pending_days": pending_days, "total_pending_lectures": total_pending}), 200
    except Exception as e:
        return jsonify({"message": "Pending attendance days could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# STUDENTS (class list for one assigned subject)
# ============================================================
@app.route('/api/faculty/students', methods=['GET'])
@faculty_required
def get_faculty_students():
    """Query param: assignment_id (faculty_subjects.id, returned in the /my-subjects response).
    The students of that subject+semester+division+batch, with their attendance % and average marks % in this subject.
    assignment_id is matched against faculty_id to check that this faculty actually teaches this subject."""
    assignment_id = request.args.get('assignment_id')
    chosen_division = request.args.get('division') or None
    if not assignment_id:
        return jsonify({"message": "assignment_id is required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("""
            SELECT subject_id, semester, division, academic_year
            FROM faculty_subjects
            WHERE id = %s AND faculty_id = %s
        """, (assignment_id, faculty_id))
        assignment = cursor.fetchone()
        if not assignment:
            return jsonify({"message": "This subject is not assigned to you"}), 403

        # division NULL means this assignment has no specific division -> all students of that semester+batch
        # (or, if the faculty picked a specific division in the Division filter above, only the students of that division)
        if assignment['division']:
            division_clause = "AND st.division = %s"
            division_param = (assignment['division'],)
        elif chosen_division:
            division_clause = "AND st.division = %s"
            division_param = (chosen_division,)
        else:
            division_clause = ""
            division_param = ()

        cursor.execute(f"""
            SELECT
                st.id AS student_id,
                u.login_id AS enrollment,
                u.name,
                st.semester,
                st.division,
                st.academic_year,
                (
                    SELECT ROUND(AVG(CASE WHEN att.status = 'present' THEN 100 ELSE 0 END))
                    FROM attendance att
                    WHERE att.student_id = st.id AND att.subject_id = %s
                ) AS attendance_pct,
                (SELECT COUNT(*) FROM attendance att
                 WHERE att.student_id = st.id AND att.subject_id = %s) AS att_total,
                (SELECT COUNT(*) FROM attendance att
                 WHERE att.student_id = st.id AND att.subject_id = %s AND att.status = 'present') AS att_present,
                (
                    SELECT ROUND(AVG(m.marks_obtained / m.max_marks * 100))
                    FROM marks m
                    WHERE m.student_id = st.id AND m.subject_id = %s
                ) AS avg_marks
            FROM students st
            JOIN users u ON u.id = st.user_id
            WHERE st.semester = %s AND st.academic_year = %s {division_clause}
            ORDER BY u.login_id
        """, (assignment['subject_id'], assignment['subject_id'], assignment['subject_id'],
              assignment['subject_id'],
              assignment['semester'], assignment['academic_year']) + division_param)
        students = cursor.fetchall()

        min_pct = get_attendance_min(cursor)
        for row in students:
            row['attendance_pct'] = row['attendance_pct'] if row['attendance_pct'] is not None else 0
            row['avg_marks'] = row['avg_marks'] if row['avg_marks'] is not None else 0
            # how many more lectures this student must attend to reach the minimum % (0 if not short)
            row['attendance_need_more'] = attendance_need_more(int(row.pop('att_present') or 0), int(row.pop('att_total') or 0), min_pct)

        return jsonify({"students": students}), 200
    except Exception as e:
        return jsonify({"message": "Students could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/students', methods=['POST'])
@faculty_required
def faculty_add_student():
    """Faculty adds a new student — same fields and rules as Admin > Add student.
    Login ID = enrollment number. Default password = enrollment number; the student must change it on first login."""
    data = request.get_json() or {}
    name = (data.get('name') or '').strip()
    enrollment = (data.get('enrollment') or '').strip()
    email = (data.get('email') or '').strip() or None
    mobile = (data.get('mobile') or '').strip() or None
    whatsapp_number = (data.get('whatsapp_number') or '').strip() or None   # optional
    department = (data.get('department') or '').strip()
    semester = data.get('semester')
    division = (data.get('division') or '').strip()
    academic_year = (data.get('academic_year') or '').strip()
    gender = (data.get('gender') or '').strip() or None
    father_name = (data.get('father_name') or '').strip() or None          # optional
    father_mobile = (data.get('father_mobile') or '').strip() or None      # optional
    mother_name = (data.get('mother_name') or '').strip() or None          # optional
    mother_mobile = (data.get('mother_mobile') or '').strip() or None      # optional
    parent_email = (data.get('parent_email') or '').strip() or None        # optional
    parent_address = (data.get('parent_address') or '').strip() or None    # optional

    if not all([name, enrollment, department, semester, division, academic_year]):
        return jsonify({"message": "Name, enrollment number, department, semester, division and batch are required"}), 400
    try:
        semester = int(semester)
    except (TypeError, ValueError):
        return jsonify({"message": "Semester must be a number"}), 400
    if semester < 1 or semester > 6:
        return jsonify({"message": "Semester must be between 1 and 6"}), 400
    if whatsapp_number and (not whatsapp_number.isdigit() or not (10 <= len(whatsapp_number) <= 15)):
        return jsonify({"message": "WhatsApp number must be 10-15 digits (with country code if needed)"}), 400
    for label, number in (("Mobile number", mobile), ("Father's mobile number", father_mobile), ("Mother's mobile number", mother_mobile)):
        if number and (not number.isdigit() or len(number) != 10):
            return jsonify({"message": f"{label} must be 10 digits"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM users WHERE login_id = %s", (enrollment,))
        if cursor.fetchone():
            return jsonify({"message": "Enrollment number already exists"}), 409

        default_password = enrollment
        hashed_pw = bcrypt.hashpw(default_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

        cursor.execute(
            "INSERT INTO users (login_id, password_hash, role, name, status, must_change_password) VALUES (%s, %s, 'student', %s, 'active', TRUE)",
            (enrollment, hashed_pw, name)
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
        return jsonify({"message": "Student added", "default_password": default_password}), 201
    except Exception as e:
        conn.rollback()
        app.logger.error("Faculty failed to add student: %s", repr(e))
        return jsonify({"message": "Failed to add student"}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/student-attendance', methods=['GET'])
@faculty_required
def get_faculty_student_attendance():
    """Day-wise attendance of ONE student in ONE subject (which day present, which day absent).
    Query params: assignment_id (faculty_subjects.id — checked against this faculty), student_id.
    The student must belong to that assignment's class (semester + batch, and division if the assignment has one),
    so a faculty cannot look up a student outside the classes he/she teaches."""
    assignment_id = request.args.get('assignment_id')
    student_id = request.args.get('student_id', type=int)
    if not assignment_id or not student_id:
        return jsonify({"message": "assignment_id and student_id are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
        if not assignment:
            return jsonify({"message": "This subject is not assigned to you"}), 403

        student_sql = """
            SELECT st.id AS student_id, u.login_id AS enrollment, u.name, st.semester, st.division, st.academic_year
            FROM students st
            JOIN users u ON u.id = st.user_id
            WHERE st.id = %s AND st.semester = %s AND st.academic_year = %s
        """
        student_params = [student_id, assignment['semester'], assignment['academic_year']]
        if assignment['division']:
            student_sql += " AND st.division = %s"
            student_params.append(assignment['division'])
        cursor.execute(student_sql, tuple(student_params))
        student = cursor.fetchone()
        if not student:
            return jsonify({"message": "This student is not in your class"}), 403

        cursor.execute("SELECT subject_code, subject_name FROM subjects WHERE id = %s", (assignment['subject_id'],))
        subject = cursor.fetchone() or {}

        cursor.execute("""
            SELECT attendance_date, session_type, status
            FROM attendance
            WHERE student_id = %s AND subject_id = %s
            ORDER BY attendance_date, session_type
        """, (student_id, assignment['subject_id']))
        records = []
        for r in cursor.fetchall():
            d = r['attendance_date']
            records.append({
                "date": d.isoformat() if hasattr(d, 'isoformat') else str(d),
                "session_type": r['session_type'],
                "status": r['status']
            })

        present = sum(1 for r in records if r['status'] == 'present')
        total = len(records)
        return jsonify({
            "student": student,
            "subject": {"subject_code": subject.get('subject_code'), "subject_name": subject.get('subject_name')},
            "summary": {
                "present": present,
                "absent": total - present,
                "total": total,
                "percentage": round(present * 100 / total) if total else 0
            },
            "records": records
        }), 200
    except Exception as e:
        return jsonify({"message": "Student attendance could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


def _session_division_block(cursor, faculty_id, subject_id, semester, session_type, divisions):
    """HARD rule: if the timetable has this session type (Lecture / Lab) for this faculty + subject + semester but
    NONE of its slots is for a division in `divisions`, that division must not be marked at all
    (e.g. Lab is only in the timetable for Division B -> Division A cannot be marked, not even as an 'Extra session').
    Returns an error message, or None when it is fine (also None when the timetable has no such slot at all —
    then the normal 'Extra session' confirmation still applies)."""
    cursor.execute("""
        SELECT t.division FROM timetable t
        WHERE t.faculty_id = %s AND t.subject_id = %s AND t.semester = %s AND t.session_type = %s
    """, (faculty_id, subject_id, semester, session_type))
    rows = cursor.fetchall()
    if not rows:
        return None
    covered = set()
    covers_all = False
    for r in rows:
        divs = split_divisions(r['division'])
        if not divs:
            covers_all = True   # a slot with no division is for every division
        covered.update(divs)
    if covers_all:
        return None
    missing = [d for d in sorted({x for x in divisions if x}) if d not in covered]
    if not missing:
        return None
    return (f"{session_type} for this subject is in the timetable only for Division {', '.join(sorted(covered))} — "
            f"Division {', '.join(missing)} cannot be marked")


def _all_divisions_scope(cursor, faculty_id, subject_id, semester, session_type, date_obj):
    """For an "All divisions" assignment when NO Division filter is chosen: which divisions does the timetable
    really put this session (Lecture / Lab) on? Returns a sorted list of divisions the student list / the save must be
    limited to, or [] when there is no limit (no timetable rows at all, or a slot that is for every division).
      1) If the timetable has this session type on that WEEKDAY -> only the divisions of those slots
         (e.g. Lab is on Tuesday for Division B -> only Division B students, Division A is never listed or saved).
      2) Otherwise (a day with no slot, i.e. an Extra session) -> the divisions the timetable has this session type
         for on any weekday."""
    cursor.execute("""
        SELECT t.division, t.day_of_week FROM timetable t
        WHERE t.faculty_id = %s AND t.subject_id = %s AND t.semester = %s AND t.session_type = %s
    """, (faculty_id, subject_id, semester, session_type))
    rows = cursor.fetchall()
    if not rows:
        return []
    day = DAY_ABBR[date_obj.weekday()]

    def _divs(slot_rows):
        out = set()
        for r in slot_rows:
            d = split_divisions(r['division'])
            if not d:
                return None   # a slot with no division is for every division -> no limit
            out.update(d)
        return out

    day_rows = [r for r in rows if r['day_of_week'] == day]
    scope = _divs(day_rows) if day_rows else _divs(rows)
    return sorted(scope) if scope else []


def _get_faculty_assignment(cursor, faculty_id, assignment_id):
    """Matches assignment_id against faculty_id and fetches its subject/semester/division/batch.
    This checks that the logged-in faculty really teaches this subject (so nobody can mark another faculty's attendance)."""
    cursor.execute("""
        SELECT subject_id, semester, division, academic_year
        FROM faculty_subjects
        WHERE id = %s AND faculty_id = %s
    """, (assignment_id, faculty_id))
    return cursor.fetchone()


# ============================================================
# ATTENDANCE (mark/view for one assigned subject)
# ============================================================
@app.route('/api/faculty/attendance', methods=['GET'])
@faculty_required
def get_faculty_attendance():
    """Query params: assignment_id, date, division (optional — used only when the assignment is "All divisions",
    it comes from the Division filter above).
    The students of that subject+semester+division+batch, with their status on the given date (present/absent/None=not marked)."""
    assignment_id = request.args.get('assignment_id')
    timetable_id = request.args.get('timetable_id')   # set when this faculty is the SUBSTITUTE for that slot
    date = request.args.get('date')
    chosen_division = request.args.get('division') or None
    session_type = request.args.get('session_type') or 'Lecture'
    if (not assignment_id and not timetable_id) or not date:
        return jsonify({"message": "assignment_id (or timetable_id) and date are required"}), 400
    if session_type not in ('Lecture', 'Lab'):
        return jsonify({"message": "session_type must be Lecture or Lab"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        is_sub = False
        if timetable_id:
            try:
                date_obj = datetime.strptime(date, '%Y-%m-%d').date()
            except ValueError:
                return jsonify({"message": "Invalid date"}), 400
            target = get_substitute_target(cursor, faculty_id, timetable_id, date_obj)
            if not target:
                return jsonify({"message": "You are not the substitute for this lecture on that date"}), 403
            year_row = _get_academic_year_for_date_semester(cursor, date, target['semester'])
            if not year_row:
                return jsonify({"message": f"This date is outside Sem {target['semester']}'s date range"}), 400
            assignment = {"subject_id": target['subject_id'], "semester": target['semester'],
                          "division": target['division'] or '', "academic_year": year_row['year_label']}
            session_type = target['session_type']
            is_sub = True
        else:
            assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
            if not assignment:
                return jsonify({"message": "This subject is not assigned to you"}), 403

        # "All divisions" assignment + Division filter on "All divisions": do NOT list every division blindly —
        # only the division(s) the timetable has this Lecture / Lab for on that day (e.g. only B, never A).
        auto_divs = []
        if not is_sub and not assignment['division'] and not chosen_division:
            try:
                auto_divs = _all_divisions_scope(cursor, faculty_id, assignment['subject_id'], assignment['semester'],
                                                 session_type, datetime.strptime(date, '%Y-%m-%d').date())
            except ValueError:
                auto_divs = []

        if assignment['division'] and is_sub:
            division_clause = "AND FIND_IN_SET(st.division, %s) > 0"   # the slot's division can be 'A,B'
            division_param = (assignment['division'],)
        elif assignment['division']:
            division_clause = "AND st.division = %s"
            division_param = (assignment['division'],)
        elif chosen_division:
            division_clause = "AND st.division = %s"
            division_param = (chosen_division,)
        elif auto_divs:
            division_clause = "AND st.division IN (" + ",".join(["%s"] * len(auto_divs)) + ")"
            division_param = tuple(auto_divs)
        else:
            division_clause = ""
            division_param = ()

        cursor.execute(f"""
            SELECT
                st.id AS student_id,
                u.login_id AS enrollment,
                u.name,
                st.semester,
                st.division,
                st.academic_year,
                a.status
            FROM students st
            JOIN users u ON u.id = st.user_id
            LEFT JOIN attendance a
                ON a.student_id = st.id AND a.subject_id = %s AND a.attendance_date = %s AND a.session_type = %s
            WHERE st.semester = %s AND st.academic_year = %s {division_clause}
            ORDER BY u.login_id
        """, (assignment['subject_id'], date, session_type,
              assignment['semester'], assignment['academic_year']) + division_param)
        students = cursor.fetchall()

        # Timetable division check: e.g. Lab is only for Division B -> Division A's list is not given out at all
        blocked_message = None
        if not is_sub:
            check_divs = [assignment['division'] or chosen_division] if (assignment['division'] or chosen_division) \
                else sorted({st_row['division'] for st_row in students if st_row['division']})
            blocked_message = _session_division_block(cursor, faculty_id, assignment['subject_id'], assignment['semester'],
                                                      session_type, check_divs)
        if blocked_message:
            return jsonify({
                "subject_id": assignment['subject_id'],
                "students": [],
                "blocked_message": blocked_message,
                "scheduled": False,
                "extra": False,
                "substitute": False,
                "session_type": session_type
            }), 200

        # Is this date/type in the timetable, or already confirmed as an Extra session? (info only)
        scheduled, extra = True, False
        if not is_sub:
            try:
                date_obj = datetime.strptime(date, '%Y-%m-%d').date()
                eff_div = assignment['division'] or chosen_division or ''
                scheduled = has_scheduled_slot(cursor, faculty_id, assignment['subject_id'], assignment['semester'],
                                               eff_div, session_type, date_obj)
                extra = (not scheduled) and bool(get_extra_session(cursor, faculty_id, assignment['subject_id'],
                                                                   assignment['semester'], eff_div, session_type, date_obj))
            except ValueError:
                pass

        return jsonify({
            "subject_id": assignment['subject_id'],
            "students": students,
            "class_divisions": auto_divs,
            "scheduled": scheduled,
            "extra": extra,
            "substitute": is_sub,
            "session_type": session_type
        }), 200
    except Exception as e:
        return jsonify({"message": "Attendance could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/attendance', methods=['POST'])
@faculty_required
def save_faculty_attendance():
    """Body: { assignment_id, date, records: [{student_id, status}] }.
    Bulk mark/update — the whole class's attendance for one day is saved in one go.
    assignment_id is matched against faculty_id (nobody can mark another faculty's subject)."""
    data = request.get_json() or {}
    assignment_id = data.get('assignment_id')
    timetable_id = data.get('timetable_id')   # set when this faculty is the SUBSTITUTE for that slot
    date = data.get('date')
    records = data.get('records') or []   # [{student_id, status}]
    session_type = data.get('session_type') or 'Lecture'

    if (not assignment_id and not timetable_id) or not date or not records:
        return jsonify({"message": "assignment_id (or timetable_id), date and records are required"}), 400
    if session_type not in ('Lecture', 'Lab'):
        return jsonify({"message": "session_type must be Lecture or Lab"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        is_sub = False
        if timetable_id:
            # Substitute faculty marking another faculty's slot: allowed only on that date, only for that slot
            try:
                date_obj = datetime.strptime(date, '%Y-%m-%d').date()
            except ValueError:
                cursor.close()
                conn.close()
                return jsonify({"message": "Invalid date"}), 400
            target = get_substitute_target(cursor, faculty_id, timetable_id, date_obj)
            if not target:
                cursor.close()
                conn.close()
                return jsonify({"message": "You are not the substitute for this lecture on that date"}), 403
            sub_year_row = _get_academic_year_for_date_semester(cursor, date, target['semester'])
            if not sub_year_row:
                cursor.close()
                conn.close()
                return jsonify({"message": f"This date is outside Sem {target['semester']}'s date range — ask Admin to set this semester's start/end date"}), 400
            holiday = get_holiday_for_slot(cursor, date_obj, target['semester'], target['division'])
            if holiday:
                cursor.close()
                conn.close()
                return jsonify({"message": f"{date_obj.isoformat()} is a holiday ({holiday['name']}) — attendance cannot be marked"}), 409
            assignment = {"subject_id": target['subject_id'], "semester": target['semester'],
                          "division": target['division'] or '', "academic_year": sub_year_row['year_label']}
            session_type = target['session_type']
            is_sub = True
        else:
            assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
            if not assignment:
                return jsonify({"message": "This subject is not assigned to you"}), 403

            # Division check: an assignment with its own division can only be saved for THAT division; an
            # "All divisions" assignment needs the chosen division to be real for this semester + batch.
            chosen = (data.get('division') or '').strip()
            if assignment['division'] and chosen and chosen != assignment['division']:
                cursor.close()
                conn.close()
                return jsonify({"message": f"This subject is assigned to you for Division {assignment['division']} only — Division {chosen} cannot be marked"}), 400
            resolved_div, div_err = _resolve_division(cursor, assignment, chosen or None)
            if div_err:
                cursor.close()
                conn.close()
                return jsonify({"message": div_err}), 400

            if not _get_academic_year_for_date_semester(cursor, date, assignment['semester']):
                cursor.close()
                conn.close()
                return jsonify({"message": f"This date is outside Sem {assignment['semester']}'s date range — ask Admin to set this semester's start/end date"}), 400

            try:
                date_obj = datetime.strptime(date, '%Y-%m-%d').date()
            except ValueError:
                cursor.close()
                conn.close()
                return jsonify({"message": "Invalid date"}), 400

        subject_id = assignment['subject_id']

        # Division check (server side): every student in `records` must really belong to this class —
        # same semester + batch, and the division being marked (an assignment's own division, the substitute slot's
        # division(s), or the Division chosen for an "All divisions" assignment). Nobody else's students get saved.
        eff_div = assignment['division'] or (data.get('division') or '').strip()
        # "All divisions" + no Division chosen: the save is limited to the division(s) the timetable has this session for
        auto_divs = []
        if not is_sub and not eff_div:
            auto_divs = _all_divisions_scope(cursor, faculty_id, assignment['subject_id'], assignment['semester'],
                                             session_type, date_obj)
        wanted_ids = []
        for r in records:
            try:
                sid = int(r.get('student_id'))
            except (TypeError, ValueError):
                continue
            if sid not in wanted_ids:
                wanted_ids.append(sid)
        if not wanted_ids:
            cursor.close()
            conn.close()
            return jsonify({"message": "No valid students to save"}), 400
        placeholders = ','.join(['%s'] * len(wanted_ids))
        class_sql = f"SELECT st.id, st.division FROM students st WHERE st.id IN ({placeholders}) AND st.semester = %s AND st.academic_year = %s"
        class_params = list(wanted_ids) + [assignment['semester'], assignment['academic_year']]
        if is_sub and assignment['division']:
            class_sql += " AND FIND_IN_SET(st.division, %s) > 0"   # the slot's division can be 'A,B'
            class_params.append(assignment['division'])
        elif eff_div:
            class_sql += " AND st.division = %s"
            class_params.append(eff_div)
        elif auto_divs:
            class_sql += " AND st.division IN (" + ",".join(["%s"] * len(auto_divs)) + ")"
            class_params.extend(auto_divs)
        cursor.execute(class_sql, tuple(class_params))
        class_rows = cursor.fetchall()
        if len(class_rows) != len(wanted_ids):
            cursor.close()
            conn.close()
            where = (f"Division {eff_div}" if eff_div
                     else (f"Division {', '.join(auto_divs)}" if auto_divs else f"Sem {assignment['semester']}"))
            return jsonify({"message": f"Some of these students do not belong to {where} ({assignment['academic_year']}) — reload the list and try again"}), 400

        # Holiday / cancelled / substituted check — for the division(s) actually being marked (not the assignment's
        # blank division), so Division B's holiday or cancellation is checked for B and A's cancellation never blocks B.
        if not is_sub:
            divisions_marked = [eff_div] if eff_div else (sorted({row['division'] for row in class_rows if row['division']}) or [''])
            for div_marked in divisions_marked:
                block_reason = get_session_block_reason(cursor, faculty_id, subject_id, assignment['semester'],
                                                        div_marked, session_type, date_obj)
                if block_reason:
                    cursor.close()
                    conn.close()
                    return jsonify({"message": block_reason}), 409

        # Timetable division check (hard): if this session type is in the timetable only for other division(s)
        # (e.g. Lab only for Division B), the division being marked cannot be saved — no Extra-session option.
        if not is_sub:
            division_msg = _session_division_block(cursor, faculty_id, subject_id, assignment['semester'], session_type,
                                                   [eff_div] if eff_div else sorted({row['division'] for row in class_rows if row['division']}))
            if division_msg:
                cursor.close()
                conn.close()
                return jsonify({"message": division_msg}), 409

        # The timetable is only a plan. If this weekday/session type is NOT in the timetable, attendance is
        # saved only when the faculty confirms it as an Extra session (or it was already confirmed earlier).
        is_extra = False
        if not is_sub:
            if not has_scheduled_slot(cursor, faculty_id, subject_id, assignment['semester'], eff_div, session_type, date_obj):
                already_extra = get_extra_session(cursor, faculty_id, subject_id, assignment['semester'], eff_div, session_type, date_obj)
                if not (data.get('is_extra') or already_extra):
                    cursor.close()
                    conn.close()
                    return jsonify({
                        "message": f"{session_type} for this subject is not in your timetable on {date_obj.strftime('%A')} ({date_obj.isoformat()}).",
                        "needs_extra_confirm": True
                    }), 409
                is_extra = True

        attendance_rows = [(r.get('student_id'), subject_id, faculty_id, date, session_type, r.get('status'))
                           for r in records
                           if r.get('student_id') and r.get('status') in ('present', 'absent')]
        if attendance_rows:
            # all students in one statement (instead of one INSERT per student)
            cursor.executemany("""
                INSERT INTO attendance (student_id, subject_id, faculty_id, attendance_date, session_type, status)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE status = VALUES(status), faculty_id = VALUES(faculty_id)
            """, attendance_rows)
        if is_extra:
            record_extra_session(cursor, faculty_id, subject_id, assignment['semester'], eff_div, session_type, date_obj)
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


# ============================================================
# MARKS ENTRY (request-based workflow)
# Faculty submits -> a PENDING request is created
# Admin (admin_routes.py) accepts/rejects/publishes it
# As long as an active request (pending/approved/published) exists, the faculty cannot submit again
# Editing/submitting again is allowed only after a 'rejected' request
# ============================================================
def _get_latest_marks_request(cursor, faculty_id, subject_id, exam_type, semester, division, academic_year):
    """The latest request (if any) for this subject+exam+division — its status decides
    whether the faculty can edit right now."""
    cursor.execute("""
        SELECT id, status, max_marks, submitted_at, reviewed_at, remarks
        FROM marks_requests
        WHERE faculty_id = %s AND subject_id = %s AND exam_type = %s
          AND semester = %s AND (division <=> %s) AND academic_year = %s
        ORDER BY submitted_at DESC
        LIMIT 1
    """, (faculty_id, subject_id, exam_type, semester, division, academic_year))
    return cursor.fetchone()


@app.route('/api/faculty/marks/requests', methods=['GET'])
@faculty_required
def get_my_marks_requests():
    """All of the faculty's own marks requests (every subject/exam), with their latest status —
    for the 'My Submissions' list at the top of the Marks Entry screen."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("""
            SELECT
                mr.id, mr.exam_type, mr.semester, mr.division, mr.academic_year,
                mr.max_marks, mr.status, mr.submitted_at, mr.reviewed_at, mr.remarks,
                sub.subject_name
            FROM marks_requests mr
            JOIN subjects sub ON sub.id = mr.subject_id
            WHERE mr.faculty_id = %s
            ORDER BY mr.submitted_at DESC
            LIMIT 30
        """, (faculty_id,))
        requests_list = cursor.fetchall()
        return jsonify({"requests": requests_list}), 200
    except Exception as e:
        return jsonify({"message": "Requests could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/marks', methods=['GET'])
@faculty_required
def get_faculty_marks():
    """Query params: assignment_id, exam_type.
    The students of that subject+semester+division+batch, with the latest request's status and marks (if any)."""
    assignment_id = request.args.get('assignment_id')
    exam_type = request.args.get('exam_type')
    chosen_division = request.args.get('division') or None
    if not assignment_id or not exam_type:
        return jsonify({"message": "assignment_id and exam_type are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
        if not assignment:
            return jsonify({"message": "This subject is not assigned to you"}), 403

        subject_id = assignment['subject_id']
        semester = assignment['semester']
        academic_year = assignment['academic_year']
        # If the assignment has its own division, use that; otherwise (the assignment is "All divisions")
        # use the division picked in the Division filter above — same behaviour as the Students/Attendance tabs
        division, division_error = _resolve_division(cursor, assignment, chosen_division)
        if division_error:
            return jsonify({"message": division_error}), 400

        latest_request = _get_latest_marks_request(
            cursor, faculty_id, subject_id, exam_type, semester, division, academic_year
        )

        if division:
            division_clause = "AND st.division = %s"
            division_param = (division,)
        else:
            division_clause = ""
            division_param = ()

        request_id = latest_request['id'] if latest_request else None
        cursor.execute(f"""
            SELECT
                st.id AS student_id,
                u.login_id AS enrollment,
                u.name,
                st.semester,
                st.division,
                st.academic_year,
                m.marks_obtained
            FROM students st
            JOIN users u ON u.id = st.user_id
            LEFT JOIN marks m
                ON m.student_id = st.id AND m.request_id = %s
            WHERE st.semester = %s AND st.academic_year = %s {division_clause}
            ORDER BY u.login_id
        """, (request_id, semester, academic_year) + division_param)
        students = cursor.fetchall()

        return jsonify({
            "subject_id": subject_id,
            "students": students,
            "request_status": latest_request['status'] if latest_request else None,
            "max_marks": latest_request['max_marks'] if latest_request else None,
            "remarks": latest_request['remarks'] if latest_request else None,
            "submitted_at": str(latest_request['submitted_at']) if latest_request else None
        }), 200
    except Exception as e:
        return jsonify({"message": "Marks could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/marks', methods=['POST'])
@faculty_required
def save_faculty_marks():
    """Body: { assignment_id, exam_type, max_marks, records: [{student_id, marks_obtained}] }.
    Creates a new PENDING request. If a request for this subject+exam is already pending/approved/published,
    it is rejected — the admin's decision must come first (a resubmission is possible only after a rejection)."""
    data = request.get_json() or {}
    assignment_id = data.get('assignment_id')
    exam_type = data.get('exam_type')
    max_marks = data.get('max_marks')
    chosen_division = data.get('division') or None
    records = data.get('records') or []   # [{student_id, marks_obtained}]

    if not assignment_id or not exam_type or max_marks is None or not records:
        return jsonify({"message": "assignment_id, exam_type, max_marks and records are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
        if not assignment:
            return jsonify({"message": "This subject is not assigned to you"}), 403

        subject_id = assignment['subject_id']
        semester = assignment['semester']
        # If the assignment has its own division, use that; otherwise (the assignment is "All divisions")
        # use the division picked in the Division filter above — so each division's request is tracked separately
        division, division_error = _resolve_division(cursor, assignment, chosen_division)
        if division_error:
            cursor.close()
            conn.close()
            return jsonify({"message": division_error}), 400
        academic_year = assignment['academic_year']

        latest_request = _get_latest_marks_request(
            cursor, faculty_id, subject_id, exam_type, semester, division, academic_year
        )
        if latest_request and latest_request['status'] in ('pending', 'approved', 'published'):
            return jsonify({
                "message": f"A request for this exam is already '{latest_request['status']}' — a new one can't be submitted",
                "request_status": latest_request['status']
            }), 409

        cursor.execute("""
            INSERT INTO marks_requests (faculty_id, subject_id, exam_type, semester, division, academic_year, max_marks, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending')
        """, (faculty_id, subject_id, exam_type, semester, division, academic_year, max_marks))
        new_request_id = cursor.lastrowid

        marks_rows = []
        for r in records:
            student_id = r.get('student_id')
            marks_obtained = r.get('marks_obtained')
            if student_id is None or marks_obtained is None or marks_obtained == '':
                continue
            try:
                if float(marks_obtained) > float(max_marks):
                    continue   # ignore marks above the max marks
            except (TypeError, ValueError):
                continue
            marks_rows.append((student_id, subject_id, exam_type, marks_obtained, max_marks, semester, academic_year, new_request_id))

        if marks_rows:
            # the whole class in one INSERT (instead of one INSERT per student)
            cursor.executemany(
                "INSERT INTO marks (student_id, subject_id, exam_type, marks_obtained, max_marks, semester, academic_year, published, request_id) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s, FALSE, %s)",
                marks_rows
            )
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Marks submit failed", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Marks request submitted, pending admin review"}), 200


# ============================================================
# FEES ENTRY (fee records of the faculty's assigned class — they can only toggle the paid/unpaid status;
# creating/editing fee items, payment links and due dates all stay with Admin)
# ============================================================
@app.route('/api/faculty/fees', methods=['GET'])
@faculty_required
def get_faculty_fees():
    """Query params: semester, academic_year, division (optional).
    Shows only the fee records that Admin has already created for that class —
    if Admin hasn't set up fees for that semester+batch yet, the list will be empty."""
    semester = request.args.get('semester')
    academic_year = request.args.get('academic_year')
    division = request.args.get('division') or None
    if not semester or not academic_year:
        return jsonify({"message": "semester and academic_year are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        # Check whether the faculty teaches this semester+batch(+division).
        # Even when "All divisions" is chosen, only records of the faculty's assigned divisions are returned.
        allowed, division_clause, division_param = _class_division_scope(
            cursor, faculty_id, semester, academic_year, division
        )
        if not allowed:
            return jsonify({"message": "This class is not assigned to you"}), 403

        cursor.execute(f"""
            SELECT
                f.id AS fee_id,
                st.id AS student_id,
                u.login_id AS enrollment,
                u.name,
                st.semester,
                st.division,
                st.academic_year,
                f.fee_title,
                f.amount,
                DATE_FORMAT(f.due_date, '%Y-%m-%d') AS due_date,
                f.status
            FROM students st
            JOIN users u ON u.id = st.user_id
            JOIN fees f ON f.student_id = st.id AND f.semester = %s AND f.academic_year = %s
            WHERE st.semester = %s AND st.academic_year = %s {division_clause}
            ORDER BY u.login_id, f.fee_title
        """, (semester, academic_year, semester, academic_year) + division_param)
        rows = cursor.fetchall()
        for r in rows:
            r['amount'] = float(r['amount']) if r['amount'] is not None else None

        return jsonify({"fees": rows}), 200
    except Exception as e:
        return jsonify({"message": "Fees could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/fees', methods=['POST'])
@faculty_required
def save_faculty_fees():
    """Body: { semester, academic_year, division, updates: [{fee_id, status}] }.
    Bulk status update — the faculty can change the status (paid/unpaid) only of fee records of their assigned class."""
    data = request.get_json() or {}
    semester = data.get('semester')
    academic_year = data.get('academic_year')
    division = data.get('division') or None
    updates = data.get('updates') or []

    if not semester or not academic_year or not updates:
        return jsonify({"message": "semester, academic_year and updates are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        allowed, division_clause, division_param = _class_division_scope(
            cursor, faculty_id, semester, academic_year, division
        )
        if not allowed:
            return jsonify({"message": "This class is not assigned to you"}), 403

        # The last status sent for a fee wins (same result as applying the updates one after another)
        wanted = {}
        for u in updates:
            fee_id = u.get('fee_id')
            status = u.get('status')
            if not fee_id or status not in ('paid', 'unpaid'):
                continue
            wanted[_norm_id(fee_id)] = status

        updated = 0
        for status in ('paid', 'unpaid'):
            fee_ids = [fid for fid, st in wanted.items() if st == status]
            # one UPDATE per status (instead of one per fee); the fee must belong to a student of this
            # semester+batch(+division) only — verified with this join
            for chunk in _chunks(fee_ids):
                ph = ','.join(['%s'] * len(chunk))
                cursor.execute(f"""
                    UPDATE fees f
                    JOIN students st ON st.id = f.student_id
                    SET f.status = %s,
                        f.paid_at = CASE WHEN %s = 'paid' THEN CURRENT_TIMESTAMP ELSE NULL END
                    WHERE f.id IN ({ph}) AND st.semester = %s AND st.academic_year = %s {division_clause}
                """, (status, status) + tuple(chunk) + (semester, academic_year) + division_param)
                updated += cursor.rowcount
        conn.commit()
        return jsonify({"message": f"{updated} fee record(s) updated"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Fee status could not be saved", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# MATERIALS (the faculty uploads/lists/edits/deletes study materials of their assigned subjects;
# the `notes` table is shared with Admin — faculty_id tracks who uploaded it,
# so each faculty can edit/delete only their own uploads)
# ============================================================
@app.route('/api/faculty/materials', methods=['GET'])
@faculty_required
def get_faculty_materials():
    """Query params: assignment_id, division (optional — used only when the assignment is
    'All divisions', it comes from the Division filter above).
    All materials of that subject+semester+batch (uploaded by Admin or any faculty) —
    the 'can_manage' flag says whether this faculty uploaded the material themselves."""
    assignment_id = request.args.get('assignment_id')
    chosen_division = request.args.get('division') or None
    if not assignment_id:
        return jsonify({"message": "assignment_id is required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
        if not assignment:
            return jsonify({"message": "This subject is not assigned to you"}), 403

        division, division_error = _resolve_division(cursor, assignment, chosen_division)
        if division_error:
            return jsonify({"message": division_error}), 400
        if division:
            division_clause = "AND (n.division IS NULL OR n.division = %s)"
            division_param = (division,)
        else:
            division_clause = ""
            division_param = ()

        cursor.execute(f"""
            SELECT
                n.id, n.title, n.description, n.semester, n.division, n.academic_year,
                n.file_name, n.file_size, n.file_type, n.uploaded_at, n.faculty_id,
                CASE WHEN n.faculty_id IS NULL THEN 'Admin' ELSE u.name END AS uploaded_by
            FROM notes n
            LEFT JOIN faculty f ON f.id = n.faculty_id
            LEFT JOIN users u ON u.id = f.user_id
            WHERE n.subject_id = %s AND n.semester = %s AND n.academic_year = %s {division_clause}
            ORDER BY n.uploaded_at DESC
        """, (assignment['subject_id'], assignment['semester'], assignment['academic_year']) + division_param)
        rows = cursor.fetchall()
        for r in rows:
            r['can_manage'] = (r['faculty_id'] == faculty_id)
            del r['faculty_id']

        return jsonify({"materials": rows}), 200
    except Exception as e:
        return jsonify({"message": "Materials could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/materials', methods=['POST'])
@faculty_required
def upload_faculty_material():
    """multipart/form-data: assignment_id, title, description (optional), division (optional —
    the division chosen above for an 'All divisions' assignment), file."""
    assignment_id = request.form.get('assignment_id')
    title = request.form.get('title')
    description = request.form.get('description') or None
    chosen_division = request.form.get('division') or None
    file = request.files.get('file')

    if not assignment_id or not title or not file or file.filename == '':
        return jsonify({"message": "Subject, title and file are required"}), 400

    if not _allowed_note_file(file):
        return jsonify({"message": "Invalid file format. Only valid PDF, DOC, DOCX, PPT, PPTX files are allowed"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    faculty_id = _get_faculty_id(cursor, request.user['user_id'])
    if not faculty_id:
        cursor.close()
        conn.close()
        return jsonify({"message": "Faculty record not found"}), 404

    assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
    if not assignment:
        cursor.close()
        conn.close()
        return jsonify({"message": "This subject is not assigned to you"}), 403

    division, division_error = _resolve_division(cursor, assignment, chosen_division)
    if division_error:
        cursor.close()
        conn.close()
        return jsonify({"message": division_error}), 400

    original_name = secure_filename(file.filename)
    file_ext = original_name.rsplit('.', 1)[1].lower()
    unique_name = f"{uuid.uuid4().hex}.{file_ext}"   # unique name to avoid collisions on disk
    save_path = os.path.join(NOTES_UPLOAD_FOLDER, unique_name)

    file.save(save_path)
    file_size = os.path.getsize(save_path)

    try:
        cursor.execute("""
            INSERT INTO notes (subject_id, faculty_id, title, description, semester, division, academic_year, file_path, file_name, file_size, file_type)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            assignment['subject_id'], faculty_id, title, description,
            assignment['semester'], division, assignment['academic_year'],
            unique_name, original_name, file_size, file_ext
        ))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        if os.path.exists(save_path):
            os.remove(save_path)   # if the DB save failed, don't leave an orphan file on disk
        return jsonify({"message": "Material could not be saved", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Material uploaded"}), 201


@app.route('/api/faculty/materials/<int:note_id>', methods=['PUT'])
@faculty_required
def update_faculty_material(note_id):
    """Only the details (title/description) can be edited — the file cannot be replaced.
    Only the faculty who uploaded this material can edit it."""
    data = request.get_json() or {}
    title = data.get('title')
    description = data.get('description') or None
    if not title:
        return jsonify({"message": "Title is required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("SELECT faculty_id FROM notes WHERE id = %s", (note_id,))
        note = cursor.fetchone()
        if not note:
            return jsonify({"message": "Material not found"}), 404
        if note['faculty_id'] != faculty_id:
            return jsonify({"message": "You can only edit material you uploaded yourself"}), 403

        cursor.execute("UPDATE notes SET title=%s, description=%s WHERE id=%s", (title, description, note_id))
        conn.commit()
        return jsonify({"message": "Material updated"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Material could not be updated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/materials/<int:note_id>', methods=['DELETE'])
@faculty_required
def delete_faculty_material(note_id):
    """Only the faculty who uploaded this material can delete it."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("SELECT faculty_id, file_path FROM notes WHERE id = %s", (note_id,))
        note = cursor.fetchone()
        if not note:
            return jsonify({"message": "Material not found"}), 404
        if note['faculty_id'] != faculty_id:
            return jsonify({"message": "You can only delete material you uploaded yourself"}), 403

        cursor.execute("DELETE FROM notes WHERE id = %s", (note_id,))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Material could not be deleted", "error": str(e)}), 500

    cursor.close()
    conn.close()

    file_path = os.path.join(NOTES_UPLOAD_FOLDER, note['file_path'])
    if os.path.exists(file_path):
        os.remove(file_path)   # delete the actual file along with the DB record

    return jsonify({"message": "Material deleted"}), 200


@app.route('/api/faculty/materials/<int:note_id>/download', methods=['GET'])
@faculty_required
def download_faculty_material(note_id):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT file_path, file_name FROM notes WHERE id = %s", (note_id,))
    note = cursor.fetchone()
    cursor.close()
    conn.close()

    if not note:
        return jsonify({"message": "Material not found"}), 404

    return send_from_directory(
        NOTES_UPLOAD_FOLDER,
        note['file_path'],
        as_attachment=True,
        download_name=note['file_name']
    )


# ============================================================
# ASSIGNMENTS (assignments of their assigned subjects — shared with Admin's `assignments` table.
# Add/Edit/Delete is allowed only on assignments they created themselves; and once any
# submission arrives for an assignment, editing its details is locked — only submissions/marks can be reviewed.)
# ============================================================
def _get_visible_faculty_assignment(cursor, faculty_id, assignment_id):
    """An assignment is returned only if it is within this faculty's assigned subject+semester+batch scope
    (no matter which faculty created the assignment for that same subject/class)."""
    cursor.execute("""
        SELECT a.*
        FROM assignments a
        WHERE a.id = %s
          AND EXISTS (
              SELECT 1 FROM faculty_subjects fs
              WHERE fs.faculty_id = %s
                AND fs.subject_id = a.subject_id
                AND fs.semester = a.semester
                AND fs.academic_year = a.academic_year
                AND (a.division IS NULL OR fs.division IS NULL OR fs.division = a.division)
          )
    """, (assignment_id, faculty_id))
    return cursor.fetchone()


@app.route('/api/faculty/assignments', methods=['GET'])
@faculty_required
def get_faculty_assignments():
    """Query params: semester, subject_id, division, academic_year, search (title) — all optional.
    Shows only assignments within this faculty's assigned subject+semester+batch scope."""
    semester = request.args.get('semester')
    subject_id = request.args.get('subject_id')
    division = request.args.get('division')
    academic_year = request.args.get('academic_year')
    search = request.args.get('search')

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        query = """
            SELECT a.id, a.title, a.description, a.semester, a.division, a.academic_year,
                   DATE_FORMAT(a.due_date, '%Y-%m-%d') AS due_date,
                   a.file_name, a.file_size, a.file_type, a.created_at,
                   a.subject_id, sub.subject_name, a.faculty_id,
                   COUNT(DISTINCT asub.id) AS submission_count
            FROM assignments a
            JOIN subjects sub ON sub.id = a.subject_id
            LEFT JOIN assignment_submissions asub ON asub.assignment_id = a.id
            WHERE EXISTS (
                SELECT 1 FROM faculty_subjects fs
                WHERE fs.faculty_id = %s
                  AND fs.subject_id = a.subject_id
                  AND fs.semester = a.semester
                  AND fs.academic_year = a.academic_year
                  AND (a.division IS NULL OR fs.division IS NULL OR fs.division = a.division)
            )
        """
        params = [faculty_id]
        if semester:
            query += " AND a.semester = %s"
            params.append(semester)
        if subject_id:
            query += " AND a.subject_id = %s"
            params.append(subject_id)
        if division:
            query += " AND (a.division = %s OR a.division IS NULL)"
            params.append(division)
        if academic_year:
            query += " AND a.academic_year = %s"
            params.append(academic_year)
        if search:
            query += " AND a.title LIKE %s"
            params.append(f"%{search}%")
        query += " GROUP BY a.id, a.title, a.description, a.semester, a.division, a.academic_year, a.due_date, a.file_name, a.file_size, a.file_type, a.created_at, a.subject_id, sub.subject_name, a.faculty_id"
        query += " ORDER BY a.due_date ASC, a.created_at DESC"

        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        for row in rows:
            row['can_manage'] = (row['faculty_id'] == faculty_id)
            del row['faculty_id']

        return jsonify(rows), 200
    except Exception as e:
        return jsonify({"message": "Assignments could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/assignments', methods=['POST'])
@faculty_required
def add_faculty_assignment():
    """multipart/form-data: assignment_id (faculty_subjects.id), title, description (optional),
    due_date (optional), division (optional — used only when the assignment is "All divisions"),
    file (optional, PDF/DOC/DOCX/PPT/PPTX)."""
    assignment_id = request.form.get('assignment_id')
    title = request.form.get('title')
    description = request.form.get('description') or None
    due_date = request.form.get('due_date') or None
    chosen_division = request.form.get('division') or None
    file = request.files.get('file')

    if not assignment_id or not title:
        return jsonify({"message": "Subject and title are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    faculty_id = _get_faculty_id(cursor, request.user['user_id'])
    if not faculty_id:
        cursor.close()
        conn.close()
        return jsonify({"message": "Faculty record not found"}), 404

    assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
    if not assignment:
        cursor.close()
        conn.close()
        return jsonify({"message": "This subject is not assigned to you"}), 403

    division, division_error = _resolve_division(cursor, assignment, chosen_division)
    if division_error:
        cursor.close()
        conn.close()
        return jsonify({"message": division_error}), 400

    unique_name = None
    original_name = None
    file_size = None
    file_ext = None

    if file and file.filename:
        if not _allowed_assignment_file(file):
            cursor.close()
            conn.close()
            return jsonify({"message": "Invalid file format. Only valid PDF, DOC, DOCX, PPT, PPTX files are allowed"}), 400
        original_name = secure_filename(file.filename)
        file_ext = original_name.rsplit('.', 1)[1].lower()
        unique_name = f"{uuid.uuid4().hex}.{file_ext}"
        save_path = os.path.join(ASSIGNMENT_UPLOAD_FOLDER, unique_name)
        file.save(save_path)
        file_size = os.path.getsize(save_path)

    try:
        cursor.execute("""
            INSERT INTO assignments (subject_id, faculty_id, title, description, semester, division, academic_year, due_date, file_path, file_name, file_size, file_type)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            assignment['subject_id'], faculty_id, title, description,
            assignment['semester'], division, assignment['academic_year'], due_date,
            unique_name, original_name, file_size, file_ext
        ))
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


@app.route('/api/faculty/assignments/<int:assignment_id>', methods=['PUT'])
@faculty_required
def update_faculty_assignment(assignment_id):
    """Only title/due_date/description can be edited (not subject/division/semester) —
    and only when (a) the faculty created this assignment themselves and (b) no submission has arrived yet."""
    data = request.get_json() or {}
    title = data.get('title')
    due_date = data.get('due_date') or None
    description = data.get('description') or None

    if not title:
        return jsonify({"message": "Title is required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("SELECT faculty_id FROM assignments WHERE id = %s", (assignment_id,))
        assignment = cursor.fetchone()
        if not assignment:
            return jsonify({"message": "Assignment not found"}), 404
        if assignment['faculty_id'] != faculty_id:
            return jsonify({"message": "You can only edit an assignment you created yourself"}), 403

        cursor.execute("SELECT COUNT(*) AS cnt FROM assignment_submissions WHERE assignment_id = %s", (assignment_id,))
        if cursor.fetchone()['cnt'] > 0:
            return jsonify({"message": "A submission has already come in for this assignment, so it can no longer be edited"}), 403

        cursor.execute("UPDATE assignments SET title=%s, due_date=%s, description=%s WHERE id=%s",
                        (title, due_date, description, assignment_id))
        conn.commit()
        return jsonify({"message": "Assignment updated"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Assignment could not be updated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/assignments/<int:assignment_id>', methods=['DELETE'])
@faculty_required
def delete_faculty_assignment(assignment_id):
    """Only the faculty who created this assignment can delete it.
    On delete, its attachment file and all student submissions (and their files) are removed too."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("SELECT faculty_id, file_path FROM assignments WHERE id = %s", (assignment_id,))
        assignment = cursor.fetchone()
        if not assignment:
            return jsonify({"message": "Assignment not found"}), 404
        if assignment['faculty_id'] != faculty_id:
            return jsonify({"message": "You can only delete an assignment you created yourself"}), 403

        cursor.execute("SELECT file_path FROM assignment_submissions WHERE assignment_id = %s", (assignment_id,))
        submission_files = [row['file_path'] for row in cursor.fetchall() if row['file_path']]

        cursor.execute("DELETE FROM assignments WHERE id = %s", (assignment_id,))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Assignment could not be deleted", "error": str(e)}), 500

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


@app.route('/api/faculty/assignments/<int:assignment_id>/download', methods=['GET'])
@faculty_required
def download_faculty_assignment(assignment_id):
    """Downloads the assignment's attachment (question paper)."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    faculty_id = _get_faculty_id(cursor, request.user['user_id'])
    if not faculty_id:
        cursor.close()
        conn.close()
        return jsonify({"message": "Faculty record not found"}), 404

    assignment = _get_visible_faculty_assignment(cursor, faculty_id, assignment_id)
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


@app.route('/api/faculty/assignments/<int:assignment_id>/submissions', methods=['GET'])
@faculty_required
def get_faculty_assignment_submissions(assignment_id):
    """All eligible students of the assignment's semester+division, with their submission status/marks (if submitted)."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        assignment = _get_visible_faculty_assignment(cursor, faculty_id, assignment_id)
        if not assignment:
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
        due_date_str = assignment['due_date'].strftime('%Y-%m-%d') if assignment['due_date'] else None
        for row in rows:
            row['due_date'] = due_date_str

        return jsonify(rows), 200
    except Exception as e:
        return jsonify({"message": "Submissions could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/assignments/<int:assignment_id>/submissions/<int:student_id>', methods=['PUT'])
@faculty_required
def upsert_faculty_submission(assignment_id, student_id):
    """The faculty manually sets a student's submission status — Submitted/Late/Pending, along with marks.
    Only the faculty who created this assignment can do this."""
    data = request.get_json() or {}
    submitted = data.get('submitted', True)
    submitted_at = data.get('submitted_at')
    marks = data.get('marks_obtained')

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("SELECT faculty_id FROM assignments WHERE id = %s", (assignment_id,))
        assignment = cursor.fetchone()
        if not assignment:
            return jsonify({"message": "Assignment not found"}), 404
        if assignment['faculty_id'] != faculty_id:
            return jsonify({"message": "You can only edit submissions for an assignment you created yourself"}), 403

        cursor.execute(
            "SELECT id FROM assignment_submissions WHERE assignment_id = %s AND student_id = %s",
            (assignment_id, student_id)
        )
        existing = cursor.fetchone()

        if not submitted:
            if existing:
                cursor.execute("DELETE FROM assignment_submissions WHERE id = %s", (existing['id'],))
                conn.commit()
            return jsonify({"message": "Marked as pending"}), 200

        if not submitted_at:
            from datetime import date
            submitted_at = date.today().isoformat()

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
        return jsonify({"message": "Submission updated"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Submission could not be updated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/assignments/submissions/<int:submission_id>/download', methods=['GET'])
@faculty_required
def download_faculty_submission(submission_id):
    """Downloads a student's submitted file (only if the assignment is within this faculty's scope)."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    faculty_id = _get_faculty_id(cursor, request.user['user_id'])
    if not faculty_id:
        cursor.close()
        conn.close()
        return jsonify({"message": "Faculty record not found"}), 404

    cursor.execute("""
        SELECT asub.file_path, asub.assignment_id
        FROM assignment_submissions asub
        WHERE asub.id = %s
    """, (submission_id,))
    submission = cursor.fetchone()
    if not submission:
        cursor.close()
        conn.close()
        return jsonify({"message": "File not found"}), 404

    assignment = _get_visible_faculty_assignment(cursor, faculty_id, submission['assignment_id'])
    cursor.close()
    conn.close()

    if not assignment or not submission['file_path']:
        return jsonify({"message": "File not found"}), 404

    return send_from_directory(
        ASSIGNMENT_UPLOAD_FOLDER,
        submission['file_path'],
        as_attachment=True,
        download_name=submission['file_path']
    )


# ============================================================
# TIMETABLE (their own weekly schedule — read-only; only Admin manages this table)
# ============================================================
@app.route('/api/faculty/timetable', methods=['GET'])
@faculty_required
def get_faculty_timetable():
    """Read-only: the college's full regular weekly timetable (all semesters/divisions/batches) —
    faculty can only view it; add/edit/delete is done by Admin only."""
    academic_year = request.args.get('academic_year')

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        query = """
            SELECT t.id, t.semester, t.division, t.academic_year, t.day_of_week, t.room_no, t.session_type,
                   TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(t.end_time, '%H:%i') AS end_time,
                   t.subject_id, sub.subject_name, sub.subject_code,
                   t.faculty_id, u.name AS faculty_name,
                   IF(t.faculty_id = %s, 1, 0) AS is_mine
            FROM timetable t
            LEFT JOIN subjects sub ON sub.id = t.subject_id
            LEFT JOIN faculty f ON f.id = t.faculty_id
            LEFT JOIN users u ON u.id = f.user_id
            WHERE 1=1
        """
        params = [faculty_id]
        if academic_year:
            query += " AND t.academic_year = %s"
            params.append(academic_year)
        query += """
            ORDER BY t.semester, t.division,
                     FIELD(t.day_of_week, 'Mon','Tue','Wed','Thu','Fri','Sat'), t.start_time
        """
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        return jsonify(rows), 200
    except Exception as e:
        return jsonify({"message": "Timetable could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/exam-timetable', methods=['GET'])
@faculty_required
def get_faculty_exam_timetable():
    """Read-only: Mid-Sem / Remedial exam timetable (all semesters/divisions/batches) —
    faculty can only view it; add/edit/delete is done by Admin only."""
    exam_type = request.args.get('exam_type')
    academic_year = request.args.get('academic_year')

    query = """
        SELECT e.id, e.exam_type, e.semester, e.division, e.academic_year, e.exam_date, e.room_no,
               TIME_FORMAT(e.start_time, '%H:%i') AS start_time,
               TIME_FORMAT(e.end_time, '%H:%i') AS end_time,
               e.subject_id, sub.subject_name, sub.subject_code,
               IF(e.subject_id IN (SELECT subject_id FROM faculty_subjects WHERE faculty_id = %s), 1, 0) AS is_mine
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
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404
        cursor.execute(query, tuple([faculty_id] + params))
        rows = cursor.fetchall()
    except Exception as e:
        cursor.close()
        conn.close()
        return jsonify({"message": "Exam timetable could not be loaded", "error": str(e)}), 500
    for r in rows:
        if r['exam_date']:
            r['exam_date'] = r['exam_date'].isoformat()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


# ============================================================
# NOTICES (faculty can read — Admin broadcasts + their own personal notices — and
# post notices to their own assigned class. Edit/Delete/Pin is allowed only on notices they posted
# themselves; class/subject cannot be changed on edit, only when posting a new one.)
# ============================================================
# ---- Notice chat groups (faculty panel) ----
#   staff : "Admin & Faculty"            -> target_role = 'faculty'            (faculty + admin can post; students never see it)
#   all   : "Students, Faculty & Admin"  -> admin broadcasts (target_role = 'all') + other faculty's class notices; READ ONLY for faculty
#   class : "My classes"                 -> notices this faculty sent to their own students
# The group is decided only here on the server (one place for list + mark-read), never taken from the client.
FACULTY_NOTICE_GROUPS = ('staff', 'all', 'class')
NOTICE_TITLE_MAX = 150
NOTICE_CONTENT_MAX = 5000
NOTICE_CATEGORIES = ('Academic', 'Event', 'Important')
NOTICE_FILE_MAX_BYTES = 10 * 1024 * 1024

_FAC_NOTICE_VISIBLE_SQL = """
    ((n.target_role IN ('all','faculty') AND n.target_user_id IS NULL)
     OR n.target_user_id = %s
     OR n.posted_by = %s
     OR (n.target_user_id IS NULL
         AND n.posted_by IN (SELECT id FROM users WHERE role = 'faculty')))
"""


def _fac_notice_group(notice, user_id):
    if notice['target_role'] == 'faculty':
        return 'staff'
    if notice['target_role'] == 'student' and notice['posted_by'] == user_id:
        return 'class'
    return 'all'


def _clean_notice_text(title, content, category):
    """Returns (title, content, category, error). Used by every faculty notice write."""
    title = (title or '').strip()
    content = (content or '').strip() or None
    category = (category or 'Academic').strip()
    if not title:
        return None, None, None, "Title is required"
    if len(title) > NOTICE_TITLE_MAX:
        return None, None, None, f"Title can be at most {NOTICE_TITLE_MAX} characters"
    if content and len(content) > NOTICE_CONTENT_MAX:
        return None, None, None, f"Message can be at most {NOTICE_CONTENT_MAX} characters"
    if category not in NOTICE_CATEGORIES:
        return None, None, None, "Invalid category"
    return title, content, category, None


@app.route('/api/faculty/notices', methods=['GET'])
@faculty_required
def get_faculty_notices():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        cursor.execute("""
            SELECT id, title, content, category, is_pinned, created_at, target_user_id, target_role,
                   semester, division, posted_by, file_name, file_size, file_type,
                   EXISTS(SELECT 1 FROM notice_reads r WHERE r.notice_id = notices.id AND r.user_id = %s) AS is_read,
                   (SELECT u.name FROM users u WHERE u.id = notices.posted_by) AS posted_by_name,
                   (SELECT u.role FROM users u WHERE u.id = notices.posted_by) AS posted_by_role,
                   (SELECT COUNT(*) FROM notice_reads nr
                    WHERE nr.notice_id = notices.id AND nr.user_id <> notices.posted_by) AS seen_count,
                   (SELECT MAX(nr.seen_at) FROM notice_reads nr
                    JOIN users u ON u.id = nr.user_id
                    WHERE nr.notice_id = notices.id AND u.role = 'admin') AS admin_seen_at
            FROM notices
            WHERE (target_role IN ('all','faculty') AND target_user_id IS NULL)
               OR target_user_id = %s
               OR posted_by = %s
               OR (target_user_id IS NULL
                   AND posted_by IN (SELECT id FROM users WHERE role = 'faculty'))   -- notices from other faculty are visible to all faculty
            ORDER BY is_pinned DESC, created_at DESC
            LIMIT 200
        """, (user_id, user_id, user_id))
        notices = cursor.fetchall()
        for n in notices:
            n['is_personal'] = n['target_user_id'] is not None
            n['can_manage'] = (n['posted_by'] == user_id)
            n['is_read'] = bool(n['is_read'])
            n['group'] = _fac_notice_group(n, user_id)
            del n['target_role']
            if n['can_manage']:
                n['admin_seen'] = n['admin_seen_at'] is not None
                n['admin_seen_at'] = n['admin_seen_at'].isoformat() if n['admin_seen_at'] else None
            else:
                del n['seen_count']   # the seen count is shown only to the faculty who posted the notice
                del n['admin_seen_at']
            del n['target_user_id']
            del n['posted_by']
        return jsonify({"notices": notices}), 200
    except Exception as e:
        return jsonify({"message": "Notices could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/notices/unread-count', methods=['GET'])
@faculty_required
def get_faculty_notices_unread_count():
    """To show/hide the dot on the sidebar 'Notices' item — how many notices are visible to this
    faculty (broadcast + personal + their own + posted by other faculty) but not seen yet."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        cursor.execute("""
            SELECT COUNT(*) AS unread_count
            FROM notices n
            WHERE (
                (n.target_role IN ('all','faculty') AND n.target_user_id IS NULL)
                OR n.target_user_id = %s
                OR n.posted_by = %s
                OR (n.target_user_id IS NULL
                    AND n.posted_by IN (SELECT id FROM users WHERE role = 'faculty'))
            )
            AND NOT EXISTS (
                SELECT 1 FROM notice_reads nr WHERE nr.notice_id = n.id AND nr.user_id = %s
            )
        """, (user_id, user_id, user_id))
        return jsonify({"unread_count": cursor.fetchone()['unread_count']}), 200
    except Exception as e:
        return jsonify({"message": "Unread count could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/notices/mark-read', methods=['POST'])
@faculty_required
def mark_faculty_notices_read():
    """Marks notices this faculty can see as 'seen'. With {"group": "staff|all|class"} only that chat
    group is marked (called when the group is opened); without it everything is marked."""
    data = request.get_json(silent=True) or {}
    group = data.get('group')
    if group is not None and group not in FACULTY_NOTICE_GROUPS:
        return jsonify({"message": "Invalid group"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        cursor.execute(
            "SELECT n.id, n.target_role, n.posted_by FROM notices n WHERE " + _FAC_NOTICE_VISIBLE_SQL,
            (user_id, user_id)
        )
        rows = cursor.fetchall()
        ids = [r['id'] for r in rows if group is None or _fac_notice_group(r, user_id) == group]
        if ids:
            cursor.executemany(
                "INSERT IGNORE INTO notice_reads (notice_id, user_id) VALUES (%s, %s)",
                [(i, user_id) for i in ids]
            )
        conn.commit()
        return jsonify({"message": "Marked as read"}), 200
    except Exception:
        conn.rollback()
        return jsonify({"message": "Failed to mark as read"}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/notices', methods=['POST'])
@faculty_required
def add_faculty_notice():
    """multipart/form-data: group ('class' = default, or 'staff'), title, content (optional), category (optional),
    file (optional, PDF/DOC/DOCX/PPT/PPTX/JPG/PNG, max 10MB).
      group = 'class' -> also needs assignment_id (faculty_subjects.id) and optional division; goes to that class's students.
      group = 'staff' -> "Admin & Faculty": stored with target_role = 'faculty' (fixed here, never from the client),
                         so students can never see it.
    Faculty cannot post in the 'all' (Students, Faculty & Admin) group — that is admin only."""
    group = (request.form.get('group') or 'class').strip()
    if group not in ('class', 'staff'):
        return jsonify({"message": "Faculty can post only to 'Admin & Faculty' or to their own class"}), 403

    assignment_id = request.form.get('assignment_id')
    chosen_division = request.form.get('division') or None
    file = request.files.get('file')

    title, content, category, text_error = _clean_notice_text(
        request.form.get('title'), request.form.get('content'), request.form.get('category'))
    if text_error:
        return jsonify({"message": text_error}), 400
    if group == 'class' and not assignment_id:
        return jsonify({"message": "Class and title are required"}), 400

    # validate the attachment before touching the DB
    if file and file.filename:
        if not _allowed_notice_file(file):
            return jsonify({"message": "Invalid file format. Only valid PDF, DOC, DOCX, PPT, PPTX, JPG, PNG files are allowed"}), 400
        file.seek(0, os.SEEK_END)
        too_big = file.tell() > NOTICE_FILE_MAX_BYTES
        file.seek(0)
        if too_big:
            return jsonify({"message": "File is larger than 10MB, upload a smaller file"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    if group == 'staff':
        target_role, semester, division, academic_year = 'faculty', None, None, None
    else:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            cursor.close()
            conn.close()
            return jsonify({"message": "Faculty record not found"}), 404

        assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
        if not assignment:
            cursor.close()
            conn.close()
            return jsonify({"message": "This subject is not assigned to you"}), 403

        division, division_error = _resolve_division(cursor, assignment, chosen_division)
        if division_error:
            cursor.close()
            conn.close()
            return jsonify({"message": division_error}), 400
        target_role, semester, academic_year = 'student', assignment['semester'], assignment['academic_year']

    file_path = file_name = file_size = file_type = None
    if file and file.filename:
        original_name = secure_filename(file.filename)
        file_ext = original_name.rsplit('.', 1)[1].lower()
        unique_name = f"{uuid.uuid4().hex}.{file_ext}"
        save_path = os.path.join(NOTICE_UPLOAD_FOLDER, unique_name)
        file.save(save_path)
        file_path = unique_name
        file_name = original_name
        file_size = os.path.getsize(save_path)
        file_type = file_ext

    try:
        cursor.execute("""
            INSERT INTO notices (title, content, category, target_role, semester, division, academic_year, posted_by, is_pinned, file_path, file_name, file_size, file_type)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,FALSE,%s,%s,%s,%s)
        """, (
            title, content, category, target_role,
            semester, division, academic_year,
            request.user['user_id'], file_path, file_name, file_size, file_type
        ))
        new_notice_id = cursor.lastrowid
        # Immediately mark it "seen" for whoever created the notice — their own post
        # should not show an unread dot
        cursor.execute(
            "INSERT IGNORE INTO notice_reads (notice_id, user_id) VALUES (%s, %s)",
            (new_notice_id, request.user['user_id'])
        )
        conn.commit()
    except Exception:
        conn.rollback()
        cursor.close()
        conn.close()
        if file_path and os.path.exists(os.path.join(NOTICE_UPLOAD_FOLDER, file_path)):
            os.remove(os.path.join(NOTICE_UPLOAD_FOLDER, file_path))
        return jsonify({"message": "Notice could not be saved"}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Notice published"}), 201


@app.route('/api/faculty/notices/<int:notice_id>', methods=['PUT'])
@faculty_required
def update_faculty_notice(notice_id):
    """Only title/content/category can be edited (not class/division/attachment) —
    and only when this faculty posted the notice themselves."""
    data = request.get_json(silent=True) or {}
    title, content, category, text_error = _clean_notice_text(
        data.get('title'), data.get('content'), data.get('category'))
    if text_error:
        return jsonify({"message": text_error}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT posted_by FROM notices WHERE id = %s", (notice_id,))
        notice = cursor.fetchone()
        if not notice:
            return jsonify({"message": "Notice not found"}), 404
        if notice['posted_by'] != request.user['user_id']:
            return jsonify({"message": "You can only edit a notice you posted yourself"}), 403

        cursor.execute("UPDATE notices SET title=%s, content=%s, category=%s WHERE id=%s",
                        (title, content, category, notice_id))
        conn.commit()
        return jsonify({"message": "Notice updated"}), 200
    except Exception:
        conn.rollback()
        return jsonify({"message": "Notice could not be updated"}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/notices/<int:notice_id>/reads', methods=['GET'])
@faculty_required
def get_faculty_notice_reads(notice_id):
    """Which students have seen a notice the faculty posted (name, enrollment, when seen) + the total
    students of that class. Only the faculty who posted the notice can see this."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        cursor.execute("SELECT * FROM notices WHERE id = %s AND posted_by = %s", (notice_id, user_id))
        notice = cursor.fetchone()
        # 404 (not 403) — because the frontend sends the user to the login page on a 403
        if not notice:
            return jsonify({"message": "Notice not found"}), 404

        cursor.execute("""
            SELECT u.id AS user_id, u.name, u.login_id, u.role, nr.seen_at
            FROM notice_reads nr
            JOIN users u ON u.id = nr.user_id
            WHERE nr.notice_id = %s AND nr.user_id <> %s
            ORDER BY nr.seen_at DESC
        """, (notice_id, user_id))
        seen_by = cursor.fetchall()
        for r in seen_by:
            if r['seen_at']:
                r['seen_at'] = r['seen_at'].isoformat()

        target_total = 0
        if notice['target_role'] != 'faculty':
            # class notice: the students of that class (a staff notice never goes to students)
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
            target_total = cursor.fetchone()['c']
        cursor.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")
        target_total += cursor.fetchone()['c']   # admin shows up in the seen list too
        cursor.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'faculty' AND id <> %s", (user_id,))
        target_total += cursor.fetchone()['c']   # other faculty too (notices posted by other faculty are visible to all faculty)

        return jsonify({
            "notice_id": notice_id,
            "seen_count": len(seen_by),
            "target_total": target_total,
            "seen_by": seen_by
        }), 200
    except Exception as e:
        return jsonify({"message": "Seen list could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/notices/<int:notice_id>/pin', methods=['PATCH'])
@faculty_required
def toggle_faculty_notice_pin(notice_id):
    """You can only pin/unpin a notice you posted yourself."""
    data = request.get_json() or {}
    is_pinned = bool(data.get('is_pinned'))

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT posted_by FROM notices WHERE id = %s", (notice_id,))
        notice = cursor.fetchone()
        if not notice:
            return jsonify({"message": "Notice not found"}), 404
        if notice['posted_by'] != request.user['user_id']:
            return jsonify({"message": "You can only pin a notice you posted yourself"}), 403

        cursor.execute("UPDATE notices SET is_pinned=%s WHERE id=%s", (is_pinned, notice_id))
        conn.commit()
        return jsonify({"message": f"Notice {'pinned' if is_pinned else 'unpinned'}"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Pin status could not be updated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/notices/<int:notice_id>', methods=['DELETE'])
@faculty_required
def delete_faculty_notice(notice_id):
    """You can only delete a notice you posted yourself — its attachment is removed along with it."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT posted_by, file_path FROM notices WHERE id = %s", (notice_id,))
        notice = cursor.fetchone()
        if not notice:
            return jsonify({"message": "Notice not found"}), 404
        if notice['posted_by'] != request.user['user_id']:
            return jsonify({"message": "You can only delete a notice you posted yourself"}), 403

        cursor.execute("DELETE FROM notices WHERE id=%s", (notice_id,))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Notice could not be deleted", "error": str(e)}), 500

    cursor.close()
    conn.close()

    if notice['file_path']:
        p = os.path.join(NOTICE_UPLOAD_FOLDER, notice['file_path'])
        if os.path.exists(p):
            os.remove(p)

    return jsonify({"message": "Notice deleted"}), 200


@app.route('/api/faculty/notices/<int:notice_id>/download', methods=['GET'])
@faculty_required
def download_faculty_notice(notice_id):
    """Downloads the attachment of any notice visible to this faculty
    (Admin broadcast, personal, or posted by themselves)."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        cursor.execute("""
            SELECT file_path, file_name
            FROM notices
            WHERE id = %s
              AND (
                  (target_role IN ('all','faculty') AND target_user_id IS NULL)
                  OR target_user_id = %s
                  OR posted_by = %s
                  OR (target_user_id IS NULL
                      AND posted_by IN (SELECT id FROM users WHERE role = 'faculty'))
              )
        """, (notice_id, user_id, user_id))
        notice = cursor.fetchone()
    finally:
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

# ============================================================
# Faculty Settings — profile (full name) + change password
# ============================================================
@app.route('/api/faculty/profile', methods=['GET'])
@faculty_required
def get_faculty_profile():
    user_id = request.user['user_id']
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        """SELECT u.name, u.login_id AS faculty_id, f.department, f.email, f.short_name, f.whatsapp_number
           FROM users u JOIN faculty f ON f.user_id = u.id
           WHERE u.id = %s""",
        (user_id,)
    )
    profile = cursor.fetchone()
    cursor.close()
    conn.close()
    if not profile:
        return jsonify({"message": "Profile not found"}), 404
    return jsonify(profile), 200


@app.route('/api/faculty/profile', methods=['PUT'])
@faculty_required
def update_faculty_profile():
    """Faculty can edit their own full name + short name + WhatsApp number — Faculty ID and Department stay under Admin's control."""
    data = request.get_json()
    name = data.get('name')
    short_name = data.get('short_name')
    whatsapp_number = data.get('whatsapp_number')
    if not name or not name.strip():
        return jsonify({"message": "Name cannot be empty"}), 400
    if whatsapp_number and (not whatsapp_number.isdigit() or not (10 <= len(whatsapp_number) <= 15)):
        return jsonify({"message": "WhatsApp number must be 10-15 digits (with country code if needed)"}), 400

    user_id = request.user['user_id']
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET name = %s WHERE id = %s", (name.strip(), user_id))
    cursor.execute(
        "UPDATE faculty SET short_name = %s, whatsapp_number = %s WHERE user_id = %s",
        (short_name.strip() if short_name else None, whatsapp_number.strip() if whatsapp_number else None, user_id)
    )
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"message": "Profile updated"}), 200


@app.route('/api/faculty/change-password', methods=['PUT'])
@faculty_required
def faculty_change_password():
    data = request.get_json()
    current_password = data.get('current_password')
    new_password = data.get('new_password')

    if not current_password or not new_password:
        return jsonify({"message": "Current and new password are both required"}), 400
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


# ============================================================
# ASK STUDENTHUB — a lightweight data-driven assistant (no external AI).
# The dashboard card and the floating chat popup both call this endpoint.
# It recognises the question by keyword and answers directly from the DB with real data —
# supported: "low attendance list", "pending submissions", "attendance %", "class list".
# ============================================================
@app.route('/api/faculty/assistant', methods=['POST'])
@faculty_required
@logged_assistant
def faculty_assistant():
    data = request.get_json() or {}
    message = (data.get('message') or '').strip().lower()
    if not message:
        return jsonify({"reply": "Go ahead, ask me something! 🙂"}), 200

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        # ---- 1) FAQ table first ----
        faq_reply = find_faq_answer(cursor, message)
        if faq_reply:
            return jsonify({"reply": faq_reply}), 200

        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"reply": "Faculty record not found."}), 200

        cursor.execute("""
            SELECT fs.id AS assignment_id, s.id AS subject_id, s.subject_name,
                   fs.semester, fs.division, fs.academic_year
            FROM faculty_subjects fs
            JOIN subjects s ON s.id = fs.subject_id
            WHERE fs.faculty_id = %s
            ORDER BY fs.academic_year DESC, fs.semester
        """, (faculty_id,))
        subjects = cursor.fetchall()
        if not subjects:
            return jsonify({"reply": "You don't have any subject assigned yet."}), 200

        # ---- Low attendance list ----
        if 'low attendance' in message or ('attendance' in message and ('kam' in message or 'low' in message)):
            lines = []
            for sub in subjects:
                div_clause = "AND st.division = %s" if sub['division'] else ""
                params = [sub['subject_id'], sub['semester'], sub['academic_year']]
                if sub['division']:
                    params.append(sub['division'])
                cursor.execute(f"""
                    SELECT u.name, u.login_id AS enrollment,
                           ROUND(AVG(CASE WHEN a.status='present' THEN 100 ELSE 0 END)) AS pct
                    FROM students st
                    JOIN users u ON u.id = st.user_id
                    JOIN attendance a ON a.student_id = st.id AND a.subject_id = %s
                    WHERE st.semester = %s AND st.academic_year = %s {div_clause}
                    GROUP BY st.id, u.name, u.login_id
                    HAVING pct < 75
                    ORDER BY pct ASC
                """, tuple(params))
                for r in cursor.fetchall():
                    lines.append(f"• {r['name']} ({r['enrollment']}) — {sub['subject_name']}: {r['pct']}%")
            reply = ("Students with low attendance (<75%):\n" + "\n".join(lines[:15])) if lines \
                else "All students have attendance 75% or above 👍"
            return jsonify({"reply": reply}), 200

        # ---- Pending submissions ----
        if 'pending submission' in message or 'submission' in message or 'not submitted' in message or 'jama nahi' in message:
            cursor.execute("""
                SELECT a.id, a.title, a.subject_id, a.semester, a.division, s.subject_name
                FROM assignments a JOIN subjects s ON s.id = a.subject_id
                WHERE a.faculty_id = %s
                ORDER BY a.due_date DESC
                LIMIT 5
            """, (faculty_id,))
            lines = []
            for a in cursor.fetchall():
                div_clause = "AND st.division = %s" if a['division'] else ""
                params = [a['id'], a['semester']]
                if a['division']:
                    params.append(a['division'])
                cursor.execute(f"""
                    SELECT u.name, u.login_id AS enrollment
                    FROM students st
                    JOIN users u ON u.id = st.user_id
                    LEFT JOIN assignment_submissions asub
                        ON asub.student_id = st.id AND asub.assignment_id = %s
                    WHERE st.semester = %s {div_clause} AND asub.id IS NULL
                    ORDER BY u.login_id
                """, tuple(params))
                missing = cursor.fetchall()
                if missing:
                    names = ", ".join(f"{m['name']} ({m['enrollment']})" for m in missing[:10])
                    more = " ..." if len(missing) > 10 else ""
                    lines.append(f"• {a['title']} ({a['subject_name']}): {names}{more}")
            reply = ("Pending submissions:\n" + "\n".join(lines)) if lines \
                else "No assignment is pending — everyone has submitted 👍"
            return jsonify({"reply": reply}), 200

        # ---- Attendance % summary ----
        if 'attendance' in message:
            lines = []
            for sub in subjects:
                cursor.execute("""
                    SELECT ROUND(AVG(CASE WHEN status='present' THEN 100 ELSE 0 END)) AS pct
                    FROM attendance WHERE subject_id = %s
                """, (sub['subject_id'],))
                r = cursor.fetchone()
                pct = r['pct'] if r and r['pct'] is not None else 0
                lines.append(f"• {sub['subject_name']} (Sem {sub['semester']}, Div {sub['division'] or 'All'}): {pct}%")
            return jsonify({"reply": "Average attendance:\n" + "\n".join(lines)}), 200

        # ---- Class list / student count ----
        if 'class list' in message or 'student list' in message or 'list of student' in message:
            lines = []
            for sub in subjects:
                div_clause = "AND division = %s" if sub['division'] else ""
                params = [sub['semester'], sub['academic_year']]
                if sub['division']:
                    params.append(sub['division'])
                cursor.execute(f"SELECT COUNT(*) AS c FROM students WHERE semester=%s AND academic_year=%s {div_clause}", tuple(params))
                c = cursor.fetchone()['c']
                lines.append(f"• {sub['subject_name']} (Sem {sub['semester']}, Div {sub['division'] or 'All'}): {c} students")
            return jsonify({"reply": "\n".join(lines)}), 200

        help_text = ("I can currently answer these kinds of questions: \"low attendance list\", "
                     "\"pending submissions\", \"attendance %\", or \"class list\".")
        reply = get_fallback_reply(cursor, message, request.user['user_id'], 'faculty', help_text)
        return jsonify({"reply": reply}), 200
    except Exception as e:
        return jsonify({"reply": "Something went wrong, please try again."}), 200
    finally:
        cursor.close()
        conn.close()



@app.route('/api/faculty/chat-history', methods=['GET'])
@faculty_required
def faculty_chat_history():
    """This user's own previous chat with the assistant (last 50 exchanges)."""
    return jsonify(get_user_chat_history(request.user['user_id'])), 200


# ============================================================
# REPORTS — Attendance Report (Excel / PDF)
# The faculty can only pick a subject that is assigned to them (semester + batch + division are checked
# against faculty_subjects), and can filter the students by attendance % before downloading.
# ============================================================
_ATT_LOW_LIMIT = 75     # GTU eligibility: below this % is shown in red


def _subject_division_scope(cursor, faculty_id, subject_id, semester, academic_year, division):
    """Same idea as _class_division_scope, but for ONE subject: the faculty can only download the report of a
    subject+semester+batch assigned to them, and only for their assigned divisions.
    Returns (allowed, sql_clause, params)."""
    cursor.execute("""
        SELECT division FROM faculty_subjects
        WHERE faculty_id = %s AND subject_id = %s AND semester = %s AND academic_year = %s
    """, (faculty_id, subject_id, semester, academic_year))
    rows = cursor.fetchall()
    if not rows:
        return False, "", ()
    assigned = {r['division'] for r in rows if r['division']}
    all_divisions = any(not r['division'] for r in rows)   # an "All divisions" assignment (NULL / empty)
    if all_divisions:
        if division:
            return True, "AND st.division = %s", (division,)
        return True, "", ()
    if division:
        if division not in assigned:
            return False, "", ()
        return True, "AND st.division = %s", (division,)
    ordered = tuple(sorted(assigned))
    placeholders = ",".join(["%s"] * len(ordered))
    return True, f"AND st.division IN ({placeholders})", ordered


def _att_filter_label(min_pct, max_pct, max_exclusive):
    def num(v):
        return f"{v:g}"
    if min_pct is None and max_pct is None:
        return "All students"
    if min_pct is not None and max_pct is not None:
        return f"{num(min_pct)}% to {num(max_pct)}%"
    if min_pct is not None:
        return f"{num(min_pct)}% and above"
    return f"Below {num(max_pct)}%" if max_exclusive else f"Up to {num(max_pct)}%"


def _build_attendance_xlsx(meta, rows):
    """meta: dict of title info. rows: list of dicts (enrollment, name, division, present, total, pct)."""
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Attendance"

    ws.append(["Attendance Report"])
    ws['A1'].font = Font(bold=True, size=14)
    ws.append(["Subject", meta['subject']])
    ws.append(["Semester", meta['semester']])
    ws.append(["Batch", meta['batch']])
    ws.append(["Division", meta['division']])
    ws.append(["Attendance filter", meta['filter']])
    ws.append(["Students", len(rows)])
    ws.append(["Generated on", meta['generated']])
    for r in range(2, 9):
        ws.cell(row=r, column=1).font = Font(bold=True)
    ws.append([])

    headers = ["Sr No.", "Enrollment", "Name", "Division", "Present", "Total Sessions", "Attendance %"]
    ws.append(headers)
    header_row = ws.max_row
    for cell in ws[header_row]:
        cell.font = Font(bold=True)

    for i, r in enumerate(rows, start=1):
        pct = r['pct'] if r['pct'] is not None else 'N/A'
        ws.append([i, r['enrollment'], r['name'], r['division'] or '', r['present'], r['total'], pct])
        if r['pct'] is not None and r['pct'] < _ATT_LOW_LIMIT:
            ws.cell(row=ws.max_row, column=7).font = Font(color="C00000", bold=True)

    widths = [8, 16, 30, 10, 10, 15, 14]
    for idx, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = w
    ws.column_dimensions['B'].width = 24   # also holds the title-block values (subject name etc.)

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


def _build_attendance_pdf(meta, rows):
    """Needs the 'reportlab' package. Raises ImportError if it is not installed."""
    from xml.sax.saxutils import escape
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm, title="Attendance Report")
    styles = getSampleStyleSheet()
    story = [Paragraph("Attendance Report", styles['Title'])]
    info = (
        f"<b>Subject:</b> {escape(meta['subject'])}<br/>"
        f"<b>Semester:</b> {escape(str(meta['semester']))} &nbsp;&nbsp; "
        f"<b>Batch:</b> {escape(str(meta['batch']))} &nbsp;&nbsp; "
        f"<b>Division:</b> {escape(str(meta['division']))}<br/>"
        f"<b>Attendance filter:</b> {escape(meta['filter'])} &nbsp;&nbsp; "
        f"<b>Students:</b> {len(rows)}<br/>"
        f"<b>Generated on:</b> {escape(meta['generated'])}"
    )
    story.append(Paragraph(info, styles['Normal']))
    story.append(Spacer(1, 8 * mm))

    data = [["Sr", "Enrollment", "Name", "Div", "Present", "Total", "Attendance %"]]
    low_rows = []
    for i, r in enumerate(rows, start=1):
        pct = f"{r['pct']:.1f}%" if r['pct'] is not None else "N/A"
        data.append([str(i), r['enrollment'], r['name'], r['division'] or '', str(r['present']), str(r['total']), pct])
        if r['pct'] is not None and r['pct'] < _ATT_LOW_LIMIT:
            low_rows.append(i)

    if len(data) == 1:
        story.append(Paragraph("No students match the selected filters.", styles['Normal']))
    else:
        table = Table(data, repeatRows=1,
                      colWidths=[10 * mm, 32 * mm, 62 * mm, 12 * mm, 18 * mm, 16 * mm, 30 * mm])
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
        for i in low_rows:
            style.append(('TEXTCOLOR', (6, i), (6, i), colors.HexColor('#c00000')))
            style.append(('FONTNAME', (6, i), (6, i), 'Helvetica-Bold'))
        table.setStyle(TableStyle(style))
        story.append(table)

    doc.build(story)
    buffer.seek(0)
    return buffer


@app.route('/api/faculty/reports/attendance', methods=['GET'])
@faculty_required
def faculty_attendance_report():
    """Query params: subject_id, semester, academic_year (all required), division (optional),
    format ('xlsx' default | 'pdf'), min_percent / max_percent (optional, inclusive),
    max_exclusive=1 (optional: max_percent is then 'below', not 'up to')."""
    subject_id = request.args.get('subject_id', type=int)
    semester = request.args.get('semester', type=int)
    academic_year = (request.args.get('academic_year') or '').strip()
    division = (request.args.get('division') or '').strip()
    fmt = (request.args.get('format') or 'xlsx').strip().lower()
    min_pct = request.args.get('min_percent', type=float)
    max_pct = request.args.get('max_percent', type=float)
    max_exclusive = request.args.get('max_exclusive') in ('1', 'true')

    if not subject_id or not semester or not academic_year:
        return jsonify({"message": "Batch, semester and subject are required"}), 400
    if fmt not in ('xlsx', 'pdf'):
        return jsonify({"message": "format must be xlsx or pdf"}), 400
    for v in (min_pct, max_pct):
        if v is not None and not (0 <= v <= 100):
            return jsonify({"message": "Percentage must be between 0 and 100"}), 400
    if min_pct is not None and max_pct is not None and min_pct > max_pct:
        return jsonify({"message": "'From %' cannot be greater than 'To %'"}), 400

    if fmt == 'pdf':
        try:
            import reportlab   # noqa: F401  (only checking that it is installed)
        except ImportError:
            return jsonify({"message": "PDF export needs the 'reportlab' package on the server. Run: pip install reportlab"}), 500

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        allowed, div_clause, div_params = _subject_division_scope(
            cursor, faculty_id, subject_id, semester, academic_year, division)
        if not allowed:
            return jsonify({"message": "This subject / division is not assigned to you for the selected semester and batch"}), 403

        cursor.execute("SELECT subject_code, subject_name FROM subjects WHERE id = %s", (subject_id,))
        subject = cursor.fetchone()
        if not subject:
            return jsonify({"message": "Subject not found"}), 404

        cursor.execute(f"""
            SELECT st.id AS student_id, u.login_id AS enrollment, u.name, st.division,
                   COALESCE(SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END), 0) AS present_count,
                   COUNT(a.id) AS total_count
            FROM students st
            JOIN users u ON u.id = st.user_id
            LEFT JOIN attendance a ON a.student_id = st.id AND a.subject_id = %s
            WHERE st.semester = %s AND st.academic_year = %s {div_clause}
            GROUP BY st.id, u.login_id, u.name, st.division
            ORDER BY u.login_id
        """, (subject_id, semester, academic_year) + tuple(div_params))
        students = cursor.fetchall()
    except Exception as e:
        return jsonify({"message": "Report could not be generated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

    rows = []
    for s in students:
        present = int(s['present_count'])
        total = int(s['total_count'])
        pct = round(present * 100 / total, 1) if total else None
        # A percentage filter can only judge students who have attendance records
        if min_pct is not None or max_pct is not None:
            if pct is None:
                continue
            if min_pct is not None and pct < min_pct:
                continue
            if max_pct is not None and ((max_exclusive and pct >= max_pct) or (not max_exclusive and pct > max_pct)):
                continue
        rows.append({"enrollment": s['enrollment'], "name": s['name'], "division": s['division'],
                     "present": present, "total": total, "pct": pct})

    meta = {
        "subject": f"{subject['subject_name']} ({subject['subject_code']})" if subject['subject_code'] else subject['subject_name'],
        "semester": semester,
        "batch": academic_year,
        "division": division or "All",
        "filter": _att_filter_label(min_pct, max_pct, max_exclusive),
        "generated": datetime.now().strftime('%d-%m-%Y %H:%M'),
    }
    base = secure_filename(f"attendance_{subject['subject_name']}_sem{semester}_{academic_year}" + (f"_div{division}" if division else "")) or "attendance_report"

    if fmt == 'pdf':
        buffer = _build_attendance_pdf(meta, rows)
        return send_file(buffer, as_attachment=True, download_name=base + ".pdf", mimetype='application/pdf')
    buffer = _build_attendance_xlsx(meta, rows)
    return send_file(buffer, as_attachment=True, download_name=base + ".xlsx",
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

# ============================================================
# REPORTS — Assignment Report (Excel / PDF)
# Two forms: "summary" (default) = one row per student with totals, "detail" = one specific assignment,
# every student with Submitted Yes/No, date, On-time/Late and marks.
# Scope is the same as the Attendance Report: only the faculty's own subject+semester+batch(+divisions).
# "Late" = submission date is after the assignment's due date (same rule as the Assignments screen).
# There is no "total marks" column in `assignments`, so marks are shown as plain numbers.
# ============================================================
_ASG_RED = "C00000"
_ASG_RED_FILL = "FDECEA"


def _asg_pct(submitted, total):
    return round(submitted * 100 / total, 1) if total else None


def _asg_fmt_marks(v):
    if v is None:
        return "-"
    f = float(v)
    return str(int(f)) if f == int(f) else f"{f:.1f}"


def _asg_fmt_date(d):
    return d.strftime('%d-%m-%Y') if d else "-"


def _asg_summary_line(rows, mode):
    """Numbers for the line above the table. Submission-level counts (student x assignment pairs).
    Average marks = average over the submissions that have marks."""
    if mode == 'detail':
        submitted = sum(1 for r in rows if r['submitted'])
        pending = len(rows) - submitted
        late = sum(1 for r in rows if r['late'])
        marks = [r['marks'] for r in rows if r['marks'] is not None]
    else:
        submitted = sum(r['submitted'] for r in rows)
        pending = sum(r['pending'] for r in rows)
        late = sum(r['late'] for r in rows)
        marks = None
    if mode == 'detail':
        avg = (sum(marks) / len(marks)) if marks else None
    else:
        graded = sum(r['graded'] for r in rows)
        avg = (sum(r['marks_sum'] for r in rows if r['marks_sum'] is not None) / graded) if graded else None
    return {"students": len(rows), "submitted": submitted, "pending": pending, "late": late,
            "avg": _asg_fmt_marks(round(avg, 1)) if avg is not None else "-"}


def _asg_headers_and_cells(mode):
    if mode == 'detail':
        return ["Sr No.", "Enrollment", "Name", "Division", "Submitted", "Submission Date", "Status", "Marks"]
    return ["Sr No.", "Enrollment", "Name", "Division", "Total Assignments", "Submitted", "Pending", "Late",
            "Submission %", "Total Marks"]


def _asg_row_values(mode, i, r):
    if mode == 'detail':
        status = "Not submitted" if not r['submitted'] else ("Late" if r['late'] else "On time")
        return [i, r['enrollment'], r['name'], r['division'] or '', "Yes" if r['submitted'] else "No",
                _asg_fmt_date(r['submitted_at']), status, _asg_fmt_marks(r['marks'])]
    pct = f"{r['pct']:.1f}%" if r['pct'] is not None else "N/A"
    return [i, r['enrollment'], r['name'], r['division'] or '', r['total'], r['submitted'], r['pending'],
            r['late'], pct, _asg_fmt_marks(r['marks_sum'])]


def _asg_is_red(mode, r):
    """Detail: the whole row is red when the student is Late or Not submitted.
    Summary: only the Pending / Late numbers that are above zero are red (otherwise nearly every row would be red)."""
    if mode == 'detail':
        return (not r['submitted']) or r['late']
    return False


def _build_assignment_xlsx(meta, rows, mode, line):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "Assignments"

    ws.append(["Assignment Report" + (" - Assignment-wise Detail" if mode == 'detail' else " - Student-wise Summary")])
    ws['A1'].font = Font(bold=True, size=14)
    info = [
        ("Subject", meta['subject']),
        ("Semester", meta['semester']),
        ("Batch", meta['batch']),
        ("Division", meta['division']),
        ("Assignment", meta['assignment']),
        ("Status filter", meta['status']),
        ("Generated on", meta['generated']),
    ]
    for k, v in info:
        ws.append([k, v])
    for r in range(2, 2 + len(info)):
        ws.cell(row=r, column=1).font = Font(bold=True)
    ws.append([])
    ws.append(["Summary",
               f"Total students: {line['students']}", f"Submitted: {line['submitted']}",
               f"Pending: {line['pending']}", f"Late: {line['late']}", f"Average marks: {line['avg']}"])
    for c in ws[ws.max_row]:
        c.font = Font(bold=True)
    ws.append([])

    headers = _asg_headers_and_cells(mode)
    ws.append(headers)
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)

    red_font = Font(color=_ASG_RED, bold=True)
    red_fill = PatternFill("solid", start_color=_ASG_RED_FILL, end_color=_ASG_RED_FILL)
    for i, r in enumerate(rows, start=1):
        vals = _asg_row_values(mode, i, r)
        if vals[-1] != "-":
            vals[-1] = float(vals[-1]) if "." in str(vals[-1]) else int(vals[-1])   # marks as a real number in Excel
        ws.append(vals)
        row_no = ws.max_row
        if _asg_is_red(mode, r):
            for c in ws[row_no]:
                c.font = red_font
                c.fill = red_fill
        elif mode == 'summary':
            if r['pending'] > 0:
                ws.cell(row=row_no, column=7).font = red_font
            if r['late'] > 0:
                ws.cell(row=row_no, column=8).font = red_font

    widths = [8, 24, 30, 10, 16, 16, 14, 14, 14, 14] if mode == 'summary' else [8, 24, 30, 10, 12, 18, 16, 10]
    for idx, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = w

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


def _build_assignment_pdf(meta, rows, mode, line):
    """Needs the 'reportlab' package. Raises ImportError if it is not installed."""
    from xml.sax.saxutils import escape
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    title = "Assignment Report - " + ("Assignment-wise Detail" if mode == 'detail' else "Student-wise Summary")
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=landscape(A4), leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm, title="Assignment Report")
    styles = getSampleStyleSheet()
    story = [Paragraph(title, styles['Title'])]
    info = (
        f"<b>Subject:</b> {escape(meta['subject'])}<br/>"
        f"<b>Semester:</b> {escape(str(meta['semester']))} &nbsp;&nbsp; "
        f"<b>Batch:</b> {escape(str(meta['batch']))} &nbsp;&nbsp; "
        f"<b>Division:</b> {escape(str(meta['division']))}<br/>"
        f"<b>Assignment:</b> {escape(meta['assignment'])} &nbsp;&nbsp; "
        f"<b>Status filter:</b> {escape(meta['status'])}<br/>"
        f"<b>Generated on:</b> {escape(meta['generated'])}<br/><br/>"
        f"<b>Total students:</b> {line['students']} &nbsp;&nbsp; <b>Submitted:</b> {line['submitted']} &nbsp;&nbsp; "
        f"<b>Pending:</b> {line['pending']} &nbsp;&nbsp; <b>Late:</b> {line['late']} &nbsp;&nbsp; "
        f"<b>Average marks:</b> {escape(str(line['avg']))}"
    )
    story.append(Paragraph(info, styles['Normal']))
    story.append(Spacer(1, 6 * mm))

    if mode == 'detail':
        header = ["Sr", "Enrollment", "Name", "Div", "Submitted", "Date", "Status", "Marks"]
        col_w = [10, 34, 70, 14, 24, 30, 30, 22]
    else:
        header = ["Sr", "Enrollment", "Name", "Div", "Total", "Submitted", "Pending", "Late", "Submission %", "Marks"]
        col_w = [10, 32, 66, 12, 16, 22, 20, 16, 28, 22]
    data = [header]
    red_rows, red_cells = [], []
    for i, r in enumerate(rows, start=1):
        data.append([str(x) for x in _asg_row_values(mode, i, r)])
        if _asg_is_red(mode, r):
            red_rows.append(i)
        elif mode == 'summary':
            if r['pending'] > 0:
                red_cells.append((6, i))
            if r['late'] > 0:
                red_cells.append((7, i))

    if len(data) == 1:
        story.append(Paragraph("No students match the selected filters.", styles['Normal']))
    else:
        table = Table(data, repeatRows=1, colWidths=[w * mm for w in col_w])
        red = colors.HexColor('#' + _ASG_RED)
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
        for i in red_rows:
            style.append(('BACKGROUND', (0, i), (-1, i), colors.HexColor('#' + _ASG_RED_FILL)))
            style.append(('TEXTCOLOR', (0, i), (-1, i), red))
            style.append(('FONTNAME', (0, i), (-1, i), 'Helvetica-Bold'))
        for col, i in red_cells:
            style.append(('TEXTCOLOR', (col, i), (col, i), red))
            style.append(('FONTNAME', (col, i), (col, i), 'Helvetica-Bold'))
        table.setStyle(TableStyle(style))
        story.append(table)

    doc.build(story)
    buffer.seek(0)
    return buffer


_ASG_STATUS_LABELS = {
    'all': 'All',
    'submitted': 'Submitted (on time + late)',
    'pending': 'Not submitted',
    'late': 'Late',
}


@app.route('/api/faculty/reports/assignments', methods=['GET'])
@faculty_required
def faculty_assignment_report():
    """Query params: subject_id, semester, academic_year (required), division (optional),
    assignment_id (optional; empty = all assignments of the subject), report ('summary' default | 'detail' —
    detail needs one assignment_id), status ('all' default | 'submitted' | 'pending' | 'late'),
    format ('xlsx' default | 'pdf').

    Status in the detail form filters the student rows directly. In the summary form it picks students:
    submitted = has submitted every assignment, pending = at least one not submitted, late = at least one late."""
    subject_id = request.args.get('subject_id', type=int)
    semester = request.args.get('semester', type=int)
    academic_year = (request.args.get('academic_year') or '').strip()
    division = (request.args.get('division') or '').strip()
    assignment_id = request.args.get('assignment_id', type=int)
    mode = (request.args.get('report') or 'summary').strip().lower()
    status = (request.args.get('status') or 'all').strip().lower()
    fmt = (request.args.get('format') or 'xlsx').strip().lower()

    if not subject_id or not semester or not academic_year:
        return jsonify({"message": "Batch, semester and subject are required"}), 400
    if fmt not in ('xlsx', 'pdf'):
        return jsonify({"message": "format must be xlsx or pdf"}), 400
    if mode not in ('summary', 'detail'):
        return jsonify({"message": "report must be summary or detail"}), 400
    if status not in _ASG_STATUS_LABELS:
        return jsonify({"message": "status must be all, submitted, pending or late"}), 400
    if mode == 'detail' and not assignment_id:
        return jsonify({"message": "Select one assignment for the assignment-wise detail report"}), 400

    if fmt == 'pdf':
        try:
            import reportlab   # noqa: F401  (only checking that it is installed)
        except ImportError:
            return jsonify({"message": "PDF export needs the 'reportlab' package on the server. Run: pip install reportlab"}), 500

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        allowed, div_clause, div_params = _subject_division_scope(
            cursor, faculty_id, subject_id, semester, academic_year, division)
        if not allowed:
            return jsonify({"message": "This subject / division is not assigned to you for the selected semester and batch"}), 403

        cursor.execute("SELECT subject_code, subject_name FROM subjects WHERE id = %s", (subject_id,))
        subject = cursor.fetchone()
        if not subject:
            return jsonify({"message": "Subject not found"}), 404

        assignment = None
        if assignment_id:
            cursor.execute("""
                SELECT id, title, division, due_date FROM assignments
                WHERE id = %s AND subject_id = %s AND semester = %s AND academic_year = %s
            """, (assignment_id, subject_id, semester, academic_year))
            assignment = cursor.fetchone()
            if not assignment:
                return jsonify({"message": "Assignment not found for the selected subject, semester and batch"}), 404

        # One submission row per (assignment, student) — duplicates, if any, are collapsed so nothing is counted twice
        subs = """(SELECT assignment_id, student_id, MIN(submitted_at) AS submitted_at, MAX(marks_obtained) AS marks_obtained
                   FROM assignment_submissions GROUP BY assignment_id, student_id)"""

        if mode == 'detail':
            extra = ""
            extra_params = ()
            if assignment['division']:
                extra = "AND st.division = %s"
                extra_params = (assignment['division'],)
            cursor.execute(f"""
                SELECT u.login_id AS enrollment, u.name, st.division,
                       asub.submitted_at, asub.marks_obtained
                FROM students st
                JOIN users u ON u.id = st.user_id
                LEFT JOIN {subs} asub ON asub.student_id = st.id AND asub.assignment_id = %s
                WHERE st.semester = %s AND st.academic_year = %s {div_clause} {extra}
                ORDER BY u.login_id
            """, (assignment_id, semester, academic_year) + tuple(div_params) + extra_params)
            students = cursor.fetchall()
        else:
            asg_filter = "AND a.id = %s" if assignment_id else ""
            asg_params = (assignment_id,) if assignment_id else ()
            cursor.execute(f"""
                SELECT u.login_id AS enrollment, u.name, st.division,
                       COUNT(a.id) AS total_count,
                       COUNT(asub.assignment_id) AS submitted_count,
                       COALESCE(SUM(CASE WHEN asub.assignment_id IS NOT NULL AND a.due_date IS NOT NULL
                                              AND DATE(asub.submitted_at) > a.due_date THEN 1 ELSE 0 END), 0) AS late_count,
                       COUNT(asub.marks_obtained) AS graded_count,
                       SUM(asub.marks_obtained) AS marks_sum
                FROM students st
                JOIN users u ON u.id = st.user_id
                LEFT JOIN assignments a
                       ON a.subject_id = %s AND a.semester = st.semester AND a.academic_year = st.academic_year
                      AND (a.division IS NULL OR a.division = st.division) {asg_filter}
                LEFT JOIN {subs} asub ON asub.assignment_id = a.id AND asub.student_id = st.id
                WHERE st.semester = %s AND st.academic_year = %s {div_clause}
                GROUP BY st.id, u.login_id, u.name, st.division
                ORDER BY u.login_id
            """, (subject_id,) + asg_params + (semester, academic_year) + tuple(div_params))
            students = cursor.fetchall()
    except Exception as e:
        return jsonify({"message": "Report could not be generated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

    rows = []
    if mode == 'detail':
        due = assignment['due_date']
        for s in students:
            sub_at = s['submitted_at']
            submitted = sub_at is not None
            late = bool(submitted and due and sub_at.date() > due)
            if status == 'submitted' and not submitted:
                continue
            if status == 'pending' and submitted:
                continue
            if status == 'late' and not late:
                continue
            marks = float(s['marks_obtained']) if s['marks_obtained'] is not None else None
            rows.append({"enrollment": s['enrollment'], "name": s['name'], "division": s['division'],
                         "submitted": submitted, "submitted_at": sub_at, "late": late, "marks": marks})
    else:
        for s in students:
            total = int(s['total_count'])
            submitted = int(s['submitted_count'])
            pending = total - submitted
            late = int(s['late_count'])
            if status == 'submitted' and not (total > 0 and pending == 0):
                continue
            if status == 'pending' and pending == 0:
                continue
            if status == 'late' and late == 0:
                continue
            rows.append({"enrollment": s['enrollment'], "name": s['name'], "division": s['division'],
                         "total": total, "submitted": submitted, "pending": pending, "late": late,
                         "pct": _asg_pct(submitted, total), "graded": int(s['graded_count']),
                         "marks_sum": float(s['marks_sum']) if s['marks_sum'] is not None else None})

    line = _asg_summary_line(rows, mode)
    meta = {
        "subject": f"{subject['subject_name']} ({subject['subject_code']})" if subject['subject_code'] else subject['subject_name'],
        "semester": semester,
        "batch": academic_year,
        "division": division or "All",
        "assignment": assignment['title'] if assignment else "All assignments",
        "status": _ASG_STATUS_LABELS[status],
        "generated": datetime.now().strftime('%d-%m-%Y %H:%M'),
    }
    base = secure_filename(
        f"assignments_{mode}_{subject['subject_name']}_sem{semester}_{academic_year}" + (f"_div{division}" if division else "")
    ) or "assignment_report"

    if fmt == 'pdf':
        buffer = _build_assignment_pdf(meta, rows, mode, line)
        return send_file(buffer, as_attachment=True, download_name=base + ".pdf", mimetype='application/pdf')
    buffer = _build_assignment_xlsx(meta, rows, mode, line)
    return send_file(buffer, as_attachment=True, download_name=base + ".xlsx",
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


# ============================================================
# REPORTS — Student Report (Excel / PDF)
# Two forms: "summary" (default) = one row per student (attendance, assignments, marks, at-risk reason),
# "detail" = one student: attendance (Lecture / Lab), every assignment, and every published exam mark.
# Scope is the same as the other reports: only the faculty's own subject+semester+batch(+divisions).
# Marks: only PUBLISHED marks of this subject are used (so marks the admin has not approved yet never appear).
# At-risk = attendance below 75%  OR  any assignment still pending  OR  average marks % below the passing %.
# ============================================================
_STU_DEFAULT_PASS = 40
_STU_EXAMS = ["Mid-Semester", "Remedial", "Internal", "Practical"]
_STU_EXAM_SHORT = {"Mid-Semester": "Mid-Sem", "Remedial": "Remedial", "Internal": "Internal", "Practical": "Practical"}


def _stu_passing_pct(cursor):
    """Same rule as the student panel: system_settings 'passing_percentage', default 40."""
    try:
        cursor.execute("SELECT setting_value FROM system_settings WHERE setting_key = 'passing_percentage'")
        row = cursor.fetchone()
        return float(row['setting_value']) if row and row['setting_value'] else _STU_DEFAULT_PASS
    except Exception:
        return _STU_DEFAULT_PASS


def _stu_risk_reasons(att_pct, pending, avg_marks, passing):
    reasons = []
    if att_pct is not None and att_pct < _ATT_LOW_LIMIT:
        reasons.append(f"Attendance below {_ATT_LOW_LIMIT}%")
    if pending > 0:
        reasons.append(f"{pending} assignment(s) pending")
    if avg_marks is not None and avg_marks < passing:
        reasons.append(f"Marks below {passing:g}%")
    return reasons


def _stu_exam_cell(pair):
    if not pair:
        return "-"
    o, m = pair
    if o is None:
        return "-"
    return f"{_asg_fmt_marks(o)}/{_asg_fmt_marks(m)}" if m else _asg_fmt_marks(o)


def _stu_pct_text(v):
    return f"{v:.1f}%" if v is not None else "N/A"


def _stu_summary_line(rows):
    atts = [r['att_pct'] for r in rows if r['att_pct'] is not None]
    marks = [r['avg_marks'] for r in rows if r['avg_marks'] is not None]
    return {
        "students": len(rows),
        "atrisk": sum(1 for r in rows if r['reasons']),
        "avg_att": f"{sum(atts) / len(atts):.1f}%" if atts else "N/A",
        "avg_marks": f"{sum(marks) / len(marks):.1f}%" if marks else "N/A",
    }


def _stu_summary_headers(parent):
    h = ["Sr No.", "Enrollment", "Name", "Div", "Present/Total", "Attendance %", "Assignments (Submitted/Total)",
         "Late", "Mid-Sem", "Remedial", "Internal", "Practical", "Avg Marks %", "At-risk Reason"]
    return h + (["Parent Mobile"] if parent else [])


def _stu_summary_values(i, r, parent):
    v = [i, r['enrollment'], r['name'], r['division'] or '',
         f"{r['att_present']}/{r['att_total']}", _stu_pct_text(r['att_pct']),
         f"{r['asg_submitted']}/{r['asg_total']}", r['asg_late']]
    v += [_stu_exam_cell(r['exams'].get(e)) for e in _STU_EXAMS]
    v += [_stu_pct_text(r['avg_marks']), ", ".join(r['reasons']) if r['reasons'] else "-"]
    if parent:
        v.append(r['parent_mobile'] or "-")
    return v


def _stu_red_columns(r, passing):
    """1-based column numbers of the summary table that are shown in red for this student."""
    cols = []
    if r['att_pct'] is not None and r['att_pct'] < _ATT_LOW_LIMIT:
        cols.append(6)
    if r['asg_pending'] > 0:
        cols.append(7)
    if r['asg_late'] > 0:
        cols.append(8)
    if r['avg_marks'] is not None and r['avg_marks'] < passing:
        cols.append(13)
    if r['reasons']:
        cols.append(14)
    return cols


def _build_student_summary_xlsx(meta, rows, line, passing, parent):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Students"
    ws.append(["Student Report - Class Summary"])
    ws['A1'].font = Font(bold=True, size=14)
    info = [("Subject", meta['subject']), ("Semester", meta['semester']), ("Batch", meta['batch']),
            ("Division", meta['division']), ("Students filter", meta['filter']),
            ("Passing marks %", f"{passing:g}%"), ("Generated on", meta['generated'])]
    for k, v in info:
        ws.append([k, v])
    for r in range(2, 2 + len(info)):
        ws.cell(row=r, column=1).font = Font(bold=True)
    ws.append([])
    ws.append(["Summary", f"Total students: {line['students']}", f"At-risk: {line['atrisk']}",
               f"Average attendance: {line['avg_att']}", f"Average marks: {line['avg_marks']}"])
    for c in ws[ws.max_row]:
        c.font = Font(bold=True)
    ws.append([])
    ws.append(_stu_summary_headers(parent))
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)

    red = Font(color="C00000", bold=True)
    for i, r in enumerate(rows, start=1):
        ws.append(_stu_summary_values(i, r, parent))
        for col in _stu_red_columns(r, passing):
            ws.cell(row=ws.max_row, column=col).font = red

    widths = [8, 24, 30, 6, 14, 14, 18, 7, 11, 11, 11, 11, 13, 36, 16]
    for idx, w in enumerate(widths[:len(_stu_summary_headers(parent))], start=1):
        ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = w

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


def _build_student_summary_pdf(meta, rows, line, passing, parent):
    from xml.sax.saxutils import escape
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=landscape(A4), leftMargin=10 * mm, rightMargin=10 * mm,
                            topMargin=12 * mm, bottomMargin=12 * mm, title="Student Report")
    styles = getSampleStyleSheet()
    cell = ParagraphStyle('cell', parent=styles['Normal'], fontSize=7.5, leading=9)
    story = [Paragraph("Student Report - Class Summary", styles['Title'])]
    info = (
        f"<b>Subject:</b> {escape(meta['subject'])}<br/>"
        f"<b>Semester:</b> {escape(str(meta['semester']))} &nbsp;&nbsp; <b>Batch:</b> {escape(str(meta['batch']))} &nbsp;&nbsp; "
        f"<b>Division:</b> {escape(str(meta['division']))} &nbsp;&nbsp; <b>Students filter:</b> {escape(meta['filter'])} &nbsp;&nbsp; "
        f"<b>Passing marks:</b> {passing:g}%<br/>"
        f"<b>Generated on:</b> {escape(meta['generated'])}<br/><br/>"
        f"<b>Total students:</b> {line['students']} &nbsp;&nbsp; <b>At-risk:</b> {line['atrisk']} &nbsp;&nbsp; "
        f"<b>Average attendance:</b> {line['avg_att']} &nbsp;&nbsp; <b>Average marks:</b> {line['avg_marks']}"
    )
    story.append(Paragraph(info, styles['Normal']))
    story.append(Spacer(1, 5 * mm))

    headers = ["Sr", "Enrollment", "Name", "Div", "Present / Total", "Att %", "Assign. (Sub/Total)", "Late",
               "Mid-Sem", "Remedial", "Internal", "Practical", "Avg Marks %", "At-risk Reason"]
    widths = [7, 22, 36, 8, 15, 13, 18, 10, 16, 17, 15, 17, 14, 38]
    if parent:
        headers.append("Parent Mobile")
        widths.append(22)
    total_w = sum(widths)
    avail = 277.0
    if total_w > avail:
        widths = [w * avail / total_w for w in widths]

    data = [[Paragraph(f"<b>{escape(h)}</b>", ParagraphStyle('h', parent=cell, fontSize=6.8, leading=8, textColor=colors.white)) for h in headers]]
    red_cells = []
    for i, r in enumerate(rows, start=1):
        vals = [str(x) for x in _stu_summary_values(i, r, parent)]
        vals[2] = Paragraph(escape(vals[2]), cell)
        vals[13] = Paragraph(escape(vals[13]), cell)
        data.append(vals)
        for col in _stu_red_columns(r, passing):
            red_cells.append((col - 1, i))
            if col == 14:
                data[i][13] = Paragraph(f'<font color="#C00000"><b>{escape(r["reasons"] and ", ".join(r["reasons"]) or "-")}</b></font>', cell)

    if len(data) == 1:
        story.append(Paragraph("No students match the selected filters.", styles['Normal']))
    else:
        table = Table(data, repeatRows=1, colWidths=[w * mm for w in widths])
        style = [
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0f766e')),
            ('FONTSIZE', (0, 0), (-1, -1), 7.5),
            ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#cbd5d1')),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f1f7f5')]),
            ('ALIGN', (3, 0), (12, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]
        for col, i in red_cells:
            if col != 13:
                style.append(('TEXTCOLOR', (col, i), (col, i), colors.HexColor('#C00000')))
                style.append(('FONTNAME', (col, i), (col, i), 'Helvetica-Bold'))
        table.setStyle(TableStyle(style))
        story.append(table)

    doc.build(story)
    buffer.seek(0)
    return buffer


def _stu_detail_tables(d, passing):
    """Shared by the Excel and the PDF detail builders. Returns the three tables as
    (title, headers, rows, red_row_indexes) so both formats show exactly the same thing."""
    att_rows, att_red = [], []
    for label, p, t, pct in d['att']:
        att_rows.append([label, p, t, _stu_pct_text(pct)])
        if pct is not None and pct < _ATT_LOW_LIMIT:
            att_red.append(len(att_rows) - 1)

    asg_rows, asg_red = [], []
    for i, a in enumerate(d['assignments'], start=1):
        status = "Not submitted" if not a['submitted'] else ("Late" if a['late'] else "On time")
        asg_rows.append([i, a['title'], _asg_fmt_date(a['due_date']), status, _asg_fmt_date(a['submitted_at']),
                         _asg_fmt_marks(a['marks'])])
        if status != "On time":
            asg_red.append(len(asg_rows) - 1)

    mk_rows, mk_red = [], []
    for m in d['marks']:
        result = "-" if m['pct'] is None else ("Pass" if m['pct'] >= passing else "Fail")
        mk_rows.append([m['exam'], _asg_fmt_marks(m['obtained']), _asg_fmt_marks(m['max']), _stu_pct_text(m['pct']), result])
        if result == "Fail":
            mk_red.append(len(mk_rows) - 1)

    return [
        ("Attendance", ["Session", "Present", "Total", "Attendance %"], att_rows, att_red),
        ("Assignments", ["Sr", "Title", "Due Date", "Status", "Submission Date", "Marks"], asg_rows, asg_red),
        ("Marks (published)", ["Exam", "Obtained", "Max", "Percentage", "Result"], mk_rows, mk_red),
    ]


def _stu_detail_info(meta, d, parent):
    info = [("Student", d['name']), ("Enrollment", d['enrollment']), ("Division", d['division'] or '-'),
            ("Subject", meta['subject']), ("Semester", meta['semester']), ("Batch", meta['batch'])]
    if parent:
        info.append(("Parent Mobile", d['parent_mobile'] or '-'))
    info.append(("At-risk", ", ".join(d['reasons']) if d['reasons'] else "No"))
    info.append(("Generated on", meta['generated']))
    return info


def _build_student_detail_xlsx(meta, d, passing, parent):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Student"
    ws.append(["Student Report - Single Student Detail"])
    ws['A1'].font = Font(bold=True, size=14)
    info = _stu_detail_info(meta, d, parent)
    for k, v in info:
        ws.append([k, v])
        ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
        if k == "At-risk" and d['reasons']:
            ws.cell(row=ws.max_row, column=2).font = Font(color="C00000", bold=True)

    red = Font(color="C00000", bold=True)
    for title, headers, rows, red_idx in _stu_detail_tables(d, passing):
        ws.append([])
        ws.append([title])
        ws.cell(row=ws.max_row, column=1).font = Font(bold=True, size=12)
        ws.append(headers)
        for c in ws[ws.max_row]:
            c.font = Font(bold=True)
        if not rows:
            ws.append(["No records"])
            continue
        for idx, row in enumerate(rows):
            ws.append(row)
            if idx in red_idx:
                for c in ws[ws.max_row]:
                    if c.value is not None:
                        c.font = red

    for idx, w in enumerate([22, 34, 16, 16, 18, 10], start=1):
        ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = w

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


def _build_student_detail_pdf(meta, d, passing, parent):
    from xml.sax.saxutils import escape
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm, title="Student Report")
    styles = getSampleStyleSheet()
    story = [Paragraph("Student Report - Single Student Detail", styles['Title'])]
    lines = []
    for k, v in _stu_detail_info(meta, d, parent):
        text = f"<b>{escape(k)}:</b> {escape(str(v))}"
        if k == "At-risk" and d['reasons']:
            text = f'<b>{escape(k)}:</b> <font color="#C00000"><b>{escape(str(v))}</b></font>'
        lines.append(text)
    story.append(Paragraph("<br/>".join(lines), styles['Normal']))

    widths_by_title = {
        "Attendance": [50, 30, 30, 40],
        "Assignments": [10, 60, 26, 28, 30, 18],
        "Marks (published)": [50, 28, 28, 30, 26],
    }
    for title, headers, rows, red_idx in _stu_detail_tables(d, passing):
        story.append(Spacer(1, 6 * mm))
        story.append(Paragraph(f"<b>{escape(title)}</b>", styles['Heading3']))
        if not rows:
            story.append(Paragraph("No records.", styles['Normal']))
            continue
        data = [headers]
        for ri, row in enumerate(rows):
            out = []
            for j, c in enumerate(row):
                if headers[j] == "Title":
                    txt = escape(str(c))
                    if ri in red_idx:
                        txt = f'<font color="#C00000"><b>{txt}</b></font>'
                    out.append(Paragraph(txt, styles['Normal']))
                else:
                    out.append(str(c))
            data.append(out)
        table = Table(data, repeatRows=1, colWidths=[w * mm for w in widths_by_title[title]])
        style = [
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0f766e')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#cbd5d1')),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f1f7f5')]),
            ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]
        for i in red_idx:
            style.append(('TEXTCOLOR', (0, i + 1), (-1, i + 1), colors.HexColor('#C00000')))
            style.append(('FONTNAME', (0, i + 1), (-1, i + 1), 'Helvetica-Bold'))
        table.setStyle(TableStyle(style))
        story.append(table)

    doc.build(story)
    buffer.seek(0)
    return buffer


_STU_FILTER_LABELS = {'all': 'All students', 'atrisk': 'At-risk students only', 'one': 'One student'}


@app.route('/api/faculty/reports/students', methods=['GET'])
@faculty_required
def faculty_student_report():
    """Query params: subject_id, semester, academic_year (required), division (optional),
    report ('summary' default | 'detail' — detail needs student_id), student_id (optional for summary),
    at_risk=1 (summary only: keep only at-risk students), include_parent=1 (adds the parent's mobile),
    format ('xlsx' default | 'pdf')."""
    subject_id = request.args.get('subject_id', type=int)
    semester = request.args.get('semester', type=int)
    academic_year = (request.args.get('academic_year') or '').strip()
    division = (request.args.get('division') or '').strip()
    student_id = request.args.get('student_id', type=int)
    mode = (request.args.get('report') or 'summary').strip().lower()
    at_risk = request.args.get('at_risk') in ('1', 'true')
    parent = request.args.get('include_parent') in ('1', 'true')
    fmt = (request.args.get('format') or 'xlsx').strip().lower()

    if not subject_id or not semester or not academic_year:
        return jsonify({"message": "Batch, semester and subject are required"}), 400
    if fmt not in ('xlsx', 'pdf'):
        return jsonify({"message": "format must be xlsx or pdf"}), 400
    if mode not in ('summary', 'detail'):
        return jsonify({"message": "report must be summary or detail"}), 400
    if mode == 'detail' and not student_id:
        return jsonify({"message": "Select one student for the single student detail report"}), 400

    if fmt == 'pdf':
        try:
            import reportlab   # noqa: F401  (only checking that it is installed)
        except ImportError:
            return jsonify({"message": "PDF export needs the 'reportlab' package on the server. Run: pip install reportlab"}), 500

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        allowed, div_clause, div_params = _subject_division_scope(
            cursor, faculty_id, subject_id, semester, academic_year, division)
        if not allowed:
            return jsonify({"message": "This subject / division is not assigned to you for the selected semester and batch"}), 403

        cursor.execute("SELECT subject_code, subject_name FROM subjects WHERE id = %s", (subject_id,))
        subject = cursor.fetchone()
        if not subject:
            return jsonify({"message": "Subject not found"}), 404

        passing = _stu_passing_pct(cursor)

        stu_clause = "AND st.id = %s" if student_id else ""
        stu_params = (student_id,) if student_id else ()
        cursor.execute(f"""
            SELECT st.id AS student_id, u.login_id AS enrollment, u.name, st.division,
                   st.father_mobile, st.mother_mobile
            FROM students st
            JOIN users u ON u.id = st.user_id
            WHERE st.semester = %s AND st.academic_year = %s {div_clause} {stu_clause}
            ORDER BY u.login_id
        """, (semester, academic_year) + tuple(div_params) + stu_params)
        students = cursor.fetchall()
        if student_id and not students:
            return jsonify({"message": "This student is not in your assigned class for the selected semester and batch"}), 404

        ids = [s['student_id'] for s in students]
        att_map, asg_map, marks_map = {}, {}, {}
        if ids:
            ph = ",".join(["%s"] * len(ids))
            cursor.execute(f"""
                SELECT student_id,
                       SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count,
                       COUNT(*) AS total_count
                FROM attendance
                WHERE subject_id = %s AND student_id IN ({ph})
                GROUP BY student_id
            """, (subject_id,) + tuple(ids))
            att_map = {r['student_id']: r for r in cursor.fetchall()}

            subs = """(SELECT assignment_id, student_id, MIN(submitted_at) AS submitted_at, MAX(marks_obtained) AS marks_obtained
                       FROM assignment_submissions GROUP BY assignment_id, student_id)"""
            cursor.execute(f"""
                SELECT st.id AS student_id, COUNT(a.id) AS total_count, COUNT(asub.assignment_id) AS submitted_count,
                       COALESCE(SUM(CASE WHEN asub.assignment_id IS NOT NULL AND a.due_date IS NOT NULL
                                              AND DATE(asub.submitted_at) > a.due_date THEN 1 ELSE 0 END), 0) AS late_count
                FROM students st
                LEFT JOIN assignments a
                       ON a.subject_id = %s AND a.semester = st.semester AND a.academic_year = st.academic_year
                      AND (a.division IS NULL OR a.division = st.division)
                LEFT JOIN {subs} asub ON asub.assignment_id = a.id AND asub.student_id = st.id
                WHERE st.id IN ({ph})
                GROUP BY st.id
            """, (subject_id,) + tuple(ids))
            asg_map = {r['student_id']: r for r in cursor.fetchall()}

            # published marks only; if an exam type has several rows the latest one wins
            cursor.execute(f"""
                SELECT student_id, exam_type, marks_obtained, max_marks
                FROM marks
                WHERE subject_id = %s AND published = 1 AND student_id IN ({ph})
                ORDER BY id ASC
            """, (subject_id,) + tuple(ids))
            for m in cursor.fetchall():
                marks_map.setdefault(m['student_id'], {})[m['exam_type']] = (
                    float(m['marks_obtained']) if m['marks_obtained'] is not None else None,
                    float(m['max_marks']) if m['max_marks'] is not None else None)

        detail = None
        if mode == 'detail':
            s = students[0]
            cursor.execute("""
                SELECT session_type,
                       SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count, COUNT(*) AS total_count
                FROM attendance WHERE student_id = %s AND subject_id = %s GROUP BY session_type
            """, (s['student_id'], subject_id))
            att_by_type = {r['session_type']: r for r in cursor.fetchall()}
            cursor.execute("""
                SELECT a.title, a.due_date, asub.submitted_at, asub.marks_obtained
                FROM assignments a
                LEFT JOIN (SELECT assignment_id, student_id, MIN(submitted_at) AS submitted_at, MAX(marks_obtained) AS marks_obtained
                           FROM assignment_submissions GROUP BY assignment_id, student_id) asub
                       ON asub.assignment_id = a.id AND asub.student_id = %s
                WHERE a.subject_id = %s AND a.semester = %s AND a.academic_year = %s
                  AND (a.division IS NULL OR a.division = %s)
                ORDER BY a.due_date ASC, a.id ASC
            """, (s['student_id'], subject_id, semester, academic_year, s['division']))
            asg_rows = cursor.fetchall()
    except Exception as e:
        return jsonify({"message": "Report could not be generated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

    rows = []
    for s in students:
        att = att_map.get(s['student_id'])
        present = int(att['present_count']) if att else 0
        total = int(att['total_count']) if att else 0
        att_pct = round(present * 100 / total, 1) if total else None
        asg = asg_map.get(s['student_id'])
        a_total = int(asg['total_count']) if asg else 0
        a_sub = int(asg['submitted_count']) if asg else 0
        a_late = int(asg['late_count']) if asg else 0
        exams = marks_map.get(s['student_id'], {})
        pcts = [o * 100 / m for (o, m) in exams.values() if o is not None and m]
        avg_marks = round(sum(pcts) / len(pcts), 1) if pcts else None
        reasons = _stu_risk_reasons(att_pct, a_total - a_sub, avg_marks, passing)
        rows.append({"student_id": s['student_id'], "enrollment": s['enrollment'], "name": s['name'],
                     "division": s['division'], "parent_mobile": s['father_mobile'] or s['mother_mobile'],
                     "att_present": present, "att_total": total, "att_pct": att_pct,
                     "asg_total": a_total, "asg_submitted": a_sub, "asg_pending": a_total - a_sub, "asg_late": a_late,
                     "exams": exams, "avg_marks": avg_marks, "reasons": reasons})

    if mode == 'summary' and at_risk:
        rows = [r for r in rows if r['reasons']]

    meta = {
        "subject": f"{subject['subject_name']} ({subject['subject_code']})" if subject['subject_code'] else subject['subject_name'],
        "semester": semester,
        "batch": academic_year,
        "division": division or "All",
        "filter": _STU_FILTER_LABELS['atrisk' if at_risk else ('one' if student_id else 'all')],
        "generated": datetime.now().strftime('%d-%m-%Y %H:%M'),
    }
    base = secure_filename(
        f"students_{mode}_{subject['subject_name']}_sem{semester}_{academic_year}" + (f"_div{division}" if division else "")
    ) or "student_report"

    if mode == 'detail':
        r = rows[0]
        att_list = []
        for label in ("Lecture", "Lab"):
            t = att_by_type.get(label)
            if t and int(t['total_count']):
                p, tt = int(t['present_count']), int(t['total_count'])
                att_list.append((label, p, tt, round(p * 100 / tt, 1)))
        att_list.append(("Overall", r['att_present'], r['att_total'], r['att_pct']))
        due_assignments = []
        for a in asg_rows:
            sub_at = a['submitted_at']
            due = a['due_date']
            due_assignments.append({
                "title": a['title'], "due_date": due, "submitted": sub_at is not None, "submitted_at": sub_at,
                "late": bool(sub_at is not None and due and sub_at.date() > due),
                "marks": float(a['marks_obtained']) if a['marks_obtained'] is not None else None})
        mark_list = []
        known = [e for e in _STU_EXAMS if e in r['exams']] + [e for e in r['exams'] if e not in _STU_EXAMS]
        for e in known:
            o, m = r['exams'][e]
            mark_list.append({"exam": e, "obtained": o, "max": m, "pct": round(o * 100 / m, 1) if (o is not None and m) else None})
        d = {"name": r['name'], "enrollment": r['enrollment'], "division": r['division'],
             "parent_mobile": r['parent_mobile'], "reasons": r['reasons'],
             "att": att_list, "assignments": due_assignments, "marks": mark_list}
        if fmt == 'pdf':
            buffer = _build_student_detail_pdf(meta, d, passing, parent)
            return send_file(buffer, as_attachment=True, download_name=base + ".pdf", mimetype='application/pdf')
        buffer = _build_student_detail_xlsx(meta, d, passing, parent)
        return send_file(buffer, as_attachment=True, download_name=base + ".xlsx",
                         mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

    line = _stu_summary_line(rows)
    if fmt == 'pdf':
        buffer = _build_student_summary_pdf(meta, rows, line, passing, parent)
        return send_file(buffer, as_attachment=True, download_name=base + ".pdf", mimetype='application/pdf')
    buffer = _build_student_summary_xlsx(meta, rows, line, passing, parent)
    return send_file(buffer, as_attachment=True, download_name=base + ".xlsx",
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


# ============================================================
# REPORTS — Marks Report (Excel / PDF)
# Two forms: ONE exam type chosen = exam-wise marks sheet (obtained / max / % / Pass-Fail),
# "All exams" (default) = one row per student with every exam type in its own column + average % and result.
# Only PUBLISHED marks of this subject are used. A student with no marks yet shows "-" and is neither
# Pass nor Fail (and is left out of the pass %). Pass = percentage >= passing % (system_settings, default 40).
# In the "All exams" form the result is judged on the average % of the student's exam types.
# ============================================================
_MK_RESULT_LABELS = {'all': 'All', 'pass': 'Pass only', 'fail': 'Fail only'}
_MK_BUCKETS = [("Below 40%", 0, 40), ("40% - 60%", 40, 60), ("60% - 80%", 60, 80), ("80% and above", 80, 1000)]


def _mk_pct(o, m):
    return round(o * 100 / m, 1) if (o is not None and m) else None


def _mk_result(pct, passing):
    if pct is None:
        return "-"
    return "Pass" if pct >= passing else "Fail"


def _mk_summary_line(rows):
    """rows already carry 'pct' (the percentage that decides the result) and 'result'."""
    pcts = [r['pct'] for r in rows if r['pct'] is not None]
    passed = sum(1 for r in rows if r['result'] == "Pass")
    failed = sum(1 for r in rows if r['result'] == "Fail")
    buckets = [(label, sum(1 for p in pcts if lo <= p < hi)) for label, lo, hi in _MK_BUCKETS]
    return {
        "students": len(rows), "entered": len(pcts), "pass": passed, "fail": failed,
        "pass_pct": f"{passed * 100 / len(pcts):.1f}%" if pcts else "N/A",
        "avg": f"{sum(pcts) / len(pcts):.1f}%" if pcts else "N/A",
        "high": f"{max(pcts):.1f}%" if pcts else "N/A",
        "low": f"{min(pcts):.1f}%" if pcts else "N/A",
        "buckets": buckets,
    }


def _mk_line_texts(line):
    top = (f"Total students: {line['students']}   Marks entered: {line['entered']}   Pass: {line['pass']}   "
           f"Fail: {line['fail']}   Pass %: {line['pass_pct']}")
    mid = f"Average: {line['avg']}   Highest: {line['high']}   Lowest: {line['low']}"
    dist = "Distribution: " + "   ".join(f"{label}: {n}" for label, n in line['buckets'])
    return top, mid, dist


def _mk_headers(exam):
    if exam:
        return ["Sr No.", "Enrollment", "Name", "Div", "Marks Obtained", "Max Marks", "Percentage", "Result"]
    return ["Sr No.", "Enrollment", "Name", "Div", "Mid-Sem", "Remedial", "Internal", "Practical", "Avg %", "Result"]


def _mk_values(exam, i, r):
    if exam:
        o, m = r['exams'].get(exam, (None, None))
        return [i, r['enrollment'], r['name'], r['division'] or '',
                _asg_fmt_marks(o), _asg_fmt_marks(m), _stu_pct_text(r['pct']), r['result']]
    return [i, r['enrollment'], r['name'], r['division'] or ''] + \
           [_stu_exam_cell(r['exams'].get(e)) for e in _STU_EXAMS] + [_stu_pct_text(r['pct']), r['result']]


def _mk_red_columns(exam, r, passing):
    """1-based columns shown in red. Exam-wise: the whole row when the student failed.
    All exams: the Avg % and Result cells of a failed student, plus any single exam below the passing %."""
    ncols = len(_mk_headers(exam))
    if exam:
        return list(range(1, ncols + 1)) if r['result'] == "Fail" else []
    cols = []
    for idx, e in enumerate(_STU_EXAMS):
        o, m = r['exams'].get(e, (None, None))
        p = _mk_pct(o, m)
        if p is not None and p < passing:
            cols.append(5 + idx)
    if r['result'] == "Fail":
        cols += [ncols - 1, ncols]
    return cols


def _build_marks_xlsx(meta, rows, line, passing, exam):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Marks"
    ws.append(["Marks Report - " + (f"{exam} Marks Sheet" if exam else "All Exams")])
    ws['A1'].font = Font(bold=True, size=14)
    info = [("Subject", meta['subject']), ("Semester", meta['semester']), ("Batch", meta['batch']),
            ("Division", meta['division']), ("Exam", meta['exam']), ("Result filter", meta['result']),
            ("Passing marks %", f"{passing:g}%"), ("Generated on", meta['generated'])]
    for k, v in info:
        ws.append([k, v])
    for r in range(2, 2 + len(info)):
        ws.cell(row=r, column=1).font = Font(bold=True)
    ws.append([])
    for text in _mk_line_texts(line):
        ws.append([text])
        ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
    ws.append([])
    headers = _mk_headers(exam)
    ws.append(headers)
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)

    red = Font(color="C00000", bold=True)
    for i, r in enumerate(rows, start=1):
        vals = _mk_values(exam, i, r)
        if exam:   # marks as real numbers in Excel
            for pos in (4, 5):
                if vals[pos] != "-":
                    vals[pos] = float(vals[pos]) if "." in str(vals[pos]) else int(vals[pos])
        ws.append(vals)
        for col in _mk_red_columns(exam, r, passing):
            ws.cell(row=ws.max_row, column=col).font = red

    widths = [8, 24, 30, 6, 16, 12, 12, 10] if exam else [8, 24, 30, 6, 12, 12, 12, 12, 10, 10]
    for idx, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = w

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


def _build_marks_pdf(meta, rows, line, passing, exam):
    from xml.sax.saxutils import escape
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=landscape(A4), leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm, title="Marks Report")
    styles = getSampleStyleSheet()
    story = [Paragraph("Marks Report - " + (f"{escape(exam)} Marks Sheet" if exam else "All Exams"), styles['Title'])]
    top, mid, dist = _mk_line_texts(line)
    info = (
        f"<b>Subject:</b> {escape(meta['subject'])}<br/>"
        f"<b>Semester:</b> {escape(str(meta['semester']))} &nbsp;&nbsp; <b>Batch:</b> {escape(str(meta['batch']))} &nbsp;&nbsp; "
        f"<b>Division:</b> {escape(str(meta['division']))} &nbsp;&nbsp; <b>Exam:</b> {escape(meta['exam'])} &nbsp;&nbsp; "
        f"<b>Result filter:</b> {escape(meta['result'])} &nbsp;&nbsp; <b>Passing marks:</b> {passing:g}%<br/>"
        f"<b>Generated on:</b> {escape(meta['generated'])}<br/><br/>"
        f"<b>{escape(top).replace('   ', ' &nbsp;&nbsp;&nbsp; ')}</b><br/>"
        f"<b>{escape(mid).replace('   ', ' &nbsp;&nbsp;&nbsp; ')}</b><br/>"
        f"<b>{escape(dist).replace('   ', ' &nbsp;&nbsp;&nbsp; ')}</b>"
    )
    story.append(Paragraph(info, styles['Normal']))
    story.append(Spacer(1, 5 * mm))

    headers = _mk_headers(exam)
    widths = [13, 34, 77, 12, 30, 24, 28, 24] if exam else [13, 32, 67, 12, 24, 24, 24, 24, 24, 22]
    data = [headers]
    red_cells = []
    for i, r in enumerate(rows, start=1):
        data.append([str(x) for x in _mk_values(exam, i, r)])
        for col in _mk_red_columns(exam, r, passing):
            red_cells.append((col - 1, i))

    if len(data) == 1:
        story.append(Paragraph("No students match the selected filters.", styles['Normal']))
    else:
        table = Table(data, repeatRows=1, colWidths=[w * mm for w in widths])
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

    doc.build(story)
    buffer.seek(0)
    return buffer


@app.route('/api/faculty/reports/marks', methods=['GET'])
@faculty_required
def faculty_marks_report():
    """Query params: subject_id, semester, academic_year (required), division (optional),
    exam_type (optional: Mid-Semester | Remedial | Internal | Practical; empty = all exams),
    result ('all' default | 'pass' | 'fail'), format ('xlsx' default | 'pdf')."""
    subject_id = request.args.get('subject_id', type=int)
    semester = request.args.get('semester', type=int)
    academic_year = (request.args.get('academic_year') or '').strip()
    division = (request.args.get('division') or '').strip()
    exam = (request.args.get('exam_type') or '').strip()
    result_filter = (request.args.get('result') or 'all').strip().lower()
    fmt = (request.args.get('format') or 'xlsx').strip().lower()

    if not subject_id or not semester or not academic_year:
        return jsonify({"message": "Batch, semester and subject are required"}), 400
    if fmt not in ('xlsx', 'pdf'):
        return jsonify({"message": "format must be xlsx or pdf"}), 400
    if exam and exam not in _STU_EXAMS:
        return jsonify({"message": "exam_type must be one of: " + ", ".join(_STU_EXAMS)}), 400
    if result_filter not in _MK_RESULT_LABELS:
        return jsonify({"message": "result must be all, pass or fail"}), 400

    if fmt == 'pdf':
        try:
            import reportlab   # noqa: F401  (only checking that it is installed)
        except ImportError:
            return jsonify({"message": "PDF export needs the 'reportlab' package on the server. Run: pip install reportlab"}), 500

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        allowed, div_clause, div_params = _subject_division_scope(
            cursor, faculty_id, subject_id, semester, academic_year, division)
        if not allowed:
            return jsonify({"message": "This subject / division is not assigned to you for the selected semester and batch"}), 403

        cursor.execute("SELECT subject_code, subject_name FROM subjects WHERE id = %s", (subject_id,))
        subject = cursor.fetchone()
        if not subject:
            return jsonify({"message": "Subject not found"}), 404

        passing = _stu_passing_pct(cursor)

        cursor.execute(f"""
            SELECT st.id AS student_id, u.login_id AS enrollment, u.name, st.division
            FROM students st
            JOIN users u ON u.id = st.user_id
            WHERE st.semester = %s AND st.academic_year = %s {div_clause}
            ORDER BY u.login_id
        """, (semester, academic_year) + tuple(div_params))
        students = cursor.fetchall()

        marks_map = {}
        ids = [s['student_id'] for s in students]
        if ids:
            ph = ",".join(["%s"] * len(ids))
            # published marks only; if an exam type has several rows the latest one wins
            cursor.execute(f"""
                SELECT student_id, exam_type, marks_obtained, max_marks
                FROM marks
                WHERE subject_id = %s AND published = 1 AND student_id IN ({ph})
                ORDER BY id ASC
            """, (subject_id,) + tuple(ids))
            for m in cursor.fetchall():
                marks_map.setdefault(m['student_id'], {})[m['exam_type']] = (
                    float(m['marks_obtained']) if m['marks_obtained'] is not None else None,
                    float(m['max_marks']) if m['max_marks'] is not None else None)
    except Exception as e:
        return jsonify({"message": "Report could not be generated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

    rows = []
    for s in students:
        exams = marks_map.get(s['student_id'], {})
        if exam:
            o, m = exams.get(exam, (None, None))
            pct = _mk_pct(o, m)
        else:
            pcts = [o * 100 / m for (o, m) in exams.values() if o is not None and m]
            pct = round(sum(pcts) / len(pcts), 1) if pcts else None
        result = _mk_result(pct, passing)
        if result_filter == 'pass' and result != "Pass":
            continue
        if result_filter == 'fail' and result != "Fail":
            continue
        rows.append({"enrollment": s['enrollment'], "name": s['name'], "division": s['division'],
                     "exams": exams, "pct": pct, "result": result})

    line = _mk_summary_line(rows)
    meta = {
        "subject": f"{subject['subject_name']} ({subject['subject_code']})" if subject['subject_code'] else subject['subject_name'],
        "semester": semester,
        "batch": academic_year,
        "division": division or "All",
        "exam": exam or "All exams",
        "result": _MK_RESULT_LABELS[result_filter],
        "generated": datetime.now().strftime('%d-%m-%Y %H:%M'),
    }
    base = secure_filename(
        f"marks_{exam or 'all_exams'}_{subject['subject_name']}_sem{semester}_{academic_year}" + (f"_div{division}" if division else "")
    ) or "marks_report"

    if fmt == 'pdf':
        buffer = _build_marks_pdf(meta, rows, line, passing, exam)
        return send_file(buffer, as_attachment=True, download_name=base + ".pdf", mimetype='application/pdf')
    buffer = _build_marks_xlsx(meta, rows, line, passing, exam)
    return send_file(buffer, as_attachment=True, download_name=base + ".xlsx",
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


# ============================================================
# FEE REPORT (class-level: Batch -> Semester -> Division, same scope rules as the Fees screen)
# The report itself (filters, overdue rule, totals, Excel / PDF) lives in admin_routes.py,
# which the Admin panel uses too.
# ============================================================
@app.route('/api/faculty/reports/fees', methods=['GET'])
@faculty_required
def faculty_fees_report():
    """Query params: semester, academic_year (required), division (optional),
    fee_title (optional; empty = all fee items),
    status ('all' default | 'paid' | 'unpaid' | 'overdue'),
    report ('summary' default | 'detail' | 'defaulters'), format ('xlsx' default | 'pdf').
    View-only: it never changes any fee record."""
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

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        # Same class check as the Fees screen: faculty only sees the semester + batch (+ divisions) they teach
        allowed, div_clause, div_params = _class_division_scope(
            cursor, faculty_id, semester, academic_year, division or None)
        if not allowed:
            return jsonify({"message": "This class is not assigned to you"}), 403

        cursor.execute(f"""
            SELECT f.id AS fee_id, st.id AS student_id, u.login_id AS enrollment, u.name, st.division,
                   f.fee_title, f.amount, f.due_date, f.status, f.paid_at
            FROM students st
            JOIN users u ON u.id = st.user_id
            JOIN fees f ON f.student_id = st.id AND f.semester = %s AND f.academic_year = %s
            WHERE st.semester = %s AND st.academic_year = %s {div_clause}
            ORDER BY u.login_id, f.due_date, f.fee_title
        """, (semester, academic_year, semester, academic_year) + tuple(div_params))
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