/**
 * 通过 GitHub REST API 把本地目录整树推送到仓库（覆盖式）
 *
 *   node tools/push-repo.mjs <本地目录> <owner/repo> [分支] [提交说明]
 *
 * 为什么不用 git push：本机到 github.com:443 被网络阻断，但 api.github.com 可直连。
 * 凭证从 Windows 凭据管理器读取（git credential fill），不落盘、不打印。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [dir, repoSpec, branch = 'main', message = 'chore: sync server'] = process.argv.slice(2);
if (!dir || !repoSpec) {
  console.error('用法: node tools/push-repo.mjs <目录> <owner/repo> [分支] [说明]');
  process.exit(1);
}
const ROOT = path.resolve(dir);
const API = 'https://api.github.com';

/* ---- 取凭证 ---- */
const cred = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  encoding: 'utf8'
});
const token = (cred.match(/^password=(.*)$/m) || [])[1];
if (!token) { console.error('没取到 GitHub 凭证'); process.exit(1); }

async function gh(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aurora-push',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text;
    throw new Error(`${method} ${url} → ${res.status} ${msg}`);
  }
  return data;
}

/* ---- 收集文件 ---- */
// 只跳过仓库根目录下的数据/构建目录；web/js/data 这类同名子目录必须保留
const SKIP_TOP = new Set(['node_modules', '.git', 'data', 'dist', 'shots', '.idea']);
const FILES = [];
(function walk(d, depth) {
  const top = depth === 0;
  for (const name of fs.readdirSync(d)) {
    if (name === 'node_modules' || name === '.git') continue;
    if (top && SKIP_TOP.has(name)) continue;
    const full = path.join(d, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, depth + 1);
    else FILES.push({ full, rel: path.relative(ROOT, full).split(path.sep).join('/'), size: st.size });
  }
})(ROOT, 0);

/* ---- 取当前 head ---- */
const ref = await gh('GET', `/repos/${repoSpec}/git/ref/heads/${branch}`);
const baseSha = ref.object.sha;
const baseCommit = await gh('GET', `/repos/${repoSpec}/git/commits/${baseSha}`);

/* ---- 建 blob（并发 6）---- */
const entries = [];
for (let i = 0; i < FILES.length; i += 6) {
  const batch = FILES.slice(i, i + 6);
  const shas = await Promise.all(batch.map(f => gh('POST', `/repos/${repoSpec}/git/blobs`, {
    content: fs.readFileSync(f.full).toString('base64'),
    encoding: 'base64'
  }).then(b => b.sha)));
  batch.forEach((f, k) => entries.push({ path: f.rel, mode: '100644', type: 'blob', sha: shas[k] }));
}
console.log(`[1/4] blob ${entries.length} 个`);

/* ---- 建整树（不带 base_tree = 覆盖，旧文件全部消失）---- */
const tree = await gh('POST', `/repos/${repoSpec}/git/trees`, { tree: entries });
console.log(`[2/4] tree ${tree.sha}`);

const commit = await gh('POST', `/repos/${repoSpec}/git/commits`, {
  message,
  tree: tree.sha,
  parents: [baseCommit.sha]
});
console.log(`[3/4] commit ${commit.sha}`);

await gh('PATCH', `/repos/${repoSpec}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log(`[4/4] 已更新 ${branch} → ${commit.sha}`);
