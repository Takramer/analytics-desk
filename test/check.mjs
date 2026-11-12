// One self-check for the logic that matters: auth, the date window, and the parsers that turn API replies into numbers.
// Run: node test/check.mjs   (no network, no keys, no framework)

import assert from 'node:assert/strict'

// The Worker reads caches.default; Node has none, so stand in a no-op cache.
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } }

const { default: worker } = await import('../src/index.js')
const { timeWindow, bingTime, rollup, umamiTotals, buildReport, cloudflareShape } = await import('../src/sources.js')
const { aiChoice, readInsights, tidy } = await import('../src/ai.js')

const env = { DASHBOARD_PASSWORD: 'correct horse battery staple' }
const ctx = { waitUntil: () => {} }
const call = (path, init = {}) => worker.fetch(new Request(`https://desk.test${path}`, init), env, ctx)
const post = (path, body, headers = {}) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

// ---- auth
assert.equal((await call('/api/report')).status, 401, 'report needs a session')
assert.equal((await post('/api/login', { password: 'wrong password, long enough' })).status, 401)
assert.equal((await call('/api/login', { method: 'POST', body: 'password=x' })).status, 415, 'form posts are refused (CSRF guard)')

const login = await post('/api/login', { password: env.DASHBOARD_PASSWORD })
assert.equal(login.status, 200)
const setCookie = login.headers.get('set-cookie')
assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/)
const cookie = setCookie.split(';')[0]

const session = await (await call('/api/session', { headers: { cookie } })).json()
assert.equal(session.signedIn, true)
const forged = cookie.replace(/\.[0-9a-f]{64}$/, '.' + '0'.repeat(64))
assert.equal((await (await call('/api/session', { headers: { cookie: forged } })).json()).signedIn, false, 'forged signature rejected')
const expired = cookie.replace(/=\d+\./, '=1000.')
assert.equal((await (await call('/api/session', { headers: { cookie: expired } })).json()).signedIn, false, 'expired or edited cookie rejected')

const signedOut = await (await call('/api/session')).json()
assert.deepEqual(Object.keys(signedOut.site), ['name'], 'signed out, only the site name is shown')

// A short password never unlocks anything.
const weak = { DASHBOARD_PASSWORD: 'short' }
assert.equal((await worker.fetch(new Request('https://desk.test/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"short"}' }), weak, ctx)).status, 500)

// ---- report with no keys: every source "off", nothing thrown
const report = await (await call('/api/report?days=7', { headers: { cookie } })).json()
assert.deepEqual(Object.values(report.sources).map((s) => s.status), ['off', 'off', 'off', 'off'])
assert.equal((await call('/api/report?days=12', { headers: { cookie } })).status, 400, 'only 7, 30 or 90 days')
assert.equal((await post('/api/insights', { days: 7 }, { cookie })).status, 400, 'AI read says the key is missing')
assert.equal((await call('/anything')).status, 404)

// ---- the date window
const now = Date.UTC(2026, 10, 12, 15) // 12 Nov 2026, 15:00 UTC
const w = timeWindow(7, now, 'America/New_York')
assert.equal(w.end, '2026-11-12')
assert.equal(w.start, '2026-11-05')
assert.equal(w.dates.length, 7)
assert.equal(w.dates.at(-1), '2026-11-12')
assert.equal(w.prevEnd, '2026-11-04')
assert.equal(w.prevStart, '2026-10-29')
const late = timeWindow(1, Date.UTC(2026, 10, 13, 2), 'America/New_York') // 9 pm on the 12th in New York
assert.equal(late.end, '2026-11-12', 'dates follow the site time zone, not UTC')

// ---- Bing parsing
assert.equal(bingTime('/Date(1731283200000-0800)/'), 1731283200000)
assert.equal(bingTime('/Date(1731283200000)/'), 1731283200000)
const rolled = rollup([
  { Query: 'designer', Clicks: 2, Impressions: 10, AvgImpressionPosition: 4 },
  { Query: 'designer', Clicks: 1, Impressions: 30, AvgImpressionPosition: 8 },
  { Query: 'portfolio', Clicks: 5, Impressions: 5, AvgImpressionPosition: -1 },
], 10)
assert.deepEqual(rolled[0], { name: 'portfolio', clicks: 5, impressions: 5, position: null }, 'most clicks first; -1 means no position')
assert.deepEqual(rolled[1], { name: 'designer', clicks: 3, impressions: 40, position: 7 }, 'position weighted by impressions')

