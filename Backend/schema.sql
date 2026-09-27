-- ============================================================
-- CampusMitra — Full Database Schema (clean, consolidated)
-- Sabhi ALTER TABLE wale columns yahan CREATE TABLE me hi
-- merge kar diye gaye hain, taaki fresh DB par ek hi baar
-- me pura structure ban jaaye.
-- ============================================================

CREATE DATABASE IF NOT EXISTS studenthub;
USE studenthub;

-- ============================================================
-- CORE TABLES — login + academic profile
-- ============================================================

-- Common login table (student, faculty, admin sabke liye)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    login_id VARCHAR(50) UNIQUE NOT NULL,      -- student: enrollment number | faculty/admin: email/faculty id
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('student', 'faculty', 'admin') NOT NULL,
    name VARCHAR(100) NOT NULL,
    status ENUM('active', 'inactive') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Students ka extra academic data
CREATE TABLE IF NOT EXISTS students (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    email VARCHAR(100),
    mobile VARCHAR(10),
    department VARCHAR(50),
    semester INT,
    division VARCHAR(5),
    academic_year VARCHAR(10),
    gender VARCHAR(20),
    father_name VARCHAR(100),
    father_mobile VARCHAR(10),
    mother_name VARCHAR(100),
    mother_mobile VARCHAR(10),
    parent_email VARCHAR(100),
    parent_address VARCHAR(255),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Existing DB par (jinme table pehle se bani hui hai) parent columns add karne ke liye:
-- ALTER TABLE students ADD COLUMN father_name VARCHAR(100);
-- ALTER TABLE students ADD COLUMN father_mobile VARCHAR(10);
-- ALTER TABLE students ADD COLUMN mother_name VARCHAR(100);
-- ALTER TABLE students ADD COLUMN mother_mobile VARCHAR(10);
-- ALTER TABLE students ADD COLUMN parent_email VARCHAR(100);
-- ALTER TABLE students ADD COLUMN parent_address VARCHAR(255);

-- Faculty ka extra data
CREATE TABLE IF NOT EXISTS faculty (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    email VARCHAR(100),
    department VARCHAR(50),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Forgot password OTP tracking
CREATE TABLE IF NOT EXISTS password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    otp VARCHAR(6) NOT NULL,
    is_verified BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- ADMIN PANEL TABLES — Academic Management
-- ============================================================

CREATE TABLE IF NOT EXISTS departments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(10) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS academic_years (
    id INT AUTO_INCREMENT PRIMARY KEY,
    year_label VARCHAR(10) NOT NULL,     -- e.g. 2025-26
    sem1_start DATE, sem1_end DATE,      -- har semester (1-6) ki apni start/end date
    sem2_start DATE, sem2_end DATE,      -- Promote Semester se hi bharti hai (ya yahan se
    sem3_start DATE, sem3_end DATE,      -- pehle se bhi daal sakte ho)
    sem4_start DATE, sem4_end DATE,
    sem5_start DATE, sem5_end DATE,
    sem6_start DATE, sem6_end DATE
);

-- ============================================================
-- Subject Management
-- ============================================================

CREATE TABLE IF NOT EXISTS subjects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    subject_code VARCHAR(20) UNIQUE NOT NULL,
    subject_name VARCHAR(100) NOT NULL,
    department VARCHAR(50),
    semester INT,
    credits INT DEFAULT 0,
    academic_year VARCHAR(10),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Faculty <-> Subject assignment (many-to-many)
CREATE TABLE IF NOT EXISTS faculty_subjects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    faculty_id INT NOT NULL,
    subject_id INT NOT NULL,
    semester INT,
    division VARCHAR(5),
    academic_year VARCHAR(10),
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

-- ============================================================
-- Timetable Management
-- ============================================================

CREATE TABLE IF NOT EXISTS timetable (
    id INT AUTO_INCREMENT PRIMARY KEY,
    department VARCHAR(50),
    semester INT,
    division VARCHAR(5),
    academic_year VARCHAR(10),
    day_of_week ENUM('Mon','Tue','Wed','Thu','Fri','Sat') NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    subject_id INT,
    faculty_id INT,
    room_no VARCHAR(20),
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL,
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE SET NULL
);

-- Exam timetable ki uploaded PDF/DOC files (Mid-Sem / Remedial) — weekly lecture
-- timetable se alag; ye poora exam schedule ek document ke roop me upload hota hai.
-- Exam timetable — Mid-Sem / Remedial exam ke slots, regular weekly `timetable`
-- table ki tarah hi structured hai (date + time + subject + room), file upload nahi.
CREATE TABLE IF NOT EXISTS exam_timetable (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_type ENUM('Mid-Sem','Remedial') NOT NULL,
    semester INT NOT NULL,
    division VARCHAR(5),
    academic_year VARCHAR(10),
    exam_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    subject_id INT,
    room_no VARCHAR(20),
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL
);

-- ============================================================
-- Attendance Management
-- ============================================================

CREATE TABLE IF NOT EXISTS attendance (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    subject_id INT NOT NULL,
    faculty_id INT,
    attendance_date DATE NOT NULL,
    status ENUM('present','absent') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE SET NULL,
    UNIQUE KEY uniq_attendance (student_id, subject_id, attendance_date)
);

-- ============================================================
-- Notes Management
-- ============================================================

CREATE TABLE IF NOT EXISTS notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    subject_id INT,
    faculty_id INT,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    semester INT,
    division VARCHAR(5),
    academic_year VARCHAR(10),
    file_path VARCHAR(255) NOT NULL,
    file_name VARCHAR(255),
    file_size INT,
    file_type VARCHAR(20),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL,
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE SET NULL
);

-- ============================================================
-- Assignment Management
-- ============================================================

CREATE TABLE IF NOT EXISTS assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    subject_id INT,
    faculty_id INT,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    semester INT,
    division VARCHAR(5),
    academic_year VARCHAR(10),
    due_date DATE,
    file_path VARCHAR(255),
    file_name VARCHAR(255),
    file_size INT,
    file_type VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL,
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS assignment_submissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    assignment_id INT NOT NULL,
    student_id INT NOT NULL,
    file_path VARCHAR(255),
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    marks_obtained INT,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

-- ============================================================
-- Marks Management
-- ============================================================

-- Faculty ka ek "class ke marks submit karna" ek request/batch hai — admin isi ko accept/reject/publish karta hai
CREATE TABLE IF NOT EXISTS marks_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    faculty_id INT NOT NULL,
    subject_id INT NOT NULL,
    exam_type VARCHAR(30) NOT NULL,
    semester INT,
    division VARCHAR(5),
    academic_year VARCHAR(10),
    max_marks DECIMAL(5,2),
    status ENUM('pending','approved','rejected','published') DEFAULT 'pending',
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL,
    reviewed_by INT,                    -- users.id (admin) jisne accept/reject kiya
    remarks VARCHAR(255),                -- reject reason (optional)
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS marks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    subject_id INT NOT NULL,
    exam_type VARCHAR(30) NOT NULL,     -- Mid-Semester / Remedial / Internal / Practical
    marks_obtained DECIMAL(5,2),
    max_marks DECIMAL(5,2),
    semester INT,
    academic_year VARCHAR(10),
    published BOOLEAN DEFAULT FALSE,    -- TRUE hote hi students ko dikhta hai
    request_id INT,                     -- kis faculty marks_request se aaya (admin ke direct-entry marks ke liye NULL)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (request_id) REFERENCES marks_requests(id) ON DELETE SET NULL
);

