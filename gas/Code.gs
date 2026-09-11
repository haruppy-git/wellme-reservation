/* =========================================================
   wellme 顧客管理バックエンド（Google Apps Script）

   スプレッドシートに紐づけて「ウェブアプリ」としてデプロイして使う。
   手順は同じフォルダの SETUP.md を参照。

   シートは初回アクセス時に自動生成される：
     customers    … 顧客マスタ
     reservations … 予約履歴
     waitlist     … キャンセル待ち
   ========================================================= */

const SHEET_DEFS = {
  customers: [
    'customerId', 'name', 'kana', 'email', 'tel', 'memo',
    'visitCount', 'lastVisit', 'createdAt', 'updatedAt'
  ],
  reservations: [
    'code', 'customerId', 'date', 'startTime', 'endTime',
    'menuName', 'options', 'total', 'status',
    'name', 'kana', 'email', 'tel', 'memo', 'createdAt', 'cancelledAt'
  ],
  waitlist: ['waitlistId', 'date', 'menuName', 'email', 'createdAt']
};

/* 書き込みを伴う操作。同時実行を防ぐためロックをかける */
const WRITE_ACTIONS = [
  'saveCustomer', 'upsertCustomer', 'deleteCustomer',
  'saveReservation', 'cancelReservation', 'saveWaitlist', 'resetData'
];

/* ---------- エントリポイント ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.action) {
    return ContentService.createTextOutput(
      'wellme 顧客管理API：稼働中です。管理画面にこのURLを設定してください。'
    ).setMimeType(ContentService.MimeType.TEXT);
  }
  return handle(p);
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ ok: false, error: 'リクエストの形式が正しくありません' });
  }
  return handle(body);
}

function handle(p) {
  const action = p.action || 'ping';
  const fn = ACTIONS[action];
  if (!fn) return json({ ok: false, error: '未対応の操作です: ' + action });

  const needsLock = WRITE_ACTIONS.indexOf(action) >= 0;
  const lock = needsLock ? LockService.getScriptLock() : null;
  if (lock && !lock.tryLock(20000)) {
    return json({ ok: false, error: '他の処理と競合しました。少し待って再試行してください。' });
  }
  try {
    return json({ ok: true, data: fn(p) });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- シート操作 ---------- */

function book() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheetOf(name) {
  const cols = SHEET_DEFS[name];
  let sheet = book().getSheetByName(name);
  if (!sheet) {
    sheet = book().insertSheet(name);
    sheet.getRange(1, 1, 1, cols.length).setValues([cols])
      .setFontWeight('bold').setBackground('#f0f0f2');
    sheet.setFrozenRows(1);
    /* 日付や電話番号が数値に変換されないよう、全列を書式「書式なしテキスト」にする */
    sheet.getRange(1, 1, sheet.getMaxRows(), cols.length).setNumberFormat('@');
    sheet.autoResizeColumns(1, cols.length);
  }
  return sheet;
}

function readAll(name) {
  const cols = SHEET_DEFS[name];
  const sheet = sheetOf(name);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, cols.length).getValues();
  return values
    .map(function (row, i) {
      const o = { _row: i + 2 };
      cols.forEach(function (c, j) { o[c] = row[j] === '' || row[j] == null ? '' : String(row[j]); });
      return o;
    })
    .filter(function (o) { return o[cols[0]] !== ''; });
}

function appendRow(name, obj) {
  const cols = SHEET_DEFS[name];
  sheetOf(name).appendRow(cols.map(function (c) { return obj[c] == null ? '' : String(obj[c]); }));
}

function updateRow(name, rowIndex, obj) {
  const cols = SHEET_DEFS[name];
  sheetOf(name).getRange(rowIndex, 1, 1, cols.length)
    .setValues([cols.map(function (c) { return obj[c] == null ? '' : String(obj[c]); })]);
}

/* ---------- 小道具 ---------- */

function normEmail(v) { return String(v || '').trim().toLowerCase(); }
function normTel(v) { return String(v || '').replace(/[^0-9]/g, ''); }
function nowIso() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss");
}
function newId(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
}
function findBy(list, key, value) {
  const hits = list.filter(function (x) { return x[key] === value; });
  return hits.length ? hits[0] : null;
}

/* 予約者情報から顧客を特定する。メール→電話番号の順に名寄せし、無ければ新規作成 */
function findOrCreateCustomer(r) {
  const list = readAll('customers');
  const email = normEmail(r.email);
  const tel = normTel(r.tel);
  const now = nowIso();

  let hit = null;
  if (email) {
    hit = list.filter(function (c) { return normEmail(c.email) === email; })[0] || null;
  }
  if (!hit && tel) {
    hit = list.filter(function (c) { return normTel(c.tel) === tel; })[0] || null;
  }

  if (hit) {
    /* 管理画面で整えた内容を予約で上書きしないよう、空欄だけ埋める */
    const upd = Object.assign({}, hit);
    if (!upd.name && r.name) upd.name = r.name;
    if (!upd.kana && r.kana) upd.kana = r.kana;
    if (!upd.email && r.email) upd.email = r.email;
    if (!upd.tel && r.tel) upd.tel = r.tel;
    upd.updatedAt = now;
    updateRow('customers', hit._row, upd);
    return upd;
  }

  const rec = {
    customerId: newId('C'),
    name: r.name || '', kana: r.kana || '', email: r.email || '', tel: r.tel || '',
    memo: '', visitCount: '0', lastVisit: '', createdAt: now, updatedAt: now
  };
  appendRow('customers', rec);
  return rec;
}

