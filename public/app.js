/* 入稿さん — チャットUI (添付したら全自動・会話型進行表示) */

const $ = (id) => document.getElementById(id);

const state = {
  running: false,
  pending: null,        // 設定待ちの原稿 { name, content }
  pendingDoc: null,     // 入稿待ちの原稿 { name, content }
  pendingImages: [],    // 添付画像 { name, type, data(base64), dataUrl }
  eyecatchIndex: null,  // 右クリックで指定されたアイキャッチ
  lastPost: null,       // 直前に入稿した記事 (追加指示の対象)
  aborter: null,        // 実行中の処理の中止用
  aborted: false,
};

/* ---------- 設定ストア (複数サイト・サーバー側でチーム共有) ---------- */

const STORE_KEY = 'nyuko-san-store';
const ACTIVE_KEY = 'nyuko-san-active-site';

let store = { sites: [], activeSiteId: null, apiKey: '', postStatus: 'draft' };

function uid() { return Math.random().toString(36).slice(2, 10); }

async function postRaw(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function loadStore() {
  // 1. サーバーに保存されたチーム共有の設定
  let serverStore = null;
  try { serverStore = (await postRaw('/api/store', {})).data.store; } catch (_) {}

  // 2. この端末に残っている旧設定 (localStorage)
  let local = null;
  try { local = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) {}

  if (serverStore && Array.isArray(serverStore.sites) && serverStore.sites.length) {
    store = serverStore;
  } else if (local && Array.isArray(local.sites) && local.sites.length) {
    // 初回: この端末の設定をサーバーへ移行してチーム共有に
    store = local;
    await postRaw('/api/store', { store }).catch(() => {});
    assistantSay('この端末に保存されていた設定を、チーム共有の設定としてサーバーに移行しました。', true);
  }

  // 入稿先サイトの選択だけは端末ごと (他の人の切り替えに影響されない)
  try {
    const act = localStorage.getItem(ACTIVE_KEY);
    if (act && store.sites.find((s) => s.id === act)) store.activeSiteId = act;
  } catch (_) {}
  if (!store.sites.find((s) => s.id === store.activeSiteId)) {
    store.activeSiteId = store.sites[0]?.id || null;
  }
}

let pushStoreTimer = null;

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) {}
  try { localStorage.setItem(ACTIVE_KEY, store.activeSiteId || ''); } catch (_) {}
  // サーバーへもまとめて保存 (チーム共有)
  clearTimeout(pushStoreTimer);
  pushStoreTimer = setTimeout(() => {
    postRaw('/api/store', { store }).catch(() => {});
  }, 400);
}

function siteNameFromUrl(url) {
  try { return new URL(url).host; } catch { return url || '新しいサイト'; }
}

function activeSite() {
  return store.sites.find((s) => s.id === store.activeSiteId) || null;
}

function siteLabel(site) {
  return site?.name || siteNameFromUrl(site?.wpUrl || '');
}

function settingsMissing() {
  const site = activeSite();
  const missing = [];
  if (!site) return ['サイトの登録'];
  if (!site.wpUrl) missing.push('サイトURL');
  if (!site.wpUser) missing.push('ユーザー名');
  if (!site.wpPass) missing.push('アプリケーションパスワード');
  return missing;
}

/* ---------- サイト切り替え ---------- */

const siteSelect = $('siteSelect');

function renderSiteSelect() {
  siteSelect.innerHTML = '';
  for (const s of store.sites) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = siteLabel(s);
    opt.selected = s.id === store.activeSiteId;
    siteSelect.appendChild(opt);
  }
  const add = document.createElement('option');
  add.value = '__add__';
  add.textContent = '＋ サイトを追加…';
  siteSelect.appendChild(add);
  if (store.sites.length === 0) siteSelect.value = '__add__';
}

siteSelect.addEventListener('change', () => {
  if (siteSelect.value === '__add__') {
    addSite();
    return;
  }
  store.activeSiteId = siteSelect.value;
  saveStore();
  assistantSay(`入稿先を「${siteLabel(activeSite())}」に切り替えました。`, true);
});

function addSite() {
  const site = { id: uid(), name: '', wpUrl: '', wpUser: '', wpPass: '', refUrl: '' };
  store.sites.push(site);
  store.activeSiteId = site.id;
  saveStore();
  renderSiteSelect();
  openModal();
}

/* ---------- 設定モーダル ---------- */

function openModal() {
  const site = activeSite();
  $('siteName').value = site?.name || '';
  $('wpUrl').value = site?.wpUrl || '';
  $('wpUser').value = site?.wpUser || '';
  $('wpPass').value = site?.wpPass || '';
  $('refUrl').value = site?.refUrl || '';
  $('siteNote').value = site?.note || '';
  $('adPatterns').value = site?.adPatterns || '';
  $('apiKey').value = store.apiKey || '';
  $('sheetGasUrl').value = store.sheetGasUrl || '';
  $('sheetGasToken').value = store.sheetGasToken || '';
  $('postStatus').value = store.postStatus || 'draft';

  // 開くたびに「このサイト」タブへ戻し、タブ名に対象サイトを表示
  $('modalTabSite').textContent = site ? `このサイト ─ ${siteLabel(site)}` : 'このサイト';
  document.querySelectorAll('.modal-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === 'site'));
  document.querySelectorAll('.modal-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== 'site'));

  $('modalOverlay').classList.remove('hidden');
}

function closeModal() {
  // 保存されなかった空のサイトは破棄する
  const site = activeSite();
  if (site && !site.wpUrl && !site.name && !site.wpUser && !site.refUrl) {
    store.sites = store.sites.filter((s) => s.id !== site.id);
    store.activeSiteId = store.sites[0]?.id || null;
    saveStore();
    renderSiteSelect();
  }
  $('modalOverlay').classList.add('hidden');
}

$('settingsBtn').addEventListener('click', () => {
  if (!activeSite()) { addSite(); return; }
  openModal();
});

/* 設定モーダルのタブ切り替え */
document.querySelectorAll('.modal-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.modal-pane').forEach((p) =>
      p.classList.toggle('hidden', p.dataset.pane !== tab.dataset.pane));
  });
});
$('modalClose').addEventListener('click', closeModal);
$('modalOverlay').addEventListener('click', (e) => {
  if (e.target === $('modalOverlay')) closeModal();
});

$('modalSave').addEventListener('click', () => {
  let site = activeSite();
  if (!site) {
    site = { id: uid() };
    store.sites.push(site);
    store.activeSiteId = site.id;
  }
  site.wpUrl = $('wpUrl').value.trim();
  site.wpUser = $('wpUser').value.trim();
  site.wpPass = $('wpPass').value.trim();
  site.refUrl = $('refUrl').value.trim();
  site.note = $('siteNote').value.trim();
  site.adPatterns = $('adPatterns').value.trim();
  site.name = $('siteName').value.trim() || siteNameFromUrl(site.wpUrl);
  store.apiKey = $('apiKey').value.trim();
  store.sheetGasUrl = $('sheetGasUrl').value.trim();
  store.sheetGasToken = $('sheetGasToken').value.trim();
  store.postStatus = $('postStatus').value;
  saveStore();
  renderSiteSelect();
  $('modalOverlay').classList.add('hidden');

  // 設定待ちの原稿があれば、そのまま自動で入稿を再開
  if (state.pending && settingsMissing().length === 0) {
    const file = state.pending;
    state.pending = null;
    assistantSay(`「${site.name}」の設定を保存しました。続けて入稿します。`, true);
    run(file);
  } else {
    assistantSay(`「${site.name}」の設定を保存しました。原稿を添付してください。`, true);
  }
});

$('deleteSiteBtn').addEventListener('click', () => {
  const site = activeSite();
  if (!site) return;
  if (!confirm(`サイト「${siteLabel(site)}」の設定を削除しますか？`)) return;
  store.sites = store.sites.filter((s) => s.id !== site.id);
  store.activeSiteId = store.sites[0]?.id || null;
  saveStore();
  renderSiteSelect();
  $('modalOverlay').classList.add('hidden');
});

/* ---------- チャット描画 ---------- */

const chat = $('chat');
const WELCOME_HTML = $('welcome').outerHTML;

/* ロゴクリックで最初の画面に戻る (サイト切り替えのクリックは除く) */
$('homeBtn').addEventListener('click', (e) => {
  if (e.target.closest('.site-select')) return;
  if (state.running) {
    assistantSay('いま入稿作業中です。完了してから戻れます。');
    return;
  }
  chat.innerHTML = WELCOME_HTML;
  chat.scrollTop = 0;
});

function hideWelcome() {
  const w = $('welcome');
  if (!w || w.classList.contains('leaving')) return;
  // 高さを固定してから畳むと、後続メッセージが滑らかに位置に収まる
  w.style.height = w.offsetHeight + 'px';
  w.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    w.classList.add('leaving');
    w.style.height = '0px';
    w.style.paddingTop = '0px';
  });
  setTimeout(() => w.remove(), 340);
}