-- ============================================================
-- Fee Management
-- ============================================================

CREATE TABLE IF NOT EXISTS fees (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    fee_title VARCHAR(150),
    amount DECIMAL(10,2) NOT NULL,
    due_date DATE,
    semester INT,
    academic_year VARCHAR(10),
    status ENUM('paid','unpaid') DEFAULT 'unpaid',
    payment_link VARCHAR(255),
    paid_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

-- ============================================================
-- Notice Management
-- ============================================================

CREATE TABLE IF NOT EXISTS notices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(150) NOT NULL,
    content TEXT,
    category VARCHAR(30) DEFAULT 'Academic',   -- Academic / Event / Important
    target_role ENUM('all','student','faculty') DEFAULT 'all',
    target_user_id INT DEFAULT NULL,     -- non-NULL = sirf isi ek user (users.id) ke liye personal notice (e.g. marks accept/reject)
    semester INT,
    division VARCHAR(5),
    academic_year VARCHAR(10),
    posted_by INT,                       -- users.id of admin
    is_pinned BOOLEAN DEFAULT FALSE,
    file_path VARCHAR(255),              -- disk pe saved unique filename (attachment optional hai)
    file_name VARCHAR(255),              -- original filename, jo user ko dikhaya/download hoga
    file_size INT,
    file_type VARCHAR(10),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- notice ko kis user (student/faculty) ne dekh liya hai, uska record
CREATE TABLE IF NOT EXISTS notice_reads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NOT NULL,
    user_id INT NOT NULL,
    seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_notice_read (notice_id, user_id),
    FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- AI Chatbot
-- ============================================================

CREATE TABLE IF NOT EXISTS chatbot_faqs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    question VARCHAR(255) NOT NULL,
    answer TEXT NOT NULL,
    category VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chatbot_knowledge (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(150) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    message TEXT NOT NULL,
    response TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================
-- Reports / Security
-- ============================================================

CREATE TABLE IF NOT EXISTS login_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================
-- Settings
-- ============================================================

CREATE TABLE IF NOT EXISTS system_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT
);

-- ============================================================
-- Default admin account
-- Login: admin@1309 | Password woh hai jo pehle set kiya tha
-- (hash yahan copy kiya gaya hai, plain password kahin store nahi hota)
-- ============================================================

INSERT INTO users (login_id, password_hash, role, name, status)
VALUES (
    'admin@1309',
    '$2b$12$b9Asg7N4pz8V1uHajxCPKuTHL0GOrIz.ZORARBLJjNt9XyKv5Ju4K',
    'admin',
    'Admin',
    'active'
);

-- Run this once on your existing `studenthub` database.
-- It updates the users.status column to allow 'pending' as a value,
-- needed for the new student-approval workflow.

ALTER TABLE users MODIFY status ENUM('active','inactive','pending') DEFAULT 'active';

select * from users where role = 'faculty';

UPDATE users
SET password_hash = '$2b$12$m8Can81yIDmLm60l/oCOiu/XKJpqMCLBoYTfbNqYdiVNWs.b3LiDm'
WHERE login_id = 'faculty001@123'
  AND role = 'faculty';

-- ============================================================
-- Seed data: existing academic years (jo pehle se Batch dropdowns
-- me hardcoded the) ko Academic Year master table me daal do.
-- Run this once on your existing `studenthub` database.
-- ============================================================

INSERT INTO academic_years (year_label, is_current)
SELECT * FROM (SELECT '2024-25' AS year_label, FALSE AS is_current) AS tmp
WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE year_label = '2024-25');

