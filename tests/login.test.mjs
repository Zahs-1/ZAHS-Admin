import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const adminRoot = fileURLToPath(new URL("../", import.meta.url));
const workspace = resolve(adminRoot, "..");
const productionApi = "https://zahs-backend-production-5988.up.railway.app/api";
const email = "login-browser@zahs.test";
const password = "Disposable-login-test-password1";
const code = "Disposable-admin-code-123456";
let server, backend, browser, temporary, site, apiBase;
const wait = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "zahs-admin-login-"));
  const reserved = createServer();
  reserved.listen(0, "127.0.0.1");
  await once(reserved, "listening");
  const apiPort = reserved.address().port;
  await new Promise((done) => reserved.close(done));
  apiBase = `http://127.0.0.1:${apiPort}/api`;
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const filename = pathname.slice("/ZAHS-Admin/".length) || "index.html";
    if (
      !pathname.startsWith("/ZAHS-Admin/") ||
      !["index.html", "app.js", "style.css", "config.js"].includes(filename)
    ) {
      response.writeHead(404).end();
      return;
    }
    const types = {
      "index.html": "text/html",
      "app.js": "text/javascript",
      "config.js": "text/javascript",
      "style.css": "text/css",
    };
    response.setHeader("Content-Type", types[filename]);
    response.end(
      filename === "config.js"
        ? `window.ZAHS_CONFIG = ${JSON.stringify({ apiBaseUrl: apiBase, environment: "test" })};`
        : await readFile(join(adminRoot, "dist", filename)),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  site = `http://127.0.0.1:${server.address().port}`;
  const script = `from backend import app as core\nwith core.db() as c:\n core.insert(c, 'users', {'id': 'login-test-admin', 'role': 'ADMIN', 'name': 'Login', 'surname': 'QA', 'email': '${email}', 'password_hash': core.password_hash('${password}')})\nfrom backend.entrypoint import main\nmain()`;
  backend = spawn(process.env.ZAHS_TEST_PYTHON || "python", ["-c", script], {
    cwd: workspace,
    env: {
      ...process.env,
      ENVIRONMENT: "test",
      ZAHS_DATA: temporary,
      DATABASE_URL: "",
      STORAGE_PROVIDER: "local",
      PUSH_PROVIDER: "noop",
      PORT: String(apiPort),
      ADMIN_LOGIN_CODE: code,
      ADMIN_LOGIN_USER_ID: "login-test-admin",
      ALLOWED_ORIGINS: site + ",https://zahs-1.github.io",
      ZAHS_ORIGINS: "https://unused-origin.example",
      PYTHONPATH: [
        join(workspace, ".python-packages"),
        workspace,
        process.env.PYTHONPATH || "",
      ].join(process.platform === "win32" ? ";" : ":"),
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 600; attempt++) {
    if (backend.exitCode !== null)
      throw Error("Disposable QA backend exited before readiness");
    try {
      if ((await fetch(`${apiBase.slice(0, -4)}/ready`)).ok) break;
    } catch {
      /* Backend starts asynchronously. */
    }
    if (attempt === 599)
      throw Error("Disposable QA backend did not become ready");
    await wait(100);
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
  });
});

after(async () => {
  if (browser) await browser.close();
  if (backend && backend.exitCode === null) {
    const stopped = once(backend, "exit");
    backend.kill();
    await stopped;
  }
  if (server) await new Promise((done) => server.close(done));
  if (temporary) {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(temporary.includes("zahs-admin-login-"));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("production artifacts load config before app and use the real HTTPS API", async () => {
  const html = await readFile(join(adminRoot, "dist/index.html"), "utf8");
  const config = await readFile(join(adminRoot, "dist/config.js"), "utf8");
  assert.ok(html.indexOf('src="./config.js') < html.indexOf('src="./app.js'));
  assert.ok(config.includes(productionApi));
  assert.ok(!config.includes(code));
  assert.ok(!html.includes("login-email") && !html.includes("login-password"));
  assert.ok(!html.includes("/dashboard.html"));
});

test("POST JSON login, dashboard reload and logout work under /ZAHS-Admin/", async () => {
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request));
  await page.goto(site + "/ZAHS-Admin/");
  await page.locator("#login-code").fill(code);
  await page.locator("#login-form button").click();
  await page.locator("#shell").waitFor({ state: "visible" });
  await page.locator("#content .metric").first().waitFor({ state: "visible" });
  const login = requests.find(
    (request) => request.url() === apiBase + "/auth/admin-code",
  );
  assert.equal(login.method(), "POST");
  assert.deepEqual(login.postDataJSON(), { code });
  assert.ok(login.headers()["content-type"].includes("application/json"));
  assert.equal(new URL(page.url()).pathname, "/ZAHS-Admin/");
  assert.equal(new URL(page.url()).search, "");
  assert.ok(await page.evaluate(() => sessionStorage.getItem("zahs_admin")));
  await page.reload();
  await page.locator("#shell").waitFor({ state: "visible" });
  await page.locator("#content .metric").first().waitFor({ state: "visible" });
  await page.locator("#logout").click();
  await page.locator("#login").waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("zahs_admin")),
    null,
  );
  await page.reload();
  assert.equal(await page.locator("#shell").isVisible(), false);
  assert.ok(
    requests.some(
      (request) =>
        request.url() === apiBase + "/auth/logout" &&
        request.method() === "POST",
    ),
  );
  assert.ok(
    requests.every(
      (request) => !/[?&](email|password|code)=/i.test(request.url()),
    ),
  );
  assert.deepEqual(errors, []);
  await page.close();
});

