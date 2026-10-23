"""
Holidays + cancelled sessions (+ Extra sessions: attendance on a day/type that is not in the timetable).

Rule: the timetable is only a plan. A slot counts as "held" only if it is NOT a holiday
and NOT cancelled. Percentage logic is unchanged (it counts attendance rows), so
holiday/cancelled slots simply never get attendance rows and never show as "pending".
"""
from flask import request, jsonify
from datetime import datetime, date as date_cls, timedelta

from db import get_db
from app import app
from auth_middleware import admin_required, faculty_required

DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
CANCEL_REASONS = ('Meeting', 'Faculty leave', 'Substitute unavailable', 'Other')


# ------------------------------------------------------------
# Helpers (also imported by faculty_routes.py)
# ------------------------------------------------------------
def get_holiday(cursor, date_obj, semester, division):
    """Returns the holiday row covering this date for the class, or None.
    Scope: semester NULL = whole college; division NULL = every division of that semester.
    division may be None/'' (a faculty assignment for 'All divisions') -> only whole-college or
    whole-semester holidays apply in that case."""
    cursor.execute("""
        SELECT id, name FROM holidays
        WHERE holiday_date = %s
          AND (semester IS NULL OR semester = %s)
          AND (division IS NULL OR division = %s)
        LIMIT 1
    """, (date_obj, semester, division or ''))
    return cursor.fetchone()


def get_cancelled_override(cursor, timetable_id, date_obj):
    cursor.execute("""
        SELECT id, reason FROM session_overrides
        WHERE timetable_id = %s AND session_date = %s AND status = 'cancelled'
        LIMIT 1
    """, (timetable_id, date_obj))
    return cursor.fetchone()


def split_divisions(value):
    """timetable.division can hold several divisions as 'A,B' -> ['A', 'B'] ('' / None -> [])."""
    return [x.strip() for x in (value or '').split(',') if x.strip()]


def get_holiday_for_slot(cursor, date_obj, semester, division_csv):
    """Holiday check for a timetable slot / class whose division may be 'A,B'.
    A multi-division slot counts as holiday only when EVERY one of its divisions has a holiday."""
    divs = split_divisions(division_csv)
    if not divs:
        return get_holiday(cursor, date_obj, semester, '')
    found = [get_holiday(cursor, date_obj, semester, d) for d in divs]
    return found[0] if all(found) else None


def _cancelled_divisions(cursor, slots, date_obj, target_divisions=None, getter=None):
    """slots = timetable rows (id, division) of the same subject/session type/weekday.
    A slot with division 'A,B' covers both A and B; a slot with no division covers every division.
    A division is 'cancelled' when ALL slots covering it are cancelled on date_obj.
    target_divisions = the divisions being saved (None -> every division that appears in the slots)."""
    groups = {}
    for sl in slots:
        for d in (split_divisions(sl.get('division')) or ['']):
            groups.setdefault(d, []).append(sl['id'])
    getter = getter or get_cancelled_override
    targets = list(target_divisions) if target_divisions else list(groups.keys())
    cancelled = []
    for d in targets:
        ids = list(groups.get(d, []))
        if d != '':
            ids += groups.get('', [])
        if ids and all(getter(cursor, i, date_obj) for i in set(ids)):
            cancelled.append(d)
    return sorted(set(cancelled))


def get_substitute_override(cursor, timetable_id, date_obj):
    """The 'substituted' override of this slot on this date (with the substitute's name), or None."""
    cursor.execute("""
        SELECT o.id, o.reason, o.substitute_faculty_id, u.name AS substitute_name
        FROM session_overrides o
        LEFT JOIN faculty f ON f.id = o.substitute_faculty_id
        LEFT JOIN users u ON u.id = f.user_id
        WHERE o.timetable_id = %s AND o.session_date = %s AND o.status = 'substituted'
        LIMIT 1
    """, (timetable_id, date_obj))
    return cursor.fetchone()


def get_substitute_target(cursor, faculty_id, timetable_id, date_obj):
    """The timetable slot (subject/semester/division/session type + original faculty) IF this faculty is the
    substitute for that slot on that date, else None."""
    cursor.execute("""
        SELECT t.id, t.subject_id, t.semester, t.division, t.session_type, t.faculty_id AS original_faculty_id
        FROM session_overrides o
        JOIN timetable t ON t.id = o.timetable_id
        WHERE o.timetable_id = %s AND o.session_date = %s
          AND o.status = 'substituted' AND o.substitute_faculty_id = %s
        LIMIT 1
    """, (timetable_id, date_obj, faculty_id))
    return cursor.fetchone()


