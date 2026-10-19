# Holographic window

A full-screen browser page for the Mac. The MacBook webcam tracks your head, and the page draws a 3D scene
with an **off-axis (asymmetric frustum) projection** that follows your eyes. That makes a 24" monitor look like
a window into a 3D world, the same trick as Johnny Lee's Wii head-tracking demo. Lean left and you see more of the
right wall; stand up and you look down into the room.

Everything is free and keyless: three.js 0.160.0 and MediaPipe tasks-vision 0.10.14 (BlazeFace short-range
face detector) are loaded from jsdelivr and Google's model bucket. No build step.

## Run it

```bash
python3 -m http.server 8130 --bind 127.0.0.1 --directory holo-window
```

Open <http://localhost:8130/> in Chrome or Safari and allow the camera. It has to be `localhost`, because the
camera only works on secure origins.

On the monitor:

1. Put the MacBook just below the monitor, or in front of it, with the webcam roughly centred under the screen.
2. Switch the monitor to the Mac's HDMI input, and drag the browser window onto it.
3. Press **F** for fullscreen. The page assumes the canvas is the whole 53.1 × 29.9 cm panel.
4. Sit centred about 60 cm away and press **C** to calibrate.

URL options: `?scene=2` opens a scene directly, `?mouse` skips the camera, and `?fit` treats a non-fullscreen
window as the full monitor width (handy for previews).

## Keys

| Key | Action |
|---|---|
| 1 / 2 / 3 | Box room / space / mountain valley |
| F | Fullscreen on/off |
| C | Calibrate: sit centred about 60 cm away; a 3 s countdown, then it records the camera offset and distance scale |
| R | Reset calibration |
| [ / ] | Webcam horizontal FOV −/+ 2° (default 70°) |
| H | Show/hide the HUD: head x/y/z in cm, fps, mode, a webcam preview with the eye points |
| M | Switch between mouse mode and head tracking |
| Mouse wheel | Head distance, in mouse mode |

## Calibration tips

- Turn **Center Stage off** (Control Center → Video Effects while the camera is on). It pans and zooms the frame,
  which the tracker reads as head movement.
- Before calibrating, the camera is assumed to sit about 18 cm below the screen centre (just under the bottom
  bezel). C replaces that with the real offset, so calibrate whenever you move the laptop.
- If depth feels too strong or too weak when you lean in and out, nudge the FOV with [ ] and calibrate again.
- It's a one-eyed illusion: closing one eye makes the depth much more convincing. Good, even light on your face
  helps the tracker.
- Calibration is kept in the browser (localStorage), so it survives reloads.

## How it works

- **Tracking** (`tracker.js`): the FaceDetector gives two eye keypoints. Their pixel distance and an average 6.3 cm
  eye spacing give the distance, using the webcam's focal length worked out from its FOV. The midpoint gives
  x and y. The result is smoothed with an exponential lerp. If your face is lost, the last position is held.
- **Projection** (`main.js`): the screen is the rectangle W × H in the z = 0 plane, and the eye is at (x, y, z).
  The camera sits at the eye with no rotation. `makePerspective(left, right, top, bottom, near, far)` uses
  `left = (−W/2 − x)·near/z` and so on, so the frustum always passes through the monitor's four edges.
  A logarithmic depth buffer keeps the 1 cm to 600 m range sharp.
- **Scenes** (`scenes.js`, in cm):
  - The classic 50 cm deep grid box, with spheres on strings tied to the back wall. Three of them float in
    front of the glass.
  - Space: a starfield, a ringed planet and an asteroid that drifts out of the screen past your left ear.
  - A low-poly valley with fog, snowy ranges, a lake and conifers. Two of the trees stand in front of the glass.
- With no camera permission it falls back to the mouse, which moves the head position so the page still demos.
