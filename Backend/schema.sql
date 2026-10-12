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
    must_change_password BOOLEAN DEFAULT FALSE,
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
    whatsapp_number VARCHAR(15),
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
    short_name VARCHAR(50),
    whatsapp_number VARCHAR(15),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Forgot password OTP tracking
CREATE TABLE IF NOT EXISTS password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    otp VARCHAR(255) NOT NULL,
    attempts INT DEFAULT 0,
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
    subject_type ENUM('Theory','Lab','Theory + Lab') NOT NULL DEFAULT 'Theory',
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
    session_type ENUM('Lecture','Lab') NOT NULL DEFAULT 'Lecture',
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
    session_type ENUM('Lecture','Lab') NOT NULL DEFAULT 'Lecture',
    status ENUM('present','absent') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE SET NULL,
    UNIQUE KEY uniq_attendance (student_id, subject_id, attendance_date, session_type)
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
-- Existing DB par WhatsApp number add karne ke liye:
-- ALTER TABLE faculty ADD COLUMN whatsapp_number VARCHAR(15);
-- ALTER TABLE students ADD COLUMN whatsapp_number VARCHAR(15);










-- ============================================================
-- StudentHub / CampusMitra - chatbot FAQs (64 rows)
-- Pehle aapke 50 sawal (jawab portal ke code se verify kiye hue),
-- phir wo common sawal jo list me nahi the.
--
-- SECURITY:
--  * Naya column `audience` (all / student / faculty / admin) joda gaya hai.
--    Chatbot ko role JWT token se (server par) pata karke sirf
--    audience IN ('all', <role>) wale FAQs search karne chahiye.
--    Isse student ko faculty/admin ke kaam ke tareeke nahi dikhenge.
--  * FAQ me kabhi password, OTP, API key, phone number ya personal data
--    na likhein. Contact details sirf portal ke Faculty section se aate hain.
--
-- RUN: sirf EK baar. Pehle backup lein. Agar pichli file
-- (chatbot_faqs_50.sql) chala chuke hain to pehle wo rows hata dein.
-- ============================================================

USE studenthub;

ALTER TABLE chatbot_faqs
  ADD COLUMN audience ENUM('all','student','faculty','admin') NOT NULL DEFAULT 'all';

INSERT INTO chatbot_faqs (question, answer, category, audience) VALUES
('How do I log in to StudentHub?',
 'Open the login page, enter your login ID and password, and click Login. Students use their enrollment number, faculty use their faculty ID or registered email, and admin uses the admin ID or email.',
 'Login', 'all'),
('Can I log in using my enrollment number?',
 'Yes. Students log in with their enrollment number and password.',
 'Login', 'all'),
('Can I log in using my email address?',
 'Yes. Students and faculty can also log in with the email address saved in their profile, instead of the enrollment number or faculty ID.',
 'Login', 'all'),
('What should I do if I forget my password?',
 'On the login page click Forgot Password, enter your ID and registered email, and an OTP will be sent to that email. Verify the OTP and then set a new password.',
 'Password', 'all'),
('How can I change my StudentHub password?',
 'After logging in, open Settings, enter your current password and your new password (minimum 8 characters) and save.',
 'Password', 'all'),
('Why is my StudentHub account not allowing me to log in?',
 'Check your login ID and password first. Also, a new account works only after the admin approves it, and an inactive account cannot log in. If it still fails, use Forgot Password or contact the admin.',
 'Login', 'all'),
('How do I log out of StudentHub?',
 'Use the logout option in the portal menu. Always log out when you use a shared or public computer.',
 'Login', 'all'),
('How can I enable dark mode?',
 'Tap the moon icon in the top bar, or open Settings and switch on Dark mode. Use the same option again to go back to the light theme.',
 'Settings', 'all'),
('Where can I see my student dashboard?',
 'Your dashboard is the Home page of the student panel. It shows a quick summary such as today timetable and the chatbot.',
 'Dashboard', 'student'),
('How can I check my overall attendance percentage?',
 'Open the Attendance section to see your overall attendance percentage. You can also ask the chatbot: what is my attendance.',
 'Attendance', 'student'),
('How can I check attendance for a specific subject?',
 'Open the Attendance section. It lists every subject of your semester with its own attendance percentage.',
 'Attendance', 'student'),
('Where can I see my Mid-Sem marks?',
 'Open the Results section. Mid-Semester marks appear there once they are published by the college.',
 'Results', 'student'),
('Where can I see my Remedial marks?',
 'Open the Results section. Remedial marks appear there once they are published.',
 'Results', 'student'),
('Where can I see my Internal marks?',
 'Open the Results section. Internal marks appear there once they are published.',
 'Results', 'student'),
('Where can I see my Practical marks?',
 'Open the Results section. Practical marks appear there once they are published.',
 'Results', 'student'),
('Where can I check my exam timetable?',
 'Open the Timetable section and choose the exam timetable (Mid-Semester or Remedial). If it says not published, it has not been released for your class yet. Also watch the Notices section.',
 'Timetable', 'student'),
('Where can I check today timetable?',
 'See Today timetable on the Home page, or open the Timetable section. You can also ask the chatbot: today timetable.',
 'Timetable', 'student'),
('How can I view my weekly timetable?',
 'Open the Timetable section. On a computer it shows a weekly grid, and on a phone it shows day-wise tabs.',
 'Timetable', 'student'),
('How can I download study notes?',
 'Open the Notes section, find the note for your subject and use the download option. Only notes uploaded for your own class are available.',
 'Notes', 'student'),
('Where can I find my assignments?',
 'Open the Assignments section. It lists the assignments for your semester and division, including the ones meant for all divisions.',
 'Assignments', 'student'),
