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

  // Click START GAME
  console.log('\n=== Click START GAME ===');
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);

  // Fill form
  console.log('\n=== Fill form ===');
  await page.locator('input[placeholder="Name"]').fill('Will Wilson');
  await page.locator('input[placeholder="Enter your e-mail address"]').fill('willtwilson+gifflar@gmail.com');
  await page.locator('input[placeholder="username"]').fill('Frilliam');
  console.log('Fields filled');

  // Disable ALL overlays that intercept pointer events
  console.log('\n=== Disable overlays ===');
  await page.evaluate(() => {
    // Kill the backdrop
    const backdrop = document.querySelector('[data-testid="MODAL_BACKDROP"]');
    if (backdrop) backdrop.style.pointerEvents = 'none';
    
    // Kill additional text container
    const additional = document.querySelector('[data-testid="ADDITIONAL_TEXT_CONTAINER"]');
    if (additional) additional.style.pointerEvents = 'none';
    
    // Set form container to be properly positioned
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    if (form) {
      form.style.position = 'relative';
      form.style.zIndex = '99999';
    }
    
    // Also kill ALL other potential overlays
    document.querySelectorAll('[data-testid]').forEach(el => {
      const testId = el.dataset.testid;
      if (testId !== 'GAMEFORM_CONTAINER' && testId !== 'GAMEFORM_SUBMIT_BUTTON' && 
          !testId.startsWith('GAMEFORM_INPUT')) {
        const style = window.getComputedStyle(el);
        if (style.position === 'absolute' || style.position === 'fixed') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 200 && rect.height > 200) {
            el.style.pointerEvents = 'none';
            console.log('[GAME] Disabled pointer-events on: ' + testId + 
              ` pos=${style.position} z=${style.zIndex} rect=${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
          }
        }
      }
    });
  });
  await page.waitForTimeout(500);

  // Try checking terms checkbox via multiple methods
  console.log('\n=== Check terms checkbox ===');
  
  // Method 1: Force-click the parent div
  console.log('Method 1: Force-click parent div[role=button]');
  await page.locator('#GAME_FORM_TERMS').locator('xpath=..').click({ force: true });
  await page.waitForTimeout(500);
  let checked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
  console.log('  Result:', checked);

  if (!checked) {
    // Method 2: Tap the checkbox area
    console.log('Method 2: Tap at checkbox coordinates');
    await page.touchscreen.tap(87, 515);
    await page.waitForTimeout(500);
    checked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('  Result:', checked);
  }

  if (!checked) {
    // Method 3: Use React internal props
    console.log('Method 3: React internal props');
    const reactResult = await page.evaluate(() => {
      // Find all React internal keys on the terms checkbox and its ancestors
      const cb = document.getElementById('GAME_FORM_TERMS');
      const parent = cb.parentElement; // div[role=button]
      const grandparent = parent.parentElement;
      
      const results = [];
      for (const [label, el] of [['input', cb], ['parent', parent], ['grandparent', grandparent]]) {
        const keys = Object.keys(el).filter(k => k.startsWith('__react'));
        results.push({ label, keys });
        
        for (const key of keys) {
          const val = el[key];
          if (key.includes('Props')) {
            const handlers = Object.keys(val).filter(k => k.startsWith('on'));
            results.push({ label: `${label}.${key}`, handlers, hasOnClick: !!val.onClick, hasOnChange: !!val.onChange });
            
            // Try invoking onClick if found
            if (val.onClick) {
              try {
                val.onClick({ target: cb, currentTarget: parent, preventDefault: () => {}, stopPropagation: () => {}, nativeEvent: new MouseEvent('click') });
                results.push({ label: `${label}.onClick`, invoked: true });
              } catch (e) {
                results.push({ label: `${label}.onClick`, error: e.message });
              }
            }
            if (val.onChange) {
              try {
                val.onChange({ target: { ...cb, checked: true }, preventDefault: () => {}, stopPropagation: () => {} });
                results.push({ label: `${label}.onChange`, invoked: true });
              } catch (e) {
                results.push({ label: `${label}.onChange`, error: e.message });
              }
            }
          }
        }
      }
      return results;
    });
    console.log('  React props:', JSON.stringify(reactResult, null, 2));
    await page.waitForTimeout(500);
    checked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('  Result:', checked);
  }

  if (!checked) {
    // Method 4: Use dispatchEvent with full synthetic event chain
    console.log('Method 4: Full synthetic event chain');
    await page.evaluate(() => {
      const cb = document.getElementById('GAME_FORM_TERMS');
      const parent = cb.parentElement;
      
      // Simulate full mouse interaction on the parent div
      const events = [
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' }),
        new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' }),
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
        new MouseEvent('mouseup', { bubbles: true, cancelable: true }),
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      ];
      for (const evt of events) {
        parent.dispatchEvent(evt);
      }
    });
    await page.waitForTimeout(500);
    checked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('  Result:', checked);
  }

  if (!checked) {
    // Method 5: Find and call the React setState function via fiber
    console.log('Method 5: React fiber setState');
    const fiberResult = await page.evaluate(() => {
      const cb = document.getElementById('GAME_FORM_TERMS');
      let fiber = null;
      
      // Find React fiber
      for (const key of Object.keys(cb)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          fiber = cb[key];
          break;
        }
      }
      
      if (!fiber) return 'No fiber found';
      
      // Walk up the fiber tree looking for state with checkbox value
      let current = fiber;
      const fiberPath = [];
      while (current) {
        const info = {
          type: typeof current.type === 'function' ? current.type.name || 'anonymous' : current.type,
          hasState: !!current.memoizedState,
          hasOnClick: !!current.memoizedProps?.onClick,
          hasOnChange: !!current.memoizedProps?.onChange,
          stateKeys: current.memoizedState ? Object.keys(current.memoizedState).slice(0, 5) : []
        };
        fiberPath.push(info);
        
        // If this fiber has an onClick, invoke it
        if (current.memoizedProps?.onClick) {
          try {
            current.memoizedProps.onClick({
              target: cb,
              currentTarget: cb.parentElement,
              preventDefault: () => {},
              stopPropagation: () => {},
              nativeEvent: new MouseEvent('click', { bubbles: true })
            });
            return { invoked: current.type?.name || current.type, fiberPath };
          } catch (e) {
            return { error: e.message, fiberPath };
          }
        }
        
        current = current.return;
        if (fiberPath.length > 15) break;
      }
      return { noHandler: true, fiberPath };
    });
    console.log('  Fiber result:', JSON.stringify(fiberResult, null, 2));
    await page.waitForTimeout(500);
    checked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
    console.log('  Result:', checked);
  }

  await page.screenshot({ path: 'screenshots/50-checkbox-debug.png' });

  // Now try submitting regardless
  console.log('\n=== Submit form ===');
  const submitBtn = page.locator('[data-testid="GAMEFORM_SUBMIT_BUTTON"]');
  await submitBtn.click({ force: true });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'screenshots/51-after-submit.png' });

  // Check game state
  const state = await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="MODAL_CONTAINER"]');
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    return {
      modalDisplay: modal ? window.getComputedStyle(modal).display : 'not found',
      formDisplay: form ? window.getComputedStyle(form).display : 'not found',
      formVisible: form ? form.offsetParent !== null : false
    };
  });
  console.log('State after submit:', state);

  console.log('\n=== All API calls ===');
  apiCalls.forEach((c, i) => console.log(`${i}: ${c.method} ${c.url}`));

  await browser.close();
  console.log('\nDone');
})();
