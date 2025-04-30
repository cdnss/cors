import puppeteer from "@cloudflare/puppeteer";

interface Env {
  MYBROWSER: Fetcher;
  BROWSER_KV_DEMO: KVNamespace;
}

export default {
  async fetch(request, env): Promise<Response> {
    const { searchParams } = new URL(request.url);
    let url = searchParams.get("url");
    let htmlContent: string | null = null; // Variabel untuk menyimpan konten HTML

    if (url) {
      url = new URL(url).toString(); // normalisasi URL

      // Coba ambil konten HTML dari cache KV
      htmlContent = await env.BROWSER_KV_DEMO.get(url, { type: "text" }); // Ambil sebagai teks

      if (htmlContent === null) {
        // Cache miss: Jalankan browser untuk mengambil konten
        const browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();

        try {
          // Buka URL
          // waitUntil: 'networkidle0' seringkali lebih baik untuk menunggu konten dimuat,
          // tapi bisa memakan waktu lebih lama. Sesuaikan jika perlu.
          await page.goto(url, { waitUntil: 'domcontentloaded' });

          console.log(`Navigasi ke ${url} selesai.`);

          // Tunggu hingga elemen iframe pertama terlihat
          // timeout: 30000 ms (30 detik) adalah nilai default, bisa disesuaikan
          console.log('Menunggu iframe pertama terlihat...');
          await page.waitForSelector('iframe', { visible: true, timeout: 30000 });
          console.log('iframe terlihat.');

          // Ambil seluruh konten HTML halaman setelah menunggu
          htmlContent = await page.content();
          console.log('Konten HTML diambil.');

          // Simpan konten HTML ke KV
          await env.BROWSER_KV_DEMO.put(url, htmlContent, {
            expirationTtl: 60 * 60 * 24, // Cache selama 24 jam
            type: "text" // Simpan sebagai teks
          });
          console.log('Konten HTML di-cache.');

        } catch (error: any) {
          console.error(`Error saat memproses URL ${url}:`, error);
          // Jika terjadi error (misal: timeout menunggu iframe), kembalikan pesan error
          htmlContent = `Error saat mengambil atau memproses halaman: ${error.message}`;
          // Opsional: Jangan cache jika error, atau cache dengan TTL yang sangat singkat
          return new Response(htmlContent, { status: 500 }); // Kembalikan respons error
        } finally {
          // Pastikan browser ditutup
          if (browser) {
            await browser.close();
          }
        }
      } else {
        console.log('Konten HTML ditemukan di cache.');
      }

      // Kembalikan konten HTML (dari cache atau yang baru diambil)
      return new Response(htmlContent, {
        headers: {
          "content-type": "text/html; charset=utf-8", // Set header ke text/html
        },
      });

    } else {
      // Jika parameter url tidak diberikan
      return new Response("Mohon tambahkan parameter ?url=https://example.com/");
    }
  },
} as ExportedHandler<Env>;
