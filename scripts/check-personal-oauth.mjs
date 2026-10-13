import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStoredZip } from './check-release-secrets.mjs';

// Account-data check only. The full secret scanner remains unchanged and must
// still report the upstream application client. Neither gate grants permission
// to publish a client secret or bypass GitHub push protection.
export function personalFindings(path, data) {
  const rules = new Set();
  const name = path.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  if (['auth.json', 'accounts.json', 'settings.json', 'antigravity-models.json', 'credentials.json', 'oauth.json'].includes(name) || name === '.env' || name.startsWith('.env.')) rules.add('private-account-file');
  const text = data.toString('utf8');
  if (/\bya29\.[A-Za-z0-9._~+/-]{20,}/.test(text)) rules.add('google-user-access-token');
  if (/\b1\/[A-Za-z0-9_-]{20,}/.test(text)) rules.add('google-user-refresh-token');
  if (/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/.test(text)) rules.add('jwt-token');
  return [...rules];
}

export function main(args = process.argv.slice(2), cwd = process.cwd()) {
  let files;
  let checked = 0;
  let findings = 0;
  try {
    if (args[0] === '--help') {
      console.log('Usage: node scripts/check-personal-oauth.mjs [--package PATH]. Checks tracked file bytes or every stored-ZIP entry for private account files and common Google account/JWT token shapes. Not a full audit: arbitrary encodings, encrypted host storage and unknown token formats are not decoded. Does not classify application client secrets as user sessions; run secrets:check separately. No credential-store reads or matching-value output.');
      return 0;
    }
    if (args.length && (args.length !== 2 || args[0] !== '--package')) throw new Error('invalid-arguments');
    if (args.length) {
      const path = resolve(cwd, args[1]);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('invalid-package');
      files = readStoredZip(readFileSync(path)).filter(e => !e.directory);
    } else {
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {cwd, encoding:'utf8'}).trim();
      const paths = execFileSync('git', ['ls-files', '-z'], {cwd:root, encoding:'utf8', maxBuffer:128*1024*1024}).split('\0').filter(Boolean);
      files = paths.map(path => {
        const absolute = resolve(root, path);
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('invalid-tracked-file');
        return {path, data:readFileSync(absolute)};
      });
    }
    for (const file of files) {
      checked++;
      for (const rule of personalFindings(file.path, file.data)) {
        findings++;
        console.log(`FAIL path=${JSON.stringify(file.path)} rule=${rule}`);
      }
    }
    console.log(`${findings ? 'FAIL' : 'PASS'} personal-data checked=${checked} findings=${findings}; application client configuration is assessed by secrets:check separately`);
    return findings ? 1 : 0;
  } catch {
    console.error('ERROR personal-data scan input unreadable or invalid');
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
