/**
 * Webアプリとしてのアクセスをハンドリングする関数
 */
function doGet() {
  try {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('此花区域')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
  } catch (err) {
    return HtmlService.createHtmlOutput('<div style="padding:20px;color:red;font-weight:bold;">GAS画面表示エラー: ' + err.toString() + '</div>');
  }
}

// ============================================================
// 設定値
// ============================================================
const SPREADSHEET_ID = '1ht3s0_fMP0_n89zeRYUD0_iUv9cMhdhOmeCyXgr6vbQ';
const MANSION_CACHE_KEY = 'mansion_data_v3';
const MANSION_CACHE_TTL_SEC = 300;     // マンションデータのサーバー側キャッシュ（秒）
const MANSION_CACHE_CHUNK = 30000;     // キャッシュ1件あたりの最大文字数（分割保存用）
const REPORT_HEADERS = ['送信日時', '奉仕者名', '項目', 'マンション名', '住所', '詳細内容'];

const LOGIN_TOKEN_DAYS = 30;           // 「ログイン状態を保つ」の有効日数（使うたびに延長）
const TOKEN_PROP_PREFIX = 'LOGIN_TOKEN_';
const TOKEN_CRED_PREFIX = 'token:';    // 画面から送られる認証情報がトークンであることを示す接頭辞

/**
 * スクリプトプロパティの値を取得（未設定なら空文字）
 * 使用するプロパティ: APP_PASSWORD（ログインパスワード） / REPORT_NOTIFY_EMAIL（報告の通知先メール）
 */
function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined) ? '' : String(v).trim();
}

/**
 * 【管理者用・初回のみ手動実行】
 * スクリプトプロパティの初期値を登録します（すでに値がある項目は上書きしません）。
 * 実行後は、プロジェクトの設定 > スクリプト プロパティ で値を変更でき、この関数は削除して構いません。
 */
function setupScriptProperties() {
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperties();
  const defaults = {
    APP_PASSWORD: 'konohana',
    REPORT_NOTIFY_EMAIL: 'nao7083177@gmail.com'
  };
  Object.keys(defaults).forEach(k => {
    if (!current[k]) props.setProperty(k, defaults[k]);
  });
  Logger.log('スクリプトプロパティを登録しました。必要に応じて「プロジェクトの設定」から値を変更してください。');
}

// ============================================================
// 認証（パスワード／ログイン状態を保つトークン）
// ============================================================
function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/** 現在のパスワードの指紋（パスワードを変更すると、発行済みトークンはすべて無効になる） */
function passwordFingerprint_() {
  return sha256Hex_('pw:' + getProp_('APP_PASSWORD'));
}

/** 入力されたパスワードが正しいか */
function isPlainPasswordCorrect_(password) {
  const real = getProp_('APP_PASSWORD');
  if (!real) return false; // 未設定の場合は誰もログインできない
  return String(password || '').trim() === real;
}

/** 期限切れ・パスワード変更前のトークンを掃除 */
function purgeExpiredTokens_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const fp = passwordFingerprint_();
  const now = Date.now();
  Object.keys(all).forEach(key => {
    if (key.indexOf(TOKEN_PROP_PREFIX) !== 0) return;
    try {
      const rec = JSON.parse(all[key]);
      if (!rec || rec.exp < now || rec.pw !== fp) props.deleteProperty(key);
    } catch (e) {
      props.deleteProperty(key);
    }
  });
}

/** 新しいトークンを発行（サーバーにはハッシュだけを保存） */
function issueLoginToken_() {
  purgeExpiredTokens_();
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const record = {
    exp: Date.now() + LOGIN_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    pw: passwordFingerprint_()
  };
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROP_PREFIX + sha256Hex_(token), JSON.stringify(record));
  return token;
}

