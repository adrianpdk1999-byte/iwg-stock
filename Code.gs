/**
 * STOCK FINDER — shared branded-SKU stock across shops.
 * Google Apps Script backend, bound to one Google Sheet. The page (Index.html) calls doPost with JSON.
 *
 * Sheets:
 *   Stock     : SKU | Brand | Model | Colour | Size | UPC | Description | Photo | Link | Cost | <one column per shop code>
 *   Shops     : Code | Name | PIN (unused) | Active
 *   Users     : UserID | Name | Shop | Password | Role (Staff / Manager / Admin) | Active (Y/N) | Shops (Managers: blank = own shop, list of codes, or ALL)
 *   Logins    : Time | UserID | Name | Shop | Device
 *   Requests  : ID | Requested | Shop | Type (STOCK IN / STOCK OUT / ADJUST) | SKU | Qty | Reason | Status | RequestedBy | DecidedBy | DecidedAt | Details
 *   Transfers : ID | Requested | From | To | SKU | Qty | Status | RequestedBy | Note | ApprovedBy | ApprovedAt | ReceivedBy | ReceivedAt
 *   Log       : Time | Shop | Type | SKU | Qty | Balance | Ref | Staff | Note
 *
 * Cost is never sent to the page. Staff see only the cost code: RODENSTICK = 1234567890,
 * and the derived RSP: cost x 4, rounded up to the next RM10.
 * Needs the Advanced Drive Service (Drive API v3) for reading scanned DOs.
 */

var SHEET_STOCK = 'Stock', SHEET_SHOPS = 'Shops', SHEET_LOG = 'Log', SHEET_USERS = 'Users',
    SHEET_LOGINS = 'Logins', SHEET_TRANSFERS = 'Transfers', SHEET_REQ = 'Requests';
/*
 * Roles: Staff   = look up; Sold today is a REQUEST approved by a Manager of that shop or an Admin.
 *        Manager = record sales directly, approve Staff sales and confirm arriving transfers for their shops,
 *                  REQUEST stock in, stock out, adjustments and transfers (an Admin approves).
 *        Admin   = everything directly, and approves requests.
 * Only Admins change stock counts directly. Column G lists the extra shops a Manager may work for (requests + sales).
 */
var REQ_HEAD = ['ID', 'Requested', 'Shop', 'Type', 'SKU', 'Qty', 'Reason', 'Status', 'RequestedBy', 'DecidedBy', 'DecidedAt', 'Details'];
var R = { ID: 0, REQ: 1, SHOP: 2, TYPE: 3, SKU: 4, QTY: 5, REASON: 6, STATUS: 7, BY: 8, DECBY: 9, DECAT: 10, DET: 11 };
var FIXED = ['SKU', 'Brand', 'Model', 'Colour', 'Size', 'UPC', 'Description', 'Photo', 'Link', 'Cost'];
var C = { SKU: 0, BRAND: 1, MODEL: 2, COLOUR: 3, SIZE: 4, UPC: 5, DESC: 6, PHOTO: 7, LINK: 8, COST: 9 };
var LOG_HEAD = ['Time', 'Shop', 'Type', 'SKU', 'Qty', 'Balance', 'Ref', 'Staff', 'Note'];
var USER_HEAD = ['UserID', 'Name', 'Shop', 'Password', 'Role', 'Active', 'Adjust'];
var LOGIN_HEAD = ['Time', 'UserID', 'Name', 'Shop', 'Device', 'Result'];
var MAX_TRIES = 5, LOCK_MINUTES = 15, PASS_DAYS = 30;
var TR_HEAD = ['ID', 'Requested', 'From', 'To', 'SKU', 'Qty', 'Status', 'RequestedBy', 'Note', 'ApprovedBy', 'ApprovedAt', 'ReceivedBy', 'ReceivedAt'];
var T = { ID: 0, REQ: 1, FROM: 2, TO: 3, SKU: 4, QTY: 5, STATUS: 6, BY: 7, NOTE: 8, APPBY: 9, APPAT: 10, RCVBY: 11, RCVAT: 12 };
var COST_LETTERS = 'RODENSTICK'; // R=1 O=2 D=3 E=4 N=5 S=6 T=7 I=8 C=9 K=0
// Model prefix -> brand. Add more brands here later (e.g. OO: 'Oakley').
var BRAND_PREFIX = { RB: 'Ray-Ban', RX: 'Ray-Ban', RJ: 'Ray-Ban', RY: 'Ray-Ban' };
var SCAN_FOLDER = 'Stock Finder - DO scans', PHOTO_FOLDER = 'Stock Finder - photos';

/* ---------------- web app ---------------- */

function doGet(e) {
  // Plain file + text replace (no template engine, so the page's JavaScript is served untouched).
  var html = HtmlService.createHtmlOutputFromFile('Index').getContent()
    .split('__API_URL__').join(ScriptApp.getService().getUrl());
  return HtmlService.createHtmlOutput(html)
    .setTitle('Stock Finder')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

var API = {
  api_login: api_login, api_logout: api_logout, api_getData: api_getData, api_recordSales: api_recordSales, api_receive: api_receive,
  api_requestTransfer: api_requestTransfer, api_decideTransfer: api_decideTransfer,
  api_receiveTransfer: api_receiveTransfer, api_cancelTransfer: api_cancelTransfer,
  api_importShop: api_importShop, api_ocr: api_ocr, api_setPhoto: api_setPhoto, api_history: api_history,
  api_adjust: api_adjust, api_log: api_log, api_stockOut: api_stockOut, api_decideRequest: api_decideRequest,
  api_cancelRequest: api_cancelRequest, api_notifications: api_notifications, api_markSeen: api_markSeen,
  api_tgStatus: api_tgStatus, api_tgLink: api_tgLink, api_tgCheck: api_tgCheck, api_tgUnlink: api_tgUnlink
};

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var fn = API[req.fn];
    if (!fn) throw new Error('Unknown action ' + req.fn + '. The server code may be out of date.');
    out = { ok: true, result: fn.apply(null, req.args || []) };
  } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  if (out.ok) flushPush_(); else PUSHQ_ = [];   // notifications only for actions that succeeded
  return json_(out);
}

/** Unique reference like RQ-261114-153012-7: date-time plus a counter that never repeats. */
function newId_(prefix) {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('seq') || 0) + 1;
  props.setProperty('seq', String(n));
  return prefix + '-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyMMdd-HHmmss') + '-' + n;
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Run from the editor to create any missing tabs. Safe to run again. */
function setup() {
  sheetOrCreate_(SHEET_SHOPS, ['Code', 'Name', 'PIN', 'Active']);
  sheetOrCreate_(SHEET_STOCK, FIXED);
  sheetOrCreate_(SHEET_LOG, LOG_HEAD);
  sheetOrCreate_(SHEET_USERS, USER_HEAD).getRange('D:D').setNumberFormat('@');
  sheetOrCreate_(SHEET_LOGINS, LOGIN_HEAD);
  sheetOrCreate_(SHEET_TRANSFERS, TR_HEAD);
  sheetOrCreate_(SHEET_REQ, REQ_HEAD);
}

