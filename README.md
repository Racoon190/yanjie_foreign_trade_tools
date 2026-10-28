# 言界 · YanJie Desk

把 [Google 翻译](https://translate.google.com/)、[DeepSeek](https://platform.deepseek.com/)、[Wise 实时汇率换算](https://wise.com/zh-cn/currency-converter/) 和 [World Clock 世界时间](https://world-clock.app/zh/) 装进一个桌面工作台，并内置可导出中英双语报价单的报价计算器。

> 当前版本 **v1.6.0** ｜ Windows 便携版（无需安装）｜ Electron 45

## 下载

前往 [**Releases**](https://github.com/Racoon190/yanjie_foreign_trade_tools/releases) 页面下载最新版：

| 文件 | 说明 |
| --- | --- |
| `YanJie-1.6.0-portable.zip` | Windows 便携版，解压后双击 `言界.exe` 即可运行 |

发布包为通用构建，**不含任何预置 API Key 或用户数据**（`YanJieData` 目录已从发布包中移除）。
首次使用请在「DeepSeek → 右上角齿轮」填入你自己的 API Key，Key 会用 Windows DPAPI 加密后
保存在本机 `%APPDATA%\YanJieData\deepseek-config.json`。

### 校验

```text
SHA256  YanJie-1.6.0-portable.zip
cd157331218de74fe5dafa28d61d4304626cd75d949dd03c59d815ec1a6faa67
```

> 本程序未购买代码签名证书。Windows 首次运行时若出现 SmartScreen 提示，请点「更多信息」→「仍要运行」。
> 详细使用说明见 [使用说明.txt](使用说明.txt)。

## 功能

- **翻译**：Google 翻译完整页面，支持文字 / 图片 / 文档 / 网站翻译、语音输入、历史记录与登录。
- **DeepSeek**
  - **API 对话（默认）**：填入 API Key 即可直连官方接口，流式输出、可中断、多轮上下文、token 用量、思考过程折叠展示，对话记录保存在本机。
  - 模型切换 `deepseek-chat` / `deepseek-reasoner`，可自定义接口地址（自带中转或私有网关）。
  - 「带入报价摘要」把当前报价单附在问题中，让 AI 针对这份报价给建议。
  - **网页版**：一键切回 chat.deepseek.com 官方页面（保留登录状态）。
- **汇率**：Wise 实时中间市场汇率换算器，可直接修改金额与币种。
- **世界时间**：World Clock 全球时钟、3D 地球、时区转换与国家列表。
- **社媒（Facebook）**：内置 `https://www.facebook.com/`，主页、Messenger、广告后台共用一次登录；与其它页签共享 `persist:yanjie` 会话，`Ctrl+6` 直达。
- **报价计算器**
  - 每行可选「成本加成」或「固定单价」两种定价方式。
  - 支持 10 种报价币种，国内费用按 CNY、海运/保险/其他费用按报价币种录入。
  - 成本占比分摊费用与目标利润，尾差自动对齐（单价 × 数量 = 金额，小计无偏差）。
  - 低于成本的行自动标红提示。
  - 中文 / English 实时预览，导出语言可选双语或单语。
  - 导出 PDF + Excel，导出目录自动记忆。
  - 「复制摘要」一键复制纯文本报价要点，方便发 WhatsApp / 邮件。
  - 「报价库」本地保存最多 30 份报价版本，可载入或删除。
  - 报价草稿自动保存。
- 五个工作台保持独立状态，切换时不刷新；DeepSeek 网页版按需加载，不占带宽。
- 持久化 Cookie / 登录状态 / 缩放比例；下载文件自动保存到系统「下载」文件夹。
- 自定义无边框窗口、最小化 / 最大化 / 还原 / 关闭、拖动标题栏、双击最大化。

## 仓库结构

```text
electron/        Electron 主进程与 preload（窗口、Cookie、DPAPI 加密存储、PDF/Excel 导出 IPC）
src/             渲染层工作台：index.html、app.js、chat.js、quote.js、样式
assets/          应用图标资源
build/           打包用图标
使用说明.txt      面向用户的中文使用手册
```

> 本仓库的源码由发布包 `resources/app.asar` 解包得到（`node_modules` 已排除），
> 与 v1.6.0 便携版逐字节一致。

## DeepSeek API Key

1. 登录 [platform.deepseek.com](https://platform.deepseek.com/) → API keys → 创建 Key。
2. 应用内 DeepSeek 页右上角齿轮 → 粘贴 Key → 保存（可先「测试连接」）。
3. Key 通过 Electron `safeStorage`（Windows DPAPI）加密后存放在
   `%APPDATA%\YanJieData\deepseek-config.json`；渲染进程只能拿到掩码。

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 切换工作台 | `Ctrl + 1` … `6` |
| 重新加载当前页面 | `Ctrl + R` 或 `F5` |
| 后退 / 前进 | `Alt + ←` / `Alt + →` |
| 放大 / 缩小 / 重置 | `Ctrl + +` / `-` / `0` |
| 在默认浏览器中打开 | `Ctrl + Shift + O` |
| 全屏 | `F11` |

## 本地运行

```powershell
npm install
npm start
```

## 验证

发布包内置端到端校验脚本 `scripts/verify.js`（内置 mock DeepSeek SSE 服务），覆盖：
外壳启动、五个工作台、API 配置与 Key 加密、流式对话、思考过程、报价上下文注入、
中断生成、401 错误提示、报价计算不变量、定价模式、双语/单语导出、报价库。

## 数据说明

用户数据（Cookie、登录状态、缓存、报价草稿、报价库、API 配置、窗口位置）保存在
`%APPDATA%\YanJieData`。翻译、汇率与时间数据由对应官方网站在联网状态下实时提供；
对话内容仅发往用户填写的 DeepSeek 接口地址。报价计算与 PDF / Excel 生成在本机完成。

## 第三方服务

本应用是 Google 翻译、DeepSeek、Wise 和 World Clock 的桌面封装。各网站的内容、
账号体系、对话数据、汇率数据和使用条款归其各自所有者所有。
本项目打包分发的 Electron / Chromium 组件遵循其各自许可证，见 `LICENSE.electron.txt`。
