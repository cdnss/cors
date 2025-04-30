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
    if (contentType.includes('text/html')) {
         console.log(`Content-Type adalah HTML (${contentType}), memproses dengan Puppeteer...`);

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
                      console.log('Menggunakan header kosong untuk respons Puppeteer guna menghindari error.');
                 }

                 // *** LAKUKAN MANIPULASI DOM DI SINI MENGGUNAKAN PAGE.EVALUATE ***
                 console.log('Memulai manipulasi DOM: menghapus script "console" & membuat src absolut...');
                 await page.evaluate(() => {
                   // 1. Hapus tag script yang mengandung "console" di dalam kontennya
                   // Kita ambil semua script
                   const scripts = document.querySelectorAll('script');
                   scripts.forEach(script => {
                     // Cek jika script ini inline dan mengandung teks "console"
                     // atau jika script ini eksternal dan src-nya mengandung "console"
                     // Permintaan Anda "tag script yang mengandung console" bisa berarti keduanya.
                     // Implementasi ini menghapus yang inline jika mengandung "console" ATAU yang eksternal jika src-nya mengandung "console".
                     const hasConsoleInContent = script.textContent && script.textContent.includes('console');
                     const hasConsoleInSrc = script.src && script.src.includes('console');

                     if (hasConsoleInContent || hasConsoleInSrc) {
                         console.log('Removing script tag containing "console" (inline or src):', script.src || (script.textContent || '').substring(0, 50) + '...');
                         script.parentNode?.removeChild(script);
                     }
                   });

                   // 2. Buat script src menjadi URL lengkap/absolut
                   // Pilih script yang masih ada (belum dihapus) dan memiliki atribut 'src'
                   const remainingScriptWithSrc = document.querySelectorAll('script[src]');
                   remainingScriptWithSrc.forEach(script => {
                     // Properti .src pada elemen script (atau elemen lain seperti <a>, <img>, <link>)
                     // secara otomatis berisi URL absolut yang telah diselesaikan oleh browser
                     // berdasarkan URL halaman saat ini.
                     const absoluteSrc = script.src;
                     const originalSrcAttribute = script.getAttribute('src'); // Ambil nilai atribut asli

                     // Jika nilai atribut src asli berbeda dengan URL absolut yang sudah terselesaikan oleh browser,
                     // berarti itu adalah URL relatif atau ada perbedaan lain (misal: skema http vs https).
                     // Kita setel ulang atribut src ke URL absolut yang sudah terselesaikan.
                     if (absoluteSrc && originalSrcAttribute !== absoluteSrc) {
                         // console.log(`Making src absolute: ${originalSrcAttribute} -> ${absoluteSrc}`);
                         script.setAttribute('src', absoluteSrc);
                     }
                   });

                   // Anda bisa tambahkan manipulasi DOM lainnya di sini jika diperlukan
                 });
                 console.log('Manipulasi DOM selesai.');
                 // *** AKHIR MANIPULASI DOM ***


                 htmlContent = await page.content(); // Ambil konten HTML *setelah* manipulasi DOM
                 console.log('Konten HTML diambil setelah manipulasi.');

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
              // Pastikan Content-Type selalu text/html saat mengembalikan konten HTML
              headersToReturn.set('content-type', 'text/html; charset=utf-8');

              const finalResponse = new Response(htmlContent.replace("devtool","ww"), {
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
        return initialResponse;
    }
  },
} as ExportedHandler<Env>;
