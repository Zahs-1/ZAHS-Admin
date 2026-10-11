import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
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
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backend.exitCode !== null)
      throw Error("Disposable QA backend exited before readiness");
    try {
      if ((await fetch(`${apiBase.slice(0, -4)}/ready`)).ok) break;
    } catch {
      /* Backend starts asynchronously. */
    }
    if (attempt === 99)
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
