from flask import request, jsonify, send_from_directory
import os
import uuid
import bcrypt
import datetime
from werkzeug.utils import secure_filename

from db import get_db
from app import app
from auth_middleware import student_required
from admin_routes import NOTES_UPLOAD_FOLDER, ASSIGNMENT_UPLOAD_FOLDER, _allowed_assignment_file, NOTICE_UPLOAD_FOLDER


def _get_student(cursor, user_id):
    """Logged-in student ki apni semester / division / batch — timetable isi se filter hoti hai."""
    cursor.execute("""
        SELECT s.id, s.semester, s.division, s.academic_year, u.name
        FROM students s JOIN users u ON u.id = s.user_id
        WHERE s.user_id = %s
    """, (user_id,))
    return cursor.fetchone()


# ============================================================
# TIMETABLE (read-only) — Add/Edit/Delete sirf Admin karta hai.
# Timetable me division comma se save hoti hai (combined lecture: "A,B"),
# isliye FIND_IN_SET se match karte hain, "=" se nahi.
# ============================================================
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
            SELECT t.id, t.day_of_week, t.room_no,
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
        return jsonify({"student": info, "slots": cursor.fetchall()}), 200
    except Exception as e:
        return jsonify({"message": "Timetable could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/student/exam-timetable', methods=['GET'])
@student_required
def get_student_exam_timetable():
    """Mid-Sem + Remedial dono — sirf is student ki semester / division / batch ke."""
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
# NOTES / STUDY MATERIALS (read-only — Admin ya Faculty upload karte hain,
# `notes` table hi dono panels ke saath shared hai. Student sirf apni
# semester + division + batch ke materials dekh/download kar sakta hai.)
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
    """Sirf tabhi download milega jab yeh material student ki apni semester/division/batch ka ho
    — kisi aur class ka note ID guess karke download nahi kiya ja sakta."""
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
# ASSIGNMENTS (student apni class ki assignments dekhta hai, problem statement
# download karta hai, aur apni solution file submit/replace karta hai.
# `assignments` + `assignment_submissions` dono tables Admin/Faculty ke saath shared hain.)
# ============================================================
def _get_student_assignment(cursor, student, assignment_id):
    """Assignment sirf tabhi return karta hai jab woh is student ki apni semester/division/batch ka ho."""
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
# ATTENDANCE (read-only) — Admin/Faculty hi `attendance` table me
# mark karte hain (admin_routes.get_attendance_summary aur
# faculty_routes.get_faculty_students jaisa hi % nikaalne ka logic
# yahan single logged-in student ke liye use hota hai.)
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
            row['total_classes'] = row['total_classes'] or 0
            row['attended_classes'] = row['attended_classes'] or 0
            row['percentage'] = round(row['attended_classes'] * 100 / row['total_classes']) if row['total_classes'] else 0
            total_classes += row['total_classes']
            total_attended += row['attended_classes']

        overall_percentage = round(total_attended * 100 / total_classes) if total_classes else 0

        return jsonify({"subjects": subjects, "overall_percentage": overall_percentage}), 200
    except Exception as e:
        return jsonify({"message": "Attendance could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/student/assignments/<int:assignment_id>/download', methods=['GET'])
@student_required
def download_student_assignment(assignment_id):
    """Assignment ka problem statement (question paper) download karta hai."""
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
    """multipart/form-data: file. Pehli baar submit ho to naya record banta hai,
    dobara submit kare (replace) to purani file disk se hatke nayi save hoti hai aur
    marks_obtained reset ho jaata hai (naya submission = purana grading ab valid nahi)."""
    file = request.files.get('file')
    if not file or file.filename == '':
        return jsonify({"message": "A file is required"}), 400
    if not _allowed_assignment_file(file.filename):
        return jsonify({"message": "Only PDF, DOC, DOCX, PPT, PPTX files are allowed"}), 400

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
                os.remove(old_full_path)   # replace hone par purani file disk pe orphan nahi chodni

        return jsonify({"message": "Assignment submitted"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Submission failed", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# RESULTS (read-only) — Faculty marks bharta hai -> Admin approve
# karta hai -> Admin publish karta hai (marks_requests + marks
# tables, admin_routes.py/faculty_routes.py me already bana hua
# workflow). Student ko sirf `marks.published = TRUE` wale marks
# hi dikhte hain, un-published kabhi nahi.
# exam_type wahi 4 values jo Faculty ki Marks Entry screen me hain:
# Mid-Semester, Remedial, Internal, Practical.
# ============================================================
EXAM_TYPES = ['Mid-Semester', 'Remedial', 'Internal', 'Practical']
DEFAULT_PASSING_PERCENTAGE = 40


def _get_passing_percentage(cursor):
    """system_settings me 'passing_percentage' key admin baad me add/change kar sakta hai
    (jaise college_name/hod_name already hai); na mile to default 40% use hota hai."""
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

        # Pivot: ek subject ka ek row, har exam_type apna column (Admin ke Student Report jaisa)
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
# NOTICES (read-only) — Admin/Faculty hi notices post/edit/pin/
# delete karte hain (`notices` + `notice_reads` tables, Faculty ka
# get_faculty_notices/mark-read jaisa hi pattern). Student sirf
# apni class (semester/division/academic_year) ki broadcast
# notices + apni khud ki personal notices (target_user_id) dekhta hai.
# ============================================================
def _student_notice_filter_sql(select_extra=''):
    """Ek hi WHERE condition — list/unread-count/mark-read teeno me reuse hota hai,
    taaki teeno jagah 'kaunsi notices is student ko dikhti hain' ka logic hamesha match kare."""
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
                   EXISTS(
                       SELECT 1 FROM notice_reads nr WHERE nr.notice_id = n.id AND nr.user_id = %s
                   ) AS is_read
            FROM notices n
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
    """Sidebar ke 'Notices' item ke badge ke liye — kitni notices dikhti hain par abhi tak dekhi nahi."""
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
    """Notices tab khulte hi call hota hai — jitni bhi notices is student ko dikhti hain,
    sabko 'seen' mark kar deta hai, taaki sidebar ka badge hat jaaye."""
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
    """Notice ka attachment download karta hai — sirf tabhi jab yeh notice
    is student ko dikhti bhi ho (apni class/personal), kisi aur ki notice ka
    file ID guess karke download nahi kiya ja sakta."""
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

    return send_from_directory(
        NOTICE_UPLOAD_FOLDER,
        notice['file_path'],
        as_attachment=True,
        download_name=notice['file_name']
    )


# ============================================================
# FACULTY DIRECTORY (read-only) — sirf woh faculty dikhte hain jo
# is student ke apne semester/division/academic_year ke subjects
# padhate hain (`faculty_subjects` table, Admin ke get_faculty
# jaisa hi join). Poore college ke saare faculty nahi.
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
                f.id AS faculty_id, u.name, f.short_name, f.email, f.department,
                GROUP_CONCAT(DISTINCT sub.subject_name ORDER BY sub.subject_name SEPARATOR ', ') AS subjects_taught
            FROM faculty_subjects fs
            JOIN faculty f ON f.id = fs.faculty_id
            JOIN users u ON u.id = f.user_id
            JOIN subjects sub ON sub.id = fs.subject_id
            WHERE fs.semester = %s
              AND (fs.division IS NULL OR fs.division = %s)
              AND (fs.academic_year IS NULL OR fs.academic_year = %s)
            GROUP BY f.id, u.name, f.short_name, f.email, f.department
            ORDER BY u.name ASC
        """, (student['semester'], student['division'], student['academic_year']))
        return jsonify({"faculty": cursor.fetchall()}), 200
    except Exception as e:
        return jsonify({"message": "Faculty directory could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# FEES (read-only) — status/amount/due-date/payment-link sirf
# Admin set karta hai, Faculty sirf paid/unpaid toggle karta hai.
# Student ko apni poori fee history dikhti hai (sirf current
# semester tak limit nahi — purane pending dues bhi yahin aa jaate hain).
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
# ASK STUDENTHUB — halka data-driven assistant (koi external AI nahi).
# Dashboard card + floating chat popup dono isi endpoint ko call karte hain.
# Keyword se sawal pehchan ke seedha DB se is student ka apna real jawab deta hai —
# supported: "attendance %", "pending assignments", "fees due", "today's timetable", "notices".
# ============================================================
@app.route('/api/student/assistant', methods=['POST'])
@student_required
def student_assistant():
    data = request.get_json() or {}
    message = (data.get('message') or '').strip().lower()
    if not message:
        return jsonify({"reply": "Kuch pooch to sahi! 🙂"}), 200

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
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
                SELECT TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
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
            lines = [f"• {r['start_time']}–{r['end_time']} {r['subject_name']} (Room {r['room_no']})" for r in rows]
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

        return jsonify({
            "reply": "I can currently answer these kinds of questions: \"attendance %\", "
                     "\"pending assignments\", \"fees due\", \"today's timetable\", or \"notices\"."
        }), 200
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
        SELECT u.name, u.login_id AS enrollment, s.email, s.mobile,
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
    """Student apna full name + mobile number edit kar sakta hai — enrollment/email/
    semester/division/batch/department Admin ke haath me hi rehte hain."""
    data = request.get_json() or {}
    name = data.get('name')
    mobile = data.get('mobile')

    if not name or not name.strip():
        return jsonify({"message": "Name cannot be empty"}), 400
    if mobile and (not mobile.isdigit() or len(mobile) != 10):
        return jsonify({"message": "Mobile number must be 10 digits"}), 400

    user_id = request.user['user_id']
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET name = %s WHERE id = %s", (name.strip(), user_id))
    cursor.execute(
        "UPDATE students SET mobile = %s WHERE user_id = %s",
        (mobile.strip() if mobile else None, user_id)
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
    cursor.execute("SELECT password_hash FROM users WHERE id = %s", (user_id,))
    user = cursor.fetchone()

    if not user or not bcrypt.checkpw(current_password.encode('utf-8'), user['password_hash'].encode('utf-8')):
        cursor.close()
        conn.close()
        return jsonify({"message": "Current password is incorrect"}), 401

    new_hash = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    cursor.execute("UPDATE users SET password_hash = %s WHERE id = %s", (new_hash, user_id))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"message": "Password updated"}), 200