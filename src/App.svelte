<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import {
    applyDeclination,
    magneticDeclination,
    smoothAngle,
    smoothLinear,
    type SensorReading,
  } from './lib/sensors'

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
  const isDev = import.meta.env.DEV

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

  onDestroy(() => {
    cameraStream?.getTracks().forEach((track) => track.stop())
    if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId)
    window.removeEventListener('deviceorientation', handleOrientation)
  })
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
  {/if}
  <div class="sky" aria-hidden="true"></div>
  <div class="scrim" aria-hidden="true"></div>

  <header class="app-header">
    <a class="brand" href="/" aria-label="SnapLock home">
      <img src="/snaplock-mark.svg" width="36" height="36" alt="" />
      <span>SnapLock</span>
    </a>
    <span class="status"><i></i> {appPhase === 'ready' ? 'Sensors online' : 'Ready when you are'}</span>
  </header>

  {#if appPhase === 'welcome' || appPhase === 'denied'}
    <section class="permission-panel" aria-labelledby="welcome-title">
      <div class="permission-mark" aria-hidden="true">✦</div>
      <p class="eyebrow">Visual aircraft identification</p>
      <h1 id="welcome-title">Look up.<br />Lock on.</h1>
      {#if appPhase === 'denied'}
        <div class="permission-error" role="alert">{errorMessage}</div>
        <button class="primary-action" type="button" on:click={retryPermissions}>Try permissions again</button>
      {:else}
        <p class="lede">SnapLock needs three permissions to place aircraft in your view.</p>
        <div class="permission-list" aria-label="Required permissions">
          <span><b>01</b> Camera</span>
          <span><b>02</b> Location</span>
          <span><b>03</b> Motion</span>
        </div>
        <button class="primary-action" type="button" on:click={enableSensors}>Enable sensors <span aria-hidden="true">↗</span></button>
      {/if}
    </section>
  {:else if appPhase === 'ready'}
    <section class="viewfinder live-view" aria-labelledby="live-title">
      <div class="reticle" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
        <div class="aircraft">✈</div>
      </div>
      <p class="eyebrow" id="live-title">Scanning your horizon</p>
      <p class="lede">Point your camera at the sky to begin.</p>
      <div class="sensor-readout">
        <span><i class:active={orientationAvailable}></i> Motion {orientationAvailable ? 'ready' : 'unavailable'}</span>
        <span><i class:active={locationAccuracy !== null}></i> GPS {locationAccuracy ? `${Math.round(locationAccuracy)}m` : 'locating'}</span>
      </div>
      {#if locationAccuracy !== null && locationAccuracy > 100}
        <p class="accuracy-warning">GPS accuracy is limited. Move outdoors for a better fix.</p>
      {/if}
      {#if isDev}
        <button class="debug-toggle" type="button" on:click={() => (debugEnabled = !debugEnabled)}>
          {debugEnabled ? 'Hide sensor data' : 'Show sensor data'}
        </button>
        {#if debugEnabled}
          <dl class="debug-panel">
            <div><dt>Heading</dt><dd>{sensorReading.heading.toFixed(1)}° true</dd></div>
            <div><dt>Pitch</dt><dd>{sensorReading.pitch.toFixed(1)}°</dd></div>
            <div><dt>Roll</dt><dd>{sensorReading.roll.toFixed(1)}°</dd></div>
            <div><dt>Declination</dt><dd>{sensorReading.declination.toFixed(1)}°</dd></div>
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
</main>
