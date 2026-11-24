// Pagemarks v31 — app logic
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc,
  writeBatch, serverTimestamp, Timestamp, getDocsFromServer, query, limit, increment
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { firebaseConfig } from "./config.js";
import { checkPagemark, quickCheck, textAllowed, familyDnsAllows, REFUSAL_MESSAGE } from "./content-rules.js?v=66";

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

// ---------- Quick save (from the browser extension or an iPhone Shortcut) ----------
// https://www.pagemarks.com/#save?u=<address>&t=<title>&src=ext
const QUICK = (() => {
  const h = location.hash || "";
  if (!h.startsWith("#save?")) return null;
  const p = new URLSearchParams(h.slice(6));
  const url = (p.get("u") || "").trim();
  if (!url) return null;
  return { url, title: (p.get("t") || "").trim(), src: p.get("src") || "" };
})();
if (QUICK) document.body.classList.add("quick");
let quickOpened = false, quickSaved = false, quickFinished = false;

function showScreen(name) {
  for (const s of ["loading", "signin", "notinvited", "offline", "app", "saved"]) {
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

// ---------- Content rules ----------
// A refused save records only a COUNT on the account (never the site or text), then explains politely.
function countRefusals(n) {
  if (!user || n < 1) return;
  setDoc(doc(db, "refusals", user.uid), { email: user.email, count: increment(Math.min(n, 1000)) }, { merge: true })
    .catch((e) => console.warn("Refusal count not saved", e));
}
async function refuse(n, title = "This can't be saved") {
  countRefusals(n);
  await ask({ title, text: REFUSAL_MESSAGE, ok: "OK", cancel: null });
}

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
  if (!on && ["ok", "broken", "moved", "unknown"].includes(view.type)) view = { type: "all", value: null };
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
$("#btn-retry-offline").addEventListener("click", () => location.reload());
$("#btn-signout").addEventListener("click", () => { $("#dlg-settings").close(); doSignOut(); });
$("#btn-signout-ni").addEventListener("click", doSignOut);

onAuthStateChanged(auth, async (u) => {
  if (unsubPagemarks) { unsubPagemarks(); unsubPagemarks = null; }
  if (unsubInvites) { unsubInvites(); unsubInvites = null; }
  if (unsubMeta) { unsubMeta(); unsubMeta = null; }
  if (typeof unsubRefusals === "function") { unsubRefusals(); unsubRefusals = null; }
  if (typeof unsubLibrarian === "function") { unsubLibrarian(); unsubLibrarian = null; }
  if (typeof unsubLibraryAll === "function") { unsubLibraryAll(); unsubLibraryAll = null; }
  extraFolders = [];
  user = u;
  pagemarks = [];
  if (!u) { showScreen("signin"); return; }

  showScreen("loading");
  const email = (u.email || "").toLowerCase();
  // Only the owner is allowed to list the invite list, so a successful read means "owner".
  // A "permission denied" answer is a real no. Anything else (a slow or dropped connection
  // right after signing in) is retried, so a hiccup never looks like "not invited".
  // Right after signing in, the database can briefly answer "permission denied" before it has
  // received the new sign-in. So a "no" is only trusted after refreshing the sign-in and asking again.
  try { await u.getIdToken(); } catch (e) {}
  const ask = async (fn) => {
    let denials = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return { ok: true, value: await fn() }; }
      catch (err) {
        if (err && err.code === "permission-denied") {
          denials++;
          if (denials >= 3) return { ok: false, denied: true };
          try { await u.getIdToken(true); } catch (e) {}
        }
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    return { ok: false, denied: false };
  };

  const adminCheck = await ask(() => getDocsFromServer(query(collection(db, "allowlist"), limit(1))));
  isAdmin = adminCheck.ok;

  let invited = isAdmin;
  let unreachable = !adminCheck.ok && !adminCheck.denied;
  if (!invited) {
    const inviteCheck = await ask(async () => (await getDoc(doc(db, "allowlist", email))).exists());
    if (inviteCheck.ok) { invited = inviteCheck.value; unreachable = false; }
    else unreachable = unreachable || !inviteCheck.denied;
  }
  if (!invited && unreachable) {
    $("#offline-email").textContent = u.email;
    showScreen("offline");
    return;
  }
  if (!invited) {
    $("#notinvited-email").textContent = u.email;
    showScreen("notinvited");
    return;
  }

  $("#me-email").textContent = u.email;
  $("#invite-section").hidden = !isAdmin;
  document.querySelectorAll(".owner-only").forEach(el => { el.hidden = !isAdmin; });
  checkPreviewCard();
  showScreen("app");
  startPagemarks();
  startLibrarian();
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
    if (!pmLoaded && pagemarks.some((b) => b.starred) && view.type === "all") view = { type: "home", value: null };
    pmLoaded = true;
    render();
    syncFolders();
    if (QUICK && !quickOpened) { quickOpened = true; openQuick(); }
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

// "Mark as broken" (your own judgement) overrides the nightly checker
const linkStatus = (b) => b.markedBroken ? "broken" : ((b.link && b.link.status) || "pending");

function filtered() {
  let list = pagemarks;
  const searchingAll = $("#search").value.trim() !== "";
  if (view.type === "home" && !searchingAll) list = list.filter((b) => b.starred);
  else if (view.type === "later") list = list.filter((b) => b.readLater);
  else if (view.type === "unfiled") list = list.filter((b) => !b.folder);
  else if (view.type === "folder") {
    // Only this folder's own Pagemarks; sub-folders appear as rows. While searching, include sub-folders too.
    const searching = $("#search").value.trim() !== "";
    list = list.filter((b) => b.folder === view.value || (searching && (b.folder || "").startsWith(view.value + " / ")));
  }
  else if (view.type === "tag") list = list.filter((b) => (b.tags || []).includes(view.value));
  else if (["ok", "broken", "moved", "unknown"].includes(view.type)) list = list.filter((b) => linkStatus(b) === view.type);

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
  // Pinned Pagemarks stay at the top of their folder (sort still applies within each group)
  if (view.type === "folder" || view.type === "unfiled") list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return list;
}

function viewTitle() {
  if (view.type === "home") return $("#search").value.trim() ? "Search results" : "Home";
  if (view.type === "later") return "Read later";
  if (view.type === "unfiled") return "Unfiled";
  if (view.type === "folder") return view.value;
  if (view.type === "tag") return "Tag: " + view.value;
  if (view.type === "ok") return "Working links";
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

  renderLibrarian();

  // Counts
  const count = (fn) => pagemarks.filter(fn).length;
  $("#count-all").textContent = pagemarks.length;
  $("#count-home").textContent = pagemarks.filter((b) => b.starred).length;
  const later = count((b) => b.readLater);
  $("#count-later").textContent = later;
  const unfiled = count((b) => !b.folder);
  $("#count-unfiled").textContent = unfiled;
  // Read later and Unfiled only appear when they hold something (or while you're looking at them)
  $("#count-later").closest("li").hidden = later === 0 && view.type !== "later";
  $("#count-unfiled").closest("li").hidden = unfiled === 0 && view.type !== "unfiled";
  const suggested = count((b) => !b.folder && b.suggestedFolder);
  $("#btn-review").textContent = `Review suggestions (${suggested})`;
  $("#btn-review").hidden = suggested === 0;
  $("#btn-review").classList.toggle("active", view.type === "review");
  $("#btn-tidy").hidden = unfiled === 0;
  for (const s of ["ok", "broken", "moved", "unknown"]) $(`#count-${s}`).textContent = count((b) => linkStatus(b) === s);
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
  // The Librarian's suggestions, reviewed all at once
  $("#review").hidden = view.type !== "review";
  if (view.type === "review") {
    for (const id of ["#home", "#list", "#sort-wrap", "#empty", "#bulk-bar", "#ext-card", "#lib-welcome"]) $(id).hidden = true;
    renderReview();
    return;
  }

  const items = filtered();
  const onHome = view.type === "home" && !$("#search").value.trim();
  $("#home").hidden = !onHome;
  renderExtCard(onHome);
  $("#list").hidden = onHome;
  $("#sort-wrap").hidden = onHome;
  if (onHome) {
    renderHome(items);
    $("#empty").hidden = true;
    $("#bulk-bar").hidden = true;
    return;
  }
  const subRows = (view.type === "folder" && !$("#search").value.trim()) ? subfolderRows(tree, view.value) : [];
  $("#list").replaceChildren(...subRows, ...items.map(renderItem));
  $("#empty").hidden = items.length > 0 || subRows.length > 0;
  if (!items.length && !subRows.length) {
    const inFolder = view.type === "folder";
    $("#empty-title").textContent = inFolder ? "This folder is empty." : "No Pagemarks here yet.";
    $("#empty-hint").textContent = inFolder
      ? (editing ? "Drag Pagemarks onto it in the sidebar, or tick them elsewhere and use Move to folder…" : "Click Organize to move Pagemarks here.")
      : "Click + Add to save a Pagemark, or import your favorites under ⚙ Settings.";
  }
  renderBulkBar(items);
}

// Simple outline folder icon (drawn in the site's green)
function folderIcon() {
  const box = el("span", { class: "sub-icon", "aria-hidden": "true" });
  box.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-7.2l-1.7-2.2A2 2 0 0 0 8.5 4.5H5a2 2 0 0 0-2 2v1z"/></svg>';
  return box;
}

// Rows for the sub-folders of the open folder, shown above its Pagemarks
function subfolderRows(tree, path) {
  let node = tree;
  for (const part of path.split(" / ")) { node = node.children.get(part); if (!node) return []; }
  return [...node.children.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((k) => {
      const row = el("li", { class: "sub-row", role: "button", tabindex: "0", title: "Open " + k.name },
        folderIcon(),
        el("span", { class: "sub-name", text: k.name }),
        el("span", { class: "count", text: k.count === 1 ? "1 Pagemark" : `${k.count} Pagemarks` }),
        el("span", { class: "sub-arrow", "aria-hidden": "true", text: "›" })
      );
      const open = () => { expanded.add(path); saveExpanded(); setView({ type: "folder", value: k.path }); };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
      if (editing) makeDropTarget(row, k.path);
      return row;
    });
}

function linkBadge(b) {
  const s = linkStatus(b);
  if (s === "pending") return el("span", { class: "dot dot-pending", title: "Not checked yet" });
  if (b.markedBroken) return el("span", { class: "dot dot-broken", title: "Broken (marked by you)" });
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
  // The status dot sits in its own column, so a long title wraps beside it instead of below it
  const titleText = el("div", { class: "title-text" }, title);
  if (b.pinned) titleText.prepend(pinIcon());
  if (s === "broken") titleText.append(el("span", { class: "pill pill-broken", text: "Broken" }));
  if (s === "moved") titleText.append(el("span", { class: "pill pill-moved", text: "Moved" }));
  if (b.readLater) titleText.append(el("span", { class: "later-badge", text: "Read later" }));
  const titleLine = el("div", { class: "title-line" }, linkBadge(b), titleText);

  const meta = el("div", { class: "bm-meta" });
  meta.append(host + " · " + fmtDate(dateOf(b)));
  if (b.folder) {
    meta.append(" · ");
    meta.append(el("span", { class: "folder-label", text: b.folder }));
  }

  const body = el("div", { class: "bm-body" }, titleLine, meta);

  const archiveLink = () => (b.link && b.link.archiveUrl)
    ? el("a", { href: b.link.archiveUrl, target: "_blank", rel: "noopener noreferrer", text: "Open the archived copy" })
    : el("a", { href: "https://web.archive.org/web/*/" + b.url, target: "_blank", rel: "noopener noreferrer", text: "Look for an archived copy" });
  if (s === "broken") {
    const fix = el("div", { class: "fix-row" },
      el("span", { text: b.markedBroken ? "You marked this page as broken." : "This page no longer loads." }), " ", archiveLink());
    if (b.markedBroken) fix.append(" ", el("button", { class: "btn small", text: "Not broken", onclick: () => setMarkedBroken(b, false) }));
    body.append(fix);
  }
  if (s === "unknown") {
    const why = b.link && b.link.reason ? ` (${b.link.reason})` : "";
    body.append(el("div", { class: "fix-row" },
      el("span", { text: "The checker couldn't verify this page" + why + ". If it doesn't open for you either:" }), " ",
      archiveLink(), " ",
      el("button", { class: "btn small", text: "Mark as broken", onclick: () => setMarkedBroken(b, true) })));
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
      class: "btn small", title: b.pinned ? "Unpin from the top of its folder" : "Pin to the top of its folder",
      text: b.pinned ? "Unpin" : "Pin",
      onclick: () => updateDoc(doc(pmCol(), b.id), { pinned: !b.pinned, updatedAt: serverTimestamp() })
    }),
    el("button", {
      class: "btn small",
      title: b.readLater ? "Mark as read" : "Read later",
      text: b.readLater ? "✓ Read" : "Later",
      onclick: () => updateDoc(doc(pmCol(), b.id), { readLater: !b.readLater, updatedAt: serverTimestamp() })
    }),
    el("button", { class: "btn small", text: "Edit", onclick: () => openEdit(b) })
  );

  const side = el("div", { class: "bm-side" }, starButton(b), actions);
  const li = el("li", { class: "bm" + (selected.has(b.id) ? " picked" : "") + (b.pinned ? " pinned" : ""), draggable: editing ? "true" : "false" }, box, fav, body, side);
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

async function setMarkedBroken(b, on) {
  await updateDoc(doc(pmCol(), b.id), { markedBroken: on, updatedAt: serverTimestamp() });
  toast(on ? "Marked as broken. It's now listed under Broken." : "No longer marked as broken.");
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

// ---------- Search ----------
// Home and the logo start fresh (search cleared). Folders keep the search, so you can narrow results.
function syncSearchClear() { $("#search-clear").hidden = !$("#search").value; }
function clearSearch() { $("#search").value = ""; syncSearchClear(); }

document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.view === "home") clearSearch();
    setView({ type: btn.dataset.view, value: null });
  });
});
$("#brand-home").addEventListener("click", (e) => {
  e.preventDefault();
  clearSearch();
  setView({ type: pagemarks.some((b) => b.starred) ? "home" : "all", value: null });
});
syncSearchClear();   // in case the browser restored a search after a reload
$("#search").addEventListener("input", () => { syncSearchClear(); selected.clear(); render(); });
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#search").value) {
    e.preventDefault();
    e.stopPropagation();   // Esc here only clears the search (it doesn't also leave Organize)
    clearSearch(); selected.clear(); render();
  }
});
$("#search-clear").addEventListener("click", () => {
  clearSearch(); selected.clear(); render();
  $("#search").focus();
});
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
  $("#folder-rename-wrap").hidden = false;
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
    dlgFolderPickMove(path);
    return;
  } else {
    $("#folder-heading").textContent = `Rename “${nameOf(path)}”`;
    $("#folder-sub").textContent = parentOf(path) ? `Inside “${parentOf(path)}”` : "";
    $("#folder-newname").value = nameOf(path);
    $("#folder-ok").textContent = "Rename";
  }
  dlgFolder.showModal();
  $("#folder-newname").focus();
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

