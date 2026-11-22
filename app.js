// Pagemarks v11 — app logic
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc,
  writeBatch, serverTimestamp, Timestamp, getDocsFromServer, query, limit
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

// ---------- Firebase ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch {
  db = initializeFirestore(app, {});
}

// ---------- State ----------
let user = null;
let isAdmin = false;
let pagemarks = [];          // [{id, ...data}]
let unsubPagemarks = null;
let unsubInvites = null;
let view = { type: "all", value: null };   // all | later | unfiled | folder | tag | broken | moved | unknown
let editingId = null;
let extraFolders = [];       // folders you created that may still be empty (synced in Firestore)
let unsubMeta = null;

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
};

function showScreen(name) {
  for (const s of ["loading", "signin", "notinvited", "app"]) {
    $(`#screen-${s}`).hidden = s !== name;
  }
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// Styled replacement for the browser's confirm()/alert(). Resolves true if OK was clicked.
function ask({ title, text, ok = "OK", cancel = "Cancel", danger = false }) {
  const dlg = $("#dlg-confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text || "";
  $("#confirm-text").hidden = !text;
  const okBtn = $("#confirm-ok");
  okBtn.textContent = ok;
  okBtn.className = "btn " + (danger ? "danger-solid" : "primary");
  $("#confirm-cancel").textContent = cancel;
  $("#confirm-cancel").hidden = cancel === null;
  return new Promise((resolve) => {
    dlg.returnValue = "cancel";
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
    dlg.showModal();
    (danger ? $("#confirm-cancel") : okBtn).focus();
  });
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- Organize mode ----------
let editing = false;
try { editing = localStorage.getItem("pm-editing") === "1"; } catch { /* ignore */ }
function setEditing(on) {
  editing = on;
  try { localStorage.setItem("pm-editing", on ? "1" : "0"); } catch { /* ignore */ }
  if (!on) selected.clear();
  document.body.classList.toggle("editing", on);
  const b = $("#btn-editmode");
  b.textContent = on ? "✓ Done" : "Organize";
  b.classList.toggle("primary", on);
  if (!on && ["broken", "moved", "unknown"].includes(view.type)) view = { type: "all", value: null };
  render();
}

function withScheme(raw) {
  const s = raw.trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s;
}

function parseUrl(raw) {
  try {
    const u = new URL(withScheme(raw));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch { return null; }
}

// Used for duplicate detection: ignores http/https, www., trailing slash, #hash and tracking codes.
function normalizeUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return (raw || "").trim().toLowerCase();
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$)/i.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? "?" + new URLSearchParams(params).toString() : "";
  let path = u.pathname.replace(/\/+$/, "");
  return host + (u.port ? ":" + u.port : "") + path + qs;
}

function hostOf(url) {
  const u = parseUrl(url);
  return u ? u.hostname.replace(/^www\./, "") : "";
}

function parseTags(s) {
  return [...new Set(
    (s || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
  )];
}

function cleanFolder(s) {
  return (s || "").split("/").map((p) => p.trim()).filter(Boolean).join(" / ");
}

function dateOf(b) {
  const c = b.createdAt;
  if (c && typeof c.toDate === "function") return c.toDate();
  return new Date();
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function pmCol() { return collection(db, "users", user.uid, "pagemarks"); }

// Free title lookup (microlink.io). Falls back quietly if it fails or hits its daily limit.
async function lookupPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch("https://api.microlink.io/?url=" + encodeURIComponent(url), { signal: ctrl.signal });
    const j = await r.json();
    if (j.status === "success" && j.data) {
      return { title: j.data.title || "", description: j.data.description || "" };
    }
  } catch { /* ignore */ }
  finally { clearTimeout(timer); }
  return null;
}

// ---------- Auth ----------
$("#btn-signin").addEventListener("click", async () => {
  $("#signin-error").hidden = true;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      $("#signin-error").textContent = "Sign-in failed: " + (e.message || e.code);
      $("#signin-error").hidden = false;
    }
  }
});

const doSignOut = () => signOut(auth);
$("#btn-signout").addEventListener("click", () => { $("#dlg-settings").close(); doSignOut(); });
$("#btn-signout-ni").addEventListener("click", doSignOut);

onAuthStateChanged(auth, async (u) => {
  if (unsubPagemarks) { unsubPagemarks(); unsubPagemarks = null; }
  if (unsubInvites) { unsubInvites(); unsubInvites = null; }
  if (unsubMeta) { unsubMeta(); unsubMeta = null; }
  extraFolders = [];
  user = u;
  pagemarks = [];
  if (!u) { showScreen("signin"); return; }

  showScreen("loading");
  const email = (u.email || "").toLowerCase();
  // Only the owner is allowed to list the invite list, so a successful read means "owner".
  try {
    await getDocsFromServer(query(collection(db, "allowlist"), limit(1)));
    isAdmin = true;
  } catch { isAdmin = false; }

  let invited = isAdmin;
  if (!invited) {
    try {
      const snap = await getDoc(doc(db, "allowlist", email));
      invited = snap.exists();
    } catch { invited = false; }
  }
  if (!invited) {
    $("#notinvited-email").textContent = u.email;
    showScreen("notinvited");
    return;
  }

  $("#me-email").textContent = u.email;
  $("#invite-section").hidden = !isAdmin;
  showScreen("app");
  startPagemarks();
  if (isAdmin) startInvites();
});

// ---------- Live data ----------
const metaRef = () => doc(db, "users", user.uid, "meta", "folders");
function saveExtraFolders(list) {
  extraFolders = [...new Set(list)].sort((a, b) => a.localeCompare(b));
  render();
  return setDoc(metaRef(), { paths: extraFolders, updatedAt: serverTimestamp() });
}

