/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

interface ScrapeResult {
  html: string;
  content: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const OVERALL_TIMEOUT_MS = 45_000; // 45 seconds max per attempt

type Browser = import('puppeteer-core').Browser;

const g = globalThis as any;

g.__PPTR_BROWSER__ ??= { browser: null as Browser | null };
g.__PPTR_BROWSER_PROMISE__ ??= null as Promise<Browser> | null;
g.__CHROMIUM_PATH_PROMISE__ ??= null as Promise<string> | null;

async function getBrowser(): Promise<Browser> {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL;

  // Reuse healthy browser
  const existing = g.__PPTR_BROWSER__.browser as Browser | null;
  if (existing && existing.isConnected()) return existing;

  // If another invocation is already launching, await it
  if (g.__PPTR_BROWSER_PROMISE__) return g.__PPTR_BROWSER_PROMISE__;

  // Launch once (guard with promise)
  g.__PPTR_BROWSER_PROMISE__ = (async () => {
    let browser: Browser;

    if (isProduction) {
      const [chromiumModule, puppeteerCore] = await Promise.all([
        import('@sparticuz/chromium'),
        import('puppeteer-core'),
      ]);

      const chromiumPkg = chromiumModule.default || chromiumModule;
      const pptr = (puppeteerCore as any).default || puppeteerCore;

      // Ensure only ONE extraction to /tmp runs at a time across invocations
      const executablePathPromise: Promise<string> =
        (g.__CHROMIUM_PATH_PROMISE__ ||= chromiumPkg.executablePath());
      const path = await executablePathPromise;

      browser = await pptr.launch({
        headless: true,
        executablePath: path,
        args: chromiumPkg.args,
        chromiumSandbox: false,
      });
    } else {
      // Dev: use full Puppeteer
      const pptr = (await import('puppeteer')).default as unknown as {
        launch: (opts?: any) => Promise<Browser>;
      };
      browser = await pptr.launch({ headless: true, ignoreHTTPSErrors: true, });
    }

    browser.on('disconnected', () => {
      g.__PPTR_BROWSER__.browser = null;
    });

    g.__PPTR_BROWSER__.browser = browser;
    return browser;
  })();

  try {
    return await g.__PPTR_BROWSER_PROMISE__;
  } finally {
    // Clear so a future relaunch can happen if this one dies later
    g.__PPTR_BROWSER_PROMISE__ = null;
  }
}

/**
 * Scrape with overall timeout protection
 */
async function scrapeWithTimeout(url: string, timeoutMs: number): Promise<ScrapeResult> {
  return new Promise(async (resolve, reject) => {
    let browser: Browser | null = null;
    let context: import('puppeteer-core').BrowserContext | null = null;
    let page: import('puppeteer-core').Page | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let isTimedOut = false;

    // Overall timeout
    timeoutHandle = setTimeout(() => {
      isTimedOut = true;
      const error = new Error(`Scraping timed out after ${timeoutMs}ms`);
      console.error(`[puppeteer-scraper] Timeout reached for ${url}`, 'puppeteer-scraper');

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
      console.info(`[puppeteer-scraper] Browser launched successfully`, 'puppeteer-scraper');

      context = await browser.createBrowserContext();

      page = await context.newPage();

      // Env/headers identical to your PW scraper
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });

      // Shorter individual timeouts since we have overall timeout
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000, // Reduced from 60s
      });

      if (isTimedOut) return; // Already cleaned up

      // Shorter network idle; warn only (non-fatal)
      try {
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10_000 });
      } catch {
        console.warn(`[puppeteer-scraper] Network idle timeout (non-fatal)`, 'puppeteer-scraper');
      }

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

      console.info(`[puppeteer-scraper] Success - ${url}`, 'puppeteer-scraper');

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
        console.error(
          `[puppeteer-scraper] Error closing page/context`,
          'puppeteer-scraper',
          { error }
        );
      }
    }
  });
}

export async function puppeteerScraper(inputUrl: string): Promise<ScrapeResult> {
  const normalizedUrl =
    inputUrl.startsWith('http://') || inputUrl.startsWith('https://') ? inputUrl : `https://${inputUrl}`;


  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.info(
        `[puppeteer-scraper] Attempt ${attempt}/${MAX_RETRIES} - ${normalizedUrl}`,
        'puppeteer-scraper'
      );

      const result = await scrapeWithTimeout(normalizedUrl, OVERALL_TIMEOUT_MS);
      return result;
    } catch (error: any) {

      console.warn(
        `[puppeteer-scraper] Attempt ${attempt}/${MAX_RETRIES} failed - ${normalizedUrl}`,
        'puppeteer-scraper',
        { error: error?.message }
      );

      // Map DNS error
      if (error?.message?.includes('net::ERR_NAME_NOT_RESOLVED')) {
        throw new Error(
          `Domain could not be resolved: ${normalizedUrl}`,
        );
      }

      // Do not retry on overall timeout
      if (error?.message?.includes('timed out')) {
        console.error(
          `[puppeteer-scraper] Timeout after ${OVERALL_TIMEOUT_MS}ms, not retrying`,
          'puppeteer-scraper'
        );
        break;
      }

      if (attempt < MAX_RETRIES) {
        console.info(
          `[puppeteer-scraper] Waiting ${RETRY_DELAY_MS}ms before retry`,
          'puppeteer-scraper'
        );
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(
    `Failed to scrape page after ${MAX_RETRIES} attempts: ${normalizedUrl}`,
  );
}
