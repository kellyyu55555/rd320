// Cloudflare Worker：網站（靜態檔）＋ LINE 通知／綁定 API
// 網址與原本 Netlify 相同：/.netlify/functions/line-notify、line-bind、line-webhook（也可用 /api/line-notify …），
// 所以網頁（index.html）不用修改。
//
// 需要的「機密」(Secrets)：LINE_CHANNEL_ACCESS_TOKEN、LINE_CHANNEL_SECRET、LINE_TO
// 老師綁定 LINE 另需要 KV 儲存空間，綁定名稱：LINE_KV（沒有設定時，只有「老師綁定」不能用，管理員通知不受影響）
// 會議紀錄「上傳錄音產生草稿」需要 Workers AI，綁定名稱：AI（已寫在 wrangler.jsonc，部署時會自動加上）

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
      await lineReply(env, ev.replyToken, '歡迎加入仁德幼兒園的教具借還系統通知 👋\n如要接收週誌、班刊的退件通知，請先在系統「📝 週誌」按「取得綁定碼」，再把「綁定 123456」這段文字傳給我。');
    } else if (ev.type === 'message' && ev.message && ev.message.type === 'text' && uid) {
      const m = String(ev.message.text).trim().match(/^(?:綁定\s*)?(\d{6})$/);
      if (!m) continue;
      let k; try { k = kv(env); } catch (e) { await lineReply(env, ev.replyToken, '❌ 系統尚未完成綁定功能的設定，請通知管理員。'); continue; }
      const rec = await k.get('code:' + m[1], 'json');
      if (!rec || rec.exp < Date.now()) { await lineReply(env, ev.replyToken, '❌ 綁定碼無效或已過期，請回到系統重新取得綁定碼。'); continue; }
      await k.put('email:' + rec.email, JSON.stringify({ userId: uid, at: Date.now() }));
      await k.delete('code:' + m[1]);
      await lineReply(env, ev.replyToken, '✅ 綁定成功！之後您的週誌或班刊若被管理員退回，會直接傳 LINE 通知您。');
    }
  }
  return json(200, { ok: true });
}

// ───────── /meeting-ai：會議錄音轉逐字稿、整理成會議紀錄草稿 ─────────
// 網頁先把錄音切成約 1 分鐘一段（16kHz 單聲道 WAV），一段一段送來轉文字，所以 50 分鐘的長錄音也不會超過限制。
const WHISPER = '@cf/openai/whisper-large-v3-turbo';

