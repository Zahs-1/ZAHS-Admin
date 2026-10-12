const API_BASE = window.ZAHS_CONFIG?.apiBaseUrl?.replace(/\/$/, "") || "";
const cleanUrl = new URL(window.location.href);
let hadCredentialsInUrl = false;
for (const name of [...cleanUrl.searchParams.keys()]) {
  if (["email", "password", "code"].includes(name.toLowerCase())) {
    cleanUrl.searchParams.delete(name);
    hadCredentialsInUrl = true;
  }
}
if (hadCredentialsInUrl)
  window.history.replaceState(
    null,
    "",
    cleanUrl.pathname + cleanUrl.search + cleanUrl.hash,
  );
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let token = sessionStorage.getItem("zahs_admin"),
  section = "dashboard",
  page = 1,
  currentImport = null,
  draft = null,
  modalSave = null,
  afterSave = null;
const resources = {
  students: ["Students", "◉"],
  teachers: ["Teachers", "♧"],
  classes: ["Classes", "▦"],
  groups: ["Groups", "◇"],
  schedules: ["Schedules", "▤"],
  news: ["School news", "▧"],
  grades: ["Grades", "✓"],
  messages: ["Messages", "☷"],
  media: ["Media", "▣"],
  notifications: ["Notifications", "♧"],
  "admin-users": ["Admin users", "◈"],
  "audit-logs": ["Audit logs", "≡"],
  settings: ["Settings", "⚙"],
};
const fields = {
  students: ["name", "surname", "email", "password", "class_id", "active"],
  teachers: [
    "name",
    "surname",
    "email",
    "password",
    "subject",
    "schedule_display_name",
    "active",
  ],
  "admin-users": ["name", "surname", "email", "password", "active"],
  classes: ["name", "school_year", "class_teacher_id", "archived"],
  groups: ["name", "description", "subject"],
  news: ["title", "body", "media_id", "published_at", "is_published"],
  grades: ["value", "comment", "subject", "date"],
  "subject-mappings": ["source_code", "display_name", "locale", "active"],
  "teacher-mappings": ["source_name", "teacher_id"],
};
const labels = {
  name: "Name",
  surname: "Surname",
  email: "Email",
  password: "Password · 10+ characters",
  class_id: "Class",
  active: "Active",
  subject: "Subject",
  schedule_display_name: "Name used in PDF",
  school_year: "Academic year",
  class_teacher_id: "Class teacher",
  archived: "Archived",
  title: "Title",
  body: "Text",
  media_id: "Image",
  published_at: "Publication date",
  is_published: "Published",
  source_code: "PDF subject code",
  display_name: "Confirmed subject name",
  source_name: "Teacher name in PDF",
  teacher_id: "Teacher account",
  locale: "Locale",
};
async function api(path, method = "GET", body) {
  if (!API_BASE)
    throw Error(
      "Admin API configuration is missing. Please contact administration.",
    );
  let options = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body instanceof FormData) options.body = body;
  else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const r = await fetch(API_BASE + path, options);
  if (r.status === 401) {
    signOut();
    throw Error("Please sign in again");
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({ detail: r.statusText }));
    throw Error(
      typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail),
    );
  }
  return r.json();
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  setTimeout(() => ($("#toast").hidden = true), 5000);
}
function signOut() {
  token = null;
  sessionStorage.removeItem("zahs_admin");
  $("#login").hidden = false;
  $("#shell").hidden = true;
}
async function start() {
  if (!token) return;
  try {
    const user = await api("/me");
    if (user.role !== "ADMIN") throw Error("Administrator account required");
    $("#login").hidden = true;
    $("#shell").hidden = false;
    await navigate();
  } catch (e) {
    signOut();
    $("#login-error").textContent = e.message;
  }
}
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  const submit = e.submitter || $("#login-form button[type=submit]");
  const submitLabel = submit.textContent;
  submit.disabled = true;
  submit.textContent = "Checking code…";
  $("#login-error").textContent = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    if (!API_BASE)
      throw Error(
        "Admin API configuration is missing. Please contact administration.",
      );
    const data = {
      code: $("#login-code").value.trim(),
    };
    const r = await fetch(API_BASE + "/auth/admin-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: controller.signal,
    });
    if (!r.ok) {
      const messages = {
        401: "Incorrect administrator code",
        403: "Administrator account required",
        422: "Enter a valid administrator code",
        429: "Too many attempts. Try again in 15 minutes.",
        503: "Administrator code sign-in is not configured on the server. Contact administration.",
      };
      throw Error(
        messages[r.status] ||
          "Sign-in service is unavailable. Please try again later.",
      );
    }
    const j = await r.json().catch(() => null);
    if (!j || typeof j.token !== "string" || !j.token)
      throw Error("Invalid sign-in response. Please contact administration.");
    token = j.token;
    sessionStorage.setItem("zahs_admin", token);
    await start();
  } catch (e) {
    $("#login-error").textContent =
      e.name === "AbortError"
        ? "Sign-in timed out. Please try again."
        : e instanceof TypeError
          ? "Unable to connect to the sign-in service. Please try again."
          : e.message;
  } finally {
    clearTimeout(timeout);
    $("#login-code").value = "";
    submit.textContent = submitLabel;
    submit.disabled = false;
  }
};
$("#login-form button[type=submit]").disabled = !API_BASE;
if (!API_BASE)
  $("#login-error").textContent =
    "Admin API configuration is missing. Please contact administration.";
