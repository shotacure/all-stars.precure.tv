import { createHmac } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// --- Configuration ---

const ADMIN_SECRET = process.env.ADMIN_SECRET;
const TABLE_NAME = process.env.TABLE_NAME;
const SITE_BUCKET = process.env.SITE_BUCKET;
const TOP_N = 20;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

// --- Helpers ---

/**
 * 管理者アクション用 HMAC 署名の検証
 * @param {string} action - "approve" or "reject"
 * @param {string} entryId - エントリ ID
 * @param {string} signature - 検証する署名
 * @returns {boolean} 署名が一致すれば true
 */
function verifyAdminSignature(action, entryId, signature) {
  const expected = createHmac("sha256", ADMIN_SECRET)
    .update(`${action}:${entryId}`)
    .digest("hex").slice(0, 32);

  // タイミングセーフな比較
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < sigBuf.length; i++) diff |= sigBuf[i] ^ expBuf[i];
  return diff === 0;
}

/**
 * ランキングのソート比較関数
 * 合計タイムの昇順（速い方が上位）でソート
 */
function rankEntry(a, b) {
  return a.totalTimeCs - b.totalTimeCs;
}

/**
 * 公開用にクライアント情報と管理用フィールドを除去
 * @param {Array} entries - ランキングエントリ配列
 * @returns {Array} 公開用に整形した配列
 */
function stripForPublic(entries) {
  return entries.map(({ clientInfo: _ci, id: _id, ...rest }) => rest);
}

/**
 * HTML レスポンスを生成
 * 管理者がメール内リンクをクリックした際にブラウザに表示する結果ページ
 * @param {number} statusCode - HTTP ステータスコード
 * @param {string} title - ページタイトル
 * @param {string} message - 表示メッセージ（HTML）
 * @param {string} color - テーマカラー
 * @returns {object} API Gateway レスポンスオブジェクト
 */
function htmlResponse(statusCode, title, message, color) {
  const body = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px 20px; text-align: center; background: #fafafa; }
    .card { max-width: 500px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { color: ${color}; font-size: 1.4em; margin: 0 0 16px; }
    p { color: #666; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    ${message}
  </div>
</body>
</html>`;

  return {
    statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body,
  };
}

/**
 * HTML エスケープ（XSS 防止）
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Handler ---

export const handler = async (event) => {
  // リクエストパスからアクション（approve / reject）を判定
  const rawPath = event.rawPath || event.requestContext?.http?.path || "";
  let action;
  if (rawPath.includes("/approve")) {
    action = "approve";
  } else if (rawPath.includes("/reject")) {
    action = "reject";
  } else {
    return htmlResponse(400, "エラー",
      '<div class="icon">❌</div><h1>不正なリクエスト</h1><p>有効なアクション URL ではありません。</p>',
      "#dc3545");
  }

  // クエリパラメータから ID と署名を取得
  const params = event.queryStringParameters || {};
  const entryId = params.id;
  const signature = params.sig;

  if (!entryId || !signature) {
    return htmlResponse(400, "エラー",
      '<div class="icon">❌</div><h1>パラメータ不足</h1><p>必要なパラメータが指定されていません。</p>',
      "#dc3545");
  }

  // HMAC 署名を検証（URL 改ざん防止）
  if (!verifyAdminSignature(action, entryId, signature)) {
    return htmlResponse(403, "認証エラー",
      '<div class="icon">🔒</div><h1>認証に失敗しました</h1><p>署名が無効です。メール内のリンクをそのまま使用してください。</p>',
      "#dc3545");
  }

  // 承認待ちエントリを個別レコードとして取得（pk: "pending:<id>"）
  const getResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: `pending:${entryId}` } })
  );

  if (!getResult.Item) {
    return htmlResponse(404, "見つかりません",
      '<div class="icon">🤔</div><h1>該当エントリが見つかりません</h1><p>既に承認または削除済みの可能性があります。</p>',
      "#6c757d");
  }

  const targetEntry = getResult.Item;

  if (action === "reject") {
    // --- 削除処理 ---
    // 承認待ちレコードを削除（ランキング・監査ログには影響なし）
    await ddb.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: `pending:${entryId}` } })
    );

    const timeStr = (targetEntry.totalTimeCs / 100).toFixed(2);
    return htmlResponse(200, "削除完了",
      `<div class="icon">🗑️</div><h1>削除しました</h1>` +
      `<p><strong>${escapeHtml(targetEntry.name)}</strong>（${timeStr}秒）を承認待ちリストから削除しました。</p>` +
      `<p style="font-size:0.9em;">監査ログには記録が残っています。</p>`,
      "#dc3545");
  }

  // --- 承認処理 ---

  // 1. 現在のランキングを取得
  const lbResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: "leaderboard" } })
  );
  const lbItem = lbResult.Item || { pk: "leaderboard", top20: [], version: 0 };
  const top20 = lbItem.top20 || [];
  const lbVersion = lbItem.version || 0;

  // 2. ランキングにマージ（承認時に改めてソート・上位20件に切り詰め）
  const merged = [...top20, targetEntry].sort(rankEntry).slice(0, TOP_N);

  // 3. ランキングを楽観的ロックで書き込み
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: "leaderboard", top20: merged, version: lbVersion + 1 },
        ConditionExpression: "attribute_not_exists(version) OR version = :v",
        ExpressionAttributeValues: { ":v": lbVersion },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return htmlResponse(409, "競合エラー",
        '<div class="icon">⚡</div><h1>同時更新の競合</h1><p>ブラウザを再読み込みして再度お試しください。</p>',
        "#ffc107");
    }
    throw err;
  }

  // 4. 承認待ちレコードを削除
  try {
    await ddb.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: `pending:${entryId}` } })
    );
  } catch {
    // pending の削除失敗は承認処理の成功に影響させない（TTL で自動削除される）
    console.error("Failed to remove approved entry from pending list");
  }

  // 5. ランキング JSON を S3 に書き出し（CloudFront 経由で配信）
  const publicTop20 = stripForPublic(merged);
  const leaderboardJson = JSON.stringify(
    { updatedAt: new Date().toISOString(), top20: publicTop20 },
    null,
    2
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: SITE_BUCKET,
      Key: "leaderboard.json",
      Body: leaderboardJson,
      ContentType: "application/json",
      CacheControl: "public, max-age=30",
    })
  );

  const timeStr = (targetEntry.totalTimeCs / 100).toFixed(2);
  const rank = merged.findIndex((e) => e.timestamp === targetEntry.timestamp && e.name === targetEntry.name) + 1;
  return htmlResponse(200, "承認完了",
    `<div class="icon">✅</div><h1>承認しました</h1>` +
    `<p><strong>${escapeHtml(targetEntry.name)}</strong>（${timeStr}秒）をランキング第 ${rank} 位として掲載しました。</p>`,
    "#28a745");
};
