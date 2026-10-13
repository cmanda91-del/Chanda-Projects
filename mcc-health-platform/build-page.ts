// Builds public/index.html from the Apps Script HTML files so both versions share one UI.
const g = import.meta.dir + "/gas/";
const read = (f: string) => Bun.file(g + f).text();
const [idx, sty, app, meta] = await Promise.all([read("Index.html"), read("Styles.html"), read("App.html"), read("Metadata.gs")]);
const shim = `<script>
window.google = { script: { run: (function mk(ok, fail) { return new Proxy({}, { get: function (_, k) {
  if (k === 'withSuccessHandler') return function (f) { return mk(f, fail); };
  if (k === 'withFailureHandler') return function (f) { return mk(ok, f); };
  return function () {
    fetch('/api/' + k, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Array.prototype.slice.call(arguments)) })
      .then(function (r) { return r.json(); })
      .then(function (r) { if (r.err) { fail && fail(new Error(r.err)); } else { ok && ok(r.val); } })
      .catch(function () { fail && fail(new Error('Cannot reach the server. Check your connection and try again.')); });
  };
} }); })() } };
</script>`;
const icon = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%230f5f5c%22/%3E%3Cpath d=%22M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z%22 fill=%22white%22/%3E%3C/svg%3E">`;
const metaJson = meta.match(/var MCC_META = ([\s\S]*);\s*$/)![1];
const app2 = app.replace("$('#ad-sheet').href = l.sheet; $('#ad-folder').href = l.folder;", "$('#ad-sheet').href = l.sheet + '?t=' + encodeURIComponent(S.token);");
let html = idx
  .replace('<base target="_top">', () => "<title>MCC Health Data Platform</title>" + icon + shim)
  .replace("<?!= include('Styles'); ?>", () => sty)
  .replace("<?!= include('App'); ?>", () => app2)
  .replace("<?!= metaJson() ?>", () => metaJson)
  .replace('<a id="ad-sheet" class="btn ghost" target="_blank" rel="noopener">Open database (Google Sheet)</a><a id="ad-folder" class="btn ghost" target="_blank" rel="noopener">Open uploads folder (Drive)</a>',
    () => '<a id="ad-sheet" class="btn ghost">Download full database (Excel)</a>');
if (html.includes("<?")) throw new Error("Unresolved template tag");
await Bun.write(import.meta.dir + "/public/index.html", html);
console.log("Built public/index.html", html.length);
