/* =========================================================
   wellme 予約アプリ
   画面遷移：メニュー → 日程・時間・オプション → 会員/ゲスト
             → 連絡先入力 → 確認 → 完了
   ========================================================= */

/* ---------- 汎用ユーティリティ ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => '￥' + Number(n).toLocaleString('ja-JP');

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fmtMin = (min) =>
  String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

const ymd = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const fmtDate = (s) => {
  const d = parseYmd(s);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
};
const atMinutes = (dateStr, min) => {
  const d = parseYmd(dateStr);
  d.setMinutes(min);
  return d;
};
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const menuById = (id) => MENUS.find((m) => m.id === id);
const optionById = (id) => OPTIONS.find((o) => o.id === id);

/* ---------- 保存領域（localStorage / sessionStorage） ---------- */

const KEY = 'wellme.v1';

const blankState = () => ({ reservations: [], members: [], waitlist: [], session: null });

let state = load();

function load() {
  try {
    return Object.assign(blankState(), JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch (e) {
    return blankState();
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

/* 予約手続き中の一時データ */
let draft = loadDraft();

function loadDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY + '.draft') || 'null') || null;
  } catch (e) {
    return null;
  }
}
function saveDraft() {
  sessionStorage.setItem(KEY + '.draft', JSON.stringify(draft));
}
function clearDraft() {
  draft = null;
  sessionStorage.removeItem(KEY + '.draft');
}

/* ---------- 既存予約のダミーデータ ----------
   日付から決まる擬似乱数で生成するので、リロードしても空き状況は変わらない。 */

const seedCache = {};

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedBookings(dateStr) {
  if (seedCache[dateStr]) return seedCache[dateStr];
  const h = SALON.hours[parseYmd(dateStr).getDay()];
  if (!h) return (seedCache[dateStr] = []);

  const rnd = mulberry32(hashStr(dateStr));
  const open = toMin(h.open);
  const close = toMin(h.close);
  const list = [];
  const durations = [60, 90, 120, 150, 180];

  /* 1割ほどは終日満席の日をつくる（全席を営業時間いっぱいまで埋める） */
  if (rnd() < 0.12) {
    for (let seat = 0; seat < SALON.capacity; seat++) {
      let t = open;
      while (t < close) {
        const dur = Math.min(durations[Math.floor(rnd() * durations.length)], close - t);
        list.push({ start: t, end: t + dur });
        t += dur;
      }
    }
    return (seedCache[dateStr] = list);
  }

  const count = 2 + Math.floor(rnd() * 6);
  for (let i = 0; i < count; i++) {
    const dur = durations[Math.floor(rnd() * durations.length)];
    const room = Math.floor((close - open - dur) / SALON.slotStep) + 1;
    if (room <= 0) continue;
    const s = open + Math.floor(rnd() * room) * SALON.slotStep;
    const e = s + dur;
    if (concurrentIn(list, s, e) < SALON.capacity) list.push({ start: s, end: e });
  }
  return (seedCache[dateStr] = list);
}

function concurrentIn(bookings, s, e) {
  let max = 0;
  for (let t = s; t < e; t += 10) {
    let c = 0;
    for (const b of bookings) if (b.start <= t && t < b.end) c++;
    if (c > max) max = c;
  }
  return max;
}

/* その日の予約（ダミー＋利用者が入れた予約） */
function bookingsOn(dateStr, ignoreCode) {
  const mine = state.reservations
    .filter((r) => r.date === dateStr && r.status === 'reserved' && r.code !== ignoreCode)
    .map((r) => ({ start: r.start, end: r.end }));
  return seedBookings(dateStr).concat(mine);
}

/* ---------- 空き状況の判定エンジン ---------- */

function acceptUntil() {
  const d = startOfToday();
  d.setMonth(d.getMonth() + RULES.acceptMonths);
  return d;                                   // 受付開始＝3ヶ月前 → 予約できるのは今日〜3ヶ月先
}

/* 予約受付締切（開始時刻の12時間前）を過ぎているか */
function isPastDeadline(dateStr, startMin) {
  return atMinutes(dateStr, startMin).getTime() - Date.now() < RULES.deadlineHours * 3600 * 1000;
}

/* キャンセル締切（前日23:59）を過ぎているか */
function isPastCancelLimit(dateStr) {
  const d = parseYmd(dateStr);
  d.setDate(d.getDate() - RULES.cancelDaysBefore);
  d.setHours(23, 59, 59, 999);
  return Date.now() > d.getTime();
}

function totalMinutes(menu, optionIds) {
  return menu.min + optionIds.reduce((s, id) => s + optionById(id).addMin, 0);
}

/* 指定日の時間枠一覧 */
function buildSlots(dateStr, duration, ignoreCode) {
  const h = SALON.hours[parseYmd(dateStr).getDay()];
  if (!h) return [];
  const open = toMin(h.open);
  const close = toMin(h.close);
  const books = bookingsOn(dateStr, ignoreCode);
  const slots = [];

  for (let t = open; t + duration <= close; t += SALON.slotStep) {
    const used = concurrentIn(books, t, t + duration);
    const left = SALON.capacity - used;
    const past = isPastDeadline(dateStr, t);
    slots.push({
      start: t,
      end: t + duration,
      left: Math.max(0, left),
      past,
      open: left > 0 && !past
    });
  }
  return slots;
}