/* 来店回数と最終来店日を予約履歴から数え直す */
function recalcCustomer(customerId) {
  const cur = findBy(readAll('customers'), 'customerId', customerId);
  if (!cur) return;

  const rs = readAll('reservations').filter(function (r) {
    return r.customerId === customerId && r.status !== 'cancelled';
  });
  const dates = rs.map(function (r) { return r.date; }).filter(Boolean).sort();

  cur.visitCount = String(rs.length);
  cur.lastVisit = dates.length ? dates[dates.length - 1] : '';
  cur.updatedAt = nowIso();
  updateRow('customers', cur._row, cur);
}

/* ---------- 操作の実体 ---------- */

const ACTIONS = {

  ping: function () {
    return { sheetName: book().getName(), url: book().getUrl(), time: nowIso() };
  },

  listCustomers: function () {
    return readAll('customers');
  },

  getCustomer: function (p) {
    const c = findBy(readAll('customers'), 'customerId', p.customerId);
    if (!c) throw new Error('顧客が見つかりません');
    const rs = readAll('reservations')
      .filter(function (r) { return r.customerId === p.customerId; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    return { customer: c, reservations: rs };
  },

  saveCustomer: function (p) {
    const input = p.customer || {};
    const now = nowIso();

    if (input.customerId) {
      const cur = findBy(readAll('customers'), 'customerId', input.customerId);
      if (!cur) throw new Error('顧客が見つかりません');
      const merged = Object.assign({}, cur, input, { updatedAt: now });
      updateRow('customers', cur._row, merged);
      return merged;
    }

    const rec = {
      customerId: newId('C'),
      name: input.name || '', kana: input.kana || '',
      email: input.email || '', tel: input.tel || '', memo: input.memo || '',
      visitCount: '0', lastVisit: '', createdAt: now, updatedAt: now
    };
    appendRow('customers', rec);
    return rec;
  },

  /* 会員登録など、予約を伴わない顧客の登録。
     既に同じメール／電話番号の顧客がいれば重複させず、空欄だけ埋める */
  upsertCustomer: function (p) {
    const c = p.customer || {};
    if (!normEmail(c.email) && !normTel(c.tel)) {
      throw new Error('メールアドレスか電話番号のどちらかが必要です');
    }
    return findOrCreateCustomer(c);
  },

  deleteCustomer: function (p) {
    const cur = findBy(readAll('customers'), 'customerId', p.customerId);
    if (!cur) throw new Error('顧客が見つかりません');
    sheetOf('customers').deleteRow(cur._row);
    return { customerId: p.customerId };
  },

  listReservations: function (p) {
    let rs = readAll('reservations');
    if (p.customerId) rs = rs.filter(function (r) { return r.customerId === p.customerId; });
    if (p.from) rs = rs.filter(function (r) { return r.date >= p.from; });
    if (p.to) rs = rs.filter(function (r) { return r.date <= p.to; });
    return rs.sort(function (a, b) {
      return (a.date + a.startTime) < (b.date + b.startTime) ? 1 : -1;
    });
  },

  /* 予約アプリから呼ばれる。同じ予約番号なら上書きする */
  saveReservation: function (p) {
    const r = p.reservation || {};
    if (!r.code) throw new Error('予約番号がありません');

    const customer = findOrCreateCustomer(r);
    const rec = {
      code: r.code,
      customerId: customer.customerId,
      date: r.date || '',
      startTime: r.startTime || '',
      endTime: r.endTime || '',
      menuName: r.menuName || '',
      options: r.options || '',
      total: r.total == null ? '' : String(r.total),
      status: r.status || 'reserved',
      name: r.name || '', kana: r.kana || '', email: r.email || '', tel: r.tel || '',
      memo: r.memo || '',
      createdAt: r.createdAt || nowIso(),
      cancelledAt: ''
    };

    const exist = findBy(readAll('reservations'), 'code', rec.code);
    if (exist) updateRow('reservations', exist._row, Object.assign({}, exist, rec));
    else appendRow('reservations', rec);

    recalcCustomer(customer.customerId);
    return { code: rec.code, customerId: customer.customerId };
  },

  cancelReservation: function (p) {
    const exist = findBy(readAll('reservations'), 'code', p.code);
    if (!exist) throw new Error('予約が見つかりません: ' + p.code);
    exist.status = 'cancelled';
    exist.cancelledAt = nowIso();
    updateRow('reservations', exist._row, exist);
    if (exist.customerId) recalcCustomer(exist.customerId);
    return { code: p.code };
  },

  /* 全シートのデータ行を削除する（見出し行は残す）。取り消せないので合言葉を要求する */
  resetData: function (p) {
    if (p.confirm !== 'RESET') throw new Error('確認キーワードが違います');
    const cleared = {};
    Object.keys(SHEET_DEFS).forEach(function (name) {
      const sheet = sheetOf(name);
      const last = sheet.getLastRow();
      cleared[name] = Math.max(0, last - 1);
      if (last > 1) sheet.deleteRows(2, last - 1);
    });
    return cleared;
  },

  saveWaitlist: function (p) {
    const w = p.entry || {};
    appendRow('waitlist', {
      waitlistId: newId('W'),
      date: w.date || '', menuName: w.menuName || '', email: w.email || '',
      createdAt: nowIso()
    });
    return { ok: true };
  }
};