test("schedule import defaults to auto detection and accepts both PDFs", async () => {
  const page = await browser.newPage();
  await page.goto(site + "/ZAHS-Admin/");
  await page.locator("#login-code").fill(code);
  await page.locator("#login-form button").click();
  await page.locator("#shell").waitFor({ state: "visible" });
  await page.locator('a[href="#schedules"]').first().click();
  const type = page.locator('#import-form select[name="type"]');
  await type.waitFor();
  assert.equal(await type.inputValue(), "AUTO");
  assert.equal(await type.evaluate((select) => select.checkValidity()), true);
  assert.equal(
    await page
      .locator('#import-form input[name="file"]')
      .evaluate((input) => input.multiple),
    true,
  );
  await type.selectOption("TEACHER");
  assert.equal(await type.inputValue(), "TEACHER");
  assert.equal(await type.evaluate((select) => select.checkValidity()), true);
  await type.selectOption("CLASS");
  assert.equal(await type.inputValue(), "CLASS");
  await type.selectOption("AUTO");
  await page
    .locator('#import-form input[name="version_label"]')
    .fill("Two source PDFs QA");
  await page
    .locator('#import-form input[name="effective_from"]')
    .fill("2026-09-22");
  await page
    .locator('#import-form input[name="file"]')
    .setInputFiles([
      join(workspace, "backend/tests/fixtures/classes.pdf"),
      join(workspace, "backend/tests/fixtures/teachers.pdf"),
    ]);
  await page.locator('[name="effective_date_confirmed"]').check();
  await page.locator("#import-form > button").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".batch-review").length === 2,
    null,
    { timeout: 90000 },
  );
  const results = await page.locator("#import-results").innerText();
  assert.match(results, /classes\.pdf · CLASS · 30 headings/);
  assert.match(results, /teachers\.pdf · TEACHER · 56 headings/);
  assert.ok(!results.includes("Unrecognized table identity"));
  await page.locator(".batch-review").nth(1).click();
  await page.locator("#identity-select").waitFor();
  assert.equal(await page.locator("#identity-select").inputValue(), "__ALL__");
  assert.equal(await page.locator("#schedule-grid tbody tr").count(), 56);
  assert.match(
    await page.locator("#schedule-grid").innerText(),
    /Teacher from PDF/i,
  );
  assert.equal(
    await page.locator("#publish").innerText(),
    "Publish all schedules",
  );
  await page.locator("#identity-select").selectOption("Ferqana Isayeva");
  await page.locator("#schedule-grid table.schedule").waitFor();
  await page.locator("#identity-select").selectOption("__ALL__");
  assert.equal(await page.locator("#schedule-grid tbody tr").count(), 56);
  assert.match(
    await page.locator("#schedule-grid").innerText(),
    /Ready with warnings/,
  );
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#import-tab").click();
  await page
    .locator("tr")
    .filter({ hasText: /Two source PDFs QA/ })
    .filter({ hasText: /CLASS/ })
    .locator(".review")
    .click();
  await page.locator("#publish").click();
  await page.locator("#import-form").waitFor();
  await page
    .locator("tr")
    .filter({ hasText: /Two source PDFs QA/ })
    .filter({ hasText: /TEACHER/ })
    .locator(".review")
    .click();
  await page.locator("#publish").click();
  await page.locator("#import-form").waitFor();
  assert.equal(
    await page
      .locator("tr")
      .filter({ hasText: /Two source PDFs QA/ })
      .filter({ hasText: /PUBLISHED/ })
      .count(),
    2,
  );
  await page
    .locator("tr")
    .filter({ hasText: /Two source PDFs QA/ })
    .filter({ hasText: /TEACHER/ })
    .locator(".review")
    .click();
  await page.locator("#identity-select").waitFor();
  assert.equal(await page.locator("#schedule-grid tbody tr").count(), 56);
  await mkdir(join(workspace, "analysis", "bulk-pdf"), { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(workspace, "analysis", "bulk-pdf", "admin-all-teachers.png"),
  });
  await page.close();
});