/* カレンダー1日ぶんの状態： closed / out / full / open */
function dateStatus(dateStr, duration) {
  const d = parseYmd(dateStr);
  if (!SALON.hours[d.getDay()]) return 'closed';
  if (d < startOfToday() || d > acceptUntil()) return 'out';

  const slots = buildSlots(dateStr, duration);
  if (!slots.length) return 'out';
  if (slots.every((s) => s.past)) return 'out';
  return slots.some((s) => s.open) ? 'open' : 'full';
}

/* ---------- スプレッドシートへの記録 ----------
   顧客管理アプリ（admin.html）で使うデータを送る。
   接続先が未設定でも通信に失敗しても予約自体は成立し、送れなかったぶんは
   SheetAPI 側のキューに残って次回まとめて送信される。 */

function syncReservation(r) {
  const menu = menuById(r.menuId);
  SheetAPI.sync('saveReservation', {
    reservation: {
      code: r.code,
      date: r.date,
      startTime: fmtMin(r.start),
      endTime: fmtMin(r.end),
      menuName: menu ? menu.name : '',
      options: r.options.map((id) => optionById(id).name).join('、'),
      total: r.total,
      status: r.status,
      name: r.name, kana: r.kana, email: r.email, tel: r.tel, memo: r.memo,
      createdAt: new Date(r.createdAt).toISOString().slice(0, 19)
    }
  });
}

/* 会員登録した人は、まだ予約が無くても顧客として登録する */
function syncMember(m) {
  m.syncedAt = Date.now();
  save();
  SheetAPI.sync('upsertCustomer', {
    customer: { name: m.name, kana: m.kana, email: m.email, tel: m.tel }
  });
}

/* 連携を入れる前に登録された会員を、あとからまとめて送る */
function backfillMembers() {
  state.members.filter((m) => !m.syncedAt).forEach(syncMember);
}

/* ---------- 画面共通パーツ ---------- */

function renderShopInfo() {
  const rows = [1, 2, 3, 4, 5, 6, 0].map((dow) => {
    const h = SALON.hours[dow];
    return `<tr><th>${WEEK[dow]}</th><td>${h ? `${h.open} 〜 ${h.close}` : '<span class="closed">定休日</span>'}</td></tr>`;
  });
  $('#hours-table').innerHTML = rows.join('');

  $('#rules-list').innerHTML = `
    <dt>予約受付開始</dt><dd>${RULES.labels.accept}</dd>
    <dt>予約受付締切</dt><dd>${RULES.labels.deadline}</dd>
    <dt>キャンセル締切</dt><dd>${RULES.labels.cancel}</dd>`;
}

function renderNav() {
  const a = $('#nav-account');
  a.textContent = state.session ? 'マイページ' : 'ログイン';
}

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

function stepBar(current) {
  const steps = ['日時を選ぶ', '連絡先を入力', '内容の確認', '予約完了'];
  return `<ol class="steps">${steps
    .map((s, i) => `<li class="${i + 1 === current ? 'is-current' : i + 1 < current ? 'is-done' : ''}">
        <span class="steps__num">${i + 1}</span>${s}</li>`)
    .join('')}</ol>`;
}

function priceLabel(menu) {
  return menu.price == null
    ? '<span class="price price--ask">カウンセリング後にお見積り</span>'
    : `<span class="price">${yen(menu.price)}</span>`;
}

/* ---------- ルーター ---------- */

const routes = [
  [/^\/?$/, viewMenus],
  [/^\/reserve\/(m\d+)$/, viewReserve],
  [/^\/auth$/, viewAuth],
  [/^\/form$/, viewForm],
  [/^\/confirm$/, viewConfirm],
  [/^\/done\/(R[0-9A-Z]+)$/, viewDone],
  [/^\/lookup$/, viewLookup],
  [/^\/account$/, viewAccount],
  [/^\/about$/, viewAbout]
];

function go(path) {
  location.hash = '#' + path;
}

function router() {
  const path = location.hash.replace(/^#/, '') || '/';
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      renderNav();
      $('#view').innerHTML = '';
      fn(...m.slice(1));
      window.scrollTo(0, 0);
      return;
    }
  }
  go('/');
}

window.addEventListener('hashchange', router);

/* =========================================================
   1. メニュー一覧
   ========================================================= */

function viewMenus() {
  const cards = MENUS.map(
    (m) => `
    <li class="menu-card">
      <div class="menu-card__body">
        <h3 class="menu-card__name">${esc(m.name)}</h3>
        <p class="menu-card__meta">${priceLabel(m)}<span class="dur">${m.min}分</span></p>
        ${m.note ? `<p class="menu-card__note">${esc(m.note)}</p>` : ''}
      </div>
      <a class="btn btn--book" href="#/reserve/${m.id}">予約する</a>
    </li>`
  ).join('');

  $('#view').innerHTML = `
    <h1 class="page-title">メニューを選択してください</h1>
    <p class="lead">ご希望のメニューの「予約する」から、日時をお選びいただけます。表示はすべて税込金額です。</p>
    <ul class="menu-list">${cards}</ul>`;
}

