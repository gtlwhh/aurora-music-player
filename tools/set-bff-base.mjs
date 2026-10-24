/**
 * 一键写入移动端 BFF 默认地址并同步到 Android 工程
 *
 *   node tools/set-bff-base.mjs http://47.100.1.2:3000
 *   node tools/set-bff-base.mjs ""            # 清空（回到"设置页手填"模式）
 *
 * 做完后打包：见 docs/deploy-ecs.md 或让 AI 继续执行 gradle
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BFF = path.join(ROOT, 'mobile', 'www', 'js', 'bff.js');

const raw = (process.argv[2] || '').trim().replace(/\/+$/, '');
if (raw && !/^https?:\/\//i.test(raw)) {
  console.error('地址必须以 http:// 或 https:// 开头，例如 http://47.100.1.2:3000');
  process.exit(1);
}

let src = fs.readFileSync(BFF, 'utf8');
const re = /export const DEFAULT_BFF_BASE = '[^']*';/;
if (!re.test(src)) {
  console.error('没找到 DEFAULT_BFF_BASE，检查 bff.js 是否被改动');
  process.exit(1);
}
src = src.replace(re, `export const DEFAULT_BFF_BASE = '${raw}';`);
fs.writeFileSync(BFF, src, 'utf8');
console.log(raw ? `[ok] 默认地址已写入：${raw}` : '[ok] 已清空默认地址（设置页手填）');

// 同步到 Android 工程（cap copy）
const cli = path.join(ROOT, 'mobile', 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
if (!fs.existsSync(cli)) {
  console.warn('[warn] 没找到 @capacitor/cli，跳过同步。请手动在 mobile/ 下执行 npx cap copy android');
  process.exit(0);
}
const r = spawnSync(process.execPath, [cli, 'copy', 'android'], {
  cwd: path.join(ROOT, 'mobile'),
  stdio: 'inherit'
});
process.exit(r.status || 0);
