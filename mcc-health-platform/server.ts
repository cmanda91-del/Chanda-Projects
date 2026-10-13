// MCC Health Data Platform — Railway Function (Bun). Runs the same server logic as the Apps Script
// version (Code.gs) on top of a SQLite database stored on a Railway volume.
// public/index.html is built from gas/*.html by build-page.ts (run automatically at start).
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import * as XLSX from "xlsx";

const here = import.meta.dir;
const B = {
  html: await Bun.file(here + "/public/index.html").text(),
  meta: await Bun.file(here + "/gas/Metadata.gs").text(),
  code: await Bun.file(here + "/gas/Code.gs").text(),
};

// ---------- storage ----------
const DIR = existsSync("/data") ? "/data" : "./data";
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
if (DIR !== "/data") console.warn("No volume at /data: data will not survive a redeploy.");
const db = new Database(DIR + "/mcc.sqlite", { create: true });
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
db.exec(`CREATE TABLE IF NOT EXISTS sheets (name TEXT PRIMARY KEY, max_r INTEGER, max_c INTEGER, ord INTEGER);
CREATE TABLE IF NOT EXISTS rows (sheet TEXT, r INTEGER, cells TEXT, PRIMARY KEY (sheet, r));
CREATE TABLE IF NOT EXISTS props (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, mime TEXT, data BLOB, created TEXT);`);
const qSheet = db.prepare("INSERT INTO sheets (name, max_r, max_c, ord) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(name) DO UPDATE SET max_r = ?2, max_c = ?3");
const qRow = db.prepare("INSERT INTO rows (sheet, r, cells) VALUES (?1, ?2, ?3) ON CONFLICT(sheet, r) DO UPDATE SET cells = ?3");
const qDelSheet = db.prepare("DELETE FROM sheets WHERE name = ?1");
const qDelRows = db.prepare("DELETE FROM rows WHERE sheet = ?1");
const qProp = db.prepare("INSERT INTO props (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2");
const qFile = db.prepare("INSERT INTO files (id, name, mime, data, created) VALUES (?1, ?2, ?3, ?4, ?5)");
const qGetFile = db.prepare("SELECT name, mime, data FROM files WHERE id = ?1");

type S = { name: string; data: string[][]; maxR: number; maxC: number; ord: number };
const book = new Map<string, S>();
for (const s of db.query("SELECT * FROM sheets ORDER BY ord").all() as any[]) book.set(s.name, { name: s.name, data: [], maxR: s.max_r, maxC: s.max_c, ord: s.ord });
for (const r of db.query("SELECT * FROM rows").all() as any[]) { const s = book.get(r.sheet); if (s) s.data[r.r - 1] = JSON.parse(r.cells); }
const props: Record<string, string> = {};
for (const p of db.query("SELECT * FROM props").all() as any[]) props[p.k] = p.v;

