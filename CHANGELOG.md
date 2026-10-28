# 更新日志

## v1.6.0 — 2026-10-28

首个发布到 GitHub Releases 的版本。Windows 便携版，解压即用。

**工作台**

- 翻译：Google 翻译完整页面，支持文字 / 图片 / 文档 / 网站翻译、语音输入、历史记录与登录。
- DeepSeek：API 对话为默认模式，支持流式输出、可中断、多轮上下文、token 用量与思考过程折叠；
  可切换 `deepseek-chat` / `deepseek-reasoner`，可自定义接口地址；「带入报价摘要」；
  一键切换到 chat.deepseek.com 网页版并保留登录状态。
- 汇率：Wise 实时中间市场汇率换算。
- 世界时间：World Clock 全球时钟、3D 地球、时区转换与国家列表。
- 社媒：内置 Facebook 主页 / Messenger / 广告后台，共享 `persist:yanjie` 会话，`Ctrl+6` 直达。
- 报价计算器：成本加成 / 固定单价双定价模式，10 种报价币种，费用按币种录入，
  尾差自动对齐，低于成本标红，中英双语预览与导出，PDF + Excel 导出，报价库最多 30 份，
  草稿自动保存。

**安全与数据**

- DeepSeek API Key 使用 Electron `safeStorage`（Windows DPAPI）加密存储于
  `%APPDATA%\YanJieData\deepseek-config.json`，渲染进程仅可见掩码。
- 用户数据目录支持自动回退：`%LOCALAPPDATA%\YanJieData` → `%APPDATA%\YanJieData` →
  程序同级 `YanJieData` → `%TEMP%`。
- GitHub 发布包已移除 `YanJieData` 目录，不包含任何预置 API Key 或用户数据。

**发布**

- `YanJie-1.6.0-portable.zip` — Windows x64 便携版。
- 未购买代码签名证书，首次运行需在 SmartScreen 中选择「仍要运行」。
