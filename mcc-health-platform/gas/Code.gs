/**
 * MCC Health Data Platform — Google Apps Script web app with Google Sheets as the database.
 * Sign-up → admin approval → sign-in, tracker data entry (Maternal Continuum of Care),
 * file uploads (Excel, CSV, Word, PDF) to Drive with rows/text captured in Sheets, admin console.
 *
 * Deploy: Execute as "Me", access "Anyone" (or "Anyone with Google account").
 * Run setup() once from the editor before the first deployment.
 */

var APP_NAME = 'MCC Health Data Platform';
var SESSION_HOURS = 6;
var HASH_ROUNDS = 2000;
var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
var ROLES = ['ADMIN', 'CLINICIAN', 'DATA_ASSOCIATE', 'DISTRICT_VIEWER', 'PARTNER'];
var ENTRY_ROLES = ['ADMIN', 'CLINICIAN', 'DATA_ASSOCIATE'];
var PII_ROLES = ['ADMIN', 'CLINICIAN', 'DATA_ASSOCIATE', 'DISTRICT_VIEWER'];

var SHEETS = {
  Users: ['user_id', 'email', 'name', 'phone', 'org_unit', 'role_requested', 'role', 'status', 'pw_hash', 'salt', 'created_at', 'approved_by', 'approved_at', 'last_login', 'note'],
  OrgUnits: ['code', 'name', 'level', 'parent_code'],
  Persons: ['tei_id', 'umid', 'org_unit', 'created_by', 'created_at', 'updated_by', 'updated_at'],   // + registration attribute codes
  Enrollments: ['enrollment_id', 'tei_id', 'umid', 'org_unit', 'enrollment_date', 'lmp', 'status', 'created_by', 'created_at', 'completed_at'],
  Uploads: ['upload_id', 'file_name', 'mime_type', 'size_bytes', 'format', 'drive_file_id', 'drive_url', 'org_unit', 'period', 'description', 'rows_parsed', 'data_tab', 'events_imported', 'text_excerpt', 'uploaded_by', 'uploaded_at'],
  Audit: ['ts', 'user', 'action', 'entity', 'entity_id', 'detail'],
};
var EVENT_BASE = ['event_id', 'enrollment_id', 'tei_id', 'umid', 'org_unit', 'event_date', 'status', 'created_by', 'created_at', 'updated_by', 'updated_at'];
var PII_COLUMNS = ['MCC_FIRST_NAME', 'MCC_SURNAME', 'MCC_OTHER_NAMES', 'MCC_DOB', 'MCC_NRC', 'MCC_PHONE', 'MCC_SMS_PHONE', 'MCC_NOK_NAME', 'MCC_NOK_PHONE', 'MCC_VILLAGE', 'MCC_ART_NO', 'email', 'phone', 'pw_hash', 'salt'];

// ------------------------------------------------------------------ web entry
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }
function metaJson() { return JSON.stringify(MCC_META); }

// ------------------------------------------------------------------ setup
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = props.getProperty('SPREADSHEET_ID');
    ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create(APP_NAME + ' – Database');
  }
  props.setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(SHEETS).forEach(function (n) { ensureSheet_(ss, n, headersFor_(n)); });
  MCC_META.stages.forEach(function (st) { ensureSheet_(ss, 'EV_' + st.code, headersFor_('EV_' + st.code)); });
  var ou = ss.getSheetByName('OrgUnits');
  if (ou.getLastRow() < 2) {
    ou.getRange(2, 1, 4, 4).setValues([
      ['ZM', 'Zambia', 1, ''],
      ['ZM-EP', 'Eastern Province', 2, 'ZM'],
      ['ZM-EP-LUM', 'Lumezi District', 3, 'ZM-EP'],
      ['LUM-FAC01', 'Facility 01 (rename to a real facility and code)', 4, 'ZM-EP-LUM'],
    ]);
  }
  if (!props.getProperty('UPLOAD_FOLDER_ID')) {
    var folder = DriveApp.createFolder(APP_NAME + ' – Uploads');
    props.setProperty('UPLOAD_FOLDER_ID', folder.getId());
  }
  var owner = Session.getEffectiveUser().getEmail();
  if (!props.getProperty('ADMIN_EMAIL')) props.setProperty('ADMIN_EMAIL', owner);
  var s = ss.getSheetByName('Sheet1'); if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  Logger.log('Database: ' + ss.getUrl());
  Logger.log('Uploads folder: https://drive.google.com/drive/folders/' + props.getProperty('UPLOAD_FOLDER_ID'));
  Logger.log('Admin email (sign up with this address to become admin): ' + props.getProperty('ADMIN_EMAIL'));
}

