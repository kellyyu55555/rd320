// Netlify Function：老師送出借還／護貝膜申請後，推播 LINE 訊息給管理員
// 需要的環境變數（Netlify → Site configuration → Environment variables）：
//   LINE_CHANNEL_ACCESS_TOKEN  LINE Messaging API 的 Channel access token（長期）
//   LINE_TO                    接收通知的 LINE userId（多位管理員用逗號分隔）
//   FIREBASE_API_KEY           （選填）預設已帶入本系統 firebaseConfig 的 apiKey
const DEFAULT_FIREBASE_API_KEY = 'AIzaSyC9xKAQYcfyUyA815fUD3I-T3fVIikW0jU';

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // 1. 驗證呼叫者已登入 Firebase（避免外人亂發通知）
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const idToken = auth.replace(/^Bearer\s+/i, '');
  if (!idToken) return json(401, { error: 'missing token' });
  const apiKey = process.env.FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY;
  const check = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
  });
  if (!check.ok) return json(401, { error: 'invalid token' });

  // 2. 取得訊息內容
  let text = '';
  try { text = String(JSON.parse(event.body || '{}').text || '').trim().slice(0, 900); } catch (e) {}
  if (!text) return json(400, { error: 'empty text' });

  // 3. 推播 LINE
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = (process.env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || to.length === 0) return json(500, { error: 'LINE 尚未設定（缺少 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_TO）' });

  const results = await Promise.all(to.map(async id => {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: id, messages: [{ type: 'text', text }] }),
    });
    return r.ok;
  }));
  return json(200, { sent: results.filter(Boolean).length, failed: results.filter(x => !x).length });
};
