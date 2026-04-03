import { createHmac } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// --- Configuration ---

const ADMIN_SECRET = process.env.ADMIN_SECRET;
const TABLE_NAME = process.env.TABLE_NAME;
const SITE_BUCKET = process.env.SITE_BUCKET;
const TOP_N = 100;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

// --- Helpers ---

/**
 * 管理者アクション用 HMAC 署名の検証
 * 名前ベースの署名により、同一名義のどの通知メールからでも操作可能
 * @param {string} action - "approve" or "reject"
 * @param {string} key - 名前（新形式）またはエントリ ID（旧形式）
 * @param {string} signature - 検証する署名
 * @returns {boolean} 署名が一致すれば true
 */
function verifyAdminSignature(action, key, signature) {
  const expected = createHmac("sha256", ADMIN_SECRET)
    .update(`${action}:${key}`)
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

/**
 * ランキング JSON を S3 に書き出す共通処理
 * @param {Array} entries - ランキングエントリ配列
 */
async function writeLeaderboardJson(entries) {
  const publicEntries = stripForPublic(entries);
  const leaderboardJson = JSON.stringify(
    { updatedAt: new Date().toISOString(), entries: publicEntries },
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
}

/**
 * 集約型 pendings レコードから指定名義を削除して書き戻す
 * @param {object} pendingsItem - DynamoDB の pendings レコード全体
 * @param {string} name - 削除する名前
 * @returns {boolean} 削除に成功したら true
 */
async function removePendingEntry(pendingsItem, name) {
  const entries = pendingsItem.entries || {};
  const version = pendingsItem.version || 0;
  if (!entries[name]) return false;

  const updated = { ...entries };
  delete updated[name];
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: "pendings", entries: updated, version: version + 1 },
        ConditionExpression: "attribute_not_exists(version) OR version = :v",
        ExpressionAttributeValues: { ":v": version },
      })
    );
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // 競合時は承認待ちの削除を諦める（手動除去で対応可能）
      console.error("Pending delete failed due to concurrent update");
      return false;
    }
    throw err;
  }
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

  // クエリパラメータから名前（または旧形式ID）と署名を取得
  const params = event.queryStringParameters || {};
  const entryName = params.name || null;
  const entryId = params.id || null;
  const signature = params.sig;

  // 名前ベース（新形式）または ID ベース（旧形式）のいずれかが必要
  const lookupKey = entryName || entryId;
  if (!lookupKey || !signature) {
    return htmlResponse(400, "エラー",
      '<div class="icon">❌</div><h1>パラメータ不足</h1><p>必要なパラメータが指定されていません。</p>',
      "#dc3545");
  }

  // HMAC 署名を検証（URL 改ざん防止）
  if (!verifyAdminSignature(action, lookupKey, signature)) {
    return htmlResponse(403, "認証エラー",
      '<div class="icon">🔒</div><h1>認証に失敗しました</h1><p>署名が無効です。メール内のリンクをそのまま使用してください。</p>',
      "#dc3545");
  }

  // 承認待ちエントリを集約レコード（pk: "pendings"）から取得
  const pendingsResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: "pendings" } })
  );
  const pendingsItem = pendingsResult.Item || { pk: "pendings", entries: {}, version: 0 };
  const targetEntry = (pendingsItem.entries || {})[lookupKey] || null;
  const hasPending = targetEntry && targetEntry.name && targetEntry.totalTimeCs;

  if (action === "reject") {
    // --- 削除処理 ---
    // 承認は「名義」の承認なので、削除も名義単位で行う
    // 1. 承認待ちレコードから該当名義を除去（存在すれば）
    let deletedFromPending = false;
    if (hasPending) {
      deletedFromPending = await removePendingEntry(pendingsItem, lookupKey);
    }

    // 2. ランキングからも同一名義を削除（承認済みのエントリが存在する場合）
    const targetName = hasPending ? targetEntry.name : lookupKey;
    const lbResult = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: "leaderboard" } })
    );
    const lbItem = lbResult.Item || { pk: "leaderboard", entries: [], version: 0 };
    const entries = lbItem.entries || lbItem.top20 || [];
    const lbVersion = lbItem.version || 0;

    const existsInLeaderboard = entries.some((e) => e.name === targetName);
    let deletedFromLeaderboard = false;

    if (existsInLeaderboard) {
      // ランキングから同一名義を除外して再書き込み
      const filtered = entries.filter((e) => e.name !== targetName);
      try {
        await ddb.send(
          new PutCommand({
            TableName: TABLE_NAME,
            Item: { pk: "leaderboard", entries: filtered, version: lbVersion + 1 },
            ConditionExpression: "attribute_not_exists(version) OR version = :v",
            ExpressionAttributeValues: { ":v": lbVersion },
          })
        );
        // S3 のランキング JSON も更新
        await writeLeaderboardJson(filtered);
        deletedFromLeaderboard = true;
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") {
          return htmlResponse(409, "競合エラー",
            '<div class="icon">⚡</div><h1>同時更新の競合</h1><p>ブラウザを再読み込みして再度お試しください。</p>',
            "#ffc107");
        }
        throw err;
      }
    }

    // 削除結果に応じたメッセージを生成
    if (!deletedFromPending && !deletedFromLeaderboard) {
      return htmlResponse(404, "見つかりません",
        '<div class="icon">🤔</div><h1>該当エントリが見つかりません</h1><p>既に削除済みの可能性があります。</p>',
        "#6c757d");
    }

    let deleteMsg = `<div class="icon">🗑️</div><h1>削除しました</h1>`;
    deleteMsg += `<p><strong>${escapeHtml(targetName)}</strong> を`;
    const parts = [];
    if (deletedFromPending) parts.push("承認待ちリスト");
    if (deletedFromLeaderboard) parts.push("ランキング");
    deleteMsg += parts.join("と") + "から削除しました。</p>";
    deleteMsg += `<p style="font-size:0.9em;">監査ログには記録が残っています。</p>`;

    return htmlResponse(200, "削除完了", deleteMsg, "#dc3545");
  }

  // --- 承認処理 ---

  // 承認待ちエントリが見つからない場合、既にランキングに掲載済みか確認
  if (!hasPending) {
    const targetName = lookupKey;
    const lbResult = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: "leaderboard" } })
    );
    const lbItem = lbResult.Item || { pk: "leaderboard", entries: [], version: 0 };
    const entries = lbItem.entries || lbItem.top20 || [];
    const alreadyApproved = entries.some((e) => e.name === targetName);

    if (alreadyApproved) {
      return htmlResponse(200, "承認済み",
        `<div class="icon">✅</div><h1>既に承認済みです</h1>` +
        `<p><strong>${escapeHtml(targetName)}</strong> は既にランキングに掲載されています。</p>`,
        "#28a745");
    }

    return htmlResponse(404, "見つかりません",
      '<div class="icon">🤔</div><h1>該当エントリが見つかりません</h1><p>既に承認または削除済みの可能性があります。</p>',
      "#6c757d");
  }

  // 1. 現在のランキングを取得
  const lbResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: "leaderboard" } })
  );
  const lbItem = lbResult.Item || { pk: "leaderboard", entries: [], version: 0 };
  // entries キーを優先し、旧形式 top20 からのフォールバックも対応
  const entries = lbItem.entries || lbItem.top20 || [];
  const lbVersion = lbItem.version || 0;

  // 2. 同一名義の重複排除
  //    同じ名前のエントリが既にある場合は除外してから新エントリを追加
  const entriesWithoutSameName = entries.filter((e) => e.name !== targetEntry.name);
  const merged = [...entriesWithoutSameName, targetEntry].sort(rankEntry).slice(0, TOP_N);

  // 3. ランキングを楽観的ロックで書き込み
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: "leaderboard", entries: merged, version: lbVersion + 1 },
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

  // 4. 承認待ちレコードから該当名義を除去
  await removePendingEntry(pendingsItem, lookupKey).catch(() => {
    // pending の削除失敗は承認処理の成功に影響させない
    console.error("Failed to remove approved entry from pending list");
  });

  // 5. ランキング JSON を S3 に書き出し（CloudFront 経由で配信）
  await writeLeaderboardJson(merged);

  const timeStr = (targetEntry.totalTimeCs / 100).toFixed(2);
  const rank = merged.findIndex((e) => e.timestamp === targetEntry.timestamp && e.name === targetEntry.name) + 1;
  return htmlResponse(200, "承認完了",
    `<div class="icon">✅</div><h1>承認しました</h1>` +
    `<p><strong>${escapeHtml(targetEntry.name)}</strong>（${timeStr}秒）をランキング第 ${rank} 位として掲載しました。</p>`,
    "#28a745");
};