function scrollBottom() { chat.scrollTop = chat.scrollHeight; }

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function userSay(fileName, sub) {
  hideWelcome();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble"><span class="file-chip-msg">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
    <span>${escapeHtml(fileName)}</span><span class="size">${escapeHtml(sub)}</span></span></div>`;
  chat.appendChild(el);
  scrollBottom();
}

const AVATAR_SVG = `<svg viewBox="0 0 48 48" width="24" height="24" fill="none"><path d="M12 5h15l11 11v25a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z" fill="var(--bg)" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M27 5v11h11" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><circle cx="19" cy="27" r="2.2" fill="currentColor"/><circle cx="29" cy="27" r="2.2" fill="currentColor"/><path d="M19 33.5c2 2.2 8 2.2 10 0" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>`;

function assistantMsg(innerHtml, keepWelcome = false) {
  if (!keepWelcome) hideWelcome();
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="avatar">${AVATAR_SVG}</div><div class="content">${innerHtml}</div>`;
  chat.appendChild(el);
  scrollBottom();
  return el.querySelector('.content');
}

function assistantSay(text, keepWelcome = false) {
  return assistantMsg(`<div class="say">${escapeHtml(text)}</div>`, keepWelcome);
}

/* 「〜しています…」のシマー表示 → 完了文に置き換え */
function speak(thinkingText) {
  const content = assistantMsg(`<span class="thinking">${escapeHtml(thinkingText)}</span>`);
  return {
    content,
    done(html) { content.innerHTML = `<div class="say">${html}</div>`; scrollBottom(); },
    fail(text) { content.innerHTML = `<span class="err-text">${escapeHtml(text)}</span>`; scrollBottom(); },
  };
}

/* ユーザーのテキスト指示バブル */
function userSayText(text) {
  hideWelcome();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  chat.appendChild(el);
  scrollBottom();
}

/* 追加指示バーの表示 */
// 直前に入稿した記事の情報。再読み込み後も追加指示を使えるよう端末に保存する
const LASTPOST_KEY = 'nyuko-san-last-post';
function saveLastPost(lp) {
  try { localStorage.setItem(LASTPOST_KEY, JSON.stringify(lp || state.lastPost)); } catch (_) {}
  return lp;
}

function showInstructBar() {
  $('instructBar').classList.remove('hidden');
  document.body.classList.add('has-bar');
}

/* ---------- API ---------- */

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: state.aborter?.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- 中止 ---------- */

function showAbort(on) {
  const btn = $('abortBtn');
  btn.classList.toggle('hidden', !on);
  btn.disabled = false;
  btn.textContent = '■ 中止';
}

$('abortBtn').addEventListener('click', () => {
  if (!state.running) return;
  state.aborted = true;
  state.aborter?.abort();
  const btn = $('abortBtn');
  btn.disabled = true;
  btn.textContent = '中止しています…';
});

const ABORT_MSG = '中止しました。直前に実行中だった処理 (入稿など) は、完了している場合があります。';

function isAbortError(e) {
  return state.aborted || e?.name === 'AbortError' || /aborted/i.test(e?.message || '');
}

/* ---------- 添付 → 即実行 ---------- */

const fileInput = $('fileInput');

document.addEventListener('click', (e) => {
  if (e.target.closest('#dropzone')) fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFiles(fileInput.files);
  fileInput.value = '';
});

function handleFiles(fileList) {
  const files = [...fileList];
  const mdFile = files.find((f) => /\.(md|markdown|txt)$/i.test(f.name));
  const imgFiles = files.filter((f) => /^image\//.test(f.type));
  if (!mdFile && !imgFiles.length) {
    assistantSay('対応していないファイルです。原稿 (.md) または画像をドロップしてください。', true);
    return;
  }
  const tasks = [];
  if (imgFiles.length) tasks.push(addImages(imgFiles));
  if (mdFile) tasks.push(stageDoc(mdFile));
  Promise.all(tasks).then(renderTray);
}

function stageDoc(file) {
  return new Promise((resolve) => {
    if (state.running) {
      assistantSay('いま入稿作業中です。完了してから次の原稿を添付してください。');
      resolve();
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.pendingDoc = { name: file.name, content: reader.result };
      resolve();
    };
    reader.readAsText(file);
  });
}

function addImages(files) {
  return Promise.all(files.map((file) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      state.pendingImages.push({
        name: file.name,
        type: file.type,
        data: String(reader.result).split(',')[1] || '',
        dataUrl: reader.result,
      });
      resolve();
    };
    reader.readAsDataURL(file);
  }))).then(renderTray);
}

/* 入稿準備トレイ (原稿+画像。画像は右クリックでアイキャッチ指定) */
function removePendingImage(i) {
  state.pendingImages.splice(i, 1);
  if (state.eyecatchIndex === i) state.eyecatchIndex = null;
  else if (state.eyecatchIndex !== null && state.eyecatchIndex > i) state.eyecatchIndex--;
  renderTray();
  syncMediaAdded();
}

function renderTray() {
  const tray = $('imageTray');
  const imgs = state.pendingImages;
  const doc = state.pendingDoc;
  if (!imgs.length && !doc) { tray.classList.add('hidden'); return; }
  tray.classList.remove('hidden');
  $('trayTitle').textContent = '入稿の準備';
  $('trayHint').textContent = imgs.length
    ? '画像のサムネイルを右クリックでアイキャッチ指定 ─ 追加のドロップもできます'
    : '画像を追加する場合はここへドロップ';

  const startBtn = $('trayStart');
  startBtn.disabled = !doc;
  startBtn.textContent = doc ? '入稿を開始 ▶' : '原稿 (.md) を待っています…';

  $('trayDoc').innerHTML = doc ? `
    <div class="tray-doc">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="doc-name">${escapeHtml(doc.name)}</span>
      <span class="doc-size">${doc.content.length.toLocaleString()}文字</span>
      <button class="doc-remove" title="原稿を外す">×</button>
    </div>` : '';
  if (doc) {
    $('trayDoc').querySelector('.doc-remove').addEventListener('click', () => {
      state.pendingDoc = null;
      renderTray();
    });
  }

  $('trayThumbs').innerHTML = imgs.map((im, i) => `
    <div class="tray-thumb ${i === state.eyecatchIndex ? 'eyecatch' : ''}" data-i="${i}" title="${escapeHtml(im.name)}">
      <img src="${im.dataUrl}" alt="">
      <button class="thumb-remove" title="画像を外す">×</button>
    </div>`).join('');

  $('trayThumbs').querySelectorAll('.tray-thumb').forEach((el) => {
    const i = Number(el.dataset.i);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      state.eyecatchIndex = state.eyecatchIndex === i ? null : i;
      renderTray();
    });
    el.querySelector('.thumb-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removePendingImage(i);
    });
  });
}

/* ドラッグ&ドロップ (画面全体)
 * dragleaveは要素をまたぐたびに発火してover状態が点滅し、
 * アニメーションがリスタートして忙しなく見えるため、タイマーで安定させる */
let dragOverTimer = null;
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  $('dropzone')?.classList.add('over');
  clearTimeout(dragOverTimer);
  dragOverTimer = setTimeout(() => $('dropzone')?.classList.remove('over'), 200);
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  clearTimeout(dragOverTimer);
  $('dropzone')?.classList.remove('over');
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});

/* メディアライブラリから選ぶ */

function openMediaModal() {
  const site = activeSite();
  if (!site || !site.wpUrl || !site.wpUser || !site.wpPass) {
    assistantSay('先にサイトの接続情報 (URL・ユーザー名・アプリケーションパスワード) を設定してください。');
    return;
  }
  $('mediaOverlay').classList.remove('hidden');
  if (!$('mediaGrid').dataset.loaded) searchMedia('');
  else syncMediaAdded();
}

/* 一覧の「選択済み」表示を、いまトレイにある画像と同期する */
function syncMediaAdded() {
  const ids = new Set(state.pendingImages.filter((im) => im.id).map((im) => String(im.id)));
  $('mediaGrid').querySelectorAll('.media-item').forEach((el) => {
    el.classList.toggle('added', ids.has(el.dataset.id));
  });
}

const mediaPaging = { query: '', page: 1 };

function appendMediaItems(grid, items) {
  const addedIds = new Set(state.pendingImages.filter((im) => im.id).map((im) => im.id));
  for (const item of items) {
    const el = document.createElement('div');
    el.className = `media-item ${addedIds.has(item.id) ? 'added' : ''}`;
    el.dataset.id = String(item.id);
    el.title = item.title || '';
    el.innerHTML = `
      <img src="${escapeHtml(item.thumb)}" alt="" loading="lazy">
      <span class="media-name">${escapeHtml(item.title || 'media-' + item.id)}</span>`;
    el.addEventListener('click', () => {
      if (el.classList.contains('added')) {
        // もう一度クリックで選択を解除 (トレイからも外す)
        const idx = state.pendingImages.findIndex((im) => String(im.id) === String(item.id));
        if (idx >= 0) removePendingImage(idx);
        else el.classList.remove('added');
        return;
      }
      state.pendingImages.push({
        name: item.title || 'media-' + item.id,
        type: item.type,
        data: '',
        dataUrl: item.thumb,
        id: item.id,
        url: item.url,
        alt: item.alt || '',
      });
      el.classList.add('added');
      renderTray();
    });
    grid.appendChild(el);
  }
}

async function searchMedia(query, loadMore = false) {
  const site = activeSite();
  const grid = $('mediaGrid');
  if (loadMore) {
    mediaPaging.page += 1;
  } else {
    mediaPaging.query = query || '';
    mediaPaging.page = 1;
    grid.innerHTML = '<div class="media-empty">読み込み中…</div>';
  }
  grid.querySelector('.media-more')?.remove();
  try {
    const r = await api('/api/media-search', {
      wpUrl: site.wpUrl,
      username: site.wpUser,
      appPassword: site.wpPass,
      query: mediaPaging.query,
      page: mediaPaging.page,
    });
    grid.dataset.loaded = '1';
    if (!loadMore) grid.innerHTML = '';
    if (!r.items.length && !loadMore) {
      grid.innerHTML = '<div class="media-empty">画像が見つかりませんでした</div>';
      return;
    }
    appendMediaItems(grid, r.items);
    if (r.hasMore) {
      const more = document.createElement('div');
      more.className = 'media-more';
      more.innerHTML = '<button type="button">もっと見る</button>';
      more.querySelector('button').addEventListener('click', () => {
        more.querySelector('button').textContent = '読み込み中…';
        searchMedia(mediaPaging.query, true);
      });
      grid.appendChild(more);
    }
  } catch (e) {
    if (!loadMore) grid.innerHTML = `<div class="media-empty">${escapeHtml(e.message)}</div>`;
  }
}

$('trayMediaBtn').addEventListener('click', openMediaModal);
$('mediaClose').addEventListener('click', () => $('mediaOverlay').classList.add('hidden'));
$('mediaOverlay').addEventListener('click', (e) => {
  if (e.target === $('mediaOverlay')) $('mediaOverlay').classList.add('hidden');
});
$('mediaSearchBtn').addEventListener('click', () => searchMedia($('mediaQuery').value.trim()));
$('mediaQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) searchMedia($('mediaQuery').value.trim());
});

/* ---------- 画像の配置エディタ (ブロック間ならどこでも置ける) ---------- */

function arrSiteCreds() {
  const p = state.lastPost;
  if (!p) return null;
  const site = store.sites.find((s) => s.id === p.siteId) || activeSite();
  if (!site || !site.wpUrl || !site.wpUser || !site.wpPass) return null;
  return { wpUrl: site.wpUrl, username: site.wpUser, appPassword: site.wpPass, postId: p.postId };
}

// タグの開き−閉じの差分 (表示用に、タグが閉じるところまでを1ブロックにまとめる)
const ARR_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function arrTagDelta(html) {
  let d = 0;
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>|<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const tag = (m[1] || '').toLowerCase();
    if (!tag || ARR_VOID.has(tag) || m[2] === '/') continue;
    d += m[0][1] === '/' ? -1 : 1;
  }
  return d;
}

let arrDragging = null;

async function openArrangeEditor() {
  const creds = arrSiteCreds();
  if (!creds) { assistantSay('調整できる記事がありません。先に入稿してください。'); return; }
  const overlay = $('arrangeOverlay');
  overlay.classList.remove('hidden');
  const list = $('arrList');
  list.innerHTML = '<div class="media-empty">記事を読み込んでいます…</div>';
  $('arrRail').querySelectorAll('.arr-img').forEach((el) => el.remove());
  try {
    const r = await api('/api/article-blocks', creds);
    buildArrange(r.blocks);
  } catch (e) {
    list.innerHTML = `<div class="media-empty">${escapeHtml(e.message)}</div>`;
  }
}

function arrChip(src) {
  const el = document.createElement('div');
  el.className = 'arr-img';
  el.draggable = true;
  el.dataset.src = src;
  el.innerHTML = `<img src="${escapeHtml(src)}" alt=""><span class="arr-img-name"></span>`;
  el.querySelector('.arr-img-name').textContent = decodeURIComponent((src.split('/').pop() || '').split('?')[0]);
  el.addEventListener('dragstart', (e) => {
    arrDragging = el;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', src); } catch (_) {}
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    arrDragging = null;
    arrHighlight(null);
  });
  el.addEventListener('click', () => {
    const was = el.classList.contains('selected');
    document.querySelectorAll('.arr-img.selected').forEach((x) => x.classList.remove('selected'));
    if (!was) el.classList.add('selected');
  });
  return el;
}

function arrGap(after) {
  const g = document.createElement('div');
  g.className = 'arr-gap';
  g.dataset.after = String(after);
  g.innerHTML = '<span class="arr-gap-line"></span><span class="arr-gap-plus">＋ ここに入れる</span>';
  const accept = () => {
    const chip = arrDragging || document.querySelector('.arr-img.selected');
    if (!chip) return;
    chip.classList.remove('selected', 'in-cell');
    g.after(chip);
    arrHighlight(null);
  };
  g.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; arrHighlight(g); });
  g.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); accept(); });
  g.addEventListener('click', accept);
  return g;
}

// 隙間ピンポイントでなくても落とせるように、リスト全体で「一番近い隙間」に吸い付かせる
function arrNearestGap(y) {
  let best = null;
  let bestD = Infinity;
  for (const g of $('arrList').querySelectorAll('.arr-gap')) {
    const r = g.getBoundingClientRect();
    const d = Math.abs(y - (r.top + r.height / 2));
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}

{
  const list = $('arrList');
  list.addEventListener('dragover', (e) => {
    if (!arrDragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const g = arrNearestGap(e.clientY);
    if (g) arrHighlight(g);
  });
  list.addEventListener('drop', (e) => {
    if (!arrDragging) return;
    e.preventDefault();
    const g = document.querySelector('.arr-gap.over') || arrNearestGap(e.clientY);
    if (g) {
      arrDragging.classList.remove('selected', 'in-cell');
      g.after(arrDragging);
    }
    arrHighlight(null);
  });
}

function arrHighlight(target) {
  document.querySelectorAll('.arr-gap.over').forEach((x) => x.classList.remove('over'));
  if (target) target.classList.add('over');
}

function buildArrange(blocks) {
  const list = $('arrList');
  list.innerHTML = '';
  let fixedIndex = -1;  // 直前までの固定チャンクのindex
  let group = [];       // 表示用にまとめ中の固定チャンク
  let depth = 0;

  const flushGroup = () => {
    if (!group.length) return;
    const b = document.createElement('div');
    b.className = 'arr-block';
    b.innerHTML = group.join('\n\n');
    list.appendChild(b);
    group = [];
    depth = 0;
    list.appendChild(arrGap(fixedIndex));
  };

  list.appendChild(arrGap(-1));
  for (const blk of blocks) {
    if (blk.t === 'img') {
      flushGroup();
      list.appendChild(arrChip(blk.src)); // いまの位置 (直前のgapの直後) に表示
    } else {
      fixedIndex++;
      group.push(blk.html);
      depth += arrTagDelta(blk.html);
      if (depth <= 0) flushGroup();
    }
  }
  flushGroup();

  // 表のセル (td/th) も受け皿にする + セル内の画像はチップ化して動かせるようにする
  let cellIndex = 0;
  for (const blockEl of list.querySelectorAll('.arr-block')) {
    for (const cell of blockEl.querySelectorAll('td, th')) {
      cell.dataset.cell = String(cellIndex++);
      cell.classList.add('arr-cell');
      for (const im of [...cell.querySelectorAll('img')]) {
        const src = im.getAttribute('src') || '';
        if (!src) continue;
        const chip = arrChip(src);
        chip.classList.add('in-cell');
        im.replaceWith(chip);
      }
      const accept = () => {
        const chip = arrDragging || document.querySelector('.arr-img.selected');
        if (!chip) return;
        chip.classList.remove('selected');
        chip.classList.add('in-cell');
        cell.appendChild(chip);
        arrHighlight(null);
        cell.classList.remove('over');
      };
      cell.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); cell.classList.add('over'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('over'));
      cell.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); accept(); });
      cell.addEventListener('click', (e) => { e.stopPropagation(); accept(); });
    }
  }
}

$('arrApply').addEventListener('click', async () => {
  const creds = arrSiteCreds();
  if (!creds) return;
  const positions = [];
  let after = -1;
  for (const el of $('arrList').children) {
    if (el.classList.contains('arr-gap')) after = Number(el.dataset.after);
    else if (el.classList.contains('arr-img')) positions.push({ src: el.dataset.src, after });
  }
  // 表のセルに置かれた画像
  for (const chip of $('arrList').querySelectorAll('.arr-cell .arr-img')) {
    positions.push({ src: chip.dataset.src, cell: Number(chip.closest('.arr-cell').dataset.cell) });
  }
  const manage = [...document.querySelectorAll('#arrangeOverlay .arr-img')].map((el) => el.dataset.src);
  const btn = $('arrApply');
  btn.disabled = true;
  btn.textContent = '反映しています…';
  try {
    const r = await api('/api/arrange-images', { ...creds, manage, positions });
    $('arrangeOverlay').classList.add('hidden');
    assistantSay(`画像の配置を反映しました (本文内 ${r.placed}枚${r.removed ? `・外した画像 ${r.removed}枚` : ''})。本文テキストは変更していません。`);
  } catch (e) {
    assistantSay(`配置の反映に失敗しました: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '反映する ▶';
  }
});

