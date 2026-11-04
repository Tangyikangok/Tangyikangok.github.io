# 调休假查询系统 · 每人独立加密版

> 前端托管在 GitHub Pages，后台数据放在**金山文档**表格里，由 AirScript 定时脚本
> **按人分别加密**后推送到仓库：员工用「姓名 + 密码」只能解开自己那一份，
> 管理员用总密码查看全员。零服务器、零费用。

站点地址（放在现有仓库的子目录，和 `zba/`、`driftbottle/` 互不影响）：

```
https://tangyikangok.github.io/tiaoxiu/
```

---

## 一、加密模型（v2）

```
                 ┌─ 管理员总密码 ──► 全量密文 admin.{salt,iv,ct}   （1 份）
金山文档（明文） ─┤
                 └─ 每个员工的密码 ─► 本人密文 people[{id,salt,iv,ct}]（每人 1 份）
```

- `id = SHA256("tx|" + 姓名 + "|" + nameSalt)`：网页只按 id 定位，仓库里**不出现明文姓名**。
- 员工登录：姓名 + 密码 → 本地 PBKDF2 派生密钥 → 只解自己那一份 → 页面只显示本人。
- 管理员登录：姓名填 `admin` + 总密码 → 解开全量，看到全员汇总、驾驶舱与明细。
- 别人的密文用别人的密码加密，**没有他的密码就解不开** —— 这是真正的隔离，不是前端过滤。

---

## 二、目录说明

```
tiaoxiu/                   ← 推到仓库 tiaoxiu/ 文件夹
├── index.html             页面（登录框：姓名 + 密码）
├── app.js                 查询 / 统计 / 登录（admin 全员 / 员工本人两种模式）
├── crypto.js              浏览器解密（v2 每人密文 + 兼容旧 v1 单密文）
├── style.css              样式（含手机端表格适配）
├── config.js              站点配置（adminName 等）
├── data/leave-data.json   加密数据（脚本自动覆盖）
└── README.md

airscript/
├── crypto-aes.js          纯 JS 加密（SHA-256/HMAC/PBKDF2/AES-256-CBC）
├── sync-to-github.js      同步脚本（读表 → 每人加密 → 推送）
└── dist/sync.full.js      ★ 上面两个合并的单文件（推荐直接粘这个）

tools/                     本地辅助（不进仓库）
├── build-airscript.js     生成 dist/sync.full.js
├── build-v2.js            生成本地 v2 示例（含凭据 tools/v2-credentials.txt）
├── verify-crypto.js       加密实现与 Node 标准库对拍
└── test-v2.mjs / shot-table.mjs  无头浏览器验证脚本
```

---

## 三、部署步骤

### 第 1 步：上传页面

把 `tiaoxiu/` 整个文件夹覆盖到仓库根目录的 `tiaoxiu/`（不要动其他文件夹）。
访问 `https://tangyikangok.github.io/tiaoxiu/`。

### 第 2 步：金山文档表格

- **年份表**：工作表名 `2024` / `2025` / `2026`（4 位年份），结构与原来一致。
- **配置表**（名 `配置`，A 列键 / B 列值）：

| 键 | 值（示例） |
|---|---|
| github_token | `ghp_xxxx…`（只需 `repo` 权限） |
| owner | `Tangyikangok` |
| repo | `Tangyikangok.github.io` |
| branch | `main` |
| path | `tiaoxiu/data/leave-data.json` |
| **admin_password** | **你的管理员总密码（≥10 位，务必强）** |
| person_iterations | `5000`（每人轮数，人多别调太高） |
| admin_iterations | `100000` |
| password_sheet | `密码` |

- **密码表**（名 `密码`，A 列姓名 / B 列密码）：

| 姓名 | 密码 |
|---|---|
| 张三 | abc12345 |
| 李四 | def67890 |
| … | … |

> 没有密码记录的员工无法自助登录（管理员仍能看到他）。建议给全员都配一条。
> 目前按姓名区分，**暂不支持重名**（同名的会互相覆盖，后续可换工号）。

### 第 3 步：部署 AirScript