/* ---------------- normalising ---------------- */

function normModel(s) {
  s = String(s || '').toUpperCase().replace(/\s+/g, '');
  // Luxottica prints 0RB2140; some POS print ORB2140 (letter O), OR2140F or OB4105
  return s.replace(/^[0O](?=R[BXJY]?\d|R[BXJY]R?\d)/, '').replace(/^R(?=\d)/, 'RB');
}
function normColour(s) { return String(s || '').toUpperCase().replace(/\s+/g, ''); }
function normSize(s) { var m = String(s || '').match(/\d{2,3}/); return m ? m[0] : ''; }
function normUpc(s) { return String(s || '').replace(/\D/g, ''); }
function skuKey(model, colour, size) {
  return [normModel(model), normColour(colour), normSize(size)].filter(String).join(' ');
}
function brandOf(model) { return BRAND_PREFIX[normModel(model).slice(0, 2)] || ''; }

/** Whole-ringgit cost to letters: 384.48 -> 384 -> DIE. */
function costCode(n) {
  n = Math.round(Number(n));
  if (!(n > 0)) return '';
  return String(n).split('').map(function (d) { return COST_LETTERS.charAt((Number(d) + 9) % 10); }).join('');
}

/** Derived RSP: cost x 4, rounded UP to the next RM10 (384.48 -> 1537.92 -> 1540). Works in sen to avoid float slips. */
function rsp(n) {
  n = Number(n);
  if (!(n > 0)) return 0;
  var sen = Math.round(n * 400);          // cost x 4, in sen
  return Math.ceil(sen / 1000) * 10;      // up to the next RM10
}

/* ---------------- sheet helpers ---------------- */

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run setup() in the Apps Script editor.');
  return sh;
}
function sheetOrCreate_(name, head) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function rows_(sh, width) {
  var n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, width).getValues() : [];
}

function shops_() {
  return rows_(sheet_(SHEET_SHOPS), 4)
    .filter(function (r) { return r[0] && String(r[3] || 'Y').toUpperCase() !== 'N'; })
    .map(function (r) { return { code: String(r[0]).trim(), name: String(r[1] || r[0]).trim() }; });
}

function users_() {
  return rows_(sheetOrCreate_(SHEET_USERS, USER_HEAD), USER_HEAD.length)
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      return { id: String(r[0]).trim(), name: String(r[1] || r[0]).trim(), shop: String(r[2] || '').trim(),
        pass: String(r[3]).trim(), admin: /admin/i.test(r[4]), manager: /manager/i.test(r[4]), active: String(r[5] || 'Y').toUpperCase() !== 'N',
        adjust: /admin/i.test(r[4]) ? 'ALL' : '',            // direct adjustment: Admins only
        shopsCol: String(r[6] || '').trim() };
    });
}

/* ---------------- login security ----------------
 * Password is checked ONLY at login, with a lockout after MAX_TRIES wrong attempts.
 * A successful login returns a random login pass; the phone keeps the pass, never the password.
 * The pass expires after PASS_DAYS, on Log out, or at once when the user's password is changed
 * or the user is set inactive. Only a hash of each pass is stored on the server.
 */
function hash_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s)));
}
function failKey_(id) { return 'fail_' + hash_(String(id).toLowerCase()).slice(0, 24); }

/** Checks the login pass sent with every request. */
function checkUser_(auth) {
  var token = String(auth && auth.token || '');
  var bad = new Error('Your login has expired. Please log in again.');
  if (token.length < 30) throw bad;
  var props = PropertiesService.getScriptProperties(), key = 'tok_' + hash_(token);
  var rec = props.getProperty(key);
  if (!rec) throw bad;
  rec = JSON.parse(rec);
  if (Date.now() > rec.exp) { props.deleteProperty(key); throw bad; }
  var u = users_().filter(function (x) { return x.id.toLowerCase() === String(rec.uid).toLowerCase(); })[0];
  if (!u || !u.active || hash_(u.pass) !== rec.ph) { props.deleteProperty(key); throw bad; }
  ACTOR_ = u;
  return u;
}
function checkAdmin_(auth) {
  var u = checkUser_(auth);
  if (!u.admin) throw new Error('Only the owner (Admin) can do this.');
  return u;
}
/**
 * Shops a user may work for. Admin: all. Manager: own shop plus column G of the Users tab
 * ("ALL", or codes separated by commas / spaces / slashes). Staff: own shop only.
 */
