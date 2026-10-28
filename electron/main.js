'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  session,
  screen,
  clipboard,
  net,
  safeStorage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const APP_ID = 'com.yanjie.desktop';
const APP_NAME = '言界';
const PARTITION = 'persist:yanjie';

// Compat mode for Windows environments where Chromium's GPU/broker sandbox
// cannot create its job object (Electron otherwise exits before first paint).
// Node isolation and context isolation remain enabled for all web guests.
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
const IS_SMOKE_TEST = process.argv.includes('--smoke-test');
const SMOKE_DIR = process.env.YANJIE_SMOKE_DIR
  ? path.resolve(process.env.YANJIE_SMOKE_DIR)
  : app.isPackaged
    ? path.join(os.tmpdir(), 'yanjie-smoke')
    : path.join(__dirname, '..', 'screenshots');
// Base domains only — sub-domains (www., m., business., web.) match by suffix.
const ALLOWED_WEBVIEW_HOSTS = new Set([
  'translate.google.com',
  'wise.com',
  'world-clock.app',
  'chat.deepseek.com',
  'facebook.com',
  'messenger.com',
]);

function hostMatchesAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  for (const allowed of ALLOWED_WEBVIEW_HOSTS) {
    if (host === allowed || host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
function resolveUserDataDir() {
  if (process.env.YANJIE_USER_DATA) return path.resolve(process.env.YANJIE_USER_DATA);
  // %APPDATA%\Roaming is the Chromium/Electron default, but some Windows
  // security suites block unsigned apps from writing there. Probe with a real
  // file write and fall back to Local / temp so the app always gets a usable
  // profile directory instead of dying before first paint.
  const candidates = [
    path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'YanJieData'),
    path.join(app.getPath('appData'), 'YanJieData'),
    // Last portable resort: keep the profile next to the executable. Some
    // security suites block AppData/Temp writes for unsigned binaries, and the
    // app must still be able to start and persist its settings.
    path.join(path.dirname(process.execPath), 'YanJieData'),
    path.join(os.tmpdir(), 'YanJieData'),
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(candidate, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return candidate;
    } catch (error) {
      console.error(`[main] user data directory unusable (${candidate}):`, error.message);
    }
  }
  return path.join(os.tmpdir(), 'YanJieData');
}

const USER_DATA_DIR = resolveUserDataDir();
try {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  console.log(`[main] user data: ${USER_DATA_DIR}`);
} catch (error) {
  console.error('[main] failed to create user data directory:', error);
}
app.setPath('userData', USER_DATA_DIR);

const chromeVersion = process.versions.chrome || '156.0.0.0';
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

let mainWindow = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAllowedWebviewUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && hostMatchesAllowed(parsed.hostname);
  } catch {
    return false;
  }
}

function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf8'));
    const width = Number(state.width);
    const height = Number(state.height);
    const x = Number(state.x);
    const y = Number(state.y);

    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width < 980 || height < 640) return null;

    if (Number.isFinite(x) && Number.isFinite(y)) {
      const visible = screen.getAllDisplays().some((display) => {
        const area = display.workArea;
        return (
          x + 120 > area.x &&
          x < area.x + area.width - 120 &&
          y + 80 > area.y &&
          y < area.y + area.height - 80
        );
      });
      if (visible) return { x, y, width, height };
    }
    return { width, height };
  } catch {
    return null;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.isMaximized()
      ? mainWindow.getNormalBounds()
      : mainWindow.getBounds();
    fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true });
    fs.writeFileSync(
      getWindowStatePath(),
      JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }, null, 2),
      'utf8'
    );
  } catch {
    /* Window-state persistence must never block shutdown. */
  }
}

function broadcastWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('window:state', {
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen(),
  });
}

function setGuestSecurity(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault();
  });

  contents.on('will-redirect', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault();
  });

  /*
   * Facebook (and Meta login) proactively ask for a passkey via WebAuthn.
   * Windows only trusts signed applications for that request, so an unsigned
   * build triggers the "确保这是你本人 / 请将安全密钥插入 USB 端口" system dialog
   * on every login page load. Reject the request inside the page instead so the
   * site falls back to its normal password flow.
   */
  const applyPasskeyGuard = () => {
    const current = contents.getURL();
    if (!/(^|\.)(facebook\.com|messenger\.com|meta\.com)/i.test(safeHostname(current))) return;
    contents
      .executeJavaScript(
        `(() => {
          try {
            if (!navigator.credentials) return 'no-credentials';
            const reject = () => Promise.reject(
              new DOMException('Passkeys are disabled inside YanJie Desk', 'NotAllowedError')
            );
            if (!navigator.credentials.__yanjieGuarded) {
              navigator.credentials.get = reject;
              navigator.credentials.create = reject;
              Object.defineProperty(navigator.credentials, '__yanjieGuarded', { value: true });
            }
            return 'guarded';
          } catch (error) {
            return 'error:' + error.message;
          }
        })();`,
        true
      )
      .catch(() => {});
  };

  contents.on('dom-ready', applyPasskeyGuard);
  contents.on('did-navigate-in-page', applyPasskeyGuard);
}

function safeHostname(value) {
  try {
    return new URL(value).hostname || '';
  } catch {
    return '';
  }
}

