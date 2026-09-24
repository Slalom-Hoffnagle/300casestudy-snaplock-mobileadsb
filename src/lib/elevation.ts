export type AltitudeDatum = 'wgs84-ellipsoid' | 'msl' | 'pressure' | 'unknown'
export type AltitudeConfidence = 'high' | 'medium' | 'low' | 'unavailable'
export type ObserverElevationSource = 'gps' | 'terrain' | 'manual' | 'unavailable'
export type AircraftAltitudeSource = 'geometric' | 'barometric' | 'unavailable'

export type ObserverElevation = {
  meters: number | null
  datum: AltitudeDatum
  source: ObserverElevationSource
  confidence: AltitudeConfidence
  accuracyMeters: number | null
  timestamp: number
}

export type AircraftAltitudeInput = {
  altGeomFeet: number | null
  altBaroFeet: number | null
}

export type SelectedAircraftAltitude = {
  meters: number | null
  datum: AltitudeDatum
  source: AircraftAltitudeSource
  confidence: AltitudeConfidence
  accuracyMeters: number | null
}

export type ElevationSolution = {
  geometricDegrees: number | null
  apparentDegrees: number | null
  uncertaintyDegrees: number | null
  nearHorizon: boolean
  confidence: AltitudeConfidence
}

const FEET_TO_METERS = 0.3048
const EARTH_RADIUS_METERS = 6_371_008.8
const STANDARD_REFRACTION_COEFFICIENT = 0.13
const MAX_GPS_ALTITUDE_AGE_MS = 10_000

export const UNAVAILABLE_OBSERVER_ELEVATION: ObserverElevation = {
  meters: null,
  datum: 'unknown',
  source: 'unavailable',
  confidence: 'unavailable',
  accuracyMeters: null,
  timestamp: 0,
}

export function gpsAltitudeConfidence(altitude: number | null, accuracyMeters: number | null): AltitudeConfidence {
  if (altitude === null || !Number.isFinite(altitude)) return 'unavailable'
  if (accuracyMeters !== null && accuracyMeters <= 20) return 'high'
  if (accuracyMeters !== null && accuracyMeters <= 40) return 'medium'
  return 'low'
}

export function resolveObserverElevation(options: {
  manualMeters?: number | null
  gpsMeters?: number | null
  gpsAccuracyMeters?: number | null
  gpsTimestamp?: number
  terrainMeters?: number | null
  terrainTimestamp?: number
  now?: number
}): ObserverElevation {
  const now = options.now ?? Date.now()
  if (options.manualMeters !== null && options.manualMeters !== undefined && Number.isFinite(options.manualMeters)) {
    return { meters: options.manualMeters, datum: 'msl', source: 'manual', confidence: 'high', accuracyMeters: 5, timestamp: now }
  }

  const gpsConfidence = gpsAltitudeConfidence(options.gpsMeters ?? null, options.gpsAccuracyMeters ?? null)
  const gpsFresh = options.gpsTimestamp !== undefined && now - options.gpsTimestamp <= MAX_GPS_ALTITUDE_AGE_MS
  if (gpsFresh && (gpsConfidence === 'high' || gpsConfidence === 'medium')) {
    return {
      meters: options.gpsMeters ?? null,
      datum: 'wgs84-ellipsoid',
      source: 'gps',
      confidence: gpsConfidence,
      accuracyMeters: options.gpsAccuracyMeters ?? null,
      timestamp: options.gpsTimestamp ?? now,
    }
  }

  if (options.terrainMeters !== null && options.terrainMeters !== undefined && Number.isFinite(options.terrainMeters)) {
    return {
      meters: options.terrainMeters,
      datum: 'msl',
      source: 'terrain',
      confidence: 'medium',
      accuracyMeters: 30,
      timestamp: options.terrainTimestamp ?? now,
    }
  }

  return UNAVAILABLE_OBSERVER_ELEVATION
}

function validAircraftAltitude(feet: number | null) {
  return feet !== null && Number.isFinite(feet) && feet >= -2_000 && feet <= 100_000
}

