import { createHmac } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

// --- Configuration ---

const SECRET = process.env.SESSION_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const TABLE_NAME = process.env.TABLE_NAME;
const SITE_BUCKET = process.env.SITE_BUCKET;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const SENDER_EMAIL = process.env.SENDER_EMAIL || "";

const MAX_NAME_LENGTH = 16;
const TOP_N = 100;
const TOTAL_QUESTIONS = 10;

// ネットワーク遅延を考慮したタイム検証の許容誤差（ミリ秒）
const TIME_TOLERANCE_MS = 3000;
// トークン有効期限（ミリ秒）：クイズ所要時間を考慮して10分
const TOKEN_EXPIRY_MS = 600_000;
// 使用済みトークンの DynamoDB TTL（秒）：トークン有効期限の2倍を保持
const TOKEN_TTL_SECONDS = Math.ceil((TOKEN_EXPIRY_MS * 2) / 1000);
// 合計タイムの上限（センチ秒）：655.35秒 = 65535cs（フロント側と同じ上限）
const MAX_TOTAL_TIME_CS = 65535;
// 監査ログの DynamoDB TTL（秒）：30日間保持
const AUDIT_TTL_SECONDS = 30 * 24 * 60 * 60;
// 承認待ちエントリの DynamoDB TTL（秒）：30日間保持、超過分は自動削除
const PENDING_TTL_SECONDS = 30 * 24 * 60 * 60;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ses = new SESv2Client({});

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Cache-Control": "no-store",
};

// --- Helpers ---

function response(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

/**
 * 名前のサニタイズ
 * - 制御文字・HTMLタグを除去
 * - Unicode文字数で16文字以内に制限
 */
function sanitizeName(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, "").replace(/<[^>]*>/g, "");
  const trimmed = cleaned.trim();
  if (trimmed.length === 0 || [...trimmed].length > MAX_NAME_LENGTH) return null;
  return trimmed;
}

/**
 * セッショントークンの検証
 * - HMAC署名の一致確認（タイミングセーフ比較）
 * - 発行時刻と申告タイムの整合性チェック（タイム偽装防止）
 * - トークン有効期限チェック
 * @returns {object} { valid, reason?, nonce? }
 */
function verifyToken(token, claimedTimeCs) {
  if (typeof token !== "string") return { valid: false, reason: "missing token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed token" };

  const [timestamp, nonce, signature] = parts;
  const payload = `${timestamp}.${nonce}`;
  const expected = createHmac("sha256", SECRET).update(payload).digest("hex");

  // タイミングセーフな比較（サイドチャネル攻撃対策）
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return { valid: false, reason: "invalid signature" };
  let diff = 0;
  for (let i = 0; i < sigBuf.length; i++) diff |= sigBuf[i] ^ expBuf[i];
  if (diff !== 0) return { valid: false, reason: "invalid signature" };

  const issuedAt = parseInt(timestamp, 10);
  if (Number.isNaN(issuedAt)) return { valid: false, reason: "invalid timestamp" };

  const now = Date.now();
  const elapsedMs = now - issuedAt;
  const claimedMs = claimedTimeCs * 10;

  // 未来のタイムスタンプは拒否
  if (issuedAt > now + TIME_TOLERANCE_MS) {
    return { valid: false, reason: "future timestamp" };
  }

  // 実経過時間 ≧ 申告クイズ時間（許容誤差あり）でなければ偽装
  if (elapsedMs + TIME_TOLERANCE_MS < claimedMs) {
    return { valid: false, reason: "time mismatch" };
  }

  // トークン有効期限超過
  if (elapsedMs > TOKEN_EXPIRY_MS) {
    return { valid: false, reason: "token expired" };
  }

  return { valid: true, nonce };
}

/**
 * 使用済みトークンの重複チェックと記録（リプレイ攻撃防止）
 * - 単一レコード（pk: "tokens"）の nonces マップに全 nonce を集約
 * - 書き込み時に有効期限切れの nonce を自動除去
 * - 楽観的ロックで同時書き込みの競合を防止（競合時はリトライ）
 * @param {string} nonce - 検証する nonce
 * @param {number} retries - リトライ残回数（楽観的ロック競合時用）
 * @returns {boolean} true=未使用（正常）、false=使用済み（リプレイ）
 */
