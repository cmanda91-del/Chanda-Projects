/**
 * OHNEZ H&N Feedback – Google Sheet → MEAL Hub link
 * Paste into Extensions → Apps Script, save, then run "setup" once.
 * Rows are sent when "Send to Hub" is ticked (instantly) and by a 5-minute backup sweep.
 * Keep edit access to this Sheet limited to trusted staff: the key below lets the Sheet add cases.
 */
const HUB_URL = 'https://meal-hub-production.up.railway.app/api/intake/hnfrm';
const INTAKE_KEY = 'PASTE_INTAKE_KEY_HERE';
const SHEET = 'Feedback Entry';
const HEAD = ['Send to Hub','Date received','Channel','District','Facility / location','Category','Description (facts only, in the person\'s words)',
  'Type of person','Sex','Age group','Disability','Anonymous?','Preferred reply route','Project component','Recorded by',
  'Case ID','Hub status','Acknowledged','Closed / referred','Sent at','Row ref'];
const KEYS = [null,'date','channel','district','location','cat','description','person','sex','age','disability','anonymous','route','component','collector'];
const C = {send:1,date:2,loc:5,cat:6,desc:7,id:16,status:17,ack:18,closed:19,sent:20,ref:21};
const LISTS = {
  'Channel':['Suggestion box','Help desk at activity','Phone / WhatsApp line','Face to face to staff','HMC / community meeting','Review meeting / scorecard'],
  'District':['Lumezi','Chipangali'],
  'Facility / location':['Lumezi Mission Hospital','Chanyalubwe HP','Kapongolo HP','Kazembe RHC','Kazonde HP','Sikatengwa HP','Zumwanda RHC','Community - Lumezi','Community - Chipangali','DHO / other'],
  'Category':['C1 – Request for information','C2 – Suggestion or appreciation','C3 – Minor dissatisfaction','C4 – Service quality or programme issue','C5 – Exclusion or targeting','C6 – Staff or partner misconduct (non-safeguarding)','C7 – Fraud, corruption or misuse of resources (SENSITIVE)','C8 – Child safeguarding or PSEA (SENSITIVE)','C9 – Outside OHNEZ scope'],
  'Type of person':['Client or caregiver','Community member','CHV or CHA','Facility staff','HMC member','DHO staff','Partner staff','Other'],
  'Sex':['Female','Male','Prefer not to say'],'Age group':['<18','18-24','25-59','60+','Unknown'],'Disability':['Yes','No','Not asked'],'Anonymous?':['No','Yes'],
  'Preferred reply route':['Phone call','WhatsApp / SMS','In person','Through HMC','Public notice (anonymous)','No reply needed'],
  'Project component':['Training','Mentorship','Equipment and supplies','Rehabilitation','Service quality','Community activity','Staff or partner conduct','Other']
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('MEAL Hub')
    .addItem('Send ticked rows now', 'sendNow')
    .addItem('Update case status from Hub', 'refreshStatus')
    .addSeparator().addItem('Set up / repair sheet', 'setup').addToUi();
}