// Every folder stays until you delete it: any folder in use is also recorded in the folder list,
// so it remains (with a count of 0) after its last Pagemark is deleted or moved out.
let metaLoaded = false, pmLoaded = false, syncing = false, relocating = 0;
async function syncFolders() {
  // Paused while a folder is being moved/renamed, so the old name isn't re-recorded mid-move
  if (!metaLoaded || !pmLoaded || syncing || relocating) return;
  const known = new Set(extraFolders);
  const missing = [...new Set(pagemarks.map((b) => b.folder).filter(Boolean))].filter((f) => !known.has(f));
  if (!missing.length) return;
  syncing = true;
  try { await saveExtraFolders([...extraFolders, ...missing]); } catch (e) { console.error(e); }
  finally { syncing = false; }
}

function startPagemarks() {
  metaLoaded = false; pmLoaded = false;
  unsubMeta = onSnapshot(metaRef(), (s) => {
    extraFolders = s.exists() ? (s.data().paths || []) : [];
    metaLoaded = true;
    render();
    syncFolders();
  }, (err) => console.error(err));
  unsubPagemarks = onSnapshot(pmCol(), (snap) => {
    pagemarks = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    pmLoaded = true;
    render();
    syncFolders();
  }, (err) => {
    console.error(err);
    toast("Could not load Pagemarks. Check the Firestore rules.");
  });
}

// ---------- Rendering ----------
const LINK_LABEL = { ok: "Working", moved: "Moved", broken: "Broken", unknown: "Couldn't check" };
const selected = new Set();
let expanded = new Set();
try { expanded = new Set(JSON.parse(localStorage.getItem("pm-expanded") || "[]")); } catch { /* ignore */ }
const saveExpanded = () => { try { localStorage.setItem("pm-expanded", JSON.stringify([...expanded])); } catch { /* ignore */ } };

const linkStatus = (b) => (b.link && b.link.status) || "pending";

function filtered() {
  let list = pagemarks;
  if (view.type === "later") list = list.filter((b) => b.readLater);
  else if (view.type === "unfiled") list = list.filter((b) => !b.folder);
  else if (view.type === "folder") list = list.filter((b) => b.folder === view.value || (b.folder || "").startsWith(view.value + " / "));
  else if (view.type === "tag") list = list.filter((b) => (b.tags || []).includes(view.value));
  else if (["broken", "moved", "unknown"].includes(view.type)) list = list.filter((b) => linkStatus(b) === view.type);

  const terms = $("#search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    list = list.filter((b) => {
      const hay = [b.title, b.url, b.description, b.notes, b.folder, ...(b.tags || [])]
        .join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  const sort = $("#sort").value;
  list = [...list];
  if (sort === "az") list.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url, undefined, { sensitivity: "base" }));
  else if (sort === "old") list.sort((a, b) => dateOf(a) - dateOf(b));
  else list.sort((a, b) => dateOf(b) - dateOf(a));
  return list;
}

function viewTitle() {
  if (view.type === "later") return "Read later";
  if (view.type === "unfiled") return "Unfiled";
  if (view.type === "folder") return view.value;
  if (view.type === "tag") return "Tag: " + view.value;
  if (view.type === "broken") return "Broken links";
  if (view.type === "moved") return "Moved pages";
  if (view.type === "unknown") return "Couldn't check";
  return "All Pagemarks";
}

// Build a nested folder tree with counts that include subfolders.
function buildTree() {
  const root = { children: new Map(), count: 0 };
  for (const p of extraFolders) {
    let node = root;
    let path = "";
    for (const part of p.split(" / ")) {
      path = path ? path + " / " + part : part;
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), count: 0 });
      node = node.children.get(part);
    }
  }
  for (const b of pagemarks) {
    if (!b.folder) continue;
    let node = root;
    let path = "";
    for (const part of b.folder.split(" / ")) {
      path = path ? path + " / " + part : part;
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), count: 0 });
      node = node.children.get(part);
      node.count++;
    }
  }
  return root;
}

function renderTree(node, depth) {
  const items = [];
  const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const k of kids) {
    const hasKids = k.children.size > 0;
    const open = expanded.has(k.path);
    const active = view.type === "folder" && view.value === k.path;
    const toggle = hasKids
      ? el("button", {
          class: "twisty", "aria-label": open ? "Collapse" : "Expand",
          onclick: (e) => { e.stopPropagation(); open ? expanded.delete(k.path) : expanded.add(k.path); saveExpanded(); render(); }
        }, open ? "▾" : "▸")
      : el("span", { class: "twisty-space" });
    const li = el("li", {},
      el("div", { class: "tree-row", style: `padding-left:${depth * 14}px` },
        toggle,
        el("button", {
          class: "nav-item" + (active ? " active" : ""), title: k.path,
          draggable: editing ? "true" : "false", "data-folder": k.path,
          onclick: () => setView({ type: "folder", value: k.path })
        }, el("span", { class: "label", text: k.name }), el("span", { class: "count", text: String(k.count) }))
      )
    );
    const btn = li.querySelector(".nav-item");
    btn.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-pm-folder", k.path);
      e.dataTransfer.effectAllowed = "move";
      document.body.classList.add("dragging");
    });
    btn.addEventListener("dragend", endDrag);
    makeDropTarget(btn, k.path);
    items.push(li);
    if (hasKids && open) items.push(...renderTree(k, depth + 1));
  }
  return items;
}

