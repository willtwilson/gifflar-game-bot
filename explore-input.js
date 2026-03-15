const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-web-security', '--no-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });

  const page = await context.newPage();

  // Inject Phaser hook before page loads
  await page.addInitScript(() => {
    let w = setInterval(() => {
      if (window.Phaser && !window.__ph) {
        window.__ph = true;
        const OG = window.Phaser.Game;
        window.Phaser.Game = function(...a) {
          const i = new OG(...a);
          window.__PHASER_GAME__ = i;
          return i;
        };
        Object.setPrototypeOf(window.Phaser.Game, OG);
        window.Phaser.Game.prototype = OG.prototype;
        clearInterval(w);
      }
    }, 10);
  });

  console.log('Navigating to game...');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle',
    timeout: 30000
  });
  await page.waitForTimeout(2000);

  // Disable overlays and elevate form
  await page.evaluate(() => {
    ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => {
      const e = document.querySelector(`[data-testid="${t}"]`);
      if (e) e.style.pointerEvents = 'none';
    });
    const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    if (f) { f.style.position = 'relative'; f.style.zIndex = '99999'; }
  });

  console.log('Clicking START GAME...');
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);

  console.log('Filling form fields...');
  for (const [p, v] of [
    ['Name', 'Will Wilson'],
    ['Enter your e-mail address', 'willtwilson+giff@gmail.com'],
    ['username', 'Frilliam']
  ]) {
    await page.locator(`input[placeholder="${p}"]`).click({ force: true });
    await page.locator(`input[placeholder="${p}"]`).fill(v);
  }

  console.log('Checking checkboxes via React...');
  await page.evaluate(() => {
    ['GAME_FORM_TERMS', 'PARAM1'].forEach(id => {
      const c = document.getElementById(id);
      if (!c) { console.warn('Checkbox not found:', id); return; }
      const p = Object.keys(c).find(k => k.startsWith('__reactProps$'));
      if (p && c[p].onChange) c[p].onChange({ target: { checked: true } });
    });
  });
  await page.waitForTimeout(300);

  console.log('Submitting form via React...');
  await page.evaluate(() => {
    const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
    if (!f) { console.warn('Form not found'); return; }
    const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
    if (p) f[p].onSubmit({
      preventDefault: () => {},
      stopPropagation: () => {},
      target: f,
      currentTarget: f,
      nativeEvent: new Event('submit')
    });
  });

  console.log('Waiting for game to start (with possible navigation)...');
  // Wait for any navigation to settle
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 8000 });
    console.log('Navigation detected, page settled');
  } catch(e) {
    console.log('No navigation detected (or timeout), continuing...');
  }
  await page.waitForTimeout(3000);

  // Wait for GAME_SCENE to be active
  await page.waitForFunction(() => {
    const game = window.__PHASER_GAME__;
    if (!game) return false;
    const scene = game.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    return !!scene;
  }, { timeout: 20000 }).catch(() => console.log('GAME_SCENE not found within timeout'));

  await page.waitForTimeout(2000);

  console.log('\n=== EXTRACTING GAME SCENE INFO ===\n');

  const info = await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    if (!game) return { error: 'No Phaser game found' };

    const scenes = game.scene?.scenes || [];
    const sceneKeys = scenes.map(s => s.sys?.settings?.key);

    const scene = scenes.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    if (!scene) return { error: 'GAME_SCENE not found', availableScenes: sceneKeys };

    // Standard Phaser scene properties to filter out
    const standardProps = new Set([
      'sys','version','game','anims','cache','plugins','registry','scale','sound',
      'textures','renderer','events','cameras','make','add','scene','children',
      'time','data','input','load','tweens','lights','physics','matter','facebook',
      'arcade','impact'
    ]);

    // Get all own properties
    const allOwnProps = Object.getOwnPropertyNames(scene);
    const customProps = allOwnProps.filter(k => !standardProps.has(k));

    // Get values of custom props (safely)
    const customPropValues = {};
    for (const k of customProps) {
      try {
        const val = scene[k];
        const t = typeof val;
        if (t === 'function') {
          customPropValues[k] = `[Function: ${val.name || 'anonymous'}]`;
        } else if (t === 'object' && val !== null) {
          customPropValues[k] = `[Object: ${val.constructor?.name || 'Object'}]`;
        } else {
          customPropValues[k] = val;
        }
      } catch(e) {
        customPropValues[k] = `[Error: ${e.message}]`;
      }
    }

    // Get update source
    let updateSource = null;
    try {
      updateSource = scene.update?.toString();
    } catch(e) {
      updateSource = `Error: ${e.message}`;
    }

    // Check sys.scene.update
    let sysSceneUpdateSource = null;
    try {
      sysSceneUpdateSource = scene.sys?.scene?.update?.toString();
    } catch(e) {
      sysSceneUpdateSource = `Error: ${e.message}`;
    }

    // Input info
    let inputInfo = {};
    try {
      const inp = scene.input;
      inputInfo = {
        hasInput: !!inp,
        inputType: inp?.constructor?.name,
        activePointer: inp?.activePointer ? {
          x: inp.activePointer.x,
          y: inp.activePointer.y,
          isDown: inp.activePointer.isDown,
          worldX: inp.activePointer.worldX,
          worldY: inp.activePointer.worldY,
          downX: inp.activePointer.downX,
          downY: inp.activePointer.downY,
        } : null,
        pointers: inp?.pointers?.length,
        mousePointer: inp?.mousePointer ? { x: inp.mousePointer.x, isDown: inp.mousePointer.isDown } : null,
      };
    } catch(e) {
      inputInfo = { error: e.message };
    }

    // Check for touch / pointer related custom props
    const touchRelated = {};
    for (const k of customProps) {
      const kl = k.toLowerCase();
      if (kl.includes('touch') || kl.includes('pointer') || kl.includes('direction') ||
          kl.includes('left') || kl.includes('right') || kl.includes('input') ||
          kl.includes('move') || kl.includes('steer') || kl.includes('cursor') ||
          kl.includes('player') || kl.includes('tap') || kl.includes('press')) {
        try {
          touchRelated[k] = scene[k];
        } catch(e) {
          touchRelated[k] = `[Error]`;
        }
      }
    }

    return {
      availableScenes: sceneKeys,
      updateSource,
      sysSceneUpdateSource,
      inputInfo,
      customProps: customPropValues,
      touchRelated,
      sceneKeys: Object.getOwnPropertyNames(scene).length,
      // Check some potential property names
      directChecks: {
        isTouching: scene.isTouching,
        pointerX: scene.pointerX,
        playerDirection: scene.playerDirection,
        direction: scene.direction,
        touchX: scene.touchX,
        isLeft: scene.isLeft,
        isRight: scene.isRight,
        moveLeft: scene.moveLeft,
        moveRight: scene.moveRight,
        cursors: scene.cursors,
        pointer: scene.pointer,
      }
    };
  });

  console.log('Available scenes:', info.availableScenes);
  console.log('\n--- UPDATE() SOURCE ---');
  console.log(info.updateSource || '(none)');
  console.log('\n--- SYS.SCENE.UPDATE() SOURCE ---');
  console.log(info.sysSceneUpdateSource || '(none)');
  console.log('\n--- INPUT INFO ---');
  console.log(JSON.stringify(info.inputInfo, null, 2));
  console.log('\n--- DIRECT CHECKS ---');
  console.log(JSON.stringify(info.directChecks, null, 2));
  console.log('\n--- TOUCH RELATED PROPS ---');
  console.log(JSON.stringify(info.touchRelated, null, 2));
  console.log('\n--- ALL CUSTOM PROPS (' + Object.keys(info.customProps || {}).length + ') ---');
  console.log(JSON.stringify(info.customProps, null, 2));

  // Now try injecting steering
  console.log('\n=== ATTEMPTING INPUT INJECTION ===');
  console.log('Setting pointer isDown=true, x=600 (RIGHT half) for 3 seconds...');

  await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    if (!scene) return;

    const ptr = scene.input?.activePointer;
    if (ptr) {
      ptr.isDown = true;
      ptr.x = 600;
      ptr.worldX = 600;
      ptr.downX = 600;
    }
    // Also try isTouching
    scene.isTouching = true;
    // Store original for reference
    window.__injecting__ = true;
  });

  await page.waitForTimeout(3000);

  // Check player position after right injection
  const posRight = await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    if (!scene) return null;
    // Try to find player object
    const playerCandidates = {};
    for (const k of Object.getOwnPropertyNames(scene)) {
      try {
        const v = scene[k];
        if (v && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number' && v.constructor?.name !== 'Scene') {
          playerCandidates[k] = { x: v.x, y: v.y, type: v.constructor?.name };
        }
      } catch(e) {}
    }
    return playerCandidates;
  });

  console.log('\nObjects with x,y after RIGHT injection:');
  console.log(JSON.stringify(posRight, null, 2));

  console.log('\nSwitching to LEFT (x=150) for 3 seconds...');
  await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    if (!scene) return;

    const ptr = scene.input?.activePointer;
    if (ptr) {
      ptr.isDown = true;
      ptr.x = 150;
      ptr.worldX = 150;
      ptr.downX = 150;
    }
  });

  await page.waitForTimeout(3000);

  const posLeft = await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    if (!scene) return null;
    const playerCandidates = {};
    for (const k of Object.getOwnPropertyNames(scene)) {
      try {
        const v = scene[k];
        if (v && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number' && v.constructor?.name !== 'Scene') {
          playerCandidates[k] = { x: v.x, y: v.y, type: v.constructor?.name };
        }
      } catch(e) {}
    }
    return playerCandidates;
  });

  console.log('\nObjects with x,y after LEFT injection:');
  console.log(JSON.stringify(posLeft, null, 2));

  // Release pointer
  await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    if (scene?.input?.activePointer) {
      scene.input.activePointer.isDown = false;
    }
    window.__injecting__ = false;
  });

  // Also dump the full update source without truncation
  console.log('\n=== FULL UPDATE SOURCE (no truncation) ===');
  const fullUpdate = await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    return scene?.update?.toString() || 'N/A';
  });
  console.log(fullUpdate);

  // Also try to find pointer/input handling in the prototype chain
  console.log('\n=== PROTOTYPE CHAIN METHODS ===');
  const protoInfo = await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    if (!scene) return 'no scene';

    const methods = [];
    let proto = Object.getPrototypeOf(scene);
    while (proto && proto !== Object.prototype) {
      const names = Object.getOwnPropertyNames(proto);
      methods.push({
        class: proto.constructor?.name,
        methods: names.filter(n => typeof proto[n] === 'function' && n !== 'constructor')
      });
      proto = Object.getPrototypeOf(proto);
    }
    return methods;
  });
  console.log(JSON.stringify(protoInfo, null, 2));

  console.log('\nDone. Keeping browser open for 10 seconds...');
  await page.waitForTimeout(10000);

  await browser.close();
})();
