// The AI read: the merged report goes to Claude, which answers in a fixed JSON shape the page can lay out.

import Anthropic from '@anthropic-ai/sdk'

export const DEFAULT_MODEL = 'claude-opus-5-5'

const SYSTEM = `You read website analytics for the person who owns the site and tell them what to change.
They are not an analyst. Write plain English in short sentences. Name real pages, searches and numbers from the data.
Rules:
- Every claim must rest on a number in the data. Never invent a trend.
- Small samples are normal for small sites. Under about 100 visits in the period, or under about 20 on one page, say the sample is small and hedge. Never call 3 versus 5 a trend.
- Umami counts people and paths. Google and Bing count searches, which happen before a visit. Cloudflare counts page loads and speed. They will not match; do not treat the gap as an error unless it is very large.
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
  if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Add ANTHROPIC_API_KEY to turn on the AI read. See the setup guide.'), { status: 400 })
  const model = env.AI_MODEL || DEFAULT_MODEL
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
  return { ...JSON.parse(text), model: msg.model, days: report.days, from: report.from, to: report.to, generatedAt: new Date().toISOString() }
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