function render() {
  // Drop selections that no longer exist
  const ids = new Set(pagemarks.map((b) => b.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);

  // Counts
  const count = (fn) => pagemarks.filter(fn).length;
  $("#count-all").textContent = pagemarks.length;
  $("#count-later").textContent = count((b) => b.readLater);
  const unfiled = count((b) => !b.folder);
  $("#count-unfiled").textContent = unfiled;
  $("#tidy-count").textContent = unfiled;
  $("#btn-tidy").hidden = unfiled === 0;
  for (const s of ["broken", "moved", "unknown"]) $(`#count-${s}`).textContent = count((b) => linkStatus(b) === s);
  const checked = count((b) => linkStatus(b) !== "pending");
  $("#health-note").textContent = checked ? "" : "Links are checked every night.";

  // Sidebar nav state
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view.type);
  });

  // Folder tree
  const tree = buildTree();
  const fl = $("#folder-list");
  fl.replaceChildren(...renderTree(tree, 0));
  if (!tree.children.size) fl.append(el("li", { class: "muted", text: "None yet" }));
  const allFolders = allFolderPaths();
  const opts = () => allFolders.map((f) => el("option", { value: f }));
  $("#folder-options").replaceChildren(...opts());

  // Tags
  const tagCounts = new Map();
  for (const b of pagemarks) for (const t of b.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const tags = [...tagCounts.keys()].sort((a, b) => a.localeCompare(b));
  const tl = $("#tag-list");
  tl.replaceChildren(...tags.map((t) => el("button", {
    class: "chip" + (view.type === "tag" && view.value === t ? " active" : ""),
    onclick: () => setView({ type: "tag", value: t }),
    text: `${t} (${tagCounts.get(t)})`
  })));
  if (!tags.length) tl.append(el("span", { class: "muted", text: "None yet" }));

  // List
  $("#view-title").textContent = viewTitle();
  $("#folder-tools").hidden = view.type !== "folder";
  $("#folder-delete").hidden = !(view.type === "folder" && !pagemarks.some((b) => b.folder && isInside(b.folder, view.value)));
  const items = filtered();
  $("#list").replaceChildren(...items.map(renderItem));
  $("#empty").hidden = items.length > 0;
  if (!items.length) {
    const inFolder = view.type === "folder";
    $("#empty-title").textContent = inFolder ? "This folder is empty." : "No Pagemarks here yet.";
    $("#empty-hint").textContent = inFolder
      ? (editing ? "Drag Pagemarks onto it in the sidebar, or tick them elsewhere and use Move to folder…" : "Click Organize to move Pagemarks here.")
      : "Click + Add to save a Pagemark, or import your favorites under ⚙ Settings.";
  }
  renderBulkBar(items);
}

function linkBadge(b) {
  const s = linkStatus(b);
  if (s === "pending") return el("span", { class: "dot dot-pending", title: "Not checked yet" });
  const when = b.link.checkedAt && b.link.checkedAt.toDate ? " · checked " + fmtDate(b.link.checkedAt.toDate()) : "";
  const why = b.link.reason ? ` (${b.link.reason})` : "";
  return el("span", { class: `dot dot-${s}`, title: LINK_LABEL[s] + why + when });
}

