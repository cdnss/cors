/**
 * Cloudflare Worker to fetch and return HTML content from a given URL
 * using the Cloudflare Browser Rendering API, accessing secrets via env.ID and env.TOKEN.
 */

// Definisikan interface untuk environment variables (Secrets)
// Ini membantu untuk type checking jika menggunakan TypeScript
interface Env {
  ID: string;     // Nama Secret untuk Account ID
  TOKEN: string;  // Nama Secret untuk API Token
}

// event listener utama, kini melewatkan env
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event.env as Env)); // Pastikan env dilewatkan
});

// handleRequest menerima objek Request dan objek Env
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url'); // Ambil URL target

  if (!targetUrl) {
    return new Response('Please provide a URL in the "url" query parameter.', { status: 400 });
  }

  // --- Mengakses Kredensial dari Secrets env.ID dan env.TOKEN (Aman!) ---
  const accountId = env.ID;    // Ambil dari env.ID
  const apiToken = env.TOKEN;  // Ambil dari env.TOKEN
  // --------------------------------------------------------------------

  // Validasi apakah secrets berhasil dimuat (opsional tapi bagus)
   if (!accountId || !apiToken) {
       // Pesan error disesuaikan dengan nama secrets yang digunakan
       return new Response('Environment secrets ID or TOKEN are not set.', { status: 500 });
   }


  // URL API Cloudflare Browser Rendering
  const cloudflareScrapeEndpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/scrape`;

  try {
    // Payload untuk API scrape
    const apiPayload = {
      url: targetUrl,
      elements: [
        {
          selector: 'div', // Ubah sesuai kebutuhanmu!
          type: 'text',
        },
      ],
       // Opsi rendering/timeout opsional
    };

    // Opsi untuk fetch request ke API Cloudflare
    const apiRequestOptions: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Menggunakan API Token dari Secrets env.TOKEN (Aman!)
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify(apiPayload),
    };

    console.log(`Calling Cloudflare scrape API for URL: ${targetUrl}`);

    // Melakukan panggilan fetch ke API Cloudflare
    const cloudflareApiResponse = await fetch(cloudflareScrapeEndpoint, apiRequestOptions);

    // Menangani error dari API Cloudflare
    if (!cloudflareApiResponse.ok) {
      const errorBody = await cloudflareApiResponse.text();
      console.error('Cloudflare API error:', cloudflareApiResponse.status, errorBody);
       try {
           const errorJson = JSON.parse(errorBody);
           return new Response(`Cloudflare API Error: ${cloudflareApiResponse.status} - ${JSON.stringify(errorJson, null, 2)}`, { status: cloudflareApiResponse.status, headers: { 'Content-Type': 'application/json'} });
      } catch (e) {
           return new Response(`Cloudflare API Error: ${cloudflareApiResponse.status} - ${errorBody}`, { status: cloudflareApiResponse.status });
      }
    }

    // Mengambil hasil scrape dalam format JSON
    const scrapeResult = await cloudflareApiResponse.json();

    // Mengembalikan hasil JSON dari API Cloudflare sebagai respons Worker
    return new Response(JSON.stringify(scrapeResult, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // CORS Header
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // CORS Header
        'Access-Control-Allow-Headers': 'Content-Type, Authorization', // CORS Header
      },
    });

  } catch (error: any) {
    console.error('Error in Cloudflare Worker during scrape process:', error);
    return new Response(`Internal Server Error: ${error.message || error}`, { status: 500 });
  }
}
