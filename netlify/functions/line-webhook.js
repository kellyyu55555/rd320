const crypto = require('crypto');
const { store } = require('../lib/common'); // 對接您的共用工具

exports.handler = async (event, context) => {
  // 1. 只允許 POST 請求
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const signature = event.headers['x-line-signature'] || event.headers['X-Line-Signature'];

  // 2. 驗證 LINE 安全簽章
  if (!signature || !channelSecret) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  const hash = crypto.createHmac('sha256', channelSecret).update(event.body).digest('base64');
  if (hash !== signature) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  try {
    const body = JSON.parse(event.body);
    const events = body.events || [];

    for (let lineEvent of events) {
      // 監聽文字訊息
      if (lineEvent.type === 'message' && lineEvent.message.type === 'text') {
        const userText = lineEvent.message.text.trim();
        const replyToken = lineEvent.replyToken;
        const userId = lineEvent.source.userId;

        // 當使用者在 LINE 輸入「綁定」
        if (userText === '綁定') {
          // 生成 6 位數隨機數字綁定碼
          const bindCode = Math.floor(100000 + Math.random() * 900000).toString();
          
          // 寫入 Netlify Blobs，有效期限設為 10 分鐘 (600秒)
          const blobStore = await store(event);
          await blobStore.set(`code:${bindCode}`, userId, { expirationTTL: 600 });

          // 回傳訊息給 LINE 使用者
          await fetch('https://line.me', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${channelAccessToken}`
            },
            body: JSON.stringify({
              replyToken: replyToken,
              messages: [
                {
                  type: 'text',
                  text: `您的系統綁定碼為：【 ${bindCode} 】\n請於 10 分鐘內回到幼兒園借還系統網頁輸入此驗證碼完成帳號綁定。`
                }
              ]
            })
          });
        }
      }
    }

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error('Webhook Error:', error);
    return { statusCode: 500, body: error.toString() };
  }
};
