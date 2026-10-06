#!/usr/bin/env node
/**
 * Render Blueprint guard - keeps `render.yaml` both valid and *free*.
 *
 * Packages can't be added to read YAML (the project has no dependencies), so
 * this reads the small subset of YAML the Blueprint uses: indented maps, lists,
 * `- key: value` list items, scalars and comments.
 *
 * What it proves:
 *   1. every service is legal on Render's Free compute plan - `type: web` with
 *      `plan: free`, no disk, no extra instances, no autoscaling, no paid-only
 *      fields, no field the platform itself refuses on a free instance, no
 *      databases (only web services get a free instance)
 *   2. the commands Render runs exist in package.json
 *   3. the health check path is one the server really serves
 *   4. every environment variable is one the code actually reads (catches
 *      typos like MEMES_ADMIN_PW, which Render would happily set and ignore)
 *   5. secrets are never written into the file - they use `sync: false` (the
 *      Dashboard asks for them) or `generateValue: true`
 *
 * Exit code is non-zero on any failure, so it doubles as CI and as the
 * Blueprint's own build step.
 *
 * Deliberately moving a service to a paid plan (disk, worker, second instance)
 * is allowed - set MEMES_BLUEPRINT_PAID=1 to skip the free-tier rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'render.yaml');
const PAID_ESCAPE = process.env.MEMES_BLUEPRINT_PAID === '1';

let failures = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};
const note = (text) => console.log(`  note  ${text}`);

/** Minimal YAML reader for the Blueprint subset (see the header). */
export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (line.includes('\t')) throw new Error(`line ${i + 1}: tabs are not valid YAML indentation`);
    lines.push({ indent: line.length - line.trimStart().length, text: trimmed, line: i + 1 });
  });

  const scalar = (raw) => {
    const value = raw.trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
    if (value === 'true') return true;
    if (value === 'false') return false;
    // YAML scalars: plain integers and decimals are numbers (24.16.0 is not).
    if (/^-?\d+$/.test(value)) return Number(value);
    if (/^-?\d*\.\d+$/.test(value)) return Number(value);
    return value;
  };

  const root = {};
  const stack = [{ indent: -1, node: root }];
  const top = () => stack[stack.length - 1];

  for (let i = 0; i < lines.length; i++) {
    const { indent, text, line } = lines[i];
    while (stack.length > 1 && indent <= top().indent) stack.pop();
    const parent = top().node;
    const body = text.startsWith('- ') || text === '-' ? text.slice(1).trim() : null;

    if (body !== null) {
      if (!Array.isArray(parent)) throw new Error(`line ${line}: list item outside a list`);
      if (!body) {
        const item = {};
        parent.push(item);
        stack.push({ indent, node: item });
        continue;
      }
      const listKey = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(body);
      if (!listKey) {
        parent.push(scalar(body));
        continue;
      }
      const item = { [listKey[1]]: listKey[2] === undefined ? {} : scalar(listKey[2]) };
      parent.push(item);
      stack.push({ indent, node: item });
      continue;
    }

    const entry = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(text);
    if (!entry) throw new Error(`line ${line}: cannot parse "${text}"`);
    const [, key, raw] = entry;
    if (raw) {
      parent[key] = scalar(raw);
      continue;
    }
    const next = lines[i + 1];
    const isList = !!next && next.indent > indent && (next.text.startsWith('- ') || next.text === '-');
    parent[key] = isList ? [] : {};
    stack.push({ indent, node: parent[key] });
  }
  return root;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'dist', '.freebuff'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(m?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every env var name the code reads (process.env.X, process.env['X'], env.X). */
function envKeysInCode() {
  const keys = new Set();
  for (const file of walk(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(m[1]);
    for (const m of source.matchAll(/process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g)) keys.add(m[1]);
    for (const m of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) keys.add(m[1]);
  }
  return keys;
}

/** Keys Render provides itself, so they never appear in our code. */
const PLATFORM_KEYS = new Set([
  'PORT', 'NODE_ENV', 'NODE_VERSION', 'RENDER', 'RENDER_EXTERNAL_URL', 'RENDER_EXTERNAL_HOSTNAME',
  'RENDER_SERVICE_ID', 'RENDER_SERVICE_NAME', 'RENDER_GIT_COMMIT', 'RENDER_GIT_BRANCH',
  'RENDER_INSTANCE_ID', 'RENDER_DISCOVERY_SERVICE', 'RENDER_CPU_COUNT', 'IS_PULL_REQUEST',
]);

/** Fields that need a paid instance type, or that scale past one instance. */
const PAID_FIELDS = ['disk', 'maintenanceMode', 'ipAllowList', 'scaling', 'previews', 'pullRequestPreviewsEnabled'];

/**
 * Fields Render's own validator refuses on a free instance even though the
 * published schema allows them - a schema-valid file can still be rejected at
 * apply time, which reads as a deploy that never starts:
 *
 *   services[0].maxShutdownDelaySeconds
 *   max shutdown delay is not supported for free tier services
 *
 * That is exactly how the graceful-shutdown window this blueprint used to ask
 * for turned up here: SIGTERM still reaches the server and it still closes its
 * store on the way out, so only the *request* for a longer grace period goes.
 */
const FREE_TIER_REJECTED = new Map([
  ['maxShutdownDelaySeconds', 'Render refuses it on a free instance ("max shutdown delay is not supported for free tier services")'],
]);
const SECRET_NAME = /(PASS|PASSWORD|TOKEN|SECRET|_KEY$|APIKEY)/;

function main() {
  if (!fs.existsSync(FILE)) {
    note('no render.yaml at the repo root - skipping the Blueprint check');
    console.log('\n✓ all checks passed\n');
    return;
  }

  const text = fs.readFileSync(FILE, 'utf8');
  console.log(`\n[1/4] render.yaml parses (${path.relative(ROOT, FILE)})`);
  let doc = null;
  try {
    doc = parseYaml(text);
    report(true, 'blueprint parsed', `${Array.isArray(doc.services) ? doc.services.length : 0} service(s)`);
  } catch (err) {
    report(false, 'blueprint parsed', err.message);
    console.log('\n✗ 1 failure(s)\n');
    process.exitCode = 1;
    return;
  }

  const services = Array.isArray(doc.services) ? doc.services : [];
  if (!services.length) report(false, 'the blueprint declares at least one service');

  console.log('\n[2/4] free-tier legality');
  if (PAID_ESCAPE) note('MEMES_BLUEPRINT_PAID=1 - the paid-plan rules are skipped on purpose');
  for (const service of services) {
    const label = `${service.name || '(unnamed service)'} (${service.type || 'no type'})`;
    if (PAID_ESCAPE) continue;
    report(service.type === 'web', `${label} is a free-plan service type`,
      service.type === 'web' ? '' : 'only web services get a free instance - workers, cron jobs and private services are paid');
    report(service.plan === 'free', `${label} asks for the free instance`,
      `plan: ${service.plan ?? '(unset - Render would use the paid default 0.5c-512mb)'}`);
    for (const field of PAID_FIELDS) {
      if (service[field] !== undefined) report(false, `${label} has no paid-only field: ${field}`, 'needs a paid instance type');
    }
    for (const [field, why] of FREE_TIER_REJECTED) {
      if (service[field] !== undefined) report(false, `${label} has no free-tier-rejected field: ${field}`, why);
    }
    if (service.numInstances !== undefined && Number(service.numInstances) !== 1) {
      report(false, `${label} stays on one instance`, `numInstances: ${service.numInstances} - free instances can't scale, and rooms/parties live in memory`);
    }
  }
  if (!PAID_ESCAPE) {
    for (const field of ['databases', 'previews', 'previewsEnabled']) {
      if (doc[field] !== undefined) report(false, `the blueprint asks for no ${field}`, 'not free / not needed - the app is zero-dependency and stores JSON on disk');
    }
  }
  if (services.length > 1) {
    note(`${services.length} services: the free tier grants 750 instance hours per workspace per month, so a second always-awake service would trip the cap`);
  }
  if (!failures) {
    const plan = services.map((s) => `${s.name}=${s.plan}`).join(', ');
    report(true, 'the blueprint only asks for free resources',
      `${plan}; no disk, no extra instances, no paid-only fields, none of the ${FREE_TIER_REJECTED.size} field(s) Render refuses on free`);
  }

  console.log('\n[3/4] commands, health check and environment');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};
  /** npm built-ins that are not package.json scripts. */
  const NPM_BUILT_INS = new Set(['install', 'ci', 'i', 'audit', 'ping', 'version']);
  /** Empty string when every `npm <script>` in the command exists. */
  const runnable = (command) => {
    const invocations = [...String(command || '').matchAll(/(?:^|&&|\|\||;)\s*npm\s+(?:run\s+)?([a-z][a-z0-9:-]*)/gi)].map((m) => m[1]);
    if (!invocations.length) return `not an npm command: ${command}`;
    for (const name of invocations) {
      if (NPM_BUILT_INS.has(name)) continue;
      if (!scripts[name]) return `no "${name}" script in package.json (have: ${Object.keys(scripts).join(', ')})`;
    }
    return '';
  };
  const apiSource = fs.readFileSync(path.join(ROOT, 'server', 'api.js'), 'utf8');

  for (const service of services) {
    const label = service.name || '(unnamed service)';
    if (!service.buildCommand) report(false, `${label} sets a build command`, 'required for non-Docker services');
    else report(!runnable(service.buildCommand), `${label} build command "${service.buildCommand}" exists`, runnable(service.buildCommand));
    if (!service.startCommand) report(false, `${label} sets a start command`);
    else report(!runnable(service.startCommand), `${label} start command "${service.startCommand}" exists`, runnable(service.startCommand));
    if (service.type === 'web') {
      const health = service.healthCheckPath;
      const served = !!health && apiSource.includes(`'${health}'`);
      report(served, `${label} health check path is served by the server`,
        health ? `${health}${served ? '' : ' is not a route in server/api.js'}` : 'missing');
    }
  }

  const known = envKeysInCode();
  for (const service of services) {
    const vars = Array.isArray(service.envVars) ? service.envVars : [];
    if (!vars.length) note(`${service.name || 'service'} sets no environment variables - Render injects PORT and NODE_ENV`);
    for (const variable of vars) {
      const key = variable.key;
      if (!key) {
        report(false, `${service.name || 'service'} has an environment variable without a key`);
        continue;
      }
      const readable = PLATFORM_KEYS.has(key) || known.has(key);
      report(readable, `env ${key} is read by the code`,
        readable ? '' : 'nothing in server/, bot/, web/ or desktop/ reads it - probably a typo');
      const sources = ['value', 'sync', 'generateValue', 'fromService'].filter((f) => variable[f] !== undefined);
      report(sources.length === 1, `env ${key} has exactly one source`, sources.join(' + ') || 'none');
      if (SECRET_NAME.test(key) && variable.value !== undefined) {
        report(false, `env ${key} is not committed in the file`, 'use sync: false (the Dashboard prompts) or generateValue: true');
      }
    }
  }

  console.log('\n[4/4] service defaults worth knowing about');
  for (const service of services) {
    note(`${service.name || 'service'}: region ${service.region || '(workspace default)'}, branch ${service.branch || '(the branch holding render.yaml)'}`);
    note(`${service.name || 'service'}: auto-deploy ${service.autoDeployTrigger || '(Render default: every commit)'}, ${service.numInstances || 1} instance`);
  }

  console.log(`\n${failures ? `✗ ${failures} failure(s)` : '✓ the blueprint is valid and free'}\n`);
  process.exitCode = failures ? 1 : 0;
}

// Importable for tests: only run when invoked as a script.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
