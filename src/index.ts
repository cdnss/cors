import { chromium } from '@cloudflare/puppeteer';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === 'GET') {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto('https://xtgem.com');
      const screenshot = await page.screenshot({ encoding: 'binary' });
      await browser.close();
      return new Response(screenshot, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (error) {
      console.error(error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
  return new Response('Not Found', { status: 404 });
}