INSERT INTO academic_years (year_label, is_current)
SELECT * FROM (SELECT '2025-26' AS year_label, FALSE AS is_current) AS tmp
WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE year_label = '2025-26');

INSERT INTO academic_years (year_label, is_current)
SELECT * FROM (SELECT '2026-27' AS year_label, TRUE AS is_current) AS tmp
WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE year_label = '2026-27');


-- ============================================================
-- Migration: academic_years me GTU-style Odd/Even term columns add karo.
-- Run this once on your existing `studenthub` database.
-- ============================================================

ALTER TABLE academic_years
    ADD COLUMN odd_term_start DATE,
    ADD COLUMN odd_term_end DATE,
    ADD COLUMN even_term_start DATE,
    ADD COLUMN even_term_end DATE,
    ADD COLUMN current_term ENUM('odd', 'even') DEFAULT NULL;


-- ============================================================
-- Migration: Odd/Even Term (shared date range) hata ke har semester
-- (1-6) ki apni alag start/end date rakho — GTU me har semester ki
-- exam/term date thodi alag-alag hoti hai.
-- Run this once on your existing `studenthub` database.
-- ============================================================

ALTER TABLE academic_years
    DROP COLUMN odd_term_start,
    DROP COLUMN odd_term_end,
    DROP COLUMN even_term_start,
    DROP COLUMN even_term_end,
    DROP COLUMN is_current,
    DROP COLUMN current_term,
    ADD COLUMN sem1_start DATE, ADD COLUMN sem1_end DATE,
    ADD COLUMN sem2_start DATE, ADD COLUMN sem2_end DATE,
    ADD COLUMN sem3_start DATE, ADD COLUMN sem3_end DATE,
    ADD COLUMN sem4_start DATE, ADD COLUMN sem4_end DATE,
    ADD COLUMN sem5_start DATE, ADD COLUMN sem5_end DATE,
    ADD COLUMN sem6_start DATE, ADD COLUMN sem6_end DATE;
    
      ALTER TABLE faculty ADD COLUMN short_name VARCHAR(50);