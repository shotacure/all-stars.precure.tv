/**********************************************
 * all-stars.precure.tv — main script
 *
 * 概要
 *  - 出題：声優 2問 + その他 7問 + 追加（父/母/誕）1問 = 計10問
 *  - タイマー：合計655.35秒・各問163.83秒を超過したら
 *               結果を出さず即初期画面に戻す
 *  - 共有URL：バイナリ短縮
 *      正解のときは「選択情報を持たない」可変長レコードでURL短縮
 *  - 共有URL復元：?r= パラメータから結果画面を再現
 *  - 初期表示：「いまのプリキュア…Nにん」を表示
 *  - ランキング：上位20位をバックエンドと連携して管理
 *      読み取りはS3上のleaderboard.jsonをCloudFront経由で取得
 *      書き込みはランクイン時のみAPI経由でバックエンドにアクセス
 **********************************************/


/*--------------------------------------------
  設定
  - config.js（.gitignore対象）から環境別の値を読み込む
  - config.js が未設定でもクイズ本体は動作する（ランキング機能のみ無効化）
--------------------------------------------*/
const ALLSTARS_CFG = window.ALLSTARS_CONFIG || {};
const API_BASE_URL = ALLSTARS_CFG.API_BASE_URL || '';

/*--------------------------------------------
  Google Analytics 4 動的読み込み
  - config.js に GA4_MEASUREMENT_ID が設定されている場合のみ有効化
  - 未設定・空文字の場合は何も読み込まない
--------------------------------------------*/
(function initGA4() {
  const id = ALLSTARS_CFG.GA4_MEASUREMENT_ID;
  if (!id) return;

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', id);
})();

/*--------------------------------------------
  i18n (ja/en)
  - UI文字列を data/i18n/{lang}.json から読み込み
--------------------------------------------*/
let currentLang = 'ja';
let I18N = {};
let latestPrecureCount = null;
let resultTimerSec = null; // 結果画面用：確定した秒数

function t(key, vars = {}) {
  const template = (I18N && I18N[key]) ? I18N[key] : '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
}

function v(entry, key) {
  const val = entry ? entry[key] : '';
  if (val && typeof val === 'object') {
    return (val[currentLang] ?? val['ja'] ?? val['en'] ?? '');
  }
  return (val ?? '');
}


function showLangSwitch(){document.getElementById('lang-switch')?.classList.remove('hidden');}
function hideLangSwitch(){document.getElementById('lang-switch')?.classList.add('hidden');}
function applyI18nToDom() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const attr = el.getAttribute('data-i18n-attr');
    const value = (I18N && I18N[key]) ? I18N[key] : null;
    if (value == null) return;
    if (attr) el.setAttribute(attr, value);
    else el.textContent = value;
  });

  // document title
  if (I18N.site_title) document.title = I18N.site_title;

  // <html lang="">
  document.documentElement.setAttribute('lang', currentLang);
}

function setLangButtonsActive(lang) {
  const jaBtn = document.getElementById('lang-ja');
  const enBtn = document.getElementById('lang-en');
  if (jaBtn) jaBtn.classList.toggle('active', lang === 'ja');
  if (enBtn) enBtn.classList.toggle('active', lang === 'en');
}

function initLangSwitch() {
  const jaBtn = document.getElementById('lang-ja');
  const enBtn = document.getElementById('lang-en');

  const setUrlLang = (lang) => {
    const url = new URL(location.href);
    const params = url.searchParams;
    const r = params.get('r');

    // 共有URLがある場合：r内の1ビット言語フラグを更新し、?en は使わない
    if (r) {
      try {
        const decoded = decodeResultsBinary(r);
        const newR = encodeResultsBinaryFromDecoded(decoded, lang === 'en' ? 1 : 0);
        url.search = '?r=' + newR;
      } catch (_) {
        // decode失敗時はフォールバック：?en を使う（容量は増えるが復旧優先）
        if (lang === 'en') url.search = '?en';
        else url.search = '';
      }
    } else {
      // 通常画面：?en の有無だけで表現
      if (lang === 'en') url.search = '?en';
      else url.search = '';
    }

    history.replaceState(null, '', url.toString());
  };

  if (jaBtn) {
    jaBtn.addEventListener('click', () => {
      setUrlLang('ja');
      loadLanguage('ja');
    });
  }
  if (enBtn) {
    enBtn.addEventListener('click', () => {
      setUrlLang('en');
      loadLanguage('en');
    });
  }
}

function hasEnglishFlag() {
  const params = new URLSearchParams(location.search);
  return params.has('en');
}


function formatSeconds(sec) {
  return t('timer_value', { sec: sec.toFixed(2) });
}

function updatePrecureCountLabel() {
  const countElem = document.getElementById('precure-count');
  if (!countElem) return;

  if (latestPrecureCount == null) {
    countElem.textContent = t('precure_count_unknown');
  } else {
    countElem.textContent = t('precure_count_value', { n: latestPrecureCount });
  }
}

async function loadLanguage(lang) {
  try {
    const res = await fetch(`data/i18n/${lang}.json`);
    I18N = await res.json();
    currentLang = lang;
    document.documentElement.lang = lang;
    setLangButtonsActive(lang);
    applyI18nToDom();
    updatePrecureCountLabel();
    rebuildQuestionsForLang();
    rebuildResultsForLang();
    refreshLanguageSensitiveUI();
    renderLeaderboard();
  } catch (e) {
    // フォールバック：読み込み失敗時は何もしない
    console.error(e);
  }
}

/*--------------------------------------------
  通常出題の Q/A マッピング
--------------------------------------------*/
const QANDA = {
  1: { questionKey: 'transformed', answerKey: 'civilian' },
  2: { questionKey: 'transformed', answerKey: 'voice' },
  3: { questionKey: 'civilian',    answerKey: 'transformed' },
  4: { questionKey: 'civilian',    answerKey: 'voice' },
  5: { questionKey: 'voice',       answerKey: 'transformed' },
  6: { questionKey: 'voice',       answerKey: 'civilian' },

  // 追加問題
  7: { questionKey: 'civilian',    answerKey: 'father' },
  8: { questionKey: 'civilian',    answerKey: 'mother' },
  9: { questionKey: 'civilian',    answerKey: 'birthday' },
  10:{ questionKey: 'transformed', answerKey: 'birthday' }
};

/*--------------------------------------------
  時間上限（超過時は即初期画面リセット）
--------------------------------------------*/
const PERQ_LIMIT  = 163.83; // 各問の最大秒数（14bit → 0..163.83s）
const TOTAL_LIMIT = 655.35; // 合計の最大秒数（16bit → 0..655.35s)

