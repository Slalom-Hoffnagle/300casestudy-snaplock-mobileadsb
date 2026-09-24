# SnapLock — Product Requirements Document

**Version:** 0.2  
**Author:** Carl Hoffnagle  
**Date:** September 21, 2026  
**Status:** Draft

---

## 1. Overview

SnapLock is a mobile-responsive progressive web application (PWA) that uses a device's camera, GPS, and orientation sensors alongside real-time ADS-B data to identify aircraft currently visible in the sky. The user points their phone camera toward an aircraft; the app determines which aircraft — out of all tracked flights in the area — is in the camera's field of view and displays identifying information as an overlay.

---

## 2. Problem Statement

Aviation enthusiasts, curious onlookers, and professionals frequently spot aircraft and have no quick way to identify them. Dedicated flight-tracking apps (FlightAware, Flightradar24) require the user to interpret a map and manually correlate what they see with what's on screen. SnapLock removes that friction entirely by letting the camera do the pointing.

---

## 3. Goals & Non-Goals

### Goals
- Identify a specific aircraft visible through the device camera using real-time ADS-B positional data.
- Provide identification with minimal user interaction — point and read.
- Work as a mobile-first web app with no required installation (PWA optional enhancement).
- Support both iOS Safari and Android Chrome.

### Non-Goals
- Indoor use or non-aircraft object identification.
- Radar or secondary surveillance data — ADS-B only.
- Server-side user accounts or flight history tracking (v1).
- Native app distribution through app stores (v1).
- Augmented reality animations or 3D rendering (v1).

---

## 4. Target Users

| Persona | Description |
|---|---|
| Aviation enthusiast | Spots planes regularly; wants tail numbers, aircraft type, route |
| Curious casual user | Hears/sees a plane overhead; wants to know "what is that?" quickly |
| Photographer / spotter | At an airport or vantage point; identifying inbound traffic |
| Parent / educator | Showing a child what plane is overhead |

---

## 5. Core Use Case Flow

1. User opens SkySpotter in a mobile browser.
2. App requests permissions: **camera**, **geolocation**, **device orientation**.
3. Live camera feed appears as the full-screen background.
4. App continuously:
   - Polls user GPS position
   - Reads device compass heading (azimuth) and pitch (elevation tilt)
   - Fetches nearby ADS-B aircraft within a configurable radius
   - Calculates which aircraft fall within the camera's field of view
5. Aircraft markers appear as overlays on the camera view at the correct screen position.
6. User taps a marker to see full aircraft detail (callsign, aircraft type, airline, altitude, speed, origin → destination).
7. If no match is found within the FOV, a "No aircraft in view" message is displayed, with a count of nearby aircraft and a prompt to pan around.

---

## 6. Functional Requirements

### 6.1 Camera View
- Render a live rear camera stream as a full-screen background using the `MediaDevices.getUserMedia` API.
- Prefer rear-facing camera (`facingMode: "environment"`).
- Require upright portrait orientation. In landscape, pause the usable camera interface and prompt the user to rotate the device upright.
- Camera view must not be interrupted by UI chrome; overlays are rendered on top.

### 6.2 Geolocation
- Obtain user GPS coordinates via the `Geolocation API` (`watchPosition` for continuous updates).
- Minimum acceptable accuracy: 50 meters.
- Display a degraded-accuracy warning if GPS accuracy exceeds 100 meters.
- Cache last known position for up to 10 seconds to handle brief GPS drops.
- Capture GPS altitude and altitude accuracy when available. GPS altitude uses the WGS84 ellipsoid datum.
- Resolve observer elevation in this order: manual MSL override, reliable fresh GPS altitude, cached Copernicus GLO-90 terrain elevation, then unavailable.
- Never silently assume the observer is at sea level. When elevation is unavailable, continue horizontal bearing guidance but label vertical placement as limited.

