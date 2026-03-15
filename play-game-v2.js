const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });

  const page = await context.newPage();

  // Track API calls
  const apiCalls = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('flarie.com/api/') || url.includes('game-play-service')) {
      apiCalls.push({ method: req.method(), url, postData: req.postData() });
      console.log(`>> ${req.method()} ${url.split('?')[0]}`);
      if (req.postData()) console.log(`   Body: ${req.postData().substring(0, 300)}`);
    }
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('flarie.com/api/') || url.includes('game-play-service')) {
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await res.json();
          console.log(`<< ${res.status()} ${url.split('?')[0]}`);
          console.log(`   ${JSON.stringify(body).substring(0, 300)}`);
        }
      } catch (e) {}
    }
  });

  // Load game
  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(3000);

  // Inject comprehensive event capture
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      if (event.data && typeof event.data === 'object') {
        console.log('[MSG] ' + JSON.stringify(event.data));
      }
    });
  });

  // Click the background START GAME button to show the form
  console.log('\n=== Clicking START GAME ===');
  // The START GAME button is in the lower area of the screen
  await page.mouse.click(187, 590);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'screenshots/10-form-visible.png' });

  // Fill form fields
  console.log('\n=== Filling form ===');
  await page.locator('input[placeholder="Name"]').fill('Will Wilson');
  await page.locator('input[placeholder="Enter your e-mail address"]').fill('willtwilson+gifflar@gmail.com');
  await page.locator('input[placeholder="username"]').fill('Frilliam');
  console.log('Form filled');
  await page.waitForTimeout(500);

  // Handle checkboxes using React-compatible approach
  // First, let's see the full DOM around checkboxes
  const cbInfo = await page.evaluate(() => {
    const results = [];
    // Look for checkbox wrappers (React styled checkboxes)
    const allInputs = document.querySelectorAll('input[type="checkbox"]');
    allInputs.forEach((input, i) => {
      const parent = input.parentElement;
      const grandParent = parent?.parentElement;
      results.push({
        index: i,
        id: input.id,
        checked: input.checked,
        parentTag: parent?.tagName,
        parentTestId: parent?.dataset?.testid || '',
        grandParentTag: grandParent?.tagName,
        parentDisplay: window.getComputedStyle(parent).display,
        inputDisplay: window.getComputedStyle(input).display,
        inputVisibility: window.getComputedStyle(input).visibility,
        inputOpacity: window.getComputedStyle(input).opacity,
        parentRect: parent?.getBoundingClientRect()
      });
    });
    return results;
  });
  console.log('Checkbox details:');
  cbInfo.forEach(cb => console.log(JSON.stringify(cb)));

  // Click the checkbox containers/labels (not the hidden inputs)
  for (const cb of cbInfo) {
    if (cb.parentRect && cb.parentRect.height > 0) {
      const x = cb.parentRect.x + cb.parentRect.width / 2;
      const y = cb.parentRect.y + cb.parentRect.height / 2;
      console.log(`Clicking checkbox ${cb.index} at (${x}, ${y})`);
      await page.mouse.click(x, y);
      await page.waitForTimeout(300);
    }
  }

  await page.waitForTimeout(500);
  await page.screenshot({ path: 'screenshots/11-checkboxes-checked.png' });

  // Verify checkbox state
  const cbState = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="checkbox"]')).map(cb => ({
      id: cb.id,
      checked: cb.checked
    }));
  });
  console.log('Checkbox state after clicks:', JSON.stringify(cbState));

  // Now find and click the form's START GAME button
  // Dump all elements with "START" text
  const startElements = await page.evaluate(() => {
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const text = el.textContent?.trim();
      if (text && (text === 'START GAME' || text === 'START')) {
        const rect = el.getBoundingClientRect();
        results.push({
          tag: el.tagName,
          text: text,
          testId: el.dataset?.testid || '',
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          display: window.getComputedStyle(el).display,
          visibility: window.getComputedStyle(el).visibility,
          zIndex: window.getComputedStyle(el).zIndex
        });
      }
    }
    return results;
  });
  console.log('\n=== All START GAME elements ===');
  startElements.forEach(el => console.log(JSON.stringify(el)));

  // Find the green START GAME button inside the form (should be higher z-index or inside the form)
  // Look for the one that's a submit-like button
  const submitBtnInfo = await page.evaluate(() => {
    // Find elements with testid containing "submit" or "form" and "start"
    const formSubmit = document.querySelector('[data-testid*="SUBMIT"], [data-testid*="FORM_BUTTON"], [data-testid*="GAMEFORM"]');
    if (formSubmit) {
      return { found: true, tag: formSubmit.tagName, testId: formSubmit.dataset.testid, text: formSubmit.textContent?.trim() };
    }
    
    // Look for all data-testid elements
    const allTestIds = Array.from(document.querySelectorAll('[data-testid]')).map(el => ({
      testId: el.dataset.testid,
      tag: el.tagName,
      text: el.textContent?.trim().substring(0, 50),
      rect: el.getBoundingClientRect()
    }));
    return { found: false, allTestIds };
  });
  console.log('\n=== Submit button search ===');
  console.log(JSON.stringify(submitBtnInfo, null, 2));

  // Click the form's START GAME button using coordinates
  // From the screenshot, the green START GAME button is at approximately y=445, centered
  console.log('\n=== Clicking form START GAME at coordinates ===');
  await page.mouse.click(187, 445);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'screenshots/12-after-form-submit.png' });

  // Check if game started by looking for new API calls or changed UI
  const formStillVisible = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[placeholder="Name"]');
    return Array.from(inputs).some(el => el.offsetParent !== null);
  });
  console.log(`Form still visible: ${formStillVisible}`);

  if (formStillVisible) {
    console.log('Form still showing - trying alternative clicks...');
    
    // Try clicking the green button with force via evaluate
    await page.evaluate(() => {
      // Find all elements and click the one that looks like a submit button
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        if (span.textContent.trim() === 'START GAME') {
          const parent = span.parentElement;
          const rect = parent.getBoundingClientRect();
          console.log('[JS] Found START GAME span, parent rect: ' + JSON.stringify(rect));
          // Simulate a proper click event
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.x + rect.width/2,
            clientY: rect.y + rect.height/2
          });
          parent.dispatchEvent(clickEvent);
          span.dispatchEvent(clickEvent);
          console.log('[JS] Dispatched click on START GAME parent');
        }
      }
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/13-after-js-click.png' });
  }

  // Check if game is playing now
  console.log('\n=== Checking game state ===');
  const gameState = await page.evaluate(() => {
    // Check if the Phaser game scene is active
    const canvas = document.querySelector('canvas');
    return {
      canvasExists: !!canvas,
      canvasSize: canvas ? { w: canvas.width, h: canvas.height } : null,
      bodyClasses: document.body.className,
      // Check for score display
      hasScoreBar: !!document.querySelector('[class*="score" i]'),
    };
  });
  console.log(JSON.stringify(gameState));

  // Play the game for 30 seconds regardless
  console.log('\n=== Playing game for 30s ===');
  const canvas = page.locator('canvas');
  if (await canvas.count() > 0) {
    const box = await canvas.boundingBox();
    const leftX = box.x + box.width * 0.2;
    const rightX = box.x + box.width * 0.8;
    const midY = box.y + box.height * 0.5;

    const startTime = Date.now();
    let taps = 0;
    while (Date.now() - startTime < 30000) {
      const x = taps % 2 === 0 ? leftX : rightX;
      await page.mouse.click(x, midY);
      taps++;
      await page.waitForTimeout(250 + Math.random() * 250);

      if (taps % 20 === 0) {
        await page.screenshot({ path: `screenshots/play-${taps}.png` });
      }
    }
    console.log(`Tapped ${taps} times`);
  }

  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'screenshots/14-final.png' });

  console.log('\n=== All API calls ===');
  apiCalls.forEach((c, i) => {
    console.log(`${i}: ${c.method} ${c.url}`);
    if (c.postData) console.log(`   ${c.postData.substring(0, 500)}`);
  });

  await browser.close();
})();