function installShortcuts(contents) {
  if (contents.__yanjieShortcutsInstalled) return;
  contents.__yanjieShortcutsInstalled = true;

  contents.on('before-input-event', (event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;

    const ctrl = input.control || input.meta;
    const key = String(input.key || '');
    const code = String(input.code || '');
    let shortcut = null;

    if (ctrl && !input.shift && ['1', '2', '3', '4', '5', '6'].includes(key)) {
      shortcut = `tab:${key}`;
    } else if ((ctrl && key.toLowerCase() === 'r') || key === 'F5') {
      shortcut = 'page:reload';
    } else if (ctrl && input.shift && key.toLowerCase() === 'o') {
      shortcut = 'page:external';
    } else if (input.alt && key === 'ArrowLeft') {
      shortcut = 'page:back';
    } else if (input.alt && key === 'ArrowRight') {
      shortcut = 'page:forward';
    } else if (ctrl && (key === '=' || key === '+' || code === 'Equal')) {
      shortcut = 'zoom:in';
    } else if (ctrl && (key === '-' || code === 'Minus')) {
      shortcut = 'zoom:out';
    } else if (ctrl && key === '0') {
      shortcut = 'zoom:reset';
    } else if (key === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      return;
    }

    if (shortcut) {
      event.preventDefault();
      mainWindow.webContents.send('app:shortcut', shortcut);
    }
  });
}

function attachWebContentsGuards() {
  app.on('web-contents-created', (_event, contents) => {
    installShortcuts(contents);
    if (contents.getType() === 'webview') {
      setGuestSecurity(contents);
    } else {
      contents.setWindowOpenHandler(({ url }) => {
        if (isHttpUrl(url)) shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
      });
    }
  });
}

function configureSession() {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(USER_AGENT);
  session.defaultSession.setUserAgent(USER_AGENT);
  app.userAgentFallback = USER_AGENT;

  try {
    ses.setSpellCheckerEnabled(true);
    ses.setSpellCheckerLanguages(['zh-CN', 'en-US']);
  } catch {
    /* Optional on minimal Windows installs. */
  }

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestUrl = details?.requestingUrl || webContents.getURL();
    let host = '';
    try {
      host = new URL(requestUrl).hostname;
    } catch {
      host = requestUrl;
    }

    if (IS_SMOKE_TEST) {
      callback(false);
      return;
    }

    if (permission === 'media') {
      dialog
        .showMessageBox(mainWindow || undefined, {
          type: 'question',
          title: '麦克风权限',
          message: `${host || '当前网页'} 请求使用麦克风`,
          detail: '用于语音输入或翻译。只有在你点击“允许”后才会启用。',
          buttons: ['允许', '拒绝'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        .then(({ response }) => callback(response === 0))
        .catch(() => callback(false));
      return;
    }

    callback(
      ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications'].includes(
        permission
      )
    );
  });

  ses.setPermissionCheckHandler((_webContents, permission) => {
    return ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media'].includes(
      permission
    );
  });

  ses.on('will-download', (_event, item) => {
    const directory = app.getPath('downloads');
    const originalName = item.getFilename() || 'download';
    const parsed = path.parse(originalName);
    let target = path.join(directory, originalName);
    let counter = 1;
    while (fs.existsSync(target)) {
      target = path.join(directory, `${parsed.name} (${counter})${parsed.ext}`);
      counter += 1;
    }
    item.setSavePath(target);
    item.once('done', (_doneEvent, state) => {
      if (state === 'completed' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:download-complete', {
          name: path.basename(target),
          path: target,
        });
      }
    });
  });
}

function createWindow() {
  const savedState = readWindowState();

  mainWindow = new BrowserWindow({
    width: savedState?.width || 1440,
    height: savedState?.height || 920,
    x: savedState?.x,
    y: savedState?.y,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    backgroundColor: '#0c1b18',
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.partition = PARTITION;
    webPreferences.backgroundThrottling = false;

    const initialSrc = String(params.src || '');
    if (initialSrc && initialSrc !== 'about:blank' && !isAllowedWebviewUrl(initialSrc)) {
      event.preventDefault();
      return;
    }
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow the shell page to reload itself (Ctrl+R / location.reload) but never
    // let it navigate away from the bundled UI.
    const currentUrl = mainWindow.webContents.getURL();
    const isSameDocument =
      Boolean(url) &&
      (url === currentUrl ||
        (url.startsWith('file:') &&
          decodeURIComponent(url).toLowerCase().endsWith('/src/index.html')));
    if (!isSameDocument) event.preventDefault();
  });

  mainWindow.webContents.on('console-message', (event) => {
    if (!IS_SMOKE_TEST) return;
    const text =
      event && typeof event === 'object' && 'message' in event
        ? event.message
        : String(event);
    if (text) console.log(`[renderer] ${text}`);
  });

  mainWindow.on('maximize', broadcastWindowState);
  mainWindow.on('unmaximize', broadcastWindowState);
  mainWindow.on('enter-full-screen', broadcastWindowState);
  mainWindow.on('leave-full-screen', broadcastWindowState);
  mainWindow.on('restore', broadcastWindowState);
  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.once('ready-to-show', () => {
    if (savedState?.maximized) mainWindow.maximize();
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    broadcastWindowState();

    if (IS_SMOKE_TEST) {
      runSmokeTest(mainWindow).catch((error) => {
        console.error('[smoke] failed:', error);
        process.exitCode = 1;
        app.quit();
      });
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

function safeExportName(value, extension) {
  const base = String(value || '报价单')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || '报价单';
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

function uniqueFilePath(directory, filename) {
  const parsed = path.parse(filename);
  let target = path.join(directory, filename);
  let counter = 1;
  while (fs.existsSync(target)) {
    target = path.join(directory, `${parsed.name} (${counter})${parsed.ext}`);
    counter += 1;
  }
  return target;
}

let lastExportDirectory = null;

async function chooseQuoteExportDirectory(title) {
  const testDirectory = process.env.YANJIE_TEST_EXPORT_DIR;
  if (testDirectory) {
    const directory = path.resolve(testDirectory);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath: lastExportDirectory || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '保存到此文件夹',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  lastExportDirectory = result.filePaths[0];
  return lastExportDirectory;
}

async function exportQuotePdf(event, payload) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Unauthorized PDF export request');
  }
  const documents = Array.isArray(payload?.documents) ? payload.documents : [];
  if (documents.length < 1 || documents.length > 4) {
    throw new Error('Invalid quote document set');
  }
  for (const document of documents) {
    if (
      !document ||
      typeof document.html !== 'string' ||
      document.html.length < 200 ||
      document.html.length > 8_000_000 ||
      !/^\s*<!doctype html>/i.test(document.html) ||
      typeof document.fileName !== 'string'
    ) {
      throw new Error('Invalid quote document');
    }
  }

  const directory = await chooseQuoteExportDirectory('选择报价单保存文件夹');
  if (!directory) return { canceled: true };

  const printWindow = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      backgroundThrottling: false,
    },
  });

  const files = [];
  try {
    printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const document of documents) {
      const filePath = uniqueFilePath(
        directory,
        safeExportName(document.fileName, '.pdf')
      );
      await printWindow.loadURL(
        `data:text/html;charset=UTF-8,${encodeURIComponent(document.html)}`
      );
      await delay(350);
      const pdf = await printWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { marginType: 'none' },
        preferCSSPageSize: true,
      });
      await fs.promises.writeFile(filePath, pdf);
      files.push({ path: filePath, name: path.basename(filePath) });
    }
    return { ok: true, files };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

