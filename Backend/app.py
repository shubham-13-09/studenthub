from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from db import get_db, close_request_db
import bcrypt
import jwt
import datetime
import smtplib
import os
import json
import logging
from email.mime.text import MIMEText
from email.utils import formataddr
from dotenv import load_dotenv

load_dotenv()   # loads environment variables from .env

app = Flask(__name__)

# Security & Performance configurations
IS_DEBUG = os.getenv("FLASK_DEBUG", "False").lower() in ("true", "1", "t")
app.debug = IS_DEBUG

# Limit file upload size to 25 MB
app.config['MAX_CONTENT_LENGTH'] = int(os.getenv('MAX_CONTENT_LENGTH', 25 * 1024 * 1024))

# CORS: restrict to allowed frontend origins
allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "")
if allowed_origins_env.strip():
    allowed_origins = [o.strip() for o in allowed_origins_env.split(",") if o.strip()]
else:
    allowed_origins = [
        "http://localhost:5000",
        "http://127.0.0.1:5000",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "null"
    ]

CORS(app, origins=allowed_origins, supports_credentials=True)

# Rate limiter setup
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[],
    storage_uri="memory://"
)

SECRET_KEY = os.getenv("JWT_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("JWT_SECRET_KEY is missing. Set a long random value in Backend/.env (see .env.example).")
if len(SECRET_KEY) < 32:
    print("WARNING: JWT_SECRET_KEY is shorter than 32 characters. Generate a stronger one (see .env.example).")
GMAIL_USER = os.getenv("GMAIL_USER")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD")

# Auto-cleanup for DB connections in current request context
app.teardown_appcontext(close_request_db)

@app.errorhandler(413)
def request_entity_too_large(error):
    return jsonify({"message": "File size exceeds the maximum limit (25 MB)"}), 413

@app.errorhandler(429)
def ratelimit_handler(e):
    return jsonify({"message": "Too many requests. Please slow down and try again later."}), 429

@app.after_request
def sanitize_error_responses(response):
    """Prevents database errors, system paths, and internal stack traces from leaking to clients in production."""
    # Any JSON reply (even a 200) that carries an internal "error" detail is cleaned: the detail goes to the server log only.
    if not app.debug and response.is_json:
        try:
            data = response.get_json(silent=True)
            if isinstance(data, dict) and 'error' in data:
                app.logger.error("Server error on %s %s (HTTP %s): %s", request.method, request.path, response.status_code, data.get('error'))
                data.pop('error', None)
                response.set_data(json.dumps(data))
        except Exception:
            pass
    return response


def send_otp_email(to_email, otp):
    """Sends the OTP email through Gmail SMTP.
    The college name/email saved by the admin in Settings > College information
    is used for the sender's display name and Reply-To."""
    college_name = "StudentHub"
    college_email = None
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (%s, %s)",
            ('college_name', 'college_email')
        )
        for row in cursor.fetchall():
            if row['setting_key'] == 'college_name' and row['setting_value']:
                college_name = row['setting_value']
            elif row['setting_key'] == 'college_email' and row['setting_value']:
                college_email = row['setting_value']
        cursor.close()
    except Exception as e:
        print("OTP EMAIL SETTINGS LOOKUP ERROR:", repr(e))
    finally:
        if conn and conn.is_connected():
            conn.close()

    subject = f"{college_name} - Password Reset OTP"
    contact_line = f"\n\nFor help, contact {college_email}." if college_email else ""
    body = f"Your OTP for password reset is: {otp}\n\nThis OTP is valid for 2 minutes. If you did not request this, please ignore it.{contact_line}"

    msg = MIMEText(body)
    msg['Subject'] = subject
    msg['From'] = formataddr((college_name, GMAIL_USER))
    msg['To'] = to_email
    if college_email:
        msg['Reply-To'] = college_email

    with smtplib.SMTP('smtp.gmail.com', 587) as server:
        server.starttls()
        server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        server.sendmail(GMAIL_USER, to_email, msg.as_string())


import auth_routes
import admin_routes
import faculty_routes
import student_routes
import session_routes