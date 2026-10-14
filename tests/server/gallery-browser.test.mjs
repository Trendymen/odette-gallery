import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { writeScoredGallery } from '../../src/gallery/render-scored-gallery.mjs';
import { createGalleryServer } from '../../src/server/server.mjs';
import { createCustomSelectionClient } from '../../src/gallery/custom-selection-client.mjs';

const make = (id, number, total, hidden = false) => ({ id, number, title: id, user: '测试作者', preview: 'p.jpg', original: 'o.png', frame: 'f.jpg', cropped: 'c.png', w: 1400, h: 800, crop: { width: 1400, height: 800 }, score: { total, rubricVersion: 'crop-v2' }, styleReview: { defaultVisible: !hidden }, versions: [] });
const artworks = [make('a', 1, 90), make('b', 2, 80), make('hidden', 3, 95, true)];
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function fixture(t, items = artworks) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-browser-')), galleryDirectory = path.join(dir, 'gallery'), stateFile = path.join(dir, 'state/custom.json'), exclusionsPath = path.join(dir, 'exclusions.json');
  await writeScoredGallery({ items, outputDirectory: galleryDirectory }); await fs.writeFile(path.join(galleryDirectory, 'manifest.json'), JSON.stringify(items)); await fs.writeFile(exclusionsPath, '{"excluded":[]}');
  const server = createGalleryServer({ galleryDirectory, stateFile, exclusionsPath }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port, context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(5000);
  t.after(async () => { await context.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const visit = async (file = 'thumbnails.html', query = '') => { await page.goto(origin + '/' + file + query); assert.equal(await page.locator('#selectionStatus').count(), 1, '页面须显示选择保存状态'); };
  const ready = () => page.waitForFunction(() => document.querySelector('#selectionStatus')?.dataset.ready === 'true');
  const ids = () => page.locator('.card').evaluateAll(nodes => nodes.map(n => n.dataset.id));
  return { dir, galleryDirectory, stateFile, exclusionsPath, server, origin, page, context, visit, ready, ids };
}
test('初次GET未确认或失败仍可本地选择，失败可重试恢复', async t => {
  const f = await fixture(t); let release; const gate = new Promise(r => { release = r; });
  await f.page.route('**/api/custom-candidates', async route => { await gate; await route.fulfill({ status: 503, json: { error: '目录读取失败' } }); });
  await f.visit(); assert.equal(await f.page.locator('.custom-check').first().isDisabled(), false); assert.equal(await f.page.locator('[data-scope="custom"]').isDisabled(), false);
  await f.page.route('**/api/custom-candidates/a', route => route.fulfill({ status: 500, json: { error: '保存失败' } }));
  await f.page.locator('[data-id="a"] .custom-check').click(); assert.equal(await f.page.locator('[data-id="a"] .custom-check').isChecked(), true);
  release(); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('目录读取失败')); assert.match(await f.page.locator('#selectionStatus').textContent(), /读取失败/);
  await f.page.locator('[data-id="b"] .custom-check').click(); assert.equal(await f.page.locator('[data-id="b"] .custom-check').isChecked(), true);
  await f.page.unroute('**/api/custom-candidates'); await f.page.unroute('**/api/custom-candidates/a'); await f.page.locator('#selectionRetry').click(); await f.ready(); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存'));
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, ['a', 'b']);
});
test('勾选立即生效，隐藏作品跨两个视图可见，勾选不导航，刷新恢复', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); let release; const gate = new Promise(r => { release = r; });
  await f.page.route('**/api/custom-candidates/a', async route => { await gate; await route.continue(); });
  await f.page.locator('[data-id="a"] .custom-check').check(); assert.ok(f.page.url().endsWith('/thumbnails.html'));
  await f.page.locator('[data-scope="custom"]').click(); assert.deepEqual(await f.ids(), ['a']); assert.match(await f.page.locator('#selectionStatus').textContent(), /保存中/);
  release(); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存'));
  await f.page.locator('[data-scope="hidden"]').click(); await f.page.locator('[data-id="hidden"] .custom-check').check(); await f.page.locator('[data-scope="custom"]').click(); assert.deepEqual(await f.ids(), ['hidden', 'a']);
  await f.page.locator('[data-id="hidden"] a').click(); await f.ready(); assert.equal(await f.page.locator('#title').textContent(), 'hidden'); assert.equal(new URL(f.page.url()).searchParams.get('scope'), 'custom');
  await f.page.reload(); await f.ready(); assert.equal(await f.page.locator('#customCheck').isChecked(), true);
  await f.page.locator('#thumbnails').click(); await f.ready(); assert.deepEqual(await f.ids(), ['hidden', 'a']);
});
test('单图取消当前定制项保留当前图，重入后展示最新集合与空状态', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); await f.page.locator('[data-id="a"] .custom-check').check(); await f.page.locator('[data-id="b"] .custom-check').check();
  await f.page.locator('[data-scope="custom"]').click(); await f.page.locator('[data-id="b"] a').click(); await f.ready(); assert.equal(await f.page.locator('#title').textContent(), 'b');
  await f.page.locator('#customCheck').click(); assert.equal(await f.page.locator('#title').textContent(), 'b'); assert.equal(await f.page.locator('#customCheck').isChecked(), false);
  await f.page.locator('#customScope').uncheck(); await f.page.locator('#customScope').check(); assert.equal(await f.page.locator('#title').textContent(), 'a');
  await f.page.locator('#customCheck').click(); assert.equal(await f.page.locator('#title').textContent(), 'a');
  await f.page.locator('#customScope').uncheck(); await f.page.locator('#customScope').check(); assert.equal(await f.page.locator('#empty').isVisible(), true);
});
test('保存失败保留最后本地意图，内部跨页停留，重试后导航完成', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); await f.page.route('**/api/custom-candidates/a', route => route.fulfill({ status: 500, json: { error: '保存测试失败' } }));
  await f.page.locator('[data-id="a"] .custom-check').check(); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('未保存'));
  await f.page.locator('[data-scope="custom"]').click(); assert.deepEqual(await f.ids(), ['a']); await f.page.locator('[data-id="a"] a').click(); assert.ok(f.page.url().includes('thumbnails.html'));
  await f.page.unroute('**/api/custom-candidates/a'); await f.page.locator('#selectionRetry').click(); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存'));
  await f.page.locator('[data-id="a"] a').click(); await f.ready(); assert.equal(await f.page.locator('#customCheck').isChecked(), true);
});
test('同ID快速反转只保存最后意图，跨页链接等待保存', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); let release, requests = 0; const gate = new Promise(r => { release = r; });
  await f.page.route('**/api/custom-candidates/a', async route => { requests++; if (requests === 1) await gate; await route.continue(); });
  await f.page.locator('[data-id="a"] .custom-check').check(); await f.page.locator('[data-id="a"] .custom-check').uncheck(); await f.page.locator('[data-id="a"] .custom-check').check();
  const clicked = f.page.locator('[data-id="a"] a').click(); await new Promise(r => setTimeout(r, 50)); assert.ok(f.page.url().includes('thumbnails.html')); assert.equal(requests, 1); release(); await clicked;
  await f.page.waitForURL('**/index.html?*'); await f.ready(); assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, ['a']);
});
test('两标签页广播及聚焦读取同步', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); const second = await f.context.newPage(); await second.goto(f.origin + '/index.html?id=a'); await second.waitForFunction(() => document.querySelector('#selectionStatus')?.dataset.ready === 'true');
  await f.page.locator('[data-id="a"] .custom-check').check(); await second.waitForFunction(() => document.querySelector('#customCheck').checked);
  await second.locator('#customCheck').uncheck(); await f.page.waitForFunction(() => !document.querySelector('[data-id="a"] .custom-check').checked);
  await fetch(f.origin + '/api/custom-candidates/b', { method: 'PUT', headers: { origin: f.origin, 'content-type': 'application/json' }, body: '{"selected":true}' });
  await f.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await f.page.waitForFunction(() => document.querySelector('[data-id="b"] .custom-check').checked);
});
test('低revision和旧目录GET晚到均不能覆盖新快照', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); let release, captured; const gate = new Promise(r => { release = r; }), oldCaptured = new Promise(r => { captured = r; }); let calls = 0;
  await f.page.route('**/api/custom-candidates', async route => { calls++; if (calls === 1) { const response = await route.fetch(); captured(); await gate; await route.fulfill({ response }); } else await route.continue(); });
  await f.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await oldCaptured;
  await fs.writeFile(f.exclusionsPath, '{"excluded":[{"id":"b"}]}'); await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await f.page.waitForFunction(() => !document.querySelector('[data-id="b"]') || document.querySelector('[data-id="b"] .custom-check')?.disabled);
  assert.equal(await f.page.locator('[data-id="b"]').count(), 0, '目录排除必须立即从普通视图移除');
  release(); await new Promise(r => setTimeout(r, 80)); assert.equal(await f.page.locator('[data-id="b"]').count(), 0);
});
test('file入口禁用保存和custom，原浏览仍可使用', async t => {
  const f = await fixture(t); await f.page.goto(pathToFileURL(path.join(f.galleryDirectory, 'thumbnails.html')).href); assert.equal(await f.page.locator('#selectionStatus').count(), 1);
  assert.match(await f.page.locator('#selectionStatus').textContent(), /本地服务/); assert.equal(await f.page.locator('[data-id="a"] .custom-check').isDisabled(), true); assert.equal(await f.page.locator('[data-scope="custom"]').isDisabled(), true);
  await f.page.locator('[data-scope="hidden"]').click(); assert.deepEqual(await f.ids(), ['hidden']);
});
test('单图主data仍为精选，custom完整目录支持默认版本及叠加条件', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); await f.page.locator('[data-scope="hidden"]').click(); await f.page.locator('[data-id="hidden"] .custom-check').check();
  await f.page.locator('[data-scope="custom"]').click(); await f.page.locator('[data-id="hidden"] a').click(); await f.ready();
  assert.deepEqual(await f.page.locator('#data').evaluate(n => JSON.parse(n.textContent).map(x => x.id)), ['a', 'b']);
  assert.equal(await f.page.locator('#title').textContent(), 'hidden'); await f.page.locator('#official').check(); assert.equal(await f.page.locator('#empty').isVisible(), true);
});
test('不同ID同时保存时，先返回响应不覆盖另一幅本地意图', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); let release; const gate = new Promise(r => { release = r; });
  await f.page.route('**/api/custom-candidates/b', async route => { await gate; await route.continue(); });
  await f.page.locator('[data-id="b"] .custom-check').check(); const firstSaved = f.page.waitForResponse(response => response.url().endsWith('/api/custom-candidates/a')); await f.page.locator('[data-id="a"] .custom-check').check(); await firstSaved;
  await f.page.locator('[data-scope="custom"]').click(); assert.deepEqual(await f.ids(), ['a', 'b']); assert.equal(await f.page.locator('[data-id="b"] .custom-check').isChecked(), true);
  release(); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存'));
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, ['a', 'b']);
});
test('客户端flush失败reject，retry保留意图并返回确认快照', async t => {
  const f = await fixture(t); await f.page.goto(f.origin + '/manifest.json');
  await f.page.evaluate(({ source, artworks }) => { window.testClient = (0, eval)('(' + source + ')')({ artworks }); }, { source: createCustomSelectionClient.toString(), artworks });
  await f.page.waitForFunction(() => window.testClient.getSnapshot().ready);
  await f.page.route('**/api/custom-candidates/a', route => route.fulfill({ status: 500, json: { error: '持久写入失败' } }));
  await f.page.evaluate(() => window.testClient.toggle('a', true));
  await f.page.waitForFunction(() => window.testClient.getSnapshot().failedIds.length === 1);
  const failed = await f.page.evaluate(async () => { try { await window.testClient.flush(); return 'resolved'; } catch (error) { return error.message; } }); assert.match(failed, /未保存/);
  assert.deepEqual(await f.page.evaluate(() => window.testClient.getSnapshot().selectedIds), ['a']);
  await f.page.unroute('**/api/custom-candidates/a'); await f.page.evaluate(() => window.testClient.retry());
  await f.page.evaluate(() => window.testClient.flush()); const saved = await f.page.evaluate(() => window.testClient.getSnapshot());
  assert.deepEqual(saved.selectedIds, ['a']); assert.deepEqual(saved.failedIds, []); assert.deepEqual(saved.pendingIds, []); assert.equal(saved.error, null); assert.equal(saved.revision, 1);
});
test('同ID进行中取消会串行保存false，不被旧true响应覆盖', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); let release, active = 0, maximum = 0; const gate = new Promise(r => { release = r; }); const values = [];
  await f.page.route('**/api/custom-candidates/a', async route => {
    active++; maximum = Math.max(maximum, active); values.push(route.request().postDataJSON().selected);
    if (values.length === 1) await gate;
    const response = await route.fetch(); active--; await route.fulfill({ response });
  });
  await f.page.locator('[data-id="a"] .custom-check').check(); await f.page.locator('[data-id="a"] .custom-check').uncheck(); release();
  await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存'));
  assert.equal(await f.page.locator('[data-id="a"] .custom-check').isChecked(), false); assert.deepEqual(values, [true, false]); assert.equal(maximum, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, []);
});
test('进入custom用默认版本，重建页面后按同ID使用新默认裁剪', async t => {
  const items = structuredClone(artworks);
  items[0].versions = [{ label: '默认', preview: 'default.jpg', score: { total: 90 } }, { label: '历史', preview: 'history.jpg', score: { total: 40 } }];
  const f = await fixture(t, items); await f.visit('index.html', '?id=a'); await f.ready();
  await f.page.locator('#version').selectOption('1'); assert.equal(await f.page.locator('#photo').getAttribute('src'), 'history.jpg');
  await f.page.locator('#customCheck').check(); await f.page.locator('#customScope').check(); assert.equal(await f.page.locator('#photo').getAttribute('src'), 'default.jpg');
  await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存'));
  items[0].versions[0].preview = 'new-default.jpg'; await writeScoredGallery({ items, outputDirectory: f.galleryDirectory }); await fs.writeFile(path.join(f.galleryDirectory, 'manifest.json'), JSON.stringify(items));
  await f.page.reload(); await f.ready(); assert.equal(await f.page.locator('#customCheck').isChecked(), true); assert.equal(await f.page.locator('#photo').getAttribute('src'), 'new-default.jpg');
});
test('persisted pagehide/pageshow后仍可跨标签收发广播', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); const second = await f.context.newPage(); await second.goto(f.origin + '/index.html?id=a'); await second.waitForFunction(() => document.querySelector('#selectionStatus')?.dataset.ready === 'true');
  await f.page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await second.locator('#customCheck').check(); await f.page.waitForFunction(() => document.querySelector('[data-id="a"] .custom-check').checked, null, { timeout: 2000 });
  await f.page.locator('[data-id="a"] .custom-check').uncheck(); await second.waitForFunction(() => !document.querySelector('#customCheck').checked, null, { timeout: 2000 });
});
test('键盘勾选及相同快照保留焦点，custom取消仍保留当前控件', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); await f.page.locator('[data-id="a"] .custom-check').focus(); await f.page.keyboard.press('Space');
  assert.equal(await f.page.evaluate(() => document.activeElement?.closest('.card')?.dataset.id), 'a');
  assert.equal(await f.page.evaluate(() => document.activeElement?.tagName), 'INPUT');
  await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存'));
  await f.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await new Promise(r => setTimeout(r, 60));
  assert.equal(await f.page.evaluate(() => document.activeElement?.closest('.card')?.dataset.id), 'a');
  await f.page.keyboard.press('Tab'); assert.equal(await f.page.evaluate(() => document.activeElement?.className), 'deletion-check');
  await f.page.keyboard.press('Tab'); assert.equal(await f.page.evaluate(() => document.activeElement?.closest('.card')?.dataset.id), 'b');
  const outline = await f.page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle); assert.equal(outline, 'solid');
  await f.page.locator('[data-id="b"] .custom-check').check(); await f.page.locator('[data-scope="custom"]').click(); await f.page.locator('[data-id="a"] .custom-check').focus(); await f.page.keyboard.press('Space');
  assert.deepEqual(await f.ids(), ['a', 'b']); assert.equal(await f.page.evaluate(() => document.activeElement?.closest('.card')?.dataset.id), 'a'); assert.equal(await f.page.evaluate(() => document.activeElement?.tagName), 'INPUT');
});
test('custom非首项返回瀑布流后重复focus保留单图ID，失效才fallback', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); await f.page.locator('[data-id="a"] .custom-check').check(); await f.page.locator('[data-id="b"] .custom-check').check(); await f.page.locator('[data-scope="custom"]').click(); await f.page.locator('[data-id="b"] a').click(); await f.ready();
  assert.equal(await f.page.locator('#title').textContent(), 'b'); await f.page.locator('#thumbnails').click(); await f.ready();
  for (let i = 0; i < 3; i++) {
    await f.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await new Promise(r => setTimeout(r, 50));
    const href = await f.page.locator('#singleView').getAttribute('href'); assert.equal(new URL(href, f.origin).searchParams.get('id'), 'b');
  }
  await f.page.locator('#singleView').click(); await f.ready(); assert.equal(await f.page.locator('#title').textContent(), 'b');
  await f.page.locator('#thumbnails').click(); await f.ready(); await f.page.locator('[data-id="b"] .custom-check').click(); assert.deepEqual(await f.ids(), ['a', 'b']); assert.equal(new URL(await f.page.locator('#singleView').getAttribute('href'), f.origin).searchParams.get('id'), 'b');
  await f.page.locator('[data-scope="custom"]').click(); assert.deepEqual(await f.ids(), ['a']); assert.equal(new URL(await f.page.locator('#singleView').getAttribute('href'), f.origin).searchParams.get('id'), 'a');
});

