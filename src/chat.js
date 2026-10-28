'use strict';

/*
 * DeepSeek API conversation workspace.
 *
 * All network traffic happens in the main process (see electron/main.js);
 * this module only renders state, streams deltas back into the bubbles and
 * keeps the conversation on disk via localStorage.
 */
(() => {
  const THREAD_KEY = 'yanjie:chat:thread:v1';
  const MODE_KEY = 'yanjie:chat:mode:v1';
  const MAX_STORED_MESSAGES = 60;
  const SYSTEM_PROMPT = [
    '你是「言界」桌面工作台里的外贸业务助手，服务对象是中国重型商用车（SHACMAN、HOWO 等）出口商的外贸经理。',
    '回答要求：',
    '1. 中文提问用中文回答；要求英文邮件、话术或条款时，直接给出可直接复制的英文原文，并在需要时附中文说明。',
    '2. 涉及报价时，主动提示汇率、贸易术语（FOB/CIF/CFR/DDP）、付款方式与收款风险。',
    '3. 结构清晰，能用要点就不用长段落；不编造客户背景、公司信息或数据，不确定就说明不确定。',
    '4. 不输出与外贸、商务沟通、翻译、报价无关的长篇内容。',
  ].join('\n');

  const state = {
    mode: 'api',
    config: null,
    messages: [],
    streaming: false,
    requestId: null,
    usage: null,
    quoteContext: false,
    settingsOpen: false,
  };

  let els = null;
  let rafPending = false;
  let saveTimer = null;

  const now = () => Date.now();

  function uid() {
    return `m-${now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[character];
    });
  }

  function safeUrl(url) {
    return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
  }

  /* ----------------------------- markdown ----------------------------- */

  function inline(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。]|$)/g, '$1<em>$2</em>');
    html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
      const href = safeUrl(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
        : label;
    });
    return html;
  }

  function renderTable(rows) {
    const cells = rows.map((row) =>
      row
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((cell) => cell.trim())
    );
    const [head, ...body] = cells;
    const headHtml = `<thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`;
    const bodyHtml = `<tbody>${body
      .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
      .join('')}</tbody>`;
    return `<table>${headHtml}${bodyHtml}</table>`;
  }

  function renderMarkdown(source) {
    const text = String(source || '').replace(/\r\n/g, '\n');
    const blocks = [];
    const withPlaceholders = text.replace(/```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const index = blocks.length;
      blocks.push(
        `<pre><code data-lang="${escapeHtml(lang || '')}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`
      );
      return `\u0000CODE${index}\u0000`;
    });

    const lines = withPlaceholders.split('\n');
    const out = [];
    let paragraph = [];
    let list = null;
    let table = null;
    let quote = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      out.push(`<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.type}>`);
      list = null;
    };
    const flushTable = () => {
      if (!table) return;
      out.push(renderTable(table));
      table = null;
    };
    const flushQuote = () => {
      if (!quote.length) return;
      out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
      quote = [];
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
      flushTable();
      flushQuote();
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');
      const trimmed = line.trim();

      if (!trimmed) {
        flushAll();
        continue;
      }

      if (/^\u0000CODE\d+\u0000$/.test(trimmed)) {
        flushAll();
        out.push(trimmed);
        continue;
      }

      if (/^#{1,6}\s+/.test(trimmed)) {
        flushAll();
        const level = Math.min(4, trimmed.match(/^#+/)[0].length);
        out.push(`<h${level}>${inline(trimmed.replace(/^#+\s+/, ''))}</h${level}>`);
        continue;
      }

      if (/^(---+|\*\*\*+)$/.test(trimmed)) {
        flushAll();
        out.push('<hr>');
        continue;
      }

      if (/^\|.*\|$/.test(trimmed) && trimmed.split('|').length >= 3) {
        flushParagraph();
        flushList();
        flushQuote();
        if (/^\|[\s:|-]+\|$/.test(trimmed)) {
          continue;
        }
        table = table || [];
        table.push(trimmed);
        continue;
      }
      flushTable();

      if (/^>\s?/.test(trimmed)) {
        flushParagraph();
        flushList();
        quote.push(trimmed.replace(/^>\s?/, ''));
        continue;
      }
      flushQuote();

      const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        if (!list || list.type !== 'ul') {
          flushList();
          list = { type: 'ul', items: [] };
        }
        list.items.push(bullet[1]);
        continue;
      }

      const ordered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
      if (ordered) {
        flushParagraph();
        if (!list || list.type !== 'ol') {
          flushList();
          list = { type: 'ol', items: [] };
        }
        list.items.push(ordered[2]);
        continue;
      }
      flushList();

      paragraph.push(trimmed);
    }

    flushAll();
    return out.join('').replace(/\u0000CODE(\d+)\u0000/g, (_m, index) => blocks[Number(index)] || '');
  }

  /* ----------------------------- state io ----------------------------- */

  function loadThread() {
    try {
      const raw = window.localStorage.getItem(THREAD_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
        .filter((message) => typeof message.content === 'string')
        .slice(-MAX_STORED_MESSAGES)
        .map((message) => ({
          id: message.id || uid(),
          role: message.role,
          content: message.content,
          reasoning: typeof message.reasoning === 'string' ? message.reasoning : '',
          ts: Number(message.ts) || now(),
          usage: message.usage || null,
        }));
    } catch {
      return [];
    }
  }

  function saveThread() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        const payload = state.messages
          .filter((message) => message.content.trim())
          .slice(-MAX_STORED_MESSAGES)
          .map(({ id, role, content, reasoning, ts, usage }) => ({
            id,
            role,
            content,
            reasoning: reasoning || '',
            ts,
            usage: usage || null,
          }));
        window.localStorage.setItem(THREAD_KEY, JSON.stringify(payload));
      } catch {
        /* storage may be unavailable */
      }
    }, 220);
  }

  function loadMode() {
    try {
      const stored = window.localStorage.getItem(MODE_KEY);
      return stored === 'web' ? 'web' : 'api';
    } catch {
      return 'api';
    }
  }

  function storeMode(mode) {
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }

  /* ----------------------------- rendering ----------------------------- */

  function messageMarkup(message) {
    const isUser = message.role === 'user';
    const reasoning = message.reasoning
      ? `<details class="chat-reasoning"${message.streaming ? ' open' : ''}>
           <summary>思考过程</summary>
           <div class="chat-reasoning-body">${escapeHtml(message.reasoning)}</div>
         </details>`
      : '';
    const body = message.content
      ? renderMarkdown(message.content)
      : message.streaming
        ? '<span class="chat-typing"><i></i><i></i><i></i></span>'
        : '';
    const textBlock = message.streaming
      ? `<div class="chat-text" data-text>${body}</div>`
      : body;
    const meta = [];
    if (message.ts && !message.streaming) {
      meta.push(new Date(message.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    }
    if (message.usage?.total_tokens) {
      meta.push(`${message.usage.prompt_tokens || 0} 输入 / ${message.usage.completion_tokens || 0} 输出 tokens`);
    }
    const metaHtml = isUser || message.streaming
      ? ''
      : `<div class="chat-msg-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
           <button class="chat-msg-copy" type="button" data-copy="${message.id}">复制</button>
         </div>`;
    const errorHtml = message.error
      ? `<div class="chat-error">${escapeHtml(message.error)}
           ${message.retryable ? '<button type="button" data-retry="1">重试</button>' : ''}
         </div>`
      : '';

    return `
      <div class="chat-msg ${isUser ? 'is-user' : 'is-assistant'}" data-id="${escapeHtml(message.id)}">
        <div class="chat-avatar">${isUser ? '我' : 'AI'}</div>
        <div class="chat-bubble">
          ${reasoning}
          ${textBlock}
          ${errorHtml}
          ${metaHtml}
        </div>
      </div>
    `;
  }

  /* Patch only the streaming bubble so history is not re-parsed every delta. */
  function patchStreaming(message) {
    const node = els.messages.querySelector(`[data-id="${message.id}"]`);
    if (!node) {
      scheduleRender();
      return;
    }
    const text = node.querySelector('[data-text]');
    const reasoning = node.querySelector('.chat-reasoning-body');
    if (!text) {
      scheduleRender();
      return;
    }
    text.innerHTML = message.content
      ? renderMarkdown(message.content)
      : '<span class="chat-typing"><i></i><i></i><i></i></span>';

    if (message.reasoning) {
      const details = node.querySelector('.chat-reasoning');
      if (!details) {
        const bubble = node.querySelector('.chat-bubble');
        const wrapper = document.createElement('details');
        wrapper.className = 'chat-reasoning';
        wrapper.open = !message.content;
        wrapper.innerHTML =
          '<summary>思考过程</summary><div class="chat-reasoning-body"></div>';
        bubble.insertBefore(wrapper, bubble.firstChild);
      }
      const body = node.querySelector('.chat-reasoning-body');
      if (body) {
        const pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
        body.textContent = message.reasoning;
        if (pinned) body.scrollTop = body.scrollHeight;
      }
    }
    scrollToBottom();
  }

  function renderThread(options = {}) {
    const hasMessages = state.messages.length > 0;
    els.empty.hidden = hasMessages;
    els.messages.innerHTML = state.messages.map(messageMarkup).join('');
    if (options.scroll !== false) scrollToBottom(options.force === true);
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    window.requestAnimationFrame(() => {
      rafPending = false;
      renderThread({ scroll: true });
    });
  }

  function isNearBottom() {
    const el = els.thread;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function scrollToBottom(force = false) {
    const el = els.thread;
    if (!force && !isNearBottom()) return;
    window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }

  /* ----------------------------- config ui ----------------------------- */

  function syncModelOptions(config) {
    const models =
      Array.isArray(config?.models) && config.models.length
        ? config.models
        : ['deepseek-chat', 'deepseek-reasoner'];
    for (const select of [els?.model, els?.settingsModel]) {
      if (!select) continue;
      const current = select.value;
      const next = models.includes(config?.model)
        ? config.model
        : models.includes(current)
          ? current
          : models[0];
      select.innerHTML = models
        .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
        .join('');
      select.value = next;
    }
  }

  function renderConfigState() {
    const config = state.config || {};
    syncModelOptions(config);
    const ready = Boolean(config.hasKey);
    els.keyState.classList.toggle('is-ready', ready);
    els.keyState.innerHTML = ready
      ? `<i></i>API 已连接 · ${escapeHtml(config.keyMask || '')}`
      : '<i></i>未配置 API Key';
    if (els.model && config.model) els.model.value = config.model;
    if (els.settingsModel && config.model) els.settingsModel.value = config.model;
    if (els.baseUrl && !state.settingsOpen) els.baseUrl.value = config.baseUrl || '';
    if (els.temperature && !state.settingsOpen) {
      els.temperature.value = String(config.temperature ?? 1);
    }
    els.send.disabled = false;
    updateHint();
  }

  function updateHint() {
    const config = state.config;
    if (!config) {
      els.hint.textContent = '';
      return;
    }
    if (!config.hasKey) {
      els.hint.textContent = '未配置 Key，点击右上角设置填写';
      return;
    }
    const count = state.messages.filter((message) => message.role === 'user').length;
    els.hint.textContent = count
      ? `${count} 轮对话 · 上下文自动携带`
      : state.usage?.total_tokens
        ? `上次用量 ${state.usage.total_tokens} tokens`
        : 'Key 已保存于本机密钥库';
  }

  function setSettingsStatus(message, type = '') {
    els.settingsStatus.textContent = message || '';
    els.settingsStatus.classList.toggle('is-ok', type === 'ok');
    els.settingsStatus.classList.toggle('is-error', type === 'error');
  }

  async function openSettings() {
    state.settingsOpen = true;
    els.modal.hidden = false;
    els.apiKey.value = '';
    const config = state.config || (await loadConfig());
    els.baseUrl.value = config.baseUrl || 'https://api.deepseek.com';
    els.settingsModel.value = config.model || 'deepseek-chat';
    els.temperature.value = String(config.temperature ?? 1);
    els.apiKey.placeholder = config.hasKey
      ? `已保存 ${config.keyMask || ''} · 留空则保持不变`
      : 'sk-xxxxxxxxxxxxxxxx';
    setSettingsStatus(
      config.hasKey
        ? `当前 Key 已加密保存在本机（${config.keyStorage === 'base64' ? '未启用系统密钥库' : '系统密钥库'}）`
        : '尚未配置。到 platform.deepseek.com 创建 API Key 后粘贴到这里。'
    );
    els.apiKey.focus();
  }

  function closeSettings() {
    state.settingsOpen = false;
    els.modal.hidden = true;
    setSettingsStatus('');
  }

  async function loadConfig() {
    try {
      state.config = await window.deepseekApi.getConfig();
    } catch (error) {
      state.config = { hasKey: false, model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' };
      els.hint.textContent = `读取配置失败：${error.message || '未知错误'}`;
    }
    renderConfigState();
    return state.config;
  }

  async function saveSettings() {
    const payload = {
      baseUrl: els.baseUrl.value.trim() || 'https://api.deepseek.com',
      model: els.settingsModel.value,
      temperature: Number(els.temperature.value || 1),
    };
    if (els.apiKey.value.trim()) payload.apiKey = els.apiKey.value.trim();
    els.saveKey.disabled = true;
    setSettingsStatus('正在保存…');
    try {
      state.config = await window.deepseekApi.saveConfig(payload);
      renderConfigState();
      els.apiKey.value = '';
      setSettingsStatus('设置已保存。', 'ok');
      window.setTimeout(closeSettings, 600);
    } catch (error) {
      setSettingsStatus(error.message || '保存失败', 'error');
    } finally {
      els.saveKey.disabled = false;
    }
  }

  async function testSettings() {
    els.testKey.disabled = true;
    setSettingsStatus('正在测试连接…');
    try {
      if (els.apiKey.value.trim()) {
        state.config = await window.deepseekApi.saveConfig({
          apiKey: els.apiKey.value.trim(),
          baseUrl: els.baseUrl.value.trim() || 'https://api.deepseek.com',
          model: els.settingsModel.value,
          temperature: Number(els.temperature.value || 1),
        });
        els.apiKey.value = '';
        renderConfigState();
      }
      const result = await window.deepseekApi.testConnection();
      setSettingsStatus(result.message || (result.ok ? '连接正常' : '连接失败'), result.ok ? 'ok' : 'error');
    } catch (error) {
      setSettingsStatus(error.message || '测试失败', 'error');
    } finally {
      els.testKey.disabled = false;
    }
  }

  async function clearKey() {
    if (!window.confirm('确定删除本机保存的 API Key 吗？')) return;
    try {
      state.config = await window.deepseekApi.saveConfig({ clearKey: true });
      renderConfigState();
      setSettingsStatus('已清除 API Key。', 'ok');
    } catch (error) {
      setSettingsStatus(error.message || '清除失败', 'error');
    }
  }

  /* ----------------------------- conversation ----------------------------- */

  function buildMessages() {
    const history = state.messages
      .filter((message) => !message.error)
      .filter((message) => typeof message.content === 'string' && message.content.trim())
      .map((message) => ({ role: message.role, content: message.content }));
    return [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  }

  function quoteSummaryText() {
    const quote = window.QuoteApp;
    if (!quote || typeof quote.getSummary !== 'function') return '';
    try {
      const data = quote.getData();
      const summary = quote.getSummary();
      if (!data || !summary || !summary.itemCount) return '';
      const currency = data.currency || 'USD';
      return [
        `【当前报价单】单号 ${data.quoteNo || '—'}，客户 ${data.customer || '未填写'}，`,
        `目的港 ${data.destination || '未填写'}，贸易术语 ${data.tradeTerm}，币种 ${currency}，汇率 1 ${currency} = ${data.rates?.[currency] || '—'} CNY。`,
        `产品共 ${summary.itemCount} 项：`,
        ...(data.items || []).map(
          (item, index) =>
            `${index + 1}. ${item.name || '未命名'}（${item.spec || '无规格'}）× ${item.qty} ${item.unit}，成本 ${item.costCny} CNY/${item.unit}`
        ),
        `总成本 ${summary.totalCost} ${currency}，折扣 ${data.discountRate || 0}%，报价总额 ${summary.total} ${currency}，预计毛利 ${summary.grossProfit} ${currency}（毛利率 ${summary.grossMargin.toFixed(1)}%）。`,
        `付款方式：${data.payment || '未填写'}；交货期：${data.delivery || '未填写'}。`,
      ].join('\n');
    } catch {
      return '';
    }
  }

  function appendLocalNotice(text, type = 'error') {
    state.messages.push({
      id: uid(),
      role: 'assistant',
      content: '',
      reasoning: '',
      ts: now(),
      error: text,
      errorType: type,
    });
    renderThread({ scroll: true, force: true });
    saveThread();
  }

  async function send() {
    if (state.streaming) return;
    const text = els.input.value.trim();
    if (!text) return;
    if (!state.config?.hasKey) {
      // The key may have been configured elsewhere (e.g. settings modal or a
      // previous session) — re-read before refusing the request.
      await loadConfig();
    }
    if (!state.config?.hasKey) {
      openSettings();
      setSettingsStatus('请先填写 DeepSeek API Key。', 'error');
      return;
    }

    const content = state.quoteContext ? `${quoteSummaryText()}\n\n${text}`.trim() : text;
    state.messages.push({ id: uid(), role: 'user', content, ts: now() });
    if (state.quoteContext) {
      state.quoteContext = false;
      els.quoteContext.classList.remove('is-on');
    }
    els.input.value = '';
    autoGrow();

    const assistant = {
      id: uid(),
      role: 'assistant',
      content: '',
      reasoning: '',
      ts: now(),
      streaming: true,
    };
    state.messages.push(assistant);

    state.streaming = true;
    state.requestId = `req-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    setStreamingUi(true);
    renderThread({ scroll: true, force: true });
    saveThread();

    window.deepseekApi.chat({
      requestId: state.requestId,
      model: els.model.value,
      temperature: Number(state.config?.temperature ?? 1),
      messages: buildMessages(),
    });
  }

  function setStreamingUi(streaming) {
    els.send.hidden = streaming;
    els.stop.hidden = !streaming;
    els.send.disabled = streaming;
    els.input.disabled = false;
    updateHint();
  }

  function findMessage(id) {
    return state.messages.find((message) => message.id === id);
  }

  function handleEvent(event) {
    if (!event || event.requestId !== state.requestId) return;
    const assistant = state.messages[state.messages.length - 1];
    if (!assistant || assistant.role !== 'assistant') return;

    if (event.type === 'delta') {
      if (event.reasoning) assistant.reasoning = (assistant.reasoning || '') + event.reasoning;
      if (event.content) assistant.content += event.content;
      patchStreaming(assistant);
      return;
    }

    if (event.type === 'done') {
      assistant.streaming = false;
      assistant.ts = now();
      if (event.usage) {
        assistant.usage = event.usage;
        state.usage = event.usage;
      }
      state.streaming = false;
      state.requestId = null;
      setStreamingUi(false);
      renderThread({ scroll: true });
      saveThread();
      return;
    }

    if (event.type === 'aborted') {
      assistant.streaming = false;
      assistant.ts = now();
      if (!assistant.content) assistant.content = '_已停止生成_';
      state.streaming = false;
      state.requestId = null;
      setStreamingUi(false);
      renderThread({ scroll: true });
      saveThread();
      return;
    }

    if (event.type === 'error') {
      assistant.streaming = false;
      assistant.ts = now();
      assistant.error = event.message || '请求失败';
      assistant.retryable = event.code !== 'no-key';
      state.streaming = false;
      state.requestId = null;
      setStreamingUi(false);
      renderThread({ scroll: true });
      saveThread();
      if (event.code === 'no-key') {
        loadConfig();
        openSettings();
      }
    }
  }

  function stop() {
    if (!state.streaming || !state.requestId) return;
    window.deepseekApi.abort(state.requestId);
  }

  function retryLast() {
    const lastUser = [...state.messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) return;
    // Drop trailing failed assistant message, then resend the same prompt.
    while (state.messages.length && state.messages[state.messages.length - 1].role === 'assistant') {
      state.messages.pop();
    }
    els.input.value = lastUser.content;
    state.messages.pop();
    autoGrow();
    send();
  }

  function copyMessage(id) {
    const message = findMessage(id);
    if (!message) return;
    const done = () => window.showYanjieToast?.('已复制到剪贴板');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(message.content).then(done).catch(() => fallbackCopy(message.content, done));
      return;
    }
    fallbackCopy(message.content, done);
  }

  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      window.showYanjieToast?.('复制失败，请手动选择文本', { error: true });
    }
    document.body.removeChild(area);
  }

  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(168, els.input.scrollHeight)}px`;
  }

  function setMode(mode, options = {}) {
    state.mode = mode === 'web' ? 'web' : 'api';
    storeMode(state.mode);
    els.panel.hidden = state.mode !== 'api';
    els.web.hidden = state.mode !== 'web';
    for (const button of els.modeButtons) {
      const active = button.dataset.chatMode === state.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (state.mode === 'web' && options.start !== false) {
      window.YanjieShell?.ensureWebview?.('chat');
    }
    if (state.mode === 'api') {
      els.input.focus();
      scrollToBottom(true);
    }
    window.YanjieShell?.refreshChrome?.();
  }

  function newThread() {
    if (state.streaming) stop();
    if (state.messages.length && !window.confirm('新建对话会清空当前对话记录，确定继续吗？')) return;
    state.messages = [];
    state.usage = null;
    renderThread({ scroll: true, force: true });
    saveThread();
    updateHint();
    els.input.focus();
  }

  function bindEvents() {
    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      send();
    });

    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });
    els.input.addEventListener('input', autoGrow);

    els.stop.addEventListener('click', stop);
    els.send.addEventListener('click', (event) => {
      event.preventDefault();
      send();
    });

    els.modeButtons.forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.chatMode));
    });

    els.newThread.addEventListener('click', newThread);
    els.settings.addEventListener('click', openSettings);
    els.settingsClose.addEventListener('click', closeSettings);
    els.modal.addEventListener('click', (event) => {
      if (event.target === els.modal) closeSettings();
    });
    els.saveKey.addEventListener('click', saveSettings);
    els.testKey.addEventListener('click', testSettings);
    els.clearKey.addEventListener('click', clearKey);
    els.model.addEventListener('change', async () => {
      try {
        state.config = await window.deepseekApi.saveConfig({ model: els.model.value });
        renderConfigState();
        window.showYanjieToast?.(`已切换到 ${els.model.value}`);
      } catch (error) {
        window.showYanjieToast?.(error.message || '切换模型失败', { error: true });
      }
    });

    els.promptList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-prompt]');
      if (!button) return;
      els.input.value = button.dataset.prompt;
      autoGrow();
      els.input.focus();
    });

    els.quoteContext.addEventListener('click', () => {
      const summary = quoteSummaryText();
      if (!summary) {
        window.showYanjieToast?.('报价单还没有内容，先填写客户与产品', { error: true });
        return;
      }
      state.quoteContext = !state.quoteContext;
      els.quoteContext.classList.toggle('is-on', state.quoteContext);
      els.hint.textContent = state.quoteContext ? '下一条消息会附带当前报价摘要' : els.hint.textContent;
      els.input.focus();
    });

    els.messages.addEventListener('click', (event) => {
      const copyButton = event.target.closest('[data-copy]');
      if (copyButton) {
        copyMessage(copyButton.dataset.copy);
        return;
      }
      const retryButton = event.target.closest('[data-retry]');
      if (retryButton) {
        retryLast();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.modal.hidden && state.settingsOpen) {
        event.preventDefault();
        closeSettings();
      }
    });

    window.deepseekApi.onEvent(handleEvent);
  }

  function cacheElements() {
    return {
      panel: document.getElementById('chatPanel'),
      web: document.getElementById('chatWeb'),
      thread: document.getElementById('chatThread'),
      messages: document.getElementById('chatMessages'),
      empty: document.getElementById('chatEmpty'),
      promptList: document.getElementById('chatPrompts'),
      keyState: document.getElementById('chatKeyState'),
      model: document.getElementById('chatModel'),
      newThread: document.getElementById('chatNew'),
      settings: document.getElementById('chatSettings'),
      form: document.getElementById('chatComposer'),
      input: document.getElementById('chatInput'),
      send: document.getElementById('chatSend'),
      stop: document.getElementById('chatStop'),
      hint: document.getElementById('chatHintText'),
      quoteContext: document.getElementById('chatQuoteContext'),
      modeButtons: Array.from(document.querySelectorAll('[data-chat-mode]')),
      modal: document.getElementById('chatSettingsModal'),
      settingsClose: document.getElementById('chatSettingsClose'),
      apiKey: document.getElementById('chatApiKey'),
      baseUrl: document.getElementById('chatBaseUrl'),
      settingsModel: document.getElementById('chatSettingsModel'),
      temperature: document.getElementById('chatTemperature'),
      settingsStatus: document.getElementById('chatSettingsStatus'),
      saveKey: document.getElementById('chatSaveKey'),
      testKey: document.getElementById('chatTestKey'),
      clearKey: document.getElementById('chatClearKey'),
    };
  }

  let initStarted = false;

  async function init() {
    if (initStarted) return;
    initStarted = true;
    els = cacheElements();
    if (!els.panel) return;
    state.messages = loadThread();
    bindEvents();
    renderThread({ scroll: false, force: true });
    setMode(loadMode(), { start: false });
    await loadConfig();
  }

  window.ChatApp = {
    init,
    getMode: () => state.mode,
    setMode,
    focus: () => els?.input?.focus(),
    newThread,
    openSettings,
    getMessages: () => state.messages.map((message) => ({ role: message.role, content: message.content })),
    isStreaming: () => state.streaming,
    // Test helpers
    __test: {
      send,
      handleEvent,
      renderThread,
      quoteSummaryText,
      state,
      isReady: () => Boolean(els && state.config),
    },
  };

  init().catch((error) => {
    console.error('[chat] init failed', error);
  });
})();