function allowedShops_(u) {
  var all = shops_().map(function (s) { return s.code; });
  if (u.admin) return all;
  if (!u.manager) return all.filter(function (c) { return c === u.shop; });
  var g = String(u.shopsCol || '').toUpperCase();
  if (/(^|[^A-Z])ALL([^A-Z]|$)/.test(g)) return all;
  var want = g.split(/[\s,\/;|]+/).filter(String);
  return all.filter(function (c) { return c === u.shop || want.indexOf(c.toUpperCase()) >= 0; });
}
/** The shop a request acts for: the shop asked for if the user may work for it, else their own. */
function shopFor_(u, shop) {
  var code = (shop && allowedShops_(u).indexOf(shop) >= 0) ? shop : u.shop;
  if (shop && shop !== code && !u.admin) throw new Error('You are not set up to work for ' + shop + '. Ask the owner.');
  if (!shops_().some(function (s) { return s.code === code; })) throw new Error('Unknown shop "' + code + '". Check the Users tab.');
  return code;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Loads Stock into memory, adding a column for any new shop in the Shops sheet. */
function loadStock_() {
  var sh = sheet_(SHEET_STOCK);
  var lastCol = Math.max(sh.getLastColumn(), FIXED.length);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  FIXED.forEach(function (h, i) {
    if (head[i] !== h) throw new Error('Stock tab column ' + (i + 1) + ' should be "' + h + '" but is "' + head[i] + '".');
  });
  shops_().forEach(function (s) {
    if (head.indexOf(s.code) < 0) { head.push(s.code); sh.getRange(1, head.length).setValue(s.code).setFontWeight('bold'); }
  });
  var rows = rows_(sh, head.length);
  var st = { sh: sh, head: head, rows: rows, col: {}, bySku: {}, byUpc: {} };
  head.forEach(function (h, i) { if (i >= FIXED.length && h) st.col[h] = i; });
  rows.forEach(function (r, i) {
    if (r[C.SKU]) st.bySku[String(r[C.SKU])] = i;
    var u = normUpc(r[C.UPC]); if (u) st.byUpc[u] = i;
  });
  return st;
}

function saveStock_(st) {
  if (!st.rows.length) return;
  st.rows.forEach(function (r) { while (r.length < st.head.length) r.push(''); });
  st.sh.getRange(2, 1, st.rows.length, st.head.length).setValues(st.rows);
}

/** Finds (or creates) the row for an item. Returns the row index, or -1. */
function resolve_(st, it, create) {
  var upc = normUpc(it.upc);
  var key = it.sku ? String(it.sku) : skuKey(it.model, it.colour, it.size);
  var i = (key && st.bySku[key] != null) ? st.bySku[key] : (upc && st.byUpc[upc] != null ? st.byUpc[upc] : -1);
  if (i < 0) {
    if (!key || create === false) return -1;
    var model = normModel(it.model || key.split(' ')[0]);
    var r = [key, it.brand || brandOf(model), model, normColour(it.colour), normSize(it.size), upc, it.desc || '', '', '', ''];
    while (r.length < st.head.length) r.push(0);
    st.rows.push(r);
    i = st.rows.length - 1;
    st.bySku[key] = i;
    if (upc) st.byUpc[upc] = i;
  } else {
    var row = st.rows[i]; // fill in details we learn later
    if (upc && !normUpc(row[C.UPC])) { row[C.UPC] = upc; st.byUpc[upc] = i; }
    if (it.desc && !row[C.DESC]) row[C.DESC] = it.desc;
  }
  return i;
}

function addQty_(st, i, shop, delta) {
  var c = st.col[shop];
  if (c == null) throw new Error('Unknown shop ' + shop);
  var v = (Number(st.rows[i][c]) || 0) + delta;
  st.rows[i][c] = v;
  return v;
}

function log_(entries) {
  if (!entries.length) return;
  var sh = sheet_(SHEET_LOG);
  sh.getRange(sh.getLastRow() + 1, 1, entries.length, LOG_HEAD.length).setValues(entries);
  queueMoves_(entries);
}

function cleanLines_(lines) {
  return (lines || []).map(function (l) {
    return { sku: l.sku || '', model: l.model, colour: l.colour, size: l.size, upc: l.upc, desc: l.desc, qty: Math.round(Number(l.qty) || 0),
      rcpt: String(l.rcpt || '').trim() };
  }).filter(function (l) { return l.qty > 0 && (l.sku || l.model || l.upc); });
}

function fmt_(d) {
  return d instanceof Date && !isNaN(d) ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'd MMM yyyy HH:mm') : String(d || '');
}

/* ---------------- phone notifications (OneSignal) ----------------
 * Switched on by two Script Properties (Apps Script → Project Settings → Script properties):
 *   ONESIGNAL_APP_ID   – the OneSignal App ID (not secret)
 *   ONESIGNAL_REST_KEY – the OneSignal REST API key (secret: never put it in the code or chat)
 * Each user's phone is linked under a private push ID derived from their User ID, so nobody can
 * sign a phone up for another person's notifications by guessing a User ID.
 */
var ACTOR_ = null, PUSHQ_ = [];
var MOVE_WORDS = { SOLD: 'sold', RECEIVE: 'stock in', 'STOCK OUT': 'stock out', ADJUST: 'adjusted', IMPORT: 'imported',
  'TRANSFER OUT': 'sent out', 'TRANSFER IN': 'received' };

function pushId_(uid) {
  var props = PropertiesService.getScriptProperties(), salt = props.getProperty('PUSH_SALT');
  if (!salt) { salt = Utilities.getUuid(); props.setProperty('PUSH_SALT', salt); }
  return 'u' + hash_(salt + ':' + String(uid).toLowerCase()).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}
/** Admins plus the Managers who work for this shop. */
function watchers_(shop) {
  return users_().filter(function (x) { return x.active && (x.admin || (x.manager && allowedShops_(x).indexOf(shop) >= 0)); });
}
function queuePush_(users, title, body) {
  var me = ACTOR_ ? ACTOR_.id.toLowerCase() : '';
  var ids = (users || []).filter(function (x) { return x && x.id.toLowerCase() !== me; }).map(function (x) { return x.id; });
  if (ids.length) PUSHQ_.push({ ids: ids, title: title, body: body });
}
/** One message per shop per action, e.g. "Anywear · Alex sold 2 frames: RB2140F 901S 52 …" */
function queueMoves_(entries) {
  var by = {};
  entries.forEach(function (e) {
    var g = by[e[1]] || (by[e[1]] = { n: 0, types: {}, skus: [], who: {} });
    g.n += Math.abs(Number(e[4]) || 0); g.types[e[2]] = 1; g.who[e[7]] = 1;
    if (g.skus.indexOf(e[3]) < 0) g.skus.push(e[3]);
  });
  var names = {}; shops_().forEach(function (s) { names[s.code] = s.name; });
  Object.keys(by).forEach(function (shop) {
    var g = by[shop], what = Object.keys(g.types).map(function (t) { return MOVE_WORDS[t] || t.toLowerCase(); }).join(' / ');
    var who = Object.keys(g.who).join(', ');
    var body = who + ' ' + what + ' ' + g.n + ' frame' + (g.n === 1 ? '' : 's') + ': ' + g.skus.slice(0, 3).join(', ') + (g.skus.length > 3 ? ' …' : '');
    queuePush_(watchers_(shop), names[shop] || shop, body);
  });
}
function flushPush_() {
  var q = PUSHQ_; PUSHQ_ = [];
  if (!q.length) return;
  var props = PropertiesService.getScriptProperties();
  sendTelegram_(q, props);
  var app = props.getProperty('ONESIGNAL_APP_ID'), key = props.getProperty('ONESIGNAL_REST_KEY');
  if (!app || !key) return;                    // not set up yet: the in-app bell still works
  q.forEach(function (m) {
    try {
      UrlFetchApp.fetch('https://api.onesignal.com/notifications', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Key ' + key },
        payload: JSON.stringify({ app_id: app, target_channel: 'push',
          include_aliases: { external_id: m.ids.map(pushId_) },
          headings: { en: m.title }, contents: { en: m.body }, url: 'https://stock.iweargroup.com/' })
      });
    } catch (e) { /* a failed notification never blocks stock work */ }
  });
}

/* ---------------- Telegram notifications ----------------
 * Switched on by Script Property TELEGRAM_BOT_TOKEN (from @BotFather; secret: never put it in code or chat).
 * Each user links their own Telegram from the app: a one-time code (15 minutes) is sent to the bot
 * with /start; the server reads it with getUpdates (no webhook needed) and stores the chat ID.
 */
