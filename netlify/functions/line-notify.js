// Netlify Function：推播 LINE 訊息
//  1. 一般呼叫（{ text }）：傳給管理員（環境變數 LINE_TO）。任何已登入的使用者都能觸發（例如老師送出申請）。
//  2. 管理員呼叫（{ text, toEmail }）：傳給指定老師（需該老師已完成 LINE 綁定），只有管理員能用，例如週誌退件通知。
// 環境變數：LINE_CHANNEL_ACCESS_TOKEN、LINE_TO（管理員 userId，逗號分隔）、（選填）FIREBASE_API_KEY、FIREBASE_PROJECT_ID
const { json, whoami, isAdmin, store, linePush } = require('../lib/common');

exports.handler = async (event) => {
  // 診斷用：瀏覽器直接開此網址，確認環境變數是否已設定（不會顯示機密）
  if (event.httpMethod === 'GET') {
    return json(200, {
      ok: true,
      lineTokenSet: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      lineToCount: (process.env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean).length,
      webhookSecretSet: !!process.env.LINE_CHANNEL_SECRET,
    });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const me = await whoami(event);
  if (!me) return json(401, { error: 'invalid token' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const text = String(body.text || '').trim().slice(0, 900);
  if (!text) return json(400, { error: 'empty text' });
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) return json(500, { error: 'LINE 尚未設定（缺少 LINE_CHANNEL_ACCESS_TOKEN）' });

  // 傳給指定老師（僅管理員）
  if (body.toEmail) {
    if (!(await isAdmin(me))) return json(403, { error: '只有管理員可以傳給指定老師' });
    let bound = null;
    try { bound = await (await store(event)).get('email:' + String(body.toEmail).toLowerCase(), { type: 'json' }); }
    catch (e) { return json(500, { error: '讀取綁定資料失敗：' + e.message }); }
    if (!bound || !bound.userId) return json(200, { ok: true, sent: 0, noBinding: true });
    const r = await linePush(bound.userId, text);
    return json(200, { ok: true, sent: r.ok ? 1 : 0, failed: r.ok ? 0 : 1, errors: r.ok ? [] : [{ status: r.status, detail: r.detail }] });
  }

  // 傳給管理員
  const to = (process.env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) return json(500, { error: 'LINE 尚未設定（缺少 LINE_TO）' });
  const results = await Promise.all(to.map(id => linePush(id, text)));
  const failed = results.filter(x => !x.ok);
  return json(200, { sent: results.length - failed.length, failed: failed.length, errors: failed.map(x => ({ status: x.status, detail: x.detail })) });
};
// test commit
