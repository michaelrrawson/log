// Pulls new Strava activities into the log. Runs every few hours from pg_cron, and from the
// editor's "Sync now" link. Safe to run any number of times: entries are keyed "strava-<id>"
// and existing ones are never overwritten, so edits made on the site stick.
//
// - Imports hikes, trail runs, rides, mountain bike rides and backcountry ski tours.
// - Generic titles ("Morning Run") become the trail's name, or "<Town> <Time> <Activity>".
// - Also fills distance / vertical / time and Strava gear on older Strava entries, a batch per run.
import { createClient } from "npm:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const clientId = Deno.env.get("STRAVA_CLIENT_ID") ?? "";
const clientSecret = Deno.env.get("STRAVA_CLIENT_SECRET") ?? "";
// Public Mapbox token (same one the site uses) for trail names and place names.
const MAPBOX = "pk.eyJ1IjoibWljaGFlbHJyYXdzb24iLCJhIjoiY212djlqcmxuMDNheDM1cHd4eXdqMXdpaCJ9.ZIUeDW1ZhXgb2OP2b7uLdQ";
const db = createClient(url, key, { auth: { persistSession: false } });

const KIND: Record<string, string> = {
  Hike: "hike", TrailRun: "trailrun", Ride: "bike", GravelRide: "bike", EBikeRide: "bike",
  MountainBikeRide: "mtb", EMountainBikeRide: "mtb", BackcountrySki: "ski",
};
const WORD: Record<string, string> = { hike: "Hike", trailrun: "Trail Run", bike: "Ride", mtb: "Ride", ski: "Tour" };
const GENERIC = /^(morning|lunch|afternoon|evening|night)\s+(trail\s+)?(run|ride|hike|walk|mountain bike ride|e-?bike ride|gravel ride|backcountry ski|ski)$/i;
const BACKFILL_PER_RUN = 40; // Strava allows 100 reads per 15 minutes; leave room for new activities

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function decodePolyline(s: string): number[][] {
  const out: number[][] = []; let i = 0, lat = 0, lng = 0;
  while (i < s.length) {
    for (const which of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    out.push([+(lat / 1e5).toFixed(6), +(lng / 1e5).toFixed(6)]);
  }
  return out;
}
function thin(pts: number[][], max = 4000) { if (pts.length <= max) return pts; const k = pts.length / max; return Array.from({ length: max }, (_, i) => pts[Math.min(pts.length - 1, Math.round(i * k))]); }

async function token(): Promise<string> {
  const { data: a } = await db.from("strava_auth").select("*").eq("id", 1).single();
  if (!a?.refresh_token) throw new Error("Strava isn't connected yet");
  if (a.access_token && a.expires_at > Date.now() / 1000 + 120) return a.access_token;
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: a.refresh_token }),
  });
  if (!r.ok) throw new Error(`Strava token refresh failed (${r.status})`);
  const t = await r.json();
  await db.from("strava_auth").update({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at }).eq("id", 1);
  return t.access_token;
}
async function strava(path: string, tok: string) {
  const r = await fetch(`https://www.strava.com/api/v3${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 429) throw new Error("Strava rate limit reached; will continue next run");
  if (!r.ok) throw new Error(`Strava ${path} answered ${r.status}`);
  return r.json();
}

// Most common named path/track near points along the route, from Mapbox's streets data.
async function trailName(route: number[][]): Promise<string> {
  if (route.length < 2) return "";
  const picks = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map(f => route[Math.floor(f * (route.length - 1))]);
  const count: Record<string, number> = {};
  await Promise.all(picks.map(async ([lat, lng]) => {
    try {
      const r = await fetch(`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lng},${lat}.json?radius=40&limit=10&layers=road&access_token=${MAPBOX}`);
      if (!r.ok) return;
      const seen = new Set<string>();
      for (const f of (await r.json()).features ?? []) {
        const p = f.properties ?? {}, n = (p.name_en || p.name || "").trim();
        if (n && ["path", "track"].includes(p.class) && !seen.has(n)) { seen.add(n); count[n] = (count[n] ?? 0) + 1; }
      }
    } catch { /* ignore */ }
  }));
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : "";
}
// "Provo, Utah" style place name.
async function placeName(lat: number, lng: number): Promise<{ town: string; place: string }> {
  try {
    const r = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lng}&latitude=${lat}&types=place,locality&language=en&access_token=${MAPBOX}`);
    const f = (await r.json()).features?.[0]?.properties;
    if (!f) return { town: "", place: "" };
    const town = f.context?.place?.name || f.name || "";
    const region = f.context?.region?.name || "", country = f.context?.country?.name || "";
    const tail = country === "United States" ? region : (country || region);
    return { town, place: [town, tail].filter(Boolean).join(", ") };
  } catch { return { town: "", place: "" }; }
}
const timeWord = (iso: string) => { const h = +iso.slice(11, 13); return h < 11 ? "Morning" : h < 14 ? "Lunch" : h < 17 ? "Afternoon" : h < 20 ? "Evening" : "Night"; };
const statsOf = (a: any) => ({ strava_id: a.id, meters: a.distance, vertical_m: a.total_elevation_gain, moving_s: a.moving_time, sport: a.sport_type });

