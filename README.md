# Filament Dryer Log

A small offline web app (PWA) for logging 3D-printer filament drying by weight. It projects when the filament is dry enough.

## Use

1. Choose a material. The oven temperature and target moisture % fill in automatically, and you can edit them.
2. Enter the empty-spool weight (if known) and the starting weight, then tap **Start**.
3. Every ~30 minutes (you get a reminder), tap **Took it out – weigh**. The timer pauses while you enter the weight.
4. Tap **Back in oven – resume**. After 3 or more weigh-ins, the app fits a drying curve and shows:
   - estimated moisture %
   - projected dry weight
   - time remaining until the target %, or until further drying is no longer measurable on your scale

Data stays on the phone (localStorage). You can export each session as CSV.

## Model

`w(t) = dry + water · e^(−t/τ)`, fitted by least squares. `t` counts only time in the oven.
Moisture % = (w − dry) / (dry − empty spool) × 100.

## Run locally

```
npx http-server -p 8765 -c-1 .
```

Then open http://127.0.0.1:8765.

## Install on Android

To install a PWA, the app must be served over **HTTPS**. The easiest free option is GitHub Pages:

1. Push this folder to a GitHub repo.
2. Go to Settings → Pages → Deploy from branch → `main` / root.
3. Open `https://<user>.github.io/<repo>/` in Chrome on the phone.
4. Tap ⋮ → **Add to Home screen** / **Install app**.

Reminders (vibration, beep, and a notification) are reliable only while the app is open. Turn on **Keep screen on** during a session. Android may delay timers when the screen is off.

After changing app files, bump `CACHE` in `sw.js` so installed copies update.
