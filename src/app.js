'use strict';

const MODULES = {
  translate: {
    title: '翻译',
    eyebrow: 'GOOGLE TRANSLATE',
    subtitle: '即时翻译，跨越语言边界',
    host: 'translate.google.com',
    url: 'https://translate.google.com/?hl=zh-CN&sl=en&tl=zh-CN&op=translate',
    webviewId: 'webview-translate',
  },
  currency: {
    title: '汇率',
    eyebrow: 'WISE CURRENCY CONVERTER',
    subtitle: 'Wise 实时汇率，换汇成本一目了然',
    host: 'wise.com',
    url: 'https://wise.com/zh-cn/currency-converter/cny-to-usd-rate?amount=1000',
    webviewId: 'webview-currency',
  },
  time: {
    title: '世界时间',
    eyebrow: 'WORLD CLOCK',
    subtitle: '全球时区，一屏掌握',
    host: 'world-clock.app',
    url: 'https://world-clock.app/zh/',
    webviewId: 'webview-time',
  },
  social: {
    title: '社媒运营',
    eyebrow: 'SOCIAL DESK',
    subtitle: 'Facebook 主页 · 消息 · 广告后台',
    host: 'facebook.com',
    url: 'https://www.facebook.com/',
    webviewId: 'webview-social',
  },
  chat: {
    title: 'DeepSeek',
    eyebrow: 'DEEPSEEK CHAT',
    subtitle: 'API 直连 · 长上下文 · 深度思考',
    host: 'api.deepseek.com',
    url: 'https://chat.deepseek.com/',
    webviewId: 'webview-chat',
    lazy: true,
  },
  quote: {
    title: '报价计算器',
    eyebrow: 'QUOTE BUILDER',
    subtitle: '成本测算 · 实时预览 · 一键导出',
    host: '本地报价',
    url: '',
    webviewId: null,
    native: true,
  },
};

const TAB_ORDER = ['translate', 'currency', 'time', 'chat', 'quote', 'social'];
const ZOOM_MIN = -3;
const ZOOM_MAX = 4;

const state = {
  activeTab: 'translate',
  modules: {},
  online: navigator.onLine,
  toastTimer: null,
  initialized: false,
  tabHistory: [],
};

const elements = {
  body: document.body,
  moduleTitle: document.getElementById('moduleTitle'),
  moduleEyebrow: document.getElementById('moduleEyebrow'),
  moduleSubtitle: document.getElementById('moduleSubtitle'),
  navItems: Array.from(document.querySelectorAll('.nav-item')),
  views: Array.from(document.querySelectorAll('.view')),
  webviews: {},
  states: {},
  backButton: document.getElementById('backButton'),
  forwardButton: document.getElementById('forwardButton'),
  reloadButton: document.getElementById('reloadButton'),
  externalButton: document.getElementById('externalButton'),
  minimizeButton: document.getElementById('minimizeButton'),
  maximizeButton: document.getElementById('maximizeButton'),
  closeButton: document.getElementById('closeButton'),
  networkPill: document.getElementById('networkPill'),
  networkText: document.getElementById('networkText'),
  loadProgress: document.getElementById('loadProgress'),
  currentHost: document.getElementById('currentHost'),
  loadStatus: document.getElementById('loadStatus'),
  statusLight: document.getElementById('statusLight'),
  appVersion: document.getElementById('appVersion'),
  modalVersion: document.getElementById('modalVersion'),
  sideDate: document.getElementById('sideDate'),
  sideTime: document.getElementById('sideTime'),
  helpButton: document.getElementById('helpButton'),
  helpModal: document.getElementById('helpModal'),
  helpClose: document.getElementById('helpClose'),
  toast: document.getElementById('toast'),
  toastText: document.getElementById('toastText'),
  topbar: document.querySelector('.topbar'),
};

