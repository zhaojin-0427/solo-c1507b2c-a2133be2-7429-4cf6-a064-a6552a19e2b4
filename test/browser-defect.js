const { chromium } = require('/tmp/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto('http://127.0.0.1:5000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // 打开试织回标模态
  await page.click('#btnDefect');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/shot_df_empty.png' });

  // 建批次
  await page.click('#dfNewBatch');
  await page.waitForTimeout(100);
  await page.fill('#dfBatchName', '浏览器试织批次');
  await page.click('#dfCreateSubmit');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/shot_df_batch.png' });

  // 在布面内点 4 个点（不同类型）：用 world() 与画布几何把布面 mm 坐标换算到屏幕像素
  const spots = [
    [0.25, 0.25], [0.45, 0.45], [0.6, 0.55], [0.7, 0.7],
  ];
  for (let i = 0; i < spots.length; i++) {
    const types = ['miss', 'mistread', 'broken', 'float'];
    await page.click(`.df-type[data-type="${types[i]}"]`);
    const pt = await page.evaluate(([fx, fy]) => {
      const api = window.__defectAPI;
      const w = api.world();
      const RULER = { l: 42, t: 26 };
      const z = api.state.scaleFit * api.state.zoomUser;
      const mmX = w.q.originX + fx * w.clothW;
      const mmY = w.q.originY + fy * w.clothH;
      return {
        px: RULER.l + (mmX - w.xMin) * z,
        py: RULER.t + (mmY - w.yMin) * z,
      };
    }, spots[i]);
    const box = await page.locator('#dfOverlay').boundingBox();
    await page.mouse.click(box.x + pt.px, box.y + pt.py);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
  const markCount = await page.textContent('#dfMarkCount');
  console.log('mark count badge:', markCount);
  const listRows = await page.locator('#dfMarkList .df-mark').count();
  console.log('mark list rows:', listRows);
  await page.screenshot({ path: '/tmp/shot_df_marks.png' });

  // 备注
  await page.locator('#dfMarkList .df-note').first().fill('现场：第 3 纬附近漏纬，需复查');
  await page.waitForTimeout(700);

  // 反复 tab
  await page.click('.df-tab[data-tab="repeat"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/shot_df_repeat.png' });

  // 并排 tab
  await page.click('.df-tab[data-tab="view"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/shot_df_view.png' });

  // 修订 tab：从单点发起穿综修订并预览
  await page.click('.df-tab[data-tab="marks"]');
  await page.waitForTimeout(200);
  await page.locator('#dfMarkList .df-rev-quick').first().click();
  await page.waitForTimeout(200);
  await page.click('#rvPreview');
  await page.waitForTimeout(300);
  const diffText = await page.textContent('#rvDiff');
  console.log('diff snippet:', diffText.replace(/\s+/g, ' ').slice(0, 120));
  const applyEnabled = await page.locator('#rvApply').isEnabled();
  console.log('apply enabled after preview:', applyEnabled);
  await page.screenshot({ path: '/tmp/shot_df_revise.png' });

  // 应用并另存
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.click('#rvApply');
  await page.waitForTimeout(700);
  const modalClosed = await page.locator('#defectModal').evaluate(el => el.classList.contains('hidden'));
  console.log('modal closed after apply:', modalClosed);
  const draftName = await page.inputValue('#draftName');
  console.log('loaded new draft name:', draftName);

  // 打印（拦截系统对话框）
  await page.evaluate(() => { window.print = () => {}; });
  await page.click('#btnDefect');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__defectAPI.doPrint());
  await page.waitForTimeout(300);
  const pw = await page.evaluate(() => document.querySelector('#dfPrintCanvas').width);
  console.log('print canvas width:', pw);
  const legendHasMm = await page.evaluate(() => /实物 X/.test(document.querySelector('#dfPrintLegend').textContent));
  console.log('print table has mm column:', legendHasMm);

  if (errors.length) {
    console.log('BROWSER ERRORS:');
    errors.forEach(e => console.log(' -', e));
    process.exit(1);
  }
  console.log('NO BROWSER ERRORS');
  await browser.close();
})();