### 6.3 Device Orientation
- Use the `DeviceOrientationEvent` API to read:
  - **Alpha (α):** Compass heading (0–360°, where 0 = North). Represents where the phone is pointing horizontally.
  - **Beta (β):** Front-to-back tilt (-180° to 180°). Used to determine pitch/elevation angle.
  - **Gamma (γ):** Left-to-right tilt. Used for landscape compensation.
- Treat alpha, beta, and gamma as a coupled intrinsic Z-X′-Y″ rotation. Transform the rear camera's forward and up vectors to derive true camera azimuth, elevation, and roll; do not calculate elevation from beta alone.
- On iOS/WebKit, prefer `webkitCompassHeading` as true heading and retain `webkitCompassAccuracy`. Otherwise prefer `deviceorientationabsolute`; suppress conflicting relative-orientation events while an absolute source is fresh.
- Track heading datum explicitly. Do not apply magnetic declination to true WebKit headings; apply it exactly once to magnetic headings. Relative headings require user calibration and reduced-confidence UI.
- Portrait is the only supported device orientation. Landscape compensation is not required.
- On iOS 13+, explicitly request permission via `DeviceOrientationEvent.requestPermission()` before reading values.
- Apply magnetic declination correction to convert magnetic north to true north (lookup by lat/lon using a lightweight embedded table or a public API).
- Smooth orientation readings with a low-pass filter to reduce jitter.
- Apply persisted heading, pitch, and roll calibration offsets after smoothing and before aircraft positioning.
- Calibration is optional; declination-corrected device heading remains available without manual setup.

### 6.4 ADS-B Data Integration
- Fetch real-time ADS-B aircraft data from a supported public API (see Section 9).
- Query for all aircraft within a configurable radius (default: 50 nautical miles) of the user's GPS position.
- Refresh interval: every 3 seconds.
- Each aircraft record must include at minimum:
  - ICAO24 hex identifier
  - Callsign / flight number
  - Latitude, longitude (decimal degrees)
  - Barometric and geometric altitude when available, plus explicit ground state
  - Ground speed (knots)
  - Track/heading (degrees true)
  - Aircraft type (ICAO type code, if available)
  - Origin and destination airports (if available from aggregator)
- Cache the last successful fetch; display staleness indicator if data is older than 15 seconds.

### 6.5 Aircraft Position Calculation
For each ADS-B aircraft record, compute whether it falls within the camera's field of view:

**Step 1 — Bearing from user to aircraft**
Compute the great-circle bearing from user's GPS position to the aircraft's reported lat/lon using the haversine formula.

**Step 2 — Apparent elevation angle from user to aircraft**
- Pair compatible vertical data: reliable GPS WGS84 altitude with ADS-B geometric altitude; otherwise terrain/manual MSL elevation with ADS-B barometric altitude.
- Calculate spherical-Earth line of sight from observer and aircraft radius vectors rather than using a flat-Earth altitude ratio.
- Calculate both geometric elevation with physical Earth radius and apparent elevation with standard terrestrial refraction coefficient `k = 0.13`.
- Use apparent elevation for screen placement and retain geometric elevation for diagnostics.
- Attach uncertainty from observer/aircraft altitude accuracy and atmospheric variation. De-emphasize near-horizon markers whose uncertainty interval crosses the horizon; do not force airborne markers above it.
- Terrain-profile occlusion from ridges, buildings, and local obstacles is not modeled in v1.

**Step 3 — Dead reckoning**
Interpolate the aircraft's current position forward from the last ADS-B ping using reported speed and heading to reduce apparent positional lag.

**Step 4 — Map to screen coordinates**
- Construct a portrait camera basis (`forward`, `right`, `up`) anchored to the selected true-heading source.
- Convert aircraft bearing/apparent elevation into an ENU direction vector and project it directly onto the camera basis.
- Use pinhole projection with the calibrated horizontal/vertical camera FOV. Roll is encoded in the camera basis; do not apply a second post-projection roll rotation.
- Clamp off-screen aircraft to the screen edge as directional arrows.

