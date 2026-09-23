# SnapLock

Mobile-first aircraft identification using camera direction, device sensors, and live ADS-B data.

## M2 Camera & Permissions

The app presents a three-step onboarding flow for camera, location, and motion access. Once granted, it opens the rear-facing camera full-screen, starts a high-accuracy location watch, and enables device orientation readings. Denied permissions return to a recoverable browser-settings message.

Camera, location, and motion APIs require HTTPS in production. Local development works on `localhost` and `127.0.0.1`.

## M3 Sensor Stack

The ready view consumes live device orientation values, applies a low-pass filter to heading, pitch, and roll, and corrects magnetic heading with a bundled coarse declination table. GPS accuracy is shown in the live status row; fixes over 100 meters surface an outdoor-signal warning. In development builds, use **Show sensor data** to inspect the smoothed readings and declination correction.

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

The static production output is written to `dist/`.

## Deploy to Vercel

1. Push this repository to GitHub.
2. Import the repository in Vercel.
3. Keep the detected framework preset as **Vite**.
4. Deploy with build command `npm run build` and output directory `dist`.

Vercel provides HTTPS automatically, which is required for camera, location, and orientation APIs.
