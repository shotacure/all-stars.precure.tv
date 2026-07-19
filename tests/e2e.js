/**********************************************
 * E2E テスト（Playwright + Edge チャンネル）
 *
 * 実行方法:
 *   cd tests && npm install && npm test
 *
 * - ブラウザは Windows 同梱の Edge を使用（別途ダウンロード不要）
 * - サーバーは server.js が :8765 で自動起動（site/ + fixtures/ を配信）
 * - フィクスチャのランキング: 2.00/3.00/3.50/8.00/15.00/30.00/60.00 秒
 *   （暫定順位・ゴースト検証の期待値はこの並びに依存）
 **********************************************/
const { chromium } = require('playwright');
const { start } = require('./server');

const BASE = 'http://localhost:8765/';
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

// ページ内の script.js グローバル（questions/currentQuestion）を参照して正答をクリック
async function playQuiz(page, { wrongOnQuestion = -1 } = {}) {
  for (let i = 0; i < 10; i++) {
    await page.waitForFunction(() => document.querySelectorAll('#choices-area .choice').length === 4);
    const correct = await page.evaluate(() => questions[currentQuestion].correct);
    const choices = await page.$$eval('#choices-area .choice', els => els.map(e => e.textContent));
    let target = correct;
    if (i === wrongOnQuestion) target = choices.find(c => c !== correct);
    await page.click(`#choices-area .choice:has-text("${target.replace(/"/g, '\\"')}")`);
  }
  await page.waitForSelector('#result-area .result-detail');
}

