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
      if (req.postData()) console.log(`   ${req.postData().substring(0, 400)}`);
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

  // Disable ALL overlay pointer events upfront
  await page.evaluate(() => {
    document.querySelectorAll('[data-testid]').forEach(el => {
      const tid = el.dataset.testid;
      if (['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER', 'SCORE_CONTAINER', 
           'LEADERBOARD_CONTAINER', 'START_BUTTON'].includes(tid)) {
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
  console.log('\n=== Click START GAME ===');
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);

  // Fill form via React-compatible input simulation
  console.log('\n=== Fill form (React-compatible) ===');
  
  // Use Playwright's native fill which triggers React events properly
  const nameInput = page.locator('input[placeholder="Name"]');
  const emailInput = page.locator('input[placeholder="Enter your e-mail address"]');
  const usernameInput = page.locator('input[placeholder="username"]');
  
  await nameInput.click({ force: true });
  await nameInput.fill('Will Wilson');
  await page.waitForTimeout(200);
  
  await emailInput.click({ force: true });
  await emailInput.fill('willtwilson+gifflar@gmail.com');
  await page.waitForTimeout(200);
  
  await usernameInput.click({ force: true });
  await usernameInput.fill('Frilliam');
  await page.waitForTimeout(200);

  // Check terms via React onChange
  console.log('\n=== Check terms checkbox (React onChange) ===');
  await page.evaluate(() => {
    const cb = document.getElementById('GAME_FORM_TERMS');
    const propsKey = Object.keys(cb).find(k => k.startsWith('__reactProps$'));
    if (propsKey && cb[propsKey].onChange) {
      cb[propsKey].onChange({ target: { checked: true } });
    }
  });
  await page.waitForTimeout(500);
  
  // Verify checkbox state
  const termsChecked = await page.evaluate(() => document.getElementById('GAME_FORM_TERMS')?.checked);
  console.log('Terms checked:', termsChecked);

  // Also check marketing consent via React
  await page.evaluate(() => {
    const cb = document.getElementById('PARAM1');
    const propsKey = Object.keys(cb).find(k => k.startsWith('__reactProps$'));
    if (propsKey && cb[propsKey].onChange) {
      cb[propsKey].onChange({ target: { checked: true } });
    }
  });

  await page.screenshot({ path: 'screenshots/60-form-ready.png' });

  // Debug submit button state
  console.log('\n=== Submit button analysis ===');
  const submitAnalysis = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="GAMEFORM_SUBMIT_BUTTON"]');
    if (!btn) return 'no submit button found';
    
    const style = window.getComputedStyle(btn);
    const propsKey = Object.keys(btn).find(k => k.startsWith('__reactProps$'));
    const props = propsKey ? btn[propsKey] : {};
    const handlers = propsKey ? Object.keys(props).filter(k => k.startsWith('on')) : [];
    
    // Also find the form element and its React props
    const form = btn.closest('form');
    let formHandlers = [];
    if (form) {
      const formPropsKey = Object.keys(form).find(k => k.startsWith('__reactProps$'));
      if (formPropsKey) {
        formHandlers = Object.keys(form[formPropsKey]).filter(k => k.startsWith('on'));
      }
    }
    
    return {
      disabled: btn.disabled,
      cursor: style.cursor,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      backgroundColor: style.backgroundColor,
      value: btn.value,
      type: btn.type,
      handlers,
      formExists: !!form,
      formHandlers,
      formAction: form?.action || '',
    };
  });
  console.log('Submit button:', JSON.stringify(submitAnalysis, null, 2));

  // Try submitting the form via React's onSubmit handler
  console.log('\n=== Submit via React onSubmit ===');
  const submitResult = await page.evaluate(() => {
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
    if (!form) return 'no form found';
    
    const propsKey = Object.keys(form).find(k => k.startsWith('__reactProps$'));
    if (!propsKey) return 'no React props on form';
    
    const props = form[propsKey];
    if (props.onSubmit) {
      try {
        // Create a mock submit event
        const event = {
          preventDefault: () => {},
          stopPropagation: () => {},
          target: form,
          currentTarget: form,
          nativeEvent: new Event('submit')
        };
        props.onSubmit(event);
        return 'onSubmit invoked';
      } catch (e) {
        return 'onSubmit error: ' + e.message;
      }
    }
    return 'no onSubmit handler, available: ' + Object.keys(props).join(', ');
  });
  console.log('Form submit result:', submitResult);
  await page.waitForTimeout(3000);

  // Check if form is gone now
  let formState = await page.evaluate(() => {
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    const modal = document.querySelector('[data-testid="MODAL_CONTAINER"]');
    return {
      formDisplay: form ? window.getComputedStyle(form).display : 'removed',
      modalDisplay: modal ? window.getComputedStyle(modal).display : 'removed',
      formInDom: !!form
    };
  });
  console.log('After React submit:', formState);
  await page.screenshot({ path: 'screenshots/61-after-react-submit.png' });

  if (formState.formInDom && formState.formDisplay !== 'none') {
    // Try clicking the submit button normally (without force)
    console.log('\n=== Try normal submit click ===');
    try {
      await page.locator('[data-testid="GAMEFORM_SUBMIT_BUTTON"]').click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log('Normal click failed:', e.message.split('\n')[0]);
      // Try force click
      await page.locator('[data-testid="GAMEFORM_SUBMIT_BUTTON"]').click({ force: true });
      await page.waitForTimeout(3000);
    }

    formState = await page.evaluate(() => {
      const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
      return {
        formDisplay: form ? window.getComputedStyle(form).display : 'removed',
        formInDom: !!form
      };
    });
    console.log('After click submit:', formState);
    await page.screenshot({ path: 'screenshots/62-after-click-submit.png' });
  }

  if (formState.formInDom && formState.formDisplay !== 'none') {
    // Try invoking the submit button's onClick via React props
    console.log('\n=== Try React submit button onClick ===');
    const btnResult = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="GAMEFORM_SUBMIT_BUTTON"]');
      const propsKey = Object.keys(btn).find(k => k.startsWith('__reactProps$'));
      if (!propsKey) return 'no props';
      const props = btn[propsKey];
      
      const results = [];
      for (const handler of Object.keys(props).filter(k => k.startsWith('on'))) {
        try {
          props[handler]({ target: btn, currentTarget: btn, preventDefault: () => {}, stopPropagation: () => {}, nativeEvent: new Event(handler.slice(2).toLowerCase()) });
          results.push(handler + ': invoked');
        } catch (e) {
          results.push(handler + ': error - ' + e.message);
        }
      }
      return results;
    });
    console.log('Button handlers result:', btnResult);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/63-after-btn-react.png' });
  }

  // Final check
  formState = await page.evaluate(() => {
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    const modal = document.querySelector('[data-testid="MODAL_CONTAINER"]');
    return {
      formDisplay: form ? window.getComputedStyle(form).display : 'removed',
      modalDisplay: modal ? window.getComputedStyle(modal).display : 'removed',
      formInDom: !!form
    };
  });
  console.log('\n=== Final state ===');
  console.log(formState);

  // If game started, play
  if (!formState.formInDom || formState.formDisplay === 'none') {
    console.log('\n=== GAME STARTED! Playing for 60s ===');
    const start = Date.now();
    let taps = 0;
    while (Date.now() - start < 60000) {
      const x = taps % 2 === 0 ? 100 : 275;
      await page.mouse.click(x, 400);
      await page.waitForTimeout(150 + Math.random() * 250);
      taps++;
    }
    console.log(`Tapped ${taps} times`);
    await page.waitForTimeout(5000);
  } else {
    console.log('\nGame still not started.');
  }

  await page.screenshot({ path: 'screenshots/64-final.png' });
  console.log('\n=== All API calls ===');
  apiCalls.forEach((c, i) => console.log(`${i}: ${c.method} ${c.url}\n   ${(c.body || '').substring(0, 200)}`));

  await browser.close();
  console.log('\nDone');
})();