function headersFor_(name) {
  if (name === 'Persons') {
    var h = SHEETS.Persons.slice();
    MCC_META.registration.forEach(function (s) { s.fields.forEach(function (f) { h.push(f); }); });
    return h;
  }
  if (name.indexOf('EV_') === 0) {
    var st = stage_(name.slice(3)); var e = EVENT_BASE.slice();
    st.sections.forEach(function (s) { s.fields.forEach(function (f) { if (e.indexOf(f) < 0) e.push(f); }); });
    return e;
  }
  return SHEETS[name];
}
function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  var missing = headers.filter(function (h) { return cur.indexOf(h) < 0; });
  var start = cur.filter(String).length + 1, need = start + missing.length - 1;
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  if (missing.length) sh.getRange(1, start, 1, missing.length).setValues([missing]);
  // Plain-text format keeps phone numbers' leading zeros, codes and 'true'/'false' exactly as entered.
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
  return sh;
}

// ------------------------------------------------------------------ sheet helpers
function db_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('The app is not set up yet. The owner must run setup() once.');
  return SpreadsheetApp.openById(id);
}
function sheet_(name) {
  var sh = db_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet ' + name + '. Run setup() again.');
  return sh;
}
function headers_(sh) { return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]; }
function readAll_(name) {
  var sh = sheet_(name); var last = sh.getLastRow();
  if (last < 2) return [];
  var h = headers_(sh);
  return sh.getRange(2, 1, last - 1, h.length).getValues().map(function (row, i) {
    var o = { _row: i + 2 };
    h.forEach(function (k, j) { var v = row[j]; o[k] = v instanceof Date ? isoDate_(v) : (v === true || v === false ? String(v) : v); });
    return o;
  });
}
function safe_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) return "'" + v; // block formula injection
  return v;
}
function append_(name, obj) {
  var sh = sheet_(name); var h = headers_(sh);
  sh.appendRow(h.map(function (k) { return safe_(obj[k]); }));
}
function update_(name, row, obj) {
  var sh = sheet_(name); var h = headers_(sh);
  var cur = sh.getRange(row, 1, 1, h.length).getValues()[0];
  var next = h.map(function (k, j) { return Object.prototype.hasOwnProperty.call(obj, k) ? safe_(obj[k]) : cur[j]; });
  sh.getRange(row, 1, 1, h.length).setValues([next]);
}
function findBy_(name, key, val) {
  var all = readAll_(name);
  for (var i = 0; i < all.length; i++) if (String(all[i][key]) === String(val)) return all[i];
  return null;
}
function now_() { return Utilities.formatDate(new Date(), 'Africa/Lusaka', "yyyy-MM-dd'T'HH:mm:ss"); }
function isoDate_(d) { return Utilities.formatDate(d, 'Africa/Lusaka', 'yyyy-MM-dd'); }
function uuid_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function audit_(user, action, entity, id, detail) {
  try { append_('Audit', { ts: now_(), user: user ? user.email : '', action: action, entity: entity, entity_id: id, detail: String(detail || '').slice(0, 1000) }); } catch (e) {}
}
function stage_(code) {
  for (var i = 0; i < MCC_META.stages.length; i++) if (MCC_META.stages[i].code === code) return MCC_META.stages[i];
  throw new Error('Unknown stage ' + code);
}

