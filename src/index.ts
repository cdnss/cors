// Hapus import puppeteer karena kita akan menggunakan Browser Rendering API Cloudflare
// import puppeteer from 'puppeteer';

export const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;

// Pastikan kelas ini diekspor agar bisa digunakan sebagai Durable Object
export class Browser {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.keptAliveInSeconds = 0;
		this.storage = this.state.storage;
		// this.browser = null; // Tidak perlu menyimpan instance browser di state DO
	}

	async fetch(request) {
		console.log(`Browser DO: Received fetch request`);

		// screen resolutions to test out
		const width = [1920, 1366, 1536, 360, 414];
		const height = [1080, 768, 864, 640, 896];

		// use the current date and time to create a folder structure for R2
		const nowDate = new Date();
		var coeff = 1000 * 60 * 5;
		var roundedDate = (new Date(Math.round(nowDate.getTime() / coeff) * coeff)).toString();
		// Replace characters that might cause issues in R2 keys
		var folder = roundedDate.split(" GMT")[0].replace(/[:\s]/g, '-').replace(/\+\d{4}/, ''); // Menghapus zona waktu dan spasi/titik dua

		let page;
		try {
            // Mendapatkan instance page dari Browser Rendering API Cloudflare
            // env.MYBROWSER adalah binding dari wrangler.toml
			console.log(`Browser DO: Getting new page from env.MYBROWSER`);
            // Meneruskan request asli ke newPage agar info seperti IP dll tersedia di browser
			page = await this.env.MYBROWSER.newPage(request);

			// Reset keptAlive setelah setiap call ke DO (fetch/alarm)
			this.keptAliveInSeconds = 0;

			// take screenshots of each screen size
			for (let i = 0; i < width.length; i++) {
				console.log(`Browser DO: Setting viewport to ${width[i]}x${height[i]}`);
				await page.setViewport({ width: width[i], height: height[i] });

				const urlToVisit = "https://workers.cloudflare.com/"; // URL yang akan dikunjungi
				console.log(`Browser DO: Navigating to ${urlToVisit}`);
				// Pastikan URL ini valid dan bisa diakses oleh browser Cloudflare
				// Gunakan opsi waitUntil yang sesuai, 'networkidle2' atau 'domcontentloaded'
				await page.goto(urlToVisit, { waitUntil: 'domcontentloaded' });
				console.log(`Browser DO: Page loaded.`);

				const fileName = "screenshot_" + width[i] + "x" + height[i];
				console.log(`Browser DO: Taking screenshot ${fileName}`);
				// screenshot() mengembalikan data gambar (Buffer/ArrayBuffer).
				const sc = await page.screenshot();

				// Unggah screenshot ke R2
				const r2Key = folder + "/" + fileName + ".jpg";
				console.log(`Browser DO: Uploading ${r2Key} to R2`);
				await this.env.BUCKET.put(r2Key, sc, {
					contentType: 'image/jpeg' // Tentukan Content-Type
				});
				console.log(`Browser DO: Uploaded ${r2Key}`);
			}

			// Set alarm pertama untuk menjaga DO tetap aktif jika belum ada alarm
			let currentAlarm = await this.storage.getAlarm();
			if (currentAlarm == null || currentAlarm < Date.now()) { // Cek juga jika alarm sudah kadaluarsa
				console.log(`Browser DO: Setting new alarm`);
				const TEN_SECONDS = 10 * 1000;
				// Set alarm untuk 10 detik ke depan
				await this.storage.setAlarm(Date.now() + TEN_SECONDS);
			} else {
                console.log(`Browser DO: Alarm already set for ${new Date(currentAlarm).toISOString()}`);
            }

			// Tutup halaman browser setelah selesai menggunakan
            // !!! Sangat penting untuk menutup halaman setelah selesai memakainya !!!
			console.log(`Browser DO: Closing page`);
			await page.close();
            page = null; // Pastikan variabel page di-reset

			return new Response("Screenshots captured and uploaded.", { status: 200 });

		} catch (error) {
			console.error("Browser DO Error during fetch execution:", error);
			// Pastikan halaman ditutup jika terjadi error
			if (page && !page.isClosed()) {
                console.log(`Browser DO: Closing page due to error`);
				try {
					await page.close();
				} catch (closeError) {
					console.error("Browser DO Error closing page after error:", closeError);
				}
			}
			// Kembalikan respons error
			return new Response(`Browser DO Processing Error: ${error.message}`, { status: 500 });
		}
		// Tidak perlu menutup 'browser' instance karena itu dikelola oleh Cloudflare via env.MYBROWSER
	}

	async alarm() {
		// Alarm ini dipicu setiap 10 detik (sesuai setAlarm di fetch/alarm sebelumnya)
		// DO instance akan tetap hidup selama ada alarm atau fetch request
		this.keptAliveInSeconds += 10;
		console.log(`Browser DO: Alarm triggered. Kept alive for ${this.keptAliveInSeconds} seconds.`);

		// Perpanjang masa hidup DO jika belum melebihi batas KEEP_BROWSER_ALIVE_IN_SECONDS
		if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
			console.log(`Browser DO: Extending lifespan.`);
			// Set alarm berikutnya untuk 10 detik lagi
			await this.storage.setAlarm(Date.now() + 10 * 1000);
		} else {
			console.log(`Browser DO: Exceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}. DO will idle out when no requests/alarms.`);
			// Jika batas waktu tercapai, jangan set alarm lagi
			// DO akan mati (idle) secara otomatis setelah beberapa waktu jika tidak ada fetch request
			// Tidak perlu menutup 'browser' secara eksplisit di sini karena kita menutup 'page' di fetch.
			// Instance DO akan dibersihkan oleh sistem Cloudflare saat idle.
		}
	}
}

// Jika kelas Browser ada di file terpisah, pastikan file Worker utama (index.ts)
// mengimpor dan mengekspornya sebagai Durable Object.
// Contoh index.ts jika Browser ada di './browser-do.ts':
/*
import { Browser } from './browser-do';

export { Browser }; // Export kelas Browser agar bisa dihubungkan oleh wrangler.toml

export default {
  async fetch(request, env, ctx) {
    // ... Kode Worker utama untuk berinteraksi dengan Durable Object
    const id = env.BROWSER.idFromName("my-rendering-session"); // Ganti dengan ID unik sesuai kebutuhan
    const stub = env.BROWSER.get(id); // Mendapatkan Durable Object stub

    // Kirim request ke Durable Object
    return stub.fetch(request);
  },
};
*/
