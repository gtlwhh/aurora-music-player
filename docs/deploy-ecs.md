# 极光音乐 · 阿里云 ECS 一键部署（小白复制粘贴版）

> 目标：把服务端跑在 ECS 上，手机用 `http://公网IP:3000` 访问。
> 全部命令已按顺序排好，**整段复制进 Workbench 终端回车**即可。
> 默认你是 root 用户（Workbench 远程连接默认就是 root）。

---

## ✅ 仓库已更新（旧代码已被覆盖）

`https://github.com/gtlwhh/aurora-bff` 现在就是**完整服务端**：

| 内容 | 状态 |
|---|---|
| `server/`（网易云 + QQ 双平台、账号扫码、歌单、心动漫游） | ✅ 已推送 |
| `core/`（与桌面端共享的排序/混合逻辑） | ✅ 已推送 |
| `web/`（桌面端播放器页面，浏览器打开可自检） | ✅ 已推送 |
| 旧版 `api/`、`lib/ncm.js`、`dev-server.js`、`vercel.json`、`netlify/`、`cf-worker/` | ❌ 已删除 |
| 最高提交 | `86669ee`（main） |

仓库是**公开**的，`git clone` 不需要 token。

---

## 1. 装环境（自动识别 Ubuntu / CentOS）

整段粘贴执行：

```bash
# 1.1 装基础工具
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y && apt-get install -y curl git ca-certificates
else
  yum install -y curl git ca-certificates
fi

# 1.2 装 Node.js 20
if command -v apt-get >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  yum install -y nodejs
fi

# 1.3 校验 + 换国内源 + 装 PM2
node -v && npm -v
npm config set registry https://registry.npmmirror.com
npm install -g pm2
pm2 -v
```

期望看到 `v20.x.x` + `10.x.x` + `5.x.x`。

> **如果 1.2 卡住不动**（NodeSource 在部分网络很慢），按 Ctrl+C 后改用镜像装：
> ```bash
> cd /tmp && curl -fsSL -O https://npmmirror.com/mirrors/node/v20.18.1/node-v20.18.1-linux-x64.tar.xz
> tar -xJf node-v20.18.1-linux-x64.tar.xz -C /usr/local --strip-components=1
> node -v && npm -v && npm config set registry https://registry.npmmirror.com && npm i -g pm2
> ```

---

## 2. 拉代码（一条命令）

```bash
cd /root
rm -rf aurora-bff
git clone https://github.com/gtlwhh/aurora-bff.git
cd aurora-bff
ls
```

应看到 `core  package.json  package-lock.json  README.md  server  web`。
确认一下版本：

```bash
grep '"version"' package.json
# "version": "2.0.0"  ← 是 2.x 才是完整服务端
test -f server/index.js && echo "✅ 代码齐全" || echo "❌ 拉到了旧版"
```

> 如果 `git clone` 卡住（大陆访问 github.com 有时会被干扰），多试一次；
> 还不行就用下面「方式 B」的压缩包，别在 clone 上耗时间。

### 方式 B（兜底）：上传现成压缩包

把 `D:\音乐开发\deploy\aurora-server.tar.gz` 通过任何方式放到 `/root/`，然后：

```bash
cd /root && tar -xzf aurora-server.tar.gz && cd aurora && ls
```

---

## 3. 装依赖 + PM2 启动

```bash
cd /root/aurora-bff
npm ci --omit=dev || npm install --omit=dev
HOST=0.0.0.0 PORT=3000 pm2 start server/index.js --name aurora --update-env
sleep 3
pm2 logs aurora --lines 30 --nostream
```

> `--omit=dev` 跳过 electron 等开发依赖；`HOST=0.0.0.0` 是关键，
> 不写这个服务只监听 127.0.0.1，公网访问不到。

自检（服务器本机）：

```bash
curl -s http://127.0.0.1:3000/api/health
```

期望返回：`{"ok":true,"platform":"linux","node":"v20.x.x"}`

外网自检：手机或电脑浏览器打开 `http://<公网IP>:3000/api/health`，同样的 JSON 就通了。

开机自启：

```bash
pm2 save
pm2 startup
# 它会打印一行 `sudo env PATH=... pm2 startup systemd -u root --hp /root`
# 原样复制执行一次即可
```

---

## 4. 安全组（必做，否则外网连不上）

控制台 → 实例 → 安全组 → 配置规则 → **入方向** → 手动添加：

| 协议 | 端口 | 授权对象 | 用途 |
|---|---|---|---|
| 自定义 TCP | 3000/3000 | 0.0.0.0/0 | BFF 服务 |
| SSH | 22/22 | 0.0.0.0/0（最好改成你家 IP） | Workbench 登录 |

其余端口一律不要开。

---

## 5. 手机端连上

App → 设置 → 服务端地址 → `http://<公网IP>:3000` → 收起键盘，会弹"服务端已连通"。

然后可以测：搜索（应同时出现网易云 + QQ 条目）、设置页账号区扫码登录。

---

## 6. 日常运维

```bash
pm2 status               # 进程状态
pm2 logs aurora          # 实时日志（Ctrl+C 退出）
pm2 restart aurora       # 重启
pm2 stop aurora          # 停止
pm2 delete aurora        # 删除进程
```

更新代码后重启：

```bash
cd /root/aurora-bff && git pull && npm ci --omit=dev && pm2 restart aurora
```

---

## 7. 排错对照表

| 现象 | 处理 |
|---|---|
| 本机 curl 通、外网打不开 | 安全组没放行 3000；`ufw status` 若是 active 则 `ufw allow 3000/tcp` |
| `EADDRINUSE` | 3000 被占：`ss -lntp \| grep 3000` 杀进程，或换 `PORT=3001`（App 地址同步改） |
| `pm2: command not found` | Node 装完再 `npm i -g pm2`；或 `ln -s /usr/local/bin/pm2 /usr/bin/pm2` |
| 内存告警 | 加 1G swap：`fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`，再 `echo '/swapfile none swap sw 0 0' >> /etc/fstab` |
| 网易云二维码一直转 | 首次启动要拉内置 API，等 10~20 秒；`pm2 logs` 看 `[netease]` |
| QQ 扫码提示服务未就绪 | `pm2 logs` 看 `[qq]` 行；QQ 内置服务在 3200+ 端口 |
| 手机报"网络连接失败" | ①地址末尾多了 `/` ②安全组没放行 ③App 是旧包（新包已放行明文 HTTP） |

---

## 8. 安卓明文 HTTP（已配好，无需你再操作）

- `mobile/android/app/src/main/res/xml/network_security_config.xml`
  → `<base-config cleartextTrafficPermitted="true">`，对所有 IP 生效
- `mobile/android/app/src/main/AndroidManifest.xml`
  → `android:usesCleartextTraffic="true"` + `android:networkSecurityConfig="@xml/network_security_config"`

接口、封面图、ExoPlayer 音频流都能走 `http://IP:3000`。
