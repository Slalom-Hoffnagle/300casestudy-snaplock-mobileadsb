import { afterEach, describe, expect, it, vi } from 'vitest'
import handler from './elevation.js'

function responseRecorder() {
  const record = { status: 0, headers: new Map<string, string>(), body: '' }
  const response = {
    status(code: number) { record.status = code; return response },
    setHeader(name: string, value: string) { record.headers.set(name, value); return response },
    send(body: string) { record.body = body },
  }
  return { record, response }
}

afterEach(() => vi.restoreAllMocks())

describe('elevation proxy', () => {
  it('rejects malformed coordinates without an upstream request', async () => {
    const { record, response } = responseRecorder()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await handler({ method: 'GET', query: { lat: '999', lon: '-122' } }, response)
    expect(record.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns and caches a validated Copernicus elevation response', async () => {
    const { record, response } = responseRecorder()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ elevation: [132] }), { status: 200 })))
    await handler({ method: 'GET', query: { lat: '47.6014', lon: '-122.3014' } }, response)
    expect(record.status).toBe(200)
    expect(JSON.parse(record.body)).toMatchObject({ elevation: 132, source: 'copernicus-glo90' })
    expect(record.headers.get('Cache-Control')).toContain('s-maxage=86400')
  })
})
