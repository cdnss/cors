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
// Asumsi: Menerima objek yang bisa di-iterate (akan divalidasi sebelum dipanggil).
function copyFilteredHeaders(originalHeaders: Headers | Map<string, string>): Record<string, string> {
    const copied: Record<string, string> = {};
    // Loop melalui header (diasumsikan sudah iterable karena validasi sebelumnya)
    for (const [name, value] of originalHeaders) {
        const lowerName = name.toLowerCase();
        // Salin jika tidak ada di denylist dan bukan header Cloudflare spesifik
        if (!HEADERS_DENY_LIST.includes(lowerName) && !lowerName.startsWith('cf-')) {
            copied[name] = value;
        }
    }
    return copied;
}


export default {
  async fetch(request, env): Promise<Response> {
    const { searchParams } = new URL(request.url);
    let url = searchParams.get("url");

    if (!url) {
      return new Response("Mohon tambahkan parameter ?url=https://example.com/");
    }

    url = new URL(url).toString(); // normalisasi URL

    // Langkah 1: Lakukan fetch standar terlebih dahulu untuk cek tipe konten
    const initialResponse = await fetch(url);
    const contentType = initialResponse.headers.get('content-type') || '';

    // Cek jika kontennya adalah HTML dan perlu Puppeteer
    // (Kita asumsikan semua konten text/html memerlukan Puppeteer berdasarkan riwayat permintaan Anda)
    if (contentType.includes('text/html')) {
         console.log(`Content-Type adalah HTML (${contentType}), memproses dengan Puppeteer...`);

         // Struktur data yang disimpan di KV akan mencakup HTML dan header
         type CachedDataType = { html: string; headers: Record<string, string> };

         // Coba ambil konten HTML dan header dari cache KV
         const cachedDataJson = await env.BROWSER_KV_DEMO.get(url, { type: "text" });
         const cachedData: CachedDataType | null = cachedDataJson ? JSON.parse(cachedDataJson) : null;

         let htmlContent: string | null = null;
         let headersToReturn = new Headers(); // Gunakan objek Headers untuk respons

         if (cachedData) {
             console.log('Konten HTML dan header ditemukan di cache.');
             htmlContent = cachedData.html;
             headersToReturn = new Headers(cachedData.headers); // Gunakan header dari cache

         } else {
             // Cache miss: Jalankan browser untuk mengambil konten HTML yang dirender dan header
             const browser = await puppeteer.launch(env.MYBROWSER);
             const page = await browser.newPage();

             try {
                 console.log(`Membuka URL ${url} dengan Puppeteer, menunggu 'networkidle0'...`);
                 const puppeteerResponse = await page.goto(url, { waitUntil: 'networkidle0' });

                 if (!puppeteerResponse) {
                      throw new Error("Navigasi Puppeteer gagal atau tidak mengembalikan respons utama.");
                 }

                 console.log(`Navigasi Puppeteer selesai. Status: ${puppeteerResponse.status()}`);

                 const targetHeadersResult = puppeteerResponse.headers(); // Ambil hasil dari headers()
                 let copiedHeaders: Record<string, string> = {}; // Siapkan objek untuk header yang akan disalin

                 // Cek apakah hasil dari headers() valid dan bisa di-iterate
                 if (targetHeadersResult && typeof targetHeadersResult[Symbol.iterator] === 'function') {
                      copiedHeaders = copyFilteredHeaders(targetHeadersResult); // Panggil fungsi copy jika valid
                      console.log('Headers dari respons Puppeteer berhasil disalin.');
                 } else {
                      // Jika tidak valid, cetak peringatan dan gunakan objek header kosong
                      console.warn("Peringatan: Hasil dari puppeteerResponse.headers() tidak iterable atau null.", targetHeadersResult);
                      console.log('Menggunakan header kosong untuk respons Puppeteer.');
                 }

                 // Ambil seluruh konten HTML halaman setelah menunggu networkidle0
                 htmlContent = await page.content();
                 console.log('Konten HTML diambil.');

                 // Simpan konten HTML dan header yang disaring ke KV
                 await env.BROWSER_KV_DEMO.put(url, JSON.stringify({ html: htmlContent, headers: copiedHeaders }), {
                   expirationTtl: 60 * 60 * 24, // Cache selama 24 jam
                   type: "text" // Simpan sebagai teks (string JSON)
                 });
                 console.log('Konten HTML dan header baru di-cache.');

                 headersToReturn = new Headers(copiedHeaders); // Gunakan header yang disalin (bisa kosong)

             } catch (error: any) {
                 console.error(`Error saat memproses URL ${url} dengan Puppeteer:`, error);
                 const errorMessage = `Error saat mengambil atau memproses halaman dengan Puppeteer: ${error.message}`;
                 return new Response(errorMessage, { status: 500 }); // Kembalikan respons error
             } finally {
                 // Pastikan browser ditutup
                 if (browser) {
                     await browser.close();
                 }
             }
         }

         // Kembalikan konten HTML yang dirender dengan header yang disalin/dari cache
         if (htmlContent !== null) {
              // *** PERBAIKAN UNTUK MASALAH HTML MENTAH ***
              // SETEL Content-Type secara eksplisit ke text/html
              headersToReturn.set('content-type', 'text/html; charset=utf-8');

              const finalResponse = new Response(htmlContent.replace("devtool","wowo"), {
                  headers: headersToReturn, // Gunakan header yang disalin/dari cache + Content-Type yang benar
                  status: cachedData ? 200 : initialResponse.status, // Gunakan status asli kecuali dari cache (200 OK)
                  statusText: cachedData ? 'OK' : initialResponse.statusText, // Gunakan status text asli
              });
              return finalResponse;

         } else {
              // Fallback jika somehow htmlContent masih null
              return new Response("Gagal mengambil atau menghasilkan konten HTML.", { status: 500 });
         }

    } else {
        // Jika kontennya BUKAN HTML, langsung kembalikan respons dari fetch awal
        console.log(`Content-Type bukan HTML (${contentType}), mengembalikan respons asli...`);
        // Mengembalikan objek Response dari fetch() secara langsung akan menyertakan body dan header asli.
        return initialResponse;
    }
  },
} as ExportedHandler<Env>;
