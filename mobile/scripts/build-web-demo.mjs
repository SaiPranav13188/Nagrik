/**
 * Builds the browser demo into docs/demo/app (served by GitHub Pages at /Nagrik/demo/app/).
 *
 *   cd mobile && npm run build:web-demo
 *
 * Uses the API and Supabase settings in mobile/.env (only the public anon key ends up in the bundle).
 * After the export it frames the app at phone width on wide screens, and writes docs/404.html so
 * reloading a deep link (e.g. /Nagrik/demo/app/complaint/…) still opens the app.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.resolve(mobile, '../docs');
const out = path.join(docs, 'demo/app');
const BASE = '/Nagrik/demo/app/';

fs.rmSync(out, { recursive: true, force: true });
execSync(`npx expo export --platform web --clear --output-dir "${out}"`, { cwd: mobile, stdio: 'inherit', env: { ...process.env, NAGRIK_WEB_DEMO: '1' } });

const frame = `
    <meta name="theme-color" content="#0F766E" />
    <meta name="description" content="Nagrik web demo: report a civic problem and watch AI agents route, file and follow it up. Sample account, no sign-up." />
    <style id="demo-frame">
      /* Wide screens: show the app at phone width, centred, like on a phone. */
      @media (min-width: 640px) {
        body { background: linear-gradient(160deg, #0B4F4A, #0F766E 55%, #134E4A); }
        #root { max-width: 430px; margin: 0 auto; box-shadow: 0 0 60px rgba(0, 0, 0, 0.35); background: #fff; }
      }
    </style>`;

let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
if (!html.includes(`src="${BASE}`)) throw new Error(`Export is not built for ${BASE}: check experiments.baseUrl in app.json`);
html = html.replace('<title>Nagrik</title>', `<title>Nagrik demo</title>${frame}`);
fs.writeFileSync(path.join(out, 'index.html'), html);

// GitHub Pages serves 404.html for any missing path: boot the app for app routes, send anything else home.
const notFound = html.replace('<head>', `<head>\n    <script>if (location.pathname.indexOf('${BASE}') !== 0) location.replace('/Nagrik/');</script>`);
fs.writeFileSync(path.join(docs, '404.html'), notFound);
// Without this, Jekyll drops folders that start with "_" (the app's _expo bundle).
fs.writeFileSync(path.join(docs, '.nojekyll'), '');
console.log(`\nWeb demo built into ${path.relative(path.resolve(mobile, '..'), out)} (+ docs/404.html, docs/.nojekyll)`);
