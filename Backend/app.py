from flask import Flask, request, jsonify
from flask_cors import CORS
from db import get_db
import bcrypt
import jwt
import datetime
import random
import smtplib
import os
from email.mime.text import MIMEText
from email.utils import formataddr
from dotenv import load_dotenv

load_dotenv()   # .env file se GMAIL_USER, GMAIL_APP_PASSWORD load karega

app = Flask(__name__)
CORS(app)   # login.html/register.html se request allow karta hai

SECRET_KEY = os.getenv("JWT_SECRET_KEY")  # production me environment variable me rakho

GMAIL_USER = os.getenv("GMAIL_USER")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD")


def send_otp_email(to_email, otp):
    """Gmail SMTP ke through OTP email bhejta hai.
    Admin ke Settings > College information me save kiya hua college name/email
    bhejne wale ke display name aur Reply-To me use hota hai (asli SMTP login
    GMAIL_USER credentials se hi hota hai, college ka apna email sirf branding
    aur reply-to ke liye)."""
    college_name = "StudentHub"
    college_email = None
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
        conn.close()
    except Exception as e:
        print("OTP EMAIL SETTINGS LOOKUP ERROR:", repr(e))   # settings na milein to bhi OTP email bhejna nahi rukna chahiye

    subject = f"{college_name} - Password Reset OTP"
    contact_line = f"\n\nFor help, contact {college_email}." if college_email else ""
    body = f"Your OTP for password reset is: {otp}\n\nThis OTP is valid for 2 minutes. If you do not receive the request, please ignore it.{contact_line}"

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