function tgToken_() { return PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN') || ''; }
function tgCall_(method, payload) {
  var tok = tgToken_();
  if (!tok) throw new Error('Telegram is not set up yet. The owner adds the bot token first.');
  var r = UrlFetchApp.fetch('https://api.telegram.org/bot' + tok + '/' + method, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload || {}) });
  var j = JSON.parse(r.getContentText() || '{}');
  if (!j.ok) throw new Error('Telegram: ' + (j.description || 'request failed'));
  return j.result;
}
function sendTelegram_(q, props) {
  if (!tgToken_()) return;
  q.forEach(function (m) {
    m.ids.forEach(function (uid) {
      var chat = props.getProperty('tg_' + String(uid).toLowerCase());
      if (!chat) return;
      try { tgCall_('sendMessage', { chat_id: chat, text: m.title + '\n' + m.body + '\nhttps://stock.iweargroup.com/', disable_web_page_preview: true }); }
      catch (e) { /* a failed notification never blocks stock work */ }
    });
  });
}
/** Run this once from the Apps Script editor (select testTelegram ▸ Run) to give the script permission to contact Telegram. */
function testTelegram() {
  var me = tgCall_('getMe');
  Logger.log('Telegram bot OK: @' + me.username);
  PropertiesService.getScriptProperties().setProperty('TG_BOT_NAME', me.username);
  return me.username;
}
function api_tgStatus(auth) {
  var u = checkUser_(auth), props = PropertiesService.getScriptProperties();
  if (!tgToken_()) return { configured: false };
  var bot = props.getProperty('TG_BOT_NAME');
  if (!bot) { try { bot = tgCall_('getMe').username; props.setProperty('TG_BOT_NAME', bot); } catch (e) { return { configured: false, error: e.message }; } }
  return { configured: true, bot: bot, linked: !!props.getProperty('tg_' + u.id.toLowerCase()) };
}
/** Step 1: a one-time link the user opens in Telegram (t.me/<bot>?start=<code>). */
function api_tgLink(auth) {
  var u = checkUser_(auth), st = api_tgStatus(auth);
  if (!st.configured) throw new Error('Telegram is not set up yet. The owner adds the bot token first.');
  var code = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  CacheService.getScriptCache().put('tgc_' + code, u.id, 900);
  return { url: 'https://t.me/' + st.bot + '?start=' + code, bot: st.bot };
}
/** Step 2: after pressing Start in Telegram, read the bot's new messages and link matching codes. */
function api_tgCheck(auth) {
  var u = checkUser_(auth), props = PropertiesService.getScriptProperties(), cache = CacheService.getScriptCache();
  return withLock_(function () {
    var off = Number(props.getProperty('TG_OFFSET') || 0);
    var ups = tgCall_('getUpdates', { offset: off, timeout: 0, allowed_updates: ['message'] }) || [];
    ups.forEach(function (up) {
      off = Math.max(off, up.update_id + 1);
      var msg = up.message || {}, m = String(msg.text || '').match(/^\/start\s+([0-9a-f]{16})$/);
      if (!m || !msg.chat) return;
      var uid = cache.get('tgc_' + m[1]);
      if (!uid) { try { tgCall_('sendMessage', { chat_id: msg.chat.id, text: 'This link has expired. Open Stock Finder → More → Connect Telegram again.' }); } catch (e) {} return; }
      cache.remove('tgc_' + m[1]);
      props.setProperty('tg_' + uid.toLowerCase(), String(msg.chat.id));
      var who = users_().filter(function (x) { return x.id === uid; })[0];
      try { tgCall_('sendMessage', { chat_id: msg.chat.id, text: 'Connected to Stock Finder as ' + (who ? who.name : uid) + '. You will get approvals and stock alerts here.' }); } catch (e) {}
    });
    props.setProperty('TG_OFFSET', String(off));
    return { linked: !!props.getProperty('tg_' + u.id.toLowerCase()) };
  });
}
function api_tgUnlink(auth) {
  var u = checkUser_(auth);
  PropertiesService.getScriptProperties().deleteProperty('tg_' + u.id.toLowerCase());
  return { linked: false };
}

/* ---------------- read ---------------- */

function getData_() {
  var st = loadStock_();
  var shops = shops_();
  var transit = {}, trs = transfers_();
  trs.forEach(function (t) {
    if (t.status !== 'IN TRANSIT') return;
    var m = transit[t.sku] || (transit[t.sku] = {});
    m[t.to] = (m[t.to] || 0) + t.qty;
  });
  var items = st.rows.filter(function (r) { return r[C.SKU]; }).map(function (r) {
    var q = {};
    shops.forEach(function (s) { q[s.code] = Number(r[st.col[s.code]]) || 0; });
    var sku = String(r[C.SKU]);
    return { sku: sku, brand: String(r[C.BRAND]), model: String(r[C.MODEL]), colour: String(r[C.COLOUR]),
      size: String(r[C.SIZE]), upc: String(r[C.UPC]), desc: String(r[C.DESC]), photo: String(r[C.PHOTO]),
      link: String(r[C.LINK] || ''), cost: costCode(r[C.COST]), rsp: rsp(r[C.COST]), qty: q, transit: transit[sku] || {} };
  });
  // open transfers + the most recent closed ones
  var open = trs.filter(function (t) { return t.status === 'PENDING' || t.status === 'IN TRANSIT'; });
  var closed = trs.filter(function (t) { return t.status !== 'PENDING' && t.status !== 'IN TRANSIT'; }).slice(-60);
  var reqs = requests_(), ropen = reqs.filter(function (r) { return r.status === 'PENDING'; });
  var rclosed = reqs.filter(function (r) { return r.status !== 'PENDING'; }).slice(-80);
  return { shops: shops, items: items, transfers: open.concat(closed), requests: ropen.concat(rclosed), at: new Date().toISOString() };
}

function transfers_() {
  return rows_(sheetOrCreate_(SHEET_TRANSFERS, TR_HEAD), TR_HEAD.length)
    .filter(function (r) { return r[T.ID]; })
    .map(function (r) {
      return { id: String(r[T.ID]), requested: fmt_(r[T.REQ]), from: String(r[T.FROM]), to: String(r[T.TO]),
        sku: String(r[T.SKU]), qty: Number(r[T.QTY]) || 0, status: String(r[T.STATUS]), by: String(r[T.BY]),
        note: String(r[T.NOTE] || ''), approvedBy: String(r[T.APPBY] || ''), approvedAt: fmt_(r[T.APPAT]),
        receivedBy: String(r[T.RCVBY] || ''), receivedAt: fmt_(r[T.RCVAT]) };
    });
}

/* ---------------- API (called from the page) ---------------- */