/* =========================================================
   2. 日程・時間・オプション選択
   ========================================================= */

function viewReserve(menuId) {
  const menu = menuById(menuId);
  if (!menu) return go('/');

  /* 別メニューを選び直したら選択状態をリセット */
  if (!draft || draft.menuId !== menuId) {
    draft = { menuId, date: null, start: null, options: [], contact: null };
    saveDraft();
  }

  const today = new Date();
  let cursor = draft.date
    ? new Date(parseYmd(draft.date).getFullYear(), parseYmd(draft.date).getMonth(), 1)
    : new Date(today.getFullYear(), today.getMonth(), 1);

  $('#view').innerHTML = `
    ${stepBar(1)}
    <p class="crumb"><a href="#/">← メニュー一覧に戻る</a></p>
    <h1 class="page-title">${esc(menu.name)}</h1>
    <p class="menu-card__meta">${priceLabel(menu)}<span class="dur" id="dur-view">${menu.min}分</span></p>
    ${menu.note ? `<p class="notice">${esc(menu.note)}</p>` : ''}

    <section class="panel">
      <h2 class="panel__title">日程選択</h2>
      <div id="calendar"></div>
      <ul class="legend">
        <li><i class="mk mk--ok">○</i>空きあり</li>
        <li><i class="mk mk--few">△</i>残りわずか</li>
        <li><i class="mk mk--no">×</i>満席（キャンセル待ち可）</li>
        <li><i class="mk mk--off">－</i>受付対象外・定休日</li>
      </ul>
    </section>

    <section class="panel" id="time-panel" hidden>
      <h2 class="panel__title">時間選択</h2>
      <p class="panel__sub" id="time-caption"></p>
      <ul class="timelist" id="timelist"></ul>
    </section>

    <section class="panel" id="option-panel" hidden>
      <h2 class="panel__title">オプション</h2>
      <ul class="optionlist">
        ${OPTIONS.map(
          (o) => `
          <li class="optionlist__item">
            <label class="optioncheck">
              <input type="checkbox" data-option="${o.id}">
              <span class="optioncheck__box" aria-hidden="true"></span>
              <span class="optioncheck__body">
                <span class="optionlist__name">${esc(o.name)}</span>
                <span class="optionlist__price">${yen(o.price)} ／ 施術時間 +${o.addMin}分</span>
              </span>
            </label>
          </li>`
        ).join('')}
      </ul>
      <p class="note">※すべて税込金額です。オプションを追加すると施術時間が延びるため、選択できる時間枠が変わります。</p>
    </section>

    <div class="sticky-bar" id="sticky" hidden>
      <div class="sticky-bar__info" id="sticky-info"></div>
      <button class="btn btn--main" id="go-next">予約を進める</button>
    </div>
    <p class="alert" id="reserve-alert" hidden></p>`;

  drawCalendar();
  if (draft.date) drawTimes();

  /* --- カレンダー描画 --- */
  function drawCalendar() {
    const dur = totalMinutes(menu, draft.options);
    const y = cursor.getFullYear();
    const mo = cursor.getMonth();
    const first = new Date(y, mo, 1);
    const days = new Date(y, mo + 1, 0).getDate();

    const limit = acceptUntil();
    const prevOk = new Date(y, mo, 1) > new Date(today.getFullYear(), today.getMonth(), 1);
    const nextOk = new Date(y, mo + 1, 1) <= limit;

    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push('<td></td>');

    for (let d = 1; d <= days; d++) {
      const ds = ymd(new Date(y, mo, d));
      const st = dateStatus(ds, dur);
      const mark = { open: '○', full: '×', closed: '－', out: '－' }[st];
      const cls = { open: 'is-open', full: 'is-full', closed: 'is-off', out: 'is-off' }[st];
      const selected = draft.date === ds ? ' is-selected' : '';
      const clickable = st === 'open' || st === 'full';
      cells.push(`<td>
        <button type="button" class="cal__cell ${cls}${selected}" data-date="${ds}" data-status="${st}" ${clickable ? '' : 'disabled'}>
          <span class="cal__num">${d}</span><span class="cal__mark">${mark}</span>
        </button></td>`);
    }
    while (cells.length % 7) cells.push('<td></td>');
    let rows = '';
    for (let i = 0; i < cells.length; i += 7) rows += '<tr>' + cells.slice(i, i + 7).join('') + '</tr>';

    $('#calendar').innerHTML = `
      <div class="cal__head">
        <button type="button" class="cal__nav" id="prev-mo" ${prevOk ? '' : 'disabled'}>‹ 前月</button>
        <span class="cal__title">${y}年${mo + 1}月</span>
        <button type="button" class="cal__nav" id="next-mo" ${nextOk ? '' : 'disabled'}>翌月 ›</button>
      </div>
      <table class="cal">
        <thead><tr>${WEEK.map((w, i) => `<th class="dow-${i}">${w}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    $('#prev-mo').onclick = () => { cursor = new Date(y, mo - 1, 1); drawCalendar(); };
    $('#next-mo').onclick = () => { cursor = new Date(y, mo + 1, 1); drawCalendar(); };

    $$('#calendar .cal__cell').forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.status === 'full') return openWaitlist(menu, btn.dataset.date);
        draft.date = btn.dataset.date;
        draft.start = null;
        saveDraft();
        drawCalendar();
        drawTimes();
      };
    });
  }

  /* --- 時間枠描画 --- */
  function drawTimes() {
    const dur = totalMinutes(menu, draft.options);
    const slots = buildSlots(draft.date, dur);
    const h = SALON.hours[parseYmd(draft.date).getDay()];

    $('#time-panel').hidden = false;
    $('#option-panel').hidden = false;
    $('#dur-view').textContent = dur + '分';
    $('#time-caption').textContent =
      `${fmtDate(draft.date)}　営業時間 ${h.open}〜${h.close}　／　施術時間 ${dur}分`;

    if (!slots.length) {
      $('#timelist').innerHTML = '<li class="timelist__empty">この日は施術時間が営業時間に収まらないため、予約できません。</li>';
    } else {
      $('#timelist').innerHTML = slots.map((s) => {
        const mark = !s.open ? '×' : s.left === 1 ? '△' : '○';
        const cls = !s.open ? 'is-full' : s.left === 1 ? 'is-few' : 'is-ok';
        const sel = draft.start === s.start ? ' is-selected' : '';
        const rest = s.open ? `残${s.left}` : s.past ? '受付終了' : '満席';
        return `<li>
          <button type="button" class="slot ${cls}${sel}" data-start="${s.start}" ${s.open ? '' : 'disabled'}>
            <span class="slot__time">${fmtMin(s.start)}</span>
            <span class="slot__mark">${mark}</span>
            <span class="slot__rest">${rest}</span>
          </button></li>`;
      }).join('');
    }

    $$('#timelist .slot').forEach((btn) => {
      btn.onclick = () => {
        draft.start = Number(btn.dataset.start);
        saveDraft();
        drawTimes();
      };
    });

    OPTIONS.forEach((o) => {
      const box = $(`[data-option="${o.id}"]`);
      box.checked = draft.options.includes(o.id);
      box.onchange = () => {
        draft.options = OPTIONS.filter((op) => $(`[data-option="${op.id}"]`).checked).map((op) => op.id);
        /* 施術時間が変わるので、選択中の枠がまだ取れるか検証し直す */
        const newDur = totalMinutes(menu, draft.options);
        const still = buildSlots(draft.date, newDur).find((s) => s.start === draft.start && s.open);
        if (draft.start !== null && !still) {
          draft.start = null;
          showAlert('オプション追加で施術時間が延びたため、選択していた時間は確保できません。時間を選び直してください。');
        } else {
          showAlert(null);
        }
        saveDraft();
        drawCalendar();
        drawTimes();
      };
    });

    updateSticky();
  }

  function updateSticky() {
    const dur = totalMinutes(menu, draft.options);
    const bar = $('#sticky');
    if (draft.start == null) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const opts = draft.options.map((id) => optionById(id).name).join('、');
    $('#sticky-info').innerHTML = `
      <strong>${esc(menu.name)}</strong>
      <span>${fmtDate(draft.date)} ${fmtMin(draft.start)}〜${fmtMin(draft.start + dur)}</span>
      ${opts ? `<span class="sticky-bar__opt">オプション：${esc(opts)}</span>` : ''}`;
    $('#go-next').onclick = () => {
      if (isPastDeadline(draft.date, draft.start)) {
        return showAlert(`予約受付は開始時刻の${RULES.deadlineHours}時間前で締め切ります。別の日時をお選びください。`);
      }
      go(state.session ? '/form' : '/auth');
    };
  }

  function showAlert(msg) {
    const el = $('#reserve-alert');
    el.hidden = !msg;
    if (msg) el.textContent = msg;
  }
}

