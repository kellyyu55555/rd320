// Netlify Function：LINE 官方帳號的 Webhook
// 老師在 LINE 傳「綁定 123456」給官方帳號 → 把她的 LINE userId 和系統登入 Email 綁在一起
// 環境變數：LINE_CHANNEL_SECRET（Channel secret）、LINE_CHANNEL_ACCESS_TOKEN
// LINE Developers → Messaging API → Webhook URL 填：https://你的網站/.netlify/functions/line-webhook，並開啟 Use webhook
const crypto = require('crypto');
const { json, store } = require('../lib/common');

async function reply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  }).catch(() => {});
}

exports.handler = async (event) => {
  // 診斷用：用瀏覽器直接開此網址，可確認環境變數有沒有設定（不會顯示機密內容）
  if (event.httpMethod === 'GET') {
    const sec = (process.env.LINE_CHANNEL_SECRET || '').trim();
    return json(200, { ok: true, secretSet: !!sec, secretLength: sec.length, tokenSet: !!process.env.LINE_CHANNEL_ACCESS_TOKEN });
  }
  if (event.httpMethod !== 'POST') return json(200, { ok: true });
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const secret = (process.env.LINE_CHANNEL_SECRET || '').trim(); // 去掉貼上時可能多出的空白或換行
  if (!secret) return json(500, { error: '缺少 LINE_CHANNEL_SECRET' });
  const sig = (event.headers || {})['x-line-signature'] || (event.headers || {})['X-Line-Signature'] || '';
  const mac = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  if (sig !== mac) return json(401, { error: 'bad signature' });

  let data = {}; try { data = JSON.parse(raw); } catch (e) {}
  const st = await store(event);
  for (const ev of (data.events || [])) {
    const uid = ev.source && ev.source.userId;
    if (ev.type === 'follow') {
      await reply(ev.replyToken, '歡迎加入仁德幼兒園的教具借還系統通知 👋\n如要接收週誌退件通知，請先在系統「📝 週誌」按「取得綁定碼」，再把「綁定 123456」這段文字傳給我。');
    } else if (ev.type === 'message' && ev.message && ev.message.type === 'text' && uid) {
      const m = String(ev.message.text).match(/綁定\s*(\d{6})/);
      if (!m) continue;
      const rec = await st.get('code:' + m[1], { type: 'json' });
      if (!rec || rec.exp < Date.now()) { await reply(ev.replyToken, '❌ 綁定碼無效或已過期，請回到系統重新取得綁定碼。'); continue; }
      await st.setJSON('email:' + rec.email, { userId: uid, at: Date.now() });
      await st.delete('code:' + m[1]);
      await reply(ev.replyToken, '✅ 綁定成功！之後您的週誌若被管理員退回，會直接傳 LINE 通知您。');
    }
  }
  return json(200, { ok: true });
};