$("#form-folder").addEventListener("submit", async (e) => {
  e.preventDefault();
  const path = view.value;
  if (folderMode === "new") {
    const name = $("#folder-newname").value.trim();
    const err = $("#folder-error");
    if (!name) { err.textContent = "Please type a name."; err.hidden = false; return; }
    if (name.includes("/")) { err.textContent = "Folder names can't contain “/”."; err.hidden = false; return; }
    if (!textAllowed(name)) { err.textContent = "That name isn't allowed under Pagemarks' content rules."; err.hidden = false; countRefusals(1); return; }
    const full = newFolderParent ? newFolderParent + " / " + name : name;
    if (allFolderPaths().some((p) => p.toLowerCase() === full.toLowerCase())) { err.textContent = "A folder with that name is already here."; err.hidden = false; return; }
    dlgFolder.close();
    await saveExtraFolders([...extraFolders, full]);
    if (newFolderParent) { expanded.add(newFolderParent); saveExpanded(); }
    setView({ type: "folder", value: full });
    toast(`Created “${name}”. Drag Pagemarks onto it, or use Move to folder…`);
    return;
  }
  {
    const name = $("#folder-newname").value.trim();
    const err = $("#folder-error");
    if (!name) { err.textContent = "Please type a name."; err.hidden = false; return; }
    if (name.includes("/")) { err.textContent = "Folder names can't contain “/”. Use Move folder to put it inside another folder."; err.hidden = false; return; }
    if (!textAllowed(name)) { err.textContent = "That name isn't allowed under Pagemarks' content rules."; err.hidden = false; countRefusals(1); return; }
    dlgFolder.close();
    const parent = parentOf(path);
    const to = parent ? parent + " / " + name : name;
    const n = await relocateFolder(path, to);
    toast(`Renamed to “${name}” (${n} Pagemark${n === 1 ? "" : "s"})`);
  }
});