/* キャンセル待ち登録 */
function openWaitlist(menu, dateStr) {
  openModal(`
    <h2 class="modal__title">キャンセル待ち登録</h2>
    <p>${esc(menu.name)}／${fmtDate(dateStr)}<br>空きが出た際にメールでお知らせします。</p>
    <label class="field">
      <span class="field__label">メールアドレス</span>
      <input type="email" id="wl-mail" placeholder="abcde@example.com" value="${esc(state.session ? state.session.email : '')}">
    </label>
    <p class="alert" id="wl-alert" hidden></p>
    <button class="btn btn--main" id="wl-submit">キャンセル待ちを申し込む</button>`);

  $('#wl-submit').onclick = () => {
    const mail = $('#wl-mail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      const a = $('#wl-alert');
      a.hidden = false;
      a.textContent = 'メールアドレスの形式が正しくありません。';
      return;
    }
    state.waitlist.push({ menuId: menu.id, date: dateStr, email: mail, createdAt: Date.now() });
    save();
    SheetAPI.sync('saveWaitlist', { entry: { date: dateStr, menuName: menu.name, email: mail } });
    closeModal();
    toast('キャンセル待ちを受け付けました。空きが出たらご連絡します。');
  };
}

/* =========================================================
   3. 会員ログイン／ゲスト分岐
   ========================================================= */

