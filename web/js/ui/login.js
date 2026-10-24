/**
 * 扫码登录弹窗控制器（多平台）
 *
 * 只负责二维码弹窗本身；账号卡片的渲染在 app.js（renderAccountCards）。
 * 统一走 /api/account/:platform/*（AccountManager）。
 * 扫码状态码全平台统一：800 过期 / 801 等待 / 802 已扫待确认 / 803 成功。
 */

import { api } from '../core/api.js';

const $ = (s) => document.querySelector(s);

const PLATFORM_META = {
  netease: {
    title: '扫码登录网易云',
    scanHint: '打开网易云音乐 App，扫描二维码',
    successToast: '网易云登录成功，下次打开自动登录'
  },
  qq: {
    title: '扫码登录 QQ 音乐',
    scanHint: '打开手机 QQ / 微信，扫描二维码',
    successToast: 'QQ 音乐登录成功，下次打开自动登录'
  }
};

export function createLoginController({ toast, onLoggedIn }) {
  let platform = null;      // 当前正在扫码的平台
  let timer = null;
  let qrKey = '';
  let polling = false;
  let expired = false;

  const setStatus = (text, kind = '') => {
    const el = $('#qrStatus');
    el.textContent = text;
    el.className = 'qr-status' + (kind ? ' ' + kind : '');
  };

  const stopPolling = () => {
    if (timer) { clearInterval(timer); timer = null; }
    polling = false;
  };

  const showExpired = () => {
    stopPolling();
    expired = true;
    $('#qrExpired').hidden = false;
    $('#qrImg').hidden = true;
    setStatus('二维码已失效，请刷新');
  };

  async function refreshQr() {
    stopPolling();
    expired = false;
    $('#qrExpired').hidden = true;
    $('#qrImg').hidden = true;
    $('#qrLoading').style.display = '';
    setStatus('正在获取二维码…');

    try {
      // 内嵌服务可能是懒启动的，第一次会慢一点
      const data = await api.accountQr(platform);
      qrKey = data.key;
      if (!data.qrimg) throw new Error('服务没有返回二维码图片');

      const img = $('#qrImg');
      img.onload = () => {
        $('#qrLoading').style.display = 'none';
        img.hidden = false;
        setStatus(PLATFORM_META[platform].scanHint);
        startPolling();
      };
      img.onerror = () => {
        $('#qrLoading').style.display = 'none';
        setStatus('二维码图片加载失败，请刷新', 'err');
      };
      img.src = data.qrimg;
    } catch (err) {
      $('#qrLoading').style.display = 'none';
      setStatus(err.message || '生成二维码失败', 'err');
    }
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    let ticks = 0;

    // 轮询查的是后端缓存的会话状态，不会反复打平台接口
    timer = setInterval(async () => {
      if (!platform || !qrKey || expired) { stopPolling(); return; }
      ticks++;
      if (ticks > 620) { showExpired(); return; }   // 后端 10 分钟兜底

      try {
        const r = await api.accountQrCheck(platform, qrKey);
        const pf = platform;

        if (r.code === 800) {
          showExpired();
        } else if (r.code === 801) {
          setStatus('等待扫码…');
        } else if (r.code === 802) {
          setStatus('已扫描，请在手机上点击「确认登录」');
        } else if (r.code === 803) {
          stopPolling();
          if (r.ok === false) {
            setStatus(r.message || '登录未完成，请刷新二维码重试', 'err');
            $('#qrExpired').hidden = false;
            return;
          }
          setStatus('登录成功，凭证已加密保存到本地', 'ok');
          if (typeof onLoggedIn === 'function') onLoggedIn(pf, r.user);
          toast(PLATFORM_META[pf].successToast, 'ok');
          setTimeout(() => {
            $('#qrMask').classList.remove('show');
          }, 1100);
        }
      } catch (_) {
        // 网络抖动就继续轮询，不打断
      }
    }, 1000);
  }

  function openQr(pf) {
    platform = pf;
    $('#qrTitle').textContent = PLATFORM_META[pf].title;
    $('#qrMask').classList.add('show');
    refreshQr();
  }

  function closeQr() {
    $('#qrMask').classList.remove('show');
    stopPolling();
    platform = null;
  }

  function bind() {
    $('#btnQrClose').addEventListener('click', closeQr);
    $('#qrMask').addEventListener('click', (e) => {
      if (e.target === $('#qrMask')) closeQr();
    });
    $('#btnQrRefresh').addEventListener('click', refreshQr);
  }

  return { bind, openQr, closeQr };
}
