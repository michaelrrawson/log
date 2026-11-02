# Log

Michael's adventure log: a 3D satellite map with every trip pinned where it happened, notes, photos and route replays.

## How it fits together

- **index.html, style.css, app.js**: the site. Plain files, no build step. GitHub Pages serves them.
- **config.js**: public keys for Mapbox and Supabase. These are meant to be visible.
- **Mapbox GL JS**: satellite imagery, 3D terrain, and the free camera that flies the route replays.
- **Supabase**: the `entries` table, the `photos` storage bucket, and the editor login. Setup is in `supabase/schema.sql`.
- **supabase/functions/**: two small server functions. `strava-connect` links one Strava account (editors only); `strava-sync` imports new hikes, trail runs, rides, mountain bike rides and backcountry ski tours every 3 hours (a `pg_cron` job), renames generic titles after the trail or town, and fills distance, vertical, moving time and gear on older Strava entries.
- **data/entries.json**: a backup copy of every entry. The site falls back to it if Supabase doesn't answer.
- **.github/workflows/keepalive.yml**: runs once a day. It reads the entries from Supabase, which keeps the free project from pausing, and refreshes `data/entries.json`.

## Who can do what

Anyone can browse. Only emails listed in the `admins` table can add, edit or delete entries and photos. Sign in with the "Editor sign in" link at the bottom of the list.

## Adding a route

Edit an entry, then under Route choose:
- **Import GPX**: from Strava (activity page on the website → ⋯ → Export GPX), Gaia GPS, AllTrails, CalTopo or a Garmin.
- **Draw on map**: click points along the way.
- **Edit points**: one `lat, lng` per line.

## Features

- **Search and filter**: the search box matches titles, places, notes and gear; Filter picks years and activities. Pins, routes, the heatmap and the totals all follow the filter.
- **Timeline**: the slider under the map shows everything up to a date; ▶ plays your adventures in order.
- **Heat**: switches pins and lines for a heatmap of every route.
- **Totals**: click the numbers at the top of the list. Breaks down by activity, year and gear (miles on each pair of shoes or bike).
- **Gear**: one item per line when editing an entry.
- **Share links**: every entry has its own address (`?e=<id>`); "Copy link" on an entry copies it.
- **Replay route**: the 3D flyover.

## Strava sync setup (once)

1. At strava.com/settings/api create an app. Set **Authorization Callback Domain** to `mvmemzherfquvxmmyqeg.supabase.co`.
2. In Supabase → Edge Functions → Secrets, add `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` from that page.
3. On the site, sign in as editor and choose **Connect** next to "Strava not connected" at the bottom of the list. Allow access to all activities.