$("#logout").onclick = async () => {
  try {
    await api("/auth/logout", "POST");
  } finally {
    signOut();
  }
};
$("#close-dialog").onclick = () => $("#dialog").close();
$("#edit-form").onsubmit = async (e) => {
  e.preventDefault();
  if ($("#save").textContent === "Close") {
    $("#dialog").close();
    return;
  }
  $("#save").disabled = true;
  $("#form-error").textContent = "";
  try {
    await modalSave();
    $("#dialog").close();
    toast("Saved successfully");
    if (afterSave) await afterSave();
    else await navigate();
  } catch (e) {
    $("#form-error").textContent = e.message;
  } finally {
    $("#save").disabled = false;
  }
};
$("#refresh").onclick = () => navigate();
window.onhashchange = () => {
  page = 1;
  navigate();
};
$("#navigation").innerHTML =
  '<a href="#dashboard">◷ &nbsp; Overview</a>' +
  Object.entries(resources)
    .map(([k, [label, icon]]) => `<a href="#${k}">${icon} &nbsp; ${label}</a>`)
    .join("");
async function navigate() {
  if (!token) return;
  section = location.hash.slice(1) || "dashboard";
  $("#page-title").textContent =
    section === "dashboard"
      ? "School overview"
      : resources[section]?.[0] || section;
  document
    .querySelectorAll("nav a")
    .forEach((a) => a.classList.toggle("active", a.hash === "#" + section));
  $("#content").innerHTML =
    '<div class="panel empty">Loading school data…</div>';
  try {
    if (section === "dashboard") await dashboard();
    else if (section === "schedules") await schedules();
    else if (section === "settings") await settings();
    else await list(section);
  } catch (e) {
    $("#content").innerHTML =
      `<div class="panel"><h2>Unable to load this page</h2><p>${esc(e.message)}</p><button id="retry">Try again</button></div>`;
    $("#retry").onclick = navigate;
  }
}
async function dashboard() {
  const d = await api("/admin/dashboard");
  $("#content").innerHTML =
    `<div class="welcome"><div><p class="eyebrow" style="color:#c4bfdc">ZAHS · ADMIN WORKSPACE</p><h2>A good day starts with clarity.</h2><p>Manage your school’s people, schedules and conversations.</p></div><div class="seal">✦</div></div><div class="grid">${Object.entries(
      d,
    )
      .map(
        ([k, v]) =>
          `<a class="metric" href="#${k}"><span>${esc(k.toUpperCase())}</span><strong>${v}</strong><small>View ${esc(k)} ↗</small></a>`,
      )
      .join(
        "",
      )}</div><div class="two-col spacer"><div class="panel"><h2>Publish the school week</h2><p class="muted">Import class and teacher PDFs, review mappings and publish a verified version.</p><a class="section-link" href="#schedules">Open schedule workspace →</a></div><div class="panel"><h2>Keep everyone informed</h2><p class="muted">Publish school news with photos. Every student and teacher receives the same update.</p><a class="section-link" href="#news">Manage school news →</a></div></div>`;
}
async function list(name, q = "", extra = {}) {
  const params = new URLSearchParams({ page, q, ...extra });
  const result = await api("/admin/resources/" + name + "?" + params);
  const readonly = [
    "messages",
    "media",
    "audit-logs",
    "notifications",
  ].includes(name);
  const canCreate = [
    "students",
    "teachers",
    "classes",
    "news",
    "admin-users",
    "subject-mappings",
    "teacher-mappings",
  ].includes(name);
  const visible = result.items.map((item) =>
    Object.fromEntries(
      Object.entries(item).filter(
        ([k]) =>
          ![
            "password_hash",
            "storage_key",
            "id",
            "updated_at",
            "normalized_source_name",
          ].includes(k),
      ),
    ),
  );
  const columns = {
    students: ["name", "surname", "email", "class_name", "active"],
    teachers: [
      "name",
      "surname",
      "email",
      "subject",
      "leader_classes",
      "active",
    ],
    classes: [
      "name",
      "school_year",
      "class_teacher_name",
      "students_count",
      "archived",
    ],
    groups: [
      "name",
      "teacher_name",
      "join_code",
      "members_count",
      "pending_count",
      "created_at",
    ],
    messages: ["sender_name", "group_name", "type", "text", "created_at"],
    media: [
      "thumbnail",
      "original_name",
      "uploader_name",
      "group_name",
      "size",
      "created_at",
    ],
    news: ["thumbnail", "title", "body", "is_published", "published_at"],
    grades: [
      "student_name",
      "teacher_name",
      "subject",
      "value",
      "comment",
      "date",
    ],
  };
  const keys =
    columns[name] || [...new Set(visible.flatMap(Object.keys))].slice(0, 9);
  $("#content").innerHTML =
    `<div class="toolbar"><input id="search" placeholder="Search ${esc(name)}…" value="${esc(q)}"><button class="secondary" id="search-button">Search</button>${name === "students" ? '<select id="class-filter"><option value="">All classes</option></select>' : ""}${name === "messages" ? '<input id="group-filter" placeholder="Group ID"><input id="user-filter" placeholder="User ID"><input type="date" id="from-filter" aria-label="From date"><input type="date" id="until-filter" aria-label="Until date">' : ""}${canCreate ? '<button id="new">+ Add ' + esc(name.replace("-mappings", " mapping")) + "</button>" : ""}</div><div class="table-wrap">${result.items.length ? `<table><thead><tr>${keys.map((k) => `<th>${esc(k.replaceAll("_", " "))}</th>`).join("")}<th>Actions</th></tr></thead><tbody>${result.items.map((item) => `<tr>${keys.map((k) => `<td>${renderCell(item, k, name)}</td>`).join("")}<td>${!readonly ? `<button class="secondary edit" data-id="${item.id}">Edit</button>` : ""}${["groups", "classes", "teachers", "students"].includes(name) ? `<button class="secondary details" data-id="${item.id}">Open</button>` : ""}${["media", "messages", "news"].includes(name) && (item.media_id || name === "media") ? `<button class="secondary attachment" data-id="${esc(item.media_id || item.id)}">View attachment</button>` : ""}${!["audit-logs", "notifications"].includes(name) ? `<button class="danger delete" data-id="${item.id}">${["students", "teachers", "admin-users"].includes(name) ? "Deactivate" : name === "classes" ? "Archive" : "Delete"}</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">No records yet. Add your first record to get started.</div>'}</div><div class="pager"><span>${result.total} records · Page ${page}</span><div><button class="secondary" id="prev" ${page <= 1 ? "disabled" : ""}>← Previous</button> <button class="secondary" id="next" ${page * 50 >= result.total ? "disabled" : ""}>Next →</button></div></div>`;
  loadThumbnails();
  const runSearch = () => {
    page = 1;
    const filters = {};
    if ($("#class-filter")) filters.class_id = $("#class-filter").value;
    if ($("#group-filter"))
      Object.assign(filters, {
        group_id: $("#group-filter").value,
        user_id: $("#user-filter").value,
        date_from: $("#from-filter").value,
        date_until: $("#until-filter").value
          ? $("#until-filter").value + " 23:59:59"
          : "",
      });
    return list(name, $("#search").value, filters);
  };
  $("#search-button").onclick = runSearch;
  $("#search").onkeydown = (e) => {
    if (e.key === "Enter") runSearch();
  };
  if ($("#class-filter")) {
    const classes = await api("/classes");
    $("#class-filter").innerHTML +=
      "<option></option>" +
      classes
        .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
        .join("");
    $("#class-filter").value = extra.class_id || "";
    $("#class-filter").onchange = runSearch;
  }
  if ($("#new")) $("#new").onclick = () => edit(name);
  document.querySelectorAll(".edit").forEach(
    (b) =>
      (b.onclick = () =>
        edit(
          name,
          result.items.find((i) => i.id === b.dataset.id),
        )),
  );
  document.querySelectorAll(".delete").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          !confirm(
            "Confirm this action? Account and message history will be retained where required.",
          )
        )
          return;
        try {
          await api(
            `/admin/resources/${name}/${b.dataset.id}?confirm=true`,
            "DELETE",
          );
          await list(name, q, extra);
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  document.querySelectorAll(".details").forEach(
    (b) =>
      (b.onclick = () =>
        detail(
          name,
          result.items.find((i) => i.id === b.dataset.id),
        )),
  );
  document
    .querySelectorAll(".attachment")
    .forEach((b) => (b.onclick = () => viewMedia(b.dataset.id)));
  $("#prev").onclick = () => {
    page--;
    list(name, q, extra);
  };
  $("#next").onclick = () => {
    page++;
    list(name, q, extra);
  };
}
async function edit(name, item = {}) {
  $("#save").textContent = item.id ? "Save changes" : "Create record";
  afterSave = () => list(name);
  const listFields = fields[name] || [];
  let classes = [],
    teachers = [];
  if (
    listFields.some((k) =>
      ["class_id", "class_teacher_id", "teacher_id"].includes(k),
    )
  ) {
    [classes, teachers] = await Promise.all([
      api("/classes"),
      allRecords("teachers"),
    ]);
  }
  $("#dialog-title").textContent = (item.id ? "Edit " : "Create ") + name;
  $("#form-error").textContent = "";
  $("#form-fields").innerHTML = listFields
    .map((k) => {
      if (k === "media_id")
        return '<label>News photograph<input type="file" id="news-image" accept="image/png,image/jpeg,image/webp"></label><div id="image-preview"></div>';
      if (["active", "archived", "is_published"].includes(k))
        return `<label><input type="checkbox" name="${k}" ${(item[k] ?? (k === "active" ? 1 : 0)) ? "checked" : ""}> ${labels[k]}</label>`;
      if (["class_id", "class_teacher_id", "teacher_id"].includes(k)) {
        const choices = k === "class_id" ? classes : teachers;
        return `<label>${labels[k]}<select name="${k}"><option value="">Select…</option>${choices.map((c) => `<option value="${c.id}" ${item[k] === c.id ? "selected" : ""}>${esc(k === "class_id" ? c.name : c.name + " " + c.surname)}</option>`).join("")}</select></label>`;
      }
      if (["body", "description", "comment"].includes(k))
        return `<label>${labels[k] || k}<textarea name="${k}">${esc(item[k])}</textarea></label>`;
      return `<label>${labels[k] || k}<input name="${k}" type="${k === "password" ? "password" : k === "email" ? "email" : k === "value" ? "number" : "text"}" value="${k === "password" ? "" : esc(item[k])}" ${k === "password" ? 'autocomplete="new-password"' : ""} placeholder="${k === "published_at" ? "2026-10-12T08:00:00+04:00" : ""}"></label>`;
    })
    .join("");
  if ($("#news-image"))
    $("#news-image").onchange = () => {
      const f = $("#news-image").files[0];
      if (f) {
        const img = document.createElement("img");
        img.className = "image-thumb";
        img.src = URL.createObjectURL(f);
        $("#image-preview").replaceChildren(img);
      }
    };
  modalSave = async () => {
    const data = Object.fromEntries(new FormData($("#edit-form")));
    for (const k of listFields) {
      if (["active", "archived", "is_published"].includes(k))
        data[k] = $(`[name="${k}"]`).checked ? 1 : 0;
      if (
        data[k] === "" &&
        ["class_teacher_id", "class_id", "teacher_id", "published_at"].includes(
          k,
        )
      )
        data[k] = null;
    }
    if (item.id && !data.password) delete data.password;
    if ($("#news-image")?.files[0]) {
      const fd = new FormData();
      fd.append("file", $("#news-image").files[0]);
      fd.append("purpose", "NEWS");
      data.media_id = (await api("/media", "POST", fd)).id;
    }
    await api(
      "/admin/resources/" + name + (item.id ? "/" + item.id : ""),
      item.id ? "PATCH" : "POST",
      data,
    );
  };
  $("#dialog").showModal();
}
async function detail(name, item) {
  $("#save").textContent = "Close";
  afterSave = null;
  $("#dialog-title").textContent =
    name === "groups" ? item.name : item.name + " " + (item.surname || "");
  let html = "";
  if (name === "groups") {
    const group = await api("/groups/" + item.id),
      requests = await api("/me/requests");
    html = `<p>Code: <strong>${esc(group.join_code)}</strong> · Teacher: ${esc(group.teacher_name)}</p><h3>Members</h3>${group.members.map((m) => `<p>${esc(m.name + " " + m.surname)} · ${esc(m.class_name)} <button type="button" class="danger remove-member" data-id="${m.id}">Remove</button></p>`).join("") || "<p>No members</p>"}<h3>Pending requests</h3>${
      requests
        .filter((r) => r.group_id === item.id)
        .map(
          (r) =>
            `<p>${esc(r.name + " " + r.surname)} · ${esc(r.class_name)} <button type="button" class="accept" data-id="${r.id}">Accept</button> <button type="button" class="danger reject" data-id="${r.id}">Reject</button></p>`,
        )
        .join("") || "<p>No requests</p>"
    }`;
  } else if (name === "classes") {
    const students = (
      await allRecords("students", { class_id: item.id })
    ).filter((s) => s.active);
    const others = (await allRecords("students")).filter(
      (s) => s.active && s.class_id !== item.id,
    );
    html = `<p>${students.length} students · Class teacher: ${esc(item.class_teacher_name || "Not assigned")}</p><label>Add an existing student<select id="class-student">${others.map((s) => `<option value="${s.id}">${esc(s.name + " " + s.surname)} · ${esc(s.class_name || "No class")}</option>`).join("")}</select></label><button type="button" id="class-add" ${!others.length ? "disabled" : ""}>Assign to this class</button> <button type="button" id="class-new">Create student</button><h3>Class members</h3>${students.map((s) => `<p>${esc(s.name + " " + s.surname)} · ${esc(s.email)} <button type="button" class="danger class-remove" data-id="${s.id}">Remove from class</button></p>`).join("")}`;
  } else if (name === "teachers") {
    const groups = (await allRecords("groups")).filter(
      (g) => g.teacher_id === item.id && g.active,
    );
    html = `<p>${esc(item.email)}</p><p>Subject: ${esc(item.subject || "Not assigned")}</p><p>Class leader: ${esc(item.leader_classes || "Not assigned")}</p><h3>Teaching groups (${groups.length})</h3>${groups.map((g) => `<p>${esc(g.name)} · ${g.members_count} members · Code ${esc(g.join_code)}</p>`).join("") || "<p>No groups yet.</p>"}`;
  } else if (name === "students") {
    html = `<p>${esc(item.email)}</p><p>Class: ${esc(item.class_name || "Not assigned")}</p><p>Account: ${item.active ? "Active" : "Deactivated"}</p><p class="muted">Edit this student to change class assignments or account details.</p>`;
  } else
    html = `<div class="details">${esc(JSON.stringify(item, null, 2))}</div>`;
  $("#form-fields").innerHTML = html;
  $("#form-error").textContent = "";
  modalSave = async () => {};
  $("#dialog").showModal();
  if ($("#class-add"))
    $("#class-add").onclick = async () => {
      try {
        await api(
          "/admin/resources/students/" + $("#class-student").value,
          "PATCH",
          { class_id: item.id },
        );
        await detail(name, item);
      } catch (e) {
        toast(e.message);
      }
    };
  if ($("#class-new"))
    $("#class-new").onclick = async () => {
      $("#dialog").close();
      await edit("students", { class_id: item.id });
    };
  document.querySelectorAll(".class-remove").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("Remove this student from the class?")) return;
        try {
          await api("/admin/resources/students/" + b.dataset.id, "PATCH", {
            class_id: null,
          });
          await detail(name, item);
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  document.querySelectorAll(".accept,.reject").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api(
            "/requests/" +
              b.dataset.id +
              "/" +
              (b.classList.contains("accept") ? "accept" : "reject"),
            "POST",
          );
          await detail(name, item);
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  document.querySelectorAll(".remove-member").forEach(
    (b) =>
      (b.onclick = async () => {
        if (confirm("Remove this student from the group?")) {
          await api(`/groups/${item.id}/members/${b.dataset.id}`, "DELETE");
          await detail(name, item);
        }
      }),
  );
}
async function viewMedia(id) {
  $("#save").textContent = "Close";
  try {
    const response = await fetch(API_BASE + "/media/" + id + "/file", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!response.ok) throw Error("Attachment unavailable");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    $("#dialog-title").textContent = "Attachment";
    $("#form-fields").innerHTML =
      blob.type === "application/pdf"
        ? `<p>Original PDF retained for audit.</p><a class="section-link" href="${url}" download="schedule.pdf">Download original PDF →</a>`
        : `<img style="max-width:100%" src="${url}" alt="Uploaded photograph">`;
    modalSave = async () => {};
    $("#dialog").showModal();
    $("#dialog").addEventListener("close", () => URL.revokeObjectURL(url), {
      once: true,
    });
  } catch (e) {
    toast(e.message);
  }
}
async function settings() {
  const values = await api("/admin/settings");
  $("#content").innerHTML =
    `<div class="panel"><h2>School time & import days</h2><p class="muted">Lessons use school time on the backend. Device timezone does not change the school day.</p><form id="settings-form"><label>School timezone<input name="school_timezone" value="${esc(values.school_timezone)}"></label><label>PDF day → weekday mapping<textarea name="day_mapping">${esc(values.day_mapping)}</textarea></label><button>Save settings</button></form></div>`;
  $("#settings-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(
        "/admin/settings",
        "PATCH",
        Object.fromEntries(new FormData(e.target)),
      );
      toast("Settings saved");
    } catch (e) {
      toast(e.message);
    }
  };
}
async function schedules() {
  const history = await api("/admin/schedules/history");
  $("#content").innerHTML =
    `<div class="tabs"><button id="import-tab">Import PDF</button><button class="secondary" id="manual-tab">Manual editor</button><button class="secondary" id="subject-tab">Subject mappings</button><button class="secondary" id="teacher-tab">Teacher mappings</button><button class="secondary" id="class-tab">Class schedules</button><button class="secondary" id="teacher-schedules-tab">Teacher schedules</button></div><div id="schedule-workspace"><div class="two-col"><div class="panel"><h2>Import a school timetable</h2><p class="muted">Upload → Parse → Review → Validate → Publish</p><form id="import-form"><label>Schedule type<select name="type" required><option value="AUTO" selected>Automatic — detect from PDF headings</option><option value="CLASS">Student / Class schedule</option><option value="TEACHER">Teacher schedule</option></select></label><p class="hint">Select both PDFs together. Names identify teachers; class codes (11A1) identify classes. Exact matches are assigned automatically; unmatched or ambiguous names require review.</p><label>PDF file<input name="file" type="file" accept="application/pdf" multiple required></label><label>Academic year<input name="academic_year" value="2026–2027" required></label><label>Version / date<input name="version_label" placeholder="21.09.2026" required></label><label>Effective from<input name="effective_from" type="date" required></label><label>Comment<textarea name="comment"></textarea></label><button>Upload timetable PDFs</button><p id="upload-state" role="status"></p><div id="import-results"></div></form></div><div class="panel"><h2>Review before release</h2><p class="muted">Original PDFs are retained for audit. Student and teacher apps receive structured lessons from the API.</p><p class="hint">Unknown subject codes and teacher identities require administrator confirmation. No automatic publication.</p><h3>Separate schedule sources</h3><p class="muted">Class imports answer “what does this class study?” Teacher imports answer “where does this teacher teach?”</p></div></div></div><div class="panel spacer"><h2>Import history & versions</h2><div class="table-wrap"><table><thead><tr><th>Version</th><th>Type</th><th>Effective</th><th>Status</th><th>Actions</th></tr></thead><tbody>${history.map((i) => `<tr><td>${esc(i.version_label)}</td><td>${i.type}</td><td>${esc(i.effective_from)}</td><td><span class="badge">${i.status}</span> ${i.is_current ? "Current" : ""}</td><td><button class="secondary review" data-id="${i.id}">Review</button>${i.version_id ? `<button class="secondary restore" data-id="${i.version_id}">Restore</button><button class="secondary clone" data-id="${i.id}">Edit a copy</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="5">No imports yet</td></tr>'}</tbody></table></div></div>`;
  $("#subject-tab").onclick = () => list("subject-mappings");
  $("#teacher-tab").onclick = () => list("teacher-mappings");
  $("#import-tab").onclick = schedules;
  $("#manual-tab").onclick = manual;
  $("#class-tab").onclick = () => publishedSchedule("classes");
  $("#teacher-schedules-tab").onclick = () => publishedSchedule("teachers");
  $("#import-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = event.submitter;
    const stateElement = form.querySelector("#upload-state");
    const resultElement = form.querySelector("#import-results");
    button.disabled = true;
    const files = [...form.elements.file.files];
    const results = [];
    try {
      for (const [index, file] of files.entries()) {
        stateElement.textContent = `Reading ${index + 1}/${files.length}: ${file.name}`;
        const body = new FormData(form);
        body.set("file", file);
        try {
          const item = await api("/admin/schedules/import", "POST", body);
          if (item.status === "UPLOADED")
            await api(`/admin/schedules/import/${item.id}/parse`, "POST");
          const detail = await api(`/admin/schedules/import/${item.id}`);
          results.push(
            `<p>${esc(file.name)} · ${esc(detail.type)} · ${detail.draft.identities?.length || 0} headings · ${detail.draft.entries?.length || 0} lessons <button type="button" class="secondary batch-review" disabled data-id="${item.id}">Review & publish</button></p><div class="issues">${issueSummary(detail.issues || [])}</div>`,
          );
        } catch (error) {
          results.push(
            `<p role="alert">${esc(file.name)}: ${esc(error.message)}</p>`,
          );
        }
        resultElement.innerHTML = results.join("");
        resultElement.querySelectorAll(".batch-review").forEach((control) => {
          control.onclick = () =>
            reviewImport(control.dataset.id).catch((error) =>
              toast(error.message),
            );
        });
      }
      stateElement.textContent =
        "Processing finished. Review each result; schedules become available in the apps after publication.";
    } finally {
      button.disabled = false;
      resultElement.querySelectorAll(".batch-review").forEach((control) => {
        control.disabled = false;
      });
    }
  };
  document
    .querySelectorAll(".review")
    .forEach((b) => (b.onclick = () => reviewImport(b.dataset.id)));
  document.querySelectorAll(".restore").forEach(
    (b) =>
      (b.onclick = async () => {
        if (confirm("Restore this version? This action is audited.")) {
          try {
            await api(
              "/admin/schedules/versions/" + b.dataset.id + "/restore",
              "POST",
              { confirm: true },
            );
            await schedules();
          } catch (e) {
            toast(e.message);
          }
        }
      }),
  );
  document.querySelectorAll(".clone").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          const item = await api(
            "/admin/schedules/import/" + b.dataset.id + "/clone",
            "POST",
          );
          await reviewImport(item.id);
        } catch (e) {
          toast(e.message);
        }
      }),
  );
}
async function reviewImport(id) {
  currentImport = await api("/admin/schedules/import/" + id);
  draft = currentImport.draft;
  if (!draft.entries && currentImport.status !== "FAILED") {
    await api("/admin/schedules/import/" + id + "/parse", "POST");
    currentImport = await api("/admin/schedules/import/" + id);
    draft = currentImport.draft;
  }
  const locked = ["PUBLISHED", "SUPERSEDED"].includes(currentImport.status);
  $("#schedule-workspace").innerHTML =
    `<div class="panel"><div class="toolbar"><h2>${esc(currentImport.version_label)} · ${currentImport.type}</h2>${currentImport.media_id ? '<button class="secondary" id="pdf-source">Original PDF</button>' : ""}<button class="secondary" id="reparse" ${locked ? "disabled" : ""}>Parse again</button></div><p class="muted">${draft.pages_parsed || 0} pages · ${draft.identities?.length || 0} identities · ${draft.entries?.length || 0} lesson slots · ${currentImport.status}</p><div class="toolbar"><select id="identity-select"></select><button class="secondary" id="create-classes" ${locked ? "disabled" : ""}>Create missing classes…</button><button class="secondary" id="save-cells" ${locked ? "disabled" : ""}>Save & validate</button><button id="publish" ${locked ? "disabled" : ""}>Publish schedule</button></div><p class="hint">Teachers are matched automatically to active teacher accounts by name. Unknown or ambiguous names need a Teacher mapping. Class codes match existing classes. Unknown subject abbreviations still require a Subject mapping. Review and publish each PDF to make schedules available in the apps.</p>${currentImport.type === "TEACHER" ? '<div id="teacher-match"></div>' : ""}<div id="review-layout"><div id="schedule-grid"></div><div id="source-pane" hidden></div></div><div class="issues">${issueSummary(currentImport.issues || [])}</div>${draft.issues?.some((i) => i.severity === "ERROR") ? '<label><input type="checkbox" id="ack-parser-issues"> I corrected the structural parser issues in this draft.</label>' : ""}</div>`;
  const identities = [
    ...new Set((draft.entries || []).map((e) => e.source_identity)),
  ];
  $("#identity-select").innerHTML = identities
    .map((i) => `<option>${esc(i)}</option>`)
    .join("");
  $("#identity-select").onchange = renderGrid;
  renderGrid();
  if ($("#pdf-source")) $("#pdf-source").onclick = () => previewSource();
  $("#reparse").onclick = async () => {
    try {
      await api("/admin/schedules/import/" + id + "/parse", "POST");
      await reviewImport(id);
    } catch (e) {
      toast(e.message);
    }
  };
  $("#save-cells").onclick = async () => {
    try {
      await saveCells();
      await reviewImport(id);
    } catch (e) {
      toast(e.message);
    }
  };
  $("#publish").onclick = async () => {
    if (
      !confirm(
        "Publish this schedule after verifying all mappings and lessons?",
      )
    )
      return;
    const warnings = currentImport.issues.some((i) => i.severity === "WARNING");
    if (
      warnings &&
      !confirm(
        "Merged cells or other warnings remain. Confirm that you reviewed them.",
      )
    )
      return;
    try {
      await saveCells();
      await api("/admin/schedules/import/" + id + "/publish", "POST", {
        confirm: true,
        confirm_warnings: warnings,
      });
      toast("Schedule published");
      await schedules();
    } catch (e) {
      toast(e.message);
    }
  };
  $("#create-classes").onclick = async () => {
    const names = [...new Set(draft.entries.map((e) => e.class_name))];
    const existing = await api("/classes");
    const missing = names.filter(
      (n) => !existing.some((c) => c.name.toUpperCase() === n.toUpperCase()),
    );
    if (!missing.length) {
      toast("All classes already exist");
      return;
    }
    if (
      !confirm(
        "Create " + missing.length + " classes: " + missing.join(", ") + "?",
      )
    )
      return;
    try {
      for (const name of missing)
        await api("/admin/resources/classes", "POST", {
          name,
          school_year: currentImport.academic_year,
        });
      await reviewImport(id);
    } catch (e) {
      toast(e.message);
    }
  };
}
function renderGrid() {
  const identity = $("#identity-select").value;
  const entries = (draft.entries || []).filter(
    (e) => e.source_identity === identity,
  );
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  $("#schedule-grid").innerHTML =
    `<div class="table-wrap"><table class="schedule"><thead><tr><th>Lesson</th>${days.map((d) => `<th>${d}</th>`).join("")}</tr></thead><tbody>${Array.from(
      { length: 8 },
      (_, i) =>
        `<tr><th>${i + 1}</th>${days
          .map((_, d) => {
            const entry = entries.find(
              (e) => e.weekday === d + 1 && e.lesson_number === i + 1,
            );
            const index = entry ? draft.entries.indexOf(entry) : -1;
            return `<td><button class="secondary cell-edit" data-index="${index}" data-day="${d + 1}" data-lesson="${i + 1}">${entry ? esc(entry.subject_code) + (currentImport.type === "TEACHER" ? "<br>" + esc(entry.class_name) : "") + "<br><small>" + esc(entry.start_time) + "–" + esc(entry.end_time) + "</small>" : "＋"}</button></td>`;
          })
          .join("")}</tr>`,
    ).join("")}</tbody></table></div>`;
  document
    .querySelectorAll(".cell-edit")
    .forEach((b) => (b.onclick = () => editCell(b, identity)));
  if (currentImport.type === "TEACHER") loadTeacherMapping(identity);
}
async function editCell(button, identity) {
  $("#save").textContent = "Save lesson";
  afterSave = () => reviewImport(currentImport.id);
  if (["PUBLISHED", "SUPERSEDED"].includes(currentImport.status))
    return toast("Edit a copy of this version");
  const index = Number(button.dataset.index),
    entry =
      index >= 0
        ? draft.entries[index]
        : {
            source_identity: identity,
            class_name: currentImport.type === "CLASS" ? identity : "",
            source_teacher: currentImport.type === "TEACHER" ? identity : null,
            weekday: Number(button.dataset.day),
            lesson_number: Number(button.dataset.lesson),
            start_time: [
              "08:00",
              "08:50",
              "09:45",
              "10:35",
              "11:40",
              "12:30",
              "13:20",
              "14:10",
            ][Number(button.dataset.lesson) - 1],
            end_time: [
              "08:45",
              "09:35",
              "10:30",
              "11:20",
              "12:25",
              "13:15",
              "14:05",
              "14:55",
            ][Number(button.dataset.lesson) - 1],
            subject_code: "",
          };
  const teachers = await allRecords("teachers");
  $("#dialog-title").textContent = "Edit lesson";
  $("#form-fields").innerHTML =
    ["class_name", "subject_code", "start_time", "end_time", "teacher_id"]
      .map((k) =>
        k === "teacher_id"
          ? `<label>Teacher<select name="teacher_id"><option value="">Unassigned</option>${teachers.map((t) => `<option value="${t.id}" ${entry.teacher_id === t.id ? "selected" : ""}>${esc(t.name + " " + t.surname)}</option>`).join("")}</select></label>`
          : `<label>${esc(k.replaceAll("_", " "))}<input name="${k}" value="${esc(entry[k])}" ${k.endsWith("_time") ? 'type="time"' : ""}></label>`,
      )
      .join("") +
    '<label><input type="checkbox" name="remove"> Remove this lesson</label>';
  $("#form-error").textContent = "";
  modalSave = async () => {
    const values = Object.fromEntries(new FormData($("#edit-form")));
    const remove = values.remove;
    delete values.remove;
    values.teacher_id = values.teacher_id || null;
    if (index >= 0) {
      if (remove) draft.entries.splice(index, 1);
      else draft.entries[index] = { ...entry, ...values, merged: false };
    } else if (!remove) draft.entries.push({ ...entry, ...values });
    await saveCells();
  };
  $("#dialog").showModal();
}
function saveCells() {
  return api(
    "/admin/schedules/import/" + currentImport.id + "/cells",
    "PATCH",
    {
      entries: draft.entries,
      acknowledge_parser_issues: $("#ack-parser-issues")?.checked === true,
    },
  );
}
async function manual() {
  const type = prompt("Schedule type: CLASS or TEACHER", "CLASS");
  if (!["CLASS", "TEACHER"].includes(type)) return;
  const identity = prompt(
    type === "CLASS"
      ? "Existing class name"
      : "Teacher name as confirmed in mapping",
  );
  if (!identity) return;
  const date = prompt("Effective from (YYYY-MM-DD)", "2026-10-12");
  try {
    const item = await api("/admin/schedules/manual", "POST", {
      type,
      effective_from: date,
      version_label: "Manual " + identity,
      entries: [
        {
          source_identity: identity,
          class_name: type === "CLASS" ? identity : "",
          source_teacher: type === "TEACHER" ? identity : null,
          weekday: 1,
          lesson_number: 1,
          start_time: "08:00",
          end_time: "08:45",
          subject_code: "",
        },
      ],
    });
    await reviewImport(item.id);
  } catch (e) {
    toast(e.message);
  }
}
async function publishedSchedule(kind) {
  const choices =
    kind === "classes" ? await api("/classes") : await allRecords("teachers");
  $("#schedule-workspace").innerHTML =
    `<div class="panel"><label>${kind === "classes" ? "Class" : "Teacher"}<select id="published-identity">${choices.map((c) => `<option value="${c.id}">${esc(c.name + " " + (c.surname || ""))}</option>`).join("")}</select></label><div id="published-grid"></div></div>`;
  const load = async () => {
    try {
      const entries = await api(
        `/admin/schedules/${kind}/entries?identity=` +
          $("#published-identity").value,
      );
      $("#published-grid").innerHTML = entries.length
        ? `<div class="table-wrap"><table><tr><th>Day</th><th>Lesson</th><th>Time</th><th>Class</th><th>Subject</th></tr>${entries.map((e) => `<tr><td>${e.weekday}</td><td>${e.lesson_number}</td><td>${e.start_time}–${e.end_time}</td><td>${esc(e.class_name)}</td><td>${esc(e.subject)}</td></tr>`).join("")}</table></div>`
        : '<p class="muted">No published schedule for this identity.</p>';
    } catch (e) {
      toast(e.message);
    }
  };
  $("#published-identity").onchange = load;
  if (choices.length) await load();
}