{
  const rail = $('arrRail');
  rail.addEventListener('dragover', (e) => { e.preventDefault(); rail.classList.add('over'); });
  rail.addEventListener('dragleave', () => rail.classList.remove('over'));
  rail.addEventListener('drop', (e) => {
    e.preventDefault();
    rail.classList.remove('over');
    if (arrDragging) { arrDragging.classList.remove('in-cell'); rail.appendChild(arrDragging); }
  });
  rail.addEventListener('click', () => {
    const chip = document.querySelector('.arr-img.selected');
    if (chip) { chip.classList.remove('selected', 'in-cell'); rail.appendChild(chip); }
  });
}
$('arrClose').addEventListener('click', () => $('arrangeOverlay').classList.add('hidden'));
$('arrangeOverlay').addEventListener('click', (e) => {
  if (e.target === $('arrangeOverlay')) $('arrangeOverlay').classList.add('hidden');
});

/* 「入稿を開始」ボタン */
$('trayStart').addEventListener('click', () => {
  const doc = state.pendingDoc;
  if (!doc || state.running) return;
  state.pendingDoc = null;
  run(doc);
});

/* ---------- 実行 (すべて自動・会話型) ---------- */

async function run(file, opts = {}) {
  if (state.running) return;

  const missing = settingsMissing();
  if (missing.length) {
    state.pending = file;
    assistantSay(`お預かりしました。ただ、先に設定が必要です (${missing.join('・')})。入力して保存すると、そのまま自動で入稿します。`);
    if (!activeSite()) addSite(); else openModal();
    return;
  }

  const site = activeSite();
  state.running = true;
  state.aborter = new AbortController();
  state.aborted = false;
  showAbort(true);

  // 添付画像を取り込んでトレイを空にする (再実行時はアップロード済み画像を使う)
  const presetImages = opts.presetImages || null;
  const images = presetImages || state.pendingImages;
  const userEyecatch = presetImages ? null : state.eyecatchIndex;
  if (!presetImages) {
    state.pendingImages = [];
    state.eyecatchIndex = null;
    renderTray();
  }

  userSay(file.name, `${file.content.length.toLocaleString()}文字${images.length ? ` + 画像${images.length}枚` : ''} → ${siteLabel(site)}${opts.updateId ? ' (更新)' : ''}`);

  try {
    // 1) 解析
    let m = speak('原稿を読んでいます…');
    const first = await api('/api/convert', { markdown: file.content });
    if (!first.title) {
      m.fail('原稿からタイトル (# 見出し) が見つかりませんでした。原稿の形式をご確認ください。');
      return finish();
    }
    const labels = { h2: 'H2', h3: 'H3', p: '段落', ul: '箇条書き', table: '表', quote: '口コミ引用', box: 'ボックス' };
    const statsText = Object.entries(first.stats).map(([k, v]) => `${labels[k] || k}×${v}`).join('、');
    m.done(
      `原稿を読み終えました。タイトルは「<span class="em">${escapeHtml(first.title)}</span>」ですね。` +
      `<span class="sub">構成: ${escapeHtml(statsText)}</span>` +
      (first.excerpt
        ? `<span class="sub">ディスクリプション: ${escapeHtml(first.excerpt.slice(0, 70))}…</span>`
        : `<span class="sub">⚠ ディスクリプションが見つかりませんでした</span>`)
    );

    // 2) 参考記事の取得・学習
    const aiMode = store.apiKey ? 'quality' : null;
    const refKey = site.refUrl || '(最新記事から自動)';
    const cached = aiMode === 'eco'
      && site.tplCache
      && site.tplCache.v === 9
      && site.tplCache.refUrl === refKey
      && (site.tplCache.note || '') === (site.note || '')
      ? site.tplCache : null;

    let learn = null;
    let templates = null;

    let refInfo = { refClasses: [], refHasStrong: false, imageStyle: null, eyecatchInBody: false };

    if (cached) {
      // 学習済みテンプレートを再利用 (参考記事の取得もAPI呼び出しも不要)
      m = speak('学習済みの書き方を確認しています…');
      templates = cached.templates;
      if (cached.refInfo) refInfo = cached.refInfo;
      m.done(
        `前回学習したこのサイトの書き方を再利用します (API料金はかかりません)。` +
        `<span class="sub">学習日時: ${new Date(cached.at).toLocaleString('ja-JP')} ─ 参考記事を変えると学習し直します</span>`
      );
    } else {
      m = speak(site.refUrl ? '参考記事を開いて、書き方を読み取っています…' : 'サイトの最新記事を取得して、書き方を読み取っています…');
      try {
        learn = await api('/api/learn', {
          referenceUrl: site.refUrl,
          wpUrl: site.wpUrl,
          username: site.wpUser,
          appPassword: site.wpPass,
        });
        refInfo = { refClasses: learn.refClasses || [], refHasStrong: Boolean(learn.refHasStrong), imageStyle: learn.imageStyle || null, eyecatchInBody: Boolean(learn.eyecatchInBody) };
        m.done(
          (aiMode
            ? `参考記事を取得しました。この書き方に合わせます。`
            : `書き方を学習しました。このサイトのタグとクラスの使い方に合わせます。`) +
          `<span class="sub">取得元: ${escapeHtml(learn.source)}</span>` +
          (learn.referenceTitle ? `<span class="sub">参考記事: ${escapeHtml(learn.referenceTitle)}</span>` : '') +
          `<span class="sub">見つけた要素: ${learn.learned.length ? learn.learned.map((k) => `<span class="em">${escapeHtml(k)}</span>`).join(' ') : 'クラス指定なし (標準タグを使用)'}</span>`
        );
      } catch (e) {
        if (isAbortError(e)) { m.fail(ABORT_MSG); return finish(); }
        m.fail(`参考記事を読み取れませんでした: ${e.message}`);
        return finish();
      }
    }

    // 3) 変換 + 照合
    let conv = null;

    // 節約モード: AIで書き方をテンプレート化 (初回のみ) → 機械的に流し込み
    if (aiMode === 'eco' && !templates) {
      m = speak('AIが書き方をテンプレートとして学習しています… (節約モード・初回のみ)');
      try {
        const la = await api('/api/learn-ai', {
          referenceHtml: learn.contentHtml,
          apiKey: store.apiKey,
          note: site.note || '',
          raw: learn.raw,
        });
        templates = la.templates;
        site.tplCache = {
          v: 9, refUrl: refKey, note: site.note || '', templates, at: Date.now(),
          refInfo: { refClasses: learn.refClasses || [], refHasStrong: Boolean(learn.refHasStrong), imageStyle: learn.imageStyle || null, eyecatchInBody: Boolean(learn.eyecatchInBody) },
        };
        saveStore();
        m.done(
          `書き方をテンプレート化しました。このサイトは次回からAPI料金なしで変換できます。` +
          `<span class="sub">学習した要素: ${la.learned.length ? la.learned.map((k) => `<span class="em">${escapeHtml(k)}</span>`).join(' ') : 'なし'}</span>`
        );
      } catch (e) {
        if (isAbortError(e)) throw e;
        m.done(`AI学習でエラーが出たため、ルールベースの学習結果を使います。<span class="sub">${escapeHtml(e.message)}</span>`);
        templates = learn.templates;
      }
    }

    // AIが骨組みを組み立て (本文はAIを通らず、必ず全文照合)
    if (aiMode === 'quality') {
      m = speak('AIが参考記事の書き方で骨組みを組み立てています… (本文はAIを通りません)');
      try {
        const ai = await api('/api/convert-ai', {
          markdown: file.content,
          referenceHtml: learn.contentHtml,
          apiKey: store.apiKey,
          note: site.note || '',
          templates: learn.templates,
        });
        if (ai.verification.ok) {
          conv = ai;
          m.done(
            `骨組みができました${ai.attempts > 1 ? ' (検証のため1回やり直し)' : ''}。原稿テキストを流し込み、` +
            `本文 <span class="em">${ai.verification.sourceChars.toLocaleString()}文字</span> が原稿と完全に一致していることを確認しました。`
          );
        } else {
          m.done(`AIの骨組みが照合で不一致だったため採用せず、テンプレート方式に切り替えます。<span class="sub">${escapeHtml(ai.verification.detail)}</span>`);
        }
      } catch (e) {
        if (isAbortError(e)) throw e;
        m.done(`AI変換でエラーが出たため、テンプレート方式に切り替えます。<span class="sub">${escapeHtml(e.message)}</span>`);
      }
    }

    // テンプレート方式 (節約モード・APIなし・フォールバック共通)
    if (!conv) {
      m = speak('原稿をテンプレートに流し込み、本文を照合しています…');
      const c = await api('/api/convert', { markdown: file.content, templates: templates || learn?.templates });
      if (!c.verification.ok) {
        m.fail(`本文の照合で不一致が見つかったため、入稿を中止しました。${c.verification.detail}`);
        return finish();
      }
      conv = c;
      m.done(`変換が完了しました。本文 <span class="em">${c.verification.sourceChars.toLocaleString()}文字</span> が原稿と完全に一致しています。`);
    }

    // 4) 入稿情報の自動準備 (スラッグ・カテゴリー・FAQ構造化データ)
    let prep = null;
    if (store.apiKey) {
      m = speak(images.length ? '画像の配置・スラッグ・カテゴリー・構造化データを準備しています…' : 'スラッグ・カテゴリー・構造化データを準備しています…');
      try {
        prep = await api('/api/prep', {
          apiKey: store.apiKey,
          wpUrl: site.wpUrl,
          title: conv.title,
          excerpt: conv.excerpt,
          html: conv.html,
          images: presetImages ? [] : images.map((im) => ({ name: im.name, type: im.type, data: im.data, url: im.url || '', alt: im.alt || '' })),
          imageStyle: refInfo.imageStyle,
          userEyecatch,
        });
        m.done(
          `入稿情報を準備しました。` +
          `<span class="sub">メインKW: <span class="em">${escapeHtml(prep.mainKw || '(判定なし)')}</span>` +
          ` ／ スラッグ: <span class="em">${escapeHtml(prep.slug || '(生成なし)')}</span>` +
          ` ／ カテゴリー: ${escapeHtml(prep.categoryName || '該当なし')}` +
          ` ／ 構造化データ: ${prep.faqCount ? `Q&A ${prep.faqCount}件をFAQスキーマとして挿入` : 'Q&Aなし'}</span>` +
          (images.length ? `<span class="sub">画像: ${images.length}枚を配置 (アイキャッチ: ${userEyecatch !== null ? '右クリック指定を適用' : 'AIが選定'})${refInfo.imageStyle ? ' ─ このサイトの画像の置き方を参考にしています' : ''}</span>` : '')
        );
      } catch (e) {
        if (isAbortError(e)) throw e;
        m.done(`入稿情報の自動準備はスキップしました。<span class="sub">${escapeHtml(e.message)}</span>`);
      }
    }

    // 画像と配置計画のマージ (AIなしの場合は導入部へ順に配置)
    let imagesForPublish = [];
    if (presetImages) {
      imagesForPublish = presetImages;
    } else if (images.length) {
      const placements = prep?.placements?.length
        ? prep.placements
        : images.map((im, i) => ({
            index: i,
            anchor: 'lead',
            alt: im.name.replace(/\.[a-z0-9]+$/i, '') + 'の画像',
            eyecatch: userEyecatch !== null ? i === userEyecatch : i === 0,
          }));
      imagesForPublish = placements.map((p) => ({
        ...images[p.index],
        dataUrl: undefined, // プレビュー用データは送らない
        alt: p.alt || images[p.index].alt || '',
        anchor: p.anchor,
        eyecatch: p.eyecatch,
      }));
    }

    // 5) 入稿
    m = speak(imagesForPublish.length
      ? `画像をアップロードして「${siteLabel(site)}」に入稿しています…`
      : `「${siteLabel(site)}」に入稿しています…`);
    let pub;
    try {
      pub = await api('/api/publish', {
        wpUrl: site.wpUrl,
        username: site.wpUser,
        appPassword: site.wpPass,
        title: conv.title,
        content: conv.html,
        excerpt: conv.excerpt,
        status: store.postStatus || 'draft',
        slug: prep?.slug || '',
        categories: prep?.categoryId ? [prep.categoryId] : undefined,
        extraContent: prep?.faqScript || '',
        images: imagesForPublish,
        imgClass: refInfo.imageStyle?.imgClass || '',
        updateId: opts.updateId || null,
        eyecatchInBody: Boolean(refInfo.eyecatchInBody),
      });
    } catch (e) {
      if (isAbortError(e)) { m.fail(ABORT_MSG); return finish(); }
      m.fail(`入稿でエラーが発生しました: ${e.message}`);
      if (/401|403|認証|incorrect|invalid/i.test(e.message)) {
        assistantSay('ユーザー名とアプリケーションパスワードをご確認ください。右上の歯車から設定を開けます。');
      }
      return finish();
    }

    // 追加指示の対象として記録
    state.lastPost = saveLastPost({
      siteId: site.id,
      postId: pub.id,
      name: file.name,
      markdown: file.content,
      title: conv.title,
      excerpt: conv.excerpt,
      baseHtml: conv.html,
      faqScript: prep?.faqScript || '',
      imgClass: refInfo.imageStyle?.imgClass || '',
      status: pub.status,
      slug: pub.slug,
      link: pub.link,
      editLink: pub.editLink,
      images: pub.uploadedMedia || [],
      headings: extractHeadings(conv.html),
      eyecatchInBody: Boolean(refInfo.eyecatchInBody),
    });

    const statusLabel = pub.status === 'draft' ? '下書き' : pub.status === 'publish' ? '公開' : pub.status;
    const seoFailed = !pub.seoName && conv.excerpt;
    const seoLine = pub.seoName
      ? `ディスクリプションは <strong>${escapeHtml(pub.seoName)}</strong> を自動検出し、メタディスクリプションと抜粋に保存しました。`
      : `ディスクリプションは抜粋 (excerpt) に保存しました。SEOプラグインのメタ欄への書き込みはこのサイトでは受け付けられませんでした。<strong>下の全文をコピーして、編集画面のメタディスクリプション欄に貼り付けてください。</strong>`;

    m.done(pub.updated
      ? `記事を更新しました (ID: ${pub.id} ／ ${statusLabel})。`
      : `入稿が完了しました。<span class="em">${statusLabel}</span>として保存しています (ID: ${pub.id})。`);

    const resultContent = assistantMsg(`
      <div class="result-card">
        <div class="result-title">✓ ${escapeHtml(conv.title)}</div>
        <div><a href="${escapeHtml(pub.editLink)}" target="_blank">WordPressで編集する →</a></div>
        ${pub.status === 'publish' ? `<div><a href="${escapeHtml(pub.link)}" target="_blank">公開ページを見る →</a></div>` : ''}
        ${(pub.uploadedMedia || []).some((m) => !m.eyecatch) ? '<div><a href="#" class="arrange-link">画像の配置を調整する →</a></div>' : ''}
        <div class="note">${seoLine}</div>
        ${seoFailed ? `
        <div class="desc-block">
          <pre class="desc-text"></pre>
          <button class="desc-copy" type="button">コピー</button>
        </div>` : ''}
      </div>
      <details class="preview">
        <summary>生成されたHTML</summary>
        <pre></pre>
      </details>`);
    resultContent.querySelector('details pre').textContent = conv.html;
    resultContent.querySelector('.arrange-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      openArrangeEditor();
    });
    if (seoFailed) {
      resultContent.querySelector('.desc-text').textContent = conv.excerpt;
      const copyBtn = resultContent.querySelector('.desc-copy');
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(conv.excerpt);
        } catch (_) {
          // http (LAN) ではclipboard APIが使えないため旧方式で
          const ta = document.createElement('textarea');
          ta.value = conv.excerpt;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        copyBtn.textContent = 'コピーしました ✓';
        setTimeout(() => { copyBtn.textContent = 'コピー'; }, 1600);
      });
    }
    scrollBottom();

    // アップ前チェックの自動実行
    m = speak('アップ前チェックを実行しています… (リンク疎通・HTMLエラー・古い情報など)');
    try {
      const pc = await api('/api/precheck', {
        html: pub.contentFinal || conv.html,
        siteUrl: site.wpUrl,
        refClasses: refInfo.refClasses,
        refHasStrong: refInfo.refHasStrong,
        expectedSlug: pub.slug || '',
        adPatterns: (site.adPatterns || '').split(/\n+/).map((s) => s.trim()).filter(Boolean),
      });
      const checkRows = buildChecklistRows(pc, pub, {
        faqInserted: Boolean(prep?.faqCount),
        excerpt: conv.excerpt,
        title: conv.title,
        seoName: pub.seoName,
        imagesCount: imagesForPublish.length,
      });
      m.done(renderChecklist(checkRows));
      if (state.lastPost && state.lastPost.postId === pub.id) {
        state.lastPost.checkRows = checkRows;  // 追加指示「このシートに反映」で使う
        state.lastPost.mainKw = prep?.mainKw || conv.title;
        saveLastPost(state.lastPost);
      }

      // 自動確認できなかったリンクの目視チェックUI
      const pendingLinks = (pc.links.unverified || []).map((href) => ({ href }));
      let sheetUrlForUpdate = null;

      // チェックシートの自動作成 (設定済みのときのみ)
      if (store.sheetGasUrl) {
        m = speak('チェックシートをコピーして、自動チェック分を記入しています…');
        try {
          // シート名にはタイトルではなくメインKWを入れる。
          // status にもマーク文字列をそのまま入れて、旧版のGASでも ◯/×/該当なし/空欄 で記入されるようにする
          const sheetName = prep?.mainKw || conv.title;
          const cs = await api('/api/checksheet', {
            gasUrl: store.sheetGasUrl,
            gasToken: store.sheetGasToken || '',
            title: sheetName,
            articleUrl: pub.editLink,
            rows: checkRows.map((r) => ({ label: r.label, status: r.mark, mark: r.mark, detail: r.detail })),
          });
          m.done(
            `チェックシートを作成し、自動チェックできた項目を記入しました。` +
            `<a class="sheet-card" href="${escapeHtml(cs.url)}" target="_blank" rel="noopener">
              <span class="sheet-info">
                <span class="sheet-title">《入れ込みチェック》WP入稿「${escapeHtml(sheetName)}」</span>
              </span>
              <span class="sheet-open">開く ↗</span>
            </a>`
          );
          sheetUrlForUpdate = cs.url;
        } catch (e) {
          if (isAbortError(e)) { m.fail('チェックシート作成を中止しました。'); return finish(); }
          m.fail(`チェックシートを作成できませんでした: ${e.message}`);
        }
      }

      if (pendingLinks.length) renderLinkReview(pendingLinks, sheetUrlForUpdate);
    } catch (e) {
      if (isAbortError(e)) { m.fail('アップ前チェックを中止しました (入稿自体は完了しています)。'); return finish(); }
      m.fail(`アップ前チェックを実行できませんでした: ${e.message}`);
    }

    finish();
  } catch (e) {
    if (isAbortError(e)) assistantMsg(`<span class="err-text">${escapeHtml(ABORT_MSG)}</span>`);
    else assistantMsg(`<span class="err-text">エラーが発生しました: ${escapeHtml(e.message)}</span>`);
    finish();
  }

  function finish() {
    state.running = false;
    state.aborter = null;
    showAbort(false);
    showInstructBar();
  }
}