def get_substitute_slots_between(cursor, faculty_id, start_date, end_date):
    """Slots this faculty is substituting for between two dates (inclusive), with the original faculty's name."""
    cursor.execute("""
        SELECT t.id AS timetable_id, DATE_FORMAT(o.session_date, '%Y-%m-%d') AS session_date,
               t.semester, t.division, t.room_no, t.session_type, t.subject_id,
               TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
               TIME_FORMAT(t.end_time, '%H:%i') AS end_time,
               sub.subject_name, ou.name AS original_faculty_name, o.reason
        FROM session_overrides o
        JOIN timetable t ON t.id = o.timetable_id
        LEFT JOIN subjects sub ON sub.id = t.subject_id
        LEFT JOIN faculty fo ON fo.id = t.faculty_id
        LEFT JOIN users ou ON ou.id = fo.user_id
        WHERE o.status = 'substituted' AND o.substitute_faculty_id = %s
          AND o.session_date BETWEEN %s AND %s
        ORDER BY o.session_date, t.start_time
    """, (faculty_id, start_date, end_date))
    return cursor.fetchall()


def same_text(a, b):
    """Same comparison MySQL makes for names like department/division: ignores case and trailing spaces. NULL never matches."""
    if a is None or b is None:
        return False
    return str(a).rstrip().lower() == str(b).rstrip().lower()


def _same_number(a, b):
    if a is None or b is None:
        return False
    try:
        return int(a) == int(b)
    except (TypeError, ValueError):
        return str(a).strip() == str(b).strip()


class SessionCalendar:
    """Holidays + cancelled/substituted overrides of a date range, loaded with ONE or TWO queries and then answered
    from memory.  Gives the same answers as get_holiday / get_holiday_for_slot / get_cancelled_override /
    get_substitute_override, which run a query on EVERY call (far too slow inside loops over days x timetable slots).
    Use it when many slots/dates are checked in one request:
        cal = SessionCalendar(cursor, first_date, last_date, [timetable ids])
        cal.holiday_for_slot(d, semester, division_csv) / cal.cancelled(timetable_id, d) / cal.substitute(timetable_id, d)"""

    def __init__(self, cursor, start_date, end_date, timetable_ids=()):
        self._holidays = {}      # date -> [holiday rows]
        self._overrides = {}     # (timetable id, date, status) -> row
        cursor.execute("""
            SELECT id, name, holiday_date, semester, division FROM holidays
            WHERE holiday_date BETWEEN %s AND %s ORDER BY id
        """, (start_date, end_date))
        for h in cursor.fetchall():
            self._holidays.setdefault(self._day(h['holiday_date']), []).append(h)

        ids = sorted({i for i in timetable_ids if i is not None})
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            placeholders = ','.join(['%s'] * len(chunk))
            cursor.execute(f"""
                SELECT o.id, o.timetable_id, o.session_date, o.status, o.reason, o.substitute_faculty_id,
                       u.name AS substitute_name
                FROM session_overrides o
                LEFT JOIN faculty f ON f.id = o.substitute_faculty_id
                LEFT JOIN users u ON u.id = f.user_id
                WHERE o.timetable_id IN ({placeholders}) AND o.session_date BETWEEN %s AND %s
                ORDER BY o.id
            """, tuple(chunk) + (start_date, end_date))
            for o in cursor.fetchall():
                self._overrides.setdefault((o['timetable_id'], self._day(o['session_date']), o['status']), o)

    @staticmethod
    def _day(value):
        return value.date() if isinstance(value, datetime) else value

    def holiday(self, date_obj, semester, division):
        """Same rule as get_holiday(): semester NULL = whole college, division NULL = every division."""
        div = division or ''
        for h in self._holidays.get(self._day(date_obj), ()):
            if h['semester'] is not None and not _same_number(h['semester'], semester):
                continue
            if h['division'] is not None and not same_text(h['division'], div):
                continue
            return {'id': h['id'], 'name': h['name']}
        return None

    def holiday_for_slot(self, date_obj, semester, division_csv):
        """Same rule as get_holiday_for_slot(): a multi-division slot ('A,B') is a holiday only if EVERY division has one."""
        divs = split_divisions(division_csv)
        if not divs:
            return self.holiday(date_obj, semester, '')
        found = [self.holiday(date_obj, semester, d) for d in divs]
        return found[0] if all(found) else None

    def cancelled(self, timetable_id, date_obj):
        o = self._overrides.get((timetable_id, self._day(date_obj), 'cancelled'))
        return {'id': o['id'], 'reason': o['reason']} if o else None

    def substitute(self, timetable_id, date_obj):
        o = self._overrides.get((timetable_id, self._day(date_obj), 'substituted'))
        if not o:
            return None
        return {'id': o['id'], 'reason': o['reason'], 'substitute_faculty_id': o['substitute_faculty_id'],
                'substitute_name': o['substitute_name']}