async function run() {
  const tok = await token();
  const { data: have } = await db.from("entries").select("id,start_date,stats,gear").like("id", "strava-%");
  const known = new Set((have ?? []).map(r => r.id));
  // only look at activities newer than the newest one already in the log (minus a day, for time zones)
  const newest = (have ?? []).reduce((m, r) => r.start_date > m ? r.start_date : m, "2000-01-01");
  const after = Math.floor(Date.parse(newest) / 1000) - 86400;

  let added = 0, filled = 0, page = 1;
  const fresh: any[] = [];
  while (page < 6) {
    const list = await strava(`/athlete/activities?after=${after}&per_page=100&page=${page}`, tok);
    fresh.push(...list); if (list.length < 100) break; page++;
  }
  for (const s of fresh) {
    const kind = KIND[s.sport_type]; const id = `strava-${s.id}`;
    if (!kind || known.has(id)) continue;
    const a = await strava(`/activities/${s.id}`, tok);
    const route = thin(decodePolyline(a.map?.polyline || a.map?.summary_polyline || ""));
    const start = a.start_latlng?.length === 2 ? a.start_latlng : route[0];
    if (!start) continue; // no GPS (indoor, treadmill): nothing to pin
    const where = await placeName(start[0], start[1]);
    let title = (a.name || "").trim();
    if (!title || GENERIC.test(title)) {
      const trail = await trailName(route);
      title = trail || [where.town, timeWord(a.start_date_local), WORD[kind]].filter(Boolean).join(" ");
    }
    const end = new Date(Date.parse(a.start_date_local) + (a.elapsed_time ?? 0) * 1000).toISOString().slice(0, 10);
    const startDate = a.start_date_local.slice(0, 10);
    const row = {
      id, title, kind, place: where.place, start_date: startDate, end_date: end > startDate ? end : null,
      lat: +start[0].toFixed(6), lng: +start[1].toFixed(6), route, notes: a.description || "",
      gear: a.gear?.name ? [a.gear.name] : [], stats: statsOf(a),
    };
    const { error } = await db.from("entries").upsert(row, { onConflict: "id", ignoreDuplicates: true });
    if (!error) { added++; known.add(id); }
  }

  // backfill stats (and Strava gear, if the entry has none) on older Strava entries
  const missing = (have ?? []).filter(r => !r.stats || !r.stats.strava_id).slice(0, BACKFILL_PER_RUN);
  for (const r of missing) {
    try {
      const a = await strava(`/activities/${r.id.slice(7)}`, tok);
      const patch: Record<string, unknown> = { stats: statsOf(a) };
      if ((!r.gear || !r.gear.length) && a.gear?.name) patch.gear = [a.gear.name];
      await db.from("entries").update(patch).eq("id", r.id); filled++;
    } catch (e) {
      if (String(e).includes("rate limit")) break;
      // deleted or private on Strava: mark so we don't retry forever
      await db.from("entries").update({ stats: { strava_id: +r.id.slice(7), missing: true } }).eq("id", r.id);
    }
  }
  return { added, filled };
}

Deno.serve(async () => {
  try {
    const r = await run();
    const msg = `Added ${r.added}${r.filled ? `, filled stats on ${r.filled}` : ""}`;
    await db.from("strava_auth").update({ last_sync: new Date().toISOString(), last_result: msg }).eq("id", 1);
    return json({ ok: true, ...r });
  } catch (e) {
    await db.from("strava_auth").update({ last_sync: new Date().toISOString(), last_result: String((e as Error).message ?? e) }).eq("id", 1);
    return json({ ok: false, error: String((e as Error).message ?? e) }, 200);
  }
});
