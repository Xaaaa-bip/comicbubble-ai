(function () {
  'use strict';

  const Config = globalThis.ComicBubbleConfig;
  const $ = (id) => document.getElementById(id);

  function showBanner(text, isOk = true) {
    const el = $('bannerMsg');
    el.textContent = text;
    el.className = `banner ${isOk ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function parseDomainLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((line) => Config.normalizeDomain(line))
      .filter(Boolean);
  }

  function fillForm(s) {
    $('provider').value = s.provider || 'vps';
    $('vpsBaseUrl').value = s.vpsBaseUrl || '';
    $('vpsApiToken').value = s.vpsApiToken || '';

    $('geminiApiKey').value = s.geminiApiKey || '';
    $('geminiModel').value = s.geminiModel || 'gemini-2.5-flash';
    $('geminiBaseUrl').value = s.geminiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';

    $('openaiBaseUrl').value = s.openaiBaseUrl || 'https://api.openai.com/v1';
    $('openaiApiKey').value = s.openaiApiKey || '';
    $('openaiModel').value = s.openaiModel || 'gpt-4o-mini';

    $('translateSfx').checked = Boolean(s.translateSfx);
    $('customPrompt').value = s.customPrompt || '';

    $('autoTranslate').checked = Boolean(s.autoTranslate);
    $('siteMode').value = s.siteMode || 'blacklist';
    $('blacklistDomains').value = (s.blacklistDomains || []).join('\n');
    $('whitelistDomains').value = (s.whitelistDomains || []).join('\n');

    $('minImageWidth').value = s.minImageWidth;
    $('minImageHeight').value = s.minImageHeight;
    $('maxImageDimension').value = s.maxImageDimension;
    $('maxConcurrency').value = s.maxConcurrency;

    $('fontFamily').value = s.fontFamily;
    if (!$('fontFamily').value) $('fontFamily').selectedIndex = 0;
    $('fontWeight').value = String(s.fontWeight || '600');
    $('overlayOpacity').value = String(s.overlayOpacity);
    $('opacityVal').textContent = String(s.overlayOpacity);

    $('autoSampleBgColor').checked = Boolean(s.autoSampleBgColor);
    $('showOriginalOnHover').checked = Boolean(s.showOriginalOnHover);
    $('clickThrough').checked = Boolean(s.clickThrough);
    $('enableCache').checked = Boolean(s.enableCache);
  }

  function readForm() {
    return {
      provider: $('provider').value,
      vpsBaseUrl: $('vpsBaseUrl').value.trim().replace(/\/+$/, ''),
      vpsApiToken: $('vpsApiToken').value.trim(),

      geminiApiKey: $('geminiApiKey').value.trim(),
      geminiModel: $('geminiModel').value.trim() || 'gemini-2.5-flash',
      geminiBaseUrl: $('geminiBaseUrl').value.trim() || 'https://generativelanguage.googleapis.com/v1beta',

      openaiBaseUrl: $('openaiBaseUrl').value.trim() || 'https://api.openai.com/v1',
      openaiApiKey: $('openaiApiKey').value.trim(),
      openaiModel: $('openaiModel').value.trim() || 'gpt-4o-mini',

      translateSfx: $('translateSfx').checked,
      customPrompt: $('customPrompt').value.trim(),

      autoTranslate: $('autoTranslate').checked,
      siteMode: $('siteMode').value,
      blacklistDomains: parseDomainLines($('blacklistDomains').value),
      whitelistDomains: parseDomainLines($('whitelistDomains').value),

      minImageWidth: Number($('minImageWidth').value) || 320,
      minImageHeight: Number($('minImageHeight').value) || 320,
      maxImageDimension: Number($('maxImageDimension').value) || 1800,
      maxConcurrency: Number($('maxConcurrency').value) || 2,

      fontFamily: $('fontFamily').value,
      fontWeight: $('fontWeight').value,
      overlayOpacity: Number($('overlayOpacity').value) || 0.98,

      autoSampleBgColor: $('autoSampleBgColor').checked,
      showOriginalOnHover: $('showOriginalOnHover').checked,
      clickThrough: $('clickThrough').checked,
      enableCache: $('enableCache').checked
    };
  }

  async function refreshCacheStats() {
    const res = await chrome.runtime.sendMessage({ type: 'CACHE_STATS' });
    if (res && res.ok && res.stats) {
      $('cacheStatsText').textContent = `已缓存 ${res.stats.count} / ${res.stats.max} 张画面`;
    }
  }

  function bindEvents() {
    $('overlayOpacity').addEventListener('input', (e) => {
      $('opacityVal').textContent = e.target.value;
    });

    $('saveBtn').addEventListener('click', async () => {
      const updated = await Config.saveSettings(readForm());
      fillForm(updated);
      showBanner('所有设置已保存并立即生效！', true);
    });

    $('resetBtn').addEventListener('click', async () => {
      if (!confirm('确定将所有设置恢复为默认值吗？（包含已填写的 VPS/API 配置）')) return;
      const reset = await Config.saveSettings(Config.DEFAULT_SETTINGS);
      fillForm(reset);
      showBanner('已恢复默认设置', true);
    });

    $('testApiBtn').addEventListener('click', async () => {
      const btn = $('testApiBtn');
      const out = $('testResult');
      btn.disabled = true;
      out.textContent = '正在测试连通性...';
      out.style.color = '#475569';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'TEST_API', settings: readForm() });
        if (res && res.ok) {
          out.textContent = res.message || '连接成功！';
          out.style.color = '#166534';
        } else {
          out.textContent = (res && res.error) || '连接失败';
          out.style.color = '#b91c1c';
        }
      } catch (err) {
        out.textContent = err.message || String(err);
        out.style.color = '#b91c1c';
      } finally {
        btn.disabled = false;
      }
    });

    $('clearCacheBtn').addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      if (res && res.ok) {
        showBanner(`已清理 ${res.cleared || 0} 条浏览器本地缓存`, true);
        refreshCacheStats();
      }
    });
  }

  async function init() {
    bindEvents();
    const settings = await Config.loadSettings();
    fillForm(settings);
    await refreshCacheStats();
  }

  init();
})();
