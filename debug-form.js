const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });

  const page = await context.newPage();

  // Track API calls
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('flarie.com/api/') || url.includes('game-play-service')) {
      console.log(`>> ${req.method()} ${url.split('?')[0]}`);
      if (req.postData()) console.log(`   Body: ${req.postData().substring(0, 400)}`);
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
          console.log(`   ${JSON.stringify(body).substring(0, 400)}`);
        }
      } catch (e) {}
    }
  });

  page.on('console', msg => {
    if (msg.text().startsWith('[')) console.log(`[PAGE] ${msg.text()}`);
  });

  // Load game
  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // Inject message listener
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      if (event.data && typeof event.data === 'object') {
        console.log('[MSG] ' + JSON.stringify(event.data));
      }
    });
  });

  // Click START GAME to show form
  console.log('\n=== Clicking START GAME ===');
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);

  // Fill form fields
  console.log('\n=== Filling form ===');
  await page.locator('input[placeholder="Name"]').fill('Will Wilson');
  await page.locator('input[placeholder="Enter your e-mail address"]').fill('willtwilson+gifflar@gmail.com');
  await page.locator('input[placeholder="username"]').fill('Frilliam');
  console.log('Form fields filled');

  // Dump the FULL form container DOM structure
  const formDom = await page.evaluate(() => {
    const container = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]') || 
                     document.querySelector('[data-testid="MODAL_CONTAINER"]');
    if (!container) return 'No form container found';
    
    function dumpNode(node, depth = 0) {
      const results = [];
      if (node.nodeType === Node.ELEMENT_NODE) {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        results.push({
          depth,
          tag: node.tagName,
          id: node.id,
          testId: node.dataset?.testid || '',
          classes: node.className?.toString().substring(0, 50) || '',
          text: node.childNodes.length === 1 && node.childNodes[0].nodeType === Node.TEXT_NODE 
            ? node.textContent.trim().substring(0, 50) : '',
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          display: style.display,
          cursor: style.cursor,
          role: node.getAttribute('role') || '',
          type: node.type || ''
        });
        for (const child of node.children) {
          results.push(...dumpNode(child, depth + 1));
        }
      }
      return results;
    }
    return dumpNode(container);
  });
  console.log('\n=== Form container DOM tree ===');
  if (Array.isArray(formDom)) {
    formDom.forEach(n => {
      const indent = '  '.repeat(n.depth);
      const extra = [
        n.id ? `id=${n.id}` : '',
        n.testId ? `testId=${n.testId}` : '',
        n.text ? `"${n.text}"` : '',
        n.cursor !== 'auto' ? `cursor=${n.cursor}` : '',
        n.role ? `role=${n.role}` : '',
        n.type ? `type=${n.type}` : '',
      ].filter(Boolean).join(' ');
      console.log(`${indent}<${n.tag}> [${n.rect.x},${n.rect.y} ${n.rect.w}x${n.rect.h}] ${n.display} ${extra}`);
    });
  } else {
    console.log(formDom);
  }

  // Now also check what's in the modal backdrop/container area
  const modalDom = await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="MODAL_CONTAINER"]');
    if (!modal) return 'No MODAL_CONTAINER';
    
    const results = [];
    for (const child of modal.children) {
      const rect = child.getBoundingClientRect();
      const style = window.getComputedStyle(child);
      results.push({
        tag: child.tagName,
        testId: child.dataset?.testid || '',
        classes: child.className?.toString().substring(0, 80) || '',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        text: child.textContent?.trim().substring(0, 80),
        zIndex: style.zIndex,
        position: style.position,
        display: style.display,
        childCount: child.children.length
      });
    }
    return results;
  });
  console.log('\n=== Modal container direct children ===');
  if (Array.isArray(modalDom)) {
    modalDom.forEach(n => console.log(JSON.stringify(n)));
  } else {
    console.log(modalDom);
  }

  await page.screenshot({ path: 'screenshots/20-debug.png' });
  await browser.close();
  console.log('\nDone');
})();
