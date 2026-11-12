// The four sources. Each one reads its own keys from env; a missing key means "not connected", never an error.
// Every loader returns plain numbers and short ranked lists, so the page and the AI read see one shape.

import { DEFAULT_MODEL } from './ai.js'

const DAY = 864e5

export const SOURCES = [
  { id: 'umami', name: 'Umami', needs: ['UMAMI_API_KEY', 'UMAMI_WEBSITE_ID'], load: umami },
  { id: 'google', name: 'Google Search Console', needs: ['GSC_SERVICE_ACCOUNT', 'GSC_SITE'], load: google },
  { id: 'bing', name: 'Bing Webmaster Tools', needs: ['BING_API_KEY', 'BING_SITE'], load: bing },
  { id: 'cloudflare', name: 'Cloudflare Web Analytics', needs: ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'SITE_URL'], load: cloudflare },
]

export const siteInfo = (env) => ({
  name: env.SITE_NAME || '',
  url: env.SITE_URL || '',
  goal: env.SITE_GOAL || '',
  timezone: env.TIMEZONE || 'UTC',
})

export function sourceStatus(env) {
  return {
    site: siteInfo(env),
    sources: SOURCES.map((s) => ({ id: s.id, name: s.name, missing: s.needs.filter((k) => !env[k]) })),
    ai: { missing: env.ANTHROPIC_API_KEY ? [] : ['ANTHROPIC_API_KEY'], model: env.AI_MODEL || DEFAULT_MODEL },
  }
}

export async function buildReport(env, days, now = Date.now()) {
  const w = timeWindow(days, now, env.TIMEZONE || 'UTC')
  const results = await Promise.all(
    SOURCES.map(async (s) => {
      if (s.needs.some((k) => !env[k])) return [s.id, { status: 'off' }]
      try {
        return [s.id, { status: 'ok', ...(await s.load(env, w)) }]
      } catch (e) {
        console.error(s.id, e)
        return [s.id, { status: 'error', error: String(e.message || e).slice(0, 300) }]
      }
    }),
  )
  return { days, from: w.start, to: w.end, generatedAt: new Date(now).toISOString(), site: siteInfo(env), sources: Object.fromEntries(results) }
}

// The last `days` days ending now, plus the same length just before it for comparison.
export function timeWindow(days, now, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const ymd = (t) => fmt.format(t)
  const startAt = now - days * DAY
  return {
    days, tz, ymd, startAt, endAt: now, prevStartAt: startAt - days * DAY,
    start: ymd(startAt), end: ymd(now), prevStart: ymd(startAt - days * DAY), prevEnd: ymd(startAt - DAY),
    dates: Array.from({ length: days }, (_, i) => ymd(startAt + (i + 1) * DAY)),
  }
}

// ---- Umami (Cloud or self-hosted): visits, pages, entry and exit pages, referrers, events, visitor paths

async function umami(env, w) {
  const base = (env.UMAMI_API_URL || 'https://api.umami.is/v1').replace(/\/+$/, '')
  const get = (path, params = {}) =>
    getJSON(`${base}/websites/${encodeURIComponent(env.UMAMI_WEBSITE_ID)}${path}?${new URLSearchParams({ startAt: w.startAt, endAt: w.endAt, timezone: w.tz, ...params })}`, {
      headers: { authorization: `Bearer ${env.UMAMI_API_KEY}`, accept: 'application/json' },
    })
  const top = (type, limit = 10) => get('/metrics', { type, limit }).then((rows) => rows.map((r) => ({ name: r.x || '', count: r.y })))

  const [stats, series, pages, entry, exit, referrers, channels, countries, devices, events, journeys] = await Promise.all([
    get('/stats', { compare: 'prev' }),
    get('/pageviews', { unit: 'day' }),
    top('path', 15), top('entry'), top('exit'), top('referrer'), top('channel'), top('country'), top('device'), top('event', 15),
    get('/journeys', { steps: 4 }).catch(() => null), // ponytail: older self-hosted Umami has no journeys route; the rest still loads
  ])
  const byDay = (rows) => new Map((rows || []).map((r) => [String(r.x).slice(0, 10), r.y]))
  const visits = byDay(series.sessions)
  const views = byDay(series.pageviews)
  return {
    totals: umamiTotals(stats),
    daily: w.dates.map((date) => ({ date, visits: visits.get(date) || 0, pageviews: views.get(date) || 0 })),
    pages, entry, exit, referrers, channels, countries, devices, events,
    journeys: (journeys || [])
      .map((j) => ({ steps: (j.items || []).filter(Boolean), count: j.count }))
      .filter((j) => j.steps.length > 1)
      .slice(0, 12),
  }
}

