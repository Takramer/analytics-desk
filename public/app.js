// analytics-desk page. No framework, no build step. Every value from the API reaches the page through
// textContent or a text node, never innerHTML, so a page title or search query can't inject markup.

const $ = (id) => document.getElementById(id)
const RANGES = [7, 30, 90]
const NAMES = { umami: 'Umami', google: 'Google Search Console', bing: 'Bing Webmaster Tools', cloudflare: 'Cloudflare Web Analytics' }

let days = RANGES.includes(Number(localStorage.getItem('desk-days'))) ? Number(localStorage.getItem('desk-days')) : 30
let report = null
let setup = null
const ai = {} // AI reads already fetched this visit, by range

// ---- formatting

const nf = new Intl.NumberFormat('en')
const num = (n) => (n == null ? '–' : nf.format(Math.round(n)))
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`)
const dec = (x, d = 1) => (x == null ? '–' : x.toFixed(d))
const secs = (s) => (s == null ? '–' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`)
const day = (ymd, o = { month: 'short', day: 'numeric' }) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' })
const regions = new Intl.DisplayNames(['en'], { type: 'region' })
const country = (code) => { try { return regions.of(code) || code } catch { return code || '(unknown)' } }
const words = (s) => { const t = String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1) }
const path = (u) => { try { return new URL(u).pathname } catch { return u } }

// Says what changed in words, so the direction never rests on color.
function change(now, prev, { kind = 'pct', fmt = num, lowerIsBetter = false } = {}) {
  if (now == null || prev == null) return null
  const verdict = (better) => (lowerIsBetter ? (better ? ', better' : ', worse') : '')
  if (kind === 'pct') {
    if (!prev) return now ? 'none in the period before' : 'none before either'
    const p = Math.round(((now - prev) / prev) * 100)
    if (p === 0) return `flat (${fmt(prev)} before)`
    return `${p > 0 ? 'up' : 'down'} ${Math.abs(p)}%${verdict(p < 0)} (${fmt(prev)} before)`
  }
  if (kind === 'pts') {
    const d = Math.round((now - prev) * 100)
    return d === 0 ? `flat (${pct(prev)} before)` : `${d > 0 ? 'up' : 'down'} ${Math.abs(d)} points${verdict(d < 0)} (${pct(prev)} before)`
  }
  // kind === 'rank': a smaller position number is higher on the results page
  const d = Math.round((prev - now) * 10) / 10
  return d === 0 ? `same as before (${dec(prev)})` : `${Math.abs(d)} places ${d > 0 ? 'higher' : 'lower'} (${dec(prev)} before)`
}

// ---- DOM helpers

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') e.className = v
    else if (k === 'text') e.textContent = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c)
  return e
}

const NS = 'http://www.w3.org/2000/svg'
function sv(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  e.append(...kids)
  return e
}

const ok = (s) => s?.status === 'ok'
const offText = (id, s) => (s?.status === 'error' ? `${NAMES[id]} failed: ${s.error}` : `Connect ${NAMES[id]} to see this.`)

async function api(url, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const r = await fetch(url, { credentials: 'same-origin', ...init })
  const data = await r.json().catch(() => ({}))
  if (r.status === 401 && url !== '/api/login') {
    showSignin(true)
    throw new Error('Signed out')
  }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data
}

// ---- sign in and out

async function boot() {
  wire()
  try {
    const s = await api('/api/session')
    setSite(s.site)
    s.signedIn ? showDesk() : showSignin(s.passwordSet)
  } catch (e) {
    $('status').textContent = e.message
  }
}

function setSite(site = {}) {
  let host = ''
  try { host = site.url ? new URL(site.url).hostname : '' } catch {}
  const name = site.name || host || 'Your site'
  $('site-name').textContent = name
  document.title = `${name} · Analytics desk`
}

function showSignin(passwordSet) {
  $('desk').hidden = true
  $('controls').hidden = true
  $('signin').hidden = false
  $('setup-status').replaceChildren()
  const form = $('signin-form')
  for (const f of form.elements) f.disabled = !passwordSet
  $('signin-error').textContent = passwordSet ? '' : 'No password set yet. Follow step 1 of the setup below, then reload this page.'
  if (passwordSet) $('password').focus()
}

