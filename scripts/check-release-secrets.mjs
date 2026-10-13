#!/usr/bin/env node
/** Independent, offline release gate. Never evaluates source or reads credential stores. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_FILE = 64 * 1024 * 1024;
const MAX_PACKAGE = 128 * 1024 * 1024;
const RULES = [
  ['google-oauth-secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/],
  ['google-oauth-client-id', /\b\d{6,}-[A-Za-z0-9_-]{10,}\.apps\.googleusercontent\.com\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})\b/],
  ['pem-private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
];
const HELP = `Usage:
  node scripts/check-release-secrets.mjs
  node scripts/check-release-secrets.mjs --package path/to/release.piplug
  node scripts/check-release-secrets.mjs --history REF

Default: current working-tree bytes of git ls-files at the repository root,
including docs, tracked dist and every bundle; excludes .git/node_modules path
components. Untracked files (including stale dist) are NOT scanned. Symlinks
are scanned as link text, never followed; unreadable files/gitlinks fail closed.
History: every distinct blob reachable from REF, not just its tip, using Git
objects (including blobs in docs/bundles and without the default exclusions).
Refs reaching a shallow boundary scan locally available ancestry but cannot
receive a clean pass (exit 2 if no findings); complete root-only refs can pass.
Git replacement objects are ignored.
Package: every entry in a stored/uncompressed ZIP, using only Node built-ins;
checks CRC and paths and rejects private filenames at any depth. No extraction.
Compressed/encrypted, ZIP64, multi-disk, non-UTF8 names, data descriptors and
malformed packages fail closed. Local records must be contiguous and in central
directory order. Limits: 64 MiB/file, 128 MiB/package, 10000 entries; Git command
output also has a 128 MiB limit and fails closed on overflow.
Recognizes Google OAuth secrets/client IDs, GitHub tokens and PEM private-key
headers in plaintext and literal atob(...) / Buffer.from(..., 'base64') calls,
including adjacent quoted strings joined by + (up to three decoding layers).
This is a targeted heuristic gate, NOT a complete audit: no execution, variable
resolution, arbitrary encodings/obfuscation, encrypted data, remote content,
untracked working files or unreachable Git objects. UTF-16 text and nested
archives are not decoded; Git submodule contents are not traversed.
It does not establish credential validity; placeholders matching a rule fail.
Output contains only paths, rule names and counts; never matching values.
Exit codes: 0 pass, 1 findings, 2 input/format/limit error.
`;

function fail(rule) {
  const error = new Error(rule);
  error.rule = rule;
  throw error;
}

function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', ['--no-replace-objects', ...args], {
      cwd, encoding: 'utf8', maxBuffer: MAX_PACKAGE,
      stdio: ['pipe', 'pipe', 'ignore'], ...options,
    });
  } catch {
    fail('git-read-error');
  }
}

function isPrivate(path) {
  const name = path.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  return ['auth.json', 'accounts.json', 'settings.json', 'antigravity-models.json'].includes(name)
    || name === '.env' || name.startsWith('.env.');
}

// Only parse literal strings, never eval/Function or source imports.
const LITERAL = String.raw`(?:'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*")`;
const GAP = String.raw`(?:\s|/\*[^]*?\*/|//[^\n]*(?:\n|$))*`;
const EXPRESSION = `${LITERAL}(?:${GAP}\\+${GAP}${LITERAL})*`;
const DECODER = new RegExp(
  String.raw`\b(?:atob\s*\(${GAP}(${EXPRESSION})${GAP}\)|Buffer\s*\.\s*from\s*\(${GAP}(${EXPRESSION})${GAP},${GAP}(['"])base64\3${GAP}\))`, 'g',
);

function literalValue(token) {
  return token.slice(1, -1).replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|(\r\n|[\n\r])|([\s\S]))/g,
    (_, codepoint, unicode, hex, continuation, char) => {
      if (continuation) return '';
      if (codepoint || unicode || hex) {
        const value = Number.parseInt(codepoint || unicode || hex, 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : '';
      }
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[char] ?? char;
    });
}

