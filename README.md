# Log

Michael's adventure log: a 3D satellite map with every trip pinned where it happened, notes, photos and route replays.

## How it fits together

- **index.html, style.css, app.js**: the site. Plain files, no build step. GitHub Pages serves them.
- **config.js**: public keys for Mapbox and Supabase. These are meant to be visible.
- **Mapbox GL JS**: satellite imagery, 3D terrain, and the free camera that flies the route replays.
- **Supabase**: the `entries` table, the `photos` storage bucket, and the editor login. Setup is in `supabase/schema.sql`.
- **data/entries.json**: a backup copy of every entry. The site falls back to it if Supabase doesn't answer.
- **.github/workflows/keepalive.yml**: runs once a day. It reads the entries from Supabase, which keeps the free project from pausing, and refreshes `data/entries.json`.

## Who can do what

Anyone can browse. Only emails listed in the `admins` table can add, edit or delete entries and photos. Sign in with the "Editor sign in" link at the bottom of the list.

## Adding a route

Edit an entry, then under Route choose:
- **Import GPX**: from Strava (activity page on the website → ⋯ → Export GPX), Gaia GPS, AllTrails, CalTopo or a Garmin.
- **Draw on map**: click points along the way.
- **Edit points**: one `lat, lng` per line.
