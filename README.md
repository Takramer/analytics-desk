# Analytics desk

One password-protected page that pulls your site's numbers from Umami, Google Search Console, Bing Webmaster Tools and Cloudflare Web Analytics, lays them out in plain English, and asks Claude what to change.

It runs as a single Cloudflare Worker. No database, no build step, no framework. Each source is optional: connect the ones you use.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Takramer/analytics-desk)

## What you get

- **The short version.** Visitors, visits, page views, the share who leave after one page, time per visit, Google and Bing clicks and impressions, page loads. Every number says how it moved against the period before, in words.
- **Visits per day.** A line chart with hover detail and a table view.
- **How people move.** The most common paths through the site (Umami journeys), where visits start, where they end.
- **What they read and press.** Pages by views and tracked link or button presses (Umami events).
- **Where they come from.** Channels, referring sites, countries, devices.
- **Search.** The searches that showed your site on Google and Bing, with clicks, click rate and position.
- **Speed.** Core Web Vitals at the 75th percentile from Cloudflare, site-wide and per page.
- **What to change.** Claude reads every connected source for the range and returns up to six changes, highest impact first, each with the numbers behind it, what to do and where. One read per range per day is cached; "Read again" asks for a new one.
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

The password needs 16 or more characters. To serve it on your own domain (the zone must be on Cloudflare), deploy with:

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
| `DASHBOARD_PASSWORD` | Signs you in. 16+ characters. Changing it signs everyone out. | Nobody can sign in. |
| `SITE_NAME`, `SITE_URL` | Page title; `SITE_URL` also picks the hostname for Cloudflare speed data. | Title falls back; Cloudflare stays off. |
| `SITE_GOAL` | One sentence on what a good visit ends with. The AI read judges everything against it. | Claude guesses the goal and says so. |
| `TIMEZONE` | IANA name such as `America/New_York`. Days start at midnight here. | UTC. |
| `UMAMI_API_KEY`, `UMAMI_WEBSITE_ID` | Visits, paths, pages, events. | Umami sections stay off. |
| `UMAMI_API_URL` | Self-hosted Umami only, e.g. `https://umami.example.com/api`. | Umami Cloud. |
| `GSC_SERVICE_ACCOUNT`, `GSC_SITE` | Google searches. | Google sections stay off. |
| `BING_API_KEY`, `BING_SITE` | Bing searches. | Bing sections stay off. |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | Page loads and Core Web Vitals. | Speed section stays off. |
| `ANTHROPIC_API_KEY` | The AI read. | The button explains what to add. |
| `AI_MODEL` | Override the Claude model. | `claude-opus-5-5`. |

### Umami

1. In Umami, open **Settings → API keys → Create key**. That is `UMAMI_API_KEY`.
2. Open **Settings → Websites → Edit** on your site and copy the **Website ID**. That is `UMAMI_WEBSITE_ID`.
3. Self-hosted: set `UMAMI_API_URL` to your instance's `/api` address and use a key or token your instance accepts.

To see which links and buttons people press, add `data-umami-event="name"` to them on your site.

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

### Cloudflare Web Analytics

1. Turn on **Web Analytics** for the site in the Cloudflare dashboard.
2. **My Profile → API Tokens → Create Token → Custom token** with one permission: **Account → Account Analytics → Read**. That is `CF_API_TOKEN`.
3. Your **Account ID** is on the Workers & Pages overview. That is `CF_ACCOUNT_ID`.

The Worker filters to the hostname in `SITE_URL`.

### The AI read

Create a key in the [Claude Console](https://platform.claude.com/) and set `ANTHROPIC_API_KEY`. A read of a month of data for a small site is a single request; each read is kept for the rest of the day per range, so reloading the page does not spend again.

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
src/ai.js        the Claude request and its JSON schema
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
