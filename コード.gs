/**
 * Webアプリとしてのアクセスをハンドリングする関数
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('此花マンション区域')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
}

// サーバー側で一元管理するパスワード
const SECRET_PASSWORD = "konohana";

/**
 * パスワード検証用の補助関数
 */
function verifyPassword(password) {
  return String(password || '').trim() === SECRET_PASSWORD;
}

/**
 * ログインパスワードチェックAPI
 */
function checkPassword(password) {
  if (verifyPassword(password)) {
    return { success: true };
  } else {
    return { success: false, error: 'パスワードが正しくありません' };
  }
}

/**
 * 指定されたスプレッドシートの全シートからマンションデータを取得する関数
 * パスワード認証成功時のみデータを返却
 */
function getMansionData(password) {
  if (!verifyPassword(password)) {
    return { success: false, error: '認証エラー: パスワードが一致しないか無効です' };
  }

  try {
    const spreadsheetId = '1ht3s0_fMP0_n89zeRYUD0_iUv9cMhdhOmeCyXgr6vbQ';
    let ss;
    
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (err) {
      ss = null;
    }
    if (!ss) {
      try {
        ss = SpreadsheetApp.openById(spreadsheetId);
      } catch (e) {
        return { success: false, error: 'スプレッドシートを開けませんでした: ' + e.toString() };
      }
    }

    const sheets = ss.getSheets();
    const mansions = [];
    let globalId = 1;

    // 全角数字・全角記号を半角に変換する補助関数
    const parseCoord = (val) => {
      if (val === null || val === undefined || val === '') return NaN;
      if (typeof val === 'number') return val;
      const str = String(val).replace(/[Ａ-Ｚａ-ｚ０-９．,]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0)).trim();
      return parseFloat(str);
    };

    sheets.forEach(sheet => {
      const sheetName = sheet.getName();
      // 報告シートは取得対象から除外
      if (sheetName === '報告') return;

      const data = sheet.getDataRange().getValues();
      if (!data || data.length <= 1) return;

      const headers = data[0].map(h => String(h).trim());
      
      let nameIdx = headers.findIndex(h => h.includes('マンション名') || h.includes('名称') || h.includes('物件名') || h.includes('建物'));
      let addrIdx = headers.findIndex(h => h.includes('住所') || h.includes('所在地'));
      let linkIdx = headers.findIndex(h => h.includes('部屋') || h.includes('リンク') || h.includes('URL') || h.includes('部屋番号'));
      let latIdx  = headers.findIndex(h => h.includes('緯度') || h.toLowerCase().includes('lat'));
      let lngIdx  = headers.findIndex(h => h.includes('経度') || h.toLowerCase().includes('lng') || h.toLowerCase().includes('lon'));
      let priorityIdx = headers.findIndex(h => h.includes('優先') || h.includes('急ぎ') || h.includes('ステータス'));

      // フォールバック（デフォルト列順）
      if (nameIdx === -1) nameIdx = 0;
      if (addrIdx === -1) addrIdx = 1;
      if (linkIdx === -1) linkIdx = 2;
      if (latIdx === -1) latIdx = 3;
      if (lngIdx === -1) lngIdx = 4;

      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row || !row[nameIdx] || String(row[nameIdx]).trim() === '') continue;

        let lat = parseCoord(row[latIdx]);
        let lng = parseCoord(row[lngIdx]);

        if ((isNaN(lat) || isNaN(lng)) && row[latIdx]) {
          const parts = String(row[latIdx]).split(/[,，]/);
          if (parts.length === 2) {
            lat = parseCoord(parts[0]);
            lng = parseCoord(parts[1]);
          }
        }

        const nameStr = String(row[nameIdx] || '').trim();
        const priorityStr = priorityIdx !== -1 ? String(row[priorityIdx] || '').trim() : '';
        const isUrgent = nameStr.includes('急ぎ') || nameStr.includes('優先') || priorityStr.includes('急ぎ') || priorityStr.includes('優先') || priorityStr === '1' || priorityStr.toLowerCase() === 'true';

        if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
          mansions.push({
            id: globalId++,
            name: nameStr,
            address: String(row[addrIdx] || '').trim(),
            roomLink: String(row[linkIdx] || '').trim(),
            lat: lat,
            lng: lng,
            sheetName: sheetName,
            isUrgent: isUrgent
          });
        }
      }
    });

    return { success: true, data: mansions };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * 報告送信処理
 */
function submitReport(data) {
  try {
    const spreadsheetId = '1ht3s0_fMP0_n89zeRYUD0_iUv9cMhdhOmeCyXgr6vbQ';
    let ss;
    try {
      ss = SpreadsheetApp.openById(spreadsheetId);
    } catch (e) {
      return { success: false, error: 'スプレッドシートを開けませんでした: ' + e.toString() };
    }

    let reportSheet = ss.getSheetByName('報告');
    if (!reportSheet) {
      reportSheet = ss.insertSheet('報告');
      reportSheet.appendRow(['送信日時', '奉仕者名', '項目', '詳細内容', '位置/マンション名']);
      reportSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#f1f5f9');
    }

    const timestamp = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd HH:mm:ss');
    reportSheet.appendRow([
      timestamp,
      data.reporterName || '',
      data.category || '',
      data.details || '',
      data.location || ''
    ]);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}