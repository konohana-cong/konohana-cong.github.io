/**
 * 此花マンション区域 - GAS バックエンド処理
 */

function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('此花マンション区域')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * スプレッドシートからマンションデータを取得する関数
 * A列: マンション名
 * B列: 住所
 * C列: 部屋番号一覧リンク (URL)
 * D列: 緯度 (Latitude)
 * E列: 経度 (Longitude)
 */
function getMansionData() {
  try {
    // 指定されたスプレッドシートID
    const spreadsheetId = '1ht3s0_fMP0_n89zeRYUD0_iUv9cMhdhOmeCyXgr6vbQ';
    const sheet = SpreadsheetApp.openById(spreadsheetId).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    
    // データヘッダー行しかない場合は空配列を返す
    if (data.length <= 1) {
      return { success: true, data: [] };
    }
    
    const mansions = [];
    
    // 2行目（インデックス1）以降を処理
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const name = row[0];
      const address = row[1];
      const roomLink = row[2];
      const lat = parseFloat(row[3]);
      const lng = parseFloat(row[4]);
      
      // 有効な座標と名前が存在する場合のみリストに追加
      if (name && !isNaN(lat) && !isNaN(lng)) {
        mansions.push({
          id: i,
          name: String(name).trim(),
          address: String(address || '').trim(),
          roomLink: String(roomLink || '').trim(),
          lat: lat,
          lng: lng
        });
      }
    }
    
    return { success: true, data: mansions };
  } catch (error) {
    Logger.log('Error fetching data: ' + error.toString());
    return { success: false, error: 'スプレッドシートのデータ取得に失敗しました: ' + error.message };
  }
}