import puppeteer from "@cloudflare/puppeteer";

interface Env {
  MYBROWSER: Fetcher; // Binder untuk Browserless
  // BROWSER_KV_DEMO: KVNamespace; // Dihapus: Binder untuk KV Namespace
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
    'cf-ray', // Header spesifik Cloudflare (juga difilter di fungsi copy)
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
        // Filter header yang ada di deny list atau dimulai dengan 'cf-'
        if (!HEADERS_DENY_LIST.includes(lowerName) && !lowerName.startsWith('cf-')) {
            copied[name] = value;
        }
    }
    return copied;
}

// Header umum yang menyerupai browser sungguhan
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', // Contoh User-Agent Chrome
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8', // Tambahkan bahasa
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
    const initialStatus = initialResponse.status; // Simpan status awal
    console.log(`Workspace awal selesai. Content-Type: ${contentType}, Status: ${initialStatus}`);


    // Gunakan Puppeteer jika Content-Type adalah HTML atau jika fetch awal mengindikasikan masalah (misal status non-2xx yang bukan resource)
    // Kami akan berasumsi jika status awal non-2xx dan Content-Type bukan resource (seperti gambar/css/js), mungkin perlu Puppeteer
    if (contentType.includes('text/html') || (initialStatus >= 400 && !contentType.match(/image|font|css|javascript/i))) {
         console.log(`Content-Type adalah HTML (${contentType}) atau status awal error (${initialStatus}), memproses dengan Puppeteer...`);

         let htmlContent: string | null = null;
         let headersToReturn = new Headers();
         let finalStatus = 200; // Default status jika berhasil Puppeteer

         // Jalankan browser untuk mengambil konten HTML yang dirender dan header
         console.log(`Meluncurkan Puppeteer...`);
         const browser = await puppeteer.launch(env.MYBROWSER);
         const page = await browser.newPage();

         try {
             await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
             await page.setExtraHTTPHeaders({
                 'Accept': BROWSER_HEADERS['Accept'],
                 'Accept-Language': BROWSER_HEADERS['Accept-Language'],
                 'Referer': baseUrlString // Atur Referer ke base URL situs target
             });

             console.log(`Membuka URL ${finalTargetUrlString} dengan Puppeteer, menunggu 'networkidle0'...`);
             const puppeteerResponse = await page.goto(finalTargetUrlString, { waitUntil: 'networkidle0' });

             if (!puppeteerResponse) {
                 // Ini bisa terjadi jika navigasi diblokir atau gagal sebelum respons
                 throw new Error("Navigasi Puppeteer gagal atau tidak mengembalikan respons utama.");
             }

             finalStatus = puppeteerResponse.status();
             console.log(`Navigasi Puppeteer selesai. Status: ${finalStatus}`);

             // --- TAMBAHAN: Cek apakah ini halaman tantangan Cloudflare ---
             const pageContent = await page.content();
             const isCloudflareChallenge =
                 finalStatus === 403 || finalStatus === 503 || // Status umum untuk diblokir/challenge
                 pageContent.includes('g-recaptcha') || // Sering ada reCAPTCHA
                 pageContent.includes('cf-challenge') || // Elemen spesifik Cloudflare
                 pageContent.includes('/cdn-cgi/challenge-platform/') || // URL script tantangan
                 pageContent.includes('var s,t,o,p,r,e,q,l=') // Pola script JS challenge umum

             if (isCloudflareChallenge) {
                 console.warn(`Halaman ${finalTargetUrlString} memicu tantangan Cloudflare atau error.`);
                 // Alih-alih throw error, kita bisa langsung mengembalikan respons error di sini
                   return new Response("Akses diblokir oleh keamanan situs target.", { status: 503, statusText: 'Service Unavailable - Challenge Blocked' });
             }
             // --- AKHIR TAMBAHAN ---

             // Jika bukan tantangan, lanjutkan proses normal
             htmlContent = pageContent; // Gunakan pageContent yang sudah diambil
             console.log('Konten HTML diambil dari Puppeteer.');

             const targetHeadersResult = puppeteerResponse.headers();
             if (targetHeadersResult) {
                 headersToReturn = new Headers(copyFilteredHeaders(targetHeadersResult)); // Gunakan header yang disaring
                 console.log('Headers dari respons Puppeteer berhasil disalin.');
             } else {
                 console.warn("Peringatan: puppeteerResponse.headers() mengembalikan null.");
                 headersToReturn = new Headers(); // Mulai dengan Headers kosong jika null
             }

         } catch (error: any) {
             console.error(`Error saat memproses URL ${finalTargetUrlString} dengan Puppeteer:`, error);
             const errorMessage = `Gagal mengambil atau memproses halaman dengan Puppeteer: ${error.message}`;
             // Tangani error saat memproses dengan Puppeteer
             return new Response(errorMessage, { status: 500 });
         } finally {
             // Pastikan browser Puppeteer ditutup
             if (browser) {
                 await browser.close();
                 console.log("Browser Puppeteer ditutup.");
             }
         }

         // Kembalikan konten HTML yang dirender dengan header yang disalin
         if (htmlContent !== null) {
              // Pastikan Content-Type selalu text/html saat mengembalikan konten HTML yang dirender Puppeteer
              headersToReturn.set('content-type', 'text/html; charset=utf-8');

              const finalResponse = new Response(htmlContent, { // Mengembalikan konten HTML
                  headers: headersToReturn, // Gunakan header yang disalin + Content-Type yang benar
                  status: finalStatus, // Gunakan status dari Puppeteer
                  statusText: finalStatus === 200 ? 'OK' : undefined,
              });
              return finalResponse;

         } else {
              console.error("htmlContent null setelah proses Puppeteer.");
              return new Response("Gagal mengambil atau menghasilkan konten HTML.", { status: 500 });
         }

    } else {
        // --- BLOK INI MENANGANI PERMINTAAN UNTUK SUMBER DAYA NON-HTML ---
        // Ini adalah logika yang sudah ada dan tidak menggunakan Puppeteer atau KV
        console.log(`Content-Type bukan HTML (${contentType}), memproses permintaan sumber daya untuk ${finalTargetUrlString}...`);

        // Lakukan fetch ulang untuk sumber daya ini dengan header yang tepat, termasuk Referer
        try {
            const resourceResponse = await fetch(finalTargetUrlString, {
                headers: {
                    // Salin header dari BROWSER_HEADERS (User-Agent, Accept, Accept-Language)
                    ...BROWSER_HEADERS,
                    // Tambahkan Referer yang mengarah ke base URL situs target
                    'Referer': baseUrlString
                    // Anda bisa menambahkan header lain dari 'request' asli jika dianggap perlu,
                    // tapi pastikan tidak meneruskan header yang bisa mengidentifikasi Worker/pengguna.
                    // Misalnya: 'Accept-Encoding': request.headers.get('Accept-Encoding'),
                }
            });

            console.log(`Workspace sumber daya selesai. Status: ${resourceResponse.status}`);

            // Mengembalikan respons sumber daya apa adanya dari server target
            return new Response(resourceResponse.body, {
                status: resourceResponse.status,
                statusText: resourceResponse.statusText,
                headers: resourceResponse.headers, // Menggunakan header asli dari fetch sumber daya
            });
        } catch (error: any) {
             console.error(`Error saat fetch sumber daya ${finalTargetUrlString}:`, error);
             // Jika fetch sumber daya gagal (misal timeout, masalah jaringan), kembalikan error
             return new Response(`Gagal memuat sumber daya: ${error.message}`, { status: 500 });
        }
    }
  },
} as ExportedHandler<Env>;