('How can I check an assignment due date?',
 'The due date is shown with each assignment in the Assignments section. You can also ask the chatbot: pending assignments.',
 'Assignments', 'student'),
('How can I download an assignment attachment?',
 'Open the assignment in the Assignments section and use the download option to get the file attached by your faculty.',
 'Assignments', 'student'),
('How can I check whether an assignment is submitted?',
 'Open the Assignments section. Assignments you have not submitted are shown as pending. You can also ask the chatbot: pending assignments.',
 'Assignments', 'student'),
('How can I check my assignment submission status?',
 'Open the Assignments section to see whether each assignment is submitted or still pending. If you submit again, the new file replaces the old one.',
 'Assignments', 'student'),
('Where can I see college notices?',
 'Open the Notices section. Unread notices show a badge count in the menu. You can also ask the chatbot: latest notices.',
 'Notices', 'student'),
('How can I check important notices?',
 'Open the Notices section. Notices that the college pins as important are shown at the top of the list. Unread ones show a badge count.',
 'Notices', 'student'),
('Where can I find faculty contact details?',
 'Open the Faculty section. It lists the faculty of your class with the contact details saved by the college.',
 'Faculty', 'student'),
('How can I find a faculty member email address?',
 'Open the Faculty section and look at the faculty member card. The email saved by the college is shown there.',
 'Faculty', 'student'),
('How can I find a faculty member mobile or WhatsApp number?',
 'Open the Faculty section. The WhatsApp number saved by the college is shown on the faculty card. Please use it only for study-related matters.',
 'Faculty', 'student'),
('Where can I check my fee status?',
 'Open the Fees section to see each fee with its due date and paid or unpaid status. You can also ask the chatbot: fees due.',
 'Fees', 'student'),
('How can I check the amount of a fee?',
 'The Fees section shows the title, amount and due date of every fee added for you.',
 'Fees', 'student'),
('Where can I find the fee payment link?',
 'If the college has added a payment link for an unpaid fee, a Pay now link appears next to that fee in the Fees section. If there is no link, contact the college office for the payment method.',
 'Fees', 'student'),
('How can I update my student profile information?',
 'Open Settings, edit the details that are allowed such as email or mobile, and save. For details like semester or division, contact the admin.',
 'Profile', 'student'),
('How can I enable attendance alerts?',
 'Open Settings and switch on Attendance alerts. You will be alerted when a subject drops below 75 percent. This setting is saved on the device and browser you are using.',
 'Settings', 'student'),
('How can faculty mark student attendance?',
 'Open Attendance in the faculty panel, select the subject, class and date, mark each student present or absent, and save. The whole class attendance for that day is saved in one go.',
 'Attendance', 'faculty'),
('How can faculty edit attendance?',
 'Open Attendance, select the same subject, class and date, change the marks and save again. The saved attendance for that day is updated.',
 'Attendance', 'faculty'),
('How can faculty view the class list?',
 'Open Students in the faculty panel, choose the class (semester and division), and the list of students appears. You can search within the list. You see only the classes assigned to you.',
 'Students', 'faculty'),
('How can faculty check students with low attendance?',
 'Open Students in the faculty panel. Each student shows an attendance badge: 85 percent and above is good, 75 to 84 is a warning, and below 75 is low.',
 'Attendance', 'faculty'),
('How can faculty enter student marks?',
 'Open Marks Entry, select the subject, class and exam type (Mid-Semester, Remedial, Internal or Practical), enter the marks and save.',
 'Marks', 'faculty'),
('How can faculty submit marks for approval?',
 'After entering marks in Marks Entry, submit them as a request to the admin. The request stays pending until the admin approves or rejects it, and students see the marks only after the result is published. You can submit again only after a request is rejected.',
 'Marks', 'faculty'),
('How can faculty upload study materials?',
 'Open Materials in the faculty panel, choose the subject and class, select the file and upload it. Students of that class can then download it from their Notes section.',
 'Materials', 'faculty'),
('What file types can faculty upload as study materials?',
 'Only PDF, DOC, DOCX, PPT and PPTX files are allowed.',
 'Materials', 'faculty'),
('How can faculty create an assignment?',
 'Open Assignments in the faculty panel, add the title, subject, semester and division, due date and an optional question file (PDF, DOC, DOCX, PPT or PPTX), then save.',
 'Assignments', 'faculty'),
('How can faculty check assignment submissions?',
 'Open Assignments and select the assignment. You will see all eligible students with their submission status, submission date and marks if given.',
 'Assignments', 'faculty'),
('How can faculty identify late submissions?',
 'Open the assignment and compare each student submission date with the assignment due date. Students who have not submitted show as not submitted.',
 'Assignments', 'faculty'),
('How can faculty post a notice for students?',
 'Open Notices in the faculty panel, write the notice, choose who it is for, optionally attach a file, and post it.',
 'Notices', 'faculty'),
('How can an admin add a new student?',
 'In the admin panel open Students and choose Add Student, then fill in the details. Students who register themselves appear as pending and can be activated from the same Students area.',
 'Admin', 'admin'),
('How can an admin add or manage faculty?',
 'In the admin panel open Faculty. You can add, view, edit or delete faculty, and assign a semester and subjects to each faculty member.',
 'Admin', 'admin'),
('How can an admin manage subjects and timetable slots?',
 'Open Subjects to add, edit or delete subjects, and open Timetable to add, view, edit or delete timetable slots.',
 'Admin', 'admin'),
