// QANDA: 質問タイプごとに対応するキー
const QANDA = {
  1: { questionKey: '変身後', answerKey: '変身前' },
  2: { questionKey: '変身後', answerKey: '声優' },
  3: { questionKey: '変身前', answerKey: '変身後' },
  4: { questionKey: '変身前', answerKey: '声優' },
  5: { questionKey: '声優',   answerKey: '変身後' },
  6: { questionKey: '声優',   answerKey: '変身前' }
};

let quizData = [];
let questions = [];
let currentQuestion = 0;
let timerInterval;
let startTime, elapsedTime = 0;
let results = [];
let lastAnswerTime;

// スタートボタン
document.getElementById('start-btn').onclick = () => {
  document.getElementById('start-btn').classList.add('hidden');
  document.getElementById('timer').classList.remove('hidden');
  loadQuizData();
};

// precure.jsonをロード
function loadQuizData() {
  fetch('data/precure.json')
    .then(res => res.json())
    .then(data => {
      quizData = data;
      generateQuestions();
      // 全体の出題順序をランダムにシャッフル
      questions = shuffleArray(questions);
      startQuiz();
    })
    .catch(err => console.error('Failed to load precure.json:', err));
}

// Fisher-Yatesシャッフル
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// generateQuestions: 声優問題2問、その他の問題7問、追加問題1問を生成する
function generateQuestions() {
  questions = [];
  const shuffledData = shuffleArray([...quizData]);
  let usedEntries = new Set();
  let voiceActorCount = 0;
  let otherCount = 0;
  let index = 0;
  
  // ■ 声優問題：2問（ケース2,4,5,6）
  while (voiceActorCount < 2 && index < shuffledData.length) {
    let entry = shuffledData[index++];
    if (usedEntries.has(entry)) continue;
    // 声優系の出題パターン：2, 4, 5, 6 のいずれか
    let types = [2, 4, 5, 6];
    let type = types[Math.floor(Math.random() * types.length)];
    let questionText = '';
    let correctAnswer = '';
    switch (type) {
      case 2:
        questionText = `${entry["変身後"]}を演じるのは誰？`;
        correctAnswer = entry["声優"];
        break;
      case 4:
        questionText = `${entry["変身前"]}を演じるのは誰？`;
        correctAnswer = entry["声優"];
        break;
      case 5:
        questionText = `${entry["声優"]}さんが演じるのは誰？`;
        correctAnswer = entry["変身後"];
        break;
      case 6:
        questionText = `${entry["声優"]}さんが演じるのは誰？`;
        correctAnswer = entry["変身前"];
        break;
    }
    let choices = [correctAnswer];
    // 同じシリーズから選ぶかは70%の確率
    while (choices.length < 4) {
      const sameSeries = quizData.filter(e => e["シリーズ"] === entry["シリーズ"]);
      const otherSeries = quizData.filter(e => e["シリーズ"] !== entry["シリーズ"]);
      const fromArray = (Math.random() < 0.7 && sameSeries.length) ? sameSeries : otherSeries;
      const candidate = pickCandidate(fromArray, type, entry);
      if (!candidate || choices.includes(candidate)) continue;
      choices.push(candidate);
    }
    choices.sort(() => Math.random() - 0.5);
    questions.push({
      question: questionText,
      choices,
      correct: correctAnswer
    });
    usedEntries.add(entry);
    voiceActorCount++;
  }
  
  // ■ その他の問題：7問（ケース1,3）
  while (otherCount < 7 && index < shuffledData.length) {
    let entry = shuffledData[index++];
    if (usedEntries.has(entry)) continue;
    let types = [1, 3];
    let type = types[Math.floor(Math.random() * types.length)];
    let questionText = '';
    let correctAnswer = '';
    switch (type) {
      case 1:
        questionText = `${entry["変身後"]}に変身するのは誰？`;
        correctAnswer = entry["変身前"];
        break;
      case 3:
        questionText = `${entry["変身前"]}が変身するのは誰？`;
        correctAnswer = entry["変身後"];
        break;
    }
    let choices = [correctAnswer];
    while (choices.length < 4) {
      const sameSeries = quizData.filter(e => e["シリーズ"] === entry["シリーズ"]);
      const otherSeries = quizData.filter(e => e["シリーズ"] !== entry["シリーズ"]);
      const fromArray = (Math.random() < 0.7 && sameSeries.length) ? sameSeries : otherSeries;
      const candidate = pickCandidate(fromArray, type, entry);
      if (!candidate || choices.includes(candidate)) continue;
      choices.push(candidate);
    }
    choices.sort(() => Math.random() - 0.5);
    questions.push({
      question: questionText,
      choices,
      correct: correctAnswer
    });
    usedEntries.add(entry);
    otherCount++;
  }
  
  // ■ 追加問題：1問
  // 追加パターンの確率設定（父親30%、母親30%、誕生日A20%、誕生日B20%）
  const additionalPatterns = [
    { key: 'father', probability: 0.3 },
    { key: 'mother', probability: 0.3 },
    { key: 'birthdayA', probability: 0.2 },
    { key: 'birthdayB', probability: 0.2 }
  ];
  let rand = Math.random();
  let cumulative = 0;
  let selectedPattern = null;
  for (const pattern of additionalPatterns) {
    cumulative += pattern.probability;
    if (rand < cumulative) {
      selectedPattern = pattern.key;
      break;
    }
  }
  
  // 追加問題として、既出のキャラクターと重複しないエントリーを探す
  let additionalEntry = null;
  while (index < shuffledData.length) {
    let entry = shuffledData[index++];
    if (usedEntries.has(entry)) continue;
    if (selectedPattern === 'father' && !entry["父親"]) continue;
    if (selectedPattern === 'mother' && !entry["母親"]) continue;
    if ((selectedPattern === 'birthdayA' || selectedPattern === 'birthdayB') && !entry["誕生日"]) continue;
    additionalEntry = entry;
    break;
  }
  
  if (additionalEntry) {
    let questionText = '';
    let correctAnswer = '';
    if (selectedPattern === 'father') {
      questionText = `${additionalEntry["変身前"]}のお父さんは誰？`;
      correctAnswer = additionalEntry["父親"];
    } else if (selectedPattern === 'mother') {
      questionText = `${additionalEntry["変身前"]}のお母さんは誰？`;
      correctAnswer = additionalEntry["母親"];
    } else if (selectedPattern === 'birthdayA') {
      questionText = `${additionalEntry["変身前"]}の誕生日はいつ？`;
      correctAnswer = additionalEntry["誕生日"];
    } else if (selectedPattern === 'birthdayB') {
      questionText = `${additionalEntry["変身後"]}の誕生日はいつ？`;
      correctAnswer = additionalEntry["誕生日"];
    }
    let choices = [correctAnswer];
    // 誤答候補は、同じシリーズ内で追加データがあるエントリーから選ぶ
    const sameSeries = quizData.filter(e => e["シリーズ"] === additionalEntry["シリーズ"] && (
      selectedPattern === 'father' ? e["父親"] :
      selectedPattern === 'mother' ? e["母親"] : e["誕生日"]
    ));
    const otherSeries = quizData.filter(e => e["シリーズ"] !== additionalEntry["シリーズ"] && (
      selectedPattern === 'father' ? e["父親"] :
      selectedPattern === 'mother' ? e["母親"] : e["誕生日"]
    ));
    while (choices.length < 4) {
      const fromArray = (Math.random() < 0.7 && sameSeries.length) ? sameSeries : otherSeries;
      const candidateEntry = fromArray[Math.floor(Math.random() * fromArray.length)];
      let candidate;
      if (selectedPattern === 'father') candidate = candidateEntry["父親"];
      else if (selectedPattern === 'mother') candidate = candidateEntry["母親"];
      else candidate = candidateEntry["誕生日"];
      if (!candidate || choices.includes(candidate)) continue;
      choices.push(candidate);
    }
    choices.sort(() => Math.random() - 0.5);
    questions.push({
      question: questionText,
      choices,
      correct: correctAnswer,
      additional: true
    });
  }
}