export function scanText(text) {
  const findings = new Set();
  function visit(source, depth) {
    for (const [rule, regex] of RULES) if (regex.test(source)) findings.add(rule);
    if (depth === 3) return;
    // Each visit needs its own regex state (recursive calls must not reset a parent).
    const decoder = new RegExp(DECODER.source, 'g');
    for (const match of source.matchAll(decoder)) {
      const expression = match[1] ?? match[2];
      const tokens = new RegExp(`(?:^|${GAP}\\+${GAP})(${LITERAL})`, 'g');
      const strings = [...expression.matchAll(tokens)].map(token => token[1]);
      const encoded = strings.map(literalValue).join('').replace(/\s/g, '');
      if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue;
      visit(Buffer.from(encoded, 'base64').toString('utf8'), depth + 1);
    }
  }
  visit(String(text), 0);
  return [...findings];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

// Parse central directory AND corresponding local records. Never invoke a ZIP tool.
export function readStoredZip(buffer) {
  if (buffer.length > MAX_PACKAGE) fail('package-size-limit');
  function range(offset, size) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > buffer.length) fail('zip-invalid');
  }
  function u16(offset) { range(offset, 2); return buffer.readUInt16LE(offset); }
  function u32(offset) { range(offset, 4); return buffer.readUInt32LE(offset); }
  let end = -1;
  for (let pos = buffer.length - 22; pos >= Math.max(0, buffer.length - 65557); pos--) {
    if (u32(pos) === 0x06054b50 && pos + 22 + u16(pos + 20) === buffer.length) { end = pos; break; }
  }
  if (end < 0) fail('zip-invalid');
  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryOffset = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count
      || count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) fail('zip-unsupported');
  if (count > 10000) fail('zip-entry-limit');
  if (directoryOffset + directorySize !== end) fail('zip-invalid');
  let cursor = directoryOffset;
  let localCursor = 0;
  const entries = [];
  const names = new Set();
  for (let index = 0; index < count; index++) {
    range(cursor, 46);
    if (u32(cursor) !== 0x02014b50) fail('zip-invalid');
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    const size = u32(cursor + 24);
    const nameSize = u16(cursor + 28);
    const extraSize = u16(cursor + 30);
    const commentSize = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    if ((flags & ~0x0800) || method !== 0 || u16(cursor + 34)
        || size === 0xffffffff || localOffset === 0xffffffff) fail('zip-unsupported');
    if (size > MAX_FILE) fail('file-size-limit');
    if (u32(cursor + 20) !== size || localOffset !== localCursor) fail('zip-invalid');
    range(cursor + 46, nameSize + extraSize + commentSize);
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = nameBytes.toString('utf8');
    if (!nameBytes.equals(Buffer.from(name)) || (!(flags & 0x0800) && nameBytes.some(byte => byte > 127))) fail('zip-name-encoding');
    const path = name.replaceAll('\\', '/');
    const components = path.replace(/\/$/, '').split('/');
    if (!name || path.startsWith('/') || /^[A-Za-z]:/.test(path)
        || components.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f:]/.test(part))) fail('zip-unsafe-path');
    const canonical = path.toLowerCase();
    if (names.has(canonical)) fail('zip-duplicate-path');
    names.add(canonical);
    range(localOffset, 30);
    if (u32(localOffset) !== 0x04034b50 || u16(localOffset + 6) !== flags
        || u16(localOffset + 8) !== method || u32(localOffset + 14) !== crc
        || u32(localOffset + 18) !== size || u32(localOffset + 22) !== size
        || u16(localOffset + 26) !== nameSize) fail('zip-invalid');
    const dataOffset = localOffset + 30 + nameSize + u16(localOffset + 28);
    range(localOffset + 30, nameSize);
    if (!buffer.subarray(localOffset + 30, localOffset + 30 + nameSize).equals(nameBytes)
        || dataOffset + size > directoryOffset) fail('zip-invalid');
    range(dataOffset, size);
    const data = buffer.subarray(dataOffset, dataOffset + size);
    if (crc32(data) !== crc || (path.endsWith('/') && size)) fail('zip-invalid');
    entries.push({ path, data, directory: path.endsWith('/') });
    localCursor = dataOffset + size;
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end || localCursor !== directoryOffset) fail('zip-invalid');
  return entries;
}