function initializeModuleState() {
  for (const key of TAB_ORDER) {
    const webview = MODULES[key].webviewId
      ? document.getElementById(MODULES[key].webviewId)
      : null;
    const viewState = document.querySelector(`[data-view-state="${key}"]`);
    state.modules[key] = {
      key,
      native: Boolean(MODULES[key].native),
      webview,
      viewState,
      loading: false,
      failed: false,
      everLoaded: false,
      domReady: false,
      lastError: null,
      zoom: readStoredZoom(key),
      started: false,
      contentProbeTimer: null,
      probeAttempts: 0,
      probeInFlight: false,
    };
    elements.webviews[key] = webview;
    elements.states[key] = viewState;
  }
}

function readStoredZoom(key) {
  const raw = window.localStorage.getItem(`yanjie:zoom:${key}`);
  const zoom = Number(raw);
  if (!Number.isFinite(zoom)) return 0;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

function storeZoom(key, zoom) {
  try {
    window.localStorage.setItem(`yanjie:zoom:${key}`, String(zoom));
  } catch {
    /* Local storage is optional. */
  }
}

function currentModule() {
  return state.modules[state.activeTab];
}

function getFallbackUserAgent() {
  return navigator.userAgent
    .replace(/\sElectron\/[\d.]+/i, '')
    .replace(/\sYanJie\/[\d.]+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function setViewState(key, mode) {
  const moduleState = state.modules[key];
  if (!moduleState || !moduleState.viewState) return;
  moduleState.viewState.dataset.state = mode;
}

function setErrorDetail(key, message) {
  const moduleState = state.modules[key];
  if (!moduleState) return;
  const detail = moduleState.viewState?.querySelector('.error-detail');
  if (detail) detail.textContent = message;
}

function errorMessageForCode(code) {
  switch (code) {
    case -106:
      return '网络连接已断开，请检查 Wi-Fi 或网线后重试。';
    case -105:
      return '无法解析服务器地址，请检查网络或 DNS 设置。';
    case -118:
    case -7:
      return '连接服务器超时，请稍后重试。';
    case -102:
      return '服务器拒绝了连接，请稍后重试。';
    case -200:
      return '安全证书校验失败，无法建立连接。';
    default:
      return '网络请求未能完成，请检查网络连接后重试。';
  }
}

function updateNetworkUi() {
  state.online = navigator.onLine;
  elements.networkPill.classList.toggle('is-offline', !state.online);
  elements.networkText.textContent = state.online ? '在线' : '离线';
  elements.networkPill.title = state.online ? '网络已连接' : '网络已断开';
  updateStatusBar();
}

function chatApiMode() {
  return state.activeTab === 'chat' && window.ChatApp?.getMode?.() === 'api';
}

function updateStatusBar() {
  const moduleState = currentModule();
  if (!moduleState) return;

  if (moduleState.native) {
    elements.currentHost.textContent = '本地报价';
    elements.loadStatus.textContent = '自动保存';
    elements.statusLight.classList.remove('is-busy', 'is-offline');
    return;
  }

  if (chatApiMode()) {
    elements.currentHost.textContent = 'api.deepseek.com';
    elements.loadStatus.textContent = state.online ? 'API 对话' : '网络已断开';
    elements.statusLight.classList.remove('is-busy');
    elements.statusLight.classList.toggle('is-offline', !state.online);
    return;
  }

  const webview = moduleState.webview;
  let host = MODULES[state.activeTab].host;
  let url = '';
  try {
    url = webview.getURL();
    if (url && url.startsWith('http')) host = new URL(url).hostname;
  } catch {
    /* The guest is not ready yet. */
  }

  elements.currentHost.textContent = host;
  elements.statusLight.classList.remove('is-busy', 'is-offline');

  if (!state.online) {
    elements.loadStatus.textContent = '网络已断开';
    elements.statusLight.classList.add('is-offline');
    return;
  }

  if (moduleState.failed) {
    elements.loadStatus.textContent = '连接失败';
    elements.statusLight.classList.add('is-offline');
    return;
  }

  if (moduleState.loading || !moduleState.everLoaded) {
    elements.loadStatus.textContent = moduleState.loading ? '正在加载' : '等待连接';
    elements.statusLight.classList.add('is-busy');
    return;
  }

  elements.loadStatus.textContent = '已连接';
}

function updateProgress() {
  const moduleState = currentModule();
  const loading = Boolean(moduleState?.loading && !moduleState.native);
  elements.loadProgress.classList.toggle('is-loading', loading);
}

function updateNavigationButtons() {
  const moduleState = currentModule();
  if (!moduleState || moduleState.native) {
    elements.backButton.disabled = true;
    elements.forwardButton.disabled = true;
    elements.reloadButton.disabled = true;
    elements.externalButton.disabled = true;
    return;
  }

  if (chatApiMode()) {
    elements.backButton.disabled = true;
    elements.forwardButton.disabled = true;
    elements.reloadButton.disabled = true;
    elements.externalButton.disabled = false;
    return;
  }

  elements.reloadButton.disabled = false;
  elements.externalButton.disabled = false;
  let canGoBack = false;
  let canGoForward = false;
  try {
    canGoBack = moduleState.webview.canGoBack();
    canGoForward = moduleState.webview.canGoForward();
  } catch {
    /* Not attached yet. */
  }
  elements.backButton.disabled = !canGoBack;
  elements.forwardButton.disabled = !canGoForward;
}

function updateTabUi() {
  const module = MODULES[state.activeTab];
  elements.body.dataset.tab = state.activeTab;
  elements.moduleTitle.textContent = module.title;
  elements.moduleEyebrow.textContent = module.eyebrow;
  elements.moduleSubtitle.textContent = module.subtitle;
  document.title = `${module.title} · 言界`;

  for (const item of elements.navItems) {
    const active = item.dataset.tab === state.activeTab;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  }

  for (const view of elements.views) {
    view.classList.toggle('is-active', view.dataset.view === state.activeTab);
  }

  const moduleState = currentModule();
  if (moduleState.native) {
    updateProgress();
    updateNavigationButtons();
    updateStatusBar();
    window.QuoteApp?.onActivate();
    return;
  }

  if (state.activeTab === 'chat') {
    if (window.ChatApp?.getMode?.() === 'api') {
      updateProgress();
      updateNavigationButtons();
      updateStatusBar();
      return;
    }
    ensureWebview('chat');
  }

  if (moduleState.everLoaded) {
    setViewState(state.activeTab, 'none');
  } else if (moduleState.failed) {
    setViewState(state.activeTab, 'error');
  } else {
    setViewState(state.activeTab, 'loading');
  }

  updateProgress();
  updateNavigationButtons();
  updateStatusBar();
}

function activateTab(key) {
  if (!MODULES[key]) return false;
  state.activeTab = key;
  const stackLine = String(new Error().stack || '')
    .split('\n')
    .slice(2, 4)
    .join(' <- ')
    .trim();
  state.tabHistory.push({ at: Date.now(), key, stackLine });
  if (state.tabHistory.length > 30) state.tabHistory.shift();
  updateTabUi();
  if (key === 'chat' && window.ChatApp?.getMode?.() === 'api') {
    window.ChatApp?.focus?.();
  }
  return true;
}

function clearContentProbe(moduleState) {
  if (moduleState.contentProbeTimer) {
    window.clearTimeout(moduleState.contentProbeTimer);
    moduleState.contentProbeTimer = null;
  }
  moduleState.probeInFlight = false;
}

function hideLoadingOnSuccess(key) {
  const moduleState = state.modules[key];
  if (!moduleState) return;
  clearContentProbe(moduleState);
  moduleState.everLoaded = true;
  moduleState.loading = false;
  moduleState.failed = false;
  moduleState.lastError = null;
  setViewState(key, 'none');
  if (state.activeTab === key) {
    updateProgress();
    updateNavigationButtons();
    updateStatusBar();
  }
}

function scheduleContentProbe(key, delayMs) {
  const moduleState = state.modules[key];
  if (!moduleState || moduleState.everLoaded) return;
  window.clearTimeout(moduleState.contentProbeTimer);
  moduleState.probeAttempts = 0;
  moduleState.contentProbeTimer = window.setTimeout(
    () => probeContentReady(key),
    delayMs
  );
}

function probeContentReady(key) {
  const moduleState = state.modules[key];
  if (!moduleState || moduleState.everLoaded || moduleState.failed) return;
  if (moduleState.probeInFlight) return;

  moduleState.probeInFlight = true;
  moduleState.probeAttempts += 1;

  let probe;
  try {
    probe = moduleState.webview.executeJavaScript(
      `(() => {
        const body = document.body;
        return {
          hasBody: Boolean(body),
          textLength: body ? body.innerText.trim().length : 0,
          readyState: document.readyState,
          title: document.title,
        };
      })()`,
      true
    );
  } catch {
    moduleState.probeInFlight = false;
    if (moduleState.probeAttempts < 16) {
      moduleState.contentProbeTimer = window.setTimeout(
        () => probeContentReady(key),
        750
      );
    }
    return;
  }

  Promise.resolve(probe)
    .then((result) => {
      moduleState.probeInFlight = false;
      if (moduleState.everLoaded || moduleState.failed) return;
      const hasUsableContent =
        result &&
        result.hasBody &&
        (result.textLength > 20 ||
          result.readyState === 'complete' ||
          moduleState.probeAttempts >= 8);

      if (hasUsableContent) {
        hideLoadingOnSuccess(key);
        return;
      }
      if (moduleState.probeAttempts < 18) {
        moduleState.contentProbeTimer = window.setTimeout(
          () => probeContentReady(key),
          750
        );
      }
    })
    .catch(() => {
      moduleState.probeInFlight = false;
      if (moduleState.probeAttempts < 18) {
        moduleState.contentProbeTimer = window.setTimeout(
          () => probeContentReady(key),
          750
        );
      }
    });
}

function handleLoadStart(key) {
  const moduleState = state.modules[key];
  if (!moduleState) return;
  moduleState.loading = true;
  moduleState.failed = false;

  if (!moduleState.everLoaded) {
    setViewState(key, 'loading');
  }

  if (state.activeTab === key) {
    updateProgress();
    updateStatusBar();
  }
}

function handleLoadStop(key) {
  const moduleState = state.modules[key];
  if (!moduleState) return;
  moduleState.loading = false;

  if (!moduleState.failed && !moduleState.everLoaded) {
    hideLoadingOnSuccess(key);
  }

  if (state.activeTab === key) {
    updateProgress();
    updateNavigationButtons();
    updateStatusBar();
  }
}

function handleLoadFailure(key, event) {
  if (!event || event.errorCode === -3 || event.isMainFrame === false) return;
  const moduleState = state.modules[key];
  if (!moduleState) return;

  clearContentProbe(moduleState);
  moduleState.loading = false;
  moduleState.failed = true;
  moduleState.lastError = event.errorCode;
  setErrorDetail(key, errorMessageForCode(event.errorCode));
  setViewState(key, 'error');

  if (state.activeTab === key) {
    updateProgress();
    updateStatusBar();
  }
}

function handleNavigate(key, url) {
  if (!url || !url.startsWith('http')) return;
  if (state.activeTab === key) {
    updateNavigationButtons();
    updateStatusBar();
  }
}

function attachWebviewEvents(key, webview) {
  webview.addEventListener('dom-ready', () => {
    const moduleState = state.modules[key];
    moduleState.domReady = true;
    try {
      webview.setZoomLevel(moduleState.zoom);
    } catch {
      /* Zoom is progressive enhancement. */
    }
    if (!moduleState.everLoaded) scheduleContentProbe(key, 900);
    if (state.activeTab === key) updateNavigationButtons();
  });

  webview.addEventListener('did-start-loading', () => handleLoadStart(key));
  webview.addEventListener('did-stop-loading', () => handleLoadStop(key));
  webview.addEventListener('did-finish-load', () => {
    if (state.modules[key].failed) return;
    hideLoadingOnSuccess(key);
  });

  webview.addEventListener('did-fail-load', (event) => handleLoadFailure(key, event));
  webview.addEventListener('did-navigate', (event) => handleNavigate(key, event.url));
  webview.addEventListener('did-navigate-in-page', (event) => {
    if (event.isMainFrame) handleNavigate(key, event.url);
  });

  webview.addEventListener('context-menu', (event) => {
    event.preventDefault();
    let webContentsId;
    try {
      webContentsId = webview.getWebContentsId();
    } catch {
      return;
    }
    window.desktop.showWebviewMenu({
      webContentsId,
      x: event.params?.x || 0,
      y: event.params?.y || 0,
      linkURL: event.params?.linkURL || '',
      srcURL: event.params?.srcURL || '',
      selectionText: event.params?.selectionText || '',
      isEditable: Boolean(event.params?.isEditable),
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
    });
  });
}

function ensureWebview(key) {
  const moduleState = state.modules[key];
  if (!moduleState || moduleState.native) return;
  if (moduleState.started) return;
  startModule(key, 0);
}

function startModule(key, delayMs) {
  const moduleState = state.modules[key];
  if (!moduleState || moduleState.started || moduleState.native) return;
  moduleState.started = true;
  const begin = () => {
    if (!moduleState.started) return;
    try {
      moduleState.webview.setAttribute('src', MODULES[key].url);
    } catch {
      moduleState.failed = true;
      setErrorDetail(key, '内置浏览器初始化失败，请重启应用后重试。');
      setViewState(key, 'error');
    }
  };
  if (delayMs) window.setTimeout(begin, delayMs);
  else begin();
}

function focusActiveWebview() {
  const webview = currentModule()?.webview;
  if (!webview) return;
  try {
    webview.focus();
  } catch {
    /* Ignore focus failures. */
  }
}

function handleExternalOpen() {
  const moduleState = currentModule();
  if (!moduleState || moduleState.native) {
    showToast('报价单可直接导出为 PDF 或 Excel');
    return;
  }
  let url = MODULES[state.activeTab].url;
  try {
    const current = moduleState.webview.getURL();
    if (current && current.startsWith('http')) url = current;
  } catch {
    /* Use the module home URL. */
  }
  window.desktop.openExternal(url).then((opened) => {
    if (opened) showToast('已在默认浏览器中打开');
    else showToast('无法打开该链接', { error: true });
  });
}

function retryActiveModule() {
  const key = state.activeTab;
  const moduleState = state.modules[key];
  if (!moduleState || moduleState.native) return;
  moduleState.failed = false;
  moduleState.loading = true;
  setViewState(key, 'loading');
  updateProgress();
  updateStatusBar();
  try {
    moduleState.webview.loadURL(MODULES[key].url);
  } catch {
    moduleState.webview.setAttribute('src', MODULES[key].url);
  }
  scheduleContentProbe(key, 1800);
}

function reloadActiveModule() {
  const moduleState = currentModule();
  if (!moduleState || moduleState.native) {
    window.QuoteApp?.onReloadShortcut();
    return;
  }
  if (chatApiMode()) {
    window.ChatApp?.focus?.();
    showToast('API 对话无需刷新页面');
    return;
  }
  if (moduleState.failed) {
    retryActiveModule();
    return;
  }

  elements.reloadButton.classList.add('is-spinning');
  window.setTimeout(() => elements.reloadButton.classList.remove('is-spinning'), 850);

  try {
    moduleState.webview.reload();
  } catch {
    retryActiveModule();
  }
}

function goBack() {
  if (currentModule()?.native) return;
  try {
    const webview = currentModule().webview;
    if (webview.canGoBack()) webview.goBack();
  } catch {
    /* Ignore. */
  }
}

function goForward() {
  if (currentModule()?.native) return;
  try {
    const webview = currentModule().webview;
    if (webview.canGoForward()) webview.goForward();
  } catch {
    /* Ignore. */
  }
}

function zoomActive(delta) {
  const moduleState = currentModule();
  if (!moduleState) return;
  if (moduleState.native) {
    showToast('报价页使用固定排版，导出 PDF 不受缩放影响');
    return;
  }
  const next = Math.min(
    ZOOM_MAX,
    Math.max(ZOOM_MIN, Math.round((moduleState.zoom + delta) * 10) / 10)
  );
  moduleState.zoom = next;
  storeZoom(moduleState.key, next);
  try {
    moduleState.webview.setZoomLevel(next);
  } catch {
    /* Ignore. */
  }
  const percent = Math.round(Math.pow(1.2, next) * 100);
  showToast(`页面缩放 ${percent}%`);
}

function resetZoom() {
  const moduleState = currentModule();
  if (!moduleState) return;
  if (moduleState.native) {
    showToast('报价页使用固定排版，导出 PDF 不受缩放影响');
    return;
  }
  moduleState.zoom = 0;
  storeZoom(moduleState.key, 0);
  try {
    moduleState.webview.setZoomLevel(0);
  } catch {
    /* Ignore. */
  }
  showToast('页面缩放已重置为 100%');
}

function showToast(message, options = {}) {
  window.clearTimeout(state.toastTimer);
  elements.toastText.textContent = message;
  elements.toast.classList.toggle('is-error', Boolean(options.error));
  elements.toast.classList.add('is-visible');
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove('is-visible');
  }, options.duration || 2600);
}

function openHelp() {
  elements.helpModal.hidden = false;
  elements.helpClose.focus();
}

function closeHelp() {
  if (elements.helpModal.hidden) return;
  elements.helpModal.hidden = true;
  elements.helpButton.focus();
}

function updateClock() {
  const now = new Date();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  elements.sideDate.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${weekdays[now.getDay()]}`;
  elements.sideTime.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes()
  ).padStart(2, '0')}`;
}

function refreshWindowState() {
  window.desktop.isMaximized().then((maximized) => {
    elements.body.classList.toggle('is-maximized', Boolean(maximized));
    elements.maximizeButton.title = maximized ? '还原' : '最大化';
    elements.maximizeButton.setAttribute('aria-label', maximized ? '还原' : '最大化');
  });
}

function bindUi() {
  for (const item of elements.navItems) {
    item.addEventListener('click', () => {
      activateTab(item.dataset.tab);
      window.desktop.isMaximized().then((maximized) => {
        elements.body.classList.toggle('is-maximized', Boolean(maximized));
      });
    });
  }

  elements.backButton.addEventListener('click', goBack);
  elements.forwardButton.addEventListener('click', goForward);
  elements.reloadButton.addEventListener('click', reloadActiveModule);
  elements.externalButton.addEventListener('click', handleExternalOpen);

  elements.minimizeButton.addEventListener('click', () => window.desktop.minimize());
  elements.maximizeButton.addEventListener('click', () => {
    window.desktop.toggleMaximize();
    window.setTimeout(refreshWindowState, 120);
  });
  elements.closeButton.addEventListener('click', () => window.desktop.close());

  elements.topbar.addEventListener('dblclick', (event) => {
    if (event.target.closest('button, .tool-group, .window-controls, .network-pill')) return;
    window.desktop.toggleMaximize();
    window.setTimeout(refreshWindowState, 120);
  });

  document.querySelectorAll('.retry-button').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.closest('[data-view-state]')?.dataset.viewState;
      if (key && key !== state.activeTab) activateTab(key);
      retryActiveModule();
    });
  });

  document.querySelectorAll('.external-fallback').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.closest('[data-view-state]')?.dataset.viewState;
      if (key && key !== state.activeTab) activateTab(key);
      handleExternalOpen();
    });
  });

  elements.helpButton.addEventListener('click', openHelp);
  elements.helpClose.addEventListener('click', closeHelp);
  elements.helpModal.addEventListener('click', (event) => {
    if (event.target === elements.helpModal) closeHelp();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.helpModal.hidden) {
      event.preventDefault();
      closeHelp();
    }
  });

  window.addEventListener('online', () => {
    updateNetworkUi();
    showToast('网络已恢复连接');
  });

  window.addEventListener('offline', () => {
    updateNetworkUi();
    showToast('网络连接已断开', { error: true, duration: 3600 });
  });

  window.desktop.onWindowState((payload) => {
    elements.body.classList.toggle('is-maximized', Boolean(payload?.maximized));
    elements.maximizeButton.title = payload?.maximized ? '还原' : '最大化';
  });

  window.desktop.onShortcut((shortcut) => {
    if (shortcut.startsWith('tab:')) {
      const index = Number(shortcut.split(':')[1]) - 1;
      if (TAB_ORDER[index]) activateTab(TAB_ORDER[index]);
      return;
    }

    if (shortcut === 'page:reload') reloadActiveModule();
    else if (shortcut === 'page:external') handleExternalOpen();
    else if (shortcut === 'page:back') goBack();
    else if (shortcut === 'page:forward') goForward();
    else if (shortcut === 'zoom:in') zoomActive(0.5);
    else if (shortcut === 'zoom:out') zoomActive(-0.5);
    else if (shortcut === 'zoom:reset') resetZoom();
  });

  window.desktop.onDownloadComplete((download) => {
    showToast(`已下载：${download?.name || '文件'}`, { duration: 4200 });
  });
}

