/* =========================================================
   店舗マスタ・メニューマスタ・予約ルール
   （reserva.be/wellme の公開情報をもとにした設定データ）
   ========================================================= */

const SALON = {
  name: 'wellme',
  fullName: '秋田市美容室　wellme',
  address: '秋田県秋田市大町３－１－８',

  /* 曜日別営業時間（0=日 … 6=土）。null は定休日 */
  hours: {
    0: { open: '09:00', close: '18:00' },
    1: { open: '09:00', close: '19:00' },
    2: null,                                  // 火曜定休
    3: { open: '09:00', close: '19:00' },
    4: { open: '09:00', close: '19:00' },
    5: { open: '09:00', close: '19:00' },
    6: { open: '09:00', close: '18:00' }
  },

  slotStep: 30,   // 予約枠の刻み（分）
  capacity: 2     // 同時に施術できる席数
};

/* 予約ルール（画面表示と実際の判定の両方でこの値を使う） */
const RULES = {
  acceptMonths: 3,        // 予約受付開始：3ヶ月前の00:00から
  deadlineHours: 12,      // 予約受付締切：12時間前まで
  cancelDaysBefore: 1,    // キャンセル締切：1日前の23:59まで
  labels: {
    accept: '3ヶ月前の00:00から',
    deadline: '12時間前まで',
    cancel: '1日前の23:59まで'
  }
};

/* メニュー（price: null は「カウンセリング後にお見積り」） */
const MENUS = [
  { id: 'm01', name: 'カット', price: 4950, min: 60,
    note: 'シャンプー・ブロー込 / 学割有▶小学生以下￥2,750 / 中学・高校生￥3,300 / 大学・専門￥3,850（学割ご利用の場合シャンプーはつきません）' },
  { id: 'm02', name: 'カット＋トリートメント', price: null, min: 90 },
  { id: 'm03', name: 'カット＋カラー', price: null, min: 150 },
  { id: 'm04', name: 'カット＋カラー＋トリートメント', price: null, min: 150 },
  { id: 'm05', name: 'カラー', price: null, min: 120 },
  { id: 'm06', name: 'カラー＋トリートメント', price: null, min: 120 },
  { id: 'm07', name: 'カット＋ダブルカラー', price: null, min: 210 },
  { id: 'm08', name: 'カット＋ダブルカラー＋トリートメント', price: null, min: 240 },
  { id: 'm09', name: 'ダブルカラー', price: null, min: 180 },
  { id: 'm10', name: 'カット＋パーマ', price: null, min: 120 },
  { id: 'm11', name: 'カット＋パーマ＋トリートメント', price: null, min: 150 },
  { id: 'm12', name: 'カット＋パーマ＋カラー', price: null, min: 210 },
  { id: 'm13', name: 'カット＋ストレートパーマ', price: null, min: 180 },
  { id: 'm14', name: 'カット＋ストレートパーマ＋トリートメント', price: null, min: 210 },
  { id: 'm15', name: 'カット＋ストレートパーマ＋カラー', price: null, min: 240 },
  { id: 'm16', name: 'ヘッドスパ', price: 6600, min: 60 },
  { id: 'm17', name: 'ヘッドスパ＋トリートメント', price: null, min: 90 },
  { id: 'm18', name: 'パリジェンヌラッシュリフト', price: 5500, min: 90 }
];

/* オプション（数量 0/1。addMin ぶん施術時間が延びる） */
const OPTIONS = [
  { id: 'o1', name: '頭浸浴スパ', price: 1650, addMin: 30 },
  { id: 'o2', name: '【夏季限定スパ】クールミストスパ', price: 2200, addMin: 30 },
  { id: 'o3', name: 'アンチエイジングスパ', price: 3300, addMin: 30 },
  { id: 'o4', name: 'パリジェンヌラッシュリフト(90分)', price: 5500, addMin: 90 }
];

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