export function main(args = process.argv.slice(2), cwd = process.cwd()) {
  let checked = 0;
  let hits = 0;
  let incompleteHistory = false;
  let activePath = '<input>';
  function finding(path, rule) {
    hits++;
    console.log(`FAIL path=${JSON.stringify(path)} rule=${rule}`);
  }
  function scan(path, data) {
    checked++;
    if (isPrivate(path)) finding(path, 'private-file');
    for (const rule of scanText(data.toString('utf8'))) finding(path, rule);
  }
  function file(path, maxSize) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(path));
      if (!stat.isFile()) fail('not-regular-file');
      if (stat.size > maxSize) fail('file-size-limit');
      const data = readFileSync(path);
      if (data.length > maxSize) fail('file-size-limit');
      return data;
    } catch (error) {
      if (error.rule) throw error;
      fail('file-read-error');
    }
  }
  try {
    if (args.length === 1 && args[0] === '--help') { console.log(HELP); return 0; }
    if (args.length && (args.length !== 2 || !['--package', '--history'].includes(args[0]) || !args[1])) fail('invalid-arguments');
    if (args[0] === '--package') {
      activePath = args[1];
      const packagePath = resolve(cwd, args[1]);
      if (lstatSync(packagePath).isSymbolicLink()) fail('package-symlink');
      for (const entry of readStoredZip(file(packagePath, MAX_PACKAGE))) {
        if (!entry.directory) scan(entry.path, entry.data);
      }
    } else {
      const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
      if (args[0] === '--history') {
        const ref = git(root, ['rev-parse', '--verify', '--end-of-options', `${args[1]}^{commit}`]).trim();
        if (git(root, ['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
          const boundaryPath = git(root, ['rev-parse', '--git-path', 'shallow']).trim();
          const boundaries = new Set(readFileSync(resolve(root, boundaryPath), 'utf8').trim().split(/\s+/));
          incompleteHistory = git(root, ['rev-list', ref]).trim().split('\n').some(oid => boundaries.has(oid));
        }
        const objects = git(root, ['rev-list', '--objects', ref]).trim().split('\n').filter(Boolean);
        const paths = new Map(objects.map(line => {
          const split = line.indexOf(' ');
          return split < 0 ? [line, `<blob:${line}>`] : [line.slice(0, split), line.slice(split + 1)];
        }));
        const metadata = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
          { input: [...paths.keys()].join('\n') + '\n' });
        for (const line of metadata.trim().split('\n')) {
          const [oid, type, size] = line.split(' ');
          if (type === 'blob') {
            activePath = paths.get(oid);
            if (Number(size) > MAX_FILE) fail('file-size-limit');
            scan(activePath, git(root, ['cat-file', 'blob', oid], { encoding: null, maxBuffer: MAX_FILE }));
          } else if (!['tree', 'commit', 'tag'].includes(type)) fail('git-object-error');
        }
      } else {
        const paths = git(root, ['ls-files', '--cached', '--full-name', '-z']).split('\0').filter(Boolean);
        for (const path of new Set(paths)) {
          if (path.split('/').some(part => part === '.git' || part === 'node_modules')) continue;
          activePath = path;
          scan(path, file(resolve(root, path), MAX_FILE));
        }
      }
    }
    if (incompleteHistory && hits === 0) {
      activePath = '<history>';
      fail('git-shallow-history');
    }
    console.log(`${hits ? 'FAIL' : 'PASS'} checked=${checked} findings=${hits}`);
    return hits ? 1 : 0;
  } catch (error) {
    finding(activePath, error.rule ?? 'input-error');
    console.log(`ERROR checked=${checked} findings=${hits}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
