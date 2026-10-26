// Cloudflare Worker：網站（靜態檔）＋ LINE 通知／綁定 API
// 網址與原本 Netlify 相同：/.netlify/functions/line-notify、line-bind、line-webhook（也可用 /api/line-notify …），
// 所以網頁（index.html）不用修改。
//
// 需要的「機密」(Secrets)：LINE_CHANNEL_ACCESS_TOKEN、LINE_CHANNEL_SECRET、LINE_TO
// 老師綁定 LINE 另需要 KV 儲存空間，綁定名稱：LINE_KV（沒有設定時，只有「老師綁定」不能用，管理員通知不受影響）

const DEFAULT_API_KEY = 'AIzaSyC9xKAQYcfyUyA815fUD3I-T3fVIikW0jU';
const DEFAULT_PROJECT = 'rd320-3681667';

// 清理貼上的憑證：去掉前後空白／換行、頭尾引號，以及中間不小心帶進來的空白
const clean = v => String(v == null ? '' : v).trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
const lineToken = env => clean(env.LINE_CHANNEL_ACCESS_TOKEN);
const lineSecret = env => clean(env.LINE_CHANNEL_SECRET);
const lineToList = env => String(env.LINE_TO || '').split(',').map(clean).filter(Boolean);
// 把 LINE 回的 HTML 錯誤網頁壓成一行文字，避免整段 HTML 跳在畫面上
const plain = t => String(t || '').replace(/<[^>]*>/g, ' ').replace(/&#58;/g, ':').replace(/&#47;/g, '/').replace(/&#46;/g, '.').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

// 驗證呼叫者已登入 Firebase，回傳 { email, uid, token }
async function whoami(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const key = env.FIREBASE_API_KEY || DEFAULT_API_KEY;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }),
  });
  if (!r.ok) return null;
  const u = ((await r.json()).users || [])[0];
  if (!u || !u.email) return null;
  return { email: u.email.toLowerCase(), uid: u.localId, token };
}

// 判斷是否為管理員：先看環境變數 ADMIN_EMAILS（逗號分隔），再用呼叫者自己的登入憑證讀取 config/admins
async function isAdmin(me, env) {
  const fixed = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (fixed.includes(me.email)) return true;

  const project = env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT;
  const key = env.FIREBASE_API_KEY || DEFAULT_API_KEY;
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/config/admins?key=${key}`, {
    headers: { Authorization: 'Bearer ' + me.token },
  });
  if (!r.ok) {
    let t = ''; try { t = (await r.text()).slice(0, 200); } catch (e) {}
    me.adminErr = 'Firestore ' + r.status + ' ' + t;
    return false;
  }
  const j = await r.json();
  const vals = ((((j.fields || {}).emails || {}).arrayValue || {}).values || []).map(v => String(v.stringValue || '').toLowerCase());
  if (!vals.includes(me.email)) { me.adminErr = '名單裡沒有 ' + me.email; return false; }
  return true;
}

async function linePush(env, to, text) {
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'rd320-line-notify/1.0', Authorization: `Bearer ${lineToken(env)}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (r.ok) return { ok: true };
  let detail = ''; try { detail = (await r.text()).slice(0, 600); } catch (e) {}
  if (/^\s*</.test(detail)) detail = plain(detail) + '（LINE 防火牆拒絕，請重新貼上 LINE_CHANNEL_ACCESS_TOKEN，確認沒有空白、引號或被截斷）';
  else detail = detail.slice(0, 300);
  return { ok: false, status: r.status, detail };
}

function kv(env) {
  if (!env.LINE_KV) throw new Error('尚未設定 KV 儲存空間（綁定名稱 LINE_KV）');
  return env.LINE_KV;
}

async function readBody(request) { try { return JSON.parse((await request.text()) || '{}'); } catch (e) { return {}; } }