function api_login(id, pass, device) {
  id = String(id || '').trim(); pass = String(pass || '').trim(); device = String(device || '').slice(0, 200);
  var cache = CacheService.getScriptCache(), fk = failKey_(id);
  var f = JSON.parse(cache.get(fk) || '{"n":0,"until":0}');
  var logins = sheetOrCreate_(SHEET_LOGINS, LOGIN_HEAD);
  if (f.until > Date.now()) {
    var mins = Math.ceil((f.until - Date.now()) / 60000);
    throw new Error('Too many wrong tries. This login is locked for ' + mins + ' more minute' + (mins === 1 ? '' : 's') + '.');
  }
  var u = users_().filter(function (x) { return x.id.toLowerCase() === id.toLowerCase(); })[0];
  if (!u || !u.active || !u.pass || u.pass !== pass) {
    f.n += 1;
    var locked = f.n >= MAX_TRIES;
    if (locked) { f.until = Date.now() + LOCK_MINUTES * 60000; f.n = 0; }
    cache.put(fk, JSON.stringify(f), LOCK_MINUTES * 60 + 60);
    logins.appendRow([new Date(), id.slice(0, 40), u ? u.name : '(unknown ID)', u ? u.shop : '', device, locked ? 'LOCKED ' + LOCK_MINUTES + ' MIN' : 'WRONG PASSWORD']);
    if (locked) throw new Error('Too many wrong tries. This login is locked for ' + LOCK_MINUTES + ' minutes.');
    var left = MAX_TRIES - f.n;
    throw new Error('Wrong user ID or password.' + (left <= 2 ? ' ' + left + ' tr' + (left === 1 ? 'y' : 'ies') + ' left before a ' + LOCK_MINUTES + '-minute lock.' : ''));
  }
  cache.remove(fk);
  var props = PropertiesService.getScriptProperties();
  // tidy expired passes
  var all = props.getProperties(), now = Date.now();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('tok_') !== 0) return;
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('tok_' + hash_(token), JSON.stringify({ uid: u.id, exp: now + PASS_DAYS * 86400000, ph: hash_(u.pass) }));
  logins.appendRow([new Date(), u.id, u.name, u.shop, device, 'OK']);
  var info = userInfo_(u);
  info.token = token;
  return info;
}

/** Ends this login pass (Log out). */
function api_logout(auth) {
  var token = String(auth && auth.token || '');
  if (token) PropertiesService.getScriptProperties().deleteProperty('tok_' + hash_(token));
  return true;
}
function userInfo_(u) { return { id: u.id, name: u.name, shop: u.shop, role: u.admin ? 'Admin' : u.manager ? 'Manager' : 'Staff', adjust: u.adjust, shops: allowedShops_(u), pushId: pushId_(u.id) }; }
function needManager_(u, what) {
  if (!u.admin && !u.manager) throw new Error('Only a Manager or the owner can ' + what + '. Ask your manager.');
}

function api_getData(auth) {
  var u = checkUser_(auth);
  var d = getData_();
  d.user = userInfo_(u);
  if (!u.admin && !u.manager) d.items.forEach(function (it) { it.cost = ''; });   // Staff never receive cost codes
  d.pushApp = PropertiesService.getScriptProperties().getProperty('ONESIGNAL_APP_ID') || '';
  return d;
}

/** End-of-day sales for one shop. */
function api_recordSales(auth, lines, note, shop) {
  var u = checkUser_(auth), code = shopFor_(u, shop);
  lines = cleanLines_(lines);
  if (lines.some(function (l) { return !l.rcpt; })) throw new Error('Receipt number is required for every frame sold.');
  if (!u.admin && !u.manager) return createRequest_(u, code, 'SOLD', lines, note || '');
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      out.push([t, code, 'SOLD', st.rows[i][C.SKU], -l.qty, addQty_(st, i, code, -l.qty), l.rcpt, u.name, note || '']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** New stock arriving at a shop (from a supplier DO). */
function api_receive(auth, lines, ref, shop) {
  var u = checkUser_(auth), code = shopFor_(u, shop);
  needManager_(u, 'record new stock');
  lines = cleanLines_(lines);
  if (!u.admin) return createRequest_(u, code, 'STOCK IN', lines, ref ? 'DO ' + ref : 'New stock');
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      out.push([t, code, 'RECEIVE', st.rows[i][C.SKU], l.qty, addQty_(st, i, code, l.qty), ref || '', u.name, '']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** Step 1: a shop asks to send frames to another shop. Stock does not move yet. */
function api_requestTransfer(auth, toShop, lines, note, shop) {
  var u = checkUser_(auth), from = shopFor_(u, shop);
  needManager_(u, 'request a transfer');
  if (!toShop || toShop === from) throw new Error('Choose a different shop to send to.');
  shopFor_({ admin: true }, toShop);
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date();
    var id = newId_('TR');
    var rows = [];
    lines.forEach(function (l) {
      var i = resolve_(st, l, false);
      if (i < 0) throw new Error('Not in the stock list: ' + (l.sku || l.model));
      rows.push([id, t, from, toShop, st.rows[i][C.SKU], l.qty, 'PENDING', u.name, note || '', '', '', '', '']);
    });
    if (!rows.length) throw new Error('Add at least one frame.');
    var sh = sheetOrCreate_(SHEET_TRANSFERS, TR_HEAD);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, TR_HEAD.length).setValues(rows);
    queuePush_(users_().filter(function (x) { return x.active && x.admin; }), 'Approval needed · transfer',
      u.name + ': ' + from + ' → ' + toShop + ', ' + rows.length + ' line' + (rows.length === 1 ? '' : 's') + ' (' + id + ')');
    return { id: id, lines: rows.length };
  });
}

/** Runs fn on every row of one transfer that has the expected status, then writes the rows back. */
function editTransfer_(id, status, fn) {
  var sh = sheetOrCreate_(SHEET_TRANSFERS, TR_HEAD), v = rows_(sh, TR_HEAD.length), hit = [];
  v.forEach(function (r, i) { if (String(r[T.ID]) === id && String(r[T.STATUS]) === status) hit.push(i); });
  if (!hit.length) throw new Error('Transfer ' + id + ' is no longer ' + status.toLowerCase() + '. Refresh and try again.');
  hit.forEach(function (i) { fn(v[i]); });   // all lines first: any error stops before anything is written
  hit.forEach(function (i) { sh.getRange(i + 2, 1, 1, TR_HEAD.length).setValues([v[i]]); });
  return hit.map(function (i) { return v[i]; });
}

/** Step 2 (owner): approve -> frames leave the sending shop and are in transit; or reject. */
function api_decideTransfer(auth, id, approve) {
  var u = checkAdmin_(auth);
  var tr = transfers_().filter(function (x) { return x.id === id && x.status === 'PENDING'; })[0];
  if (tr) queuePush_(users_().filter(function (x) { return x.name === tr.by; }), 'Transfer ' + (approve ? 'approved' : 'rejected'),
    id + ' ' + tr.from + ' → ' + tr.to + ' ' + (approve ? 'approved' : 'rejected') + ' by ' + u.name);
  return withLock_(function () {
    var t = new Date();
    if (!approve) {
      editTransfer_(id, 'PENDING', function (r) { r[T.STATUS] = 'REJECTED'; r[T.APPBY] = u.name; r[T.APPAT] = t; });
      return { id: id, status: 'REJECTED' };
    }
    var st = loadStock_(), out = [];
    editTransfer_(id, 'PENDING', function (r) {
      var i = st.bySku[String(r[T.SKU])];
      if (i == null) throw new Error('SKU not found: ' + r[T.SKU]);
      var q = Number(r[T.QTY]) || 0;
      out.push([t, r[T.FROM], 'TRANSFER OUT', r[T.SKU], -q, addQty_(st, i, String(r[T.FROM]), -q), id, u.name, 'to ' + r[T.TO] + ' (approved)']);
      r[T.STATUS] = 'IN TRANSIT'; r[T.APPBY] = u.name; r[T.APPAT] = t;
    });
    saveStock_(st); log_(out);
    return { id: id, status: 'IN TRANSIT' };
  });
}

/** Step 3 (receiving shop): frames arrived -> added to the receiving shop. */
function api_receiveTransfer(auth, id) {
  var u = checkUser_(auth);
  needManager_(u, 'confirm a transfer arrived');
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    editTransfer_(id, 'IN TRANSIT', function (r) {
      if (allowedShops_(u).indexOf(String(r[T.TO])) < 0) throw new Error('Only the receiving shop can confirm this transfer.');
      var i = st.bySku[String(r[T.SKU])];
      if (i == null) throw new Error('SKU not found: ' + r[T.SKU]);
      var q = Number(r[T.QTY]) || 0;
      out.push([t, r[T.TO], 'TRANSFER IN', r[T.SKU], q, addQty_(st, i, String(r[T.TO]), q), id, u.name, 'from ' + r[T.FROM]]);
      r[T.STATUS] = 'RECEIVED'; r[T.RCVBY] = u.name; r[T.RCVAT] = t;
    });
    saveStock_(st); log_(out);
    return { id: id, status: 'RECEIVED' };
  });
}