const longItems = () => Array.from({ length: 120 }, (_, i) => ({ ...make('art_' + i, i + 1, 100 - i / 10), preview: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }));
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function rememberScroll(page, id = 'art_60') {
  await frames(page); await page.locator('[data-id="' + id + '"] .custom-check').scrollIntoViewIfNeeded(); await frames(page);
  return page.evaluate(id => {
    window.testCard = document.querySelector('[data-id="' + id + '"]'); window.layoutWrites = 0; window.cardChanges = 0;
    new MutationObserver(records => { for (const record of records) { if (record.type === 'attributes') window.layoutWrites++; else window.cardChanges++; } }).observe(document.querySelector('#gallery'), { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });
    return window.scrollY;
  }, id);
}
async function assertScroll(page, before) {
  await frames(page); const result = await page.evaluate(() => ({ y: scrollY, same: window.testCard === document.querySelector('[data-id="' + window.testCard.dataset.id + '"]'), styleWrites: window.layoutWrites, cardChanges: window.cardChanges }));
  console.log('scroll evidence', JSON.stringify({ before, ...result }));
  assert.ok(before > 3000, '长列表应滚至实际下方'); assert.ok(Math.abs(result.y - before) <= 2, 'scrollY ' + before + ' -> ' + result.y); assert.equal(result.same, true); assert.equal(result.styleWrites, 0, '选择通知不应写网格布局'); assert.equal(result.cardChanges, 0, '选择通知不应重建卡片');
}
test('长列表首次GET响应不会重排或回顶', async t => {
  const f = await fixture(t, longItems()); let release, captured; const gate = new Promise(r => { release = r; }), got = new Promise(r => { captured = r; });
  await f.page.route('**/api/custom-candidates', async route => { const response = await route.fetch(); captured(); await gate; await route.fulfill({ response }); });
  await f.visit(); await got; const before = await rememberScroll(f.page); release(); await f.ready(); await assertScroll(f.page, before);
});
test('长列表原生勾选、延迟PUT和保存确认保持滚动与卡片', async t => {
  const f = await fixture(t, longItems()); await f.visit(); await f.ready(); let release; const gate = new Promise(r => { release = r; });
  await f.page.route('**/api/custom-candidates/art_60', async route => { await gate; await route.continue(); });
  const before = await rememberScroll(f.page); await f.page.locator('[data-id="art_60"] .custom-check').click(); assert.equal(await f.page.locator('[data-id="art_60"] .custom-check').isChecked(), true); await assertScroll(f.page, before);
  assert.match(await f.page.locator('#selectionStatus').textContent(), /保存中/); release(); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存')); await assertScroll(f.page, before);
});
test('长custom列表取消和跨标签广播只更新控件，重入才更新集合', async t => {
  const items = longItems(), f = await fixture(t, items);
  const state = await fetch(f.origin + '/api/custom-candidates').then(r => r.json()); await fs.writeFile(f.stateFile, JSON.stringify({ ...state, selectedIds: items.map(x => x.id), revision: 1 }));
  await f.visit('thumbnails.html', '?scope=custom'); await f.ready(); const before = await rememberScroll(f.page);
  await f.page.locator('[data-id="art_60"] .custom-check').click(); assert.equal(await f.page.locator('[data-id="art_60"] .custom-check').isChecked(), false); assert.equal(await f.page.locator('.card').count(), 120); await assertScroll(f.page, before);
  await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存')); await assertScroll(f.page, before);
  const second = await f.context.newPage(); await second.goto(f.origin + '/index.html?id=art_55'); await second.waitForFunction(() => document.querySelector('#selectionStatus').dataset.ready === 'true'); await second.locator('#customCheck').uncheck();
  await f.page.waitForFunction(() => !document.querySelector('[data-id="art_55"] .custom-check')?.checked); assert.equal(await f.page.locator('.card').count(), 120); await assertScroll(f.page, before);
  await f.page.locator('[data-scope="custom"]').click(); assert.equal(await f.page.locator('.card').count(), 118); assert.equal(await f.page.locator('[data-id="art_60"]').count(), 0);
});
for (const file of ['thumbnails.html', 'index.html']) test(file + '初GET pending原生click立即checked，晚GET不覆盖本地最后意图', async t => {
  const f = await fixture(t); let releaseGet, releasePut, captured; const getGate = new Promise(r => { releaseGet = r; }), putGate = new Promise(r => { releasePut = r; }), got = new Promise(r => { captured = r; });
  await f.page.route('**/api/custom-candidates', async route => { const response = await route.fetch(); captured(); await getGate; await route.fulfill({ response }); });
  await f.page.route('**/api/custom-candidates/a', async route => { await putGate; await route.continue(); });
  await f.visit(file, file === 'index.html' ? '?id=a' : ''); await got;
  const check = f.page.locator(file === 'index.html' ? '#customCheck' : '[data-id="a"] .custom-check'); assert.equal(await check.isDisabled(), false);
  await check.click(); assert.equal(await check.isChecked(), true); await check.click(); assert.equal(await check.isChecked(), false); await check.click(); assert.equal(await check.isChecked(), true);
  releaseGet(); await f.ready(); assert.equal(await check.isChecked(), true); assert.match(await f.page.locator('#selectionStatus').textContent(), /保存中/);
  releasePut(); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存')); assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, ['a']);
});
test('单图初GET失败仍可立即选择，重试后确认保存', async t => {
  const f = await fixture(t); await f.page.route('**/api/custom-candidates', route => route.fulfill({ status: 503, json: { error: '目录读取失败' } }));
  await f.page.route('**/api/custom-candidates/a', route => route.fulfill({ status: 500, json: { error: '写入失败' } }));
  await f.visit('index.html', '?id=a'); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('读取失败'));
  assert.equal(await f.page.locator('#customCheck').isDisabled(), false); await f.page.locator('#customCheck').click(); assert.equal(await f.page.locator('#customCheck').isChecked(), true);
  await f.page.unroute('**/api/custom-candidates'); await f.page.unroute('**/api/custom-candidates/a'); await f.page.locator('#selectionRetry').click();
  await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存')); assert.equal(await f.page.locator('#customCheck').isChecked(), true); assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, ['a']);
});
for (const file of ['thumbnails.html', 'index.html']) test(file + '未确认时可本地选入custom，权威目录排除立即移除', async t => {
  const f = await fixture(t); await fs.writeFile(f.exclusionsPath, '{"excluded":[{"id":"a"}]}'); let release, captured, releasePut; const gate = new Promise(r => { release = r; }), got = new Promise(r => { captured = r; }), putGate = new Promise(r => { releasePut = r; });
  await f.page.route('**/api/custom-candidates', async route => { const response = await route.fetch(); captured(); await gate; await route.fulfill({ response }); });
  await f.page.route('**/api/deletion-marks', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  await f.page.route('**/api/custom-candidates/a', async route => { await putGate; await route.continue(); });
  await f.visit(file, file === 'index.html' ? '?id=a' : ''); await got;
  await f.page.locator(file === 'index.html' ? '#customCheck' : '[data-id="a"] .custom-check').click();
  await f.page.locator(file === 'index.html' ? '#customScope' : '[data-scope="custom"]').click();
  if (file === 'index.html') assert.equal(await f.page.locator('#title').textContent(), 'a'); else assert.deepEqual(await f.ids(), ['a']);
  releasePut(); release(); await f.ready();
  if (file === 'index.html') assert.equal(await f.page.locator('#empty').isVisible(), true); else assert.deepEqual(await f.ids(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, []);
});
test('首次GET晚于PUT确认也不能回退已保存选择', async t => {
  const f = await fixture(t); let release, captured; const gate = new Promise(r => { release = r; }), got = new Promise(r => { captured = r; });
  await f.page.route('**/api/custom-candidates', async route => { const response = await route.fetch(); captured(); await gate; await route.fulfill({ response }); });
  await f.visit(); await got; await f.page.locator('[data-id="a"] .custom-check').click(); await f.ready(); await f.page.waitForFunction(() => document.querySelector('#selectionStatus').textContent.includes('已保存'));
  release(); await frames(f.page); assert.equal(await f.page.locator('[data-id="a"] .custom-check').isChecked(), true); await f.page.locator('[data-scope="custom"]').click(); assert.deepEqual(await f.ids(), ['a']);
});
test('单图custom广播取消仅更新当前勾选，重入后才改变浏览集合', async t => {
  const f = await fixture(t); await f.visit(); await f.ready(); await f.page.locator('[data-id="a"] .custom-check').click(); await f.page.locator('[data-id="b"] .custom-check').click(); await f.page.locator('[data-scope="custom"]').click(); await f.page.locator('[data-id="b"] a').click(); await f.ready();
  const second = await f.context.newPage(); await second.goto(f.origin + '/index.html?id=b'); await second.waitForFunction(() => document.querySelector('#selectionStatus').dataset.ready === 'true'); await second.locator('#customCheck').uncheck();
  await f.page.waitForFunction(() => !document.querySelector('#customCheck').checked); assert.equal(await f.page.locator('#title').textContent(), 'b'); assert.equal(await f.page.locator('#pick option').count(), 2);
  await f.page.locator('#customScope').uncheck(); await f.page.locator('#customScope').check(); assert.equal(await f.page.locator('#title').textContent(), 'a'); assert.equal(await f.page.locator('#pick option').count(), 1);
});
test('初次目录未确认时PUT410立即移除作品，旧GET不能恢复资格', async t => {
  const f = await fixture(t); let release, captured; const gate = new Promise(r => { release = r; }), got = new Promise(r => { captured = r; });
  await f.page.route('**/api/custom-candidates', async route => { const response = await route.fetch(); captured(); await gate; await route.fulfill({ response }); });
  await f.visit(); await got; await fs.writeFile(f.exclusionsPath, '{"excluded":[{"id":"a"}]}');
  const rejected = f.page.waitForResponse(response => response.url().endsWith('/api/custom-candidates/a') && response.status() === 410); await f.page.locator('[data-id="a"] .custom-check').click(); await rejected; await frames(f.page);
  assert.equal(await f.page.locator('[data-id="a"]').count(), 0, '明确排除的作品立即移除');
  release(); await f.ready(); await frames(f.page); assert.equal(await f.page.locator('[data-id="a"]').count(), 0, '旧目录不能恢复已排除作品');
  await f.page.unroute('**/api/custom-candidates'); const refreshed = f.page.waitForResponse(response => response.url().endsWith('/api/custom-candidates')); await f.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await refreshed; await frames(f.page); assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, []);
});
for (const file of ['thumbnails.html', 'index.html']) test(file + '删除标记即时切换且不影响浏览与定制集合，刷新恢复', async t => {
  const f = await fixture(t); await f.visit(file, file === 'index.html' ? '?id=a' : ''); await f.ready();
  const check = f.page.locator(file === 'index.html' ? '#deletionCheck' : '[data-id="a"] .deletion-check'); assert.equal(await check.count(), 1, '每幅作品应有删除标记开关');
  await f.page.locator(file === 'index.html' ? '#customCheck' : '[data-id="a"] .custom-check').click();
  await check.click(); assert.equal(await check.isChecked(), true);
  if (file === 'index.html') assert.equal(await f.page.locator('#title').textContent(), 'a'); else assert.deepEqual(await f.ids(), ['a', 'b']);
  await f.page.waitForFunction(() => document.querySelector('#deletionStatus').textContent.includes('已保存'));
  const marked = JSON.parse(await fs.readFile(path.join(path.dirname(f.stateFile), 'deletion-marks.json'), 'utf8')); assert.deepEqual(marked.markedIds, ['a']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, ['a']);
  await f.page.reload(); await f.ready(); await f.page.waitForFunction(() => document.querySelector('#deletionStatus').dataset.ready === 'true'); assert.equal(await check.isChecked(), true);
  await check.click(); assert.equal(await check.isChecked(), false); await f.page.waitForFunction(() => document.querySelector('#deletionStatus').textContent.includes('已保存')); assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, ['a']);
});
test('删除标记首次GET pending可本地切换，失败重试与跨标签同步', async t => {
  const f = await fixture(t); let release; const gate = new Promise(r => { release = r; });
  await f.page.route('**/api/deletion-marks', async route => { await gate; await route.continue(); }); await f.page.route('**/api/deletion-marks/a', route => route.fulfill({ status: 500, json: { error: '标记写入失败' } }));
  await f.visit(); assert.equal(await f.page.locator('[data-id="a"] .deletion-check').count(), 1); await f.page.locator('[data-id="a"] .deletion-check').click(); assert.equal(await f.page.locator('[data-id="a"] .deletion-check').isChecked(), true);
  await f.page.waitForFunction(() => document.querySelector('#deletionStatus').textContent.includes('未保存')); release(); await f.page.unroute('**/api/deletion-marks'); await f.page.unroute('**/api/deletion-marks/a'); await f.page.locator('#deletionRetry').click(); await f.page.waitForFunction(() => document.querySelector('#deletionStatus').textContent.includes('已保存'));
  const second = await f.context.newPage(); await second.goto(f.origin + '/index.html?id=a'); await second.waitForFunction(() => document.querySelector('#deletionStatus')?.dataset.ready === 'true'); assert.equal(await second.locator('#deletionCheck').isChecked(), true);
  await second.locator('#deletionCheck').uncheck(); await f.page.waitForFunction(() => !document.querySelector('[data-id="a"] .deletion-check').checked); assert.deepEqual(await f.ids(), ['a', 'b']);
});
test('长列表删除标记pending及确认不回顶、不重排或重建卡片', async t => {
  const f = await fixture(t, longItems()); await f.visit(); await f.page.waitForFunction(() => document.querySelector('#deletionStatus')?.dataset.ready === 'true'); let release; const gate = new Promise(r => { release = r; });
  await f.page.route('**/api/deletion-marks/art_60', async route => { await gate; await route.continue(); }); const before = await rememberScroll(f.page);
  await f.page.locator('[data-id="art_60"] .deletion-check').click(); assert.equal(await f.page.locator('[data-id="art_60"] .deletion-check').isChecked(), true); await assertScroll(f.page, before);
  release(); await f.page.waitForFunction(() => document.querySelector('#deletionStatus').textContent.includes('已保存')); await assertScroll(f.page, before);
});
test('删除标记file入口禁用，目录排除不能通过标记复活', async t => {
  const f = await fixture(t); await f.visit(); assert.equal(await f.page.locator('[data-id="a"] .deletion-check').count(), 1);
  await fs.writeFile(f.exclusionsPath, '{"excluded":[{"id":"a"}]}'); const rejected = f.page.waitForResponse(response => response.url().endsWith('/api/deletion-marks/a') && response.status() === 410); await f.page.locator('[data-id="a"] .deletion-check').click(); await rejected; await frames(f.page); assert.equal(await f.page.locator('[data-id="a"]').count(), 0);
  await f.page.goto(pathToFileURL(path.join(f.galleryDirectory, 'thumbnails.html')).href); assert.equal(await f.page.locator('[data-id="a"] .deletion-check').isDisabled(), true); assert.match(await f.page.locator('#deletionStatus').textContent(), /本地服务/);
});
for (const file of ['thumbnails.html', 'index.html']) test(file + '删除标记初GET pending可即时反转，内部跨页等待最后意图保存', async t => {
  const f = await fixture(t); let releaseGet, releasePut, captured; const getGate = new Promise(r => { releaseGet = r; }), putGate = new Promise(r => { releasePut = r; }), got = new Promise(r => { captured = r; });
  await f.page.route('**/api/deletion-marks', async route => { const response = await route.fetch(); captured(); await getGate; await route.fulfill({ response }); });
  await f.page.route('**/api/deletion-marks/a', async route => { await putGate; await route.continue(); });
  await f.visit(file, file === 'index.html' ? '?id=a' : ''); await got;
  const check = f.page.locator(file === 'index.html' ? '#deletionCheck' : '[data-id="a"] .deletion-check'); assert.equal(await check.isDisabled(), false);
  await check.click(); assert.equal(await check.isChecked(), true); await check.click(); assert.equal(await check.isChecked(), false); await check.click(); assert.equal(await check.isChecked(), true);
  releaseGet(); await f.page.waitForFunction(() => document.querySelector('#deletionStatus').dataset.ready === 'true'); assert.equal(await check.isChecked(), true);
  const navigation = f.page.locator(file === 'index.html' ? '#thumbnails' : '[data-id="a"] a').click(); await new Promise(r => setTimeout(r, 50)); assert.equal(new URL(f.page.url()).pathname, '/' + file);
  releasePut(); await navigation; await f.page.waitForURL(file === 'index.html' ? '**/thumbnails.html?*' : '**/index.html?*');
  await f.page.waitForFunction(() => document.querySelector('#deletionStatus').dataset.ready === 'true'); assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(f.stateFile), 'deletion-marks.json'), 'utf8')).markedIds, ['a']);
});
test('IF-S1 custom取消后像素官方偏右条件只过滤冻结集合，重入才更新成员', async t => {
  const items = structuredClone(artworks); for (const item of items) { item.crop.width = 4200; item.official = true; item.rightFocus = true; }
  const f = await fixture(t, items); await f.visit(); await f.ready(); await f.page.locator('[data-id="a"] .custom-check').click(); await f.page.locator('[data-id="b"] .custom-check').click();
  await f.page.locator('[data-scope="custom"]').click(); await f.page.locator('[data-id="b"] a').click(); await f.ready();
  await f.page.locator('#customCheck').click(); assert.equal(await f.page.locator('#title').textContent(), 'b'); assert.equal(await f.page.locator('#pick option').count(), 2);
  await f.page.locator('#pixels').selectOption('2000'); assert.equal(await f.page.locator('#title').textContent(), 'b'); assert.equal(await f.page.locator('#pick option').count(), 2);
  await f.page.locator('#official').check(); await f.page.locator('#right').check(); assert.equal(await f.page.locator('#title').textContent(), 'b'); assert.equal(await f.page.locator('#pick option').count(), 2);
  await f.page.locator('#customScope').uncheck(); await f.page.locator('#customScope').check(); assert.equal(await f.page.locator('#title').textContent(), 'a'); assert.equal(await f.page.locator('#pick option').count(), 1);
});
for (const resource of ['custom-candidates', 'deletion-marks']) test('IF-S2 ' + resource + '首GET与PUT双失败同时显示读取失败及未保存', async t => {
  const f = await fixture(t), endpoint = '/api/' + resource, prefix = resource === 'deletion-marks' ? 'deletion' : 'selection';
  const selector = resource === 'deletion-marks' ? '.deletion-check' : '.custom-check';
  await f.page.route('**' + endpoint, route => route.fulfill({ status: 503, json: { error: '目录读取失败' } }));
  await f.page.route('**' + endpoint + '/a', route => route.fulfill({ status: 500, json: { error: '保存写入失败' } }));
  await f.visit(); await f.page.waitForFunction(prefix => document.querySelector('#' + prefix + 'Status').textContent.includes('读取失败'), prefix);
  const failed = f.page.waitForResponse(response => response.url().endsWith(endpoint + '/a') && response.status() === 500); await f.page.locator('[data-id="a"] ' + selector).click(); await failed; await frames(f.page);
  const text = await f.page.locator('#' + prefix + 'Status').textContent(); assert.match(text, /读取失败/); assert.match(text, /未保存/); assert.equal(await f.page.locator('[data-id="a"] ' + selector).isChecked(), true);
  await f.page.unroute('**' + endpoint); await f.page.unroute('**' + endpoint + '/a'); await f.page.locator('#' + prefix + 'Retry').click(); await f.page.waitForFunction(prefix => document.querySelector('#' + prefix + 'Status').textContent.includes('已保存'), prefix);
});
for (const resource of ['custom-candidates', 'deletion-marks']) for (const status of [404, 410]) test('CQ-ID-1 ' + resource + ' PUT' + status + '旧GET保留终止失败，禁止导航，明确重试后才恢复', async t => {
  const f = await fixture(t), endpoint = '/api/' + resource, prefix = resource === 'deletion-marks' ? 'deletion' : 'selection';
  const selector = resource === 'deletion-marks' ? '.deletion-check' : '.custom-check'; let release, captured;
  const gate = new Promise(r => { release = r; }), got = new Promise(r => { captured = r; });
  await f.page.route('**' + endpoint, async route => { const response = await route.fetch(); captured(); await gate; await route.fulfill({ response }); });
  await f.visit(); await got;
  if (status === 410) await fs.writeFile(f.exclusionsPath, '{"excluded":[{"id":"a"}]}');
  else await fs.writeFile(path.join(f.galleryDirectory, 'manifest.json'), JSON.stringify(artworks.filter(item => item.id !== 'a')));
  const failed = f.page.waitForResponse(response => response.url().endsWith(endpoint + '/a') && response.status() === status); await f.page.locator('[data-id="a"] ' + selector).click(); await failed; await frames(f.page);
  assert.match(await f.page.locator('#' + prefix + 'Status').textContent(), /未保存/); assert.equal(await f.page.locator('[data-id="a"]').count(), 0);
  release(); await f.page.waitForFunction(prefix => document.querySelector('#' + prefix + 'Status').dataset.ready === 'true', prefix); await frames(f.page);
  const text = await f.page.locator('#' + prefix + 'Status').textContent(); assert.match(text, /未保存/); assert.match(text, status === 410 ? /排除/ : /未找到/); assert.equal(await f.page.locator('[data-id="a"]').count(), 0);
  const before = f.page.url(); await f.page.locator('#singleView').click(); await frames(f.page); assert.equal(f.page.url(), before, '失败未关闭时flush应拒绝跨页导航');
  await f.page.unroute('**' + endpoint); await f.page.locator('#' + prefix + 'Retry').click(); await f.page.waitForFunction(prefix => document.querySelector('#' + prefix + 'Status').textContent.includes('已保存'), prefix);
  assert.equal(await f.page.locator('[data-id="a"]').count(), 0); await f.page.locator('#singleView').click(); await f.page.waitForURL('**/index.html?*');
});
