import { haversineDistance, signedAngleDifference } from './positioning'

export type CalibrationMethod = 'automatic' | 'horizon' | 'aircraft' | 'moon' | 'landmark' | 'known-bearing'
export type CalibrationQuality = 'uncalibrated' | 'automatic' | 'fair' | 'good' | 'excellent' | 'stale'

export type SensorCalibration = {
  version: 2
  headingOffset: number
  pitchOffset: number
  rollOffset: number
  method: CalibrationMethod
  quality: CalibrationQuality
  calibratedAt: number
  latitude: number | null
  longitude: number | null
  headingDeviation: number | null
  pitchDeviation: number | null
}

export type OrientationSample = {
  heading: number
  pitch: number
  roll: number
}

export type CalibrationCapture = {
  headingOffset: number
  pitchOffset: number
  rollOffset: number
  headingDeviation: number
  pitchDeviation: number
  stable: boolean
}

export type LandmarkValidation = {
  valid: boolean
  warning: string | null
  distanceNm: number
  confidence: 'low' | 'medium' | 'high'
}

export const CALIBRATION_STORAGE_KEY = 'snaplock-calibration'
export const CALIBRATION_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const DEFAULT_CALIBRATION: SensorCalibration = {
  version: 2,
  headingOffset: 0,
  pitchOffset: 0,
  rollOffset: 0,
  method: 'automatic',
  quality: 'uncalibrated',
  calibratedAt: 0,
  latitude: null,
  longitude: null,
  headingDeviation: null,
  pitchDeviation: null,
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function standardDeviation(values: number[]) {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const average = mean(values)
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
}

function circularMean(values: number[]) {
  const radians = values.map((value) => value * Math.PI / 180)
  const x = mean(radians.map(Math.cos))
  const y = mean(radians.map(Math.sin))
  return ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360
}

function circularDeviation(values: number[]) {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const average = circularMean(values)
  return standardDeviation(values.map((value) => signedAngleDifference(value, average)))
}

export function captureHorizon(samples: OrientationSample[]): CalibrationCapture {
  if (samples.length < 10) return { headingOffset: 0, pitchOffset: 0, rollOffset: 0, headingDeviation: Infinity, pitchDeviation: Infinity, stable: false }
  const cameraElevations = samples.map((sample) => sample.pitch)
  const rolls = samples.map((sample) => sample.roll)
  const headingDeviation = circularDeviation(samples.map((sample) => sample.heading))
  const pitchDeviation = standardDeviation(cameraElevations)
  const rollDeviation = standardDeviation(rolls)
  const stable = pitchDeviation <= 2 && rollDeviation <= 3
  return {
    headingOffset: 0,
    pitchOffset: stable ? -mean(cameraElevations) : 0,
    rollOffset: stable ? -mean(rolls) : 0,
    headingDeviation,
    pitchDeviation: Math.max(pitchDeviation, rollDeviation),
    stable,
  }
}

export function captureTarget(
  samples: OrientationSample[],
  targetBearing: number,
  targetElevation: number,
): CalibrationCapture {
  if (samples.length < 10) return { headingOffset: 0, pitchOffset: 0, rollOffset: 0, headingDeviation: Infinity, pitchDeviation: Infinity, stable: false }
  const headings = samples.map((sample) => sample.heading)
  const cameraElevations = samples.map((sample) => sample.pitch)
  const headingDeviation = circularDeviation(headings)
  const pitchDeviation = standardDeviation(cameraElevations)
  const stable = headingDeviation <= 3 && pitchDeviation <= 2
  const measuredHeading = circularMean(headings)
  return {
    headingOffset: stable ? signedAngleDifference(targetBearing, measuredHeading) : 0,
    pitchOffset: stable ? targetElevation - mean(cameraElevations) : 0,
    rollOffset: 0,
    headingDeviation,
    pitchDeviation,
    stable,
  }
}

export function scoreCapture(capture: CalibrationCapture): CalibrationQuality {
  if (!capture.stable) return 'fair'
  const worstDeviation = Math.max(capture.headingDeviation, capture.pitchDeviation)
  if (worstDeviation <= 0.8) return 'excellent'
  if (worstDeviation <= 1.8) return 'good'
  return 'fair'
}

export function validateLandmark(
  userLatitude: number,
  userLongitude: number,
  gpsAccuracyMeters: number,
  landmarkLatitude: number,
  landmarkLongitude: number,
): LandmarkValidation {
  const distanceNm = haversineDistance(userLatitude, userLongitude, landmarkLatitude, landmarkLongitude)
  if (distanceNm < 0.5) return { valid: false, warning: 'Choose a landmark at least 0.5 nautical miles away.', distanceNm, confidence: 'low' }
  if (distanceNm > 50) return { valid: false, warning: 'Choose a landmark within 50 nautical miles.', distanceNm, confidence: 'low' }
  if (gpsAccuracyMeters > 150) return { valid: false, warning: 'Wait for GPS accuracy better than 150 meters.', distanceNm, confidence: 'low' }
  if (gpsAccuracyMeters > 50) return { valid: true, warning: 'GPS accuracy may reduce calibration precision.', distanceNm, confidence: 'medium' }
  return { valid: true, warning: null, distanceNm, confidence: distanceNm >= 2 ? 'high' : 'medium' }
}

export function parseCalibration(value: string | null): SensorCalibration | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<SensorCalibration>
    if (parsed.version !== 2 || typeof parsed.headingOffset !== 'number' || typeof parsed.pitchOffset !== 'number' || typeof parsed.rollOffset !== 'number') return null
    if (!Number.isFinite(parsed.headingOffset) || !Number.isFinite(parsed.pitchOffset) || !Number.isFinite(parsed.rollOffset)) return null
    if (Math.abs(parsed.headingOffset) > 45 || Math.abs(parsed.pitchOffset) > 45 || Math.abs(parsed.rollOffset) > 45) return null
    return { ...DEFAULT_CALIBRATION, ...parsed }
  } catch {
    return null
  }
}

export function calibrationIsStale(calibration: SensorCalibration, now = Date.now()) {
  return calibration.calibratedAt > 0 && now - calibration.calibratedAt > CALIBRATION_MAX_AGE_MS
}
