// © 2026 The Sensible Studio. All rights reserved. Not licensed for copying, reuse or redistribution.
// Pagemarks daily backup — runs on GitHub Actions (see .github/workflows/backup.yml)
// Copies every person's Pagemarks and folder list into the "backups" collection, one set per day,
// and keeps the last 14 days. The backups live in the same private Firebase project; the security
// rules give no one (not even the owner's own app) access to them: only these jobs can read them.
// To bring a library back, the owner runs "Restore Pagemarks" (restore.mjs) on GitHub.
// Privacy: this repository is public, so the log only prints totals, never titles or addresses.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const KEEP_DAYS = 14;
const PART_BYTES = 600000;   // keep each backup document well under Firestore's 1 MB limit

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) { console.error("Missing FIREBASE_SERVICE_ACCOUNT secret."); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(raw)) });
const db = getFirestore();

const day = (d) => d.toISOString().slice(0, 10);
const today = day(new Date());
const backups = db.collection("backups");

// Split a list into parts small enough for one document each
function parts(items) {
  const out = [[]];
  let size = 0;
  for (const it of items) {
    const n = Buffer.byteLength(JSON.stringify(it), "utf8");
    if (size + n > PART_BYTES && out[out.length - 1].length) { out.push([]); size = 0; }
    out[out.length - 1].push(it);
    size += n;
  }
  return out;
}

async function deleteDocs(docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
}

let people = 0, saved = 0, docsWritten = 0;
const userRefs = await db.collection("users").listDocuments();
for (const u of userRefs) {
  const uid = u.id;
  const pms = (await u.collection("pagemarks").get()).docs.map((d) => ({ id: d.id, data: d.data() }));
  const folders = await u.collection("meta").doc("folders").get();
  if (!pms.length && !folders.exists) continue;
  people++;
  saved += pms.length;
  // Today's backup replaces any earlier run from today (e.g. a manual run)
  await deleteDocs((await backups.where("uid", "==", uid).where("date", "==", today).get()).docs);
  const chunks = parts(pms);
  for (let i = 0; i < chunks.length; i++) {
    await backups.doc(`${today}_${uid}_${i}`).set({
      date: today, uid, part: i, parts: chunks.length, count: pms.length,
      folders: i === 0 && folders.exists ? folders.data() : null,
      items: chunks[i], at: FieldValue.serverTimestamp()
    });
    docsWritten++;
  }
}

// Keep the last 14 days
const cutoff = day(new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000));
const old = (await backups.where("date", "<", cutoff).get()).docs;
await deleteDocs(old);

console.log(`Backed up ${saved} Pagemarks for ${people} ${people === 1 ? "person" : "people"} (${docsWritten} backup documents). Removed ${old.length} older than ${KEEP_DAYS} days.`);