/** The sending shop withdraws a request before it is approved. */
function api_cancelTransfer(auth, id) {
  var u = checkUser_(auth);
  return withLock_(function () {
    editTransfer_(id, 'PENDING', function (r) {
      if (allowedShops_(u).indexOf(String(r[T.FROM])) < 0) throw new Error('Only the sending shop can cancel this request.');
      r[T.STATUS] = 'CANCELLED'; r[T.APPBY] = u.name; r[T.APPAT] = new Date();
    });
    return { id: id, status: 'CANCELLED' };
  });
}

/** Admin: replace one shop's whole stock with a POS export (stock count). */
function api_importShop(auth, shop, lines, fileName) {
  var u = checkAdmin_(auth);
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    var c = st.col[shop];
    if (c == null) throw new Error('Unknown shop ' + shop);
    st.rows.forEach(function (r) { r[c] = 0; });
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      out.push([t, shop, 'IMPORT', st.rows[i][C.SKU], l.qty, addQty_(st, i, shop, l.qty), fileName || '', u.name, 'stock replaced from POS export']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** Reads a scanned / photographed DO with Google Drive OCR. Returns plain text. */
function api_ocr(auth, files, shop) {
  var u = checkUser_(auth), code = shopFor_(u, shop);
  needManager_(u, 'read delivery orders');
  var folder = folder_(SCAN_FOLDER), text = [];
  (files || []).forEach(function (f) {
    var blob = Utilities.newBlob(Utilities.base64Decode(f.b64), f.mime, code + ' ' + f.name);
    folder.createFile(blob); // keep the original scan for checking later
    var doc = Drive.Files.create({ name: 'OCR tmp ' + f.name, mimeType: 'application/vnd.google-apps.document' }, blob, { ocrLanguage: 'en', fields: 'id' });
    try { text.push(DocumentApp.openById(doc.id).getBody().getText()); }
    finally { DriveApp.getFileById(doc.id).setTrashed(true); }
  });
  return { text: text.join('\n') };
}

/** Saves a product photo to Drive and links it to the SKU. */
function api_setPhoto(auth, sku, b64, mime) {
  checkUser_(auth);
  var f = folder_(PHOTO_FOLDER).createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime, sku + '.jpg'));
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var url = 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w800';
  return withLock_(function () {
    var st = loadStock_(), i = st.bySku[sku];
    if (i == null) throw new Error('SKU not found: ' + sku);
    st.sh.getRange(i + 2, C.PHOTO + 1).setValue(url);
    return { photo: url };
  });
}

/** Reads Log rows (oldest first) as objects. */
function logRows_() {
  var sh = sheet_(SHEET_LOG);
  return rows_(sh, LOG_HEAD.length).filter(function (r) { return r[0] !== '' && r[0] != null; }).map(function (r) {
    var t = r[0] instanceof Date ? r[0] : new Date(r[0]);
    return { t: t, time: fmt_(t), shop: String(r[1]), type: String(r[2]), sku: String(r[3]), qty: Number(r[4]) || 0,
      bal: r[5] === '' ? '' : Number(r[5]), ref: String(r[6] || ''), staff: String(r[7] || ''), note: String(r[8] || '') };
  });
}

/**
 * Full activity for one SKU, newest first: every logged movement, transfer requests
 * (pending / rejected / cancelled), and an "Opening stock" line per shop for stock that was
 * there before the first logged movement (e.g. loaded straight from POS reports).
 */
function api_history(auth, sku, limit) {
  checkUser_(auth);
  limit = Math.min(Number(limit) || 25, 2000);
  var log = logRows_().filter(function (x) { return x.sku === sku; });
  var out = log.map(function (x) { return { time: x.time, ts: x.t.getTime() || 0, shop: x.shop, type: x.type, qty: x.qty, bal: x.bal, ref: x.ref, staff: x.staff, note: x.note }; });
  transfers_().forEach(function (t) {
    if (t.sku !== sku) return;
    out.push({ time: t.requested, ts: Date.parse(t.requested) || 0, shop: t.from, type: 'TRANSFER ' + t.status, qty: '', bal: '',
      ref: t.id, staff: t.by, note: 'to ' + t.to + (t.approvedBy ? ' · ' + t.status.toLowerCase() + ' by ' + t.approvedBy : '') + (t.note ? ' · ' + t.note : '') });
  });
  // opening stock: current qty minus everything logged since
  var st = loadStock_(), i = st.bySku[sku];
  if (i != null) {
    shops_().forEach(function (s) {
      var now = Number(st.rows[i][st.col[s.code]]) || 0;
      var moved = log.filter(function (x) { return x.shop === s.code; }).reduce(function (a, x) { return a + x.qty; }, 0);
      var first = log.filter(function (x) { return x.shop === s.code; })[0];
      if (now - moved !== 0) out.push({ time: first ? 'before ' + first.time : 'from POS report', ts: -1, shop: s.code, type: 'OPENING STOCK',
        qty: now - moved, bal: now - moved, ref: '', staff: '', note: 'loaded from POS closing stock report' });
    });
  }
  out.sort(function (a, b) { return b.ts - a.ts; });
  return out.slice(0, limit);
}

