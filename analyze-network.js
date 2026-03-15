const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }, // iPhone X dimensions
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });

  const page = await context.newPage();

  // Capture all network requests
  const requests = [];
  const responses = [];

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('_next/static') && !url.includes('.woff') && !url.includes('.png') && !url.includes('.mp3') && !url.includes('.css')) {
      requests.push({
        method: req.method(),
        url: url,
        headers: req.headers(),
        postData: req.postData()
      });
      console.log(`>> ${req.method()} ${url}`);
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('_next/static') && !url.includes('.woff') && !url.includes('.png') && !url.includes('.mp3') && !url.includes('.css')) {
      let body = null;
      try {
        const contentType = res.headers()['content-type'] || '';
        if (contentType.includes('json')) {
          body = await res.json();
        }
      } catch (e) {}
      responses.push({
        status: res.status(),
        url: url,
        body: body
      });
      if (body) {
        console.log(`<< ${res.status()} ${url}`);
        console.log(`   Body: ${JSON.stringify(body).substring(0, 200)}`);
      }
    }
  });

  // Listen for console messages from the page
  page.on('console', msg => {
    if (msg.type() === 'log' || msg.type() === 'info') {
      console.log(`[PAGE] ${msg.text()}`);
    }
  });

  // Navigate to the game directly
  console.log('\n=== Loading game page ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  console.log('\n=== Page loaded, waiting for game to initialize ===');
  await page.waitForTimeout(3000);

  // Inject message listener to capture postMessage events
  await page.evaluate(() => {
    const origPostMessage = window.postMessage.bind(window);
    window.postMessage = function(msg, ...args) {
      console.log('[postMessage] ' + JSON.stringify(msg));
      return origPostMessage(msg, ...args);
    };
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type) {
        console.log('[message event] ' + JSON.stringify(event.data));
      }
    });
  });

  // Take a screenshot
  await page.screenshot({ path: 'screenshots/01-game-loaded.png', fullPage: true });
  console.log('\nScreenshot saved: 01-game-loaded.png');

  // Check what's visible on the page
  const pageContent = await page.evaluate(() => {
    const texts = [];
    document.querySelectorAll('button, input, [role="button"], a').forEach(el => {
      if (el.offsetParent !== null) { // visible elements
        texts.push({
          tag: el.tagName,
          type: el.type || '',
          text: el.textContent?.trim().substring(0, 100),
          placeholder: el.placeholder || '',
          id: el.id || '',
          className: el.className?.substring?.(0, 50) || ''
        });
      }
    });
    return texts;
  });
  console.log('\n=== Visible interactive elements ===');
  pageContent.forEach(el => console.log(JSON.stringify(el)));

  // Check for canvas element
  const hasCanvas = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return canvas ? { width: canvas.width, height: canvas.height, id: canvas.id } : null;
  });
  console.log('\n=== Canvas element ===');
  console.log(JSON.stringify(hasCanvas));

  // Check for iframes
  const iframes = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe')).map(f => ({
      src: f.src,
      id: f.id,
      name: f.name
    }));
  });
  console.log('\n=== Iframes ===');
  console.log(JSON.stringify(iframes));

  // Wait for user to see the state
  console.log('\n=== Waiting 10 seconds for observation ===');
  await page.waitForTimeout(10000);

  // Print all captured API requests
  console.log('\n=== All captured API requests ===');
  requests.forEach(r => {
    console.log(`${r.method} ${r.url}`);
    if (r.postData) console.log(`  Body: ${r.postData.substring(0, 500)}`);
  });

  console.log('\n=== All captured API responses with JSON body ===');
  responses.filter(r => r.body).forEach(r => {
    console.log(`${r.status} ${r.url}`);
    console.log(`  ${JSON.stringify(r.body).substring(0, 500)}`);
  });

  await browser.close();
  console.log('\nDone!');
})();