function asText(value, fallback = '') {
  const text = value === null || value === undefined ? fallback : String(value);
  return text.trim();
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function writeQuoteExcel(data) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '言界';
  workbook.created = new Date();
  const isEn = data.lang === 'en';
  const L = isEn
    ? {
        sheet: 'Quotation',
        company: 'Your Company Name',
        subtitle: 'QUOTATION',
        customer: 'Customer',
        quoteInfo: 'Quote details',
        trade: 'Trade terms',
        seller: 'Seller',
        unnamedItem: 'Unnamed product',
        unit: 'unit',
        no: 'No.',
        date: 'Date',
        validUntil: 'Valid until',
        destination: 'Destination',
        currency: 'Currency',
        index: '#',
        product: 'Product / Specification',
        qty: 'Qty',
        unitColumn: 'Unit',
        unitPrice: 'Unit price',
        amount: 'Amount',
        subtotal: 'Subtotal',
        discount: 'Discount',
        total: 'TOTAL',
        payment: 'Payment terms',
        delivery: 'Delivery time',
        validity: 'Validity',
        remarks: 'Remarks',
        days: 'days',
        until: 'until',
        footer: 'Generated by YanJie Quote Calculator · Subject to final contract',
      }
    : {
        sheet: '报价单',
        company: '你的公司名称',
        subtitle: '报价单   QUOTATION',
        customer: '客户',
        quoteInfo: '报价信息',
        trade: '贸易条款',
        seller: '报价方',
        unnamedItem: '未命名产品',
        unit: '台',
        no: '单号',
        date: '日期',
        validUntil: '有效期至',
        destination: '目的港',
        currency: '币种',
        index: '序号',
        product: '产品 / 规格',
        qty: '数量',
        unitColumn: '单位',
        unitPrice: '单价',
        amount: '金额',
        subtotal: '小计',
        discount: '折扣',
        total: '报价总额',
        payment: '付款方式',
        delivery: '交货期',
        validity: '有效期',
        remarks: '备注',
        days: '天',
        until: '至',
        footer: '本报价单由言界报价计算器生成 · 报价以最终合同为准',
      };

  const sheet = workbook.addWorksheet(L.sheet, {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: {
        left: 0.35,
        right: 0.35,
        top: 0.45,
        bottom: 0.45,
        header: 0.2,
        footer: 0.2,
      },
    },
  });
  sheet.columns = [
    { width: 11 },
    { width: 40 },
    { width: 10 },
    { width: 9 },
    { width: 17 },
    { width: 19 },
  ];

  const ink = 'FF11251F';
  const accent = 'FFB4633F';
  const pale = 'FFF7ECE6';
  const line = 'FFD8E1DC';
  const thin = { style: 'thin', color: { argb: line } };
  const seller = data.seller || {};
  const meta = data.meta || {};
  const totals = data.totals || {};
  const terms = data.terms || {};
  const currency = asText(meta.currency, 'USD') || 'USD';

  const styleRange = (row, from, to, style) => {
    for (let column = from; column <= to; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      if (style?.fill) cell.fill = style.fill;
      if (style?.font) cell.font = style.font;
      if (style?.alignment) cell.alignment = style.alignment;
    }
  };

  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = asText(seller.company, L.company);
  titleCell.font = { name: 'Microsoft YaHei', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ink } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 38;

  sheet.mergeCells('A2:F2');
  const subtitleCell = sheet.getCell('A2');
  subtitleCell.value = L.subtitle;
  subtitleCell.font = { name: 'Microsoft YaHei', size: 13, bold: true, color: { argb: accent } };
  subtitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pale } };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(2).height = 27;

  const sellerLine = [
    asText(seller.contact),
    asText(seller.phone),
    asText(seller.email),
    asText(seller.address),
  ]
    .filter(Boolean)
    .join('  ·  ');

  const metaRows = [
    [
      L.customer,
      asText(meta.customer, '—') +
        (asText(meta.contact) ? `  ·  ${asText(meta.contact)}` : ''),
    ],
    [
      L.quoteInfo,
      isEn
        ? `${L.no} ${asText(meta.quoteNo, '—')}  ·  ${L.date} ${asText(meta.date, '—')}  ·  ${L.validUntil} ${asText(meta.validUntil, '—')}`
        : `${L.no} ${asText(meta.quoteNo, '—')}  ·  ${L.date} ${asText(meta.date, '—')}  ·  ${L.validUntil} ${asText(meta.validUntil, '—')}`,
    ],
    [
      L.trade,
      isEn
        ? `${asText(meta.tradeTerm, 'FOB')}  ·  ${L.destination} ${asText(meta.destination, '—')}  ·  ${L.currency} ${currency}`
        : `${asText(meta.tradeTerm, 'FOB')}  ·  ${L.destination} ${asText(meta.destination, '—')}  ·  ${L.currency} ${currency}`,
    ],
    [L.seller, sellerLine || '—'],
  ];

  let rowNumber = 4;
  for (const [label, value] of metaRows) {
    sheet.mergeCells(rowNumber, 2, rowNumber, 6);
    const labelCell = sheet.getCell(rowNumber, 1);
    const valueCell = sheet.getCell(rowNumber, 2);
    labelCell.value = label;
    labelCell.font = { name: 'Microsoft YaHei', size: 10, bold: true, color: { argb: 'FF53635C' } };
    labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F3' } };
    labelCell.alignment = { vertical: 'middle', horizontal: 'left' };
    valueCell.value = value;
    valueCell.font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF24342D' } };
    valueCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    styleRange(rowNumber, 1, 6, null);
    sheet.getRow(rowNumber).height = 24;
    rowNumber += 1;
  }

  rowNumber += 1;
  const headerRow = sheet.getRow(rowNumber);
  headerRow.values = [
    L.index,
    L.product,
    L.qty,
    L.unitColumn,
    `${L.unitPrice} (${currency})`,
    `${L.amount} (${currency})`,
  ];
  headerRow.height = 26;
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Microsoft YaHei', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: accent } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  });
  const tableStart = rowNumber;
  rowNumber += 1;

  const items = Array.isArray(data.items) ? data.items : [];
  for (const [index, item] of items.entries()) {
    const name = asText(item.name, L.unnamedItem);
    const spec = asText(item.spec);
    const row = sheet.getRow(rowNumber);
    row.values = [
      index + 1,
      spec ? `${name}\n${spec}` : name,
      asNumber(item.qty),
      asText(item.unit, L.unit),
      asNumber(item.unitPrice),
      asNumber(item.amount),
    ];
    row.height = Math.min(72, spec ? 20 + Math.ceil(spec.length / 34) * 15 : 24);
    row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell(2).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell(5).numFmt = '#,##0.00';
    row.getCell(6).numFmt = '#,##0.00';
    row.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' };
    row.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' };
    row.eachCell((cell) => {
      cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      cell.font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF24342D' } };
    });
    rowNumber += 1;
  }

  const totalRow = (label, value, options = {}) => {
    sheet.mergeCells(rowNumber, 1, rowNumber, 4);
    const labelCell = sheet.getCell(rowNumber, 1);
    labelCell.value = label;
    labelCell.alignment = { vertical: 'middle', horizontal: 'right' };
    labelCell.font = {
      name: 'Microsoft YaHei',
      size: 10,
      bold: Boolean(options.bold),
      color: { argb: options.bold ? ink : 'FF53635C' },
    };
    const valueCell = sheet.getCell(rowNumber, 6);
    valueCell.value = asNumber(value);
    valueCell.numFmt = '#,##0.00';
    valueCell.alignment = { vertical: 'middle', horizontal: 'right' };
    valueCell.font = {
      name: 'Microsoft YaHei',
      size: options.bold ? 12 : 10,
      bold: Boolean(options.bold),
      color: { argb: options.bold ? accent : 'FF24342D' },
    };
    styleRange(rowNumber, 1, 6, options.bold
      ? { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: pale } } }
      : null);
    sheet.getRow(rowNumber).height = options.bold ? 28 : 23;
    rowNumber += 1;
  };

  totalRow(L.subtotal, totals.subtotal);
  if (asNumber(totals.discount) > 0) {
    totalRow(`${L.discount} (${asNumber(totals.discountRate)}%)`, -asNumber(totals.discount));
  }
  totalRow(L.total, totals.total, { bold: true });

  rowNumber += 1;
  const termsRows = [
    [L.payment, asText(terms.payment)],
    [L.delivery, asText(terms.delivery)],
    [
      L.validity,
      isEn
        ? `${asNumber(terms.validityDays)} ${L.days}, ${L.until} ${asText(meta.validUntil, '—')}`
        : `${asNumber(terms.validityDays)} ${L.days}，${L.until} ${asText(meta.validUntil, '—')}`,
    ],
    [L.remarks, asText(terms.notes)],
  ].filter(([, value]) => Boolean(value));

  for (const [label, value] of termsRows) {
    sheet.mergeCells(rowNumber, 1, rowNumber, 6);
    const cell = sheet.getCell(rowNumber, 1);
    cell.value = `${label}${isEn ? ': ' : '：'}${value}`;
    cell.font = { name: 'Microsoft YaHei', size: 9.5, color: { argb: 'FF3C4C45' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAF8' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
    sheet.getRow(rowNumber).height = 24;
    rowNumber += 1;
  }

  rowNumber += 1;
  sheet.mergeCells(rowNumber, 1, rowNumber, 6);
  const footer = sheet.getCell(rowNumber, 1);
  footer.value = L.footer;
  footer.font = { name: 'Microsoft YaHei', size: 8.5, color: { argb: 'FF7A8982' } };
  footer.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(rowNumber).height = 22;

  sheet.pageSetup.printArea = `A1:F${rowNumber}`;
  sheet.pageSetup.printTitlesRow = `${tableStart}:${tableStart}`;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function exportQuoteExcel(event, payload) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Unauthorized Excel export request');
  }
  const documents = Array.isArray(payload?.documents) ? payload.documents : [];
  if (documents.length < 1 || documents.length > 4) {
    throw new Error('Invalid quote data set');
  }
  for (const document of documents) {
    if (
      !document ||
      !document.data ||
      typeof document.data !== 'object' ||
      !Array.isArray(document.data.items) ||
      typeof document.fileName !== 'string'
    ) {
      throw new Error('Invalid quote data');
    }
  }

  const directory = await chooseQuoteExportDirectory('选择报价单保存文件夹');
  if (!directory) return { canceled: true };

  const files = [];
  for (const document of documents) {
    const filePath = uniqueFilePath(
      directory,
      safeExportName(document.fileName, '.xlsx')
    );
    const buffer = await writeQuoteExcel(document.data);
    await fs.promises.writeFile(filePath, buffer);
    files.push({ path: filePath, name: path.basename(filePath) });
  }
  return { ok: true, files };
}