async function bootstrap() {
  initializeModuleState();

  try {
    await window.ChatApp?.init?.();
  } catch (error) {
    console.error('[yanjie] chat init failed', error);
  }

  let info = null;
  try {
    info = await window.desktop.getInfo();
  } catch {
    info = null;
  }

  const userAgent = info?.userAgent || getFallbackUserAgent();
  for (const key of TAB_ORDER) {
    const webview = elements.webviews[key];
    if (!webview) continue;
    webview.setAttribute('useragent', userAgent);
    attachWebviewEvents(key, webview);
  }

  elements.appVersion.textContent = `v${info?.version || '1.2.0'}`;
  elements.modalVersion.textContent = `言界 ${info?.version || '1.2.0'}`;
  window.showYanjieToast = showToast;

  bindUi();
  updateNetworkUi();
  updateClock();
  window.setInterval(updateClock, 15000);
  activateTab('translate');

  startModule('translate', 0);
  startModule('currency', 450);
  startModule('time', 900);
  startModule('social', 1350);
  // DeepSeek starts lazily: API mode needs no page load, web mode loads on demand.
  if (window.ChatApp?.getMode?.() === 'web') startModule('chat', 1200);

  window.YanjieShell = {
    ensureWebview,
    refreshChrome: () => {
      updateProgress();
      updateNavigationButtons();
      updateStatusBar();
    },
    showToast,
  };
  window.QuoteApp?.onShellReady?.();
  refreshWindowState();
  state.initialized = true;

  window.setTimeout(() => updateNavigationButtons(), 1200);
}

