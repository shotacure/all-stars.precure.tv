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

// 記録バージョン（score 側と同一の値を設定すること。詳細は score/index.mjs 参照）
const RECORDS_VERSION = process.env.RECORDS_VERSION || "1";
const LEADERBOARD_PK = RECORDS_VERSION === "1" ? "leaderboard" : `leaderboard#v${RECORDS_VERSION}`;
const PENDINGS_PK = RECORDS_VERSION === "1" ? "pendings" : `pendings#v${RECORDS_VERSION}`;

// シャドウ対象端末のレコード（score 側と同一のキーを使うこと）
// 削除操作を行うと、対象エントリの送信元端末（同一IP・同一UA）をここに登録する
// 登録された端末からの以降の送信は、score 側で「受け付けたように見える応答」だけ返し破棄される
const SHADOWS_PK = "shadows";
// シャドウ登録の有効期間（日）：IP の再割り当てで無関係な人を巻き込み続けないよう期限を設ける
const SHADOW_TTL_DAYS = 30;
// 削除時に同一端末のエントリをまとめて削除する対象期間（日）
const SWEEP_WINDOW_DAYS = 7;

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
  // score 側の stripClientInfo と同じ項目を除去すること
  return entries.map(
    ({ clientInfo: _ci, id: _id, resultBinary: _rb, correct: _c, ...rest }) => rest
  );
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
 * IPv6 アドレスを 8 グループの正規化済み配列に展開する（score 側と同一ロジック）
 * 解析不能な形式は null を返す
 * @param {string} addr - IPv6 文字列
 * @returns {string[]|null} 8 要素の hextet 配列、または null
 */
function expandIpv6(addr) {
  const clean = addr.split("%")[0];
  if (clean.includes(".")) return null;
  const halves = clean.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  const normalized = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    normalized.push(g.toLowerCase().padStart(4, "0"));
  }
  return normalized;
}

/**
 * 端末の同一性判定キー（score 側と同一ロジックであること）
 * - IPv4: アドレス完全一致
 * - IPv6: 先頭4グループ（/64）一致
 * - User-Agent: 完全一致
 * IP または UA が判定不能な場合は null（→ 一括削除・シャドウ登録の対象外）
 * @param {object} clientInfo - クライアント情報
 * @returns {string|null}
 */
function clientKey(clientInfo) {
  const ua = clientInfo?.userAgent;
  const ip = clientInfo?.sourceIp;
  if (typeof ua !== "string" || ua === "" || typeof ip !== "string") return null;
  const addr = ip.trim().split("%")[0];
  if (addr === "") return null;

  if (addr.includes(":")) {
    const groups = expandIpv6(addr);
    if (!groups) return null;
    return `v6:${groups.slice(0, 4).join(":")}|${ua}`;
  }
  return `v4:${addr}|${ua}`;
}

/**
 * 端末をシャドウ対象として登録（pk: SHADOWS_PK の entries 配列）
 * - 期限切れの登録は書き込み時に自動除去
 * - 同一端末が既に登録済みの場合は期限を延長
 * - 楽観的ロックで同時書き込みの競合を防止（競合時はリトライ）
 * @param {Array<{key: string, sourceIp: string, userAgent: string}>} devices - 登録する端末
 * @param {string} name - 削除操作の対象となった名前（記録用）
 * @param {number} retries - リトライ残回数
 */
async function addShadows(devices, name, retries = 3) {
  const getResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: SHADOWS_PK } })
  );
  const current = getResult.Item || { pk: SHADOWS_PK, entries: [], version: 0 };
  const version = current.version || 0;

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + SHADOW_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const newKeys = new Set(devices.map((d) => d.key));
  const kept = (current.entries || []).filter(
    (e) => e && e.expiresAt > nowIso && !newKeys.has(e.key)
  );
  const added = devices.map((d) => ({
    key: d.key,
    sourceIp: d.sourceIp,
    userAgent: d.userAgent,
    name,
    addedAt: nowIso,
    expiresAt,
  }));

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: SHADOWS_PK, entries: [...kept, ...added], version: version + 1 },
        ConditionExpression: "attribute_not_exists(version) OR version = :v",
        ExpressionAttributeValues: { ":v": version },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException" && retries > 0) {
      return addShadows(devices, name, retries - 1);
    }
    throw err;
  }
}

