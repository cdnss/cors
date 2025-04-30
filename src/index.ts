

export const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;

export class Browser {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.keptAliveInSeconds = 0;
		this.storage = this.state.storage;
		this.browser = null; // Inisialisasi browser
	}

	async fetch(request) {
		// screen resolutions to test out
		const width = [1920, 1366, 1536, 360, 414]
		const height = [1080, 768, 864, 640, 896]

		// use the current date and time to create a folder structure for R2
		const nowDate = new Date();
		var coeff = 1000 * 60 * 5;
		var roundedDate = (new Date(Math.round(nowDate.getTime() / coeff) * coeff)).toString();
		// Replace characters that might cause issues in R2 keys
		var folder = roundedDate.split(" GMT")[0].replace(/[:\s]/g, '-');


		//if there's a browser session open, re-use it
		if (!this.browser) {
			console.log(`Browser DO: Starting new instance`);
			try {
				// !!! PERINGATAN: Baris ini tidak akan berfungsi di Cloudflare Workers/DO !!!
				// Puppeteer memerlukan binary Chromium yang tidak bisa dijalankan di sini.
				this.browser = await puppeteer.launch(this.env.MYBROWSER);
			} catch (e) {
				console.log(`Browser DO: Could not start browser instance. Error: ${e}`);
				// Penting untuk mengembalikan respons error jika browser gagal dijalankan
				return new Response(`Error starting browser: ${e.message}`, { status: 500 });
			}
		} else {
			console.log(`Browser DO: Re-using existing instance`);
		}

		// Reset keptAlive after each call to the DO
		this.keptAliveInSeconds = 0;

		let page;
		try {
			page = await this.browser.newPage();

			// take screenshots of each screen size
			for (let i = 0; i < width.length; i++) {
				await page.setViewport({ width: width[i], height: height[i] });
				// Pastikan URL ini valid dan bisa diakses oleh Puppeteer
				await page.goto("https://workers.cloudflare.com/", { waitUntil: 'networkidle2' }); // Tambahkan waitUntil agar halaman selesai dimuat
				const fileName = "screenshot_" + width[i] + "x" + height[i];
				// !!! PERINGATAN: Opsi 'path' tidak valid di lingkungan ini.
				// screenshot() mengembalikan data gambar (Buffer).
				const sc = await page.screenshot(); // Hapus opsi path

				// Unggah screenshot ke R2
				await this.env.BUCKET.put(folder + "/" + fileName + ".jpg", sc, {
					contentType: 'image/jpeg' // Tentukan Content-Type
				});
				console.log(`Uploaded ${fileName}.jpg to R2`);
			}

			// Reset keptAlive after performing tasks to the DO.
			this.keptAliveInSeconds = 0;

			// set the first alarm to keep DO alive
			let currentAlarm = await this.storage.getAlarm();
			if (currentAlarm == null) {
				console.log(`Browser DO: setting alarm`);
				const TEN_SECONDS = 10 * 1000;
				// Set alarm untuk 10 detik ke depan
				await this.storage.setAlarm(Date.now() + TEN_SECONDS);
			}

			// !!! PERINGATAN: Menutup browser setelah setiap permintaan fetch mungkin tidak efisien
			// dan bertentangan dengan tujuan Durable Object untuk menjaga state.
			// Mungkin lebih baik menutupnya hanya ketika alarm menunjukkan DO akan mati.
			// await this.browser.close();

			// Tutup halaman, bukan seluruh browser instance
			await page.close();

			return new Response("success");

		} catch (error) {
			console.error("Error during fetch execution:", error);
			// Pastikan halaman ditutup jika terjadi error
			if (page && !page.isClosed()) {
				await page.close();
			}
			return new Response(`Error during processing: ${error.message}`, { status: 500 });
		}
		// Jangan menutup browser di sini jika ingin menggunakannya kembali
		// Hapus baris await this.browser.close(); di sini
	}

	async alarm() {
		// Alarm ini dipicu setiap 10 detik (sesuai setAlarm di fetch)
		this.keptAliveInSeconds += 10;
		console.log(`Browser DO: Alarm triggered. Kept alive for ${this.keptAliveInSeconds} seconds.`);

		// Periksa apakah browser instance masih ada sebelum mencoba menutupnya
		if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
			console.log(`Browser DO: Extending lifespan.`);
			// Set alarm berikutnya untuk 10 detik lagi
			await this.storage.setAlarm(Date.now() + 10 * 1000);
		} else {
			console.log(`Browser DO: Exceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}. Closing browser and shutting down DO.`);
			// Jika batas waktu tercapai, tutup browser
			if (this.browser) {
				try {
					await this.browser.close();
					console.log(`Browser DO: Browser instance closed.`);
				} catch (e) {
					console.error("Error closing browser:", e);
				}
				this.browser = null; // Set null agar instance baru dibuat nanti
			}
			// Jangan set alarm lagi, biarkan DO mati
		}
	}

}