// ---- Umami stats, both reply shapes
const flat = umamiTotals({ pageviews: 50, visitors: 20, visits: 25, bounces: 10, totaltime: 2500, comparison: { pageviews: 40, visitors: 10, visits: 20, bounces: 5, totaltime: 1000 } })
assert.equal(flat.visitors, 20)
assert.equal(flat.bounceRate, 0.4)
assert.equal(flat.avgVisitSeconds, 100)
assert.equal(flat.prev.visitors, 10)
const nested = umamiTotals({ pageviews: { value: 50, prev: 40 }, visitors: { value: 20, prev: 10 }, visits: { value: 25, prev: 20 }, bounces: { value: 10, prev: 5 }, totaltime: { value: 2500, prev: 1000 } })
assert.deepEqual(nested, flat, 'old and new Umami shapes give the same numbers')
assert.equal(umamiTotals({ visits: 0 }).bounceRate, null, 'no visits: no rate, no divide by zero')

// ---- Cloudflare reply → the Umami-like shape the page draws
const cfw = timeWindow(7, now, 'America/New_York')
const g = (dim, value, count, visits) => ({ count, sum: { visits }, dimensions: { [dim]: value } })
const cf = cloudflareShape({
  total: [{ count: 50, sum: { visits: 30 } }],
  hours: [g('datetimeHour', '2026-11-12T03:00:00Z', 10, 10), g('datetimeHour', '2026-11-12T15:00:00Z', 20, 10)], // 10 pm on the 11th, then the 12th, in New York
  referrers: [g('refererHost', '', 20, 20), g('refererHost', 'www.example.com', 30, 0), g('refererHost', 't.co', 10, 10)],
  entry: [g('requestPath', '/', 20, 20)],
}, cfw, 'www.example.com')
assert.deepEqual(cf.totals, { pageLoads: 50, visits: 30, prev: { pageLoads: 0, visits: 0 } }, 'no reply for the period before counts as zero')
assert.deepEqual(cf.daily.at(-2), { date: '2026-11-11', visits: 10, pageviews: 10 }, 'UTC hours land on the site’s own date')
assert.deepEqual(cf.daily.at(-1), { date: '2026-11-12', visits: 10, pageviews: 20 })
assert.deepEqual(cf.referrers.map((x) => x.name), ['', 't.co'], 'the site itself is not a referrer')
assert.deepEqual(cf.entry, [{ name: '/', count: 20 }])
assert.deepEqual(cf.speed, [])

// ---- the AI read: free by default, Claude with a key, model JSON cleaned before the page sees it
assert.equal(aiChoice({ AI: {} }).provider, 'Workers AI')
assert.equal(aiChoice({ AI: {}, ANTHROPIC_API_KEY: 'k' }).provider, 'Claude')
assert.equal(aiChoice({ AI: {}, ANTHROPIC_API_KEY: 'k', AI_MODEL: '@cf/x/y' }).provider, 'Workers AI', '@cf/ names stay on Workers AI')
assert.deepEqual(aiChoice({ AI_MODEL: 'claude-x' }).missing, ['ANTHROPIC_API_KEY'])
assert.deepEqual(tidy({ summary: ['a', 3, null], actions: [{ title: 't', impact: 9 }] }).actions[0], { title: 't', why: '', change: '', where: '', impact: '', effort: '' })
const fakeAI = { run: async () => ({ choices: [{ message: { content: 'Here you go:\n```json\n{"headline":"h","summary":["s"]}\n```' } }] }) }
const read = await readInsights({ AI: fakeAI }, { days: 7, from: 'a', to: 'b', site: {}, sources: {} })
assert.equal(read.headline, 'h', 'JSON is found inside fences and chatter')
assert.deepEqual(read.actions, [], 'missing lists come back empty, not undefined')
const garbled = { run: async () => ({ choices: [{ message: { content: '{"headline": "h",\n\n\n' } }] }) }
await assert.rejects(readInsights({ AI: garbled }, { days: 7, site: {}, sources: {} }), /could not be read/)

// ---- a failing source reports its error and does not take the others down
const quiet = console.error
console.error = () => {} // the Worker logs the expected failure; keep the check's output clean
const failing = await buildReport({ UMAMI_API_KEY: 'k', UMAMI_WEBSITE_ID: 'id', UMAMI_API_URL: 'http://127.0.0.1:9/api' }, 7, now)
console.error = quiet
assert.equal(failing.sources.umami.status, 'error')
assert.equal(failing.sources.google.status, 'off')

console.log('check passed')