// ------------------------------------------------------------------ auth
function hash_(pw, salt) {
  var v = salt + '|' + pw;
  var bytes;
  for (var i = 0; i < HASH_ROUNDS; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, v, Utilities.Charset.UTF_8);
    v = Utilities.base64Encode(bytes) + salt;
  }
  return Utilities.base64Encode(bytes);
}
function signup(p) {
  p = p || {};
  var email = String(p.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (!p.name || String(p.name).trim().length < 3) throw new Error('Enter your full name.');
  if (!p.password || String(p.password).length < 8) throw new Error('Password must be at least 8 characters.');
  if (ROLES.indexOf(p.role) < 0 || p.role === 'ADMIN') p.role = 'CLINICIAN';
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (findBy_('Users', 'email', email)) throw new Error('An account with this email already exists.');
    var salt = uuid_();
    var isOwner = email === String(PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL') || '').toLowerCase();
    var u = {
      user_id: uuid_(), email: email, name: String(p.name).trim(), phone: String(p.phone || ''), org_unit: String(p.org_unit || ''),
      role_requested: p.role, role: isOwner ? 'ADMIN' : '', status: isOwner ? 'APPROVED' : 'PENDING',
      pw_hash: hash_(String(p.password), salt), salt: salt, created_at: now_(), approved_by: isOwner ? 'system (owner)' : '', approved_at: isOwner ? now_() : '',
    };
    append_('Users', u);
    audit_(u, 'SIGNUP', 'user', u.user_id, u.role_requested);
    return { status: u.status };
  } finally { lock.releaseLock(); }
}
function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('fail_' + email) || 0);
  if (fails >= 5) throw new Error('Too many attempts. Try again in 15 minutes.');
  var u = findBy_('Users', 'email', email);
  if (!u || hash_(String(password || ''), u.salt) !== u.pw_hash) {
    cache.put('fail_' + email, String(fails + 1), 900);
    throw new Error('Email or password is incorrect.');
  }
  if (u.status === 'PENDING') throw new Error('Your account is waiting for administrator approval.');
  if (u.status !== 'APPROVED') throw new Error('Your account is ' + String(u.status).toLowerCase() + '. Contact the administrator.');
  cache.remove('fail_' + email);
  var token = Utilities.getUuid();
  cache.put('sess_' + token, u.user_id, SESSION_HOURS * 3600);
  update_('Users', u._row, { last_login: now_() });
  audit_(u, 'LOGIN', 'user', u.user_id, '');
  return { token: token, user: publicUser_(u) };
}
function logout(token) { CacheService.getScriptCache().remove('sess_' + token); return true; }
function publicUser_(u) { return { user_id: u.user_id, email: u.email, name: u.name, role: u.role, org_unit: u.org_unit }; }
function auth_(token, roles) {
  var id = token && CacheService.getScriptCache().get('sess_' + token);
  if (!id) throw new Error('SESSION_EXPIRED');
  var u = findBy_('Users', 'user_id', id);
  if (!u || u.status !== 'APPROVED') throw new Error('SESSION_EXPIRED');
  if (roles && roles.indexOf(u.role) < 0) throw new Error('You do not have permission for this action.');
  CacheService.getScriptCache().put('sess_' + token, id, SESSION_HOURS * 3600);
  return u;
}
function whoami(token) { return publicUser_(auth_(token)); }

// ------------------------------------------------------------------ org units & scope
function orgUnits() { return readAll_('OrgUnits').map(function (o) { return { code: String(o.code), name: o.name, level: o.level, parent_code: String(o.parent_code) }; }); }
function scope_(u) {
  var all = orgUnits();
  if (u.role === 'ADMIN' || !u.org_unit) return u.role === 'ADMIN' ? all.map(function (o) { return o.code; }) : [];
  var out = [String(u.org_unit)], grew = true;
  while (grew) {
    grew = false;
    all.forEach(function (o) { if (out.indexOf(o.parent_code) >= 0 && out.indexOf(o.code) < 0) { out.push(o.code); grew = true; } });
  }
  return out;
}
function myOrgUnits(token) {
  var u = auth_(token); var sc = scope_(u);
  return orgUnits().filter(function (o) { return sc.indexOf(o.code) >= 0; });
}

