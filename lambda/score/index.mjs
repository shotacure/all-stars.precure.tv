import { createHmac } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// --- Configuration ---

const SECRET = process.env.SESSION_SECRET;
const TABLE_NAME = process.env.TABLE_NAME;
const SITE_BUCKET = process.env.SITE_BUCKET;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const MAX_NAME_LENGTH = 16;
const TOP_N = 20;
const TOTAL_QUESTIONS = 10;

// ネットワーク遅延を考慮したタイム検証の許容誤差（ミリ秒）
const TIME_TOLERANCE_MS = 3000;
// トークン有効期限（ミリ秒）：クイズ所要時間を考慮して10分
const TOKEN_EXPIRY_MS = 600_000;
// 使用済みトークンの DynamoDB TTL（秒）：トークン有効期限の2倍を保持
const TOKEN_TTL_SECONDS = Math.ceil((TOKEN_EXPIRY_MS * 2) / 1000);
// 合計タイムの上限（センチ秒）：655.35秒 = 65535cs（フロント側と同じ上限）
const MAX_TOTAL_TIME_CS = 65535;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

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
 * - DynamoDB に nonce を条件付き書き込みし、既存なら拒否
 * - TTL で自動削除されるため無限に蓄積しない
 * @returns {boolean} true=未使用（正常）、false=使用済み（リプレイ）
 */
async function consumeToken(nonce) {
  const ttl = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: `token:${nonce}`, ttl },
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return false;
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

// --- Handler ---

export const handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Invalid JSON" });
  }

  const { token, name: rawName, correct, totalTimeCs, resultBinary } = body;

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

  // 5. 現在のランキングを DynamoDB から読み込み
  const getResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: "leaderboard" } })
  );

  const current = getResult.Item || { pk: "leaderboard", top20: [], version: 0 };
  const top20 = current.top20 || [];
  const version = current.version || 0;

  // 6. ランクイン判定
  const newEntry = {
    name,
    correct,
    totalTimeCs,
    resultBinary: resultBinary || "",
    timestamp: new Date().toISOString(),
  };

  const merged = [...top20, newEntry].sort(rankEntry).slice(0, TOP_N);

  const qualified = merged.some(
    (e) => e.timestamp === newEntry.timestamp && e.name === newEntry.name
  );

  if (!qualified) {
    return response(200, { qualified: false, top20 });
  }

  // 7. 楽観的ロックで DynamoDB に書き込み
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: "leaderboard", top20: merged, version: version + 1 },
        ConditionExpression: "attribute_not_exists(version) OR version = :v",
        ExpressionAttributeValues: { ":v": version },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return response(409, { error: "Concurrent update, please retry" });
    }
    throw err;
  }

  // 8. ランキング JSON を S3 に書き出し（CloudFront経由で配信）
  const leaderboardJson = JSON.stringify(
    { updatedAt: new Date().toISOString(), top20: merged },
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

  return response(200, { qualified: true, top20: merged });
};
