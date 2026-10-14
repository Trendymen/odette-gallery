import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderThumbnailGallery } from './render-thumbnail-gallery.mjs';
import { createCustomSelectionClient } from './custom-selection-client.mjs';

const rubric = `奥黛塔 700×400 mm 鼠标垫候选：裁后评分规则（crop-v2）
按当前默认 7:4 裁剪评分，总分 100 分：
画面精致度 35 分；裁后构图 25 分；人脸与人体表现 20 分；主体偏右适配 10 分；裁剪像素条件 10 分。
主体偏右适配判断人物或脸在裁后画面中的位置，不要求左侧留白。
裁剪像素条件由评分记录按固定 PPI 档位给出，页面不重新计算分数。
文件像素不等同原生画质；放大、压缩和来源情况仍需结合图片与来源说明判断。
历史参考·旧标准（无 rubricVersion 或 legacy-v1）：画面完成度 30 分、7:4 裁剪适配 30 分、原生印刷像素 25 分、主体清晰度 15 分。
历史版本显示各自记录的旧分，不套用新权重。候选顺序始终按当前默认裁剪的总分降序，同分按稳定编号升序；切换历史版本不改变顺序。
`;

function galleryClient(createSelectionClient) {
  const all = JSON.parse(document.getElementById('data').textContent);
  const completeCatalog = JSON.parse(document.getElementById('completeCatalog').textContent);
  const client = createSelectionClient({ artworks: completeCatalog });
  const deletionClient = createSelectionClient({ artworks: completeCatalog, resource: 'deletion-marks' });
  let selection = client.getSnapshot();
  let deletion = deletionClient.getSnapshot();
  const permittedIds = () => { const markedAllowed = new Set(deletion.allowedIds); return selection.allowedIds.filter(id => markedAllowed.has(id)); };
  const el = id => document.getElementById(id);
  const selectedVersions = new Map();
  const params = new URLSearchParams(location.search);
  const serviceEnabled = ['http:', 'https:'].includes(location.protocol);
  let requestedId = completeCatalog.find(item => String(item.id) === params.get('id'))?.id;
  const defaultScope = el('thumbnails').dataset.scope;
  let scope = ['selected', 'all', 'hidden', 'custom'].includes(params.get('scope')) ? params.get('scope') : defaultScope;
  if (location.protocol === 'file:' && scope === 'custom') scope = defaultScope;
  el('thumbnails').href = 'thumbnails.html?' + new URLSearchParams({ scope });
  const kindNames = { artist_illustration: '画师插画', x_image: 'X 来源图片', official_illustration: '官方静态图', official_game_art: '官方游戏原画', official_video_frame: '官方 PV 原始帧', official_artwork_supplement: '官方作品的米游社补充文件（原生4K未核实）' };
  const newFields = [['画面精致度', 'quality', 35], ['裁后构图', 'cropScore', 25], ['人脸与人体表现', 'subjectScore', 20], ['主体偏右适配', 'rightScore', 10], ['裁剪像素条件', 'printScore', 10]];
  const oldFields = [['画面完成度', 'quality', 30], ['7:4 裁剪适配', 'cropScore', 30], ['原生印刷像素', 'printScore', 25], ['主体清晰度', 'subjectScore', 15]];
  const effective = (base, versionIndex = 0) => ({ ...base, ...base.versions?.[versionIndex] });
  const option = (value, label) => {
    const node = document.createElement('option');
    node.value = value; node.textContent = label;
    return node;
  };
  let list = [], index = 0, view = 'preview';
  let customIds = null, listInitialized = false;

  function refresh() {
    const previous = list[index]?.id ?? requestedId;
    const previousList = list;
    if (scope !== 'custom' || selection.ready) requestedId = undefined;
    const chosen = new Set(selection.selectedIds), allowed = new Set(permittedIds());
    if (scope === 'custom' && customIds === null && selection.ready) customIds = new Set(chosen);
    list = (scope === 'custom' ? completeCatalog : all).filter(base => {
      const x = effective(base);
      return allowed.has(String(base.id)) && (scope !== 'custom' || customIds?.has(String(base.id))) && (!el('right').checked || (x.rightFocus ?? x.score?.rightFocus)) && (!el('official').checked || x.official) && (x.crop?.width ?? 0) >= Number(el('pixels').value);
    });
    index = list.findIndex(x => x.id === previous);
    if (index < 0 && scope === 'custom') {
      const next = previousList.slice(previousList.findIndex(x => x.id === previous) + 1).find(x => list.some(item => item.id === x.id));
      index = next ? list.findIndex(x => x.id === next.id) : 0;
    }
    index = Math.max(0, index);
    el('pick').replaceChildren(...list.map((base, i) => {
      const x = effective(base);
      return option(i, String(base.number).padStart(3, '0') + ' · ' + x.title + ' · ' + (x.score?.total ?? '未评分') + ' 分');
    }));
    listInitialized = true;
    show();
  }

  function updateCurrentSelection() {
    const base = list[index];
    el('customCheck').checked = !!base && selection.selectedIds.includes(String(base.id));
    const disabled = !base || !serviceEnabled || !permittedIds().includes(String(base.id));
    el('customCheck').disabled = disabled;
    el('deletionCheck').checked = !!base && deletion.markedIds.includes(String(base.id));
    el('deletionCheck').disabled = disabled;
  }

  function show() {
    const base = list[index], variants = base?.versions ?? [];
    const versionIndex = selectedVersions.get(base?.id) ?? 0;
    el('versionControl').hidden = !variants.length;
    el('version').replaceChildren(...variants.map((v, i) => option(i, v.label)));
    el('version').value = versionIndex;
    const x = base ? effective(base, versionIndex) : null;
    updateCurrentSelection();
    el('thumbnails').href = 'thumbnails.html?' + new URLSearchParams(scope === 'custom' && base ? { scope, id: String(base.id) } : { scope });
    el('empty').hidden = !!x; el('photo').hidden = !x; el('details').hidden = !x;
    for (const id of ['pick', 'prev', 'next']) el(id).disabled = !x;
    if (!x) {
      el('photo').removeAttribute('src'); el('counter').textContent = '0 / 0';
      for (const id of ['title', 'author', 'kind', 'score', 'dimensions', 'note', 'reason', 'rightReason', 'alpha', 'hiddenReason']) el(id).textContent = '';
      el('scores').replaceChildren();
      for (const id of ['source', 'original', 'crop']) el(id).removeAttribute('href');
      return;
    }
    const score = x.score ?? {}, isNew = score.rubricVersion === 'crop-v2';
    el('pick').value = index; el('counter').textContent = (index + 1) + ' / ' + list.length;
    el('photo').src = x[view]; el('photo').alt = x.title;
    el('title').textContent = x.title; el('author').textContent = '作者 / 发布者：' + (x.user ?? '未注明');
    el('kind').textContent = kindNames[x.sourceKind] ?? '插画';
    el('score').textContent = (score.total ?? '未评分') + ' / 100 · ' + (isNew ? '裁后评分·新标准' : '历史参考·旧标准');
    el('score').classList.toggle('legacy', !isNew);
    el('scores').replaceChildren(...(isNew ? newFields : oldFields).map(([name, key, max]) => {
      const row = document.createElement('tr');
      for (const text of [name, (score[key] ?? '—') + ' / ' + max]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      return row;
    }));
    el('dimensions').textContent = '原图 ' + x.w + '×' + x.h + ' px；裁剪 ' + x.crop.width + '×' + x.crop.height + ' px。按 700 mm 宽打印：' + (x.ppiAt700mm ?? score.ppi ?? '未记录') + ' ppi。';
    el('reason').textContent = '评分理由：' + (score.reason ?? '未提供');
    el('rightReason').textContent = '偏右依据：' + (score.rightReason ?? (isNew ? '未提供' : '历史记录未单独评估偏右依据。'));
    el('note').textContent = x.note ?? '';
    el('hiddenReason').textContent = base.styleReview?.defaultVisible === false ? '默认隐藏：' + (base.styleReview.reason ?? '未注明原因') : '';
    el('alpha').textContent = x.hasAlpha ? '原始 PNG 含透明背景；预览以深蓝底显示，裁剪 PNG 保留透明。' : '';
    for (const [id, field] of [['source', 'source'], ['original', 'original'], ['crop', 'cropped']]) {
      if (x[field]) el(id).href = x[field]; else el(id).removeAttribute('href');
    }
    el('original').textContent = x.sourceKind === 'official_video_frame' ? '下载原始帧 PNG' : '下载原图';
  }

  function move(delta) { if (list.length) { index = (index + delta + list.length) % list.length; show(); } }
  el('customCheck').addEventListener('change', () => { if (list[index]) client.toggle(list[index].id, el('customCheck').checked); });
  el('deletionCheck').addEventListener('change', () => { if (list[index]) deletionClient.toggle(list[index].id, el('deletionCheck').checked); });
  el('customScope').addEventListener('change', () => {
    scope = el('customScope').checked ? 'custom' : defaultScope;
    if (scope === 'custom') { selectedVersions.clear(); customIds = new Set(selection.selectedIds); }
    history.replaceState(null, '', location.pathname + '?' + new URLSearchParams(list[index] ? { scope, id: list[index].id } : { scope }));
    refresh();
  });
  el('selectionRetry').onclick = () => { client.retry(); };
  client.subscribe(snapshot => {
    const allowedChanged = selection.allowedIds.length !== snapshot.allowedIds.length || selection.allowedIds.some(id => !snapshot.allowedIds.includes(id));
    selection = snapshot;
    el('selectionStatus').dataset.ready = String(snapshot.ready);
    el('selectionStatus').textContent = snapshot.error ?? (snapshot.pendingIds.length ? (snapshot.ready ? '保存中…' : '未确认 · 保存中…') : !snapshot.ready ? '正在读取定制候选…' : '已保存');
    el('selectionRetry').hidden = !snapshot.error || location.protocol === 'file:';
    el('customScope').disabled = !serviceEnabled; el('customScope').checked = scope === 'custom';
    el('customCount').textContent = snapshot.selectedIds.length + ' 幅' + (snapshot.ready ? '' : ' · 未确认');
    if (!listInitialized || allowedChanged || scope === 'custom' && customIds === null && snapshot.ready) refresh();
    else updateCurrentSelection();
  });
  el('deletionRetry').onclick = () => { deletionClient.retry(); };
  deletionClient.subscribe(snapshot => {
    const before = permittedIds(); deletion = snapshot; const after = permittedIds();
    const allowedChanged = before.length !== after.length || before.some(id => !after.includes(id));
    el('deletionStatus').dataset.ready = String(snapshot.ready);
    el('deletionStatus').textContent = snapshot.error ?? (snapshot.pendingIds.length ? (snapshot.ready ? '删除标记保存中…' : '删除标记未确认 · 保存中…') : !snapshot.ready ? '正在读取删除标记…' : '删除标记已保存');
    el('deletionRetry').hidden = !snapshot.error || !serviceEnabled;
    if (!listInitialized || allowedChanged) refresh(); else updateCurrentSelection();
  });
  document.querySelectorAll('a[href]').forEach(link => link.addEventListener('click', async event => {
    const url = new URL(link.href);
    if (location.protocol === 'file:' || url.origin !== location.origin || !/\/(?:index|all-candidates|thumbnails)\.html$/.test(url.pathname) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    try { await Promise.all([client.flush(), deletionClient.flush()]); location.href = url.href; }
    catch (error) { const prefix = error.resource === 'deletion-marks' ? 'deletion' : 'selection'; el(prefix + 'Status').textContent = error.message; el(prefix + 'Retry').hidden = false; }
  }));
  for (const id of ['right', 'official', 'pixels']) el(id).addEventListener('change', refresh);
  el('version').addEventListener('change', () => { if (list[index]) { selectedVersions.set(list[index].id, Number(el('version').value)); show(); } });
  el('pick').addEventListener('change', () => { index = Number(el('pick').value); show(); });
  el('prev').onclick = () => move(-1); el('next').onclick = () => move(1);
  document.addEventListener('keydown', event => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (event.key === 'ArrowLeft') move(-1); if (event.key === 'ArrowRight') move(1);
  });
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
    view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach(other => other.classList.toggle('active', other === button));
    show();
  });
  if (!listInitialized) refresh();
}

