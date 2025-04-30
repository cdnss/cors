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

// Hapus fungsi isAbsoluteUrl jika tidak lagi digunakan


export default {
  async fetch(request: Request, env: Env): Promise<Response> { // Gunakan tipe Request
    // *** PERUBAHAN: TANGKAP PATH & PARAMETER DARI REQUEST MASUK ***
    const baseUrlString = 'https://cloud.hownetwork.xyz';
    const incomingUrl = new URL(request.url);

    // Gabungkan base target URL dengan path dan parameter dari request masuk
    // Contoh: https://cloud.hownetwork.xyz + /jalur/sub + ?param=value
    const finalTargetUrl = new URL(incomingUrl.pathname + incomingUrl.search, baseUrlString);
    const finalTargetUrlString = finalTargetUrl.toString();

    console.log(`Menerima permintaan untuk ${incomingUrl.pathname}${incomingUrl.search}, menargetkan URL: ${finalTargetUrlString}`);

    // Langkah 1: Lakukan fetch standar terlebih dahulu untuk mendapatkan status dan header awal
    // Gunakan finalTargetUrlString untuk fetch
    const initialResponse = await fetch(finalTargetUrlString);

    // Diasumsikan target selalu diproses Puppeteer
    console.log(`Memproses target dengan Puppeteer...`);

    type CachedDataType = { html: string; headers: Record<string, string> };

    // Gunakan finalTargetUrlString sebagai key untuk KV
    const cachedDataJson = await env.BROWSER_KV_DEMO.get(finalTargetUrlString, { type: "text" });
    const cachedData: CachedDataType | null = cachedDataJson ? JSON.parse(cachedDataJson) : null;

    let htmlContent: string | null = null;
    let headersToReturn = new Headers();

    if (cachedData) {
        console.log(`Konten dan header ditemukan di cache KV untuk ${finalTargetUrlString}.`);
        htmlContent = cachedData.html;
        headersToReturn = new Headers(cachedData.headers); // Gunakan header dari cache

    } else {
        // Cache miss: Jalankan browser untuk mengambil konten HTML yang dirender dan header
        const browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();

        // Hapus listener konsol/error Puppeteer jika tidak lagi digunakan untuk debugging evaluate
        // page.on('console', ...);
        // page.on('pageerror', ...);


        try {
            console.log(`Membuka URL ${finalTargetUrlString} dengan Puppeteer, menunggu 'networkidle0'...`);
            // Gunakan finalTargetUrlString untuk page.goto
            const puppeteerResponse = await page.goto(finalTargetUrlString, { waitUntil: 'networkidle0' });

            if (!puppeteerResponse) {
                 throw new Error("Navigasi Puppeteer gagal atau tidak mengembalikan respons utama.");
            }

            console.log(`Navigasi Puppeteer selesai. Status: ${puppeteerResponse.status()}`);

            const targetHeadersResult = puppeteerResponse.headers(); // Ambil hasil dari headers()
            let copiedHeaders: Record<string, string> = {}; // Siapkan objek untuk header yang akan disalin

            if (targetHeadersResult && typeof targetHeadersResult[Symbol.iterator] === 'function') {
                 copiedHeaders = copyFilteredHeaders(targetHeadersResult); // Panggil fungsi copy jika valid
                 console.log('Headers dari respons Puppeteer berhasil disalin.');
            } else {
                 console.warn("Peringatan: Hasil dari puppeteerResponse.headers() tidak iterable atau null.", targetHeadersResult);
                 console.log('Menggunakan header kosong untuk respons Puppeteer.');
            }

            // Ambil konten HTML *setelah* render oleh Puppeteer TANPA MANIPULASI
            htmlContent = await page.content();
            console.log('Konten HTML diambil dari Puppeteer (tanpa manipulasi).');

            // Simpan konten HTML (yang asli dari Puppeteer) dan header yang disaring ke KV
            // Gunakan finalTargetUrlString sebagai key
            await env.BROWSER_KV_DEMO.put(finalTargetUrlString, JSON.stringify({ html: htmlContent, headers: copiedHeaders }), {
              expirationTtl: 60 * 60 * 24, // Cache selama 24 jam
              type: "text" // Simpan sebagai teks (string JSON)
            });
            console.log(`Konten HTML (tanpa manipulasi) dan header baru di-cache untuk ${finalTargetUrlString}.`);

            headersToReturn = new Headers(copiedHeaders); // Gunakan header yang disalin (bisa kosong)

        } catch (error: any) {
            console.error(`Error saat memproses URL ${finalTargetUrlString} dengan Puppeteer:`, error);
            const errorMessage = `Error saat mengambil atau memproses halaman: ${error.message}`;
            return new Response(errorMessage, { status: 500 }); // Kembalikan respons error
        } finally {
            // Pastikan browser Puppeteer ditutup
            if (browser) {
                await browser.close();
            }
        }
    }

    // Kembalikan konten HTML yang dirender (tanpa manipulasi) dengan header yang disalin/dari cache
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
         // Fallback jika somehow htmlContent masih null
         return new Response("Gagal mengambil atau menghasilkan konten.", { status: 500 });
    }
  },
} as ExportedHandler<Env>;