function viewAuth() {
  if (!draft || draft.start == null) return go('/');

  $('#view').innerHTML = `
    ${stepBar(2)}
    <h1 class="page-title">お客様情報の入力方法</h1>
    <div class="split">
      <section class="panel">
        <h2 class="panel__title">会員の方</h2>
        <label class="field"><span class="field__label">メールアドレス</span><input type="email" id="li-mail"></label>
        <label class="field"><span class="field__label">パスワード</span><input type="password" id="li-pass"></label>
        <p class="alert" id="li-alert" hidden></p>
        <button class="btn btn--main" id="li-submit">会員ログイン</button>
        <p class="note"><a href="#/account">新規会員登録はこちら</a></p>
      </section>
      <section class="panel">
        <h2 class="panel__title">会員以外の方</h2>
        <p>会員登録なしでご予約いただけます。</p>
        <button class="btn btn--sub" id="guest">連絡先を直接入力する</button>
        <p class="note">会員登録すると次回以降の入力が省け、予約履歴の確認・キャンセルがマイページから行えます。</p>
      </section>
    </div>
    <p class="crumb"><a href="#/reserve/${draft.menuId}">← 日時の選択に戻る</a></p>`;

  $('#guest').onclick = () => go('/form');
  $('#li-submit').onclick = () => {
    const mail = $('#li-mail').value.trim();
    const pass = $('#li-pass').value;
    const m = state.members.find((x) => x.email === mail && x.password === pass);
    if (!m) {
      const a = $('#li-alert');
      a.hidden = false;
      a.textContent = 'メールアドレスまたはパスワードが違います。';
      return;
    }
    state.session = { email: m.email };
    save();
    go('/form');
  };
}

/* =========================================================
   4. 連絡先入力
   ========================================================= */

function viewForm() {
  if (!draft || draft.start == null) return go('/');
  const menu = menuById(draft.menuId);
  const member = state.session ? state.members.find((m) => m.email === state.session.email) : null;
  const c = draft.contact || member || {};

  $('#view').innerHTML = `
    ${stepBar(2)}
    <h1 class="page-title">連絡先の入力</h1>
    ${summaryBox(menu)}
    <section class="panel">
      <label class="field"><span class="field__label">氏名 <em>必須</em></span>
        <input type="text" id="f-name" value="${esc(c.name || '')}" placeholder="秋田 花子"></label>
      <label class="field"><span class="field__label">氏名（カナ） <em>必須</em></span>
        <input type="text" id="f-kana" value="${esc(c.kana || '')}" placeholder="アキタ ハナコ"></label>
      <label class="field"><span class="field__label">メールアドレス <em>必須</em></span>
        <input type="email" id="f-mail" value="${esc(c.email || '')}" placeholder="abcde@example.com">
        <span class="field__help">※携帯キャリアのアドレスをご利用の場合は、受信許可リストに当店ドメインを追加してください。</span></label>
      <label class="field"><span class="field__label">メールアドレス（確認） <em>必須</em></span>
        <input type="email" id="f-mail2" value="${esc(c.email || '')}"></label>
      <label class="field"><span class="field__label">電話番号 <em>必須</em></span>
        <input type="tel" id="f-tel" value="${esc(c.tel || '')}" placeholder="018-000-0000"></label>
      <label class="field"><span class="field__label">連絡事項</span>
        <textarea id="f-memo" rows="4" placeholder="ご要望があればご記入ください">${esc(c.memo || '')}</textarea></label>
      <p class="alert" id="f-alert" hidden></p>
    </section>
    <div class="actions">
      <a class="btn btn--sub" href="#/reserve/${draft.menuId}">戻る</a>
      <button class="btn btn--main" id="f-next">確認する</button>
    </div>`;

  $('#f-next').onclick = () => {
    const v = {
      name: $('#f-name').value.trim(),
      kana: $('#f-kana').value.trim(),
      email: $('#f-mail').value.trim(),
      email2: $('#f-mail2').value.trim(),
      tel: $('#f-tel').value.trim(),
      memo: $('#f-memo').value.trim()
    };
    const err = validateContact(v);
    if (err) {
      const a = $('#f-alert');
      a.hidden = false;
      a.textContent = err;
      return;
    }
    delete v.email2;
    draft.contact = v;
    saveDraft();
    go('/confirm');
  };
}

function validateContact(v) {
  if (!v.name) return '氏名を入力してください。';
  if (!v.kana) return '氏名（カナ）を入力してください。';
  if (!/^[ァ-ヴー\s　]+$/.test(v.kana)) return '氏名（カナ）は全角カタカナで入力してください。';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return 'メールアドレスの形式が正しくありません。';
  if (v.email !== v.email2) return 'メールアドレスと確認用メールアドレスが一致しません。';
  if (!/^[0-9\-+()]{10,15}$/.test(v.tel)) return '電話番号の形式が正しくありません。';
  return null;
}

