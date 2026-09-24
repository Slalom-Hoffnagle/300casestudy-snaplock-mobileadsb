export type TerrainElevationFix = {
  elevation: number
  latitude: number
  longitude: number
  source: 'copernicus-glo90'
  timestamp: number
}

const STORAGE_KEY = 'snaplock-terrain-elevation'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
let inFlight: { key: string; promise: Promise<TerrainElevationFix> } | null = null

function cellKey(latitude: number, longitude: number) {
  return `${latitude.toFixed(3)}:${longitude.toFixed(3)}`
}

export function loadTerrainElevation(latitude: number, longitude: number, now = Date.now()) {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    const parsed = JSON.parse(stored) as TerrainElevationFix
    if (parsed.source !== 'copernicus-glo90' || !Number.isFinite(parsed.elevation) || now - parsed.timestamp > CACHE_TTL_MS) return null
    return cellKey(parsed.latitude, parsed.longitude) === cellKey(latitude, longitude) ? parsed : null
  } catch {
    return null
  }
}

export function fetchTerrainElevation(latitude: number, longitude: number, signal?: AbortSignal) {
  const key = cellKey(latitude, longitude)
  const cached = loadTerrainElevation(latitude, longitude)
  if (cached) return Promise.resolve(cached)
  if (inFlight?.key === key) return inFlight.promise

  const params = new URLSearchParams({ lat: latitude.toFixed(3), lon: longitude.toFixed(3) })
  const promise = fetch(`/api/elevation?${params}`, { signal })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Elevation service returned HTTP ${response.status}.`)
      const payload = await response.json() as { elevation?: number | number[]; latitude?: number; longitude?: number }
      const elevation = Array.isArray(payload.elevation) ? payload.elevation[0] : payload.elevation
      const resolvedLatitude = typeof payload.latitude === 'number' ? payload.latitude : Number(latitude.toFixed(3))
      const resolvedLongitude = typeof payload.longitude === 'number' ? payload.longitude : Number(longitude.toFixed(3))
      if (typeof elevation !== 'number' || !Number.isFinite(elevation)) {
        throw new Error('Elevation service returned invalid data.')
      }
      const fix: TerrainElevationFix = {
        elevation,
        latitude: resolvedLatitude,
        longitude: resolvedLongitude,
        source: 'copernicus-glo90',
        timestamp: Date.now(),
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fix))
      return fix
    })
    .finally(() => {
      if (inFlight?.key === key) inFlight = null
    })
  inFlight = { key, promise }
  return promise
}
