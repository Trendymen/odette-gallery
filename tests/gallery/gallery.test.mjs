import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeScoredGallery } from '../../src/gallery/render-scored-gallery.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const outputDirectory = path.join(os.tmpdir(), 'odette-renderer-' + process.pid);
const manifest = JSON.parse(await readFile(path.join(root, 'tests/fixtures/manifest-557.json'), 'utf8'));
const sample = structuredClone(manifest.find(x => x.number === 13));
const fixture = (id, number, total, visible) => ({ ...structuredClone(sample), id, number, title: id, score: { ...sample.score, total }, styleReview: visible === undefined ? undefined : { defaultVisible: visible, reason: '隐藏理由' }, versions: [] });
const a = fixture('current', 2, 99, true);
a.versions = [{ ...sample.versions[0], label: '当前', preview: 'current-preview.jpg', score: { ...sample.score, total: 70 } }, { ...sample.versions[1], label: '历史', preview: 'historical-preview.jpg', score: { ...sample.score, total: 40 } }];
const injection = '</script><script>globalThis.injected=true</script><b>标题</b>';
const items = [a, fixture('hidden', 4, 90, false), fixture('tie', 1, 70), { ...fixture('low', 3, 60, true), title: injection, user: injection }];
let browser, page;

before(async () => {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeScoredGallery({ items, outputDirectory });
  await writeScoredGallery({ items: manifest, outputDirectory: path.join(outputDirectory, 'real') });
  browser = await chromium.launch({ headless: true });
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.route('**/*', route => /\.(jpg|png)$/.test(route.request().url()) ? route.abort() : route.continue());
});
afterEach(async () => { await page.close(); });
after(async () => { await browser?.close(); await rm(outputDirectory, { recursive: true, force: true }); });
const visit = (file, query = '', directory = outputDirectory) => page.goto(pathToFileURL(path.join(directory, file)).href + query, { waitUntil: 'domcontentloaded' });
const cards = () => page.locator('[data-id]').evaluateAll(nodes => nodes.map(n => ({ id: n.dataset.id, text: n.textContent, href: n.querySelector('a').getAttribute('href'), preview: n.querySelector('img')?.getAttribute('src') })));

test('生成瀑布流页面，默认只展示精选并按有效默认总分及编号排序', async () => {
  const files = await import('node:fs/promises').then(fs => fs.readdir(outputDirectory));
  assert.ok(files.includes('thumbnails.html'), 'writeScoredGallery 应生成 thumbnails.html');
  await visit('thumbnails.html');
  const result = await cards();
  assert.deepEqual(result.map(x => x.id), ['tie', 'current', 'low']);
  assert.equal(result[1].preview, 'current-preview.jpg');
  assert.match(result[1].text, /70/);
  assert.equal(await page.locator('[data-scope="selected"]').getAttribute('aria-pressed'), 'true');
});

test('全部与隐藏分区完整，卡片只加载裁后预览并选择正确单图页', async () => {
  await visit('thumbnails.html', '?scope=all');
  assert.deepEqual((await cards()).map(x => x.id), ['hidden', 'tie', 'current', 'low']);
  const hidden = (await cards())[0];
  assert.equal(hidden.href, 'all-candidates.html?id=hidden&scope=all');
  assert.match(hidden.text, /隐藏理由/);
  assert.equal((await cards())[2].href, 'index.html?id=current&scope=all');
  await page.locator('[data-scope="hidden"]').click();
  assert.deepEqual((await cards()).map(x => x.id), ['hidden']);
  assert.equal((await cards())[0].href, 'all-candidates.html?id=hidden&scope=hidden');
  assert.equal(new URL(page.url()).searchParams.get('scope'), 'hidden');
});

test('实际557项的精选424与隐藏133准确，013等样本用各自默认裁后JPEG', async () => {
  await visit('thumbnails.html', '?scope=all', path.join(outputDirectory, 'real'));
  const result = await cards();
  assert.equal(result.length, 557);
  for (const [id, preview] of [['149656002', 'recrop_013/013_left_full_height_preview.jpg'], ['148779631', 'previews/027_148779631_7x4.jpg'], ['official_wallpaper_stage', 'recrop_043/043_stage_right_balanced_preview.jpg'], ['148900925', 'recrop_087/087_right_shoe_tight_top_preview.jpg'], ['148393517', 'previews/095_148393517_7x4.jpg']]) assert.equal(result.find(x => x.id === id).preview, preview);
  await page.locator('[data-scope="selected"]').click();
  assert.equal((await cards()).length, 424);
  await page.locator('[data-scope="hidden"]').click();
  assert.equal((await cards()).length, 133);
});

