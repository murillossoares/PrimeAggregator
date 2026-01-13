import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

function timestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function extractKeys(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function extractExampleEntries(text) {
  const entries = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) continue;
    const key = match[1];
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, line: line.trimEnd() });
  }
  return entries;
}

const envPath = process.argv[2] ?? '.env';
const examplePath = process.argv[3] ?? '.env.example';

if (!existsSync(examplePath)) {
  console.error(`Missing ${examplePath}`);
  process.exitCode = 1;
  process.exit(1);
}

const exampleText = readFileSync(examplePath, 'utf8');
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

const envKeys = extractKeys(envText);
const exampleEntries = extractExampleEntries(exampleText);
const missing = exampleEntries.filter((entry) => !envKeys.has(entry.key));

if (missing.length === 0) {
  console.log(JSON.stringify({ ok: true, updated: false, added: 0 }, null, 2));
  process.exit(0);
}

let backupPath;
if (existsSync(envPath)) {
  backupPath = `${envPath}.bak.${timestamp()}`;
  copyFileSync(envPath, backupPath);
}

const suffix = `\n\n# Added from ${examplePath}\n${missing.map((entry) => entry.line).join('\n')}\n`;
const nextText = envText.trimEnd() + suffix;
writeFileSync(envPath, nextText, 'utf8');

console.log(JSON.stringify({ ok: true, updated: true, backupPath, added: missing.length, keys: missing.map((e) => e.key) }, null, 2));