('How can an admin manage FAQs and the AI Chatbot knowledge base?',
 'Open AI Chatbot in the admin panel. It has FAQ Management for questions and answers, AI Knowledge Base for longer reference text, and Chat History to review past chats. Do not put passwords or personal data in FAQs.',
 'Admin', 'admin'),
('How do I register on the portal?',
 'Open the Register page and fill in every required field: name, enrollment number, email, mobile, gender, department, semester, division, academic year, parent details and a password. After submitting, wait for the admin to approve your account.',
 'Registration', 'all'),
('Why can I not log in right after registering?',
 'New accounts stay pending until the admin approves them. You can log in once your account is approved.',
 'Registration', 'all'),
('How long is the OTP valid?',
 'The OTP is valid for 2 minutes. If it expires, request a new OTP.',
 'Password', 'all'),
('I did not receive the OTP email. What should I do?',
 'Check your spam folder, make sure you entered the same ID and email you registered with, and try again after a minute.',
 'Password', 'all'),
('What are the password rules?',
 'Your password must be at least 8 characters long. Do not share it with anyone.',
 'Password', 'all'),
('Which file types are allowed for assignment submission?',
 'Only PDF, DOC, DOCX, PPT and PPTX files are allowed.',
 'Assignments', 'student'),
('What is the minimum attendance required?',
 'The portal flags attendance below 75 percent. Please confirm the official rule with your college.',
 'Attendance', 'student'),
('Why are my marks not visible?',
 'Marks are shown only after they are published. If your exam is over and marks are still missing, contact your subject faculty.',
 'Results', 'student'),
('What is the passing percentage?',
 'The portal uses 40 percent as the default passing percentage unless the admin has set a different value.',
 'Results', 'student'),
('My fee is paid but it shows unpaid. What should I do?',
 'The status is updated by faculty or admin after payment is confirmed. For offline payments allow 24 to 48 hours. If it still shows unpaid, keep your receipt and contact the accounts office.',
 'Fees', 'student'),
('Why can I not download a note?',
 'A note can be downloaded only by the class it was uploaded for. If it is not meant for your semester or division, the portal will not allow it.',
 'Notes', 'student'),
('My dashboard says semester or division is not set up. What should I do?',
 'Your academic details are not configured yet. Please contact the admin.',
 'Profile', 'student'),
('What can the chatbot help me with?',
 'You can ask about your attendance, pending assignments, fees due, today timetable and latest notices, along with common portal questions.',
 'Chatbot', 'all'),
('Whom should I contact if the portal is not working?',
 'Refresh the page and log in again. If the problem continues, contact your college admin and mention what you were doing and any message shown.',
 'Help', 'all');

-- Check: SELECT audience, COUNT(*) FROM chatbot_faqs GROUP BY audience;

SELECT COUNT(*) FROM chatbot_faqs;

CREATE TABLE chatbot_faqs_backup AS SELECT * FROM chatbot_faqs;
SET SQL_SAFE_UPDATES = 0;

DELETE f1
FROM chatbot_faqs f1
JOIN chatbot_faqs f2
  ON f1.question = f2.question
 AND f1.id > f2.id;

SET SQL_SAFE_UPDATES = 1;

SELECT COUNT(*) FROM chatbot_faqs;
SELECT audience, COUNT(*) FROM chatbot_faqs GROUP BY audience;
ALTER TABLE chatbot_faqs ADD UNIQUE KEY uq_faq_question (question);
DROP TABLE chatbot_faqs_backup;

SELECT u.login_id, u.name, s.semester, s.division, s.academic_year, s.department
FROM users u LEFT JOIN students s ON s.user_id = u.id
WHERE u.login_id = '246250307XXX';

   USE studenthub
   
   -- Sem 5 students import (95) | Batch 2024-25 | Sem 5 | password = enrollment number
USE studenthub;
START TRANSACTION;

INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307001', '$2b$12$uEcbXGQC30SPV/ARvwiZhOTRUEfjKuOqDlhV6ey6iFtFeJNkpEN1O', 'student', 'Jay Ramshibhai Ambaliya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Ramshibhai' FROM users u WHERE u.login_id='246250307001' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307002', '$2b$12$boxkHDV2fMVahgJfdCNKHuN5xl8fbYDFOEpuwBN9aSx65CqhZ1Edu', 'student', 'Ahmadraza Sahidrajak Ansari', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Sahidrajak' FROM users u WHERE u.login_id='246250307002' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307003', '$2b$12$FulegnItbmZ.hlIFi0upVOdE2ML81GwPkKCCAEvRrs5cl12hKBNa2', 'student', 'Jenil Ritesh Barad', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Ritesh' FROM users u WHERE u.login_id='246250307003' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307005', '$2b$12$9WGBjUiZ2N7TIJazON0mUu9p5mclFMmt7oUXRSy/u4vwVZx2uamqu', 'student', 'Shalaka Sanjaybhai Bosamiya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Sanjaybhai' FROM users u WHERE u.login_id='246250307005' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307006', '$2b$12$A/gsBgkHSEHgPBurrQ7VPuWEusXxhuNOmdgASZQuuMsoPBbTtkzym', 'student', 'Krishna Sanjaybhai Chandra', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Sanjaybhai' FROM users u WHERE u.login_id='246250307006' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307007', '$2b$12$xiE1w5V.h/TPJ2la7TAQkef17jg.ALClSByzikM0oNTsCGFOSGaGu', 'student', 'Sujal Manishbhai Chandra', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Manishbhai' FROM users u WHERE u.login_id='246250307007' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307008', '$2b$12$0Qaw595hwvXP8pcHvUafw.OFCYdsJxS4edXq6yvAkbpqmvEbyhTfW', 'student', 'Durva Hitesh Chauhan', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Hitesh' FROM users u WHERE u.login_id='246250307008' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307009', '$2b$12$E5RM/k3P4QUb7DGtOIKZYOLeziMae8EqjP/fw3PsG0paKn.v/WBEG', 'student', 'Yuvraj Nileshbhai Chauhan', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Nileshbhai' FROM users u WHERE u.login_id='246250307009' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307010', '$2b$12$NuTVrr2t.nBnQFHbomRJ8.7AiORZ4PGTfpiwiP2qr2To2X/xH6V8.', 'student', 'Harshit Jigneshbhai Chavda', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Jigneshbhai' FROM users u WHERE u.login_id='246250307010' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307013', '$2b$12$KuN8VkBqW/a1gXQr3y/VWOrCkOvhwjFmK3hx5z05t4PYfu5LHl24C', 'student', 'Kushal Jaykumar Chhatbar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Jaykumar' FROM users u WHERE u.login_id='246250307013' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307014', '$2b$12$ypPxraTq/KBlkUK3Y1RWfO3uIziCoLnsAGTH9thZ0ptvEOnS2d2Cm', 'student', 'Ziya Atul Chudasama', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Atul' FROM users u WHERE u.login_id='246250307014' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307015', '$2b$12$bqtDuvUtbzujSqSUH7RhwO9HpobRywq3P1LN1zrRTiOvUxi7SSyh6', 'student', 'Jaydeep Sajanbhai Dangar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Sajanbhai' FROM users u WHERE u.login_id='246250307015' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307016', '$2b$12$KFu1va9FugNdKinkbXu9NeunwuFaHnhBbIX5NsQIYIPE1iBgDGnQi', 'student', 'Sakhi Shyam Davda', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Shyam' FROM users u WHERE u.login_id='246250307016' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307018', '$2b$12$F2miXDFpBO1Q2ai2bN/ou.02oWsBLr2vgDZ1YeXgsBKrQQRnIQ23u', 'student', 'Sahil Jentibhai Davera', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Jentibhai' FROM users u WHERE u.login_id='246250307018' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307019', '$2b$12$PgXvfsvvx2px2XMQrHnbyO7eW1pWCmIrUVldTLbigEOaVOodMBY7S', 'student', 'Shubham Bipinbhai Devmurari', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Bipinbhai' FROM users u WHERE u.login_id='246250307019' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307021', '$2b$12$TRx86I/C24HHJrfKyZnui.NsH32Y5BwBtdF5X8k1Kqij.RrCLaUPO', 'student', 'Yash Premjibhai Dhokiya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Premjibhai' FROM users u WHERE u.login_id='246250307021' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307022', '$2b$12$tf097wElqu4R4eFRpCtsRuMOaObRbtQmuAtY2kC77QKycimWeVq8y', 'student', 'Bhranti Punitkumar Dholariya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Punitkumar' FROM users u WHERE u.login_id='246250307022' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307023', '$2b$12$RQ7tHQKBwE/Ur5y9dJSGue0DgCTRQSpxfDi0SDWFeM24rS3NpjEZC', 'student', 'Jemish Kishorbhai Gagiya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Kishorbhai' FROM users u WHERE u.login_id='246250307023' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307024', '$2b$12$jEw.xXDqna556shZsoGQlOAdD06ni5OV/C.i/ZqeNZkXCH2D6x//C', 'student', 'Khushi Bipinbhai Gangajaliya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Bipinbhai' FROM users u WHERE u.login_id='246250307024' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307025', '$2b$12$DoyBgzASC5Cq416EN1sCze1pe.dftdQwOe7WxXWiAn17esrsWUxwy', 'student', 'Diya Jasminkumar Ghumra', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Jasminkumar' FROM users u WHERE u.login_id='246250307025' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307026', '$2b$12$j3FZRZvwZUdXyTK.kxnBLOuoBOR2P.O0PPhMiQBCjMQimCHMao3sm', 'student', 'Rishi Mayur Ghumra', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Mayur' FROM users u WHERE u.login_id='246250307026' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307027', '$2b$12$c4hfO2HWKXXMw6Sc.DzREe7PbooErnN965Xa3GViLf1HvnU/wHCIi', 'student', 'Helly Haresh Godhani', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Haresh' FROM users u WHERE u.login_id='246250307027' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307028', '$2b$12$vzXRMYDRTr9kqACuf1uxTOo7Y9jYpOoPb8mSsamBnL2dns58AGWwO', 'student', 'Priyesh Rajesh Gohel', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Rajesh' FROM users u WHERE u.login_id='246250307028' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307030', '$2b$12$zCoqNzdIq99VrJIKY016BuvgQn2zbuihvyIrcc5CeYly4dracDwhy', 'student', 'Arjun Markhibhai Gojiya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Markhibhai' FROM users u WHERE u.login_id='246250307030' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307031', '$2b$12$bjW5Ev6ANLUsijPkwUAjfOrXmmA2WCk40DdFInicrCguCazivdJXW', 'student', 'Chirag Mukeshbhai Gojiya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Mukeshbhai' FROM users u WHERE u.login_id='246250307031' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307032', '$2b$12$4SB0qKeJ6Vd9nYhAtDVJ2e2ng0rVoXmAzfaCzU2H6sPDiA5JuIOjC', 'student', 'Deep Girishbhai Gorfad', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Girishbhai' FROM users u WHERE u.login_id='246250307032' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307033', '$2b$12$j1loMLjrSkl58E4jl7T9uOx2r7G2vtzg0r9iHIlX/cMwusonuYDSG', 'student', 'Shriya Alpesh Gudka', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Alpesh' FROM users u WHERE u.login_id='246250307033' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307034', '$2b$12$k.oLlCsAuPMJHsawgFuNWeKMpvdpweHWCcDaMDm335nbyq67ggjuW', 'student', 'Shubh Nejul Gudka', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Nejul' FROM users u WHERE u.login_id='246250307034' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307035', '$2b$12$7h4tZO/Mu9fnuNps5XOw1.NczYYsn4WCepfFy8qGHnYi3ueoVTARS', 'student', 'Nishitaba Dashrathsinh Jadeja', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Dashrathsinh' FROM users u WHERE u.login_id='246250307035' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307036', '$2b$12$cvUPmukhuDjipJYDNQMPHeNJGsn7MTuMYrJlfI69vp2ZGIowZ1u56', 'student', 'Jainil Dharmesh Chavda', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Dharmesh' FROM users u WHERE u.login_id='246250307036' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307037', '$2b$12$1aiSb5.ggZeiaScd31aV8eXL/3umyG6l0RQ86.nCqamOOMEOohBVW', 'student', 'Dhairya Pritesh Joisar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Pritesh' FROM users u WHERE u.login_id='246250307037' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307038', '$2b$12$f0gZakVEbrgdJ5etgaldNetzwVTM3DWrlmNVQRPKsUbRi8dzO8fN.', 'student', 'Veer Shaileshbhai Joishar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Shaileshbhai' FROM users u WHERE u.login_id='246250307038' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307039', '$2b$12$xy6BWGONW0ycR84.VWv.K.6hIdH8xhBpEG9DJCHvgzUJprlKz28ma', 'student', 'Darsh Sanjaybhai Joshi', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Sanjaybhai' FROM users u WHERE u.login_id='246250307039' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307040', '$2b$12$Rv1MZIDsSB47MAeEZaxTMe/ndy4hkpCtQvlZ9eh06yaTJsv6tfSIm', 'student', 'Maulik Nirajbhai Joshi', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Nirajbhai' FROM users u WHERE u.login_id='246250307040' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307041', '$2b$12$aHkW0wjs0AYXYaieweex8uC.Lub8GmDeMsOdbkMdZE7/9PhzKPvCO', 'student', 'Mayank Hiteshbhai Joshi', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Hiteshbhai' FROM users u WHERE u.login_id='246250307041' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307043', '$2b$12$d8dgSljp2ffSfLP6pXWOBOpNEPJEg3.tCyjpSywkeAYYpF8q8BsEG', 'student', 'Radha Ajaybhai Kalaria', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Ajaybhai' FROM users u WHERE u.login_id='246250307043' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307045', '$2b$12$O.l3ZBZwTqa/syPJCPeCHO0x2kNGeZCU16n9O0N3yJRwe07a/pGDi', 'student', 'Sumit Dharamshibhai Kanzariya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Dharamshibhai' FROM users u WHERE u.login_id='246250307045' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307046', '$2b$12$a2Qgl0Aj5pGCVnQ/XV.LkuvCX9IG6tuXJ7Uigt7pSpWLeJS6zLYji', 'student', 'Shyam Ramnikbhai Karshariya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Ramnikbhai' FROM users u WHERE u.login_id='246250307046' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307047', '$2b$12$LP8oADeI/22B9UdnwNMuX.Gx5zfQmb/RNJKro5VUKDSojBeWFRn8e', 'student', 'Nirav Pradipbhai Katarmal', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Pradipbhai' FROM users u WHERE u.login_id='246250307047' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307049', '$2b$12$tPb/h5q4YcT7MQjhJ3ZYdOh0Itf.ntqP8JK2A7QP4D2gphDBtVeO.', 'student', 'Suha Mehboob Khan', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Mehboob' FROM users u WHERE u.login_id='246250307049' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307050', '$2b$12$gyD6PBi32zvH8NNRXIAzPuKpgsZ2dnLLU9QFgIpJU4JtE0/2sl3AS', 'student', 'Daksh Abhay Khona', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Abhay' FROM users u WHERE u.login_id='246250307050' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307051', '$2b$12$cJ2dya60S3QsU34ZxTuqxO/eKvN6XgjEutPeT39yM3.s/IVDDCyES', 'student', 'Dev Girishbhai Koradia', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Girishbhai' FROM users u WHERE u.login_id='246250307051' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307055', '$2b$12$sNzBsDrlGiZdHB.4m2q.iOYKL1mldmU41P1YBY3FAFO.b7IrCc67K', 'student', 'Krish Manojbhai Makwana', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Manojbhai' FROM users u WHERE u.login_id='246250307055' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307056', '$2b$12$Mr99WLWSMYxrWelB2trRJ.dNXq7IUr7RHHjaJQl7aGHYCioJPTrqa', 'student', 'Paras Gangjibhai Maru', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Gangjibhai' FROM users u WHERE u.login_id='246250307056' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307057', '$2b$12$tsYzlEfq.v4TnOz/amBCB.g9HYtO/1kPAX0Eb3TgSIRk08NeVu.6K', 'student', 'Aditya Amitgiri Meghnathi', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Amitgiri' FROM users u WHERE u.login_id='246250307057' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307058', '$2b$12$k9Go5mWm0uBIIDDDLaYatOEWIY99sXs1ouEvSisI4HcSDaXZdW0.2', 'student', 'Drashan Mehulbhai Mehta', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Mehulbhai' FROM users u WHERE u.login_id='246250307058' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307059', '$2b$12$Qvmt7jxocSh.tJULHvaKPup9j/dzkoGqwx4EBFYIhtPF7RAFFkpqi', 'student', 'Ruchitaa Jignesh Mehta', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Jignesh' FROM users u WHERE u.login_id='246250307059' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307061', '$2b$12$xqoXfwOuChi7DZSnXiot1.2MfJ2/XjDGXcV0NojNpM3uP4KRmS/Ai', 'student', 'M.Safvan Rafikbhai Metar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Rafikbhai' FROM users u WHERE u.login_id='246250307061' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307062', '$2b$12$LL9vdTTJYE0gd1FXCVGAQukTAnbkT5LLsFNvaukfxJUQ6VDcMvVAC', 'student', 'Hrutav Harishbhai Modha', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Harishbhai' FROM users u WHERE u.login_id='246250307062' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307063', '$2b$12$QtKFONXWTacN/7XYeUdIqOTfuEMDKOfDhaELyJyioGSA6mfy/wXZm', 'student', 'Karan Shaileshbhai Nakum', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'A', '2024-25', 'Shaileshbhai' FROM users u WHERE u.login_id='246250307063' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307064', '$2b$12$i7H1wELh0sBxnwk9eclZvOi24bqEuB8ZlX7S6iF98E24BOMUsp8hm', 'student', 'Ravi Hasmukh Nakum', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Hasmukh' FROM users u WHERE u.login_id='246250307064' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307065', '$2b$12$Us.5uTnxvIIHBUAVWLdxOudCFZPFoDHQKQas5aqqE6nNOGikFja3i', 'student', 'Shyam Nanjibhai Nakum', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Nanjibhai' FROM users u WHERE u.login_id='246250307065' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307066', '$2b$12$3GCcrn0CrwsZH8f3gfKnmuybcD3PQ5julx2RCppLgAJSOtXlRygtS', 'student', 'Darshan Jaydeep Nanda', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Jaydeep' FROM users u WHERE u.login_id='246250307066' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307067', '$2b$12$dtB133f/goYKVwYmUJwom.TN0Gp0gGgDxorgIBBmGlnSlWCUjCdwK', 'student', 'Kevalbhai Varjangbhai Nangesh', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Varjangbhai' FROM users u WHERE u.login_id='246250307067' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307068', '$2b$12$CzRn5LWEk9qL5i2Zrve6cebVWk.hkY6GQv75L8yrCoDcVg3yaCO3e', 'student', 'Jignesh Dineshbhai Odich', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Dineshbhai' FROM users u WHERE u.login_id='246250307068' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307070', '$2b$12$WIdiKOIad440Vf77kS9nmeTUoHJ/x/WWxmn7gzk0EIrYo8IhEDUPq', 'student', 'Dhruv Deepakbhai Padia', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Deepakbhai' FROM users u WHERE u.login_id='246250307070' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307072', '$2b$12$HNxL61.4ATN/7DinXtOF7.fdQ7y5K1q1xrlA/ulwPc.n61SnmOkQa', 'student', 'Hani Vipulbhai Pandya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Vipulbhai' FROM users u WHERE u.login_id='246250307072' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307073', '$2b$12$F6WuoG/3Stq1nfHwHZARieF1nKKao2NZrewtA2CWNiJcb3Kds9hI6', 'student', 'Shivam Pankajbhai Pandya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Pankajbhai' FROM users u WHERE u.login_id='246250307073' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307074', '$2b$12$Ivwu7f/ow7HH9AQV7zVaneqkzns8KGGeH.pknZdIfS8zKCcJB0TNu', 'student', 'Dhruv Bharatbhai Pankhaniya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Bharatbhai' FROM users u WHERE u.login_id='246250307074' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307075', '$2b$12$0UwSkzTlW3bBPQj5zFPQb.Vn3JtNTaNWBp1/Zx4rZf7jE77FhE/Uy', 'student', 'Krishna Hiteshbhai Pankhaniya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Hiteshbhai' FROM users u WHERE u.login_id='246250307075' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307076', '$2b$12$PhzyHgCD.4RvMlLwtTcr5O71HYcUMg9lQXZpQWG8lagJwgeE7lLMa', 'student', 'Vivek Dineshbhai Pankhaniya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Dineshbhai' FROM users u WHERE u.login_id='246250307076' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307077', '$2b$12$qlk/WclpLn11YlpJSjZKA.CgnEdBK4PXDesBBrQbrgyffFMmUB4ua', 'student', 'Meet Jatinbhai Parekh', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Jatinbhai' FROM users u WHERE u.login_id='246250307077' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307078', '$2b$12$Pr1YNTjcs78bq6LtAbPP2.LQSwSNQG4H.A44HqNlIZHyZPBle6Opi', 'student', 'Aarti Mohanbhai Parmar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Mohanbhai' FROM users u WHERE u.login_id='246250307078' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307080', '$2b$12$itgLwNQ/FZ1qhylVsYUStuqCR1hGfeaAxKNvkRKfIiRpRh2YyMqCy', 'student', 'Harshkumar Mansukhbhai Parmar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Mansukhbhai' FROM users u WHERE u.login_id='246250307080' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307082', '$2b$12$8yzwhMV306JwHMp1BsZ5jOwdFMAAum.HrzybvlOtPe8IbsmqaKFMG', 'student', 'Mehul Nagjibhai Parmar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Nagjibhai' FROM users u WHERE u.login_id='246250307082' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307083', '$2b$12$fqmTfrl2MYWuYUxcKWZAOedGWkA3fTRIJe.T9HzSyYqbixvTfMPfW', 'student', 'Vishva Rakeshbhai Parmar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Rakeshbhai' FROM users u WHERE u.login_id='246250307083' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307084', '$2b$12$P/dG0pKpYObma5zoQlTVAO03e4ehVGtXkHpxPzA4kpuZcS4vjCi0G', 'student', 'Dev Jayesh Patel', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Jayesh' FROM users u WHERE u.login_id='246250307084' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307085', '$2b$12$1Sz5JKAFukmNdEwIU88JqetslLh4jdaFMigSMXoRlMPKENYUVADXq', 'student', 'Bhagirathbhai Fogabhai Pathar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Fogabhai' FROM users u WHERE u.login_id='246250307085' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307086', '$2b$12$vNXxjEA6jWa/w/KsjE1KjuCRYpTyry7d4GZeYhDDmnTmSK.1wpBPC', 'student', 'Aditya Jayesh Peshavariya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Jayesh' FROM users u WHERE u.login_id='246250307086' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307088', '$2b$12$b0XQ9shqAqDbm2SF.WJaquhUeNYvX35INQHuDHN3CwSOT5hHaQf9a', 'student', 'Diya Vimal Rajani', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Vimal' FROM users u WHERE u.login_id='246250307088' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307089', '$2b$12$Bs3G9Iwq1dgMBhiaGI6fvuEAD4cYR/dih8U2xEvQwi70c./AssUCm', 'student', 'Bhagirathsinh Ajitsinh Rana', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Ajitsinh' FROM users u WHERE u.login_id='246250307089' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307094', '$2b$12$OZPTSoKOFSTCq4QC/vhhNOUq8fjFjnqtKGngzxW8406yKMJA6l3GG', 'student', 'Priyansu Lalitbhai Rathod', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Lalitbhai' FROM users u WHERE u.login_id='246250307094' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307095', '$2b$12$cLXI40oIfYNujSibjIYLbOTREl5lIsgJ1dPUy.ahxkHBjC.ZYheiO', 'student', 'Jelam Rushikumar Raval', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Rushikumar' FROM users u WHERE u.login_id='246250307095' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307096', '$2b$12$KkhF/1GteSG97iiJ9kdXxeQhKpuu4lF4V.vf9kD.VIY8WE.mu/Rxq', 'student', 'Malay Nikunj Raval', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Nikunj' FROM users u WHERE u.login_id='246250307096' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307097', '$2b$12$.XTTPnuOEMMHTfSHWSuqr.mvRHnq3k/qFrhUpIXS75CMmgDgk6N5.', 'student', 'Meghraj Sharad Ravani', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Sharad' FROM users u WHERE u.login_id='246250307097' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307098', '$2b$12$5Vu38wW8NNyJ5xGn5DKhruFy8oJO1nrn3stNqsUl.9KZeuXIfKmiW', 'student', 'Aaditya Kaushik Samani', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Kaushik' FROM users u WHERE u.login_id='246250307098' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307099', '$2b$12$NIoPVLL50PgDeoDvSjNxm.3qLNgYU7id8Hkrk51EgKEtxud2JzvRi', 'student', 'Omkumar Sanjaybhai Sathvara', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Sanjaybhai' FROM users u WHERE u.login_id='246250307099' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307100', '$2b$12$h6KnkJCeMFxb0yk.ZN/4Me0ButsqTXeXP4kpJ0hHVklD7mbk/UT0G', 'student', 'Dhruv Rameshbhai Shir', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Rameshbhai' FROM users u WHERE u.login_id='246250307100' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307101', '$2b$12$nBXFauFdmPafCSQNEsjRfeW2HFRjW/O7GpyQhGTiWUINJazvXDW6a', 'student', 'Roshni Rajeshkumar Singh', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Rajeshkumar' FROM users u WHERE u.login_id='246250307101' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307102', '$2b$12$V9Y6YmYIGkY2xi2h1WhqiOXyVZpxURGAHIR66uJmkcW2aG/eoY9uy', 'student', 'Bhavyadeepsinh Hardevsinh Sodha', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Hardevsinh' FROM users u WHERE u.login_id='246250307102' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307104', '$2b$12$s1Nm/KdQTePxf7W4GCQsXepP2YF0ZcjFN.fmJwUrdoY5MVcq0dqjO', 'student', 'Praful Shaileshbhai Sonagara', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Shaileshbhai' FROM users u WHERE u.login_id='246250307104' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307105', '$2b$12$o0u92t/Gw8PHBXnlRhREh.ee6K6TPMP3KaOFSYWn2xQuckbOHOfPO', 'student', 'Karm Dipesh Sorathiya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Dipesh' FROM users u WHERE u.login_id='246250307105' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307106', '$2b$12$ruRe7.RPB6HGZ3bLYwWWx.uV6N7rhjqYiEiKRBNBtosqYChWU9p6O', 'student', 'Kedar Satyambhai Thakar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Satyambhai' FROM users u WHERE u.login_id='246250307106' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307107', '$2b$12$9OWZYx3yWTz6/VlkuPIpDeAq4ooyTg/0ROV.1MeLas5pqIzBSNTq2', 'student', 'Parv Bharatbhushan Thakar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Bharatbhushan' FROM users u WHERE u.login_id='246250307107' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307108', '$2b$12$ddw2Q/KqxlDGD4fpSVfBaeye6aMF6vA8wzUQUhR8Seg2OSwb7UacW', 'student', 'Paramkumar Kanaiyalal Thakkar', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Kanaiyalal' FROM users u WHERE u.login_id='246250307108' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307109', '$2b$12$QhH7gusmX1/MhMFyD6axOOlabn7OSgKnkrmMrzHIR8BhRsAV7lwCK', 'student', 'Shyam Dharmeshbhai Thanki', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Dharmeshbhai' FROM users u WHERE u.login_id='246250307109' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307111', '$2b$12$sbMl9GLHfPsJwVFC45mVZe82jlxsMPxN/PnqcAw3/Tjsa4AEZ4qB2', 'student', 'Karan Shaileshbhai Vadgama', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Shaileshbhai' FROM users u WHERE u.login_id='246250307111' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307112', '$2b$12$uizdP0UBYId1pW7oEW6rY.coySY7Rp6I6pRXwnVg8WmjntYVBoXCu', 'student', 'Rajiv Anilbhai Vadoliya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Anilbhai' FROM users u WHERE u.login_id='246250307112' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307113', '$2b$12$I.DtW3OvYQyeYNkZXjyFCer3Rh8C1QEHdQ7KGIMd2qno0VsyhFUQK', 'student', 'Hetkumar Anilbhai Vaja', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Anilbhai' FROM users u WHERE u.login_id='246250307113' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307114', '$2b$12$qhQN6BHKBR60tY6Sx4DJCezdrwI6isOoHysgKNZ5dFWQcTSAO3rzC', 'student', 'Aditi Dharm Visavadia', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Dharm' FROM users u WHERE u.login_id='246250307114' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307115', '$2b$12$PMnGey6a3YogXQ1e8dQXUOBs7j3SWPzugReP1UeHo8/AFQAzlUDh6', 'student', 'Dhara Rajeshbhai Visavadiya', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Rajeshbhai' FROM users u WHERE u.login_id='246250307115' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307116', '$2b$12$R2XYl0xDV8.0fxVw9n5GrOCbvEv8QBk5PakgKhhqH7AH4Nrrh1X1S', 'student', 'Bhavya Rajesh Vithlani', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Rajesh' FROM users u WHERE u.login_id='246250307116' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307117', '$2b$12$YFyfSjgzwX9lqMFRkJKM.O8UFBHL0IjqzeITBQkjua4Q/3s.2Pcv6', 'student', 'Hinaba Mahipalsinh Zala', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Mahipalsinh' FROM users u WHERE u.login_id='246250307117' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('246250307118', '$2b$12$LE8zmQXvufPWClZm37Si5u32tBM83aNVBkXg53c3/VmpJBFoS5vDG', 'student', 'Sunil Ashokbhai Zala', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Ashokbhai' FROM users u WHERE u.login_id='246250307118' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);
INSERT IGNORE INTO users (login_id, password_hash, role, name, status) VALUES ('236250307037', '$2b$12$eqVPWHXwWF9wiHFZWMMHLO6SiFVdTE43f9RZyi02NN/NMDLYUCLO2', 'student', 'Sahilpuri Ajaypuri Goswami', 'active');
INSERT INTO students (user_id, department, semester, division, academic_year, father_name) SELECT u.id, 'Computer Engineering', 5, 'B', '2024-25', 'Ajaypuri' FROM users u WHERE u.login_id='236250307037' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id=u.id);