/** トークンの検証（extend が true なら有効期限を延長） */
function verifyToken_(token, extend) {
  if (!token) return false;
  const props = PropertiesService.getScriptProperties();
  const key = TOKEN_PROP_PREFIX + sha256Hex_(String(token));
  const raw = props.getProperty(key);
  if (!raw) return false;
  try {
    const rec = JSON.parse(raw);
    if (!rec || rec.exp < Date.now() || rec.pw !== passwordFingerprint_()) {
      props.deleteProperty(key);
      return false;
    }
    if (extend) {
      rec.exp = Date.now() + LOGIN_TOKEN_DAYS * 24 * 60 * 60 * 1000;
      props.setProperty(key, JSON.stringify(rec));
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 認証情報（パスワード、または「token:」で始まるトークン）の検証
 * 各API（データ取得・訪問記録・報告）から使われます。
 */
function verifyPassword(credential) {
  const cred = String(credential || '').trim();
  if (cred.indexOf(TOKEN_CRED_PREFIX) === 0) {
    return verifyToken_(cred.substring(TOKEN_CRED_PREFIX.length), false);
  }
  return isPlainPasswordCorrect_(cred);
}

/**
 * ログインパスワードチェックAPI
 * keepLogin が true なら、「ログイン状態を保つ」用のトークンも発行して返す
 */
function checkPassword(password, keepLogin) {
  if (!getProp_('APP_PASSWORD')) {
    return { success: false, error: 'パスワードが未設定です（管理者: スクリプトプロパティ APP_PASSWORD を設定してください）' };
  }
  if (!isPlainPasswordCorrect_(password)) {
    return { success: false, error: 'パスワードが正しくありません' };
  }
  const result = { success: true };
  if (keepLogin) {
    try {
      result.token = issueLoginToken_();
      result.days = LOGIN_TOKEN_DAYS;
    } catch (e) {
      Logger.log('Token issue error: ' + e.toString());
    }
  }
  return result;
}

/** 保存済みのトークンでのログイン（有効なら期限を延長） */
function loginWithToken(token) {
  if (verifyToken_(token, true)) return { success: true };
  return { success: false, error: 'ログインの有効期限が切れました。もう一度ログインしてください' };
}

/** ログアウト時：その端末のトークンを無効にする */
function revokeLoginToken(token) {
  try {
    if (token) {
      PropertiesService.getScriptProperties().deleteProperty(TOKEN_PROP_PREFIX + sha256Hex_(String(token)));
    }
  } catch (e) {
    Logger.log('Token revoke error: ' + e.toString());
  }
  return { success: true };
}

/**
 * 【管理者用・手動実行】すべての端末の「ログイン状態を保つ」を一括で解除します。
 */
function revokeAllLoginTokens() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  let n = 0;
  Object.keys(all).forEach(key => {
    if (key.indexOf(TOKEN_PROP_PREFIX) === 0) {
      props.deleteProperty(key);
      n++;
    }
  });
  Logger.log('ログイン状態を解除しました（対象: ' + n + ' 件）');
}

/**
 * スプレッドシートを開く
 */
function openSpreadsheet_() {
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    try {
      return SpreadsheetApp.getActiveSpreadsheet();
    } catch (e2) {
      return null;
    }
  }
}

// ============================================================
// マンションデータのキャッシュ（CacheService）
// ============================================================
function readMansionCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const meta = cache.get(MANSION_CACHE_KEY + '_n');
    if (!meta) return null;
    const n = parseInt(meta, 10);
    if (!n || n < 1) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(MANSION_CACHE_KEY + '_' + i);
    const parts = cache.getAll(keys);
    let s = '';
    for (let i = 0; i < n; i++) {
      const p = parts[MANSION_CACHE_KEY + '_' + i];
      if (p === null || p === undefined) return null;
      s += p;
    }
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

function writeMansionCache_(obj) {
  try {
    const cache = CacheService.getScriptCache();
    const s = JSON.stringify(obj);
    const entries = {};
    let n = 0;
    for (let i = 0; i < s.length; i += MANSION_CACHE_CHUNK) {
      entries[MANSION_CACHE_KEY + '_' + n] = s.substring(i, i + MANSION_CACHE_CHUNK);
      n++;
    }
    entries[MANSION_CACHE_KEY + '_n'] = String(n);
    cache.putAll(entries, MANSION_CACHE_TTL_SEC);
  } catch (e) {
    Logger.log('Cache write error: ' + e.toString());
  }
}

function clearMansionCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const meta = cache.get(MANSION_CACHE_KEY + '_n');
    const n = meta ? parseInt(meta, 10) : 0;
    const keys = [MANSION_CACHE_KEY + '_n'];
    for (let i = 0; i < n; i++) keys.push(MANSION_CACHE_KEY + '_' + i);
    cache.removeAll(keys);
  } catch (e) {
    Logger.log('Cache clear error: ' + e.toString());
  }
}

// ============================================================
// スプレッドシート編集時の自動処理
// ============================================================
/**
 * スプレッドシート編集時に自動実行される組み込みトリガー
 * B列（住所）が変更・削除・複数行貼り付けされた場合にD列（緯度）・E列（経度）を自動更新・連動消去します。
 * 「報告」以外のシートが編集されたら、サーバー側のキャッシュも破棄します。
 */
