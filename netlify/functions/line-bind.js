const { json, whoami, store, linePush } = require('../lib/common'); // 對接您的共用工具

exports.handler = async (event, context) => {
  // 設定 跨網域 (CORS) 響應標頭
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // 1. 驗證 Firebase 登入狀態
    const me = await whoami(event);
    if (!me || !me.email) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '未登入或憑證無效' }) };
    }

    const { bindCode } = JSON.parse(event.body);
    if (!bindCode) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '請輸入綁定碼' }) };
    }

    // 2. 從 Netlify Blobs 中找出該綁定碼對應的 LINE userId
    const blobStore = await store(event);
    const userId = await blobStore.get(`code:${bindCode}`);

    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '綁定碼無效或已過期，請在 LINE 重新輸入「綁定」取得新驗證碼' }) };
    }

    // 3. 儲存雙向綁定關係至 Blobs 永久存放
    await blobStore.set(`email:${me.email}`, userId);
    await blobStore.set(`user:${userId}`, me.email);

    // 4. 刪除已被使用過的臨時綁定碼
    await blobStore.delete(`code:${bindCode}`);

    // 5. 透過 LINE 主動推播通知使用者綁定成功
    await linePush(userId, `🎉 帳號綁定成功！\n您的 LINE 已成功連結至仁德幼兒園系統帳號：\n${me.email}\n\n未來系統通知將會發送至此。`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'LINE 帳號綁定成功！' })
    };
  } catch (error) {
    console.error('Bind Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.toString() })
    };
  }
};