COMMIT;

-- Check:
SELECT s.division, COUNT(*) FROM students s JOIN users u ON u.id=s.user_id WHERE u.role='student' AND s.semester=5 AND s.academic_year='2024-25' GROUP BY s.division;

-- ============================================================
-- Holidays + cancelled sessions
-- A slot counts as "held" only if it is not a holiday and not cancelled.
-- ============================================================
CREATE TABLE IF NOT EXISTS holidays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    holiday_date DATE NOT NULL,
    name VARCHAR(100) NOT NULL,
    semester INT NULL,          -- NULL = whole college
    division VARCHAR(5) NULL,   -- NULL = all divisions of that semester
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_holiday_date (holiday_date)
    -- note: duplicates are checked in admin_add_holiday (MySQL UNIQUE ignores NULLs)
);

CREATE TABLE IF NOT EXISTS session_overrides (
    id INT AUTO_INCREMENT PRIMARY KEY,
    timetable_id INT NOT NULL,
    session_date DATE NOT NULL,
    status ENUM('cancelled','substituted') NOT NULL,
    reason VARCHAR(100),                 -- Meeting, Faculty leave, etc.
    substitute_faculty_id INT NULL,      -- only for status 'substituted': who takes the lecture
    marked_by INT,
    marked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_override (timetable_id, session_date),
    FOREIGN KEY (timetable_id) REFERENCES timetable(id) ON DELETE CASCADE,
    FOREIGN KEY (substitute_faculty_id) REFERENCES faculty(id) ON DELETE CASCADE
);

-- Extra sessions: attendance taken on a weekday/session type that is NOT in the timetable.
-- (Attendance rows themselves are unchanged, so percentage logic still counts them as held.)
CREATE TABLE IF NOT EXISTS extra_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    faculty_id INT NOT NULL,
    subject_id INT NOT NULL,
    semester INT NOT NULL,
    division VARCHAR(5) NOT NULL DEFAULT '',   -- '' = all divisions
    session_type ENUM('Lecture','Lab') NOT NULL DEFAULT 'Lecture',
    session_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_extra (faculty_id, subject_id, semester, division, session_type, session_date),
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);



ALTER TABLE session_overrides
  MODIFY status ENUM('cancelled','substituted') NOT NULL,
  ADD COLUMN substitute_faculty_id INT NULL,
  ADD CONSTRAINT fk_override_sub_faculty
      FOREIGN KEY (substitute_faculty_id) REFERENCES faculty(id) ON DELETE SET NULL;
      
      SHOW CREATE TABLE session_overrides;
      
         ALTER TABLE session_overrides
     ADD CONSTRAINT fk_override_sub_faculty
     FOREIGN KEY (substitute_faculty_id) REFERENCES faculty(id) ON DELETE SET NULL;