function extractHeadings(html) {
  const out = [];
  const re = /<(h[23])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[2].replace(/<[^>]+>/g, '').trim());
  return out;
}

/* ---------- 追加指示 ---------- */

$('nextDocBtn').addEventListener('click', () => fileInput.click());
$('instructSend').addEventListener('click', submitInstruction);
$('instructInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) submitInstruction();
});

function submitInstruction() {
  const text = $('instructInput').value.trim();
  if (!text) return;
  $('instructInput').value = '';
  handleInstruction(text);
}

/* 既存のチェックシートへ自動チェック結果を反映する。
 * 直前の入稿で作ったチェック結果 (checkRows) があればそれを使い、
 * 無ければ今のWP本文を取り直して再チェックしてから記入する。 */
async function fillChecksheetTo(sheetUrl, originalText) {
  const lp = state.lastPost;
  if (!store.sheetGasUrl) { assistantSay('チェックシート連携が未設定です。右上の設定「共通」タブでWebアプリのURLと合言葉を入力してください。'); return; }
  const site = store.sites.find((s) => s.id === lp.siteId) || activeSite();
  if (!site) { assistantSay('対象サイトの設定が見つかりません。'); return; }

  userSayText(originalText || sheetUrl);
  state.running = true;
  state.aborter = new AbortController();
  state.aborted = false;
  showAbort(true);
  let m = speak('チェック結果を既存のシートに反映しています…');
  try {
    let rows = lp.checkRows;
    let pendingLinks = [];
    if (!rows) {
      m.step?.('いまのWP本文を取得して、アップ前チェックをやり直しています…');
      const bl = await api('/api/article-blocks', {
        wpUrl: site.wpUrl, username: site.wpUser, appPassword: site.wpPass, postId: lp.postId,
      });
      const html = bl.blocks.map((b) => b.html).join('\n\n');
      const refInfo = site.tplCache?.refInfo || {};
      const pc = await api('/api/precheck', {
        html,
        siteUrl: site.wpUrl,
        refClasses: refInfo.refClasses,
        refHasStrong: refInfo.refHasStrong,
        expectedSlug: bl.slug || lp.slug || '',
        adPatterns: (site.adPatterns || '').split(/\n+/).map((s) => s.trim()).filter(Boolean),
      });
      rows = buildChecklistRows(pc, {
        slug: bl.slug || lp.slug,
        categories: bl.categories,
        featuredMedia: bl.featuredMedia,
        seoName: lp.seoName,
        uploadedMedia: lp.images,
      }, {
        faqInserted: Boolean(lp.faqScript),
        excerpt: lp.excerpt,
        title: lp.title,
        seoName: lp.seoName,
        imagesCount: (lp.images || []).length,
      });
      pendingLinks = (pc.links.unverified || []).map((href) => ({ href }));
    }
    await api('/api/checksheet', {
      gasUrl: store.sheetGasUrl,
      gasToken: store.sheetGasToken || '',
      action: 'fill',
      sheetUrl,
      title: lp.mainKw || lp.title,
      articleUrl: lp.editLink,
      rows: rows.map((r) => ({ label: r.label, status: r.mark, mark: r.mark, detail: r.detail })),
    });
    m.done(
      `既存のチェックシートに自動チェック分を記入しました。` +
      `<a class="sheet-card" href="${escapeHtml(sheetUrl)}" target="_blank" rel="noopener">
        <span class="sheet-info"><span class="sheet-title">チェックシート</span></span>
        <span class="sheet-open">開く ↗</span>
      </a>`
    );
    if (pendingLinks.length) renderLinkReview(pendingLinks, sheetUrl);
  } catch (e) {
    if (isAbortError(e)) m.fail(ABORT_MSG);
    else m.fail(`シートへの反映に失敗しました: ${e.message}`);
  } finally {
    state.running = false;
    state.aborter = null;
    showAbort(false);
  }
}

