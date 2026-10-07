# SpeedSub · 实测优选订阅改写器

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yegetables/SpeedSub)
![License](https://img.shields.io/badge/license-GPL--3.0-blue)

把**机场订阅 / 自建订阅 / 节点链接**里的节点「地址:端口」，按位置替换成**你自己实测的优选 IP 列表**，其余连接参数（uuid、path、Host、传输层配置）逐字保留，输出成你自己的订阅。

> 典型场景：你手里有一份能用的订阅，但它的优选线路是别人测的；你自己跑测速得到一批更快的优选 IP（IPv4/IPv6、指定端口）。SpeedSub 把两者合到一起：**连接方式用源订阅的，线路用你实测的**。
>
> 本项目由 [cmliu/WorkerVless2sub](https://github.com/cmliu/WorkerVless2sub) 重写而来，但用途已完全不同：不是"从模板生成订阅"，而是"改写既有订阅"。

---

## 特性

- **按位置一一配对**（不是乘法）：第 i 条实测 → 第 i 个节点；实测多于节点时，超出部分用第 1 个节点的参数继续配；节点多于实测时，多余的忽略
- **三要素 TLS 一致性**：源节点、实测端口族、最终配置自动对齐（全 TLS 或全明文），最终配置显式写出 `tls: true/false`
- **改写而非重建**：源节点里工具不认识的参数（fp、pbk、ws headers、未来新字段）原样保留；认不出的协议原样透传，不弄坏订阅
- **拉取 UA 可指定**：自适应订阅按拉取端 UA 返回不同格式，可强制按 Clash / v2rayNG / v2rayN / Surge / Shadowrocket 的 UA 拉取
- **随机 User-Agent 头**（可选）：给导出的 Clash 节点生成随机浏览器 UA
- 源格式：base64 节点列表、明文节点列表、**Clash YAML（块式与流式 `{...}` 都支持）**
- 输出：跟随源格式 / base64 / 明文 / **完整 Clash 配置**（内置默认模板，可粘贴自己的模板覆盖）
- Clash 导出支持 **vless（含 Reality）/ vmess / trojan / ss / hysteria2 / tuic / anytls**；ssr 等暂不支持导出的节点自动跳过并注释
- **KV 配置档（可选）**：保存配置、生成短地址；未绑定 KV 时全功能可用（手动模式）
- 单文件 Worker，无任何构建与运行时依赖

**不做什么**：不添加 `udp`（优选 Worker 节点不支持 UDP relay）；不做订阅转换（YAML/链接互转请配合 subconverter 类工具）。

---

## 一键部署

### 方式一：Cloudflare Workers 一键部署（推荐）

点击上面的 **Deploy to Cloudflare Workers** 按钮，授权后按提示完成，即可得到一个属于你的 Worker。部署完成打开 Worker 地址就是配置页面，**默认无需任何环境变量即可使用全部功能**。

### 方式二：Dashboard 手动部署

1. Cloudflare 控制台 → **Workers 和 Pages** → 创建 Worker（名字随意，如 `speedsub`）
2. 编辑代码，粘贴 [`sublink-worker.js`](./sublink-worker.js) 全文，部署

### 方式三：wrangler 命令行

```sh
git clone https://github.com/yegetables/SpeedSub.git
cd SpeedSub
npx wrangler@4 deploy        # 部署名在 wrangler.toml 的 name 里，可自行修改
```

> `wrangler.toml` 不含任何私有信息（KV id 等），可直接入库使用。

---

## 启用配置档（可选）

绑定 KV 后可获得「保存配置档 + 短订阅地址」：改配置后客户端刷新即生效，无需换链接。

1. Cloudflare 控制台 → **存储和数据库 → KV**：创建一个 namespace（名称随意）
2. **Workers → 你的 Worker → 设置 → 绑定**：添加 KV Namespace，**变量名必须填 `SUBLINK_KV`**
3. 重新部署（或保存绑定）。页面顶部会显示「KV 已绑定」

短地址形如 `https://你的域名/s/<档id>?k=<密钥>`。**源订阅里含你的节点凭据（uuid 等），`k` 密钥请与短地址一起保管**。

> 想让 KV id 不进 git：复制 `wrangler.prod.toml.example` 为 `wrangler.prod.toml` 填入 id（已 gitignore），用 `npx wrangler@4 deploy -c wrangler.prod.toml` 部署。注意任何不带该绑定的部署都会清掉 KV 绑定。

---

## 使用

打开 Worker 地址，按下面填：

| 字段 | 说明 |
|---|---|
| **源订阅地址** | 机场订阅 / 自建订阅 URL；也可以直接粘贴节点链接（每行一个） |
| **拉取源订阅的客户端类型** | 自适应订阅按 UA 返回不同内容。默认自动跟随；要拿 Clash YAML 选 **Clash**（输出格式建议同时选 Clash 配置） |
| **实测优选列表** | 每行一条：`ip:端口`、`ip:端口#名称`、`[IPv6]:端口`、裸 `IPv6:端口` 亦可。也可改用「远程 URL」模式（列表内容更新后订阅自动跟随） |
| **生成数量** | 留空 = 全部；填 N = 只取列表前 N 条 |
| **按端口自动匹配 TLS** | 默认勾选：TLS 端口（443/2053/2083/2087/2096/8443）自动补 `tls`，明文端口（80/8080/8880/2052/2082/2086/2095）自动去掉。不勾选则保持源节点原样 |
| **生成随机 User-Agent 头** | 默认不勾选。勾选后 Clash 导出的 ws 节点会带随机浏览器 UA |
| **输出格式** | 自动（跟随源）/ base64 / 明文 / Clash 配置 |
| **Clash 模板** | 可选。粘贴自己的 config.yaml，顶层 `proxies:` 段会被替换；`proxy-groups` 里可用 `__PROXIES_NAMES__` 占位符插入节点名。留空用内置默认模板 |

点「生成订阅地址」→ 复制/扫码给客户端即可。

**两条典型用法：**

- **Clash 用户**：拉取 UA 选 `Clash` + 输出格式选 `Clash 配置` → 得到完整 config.yaml（内置模板含 dns/proxy-groups/rules，或用你自己的模板）
- **v2rayN / v2rayNG 用户**：拉取 UA 选 `v2rayNG`（或保持自动）+ 输出格式 `自动` → 得到 base64 节点列表

### 配对规则

设源订阅解析出 n 个节点，实测列表 m 条：输出 **m 条**；第 i 条实测替换第 i 个节点的地址端口；i 超出节点数时用**第 1 个节点**的参数；节点多余的忽略。名称：实测条目带 `#名称` 原样使用，否则默认 `ip:端口`。

---

## URL 参数（可直接构造订阅地址）

```
https://你的域名/<自定义路径，默认 /re>?url=<源订阅>&add=<实测列表>&addapi=<列表URL>&num=<数量>&format=<格式>&pullua=<拉取UA>&ua=1&tls=0&template=<Clash模板>
```

| 参数 | 说明 |
|---|---|
| `url` | 源订阅地址（与 `link` 至少一个） |
| `link` | 内联节点链接，每行一个（URL 编码） |
| `add` | 内联实测列表，逗号或换行分隔 |
| `addapi` | 实测列表 URL（内容格式同 `add`；**更新列表内容后订阅自动跟随**） |
| `num` | 生成数量，只截短 |
| `format` | `auto`（默认，跟随源）/ `base64` / `plain` / `clash` |
| `template` | 自定义 Clash 模板（仅 `format=clash` 且源为节点链接时生效） |
| `pullua` | 拉取源订阅的 UA：`auto`（默认）/ `clash` / `mihomo` / `v2rayng` / `v2rayn` / `surge` / `shadowrocket` / 任意字符串 |
| `ua` | `1` = 输出的 Clash 节点生成随机 User-Agent 头（默认 0） |
| `tls` | `0` = 关闭按端口自动匹配 TLS（默认开启） |

**已生成的订阅链接，列表内容变化会自动跟随吗？** 会——只要实测列表用的是远程 URL（`addapi`），每次客户端刷新都会重新拉列表。用内联文本（`add`）的则固定在链接里，需要重新生成。

---

## 常见问题

**连不上节点？**
按优先级排查：① 实测列表的端口与你实测时的协议族一致吗（TLS 端口配 TLS 测速、明文端口配明文测速）——工具会自动对齐到端口族，但如果实测本身不通，输出也不通；② 源订阅是不是最近换过节点（自适应源每次拉取内容会轮换）；③ 客户端日志里的具体错误。

**`*.workers.dev` 打不开？**
部分网络的 DNS 会污染 workers.dev。给自己绑一个自定义域名（Worker → 设置 → 域名和路由），用自定义域名访问。

**实测列表的 URL 带签名（如 alist 直链 `?sign=...`）会过期吗？**
会。过期后拉取失败，此时工具会**原样返回源订阅**（不会给客户端坏配置），但你的优选就失效了。订阅链接里的列表 URL 请使用不带签名的固定地址，或把列表以文本方式存进配置档。

**源订阅里含我的 uuid，会泄露吗？**
生成的订阅 URL（及 KV 短链的 `k` 密钥）本身就是访问凭据，请勿公开分享。KV 短链只认密钥。

**支持 UDP / 订阅转换（YAML↔链接互转）吗？**
不支持。优选 Worker 节点无 UDP relay；格式互转请配合 subconverter 类工具（本项目的拉取 UA 设计参考了 subconverter 的自动识别机制）。

---

## 开发

单文件 Worker（`sublink-worker.js`），无构建、无依赖。语法检查 `node --check sublink-worker.js`。

---

## 致谢

- [cmliu/WorkerVless2sub](https://github.com/cmliu/WorkerVless2sub) —— 本仓库的起点
- [subconverter](https://github.com/tindy2013/subconverter) 及其社区分支 —— 按客户端 UA 自适应返回订阅格式的机制参考
- [ACL4SSR](https://github.com/cmliu/ACL4SSR) —— Clash 模板规则来源

## License

GPL-3.0（沿用上游）