function renderPage(items, counts, complete, completeCatalog) {
  const data = JSON.stringify(items).replaceAll('<', '\\u003c');
  const catalogData = JSON.stringify(completeCatalog).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>奥黛塔 · 700×400 mm 鼠标垫候选</title>
<style>*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#0c1324;color:#e6edff;font:15px/1.5 system-ui,-apple-system,sans-serif}header{padding:18px 24px;background:#111d35;border-bottom:1px solid #283754}h1{margin:0;font-size:23px;font-weight:650}header p{margin:4px 0 0;color:#aebedf}.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:14px 24px;background:#152139}button,select,input{font:inherit;color:inherit;background:#223250;border:1px solid #456080;border-radius:7px;padding:8px 12px}button{cursor:pointer}button:hover,button.active{background:#425e91}button:disabled{opacity:.5;cursor:default}label{display:flex;align-items:center;gap:6px}#pick{max-width:520px;flex:1}main{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;padding:20px}figure{margin:0;display:flex;align-items:center;justify-content:center;background:#142343;min-height:400px;max-height:calc(100vh - 220px);overflow:auto;border-radius:10px}#photo{display:block;max-width:100%;max-height:calc(100vh - 220px);object-fit:contain}aside{padding:4px 6px}h2{font-size:20px;margin:0 0 6px;overflow-wrap:anywhere}.badge{display:inline-block;padding:5px 10px;background:#334f83;border-radius:6px;font-size:18px;font-weight:700;margin:10px 0}.legacy{background:#765128;color:#fff0cb}table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid #293b58}td:last-child{text-align:right}a{color:#9ac8ff;text-decoration:none}a:hover{text-decoration:underline}.links{display:flex;flex-direction:column;gap:9px;margin-top:20px}.muted{color:#aebedf}#hiddenReason{color:#ffd39a}#note,#reason,#rightReason{line-height:1.7}#empty{padding:60px;font-size:18px}@media(max-width:900px){main{grid-template-columns:1fr}figure,#photo{max-height:none}aside{padding:10px}#pick{max-width:100%;flex-basis:100%}}.choice-pair{display:flex;align-items:center;gap:20px;flex-wrap:nowrap}.deletion-control{color:#ff9caf;font-weight:650;white-space:nowrap;cursor:pointer}.deletion-check{appearance:none;position:relative;flex:0 0 40px;width:40px;height:24px;margin:0;padding:0;border:1px solid #d8546b;border-radius:999px;background:#321d2c;cursor:pointer}.deletion-check::before{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#ff9caf;transition:transform .12s ease}.deletion-check:checked{background:#d72d4d;border-color:#ff6b87}.deletion-check:checked::before{background:#fff2f5;transform:translateX(16px)}.deletion-check:focus-visible{outline:3px solid #ff879f;outline-offset:3px}.deletion-check:disabled{opacity:.5;cursor:default}@media(prefers-reduced-motion:reduce){.deletion-check::before{transition:none}}</style>
<header><h1>奥黛塔 · 700×400 mm 鼠标垫候选</h1><p>${counts.curated} 幅精选 · ${counts.total - counts.curated} 幅默认隐藏 · 按当前默认裁剪评分排序</p></header>
<div class="controls"><a id="thumbnails" data-scope="${complete ? 'all' : 'selected'}" href="thumbnails.html?scope=${complete ? 'all' : 'selected'}">瀑布流画廊</a><a href="${complete ? 'index.html' : 'all-candidates.html'}">${complete ? '返回精选候选（' + counts.curated : '显示全部候选（' + counts.total}）</a><label><input type="checkbox" id="right">只看偏右</label><label><input type="checkbox" id="official">只看官方</label><label>当前裁剪宽度<select id="pixels"><option value="1000">≥1000 px</option><option value="2000">≥2000 px</option><option value="4000">≥4000 px</option></select></label><button id="prev">上一张</button><select id="pick" aria-label="选择图片"></select><button id="next">下一张</button><span id="counter"></span></div>
<div class="controls"><button data-view="preview" class="active">7:4 裁剪图</button><button data-view="original">原图 / 原始帧</button><button data-view="frame">原图上的裁剪框</button><label id="versionControl" hidden>图片版本<select id="version" aria-label="图片版本"></select></label><span class="muted">可用键盘 ← → 切换；PNG 按文件像素裁剪</span></div>
<div class="controls"><div class="choice-pair"><label><input id="customCheck" type="checkbox" disabled>加入定制候选</label><label class="deletion-control"><input id="deletionCheck" class="deletion-check" type="checkbox" role="switch" disabled>标记删除</label></div><label><input id="customScope" type="checkbox" disabled>定制候选 <span id="customCount">尚未读取</span></label><span id="selectionStatus" role="status" aria-live="polite">正在读取定制候选…</span><button id="selectionRetry" hidden>重试</button><span id="deletionStatus" role="status" aria-live="polite">正在读取删除标记…</span><button id="deletionRetry" hidden>重试删除标记</button></div>
<main><figure><img id="photo" alt="当前候选图片"><div id="empty" hidden>当前筛选条件下没有图片。</div></figure><aside id="details"><h2 id="title"></h2><div id="author" class="muted"></div><div id="kind" class="muted"></div><div id="score" class="badge"></div><table id="scores"></table><p id="dimensions"></p><p id="reason"></p><p id="rightReason"></p><p id="note"></p><p id="hiddenReason"></p><p id="alpha" class="muted"></p><div class="links"><a id="source" target="_blank" rel="noopener noreferrer">查看发布来源</a><a id="original" download>下载原图</a><a id="crop" download>下载 7:4 PNG</a><a href="scores.csv">旧版筛选评分表 CSV</a><a href="crop-scores.json">裁后评分记录 JSON</a><a href="scoring-rubric.txt">裁后评分规则</a><a href="README.txt">筛选与像素说明</a></div></aside></main>

<script id="data" type="application/json">${data}</script><script id="completeCatalog" type="application/json">${catalogData}</script><script>(${galleryClient.toString()})(${createCustomSelectionClient.toString()});</script></html>`;
}

export async function writeScoredGallery({ items, outputDirectory }) {
  const defaultTotal = base => ({ ...base, ...base.versions?.[0] }).score?.total ?? -1;
  const sorted = [...items].sort((a, b) => defaultTotal(b) - defaultTotal(a) || Number(a.number) - Number(b.number));
  const curated = sorted.filter(item => item.styleReview?.defaultVisible !== false);
  const counts = { total: sorted.length, curated: curated.length };
  const records = sorted.map(item => {
    const current = { ...item, ...item.versions?.[0] };
    const versions = item.versions?.map(variant => {
      const version = { ...item, ...variant };
      return { label: variant.label, score: version.score, scoreInherited: variant.scoreInherited, crop: version.crop };
    });
    return { number: item.number, id: item.id, score: current.score, crop: current.crop, versions };
  });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'index.html'), renderPage(curated, counts, false, sorted));
  await writeFile(path.join(outputDirectory, 'all-candidates.html'), renderPage(sorted, counts, true, sorted));
  await writeFile(path.join(outputDirectory, 'thumbnails.html'), renderThumbnailGallery(sorted, counts));
  await writeFile(path.join(outputDirectory, 'crop-scores.json'), JSON.stringify(records, null, 2) + '\n');
  await writeFile(path.join(outputDirectory, 'scoring-rubric.txt'), rubric);
  return counts;
}