/*--------------------------------------------
  ランタイム状態
--------------------------------------------*/
let quizData = [];          // precure.json 全件
let questions = [];         // 出題10問
let currentQuestion = 0;    // 現在の問題番号
let timerInterval;          // setInterval ID
let startTime;              // クイズ開始時刻(ms)
let elapsedTime = 0;        // 合計経過時間(ms)
let results = [];           // 回答結果（共有用メタ含む）
let lastAnswerTime;         // 直前回答時刻(ms)
let isSharedView = false;   // 共有URLからの閲覧か

/*--------------------------------------------
  ランキング状態
  - leaderboard: S3のleaderboard.jsonから読み込んだエントリ配列（上位100件）
  - sessionToken: バックエンドから取得したセッショントークン
--------------------------------------------*/
let leaderboard = [];
let sessionToken = null;

/*--------------------------------------------
  Base64URL ユーティリティ
  （共有パラメータをURL安全に圧縮表現するため）
--------------------------------------------*/
function b64uEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
function b64uDecode(str) {
  str = str.replace(/-/g,'+').replace(/_/g,'/');
  const pad = str.length % 4 ? 4 - (str.length % 4) : 0;
  return atob(str + '='.repeat(pad));
}

/*--------------------------------------------
  質問タイプ ⇄ データキーの対応
  - 出題タイプごとにどのフィールドを答えに使うか
--------------------------------------------*/
function typeToFieldCode(t) {
  if (t === 1 || t === 6) return 1;           // 変身前
  if (t === 2 || t === 4) return 3;           // 声優
  if (t === 3 || t === 5) return 2;           // 変身後
  if (t === 7) return 4;                      // 父親（追加）
  if (t === 8) return 5;                      // 母親（追加）
  if (t === 9 || t === 10) return 6;          // 誕生日（追加）
  return 0;
}
function fieldCodeToKey(c) {
  return c === 1 ? 'civilian'
       : c === 2 ? 'transformed'
       : c === 3 ? 'voice'
       : c === 4 ? 'father'
       : c === 5 ? 'mother'
       : c === 6 ? 'birthday'
       : '';
}

/*--------------------------------------------
  ビットパック用ユーティリティ
  - URLを短くするため、結果をビット列に詰める
--------------------------------------------*/
function writeBits(buf, bitPos, value, width) {
  for (let i = width - 1; i >= 0; i--) {
    const bit = (value >>> i) & 1;
    const byteIndex = bitPos >> 3;
    const bitIndex  = 7 - (bitPos & 7);
    buf[byteIndex] = (buf[byteIndex] || 0) | (bit << bitIndex);
    bitPos++;
  }
  return bitPos;
}
function readBits(buf, bitPos, width) {
  let v = 0;
  for (let i = 0; i < width; i++) {
    const byteIndex = (bitPos + i) >> 3;
    const bitIndex  = 7 - ((bitPos + i) & 7);
    const bit = ((buf[byteIndex] || 0) >> bitIndex) & 1;
    v = (v << 1) | bit;
  }
  return v;
}

/*--------------------------------------------
  共有エンコード
  ヘッダ：
    ver(8)=6, totalCs(16)   → 合計センチ秒（0..65535=655.35s）
  各問（可変長）：
    正解：i(10), t(4), w(1=0),              tmCs(14)    = 29bit
    不正：i(10), t(4), w(1=1), si+1(10), sf(3), tmCs(14) = 42bit
  - 正解時は「選択インデックス/選択カラム」を持たずに短縮
--------------------------------------------*/

/*--------------------------------------------
  共有エンコード（復元データ→再エンコード）
  - decodeResultsBinary の戻り値（totalCs/items）から、言語ビットだけ差し替えて再生成
--------------------------------------------*/
function encodeResultsBinaryFromDecoded(decoded, langBit) {
  const ver = 7;
  const totalCs = Math.min(65535, Math.max(0, decoded.totalCs || 0));
  const items = Array.isArray(decoded.items) ? decoded.items : [];

  // 必要ビット数（ver + lang + totalCs + items）
  let totalBits = 8 + 1 + 16;
  totalBits += items.reduce((acc, it) => acc + ((it.wrong === 0) ? 29 : 42), 0);

  const buf = new Uint8Array(Math.ceil(totalBits / 8));
  let p = 0;

  p = writeBits(buf, p, ver, 8);
  p = writeBits(buf, p, (langBit ? 1 : 0), 1);
  p = writeBits(buf, p, totalCs, 16);

  for (const it of items) {
    const i = Math.min(1023, Math.max(0, it.i || 0)) & 0x3ff;
    const t = (it.t || 0) & 0x0f;
    const w = (it.wrong || 0) & 0x01;
    const tmCs = Math.min(16383, Math.max(0, it.tmCs || 0)) & 0x3fff;

    p = writeBits(buf, p, i, 10);
    p = writeBits(buf, p, t, 4);
    p = writeBits(buf, p, w, 1);

    if (w === 0) {
      p = writeBits(buf, p, tmCs, 14);
    } else {
      const si = Math.min(1023, Math.max(0, (it.si || 0))) & 0x3ff;
      const sf = Math.min(7, Math.max(0, (it.sf || 0))) & 0x07;
      p = writeBits(buf, p, si, 10);
      p = writeBits(buf, p, sf, 3);
      p = writeBits(buf, p, tmCs, 14);
    }
  }

  return b64uEncode(String.fromCharCode(...buf));
}

function encodeResultsBinary(resArr, totalSeconds) {
  const ver = 7;
  const totalCs = Math.min(65535, Math.max(0, Math.round(totalSeconds * 100)));

  // まず必要ビット数を概算（可変長）
  let totalBits = 8 + 1 + 16; // ver + lang(1) + totalCs
  const perItemBits = resArr.map(r => (r.correct ? 29 : 42));
  totalBits += perItemBits.reduce((a, b) => a + b, 0);

  const buf = new Uint8Array(Math.ceil(totalBits / 8));
  let p = 0;

  // ヘッダ書き込み
  p = writeBits(buf, p, ver, 8);
  // 言語フラグ（0=ja, 1=en）
  p = writeBits(buf, p, (currentLang === 'en') ? 1 : 0, 1);
  p = writeBits(buf, p, totalCs, 16);

  // 各問
  for (const r of resArr) {
    const entryIdx = Math.min(1023, Math.max(0, (r.entryIndex ?? 0))) & 0x3ff;
    const type     = (r.type ?? 0) & 0x0f;
    const tmCs     = Math.min(16383, Math.max(0, Math.round(parseFloat(r.time) * 100)));
    const wrong    = r.correct ? 0 : 1;

    // 必須部
    p = writeBits(buf, p, entryIdx, 10);
    p = writeBits(buf, p, type, 4);
    p = writeBits(buf, p, wrong, 1);

    // 不正解のみ：選択インデックス/選択カラム
    if (wrong) {
      const si = Math.min(1023, Math.max(0, ((r.selIndex ?? -1) + 1))) & 0x3ff; // -1 → 0
      const sf = (r.selFieldCode ?? 0) & 0x07;
      p = writeBits(buf, p, si, 10);
      p = writeBits(buf, p, sf, 3);
    }

    // 経過時間（センチ秒）
    p = writeBits(buf, p, tmCs, 14);
  }

  // Base64URL 化
  return b64uEncode(String.fromCharCode(...buf));
}