/* ------------------------------------------------------------------ *
 * DeepSeek API
 * The API key never leaves the main process once saved: the renderer
 * only ever receives a masked hint. Conversations stream through IPC.
 * ------------------------------------------------------------------ */

const DEEPSEEK_DEFAULT_BASE = 'https://api.deepseek.com';
const DEEPSEEK_MODELS = ['deepseek-chat', 'deepseek-reasoner'];
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{2,64}$/;

function pickModel(candidate, fallback) {
  if (typeof candidate === 'string' && MODEL_ID_PATTERN.test(candidate.trim())) return candidate.trim();
  return fallback;
}
const DEEPSEEK_MAX_MESSAGES = 80;
const DEEPSEEK_MAX_CHARS = 240_000;
const deepseekRequests = new Map();

function deepseekConfigPath() {
  return path.join(app.getPath('userData'), 'deepseek-config.json');
}

function readDeepseekConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(deepseekConfigPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeDeepseekConfig(config) {
  const target = deepseekConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2), 'utf8');
}

function encryptSecret(text) {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return {
        value: safeStorage.encryptString(text).toString('base64'),
        mode: 'os-keychain',
      };
    } catch {
      /* fall through to obfuscation */
    }
  }
  return { value: Buffer.from(text, 'utf8').toString('base64'), mode: 'base64' };
}

