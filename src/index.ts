import puppeteer from "@cloudflare/puppeteer";

interface Env {
  MYBROWSER: Fetcher;
  BROWSER_KV_DEMO: KVNamespace;
}

const HEADERS_DENY_LIST = [
    'content-length', // Worker akan menghitung ulang
    'transfer-encoding', // Worker akan menangani
    'connection', // Terkait koneksi asli
    'keep-alive', // Terkait koneksi asli
    'upgrade', // Terkait koneksi asli
    'server', // Informasi server asli
    'date', // Tanggal permintaan asli
    'expect-ct', // Terkait laporan CT
    'nel', // Jaringan error logging
    'report-to', // Tujuan pelaporan
    'alt-svc', // Alternatif layanan
    'cf-ray', // Header spesifik Cloudflare
    'cf-connecting-ip',
    'cf-ipcountry',
    // Tambahkan header lain di sini jika perlu
];

// Fungsi bantu untuk menyalin header.
function copyFilteredHeaders(originalHeaders: Headers | Map<string, string> | Record<string, string>): Record<string, string> {
    const copied: Record<string, string> = {};
    // Puppeteer headers() returns Record<string, string>, fetch() returns Headers
    const headersIterator = originalHeaders instanceof Headers || originalHeaders instanceof Map ? originalHeaders.entries() : Object.entries(originalHeaders);

    for (const [name, value] of headersIterator) {
        const lowerName = name.toLowerCase();
        if (!HEADERS_DENY_LIST.includes(lowerName) && !lowerName.startsWith('cf-')) {
            copied[name] = value;
        }
    }
    return copied;
}

