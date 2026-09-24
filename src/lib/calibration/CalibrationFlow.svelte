<script lang="ts">
  import LandmarkPicker from './LandmarkPicker.svelte'
  import {
    DEFAULT_CALIBRATION,
    captureHorizon,
    captureTarget,
    fitTwoReferenceHeading,
    scoreCapture,
    type CalibrationMethod,
    type OrientationSample,
    type SensorCalibration,
  } from '../calibration'
  import type { SensorReading } from '../sensors'
  import type { AircraftPosition } from '../positioning'
  import type { Aircraft } from '../adsb'
  import { cardinalDirection, getMoonTarget } from './moon'
  import type { HeadingDatum, HeadingSource } from '../orientation-source'

  type Stage = 'intro' | 'horizon' | 'method' | 'aircraft' | 'moon' | 'landmark' | 'known' | 'align' | 'verify-entry' | 'verify-first' | 'verify-second' | 'result'
  type Target = { label: string; bearing: number; elevation: number; method: CalibrationMethod; refinePitch: boolean }

  export let sensorReading: SensorReading
  export let latitude: number | null
  export let longitude: number | null
  export let gpsAccuracy: number | null
  export let aircraftPositions: AircraftPosition[]
  export let aircraft: Aircraft[]
  export let orientationSource: HeadingSource | 'unavailable'
  export let orientationDatum: HeadingDatum | 'unknown'
  export let orientationAccuracy: number | null
  export let onComplete: (calibration: SensorCalibration) => void
  export let onCancel: () => void

  let stage: Stage = 'intro'
  let status = ''
  let busy = false
  let knownBearing = 0
  let target: Target | null = null
  let result: SensorCalibration | null = null
  let horizonPitchOffset = 0
  let horizonRollOffset = 0
  let firstReferenceBearing = 0
  let secondReferenceBearing = 90
  let firstMeasuredHeading: number | null = null

  $: moonTarget = latitude !== null && longitude !== null ? getMoonTarget(latitude, longitude) : null
  $: airborneTargets = aircraftPositions
    .filter((position) => aircraft.some((item) => item.icao24 === position.icao24 && !item.onGround && (item.altBaro ?? item.altGeom ?? 0) > 0))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 12)

  function goTo(nextStage: Stage) {
    status = ''
    stage = nextStage
  }

  async function collectSamples() {
    const samples: OrientationSample[] = []
    busy = true
    status = 'Hold steady while SnapLock measures sensor stability.'
    for (let index = 0; index < 15; index += 1) {
      if (document.hidden) break
      samples.push({ heading: sensorReading.heading, pitch: sensorReading.pitch, roll: sensorReading.roll })
      await new Promise((resolve) => window.setTimeout(resolve, 60))
    }
    busy = false
    return samples
  }

  async function setHorizon() {
    const capture = captureHorizon(await collectSamples())
    if (!capture.stable) {
      status = 'Readings moved too much. Hold steady and try again, or skip this step.'
      return
    }
    horizonPitchOffset = capture.pitchOffset
    horizonRollOffset = capture.rollOffset
    status = 'Horizon saved. Choose how to calibrate heading.'
    navigator.vibrate?.(40)
    goTo('method')
  }

  function chooseAutomatic() {
    finish('automatic', 0, horizonPitchOffset, horizonRollOffset, 'automatic', null, null)
  }

  function chooseAircraft(position: AircraftPosition) {
    target = {
      label: position.callsign,
      bearing: position.bearing,
      elevation: position.elevation,
      method: 'aircraft',
      refinePitch: true,
    }
    goTo('align')
  }

  function chooseMoon() {
    if (!moonTarget?.visible) return
    target = {
      label: 'the Moon',
      bearing: moonTarget.azimuth,
      elevation: moonTarget.altitude,
      method: 'moon',
      refinePitch: true,
    }
    goTo('align')
  }

  function chooseLandmark(landmark: { bearing: number }) {
    target = {
      label: 'your selected landmark',
      bearing: landmark.bearing,
      elevation: 0,
      method: 'landmark',
      refinePitch: false,
    }
    goTo('align')
  }

  function chooseKnownBearing() {
    if (!Number.isFinite(knownBearing) || knownBearing < 0 || knownBearing >= 360) {
      status = 'Enter a true bearing from 0 through 359 degrees.'
      return
    }
    target = {
      label: `${Math.round(knownBearing)}° true`,
      bearing: knownBearing,
      elevation: 0,
      method: 'known-bearing',
      refinePitch: false,
    }
    goTo('align')
  }

  function beginHeadingVerification() {
    const separation = Math.abs(((secondReferenceBearing - firstReferenceBearing + 540) % 360) - 180)
    if (separation < 60 || separation > 120) {
      status = 'Choose references separated by 60 to 120 degrees.'
      return
    }
    firstMeasuredHeading = null
    goTo('verify-first')
  }

  async function alignTarget() {
    if (!target) return
    const capture = captureTarget(await collectSamples(), target.bearing, target.elevation)
    if (!capture.stable) {
      status = 'Readings moved too much. Keep the target centered and try again.'
      return
    }
    finish(
      target.method,
      capture.headingOffset,
      target.refinePitch ? capture.pitchOffset : horizonPitchOffset,
      horizonRollOffset,
      scoreCapture(capture),
      capture.headingDeviation,
      capture.pitchDeviation,
    )
    navigator.vibrate?.([35, 30, 70])
  }

  async function captureFirstReference() {
    const capture = captureTarget(await collectSamples(), firstReferenceBearing, 0)
    if (!capture.stable || capture.measuredHeading === null) {
      status = 'Readings moved too much. Keep the first reference centered and try again.'
      return
    }
    firstMeasuredHeading = capture.measuredHeading
    goTo('verify-second')
  }

  async function captureSecondReference() {
    if (firstMeasuredHeading === null) return
    const capture = captureTarget(await collectSamples(), secondReferenceBearing, 0)
    if (!capture.stable || capture.measuredHeading === null) {
      status = 'Readings moved too much. Keep the second reference centered and try again.'
      return
    }
    const fit = fitTwoReferenceHeading(
      { measured: firstMeasuredHeading, target: firstReferenceBearing },
      { measured: capture.measuredHeading, target: secondReferenceBearing },
    )
    if (!fit.valid) {
      status = fit.reason ?? 'The two references did not produce a reliable heading model.'
      return
    }
    finish('two-reference', fit.offset, horizonPitchOffset, horizonRollOffset, fit.residual <= 2 ? 'excellent' : 'good', fit.residual, null, fit.polarity, true)
  }

  function finish(
    method: CalibrationMethod,
    headingOffset: number,
    pitchOffset: number,
    rollOffset: number,
    quality: SensorCalibration['quality'],
    headingDeviation: number | null,
    pitchDeviation: number | null,
    headingPolarity: 1 | -1 = 1,
    twoReferenceVerified = false,
  ) {
    result = {
      ...DEFAULT_CALIBRATION,
      headingOffset,
      pitchOffset,
      rollOffset,
      method,
      quality,
      calibratedAt: Date.now(),
      latitude,
      longitude,
      headingDeviation,
      pitchDeviation,
      orientationSource: orientationSource === 'unavailable' ? 'unknown' : orientationSource,
      headingDatum: orientationDatum,
      headingAccuracy: orientationAccuracy,
      headingPolarity,
      twoReferenceVerified,
    }
    stage = 'result'
    status = 'Calibration is ready to apply.'
  }
