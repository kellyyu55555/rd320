// Cloudflare Pages Function：推播 LINE 訊息 (相容原 Netlify 邏輯)
const API_KEY = 'AIzaSyC9xKAQYcfyUyA815fUD3I-T3fVIikW0jU'; // Firebase 預設金鑰值
const PROJECT = 'rd320-3681667'; // Firebase 預設專案 ID

// 統一的 JSON 回覆格式，並鎖定跨網域（CORS）解鎖標頭
const json = (statusCode, obj) => {
  return new Response(JSON.stringify(obj), {
    status: statusCode,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // 允許前端網頁跨網域呼叫
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
};

// 驗證呼叫者是否已登入 Firebase
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

// 判斷該名使用者是否為管理員
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

// 發送 LINE Messaging API 訊息
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

// Cloudflare 統一請求入口 (自動解析 GET, POST 與 OPTIONS)
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 1. 處理瀏覽器跨網域預檢請求 (OPTIONS)
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  // 2. 診斷用 GET 請求 (用瀏覽器直接點開網址時觸發)
  if (request.method === 'GET') {
    return json(200, {
      ok: true,
      status: "Cloudflare 後端核心運作正常",
      lineTokenSet: !!env.LINE_CHANNEL_ACCESS_TOKEN,
      lineToCount: (env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean).length,
      webhookSecretSet: !!env.LINE_CHANNEL_SECRET,
      kvBindingSet: !!env.LINE_BIND
    });
  }

  // 3. 限制其餘請求必須為 POST
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // 驗證 Firebase 登入狀態
  const me = await whoami(request, env);
  if (!me) return json(401, { error: '使用者驗證失敗，請重新登入系統' });

  let body = {}; try { body = await request.json(); } catch (e) {}
  const text = String(body.text || '').trim().slice(0, 900);
  if (!text) return json(400, { error: '推播訊息內容不可為空白' });
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return json(500, { error: 'Cloudflare 後台尚未設定 LINE_CHANNEL_ACCESS_TOKEN' });

  // 情況 A：傳送給特定個人老師（僅限管理員權限，需讀取 KV 資料庫）
  if (body.toEmail) {
    if (!(await isAdmin(me, env))) return json(403, { error: '權限不足：只有管理員可以發送個人提醒' });
    if (!env.LINE_BIND) return json(500, { error: 'Cloudflare KV 命名空間（LINE_BIND）未正確綁定' });
    
    let bound = null;
    try {
      const kvData = await env.LINE_BIND.get('email:' + String(body.toEmail).toLowerCase());
      bound = kvData ? JSON.parse(kvData) : null;
    } catch (e) { return json(500, { error: '讀取 KV 老師綁定資料失敗：' + e.message }); }
    
    if (!bound || !bound.userId) return json(200, { ok: true, sent: 0, noBinding: true });
    const r = await linePush(bound.userId, text, env);
    return json(200, { ok: true, sent: r.ok ? 1 : 0, failed: r.ok ? 0 : 1, errors: r.ok ? [] : [{ status: r.status, detail: r.detail }] });
  }

  // 情況 B：集體推播 / 發送給預設管理群組
  const to = (env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) return json(500, { error: 'Cloudflare 後台尚未設定接收群組（LINE_TO）' });
  
  const results = await Promise.all(to.map(id => linePush(id, text, env)));
  const failed = results.filter(x => !x.ok);
  return json(200, { ok: true, sent: results.length - failed.length, failed: failed.length, errors: failed.map(x => ({ status: x.status, detail: x.detail })) });
}
