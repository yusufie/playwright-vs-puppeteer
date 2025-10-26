/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

interface ScrapeResult {
  html: string;
  content: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const OVERALL_TIMEOUT_MS = 45000; // 45 seconds max per attempt

type Browser = import('playwright-core').Browser;
const g = globalThis as any;

g.__PW_BROWSER__ ??= { browser: null as Browser | null };
g.__PW_BROWSER_PROMISE__ ??= null as Promise<Browser> | null;
g.__CHROMIUM_PATH_PROMISE__ ??= null as Promise<string> | null;

async function getBrowser(): Promise<Browser> {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL;

  // Reuse healthy browser
  const existing = g.__PW_BROWSER__.browser as Browser | null;
  if (existing && existing.isConnected()) return existing;

  // If another invocation is already launching, await it
  if (g.__PW_BROWSER_PROMISE__) return g.__PW_BROWSER_PROMISE__;

  // Launch once (guard with promise)
  g.__PW_BROWSER_PROMISE__ = (async () => {
    let browser: Browser;

    if (isProduction) {
      const [{ chromium: chromiumLauncher }, chromiumModule] = await Promise.all([
        import('playwright-core').then(m => ({ chromium: m.chromium })),
        import('@sparticuz/chromium')
      ]);

      const chromiumPkg = chromiumModule.default || chromiumModule;

      // Ensure only ONE extraction to /tmp runs at a time across invocations
      const executablePath =
        (g.__CHROMIUM_PATH_PROMISE__ ||= chromiumPkg.executablePath());
      const path = await executablePath;

      browser = await chromiumLauncher.launch({
        headless: true,
        executablePath: path,
        args: chromiumPkg.args,
        chromiumSandbox: false,
      });
    } else {
      // Dev: use full Playwright
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
    }

    browser.on('disconnected', () => { g.__PW_BROWSER__.browser = null; });
    g.__PW_BROWSER__.browser = browser;
    return browser;
  })();

  try {
    return await g.__PW_BROWSER_PROMISE__;
  } finally {
    // Clear the promise so a future relaunch can happen if this one dies later
    g.__PW_BROWSER_PROMISE__ = null;
  }
}


/**
 * Scrape with overall timeout protection
 */
async function scrapeWithTimeout(url: string, timeoutMs: number): Promise<ScrapeResult> {
  return new Promise(async (resolve, reject) => {
    let browser: Browser | null = null;
    let context: import('playwright-core').BrowserContext | null = null;
    let page: import('playwright-core').Page | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let isTimedOut = false;

    // Overall timeout
    timeoutHandle = setTimeout(() => {
      isTimedOut = true;
      const error = new Error(`Scraping timed out after ${timeoutMs}ms`);
      console.error(`[playwright-scraper] Timeout reached for ${url}`);
      
      // Force cleanup
      Promise.all([
        page?.close().catch(() => {}),
        context?.close().catch(() => {}),
      ]).finally(() => {
        reject(error);
      });
    }, timeoutMs);

    try {
      browser = await getBrowser();
      console.info(`[playwright-scraper] Browser launched successfully`);

      context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
        ignoreHTTPSErrors: true,
      });

      page = await context.newPage();

      // Shorter individual timeouts since we have overall timeout
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000, // Reduced from 60s
      });

      if (isTimedOut) return; // Already cleaned up

      // Shorter network idle
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {
        console.warn(`[playwright-scraper] Network idle timeout (non-fatal)`);
      });

      if (isTimedOut) return;

      if (!response?.ok()) {
        throw new Error(
          `HTTP error! Status: ${response?.status()} for ${url}`,
        );
      }

      const html = await page.content();
      const content = await page.evaluate(() => document.body?.innerText || '');

      if (!content || content.trim().length < 100) {
        throw new Error('Insufficient content scraped. The page may not have loaded properly.');
      }

      if (isTimedOut) return;

      console.info(`[playwright-scraper] Success - ${url}`);

      // Clear timeout and resolve
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }

      resolve({ html, content });

    } catch (error: any) {
      if (isTimedOut) return; // Already handled by timeout
      
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }

      reject(error);
    } finally {
      // Cleanup
      try {
        await page?.close().catch(() => {});
        await context?.close().catch(() => {});
      } catch (error) {
        console.error(`[playwright-scraper] Error closing page/context`, { error });
      }
    }
  });
}

export async function playwrightScraper(url: string): Promise<ScrapeResult> {
  const normalizedUrl = url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;


  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.info(`[playwright-scraper] Attempt ${attempt}/${MAX_RETRIES} - ${normalizedUrl}`);

      const result = await scrapeWithTimeout(normalizedUrl, OVERALL_TIMEOUT_MS);
      return result;

    } catch (error: any) {
      console.warn(
        `[playwright-scraper] Attempt ${attempt}/${MAX_RETRIES} failed - ${normalizedUrl}`,
        { error: error?.message }
      );

      if (error?.message?.includes('net::ERR_NAME_NOT_RESOLVED')) {
        throw new Error(
          `Domain could not be resolved: ${normalizedUrl}`,
        );
      }

      // Don't retry on timeout - it's likely a bad site
      if (error?.message?.includes('timed out')) {
        console.error(`[playwright-scraper] Timeout after ${OVERALL_TIMEOUT_MS}ms, not retrying`);
        break;
      }

      if (attempt < MAX_RETRIES) {
        console.info(`[playwright-scraper] Waiting ${RETRY_DELAY_MS}ms before retry`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(
    `Failed to scrape page after ${MAX_RETRIES} attempts: ${normalizedUrl}`,
  );
}
