// Cloudflare Pages Function：推播 LINE 訊息 (相容原 Netlify 邏輯)
const API_KEY = 'AIzaSyC9xKAQYcfyUyA815fUD3I-T3fVIikW0jU'; // 預設值
const PROJECT = 'rd320-3681667'; // 預設值

const json = (statusCode, obj) => {
  return new Response(JSON.stringify(obj), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' }
  });
};

// 驗證呼叫者已登入 Firebase
async function whoami(request, env) {
  const apiKey = env.FIREBASE_API_KEY || API_KEY;
  const token = (request.headers.get('authorization') || request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`https://googleapis.com{apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }),
  });
  if (!r.ok) return null;
  const u = ((await r.json()).users || []);
  if (!u || !u.email) return null;
  return { email: u.email.toLowerCase(), uid: u.localId, token };
}

// 判斷是否為管理員
async function isAdmin(me, env) {
  const projectId = env.FIREBASE_PROJECT_ID || PROJECT;
  const r = await fetch(`https://googleapis.com{projectId}/databases/(default)/documents/config/admins`, {
    headers: { Authorization: 'Bearer ' + me.token },
  });
  if (!r.ok) return false;
  const j = await r.json();
  const vals = ((((j.fields || {}).emails || {}).arrayValue || {}).values || []).map(v => String(v.stringValue || '').toLowerCase());
  return vals.includes(me.email);
}

async function linePush(to, text, env) {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const r = await fetch('https://line.me', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (r.ok) return { ok: true };
  let detail = ''; try { detail = (await r.text()).slice(0, 300); } catch (e) {}
  return { ok: false, status: r.status, detail };
}

// Cloudflare 統一請求入口 (相容 GET 與 POST)
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 診斷用 GET 請求
  if (request.method === 'GET') {
    return json(200, {
      ok: true,
      lineTokenSet: !!env.LINE_CHANNEL_ACCESS_TOKEN,
      lineToCount: (env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean).length,
      webhookSecretSet: !!env.LINE_CHANNEL_SECRET,
    });
  }

  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const me = await whoami(request, env);
  if (!me) return json(401, { error: 'invalid token' });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const text = String(body.text || '').trim().slice(0, 900);
  if (!text) return json(400, { error: 'empty text' });
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return json(500, { error: 'LINE 尚未設定（缺少 LINE_CHANNEL_ACCESS_TOKEN）' });

  // 傳給指定老師（僅管理員）
  if (body.toEmail) {
    if (!(await isAdmin(me, env))) return json(403, { error: '只有管理員可以傳給指定老師' });
    
    if (!env.LINE_BIND) return json(500, { error: 'Cloudflare KV 命名空間未正確綁定' });
    let bound = null;
    try {
      const kvData = await env.LINE_BIND.get('email:' + String(body.toEmail).toLowerCase());
      bound = kvData ? JSON.parse(kvData) : null;
    } catch (e) { return json(500, { error: '讀取 KV 綁定資料失敗：' + e.message }); }
    
    if (!bound || !bound.userId) return json(200, { ok: true, sent: 0, noBinding: true });
    const r = await linePush(bound.userId, text, env);
    return json(200, { ok: true, sent: r.ok ? 1 : 0, failed: r.ok ? 0 : 1, errors: r.ok ? [] : [{ status: r.status, detail: r.detail }] });
  }

  // 傳給管理員
  const to = (env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) return json(500, { error: 'LINE 尚未設定（缺少 LINE_TO）' });
  const results = await Promise.all(to.map(id => linePush(id, text, env)));
  const failed = results.filter(x => !x.ok);
  return json(200, { sent: results.length - failed.length, failed: failed.length, errors: failed.map(x => ({ status: x.status, detail: x.detail })) });
}
