# Check-ins

A home-screen web app for iPhone: record short check-ins through the day, then tap Finish and Merge to turn
them into one vertical video in the Library.

- Everything stays on the phone (IndexedDB). Nothing is uploaded.
- A new day starts at midnight, by the phone's clock.
- Merging copies the recorded video without re-encoding (`merge.js`, using the vendored Mediabunny 1.60.0).
  If the clips differ in format or size, it falls back to playing them into a canvas and recording that,
  which takes as long as the clips themselves.
- Save to Photos uses the iPhone share sheet ("Save Video").

## Run locally

    python3 -m http.server 8793 --directory .

The camera only works on `localhost` or over HTTPS, so the phone needs the hosted copy.

## Updating

Whenever a file changes, bump `VERSION` in `sw.js` and the `?v=` number on `styles.css`, `app.js` (in `index.html`)
and `merge.js` (in `app.js`), so phones never mix old and new files.
