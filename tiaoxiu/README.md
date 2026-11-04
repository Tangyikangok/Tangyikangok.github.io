# 调休假查询系统 · 在线加密版

> 前端托管在 GitHub Pages，后台数据放在**金山文档**表格里，由金山文档自带的 AirScript
> 定时脚本**加密后**推送到仓库 —— 全程零服务器、零费用，且公开仓库也看不到明文名单。

站点地址（放在你现有的仓库里，和 `zba/`、`driftbottle/` 互不影响）：

```
https://tangyikangok.github.io/tiaoxiu/
```

---

## 一、为什么之前担心「泄密」

你问的第一个问题——「名单放金山文档会不会泄密」——要分两段看：

1. **金山文档本身**：不分享、不开链接，别人打不开，是安全的。
2. **数据到了 GitHub**：GitHub Free 的 Pages 只能从**公开仓库**发布，所以推到仓库的 JSON
   任何人都能下载。**仓库设私有 ≠ 保密**，只要网页能显示，调试面板里就能拿到。

所以这一版的关键改动是：**数据加密后再进仓库**。

```
明文名单 → AES-256-CBC 加密（口令派生密钥）→ 密文 JSON 进公开仓库
                                                  ↓
                              网页需输入口令，浏览器本地解密后显示
```

外人即使把 `leave-data.json` 下载下来，拿到的也只是一串 `ct` 密文，没有口令什么都看不到。

---

## 二、架构

```
 ┌──────────────┐   定时触发(每天)      ┌───────────────────────────┐
 │ 金山文档表格  │ ── AirScript 脚本 ──▶ │ GitHub 仓库                │
 │ (存明文数据)  │   读表→生成JSON→加密   │ tiaoxiu/data/leave-data.json│
 └──────────────┘   PUT /contents API   │ （只有密文，公开也可）      │
                                        └────────────┬──────────────┘
                                                     │ 自动构建
                                            ┌────────▼─────────┐
                                            │ GitHub Pages 页面 │ ← 同源，无跨域
                                            └────────┬─────────┘
                                                     │ 输入口令
                                            ┌────────▼─────────┐
                                            │ 员工浏览器本地解密 │
                                            └──────────────────┘
```

三个免费件：金山文档（存数据）+ AirScript（跑同步+加密）+ GitHub Pages（发页面）。

