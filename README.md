# Playwright vs. Puppeteer (Next.js)

Compare **Playwright** and **Puppeteer** side-by-side in a modern **Next.js 16** app.  
This repo exposes two API endpoints that scrape a given URL using each library and return both the **HTML** and the **text content**. It’s designed to run locally with full Playwright/Puppeteer and seamlessly on serverless platforms (e.g., Vercel) using **@sparticuz/chromium**.

---

## Table of Contents
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [API Reference](#api-reference)
- [How It Works](#how-it-works)
- [Production / Vercel Notes](#production--vercel-notes)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

- 🔁 **Headless scraping** with retry & global timeout logic (per request).
- 🧭 **Two endpoints**: one powered by **Playwright**, the other by **Puppeteer**.
- 🚦 **Graceful error handling** with HTTP 4xx/5xx responses and clear logs.
- 🧊 **Serverless-friendly**: uses `@sparticuz/chromium` in production to provide a Chromium binary and args compatible with serverless environments.
- ⚡ **Resource reuse**: reuses a single browser instance per runtime to reduce cold-start overhead.

---

## Tech Stack

- **Framework:** Next.js 16, React 19, TypeScript
- **Automation:** Playwright (`playwright` for dev, `playwright-core` for prod), Puppeteer (`puppeteer` for dev, `puppeteer-core` for prod)
- **Serverless Chromium:** `@sparticuz/chromium` (+ `@sparticuz/chromium-min`)
- **Styling:** Tailwind CSS 4 (optional, already configured)
- **Linting:** ESLint 9 (with `eslint-config-next`)

---

## Project Structure

> Key files relevant to scraping (paths may vary—assuming App Router):

/app
/api
/test-playwright
route.ts # POST /api/test-playwright
/test-puppeteer
route.ts # POST /api/test-puppeteer
/services
playwrightScraper.ts # Playwright implementation
puppeteerScraper.ts # Puppeteer implementation
package.json
tsconfig.json

---

## Getting Started

### 1 Prerequisites
- Node.js 18+ recommended
- pnpm / yarn / npm (any works)

### 2 Install

```bash
# clone your repo first, then:
pnpm install
# or
yarn
# or
npm install
```

### 3  Run Locally

Dev uses full Playwright/Puppeteer (not the -core builds):

```bash
pnpm dev
or
yarn dev
or
npm run dev
```

Open http://localhost:3000

Build/start scripts:

dev → next dev

build → next build

start → next start

lint → eslint

API Reference
POST /api/test-playwright

Scrapes a URL with Playwright.

Request body

```
{ "url": "https://example.org" }
```


```
Response (200)

{
  "content": "Visible page text ...",
  "html": "<!doctype html>..."
}
```

Errors

400 — missing/invalid url

500 — internal error (timeout, network, etc.)

POST /api/test-puppeteer

Scrapes a URL with Puppeteer.

Request body

```
{ "url": "https://example.org" }
```

```
Response (200)

{
  "content": "Visible page text ...",
  "html": "<!doctype html>..."
}
```

Errors
400 — missing/invalid url
500 — internal error (timeout, network, etc.)


### cURL Examples

### Playwright
```bash
curl -s -X POST http://localhost:3000/api/test-playwright \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.org"}' | jq .
```

### Puppeteer
```bash
curl -s -X POST http://localhost:3000/api/test-puppeteer \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.org"}' | jq .
```

How It Works

Both scrapers share the same ideas:

Global browser reuse: a single browser instance is launched and reused via globalThis guards:
```
g.__PW_BROWSER__ / g.__PW_BROWSER_PROMISE__

g.__PPTR_BROWSER__ / g.__PPTR_BROWSER_PROMISE__
```

Production vs Dev:

Dev: imports full playwright / puppeteer and launches normally.

Production: imports playwright-core / puppeteer-core and launches with an executable from @sparticuz/chromium (plus required args, no sandbox).

Resilience

MAX_RETRIES = 3 (skips retry on overall timeout).

OVERALL_TIMEOUT_MS ≈ 45s per attempt.

goto(..., timeout: 30_000) plus short network idle waits.

Returns both page content (text) and full html.

Rejects if scraped text is suspiciously short.

Playwright specifics

Uses a browser context with viewport, UA, and headers set.

Waits for domcontentloaded + networkidle (non-fatal if it times out).

Puppeteer specifics

Uses browser.createBrowserContext() then context.newPage().

Waits for domcontentloaded + waitForNetworkIdle (non-fatal if it times out).

Production / Vercel Notes

These scrapers require the Node.js runtime (not Edge).

In each API route file, add:

export const runtime = 'nodejs';


No special env vars are required by default, but Vercel sets process.env.VERCEL, which your code already uses to decide production paths.

@sparticuz/chromium handles:
```
executablePath() extraction (memoized with g.__CHROMIUM_PATH_PROMISE__)
```

args for serverless compatibility
```
chromiumSandbox: false
```

If you see “No usable sandbox!” or similar, ensure you’re not forcing Edge and you’re passing the provided args.

Troubleshooting

400 Invalid URL parameter
Your JSON body must include a string url. Example:

```
{ "url": "https://example.org" }
```

500 Internal Server Error with timeout
The scraper hit the overall timeout. Try:

Checking the target site availability.

Testing with a simpler page.

Increasing OVERALL_TIMEOUT_MS if truly needed.
```
net::ERR_NAME_NOT_RESOLVED
```
DNS resolution failed (e.g., typo in domain). The code maps this to a clear error and stops retrying.

“Insufficient content scraped”
The page might be blank, gated, or render late. Consider:

Tweaking waits (e.g., longer network idle).

Using a different waitUntil strategy.

Adding site-specific waits/selectors.

Memory leaks / too many browsers
Browsers are reused and cleaned up per request; if you run into limits:

Confirm you aren’t spawning browsers elsewhere.

Ensure browser.on('disconnected', ...) resets the global ref (already implemented).