// ------------------------------------------------------------------ home stats
function homeStats(token) {
  var u = auth_(token); var sc = scope_(u);
  var inScope = function (r) { return sc.indexOf(String(r.org_unit)) >= 0; };
  var month = Utilities.formatDate(new Date(), 'Africa/Lusaka', 'yyyy-MM');
  var events = 0, highRisk = 0;
  MCC_META.stages.forEach(function (st) {
    readAll_('EV_' + st.code).forEach(function (e) {
      if (!inScope(e)) return;
      if (String(e.event_date).slice(0, 7) === month) events++;
    });
  });
  readAll_('EV_ANC1').forEach(function (e) { if (inScope(e) && String(e.MCC_HIGH_RISK) === 'true') highRisk++; });
  var enr = readAll_('Enrollments').filter(inScope);
  return {
    persons: readAll_('Persons').filter(inScope).length,
    activeEnrollments: enr.filter(function (e) { return e.status === 'ACTIVE'; }).length,
    eventsThisMonth: events, highRiskBookings: highRisk,
    uploads: readAll_('Uploads').filter(inScope).length,
    pendingUsers: u.role === 'ADMIN' ? readAll_('Users').filter(function (x) { return x.status === 'PENDING'; }).length : null,
    month: month,
  };
}

// ------------------------------------------------------------------ persons
function stripPii_(u, row) {
  if (PII_ROLES.indexOf(u.role) >= 0) return row;
  var o = {}; Object.keys(row).forEach(function (k) { if (PII_COLUMNS.indexOf(k) < 0) o[k] = row[k]; }); return o;
}
function searchPersons(token, q) {
  var u = auth_(token, PII_ROLES); var sc = scope_(u);
  q = String(q || '').trim().toLowerCase();
  var rows = readAll_('Persons').filter(function (p) { return sc.indexOf(String(p.org_unit)) >= 0 || u.role === 'ADMIN'; });
  if (q) rows = rows.filter(function (p) {
    return [p.umid, p.MCC_FIRST_NAME, p.MCC_SURNAME, p.MCC_PHONE, p.MCC_NRC, p.MCC_ANC_REG_NO, p.MCC_VILLAGE]
      .some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
  });
  audit_(u, 'SEARCH', 'person', '', q);
  return rows.slice(0, 50).map(function (p) { delete p._row; return p; });
}
function duplicateCheck(token, p) {
  auth_(token, ENTRY_ROLES);
  var fn = String(p.MCC_FIRST_NAME || '').toLowerCase(), sn = String(p.MCC_SURNAME || '').toLowerCase();
  return readAll_('Persons').map(function (x) {
    var score = 0;
    if (fn && String(x.MCC_FIRST_NAME).toLowerCase() === fn) score += 2;
    if (sn && String(x.MCC_SURNAME).toLowerCase() === sn) score += 2;
    if (p.MCC_DOB && String(x.MCC_DOB) === String(p.MCC_DOB)) score += 2;
    if (p.MCC_PHONE && String(x.MCC_PHONE) === String(p.MCC_PHONE)) score += 3;
    if (p.MCC_NRC && String(x.MCC_NRC) === String(p.MCC_NRC)) score += 5;
    if (p.MCC_VILLAGE && String(x.MCC_VILLAGE).toLowerCase() === String(p.MCC_VILLAGE).toLowerCase()) score += 1;
    return { score: score, tei_id: x.tei_id, umid: x.umid, name: x.MCC_FIRST_NAME + ' ' + x.MCC_SURNAME, dob: x.MCC_DOB, village: x.MCC_VILLAGE, org_unit: x.org_unit };
  }).filter(function (x) { return x.score >= 5; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 10);
}
function nextUmid_(orgUnit) {
  var props = PropertiesService.getScriptProperties();
  var year = Utilities.formatDate(new Date(), 'Africa/Lusaka', 'yyyy');
  var key = 'SEQ_' + orgUnit + '_' + year;
  var n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return orgUnit + '-' + year + '-' + ('00000' + n).slice(-5);
}
function savePerson(token, p) {
  var u = auth_(token, ENTRY_ROLES);
  var values = p.values || {};
  var sc = scope_(u);
  if (sc.indexOf(String(p.org_unit)) < 0) throw new Error('Choose a facility in your assignment.');
  checkMandatory_(MCC_META.registration, values);
  if (values.MCC_NRC && !/^[0-9]{6}\/[0-9]{2}\/[0-9]$/.test(values.MCC_NRC)) throw new Error('NRC must look like 123456/78/1.');
  if (values.MCC_CONSENT_DATA !== 'true') throw new Error('Record that the client was informed of data use before saving.');
  values.MCC_SMS_PHONE = values.MCC_CONSENT_SMS === 'true' ? (values.MCC_PHONE || '') : '';
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (p.tei_id) {
      var cur = findBy_('Persons', 'tei_id', p.tei_id);
      if (!cur) throw new Error('Person not found.');
      var upd = Object.assign({}, values, { updated_by: u.email, updated_at: now_() });
      delete upd.MCC_UMID;
      update_('Persons', cur._row, upd);
      audit_(u, 'UPDATE', 'person', p.tei_id, '');
      return findBy_('Persons', 'tei_id', p.tei_id);
    }
    var row = Object.assign({}, values, { tei_id: uuid_(), org_unit: p.org_unit, created_by: u.email, created_at: now_() });
    row.umid = row.MCC_UMID = nextUmid_(p.org_unit);
    append_('Persons', row);
    audit_(u, 'CREATE', 'person', row.tei_id, row.umid);
    return row;
  } finally { lock.releaseLock(); }
}
function getPerson(token, teiId) {
  var u = auth_(token, PII_ROLES);
  var p = findBy_('Persons', 'tei_id', teiId);
  if (!p) throw new Error('Person not found.');
  if (u.role !== 'ADMIN' && scope_(u).indexOf(String(p.org_unit)) < 0) audit_(u, 'BREAK_GLASS', 'person', teiId, 'opened outside assignment');
  var enr = readAll_('Enrollments').filter(function (e) { return e.tei_id === teiId; });
  var events = [];
  MCC_META.stages.forEach(function (st) {
    readAll_('EV_' + st.code).forEach(function (e) { if (e.tei_id === teiId) { e.stage = st.code; delete e._row; events.push(e); } });
  });
  audit_(u, 'READ', 'person', teiId, '');
  delete p._row; enr.forEach(function (e) { delete e._row; });
  return { person: p, enrollments: enr, events: events };
}
function enroll(token, teiId, p) {
  var u = auth_(token, ENTRY_ROLES);
  var person = findBy_('Persons', 'tei_id', teiId);
  if (!person) throw new Error('Person not found.');
  if (!p.enrollment_date || !p.lmp) throw new Error('Enrollment date and date of LMP are required.');
  if (p.lmp > p.enrollment_date) throw new Error('LMP cannot be after the booking date.');
  var gaDays = (new Date(p.enrollment_date) - new Date(p.lmp)) / 86400000;
  if (gaDays > 44 * 7) throw new Error('LMP gives an impossible gestational age at booking.');
  if (readAll_('Enrollments').some(function (e) { return e.tei_id === teiId && e.status === 'ACTIVE'; }))
    throw new Error('She already has an active pregnancy. Complete it (Exit stage) before enrolling a new one.');
  var e = { enrollment_id: uuid_(), tei_id: teiId, umid: person.umid, org_unit: p.org_unit || person.org_unit, enrollment_date: p.enrollment_date, lmp: p.lmp, status: 'ACTIVE', created_by: u.email, created_at: now_() };
  append_('Enrollments', e);
  var edd = isoDate_(new Date(new Date(p.lmp).getTime() + 280 * 86400000));
  update_('Persons', person._row, { MCC_CUR_EDD: edd });
  audit_(u, 'CREATE', 'enrollment', e.enrollment_id, person.umid);
  return e;
}
function checkMandatory_(sections, values) {
  var missing = [];
  sections.forEach(function (s) {
    s.fields.forEach(function (f) {
      var m = MCC_META.fields[f];
      if (m.mand === 'Yes' && (values[f] === undefined || values[f] === '' || values[f] === null) && values['__hidden_' + f] !== true) missing.push(m.name);
    });
  });
  if (missing.length) throw new Error('Required: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? '…' : ''));
}
function saveEvent(token, ev) {
  var u = auth_(token, ENTRY_ROLES);
  var st = stage_(ev.stage);
  var enr = findBy_('Enrollments', 'enrollment_id', ev.enrollment_id);
  if (!enr) throw new Error('Enrollment not found.');
  if (enr.status !== 'ACTIVE' && !ev.event_id) throw new Error('This pregnancy is closed.');
  if (!ev.event_date) throw new Error('Event date is required.');
  if (ev.event_date > isoDate_(new Date())) throw new Error('Event date cannot be in the future.');
  if (ev.event_date < String(enr.lmp)) throw new Error('Event date is before the LMP.');
  var values = ev.values || {};
  (ev.hidden || []).forEach(function (f) { values['__hidden_' + f] = true; delete values[f]; });
  if (ev.status === 'COMPLETED') checkMandatory_(st.sections, values);
  Object.keys(values).forEach(function (k) { if (k.indexOf('__hidden_') === 0) delete values[k]; });
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var name = 'EV_' + st.code;
    if (!st.repeatable && !ev.event_id) {
      var exists = readAll_(name).some(function (e) { return e.enrollment_id === ev.enrollment_id; });
      if (exists) throw new Error(st.name + ' already exists for this pregnancy.');
    }
    var row = Object.assign({}, values, { enrollment_id: enr.enrollment_id, tei_id: enr.tei_id, umid: enr.umid, org_unit: ev.org_unit || enr.org_unit,
      event_date: ev.event_date, status: ev.status || 'ACTIVE', updated_by: u.email, updated_at: now_() });
    if (ev.event_id) {
      var cur = findBy_(name, 'event_id', ev.event_id);
      if (!cur) throw new Error('Event not found.');
      update_(name, cur._row, row);
      audit_(u, 'UPDATE', name, ev.event_id, '');
    } else {
      row.event_id = uuid_(); row.created_by = u.email; row.created_at = now_();
      append_(name, row);
      audit_(u, 'CREATE', name, row.event_id, enr.umid);
    }
    if (st.code === 'EXIT' && row.status === 'COMPLETED') {
      update_('Enrollments', enr._row, { status: 'COMPLETED', completed_at: now_() });
    }
    return row;
  } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------------ uploads
function uploadFile(token, f) {
  var u = auth_(token, ENTRY_ROLES);
  if (!f || !f.b64) throw new Error('No file received.');
  var bytes = Utilities.base64Decode(f.b64);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('File is larger than 10 MB.');
  var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('UPLOAD_FOLDER_ID'));
  var id = uuid_();
  var blob = Utilities.newBlob(bytes, f.mime || 'application/octet-stream', id + '_' + String(f.name).replace(/[^\w.\- ]/g, '_'));
  var file = folder.createFile(blob);
  var rec = { upload_id: id, file_name: f.name, mime_type: f.mime, size_bytes: bytes.length, format: f.format, drive_file_id: file.getId(), drive_url: file.getUrl(),
    org_unit: f.org_unit, period: f.period, description: f.description, rows_parsed: 0, data_tab: '', events_imported: 0,
    text_excerpt: String(f.text || '').slice(0, 45000), uploaded_by: u.email, uploaded_at: now_() };
  if (f.rows && f.rows.length) {
    var tab = 'UPL_' + id.slice(0, 8);
    var ss = db_(); var sh = ss.insertSheet(tab);
    var width = Math.max(1, f.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0));
    var grid = f.rows.slice(0, 20001).map(function (r) { var x = r.map(safe_); while (x.length < width) x.push(''); return x; });
    if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    if (sh.getMaxRows() < grid.length) sh.insertRowsAfter(sh.getMaxRows(), grid.length - sh.getMaxRows());
    sh.getRange(1, 1, grid.length, width).setNumberFormat('@').setValues(grid);
    sh.setFrozenRows(1); sh.getRange(1, 1, 1, width).setFontWeight('bold');
    rec.rows_parsed = grid.length - 1; rec.data_tab = tab;
    if (f.importStage) rec.events_imported = importEvents_(u, f.importStage, grid);
  }
  append_('Uploads', rec);
  audit_(u, 'UPLOAD', 'file', id, f.name + ' (' + f.format + ')');
  return rec;
}
/** Rows with headers umid, event_date, [status] and data element codes become events in the matching stage. */
function importEvents_(u, stageCode, grid) {
  var st = stage_(stageCode);
  var h = grid[0].map(function (x) { return String(x).trim(); });
  var iU = h.indexOf('umid'), iD = h.indexOf('event_date');
  if (iU < 0 || iD < 0) throw new Error('To import as events the sheet needs the columns umid and event_date (download the template).');
  var allowed = {}; st.sections.forEach(function (s) { s.fields.forEach(function (f) { allowed[f] = true; }); });
  var enr = readAll_('Enrollments').filter(function (e) { return e.status === 'ACTIVE'; });
  var n = 0, sc = scope_(u);
  grid.slice(1).forEach(function (r) {
    var umid = String(r[iU] || '').trim(); if (!umid) return;
    var e = enr.filter(function (x) { return x.umid === umid; })[0];
    if (!e || sc.indexOf(String(e.org_unit)) < 0) return;
    var d = r[iD] instanceof Date ? isoDate_(r[iD]) : String(r[iD]).slice(0, 10);
    var vals = {}; h.forEach(function (k, j) { if (allowed[k] && r[j] !== '' && r[j] !== null) vals[k] = r[j]; });
    var row = Object.assign(vals, { event_id: uuid_(), enrollment_id: e.enrollment_id, tei_id: e.tei_id, umid: umid, org_unit: e.org_unit, event_date: d,
      status: 'ACTIVE', created_by: u.email + ' (upload)', created_at: now_(), updated_by: u.email, updated_at: now_() });
    append_('EV_' + st.code, row); n++;
  });
  return n;
}
function listUploads(token) {
  var u = auth_(token); var sc = scope_(u);
  return readAll_('Uploads').filter(function (r) { return u.role === 'ADMIN' || sc.indexOf(String(r.org_unit)) >= 0; })
    .map(function (r) { delete r._row; r.text_excerpt = String(r.text_excerpt).slice(0, 300); return r; }).reverse();
}

