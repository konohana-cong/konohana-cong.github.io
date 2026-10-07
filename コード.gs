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
 * 各API（データ取得・部屋の記録・報告）から使われます。
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
 * （物件名・住所・リンク・緯度・経度・優先・注意）
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
            row: i + 1,                                                        // シート上の行番号（部屋記録の対象特定用）
            isUrgent: isUrgent,
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
// 部屋番号シート（アプリ内で部屋ごとの訪問結果を記録）
// ============================================================
// 部屋番号シートの形式:
//   ・部屋番号が横に並び、階ごとに行が分かれている
//   ・部屋番号のすぐ下の1段に「日付（左）」と「結果（右）」が入る
const ROOM_RESULTS = ['会', '留', 'エラー', '予約'];
const ROOM_RE_LABEL = /^[0-9]{2,4}$/;
const ROOM_RE_DATE = /^(\d{1,4}[\/\-.]\d{1,2}([\/\-.]\d{1,2})?|\d{4}年\d{1,2}月\d{1,2}日)$/;

/**
 * セルからリンクURLを取り出す（URLそのもの／リッチテキストのリンク／HYPERLINK関数に対応）
 */
function extractLink_(cell) {
  const v = String(cell.getValue() || '').trim();
  if (/^https?:\/\//i.test(v)) return v;
  try {
    const rich = cell.getRichTextValue();
    if (rich) {
      const u = rich.getLinkUrl();
      if (u) return u;
      const runs = rich.getRuns();
      for (let i = 0; i < runs.length; i++) {
        const ru = runs[i].getLinkUrl();
        if (ru) return ru;
      }
    }
  } catch (e) { /* 何もしない */ }
  try {
    const f = cell.getFormula();
    const mm = f && f.match(/HYPERLINK\(\s*"([^"]+)"/i);
    if (mm) return mm[1];
  } catch (e) { /* 何もしない */ }
  return v;
}

/**
 * リンク（GoogleスプレッドシートのURL）から、対象のシートを開く
 * #gid=○○ があればそのシート、なければ最初のシート
 */
function openRoomSheetByUrl_(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error('部屋番号のリンクがGoogleスプレッドシートではありません');

  let target;
  try {
    target = SpreadsheetApp.openById(m[1]);
  } catch (e) {
    Logger.log('openById error: ' + e.toString());
    throw new Error('部屋番号のシートを開けませんでした（編集権限を確認してください）');
  }

  let sheet = null;
  const g = String(url).match(/[#&?]gid=(\d+)/);
  if (g) {
    sheet = target.getSheets().filter(s => String(s.getSheetId()) === g[1])[0] || null;
  }
  if (!sheet) sheet = target.getSheets()[0];
  if (!sheet) throw new Error('部屋番号のシートが見つかりません');
  return { ss: target, sheet: sheet };
}

/**
 * アプリから送られたマンションの指定（シート名・行・名前）から、部屋番号シートを特定する
 * メインのシートに登録されているリンクだけを使う（画面から任意のURLは指定できない）
 */
function resolveRoomSheet_(ref) {
  if (!ref || !ref.sheetName || !ref.row || ref.sheetName === '報告') {
    throw new Error('対象が正しくありません');
  }
  const main = openSpreadsheet_();
  if (!main) throw new Error('スプレッドシートを開けませんでした');

  const sheet = main.getSheetByName(ref.sheetName);
  if (!sheet) throw new Error('シートが見つかりません');

  const row = Number(ref.row);
  if (!(row >= 2) || row > sheet.getLastRow()) {
    throw new Error('行が見つかりません（データが更新された可能性があります）');
  }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const cols = detectColumns_(headers);

  // 別のマンションを開かないよう、物件名が一致するか確認
  const currentName = String(sheet.getRange(row, cols.name + 1).getValue() || '').trim();
  if (currentName !== String(ref.name || '').trim()) {
    throw new Error('データが更新されています。「更新」を押してからやり直してください');
  }

  const url = extractLink_(sheet.getRange(row, cols.link + 1));
  const target = openRoomSheetByUrl_(url);
  return { sheet: target.sheet, url: url };
}

/**
 * 部屋番号シートを読み取り、階ごとの部屋一覧（番号・日付・結果）と、上部の注意書きを返す
 */
function parseRoomSheet_(sheet, ref) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return { floors: [], notes: [] };

  const display = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();

  // 部屋番号の候補：2〜4桁の数字のセルで、真下が日付（または空）、右下が結果（または空）
  const cands = [];
  for (let r = 0; r < lastRow - 1; r++) {
    for (let c = 0; c < lastCol - 1; c++) {
      const label = String(display[r][c]).trim();
      if (!ROOM_RE_LABEL.test(label)) continue;
      const below = String(display[r + 1][c]).trim();
      const belowRight = String(display[r + 1][c + 1]).trim();
      if (below !== '' && !ROOM_RE_DATE.test(below)) continue;
      if (belowRight.length > 6) continue;
      cands.push({ r: r + 1, c: c + 1, label: label, date: below, result: belowRight });
    }
  }

  // 上部の見出し部分にある数字を除外（部屋番号は、2室以上が並ぶ最初の行から始まる）
  const countByRow = {};
  cands.forEach(x => { countByRow[x.r] = (countByRow[x.r] || 0) + 1; });
  const multi = Object.keys(countByRow).filter(k => countByRow[k] >= 2).map(Number);
  let rooms = cands;
  if (multi.length) {
    const firstMulti = Math.min.apply(null, multi);
    rooms = cands.filter(x => x.r >= firstMulti);
  }

  // 階（行）ごとにまとめる
  const floors = [];
  const idx = {};
  rooms.forEach(x => {
    if (idx[x.r] === undefined) {
      idx[x.r] = floors.length;
      floors.push({ r: x.r, rooms: [] });
    }
    floors[idx[x.r]].rooms.push({ r: x.r, c: x.c, label: x.label, date: x.date, result: x.result });
  });

  // 部屋番号より上の見出し部分を読み取る。
  // 並び：マンション名（左上）／地名（その右）と番地（地名の真下）／それ以外は注意事項
  // 返す順番：1行目＝「地名 番地」、2行目以降＝注意事項（1セルにつき1行）
  const notes = [];
  if (rooms.length) {
    const firstRow = rooms[0].r;
    const nameStr = String((ref && ref.name) || '');
    const norm = (t) => String(t).replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 65248)).trim();
    const RE_ADDR = /^[0-9]+([-ー－‐−][0-9]+)*$/;

    // 見出し部分のセルを、上から下・左から右の順に集める
    const cells = [];
    for (let r = 0; r < firstRow - 1; r++) {
      for (let c = 0; c < lastCol; c++) {
        const t = String(display[r][c]).trim();
        if (t) cells.push({ r: r, c: c, t: t, used: false });
      }
    }
    const find = (r, c) => cells.filter(x => x.r === r && x.c === c)[0];

    // 左上で最初に見つかったセルはマンション名（住所の形式でなければ）
    if (cells.length && !RE_ADDR.test(norm(cells[0].t))) cells[0].used = true;
    cells.forEach(x => { if (!x.used && nameStr.indexOf(x.t) !== -1 && !RE_ADDR.test(norm(x.t))) x.used = true; });

    // 番地（例: 2-3-23）と、その真上の地名を1行にまとめる
    const addrParts = [];
    cells.forEach(x => {
      if (x.used || !RE_ADDR.test(norm(x.t))) return;
      const above = find(x.r - 1, x.c);
      x.used = true;
      if (above && !above.used) {
        above.used = true;
        addrParts.push(above.t + ' ' + x.t);
      } else {
        addrParts.push(x.t);
      }
    });
    if (addrParts.length) notes.push(addrParts.join(' / '));

    // 残りは注意事項（同じ内容は1回だけ）
    const seen = {};
    cells.forEach(x => {
      if (x.used || seen[x.t] || notes.length >= 6) return;
      seen[x.t] = true;
      notes.push(x.t.length > 120 ? x.t.substring(0, 120) + '…' : x.t);
    });
  }

  return { floors: floors, notes: notes };
}

