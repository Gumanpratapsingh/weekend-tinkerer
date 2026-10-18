// Webcam head tracking with MediaPipe FaceDetector (BlazeFace short range).
// Gives the viewer's eye midpoint in centimetres, relative to the webcam:
// +x = viewer's right, +y = up, +z = distance from the camera.

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const IPD_CM = 6.3; // average adult inter-pupil distance

export class HeadTracker {
  constructor(video) {
    this.video = video;
    this.detector = null;
    this.fovDeg = 70;      // horizontal FOV of the webcam, tweak with [ and ]
    this.lastVideoTime = -1;
    this.eyes = null;      // last eye keypoints (normalised 0..1), for the HUD preview
    this.ready = false;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    const { FilesetResolver, FaceDetector } = await import(`${MP}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
    try {
      this.detector = await FaceDetector.createFromOptions(vision, opts('GPU'));
    } catch {
      this.detector = await FaceDetector.createFromOptions(vision, opts('CPU'));
    }
    this.ready = true;
  }

  // Returns {x, y, z} in cm relative to the camera, null if no face in this frame,
  // or undefined if there is no new video frame yet.
  poll(nowMs) {
    const v = this.video;
    if (!this.ready || v.readyState < 2 || v.currentTime === this.lastVideoTime) return undefined;
    this.lastVideoTime = v.currentTime;
    const res = this.detector.detectForVideo(v, nowMs);
    const det = res.detections && res.detections[0];
    if (!det || !det.keypoints || det.keypoints.length < 2) { this.eyes = null; return null; }
    const [a, b] = det.keypoints; // 0 = right eye, 1 = left eye
    this.eyes = [a, b];
    const vw = v.videoWidth, vh = v.videoHeight;
    const f = (vw / 2) / Math.tan((this.fovDeg * Math.PI / 180) / 2); // focal length in px
    const dpx = Math.hypot((b.x - a.x) * vw, (b.y - a.y) * vh);
    if (dpx < 4) return null;
    const z = f * IPD_CM / dpx;
    const cx = ((a.x + b.x) / 2) * vw - vw / 2;
    const cy = ((a.y + b.y) / 2) * vh - vh / 2;
    // The raw webcam frame is not mirrored: moving to your right moves you left in the image.
    return { x: -cx * z / f, y: -cy * z / f, z };
  }

  // Small mirrored preview with the two eye points, drawn into the HUD.
  drawPreview(ctx) {
    const v = this.video, w = ctx.canvas.width, h = ctx.canvas.height;
    if (!this.ready || v.readyState < 2) return;
    ctx.save();
    ctx.translate(w, 0); ctx.scale(-1, 1);
    ctx.drawImage(v, 0, 0, w, h);
    if (this.eyes) {
      ctx.fillStyle = '#4cf';
      for (const k of this.eyes) { ctx.beginPath(); ctx.arc(k.x * w, k.y * h, 2.5, 0, 7); ctx.fill(); }
    }
    ctx.restore();
  }
}