function issueSummary(issues) {
  if (!issues.length) return "No validation issues.";
  const categories = new Map();
  for (const issue of issues) {
    const key = issue.severity + "|" + issue.message;
    if (!categories.has(key))
      categories.set(key, { ...issue, count: 0, examples: [] });
    const category = categories.get(key);
    category.count++;
    if (category.examples.length < 3 && issue.entry !== undefined)
      category.examples.push(issue.entry);
  }
  return [...categories.values()]
    .map(
      (i) =>
        `<p><span class="badge ${i.severity.toLowerCase()}">${i.severity}</span> ${esc(i.message)} · <strong>${i.count} affected cells</strong>${i.examples.length ? " · examples: " + i.examples.join(", ") : ""}</p>`,
    )
    .join("");
}

async function allRecords(name, filters = {}) {
  const items = [];
  let page = 1,
    total = 1;
  while (items.length < total) {
    const data = await api(
      "/admin/resources/" +
        name +
        "?" +
        new URLSearchParams({ ...filters, page }),
    );
    items.push(...data.items);
    total = data.total;
    page++;
    if (!data.items.length) break;
  }
  return items;
}

async function loadTeacherMapping(identity) {
  try {
    const [teachers, mappings] = await Promise.all([
      allRecords("teachers"),
      allRecords("teacher-mappings"),
    ]);
    const norm = (s) =>
      s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    const mapping = mappings.find(
      (m) => norm(m.source_name) === norm(identity),
    );
    const suggestion =
      currentImport.suggested_teacher_mappings?.find(
        (m) => m.source_name === identity,
      )?.candidate_ids || [];
    const selected =
      mapping?.teacher_id || (suggestion.length === 1 ? suggestion[0] : "");
    if (!$("#teacher-match") || $("#identity-select").value !== identity)
      return;
    $("#teacher-match").innerHTML =
      `<div class="hint"><strong>PDF teacher: ${esc(identity)}</strong><p>${mapping ? "Confirmed account mapping" : suggestion.length === 1 ? "Automatically matched to this teacher account. No manual confirmation is required." : "No unique account match. Select and confirm the correct teacher."}</p><label>Teacher account<select id="mapped-teacher"><option value="">Select account…</option>${teachers
        .filter((t) => t.active)
        .map(
          (t) =>
            `<option value="${t.id}" ${selected === t.id ? "selected" : ""}>${esc(t.name + " " + t.surname)} · ${esc(t.email)}</option>`,
        )
        .join(
          "",
        )}</select></label><button class="secondary" id="confirm-teacher">Confirm mapping</button></div>`;
    $("#confirm-teacher").onclick = async () => {
      const teacherId = $("#mapped-teacher").value;
      if (!teacherId) return toast("Choose a teacher account");
      try {
        await api(
          "/admin/resources/teacher-mappings" +
            (mapping ? "/" + mapping.id : ""),
          mapping ? "PATCH" : "POST",
          { source_name: identity, teacher_id: teacherId },
        );
        toast("Teacher identity confirmed");
        await reviewImport(currentImport.id);
      } catch (e) {
        toast(e.message);
      }
    };
  } catch (e) {
    toast(e.message);
  }
}
function renderCell(item, key, name) {
  if (key === "thumbnail") {
    const id = name === "media" ? item.id : item.media_id;
    return id && (name !== "media" || item.mime?.startsWith("image/"))
      ? `<img class="image-thumb media-thumbnail" data-id="${esc(id)}" alt="Photo preview">`
      : "—";
  }
  if (["role", "status"].includes(key))
    return `<span class="badge">${esc(item[key])}</span>`;
  if (["active", "archived", "is_published"].includes(key))
    return item[key] ? "Yes" : "No";
  if (key === "size") return Math.round(item.size / 1024) + " KB";
  return esc(item[key]).slice(0, 400);
}
function loadThumbnails() {
  document.querySelectorAll(".media-thumbnail").forEach(async (img) => {
    try {
      const response = await fetch(
        API_BASE + "/admin/media/" + img.dataset.id + "/thumbnail",
        { headers: { Authorization: "Bearer " + token } },
      );
      if (!response.ok) throw Error("Unavailable");
      const url = URL.createObjectURL(await response.blob());
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
    } catch (_) {
      img.alt = "Photo unavailable";
    }
  });
}
async function previewSource(page) {
  const pane = $("#source-pane");
  if (!pane) return;
  const entry = draft.entries?.find(
    (e) => e.source_identity === $("#identity-select").value,
  );
  page = page || entry?.page || 1;
  pane.hidden = false;
  $("#review-layout").className = "two-col";
  pane.innerHTML = '<p class="muted">Rendering original PDF page…</p>';
  try {
    const response = await fetch(
      `${API_BASE}/admin/schedules/import/${currentImport.id}/preview/${page}`,
      { headers: { Authorization: "Bearer " + token } },
    );
    if (!response.ok) throw Error("Original page cannot be rendered");
    const blob = await response.blob(),
      url = URL.createObjectURL(blob);
    pane.innerHTML = `<label>Original PDF page<select id="source-page">${Array.from({ length: draft.pages_parsed || page }, (_, i) => `<option value="${i + 1}" ${i + 1 === Number(page) ? "selected" : ""}>Page ${i + 1}</option>`).join("")}</select></label><img style="width:100%;border:1px solid #e4e4ee;border-radius:10px" src="${url}" alt="Original PDF page ${page}"><p class="muted">Rendered on the server; embedded PDF scripts are not executed.</p>`;
    $("#source-page").onchange = () => {
      URL.revokeObjectURL(url);
      previewSource(Number($("#source-page").value));
    };
  } catch (e) {
    pane.innerHTML = `<p>${esc(e.message)}</p>`;
  }
}

start();