/*--------------------------------------------
  共有デコード
  - 正解/不正解でレコード長が異なるため、wフラグで読み分け
--------------------------------------------*/
function decodeResultsBinary(s) {
  const raw = b64uDecode(s);
  const b = Uint8Array.from(raw, c => c.charCodeAt(0));
  let p = 0;

  // ヘッダ
  const ver = readBits(b, p, 8); p += 8;
  let lang = 0;
  if (ver === 6) {
    lang = 0;
  } else if (ver === 7) {
    lang = readBits(b, p, 1); p += 1;
  } else {
    throw new Error('Unsupported share format');
  }
  const totalCs = readBits(b, p, 16); p += 16;

  // 各問
  const items = [];
  while (p < b.length * 8) {
    if ((p + 29) > b.length * 8) break; // 正解の最小長が読めない場合は終了

    const i = readBits(b, p, 10); p += 10;
    const t = readBits(b, p, 4);  p += 4;
    const w = readBits(b, p, 1);  p += 1;

    let si = -1;
    let sf = 0;

    if (w === 1) {
      // 不正解：si+1(10) + sf(3)
      if ((p + 13) > b.length * 8) break;
      const si1 = readBits(b, p, 10); p += 10; si = si1 - 1;
      sf = readBits(b, p, 3);        p += 3;
    }

    const tmCs = readBits(b, p, 14); p += 14;

    items.push({ i, t, wrong: w, si, sf, tmCs });
  }

  return { totalCs, items, lang };
}

/*--------------------------------------------
  ランキング：leaderboard.json の読み込み
  - ページ読み込み時にS3/CloudFront経由で取得しメモリに保持
  - バックエンドAPIへのアクセスは不要（静的JSON配信）
  - entries キーを優先し、旧形式 top20 からのフォールバックも対応
--------------------------------------------*/
async function loadLeaderboard() {
  try {
    const res = await fetch('leaderboard.json');
    if (!res.ok) {
      leaderboard = [];
      return;
    }
    const data = await res.json();
    leaderboard = Array.isArray(data.entries) ? data.entries
               : Array.isArray(data.top20)   ? data.top20
               : [];
  } catch {
    // leaderboard.json が存在しない初期状態でもエラーにしない
    leaderboard = [];
  }
}

/*--------------------------------------------
  ランキング：順位判定
  - 満点（10問正解）のみ登録対象
  - 満点同士では合計タイム（センチ秒）の昇順で順位を決定
  - 上位100位の末尾より速いか、まだ100件未満なら圏内
--------------------------------------------*/
function isQualified(correct, totalTimeCs) {
  if (correct !== 10) return false;
  if (leaderboard.length < 100) return true;
  const last = leaderboard[leaderboard.length - 1];
  return totalTimeCs < last.totalTimeCs;
}

/*--------------------------------------------
  ランキング：表示
  - 満点達成者のみのタイムランキングを描画
  - 結果画面・初期画面の両方で表示
  - 順位ティア別の表示：
    1～3位: ボールド・大きめフォント・メダル絵文字で差別化
    4～10位: 通常表示
    11～20位: 小さめフォント・行高を詰める
    21位以降: さらに小さいフォントで改行なしのインライン形式
--------------------------------------------*/
function renderLeaderboard() {
  const area = document.getElementById('leaderboard-area');
  const list = document.getElementById('leaderboard-list');
  if (!area || !list) return;

  // ランキングデータがなければ非表示
  if (!leaderboard.length) {
    area.classList.add('hidden');
    return;
  }

  area.classList.remove('hidden');

  // メダル絵文字と1～3位のフォントサイズ
  const medals = ['🥇', '🥈', '🥉'];
  const topFontSizes = ['1.25em', '1.15em', '1.05em'];

  // 1～20位はテーブルで描画
  const tableEntries = leaderboard.slice(0, 20);
  let html = '<table class="leaderboard-table">';
  html += `<thead><tr>
    <th>${t('leaderboard_rank')}</th>
    <th>${t('leaderboard_name')}</th>
    <th>${t('leaderboard_time')}</th>
  </tr></thead><tbody>`;

  tableEntries.forEach((entry, i) => {
    const rank = i + 1;
    const timeSec = (entry.totalTimeCs / 100).toFixed(2);

    if (rank <= 3) {
      // 1～3位: メダル絵文字・ボールド・大きめフォント
      html += `<tr class="lb-top3" style="font-size:${topFontSizes[i]};">
        <td><strong>${medals[i]} ${rank}</strong></td>
        <td><strong>${escapeHtml(entry.name)}</strong></td>
        <td><strong>${t('result_time', { sec: timeSec })}</strong></td>
      </tr>`;
    } else if (rank <= 10) {
      // 4～10位: 通常表示
      html += `<tr>
        <td>${rank}</td>
        <td>${escapeHtml(entry.name)}</td>
        <td>${t('result_time', { sec: timeSec })}</td>
      </tr>`;
    } else {
      // 11～20位: 小さめフォント・行高を詰める
      html += `<tr class="lb-minor">
        <td>${rank}</td>
        <td>${escapeHtml(entry.name)}</td>
        <td>${t('result_time', { sec: timeSec })}</td>
      </tr>`;
    }
  });

  html += '</tbody></table>';

  // 21位以降: 改行なしのインライン形式
  if (leaderboard.length > 20) {
    const inlineEntries = leaderboard.slice(20);
    const inlineFormatted = inlineEntries.map((entry, i) => {
      const rank = i + 21;
      const timeSec = (entry.totalTimeCs / 100).toFixed(2);
      return `${rank}: ${escapeHtml(entry.name)} (${t('result_time', { sec: timeSec })})`;
    });
    html += `<div class="lb-rest">${inlineFormatted.join(' / ')}</div>`;
  }

  list.innerHTML = html;
}

/*--------------------------------------------
  HTMLエスケープ（ランキング名前表示用）
--------------------------------------------*/
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/*--------------------------------------------
  ランキング：セッショントークン取得
  - クイズ開始時にバックエンドから取得
  - タイム偽装防止のためサーバー側で発行時刻を記録
--------------------------------------------*/
async function fetchSessionToken() {
  if (!API_BASE_URL) {
    sessionToken = null;
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/api/session`);
    if (!res.ok) throw new Error('Session API error');
    const data = await res.json();
    sessionToken = data.token || null;
  } catch {
    // トークン取得失敗時もクイズは続行可能（ランキング登録不可になるだけ）
    sessionToken = null;
  }
}

/*--------------------------------------------
  ランキング：スコア送信
  - ランクイン時のみ名前と結果をバックエンドに送信
  - トークンは呼び出し元から明示的に渡す（グローバル参照による二重使用を防止）
  - 成功時は最新のランキングを受け取りメモリ・表示を更新
--------------------------------------------*/
async function submitScoreWithToken(token, name, correct, totalTimeCs) {
  if (!API_BASE_URL) return { qualified: false };

  const res = await fetch(`${API_BASE_URL}/api/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      name,
      correct,
      totalTimeCs,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Score submission failed');
  }

  return await res.json();
}