function decryptSecret(entry) {
  if (!entry || typeof entry.value !== 'string' || !entry.value) return '';
  const buffer = Buffer.from(entry.value, 'base64');
  if (entry.mode === 'os-keychain') {
    try {
      return safeStorage.decryptString(buffer);
    } catch {
      return '';
    }
  }
  return buffer.toString('utf8');
}

/*
 * A key seeded by an installer / support flow may be stored as base64 only.
 * Upgrade it to OS keychain (DPAPI) storage on the first launch that can do so,
 * so the plaintext-obscured copy does not stay on disk.
 */
function migrateDeepseekSecret() {
  const config = readDeepseekConfig();
  if (!config.apiKey || config.apiKey.mode === 'os-keychain') return;
  const plain = decryptSecret(config.apiKey);
  if (!plain || !safeStorage.isEncryptionAvailable()) return;
  config.apiKey = encryptSecret(plain);
  writeDeepseekConfig(config);
  console.log('[main] DeepSeek key upgraded to system keychain storage');
}

function maskSecret(secret) {
  if (!secret) return '';
  const tail = secret.slice(-4);
  return `••••••••${tail}`;
}

function normalizeBaseUrl(value) {
  const raw = asText(value, DEEPSEEK_DEFAULT_BASE) || DEEPSEEK_DEFAULT_BASE;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('接口地址格式不正确，请填写以 http:// 或 https:// 开头的地址');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('接口地址只支持 http 或 https');
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error('出于安全考虑，http 地址只允许本机调试使用，远程请使用 https');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

function publicDeepseekConfig() {
  const config = readDeepseekConfig();
  const key = decryptSecret(config.apiKey);
  return {
    hasKey: Boolean(key),
    keyMask: maskSecret(key),
    keyStorage: config.apiKey?.mode || null,
    model: pickModel(config.model, DEEPSEEK_MODELS[0]),
    models: Array.from(new Set([...DEEPSEEK_MODELS, ...(Array.isArray(config.availableModels) ? config.availableModels : [])])),
    availableModels: Array.isArray(config.availableModels) ? config.availableModels : [],
    baseUrl: config.baseUrl || DEEPSEEK_DEFAULT_BASE,
    temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 1,
    lastTest: config.lastTest || null,
  };
}

function describeDeepseekError(status, body) {
  let message = '';
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message || parsed?.message || '';
  } catch {
    message = String(body || '').slice(0, 240);
  }
  const base = `HTTP ${status}`;
  if (status === 401) return `API Key 无效或已失效（${base}）。请在设置中重新填写。`;
  if (status === 402) return `账户余额不足（${base}），请前往 DeepSeek 开放平台充值。`;
  if (status === 422) return `请求参数不被接受（${base}）：${message}`;
  if (status === 429) return `请求过于频繁或已限流（${base}），请稍后重试。`;
  if (status >= 500) return `DeepSeek 服务暂时不可用（${base}），请稍后重试。`;
  return `${base}${message ? `：${message}` : ' 请求失败'}`;
}

function sanitizeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const cleaned = [];
  let total = 0;
  for (const message of list) {
    if (!message || typeof message !== 'object') continue;
    const role = ['system', 'user', 'assistant'].includes(message.role) ? message.role : null;
    if (!role) continue;
    const content = asText(message.content);
    if (!content) continue;
    total += content.length;
    if (cleaned.length >= DEEPSEEK_MAX_MESSAGES || total > DEEPSEEK_MAX_CHARS) break;
    cleaned.push({ role, content });
  }
  return cleaned;
}

function sendDeepseekEvent(sender, payload) {
  if (!sender || sender.isDestroyed()) return;
  sender.send('deepseek:event', payload);
}

async function readSseStream(response, emit) {
  const contentType = String(response.headers.get('content-type') || '');
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.choices?.[0]?.message || {};
      if (message.reasoning_content) emit.reasoning(message.reasoning_content);
      if (message.content) emit.delta(message.content);
      if (parsed?.usage) emit.usage(parsed.usage);
      return;
    } catch {
      throw new Error('无法解析 DeepSeek 返回内容');
    }
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    emit.raw(text);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finished = false;

  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0 && !finished) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '').trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        finished = true;
        break;
      }

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed?.error) {
        throw new Error(parsed.error.message || 'DeepSeek 返回错误');
      }
      const choice = parsed?.choices?.[0];
      const delta = choice?.delta || {};
      if (delta.reasoning_content) emit.reasoning(delta.reasoning_content);
      if (delta.content) emit.delta(delta.content);
      if (parsed?.usage) emit.usage(parsed.usage);
    }
  }

  try {
    await reader.cancel();
  } catch {
    /* stream already closed */
  }
}

async function startDeepseekStream(sender, payload) {
  const requestId = asText(payload?.requestId) || `req-${Date.now()}`;
  const apiKey = decryptSecret(readDeepseekConfig().apiKey);
  if (!apiKey) {
    sendDeepseekEvent(sender, {
      type: 'error',
      requestId,
      message: '尚未配置 DeepSeek API Key，请先在设置中填写。',
      code: 'no-key',
    });
    return;
  }

  const config = readDeepseekConfig();
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(payload?.baseUrl || config.baseUrl);
  } catch (error) {
    sendDeepseekEvent(sender, { type: 'error', requestId, message: error.message });
    return;
  }

  const messages = sanitizeMessages(payload?.messages);
  if (!messages.length) {
    sendDeepseekEvent(sender, { type: 'error', requestId, message: '消息内容为空' });
    return;
  }

  const model = pickModel(payload?.model, pickModel(config.model, DEEPSEEK_MODELS[0]));
  const temperature = Number.isFinite(Number(payload?.temperature))
    ? Math.min(2, Math.max(0, Number(payload.temperature)))
    : Number.isFinite(Number(config.temperature))
      ? Math.min(2, Math.max(0, Number(config.temperature)))
      : 1;

  const controller = new AbortController();
  deepseekRequests.set(requestId, controller);
  const timeout = setTimeout(() => controller.abort(), 300_000);

  let pendingReasoning = '';
  let pendingContent = '';
  let usage = null;

  const flush = () => {
    if (!pendingReasoning && !pendingContent) return;
    sendDeepseekEvent(sender, {
      type: 'delta',
      requestId,
      content: pendingContent,
      reasoning: pendingReasoning,
    });
    pendingReasoning = '';
    pendingContent = '';
  };

  try {
    sendDeepseekEvent(sender, { type: 'start', requestId, model });

    const response = await net.fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: Math.min(8192, Math.max(256, Number(payload?.maxTokens) || 4096)),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(describeDeepseekError(response.status, body));
    }

    await readSseStream(response, {
      delta: (text) => {
        pendingContent += text;
        if (pendingContent.length > 24) flush();
      },
      reasoning: (text) => {
        pendingReasoning += text;
        if (pendingReasoning.length > 24) flush();
      },
      usage: (value) => {
        usage = value;
      },
      raw: (text) => {
        pendingContent += text;
        flush();
      },
    });

    flush();
    sendDeepseekEvent(sender, { type: 'done', requestId, usage });
  } catch (error) {
    flush();
    const aborted = controller.signal.aborted || error?.name === 'AbortError';
    const message = aborted
      ? '已停止生成'
      : /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(String(error?.message))
        ? `无法连接 DeepSeek 接口：${error.message}。请检查网络或接口地址。`
        : error?.message || '未知错误';
    sendDeepseekEvent(sender, {
      type: aborted ? 'aborted' : 'error',
      requestId,
      message,
    });
  } finally {
    clearTimeout(timeout);
    deepseekRequests.delete(requestId);
  }
}

async function testDeepseekConnection(sender) {
  const config = readDeepseekConfig();
  const apiKey = decryptSecret(config.apiKey);
  if (!apiKey) {
    return { ok: false, message: '尚未配置 API Key' };
  }
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(config.baseUrl);
  } catch (error) {
    return { ok: false, message: error.message };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await net.fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, message: describeDeepseekError(response.status, body) };
    }
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload?.data)
      ? payload.data.map((entry) => entry?.id).filter(Boolean)
      : [];
    const lastTest = {
      at: new Date().toISOString(),
      ok: true,
      models,
    };
    writeDeepseekConfig({ ...readDeepseekConfig(), lastTest, availableModels: models });
    return {
      ok: true,
      message: models.length ? `连接正常，可用模型：${models.join('、')}` : '连接正常',
      models,
    };
  } catch (error) {
    const message = controller.signal.aborted
      ? '连接超时，请检查网络或接口地址'
      : `连接失败：${error.message}`;
    writeDeepseekConfig({
      ...readDeepseekConfig(),
      lastTest: { at: new Date().toISOString(), ok: false, message },
    });
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}