// Umami 2.x sent {pageviews: {value, prev}}; current versions send flat numbers plus a `comparison` object.
export function umamiTotals(stats) {
  const now = (k) => Number(stats[k]?.value ?? stats[k] ?? 0)
  const before = (k) => Number(stats.comparison?.[k] ?? stats[k]?.prev ?? 0)
  const pick = (g) => ({
    visitors: g('visitors'),
    visits: g('visits'),
    pageviews: g('pageviews'),
    bounceRate: ratio(g('bounces'), g('visits')),
    avgVisitSeconds: ratio(g('totaltime'), g('visits')),
  })
  return { ...pick(now), prev: pick(before) }
}

// ---- Google Search Console: a service account added as a user on the property, so no browser sign-in

async function google(env, w) {
  const token = await googleToken(JSON.parse(env.GSC_SERVICE_ACCOUNT))
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(env.GSC_SITE)}/searchAnalytics/query`
  const run = (body) =>
    getJSON(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: w.start, endDate: w.end, dataState: 'all', ...body }),
    }).then((r) => r.rows || [])

  const [total, before, daily, queries, pages] = await Promise.all([
    run({}),
    run({ startDate: w.prevStart, endDate: w.prevEnd }),
    run({ dimensions: ['date'], rowLimit: 1000 }),
    run({ dimensions: ['query'], rowLimit: 25 }),
    run({ dimensions: ['page'], rowLimit: 15 }),
  ])
  const sum = ([r]) => ({ clicks: r?.clicks || 0, impressions: r?.impressions || 0, position: round1(r?.position) })
  const days = new Map(daily.map((r) => [r.keys[0], r]))
  const row = (r) => ({ name: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: round1(r.position) })
  return {
    totals: { ...sum(total), prev: sum(before) },
    daily: w.dates.map((date) => ({ date, clicks: days.get(date)?.clicks || 0, impressions: days.get(date)?.impressions || 0 })),
    queries: queries.map(row),
    pages: pages.map(row),
  }
}

async function googleToken(sa) {
  const now = Math.floor(Date.now() / 1000)
  const part = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const r = await getJSON('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(new Uint8Array(sig))}` }),
  })
  return r.access_token
}

// ---- Bing Webmaster Tools: one API key; data comes back as dated rows we cut to the window ourselves

async function bing(env, w) {
  const call = (method) =>
    getJSON(`https://ssl.bing.com/webmaster/api.svc/json/${method}?${new URLSearchParams({ siteUrl: env.BING_SITE, apikey: env.BING_API_KEY })}`, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }).then((r) => r.d || [])
  const [traffic, queries, pages] = await Promise.all(['GetRankAndTrafficStats', 'GetQueryStats', 'GetPageStats'].map(call))

  const inside = (a, b) => (r) => bingTime(r.Date) >= a && bingTime(r.Date) <= b
  const now = inside(w.startAt, w.endAt)
  const sum = (rows) => ({ clicks: total(rows, 'Clicks'), impressions: total(rows, 'Impressions') })
  const days = new Map()
  for (const r of traffic.filter(now)) {
    const d = w.ymd(bingTime(r.Date))
    const e = days.get(d) || { clicks: 0, impressions: 0 }
    days.set(d, { clicks: e.clicks + r.Clicks, impressions: e.impressions + r.Impressions })
  }
  return {
    totals: { ...sum(traffic.filter(now)), prev: sum(traffic.filter(inside(w.prevStartAt, w.startAt - 1))) },
    daily: w.dates.map((date) => ({ date, ...(days.get(date) || { clicks: 0, impressions: 0 }) })),
    // ponytail: Bing groups query and page rows by week, so a 7-day window can catch one week's bucket on either side.
    queries: rollup(queries.filter(now), 25),
    pages: rollup(pages.filter(now), 15),
  }
}

