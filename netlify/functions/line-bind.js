// Netlify Function：老師綁定自己的 LINE（用來接收週誌退件通知）
//   { action: 'init' }   產生 6 位數綁定碼（10 分鐘內有效）
//   { action: 'status' } 查詢目前登入者是否已綁定
const { json, whoami, store } = require('../lib/common');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const me = await whoami(event);
  if (!me) return json(401, { ok: false, error: '請先登入' });
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  let st;
  try { st = await store(event); } catch (e) { return json(500, { ok: false, error: '無法使用儲存空間：' + e.message }); }

  if (body.action === 'status') {
    const b = await st.get('email:' + me.email, { type: 'json' });
    return json(200, { ok: true, bound: !!(b && b.userId) });
  }
  if (body.action === 'init') {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await st.setJSON('code:' + code, { email: me.email, exp: Date.now() + 10 * 60 * 1000 });
    return json(200, { ok: true, code });
  }
  return json(400, { ok: false, error: 'unknown action' });
};
