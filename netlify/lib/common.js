// 共用工具：驗證 Firebase 登入、判斷是否為管理員、LINE 推播、綁定資料儲存
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyC9xKAQYcfyUyA815fUD3I-T3fVIikW0jU';
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'rd320-3681667';

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// 驗證呼叫者已登入 Firebase，回傳 { email, uid, token }
async function whoami(event) {
  const h = event.headers || {};
  const token = (h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }),
  });
  if (!r.ok) return null;
  const u = ((await r.json()).users || [])[0];
  if (!u || !u.email) return null;
  return { email: u.email.toLowerCase(), uid: u.localId, token };
}

// 用呼叫者自己的登入憑證讀取 config/admins，判斷是否為管理員
async function isAdmin(me) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/config/admins`, {
    headers: { Authorization: 'Bearer ' + me.token },
  });
  if (!r.ok) return false;
  const j = await r.json();
  const vals = ((((j.fields || {}).emails || {}).arrayValue || {}).values || []).map(v => String(v.stringValue || '').toLowerCase());
  return vals.includes(me.email);
}

// Netlify Blobs：存「綁定碼」與「Email ↔ LINE userId」
async function store(event) {
  const { getStore, connectLambda } = await import('@netlify/blobs');
  try { connectLambda(event); } catch (e) {}
  return getStore('line-bind');
}

async function linePush(to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (r.ok) return { ok: true };
  let detail = ''; try { detail = (await r.text()).slice(0, 300); } catch (e) {}
  return { ok: false, status: r.status, detail };
}

module.exports = { json, whoami, isAdmin, store, linePush };