window.__YJ_TEST__ = {
  isReady: () => state.initialized,
  activate: (key) => {
    activateTab(key);
    return state.activeTab;
  },
  zoomActive: (delta) => zoomActive(delta),
  stats: () => ({
    active: state.activeTab,
    online: state.online,
    chatMode: window.ChatApp?.getMode?.() || null,
    chatStreaming: window.ChatApp?.isStreaming?.() || false,
    size: { width: window.innerWidth, height: window.innerHeight },
    tabHistory: state.tabHistory,
    ui: {
      datasetTab: document.body.dataset.tab,
      header: elements.moduleTitle.textContent,
      activeNav: document.querySelector('.nav-item.is-active')?.dataset.tab || '',
      activeView: document.querySelector('.view.is-active')?.dataset.view || '',
      stateOpacity: (() => {
        const el = document.querySelector('.view.is-active .view-state');
        return el ? getComputedStyle(el).opacity : null;
      })(),
      webviewRect: (() => {
        const el = document.querySelector('.view.is-active .webview');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })(),
    },
    tabs: TAB_ORDER.map((key) => {
      const moduleState = state.modules[key];
      let url = '';
      let title = '';
      let webContentsId = null;
      try {
        url = moduleState.webview?.getURL() || '';
        title = moduleState.webview?.getTitle() || '';
        webContentsId = moduleState.webview?.getWebContentsId() || null;
      } catch {
        /* Guest not ready. */
      }
      const apiMode = key === 'chat' && window.ChatApp?.getMode?.() === 'api';
      return {
        key,
        url,
        title,
        webContentsId,
        native: Boolean(moduleState.native),
        loading: apiMode ? false : moduleState.loading,
        loaded: moduleState.native || apiMode ? true : moduleState.everLoaded,
        failed: apiMode ? false : moduleState.failed,
        errorCode: moduleState.lastError,
        state: moduleState.viewState?.dataset.state || '',
      };
    }),
  }),
};

bootstrap().catch((error) => {
  console.error('[yanjie] bootstrap failed', error);
  showToast('应用初始化失败，请重启后重试', { error: true, duration: 5000 });
});
