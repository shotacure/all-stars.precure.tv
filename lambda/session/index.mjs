import { createHmac, randomBytes } from "node:crypto";

const SECRET = process.env.SESSION_SECRET;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Cache-Control": "no-store",
};

export const handler = async () => {
  const timestamp = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const payload = `${timestamp}.${nonce}`;
  const signature = createHmac("sha256", SECRET)
    .update(payload)
    .digest("hex");

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      token: `${payload}.${signature}`,
    }),
  };
};