// pickCandidate: 同じキャラの別変身形態を除外するための関数
function pickCandidate(arr, type, correctItem) {
  const e = arr[Math.floor(Math.random() * arr.length)];
  if (!e) return null;
  const { questionKey, answerKey } = QANDA[type];
  const sameQuestionValue = (e[questionKey] === correctItem[questionKey]);
  const differentAnswerValue = (e[answerKey] !== correctItem[answerKey]);
  if (sameQuestionValue && differentAnswerValue) {
    return null;
  }
  return pickAnswerByType(e, type);
}

function pickAnswerByType(entry, type) {
  switch (type) {
    case 1: case 6:
      return entry["変身前"];
    case 2: case 4:
      return entry["声優"];
    case 3: case 5:
      return entry["変身後"];
    default:
      return null;
  }
}

function startQuiz() {
  currentQuestion = 0;
  results = [];
  elapsedTime = 0;
  startTime = Date.now();
  lastAnswerTime = startTime;
  timerInterval = setInterval(updateTimer, 10);
  showQuestion();
}

function updateTimer() {
  elapsedTime = Date.now() - startTime;
  document.getElementById('timer').textContent = (elapsedTime / 1000).toFixed(2) + '秒';
}

function showQuestion() {
  if (currentQuestion >= questions.length) {
    endQuiz();
    return;
  }
  const q = questions[currentQuestion];
  document.getElementById('question-area').textContent = q.question;
  const area = document.getElementById('choices-area');
  area.innerHTML = '';
  q.choices.forEach(choice => {
    const b = document.createElement('button');
    b.textContent = choice;
    b.className = 'choice';
    b.onclick = () => {
      b.blur(); // タップ後のフォーカス解除
      answer(choice);
    };
    area.appendChild(b);
  });
}

