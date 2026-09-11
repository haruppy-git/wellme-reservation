/* =========================================================
   wellme 顧客管理画面
   データの置き場所は Google スプレッドシート（Apps Script 経由）
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => '￥' + Number(n).toLocaleString('ja-JP');

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const fmtDate = (s) => {
  if (!s) return '—';
  const [y, m, d] = s.split('-').map(Number);
  if (!y) return esc(s);
  return `${y}/${m}/${d}(${WEEK[new Date(y, m - 1, d).getDay()]})`;
};
const fmtDateTime = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—');

/* 画面をまたいで使う簡易キャッシュ */
const cache = { customers: null, reservations: null };

/* ---------- 共通パーツ ---------- */

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3600);
}

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
}
function closeModal() {
  $('#modal').hidden = true;
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-close')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

function loading(msg = '読み込み中…') {
  $('#view').innerHTML = `<p class="loading">${esc(msg)}</p>`;
}

function errorBox(e) {
  return `<p class="alert">${esc(e && e.message ? e.message : e)}</p>`;
}

function statusBadge(status) {
  return status === 'cancelled'
    ? '<span class="badge badge--no">キャンセル</span>'
    : '<span class="badge badge--ok">予約済み</span>';
}

/* ---------- ルーター ---------- */

const routes = [
  [/^\/?$/, () => go('/customers')],
  [/^\/customers$/, viewCustomers],
  [/^\/customers\/([A-Z0-9]+)$/, viewCustomerDetail],
  [/^\/reservations$/, viewReservations],
  [/^\/settings$/, viewSettings]
];

function go(path) {
  location.hash = '#' + path;
}

function router() {
  const path = location.hash.replace(/^#/, '') || '/';

  /* 接続先が未設定なら、まず設定画面へ誘導する */
  if (!SheetAPI.isConfigured() && path !== '/settings') return go('/settings');

  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      markNav(path);
      fn(...m.slice(1));
      window.scrollTo(0, 0);
      return;
    }
  }
  go('/customers');
}

function markNav(path) {
  $$('.gnav a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    a.classList.toggle('is-active', href.startsWith('#') && path.startsWith(href.slice(1)));
  });
}

window.addEventListener('hashchange', router);

/* =========================================================
   顧客一覧
   ========================================================= */

const listState = { q: '', sort: 'lastVisit' };

async function viewCustomers() {
  loading('顧客データを読み込み中…');
  try {
    cache.customers = await SheetAPI.call('listCustomers');
  } catch (e) {
    $('#view').innerHTML = `<h1 class="page-title">顧客一覧</h1>${errorBox(e)}
      <div class="actions"><a class="btn btn--sub" href="#/settings">設定を確認する</a></div>`;
    return;
  }

  $('#view').innerHTML = `
    <h1 class="page-title">顧客一覧</h1>
    <div class="toolbar">
      <input type="search" id="q" class="toolbar__search" placeholder="氏名・カナ・電話・メールで検索"
             value="${esc(listState.q)}">
      <select id="sort" class="toolbar__select">
        <option value="lastVisit">最終来店が新しい順</option>
        <option value="visitCount">来店回数が多い順</option>
        <option value="name">氏名順</option>
        <option value="createdAt">登録が新しい順</option>
      </select>
      <span class="toolbar__spacer"></span>
      <button class="btn btn--book" id="add">＋ 新規登録</button>
    </div>
    <div id="list"></div>`;

  $('#sort').value = listState.sort;
  $('#q').oninput = (e) => { listState.q = e.target.value; drawList(); };
  $('#sort').onchange = (e) => { listState.sort = e.target.value; drawList(); };
  $('#add').onclick = () => openCustomerForm(null);

  drawList();
}

