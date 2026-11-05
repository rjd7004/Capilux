# Bio-Radar rPPG

A zero-build, zero-runtime-cost **Progressive Web App** that estimates heart rate, pulse waveform and a stress index from your phone's front camera using **remote photoplethysmography (rPPG)**: tiny, invisible colour changes in facial skin caused by blood volume pulses. Everything runs on-device in the browser. No video or data leaves the phone.

> ⚠️ Experimental wellness visualisation. **Not a medical device.** Do not use for diagnosis.

## Deploy (GitHub Pages, $0)

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: _Deploy from a branch_**, pick your branch and `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` in Safari on iPhone, tap **INITIALIZE SCANNER** and allow camera access.
4. Optional: **Share → Add to Home Screen** to run it as a standalone app. After the first launch the app shell, MediaPipe runtime and face model are cached by the service worker and work offline.

Camera access requires HTTPS (or `localhost`). For local development:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Files

| File | Role |
|---|---|
| `index.html` | Semantic HUD markup, PWA/iOS meta tags, MediaPipe ES-module loader (jsDelivr CDN) |
| `styles.css` | Cyberpunk HUD theme: frosted glass, neon accents per scanner phase, safe-area and landscape layouts |
| `app.js` | App manager: camera lifecycle, FaceLandmarker (GPU → CPU fallback), ROI sampling, frame scheduling, guidance, wake lock |
| `rppg-processor.js` | Pure-JS DSP: resampling, POS/CHROM, detrend, Butterworth, FFT, SNR, beat detection, HRV, Baevsky stress index |
| `hud-renderer.js` | Canvas engine: face reticle, ROI highlights, radar guide, ECG trace, quality gauge, spectrum |
| `manifest.json`, `sw.js` | Installable PWA + offline caching |
| `icons/` | App icons (SVG source + PNG renders) |

## Signal pipeline

1. **Capture:** `getUserMedia({ facingMode: 'user', 1280×720 @ 30 fps })`, started from an explicit tap (WebKit policy). Frames are delivered with `requestVideoFrameCallback` (with a `requestAnimationFrame` fallback).
2. **Face mesh:** MediaPipe `FaceLandmarker` (478 landmarks, VIDEO mode). If inference is slow, it automatically runs only every 2nd or 3rd frame; colour sampling still runs on every frame.
3. **ROIs:** forehead and left/right cheek polygons (convex hulls of landmark sets, shrunk toward their centroids). Only the face crop is drawn to a ≤220 px CPU canvas. Pixels inside the polygons are averaged after rejecting clipped/specular and near-black pixels.
4. **Resample** the trailing window (256 samples ≈ 8.5 s) onto a uniform 30 Hz grid.
5. **POS** (Wang et al., 2017): a sliding 1.6 s window, each normalised by its own temporal mean. `S1 = Gn − Bn`, `S2 = −2Rn + Gn + Bn`, `h = S1 + (σS1/σS2)·S2`, overlap-added.
6. **Detrend** (2 s moving average), then a **zero-phase 2nd-order Butterworth band-pass** at 0.7–3.5 Hz (a high-pass and a low-pass biquad, run forward and backward).
7. **FFT:** Hann window, zero-padded to 1024 points, radix-2 Cooley–Tukey. The peak in 0.7–3.5 Hz is refined by parabolic interpolation, giving `BPM = f·60`.
8. **SNR:** power at the fundamental (±0.1 Hz) and first harmonic (±0.2 Hz) vs. the rest of 0.6–4 Hz. **Confidence** combines SNR, BPM stability, head motion and buffer fill. Once a lock is established, a soft prior around the tracked BPM suppresses jumps to harmonics.
9. **Beats and HRV:** peaks are found on a second, narrow band-pass that tracks the measured rate (HR ± 0.55 Hz). Beats are committed only once the filter has settled (≥1.5 s inside the window). IBIs give RMSSD and SDNN, and the **Baevsky stress index** `SI = AMo / (2·Mo·MxDMn)` is mapped to 0–100 once 15 clean IBIs are available.

### A note on the projection

The `3Rn − 2Gn` / `1.5Rn + Gn − 1.5Bn` planes are the **CHROM** chrominance planes (de Haan & Jeanne, 2013). The blood-volume pulse projects onto them with *opposite* signs, while intensity and specular changes project with the *same* sign. So these planes must be combined as `X − α·Y`. Combining them as `X + α·Y` cancels the pulse and amplifies illumination flicker. The processor ships canonical **POS** by default (it was more robust in testing), with CHROM available as `new RPPG.RPPGProcessor({ method: 'chrom' })`.

## Tips for a good reading

- Use bright, even, steady light on your face. Avoid backlight and flickering LEDs.
- Fill about a third to half of the frame with your face, keep still, and don't talk.
- Lock usually takes about 10 s. The stress index needs about 20–30 s of clean beats.

## Browser support

Built for iOS Safari 15.4+ (iPhone), and also works in current Chrome, Edge and Firefox. Screen wake lock is used when available (iOS 16.4+).