/* 予約内容のサマリー */
function summaryBox(menu) {
  const dur = totalMinutes(menu, draft.options);
  const opts = draft.options.map(optionById);
  const optSum = opts.reduce((s, o) => s + o.price, 0);
  const total = menu.price == null ? null : menu.price + optSum;

  return `
    <section class="summary">
      <dl>
        <dt>メニュー</dt><dd>${esc(menu.name)}</dd>
        <dt>日時</dt><dd>${fmtDate(draft.date)} ${fmtMin(draft.start)}〜${fmtMin(draft.start + dur)}（${dur}分）</dd>
        <dt>オプション</dt><dd>${opts.length ? opts.map((o) => `${esc(o.name)}（${yen(o.price)}）`).join('<br>') : 'なし'}</dd>
        <dt>合計金額</dt><dd>${
          total == null
            ? `${optSum ? yen(optSum) + ' ＋ ' : ''}施術料金はカウンセリング後にご案内します`
            : `<strong>${yen(total)}</strong>（税込）`
        }</dd>
      </dl>
    </section>`;
}

/* =========================================================
   5. 確認 → 予約確定
   ========================================================= */

function viewConfirm() {
  if (!draft || draft.start == null || !draft.contact) return go('/');
  const menu = menuById(draft.menuId);
  const c = draft.contact;
  const cancelLimit = cancelLimitText(draft.date);

  $('#view').innerHTML = `
    ${stepBar(3)}
    <h1 class="page-title">この内容でお間違いないですか？</h1>
    ${summaryBox(menu)}
    <section class="panel">
      <dl class="kv">
        <dt>氏名</dt><dd>${esc(c.name)}（${esc(c.kana)}）</dd>
        <dt>メールアドレス</dt><dd>${esc(c.email)}</dd>
        <dt>電話番号</dt><dd>${esc(c.tel)}</dd>
        <dt>連絡事項</dt><dd>${c.memo ? esc(c.memo).replace(/\n/g, '<br>') : '—'}</dd>
      </dl>
    </section>
    <p class="notice">キャンセルは <strong>${cancelLimit}</strong> まで承ります（${RULES.labels.cancel}）。</p>
    <p class="alert" id="c-alert" hidden></p>
    <div class="actions">
      <a class="btn btn--sub" href="#/form">修正する</a>
      <button class="btn btn--main" id="c-submit">予約を確定する</button>
    </div>`;

  $('#c-submit').onclick = () => {
    const dur = totalMinutes(menu, draft.options);

    /* 確定直前に締切と空きを再チェック（二重予約の防止） */
    if (isPastDeadline(draft.date, draft.start)) {
      return fail(`予約受付は開始時刻の${RULES.deadlineHours}時間前で締め切りました。日時を選び直してください。`);
    }
    const slot = buildSlots(draft.date, dur).find((s) => s.start === draft.start);
    if (!slot || !slot.open) {
      return fail('申し訳ありません。選択された時間はちょうど満席になりました。別の時間をお選びください。');
    }

    const code = newCode();
    const optSum = draft.options.reduce((s, id) => s + optionById(id).price, 0);
    const reservation = {
      code,
      menuId: menu.id,
      options: draft.options.slice(),
      date: draft.date,
      start: draft.start,
      end: draft.start + dur,
      total: menu.price == null ? null : menu.price + optSum,
      name: c.name, kana: c.kana, email: c.email, tel: c.tel, memo: c.memo,
      memberEmail: state.session ? state.session.email : null,
      status: 'reserved',
      createdAt: Date.now()
    };
    state.reservations.push(reservation);
    save();
    clearDraft();
    syncReservation(reservation);
    go('/done/' + code);
  };

  function fail(msg) {
    const a = $('#c-alert');
    a.hidden = false;
    a.textContent = msg;
  }
}

function newCode() {
  const d = new Date();
  const base = 'R' + String(d.getFullYear()).slice(2) +
    String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  let code;
  do {
    code = base + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  } while (state.reservations.some((r) => r.code === code));
  return code;
}

