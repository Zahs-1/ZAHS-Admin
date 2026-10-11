import { mkdir, copyFile, writeFile } from "node:fs/promises";
const production = process.env.ENVIRONMENT === "production";
const base = process.env.ADMIN_API_BASE_URL || (production ? "" : "/api");
if (production) {
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw Error("Production Admin requires an HTTPS ADMIN_API_BASE_URL");
}
const apiBaseUrl = base.replace(/\/$/, "");
await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
for (const name of ["index.html", "style.css", "app.js"])
  await copyFile(
    new URL(name, import.meta.url),
    new URL("dist/" + name, import.meta.url),
  );
await writeFile(
  new URL("dist/config.js", import.meta.url),
  "window.ZAHS_CONFIG = " +
    JSON.stringify({
      apiBaseUrl,
      environment: production ? "production" : "development",
    }) +
    ";\n",
);
const origin = production ? new URL(base).origin : "'self'";
await writeFile(
  new URL("dist/_headers", import.meta.url),
  `/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' ${origin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n`,
);
console.log(
  "ZAHS Admin built: dist/index.html; " +
    (production ? "production HTTPS" : "development"),
);
