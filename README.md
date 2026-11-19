# Analytics desk

One password-protected page that pulls your site's numbers from Cloudflare Web Analytics, Google Search Console, Bing Webmaster Tools and (optionally) Umami, lays them out in plain English, and asks an AI model what to change.

It runs as a single Cloudflare Worker. No database, no build step, no framework. Each source is optional: connect the ones you use. Everything except Umami Cloud's API and Claude runs on free plans:

| Input | Cost |
|---|---|
| Cloudflare Worker, Web Analytics and its API | Free. Analytics go back 90 days; about 1 in 10 page loads is sampled. |
| Google Search Console API | Free |
| Bing Webmaster Tools API | Free |
| AI read on Workers AI (default) | Free up to 10,000 neurons a day; one read uses about 150 to 500 |
| AI read on Claude (optional) | About $0.10 to $0.25 a read |
| Umami API (optional) | Free when self-hosted; Pro plan on Umami Cloud |

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Takramer/analytics-desk)

## What you get

- **The short version.** Visits, page views, Google and Bing clicks and impressions. With Umami: people, the share who leave after one page, time per visit. Every number says how it moved against the period before, in words.
- **Visits per day.** A line chart with hover detail and a table view.
- **How people move.** Where visits start. With Umami: the most common paths through the site and where visits end.
- **What they read and press.** Pages by views. With Umami: tracked link or button presses.
- **Where they come from.** Referring sites, countries, devices. With Umami: channels.
- **Search.** The searches that showed your site on Google and Bing, with clicks, click rate and position.
- **Speed.** Core Web Vitals at the 75th percentile from Cloudflare, site-wide and per page.
- **What to change.** An AI model reads every connected source for the range and returns up to six changes, highest impact first, each with the numbers behind it, what to do and where. One read per range per day is cached; "Read again" asks for a new one.

Visits and pages come from Umami when its API is connected, otherwise from Cloudflare.
- **Setup.** A built-in guide and a live list of which sources are connected, missing a key, or failing.

Ranges: 7, 30 or 90 days. Numbers are cached for ten minutes; Refresh skips the cache.

## Set up

You need a Cloudflare account and Node 20 or later.

```bash
git clone https://github.com/Takramer/analytics-desk.git
cd analytics-desk
npm install
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD
```

The password needs 15 or more characters. To serve it on your own domain (the zone must be on Cloudflare), deploy with:

```bash
npx wrangler deploy --domain analytics.example.com
```

The easiest way to set everything else: copy `.dev.vars.example` to `.dev.vars`, fill in what you have, and upload it in one go. Then delete the file or keep it out of git (it already is).

```bash
npx wrangler secret bulk .dev.vars
```

### Settings

| Name | What it does | Without it |
|---|---|---|
| `DASHBOARD_PASSWORD` | Signs you in. 15+ characters. Changing it signs everyone out. | Nobody can sign in. |
| `SITE_NAME`, `SITE_URL` | Page title; `SITE_URL` also picks the hostname for Cloudflare speed data. | Title falls back; Cloudflare stays off. |
| `SITE_GOAL` | One sentence on what a good visit ends with. The AI read judges everything against it. | Claude guesses the goal and says so. |
| `TIMEZONE` | IANA name such as `America/New_York`. Days start at midnight here. | UTC. |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | Visits, pages, referrers, countries, devices, Core Web Vitals. | Visits come from Umami only; speed stays off. |
| `GSC_SERVICE_ACCOUNT`, `GSC_SITE` | Google searches. | Google sections stay off. |
| `BING_API_KEY`, `BING_SITE` | Bing searches. | Bing sections stay off. |
| `ANTHROPIC_API_KEY` | Switches the AI read to Claude (paid). | The free Workers AI read. |
| `AI_MODEL` | Picks the model. A name starting with `@cf/` is a Workers AI model. | `@cf/google/gemma-4-26b-a4b-it`, or `claude-opus-5-5` with a Claude key. |
| `UMAMI_API_KEY`, `UMAMI_WEBSITE_ID` | Paths, exit pages, button presses, people; replaces Cloudflare for visits. | Those sections say they need Umami. |
| `UMAMI_API_URL` | Self-hosted Umami only, e.g. `https://umami.example.com/api`. | Umami Cloud. |

