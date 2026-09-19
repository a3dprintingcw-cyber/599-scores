# 599 Scores — Android app package

Everything here is one offline web app. No build step, no dependencies, no server code.

```
index.html               the whole app, data included (~235 KB)
manifest.webmanifest     app name, icons, colours
sw.js                    service worker, makes it work with no signal
icon-*.png               app icons
```

---

## 1. Fastest way: install straight on the phone (2 minutes)

1. Put the whole folder online. Any static host works and the free tiers are enough:
   - **Netlify Drop** — netlify.com/drop, drag the folder in, done
   - **Cloudflare Pages** — pages.cloudflare.com, upload the folder
   - **GitHub Pages** — push the folder, turn on Pages in the repo settings
   It must be **https**, or the offline mode and the install prompt will not work.
2. Open the address in **Chrome on Android**.
3. Chrome shows **"Install app"** at the bottom, or use the ⋮ menu → **Install app** / **Add to Home screen**.
4. It lands on the home screen with its own icon and opens full screen, no browser bar.

After the first open it works with **no internet**. Scores, tables, badges, everything.

## 2. If you want a real .apk for the Play Store

The app is already a valid PWA, so you can wrap it without touching the code:

- **PWABuilder** — pwabuilder.com, paste your https address, choose Android, download the signed .apk / .aab
- **Bubblewrap** (command line):
  ```
  npm i -g @bubblewrap/cli
  bubblewrap init --manifest https://YOURDOMAIN/manifest.webmanifest
  bubblewrap build
  ```

Both produce a Trusted Web Activity: a real Android app, no browser chrome, installable from the Play Store. When you update the web files, the app updates itself.

## 3. No hosting at all

Copy `index.html` to the phone and open it from the Files app. Everything works except the install prompt and the offline cache, since those need https.

---

## Editing on the phone

The **Editor** tab is always available in this build.

- Every change saves **on that phone** straight away, in that browser's storage.
- **"Warda + baha app"** also downloads a fresh `index.html` with your changes baked in. Upload that one file to your host and everyone else sees the update.
- **Editor → Mas → Backup** downloads the data on its own as JSON, and restores it.

Careful: clearing the browser data for the site wipes edits that were never downloaded. Take a JSON backup before anything risky.

## Updating the data from FFK

Tables, scorer charts, fixtures and referees came from ffk.cw (a Genius Sports feed). The FFK publishes no API, so it is copy-in by hand for now. If you want this automatic, it needs a small server job that reads that feed on a schedule and writes the JSON. Ask and I will write it.

---

# Keeping it up to date automatically

`tools/` holds a job that reads the Curaçao football database and rewrites `data.json`. The app loads that file on every open, so new results appear without touching the app itself.

ffk.cw renders a Genius Sports feed in the browser, which is why a plain page fetch looks empty. The feed underneath is served as ordinary HTML at `hosted.dcd.shared.geniussports.com/CUW/en/...`, with no key and no login, so the job just reads it. No browser, no Playwright, two small dependencies.

## Run it by hand

```
cd tools
npm install
npm run update
```

That writes `../data.json`. Upload it and everyone sees the new tables, scorers and fixtures.

While testing:

```
FFK_ONLY=2414 npm run update      # one competition
FFK_MAX_DATES=3 npm run update    # only the most recent match dates
```

## Run it on a schedule, for free

`.github/workflows/update-data.yml` is ready.

1. Push this folder to a GitHub repo.
2. Turn on **Settings → Pages** and point it at the branch. That serves the app over https.
3. It then runs **twice a day**, plus after the weekend evening kickoffs, and commits `data.json` when something changed. Pages redeploys itself.
4. **Actions → Update Curaçao football data → Run workflow** forces a run.

## What it collects

Every competition the federation publishes, the women's championship included, and next season's as soon as it appears:

- standings for each phase and each poule separately
- top scorers, assists, clean sheets, cards and minutes
- every fixture date, with venue, kickoff, score and the referee's name
- the club list with real badges, shrunk to small WebP

Referees rebuild from the names on the match sheets, so the Arbiter tab fills itself as the season runs.

## What it never touches

`tools/editorial.json` holds what the federation does not publish: transfers and news. Those survive every update, and so do the referee rewards, sponsors and points ledger. If you edit in the app, export from **Editor → Mas → Backup** and paste the relevant parts into `editorial.json`.

## If it breaks

The feed could change shape. Then the run fails or comes back thin, and the app keeps showing the last good `data.json`. Every run uploads `tools/raw.json` as a GitHub artifact so you can see what came back.

**First run:** try `FFK_ONLY=2414 npm run update` and check the summary it prints. It should report one competition, seven poules and around thirty matches.
