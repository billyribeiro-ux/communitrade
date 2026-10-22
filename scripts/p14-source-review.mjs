#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {createHash} from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skippedNames = new Set(['.git', '.next', '.turbo', '.local', 'node_modules', 'dist', 'build', 'coverage', 'target', 'generated', 'vendor']);
const sourceExtensions = new Set(['.py', '.cjs', '.css', '.html', '.js', '.jsx', '.mjs', '.prisma', '.sql', '.tf', '.ts', '.tsx', '.xml', '.yaml', '.yml']);
const scanRoots = ['apps', 'infra', 'packages', 'scripts'];
const secretRules = [
  ['PEM_PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['AWS_ACCESS_KEY_ID', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['GITHUB_TOKEN', /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/],
  ['STRIPE_LIVE_SECRET', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ['CREDENTIAL_DATABASE_URL', /\bpostgres(?:ql)?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i],
];
const metadataCredentialRule = /(?:^|[^A-Za-z0-9])(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*(['"])[^'"\r\n]{24,}\1/i;
const findings = new Map();
const reviewed=JSON.parse(await readFile(path.join(root,'scripts/p14-source-review-allowlist.json'),'utf8'));
let reviewedMatches=0;
let scanned = 0;

function isExcluded(relativePath, name) {
  return skippedNames.has(name) || name === '.env.local' || name.startsWith('.env.') ||
    relativePath.split(path.sep).some(part => skippedNames.has(part)) ||
    relativePath.includes(`${path.sep}test${path.sep}`) || relativePath.includes(`${path.sep}tests${path.sep}`) ||
    relativePath.endsWith('.map') || relativePath.endsWith('.snap');
}

function addFinding(relative, rule) {
  if (!findings.has(relative)) findings.set(relative, new Set());
  findings.get(relative).add(rule);
}

async function readInstalledPackageMetadata(packagePath) {
  try {
    const file = path.join(packagePath, 'package.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    return { name: String(data.name ?? path.basename(packagePath)), version: String(data.version ?? 'unknown'), license: licenseLabel(data.license ?? data.licenses) };
  } catch {
    return null;
  }
}

function licenseLabel(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.type).filter(Boolean).join(' OR ') || 'UNDECLARED';
  return 'UNDECLARED';
}

async function installedPackageIndex() {
  const base = path.join(root, 'node_modules', '.pnpm');
  const top = await readdir(base, { withFileTypes: true }).catch(() => []);
  const packages = new Map();
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    const modules = path.join(base, entry.name, 'node_modules');
    const children = await readdir(modules, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      const candidate = path.join(modules, child.name);
      if (child.name.startsWith('@') && (child.isDirectory() || child.isSymbolicLink())) {
        const scoped = await readdir(candidate, { withFileTypes: true }).catch(() => []);
        for (const item of scoped) {
          if (!item.isDirectory() && !item.isSymbolicLink()) continue;
          const pkg = await readInstalledPackageMetadata(path.join(candidate, item.name));
          if (pkg) packages.set(`${pkg.name}@${pkg.version}`, pkg);
        }
      } else if (child.isDirectory() || child.isSymbolicLink()) {
        const pkg = await readInstalledPackageMetadata(candidate);
        if (pkg) packages.set(`${pkg.name}@${pkg.version}`, pkg);
      }
    }
  }
  return packages;
}

function pnpmProductionPackages() {
  const output = execFileSync('pnpm', ['list', '--recursive', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(output);
  const found = new Set();
  function visit(entry) {
    if (!entry || typeof entry !== 'object') return;
    for (const field of ['dependencies', 'optionalDependencies']) {
      const dependencies = entry[field];
      if (!dependencies || typeof dependencies !== 'object') continue;
      for (const [key, dep] of Object.entries(dependencies)) {
        if (!dep || typeof dep !== 'object') continue;
        const name = String(dep.from ?? dep.name ?? key);
        const version = String(dep.version ?? 'unknown');
        if (name && name !== 'undefined') found.add(`${name}@${version}`);
        visit(dep);
      }
    }
  }
  for (const entry of Array.isArray(parsed) ? parsed : [parsed]) visit(entry);
  return [...found].sort((a, b) => a.localeCompare(b));
}

const sourcePaths = execFileSync('rg', [
  '--files', '--hidden',
  '-g', '!**/.env*', '-g', '!**/.local/**', '-g', '!**/node_modules/**',
  '-g', '!**/dist/**', '-g', '!**/build/**', '-g', '!**/generated/**', '-g', '!**/.next/**',
  '-g', '!**/coverage/**', '-g', '!**/target/**', '-g', '!**/vendor/**',
  ...scanRoots,
], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
for (const relative of sourcePaths) {
  const filename = path.basename(relative);
  if (isExcluded(relative, filename)) continue;
  if (!sourceExtensions.has(path.extname(filename)) && filename !== 'Dockerfile') continue;
  const absolute = path.join(root, relative);
  const details = await stat(absolute).catch(() => null);
  if (!details || details.size > 1_000_000) continue;
  const contents = await readFile(absolute, 'utf8').catch(() => '');
  if (!contents) continue;
  scanned++;
  for (const [rule, expression] of secretRules) {
    for(const match of contents.matchAll(new RegExp(expression.source,expression.flags.replace('g','')+'g'))){
      const sha256=createHash('sha256').update(match[0]).digest('hex');
      if(reviewed.some(entry=>entry.file===relative&&entry.rule===rule&&entry.sha256===sha256&&entry.reason&&entry.reviewDate))reviewedMatches++;
      else addFinding(relative,rule);
    }
  }
  // This broad heuristic can flag fixtures/placeholders; findings are explicitly
  // labeled as candidates and contain only source path plus rule, never the value.
  metadataCredentialRule.lastIndex = 0;
  if (metadataCredentialRule.test(contents)) addFinding(relative, 'POSSIBLE_LITERAL_CREDENTIAL');
}
console.log(`Source files reviewed: ${scanned}`);
console.log(`Exact reviewed synthetic/template matches: ${reviewedMatches}`);
console.log('Secret scan: heuristic only; this is not certification or a complete credential audit.');
if (findings.size) {
  console.log(`Potential secret-pattern findings: ${findings.size}`);
  for (const [file, rules] of [...findings].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${file} [${[...rules].sort().join(', ')}]`);
  }
} else {
  console.log('Potential secret-pattern findings: none');
}

try {
  const listed = pnpmProductionPackages();
  const installed = await installedPackageIndex();
  console.log(`Installed production dependency inventory (pnpm recursive --prod): ${listed.length} entries`);
  for (const identity of listed) {
    const pkg = installed.get(identity);
    console.log(`  ${identity}\t${identity.startsWith('@trading/') ? 'PROPRIETARY_WORKSPACE_RIGHTSHOLDER_PENDING' : pkg?.license ?? 'NOT_INSTALLED_ON_THIS_PLATFORM'}`);
  }
  const missing = listed.filter(identity => !identity.startsWith('@trading/') && !installed.has(identity));
  if (missing.length) console.log(`Installed metadata absent for ${missing.length} optional platform artifacts; exact-version metadata is collected separately by release:inventory.`);
} catch (error) {
  const code = error?.code === 'ENOENT' ? 'PNPM_NOT_FOUND' : 'PNPM_LIST_UNAVAILABLE';
  console.log(`Installed production dependency inventory unavailable [${code}].`);
}

if (findings.size) process.exitCode = 1;