// ------------------------------------------------------------------ data browser
function listTables(token) {
  var u = auth_(token);
  var names = db_().getSheets().map(function (s) { return s.getName(); });
  return names.filter(function (n) {
    if (u.role === 'ADMIN') return true;
    if (n === 'Users' || n === 'Audit') return false;
    return true;
  });
}
function browse(token, name, q, offset, limit) {
  var u = auth_(token);
  if ((name === 'Users' || name === 'Audit') && u.role !== 'ADMIN') throw new Error('Admins only.');
  var sh = sheet_(name); var h = headers_(sh).filter(String);
  var rows = readAll_(name);
  var sc = scope_(u);
  if (u.role !== 'ADMIN' && h.indexOf('org_unit') >= 0) rows = rows.filter(function (r) { return sc.indexOf(String(r.org_unit)) >= 0; });
  var cols = h.filter(function (c) { return (c !== 'pw_hash' && c !== 'salt') && (PII_ROLES.indexOf(u.role) >= 0 || PII_COLUMNS.indexOf(c) < 0); });
  q = String(q || '').toLowerCase();
  if (q) rows = rows.filter(function (r) { return cols.some(function (c) { return String(r[c]).toLowerCase().indexOf(q) >= 0; }); });
  offset = Number(offset || 0); limit = Math.min(Number(limit || 100), 5000);
  audit_(u, 'BROWSE', 'sheet', name, q);
  return { columns: cols, total: rows.length, offset: offset,
    rows: rows.slice(offset, offset + limit).map(function (r) { return cols.map(function (c) { return r[c] === undefined ? '' : String(r[c]); }); }) };
}