// ───────── /line-notify ─────────
async function notify(request, env) {
  if (request.method === 'GET') {
    return json(200, {
      ok: true,
      lineTokenSet: !!lineToken(env),
      lineTokenLength: lineToken(env).length,   // LINE 長期權杖通常約 170 個字元；差太多就是貼錯
      lineToCount: lineToList(env).length,
      webhookSecretSet: !!lineSecret(env),
      kvSet: !!env.LINE_KV,
    });
  }
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const me = await whoami(request, env);
  if (!me) return json(401, { error: 'invalid token' });
  const body = await readBody(request);

  // 查詢本月 LINE 訊息用量（僅管理員）
  if (body.action === 'usage') {
    if (!(await isAdmin(me, env))) return json(403, { error: '只有管理員可以查詢用量', detail: me.adminErr || '' });
    if (!lineToken(env)) return json(200, { ok: false, error: 'LINE 尚未設定（缺少 LINE_CHANNEL_ACCESS_TOKEN）' });
    const H = { Authorization: 'Bearer ' + lineToken(env), 'User-Agent': 'rd320-line-notify/1.0' };
    const [q, c] = await Promise.all([
      fetch('https://api.line.me/v2/bot/message/quota', { headers: H }),
      fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: H }),
    ]);
    if (!q.ok || !c.ok) return json(200, { ok: false, error: 'LINE 回應錯誤（' + q.status + '/' + c.status + '）' });
    const qj = await q.json(), cj = await c.json();
    const limit = qj.type === 'limited' ? Number(qj.value || 0) : 0, used = Number(cj.totalUsage || 0);
    return json(200, { ok: true, type: qj.type, limit, used, remaining: limit ? Math.max(0, limit - used) : null });
  }

  const text = String(body.text || '').trim().slice(0, 900);
  if (!text) return json(400, { error: 'empty text' });
  if (!lineToken(env)) return json(500, { error: 'LINE 尚未設定（缺少 LINE_CHANNEL_ACCESS_TOKEN）' });

  // 傳給指定老師（僅管理員）
  if (body.toEmail) {
    if (!(await isAdmin(me, env))) return json(403, { error: '只有管理員可以傳給指定老師', detail: me.adminErr || '', build: 'v4' });
    let bound = null;
    try { bound = await kv(env).get('email:' + String(body.toEmail).toLowerCase(), 'json'); }
    catch (e) { return json(500, { error: '讀取綁定資料失敗：' + e.message }); }
    if (!bound || !bound.userId) return json(200, { ok: true, sent: 0, noBinding: true });
    const r = await linePush(env, bound.userId, text);
    return json(200, { ok: true, sent: r.ok ? 1 : 0, failed: r.ok ? 0 : 1, errors: r.ok ? [] : [{ status: r.status, detail: r.detail }] });
  }

  // 傳給管理員
  const to = lineToList(env);
  if (!to.length) return json(500, { error: 'LINE 尚未設定（缺少 LINE_TO）' });
  const results = await Promise.all(to.map(id => linePush(env, id, text)));
  const failed = results.filter(x => !x.ok);
  return json(200, { sent: results.length - failed.length, failed: failed.length, errors: failed.map(x => ({ status: x.status, detail: x.detail })) });
}

// ───────── /line-bind ─────────
async function bind(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const me = await whoami(request, env);
  if (!me) return json(401, { ok: false, error: '請先登入' });
  const body = await readBody(request);
  let k; try { k = kv(env); } catch (e) { return json(500, { ok: false, error: '無法使用儲存空間：' + e.message }); }
  if (body.action === 'status') {
    const b = await k.get('email:' + me.email, 'json');
    return json(200, { ok: true, bound: !!(b && b.userId) });
  }
  if (body.action === 'init') {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await k.put('code:' + code, JSON.stringify({ email: me.email, exp: Date.now() + 10 * 60 * 1000 }), { expirationTtl: 600 });
    return json(200, { ok: true, code });
  }
  return json(400, { ok: false, error: 'unknown action' });
}

// ───────── /line-webhook ─────────
async function hmacBase64(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  let bin = ''; sig.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
async function lineReply(env, replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'rd320-line-notify/1.0', Authorization: `Bearer ${lineToken(env)}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  }).catch(() => {});
}
async function webhook(request, env) {
  if (request.method === 'GET') {
    const sec = lineSecret(env);
    return json(200, { ok: true, secretSet: !!sec, secretLength: sec.length, tokenSet: !!lineToken(env), kvSet: !!env.LINE_KV });
  }
  if (request.method !== 'POST') return json(200, { ok: true });
  const raw = await request.text();
  const secret = lineSecret(env);
  if (!secret) return json(500, { error: '缺少 LINE_CHANNEL_SECRET' });
  const sig = request.headers.get('x-line-signature') || '';
  if (sig !== await hmacBase64(secret, raw)) return json(401, { error: 'bad signature' });

  let data = {}; try { data = JSON.parse(raw); } catch (e) {}
  for (const ev of (data.events || [])) {
    const uid = ev.source && ev.source.userId;
    if (ev.type === 'follow') {
      await lineReply(env, ev.replyToken, '歡迎加入仁德幼兒園的教具借還系統通知 👋\n如要接收週誌退件通知，請先在系統「📝 週誌」按「取得綁定碼」，再把「綁定 123456」這段文字傳給我。');
    } else if (ev.type === 'message' && ev.message && ev.message.type === 'text' && uid) {
      const m = String(ev.message.text).trim().match(/^(?:綁定\s*)?(\d{6})$/);
      if (!m) continue;
      let k; try { k = kv(env); } catch (e) { await lineReply(env, ev.replyToken, '❌ 系統尚未完成綁定功能的設定，請通知管理員。'); continue; }
      const rec = await k.get('code:' + m[1], 'json');
      if (!rec || rec.exp < Date.now()) { await lineReply(env, ev.replyToken, '❌ 綁定碼無效或已過期，請回到系統重新取得綁定碼。'); continue; }
      await k.put('email:' + rec.email, JSON.stringify({ userId: uid, at: Date.now() }));
      await k.delete('code:' + m[1]);
      await lineReply(env, ev.replyToken, '✅ 綁定成功！之後您的週誌若被管理員退回，會直接傳 LINE 通知您。');
    }
  }
  return json(200, { ok: true });
}

// ───────── 路由 ─────────
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    const m = path.match(/^(?:\/\.netlify\/functions|\/api)?\/(line-notify|line-bind|line-webhook)$/);
    try {
      if (m) {
        if (m[1] === 'line-notify') return await notify(request, env);
        if (m[1] === 'line-bind') return await bind(request, env);
        return await webhook(request, env);
      }
    } catch (e) {
      return json(500, { ok: false, error: '伺服器錯誤：' + (e && e.message || e) });
    }
    // 其他網址交給靜態網站（沒有設定靜態檔時回傳 404）
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
  },
};
