const { chromium } = require('/tmp/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto('http://127.0.0.1:5000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/shot_default.png' });

  // 制造多种问题：越界穿综、未踩踏、空踏板+踩踏、长浮线
  await page.evaluate(() => {
    const s = window.__loom.state;
    s.draft.threading[2] = 99;
    s.draft.treadling[3] = -1;
    for (let i = 0; i < 8; i++) s.draft.threading[i] = 0;
    for (let i = 0; i < 6; i++) s.draft.treadling[i] = 0;
    s.draft.tieup = s.draft.tieup.map((row, sh) =>
      row.map((v, t) => (t === 0 ? sh === 0 : false)));
    s.draft.maxFloat = 3;
    afterEdit();
    focusIssue(0);
  });
  await page.waitForTimeout(700);
  const issueBadge = await page.textContent('#issueCount');
  console.log('issue badge:', issueBadge);
  await page.screenshot({ path: '/tmp/shot_issues.png' });

  // 播放高亮：单步到第 3 纬
  await page.evaluate(() => { stepPick(2); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/shot_playback.png' });
  await page.evaluate(() => stopPlay());

  // 真实交互：切换平纹模板 -> 问题应清零
  await page.click('[data-tpl="plain"]');
  await page.waitForTimeout(300);
  const badge2 = await page.textContent('#issueCount');
  console.log('after plain template badge:', badge2);
  const stat = await page.textContent('#statText');
  console.log('stat line 1:', stat.split('\n')[0]);

  // 走真实 API 保存
  const saveId = await page.evaluate(async () => {
    document.querySelector('#draftName').value = '浏览器测试稿';
    await saveDraft();
    return window.__loom.state.savedId;
  });
  console.log('saved id via UI:', saveId);

  // 草稿箱
  await page.click('#btnOpen');
  await page.waitForTimeout(300);
  const rowCount = await page.locator('#draftRows tr').count();
  console.log('draft rows:', rowCount);
  await page.screenshot({ path: '/tmp/shot_drafts.png' });
  await page.keyboard.press('Escape');

  // 方案比较：与刚保存的平纹稿比较（当前仍是平纹，应等效）
  if (saveId) {
    await page.selectOption('#cmpSource', String(saveId));
    await page.waitForTimeout(400);
    const cmpText = await page.textContent('#cmpResult');
    console.log('compare snippet:', cmpText.replace(/\s+/g, ' ').slice(0, 160));
    await page.screenshot({ path: '/tmp/shot_compare.png' });
  }

  // 打印渲染（不真的弹打印对话框）
  await page.evaluate(() => { window.print = () => {}; doPrint(); });
  await page.waitForTimeout(300);
  const printCanvasW = await page.evaluate(() => document.querySelector('#printCanvas').width);
  console.log('print canvas width:', printCanvasW);

  if (errors.length) {
    console.log('BROWSER ERRORS:');
    errors.forEach(e => console.log(' -', e));
    process.exit(1);
  }
  console.log('NO BROWSER ERRORS');
  await browser.close();
})();
