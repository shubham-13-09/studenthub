USE studenthub;

-- Run ONCE on an existing database (you already created holidays + session_overrides).
-- 1) holidays: the old UNIQUE KEY never blocked duplicates (NULLs are distinct in MySQL);
--    the backend now checks duplicates, so drop it and add a plain date index.
ALTER TABLE holidays DROP INDEX holiday_date;
ALTER TABLE holidays ADD INDEX idx_holiday_date (holiday_date);

-- 2) session_overrides: delete overrides automatically if the timetable slot is deleted.
ALTER TABLE session_overrides
    ADD CONSTRAINT fk_override_timetable FOREIGN KEY (timetable_id) REFERENCES timetable(id) ON DELETE CASCADE;

SHOW INDEX FROM holidays;



SELECT * FROM session_overrides;
SELECT id, semester, division, day_of_week, session_type, subject_id, faculty_id
FROM timetable WHERE subject_id = (SELECT id FROM subjects WHERE subject_name LIKE 'Software Testing%' LIMIT 1);

SELECT attendance_date, session_type, COUNT(*) FROM attendance
WHERE subject_id = 3
GROUP BY attendance_date, session_type;

-- 1) Backup (pehle ye chalao, taaki galti ho to wapas la sako)
CREATE TABLE attendance_backup_cancelled AS
SELECT * FROM attendance
WHERE subject_id = 3 AND session_type = 'Lecture'
  AND attendance_date IN ('2026-09-21', '2026-09-28');

-- 2) Check karo ki backup me 145 rows aayi (50 + 95)
SELECT COUNT(*) FROM attendance_backup_cancelled;

-- 3) Ab delete karo
DELETE FROM attendance
WHERE subject_id = 3 AND session_type = 'Lecture'
  AND attendance_date IN ('2026-09-23');
  
  
  USE studenthub;

-- Run ONCE on an existing database.

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


USE studenthub;

-- Run ONCE on an existing database (adds Substitute sessions to session_overrides).
ALTER TABLE session_overrides
    MODIFY status ENUM('cancelled','substituted') NOT NULL;

ALTER TABLE session_overrides
    ADD COLUMN substitute_faculty_id INT NULL AFTER reason;

ALTER TABLE session_overrides
    ADD CONSTRAINT fk_override_substitute FOREIGN KEY (substitute_faculty_id)
    REFERENCES faculty(id) ON DELETE CASCADE;
    
    SELECT * FROM session_overrides ORDER BY id DESC LIMIT 5;
SELECT student_id, subject_id, faculty_id, attendance_date, status
FROM attendance ORDER BY id DESC LIMIT 10;

SELECT DISTINCT academic_year FROM students;
SELECT year_label FROM academic_years;