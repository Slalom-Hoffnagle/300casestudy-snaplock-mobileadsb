<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import {
    applyDeclination,
    magneticDeclination,
    smoothAngle,
    smoothLinear,
    type SensorReading,
  } from './lib/sensors'
  import { AdsbError, fetchNearbyAircraft, type Aircraft } from './lib/adsb'
  import type { AircraftPosition, PositioningInput } from './lib/positioning'

  type AppPhase = 'welcome' | 'camera' | 'location' | 'motion' | 'ready' | 'denied'

  let appPhase: AppPhase = 'welcome'
  let videoElement: HTMLVideoElement | undefined
  let cameraStream: MediaStream | null = null
  let locationWatchId: number | null = null
  let errorMessage = ''
  let locationAccuracy: number | null = null
  let orientationAvailable = false
  let latitude: number | null = null
  let longitude: number | null = null
  let debugEnabled = false
  let sensorReading: SensorReading = {
    heading: 0,
    pitch: 0,
    roll: 0,
    declination: 0,
    latitude: null,
    longitude: null,
  }
  let aircraft: Aircraft[] = []
  let adsbState: 'idle' | 'loading' | 'fresh' | 'error' = 'idle'
  let adsbError = ''
  let lastAdsbUpdate: number | null = null
  let currentTime = Date.now()
  let adsbTimer: number | null = null
  let adsbClock: number | null = null
  let adsbAbortController: AbortController | null = null
  let adsbRequestInFlight = false
  let positioningWorker: Worker | null = null
  let positioningFrame: number | null = null
  let positioningRequestInFlight = false
  let aircraftPositions: AircraftPosition[] = []
  let positioningComputedAt: number | null = null
  let overlayCanvas: HTMLCanvasElement | undefined
  let overlayFrame: number | null = null
  let overlayContext: CanvasRenderingContext2D | null = null
  const markerBirths = new Map<string, number>()
  let selectedAircraft: Aircraft | null = null
  let selectedPosition: AircraftPosition | null = null
  let settingsOpen = false
  let showInitialGuide = true
  let settings = {
    radiusNm: 50,
    distanceUnit: 'nm',
    altitudeUnit: 'ft',
    horizontalFov: 60,
    verticalFov: 45,
  }
  let adsbRetryDelay = 3000
  let adsbRadiusNm = settings.radiusNm
  const isDev = import.meta.env.DEV

  $: adsbIsStale = lastAdsbUpdate !== null && currentTime - lastAdsbUpdate > 15000
  $: adsbAgeSeconds = lastAdsbUpdate === null ? null : Math.max(0, Math.floor((currentTime - lastAdsbUpdate) / 1000))
  $: inFovCount = aircraftPositions.filter((position) => position.inFov).length

  function loadSettings() {
    try {
      const stored = localStorage.getItem('snaplock-settings')
      if (!stored) return
      const parsed = JSON.parse(stored) as Partial<typeof settings>
      settings = { ...settings, ...parsed }
      adsbRadiusNm = settings.radiusNm
    } catch {
      // Ignore malformed local settings and keep defaults.
    }
  }

  function saveSettings() {
    adsbRadiusNm = settings.radiusNm
    localStorage.setItem('snaplock-settings', JSON.stringify(settings))
    if (appPhase === 'ready') scheduleAdsbPoll()
  }

  function closePanels() {
    selectedAircraft = null
    selectedPosition = null
    settingsOpen = false
  }

  function formatAltitude(altitude: number | null) {
    if (altitude === null) return 'Altitude unavailable'
    if (settings.altitudeUnit === 'm') return `${Math.round(altitude * 0.3048).toLocaleString()} m`
    return `${Math.round(altitude).toLocaleString()} ft`
  }

  function formatSpeed(speed: number | null) {
    if (speed === null) return 'Speed unavailable'
    if (settings.distanceUnit === 'km') return `${Math.round(speed * 1.852)} km/h`
    if (settings.distanceUnit === 'mi') return `${Math.round(speed * 1.15078)} mph`
    return `${Math.round(speed)} kt`
  }

  function selectPosition(position: AircraftPosition) {
    selectedPosition = position
    selectedAircraft = aircraft.find((item) => item.icao24 === position.icao24) ?? null
  }

  function handleOverlayClick(event: MouseEvent) {
    if (!overlayCanvas) return
    const bounds = overlayCanvas.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    const inFrame = aircraftPositions
      .filter((position) => position.inFov)
      .find((position) => Math.hypot(position.x - x, position.y - y) <= position.size)
    if (inFrame) {
      selectPosition(inFrame)
      return
    }
    const edge = aircraftPositions
      .filter((position) => !position.inFov)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 6)
      .find((position) => Math.hypot(position.edgeX - x, position.edgeY - y) <= 28)
    if (edge) selectPosition(edge)
  }

  const phaseCopy: Record<Exclude<AppPhase, 'welcome' | 'ready' | 'denied'>, string> = {
    camera: 'Camera access lets SnapLock see the sky through your phone.',
    location: 'Location finds the aircraft near your current position.',
    motion: 'Motion sensors align aircraft markers with where you point.',
  }

  function handleOrientation(event: DeviceOrientationEvent) {
    if (event.alpha === null) return

    const declination = latitude !== null && longitude !== null
      ? magneticDeclination(latitude, longitude)
      : sensorReading.declination
    const heading = applyDeclination(event.alpha, declination)

    sensorReading = {
      heading: smoothAngle(sensorReading.heading, heading),
      pitch: smoothLinear(sensorReading.pitch, event.beta ?? sensorReading.pitch),
      roll: smoothLinear(sensorReading.roll, event.gamma ?? sensorReading.roll),
      declination,
      latitude,
      longitude,
    }
    orientationAvailable = true
  }

  async function requestMotionPermission() {
    const orientation = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>
    }

    if (!orientation) return

    if (typeof orientation.requestPermission === 'function') {
      const permission = await orientation.requestPermission()
      if (permission !== 'granted') {
        throw new Error('Motion permission was denied. Enable motion access in your browser settings and try again.')
      }
    }

    if ('DeviceOrientationEvent' in window) {
      window.addEventListener('deviceorientation', handleOrientation)
    }
  }

  function startLocationWatch() {
    if (!navigator.geolocation) {
      throw new Error('Location is not available in this browser. SnapLock needs location to find nearby aircraft.')
    }

    return new Promise<void>((resolve, reject) => {
      locationWatchId = navigator.geolocation.watchPosition(
        (position) => {
          locationAccuracy = position.coords.accuracy
          latitude = position.coords.latitude
          longitude = position.coords.longitude
          sensorReading = {
            ...sensorReading,
            declination: magneticDeclination(latitude, longitude),
            latitude,
            longitude,
          }
          resolve()
        },
        () => reject(new Error('Location permission was denied. Enable location access in your browser settings and try again.')),
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
      )
    })
  }

  async function enableSensors() {
    errorMessage = ''
    appPhase = 'camera'

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access is unavailable. Open SnapLock over HTTPS in a supported mobile browser.')
      }
      // iOS requires requestPermission() to run synchronously from the button tap.
      const motionPermission = requestMotionPermission()
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      })
      appPhase = 'location'
      await startLocationWatch()
      appPhase = 'motion'
      await motionPermission
      appPhase = 'ready'
      await tick()
      if (videoElement && cameraStream) videoElement.srcObject = cameraStream
      await videoElement?.play()
      startAdsbPolling()
      startPositioning()
      startOverlay()
    } catch (error) {
      cameraStream?.getTracks().forEach((track) => track.stop())
      cameraStream = null
      appPhase = 'denied'
      errorMessage = error instanceof Error ? error.message : 'A browser permission was denied. Check your browser settings and try again.'
    }
  }

  function retryPermissions() {
    if (locationWatchId !== null) {
      navigator.geolocation.clearWatch(locationWatchId)
      locationWatchId = null
    }
    enableSensors()
  }

  function scheduleAdsbPoll(delay = 0) {
    if (adsbTimer !== null) window.clearTimeout(adsbTimer)
    adsbTimer = window.setTimeout(pollAdsb, delay)
  }

  async function pollAdsb() {
    if (document.hidden || adsbRequestInFlight) return
    if (latitude === null || longitude === null) {
      scheduleAdsbPoll(1000)
      return
    }

    adsbRequestInFlight = true
    adsbAbortController = new AbortController()
    if (lastAdsbUpdate === null) adsbState = 'loading'

    try {
      const result = await fetchNearbyAircraft(latitude, longitude, adsbRadiusNm, adsbAbortController.signal)
      aircraft = result
      lastAdsbUpdate = Date.now()
      currentTime = lastAdsbUpdate
      adsbState = 'fresh'
      adsbError = ''
      adsbRetryDelay = 3000
      if (isDev) console.info(`[SnapLock] ADS-B aircraft: ${aircraft.length}`)
      scheduleAdsbPoll(3000)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      adsbState = 'error'
      adsbError = error instanceof AdsbError ? error.message : 'Unable to reach the ADS-B service.'
      adsbRetryDelay = error instanceof AdsbError && error.status === 429
        ? Math.min(30000, adsbRetryDelay * 2)
        : Math.min(30000, Math.max(6000, adsbRetryDelay * 2))
      scheduleAdsbPoll(adsbRetryDelay)
    } finally {
      adsbRequestInFlight = false
    }
  }

  function startAdsbPolling() {
    adsbClock = window.setInterval(() => {
      currentTime = Date.now()
    }, 1000)
    scheduleAdsbPoll()
  }

  function stopAdsbPolling() {
    if (adsbTimer !== null) window.clearTimeout(adsbTimer)
    if (adsbClock !== null) window.clearInterval(adsbClock)
    adsbAbortController?.abort()
    adsbRequestInFlight = false
    adsbTimer = null
    adsbClock = null
    adsbAbortController = null
  }

  function getPositioningInput(): PositioningInput | null {
    if (latitude === null || longitude === null) return null
    return {
      aircraft: aircraft.map(({ icao24, callsign, latitude: aircraftLatitude, longitude: aircraftLongitude, altBaro, altGeom, groundSpeed, track, lastSeen }) => ({
        icao24,
        callsign,
        latitude: aircraftLatitude,
        longitude: aircraftLongitude,
        altBaro,
        altGeom,
        groundSpeed,
        track,
        lastSeen,
      })),
      user: {
        latitude,
        longitude,
        heading: sensorReading.heading,
        pitch: sensorReading.pitch,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        horizontalFov: settings.horizontalFov,
        verticalFov: settings.verticalFov,
      },
      now: Date.now(),
    }
  }

  function schedulePositioningFrame() {
    if (positioningFrame === null) positioningFrame = window.requestAnimationFrame(runPositioningFrame)
  }

  function runPositioningFrame() {
    positioningFrame = null
    if (!positioningWorker || document.hidden) return
    if (!positioningRequestInFlight) {
      const input = getPositioningInput()
      if (input) {
        positioningRequestInFlight = true
        positioningWorker.postMessage(input)
      }
    }
    schedulePositioningFrame()
  }

  function startPositioning() {
    if (positioningWorker) return
    positioningWorker = new Worker(new URL('./lib/positioning.worker.ts', import.meta.url), { type: 'module' })
    positioningWorker.onmessage = (event: MessageEvent<{ positions: AircraftPosition[]; computedAt: number }>) => {
      aircraftPositions = event.data.positions
      positioningComputedAt = event.data.computedAt
      positioningRequestInFlight = false
    }
    positioningWorker.onerror = () => {
      positioningRequestInFlight = false
      positioningWorker?.terminate()
      positioningWorker = null
    }
    schedulePositioningFrame()
  }

  function stopPositioning() {
    if (positioningFrame !== null) window.cancelAnimationFrame(positioningFrame)
    positioningWorker?.terminate()
    positioningFrame = null
    positioningWorker = null
    positioningRequestInFlight = false
  }

  function resizeOverlay() {
    if (!overlayCanvas) return
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const width = window.innerWidth
    const height = window.innerHeight
    if (overlayCanvas.width !== width * pixelRatio || overlayCanvas.height !== height * pixelRatio) {
      overlayCanvas.width = width * pixelRatio
      overlayCanvas.height = height * pixelRatio
      overlayCanvas.style.width = `${width}px`
      overlayCanvas.style.height = `${height}px`
      overlayContext = overlayCanvas.getContext('2d')
      overlayContext?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    }
  }

  function drawReticle(context: CanvasRenderingContext2D, position: AircraftPosition, time: number) {
    const bornAt = markerBirths.get(position.icao24) ?? time
    markerBirths.set(position.icao24, bornAt)
    const entrance = Math.min(1, (time - bornAt) / 220)
    const scale = 0.78 + 0.22 * entrance
    const size = position.size * scale
    const half = size / 2
    const corner = size * 0.3
    context.save()
    context.translate(position.x, position.y)
    context.globalAlpha = position.opacity
    context.strokeStyle = '#b9f23d'
    context.lineWidth = 2
    context.shadowColor = 'rgba(185, 242, 61, 0.6)'
    context.shadowBlur = 8
    context.beginPath()
    context.moveTo(-half, -half + corner)
    context.lineTo(-half, -half)
    context.lineTo(-half + corner, -half)
    context.moveTo(half - corner, -half)
    context.lineTo(half, -half)
    context.lineTo(half, -half + corner)
    context.moveTo(-half, half - corner)
    context.lineTo(-half, half)
    context.lineTo(-half + corner, half)
    context.moveTo(half - corner, half)
    context.lineTo(half, half)
    context.lineTo(half, half - corner)
    context.stroke()
    context.shadowBlur = 0
    context.fillStyle = '#ffffff'
    context.font = '700 11px "Avenir Next", sans-serif'
    context.textAlign = 'center'
    context.fillText(`${position.callsign}  ${Math.round(position.elevation)}°`, 0, -half - 9)
    context.restore()
  }

  function drawEdgeArrow(context: CanvasRenderingContext2D, position: AircraftPosition) {
    const angle = Math.atan2(position.y - window.innerHeight / 2, position.x - window.innerWidth / 2)
    const x = position.edgeX
    const y = position.edgeY
    context.save()
    context.translate(x, y)
    context.rotate(angle)
    context.globalAlpha = position.opacity
    context.fillStyle = '#b9f23d'
    context.shadowColor = 'rgba(185, 242, 61, 0.65)'
    context.shadowBlur = 8
    context.beginPath()
    context.moveTo(12, 0)
    context.lineTo(-7, -7)
    context.lineTo(-3, 0)
    context.lineTo(-7, 7)
    context.closePath()
    context.fill()
    context.restore()
  }

  function renderOverlay(time: number) {
    overlayFrame = null
    if (!overlayCanvas || document.hidden) return
    resizeOverlay()
    const context = overlayContext
    if (!context) return
    context.clearRect(0, 0, window.innerWidth, window.innerHeight)
    const offscreen = aircraftPositions
      .filter((position) => !position.inFov)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 6)
    offscreen.forEach((position) => drawEdgeArrow(context, position))
    aircraftPositions.filter((position) => position.inFov).forEach((position) => drawReticle(context, position, time))
    const activeIds = new Set(aircraftPositions.map((position) => position.icao24))
    markerBirths.forEach((_, id) => {
      if (!activeIds.has(id)) markerBirths.delete(id)
    })
    overlayFrame = window.requestAnimationFrame(renderOverlay)
  }

  function startOverlay() {
    resizeOverlay()
    if (overlayFrame === null) overlayFrame = window.requestAnimationFrame(renderOverlay)
  }

  function stopOverlay() {
    if (overlayFrame !== null) window.cancelAnimationFrame(overlayFrame)
    overlayFrame = null
    overlayContext = null
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      if (adsbTimer !== null) window.clearTimeout(adsbTimer)
      if (adsbClock !== null) window.clearInterval(adsbClock)
      adsbTimer = null
      adsbClock = null
      adsbAbortController?.abort()
      if (positioningFrame !== null) window.cancelAnimationFrame(positioningFrame)
      positioningFrame = null
      if (overlayFrame !== null) window.cancelAnimationFrame(overlayFrame)
      overlayFrame = null
      return
    }

    if (appPhase === 'ready') {
      adsbClock = window.setInterval(() => {
        currentTime = Date.now()
      }, 1000)
      scheduleAdsbPoll()
      schedulePositioningFrame()
      startOverlay()
    }
  }

  onDestroy(() => {
    cameraStream?.getTracks().forEach((track) => track.stop())
    if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId)
    window.removeEventListener('deviceorientation', handleOrientation)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    stopAdsbPolling()
    stopPositioning()
    stopOverlay()
  })

  onMount(loadSettings)
  document.addEventListener('visibilitychange', handleVisibilityChange)