### 6.6 Camera Field of View (FOV)
- Default assumption: 60° horizontal × 45° vertical (conservative mid-range smartphone estimate).
- Allow user to manually calibrate FOV in settings by pointing at a known landmark.
- Read camera stream dimensions from the active video track/video metadata and compensate configured FOV for `object-fit: cover` cropping in the portrait viewport.
- Browser camera APIs do not expose focal length or physical FOV consistently; manual FOV values remain authoritative.
- V2 enhancement: read FOV from the `ImageCapture` API's `getPhotoCapabilities()` or camera track settings where available.

### 6.7 Aircraft Overlay UI
- Aircraft highlighting is **geometry-based**: the app calculates each aircraft's screen position from ADS-B lat/lon/altitude + user GPS + compass heading + device tilt + camera FOV, then renders a real-time overlay on the canvas at that computed pixel position. No computer vision is used.
- The marker style is a **targeting reticle** (corner-bracket box) rather than a simple dot, giving the visual impression of locking onto the aircraft. The reticle animates in on first detection (brief scale-down snap) and tracks smoothly as the user pans.
- Marker label: callsign (or ICAO24 if callsign unavailable) + altitude in feet, rendered just above the reticle.
- Marker size and opacity scale with distance — closer aircraft get a larger, fully opaque reticle; distant aircraft get a smaller, semi-transparent one.
- Overlay canvas updates at up to 60fps; ADS-B position is interpolated between fetch cycles via dead reckoning to keep the reticle smooth.
- Tap/click a marker to open a detail sheet from the bottom of the screen containing:
  - Airline logo (if resolvable) and callsign
  - Aircraft type and registration (if available)
  - Origin → destination
  - Altitude, speed, heading
  - Time since last ADS-B ping
  - Link to external tracker (FlightAware / FlightRadar24) for the flight
- Dismiss detail sheet by tapping outside it or swiping down.

### 6.8 Off-FOV Aircraft Indicators
- Aircraft within range but outside the current FOV are shown as small directional arrows along the screen edge, pointing toward where the user should look.
- Show up to 6 nearest off-screen aircraft as edge indicators.
- Tapping an edge indicator displays minimal info (callsign, bearing, elevation) and does not open the full detail sheet.

### 6.9 Permissions & Onboarding
- On first load, display a brief 3-step permission walkthrough explaining why each permission is needed (camera, location, motion).
- If any permission is denied, display an informative fallback screen explaining the limitation and how to grant it in browser settings.
- Graceful degradation: if orientation is unavailable, fall back to a manual compass-style dial the user can drag to set heading.

### 6.10 Settings Panel
- Maximum search radius (10, 25, 50, 100 nm)
- Distance units (nautical miles / kilometers / statute miles)
- Altitude units (feet / meters)
- FOV calibration tool
- ADS-B API source selection (if multiple are configured)
- Toggle: show all nearby aircraft on a mini-map inset

### 6.11 Sensor Calibration
- Use a two-stage guided flow: optional horizon alignment followed by heading-method selection.
- Horizon alignment uses a fixed high-contrast line and stable sensor sample window to capture pitch and roll offsets. Users may skip when no horizon is visible.
- Heading methods must include:
  - Automatic declination-corrected device compass
  - Alignment to a visually identified ADS-B aircraft
  - Alignment to the Moon's calculated azimuth/elevation
  - Alignment to a map-selected visible landmark
  - Manual entry of a known true bearing
