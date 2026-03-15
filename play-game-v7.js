const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  // Capture full API request/response bodies
  let lastScoreRequest = null;
  let lastScoreResponse = null;
  let lastStartResponse = null;

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/post-game-score')) {
      lastScoreRequest = req.postData();
      console.log(`>> POST post-game-score FULL BODY:`);
      console.log(req.postData());
    } else if (url.includes('/api/post-game-start')) {
      console.log(`>> POST post-game-start`);
      console.log(`   ${req.postData()?.substring(0, 300)}`);
    }
  });
  page.on('response', async (res) => {
    const url = res.url();
    try {
      if (url.includes('/api/post-game-score')) {
        const body = await res.json();
        lastScoreResponse = body;
        console.log(`<< post-game-score RESPONSE:`);
        console.log(JSON.stringify(body, null, 2));
      } else if (url.includes('/api/post-game-start')) {
        const body = await res.json();
        lastStartResponse = body;
        console.log(`<< post-game-start: playerId=${body.playerId}, roundId=${body.roundId?.substring(0, 40)}...`);
      }
    } catch {}
  });

  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // Disable overlays
  await page.evaluate(() => {
    document.querySelectorAll('[data-testid]').forEach(el => {
      const tid = el.dataset.testid;
      if (['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].includes(tid)) {
        el.style.pointerEvents = 'none';
      }
    });
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    if (form) {
      form.style.position = 'relative';
      form.style.zIndex = '99999';
    }
  });

  // Click START GAME
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);

  // Fill form
  console.log('=== Filling form ===');
  await page.locator('input[placeholder="Name"]').click({ force: true });
  await page.locator('input[placeholder="Name"]').fill('Will Wilson');
  await page.locator('input[placeholder="Enter your e-mail address"]').click({ force: true });
  await page.locator('input[placeholder="Enter your e-mail address"]').fill('willtwilson+gifflar@gmail.com');
  await page.locator('input[placeholder="username"]').click({ force: true });
  await page.locator('input[placeholder="username"]').fill('Frilliam');

  // Check terms via React onChange
  await page.evaluate(() => {
    const cb = document.getElementById('GAME_FORM_TERMS');
    const pk = Object.keys(cb).find(k => k.startsWith('__reactProps$'));
    if (pk) cb[pk].onChange({ target: { checked: true } });
    // Also marketing
    const mc = document.getElementById('PARAM1');
    const mp = Object.keys(mc).find(k => k.startsWith('__reactProps$'));
    if (mp) mc[mp].onChange({ target: { checked: true } });
  });
  await page.waitForTimeout(300);

  // Submit via React onSubmit
  console.log('=== Submitting form ===');
  await page.evaluate(() => {
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
    const pk = Object.keys(form).find(k => k.startsWith('__reactProps$'));
    if (pk) form[pk].onSubmit({ preventDefault: () => {}, stopPropagation: () => {}, target: form, currentTarget: form, nativeEvent: new Event('submit') });
  });
  await page.waitForTimeout(3000);

  // Verify game started
  const formGone = await page.evaluate(() => !document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'));
  console.log('Form removed (game started):', formGone);
  
  if (!formGone) {
    console.log('ERROR: Game did not start');
    await browser.close();
    return;
  }

  // Play the game with improved strategy
  console.log('\n=== PLAYING GAME ===');
  console.log('Strategy: Gentle alternating taps, staying near center');
  
  const start = Date.now();
  let taps = 0;
  const maxPlayTime = 90000; // 90 seconds max
  
  // Improved strategy: tap less aggressively, stay centered
  while (Date.now() - start < maxPlayTime) {
    // Alternate sides but not too far from center
    // Left side tap: 130-170, Right side tap: 200-240
    const leftX = 130 + Math.random() * 40;
    const rightX = 200 + Math.random() * 40;
    const x = taps % 2 === 0 ? leftX : rightX;
    const y = 350 + Math.random() * 100; // Vary tap height
    
    await page.mouse.click(x, y);
    
    // Variable delay - slightly slower to be more precise
    const delay = 250 + Math.random() * 300;
    await page.waitForTimeout(delay);
    taps++;
    
    // Check if game over (modal reappeared)
    if (taps % 20 === 0) {
      const isGameOver = await page.evaluate(() => {
        const modal = document.querySelector('[data-testid="MODAL_CONTAINER"]');
        return modal && window.getComputedStyle(modal).display !== 'none';
      });
      if (isGameOver) {
        console.log(`Game over detected after ${taps} taps, ${Math.round((Date.now() - start) / 1000)}s`);
        break;
      }
    }
  }
  
  console.log(`Total taps: ${taps}, time: ${Math.round((Date.now() - start) / 1000)}s`);
  
  // Wait for score submission
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'screenshots/70-game-over.png' });

  // Report results
  console.log('\n=== RESULTS ===');
  if (lastScoreResponse) {
    console.log(`High Score: ${lastScoreResponse.highScore}`);
    console.log(`Ranking: ${lastScoreResponse.ranking}`);
    console.log(`Total Rounds: ${lastScoreResponse.totalRound}`);
    console.log(`Is Cheater: ${lastScoreResponse.isCheater}`);
    console.log(`Number of Entries: ${lastScoreResponse.numberOfEntries}`);
    
    if (lastScoreResponse.highScore >= 300) {
      console.log('\n🎉 TARGET ACHIEVED! Score >= 300!');
    } else {
      console.log(`\n❌ Score ${lastScoreResponse.highScore} < 300. Need to try again.`);
    }
  }

  if (lastScoreRequest) {
    console.log('\n=== Full score request body ===');
    console.log(lastScoreRequest);
  }

  await browser.close();
  console.log('\nDone');
})();