/** Run once: builds dropdowns, checkboxes, protection and the two triggers. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET, 0);
  sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setWrap(true)
    .setBackground('#1b2430').setFontColor('#ffffff').setVerticalAlignment('middle');
  sh.getRange(1, C.id, 1, 5).setBackground('#5b6573');
  sh.setFrozenRows(1); sh.setFrozenColumns(2); sh.setRowHeight(1, 42);
  const n = Math.max(sh.getMaxRows() - 1, 999); if (sh.getMaxRows() < 1000) sh.insertRowsAfter(sh.getMaxRows(), 1000 - sh.getMaxRows());
  sh.getRange(2, C.send, n).insertCheckboxes();
  sh.getRange(2, C.date, n).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).setHelpText('Pick the date the feedback was received').build()).setNumberFormat('yyyy-mm-dd');
  HEAD.forEach((h, i) => { if (LISTS[h]) sh.getRange(2, i + 1, n).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(LISTS[h], true).setAllowInvalid(false).build()); });
  [[1,70],[2,105],[3,150],[4,90],[5,170],[6,240],[7,340],[8,140],[9,90],[10,80],[11,80],[12,85],[13,150],[14,150],[15,130],[16,155],[17,190],[18,100],[19,110],[20,140]].forEach(([c,w]) => sh.setColumnWidth(c, w));
  sh.getRange(2, C.desc, n).setWrap(true);
  sh.getRange(2, C.id, n, 5).setBackground('#f1f3f5').setFontColor('#334');
  sh.hideColumns(C.ref);
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(p => { if (p.getDescription() === 'Filled by MEAL Hub') p.remove(); });
  const p = sh.getRange(1, C.id, sh.getMaxRows(), 6).protect().setDescription('Filled by MEAL Hub'); p.setWarningOnly(true);
  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=LEFT($Q2,4)="Fix:"').setBackground('#fde2e1').setFontColor('#a61b1b').setRanges([sh.getRange(2, C.status, n)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR(LEFT($F2,2)="C7",LEFT($F2,2)="C8")').setBackground('#fff1d6').setRanges([sh.getRange(2, C.cat, n, 2)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Closed').setBackground('#dff3e4').setFontColor('#1d6b35').setRanges([sh.getRange(2, C.status, n)]).build()];
  sh.setConditionalFormatRules(rules);
  howTo_(ss);
  const s1 = ss.getSheetByName('Sheet1'); if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  ss.setActiveSheet(sh);
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onEditSend').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('sweep').timeBased().everyMinutes(5).create();
  ss.toast('Ready. Fill a row, tick "Send to Hub", and the Case ID appears within seconds.', 'MEAL Hub', 8);
}

/** Installable edit trigger: blanks sensitive descriptions and sends a row the moment its box is ticked. */
function onEditSend(e) {
  const r = e && e.range; if (!r || r.getSheet().getName() !== SHEET || r.getRow() < 2) return;
  const sh = r.getSheet();
  if (r.getColumn() <= C.cat && r.getLastColumn() >= C.cat) for (let i = r.getRow(); i <= r.getLastRow(); i++) guardSensitive(sh, i);
  if (r.getColumn() <= C.send && r.getLastColumn() >= C.send && r.getValue() === true) send_();
}
function guardSensitive(sh, row) {
  const cat = String(sh.getRange(row, C.cat).getValue());
  if (/^C[78]/.test(cat)) {
    const d = sh.getRange(row, C.desc); if (d.getValue() && d.getValue() !== 'NONE')
      SpreadsheetApp.getActive().toast('C7/C8 are sensitive: report to the SCI focal point. Details are not recorded here.', 'Sensitive case', 10);
    d.setValue('NONE');
  }
}
function sweep() { send_(); refreshStatus_(); }
function sendNow() { const r = send_(); SpreadsheetApp.getActive().toast(r.created + ' sent · ' + r.errors + ' need fixing', 'MEAL Hub', 6); }
function refreshStatus() { const n = refreshStatus_(); SpreadsheetApp.getActive().toast(n + ' case(s) updated from the Hub', 'MEAL Hub', 6); }

