from flask import request, jsonify, send_from_directory
import os
import uuid
import bcrypt
import datetime
from werkzeug.utils import secure_filename

from db import get_db
from app import app
from auth_middleware import student_required, is_default_password
from session_routes import get_holiday, get_cancelled_override, SessionCalendar
from chatbot_helper import find_faq_answer, get_fallback_reply, log_chat, logged_assistant, get_user_chat_history
from admin_routes import get_attendance_min, attendance_is_short, attendance_need_more, attendance_can_miss, ATTENDANCE_ALERT_MIN_CLASSES, NOTES_UPLOAD_FOLDER, ASSIGNMENT_UPLOAD_FOLDER, _allowed_assignment_file, NOTICE_UPLOAD_FOLDER


def _get_student(cursor, user_id):
    """The logged-in student's own semester / division / batch — the timetable is filtered by this."""
    cursor.execute("""
        SELECT s.id, s.semester, s.division, s.academic_year, u.name
        FROM students s JOIN users u ON u.id = s.user_id
        WHERE s.user_id = %s
    """, (user_id,))
    return cursor.fetchone()


# ============================================================
# TIMETABLE (read-only) — only Admin can add/edit/delete.
# The timetable stores division as a comma-separated value (combined lecture: "A,B"),
# so we match with FIND_IN_SET, not "=".
# ============================================================
_DAY_INDEX = {'Mon': 0, 'Tue': 1, 'Wed': 2, 'Thu': 3, 'Fri': 4, 'Sat': 5}


def _mark_week_status(cursor, slots, student):
    """The weekly timetable is a plan; for THIS week (Mon-Sat) mark each slot as held / cancelled / holiday,
    so the student can see that a lecture was cancelled (and that they were not absent)."""
    if not slots:
        return
    today = datetime.date.today()
    monday = today - datetime.timedelta(days=today.weekday())
    # this week's holidays + cancellations: 2 queries (instead of one per day and one per slot)
    cal = SessionCalendar(cursor, monday, monday + datetime.timedelta(days=6), [sl['id'] for sl in slots])
    for sl in slots:
        idx = _DAY_INDEX.get(sl['day_of_week'])
        if idx is None:
            sl['status'], sl['status_note'], sl['date'] = 'held', None, None
            continue
        d = monday + datetime.timedelta(days=idx)
        holiday = cal.holiday(d, student['semester'], student['division'])
        cancelled = None if holiday else cal.cancelled(sl['id'], d)
        sl['date'] = d.isoformat()
        sl['status'] = 'holiday' if holiday else ('cancelled' if cancelled else 'held')
        sl['status_note'] = holiday['name'] if holiday else (cancelled['reason'] if cancelled else None)


