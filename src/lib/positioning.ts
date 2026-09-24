export type PositioningAircraft = {
  icao24: string
  callsign: string
  latitude: number
  longitude: number
  altBaro: number | null
  altGeom: number | null
  groundSpeed: number | null
  track: number | null
  lastSeen: number
}

export type PositioningInput = {
  aircraft: PositioningAircraft[]
  user: {
    latitude: number
    longitude: number
    heading: number
    pitch: number
    roll?: number
    headingOffset?: number
    pitchOffset?: number
    rollOffset?: number
  }
  viewport: {
    width: number
    height: number
    horizontalFov: number
    verticalFov: number
  }
  now: number
}

export type AircraftPosition = {
  icao24: string
  callsign: string
  x: number
  y: number
  inFov: boolean
  bearing: number
  elevation: number
  distance: number
  horizontalOffset: number
  verticalOffset: number
  edgeX: number
  edgeY: number
  opacity: number
  size: number
}

export type PositioningOutput = {
  positions: AircraftPosition[]
  computedAt: number
}

const EARTH_RADIUS_NM = 3440.065
const FEET_PER_NM = 6076.12
const KNOTS_TO_NM_PER_MS = 1 / 3600

function toRadians(value: number) {
  return (value * Math.PI) / 180
}

function toDegrees(value: number) {
  return (value * 180) / Math.PI
}

export function normalizeAngle(angle: number) {
  return ((angle % 360) + 360) % 360
}

export function signedAngleDifference(target: number, reference: number) {
  return ((target - reference + 540) % 360) - 180
}

export function haversineDistance(
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
) {
  const latitudeDelta = toRadians(toLatitude - fromLatitude)
  const longitudeDelta = toRadians(toLongitude - fromLongitude)
  const fromLatitudeRadians = toRadians(fromLatitude)
  const toLatitudeRadians = toRadians(toLatitude)
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitudeRadians) * Math.cos(toLatitudeRadians) * Math.sin(longitudeDelta / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a))
}

export function bearingBetween(
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
) {
  const fromLatitudeRadians = toRadians(fromLatitude)
  const toLatitudeRadians = toRadians(toLatitude)
  const longitudeDelta = toRadians(toLongitude - fromLongitude)
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitudeRadians)
  const x = Math.cos(fromLatitudeRadians) * Math.sin(toLatitudeRadians)
    - Math.sin(fromLatitudeRadians) * Math.cos(toLatitudeRadians) * Math.cos(longitudeDelta)
  return normalizeAngle(toDegrees(Math.atan2(y, x)))
}

function deadReckon(aircraft: PositioningAircraft, now: number) {
  if (aircraft.groundSpeed === null || aircraft.track === null || now <= aircraft.lastSeen) {
    return { latitude: aircraft.latitude, longitude: aircraft.longitude }
  }

  const elapsedSeconds = Math.min(30, (now - aircraft.lastSeen) / 1000)
  const distanceNm = aircraft.groundSpeed * KNOTS_TO_NM_PER_MS * elapsedSeconds
  const angularDistance = distanceNm / EARTH_RADIUS_NM
  const bearing = toRadians(aircraft.track)
  const latitude = toRadians(aircraft.latitude)
  const longitude = toRadians(aircraft.longitude)
  const nextLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance)
      + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  )
  const nextLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(nextLatitude),
  )

  return {
    latitude: toDegrees(nextLatitude),
    longitude: toDegrees(nextLongitude),
  }
}

function elevationAngle(distanceNm: number, altitudeFeet: number) {
  const altitudeNm = Math.max(0, altitudeFeet) / FEET_PER_NM
  return toDegrees(Math.atan2(altitudeNm, Math.max(distanceNm, 0.001)))
}

function clampToEdge(x: number, y: number, width: number, height: number) {
  const centerX = width / 2
  const centerY = height / 2
  const dx = x - centerX
  const dy = y - centerY
  const scale = Math.max(Math.abs(dx) / Math.max(centerX - 18, 1), Math.abs(dy) / Math.max(centerY - 18, 1), 1)
  return {
    x: centerX + dx / scale,
    y: centerY + dy / scale,
  }
}

export function calculatePositions(input: PositioningInput): PositioningOutput {
  const { user, viewport, now } = input
  const calibratedHeading = normalizeAngle(user.heading + (user.headingOffset ?? 0))
  const cameraElevation = 90 - user.pitch + (user.pitchOffset ?? 0)
  const rollRadians = -((user.roll ?? 0) + (user.rollOffset ?? 0)) * Math.PI / 180
  const positions = input.aircraft
    .filter((aircraft) => (aircraft.altBaro ?? aircraft.altGeom ?? 0) > 0)
    .map((aircraft) => {
      const current = deadReckon(aircraft, now)
      const distance = haversineDistance(user.latitude, user.longitude, current.latitude, current.longitude)
      const bearing = bearingBetween(user.latitude, user.longitude, current.latitude, current.longitude)
      const altitude = aircraft.altBaro ?? aircraft.altGeom ?? 0
      const elevation = elevationAngle(distance, altitude)
      const horizontalOffset = signedAngleDifference(bearing, calibratedHeading)
      const verticalOffset = elevation - cameraElevation
      const projectedX = horizontalOffset / viewport.horizontalFov * viewport.width
      const projectedY = -verticalOffset / viewport.verticalFov * viewport.height
      const x = viewport.width / 2 + projectedX * Math.cos(rollRadians) - projectedY * Math.sin(rollRadians)
      const y = viewport.height / 2 + projectedX * Math.sin(rollRadians) + projectedY * Math.cos(rollRadians)
      const inFov = x >= 0 && x <= viewport.width && y >= 0 && y <= viewport.height
      const edge = clampToEdge(x, y, viewport.width, viewport.height)
      const distanceScale = Math.max(0.55, Math.min(1, 1 - distance / 100))

      return {
        icao24: aircraft.icao24,
        callsign: aircraft.callsign,
        x,
        y,
        inFov,
        bearing,
        elevation,
        distance,
        horizontalOffset,
        verticalOffset,
        edgeX: edge.x,
        edgeY: edge.y,
        opacity: distanceScale,
        size: 24 + 20 * distanceScale,
      }
    })

  return { positions, computedAt: now }
}