export function selectAircraftAltitude(
  aircraft: AircraftAltitudeInput,
  observer: ObserverElevation,
): SelectedAircraftAltitude {
  if (observer.datum === 'wgs84-ellipsoid' && validAircraftAltitude(aircraft.altGeomFeet)) {
    return {
      meters: aircraft.altGeomFeet! * FEET_TO_METERS,
      datum: 'wgs84-ellipsoid',
      source: 'geometric',
      confidence: 'high',
      accuracyMeters: 15,
    }
  }
  if (observer.datum === 'msl' && validAircraftAltitude(aircraft.altBaroFeet)) {
    return {
      meters: aircraft.altBaroFeet! * FEET_TO_METERS,
      datum: 'pressure',
      source: 'barometric',
      confidence: 'medium',
      accuracyMeters: 40,
    }
  }
  if (validAircraftAltitude(aircraft.altGeomFeet)) {
    return {
      meters: aircraft.altGeomFeet! * FEET_TO_METERS,
      datum: 'wgs84-ellipsoid',
      source: 'geometric',
      confidence: 'low',
      accuracyMeters: 60,
    }
  }
  if (validAircraftAltitude(aircraft.altBaroFeet)) {
    return {
      meters: aircraft.altBaroFeet! * FEET_TO_METERS,
      datum: 'pressure',
      source: 'barometric',
      confidence: 'low',
      accuracyMeters: 75,
    }
  }
  return { meters: null, datum: 'unknown', source: 'unavailable', confidence: 'unavailable', accuracyMeters: null }
}

export function sphericalElevationDegrees(
  surfaceDistanceMeters: number,
  observerHeightMeters: number,
  targetHeightMeters: number,
  refractionCoefficient = 0,
) {
  const distance = Math.max(0, surfaceDistanceMeters)
  if (distance < 0.01) return Math.atan2(targetHeightMeters - observerHeightMeters, 0.01) * 180 / Math.PI
  const effectiveRadius = EARTH_RADIUS_METERS / (1 - refractionCoefficient)
  const centralAngle = distance / effectiveRadius
  const upward = (effectiveRadius + targetHeightMeters) * Math.cos(centralAngle)
    - (effectiveRadius + observerHeightMeters)
  const forward = (effectiveRadius + targetHeightMeters) * Math.sin(centralAngle)
  return Math.atan2(upward, forward) * 180 / Math.PI
}

export function solveElevation(
  surfaceDistanceMeters: number,
  observer: ObserverElevation,
  target: SelectedAircraftAltitude,
): ElevationSolution {
  if (observer.meters === null || target.meters === null) {
    return { geometricDegrees: null, apparentDegrees: null, uncertaintyDegrees: null, nearHorizon: true, confidence: 'unavailable' }
  }
  const geometricDegrees = sphericalElevationDegrees(surfaceDistanceMeters, observer.meters, target.meters)
  const apparentDegrees = sphericalElevationDegrees(
    surfaceDistanceMeters,
    observer.meters,
    target.meters,
    STANDARD_REFRACTION_COEFFICIENT,
  )
  const combinedAccuracy = Math.hypot(observer.accuracyMeters ?? 75, target.accuracyMeters ?? 75)
  const altitudeUncertainty = Math.atan2(combinedAccuracy, Math.max(surfaceDistanceMeters, 1)) * 180 / Math.PI
  const atmosphericUncertainty = Math.abs(apparentDegrees) < 2 ? 0.35 : 0.1
  const uncertaintyDegrees = altitudeUncertainty + atmosphericUncertainty
  const nearHorizon = Math.abs(apparentDegrees) <= Math.max(2, uncertaintyDegrees)
  const confidence: AltitudeConfidence = observer.confidence === 'low' || target.confidence === 'low'
    ? 'low'
    : observer.confidence === 'high' && target.confidence === 'high' && uncertaintyDegrees <= 1
      ? 'high'
      : 'medium'
  return { geometricDegrees, apparentDegrees, uncertaintyDegrees, nearHorizon, confidence }
}