test("wrong code displays an error without navigation or credential disclosure", async () => {
  const page = await browser.newPage();
  await page.goto(site + "/ZAHS-Admin/");
  await page.locator("#login-code").fill("Wrong-disposable-admin-code");
  await page.locator("#login-code").press("Enter");
  await page
    .locator("#login-error")
    .filter({ hasText: "Incorrect administrator code" })
    .waitFor();
  assert.equal(page.url(), site + "/ZAHS-Admin/");
  assert.equal(await page.locator("#shell").isVisible(), false);
  assert.equal(await page.locator("#login-code").inputValue(), "");
  assert.ok(
    !(await page.locator("body").innerText()).includes(
      "Wrong-disposable-admin-code",
    ),
  );
  await page.close();
});

test("missing app JavaScript cannot submit credentials or change the page URL", async () => {
  const page = await browser.newPage();
  await page.route("**/app.js*", (route) => route.abort());
  await page.goto(site + "/ZAHS-Admin/");
  await page.locator("#login-code").fill(code);
  assert.equal(await page.locator("#login-form button").isDisabled(), true);
  await page.locator("#login-code").press("Enter");
  await page.evaluate(() => document.querySelector("#login-form").submit());
  await wait(150);
  assert.equal(page.url(), site + "/ZAHS-Admin/");
  await page.close();
});

test("old credential query parameters are removed from the current history entry", async () => {
  const page = await browser.newPage();
  await page.goto(
    site +
      "/ZAHS-Admin/?email=old-test&password=old-test&code=old-test#dashboard",
  );
  await page.waitForFunction(() => !location.search);
  assert.equal(new URL(page.url()).pathname, "/ZAHS-Admin/");
  assert.equal(new URL(page.url()).hash, "#dashboard");
  await page.close();
});

test("CORS honors ALLOWED_ORIGINS and permits JSON/Bearer preflight", async () => {
  const preflight = await fetch(apiBase + "/auth/admin-code", {
    method: "OPTIONS",
    headers: {
      Origin: site,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization",
    },
  });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get("access-control-allow-origin"), site);
  const github = await fetch(apiBase + "/auth/admin-code", {
    method: "OPTIONS",
    headers: {
      Origin: "https://zahs-1.github.io",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization",
    },
  });
  assert.equal(github.status, 200);
  assert.equal(
    github.headers.get("access-control-allow-origin"),
    "https://zahs-1.github.io",
  );
  const denied = await fetch(apiBase + "/auth/admin-code", {
    method: "OPTIONS",
    headers: {
      Origin: "https://untrusted.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("expired session returns to login and clears the stored token", async () => {
  const page = await browser.newPage();
  await page.addInitScript(() =>
    sessionStorage.setItem("zahs_admin", "expired-qa-token"),
  );
  await page.goto(site + "/ZAHS-Admin/");
  await page
    .locator("#login-error")
    .filter({ hasText: "Please sign in again" })
    .waitFor();
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("zahs_admin")),
    null,
  );
  assert.equal(await page.locator("#shell").isVisible(), false);
  assert.equal(new URL(page.url()).search, "");
  await page.close();
});

