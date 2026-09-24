export type Aircraft = {
  icao24: string
  callsign: string
  latitude: number
  longitude: number
  altBaro: number | null
  altGeom: number | null
  onGround: boolean
  groundSpeed: number | null
  track: number | null
  type: string | null
  registration: string | null
  description: string | null
  origin: string | null
  destination: string | null
  lastSeen: number
}

export type AdsbResponse = {
  ac?: Record<string, unknown>[]
  now?: number
}

export class AdsbError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'AdsbError'
    this.status = status
  }
}

const API_BASE = '/api/adsb'

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseAircraft(record: Record<string, unknown>, timestamp: number): Aircraft | null {
  const icao24 = stringOrNull(record.hex)
  const latitude = numberOrNull(record.lat)
  const longitude = numberOrNull(record.lon)

  if (!icao24 || latitude === null || longitude === null) return null

  const onGround = record.alt_baro === 'ground' || record.ground === true
  const altBaro = numberOrNull(record.alt_baro)
  return {
    icao24: icao24.toLowerCase(),
    callsign: stringOrNull(record.flight) ?? icao24.toUpperCase(),
    latitude,
    longitude,
    altBaro,
    altGeom: numberOrNull(record.alt_geom),
    onGround,
    groundSpeed: numberOrNull(record.gs),
    track: numberOrNull(record.track),
    type: stringOrNull(record.t),
    registration: stringOrNull(record.r),
    description: stringOrNull(record.desc),
    origin: stringOrNull(record.orig),
    destination: stringOrNull(record.dest),
    lastSeen: timestamp,
  }
}

export async function fetchNearbyAircraft(
  latitude: number,
  longitude: number,
  radiusNm: number,
  signal?: AbortSignal,
) {
  const radius = Math.min(250, Math.max(1, Math.round(radiusNm)))
  const params = new URLSearchParams({
    lat: latitude.toFixed(4),
    lon: longitude.toFixed(4),
    dist: String(radius),
  })
  const endpoint = `${API_BASE}?${params}`
  const response = await fetch(endpoint, { signal })

  if (!response.ok) {
    throw new AdsbError(
      response.status === 429 ? 'ADS-B rate limit reached. Retrying shortly.' : `ADS-B service returned HTTP ${response.status}.`,
      response.status,
    )
  }

  let payload: AdsbResponse
  try {
    payload = await response.json() as AdsbResponse
  } catch {
    throw new AdsbError('ADS-B service returned invalid data.')
  }

  const timestamp = Date.now()
  const aircraft = (Array.isArray(payload.ac) ? payload.ac : [])
    .map((record) => parseAircraft(record, timestamp))
    .filter((record): record is Aircraft => record !== null)

  return aircraft
}