/**
 * 集約型 pendings レコードから指定名義（複数可）を削除して書き戻す
 * @param {object} pendingsItem - DynamoDB の pendings レコード全体
 * @param {string[]} names - 削除する名前（entries マップのキー）
 * @returns {boolean} 削除に成功したら true
 */
async function removePendingEntries(pendingsItem, names) {
  const entries = pendingsItem.entries || {};
  const version = pendingsItem.version || 0;
  const targets = names.filter((n) => entries[n]);
  if (targets.length === 0) return false;

  const updated = { ...entries };
  for (const n of targets) delete updated[n];
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: PENDINGS_PK, entries: updated, version: version + 1 },
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

  // 承認待ちエントリを集約レコード（pk: PENDINGS_PK）から取得
  const pendingsResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: PENDINGS_PK } })
  );
  const pendingsItem = pendingsResult.Item || { pk: PENDINGS_PK, entries: {}, version: 0 };
  const targetEntry = (pendingsItem.entries || {})[lookupKey] || null;
  const hasPending = targetEntry && targetEntry.name && targetEntry.totalTimeCs;

  if (action === "reject") {
    // --- 削除処理 ---
    // 承認は「名義」の承認なので、削除も名義単位で行う
    // さらに、削除対象と同じ端末（同一IP・同一UA）から直近に送信されたエントリを
    // 別名義も含めてすべて削除し、その端末をシャドウ対象に登録する
    const targetName = hasPending ? targetEntry.name : lookupKey;
    const pendingEntries = pendingsItem.entries || {};
    const lbResult = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: LEADERBOARD_PK } })
    );
    const lbItem = lbResult.Item || { pk: LEADERBOARD_PK, entries: [], version: 0 };
    const entries = lbItem.entries || lbItem.top20 || [];
    const lbVersion = lbItem.version || 0;

    // 1. 削除対象名義のエントリ（承認待ち・ランキング）から送信元端末を特定
    const namedTargets = [
      ...(hasPending ? [targetEntry] : []),
      ...entries.filter((e) => e.name === targetName),
    ];
    const devices = new Map();
    for (const e of namedTargets) {
      const key = clientKey(e.clientInfo);
      if (key && !devices.has(key)) {
        devices.set(key, {
          key,
          sourceIp: e.clientInfo.sourceIp,
          userAgent: e.clientInfo.userAgent,
        });
      }
    }

    // 同一端末から対象期間内に送信されたエントリかどうか
    const sweepCutoff = new Date(
      Date.now() - SWEEP_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const isSameDevice = (e) =>
      !!e && !!e.timestamp && e.timestamp >= sweepCutoff && devices.has(clientKey(e.clientInfo));

    // 2. 端末をシャドウ対象に登録（削除より先に行い、処理中の再送信も遮断する）
    let shadowRegistered = false;
    if (namedTargets.length > 0 && devices.size > 0) {
      try {
        await addShadows([...devices.values()], targetName);
        shadowRegistered = true;
      } catch (err) {
        // シャドウ登録の失敗は削除処理をブロックしない（結果ページで通知）
        console.error("Failed to register shadow devices:", err);
      }
    }

    // 3. 承認待ちレコードから該当名義と同一端末のエントリを除去
    const pendingNames = Object.keys(pendingEntries).filter(
      (k) => (hasPending && k === lookupKey) || isSameDevice(pendingEntries[k])
    );
    let deletedFromPending = false;
    if (pendingNames.length > 0) {
      deletedFromPending = await removePendingEntries(pendingsItem, pendingNames);
      if (!deletedFromPending) {
        return htmlResponse(409, "競合エラー",
          '<div class="icon">⚡</div><h1>同時更新の競合</h1><p>ブラウザを再読み込みして再度お試しください。</p>',
          "#ffc107");
      }
    }

    // 4. ランキングからも同一名義と同一端末のエントリを削除
    const isLbTarget = (e) => e.name === targetName || isSameDevice(e);
    const lbNames = entries.filter(isLbTarget).map((e) => e.name);
    let deletedFromLeaderboard = false;

    if (lbNames.length > 0) {
      // ランキングから対象を除外して再書き込み
      const filtered = entries.filter((e) => !isLbTarget(e));
      try {
        await ddb.send(
          new PutCommand({
            TableName: TABLE_NAME,
            Item: { pk: LEADERBOARD_PK, entries: filtered, version: lbVersion + 1 },
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

    // 同一端末（同一IP・同一UA）から巻き取って削除した別名義の一覧
    const sweptNames = [...new Set([
      ...(deletedFromPending ? pendingNames.map((k) => pendingEntries[k].name || k) : []),
      ...(deletedFromLeaderboard ? lbNames : []),
    ])].filter((n) => n !== targetName);
    if (sweptNames.length > 0) {
      deleteMsg += `<p>同じ端末（同一IP・同一UA）から直近 ${SWEEP_WINDOW_DAYS} 日以内に送信された ` +
        `${sweptNames.length} 件もあわせて削除しました：<br><strong>` +
        sweptNames.map(escapeHtml).join("、") + `</strong></p>`;
    }

    if (shadowRegistered) {
      deleteMsg += `<p style="font-size:0.9em;">この端末からの今後の送信は、受け付けたように見せたまま破棄されます（${SHADOW_TTL_DAYS} 日間）。</p>`;
    } else if (devices.size === 0) {
      deleteMsg += `<p style="font-size:0.9em;">送信元の IP / User-Agent を特定できなかったため、端末単位の一括削除と以後の遮断は行っていません。</p>`;
    } else {
      deleteMsg += `<p style="font-size:0.9em;color:#dc3545;">端末の遮断登録に失敗しました（削除自体は完了）。CloudWatch Logs を確認してください。</p>`;
    }
    deleteMsg += `<p style="font-size:0.9em;">監査ログには記録が残っています。</p>`;

    return htmlResponse(200, "削除完了", deleteMsg, "#dc3545");
  }

  // --- 承認処理 ---

  // 承認待ちエントリが見つからない場合、既にランキングに掲載済みか確認
  if (!hasPending) {
    const targetName = lookupKey;
    const lbResult = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: LEADERBOARD_PK } })
    );
    const lbItem = lbResult.Item || { pk: LEADERBOARD_PK, entries: [], version: 0 };
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
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: LEADERBOARD_PK } })
  );
  const lbItem = lbResult.Item || { pk: LEADERBOARD_PK, entries: [], version: 0 };
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
        Item: { pk: LEADERBOARD_PK, entries: merged, version: lbVersion + 1 },
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
  await removePendingEntries(pendingsItem, [lookupKey]).catch(() => {
    // pending の削除失敗は承認処理の成功に影響させない
    console.error("Failed to remove approved entry from pending list");
  });

  // 5. ランキング JSON を S3 に書き出し（CloudFront 経由で配信）
  await writeLeaderboardJson(merged);

  const timeStr = (targetEntry.totalTimeCs / 100).toFixed(2);
  const rank = merged.findIndex((e) => e.timestamp === targetEntry.timestamp && e.name === targetEntry.name) + 1;
  // 承認待ちの間に上位が埋まり、上位 TOP_N 件から外れた場合は掲載されない
  if (rank === 0) {
    return htmlResponse(200, "圏外",
      `<div class="icon">📉</div><h1>ランキング圏外でした</h1>` +
      `<p><strong>${escapeHtml(targetEntry.name)}</strong>（${timeStr}秒）は承認されましたが、` +
      `現在の上位 ${TOP_N} 位に入らないため掲載されていません。</p>`,
      "#6c757d");
  }
  return htmlResponse(200, "承認完了",
    `<div class="icon">✅</div><h1>承認しました</h1>` +
    `<p><strong>${escapeHtml(targetEntry.name)}</strong>（${timeStr}秒）をランキング第 ${rank} 位として掲載しました。</p>`,
    "#28a745");
};
