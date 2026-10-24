/**
 * GitHub 开源发布一站式脚本（复用 push-repo 的凭证机制）
 *
 *   node tools/publish-github.mjs
 *
 * 流程：建仓（auto_init，已存在则跳过）→ 覆盖式推送白名单文件 → 创建 Release v1.8.3 → 上传 Setup.exe
 * 白名单制收集文件，杜绝 mobile/dist/data/logs 等任何越界上传。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/音乐开发';
const OWNER = 'gtlwhh';
const REPO = 'aurora-music-player';
const SPEC = `${OWNER}/${REPO}`;
const BRANCH = 'main';
const API = 'https://api.github.com';
const EXE = path.join(ROOT, 'dist', '极光音乐-Setup-1.8.3.exe');
const TAG = 'v1.8.3';
const RELEASE_NAME = '极光音乐 桌面端 1.8.3 正式版';

/* ---- 凭证（与 push-repo.mjs 同源） ---- */
import { execFileSync } from 'node:child_process';
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

/* ---- 白名单收集（含根文件；递归内跳过 node_modules/.git） ---- */
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
console.log(`[0/5] 白名单文件 ${FILES.length} 个`);

/* ---- ① 建仓（auto_init；已存在则跳过） ---- */
let created = await gh('POST', '/user/repos', {
  name: REPO,
  description: '🎵 AURORA 极光音乐 —— Electron 双平台聚合桌面音乐播放器（网易云 + QQ）',
  private: false,
  auto_init: true,
  has_issues: true,
  has_wiki: false
});
if (created.ok) console.log(`[1/5] 仓库已创建: ${SPEC}`);
else if (created.status === 422) console.log(`[1/5] 仓库已存在: ${SPEC}`);
else { console.error('建仓失败:', JSON.stringify(created.data).slice(0, 300)); process.exit(1); }

/* ---- ② 覆盖式推送 ---- */
const ref = await gh('GET', `/repos/${SPEC}/git/ref/heads/${BRANCH}`);
if (!ref.ok) { console.error('取 main 分支失败:', JSON.stringify(ref.data).slice(0, 300)); process.exit(1); }
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
console.log(`[2/5] blob ${entries.length} 个`);

const tree = await gh('POST', `/repos/${SPEC}/git/trees`, { tree: entries });
const commit = await gh('POST', `/repos/${SPEC}/git/commits`, {
  message: 'feat: AURORA 极光音乐 v1.8.3 —— Electron 双平台聚合音乐播放器\n\n- 网易云 + QQ 双平台聚合，账号隔离架构（ALS 凭证上下文）\n- BPM 智能交叉淡化、沉浸式歌词、像素伴侣\n- 本地/云端歌单双同步、红心收藏、批量多选\n- 游客搜索四层兜底、302 CDN 直连',
  tree: tree.data.sha,
  parents: [baseCommit.data.sha]
});
await gh('PATCH', `/repos/${SPEC}/git/refs/heads/${BRANCH}`, { sha: commit.data.sha });
console.log(`[3/5] 已推送 ${BRANCH} → ${commit.data.sha}`);

/* ---- ③ Release ---- */
const relBody = [
  '## 🎵 极光音乐 桌面端 1.8.3 正式版',
  '',
  '### ✨ 本版本亮点',
  '- **双平台聚合**：网易云 + QQ 音乐一次搜全，账号隔离不串号',
  '- **BPM 智能交叉淡化**：切歌等功率平滑交叠，运动歌单节拍无缝衔接',
  '- **歌单全面升级**：红心收藏、批量多选、跨歌单移动、左滑快删',
  '- **游客搜索四层兜底**：未登录也能搜出双平台曲库',
  '- **302 CDN 直连**：播放直链不过服务器，加载更快',
  '',
  '### 📦 安装说明',
  '下载下方 `极光音乐-Setup-1.8.3.exe`，双击安装即可（无需任何运行时依赖）。',
  '',
  '> 本项目仅供学习与技术研究，音乐版权归原作者所有。'
].join('\n');

const relCheck = await gh('GET', `/repos/${SPEC}/releases/tags/${TAG}`);
let releaseId;
if (relCheck.ok) {
  releaseId = relCheck.data.id;
  console.log(`[4/5] Release ${TAG} 已存在（id=${releaseId}）`);
} else {
  const rel = await gh('POST', `/repos/${SPEC}/releases`, {
    tag_name: TAG,
    target_commitish: BRANCH,
    name: RELEASE_NAME,
    body: relBody,
    draft: false,
    prerelease: false
  });
  if (!rel.ok) { console.error('创建 Release 失败:', JSON.stringify(rel.data).slice(0, 300)); process.exit(1); }
  releaseId = rel.data.id;
  console.log(`[4/5] Release ${TAG} 已创建（id=${releaseId}）`);
}

/* ---- ④ 上传 exe ---- */
const assetName = encodeURIComponent('极光音乐-Setup-1.8.3.exe');
const up = await fetch(`https://uploads.github.com/repos/${SPEC}/releases/${releaseId}/assets?name=${assetName}`, {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(fs.statSync(EXE).size),
    'User-Agent': 'aurora-publish'
  },
  body: fs.readFileSync(EXE)
});
const upText = await up.text();
if (!up.ok) { console.error('上传 asset 失败:', up.status, upText.slice(0, 300)); process.exit(1); }
console.log(`[5/5] Setup.exe 已上传（${(JSON.parse(upText).size / 1048576).toFixed(1)} MB）`);
console.log('\n✅ 发布完成: https://github.com/' + SPEC);
console.log('✅ Release:    https://github.com/' + SPEC + '/releases/tag/' + TAG);
