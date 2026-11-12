// The AI read: the merged report goes to a model, which answers in a fixed JSON shape the page can lay out.
// Free by default (Workers AI on your own Cloudflare account); Claude when ANTHROPIC_API_KEY is set.

import Anthropic from '@anthropic-ai/sdk'

export const CLAUDE_MODEL = 'claude-opus-5-5'
export const WORKERS_MODEL = '@cf/google/gemma-4-26b-a4b-it'

// AI_MODEL picks the model; a name starting with "@" is a Workers AI model.
export function aiChoice(env) {
  const m = env.AI_MODEL || ''
  return m.startsWith('@') || (!m && !env.ANTHROPIC_API_KEY)
    ? { provider: 'Workers AI', model: m || WORKERS_MODEL, missing: env.AI ? [] : ['the AI binding in wrangler.toml'] }
    : { provider: 'Claude', model: m || CLAUDE_MODEL, missing: env.ANTHROPIC_API_KEY ? [] : ['ANTHROPIC_API_KEY'] }
}

const SYSTEM = `You read website analytics for the person who owns the site and tell them what to change.
They are not an analyst. Write plain English in short sentences. Name real pages, searches and numbers from the data.
Plain text only: no Markdown, asterisks or backticks; the page shows your words exactly as written.
Rules:
- Every claim must rest on a number in the data. Never invent a trend.
- Small samples are normal for small sites. Under about 100 visits in the period, or under about 20 on one page, say the sample is small and hedge. Never call 3 versus 5 a trend.
- Umami counts people and paths. Google and Bing count searches, which happen before a visit. Cloudflare counts page loads and speed. They will not match; do not treat the gap as an error unless it is very large.
- Cloudflare keeps about 1 page load in 10 and multiplies up, so its counts move in steps of about 10. A Cloudflare count under 50 is a handful of real loads: never read a trend into it. Its "entry" list is where visits start.
- Core Web Vitals at p75: LCP under 2500 ms is good, over 4000 ms is poor. INP under 200 ms is good, over 500 ms is poor. CLS under 0.1 is good, over 0.25 is poor.
- Prefer changes the owner can make this week: copy, links, page order, titles and descriptions, image weight. Tie each one to the site's goal when a goal is given.
- Order actions by expected impact. Give at most 6. Skip "add more tracking" unless a question that matters cannot be answered without it.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'actions', 'flow', 'search', 'speed', 'caveats'],
  properties: {
    headline: { type: 'string', description: 'One sentence: the most important thing in this period.' },
    summary: { type: 'array', items: { type: 'string' }, description: 'Two to four plain sentences on what happened.' },
    actions: {
      type: 'array',
      description: 'What to change, highest impact first, at most 6.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'change', 'where', 'impact', 'effort'],
        properties: {
          title: { type: 'string', description: 'Short imperative, e.g. "Put the contact link in the first screen".' },
          why: { type: 'string', description: 'The numbers that point to this.' },
          change: { type: 'string', description: 'Exactly what to do.' },
          where: { type: 'string', description: 'The page, search or part of the site it touches.' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          effort: { type: 'string', enum: ['small', 'medium', 'large'] },
        },
      },
    },
    flow: { type: 'string', description: 'How visitors move through the site: where they start, the common paths, where they leave.' },
    search: { type: 'string', description: 'What Google and Bing searches show. Empty string if there is no search data.' },
    speed: { type: 'string', description: 'What the speed numbers show. Empty string if there is no speed data.' },
    caveats: { type: 'array', items: { type: 'string' }, description: 'Limits of this data worth knowing.' },
  },
}

export async function readInsights(env, report) {
  const ai = aiChoice(env)
  if (ai.missing.length) throw Object.assign(new Error(`Add ${ai.missing.join(', ')} to turn on the AI read. See the setup guide.`), { status: 400 })
  const read = ai.provider === 'Claude' ? await claude(env, ai.model, report) : await workersAI(env, ai.model, report)
  return { ...tidy(read.answer), model: read.model, days: report.days, from: report.from, to: report.to, generatedAt: new Date().toISOString() }
}

// Free: Workers AI on the account the Worker runs on, 10,000 neurons a day. One read of 30 days costs a few hundred.
async function workersAI(env, model, report) {
  // ponytail: no response_format. Gemma's JSON mode padded its answer with blank lines until it ran out of tokens;
  // the schema in the prompt plus tidy() below holds up. Try response_format again if you switch models.
  const r = await env.AI.run(model, {
    messages: [
      { role: 'system', content: `${SYSTEM}\n\nAnswer with one JSON object and nothing else. It must match this JSON Schema:\n${JSON.stringify(SCHEMA)}` },
      { role: 'user', content: prompt(report) },
    ],
    max_tokens: 8000,
  })
  const text = String(r?.choices?.[0]?.message?.content ?? r?.response ?? '')
  try {
    return { answer: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)), model: model.split('/').pop() }
  } catch {
    throw Object.assign(new Error('The free model sent an answer that could not be read. Press "Read again".'), { status: 502 })
  }
}

// The model's JSON is untrusted: keep only the fields the page draws, as strings, so a missing one can't break it.
export function tidy(x = {}) {
  const str = (v) => (typeof v === 'string' ? v : '')
  const strs = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : [])
  const keys = ['title', 'why', 'change', 'where', 'impact', 'effort']
  return {
    headline: str(x.headline), summary: strs(x.summary), flow: str(x.flow), search: str(x.search), speed: str(x.speed), caveats: strs(x.caveats),
    actions: (Array.isArray(x.actions) ? x.actions : []).slice(0, 6).map((a) => Object.fromEntries(keys.map((k) => [k, str(a?.[k])]))),
  }
}

async function claude(env, model, report) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 5 * 60e3 })
  // Server-side fallback re-runs a declined request on another model. Only these models take the parameter.
  const fallback = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model)

  // ponytail: one non-streaming call keeps CPU low on the Workers free plan; stream it if replies outgrow 16k tokens.
  const msg = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    ...(fallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt(report) }],
  })
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The model declined this request. Try again later.'), { status: 502 })
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('The AI read ran out of room. Try a shorter range.'), { status: 502 })
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return { answer: JSON.parse(text), model: msg.model }
}

function prompt(report) {
  const { site, sources, days, from, to } = report
  const live = Object.fromEntries(Object.entries(sources).filter(([, s]) => s.status === 'ok'))
  const missing = Object.entries(sources).filter(([, s]) => s.status !== 'ok').map(([id, s]) => `${id} (${s.status})`)
  return [
    `Site: ${site.name || site.url || 'not named'}${site.url ? ` (${site.url})` : ''}`,
    `Goal of the site: ${site.goal || 'not given; infer it from the pages and say what you assumed'}`,
    `Period: the last ${days} days, ${from} to ${to}. "prev" values cover the ${days} days before that.`,
    missing.length ? `Not connected or failing: ${missing.join(', ')}.` : 'All sources connected.',
    'Event names are custom events the site sends when someone presses a link or button.',
    'Data:',
    JSON.stringify(live),
  ].join('\n')
}
