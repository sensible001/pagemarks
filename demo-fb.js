// Pagemarks "Try it" demo: a stand-in for Firebase that keeps everything inside this browser tab.
// index.html swaps this in for the real Firebase when the address ends in ?demo, so the demo runs
// the very same app and content checks, but nothing is sent to Pagemarks' database and it costs nothing.
// Each tab is its own private sandbox: closing the tab erases it (sessionStorage), and visitors
// never see each other's changes. "Leave the demo" erases it straight away.

const KEY = "pagemarks-demo";
const GUEST = "Guest (demo)";

// ---------- Time stamps that survive being stored as text ----------
class Ts {
  constructor(ms) { this.ms = ms; this.seconds = Math.floor(ms / 1000); }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
  toJSON() { return { __ts: this.ms }; }
}
const revive = (v) => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    if (typeof v.__ts === "number") return new Ts(v.__ts);
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = revive(x);
    return o;
  }
  return v;
};
export class Timestamp {
  static now() { return new Ts(Date.now()); }
  static fromDate(d) { return new Ts(d.getTime()); }
  static fromMillis(m) { return new Ts(m); }
}
const daysAgo = (n) => new Ts(Date.now() - n * 864e5);

// ---------- The sample library a visitor starts with ----------
function sample() {
  const S = {};
  const ok = (d) => ({ status: "ok", checkedAt: daysAgo(0), ...d });
  const pm = (id, d, age) => { S["users/demo/pagemarks/" + id] = { createdAt: daysAgo(age), updatedAt: daysAgo(age), tags: [], notes: "", ...d }; };
  pm("d01", { url: "https://en.wikipedia.org/wiki/Main_Page", title: "Wikipedia, the free encyclopedia", folder: "Reading & Learning", starred: true, link: ok() }, 400);
  pm("d02", { url: "https://apod.nasa.gov/apod/astropix.html", title: "Astronomy Picture of the Day", folder: "Reading & Learning", starred: true, link: ok(), notes: "A new photo of space every day." }, 220);
  pm("d03", { url: "https://www.gutenberg.org/", title: "Project Gutenberg: free eBooks", folder: "Reading & Learning", link: ok(), tags: ["books"] }, 160);
  pm("d04", { url: "https://www.khanacademy.org/", title: "Khan Academy", folder: "Reading & Learning", link: ok(), readLater: true }, 30);
  pm("d05", { url: "https://www.nps.gov/findapark/index.htm", title: "Find a Park (U.S. National Park Service)", folder: "Travel", starred: true, pinned: true, link: ok() }, 300);
  pm("d06", { url: "https://www.smithsonianmag.com/travel/", title: "Travel | Smithsonian Magazine", folder: "Travel", link: ok(), readLater: true }, 12);
  pm("d07", { url: "https://www.almanac.com/gardening/planting-calendar", title: "Planting Calendar | The Old Farmer's Almanac", folder: "Garden", link: ok(), tags: ["spring"] }, 90);
  pm("d08", { url: "https://www.audubon.org/native-plants", title: "Native Plants Database | Audubon", folder: "Garden", link: ok() }, 75);
  pm("d09", { url: "https://www.justinguitar.com/", title: "JustinGuitar: free guitar lessons", folder: "Music / Guitar", starred: true, link: ok() }, 500);
  // Examples of what the nightly checks find (made-up websites, so no real site is called broken)
  pm("d10", { url: "https://grandmas-kitchen.example/apple-pie", title: "Grandma's Apple Pie", folder: "Recipes",
    link: { status: "broken", code: 404, reason: "HTTP 404", fails: 2, checkedAt: daysAgo(0), archiveUrl: "https://web.archive.org/web/2019/https://www.allrecipes.com/recipe/12682/apple-pie-by-grandma-ople/" } }, 1400);
  pm("d11", { url: "https://old-chords.example/lesson-12", title: "Fingerpicking lesson 12", folder: "Music / Guitar",
    link: { status: "moved", code: 301, finalUrl: "https://new-chords.example/lessons/fingerpicking-12", checkedAt: daysAgo(0) } }, 800);
  pm("d12", { url: "https://busy-news.example/local", title: "Local news", folder: "Reading & Learning",
    link: { status: "unknown", reason: "site blocks automated checks", checkedAt: daysAgo(0) } }, 60);
  pm("d13", { url: "https://watercolor-tips.example/", title: "Watercolor tips for beginners", folder: "Art",
    link: { status: "ok", checkedAt: daysAgo(0), risk: { kind: "newOwner", since: Date.parse("2024-03-02T00:00:00Z") } } }, 2200);
  pm("d14", { url: "https://birding-journal.example/", title: "Backyard Birding Journal", folder: "Garden",
    link: { status: "ok", checkedAt: daysAgo(0), drift: { kind: "changed", title: "Best Casino Bonuses 2026" } } }, 1700);
  // Unfiled, waiting for Tidy up: two with the Librarian's suggestions, one without
  pm("d15", { url: "https://www.allrecipes.com/recipes/17562/dinner/", title: "Dinner Recipes | Allrecipes", folder: "", suggestedFolder: "Recipes", suggestedBy: "librarian", link: ok() }, 3);
  pm("d16", { url: "https://www.nwf.org/Garden-for-Wildlife", title: "Garden for Wildlife | National Wildlife Federation", folder: "", suggestedFolder: "Garden", suggestedBy: "librarian", link: ok() }, 2);
  pm("d17", { url: "https://www.loc.gov/", title: "Library of Congress", folder: "", link: ok() }, 1);
  S["allowlist/" + GUEST.toLowerCase()] = { addedAt: daysAgo(0) };
  S["librarian/" + GUEST.toLowerCase()] = { left: 0, status: "done", made: 2 };
  return S;
}

