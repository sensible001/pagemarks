// © 2026 The Sensible Studio. All rights reserved. Not licensed for copying, reuse or redistribution.
// Restore one person's Pagemarks from a daily backup — run by the owner on GitHub
// (Actions → "Restore Pagemarks" → Run workflow). See .github/workflows/restore.yml.
//
//   EMAIL  the person's sign-in email
//   DATE   the backup's date, YYYY-MM-DD (the backup is made at about 1:45 AM Eastern)
//   MODE   "add-missing" (the safe choice): brings back Pagemarks that were deleted since then,
//              and any missing folders; leaves everything that's there now untouched.
//          "replace": makes the library exactly as it was on that date. Anything added or
//              changed since then is lost.
//   DRY_RUN "yes" (the default): only reports what would happen. Choose "no" to do it.
// Privacy: the log prints counts only.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) { console.error("Missing FIREBASE_SERVICE_ACCOUNT secret."); process.exit(1); }
// Inputs come from the "Run workflow" form, read from GitHub's event file (never printed)
import { readFileSync } from "node:fs";
let inputs = {};
try { inputs = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).inputs || {}; } catch { /* run locally */ }
const pick = (k) => String(inputs[k] ?? process.env[k.toUpperCase()] ?? "").trim();
const EMAIL = pick("email").toLowerCase();
const DATE = pick("date");
const MODE = pick("mode") === "replace" ? "replace" : "add-missing";
const DRY = pick("dry_run").toLowerCase() !== "no";
if (!EMAIL || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error("Give the person's email and a date like 2026-11-25."); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(raw)) });
const db = getFirestore();

let uid;
try { uid = (await getAuth().getUserByEmail(EMAIL)).uid; }
catch { console.error("No Pagemarks sign-in found for that email."); process.exit(1); }

const snap = await db.collection("backups").where("uid", "==", uid).where("date", "==", DATE).get();
if (snap.empty) {
  const dates = [...new Set((await db.collection("backups").where("uid", "==", uid).get()).docs.map((d) => d.data().date))].sort();
  console.error(`No backup for that date. Backups available: ${dates.join(", ") || "none"}.`);
  process.exit(1);
}
const partsDocs = snap.docs.map((d) => d.data()).sort((a, b) => a.part - b.part);
if (partsDocs.length !== partsDocs[0].parts) { console.error("That backup is incomplete; try another date."); process.exit(1); }
const items = partsDocs.flatMap((p) => p.items);
const folders = partsDocs[0].folders;

const col = db.collection("users").doc(uid).collection("pagemarks");
const current = new Map((await col.get()).docs.map((d) => [d.id, d]));
const backupIds = new Set(items.map((x) => x.id));
const toWrite = MODE === "replace" ? items : items.filter((x) => !current.has(x.id));
const toDelete = MODE === "replace" ? [...current.values()].filter((d) => !backupIds.has(d.id)) : [];

console.log(`Backup of ${DATE}: ${items.length} Pagemarks. Now: ${current.size}. Mode: ${MODE}.`);
console.log(`${DRY ? "Would bring back or reset" : "Bringing back or resetting"} ${toWrite.length}; ${DRY ? "would remove" : "removing"} ${toDelete.length} added since.`);
if (DRY) process.exit(0);

const ops = [...toWrite.map((x) => ["set", col.doc(x.id), x.data]), ...toDelete.map((d) => ["delete", d.ref])];
for (let i = 0; i < ops.length; i += 400) {
  const batch = db.batch();
  for (const [op, ref, data] of ops.slice(i, i + 400)) op === "set" ? batch.set(ref, data) : batch.delete(ref);
  await batch.commit();
}
// Folders (including empty ones) and Home pins
if (folders) {
  const metaRef = db.collection("users").doc(uid).collection("meta").doc("folders");
  if (MODE === "replace") await metaRef.set(folders);
  else {
    const now = (await metaRef.get()).data() || {};
    const paths = [...new Set([...(now.paths || []), ...(folders.paths || [])])].sort();
    await metaRef.set({ paths }, { merge: true });
  }
}
console.log("Done.");
