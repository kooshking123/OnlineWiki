const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const UPLOADS_JSON = path.join(DATA_DIR, 'uploads.json');

console.log('=== Creating test orphan data structures ===\n');

// ── 1. Type A: Orphan file (disk file without uploads.json record) ──────────
const engDir = path.join(UPLOADS_DIR, 'Engineering');
fs.ensureDirSync(engDir);

const orphanFile = path.join(engDir, '9999999_orphan-test-file.txt');
fs.writeFileSync(orphanFile, 'This is an orphan test file created at ' + new Date().toISOString() + '\nNo uploads.json record exists for this file.\n', 'utf8');
console.log('[Type A] Created orphan file on disk:');
console.log('         ' + orphanFile);
console.log('         relPath: Engineering/9999999_orphan-test-file.txt');

const orphanFile2 = path.join(UPLOADS_DIR, '8888888_root-level-orphan.pdf');
fs.writeFileSync(orphanFile2, '%PDF-1.4 fake orphan pdf root level\n', 'utf8');
console.log('[Type A] Created root-level orphan file on disk:');
console.log('         ' + orphanFile2);
console.log('         relPath: 8888888_root-level-orphan.pdf');

// ── 2. Type B: Dangling record (uploads.json record without disk file) ──────
let index;
try {
  index = fs.readJsonSync(UPLOADS_JSON);
} catch (e) {
  console.log('No existing uploads.json, creating new index.');
  index = { uploads: [], updatedAt: new Date().toISOString() };
}
if (!Array.isArray(index.uploads)) index.uploads = [];

const dangling1 = {
  storedName: '7777777_dangling-test-doc.docx',
  folderPath: 'Engineering',
  originalName: 'dangling-test-doc.docx',
  sizeRaw: 1234567,
  uploadedAt: new Date(Date.now() - 86400000 * 3).toISOString(),
  updatedAt: new Date(Date.now() - 86400000).toISOString(),
  uploadedBy: 'admin'
};
const dangling2 = {
  storedName: '6666666_dangling-root-image.png',
  folderPath: '',
  originalName: 'dangling-root-image.png',
  sizeRaw: 87654,
  uploadedAt: new Date(Date.now() - 86400000 * 7).toISOString(),
  updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  uploadedBy: 'admin'
};

const exists1 = index.uploads.some(r =>
  r.folderPath === dangling1.folderPath && r.storedName === dangling1.storedName);
const exists2 = index.uploads.some(r =>
  (r.folderPath || '') === dangling2.folderPath && r.storedName === dangling2.storedName);

if (!exists1) index.uploads.push(dangling1);
if (!exists2) index.uploads.push(dangling2);

index.updatedAt = new Date().toISOString();
fs.writeJsonSync(UPLOADS_JSON, index, { spaces: 2 });

console.log('\n[Type B] Added dangling records to uploads.json (NO files on disk for these):');
console.log('         1. Engineering/7777777_dangling-test-doc.docx  (added=' + !exists1 + ')');
console.log('         2. 6666666_dangling-root-image.png              (added=' + !exists2 + ')');

// ── Confirm ──────────────────────────────────────────────────────────────────
const a = fs.existsSync(orphanFile) && !index.uploads.some(r =>
  r.folderPath === 'Engineering' && r.storedName === '9999999_orphan-test-file.txt');
const b = !fs.existsSync(path.join(engDir, '7777777_dangling-test-doc.docx')) &&
  index.uploads.some(r => r.folderPath === 'Engineering' && r.storedName === '7777777_dangling-test-doc.docx');
console.log('\n=== Verification ===');
console.log('Orphan file (file exists, no rec): ' + (a ? 'PASS' : 'FAIL'));
console.log('Dangling record (rec exists, no file): ' + (b ? 'PASS' : 'FAIL'));
console.log('\nTotal uploads.json records: ' + index.uploads.length);
console.log('\nNow navigate to:');
console.log('  http://localhost:3000/uploads            (root, shows root orphan file + root dangling)');
console.log('  http://localhost:3000/uploads?path=Engineering (Engineering folder with orphan + dangling)');
