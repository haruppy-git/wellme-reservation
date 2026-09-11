/* =========================================================
   Google スプレッドシート（Apps Script ウェブアプリ）との通信
   予約アプリ・管理画面の両方から使う共通クライアント
   ========================================================= */

const SheetAPI = (() => {
  const URL_KEY = 'wellme.gasUrl';
  const QUEUE_KEY = 'wellme.syncQueue';
  const QUEUE_MAX = 200;

  const getUrl = () => (localStorage.getItem(URL_KEY) || '').trim();
  const setUrl = (u) => localStorage.setItem(URL_KEY, String(u || '').trim());
  const isConfigured = () => !!getUrl();

  /* Apps Script への呼び出し。
     Content-Type を text/plain にしているのは、CORS プリフライト（OPTIONS）を
     発生させないため。GAS は OPTIONS に応答できないので application/json だと失敗する。 */
  async function call(action, payload = {}) {
    const url = getUrl();
    if (!url) throw new Error('スプレッドシートの接続先URLが未設定です。管理画面の「設定」から登録してください。');

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, payload)),
        redirect: 'follow'
      });
    } catch (e) {
      throw new Error('スプレッドシートに接続できません。URLとネットワークを確認してください。');
    }
    if (!res.ok) throw new Error('通信エラー（HTTP ' + res.status + '）');

    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error('応答を解釈できません。デプロイ設定の「アクセスできるユーザー」が「全員」になっているか確認してください。');
    }
    if (!json.ok) throw new Error(json.error || '不明なエラー');
    return json.data;
  }

  /* ---- 未送信キュー ----
     オフラインや未設定でも予約は成立させ、送れなかったぶんは後でまとめて再送する */

  const readQueue = () => {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
  };
  const writeQueue = (q) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)));

  function enqueue(action, payload) {
    const q = readQueue();
    q.push({ action, payload, at: Date.now() });
    writeQueue(q);
  }

  /* 送信を試み、失敗したらキューに積む。決して例外を投げない */
  async function sync(action, payload) {
    if (!isConfigured()) {
      enqueue(action, payload);
      return false;
    }
    try {
      await call(action, payload);
      return true;
    } catch (e) {
      enqueue(action, payload);
      return false;
    }
  }

  /* 溜まった未送信ぶんを古い順に再送。1件でも失敗したらそこで止める（順序を守るため） */
  async function flush() {
    if (!isConfigured()) return { sent: 0, left: readQueue().length };
    let q = readQueue();
    let sent = 0;
    while (q.length) {
      try {
        await call(q[0].action, q[0].payload);
      } catch (e) {
        break;
      }
      q.shift();
      writeQueue(q);
      sent++;
    }
    return { sent, left: q.length };
  }

  return {
    getUrl, setUrl, isConfigured, call, sync, flush,
    queueLength: () => readQueue().length,
    clearQueue: () => localStorage.removeItem(QUEUE_KEY)
  };
})();
