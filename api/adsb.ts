type Query = Record<string, string | string[] | undefined>

type VercelRequest = {
  method?: string
  query?: Query
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  setHeader: (name: string, value: string) => VercelResponse
  send: (body: string) => void
}

type CacheEntry = {
  expiresAt: number
  body: string
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 2500
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

function parseRadius(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 250 ? parsed : null
}

function respond(res: VercelResponse, status: number, body: string) {
  res
    .status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .send(body)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    respond(res, 405, JSON.stringify({ error: 'Only GET is supported.' }))
    return
  }

  const lat = parseCoordinate(queryValue(req.query ?? {}, 'lat'), -90, 90)
  const lon = parseCoordinate(queryValue(req.query ?? {}, 'lon'), -180, 180)
  const dist = parseRadius(queryValue(req.query ?? {}, 'dist'))
  if (lat === null || lon === null || dist === null) {
    respond(res, 400, JSON.stringify({ error: 'lat, lon, and dist are invalid.' }))
    return
  }

  const key = `${lat.toFixed(4)}:${lon.toFixed(4)}:${dist}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    respond(res, 200, cached.body)
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const upstream = await fetch(`https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    const body = await upstream.text()
    if (upstream.ok) cache.set(key, { body, expiresAt: Date.now() + CACHE_TTL_MS })
    respond(res, upstream.status, body)
  } catch (error) {
    const message = error instanceof DOMException && error.name === 'AbortError'
      ? 'ADS-B service timed out.'
      : 'ADS-B service is unavailable.'
    respond(res, 503, JSON.stringify({ error: message }))
  } finally {
    clearTimeout(timeout)
  }
}