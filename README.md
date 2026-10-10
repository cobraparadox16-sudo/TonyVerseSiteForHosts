# The Tony Verse Directory

A single-page, dark neon-green cyberpunk hub for the Tony Verse streaming community. Everything lives in one self-contained file, `index.html` — no build step, no dependencies to install.

## What's on the page

| Section | What it does |
|---|---|
| Hero | Site emblem and "Watch Live" button |
| HR Department | Collapsible clip sections |
| Most Recent Streams | Latest stream cards with live view counts |
| Johnny Apple Clipz / Tony Schitzo | Clip-channel sections |
| Channel Stats | Live subscriber and view tiles per channel, with trend history |
| Schedule | Weekly stream schedule table with a "Live" badge |
| The Crew / Reoccurring Guests | Host cards with YouTube, Instagram and TikTok links and copy-to-clipboard Discord handles |
| Tapes / Creator Toolkit | Banner links to the linked tool artifacts |
| Movie Night / Spider-Man Corner | Upcoming movie banner and Marvel section |
| Send a Tip | Streamlabs tip links |
| The Server | Discord invite and live member-count tracker |
| Biography | Click-to-expand story cards |
| Music player | Floating player ("The Tony Verse Directory Mix") |

## Run it

Open `index.html` in any modern browser. For a more realistic test, serve it:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

Live stats, view counts and the Discord tracker need an internet connection. If a request fails, the page keeps the last known values.

## Edit it

- **Text, links and cards:** edit the HTML directly. Each section has an `id` (for example `#crew`, `#schedule`, `#stats`).
- **Stats tiles:** each `.stat-tile` is configured with `data-handle`, `data-channel-id`, `data-last-video-id`, `data-history-key` and `data-poll-ms` (poll interval in milliseconds).
- **Stats history:** the `<script id="stats-history">` JSON block stores dated subscriber/view snapshots used for trends. Keys must match each tile's `data-history-key`.
- **Schedule rows:** each `<tr>` is keyed by `data-history-key` so a host's "Live" badge lights up with their channel.
- **Biographies:** each person is one `<details class="bio-card">` block. Add or remove a whole block to add or remove a person.

## Deploy

Upload `index.html` to any static host (GitHub Pages, Netlify, Cloudflare Pages, Lovable, and so on). It is about 14 MB because the avatars and portraits are embedded as base64 images, so for production consider moving them to separate image files to speed up loading.

## Things to know

- **API keys are in the page source.** The YouTube Data API keys are in each tile's `data-keys` attribute, so anyone can read them. Restrict them to your site's domain in the Google Cloud Console (HTTP referrer restrictions), or move the calls to a small backend.
- **Public CORS relays.** Some requests go through free proxy services (allorigins, corsproxy.io, codetabs, cors.eu.org) as fallbacks. They can be slow or go down; a backend would be more reliable.
- **Emblem artwork.** The hero emblem image is baked in and still shows the older cobra artwork. Replace the `<img>` in the hero section to update it.
- **Removed content.** Houdini's cards, stats, schedule row, bio and tape banner, and all Maximus mentions, were removed from this version.
