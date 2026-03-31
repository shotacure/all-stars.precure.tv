/**********************************************
 * imode.js — iモード風表示パッチ
 *
 * /?i でアクセスした場合に発動する。
 * script.js の関数をモンキーパッチして
 * 1999年頃のiモード携帯電話風の画面を再現する。
 *
 * 表示仕様:
 *   - 全角10文字×9行程度の表示領域
 *   - 白背景・DotGothic16フォント
 *   - 全角カタカナは半角カタカナに変換
 *   - リンク：青色＋下線、ホバーで青地に白字
 *   - タイマー表示の抑制（内部計測は継続）
 *   - 言語切替の無効化（日本語固定）
 *   - 共有URLは通常版と同一（?i を含まない）
 **********************************************/

(function() {
  'use strict';
  if (!window.IMODE) return;

  /*--------------------------------------------
    全角カタカナ → 半角カタカナ変換マップ
    濁音・半濁音は2文字（基字＋濁点/半濁点）に分解
  --------------------------------------------*/
  var KANA_MAP = {
    'ガ':'ｶﾞ','ギ':'ｷﾞ','グ':'ｸﾞ','ゲ':'ｹﾞ','ゴ':'ｺﾞ',
    'ザ':'ｻﾞ','ジ':'ｼﾞ','ズ':'ｽﾞ','ゼ':'ｾﾞ','ゾ':'ｿﾞ',
    'ダ':'ﾀﾞ','ヂ':'ﾁﾞ','ヅ':'ﾂﾞ','デ':'ﾃﾞ','ド':'ﾄﾞ',
    'バ':'ﾊﾞ','ビ':'ﾋﾞ','ブ':'ﾌﾞ','ベ':'ﾍﾞ','ボ':'ﾎﾞ',
    'パ':'ﾊﾟ','ピ':'ﾋﾟ','プ':'ﾌﾟ','ペ':'ﾍﾟ','ポ':'ﾎﾟ',
    'ヴ':'ｳﾞ',
    'ァ':'ｧ','ア':'ｱ','ィ':'ｨ','イ':'ｲ','ゥ':'ｩ',
    'ウ':'ｳ','ェ':'ｪ','エ':'ｴ','ォ':'ｫ','オ':'ｵ',
    'カ':'ｶ','キ':'ｷ','ク':'ｸ','ケ':'ｹ','コ':'ｺ',
    'サ':'ｻ','シ':'ｼ','ス':'ｽ','セ':'ｾ','ソ':'ｿ',
    'タ':'ﾀ','チ':'ﾁ','ツ':'ﾂ','テ':'ﾃ','ト':'ﾄ',
    'ナ':'ﾅ','ニ':'ﾆ','ヌ':'ﾇ','ネ':'ﾈ','ノ':'ﾉ',
    'ハ':'ﾊ','ヒ':'ﾋ','フ':'ﾌ','ヘ':'ﾍ','ホ':'ﾎ',
    'マ':'ﾏ','ミ':'ﾐ','ム':'ﾑ','メ':'ﾒ','モ':'ﾓ',
    'ャ':'ｬ','ヤ':'ﾔ','ュ':'ｭ','ユ':'ﾕ','ョ':'ｮ',
    'ヨ':'ﾖ','ラ':'ﾗ','リ':'ﾘ','ル':'ﾙ','レ':'ﾚ',
    'ロ':'ﾛ','ワ':'ﾜ','ヲ':'ｦ','ン':'ﾝ',
    'ッ':'ｯ','ー':'ｰ',
    '。':'｡','「':'｢','」':'｣','、':'､','・':'･'
  };
  var kanaRegex = new RegExp('(' + Object.keys(KANA_MAP).join('|') + ')', 'g');

  /** 絵文字を記号文字に置換する */
  var EMOJI_MAP = {
    '\u{1F380}': '☆',  /* 🎀 リボン */
    '\u{1F3C6}': '★',  /* 🏆 トロフィー */
    '\u{1F496}': '♪',  /* 💖 ハート */
    '\u{1F389}': '☆',  /* 🎉 クラッカー */
    '\u{1F31F}': '★',  /* 🌟 星 */
    '\u{2728}':  '☆',  /* ✨ きらきら */
  };
  var emojiMapRegex = new RegExp('(' + Object.keys(EMOJI_MAP).join('|') + ')', 'gu');
  /* マップにない絵文字（Supplementary Plane）を一括で◆に置換 */
  var remainingEmojiRegex = /[\u{1F000}-\u{1FFFF}]/gu;

  function replaceEmoji(str) {
    return str
      .replace(emojiMapRegex, function(m) { return EMOJI_MAP[m] || '◆'; })
      .replace(remainingEmojiRegex, '◆');
  }

  /** 全角カタカナを半角カタカナに変換し、絵文字を記号に置換する */
  function toHankaku(str) {
    if (!str || typeof str !== 'string') return str;
    return replaceEmoji(str.replace(kanaRegex, function(m) { return KANA_MAP[m] || m; }));
  }

  /*--------------------------------------------
    DotGothic16 フォントの動的読み込み
  --------------------------------------------*/
  var fontLink = document.createElement('link');
  fontLink.rel = 'stylesheet';
  fontLink.href = 'https://fonts.googleapis.com/css2?family=DotGothic16&family=Kaisei+Decol&display=swap';
  document.head.appendChild(fontLink);

  /*--------------------------------------------
    iモード用CSS注入
    - 携帯フレームなし、画面だけをビューポートいっぱいに表示
    - iモード画面風のアスペクト比（8:13）を維持
    - 全角10文字×約6行の文字グリッド
    - 白背景
  --------------------------------------------*/
  var style = document.createElement('style');
  style.textContent = [
    '/* === iモード風スタイル（画面のみ・ビューポート全面） === */',

    /* 背景を暗色にして画面外を枠のように見せる */
    'body.imode{background:#222;display:flex;justify-content:center;align-items:center;min-height:100vh;min-height:100dvh;padding:0;margin:0;overflow:hidden;font-family:"DotGothic16",monospace;}',

    /* quiz-container を iモード画面として表示 */
    /* iモード画面風アスペクト比 8:13 */
    /* フォントサイズはビューポート基準で全角10文字×約9行になるよう調整 */
    'body.imode #quiz-container{',
    '  aspect-ratio:8/13;',
    '  max-width:100vw;',
    '  max-height:100vh;max-height:98dvh;',
    '  height:98dvh;',
    '  width:auto;',
    '  background:#fff;',
    '  border-radius:0;',
    '  box-shadow:none;',
    '  margin:0;',
    '  padding:0.4em 0.5em 0.8em;',
    '  overflow-y:auto;overflow-x:hidden;',
    '  font-family:"DotGothic16",monospace;',
    /* フォントサイズ: 画面幅 = height * 8/13。全角10文字 = 10em = 幅 */
    /* 幅基準: height*8/130 ≈ 6.15dvh、高さ基準: height/21 ≈ 4.76dvh */
    /* 小さい方を採用して約9行表示 */
    '  font-size:min(calc(98dvh / 21), calc(98dvh * 8 / 130));',
    '  line-height:1.6;',
    '  color:#222;',
    '  text-align:left;',
    '  scrollbar-width:thin;scrollbar-color:#888 #fff;',
    '}',
    'body.imode #quiz-container::-webkit-scrollbar{width:3px;}',
    'body.imode #quiz-container::-webkit-scrollbar-thumb{background:#888;border-radius:2px;}',
    'body.imode #quiz-container::-webkit-scrollbar-track{background:#fff;}',

    /* 横幅がビューポート幅で制約される場合（横長画面向け） */
    '@media screen and (max-aspect-ratio:8/13){',
    '  body.imode #quiz-container{width:100vw;height:auto;max-height:none;',
    '    font-size:min(calc(100vw / 8), calc(100vw * 13 / 8 / 21));',
    '  }',
    '}',

    /* .hidden が button スタイルに負けないよう詳細度を確保 */
    'body.imode .hidden{display:none!important;}',

    /* ヘッダ画像・タイマー・言語切替を非表示 */
    'body.imode .header-image{display:none!important;}',
    'body.imode #timer{display:none!important;}',
    'body.imode #lang-switch{display:none!important;}',

    /* フッター非表示（iモード用フッターで代替） */
    'body.imode #pageFooter{display:none!important;}',

    /* 全要素をDotGothic16に統一し、ボールドを無効化 */
    'body.imode,body.imode *{font-family:"DotGothic16",monospace!important;font-weight:normal!important;}',

    /* ランキング・名前入力UIを非表示（iモード時代には無い機能） */
    'body.imode #leaderboard-area{display:none!important;}',
    'body.imode #name-input-area{display:none!important;}',

    /* 全般テキスト */
    'body.imode h1,body.imode h2{font-family:"DotGothic16",monospace;font-size:1em;color:#222;text-shadow:none;margin:0.3em 0;}',
    'body.imode #precure-count{font-family:"DotGothic16",monospace;color:#222;font-size:1em;text-shadow:none;margin:0.2em 0;text-align:center;}',

    /* リンク：青色＋下線、ホバーで青地に白字 */
    'body.imode a{color:#0000cc;text-decoration:underline;}',
    'body.imode a:hover{color:#fff;background-color:#0000cc;text-decoration:none;}',

    /* ボタン類（iモード風リンクスタイル） */
    'body.imode button{display:block;width:100%;background:none;border:none;color:#0000cc;text-decoration:underline;font-family:"DotGothic16",monospace;font-size:1em;padding:0.2em 0;cursor:pointer;text-align:left;box-shadow:none;border-radius:0;margin:0.1em 0;transition:none;transform:none;}',
    'body.imode button:hover{color:#fff;background-color:#0000cc;text-decoration:none;transform:none;}',
    'body.imode button:disabled{color:#888;background:none;text-decoration:none;cursor:default;transform:none;}',

    /* 選択肢ボタン */
    'body.imode .choice{display:block;width:100%;margin:0.1em 0;padding:0.15em 0.2em;text-align:left;}',

    /* 問題エリア */
    'body.imode #question-area{margin:0.3em 0;font-size:1em;}',

    /* 結果エリア */
    'body.imode .result-detail{border-bottom:1px dotted #888;padding:0.2em 0;margin:0;background:none;}',
    'body.imode .result-heading{font-size:1em;color:#222;font-family:"DotGothic16",monospace;}',
    'body.imode .result-summary{font-size:1em;color:#333;}',
    'body.imode .result-line{font-size:1em;color:#444;}',
    'body.imode .correct{color:#006600;}',
    'body.imode .incorrect{color:#cc0000;}',

    /* ランキング */
    'body.imode #leaderboard-area{margin:0.3em 0;}',
    'body.imode #leaderboard-title{font-size:1em;color:#222;text-align:center;margin-bottom:0.2em;}',
    'body.imode .leaderboard-table{width:100%;border-collapse:collapse;font-size:1em;}',
    'body.imode .leaderboard-table thead{background-color:#ddd;color:#222;}',
    'body.imode .leaderboard-table th,body.imode .leaderboard-table td{padding:0.15em 0.2em;text-align:center;border-bottom:1px dotted #888;}',
    'body.imode .leaderboard-table tbody tr:nth-child(odd){background:#f8f8f8;}',
    'body.imode .leaderboard-table tbody tr:nth-child(even){background:#fff;}',
    'body.imode .leaderboard-table tbody tr:nth-child(1) td:first-child,body.imode .leaderboard-table tbody tr:nth-child(2) td:first-child,body.imode .leaderboard-table tbody tr:nth-child(3) td:first-child{color:#222;}',

    /* 名前入力 */
    'body.imode #name-input-area{margin:0.3em 0;padding:0.3em;background:#f0f0f0;border:1px dotted #888;border-radius:0;}',
    'body.imode #name-input-message{font-family:"DotGothic16",monospace;font-size:1em;color:#222;margin:0 0 0.2em;}',
    'body.imode #name-input{font-family:"DotGothic16",monospace;font-size:1em;padding:0.15em 0.3em;border:1px solid #666;border-radius:0;width:70%;background:#fff;}',
    'body.imode #name-input:focus{border-color:#333;box-shadow:none;}',
    'body.imode #name-error{font-size:1em;color:#cc0000;margin:0.15em 0 0;}',

    /* ツイート・リトライボタン */
    'body.imode #tweet-btn,body.imode #retry-btn{font-size:1em;padding:0.2em 0;text-align:left;}',

    /* 「もとのじだいにもどる」ボタン（通常デザイン・全問正解時のみ表示） */
    /* Kaisei Decol フォントで時代の違いを演出 */
    'body.imode #imode-return-btn{background:#ff80bf!important;color:#fff!important;text-decoration:none!important;border-radius:8px!important;padding:0.5em 1em!important;text-align:center!important;box-shadow:0 2px 6px rgba(255,105,180,0.6)!important;cursor:pointer!important;margin:0.4em 0!important;display:block!important;width:100%!important;font-family:"Kaisei Decol",serif!important;}',
    'body.imode #imode-return-btn:hover{background:#ff59ac!important;color:#fff!important;}',

    /* iモード用フッター */
    '.imode-footer{margin-top:0.3em;font-size:1em;color:#555;text-align:center;border-top:1px dotted #888;padding-top:0.2em;}',

    /* iモードタイトル装飾 */
    '.imode-title-deco{font-size:1em;text-align:center;margin:0.1em 0;letter-spacing:0.05em;}',
    '.imode-hr{border:none;border-top:1px dotted #888;margin:0.3em 0;}'
  ].join('\n');
  document.head.appendChild(style);

  /*--------------------------------------------
    DOM構築：quiz-container 内に装飾要素を追加
    （携帯フレームなし、画面のみ）
  --------------------------------------------*/
  document.body.classList.add('imode');

  var qc = document.getElementById('quiz-container');

  /* タイトル装飾をquiz-containerの先頭に挿入（初期画面のみ表示） */
  var titleWrap = document.createElement('div');
  titleWrap.id = 'imode-title';
  qc.insertBefore(titleWrap, qc.firstChild);

  var deco1 = document.createElement('div');
  deco1.className = 'imode-title-deco';
  deco1.textContent = '☆★☆★☆★☆★☆';
  titleWrap.appendChild(deco1);

  var title = document.createElement('div');
  title.style.cssText = 'text-align:center;font-size:1em;margin:0.15em 0;white-space:pre-line;';
  title.textContent = 'ﾌﾟﾘｷｭｱｵｰﾙｽﾀｰｽﾞ\nいえるかなｸｲｽﾞ\n(1999ねんばん)';
  titleWrap.appendChild(title);

  var deco2 = document.createElement('div');
  deco2.className = 'imode-title-deco';
  deco2.textContent = '☆★☆★☆★☆★☆';
  titleWrap.appendChild(deco2);

  var hr = document.createElement('hr');
  hr.className = 'imode-hr';
  titleWrap.appendChild(hr);

  /* クイズ開始時にタイトルを隠す */
  document.getElementById('start-btn').addEventListener('click', function() {
    var el = document.getElementById('imode-title');
    if (el) el.classList.add('hidden');
  }, true);

  /* 共有URL表示時：DOMContentLoaded 後にスタートボタンが隠れていたらタイトルも隠す */
  document.addEventListener('DOMContentLoaded', function() {
    var startBtn = document.getElementById('start-btn');
    if (startBtn && startBtn.classList.contains('hidden')) {
      var el = document.getElementById('imode-title');
      if (el) el.classList.add('hidden');
    }
  });

  /* iモード用フッターをquiz-container末尾に追加 */
  var imodeFooter = document.createElement('div');
  imodeFooter.className = 'imode-footer';
  imodeFooter.textContent = '☆ﾌﾟﾘｷｭｱｵｰﾙｽﾀｰｽﾞいえるかなｸｲｽﾞ(1999ねんばん)☆';
  qc.appendChild(imodeFooter);

  /*--------------------------------------------
    script.js の関数をパッチ
  --------------------------------------------*/

  /* t() — i18n文字列を半角カタカナに変換（共有テキストは除外） */
  var _orig_t = t;
  t = function(key, vars) {
    var result = _orig_t(key, vars);
    /* 共有テキストは変換しない（ハッシュタグが変わるのを防止） */
    if (key === 'tweet_result') return result;
    return toHankaku(result);
  };

  /* v() — プリキュアデータ値を半角カタカナに変換 */
  var _orig_v = v;
  v = function(entry, key) {
    return toHankaku(_orig_v(entry, key));
  };

  /* applyI18nToDom() — DOM反映時にも半角変換を適用 */
  var _orig_applyI18nToDom = applyI18nToDom;
  applyI18nToDom = function() {
    _orig_applyI18nToDom();
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var attr = el.getAttribute('data-i18n-attr');
      if (attr) {
        el.setAttribute(attr, toHankaku(el.getAttribute(attr)));
      } else {
        el.textContent = toHankaku(el.textContent);
      }
    });
    document.title = toHankaku(document.title);
  };

  /* updateTimer() — タイマーDOM更新をスキップ（内部計測は継続） */
  updateTimer = function() {
    elapsedTime = Date.now() - startTime;
    var s = elapsedTime / 1000;
    if (s > TOTAL_LIMIT) {
      clearInterval(timerInterval);
      resetToHome();
    }
  };

  /* showLangSwitch() — iモードでは無効化（日本語固定） */
  showLangSwitch = function() {};

  /* showNameInput() — iモードではランキング登録UIを表示しない */
  showNameInput = function() {};

  /* renderLeaderboard() — iモードではランキング表を描画しない */
  renderLeaderboard = function() {};

  /* escapeHtml() — ランキング名前表示でも半角変換 */
  var _orig_escapeHtml = escapeHtml;
  escapeHtml = function(str) {
    return toHankaku(_orig_escapeHtml(str));
  };

  /* resetToHome() — リセット後に ?i を保持し、タイトルを再表示、時間旅行ボタンを除去 */
  var _orig_resetToHome = resetToHome;
  resetToHome = function() {
    _orig_resetToHome();
    history.replaceState(null, '', location.pathname + '?i');
    var el = document.getElementById('imode-title');
    if (el) el.classList.remove('hidden');
    var rb = document.getElementById('imode-return-btn');
    if (rb) rb.remove();
  };

  /*--------------------------------------------
    endQuiz() パッチ
    全問正解時に「もとのじだいにもどる」ボタンを追加
    通常デザインのボタンで、通常版TOPへリンクする
  --------------------------------------------*/
  var _orig_endQuiz = endQuiz;
  endQuiz = function() {
    _orig_endQuiz();
    var correctCount = results.filter(function(r) { return r.correct; }).length;
    if (correctCount === 10 && !document.getElementById('imode-return-btn')) {
      var btn = document.createElement('button');
      btn.id = 'imode-return-btn';
      btn.textContent = 'もとのじだいにもどる';
      btn.onclick = function() { location.href = location.origin + location.pathname; };
      var retryBtn = document.getElementById('retry-btn');
      if (retryBtn) retryBtn.after(btn);
    }
  };

  /*--------------------------------------------
    リトライボタンのURL修正
    endQuiz() 内で設定される onclick を上書きするため、
    キャプチャフェーズのリスナーで先に処理する
  --------------------------------------------*/
  document.getElementById('retry-btn').addEventListener('click', function(e) {
    e.stopImmediatePropagation();
    e.preventDefault();
    location.href = location.origin + location.pathname + '?i';
  }, true);

})();