test('单图初次定位ID，默认预览与新分绑定，隐藏项返回原scope', async () => {
  await visit('index.html', '?id=current&scope=all');
  assert.equal(await page.locator('#title').textContent(), 'current');
  assert.equal(await page.locator('#photo').getAttribute('src'), 'current-preview.jpg');
  assert.match(await page.locator('#score').textContent(), /^70/);
  assert.equal(await page.locator('#thumbnails').getAttribute('href'), 'thumbnails.html?scope=all');
  await visit('all-candidates.html', '?id=hidden&scope=hidden');
  assert.equal(await page.locator('#title').textContent(), 'hidden');
  assert.equal(await page.locator('#thumbnails').getAttribute('href'), 'thumbnails.html?scope=hidden');
});

test('非法scope和不在单图列表的ID回到安全默认项', async () => {
  await visit('index.html', '?id=hidden&scope=https://evil.example/');
  assert.equal(await page.locator('#title').textContent(), 'tie');
  assert.equal(await page.locator('#thumbnails').getAttribute('href'), 'thumbnails.html?scope=selected');
  await visit('all-candidates.html', '?id=unknown&scope=__proto__');
  assert.equal(await page.locator('#title').textContent(), 'hidden');
  assert.equal(await page.locator('#thumbnails').getAttribute('href'), 'thumbnails.html?scope=all');
  await visit('thumbnails.html', '?scope=//evil.example/');
  assert.deepEqual((await cards()).map(x => x.id), ['tie', 'current', 'low']);
});

test('标题作者script注入作为原样文本显示，内联JSON可解析', async () => {
  for (const file of ['thumbnails.html', 'index.html', 'all-candidates.html']) {
    await visit(file, '?id=low');
    assert.equal(await page.evaluate(() => globalThis.injected), undefined);
    assert.equal(await page.locator('script').count(), file === 'thumbnails.html' ? 2 : 3);
    if (file === 'thumbnails.html') assert.ok((await cards()).find(x => x.id === 'low').text.includes(injection));
    else assert.equal(await page.locator('#title').textContent(), injection);
  }
});

test('保留版本、3视图、方向键、过滤与空状态', async () => {
  await visit('index.html', '?id=current');
  await page.locator('#version').selectOption('1');
  assert.equal(await page.locator('#photo').getAttribute('src'), 'historical-preview.jpg');
  assert.match(await page.locator('#score').textContent(), /^40/);
  await page.locator('[data-view="original"]').click();
  assert.equal(await page.locator('#photo').getAttribute('src'), sample.original);
  await page.locator('[data-view="frame"]').click();
  assert.equal(await page.locator('#photo').getAttribute('src'), sample.versions[1].frame);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#title').textContent(), injection);
  await page.locator('#official').check();
  assert.equal(await page.locator('#empty').isVisible(), true);
  assert.equal(await page.locator('#next').isDisabled(), true);
});

test('输入不修改、counts接口与历史评分crop绑定不变', async () => {
  const before = structuredClone(items);
  const counts = await writeScoredGallery({ items, outputDirectory });
  assert.deepEqual(counts, { total: 4, curated: 3 });
  assert.deepEqual(items, before);
  const scores = JSON.parse(await readFile(path.join(outputDirectory, 'crop-scores.json'), 'utf8'));
  const current = scores.find(x => x.id === 'current');
  assert.equal(current.score.total, 70);
  assert.deepEqual(current.crop, sample.versions[0].crop);
  assert.equal(current.versions[1].score.total, 40);
  assert.deepEqual(current.versions[1].crop, sample.versions[1].crop);
});

test('桌面缩到手机时重新排列为一列，没有水平溢出与卡片重叠', async () => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await visit('thumbnails.html', '?scope=all');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bounds = await page.locator('[data-id]').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
  assert.ok(bounds.every(r => r.right <= 390), '手机页面不应保留桌面的隐式列');
  assert.ok(bounds.every(r => r.left === bounds[0].left));
  assert.ok(bounds.slice(1).every((r, i) => r.top >= bounds[i].bottom));
});

test('宽屏固定三列，断点缩为两列及一列，卡片仍完整填满对应列', async () => {
  await visit('thumbnails.html', '?scope=all');
  for (const [width, expected] of [[1600, 3], [901, 3], [900, 2], [581, 2], [580, 1]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.locator('#gallery').evaluate(grid => {
      const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').map(Number.parseFloat);
      const card = grid.firstElementChild.getBoundingClientRect();
      return { tracks, cardWidth: card.width };
    });
    assert.equal(geometry.tracks.length, expected, width + ' px 的列数');
    assert.ok(Math.abs(geometry.cardWidth - geometry.tracks[0]) < 1);
  }
});