const clean = (x: any) => (typeof x === "string" && x.startsWith("'") ? x.slice(1) : String(x ?? ""));
function sheetApi(s: S): any {
  const saveMeta = () => qSheet.run(s.name, s.maxR, s.maxC, s.ord);
  const saveRow = (i: number) => qRow.run(s.name, i + 1, JSON.stringify(s.data[i] || []));
  const api: any = {
    getName: () => s.name,
    getLastRow: () => { let n = 0; s.data.forEach((r, i) => { if (r && r.some((c) => c !== "" && c != null)) n = i + 1; }); return n; },
    getLastColumn: () => { let n = 0; s.data.forEach((r) => (r || []).forEach((c, j) => { if (c !== "" && c != null) n = Math.max(n, j + 1); })); return n; },
    getMaxRows: () => s.maxR, getMaxColumns: () => s.maxC,
    insertColumnsAfter: (_: number, k: number) => { s.maxC += k; saveMeta(); },
    insertRowsAfter: (_: number, k: number) => { s.maxR += k; saveMeta(); },
    setFrozenRows: () => {},
    getRange: (r: number, c: number, nr = 1, nc = 1) => {
      const rng: any = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.data[r - 1 + i] || [])[c - 1 + j] ?? "")),
        setValues: (v: any[][]) => {
          db.transaction(() => v.forEach((row, i) => {
            const k = r - 1 + i; s.data[k] = s.data[k] || [];
            row.forEach((x, j) => { s.data[k][c - 1 + j] = clean(x); });
            if (k + 1 > s.maxR) s.maxR = k + 1;
            saveRow(k);
          }))();
          saveMeta(); return rng;
        },
        setFontWeight: () => rng, setNumberFormat: () => rng,
      };
      return rng;
    },
    appendRow: (row: any[]) => { const k = api.getLastRow(); s.data[k] = row.map(clean); if (k + 1 > s.maxR) { s.maxR = k + 1; saveMeta(); } saveRow(k); },
  };
  return api;
}
const SS = {
  getId: () => "railway", getUrl: () => "/export.xlsx",
  getSheetByName: (n: string) => (book.has(n) ? sheetApi(book.get(n)!) : null),
  insertSheet: (n: string) => { const s = { name: n, data: [], maxR: 1000, maxC: 26, ord: book.size }; book.set(n, s); qSheet.run(n, 1000, 26, s.ord); return sheetApi(s); },
  getSheets: () => [...book.values()].map(sheetApi),
  deleteSheet: (x: any) => { book.delete(x.getName()); qDelSheet.run(x.getName()); qDelRows.run(x.getName()); },
};
const cache = new Map<string, { v: string; exp: number }>();
const toBytes = (b: any) => Uint8Array.from(b, (x: number) => x & 255);
const G: any = {
  Logger: { log: (m: any) => console.log(String(m)) },
  SpreadsheetApp: { getActiveSpreadsheet: () => SS, openById: () => SS, create: () => SS },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props[k] ?? null, setProperty: (k: string, v: any) => { props[k] = String(v); qProp.run(k, String(v)); } }) },
  CacheService: { getScriptCache: () => ({
    get: (k: string) => { const e = cache.get(k); if (!e || e.exp < Date.now()) { cache.delete(k); return null; } return e.v; },
    put: (k: string, v: string, sec = 600) => cache.set(k, { v: String(v), exp: Date.now() + sec * 1000 }),
    remove: (k: string) => cache.delete(k) }) },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Session: { getEffectiveUser: () => ({ getEmail: () => (Bun.env.ADMIN_EMAIL || "").toLowerCase() }) },
  DriveApp: {
    createFolder: () => ({ getId: () => "files" }),
    getFolderById: () => ({ createFile: (b: any) => {
      const id = crypto.randomUUID().replace(/-/g, "");
      qFile.run(id, b.name, b.mime, toBytes(b.bytes), new Date().toISOString());
      return { getId: () => id, getUrl: () => "/files/" + id };
    } }),
  },
  MailApp: { sendEmail: () => {} },
  ScriptApp: { getService: () => ({ getUrl: () => Bun.env.PUBLIC_URL || "" }) },
  HtmlService: {},
  Utilities: {
    DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
    computeDigest: (_: any, v: string) => [...new Bun.CryptoHasher("sha256").update(v).digest()],
    base64Encode: (b: any) => Buffer.from(toBytes(b)).toString("base64"),
    base64Decode: (s: string) => Buffer.from(s, "base64"),
    getUuid: () => crypto.randomUUID(),
    formatDate: (d: Date, _tz: string, f: string) => { const z = new Date(d.getTime() + 2 * 3600e3).toISOString(); return f === "yyyy" ? z.slice(0, 4) : f === "yyyy-MM" ? z.slice(0, 7) : f === "yyyy-MM-dd" ? z.slice(0, 10) : z.slice(0, 19); },
    newBlob: (bytes: any, mime: string, name: string) => ({ bytes, mime, name }),
  },
};
const EXPORTS = ["setup", "adminLinks", "signup", "login", "logout", "whoami", "orgUnits", "myOrgUnits", "homeStats", "searchPersons", "duplicateCheck", "savePerson",
  "getPerson", "enroll", "saveEvent", "uploadFile", "listUploads", "listTables", "browse", "adminUsers", "adminUpdateUser", "adminAddOrgUnit", "auth_"];
const names = Object.keys(G);
const App: any = new Function(...names, B.meta + "\n" + B.code + "\nreturn {" + EXPORTS.join(",") + "};")(...names.map((n) => G[n]));
App.setup();
console.log("MCC platform ready. Sheets:", [...book.keys()].join(", "));

const PUBLIC = new Set(EXPORTS.filter((n) => n !== "setup" && n !== "auth_"));
const hdrs = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" };
const json = (o: any) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...hdrs } });
const tokenUser = (t: string | null) => { try { return t ? App.auth_(t) : null; } catch { return null; } };

Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  maxRequestBodySize: 32 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
      return new Response(B.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ...hdrs } });
    if (url.pathname === "/health") return new Response("ok");
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const fn = url.pathname.slice(5);
      if (!PUBLIC.has(fn)) return json({ err: "Unknown action." });
      try {
        const args = (await req.json()) as any[];
        let val = App[fn](...(Array.isArray(args) ? args : []));
        if (fn === "listUploads") val = val.map((r: any) => ({ ...r, drive_url: String(r.drive_url) + "?t=" + encodeURIComponent(args[0]) }));
        if (fn === "uploadFile") val = { ...val, drive_url: String(val.drive_url) + "?t=" + encodeURIComponent(args[0]) };
        return json({ val: val === undefined ? null : val });
      } catch (e: any) {
        return json({ err: String(e?.message || e) });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const u = tokenUser(url.searchParams.get("t"));
      if (!u) return new Response("Sign in again to open this file.", { status: 401 });
      const f = qGetFile.get(url.pathname.slice(7)) as any;
      if (!f) return new Response("Not found", { status: 404 });
      G.Logger.log(`file ${url.pathname} opened by ${u.email}`);
      return new Response(f.data, { headers: { "Content-Type": f.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${String(f.name).replace(/[^\w.\- ]/g, "_")}"`, ...hdrs } });
    }
    if (req.method === "GET" && url.pathname === "/export.xlsx") {
      const u = tokenUser(url.searchParams.get("t"));
      if (!u || u.role !== "ADMIN") return new Response("Admins only. Sign in again.", { status: 401 });
      const wb = XLSX.utils.book_new();
      for (const s of book.values()) {
        const h = (s.data[0] || []); const drop = new Set(["pw_hash", "salt"].map((c) => h.indexOf(c)).filter((i) => i >= 0));
        const rows = s.data.filter(Boolean).map((r) => r.filter((_, j) => !drop.has(j)));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.length ? rows : [[]]), s.name.slice(0, 31));
      }
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      return new Response(buf, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="MCC_database_${new Date().toISOString().slice(0, 10)}.xlsx"`, "Cache-Control": "no-store", ...hdrs } });
    }
    return new Response("Not found", { status: 404 });
  },
});
