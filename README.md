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
npm run build
npm run preview
```

The static production output is written to `dist/`. The `api/adsb.ts` function must be deployed with the app; Vercel detects it automatically when the repository is imported.

## Deploy to Vercel

1. Push this repository to GitHub.
2. Import the repository in Vercel.
3. Keep the detected framework preset as **Vite**.
4. Deploy with build command `npm run build` and output directory `dist`.

Vercel provides HTTPS automatically, which is required for camera, location, and orientation APIs. The ADS-B proxy is also required in production; do not deploy only the `dist/` directory to a static host unless it supports an equivalent server-side function.
