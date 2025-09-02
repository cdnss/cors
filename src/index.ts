// _worker.ts

interface Env {
  BROWSER_KV_DEMO: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url).pathname;

    // Ambil data dari KV
    const cachedData = await env.MY_KV_NAMESPACE.get("scraped_content");
    if (cachedData) {
      return new Response(cachedData, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600"
        }
      });
    }

    // Jika data tidak ada, lakukan scraping
    const scrapedResponse = await fetch("https://ww3.anoboy.app/");
    const content = await scrapedResponse.text();

    // Simpan data di KV untuk 1 jam ke depan
    await env.BROWSER_KV_DEMO.put("scraped_content", content, { expirationTtl: 3600 });

    return new Response(content);
  }
};
