const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // Disable overlays and submit form
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

  // Submit form
  await page.evaluate(() => {
    const form = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
    const pk = Object.keys(form).find(k => k.startsWith('__reactProps$'));
    if (pk) form[pk].onSubmit({ preventDefault: () => {}, stopPropagation: () => {}, target: form, currentTarget: form, nativeEvent: new Event('submit') });
  });
  await page.waitForTimeout(3000);

  const formGone = await page.evaluate(() => !document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'));
  console.log('Game started:', formGone);
  if (!formGone) { await browser.close(); return; }

  // NOW: Explore the Phaser game internals
  console.log('\n=== Exploring Phaser game instance ===');
  
  const gameInfo = await page.evaluate(() => {
    // Find the Phaser game instance - could be on window or a global
    const results = {};
    
    // Check common locations
    for (const key of Object.getOwnPropertyNames(window)) {
      const val = window[key];
      if (val && typeof val === 'object') {
        if (val.scene || val.physics || val.renderer || val.canvas) {
          results.phaserKeys = results.phaserKeys || [];
          results.phaserKeys.push(key);
        }
      }
    }
    
    // Check Phaser global
    if (window.Phaser) {
      results.phaserVersion = window.Phaser.VERSION;
      // Find game instances
      if (window.Phaser.GAMES) {
        results.gameCount = window.Phaser.GAMES.length;
      }
    }
    
    // Try to find the game through the canvas
    const canvas = document.querySelector('canvas');
    if (canvas) {
      const canvasKeys = Object.keys(canvas).filter(k => !k.startsWith('__'));
      results.canvasKeys = canvasKeys;
      
      // Check for Phaser game reference on canvas parent
      const parent = canvas.parentElement;
      if (parent) {
        const parentKeys = Object.getOwnPropertyNames(parent).filter(k => !k.startsWith('__'));
        results.parentKeys = parentKeys.slice(0, 20);
      }
    }
    
    return results;
  });
  console.log('Game info:', JSON.stringify(gameInfo, null, 2));

  // Try to access via Phaser.GAMES
  const gameDetails = await page.evaluate(() => {
    if (!window.Phaser || !window.Phaser.GAMES || !window.Phaser.GAMES.length) {
      return 'No Phaser.GAMES found';
    }
    
    const game = window.Phaser.GAMES[0];
    const results = {
      isRunning: game.isRunning,
      isPaused: game.isPaused,
      isBooted: game.isBooted,
      sceneKeys: [],
      activeScenes: [],
      config: {
        width: game.config?.width,
        height: game.config?.height,
        type: game.config?.renderType,
      }
    };
    
    // Explore scenes
    if (game.scene) {
      const scenes = game.scene.scenes || [];
      for (const scene of scenes) {
        const sceneInfo = {
          key: scene.sys?.settings?.key || scene.scene?.key || 'unknown',
          active: scene.sys?.settings?.active,
          visible: scene.sys?.settings?.visible,
          childrenCount: 0,
          physicsEnabled: !!scene.physics,
        };
        
        // Count children
        if (scene.children && scene.children.list) {
          sceneInfo.childrenCount = scene.children.list.length;
          
          // Get types of first few children
          sceneInfo.childTypes = scene.children.list.slice(0, 20).map(c => ({
            type: c.type || c.constructor?.name,
            name: c.name || '',
            x: Math.round(c.x || 0),
            y: Math.round(c.y || 0),
            active: c.active,
            visible: c.visible,
            texture: c.texture?.key || ''
          }));
        }
        
        // Check for physics bodies
        if (scene.physics && scene.physics.world) {
          sceneInfo.physicsBodies = scene.physics.world.bodies?.size || 0;
        }
        
        results.sceneKeys.push(sceneInfo);
        if (sceneInfo.active) results.activeScenes.push(sceneInfo.key);
      }
    }
    
    return results;
  });
  console.log('\nGame details:', JSON.stringify(gameDetails, null, 2));

  // Explore the active scene more deeply
  const sceneExplore = await page.evaluate(() => {
    const game = window.Phaser?.GAMES?.[0];
    if (!game) return 'no game';
    
    const scenes = game.scene.scenes || [];
    const activeScene = scenes.find(s => s.sys?.settings?.active);
    if (!activeScene) return 'no active scene';
    
    const results = {
      sceneKey: activeScene.sys?.settings?.key,
      sceneProps: Object.getOwnPropertyNames(activeScene).filter(k => !k.startsWith('_')).slice(0, 50),
    };
    
    // Look for game objects that could be platforms or player
    if (activeScene.children?.list) {
      const groups = {};
      for (const child of activeScene.children.list) {
        const type = child.type || child.constructor?.name || 'unknown';
        const texture = child.texture?.key || 'none';
        const key = `${type}:${texture}`;
        if (!groups[key]) groups[key] = { count: 0, examples: [] };
        groups[key].count++;
        if (groups[key].examples.length < 3) {
          groups[key].examples.push({
            x: Math.round(child.x),
            y: Math.round(child.y),
            w: Math.round(child.width || child.displayWidth || 0),
            h: Math.round(child.height || child.displayHeight || 0),
            active: child.active,
            name: child.name || ''
          });
        }
      }
      results.objectGroups = groups;
    }
    
    // Check for named properties that could be player/platforms
    for (const prop of Object.getOwnPropertyNames(activeScene)) {
      const val = activeScene[prop];
      if (val && typeof val === 'object' && val.x !== undefined && val.y !== undefined) {
        results[`prop_${prop}`] = {
          x: Math.round(val.x),
          y: Math.round(val.y),
          type: val.type || val.constructor?.name,
          texture: val.texture?.key || ''
        };
      }
      // Check for groups/arrays of game objects
      if (val && val.children && Array.isArray(val.children.list)) {
        results[`group_${prop}`] = {
          count: val.children.list.length,
          firstItems: val.children.list.slice(0, 3).map(c => ({
            x: Math.round(c.x), y: Math.round(c.y),
            texture: c.texture?.key || '',
            active: c.active
          }))
        };
      }
    }
    
    return results;
  });
  console.log('\nScene exploration:', JSON.stringify(sceneExplore, null, 2));

  await page.screenshot({ path: 'screenshots/80-game-state.png' });
  await browser.close();
  console.log('\nDone');
})();