async function consumeToken(nonce, retries = 3) {
  const getResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: "tokens" } })
  );
  const current = getResult.Item || { pk: "tokens", nonces: {}, version: 0 };
  const nonces = current.nonces || {};
  const version = current.version || 0;

  // 有効期限切れの nonce を除去
  const now = Math.floor(Date.now() / 1000);
  const pruned = {};
  for (const [key, exp] of Object.entries(nonces)) {
    if (exp > now) pruned[key] = exp;
  }

  // 既に使用済みの nonce なら拒否
  if (pruned[nonce]) return false;

  // 新しい nonce を追加
  pruned[nonce] = now + TOKEN_TTL_SECONDS;

  // 楽観的ロックで書き込み
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: "tokens", nonces: pruned, version: version + 1 },
        ConditionExpression: "attribute_not_exists(version) OR version = :v",
        ExpressionAttributeValues: { ":v": version },
      })
    );
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // 同時書き込みの競合 → リトライして再判定
      if (retries <= 0) return false;
      return consumeToken(nonce, retries - 1);
    }
    throw err;
  }
}

/**
 * スコアデータの整合性検証
 * - 正解数：満点（10問正解）のみ登録対象
 * - 合計タイム：正の整数、上限以内
 * - 結果バイナリ：提供されている場合はデコードして一致確認
 */
function validateScore(correct, totalTimeCs, resultBinary) {
  // 満点以外はランキング登録不可
  if (
    typeof correct !== "number" ||
    !Number.isInteger(correct) ||
    correct !== TOTAL_QUESTIONS
  ) {
    return false;
  }

  if (
    typeof totalTimeCs !== "number" ||
    !Number.isInteger(totalTimeCs) ||
    totalTimeCs <= 0 ||
    totalTimeCs > MAX_TOTAL_TIME_CS
  ) {
    return false;
  }

  if (typeof resultBinary === "string" && resultBinary.length > 0) {
    try {
      const decoded = decodeResultBinary(resultBinary);
      if (decoded.correct !== correct) return false;
      if (Math.abs(decoded.totalTimeCs - totalTimeCs) > 100) return false;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * 結果バイナリのデコード
 * 各問は 2バイト（タイム cs, big-endian uint16）+ 1バイト（正誤）で構成
 * 全体は base64url エンコード
 */
function decodeResultBinary(encoded) {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(b64, "base64");

  const bytesPerQuestion = 3;
  if (buf.length % bytesPerQuestion !== 0) {
    throw new Error("Invalid result binary length");
  }

  const questionCount = buf.length / bytesPerQuestion;
  let totalTimeCs = 0;
  let correct = 0;

  for (let i = 0; i < questionCount; i++) {
    const offset = i * bytesPerQuestion;
    const timeCs = buf.readUInt16BE(offset);
    const isCorrect = buf[offset + 2];
    totalTimeCs += timeCs;
    if (isCorrect === 1) correct++;
  }

  return { correct, totalTimeCs, questionCount };
}

/**
 * ランキングのソート比較関数
 * 全エントリが満点のため、合計タイムの昇順（速い方が上位）でソート
 */
function rankEntry(a, b) {
  return a.totalTimeCs - b.totalTimeCs;
}

/**
 * API Gateway HTTP API の event オブジェクトからクライアント情報を抽出
 * 荒らし対策の監査ログ・管理者通知・ISPログ照会に使用
 * @param {object} event - API Gateway イベントオブジェクト
 * @returns {object} クライアント情報
 */
function extractClientInfo(event) {
  const httpCtx = event.requestContext?.http || {};
  const reqCtx = event.requestContext || {};
  const hdrs = event.headers || {};

  return {
    // クライアント識別情報
    sourceIp: httpCtx.sourceIp || null,
    userAgent: httpCtx.userAgent || null,
    xForwardedFor: hdrs["x-forwarded-for"] || null,
    acceptLanguage: hdrs["accept-language"] || null,
    referer: hdrs["referer"] || hdrs["Referer"] || null,
    cloudFrontViewerCountry:
      hdrs["cloudfront-viewer-country"] ||
      hdrs["CloudFront-Viewer-Country"] ||
      null,
    origin: hdrs["origin"] || null,
    secFetchSite: hdrs["sec-fetch-site"] || null,
    // リクエストメタデータ（ISPログ照会用）
    requestTime: reqCtx.time || null,
    requestTimeEpoch: reqCtx.timeEpoch || null,
    domainName: reqCtx.domainName || null,
    httpMethod: httpCtx.method || null,
    path: httpCtx.path || null,
    protocol: httpCtx.protocol || null,
    apiRequestId: reqCtx.requestId || null,
  };
}

/**
 * 監査ログを単一レコード（pk: "audits"）の配列に追記
 * - 30 日を超えた古いエントリは書き込み時に自動除去
 * - 最大 100 件まで保持（超過分は古い順に削除）
 * - 楽観的ロックで同時書き込みの競合を防止
 * @param {string} nonce - セッショントークンの nonce（一意キー）
 * @param {object} details - 記録する詳細情報
 */
async function writeAuditLog(nonce, details) {
  try {
    // 現在の監査ログレコードを取得
    const getResult = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: "audits" } })
    );
    const current = getResult.Item || { pk: "audits", logs: [], version: 0 };
    const logs = current.logs || [];
    const version = current.version || 0;

    // 30 日超えのエントリを除去
    const cutoff = new Date(Date.now() - AUDIT_TTL_SECONDS * 1000).toISOString();
    const pruned = logs.filter((e) => e.submittedAt > cutoff);

    // 新しいエントリを追加
    const newEntry = { nonce, ...details };
    const merged = [...pruned, newEntry];

    // 最大 100 件に制限（古い順に削除）
    const capped = merged.length > 100 ? merged.slice(-100) : merged;

    // 楽観的ロックで書き込み
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: "audits", logs: capped, version: version + 1 },
        ConditionExpression: "attribute_not_exists(version) OR version = :v",
        ExpressionAttributeValues: { ":v": version },
      })
    );
  } catch (err) {
    // 監査ログの書き込み失敗はスコア送信自体をブロックしない
    console.error("Failed to write audit log:", err);
  }
}

