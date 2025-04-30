import puppeteer from "@cloudflare/puppeteer";
// import cheerio from 'cheerio'; // Pastikan cheerio tetap dihapus

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
function copyFilteredHeaders(originalHeaders: Headers | Map<string, string>): Record<string, string> {
    const copied: Record<string, string> = {};
    for (const [name, value] of originalHeaders) {
        const lowerName = name.toLowerCase();
        if (!HEADERS_DENY_LIST.includes(lowerName) && !lowerName.startsWith('cf-')) {
            copied[name] = value;
        }
    }
    return copied;
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> { // Gunakan tipe Request
    // Konstruksi final target URL berdasarkan base URL tetap dan path/query dari request masuk
    const baseUrlString = 'https://cloud.hownetwork.xyz';
    const incomingUrl = new URL(request.url);
    const finalTargetUrl = new URL(incomingUrl.pathname + incomingUrl.search, baseUrlString);
    const finalTargetUrlString = finalTargetUrl.toString();

    console.log(`Menerima permintaan untuk ${incomingUrl.pathname}${incomingUrl.search}, menargetkan URL: ${finalTargetUrlString}`);

    // Langkah 1: Lakukan fetch standar terlebih dahulu untuk mendapatkan status, header, dan cek tipe konten
    const initialResponse = await fetch(finalTargetUrlString);
    const contentType = initialResponse.headers.get('content-type') || '';
    console.log(`Workspace awal selesai. Content-Type: ${contentType}`);

    // *** PERUBAHAN: KEMBALIKAN PERCABANGAN BERDASARKAN CONTENT-TYPE ***
    // Hanya gunakan Puppeteer jika Content-Type adalah HTML
    if (contentType.includes('text/html')) {
         console.log(`Content-Type adalah HTML, memproses dengan Puppeteer...`);

         type CachedDataType = { html: string; headers: Record<string, string> };

         // Gunakan finalTargetUrlString sebagai key untuk cache KV
         const cachedDataJson = await env.BROWSER_KV_DEMO.get(finalTargetUrlString, { type: "text" });
         const cachedData: CachedDataType | null = cachedDataJson ? JSON.parse(cachedDataJson) : null;

         let htmlContent: string | null = null;
         let headersToReturn = new Headers();

         if (cachedData) {
             console.log(`Konten HTML dan header ditemukan di cache KV untuk ${finalTargetUrlString}.`);
             htmlContent = cachedData.html;
             headersToReturn = new Headers(cachedData.headers); // Gunakan header dari cache

         } else {
             // Cache miss: Jalankan browser untuk mengambil konten HTML yang dirender dan header
             const browser = await puppeteer.launch(env.MYBROWSER);
             const page = await browser.newPage();

             // Hapus listener konsol/error Puppeteer jika tidak lagi digunakan
             // page.on('console', ...);
             // page.on('pageerror', ...);


             try {
                 console.log(`Membuka URL ${finalTargetUrlString} dengan Puppeteer, menunggu 'networkidle0'...`);
                 const puppeteerResponse = await page.goto(finalTargetUrlString, { waitUntil: 'networkidle0' });

                 if (!puppeteerResponse) {
                      throw new Error("Navigasi Puppeteer gagal atau tidak mengembalikan respons utama.");
                 }

                 console.log(`Navigasi Puppeteer selesai. Status: ${puppeteerResponse.status()}`);

                 // Ambil header dari respons Puppeteer
                 const targetHeadersResult = puppeteerResponse.headers();
                 let copiedHeaders: Record<string, string> = {};

                 if (targetHeadersResult && typeof targetHeadersResult[Symbol.iterator] === 'function') {
                      copiedHeaders = copyFilteredHeaders(targetHeadersResult);
                      console.log('Headers dari respons Puppeteer berhasil disalin.');
                 } else {
                      console.warn("Peringatan: Hasil dari puppeteerResponse.headers() tidak iterable atau null.", targetHeadersResult);
                      console.log('Menggunakan header kosong untuk respons Puppeteer.');
                 }

                 // Ambil konten HTML *setelah* render oleh Puppeteer
                 htmlContent = await page.content();
                 console.log('Konten HTML diambil dari Puppeteer.');

                 // Simpan konten HTML dan header yang disaring ke KV
                 await env.BROWSER_KV_DEMO.put(finalTargetUrlString, JSON.stringify({ html: htmlContent, headers: copiedHeaders }), {
                   expirationTtl: 60 * 60 * 24,
                   type: "text" // Simpan sebagai teks (string JSON)
                 });
                 console.log(`Konten HTML dan header baru di-cache untuk ${finalTargetUrlString}.`);

                 headersToReturn = new Headers(copiedHeaders); // Gunakan header yang disalin (bisa kosong)

             } catch (error: any) {
                 console.error(`Error saat memproses URL ${finalTargetUrlString} dengan Puppeteer:`, error);
                 const errorMessage = `Error saat mengambil atau memproses halaman: ${error.message}`;
                 // Tangani error saat memproses dengan Puppeteer
                 return new Response(errorMessage, { status: 500 });
             } finally {
                 // Pastikan browser Puppeteer ditutup
                 if (browser) {
                     await browser.close();
                 }
             }
         }

         // Kembalikan konten HTML yang dirender dengan header yang disalin/dari cache
         if (htmlContent !== null) {
              // Pastikan Content-Type selalu text/html saat mengembalikan konten HTML yang dirender Puppeteer
              headersToReturn.set('content-type', 'text/html; charset=utf-8');

              const finalResponse = new Response(htmlContent.replace("devtool","l"), {
                  headers: headersToReturn, // Gunakan header yang disalin/dari cache + Content-Type yang benar
                  status: cachedData ? 200 : initialResponse.status, // Gunakan status asli dari fetch awal kecuali dari cache (200 OK)
                  statusText: cachedData ? 'OK' : initialResponse.statusText, // Gunakan status text asli
              });
              return finalResponse;

         } else {
              // Fallback jika somehow htmlContent masih null setelah mencoba memproses
              return new Response("Gagal mengambil atau menghasilkan konten.", { status: 500 });
         }

    } else {
        // *** PERUBAHAN: KEMBALIKAN RESPONS ASLI UNTUK KONTEN NON-HTML ***
        console.log(`Content-Type bukan HTML (${contentType}), mengembalikan respons asli...`);
        // Mengembalikan objek Response dari fetch() secara langsung akan menyertakan body, header, status asli.
        // Klon respons awal agar body bisa dibaca Worker dan dikembalikan dengan benar.
        return new Response(initialResponse.body, {
            status: initialResponse.status,
            statusText: initialResponse.statusText,
            headers: initialResponse.headers,
        });
    }
  },
} as ExportedHandler<Env>;