function cancelLimitText(dateStr) {
  const d = parseYmd(dateStr);
  d.setDate(d.getDate() - RULES.cancelDaysBefore);
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]}) 23:59`;
}

/* =========================================================
   6. 予約完了
   ========================================================= */

function viewDone(code) {
  const r = state.reservations.find((x) => x.code === code);
  if (!r) return go('/');

  $('#view').innerHTML = `
    ${stepBar(4)}
    <div class="done">
      <h1 class="page-title">ご予約を承りました</h1>
      <p class="done__code">予約番号<strong>${esc(r.code)}</strong></p>
      <p>確認メールを <strong>${esc(r.email)}</strong> 宛にお送りしました。<span class="note">（デモのため実際には送信されません）</span></p>
    </div>
    ${reservationCard(r)}
    <p class="notice">予約の確認・キャンセルは「予約の確認・キャンセル」から、予約番号とメールアドレスで行えます。<br>
      キャンセルは <strong>${cancelLimitText(r.date)}</strong> まで承ります。</p>
    <div class="actions">
      <a class="btn btn--sub" href="#/">メニュー一覧へ</a>
      <a class="btn btn--main" href="#/lookup">予約を確認する</a>
    </div>`;
}

function reservationCard(r) {
  const menu = menuById(r.menuId);
  const opts = r.options.map((id) => optionById(id).name);
  return `
    <section class="summary">
      <dl>
        <dt>予約番号</dt><dd>${esc(r.code)}</dd>
        <dt>メニュー</dt><dd>${esc(menu.name)}</dd>
        <dt>日時</dt><dd>${fmtDate(r.date)} ${fmtMin(r.start)}〜${fmtMin(r.end)}</dd>
        <dt>オプション</dt><dd>${opts.length ? esc(opts.join('、')) : 'なし'}</dd>
        <dt>合計金額</dt><dd>${r.total == null ? '施術料金はカウンセリング後にご案内' : yen(r.total) + '（税込）'}</dd>
        <dt>お客様</dt><dd>${esc(r.name)} 様／${esc(r.tel)}</dd>
        <dt>状態</dt><dd>${r.status === 'reserved' ? '<span class="badge badge--ok">予約済み</span>' : '<span class="badge badge--no">キャンセル済み</span>'}</dd>
      </dl>
    </section>`;
}

/* =========================================================
   7. 予約の確認・キャンセル
   ========================================================= */

function viewLookup() {
  $('#view').innerHTML = `
    <h1 class="page-title">予約の確認・キャンセル</h1>
    <p class="lead">予約番号とご予約時のメールアドレスを入力してください。</p>
    <section class="panel">
      <label class="field"><span class="field__label">予約番号</span><input type="text" id="lk-code" placeholder="R2609070001"></label>
      <label class="field"><span class="field__label">メールアドレス</span><input type="email" id="lk-mail" placeholder="abcde@example.com"></label>
      <p class="alert" id="lk-alert" hidden></p>
      <button class="btn btn--main" id="lk-submit">予約を照会する</button>
    </section>
    <div id="lk-result"></div>`;

  $('#lk-submit').onclick = () => {
    const code = $('#lk-code').value.trim().toUpperCase();
    const mail = $('#lk-mail').value.trim();
    const r = state.reservations.find((x) => x.code === code && x.email === mail);
    if (!r) {
      const a = $('#lk-alert');
      a.hidden = false;
      a.textContent = '該当する予約が見つかりません。予約番号とメールアドレスをご確認ください。';
      return;
    }
    $('#lk-alert').hidden = true;
    $('#lk-result').innerHTML = reservationCard(r) + cancelArea(r);
    bindCancel(r, () => viewLookup());
  };
}

function cancelArea(r) {
  if (r.status !== 'reserved') return '';
  if (isPastCancelLimit(r.date)) {
    return `<p class="notice">キャンセル締切（${cancelLimitText(r.date)}）を過ぎているため、Webからのキャンセルはできません。お電話にてご連絡ください。</p>`;
  }
  return `
    <p class="notice">キャンセル期限：${cancelLimitText(r.date)}</p>
    <div class="actions"><button class="btn btn--danger" data-cancel="${r.code}">この予約をキャンセルする</button></div>`;
}

function bindCancel(r, onDone) {
  const btn = $(`[data-cancel="${r.code}"]`);
  if (!btn) return;
  btn.onclick = () => {
    openModal(`
      <h2 class="modal__title">予約をキャンセルします</h2>
      <p>${fmtDate(r.date)} ${fmtMin(r.start)}〜 のご予約（${esc(menuById(r.menuId).name)}）をキャンセルします。<br>この操作は取り消せません。</p>
      <div class="actions">
        <button class="btn btn--sub" data-close>やめる</button>
        <button class="btn btn--danger" id="do-cancel">キャンセルを確定する</button>
      </div>`);
    $('#do-cancel').onclick = () => {
      const target = state.reservations.find((x) => x.code === r.code);
      target.status = 'cancelled';
      target.cancelledAt = Date.now();
      save();
      SheetAPI.sync('cancelReservation', { code: target.code });
      closeModal();
      const waiting = state.waitlist.filter((w) => w.date === target.date).length;
      toast(waiting
        ? `キャンセルしました。キャンセル待ちの${waiting}名に空き通知を送信しました（デモ）。`
        : 'キャンセルしました。');
      onDone();
    };
  };
}

/* =========================================================
   8. 会員登録・マイページ
   ========================================================= */

function viewAccount() {
  if (state.session) return viewMypage();

  $('#view').innerHTML = `
    <h1 class="page-title">ログイン / 新規会員登録</h1>
    <div class="split">
      <section class="panel">
        <h2 class="panel__title">ログイン</h2>
        <label class="field"><span class="field__label">メールアドレス</span><input type="email" id="ac-mail"></label>
        <label class="field"><span class="field__label">パスワード</span><input type="password" id="ac-pass"></label>
        <p class="alert" id="ac-alert" hidden></p>
        <button class="btn btn--main" id="ac-login">ログイン</button>
      </section>
      <section class="panel">
        <h2 class="panel__title">新規会員登録</h2>
        <label class="field"><span class="field__label">氏名</span><input type="text" id="rg-name"></label>
        <label class="field"><span class="field__label">氏名（カナ）</span><input type="text" id="rg-kana"></label>
        <label class="field"><span class="field__label">メールアドレス</span><input type="email" id="rg-mail"></label>
        <label class="field"><span class="field__label">電話番号</span><input type="tel" id="rg-tel"></label>
        <label class="field"><span class="field__label">パスワード</span><input type="password" id="rg-pass"></label>
        <p class="alert" id="rg-alert" hidden></p>
        <button class="btn btn--sub" id="rg-submit">登録する</button>
        <p class="note">※デモアプリのため、入力内容はこのブラウザ内にのみ保存されます。実在するパスワードは入力しないでください。</p>
      </section>
    </div>`;

  $('#ac-login').onclick = () => {
    const mail = $('#ac-mail').value.trim();
    const pass = $('#ac-pass').value;
    const m = state.members.find((x) => x.email === mail && x.password === pass);
    if (!m) {
      const a = $('#ac-alert');
      a.hidden = false;
      a.textContent = 'メールアドレスまたはパスワードが違います。';
      return;
    }
    state.session = { email: m.email };
    save();
    viewMypage();
    renderNav();
  };

  $('#rg-submit').onclick = () => {
    const m = {
      name: $('#rg-name').value.trim(),
      kana: $('#rg-kana').value.trim(),
      email: $('#rg-mail').value.trim(),
      tel: $('#rg-tel').value.trim(),
      password: $('#rg-pass').value
    };
    const err = validateContact({ name: m.name, kana: m.kana, email: m.email, email2: m.email, tel: m.tel })
      || (m.password.length < 4 ? 'パスワードは4文字以上で入力してください。' : null)
      || (state.members.some((x) => x.email === m.email) ? 'このメールアドレスは既に登録されています。' : null);
    if (err) {
      const a = $('#rg-alert');
      a.hidden = false;
      a.textContent = err;
      return;
    }
    state.members.push(m);
    state.session = { email: m.email };
    save();
    syncMember(m);
    toast('会員登録が完了しました。');
    viewMypage();
    renderNav();
  };
}

function viewMypage() {
  const email = state.session.email;
  const me = state.members.find((m) => m.email === email);
  const list = state.reservations
    .filter((r) => r.memberEmail === email || r.email === email)
    .sort((a, b) => (a.date + a.start > b.date + b.start ? -1 : 1));

  $('#view').innerHTML = `
    <h1 class="page-title">マイページ</h1>
    <p class="lead">${esc(me ? me.name : email)} 様</p>
    <section class="panel">
      <h2 class="panel__title">予約履歴</h2>
      ${list.length ? '' : '<p>ご予約はまだありません。</p>'}
      ${list.map((r) => reservationCard(r) + cancelArea(r)).join('')}
    </section>
    <div class="actions">
      <a class="btn btn--main" href="#/">新しく予約する</a>
      <button class="btn btn--sub" id="logout">ログアウト</button>
    </div>`;

  list.forEach((r) => bindCancel(r, viewMypage));
  $('#logout').onclick = () => {
    state.session = null;
    save();
    renderNav();
    go('/');
  };
}

/* =========================================================
   9. 店舗案内
   ========================================================= */

function viewAbout() {
  $('#view').innerHTML = `
    <h1 class="page-title">About Us</h1>
    <section class="panel">
      <dl class="kv">
        <dt>店名</dt><dd>${esc(SALON.fullName)}</dd>
        <dt>所在地</dt><dd>${esc(SALON.address)}</dd>
        <dt>営業時間</dt><dd>${[1, 2, 3, 4, 5, 6, 0].map((d) => {
          const h = SALON.hours[d];
          return `${WEEK[d]}：${h ? h.open + '〜' + h.close : '定休日'}`;
        }).join('<br>')}</dd>
        <dt>席数</dt><dd>${SALON.capacity}席（同時施術可能人数）</dd>
        <dt>予約枠</dt><dd>${SALON.slotStep}分刻み</dd>
      </dl>
    </section>
    <section class="panel">
      <h2 class="panel__title">予約に関する注意事項</h2>
      <dl class="kv">
        <dt>予約受付開始</dt><dd>${RULES.labels.accept}</dd>
        <dt>予約受付締切</dt><dd>${RULES.labels.deadline}</dd>
        <dt>キャンセル締切</dt><dd>${RULES.labels.cancel}</dd>
      </dl>
    </section>`;
}

/* ---------- 起動 ---------- */

renderShopInfo();
router();
backfillMembers();  /* 未送信の会員を送信対象に加える */
SheetAPI.flush();   /* 前回送れなかったぶんをまとめて送信 */