function drawList() {
  const q = listState.q.trim().toLowerCase();
  let rows = (cache.customers || []).filter((c) =>
    !q || [c.name, c.kana, c.tel, c.email].some((v) => String(v || '').toLowerCase().includes(q))
  );

  const sorters = {
    lastVisit: (a, b) => String(b.lastVisit).localeCompare(String(a.lastVisit)),
    visitCount: (a, b) => Number(b.visitCount || 0) - Number(a.visitCount || 0),
    name: (a, b) => String(a.kana || a.name).localeCompare(String(b.kana || b.name), 'ja'),
    createdAt: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
  };
  rows = rows.sort(sorters[listState.sort]);

  if (!rows.length) {
    $('#list').innerHTML = `<p class="empty">${
      listState.q ? '該当する顧客がいません。' : 'まだ顧客が登録されていません。予約が入るか、「＋ 新規登録」で追加されます。'
    }</p>`;
    return;
  }

  $('#list').innerHTML = `
    <p class="count">${rows.length}件${listState.q ? `（全${cache.customers.length}件中）` : ''}</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>氏名</th><th>カナ</th><th>電話番号</th><th>メールアドレス</th>
          <th class="num">来店</th><th>最終来店</th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => `
            <tr data-id="${esc(c.customerId)}">
              <td class="strong">${esc(c.name || '（無名）')}</td>
              <td class="sub">${esc(c.kana)}</td>
              <td>${esc(c.tel)}</td>
              <td class="sub">${esc(c.email)}</td>
              <td class="num">${esc(c.visitCount || '0')}</td>
              <td>${c.lastVisit ? fmtDate(c.lastVisit) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  $$('#list tbody tr').forEach((tr) => {
    tr.onclick = () => go('/customers/' + tr.dataset.id);
  });
}

/* =========================================================
   顧客詳細
   ========================================================= */

async function viewCustomerDetail(customerId) {
  loading();
  let data;
  try {
    data = await SheetAPI.call('getCustomer', { customerId });
  } catch (e) {
    $('#view').innerHTML = errorBox(e) + '<div class="actions"><a class="btn btn--sub" href="#/customers">一覧に戻る</a></div>';
    return;
  }

  const c = data.customer;
  const rs = data.reservations || [];
  const active = rs.filter((r) => r.status !== 'cancelled');

  $('#view').innerHTML = `
    <p class="crumb"><a href="#/customers">← 顧客一覧に戻る</a></p>
    <h1 class="page-title">${esc(c.name || '（無名）')}</h1>
    <p class="lead">${esc(c.kana || '')}</p>

    <div class="stat-row">
      <div class="stat"><span class="stat__num">${active.length}</span><span class="stat__label">来店回数</span></div>
      <div class="stat"><span class="stat__num">${c.lastVisit ? fmtDate(c.lastVisit) : '—'}</span><span class="stat__label">最終来店</span></div>
      <div class="stat"><span class="stat__num">${fmtDateTime(c.createdAt).slice(0, 10) || '—'}</span><span class="stat__label">登録日</span></div>
    </div>

    <section class="panel">
      <h2 class="panel__title">基本情報</h2>
      <dl class="kv">
        <dt>電話番号</dt><dd>${esc(c.tel || '—')}</dd>
        <dt>メールアドレス</dt><dd>${esc(c.email || '—')}</dd>
        <dt>顧客ID</dt><dd class="sub">${esc(c.customerId)}</dd>
        <dt>カルテメモ</dt><dd>${c.memo ? esc(c.memo).replace(/\n/g, '<br>') : '—'}</dd>
      </dl>
      <div class="actions">
        <button class="btn btn--book" id="edit">情報を編集する</button>
        <button class="btn btn--danger" id="del">この顧客を削除</button>
      </div>
    </section>

    <section class="panel">
      <h2 class="panel__title">来店・予約履歴（${rs.length}件）</h2>
      ${rs.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>日付</th><th>時間</th><th>メニュー</th><th>オプション</th><th class="num">金額</th><th>状態</th></tr></thead>
            <tbody>
              ${rs.map((r) => `
                <tr class="${r.status === 'cancelled' ? 'is-cancelled' : ''}">
                  <td>${fmtDate(r.date)}</td>
                  <td>${esc(r.startTime)}〜${esc(r.endTime)}</td>
                  <td class="strong">${esc(r.menuName)}</td>
                  <td class="sub">${esc(r.options || '—')}</td>
                  <td class="num">${r.total ? yen(r.total) : '—'}</td>
                  <td>${statusBadge(r.status)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="empty">予約履歴はまだありません。</p>'}
    </section>`;

  $('#edit').onclick = () => openCustomerForm(c);
  $('#del').onclick = () => confirmDelete(c);
}

/* 顧客の登録・編集フォーム */
function openCustomerForm(c) {
  const isNew = !c;
  openModal(`
    <h2 class="modal__title">${isNew ? '顧客を新規登録' : '顧客情報の編集'}</h2>
    <label class="field"><span class="field__label">氏名 <em>必須</em></span>
      <input type="text" id="cf-name" value="${esc(c ? c.name : '')}" placeholder="秋田 花子"></label>
    <label class="field"><span class="field__label">氏名（カナ）</span>
      <input type="text" id="cf-kana" value="${esc(c ? c.kana : '')}" placeholder="アキタ ハナコ"></label>
    <label class="field"><span class="field__label">電話番号</span>
      <input type="tel" id="cf-tel" value="${esc(c ? c.tel : '')}" placeholder="018-000-0000"></label>
    <label class="field"><span class="field__label">メールアドレス</span>
      <input type="email" id="cf-mail" value="${esc(c ? c.email : '')}" placeholder="abcde@example.com"></label>
    <label class="field"><span class="field__label">カルテメモ</span>
      <textarea id="cf-memo" rows="4" placeholder="髪質・薬剤・要望など">${esc(c ? c.memo : '')}</textarea></label>
    <p class="alert" id="cf-alert" hidden></p>
    <div class="actions">
      <button class="btn btn--sub" data-close>やめる</button>
      <button class="btn btn--book" id="cf-save">保存する</button>
    </div>`);

  $('#cf-save').onclick = async () => {
    const payload = {
      customerId: c ? c.customerId : '',
      name: $('#cf-name').value.trim(),
      kana: $('#cf-kana').value.trim(),
      tel: $('#cf-tel').value.trim(),
      email: $('#cf-mail').value.trim(),
      memo: $('#cf-memo').value.trim()
    };
    if (!payload.name) return showModalError('氏名を入力してください。');
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      return showModalError('メールアドレスの形式が正しくありません。');
    }

    const btn = $('#cf-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const saved = await SheetAPI.call('saveCustomer', { customer: payload });
      cache.customers = null;
      closeModal();
      toast(isNew ? '顧客を登録しました。' : '顧客情報を更新しました。');
      if (isNew) go('/customers/' + saved.customerId);
      else router();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '保存する';
      showModalError(e.message);
    }
  };

  function showModalError(msg) {
    const a = $('#cf-alert');
    a.hidden = false;
    a.textContent = msg;
  }
}

function confirmDelete(c) {
  openModal(`
    <h2 class="modal__title">顧客を削除します</h2>
    <p><strong>${esc(c.name || '（無名）')}</strong> をスプレッドシートから削除します。<br>
       予約履歴の行は残りますが、この顧客とのひも付けは失われます。この操作は取り消せません。</p>
    <p class="alert" id="dl-alert" hidden></p>
    <div class="actions">
      <button class="btn btn--sub" data-close>やめる</button>
      <button class="btn btn--danger" id="dl-go">削除する</button>
    </div>`);

  $('#dl-go').onclick = async () => {
    const btn = $('#dl-go');
    btn.disabled = true;
    btn.textContent = '削除中…';
    try {
      await SheetAPI.call('deleteCustomer', { customerId: c.customerId });
      cache.customers = null;
      closeModal();
      toast('削除しました。');
      go('/customers');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '削除する';
      const a = $('#dl-alert');
      a.hidden = false;
      a.textContent = e.message;
    }
  };
}

/* =========================================================
   予約一覧
   ========================================================= */

const resState = { range: 'upcoming', q: '' };

async function viewReservations() {
  loading('予約データを読み込み中…');
  try {
    cache.reservations = await SheetAPI.call('listReservations', {});
  } catch (e) {
    $('#view').innerHTML = `<h1 class="page-title">予約一覧</h1>${errorBox(e)}`;
    return;
  }

  $('#view').innerHTML = `
    <h1 class="page-title">予約一覧</h1>
    <div class="toolbar">
      <div class="segmented" id="range">
        <button data-range="today" type="button">本日</button>
        <button data-range="upcoming" type="button">今後</button>
        <button data-range="past" type="button">過去</button>
        <button data-range="all" type="button">すべて</button>
      </div>
      <input type="search" id="rq" class="toolbar__search" placeholder="氏名・メニュー・予約番号で検索" value="${esc(resState.q)}">
    </div>
    <div id="rlist"></div>`;

  $('#rq').oninput = (e) => { resState.q = e.target.value; drawReservations(); };
  $$('#range button').forEach((b) => {
    b.onclick = () => { resState.range = b.dataset.range; drawReservations(); };
  });

  drawReservations();
}

function drawReservations() {
  const t = today();
  const q = resState.q.trim().toLowerCase();

  $$('#range button').forEach((b) => b.classList.toggle('is-active', b.dataset.range === resState.range));

  let rows = cache.reservations || [];
  if (resState.range === 'today') rows = rows.filter((r) => r.date === t);
  else if (resState.range === 'upcoming') rows = rows.filter((r) => r.date >= t);
  else if (resState.range === 'past') rows = rows.filter((r) => r.date < t);

  if (q) {
    rows = rows.filter((r) =>
      [r.name, r.kana, r.menuName, r.code, r.tel].some((v) => String(v || '').toLowerCase().includes(q))
    );
  }

  /* 今後の予約は日付の早い順、それ以外は新しい順が見やすい */
  rows = rows.slice().sort((a, b) => {
    const ka = a.date + a.startTime;
    const kb = b.date + b.startTime;
    return resState.range === 'past' || resState.range === 'all' ? (ka < kb ? 1 : -1) : (ka > kb ? 1 : -1);
  });

  if (!rows.length) {
    $('#rlist').innerHTML = '<p class="empty">該当する予約がありません。</p>';
    return;
  }

  $('#rlist').innerHTML = `
    <p class="count">${rows.length}件</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>日付</th><th>時間</th><th>お客様</th><th>メニュー</th>
          <th class="num">金額</th><th>状態</th><th>予約番号</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr class="${r.status === 'cancelled' ? 'is-cancelled' : ''}" data-id="${esc(r.customerId)}">
              <td>${fmtDate(r.date)}</td>
              <td>${esc(r.startTime)}〜${esc(r.endTime)}</td>
              <td class="strong">${esc(r.name || '—')}</td>
              <td>${esc(r.menuName)}${r.options ? `<span class="sub"><br>+ ${esc(r.options)}</span>` : ''}</td>
              <td class="num">${r.total ? yen(r.total) : '—'}</td>
              <td>${statusBadge(r.status)}</td>
              <td class="sub">${esc(r.code)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  $$('#rlist tbody tr').forEach((tr) => {
    if (!tr.dataset.id) return;
    tr.onclick = () => go('/customers/' + tr.dataset.id);
  });
}

/* =========================================================
   設定（接続先URL・未送信データ）
   ========================================================= */

function viewSettings() {
  const pending = SheetAPI.queueLength();

  $('#view').innerHTML = `
    <h1 class="page-title">設定</h1>

    <section class="panel">
      <h2 class="panel__title">スプレッドシートの接続先</h2>
      <p class="lead">Apps Script を「ウェブアプリ」としてデプロイして得た URL を貼り付けてください。
        手順は <code>gas/SETUP.md</code> に書いてあります。</p>
      <label class="field"><span class="field__label">ウェブアプリの URL</span>
        <input type="url" id="gas-url" value="${esc(SheetAPI.getUrl())}"
               placeholder="https://script.google.com/macros/s/.../exec"></label>
      <p class="alert" id="s-alert" hidden></p>
      <p class="notice" id="s-ok" hidden></p>
      <div class="actions">
        <button class="btn btn--book" id="s-save">保存する</button>
        <button class="btn btn--sub" id="s-test">接続テスト</button>
      </div>
    </section>

    <section class="panel">
      <h2 class="panel__title">未送信データ</h2>
      <p>予約サイト側で発生したが、まだスプレッドシートに送れていないデータ：
        <strong id="q-count">${pending}</strong> 件</p>
      <p class="note">接続先が未設定のあいだやオフライン中の予約は、ここに溜まって後から送信されます。</p>
      <div class="actions">
        <button class="btn btn--sub" id="q-flush" ${pending ? '' : 'disabled'}>今すぐ送信する</button>
      </div>
    </section>

    <section class="panel panel--danger">
      <h2 class="panel__title">デモデータの初期化</h2>
      <p>動作確認で入力したデータを全部消して、まっさらな状態に戻します。</p>
      <ul class="bullets">
        <li><strong>消えるもの</strong>：スプレッドシートの顧客・予約・キャンセル待ちの全行、
          ブラウザに保存された予約・会員・ログイン状態・未送信データ</li>
        <li><strong>残るもの</strong>：接続先URL、シートの見出し行、メニューや営業時間などの設定</li>
      </ul>
      <p class="note">スプレッドシートの行は完全に削除されます。この操作は取り消せません。</p>
      <div class="actions">
        <button class="btn btn--danger" id="reset">すべてのデータを消して初期化する</button>
      </div>
    </section>

    <section class="panel">
      <h2 class="panel__title">セットアップ手順</h2>
      <ol class="steps-list">
        <li>Google スプレッドシートを新規作成する</li>
        <li><strong>拡張機能 → Apps Script</strong> を開き、<code>gas/Code.gs</code> の中身を貼り付けて保存</li>
        <li><strong>デプロイ → 新しいデプロイ → ウェブアプリ</strong>。「実行するユーザー：自分」「アクセスできるユーザー：<strong>全員</strong>」でデプロイ</li>
        <li>表示された URL を上の欄に貼って保存 → 接続テスト</li>
      </ol>
      <p class="notice">「アクセスできるユーザー」が「全員」でないと、ログイン画面が返ってきて接続に失敗します。<br>
        URL を知っていれば誰でも読み書きできるため、実際の顧客情報を入れる場合は URL を共有しないでください。</p>
    </section>`;

  $('#s-save').onclick = () => {
    const url = $('#gas-url').value.trim();
    if (url && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
      return setAlert('URL の形式が違うようです。末尾が /exec のウェブアプリ URL を貼り付けてください。');
    }
    SheetAPI.setUrl(url);
    setAlert(null);
    toast('保存しました。');
    if (url) setOk('保存しました。「接続テスト」で疎通を確認してください。');
  };

  $('#s-test').onclick = async () => {
    const btn = $('#s-test');
    setAlert(null);
    setOk(null);
    btn.disabled = true;
    btn.textContent = '確認中…';
    try {
      SheetAPI.setUrl($('#gas-url').value.trim());
      const info = await SheetAPI.call('ping');
      setOk(`接続できました。スプレッドシート「${esc(info.sheetName)}」（サーバー時刻 ${esc(info.time)}）`);
      const res = await SheetAPI.flush();
      if (res.sent) {
        $('#q-count').textContent = res.left;
        toast(`未送信だった${res.sent}件を送信しました。`);
      }
    } catch (e) {
      setAlert(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '接続テスト';
    }
  };

  $('#q-flush').onclick = async () => {
    const btn = $('#q-flush');
    btn.disabled = true;
    btn.textContent = '送信中…';
    const res = await SheetAPI.flush();
    $('#q-count').textContent = res.left;
    btn.textContent = '今すぐ送信する';
    btn.disabled = res.left === 0;
    toast(res.left ? `${res.sent}件送信、${res.left}件が残っています。` : `${res.sent}件を送信しました。`);
  };

  $('#reset').onclick = openResetDialog;

  function setAlert(msg) {
    const a = $('#s-alert');
    a.hidden = !msg;
    if (msg) a.textContent = msg;
  }
  function setOk(msg) {
    const el = $('#s-ok');
    el.hidden = !msg;
    if (msg) el.innerHTML = msg;
  }
}

/* デモデータの初期化。接続先URLだけ残して、シートとブラウザの両方を空にする */
function openResetDialog() {
  openModal(`
    <h2 class="modal__title">すべてのデータを消します</h2>
    <p>スプレッドシートの <strong>customers / reservations / waitlist</strong> の全行と、
       ブラウザに保存された予約・会員・未送信データを削除します。<br>
       接続先URLは残るので、そのまま使い続けられます。</p>
    <p class="notice">この操作は取り消せません。実行するには下の欄に <strong>RESET</strong> と入力してください。</p>
    <label class="field"><span class="field__label">確認</span>
      <input type="text" id="rs-word" placeholder="RESET" autocomplete="off"></label>
    <p class="alert" id="rs-alert" hidden></p>
    <div class="actions">
      <button class="btn btn--sub" data-close>やめる</button>
      <button class="btn btn--danger" id="rs-go">初期化する</button>
    </div>`);

  $('#rs-go').onclick = async () => {
    const word = $('#rs-word').value.trim();
    if (word !== 'RESET') {
      const a = $('#rs-alert');
      a.hidden = false;
      a.textContent = 'RESET と入力してください。';
      return;
    }

    const btn = $('#rs-go');
    btn.disabled = true;
    btn.textContent = '初期化中…';
    try {
      const cleared = await SheetAPI.call('resetData', { confirm: 'RESET' });
      clearLocalData();
      cache.customers = null;
      cache.reservations = null;
      closeModal();
      toast(`初期化しました（顧客${cleared.customers ?? 0}件・予約${cleared.reservations ?? 0}件・キャンセル待ち${cleared.waitlist ?? 0}件を削除）`);
      go('/customers');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '初期化する';
      const a = $('#rs-alert');
      a.hidden = false;
      a.textContent = e.message;
    }
  };
}

/* ブラウザ側のデモデータを消す。接続先URLは残す */
function clearLocalData() {
  localStorage.removeItem('wellme.v1');        // 予約・会員・キャンセル待ち・ログイン状態
  localStorage.removeItem('wellme.syncQueue'); // 未送信データ
  sessionStorage.removeItem('wellme.v1.draft');
}

/* ---------- 起動 ---------- */

router();
SheetAPI.flush();
