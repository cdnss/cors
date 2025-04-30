import * as cheerio from 'cheerio'; // Menggunakan namespace import

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

// Fungsi bantu untuk memeriksa apakah URL absolut
function isAbsoluteUrl(url: string): boolean {
    // Memeriksa apakah URL dimulai dengan skema (misal: http:, https:, //)
    // Ini adalah cek sederhana, bisa disempurnakan jika perlu
    return /^(?:[a-z]+:)?\/\//i.test(url);
}


export default {
  async fetch(request, env): Promise<Response> {
    const { searchParams } = new URL(request.url);
    let url = searchParams.get("url");

    if (!url) {
      return new Response("Mohon tambahkan parameter ?url=https://example.com/");
    }

    const targetUrl = new URL(url); // Gunakan objek URL untuk resolusi URL dasar nanti
    const urlString = targetUrl.toString(); // Gunakan string untuk fetch dan KV key

    // Langkah 1: Lakukan fetch standar terlebih dahulu untuk cek tipe konten
    const initialResponse = await fetch(urlString);
    const contentType = initialResponse.headers.get('content-type') || '';

    // Cek jika kontennya adalah HTML dan perlu Puppeteer
    if (contentType.includes('text/html')) {
         console.log(`Content-Type adalah HTML (${contentType}), memproses dengan Puppeteer + Cheerio...`);

         type CachedDataType = { html: string; headers: Record<string, string> };

         // Gunakan urlString sebagai key untuk KV
         const cachedDataJson = await env.BROWSER_KV_DEMO.get(urlString, { type: "text" });
         const cachedData: CachedDataType | null = cachedDataJson ? JSON.parse(cachedDataJson) : null;

         let htmlContent: string | null = null;
         let headersToReturn = new Headers();

         if (cachedData) {
             console.log('Konten HTML dan header ditemukan di cache.');
             htmlContent = cachedData.html;
             headersToReturn = new Headers(cachedData.headers);

         } else {
             // Cache miss: Jalankan browser untuk mengambil konten HTML yang dirender dan header
             const browser = await puppeteer.launch(env.MYBROWSER);
             const page = await browser.newPage();

             // Tidak perlu listener konsol Puppeteer lagi karena tidak menggunakan evaluate untuk debugging
             // page.on('console', ...);
             // page.on('pageerror', ...);


             try {
                 console.log(`Membuka URL ${urlString} dengan Puppeteer, menunggu 'networkidle0'...`);
                 const puppeteerResponse = await page.goto(urlString, { waitUntil: 'networkidle0' });

                 if (!puppeteerResponse) {
                      throw new Error("Navigasi Puppeteer gagal atau tidak mengembalikan respons utama.");
                 }

                 console.log(`Navigasi Puppeteer selesai. Status: ${puppeteerResponse.status()}`);

                 const targetHeadersResult = puppeteerResponse.headers();
                 let copiedHeaders: Record<string, string> = {};

                 if (targetHeadersResult && typeof targetHeadersResult[Symbol.iterator] === 'function') {
                      copiedHeaders = copyFilteredHeaders(targetHeadersResult);
                      console.log('Headers dari respons Puppeteer berhasil disalin.');
                 } else {
                      console.warn("Peringatan: Hasil dari puppeteerResponse.headers() tidak iterable atau null.", targetHeadersResult);
                      console.log('Menggunakan header kosong untuk respons Puppeteer guna menghindari error.');
                 }

                 // Ambil konten HTML *setelah* render oleh Puppeteer sebagai STRING
                 const rawHtmlFromPuppeteer = await page.content();
                 console.log('Konten HTML diambil dari Puppeteer.');

                 // *** MANIPULASI HTML MENGGUNAKAN CHEERIO ***
                 console.log('Memulai parsing dan manipulasi HTML string dengan Cheerio...');
                 
                 // Dapatkan kembali string HTML yang sudah dimodifikasi dari Cheerio
                 htmlContent = rawHtmlFromPuppeteer;
                 console.log('Manipulasi HTML string dengan Cheerio selesai.');
                 // *** AKHIR MANIPULASI CHEERIO ***


                 // Simpan konten HTML (yang sudah dimodifikasi) dan header yang disaring ke KV
                 // Gunakan urlString sebagai key
                 await env.BROWSER_KV_DEMO.put(urlString, JSON.stringify({ html: htmlContent, headers: copiedHeaders }), {
                   expirationTtl: 60 * 60 * 24,
                   type: "text"
                 });
                 console.log('Konten HTML (dimodifikasi) dan header baru di-cache.');

                 headersToReturn = new Headers(copiedHeaders); // Gunakan header yang disalin (bisa kosong)

             } catch (error: any) {
                 console.error(`Error saat memproses URL ${urlString} dengan Puppeteer/Cheerio:`, error);
                 const errorMessage = `Error saat mengambil atau memproses halaman: ${error.message}`;
                 // Jika Puppeteer gagal, kembalikan respons error
                 return new Response(errorMessage, { status: 500 });
             } finally {
                 // Pastikan browser Puppeteer ditutup
                 if (browser) {
                     await browser.close();
                 }
             }
         }

         // Kembalikan konten HTML yang dirender dan dimodifikasi dengan header yang disalin/dari cache
         if (htmlContent !== null) {
              // Pastikan Content-Type selalu text/html saat mengembalikan konten HTML
              headersToReturn.set('content-type', 'text/html; charset=utf-8');
const $ = cheerio.load(htmlContent); // Parsing string HTML dengan Cheerio

                 // 1. Hapus tag script yang mengandung "console" di dalamnya atau di src-nya
                 $('script').each((i, el) => { // Pilih semua tag script dan iterasi
                     const script = $(el); // Bungkus elemen saat ini dengan objek Cheerio

                     // Dapatkan konten script inline (jika ada) dan atribut src
                     const inlineContent = script.html(); // Gunakan .html() untuk mendapatkan konten inline
                     const srcAttribute = script.attr('src');

                     // Periksa apakah "console" ada di konten inline ATAU di atribut src
                     const hasConsoleInContent = inlineContent && inlineContent.includes('console');
                     const hasConsoleInSrc = srcAttribute && srcAttribute.includes('console');

                     if (hasConsoleInContent || hasConsoleInSrc) {
                         console.log('Menghapus tag script mengandung "console":', srcAttribute || (inlineContent || '').substring(0, 50) + '...'); // Log di konsol Worker
                         script.remove(); // Hapus elemen script dari struktur Cheerio
                     }
                 });

                 // 2. Buat script src menjadi URL lengkap/absolut
                 $('script[src]').each((i, el) => { // Pilih semua tag script yang memiliki atribut src
                     const script = $(el);
                     const originalSrc = script.attr('src'); // Ambil nilai atribut src asli

                     // Periksa apakah src asli ada dan bukan URL absolut
                     if (originalSrc && !isAbsoluteUrl(originalSrc)) {
                        try {
                           // Selesaikan URL relatif menggunakan URL dasar dari halaman (targetUrl)
                           const absoluteSrc = new URL(originalSrc, targetUrl).toString();

                           // Setel ulang atribut src ke URL absolut yang sudah terselesaikan
                           // Cek tambahan untuk menghindari setAttribute jika src asli sama dengan resolved (misal: sudah absolut)
                           if (originalSrc !== absoluteSrc) {
                               console.log(`Membuat src script absolut: ${originalSrc} -> ${absoluteSrc}`); // Log di konsol Worker
                               script.attr('src', absoluteSrc); // Update atribut src
                           }
                        } catch (e: any) {
                           console.error(`Error menyelesaikan URL script ${originalSrc} relatif terhadap ${targetUrl.toString()}:`, e);
                           // Opsional: Anda bisa memilih untuk menghapus script jika URL-nya tidak valid
                           // script.remove();
                        }
                     }
                 });

              const finalResponse = new Response(htmlContent.replace("p style","p data-s").replace("donate","ll").replace("onclick","data-on").replace("devtool","l").replace(/src="/g,'src="https://cloud.hownetwork.xyz').replace(".xyzjs",".xyz/js"), {
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
