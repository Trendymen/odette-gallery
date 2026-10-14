import { createCustomSelectionClient } from './custom-selection-client.mjs';

function thumbnailClient(createSelectionClient) {
  const items = JSON.parse(document.getElementById('data').textContent);
  const client = createSelectionClient({ artworks: items });
  const deletionClient = createSelectionClient({ artworks: items, resource: 'deletion-marks' });
  let selection = client.getSnapshot();
  let deletion = deletionClient.getSnapshot();
  const grid = document.getElementById('gallery');
  const buttons = [...document.querySelectorAll('[data-scope]')];
  const params = new URLSearchParams(location.search);
  const serviceEnabled = ['http:', 'https:'].includes(location.protocol);
  let scope = ['selected', 'all', 'hidden', 'custom'].includes(params.get('scope')) ? params.get('scope') : 'selected';
  if (location.protocol === 'file:' && scope === 'custom') scope = 'selected';
  let currentId = params.get('id');
  let scrollPending = !!currentId;
  let renderedIds = [], renderedScope;
  let customIds = null;
  let scheduled = false;

  function layout() {
    for (const card of grid.children) { card.style.gridColumn = ''; card.style.gridRow = ''; }
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const heights = Array(columns).fill(0);
    for (const card of grid.children) {
      const column = heights.indexOf(Math.min(...heights));
      const height = Math.ceil(card.firstElementChild.getBoundingClientRect().height);
      card.style.gridColumn = column + 1;
      card.style.gridRow = (heights[column] + 1) + ' / span ' + height;
      heights[column] += height + 16;
    }
    scheduled = false;
    if (scrollPending && (scope !== 'custom' || selection.ready)) {
      const target = [...grid.children].find(card => card.dataset.id === currentId);
      target?.scrollIntoView({ block: 'center' });
      scrollPending = false;
    }
  }

  function scheduleLayout() {
    if (!scheduled) { scheduled = true; requestAnimationFrame(layout); }
  }

  const observer = new ResizeObserver(scheduleLayout);
  observer.observe(grid);

  function render() {
    const chosen = new Set(selection.selectedIds), marked = new Set(deletion.markedIds);
    const deletionAllowed = new Set(deletion.allowedIds), allowed = new Set(selection.allowedIds.filter(id => deletionAllowed.has(id)));
    if (scope === 'custom' && customIds === null && selection.ready) customIds = new Set(chosen);
    const shown = items.filter(item => allowed.has(String(item.id)) && (scope === 'custom' ? customIds?.has(String(item.id)) : scope === 'all' || (scope === 'hidden' ? item.hidden : !item.hidden)));
    const shownIds = shown.map(item => String(item.id));
    const active = grid.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = active?.closest('.card')?.dataset.id, focusedIndex = renderedIds.indexOf(focusedId);
    const rebuild = renderedScope !== scope || shownIds.length !== renderedIds.length || shownIds.some((id, i) => id !== renderedIds[i]);
    if (rebuild) {
      observer.disconnect(); observer.observe(grid);
      grid.replaceChildren(...shown.map(item => {
          const card = document.createElement('article');
          card.className = 'card'; card.dataset.id = item.id;
          const link = document.createElement('a');
          link.href = (scope === 'custom' ? 'index.html' : item.hidden ? 'all-candidates.html' : 'index.html') + '?' + new URLSearchParams({ id: item.id, scope });
          const content = document.createElement('div'); content.className = 'card-content';
          const image = document.createElement('img');
          image.src = item.preview; image.alt = item.title; image.loading = 'lazy'; image.decoding = 'async';
          image.width = 700; image.height = 400;
          const meta = document.createElement('div'); meta.className = 'meta';
          for (const [tag, className, text] of [
            ['div', 'number-score', String(item.number).padStart(3, '0') + ' · ' + (item.total ?? '未评分') + ' 分'],
            ['h2', '', item.title], ['div', 'muted', '作者 / 发布者：' + (item.user ?? '未注明')],
            ...(item.hidden ? [['div', 'hidden-badge', '已隐藏'], ['p', 'hidden-reason', item.hiddenReason ?? '未注明原因']] : [])
          ]) {
            const node = document.createElement(tag); node.className = className; node.textContent = text; meta.append(node);
          }
          const label = document.createElement('label'); label.className = 'custom-control';
          const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'custom-check';
          check.checked = chosen.has(String(item.id)); check.disabled = !serviceEnabled || !allowed.has(String(item.id));
          check.addEventListener('change', () => client.toggle(item.id, check.checked));
          label.append(check, '加入定制候选');
          const deletionLabel = document.createElement('label'); deletionLabel.className = 'custom-control deletion-control';
          const deletionCheck = document.createElement('input'); deletionCheck.type = 'checkbox'; deletionCheck.className = 'deletion-check';
          deletionCheck.setAttribute('role', 'switch');
          deletionCheck.checked = marked.has(String(item.id)); deletionCheck.disabled = !serviceEnabled || !allowed.has(String(item.id));
          deletionCheck.addEventListener('change', () => deletionClient.toggle(item.id, deletionCheck.checked));
          deletionLabel.append(deletionCheck, '标记删除');
          const controls = document.createElement('div'); controls.className = 'card-controls'; controls.append(label, deletionLabel);
          link.append(image, meta); content.append(link, controls); card.append(content); observer.observe(content);
          return card;
      }));
      if (active) {
        const nextId = shownIds.includes(focusedId) ? focusedId : renderedIds.slice(focusedIndex + 1).find(id => shownIds.includes(id)) ?? shownIds[0];
        const nextCard = [...grid.children].find(card => card.dataset.id === nextId);
        if (nextCard) nextCard.querySelector(active.tagName === 'INPUT' ? (active.classList.contains('deletion-check') ? '.deletion-check' : '.custom-check') : 'a').focus({ preventScroll: true });
        else document.querySelector('[data-scope="' + scope + '"]').focus({ preventScroll: true });
      }
      renderedIds = shownIds; renderedScope = scope;
    } else {
      for (const card of grid.children) {
        const check = card.querySelector('.custom-check');
        check.checked = chosen.has(card.dataset.id);
        check.disabled = !serviceEnabled || !allowed.has(card.dataset.id);
        const deletionCheck = card.querySelector('.deletion-check');
        deletionCheck.checked = marked.has(card.dataset.id);
        deletionCheck.disabled = !serviceEnabled || !allowed.has(card.dataset.id);
      }
    }
    for (const button of buttons) {
      const active = button.dataset.scope === scope;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    }
    document.getElementById('count').textContent = shown.length + ' 幅 · 按当前默认裁剪总分排序';
    document.getElementById('empty').hidden = !!shown.length;
    const single = document.getElementById('singleView');
    const target = shown.find(item => String(item.id) === currentId) ?? shown[0];
    if (scope !== 'custom' || selection.ready) currentId = target ? String(target.id) : null;
    single.href = 'index.html?' + new URLSearchParams(scope === 'custom' && target ? { scope, id: target.id } : { scope });
    if (rebuild) scheduleLayout();
  }

  for (const button of buttons) button.addEventListener('click', () => {
    scope = button.dataset.scope;
    if (scope === 'custom') customIds = new Set(selection.selectedIds);
    render();
    history.replaceState(null, '', 'thumbnails.html?' + new URLSearchParams(scope === 'custom' && currentId ? { scope, id: currentId } : { scope }));
  });
  grid.addEventListener('click', navigate);
  document.getElementById('singleView').addEventListener('click', navigate);
  async function navigate(event) {
    const link = event.target.closest('a');
    if (!link || location.protocol === 'file:' || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    try { await Promise.all([client.flush(), deletionClient.flush()]); location.href = link.href; }
    catch (error) { const prefix = error.resource === 'deletion-marks' ? 'deletion' : 'selection'; document.getElementById(prefix + 'Status').textContent = error.message; document.getElementById(prefix + 'Retry').hidden = false; }
  }
  document.getElementById('selectionRetry').onclick = () => { client.retry(); };
  client.subscribe(snapshot => {
    selection = snapshot;
    document.getElementById('selectionStatus').dataset.ready = String(snapshot.ready);
    document.getElementById('selectionStatus').textContent = snapshot.error ?? (snapshot.pendingIds.length ? (snapshot.ready ? '保存中…' : '未确认 · 保存中…') : !snapshot.ready ? '正在读取定制候选…' : '已保存');
    document.getElementById('selectionRetry').hidden = !snapshot.error || location.protocol === 'file:';
    const custom = document.querySelector('[data-scope="custom"]'); custom.disabled = !serviceEnabled;
    custom.textContent = '定制候选（' + snapshot.selectedIds.length + (snapshot.ready ? '' : ' · 未确认') + '）';
    render();
  });
  document.getElementById('deletionRetry').onclick = () => { deletionClient.retry(); };
  deletionClient.subscribe(snapshot => {
    deletion = snapshot;
    document.getElementById('deletionStatus').dataset.ready = String(snapshot.ready);
    document.getElementById('deletionStatus').textContent = snapshot.error ?? (snapshot.pendingIds.length ? (snapshot.ready ? '删除标记保存中…' : '删除标记未确认 · 保存中…') : !snapshot.ready ? '正在读取删除标记…' : '删除标记已保存');
    document.getElementById('deletionRetry').hidden = !snapshot.error || !serviceEnabled;
    render();
  });
  render();
}

export function renderThumbnailGallery(items, counts) {
  const cards = items.map(base => {
    const current = { ...base, ...base.versions?.[0] };
    return { id: base.id, number: base.number, title: current.title, user: current.user, preview: current.preview, total: current.score?.total, hidden: base.styleReview?.defaultVisible === false, hiddenReason: base.styleReview?.reason };
  });
  const data = JSON.stringify(cards).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>奥黛塔 · 瀑布流画廊</title>
<style>*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#0c1324;color:#e6edff;font:15px/1.5 system-ui,-apple-system,sans-serif}header{padding:18px 24px;background:#111d35;border-bottom:1px solid #283754}h1{margin:0;font-size:23px;font-weight:650}header p{margin:4px 0 0;color:#aebedf}.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:14px 24px;background:#152139}button{font:inherit;color:inherit;background:#223250;border:1px solid #456080;border-radius:7px;padding:8px 12px;cursor:pointer}button:hover,button.active{background:#425e91}a{color:#9ac8ff;text-decoration:none}a:hover{text-decoration:underline}main{padding:20px}#gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:1px;column-gap:16px;align-items:start}.card{display:block;min-width:0;color:inherit;border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px #293b58;background:#142343}.card:hover{box-shadow:0 0 0 2px #9ac8ff;text-decoration:none}.card a:focus-visible{outline:3px solid #9ac8ff;outline-offset:-3px}button:focus-visible,.custom-check:focus-visible,.deletion-check:focus-visible{outline:3px solid #9ac8ff;outline-offset:4px}.card img{display:block;width:100%;height:auto;aspect-ratio:7/4;object-fit:contain;background:#142343}.card-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-top:1px solid #293b58}.custom-control{display:flex;align-items:center;gap:7px;font-size:14px;white-space:nowrap;cursor:pointer}.card-controls .deletion-control{margin-left:auto}.deletion-control{color:#ff9caf;font-weight:650;white-space:nowrap;cursor:pointer}.deletion-check{appearance:none;position:relative;flex:0 0 40px;width:40px;height:24px;margin:0;padding:0;border:1px solid #d8546b;border-radius:999px;background:#321d2c;cursor:pointer}.deletion-check::before{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#ff9caf;transition:transform .12s ease}.deletion-check:checked{background:#d72d4d;border-color:#ff6b87}.deletion-check:checked::before{background:#fff2f5;transform:translateX(16px)}.deletion-check:focus-visible{outline:3px solid #ff879f;outline-offset:3px}.deletion-check:disabled{opacity:.5;cursor:default}@media(prefers-reduced-motion:reduce){.deletion-check::before{transition:none}}.card a{display:block;color:inherit}button:disabled{opacity:.5;cursor:default}.meta{padding:12px 14px}h2{font-size:17px;margin:5px 0 7px;overflow-wrap:anywhere}.muted{color:#aebedf;overflow-wrap:anywhere}.number-score{color:#bcd7ff;font-weight:650}.hidden-badge{display:inline-block;margin-top:9px;padding:2px 7px;border-radius:5px;background:#765128;color:#fff0cb}.hidden-reason{margin:7px 0 0;color:#ffd39a;overflow-wrap:anywhere}#empty{padding:60px;text-align:center}@media(max-width:900px){#gallery{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:580px){header,.controls{padding-left:16px;padding-right:16px}main{padding:16px}#gallery{grid-template-columns:1fr}}</style>
<header><h1>奥黛塔 · 瀑布流画廊</h1><p>700×400 mm 鼠标垫候选 · 完整显示当前默认 7:4 裁剪</p></header>
<nav class="controls" aria-label="候选范围"><button data-scope="selected" aria-pressed="true">精选（${counts.curated}）</button><button data-scope="all" aria-pressed="false">全部（${counts.total}）</button><button data-scope="hidden" aria-pressed="false">已隐藏（${counts.total - counts.curated}）</button><button data-scope="custom" disabled>定制候选（尚未读取）</button><a id="singleView" href="index.html">单图查看</a><span id="selectionStatus" role="status" aria-live="polite">正在读取定制候选…</span><button id="selectionRetry" hidden>重试</button><span id="count" aria-live="polite"></span><span id="deletionStatus" role="status" aria-live="polite">正在读取删除标记…</span><button id="deletionRetry" hidden>重试删除标记</button></nav>
<main><div id="gallery" aria-label="候选图片"></div><p id="empty" hidden>当前范围没有图片。</p></main>
<script id="data" type="application/json">${data}</script><script>(${thumbnailClient.toString()})(${createCustomSelectionClient.toString()});</script></html>`;
}