(async () => {
  const server = await start(8765);
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  // --- シナリオ0: 出題生成のプロパティ検証（50回再生成） ---
  // 口上問題（type 11/12）の「正解が2つある」事故が起きないことを含む
  await page.goto(BASE);
  await page.click('#start-btn');
  await page.waitForFunction(() => typeof questions !== 'undefined' && questions.length === 10);
  const genCheck = await page.evaluate(() => {
    const byTransformed = {};
    quizData.forEach(e => { byTransformed[e.transformed.ja] = e; });
    const issues = [];
    let coexistSeen = 0;
    for (let k = 0; k < 50; k++) {
      generateQuestions();
      if (questions.length !== 10) issues.push(`回${k}: 問題数${questions.length}`);
      const counts = { voice: 0, other: 0, r11: 0, r12: 0, add: 0 };
      for (const q of questions) {
        if (new Set(q.choices).size !== 4) issues.push(`回${k}: type${q.type} 選択肢重複`);
        if (!q.choices.includes(q.correct)) issues.push(`回${k}: type${q.type} 正解不在`);
        if ([2, 4, 5, 6].includes(q.type)) counts.voice++;
        else if ([1, 3].includes(q.type)) counts.other++;
        else if (q.type === 11) counts.r11++;
        else if (q.type === 12) counts.r12++;
        else counts.add++;

        if (q.type === 11) {
          // 誤答キュアの口上が問題の口上と同じ＝正解2つ、は許されない
          const qe = quizData[q.entryIndex];
          for (const c of q.choices) {
            if (c === q.correct) continue;
            const e2 = byTransformed[c];
            if (e2 && e2.rollcall.ja === qe.rollcall.ja) issues.push(`回${k}: type11 正解重複「${c}」`);
          }
          // 同一人物別形態（口上は別）の同居は合法：観測のみ
          const joined = q.choices.join('/');
          if ((joined.includes('ブルーム') && joined.includes('ブライト')) ||
              (joined.includes('イーグレット') && joined.includes('ウィンディ'))) coexistSeen++;
        }
      }
      if (counts.voice !== 2 || counts.other !== 5 || counts.r11 !== 1 || counts.r12 !== 1 || counts.add !== 1) {
        issues.push(`回${k}: 構成 ${JSON.stringify(counts)}`);
      }
    }
    return { issues: issues.slice(0, 5), coexistSeen };
  });
  check('出題生成50回：構成5/2/口上2/1・選択肢重複なし・口上の正解重複なし',
    genCheck.issues.length === 0, genCheck.issues.join(' | ') || `同一人物別形態の同居観測: ${genCheck.coexistSeen}回`);

  // --- シナリオ0.5: 長文（口上）選択肢の縮小クラスとはみ出し検査 ---
  await page.goto(BASE);
  await page.click('#start-btn');
  const fontIssues = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForFunction(() => document.querySelectorAll('#choices-area .choice').length === 4);
    const bad = await page.evaluate(() => {
      // 実装と同じ幅計算（全角=1、半角=0.5）で検査する
      const tw = s => [...s].reduce((a, c) => a + (c.charCodeAt(0) < 0x100 ? 0.5 : 1), 0);
      const out = [];
      document.querySelectorAll('#choices-area .choice').forEach(b => {
        const w = tw(b.textContent);
        const xl = b.classList.contains('choice-xlong');
        const lg = b.classList.contains('choice-long');
        if (w > 22 && !xl) out.push(`xlong欠落(${w})`);
        else if (w > 14 && w <= 22 && !lg) out.push(`long欠落(${w})`);
        else if (w <= 14 && (xl || lg)) out.push(`過剰縮小(${w})`);
        if (b.scrollWidth > b.clientWidth + 1) out.push(`overflow(${b.textContent.slice(0, 10)}…)`);
      });
      const qa = document.getElementById('question-area');
      if (tw(qa.textContent) > 24 && !qa.classList.contains('q-long')) out.push('q-long欠落');
      return out;
    });
    fontIssues.push(...bad);
    const correct = await page.evaluate(() => questions[currentQuestion].correct);
    await page.click(`#choices-area .choice:has-text("${correct.replace(/"/g, '\\"')}")`);
  }
  await page.waitForSelector('#result-area .result-detail');
  check('長文縮小クラス適用とはみ出しなし（全10問）', fontIssues.length === 0, fontIssues.slice(0, 5).join(' | '));

  // --- シナリオ1: ペース予測の暫定順位（未回答のまま観測） ---
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction(() => typeof ghostTimeline !== 'undefined' && ghostTimeline.length > 0);

  // t<190ms: 予測 <1.9s → 最速2.0sより速い → 暫定1位
  await page.waitForFunction(() => elapsedTime > 30 && elapsedTime < 185, { polling: 10 });
  const rankEarly = await page.$eval('#timer-rank', el => el.textContent);
  check('開始直後（予測<1.9s）は暫定1位', rankEarly === '暫定1位', rankEarly);

  // 未回答で t∈[1.0s, 1.45s]: 予測10〜14.5s → 8s超・15s未満 → 暫定5位
  await page.waitForFunction(() => elapsedTime >= 1000 && elapsedTime < 1450 && results.length === 0, { polling: 10 });
  const rankPace = await page.$eval('#timer-rank', el => el.textContent);
  check('未回答1秒経過（予測10s台）で暫定5位', rankPace === '暫定5位', rankPace);

  // ゴースト: 3.6秒経過で 2.0/3.0/3.5s の3記録が流れている
  await page.waitForFunction(() => elapsedTime >= 3600);
  const ghostSeen = await page.$$eval('#timer-ghosts .timer-ghost', els => els.map(e => e.textContent));
  check('ゴーストが流れている', ghostSeen.length > 0, JSON.stringify(ghostSeen));

  // レイアウト不変: ゴースト表示中も #timer-row の高さが増えず、タイマーが中央のまま
  const layout = await page.evaluate(() => {
    const row = document.getElementById('timer-row');
    const timer = document.getElementById('timer');
    const rowRect = row.getBoundingClientRect();
    const timerRect = timer.getBoundingClientRect();
    const timerCenter = timerRect.left + timerRect.width / 2;
    const rowCenter = rowRect.left + rowRect.width / 2;
    return { rowHeight: rowRect.height, centerDiff: Math.abs(timerCenter - rowCenter) };
  });
  check('ゴースト表示中も行の高さが正常（<=40px）', layout.rowHeight <= 40, `height=${layout.rowHeight}`);
  check('タイマーが中央からズレない（<=2px）', layout.centerDiff <= 2, `diff=${layout.centerDiff.toFixed(1)}px`);

  // --- シナリオ2: 完走→結果画面では暫定順位が消える、自己ベスト保存 ---
  await playQuiz(page);
  const rankAfterFinish = await page.$eval('#timer-rank', el => el.textContent);
  check('結果画面では暫定順位が消える', rankAfterFinish === '', JSON.stringify(rankAfterFinish));
  check('自己ベスト更新メッセージ', !!(await page.$('.pb-updated')));

  // --- シナリオ2.3: 結果画面で言語切替 → endQuiz 再入で再描画 ---
  await page.click('#lang-en');
  await page.waitForFunction(() => document.getElementById('question-area').textContent.includes('Results'));
  const reentry = await page.evaluate(() => ({
    details: document.querySelectorAll('#result-area .result-detail').length,
    pbMsgs: document.querySelectorAll('.pb-updated').length,
  }));
  check('結果画面の言語切替で再描画（10問維持）', reentry.details === 10, `details=${reentry.details}`);
  check('再描画で自己ベスト演出が重複しない', reentry.pbMsgs <= 1, `pbMsgs=${reentry.pbMsgs}`);
  await page.click('#lang-ja');
  await page.waitForFunction(() => document.getElementById('question-area').textContent.includes('けっか'));

  // --- シナリオ2.5: 共有URL復元（#r= を別ページで開く） ---
  const shareHash = await page.evaluate(() => location.hash);
  check('完走後のURLが #r= 形式', /^#r=[A-Za-z0-9_-]+$/.test(shareHash), shareHash);
  const shared = await browser.newPage();
  await shared.goto(BASE + shareHash);
  await shared.waitForSelector('#result-area .result-detail');
  const sharedState = await shared.evaluate(() => ({
    details: document.querySelectorAll('#result-area .result-detail').length,
    correct: results.filter(r => r.correct).length,
    startHidden: document.getElementById('start-btn').classList.contains('hidden'),
    qTexts: results.every(r => r.questionText && r.questionText.length > 0 && r.correctAnswer),
  }));
  check('共有復元：10問の詳細が再現される', sharedState.details === 10, `details=${sharedState.details}`);
  check('共有復元：全問正解として復元', sharedState.correct === 10, `correct=${sharedState.correct}`);
  check('共有復元：問題文と正答が全問生成される', sharedState.qTexts);
  check('共有復元：スタートボタン非表示', sharedState.startHidden);
  await shared.close();

  // --- シナリオ3: ホームの自己ベスト・PBゴースト合流 ---
  await page.goto(BASE);
  await page.waitForFunction(() => !document.getElementById('personal-best').classList.contains('hidden'));
  const pbLabel = await page.$eval('#personal-best', el => el.textContent);
  check('ホームに自己ベスト表示', /じこベスト：10\/10（\d+\.\d{2}秒）/.test(pbLabel), pbLabel);
  await page.click('#start-btn');
  await page.waitForFunction(() => typeof ghostTimeline !== 'undefined' && ghostTimeline.length > 0);
  check('タイムラインに自己ベストゴーストが合流', await page.evaluate(() => ghostTimeline.some(g => !g.isLb)));

  // --- シナリオ4: 不正解してもプレイ中はグレーなし → 結果画面では表示が消える ---
  // 口上問題（type 12）でわざと間違える：共有URLの新ビット表現 sf=7 の往復も検証
  let wrongDone = false;
  let grayAfterWrong = null;
  for (let i = 0; i < 10; i++) {
    await page.waitForFunction(() => document.querySelectorAll('#choices-area .choice').length === 4);
    const cur = await page.evaluate(() => ({ type: questions[currentQuestion].type, correct: questions[currentQuestion].correct }));
    const choices = await page.$$eval('#choices-area .choice', els => els.map(e => e.textContent));
    const isWrongTurn = (cur.type === 12 && !wrongDone);
    const target = isWrongTurn ? choices.find(c => c !== cur.correct) : cur.correct;
    if (isWrongTurn) wrongDone = true;
    await page.click(`#choices-area .choice:has-text("${target.replace(/"/g, '\\"')}")`);
    if (isWrongTurn && i < 9) {
      // 不正解の登録直後（まだプレイ中）にグレーになっていないことを確認
      await page.waitForFunction(n => results.length >= n, i + 1);
      await page.waitForTimeout(150);
      grayAfterWrong = await page.$eval('#timer-rank', el => el.classList.contains('rank-gray'));
    }
  }
  check('口上問題(type12)で誤答した', wrongDone);
  // type12 が最終問だった場合はプレイ中の観測ができない（null）→ グレーでなければ合格
  check('プレイ中は不正解でもグレーにならない（ネタバレ防止）', grayAfterWrong !== true,
    grayAfterWrong === null ? '（最終問で誤答のため観測なし）' : `gray=${grayAfterWrong}`);
  await page.waitForSelector('#result-area .result-detail');
  check('不正解ありでも結果画面では暫定順位が消える', (await page.$eval('#timer-rank', el => el.textContent)) === '');
  check('不正解では自己ベスト更新されない', !(await page.$('.pb-updated')));

  // 口上誤答を含む共有URL（sf=7）の復元検証
  const wrongHash = await page.evaluate(() => location.hash);
  const shared2 = await browser.newPage();
  await shared2.goto(BASE + wrongHash);
  await shared2.waitForSelector('#result-area .result-detail');
  const wrongRestore = await shared2.evaluate(() => {
    const bad = results.find(r => !r.correct);
    return {
      correctCount: results.filter(r => r.correct).length,
      wrongType: bad ? bad.type : null,
      userAnswerOk: bad ? (bad.userAnswer && bad.userAnswer !== '(?)' && bad.userAnswer !== bad.correctAnswer) : false,
    };
  });
  check('共有復元：口上誤答が9/10として復元', wrongRestore.correctCount === 9, `correct=${wrongRestore.correctCount}`);
  check('共有復元：誤答タイプが口上(12)で選択内容も復元(sf=7)', wrongRestore.wrongType === 12 && wrongRestore.userAnswerOk,
    `type=${wrongRestore.wrongType}`);
  await shared2.close();

  // --- シナリオ5: 英語表示 ---
  await page.goto(BASE);
  await page.click('#lang-en');
  await page.waitForTimeout(500);
  await page.click('#start-btn');
  await page.waitForFunction(() => typeof elapsedTime !== 'undefined' && elapsedTime > 100);
  const rankEn = await page.$eval('#timer-rank', el => el.textContent);
  check('英語のペース順位表示', /Pace #\d+/.test(rankEn), rankEn);

  // --- シナリオ5.5: アーカイブ（過去ランキング）ページと導線 ---
  await page.goto(BASE);
  await page.waitForFunction(() => !document.getElementById('leaderboard-area').classList.contains('hidden'));
  const archHref = await page.$eval('#archive-link a', a => a.getAttribute('href'));
  check('ランキング下にアーカイブリンク', archHref === 'archive/v1.html', archHref);

  // 空盤面（v2仕切り直し直後想定）でも枠と空メッセージが出る
  const emptyState = await page.evaluate(() => {
    const backup = leaderboard;
    leaderboard = [];
    renderLeaderboard();
    const visible = !document.getElementById('leaderboard-area').classList.contains('hidden');
    const msg = !!document.querySelector('#leaderboard-list .lb-empty');
    leaderboard = backup;
    renderLeaderboard();
    return { visible, msg };
  });
  check('空ランキングでも枠・空メッセージ・導線を表示', emptyState.visible && emptyState.msg, JSON.stringify(emptyState));

  await page.goto(BASE + 'archive/v1.html');
  await page.waitForFunction(() => document.querySelectorAll('#archive-list tbody tr').length > 0);
  const arch = await page.evaluate(() => ({
    rows: document.querySelectorAll('#archive-list tbody tr').length,
    medal: document.querySelector('#archive-list tbody tr td').textContent.includes('🥇'),
    back: document.querySelector('#archive-back a').getAttribute('href'),
  }));
  check('アーカイブページ：ティア描画と戻り導線', arch.rows === 5 && arch.medal && arch.back === '../', JSON.stringify(arch));

  // --- シナリオ6: iモード（?i）で演出・自己ベスト非表示 ---
  await page.goto(BASE + '?i');
  await page.waitForTimeout(800);
  const imodeHidden = await page.evaluate(() => {
    return getComputedStyle(document.getElementById('timer-row')).display === 'none'
        && getComputedStyle(document.getElementById('personal-best')).display === 'none';
  });
  check('iモードでタイマー行・自己ベスト非表示', imodeHidden);

  check('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  server.close();

  const fails = results.filter(r => !r.ok);
  console.log(`\n==== ${results.length - fails.length}/${results.length} PASS ====`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('E2E ERROR:', e); process.exit(2); });
