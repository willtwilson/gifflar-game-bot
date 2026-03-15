'use strict';
const { chromium } = require('playwright');

const EMAIL    = 'willtwilson+giff@gmail.com';
const NAME     = 'Will Wilson';
const USERNAME = 'Frilliam';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  await page.addInitScript(() => {
    window.__TEXTURES_SEEN__ = new Set();
    const orig = setInterval(() => {
      if (!window.Phaser || window.__ph2) return;
      window.__ph2 = true;
      const OG = window.Phaser.Game;
      window.Phaser.Game = function(...args) {
        const game = new OG(...args);
        window.__PHASER_GAME__ = game;
        game.events.on('step', () => {
          const scene = game.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
          if (!scene) return;
          const all = [...(scene.platformPool||[]),...(scene.introPlatforms||[]),...(scene.trampolines||[])];
          all.forEach(p => { if (p?.active && p.texture?.key) window.__TEXTURES_SEEN__.add(p.texture.key); });
        });
        return game;
      };
      Object.setPrototypeOf(window.Phaser.Game, OG);
      window.Phaser.Game.prototype = OG.prototype;
      clearInterval(orig);
    }, 10);
  });

  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Fill form if shown
  const hasForm = await page.evaluate(() => !!document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'));
  if (hasForm) {
    await page.locator('[data-testid="START_BUTTON"]').click({ force: true }).catch(()=>{});
    await page.waitForTimeout(1000);
    for (const [ph, val] of [['Name', NAME], ['Enter your e-mail address', EMAIL], ['username', USERNAME]]) {
      await page.locator(`input[placeholder="${ph}"]`).fill(val).catch(()=>{});
    }
    await page.evaluate(() => {
      ['GAME_FORM_TERMS','PARAM1'].forEach(id => {
        const c = document.getElementById(id); if (!c) return;
        const p = Object.keys(c).find(k=>k.startsWith('__reactProps$'));
        if (p && c[p].onChange) c[p].onChange({ target: { checked: true } });
      });
      const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form'); if (!f) return;
      const p = Object.keys(f).find(k=>k.startsWith('__reactProps$'));
      if (p) f[p].onSubmit({ preventDefault:()=>{}, stopPropagation:()=>{}, target:f, currentTarget:f, nativeEvent: new Event('submit') });
    });
    await page.waitForTimeout(2000);
  }

  console.log('Collecting texture keys for 60 seconds...');
  await page.waitForTimeout(60000);

  const textures = await page.evaluate(() => [...window.__TEXTURES_SEEN__]);
  console.log('\nUnique platform texture keys observed:');
  textures.sort().forEach(t => console.log(` - "${t}"`));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
