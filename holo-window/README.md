# Holographic window

A full-screen browser page for the Mac. The MacBook webcam tracks your head, and the page draws a 3D scene
whose projection follows your head. That makes a 24" monitor look like a window into a 3D world, like
Johnny Lee's Wii head-tracking demo. It uses three.js and the MediaPipe FaceDetector, both free and keyless,
loaded from CDNs.

## Status

Work in progress: the page doesn't run yet. `index.html`, `tracker.js` (webcam eye tracking) and `scenes.js`
(box room, space, mountain valley) are written. Paused on 2026-10-18 because of the usage limit.
Next: `main.js` (renderer, head-following projection, keys 1/2/3, C, F, H, [ ], mouse fallback, HUD), run
instructions here, then a check in the browser.
