from functools import wraps
from flask import request, jsonify
import jwt
from db import get_db

from app import SECRET_KEY


def _get_token_from_header():
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None
    return auth_header.split(' ', 1)[1]


def _is_user_active(user_id):
    """Verifies that the user still exists and has an active status in the database."""
    if not user_id:
        return False
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT status FROM users WHERE id = %s", (user_id,))
        row = cursor.fetchone()
        return bool(row and row.get('status') == 'active')
    except Exception as e:
        print("MIDDLEWARE USER STATUS CHECK ERROR:", repr(e))
        return False
    finally:
        cursor.close()
        conn.close()


# Paths a user with must_change_password=TRUE may still call (so they can actually change it).
_PASSWORD_CHANGE_PATHS = (
    '/api/student/change-password',
    '/api/faculty/change-password',
    '/api/admin/change-password',
)


def is_default_password(role, login_id, password):
    """True when the password is still the system-generated default
    (student: enrollment number | faculty: 'faculty#...')."""
    password = password or ''
    if role == 'student':
        return password == str(login_id)
    if role == 'faculty':
        return password.startswith('faculty#')
    return False


def _get_user_state(user_id):
    """Returns (is_active, must_change_password) for the user."""
    if not user_id:
        return False, False
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        try:
            cursor.execute("SELECT status, must_change_password FROM users WHERE id = %s", (user_id,))
            row = cursor.fetchone()
            if not row:
                return False, False
            return row.get('status') == 'active', bool(row.get('must_change_password'))
        except Exception:
            # must_change_password column not migrated yet -> fall back to status only
            cursor.execute("SELECT status FROM users WHERE id = %s", (user_id,))
            row = cursor.fetchone()
            return bool(row and row.get('status') == 'active'), False
    except Exception as e:
        print("MIDDLEWARE USER STATE CHECK ERROR:", repr(e))
        return False, False
    finally:
        cursor.close()
        conn.close()


def _account_gate(user_id):
    """Returns None if the request may proceed, else a ready (response, status) tuple.
    428 (not 403) is used for 'password change required' so the panels' 401/403
    handlers do not log the user out."""
    active, must_change = _get_user_state(user_id)
    if not active:
        return jsonify({"message": "Account is inactive or does not exist"}), 403
    if must_change and request.path not in _PASSWORD_CHANGE_PATHS:
        return jsonify({
            "message": "You must change your default password before continuing.",
            "code": "PASSWORD_CHANGE_REQUIRED"
        }), 428
    return None


def token_required(f):
    """Allows any logged-in active user (student/faculty/admin)."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _get_token_from_header()
        if not token:
            return jsonify({"message": "Token missing"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Session expired. Please log in again"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        blocked = _account_gate(payload.get('user_id'))
        if blocked:
            return blocked

        request.user = payload   # {'user_id':..., 'role':..., 'exp':...}
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    """Allows only active users with role='admin'. Apply it to every route in admin_routes.py."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _get_token_from_header()
        if not token:
            return jsonify({"message": "Token missing"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Session expired. Please log in again"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        if payload.get('role') != 'admin':
            return jsonify({"message": "Admin access required"}), 403

        blocked = _account_gate(payload.get('user_id'))
        if blocked:
            return blocked

        request.user = payload
        return f(*args, **kwargs)
    return decorated


def faculty_required(f):
    """Allows only active users with role='faculty'. Apply it to every route in faculty_routes.py."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _get_token_from_header()
        if not token:
            return jsonify({"message": "Token missing"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Session expired. Please log in again"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        if payload.get('role') != 'faculty':
            return jsonify({"message": "Faculty access required"}), 403

        blocked = _account_gate(payload.get('user_id'))
        if blocked:
            return blocked

        request.user = payload
        return f(*args, **kwargs)
    return decorated


def student_required(f):
    """Allows only active users with role='student'. Apply it to every route in student_routes.py."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _get_token_from_header()
        if not token:
            return jsonify({"message": "Token missing"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Session expired. Please log in again"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        if payload.get('role') != 'student':
            return jsonify({"message": "Student access required"}), 403

        blocked = _account_gate(payload.get('user_id'))
        if blocked:
            return blocked

        request.user = payload
        return f(*args, **kwargs)
    return decorated