/*--------------------------------------------
  初期化（人数の即表示／共有URL復元／ランキング読み込み）
--------------------------------------------*/
document.addEventListener('DOMContentLoaded', () => {
  // i18n: language init
  // - 共有URL (?r=) では、パラメータ内の1ビット言語フラグを優先
  // - それ以外は、?en がある場合のみ英語、無い場合は日本語
  const params = new URLSearchParams(location.search);
  const rParamForLang = params.get('r');
  let initialLang = params.has('en') ? 'en' : 'ja';
  if (rParamForLang) {
    try {
      const decodedHeader = decodeResultsBinary(rParamForLang);
      initialLang = (decodedHeader.lang === 1) ? 'en' : 'ja';
    } catch (_) {
      // ignore
    }
  }
  loadLanguage(initialLang);
  initLangSwitch();

  // ランキングを非同期で読み込み（表示はloadLanguage内のrenderLeaderboardで行う）
  loadLeaderboard().then(() => renderLeaderboard());

  const countElem = document.getElementById('precure-count');

  // 1) 人数の即表示（window.PRECURE_COUNT優先、なければローカルキャッシュ）
  if (typeof window.PRECURE_COUNT === 'number') {
    latestPrecureCount = window.PRECURE_COUNT;
  } else {
    const cached = localStorage.getItem('precure_count');
    if (cached && !Number.isNaN(Number(cached))) {
      latestPrecureCount = Number(cached);
    }
  }
  updatePrecureCountLabel();

  // JSONを読み込んで人数キャッシュを更新（ブライト/ウィンディの2件を除外）
  fetch('data/precure.json')
    .then(res => res.json())
    .then(data => {
      const latest = (Array.isArray(data) ? data.length : 0) - 2;
      if (latest > 0) {
        localStorage.setItem('precure_count', String(latest));
        if (countElem && typeof window.PRECURE_COUNT !== 'number') {
          latestPrecureCount = latest;
          updatePrecureCountLabel();
        }
      }
    })
    .catch(() => { /* 表示はキャッシュでOK */ });

  // 2) 共有URL ?r= があれば結果復元モード
  const rParam = new URLSearchParams(location.search).get('r');
  if (!rParam) return;

  isSharedView = true;
  document.getElementById('start-btn')?.classList.add('hidden');
  document.getElementById('precure-count')?.classList.add('hidden');
  document.getElementById('timer')?.classList.add('hidden');

  fetch('data/precure.json')
    .then(res => res.json())
    .then(data => {
      quizData = data;

      const decoded = decodeResultsBinary(rParam);
      results = [];
      let sumCs = 0;

      // 復元：ビット列から各問を再構成
      decoded.items.forEach(it => {
        const entry = quizData[it.i];
        if (!entry) return;

        // 質問文の再生成（タイプ別）
        let qText = '';
        if (it.t === 1)      qText = t('q_cure_transform_who', { name: v(entry,'transformed') });
        else if (it.t === 2) qText = t('q_cure_actor_who', { name: v(entry,'transformed') });
        else if (it.t === 3) qText = t('q_transform_who', { name: v(entry,'civilian') });
        else if (it.t === 4) qText = t('q_civilian_actor_who', { name: v(entry,'civilian') });
        else if (it.t === 5) qText = t('q_actor_who', { name: v(entry,'voice') });
        else if (it.t === 6) qText = t('q_actor_who', { name: v(entry,'voice') });
        else if (it.t === 7) qText = t('q_civilian_father_who', { name: v(entry,'civilian') });
        else if (it.t === 8) qText = t('q_civilian_mother_who', { name: v(entry,'civilian') });
        else if (it.t === 9) qText = t('q_civilian_birthday_when', { name: v(entry,'civilian') });
        else if (it.t === 10) qText = t('q_cure_birthday_when', { name: v(entry,'transformed') });

        // 正答
        const correctAnswer =
            it.t === 7 ? v(entry,'father')
          : it.t === 8 ? v(entry,'mother')
          : (it.t === 9 || it.t === 10) ? v(entry,'birthday')
          : v(entry, fieldCodeToKey(typeToFieldCode(it.t)));

        // ユーザー解答（正解なら選択データを持っていない → 正答と同じ）
        let userAnswer;
        if (it.wrong === 0) {
          userAnswer = correctAnswer;
        } else {
          const key = fieldCodeToKey(it.sf);
          const userEntry = it.si >= 0 ? quizData[it.si] : null;
          userAnswer = (userEntry && key) ? v(userEntry, key) : '(?)';
        }

        results.push({
          entryIndex: it.i,
          type: it.t,
          questionText: qText,
          correct: userAnswer === correctAnswer,
          correctAnswer,
          userAnswer,
          // 共有復元でも言語切替で再構成できるように保持
          selIndex: (it.wrong === 0) ? -1 : it.si,
          selFieldCode: (it.wrong === 0) ? null : it.sf,
          timeCs: it.tmCs,
          time: (it.tmCs / 100).toFixed(2)
        });

        sumCs += it.tmCs;
      });

      // 合計時間（センチ秒 → ms）
      elapsedTime = Math.min(65535, decoded.totalCs) * 10;
      endQuiz();
    })
    .catch(() => {
      // 復元失敗時はトップへ戻す
      location.href = location.origin + location.pathname;
    });
});

/*--------------------------------------------
  スタートボタン：初期UIを隠し、データ読込→開始
  - セッショントークンも並行して取得
--------------------------------------------*/
document.getElementById('start-btn').onclick = () => {
  document.getElementById('start-btn').classList.add('hidden');
  document.getElementById('precure-count')?.classList.add('hidden');
  document.getElementById('leaderboard-area')?.classList.add('hidden');
  hideLangSwitch();
  document.getElementById('timer').classList.remove('hidden');

  // データ読込とセッショントークン取得を並行実行
  Promise.all([
    fetch('data/precure.json').then(res => res.json()),
    fetchSessionToken(),
  ]).then(([data]) => {
    quizData = data;
    generateQuestions();
    questions = shuffleArray(questions); // 全体の出題順をランダムに
    startQuiz();
  }).catch(err => console.error('Failed to start quiz:', err));
};

