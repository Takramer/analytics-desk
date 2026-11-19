// analytics-desk: one Cloudflare Worker. Files in public/ are served as they are; every /api route runs here.
//   POST /api/login {password}   POST /api/logout   GET /api/session
//   GET /api/setup               GET /api/report?days=7|30|90[&fresh]   POST /api/insights {days, fresh}

import { buildReport, siteInfo, sourceStatus } from './sources.js'
import { readInsights } from './ai.js'

const COOKIE = 'desk_session'
const SESSION_DAYS = 30
const RANGES = [7, 30, 90]
const REPORT_TTL = 600 // seconds. Umami allows 50 calls per 15 s; search data runs a day or two behind anyway.
const INSIGHTS_TTL = 86400 // one AI read per range per day unless you ask for a fresh one

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx, new URL(req.url))
    } catch (e) {
      if (!e.status) console.error(e)
      return json({ error: e.status ? e.message : 'Server error' }, e.status || 500)
    }
  },
}

async function route(req, env, ctx, url) {
  const m = req.method
  const path = url.pathname
  if (!path.startsWith('/api/')) fail(404, 'Not found')
  if (m === 'POST' && !(req.headers.get('content-type') || '').includes('application/json')) fail(415, 'JSON only')

  if (path === '/api/login' && m === 'POST') return login(req, env)
  if (path === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) })
  if (path === '/api/session' && m === 'GET') {
    const ok = await signedIn(req, env)
    // Signed out, the page only learns the site's name; the goal and URL stay behind the password.
    return json({ signedIn: ok, passwordSet: passwordOk(env), site: ok ? siteInfo(env) : { name: env.SITE_NAME || '' } })
  }

  if (!(await signedIn(req, env))) fail(401, 'Sign in first')

  if (path === '/api/setup' && m === 'GET') return json(sourceStatus(env))
  if (path === '/api/report' && m === 'GET') {
    const days = range(url.searchParams.get('days'))
    return json(await report(req, env, ctx, days, url.searchParams.has('fresh')))
  }
  if (path === '/api/insights' && m === 'POST') {
    const body = await req.json()
    const days = range(body.days)
    const day = new Date().toISOString().slice(0, 10)
    return json(await cached(req, ctx, `insights-${days}-${day}`, INSIGHTS_TTL, !!body.fresh, async () =>
      readInsights(env, await report(req, env, ctx, days, false))))
  }
  fail(404, 'Not found')
}

const report = (req, env, ctx, days, fresh) =>
  cached(req, ctx, `report-${days}`, REPORT_TTL, fresh, () => buildReport(env, days))

function range(v) {
  const days = Number(v || 30)
  return RANGES.includes(days) ? days : fail(400, `days must be one of ${RANGES.join(', ')}`)
}

// Results sit in this zone's edge cache under a path the Worker itself answers with 404,
// so only this code can read them back. On workers.dev the cache is a no-op and every load is live.
async function cached(req, ctx, key, ttl, fresh, make) {
  const keyReq = new Request(new URL(`/__cache/${key}`, req.url))
  const cache = caches.default
  if (!fresh) {
    const hit = await cache.match(keyReq)
    if (hit) return hit.json()
  }
  const value = await make()
  ctx.waitUntil(cache.put(keyReq, new Response(JSON.stringify(value), { headers: { 'cache-control': `max-age=${ttl}` } })))
  return value
}

// ---- auth: one password (DASHBOARD_PASSWORD) and an HMAC-signed cookie. Changing the password signs everyone out.
// ponytail: the rate limiter counts per Cloudflare location (5 tries a minute); a 15+ character password is what
// actually stops guessing. Add a D1 table of failed tries if you ever want a hard lockout.

const passwordOk = (env) => (env.DASHBOARD_PASSWORD || '').length >= 15

async function login(req, env) {
  if (!passwordOk(env)) fail(500, 'DASHBOARD_PASSWORD is missing or shorter than 15 characters. See the setup guide.')
  const ip = req.headers.get('cf-connecting-ip') || 'local'
  if (env.LOGIN_LIMIT && !(await env.LOGIN_LIMIT.limit({ key: `login:${ip}` })).success) fail(429, 'Too many tries. Wait a minute.')
  const { password } = await req.json()
  if (!(await sameSecret(String(password || ''), env.DASHBOARD_PASSWORD))) fail(401, 'Wrong password')
  const exp = String(Date.now() + SESSION_DAYS * 864e5)
  return json({ signedIn: true }, 200, { 'set-cookie': cookie(`${exp}.${await sign(env, exp)}`, SESSION_DAYS * 86400) })
}

const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`

export async function signedIn(req, env) {
  if (!passwordOk(env)) return false
  const v = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`))
  if (!v || Number(v[1]) < Date.now()) return false
  return crypto.subtle.verify('HMAC', await hmacKey(env), fromHex(v[2]), new TextEncoder().encode(v[1]))
}

const hmacKey = async (env) =>
  crypto.subtle.importKey('raw', await sha256('analytics-desk-session:' + env.DASHBOARD_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])

const sign = async (env, data) => toHex(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(data)))

// Compare digests so length and content both stay hidden; XOR-accumulate so the loop never exits early.
async function sameSecret(a, b) {
  const [x, y] = (await Promise.all([sha256(a), sha256(b)])).map((d) => new Uint8Array(d))
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

// ---- helpers

const sha256 = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)))

function fail(status, message) {
  throw Object.assign(new Error(message), { status })
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff', ...headers },
  })
}