// Bing dates look like "/Date(1731283200000-0800)/": the first number is milliseconds since 1970.
export const bingTime = (s) => Number(/-?\d+/.exec(String(s))?.[0])

// Sum each query's weekly rows; average position weighted by impressions. Bing sends -1 when it has no position.
export function rollup(rows, limit) {
  const m = new Map()
  for (const r of rows) {
    const e = m.get(r.Query) || { name: r.Query, clicks: 0, impressions: 0, weighted: 0, seen: 0 }
    e.clicks += r.Clicks || 0
    e.impressions += r.Impressions || 0
    if (r.AvgImpressionPosition > 0) {
      e.weighted += r.AvgImpressionPosition * (r.Impressions || 0)
      e.seen += r.Impressions || 0
    }
    m.set(r.Query, e)
  }
  return [...m.values()]
    .map(({ weighted, seen, ...e }) => ({ ...e, position: seen ? round1(weighted / seen) : null }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, limit)
}

// ---- Cloudflare Web Analytics: page loads and Core Web Vitals (p75), filtered to the site's own hostname

async function cloudflare(env, w) {
  const host = new URL(env.SITE_URL).hostname
  const filter = `{AND:[{datetime_geq:$s},{datetime_leq:$e},{requestHost:$h}]}`
  const vitals = 'largestContentfulPaintP75 interactionToNextPaintP75 cumulativeLayoutShiftP75'
  const query = `query($a:string!,$s:Time!,$e:Time!,$h:string!){viewer{accounts(filter:{accountTag:$a}){
    total: rumPageloadEventsAdaptiveGroups(filter:${filter},limit:1){count sum{visits}}
    site: rumWebVitalsEventsAdaptiveGroups(filter:${filter},limit:1){count quantiles{${vitals}}}
    pages: rumWebVitalsEventsAdaptiveGroups(filter:${filter},limit:10,orderBy:[count_DESC]){count dimensions{requestPath} quantiles{${vitals}}}
  }}}`
  const r = await getJSON('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, s: new Date(w.startAt).toISOString(), e: new Date(w.endAt).toISOString(), h: host } }),
  })
  if (r.errors?.length) throw new Error(`Cloudflare: ${r.errors[0].message}`)
  const acc = r.data?.viewer?.accounts?.[0] || {}
  // Times arrive in microseconds; a negative value means "no data".
  const ms = (us) => (us == null || us < 0 ? null : Math.round(us / 1000))
  const v = (q = {}) => ({ lcpMs: ms(q.largestContentfulPaintP75), inpMs: ms(q.interactionToNextPaintP75), cls: q.cumulativeLayoutShiftP75 ?? null })
  return {
    totals: { pageLoads: acc.total?.[0]?.count || 0, visits: acc.total?.[0]?.sum?.visits || 0 },
    vitals: { samples: acc.site?.[0]?.count || 0, ...v(acc.site?.[0]?.quantiles) },
    pages: (acc.pages || []).map((p) => ({ name: p.dimensions.requestPath, samples: p.count, ...v(p.quantiles) })),
  }
}

// ---- helpers

// Errors name the host and path only, never the query string: Bing's key rides in it.
async function getJSON(url, init = {}) {
  const r = await fetch(url, init)
  const text = await r.text()
  const where = () => { const u = new URL(url); return u.host + u.pathname }
  if (!r.ok) throw new Error(`${where()} answered ${r.status}: ${text.slice(0, 200)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${where()} did not send JSON`)
  }
}

const ratio = (a, b) => (b ? a / b : null)
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10)
const total = (rows, k) => rows.reduce((n, r) => n + (r[k] || 0), 0)
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
