/**
 * GitHub 版本更新：推送桌面端源码 + 发布 Release + 上传安装包
 *   node tools/publish-update.mjs <版本号> <Setup.exe 绝对路径>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [VER, EXE_IN] = process.argv.slice(2);
if (!VER || !EXE_IN || !fs.existsSync(EXE_IN)) {
  console.error('用法: node tools/publish-update.mjs <版本号> <Setup.exe 路径>');
  process.exit(1);
}
const ROOT = 'D:/音乐开发';
const OWNER = 'gtlwhh';
const REPO = 'aurora-music-player';
const SPEC = `${OWNER}/${REPO}`;
const BRANCH = 'main';
const TAG = `v${VER}`;
const EXE = path.resolve(EXE_IN);
const ASSET_NAME = `Aurora-Setup-${VER}.exe`;   // GitHub asset 名建议 ASCII

const cred = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  encoding: 'utf8'
});
const token = (cred.match(/^password=(.*)$/m) || [])[1];
if (!token) { console.error('没取到 GitHub 凭证'); process.exit(1); }

async function gh(method, url, body, headers = {}) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aurora-publish',
      ...(body && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body instanceof Buffer ? body : (body ? JSON.stringify(body) : undefined)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { ok: res.ok, status: res.status, data };
}
const API = 'https://api.github.com';

/* ---- 白名单收集（与 publish-github.mjs 一致） ---- */
const INCLUDE_TOP = ['electron', 'server', 'web', 'core', 'tools', 'build', 'docs'];
const ROOT_FILES = ['package.json', 'package-lock.json', '.gitignore', 'README.md', '启动播放器.bat'];
const FILES = [];
function walk(d, rel) {
  for (const name of fs.readdirSync(d)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(d, name);
    const r = rel ? `${rel}/${name}` : name;
    if (fs.statSync(full).isDirectory()) walk(full, r);
    else FILES.push({ full, rel: r });
  }
}
for (const t of INCLUDE_TOP) walk(path.join(ROOT, t), t);
for (const f of ROOT_FILES) {
  const full = path.join(ROOT, f);
  if (fs.existsSync(full)) FILES.push({ full, rel: f });
}

/* ---- 推送（覆盖式 tree） ---- */
const ref = await gh('GET', `/repos/${SPEC}/git/ref/heads/${BRANCH}`);
if (!ref.ok) { console.error('取分支失败:', JSON.stringify(ref.data).slice(0, 200)); process.exit(1); }
const baseCommit = await gh('GET', `/repos/${SPEC}/git/commits/${ref.data.object.sha}`);

const entries = [];
for (let i = 0; i < FILES.length; i += 6) {
  const batch = FILES.slice(i, i + 6);
  const shas = await Promise.all(batch.map(f => gh('POST', `/repos/${SPEC}/git/blobs`, {
    content: fs.readFileSync(f.full).toString('base64'),
    encoding: 'base64'
  }))).then(list => list.map(r => {
    if (!r.ok) throw new Error('blob 失败: ' + JSON.stringify(r.data).slice(0, 200));
    return r.data.sha;
  }));
  batch.forEach((f, k) => entries.push({ path: f.rel, mode: '100644', type: 'blob', sha: shas[k] }));
}
console.log(`[1/4] blob ${entries.length} 个`);
const tree = await gh('POST', `/repos/${SPEC}/git/trees`, { tree: entries });
const commit = await gh('POST', `/repos/${SPEC}/git/commits`, {
  message: `fix: 修复桌面端歌单无法加载的问题（v${VER}）\n\n- /api/playlist/tracks 闸门支持桌面单用户回退服务端会话凭证\n- 歌单详情抽屉空白修复`,
  tree: tree.data.sha,
  parents: [baseCommit.data.sha]
});
await gh('PATCH', `/repos/${SPEC}/git/refs/heads/${BRANCH}`, { sha: commit.data.sha });
console.log(`[2/4] 已推送 ${BRANCH} → ${commit.data.sha}`);

/* ---- Release ---- */
const relBody = [
  `## 🎵 极光音乐 桌面端 ${VER} 正式版`,
  '',
  '### 🛠 修复',
  '- **歌单详情抽屉空白**：`/api/playlist/tracks` 闸门支持桌面单用户回退服务端会话凭证（与列表端点同构），平台歌单详情可正常加载全部曲目。',
  '',
  '### 📦 安装说明',
  `下载下方 \`Aurora-Setup-${VER}.exe\`，双击安装即可（无需任何运行时依赖）。`,
  '',
  '> 本项目仅供学习与技术研究，音乐版权归原作者所有。'
].join('\n');

const rel = await gh('POST', `/repos/${SPEC}/releases`, {
  tag_name: TAG,
  target_commitish: BRANCH,
  name: `极光音乐 桌面端 ${VER} 正式版`,
  body: relBody,
  draft: false,
  prerelease: false
});
if (!rel.ok) { console.error('创建 Release 失败:', JSON.stringify(rel.data).slice(0, 300)); process.exit(1); }
console.log(`[3/4] Release ${TAG} 已创建（id=${rel.data.id}）`);

/* ---- 上传 asset ---- */
const up = await fetch(`https://uploads.github.com/repos/${SPEC}/releases/${rel.data.id}/assets?name=${ASSET_NAME}`, {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(fs.statSync(EXE).size),
    'User-Agent': 'aurora-publish'
  },
  body: fs.readFileSync(EXE)
});
if (!up.ok) { console.error('上传 asset 失败:', up.status, (await up.text()).slice(0, 300)); process.exit(1); }
console.log(`[4/4] ${ASSET_NAME} 已上传`);
console.log(`\n✅ Release: https://github.com/${SPEC}/releases/tag/${TAG}`);