test("news gallery selects, removes, reorders, saves and edits actual private image uploads", async () => {
  const page = await browser.newPage();
  await page.goto(site + "/ZAHS-Admin/");
  await page.locator("#login-code").fill(code);
  await page.locator("#login-form button").click();
  await page.locator("#shell").waitFor({state: "visible"});
  await page.locator('a[href="#news"]').first().click();
  await page.locator("#new").click();
  await page.locator('[name="title"]').fill("Gallery browser QA");
  await page.locator('[name="body"]').fill("Multiple private news images");
  const files = (name) => join(workspace, "backend/tests/fixtures/news-gallery", name);
  await page.locator("#news-image").setInputFiles([files("photo.png"), files("photo.jpeg"), files("photo.webp")]);
  assert.equal(await page.locator(".news-image-row").count(), 3);
  await page.locator(".image-remove").nth(1).click();
  assert.equal(await page.locator(".news-image-row").count(), 2);
  await page.locator(".image-up").nth(1).click();
  assert.match(await page.locator(".news-image-row").first().innerText(), /photo.webp/);
  await page.locator('[name="is_published"]').check();
  const saved = page.waitForRequest((request) => request.url() === apiBase + "/admin/resources/news" && request.method() === "POST");
  await page.locator("#save").click();
  const payload = (await saved).postDataJSON();
  assert.equal(payload.image_ids.length, 2);
  await page.locator("#dialog").waitFor({state: "hidden"});
  const row = page.locator("tr").filter({hasText: "Gallery browser QA"});
  await row.locator(".edit").click();
  assert.equal(await page.locator(".news-image-row").count(), 2);
  await page.locator(".image-remove").first().click();
  await page.locator("#news-image").setInputFiles(files("photo.jpeg"));
  const updated = page.waitForRequest((request) => request.url().includes("/admin/resources/news/") && request.method() === "PATCH");
  await page.locator("#save").click();
  const ids = (await updated).postDataJSON().image_ids;
  assert.equal(ids.length, 2);
  assert.equal(ids[0], payload.image_ids[1]);
  await page.locator("#dialog").waitFor({state: "hidden"});
  const token = await page.evaluate(() => sessionStorage.getItem("zahs_admin"));
  const news = await fetch(apiBase + "/news", {headers: {Authorization: "Bearer " + token}}).then((r) => r.json());
  const gallery = news.find((item) => item.title === "Gallery browser QA");
  assert.deepEqual(gallery.image_ids, ids);
  assert.equal(gallery.media_id, ids[0]);
  for (const media_id of ids) assert.equal((await fetch(apiBase + "/media/" + media_id + "/file", {headers: {Authorization: "Bearer " + token}})).status, 200);
  await page.close();
});

test("one bad image keeps news text and successful uploads available for retry", async () => {
  const page = await browser.newPage();
  await page.goto(site + "/ZAHS-Admin/");
  await page.locator("#login-code").fill(code);
  await page.locator("#login-form button").click();
  await page.locator("#shell").waitFor({state: "visible"});
  await page.locator('a[href="#news"]').first().click();
  await page.locator("#new").click();
  await page.locator('[name="title"]').fill("Retry image QA");
  await page.locator('[name="body"]').fill("Keep this news text");
  await page.locator("#news-image").setInputFiles([join(workspace, "backend/tests/fixtures/news-gallery/photo.png"), join(workspace, "backend/tests/fixtures/news-gallery/bad.png")]);
  await page.locator("#save").click();
  await page.locator("#form-error").filter({hasText: "Some images could not upload"}).waitFor();
  assert.equal(await page.locator('[name="body"]').inputValue(), "Keep this news text");
  assert.equal(await page.locator(".news-image-row").count(), 2);
  assert.match(await page.locator(".news-image-row").first().innerText(), /Uploaded/);
  assert.equal(await page.locator(".image-error").count(), 1);
  await page.locator(".image-remove").last().click();
  await page.locator("#save").click();
  await page.locator("#dialog").waitFor({state: "hidden"});
  await page.locator("tr").filter({hasText: "Retry image QA"}).waitFor();
  await page.close();
});