/*--------------------------------------------
  データ読込 → 問題生成 → 出題順シャッフル → 開始
--------------------------------------------*/
function loadQuizData() {
  fetch('data/precure.json')
    .then(res => res.json())
    .then(data => {
      quizData = data;
      generateQuestions();
      questions = shuffleArray(questions); // 全体の出題順をランダムに
      startQuiz();
    })
    .catch(err => console.error('Failed to load precure.json:', err));
}

/*--------------------------------------------
  配列シャッフル（Fisher–Yates）
--------------------------------------------*/
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/*--------------------------------------------
  出題データのシリーズ優先設定
--------------------------------------------*/
const PRIORITY_SERIES = '2026';
const PRIORITY_RATE = 0.125;

/**
 * 未使用エントリの中から、指定シリーズを一定確率で優先して 1 件選ぶ
 * @param {Set<any>} usedSet 既に正解に使ったエントリ集合
 * @param {(e:any)=>boolean} predicate 条件（null 可）
 * @returns {any|null}
 */
function pickEntryWithSeriesBias(usedSet, predicate) {
  const pool = quizData.filter(e => !usedSet.has(e) && (!predicate || predicate(e)));
  if (!pool.length) return null;

  // 優先設定が無効なら通常ランダム
  if (!PRIORITY_SERIES || !PRIORITY_RATE) {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const pri = pool.filter(e => e.series === PRIORITY_SERIES);
  const oth = pool.filter(e => e.series !== PRIORITY_SERIES);

  // 片方しか無い場合はそのまま
  if (!pri.length) return oth[Math.floor(Math.random() * oth.length)];
  if (!oth.length) return pri[Math.floor(Math.random() * pri.length)];

  // 両方ある場合のみ、確率で優先シリーズを選ぶ
  const src = (Math.random() < PRIORITY_RATE) ? pri : oth;
  return src[Math.floor(Math.random() * src.length)];
}

/*--------------------------------------------
  ダミー候補抽出
  - 同一人物の別形態（同じ質問キーで答えだけ違う）は除外
--------------------------------------------*/
function pickCandidate(arr, type, correctItem) {
  const e = arr[Math.floor(Math.random() * arr.length)];
  if (!e) return null;

  const qa = QANDA[type];
  if (qa) {
    const sameQ = (v(e, qa.questionKey) === v(correctItem, qa.questionKey));
    const diffA = (v(e, qa.answerKey)   !== v(correctItem, qa.answerKey));
    if (sameQ && diffA) return null; // 「同一人物の別形態」などは除外
  }
  return pickAnswerByType(e, type);
}
function pickAnswerByType(entry, type) {
  switch (type) {
    case 1: case 6: return v(entry,'civilian');
    case 2: case 4: return v(entry,'voice');
    case 3: case 5: return v(entry,'transformed');
    default:        return null;
  }
}

function buildQuestionText(type, entry) {
  switch (type) {
    case 1: return t('q_cure_transform_who', { name: v(entry,'transformed') });
    case 2: return t('q_cure_actor_who', { name: v(entry,'transformed') });
    case 3: return t('q_transform_who', { name: v(entry,'civilian') });
    case 4: return t('q_civilian_actor_who', { name: v(entry,'civilian') });
    case 5: return t('q_actor_who', { name: v(entry,'voice') });
    case 6: return t('q_actor_who', { name: v(entry,'voice') });

    // 追加問題
    case 7: return t('q_civilian_father_who', { name: v(entry,'civilian') });
    case 8: return t('q_civilian_mother_who', { name: v(entry,'civilian') });
    case 9: return t('q_civilian_birthday_when', { name: v(entry,'civilian') });
    case 10:return t('q_cure_birthday_when', { name: v(entry,'transformed') });
    default: return '';
  }
}

function answerKeyByType(type) {
  if (type === 7) return 'father';
  if (type === 8) return 'mother';
  if (type === 9 || type === 10) return 'birthday';
  return fieldCodeToKey(typeToFieldCode(type));
}

function rebuildQuestionsForLang() {
  if (!Array.isArray(questions) || !questions.length) return;

  questions.forEach(q => {
    const entry = quizData[q.entryIndex];
    if (!entry) return;

    q.question = buildQuestionText(q.type, entry);

    const aKey = answerKeyByType(q.type);
    q.correct = v(entry, aKey);

    if (Array.isArray(q.choiceEntryIndices) && q.choiceEntryIndices.length) {
      q.choices = q.choiceEntryIndices.map(i => v(quizData[i], aKey));
    }
  });
}

function rebuildResultsForLang() {
  if (!Array.isArray(results) || !results.length) return;

  results.forEach(r => {
    const entry = quizData[r.entryIndex];
    if (!entry) return;

    // 問題文
    r.questionText = buildQuestionText(r.type, entry);

    // 正答
    const correctKey = answerKeyByType(r.type);
    r.correctAnswer = v(entry, correctKey);

    // ユーザー解答
    // - 正解時（共有短縮時も含む）は「選択情報を持たない」ため正答と同じ
    // - 不正解時は selIndex / selFieldCode から復元
    if (r.selIndex != null && r.selIndex >= 0 && r.selFieldCode != null) {
      const selKey = fieldCodeToKey(r.selFieldCode);
      if (selKey) {
        r.userAnswer = v(quizData[r.selIndex], selKey);
      } else {
        r.userAnswer = r.userAnswer ?? r.correctAnswer;
      }
    } else {
      r.userAnswer = r.correctAnswer;
    }

    r.correct = (r.userAnswer === r.correctAnswer);
  });
}

function refreshLanguageSensitiveUI() {
  // タイマー
  const timer = document.getElementById('timer');
  if (timer) {
    // 結果画面：確定値で固定（絶対に再計算しない）
    if (resultTimerSec != null) {
      timer.textContent = formatSeconds(resultTimerSec);
    } else if (startTime) {
      // 出題中：進行中の elapsedTime から表示（進んでOK）
      timer.textContent = formatSeconds(elapsedTime / 1000);
    }
  }

  // 出題中なら問題文と選択肢を差し替え
  const startBtn = document.getElementById('start-btn');
  const inQuiz = startBtn && startBtn.classList.contains('hidden') && Array.isArray(questions) && questions.length && currentQuestion < questions.length;
  const hasResult = document.getElementById('result-area') && document.getElementById('result-area').innerHTML.trim() !== '';

  if (hasResult) {
    // 結果画面の文言差し替え（再描画）
    endQuiz();
    return;
  }

  if (inQuiz) {
    showQuestion();
  }
}

/*--------------------------------------------
  問題生成（声優2・その他7・追加1）
  - 正解に使ったキャラは重複させない
  - 誤答は可能なら同シリーズ70%優先
--------------------------------------------*/
function generateQuestions() {
  questions = [];
  const used = new Set(); // 正解に使ったエントリ
  let vCount = 0, oCount = 0;

  // 無限ループ防止（データ欠損が多い場合の保険）
  let guard = 0;

  // 声優2問（type: 2/4/5/6 からランダム）
  guard = 0;
  while (vCount < 2 && guard++ < 2000) {
    const type = [2, 4, 5, 6][Math.floor(Math.random() * 4)];

    // series 優先確率を適用しつつ、該当 type の回答が作れるものだけ候補にする
    const entry = pickEntryWithSeriesBias(used, (e) => !!pickAnswerByType(e, type));
    if (!entry) break;

    let q = '', a = '';
    a = pickAnswerByType(entry, type);
    if (!a) continue; // 未定義（空）なら問題にしない
    q = buildQuestionText(type, entry);

    const choices = [a];
    while (choices.length < 4) {
      const same  = quizData.filter(e => e.series === entry.series);
      const other = quizData.filter(e => e.series !== entry.series);
      const from  = (Math.random() < 0.7 && same.length) ? same : other;
      const cand  = pickCandidate(from, type, entry);
      if (!cand || choices.includes(cand)) continue;
      choices.push(cand);
    }
    choices.sort(() => Math.random() - 0.5);

    const qType = (typeof type !== 'undefined') ? type : typeCode;
    const aKey = answerKeyByType(qType);
    const choiceEntryIndices = choices.map(c => quizData.findIndex(e => v(e, aKey) === c));

    questions.push({
      question: q,
      choices,
      correct: a,
      type,
      entryIndex: quizData.indexOf(entry),
      choiceEntryIndices
    });
    used.add(entry);
    vCount++;
  }


  // その他7問（type: 1/3）
  guard = 0;
  while (oCount < 7 && guard++ < 4000) {
    const type = [1, 3][Math.floor(Math.random() * 2)];

    const entry = pickEntryWithSeriesBias(used, (e) => !!pickAnswerByType(e, type));
    if (!entry) break;

    let q = '', a = '';
    a = pickAnswerByType(entry, type);
    if (!a) continue; // 未定義（空）なら問題にしない
    q = buildQuestionText(type, entry);

    const choices = [a];
    while (choices.length < 4) {
      const same  = quizData.filter(e => e.series === entry.series);
      const other = quizData.filter(e => e.series !== entry.series);
      const from  = (Math.random() < 0.7 && same.length) ? same : other;
      const cand  = pickCandidate(from, type, entry);
      if (!cand || choices.includes(cand)) continue;
      choices.push(cand);
    }
    choices.sort(() => Math.random() - 0.5);

    const qType = (typeof type !== 'undefined') ? type : typeCode;
    const aKey = answerKeyByType(qType);
    const choiceEntryIndices = choices.map(c => quizData.findIndex(e => v(e, aKey) === c));

    questions.push({
      question: q,
      choices,
      correct: a,
      type,
      entryIndex: quizData.indexOf(entry),
      choiceEntryIndices
    });
    used.add(entry);
    oCount++;
  }

  // 追加1問（父30%／母30%／誕生日A20%／誕生日B20%）
  const patterns = [
    { key: 'father',    p: 0.3 },
    { key: 'mother',    p: 0.3 },
    { key: 'birthdayA', p: 0.2 },
    { key: 'birthdayB', p: 0.2 }
  ];
  let roll = Math.random(), acc = 0, sel = null;
  for (const p of patterns) { acc += p.p; if (roll < acc) { sel = p.key; break; } }

  const addEntry = pickEntryWithSeriesBias(used, (e) => {
    if (sel === 'father') return !!v(e,'father');
    if (sel === 'mother') return !!v(e,'mother');
    if (sel === 'birthdayA' || sel === 'birthdayB') return !!v(e,'birthday');
    return false;
  });

  if (addEntry) {
    let q = '', a = '', typeCode = 0;
    if (sel === 'father')     { q = t('q_civilian_father_who', { name: v(addEntry,'civilian') });   a = v(addEntry,'father');   typeCode = 7;  }
    else if (sel === 'mother'){ q = t('q_civilian_mother_who', { name: v(addEntry,'civilian') });   a = v(addEntry,'mother');   typeCode = 8;  }
    else if (sel === 'birthdayA'){ q = t('q_civilian_birthday_when', { name: v(addEntry,'civilian') }); a = v(addEntry,'birthday'); typeCode = 9;  }
    else                      { q = t('q_cure_birthday_when', { name: v(addEntry,'transformed') });     a = v(addEntry,'birthday'); typeCode = 10; }

    // 誤答候補：可能な限り同シリーズから
    const fieldKey = (sel === 'father') ? 'father' : (sel === 'mother') ? 'mother' : 'birthday';
    const same  = quizData.filter(e => e.series === addEntry.series && v(e, fieldKey));
    const other = quizData.filter(e => e.series !== addEntry.series && v(e, fieldKey));

    const choices = [a];
    let tries = 0;
    while (choices.length < 4 && tries < 200) {
      tries++;
      const from = (Math.random() < 0.7 && same.length) ? same : other;
      const ce = from[Math.floor(Math.random() * from.length)];
      if (!ce) continue;
      const cand = v(ce, fieldKey);
      if (!cand || choices.includes(cand)) continue;
      choices.push(cand);
    }
    if (choices.length < 4) {
      const pool = quizData.filter(e => v(e, fieldKey));
      for (const e of pool) {
        const cand = v(e, fieldKey);
        if (cand && !choices.includes(cand)) choices.push(cand);
        if (choices.length >= 4) break;
      }
    }

    choices.sort(() => Math.random() - 0.5);

    const qType = (typeof type !== 'undefined') ? type : typeCode;
    const aKey = answerKeyByType(qType);
    const choiceEntryIndices = choices.map(c => quizData.findIndex(e => v(e, aKey) === c));

    questions.push({
      question: q,
      choices,
      correct: a,
      type: typeCode,
      additional: true,
      entryIndex: quizData.indexOf(addEntry),
      choiceEntryIndices
    });
  }
}

/*--------------------------------------------
  クイズ開始 & タイマー更新
  - 10ms刻みで表示
  - 合計が上限超過した瞬間にリセット
--------------------------------------------*/
function startQuiz() {
  currentQuestion = 0;
  results = [];
  elapsedTime = 0;

  startTime = Date.now();
  lastAnswerTime = startTime;

  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 10);

  showQuestion();
}
function updateTimer() {
  elapsedTime = Date.now() - startTime;
  const s = elapsedTime / 1000;
  document.getElementById('timer').textContent = formatSeconds(s);

  if (s > TOTAL_LIMIT) {
    clearInterval(timerInterval);
    resetToHome(); // 結果を出さず初期化
  }
}