// ---------- Folder picker (used for every "choose a folder") ----------
let pickState = null;

function pickFolder({ title, ok = "Move here", current = null, here = null, allowNone = true, noneLabel = "Unfiled", exclude = () => false }) {
  pickState = { selected: current ?? null, here, allowNone, noneLabel, exclude, resolve: null, created: [] };
  $("#pick-title").textContent = title;
  $("#pick-ok").textContent = ok;
  $("#pick-search").value = "";
  $("#pick-error").hidden = true;
  $("#pick-new-row").hidden = true;
  renderPickList();
  const dlg = $("#dlg-pick");
  dlg.showModal();
  $("#pick-search").focus();
  const sel = $("#pick-list .pick-row.selected");
  if (sel) sel.scrollIntoView({ block: "center" });
  return new Promise((resolve) => { pickState.resolve = resolve; });
}

function finishPick(value) {
  const st = pickState;
  if (!st) return;
  pickState = null;
  $("#dlg-pick").close();
  st.resolve(value);
}

function renderPickList() {
  const st = pickState;
  const q = $("#pick-search").value.trim().toLowerCase();
  const paths = [...new Set([...allFolderPaths(), ...st.created])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const rows = [];
  const mk = (value, label, depth, sub) => {
    const row = el("li", { class: "pick-row" + (st.selected === value ? " selected" : ""), role: "option", tabindex: "0", style: `padding-left:${0.8 + depth * 1.25}rem` },
      value === "" ? el("span", { class: "pick-none-icon", "aria-hidden": "true" }) : folderIcon(),
      el("span", { class: "pick-name", text: label }),
      sub ? el("span", { class: "pick-sub", text: sub }) : null,
      st.here !== null && st.here === value ? el("span", { class: "pick-sub", text: "current" }) : null,
      el("span", { class: "pick-check", "aria-hidden": "true", text: st.selected === value ? "✓" : "" })
    );
    row.addEventListener("click", () => { st.selected = value; renderPickList(); });
    row.addEventListener("dblclick", () => finishPick(value));
    row.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finishPick(value); } });
    return row;
  };
  if (st.allowNone && (!q || st.noneLabel.toLowerCase().includes(q))) rows.push(mk("", st.noneLabel, 0));
  for (const p of paths) {
    if (st.exclude(p)) continue;
    if (q) {
      if (!p.toLowerCase().includes(q)) continue;
      rows.push(mk(p, nameOf(p), 0, parentOf(p)));
    } else {
      rows.push(mk(p, nameOf(p), p.split(" / ").length - 1));
    }
  }
  if (!rows.length) rows.push(el("li", { class: "pick-empty muted", text: "No folder matches. Use + New folder to make one." }));
  $("#pick-list").replaceChildren(...rows);
  $("#pick-ok").disabled = st.selected === null;
}

$("#pick-search").addEventListener("input", () => {
  renderPickList();
  // If the search leaves exactly one folder, select it so Enter moves there
  const only = [...document.querySelectorAll("#pick-list .pick-row")];
  if (only.length === 1) only[0].click();
});
$("#pick-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); if (pickState && pickState.selected !== null) finishPick(pickState.selected); }
  if (e.key === "ArrowDown") { e.preventDefault(); document.querySelector("#pick-list .pick-row")?.focus(); }
});
$("#pick-list").addEventListener("keydown", (e) => {
  const rows = [...document.querySelectorAll("#pick-list .pick-row")];
  const i = rows.indexOf(document.activeElement);
  if (e.key === "ArrowDown" && i < rows.length - 1) { e.preventDefault(); rows[i + 1].focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); (i > 0 ? rows[i - 1] : $("#pick-search")).focus(); }
});
$("#form-pick").addEventListener("submit", (e) => { e.preventDefault(); if (pickState && pickState.selected !== null) finishPick(pickState.selected); });
$("#pick-cancel").addEventListener("click", () => finishPick(null));
$("#dlg-pick").addEventListener("cancel", (e) => { e.preventDefault(); finishPick(null); });

// "+ New folder" inside the picker: creates it inside the highlighted folder (or at the top level)
$("#pick-new").addEventListener("click", () => {
  $("#pick-new-row").hidden = false;
  const parent = pickState?.selected || "";
  $("#pick-new-name").placeholder = parent ? `New folder inside “${nameOf(parent)}”` : "New folder at the top level";
  $("#pick-new-name").value = "";
  $("#pick-new-name").focus();
});
$("#pick-new-cancel").addEventListener("click", () => { $("#pick-new-row").hidden = true; $("#pick-error").hidden = true; });
async function createInPicker() {
  const st = pickState;
  const name = $("#pick-new-name").value.trim();
  const err = $("#pick-error");
  if (!name) { err.textContent = "Please type a name."; err.hidden = false; return; }
  if (name.includes("/")) { err.textContent = "Folder names can't contain “/”."; err.hidden = false; return; }
  if (!textAllowed(name)) { err.textContent = "That name isn't allowed under Pagemarks' content rules."; err.hidden = false; countRefusals(1); return; }
  const parent = st.selected || "";
  const full = parent ? parent + " / " + name : name;
  if (allFolderPaths().some((p) => p.toLowerCase() === full.toLowerCase())) { err.textContent = "That folder already exists here."; err.hidden = false; return; }
  err.hidden = true;
  st.created.push(full);
  st.selected = full;
  $("#pick-new-row").hidden = true;
  $("#pick-search").value = "";
  renderPickList();
  document.querySelector("#pick-list .pick-row.selected")?.scrollIntoView({ block: "center" });
  saveExtraFolders([...extraFolders, full]);
  if (parent) { expanded.add(parent); saveExpanded(); }
}
$("#pick-new-ok").addEventListener("click", createInPicker);
$("#pick-new-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); createInPicker(); } });

// Move a whole folder with the picker
async function dlgFolderPickMove(path) {
  const dest = await pickFolder({
    title: `Move “${nameOf(path)}” into…`, ok: "Move here",
    current: parentOf(path), noneLabel: "Top level (no parent folder)",
    exclude: (p) => isInside(p, path)
  });
  if (dest === null) return;
  await moveFolder(path, dest);
}

// Folder field in the Add / Edit dialog
function syncFolderField() {
  const v = $("#f-folder").value;
  $("#f-folder-label").textContent = v ? v : "Unfiled";
  $("#f-folder-btn").classList.toggle("empty", !v);
}
$("#f-folder-btn").addEventListener("click", async () => {
  const f = await pickFolder({ title: "Choose a folder", ok: "Choose", current: $("#f-folder").value });
  if (f === null) return;
  $("#f-folder").value = f;
  syncFolderField();
  setTimeout(refreshEditSuggest, 0);
});

// ---------- Star (Home) and Pin ----------
function starButton(b) {
  return el("button", {
    type: "button", class: "star-btn" + (b.starred ? " on" : ""),
    title: b.starred ? "Remove from Home" : "Add to Home", "aria-label": b.starred ? "Remove from Home" : "Add to Home",
    "aria-pressed": b.starred ? "true" : "false", text: b.starred ? "★" : "☆",
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleStar(b); }
  });
}
async function toggleStar(b) {
  await updateDoc(doc(pmCol(), b.id), { starred: !b.starred, updatedAt: serverTimestamp() });
  toast(b.starred ? "Removed from Home" : "Added to Home");
}
function pinIcon() {
  const s = el("span", { class: "pin-icon", title: "Pinned to the top of this folder", "aria-label": "Pinned" });
  s.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
  return s;
}

// Home: starred Pagemarks as tiles, grouped by their folder
// ---------- Browser button (extension) ----------
// Fill in the Chrome Web Store address once the listing is published; until then the Home card stays hidden.
const EXTENSION_URL = "";
const extInstalled = () => document.documentElement.hasAttribute("data-pagemarks-extension");
// Desktop Chrome, Edge, Brave, Opera and Vivaldi can all install from the Chrome Web Store
const extSupported = () => /Chrome\//.test(navigator.userAgent) && !/Mobile|Android|CriOS/.test(navigator.userAgent);
function extCardDismissed() { try { return localStorage.getItem("pm-ext-card") === "dismissed"; } catch { return false; } }