function onEdit(e) {
  if (!e || !e.range) return;

  try {
    const range = e.range;
    const sheet = range.getSheet();
    const sheetName = sheet.getName();

    // 「報告」シートは対象外
    if (sheetName === '報告') return;

    // データが変わったのでキャッシュを破棄
    clearMansionCache_();

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
 * 【管理者用手動実行関数】全シートの住所と緯度経度のズレを一括修復・補完する関数
 * - B列（住所）が空なのにD・E列（緯度・経度）がある場合は自動削除
 * - B列（住所）があるのにD・E列が空・0の場合は自動ジオコーディング取得
 */
function syncAllSheetCoordinates() {
  const ss = openSpreadsheet_();
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
        sheet.getRange(rowNum, 4).clearContent();
        sheet.getRange(rowNum, 5).clearContent();
        cleanedCount++;
      } else if (address && !hasCoords) {
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

  clearMansionCache_();
  Logger.log('一括同期完了: 余分な緯度経度の削除 ' + cleanedCount + '件 / 不足住所の自動取得 ' + geocodedCount + '件');
}

// ============================================================
// マンションデータの取得
// ============================================================
/**
 * 見出し行から各列の位置を判定する
 * （物件名・住所・リンク・緯度・経度・優先・訪問日・注意）
 */
function detectColumns_(headers) {
  const find = (fn) => headers.findIndex(fn);
  const cols = {
    name: find(h => h.includes('マンション名') || h.includes('名称') || h.includes('物件名') || h.includes('建物')),
    addr: find(h => h.includes('住所') || h.includes('所在地')),
    link: find(h => h.includes('部屋') || h.includes('リンク') || h.includes('URL') || h.includes('部屋番号')),
    lat: find(h => h.includes('緯度') || h.toLowerCase().includes('lat')),
    lng: find(h => h.includes('経度') || h.toLowerCase().includes('lng') || h.toLowerCase().includes('lon')),
    priority: find(h => h.includes('優先') || h.includes('急ぎ') || h.includes('ステータス')),
    visit: find(h => h.includes('訪問日')),
    note: find(h => h.includes('注意'))
  };

  // デフォルト列補正（標準フォーマット: A:物件名, B:住所, C:リンク, D:緯度, E:経度）
  if (cols.name === -1) cols.name = 0;
  if (cols.addr === -1) cols.addr = 1;
  if (cols.link === -1) cols.link = 2;
  if (cols.lat === -1) cols.lat = 3;
  if (cols.lng === -1) cols.lng = 4;
  return cols;
}

/**
 * 訪問日セルの値を「yyyy-MM-dd」の文字列にそろえる
 */
function formatVisitValue_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return String(v === null || v === undefined ? '' : v).trim();
}

/**
 * 全シートからマンションデータを取得する関数
 * forceRefresh が true のときは、サーバー側のキャッシュを使わず最新を読み直す
 */
function getMansionData(password, forceRefresh) {
  if (!verifyPassword(password)) {
    return { success: false, error: '認証エラー: パスワードが一致しないか無効です' };
  }

  try {
    if (!forceRefresh) {
      const cached = readMansionCache_();
      if (cached) return { success: true, data: cached, cached: true };
    }

    const ss = openSpreadsheet_();
    if (!ss) {
      return { success: false, error: 'スプレッドシートを開けませんでした' };
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
      const cols = detectColumns_(headers);

      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row || !row[cols.name] || String(row[cols.name]).trim() === '') continue;

        const addressStr = String(row[cols.addr] || '').trim();

        // 住所が存在しない行で、誤って緯度経度が入っている場合のスキップ処理
        if (!addressStr) continue;

        let lat = parseCoord(row[cols.lat]);
        let lng = parseCoord(row[cols.lng]);

        if ((isNaN(lat) || isNaN(lng)) && row[cols.lat]) {
          const parts = String(row[cols.lat]).split(/[,，]/);
          if (parts.length === 2) {
            lat = parseCoord(parts[0]);
            lng = parseCoord(parts[1]);
          }
        }

        const nameStr = String(row[cols.name] || '').trim();
        const priorityStr = cols.priority !== -1 ? String(row[cols.priority] || '').trim() : '';
        const isUrgent = nameStr.includes('急ぎ') || nameStr.includes('優先') || priorityStr.includes('急ぎ') || priorityStr.includes('優先') || priorityStr === '1' || priorityStr.toLowerCase() === 'true';

        if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
          mansions.push({
            id: globalId++,
            name: nameStr,
            address: addressStr,
            roomLink: String(row[cols.link] || '').trim(),
            lat: lat,
            lng: lng,
            sheetName: sheetName,
            row: i + 1,                                                        // シート上の行番号（訪問記録用）
            isUrgent: isUrgent,
            visitDate: cols.visit !== -1 ? formatVisitValue_(row[cols.visit]) : '',
            note: cols.note !== -1 ? String(row[cols.note] || '').trim() : ''
          });
        }
      }
    });

    writeMansionCache_(mansions);
    return { success: true, data: mansions };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// ============================================================
