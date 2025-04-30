const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;

export class Browser {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.keptAliveInSeconds = 0;
		this.storage = this.state.storage;
	}
  
	async fetch(request) {
		// screen resolutions to test out
		const width = [1920, 1366, 1536, 360, 414]
		const height = [1080, 768, 864, 640, 896]

		// use the current date and time to create a folder structure for R2
		const nowDate = new Date()
		var coeff = 1000 * 60 * 5
		var roundedDate = (new Date(Math.round(nowDate.getTime() / coeff) * coeff)).toString();
		var folder = roundedDate.split(" GMT")[0]

		//if there's a browser session open, re-use it
		if (!this.browser) {
			console.log(`Browser DO: Starting new instance`);
			try {
			  this.browser = await puppeteer.launch(this.env.MYBROWSER);
			} catch (e) {
			  console.log(`Browser DO: Could not start browser instance. Error: ${e}`);
			}
		  }
		
		// Reset keptAlive after each call to the DO
		this.keptAliveInSeconds = 0;
		
		const page = await this.browser.newPage();

		// take screenshots of each screen size 
		for (let i = 0; i < width.length; i++) {
			await page.setViewport({ width: width[i], height: height[i] });
			await page.goto("https://workers.cloudflare.com/");
			const fileName = "screenshot_" + width[i] + "x" + height[i]
			const sc = await page.screenshot({
				path: fileName + ".jpg"
			}
			);

			this.env.BUCKET.put(folder + "/"+ fileName + ".jpg", sc);
		  }
		
		// Reset keptAlive after performing tasks to the DO.
		this.keptAliveInSeconds = 0;

		// set the first alarm to keep DO alive
		let currentAlarm = await this.storage.getAlarm();
		if (currentAlarm == null) {
		console.log(`Browser DO: setting alarm`);
		const TEN_SECONDS = 10 * 1000;
		this.storage.setAlarm(Date.now() + TEN_SECONDS);
		}
		
		await this.browser.close();
		return new Response("success");
	}

	async alarm() {
		this.keptAliveInSeconds += 10;
	
		// Extend browser DO life
		if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
		  console.log(`Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`);
		  this.storage.setAlarm(Date.now() + 10 * 1000);
		} else console.log(`Browser DO: cxceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}. Browser DO will be shut down in 10 seconds.`);
	  }

  }