参考过并被验证可行的同类项目：
[imoki/imoki.github.io](https://github.com/imoki/imoki.github.io)、
[bandengzex/bandengzex.github.io](https://github.com/bandengzex/bandengzex.github.io)（金山文档 AirScript + GitHub Pages 思路）。

---

## 三、目录说明

```
tiaoxiu/                    ← 推到 GitHub 仓库 tiaoxiu/ 文件夹的内容
├── index.html              页面骨架（含解锁面板）
├── app.js                  查询 / 统计 / 驾驶舱 / 解锁逻辑（原生 JS，无依赖）
├── crypto.js               浏览器端解密（WebCrypto：PBKDF2 + AES-256-CBC）
├── style.css               样式（深色主题）
├── config.js               站点配置：标题、数据路径
├── data/
│   └── leave-data.json     加密数据包（由金山文档脚本自动覆盖）
└── README.md               本文件

airscript/
├── sync-to-github.js       ★ 同步脚本（依赖 crypto-aes.js）
├── crypto-aes.js           ★ 纯 JS 加密实现（AirScript 无 WebCrypto，必须用它）
└── dist/
    └── sync.full.js        ★ 上面两个合并成的单文件（推荐直接粘这个）

tools/                      本地辅助脚本（不进仓库）
├── build-airscript.js      生成 dist/sync.full.js
├── encrypt-data.js         本地把明文 JSON 加密成数据包（AirScript 出问题时的降级方案）
├── verify-crypto.js        加密实现与 Node 标准库逐字节对拍
└── test-webcrypto-roundtrip.js  验证「金山文档加密 → 浏览器解密」互通

index.html / app.js / style.css  ← 仓库根目录：本地 Excel 版，未改动，管理员照常用
```

> 本地 Excel 版直接读写 `服务部休假.xls`，两套并存：管理员本地维护、员工网页查询。

---

## 四、部署步骤

### 第 1 步：把页面放进仓库

你现有仓库是 `Tangyikangok.github.io`，里面已有 `zba/`、`driftbottle/`。
把本目录 `tiaoxiu/` 整个文件夹传到仓库根目录即可，**不要动其他文件夹**。

- 上传后访问 `https://tangyikangok.github.io/tiaoxiu/`
- 同一仓库的 Pages 会自动发布，无需新建仓库、无需重新配置 Pages

### 第 2 步：把休假表放进金山文档

1. [kdocs.cn](https://www.kdocs.cn) 登录 → 新建表格，或直接上传现有 `服务部休假.xls`
2. 工作表名必须是 `2024`、`2025`、`2026` 这样的 4 位年份（脚本靠这个识别）
3. 表格**保持不分享**（配置表里会放 GitHub token）

### 第 3 步：建「配置」工作表

在同一份文档新建工作表，命名 **`配置`**，A 列写键名、B 列写值：

| A 列（键） | B 列（值） |
|---|---|
| github_token | `ghp_xxxx…` |
| owner | `Tangyikangok` |
| repo | `Tangyikangok.github.io` |
| branch | `main` |
| path | `tiaoxiu/data/leave-data.json` |
| **password** | **查询口令（如 `fwbu2026`，分发给你想给的人）** |
| iterations | `100000`（可省略，默认 10 万轮） |

**GitHub Token**：GitHub 头像 → Settings → Developer settings → Personal access tokens
→ Tokens (classic) → Generate new token → 只勾 **`repo`** → 生成即复制（只显示一次）。

### 第 4 步：部署 AirScript

1. 休假表 →「效率」→「高级开发」→「AirScript 脚本编辑器」
2. 新建脚本，**必须选「文档共享脚本」**（否则定时任务选不到它）
3. 粘贴内容二选一：
   - **推荐**：`airscript/dist/sync.full.js` 全文（加密+同步已合并成一个文件）
   - 或先后粘贴 `crypto-aes.js`、`sync-to-github.js`（顺序不能反）
4. 点保存按钮旁的「服务授权」→ 添加服务 → 勾选 **「网络 API」**
   （不加会报 `HTTP is not defined`）
5. 顶部 `CFG.dryRun = true`，先「运行」试跑，看日志：
   - 列出工作表清单、各年份人数、明文前 300 字、密文长度
6. 确认无误后把 `dryRun` 改回 `false`，再跑一次正式推送

### 第 5 步：设定时任务

「效率」→「高级开发」→「定时任务」→ 新建：
- 时间：每天 `08:00`（可再加 `14:00`）
- 脚本：选第 4 步那个
- 保存

之后**在金山文档改数据，次日网页自动更新**；想立刻生效就在脚本编辑器点一次「运行」。

---

## 五、数据格式（仅在排查时看）

仓库里 `leave-data.json` 是**密文包**，结构如下（不是明文名单）：

```jsonc
{
  "v": 1,
  "alg": "AES-256-CBC",
  "kdf": "PBKDF2-HMAC-SHA256",
  "iter": 100000,
  "salt": "…base64…",
  "iv": "…base64…",
  "ct": "…base64 密文…",
  "updatedAt": "2026-11-04T08:00:00+08:00",
  "note": "数据已加密，需在页面输入口令查看"
}
```

解密后才得到明文结构（前端计算用）：

```jsonc
{ "years": [ { "year": 2026, "persons": [
  { "name": "张三", "dept": "客服组", "clearStatus": "本年累计中", "G": 5.5,
    "months": [ {"l":1,"t":0.5}, … 共 12 项 … ]   // l=休假天数, t=调休天数
  }
] } ] }
```

**计算规则（与本地 Excel 版完全一致）**：

```
剩余可用 = G（清算基数） + 3~12月调休合计 − 3~12月休假合计
```

1、2 月已含在上一年清算结果里，不重复计入合计 —— 原表业务口径。

---

## 六、安全边界

| 层次 | 保护方式 | 说明 |
|---|---|---|
| 金山文档 | 不分享 | token 在配置表，务必别转发整份文档 |
| 传输/存储 | AES-256-CBC 加密 | 公开仓库里只有密文，下载也看不懂 |
| 口令 | PBKDF2-SHA256 10 万轮 | 口令弱则易被暴力破解，**请用强口令**（≥10 位，字母+数字） |
| 前端会话 | sessionStorage | 口令只在当前标签页有效，关闭即失效，点「锁定」立即清除 |

**已知局限**：口令是「统一发放」的——所有拿到口令的人都能看到全部分析数据。
若要「每个人只能查自己」，需要后端鉴权（如 Cloudflare Worker + 账号体系），成本更高。
当前方案适合「部门内部、信任同事、但不想让全网看到」的场景。

**换口令**：改配置表 `password` → 手动跑一次脚本重新加密推送即可；旧密文随之失效。

---

## 七、常见问题

**Q：改完金山文档，网页多久更新？**
A：脚本跑完 + Pages 构建，约 1~10 分钟。右上角显示「数据更新于 …」。

**Q：页面一直显示「正在加载数据…」？**
A：多半是预览端口不对。本地预览请确认服务起在 **8900** 且访问 `http://127.0.0.1:8900/`。

**Q：输入口令提示不正确？**
A：① 配置表 `password` 与输入是否一致；② 是否刚改过口令但还没重跑脚本；③ 数据文件是否损坏（重新跑脚本）。

**Q：脚本报 `HTTP is not defined`？**
A：漏了「服务授权 → 网络 API」。

**Q：脚本报「取不到工作簿 / 表名全空」？**
A：AirScript 版本差异，脚本已做多路探测；先开 `dryRun` 看日志，对照工作表清单调 `getWorkbook/getSheets` 顺序。

**Q：脚本报找不到 `encryptJson`？**
A：只粘了 `sync-to-github.js` 没粘 `crypto-aes.js`。改用 `dist/sync.full.js` 最省事。

**Q：断网怎么办？**
A：页面把最近一次成功加载的数据缓存在 localStorage，弱网自动降级显示并标注时间（加密数据仍是密文形式缓存，需口令解）。

---

## 八、本地预览

```bash
cd tiaoxiu
python -m http.server 8900 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8900/
# 示例数据口令：tiaoxiu2026
```

> 双击 `index.html` 用 `file://` 打开会因安全策略读不到 JSON，且 `file://` 不是安全上下文、WebCrypto 不可用，必须起本地服务。

---

## 九、和本地 Excel 版的关系

| | 本地版（仓库根目录） | 在线版（tiaoxiu/） |
|---|---|---|
| 数据来源 | 手动选本地 `服务部休假.xls` | 金山文档自动同步的加密 JSON |
| 编辑 | 支持增删改、存回 xls | 只读查询 |
| 适用 | 管理员维护 | 全员自助查询 |
| 依赖 | xlsx / excel-builder（离线 libs） | 无依赖，纯原生 |

推荐流程：**管理员用本地版维护 → 上传/更新到金山文档 → 脚本加密推送 → 全员网页查询。**