test("import deletion requires a dialog and separate published confirmation", async () => {
  const page = await browser.newPage();
  await page.goto(site + "/ZAHS-Admin/");
  await page.locator("#login-code").fill(code);
  await page.locator("#login-form button").click();
  await page.locator("#shell").waitFor({ state: "visible" });
  const token = await page.evaluate(() => sessionStorage.getItem("zahs_admin"));
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const roster = await fetch(apiBase + "/classes").then((r) => r.json());
  const create = async (label) => {
    const result = await fetch(apiBase + "/admin/schedules/manual", {
      method: "POST", headers, body: JSON.stringify({type: "CLASS", version_label: label, effective_from: "2026-09-21", entries: [{class_name: roster[0].name, subject_code: "UI/pending", weekday: 1, lesson_number: 1, start_time: "08:00", end_time: "08:45"}]}),
    });
    assert.equal(result.status, 201);
    return result.json();
  };
  const draft = await create("Delete UI draft QA");
  await page.locator('a[href="#schedules"]').first().click();
  const draftRow = page.locator("tr").filter({hasText: "Delete UI draft QA"});
  await draftRow.locator(".import-delete").click();
  assert.match(await page.locator("#delete-import-dialog").innerText(), /2026-09-21.*CLASS/);
  await page.locator("#cancel-import-delete").click();
  assert.equal(await draftRow.count(), 1);
  await draftRow.locator(".import-delete").click();
  await page.locator("#confirm-import-delete").click();
  await page.waitForFunction(() => !document.querySelector("#delete-import-dialog"));
  await page.locator("#import-form").waitFor();
  await draftRow.waitFor({ state: "detached" });
  assert.equal(await draftRow.count(), 0);
  assert.equal((await fetch(apiBase + "/admin/schedules/import/" + draft.id, {headers})).status, 404);
  const published = await create("Delete UI published QA");
  assert.equal((await fetch(apiBase + "/admin/schedules/import/" + published.id + "/publish", {method: "POST", headers, body: JSON.stringify({confirm: true})})).status, 200);
  await page.locator("#import-tab").click();
  const row = page.locator("tr").filter({hasText: "Delete UI published QA"});
  await row.locator(".import-delete").click();
  assert.equal(await page.locator("#confirm-import-delete").isDisabled(), true);
  await page.locator("#confirm-published-delete").check();
  assert.equal(await page.locator("#confirm-import-delete").isEnabled(), true);
  await page.locator("#confirm-import-delete").click();
  await page.waitForFunction(() => !document.querySelector("#delete-import-dialog"));
  await page.locator("#import-form").waitFor();
  await row.waitFor({ state: "detached" });
  assert.equal(await row.count(), 0);
  assert.ok(await page.locator("tr").filter({hasText: "Two source PDFs QA"}).count() >= 2);
  await page.close();
});

test("filename date suggestion needs explicit confirmation and ignores ambiguous filenames", async () => {
  const page = await browser.newPage();
  await page.goto(site + "/ZAHS-Admin/");
  await page.locator("#login-code").fill(code);
  await page.locator("#login-form button").click();
  await page.locator("#shell").waitFor({ state: "visible" });
  await page.locator('a[href="#schedules"]').first().click();
  const input = page.locator('[name="file"]');
  await input.setInputFiles({name: "Version 21.09.2026.pdf", mimeType: "application/pdf", buffer: Buffer.from("date selection QA")});
  assert.equal(await page.locator('[name="effective_from"]').inputValue(), "2026-09-21");
  assert.equal(await page.locator('[name="effective_date_confirmed"]').isChecked(), false);
  await page.locator('[name="effective_date_confirmed"]').check();
  await page.locator('[name="effective_from"]').fill("2027-06-15");
  assert.equal(await page.locator('[name="effective_date_confirmed"]').isChecked(), false);
  await page.locator('[name="effective_from"]').fill("");
  await input.setInputFiles({name: "21.09.2026 and 22.09.2026.pdf", mimeType: "application/pdf", buffer: Buffer.from("date selection QA")});
  assert.equal(await page.locator('[name="effective_from"]').inputValue(), "");
  assert.match(await page.locator("#date-hint").innerText(), /Choose and confirm/);
  await page.close();
});

test("network failures and invalid login responses never disclose the code", async () => {
  for (const mode of ["network", "invalid-json"]) {
    const page = await browser.newPage();
    await page.route("**/api/auth/admin-code", (route) =>
      mode === "network"
        ? route.abort()
        : route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "Invalid response containing Disposable-admin-code-123456",
          }),
    );
    await page.goto(site + "/ZAHS-Admin/");
    await page.locator("#login-code").fill(code);
    await page.locator("#login-form button").click();
    await page
      .locator("#login-error")
      .filter({
        hasText:
          mode === "network" ? "Unable to connect" : "Invalid sign-in response",
      })
      .waitFor();
    assert.equal(page.url(), site + "/ZAHS-Admin/");
    assert.ok(!(await page.locator("body").innerText()).includes(code));
    assert.equal(await page.locator("#login-code").inputValue(), "");
    await page.close();
  }
});