function aiText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (typeof r.output_text === 'string') return r.output_text;
  const c = r.choices && r.choices[0];
  if (c && c.message && typeof c.message.content === 'string' && c.message.content) return c.message.content;
  if (c && typeof c.text === 'string') return c.text;
  let t = '';
  for (const o of (Array.isArray(r.output) ? r.output : [])) {
    if (o && o.type && o.type !== 'message') continue;
    for (const x of (Array.isArray(o && o.content) ? o.content : [])) if (x && typeof x.text === 'string') t += x.text;
  }
  return t;
}
// 依序嘗試：gpt-oss-120b（messages 格式）→ gpt-oss-120b（Responses 格式）→ llama-3.3-70b，前一個失敗或沒回傳文字就換下一個
const LLM_TRIES = [
  ['@cf/openai/gpt-oss-120b', (sys, user, n) => ({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], max_tokens: n, reasoning_effort: 'low' })],
  ['@cf/openai/gpt-oss-120b', (sys, user, n) => ({ instructions: sys, input: user, reasoning: { effort: 'low' }, max_output_tokens: n })],
  ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', (sys, user, n) => ({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user.slice(0, 30000) }], max_tokens: Math.min(n, 4000) })],
];
async function askLLM(env, instructions, input, maxTokens) {
  const errs = [];
  for (const [model, mk] of LLM_TRIES) {
    try {
      const t = aiText(await env.AI.run(model, mk(instructions, input, maxTokens || 6000))).trim();
      if (t) return t;
      errs.push(model.split('/').pop() + '：沒有回傳文字');
    } catch (e) {
      errs.push(model.split('/').pop() + '：' + String((e && e.message) || e).slice(0, 200));
    }
  }
  throw new Error('AI 整理失敗（' + errs.join('；') + '）');
}
function pickJson(t) {
  const s = String(t || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

const NOTES_PROMPT = `你是幼兒園的會議記錄員。下面是一場會議錄音逐字稿的其中一段（語音辨識結果，可能有錯字、口語贅詞、簡體字）。
請用「繁體中文（台灣用語）」把這一段整理成重點筆記，保留：誰（職稱或班級）說了什麼、報告事項、每個討論議題的內容與決議（優點、缺點）、老師提出的問題與回覆、各班需要協助的幼兒（班級、幼兒姓名、學習情形、老師給的策略與建議）、數字、日期、時間、人名。
去掉口語贅詞與重複的話，不要自己編造內容。只輸出筆記本文，用條列方式。`;

const DRAFT_PROMPT = `你是幼兒園的會議記錄員，要把會議錄音的逐字稿（或分段筆記）整理成本園正式的會議紀錄（教學研討會議／教保會議格式）。
寫作規則（一定要遵守）：
1. 全部使用繁體中文（台灣用語），語氣正式、精簡，像公文的會議紀錄；去掉口語贅詞與重複的話，修正明顯的語音辨識錯字。
2. 只能根據內容整理，不要編造；沒有提到的欄位留空字串 ""。幼兒姓名照錄音內容寫，聽不清楚的字用「○」代替（例如：陳○二）。
3. 每一行只寫一點，用「\n」換行。列點符號只用兩種：「1. 」「2. 」…（數字、半形句點、一個空白）和「• 」（圓點、一個空白）。不要用 - 或 * 或（一）。
4. 「報告事項」：會中各項報告（例如：個人專業成長檔案冊、家長電訪、課堂觀察紀錄、週誌填寫說明、特教承辦事務）。
   每項一則，title 寫簡短主題（不要加「報告一」等編號），body 用「1. 」「2. 」逐點寫；需要舉例時，下一行用「例如：」開頭。
   特教相關的報告標題寫「特教承辦事務」，每點寫成「主題：內容」，例如「1. 物理治療師建議：……」。
5. 「議題討論」：會中討論的每個議題一則（例如：運動會檢討、清潔阿姨請假期間各班輪值協調、聖誕節活動）。
   title 寫簡短議題名稱（不要加「議題一」等編號）。
   content 是討論內容：先用一句話說明議題，再用「• 」逐點列出討論重點；有優缺點時，用單獨一行「優點」、「缺點」當小標，下面接「• 」列點。
   resolution 是這個議題的決議，用「1. 」「2. 」逐點寫；沒有決議就留空。
6. 下面兩個是固定議題，有談到才填，title 一定要一字不差：
   (a) title「對於教保或園務問題提問」：content 用「1. 」逐點寫老師提出的問題；resolution 用「1. 」逐點寫回覆或處理方式。
   (b) title「班上需要協助的幼兒學習情形，各班老師給予策略與建議。」：
       content 依班級分段，每班先寫一行「【班級名稱】」，下面每位幼兒一行「• 幼兒姓名：學習情形」；
       resolution 也依班級分段，每班一行「【班級名稱】」，下面每位幼兒一行「• 幼兒姓名：給予的策略與建議」。
7. 沒有主席報告就留空；臨時動議沒有提到就留空（不要寫「無」）。不要另外寫「決議事項」總整理或「散會」。
8. 只輸出一個 JSON 物件，不要有其他文字，格式如下：
{
  "date": "會議日期 YYYY-MM-DD，沒提到就留空",
  "from": "開始時間 HH:MM（24小時制），沒提到就留空",
  "to": "結束時間 HH:MM（24小時制），沒提到就留空",
  "place": "地點",
  "chair": "主席（例如：林佳靜園長）",
  "recorder": "記錄",
  "chairReport": "主席報告內容",
  "reports": [ { "title": "個人專業成長檔案冊", "body": "1. ……\n2. ……" } ],
  "issues": [ { "title": "運動會檢討", "content": "各班老師分享運動會的優點與缺點。\n優點\n• ……\n缺點\n• ……", "resolution": "1. ……\n2. ……" } ],
  "motions": "臨時動議內容"
}`;

async function meetingAi(request, env) {
  if (request.method === 'GET') return json(200, { ok: true, aiSet: !!env.AI });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const me = await whoami(request, env);
  if (!me) return json(401, { ok: false, error: '請先登入' });
  if (!env.AI) return json(500, { ok: false, error: '尚未設定 Workers AI（綁定名稱 AI），請確認 wrangler.jsonc 已部署' });
  const action = new URL(request.url).searchParams.get('action') || '';

  // 一段錄音（base64 的 WAV，直接放在 body）→ 文字
  if (action === 'transcribe') {
    const audio = (await request.text()).trim();
    if (!audio) return json(400, { ok: false, error: '沒有收到錄音' });
    if (audio.length > 8 * 1024 * 1024) return json(413, { ok: false, error: '這一段錄音太大' });
    const r = await env.AI.run(WHISPER, {
      audio, task: 'transcribe', language: 'zh', vad_filter: true,
      initial_prompt: '以下是幼兒園會議的繁體中文逐字稿，內容包含園長報告、各班老師分享與討論、決議事項。',
    });
    return json(200, { ok: true, text: String((r && r.text) || '').trim() });
  }

  const body = await readBody(request);
  // 很長的逐字稿：先一段一段整理成重點筆記
  if (action === 'notes') {
    const text = String(body.text || '').slice(0, 20000);
    if (!text.trim()) return json(200, { ok: true, notes: '' });
    const notes = await askLLM(env, NOTES_PROMPT, `（第 ${+body.part || 1} 段，共 ${+body.total || 1} 段）\n${text}`, 4000);
    return json(200, { ok: true, notes });
  }
  // 逐字稿（或筆記）→ 會議紀錄格式（JSON）
  if (action === 'draft') {
    const text = String(body.text || '').slice(0, 60000);
    if (!text.trim()) return json(400, { ok: false, error: '逐字稿是空的' });
    const hint = [body.type ? '會議類別：' + body.type : '', body.date ? '會議日期（已知）：' + body.date : '', Array.isArray(body.classes) && body.classes.length ? '本園班級：' + body.classes.join('、') : ''].filter(Boolean).join('\n');
    const input = (hint ? hint + '\n\n' : '') + (body.isNotes ? '以下是依序整理的分段筆記：\n' : '以下是逐字稿：\n') + text;
    let out = await askLLM(env, DRAFT_PROMPT, input, 8000);
    let draft = pickJson(out);
    if (!draft) { // 再試一次，要求只輸出 JSON
      out = await askLLM(env, DRAFT_PROMPT + '\n\n上一次的輸出不是正確的 JSON，這次請只輸出 JSON 物件。', input, 8000);
      draft = pickJson(out);
    }
    if (!draft) return json(200, { ok: false, error: 'AI 沒有回傳正確格式，請再試一次', raw: out.slice(0, 2000) });
    return json(200, { ok: true, draft });
  }
  return json(400, { ok: false, error: 'unknown action' });
}

// ───────── 路由 ─────────
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    const m = path.match(/^(?:\/\.netlify\/functions|\/api)?\/(line-notify|line-bind|line-webhook|meeting-ai)$/);
    try {
      if (m) {
        if (m[1] === 'meeting-ai') return await meetingAi(request, env);
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