- Aircraft alignment uses the aircraft's computed bearing/elevation from the user's location, never the aircraft's reported flight track.
- Landmark calibration must provide manual latitude/longitude entry so map interpretation is not required.
- Persist calibration method, offsets, quality, timestamp, and calibration location locally. Allow recalibration and independent reset.
- Record orientation source/datum and heading polarity with calibration. A source change invalidates the calibration confidence.
- One-reference heading alignment is unverified. Offer two-reference verification using visible references separated by 60–120°; reject opposite 180° pairs because they cannot distinguish normal from reversed heading direction.
- Fit both normal and reversed heading models and require a maximum circular residual of 5° before marking heading verified.
- Mark calibration stale after 24 hours; continue operating with a visible warning rather than blocking the camera.
- Do not provide Sun alignment due to eye-safety risk.

---

## 7. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Performance | Aircraft position calculations must complete within 16ms per frame (60fps rendering target). ADS-B fetch must not block the UI thread (use Web Workers). |
| Accuracy | Aircraft identification must match the visually observed aircraft in >90% of cases when ADS-B data is fresh (<10s old) and the aircraft is within 25nm. |
| Latency | End-to-end from launch to first overlay render: <5 seconds on a 4G connection. |
| Battery | Minimize wake-lock use; pause GPS polling when app is backgrounded. |
| Privacy | Location is processed locally and sent transiently through same-origin ADS-B and optional terrain-elevation proxies. Proxies validate/round coordinates and do not log or persist them. |
| Offline | Display a clear "No data connection" state. Show last cached ADS-B data with a staleness warning. |
| HTTPS | Required for all sensor APIs (geolocation, orientation, camera). App must be served over HTTPS. |
| Compatibility | iOS Safari 16+, Chrome for Android 110+, Samsung Internet 20+. |

---

