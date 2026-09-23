# SnapLock

Mobile-first aircraft identification using camera direction, device sensors, and live ADS-B data.

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
