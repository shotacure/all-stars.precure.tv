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
 **********************************************/

/*--------------------------------------------
  通常出題の Q/A マッピング
--------------------------------------------*/
const QANDA = {
  1: { questionKey: '変身後', answerKey: '変身前' },
  2: { questionKey: '変身後', answerKey: '声優' },
  3: { questionKey: '変身前', answerKey: '変身後' },
  4: { questionKey: '変身前', answerKey: '声優' },
  5: { questionKey: '声優',   answerKey: '変身後' },
  6: { questionKey: '声優',   answerKey: '変身前' }
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
  return c === 1 ? '変身前'
       : c === 2 ? '変身後'
       : c === 3 ? '声優'
       : c === 4 ? '父親'
       : c === 5 ? '母親'
       : c === 6 ? '誕生日'
       : null;
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
function encodeResultsBinary(resArr, totalSeconds) {
  const ver = 6;
  const totalCs = Math.min(65535, Math.max(0, Math.round(totalSeconds * 100)));

  // まず必要ビット数を概算（可変長）
  let totalBits = 8 + 16; // ver + totalCs
  const perItemBits = resArr.map(r => (r.correct ? 29 : 42));
  totalBits += perItemBits.reduce((a, b) => a + b, 0);

  const buf = new Uint8Array(Math.ceil(totalBits / 8));
  let p = 0;

  // ヘッダ書き込み
  p = writeBits(buf, p, ver, 8);
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
  if (ver !== 6) throw new Error('Unsupported share format');
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

  return { totalCs, items };
}

/*--------------------------------------------
  初期化（人数の即表示／共有URL復元）
--------------------------------------------*/
document.addEventListener('DOMContentLoaded', () => {
  const countElem = document.getElementById('precure-count');

  // 1) 人数の即表示（window.PRECURE_COUNT優先、なければローカルキャッシュ）
  if (countElem) {
    if (typeof window.PRECURE_COUNT === 'number') {
      countElem.textContent = `いまのプリキュア…${window.PRECURE_COUNT}にん`;
    } else {
      const cached = localStorage.getItem('precure_count');
      if (cached) countElem.textContent = `いまのプリキュア…${cached}にん`;
    }
  }

  // JSONを読み込んで人数キャッシュを更新（ブライト/ウィンディの2件を除外）
  fetch('data/precure.json')
    .then(res => res.json())
    .then(data => {
      const latest = (Array.isArray(data) ? data.length : 0) - 2;
      if (latest > 0) {
        localStorage.setItem('precure_count', String(latest));
        if (countElem && typeof window.PRECURE_COUNT !== 'number') {
          countElem.textContent = `いまのプリキュア…${latest}にん`;
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
        if (it.t === 1)      qText = `${entry['変身後']}に変身するのは誰？`;
        else if (it.t === 2) qText = `${entry['変身後']}を演じるのは誰？`;
        else if (it.t === 3) qText = `${entry['変身前']}が変身するのは誰？`;
        else if (it.t === 4) qText = `${entry['変身前']}を演じるのは誰？`;
        else if (it.t === 5) qText = `${entry['声優']}さんが演じるのは誰？`;
        else if (it.t === 6) qText = `${entry['声優']}さんが演じるのは誰？`;
        else if (it.t === 7) qText = `${entry['変身前']}のお父さんは誰？`;
        else if (it.t === 8) qText = `${entry['変身前']}のお母さんは誰？`;
        else if (it.t === 9) qText = `${entry['変身前']}の誕生日はいつ？`;
        else if (it.t === 10) qText = `${entry['変身後']}の誕生日はいつ？`;

        // 正答
        const correctAnswer =
            it.t === 7 ? entry['父親']
          : it.t === 8 ? entry['母親']
          : (it.t === 9 || it.t === 10) ? entry['誕生日']
          : entry[fieldCodeToKey(typeToFieldCode(it.t))];

        // ユーザー解答（正解なら選択データを持っていない → 正答と同じ）
        let userAnswer;
        if (it.wrong === 0) {
          userAnswer = correctAnswer;
        } else {
          const key = fieldCodeToKey(it.sf);
          const userEntry = it.si >= 0 ? quizData[it.si] : null;
          userAnswer = (userEntry && key) ? userEntry[key] : '(?)';
        }

        results.push({
          questionText: qText,
          correct: userAnswer === correctAnswer,
          correctAnswer,
          userAnswer,
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
--------------------------------------------*/
document.getElementById('start-btn').onclick = () => {
  document.getElementById('start-btn').classList.add('hidden');
  document.getElementById('precure-count')?.classList.add('hidden');
  document.getElementById('timer').classList.remove('hidden');
  loadQuizData();
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
  ダミー候補抽出
  - 同一人物の別形態（同じ質問キーで答えだけ違う）は除外
--------------------------------------------*/
function pickCandidate(arr, type, correctItem) {
  const e = arr[Math.floor(Math.random() * arr.length)];
  if (!e) return null;

  const qa = QANDA[type];
  if (qa) {
    const sameQ = (e[qa.questionKey] === correctItem[qa.questionKey]);
    const diffA = (e[qa.answerKey]   !== correctItem[qa.answerKey]);
    if (sameQ && diffA) return null; // 「同一人物の別形態」などは除外
  }
  return pickAnswerByType(e, type);
}
function pickAnswerByType(entry, type) {
  switch (type) {
    case 1: case 6: return entry['変身前'];
    case 2: case 4: return entry['声優'];
    case 3: case 5: return entry['変身後'];
    default:        return null;
  }
}

/*--------------------------------------------
  問題生成（声優2・その他7・追加1）
  - 正解に使ったキャラは重複させない
  - 誤答は可能なら同シリーズ70%優先
--------------------------------------------*/
function generateQuestions() {
  questions = [];
  const shuffled = shuffleArray([...quizData]);
  const used = new Set(); // 正解に使ったエントリ
  let vCount = 0, oCount = 0, idx = 0;

  // 声優2問（type: 2/4/5/6 からランダム）
  while (vCount < 2 && idx < shuffled.length) {
    const entry = shuffled[idx++]; if (used.has(entry)) continue;

    const type = [2, 4, 5, 6][Math.floor(Math.random() * 4)];
    let q = '', a = '';
    if (type === 2) { q = `${entry['変身後']}を演じるのは誰？`; a = entry['声優']; }
    if (type === 4) { q = `${entry['変身前']}を演じるのは誰？`; a = entry['声優']; }
    if (type === 5) { q = `${entry['声優']}さんが演じるのは誰？`; a = entry['変身後']; }
    if (type === 6) { q = `${entry['声優']}さんが演じるのは誰？`; a = entry['変身前']; }

    const choices = [a];
    while (choices.length < 4) {
      const same  = quizData.filter(e => e['シリーズ'] === entry['シリーズ']);
      const other = quizData.filter(e => e['シリーズ'] !== entry['シリーズ']);
      const from  = (Math.random() < 0.7 && same.length) ? same : other;
      const cand  = pickCandidate(from, type, entry);
      if (!cand || choices.includes(cand)) continue;
      choices.push(cand);
    }
    choices.sort(() => Math.random() - 0.5);

    questions.push({
      question: q,
      choices,
      correct: a,
      type,
      entryIndex: quizData.indexOf(entry)
    });
    used.add(entry);
    vCount++;
  }

  // その他7問（type: 1/3）
  while (oCount < 7 && idx < shuffled.length) {
    const entry = shuffled[idx++]; if (used.has(entry)) continue;

    const type = [1, 3][Math.floor(Math.random() * 2)];
    let q = '', a = '';
    if (type === 1) { q = `${entry['変身後']}に変身するのは誰？`; a = entry['変身前']; }
    if (type === 3) { q = `${entry['変身前']}が変身するのは誰？`; a = entry['変身後']; }

    const choices = [a];
    while (choices.length < 4) {
      const same  = quizData.filter(e => e['シリーズ'] === entry['シリーズ']);
      const other = quizData.filter(e => e['シリーズ'] !== entry['シリーズ']);
      const from  = (Math.random() < 0.7 && same.length) ? same : other;
      const cand  = pickCandidate(from, type, entry);
      if (!cand || choices.includes(cand)) continue;
      choices.push(cand);
    }
    choices.sort(() => Math.random() - 0.5);

    questions.push({
      question: q,
      choices,
      correct: a,
      type,
      entryIndex: quizData.indexOf(entry)
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

  let addEntry = null;
  while (idx < shuffled.length) {
    const e = shuffled[idx++]; if (used.has(e)) continue;
    if (sel === 'father' && !e['父親']) continue;
    if (sel === 'mother' && !e['母親']) continue;
    if ((sel === 'birthdayA' || sel === 'birthdayB') && !e['誕生日']) continue;
    addEntry = e; break;
  }

  if (addEntry) {
    let q = '', a = '', typeCode = 0;
    if (sel === 'father')     { q = `${addEntry['変身前']}のお父さんは誰？`;   a = addEntry['父親'];   typeCode = 7;  }
    else if (sel === 'mother'){ q = `${addEntry['変身前']}のお母さんは誰？`;   a = addEntry['母親'];   typeCode = 8;  }
    else if (sel === 'birthdayA'){ q = `${addEntry['変身前']}の誕生日はいつ？`; a = addEntry['誕生日']; typeCode = 9;  }
    else                      { q = `${addEntry['変身後']}の誕生日はいつ？`;     a = addEntry['誕生日']; typeCode = 10; }

    // 誤答候補：可能な限り同シリーズから
    const fieldKey = (sel === 'father') ? '父親' : (sel === 'mother') ? '母親' : '誕生日';
    const same  = quizData.filter(e => e['シリーズ'] === addEntry['シリーズ'] && e[fieldKey]);
    const other = quizData.filter(e => e['シリーズ'] !== addEntry['シリーズ'] && e[fieldKey]);

    const choices = [a];
    let tries = 0;
    while (choices.length < 4 && tries < 200) {
      tries++;
      const from = (Math.random() < 0.7 && same.length) ? same : other;
      const ce = from[Math.floor(Math.random() * from.length)];
      if (!ce) continue;
      const cand = ce[fieldKey];
      if (!cand || choices.includes(cand)) continue;
      choices.push(cand);
    }
    if (choices.length < 4) {
      const pool = quizData.filter(e => e[fieldKey]);
      for (const e of pool) {
        const cand = e[fieldKey];
        if (cand && !choices.includes(cand)) choices.push(cand);
        if (choices.length >= 4) break;
      }
    }

    choices.sort(() => Math.random() - 0.5);

    questions.push({
      question: q,
      choices,
      correct: a,
      type: typeCode,
      additional: true,
      entryIndex: quizData.indexOf(addEntry)
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
  document.getElementById('timer').textContent = s.toFixed(2) + '秒';

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
  questions = [];
  results = [];
  currentQuestion = 0;
  elapsedTime = 0;

  document.getElementById('result-area').innerHTML = '';
  document.getElementById('timer').textContent = '0.00秒';
  document.getElementById('timer').classList.add('hidden');
  document.getElementById('start-btn').classList.remove('hidden');
  document.getElementById('precure-count')?.classList.remove('hidden');
  document.getElementById('retry-btn').classList.add('hidden');
  document.getElementById('tweet-btn').classList.add('hidden');
  document.getElementById('question-area').innerHTML = '';
  document.getElementById('choices-area').innerHTML = '';

  // 共有パラメータを消す
  history.replaceState(null, '', location.pathname);
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
    selIndex = quizData.findIndex(e => e[fieldKey] === selectedChoice);
    if (selIndex < 0) {
      // 想定外のカラムに該当している可能性（例：氏名と誕生日など）
      for (const c of [1,2,3,4,5,6].filter(c => c !== fieldCode)) {
        const k = fieldCodeToKey(c);
        if (!k) continue;
        const idx = quizData.findIndex(e => e[k] === selectedChoice);
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
  結果表示 & 共有URL生成
  - 詳細結果（各問の○×・時間・正答）
  - 共有URLを作ってツイート誘導
  - 共有ビュー時はツイート非表示／「あそんでみる」に文言変更
--------------------------------------------*/
function endQuiz() {
  clearInterval(timerInterval);

  document.getElementById('question-area').innerHTML = '🎀けっかはっぴょう🎀';
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
    heading.innerHTML = `<strong>だい${i + 1}もん</strong>`;

    const summary = document.createElement('div');
    summary.className = 'result-summary';
    summary.textContent = `${r.questionText} ⇒ ${r.userAnswer}`;

    const resultLine = document.createElement('div');
    resultLine.className = 'result-line';
    if (r.correct) {
      resultLine.innerHTML = `<span class="result-icon correct">○せいかい</span> (${r.time}びょう)`;
      correctCount++;
    } else {
      resultLine.innerHTML = `<span class="result-icon incorrect">×ざんねん</span> (${r.time}びょう) せいかい：${r.correctAnswer}`;
    }

    d.appendChild(heading);
    d.appendChild(summary);
    d.appendChild(resultLine);
    resArea.appendChild(d);
  });

  // 合計時間とメッセージ
  const totalSec  = elapsedTime / 1000;
  const totalText = totalSec.toFixed(2);

  let praise = '';
  if (correctCount === 10)      praise = 'すごい！パーフェクトだよ！';
  else if (correctCount >= 7)   praise = 'よくできました！';
  else if (correctCount >= 4)   praise = 'がんばったね！つぎはもっといけるよ！';
  else if (correctCount >= 1)   praise = 'おしかったね！またちょうせんしよう！';
  else                          praise = 'さいごまでがんばったね！';

  let speedComment = '';
  if (totalSec < 10)      speedComment = 'スピードもカンペキ！すっごくはやい！';
  else if (totalSec < 30) speedComment = 'なかなかはやいよ！';
  else if (totalSec < 60) speedComment = 'いいペースだったね！';
  else                    speedComment = 'じっくりかんがえてがんばったね！';

  resArea.innerHTML +=
    `<h2>せいかいしたかず：${correctCount}/10<br>かかったじかん：${totalText}びょう</h2>`;
  resArea.innerHTML += `<p>${praise}<br>${speedComment}</p>`;

  const tweetBtn = document.getElementById('tweet-btn');
  const retryBtn = document.getElementById('retry-btn');

  // 共有ビュー時：ツイート非表示・「あそんでみる」ボタン
  if (isSharedView) {
    tweetBtn?.classList.add('hidden');
    if (retryBtn) {
      retryBtn.textContent = 'あそんでみる';
      retryBtn.classList.remove('hidden');
      retryBtn.onclick = () => { location.href = location.origin + location.pathname; };
    }
    return;
  }

  // 共有URL生成（合計は16bit上限で丸め、エンコード）
  const totalCs16 = Math.min(65535, Math.max(0, Math.round(totalSec * 100)));
  const shareParam = encodeResultsBinary(results, totalCs16 / 100);
  const shareUrl   = `${location.origin}${location.pathname}?r=${shareParam}`;

  if (tweetBtn) {
    tweetBtn.classList.remove('hidden');
    tweetBtn.onclick = () => {
      const text = `#プリキュアオールスターズいえるかなクイズ で${correctCount}/10問正解、タイムは${totalText}秒でした！ ${praise} ${speedComment} ${shareUrl}`;
      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');
    };
  }

  if (retryBtn) {
    retryBtn.textContent = 'もういちどあそぶ';
    retryBtn.classList.remove('hidden');
    retryBtn.onclick = () => { location.reload(); };
  }
}