function showDesk() {
  $('signin').hidden = true
  $('desk').hidden = false
  $('controls').hidden = false
  pressRange()
  renderAI()
  load(false)
  api('/api/setup').then((s) => { setup = s; setSite(s.site); renderSetup() }).catch(() => {})
}

function wire() {
  $('signin-form').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const btn = ev.submitter
    btn.disabled = true
    $('signin-error').textContent = ''
    try {
      await api('/api/login', { password: $('password').value })
      $('password').value = ''
      showDesk()
    } catch (e) {
      $('signin-error').textContent = e.message
    } finally {
      btn.disabled = false
    }
  })
  for (const b of document.querySelectorAll('[data-days]')) {
    b.addEventListener('click', () => {
      days = Number(b.dataset.days)
      localStorage.setItem('desk-days', days)
      pressRange()
      renderAI()
      load(false)
    })
  }
  $('refresh').addEventListener('click', () => load(true))
  $('signout').addEventListener('click', async () => {
    await api('/api/logout', {}).catch(() => {})
    showSignin(true)
  })
  $('ai-run').addEventListener('click', readAI)
  let width = 0
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width)
    if (w !== width && report) { width = w; drawTrend(report) }
  }).observe($('trend'))
  window.addEventListener('scroll', () => ($('tip').hidden = true), { passive: true })
}

function pressRange() {
  for (const b of document.querySelectorAll('[data-days]')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days))
}

// ---- load and draw