function renderItem(b) {
  const host = hostOf(b.url);
  const safeHref = parseUrl(b.url) ? parseUrl(b.url).href : "#";
  const s = linkStatus(b);

  const box = el("input", { type: "checkbox", class: "pick", "aria-label": "Select" });
  box.checked = selected.has(b.id);
  box.addEventListener("change", () => { box.checked ? selected.add(b.id) : selected.delete(b.id); render(); });

  const fav = el("div", { class: "fav" });
  if (host) {
    const img = el("img", { alt: "", loading: "lazy", src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` });
    img.addEventListener("error", () => { fav.textContent = host[0].toUpperCase(); });
    fav.append(img);
  } else fav.textContent = "?";

  const title = el("a", { class: "bm-title", href: safeHref, target: "_blank", rel: "noopener noreferrer", text: b.title || host || b.url });
  const titleLine = el("div", { class: "title-line" }, linkBadge(b), title);
  if (s === "broken") titleLine.append(el("span", { class: "pill pill-broken", text: "Broken" }));
  if (s === "moved") titleLine.append(el("span", { class: "pill pill-moved", text: "Moved" }));
  if (b.readLater) titleLine.append(el("span", { class: "later-badge", text: "Read later" }));

  const meta = el("div", { class: "bm-meta" });
  meta.append(host + " · " + fmtDate(dateOf(b)));
  if (b.folder) {
    meta.append(" · ");
    meta.append(el("span", { class: "folder-label", text: b.folder }));
  }

  const body = el("div", { class: "bm-body" }, titleLine, meta);

  if (s === "broken") {
    const fix = el("div", { class: "fix-row" }, el("span", { text: "This page no longer loads." }));
    if (b.link.archiveUrl) fix.append(" ", el("a", { href: b.link.archiveUrl, target: "_blank", rel: "noopener noreferrer", text: "Open the archived copy" }));
    else fix.append(" ", el("a", { href: "https://web.archive.org/web/*/" + b.url, target: "_blank", rel: "noopener noreferrer", text: "Search the Internet Archive" }));
    body.append(fix);
  }
  if (s === "moved" && b.link.finalUrl) {
    if (suspiciousMove(b.url, b.link.finalUrl)) body.append(el("div", { class: "fix-row warn-text", text: "Goes to a home or sign-in page, so the original may be gone." }));
    body.append(el("div", { class: "fix-row" },
      el("span", { text: "Now goes to " }),
      el("span", { class: "mono", text: hostOf(b.link.finalUrl) + (parseUrl(b.link.finalUrl)?.pathname || "") }),
      " ",
      el("button", { class: "btn small", text: "Update link", onclick: () => updateLink(b) })
    ));
  }

  if (b.description) body.append(el("p", { class: "bm-desc", text: b.description }));
  if (b.notes) body.append(el("p", { class: "bm-notes", text: b.notes }));
  if ((b.tags || []).length) {
    body.append(el("div", { class: "bm-tags" },
      ...b.tags.map((t) => el("button", { class: "chip", text: t, onclick: () => setView({ type: "tag", value: t }) }))));
  }

  const actions = el("div", { class: "bm-actions" },
    el("button", {
      class: "btn small",
      title: b.readLater ? "Mark as read" : "Read later",
      text: b.readLater ? "✓ Read" : "Later",
      onclick: () => updateDoc(doc(pmCol(), b.id), { readLater: !b.readLater, updatedAt: serverTimestamp() })
    }),
    el("button", { class: "btn small", text: "Edit", onclick: () => openEdit(b) })
  );

  const li = el("li", { class: "bm" + (selected.has(b.id) ? " picked" : ""), draggable: editing ? "true" : "false" }, box, fav, body, actions);
  li.addEventListener("dragstart", (e) => {
    if (e.target !== li) return;
    const ids = selected.has(b.id) ? [...selected] : [b.id];
    e.dataTransfer.setData("application/x-pm-ids", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    document.body.classList.add("dragging");
    if (ids.length > 1) {
      const ghost = el("div", { class: "drag-ghost", text: `${ids.length} Pagemarks` });
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
    }
  });
  li.addEventListener("dragend", endDrag);
  return li;
}

async function updateLink(b) {
  const u = parseUrl(b.link.finalUrl);
  if (!u) return;
  await updateDoc(doc(pmCol(), b.id), {
    url: u.href, normUrl: normalizeUrl(u.href),
    link: { ...b.link, status: "ok", finalUrl: "", reason: "", fails: 0 },
    updatedAt: serverTimestamp()
  });
  toast("Link updated");
}

function setView(v) {
  view = v;
  selected.clear();
  document.querySelector(".sidebar").classList.remove("open");
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => setView({ type: btn.dataset.view, value: null }));
});
$("#brand-home").addEventListener("click", (e) => { e.preventDefault(); $("#search").value = ""; setView({ type: "all", value: null }); });
$("#search").addEventListener("input", () => { selected.clear(); render(); });
$("#btn-filters").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));
$("#sort").addEventListener("change", render);

// ---------- Folders: move, rename, drag and drop ----------
const parentOf = (path) => path.includes(" / ") ? path.slice(0, path.lastIndexOf(" / ")) : "";
const nameOf = (path) => path.split(" / ").pop();
const isInside = (path, folder) => path === folder || path.startsWith(folder + " / ");

function endDrag() {
  document.body.classList.remove("dragging");
  document.querySelectorAll(".drop-over").forEach((n) => n.classList.remove("drop-over"));
}

// Rewrites every Pagemark under `from` so it sits under `to` instead (merges if `to` exists).
async function relocateFolder(from, to) {
  if (from === to) return 0;
  relocating++;
  try { return await relocateFolderNow(from, to); }
  finally { relocating--; syncFolders(); }
}

async function relocateFolderNow(from, to) {
  const affected = pagemarks.filter((b) => b.folder && isInside(b.folder, from));
  // Update the folder list first so the old folder doesn't linger as an empty copy
  if (extraFolders.some((p) => isInside(p, from))) {
    await saveExtraFolders(extraFolders.map((p) => (isInside(p, from) ? to + p.slice(from.length) : p)));
  }
  for (let i = 0; i < affected.length; i += 400) {
    const batch = writeBatch(db);
    for (const b of affected.slice(i, i + 400)) {
      batch.update(doc(pmCol(), b.id), { folder: to + b.folder.slice(from.length), updatedAt: serverTimestamp() });
    }
    await batch.commit();
  }
  // Keep open/closed state and the current view pointing at the new place
  expanded = new Set([...expanded].map((p) => (isInside(p, from) ? to + p.slice(from.length) : p)));
  const parent = parentOf(to);
  if (parent) expanded.add(parent);
  saveExpanded();
  if (view.type === "folder" && isInside(view.value, from)) view = { type: "folder", value: to + view.value.slice(from.length) };
  render();
  return affected.length;
}

async function moveFolder(from, destParent) {
  if (destParent && isInside(destParent, from)) { toast("A folder can't go inside itself."); return; }
  if (parentOf(from) === destParent) return;
  const to = destParent ? destParent + " / " + nameOf(from) : nameOf(from);
  const n = await relocateFolder(from, to);
  toast(`Moved “${nameOf(from)}” ${destParent ? "into “" + nameOf(destParent) + "”" : "to the top level"} (${n} Pagemark${n === 1 ? "" : "s"})`);
}

async function movePagemarksTo(ids, folder) {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    for (const id of ids.slice(i, i + 400)) batch.update(doc(pmCol(), id), { folder, updatedAt: serverTimestamp() });
    await batch.commit();
  }
  for (const id of ids) selected.delete(id);
  const parent = parentOf(folder);
  if (parent) { expanded.add(parent); saveExpanded(); }
  toast(`Moved ${ids.length} Pagemark${ids.length === 1 ? "" : "s"} to “${nameOf(folder)}”`);
}

function makeDropTarget(node, folderPath) {
  node.addEventListener("dragover", (e) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes("application/x-pm-folder") && !types.includes("application/x-pm-ids")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    node.classList.add("drop-over");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-over"));
  node.addEventListener("drop", async (e) => {
    e.preventDefault();
    endDrag();
    const folder = e.dataTransfer.getData("application/x-pm-folder");
    const ids = e.dataTransfer.getData("application/x-pm-ids");
    if (folder) await moveFolder(folder, folderPath);
    else if (ids && folderPath) await movePagemarksTo(JSON.parse(ids), folderPath);
  });
}
makeDropTarget($("#folders-heading"), "");

// Move / rename dialog
const dlgFolder = $("#dlg-folder");
let folderMode = null;

function allFolderPaths() {
  const set = new Set();
  for (const f of [...pagemarks.map((b) => b.folder), ...extraFolders]) {
    if (!f) continue;
    const parts = f.split(" / ");
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join(" / "));
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function openFolderDialog(mode, parentForNew = "") {
  if (mode !== "new" && view.type !== "folder") return;
  folderMode = mode;
  newFolderParent = parentForNew;
  const path = view.value;
  $("#folder-error").hidden = true;
  $("#folder-move-wrap").hidden = mode !== "move";
  $("#folder-rename-wrap").hidden = mode === "move";
  if (mode === "new") {
    $("#folder-heading").textContent = parentForNew ? `New folder inside “${nameOf(parentForNew)}”` : "New folder";
    $("#folder-sub").textContent = parentForNew ? parentForNew : "At the top level";
    $("#folder-newname").value = "";
    $("#folder-newname").placeholder = "e.g. Blockchain";
    $("#folder-ok").textContent = "Create";
    dlgFolder.showModal();
    $("#folder-newname").focus();
    return;
  }
  $("#folder-newname").placeholder = "";
  if (mode === "move") {
    $("#folder-heading").textContent = `Move “${nameOf(path)}”`;
    $("#folder-sub").textContent = "Choose where it should go. Everything inside moves with it.";
    const sel = $("#folder-dest");
    const opts = [el("option", { value: "", text: "Top level (no parent folder)" })];
    for (const p of allFolderPaths()) {
      if (isInside(p, path)) continue;            // not into itself
      const depth = p.split(" / ").length - 1;
      opts.push(el("option", { value: p, text: "\u00a0\u00a0\u00a0\u00a0".repeat(depth) + nameOf(p) }));
    }
    sel.replaceChildren(...opts);
    sel.value = parentOf(path);
    $("#folder-ok").textContent = "Move";
  } else {
    $("#folder-heading").textContent = `Rename “${nameOf(path)}”`;
    $("#folder-sub").textContent = parentOf(path) ? `Inside “${parentOf(path)}”` : "";
    $("#folder-newname").value = nameOf(path);
    $("#folder-ok").textContent = "Rename";
  }
  dlgFolder.showModal();
  (mode === "move" ? $("#folder-dest") : $("#folder-newname")).focus();
}

let newFolderParent = "";
$("#folder-move").addEventListener("click", () => openFolderDialog("move"));
$("#folder-new").addEventListener("click", () => openFolderDialog("new", view.value));
$("#folder-new-top").addEventListener("click", () => openFolderDialog("new", ""));
$("#folder-delete").addEventListener("click", async () => {
  const path = view.value;
  if (!(await ask({ title: `Delete the folder “${nameOf(path)}”?`, text: "It's empty, so nothing else is deleted.", ok: "Delete", danger: true }))) return;
  await saveExtraFolders(extraFolders.filter((p) => !isInside(p, path)));
  setView(parentOf(path) ? { type: "folder", value: parentOf(path) } : { type: "all", value: null });
  toast("Folder deleted");
});
$("#folder-rename").addEventListener("click", () => openFolderDialog("rename"));
$("#folder-cancel").addEventListener("click", () => dlgFolder.close());
$("#folder-dest").addEventListener("dblclick", () => $("#form-folder").requestSubmit());

$("#form-folder").addEventListener("submit", async (e) => {
  e.preventDefault();
  const path = view.value;
  if (folderMode === "new") {
    const name = $("#folder-newname").value.trim();
    const err = $("#folder-error");
    if (!name) { err.textContent = "Please type a name."; err.hidden = false; return; }
    if (name.includes("/")) { err.textContent = "Folder names can't contain “/”."; err.hidden = false; return; }
    const full = newFolderParent ? newFolderParent + " / " + name : name;
    if (allFolderPaths().some((p) => p.toLowerCase() === full.toLowerCase())) { err.textContent = "A folder with that name is already here."; err.hidden = false; return; }
    dlgFolder.close();
    await saveExtraFolders([...extraFolders, full]);
    if (newFolderParent) { expanded.add(newFolderParent); saveExpanded(); }
    setView({ type: "folder", value: full });
    toast(`Created “${name}”. Drag Pagemarks onto it, or use Move to folder…`);
    return;
  }
  if (folderMode === "move") {
    const dest = $("#folder-dest").value;
    dlgFolder.close();
    await moveFolder(path, dest);
  } else {
    const name = $("#folder-newname").value.trim();
    const err = $("#folder-error");
    if (!name) { err.textContent = "Please type a name."; err.hidden = false; return; }
    if (name.includes("/")) { err.textContent = "Folder names can't contain “/”. Use Move folder to put it inside another folder."; err.hidden = false; return; }
    dlgFolder.close();
    const parent = parentOf(path);
    const to = parent ? parent + " / " + name : name;
    const n = await relocateFolder(path, to);
    toast(`Renamed to “${name}” (${n} Pagemark${n === 1 ? "" : "s"})`);
  }
});

// ---------- Bulk actions ----------
function renderBulkBar(shown) {
  $("#bulk-bar").hidden = shown.length === 0;
  const picked = shown.filter((b) => selected.has(b.id)).length;
  const box = $("#bulk-all");
  box.checked = picked > 0 && picked === shown.length;
  box.indeterminate = picked > 0 && picked < shown.length;
  $("#bulk-all-label").textContent = `Select all ${shown.length}`;
  $("#bulk-count").textContent = selected.size ? `${selected.size} selected` : "Tick boxes to move, tag or delete several at once";
  $("#bulk-count").classList.toggle("hint-text", !selected.size);
  $("#bulk-bar").classList.toggle("active", selected.size > 0);
  for (const id of ["bulk-move", "bulk-tag", "bulk-later", "bulk-delete"]) $("#" + id).disabled = selected.size === 0;
  const movedPicked = pagemarks.filter((b) => selected.has(b.id) && linkStatus(b) === "moved" && b.link.finalUrl).length;
  const upd = $("#bulk-update");
  upd.hidden = !(movedPicked > 0 || view.type === "moved");
  upd.disabled = movedPicked === 0;
  upd.textContent = movedPicked ? `Update ${movedPicked} link${movedPicked === 1 ? "" : "s"}` : "Update links";
}

// A redirect to a site's home page or a sign-in page usually means the original page is gone.
function suspiciousMove(oldUrl, newUrl) {
  const o = parseUrl(oldUrl), n = parseUrl(newUrl);
  if (!o || !n) return true;
  const oPath = o.pathname.replace(/\/+$/, ""), nPath = n.pathname.replace(/\/+$/, "");
  if (oPath && !nPath) return true;
  return /(^|[\/._-])(log-?in|sign-?in|signin|auth|sso|account\/login|session|404|not-?found|error)([\/._?-]|$)/i.test(n.pathname + n.search);
}

$("#bulk-update").addEventListener("click", async () => {
  const moved = pagemarks.filter((b) => selected.has(b.id) && linkStatus(b) === "moved" && b.link.finalUrl);
  const safe = moved.filter((b) => !suspiciousMove(b.url, b.link.finalUrl));
  const risky = moved.length - safe.length;
  const msg = `Update ${safe.length} link${safe.length === 1 ? "" : "s"} to their new addresses?` +
    (risky ? `\n\n${risky} will be left alone because they now go to a home page or sign-in page, which usually means the page is gone. Check those by hand.` : "");
  if (!safe.length) {
    await ask({ title: "Nothing to update", text: `All ${risky} selected pages now go to a home page or sign-in page, which usually means the original is gone. Check those by hand.`, ok: "OK", cancel: null });
    return;
  }
  if (!(await ask({ title: `Update ${plural(safe.length, "link")}?`, text: msg.split("\n\n")[1] || "Each one will point to its new address.", ok: "Update" }))) return;
  for (let i = 0; i < safe.length; i += 400) {
    const batch = writeBatch(db);
    for (const b of safe.slice(i, i + 400)) {
      const u = parseUrl(b.link.finalUrl);
      batch.update(doc(pmCol(), b.id), {
        url: u.href, normUrl: normalizeUrl(u.href),
        link: { ...b.link, status: "ok", finalUrl: "", reason: "", fails: 0 },
        updatedAt: serverTimestamp()
      });
    }
    await batch.commit();
  }
  for (const b of safe) selected.delete(b.id);
  toast(`${safe.length} link${safe.length === 1 ? "" : "s"} updated` + (risky ? ` · ${risky} left to check` : ""));
});

$("#bulk-all").addEventListener("change", () => {
  const shown = filtered();
  const allShown = shown.length > 0 && shown.every((b) => selected.has(b.id));
  if (allShown) selected.clear(); else shown.forEach((b) => selected.add(b.id));
  render();
});

async function bulkWrite(fn, doneMsg) {
  const ids = [...selected];
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    for (const id of ids.slice(i, i + 400)) fn(batch, doc(pmCol(), id), pagemarks.find((b) => b.id === id));
    await batch.commit();
  }
  selected.clear();
  toast(doneMsg(ids.length));
}

const dlgBulk = $("#dlg-bulk");
let bulkMode = null;
function openBulk(mode) {
  bulkMode = mode;
  $("#bulk-heading").textContent = mode === "move" ? `Move ${selected.size} to folder` : `Add a tag to ${selected.size}`;
  $("#bulk-label").textContent = mode === "move" ? "Folder (leave empty for Unfiled)" : "Tag";
  $("#bulk-input").value = "";
  $("#bulk-input").setAttribute("list", mode === "move" ? "folder-options" : "");
  dlgBulk.showModal();
  $("#bulk-input").focus();
}
$("#bulk-move").addEventListener("click", () => openBulk("move"));
$("#bulk-tag").addEventListener("click", () => openBulk("tag"));
$("#bulk-cancel").addEventListener("click", () => dlgBulk.close());
$("#form-bulk").addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = $("#bulk-input").value;
  dlgBulk.close();
  if (bulkMode === "move") {
    const folder = cleanFolder(val);
    await bulkWrite((batch, ref) => batch.update(ref, { folder, updatedAt: serverTimestamp() }),
      (n) => `${n} moved to ${folder || "Unfiled"}`);
  } else {
    const newTags = parseTags(val);
    if (!newTags.length) return;
    await bulkWrite((batch, ref, b) => batch.update(ref, { tags: [...new Set([...(b?.tags || []), ...newTags])], updatedAt: serverTimestamp() }),
      (n) => `Tagged ${n}`);
  }
});
$("#bulk-later").addEventListener("click", () =>
  bulkWrite((batch, ref) => batch.update(ref, { readLater: true, updatedAt: serverTimestamp() }), (n) => `${n} marked Read later`));
$("#bulk-delete").addEventListener("click", async () => {
  const n = selected.size;
  if (!(await ask({ title: `Delete ${plural(n, "Pagemark")}?`, text: "This can't be undone.", ok: "Delete", danger: true }))) return;
  await bulkWrite((batch, ref) => batch.delete(ref), (n) => `${n} deleted`);
});

// ---------- Tidy up ----------
const dlgTidy = $("#dlg-tidy");
let tidyQueue = [];
let tidyDone = 0;
let tidyRecent = [];

function nextTidy() {
  const ids = new Set(pagemarks.filter((b) => !b.folder).map((b) => b.id));
  tidyQueue = tidyQueue.filter((id) => ids.has(id));
  if (!tidyQueue.length) {
    $("#tidy-card").replaceChildren(el("p", { class: "tidy-finished", text: "All tidy. Nothing left in Unfiled." }));
    $("#tidy-controls").hidden = true;
    return;
  }
  const b = pagemarks.find((x) => x.id === tidyQueue[0]);
  const host = hostOf(b.url);
  const s = linkStatus(b);
  $("#tidy-progress").textContent = `${tidyDone} tidied · ${tidyQueue.length} to go`;
  $("#tidy-card").replaceChildren(
    el("div", { class: "title-line" }, linkBadge(b),
      el("a", { class: "bm-title", href: parseUrl(b.url)?.href || "#", target: "_blank", rel: "noopener noreferrer", text: b.title || host })),
    el("div", { class: "bm-meta", text: host + " · saved " + fmtDate(dateOf(b)) + (s !== "pending" ? " · " + LINK_LABEL[s] : "") })
  );
  $("#tidy-controls").hidden = false;
  $("#tidy-folder").value = "";
  // Quick picks: recently used, then biggest folders
  const counts = new Map();
  for (const p of pagemarks) if (p.folder) counts.set(p.folder, (counts.get(p.folder) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const picks = [...new Set([...tidyRecent, ...top])].slice(0, 8);
  $("#tidy-picks").replaceChildren(...picks.map((f) => el("button", { type: "button", class: "chip", text: f, onclick: () => fileTidy(f) })));
}

async function fileTidy(folderRaw) {
  const folder = cleanFolder(folderRaw);
  if (!folder) { $("#tidy-folder").focus(); return; }
  const id = tidyQueue.shift();
  tidyRecent = [folder, ...tidyRecent.filter((f) => f !== folder)].slice(0, 4);
  tidyDone++;
  nextTidy();
  await updateDoc(doc(pmCol(), id), { folder, updatedAt: serverTimestamp() });
}

$("#btn-tidy").addEventListener("click", () => {
  tidyQueue = pagemarks.filter((b) => !b.folder).sort((a, b) => dateOf(b) - dateOf(a)).map((b) => b.id);
  tidyDone = 0;
  dlgTidy.showModal();
  nextTidy();
});
$("#tidy-file").addEventListener("click", () => fileTidy($("#tidy-folder").value));
$("#tidy-folder").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fileTidy($("#tidy-folder").value); } });
$("#tidy-skip").addEventListener("click", () => { tidyQueue.push(tidyQueue.shift()); nextTidy(); });
$("#tidy-delete").addEventListener("click", async () => {
  const id = tidyQueue.shift();
  tidyDone++;
  nextTidy();
  await deleteDoc(doc(pmCol(), id));
});
$("#tidy-close").addEventListener("click", () => dlgTidy.close());

// ---------- Add / edit ----------
const dlgEdit = $("#dlg-edit");

function openEdit(b = null) {
  editingId = b ? b.id : null;
  $("#edit-heading").textContent = b ? "Edit Pagemark" : "Add Pagemark";
  $("#f-url").value = b ? b.url : "";
  $("#f-title").value = b ? b.title || "" : "";
  $("#f-desc").value = b ? b.description || "" : "";
  $("#f-folder").value = b ? b.folder || "" : (view.type === "folder" ? view.value : "");
  $("#f-tags").value = b ? (b.tags || []).join(", ") : (view.type === "tag" ? view.value : "");
  $("#f-notes").value = b ? b.notes || "" : "";
  $("#f-later").checked = b ? !!b.readLater : view.type === "later";
  $("#btn-delete").hidden = !b;
  $("#dup-warning").hidden = true;
  dlgEdit.showModal();
  if (!b) $("#f-url").focus();
}

$("#btn-add").addEventListener("click", () => openEdit());
$("#btn-cancel").addEventListener("click", () => dlgEdit.close());

function checkDuplicate() {
  const n = normalizeUrl($("#f-url").value);
  const w = $("#dup-warning");
  const dup = n && pagemarks.find((b) => b.id !== editingId && (b.normUrl || normalizeUrl(b.url)) === n);
  if (!dup) { w.hidden = true; return null; }
  w.replaceChildren(
    `You already saved this on ${fmtDate(dateOf(dup))}` + (dup.folder ? ` in “${dup.folder}”` : "") + ". ",
    el("button", { type: "button", text: "Open the saved one", onclick: () => openEdit(dup) })
  );
  w.hidden = false;
  return dup;
}

let lookupBusy = false;
async function doLookup(force = false) {
  const u = parseUrl($("#f-url").value);
  if (!u || lookupBusy) return;
  if (!force && $("#f-title").value.trim()) return;
  lookupBusy = true;
  const btn = $("#btn-lookup");
  btn.textContent = "Looking…";
  btn.disabled = true;
  const info = await lookupPage(u.href);
  if (info) {
    if (info.title && (force || !$("#f-title").value.trim())) $("#f-title").value = info.title;
    if (info.description && !$("#f-desc").value.trim()) $("#f-desc").value = info.description;
  } else if (force) {
    toast("Couldn't look up that page. Type a title instead.");
  }
  btn.textContent = "Look up";
  btn.disabled = false;
  lookupBusy = false;
}

$("#f-url").addEventListener("input", checkDuplicate);
$("#f-url").addEventListener("change", () => { checkDuplicate(); doLookup(false); });
$("#f-url").addEventListener("paste", () => setTimeout(() => { checkDuplicate(); doLookup(false); }, 0));
$("#btn-lookup").addEventListener("click", () => doLookup(true));

$("#form-edit").addEventListener("submit", async (e) => {
  e.preventDefault();
  const u = parseUrl($("#f-url").value);
  if (!u) { toast("Please enter a valid web address."); $("#f-url").focus(); return; }

  const data = {
    url: u.href,
    normUrl: normalizeUrl(u.href),
    title: $("#f-title").value.trim() || hostOf(u.href),
    description: $("#f-desc").value.trim(),
    folder: cleanFolder($("#f-folder").value),
    tags: parseTags($("#f-tags").value),
    notes: $("#f-notes").value.trim(),
    readLater: $("#f-later").checked,
    updatedAt: serverTimestamp()
  };

  try {
    if (editingId) {
      const before = pagemarks.find((x) => x.id === editingId);
      if (before && normalizeUrl(before.url) !== data.normUrl) data.link = { status: "pending" };
      await updateDoc(doc(pmCol(), editingId), data);
      toast("Saved");
    } else {
      const ref = doc(pmCol());
      await setDoc(ref, { ...data, createdAt: serverTimestamp() });
      toast("Pagemark added");
    }
    dlgEdit.close();
  } catch (err) {
    console.error(err);
    toast("Could not save. Are you online?");
  }
});

$("#btn-delete").addEventListener("click", async () => {
  if (!editingId) return;
  if (!(await ask({ title: "Delete this Pagemark?", text: "This can't be undone.", ok: "Delete", danger: true }))) return;
  await deleteDoc(doc(pmCol(), editingId));
  dlgEdit.close();
  toast("Deleted");
});

// ---------- Settings ----------
const dlgSettings = $("#dlg-settings");
$("#btn-settings").addEventListener("click", () => { $("#import-status").textContent = ""; dlgSettings.showModal(); });
$("#btn-close-settings").addEventListener("click", () => dlgSettings.close());

// Import (Chrome / Edge / Firefox favorites HTML export)
const GENERIC_ROOTS = new Set([
  "bookmarks bar", "bookmarks toolbar", "favorites bar", "other bookmarks",
  "other favorites", "mobile bookmarks", "bookmarks menu", "bookmarks", "favorites"
]);

function parseFavoritesHtml(html) {
  const docu = new DOMParser().parseFromString(html, "text/html");
  const out = [];
  function walk(dl, path) {
    for (const dt of dl.children) {
      if (dt.tagName !== "DT") continue;
      const h3 = dt.querySelector(":scope > h3");
      const a = dt.querySelector(":scope > a");
      if (h3) {
        const sub = dt.querySelector(":scope > dl") || (dt.nextElementSibling && dt.nextElementSibling.tagName === "DL" ? dt.nextElementSibling : null);
        const name = h3.textContent.trim();
        const nextPath = path.length === 0 && GENERIC_ROOTS.has(name.toLowerCase()) ? path : [...path, name];
        if (sub) walk(sub, nextPath);
      } else if (a) {
        out.push({
          url: a.getAttribute("href") || "",
          title: a.textContent.trim(),
          addDate: parseInt(a.getAttribute("add_date") || "0", 10),
          folder: nextFolder(path)
        });
      }
    }
  }
  const nextFolder = (p) => p.join(" / ");
  const root = docu.querySelector("dl");
  if (root) walk(root, []);
  return out;
}

$("#file-import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $("#import-status");
  status.textContent = "Reading file…";
  try {
    const items = parseFavoritesHtml(await file.text());
    const seen = new Set(pagemarks.map((b) => b.normUrl || normalizeUrl(b.url)));
    const toAdd = [];
    let skipped = 0;
    for (const it of items) {
      const u = parseUrl(it.url);
      if (!u) { skipped++; continue; }
      const n = normalizeUrl(u.href);
      if (seen.has(n)) { skipped++; continue; }
      seen.add(n);
      toAdd.push({
        url: u.href,
        normUrl: n,
        title: it.title || hostOf(u.href),
        description: "",
        folder: cleanFolder(it.folder),
        tags: [],
        notes: "",
        readLater: false,
        createdAt: it.addDate > 0 ? Timestamp.fromMillis(it.addDate * 1000) : serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    if (!toAdd.length) {
      status.textContent = `Nothing new to import (${skipped} duplicates or unsupported links skipped).`;
      return;
    }
    for (let i = 0; i < toAdd.length; i += 400) {
      const batch = writeBatch(db);
      for (const d of toAdd.slice(i, i + 400)) batch.set(doc(pmCol()), d);
      await batch.commit();
      status.textContent = `Imported ${Math.min(i + 400, toAdd.length)} of ${toAdd.length}…`;
    }
    status.textContent = `Done: ${toAdd.length} imported, ${skipped} skipped.`;
  } catch (err) {
    console.error(err);
    status.textContent = "Import failed: " + (err.message || err);
  } finally {
    e.target.value = "";
  }
});

// Export
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stamp = () => new Date().toISOString().slice(0, 10);

$("#btn-export-html").addEventListener("click", () => {
  // Build a folder tree
  const tree = { folders: new Map(), items: [] };
  for (const b of pagemarks) {
    let node = tree;
    for (const part of (b.folder ? b.folder.split(" / ") : [])) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), items: [] });
      node = node.folders.get(part);
    }
    node.items.push(b);
  }
  const lines = [];
  const pad = (n) => "    ".repeat(n);
  function emit(node, depth) {
    for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${pad(depth)}<DT><H3>${esc(name)}</H3>`);
      lines.push(`${pad(depth)}<DL><p>`);
      emit(child, depth + 1);
      lines.push(`${pad(depth)}</DL><p>`);
    }
    for (const b of node.items) {
      const add = Math.floor(dateOf(b).getTime() / 1000);
      const tags = (b.tags || []).length ? ` TAGS="${esc(b.tags.join(","))}"` : "";
      lines.push(`${pad(depth)}<DT><A HREF="${esc(b.url)}" ADD_DATE="${add}"${tags}>${esc(b.title || b.url)}</A>`);
      if (b.notes) lines.push(`${pad(depth)}<DD>${esc(b.notes)}`);
    }
  }
  emit(tree, 1);
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Pagemarks</TITLE>
<H1>Pagemarks</H1>
<DL><p>
${lines.join("\n")}
</DL><p>
`;
  download(`pagemarks-${stamp()}.html`, html, "text/html");
});

$("#btn-export-json").addEventListener("click", () => {
  const data = pagemarks.map((b) => ({
    url: b.url, title: b.title, description: b.description || "", folder: b.folder || "",
    tags: b.tags || [], notes: b.notes || "", readLater: !!b.readLater,
    created: dateOf(b).toISOString()
  }));
  download(`pagemarks-${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
});