</script>

<div class:aiming={stage === 'horizon' || stage === 'align' || stage === 'verify-first' || stage === 'verify-second'} class="calibration-layer" role="dialog" aria-modal="true" aria-labelledby="calibration-title">
  <div class="calibration-topbar">
    <div><span>Sensor alignment</span><h2 id="calibration-title">Calibration</h2></div>
    <button type="button" aria-label="Close calibration" onclick={onCancel}>×</button>
  </div>

  <div class="calibration-content">
    {#if stage === 'intro'}
      <p class="calibration-step">Optional accuracy setup</p>
      <h3>Fit SnapLock to how you hold your phone.</h3>
      <p>First align a visible horizon when available. Then keep automatic heading or improve it using whichever reference works where you are.</p>
      <div class="calibration-actions">
        <button class="secondary-action" type="button" onclick={onCancel}>Not now</button>
        <button class="primary-action" type="button" onclick={() => goTo('horizon')}>Begin</button>
      </div>
    {:else if stage === 'horizon'}
      <p class="calibration-step">Step 1 · Horizon</p>
      <h3>Align the line with the real horizon.</h3>
      <div class="horizon-target" aria-hidden="true"><span></span><i style={`transform: rotate(${-sensorReading.roll}deg)`}></i></div>
      <p>Keep the phone steady, then set the horizon. Skip when buildings, terrain, or indoor surroundings hide it.</p>
      <div class="calibration-actions">
        <button class="secondary-action" type="button" onclick={() => goTo('method')}>Skip horizon</button>
        <button class="primary-action" type="button" disabled={busy} onclick={setHorizon}>{busy ? 'Measuring…' : 'Set horizon'}</button>
      </div>
    {:else if stage === 'method'}
      <p class="calibration-step">Step 2 · Heading</p>
      <h3>Choose a reference that works here.</h3>
      <div class="method-grid">
        <button type="button" onclick={chooseAutomatic}><strong>Automatic</strong><span>Use corrected device compass</span></button>
        <button type="button" disabled={airborneTargets.length === 0} onclick={() => goTo('aircraft')}><strong>Aircraft</strong><span>{airborneTargets.length ? 'Align a visible tracked aircraft' : 'No airborne targets available'}</span></button>
        <button type="button" disabled={!moonTarget?.visible} onclick={() => goTo('moon')}><strong>Moon</strong><span>{moonTarget?.visible ? `${Math.round(moonTarget.altitude)}° high · ${cardinalDirection(moonTarget.azimuth)}` : 'Not visible right now'}</span></button>
        <button type="button" disabled={latitude === null || longitude === null} onclick={() => goTo('landmark')}><strong>Landmark map</strong><span>Select a visible distant place</span></button>
        <button type="button" onclick={() => goTo('known')}><strong>Known bearing</strong><span>Enter a trusted true direction</span></button>
        <button type="button" onclick={() => goTo('verify-entry')}><strong>Verify heading direction</strong><span>Use two references 60–120° apart</span></button>
      </div>
    {:else if stage === 'aircraft'}
      <p class="calibration-step">Aircraft reference</p>
      <h3>Choose the aircraft you can clearly see.</h3>
      <div class="target-list">
        {#each airborneTargets as position}
          <button type="button" onclick={() => chooseAircraft(position)}><strong>{position.callsign}</strong><span>{position.distance.toFixed(1)} nm · {Math.round(position.bearing)}° · {Math.round(position.elevation)}° high</span></button>
        {/each}
      </div>
      <button class="secondary-action" type="button" onclick={() => goTo('method')}>Back</button>
    {:else if stage === 'moon'}
      <p class="calibration-step">Moon reference</p>
      <h3>Use the Moon’s calculated position.</h3>
      {#if moonTarget}
        <dl class="target-facts"><div><dt>Direction</dt><dd>{Math.round(moonTarget.azimuth)}° {cardinalDirection(moonTarget.azimuth)}</dd></div><div><dt>Elevation</dt><dd>{Math.round(moonTarget.altitude)}°</dd></div></dl>
        {#if moonTarget.reason}<p class="calibration-warning">{moonTarget.reason}</p>{/if}
      {/if}
      <div class="calibration-actions"><button class="secondary-action" type="button" onclick={() => goTo('method')}>Back</button><button class="primary-action" type="button" disabled={!moonTarget?.visible} onclick={chooseMoon}>Aim at Moon</button></div>
    {:else if stage === 'landmark' && latitude !== null && longitude !== null && gpsAccuracy !== null}
      <p class="calibration-step">Landmark reference</p>
      <h3>Select the same distant object you can see.</h3>
      <LandmarkPicker userLatitude={latitude} userLongitude={longitude} gpsAccuracy={gpsAccuracy} onSelect={chooseLandmark} onCancel={() => goTo('method')} />
    {:else if stage === 'known'}
      <p class="calibration-step">Known true bearing</p>
      <h3>Enter the direction to a visible reference.</h3>
      <label class="bearing-input">True bearing<input type="number" min="0" max="359" step="1" bind:value={knownBearing} /><span>0° north · 90° east · 180° south · 270° west</span></label>
      <div class="calibration-actions"><button class="secondary-action" type="button" onclick={() => goTo('method')}>Back</button><button class="primary-action" type="button" onclick={chooseKnownBearing}>Aim at reference</button></div>
    {:else if stage === 'verify-entry'}
      <p class="calibration-step">Two-reference verification</p>
      <h3>Enter two visible true bearings.</h3>
      <p>Choose references separated by 60–120°. Opposite directions cannot reveal a reversed heading convention.</p>
      <div class="coordinate-grid">
        <label>First bearing<input type="number" min="0" max="359" step="1" bind:value={firstReferenceBearing} /></label>
        <label>Second bearing<input type="number" min="0" max="359" step="1" bind:value={secondReferenceBearing} /></label>
      </div>
      <div class="calibration-actions"><button class="secondary-action" type="button" onclick={() => goTo('method')}>Back</button><button class="primary-action" type="button" onclick={beginHeadingVerification}>Aim at first reference</button></div>
    {:else if stage === 'verify-first'}
      <p class="calibration-step">Reference 1 of 2</p>
      <h3>Center {firstReferenceBearing}° true.</h3>
      <div class="alignment-reticle" aria-hidden="true"><span></span><i></i></div>
      <div class="calibration-actions"><button class="secondary-action" type="button" onclick={() => goTo('verify-entry')}>Back</button><button class="primary-action" type="button" disabled={busy} onclick={captureFirstReference}>{busy ? 'Measuring…' : 'Lock first reference'}</button></div>
    {:else if stage === 'verify-second'}
      <p class="calibration-step">Reference 2 of 2</p>
      <h3>Center {secondReferenceBearing}° true.</h3>
      <div class="alignment-reticle" aria-hidden="true"><span></span><i></i></div>
      <div class="calibration-actions"><button class="secondary-action" type="button" onclick={() => goTo('verify-entry')}>Restart</button><button class="primary-action" type="button" disabled={busy} onclick={captureSecondReference}>{busy ? 'Measuring…' : 'Verify heading'}</button></div>
    {:else if stage === 'align' && target}
      <p class="calibration-step">Align reference</p>
      <h3>Center {target.label} in the reticle.</h3>
      <div class="alignment-reticle" aria-hidden="true"><span></span><i></i></div>
      <p>Direction {Math.round(target.bearing)}° true{target.refinePitch ? ` · ${Math.round(target.elevation)}° high` : ''}. Hold steady, then lock alignment.</p>
      <div class="calibration-actions"><button class="secondary-action" type="button" onclick={() => goTo('method')}>Back</button><button class="primary-action" type="button" disabled={busy} onclick={alignTarget}>{busy ? 'Measuring…' : 'Lock alignment'}</button></div>
    {:else if stage === 'result' && result}
      <p class="calibration-step">Complete</p>
      <h3>{result.quality === 'excellent' ? 'Excellent' : result.quality === 'good' ? 'Good' : 'Usable'} calibration</h3>
      <dl class="target-facts"><div><dt>Method</dt><dd>{result.method}</dd></div><div><dt>Heading adjustment</dt><dd>{result.headingOffset.toFixed(1)}°</dd></div><div><dt>Pitch adjustment</dt><dd>{result.pitchOffset.toFixed(1)}°</dd></div><div><dt>Heading model</dt><dd>{result.headingPolarity === -1 ? 'reversed' : 'normal'}{result.twoReferenceVerified ? ' · verified' : ' · unverified'}</dd></div></dl>
      <div class="calibration-actions"><button class="secondary-action" type="button" onclick={() => goTo('horizon')}>Retry</button><button class="primary-action" type="button" onclick={() => onComplete(result!)}>Apply calibration</button></div>
    {/if}
    {#if status}<p class="calibration-status" aria-live="polite">{status}</p>{/if}
  </div>
</div>
