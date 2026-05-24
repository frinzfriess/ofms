OFMS HTML Clone with Supabase Database
======================================

This folder is an HTML/browser clone of the OFMS desktop system. It now saves and reads data from Supabase using the same tables used by the provided Python database.py:

- users
- reports
- system_logs

Files
-----
- index.html              Main HTML file
- styles.css              Blue OFMS design
- app.js                  OFMS logic + Supabase CRUD
- supabase_schema.sql     Supabase SQL table schema and demo policies
- assets/                 OFMS logos

How to use
----------
1. Open your Supabase project.
2. Open SQL Editor.
3. Run the contents of supabase_schema.sql.
4. Open index.html in a browser.
5. Login using:
   admin / admin123

If the admin user does not exist yet, the HTML clone will create it automatically after the first successful admin login attempt.

Important
---------
- The HTML clone uses the same Supabase URL/key found in the provided Python database.py.
- Reports are inserted into the reports table.
- Logs are inserted into the system_logs table.
- User accounts and password changes are stored in the users table.
- Passwords are hashed using PBKDF2-HMAC-SHA256 with 120000 iterations to match the Python database.py hashing style.
- XLSX import uses the SheetJS CDN. The browser needs internet access for .xlsx parsing unless the library is downloaded locally.

Security note
-------------
The SQL file includes open demo policies so the browser-only HTML clone can insert/select/update data using the Supabase publishable key. For production deployment, replace those policies with stricter authenticated-user policies.

Latest HTML UI update:
- Improved login and create-account design to match the OFMS desktop-style login reference.
- Added OADJ logo to the loading overlay.
- Added working notification bell in the top header with recent report/log alerts.
- Improved website spacing, shadows, cards, input focus, and transition styling.

Recent HTML Clone Updates
-------------------------
- Generate Report now builds a memo-style report patterned after the uploaded OFMS PDF layout.
- Report output changes depending on the inserted Excel survey type:
  * Client Satisfaction Measurement Survey
  * Job Satisfaction and Work Experience Survey
- Dashboard includes additional Excel-derived profile details, latest survey interpretation, and trend filters.
- Survey Trend can be filtered by All, Today, Yesterday, This Week, and This Month.
- Settings now includes the Development Team section.
- Report narrative and summary sections were expanded to be more interpretative, informative, and tied to the uploaded Excel content.