function registerDeepseekIpc() {
  ipcMain.handle('deepseek:config', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Unauthorized');
    }
    return publicDeepseekConfig();
  });

  ipcMain.handle('deepseek:save-config', (event, payload = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Unauthorized');
    }
    const config = readDeepseekConfig();

    if (payload.clearKey === true) {
      delete config.apiKey;
    } else if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      const key = payload.apiKey.trim();
      if (key.length < 16 || /\s/.test(key)) {
        throw new Error('API Key 格式似乎不正确，请检查是否完整复制');
      }
      config.apiKey = encryptSecret(key);
    }

    if (typeof payload.model === 'string' && MODEL_ID_PATTERN.test(payload.model.trim())) {
      config.model = payload.model.trim();
    }
    if (typeof payload.baseUrl === 'string' && payload.baseUrl.trim()) {
      config.baseUrl = normalizeBaseUrl(payload.baseUrl);
    }
    if (payload.temperature !== undefined) {
      const value = Number(payload.temperature);
      if (Number.isFinite(value)) config.temperature = Math.min(2, Math.max(0, value));
    }

    writeDeepseekConfig(config);
    return publicDeepseekConfig();
  });

  ipcMain.handle('deepseek:test', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Unauthorized');
    }
    return testDeepseekConnection(event.sender);
  });

  ipcMain.on('deepseek:chat', (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    startDeepseekStream(event.sender, payload).catch((error) => {
      sendDeepseekEvent(event.sender, {
        type: 'error',
        requestId: asText(payload?.requestId),
        message: error?.message || '未知错误',
      });
    });
  });

  ipcMain.on('deepseek:abort', (event, requestId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const controller = deepseekRequests.get(asText(requestId));
    if (controller) controller.abort();
  });
}

/* ------------------------------------------------------------------ *
 * Live FX rates
 * Returns CNY per 1 unit of each currency, which is exactly what the quote
 * calculator stores. Two public sources are tried in order so a single
 * provider outage does not break quoting.
 * ------------------------------------------------------------------ */

const FX_CACHE_MS = 5 * 60 * 1000;
const FX_WISE_CACHE_MS = 2 * 60 * 1000;
const FX_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'AED', 'SAR', 'RUB', 'CNY'];
const FX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
let fxCache = null;

/*
 * Wise publishes the same mid-market numbers its converter uses through an
 * unauthenticated endpoint: GET /rates/live?source=USD&target=CNY returns
 * { value: 6.6678 } — CNY per 1 USD, already the direction the quote form wants.
 * One call per pair is needed, so they run in parallel and any failed pair is
 * filled in later by the daily table below.
 */