### Cloudflare Web Analytics (free)

1. Turn on **Web Analytics** for the site in the Cloudflare dashboard.
2. **My Profile → API Tokens → Create Token → Custom token** with one permission: **Account → Account Analytics → Read**. That is `CF_API_TOKEN`.
3. Your **Account ID** is on the Workers & Pages overview. That is `CF_ACCOUNT_ID`.

The Worker filters to the hostname in `SITE_URL`. Cloudflare keeps about 1 page load in 10 and multiplies up, so small numbers move in steps of about 10. A "visit" is a page load that came from outside the site, which is how the page knows where visits start. Cloudflare does not record paths through the site, exit pages or button presses.

### Google Search Console

Google needs a service account so the Worker can read without a browser sign-in.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project and enable the **Google Search Console API**.
2. **IAM & Admin → Service accounts → Create service account.** No roles. Open it, then **Keys → Add key → JSON**. A file downloads.
3. In [Search Console](https://search.google.com/search-console), open **Settings → Users and permissions → Add user**, paste the service account's `client_email`, and give it **Restricted** permission.
4. Upload the key and name the property, then delete the file:

```bash
npx wrangler secret put GSC_SERVICE_ACCOUNT < key.json
npx wrangler secret put GSC_SITE
```

`GSC_SITE` is `sc-domain:example.com` for a domain property (the kind verified by a DNS record), or the exact URL with its trailing slash for a URL-prefix property.

### Bing Webmaster Tools

1. Add your site in [Bing Webmaster Tools](https://www.bing.com/webmasters) if it is not there; **Import from Google Search Console** does it in one step.
2. Open **Settings (gear) → API access → API key** and generate one. That is `BING_API_KEY`.
3. `BING_SITE` is the site exactly as Bing lists it, such as `https://www.example.com/`.

Bing groups search rows by week, so a 7-day range can include one week's bucket on either edge.

### The AI read

Free by default, with nothing to set: the `[ai]` binding in `wrangler.toml` runs [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) on your own account, which includes 10,000 neurons a day. A month of data for a small site used about 150 neurons in testing. On the Workers Free plan it stops at the cap instead of billing. Each read is kept for the rest of the day per range, so reloading the page does not spend again.

For a sharper read, create a key in the [Claude Console](https://platform.claude.com/) and set `ANTHROPIC_API_KEY`. That switches the read to Claude Opus 5.5, about $0.10 to $0.25 a read.

### Umami (optional)

Umami Cloud's free Hobby plan has no API, so it cannot feed this page; API access starts at its Pro plan. [Self-hosted Umami](https://umami.is/docs/install) includes the API for free.

1. In Umami, open **Settings → API keys → Create key**. That is `UMAMI_API_KEY`.
2. Open **Settings → Websites → Edit** on your site and copy the **Website ID**. That is `UMAMI_WEBSITE_ID`.
3. Self-hosted: set `UMAMI_API_URL` to your instance's `/api` address and use a key or token your instance accepts.

To see which links and buttons people press, add `data-umami-event="name"` to them on your site.

## Run it locally

```bash
cp .dev.vars.example .dev.vars   # fill in at least DASHBOARD_PASSWORD
npm run dev                      # http://localhost:8787
npm run check                    # self-check plus a deploy dry run
```

## How it is built

```
src/index.js     routes, sign-in, caching
src/sources.js   one loader per source, all returning the same shape
src/ai.js        the AI request (Workers AI or Claude) and its JSON schema
public/          the page: HTML, CSS, one script, no build
test/check.mjs   assert-based self-check, no network
```

The page talks only to its own Worker. The Worker holds every key and calls each API server-side, so no key reaches the browser.

## Security

- One password, compared in constant time, with a login rate limit of 5 tries a minute per IP.
- The session is an HMAC-signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie that lasts 30 days. It is keyed on the password, so changing the password ends every session.
- POST routes accept JSON only, which blocks cross-site form posts.
- Strict Content Security Policy, no third-party scripts, `noindex` everywhere, framing denied.
- Every value from an API reaches the page as text, never as HTML.

See [SECURITY.md](SECURITY.md) to report a problem.

## License

MIT. See [LICENSE](LICENSE).
