# ZAHS Admin Web

Production API: https://zahs-backend-production-5988.up.railway.app/api
Login: POST /api/auth/admin-code with JSON code. The server compares it with ADMIN_LOGIN_CODE in Railway Variables; the frontend contains no configured code. Existing opaque token is stored in sessionStorage under zahs_admin and sent as Bearer Authorization. Reload calls /api/me; logout calls POST /api/auth/logout and clears local session.

Run npm ci, npm run lint and npm run build:production. Publish only dist contents to GitHub Pages at /ZAHS-Admin/. All asset URLs are relative and dashboard/navigation uses hashes. config.js loads before app.js. The source root can also be published directly: its checked-in config.js points to the production API.

npm run build is development mode unless ENVIRONMENT=production is set; npm run build:production explicitly enables production regardless of shell platform. Optional ADMIN_API_BASE_URL overrides the HTTPS API base for production builds.

Backend must use ALLOWED_ORIGINS=https://zahs-1.github.io (origin only, no /ZAHS-Admin/ path). If other origins already exist, append this origin rather than discarding them. Do not use wildcard. Backend CORS consumes the validated Settings.origins. Publish both backend CORS fix and Admin assets before the live integration can pass.

npm test runs Playwright/headless browser tests against an actual disposable local backend and SQLite database under a checked temporary directory. It does not create a production administrator or send test codes to production. Python and backend requirements must be available; ZAHS_TEST_PYTHON can select the Python executable. Windows tests use installed Chrome; other platforms need npx playwright install chromium. Tests validate the production build under /ZAHS-Admin/, login/dashboard/reload/logout, wrong code, JavaScript failure, old query cleanup, CORS (including GitHub Pages origin), expired session, network failure and invalid JSON.

No automatic publication is performed by these commands. Real production login needs an existing authorized admin account after publication; it was not tested with the private Railway administrator code.

For code login set ADMIN_LOGIN_CODE on the backend (private 12-128 character random value). It uses an existing active ADMIN. If more than one active ADMIN exists, set ADMIN_LOGIN_USER_ID to the chosen users.id. No admin is created automatically. Missing code/account configuration produces a clear sign-in error. The login request has a 15-second timeout with visible progress; query credentials are stripped and static assets use a versioned URL to avoid old cached scripts.