1. 休假表 →「效率」→「高级开发」→「AirScript 脚本编辑器」→ 新建**文档共享脚本**。
2. **推荐**：把 `airscript/dist/sync.full.js` 全文粘进去（加密 + 同步已合并）。
3. 保存 → 点「服务授权」→ 添加服务 → 勾选 **「网络 API」**。
4. 先把 `CFG.dryRun` 改成 `true` 运行一次，核对日志：
   - 工作表清单、年份、总人数、有密码/缺密码人数、预计耗时。
5. 确认无误后改回 `false`，再运行，正式加密并推送。

### 第 4 步：定时任务

「效率」→「高级开发」→「定时任务」→ 新建：每天 `08:00`（可再加 `14:00`）执行该脚本。

### 第 5 步：验证登录

- 员工：姓名 + 各自密码 → 只看到本人（含各年份）。
- 管理员：姓名填 `admin` + `admin_password` → 看到全员。

---

## 四、性能参考（150~200 人）

本机 Node 基准：PBKDF2 约 **10 ms / 1000 轮**。

- `person_iterations=5000`：约 `52 ms/人` → 200 人约 **10 秒**（AirScript 可能 2~4 倍，约 20~40 秒）。
- 若脚本超时：把 `person_iterations` 降到 `3000`；密码请保持 8 位以上，弥补轮数降低。
- 管理员全量 `admin_iterations=100000` 只有 1 份，耗时可忽略。

---

## 五、数据格式（排查用）

```jsonc
{
  "v": 2, "alg": "AES-256-CBC", "kdf": "PBKDF2-SHA256",
  "updatedAt": "2026-11-04T…",
  "nameSalt": "…base64…",
  "iter": 5000,
  "admin": { "iter": 100000, "salt": "…", "iv": "…", "ct": "…" },
  "people": [
    { "id": "…64位hex…", "salt": "…", "iv": "…", "ct": "…" }
  ]
}
```

员工密文解密后的结构：`{ name, years:[{year,clearStatus,G,months:[{l,t}×12}] } }`。

计算规则不变：`剩余 = G + 3~12月调休 − 3~12月休假`。

---

## 六、安全边界

| 层 | 保护 |
|---|---|
| 数据 | 每人独立 AES-256-CBC；公开仓库只有密文 |
| 姓名 | 用 `nameSalt` 哈希成 id，仓库不出现明文名单 |
| 密码 | PBKDF2-SHA256；强度由你设置，**务必 ≥8 位** |
| 会话 | 登录信息只存 sessionStorage，关标签页/点「锁定」即失效 |

局限：纯前端方案无法做登录失败锁定、会话审计，也无法阻止员工把账号转给他人。
如需这些，要加小后端（如 Cloudflare Worker）。

---

## 七、常见问题

**Q：员工改密码 / 离职怎么办？**
A：改「密码」表对应行（离职可删行），重跑脚本即可，旧密文被整体覆盖失效。

**Q：某员工登录提示「姓名或密码不正确」？**
A：① 姓名与「密码」表是否完全一致（含空格）；② 是否刚改密码但没重跑脚本；③ 该员工是否根本没配密码。

**Q：管理员密码填在哪？**
A：配置表 `admin_password`；网页登录姓名填 `admin`（可在 `config.js` 的 `adminName` 改）。

**Q：重名怎么处理？**
A：当前按姓名识别，重名会冲突。后续可改为「工号」作为登录名，仓库结构不变。

**Q：脚本报 `HTTP is not defined`？**
A：漏了「服务授权 → 网络 API」。

**Q：脚本报找不到 `encryptJson` / `sha256Hex`？**
A：只粘了 `sync-to-github.js`，没粘 `crypto-aes.js`。用 `dist/sync.full.js` 最省事。

**Q：脚本很慢 / 超时？**
A：降 `person_iterations`（如 3000），或减少一次处理的年份。

---

## 八、本地预览

```bash
cd tiaoxiu
python -m http.server 8910 --bind 127.0.0.1
# 打开 http://127.0.0.1:8910/
# 示例：员工 张伟 / pw01；管理员 admin / admin123
# 完整凭据见 tools/v2-credentials.txt
```

> 必须用本地服务打开（`file://` 无法 fetch，且不是安全上下文，WebCrypto 不可用）。
