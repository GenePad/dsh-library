// Standalone HTML dialogs for the word-processor integration.
//
// These pages are the web equivalent of Zotero's
// chrome/content/zotero/integration/*: the citation dialog (bubble input,
// keyword search vs collection browsing, locator parsing, per-item editor,
// live preview, keyboard navigation), document preferences, the bibliography editor, the document
// citations explorer, the item picker and the progress window.
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>文库引用</title>
<style>
:root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --border:#dfe3e8; --border-soft:#edf0f3;
  --text:#1f2328; --text2:#57606a; --text3:#8c959f; --accent:#2f6feb; --accent-soft:#e8f0ff;
  --hover:#f0f4fa; --danger:#cf222e; --radius:8px; }
* { box-sizing:border-box; }
html, body { margin:0; height:100%; }
body { font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
  color:var(--text); background:var(--bg); display:flex; flex-direction:column; }
button, input, select, textarea { font:inherit; color:inherit; }
button { cursor:pointer; }
.hidden { display:none !important; }
#app { display:flex; flex-direction:column; height:100%; min-height:0; }
header { padding:12px 18px; background:var(--panel); border-bottom:1px solid var(--border);
  display:flex; align-items:center; gap:12px; flex:none; }
header .logo { width:22px; height:22px; border-radius:6px; background:var(--accent); color:#fff;
  display:grid; place-items:center; font-weight:700; font-size:13px; }
header h1 { font-size:14px; margin:0; font-weight:600; flex:1; }
header .hint { font-size:11.5px; color:var(--text3); }
main { flex:1; min-height:0; display:flex; flex-direction:column; padding:14px 18px; gap:12px; overflow:auto; }
footer { flex:none; padding:11px 18px; background:var(--panel); border-top:1px solid var(--border);
  display:flex; align-items:center; justify-content:flex-end; gap:8px; }
.btn { border:1px solid var(--border); background:var(--panel); border-radius:6px; padding:6px 14px;
  min-height:30px; }
.btn:hover { background:var(--hover); }
.btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.btn.primary:hover { filter:brightness(.95); }
.btn:disabled { opacity:.5; cursor:not-allowed; }
.btn.small { padding:3px 9px; min-height:24px; font-size:12px; }
.input, select { border:1px solid var(--border); background:var(--panel); border-radius:6px;
  padding:6px 9px; min-height:32px; outline:none; }
.input:focus, select:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }
.row { display:flex; gap:8px; align-items:center; }
.grow { flex:1; min-width:0; }
.label { font-size:12px; color:var(--text2); font-weight:600; }
.hint { font-size:11.5px; color:var(--text3); }
.panel { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); }
.spinner { width:13px; height:13px; border:2px solid var(--border); border-top-color:var(--accent);
  border-radius:50%; animation:spin .7s linear infinite; display:inline-block; }
@keyframes spin { to { transform:rotate(360deg); } }

/* ---- citation dialog ---- */
#bubbleBox { display:flex; flex-wrap:wrap; gap:6px; align-items:center; min-height:44px;
  padding:7px 9px; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); }
#bubbleBox:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }
.bubble { display:inline-flex; align-items:center; gap:5px; max-width:340px; padding:3px 7px 3px 9px;
  border-radius:14px; background:var(--accent-soft); border:1px solid #cfe0ff; color:#174ea6;
  font-size:12px; cursor:pointer; user-select:none; }
.bubble.selected { outline:2px solid var(--accent); }
.bubble .txt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bubble .x { font-size:14px; line-height:1; opacity:.6; }
.bubble .x:hover { opacity:1; }
#searchInput { flex:1; min-width:170px; border:0; outline:none; padding:4px 2px; background:transparent; }
#searchInput::placeholder { color:var(--text3); }
#browser { display:flex; gap:10px; flex:1; min-height:0; }
#results { flex:1; min-height:160px; overflow:auto; padding:6px; }
#collections { width:186px; flex:none; overflow:auto; padding:5px; }
#collections .tree-head { font-size:11px; font-weight:700; color:var(--text3); padding:5px 7px; }
.collection { display:flex; align-items:center; gap:6px; padding:5px 7px; border-radius:6px;
  cursor:pointer; font-size:12px; }
