const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  // HOOK: Intercept Phaser.Game constructor BEFORE page loads
  await page.addInitScript(() => {
    // Monkey-patch to capture the Phaser game instance
    const origDefineProperty = Object.defineProperty;
    let phaserGameInstance = null;
    
    // Watch for Phaser global being set
    let phaserWatcher = setInterval(() => {
      if (window.Phaser && !window.__phaserHooked) {
        window.__phaserHooked = true;
        
        // Hook the Game constructor
        const OrigGame = window.Phaser.Game;
        if (OrigGame) {
          window.Phaser.Game = function(...args) {
            const instance = new OrigGame(...args);
            window.__PHASER_GAME__ = instance;
            console.log('[HOOK] Phaser.Game instance captured!');
            return instance;
          };
          // Copy static properties
          Object.setPrototypeOf(window.Phaser.Game, OrigGame);
          window.Phaser.Game.prototype = OrigGame.prototype;
        }
      }
    }, 50);
    
    // Also try to capture via requestAnimationFrame
    const origRAF = window.requestAnimationFrame;
    let rafHooked = false;
    window.requestAnimationFrame = function(callback) {
      if (!rafHooked && callback && callback.toString().includes('step')) {
        rafHooked = true;
        // Check if we can find the game instance through the callback's scope
      }
      return origRAF.call(window, callback);
    };
  });

  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // Check if hook worked
  let hasGame = await page.evaluate(() => !!window.__PHASER_GAME__);
  console.log('Hook captured game:', hasGame);

  if (!hasGame) {
    // Try to find it by scanning all reachable objects from window
    console.log('\n=== Deep scanning for Phaser game ===');
    const scanResult = await page.evaluate(() => {
      // Strategy 1: Check window props more carefully
      const found = [];
      for (const key of Object.getOwnPropertyNames(window)) {
        try {
          const val = window[key];
          if (val && typeof val === 'object' && val !== window && val !== document) {
            if (val.scene && val.config && typeof val.step === 'function') {
              found.push({ key, type: 'game-like', hasScene: true, hasConfig: true });
              window.__PHASER_GAME__ = val;
            }
            if (val.game && val.game.scene && val.game.config) {
              found.push({ key, type: 'has-game-prop' });
              window.__PHASER_GAME__ = val.game;
            }
          }
        } catch {}
      }
      
      // Strategy 2: Find via canvas's __game reference (some Phaser versions)
      const canvas = document.querySelector('canvas');
      if (canvas) {
        for (const key of Object.getOwnPropertyNames(canvas)) {
          try {
            if (canvas[key] && typeof canvas[key] === 'object' && canvas[key].scene) {
              found.push({ key: `canvas.${key}`, type: 'canvas-game' });
              window.__PHASER_GAME__ = canvas[key];
            }
          } catch {}
        }
        // Check parent element
        if (canvas.parentElement) {
          for (const key of Object.getOwnPropertyNames(canvas.parentElement)) {
            try {
              const val = canvas.parentElement[key];
              if (val && typeof val === 'object' && val.scene) {
                found.push({ key: `parent.${key}` });
                window.__PHASER_GAME__ = val;
              }
            } catch {}
          }
        }
      }
      
      // Strategy 3: Phaser stores games in an internal array
      if (window.Phaser) {
        const phaserKeys = Object.getOwnPropertyNames(window.Phaser);
        found.push({ phaserStaticKeys: phaserKeys.slice(0, 30) });
        
        if (window.Phaser.Display?.Canvas?.CanvasPool) {
          found.push({ canvasPool: 'exists' });
        }
      }
      
      // Strategy 4: Look for Flarie framework globals
      for (const key of ['flarie', 'Flarie', '__flarie', 'gameInstance', 'app', 'game']) {
        if (window[key]) {
          found.push({ key, type: typeof window[key], keys: Object.keys(window[key]).slice(0, 10) });
        }
      }
      
      // Strategy 5: Check all event listeners on the canvas
      // The game registers input events on the canvas
      
      return { found, hasGame: !!window.__PHASER_GAME__ };
    });
    console.log('Scan result:', JSON.stringify(scanResult, null, 2));
    hasGame = scanResult.hasGame;
  }

  if (!hasGame) {
    // Strategy 6: Hook into Phaser.Scene update to find game reference
    console.log('\n=== Trying scene prototype hook ===');
    const hookResult = await page.evaluate(() => {
      // Phaser.Scene.prototype should have references
      if (window.Phaser?.Scene?.prototype) {
        const proto = window.Phaser.Scene.prototype;
        const protoKeys = Object.getOwnPropertyNames(proto).slice(0, 20);
        return { protoKeys };
      }
      
      // Try to find through Phaser module internals
      if (window.Phaser) {
        // Check for Game class
        const gameProto = window.Phaser.Game?.prototype;
        if (gameProto) {
          return { gameProtoKeys: Object.getOwnPropertyNames(gameProto).slice(0, 30) };
        }
      }
      
      return 'no proto found';
    });
    console.log('Hook result:', JSON.stringify(hookResult));
  }

  // Now set up the game (form submission etc.)
  await page.evaluate(() => {
    ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(tid => {
      const el = document.querySelector(`[data-testid="${tid}"]`);
      if (el) el.style.pointerEvents = 'none';
    });
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    if (form) { form.style.position = 'relative'; form.style.zIndex = '99999'; }
  });
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);
  await page.locator('input[placeholder="Name"]').click({ force: true });
  await page.locator('input[placeholder="Name"]').fill('Will Wilson');
  await page.locator('input[placeholder="Enter your e-mail address"]').click({ force: true });
  await page.locator('input[placeholder="Enter your e-mail address"]').fill('willtwilson+gifflar@gmail.com');
  await page.locator('input[placeholder="username"]').click({ force: true });
  await page.locator('input[placeholder="username"]').fill('Frilliam');
  await page.evaluate(() => {
    ['GAME_FORM_TERMS', 'PARAM1'].forEach(id => {
      const cb = document.getElementById(id);
      const pk = Object.keys(cb).find(k => k.startsWith('__reactProps$'));
      if (pk && cb[pk].onChange) cb[pk].onChange({ target: { checked: true } });
    });
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
    const pk = Object.keys(form).find(k => k.startsWith('__reactProps$'));
    if (pk) form[pk].onSubmit({ preventDefault: () => {}, stopPropagation: () => {}, target: form, currentTarget: form, nativeEvent: new Event('submit') });
  });
  await page.waitForTimeout(3000);

  // Now try to find the game again after it's fully running
  console.log('\n=== Post-game-start: searching for Phaser game ===');
  const postStartSearch = await page.evaluate(() => {
    // The game might be accessible now through window scope changes
    const results = {};
    
    // Check if Phaser.GAMES was populated after game start
    if (window.Phaser?.GAMES) {
      results.phaserGamesLength = window.Phaser.GAMES.length;
    }
    
    // Check __PHASER_GAME__ from our hook
    if (window.__PHASER_GAME__) {
      results.hookWorked = true;
    }
    
    // Scan for ANY object with scene management
    const checked = new Set();
    function scanObj(obj, path, depth) {
      if (depth > 3 || checked.has(obj)) return;
      checked.add(obj);
      try {
        for (const key of Object.getOwnPropertyNames(obj)) {
          try {
            const val = obj[key];
            if (val && typeof val === 'object' && !checked.has(val)) {
              if (val.scene && val.config && val.canvas) {
                results.found = path + '.' + key;
                window.__PHASER_GAME__ = val;
                return;
              }
              if (depth < 2) scanObj(val, path + '.' + key, depth + 1);
            }
          } catch {}
        }
      } catch {}
    }
    
    // Check Flarie namespace
    for (const key of ['Flarie', 'flarie', '__NEXT_DATA__', 'Phaser']) {
      if (window[key]) {
        scanObj(window[key], key, 0);
      }
    }
    
    // Last resort: check all window enumerable properties
    for (const key in window) {
      try {
        const val = window[key];
        if (val && typeof val === 'object' && val.scene && val.config && val.canvas) {
          results.foundInWindow = key;
          window.__PHASER_GAME__ = val;
          break;
        }
      } catch {}
    }
    
    return results;
  });
  console.log('Post-start search:', JSON.stringify(postStartSearch, null, 2));

  // If still no game, try a different approach: intercept the game's update loop
  const finalAttempt = await page.evaluate(() => {
    // Try to find the game through the canvas context
    const canvas = document.querySelector('canvas');
    if (!canvas) return 'no canvas';
    
    // Check WebGL context for renderer reference
    const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
    const ctx2d = canvas.getContext('2d');
    
    // The Phaser renderer stores a reference to the game
    // Try to find it through Phaser's input manager (it listens on the canvas)
    const eventListeners = [];
    
    // Check for __zone_symbol__ keys (Angular zone.js) or event handler lists
    for (const key of Object.getOwnPropertyNames(canvas)) {
      if (key.includes('event') || key.includes('listener') || key.includes('handler')) {
        eventListeners.push(key);
      }
    }
    
    // Check if Phaser Input manager is on the canvas
    if (canvas.phaser) return { canvasPhaser: Object.keys(canvas.phaser) };
    
    return {
      contextType: gl ? 'webgl' : ctx2d ? '2d' : 'none',
      eventKeys: eventListeners,
      canvasKeys: Object.getOwnPropertyNames(canvas).filter(k => !k.startsWith('__')),
      allCanvasKeys: Object.getOwnPropertyNames(canvas)
    };
  });
  console.log('Canvas investigation:', JSON.stringify(finalAttempt, null, 2));

  await page.screenshot({ path: 'screenshots/81-explore2.png' });
  await browser.close();
  console.log('\nDone');
})();