def has_scheduled_slot(cursor, faculty_id, subject_id, semester, division, session_type, date_obj):
    """True if the timetable has a slot for this faculty+subject+class+session type on this weekday.
    A slot with division 'A,B' covers both A and B; a slot with no division covers every division.
    division may be '' / None (an "All divisions" assignment with no Division filter) -> any slot counts."""
    cursor.execute("""
        SELECT t.id, t.division FROM timetable t
        WHERE t.faculty_id = %s AND t.subject_id = %s AND t.semester = %s
          AND t.session_type = %s AND t.day_of_week = %s
    """, (faculty_id, subject_id, semester, session_type, DAY_ABBR[date_obj.weekday()]))
    slots = cursor.fetchall()
    if not slots:
        return False
    if not division:
        return True
    for sl in slots:
        divs = split_divisions(sl.get('division'))
        if not divs or division in divs:
            return True
    return False


def get_extra_session(cursor, faculty_id, subject_id, semester, division, session_type, date_obj):
    """The extra_sessions row if this session was already confirmed as an Extra session, else None."""
    cursor.execute("""
        SELECT id FROM extra_sessions
        WHERE faculty_id = %s AND subject_id = %s AND semester = %s AND division = %s
          AND session_type = %s AND session_date = %s
        LIMIT 1
    """, (faculty_id, subject_id, semester, division or '', session_type, date_obj))
    return cursor.fetchone()


def record_extra_session(cursor, faculty_id, subject_id, semester, division, session_type, date_obj):
    cursor.execute("""
        INSERT INTO extra_sessions (faculty_id, subject_id, semester, division, session_type, session_date)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE id = id
    """, (faculty_id, subject_id, semester, division or '', session_type, date_obj))


def _cancelled_message(cancelled):
    names = [d for d in cancelled if d]
    where = (" for Division " + ", ".join(names)) if names else ""
    return (f"This lecture is marked as Cancelled{where} on that date — it must be un-cancelled by the faculty "
            "before attendance can be saved" + (" (save the other divisions separately)" if names else ""))


def get_session_block_reason(cursor, faculty_id, subject_id, semester, division, session_type, date_obj):
    """Why attendance must NOT be taken for this (faculty, subject, class, session type, date).
    Returns a message string, or None if the session is allowed."""
    holiday = get_holiday(cursor, date_obj, semester, division)
    if holiday:
        return f"{date_obj.isoformat()} is a holiday ({holiday['name']}) — attendance cannot be marked"

    cursor.execute("""
        SELECT t.id, t.division FROM timetable t
        WHERE t.faculty_id = %s AND t.subject_id = %s AND t.semester = %s
          AND t.session_type = %s AND t.day_of_week = %s
    """, (faculty_id, subject_id, semester, session_type, DAY_ABBR[date_obj.weekday()]))
    slots = cursor.fetchall()
    target = [division] if division else None
    cancelled = _cancelled_divisions(cursor, slots, date_obj, target) if slots else []
    if cancelled:
        return _cancelled_message(cancelled)
    substituted = _cancelled_divisions(cursor, slots, date_obj, target, getter=get_substitute_override) if slots else []
    if substituted:
        return ("This lecture is substituted by another faculty on that date — only the substitute can mark its "
                "attendance (remove the substitute first if you want to take it yourself)")
    return None