// Owner-only preview: www.pagemarks.com/#preview-card shows the card even when it would normally be hidden
let previewCard = false;
function checkPreviewCard() {
  if (location.hash !== "#preview-card") return;
  history.replaceState(null, "", location.pathname + location.search);
  if (!isAdmin) return;
  previewCard = true;
  clearSearch();
  setView({ type: "home", value: null });
}
window.addEventListener("hashchange", checkPreviewCard);

function renderExtCard(onHome) {
  const normal = !!EXTENSION_URL && extSupported() && !extInstalled() && !extCardDismissed();
  const show = onHome && (normal || previewCard);
  $("#ext-card").hidden = !show;
  if (show) $("#ext-card-add").href = EXTENSION_URL || "#";
}
$("#ext-card-add").addEventListener("click", (e) => {
  if (!EXTENSION_URL) { e.preventDefault(); toast("Preview: this will open the Chrome Web Store once the button is published"); }
});
$("#ext-card-close").addEventListener("click", () => {
  $("#ext-card").hidden = true;
  if (previewCard) { previewCard = false; return; }   // a preview never hides the real card
  try { localStorage.setItem("pm-ext-card", "dismissed"); } catch { /* ignore */ }
  toast("You'll find the browser button in Settings");
});

function renderExtSettings() {
  const installed = extInstalled();
  $("#ext-installed").hidden = !installed;
  $("#ext-get").hidden = installed || !EXTENSION_URL;
  $("#ext-soon").hidden = installed || !!EXTENSION_URL;
  if (EXTENSION_URL) $("#ext-settings-add").href = EXTENSION_URL;
}

function renderHome(items) {
  const box = $("#home");
  if (!items.length) {
    box.replaceChildren(el("div", { class: "empty" },
      el("p", { text: "Your Home page is empty." }),
      el("p", { class: "muted", text: "Click the ☆ on any Pagemark you visit often, and it will appear here, grouped by folder." })));
    return;
  }
  const groups = new Map();
  for (const b of items) {
    const g = b.folder || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(b);
  }
  const names = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { sensitivity: "base" })));
  box.replaceChildren(...names.map((g) => {
    const list = groups.get(g).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.title || a.url).localeCompare(b.title || b.url, undefined, { sensitivity: "base" }));
    const parts = g ? g.split(" / ") : ["Unfiled"];
    const heading = el("h3", { class: "home-group-title", title: g || "Unfiled" }, folderIcon(),
      el("span", { class: "hg-name" },
        parts.length > 1 ? el("span", { class: "hg-parent", text: parts.slice(0, -1).join(" / ") + " / " }) : null,
        parts[parts.length - 1]));
    if (g) heading.addEventListener("click", () => setView({ type: "folder", value: g }));
    return el("section", { class: "home-group" + (g ? " linked" : "") }, heading,
      el("ul", { class: "home-list" }, ...list.map(homeTile)));
  }));
}

