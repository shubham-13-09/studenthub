from functools import wraps
from flask import request, jsonify
import jwt

from app import SECRET_KEY


def _get_token_from_header():
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None
    return auth_header.split(' ', 1)[1]


def token_required(f):
    """Koi bhi logged-in user (student/faculty/admin) allow karta hai."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _get_token_from_header()
        if not token:
            return jsonify({"message": "Token missing"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Token expired, dobara login karo"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        request.user = payload   # {'user_id':..., 'role':..., 'exp':...}
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    """Sirf role='admin' wale users ko allow karta hai. admin_routes.py ke har route pe lagana hai."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _get_token_from_header()
        if not token:
            return jsonify({"message": "Token missing"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Token expired, dobara login karo"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        if payload.get('role') != 'admin':
            return jsonify({"message": "Admin access required"}), 403

        request.user = payload
        return f(*args, **kwargs)
    return decorated


def faculty_required(f):
    """Sirf role='faculty' wale users ko allow karta hai. faculty_routes.py ke har route pe lagana hai."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _get_token_from_header()
        if not token:
            return jsonify({"message": "Token missing"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Token expired, dobara login karo"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        if payload.get('role') != 'faculty':
            return jsonify({"message": "Faculty access required"}), 403

        request.user = payload
        return f(*args, **kwargs)
    return decorated


def student_required(f):
    """Sirf role='student' wale users ko allow karta hai. student_routes.py ke har route pe lagana hai."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _get_token_from_header()
        if not token:
            return jsonify({"message": "Token missing"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Token expired, dobara login karo"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        if payload.get('role') != 'student':
            return jsonify({"message": "Student access required"}), 403

        request.user = payload
        return f(*args, **kwargs)
    return decorated