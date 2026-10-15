# Check-ins

A home-screen web app for iPhone: record short check-ins through the day, then tap Finish and Merge to turn
them into one vertical video in the Library.

- Everything stays on the phone (IndexedDB). Nothing is uploaded.
- A day runs from 4 am to 4 am, so a check-in after midnight still counts for the evening before.
- Merging copies the recorded video without re-encoding (`merge.js`, using the vendored Mediabunny 1.60.0).
  If the clips differ in format or size, it falls back to playing them into a canvas and recording that,
  which takes as long as the clips themselves.
- Save to Photos uses the iPhone share sheet ("Save Video").

## Run locally

    python3 -m http.server 8793 --directory .

The camera only works on `localhost` or over HTTPS, so the phone needs the hosted copy.

## Updating

Bump `VERSION` in `sw.js` whenever a file changes, so installed copies pick up the new version.