function homeTile(b) {
  const host = hostOf(b.url);
  const href = parseUrl(b.url) ? parseUrl(b.url).href : "#";
  const fav = el("span", { class: "fav tile-fav" });
  if (host) {
    const img = el("img", { alt: "", loading: "lazy", src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` });
    img.addEventListener("error", () => { fav.textContent = host[0].toUpperCase(); });
    fav.append(img);
  }
  return el("li", { class: "home-row" },
    el("a", { class: "home-link", href, target: "_blank", rel: "noopener noreferrer", title: host },
      fav,
      el("span", { class: "home-title", text: b.title || host || b.url })),
    starButton(b));
}

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
$("#bulk-move").addEventListener("click", async () => {
  const n = selected.size;
  const folder = await pickFolder({ title: `Move ${plural(n, "Pagemark")} to…`, ok: "Move here", here: view.type === "folder" ? view.value : null });
  if (folder === null) return;
  await bulkWrite((batch, ref) => batch.update(ref, { folder, updatedAt: serverTimestamp() }),
    (k) => `${plural(k, "Pagemark")} moved to “${folder ? nameOf(folder) : "Unfiled"}”`);
});
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
    if (!textAllowed(newTags)) { await refuse(1, "That tag can't be added"); return; }
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

// ---------- Folder suggestions ----------
// Built-in matching: looks at where you've filed similar pages (same website, shared words).
const STOP = new Set("the and for with from your you this that what how are was were www com org net html http https index page pages home official site guide about into their them they have has our out not all can will just more one two new get use using lesson channels youtube".split(" "));
const words = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
const siteOf = (url) => { const h = hostOf(url); const p = h.split("."); return p.length > 2 ? p.slice(-2).join(".") : h; };

// Everyday words that say nothing about a page's subject ("NY Daily News" is not about "Gen Art News")
const GENERIC = new Set("news daily blog blogs post posts article articles online free best top today times journal magazine media video videos watch shop store info review reviews world story stories".split(" "));
const meaningful = (list) => list.filter((w) => !GENERIC.has(w));

function folderSuggestions(b, max = 2) {
  const scores = new Map();
  const add = (f, n) => scores.set(f, (scores.get(f) || 0) + n);
  const host = hostOf(b.url), site = siteOf(b.url);
  const allMine = new Set(words(b.title + " " + (parseUrl(b.url)?.pathname || "")));
  const mine = new Set(meaningful([...allMine]));
  const filed = pagemarks.filter((p) => p.folder && p.id !== b.id);
  // Same website as Pagemarks already filed
  for (const p of filed) {
    if (hostOf(p.url) === host) add(p.folder, 4);
    else if (siteOf(p.url) === site) add(p.folder, 2);
  }
  // Words shared with a folder's own name (strong). Only the last part counts ("Gen Art News", not "Art"),
  // everyday words don't count, and partial matches need longer words ("garden" ~ "gardening").
  for (const f of allFolderPaths()) {
    const own = f.split(" / ").pop();
    const ownWords = words(own);
    if (ownWords.length === 1 && allMine.has(ownWords[0])) { add(f, 3); continue; }   // a folder simply named "News"
    for (const w of meaningful(ownWords)) {
      if (mine.has(w) || [...mine].some((m) => m.length >= 5 && w.length >= 5 && (m.startsWith(w) || w.startsWith(m)))) add(f, 3);
    }
  }
  // Words shared with titles already in a folder (weaker)
  for (const p of filed) {
    let shared = 0;
    for (const w of new Set(meaningful(words(p.title)))) if (mine.has(w)) shared++;
    if (shared) add(p.folder, Math.min(shared, 3) * 0.75);
  }
  return [...scores.entries()]
    .filter(([, s]) => s >= 2.5)
    .sort((a, b) => b[1] - a[1] || b[0].split(" / ").length - a[0].split(" / ").length)
    .slice(0, max)
    .map(([f]) => f);
}

// All suggestions for one Pagemark: a loaded one first (may be a new folder), then built-in matches
function suggestionsFor(b) {
  const out = [];
  if (b.suggestedFolder) out.push(b.suggestedFolder);
  for (const f of folderSuggestions(b)) if (!out.includes(f)) out.push(f);
  return out.slice(0, 3);
}

function suggestButton(f, onPick) {
  const exists = allFolderPaths().includes(f);
  return el("button", { type: "button", class: "btn suggest-btn" + (exists ? "" : " is-new"), title: exists ? f : "Creates this new folder", onclick: () => onPick(f) },
    folderIcon(), el("span", { class: "sb-name", text: f }), exists ? null : el("span", { class: "sb-new", text: "new" }));
}

// Load a suggestions file: { "suggestions": [ { "url": "...", "folder": "A / B" }, ... ] }
$("#file-suggest").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $("#suggest-status");
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.suggestions || [];
    const byUrl = new Map(pagemarks.filter((b) => !b.folder).map((b) => [b.normUrl || normalizeUrl(b.url), b]));
    const updates = [];
    let missed = 0;
    for (const s of list) {
      const b = byUrl.get(normalizeUrl(s.url || ""));
      const folder = cleanFolder(s.folder || "");
      if (b && folder) updates.push([b.id, folder]); else missed++;
    }
    for (let i = 0; i < updates.length; i += 400) {
      const batch = writeBatch(db);
      for (const [id, folder] of updates.slice(i, i + 400)) batch.update(doc(pmCol(), id), { suggestedFolder: folder, suggestedBy: null });
      await batch.commit();
    }
    status.textContent = `Loaded ${plural(updates.length, "suggestion")}` + (missed ? ` (${missed} didn't match an Unfiled Pagemark)` : "") + ". Open Tidy up to review them.";
  } catch (err) {
    console.error(err);
    status.textContent = "Couldn't read that file: " + (err.message || err);
  } finally {
    e.target.value = "";
  }
});

// Suggestion line in the Add / Edit dialog (only while no folder is chosen)
function refreshEditSuggest() {
  const line = $("#f-suggest");
  if ($("#f-folder").value) { line.hidden = true; return; }
  const u = parseUrl($("#f-url").value);
  if (!u) { line.hidden = true; return; }
  const draft = { id: editingId, url: u.href, title: $("#f-title").value, suggestedFolder: editingId ? pagemarks.find((x) => x.id === editingId)?.suggestedFolder : "" };
  const list = suggestionsFor(draft);
  if (!list.length) { line.hidden = true; return; }
  line.replaceChildren(el("span", { class: "muted", text: "Suggested: " }), ...list.map((f) => suggestButton(f, (pick) => { $("#f-folder").value = pick; syncFolderField(); refreshEditSuggest(); })));
  line.hidden = false;
}
$("#f-url").addEventListener("input", () => setTimeout(refreshEditSuggest, 0));
$("#f-title").addEventListener("input", refreshEditSuggest);

// ---------- Tidy up ----------
const dlgTidy = $("#dlg-tidy");
let tidyQueue = [];
let tidyDone = 0;
let tidySkipped = new Set();   // skipped this time through; when only these are left, Tidy up finishes
let tidyRecent = [];

function nextTidy() {
  const ids = new Set(pagemarks.filter((b) => !b.folder).map((b) => b.id));
  tidyQueue = tidyQueue.filter((id) => ids.has(id));
  if (!tidyQueue.length) {
    $("#tidy-card").replaceChildren(el("p", { class: "tidy-finished", text: "All tidy. Every Pagemark is in a folder." }));
    $("#tidy-controls").hidden = true;
    return;
  }
  if (tidyQueue.every((id) => tidySkipped.has(id))) {
    const n = tidyQueue.length;
    $("#tidy-progress").textContent = `${tidyDone} filed · ${n} skipped`;
    $("#tidy-card").replaceChildren(
      el("p", { class: "tidy-finished", text: "That's everything for now." }),
      el("p", { class: "muted tidy-finished-note", text: `You skipped ${plural(n, "Pagemark")}. ${n === 1 ? "It stays" : "They stay"} in Unfiled for another time.` }),
      el("div", { class: "dlg-actions" },
        el("button", { type: "button", class: "btn", text: "Go through skipped again", onclick: () => { tidySkipped = new Set(); nextTidy(); } }),
        el("span", { class: "spacer" }),
        el("button", { type: "button", class: "btn primary", text: "Done", onclick: () => dlgTidy.close() }))
    );
    $("#tidy-controls").hidden = true;
    return;
  }
  const b = pagemarks.find((x) => x.id === tidyQueue[0]);
  const host = hostOf(b.url);
  const s = linkStatus(b);
  const skippedNow = tidyQueue.filter((id) => tidySkipped.has(id)).length;
  const toGo = tidyQueue.length - skippedNow;
  $("#tidy-progress").textContent = [`${tidyDone} filed`, skippedNow ? `${skippedNow} skipped` : null, `${toGo} to go`].filter(Boolean).join(" · ");
  const libBusy = librarian && (librarian.status === "waiting" || librarian.status === "working");
  $("#tidy-lib-note").hidden = !libBusy;
  $("#tidy-card").replaceChildren(
    el("div", { class: "title-line" }, linkBadge(b),
      el("div", { class: "title-text" }, el("a", { class: "bm-title", href: parseUrl(b.url)?.href || "#", target: "_blank", rel: "noopener noreferrer", text: b.title || host }))),
    el("div", { class: "bm-meta", text: host + " · saved " + fmtDate(dateOf(b)) + (s !== "pending" ? " · " + LINK_LABEL[s] : "") })
  );
  $("#tidy-controls").hidden = false;
  // Suggestions first
  const own = b.suggestedFolder ? [b.suggestedFolder] : [];
  const hints = folderSuggestions(b).filter((f) => !own.includes(f));
  const sugg = [...own, ...hints];
  $("#tidy-suggest").hidden = !own.length;
  $("#tidy-suggest-label").textContent = b.suggestedBy === "librarian" ? "Suggested by the Librarian" : "Suggested";
  $("#tidy-suggest-list").replaceChildren(...own.map((f) => suggestButton(f, fileTidy)));
  $("#tidy-hints").hidden = !hints.length;
  $("#tidy-hints-list").replaceChildren(...hints.map((f) => suggestButton(f, fileTidy)));
  const remainingSuggested = tidyQueue.filter((id) => pagemarks.find((x) => x.id === id)?.suggestedFolder).length;
  const allSuggested = reviewItems().length;
  $("#tidy-review-link").hidden = allSuggested < 2;
  $("#tidy-review-link").textContent = `Review all ${allSuggested} suggestions at once →`;
  // Quick picks: recently used, then biggest folders
  const counts = new Map();
  for (const p of pagemarks) if (p.folder) counts.set(p.folder, (counts.get(p.folder) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const picks = [...new Set([...tidyRecent, ...top])].filter((f) => !sugg.includes(f)).slice(0, 8);
  $("#tidy-picks").replaceChildren(...picks.map((f) => el("button", { type: "button", class: "chip", text: f, onclick: () => fileTidy(f) })));
}

// ---------- Review suggestions (all at once) ----------
let reviewOff = new Set();        // Pagemarks unticked on the review page (stay in Unfiled)
let reviewReturn = { type: "home", value: null };

function openReview() {
  if (view.type !== "review") reviewReturn = view;
  reviewOff = new Set();
  setView({ type: "review", value: null });
}
$("#btn-review").addEventListener("click", openReview);
$("#review-back").addEventListener("click", () => setView(reviewReturn));

const reviewItems = () => pagemarks.filter((b) => !b.folder && b.suggestedFolder);

async function setSuggestion(ids, folderRaw) {
  const folder = cleanFolder(folderRaw);
  if (!folder || !ids.length) return;
  const batch = writeBatch(db);
  for (const id of ids) batch.update(doc(pmCol(), id), { suggestedFolder: folder });
  await batch.commit();
}

function renderReview() {
  const items = reviewItems();
  const known = new Set(allFolderPaths());
  const fromLibrarian = items.length && items.every((b) => b.suggestedBy === "librarian");
  $("#view-title").textContent = fromLibrarian ? "The Librarian's suggestions" : "Suggested folders";
  for (const id of [...reviewOff]) if (!items.some((b) => b.id === id)) reviewOff.delete(id);

  if (!items.length) {
    $("#review-intro").textContent = "Every suggestion has been handled.";
    $("#review-groups").replaceChildren();
    $("#review-bar").hidden = true;
    return;
  }
  $("#review-bar").hidden = false;
  $("#review-intro").textContent =
    `${plural(items.length, "Unfiled Pagemark")}, each with a suggested folder. Untick any you'd rather not file, change a folder if you like, then file them. You can always move them later.`;

  const groups = new Map();
  for (const b of items) {
    if (!groups.has(b.suggestedFolder)) groups.set(b.suggestedFolder, []);
    groups.get(b.suggestedFolder).push(b);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  $("#review-groups").replaceChildren(...ordered.map(([folder, list]) => {
    const parts = folder.split(" / ");
    const name = parts.pop();
    const head = el("div", { class: "rv-head" },
      folderIcon(),
      el("span", { class: "rv-name" },
        parts.length ? el("span", { class: "hg-parent", text: parts.join(" / ") + " / " }) : null, name),
      el("span", { class: "rv-count", text: String(list.length) }),
      known.has(folder) ? null : el("span", { class: "rv-new", text: "new folder" }),
      el("button", {
        type: "button", class: "btn small rv-change", text: "Change folder…",
        onclick: async () => {
          const f = await pickFolder({ title: `Move all ${list.length} to…`, ok: "Choose", allowNone: false, current: known.has(folder) ? folder : null });
          if (f) setSuggestion(list.map((b) => b.id), f);
        }
      }));
    const rows = list.sort((a, b) => (a.title || "").localeCompare(b.title || "")).map((b) => {
      const off = reviewOff.has(b.id);
      const box = el("input", { type: "checkbox", class: "rv-check", "aria-label": `File ${b.title || b.url}` });
      box.checked = !off;
      box.addEventListener("change", () => { box.checked ? reviewOff.delete(b.id) : reviewOff.add(b.id); renderReview(); });
      return el("li", { class: "rv-row" + (off ? " off" : "") },
        el("label", { class: "rv-label" }, box,
          el("span", { class: "rv-title", text: b.title || b.url }),
          el("span", { class: "rv-site", text: hostOf(b.url) })),
        el("button", {
          type: "button", class: "rv-row-change", text: "Change…",
          onclick: async () => {
            const f = await pickFolder({ title: "Suggest a different folder", ok: "Choose", allowNone: false, current: b.suggestedFolder });
            if (f) setSuggestion([b.id], f);
          }
        }));
    });
    return el("section", { class: "rv-group" }, head, el("ul", { class: "rv-list" }, ...rows));
  }));

  const chosen = items.filter((b) => !reviewOff.has(b.id)).length;
  $("#review-count").textContent = chosen === items.length ? `All ${items.length} selected` : `${chosen} of ${items.length} selected`;
  $("#review-file").textContent = chosen ? `File ${plural(chosen, "Pagemark")}` : "Nothing selected";
  $("#review-file").disabled = !chosen;
}

$("#review-all").addEventListener("click", () => { reviewOff = new Set(); renderReview(); });
$("#review-none").addEventListener("click", () => { reviewOff = new Set(reviewItems().map((b) => b.id)); renderReview(); });
$("#review-file").addEventListener("click", async () => {
  const items = reviewItems().filter((b) => !reviewOff.has(b.id));
  if (!items.length) return;
  for (let i = 0; i < items.length; i += 400) {
    const batch = writeBatch(db);
    for (const b of items.slice(i, i + 400)) batch.update(doc(pmCol(), b.id), { folder: b.suggestedFolder, suggestedFolder: null, suggestedBy: null, updatedAt: serverTimestamp() });
    await batch.commit();
  }
  toast(`Filed ${plural(items.length, "Pagemark")}`);
  if (!reviewItems().some((b) => !items.includes(b))) setView(reviewReturn);
});

async function fileTidy(folderRaw) {
  const folder = cleanFolder(folderRaw);
  if (!folder) return;
  const id = tidyQueue.shift();
  tidyRecent = [folder, ...tidyRecent.filter((f) => f !== folder)].slice(0, 4);
  tidyDone++;
  nextTidy();
  await updateDoc(doc(pmCol(), id), { folder, suggestedFolder: null, suggestedBy: null, updatedAt: serverTimestamp() });
}

$("#btn-tidy").addEventListener("click", () => {
  tidyQueue = pagemarks.filter((b) => !b.folder).sort((a, b) => dateOf(b) - dateOf(a)).map((b) => b.id);
  tidyDone = 0;
  tidySkipped = new Set();
  dlgTidy.showModal();
  nextTidy();
});
$("#tidy-file").addEventListener("click", async () => {
  const f = await pickFolder({ title: "File it in…", ok: "File here", allowNone: false });
  if (f) fileTidy(f);
});
$("#tidy-skip").addEventListener("click", () => { const id = tidyQueue.shift(); tidySkipped.add(id); tidyQueue.push(id); nextTidy(); });
$("#tidy-delete").addEventListener("click", async () => {
  const id = tidyQueue.shift();
  tidyDone++;
  nextTidy();
  await deleteDoc(doc(pmCol(), id));
});
$("#tidy-close").addEventListener("click", () => dlgTidy.close());
$("#tidy-review-link").addEventListener("click", () => { dlgTidy.close(); openReview(); });

// ---------- Add / edit ----------
const dlgEdit = $("#dlg-edit");

function openEdit(b = null) {
  editingId = b ? b.id : null;
  $("#edit-heading").textContent = b ? "Edit Pagemark" : "Add Pagemark";
  $("#f-url").value = b ? b.url : "";
  $("#f-title").value = b ? b.title || "" : "";
  $("#f-desc").value = b ? b.description || "" : "";
  $("#f-folder").value = b ? b.folder || "" : (view.type === "folder" ? view.value : "");
  syncFolderField();
  $("#f-tags").value = b ? (b.tags || []).join(", ") : (view.type === "tag" ? view.value : "");
  $("#f-notes").value = b ? b.notes || "" : "";
  $("#f-later").checked = b ? !!b.readLater : view.type === "later";
  $("#btn-delete").hidden = !b;
  $("#dup-warning").hidden = true;
  dlgEdit.showModal();
  if (!b) $("#f-url").focus();
}

$("#btn-add").addEventListener("click", () => openEdit());

function openQuick() {
  history.replaceState(null, "", location.pathname + location.search);
  openEdit();
  $("#edit-heading").textContent = "Save a Pagemark";
  $("#f-url").value = QUICK.url;
  $("#f-title").value = QUICK.title;
  checkDuplicate();
  refreshEditSuggest();
  if (!QUICK.title) doLookup(false);
  // Start at the top so the heading and address are the first thing you see; Enter still saves.
  $("#btn-save").focus({ preventScroll: true });
  dlgEdit.scrollTop = 0;
  requestAnimationFrame(() => { dlgEdit.scrollTop = 0; });
}

// Leaving quick-save: close the little window if we can, otherwise say so calmly.
function quickFinish(saved) {
  if (quickFinished) return;
  quickFinished = true;
  if (QUICK.src === "ext") location.hash = "pm-done";   // the extension closes its window on this
  try { window.close(); } catch { /* ignore */ }
  setTimeout(() => {
    $("#saved-title").textContent = saved ? "Saved to Pagemarks" : "Nothing was saved";
    $("#saved-mark").hidden = !saved;
    document.body.classList.remove("quick");
    showScreen("saved");
  }, 350);
}

dlgEdit.addEventListener("close", () => { if (QUICK && quickOpened) quickFinish(quickSaved); });
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

  // Content rules: checked at the moment of saving
  const saveBtn = $("#btn-save");
  saveBtn.disabled = true; saveBtn.textContent = "Checking…";
  const verdict = await checkPagemark(data);
  saveBtn.disabled = false; saveBtn.textContent = "Save";
  if (!verdict.ok) { await refuse(1); return; }

  try {
    if (editingId) {
      const before = pagemarks.find((x) => x.id === editingId);
      if (before && normalizeUrl(before.url) !== data.normUrl) { data.link = { status: "pending" }; data.markedBroken = false; }
      await updateDoc(doc(pmCol(), editingId), data);
      toast("Saved");
    } else {
      const ref = doc(pmCol());
      await setDoc(ref, { ...data, createdAt: serverTimestamp() });
      toast("Pagemark added");
    }
    quickSaved = true;
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
$("#btn-settings").addEventListener("click", () => { $("#import-status").textContent = ""; renderExtSettings(); dlgSettings.showModal(); });
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
        const dd = dt.nextElementSibling && dt.nextElementSibling.tagName === "DD" ? dt.nextElementSibling : dt.querySelector(":scope > dd");
        const tags = (a.getAttribute("tags") || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
        const inHome = path[0] === HOME_EXPORT_FOLDER;
        out.push({
          url: a.getAttribute("href") || "",
          title: a.textContent.trim(),
          addDate: parseInt(a.getAttribute("add_date") || "0", 10),
          folder: inHome ? "" : nextFolder(path),
          tags: tags.filter((t) => t !== "read-later"),
          readLater: tags.includes("read-later"),
          notes: dd ? dd.textContent.trim() : "",
          homeOnly: inHome
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
    const starUrls = new Set();              // from a "★ Home" folder in a Pagemarks export
    let skipped = 0;
    for (const it of items) {
      const u = parseUrl(it.url);
      if (!u) { skipped++; continue; }
      const n = normalizeUrl(u.href);
      if (it.homeOnly) starUrls.add(n);
      if (seen.has(n)) { if (!it.homeOnly) skipped++; continue; }
      seen.add(n);
      toAdd.push({
        url: u.href,
        normUrl: n,
        title: it.title || hostOf(u.href),
        description: "",
        folder: cleanFolder(it.folder),
        tags: it.tags || [],
        notes: it.notes || "",
        readLater: !!it.readLater,
        createdAt: it.addDate > 0 ? Timestamp.fromMillis(it.addDate * 1000) : serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    for (const d of toAdd) if (starUrls.has(d.normUrl)) d.starred = true;
    // Content rules: quick checks first, then the family-safe lookup once per site
    let refused = 0;
    let checked = toAdd.filter((d) => quickCheck(d).ok);
    refused += toAdd.length - checked.length;
    const hosts = [...new Set(checked.map((d) => hostOf(d.url)))];
    const allowedHost = new Map();
    let done = 0;
    const work = async () => {
      while (hosts.length) {
        const h = hosts.pop();
        allowedHost.set(h, await familyDnsAllows(h));
        status.textContent = `Checking sites against the content rules… ${++done}`;
      }
    };
    await Promise.all(Array.from({ length: 8 }, work));
    const passed = checked.filter((d) => allowedHost.get(hostOf(d.url)) !== false);
    refused += checked.length - passed.length;
    toAdd.length = 0; toAdd.push(...passed);
    if (refused) countRefusals(refused);
    const toStar = pagemarks.filter((b) => !b.starred && starUrls.has(b.normUrl || normalizeUrl(b.url)));
    if (!toAdd.length && !toStar.length) {
      status.textContent = `Nothing new to import (${skipped} duplicates or unsupported links skipped` + (refused ? `, ${refused} not allowed under the content rules).` : ").");
      return;
    }
    for (let i = 0; i < toAdd.length; i += 400) {
      const batch = writeBatch(db);
      for (const d of toAdd.slice(i, i + 400)) batch.set(doc(pmCol()), d);
      await batch.commit();
      status.textContent = `Imported ${Math.min(i + 400, toAdd.length)} of ${toAdd.length}…`;
    }
    for (let i = 0; i < toStar.length; i += 400) {
      const batch = writeBatch(db);
      for (const b of toStar.slice(i, i + 400)) batch.update(doc(pmCol(), b.id), { starred: true });
      await batch.commit();
    }
    status.textContent = `Done: ${toAdd.length} imported, ${skipped} skipped` + (refused ? `, ${refused} not allowed under the content rules.` : ".");
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

// HTML export: the standard bookmark-file format every browser can import.
// Folders (including empty ones) and order come along everywhere; Firefox also keeps tags and notes.
const HOME_EXPORT_FOLDER = "★ Home";
$("#btn-export-html").addEventListener("click", () => {
  const tree = { folders: new Map(), items: [] };
  const nodeFor = (path) => {
    let node = tree;
    for (const part of (path ? path.split(" / ") : [])) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), items: [] });
      node = node.folders.get(part);
    }
    return node;
  };
  for (const f of allFolderPaths()) nodeFor(f);           // keeps empty folders too
  for (const b of pagemarks) nodeFor(b.folder).items.push(b);

  const byName = (a, b) => (a.title || a.url).localeCompare(b.title || b.url, undefined, { sensitivity: "base" });
  const lines = [];
  const pad = (n) => "    ".repeat(n);
  const secs = (d) => Math.floor(d.getTime() / 1000);
  const link = (b, depth) => {
    const tags = [...(b.tags || [])];
    if (b.readLater) tags.push("read-later");
    const tagAttr = tags.length ? ` TAGS="${esc(tags.join(","))}"` : "";
    const mod = b.updatedAt && b.updatedAt.toDate ? ` LAST_MODIFIED="${secs(b.updatedAt.toDate())}"` : "";
    lines.push(`${pad(depth)}<DT><A HREF="${esc(b.url)}" ADD_DATE="${secs(dateOf(b))}"${mod}${tagAttr}>${esc(b.title || b.url)}</A>`);
    const note = [b.description, b.notes].filter(Boolean).join("\n\n");
    if (note) lines.push(`${pad(depth)}<DD>${esc(note)}`);
  };
  const folderOpen = (name, depth) => { lines.push(`${pad(depth)}<DT><H3>${esc(name)}</H3>`); lines.push(`${pad(depth)}<DL><p>`); };
  const folderClose = (depth) => lines.push(`${pad(depth)}</DL><p>`);
  function emit(node, depth) {
    for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
      folderOpen(name, depth); emit(child, depth + 1); folderClose(depth);
    }
    // Pinned first, then A–Z, so the browser shows them in the same order
    for (const b of [...node.items].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || byName(a, b))) link(b, depth);
  }
  emit(tree, 1);
  // Starred Pagemarks also go in a "★ Home" folder at the end, so daily sites land together in the browser
  const starred = pagemarks.filter((b) => b.starred).sort(byName);
  if (starred.length) { folderOpen(HOME_EXPORT_FOLDER, 1); for (const b of starred) link(b, 2); folderClose(1); }

  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- Exported from Pagemarks. Import this file into any web browser's bookmarks or favorites. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
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
    starred: !!b.starred, pinned: !!b.pinned,
    created: dateOf(b).toISOString()
  }));
  download(`pagemarks-${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
});

// ---------- The Librarian ----------
// Suggests a folder for each Pagemark that has none. The work happens on GitHub (librarian.yml);
// here a person asks, and sees how it's going. The owner gives each person a number of visits.
const LIBRARIAN_MAX = 2000;
let librarian = null;          // this person's librarian/{email} document
let unsubLibrarian = null;
let libraryAll = new Map();    // owner only: email -> librarian document
let unsubLibraryAll = null;

function startLibrarian() {
  if (unsubLibrarian) unsubLibrarian();
  const email = (user.email || "").toLowerCase();
  let before = null;
  unsubLibrarian = onSnapshot(doc(db, "librarian", email),
    (s) => {
      librarian = s.exists() ? s.data() : null;
      const now = librarian ? librarian.status : null;
      if ((before === "waiting" || before === "working") && now === "done") toast("The Librarian's suggestions are ready. Open Organize, then Review suggestions.");
      if (dlgTidy.open && before !== now) nextTidy();
      before = now;
      renderLibrarian();
    },
    () => { librarian = null; renderLibrarian(); });
}

const unsuggestedCount = () => pagemarks.filter((b) => !b.folder && !b.suggestedFolder).length;

function librarianState() {
  if (!librarian) return null;
  const left = librarian.left || 0;
  const status = librarian.status || "idle";
  const busy = status === "waiting" || status === "working";
  const used = librarian.made !== undefined || status !== "idle";
  const lines = [];
  if (busy) {
    lines.push("The Librarian is looking through your Pagemarks. Suggestions will be waiting in Tidy up in about 15 minutes. You can keep using Pagemarks or close it.");
  } else if (status === "done") {
    const made = librarian.made || 0;
    lines.push(made
      ? `The Librarian made suggestions for ${plural(made, "Pagemark")}. They're waiting in Tidy up.`
      : "The Librarian didn't find any Pagemarks that needed a folder.");
    const more = unsuggestedCount();
    if (more) lines.push(`${plural(more, "Unfiled Pagemark")} ${more === 1 ? "has" : "have"} no suggestion yet.`);
  } else if (status === "error") {
    lines.push("The Librarian couldn't finish this time, so that visit wasn't used. Please try again later.");
  }
  if (!busy) {
    if (left > 0) lines.push(`You have ${plural(left, "Librarian visit")} left.`);
    else lines.push("You've used all your Librarian visits.");
  }
  const canAsk = !busy && left > 0 && unsuggestedCount() > 0;
  const again = status === "done" && (librarian.made || 0) > 0;
  return { lines, canAsk, label: again ? "Ask the Librarian again" : "Ask the Librarian" };
}

const librarianReady = () => pagemarks.filter((b) => !b.folder && b.suggestedFolder && b.suggestedBy === "librarian").length;

// Organize mode only: its own button under Tidy up (the sidebar is otherwise just places)
function renderSideLibrarian(st) {
  const btn = $("#btn-side-librarian");
  const busy = librarian && (librarian.status === "waiting" || librarian.status === "working");
  if (busy) { btn.textContent = "The Librarian is working…"; btn.disabled = true; btn.hidden = false; return; }
  btn.disabled = false;
  if (st && st.canAsk) { btn.textContent = "Ask the Librarian"; btn.hidden = false; return; }
  btn.hidden = true;
}

// A one-time welcome on Home after the owner gives someone Librarian visits
const libWelcomeKey = () => "pm-lib-welcome-" + (user?.uid || "");
function libWelcomeDismissed() { try { return localStorage.getItem(libWelcomeKey()) === "done"; } catch { return false; } }
function renderLibWelcome(st) {
  const onHome = view.type === "home";
  const fresh = librarian && (librarian.left || 0) > 0 && librarian.made === undefined && !(librarian.status && librarian.status !== "idle");
  const show = !!(onHome && fresh && !libWelcomeDismissed());
  $("#lib-welcome").hidden = !show;
  if (!show) return;
  const left = librarian.left || 0;
  $("#lib-welcome-text").textContent =
    `You've been given ${plural(left, "Librarian visit")}. The Librarian is Pagemarks' AI helper: it can suggest a folder for each Unfiled Pagemark, and you decide what to keep in Tidy up.`;
  $("#lib-welcome-ask").hidden = !(st && st.canAsk);
  $("#lib-welcome-later").textContent = st && st.canAsk ? "Not now" : "Got it";
}
function dismissLibWelcome() {
  try { localStorage.setItem(libWelcomeKey(), "done"); } catch { /* ignore */ }
  $("#lib-welcome").hidden = true;
}
$("#lib-welcome-ask").addEventListener("click", () => { dismissLibWelcome(); askLibrarian(); });
$("#lib-welcome-later").addEventListener("click", () => { dismissLibWelcome(); toast("You'll find the Librarian in Organize and in Settings"); });

function renderLibrarian() {
  const st = librarianState();
  renderSideLibrarian(st);
  renderLibWelcome(st);
  $("#librarian-section").hidden = !st;
  if (!st) return;
  $("#lib-status").replaceChildren(...st.lines.map((t) => el("span", { class: "lib-line", text: t })));
  $("#btn-ask-librarian").hidden = !st.canAsk;
  $("#btn-ask-librarian").textContent = st.label;
}

async function askLibrarian() {
  const n = unsuggestedCount();
  if (!librarian || !(librarian.left > 0) || !n) return;
  const take = Math.min(n, LIBRARIAN_MAX);
  const ok = await ask({
    title: librarian.left === 1 ? "Use your last Librarian visit?" : "Use a Librarian visit?",
    text: (n > LIBRARIAN_MAX
        ? `The Librarian will look at the first ${LIBRARIAN_MAX.toLocaleString()} of your ${n.toLocaleString()} Unfiled Pagemarks and suggest a folder for each. The rest can be done next time. `
        : n === 1
          ? "The Librarian will look at your Unfiled Pagemark and suggest a folder for it. "
          : `The Librarian will look at the ${n} Unfiled Pagemarks and suggest a folder for each. `) +
      (librarian.left === 1 ? "This uses your last Librarian visit.\n\n" : `This uses 1 of your ${librarian.left} Librarian visits.\n\n`) +
      (n === 1 ? "Its title and web address are" : "Their titles and web addresses are") +
      " sent to an AI service, which doesn't use them to train its AI. Suggestions will be waiting in Tidy up in about 15 minutes, and nothing is filed until you accept it.",
    ok: "Ask the Librarian"
  });
  if (!ok) return;
  try {
    await updateDoc(doc(db, "librarian", (user.email || "").toLowerCase()), {
      left: librarian.left - 1, status: "waiting", uid: user.uid, requestedAt: serverTimestamp()
    });
    await ask({
      title: "The Librarian is on it",
      text: (take === 1 ? "The Librarian is looking at your Unfiled Pagemark." : `The Librarian is looking through your ${take} Unfiled Pagemarks.`) +
        " In about 15 minutes, the suggestions will be waiting in Tidy up (in Organize).\n\n" +
        "You can keep using Pagemarks or close it while the Librarian works. Nothing is filed until you accept it.",
      ok: "OK",
      cancel: null
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't reach the Librarian. Please try again.");
  }
}
$("#btn-ask-librarian").addEventListener("click", askLibrarian);
$("#btn-side-librarian").addEventListener("click", askLibrarian);

// Owner: everyone's visits, shown in the Invite list
function startLibraryAll() {
  if (unsubLibraryAll) unsubLibraryAll();
  unsubLibraryAll = onSnapshot(collection(db, "librarian"), (snap) => {
    libraryAll = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderInvites();
  }, () => { libraryAll = new Map(); });
}
function librarianNote(email) {
  const d = libraryAll.get((email || "").toLowerCase());
  if (!d) return null;
  const busy = d.status === "waiting" || d.status === "working";
  return el("span", { class: "refusal-note", text: busy ? " · Librarian: working" : ` · Librarian: ${plural(d.left || 0, "visit")} left` });
}
function giveAsksButton(email) {
  return el("button", {
    class: "btn small", text: "Give 3 Librarian visits",
    onclick: async () => {
      try {
        await setDoc(doc(db, "librarian", email.toLowerCase()), { left: increment(3) }, { merge: true });
        toast(`Gave ${email} 3 Librarian visits`);
      } catch (err) { console.error(err); toast("Could not give visits. Check the Firestore rules."); }
    }
  });
}

// Invite list (admin only)
let inviteEmails = [];
let refusalCounts = new Map();
let unsubRefusals = null;
function startInvites() {
  startLibraryAll();
  unsubInvites = onSnapshot(collection(db, "allowlist"), (snap) => {
    inviteEmails = snap.docs.map((d) => d.id).sort();
    renderInvites();
  });
  // Owner only: how many saves each account has had refused (counts only, never the content)
  if (unsubRefusals) unsubRefusals();
  unsubRefusals = onSnapshot(collection(db, "refusals"), (snap) => {
    refusalCounts = new Map(snap.docs.map((d) => [(d.data().email || "").toLowerCase(), d.data().count || 0]));
    renderInvites();
  }, () => { refusalCounts = new Map(); });
}
function refusalNote(email) {
  const n = refusalCounts.get((email || "").toLowerCase()) || 0;
  return n ? el("span", { class: "refusal-note", text: ` · ${plural(n, "refused save")}` }) : null;
}
function renderInvites() {
  const ul = $("#invite-list");
  ul.replaceChildren(
    el("li", {}, el("span", {}, user.email + " (you, owner)", refusalNote(user.email), librarianNote(user.email)),
      el("span", { class: "invite-actions" }, giveAsksButton(user.email))),
    ...inviteEmails.map((email) => el("li", {},
      el("span", {}, email, refusalNote(email), librarianNote(email)),
      el("span", { class: "invite-actions" },
        giveAsksButton(email),
        el("button", {
          class: "btn small danger", text: "Remove",
          onclick: async () => {
            if (!(await ask({ title: `Remove ${email}?`, text: "Their saved Pagemarks stay, but they can no longer sign in.", ok: "Remove", danger: true }))) return;
            await deleteDoc(doc(db, "allowlist", email));
            deleteDoc(doc(db, "librarian", email)).catch(() => {});
          }
        }))
    ))
  );
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

// ---------- Click outside to close ----------
// Only for windows you read (Settings, Tidy up), never ones you type into or that ask a question.
// Both the press and the release must land outside the box, so selecting text and letting go outside doesn't close it.
function closeOnOutsideClick(dlg) {
  const outside = (e) => {
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dlg.addEventListener("pointerdown", (e) => { pressedOutside = e.target === dlg && outside(e); });
  dlg.addEventListener("click", (e) => {
    if (pressedOutside && e.target === dlg && outside(e)) dlg.close();
    pressedOutside = false;
  });
}
closeOnOutsideClick($("#dlg-settings"));
closeOnOutsideClick($("#dlg-tidy"));

// ---------- Version check ----------
// Each release bumps APP_VERSION here, version.json, and the ?v= numbers in index.html.
const APP_VERSION = "66";
$("#app-version").textContent = APP_VERSION;
async function checkForUpdate() {
  try {
    const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const { version } = await r.json();
    if (version && String(version) !== APP_VERSION) $("#update-bar").hidden = false;
  } catch { /* offline: ignore */ }
}
$("#btn-reload").addEventListener("click", () => location.reload());
checkForUpdate();
setInterval(checkForUpdate, 15 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
