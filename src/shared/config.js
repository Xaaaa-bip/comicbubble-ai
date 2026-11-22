(function (root) {
  'use strict';

  const STORAGE_KEY = 'comicbubble_settings_v1';

  const DEFAULT_SETTINGS = {
    // 引擎模式: 'vps' (自建无痕擦字后端，推荐) | 'gemini' | 'openai'
    provider: 'vps',

    // 自建 VPS 后端配置（在插件弹窗或设置页中填写你的 VPS 地址与 Token）
    vpsBaseUrl: '',
    vpsApiToken: '',

    // 直连多模态大模型备用配置
    geminiApiKey: '',
    geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    geminiModel: 'gemini-2.5-flash',

    openaiApiKey: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: 'gpt-4o-mini',

    // 翻译行为配置
    autoTranslate: true,
    siteMode: 'blacklist', // 'blacklist' | 'whitelist'
    blacklistDomains: [
      'github.com',
      'google.com',
      'bing.com',
      'baidu.com',
      'youtube.com',
      'bilibili.com',
      'zhihu.com',
      'taobao.com',
      'jd.com'
    ],
    whitelistDomains: [],
    translateSfx: false,
    customPrompt: '',

    // 扫描与性能
    minImageWidth: 320,
    minImageHeight: 320,
    maxImageDimension: 1280,
    maxConcurrency: 3,
    enableCache: true,

    // 渲染与交互
    overlayVisible: true,
    autoSampleBgColor: true,
    overlayOpacity: 1.0,
    fontFamily: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Hiragino Sans GB", sans-serif',
    fontWeight: '600',
    showOriginalOnHover: true,
    clickThrough: false
  };

  function normalizeDomain(input) {
    if (!input || typeof input !== 'string') return '';
    return input
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./, '');
  }

  function domainMatchesList(hostname, list) {
    const cleanHost = normalizeDomain(hostname);
    if (!cleanHost || !Array.isArray(list)) return false;
    return list.some((entry) => {
      const rule = normalizeDomain(entry);
      if (!rule) return false;
      return cleanHost === rule || cleanHost.endsWith('.' + rule);
    });
  }

  function isSiteAutoEnabled(settings, hostname) {
    if (!settings || !settings.autoTranslate) return false;
    const cleanHost = normalizeDomain(hostname);
    if (!cleanHost) return false;
    if (settings.siteMode === 'whitelist') {
      return domainMatchesList(cleanHost, settings.whitelistDomains);
    }
    return !domainMatchesList(cleanHost, settings.blacklistDomains);
  }

  function hasValidApiKey(settings) {
    if (!settings) return false;
    if (settings.provider === 'vps') {
      return /^https?:\/\/.+/i.test((settings.vpsBaseUrl || '').trim());
    }
    if (settings.provider === 'gemini') {
      return Boolean((settings.geminiApiKey || '').trim());
    }
    const baseUrl = (settings.openaiBaseUrl || '').trim();
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(baseUrl);
    return isLocal || Boolean((settings.openaiApiKey || '').trim());
  }

  function mergeSettings(raw) {
    const merged = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    if (!['vps', 'gemini', 'openai'].includes(merged.provider)) {
      merged.provider = 'vps';
    }
    if (!merged.vpsBaseUrl) {
      merged.vpsBaseUrl = DEFAULT_SETTINGS.vpsBaseUrl;
      if (!merged.vpsApiToken) merged.vpsApiToken = DEFAULT_SETTINGS.vpsApiToken;
    }
    // 兼容从 v1 升级：若旧配置选了 gemini/openai 但未填可用 Key，自动切到已部署好的 VPS 后端
    if (merged.provider !== 'vps' && !hasValidApiKey(merged) && merged.vpsBaseUrl) {
      merged.provider = 'vps';
    }
    if (!Array.isArray(merged.blacklistDomains)) {
      merged.blacklistDomains = DEFAULT_SETTINGS.blacklistDomains.slice();
    }
    if (!Array.isArray(merged.whitelistDomains)) {
      merged.whitelistDomains = [];
    }
    merged.minImageWidth = Math.max(120, Number(merged.minImageWidth) || 320);
    merged.minImageHeight = Math.max(120, Number(merged.minImageHeight) || 320);
    merged.maxImageDimension = Math.max(640, Math.min(3200, Number(merged.maxImageDimension) || 1800));
    merged.maxConcurrency = Math.max(1, Math.min(5, Number(merged.maxConcurrency) || 2));
    merged.overlayOpacity = Math.max(0.5, Math.min(1, Number(merged.overlayOpacity) || 0.98));
    return merged;
  }

  async function loadSettings() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return mergeSettings(result[STORAGE_KEY]);
  }

  async function saveSettings(partial) {
    const current = await loadSettings();
    const updated = mergeSettings(Object.assign({}, current, partial));
    await chrome.storage.local.set({ [STORAGE_KEY]: updated });
    return updated;
  }

  async function toggleSiteAuto(hostname, enable) {
    const cleanHost = normalizeDomain(hostname);
    if (!cleanHost) return loadSettings();
    const settings = await loadSettings();
    const wl = new Set((settings.whitelistDomains || []).map(normalizeDomain).filter(Boolean));
    const bl = new Set((settings.blacklistDomains || []).map(normalizeDomain).filter(Boolean));

    if (settings.siteMode === 'whitelist') {
      if (enable) {
        wl.add(cleanHost);
      } else {
        for (const item of Array.from(wl)) {
          if (cleanHost === item || cleanHost.endsWith('.' + item)) wl.delete(item);
        }
      }
    } else {
      if (enable) {
        for (const item of Array.from(bl)) {
          if (cleanHost === item || cleanHost.endsWith('.' + item)) bl.delete(item);
        }
      } else {
        bl.add(cleanHost);
      }
    }

    return saveSettings({
      whitelistDomains: Array.from(wl),
      blacklistDomains: Array.from(bl)
    });
  }

  root.ComicBubbleConfig = {
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    normalizeDomain,
    domainMatchesList,
    isSiteAutoEnabled,
    hasValidApiKey,
    mergeSettings,
    loadSettings,
    saveSettings,
    toggleSiteAuto
  };
})(globalThis);
