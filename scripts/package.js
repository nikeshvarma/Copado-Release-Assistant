'use strict';
/**
 * Builds the .vsix with plain Node - no download, no zip tool - from the files git tracks (or, before
 * git init, the folder's own), less what .vscodeignore leaves out (LICENSE goes in as LICENSE.txt). Writes dist/<name>-<version>.vsix.
 *   node scripts/package.js [out-folder]
 */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const zip = require('./zip');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// .vscodeignore: "dir/**", "**/*.ext", plain names
const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(glob);
// "**/" any folders, "**" anything, "*" anything but a slash - through placeholders, so one step never rewrites another's output
function glob(g) {
  const re = g.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '\u0003')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*').replace(/\u0003/g, '[^/]*');
  return new RegExp('^' + re + '$');
}
// the files git tracks - or, in a folder that is not a git checkout yet (an unpacked source zip), the folder's files
let tracked;
try { tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch (e) { tracked = null; }
if (!tracked || !tracked.length) {
  const walk = d => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap(e => {
    const rel = d ? d + '/' + e.name : e.name;
    if (e.isDirectory()) return ['.git', 'node_modules', 'dist'].includes(e.name) && !d ? [] : walk(rel);
    return [rel];
  });
  tracked = walk('').filter(f => !/(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$|\.vsix$/.test(f));
}
const files = tracked.filter(f => !ignore.some(r => r.test(f)) && fs.existsSync(path.join(root, f))).sort();

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords || []).join(','))}</Tags>
    <Categories>${esc((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="${esc((pkg.galleryBanner || {}).color || '#1e1e1e')}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="${esc((pkg.galleryBanner || {}).theme || 'dark')}" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/${esc(pkg.icon)}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${esc(pkg.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>
`;
const TYPES = { '.js': 'application/javascript', '.json': 'application/json', '.md': 'text/markdown', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.txt': 'text/plain', '.xml': 'text/xml', '.vsixmanifest': 'text/xml', '.html': 'text/html', '.ttf': 'font/ttf' };
const inside = f => 'extension/' + (f === 'LICENSE' ? 'LICENSE.txt' : f);
const exts = [...new Set(files.map(f => path.extname(inside(f)).toLowerCase()).concat(['.vsixmanifest']))].sort();
const unknown = exts.filter(e => !TYPES[e]);
if (unknown.length) { console.error('No content type for "' + unknown.join('", "') + '" - add it to scripts/package.js.'); process.exit(1); }
const types = '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  exts.map(e => '<Default Extension="' + e + '" ContentType="' + TYPES[e] + '" />').join('') + '</Types>\n';

const entries = [{ name: '[Content_Types].xml', data: Buffer.from(types) }, { name: 'extension.vsixmanifest', data: Buffer.from(manifest) }]
  .concat(files.map(f => ({ name: inside(f), data: fs.readFileSync(path.join(root, f)) })));
const outDir = path.resolve(process.argv[2] || path.join(root, 'dist'));
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, pkg.name + '-' + pkg.version + '.vsix');
fs.writeFileSync(out, zip.write(entries));
console.log('packaged ' + path.relative(process.cwd(), out) + ' - ' + files.length + ' files, ' + Math.round(fs.statSync(out).size / 1024) + ' KB');
