-- ============================================================
-- CampusMitra / StudentHub — COMPLETE DATABASE (single file)
-- Database : studenthub
-- Contains : all tables (final structure) + seed data
-- Run      : mysql -u root -p < schema.sql   (fresh DB par, re-run safe)
-- ============================================================

CREATE DATABASE IF NOT EXISTS studenthub;
USE studenthub;

-- Common login table (student, faculty, admin sabke liye)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    login_id VARCHAR(50) UNIQUE NOT NULL,      -- student: enrollment number | faculty/admin: email/faculty id
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('student', 'faculty', 'admin') NOT NULL,
    name VARCHAR(100) NOT NULL,
    status ENUM('active', 'inactive', 'pending') DEFAULT 'active',   -- pending = admin approval baaki
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

-- Attendance shortage alerts (e-mail to student + parent) that were already sent.
-- Used so the same student+subject is not mailed again within the cooldown (7 days).
-- (The backend also creates this table by itself on first use if it is missing.)
CREATE TABLE IF NOT EXISTS attendance_alerts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    subject_id INT NOT NULL,
    percentage DECIMAL(5,2),
    sent_to VARCHAR(255),
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_attendance_alert (student_id, subject_id, sent_at),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
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
    audience ENUM('all','student','faculty','admin') NOT NULL DEFAULT 'all',  -- kis role ko ye FAQ dikhana hai
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_faq_question (question)
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
-- Holidays + cancelled / substituted sessions
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
    CONSTRAINT fk_override_timetable FOREIGN KEY (timetable_id) REFERENCES timetable(id) ON DELETE CASCADE,
    CONSTRAINT fk_override_sub_faculty FOREIGN KEY (substitute_faculty_id) REFERENCES faculty(id) ON DELETE SET NULL
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

-- ============================================================
-- SEED DATA (re-run safe: INSERT IGNORE / NOT EXISTS)
-- ============================================================

-- Default admin account  |  Login: admin@1309
-- (bcrypt hash; plain password kahin store nahi hota)
INSERT IGNORE INTO users (login_id, password_hash, role, name, status)
VALUES ('admin@1309', '$2b$12$b9Asg7N4pz8V1uHajxCPKuTHL0GOrIz.ZORARBLJjNt9XyKv5Ju4K', 'admin', 'Admin', 'active');

-- Academic years
INSERT INTO academic_years (year_label)
SELECT '2024-25' WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE year_label = '2024-25');
INSERT INTO academic_years (year_label)
SELECT '2025-26' WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE year_label = '2025-26');
INSERT INTO academic_years (year_label)
SELECT '2026-27' WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE year_label = '2026-27');

-- ------------------------------------------------------------
-- Chatbot FAQs (audience: all / student / faculty / admin)
-- FAQ me kabhi password, OTP, API key ya personal data na likhein.
-- ------------------------------------------------------------
INSERT IGNORE INTO chatbot_faqs (question, answer, category, audience) VALUES
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