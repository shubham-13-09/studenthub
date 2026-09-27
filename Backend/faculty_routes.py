from flask import request, jsonify, send_from_directory
from db import get_db
import bcrypt
import os
import uuid
from datetime import datetime
from werkzeug.utils import secure_filename

from app import app
from auth_middleware import faculty_required
from admin_routes import NOTES_UPLOAD_FOLDER, _allowed_note_file, ASSIGNMENT_UPLOAD_FOLDER, _allowed_assignment_file, NOTICE_UPLOAD_FOLDER, _allowed_notice_file, _get_academic_year_for_date_semester


def _get_faculty_id(cursor, user_id):
    """JWT ke user_id (users.id) se faculty.id nikaalta hai."""
    cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (user_id,))
    row = cursor.fetchone()
    return row['id'] if row else None


# ============================================================
# MY SUBJECTS
# ============================================================
@app.route('/api/faculty/my-subjects', methods=['GET'])
@faculty_required
def get_my_subjects():
    """Logged-in faculty ko assign kiye gaye subjects (semester + division + batch ke saath),
    har subject ke liye student count aur average attendance % ke saath.
    Saath me un sabhi semester+batch combos ke real divisions (students table se) bhi bhejta hai,
    taaki "All divisions" wale assignments ke liye bhi division-filter dropdown me asli divisions dikh sakein."""
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

        # Faculty ke assigned semester+batch combos ke real divisions (students table se) — duplicate-free
        sem_year_pairs = {(row['semester'], row['academic_year']) for row in subjects}
        divisions = set()
        for semester, academic_year in sem_year_pairs:
            cursor.execute("""
                SELECT DISTINCT division FROM students
                WHERE semester = %s AND academic_year = %s AND division IS NOT NULL
            """, (semester, academic_year))
            divisions.update(r['division'] for r in cursor.fetchall())

        return jsonify({"subjects": subjects, "divisions": sorted(divisions), "faculty_id": faculty_id}), 200
    except Exception as e:
        return jsonify({"message": "Subjects could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ============================================================
# DASHBOARD (aaj ka summary — subjects, aaj ki lectures, pending attendance, ungraded submissions)
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
            SELECT t.id, t.semester, t.division, t.room_no,
                   TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(t.end_time, '%H:%i') AS end_time,
                   t.subject_id, sub.subject_name,
                   EXISTS (
                       SELECT 1 FROM attendance a
                       WHERE a.faculty_id = %s AND a.subject_id = t.subject_id AND a.attendance_date = CURDATE()
                   ) AS attendance_marked
            FROM timetable t
            JOIN subjects sub ON sub.id = t.subject_id
            WHERE t.faculty_id = %s AND t.day_of_week = %s
            ORDER BY t.start_time
        """, (faculty_id, faculty_id, today_day))
        lectures_today = cursor.fetchall()
        for l in lectures_today:
            l['attendance_marked'] = bool(l['attendance_marked'])

        now_time = datetime.now().strftime('%H:%M')
        lectures_left_today = sum(1 for l in lectures_today if l['end_time'] > now_time)
        attendance_pending_today = sum(1 for l in lectures_today if not l['attendance_marked'] and l['start_time'] <= now_time)

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
# STUDENTS (class list for one assigned subject)
# ============================================================
@app.route('/api/faculty/students', methods=['GET'])
@faculty_required
def get_faculty_students():
    """Query param: assignment_id (faculty_subjects.id, jo /my-subjects response me milta hai).
    Us subject+semester+division+batch ke students, unki is subject me attendance % aur average marks % ke saath.
    assignment_id ko faculty_id se match karke check karte hain ki yeh faculty isi subject ko padhata hai."""
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

        # division NULL matlab is assignment ki koi specific division nahi hai -> us semester+batch ke sabhi students
        # (ya, agar faculty ne upar Division filter se ek specific division chuni hai, to sirf usi division ke students)
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
                (
                    SELECT ROUND(AVG(m.marks_obtained / m.max_marks * 100))
                    FROM marks m
                    WHERE m.student_id = st.id AND m.subject_id = %s
                ) AS avg_marks
            FROM students st
            JOIN users u ON u.id = st.user_id
            WHERE st.semester = %s AND st.academic_year = %s {division_clause}
            ORDER BY u.login_id
        """, (assignment['subject_id'], assignment['subject_id'],
              assignment['semester'], assignment['academic_year']) + division_param)
        students = cursor.fetchall()

        for row in students:
            row['attendance_pct'] = row['attendance_pct'] if row['attendance_pct'] is not None else 0
            row['avg_marks'] = row['avg_marks'] if row['avg_marks'] is not None else 0

        return jsonify({"students": students}), 200
    except Exception as e:
        return jsonify({"message": "Students could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


def _get_faculty_assignment(cursor, faculty_id, assignment_id):
    """assignment_id ko faculty_id se match karke uska subject/semester/division/batch nikaalta hai.
    Yeh check karta hai ki logged-in faculty hi is subject ko padhata hai (kisi aur ka attendance mark na ho)."""
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
    """Query params: assignment_id, date, division (optional — sirf tab use hota hai jab assignment "All divisions" ho,
    upar wale Division filter se aata hai).
    Us subject+semester+division+batch ke students, diye gaye date ka unka status (present/absent/None=not marked) ke saath."""
    assignment_id = request.args.get('assignment_id')
    date = request.args.get('date')
    chosen_division = request.args.get('division') or None
    if not assignment_id or not date:
        return jsonify({"message": "assignment_id and date are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
        if not assignment:
            return jsonify({"message": "This subject is not assigned to you"}), 403

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
                a.status
            FROM students st
            JOIN users u ON u.id = st.user_id
            LEFT JOIN attendance a
                ON a.student_id = st.id AND a.subject_id = %s AND a.attendance_date = %s
            WHERE st.semester = %s AND st.academic_year = %s {division_clause}
            ORDER BY u.login_id
        """, (assignment['subject_id'], date,
              assignment['semester'], assignment['academic_year']) + division_param)
        students = cursor.fetchall()

        return jsonify({
            "subject_id": assignment['subject_id'],
            "students": students
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
    Bulk mark/update — poori class ka ek din ka attendance ek saath save hota hai.
    assignment_id ko faculty_id se match karke check karte hain (koi aur faculty ka subject nahi mark kar sakta)."""
    data = request.get_json() or {}
    assignment_id = data.get('assignment_id')
    date = data.get('date')
    records = data.get('records') or []   # [{student_id, status}]

    if not assignment_id or not date or not records:
        return jsonify({"message": "assignment_id, date and records are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        assignment = _get_faculty_assignment(cursor, faculty_id, assignment_id)
        if not assignment:
            return jsonify({"message": "This subject is not assigned to you"}), 403

        if not _get_academic_year_for_date_semester(cursor, date, assignment['semester']):
            cursor.close()
            conn.close()
            return jsonify({"message": f"This date is outside Sem {assignment['semester']}'s date range — ask Admin to set this semester's start/end date"}), 400

        subject_id = assignment['subject_id']
        for r in records:
            student_id = r.get('student_id')
            status = r.get('status')
            if not student_id or status not in ('present', 'absent'):
                continue
            cursor.execute("""
                INSERT INTO attendance (student_id, subject_id, faculty_id, attendance_date, status)
                VALUES (%s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE status = VALUES(status), faculty_id = VALUES(faculty_id)
            """, (student_id, subject_id, faculty_id, date, status))
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        return jsonify({"message": "Attendance save failed", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Attendance saved"}), 200


# ============================================================
# MARKS ENTRY (request-based workflow)
# Faculty submit karta hai -> PENDING request banta hai
# Admin (admin_routes.py) accept/reject/publish karta hai
# Jab tak koi active request (pending/approved/published) hai, faculty dobara submit nahi kar sakta
# Sirf 'rejected' hone par dobara edit/submit allowed hai
# ============================================================
def _get_latest_marks_request(cursor, faculty_id, subject_id, exam_type, semester, division, academic_year):
    """Is subject+exam+division ki sabse latest request (agar koi ho) — status decide karta hai ki
    faculty abhi edit kar sakta hai ya nahi."""
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
    """Faculty ki apni saari marks requests (har subject/exam), latest status ke saath —
    Marks Entry screen ke top pe 'My Submissions' list ke liye."""
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
    Us subject+semester+division+batch ke students, latest request ka status aur marks (agar ho) ke saath."""
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
        # assignment ki apni division ho to wahi use karo; warna (assignment "All divisions" hai) to
        # upar Division filter se chuni gayi division use karo — Students/Attendance tabs jaisa hi behaviour
        division = assignment['division'] or chosen_division

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
    Naya PENDING request banata hai. Agar is subject+exam ki koi request pehle se pending/approved/published
    hai to reject ho jaata hai — pehle admin ka decision aana chahiye (rejected ke baad hi dobara submit ho sakta hai)."""
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
        # assignment ki apni division ho to wahi use karo; warna (assignment "All divisions" hai) to
        # upar Division filter se chuni gayi division use karo — taaki har division ki request alag se track ho
        division = assignment['division'] or chosen_division
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

        for r in records:
            student_id = r.get('student_id')
            marks_obtained = r.get('marks_obtained')
            if student_id is None or marks_obtained is None or marks_obtained == '':
                continue
            try:
                if float(marks_obtained) > float(max_marks):
                    continue   # max marks se zyada marks ignore karo
            except (TypeError, ValueError):
                continue

            cursor.execute(
                "INSERT INTO marks (student_id, subject_id, exam_type, marks_obtained, max_marks, semester, academic_year, published, request_id) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s, FALSE, %s)",
                (student_id, subject_id, exam_type, marks_obtained, max_marks, semester, academic_year, new_request_id)
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
# FEES ENTRY (faculty ki assigned class ke fee records — sirf status paid/unpaid toggle kar sakte hain;
# fee item banana/edit karna, payment link, due date — sab Admin ke haath me hi rehta hai)
# ============================================================
@app.route('/api/faculty/fees', methods=['GET'])
@faculty_required
def get_faculty_fees():
    """Query params: semester, academic_year, division (optional).
    Sirf woh fee records dikhata hai jo Admin ne pehle se bana rakhe hain us class ke liye —
    agar Admin ne abhi tak us semester+batch ke liye fee setup nahi kiya, toh list khaali aayegi."""
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

        # Faculty isi semester+batch(+division) ko padhata hai ya nahi, check karo
        cursor.execute("""
            SELECT id FROM faculty_subjects
            WHERE faculty_id = %s AND semester = %s AND academic_year = %s
              AND (division IS NULL OR division = %s)
            LIMIT 1
        """, (faculty_id, semester, academic_year, division))
        if not cursor.fetchone():
            return jsonify({"message": "This class is not assigned to you"}), 403

        division_clause = "AND st.division = %s" if division else ""
        division_param = (division,) if division else ()

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
    Bulk status update — faculty sirf apni assigned class ke fee records ka status (paid/unpaid) badal sakta hai."""
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

        cursor.execute("""
            SELECT id FROM faculty_subjects
            WHERE faculty_id = %s AND semester = %s AND academic_year = %s
              AND (division IS NULL OR division = %s)
            LIMIT 1
        """, (faculty_id, semester, academic_year, division))
        if not cursor.fetchone():
            return jsonify({"message": "This class is not assigned to you"}), 403

        division_clause = "AND st.division = %s" if division else ""
        division_param = (division,) if division else ()

        updated = 0
        for u in updates:
            fee_id = u.get('fee_id')
            status = u.get('status')
            if not fee_id or status not in ('paid', 'unpaid'):
                continue
            # fee_id sirf isi semester+batch(+division) ke student ka hona chahiye — is join se verify karte hain
            cursor.execute(f"""
                UPDATE fees f
                JOIN students st ON st.id = f.student_id
                SET f.status = %s,
                    f.paid_at = CASE WHEN %s = 'paid' THEN CURRENT_TIMESTAMP ELSE NULL END
                WHERE f.id = %s AND st.semester = %s AND st.academic_year = %s {division_clause}
            """, (status, status, fee_id, semester, academic_year) + division_param)
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
# MATERIALS (faculty apne assigned subject ke study materials upload/list/edit/delete karta hai;
# `notes` table hi Admin ke saath shared hai — faculty_id se track hota hai kisne upload kiya,
# taaki har faculty sirf apna khud ka upload edit/delete kar sake)
# ============================================================
@app.route('/api/faculty/materials', methods=['GET'])
@faculty_required
def get_faculty_materials():
    """Query params: assignment_id, division (optional — sirf tab use hota hai jab assignment
    'All divisions' ho, upar wale Division filter se aata hai).
    Us subject+semester+batch ke saare materials (Admin ya kisi bhi faculty ke upload kiye hue) —
    'can_manage' flag batata hai ki yeh material khud is faculty ne upload kiya hai ya nahi."""
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

        division = assignment['division'] or chosen_division
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
    'All divisions' assignment ke liye upar chuni gayi division), file."""
    assignment_id = request.form.get('assignment_id')
    title = request.form.get('title')
    description = request.form.get('description') or None
    chosen_division = request.form.get('division') or None
    file = request.files.get('file')

    if not assignment_id or not title or not file or file.filename == '':
        return jsonify({"message": "Subject, title and file are required"}), 400

    if not _allowed_note_file(file.filename):
        return jsonify({"message": "Only PDF, DOC, DOCX, PPT, PPTX files are allowed"}), 400

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

    division = assignment['division'] or chosen_division

    original_name = secure_filename(file.filename)
    file_ext = original_name.rsplit('.', 1)[1].lower()
    unique_name = f"{uuid.uuid4().hex}.{file_ext}"   # disk pe collision se bachne ke liye unique naam
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
            os.remove(save_path)   # DB save fail hua to orphan file disk pe mat chodo
        return jsonify({"message": "Material could not be saved", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Material uploaded"}), 201


@app.route('/api/faculty/materials/<int:note_id>', methods=['PUT'])
@faculty_required
def update_faculty_material(note_id):
    """Sirf details edit hoti hain (title/description) — file replace nahi hoti.
    Sirf woh faculty edit kar sakta hai jisne khud yeh material upload kiya tha."""
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
        os.remove(file_path)   # DB record ke saath actual file bhi delete karo

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
# ASSIGNMENTS (apni assigned subjects ki assignments — Admin ke `assignments` table se shared.
# Add/Edit/Delete sirf khud banayi hui assignment pe milta hai; aur ek baar us assignment par
# koi submission aa jaaye to details edit karna band ho jaata hai — sirf submissions/marks review ho sakti hai.)
# ============================================================
def _get_visible_faculty_assignment(cursor, faculty_id, assignment_id):
    """Assignment tabhi milegi jab woh is faculty ki assigned subject+semester+batch ke scope me ho
    (chahe assignment kisi bhi faculty ne banayi ho usi subject/class ke liye)."""
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
    """Query params: semester, subject_id, division, academic_year, search (title) — sab optional.
    Sirf woh assignments dikhti hain jo is faculty ki assigned subject+semester+batch ke scope me ho."""
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
    due_date (optional), division (optional — sirf tab use hota hai jab assignment "All divisions" ho),
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

    division = assignment['division'] or chosen_division

    unique_name = None
    original_name = None
    file_size = None
    file_ext = None

    if file and file.filename:
        if not _allowed_assignment_file(file.filename):
            cursor.close()
            conn.close()
            return jsonify({"message": "Only PDF, DOC, DOCX, PPT, PPTX files are allowed"}), 400
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
    """Sirf title/due_date/description edit hote hain (subject/division/semester nahi) —
    aur sirf tab jab (a) yeh assignment khud faculty ne banayi ho, (b) abhi tak koi submission na aayi ho."""
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
    """Sirf woh faculty delete kar sakta hai jisne khud yeh assignment banayi thi.
    Delete hone par uski attachment file, saath hi sab student submissions (aur unki files) bhi hat jaati hain."""
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
    """Assignment ka attachment (question paper) download karta hai."""
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
    """Assignment ke semester+division ke sab eligible students, saath me unka submission status/marks (agar submit kiya ho)."""
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
        query += " ORDER BY u.name ASC"

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
    """Faculty manually ek student ka submission status set karta hai — Submitted/Late/Pending, saath me marks.
    Sirf woh faculty kar sakta hai jisne khud yeh assignment banayi thi."""
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
    """Ek student ki submitted file download karta hai (sirf agar assignment is faculty ke scope me ho)."""
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
# TIMETABLE (apni khud ki weekly schedule — read-only; Admin hi is table ko manage karta hai)
# ============================================================
@app.route('/api/faculty/timetable', methods=['GET'])
@faculty_required
def get_faculty_timetable():
    """Read-only: college ki poori regular weekly timetable (sab semester/division/batch) —
    faculty sirf dekh sakta hai, add/edit/delete sirf Admin karta hai."""
    academic_year = request.args.get('academic_year')

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        faculty_id = _get_faculty_id(cursor, request.user['user_id'])
        if not faculty_id:
            return jsonify({"message": "Faculty record not found"}), 404

        query = """
            SELECT t.id, t.semester, t.division, t.academic_year, t.day_of_week, t.room_no,
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
    """Read-only: Mid-Sem / Remedial exam timetable (sab semester/division/batch) —
    faculty sirf dekh sakta hai, add/edit/delete sirf Admin karta hai."""
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
# NOTICES (faculty ke liye read — Admin broadcast + apni personal notices — aur
# apni assigned class ko khud notice post karna. Edit/Delete/Pin sirf khud ki post ki
# hui notice pe milta hai; class/subject edit pe change nahi hoti, sirf naya post karte waqt.)
# ============================================================
@app.route('/api/faculty/notices', methods=['GET'])
@faculty_required
def get_faculty_notices():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        cursor.execute("""
            SELECT id, title, content, category, is_pinned, created_at, target_user_id,
                   semester, division, posted_by, file_name, file_size, file_type,
                   (SELECT COUNT(*) FROM notice_reads nr
                    WHERE nr.notice_id = notices.id AND nr.user_id <> notices.posted_by) AS seen_count,
                   (SELECT MAX(nr.seen_at) FROM notice_reads nr
                    JOIN users u ON u.id = nr.user_id
                    WHERE nr.notice_id = notices.id AND u.role = 'admin') AS admin_seen_at
            FROM notices
            WHERE (target_role IN ('all','faculty') AND target_user_id IS NULL)
               OR target_user_id = %s
               OR posted_by = %s
            ORDER BY is_pinned DESC, created_at DESC
            LIMIT 50
        """, (user_id, user_id))
        notices = cursor.fetchall()
        for n in notices:
            n['is_personal'] = n['target_user_id'] is not None
            n['can_manage'] = (n['posted_by'] == user_id)
            if n['can_manage']:
                n['admin_seen'] = n['admin_seen_at'] is not None
                n['admin_seen_at'] = n['admin_seen_at'].isoformat() if n['admin_seen_at'] else None
            else:
                del n['seen_count']   # seen count sirf usi faculty ko dikhta hai jisne notice post ki
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
    """Sidebar ke 'Notices' item pe dot dikhane/hatane ke liye — kitni notices hain jo is
    faculty ko dikhti hain (broadcast + personal + khud ki post ki hui) par abhi tak dekhi nahi."""
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
    """Notices tab khulte hi call hota hai — jitni bhi notices is faculty ko dikhti hain,
    sabko 'seen' mark kar deta hai, taaki sidebar ka dot hat jaaye."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        user_id = request.user['user_id']
        cursor.execute("""
            INSERT IGNORE INTO notice_reads (notice_id, user_id)
            SELECT n.id, %s
            FROM notices n
            WHERE (n.target_role IN ('all','faculty') AND n.target_user_id IS NULL)
               OR n.target_user_id = %s
               OR n.posted_by = %s
        """, (user_id, user_id, user_id))
        conn.commit()
        return jsonify({"message": "Marked as read"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Failed to mark as read", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/notices', methods=['POST'])
@faculty_required
def add_faculty_notice():
    """multipart/form-data: assignment_id (faculty_subjects.id — jis class ko notice bhejni hai),
    title, content (optional), category (optional), division (optional — sirf tab jab assignment
    "All divisions" ho), file (optional, PDF/DOC/DOCX/PPT/PPTX/JPG/PNG). Hamesha students ko jaati hai."""
    assignment_id = request.form.get('assignment_id')
    title = request.form.get('title')
    content = request.form.get('content') or None
    category = request.form.get('category') or 'Academic'
    chosen_division = request.form.get('division') or None
    file = request.files.get('file')

    if not assignment_id or not title:
        return jsonify({"message": "Class and title are required"}), 400

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

    division = assignment['division'] or chosen_division

    file_path = file_name = file_size = file_type = None
    if file and file.filename:
        if not _allowed_notice_file(file.filename):
            cursor.close()
            conn.close()
            return jsonify({"message": "Only PDF, DOC, DOCX, PPT, PPTX, JPG, PNG files are allowed"}), 400
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
            VALUES (%s,%s,%s,'student',%s,%s,%s,%s,FALSE,%s,%s,%s,%s)
        """, (
            title, content, category,
            assignment['semester'], division, assignment['academic_year'],
            request.user['user_id'], file_path, file_name, file_size, file_type
        ))
        new_notice_id = cursor.lastrowid
        # Jisne notice banayi usi ke liye turant "seen" mark kar do — apni khud ki post ke liye
        # unread dot nahi dikhna chahiye
        cursor.execute(
            "INSERT IGNORE INTO notice_reads (notice_id, user_id) VALUES (%s, %s)",
            (new_notice_id, request.user['user_id'])
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        cursor.close()
        conn.close()
        if file_path and os.path.exists(os.path.join(NOTICE_UPLOAD_FOLDER, file_path)):
            os.remove(os.path.join(NOTICE_UPLOAD_FOLDER, file_path))
        return jsonify({"message": "Notice could not be saved", "error": str(e)}), 500

    cursor.close()
    conn.close()
    return jsonify({"message": "Notice published"}), 201


@app.route('/api/faculty/notices/<int:notice_id>', methods=['PUT'])
@faculty_required
def update_faculty_notice(notice_id):
    """Sirf title/content/category edit hote hain (class/division/attachment nahi) —
    aur sirf tab jab yeh notice khud faculty ne post ki ho."""
    data = request.get_json() or {}
    title = data.get('title')
    content = data.get('content') or None
    category = data.get('category') or 'Academic'

    if not title:
        return jsonify({"message": "Title is required"}), 400

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
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Notice could not be updated", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/notices/<int:notice_id>/reads', methods=['GET'])
@faculty_required
def get_faculty_notice_reads(notice_id):
    """Apni post ki hui notice kis student ne dekh li (naam, enrollment, kab dekha) + us class ke
    total students. Sirf notice post karne wali faculty hi dekh sakti hai."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        user_id = request.user['user_id']
        cursor.execute("SELECT * FROM notices WHERE id = %s AND posted_by = %s", (notice_id, user_id))
        notice = cursor.fetchone()
        # 404 (403 nahi) — kyunki frontend 403 pe login page pe bhej deta hai
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
        target_total += cursor.fetchone()['c']   # admin bhi seen list me aata hai

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
    """Kisi bhi notice ka attachment download karta hai jo is faculty ko dikhti hai
    (Admin broadcast, personal, ya khud ki post ki hui)."""
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
              )
        """, (notice_id, user_id, user_id))
        notice = cursor.fetchone()
    finally:
        cursor.close()
        conn.close()

    if not notice or not notice['file_path']:
        return jsonify({"message": "Attachment not found"}), 404

    return send_from_directory(
        NOTICE_UPLOAD_FOLDER,
        notice['file_path'],
        as_attachment=True,
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
        """SELECT u.name, u.login_id AS faculty_id, f.department, f.email, f.short_name
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
    """Faculty can edit their own full name + short name — Faculty ID and Department stay under Admin's control."""
    data = request.get_json()
    name = data.get('name')
    short_name = data.get('short_name')
    if not name or not name.strip():
        return jsonify({"message": "Name cannot be empty"}), 400

    user_id = request.user['user_id']
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET name = %s WHERE id = %s", (name.strip(), user_id))
    cursor.execute(
        "UPDATE faculty SET short_name = %s WHERE user_id = %s",
        (short_name.strip() if short_name else None, user_id)
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


# ============================================================
# ASK STUDENTHUB — halka data-driven assistant (koi external AI nahi).
# Dashboard card + floating chat popup dono isi endpoint ko call karte hain.
# Keyword se sawal pehchan ke seedha DB se real jawab deta hai —
# supported: "low attendance list", "pending submissions", "attendance %", "class list".
# ============================================================
@app.route('/api/faculty/assistant', methods=['POST'])
@faculty_required
def faculty_assistant():
    data = request.get_json() or {}
    message = (data.get('message') or '').strip().lower()
    if not message:
        return jsonify({"reply": "Kuch pooch to sahi! 🙂"}), 200

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
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
            reply = ("Low attendance (<75%) wale students:\n" + "\n".join(lines[:15])) if lines \
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

        return jsonify({
            "reply": "I can currently answer these kinds of questions: \"low attendance list\", "
                     "\"pending submissions\", \"attendance %\", or \"class list\"."
        }), 200
    except Exception as e:
        return jsonify({"reply": "Something went wrong, please try again."}), 200
    finally:
        cursor.close()
        conn.close()