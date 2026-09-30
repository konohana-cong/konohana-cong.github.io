/**
 * Webアプリとしてのアクセスをハンドリングする関数
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('此花マンション区域')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
}

/**
 * 指定されたスプレッドシートの全シートからマンションデータを取得する関数
 * @return {Object} 取得結果オブジェクト { success: boolean, data: Array, error?: string }
 */
function getMansionData() {
  try {
    const spreadsheetId = '1ht3s0_fMP0_n89zeRYUD0_iUv9cMhdhOmeCyXgr6vbQ';
    let ss;
    
    // スプレッドシートのオープン試行（アクティブまたはID指定）
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (err) {
      ss = null;
    }
    if (!ss) {
      try {
        ss = SpreadsheetApp.openById(spreadsheetId);
      } catch (e) {
        return { success: false, error: 'スプレッドシートを開けませんでした。アクセス権限またはIDを確認してください: ' + e.toString() };
      }
    }

    const sheets = ss.getSheets(); // すべてのシートを取得
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
      const data = sheet.getDataRange().getValues();
      if (!data || data.length <= 1) return;

      // 1行目のヘッダー行からカラムインデックスを動的に自動特定
      const headers = data[0].map(h => String(h).trim());
      
      let nameIdx = headers.findIndex(h => h.includes('マンション名') || h.includes('名称') || h.includes('物件名') || h.includes('建物'));
      let addrIdx = headers.findIndex(h => h.includes('住所') || h.includes('所在地'));
      let linkIdx = headers.findIndex(h => h.includes('部屋') || h.includes('リンク') || h.includes('URL') || h.includes('部屋番号'));
      let latIdx  = headers.findIndex(h => h.includes('緯度') || h.toLowerCase().includes('lat'));
      let lngIdx  = headers.findIndex(h => h.includes('経度') || h.toLowerCase().includes('lng') || h.toLowerCase().includes('lon'));

      // フォールバック（デフォルト列順）
      if (nameIdx === -1) nameIdx = 0;
      if (addrIdx === -1) addrIdx = 1;
      if (linkIdx === -1) linkIdx = 2;
      if (latIdx === -1) latIdx = 3;
      if (lngIdx === -1) lngIdx = 4;

      // データ行のループ（2行目以降）
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row || !row[nameIdx] || String(row[nameIdx]).trim() === '') continue;

        let lat = parseCoord(row[latIdx]);
        let lng = parseCoord(row[lngIdx]);

        // カンマ区切りセル（例: "34.682, 135.452"）の解析処理
        if ((isNaN(lat) || isNaN(lng)) && row[latIdx]) {
          const parts = String(row[latIdx]).split(/[,，]/);
          if (parts.length === 2) {
            lat = parseCoord(parts[0]);
            lng = parseCoord(parts[1]);
          }
        }

        if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
          mansions.push({
            id: globalId++,
            name: String(row[nameIdx] || '').trim(),
            address: String(row[addrIdx] || '').trim(),
            roomLink: String(row[linkIdx] || '').trim(),
            lat: lat,
            lng: lng,
            sheetName: sheetName
          });
        }
      }
    });

    return { success: true, data: mansions };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}