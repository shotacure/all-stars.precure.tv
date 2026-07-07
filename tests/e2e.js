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
  // 1問目をわざと間違える
  await page.waitForFunction(() => document.querySelectorAll('#choices-area .choice').length === 4);
  const c1 = await page.evaluate(() => questions[currentQuestion].correct);
  const cs1 = await page.$$eval('#choices-area .choice', els => els.map(e => e.textContent));
  const wrong1 = cs1.find(c => c !== c1);
  await page.click(`#choices-area .choice:has-text("${wrong1.replace(/"/g, '\\"')}")`);
  await page.waitForFunction(() => results.length === 1);
  await page.waitForTimeout(300); // 描画更新を数tick待つ
  check('プレイ中は不正解でもグレーにならない（ネタバレ防止）',
    !(await page.$eval('#timer-rank', el => el.classList.contains('rank-gray'))));
  // 残り9問は正答で完走
  for (let i = 0; i < 9; i++) {
    await page.waitForFunction(() => document.querySelectorAll('#choices-area .choice').length === 4);
    const correct = await page.evaluate(() => questions[currentQuestion].correct);
    await page.click(`#choices-area .choice:has-text("${correct.replace(/"/g, '\\"')}")`);
  }
  await page.waitForSelector('#result-area .result-detail');
  check('不正解ありでも結果画面では暫定順位が消える', (await page.$eval('#timer-rank', el => el.textContent)) === '');
  check('不正解では自己ベスト更新されない', !(await page.$('.pb-updated')));

  // --- シナリオ5: 英語表示 ---
  await page.goto(BASE);
  await page.click('#lang-en');
  await page.waitForTimeout(500);
  await page.click('#start-btn');
  await page.waitForFunction(() => typeof elapsedTime !== 'undefined' && elapsedTime > 100);
  const rankEn = await page.$eval('#timer-rank', el => el.textContent);
  check('英語のペース順位表示', /Pace #\d+/.test(rankEn), rankEn);

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
