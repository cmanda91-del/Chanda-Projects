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
  Submissions: ['received_at', 'instance_id', 'form', 'facility', 'umid', 'status', 'message', 'payload'],
  Audit: ['ts', 'user', 'action', 'entity', 'entity_id', 'detail'],
};
var EVENT_BASE = ['event_id', 'enrollment_id', 'tei_id', 'umid', 'org_unit', 'event_date', 'status', 'created_by', 'created_at', 'updated_by', 'updated_at'];
var PII_COLUMNS = ['MCC_FIRST_NAME', 'MCC_SURNAME', 'MCC_OTHER_NAMES', 'MCC_DOB', 'MCC_NRC', 'MCC_HIV_STATUS', 'MCC_ART_NO', 'payload', 'MCC_PHONE', 'MCC_SMS_PHONE', 'MCC_NOK_NAME', 'MCC_NOK_PHONE', 'MCC_VILLAGE', 'MCC_ART_NO', 'email', 'phone', 'pw_hash', 'salt'];

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
    return [p.umid, p.MCC_FIRST_NAME, p.MCC_SURNAME, p.MCC_PHONE, p.MCC_ANC_REG_NO, p.MCC_VILLAGE, p.MCC_FIRST_ANC_DATE]
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
    if (p.MCC_FIRST_ANC_DATE && String(x.MCC_FIRST_ANC_DATE) === String(p.MCC_FIRST_ANC_DATE) && String(x.org_unit) === String(p.org_unit || x.org_unit)) score += 3;
    if (p.MCC_VILLAGE && String(x.MCC_VILLAGE).toLowerCase() === String(p.MCC_VILLAGE).toLowerCase()) score += 1;
    return { score: score, tei_id: x.tei_id, umid: x.umid, name: x.MCC_FIRST_NAME + ' ' + x.MCC_SURNAME, dob: x.MCC_DOB, village: x.MCC_VILLAGE, org_unit: x.org_unit };
  }).filter(function (x) { return x.score >= 5; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 10);
}
/** Age in completed years on a date (DOB as YYYY-MM-DD). */
function ageAt_(dob, on) {
  if (!dob || !on) return '';
  var b = new Date(String(dob).slice(0, 10)), d = new Date(String(on).slice(0, 10));
  var a = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a--;
  return a;
}
/** Unique ID from the three identifying parameters: FACILITY-YYMMDD(first ANC)-AGE-NN, e.g. LUM-FAC01-261013-24-01. */
function nextUmid_(orgUnit, firstAnc, age) {
  var props = PropertiesService.getScriptProperties();
  var d = String(firstAnc).slice(2, 10).replace(/-/g, '');
  var stem = orgUnit + '-' + d + '-' + ('0' + age).slice(-2);
  var key = 'SEQ_' + stem;
  var n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return stem + '-' + ('0' + n).slice(-2);
}
function savePerson(token, p) { return savePerson_(auth_(token, ENTRY_ROLES), p); }
function savePerson_(u, p) {
  var values = p.values || {};
  var sc = scope_(u);
  if (sc.indexOf(String(p.org_unit)) < 0) throw new Error(u.role === 'ADMIN' ? 'Unknown facility code: ' + p.org_unit : 'Choose a facility in your assignment.');
  checkMandatory_(MCC_META.registration, values);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(values.MCC_FIRST_ANC_DATE || ''))) throw new Error('Enter the date of her first ANC visit.');
  if (values.MCC_FIRST_ANC_DATE > isoDate_(new Date())) throw new Error('Date of first ANC cannot be in the future.');
  var age = ageAt_(values.MCC_DOB, values.MCC_FIRST_ANC_DATE);
  if (age === '' || age < 10 || age > 55) throw new Error('Check the age: it must be 10–55 years at the first ANC visit.');
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
    row.umid = row.MCC_UMID = nextUmid_(p.org_unit, values.MCC_FIRST_ANC_DATE, age);
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
  return { person: p, enrollments: enr, events: events, uploads: uploadsForPerson_(p) };
}
function enroll(token, teiId, p) { return enroll_(auth_(token, ENTRY_ROLES), teiId, p); }
function enroll_(u, teiId, p) {
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
function saveEvent(token, ev) { return saveEvent_(auth_(token, ENTRY_ROLES), ev); }
function saveEvent_(u, ev) {
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
  var h = grid[0].map(function (x) { return String(x).trim().split('/').pop(); }); // KoBo/ODK exports prefix group names
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


// ------------------------------------------------------------------ client lookup (prefill for continuum of care)
function personSummary_(p, enrolls, facilities) {
  var act = enrolls.filter(function (e) { return e.tei_id === p.tei_id && e.status === 'ACTIVE'; })[0];
  var out = { tei_id: p.tei_id, umid: p.umid, name: [p.MCC_FIRST_NAME, p.MCC_OTHER_NAMES, p.MCC_SURNAME].filter(String).join(' '),
    dob: p.MCC_DOB, age: ageAt_(p.MCC_DOB, p.MCC_FIRST_ANC_DATE), first_anc: p.MCC_FIRST_ANC_DATE, village: p.MCC_VILLAGE, zone: p.MCC_ZONE, phone: p.MCC_PHONE,
    anc_reg_no: p.MCC_ANC_REG_NO, facility: p.org_unit, facility_name: facilities[p.org_unit] || p.org_unit,
    pregnancies: enrolls.filter(function (e) { return e.tei_id === p.tei_id; }).length, active: null };
  if (act) {
    var last = null;
    MCC_META.stages.forEach(function (st) {
      readAll_('EV_' + st.code).forEach(function (e) {
        if (e.enrollment_id === act.enrollment_id && (!last || String(e.event_date) > String(last.date))) last = { date: e.event_date, stage: st.name, risk: e.MCC_HIGH_RISK, reasons: e.MCC_RISK_REASONS, next: e.MCC_NEXT_APPT };
      });
    });
    out.active = { enrollment_id: act.enrollment_id, lmp: act.lmp, edd: isoDate_(new Date(new Date(act.lmp).getTime() + 280 * 86400000)),
      booked: act.enrollment_date, facility: act.org_unit, last: last };
  }
  return out;
}
/** Find existing clients by facility + age + date of first ANC, UMID, phone or name so forms can reuse their identifiers. Audited. */
function lookupClient(token, q) {
  var u = auth_(token, PII_ROLES);
  q = q || {};
  var fac0 = String(q.facility || ''), age0 = q.age === '' || q.age === undefined ? NaN : Number(q.age), anc0 = String(q.first_anc || '').slice(0, 10);
  var params = fac0 && !isNaN(age0) && /^\d{4}-\d{2}-\d{2}$/.test(anc0);
  var umid = String(q.umid || '').trim().toUpperCase(), phone = String(q.phone || '').replace(/\D/g, '');
  var fn = String(q.first || '').trim().toLowerCase(), sn = String(q.surname || '').trim().toLowerCase();
  if (!params && !umid && phone.length < 9 && (fn.length < 2 || sn.length < 2)) return [];
  var people = readAll_('Persons'), enrolls = readAll_('Enrollments');
  var fac = {}; orgUnits().forEach(function (o) { fac[o.code] = o.name; });
  var hits = people.map(function (p) {
    var why = '';
    if (umid && String(p.umid).toUpperCase() === umid) why = 'UMID';
    else if (params && String(p.org_unit) === fac0 && String(p.MCC_FIRST_ANC_DATE).slice(0, 10) === anc0 && Math.abs(Number(ageAt_(p.MCC_DOB, p.MCC_FIRST_ANC_DATE)) - age0) <= 1) why = 'Facility, age and first ANC';
    else if (umid && String(p.umid).toUpperCase() === umid) why = 'UMID';
    else if (phone.length >= 9 && String(p.MCC_PHONE).replace(/\D/g, '').slice(-9) === phone.slice(-9)) why = 'Phone';
    else if (fn.length >= 2 && sn.length >= 2 && String(p.MCC_FIRST_NAME).toLowerCase().indexOf(fn) === 0 && String(p.MCC_SURNAME).toLowerCase().indexOf(sn) === 0) why = 'Name';
    return why ? { p: p, why: why } : null;
  }).filter(Boolean).slice(0, 8);
  audit_(u, 'LOOKUP', 'person', '', JSON.stringify({ params: params ? fac0 + ' ' + age0 + ' ' + anc0 : '', umid: umid, name: fn && sn ? fn + ' ' + sn : '', hits: hits.length }));
  return hits.map(function (h) { var o = personSummary_(h.p, enrolls, fac); o.match = h.why; return o; });
}

// ------------------------------------------------------------------ KoBo / ODK
var ODK_RELEVANT = {
  MCC_US_DATE: "${MCC_DATING_METHOD}='US_LT24' or ${MCC_DATING_METHOD}='US_GE24'", MCC_US_GA_WK: "${MCC_DATING_METHOD}='US_LT24' or ${MCC_DATING_METHOD}='US_GE24'",
  MCC_HB: "${MCC_HB_STATUS}='DONE'", MCC_BPG_DOSE: "${MCC_SYPH_RESULT}='REACTIVE'", MCC_SYPH_PARTNER_TX: "${MCC_SYPH_RESULT}='REACTIVE'",
  MCC_SYPH_TEST_TYPE: "${MCC_SYPH_RESULT}='REACTIVE' or ${MCC_SYPH_RESULT}='NON_REACTIVE'",
  MCC_HIV_TEST_TYPE: "${MCC_HIV_RESULT}!='' and ${MCC_HIV_RESULT}!='KNOWN_POS'",
  MCC_DEWORM: "${MCC_GA_WK}>=13", MCC_FHR: "${MCC_GA_WK}>=20", MCC_FETAL_MOVEMENTS: "${MCC_GA_WK}>=20", MCC_PRESENTATION: "${MCC_GA_WK}>=28",
  MCC_TD_PRIOR_LAST: "${MCC_TD_PRIOR}>0", MCC_IPTP_DOT: "${MCC_IPTP_STATUS}='GIVEN'",
  MCC_SUPP_REGIMEN: "${MCC_SUPP_PRODUCT}='IFA' or ${MCC_SUPP_PRODUCT}='MMS' or ${MCC_SUPP_PRODUCT}='FA_ONLY'",
  MCC_SUPP_TABS: "${MCC_SUPP_PRODUCT}='IFA' or ${MCC_SUPP_PRODUCT}='MMS' or ${MCC_SUPP_PRODUCT}='FA_ONLY'", MCC_SUPP_DAYS: "${MCC_SUPP_TABS}!=''",
  MCC_REF_TO: "${MCC_REFERRED}='true'", MCC_REF_REASON: "${MCC_REFERRED}='true'", MCC_REF_FEEDBACK: "${MCC_REFERRED}='true'",
  MCC_REF_FROM: "${MCC_FU_TYPE}='REFERRAL_IN' or ${MCC_FU_TYPE}='TRANSFER_IN'", MCC_REF_URGENCY: "${MCC_FU_TYPE}='REFERRAL_OUT'",
  MCC_BBA: "${MCC_DEL_PLACE}='HOME' or ${MCC_DEL_PLACE}='EN_ROUTE'", MCC_PARTOGRAPH: "${MCC_DEL_PLACE}='THIS_FACILITY'",
  MCC_MGSO4: "selected(${MCC_DEL_COMPLICATIONS},'ECLAMPSIA') or selected(${MCC_DEL_COMPLICATIONS},'SEVERE_PE')", MCC_TXA: "selected(${MCC_DEL_COMPLICATIONS},'PPH')",
  MCC_MAT_DEATH_DATE: "${MCC_MAT_OUTCOME}='DIED'", MCC_MAT_DEATH_CAUSE: "${MCC_MAT_OUTCOME}='DIED'", MCC_MDSR_NOTIFIED: "${MCC_MAT_OUTCOME}='DIED'",
  MCC_FP_METHOD: "${MCC_FP_COUNSELLED}='true'", MCC_HV_RETURN_DATE: "${MCC_HV_RETURNED}='true'",
  MCC_EXIT_TRANSFER_TO: "${MCC_EXIT_OUTCOME}='TRANSFERRED_OUT'", MCC_EXIT_LAST_SEEN: "${MCC_EXIT_OUTCOME}='LTFU'",
  MCC_MH_SCORE: "${MCC_MH_TOOL}!=''", MCC_US_FINDINGS: "${MCC_US_DONE}='true'",
};
var ODK_RELEVANT_REF = {
  MCC_REFERRED: "${MCC_FU_TYPE}!='HOME_VISIT'", MCC_REF_TO: "${MCC_FU_TYPE}='REFERRAL_OUT' or ${MCC_FU_TYPE}='TRANSFER_OUT'",
  MCC_REF_REASON: "${MCC_FU_TYPE}!='' and ${MCC_FU_TYPE}!='HOME_VISIT'", MCC_REF_FEEDBACK: "${MCC_FU_TYPE}='REFERRAL_OUT'",
};
var ODK_SECTION_RELEVANT = {
  'C2 Calcium': 'false()', 'C3 IPTp-SP': '${MCC_GA_WK}>=13', 'C6 HIV care (PMTCT)': "${MCC_HIV_RESULT}='POS' or ${MCC_HIV_RESULT}='KNOWN_POS'",
  'D6 Baby 2': '${MCC_N_BABIES}>=2', 'D6 Baby 3': '${MCC_N_BABIES}>=3', 'G2 Home visit': "${MCC_FU_TYPE}='HOME_VISIT'",
};
var ODK_CONSTRAINT = {
  MCC_WEIGHT: ['. >= 30 and . <= 150', 'Weight must be 30–150 kg'], MCC_HEIGHT: ['. >= 120 and . <= 200', 'Height must be 120–200 cm'],
  MCC_MUAC: ['. >= 12 and . <= 45', 'MUAC must be 12–45 cm'], MCC_BP_SYS: ['. >= 60 and . <= 260', 'Systolic 60–260'],
  MCC_BP_DIA: ['. >= 30 and . <= 160 and . < ${MCC_BP_SYS}', 'Diastolic 30–160 and below systolic'], MCC_HB: ['. >= 3 and . <= 20', 'Hb must be 3–20 g/dL'],
  MCC_PARITY: ['. < ${MCC_GRAVIDA}', 'Parity must be lower than gravida'], MCC_FHR: ['. >= 60 and . <= 220', 'Check FHR'],
  MCC_FIRST_ANC_DATE: ['. <= today()', 'Cannot be in the future'], MCC_N_BABIES: ['. >= 1 and . <= 3', '1 to 3 babies'],
  MCC_TEMP: ['. >= 34 and . <= 43', 'Check temperature'],
};
function odkType_(f, m) {
  var vt = m.vt;
  if (m.os) return (vt === 'MULTI_TEXT' ? 'select_multiple ' : 'select_one ') + m.os;
  return { BOOLEAN: 'select_one yes_no', TRUE_ONLY: 'select_one yes_only', DATE: 'date', AGE: 'date', DATETIME: 'dateTime', NUMBER: 'decimal',
    INTEGER: 'integer', INTEGER_POSITIVE: 'integer', INTEGER_ZERO_OR_POSITIVE: 'integer', LONG_TEXT: 'text', PHONE_NUMBER: 'text', ORGANISATION_UNIT: 'text' }[vt] || 'text';
}
var ODK_CALC = {
  MCC_EDD: "if(${MCC_DATING_METHOD}='LMP' or ${MCC_DATING_METHOD}='SFH', format-date(decimal-date-time(${lmp_used}) + 280, '%Y-%m-%d'), ${edd_us})",
  MCC_GA_WK: "if(${edd_used}!='', int((280 - (decimal-date-time(${edd_used}) - decimal-date-time(${event_date}))) div 7), '')",
  MCC_BOOK_TRIMESTER: "if(${MCC_GA_WK}='', '', if(${MCC_GA_WK} < 14, 'T1', if(${MCC_GA_WK} < 28, 'T2', 'T3')))",
  MCC_ANC1_FIRST_TRI: "if(${MCC_GA_WK}!='' and ${MCC_GA_WK} < 12, 'true', 'false')",
  MCC_BMI: "if(${MCC_WEIGHT}!='' and ${MCC_HEIGHT}!='', round(${MCC_WEIGHT} div ((${MCC_HEIGHT} div 100) * (${MCC_HEIGHT} div 100)), 1), '')",
  MCC_ANAEMIA_GRADE: "if(${MCC_HB}='', '', if(${MCC_HB} >= 11, 'NONE', if(${MCC_HB} >= 10, 'MILD', if(${MCC_HB} >= 7, 'MODERATE', 'SEVERE'))))",
  MCC_MUAC_CLASS: "if(${MCC_MUAC}='', '', if(${MCC_MUAC} < 21, 'SAM', if(${MCC_MUAC} < 23, 'MAM', 'NORMAL')))",
  MCC_IPTP_DATE: "if(${MCC_IPTP_STATUS}='GIVEN', ${event_date}, '')",
  MCC_SBA: "if(${MCC_ATTENDANT}='MIDWIFE' or ${MCC_ATTENDANT}='NURSE' or ${MCC_ATTENDANT}='CO' or ${MCC_ATTENDANT}='MO' or ${MCC_ATTENDANT}='OBGYN', 'true', if(${MCC_ATTENDANT}='', '', 'false'))",
  MCC_B1_LBW: "if(${MCC_B1_BW}!='', if(${MCC_B1_BW} < 2500, 'true', 'false'), '')",
  MCC_B2_LBW: "if(${MCC_B2_BW}!='', if(${MCC_B2_BW} < 2500, 'true', 'false'), '')",
  MCC_B3_LBW: "if(${MCC_B3_BW}!='', if(${MCC_B3_BW} < 2500, 'true', 'false'), '')",
  MCC_PNC_DAYS: "if(${client_delivery}!='', int(decimal-date-time(${event_date}) - decimal-date-time(${client_delivery})), '')",
  MCC_PNC_WINDOW: "if(${MCC_PNC_DAYS}='', '', if(${MCC_PNC_DAYS} <= 2, 'W48H', if(${MCC_PNC_DAYS} >= 3 and ${MCC_PNC_DAYS} <= 7, 'D3_7', if(${MCC_PNC_DAYS} >= 8 and ${MCC_PNC_DAYS} <= 14, 'D8_14', if(${MCC_PNC_DAYS} >= 42 and ${MCC_PNC_DAYS} <= 49, 'W6', 'OUTSIDE')))))",
  MCC_DEL_GA_WK: "if(${edd_used}!='', int((280 - (decimal-date-time(${edd_used}) - decimal-date-time(${event_date}))) div 7), '')",
};
/** XLSForm (survey / choices / settings as arrays) for KoBoToolbox or ODK. code = 'REG' or a stage code. */
function odkForm(token, code) {
  auth_(token, PII_ROLES);
  var H = ['type', 'name', 'label', 'hint', 'required', 'relevant', 'constraint', 'constraint_message', 'calculation', 'appearance', 'default', 'choice_filter', 'read_only'];
  var rows = [H], used = {};
  var add = function (o) { rows.push(H.map(function (k) { return o[k] === undefined ? '' : String(o[k]); })); };
  var reg = code === 'REG';
  var st = reg ? { code: 'REG', name: 'Client registration', sections: MCC_META.registration } : stage_(code);
  add({ type: 'start', name: 'start' }); add({ type: 'end', name: 'end' }); add({ type: 'deviceid', name: 'deviceid' });
  add({ type: 'calculate', name: 'mcc_form', calculation: "'" + st.code + "'" });
  add({ type: 'text', name: 'facility_code', label: 'Facility code (where you are working)', hint: 'Exactly as in the platform org unit list, e.g. LUM-FAC01', required: 'yes',
    default: '', calculation: '' });
  if (reg) {
    add({ type: 'note', name: 'reg_note', label: 'Registers a woman. She is identified by facility, age and date of first ANC; if those match an existing client (with the same surname) her record is updated. The platform generates her Unique ID on receipt.' });
  } else {
    add({ type: 'begin_group', name: 'find', label: 'Find the client', appearance: 'field-list' });
    add({ type: 'select_one lookup_by', name: 'lookup_by', label: 'Find client by', required: 'yes', appearance: 'horizontal' });
    add({ type: 'integer', name: 'age_q', label: 'Her age at first ANC (years)', relevant: "${lookup_by}='params'", constraint: '. >= 10 and . <= 55' });
    add({ type: 'date', name: 'first_anc_q', label: 'Date of her first ANC visit', relevant: "${lookup_by}='params'" });
    add({ type: 'select_one_from_file clients.csv', name: 'client_pick_p', label: 'Select the client', relevant: "${lookup_by}='params' and ${age_q}!='' and ${first_anc_q}!=''",
      choice_filter: 'facility=${facility_code} and age=${age_q} and first_anc=${first_anc_q}', appearance: 'minimal' });
    add({ type: 'barcode', name: 'umid_scan', label: 'Scan the QR / barcode on the ANC card', relevant: "${lookup_by}='scan'" });
    add({ type: 'text', name: 'umid_typed', label: 'Unique Maternal ID (UMID)', relevant: "${lookup_by}='umid'" });
    add({ type: 'text', name: 'name_q', label: 'Type part of her name (as registered, e.g. Banda)', relevant: "${lookup_by}='name'" });
    add({ type: 'select_one_from_file clients.csv', name: 'client_pick', label: 'Select the client', relevant: "${lookup_by}='name' and ${name_q}!=''", choice_filter: 'contains(label, ${name_q})', appearance: 'minimal' });
    add({ type: 'calculate', name: 'umid', calculation: "if(${lookup_by}='params', ${client_pick_p}, if(${lookup_by}='scan', ${umid_scan}, if(${lookup_by}='umid', ${umid_typed}, ${client_pick})))" });
    [['client_name', 'full_name'], ['client_facility', 'facility'], ['client_dob', 'dob'], ['client_age', 'age'], ['client_first_anc', 'first_anc'], ['client_edd', 'edd'], ['client_lmp', 'lmp'],
      ['client_active', 'active'], ['client_village', 'village'], ['client_delivery', 'delivery_date'], ['client_reg_no', 'anc_reg_no'], ['client_risk', 'risk']]
      .forEach(function (x) { add({ type: 'calculate', name: x[0], calculation: "pulldata('clients', '" + x[1] + "', 'name', ${umid})" }); });
    add({ type: 'note', name: 'client_card', relevant: "${client_name}!=''",
      label: '**${client_name}** · UMID ${umid} · Facility ${client_facility} · Age ${client_age} · First ANC ${client_first_anc} · Village ${client_village} · ANC no. ${client_reg_no} · EDD ${client_edd} · Risk: ${client_risk}' });
    add({ type: 'note', name: 'not_found', relevant: "${lookup_by}!='' and ${umid}!='' and ${client_name}=''",
      label: 'This UMID is not in the client list on this device. Update the clients.csv media file, or check the ID.' });
    add({ type: 'select_one yes_no', name: 'confirm_client', label: 'Is this the right client?', required: 'yes', relevant: "${umid}!=''", constraint: ".='true'", constraint_message: 'Search again until the right client is shown.' });
    add({ type: 'end_group', name: '' });
    add({ type: 'date', name: 'event_date', label: code === 'DEL' ? 'Delivery date' : 'Visit date', required: 'yes', default: 'today()', constraint: '. <= today()', constraint_message: 'Cannot be in the future' });
    if (code === 'ANC1') {
      add({ type: 'date', name: 'lmp', label: 'Date of LMP (or ultrasound-derived LMP) for this pregnancy', required: "${client_active}!='yes'", relevant: "${client_active}!='yes'",
        hint: 'Starts a new pregnancy record. Leave as is if she already has an active pregnancy.' });
      add({ type: 'calculate', name: 'lmp_used', calculation: "if(${lmp}!='', ${lmp}, ${client_lmp})" });
      add({ type: 'date', name: 'edd_us', label: 'EDD from the ultrasound report', relevant: "${MCC_DATING_METHOD}='US_LT24' or ${MCC_DATING_METHOD}='US_GE24'", required: 'yes' });
    }
    add({ type: 'calculate', name: 'edd_used', calculation: code === 'ANC1' ? '${MCC_EDD}' : '${client_edd}' });
  }
  st.sections.forEach(function (sec, i) {
    var fields = sec.fields.filter(function (f) { return !/^MCC_(UMID|CUR_|DEFAULTER|SMS_PHONE|ADOLESCENT)/.test(f) && !/_TEI_LINKED$/.test(f); });
    if (!fields.length) return;
    add({ type: 'begin_group', name: 'g' + (i + 1), label: sec.name.replace(/^[A-Z]\d+\s/, ''), relevant: ODK_SECTION_RELEVANT[sec.name] || '', appearance: 'field-list' });
    fields.forEach(function (f) {
      var m = MCC_META.fields[f], c = ODK_CONSTRAINT[f] || [];
      if (m.os) used[m.os] = true;
      if (m.mand === 'Auto') {
        if (ODK_CALC[f]) add({ type: 'calculate', name: f, calculation: ODK_CALC[f] });
        return;
      }
      var rel = (code === 'REF' && ODK_RELEVANT_REF[f]) || ODK_RELEVANT[f] || '';
      var bm = f.match(/^MCC_B(\d)_(\w+)$/);
      if (bm && ['SEX', 'OUTCOME', 'BW'].indexOf(bm[2]) < 0) rel = "${MCC_B" + bm[1] + "_OUTCOME}='LIVE'" + (bm[2] === 'KMC' ? " and ${MCC_B" + bm[1] + "_BW} < 2500" : '') + (bm[2] === 'ARV_PROPH' ? " and (${MCC_HIV_RESULT}='POS' or ${MCC_HIV_RESULT}='KNOWN_POS')" : '');
      if (code === 'ANC1' && f === 'MCC_EDD') return;
      add({ type: odkType_(f, m), name: f, label: m.name, default: f === 'MCC_FIRST_ANC_DATE' ? 'today()' : '', hint: m.vt === 'ORGANISATION_UNIT' ? 'Facility code' : '', required: m.mand === 'Yes' ? 'yes' : '',
        relevant: rel, constraint: c[0] || (m.vt === 'INTEGER_POSITIVE' ? '. >= 1' : m.vt === 'INTEGER_ZERO_OR_POSITIVE' ? '. >= 0' : ''), constraint_message: c[1] || '',
        appearance: m.vt === 'LONG_TEXT' ? 'multiline' : (m.os && (MCC_META.optionSets[m.os] || []).length > 6 && m.vt !== 'MULTI_TEXT' ? 'minimal' : '') });
    });
    if (code === 'ANC1' && sec.fields.indexOf('MCC_EDD') >= 0) add({ type: 'calculate', name: 'MCC_EDD', calculation: ODK_CALC.MCC_EDD });
    add({ type: 'end_group', name: '' });
  });
  // Drop any skip/constraint clause that points at a field this form does not have (keeps the form valid).
  var names = {}; rows.slice(1).forEach(function (r) { if (r[1]) names[r[1]] = true; });
  var ok = function (expr) { return !(String(expr).match(/\$\{(\w+)\}/g) || []).some(function (m) { return !names[m.slice(2, -1)]; }); };
  rows.slice(1).forEach(function (r) { [5, 6, 4].forEach(function (i) { if (r[i] && r[i] !== 'yes' && !ok(r[i])) { r[i] = ''; if (i === 6) r[7] = ''; } }); });
  var choices = [['list_name', 'name', 'label']];
  choices.push(['yes_no', 'true', 'Yes'], ['yes_no', 'false', 'No'], ['yes_only', 'true', 'Yes']);
  [['params', 'Age + first ANC date'], ['scan', 'Scan card'], ['umid', 'Type UMID'], ['name', 'Name']].forEach(function (x) { choices.push(['lookup_by', x[0], x[1]]); });
  Object.keys(used).forEach(function (os) { (MCC_META.optionSets[os] || []).forEach(function (o) { choices.push([os, o[0], o[1]]); }); });
  var ver = Utilities.formatDate(new Date(), 'Africa/Lusaka', 'yyyy-MM-dd').replace(/-/g, '') + '01';
  return { file: 'MCC_' + st.code + '_xlsform.xlsx', title: 'MCC – ' + st.name,
    sheets: { survey: rows, choices: choices, settings: [['form_title', 'form_id', 'version', 'default_language'], ['MCC – ' + st.name, 'mcc_' + st.code.toLowerCase(), ver, 'English (en)']] } };
}
/** clients.csv media file for pulldata() / select_one_from_file. Contains personal data: keep it on project devices only. */
function odkClients(token) {
  var u = auth_(token, ENTRY_ROLES); var sc = scope_(u);
  var enrolls = readAll_('Enrollments'), del = {}, risk = {};
  readAll_('EV_DEL').forEach(function (e) { del[e.enrollment_id] = String(e.MCC_DELIVERY_DT || e.event_date).slice(0, 10); });
  ['EV_ANC1', 'EV_ANCFU'].forEach(function (n) { readAll_(n).forEach(function (e) { if (String(e.MCC_HIGH_RISK) === 'true') risk[e.enrollment_id] = e.MCC_RISK_REASONS; }); });
  var rows = [['name', 'label', 'facility', 'age', 'first_anc', 'full_name', 'dob', 'village', 'phone', 'anc_reg_no', 'active', 'lmp', 'edd', 'delivery_date', 'risk']];
  readAll_('Persons').filter(function (p) { return sc.indexOf(String(p.org_unit)) >= 0; }).forEach(function (p) {
    var act = enrolls.filter(function (e) { return e.tei_id === p.tei_id && e.status === 'ACTIVE'; })[0];
    var full = [p.MCC_FIRST_NAME, p.MCC_OTHER_NAMES, p.MCC_SURNAME].filter(String).join(' ');
    var age = ageAt_(p.MCC_DOB, p.MCC_FIRST_ANC_DATE);
    rows.push([p.umid, full + ' · ' + age + ' y · first ANC ' + p.MCC_FIRST_ANC_DATE + ' · ' + p.umid, p.org_unit, age, String(p.MCC_FIRST_ANC_DATE || '').slice(0, 10), full, p.MCC_DOB, p.MCC_VILLAGE, p.MCC_PHONE,
      p.MCC_ANC_REG_NO, act ? 'yes' : 'no', act ? act.lmp : '', act ? isoDate_(new Date(new Date(act.lmp).getTime() + 280 * 86400000)) : '',
      act ? (del[act.enrollment_id] || '') : '', act ? (risk[act.enrollment_id] || '') : '']);
  });
  audit_(u, 'EXPORT', 'odk_clients', '', (rows.length - 1) + ' clients');
  return rows;
}
function adminIngestKey(token, regenerate) {
  auth_(token, ['ADMIN']);
  var props = PropertiesService.getScriptProperties();
  if (regenerate || !props.getProperty('INGEST_KEY')) props.setProperty('INGEST_KEY', Utilities.getUuid().replace(/-/g, ''));
  var key = props.getProperty('INGEST_KEY'), base = ScriptApp.getService().getUrl();
  return { key: key, url: props.getProperty('RUNTIME') === 'railway' ? base + '/odk/submit/' + key : base + '?key=' + key };
}
/** Receives one KoBoToolbox REST-service submission (JSON) or ODK record and stores it. */
function ingestSubmission(key, sub) {
  var want = PropertiesService.getScriptProperties().getProperty('INGEST_KEY');
  if (!want || key !== want) throw new Error('Invalid key.');
  var v = {};
  Object.keys(sub || {}).forEach(function (k) { var name = k.split('/').pop(); if (name.charAt(0) !== '_' || name === '_uuid') v[name] = sub[k]; });
  var iid = String(sub['meta/instanceID'] || sub._uuid || v.instanceID || '').replace('uuid:', '');
  var form = String(v.mcc_form || '');
  var log = function (status, msg, umid) { var prev = iid ? findBy_('Submissions', 'instance_id', iid) : null; (prev ? function (o) { update_('Submissions', prev._row, o); } : function (o) { append_('Submissions', o); })({ received_at: now_(), instance_id: iid, form: form, facility: v.facility_code || '', umid: umid || v.umid || '', status: status,
    message: String(msg || '').slice(0, 500), payload: JSON.stringify(v).slice(0, 45000) }); };
  if (iid && readAll_('Submissions').some(function (r) { return r.instance_id === iid && r.status === 'OK'; })) return { status: 'duplicate' };
  var sys = { user_id: 'odk', email: 'kobo/odk ingest', role: 'ADMIN', org_unit: '' };
  try {
    var allowed = {}, multi = {};
    var secs = form === 'REG' ? MCC_META.registration : stage_(form).sections;
    secs.forEach(function (s) { s.fields.forEach(function (f) { allowed[f] = true; if (MCC_META.fields[f].vt === 'MULTI_TEXT') multi[f] = true; }); });
    var vals = {};
    Object.keys(v).forEach(function (k) { if (allowed[k] && v[k] !== '' && v[k] !== null && v[k] !== undefined) vals[k] = multi[k] ? String(v[k]).trim().split(/\s+/).join(',') : String(v[k]); });
    var fc = String(v.facility_code || '').trim();
    if (form === 'REG') {
      var age = ageAt_(vals.MCC_DOB, vals.MCC_FIRST_ANC_DATE);
      var ex = readAll_('Persons').filter(function (x) { return String(x.org_unit) === fc && String(x.MCC_FIRST_ANC_DATE).slice(0, 10) === String(vals.MCC_FIRST_ANC_DATE || '').slice(0, 10)
        && Math.abs(Number(ageAt_(x.MCC_DOB, x.MCC_FIRST_ANC_DATE)) - Number(age)) <= 1 && String(x.MCC_SURNAME).toLowerCase() === String(vals.MCC_SURNAME || '').toLowerCase(); })[0] || null;
      var p = savePerson_(sys, { tei_id: ex ? ex.tei_id : '', org_unit: ex ? ex.org_unit : fc, values: Object.assign({}, ex || {}, vals) });
      log('OK', ex ? 'Updated existing client' : 'Registered', p.umid);
      return { status: 'ok', umid: p.umid };
    }
    var umid = String(v.umid || '').trim();
    var person = findBy_('Persons', 'umid', umid);
    if (!person) throw new Error('No client with UMID ' + umid);
    var act = readAll_('Enrollments').filter(function (e) { return e.tei_id === person.tei_id && e.status === 'ACTIVE'; })[0];
    var date = String(v.event_date || '').slice(0, 10) || isoDate_(new Date());
    if (!act) {
      if (form !== 'ANC1' || !v.lmp) throw new Error('No active pregnancy. Submit ANC 1 with the date of LMP first.');
      act = enroll_(sys, person.tei_id, { enrollment_date: date, lmp: String(v.lmp).slice(0, 10), org_unit: fc || person.org_unit });
    }
    var ev = saveEvent_(sys, { stage: form, enrollment_id: act.enrollment_id, event_date: date, org_unit: fc || act.org_unit, status: 'COMPLETED', values: vals,
      hidden: Object.keys(allowed).filter(function (f) { return !(f in vals); }) }); // the form's own skip logic already decided what applies
    log('OK', 'Saved ' + form, umid);
    return { status: 'ok', event_id: ev.event_id };
  } catch (e) {
    log('ERROR', e.message);
    throw e;
  }
}
/** Apps Script version: KoBo REST service URL = <web app URL>?key=<ingest key> */
function doPost(e) {
  var out;
  try { out = ingestSubmission(e.parameter.key, JSON.parse(e.postData.contents)); }
  catch (err) { out = { status: 'error', message: err.message }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}


// ------------------------------------------------------------------ uploaded data in Capture
/** Rows in uploaded spreadsheets (and text of Word/PDF uploads) that mention this client's UMID. */
function uploadsForPerson_(p) {
  var keys = [String(p.umid || '').trim()].filter(function (k) { return k.length >= 6; });
  if (!keys.length) return [];
  var out = [];
  readAll_('Uploads').forEach(function (up) {
    if (up.data_tab) {
      var sh = db_().getSheetByName(up.data_tab); if (!sh || sh.getLastRow() < 2) return;
      var vals = sh.getRange(1, 1, sh.getLastRow(), Math.max(1, sh.getLastColumn())).getValues();
      var head = vals[0].map(String);
      vals.slice(1).forEach(function (r, i) {
        if (out.length >= 60) return;
        if (r.some(function (c) { return keys.indexOf(String(c).trim()) >= 0; }))
          out.push({ kind: 'row', upload_id: up.upload_id, file_name: up.file_name, period: up.period, uploaded_at: up.uploaded_at, drive_url: up.drive_url, tab: up.data_tab, row_no: i + 2, header: head, row: r.map(String) });
      });
    } else if (up.text_excerpt) {
      var t = String(up.text_excerpt), hit = keys.filter(function (k) { return t.indexOf(k) >= 0; })[0];
      if (hit) { var at = t.indexOf(hit); out.push({ kind: 'text', upload_id: up.upload_id, file_name: up.file_name, period: up.period, uploaded_at: up.uploaded_at, drive_url: up.drive_url,
        snippet: t.slice(Math.max(0, at - 160), at + 240) }); }
    }
  });
  return out;
}
function getUpload(token, id) {
  var u = auth_(token); var sc = scope_(u);
  var r = findBy_('Uploads', 'upload_id', id);
  if (!r || (u.role !== 'ADMIN' && sc.indexOf(String(r.org_unit)) < 0)) throw new Error('Upload not found.');
  delete r._row;
  audit_(u, 'READ', 'upload', id, r.file_name);
  return r;
}

// ------------------------------------------------------------------ analytics
/** De-identified rows for the analytics app: events by stage, enrollments and age band / HIV status per woman. */
function analyticsData(token, f) {
  var u = auth_(token); f = f || {};
  var sc = scope_(u), set = sc;
  if (f.ou && sc.indexOf(f.ou) >= 0) {
    var all = orgUnits(), sub = [f.ou], grew = true;
    while (grew) { grew = false; all.forEach(function (o) { if (sub.indexOf(o.parent_code) >= 0 && sub.indexOf(o.code) < 0) { sub.push(o.code); grew = true; } }); }
    set = sub;
  }
  var inSet = function (r) { return set.indexOf(String(r.org_unit)) >= 0; };
  var drop = ['umid', 'tei_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'MCC_RISK_OTHER', 'MCC_OTHER_MED_TXT'];
  var events = {};
  MCC_META.stages.forEach(function (st) {
    events[st.code] = readAll_('EV_' + st.code).filter(inSet).map(function (e) { var o = {}; Object.keys(e).forEach(function (k) { if (k !== '_row' && drop.indexOf(k) < 0 && e[k] !== '') o[k] = e[k]; }); return o; });
  });
  var people = {};
  readAll_('Persons').forEach(function (p) { people[p.tei_id] = p; });
  var band = function (dob, at) {
    if (!dob) return 'Unknown';
    var a = (new Date(at) - new Date(dob)) / (365.25 * 86400000);
    return a < 15 ? '10–14' : a < 20 ? '15–19' : a < 25 ? '20–24' : a < 50 ? '25–49' : '50+';
  };
  var hivPos = {};
  MCC_META.stages.forEach(function (st) { (events[st.code] || []).forEach(function (e) { if (e.MCC_HIV_RESULT === 'POS' || e.MCC_HIV_RESULT === 'KNOWN_POS') hivPos[e.enrollment_id] = true; }); });
  var enrollments = readAll_('Enrollments').filter(inSet).map(function (e) {
    var p = people[e.tei_id] || {};
    return { enrollment_id: e.enrollment_id, org_unit: e.org_unit, enrollment_date: e.enrollment_date, lmp: e.lmp, status: e.status,
      age_band: band(p.MCC_DOB, e.enrollment_date), hiv_status: hivPos[e.enrollment_id] ? 'Positive (test result)' : 'Not positive / not tested', adolescent: band(p.MCC_DOB, e.enrollment_date) === '10–14' || band(p.MCC_DOB, e.enrollment_date) === '15–19' };
  });
  audit_(u, 'ANALYTICS', 'aggregate', f.ou || '', '');
  return { events: events, enrollments: enrollments, orgUnits: orgUnits(), generated: now_() };
}


// ------------------------------------------------------------------ KoBo submissions in the app
function listSubmissions(token, q) {
  var u = auth_(token, PII_ROLES); var sc = scope_(u);
  q = String(q || '').toLowerCase();
  var rows = readAll_('Submissions').filter(function (r) { return u.role === 'ADMIN' || sc.indexOf(String(r.facility)) >= 0; });
  if (q) rows = rows.filter(function (r) { return [r.form, r.facility, r.umid, r.status, r.message, r.payload].join(' ').toLowerCase().indexOf(q) >= 0; });
  audit_(u, 'BROWSE', 'submissions', '', q);
  return rows.reverse().slice(0, 300).map(function (r) {
    var p = {}; try { p = JSON.parse(r.payload || '{}'); } catch (e) {}
    var vals = [];
    Object.keys(p).forEach(function (k) { if (MCC_META.fields[k] && p[k] !== '' && p[k] !== null) vals.push([MCC_META.fields[k].name, String(p[k])]); });
    ['event_date', 'lmp', 'facility_code'].forEach(function (k) { if (p[k]) vals.unshift([k.replace('_', ' '), String(p[k])]); });
    return { received_at: r.received_at, form: r.form, facility: r.facility, umid: r.umid, status: r.status, message: r.message, values: vals };
  });
}
function adminKoboSettings(token, set) {
  auth_(token, ['ADMIN']);
  var props = PropertiesService.getScriptProperties();
  if (set) {
    if (set.server !== undefined) props.setProperty('KOBO_SERVER', String(set.server).replace(/\/+$/, ''));
    if (set.token) props.setProperty('KOBO_TOKEN', String(set.token).trim());
    if (set.assets !== undefined) props.setProperty('KOBO_ASSETS', String(set.assets).replace(/\s+/g, ''));
  }
  return { server: props.getProperty('KOBO_SERVER') || 'https://kf.kobotoolbox.org', assets: props.getProperty('KOBO_ASSETS') || '', hasToken: !!props.getProperty('KOBO_TOKEN'),
    lastPull: props.getProperty('KOBO_LAST_PULL') || '' };
}
/** Apps Script version of "Pull from KoBo" (the Railway server does this itself). */
function koboPull(token) {
  auth_(token, ['ADMIN']);
  var props = PropertiesService.getScriptProperties(), out = { ok: 0, duplicate: 0, error: 0, errors: [] };
  if (!props.getProperty('INGEST_KEY')) props.setProperty('INGEST_KEY', Utilities.getUuid().replace(/-/g, ''));
  (props.getProperty('KOBO_ASSETS') || '').split(',').filter(String).forEach(function (uid) {
    var res = UrlFetchApp.fetch((props.getProperty('KOBO_SERVER') || 'https://kf.kobotoolbox.org') + '/api/v2/assets/' + uid + '/data/?format=json&limit=1000',
      { headers: { Authorization: 'Token ' + props.getProperty('KOBO_TOKEN') }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { out.error++; out.errors.push(uid + ': HTTP ' + res.getResponseCode()); return; }
    (JSON.parse(res.getContentText()).results || []).forEach(function (rec) {
      try { var r = ingestSubmission(props.getProperty('INGEST_KEY'), rec); if (r.status === 'duplicate') out.duplicate++; else out.ok++; }
      catch (e) { out.error++; if (out.errors.length < 10) out.errors.push(e.message); }
    });
  });
  props.setProperty('KOBO_LAST_PULL', now_());
  return out;
}