/** Only Admins change stock counts directly; Managers request (see api_adjust). */
function canAdjust_(u, shop) { return !!u.admin; }

/**
 * Stock adjustment (stock-take, damaged, found, correction). Each line sets the counted quantity
 * for one SKU at one shop; the difference is logged as ADJUST with the reason.
 */
function api_adjust(auth, shop, lines, reason) {
  var u = checkUser_(auth);
  if (!shops_().some(function (s) { return s.code === shop; })) throw new Error('Unknown shop ' + shop);
  reason = String(reason || '').trim();
  if (!reason) throw new Error('Give a reason for the adjustment.');
  if (!canAdjust_(u, shop)) {
    if (u.manager && allowedShops_(u).indexOf(shop) >= 0) {
      return createRequest_(u, shop, 'ADJUST', (lines || []).filter(function (l) { return l.count !== '' && l.count != null && isFinite(Number(l.count)); })
        .map(function (l) { return { sku: l.sku, model: l.model, colour: l.colour, size: l.size, upc: l.upc, qty: Math.round(Number(l.count)) }; }), reason);
    }
    throw new Error(u.manager ? 'You can only request adjustments for ' + allowedShops_(u).join(', ') + '.' : 'You are not authorised to adjust stock. Ask the owner.');
  }
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    var ref = newId_('ADJ');
    (lines || []).forEach(function (l) {
      var target = Math.round(Number(l.count));
      if (!isFinite(target) || l.count === '' || l.count == null) return;
      var i = resolve_(st, { sku: l.sku, model: l.model, colour: l.colour, size: l.size, upc: l.upc });
      if (i < 0) return;
      var c = st.col[shop], before = Number(st.rows[i][c]) || 0, delta = target - before;
      if (!delta) return;
      st.rows[i][c] = target;
      out.push([t, shop, 'ADJUST', st.rows[i][C.SKU], delta, target, ref, u.name, reason + ' (was ' + before + ')']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length, ref: ref };
  });
}

/* ---------------- stock out + approval requests ---------------- */

/** Stock leaving a shop for reasons other than a sale (return to supplier, damaged, sample ...). */
function api_stockOut(auth, lines, reason, shop) {
  var u = checkUser_(auth), code = shopFor_(u, shop);
  needManager_(u, 'take stock out');
  reason = String(reason || '').trim();
  if (!reason) throw new Error('Give a reason for taking the stock out.');
  lines = cleanLines_(lines);
  if (!u.admin) return createRequest_(u, code, 'STOCK OUT', lines, reason);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    lines.forEach(function (l) {
      var i = resolve_(st, l, false); if (i < 0) return;
      out.push([t, code, 'STOCK OUT', st.rows[i][C.SKU], -l.qty, addQty_(st, i, code, -l.qty), '', u.name, reason]);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** A Manager's request: nothing moves until the owner approves. */
function createRequest_(u, shop, type, lines, reason) {
  if (!lines || !lines.length) throw new Error('Add at least one frame.');
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), rows = [];
    var id = newId_('RQ');
    lines.forEach(function (l) {
      var i = l.sku ? st.bySku[String(l.sku)] : resolve_(st, l, false);
      if (i == null) i = -1;
      var key = i >= 0 ? String(st.rows[i][C.SKU]) : skuKey(l.model, l.colour, l.size);
      if (!key) return;
      if (i < 0 && type !== 'STOCK IN' && type !== 'SOLD') throw new Error('Not in the stock list: ' + key);
      rows.push([id, t, shop, type, key, Number(l.qty) || 0, reason || '', 'PENDING', u.name, '', '',
        JSON.stringify({ uid: u.id, model: l.model || '', colour: l.colour || '', size: l.size || '', upc: l.upc || '', desc: l.desc || '', rcpt: l.rcpt || '' })]);
    });
    if (!rows.length) throw new Error('Add at least one frame.');
    var sh = sheetOrCreate_(SHEET_REQ, REQ_HEAD);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, REQ_HEAD.length).setValues(rows);
    var what = { SOLD: 'Sale', 'STOCK IN': 'Stock in', 'STOCK OUT': 'Stock out', ADJUST: 'Adjustment' }[type] || type;
    queuePush_(users_().filter(function (x) { return x.active && canDecide_(x, type, shop); }), 'Approval needed · ' + shop,
      what + ' by ' + u.name + ': ' + rows.length + ' line' + (rows.length === 1 ? '' : 's') + ' (' + id + ')');
    return { id: id, lines: rows.length, pending: true };
  });
}

function requests_() {
  return rows_(sheetOrCreate_(SHEET_REQ, REQ_HEAD), REQ_HEAD.length)
    .filter(function (r) { return r[R.ID]; })
    .map(function (r) {
      var d = {}; try { d = JSON.parse(r[R.DET] || '{}'); } catch (e) {}
      return { id: String(r[R.ID]), requested: fmt_(r[R.REQ]), shop: String(r[R.SHOP]), type: String(r[R.TYPE]), sku: String(r[R.SKU]),
        qty: Number(r[R.QTY]) || 0, reason: String(r[R.REASON] || ''), status: String(r[R.STATUS]), by: String(r[R.BY]), uid: d.uid || '', rcpt: d.rcpt || '',
        decidedBy: String(r[R.DECBY] || ''), decidedAt: fmt_(r[R.DECAT]) };
    });
}

function editRequest_(id, fn) {
  var sh = sheetOrCreate_(SHEET_REQ, REQ_HEAD), v = rows_(sh, REQ_HEAD.length), hit = [];
  v.forEach(function (r, i) { if (String(r[R.ID]) === id && String(r[R.STATUS]) === 'PENDING') hit.push(i); });
  if (!hit.length) throw new Error('Request ' + id + ' is no longer pending. Refresh and try again.');
  hit.forEach(function (i) { fn(v[i]); });   // all lines first: any error stops before anything is written
  hit.forEach(function (i) { sh.getRange(i + 2, 1, 1, REQ_HEAD.length).setValues([v[i]]); });
}