</script>

<svelte:head>
  <meta
    name="description"
    content="Point your phone at the sky and identify nearby aircraft with live ADS-B data."
  />
</svelte:head>

<main class="scanner-shell">
  {#if appPhase === 'ready' && cameraStream}
    <video class="camera-feed" bind:this={videoElement} autoplay muted playsinline></video>
    <canvas class="overlay-canvas" bind:this={overlayCanvas} onclick={handleOverlayClick} aria-label="Aircraft position overlay"></canvas>
  {/if}
  <div class="sky" aria-hidden="true"></div>
  <div class="scrim" aria-hidden="true"></div>

  <header class="app-header">
    <a class="brand" href="/" aria-label="SnapLock home">
      <img src="/snaplock-mark.svg" width="36" height="36" alt="" />
      <span>SnapLock</span>
    </a>
    <button class="settings-button" type="button" aria-label="Open settings" onclick={() => (settingsOpen = true)}>⚙</button>
    <span class="status"><i></i> {appPhase === 'ready' ? 'Sensors online' : 'Ready when you are'}</span>
  </header>

  {#if appPhase === 'welcome' || appPhase === 'denied'}
    <section class="permission-panel" aria-labelledby="welcome-title">
      <div class="permission-mark" aria-hidden="true">✦</div>
      <p class="eyebrow">Visual aircraft identification</p>
      <h1 id="welcome-title">Look up.<br />Lock on.</h1>
      {#if appPhase === 'denied'}
        <div class="permission-error" role="alert">{errorMessage}</div>
        <button class="primary-action" type="button" onclick={retryPermissions}>Try permissions again</button>
      {:else}
        <p class="lede">SnapLock needs three permissions to place aircraft in your view.</p>
        <div class="permission-list" aria-label="Required permissions">
          <span><b>01</b> Camera</span>
          <span><b>02</b> Location</span>
          <span><b>03</b> Motion</span>
        </div>
        <button class="primary-action" type="button" onclick={enableSensors}>Enable sensors <span aria-hidden="true">↗</span></button>
      {/if}
    </section>
  {:else if appPhase === 'ready'}
    <section class="viewfinder live-view" aria-labelledby="live-title">
      {#if showInitialGuide}
        <button class="guide-dismiss" type="button" aria-label="Clear scanning instructions" onclick={() => (showInitialGuide = false)}>×</button>
        <div class="reticle" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
          <div class="aircraft">✈</div>
        </div>
        <p class="eyebrow" id="live-title">Scanning your horizon</p>
        <p class="lede">Point your camera at the sky to begin.</p>
      {:else}
        <button class="guide-restore" type="button" aria-label="Show scanning instructions" onclick={() => (showInitialGuide = true)}>Show guidance</button>
      {/if}
      <div class="sensor-readout">
        <span><i class:active={orientationAvailable}></i> Motion {orientationAvailable ? 'ready' : 'unavailable'}</span>
        <span><i class:active={locationAccuracy !== null}></i> GPS {locationAccuracy ? `${Math.round(locationAccuracy)}m` : 'locating'}</span>
        <span><i class:active={adsbState === 'fresh' && !adsbIsStale}></i> ADS-B {adsbState === 'loading' ? 'loading' : `${aircraft.length} nearby`}</span>
        <span><i class:active={positioningComputedAt !== null}></i> View {inFovCount} in frame</span>
      </div>
      {#if adsbIsStale}
        <p class="data-warning">ADS-B data is {adsbAgeSeconds}s old. Showing the last successful result.</p>
      {:else if adsbState === 'error'}
        <p class="data-warning">{adsbError}</p>
      {/if}
      {#if locationAccuracy !== null && locationAccuracy > 100}
        <p class="accuracy-warning">GPS accuracy is limited. Move outdoors for a better fix.</p>
      {/if}
      {#if isDev}
        <button class="debug-toggle" type="button" onclick={() => (debugEnabled = !debugEnabled)}>
          {debugEnabled ? 'Hide sensor data' : 'Show sensor data'}
        </button>
        {#if debugEnabled}
          <dl class="debug-panel">
            <div><dt>Heading</dt><dd>{sensorReading.heading.toFixed(1)}° true</dd></div>
            <div><dt>Pitch</dt><dd>{sensorReading.pitch.toFixed(1)}°</dd></div>
            <div><dt>Roll</dt><dd>{sensorReading.roll.toFixed(1)}°</dd></div>
            <div><dt>Declination</dt><dd>{sensorReading.declination.toFixed(1)}°</dd></div>
            <div><dt>Worker</dt><dd>{positioningComputedAt ? 'active' : 'waiting'}</dd></div>
          </dl>
        {/if}
      {/if}
    </section>
  {:else}
    <section class="permission-panel permission-progress" aria-live="polite" aria-labelledby="permission-title">
      <div class="progress-ring" aria-hidden="true"></div>
      <p class="eyebrow">Permission {appPhase === 'camera' ? '01' : appPhase === 'location' ? '02' : '03'} of 03</p>
      <h2 id="permission-title">{appPhase === 'camera' ? 'Open the camera' : appPhase === 'location' ? 'Find your position' : 'Enable motion'}</h2>
      <p class="lede">{phaseCopy[appPhase]}</p>
    </section>
  {/if}

  <footer class="app-footer">
    <div class="milestone">
      <span class="milestone-label">Build status</span>
      <strong>{appPhase === 'ready' ? 'Sensors calibrated' : 'M3 sensor stack'}</strong>
    </div>
    <a href="https://adsb.fi" target="_blank" rel="noreferrer">Flight data provided by adsb.fi</a>
  </footer>

  {#if selectedAircraft}
    <div class="sheet-layer" role="presentation">
      <button class="sheet-backdrop" type="button" aria-label="Dismiss aircraft details" onclick={closePanels}></button>
      <div class:compact-sheet={!selectedPosition?.inFov} class="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="aircraft-title">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-heading">
          <div>
            <span class="sheet-kicker">{selectedPosition?.inFov ? 'Aircraft in view' : 'Aircraft direction'}</span>
            <h2 id="aircraft-title">{selectedAircraft.callsign}</h2>
          </div>
          <button class="close-button" type="button" aria-label="Close aircraft details" onclick={closePanels}>×</button>
        </div>
        {#if selectedPosition?.inFov}
          <div class="aircraft-facts">
            <div><span>Type</span><strong>{selectedAircraft.type ?? 'Unknown'}</strong></div>
            <div><span>Registration</span><strong>{selectedAircraft.registration ?? 'Unavailable'}</strong></div>
            <div><span>Altitude</span><strong>{formatAltitude(selectedAircraft.altBaro ?? selectedAircraft.altGeom)}</strong></div>
            <div><span>Speed</span><strong>{formatSpeed(selectedAircraft.groundSpeed)}</strong></div>
            <div><span>Heading</span><strong>{selectedAircraft.track === null ? 'Unavailable' : `${Math.round(selectedAircraft.track)}°`}</strong></div>
            <div><span>Last update</span><strong>{adsbAgeSeconds === null ? 'Unknown' : `${adsbAgeSeconds}s ago`}</strong></div>
          </div>
          <div class="route-line">
            <span>{selectedAircraft.origin ?? 'Unknown origin'}</span>
            <b>→</b>
            <span>{selectedAircraft.destination ?? 'Unknown destination'}</span>
          </div>
          <a class="tracker-link" href={`https://adsb.fi/aircraft/${selectedAircraft.icao24}`} target="_blank" rel="noreferrer">Open on adsb.fi <span aria-hidden="true">↗</span></a>
        {:else}
          <div class="direction-facts">
            <div><span>Bearing</span><strong>{selectedPosition ? `${Math.round(selectedPosition.bearing)}°` : 'Unknown'}</strong></div>
            <div><span>Elevation</span><strong>{selectedPosition ? `${Math.round(selectedPosition.elevation)}°` : 'Unknown'}</strong></div>
            <div><span>Distance</span><strong>{selectedPosition ? `${selectedPosition.distance.toFixed(1)} nm` : 'Unknown'}</strong></div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if settingsOpen}
    <div class="settings-layer" role="presentation">
      <button class="sheet-backdrop" type="button" aria-label="Close settings" onclick={closePanels}></button>
      <div class="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="sheet-heading">
          <div>
            <span class="sheet-kicker">Configuration</span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button class="close-button" type="button" aria-label="Close settings" onclick={closePanels}>×</button>
        </div>
        <label class="setting-row">
          <span>Search radius</span>
          <select bind:value={settings.radiusNm} onchange={saveSettings}>
            <option value={10}>10 nm</option>
            <option value={25}>25 nm</option>
            <option value={50}>50 nm</option>
            <option value={100}>100 nm</option>
          </select>
        </label>
        <label class="setting-row">
          <span>Distance units</span>
          <select bind:value={settings.distanceUnit} onchange={saveSettings}>
            <option value="nm">Nautical miles</option>
            <option value="km">Kilometers</option>
            <option value="mi">Statute miles</option>
          </select>
        </label>
        <label class="setting-row">
          <span>Altitude units</span>
          <select bind:value={settings.altitudeUnit} onchange={saveSettings}>
            <option value="ft">Feet</option>
            <option value="m">Meters</option>
          </select>
        </label>
        <div class="fov-setting">
          <div class="setting-label"><span>Horizontal FOV</span><strong>{settings.horizontalFov}°</strong></div>
          <input type="range" min="45" max="80" step="1" bind:value={settings.horizontalFov} oninput={saveSettings} />
          <div class="setting-label"><span>Vertical FOV</span><strong>{settings.verticalFov}°</strong></div>
          <input type="range" min="30" max="60" step="1" bind:value={settings.verticalFov} oninput={saveSettings} />
        </div>
        <p class="settings-note">Adjust FOV until a known landmark lines up with the camera view.</p>
      </div>
    </div>
  {/if}
</main>