.collection:hover { background:var(--hover); }
.collection.selected { background:var(--accent-soft); color:#174ea6; font-weight:600; }
.collection .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.collection .count { color:var(--text3); font-size:11px; }
.group-title { font-size:11px; font-weight:700; color:var(--text3); padding:8px 8px 4px;
  letter-spacing:.03em; display:flex; align-items:center; gap:6px; }
.result { display:flex; gap:9px; align-items:baseline; padding:6px 9px; border-radius:6px;
  cursor:pointer; border:1px solid transparent; }
.result:hover { background:var(--hover); }
.result.current { background:var(--accent-soft); border-color:#cfe0ff; }
.result.selected { background:#e3ecff; }
.result .title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.result .meta { color:var(--text3); font-size:11.5px; white-space:nowrap; }
.result .badge { font-size:10.5px; color:var(--accent); border:1px solid #cfe0ff; border-radius:9px; padding:0 6px; white-space:nowrap; }
/* Items already selected for this citation are tinted green. "已选中" is a
   different state from the transient Ctrl/Shift selection (.result.selected)
   and from writing an item into the library/document. */
.result.chosen { background:#eaf7ee; border-color:#b7e4c7; }
.result.chosen.current { background:#dcefe4; outline:1px solid var(--accent); }
.result.chosen .title { color:#18794e; }
.result .badge.chosen { color:#18794e; border-color:#b7e4c7; background:#f2fbf5; }
.result .badge.cited { color:var(--accent); border-color:#cfe0ff; }
.empty { padding:22px; text-align:center; color:var(--text3); }
#preview { padding:9px 12px; min-height:38px; border:1px dashed var(--border); border-radius:6px;
  background:#fbfcfe; color:var(--text2); }
#preview .err { color:var(--danger); }
#details { position:fixed; inset:0; background:rgba(15,20,30,.28); display:grid; place-items:center; z-index:20; }
#detailsCard { width:min(430px,92vw); background:var(--panel); border-radius:12px; padding:18px;
  box-shadow:0 16px 50px rgba(0,0,0,.18); display:flex; flex-direction:column; gap:11px; }
#detailsCard h2 { margin:0 0 2px; font-size:14px; }
#detailsCard .grid { display:grid; grid-template-columns:78px 1fr; gap:8px; align-items:center; }
#detailsCard label { font-size:12px; color:var(--text2); }
.check { display:inline-flex; gap:6px; align-items:center; font-size:12px; color:var(--text2); }
.toolbar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.segmented { display:inline-flex; border:1px solid var(--border); border-radius:6px; overflow:hidden; }
.segmented button { border:0; background:var(--panel); padding:4px 10px; font-size:12px; }
.segmented button.active { background:var(--accent); color:#fff; }
progress { width:100%; height:6px; }

/* ---- bibliography / explorer ---- */
.split { display:flex; gap:12px; min-height:0; flex:1; }
.col { display:flex; flex-direction:column; gap:8px; min-height:0; }
.list { overflow:auto; flex:1; min-height:140px; padding:5px; }
.list-item { padding:7px 9px; border-radius:6px; cursor:pointer; border:1px solid transparent; }
.list-item:hover { background:var(--hover); }
.list-item.selected { background:var(--accent-soft); border-color:#cfe0ff; }
.list-item .meta { font-size:11.5px; color:var(--text3); }
.editor { min-height:100px; padding:10px; border:1px solid var(--border); border-radius:6px;
  background:var(--panel); outline:none; overflow:auto; }
.editor:empty:before { content:'在此编辑该条参考文献…'; color:var(--text3); }
.editor button.active { background:var(--accent-soft); }
.section { padding:12px; display:flex; flex-direction:column; gap:10px; }
.field-row { display:grid; grid-template-columns:150px 1fr; gap:10px; align-items:center; }
.style-row { padding:6px 9px; border-radius:6px; cursor:pointer; }
.style-row:hover { background:var(--hover); }
.style-row.selected { background:var(--accent-soft); }
.toast { position:fixed; bottom:62px; left:50%; transform:translateX(-50%); background:#24292f;
  color:#fff; padding:7px 14px; border-radius:6px; font-size:12px; z-index:50; }

/* Compact layout for the standalone chromeless window (Zotero-like dialog) */
body.compact header { padding:9px 14px; }
body.compact header .logo { width:19px; height:19px; font-size:11px; }
body.compact header h1 { font-size:13px; }
body.compact header .hint { display:none; }
body.compact main { padding:10px 14px; gap:9px; }
body.compact footer { padding:8px 14px; }
body.compact #bubbleBox { min-height:38px; padding:5px 8px; }
body.compact #results { min-height:120px; }
body.compact #collections { width:158px; }
body.compact .result { padding:5px 8px; }
body.compact .group-title { padding:6px 8px 3px; }
body.compact #preview { padding:7px 10px; min-height:32px; }
body.compact .section { padding:10px; }
body.compact .list { min-height:110px; }
body.compact .editor { min-height:84px; }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="logo">文</div>
    <h1 id="title">文库引用</h1>
    <span class="hint" id="headerHint"></span>
  </header>
  <main id="main"></main>
  <footer id="footer"></footer>
</div>
<div id="toast" class="toast hidden"></div>
<script>
(function () {
  'use strict';
  var ID = decodeURIComponent(location.pathname.split('/').pop() || '');
  // A standalone --app window has no tab strip or address bar; tighten spacing
  // and give it a short, unique title so the host can close exactly this window.
  if (/[?&]compact=1/.test(location.search)) document.body.classList.add('compact');
  var finished = false;
  window.addEventListener('pagehide', function () {
    if (finished || !ID) return;
    // User hit the X instead of OK/Cancel: cancel the pending Word transaction
    // instead of leaving it hanging until the 20-minute timeout.
    try {
      navigator.sendBeacon('/office/api/result?id=' + encodeURIComponent(ID),
        new Blob([JSON.stringify({ cancel: true })], { type: 'application/json' }));
    } catch (e) {}
  });
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };
  var api = function (path, options) {
    return fetch('/office/api/' + path + (path.indexOf('?') === -1 ? '?id=' + encodeURIComponent(ID) : '&id=' + encodeURIComponent(ID)), options)
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; }); });
  };
  var post = function (path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  };
  var toastTimer = null;
  function toast(text) {
    var node = $('#toast'); node.textContent = text; node.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { node.classList.add('hidden'); }, 2600);
  }
  function submit(value) {
    finished = true;
    post('result', { value: value }).then(function () {
      try { window.close(); } catch (e) {}
      setTimeout(function () {
        document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#57606a">已完成，窗口即将关闭。</div>';
      }, 120);
    }).catch(function (e) { finished = false; toast('提交失败：' + e.message); });
  }
  function cancel() {
    finished = true;
    post('result', { cancel: true }).then(function () {
      try { window.close(); } catch (e) {}
      setTimeout(function () {
        document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#57606a">已取消，窗口即将关闭。</div>';
      }, 120);
    }).catch(function (e) { finished = false; toast('取消失败：' + e.message); });
  }
  function footer(buttons, left) {
    var f = $('#footer'); f.innerHTML = '';
    if (left) { var span = document.createElement('span'); span.className = 'hint grow'; span.innerHTML = left; f.appendChild(span); }
    (buttons || []).forEach(function (b) {
      var el = document.createElement('button');
      el.className = 'btn' + (b.primary ? ' primary' : '') + (b.small ? ' small' : '');
      el.textContent = b.label; el.disabled = !!b.disabled; el.onclick = b.onClick;
      if (b.id) el.id = b.id;
      f.appendChild(el);
    });
  }
  function rid() { return Math.random().toString(36).slice(2, 7); }

  /* ------------------------------------------------------------ state --- */
  var S = {
    type: 'citation', io: {}, title: '文库引用',
    items: [], groups: [], flat: [], selected: new Set(), current: -1,
    keepSorted: true, showPreview: true, layout: 'library', dialogType: 'citation',
    collections: [], collectionsLoaded: false, collection: 'all', unfiledCount: 0, emptyHint: '',
    searching: false, searchValue: '', searchTimer: null, previewTimer: null,
    justAdded: null, lastLocator: null, acceptSuppressUntil: 0,
    detailsIndex: -1, detailsSnapshot: null, discardDetails: false,
    customText: {}, uncited: [], omitted: [], activeEntry: -1,
    styleRows: [], selectedStyle: '', selectedLocale: '',
    explorerCitations: [], explorerItems: [], activeCitation: -1, activeItem: -1,
    styleInstallBusy: false
  };

  var LOCATORS = [
    ['page', ['p.', 'p', '页', 'page']], ['book', ['bk.', 'bk', 'book']],
    ['chapter', ['chap.', 'chap', '章', 'chapter']], ['column', ['col.', 'col', 'column']],
    ['figure', ['fig.', 'fig', 'figure']], ['folio', ['fol.', 'fol', 'folio']],
    ['issue', ['no.', 'no', 'issue']], ['line', ['l.', 'l', 'line']],
    ['note', ['n.', 'n', 'note']], ['opus', ['op.', 'op', 'opus']],
    ['paragraph', ['para.', 'para', '段', 'paragraph']], ['part', ['pt.', 'pt', 'part']],
    ['section', ['sec.', 'sec', '节', 'section']], ['sub verbo', ['s.v.', 's.v', 'sub verbo']],
    ['volume', ['vol.', 'vol', '卷', 'volume']], ['verse', ['v.', 'v', 'verse']]
  ];
  var NUMERIC = /^[\\d\\s,:-]*\\d[\\d\\s,:-]*$/;

  function cleanQuery(str) {
    var value = String(str || '').trim();
    if (/^(10\\.\\d{4,9}\\/|97[89][-\\d]{8,})/.test(value)) return value;
    value = value.replace(/[()&,.;]/g, ' ').replace(/\\s+(and|et al)\\s+/gi, ' ').replace(/\\s+/g, ' ').trim();
    value = value.replace(/:$/, '').trim();
    return value;
  }

  function extractLocator(str) {
    var value = String(str || '').trim();
    if (!value) return null;
    var colon = /^(.*):\\s*(\\d+(?:[\\s,-]*\\d*)*)\\s*$/.exec(value);
    if (colon) {
      return { label: 'page', locator: colon[2], onlyLocator: colon[1].trim() === '',
        fullLocatorString: colon[0].trim() };
    }
    var words = value.split(/\\s+/);
    for (var i = 0; i < words.length; i++) {
      var tail = words.slice(i).join(' ');
      for (var j = 0; j < LOCATORS.length; j++) {
        var key = LOCATORS[j][0], forms = LOCATORS[j][1];
        for (var k = 0; k < forms.length; k++) {
          if (tail.toLowerCase().indexOf(forms[k].toLowerCase()) !== 0) continue;
          var rest = tail.slice(forms[k].length).trim();
          if (!/^(\\d+(?:[\\s,-:]+\\d+)*)$/.test(rest) && !/^((?:"[^"]+"|'[^']+'))$/.test(rest)) continue;
          var full = tail;
          if (value.slice(-full.length) !== full) continue;
          return { label: key, locator: rest.replace(/^["']|["']$/g, ''), onlyLocator: full.length === value.length,
            fullLocatorString: full };
        }
      }
    }
    return null;
  }

  function bubbleString(item) {
    var main = item.creator || (item.title ? '"' + item.title + '"' : '（无标题）');
    if (item.year) main += ', ' + item.year;
    var locator = item.locator ? (item.label === 'page' ? '' : (item.label || '页') + ' ') + item.locator : '';
    if (locator) main += ', ' + locator;
    if (item.prefix) main += ', ' + item.prefix.slice(0, 10) + (item.prefix.length > 10 ? '…' : '') + ' ';
    if (item.suffix) main += ', ' + item.suffix.slice(0, 10) + (item.suffix.length > 10 ? '…' : '');
    if (item['suppress-author']) main += '（省略作者）';
    return main;
  }

  function citationItem(item, final) {
    var out = { id: item.id, itemData: item.itemData || null, uris: item.uris || [] };
    ['locator', 'label', 'prefix', 'suffix', 'suppress-author', 'author-only'].forEach(function (key) {
      if (item[key] !== undefined && item[key] !== '' && item[key] !== false) out[key] = item[key];
    });
    if (!final) out.dialogReferenceID = item.dialogReferenceID;
    return out;
  }

  function currentCitation(final) {
    return {
      citationID: S.io.citation && S.io.citation.citationID,
      properties: { unsorted: !S.keepSorted, noteIndex: (S.io.citation && S.io.citation.properties || {}).noteIndex || 0 },
      citationItems: S.items.map(function (item) { return citationItem(item, final); })
    };
  }

  /* --------------------------------------------------- citation dialog --- */
  function renderCitationShell() {
    $('#title').textContent = S.title;
    $('#headerHint').textContent = '默认按分类浏览文献库；输入关键词自动切到「文献列表」检索。点击条目加入引注';
    $('#main').innerHTML =
      '<div id="bubbleBox" class="panel"><input id="searchInput" class="input" style="border:0;box-shadow:none" ' +
      'placeholder="输入关键词自动切到「文献列表」检索" autocomplete="off"></div>' +
      '<div class="toolbar">' +
        '<div class="segmented" id="modeSwitch">' +
          '<button data-mode="list">文献列表</button><button data-mode="library">文献库</button></div>' +
        '<label class="check"><input type="checkbox" id="keepSorted"> 保持文献自动排序</label>' +
        '<label class="check"><input type="checkbox" id="showPreview"> 显示引注预览</label>' +
        '<span class="grow"></span><span class="spinner hidden" id="spinner"></span>' +
      '</div>' +
      '<div id="browser">' +
        '<div id="collections" class="panel hidden"></div>' +
        '<div id="results" class="panel"></div>' +
      '</div>' +
      '<div id="preview" class="hidden"></div>' +
      '<div id="details" class="hidden"><div id="detailsCard"></div></div>';

    $('#keepSorted').checked = S.keepSorted;
    $('#showPreview').checked = S.showPreview;
    $$('#modeSwitch button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === S.layout);
      b.onclick = function () { switchLayout(b.dataset.mode); };
    });
    $('#keepSorted').onchange = function () { S.keepSorted = this.checked; if (S.keepSorted && sortable()) sortItems(); };
    $('#showPreview').onchange = function () { S.showPreview = this.checked; updatePreview(); };
    $('#searchInput').addEventListener('input', onSearchInput);
    $('#searchInput').addEventListener('keydown', onSearchKey);
    $('#bubbleBox').addEventListener('click', function (e) { if (e.target === this) $('#searchInput').focus(); });
    $('#results').addEventListener('click', onResultClick);
    $('#results').addEventListener('mousedown', function (e) { if (e.target.closest('.result')) e.preventDefault(); });
    updateFooter();
    if (S.layout === 'library') { $('#collections').classList.remove('hidden'); loadCollections(); }
    doSearch();
    setTimeout(function () { $('#searchInput').focus(); }, 30);
  }

  /* Two views with genuinely different data sources:
     list    = only what the search box matched
     library = one collection (plus subcollections), browsed via the tree */
  function applyLayout(mode, keepQuery) {
    S.layout = mode;
    $$('#modeSwitch button').forEach(function (x) { x.classList.toggle('active', x.dataset.mode === mode); });
    var side = $('#collections');
    if (side) side.classList.toggle('hidden', mode !== 'library');
    var input = $('#searchInput');
    if (input) {
      if (!keepQuery) input.value = '';
      input.placeholder = mode === 'library'
        ? '输入关键词自动切到「文献列表」检索' : '输入作者 / 标题 / 年份检索文献';
    }
    if (!keepQuery) S.searchValue = '';
    if (mode === 'library') loadCollections();
    return input;
  }

  function switchLayout(mode) {
    if (mode !== 'list' && mode !== 'library') return;
    var input = applyLayout(mode, false);
    doSearch();
    if (input) input.focus();
  }

  function loadCollections() {
    if (S.collectionsLoaded) { renderCollections(); return; }
    api('collections').then(function (data) {
      S.collections = data.collections || [];
      S.unfiledCount = Number(data.unfiled || 0);
      S.collectionsLoaded = true;
      renderCollections();
    }).catch(function (e) { toast('分类加载失败：' + e.message); });
  }

  function collectionRow(value, name, indent, count) {
    return '<div class="collection' + (String(S.collection) === String(value) ? ' selected' : '') + '"' +
      ' data-collection="' + esc(value) + '"' + (indent ? ' style="' + indent + '"' : '') +
      ' title="' + esc(name) + '"><span class="name">' + esc(name) + '</span>' +
      (count ? '<span class="count">' + count + '</span>' : '') + '</div>';
  }

  function renderCollections() {
    var box = $('#collections'); if (!box) return;
    var rows = ['<div class="tree-head">按分类添加</div>',
      collectionRow('all', '全部文献', '', 0),
      collectionRow('unfiled', '未分类', '', S.unfiledCount)];
    (function walk(nodes, depth) {
      (nodes || []).forEach(function (node) {
        // itemCount comes from the exact same recursive/deduplicated item set
        // that the results list shows, so the badge can never disagree.
        var total = Number(node.itemCount ?? node.totalCount ?? node.count ?? 0);
        rows.push(collectionRow(String(node.id), node.name,
          'padding-left:' + (7 + depth * 12) + 'px', total > 500 ? '500+' : total));
        walk(node.children, depth + 1);
      });
    })(S.collections, 0);
    box.innerHTML = rows.join('');
    $$('.collection', box).forEach(function (row) {
      row.onclick = function () {
        S.collection = row.dataset.collection;
        renderCollections();
        doSearch();
      };
    });
  }

  function sortable() { return !!S.io.sortable; }

  function renderBubbles() {
    var box = $('#bubbleBox'); if (!box) return;
    $$('.bubble', box).forEach(function (n) { n.remove(); });
    S.items.forEach(function (item, index) {
      var el = document.createElement('span');
      el.className = 'bubble' + (S.detailsIndex === index ? ' selected' : '');
      el.tabIndex = 0; el.draggable = true; el.title = bubbleString(item);
      el.innerHTML = '<span class="txt">' + esc(bubbleString(item)) + '</span><span class="x" title="移除">×</span>';
      el.addEventListener('click', function (e) {
        if (e.target.classList.contains('x')) { removeItem(index); return; }
        openDetails(index);
      });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); removeItem(index); }
        else if (e.key === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); moveItem(index, index - 1); }
        else if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); moveItem(index, index + 1); }
        else if (e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); openDetails(index); }
      });
      el.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', String(index)); });
      box.insertBefore(el, $('#searchInput'));
    });
    $('#searchInput').placeholder = S.items.length ? '继续搜索，或直接输入页码（如 10-15）'
      : (S.layout === 'library' ? '输入关键词自动切到「文献列表」检索' : '输入作者 / 标题 / 年份检索文献');
    var btn = $('#acceptBtn'); if (btn) btn.disabled = S.items.length === 0;
    updatePreview();
  }

  function updateFooter() {
    footer([
      { label: '取消', onClick: cancel },
      { label: '确定', primary: true, id: 'acceptBtn', disabled: S.items.length === 0, onClick: acceptCitation }
    ], '<span>Ctrl/⌘ + Enter 确定 · Esc 取消 · ↑↓ 选择 · Tab 切换</span>');
  }

  function onSearchInput(e) {
    var raw = e.target.value;
    var numeric = NUMERIC.test(raw.trim()) && raw.trim() !== '';
    if (S.justAdded && numeric) {
      clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(function () { applyNumericLocator(raw, false); }, 500);
      return;
    }
    S.justAdded = null;
    var loc = extractLocator(raw);
    var query = cleanQuery(loc ? raw.replace(loc.fullLocatorString, '') : raw);
    // Typing a real query means "search the whole library": jump from the
    // default 文献库 tab to 文献列表, keeping what the user just typed.
    var layoutChanged = false;
    if (S.layout === 'library' && query) {
      applyLayout('list', true);
      layoutChanged = true;
    }
    if (query === S.searchValue && !layoutChanged) return;
    S.searchValue = query;
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(doSearch, 250);
  }

  function applyNumericLocator(raw, fromEnter) {
    if (!S.justAdded) return false;
    var item = S.justAdded;
    var value = String(raw).trim().replace(/^:/, '');
    if (!value) return false;
    S.lastLocator = { index: S.items.indexOf(item), before: item.locator, label: item.label };
    item.locator = item.locator ? item.locator + value : value;
    item.label = 'page';
    $('#searchInput').value = '';
    S.justAdded = null;
    S.acceptSuppressUntil = Date.now() + 500;
    renderBubbles();
    if (fromEnter) $('#searchInput').focus();
    return true;
  }

  function onSearchKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); acceptCitation(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#searchInput').select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && S.lastLocator) {
      e.preventDefault();
      var item = S.items[S.lastLocator.index];
      if (item) { item.locator = S.lastLocator.before; item.label = S.lastLocator.label; $('#searchInput').value = ''; renderBubbles(); }
      S.lastLocator = null; return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!S.flat.length) return;
      S.current = e.key === 'ArrowDown' ? Math.min(S.flat.length - 1, S.current + 1) : Math.max(0, S.current - 1);
      if (e.shiftKey) S.selected.add(S.current);
      renderResults(); return;
    }
    if (e.key === 'Enter') { e.preventDefault(); handleEnter(); }
  }

  function handleEnter() {
    var raw = $('#searchInput').value;
    if (S.justAdded && NUMERIC.test(raw.trim()) && raw.trim() !== '') { applyNumericLocator(raw, true); return; }
    var loc = extractLocator(raw);
    if (loc && loc.onlyLocator && S.items.length) {
      var last = S.items[S.items.length - 1];
      last.locator = loc.locator; last.label = loc.label;
      $('#searchInput').value = ''; S.justAdded = null; renderBubbles(); return;
    }
    var chosen = S.selected.size ? S.flat.filter(function (_, i) { return S.selected.has(i); }) : [];
    if (!chosen.length && S.current >= 0 && S.flat[S.current]) chosen = [S.flat[S.current]];
    if (chosen.length) { addItems(chosen, raw); return; }
    if (S.flat.length === 1) { addItems([S.flat[0]], raw); return; }
    if (!raw.trim() && Date.now() > S.acceptSuppressUntil) { acceptCitation(); }
  }

  function onResultClick(e) {
    var node = e.target.closest('.result'); if (!node) return;
    var index = Number(node.dataset.index);
    if (e.ctrlKey || e.metaKey) {
      if (S.selected.has(index)) S.selected.delete(index); else S.selected.add(index);
      S.current = index; renderResults(); return;
    }
    if (e.shiftKey && S.current >= 0) {
      var from = Math.min(S.current, index), to = Math.max(S.current, index);
      for (var i = from; i <= to; i += 1) S.selected.add(i);
      renderResults(); return;
    }
    addItems([S.flat[index]], $('#searchInput').value);
  }

  function addItems(rows, raw) {
    if (S.searching) return;
    var loc = extractLocator(raw || '');
    var existing = new Set(S.items.map(function (i) { return String(i.id); }));
    var added = [];
    (rows || []).forEach(function (row) {
      if (!row || existing.has(String(row.id))) return;
      if (S.dialogType === 'add-note' && S.items.length) return;
      existing.add(String(row.id));
      var item = {
        id: row.id, itemData: row.itemData || null, uris: row.uris || [],
        title: row.title || '', creator: row.creator || '', year: row.year || '',
        locator: '', label: '', prefix: '', suffix: '', 'suppress-author': false,
        dialogReferenceID: rid()
      };
      S.items.push(item); added.push(item);
    });
    if (!added.length) {
      if ((rows || []).length && (rows || []).every(function (row) { return row && existing.has(String(row.id)); })) {
        toast('该文献已选中');
      }
      return;
    }
    if (loc) {
      added.forEach(function (item) { item.locator = loc.locator; item.label = loc.label; });
      S.justAdded = null;
    } else if (added.length === 1) {
      S.justAdded = added[0];
    }
    if (S.dialogType === 'add-note') { acceptCitation(); return; }
    if (S.keepSorted && sortable()) sortItems();
    $('#searchInput').value = '';
    S.searchValue = '';
    S.selected.clear(); S.current = -1;
    renderBubbles(); updateFooter(); doSearch();
    $('#searchInput').focus();
  }

  function removeItem(index) {
    if (index < 0 || index >= S.items.length) return;
    S.items.splice(index, 1);
    S.justAdded = null; S.detailsIndex = -1;
    renderBubbles(); updateFooter(); renderResults();
  }

  function moveItem(from, to) {
    if (to < 0 || to >= S.items.length || from === to) return;
    var item = S.items.splice(from, 1)[0];
    S.items.splice(to, 0, item);
    S.keepSorted = false;
    var box = $('#keepSorted'); if (box) box.checked = false;
    renderBubbles();
  }

  function sortItems() {
    post('preview', { citation: currentCitation(false) }).catch(function () {});
    // Sorting is delegated to citeproc by the host on accept; locally we keep a
    // stable bibliographic order (creator, year, title) as a best-effort view.
    S.items.sort(function (a, b) {
      return [a.creator, a.year, a.title].join('|').localeCompare([b.creator, b.year, b.title].join('|'), 'zh-CN');
    });
    renderBubbles();
  }

  function doSearch() {
    if (S.type !== 'citation') return;
    S.searching = true;
    var spinner = $('#spinner'); if (spinner) spinner.classList.remove('hidden');
    var mode = S.dialogType === 'add-note' ? 'note' : S.dialogType === 'annotations' ? 'annotations' : 'citation';
    api('search?q=' + encodeURIComponent(S.searchValue) + '&mode=' + encodeURIComponent(mode) +
      '&scope=' + encodeURIComponent(S.dialogType) +
      '&layout=' + encodeURIComponent(S.layout) +
      '&collection=' + encodeURIComponent(S.collection)).then(function (data) {
      S.groups = data.groups || [];
      S.emptyHint = data.hint || '';
      S.flat = [];
      S.groups.forEach(function (group) { (group.items || []).forEach(function (item) { S.flat.push(item); }); });
      S.flat.forEach(function (item, index) { item._index = index; });
      S.current = S.flat.length ? 0 : -1;
      S.selected.clear();
      renderResults();
    }).catch(function (e) { toast('检索失败：' + e.message); })
      .finally(function () { S.searching = false; if (spinner) spinner.classList.add('hidden'); });
  }

  function renderResults() {
    var box = $('#results'); if (!box) return;
    var chosenIDs = new Set(S.items.map(function (item) { return String(item.id); }));
    var citedCounts = new Map((S.io.citedItems || []).map(function (entry) {
      return [String(entry.id), Number(entry.count) || 1];
    }));
    var html = '';
    S.groups.forEach(function (group) {
      if (!(group.items || []).length) return;
      var canAddAll = (group.key === 'collection' || group.key === 'search') && group.items.length > 1;
      html += '<div class="group-title">' + esc(group.label) +
        (canAddAll ? ' <button class="btn small" data-add-all="' + esc(group.key) + '">全部添加</button>' : '') + '</div>';
      group.items.forEach(function (item) {
        var index = item._index;
        var chosen = chosenIDs.has(String(item.id));
        var cited = Number(item.count || citedCounts.get(String(item.id)) || 0);
        var classes = 'result' + (chosen ? ' chosen' : '') +
          (index === S.current ? ' current' : '') + (S.selected.has(index) ? ' selected' : '');
        var meta = [item.creator, item.year].filter(Boolean).join(', ');
        html += '<div class="' + classes + '" data-index="' + index + '" role="option" aria-selected="' + S.selected.has(index) + '"' +
          (chosen ? ' title="已选中"' : '') + '>' +
          '<span class="title">' + esc(item.title || '（无标题）') + '</span>' +
          (chosen ? '<span class="badge chosen">✓ 已选中</span>' : '') +
          (cited ? '<span class="badge cited">本文中引用 ' + cited + ' 次</span>' : '') +
          '<span class="meta">' + esc(meta) + '</span></div>';
      });
    });
    if (!html) html = '<div class="empty">' + esc(S.emptyHint ||
      (S.layout === 'library' ? '该分类下暂无文献' : (S.searchValue ? '没有匹配的条目' : '输入关键词搜索文库条目'))) + '</div>';
    box.innerHTML = html;
    $$('[data-add-all]', box).forEach(function (button) {
      button.onclick = function (event) {
        event.stopPropagation();
        var group = S.groups.find(function (g) { return g.key === button.dataset.addAll; });
        addItems((group && group.items) || [], $('#searchInput').value);
      };
    });
  }

  function updatePreview() {
    clearTimeout(S.previewTimer);
    var box = $('#preview'); if (!box) return;
    box.classList.toggle('hidden', !S.showPreview);
    if (!S.showPreview || !S.items.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<span class="hint">正在生成预览…</span>';
    S.previewTimer = setTimeout(function () {
      post('preview', { citation: currentCitation(false) }).then(function (data) {
        box.innerHTML = data.error ? '<span class="err">预览不可用：' + esc(data.error) + '</span>' : (data.html || '<span class="hint">（无预览）</span>');
      }).catch(function (e) { box.innerHTML = '<span class="err">预览不可用：' + esc(e.message) + '</span>'; });
    }, 180);
  }

  function openDetails(index) {
    var item = S.items[index]; if (!item) return;
    S.detailsIndex = index;
    S.detailsSnapshot = JSON.parse(JSON.stringify(item));
    S.discardDetails = false;
    var card = $('#detailsCard');
    var options = LOCATORS.map(function (l) {
      return '<option value="' + l[0] + '"' + (item.label === l[0] ? ' selected' : '') + '>' + esc(l[0]) + '</option>';
    }).join('');
    card.innerHTML = '<h2>' + esc(bubbleString(item)) + '</h2>' +
      '<div class="grid">' +
        '<label for="dLabel">定位符类型</label><select id="dLabel" class="input"><option value="">（自动）</option>' + options + '</select>' +
        '<label for="dLocator">定位符</label><input id="dLocator" class="input" value="' + esc(item.locator || '') + '" placeholder="例如 10-15">' +
        '<label for="dPrefix">前缀</label><input id="dPrefix" class="input" value="' + esc(item.prefix || '') + '" placeholder="例如 参见 ">' +
        '<label for="dSuffix">后缀</label><input id="dSuffix" class="input" value="' + esc(item.suffix || '') + '" placeholder="例如 , 着重号为我所加">' +
      '</div>' +
      '<label class="check"><input type="checkbox" id="dSuppress"' + (item['suppress-author'] ? ' checked' : '') + '> 省略作者</label>' +
      '<div class="hint">提示：也可以直接在主输入框中键入页码等定位符。</div>' +
      '<div class="row" style="justify-content:flex-end">' +
        '<button class="btn" id="dRemove">移除条目</button>' +
        '<button class="btn" id="dCancel">放弃修改</button>' +
        '<button class="btn primary" id="dDone">完成</button></div>';
    $('#details').classList.remove('hidden');
    ['dLabel', 'dLocator', 'dPrefix', 'dSuffix', 'dSuppress'].forEach(function (id) {
      $('#' + id).addEventListener('input', detailChanged);
      $('#' + id).addEventListener('change', detailChanged);
    });
    $('#dDone').onclick = function () { $('#details').classList.add('hidden'); S.detailsIndex = -1; renderBubbles(); };
    $('#dCancel').onclick = function () { S.discardDetails = true; $('#details').classList.add('hidden'); closeDetails(true); };
    $('#dRemove').onclick = function () { $('#details').classList.add('hidden'); S.detailsIndex = -1; removeItem(index); };
    setTimeout(function () { $('#dLocator').focus(); }, 30);
  }

  function detailChanged() {
    var item = S.items[S.detailsIndex]; if (!item) return;
    item.label = $('#dLabel').value;
    item.locator = $('#dLocator').value;
    item.prefix = $('#dPrefix').value;
    item.suffix = $('#dSuffix').value;
    item['suppress-author'] = $('#dSuppress').checked;
    if (!item.locator) item.label = '';
  }

  function closeDetails(discard) {
    if (discard && S.detailsSnapshot && S.items[S.detailsIndex]) {
      S.items[S.detailsIndex] = S.detailsSnapshot;
    }
    S.detailsIndex = -1; renderBubbles();
  }

  function acceptCitation() {
    if (!S.items.length || S.searching) return;
    submit({ citation: currentCitation(true), unsorted: !S.keepSorted });
  }

  /* --------------------------------------------------- document prefs --- */
  function renderDocPrefs() {
    $('#title').textContent = S.title;
    $('#headerHint').textContent = '选择引用样式与文档选项';
    $('#main').innerHTML =
      '<div class="section panel">' +
        '<div class="label">引用样式</div>' +
        '<div class="row"><input id="styleSearch" class="input grow" placeholder="检索已安装样式或输入名称从 Zotero 样式库查找">' +
        '<button class="btn" id="styleRepo">在线检索</button></div>' +
        '<div id="styleList" class="list panel" style="max-height:210px"></div>' +
        '<div class="hint" id="styleHint"></div>' +
      '</div>' +
      '<div class="section panel">' +
        '<div class="field-row"><label class="label" for="locale">语言区域</label><select id="locale" class="input"></select></div>' +
        '<div class="field-row"><label class="label" for="displayAs">引注显示为</label><select id="displayAs" class="input">' +
          '<option value="0">正文引注</option><option value="footnotes">脚注</option><option value="endnotes">尾注</option></select></div>' +
        '<label class="check"><input type="checkbox" id="bookmarks"> 引注存储为书签（可与 LibreOffice 共享）</label>' +
        '<label class="check"><input type="checkbox" id="autoUpdates"> 自动更新引注</label>' +
        '<label class="check"><input type="checkbox" id="abbrev"> 使用 MEDLINE 期刊缩写</label>' +
        '<div class="hint">关闭自动更新可加快大型文档的插入速度；之后可点击「刷新」手动更新。</div>' +
      '</div>';
    var io = S.io;
    S.selectedStyle = io.style || '';
    S.selectedLocale = io.locale || '';
    $('#locale').innerHTML = (S.styleRowsLocales || []).map(function (l) {
      return '<option value="' + esc(l.code) + '"' + (l.code === io.locale ? ' selected' : '') + '>' + esc(l.name) + '</option>';
    }).join('');
    if (!io.locale) $('#locale').insertAdjacentHTML('afterbegin', '<option value="">（样式默认）</option>');
    $('#locale').value = io.locale || '';
    var noteStyle = io.styleClass === 'note';
    $('#displayAs').value = noteStyle ? (Number(io.useEndnotes) === 1 ? 'endnotes' : 'footnotes') : '0';
    $('#displayAs').disabled = !noteStyle;
    $('#bookmarks').checked = io.fieldType === io.secondaryFieldType;
    $('#autoUpdates').checked = !io.delayCitationUpdates;
    $('#abbrev').checked = !!io.automaticJournalAbbreviations;
    $('#styleSearch').addEventListener('input', function () { renderStyles(this.value); });
    $('#styleRepo').onclick = function () {
      var q = $('#styleSearch').value.trim();
      if (!q) { toast('请输入样式名称'); return; }
      S.styleInstallBusy = true; $('#styleHint').textContent = '正在检索 Zotero 样式库…';
      api('style-search?q=' + encodeURIComponent(q)).then(function (data) {
        S.styleRows = (data.styles || []).map(function (s) {
          return { styleID: s.styleID, title: s.title, titleShort: s.titleShort, installed: s.installed };
        });
        $('#styleHint').textContent = '在线结果 ' + S.styleRows.length + ' 条，点击即可安装并选用';
        renderStyles('');
      }).catch(function (e) { toast('样式检索失败：' + e.message); })
        .finally(function () { S.styleInstallBusy = false; });
    };
    footer([{ label: '取消', onClick: cancel }, { label: '确定', primary: true, onClick: function () {
      var chosen = S.selectedStyle;
      if (!chosen) { toast('请先选择一个引用样式'); return; }
      submit({
        style: chosen, locale: $('#locale').value,
        fieldType: $('#bookmarks').checked ? S.io.secondaryFieldType : S.io.primaryFieldType,
        useEndnotes: $('#displayAs').value === 'endnotes' ? 1 : 0,
        automaticJournalAbbreviations: $('#abbrev').checked,
        delayCitationUpdates: !$('#autoUpdates').checked,
        dontAskDelayCitationUpdates: S.io.dontAskDelayCitationUpdates || false,
        exportDocument: false
      });
    } }], '<span>安装在线样式需要网络连接；已安装样式可离线使用</span>');
    api('styles').then(function (data) {
      S.styleRows = data.styles || [];
      S.styleRowsLocales = data.locales || [];
      $('#locale').innerHTML = '<option value="">（样式默认）</option>' + S.styleRowsLocales.map(function (l) {
        return '<option value="' + esc(l.code) + '"' + (l.code === S.io.locale ? ' selected' : '') + '>' + esc(l.name) + '</option>';
      }).join('');
      $('#locale').value = S.io.locale || '';
      renderStyles('');
    });
  }

  function renderStyles(query) {
    var box = $('#styleList'); if (!box) return;
    var needle = String(query || '').trim().toLowerCase();
    var rows = S.styleRows.filter(function (s) {
      return !needle || (s.title + ' ' + (s.titleShort || '') + ' ' + s.styleID).toLowerCase().includes(needle);
    });
    box.innerHTML = rows.length ? rows.map(function (s) {
      return '<div class="style-row' + (s.styleID === S.selectedStyle ? ' selected' : '') + '" data-id="' + esc(s.styleID) + '">' +
        '<strong>' + esc(s.title) + '</strong>' + (s.titleShort ? ' <span class="hint">' + esc(s.titleShort) + '</span>' : '') +
        (s.installed === false ? ' <span class="badge">在线</span>' : '') + '</div>';
    }).join('') : '<div class="empty">没有匹配的样式</div>';
    $$('.style-row', box).forEach(function (row) {
      row.onclick = function () {
        var entry = rows.find(function (s) { return s.styleID === row.dataset.id; });
        if (entry && entry.installed === false) {
          $('#styleHint').textContent = '正在安装 ' + entry.title + '…';
          post('style-install', { styleID: entry.styleID }).then(function (installed) {
            entry.installed = true; entry.title = installed.title || entry.title;
            S.selectedStyle = entry.styleID; renderStyles(query);
            $('#styleHint').textContent = '已安装 ' + entry.title;
          }).catch(function (e) { toast('样式安装失败：' + e.message); });
          return;
        }
        S.selectedStyle = row.dataset.id; renderStyles(query);
      };
    });
  }

  /* ------------------------------------------------------ bibliography --- */
  function renderBibliography() {
    $('#title').textContent = S.title;
    $('#headerHint').textContent = '添加未引用条目、排除已引用条目，或直接修改某一条参考文献';
    $('#main').innerHTML =
      '<div class="split">' +
        '<div class="col panel" style="width:38%">' +
          '<div class="row" style="padding:9px 9px 0"><input id="bibSearch" class="input grow" placeholder="搜索要添加的未引用条目">' +
          '<button class="btn small" id="bibAdd">添加</button></div>' +
          '<div class="row" style="padding:0 9px"><button class="btn small" id="bibRemove">移除所选</button>' +
          '<button class="btn small" id="bibRevert">恢复所选</button>' +
          '<button class="btn small" id="bibRevertAll">全部恢复</button></div>' +
          '<div id="bibList" class="list"></div>' +
        '</div>' +
        '<div class="col grow">' +
          '<div class="toolbar"><button class="btn small" data-cmd="bold" title="加粗">加粗</button>' +
            '<button class="btn small" data-cmd="italic" title="斜体">斜体</button>' +
            '<button class="btn small" data-cmd="underline" title="下划线">下划线</button>' +
            '<span class="hint grow">选中一条参考文献后可在下方直接编辑格式与文字</span></div>' +
          '<div id="bibEditor" class="editor" contenteditable="true"></div>' +
          '<div class="hint">改动会在文档刷新后保留；「恢复」可撤回到样式自动生成的文本。</div>' +
        '</div>' +
      '</div>';
    $$('[data-cmd]').forEach(function (button) {
      button.onmousedown = function (e) { e.preventDefault(); document.execCommand(button.dataset.cmd, false, null); };
    });
    $('#bibEditor').addEventListener('input', function () {
      if (S.activeEntry < 0) return;
      var entry = S.entries[S.activeEntry]; if (!entry) return;
      S.customText[entry.id] = $('#bibEditor').innerHTML;
      entry.edited = true; renderBibList();
    });
    $('#bibAdd').onclick = function () { addUncited($('#bibSearch').value); };
    $('#bibSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addUncited(this.value); } });
    $('#bibRemove').onclick = function () { if (S.activeEntry >= 0) omitEntry(S.activeEntry); };
    $('#bibRevert').onclick = function () { if (S.activeEntry >= 0) revertEntry(S.activeEntry); };
    $('#bibRevertAll').onclick = function () { S.customText = {}; S.omitted = []; S.entries.forEach(function (e) { e.edited = false; }); renderBibList(); };
    footer([{ label: '取消', onClick: cancel }, { label: '确定', primary: true, onClick: function () {
      submit({ customText: S.customText, uncited: S.uncited, omitted: S.omitted });
    } }], '<span>提示：已引用条目被移除后仍会留在文档中，只是不出现在参考文献表里</span>');
    renderBibList();
    if (S.entries.length) selectEntry(0);
  }

  function renderBibList() {
    var box = $('#bibList'); if (!box) return;
    box.innerHTML = S.entries.map(function (entry, index) {
      return '<div class="list-item' + (index === S.activeEntry ? ' selected' : '') + '" data-index="' + index + '">' +
        '<div>' + esc(String(entry.text || '').replace(/<[^>]*>/g, '').slice(0, 90)) + '</div>' +
        '<div class="meta">' + (entry.edited ? '已手工编辑 · ' : '') + (entry.cited ? '已引用' : '未引用（手工添加）') + '</div></div>';
    }).join('') || '<div class="empty">参考文献表为空</div>';
    $$('.list-item', box).forEach(function (node) {
      node.onclick = function () { saveEditor(); selectEntry(Number(node.dataset.index)); };
    });
  }

  function saveEditor() {
    if (S.activeEntry < 0) return;
    var entry = S.entries[S.activeEntry]; if (!entry) return;
    var html = $('#bibEditor').innerHTML;
    if (html !== (S.customText[entry.id] || entry.text)) S.customText[entry.id] = html;
  }

  function selectEntry(index) {
    saveEditor();
    S.activeEntry = index;
    var entry = S.entries[index];
    $('#bibEditor').innerHTML = entry ? (S.customText[entry.id] || entry.text || '') : '';
    renderBibList();
  }

  function revertEntry(index) {
    var entry = S.entries[index]; if (!entry) return;
    delete S.customText[entry.id]; entry.edited = false;
    $('#bibEditor').innerHTML = entry.text || ''; renderBibList();
  }

  function omitEntry(index) {
    var entry = S.entries[index]; if (!entry) return;
    if (!S.omitted.includes(entry.id)) S.omitted.push(entry.id);
    S.entries.splice(index, 1);
    S.activeEntry = Math.min(index, S.entries.length - 1);
    renderBibList(); if (S.activeEntry >= 0) selectEntry(S.activeEntry);
  }

  function addUncited(query) {
    api('search?q=' + encodeURIComponent(query) + '&mode=citation').then(function (data) {
      var rows = (data.groups || []).reduce(function (acc, g) { return acc.concat(g.items || []); }, []);
      if (!rows.length) { toast('没有找到条目'); return; }
      var row = rows[0];
      var id = String(row.id);
      if (S.uncited.includes(id)) { toast('该条目已在未引用列表中'); return; }
      S.uncited.push(id);
      S.entries.push({ id: id, text: [row.creator, row.year, row.title].filter(Boolean).join('. '), cited: false, edited: false });
      $('#bibSearch').value = '';
      renderBibList(); selectEntry(S.entries.length - 1);
    }).catch(function (e) { toast('检索失败：' + e.message); });
  }

  /* ---------------------------------------------------------- explorer --- */
  function renderExplorer() {
    $('#title').textContent = S.title;
    $('#headerHint').textContent = '浏览文档中全部引注及其条目';
    $('#main').innerHTML = '<div class="split">' +
      '<div class="col panel" style="width:48%"><div class="label" style="padding:9px 9px 0">文档引注</div>' +
      '<input id="exSearch" class="input" style="margin:0 9px" placeholder="筛选引注"><div id="exCitations" class="list"></div></div>' +
      '<div class="col panel grow"><div class="label" style="padding:9px 9px 0">条目</div>' +
      '<div id="exItems" class="list"></div></div></div>';
    $('#exSearch').addEventListener('input', renderExplorerLists);
    footer([
      { label: '关闭', onClick: function () { submit({}); } },
      { label: '编辑所选引注', primary: true, onClick: function () {
        var citation = S.explorerCitations[S.activeCitation];
        submit({ editIndex: citation ? citation.index : -1 });
      } },
      { label: '重新关联条目', onClick: function () { toast('请在引注对话框中重新选择条目'); } }
    ], '<span>选中引注后可直接打开引注编辑器</span>');
    renderExplorerLists();
  }

  function renderExplorerLists() {
    var needle = ($('#exSearch') && $('#exSearch').value || '').trim().toLowerCase();
    var citations = S.explorerCitations.filter(function (c) { return !needle || String(c.text).toLowerCase().includes(needle); });
    $('#exCitations').innerHTML = citations.map(function (c) {
      var index = S.explorerCitations.indexOf(c);
      return '<div class="list-item' + (index === S.activeCitation ? ' selected' : '') + '" data-index="' + index + '">' +
        '<div>' + esc(String(c.text || '(空引注)').replace(/<[^>]*>/g, '')) + '</div>' +
        '<div class="meta">' + (c.items || []).map(function (i) { return esc(i.title || i.id); }).join('；') + '</div></div>';
    }).join('') || '<div class="empty">文档中没有引注</div>';
    $$('#exCitations .list-item').forEach(function (node) {
      node.onclick = function () { S.activeCitation = Number(node.dataset.index); renderExplorerLists(); };
    });
    var items = [];
    (S.explorerCitations[S.activeCitation] || {}).items && (items = S.explorerCitations[S.activeCitation].items);
    if (!items.length) items = S.explorerItems;
    $('#exItems').innerHTML = items.map(function (item, index) {
      return '<div class="list-item' + (index === S.activeItem ? ' selected' : '') + '">' +
        '<div>' + esc(item.title || item.id) + '</div><div class="meta">' + esc([item.creator, item.year].filter(Boolean).join(', ')) + '</div></div>';
    }).join('') || '<div class="empty">没有条目</div>';
  }

  /* -------------------------------------------------------- item picker --- */
  function renderItemPicker() {
    $('#title').textContent = S.title;
    $('#headerHint').textContent = '文档中的条目在文库里找不到了，请重新选择';
    $('#main').innerHTML = '<div class="row"><input id="pickSearch" class="input grow" placeholder="搜索文库条目" autocomplete="off"></div>' +
      '<div id="pickResults" class="list panel"></div>';
    $('#pickSearch').addEventListener('input', function () {
      api('search?q=' + encodeURIComponent(this.value) + '&mode=citation').then(function (data) {
        var rows = (data.groups || []).reduce(function (acc, g) { return acc.concat(g.items || []); }, []);
        $('#pickResults').innerHTML = rows.map(function (row) {
          return '<div class="list-item" data-id="' + esc(row.id) + '"><div>' + esc(row.title) + '</div>' +
            '<div class="meta">' + esc([row.creator, row.year].filter(Boolean).join(', ')) + '</div></div>';
        }).join('') || '<div class="empty">没有匹配的条目</div>';
        $$('#pickResults .list-item').forEach(function (node) {
          node.onclick = function () { submit({ id: node.dataset.id }); };
        });
      });
    });
    footer([{ label: '取消', onClick: cancel }], '<span>原条目：' + esc((S.io && S.io.id) || '') + '</span>');
    setTimeout(function () { $('#pickSearch').focus(); }, 30);
  }

  /* ------------------------------------------------------------ progress --- */
  function renderProgress() {
    $('#title').textContent = S.title;
    $('#main').innerHTML = '<div class="section panel"><div class="label">正在更新文档…</div>' +
      '<progress id="bar" max="100" value="0"></progress>' +
      '<div class="hint" id="pct">0%</div></div>';
    footer([]);
    var timer = setInterval(function () {
      api('progress').then(function (data) {
        var value = Math.round(Number(data.percent) || 0);
        $('#bar').value = value; $('#pct').textContent = value + '%';
        if (value >= 100) { clearInterval(timer); setTimeout(function () { window.close(); }, 400); }
      }).catch(function () { clearInterval(timer); });
    }, 200);
  }

  /* --------------------------------------------------------------- boot --- */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && S.type === 'citation') {
      if (!$('#details').classList.contains('hidden')) { S.discardDetails = true; $('#details').classList.add('hidden'); closeDetails(true); return; }
      e.preventDefault(); cancel();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && S.type === 'citation') { e.preventDefault(); acceptCitation(); }
  });

  api('state').then(function (data) {
    S.type = data.type || 'citation';
    S.title = data.title || '文库引用';
    S.io = data.io || {};
    // Marker must match dialogMarker() in window.js (host closes/raises this window).
    document.title = S.title + ' #' + ID.slice(0, 4);
    // Only real --app windows (compact) need Win32 raising; a plain browser
    // tab or a test DOM must not make the host spawn PowerShell.
    if (document.body.classList.contains('compact')) api('raise').catch(function () {});
    if (S.type === 'citation') {
      var citation = S.io.citation || { citationItems: [], properties: {} };
      S.items = (citation.citationItems || []).map(function (item) {
        var data = item.itemData || {};
        return {
          id: item.id, itemData: item.itemData || null, uris: item.uris || [],
          title: data.title || '', creator: (data.author && data.author[0] && (data.author[0].family || data.author[0].literal)) || '',
          year: data.issued && data.issued['date-parts'] && data.issued['date-parts'][0] ? String(data.issued['date-parts'][0][0]) : '',
          locator: item.locator || '', label: item.label || '', prefix: item.prefix || '',
          suffix: item.suffix || '', 'suppress-author': item['suppress-author'] || false,
          dialogReferenceID: rid()
        };
      });
      S.keepSorted = !(citation.properties && citation.properties.unsorted);
      S.dialogType = S.io.isCitingNotes ? 'add-note' : S.io.isAddingAnnotations ? 'annotations' : 'citation';
      renderCitationShell(); renderBubbles();
    } else if (S.type === 'docPrefs') { renderDocPrefs(); }
    else if (S.type === 'bibliography') {
      S.entries = (S.io.entries || []).map(function (e) { return Object.assign({}, e); });
      S.uncited = (S.io.uncited || []).slice(); S.omitted = (S.io.omitted || []).slice();
      renderBibliography();
    } else if (S.type === 'explorer') {
      S.explorerCitations = S.io.citations || []; S.explorerItems = S.io.items || [];
      renderExplorer();
    } else if (S.type === 'itemPicker') { renderItemPicker(); }
    else if (S.type === 'progress') { renderProgress(); }
    else { $('#main').innerHTML = '<div class="empty">未知对话框类型</div>'; footer([{ label: '关闭', onClick: function () { submit({}); } }]); }
  }).catch(function (e) {
    $('#main').innerHTML = '<div class="empty">无法加载对话框：' + esc(e.message) + '</div>';
    footer([{ label: '关闭', onClick: function () { window.close(); } }]);
  });
})();
</script>
</body>
</html>
`;

export function renderDialogPage() {
  return PAGE
}
