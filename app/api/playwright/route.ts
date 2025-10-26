/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { playwrightScraper } from '@/services/playwrightScraper';


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
    
    console.info(`[Test] Starting Playwright scrape for ${url}`);
    const scrapedData = await playwrightScraper(url);

    // Validate scraper response structure
    if (!scrapedData || typeof scrapedData !== 'object') {
      throw new Error('Invalid scraper response');
    }

    const { content: scrapedContent, html: scrapedHtml } = scrapedData;

    console.info(`[Test] Scrape completed. Content length: ${scrapedContent.length}`);


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
    console.error?.('[test-playwright] TestAPI failed', { error });

    return NextResponse.json(
      { error: 'Internal Server Error' },
      { 
        status: 500,
      }
    );
  }
}