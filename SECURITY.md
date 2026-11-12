# Security

Please report a security problem privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get a reply within a week.

## What this project protects

- The dashboard password and session cookie (`src/index.js`).
- The API keys stored as Worker secrets. They never leave the Worker; error messages strip query strings so a key cannot leak through one.
- The analytics data behind the sign-in.

## Your part when you deploy

- Use a password of 16 or more characters that you use nowhere else, or one you already keep for a sibling admin page.
- Give the Cloudflare token only **Account Analytics: Read**, and the Google service account only **Restricted** access to one property.
- Never commit `.dev.vars` or a Google key file. `.gitignore` already excludes both.
