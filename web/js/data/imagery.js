/**
 * 关键词 → 意象图标 映射
 *
 * 只做"歌词里出现了这些词，就在行背后浮一个极淡的小图标"，
 * 属于纯装饰，误判也不影响阅读，所以用简单的包含匹配即可。
 */

export const IMAGERY = {
  rain: ['雨', '下雨', '落雨', '小雨', '大雨', '雨水', '细雨', '雨中', '淋雨', 'rain'],
  star: ['星', '星辰', '星光', '繁星', '银河', '流星', '星空', '星星', 'star'],
  sea: ['海', '海浪', '海边', '大海', '海岸', '潮水', '潮汐', '浪花', 'sea', 'ocean'],
  night: ['夜', '深夜', '黑夜', '夜晚', '午夜', '夜色', '夜里', '整夜', 'night'],
  wind: ['风', '微风', '风吹', '大风', '晚风', '秋风', '春风', '风中', 'wind'],
  fire: ['火', '火焰', '燃烧', '烈火', '篝火', '火苗', 'fire', 'burn'],
  flower: ['花', '花朵', '花瓣', '花开', '鲜花', '玫瑰', '花落', 'flower'],
  road: ['路', '路上', '街道', '旅途', '远方', '公路', '路口', 'road', 'street'],
  light: ['光', '灯光', '光芒', '阳光', '光亮', '光线', 'light'],
  dream: ['梦', '梦境', '梦里', '做梦', '梦幻', 'dream'],
  cloud: ['云', '白云', '云朵', '乌云', '云端', 'cloud'],
  moon: ['月', '月亮', '月光', '月色', '满月', 'moon'],
  mountain: ['山', '山川', '山顶', '山谷', '高山', 'mountain'],
  snow: ['雪', '下雪', '雪花', '白雪', '雪地', 'snow'],
  thunder: ['雷', '雷电', '雷鸣', '闪电', 'thunder', 'lightning'],
  fog: ['雾', '起雾', '迷雾', '大雾', '薄雾', 'fog', 'mist'],
  heart: ['心', '心跳', '心动', '心里', '心房', 'heart'],
  shadow: ['影', '影子', '身影', '倒影', '阴影', 'shadow'],
  boat: ['船', '小舟', '渡船', '帆船', '孤舟', 'boat', 'ship'],
  bird: ['鸟', '飞鸟', '候鸟', '翅膀', '鸟群', 'bird'],
  lamp: ['灯', '灯火', '路灯', '台灯', '灯光下', 'lamp'],
  window: ['窗', '窗外', '窗前', '窗口', '玻璃窗', 'window'],
  bridge: ['桥', '大桥', '桥头', '天桥', 'bridge'],
  sand: ['沙', '沙滩', '沙粒', '黄沙', 'sand', 'beach']
};

/** 预编译成 [{icon, word}] 并按词长降序，优先匹配长词避免误伤 */
export const IMAGERY_INDEX = Object.entries(IMAGERY)
  .flatMap(([icon, words]) => words.map(w => ({ icon, word: w })))
  .sort((a, b) => b.word.length - a.word.length);

/** 在文本里找出所有命中的意象（最多 2 个，避免画面太乱） */
export function findImagery(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const hits = [];
  const usedIcons = new Set();

  for (const { icon, word } of IMAGERY_INDEX) {
    if (usedIcons.has(icon)) continue;
    const w = word.toLowerCase();
    if (lower.includes(w)) {
      hits.push({ icon, word });
      usedIcons.add(icon);
      if (hits.length >= 2) break;
    }
  }
  return hits;
}