def get_admin_session_block_reason(cursor, subject_id, semester, divisions, session_type, date_obj):
    """Same rule as get_session_block_reason, for Admin's attendance save (no faculty involved).
    divisions = divisions of the students being saved (may be several when divisions are combined)."""
    divisions = sorted({d for d in divisions if d})
    for div in (divisions or ['']):
        holiday = get_holiday(cursor, date_obj, semester, div)
        if holiday:
            return f"{date_obj.isoformat()} is a holiday ({holiday['name']}) — attendance cannot be marked"

    cursor.execute("""
        SELECT t.id, t.division FROM timetable t
        WHERE t.subject_id = %s AND t.semester = %s AND t.session_type = %s AND t.day_of_week = %s
    """, (subject_id, semester, session_type, DAY_ABBR[date_obj.weekday()]))
    slots = cursor.fetchall()
    cancelled = _cancelled_divisions(cursor, slots, date_obj, divisions or None) if slots else []
    return _cancelled_message(cancelled) if cancelled else None


def _parse_date(value):
    try:
        return datetime.strptime(value, '%Y-%m-%d').date()
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------
# FACULTY — cancel / un-cancel one timetable slot on one date
# ------------------------------------------------------------
@app.route('/api/faculty/session-cancel', methods=['POST'])
@faculty_required
def faculty_cancel_session():
    """Body: { timetable_id, date, reason }. Only the slot's own faculty can cancel it."""
    data = request.get_json() or {}
    timetable_id = data.get('timetable_id')
    date_obj = _parse_date(data.get('date'))
    reason = (data.get('reason') or '').strip()[:100]

    if not timetable_id or not date_obj or not reason:
        return jsonify({"message": "timetable_id, date and reason are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (request.user['user_id'],))
        fac = cursor.fetchone()
        if not fac:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("SELECT * FROM timetable WHERE id = %s AND faculty_id = %s", (timetable_id, fac['id']))
        slot = cursor.fetchone()
        if not slot:
            return jsonify({"message": "This slot is not yours"}), 403
        if DAY_ABBR[date_obj.weekday()] != slot['day_of_week']:
            return jsonify({"message": "That date does not fall on this slot's weekday"}), 400
        if get_holiday_for_slot(cursor, date_obj, slot['semester'], slot['division']):
            return jsonify({"message": "That day is already a holiday"}), 400

        if get_substitute_override(cursor, timetable_id, date_obj):
            return jsonify({"message": "A substitute is set for this lecture. Remove the substitute first, then cancel."}), 409

        # Safety: don't silently hide attendance that was already saved
        cursor.execute("""
            SELECT 1 FROM attendance a
            JOIN students st ON st.id = a.student_id
            WHERE a.subject_id = %s AND a.attendance_date = %s AND a.session_type = %s
              AND st.semester = %s AND (%s IS NULL OR %s = '' OR FIND_IN_SET(st.division, %s))
            LIMIT 1
        """, (slot['subject_id'], date_obj, slot['session_type'], slot['semester'],
              slot['division'], slot['division'], slot['division']))
        if cursor.fetchone():
            return jsonify({"message": "Attendance was already saved for this lecture, so it cannot be cancelled. "
                                       "Ask Admin to correct it."}), 409

        cursor.execute("""
            INSERT INTO session_overrides (timetable_id, session_date, status, reason, marked_by)
            VALUES (%s, %s, 'cancelled', %s, %s)
            ON DUPLICATE KEY UPDATE reason = VALUES(reason), marked_by = VALUES(marked_by)
        """, (timetable_id, date_obj, reason, request.user['user_id']))
        conn.commit()
        return jsonify({"message": "Lecture marked as cancelled"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Could not cancel the lecture", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/session-uncancel', methods=['POST'])
@faculty_required
def faculty_uncancel_session():
    """Body: { timetable_id, date } — undoes a cancellation (the slot becomes pending again)."""
    data = request.get_json() or {}
    timetable_id = data.get('timetable_id')
    date_obj = _parse_date(data.get('date'))
    if not timetable_id or not date_obj:
        return jsonify({"message": "timetable_id and date are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (request.user['user_id'],))
        fac = cursor.fetchone()
        if not fac:
            return jsonify({"message": "Faculty record not found"}), 404
        cursor.execute("SELECT id FROM timetable WHERE id = %s AND faculty_id = %s", (timetable_id, fac['id']))
        if not cursor.fetchone():
            return jsonify({"message": "This slot is not yours"}), 403
        cursor.execute("DELETE FROM session_overrides WHERE timetable_id = %s AND session_date = %s AND status = 'cancelled'",
                       (timetable_id, date_obj))
        conn.commit()
        return jsonify({"message": "Cancellation removed"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Could not undo the cancellation", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ------------------------------------------------------------
# ADMIN — holidays CRUD
# ------------------------------------------------------------
@app.route('/api/admin/holidays', methods=['GET'])
@admin_required
def admin_list_holidays():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("""
            SELECT id, DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date, name, semester, division
            FROM holidays ORDER BY holiday_date DESC, id DESC
        """)
        return jsonify(cursor.fetchall()), 200
    except Exception as e:
        return jsonify({"message": "Holidays could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/holidays', methods=['POST'])
@admin_required
def admin_add_holiday():
    """Body: { holiday_date, name, semester (optional), division (optional) }.
    No semester = whole college. Semester without division = all divisions of that semester."""
    data = request.get_json() or {}
    date_obj = _parse_date(data.get('holiday_date'))
    name = (data.get('name') or '').strip()[:100]
    semester = data.get('semester') or None
    division = (data.get('division') or '').strip() or None

    if not date_obj or not name:
        return jsonify({"message": "holiday_date and name are required"}), 400
    if division and not semester:
        return jsonify({"message": "Choose a semester when choosing a division"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        # UNIQUE KEY ignores NULLs in MySQL, so duplicates are checked here
        cursor.execute("""
            SELECT id FROM holidays
            WHERE holiday_date = %s AND semester <=> %s AND division <=> %s
        """, (date_obj, semester, division))
        if cursor.fetchone():
            return jsonify({"message": "This holiday already exists for that scope"}), 409

        cursor.execute("""
            INSERT INTO holidays (holiday_date, name, semester, division, created_by)
            VALUES (%s, %s, %s, %s, %s)
        """, (date_obj, name, semester, division, request.user['user_id']))
        conn.commit()
        return jsonify({"message": "Holiday added"}), 201
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Holiday could not be added", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/holidays/<int:holiday_id>', methods=['DELETE'])
@admin_required
def admin_delete_holiday(holiday_id):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("DELETE FROM holidays WHERE id = %s", (holiday_id,))
        conn.commit()
        if cursor.rowcount == 0:
            return jsonify({"message": "Holiday not found"}), 404
        return jsonify({"message": "Holiday deleted"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Holiday could not be deleted", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ------------------------------------------------------------
# List of cancelled sessions (so a cancellation can be found and undone later)
# ------------------------------------------------------------
_CANCELLED_SELECT = """
    SELECT o.id, o.timetable_id, DATE_FORMAT(o.session_date, '%Y-%m-%d') AS session_date,
           o.reason, t.session_type, t.semester, t.division,
           TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
           sub.subject_name, u.name AS faculty_name
    FROM session_overrides o
    JOIN timetable t ON t.id = o.timetable_id
    LEFT JOIN subjects sub ON sub.id = t.subject_id
    LEFT JOIN faculty f ON f.id = t.faculty_id
    LEFT JOIN users u ON u.id = f.user_id
    WHERE o.status = 'cancelled' AND o.session_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
"""


@app.route('/api/faculty/cancelled-sessions', methods=['GET'])
@faculty_required
def faculty_cancelled_sessions():
    """The logged-in faculty's own cancelled lectures/labs of the last 60 days (and upcoming ones)."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (request.user['user_id'],))
        fac = cursor.fetchone()
        if not fac:
            return jsonify({"message": "Faculty record not found"}), 404
        cursor.execute(_CANCELLED_SELECT + " AND t.faculty_id = %s ORDER BY o.session_date DESC, t.start_time",
                       (fac['id'],))
        return jsonify(cursor.fetchall()), 200
    except Exception as e:
        return jsonify({"message": "Cancelled lectures could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/cancelled-sessions', methods=['GET'])
@admin_required
def admin_cancelled_sessions():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(_CANCELLED_SELECT + " ORDER BY o.session_date DESC, t.start_time")
        return jsonify(cursor.fetchall()), 200
    except Exception as e:
        return jsonify({"message": "Cancelled lectures could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/admin/session-uncancel', methods=['POST'])
@admin_required
def admin_uncancel_session():
    """Body: { timetable_id, date } — Admin can undo any cancellation."""
    data = request.get_json() or {}
    timetable_id = data.get('timetable_id')
    date_obj = _parse_date(data.get('date'))
    if not timetable_id or not date_obj:
        return jsonify({"message": "timetable_id and date are required"}), 400
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("DELETE FROM session_overrides WHERE timetable_id = %s AND session_date = %s AND status = 'cancelled'",
                       (timetable_id, date_obj))
        conn.commit()
        if cursor.rowcount == 0:
            return jsonify({"message": "This lecture is not cancelled"}), 404
        return jsonify({"message": "Cancellation removed"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Could not undo the cancellation", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ------------------------------------------------------------
# FACULTY — mark leave in advance (a date range): all of the faculty's slots in that range are cancelled
# ------------------------------------------------------------
LEAVE_MAX_DAYS = 60


@app.route('/api/faculty/leave', methods=['POST'])
@faculty_required
def faculty_mark_leave():
    """Body: { from_date, to_date, reason }. Cancels every timetable slot of this faculty that falls on a
    working day in the range (today or later). Holidays and lectures whose attendance is already saved are skipped.
    Students see these cancellations in advance (Upcoming changes)."""
    data = request.get_json() or {}
    from_d = _parse_date(data.get('from_date'))
    to_d = _parse_date(data.get('to_date')) or from_d
    reason = (data.get('reason') or 'Faculty leave').strip()[:100] or 'Faculty leave'

    if not from_d:
        return jsonify({"message": "from_date is required"}), 400
    if to_d < from_d:
        return jsonify({"message": "To date cannot be before From date"}), 400
    if from_d < date_cls.today():
        return jsonify({"message": "Leave can be marked from today onwards. For a past lecture use Cancel in the pending list."}), 400
    if (to_d - from_d).days > LEAVE_MAX_DAYS:
        return jsonify({"message": f"Please choose a range of at most {LEAVE_MAX_DAYS} days"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (request.user['user_id'],))
        fac = cursor.fetchone()
        if not fac:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("SELECT id, day_of_week, semester, division, subject_id, session_type "
                       "FROM timetable WHERE faculty_id = %s", (fac['id'],))
        slots = cursor.fetchall()

        cancelled_count = 0
        skipped_saved = 0
        override_rows = []
        # holidays + existing cancellations/substitutions of the whole range: 2 queries (instead of 3 per slot per day)
        cal = SessionCalendar(cursor, from_d, to_d, [sl['id'] for sl in slots])
        d = from_d
        while d <= to_d:
            day = DAY_ABBR[d.weekday()]
            for sl in slots:
                if sl['day_of_week'] != day:
                    continue
                if cal.holiday_for_slot(d, sl['semester'], sl['division']):
                    continue
                if cal.cancelled(sl['id'], d):
                    continue
                if cal.substitute(sl['id'], d):
                    continue   # a substitute is already arranged for this slot — leave it as it is
                cursor.execute("""
                    SELECT 1 FROM attendance a JOIN students st ON st.id = a.student_id
                    WHERE a.subject_id = %s AND a.attendance_date = %s AND a.session_type = %s
                      AND st.semester = %s AND (%s IS NULL OR %s = '' OR FIND_IN_SET(st.division, %s))
                    LIMIT 1
                """, (sl['subject_id'], d, sl['session_type'], sl['semester'],
                      sl['division'], sl['division'], sl['division']))
                if cursor.fetchone():
                    skipped_saved += 1
                    continue
                override_rows.append((sl['id'], d, reason, request.user['user_id']))
                cancelled_count += 1
            d += timedelta(days=1)
        if override_rows:
            # all cancellations in one INSERT (instead of one per slot)
            cursor.executemany("""
                INSERT INTO session_overrides (timetable_id, session_date, status, reason, marked_by)
                VALUES (%s, %s, 'cancelled', %s, %s)
                ON DUPLICATE KEY UPDATE reason = VALUES(reason), marked_by = VALUES(marked_by)
            """, override_rows)
        conn.commit()

        msg = f"{cancelled_count} lecture/lab slot(s) marked as cancelled"
        if skipped_saved:
            msg += f" ({skipped_saved} skipped because attendance was already saved)"
        return jsonify({"message": msg, "cancelled": cancelled_count, "skipped_saved": skipped_saved}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Could not mark the leave", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# ------------------------------------------------------------
# FACULTY — Substitute session: another faculty takes one timetable slot on one date
# (the slot stays "held"; only the substitute can mark its attendance, and the row is saved with his/her faculty_id)
# ------------------------------------------------------------
def _attendance_saved_for_slot(cursor, slot, date_obj):
    cursor.execute("""
        SELECT 1 FROM attendance a
        JOIN students st ON st.id = a.student_id
        WHERE a.subject_id = %s AND a.attendance_date = %s AND a.session_type = %s
          AND st.semester = %s AND (%s IS NULL OR %s = '' OR FIND_IN_SET(st.division, %s))
        LIMIT 1
    """, (slot['subject_id'], date_obj, slot['session_type'], slot['semester'],
          slot['division'], slot['division'], slot['division']))
    return cursor.fetchone() is not None


@app.route('/api/faculty/colleagues', methods=['GET'])
@faculty_required
def faculty_colleagues():
    """Other faculty members (for choosing a substitute)."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (request.user['user_id'],))
        fac = cursor.fetchone()
        if not fac:
            return jsonify({"message": "Faculty record not found"}), 404
        cursor.execute("""
            SELECT f.id, u.name, f.department
            FROM faculty f JOIN users u ON u.id = f.user_id
            WHERE f.id <> %s ORDER BY u.name
        """, (fac['id'],))
        return jsonify(cursor.fetchall()), 200
    except Exception as e:
        return jsonify({"message": "Faculty list could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/session-substitute', methods=['POST'])
@faculty_required
def faculty_substitute_session():
    """Body: { timetable_id, date, substitute_faculty_id, reason (optional) }. Only the slot's own faculty can do this."""
    data = request.get_json() or {}
    timetable_id = data.get('timetable_id')
    date_obj = _parse_date(data.get('date'))
    substitute_id = data.get('substitute_faculty_id')
    reason = (data.get('reason') or 'Faculty unavailable').strip()[:100] or 'Faculty unavailable'

    if not timetable_id or not date_obj or not substitute_id:
        return jsonify({"message": "timetable_id, date and substitute_faculty_id are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (request.user['user_id'],))
        fac = cursor.fetchone()
        if not fac:
            return jsonify({"message": "Faculty record not found"}), 404

        cursor.execute("SELECT * FROM timetable WHERE id = %s AND faculty_id = %s", (timetable_id, fac['id']))
        slot = cursor.fetchone()
        if not slot:
            return jsonify({"message": "This slot is not yours"}), 403
        if DAY_ABBR[date_obj.weekday()] != slot['day_of_week']:
            return jsonify({"message": "That date does not fall on this slot's weekday"}), 400
        if get_holiday_for_slot(cursor, date_obj, slot['semester'], slot['division']):
            return jsonify({"message": "That day is already a holiday"}), 400

        try:
            substitute_id = int(substitute_id)
        except (TypeError, ValueError):
            return jsonify({"message": "Invalid substitute"}), 400
        if substitute_id == fac['id']:
            return jsonify({"message": "Choose a different faculty as the substitute"}), 400
        cursor.execute("""
            SELECT f.id, u.name FROM faculty f JOIN users u ON u.id = f.user_id WHERE f.id = %s
        """, (substitute_id,))
        sub = cursor.fetchone()
        if not sub:
            return jsonify({"message": "Substitute faculty not found"}), 404

        if get_cancelled_override(cursor, timetable_id, date_obj):
            return jsonify({"message": "This lecture is cancelled. Undo the cancellation first, then set a substitute."}), 409
        if _attendance_saved_for_slot(cursor, slot, date_obj):
            return jsonify({"message": "Attendance was already saved for this lecture, so a substitute cannot be set. "
                                       "Ask Admin to correct it."}), 409

        # The substitute must be free at that time (own classes and other substitutions)
        cursor.execute("""
            SELECT TIME_FORMAT(t.start_time, '%H:%i') AS st, sub.subject_name, t.id
            FROM timetable t LEFT JOIN subjects sub ON sub.id = t.subject_id
            WHERE t.faculty_id = %s AND t.day_of_week = %s AND t.id <> %s
              AND t.start_time < %s AND t.end_time > %s
        """, (substitute_id, slot['day_of_week'], timetable_id, slot['end_time'], slot['start_time']))
        for c in cursor.fetchall():
            if get_cancelled_override(cursor, c['id'], date_obj) or get_substitute_override(cursor, c['id'], date_obj):
                continue   # that class is not actually taken by him/her on this date
            return jsonify({"message": f"{sub['name']} already has {c['subject_name']} at {c['st']} on that day"}), 409
        cursor.execute("""
            SELECT TIME_FORMAT(t.start_time, '%H:%i') AS st, sub.subject_name
            FROM session_overrides o
            JOIN timetable t ON t.id = o.timetable_id
            LEFT JOIN subjects sub ON sub.id = t.subject_id
            WHERE o.status = 'substituted' AND o.substitute_faculty_id = %s AND o.session_date = %s
              AND o.timetable_id <> %s AND t.start_time < %s AND t.end_time > %s
            LIMIT 1
        """, (substitute_id, date_obj, timetable_id, slot['end_time'], slot['start_time']))
        c = cursor.fetchone()
        if c:
            return jsonify({"message": f"{sub['name']} is already substituting {c['subject_name']} at {c['st']} on that day"}), 409

        cursor.execute("""
            INSERT INTO session_overrides (timetable_id, session_date, status, reason, marked_by, substitute_faculty_id)
            VALUES (%s, %s, 'substituted', %s, %s, %s)
            ON DUPLICATE KEY UPDATE status = 'substituted', reason = VALUES(reason),
                                    marked_by = VALUES(marked_by), substitute_faculty_id = VALUES(substitute_faculty_id)
        """, (timetable_id, date_obj, reason, request.user['user_id'], substitute_id))
        conn.commit()
        return jsonify({"message": f"{sub['name']} will take this lecture"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Could not set the substitute", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/session-unsubstitute', methods=['POST'])
@faculty_required
def faculty_unsubstitute_session():
    """Body: { timetable_id, date } — removes the substitute (the slot becomes the original faculty's again)."""
    data = request.get_json() or {}
    timetable_id = data.get('timetable_id')
    date_obj = _parse_date(data.get('date'))
    if not timetable_id or not date_obj:
        return jsonify({"message": "timetable_id and date are required"}), 400

    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (request.user['user_id'],))
        fac = cursor.fetchone()
        if not fac:
            return jsonify({"message": "Faculty record not found"}), 404
        cursor.execute("SELECT * FROM timetable WHERE id = %s AND faculty_id = %s", (timetable_id, fac['id']))
        slot = cursor.fetchone()
        if not slot:
            return jsonify({"message": "This slot is not yours"}), 403
        ov = get_substitute_override(cursor, timetable_id, date_obj)
        if not ov:
            return jsonify({"message": "No substitute is set for this lecture"}), 404
        if _attendance_saved_for_slot(cursor, slot, date_obj):
            return jsonify({"message": "The substitute has already saved attendance for this lecture, so the "
                                       "substitute cannot be removed. Ask Admin to correct it."}), 409
        cursor.execute("DELETE FROM session_overrides WHERE id = %s", (ov['id'],))
        conn.commit()
        return jsonify({"message": "Substitute removed"}), 200
    except Exception as e:
        conn.rollback()
        return jsonify({"message": "Could not remove the substitute", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@app.route('/api/faculty/substituted-sessions', methods=['GET'])
@faculty_required
def faculty_substituted_sessions():
    """{ given: my slots that someone else takes, taking: slots I take for others } — last 60 days + upcoming."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM faculty WHERE user_id = %s", (request.user['user_id'],))
        fac = cursor.fetchone()
        if not fac:
            return jsonify({"message": "Faculty record not found"}), 404
        cursor.execute("""
            SELECT o.timetable_id, DATE_FORMAT(o.session_date, '%Y-%m-%d') AS session_date, o.reason,
                   t.session_type, t.semester, t.division, TIME_FORMAT(t.start_time, '%H:%i') AS start_time,
                   sub.subject_name, su.name AS substitute_name
            FROM session_overrides o
            JOIN timetable t ON t.id = o.timetable_id
            LEFT JOIN subjects sub ON sub.id = t.subject_id
            LEFT JOIN faculty sf ON sf.id = o.substitute_faculty_id
            LEFT JOIN users su ON su.id = sf.user_id
            WHERE o.status = 'substituted' AND t.faculty_id = %s
              AND o.session_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
            ORDER BY o.session_date DESC, t.start_time
        """, (fac['id'],))
        given = cursor.fetchall()
        taking = get_substitute_slots_between(cursor, fac['id'],
                                              date_cls.today() - timedelta(days=60),
                                              date_cls.today() + timedelta(days=60))
        return jsonify({"given": given, "taking": taking}), 200
    except Exception as e:
        return jsonify({"message": "Substitutions could not be loaded", "error": str(e)}), 500
    finally:
        cursor.close()
        conn.close()