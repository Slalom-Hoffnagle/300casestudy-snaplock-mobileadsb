type Query = Record<string, string | string[] | undefined>

type VercelRequest = { method?: string; query?: Query }
type VercelResponse = {
  status: (code: number) => VercelResponse
  setHeader: (name: string, value: string) => VercelResponse
  send: (body: string) => void
}

type CacheEntry = { elevation: number; expiresAt: number }

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const UPSTREAM_TIMEOUT_MS = 8000

function queryValue(query: Query, key: string) {
  const value = query[key]
  return Array.isArray(value) ? value[0] : value
}

function parseCoordinate(value: string | undefined, min: number, max: number) {
  if (!value || !/^-?\d+(\.\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null
}

function respond(res: VercelResponse, status: number, body: unknown, cacheable = false) {
  res
    .status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .setHeader('Cache-Control', cacheable ? 'public, s-maxage=86400, stale-while-revalidate=604800' : 'no-store')
    .send(JSON.stringify(body))
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    respond(res, 405, { error: 'Only GET is supported.' })
    return
  }

  const latitude = parseCoordinate(queryValue(req.query ?? {}, 'lat'), -90, 90)
  const longitude = parseCoordinate(queryValue(req.query ?? {}, 'lon'), -180, 180)
  if (latitude === null || longitude === null) {
    respond(res, 400, { error: 'lat and lon are invalid.' })
    return
  }

  const roundedLatitude = Number(latitude.toFixed(3))
  const roundedLongitude = Number(longitude.toFixed(3))
  const key = `${roundedLatitude}:${roundedLongitude}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    respond(res, 200, { elevation: cached.elevation, latitude: roundedLatitude, longitude: roundedLongitude, source: 'copernicus-glo90' }, true)
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const params = new URLSearchParams({ latitude: String(roundedLatitude), longitude: String(roundedLongitude) })
    const upstream = await fetch(`https://api.open-meteo.com/v1/elevation?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!upstream.ok) {
      respond(res, upstream.status, { error: `Elevation service returned HTTP ${upstream.status}.` })
      return
    }
    const payload = await upstream.json() as { elevation?: unknown }
    const elevation = Array.isArray(payload.elevation) ? payload.elevation[0] : null
    if (typeof elevation !== 'number' || !Number.isFinite(elevation)) {
      respond(res, 502, { error: 'Elevation service returned invalid data.' })
      return
    }
    cache.set(key, { elevation, expiresAt: Date.now() + CACHE_TTL_MS })
    respond(res, 200, { elevation, latitude: roundedLatitude, longitude: roundedLongitude, source: 'copernicus-glo90' }, true)
  } catch (error) {
    const message = error instanceof DOMException && error.name === 'AbortError'
      ? 'Elevation service timed out.'
      : 'Elevation service is unavailable.'
    respond(res, 503, { error: message })
  } finally {
    clearTimeout(timeout)
  }
}