/** Owner approves (stock moves now) or rejects a Manager's request. */
/** Admins decide every request; a Manager decides Staff sales (SOLD) for the shops they work for. */
function canDecide_(u, type, shop) {
  if (u.admin) return true;
  return u.manager && type === 'SOLD' && allowedShops_(u).indexOf(shop) >= 0;
}
function api_decideRequest(auth, id, approve) {
  var u = checkUser_(auth);
  var mine = requests_().filter(function (r) { return r.id === id && r.status === 'PENDING'; });
  mine.forEach(function (r) {
    if (!canDecide_(u, r.type, r.shop)) throw new Error(u.manager ? 'Only an Admin can approve this request.' : 'Only the owner (Admin) can do this.');
  });
  if (mine.length) queuePush_(users_().filter(function (x) { return x.id === mine[0].uid; }), 'Request ' + (approve ? 'approved' : 'rejected'),
    id + ' (' + mine[0].type.toLowerCase() + ', ' + mine[0].shop + ') ' + (approve ? 'approved' : 'rejected') + ' by ' + u.name);
  return withLock_(function () {
    var t = new Date();
    if (!approve) {
      editRequest_(id, function (r) { r[R.STATUS] = 'REJECTED'; r[R.DECBY] = u.name; r[R.DECAT] = t; });
      return { id: id, status: 'REJECTED' };
    }
    var st = loadStock_(), out = [];
    editRequest_(id, function (r) {
      var d = {}; try { d = JSON.parse(r[R.DET] || '{}'); } catch (e) {}
      var shop = String(r[R.SHOP]), type = String(r[R.TYPE]), q = Number(r[R.QTY]) || 0;
      if (st.col[shop] == null) throw new Error('Unknown shop ' + shop);
      var i = resolve_(st, { sku: r[R.SKU], model: d.model, colour: d.colour, size: d.size, upc: d.upc, desc: d.desc }, type === 'STOCK IN' || type === 'SOLD');
      if (i < 0) throw new Error('SKU not found: ' + r[R.SKU]);
      var who = String(r[R.BY]), note = String(r[R.REASON] || '') + ' · approved by ' + u.name;
      if (type === 'STOCK IN') out.push([t, shop, 'RECEIVE', st.rows[i][C.SKU], q, addQty_(st, i, shop, q), id, who, note]);
      else if (type === 'SOLD') out.push([t, shop, 'SOLD', st.rows[i][C.SKU], -q, addQty_(st, i, shop, -q), d.rcpt || id, who, note]);
      else if (type === 'STOCK OUT') out.push([t, shop, 'STOCK OUT', st.rows[i][C.SKU], -q, addQty_(st, i, shop, -q), id, who, note]);
      else if (type === 'ADJUST') {
        var c = st.col[shop], before = Number(st.rows[i][c]) || 0;
        if (q !== before) { st.rows[i][c] = q; out.push([t, shop, 'ADJUST', st.rows[i][C.SKU], q - before, q, id, who, note + ' (was ' + before + ')']); }
      }
      r[R.STATUS] = 'APPROVED'; r[R.DECBY] = u.name; r[R.DECAT] = t;
    });
    saveStock_(st); log_(out);
    return { id: id, status: 'APPROVED', moved: out.length };
  });
}

/** The requester (or the owner) withdraws a pending request. */
function api_cancelRequest(auth, id) {
  var u = checkUser_(auth);
  return withLock_(function () {
    editRequest_(id, function (r) {
      var d = {}; try { d = JSON.parse(r[R.DET] || '{}'); } catch (e) {}
      if (!u.admin && d.uid !== u.id) throw new Error('Only the person who asked can cancel this request.');
      r[R.STATUS] = 'CANCELLED'; r[R.DECBY] = u.name; r[R.DECAT] = new Date();
    });
    return { id: id, status: 'CANCELLED' };
  });
}

/* ---------------- notifications (owner) ---------------- */

/** Movements by other people since the owner last looked, plus what is waiting for approval. */
function api_notifications(auth) {
  var u = checkUser_(auth);
  if (!u.admin && !u.manager) return { unread: 0, pending: 0, rows: [] };
  var seen = Number(PropertiesService.getScriptProperties().getProperty('seen_' + u.id) || 0);
  var mine = u.name.toLowerCase(), shops = allowedShops_(u);
  var rows = logRows_().filter(function (x) { return x.staff.toLowerCase() !== mine && shops.indexOf(x.shop) >= 0; });
  var unread = rows.filter(function (x) { return x.t.getTime() > seen; }).length;
  var recent = rows.slice(-60).reverse().map(function (x) {
    return { time: x.time, shop: x.shop, type: x.type, sku: x.sku, qty: x.qty, bal: x.bal, staff: x.staff, note: x.note, ref: x.ref, unread: x.t.getTime() > seen };
  });
  var pend = {};
  requests_().forEach(function (r) { if (r.status === 'PENDING' && canDecide_(u, r.type, r.shop)) pend[r.id] = 1; });
  if (u.admin) transfers_().forEach(function (t) { if (t.status === 'PENDING') pend[t.id] = 1; });
  return { unread: unread, pending: Object.keys(pend).length, rows: recent };
}

function api_markSeen(auth) {
  var u = checkUser_(auth);
  PropertiesService.getScriptProperties().setProperty('seen_' + u.id, String(Date.now()));
  return true;
}

/** Activity across SKUs for the Report tab. Staff without adjust rights see only their own shop. */
function api_log(auth, opts) {
  var u = checkUser_(auth);
  opts = opts || {};
  var from = opts.from ? new Date(opts.from + 'T00:00:00') : null, to = opts.to ? new Date(opts.to + 'T23:59:59') : null;
  var shop = opts.shop || '', mine = allowedShops_(u);
  if (shop && mine.indexOf(shop) < 0) shop = u.shop;
  var q = String(opts.q || '').toUpperCase().replace(/\s+/g, ' ').trim();
  var rows = logRows_().filter(function (x) {
    if (from && x.t < from) return false;
    if (to && x.t > to) return false;
    if (shop && x.shop !== shop) return false;
    if (!shop && mine.indexOf(x.shop) < 0) return false;
    if (opts.type && x.type.indexOf(opts.type) !== 0) return false;
    if (q && (x.sku + ' ' + x.staff + ' ' + x.ref + ' ' + x.note).toUpperCase().indexOf(q) < 0) return false;
    return true;
  });
  rows.reverse();
  var lim = Math.min(Number(opts.limit) || 500, 5000);
  return { total: rows.length, rows: rows.slice(0, lim).map(function (x) { delete x.t; return x; }) };
}

function folder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