// ---------- The in-tab "database" ----------
let store;
try { store = revive(JSON.parse(sessionStorage.getItem(KEY) || "null")) || sample(); } catch { store = sample(); }
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(store)); } catch { /* full: keep going in memory */ } };
save();

const listeners = new Set();
const join = (parts) => parts.flatMap((a) => (a && a.path) ? [a.path] : (typeof a === "string" ? [a] : [])).join("/");
const newId = () => "x" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const copy = (v) => revive(JSON.parse(JSON.stringify(v)));

export const initializeApp = () => ({});
export const initializeFirestore = () => ({});
export const persistentLocalCache = () => ({});
export const persistentMultipleTabManager = () => ({});
export const collection = (_db, ...rest) => ({ kind: "col", path: join(rest) });
export const doc = (base, ...rest) => {
  // doc(collection) with no id makes a new, unique id, like Firebase
  const path = base && base.kind === "col" && rest.length === 0 ? base.path + "/" + newId() : join([base, ...rest]);
  return { kind: "doc", path, get id() { return this.path.split("/").pop(); } };
};
export const query = (c) => c;
export const limit = () => null;
export const serverTimestamp = () => new Ts(Date.now());
export const increment = (n) => ({ __inc: n });

// Users are the guest; the Pagemarks owner's invite list is off limits, as in the real app
const DENIED = () => Object.assign(new Error("Not allowed in the demo"), { code: "permission-denied" });
const mine = (path) => path.startsWith("users/demo") || path.startsWith("librarian/") || path.startsWith("allowlist/" + GUEST.toLowerCase());
const realPath = (path) => path.replace(/^users\/[^/]+/, "users/demo");

function snap(ref) {
  const path = realPath(ref.path);
  if (ref.kind === "doc") {
    const d = store[path];
    return { exists: () => !!d, data: () => (d ? copy(d) : undefined), id: path.split("/").pop(), ref };
  }
  const depth = path.split("/").length + 1;
  const docs = Object.keys(store).filter((k) => k.startsWith(path + "/") && k.split("/").length === depth)
    .map((k) => ({ id: k.split("/").pop(), data: () => copy(store[k]), ref: { kind: "doc", path: k } }));
  return { docs, size: docs.length, empty: docs.length === 0, forEach: (f) => docs.forEach(f) };
}
const notify = () => { save(); for (const l of listeners) { try { l.cb(snap(l.ref)); } catch (e) { console.error(e); } } };

export const onSnapshot = (ref, cb, onError) => {
  if (ref.path === "allowlist" || (!mine(realPath(ref.path)) && ref.path !== "users")) {
    setTimeout(() => onError && onError(DENIED()), 0);
    return () => {};
  }
  const l = { ref, cb };
  listeners.add(l);
  setTimeout(() => cb(snap(ref)), 0);
  return () => listeners.delete(l);
};
export const getDoc = async (ref) => snap(ref);
export const getDocFromServer = async (ref) => snap(ref);
export const getDocsFromServer = async (ref) => { if (ref.path === "allowlist") throw DENIED(); return snap(ref); };

function apply(path, data, merge) {
  path = realPath(path);
  if (path.startsWith("refusals/")) return;            // nothing to report in the demo
  const cur = merge && store[path] ? store[path] : {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "__inc" in v) cur[k] = (cur[k] || 0) + v.__inc;
    else cur[k] = v;
  }
  store[path] = cur;
}
export const setDoc = async (ref, data, opts) => { apply(ref.path, data, opts && opts.merge); notify(); };
export const updateDoc = async (ref, data) => { apply(ref.path, data, true); notify(); };
export const deleteDoc = async (ref) => { delete store[realPath(ref.path)]; notify(); };
export const writeBatch = () => {
  const ops = [];
  return {
    set: (r, d, o) => ops.push(() => apply(r.path, d, o && o.merge)),
    update: (r, d) => ops.push(() => apply(r.path, d, true)),
    delete: (r) => ops.push(() => { delete store[realPath(r.path)]; }),
    commit: async () => { ops.forEach((f) => f()); notify(); }
  };
};

// ---------- Sign-in: always the guest ----------
export const getAuth = () => ({});
export class GoogleAuthProvider { setCustomParameters() {} addScope() {} }
const guest = { uid: "demo", email: GUEST, displayName: "Guest", getIdToken: async () => "demo" };
export const onAuthStateChanged = (_auth, cb) => { setTimeout(() => cb(guest), 0); return () => {}; };
export const signInWithPopup = async () => ({ user: guest });
export const signInWithRedirect = async () => {};
// "Sign out" leaves the demo and erases it
export const signOut = async () => {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  location.href = "./";
};
