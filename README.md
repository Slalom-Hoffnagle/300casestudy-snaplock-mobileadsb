# SnapLock

Mobile-first aircraft identification using camera direction, device sensors, and live ADS-B data.

## M2 Camera & Permissions

The app presents a three-step onboarding flow for camera, location, and motion access. Once granted, it opens the rear-facing camera full-screen, starts a high-accuracy location watch, and enables device orientation readings. Denied permissions return to a recoverable browser-settings message.

Camera, location, and motion APIs require HTTPS in production. Local development works on `localhost` and `127.0.0.1`.

## M3 Sensor Stack

The ready view consumes live device orientation values, applies a low-pass filter to heading, pitch, and roll, and corrects magnetic heading with a bundled coarse declination table. GPS accuracy is shown in the live status row; fixes over 100 meters surface an outdoor-signal warning. In development builds, use **Show sensor data** to inspect the smoothed readings and declination correction.

## M4 ADS-B Data

The live view polls the same-origin `/api/adsb` endpoint every three seconds using a 50 nautical mile radius, normalizes aircraft records, and logs the parsed count in development builds. The endpoint proxies adsb.fi server-side because the upstream API does not allow direct browser CORS requests. It validates coordinates, caps the radius at 250 nautical miles, times out upstream requests after eight seconds, and caches identical results for 2.5 seconds.

Polling is single-flight: a new request cannot overlap an active request. It pauses when the tab is hidden, aborts the active request, and resumes when the app becomes visible. Failed requests use exponential backoff, including longer retry delays for HTTP 429 responses. Results older than 15 seconds remain visible with a staleness warning.

## M5 Positioning Engine

`src/lib/positioning.worker.ts` keeps screen-space math off the main thread. Each frame it dead-reckons aircraft forward from speed and track, computes haversine distance and bearing, derives curvature/refraction-aware apparent elevation, maps offsets through the default 60° by 45° FOV, and returns clamped edge coordinates for aircraft outside the frame. Worker requests are single-flight and pause when the page is hidden; M6 consumes the returned positions for rendering.

## Observer Elevation

Vertical placement resolves observer elevation in this order: manual MSL override, reliable fresh GPS WGS84 altitude, cached Copernicus GLO-90 terrain elevation, then unavailable. Matching ADS-B geometric or barometric altitude is selected by datum. SnapLock never silently assumes sea level.

Terrain fallback uses the same-origin `/api/elevation` function, runs only when GPS altitude is unsuitable, and caches a rounded terrain cell for 24 hours. It is not tied to the three-second ADS-B poll. Open **Settings → Observer elevation** to inspect the source, enter a manual elevation, or restore automatic mode.

The overlay uses spherical-Earth line of sight and standard terrestrial refraction (`k = 0.13`). Near-horizon targets are marked as uncertain rather than moved above the horizon. Ridges, buildings, and terrain between the observer and aircraft are not yet modeled.

Terrain data: [Open-Meteo](https://open-meteo.com/) / Copernicus GLO-90. The public endpoint is limited to non-commercial use under 10,000 calls per day unless commercial access is arranged.

## M6 Overlay Rendering

The ready state adds a device-pixel-ratio-aware canvas above the camera. In-frame aircraft render as animated targeting reticles with callsign/elevation labels; the six nearest off-screen aircraft render as directional edge arrows. The canvas uses `requestAnimationFrame`, clears on every frame, and pauses when the page is hidden.

## Sensor Calibration

Open **Settings → Calibrate sensors** after enabling camera, location, and motion. Horizon alignment is optional. Heading can use the automatic corrected compass or be refined against a visible tracked aircraft, the Moon, a map-selected landmark, or a known true bearing. Calibration offsets and quality are stored locally and can be reset independently from display settings.

Landmark calibration loads Leaflet only when opened and displays OpenStreetMap attribution on the map. Moon calibration uses SunCalc locally; no location or calibration data is sent to either library.

## Development

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Vite prints the local URL and reloads the app when source files change.

## Validation

```sh
npm run check
npm test
npm run build
npm run preview
```

The static production output is written to `dist/`. The `api/adsb.ts` and `api/elevation.ts` functions must be deployed with the app; Vercel detects them automatically when the repository is imported.

## Deploy to Vercel

1. Push this repository to GitHub.
2. Import the repository in Vercel.
3. Keep the detected framework preset as **Vite**.
4. Deploy with build command `npm run build` and output directory `dist`.

Vercel provides HTTPS automatically, which is required for camera, location, and orientation APIs. Both data proxies are required in production; do not deploy only the `dist/` directory to a static host unless it supports equivalent server-side functions.