/**
 * 承認待ちエントリを DynamoDB に保存（単一レコード集約型）
 * - 単一レコード（pk: "pendings"）の entries マップに名前をキーとして格納
 * - 書き込み時に有効期限切れ（30日超）のエントリを自動除去
 * - 楽観的ロックで同時書き込みの競合を防止
 * @param {string} name - サニタイズ済みの名前
 * @param {object} entry - スコアエントリ
 */
async function writePendingEntry(name, entry) {
  const getResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: "pendings" } })
  );
  const current = getResult.Item || { pk: "pendings", entries: {}, version: 0 };
  const entries = current.entries || {};
  const version = current.version || 0;

  // 有効期限切れのエントリを除去（30日超）
  const cutoff = new Date(Date.now() - PENDING_TTL_SECONDS * 1000).toISOString();
  const pruned = {};
  for (const [key, e] of Object.entries(entries)) {
    if (e.timestamp && e.timestamp > cutoff) pruned[key] = e;
  }

  // エントリを追加・上書き
  pruned[name] = entry;

  // 楽観的ロックで書き込み
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk: "pendings", entries: pruned, version: version + 1 },
      ConditionExpression: "attribute_not_exists(version) OR version = :v",
      ExpressionAttributeValues: { ":v": version },
    })
  );
}

/**
 * 承認待ちエントリを名前で取得
 * @param {string} name - サニタイズ済みの名前
 * @returns {object|null} 承認待ちエントリ、存在しなければ null
 */
async function getPendingEntry(name) {
  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: "pendings" } })
  );
  return result.Item?.entries?.[name] || null;
}

/**
 * 管理操作用の HMAC 署名を生成
 * Admin Lambda がこの署名を検証して承認/却下を実行する
 * 名前ベースの署名により、同一名義のどの通知メールからでも操作可能
 * @param {string} action - 操作種別（"approve" または "reject"）
 * @param {string} name - 承認待ちの名前
 * @returns {string} 署名（hex, 32文字）
 */
