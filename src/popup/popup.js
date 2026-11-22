(function () {
  'use strict';

  const Config = globalThis.ComicBubbleConfig;
  let activeTab = null;
  let currentHostname = '';

  const $ = (id) => document.getElementById(id);

  function setStatus(text) {
    $('statusMsg').textContent = text || '';
  }

  function showApiMsg(text, isOk) {
    const el = $('apiMsg');
    el.textContent = text;
    el.className = `msg ${isOk ? 'ok' : 'err'}`;
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tabName}`);
    });
  }

  function updateProviderVisibility() {
    const provider = $('providerSelect').value;
    $('vpsFields').classList.toggle('hidden', provider !== 'vps');
    $('geminiFields').classList.toggle('hidden', provider !== 'gemini');
    $('openaiFields').classList.toggle('hidden', provider !== 'openai');
  }

  function renderSettingsToUi(settings) {
    $('providerSelect').value = settings.provider || 'vps';
    $('vpsBaseUrl').value = settings.vpsBaseUrl || '';
    $('vpsApiToken').value = settings.vpsApiToken || '';

    $('geminiApiKey').value = settings.geminiApiKey || '';
    $('geminiModel').value = settings.geminiModel || 'gemini-2.5-flash';
    $('geminiBaseUrl').value = settings.geminiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';

    $('openaiBaseUrl').value = settings.openaiBaseUrl || 'https://api.openai.com/v1';
    $('openaiApiKey').value = settings.openaiApiKey || '';
    $('openaiModel').value = settings.openaiModel || 'gpt-4o-mini';

    updateProviderVisibility();

    const validKey = Config.hasValidApiKey(settings);
    $('apiAlert').classList.toggle('hidden', validKey);

    if (settings.provider === 'vps') {
      let hostLabel = '未填写';
      try {
        if (settings.vpsBaseUrl) hostLabel = new URL(settings.vpsBaseUrl).host;
      } catch (_) {}
      $('engineBadge').textContent = `VPS · ${hostLabel}`;
    } else if (settings.provider === 'gemini') {
      $('engineBadge').textContent = `Gemini · ${settings.geminiModel}`;
    } else {
      $('engineBadge').textContent = `OpenAI · ${settings.openaiModel}`;
    }

    if (currentHostname) {
      $('siteDomainText').textContent = currentHostname;
      $('siteAutoToggle').disabled = false;
      $('siteAutoToggle').checked = Config.isSiteAutoEnabled(settings, currentHostname);
    } else {
      $('siteDomainText').textContent = '当前页面不支持插件注入';
      $('siteAutoToggle').disabled = true;
      $('siteAutoToggle').checked = false;
    }

    $('overlayVisibleToggle').checked = Boolean(settings.overlayVisible);
  }

  async function sendToActiveTab(payload) {
    if (!activeTab || !activeTab.id) return null;
    try {
      return await chrome.tabs.sendMessage(activeTab.id, payload);
    } catch (_) {
      return null;
    }
  }

  async function refreshPageStatus() {
    const res = await sendToActiveTab({ type: 'GET_PAGE_STATUS' });
    if (!res || !res.ok || !res.stats) {
      if (currentHostname) {
        setStatus('请按 F5 刷新当前漫画网页后生效');
      }
      return;
    }
    const s = res.stats;
    $('statDone').textContent = String(s.done || 0);
    $('statBubbles').textContent = String(s.bubblesTotal || 0);
    $('statPending').textContent = String((s.loading || 0) + (s.queued || 0));
    $('overlayVisibleToggle').checked = Boolean(s.overlayVisible);
    if ($('statusMsg').textContent === '请按 F5 刷新当前漫画网页后生效') {
      setStatus('');
    }
  }

  function collectApiForm() {
    return {
      provider: $('providerSelect').value,
      vpsBaseUrl: $('vpsBaseUrl').value.trim().replace(/\/+$/, ''),
      vpsApiToken: $('vpsApiToken').value.trim(),
      geminiApiKey: $('geminiApiKey').value.trim(),
      geminiModel: $('geminiModel').value.trim() || 'gemini-2.5-flash',
      geminiBaseUrl: $('geminiBaseUrl').value.trim() || 'https://generativelanguage.googleapis.com/v1beta',
      openaiBaseUrl: $('openaiBaseUrl').value.trim() || 'https://api.openai.com/v1',
      openaiApiKey: $('openaiApiKey').value.trim(),
      openaiModel: $('openaiModel').value.trim() || 'gpt-4o-mini'
    };
  }

  function bindEvents() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('goApiBtn').addEventListener('click', () => switchTab('api'));
    $('openOptionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('providerSelect').addEventListener('change', updateProviderVisibility);

    $('siteAutoToggle').addEventListener('change', async (e) => {
      if (!currentHostname) return;
      const enable = e.target.checked;
      let updated = await Config.toggleSiteAuto(currentHostname, enable);
      if (enable && !updated.autoTranslate) {
        updated = await Config.saveSettings({ autoTranslate: true });
      }
      renderSettingsToUi(updated);
      setStatus(enable ? `已对 ${currentHostname} 开启自动翻译` : `已暂停 ${currentHostname} 自动翻译`);
    });

    $('overlayVisibleToggle').addEventListener('change', async (e) => {
      const visible = e.target.checked;
      await Config.saveSettings({ overlayVisible: visible });
      await sendToActiveTab({ type: 'TOGGLE_OVERLAY', visible });
      setStatus(visible ? '已显示译文层' : '已隐藏译文层');
    });

    $('translatePageBtn').addEventListener('click', async () => {
      const res = await sendToActiveTab({ type: 'TRANSLATE_FULL_CHAPTER', force: false });
      if (!res) {
        setStatus('无法连接当前页面，请按 F5 刷新网页后重试');
        return;
      }
      if (!res.ok) {
        setStatus(res.error || '触发失败');
        return;
      }
      const wokeStr = res.woken > 0 ? `（唤醒 ${res.woken} 张懒图）` : '';
      setStatus(`已启动全话翻译：${res.count || 0} 张画面${wokeStr}`);
      setTimeout(refreshPageStatus, 400);
    });

    $('retranslatePageBtn').addEventListener('click', async () => {
      const res = await sendToActiveTab({ type: 'TRANSLATE_FULL_CHAPTER', force: true });
      if (!res || !res.ok) {
        setStatus((res && res.error) || '无法连接当前页面');
        return;
      }
      setStatus(`正在强制重译整话 ${res.count || 0} 张画面`);
      setTimeout(refreshPageStatus, 400);
    });

    $('exportAllBtn').addEventListener('click', async () => {
      const btn = $('exportAllBtn');
      btn.disabled = true;
      setStatus('正在合成导出高清图片...');
      const res = await sendToActiveTab({ type: 'EXPORT_ALL_TRANSLATED' });
      btn.disabled = false;
      if (!res || !res.ok) {
        setStatus((res && res.error) || '导出失败');
        return;
      }
      setStatus(`已导出 ${res.count} 张译后图`);
    });

    $('saveApiBtn').addEventListener('click', async () => {
      const updated = await Config.saveSettings(collectApiForm());
      renderSettingsToUi(updated);
      showApiMsg('配置已保存！', true);
    });

    $('testApiBtn').addEventListener('click', async () => {
      const btn = $('testApiBtn');
      btn.disabled = true;
      showApiMsg('正在测试后端连通性...', true);
      const formData = collectApiForm();
      try {
        const res = await chrome.runtime.sendMessage({ type: 'TEST_API', settings: formData });
        if (res && res.ok) {
          // 测试通过即自动保存，避免忘记点保存仍停在旧引擎
          const updated = await Config.saveSettings(formData);
          renderSettingsToUi(updated);
          showApiMsg((res.message || '连接成功！') + '（已自动保存配置）', true);
          sendToActiveTab({ type: 'TRANSLATE_PAGE', force: false });
        } else {
          showApiMsg((res && res.error) || '连接测试失败', false);
        }
      } catch (err) {
        showApiMsg(err.message || String(err), false);
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function init() {
    bindEvents();
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;
    if (activeTab && activeTab.url && /^https?:\/\//i.test(activeTab.url)) {
      try {
        currentHostname = new URL(activeTab.url).hostname;
      } catch (_) {
        currentHostname = '';
      }
    }
    const settings = await Config.loadSettings();
    renderSettingsToUi(settings);
    await refreshPageStatus();
    setInterval(refreshPageStatus, 1200);
  }

  init();
})();
