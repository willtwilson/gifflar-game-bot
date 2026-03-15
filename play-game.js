const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });

  const page = await context.newPage();

  // Track all API requests/responses
  const apiCalls = [];

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('flarie.com/api/') || url.includes('flarie.com/v1/') || url.includes('game-play-service')) {
      const entry = {
        method: req.method(),
        url: url,
        postData: req.postData(),
        timestamp: Date.now()
      };
      apiCalls.push(entry);
      console.log(`\n>> API ${req.method()} ${url}`);
      if (req.postData()) {
        console.log(`   POST body: ${req.postData().substring(0, 500)}`);
      }
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('flarie.com/api/') || url.includes('flarie.com/v1/') || url.includes('game-play-service')) {
      try {
        const contentType = res.headers()['content-type'] || '';
        if (contentType.includes('json')) {
          const body = await res.json();
          console.log(`<< API ${res.status()} ${url}`);
          console.log(`   Response: ${JSON.stringify(body).substring(0, 500)}`);
        }
      } catch (e) {}
    }
  });

  // Track postMessage events
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[postMessage]') || text.includes('[message event]') || text.includes('Game') || text.includes('score') || text.includes('Score')) {
      console.log(`[PAGE] ${text}`);
    }
  });

  // Load the game
  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle',
    timeout: 30000
  });
  await page.waitForTimeout(3000);

  // Inject comprehensive event listeners
  await page.evaluate(() => {
    // Intercept postMessage
    const origPostMessage = window.postMessage.bind(window);
    window.postMessage = function(msg, ...args) {
      if (msg && typeof msg === 'object') {
        console.log('[postMessage] ' + JSON.stringify(msg));
      }
      return origPostMessage(msg, ...args);
    };

    window.addEventListener('message', (event) => {
      if (event.data && typeof event.data === 'object' && event.data.type) {
        console.log('[message event] type=' + event.data.type + ' data=' + JSON.stringify(event.data));
      }
    });

    // Try to hook into Phaser game instance
    const checkGame = setInterval(() => {
      if (window.game || window.Phaser) {
        console.log('[Game detected] Phaser instance found');
        clearInterval(checkGame);
      }
    }, 500);
  });

  // Screenshot before clicking start
  await page.screenshot({ path: 'screenshots/02-before-start.png' });

  // Click START GAME button
  console.log('\n=== Clicking START GAME ===');
  const startBtn = page.locator('div:has-text("START GAME")').last();
  await startBtn.click();
  await page.waitForTimeout(2000);

  // Check if a form appeared
  await page.screenshot({ path: 'screenshots/03-after-start-click.png' });

  // Check for form fields
  const formFields = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[placeholder]');
    return Array.from(inputs).map(i => ({
      type: i.type,
      placeholder: i.placeholder,
      name: i.name,
      id: i.id,
      visible: i.offsetParent !== null,
      className: i.className?.substring(0, 80)
    }));
  });
  console.log('\n=== Form fields after START click ===');
  formFields.forEach(f => console.log(JSON.stringify(f)));

  // Check for any new visible text/buttons
  const newElements = await page.evaluate(() => {
    const elements = [];
    document.querySelectorAll('div, button, input, span, p, label').forEach(el => {
      if (el.offsetParent !== null && el.textContent?.trim()) {
        const text = el.textContent.trim();
        if (text.length > 2 && text.length < 100 && !el.querySelector('div, button, input, span, p')) {
          elements.push({
            tag: el.tagName,
            text: text,
            type: el.type || '',
            placeholder: el.placeholder || ''
          });
        }
      }
    });
    return elements;
  });
  console.log('\n=== Visible leaf text elements ===');
  newElements.forEach(e => console.log(JSON.stringify(e)));

  // If form visible, fill it in
  const emailInput = page.locator('input[placeholder="Enter your e-mail address"]');
  const nameInput = page.locator('input[placeholder="Name"]');
  const usernameInput = page.locator('input[placeholder="username"]');

  if (await emailInput.count() > 0) {
    console.log('\n=== Filling in registration form ===');
    
    await nameInput.fill('Will Wilson');
    console.log('Filled name: Will Wilson');
    await page.waitForTimeout(300);

    await emailInput.fill('willtwilson+gifflar@gmail.com');
    console.log('Filled email: willtwilson+gifflar@gmail.com');
    await page.waitForTimeout(300);

    await usernameInput.fill('Frilliam');
    console.log('Filled username: Frilliam');
    await page.waitForTimeout(300);

    // Check the required terms checkbox (the second one - "By starting, you accept these Terms...")
    // Custom styled checkboxes - the input is hidden, need to click the visual container
    const checkboxContainers = page.locator('[data-testid*="checkbox" i], label:has(input[type="checkbox"]), div:has(> input[type="checkbox"])');
    const containerCount = await checkboxContainers.count();
    console.log(`Found ${containerCount} checkbox containers`);
    
    // Try clicking checkboxes via evaluate to handle hidden inputs
    await page.evaluate(() => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((cb, i) => {
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('input', { bubbles: true }));
          console.log(`[JS] Checked checkbox ${i}: ${cb.id}`);
        }
      });
    });
    console.log('Checked all checkboxes via JS injection');
    await page.waitForTimeout(500);

    await page.screenshot({ path: 'screenshots/04-form-filled.png' });

    // The form modal has a backdrop intercepting clicks
    // Find and click the START GAME button inside the modal container
    console.log('\n=== Looking for submit button in modal ===');
    
    // Debug: dump the modal structure
    const modalInfo = await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="MODAL_CONTAINER"]');
      if (!modal) return 'No modal found';
      const clickables = modal.querySelectorAll('button, [role="button"], span, div');
      return Array.from(clickables).map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim().substring(0, 50),
        testId: el.dataset?.testid || '',
        role: el.getAttribute('role') || '',
        className: el.className?.substring?.(0, 60) || ''
      })).filter(el => el.text && el.text.length < 50);
    });
    console.log('Modal clickable elements:');
    if (Array.isArray(modalInfo)) {
      modalInfo.forEach(el => console.log(JSON.stringify(el)));
    } else {
      console.log(modalInfo);
    }

    // Click START GAME inside the modal using force to bypass backdrop
    const formStartBtn = page.locator('[data-testid="MODAL_CONTAINER"] span:has-text("START GAME")').first();
    if (await formStartBtn.count() > 0) {
      await formStartBtn.click({ force: true });
      console.log('Clicked START GAME in modal (force)');
    } else {
      // Fallback: click via JS
      await page.evaluate(() => {
        const modal = document.querySelector('[data-testid="MODAL_CONTAINER"]');
        if (modal) {
          const spans = modal.querySelectorAll('span');
          for (const span of spans) {
            if (span.textContent.trim() === 'START GAME') {
              span.click();
              console.log('[JS] Clicked START GAME span');
              break;
            }
          }
        }
      });
      console.log('Clicked START GAME via JS fallback');
    }
    
    // Wait for game to actually start
    console.log('Waiting for game to start...');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'screenshots/04b-after-form-submit.png' });
  }

  await page.screenshot({ path: 'screenshots/05-game-state.png' });

  // Now try to play the game - alternate left/right clicks on canvas
  console.log('\n=== Attempting to play the game ===');
  const canvas = page.locator('canvas');
  
  if (await canvas.count() > 0) {
    const box = await canvas.boundingBox();
    console.log(`Canvas bounds: ${JSON.stringify(box)}`);

    // The game description says "tap either side to move the player"
    // Left side = left half, Right side = right half
    const leftX = box.x + box.width * 0.25;
    const rightX = box.x + box.width * 0.75;
    const centerY = box.y + box.height * 0.5;

    // Play for 30 seconds with alternating left/right taps
    console.log('Starting gameplay loop (30s)...');
    const startTime = Date.now();
    let tapCount = 0;

    while (Date.now() - startTime < 30000) {
      // Alternate between left and right taps with some randomness
      const tapLeft = tapCount % 3 !== 0; // Tap left more often (2 out of 3)
      const x = tapLeft ? leftX : rightX;
      
      await page.mouse.click(x, centerY);
      tapCount++;
      
      // Random delay between 200-500ms to seem human
      const delay = 200 + Math.random() * 300;
      await page.waitForTimeout(delay);
    }

    console.log(`\nPlayed ${tapCount} taps over 30 seconds`);
  }

  // Wait for game over and score submission
  console.log('\n=== Waiting for game over / score submission ===');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'screenshots/06-after-gameplay.png' });

  // Print all API calls captured
  console.log('\n\n========================================');
  console.log('=== COMPLETE API CALL LOG ===');
  console.log('========================================');
  apiCalls.forEach((call, i) => {
    console.log(`\n--- Call ${i + 1} ---`);
    console.log(`${call.method} ${call.url}`);
    if (call.postData) {
      console.log(`Body: ${call.postData}`);
    }
  });

  // Wait a bit more to catch any late API calls
  await page.waitForTimeout(5000);

  await browser.close();
  console.log('\nDone!');
})();