// ------------------------------------------------------------------ admin
function adminUsers(token) {
  auth_(token, ['ADMIN']);
  return readAll_('Users').map(function (x) { delete x._row; delete x.pw_hash; delete x.salt; return x; }).reverse();
}
function adminUpdateUser(token, userId, ch) {
  var a = auth_(token, ['ADMIN']);
  var x = findBy_('Users', 'user_id', userId);
  if (!x) throw new Error('User not found.');
  var upd = {};
  if (ch.status) {
    if (['APPROVED', 'REJECTED', 'DISABLED', 'PENDING'].indexOf(ch.status) < 0) throw new Error('Bad status');
    if (x.user_id === a.user_id && ch.status !== 'APPROVED') throw new Error('You cannot disable your own account.');
    upd.status = ch.status;
    if (ch.status === 'APPROVED') { upd.approved_by = a.email; upd.approved_at = now_(); if (!x.role && !ch.role) upd.role = x.role_requested || 'CLINICIAN'; }
  }
  if (ch.role) { if (ROLES.indexOf(ch.role) < 0) throw new Error('Bad role'); upd.role = ch.role; }
  if (ch.org_unit !== undefined) upd.org_unit = ch.org_unit;
  if (ch.password) {
    if (String(ch.password).length < 8) throw new Error('Password must be at least 8 characters.');
    upd.salt = uuid_(); upd.pw_hash = hash_(String(ch.password), upd.salt);
  }
  update_('Users', x._row, upd);
  audit_(a, 'ADMIN_UPDATE', 'user', userId, JSON.stringify({ status: upd.status, role: upd.role, org_unit: upd.org_unit, password_reset: !!ch.password }));
  if (upd.status && upd.status !== 'PENDING') notifyUser_(x.email, upd.status);
  return true;
}
function notifyUser_(email, status) {
  try {
    var url = ScriptApp.getService().getUrl();
    MailApp.sendEmail(email, APP_NAME + ': account ' + status.toLowerCase(),
      'Your ' + APP_NAME + ' account is now ' + status.toLowerCase() + '.' + (status === 'APPROVED' ? '\n\nSign in: ' + url : ''));
  } catch (e) { /* email quota or permissions: approval still stands */ }
}
function adminAddOrgUnit(token, o) {
  var a = auth_(token, ['ADMIN']);
  if (!o.code || !o.name) throw new Error('Code and name are required.');
  if (findBy_('OrgUnits', 'code', o.code)) throw new Error('That code already exists.');
  append_('OrgUnits', { code: String(o.code).trim(), name: o.name, level: Number(o.level || 4), parent_code: o.parent_code || '' });
  audit_(a, 'CREATE', 'org_unit', o.code, o.name);
  return orgUnits();
}
function adminLinks(token) {
  auth_(token, ['ADMIN']);
  var p = PropertiesService.getScriptProperties();
  return { sheet: db_().getUrl(), folder: 'https://drive.google.com/drive/folders/' + p.getProperty('UPLOAD_FOLDER_ID') };
}
