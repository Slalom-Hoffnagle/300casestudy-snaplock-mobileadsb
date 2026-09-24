<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import {
    magneticDeclination,
    normalizeAngle,
    smoothAngle,
    smoothLinear,
    smoothSignedAngle,
    type SensorReading,
  } from './lib/sensors'
  import { AdsbError, fetchNearbyAircraft, type Aircraft } from './lib/adsb'
  import { haversineDistance, type AircraftPosition, type PositioningInput } from './lib/positioning'
  import CalibrationFlow from './lib/calibration/CalibrationFlow.svelte'
  import {
    CALIBRATION_STORAGE_KEY,
    DEFAULT_CALIBRATION,
    calibrationIsStale,
    parseCalibration,
    type SensorCalibration,
  } from './lib/calibration'
  import {
    gpsAltitudeConfidence,
    resolveObserverElevation,
  } from './lib/elevation'
  import { fetchTerrainElevation, type TerrainElevationFix } from './lib/elevation-service'
  import { cameraFrameFromAngles, deriveCameraOrientation } from './lib/orientation'
  import { OrientationSourceAdapter, resolveTrueHeading, type HeadingDatum, type HeadingSource } from './lib/orientation-source'
  import { effectiveCoverFov } from './lib/camera'

  type AppPhase = 'welcome' | 'camera' | 'location' | 'motion' | 'ready' | 'denied'

  let appPhase: AppPhase = 'welcome'
  let videoElement: HTMLVideoElement | undefined
  let cameraStream: MediaStream | null = null
  let cameraWidth: number | null = null
  let cameraHeight: number | null = null
  let locationWatchId: number | null = null
  let errorMessage = ''
  let locationAccuracy: number | null = null
  let orientationAvailable = false
  let latitude: number | null = null
  let longitude: number | null = null
  let debugEnabled = false
  let showDevHorizon = false
  let sensorReading: SensorReading = {
    heading: 0,
    pitch: 0,
    roll: 0,
    declination: 0,
    latitude: null,
    longitude: null,
    altitude: null,
    altitudeAccuracy: null,
    altitudeTimestamp: 0,
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
  let calibrationOpen = false
  let statusOpen = false
  let calibration: SensorCalibration = { ...DEFAULT_CALIBRATION }
  let terrainElevation: TerrainElevationFix | null = null
  let terrainElevationError = ''
  let elevationAbortController: AbortController | null = null
  let requestedTerrainCell = ''
  let terrainRequestLatitude: number | null = null
  let terrainRequestLongitude: number | null = null
  let terrainRetryAfter = 0
  const orientationSourceAdapter = new OrientationSourceAdapter()
  let orientationSource: HeadingSource | 'unavailable' = 'unavailable'
  let orientationDatum: HeadingDatum | 'unknown' = 'unknown'
  let orientationAccuracy: number | null = null
  let rawOrientation = { alpha: 0, beta: 0, gamma: 0 }
  let diagnosticsRecording = false
  let orientationDiagnostics: Array<{
    timestamp: number
    alpha: number
    beta: number
    gamma: number
    source: HeadingSource
    datum: HeadingDatum
    heading: number
    elevation: number
    roll: number
    markerX: number | null
    markerY: number | null
  }> = []
  let settings = {
    radiusNm: 10,
    distanceUnit: 'nm',
    altitudeUnit: 'ft',
    horizontalFov: 60,
    verticalFov: 45,
    manualElevationMeters: null as number | null,
  }
  let adsbRetryDelay = 3000
  let adsbRadiusNm = settings.radiusNm
  const isDev = import.meta.env.DEV

  $: adsbIsStale = lastAdsbUpdate !== null && currentTime - lastAdsbUpdate > 15000
  $: adsbAgeSeconds = lastAdsbUpdate === null ? null : Math.max(0, Math.floor((currentTime - lastAdsbUpdate) / 1000))
  $: inFovCount = aircraftPositions.filter((position) => position.inFov).length
  $: calibrationLocationStale = calibration.latitude !== null && calibration.longitude !== null && latitude !== null && longitude !== null
    ? haversineDistance(calibration.latitude, calibration.longitude, latitude, longitude) > 50
    : false
  $: calibrationStale = calibrationIsStale(calibration, currentTime) || calibrationLocationStale
  $: calibrationSourceChanged = calibration.calibratedAt > 0
    && calibration.orientationSource !== 'unknown'
    && orientationSource !== 'unavailable'
    && calibration.orientationSource !== orientationSource
  $: observerElevation = resolveObserverElevation({
    manualMeters: settings.manualElevationMeters,
    gpsMeters: sensorReading.altitude,
    gpsAccuracyMeters: sensorReading.altitudeAccuracy,
    gpsTimestamp: sensorReading.altitudeTimestamp,
    terrainMeters: terrainElevation?.elevation ?? null,
    terrainTimestamp: terrainElevation?.timestamp,
    now: currentTime,
  })
  $: observerElevationText = observerElevation.meters === null
    ? 'unavailable'
    : `${observerElevation.source} ${settings.altitudeUnit === 'ft' ? `${Math.round(observerElevation.meters / 0.3048)} ft` : `${Math.round(observerElevation.meters)} m`}`
  $: manualElevationDisplay = settings.manualElevationMeters === null
    ? ''
    : settings.altitudeUnit === 'ft'
      ? String(Math.round(settings.manualElevationMeters / 0.3048))
      : String(Math.round(settings.manualElevationMeters))
  $: statusItems = [
    { label: 'Motion', value: orientationAvailable ? 'ready' : 'unavailable', active: orientationAvailable },
    { label: 'Heading', value: orientationSource === 'unavailable' ? 'unavailable' : orientationSource, active: orientationDatum !== 'relative' && orientationDatum !== 'unknown' },
    { label: 'GPS', value: locationAccuracy ? `${Math.round(locationAccuracy)}m` : 'locating', active: locationAccuracy !== null },
    { label: 'ADS-B', value: adsbState === 'loading' ? 'loading' : `${aircraft.length} nearby`, active: adsbState === 'fresh' && !adsbIsStale },
    { label: 'View', value: `${inFovCount} in frame`, active: positioningComputedAt !== null },
    { label: 'Calibration', value: calibrationSourceChanged ? 'source changed' : calibrationStale ? 'stale' : calibration.quality, active: calibration.quality !== 'uncalibrated' && !calibrationStale && !calibrationSourceChanged },
    { label: 'Elevation', value: observerElevation.source, active: observerElevation.source !== 'unavailable' },
  ]
  $: effectiveFov = effectiveCoverFov(
    { horizontal: settings.horizontalFov, vertical: settings.verticalFov },
    cameraWidth,
    cameraHeight,
    window.innerWidth,
    window.innerHeight,
  )
  $: devHorizonTop = 50 + ((sensorReading.pitch + calibration.pitchOffset) / settings.verticalFov) * 100
  $: devHorizonRoll = -(sensorReading.roll + calibration.rollOffset)

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

  function loadCalibration() {
    const stored = parseCalibration(localStorage.getItem(CALIBRATION_STORAGE_KEY))
    if (stored) calibration = stored
  }

  function applyCalibration(nextCalibration: SensorCalibration) {
    calibration = nextCalibration
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(nextCalibration))
    calibrationOpen = false
  }

  function resetCalibration() {
    calibration = { ...DEFAULT_CALIBRATION }
    localStorage.removeItem(CALIBRATION_STORAGE_KEY)
  }

  function openCalibration() {
    settingsOpen = false
    calibrationOpen = true
  }

  function saveSettings() {
    adsbRadiusNm = settings.radiusNm
    localStorage.setItem('snaplock-settings', JSON.stringify(settings))
    if (appPhase === 'ready') scheduleAdsbPoll()
  }

  function clearManualElevation() {
    settings.manualElevationMeters = null
    saveSettings()
    if (latitude !== null && longitude !== null) void ensureTerrainElevation(latitude, longitude)
  }

  function setManualElevation(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    settings.manualElevationMeters = settings.altitudeUnit === 'ft' ? value * 0.3048 : value
    saveSettings()
  }

  async function ensureTerrainElevation(currentLatitude: number, currentLongitude: number) {
    if (settings.manualElevationMeters !== null) return
    const gpsConfidence = gpsAltitudeConfidence(sensorReading.altitude, sensorReading.altitudeAccuracy)
    if (gpsConfidence === 'high' || gpsConfidence === 'medium') {
      elevationAbortController?.abort()
      elevationAbortController = null
      return
    }
    const cell = `${currentLatitude.toFixed(3)}:${currentLongitude.toFixed(3)}`
    const movedNm = terrainRequestLatitude === null || terrainRequestLongitude === null
      ? Number.POSITIVE_INFINITY
      : haversineDistance(terrainRequestLatitude, terrainRequestLongitude, currentLatitude, currentLongitude)
    if (movedNm < 0.135 && Date.now() < terrainRetryAfter) return
    if (cell === requestedTerrainCell && (terrainElevation || elevationAbortController)) return
    requestedTerrainCell = cell
    terrainRequestLatitude = currentLatitude
    terrainRequestLongitude = currentLongitude
    elevationAbortController?.abort()
    elevationAbortController = new AbortController()
    terrainElevationError = ''
    try {
      terrainElevation = await fetchTerrainElevation(currentLatitude, currentLongitude, elevationAbortController.signal)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      terrainElevationError = error instanceof Error ? error.message : 'Terrain elevation is unavailable.'
      terrainRetryAfter = Date.now() + 5 * 60 * 1000
    } finally {
      elevationAbortController = null
    }
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

  function updateCameraDimensions() {
    if (!videoElement) return
    cameraWidth = videoElement.videoWidth || cameraWidth
    cameraHeight = videoElement.videoHeight || cameraHeight
  }

  const phaseCopy: Record<Exclude<AppPhase, 'welcome' | 'ready' | 'denied'>, string> = {
    camera: 'Camera access lets SnapLock see the sky through your phone.',
    location: 'Location finds the aircraft near your current position.',
    motion: 'Motion sensors align aircraft markers with where you point.',
  }

  function handleOrientation(event: DeviceOrientationEvent) {
    if (window.matchMedia('(orientation: landscape)').matches) return
    const sample = orientationSourceAdapter.process(event)
    if (!sample) return

    const declination = latitude !== null && longitude !== null
      ? magneticDeclination(latitude, longitude)
      : sensorReading.declination
    const cameraOrientation = deriveCameraOrientation(sample.alpha, sample.beta, sample.gamma)
    const heading = resolveTrueHeading(sample.heading, sample.datum, declination)
    const smoothedHeading = cameraOrientation.headingAvailable ? smoothAngle(sensorReading.heading, heading) : sensorReading.heading
    const smoothedElevation = smoothLinear(sensorReading.pitch, cameraOrientation.elevation)
    const smoothedRoll = smoothSignedAngle(sensorReading.roll, cameraOrientation.roll)

    sensorReading = {
      ...sensorReading,
      heading: smoothedHeading,
      pitch: smoothedElevation,
      roll: smoothedRoll,
      declination,
      latitude,
      longitude,
    }
    orientationSource = sample.source
    orientationDatum = sample.datum
    orientationAccuracy = sample.headingAccuracy
    rawOrientation = { alpha: sample.alpha, beta: sample.beta, gamma: sample.gamma }
    if (diagnosticsRecording) {
      orientationDiagnostics = [...orientationDiagnostics.slice(-299), {
        timestamp: sample.timestamp,
        alpha: sample.alpha,
        beta: sample.beta,
        gamma: sample.gamma,
        source: sample.source,
        datum: sample.datum,
        heading: smoothedHeading,
        elevation: smoothedElevation,
        roll: smoothedRoll,
        markerX: selectedPosition?.x ?? null,
        markerY: selectedPosition?.y ?? null,
      }]
    }
    orientationAvailable = true
  }

  function toggleDiagnosticsRecording() {
    diagnosticsRecording = !diagnosticsRecording
    if (diagnosticsRecording) orientationDiagnostics = []
  }

  function exportOrientationDiagnostics() {
    const blob = new Blob([JSON.stringify({ exportedAt: Date.now(), samples: orientationDiagnostics }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `snaplock-orientation-${Date.now()}.json`
    link.click()
    URL.revokeObjectURL(url)
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
      window.addEventListener('deviceorientationabsolute', handleOrientation as EventListener)
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
          const altitude = position.coords.altitude
          const altitudeAccuracy = position.coords.altitudeAccuracy
          sensorReading = {
            ...sensorReading,
            declination: magneticDeclination(latitude, longitude),
            latitude,
            longitude,
            altitude: altitude === null ? sensorReading.altitude : smoothLinear(sensorReading.altitude, altitude),
            altitudeAccuracy,
            altitudeTimestamp: altitude === null ? sensorReading.altitudeTimestamp : position.timestamp,
          }
          void ensureTerrainElevation(latitude, longitude)
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
      const cameraSettings = cameraStream.getVideoTracks()[0]?.getSettings()
      cameraWidth = cameraSettings?.width ?? null
      cameraHeight = cameraSettings?.height ?? null
      appPhase = 'location'
      await startLocationWatch()
      appPhase = 'motion'
      await motionPermission
      appPhase = 'ready'
      // Keep the camera unobstructed once the permission flow is complete.
      await tick()
      if (videoElement && cameraStream) videoElement.srcObject = cameraStream
      await videoElement?.play()
      updateCameraDimensions()
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
    const calibratedCameraFrame = cameraFrameFromAngles(
      normalizeAngle(calibration.headingPolarity * sensorReading.heading + calibration.headingOffset),
      sensorReading.pitch + calibration.pitchOffset,
      sensorReading.roll + calibration.rollOffset,
    )
    return {
      aircraft: aircraft.map(({ icao24, callsign, latitude: aircraftLatitude, longitude: aircraftLongitude, altBaro, altGeom, onGround, groundSpeed, track, lastSeen }) => ({
        icao24,
        callsign,
        latitude: aircraftLatitude,
        longitude: aircraftLongitude,
        altBaro,
        altGeom,
        onGround,
        groundSpeed,
        track,
        lastSeen,
      })),
      user: {
        latitude,
        longitude,
        heading: sensorReading.heading,
        pitch: sensorReading.pitch,
        roll: sensorReading.roll,
        headingOffset: calibration.headingOffset,
        headingPolarity: calibration.headingPolarity,
        pitchOffset: calibration.pitchOffset,
        rollOffset: calibration.rollOffset,
        cameraFrame: calibratedCameraFrame,
        elevationMeters: observerElevation.meters,
        elevationSource: observerElevation.source,
        elevationConfidence: observerElevation.confidence,
        elevationAccuracyMeters: observerElevation.accuracyMeters,
        elevationTimestamp: observerElevation.timestamp,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        horizontalFov: effectiveFov.horizontal,
        verticalFov: effectiveFov.vertical,
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
    context.fillText(`${position.callsign}  ${position.distance.toFixed(1)} nm`, 0, -half - 9)
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
      elevationAbortController?.abort()
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
      if (latitude !== null && longitude !== null) void ensureTerrainElevation(latitude, longitude)
    }
  }

  onDestroy(() => {
    cameraStream?.getTracks().forEach((track) => track.stop())
    if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId)
    window.removeEventListener('deviceorientation', handleOrientation)
    window.removeEventListener('deviceorientationabsolute', handleOrientation as EventListener)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    stopAdsbPolling()
    elevationAbortController?.abort()
    stopPositioning()
    stopOverlay()
  })

  onMount(() => {
    loadSettings()
    loadCalibration()
  })
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
    <video class="camera-feed" bind:this={videoElement} autoplay muted playsinline onloadedmetadata={updateCameraDimensions}></video>
    <canvas class="overlay-canvas" bind:this={overlayCanvas} onclick={handleOverlayClick} aria-label="Aircraft position overlay"></canvas>
    {#if isDev && showDevHorizon}
      <div class="dev-horizon" style={`top: ${devHorizonTop}%; transform: rotate(${devHorizonRoll}deg)`} aria-hidden="true"></div>
    {/if}
  {/if}
  <div class="sky" aria-hidden="true"></div>
  <div class="scrim" aria-hidden="true"></div>

  <header class="app-header">
    <div class="brand-stack">
      <a class="brand" href="/" aria-label="SnapLock home">
        <img src="/snaplock-mark.svg" width="36" height="36" alt="" />
        <span>SnapLock</span>
      </a>
      <div class="status-panel">
        <button class="status-toggle" type="button" aria-expanded={statusOpen} onclick={() => (statusOpen = !statusOpen)}>
          <span class="status-indicator" aria-hidden="true"></span>
          <span>Status</span>
        </button>
        {#if statusOpen}
          <div class="status-popover" role="dialog" aria-label="Status details">
            {#each statusItems as item}
              <div class="status-entry">
                <span class="status-entry-label">{item.label}</span>
                <span class:active={item.active} class="status-entry-value">{item.value}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
    <button class="settings-button" type="button" aria-label="Open settings" onclick={() => (settingsOpen = true)}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" />
      </svg>
    </button>
  </header>

  {#if appPhase === 'welcome' || appPhase === 'denied'}
    <section class="permission-panel" aria-labelledby="welcome-title">
      <div class="permission-mark" aria-hidden="true">✦</div>
      <p class="eyebrow">Visual aircraft identification</p>
      <h1 id="welcome-title"><span>Look up.</span><span>Lock on.</span></h1>
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
      {#if adsbIsStale}
        <p class="data-warning">ADS-B data is {adsbAgeSeconds}s old. Showing the last successful result.</p>
      {:else if adsbState === 'error'}
        <p class="data-warning">{adsbError}</p>
      {/if}
      {#if locationAccuracy !== null && locationAccuracy > 100}
        <p class="accuracy-warning">GPS accuracy is limited. Move outdoors for a better fix.</p>
      {/if}
      {#if observerElevation.source === 'unavailable'}
        <p class="accuracy-warning">Vertical aircraft placement is limited until observer elevation is available.</p>
      {:else if terrainElevationError}
        <p class="accuracy-warning">{terrainElevationError}</p>
      {/if}
      {#if orientationDatum === 'relative'}
        <p class="accuracy-warning">Heading is relative to app startup. Use landmark or known-bearing calibration before identifying aircraft.</p>
      {/if}
      {#if orientationSource === 'webkit-compass' && orientationAccuracy !== null && orientationAccuracy > 20}
        <p class="accuracy-warning">Compass accuracy is ±{orientationAccuracy.toFixed(0)}°. Move away from metal or power sources and recalibrate.</p>
      {/if}
      {#if calibrationSourceChanged}
        <p class="accuracy-warning">Heading source changed since calibration. Recalibrate before relying on aircraft placement.</p>
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
            <div><dt>Heading source</dt><dd>{orientationSource} · {orientationDatum}</dd></div>
            <div><dt>Compass accuracy</dt><dd>{orientationAccuracy === null ? 'unknown' : `±${orientationAccuracy.toFixed(0)}°`}</dd></div>
            <div><dt>Raw orientation</dt><dd>{rawOrientation.alpha.toFixed(0)} / {rawOrientation.beta.toFixed(0)} / {rawOrientation.gamma.toFixed(0)}</dd></div>
            <div><dt>Worker</dt><dd>{positioningComputedAt ? 'active' : 'waiting'}</dd></div>
            <div><dt>Observer</dt><dd>{observerElevationText}</dd></div>
            <div><dt>Elevation accuracy</dt><dd>{observerElevation.accuracyMeters === null ? 'unknown' : `±${Math.round(observerElevation.accuracyMeters)}m`}</dd></div>
            <div><dt>Camera stream</dt><dd>{cameraWidth && cameraHeight ? `${cameraWidth}×${cameraHeight}` : 'unknown'}</dd></div>
            <div><dt>Effective FOV</dt><dd>{effectiveFov.horizontal.toFixed(1)}° × {effectiveFov.vertical.toFixed(1)}°</dd></div>
            {#if selectedPosition}<div><dt>Apparent target</dt><dd>{selectedPosition.elevation.toFixed(2)}°</dd></div>{/if}
          </dl>
          <button class="debug-toggle" type="button" onclick={() => (showDevHorizon = !showDevHorizon)}>{showDevHorizon ? 'Hide calibrated horizon' : 'Show calibrated horizon'}</button>
          <button class="debug-toggle" type="button" onclick={toggleDiagnosticsRecording}>{diagnosticsRecording ? `Stop recording (${orientationDiagnostics.length})` : 'Record orientation'}</button>
          {#if orientationDiagnostics.length}<button class="debug-toggle" type="button" onclick={exportOrientationDiagnostics}>Export orientation JSON</button>{/if}
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
            <div><span>Distance</span><strong>{selectedPosition ? `${selectedPosition.distance.toFixed(1)} nm` : 'Unknown'}</strong></div>
            <div><span>Last update</span><strong>{adsbAgeSeconds === null ? 'Unknown' : `${adsbAgeSeconds}s ago`}</strong></div>
            <div><span>Apparent elevation</span><strong>{selectedPosition ? `${selectedPosition.elevation.toFixed(1)}°` : 'Unavailable'}</strong></div>
            <div><span>Vertical confidence</span><strong>{selectedPosition?.verticalConfidence ?? 'Unavailable'}</strong></div>
          </div>
          {#if selectedPosition?.nearHorizon}<p class="detail-warning">Near-horizon placement is uncertain due to altitude and atmospheric variation. Terrain occlusion is not modeled.</p>{/if}
        {:else}
          <div class="direction-facts">
            <div><span>Bearing</span><strong>{selectedPosition ? `${Math.round(selectedPosition.bearing)}°` : 'Unknown'}</strong></div>
            <div><span>Elevation</span><strong>{selectedPosition?.verticalAvailable ? `${selectedPosition.elevation.toFixed(1)}°` : 'Unavailable'}</strong></div>
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
        <div class="elevation-settings">
          <div class="setting-label"><span>Observer elevation</span><strong>{observerElevationText}</strong></div>
          <label class="setting-row">
            <span>Manual MSL elevation ({settings.altitudeUnit === 'ft' ? 'feet' : 'meters'})</span>
            <input type="number" step="1" value={manualElevationDisplay} placeholder="Automatic" onchange={setManualElevation} />
          </label>
          {#if settings.manualElevationMeters !== null}<button class="reset-action" type="button" onclick={clearManualElevation}>Use automatic elevation</button>{/if}
          {#if terrainElevationError}<small>{terrainElevationError}</small>{/if}
        </div>
        <div class="calibration-settings">
          <div class="setting-label"><span>Sensor calibration</span><strong>{calibrationStale ? 'Stale' : calibration.quality}</strong></div>
          <p>{calibration.calibratedAt ? `${calibration.method} · heading ${calibration.headingOffset.toFixed(1)}° · pitch ${calibration.pitchOffset.toFixed(1)}°` : 'Using automatic corrected compass heading.'}</p>
          <button class="primary-action" type="button" disabled={appPhase !== 'ready'} onclick={openCalibration}>{calibration.calibratedAt ? 'Recalibrate sensors' : 'Calibrate sensors'}</button>
          {#if calibration.calibratedAt}
            <button class="reset-action" type="button" onclick={resetCalibration}>Reset calibration</button>
          {/if}
          {#if appPhase !== 'ready'}<small>Enable sensors before calibration.</small>{/if}
        </div>
        <div class="settings-attribution">
          <a href="https://adsb.fi" target="_blank" rel="noreferrer">Flight data by adsb.fi</a>
          <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Terrain by Open-Meteo / Copernicus</a>
        </div>
      </div>
    </div>
  {/if}

  {#if calibrationOpen}
    <CalibrationFlow
      {sensorReading}
      {latitude}
      {longitude}
      gpsAccuracy={locationAccuracy}
      {aircraftPositions}
      {aircraft}
      {orientationSource}
      {orientationDatum}
      {orientationAccuracy}
      onComplete={applyCalibration}
      onCancel={() => (calibrationOpen = false)}
    />
  {/if}
  <div class="portrait-required" role="alert">
    <strong>Portrait mode required</strong>
    <span>Rotate your phone upright to continue tracking aircraft.</span>
  </div>
</main>
