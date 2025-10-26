/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { puppeteerScraper } from '@/services/puppeteerScraper';

/*
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800; // 800 seconds
*/

export async function POST(request: NextRequest) {
  try {
    // Extract parameters from request body
    const { url } = await request.json();

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { error: 'Invalid URL parameter' },
        { status: 400 }
      );
    }

    console.info(`[Test] Starting Puppeteer scrape for ${url}`, '');
    const scrapedData = await puppeteerScraper(url);
    const { content: scrapedContent, html: scrapedHtml } = scrapedData;

    console.info(`[Test] Scrape completed. Content length: ${scrapedContent.length}`, '');

    // Return immediately (fire-and-forget)
    return NextResponse.json(
      { 
        content: scrapedContent,
        html: scrapedHtml,
      },
      {
        status: 200,
      }
    );

  } catch (error: any) {
    console.error?.('[Test] TestAPI failed', 'test-puppeteer', { error });

    return NextResponse.json(
      { error: 'Internal Server Error' },
      { 
        status: 500,
      }
    );
  }
}
