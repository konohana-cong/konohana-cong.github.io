/**
 * Webアプリとしてのアクセスをハンドリングする関数
 */
function doGet() {
  try {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('此花マンション区域')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
  } catch (err) {
    return HtmlService.createHtmlOutput('<div style="padding:20px;color:red;font-weight:bold;">GAS画面表示エラー: ' + err.toString() + '</div>');
  }
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
 * スプレッドシート編集時に自動実行される組み込みトリガー
 * B列（住所）が変更・削除・複数行貼り付けされた場合にD列（緯度）・E列（経度）を自動更新・連動消去します。
 */
function onEdit(e) {
  if (!e || !e.range) return;
  
  try {
    const range = e.range;
    const sheet = range.getSheet();
    const sheetName = sheet.getName();
    
    // 「報告」シートは対象外
    if (sheetName === '報告') return;
    
    const startRow = range.getRow();
    const numRows = range.getNumRows();
    const startCol = range.getColumn();
    const numCols = range.getNumColumns();
    
    // B列（2列目）を含んでいない場合はスキップ
    if (startCol > 2 || (startCol + numCols - 1) < 2) return;
    
    const values = range.getValues();
    
    for (let r = 0; r < numRows; r++) {
      const currentRow = startRow + r;
      if (currentRow <= 1) continue; // ヘッダー行をスキップ
      
      // B列の値を取得（範囲指定編集時のB列インデックス計算）
      const bColIndex = 2 - startCol;
      const addressVal = values[r][bColIndex];
      const addressStr = String(addressVal || '').trim();
      
      const latCell = sheet.getRange(currentRow, 4); // D列 (緯度)
      const lngCell = sheet.getRange(currentRow, 5); // E列 (経度)
      
      if (!addressStr) {
        // B列の住所が空の場合、D列・E列の緯度経度を自動削除
        latCell.clearContent();
        lngCell.clearContent();
      } else {
        // 住所がある場合、ジオコーディングで緯度経度を自動入力
        try {
          const response = Maps.newGeocoder().setLanguage('ja').geocode(addressStr);
          if (response.status === 'OK' && response.results && response.results.length > 0) {
            const location = response.results[0].geometry.location;
            latCell.setValue(location.lat);
            lngCell.setValue(location.lng);
          }
        } catch (geoErr) {
          Logger.log('Geocoding error on row ' + currentRow + ': ' + geoErr.toString());
        }
      }
    }
  } catch (err) {
    Logger.log('onEdit Handler Error: ' + err.toString());
  }
}

/**
 * 【管理者用手動実行関数】16シート全体の住所と緯度経度のズレを一括修復・補完する関数
 * - B列（住所）が空なのにD・E列（緯度・経度）がある場合は自動削除
 * - B列（住所）があるのにD・E列が空・0の場合は自動ジオコーディング取得
 */
function syncAllSheetCoordinates() {
  const spreadsheetId = '1ht3s0_fMP0_n89zeRYUD0_iUv9cMhdhOmeCyXgr6vbQ';
  let ss = null;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (e) {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  if (!ss) return;

  const sheets = ss.getSheets();
  let cleanedCount = 0;
  let geocodedCount = 0;

  sheets.forEach(sheet => {
    if (sheet.getName() === '報告') return;
    
    const data = sheet.getDataRange().getValues();
    if (!data || data.length <= 1) return;
    
    for (let i = 1; i < data.length; i++) {
      const rowNum = i + 1;
      const address = String(data[i][1] || '').trim(); // B列
      const lat = data[i][3]; // D列
      const lng = data[i][4]; // E列
      
      const hasCoords = lat !== '' && lng !== '' && lat !== null && lng !== null && lat !== 0 && lng !== 0;

      if (!address && hasCoords) {
        // 住所がないのに緯度経度がある場合、削除
        sheet.getRange(rowNum, 4).clearContent();
        sheet.getRange(rowNum, 5).clearContent();
        cleanedCount++;
      } else if (address && !hasCoords) {
        // 住所があるのに緯度経度がない場合、ジオコーディング取得
        try {
          const res = Maps.newGeocoder().setLanguage('ja').geocode(address);
          if (res.status === 'OK' && res.results && res.results.length > 0) {
            const loc = res.results[0].geometry.location;
            sheet.getRange(rowNum, 4).setValue(loc.lat);
            sheet.getRange(rowNum, 5).setValue(loc.lng);
            geocodedCount++;
            Utilities.sleep(200); // API呼び出し制限回避
          }
        } catch (geoErr) {
          Logger.log('Sync Batch Geocode Error on ' + sheet.getName() + ' Row ' + rowNum + ': ' + geoErr.toString());
        }
      }
    }
  });

  Logger.log('一括同期完了: 余分な緯度経度の削除 ' + cleanedCount + '件 / 不足住所の自動取得 ' + geocodedCount + '件');
}

/**
 * 指定されたスプレッドシートの全シートからマンションデータを取得する関数
 */
function getMansionData(password) {
  if (!verifyPassword(password)) {
    return { success: false, error: '認証エラー: パスワードが一致しないか無効です' };
  }

  try {
    const spreadsheetId = '1ht3s0_fMP0_n89zeRYUD0_iUv9cMhdhOmeCyXgr6vbQ';
    let ss = null;
    
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

      // デフォルト列補正（標準フォーマット: A:物件名, B:住所, C:リンク, D:緯度, E:経度）
      if (nameIdx === -1) nameIdx = 0;
      if (addrIdx === -1) addrIdx = 1;
      if (linkIdx === -1) linkIdx = 2;
      if (latIdx === -1) latIdx = 3;
      if (lngIdx === -1) lngIdx = 4;

      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row || !row[nameIdx] || String(row[nameIdx]).trim() === '') continue;

        const addressStr = String(row[addrIdx] || '').trim();
        
        // 住所が存在しない行で、誤って緯度経度が入っている場合のスキップ処理
        if (!addressStr) continue;

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
            address: addressStr,
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