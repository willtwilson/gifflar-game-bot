const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  // Hook Phaser.Game constructor
  await page.addInitScript(() => {
    let watchInterval = setInterval(() => {
      if (window.Phaser && !window.__phaserHooked) {
        window.__phaserHooked = true;
        const OrigGame = window.Phaser.Game;
        if (OrigGame) {
          const origConstruct = OrigGame.prototype.constructor;
          window.Phaser.Game = function(...args) {
            const instance = new OrigGame(...args);
            window.__PHASER_GAME__ = instance;
            return instance;
          };
          Object.setPrototypeOf(window.Phaser.Game, OrigGame);
          window.Phaser.Game.prototype = OrigGame.prototype;
        }
        clearInterval(watchInterval);
      }
    }, 10);
  });

  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // Submit form to start game
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

  console.log('=== Game started, exploring state ===');

  // Wait a moment for game to initialize fully
  await page.waitForTimeout(2000);

  // Explore game scene and objects
  const gameState = await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    if (!game) return 'no game instance';

    const result = {
      isRunning: game.isRunning,
      sceneCount: game.scene?.scenes?.length || 0,
      scenes: []
    };

    const scenes = game.scene?.scenes || [];
    for (const scene of scenes) {
      const sceneData = {
        key: scene.sys?.settings?.key || 'unknown',
        active: scene.sys?.settings?.active,
        visible: scene.sys?.settings?.visible,
        props: Object.getOwnPropertyNames(scene).filter(k => !k.startsWith('_')).slice(0, 60),
      };

      // Explore all named properties on the scene
      const gameObjects = {};
      for (const prop of Object.getOwnPropertyNames(scene)) {
        const val = scene[prop];
        if (!val || typeof val !== 'object') continue;
        
        // Check if it's a game object (has x, y)
        if (val.x !== undefined && val.y !== undefined && val.type) {
          gameObjects[prop] = {
            type: val.type,
            x: Math.round(val.x),
            y: Math.round(val.y),
            texture: val.texture?.key || '',
            active: val.active,
            visible: val.visible,
            velocity: val.body ? { x: Math.round(val.body.velocity?.x || 0), y: Math.round(val.body.velocity?.y || 0) } : null,
            scale: val.scaleX !== undefined ? { x: val.scaleX, y: val.scaleY } : null,
          };
        }
        
        // Check if it's a group/container with children
        if (val.children?.list?.length > 0 || val.getChildren) {
          const children = val.children?.list || (val.getChildren ? val.getChildren() : []);
          gameObjects[prop] = {
            type: 'Group',
            count: children.length,
            items: children.slice(0, 5).map(c => ({
              type: c.type || c.constructor?.name,
              x: Math.round(c.x),
              y: Math.round(c.y),
              w: Math.round(c.width || c.displayWidth || 0),
              h: Math.round(c.height || c.displayHeight || 0),
              texture: c.texture?.key || '',
              active: c.active,
              name: c.name || '',
              body: c.body ? { vx: Math.round(c.body.velocity?.x || 0), vy: Math.round(c.body.velocity?.y || 0) } : null
            }))
          };
        }
        
        // Check for arrays of game objects
        if (Array.isArray(val) && val.length > 0 && val[0]?.x !== undefined) {
          gameObjects[prop] = {
            type: 'Array',
            count: val.length,
            items: val.slice(0, 5).map(c => ({
              type: c.type || c.constructor?.name,
              x: Math.round(c.x),
              y: Math.round(c.y),
              texture: c.texture?.key || '',
              active: c.active
            }))
          };
        }
      }

      sceneData.gameObjects = gameObjects;
      result.scenes.push(sceneData);
    }

    return result;
  });
  console.log(JSON.stringify(gameState, null, 2));

  // Also check Flarie.Fysics namespace
  const fysicsInfo = await page.evaluate(() => {
    if (!window.Phaser?.Physics?.Fysics) return 'no Fysics';
    const F = window.Phaser.Physics.Fysics;
    return {
      keys: Object.getOwnPropertyNames(F).slice(0, 20),
      hasGame: !!F.game,
      gameType: typeof F.game
    };
  });
  console.log('\nFysics:', JSON.stringify(fysicsInfo));

  await page.screenshot({ path: 'screenshots/82-game-running.png' });
  await browser.close();
  console.log('\nDone');
})();
