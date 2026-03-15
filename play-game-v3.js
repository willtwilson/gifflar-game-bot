const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  const apiCalls = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('flarie.com/api/') || url.includes('game-play-service')) {
      const entry = { method: req.method(), url: url.split('?')[0], body: req.postData() };
      apiCalls.push(entry);
      console.log(`>> ${req.method()} ${url.split('?')[0]}`);
      if (req.postData()) console.log(`   Body: ${req.postData().substring(0, 300)}`);
    }
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('flarie.com/api/') || url.includes('game-play-service')) {
      try {
        const body = await res.json();
        console.log(`<< ${res.status()} ${url.split('?')[0]}`);
        console.log(`   ${JSON.stringify(body).substring(0, 400)}`);
      } catch {}
    }
  });

  // Log postMessage events
  page.on('console', msg => {
    const t = msg.text();
    if (t.startsWith('[MSG]') || t.startsWith('[GAME]')) console.log(`[PAGE] ${t}`);
  });

  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // Inject message listener to track game events
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      if (event.data && typeof event.data === 'object') {
        console.log('[MSG] ' + JSON.stringify(event.data));
      }
    });
    // Also monitor the Phaser game instance
    const checkGame = setInterval(() => {
      const game = window.__PHASER_GAME__;
      if (game) {
        console.log('[GAME] Phaser game found');
        clearInterval(checkGame);
      }
    }, 500);
  });

  // Step 1: Click START GAME button to show form
  console.log('\n=== Step 1: Click START GAME ===');
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'screenshots/30-form-shown.png' });

  // Step 2: Fill form fields
  console.log('\n=== Step 2: Fill form ===');
  await page.locator('input[placeholder="Name"]').fill('Will Wilson');
  await page.waitForTimeout(300);
  await page.locator('input[placeholder="Enter your e-mail address"]').fill('willtwilson+gifflar@gmail.com');
  await page.waitForTimeout(300);
  await page.locator('input[placeholder="username"]').fill('Frilliam');
  await page.waitForTimeout(300);
  console.log('Form fields filled');

  // Step 3: Check the terms checkbox (mandatory)
  // The checkbox visual is an SVG at (77, 505) 20x20 inside a div[role=button]
  console.log('\n=== Step 3: Check terms checkbox ===');
  
  // Click the terms checkbox wrapper div (role=button, cursor=pointer)
  // It's at (70, 505) with size 235x42, so center is (187, 526)
  // But let's click the SVG specifically at (87, 515)
  const termsDiv = page.locator('#GAME_FORM_TERMS').locator('..');
  console.log('Terms parent:', await termsDiv.evaluate(el => ({
    tag: el.tagName,
    role: el.getAttribute('role'),
    cursor: window.getComputedStyle(el).cursor,
    rect: el.getBoundingClientRect()
  })));
  
  // Click the parent div[role=button] of the terms checkbox
  await termsDiv.click({ force: true });
  await page.waitForTimeout(500);
  
  // Check if it worked
  let termsChecked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
  console.log('Terms checked after div click:', termsChecked);
  
  if (!termsChecked) {
    // Try clicking the SVG element directly
    console.log('Trying SVG click...');
    const termsSvg = page.locator('#GAME_FORM_TERMS ~ svg');
    await termsSvg.click({ force: true });
    await page.waitForTimeout(500);
    termsChecked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('Terms checked after SVG click:', termsChecked);
  }
  
  if (!termsChecked) {
    // Try clicking via coordinates on the SVG (77, 505) center (87, 515)
    console.log('Trying coordinate click on SVG at (87, 515)...');
    await page.mouse.click(87, 515);
    await page.waitForTimeout(500);
    termsChecked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('Terms checked after coord click:', termsChecked);
  }

  if (!termsChecked) {
    // Try using page.tap() since this is a mobile game
    console.log('Trying tap...');
    await page.tap('[data-testid="GAMEFORM_CONTAINER"] div[role="button"]:last-of-type');
    await page.waitForTimeout(500);
    termsChecked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('Terms checked after tap:', termsChecked);
  }

  if (!termsChecked) {
    // Last resort: trigger React's onChange via native event simulation
    console.log('Trying React-compatible event dispatch...');
    await page.evaluate(() => {
      const cb = document.getElementById('GAME_FORM_TERMS');
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'checked'
      ).set;
      nativeInputValueSetter.call(cb, true);
      cb.dispatchEvent(new Event('input', { bubbles: true }));
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    termsChecked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('Terms checked after React hack:', termsChecked);
  }

  await page.screenshot({ path: 'screenshots/31-checkbox-attempt.png' });

  // Also check marketing consent (optional, but let's try)
  const param1Div = page.locator('#PARAM1').locator('..');
  await param1Div.click({ force: true });
  await page.waitForTimeout(300);

  // Step 4: Submit the form
  console.log('\n=== Step 4: Submit form ===');
  // The submit button is at (78, 422) 219x44
  const submitBtn = page.locator('[data-testid="GAMEFORM_SUBMIT_BUTTON"]');
  const submitBounds = await submitBtn.boundingBox();
  console.log('Submit button bounds:', submitBounds);
  
  // Check if submit button is disabled
  const submitDisabled = await submitBtn.evaluate(el => ({
    disabled: el.disabled,
    cursor: window.getComputedStyle(el).cursor,
    opacity: window.getComputedStyle(el).opacity,
    pointerEvents: window.getComputedStyle(el).pointerEvents
  }));
  console.log('Submit button state:', submitDisabled);
  
  await submitBtn.click({ force: true });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'screenshots/32-after-submit.png' });

  // Check if form is gone
  const formVisible = await page.evaluate(() => {
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    return form ? window.getComputedStyle(form).display !== 'none' : false;
  });
  console.log('Form still visible:', formVisible);

  if (formVisible) {
    console.log('\n=== Form still showing - trying alternative submit ===');
    // Try pressing Enter in the form
    await page.locator('input[placeholder="username"]').press('Enter');
    await page.waitForTimeout(3000);
    
    const formVisible2 = await page.evaluate(() => {
      const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
      return form ? window.getComputedStyle(form).display !== 'none' : false;
    });
    console.log('Form still visible after Enter:', formVisible2);
    await page.screenshot({ path: 'screenshots/33-after-enter.png' });
  }

  // Check if game is playing
  console.log('\n=== Game state check ===');
  const gameState = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return {
      canvasExists: !!canvas,
      modalVisible: !!document.querySelector('[data-testid="MODAL_CONTAINER"]') && 
        window.getComputedStyle(document.querySelector('[data-testid="MODAL_CONTAINER"]')).display !== 'none',
      backdropVisible: !!document.querySelector('[data-testid="MODAL_BACKDROP"]') &&
        window.getComputedStyle(document.querySelector('[data-testid="MODAL_BACKDROP"]')).display !== 'none'
    };
  });
  console.log('Game state:', gameState);

  // If game started, play for 45 seconds
  if (!gameState.modalVisible || !gameState.backdropVisible) {
    console.log('\n=== GAME STARTED! Playing for 45s ===');
    const startTime = Date.now();
    let taps = 0;
    while (Date.now() - startTime < 45000) {
      // Alternate left/right taps
      const x = taps % 2 === 0 ? 100 : 275;
      await page.mouse.click(x, 400);
      await page.waitForTimeout(200 + Math.random() * 200);
      taps++;
    }
    console.log(`Tapped ${taps} times`);
    await page.waitForTimeout(5000); // Wait for game over events
  }

  // Take final screenshot and dump all API calls
  await page.screenshot({ path: 'screenshots/34-final.png' });
  
  console.log('\n=== All API calls ===');
  apiCalls.forEach((c, i) => console.log(`${i}: ${c.method} ${c.url}\n   ${(c.body || '').substring(0, 300)}`));

  await browser.close();
  console.log('\nDone');
})();