/**
 * 部屋番号の一覧を取得する（アプリの「部屋番号一覧を見る」から呼ばれる）
 * ref: { sheetName, row, name }
 */
function getRoomSheet(credential, ref) {
  if (!verifyPassword(credential)) {
    return { success: false, error: '認証エラー' };
  }
  try {
    const target = resolveRoomSheet_(ref);
    const parsed = parseRoomSheet_(target.sheet, ref);
    return { success: true, floors: parsed.floors, notes: parsed.notes };
  } catch (e) {
    return { success: false, error: (e && e.message) ? e.message : String(e) };
  }
}

/**
 * 部屋の訪問結果を記録する（日付は今日の日付が自動で入る）
 * ref: { sheetName, row, name } / room: { r, c, label } / result: 会・留・エラー・予約（空文字なら記録を消す）
 */
function setRoomResult(credential, ref, room, result) {
  if (!verifyPassword(credential)) {
    return { success: false, error: '認証エラー' };
  }

  const value = String(result === null || result === undefined ? '' : result).trim();
  if (value !== '' && ROOM_RESULTS.indexOf(value) === -1) {
    return { success: false, error: '結果の値が正しくありません' };
  }

  const r = room ? Number(room.r) : 0;
  const c = room ? Number(room.c) : 0;
  if (!(r >= 1) || !(c >= 1) || !room.label) {
    return { success: false, error: '部屋の指定が正しくありません' };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, error: '混み合っています。もう一度お試しください' };
  }

  try {
    const target = resolveRoomSheet_(ref);
    const sheet = target.sheet;

    if (r + 1 > sheet.getLastRow() || c + 1 > sheet.getLastColumn()) {
      return { success: false, error: '部屋の位置が見つかりません。開き直してからやり直してください' };
    }

    // 別の部屋を書き換えないよう、その位置の部屋番号が一致するか確認
    const currentLabel = String(sheet.getRange(r, c).getDisplayValue()).trim();
    if (currentLabel !== String(room.label).trim()) {
      return { success: false, error: 'シートの内容が変わっています。開き直してからやり直してください' };
    }

    const dateCell = sheet.getRange(r + 1, c);        // 部屋番号の真下（左）：日付
    const resultCell = sheet.getRange(r + 1, c + 1);  // 部屋番号の右下：結果

    if (value) {
      const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
      if (!/y/i.test(dateCell.getNumberFormat())) {
        dateCell.setNumberFormat('yyyy/MM/dd');
      }
      dateCell.setValue(today);
      resultCell.setValue(value);
    } else {
      dateCell.clearContent();
      resultCell.clearContent();
    }

    SpreadsheetApp.flush();
    return {
      success: true,
      date: String(dateCell.getDisplayValue()).trim(),
      result: String(resultCell.getDisplayValue()).trim()
    };
  } catch (e) {
    return { success: false, error: (e && e.message) ? e.message : String(e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 【管理者用・手動実行】サンプルの部屋番号シートが正しく読めるか、実行ログで確認します。
 */
function testParseRoomSheet() {
  const url = 'https://docs.google.com/spreadsheets/d/1zHEez4fdvrJacjKbE20FOc_OIQZWSHFdBAK-sRywWcs/edit?usp=sharing';
  const target = openRoomSheetByUrl_(url);
  const parsed = parseRoomSheet_(target.sheet, { name: 'ライオンズマンション此花第2' });

  let total = 0;
  parsed.floors.forEach(fl => {
    total += fl.rooms.length;
    Logger.log('行' + fl.r + ': ' + fl.rooms.map(rm => rm.label + '(' + (rm.result || '未') + ' ' + rm.date + ')').join(' / '));
  });
  Logger.log('読み取れた部屋数: ' + total + ' / 階数(行数): ' + parsed.floors.length);
  Logger.log('上部の記載: ' + JSON.stringify(parsed.notes));
}

/**
 * 【管理者用・手動実行】全マンションの部屋番号シートを順に確認し、
 * 「開けない」「部屋が読み取れない」ものを実行ログに一覧表示します（数分かかります）。
 */
function checkAllRoomSheets() {
  const started = Date.now();
  const ss = openSpreadsheet_();
  if (!ss) return;

  let okCount = 0;
  const problems = [];
  let stopped = false;

  const sheets = ss.getSheets();
  for (let s = 0; s < sheets.length && !stopped; s++) {
    const sheet = sheets[s];
    const sheetName = sheet.getName();
    if (sheetName === '報告') continue;

    const data = sheet.getDataRange().getValues();
    if (!data || data.length <= 1) continue;
    const headers = data[0].map(h => String(h).trim());
    const cols = detectColumns_(headers);

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const name = String(row[cols.name] || '').trim();
      if (!name || !String(row[cols.addr] || '').trim()) continue;

      if (Date.now() - started > 5 * 60 * 1000) {
        Logger.log('時間の上限に近づいたため、ここで中断しました。もう一度実行すると最初から確認します。');
        stopped = true;
        break;
      }

      const link = String(row[cols.link] || '').trim();
      if (!link) {
        problems.push(sheetName + ' 行' + (i + 1) + ' ' + name + ' : リンク未登録');
        continue;
      }
      try {
        const target = openRoomSheetByUrl_(link);
        const parsed = parseRoomSheet_(target.sheet, { name: name });
        const n = parsed.floors.reduce((sum, fl) => sum + fl.rooms.length, 0);
        if (n === 0) {
          problems.push(sheetName + ' 行' + (i + 1) + ' ' + name + ' : 部屋が読み取れません');
        } else {
          okCount++;
        }
      } catch (e) {
        problems.push(sheetName + ' 行' + (i + 1) + ' ' + name + ' : ' + ((e && e.message) ? e.message : String(e)));
      }
    }
  }

  Logger.log('確認完了: 読み取れたマンション ' + okCount + ' 件 / 要確認 ' + problems.length + ' 件');
  problems.forEach(p => Logger.log('要確認: ' + p));
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