function iso_(v) { if (v instanceof Date) return Utilities.formatDate(v, 'Africa/Lusaka', 'yyyy-MM-dd'); return String(v || '').trim(); }
function post_(body) {
  const res = UrlFetchApp.fetch(HUB_URL, { method: 'post', contentType: 'application/json', headers: { 'X-Intake-Key': INTAKE_KEY }, payload: JSON.stringify(body), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Hub replied ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

function send_() {
  const lock = LockService.getDocumentLock(); if (!lock.tryLock(20000)) return { created: 0, errors: 0 };
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET); const last = sh.getLastRow(); if (last < 2) return { created: 0, errors: 0 };
    const V = sh.getRange(2, 1, last - 1, HEAD.length).getValues(); const rows = [], at = [];
    V.forEach((v, i) => {
      if (v[C.send - 1] !== true || v[C.id - 1]) return;
      let ref = v[C.ref - 1]; if (!ref) { ref = SpreadsheetApp.getActive().getId().slice(0, 8) + '-' + Utilities.getUuid(); sh.getRange(i + 2, C.ref).setValue(ref); }
      const o = { srcKey: ref }; KEYS.forEach((k, j) => { if (k) o[k] = k === 'date' ? iso_(v[j]) : String(v[j] == null ? '' : v[j]).trim(); });
      if (/^C[78]/.test(o.cat)) o.description = 'NONE';
      rows.push(o); at.push(i + 2);
    });
    if (!rows.length) return { created: 0, errors: 0 };
    let out; try { out = post_({ rows }); } catch (e) { at.forEach(r => sh.getRange(r, C.status).setValue('Waiting – ' + e.message.slice(0, 80))); return { created: 0, errors: rows.length }; }
    let created = 0, errors = 0; const stamp = Utilities.formatDate(new Date(), 'Africa/Lusaka', 'yyyy-MM-dd HH:mm');
    out.results.forEach((r, k) => {
      const row = at[k];
      if (r.id) { sh.getRange(row, C.id, 1, 2).setValues([[r.id, 'Open – received']]); sh.getRange(row, C.sent).setValue(stamp); if (r.status === 'created') created++; }
      else { sh.getRange(row, C.status).setValue('Fix: ' + r.error); sh.getRange(row, C.send).setValue(false); errors++; }
    });
    return { created, errors };
  } finally { lock.releaseLock(); }
}

function refreshStatus_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET); const last = sh.getLastRow(); if (last < 2) return 0;
  const ids = sh.getRange(2, C.id, last - 1, 1).getValues().map(r => String(r[0] || ''));
  const want = ids.filter(Boolean); if (!want.length) return 0;
  const out = post_({ rows: [], statusIds: want }); let n = 0;
  ids.forEach((id, i) => {
    if (!id) return; const c = out.cases[id];
    const st = !c ? 'Removed in Hub' : c.closed ? 'Closed' : c.ack ? 'Acknowledged' + (c.assigned ? ' – ' + c.assigned : '') : 'Open – received' + (c.assigned ? ' – ' + c.assigned : '');
    sh.getRange(i + 2, C.status, 1, 3).setValues([[st, c ? c.ack : '', c ? c.closed : '']]); n++;
  });
  return n;
}

function howTo_(ss) {
  if (ss.getSheetByName('How to use')) return;
  const h = ss.insertSheet('How to use', 0);
  const T = [['OHNEZ H&N Feedback – data entry sheet'],
    ['Each ticked row becomes a case in the MEAL Hub H&N Feedback (FRM) tab, with its own Case ID and deadlines.'], [''],
    ['Entering feedback'],
    ['1. Use the "Feedback Entry" tab, one row per piece of feedback.'],
    ['2. Fill Date received, Facility / location, Category and Description. Other columns are optional.'],
    ['3. Tick "Send to Hub". The Case ID and status appear in the grey columns within seconds.'],
    ['4. If the status starts with "Fix:", correct the row and tick "Send to Hub" again.'],
    ['5. Grey columns are filled by the Hub. Follow-up (acknowledge, close) is done in the MEAL Hub; the status here updates every 5 minutes.'], [''],
    ['Rules'],
    ['• Facts only, in the person\'s words. No names, phone numbers or NRC numbers in the description.'],
    ['• C7 (fraud) and C8 (safeguarding / PSEA) are sensitive: report to the SCI focal point the same day. The description is set to NONE automatically.'],
    ['• Only trusted staff should have edit access to this Sheet.'], [''],
    ['Menu: MEAL Hub → "Send ticked rows now" or "Update case status from Hub".']];
  h.clear(); h.getRange(1, 1, T.length, 1).setValues(T).setWrap(true).setVerticalAlignment('top');
  h.setColumnWidth(1, 900); h.getRange(1, 1).setFontSize(15).setFontWeight('bold').setFontColor('#1b2430');
  [4, 11].forEach(r => h.getRange(r, 1).setFontWeight('bold').setFontSize(12).setFontColor('#1f6fc5'));
}