## 8. Technical Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Browser / PWA Shell                │
│                                                      │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────┐  │
│  │  Camera     │   │  Sensor      │   │  ADS-B   │  │
│  │  Manager    │   │  Manager     │   │  Service │  │
│  │             │   │              │   │          │  │
│  │ getUserMedia│   │ Geolocation  │   │ Fetch /  │  │
│  │ MediaStream │   │ DeviceOrient.│   │ poll API │  │
│  └──────┬──────┘   └──────┬───────┘   └────┬─────┘  │
│         │                 │                │         │
│         └────────────┬────┘                │         │
│                      ▼                     │         │
│              ┌───────────────┐             │         │
│              │  Positioning  │◄────────────┘         │
│              │  Engine       │                       │
│              │  (Web Worker) │                       │
│              │               │                       │
│              │ • Haversine   │                       │
│              │ • Elevation   │                       │
│              │ • Dead Reckon │                       │
│              │ • FOV mapping │                       │
│              └───────┬───────┘                       │
│                      │                               │
│                      ▼                               │
│              ┌───────────────┐                       │
│              │  Render Layer │                       │
│              │  (Canvas/CSS) │                       │
│              │               │                       │
│              │ • Markers     │                       │
│              │ • Edge arrows │                       │
│              │ • Detail sheet│                       │
│              └───────────────┘                       │
└──────────────────────────────────────────────────────┘
```

### Key Technical Choices
- **Framework:** Vanilla JS or lightweight framework (Svelte recommended for reactivity without overhead). No React — bundle size and startup time matter on mobile.
- **Rendering:** HTML5 Canvas overlay on top of a `<video>` element for marker drawing. CSS transitions for the detail sheet.
- **State management:** Reactive store pattern (Svelte stores or a small hand-rolled observable).
- **Computation:** Positioning math runs in a dedicated Web Worker to keep the main thread free for rendering.
- **Minimal backend proxy required.** Browser CORS restrictions prevent direct reads from adsb.fi. A same-origin Vercel function validates the query, applies a short cache, and proxies the response without storing location data.
- **Deployment:** Vercel. Connect GitHub repo → Vercel project; every push to `main` deploys the Vite client and `/api/adsb` function automatically. HTTPS is provided by Vercel by default, satisfying all browser sensor API requirements. No Vercel environment variables are needed for v1.

---

## 9. ADS-B Data Source

**Primary (and only) source: [adsb.fi](https://adsb.fi) Open Data API**

| Property | Detail |
|---|---|
| Base URL | `https://opendata.adsb.fi/api/` |
| Key endpoint | `GET /v3/lat/{lat}/lon/{lon}/dist/{dist}` |
| Auth | None — no API key required |
| Rate limit | 1 request per second (public tier) |
| Max radius | 250 nautical miles |
| Response format | Compatible with ADS-B Exchange v2 API schema |
| Terms | Personal, non-commercial use; must cite adsb.fi with a link to [adsb.fi](https://adsb.fi) in the UI |

**Example request:**
```
GET https://opendata.adsb.fi/api/v3/lat/47.6062/lon/-122.3321/dist/50
```

**Implementation notes:**
- The 3-second single-flight polling interval is within the 1 req/sec rate limit. Polling pauses while the page is hidden and uses exponential backoff after failures.
- The `dist` parameter is in nautical miles (integer); cap to the user's configured max radius (default 50nm, max 250nm).
- Response fields include: `hex` (ICAO24), `flight` (callsign), `lat`, `lon`, `alt_baro`, `alt_geom`, `gs` (ground speed), `track`, `t` (aircraft type), `r` (registration), `desc` (aircraft description), and more.
- **Citation requirement:** The app footer and about screen must include "Flight data provided by [adsb.fi](https://adsb.fi)" as required by their terms.
- No `AdsbProvider` abstraction layer needed in v1 given single source; add the interface in v2 if multi-source support is desired.

---

## 10. Sensor Accuracy & Edge Cases

| Scenario | Handling |
|---|---|
| Aircraft not transmitting ADS-B (military, some GA) | Cannot identify — display "No ADS-B data for this area" note in edge cases. |
| Stale ADS-B data (>15s) | Display staleness badge on markers; de-emphasize marker opacity. |
| Multiple aircraft in close angular proximity | Stack markers with a small offset; "1 of 3 nearby" indicator on tap. |
| Device held horizontal (pointing straight up) | Beta ≈ 90°; treat elevation angle as ~90°; match aircraft with highest elevation angle. |
| GPS indoors or poor signal | Display degraded-accuracy warning; suggest moving outdoors. |
| Magnetic interference (near metal structures) | Cannot fully compensate; surface warning: "Compass may be inaccurate near metal structures." |
| iOS compass permission denied | Offer manual heading dial as fallback UI. |
| Aircraft on the ground (altitude = 0) | Exclude from FOV matching; include on mini-map inset only. |
| Very high-altitude aircraft (cruising at 40,000ft, >100nm away) | May appear visually near-horizon; elevation calculation handles naturally but accuracy degrades with ADS-B positional error at distance. |

---

## 11. Permissions Model

| Permission | API | iOS Behavior | Android Behavior |
|---|---|---|---|
| Camera | `getUserMedia` | Prompted by browser | Prompted by browser |
| Location | `Geolocation` | Prompted by browser | Prompted by browser |
| Device Motion/Orientation | `DeviceOrientationEvent` | **Requires explicit JS call to `requestPermission()`** — must be triggered by a user gesture | Granted automatically with HTTPS |

> **iOS Critical Path:** The orientation permission must be requested inside a `click` handler. The app's onboarding flow must include a user-tapped "Enable Sensors" button that fires all three permission requests in sequence.

---

## 12. Privacy & Data Handling

- **No analytics, no tracking, no accounts** in v1.
- User GPS coordinates are used for local computation and transient same-origin ADS-B proxy queries; the proxy does not log or persist them.
- ADS-B proxy calls round coordinates to four decimal places and forward only the location/radius required by the upstream endpoint.
- When GPS altitude is unavailable or unreliable, the elevation proxy rounds coordinates to a terrain cell and requests Copernicus GLO-90 elevation through Open-Meteo. Successful cells are cached for 24 hours and are not polled with ADS-B.
- Observer altitude, altitude accuracy, manual elevation overrides, and calibration data remain on-device.
- Terrain data attribution: [Open-Meteo](https://open-meteo.com/) and the Copernicus program. Public API use is limited to non-commercial use under 10,000 daily calls unless commercial access is arranged.
- No cookies beyond session state.
- If a third-party ADS-B API's terms require disclosure, surface a one-time notice on first use.

---

## 13. Future Enhancements (Out of Scope for v1)

- **v2:** WebXR / AR overlay using the WebXR Device API for more precise screen-space placement.
- **v2:** Terrain-profile line-of-sight and occlusion lookup for ridges and local terrain between observer and aircraft.
- **v2:** Aircraft photo lookup (Jetphotos or Planespotters.net API).
- **v2:** Offline mode with pre-cached aircraft type database.
- **v3:** Social/sharing — screenshot with overlay burned in and aircraft details.
- **v3:** Notification mode — "alert me when a specific aircraft type is overhead."
- **v3:** Computer vision aircraft detection — TensorFlow.js model to draw a bounding box around the actual aircraft pixels for pixel-precise highlighting (research item; contingent on viable model for small/distant objects).
- **v3:** Apple Vision Pro spatial computing interface.

---

## 14. Implementation Milestones

### M1 — Project Foundation
**Goal:** Deployable shell on Vercel with nothing broken.
- Initialize repo (GitHub) and connect to Vercel project
- Scaffold app with chosen framework (Svelte recommended) and confirm hot-reload in VS Code
- Configure PWA manifest (`name`, `icons`, `display: standalone`, `orientation: portrait`)
- Confirm HTTPS on Vercel preview URL (required for all sensor APIs)
- Deploy placeholder landing page to production URL

**Exit criteria:** `https://snaplock.vercel.app` (or equivalent) loads over HTTPS with no console errors.

---

### M2 — Camera & Permissions
**Goal:** Full-screen live camera feed with all three permissions granted and handled gracefully.
- Render rear camera stream full-screen via `getUserMedia` (`facingMode: "environment"`)
- Implement 3-step permission onboarding flow (camera → location → sensors)
- iOS 13+: wire orientation permission request to a user-gesture button
- Handle all denial states with informative fallback screens
- Handle portrait/landscape orientation changes without breaking the camera view

**Exit criteria:** On both iOS Safari and Android Chrome, the camera renders full-screen and all three permissions are requested and granted without errors.

---

### M3 — Sensor Stack
**Goal:** Reliable real-time readings from GPS and device orientation.
- Implement `watchPosition` GPS loop; surface accuracy indicator in UI
- Implement `DeviceOrientationEvent` listener; extract alpha (heading), beta (pitch), gamma (roll)
- Apply low-pass filter to smooth orientation jitter
- Apply magnetic declination correction (bundled static lookup table for v1)
- Display live heading/pitch debug overlay (dev-only toggle) for field testing

**Exit criteria:** Walking outside, the heading and pitch values update smoothly and track physical device movement without noticeable lag or jitter.

---

### M4 — ADS-B Data Layer
**Goal:** Live aircraft data flowing into the app every 3 seconds.
- Implement adsb.fi polling service: `GET /v3/lat/{lat}/lon/{lon}/dist/{dist}` every 3 seconds
- Parse response into internal aircraft model (`icao24`, `callsign`, `lat`, `lon`, `altBaro`, `groundSpeed`, `track`, `type`, `registration`)
- Implement staleness detection; show badge when data is >15 seconds old
- Handle network failures and 429s gracefully (exponential backoff, user-visible error state)
- Log aircraft count to console in dev mode for field verification

**Exit criteria:** Standing outdoors, the app fetches and parses live aircraft data with correct counts matching adsb.fi's web map for the same area.

---

### M5 — Positioning Engine (Web Worker)
**Goal:** Accurate screen-space position computed for every aircraft in range.
- Move all math into a dedicated Web Worker to keep the main thread free
- Implement haversine bearing from user GPS to aircraft lat/lon
- Implement datum-aware observer/aircraft altitude pairing, spherical-Earth elevation, and standard refraction
- Implement dead reckoning: interpolate aircraft position forward from last ADS-B ping using speed + track
- Map bearing offset and elevation offset to canvas pixel coordinates using device FOV (default 60° × 45°)
- Output: per-aircraft `{ x, y, inFov, bearing, elevation, distance }` updated each frame

**Exit criteria:** In a field test with a known overhead aircraft, the computed bearing matches a handheld compass reading within ~5°.

---

### M6 — Overlay Rendering
**Goal:** Real-time targeting reticle tracking aircraft on screen at 60fps.
- Render HTML5 Canvas overlay on top of `<video>` element
- Draw targeting reticle (corner-bracket box) at computed `(x, y)` per in-FOV aircraft
- Render callsign + altitude label above each reticle
- Scale reticle size and opacity with distance
- Animate reticle appearance (scale-snap on first detection)
- Render edge-of-screen directional arrows for off-FOV aircraft (up to 6 nearest)
- Confirm 60fps render loop does not drop frames on mid-range Android

**Exit criteria:** Pointing at a known aircraft, the reticle visually tracks it as the phone pans, with no perceptible lag.

---

### M7 — Detail Sheet & Settings
**Goal:** Tapping a reticle reveals full aircraft information; settings panel is functional.
- Bottom sheet slides up on reticle tap, dismisses on swipe-down or outside tap
- Display: airline/callsign, aircraft type + registration, origin → destination, altitude, speed, heading, time since last ping
- Include external link to adsb.fi flight detail page
- Settings panel: search radius, distance units, altitude units, FOV calibration tool
- adsb.fi attribution in footer ("Flight data provided by adsb.fi")

**Exit criteria:** Full aircraft detail is accessible with one tap and all settings persist across sessions.

---

### M8 — Polish & Launch
**Goal:** Production-ready, cross-browser, optimized for mobile battery and performance.
- Cross-browser testing: iOS Safari 16+, Chrome for Android 110+, Samsung Internet 20+
- Battery optimization: pause GPS polling and rendering when app is backgrounded
- Offline state: clear "No data connection" UI with last cached data + staleness warning
- Lighthouse mobile score ≥ 90 (performance, PWA)
- Final Vercel production deploy with custom domain (if applicable)

**Exit criteria:** App passes cross-browser smoke tests, Lighthouse mobile score ≥ 90, and is live on production URL.

---

## 16. Open Questions

1. ~~**Sensor calibration UX**~~ — ✅ Resolved: optional horizon alignment followed by automatic, aircraft, Moon, map-landmark, or known-bearing heading calibration. FOV remains adjustable with horizontal/vertical sliders.
2. ~~**ADS-B Exchange API key distribution**~~ — ✅ Resolved: adsb.fi requires no API key. Pure static Vercel deploy, no proxy needed.
3. **Magnetic declination source** — Use a bundled static lookup table (simpler, offline) or hit a live API (more accurate)?
4. **Minimum aircraft distance cutoff** — Should we exclude aircraft farther than X nautical miles from FOV matching to reduce false positives? (Proposed default: 100nm.)
5. **Accessibility** — How should the aircraft overlay be communicated to users with visual impairments? (Audio readout on tap?)
6. **adsb.fi non-commercial terms** — Confirm the intended use of SkySpotter is personal/non-commercial before launch. If commercial use is anticipated, contact adsb.fi for a commercial arrangement.

---

## 17. Success Metrics

| Metric | Target |
|---|---|
| Correct aircraft identification rate | ≥90% when ADS-B data <10s stale and aircraft within 25nm |
| Time to first overlay from cold launch | <5 seconds on LTE |
| Crash-free sessions | >99% |
| Permission grant rate (all three) | >75% of users who reach permission screen |
| Session length | >60 seconds median (indicates successful identification) |
