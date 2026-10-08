// Execute the real PowerShell script with fake COM objects; never start Office.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../src/backend/word_to_pdf.ps1');
const quote = s => "'" + s.replace(/'/g, "''") + "'";

test('failed PowerShell process cannot pass via a leftover PDF', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoneapp-pv04-'));
  try {
    const source = path.join(dir, 'cert.doc');
    const pdf = path.join(dir, 'cert.pdf');
    fs.writeFileSync(source, 'unchanged');
    const sandbox = {
      module: { exports: {} }, __dirname: path.dirname(script),
      process: { platform: 'win32', env: {} }, Buffer, console,
      require(name) {
        if (name === 'child_process') return { execFileSync() {
          fs.writeFileSync(pdf, '%PDF-partial');
          throw new Error('conversion failed');
        } };
        if (name === 'fs') return { ...fs, existsSync(p) {
          return /soffice/i.test(String(p)) ? false : fs.existsSync(p);
        } };
        return require(name);
      }
    };
    require('node:vm').runInNewContext(fs.readFileSync(path.join(path.dirname(script), 'doc_render.js'), 'utf8'), sandbox);
    assert.throws(() => sandbox.module.exports.convertWordToPdf(source, pdf), /Office COM/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ['export-fails', 'open-fails', 'missing-com', 'empty-output', 'invalid-output', 'all-fail', 'word-success']) {
  test(`PV03/PV04: ${mode}`, { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoneapp-pv03-'));
    try {
      const source = path.join(dir, '原件.doc');
      const pdf = path.join(dir, 'preview.pdf');
      const log = path.join(dir, 'events.txt');
      fs.writeFileSync(source, 'source-must-not-change');
      fs.writeFileSync(pdf, '%PDF-stale');
      const wrapper = path.join(dir, 'mock.ps1');
      fs.writeFileSync(wrapper, '\ufeff' + `
$global:mode = ${quote(mode)}
$global:log = ${quote(log)}
function New-Object {
  param($ComObject, $ErrorAction)
  $global:engine = $ComObject
  Add-Content $global:log "create:$ComObject"
  if ($global:mode -eq 'missing-com' -and $ComObject -eq 'Word.Application') { throw 'COM missing' }
  $documents = [pscustomobject]@{}
  $documents | Add-Member ScriptMethod Open {
    param($file, $confirm, $readonly)
    if (-not $readonly) { throw 'must open read-only' }
    if ($global:mode -eq 'open-fails' -and $global:engine -eq 'Word.Application') { throw 'open failed' }
    $doc = [pscustomobject]@{}
    $doc | Add-Member ScriptMethod ComputeStatistics { param($kind) return 2 }
    $doc | Add-Member ScriptMethod Close { param($save) Add-Content $global:log "close:$global:engine" }
    $doc | Add-Member ScriptMethod ExportAsFixedFormat {
      param($output)
      Add-Content $global:log "export:$global:engine"
      if ($global:mode -eq 'all-fail' -or ($global:mode -eq 'export-fails' -and $global:engine -eq 'Word.Application')) {
        [IO.File]::WriteAllText($output, 'partial-file')
        throw 'PDF export unavailable'
      }
      if ($global:mode -eq 'empty-output' -and $global:engine -eq 'Word.Application') { [IO.File]::WriteAllText($output, ''); return }
      if ($global:mode -eq 'invalid-output' -and $global:engine -eq 'Word.Application') { [IO.File]::WriteAllText($output, 'invalid'); return }
      [IO.File]::WriteAllText($output, "%PDF-1.4 mock $global:engine")
    }
    return $doc
  }
  $app = [pscustomobject]@{ Name=$ComObject; Documents=$documents; Visible=$false; DisplayAlerts=0 }
  $app | Add-Member ScriptMethod Quit { Add-Content $global:log "quit:$global:engine" }
  return $app
}
& ${quote(script)} -WordPath ${quote(source)} -PdfPath ${quote(pdf)}
exit $LASTEXITCODE
`, 'utf8');
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      assert.ifError(r.error);
      const events = fs.readFileSync(log, 'utf8');
      assert.equal(fs.readFileSync(source, 'utf8'), 'source-must-not-change');
      if (mode === 'all-fail') {
        assert.notEqual(r.status, 0);
        assert.equal(fs.existsSync(pdf), false, 'failed attempts must not leave partial PDF');
        for (const engine of ['Word.Application', 'KWps.Application', 'Wps.Application']) assert.ok(events.includes(`export:${engine}`));
      } else {
        assert.equal(r.status, 0, r.stderr);
        const engine = mode === 'word-success' ? 'Word.Application' : 'KWps.Application';
        assert.ok(fs.readFileSync(pdf, 'utf8').includes(engine));
        assert.ok(r.stdout.includes(`engine=${engine}`));
        if (mode === 'word-success') assert.ok(!events.includes('create:KWps'));
        else if (mode !== 'missing-com') assert.ok(events.indexOf('quit:Word.Application') < events.indexOf('create:KWps.Application'));
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