// Invite list (admin only)
function startInvites() {
  unsubInvites = onSnapshot(collection(db, "allowlist"), (snap) => {
    const ul = $("#invite-list");
    const rows = snap.docs.map((d) => d.id).sort();
    ul.replaceChildren(
      el("li", {}, el("span", { text: user.email + " (you, owner)" })),
      ...rows.map((email) => el("li", {},
        el("span", { text: email }),
        el("button", {
          class: "btn small danger", text: "Remove",
          onclick: async () => {
            if (!(await ask({ title: `Remove ${email}?`, text: "Their saved Pagemarks stay, but they can no longer sign in.", ok: "Remove", danger: true }))) return;
            await deleteDoc(doc(db, "allowlist", email));
          }
        })
      ))
    );
  });
}

$("#form-invite").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#invite-email").value.trim().toLowerCase();
  if (!email) return;
  try {
    await setDoc(doc(db, "allowlist", email), { addedAt: serverTimestamp(), addedBy: user.email });
    $("#invite-email").value = "";
    toast(`${email} invited`);
  } catch (err) {
    console.error(err);
    toast("Could not add. Check the Firestore rules.");
  }
});

// Organize mode wiring
$("#btn-editmode").addEventListener("click", () => setEditing(!editing));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && editing && !document.querySelector("dialog[open]")) setEditing(false);
});
document.body.classList.toggle("editing", editing);
$("#btn-editmode").textContent = editing ? "✓ Done" : "Organize";
$("#btn-editmode").classList.toggle("primary", editing);