async function handleInstruction(text) {
  if (state.running) { assistantSay('処理中です。完了してから指示してください。'); return; }
  const lp = state.lastPost;
  if (!lp) { assistantSay('まだこのセッションで入稿した記事がありません。先に原稿をドロップしてください。'); return; }

  // スプレッドシートのURLが含まれていたら、そのシートへチェック結果を反映 (AI不要)
  const sheetMatch = text.match(/https:\/\/docs\.google\.com\/spreadsheets\/[^\s"'<>]+/);
  if (sheetMatch) { await fillChecksheetTo(sheetMatch[0], text); return; }

  // 短い「配置」系の指示は配置エディタを開く (長文の具体的な移動指示はAIに渡す)
  if (text.length <= 15 && /配置/.test(text)) {
    userSayText(text);
    openArrangeEditor();
    return;
  }

  if (!store.apiKey) { assistantSay('追加指示の解釈にはClaude APIキーが必要です。右上の設定から入力してください。'); return; }
  const site = store.sites.find((s) => s.id === lp.siteId);
  if (!site) { assistantSay('対象サイトの設定が見つかりません。'); return; }

  userSayText(text);
  state.running = true;
  state.aborter = new AbortController();
  state.aborted = false;
  showAbort(true);
  const m = speak('指示を確認しています…');
  try {
    const r = await api('/api/instruct', {
      apiKey: store.apiKey,
      wpUrl: site.wpUrl,
      instruction: text,
      context: {
        title: lp.title,
        status: lp.status,
        slug: lp.slug,
        headings: lp.headings,
        images: lp.images.map((im, i) => ({ number: i + 1, name: im.name, alt: im.alt, anchor: im.anchor, eyecatch: im.eyecatch })),
      },
    });
    await executeInstruction(r, m, lp, site);
  } catch (e) {
    if (isAbortError(e)) m.fail(ABORT_MSG);
    else m.fail(`指示を処理できませんでした: ${e.message}`);
  } finally {
    // 再変換 (redo) に引き継いだ場合は run() 側が後始末する
    if (!state.runHandoff) {
      state.running = false;
      state.aborter = null;
      showAbort(false);
    }
    state.runHandoff = false;
  }
}

// 再変換系のアクションへ処理を引き継ぐ (実行フラグをrun側へ渡す)
function handoffToRun(lp) {
  state.runHandoff = true;
  state.running = false;
  state.aborter = null;
  run({ name: lp.name, content: lp.markdown }, { updateId: lp.postId, presetImages: lp.images });
}

async function executeInstruction(r, m, lp, site) {
  const creds = { wpUrl: site.wpUrl, username: site.wpUser, appPassword: site.wpPass, postId: lp.postId };
  const p = r.params || {};
  const reply = escapeHtml(r.reply || '対応しました。');

  switch (r.action) {
    case 'set_status': {
      if (p.status === 'publish' && !confirm('この記事を「公開」します。よろしいですか？')) {
        m.done('公開をキャンセルしました。');
        return;
      }
      const u = await api('/api/update-post', { ...creds, fields: { status: p.status } });
      lp.status = u.status;
      m.done(reply + (u.status === 'publish' ? ` <a href="${escapeHtml(u.link)}" target="_blank">公開ページを見る →</a>` : ''));
      return;
    }
    case 'set_slug': {
      const u = await api('/api/update-post', { ...creds, fields: { slug: p.slug } });
      lp.slug = u.slug;
      m.done(`${reply}<span class="sub">スラッグ: ${escapeHtml(u.slug)}</span>`);
      return;
    }
    case 'set_title': {
      await api('/api/update-post', { ...creds, fields: { title: p.title } });
      lp.title = p.title;
      m.done(reply);
      return;
    }
    case 'set_excerpt': {
      await api('/api/update-post', { ...creds, fields: { excerpt: p.excerpt } });
      lp.excerpt = p.excerpt;
      m.done(reply);
      return;
    }
    case 'set_category': {
      await api('/api/update-post', { ...creds, fields: { categories: [p.categoryId] } });
      m.done(reply);
      return;
    }
    case 'set_eyecatch': {
      const img = lp.images[p.imageNumber - 1];
      if (!img) { m.fail('その番号の画像が見つかりません。'); return; }
      lp.images.forEach((im, i) => { im.eyecatch = i === p.imageNumber - 1; });
      await republishWithImages(lp, site);
      m.done(reply);
      return;
    }
    case 'move_image': {
      const img = lp.images[p.imageNumber - 1];
      if (!img) { m.fail('その番号の画像が見つかりません。'); return; }
      img.anchor = p.anchor || 'lead';
      await republishWithImages(lp, site);
      m.done(reply);
      return;
    }
    case 'add_note_and_redo': {
      if (p.note) {
        site.note = (site.note ? site.note + '\n' : '') + p.note;
        saveStore();
      }
      m.done(`${reply}<span class="sub">サイトメモに追記: ${escapeHtml(p.note || '')} ─ 再変換して同じ記事を更新します</span>`);
      handoffToRun(lp);
      return;
    }
    case 'redo': {
      m.done(`${reply}<span class="sub">再変換して同じ記事を更新します</span>`);
      handoffToRun(lp);
      return;
    }
    default:
      m.done(escapeHtml(r.reply || 'その指示には対応していません。WordPressの編集画面でご対応ください。'));
  }
}

// 画像の配置・アイキャッチ変更を反映して同じ投稿を組み直す (再アップロードなし)
async function republishWithImages(lp, site) {
  const pub = await api('/api/publish', {
    wpUrl: site.wpUrl,
    username: site.wpUser,
    appPassword: site.wpPass,
    title: lp.title,
    content: lp.baseHtml,
    excerpt: lp.excerpt,
    status: lp.status,
    extraContent: lp.faqScript,
    images: lp.images,
    imgClass: lp.imgClass,
    updateId: lp.postId,
    eyecatchInBody: Boolean(lp.eyecatchInBody),
  });
  lp.images = pub.uploadedMedia || lp.images;
}

/* ---------- アップ前チェックのレポート ---------- */

// シート記入用のマーク: ◯ / × / 該当なし。
// 人の確認が必要なもの (warn) は空欄にしてメモだけ残す (「要確認」等の文字は書かない)
const SHEET_MARKS = { ok: '◯', err: '×', na: '該当なし', warn: '' };

function buildChecklistRows(pc, pub, opts = {}) {
  const rows = [];
  const row = (status, label, detail) => rows.push({ status, label, detail, mark: SHEET_MARKS[status] ?? '' });

  // リンク遷移
  {
    const L = pc.links;
    const errors = L.errors || [];
    const warns = L.warns || [];
    const unverified = L.unverified || [];
    if (L.total === 0) {
      row('ok', 'リンク遷移', '本文内にリンクはありません');
    } else if (errors.length > 0) {
      row('err', 'リンク遷移', errors.map((b) => `${b.href} ─ ${b.message}`).join(' ／ ') +
        (unverified.length ? ` ｜ 他に${unverified.length}件は手動チェック (下の一覧)` : ''));
    } else if (warns.length > 0 || unverified.length > 0) {
      const parts = [];
      if (L.okCount > 0) parts.push(`${L.okCount}件は正常`);
      for (const w of warns) parts.push(`${w.href} ─ ${w.message}`);
      if (unverified.length) parts.push(`${unverified.length}件は自動で確認できませんでした (下の一覧から手動チェック)`);
      row('warn', 'リンク遷移', parts.join(' ｜ '));
    } else {
      row('ok', 'リンク遷移', `${L.checked}件すべて正常に遷移します (末尾欠け・パラメータ重複・旧スラッグもなし)`);
    }
  }

  // JSリンク (bt系)
  if (pc.jsLinks && pc.jsLinks.ids.length > 0) {
    const J = pc.jsLinks;
    if (J.missing.length > 0) {
      row('err', 'JSリンク', `遷移先が未定義のボタンがあります (リンクミス): ${J.missing.join(', ')}`);
    } else if (!J.mapFound || J.unverifiedIds.length > 0 || J.errors.length > 0) {
      if (J.errors.length > 0) {
        row('err', 'JSリンク', J.errors.map((e) => `${e.id} ─ 遷移先が${e.message}`).join(' ／ '));
      } else if (!J.mapFound) {
        row('warn', 'JSリンク', `${J.ids.length}件のJSボタンは自動で確認できませんでした。手動でチェックしてください`);
      } else {
        row('warn', 'JSリンク', `${J.okCount}件は遷移OK ｜ ${J.unverifiedIds.join(', ')} は自動で確認できませんでした。手動でチェックしてください`);
      }
    } else {
      row('ok', 'JSリンク', `${J.ids.length}件すべて遷移先が定義済みで、遷移も確認しました`);
    }
  }

  // HTMLエラー
  if (pc.tagErrors.length === 0) row('ok', 'HTMLエラー', 'タグの対応に問題はありません');
  else row('err', 'HTMLエラー', pc.tagErrors.join(' ／ '));

  // 古い情報 (年表記)
  if (pc.oldYears.length === 0) row('ok', '古い年の表記', '過去の年の記載はありません');
  else row('warn', '古い年の表記', pc.oldYears.map((y) => `${y.year}年×${y.count}`).join('、') + ' ─ 最新情報か確認してください');

  // 画像 alt
  if (pc.imgCount === 0) row('ok', '画像のalt', '本文に画像なし (画像を手動挿入する際はaltを設定)');
  else if (pc.imgsNoAlt === 0) row('ok', '画像のalt', `${pc.imgCount}枚すべてにaltが設定されています`);
  else row('err', '画像のalt', `${pc.imgsNoAlt}枚の画像にaltがありません`);

  // strongタグ
  if (pc.usesStrong && !pc.refHasStrong) row('warn', 'strongタグ', '参考記事はstrongを使っていませんが、生成記事に含まれています (classでの装飾を推奨)');
  else row('ok', 'strongタグ', pc.usesStrong ? '参考記事と同様にstrongを使用' : '不使用');

  // class
  if (pc.unknownClasses.length === 0) row('ok', '使用class', '参考記事に存在するclassのみ使用しています');
  else row('warn', '使用class', `参考記事にないclass: ${pc.unknownClasses.join(', ')} ─ CSSが効かない可能性があります`);

  // 外部リンクの別窓
  if (pc.externalCount === 0) row('ok', '外部リンクの別窓', '外部リンクなし');
  else if (pc.externalNoBlank.length === 0) row('ok', '外部リンクの別窓', `外部リンク${pc.externalCount}件すべて target="_blank" 付き`);
  else row('warn', '外部リンクの別窓', `target="_blank" が無い外部リンクが${pc.externalNoBlank.length}件あります`);

  // スラッグ
  if (pub.slug && /^[\x21-\x7e]+$/.test(pub.slug)) row('ok', 'パーマリンク', `スラッグ: ${pub.slug}`);
  else row('warn', 'パーマリンク', `スラッグが日本語のままです (${pub.slug || '未設定'})。編集画面で半角英数字に変更してください`);

  // カテゴリー
  const cats = pub.categories || [];
  if (cats.length === 0 || (cats.length === 1 && cats[0] === 1)) row('warn', 'カテゴリー', '「未分類」のままです。編集画面で設定してください');
  else row('ok', 'カテゴリー', '設定済み');

  // アイキャッチ (未設定は×)
  if (!pub.featuredMedia) row('err', 'アイキャッチ', '未設定です。編集画面で設定してください');
  else row('ok', 'アイキャッチ', '設定済み');

  // 構造化データ (JSON-LDの中身まで検証)
  {
    const ld = pc.jsonLd || { blocks: 0, invalid: 0, faq: null };
    if (ld.blocks === 0) {
      if (pc.hasFaq) row('warn', '構造化データ', 'Q&A・よくある質問のコンテンツがありますが、構造化データが入っていません。挿入を確認してください');
      else row('na', '構造化データ', 'Q&Aコンテンツなし');
    } else if (ld.invalid > 0) {
      row('err', '構造化データ', `JSON-LDに構文エラーがあります (${ld.invalid}件)。検索エンジンに認識されません`);
    } else if (ld.faq) {
      const f = ld.faq;
      const problems = [];
      if (f.badShape > 0) problems.push(`形式不備${f.badShape}件 (Question/Answerの必須項目欠け)`);
      if (f.withHtml > 0) problems.push(`HTMLタグ混入${f.withHtml}件 (プレーンテキストのみ可)`);
      if (f.missingInBody > 0) problems.push(`本文に存在しない質問${f.missingInBody}件 (Googleのガイドライン違反のリスク)`);
      if (problems.length) row('err', '構造化データ', `FAQPage (Q&A ${f.questions}件): ` + problems.join(' ／ '));
      else row('ok', '構造化データ', `FAQPage (Q&A ${f.questions}件) ─ 構文OK・本文と一致・HTML混入なし${opts.faqInserted ? ' (自動挿入)' : ''}`);
    } else {
      row('ok', '構造化データ', `JSON-LD ${ld.blocks}件 ─ 構文OK`);
    }
  }

  // ディスクリプション (SEOメタ欄に書けていないときは◯にしない → 手動確認へ)
  if (opts.excerpt) {
    const len = opts.excerpt.length;
    if (!opts.seoName) {
      row('warn', 'ディスクリプション', `抜粋には保存済み (${len}文字) ─ SEOプラグインのメタ欄に書き込めなかったため、編集画面で手動設定してください`);
    } else if (len > 120) {
      row('warn', 'ディスクリプション', `${len}文字を${opts.seoName}のメタ欄と抜粋に設定 ─ 120文字以内が目安です`);
    } else {
      row('ok', 'ディスクリプション', `${len}文字を${opts.seoName}のメタ欄と抜粋に設定`);
    }
  } else {
    row('err', 'ディスクリプション', '原稿にディスクリプションが見つかりませんでした');
  }

  // タイトル
  if (opts.title) {
    const tl = opts.title.length;
    if (tl > 40) row('warn', 'タイトル', `${tl}文字 ─ 検索結果で省略される可能性があります (32文字前後が目安)`);
    else row('ok', 'タイトル', `${tl}文字`);
  }

  // 引用 (blockquote + cite)
  if (pc.quotes) {
    if (pc.quotes.count === 0) row('na', 'blockquoteタグ', '引用ブロックなし');
    else if (pc.quotes.withoutCite > 0) row('err', 'blockquoteタグ', `引用元 (cite) の無い引用ブロックが${pc.quotes.withoutCite}件あります`);
    else row('ok', 'blockquoteタグ', `引用${pc.quotes.count}件すべてにcite付きの引用元リンクがあります`);
  }

  // 目次
  row(pc.hasToc ? 'ok' : 'na', '目次', pc.hasToc ? '[toc] を挿入済み' : 'このサイトの定型に目次がないため対象外');

  // 注釈 (※) ─ サイトの流儀 (<sup>※</sup>) を学習していれば自動適用済み
  if (pc.kome) {
    if (pc.kome.total === 0) row('na', '注釈', '注釈 (※) なし');
    else if (pc.kome.inSup >= pc.kome.total) row('ok', '注釈', `※ ${pc.kome.total}件すべてをサイトの流儀どおり <sup>※</sup> で装飾済み`);
    else row('warn', '注釈', `本文に「※」が${pc.kome.total}件あります。装飾 (supやsmall) がサイトの流儀どおりか確認してください`);
  }

  // スラッグ末尾の「/」
  if (pc.trailingSlash === 'slash') row('ok', 'スラッグ', 'このサイトはURL末尾に「/」が自動で付く設定です (公開記事のURLで確認)');
  else if (pc.trailingSlash === 'noslash') row('ok', 'スラッグ', 'このサイトはURL末尾「/」なしの形式です (公開記事のURLで確認)');
  else if (pc.trailingSlash === 'querystyle') row('ok', 'スラッグ', 'このサイトのURLはパラメータ形式のため末尾「/」は不要です');
  else row('warn', 'スラッグ', 'URL末尾「/」の要否を確認できませんでした。公開時にURLを確認してください');

  // 広告リンク (パターン一致: 自ドメインのクッション含む) の nofollow / パラメータ
  {
    const A = pc.adLinks || { patternsConfigured: false, total: 0 };
    if (A.total === 0) {
      if (!A.patternsConfigured) {
        row('na', '広告リンクnofollow', '広告リンクなし (スラッグ入りパラメータで自動判定。クッションのパスを設定に登録するとさらに確実)');
        row('na', '広告リンクパラメータ', '広告リンクなし');
      } else {
        row('na', '広告リンクnofollow', '広告リンクなし');
        row('na', '広告リンクパラメータ', '広告リンクなし');
      }
    } else {
      // nofollow
      if (A.noNofollow.length === 0) row('ok', '広告リンクnofollow', `広告リンク${A.total}件すべてに nofollow 付き`);
      else row('err', '広告リンクnofollow', `nofollow の無い広告リンクが${A.noNofollow.length}件: ${A.noNofollow.join(' ／ ')}`);
      // パラメータ (スラッグ入り)
      const noParam = A.noQuery;
      const noSlug = (A.noSlug || []).filter((h) => !noParam.includes(h));
      if (noParam.length === 0 && noSlug.length === 0) {
        row('ok', '広告リンクパラメータ', `広告リンク${A.total}件すべてにスラッグ入りのパラメータ付き`);
      } else if (noParam.length > 0) {
        row('err', '広告リンクパラメータ',
          `パラメータの付け忘れが${noParam.length}件: ${noParam.join(' ／ ')}` +
          (noSlug.length ? ` ｜ スラッグが入っていないものが${noSlug.length}件: ${noSlug.join(' ／ ')}` : ''));
      } else {
        row('warn', '広告リンクパラメータ', `パラメータはあるがスラッグが入っていない広告リンクが${noSlug.length}件: ${noSlug.join(' ／ ')}`);
      }
    }
  }

  // JCB券種の指定リンク
  if (pc.hasJcb) row('warn', 'JCBリンク', '本文にJCB券種の記載があります。アフィリンクが各券種の指定リンクか確認してください');
  else row('na', 'JCBリンク', 'JCB券種の記載なし');

  // 使用キャプチャ
  if (opts.imagesCount > 0) row('warn', '使用キャプチャ', `画像${opts.imagesCount}枚 ─ 使用NGなキャプチャ (商標・タレント画像等) でないか目視確認してください`);
  else row('na', '使用キャプチャ', '画像なし');

  // PC・SP のレイアウト (目視)
  row('warn', 'PC・SP', 'プレビューを開き、PCとスマホ表示でレイアウト崩れがないか目視確認してください');

  // PRロゴ (広告リンクがある場合、サイトにPR表記があるか)
  {
    const hasAds = (pc.adLinks?.total || 0) > 0;
    if (!hasAds) row('na', 'PRロゴ', '広告リンクなし');
    else if (pc.hasPrLogo === true) row('ok', 'PRロゴ', 'サイト共通テンプレートにPR表記を確認しました');
    else row('warn', 'PRロゴ', '広告リンクがあります。PRロゴが表示されるかプレビューで確認してください');
  }

  // 前サイトの痕跡 (記事移行時の旧ドメイン)
  if (pc.prevSiteHosts && pc.prevSiteHosts.length) {
    row('err', '前サイトの痕跡', `別ドメインの wp-content を参照しています: ${pc.prevSiteHosts.join(', ')} ─ 画像・タグを差し替えてください`);
  } else {
    row('ok', '前サイトの痕跡', '他サイトのwp-content参照はありません');
  }

  return rows;
}

function renderChecklist(rows) {
  const warnCount = rows.filter((r) => r.status === 'warn').length;
  const errCount = rows.filter((r) => r.status === 'err').length;
  const summary = errCount ? `要修正 ${errCount}件・手動チェック ${warnCount}件があります。`
    : warnCount ? `自動チェックはOK。手動チェック ${warnCount}件があります。`
    : '自動チェックはすべてOKです。';

  const icons = { ok: '✓', warn: '!', err: '✕', na: '—' };
  return `アップ前チェックが完了しました。${escapeHtml(summary)}
    <div class="checklist">${rows.map((r) => `
      <div class="check-row">
        <span class="check-ic ${r.status}">${icons[r.status]}</span>
        <span class="check-label">${escapeHtml(r.label)}</span>
        <span class="check-detail">${escapeHtml(r.detail)}</span>
      </div>`).join('')}
    </div>
    <span class="sub">※レイアウト崩れ (PC/SP) と画像の内容確認は目視でお願いします。</span>`;
}

/* ---------- リンクの目視チェック ---------- */

function renderLinkReview(links, sheetUrl) {
  const content = assistantMsg(`
    <div class="say"><span class="em">${links.length}件</span> のリンクはbot対策で自動確認できませんでした。URLを開いて、手動でチェックしてください (◯か✕を付けると記録されます)。</div>
    <div class="linkreview">
      ${links.map((l, i) => `
      <div class="lr-row" data-i="${i}">
        <span class="lr-btns">
          <button class="lr-btn lr-ok" title="問題なし">◯</button>
          <button class="lr-btn lr-ng" title="リンク切れ・要修正">✕</button>
        </span>
        <a class="lr-url" href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.href)}</a>
      </div>`).join('')}
      <div class="lr-summary">0/${links.length} 確認済み</div>
    </div>`);

  const states = new Array(links.length).fill(null);
  const summaryEl = content.querySelector('.lr-summary');

  async function onAllDone() {
    const ng = links.filter((_, i) => states[i] === 'ng');
    const okCount = states.filter((s) => s === 'ok').length;
    if (ng.length === 0) {
      summaryEl.innerHTML = `<span class="lr-done-ok">✓ 全${okCount}件 問題なしを確認しました</span>`;
    } else {
      summaryEl.innerHTML = `<span class="lr-done-ng">✕ ${ng.length}件が要修正: ${ng.map((l) => escapeHtml(l.href)).join(' ／ ')}</span>`;
    }
    // チェックシートのリンク行を目視結果で更新
    if (sheetUrl && store.sheetGasUrl) {
      try {
        await api('/api/checksheet', {
          gasUrl: store.sheetGasUrl,
          gasToken: store.sheetGasToken || '',
          action: 'updateLinks',
          sheetUrl,
          linkStatus: ng.length ? '×' : '◯',
          linkDetail: ng.length
            ? `✕ ${ng.length}件: ${ng.map((l) => l.href).join(' ／ ')}`
            : `全${okCount}件 ◯ (自動+目視)`,
        });
        summaryEl.innerHTML += ' <span class="lr-sheet">─ チェックシートにも反映しました</span>';
      } catch (e) {
        summaryEl.innerHTML += ` <span class="lr-sheet">─ シート反映に失敗: ${escapeHtml(e.message)}</span>`;
      }
    }
  }

  content.querySelectorAll('.lr-row').forEach((rowEl) => {
    const i = Number(rowEl.dataset.i);
    const mark = (result) => {
      states[i] = result;
      rowEl.classList.remove('is-ok', 'is-ng');
      rowEl.classList.add(result === 'ok' ? 'is-ok' : 'is-ng');
      const done = states.filter((s) => s !== null).length;
      if (done < links.length) summaryEl.textContent = `${done}/${links.length} 確認済み`;
      else onAllDone();
    };
    rowEl.querySelector('.lr-ok').addEventListener('click', () => mark('ok'));
    rowEl.querySelector('.lr-ng').addEventListener('click', () => mark('ng'));
  });
}

/* ---------- 初期化 ---------- */

(async () => {
  await loadStore();
  renderSiteSelect();

  // 再読み込み後も直前の記事への追加指示を使えるようにする
  try {
    const lp = JSON.parse(localStorage.getItem(LASTPOST_KEY) || 'null');
    if (lp && lp.postId && !state.lastPost) {
      state.lastPost = lp;
      showInstructBar();
    }
  } catch (_) {}

  if (settingsMissing().length) {
    assistantSay('はじめに右上の歯車から、WordPressの接続情報と参考記事のURLを設定してください。サイトは複数登録でき、左上のメニューで切り替えられます。設定はサーバーに保存され、チーム全員で共有されます。', true);
  }
})();
