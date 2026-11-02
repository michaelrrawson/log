// Connects the log to one Strava account.
//   ?start=1&state=NONCE  -> sends the editor to Strava's "Authorize" page
//   ?code=...&state=NONCE -> Strava sends them back here; we swap the code for tokens and save them
// The nonce comes from public.strava_connect_nonce(), which only editors can call, so nobody
// else can attach their own Strava account to the log.
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://michaelrrawson.github.io/log/";
const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const clientId = Deno.env.get("STRAVA_CLIENT_ID") ?? "";
const clientSecret = Deno.env.get("STRAVA_CLIENT_SECRET") ?? "";
const db = createClient(url, key, { auth: { persistSession: false } });

const back = (status: string) => Response.redirect(`${SITE}?strava=${encodeURIComponent(status)}`, 302);

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  if (!clientId || !clientSecret) return back("missing-keys");

  const { data: row } = await db.from("strava_auth").select("connect_nonce,nonce_at").eq("id", 1).single();
  const fresh = row?.nonce_at && Date.now() - Date.parse(row.nonce_at) < 30 * 60 * 1000;
  if (!state || !row?.connect_nonce || state !== row.connect_nonce || !fresh) return back("expired");

  const self = `${url}/functions/v1/strava-connect`;
  if (q.get("start")) {
    const auth = new URL("https://www.strava.com/oauth/authorize");
    auth.search = new URLSearchParams({
      client_id: clientId, response_type: "code", redirect_uri: self,
      approval_prompt: "auto", scope: "read,activity:read_all", state,
    }).toString();
    return Response.redirect(auth.toString(), 302);
  }

  if (q.get("error")) return back("denied");
  if (!(q.get("scope") ?? "").includes("activity:read_all")) return back("need-private");
  const code = q.get("code");
  if (!code) return back("expired");

  const tok = await fetch("https://www.strava.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code" }),
  });
  if (!tok.ok) return back("failed");
  const t = await tok.json();
  await db.from("strava_auth").update({
    athlete_id: t.athlete?.id ?? null, access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: t.expires_at, connect_nonce: null, nonce_at: null, last_result: "Connected",
  }).eq("id", 1);

  // kick off the first sync without waiting for it
  const kick = fetch(`${url}/functions/v1/strava-sync`, { method: "POST", headers: { Authorization: `Bearer ${key}` } }).catch(() => {});
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(kick);
  return back("connected");
});