/*--------------------------------------------
  初期画面へ完全リセット
  - UIと状態を初期化し、?r を除去して純粋な初期表示に戻す
--------------------------------------------*/
function resetToHome() {
  showLangSwitch();
  questions = [];
  results = [];
  currentQuestion = 0;
  elapsedTime = 0;
  resultTimerSec = null; // 結果確定時間リセット
  sessionToken = null;

  document.getElementById('result-area').innerHTML = '';
  document.getElementById('timer').textContent = formatSeconds(0);
  document.getElementById('timer').classList.add('hidden');
  document.getElementById('start-btn').classList.remove('hidden');
  document.getElementById('precure-count')?.classList.remove('hidden');
  document.getElementById('lang-switch')?.classList.remove('hidden');
  document.getElementById('retry-btn').classList.add('hidden');
  document.getElementById('tweet-btn').classList.add('hidden');
  document.getElementById('question-area').innerHTML = '';
  document.getElementById('choices-area').innerHTML = '';
  document.getElementById('name-input-area')?.classList.add('hidden');
  document.getElementById('name-error')?.classList.add('hidden');
  document.getElementById('name-pending-message')?.classList.add('hidden');

  // 共有パラメータを消す
  history.replaceState(null, '', location.pathname);

  // ランキングを再表示
  renderLeaderboard();
}

