// Reads the public Supabase settings from config.js, fetches every entry
// (which also counts as activity, so the free project never pauses),
// and saves them to data/entries.json as the site's fallback copy.
import { readFileSync, writeFileSync } from "node:fs";

const cfg = readFileSync("config.js", "utf8");
const pick = k => (cfg.match(new RegExp(k + '\\s*:\\s*"([^"]*)"')) || [])[1] || "";
const url = pick("supabaseUrl"), key = pick("supabaseAnonKey");
if (!url || !key) { console.log("Supabase isn't configured yet; nothing to back up."); process.exit(0); }

const res = await fetch(`${url}/rest/v1/entries?select=*&order=start_date.asc`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
if (!res.ok) { console.error("Supabase answered", res.status, await res.text()); process.exit(1); }
const rows = await res.json();
const clean = rows.map(({ created_at, updated_at, ...r }) => r);
writeFileSync("data/entries.json", JSON.stringify(clean, null, 2) + "\n");
console.log(`Saved ${clean.length} entries.`);
const tr = await fetch(`${url}/rest/v1/trips?select=id,title,notes&order=id.asc`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
if (tr.ok) { const t = await tr.json(); writeFileSync("data/trips.json", JSON.stringify(t, null, 2) + "\n"); console.log(`Saved ${t.length} trips.`); }

// GitHub turns off scheduled jobs in repos with no commits for 60 days,
// so write a heartbeat on the 1st of each month.
const now = new Date();
if (now.getUTCDate() === 1) writeFileSync("data/heartbeat.txt", now.toISOString().slice(0, 10) + "\n");