// Header umum yang menyerupai browser sungguhan
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', // Menggunakan User-Agent Chrome terbaru (contoh)
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8', // Tambahkan bahasa Indonesia juga
    // Referer akan ditambahkan secara spesifik untuk Puppeteer jika diperlukan
};


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const baseUrlString = 'https://doujindesu.tv';
    const incomingUrl = new URL(request.url);
    const finalTargetUrl = new URL(incomingUrl.pathname + incomingUrl.search, baseUrlString);
    const finalTargetUrlString = finalTargetUrl.toString();

    console.log(`Menerima permintaan untuk ${incomingUrl.pathname}${incomingUrl.search}, menargetkan URL: ${finalTargetUrlString}`);

    // Langkah 1: Lakukan fetch standar terlebih dahulu untuk mendapatkan status, header, dan cek tipe konten
    // Tambahkan header browser realistis pada fetch awal
    const initialResponse = await fetch(finalTargetUrlString, {
        headers: BROWSER_HEADERS // Gunakan header browser yang sudah didefinisikan
    });
    const contentType = initialResponse.headers.get('content-type') || '';
    console.log(`Workspace awal selesai. Content-Type: ${contentType}, Status: ${initialResponse.status}`);


    // Hanya gunakan Puppeteer jika Content-Type adalah HTML dan fetch awal mungkin diblokir (misal 403/404 pada HTML)
    // Atau Anda bisa selalu menggunakan Puppeteer untuk HTML jika rendering JS selalu dibutuhkan.
    // Untuk mengatasi 403, kita akan coba Puppeteer jika fetch awal gagal atau mengembalikan 403/404 pada HTML.
    // ATAU, kita bisa langsung menggunakan Puppeteer untuk SEMUA HTML karena situs mungkin selalu butuh JS rendering.
    // Mari kita asumsikan situs ini SELALU butuh JS rendering untuk HTML.
    if (contentType.includes('text/html')) {
         console.log(`Content-Type adalah HTML (${contentType}), memproses dengan Puppeteer...`);

         type CachedDataType = { html: string; headers: Record<string, string> };

         const cacheKey = finalTargetUrlString; // Gunakan finalTargetUrlString sebagai key untuk cache KV
         const cachedDataJson = await env.BROWSER_KV_DEMO.get(cacheKey, { type: "text" });
         const cachedData: CachedDataType | null = cachedDataJson ? JSON.parse(cachedDataJson) : null;

         let htmlContent: string | null = null;
         let headersToReturn = new Headers();
         let finalStatus = 200; // Default status jika dari cache atau berhasil

         if (cachedData) {
             console.log(`Konten HTML dan header ditemukan di cache KV untuk ${cacheKey}.`);
             htmlContent = cachedData.html;
             headersToReturn = new Headers(cachedData.headers); // Gunakan header dari cache
             finalStatus = 200; // Status OK untuk respons dari cache

         } else {
             // Cache miss: Jalankan browser untuk mengambil konten HTML yang dirender dan header
             console.log(`Cache miss untuk ${cacheKey}. Meluncurkan Puppeteer...`);
             const browser = await puppeteer.launch(env.MYBROWSER);
             const page = await browser.newPage();

             try {
                 // Set User-Agent dan header tambahan lainnya untuk Puppeteer
                 await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
                 await page.setExtraHTTPHeaders({
                     'Accept': BROWSER_HEADERS['Accept'],
                     'Accept-Language': BROWSER_HEADERS['Accept-Language'],
                     'Referer': baseUrlString // Atur Referer ke base URL
                     // Tambahkan header lain jika perlu
                 });

                 console.log(`Membuka URL ${finalTargetUrlString} dengan Puppeteer, menunggu 'networkidle0'...`);
                 const puppeteerResponse = await page.goto(finalTargetUrlString, { waitUntil: 'networkidle0' });

                 if (!puppeteerResponse) {
                      // Ini bisa terjadi jika navigasi tidak berhasil (misal redirect non-HTTP)
                      throw new Error("Navigasi Puppeteer gagal atau tidak mengembalikan respons utama.");
                 }

                 finalStatus = puppeteerResponse.status(); // Ambil status dari respons Puppeteer
                 console.log(`Navigasi Puppeteer selesai. Status: ${finalStatus}`);

                 // Jika status dari Puppeteer adalah 403 atau 404, mungkin server memang menolak atau halaman tidak ada.
                 // Kita bisa memilih untuk mengembalikan status ini atau melempar error.
                 // Untuk saat ini, kita akan ambil kontennya jika memungkinkan dan simpan/kembalikan status aslinya.
                 // Jika statusnya error non-403/404 yang parah (misal 5xx), pertimbangkan melempar error.
                 if (finalStatus >= 400 && finalStatus !== 403 && finalStatus !== 404) {
                      console.warn(`Puppeteer mengembalikan status ${finalStatus}. Mencoba tetap mengambil konten.`);
                      // throw new Error(`Puppeteer mengembalikan status error: ${finalStatus}`); // Opsi: lempar error
                 }


                 // Ambil header dari respons Puppeteer
                 const targetHeadersResult = puppeteerResponse.headers();
                 let copiedHeaders: Record<string, string> = {};

                 if (targetHeadersResult) { // puppeteerResponse.headers() mengembalikan Record<string, string>
                      copiedHeaders = copyFilteredHeaders(targetHeadersResult);
                      console.log('Headers dari respons Puppeteer berhasil disalin.');
                 } else {
                      console.warn("Peringatan: puppeteerResponse.headers() mengembalikan null.");
                      console.log('Menggunakan header kosong untuk respons Puppeteer.');
                 }

                 // Ambil konten HTML *setelah* render oleh Puppeteer
                 htmlContent = await page.content();
                 console.log('Konten HTML diambil dari Puppeteer.');

                 // Simpan konten HTML dan header yang disaring ke KV
                 await env.BROWSER_KV_DEMO.put(cacheKey, JSON.stringify({ html: htmlContent, headers: copiedHeaders }), {
                   expirationTtl: 60 * 60 * 24, // Cache selama 24 jam
                   type: "text" // Simpan sebagai teks (string JSON)
                 });
                 console.log(`Konten HTML dan header baru di-cache untuk ${cacheKey}.`);

                 headersToReturn = new Headers(copiedHeaders); // Gunakan header yang disalin (bisa kosong)

             } catch (error: any) {
                 console.error(`Error saat memproses URL ${finalTargetUrlString} dengan Puppeteer:`, error);
                 const errorMessage = `Error saat mengambil atau memproses halaman dengan Puppeteer: ${error.message}`;
                 // Tangani error saat memproses dengan Puppeteer
                 return new Response(errorMessage, { status: 500 });
             } finally {
                 // Pastikan browser Puppeteer ditutup
                 if (browser) {
                     await browser.close();
                     console.log("Browser Puppeteer ditutup.");
                 }
             }
         }

         // Kembalikan konten HTML yang dirender dengan header yang disalin/dari cache
         if (htmlContent !== null) {
              // Pastikan Content-Type selalu text/html saat mengembalikan konten HTML yang dirender Puppeteer
              headersToReturn.set('content-type', 'text/html; charset=utf-8');
              // Tidak ada lagi injeksi script JS kustom di sini

              const finalResponse = new Response(htmlContent, { // Mengembalikan konten HTML tanpa modifikasi replace
                  headers: headersToReturn, // Gunakan header yang disalin/dari cache + Content-Type yang benar
                  status: finalStatus, // Gunakan status dari Puppeteer atau 200 jika dari cache
                  statusText: finalStatus === 200 ? 'OK' : undefined, // Set statusText hanya jika 200, biarkan undefined untuk status lain agar default
              });
              return finalResponse;

         } else {
              // Fallback jika somehow htmlContent masih null setelah mencoba memproses
              console.error("htmlContent null setelah proses Puppeteer atau cache.");
              return new Response("Gagal mengambil atau menghasilkan konten HTML.", { status: 500 });
         }

    } else {
        // Mengembalikan objek Response dari fetch() secara langsung untuk konten non-HTML.
        // Klon respons awal agar body bisa dibaca Worker dan dikembalikan dengan benar.
        // Header dari initialResponse sudah mencakup header asli dari server target + header yg mungkin ditambahkan CF.
        // Kita bisa memilih untuk menyaring header ini juga jika perlu, tapi biasanya untuk non-HTML
        // mengembalikan apa adanya lebih aman kecuali header tertentu menyebabkan masalah.
        // Untuk saat ini, kembalikan apa adanya.
        console.log(`Content-Type bukan HTML (${contentType}), mengembalikan respons asli dari fetch awal (Status: ${initialResponse.status})...`);
        return new Response(initialResponse.body, {
            status: initialResponse.status,
            statusText: initialResponse.statusText,
            headers: initialResponse.headers, // Menggunakan header asli dari fetch awal
        });
    }
  },
} as ExportedHandler<Env>;