/*--------------------------------------------
  出題表示：問題文と4択ボタン
--------------------------------------------*/
function showQuestion() {
  if (currentQuestion >= questions.length) { endQuiz(); return; }

  const q = questions[currentQuestion];
  document.getElementById('question-area').textContent = q.question;

  const area = document.getElementById('choices-area');
  area.innerHTML = '';

  q.choices.forEach(choice => {
    const b = document.createElement('button');
    b.textContent = choice;
    b.className = 'choice';
    b.onclick = () => { b.blur(); answer(choice); };
    area.appendChild(b);
  });
}

/*--------------------------------------------
  回答処理
  - 各問の経過秒（小数第2位まで）を測定
  - 各問上限超過時は結果保存せず初期化
  - 共有のため、ユーザーが押した選択値の由来も（可能なら）記録
--------------------------------------------*/
function answer(selectedChoice) {
  const now = Date.now();
  const deltaS = (now - lastAnswerTime) / 1000;
  lastAnswerTime = now;

  // 各問の上限超過 → 即リセット（結果なし）
  if (deltaS > PERQ_LIMIT) {
    clearInterval(timerInterval);
    resetToHome();
    return;
  }

  const q = questions[currentQuestion];
  const isCorrect = (selectedChoice === q.correct);

  // 共有用に選択の出典（どの要素のどのカラムか）を推測
  const fieldCode = typeToFieldCode(q.type);
  const fieldKey  = fieldCodeToKey(fieldCode);
  let selIndex = -1;
  let selFieldCode = fieldCode;

  if (fieldKey) {
    selIndex = quizData.findIndex(e => v(e, fieldKey) === selectedChoice);
    if (selIndex < 0) {
      // 想定外のカラムに該当している可能性（例：氏名と誕生日など）
      for (const c of [1,2,3,4,5,6].filter(c => c !== fieldCode)) {
        const k = fieldCodeToKey(c);
        if (!k) continue;
        const idx = quizData.findIndex(e => v(e, k) === selectedChoice);
        if (idx >= 0) { selIndex = idx; selFieldCode = c; break; }
      }
    }
  }

  results.push({
    questionText : q.question,
    correct      : isCorrect,
    correctAnswer: q.correct,
    userAnswer   : selectedChoice,
    time         : deltaS.toFixed(2),
    entryIndex   : q.entryIndex,
    type         : q.type,
    selIndex,
    selFieldCode
  });

  currentQuestion++;
  showQuestion();
}

/*--------------------------------------------
  結果表示 & 共有URL生成 & ランキング判定
  - 詳細結果（各問の○×・時間・正答）
  - 共有URLを作ってツイート誘導
  - 共有ビュー時はツイート非表示／「あそんでみる」に文言変更
  - ランクインならば名前入力UIを表示
--------------------------------------------*/
function endQuiz() {
  clearInterval(timerInterval);

  // 結果画面に入った瞬間の秒数を確定
  resultTimerSec = elapsedTime / 1000;

  document.getElementById('question-area').innerHTML = t('result_heading_html');
  document.getElementById('choices-area').innerHTML  = '';

  const resArea = document.getElementById('result-area');
  resArea.innerHTML = '';

  let correctCount = 0;

  // 各問の詳細
  results.forEach((r, i) => {
    const d = document.createElement('div');
    d.className = 'result-detail';

    const heading = document.createElement('div');
    heading.className = 'result-heading';
    heading.innerHTML = `<strong>${t('result_q_heading', { n: (i + 1) })}</strong>`;

    const summary = document.createElement('div');
    summary.className = 'result-summary';
    summary.textContent = `${r.questionText} ⇒ ${r.userAnswer}`;

    const resultLine = document.createElement('div');
    resultLine.className = 'result-line';
    if (r.correct) {
      resultLine.innerHTML = `<span class="result-icon correct">${t('result_correct')}</span> (${t('result_time', { sec: r.time })})`;
      correctCount++;
    } else {
      resultLine.innerHTML = `<span class="result-icon incorrect">${t('result_incorrect')}</span> (${t('result_time', { sec: r.time })}) ${t('result_correct_answer', { ans: r.correctAnswer })}`;
    }

    d.appendChild(heading);
    d.appendChild(summary);
    d.appendChild(resultLine);
    resArea.appendChild(d);
  });

  // 合計時間とメッセージ
  const totalSec  = elapsedTime / 1000;
  const totalText = totalSec.toFixed(2);

  // ほめコメント
  let praise = '';
  if (correctCount === 10)      praise = t('praise_perfect');
  else if (correctCount >= 7)   praise = t('praise_very_good');
  else if (correctCount >= 4)   praise = t('praise_good');
  else if (correctCount >= 1)   praise = t('praise_close');
  else                          praise = t('praise_finish');

  // はやさコメント
  let speedComment = '';
  if (totalSec < 15)      speedComment = t('speed_very_fast');
  else if (totalSec < 30) speedComment = t('speed_fast');
  else if (totalSec < 60) speedComment = t('speed_ok');
  else                    speedComment = t('speed_think');

  // 合計スコア表示
  resArea.innerHTML += t('result_score_time_html', { correct: correctCount, sec: totalText });
  resArea.innerHTML += t('result_praise_speed_html', { praise, speed: speedComment });

  // ボタン設定
  const tweetBtn = document.getElementById('tweet-btn');
  const retryBtn = document.getElementById('retry-btn');

  // 共有URL生成（合計は16bit上限で丸め、エンコード）
  const totalCs16 = Math.min(65535, Math.max(0, Math.round(totalSec * 100)));
  const shareParam = encodeResultsBinary(results, totalCs16 / 100);
  const shareUrl   = `${location.origin}${location.pathname}?r=${shareParam}`;

  // 結果画面になった時点で、URLを共有形式に更新（コピー共有しやすくする）
  try { history.replaceState(null, '', `${location.pathname}?r=${shareParam}`); } catch (_) {}

  // ツイートボタン設定
  if (tweetBtn) {
    // 共有URL（他人の結果）で開いた場合は表示しない
    if (isSharedView) {
      tweetBtn.classList.add('hidden');
      tweetBtn.onclick = null;
    } else {
      tweetBtn.classList.remove('hidden');
      tweetBtn.onclick = () => {
        const body = t('tweet_result', { correct: correctCount, total: 10, time: totalText });
        const text = `${body} ${praise} ${speedComment} ${shareUrl}`;
        window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');
      };
    }
  }

  // リトライボタン設定
  if (retryBtn) {
    retryBtn.textContent = t('retry');
    retryBtn.classList.remove('hidden');
    retryBtn.onclick = () => {
      // いまの言語を 1bit で保持してホームへ
      // - 英語: ?en
      // - 日本語: クエリなし
      location.href = location.origin + location.pathname + (currentLang === 'en' ? '?en' : '');
    };
  }

  // ランキング判定（自分のプレイ時のみ、共有ビューでは行わない）
  const totalTimeCs = Math.round(totalSec * 100);
  if (!isSharedView && API_BASE_URL && isQualified(correctCount, totalTimeCs)) {
    showNameInput(correctCount, totalTimeCs);
  }

  // ランキング表示
  renderLeaderboard();

  showLangSwitch();
}