// 訪問済みの記録
// ============================================================
/**
 * 訪問日の記録・取り消し
 * payload: { sheetName, row, name, visited }
 * 「訪問日」列がないシートには、右端に自動で追加します。
 */
function setVisitStatus(password, payload) {
  if (!verifyPassword(password)) {
    return { success: false, error: '認証エラー' };
  }
  if (!payload || !payload.sheetName || !payload.row || payload.sheetName === '報告') {
    return { success: false, error: '対象が正しくありません' };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, error: '混み合っています。もう一度お試しください' };
  }

  try {
    const ss = openSpreadsheet_();
    if (!ss) return { success: false, error: 'スプレッドシートを開けませんでした' };

    const sheet = ss.getSheetByName(payload.sheetName);
    if (!sheet) return { success: false, error: 'シートが見つかりません' };

    const row = Number(payload.row);
    if (!(row >= 2) || row > sheet.getLastRow()) {
      return { success: false, error: '行が見つかりません（データが更新された可能性があります）' };
    }

    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const cols = detectColumns_(headers);

    // 別の行を書き換えないよう、物件名が一致するか確認
    const currentName = String(sheet.getRange(row, cols.name + 1).getValue() || '').trim();
    if (currentName !== String(payload.name || '').trim()) {
      return { success: false, error: 'データが更新されています。「更新」を押してからやり直してください' };
    }

    // 「訪問日」列がなければ右端に追加
    let visitCol = cols.visit;
    if (visitCol === -1) {
      visitCol = lastCol; // 0始まりの次の列
      const headerCell = sheet.getRange(1, visitCol + 1);
      headerCell.setValue('訪問日');
      headerCell.setFontWeight('bold');
    }

    const cell = sheet.getRange(row, visitCol + 1);
    let visitDate = '';
    if (payload.visited) {
      const today = new Date();
      cell.setNumberFormat('yyyy-mm-dd');
      cell.setValue(today);
      visitDate = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy-MM-dd');
    } else {
      cell.clearContent();
    }

    clearMansionCache_();
    return { success: true, visitDate: visitDate };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 【管理者用・手動実行】すべてのシートの「訪問日」を一括でクリアします。
 * 新しい期間・新しいキャンペーンを始めるときなどに使います。実行前にバックアップをおすすめします。
 */
function clearAllVisitDates() {
  const ss = openSpreadsheet_();
  if (!ss) return;
  let cleared = 0;

  ss.getSheets().forEach(sheet => {
    if (sheet.getName() === '報告') return;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return;

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const visitIdx = headers.findIndex(h => h.includes('訪問日'));
    if (visitIdx === -1) return;

    sheet.getRange(2, visitIdx + 1, lastRow - 1, 1).clearContent();
    cleared += lastRow - 1;
  });

  clearMansionCache_();
  Logger.log('訪問日をクリアしました（対象セル数: ' + cleared + '）');
}

// ============================================================
// 報告
// ============================================================
/**
 * セルに書き込む値の安全化
 * 先頭が「=」「+」「-」「@」の文字列は、スプレッドシートが数式として解釈しないよう文字列として扱う
 */
function sanitizeCellValue_(value) {
  const s = String(value === null || value === undefined ? '' : value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/**
 * 報告の通知メールを送信する補助関数
 * 宛先はスクリプトプロパティ REPORT_NOTIFY_EMAIL（空の場合は送信しません）
 */
function sendReportNotification_(reportUrl, info) {
  const to = getProp_('REPORT_NOTIFY_EMAIL');
  if (!to) return;

  const oneLine = (s) => String(s === null || s === undefined ? '' : s).replace(/[\r\n]+/g, ' ').trim();

  const subject = '【此花区域】新しい報告: ' + oneLine(info.category)
    + (info.mansionName ? '（' + oneLine(info.mansionName) + '）' : '');

  const body = [
    '「報告」が送信されました。',
    '',
    '送信日時: ' + info.timestamp,
    '奉仕者名: ' + (info.reporterName || '（未入力）'),
    '項目: ' + (info.category || '（未選択）'),
    'マンション名: ' + (info.mansionName || '（指定なし）'),
    '住所: ' + (info.address || '（指定なし）'),
    '',
    '【詳細内容】',
    (info.details || '（記入なし）'),
    '',
    '報告シート: ' + reportUrl
  ].join('\n');

  MailApp.sendEmail({ to: to, subject: subject, body: body, name: '此花区域' });
}

/**
 * 報告送信処理（認証つき）
 * 列の順番: A 送信日時 / B 奉仕者名 / C 項目 / D マンション名 / E 住所 / F 詳細内容
 */
function submitReport(password, data) {
  if (!verifyPassword(password)) {
    return { success: false, error: '認証エラー: パスワードが一致しないか無効です' };
  }

  try {
    const ss = openSpreadsheet_();
    if (!ss) {
      return { success: false, error: 'スプレッドシートを開けませんでした' };
    }

    let reportSheet = ss.getSheetByName('報告');
    if (!reportSheet) {
      reportSheet = ss.insertSheet('報告');
      reportSheet.appendRow(REPORT_HEADERS);
      reportSheet.getRange(1, 1, 1, REPORT_HEADERS.length).setFontWeight('bold').setBackground('#f1f5f9');
    }

    data = data || {};
    const mansionName = data.mansionName || '';
    const address = data.address || '';

    const timestamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    reportSheet.appendRow([
      timestamp,
      sanitizeCellValue_(data.reporterName),
      sanitizeCellValue_(data.category),
      sanitizeCellValue_(mansionName),
      sanitizeCellValue_(address),
      sanitizeCellValue_(data.details)
    ]);

    // 通知メール（失敗しても報告の保存自体は成功として扱う）
    try {
      sendReportNotification_(
        ss.getUrl() + '#gid=' + reportSheet.getSheetId(),
        {
          timestamp: timestamp,
          reporterName: data.reporterName,
          category: data.category,
          mansionName: mansionName,
          address: address,
          details: data.details
        }
      );
    } catch (mailErr) {
      Logger.log('Report notification mail error: ' + mailErr.toString());
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * 【管理者用・必要時のみ手動実行】
 * 通知メールのテスト送信と、メール送信権限の承認を行います。
 */
function testReportEmail() {
  const to = getProp_('REPORT_NOTIFY_EMAIL');
  if (!to) {
    Logger.log('REPORT_NOTIFY_EMAIL が未設定のため、テストメールは送信しませんでした。');
    return;
  }
  MailApp.sendEmail({
    to: to,
    subject: '【テスト】此花区域 通知メール',
    body: 'これはテストメールです。\n報告が送信されると、このアドレスに通知メールが届きます。',
    name: '此花区域'
  });
  Logger.log('テストメールを送信しました: ' + to);
}

/**
 * 【管理者用・1回だけ手動実行】
 * 旧形式の「報告」シート（A:送信日時 / B:奉仕者名 / C:項目 / D:詳細内容 / E:位置/マンション名）を
 * 新形式（A:送信日時 / B:奉仕者名 / C:項目 / D:マンション名 / E:住所 / F:詳細内容）に変換します。
 * すでに新形式の場合は何もせず終了します。実行前に「報告」シートを複製してバックアップしてください。
 */
function migrateReportSheetLayout() {
  const ss = openSpreadsheet_();
  const sheet = ss ? ss.getSheetByName('報告') : null;

  if (!sheet) {
    Logger.log('「報告」シートが見つかりません。移行は不要です。');
    return;
  }

  const lastCol = Math.max(sheet.getLastColumn(), 5);
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());

  if (header[3] !== '詳細内容' || header[4] !== '位置/マンション名') {
    Logger.log('旧形式の見出しではないため、移行を中止しました。（D1=' + header[3] + ' / E1=' + header[4] + '）');
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    const converted = rows.map(r => {
      const loc = String(r[4] || '');
      const parts = loc ? loc.split('｜') : [];
      return [r[0], r[1], r[2], parts[0] || '', parts[1] || '', r[3]];
    });
    sheet.getRange(2, 1, converted.length, REPORT_HEADERS.length).setValues(converted);
    sheet.getRange(2, 1, converted.length, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');
  }

  sheet.getRange(1, 1, 1, REPORT_HEADERS.length)
    .setValues([REPORT_HEADERS])
    .setFontWeight('bold')
    .setBackground('#f1f5f9');

  Logger.log('移行が完了しました。変換した行数: ' + Math.max(lastRow - 1, 0));
}