@app.route('/api/student/timetable', methods=['GET'])
@student_required
def get_student_timetable():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404

        info = {
            "name": student['name'],
            "semester": student['semester'],
            "division": student['division'],
            "academic_year": student['academic_year']
        }
        if not student['semester'] or not student['division']:
            return jsonify({"student": info, "slots": []}), 200

        cursor.execute("""
            SELECT t.id, t.day_of_week, t.room_no, t.session_type,
                   TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(t.end_time, '%H:%i') AS end_time,
                   sub.subject_name, sub.subject_code,
                   u.name AS faculty_name, f.short_name AS faculty_short_name
            FROM timetable t
            LEFT JOIN subjects sub ON sub.id = t.subject_id
            LEFT JOIN faculty f ON f.id = t.faculty_id
            LEFT JOIN users u ON u.id = f.user_id
            WHERE t.semester = %s
              AND FIND_IN_SET(%s, t.division) > 0
              AND (t.academic_year = %s OR t.academic_year IS NULL OR t.academic_year = '')
            ORDER BY FIELD(t.day_of_week, 'Mon','Tue','Wed','Thu','Fri','Sat'), t.start_time
        """, (student['semester'], student['division'], student['academic_year']))
        slots = cursor.fetchall()
        _mark_week_status(cursor, slots, student)
        return jsonify({"student": info, "slots": slots}), 200
    except Exception as e:
        return jsonify({"message": "Timetable could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


UPCOMING_WINDOW_DAYS = 30


@app.route('/api/student/upcoming-changes', methods=['GET'])
@student_required
def get_student_upcoming_changes():
    """Cancelled lectures/labs and holidays of the student's class for the next 30 days (today included),
    so a faculty leave / holiday known in advance is visible in advance."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404
        if not student['semester'] or not student['division']:
            return jsonify({"changes": []}), 200

        cursor.execute("""
            SELECT t.id, t.day_of_week, t.session_type,
                   TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(t.end_time, '%H:%i') AS end_time,
                   sub.subject_name
            FROM timetable t
            LEFT JOIN subjects sub ON sub.id = t.subject_id
            WHERE t.semester = %s AND FIND_IN_SET(%s, t.division) > 0
              AND (t.academic_year = %s OR t.academic_year IS NULL OR t.academic_year = '')
        """, (student['semester'], student['division'], student['academic_year']))
        slots = cursor.fetchall()
        if not slots:
            return jsonify({"changes": []}), 200

        today = datetime.date.today()
        end = today + datetime.timedelta(days=UPCOMING_WINDOW_DAYS)

        # 2 bulk queries instead of one per day/slot
        cursor.execute("""
            SELECT holiday_date, name FROM holidays
            WHERE holiday_date BETWEEN %s AND %s
              AND (semester IS NULL OR semester = %s)
              AND (division IS NULL OR division = '' OR division = %s)
        """, (today, end, student['semester'], student['division']))
        holidays = {row['holiday_date']: row['name'] for row in cursor.fetchall()}

        slot_ids = [s['id'] for s in slots]
        ph = ','.join(['%s'] * len(slot_ids))
        cursor.execute(f"""
            SELECT timetable_id, session_date, reason FROM session_overrides
            WHERE status = 'cancelled' AND session_date BETWEEN %s AND %s AND timetable_id IN ({ph})
        """, tuple([today, end] + slot_ids))
        cancelled = {(row['timetable_id'], row['session_date']): row['reason'] for row in cursor.fetchall()}

        day_abbr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        changes = []
        for i in range(UPCOMING_WINDOW_DAYS + 1):
            d = today + datetime.timedelta(days=i)
            day_slots = [s for s in slots if s['day_of_week'] == day_abbr[d.weekday()]]
            if not day_slots:
                continue
            if d in holidays:
                changes.append({"date": d.isoformat(), "day_name": day_abbr[d.weekday()],
                                "status": "holiday", "note": holidays[d]})
                continue
            for sl in sorted(day_slots, key=lambda x: x['start_time']):
                reason = cancelled.get((sl['id'], d))
                if reason is not None:
                    changes.append({"date": d.isoformat(), "day_name": day_abbr[d.weekday()],
                                    "status": "cancelled", "note": reason,
                                    "subject_name": sl['subject_name'], "session_type": sl['session_type'],
                                    "start_time": sl['start_time'], "end_time": sl['end_time']})
        return jsonify({"changes": changes}), 200
    except Exception as e:
        return jsonify({"message": "Upcoming changes could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/student/exam-timetable', methods=['GET'])
@student_required
def get_student_exam_timetable():
    """Mid-Sem + Remedial both — only for this student's semester / division / batch."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404
        if not student['semester']:
            return jsonify({"exams": []}), 200

        cursor.execute("""
            SELECT e.id, e.exam_type, e.room_no,
                   DATE_FORMAT(e.exam_date, '%Y-%m-%d') AS exam_date,
                   TIME_FORMAT(e.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(e.end_time, '%H:%i') AS end_time,
                   sub.subject_name, sub.subject_code
            FROM exam_timetable e
            LEFT JOIN subjects sub ON sub.id = e.subject_id
            WHERE e.semester = %s
              AND (e.division IS NULL OR e.division = '' OR FIND_IN_SET(%s, e.division) > 0)
              AND (e.academic_year = %s OR e.academic_year IS NULL OR e.academic_year = '')
            ORDER BY e.exam_date, e.start_time
        """, (student['semester'], student['division'], student['academic_year']))
        return jsonify({"exams": cursor.fetchall()}), 200
    except Exception as e:
        return jsonify({"message": "Exam timetable could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

# ============================================================
# NOTES / STUDY MATERIALS (read-only — uploaded by Admin or Faculty;
# the `notes` table is shared between both panels. A student can only
# view/download materials for their own semester + division + batch.)
# ============================================================
@app.route('/api/student/materials', methods=['GET'])
@student_required
def get_student_materials():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404
        if not student['semester']:
            return jsonify({"materials": []}), 200

        cursor.execute("""
            SELECT
                n.id, n.title, n.description, n.file_name, n.file_size, n.file_type, n.uploaded_at,
                sub.subject_name, sub.subject_code,
                CASE WHEN n.faculty_id IS NULL THEN 'Admin' ELSE u.name END AS uploaded_by
            FROM notes n
            LEFT JOIN subjects sub ON sub.id = n.subject_id
            LEFT JOIN faculty f ON f.id = n.faculty_id
            LEFT JOIN users u ON u.id = f.user_id
            WHERE n.semester = %s
              AND (n.division IS NULL OR n.division = '' OR FIND_IN_SET(%s, n.division) > 0)
              AND (n.academic_year = %s OR n.academic_year IS NULL OR n.academic_year = '')
            ORDER BY n.uploaded_at DESC
        """, (student['semester'], student['division'], student['academic_year']))
        return jsonify({"materials": cursor.fetchall()}), 200
    except Exception as e:
        return jsonify({"message": "Materials could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/student/materials/<int:note_id>/download', methods=['GET'])
@student_required
def download_student_material(note_id):
    """Download is allowed only if this material belongs to the student's own semester/division/batch
    — a note ID of another class cannot be guessed to download it."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404

        cursor.execute("""
            SELECT file_path, file_name, semester, division, academic_year
            FROM notes WHERE id = %s
        """, (note_id,))
        note = cursor.fetchone()
        if not note:
            return jsonify({"message": "Material not found"}), 404

        division_ok = not note['division'] or student['division'] in note['division'].split(',')
        year_ok = not note['academic_year'] or note['academic_year'] == student['academic_year']
        if str(note['semester']) != str(student['semester']) or not division_ok or not year_ok:
            return jsonify({"message": "This material is not available for your class"}), 403
    finally:
        cursor.close()
        conn.close()

    return send_from_directory(
        NOTES_UPLOAD_FOLDER,
        note['file_path'],
        as_attachment=True,
        download_name=note['file_name']
    )


# ============================================================
# ASSIGNMENTS (a student sees their own class's assignments, downloads the
# problem statement, and submits/replaces their solution file.
# The `assignments` + `assignment_submissions` tables are shared with Admin/Faculty.)
# ============================================================
def _get_student_assignment(cursor, student, assignment_id):
    """Returns the assignment only if it belongs to this student's own semester/division/batch."""
    cursor.execute("SELECT * FROM assignments WHERE id = %s", (assignment_id,))
    assignment = cursor.fetchone()
    if not assignment:
        return None
    if str(assignment['semester']) != str(student['semester']):
        return None
    if assignment['division'] and student['division'] not in assignment['division'].split(','):
        return None
    if assignment['academic_year'] and assignment['academic_year'] != student['academic_year']:
        return None
    return assignment


@app.route('/api/student/assignments', methods=['GET'])
@student_required
def get_student_assignments():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404
        if not student['semester']:
            return jsonify({"assignments": []}), 200

        cursor.execute("""
            SELECT
                a.id, a.title, a.description, DATE_FORMAT(a.due_date, '%Y-%m-%d') AS due_date,
                a.file_name AS problem_file_name,
                sub.subject_name, sub.subject_code,
                asub.id AS submission_id, DATE_FORMAT(asub.submitted_at, '%Y-%m-%d') AS submitted_at,
                asub.marks_obtained
            FROM assignments a
            LEFT JOIN subjects sub ON sub.id = a.subject_id
            LEFT JOIN assignment_submissions asub ON asub.assignment_id = a.id AND asub.student_id = %s
            WHERE a.semester = %s
              AND (a.division IS NULL OR a.division = '' OR FIND_IN_SET(%s, a.division) > 0)
              AND (a.academic_year = %s OR a.academic_year IS NULL OR a.academic_year = '')
            ORDER BY a.due_date ASC
        """, (student['id'], student['semester'], student['division'], student['academic_year']))
        return jsonify({"assignments": cursor.fetchall()}), 200
    except Exception as e:
        return jsonify({"message": "Assignments could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# ATTENDANCE (read-only) — only Admin/Faculty mark it in the `attendance` table
# (the same percentage logic as admin_routes.get_attendance_summary and
# faculty_routes.get_faculty_students is used here for the single
# logged-in student.)
# ============================================================
@app.route('/api/student/attendance', methods=['GET'])
@student_required
def get_student_attendance():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404
        if not student['semester']:
            return jsonify({"subjects": [], "overall_percentage": 0}), 200

        min_pct = get_attendance_min(cursor)
        cursor.execute("""
            SELECT
                sub.id AS subject_id, sub.subject_name, sub.subject_code,
                COUNT(a.id) AS total_classes,
                SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS attended_classes
            FROM subjects sub
            LEFT JOIN attendance a ON a.subject_id = sub.id AND a.student_id = %s
            WHERE sub.semester = %s
              AND (sub.academic_year = %s OR sub.academic_year IS NULL OR sub.academic_year = '')
            GROUP BY sub.id, sub.subject_name, sub.subject_code
            ORDER BY sub.subject_name ASC
        """, (student['id'], student['semester'], student['academic_year']))
        subjects = cursor.fetchall()

        total_classes = 0
        total_attended = 0
        for row in subjects:
            row['total_classes'] = int(row['total_classes'] or 0)
            row['attended_classes'] = int(row['attended_classes'] or 0)   # SUM() comes back as Decimal (JSON would make it a string)
            row['percentage'] = round(row['attended_classes'] * 100 / row['total_classes']) if row['total_classes'] else 0
            row['percentage_exact'] = round(row['attended_classes'] * 100 / row['total_classes'], 1) if row['total_classes'] else 0
            # shortage info: exact (no rounding); 'alert' only once enough classes were held to judge
            row['short'] = attendance_is_short(row['attended_classes'], row['total_classes'], min_pct)
            row['alert'] = row['short'] and row['total_classes'] >= ATTENDANCE_ALERT_MIN_CLASSES
            row['need_more'] = attendance_need_more(row['attended_classes'], row['total_classes'], min_pct)
            row['can_miss'] = attendance_can_miss(row['attended_classes'], row['total_classes'], min_pct)
            total_classes += row['total_classes']
            total_attended += row['attended_classes']

        overall_percentage = round(total_attended * 100 / total_classes) if total_classes else 0

        return jsonify({
            "subjects": subjects,
            "overall_percentage": overall_percentage,
            "min_percentage": min_pct,
            "shortage_count": sum(1 for s in subjects if s['alert'])
        }), 200
    except Exception as e:
        return jsonify({"message": "Attendance could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/student/assignments/<int:assignment_id>/download', methods=['GET'])
@student_required
def download_student_assignment(assignment_id):
    """Downloads the assignment's problem statement (question paper)."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404

        assignment = _get_student_assignment(cursor, student, assignment_id)
        if not assignment:
            return jsonify({"message": "Assignment not found"}), 404
        if not assignment['file_path']:
            return jsonify({"message": "No file was attached to this assignment"}), 404
    finally:
        cursor.close()
        conn.close()

    return send_from_directory(
        ASSIGNMENT_UPLOAD_FOLDER,
        assignment['file_path'],
        as_attachment=True,
        download_name=assignment['file_name']
    )


@app.route('/api/student/assignments/<int:assignment_id>/submit', methods=['POST'])
@student_required
def submit_student_assignment(assignment_id):
    """multipart/form-data: file. The first submission creates a new record;
    submitting again (replace) saves the new file and removes the old one from disk,
    and marks_obtained is reset (a new submission invalidates the earlier grading)."""
    file = request.files.get('file')
    if not file or file.filename == '':
        return jsonify({"message": "A file is required"}), 400
    if not _allowed_assignment_file(file):
        return jsonify({"message": "Invalid file format. Only valid PDF, DOC, DOCX, PPT, PPTX files are allowed"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404

        assignment = _get_student_assignment(cursor, student, assignment_id)
        if not assignment:
            return jsonify({"message": "Assignment not found"}), 404

        cursor.execute(
            "SELECT id, file_path FROM assignment_submissions WHERE assignment_id = %s AND student_id = %s",
            (assignment_id, student['id'])
        )
        existing = cursor.fetchone()

        original_name = secure_filename(file.filename)
        file_ext = original_name.rsplit('.', 1)[1].lower()
        unique_name = f"{uuid.uuid4().hex}.{file_ext}"
        save_path = os.path.join(ASSIGNMENT_UPLOAD_FOLDER, unique_name)
        file.save(save_path)
        file_size = os.path.getsize(save_path)

        old_file_path = existing['file_path'] if existing else None

        if existing:
            cursor.execute("""
                UPDATE assignment_submissions
                SET file_path=%s, file_name=%s, file_size=%s, file_type=%s,
                    submitted_at=NOW(), marks_obtained=NULL
                WHERE id=%s
            """, (unique_name, original_name, file_size, file_ext, existing['id']))
        else:
            cursor.execute("""
                INSERT INTO assignment_submissions
                    (assignment_id, student_id, file_path, file_name, file_size, file_type, submitted_at)
                VALUES (%s,%s,%s,%s,%s,%s,NOW())
            """, (assignment_id, student['id'], unique_name, original_name, file_size, file_ext))
        conn.commit()

        if old_file_path:
            old_full_path = os.path.join(ASSIGNMENT_UPLOAD_FOLDER, old_file_path)
            if os.path.exists(old_full_path):
                os.remove(old_full_path)   # on replace, don't leave the old file orphaned on disk

        return jsonify({"message": "Assignment submitted"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Submission failed", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# RESULTS (read-only) — Faculty enters marks -> Admin approves
# -> Admin publishes (marks_requests + marks tables, the workflow
# already built in admin_routes.py/faculty_routes.py). A student
# only ever sees marks with `marks.published = TRUE`, never unpublished ones.
# The exam_type values are the same 4 as on Faculty's Marks Entry screen:
# Mid-Semester, Remedial, Internal, Practical.
# ============================================================
EXAM_TYPES = ['Mid-Semester', 'Remedial', 'Internal', 'Practical']
DEFAULT_PASSING_PERCENTAGE = 40


def _get_passing_percentage(cursor):
    """Admin can add/change the 'passing_percentage' key in system_settings later
    (like college_name/hod_name already there); if it is missing, the default 40% is used."""
    cursor.execute("SELECT setting_value FROM system_settings WHERE setting_key = 'passing_percentage'")
    row = cursor.fetchone()
    try:
        return float(row['setting_value']) if row and row['setting_value'] else DEFAULT_PASSING_PERCENTAGE
    except (TypeError, ValueError):
        return DEFAULT_PASSING_PERCENTAGE


@app.route('/api/student/results', methods=['GET'])
@student_required
def get_student_results():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404
        if not student['semester']:
            return jsonify({"subjects": [], "passing_percentage": DEFAULT_PASSING_PERCENTAGE, "mid_sem_percentage": None}), 200

        passing_percentage = _get_passing_percentage(cursor)

        cursor.execute("""
            SELECT
                sub.id AS subject_id, sub.subject_name, sub.subject_code,
                m.exam_type, m.marks_obtained, m.max_marks
            FROM subjects sub
            LEFT JOIN marks m
                ON m.subject_id = sub.id AND m.student_id = %s AND m.published = TRUE
            WHERE sub.semester = %s
              AND (sub.academic_year = %s OR sub.academic_year IS NULL OR sub.academic_year = '')
            ORDER BY sub.subject_name ASC
        """, (student['id'], student['semester'], student['academic_year']))
        rows = cursor.fetchall()

        # Pivot: one row per subject, one column per exam_type (same as Admin's Student Report)
        subjects = {}
        for r in rows:
            sid = r['subject_id']
            if sid not in subjects:
                subjects[sid] = {
                    "subject_id": sid,
                    "subject_name": r['subject_name'],
                    "subject_code": r['subject_code'],
                    "exams": {et: None for et in EXAM_TYPES},
                    "total_obtained": 0.0,
                    "total_max": 0.0
                }
            if r['exam_type'] in EXAM_TYPES and r['marks_obtained'] is not None:
                obtained = float(r['marks_obtained'])
                max_marks = float(r['max_marks'])
                subjects[sid]['exams'][r['exam_type']] = {"marks_obtained": obtained, "max_marks": max_marks}
                subjects[sid]['total_obtained'] += obtained
                subjects[sid]['total_max'] += max_marks

        result_list = []
        mid_obtained_sum = 0.0
        mid_max_sum = 0.0
        for s in subjects.values():
            has_published = s['total_max'] > 0
            percentage = round(s['total_obtained'] * 100 / s['total_max']) if has_published else None
            if not has_published:
                status = 'Not published yet'
            elif percentage >= passing_percentage:
                status = 'Pass'
            else:
                status = 'Fail'
            result_list.append({
                "subject_id": s['subject_id'],
                "subject_name": s['subject_name'],
                "subject_code": s['subject_code'],
                "exams": s['exams'],
                "percentage": percentage,
                "status": status
            })
            mid = s['exams']['Mid-Semester']
            if mid:
                mid_obtained_sum += mid['marks_obtained']
                mid_max_sum += mid['max_marks']

        mid_sem_percentage = round(mid_obtained_sum * 100 / mid_max_sum) if mid_max_sum else None

        return jsonify({
            "subjects": result_list,
            "passing_percentage": passing_percentage,
            "mid_sem_percentage": mid_sem_percentage
        }), 200
    except Exception as e:
        return jsonify({"message": "Results could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# NOTICES (read-only) — only Admin/Faculty post/edit/pin/
# delete notices (`notices` + `notice_reads` tables, same pattern as
# Faculty's get_faculty_notices/mark-read). A student sees only the
# broadcast notices for their own class (semester/division/academic_year)
# plus their own personal notices (target_user_id).
# ============================================================
def _student_notice_filter_sql(select_extra=''):
    """A single WHERE condition — reused by list / unread-count / mark-read,
    so the logic of 'which notices this student can see' always matches in all three places."""
    return """
        (
            (n.target_role IN ('all','student') AND n.target_user_id IS NULL
             AND (n.semester IS NULL OR n.semester = %s)
             AND (n.division IS NULL OR n.division = %s)
             AND (n.academic_year IS NULL OR n.academic_year = %s))
            OR n.target_user_id = %s
        )
    """


@app.route('/api/student/notices', methods=['GET'])
@student_required
def get_student_notices():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        student = _get_student(cursor, user_id)
        if not student:
            return jsonify({"message": "Student record not found"}), 404

        cursor.execute(f"""
            SELECT n.id, n.title, n.content, n.category, n.is_pinned, n.created_at,
                   n.file_name, n.file_size, n.file_type, n.target_user_id,
                   n.semester, n.division,
                   u.name AS posted_by_name, u.role AS posted_by_role,
                   EXISTS(
                       SELECT 1 FROM notice_reads nr WHERE nr.notice_id = n.id AND nr.user_id = %s
                   ) AS is_read
            FROM notices n
            LEFT JOIN users u ON u.id = n.posted_by
            WHERE {_student_notice_filter_sql()}
            ORDER BY n.is_pinned DESC, n.created_at DESC
            LIMIT 50
        """, (user_id, student['semester'], student['division'], student['academic_year'], user_id))
        notices = cursor.fetchall()
        for n in notices:
            n['is_personal'] = n['target_user_id'] is not None
            n['is_read'] = bool(n['is_read'])
            del n['target_user_id']
        return jsonify({"notices": notices}), 200
    except Exception as e:
        return jsonify({"message": "Notices could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/student/notices/unread-count', methods=['GET'])
@student_required
def get_student_notices_unread_count():
    """For the sidebar 'Notices' badge — how many visible notices have not been seen yet."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        student = _get_student(cursor, user_id)
        if not student:
            return jsonify({"unread_count": 0}), 200

        cursor.execute(f"""
            SELECT COUNT(*) AS unread_count
            FROM notices n
            WHERE {_student_notice_filter_sql()}
              AND NOT EXISTS (
                  SELECT 1 FROM notice_reads nr WHERE nr.notice_id = n.id AND nr.user_id = %s
              )
        """, (student['semester'], student['division'], student['academic_year'], user_id, user_id))
        return jsonify({"unread_count": cursor.fetchone()['unread_count']}), 200
    except Exception as e:
        return jsonify({"message": "Unread count could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/student/notices/mark-read', methods=['POST'])
@student_required
def mark_student_notices_read():
    """Called as soon as the Notices tab opens — marks every notice visible to this student
    as 'seen', so the sidebar badge disappears."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        student = _get_student(cursor, user_id)
        if not student:
            return jsonify({"message": "Student record not found"}), 404

        cursor.execute(f"""
            INSERT IGNORE INTO notice_reads (notice_id, user_id)
            SELECT n.id, %s
            FROM notices n
            WHERE {_student_notice_filter_sql()}
        """, (user_id, student['semester'], student['division'], student['academic_year'], user_id))
        conn.commit()
        return jsonify({"message": "Marked as read"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Failed to mark as read", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/student/notices/<int:notice_id>/download', methods=['GET'])
@student_required
def download_student_notice(notice_id):
    """Downloads a notice's attachment — only if this notice is also
    visible to this student (their own class/personal); a file ID of
    someone else's notice cannot be guessed to download it."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        student = _get_student(cursor, user_id)
        if not student:
            return jsonify({"message": "Student record not found"}), 404

        cursor.execute("""
            SELECT file_path, file_name, target_role, target_user_id, semester, division, academic_year
            FROM notices WHERE id = %s
        """, (notice_id,))
        notice = cursor.fetchone()
        if not notice:
            return jsonify({"message": "Notice not found"}), 404
        if not notice['file_path']:
            return jsonify({"message": "No attachment was added to this notice"}), 404

        is_personal_match = notice['target_user_id'] == user_id
        is_broadcast_match = (
            notice['target_user_id'] is None
            and notice['target_role'] in ('all', 'student')
            and (notice['semester'] is None or str(notice['semester']) == str(student['semester']))
            and (notice['division'] is None or notice['division'] == student['division'])
            and (notice['academic_year'] is None or notice['academic_year'] == student['academic_year'])
        )
        if not is_personal_match and not is_broadcast_match:
            return jsonify({"message": "This notice is not available for you"}), 403
    finally:
        cursor.close()
        conn.close()

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
# FACULTY DIRECTORY (read-only) — shows only the faculty who teach
# subjects of this student's own semester/division/academic_year
# (`faculty_subjects` table, the same join as Admin's get_faculty).
# Not every faculty member of the whole college.
# ============================================================
@app.route('/api/student/faculty', methods=['GET'])
@student_required
def get_student_faculty():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404
        if not student['semester']:
            return jsonify({"faculty": []}), 200

        cursor.execute("""
            SELECT
                f.id AS faculty_id, u.name, f.short_name, f.email, f.department, f.whatsapp_number,
                GROUP_CONCAT(DISTINCT sub.subject_name ORDER BY sub.subject_name SEPARATOR ', ') AS subjects_taught
            FROM faculty_subjects fs
            JOIN faculty f ON f.id = fs.faculty_id
            JOIN users u ON u.id = f.user_id
            JOIN subjects sub ON sub.id = fs.subject_id
            WHERE fs.semester = %s
              AND (fs.division IS NULL OR fs.division = %s)
              AND (fs.academic_year IS NULL OR fs.academic_year = %s)
            GROUP BY f.id, u.name, f.short_name, f.email, f.department, f.whatsapp_number
            ORDER BY u.name ASC
        """, (student['semester'], student['division'], student['academic_year']))
        return jsonify({"faculty": cursor.fetchall()}), 200
    except Exception as e:
        return jsonify({"message": "Faculty directory could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# FEES (read-only) — status/amount/due-date/payment-link are set only by
# Admin; Faculty only toggles paid/unpaid.
# A student sees their full fee history (not limited to the current
# semester — older pending dues show up here too).
# ============================================================
@app.route('/api/student/fees', methods=['GET'])
@student_required
def get_student_fees():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"message": "Student record not found"}), 404

        cursor.execute("""
            SELECT
                f.id AS fee_id,
                f.fee_title,
                f.amount,
                DATE_FORMAT(f.due_date, '%Y-%m-%d') AS due_date,
                f.semester,
                f.academic_year,
                f.status,
                f.payment_link
            FROM fees f
            WHERE f.student_id = %s
            ORDER BY f.academic_year DESC, f.semester DESC, f.fee_title
        """, (student['id'],))
        rows = cursor.fetchall()
        for r in rows:
            r['amount'] = float(r['amount']) if r['amount'] is not None else None

        return jsonify({"fees": rows}), 200
    except Exception as e:
        return jsonify({"message": "Fees could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# ASK STUDENTHUB — a lightweight data-driven assistant (no external AI).
# The dashboard card and the floating chat popup both call this endpoint.
# It recognises the question by keyword and answers directly from the DB with this student's own real data —
# supported: "attendance %", "pending assignments", "fees due", "today's timetable", "notices".
# ============================================================
@app.route('/api/student/assistant', methods=['POST'])
@student_required
@logged_assistant
def student_assistant():
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

        student = _get_student(cursor, request.user['user_id'])
        if not student:
            return jsonify({"reply": "Student record not found."}), 200
        if not student['semester']:
            return jsonify({"reply": "Your semester/division hasn't been set up yet — contact admin."}), 200

        # ---- Attendance % ----
        if 'attendance' in message:
            cursor.execute("""
                SELECT sub.subject_name,
                       COUNT(a.id) AS total_classes,
                       SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS attended_classes
                FROM subjects sub
                LEFT JOIN attendance a ON a.subject_id = sub.id AND a.student_id = %s
                WHERE sub.semester = %s
                  AND (sub.academic_year = %s OR sub.academic_year IS NULL OR sub.academic_year = '')
                GROUP BY sub.id, sub.subject_name
                ORDER BY sub.subject_name ASC
            """, (student['id'], student['semester'], student['academic_year']))
            rows = cursor.fetchall()
            total, attended, lines = 0, 0, []
            for r in rows:
                tc = r['total_classes'] or 0
                ac = r['attended_classes'] or 0
                pct = round(ac * 100 / tc) if tc else 0
                total += tc
                attended += ac
                lines.append(f"• {r['subject_name']}: {pct}%")
            overall = round(attended * 100 / total) if total else 0
            reply = (f"Your overall attendance is {overall}%.\n" + "\n".join(lines)) if lines \
                else "No attendance has been marked for you yet."
            return jsonify({"reply": reply}), 200

        # ---- Pending assignments ----
        if 'assignment' in message or 'pending' in message or 'submission' in message:
            cursor.execute("""
                SELECT a.title, DATE_FORMAT(a.due_date, '%Y-%m-%d') AS due_date, sub.subject_name
                FROM assignments a
                LEFT JOIN subjects sub ON sub.id = a.subject_id
                LEFT JOIN assignment_submissions asub ON asub.assignment_id = a.id AND asub.student_id = %s
                WHERE a.semester = %s
                  AND (a.division IS NULL OR a.division = '' OR FIND_IN_SET(%s, a.division) > 0)
                  AND (a.academic_year = %s OR a.academic_year IS NULL OR a.academic_year = '')
                  AND asub.id IS NULL
                ORDER BY a.due_date ASC
            """, (student['id'], student['semester'], student['division'], student['academic_year']))
            rows = cursor.fetchall()
            lines = [f"• {r['title']} ({r['subject_name']}) — due {r['due_date']}" for r in rows]
            reply = ("Pending assignments:\n" + "\n".join(lines[:10])) if lines \
                else "You're all caught up — no pending assignments 👍"
            return jsonify({"reply": reply}), 200

        # ---- Fees due ----
        if 'fee' in message:
            cursor.execute("""
                SELECT fee_title, amount, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date
                FROM fees WHERE student_id = %s AND status != 'paid'
                ORDER BY due_date ASC
            """, (student['id'],))
            rows = cursor.fetchall()
            lines = [f"• {r['fee_title']}: ₹{r['amount']} (due {r['due_date']})" for r in rows]
            reply = ("Fees pending:\n" + "\n".join(lines)) if lines else "No fees pending — you're all paid up 👍"
            return jsonify({"reply": reply}), 200

        # ---- Today's timetable ----
        if 'timetable' in message or 'today' in message or 'class' in message:
            today_abbr = datetime.datetime.now().strftime('%a')[:3]
            cursor.execute("""
                SELECT t.id, TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
                       TIME_FORMAT(t.end_time, '%H:%i') AS end_time,
                       sub.subject_name, t.room_no
                FROM timetable t
                LEFT JOIN subjects sub ON sub.id = t.subject_id
                WHERE t.semester = %s AND FIND_IN_SET(%s, t.division) > 0
                  AND (t.academic_year = %s OR t.academic_year IS NULL OR t.academic_year = '')
                  AND t.day_of_week = %s
                ORDER BY t.start_time
            """, (student['semester'], student['division'], student['academic_year'], today_abbr))
            rows = cursor.fetchall()
            today_date = datetime.date.today()
            today_holiday = get_holiday(cursor, today_date, student['semester'], student['division'])
            lines = []
            for r in rows:
                line = f"• {r['start_time']}–{r['end_time']} {r['subject_name']} (Room {r['room_no']})"
                if today_holiday:
                    line += f" — Holiday ({today_holiday['name']})"
                else:
                    canc = get_cancelled_override(cursor, r['id'], today_date)
                    if canc:
                        line += f" — CANCELLED ({canc['reason']})"
                lines.append(line)
            reply = ("Today's timetable:\n" + "\n".join(lines)) if lines else "No classes scheduled for you today."
            return jsonify({"reply": reply}), 200

        # ---- Notices ----
        if 'notice' in message:
            cursor.execute(f"""
                SELECT n.title FROM notices n
                WHERE {_student_notice_filter_sql()}
                ORDER BY n.is_pinned DESC, n.created_at DESC LIMIT 5
            """, (student['semester'], student['division'], student['academic_year'], request.user['user_id']))
            rows = cursor.fetchall()
            lines = [f"• {r['title']}" for r in rows]
            reply = ("Latest notices:\n" + "\n".join(lines)) if lines else "No notices right now."
            return jsonify({"reply": reply}), 200

        help_text = ("I can currently answer these kinds of questions: \"attendance %\", "
                     "\"pending assignments\", \"fees due\", \"today's timetable\", or \"notices\".")
        reply = get_fallback_reply(cursor, message, request.user['user_id'], 'student', help_text)
        return jsonify({"reply": reply}), 200
    except Exception as e:
        return jsonify({"reply": "Something went wrong, please try again."}), 200
    finally:
        cursor.close()
        conn.close()


# ============================================================
# Student Settings — profile (name + mobile) + change password.
# Enrollment, email, semester, division, academic_year, department
# stay Admin-controlled — student can't edit those from here.
# ============================================================
@app.route('/api/student/profile', methods=['GET'])
@student_required
def get_student_profile():
    user_id = request.user['user_id']
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("""
        SELECT u.name, u.login_id AS enrollment, s.email, s.mobile, s.whatsapp_number,
               s.semester, s.division, s.academic_year, s.department
        FROM users u JOIN students s ON s.user_id = u.id
        WHERE u.id = %s
    """, (user_id,))
    profile = cursor.fetchone()
    cursor.close()
    conn.close()
    if not profile:
        return jsonify({"message": "Profile not found"}), 404
    return jsonify(profile), 200


@app.route('/api/student/profile', methods=['PUT'])
@student_required
def update_student_profile():
    """A student can edit their own full name + mobile number + WhatsApp number — enrollment/email/
    semester/division/batch/department stay under Admin's control."""
    data = request.get_json() or {}
    name = data.get('name')
    mobile = data.get('mobile')
    whatsapp_number = data.get('whatsapp_number')

    if not name or not name.strip():
        return jsonify({"message": "Name cannot be empty"}), 400
    if mobile and (not mobile.isdigit() or len(mobile) != 10):
        return jsonify({"message": "Mobile number must be 10 digits"}), 400
    if whatsapp_number and (not whatsapp_number.isdigit() or not (10 <= len(whatsapp_number) <= 15)):
        return jsonify({"message": "WhatsApp number must be 10-15 digits (with country code if needed)"}), 400

    user_id = request.user['user_id']
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET name = %s WHERE id = %s", (name.strip(), user_id))
    cursor.execute(
        "UPDATE students SET mobile = %s, whatsapp_number = %s WHERE user_id = %s",
        (mobile.strip() if mobile else None, whatsapp_number.strip() if whatsapp_number else None, user_id)
    )
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"message": "Profile updated"}), 200


@app.route('/api/student/change-password', methods=['PUT'])
@student_required
def student_change_password():
    data = request.get_json() or {}
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



@app.route('/api/student/chat-history', methods=['GET'])
@student_required
def student_chat_history():
    """This user's own previous chat with the assistant (last 50 exchanges)."""
    return jsonify(get_user_chat_history(request.user['user_id'])), 200