/*--------------------------------------------
  ランキング：名前入力UIの表示と送信処理
  - 上位100位に入った場合のみ表示
  - 名前は16文字以内
  - 同一名義は一つまで（記録更新時のみ上書き）
  - 送信成功で承認待ちメッセージまたは記録更新メッセージを表示
--------------------------------------------*/
function showNameInput(correctCount, totalTimeCs) {
  const area = document.getElementById('name-input-area');
  const oldInput = document.getElementById('name-input');
  const oldSubmitBtn = document.getElementById('name-submit-btn');
  const errorEl = document.getElementById('name-error');

  if (!area || !oldInput || !oldSubmitBtn) return;

  // イベントリスナーの重複防止のため、先にクローンで差し替える
  const input = oldInput.cloneNode(true);
  oldInput.parentNode.replaceChild(input, oldInput);

  const submitBtn = oldSubmitBtn.cloneNode(true);
  oldSubmitBtn.parentNode.replaceChild(submitBtn, oldSubmitBtn);

  area.classList.remove('hidden');
  errorEl?.classList.add('hidden');
  input.value = '';
  input.focus();

  // 二重送信防止フラグ（非同期の隙間で複数回呼ばれることへの対策）
  let submitting = false;

  // 送信処理（ボタンクリックまたはEnterキー）
  const doSubmit = async () => {
    if (submitting) return;

    const name = input.value.trim();

    // クライアント側バリデーション（16文字＝Unicode文字数で判定）
    if (!name || [...name].length > 16) {
      if (errorEl) {
        errorEl.textContent = t('leaderboard_name_error');
        errorEl.classList.remove('hidden');
      }
      return;
    }

    // 二重送信防止：フラグ＋UI無効化
    submitting = true;
    submitBtn.disabled = true;
    input.disabled = true;

    // トークンを即座に取得して破棄（同じトークンの再送信を完全に防止）
    const token = sessionToken;
    sessionToken = null;

    if (!token) {
      if (errorEl) {
        errorEl.textContent = t('leaderboard_submit_error');
        errorEl.classList.remove('hidden');
      }
      submitting = false;
      submitBtn.disabled = false;
      input.disabled = false;
      return;
    }

    try {
      const result = await submitScoreWithToken(token, name, correctCount, totalTimeCs);

      if (result.qualified) {
        if (result.pending && result.recordUpdated === false) {
          // 承認待ちに既にベストスコアがある → 更新なし
          input.classList.add('hidden');
          submitBtn.classList.add('hidden');
          const msgEl = document.getElementById('name-input-message');
          if (msgEl) msgEl.classList.add('hidden');
          const notUpdatedEl = document.getElementById('name-pending-message');
          if (notUpdatedEl) {
            notUpdatedEl.textContent = t('leaderboard_not_updated_message');
            notUpdatedEl.classList.remove('hidden');
          }
        } else if (result.pending) {
          // 承認待ち：入力フォームを隠して承認待ちメッセージを表示
          input.classList.add('hidden');
          submitBtn.classList.add('hidden');
          const msgEl = document.getElementById('name-input-message');
          if (msgEl) msgEl.classList.add('hidden');
          const pendingEl = document.getElementById('name-pending-message');
          if (pendingEl) {
            pendingEl.textContent = t('leaderboard_pending_message');
            pendingEl.classList.remove('hidden');
          }
        } else if (result.autoApproved && result.recordUpdated === false) {
          // 同一名義で既存の記録の方が良い → 更新なし
          const entries = Array.isArray(result.entries) ? result.entries : [];
          if (entries.length) { leaderboard = entries; renderLeaderboard(); }
          input.classList.add('hidden');
          submitBtn.classList.add('hidden');
          const msgEl = document.getElementById('name-input-message');
          if (msgEl) msgEl.classList.add('hidden');
          const notUpdatedEl = document.getElementById('name-pending-message');
          if (notUpdatedEl) {
            notUpdatedEl.textContent = t('leaderboard_not_updated_message');
            notUpdatedEl.classList.remove('hidden');
          }
        } else if (result.autoApproved && Array.isArray(result.entries)) {
          // 自動承認（記録更新あり）：即時反映、完了メッセージを表示
          leaderboard = result.entries;
          renderLeaderboard();
          input.classList.add('hidden');
          submitBtn.classList.add('hidden');
          const msgEl = document.getElementById('name-input-message');
          if (msgEl) msgEl.classList.add('hidden');
          const autoEl = document.getElementById('name-pending-message');
          if (autoEl) {
            autoEl.textContent = t('leaderboard_record_updated_message');
            autoEl.classList.remove('hidden');
          }
        } else if (Array.isArray(result.entries)) {
          // ランキング即時更新（フォールバック）
          leaderboard = result.entries;
          renderLeaderboard();
          area.classList.add('hidden');
        } else if (Array.isArray(result.top20)) {
          // 旧形式のレスポンスへのフォールバック
          leaderboard = result.top20;
          renderLeaderboard();
          area.classList.add('hidden');
        }
      } else {
        // ランク圏外だった場合
        area.classList.add('hidden');
      }
    } catch (err) {
      // エラー表示（トークンは消費済みのためリトライ不可）
      if (errorEl) {
        errorEl.textContent = t('leaderboard_submit_error');
        errorEl.classList.remove('hidden');
      }
      submitting = false;
      submitBtn.disabled = false;
      input.disabled = false;
    }
  };

  submitBtn.addEventListener('click', doSubmit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSubmit();
  });
}