function generateAdminSignature(action, name) {
  return createHmac("sha256", ADMIN_SECRET)
    .update(`${action}:${name}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * ランクイン通知メールの HTML を生成
 * 登録者の情報とクライアント情報、最新の順位表、承認/却下ボタンをすべて含む
 * @param {object} entry - ランクイン者の情報
 * @param {object} clientInfo - クライアント情報
 * @param {Array} rankEntries - 最新の順位表
 * @param {string} approveUrl - 承認用 URL（自動承認時は空文字）
 * @param {string} rejectUrl - 却下用 URL（自動承認時は空文字）
 * @param {object} options - オプション
 * @param {boolean} options.autoApproved - 自動承認済みの場合 true
 * @returns {string} HTML 文字列
 */
function buildNotificationHtml(entry, clientInfo, rankEntries, approveUrl, rejectUrl, options = {}) {
  const timeStr = (entry.totalTimeCs / 100).toFixed(2);

  // ISP照会用：リクエスト日時をJSTに変換
  const requestJst = clientInfo.requestTimeEpoch
    ? new Date(clientInfo.requestTimeEpoch).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        fractionalSecondDigits: 3,
      })
    : clientInfo.requestTime || "(不明)";

  // ISP照会用：接続先URI
  const requestUri = (clientInfo.domainName && clientInfo.path)
    ? `https://${clientInfo.domainName}${clientInfo.path}`
    : "(不明)";

  // クライアント情報テーブル行の生成（リクエストメタデータはISP照会欄に分離するため除外）
  const metaKeys = new Set([
    "requestTime", "requestTimeEpoch", "domainName",
    "httpMethod", "path", "protocol", "apiRequestId",
  ]);
  const infoRows = Object.entries(clientInfo)
    .filter(([key]) => !metaKeys.has(key))
    .map(
      ([key, val]) =>
        `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;white-space:nowrap;color:#555;">${escapeHtml(key)}</td>` +
        `<td style="padding:4px 0;word-break:break-all;">${escapeHtml(String(val ?? "(なし)"))}</td></tr>`
    )
    .join("");

  // 順位表行の生成（承認待ちエントリは背景色で区別）
  const rankRows = rankEntries
    .map((e, i) => {
      const isCurrent =
        e.name === entry.name && e.timestamp === entry.timestamp;
      const isPending = !!e._pending;
      // 承認待ち（今回の送信者）: オレンジ系、承認済み: 通常の縞模様
      const bg = isPending ? "#fff3cd" : i % 2 === 0 ? "#f8f9fa" : "#ffffff";
      const bold = isCurrent ? "font-weight:bold;" : "";
      const pendingLabel = isPending ? ' <span style="color:#e67e22;font-size:11px;">⏳未承認</span>' : "";
      const ts = e.timestamp
        ? new Date(e.timestamp).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
        : "";
      return `<tr style="background:${bg};${bold}">
        <td style="padding:6px 8px;text-align:center;">${i + 1}</td>
        <td style="padding:6px 8px;">${escapeHtml(e.name)}${pendingLabel}</td>
        <td style="padding:6px 8px;text-align:right;">${(e.totalTimeCs / 100).toFixed(2)}s</td>
        <td style="padding:6px 8px;font-size:12px;color:#888;">${ts}</td>
      </tr>`;
    })
    .join("");

  // 自動承認モードと承認待ちモードでヘッダー・バナー・ボタンを切り替え
  const isAutoApproved = !!options.autoApproved;

  const headingText = isAutoApproved
    ? "🎀 ランクイン通知（自動承認済み）"
    : "🎀 ランクイン通知（承認待ち）";

  const statusBanner = isAutoApproved
    ? `<p style="background:#d4edda;padding:12px;border-radius:8px;border:1px solid #28a745;">
  ✅ ランキングに既存の名前と一致したため <strong>自動承認</strong> されました。ランキングは既に更新済みです。
</p>`
    : `<p style="background:#fff3cd;padding:12px;border-radius:8px;border:1px solid #ffc107;">
  ⚠️ このエントリは <strong>承認待ち</strong> です。以下のボタンで承認または削除してください。
</p>`;

  // 自動承認時はアクションボタンなし（情報通知のみ）
  // 承認待ち時は承認・削除ボタンを表示
  const actionButtons = isAutoApproved
    ? ""
    : `<div style="text-align:center;margin:24px 0;">
  <a href="${escapeHtml(approveUrl)}"
     style="display:inline-block;background:#28a745;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;margin:0 8px;">
    ✅ 掲載承認
  </a>
  <a href="${escapeHtml(rejectUrl)}"
     style="display:inline-block;background:#dc3545;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;margin:0 8px;">
    ❌ 削除
  </a>
</div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">

<h2 style="color:#e91e8c;border-bottom:2px solid #e91e8c;padding-bottom:8px;">
  ${headingText}
</h2>

${statusBanner}

${actionButtons}

<table style="border-collapse:collapse;width:100%;margin-bottom:20px;">
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">名前</td>
      <td style="padding:6px 0;font-size:18px;">${escapeHtml(entry.name)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">正解数</td>
      <td style="padding:6px 0;">${entry.correct} / ${TOTAL_QUESTIONS}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">合計タイム</td>
      <td style="padding:6px 0;font-size:18px;color:#e91e8c;">${timeStr}秒</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">登録日時</td>
      <td style="padding:6px 0;">${escapeHtml(entry.timestamp)}</td></tr>
</table>

<h3>クライアント情報</h3>
<table style="border-collapse:collapse;width:100%;font-size:14px;">
  ${infoRows}
</table>

<h3 style="margin-top:20px;">ISPログ照会用メタデータ</h3>
<table style="border-collapse:collapse;width:100%;font-size:14px;">
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">リクエスト日時(JST)</td>
      <td style="padding:6px 0;font-family:monospace;">${escapeHtml(requestJst)}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">リクエスト日時(epoch)</td>
      <td style="padding:6px 0;font-family:monospace;">${escapeHtml(String(clientInfo.requestTimeEpoch ?? "(不明)"))}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">接続先</td>
      <td style="padding:6px 0;font-family:monospace;">${escapeHtml(String(clientInfo.httpMethod ?? "POST"))} ${escapeHtml(requestUri)} (port 443)</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">プロトコル</td>
      <td style="padding:6px 0;font-family:monospace;">HTTPS (${escapeHtml(String(clientInfo.protocol ?? "HTTP/1.1"))})</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">X-Forwarded-For</td>
      <td style="padding:6px 0;font-family:monospace;">${escapeHtml(String(clientInfo.xForwardedFor ?? "(なし)"))}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;font-weight:bold;white-space:nowrap;color:#555;">API Gateway Request ID</td>
      <td style="padding:6px 0;font-family:monospace;font-size:12px;">${escapeHtml(String(clientInfo.apiRequestId ?? "(なし)"))}</td></tr>
</table>

<h3>最新ランキング TOP ${rankEntries.length}</h3>
<table style="border-collapse:collapse;width:100%;border:1px solid #dee2e6;">
  <thead>
    <tr style="background:#e91e8c;color:#fff;">
      <th style="padding:6px 8px;text-align:center;">順位</th>
      <th style="padding:6px 8px;text-align:left;">名前</th>
      <th style="padding:6px 8px;text-align:right;">タイム</th>
      <th style="padding:6px 8px;text-align:left;font-size:12px;">登録日時</th>
    </tr>
  </thead>
  <tbody>
    ${rankRows}
  </tbody>
</table>

<p style="margin-top:24px;color:#999;font-size:12px;">
  このメールは プリキュアオールスターズいえるかなクイズ のランクイン通知です。<br>
  承認リンクの有効期限は 30 日です。
</p>

</body>
</html>`;
}

/**
 * HTML エスケープ（XSS 防止）
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 管理者にランクイン通知メールを送信（SES v2）
 * ADMIN_EMAIL / SENDER_EMAIL が未設定の場合はスキップ
 * メール送信の失敗はスコア登録処理をブロックしない
 * メールには承認/却下ボタン、または自動承認済み通知が含まれる
 * @param {object} entry - ランクイン者の情報
 * @param {object} clientInfo - クライアント情報
 * @param {Array} rankEntries - 最新の順位表
 * @param {string} approveUrl - 承認用 URL（自動承認時は空文字）
 * @param {string} rejectUrl - 却下用 URL（自動承認時は空文字）
 * @param {object} options - オプション
 * @param {boolean} options.autoApproved - 自動承認済みの場合 true
 */
async function sendAdminNotification(entry, clientInfo, rankEntries, approveUrl, rejectUrl, options = {}) {
  if (!ADMIN_EMAIL || !SENDER_EMAIL) return;

  const timeStr = (entry.totalTimeCs / 100).toFixed(2);
  // 自動承認時と承認待ち時でメール件名を分ける
  const subject = options.autoApproved
    ? `[いえるかなクイズ] 自動承認: ${entry.name} (${timeStr}s)`
    : `[いえるかなクイズ] 承認待ち: ${entry.name} (${timeStr}s)`;
  const htmlBody = buildNotificationHtml(entry, clientInfo, rankEntries, approveUrl, rejectUrl, options);

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: SENDER_EMAIL,
        Destination: { ToAddresses: [ADMIN_EMAIL] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: htmlBody, Charset: "UTF-8" },
            },
          },
        },
      })
    );
  } catch (err) {
    // メール送信失敗はスコア登録の成功に影響させない
    console.error("Failed to send admin notification:", err);
  }
}