async function load(fresh) {
  const btn = $('refresh')
  btn.disabled = true
  $('status').textContent = `Loading the last ${days} days…`
  try {
    report = await api(`/api/report?days=${days}${fresh ? '&fresh' : ''}`)
    render(report)
    const at = new Date(report.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    $('status').textContent = `${day(report.from, { month: 'long', day: 'numeric' })} to ${day(report.to, { month: 'long', day: 'numeric', year: 'numeric' })}. Numbers fetched at ${at}.`
  } catch (e) {
    $('status').textContent = e.message
  } finally {
    btn.disabled = false
  }
}

function render(r) {
  banner(r)
  totals(r)
  drawTrend(r)
  flow(r)
  pages(r)
  sources(r)
  search(r)
  speed(r)
  renderSetup()
}

function banner(r) {
  const off = Object.entries(r.sources).filter(([, s]) => s.status === 'off').map(([id]) => NAMES[id])
  const bad = Object.entries(r.sources).filter(([, s]) => s.status === 'error')
  const b = $('banner')
  b.hidden = !off.length && !bad.length
  b.replaceChildren(
    ...bad.map(([id, s]) => el('span', { text: `${NAMES[id]} failed: ${s.error} ` })),
    off.length ? `Not connected yet: ${off.join(', ')}. ` : '',
    el('a', { href: '#setup', text: 'Open setup' }),
  )
}

function tile({ label, value, delta, src, flag }) {
  return el('div', { class: flag ? 'tile flag' : 'tile' },
    el('p', { class: 'label', text: label }),
    el('p', { class: 'value', text: value }),
    delta && el('p', { class: 'delta', text: delta }),
    src && el('p', { class: 'src', text: src }))
}

function totals(r) {
  const { umami: u, google: g, bing: b, cloudflare: c } = r.sources
  const t = []
  const lede = []
  if (ok(u)) {
    const x = u.totals, p = x.prev
    t.push(
      tile({ label: 'People', value: num(x.visitors), delta: change(x.visitors, p.visitors), src: 'Umami' }),
      tile({ label: 'Visits', value: num(x.visits), delta: change(x.visits, p.visits), src: 'Umami' }),
      tile({ label: 'Page views', value: num(x.pageviews), delta: change(x.pageviews, p.pageviews), src: 'Umami' }),
      tile({ label: 'Left after one page', value: pct(x.bounceRate), delta: change(x.bounceRate, p.bounceRate, { kind: 'pts', lowerIsBetter: true }), src: 'Umami' }),
      tile({ label: 'Time per visit', value: secs(x.avgVisitSeconds), delta: change(x.avgVisitSeconds, p.avgVisitSeconds, { fmt: secs }), src: 'Umami' }),
    )
    lede.push(`${num(x.visitors)} people made ${num(x.visits)} visits and viewed ${num(x.pageviews)} pages.`)
  }
  if (ok(g)) {
    const x = g.totals, p = x.prev
    t.push(
      tile({ label: 'Google clicks', value: num(x.clicks), delta: change(x.clicks, p.clicks), src: 'Search Console' }),
      tile({ label: 'Seen in Google', value: num(x.impressions), delta: change(x.impressions, p.impressions), src: 'Search Console, impressions' }),
      tile({ label: 'Google position', value: dec(x.position), delta: change(x.position, p.position, { kind: 'rank' }), src: 'Average rank, 1 is the top' }),
    )
    lede.push(`Google showed the site ${num(x.impressions)} times; ${num(x.clicks)} of those became clicks.`)
  }
  if (ok(b)) {
    const x = b.totals, p = x.prev
    t.push(
      tile({ label: 'Bing clicks', value: num(x.clicks), delta: change(x.clicks, p.clicks), src: 'Bing Webmaster Tools' }),
      tile({ label: 'Seen in Bing', value: num(x.impressions), delta: change(x.impressions, p.impressions), src: 'Bing, impressions' }),
    )
  }
  if (ok(c)) t.push(tile({ label: 'Page loads', value: num(c.totals.pageLoads), src: 'Cloudflare' }))
  $('tiles').replaceChildren(...t)
  $('totals-lede').textContent = lede.length ? `In the last ${r.days} days: ${lede.join(' ')}` : 'Connect a source to see totals.'
}

// Line chart drawn at the box's real width, so text stays its true size at any zoom.
function drawTrend(r) {
  const box = $('trend')
  const u = r.sources.umami
  box.replaceChildren()
  $('trend-table').replaceChildren()
  if (!ok(u)) {
    box.append(el('p', { class: 'empty', text: offText('umami', u) }))
    $('trend-lede').textContent = ''
    return
  }
  const rows = u.daily
  const vals = rows.map((d) => d.visits)
  const peak = vals.indexOf(Math.max(...vals))
  const total = vals.reduce((a, b) => a + b, 0)
  $('trend-lede').textContent = total
    ? `Busiest day: ${day(rows[peak].date, { weekday: 'long', month: 'short', day: 'numeric' })}, with ${num(vals[peak])} visits. About ${dec(total / rows.length)} a day on average.`
    : 'No visits in this range.'

  const W = Math.max(box.clientWidth - 34, 260)
  const H = Math.round(Math.min(300, Math.max(200, W * 0.34)))
  const m = { l: 44, r: 18, t: 26, b: 30 }
  const step = niceStep(Math.max(...vals, 1))
  const top = Math.max(step, Math.ceil(Math.max(...vals, 1) / step) * step)
  const x = (i) => m.l + (rows.length < 2 ? 0 : (i * (W - m.l - m.r)) / (rows.length - 1))
  const y = (v) => m.t + (H - m.t - m.b) * (1 - v / top)

  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': `Visits per day from ${day(rows[0].date)} to ${day(rows.at(-1).date)}. Highest ${vals[peak]} on ${day(rows[peak].date)}. The table below lists every day.` })
  const grid = sv('g', { class: 'grid' })
  const axis = sv('g', { class: 'axis' })
  for (let v = 0; v <= top; v += step) {
    grid.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }))
    axis.append(sv('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, num(v)))
  }
  // One date label per ~80px of width, counted back from today so the latest day is always labelled.
  const every = Math.ceil(rows.length / Math.max(2, Math.floor((W - m.l - m.r) / 80)))
  rows.forEach((d, i) => {
    if ((rows.length - 1 - i) % every || (i > 0 && i < every / 2)) return
    axis.append(sv('text', { x: x(i), y: H - 8, 'text-anchor': i === rows.length - 1 ? 'end' : i === 0 ? 'start' : 'middle' }, day(d.date)))
  })
  const line = rows.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.visits).toFixed(1)}`).join('')
  svg.append(grid, axis,
    sv('path', { class: 'area', d: `${line}L${x(rows.length - 1)},${y(0)}L${x(0)},${y(0)}Z` }),
    sv('path', { class: 'line', d: line }))
  if (total) {
    svg.append(sv('circle', { class: 'dot', cx: x(peak), cy: y(vals[peak]), r: 5 }),
      sv('text', { class: 'peak', x: x(peak), y: y(vals[peak]) - 12, 'text-anchor': peak > rows.length * 0.85 ? 'end' : peak < rows.length * 0.15 ? 'start' : 'middle' }, `${num(vals[peak])} visits`))
  }

  const hoverLine = sv('line', { class: 'hover-line', y1: m.t, y2: H - m.b, visibility: 'hidden' })
  const hoverDot = sv('circle', { class: 'hover-dot', r: 4.5, visibility: 'hidden' })
  const hit = sv('rect', { class: 'hit', x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b })
  const tip = $('tip')
  hit.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect()
    const px = ((ev.clientX - rect.left) / rect.width) * W
    const i = Math.max(0, Math.min(rows.length - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (rows.length - 1))))
    const d = rows[i]
    for (const [k, v] of [['x1', x(i)], ['x2', x(i)], ['visibility', 'visible']]) hoverLine.setAttribute(k, v)
    for (const [k, v] of [['cx', x(i)], ['cy', y(d.visits)], ['visibility', 'visible']]) hoverDot.setAttribute(k, v)
    tip.replaceChildren(el('strong', { text: day(d.date, { weekday: 'short', month: 'short', day: 'numeric' }) }), el('br'), `${num(d.visits)} visits, ${num(d.pageviews)} page views`)
    tip.hidden = false
    const tw = tip.offsetWidth
    tip.style.left = `${Math.min(window.innerWidth - tw - 8, ev.clientX + 14)}px`
    tip.style.top = `${ev.clientY + 16}px`
  })
  hit.addEventListener('pointerleave', () => {
    hoverLine.setAttribute('visibility', 'hidden')
    hoverDot.setAttribute('visibility', 'hidden')
    tip.hidden = true
  })
  svg.append(hoverLine, hoverDot, hit)
  box.append(svg)

  $('trend-table').append(tableOf(rows.slice().reverse(), [
    { h: 'Day', v: (d) => day(d.date, { weekday: 'short', month: 'short', day: 'numeric' }) },
    { h: 'Visits', v: (d) => num(d.visits), n: true },
    { h: 'Page views', v: (d) => num(d.pageviews), n: true },
  ]))
}

// 1, 2 or 5 times a power of ten, giving about four gridlines.
function niceStep(max) {
  const raw = max / 4
  const p = 10 ** Math.floor(Math.log10(raw || 1))
  return Math.max(1, [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw))
}

function bars(id, src, srcId, rows, { label = (r) => r.name || '(none)', value = (r) => r.count, empty = 'Nothing in this range.' } = {}) {
  const ol = $(id)
  ol.replaceChildren()
  if (!ok(src)) return ol.append(el('li', { class: 'empty', text: offText(srcId, src) }))
  if (!rows?.length) return ol.append(el('li', { class: 'empty', text: empty }))
  const max = Math.max(...rows.map(value), 1)
  for (const r of rows) {
    const fill = el('span')
    fill.style.width = `${(value(r) / max) * 100}%`
    ol.append(el('li', {}, el('span', { class: 'name', text: label(r) }), el('span', { class: 'num', text: num(value(r)) }), el('span', { class: 'bar', 'aria-hidden': 'true' }, fill)))
  }
}

function flow(r) {
  const u = r.sources.umami
  const ol = $('journeys')
  ol.replaceChildren()
  if (!ok(u)) ol.append(el('li', { class: 'empty', text: offText('umami', u) }))
  else if (!u.journeys.length) ol.append(el('li', { class: 'empty', text: 'No paths of two or more steps yet.' }))
  else for (const j of u.journeys.slice(0, 8)) {
    const steps = el('div', { class: 'steps' })
    j.steps.forEach((s, i) => steps.append(...(i ? [el('span', { class: 'arrow', 'aria-label': 'then', text: '→' })] : []), el('span', { class: 'step', text: s })))
    ol.append(el('li', {}, steps, el('p', { class: 'count', text: `${num(j.count)} visits took this path` })))
  }
  bars('entry', u, 'umami', u?.entry)
  bars('exit', u, 'umami', u?.exit)
  if (ok(u) && u.entry[0] && u.exit[0]) {
    const top = u.journeys[0]
    $('flow-lede').textContent = `Most visits start on ${u.entry[0].name} and end on ${u.exit[0].name}.` +
      (top ? ` The most common path is ${top.steps.join(' then ')} (${num(top.count)} visits).` : '')
  } else $('flow-lede').textContent = ''
}

function pages(r) {
  const u = r.sources.umami
  bars('pages', u, 'umami', u?.pages)
  bars('events', u, 'umami', u?.events, { empty: 'No tracked clicks yet. Add data-umami-event to the links you care about.' })
}

function sources(r) {
  const u = r.sources.umami
  bars('channels', u, 'umami', u?.channels, { label: (x) => words(x.name) || '(unknown)' })
  bars('referrers', u, 'umami', u?.referrers, { label: (x) => x.name || '(direct or unknown)' })
  bars('countries', u, 'umami', u?.countries, { label: (x) => country(x.name) })
  bars('devices', u, 'umami', u?.devices, { label: (x) => words(x.name) || '(unknown)' })
}

function tableOf(rows, cols) {
  return el('div', { class: 'scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.n ? 'n' : null, scope: 'col', text: c.h })))),
    el('tbody', {}, rows.map((row) => el('tr', {}, cols.map((c) => el('td', { class: c.n ? 'n' : null, text: c.v(row) })))))))
}

function searchTable(id, src, srcId, rows, label = (x) => x.name) {
  const box = $(id)
  box.replaceChildren()
  if (!ok(src)) return box.append(el('p', { class: 'empty', text: offText(srcId, src) }))
  if (!rows.length) return box.append(el('p', { class: 'empty', text: 'No search data in this range. It runs two or three days behind.' }))
  box.append(tableOf(rows.slice(0, 15), [
    { h: 'Search', v: label },
    { h: 'Clicks', v: (x) => num(x.clicks), n: true },
    { h: 'Seen', v: (x) => num(x.impressions), n: true },
    { h: 'Click rate', v: (x) => (x.impressions ? pct(x.clicks / x.impressions) : '–'), n: true },
    { h: 'Position', v: (x) => dec(x.position), n: true },
  ]))
}

function search(r) {
  const { google: g, bing: b } = r.sources
  searchTable('g-queries', g, 'google', g?.queries || [])
  searchTable('b-queries', b, 'bing', b?.queries || [])
  searchTable('g-pages', g, 'google', g?.pages || [], (x) => path(x.name))
  const bits = []
  if (ok(g)) bits.push(`Google: ${num(g.totals.clicks)} clicks from ${num(g.totals.impressions)} views of the results, average position ${dec(g.totals.position)}.`)
  if (ok(b)) bits.push(`Bing: ${num(b.totals.clicks)} clicks from ${num(b.totals.impressions)} views.`)
  $('search-lede').textContent = bits.length ? `${bits.join(' ')} A low click rate at a good position usually means the page title or description needs work.` : ''
}

const rate = (v, good, poor) => (v == null ? 'no data yet' : v <= good ? 'good' : v <= poor ? 'needs work' : 'poor')

function speed(r) {
  const c = r.sources.cloudflare
  const box = $('speed-pages')
  box.replaceChildren()
  if (!ok(c)) {
    $('vitals').replaceChildren()
    $('speed-lede').textContent = ''
    return box.append(el('p', { class: 'empty', text: offText('cloudflare', c) }))
  }
  const v = c.vitals
  const lcp = rate(v.lcpMs, 2500, 4000), inp = rate(v.inpMs, 200, 500), cls = rate(v.cls, 0.1, 0.25)
  $('vitals').replaceChildren(
    tile({ label: 'Main content appears', value: v.lcpMs == null ? '–' : `${dec(v.lcpMs / 1000)} s`, delta: `${words(lcp)}. Good is under 2.5 s.`, src: 'Largest Contentful Paint', flag: lcp === 'poor' }),
    tile({ label: 'Reacts to a tap or click', value: v.inpMs == null ? '–' : `${num(v.inpMs)} ms`, delta: `${words(inp)}. Good is under 200 ms.`, src: 'Interaction to Next Paint', flag: inp === 'poor' }),
    tile({ label: 'Layout jumps', value: dec(v.cls, 2), delta: `${words(cls)}. Good is under 0.1.`, src: 'Cumulative Layout Shift', flag: cls === 'poor' }),
  )
  $('speed-lede').textContent = `${num(c.totals.pageLoads)} page loads, ${num(v.samples)} with speed data. Each figure is the 75th percentile: three in four loads were this fast or faster.`
  const rows = c.pages.slice().sort((a, b) => (b.lcpMs ?? -1) - (a.lcpMs ?? -1))
  if (!rows.length) return box.append(el('p', { class: 'empty', text: 'No speed samples in this range.' }))
  box.append(tableOf(rows, [
    { h: 'Page', v: (x) => x.name },
    { h: 'Loads', v: (x) => num(x.samples), n: true },
    { h: 'Main content', v: (x) => (x.lcpMs == null ? '–' : `${dec(x.lcpMs / 1000)} s`), n: true },
    { h: 'Reacts', v: (x) => (x.inpMs == null ? '–' : `${num(x.inpMs)} ms`), n: true },
    { h: 'Jumps', v: (x) => dec(x.cls, 2), n: true },
  ]))
}

// ---- setup status

function renderSetup() {
  const box = $('setup-status')
  if (!setup) return box.replaceChildren()
  const row = (name, state, cls, detail) =>
    el('div', { class: `src-row ${cls}` }, el('span', { class: 'state', text: state }), el('strong', { text: name }), detail && el('span', { class: 'muted', text: detail }))
  const site = setup.site
  const missingSite = [['SITE_NAME', site.name], ['SITE_URL', site.url], ['SITE_GOAL', site.goal]].filter(([, v]) => !v).map(([k]) => k)
  box.replaceChildren(
    row('Site details', missingSite.length ? 'Not set' : 'Set', missingSite.length ? '' : 'on', missingSite.length ? `Missing ${missingSite.join(', ')}` : `${site.url}, time zone ${site.timezone}`),
    ...setup.sources.map((s) => {
      const live = report?.sources[s.id]
      if (s.missing.length) return row(s.name, 'Not connected', '', `Missing ${s.missing.join(', ')}`)
      if (live?.status === 'error') return row(s.name, 'Failing', 'bad', live.error)
      return row(s.name, 'Connected', 'on', null)
    }),
    setup.ai.missing.length
      ? row('AI read (Claude)', 'Not connected', '', 'Missing ANTHROPIC_API_KEY')
      : row('AI read (Claude)', 'Connected', 'on', `Model ${setup.ai.model}`),
  )
}

// ---- the AI read

async function readAI() {
  const btn = $('ai-run')
  const range = days
  btn.disabled = true
  btn.textContent = 'Reading, about a minute…'
  $('ai-body').replaceChildren(el('p', { class: 'muted', text: `Claude is reading every connected source for the last ${range} days.` }))
  try {
    ai[range] = await api('/api/insights', { days: range, fresh: !!ai[range] })
  } catch (e) {
    if (range === days) $('ai-body').replaceChildren(el('p', { class: 'error', text: e.message }))
    btn.disabled = false
    btn.textContent = ai[days] ? 'Read again' : 'Read my numbers'
    return
  }
  btn.disabled = false
  if (range === days) renderAI()
}

function renderAI() {
  const a = ai[days]
  const btn = $('ai-run')
  if (!btn.disabled) btn.textContent = a ? 'Read again' : 'Read my numbers'
  const body = $('ai-body')
  if (!a) {
    return body.replaceChildren(el('p', { class: 'muted', text: 'Claude reads every source for this range and lists what to change, biggest win first. It takes about a minute, and the read is kept for the rest of the day.' }))
  }
  const notes = [['How people move', a.flow], ['Search', a.search], ['Speed', a.speed]].filter(([, t]) => t)
  body.replaceChildren(
    el('p', { class: 'headline', text: a.headline }),
    el('ul', { class: 'summary' }, a.summary.map((s) => el('li', { text: s }))),
    el('ol', { class: 'actions' }, a.actions.map((x) => el('li', {}, el('div', {},
      el('p', { class: 'act-title', text: x.title }),
      el('p', { class: 'tags' }, el('span', { class: 'tag', text: `Impact: ${x.impact}` }), el('span', { class: 'tag', text: `Effort: ${x.effort}` })),
      el('dl', {}, el('dt', { text: 'Why' }), el('dd', { text: x.why }), el('dt', { text: 'Change' }), el('dd', { text: x.change }), el('dt', { text: 'Where' }), el('dd', { text: x.where })))))),
    notes.length && el('div', { class: 'notes' }, notes.map(([h, t]) => el('div', {}, el('h3', { text: h }), el('p', { text: t })))),
    a.caveats?.length && el('div', { class: 'caveats' }, el('strong', { text: 'Keep in mind' }), el('ul', {}, a.caveats.map((c) => el('li', { text: c })))),
    el('p', { class: 'meta', text: `Read by ${a.model} at ${new Date(a.generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, covering ${day(a.from)} to ${day(a.to)}.` }),
  )
}

boot()
