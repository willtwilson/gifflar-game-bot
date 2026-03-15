const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  const apiCalls = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('flarie.com/api/') || url.includes('game-play-service')) {
      apiCalls.push({ method: req.method(), url: url.split('?')[0], body: req.postData() });
      console.log(`>> ${req.method()} ${url.split('?')[0]}`);
      if (req.postData()) console.log(`   ${req.postData().substring(0, 300)}`);
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

  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // Click START GAME to show form
  console.log('\n=== Click START GAME ===');
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);

  // Fill form
  console.log('\n=== Fill form ===');
  await page.locator('input[placeholder="Name"]').fill('Will Wilson');
  await page.locator('input[placeholder="Enter your e-mail address"]').fill('willtwilson+gifflar@gmail.com');
  await page.locator('input[placeholder="username"]').fill('Frilliam');
  console.log('Fields filled');

  // KEY FIX: Remove the MODAL_BACKDROP's pointer events so clicks reach the form
  console.log('\n=== Fix backdrop ===');
  await page.evaluate(() => {
    const backdrop = document.querySelector('[data-testid="MODAL_BACKDROP"]');
    if (backdrop) {
      backdrop.style.pointerEvents = 'none';
      console.log('[GAME] Backdrop pointer-events disabled');
    }
    // Also ensure form container is properly positioned for z-index
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    if (form) {
      form.style.position = 'relative';
      form.style.zIndex = '10010';
    }
  });
  await page.waitForTimeout(500);

  // Now click the terms checkbox (the div[role=button] parent of #GAME_FORM_TERMS)
  console.log('\n=== Check terms ===');
  const termsBtn = page.locator('#GAME_FORM_TERMS').locator('xpath=..');
  await termsBtn.click();
  await page.waitForTimeout(500);
  
  let termsState = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
  console.log('Terms checked:', termsState);

  if (!termsState) {
    // Try clicking the SVG checkbox visual
    console.log('Trying SVG...');
    await page.locator('#GAME_FORM_TERMS ~ svg').click();
    await page.waitForTimeout(500);
    termsState = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('Terms after SVG click:', termsState);
  }

  if (!termsState) {
    // Try using React fiber to invoke the onClick handler
    console.log('Trying React fiber...');
    await page.evaluate(() => {
      const termsParent = document.getElementById('GAME_FORM_TERMS').parentElement;
      // Find React fiber key
      const fiberKey = Object.keys(termsParent).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (fiberKey) {
        let fiber = termsParent[fiberKey];
        // Walk up the fiber tree to find an onClick handler
        while (fiber) {
          if (fiber.memoizedProps?.onClick) {
            console.log('[GAME] Found onClick on fiber: ' + fiber.type?.name || fiber.type);
            fiber.memoizedProps.onClick({ preventDefault: () => {}, stopPropagation: () => {} });
            break;
          }
          fiber = fiber.return;
        }
      } else {
        console.log('[GAME] No React fiber found, keys: ' + Object.keys(termsParent).filter(k => k.startsWith('__')).join(', '));
      }
    });
    await page.waitForTimeout(500);
    termsState = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('Terms after React fiber:', termsState);
  }

  if (!termsState) {
    // Try dispatching synthetic React event
    console.log('Trying synthetic React event...');
    await page.evaluate(() => {
      const cb = document.getElementById('GAME_FORM_TERMS');
      // React 16+ uses __reactProps$ or __reactEvents$ keys
      const propsKey = Object.keys(cb).find(k => k.startsWith('__reactProps$'));
      if (propsKey && cb[propsKey]?.onChange) {
        console.log('[GAME] Found onChange on input props');
        cb[propsKey].onChange({ target: { checked: true } });
      } else {
        // Try the parent's props
        const parent = cb.parentElement;
        const parentPropsKey = Object.keys(parent).find(k => k.startsWith('__reactProps$'));
        if (parentPropsKey && parent[parentPropsKey]?.onClick) {
          console.log('[GAME] Found onClick on parent props');
          parent[parentPropsKey].onClick({ preventDefault: () => {}, stopPropagation: () => {} });
        } else {
          console.log('[GAME] Props keys on input: ' + Object.keys(cb).filter(k => k.startsWith('__')).join(', '));
          console.log('[GAME] Props keys on parent: ' + Object.keys(parent).filter(k => k.startsWith('__')).join(', '));
        }
      }
    });
    await page.waitForTimeout(500);
    termsState = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('Terms after synthetic event:', termsState);
  }

  // Also try the marketing checkbox
  const marketingBtn = page.locator('#PARAM1').locator('xpath=..');
  await marketingBtn.click();
  await page.waitForTimeout(300);

  await page.screenshot({ path: 'screenshots/40-after-checkbox.png' });

  // Submit the form
  console.log('\n=== Submit form ===');
  const submitBtn = page.locator('[data-testid="GAMEFORM_SUBMIT_BUTTON"]');
  const submitState = await submitBtn.evaluate(el => ({
    disabled: el.disabled,
    cursor: window.getComputedStyle(el).cursor,
    opacity: window.getComputedStyle(el).opacity,
    value: el.value,
    pointerEvents: window.getComputedStyle(el).pointerEvents
  }));
  console.log('Submit state:', submitState);

  await submitBtn.click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'screenshots/41-after-submit.png' });

  // Check if form is gone
  const formGone = await page.evaluate(() => {
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    if (!form) return true;
    return window.getComputedStyle(form).display === 'none';
  });
  console.log('Form gone:', formGone);

  if (!formGone) {
    // Try pressing Enter on the submit button
    console.log('Trying Enter on submit...');
    await submitBtn.press('Enter');
    await page.waitForTimeout(2000);
    
    // Try clicking the form's submit via JavaScript
    console.log('Trying form.submit()...');
    await page.evaluate(() => {
      const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/42-after-more-tries.png' });
  }

  // Game play phase
  const gameStarted = await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="MODAL_CONTAINER"]');
    if (!modal) return true;
    return window.getComputedStyle(modal).display === 'none' || 
           window.getComputedStyle(modal).opacity === '0';
  });

  if (gameStarted) {
    console.log('\n=== GAME STARTED! Playing... ===');
    const start = Date.now();
    let taps = 0;
    while (Date.now() - start < 45000) {
      const x = taps % 2 === 0 ? 100 : 275;
      await page.mouse.click(x, 400);
      await page.waitForTimeout(150 + Math.random() * 250);
      taps++;
    }
    console.log(`Tapped ${taps} times`);
    await page.waitForTimeout(5000);
  } else {
    console.log('\nGame did NOT start. Form still blocking.');
  }

  await page.screenshot({ path: 'screenshots/43-final.png' });
  
  console.log('\n=== All API calls ===');
  apiCalls.forEach((c, i) => console.log(`${i}: ${c.method} ${c.url}`));

  await browser.close();
  console.log('\nDone');
})();