// --- Handler ---

export const handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Invalid JSON" });
  }

  const { token, name: rawName, correct, totalTimeCs, resultBinary } = body;

  // リクエストからクライアント情報を抽出（荒らし対策）
  const clientInfo = extractClientInfo(event);

  // 1. セッショントークンの署名・有効期限・タイム整合性を検証
  const tokenResult = verifyToken(token, totalTimeCs);
  if (!tokenResult.valid) {
    return response(403, { error: tokenResult.reason });
  }

  // 2. トークンの一回限り使用を保証（リプレイ攻撃防止）
  const isNew = await consumeToken(tokenResult.nonce);
  if (!isNew) {
    return response(403, { error: "token already used" });
  }

  // 3. 名前のサニタイズ
  const name = sanitizeName(rawName);
  if (!name) {
    return response(400, { error: "Invalid name (1-16 characters, no HTML)" });
  }

  // 4. スコアデータの整合性検証
  if (!validateScore(correct, totalTimeCs, resultBinary)) {
    return response(400, { error: "Invalid score data" });
  }

  // 5. 監査ログを書き込み（ランクイン有無にかかわらず全送信を記録）
  await writeAuditLog(tokenResult.nonce, {
    name,
    correct,
    totalTimeCs,
    resultBinary: resultBinary || "",
    clientInfo,
    submittedAt: new Date().toISOString(),
  });

  // 6. 現在のランキングを DynamoDB から読み込み
  const getResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: "leaderboard" } })
  );

  const current = getResult.Item || { pk: "leaderboard", entries: [], version: 0 };
  // entries キーを優先し、旧形式 top20 からのフォールバックも対応
  const entries = current.entries || current.top20 || [];

  // 7. 同一名義の重複チェック
  //    同じ名前のエントリが既にランキングにある場合、
  //    新スコアが既存より良い（タイムが短い）場合のみ置換する
  const existingEntry = entries.find((e) => e.name === name);
  if (existingEntry && totalTimeCs >= existingEntry.totalTimeCs) {
    // 既存の記録の方が良い、または同等 → 更新しない、通知メールも不要
    return response(200, {
      qualified: true,
      pending: false,
      autoApproved: true,
      recordUpdated: false,
      entries: stripClientInfo(entries),
    });
  }

  // 同一名義のエントリを除外してから新エントリを追加（名前の重複を防ぐ）
  const entriesWithoutSameName = entries.filter((e) => e.name !== name);

  const newEntry = {
    name,
    correct,
    totalTimeCs,
    resultBinary: resultBinary || "",
    timestamp: new Date().toISOString(),
    // クライアント情報は DynamoDB にのみ保持（公開 JSON には含めない）
    clientInfo,
  };

  const merged = [...entriesWithoutSameName, newEntry].sort(rankEntry).slice(0, TOP_N);

  const qualified = merged.some(
    (e) => e.timestamp === newEntry.timestamp && e.name === newEntry.name
  );

  if (!qualified) {
    return response(200, { qualified: false, entries: stripClientInfo(entries) });
  }

  // 8. 自動承認判定：送信された名前がランキング上の既存名と完全一致するか
  //    既にランキングに掲載されている名前は信頼済みとみなし、承認をスキップする
  const isKnownName = entries.some((e) => e.name === name);

  if (isKnownName) {
    // --- 自動承認フロー ---
    // 既知の名前なので承認待ちにせず、ランキングを直接更新する

    const lbVersion = current.version || 0;

    // 8a. ランキングを楽観的ロックで直接書き込み
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
        return response(409, { error: "concurrent update, please retry" });
      }
      throw err;
    }

    // 8b. ランキング JSON を S3 に書き出し（CloudFront 経由で配信）
    const publicEntries = stripClientInfo(merged);
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

    // 8c. 管理者に自動承認通知メールを送信（アクションボタンなし・情報通知のみ）
    const emailEntries = merged.map((e) =>
      e.timestamp === newEntry.timestamp && e.name === newEntry.name
        ? { ...e, _autoApproved: true }
        : e
    );
    await sendAdminNotification(newEntry, clientInfo, emailEntries, "", "", { autoApproved: true });

    // 8d. 自動承認済みの更新後ランキングをフロントエンドに返す
    return response(200, {
      qualified: true,
      pending: false,
      autoApproved: true,
      recordUpdated: true,
      entries: publicEntries,
    });
  }

  // --- 通常の承認待ちフロー（新規名での登録） ---

  // 9. 承認待ちエントリの同一名義チェック
  //    同じ名前で既に承認待ちがある場合、新スコアが良ければ上書き、そうでなければ更新しない
  const existingPending = await getPendingEntry(name);
  if (existingPending && totalTimeCs >= existingPending.totalTimeCs) {
    // 承認待ちの既存記録の方が良い、または同等 → 更新しない、通知メールも不要
    return response(200, {
      qualified: true,
      pending: true,
      recordUpdated: false,
      entries: stripClientInfo(entries),
    });
  }

  // 10. 承認待ちとして DynamoDB に保存（名前単位で1レコード、ベストスコアのみ保持）
  await writePendingEntry(name, newEntry);

  // 11. 管理者にランクイン通知メールを送信（承認/却下ボタン付き）
  //     承認リンクは名前ベース（同一名義のどのメールからでも操作可能）
  const apiDomain = event.requestContext?.domainName || "";
  const stage = event.requestContext?.stage || "prod";
  const baseUrl = `https://${apiDomain}/${stage}`;
  const encodedName = encodeURIComponent(name);
  const approveSig = generateAdminSignature("approve", name);
  const rejectSig = generateAdminSignature("reject", name);
  const approveUrl = `${baseUrl}/api/admin/approve?name=${encodedName}&sig=${approveSig}`;
  const rejectUrl = `${baseUrl}/api/admin/reject?name=${encodedName}&sig=${rejectSig}`;

  // メール表示用：承認済みランキングに今回の承認待ちエントリを暫定マージ
  const emailEntries = [...entriesWithoutSameName, { ...newEntry, _pending: true }].sort(rankEntry).slice(0, TOP_N);

  await sendAdminNotification(newEntry, clientInfo, emailEntries, approveUrl, rejectUrl);

  // 12. 承認待ち状態をフロントエンドに返す（ランキングは即時更新しない）
  return response(200, { qualified: true, pending: true, recordUpdated: true });
};

/**
 * 公開用にクライアント情報を除去したランキング配列を返す
 * leaderboard.json や API レスポンスにはクライアント情報を含めない
 * @param {Array} entries - ランキングエントリ配列
 * @returns {Array} clientInfo を除去した配列
 */
function stripClientInfo(entries) {
  return entries.map(({ clientInfo: _ci, ...rest }) => rest);
}