async function fetchWiseRates() {
  const pairs = FX_CODES.filter((code) => code !== 'CNY');
  const settled = await Promise.allSettled(
    pairs.map(async (code) => {
      const response = await net.fetch(
        `https://wise.com/rates/live?source=${code}&target=CNY`,
        { headers: { accept: 'application/json', 'user-agent': FX_UA } }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const value = Number(payload?.value);
      if (!Number.isFinite(value) || value <= 0) throw new Error('bad value');
      return [code, value];
    })
  );

  const rates = { CNY: 1 };
  for (const item of settled) {
    if (item.status === 'fulfilled') rates[item.value[0]] = item.value[1];
  }
  const filled = Object.keys(rates).length - 1;
  if (!(rates.USD > 4 && rates.USD < 12)) return null;
  if (filled < 5) return null;
  return {
    ok: true,
    source: 'wise.com',
    at: Date.now(),
    rates,
    partial: filled < pairs.length,
  };
}

async function fetchFxRates() {
  const ttl =
    fxCache && fxCache.source === 'wise.com' ? FX_WISE_CACHE_MS : FX_CACHE_MS;
  if (fxCache && Date.now() - fxCache.at < ttl) return fxCache;

  try {
    const wise = await fetchWiseRates();
    if (wise) {
      fxCache = wise;
      return wise;
    }
  } catch (error) {
    console.error('[fx] wise failed:', error.message);
  }

  const sources = [
    {
      name: 'open.er-api.com',
      url: 'https://open.er-api.com/v6/latest/CNY',
      pick: (json) => json?.rates,
    },
    {
      name: 'frankfurter.app',
      url: 'https://api.frankfurter.app/latest?from=CNY',
      pick: (json) => json?.rates,
    },
  ];

  for (const source of sources) {
    try {
      const response = await net.fetch(source.url, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) continue;
      const table = source.pick(await response.json());
      if (!table || typeof table !== 'object') continue;

      const rates = {};
      for (const [code, value] of Object.entries(table)) {
        const amount = Number(value);
        if (!/^[A-Z]{3}$/.test(code)) continue;
        if (!Number.isFinite(amount) || amount <= 0) continue;
        rates[code] = 1 / amount; // CNY per 1 unit
      }
      // Sanity check: the USD/CNY pair must look like a real exchange rate.
      if (!(rates.USD > 4 && rates.USD < 12)) continue;

      fxCache = { ok: true, source: source.name, at: Date.now(), rates };
      return fxCache;
    } catch (error) {
      console.error(`[fx] ${source.name} failed:`, error.message);
    }
  }

  return { ok: false, at: Date.now(), error: '汇率接口暂时不可用，请手动填写' };
}

function registerIpc() {
  ipcMain.on('win:minimize', () => mainWindow?.minimize());
  ipcMain.on('win:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('win:close', () => mainWindow?.close());
  ipcMain.handle('win:is-maximized', () => Boolean(mainWindow?.isMaximized()));
  ipcMain.handle('win:toggle-fullscreen', () => {
    if (!mainWindow) return false;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('fx:rates', async () => fetchFxRates());

  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userAgent: USER_AGENT,
    packaged: app.isPackaged,
  }));

  ipcMain.handle('app:open-external', async (_event, url) => {
    if (!isHttpUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('app:show-item', (_event, filePath) => {
    if (typeof filePath === 'string' && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return true;
    }
    return false;
  });

  ipcMain.handle('quote:export-pdf', exportQuotePdf);
  ipcMain.handle('quote:export-excel', exportQuoteExcel);

  ipcMain.on('menu:webview', (event, params = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const id = Number(params.webContentsId);
    if (!Number.isFinite(id)) return;
    const contents = require('electron').webContents.fromId(id);
    if (!contents || contents.getType() !== 'webview') return;

    const linkUrl = isHttpUrl(params.linkURL) ? params.linkURL : null;
    const pageUrl = isHttpUrl(contents.getURL()) ? contents.getURL() : null;
    const template = [];

    if (linkUrl) {
      template.push({
        label: '在默认浏览器中打开链接',
        click: () => shell.openExternal(linkUrl).catch(() => {}),
      });
      template.push({ type: 'separator' });
    }

    template.push(
      {
        label: '后退',
        enabled: contents.canGoBack(),
        click: () => contents.goBack(),
      },
      {
        label: '前进',
        enabled: contents.canGoForward(),
        click: () => contents.goForward(),
      },
      {
        label: '重新加载',
        click: () => contents.reload(),
      },
      { type: 'separator' }
    );

    if (params.isEditable) {
      template.push(
        {
          label: '剪切',
          enabled: Boolean(params.selectionText),
          click: () => contents.cut(),
        },
        {
          label: '复制',
          enabled: Boolean(params.selectionText),
          click: () => contents.copy(),
        },
        { label: '粘贴', click: () => contents.paste() },
        { label: '全选', click: () => contents.selectAll() },
        { type: 'separator' }
      );
    } else if (params.selectionText) {
      template.push(
        { label: '复制', click: () => contents.copy() },
        { label: '全选', click: () => contents.selectAll() },
        { type: 'separator' }
      );
    }

    template.push({
      label: '复制页面地址',
      enabled: Boolean(pageUrl),
      click: () => pageUrl && clipboard.writeText(pageUrl),
    });
    template.push({
      label: '在默认浏览器中打开本页',
      enabled: Boolean(pageUrl),
      click: () => pageUrl && shell.openExternal(pageUrl).catch(() => {}),
    });

    if (!app.isPackaged) {
      template.push({ type: 'separator' });
      template.push({
        label: '检查元素',
        click: () => contents.inspectElement(params.x || 0, params.y || 0),
      });
    }

    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
}

async function waitForRendererApi(win, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ready = await win.webContents.executeJavaScript(
        'Boolean(window.__YJ_TEST__ && window.__YJ_TEST__.isReady())'
      );
      if (ready) return true;
    } catch {
      /* The renderer may still be loading. */
    }
    await delay(500);
  }
  return false;
}

let smokeTestStarted = false;

async function runSmokeTest(win) {
  if (smokeTestStarted) {
    console.log('[smoke] duplicate invocation ignored');
    return;
  }
  smokeTestStarted = true;
  fs.mkdirSync(SMOKE_DIR, { recursive: true });
  win.show();
  win.moveTop();
  win.focus();
  console.log('[smoke] window shown; waiting for webviews');
  const apiReady = await waitForRendererApi(win);
  if (!apiReady) throw new Error('Renderer test API did not become ready');

  await delay(16000);
  const results = [];

  for (const key of ['translate', 'currency', 'time', 'chat', 'quote']) {
    const activated = await win.webContents.executeJavaScript(
      `window.__YJ_TEST__.activate(${JSON.stringify(key)})`
    );
    console.log(`[smoke] requested ${key}, renderer active=${activated}`);
    await delay(6500);

    await win.webContents.executeJavaScript(
      `new Promise((resolve) => {
        document.getAnimations({ subtree: true }).forEach((animation) => {
          try { animation.finish(); } catch {}
        });
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300)));
      })`
    );
    win.webContents.invalidate();
    await delay(700);

    const stats = await win.webContents.executeJavaScript(
      'window.__YJ_TEST__.stats()'
    );
    console.log(`[smoke] ${key}:`, JSON.stringify(stats));

    const image = await Promise.race([
      win.webContents.capturePage(),
      delay(12000).then(() => null),
    ]);
    if (!image) throw new Error(`capturePage timed out for ${key}`);
    const file = path.join(SMOKE_DIR, `${key}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(
      `[smoke] captured ${file} (${image.getSize().width}x${image.getSize().height})`
    );
    results.push({ key, file, stats });
  }

  fs.writeFileSync(
    path.join(SMOKE_DIR, 'smoke-result.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );
  console.log('[smoke] RESULT ' + JSON.stringify(results));
  await delay(800);
  app.quit();
}

attachWebContentsGuards();

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  configureSession();
  migrateDeepseekSecret();
  registerIpc();
  registerDeepseekIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  saveWindowState();
});

process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('[main] unhandled rejection:', error);
});
