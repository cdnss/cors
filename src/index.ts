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
              var js = `
// Tunggu hingga seluruh halaman (termasuk semua script dan aset) selesai dimuat
window.addEventListener('load', function() {
    console.log("Event 'load' terdeteksi. Halaman penuh telah dimuat. Mencoba mendapatkan data pemain...");

    let playerData = null;

    // Coba ambil data *setelah* event 'load' terjadi
    // Ini memberi kesempatan script asli untuk mendefinisikan window.clientSide.pl
    if (window.clientSide &&
        window.clientSide.pl &&
        window.clientSide.pl.sources &&
        Array.isArray(window.clientSide.pl.sources) &&
        window.clientSide.pl.sources.length > 0
    ) {
        playerData = window.clientSide.pl.sources[0];
        console.log("Data konfigurasi pemain berhasil ditemukan di window.clientSide.pl.sources[0].");
        // console.log(playerData); // Opsi: tampilkan data untuk konfirmasi

        // Definisikan fungsi yang akan dijalankan saat klik, di dalam scope ini
        // sehingga playerData dapat diakses
        function handlePlayClick() {
            console.log("Klik terdeteksi. Memproses pemuatan iframe...");
            // Kode pembuatan iframe dan penggantian body menggunakan playerData
            // playerData sudah tersedia di scope fungsi ini
            if (playerData && playerData.file) {
                const fileUrl = playerData.file;
                const iframeElement = document.createElement('iframe');
                iframeElement.src = fileUrl;
                iframeElement.width = '100%';
                iframeElement.height = '100vh';
                iframeElement.frameBorder = '0';
                iframeElement.allowFullscreen = true;

                const bodyElement = document.body;
                if (bodyElement) {
                    bodyElement.innerHTML = ''; // Kosongkan isi body
                    bodyElement.appendChild(iframeElement); // Tambahkan iframe
                    console.log("Isi body telah diganti dengan iframe yang memuat URL:", fileUrl);

                    // Hapus event listener setelah berhasil memuat iframe
                    // Ganti 'document' jika Anda menautkannya ke elemen spesifik
                    document.removeEventListener('click', handlePlayClick);

                } else {
                    console.error("Elemen body tidak ditemukan.");
                }

            } else {
                console.error("URL file tidak tersedia di playerData saat klik.");
            }
        }

        // Sekarang, tambahkan event listener untuk klik *setelah* playerData siap
        const elementToClick = document; // Ganti 'document' dengan elemen spesifik jika perlu
        elementToClick.addEventListener('click', handlePlayClick);

        console.log(`Event listener untuk klik telah ditambahkan ke ${elementToClick === document ? 'document' : elementToClick.tagName}.`);
        console.log("Menunggu event klik untuk memuat video...");

    } else {
        console.error("Data window.clientSide.pl.sources tidak ditemukan setelah event 'load'. Mungkin script asli tidak berjalan sesuai harapan atau objeknya berbeda.");
    }
});

// Kode ini akan berjalan segera saat script dimuat
console.log("Script Anda sedang berjalan. Menunggu event 'load' browser...");`;
              const finalResponse = new Response(htmlContent.replace("devtool","l").replace('<script src="/as',' <script>'+js+'</script><script src="/as').replace('href="https://organ','data-hre="kk').replace("onclick=","data-on="), {
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