function answer(selectedChoice) {
  const now = Date.now();
  const time = ((now - lastAnswerTime) / 1000).toFixed(2);
  lastAnswerTime = now;
  const q = questions[currentQuestion];
  const isCorrect = (selectedChoice === q.correct);
  results.push({
    questionText: q.question,
    correct: isCorrect,
    correctAnswer: q.correct,
    userAnswer: selectedChoice,
    time
  });
  currentQuestion++;
  showQuestion();
}

function endQuiz() {
  clearInterval(timerInterval);
  document.getElementById('question-area').innerHTML = '🎀けっかはっぴょう🎀';
  document.getElementById('choices-area').innerHTML = '';
  const resArea = document.getElementById('result-area');
  resArea.innerHTML = '';
  let correctCount = 0;
  
  // 各問題の詳細を表示
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
  
  const total = (elapsedTime / 1000).toFixed(2);
  let praise = '';
  if (correctCount === 10) praise = 'すごい！パーフェクトだよ！';
  else if (correctCount >= 7) praise = 'よくできました！';
  else if (correctCount >= 4) praise = 'がんばったね！つぎはもっといけるよ！';
  else if (correctCount >= 1) praise = 'おしかったね！またちょうせんしよう！';
  else praise = 'さいごまでがんばったね！';
  
  let speedComment = '';
  if (total < 10) speedComment = 'スピードもカンペキ！すっごくはやい！';
  else if (total < 30) speedComment = 'なかなかはやいよ！';
  else if (total < 60) speedComment = 'いいペースだったね！';
  else speedComment = 'じっくりかんがえてがんばったね！';
  
  resArea.innerHTML += `<h2>せいかいしたかず：${correctCount}/10<br>かかったじかん：${total}びょう</h2>`;
  resArea.innerHTML += `<p>${praise}<br>${speedComment}</p>`;
  
  // Twitterシェアボタン
  const tweetBtn = document.getElementById('tweet-btn');
  tweetBtn.classList.remove('hidden');
  tweetBtn.onclick = () => {
    const tweetText = `#プリキュアオールスターズいえるかなクイズ で${correctCount}/10問正解、タイムは${total}秒でした！ ${praise} ${speedComment} https://all-stars.precure.tv/`;
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`, '_blank');
  };
  
  // もういちどあそぶボタン
  const retryBtn = document.getElementById('retry-btn');
  retryBtn.classList.remove('hidden');
  retryBtn.onclick = () => {
    questions = [];
    results = [];
    currentQuestion = 0;
    elapsedTime = 0;
    document.getElementById('result-area').innerHTML = '';
    document.getElementById('timer').textContent = '0.00秒';
    document.getElementById('timer').classList.add('hidden');
    document.getElementById('start-btn').classList.remove('hidden');
    document.getElementById('retry-btn').classList.add('hidden');
    document.getElementById('tweet-btn').classList.add('hidden');
    document.getElementById('question-area').innerHTML = '';
  };
}
