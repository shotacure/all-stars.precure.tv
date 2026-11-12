import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

// --- Configuration ---

const TABLE_NAME = process.env.TABLE_NAME;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const SENDER_EMAIL = process.env.SENDER_EMAIL || "";

// 自動承認の記録（score 側と同一のキーを使うこと）
const AUTO_APPROVALS_PK = "autoapprovals";
// レポート対象の時間窓（時間）
const REPORT_WINDOW_HOURS = 24;
// 前回レポート時刻をレポート起点として採用する許容幅（時間）
// スケジュール起動の数秒〜数分のずれで、境界付近の自動承認が漏れたり重複したりするのを防ぐ
const SCHEDULE_JITTER_HOURS = 1;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESv2Client({});

// --- Helpers ---

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
 * ISO 文字列を JST の読みやすい表記に変換
 */
function toJst(iso) {
  if (!iso) return "(不明)";
  try {
    return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  } catch {
    return String(iso);
  }
}

/**
 * センチ秒を「12.34s」形式に変換
 */
function formatTime(cs) {
  return `${(cs / 100).toFixed(2)}s`;
}

/**
 * 自動承認レポートメールの HTML を生成
 * @param {Array} events - レポート対象の自動承認（古い順）
 * @param {string} sinceIso - レポート対象期間の開始時刻
 * @param {string} untilIso - レポート対象期間の終了時刻
 * @returns {string} HTML 文字列
 */
function buildReportHtml(events, sinceIso, untilIso) {
  const flaggedCount = events.filter((e) => e.suspicious).length;

  const banner = flaggedCount > 0
    ? `<p style="background:#dc3545;color:#ffffff;padding:12px 14px;border-radius:8px;font-weight:bold;">
  🚨 自演の疑い（同一端末から複数の名前で送信）が ${flaggedCount} 件含まれています。該当行をご確認ください。
</p>`
    : "";

  const rows = events
    .map((e, i) => {
      const ci = e.clientInfo || {};
      const bg = e.suspicious ? "#f8d7da" : i % 2 === 0 ? "#f8f9fa" : "#ffffff";
      const previous = typeof e.previousTimeCs === "number"
        ? `<br><span style="color:#888;font-size:12px;">前回 ${formatTime(e.previousTimeCs)}</span>`
        : "";
      const warning = e.suspicious
        ? `<br><span style="color:#a71d2a;font-size:12px;font-weight:bold;">🚨 ${e.suspicious.windowHours}h内に別名${e.suspicious.nameCount}件: ` +
          `${escapeHtml((e.suspicious.names || []).join("、"))}</span>`
        : "";
      return `<tr style="background:${bg};vertical-align:top;">
        <td style="padding:6px 8px;white-space:nowrap;font-size:12px;">${escapeHtml(toJst(e.approvedAt))}</td>
        <td style="padding:6px 8px;"><strong>${escapeHtml(e.name)}</strong>${warning}</td>
        <td style="padding:6px 8px;text-align:right;white-space:nowrap;">${formatTime(e.totalTimeCs)}${previous}</td>
        <td style="padding:6px 8px;text-align:center;">${e.rank || "-"}</td>
        <td style="padding:6px 8px;font-size:12px;word-break:break-all;">
          <span style="font-family:monospace;">${escapeHtml(ci.sourceIp || "(不明)")}</span>
          ${ci.cloudFrontViewerCountry ? `(${escapeHtml(ci.cloudFrontViewerCountry)})` : ""}<br>
          <span style="color:#888;">${escapeHtml(ci.userAgent || "(不明)")}</span>
        </td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,sans-serif;max-width:700px;margin:0 auto;padding:20px;color:#333;">

<h2 style="color:#e91e8c;border-bottom:2px solid #e91e8c;padding-bottom:8px;">
  🎀 自動承認レポート（${events.length} 件）
</h2>

<p style="background:#d4edda;padding:12px;border-radius:8px;border:1px solid #28a745;">
  ✅ ${escapeHtml(toJst(sinceIso))} 〜 ${escapeHtml(toJst(untilIso))} の間に、
  ランキング既存の名前と一致したため <strong>自動承認</strong> された記録更新は ${events.length} 件です。
  ランキングは既に更新済みです。
</p>

${banner}

<table style="border-collapse:collapse;width:100%;border:1px solid #dee2e6;font-size:14px;">
  <thead>
    <tr style="background:#e91e8c;color:#fff;">
      <th style="padding:6px 8px;text-align:left;">日時(JST)</th>
      <th style="padding:6px 8px;text-align:left;">名前</th>
      <th style="padding:6px 8px;text-align:right;">タイム</th>
      <th style="padding:6px 8px;text-align:center;">順位</th>
      <th style="padding:6px 8px;text-align:left;">IP / User-Agent</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>

<p style="margin-top:24px;color:#999;font-size:12px;">
  このメールは プリキュアオールスターズいえるかなクイズ の自動承認レポートです。<br>
  自動承認が 1 件も無かった日は送信されません。順位は承認時点のものです。
</p>

</body>
</html>`;
}

// --- Handler ---

/**
 * 毎朝 8:30 (JST) に EventBridge から起動され、過去24時間の自動承認をまとめて
 * 管理者にメールでレポートする。対象期間に自動承認が無ければ何も送信しない。
 */
export const handler = async () => {
  if (!ADMIN_EMAIL || !SENDER_EMAIL) return { sent: false, reason: "email disabled" };

  const getResult = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: AUTO_APPROVALS_PK } })
  );
  const item = getResult.Item;
  if (!item) return { sent: false, count: 0 };

  const now = Date.now();
  const untilIso = new Date(now).toISOString();
  const windowStartIso = new Date(now - REPORT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const jitterStartIso = new Date(
    now - (REPORT_WINDOW_HOURS + SCHEDULE_JITTER_HOURS) * 60 * 60 * 1000
  ).toISOString();

  // レポート起点：原則は24時間前。前回レポートがほぼ予定どおり（24時間±許容幅以内）に
  // 送信済みであれば、その時刻を起点にして漏れ・重複を防ぐ
  const last = item.lastReportedAt;
  const sinceIso = last && last > jitterStartIso ? last : windowStartIso;

  // 区間は [since, until)：境界ちょうどの記録は次回のレポートに回す
  // （今回の読み取り後に同じミリ秒で追記された記録が、どちらの回からも漏れるのを防ぐ）
  const events = (item.events || [])
    .filter((e) => e && e.approvedAt >= sinceIso && e.approvedAt < untilIso)
    .sort((a, b) => (a.approvedAt < b.approvedAt ? -1 : 1));

  // 対象期間に自動承認が無ければレポートしない
  if (events.length === 0) return { sent: false, count: 0 };

  const flagged = events.some((e) => e.suspicious);
  const subject =
    `${flagged ? "🚨要確認 " : ""}[いえるかなクイズ] 自動承認レポート: ${events.length}件（過去${REPORT_WINDOW_HOURS}時間）`;

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: SENDER_EMAIL,
      Destination: { ToAddresses: [ADMIN_EMAIL] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: buildReportHtml(events, sinceIso, untilIso), Charset: "UTF-8" },
          },
        },
      },
    })
  );

  // 送信済み時刻を記録（version を進め、score 側の同時書き込みで巻き戻らないようにする）
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: AUTO_APPROVALS_PK },
      UpdateExpression: "SET lastReportedAt = :t ADD version :one",
      ExpressionAttributeValues: { ":t": untilIso, ":one": 1 },
    })
  );

  return { sent: true, count: events.length };
};
