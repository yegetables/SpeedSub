# SpeedSub · 多订阅汇总 + Cloudflare 优选加速器

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yegetables/SpeedSub)
![License](https://img.shields.io/badge/license-GPL--3.0-blue)

一个单文件 Cloudflare Worker，同时做两件事：

1. **多订阅汇总转换器** —— 把任意多个订阅源（Clash YAML / base64 / 明文分享链接）合并成一份，并在 Clash 与 base64 / 明文之间双向转换、全局去重。
2. **Cloudflare 优选 IP 加速器** —— 只改节点的 **IP（`server`）、端口（`port`）、名称（`name`）**，把源订阅里的 CF 节点换成你实测的优选 IP；`tls`、`sni`、`ech-opts`、`ws-opts`、`reality` 等配置选项**一个字节都不动**。

> 典型场景：手里有几份能用的订阅，但优选线路是别人测的。SpeedSub 把它们汇总成一份，再把 CF 节点接到你自己跑出来的优选 IP 上：**连接方式用源订阅的，线路用你实测的**。

---

## 核心原则

**只动三个字段：`server`（IP）、`port`（端口）、`name`（名称）。**

其余所有配置——`tls`、`servername` / `sni`、`ech-opts`、`ws-opts` / `grpc-opts` / `xhttp-opts`、`reality-opts`、`client-fingerprint`、`flow`、`alpn`……——原样保留。这是硬约束，也是它和「重建节点」类工具最大的区别。

---

## 两种模式

| | 纯汇总模式 | CF 优选模式 |
|---|---|---|
| **触发条件** | 「自定义优选与汇聚」留空 | 填了优选 IP / 域名 / IP API |
| **行为** | 多源并发聚合 + 格式双向转换 + 全局去重；不识别 CF、不精简、不改写 | 三层识别 CF 节点 → 每个独立落地保留 1 条基准原节点 → 追加优选 IP 节点 |
| **缺类型提示** | 不提示 | 有缺口时弹窗，让你「去补充」或「仅替换已提供类型」 |

纯汇总模式下，源订阅里有什么就输出什么，只是去重并按你选的格式导出。

---

## CF 优选模式怎么工作

### 1. 三层识别 CF 节点

1. **CF 官方 CIDR** —— IPv4 / IPv6 地址直接匹配 Cloudflare 网段；
2. **域名与传输特征** —— `*.workers.dev` / `*.pages.dev`，或 `ws / grpc / xhttp / httpupgrade` 传输命中 CF CDN 端口族与常见优选域名；
3. **Cloudflare DoH 兜底** —— 前两层不确定时，用 `cloudflare-dns.com` 查询 A / AAAA 是否落在 CF 段。

非 CF 节点（含 Reality、Hysteria2、TUIC、SS、WireGuard、信息节点）一律**原样保留**，不参与改写。

### 2. 独立落地归并

按 `类型 + 凭据 + 传输 + TLS 状态 + SNI + Host + path` 生成落地指纹。同一个 CF 落地无论源订阅里有多少个不同 IP 的副本，**只保留 1 条基准原节点**，其余丢弃，避免输出膨胀。

### 3. 严格对号配对，绝不跨类型错配

| 池 | 端口 |
|---|---|
| **TLS 优选池** | `443` `2053` `2083` `2087` `2096` `8443` |
| **非 TLS 优选池** | `80` `8080` `8880` `2052` `2082` `2086` `2095` |

- TLS 基准节点只从 TLS 池取 `IP:端口`，非 TLS 基准节点只从非 TLS 池取；
- 省略端口的优选条目默认按 `443`（TLS 池）处理；
- 某个类型没有提供优选时，**保留该类型的原节点并给出警告**，绝不会拿另一种类型的 IP 顶上；
- 前端检测到缺口会弹窗：**去补充** 或 **仅替换已提供类型**。

### 4. 追加而非覆盖

保留基准原节点之后再追加优选节点，统一命名为 `[CF优选] 原节点名 · 优选标签`。这样客户端里既有原始可用节点，也有全部优选线路，互不影响。

---

## 特性

- **多源并发聚合**：`Promise.allSettled`，单源失败自动跳过并在结果里报告，不影响其他源
- **输入宽容**：源订阅每行可混写 `http(s)://` 链接、`sub://`、明文分享链接；中文说明、符号、空行静默忽略；自动去重
- **格式自适应**：自动识别 Clash YAML（块式 + 流式 `{...}`）、base64 列表、明文列表
- **双向转换**：Clash YAML ↔ base64 / 明文，覆盖 `vless`（含 Reality）/ `vmess` / `trojan` / `ss` / `hysteria2` / `tuic` / `anytls`
- **全局重名去重**：同名节点自动追加 `-2`、`-3` 后缀
- **多合一输入框**：优选域名 / IPv4 / IPv6 / IP API / 汇聚机场订阅 / 现成节点混写，行尾 `#备注`
- **GitHub 直链纠正**：`github.com/.../blob/...` 自动转 `raw.githubusercontent.com/...`
- **CloudflareST CSV 兼容**：直接粘贴测速 CSV 也能识别第一列 IP
- **KV 配置档（可选）**：保存配置、生成固定短链；未绑定 KV 时自动回退 `/re?...` 直连链接，全功能可用
- **可选管理口令**：设置 `ADMIN_PASS` 后保护管理页与管理 API；`/s/*` 订阅链接不受影响
- **预览**：短链旁「预览」按钮可查看真实拉取统计、缺类型警告和完整结果文件
- **Cookie 记忆**：自定义优选与汇聚内容写进 Cookie，刷新后自动回填
- 单文件 Worker，无构建、无运行时依赖

---

## 一键部署

### 方式一：Cloudflare Workers 一键部署（推荐）

点击顶部 **Deploy to Cloudflare Workers** 按钮，授权后按提示完成。部署完成打开 Worker 地址就是配置页面，**默认无需任何环境变量即可使用全部功能**。

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

### 方式四：连接 Git 仓库（push 自动部署，推荐长期使用）

把仓库连到 Worker 后，**每次 `git push` 自动构建并部署**。

1. Workers → 你的 Worker → **设置 → 构建** → 连接 Git 仓库 → 选本仓库、分支 `main`
2. **添加构建变量**（敏感文本）：`KV_NAMESPACE_ID` = 你的 KV namespace id
3. **部署命令改为**（覆盖默认的 `npx wrangler deploy`，用模板现场生成带 KV 的配置，KV 绑定不会丢）：

```sh
sh -c 'sed "s/在此填入你的 KV namespace id/$KV_NAMESPACE_ID/" wrangler.prod.toml.example > wrangler.deploy.toml && npx wrangler deploy -c wrangler.deploy.toml'
```

4. 保存后自动触发首次构建。之后每次 push 到 `main` 即自动部署。

> 本仓库自身就是这么部署的：[SpeedSub 线上示例](https://speedsub.yegetables.com)。

---

## 启用配置档（可选）

绑定 KV 后可获得「保存配置档 + 固定短订阅地址」：改配置后客户端刷新即生效，无需换链接。

1. Cloudflare 控制台 → **存储和数据库 → KV**：创建一个 namespace（名称随意）
2. **Workers → 你的 Worker → 设置 → 绑定**：添加 KV Namespace，**变量名必须填 `SpeedSub_KV`**
3. 重新部署（或保存绑定）。页面顶部会显示「KV 已绑定」

短地址形如 `https://你的域名/s/<档id>?k=<密钥>`。**源订阅里含你的节点凭据（uuid 等），`k` 密钥请与短地址一起保管**。

### 管理口令（可选）

在 Worker 设置里添加环境变量/密钥 `ADMIN_PASS`，此后：

- 打开管理页需要输入口令；
- `/api/profile`、`/api/preview` 需要登录 Cookie；
- **`/s/<id>?k=...` 与 `/re?...` 不受影响**，客户端照常拉取。

> 想让 KV id 不进 git：复制 `wrangler.prod.toml.example` 为 `wrangler.prod.toml` 填入 id（已 gitignore），用 `npx wrangler@4 deploy -c wrangler.prod.toml` 部署。注意任何不带该绑定的部署都会清掉 KV 绑定。

---

## 使用

**三步上手**：① 打开 Worker 地址；② 填源订阅，需要优选时再填「自定义优选与汇聚」；③ 点「保存并更新」拿到订阅链接。

页面字段：

| 字段 | 说明 |
|---|---|
| **① 源订阅** | 每行一条，可混写订阅链接与裸节点。支持 Clash YAML、base64、明文分享链接；中文/符号/空行自动忽略；重复自动去重 |
| **② 自定义优选与汇聚** | 留空 = 纯汇总模式。可混写优选域名、IPv4/IPv6、IP API、`sub://`、汇聚订阅、现成节点，行尾 `#备注` |
| **③ 拉取源 UA** | 默认 **Clash（`clash.meta`）**。部分机场按 UA 返回不同格式，只有 Clash 系 UA 能拿到真实 mihomo YAML |
| **④ 选择输出格式** | 默认 **Clash**；另有 自动 / Base64 / 明文 |

点「保存并更新」→ 短链卡出现，可 **显示 / 复制 / 预览 / 二维码 / 打开**。

### 「自定义优选与汇聚」写法

```text
# 优选 IP / 域名
104.16.0.1
104.16.0.2:2053
104.16.0.3:80
[2606:4700::1]:8443
cf.090227.xyz
104.16.0.4:443 #香港

# 优选 IP API
https://raw.githubusercontent.com/user/repo/main/ips-v4.txt
sub://你的订阅域名/path
https://github.com/user/repo/blob/main/list.txt

# 汇聚订阅 / 现成节点
https://example.com/api/v1/client/subscribe?token=xxx
vless://uuid@1.2.3.4:443?security=tls&sni=a.com&type=ws&path=/ws#节点名
```

规则：

- 每行一条，`#` 后是备注（写进节点名）；
- 省略端口默认 `443`（TLS 池）；
- IPv6 带端口时用方括号，如 `[2606:4700::1]:8443`；
- 裸节点支持 `vless / vmess / trojan / ss / hysteria2 / tuic / anytls`；
- 也兼容 CloudflareST 的 CSV（`IP,已发送,已接收,...`）；
- 页面内点 **📍 填写说明** 可查看完整示例。

---

## URL 参数（可直接构造订阅地址）

```text
https://你的域名/re?url=<源订阅>&link=<内联节点>&add=<优选/汇聚>&addapi=<列表URL>&num=<数量>&format=<格式>&pullua=<拉取UA>&ua=1&template=<Clash模板>
```

| 参数 | 说明 |
|---|---|
| `url` | 源订阅地址（可多行 / 多个，换行分隔并 URL 编码） |
| `link` | 内联节点链接（每行一个，URL 编码） |
| `add` | 多合一「自定义优选与汇聚」内容（URL 编码） |
| `addapi` | 优选列表 URL，逗号或换行分隔（兼容旧链接） |
| `num` | 只取优选列表前 N 条 |
| `format` | `clash`（默认）/ `auto` / `base64` / `plain` |
| `pullua` | 拉取源 UA：`clash`（默认）/ `auto` / `v2rayng` / `v2rayn` / `surge` / `shadowrocket` |
| `ua` | `1` = 导出的 Clash ws 节点带随机浏览器 UA（默认 0） |
| `template` | 自定义 Clash 模板（`format=clash` 时生效） |

**已生成的订阅会自动跟随吗？** 只要优选 / 汇聚用的是远程 URL（`add` 里的链接或 `addapi`），每次客户端刷新都会重新拉取；内联文本则固定在链接里。

---

## 常见问题

**连不上节点？**
① 确认源节点在 Cloudflare 后面（优选 IP 只加速「你 → CF 边缘」这一段，裸 VPS 源站替换后必然连不上）；② 确认优选端口的协议族与测速时一致（TLS 端口配 TLS 测速、明文端口配明文测速）；③ 看预览里的来源失败与警告信息；④ 看客户端日志。

**为什么我的节点变少了？**
CF 优选模式下，同一个独立 CF 落地只保留 1 条基准原节点（其余同落地副本被合并），再追加优选线路。纯汇总模式不会减少节点。

**为什么有节点没被替换？**
它们要么不是 CF 节点（Reality / Hysteria2 / SS / 信息节点等），要么对应类型的优选池为空。缺失类型会明确提示，不会跨类型替换。

**`*.workers.dev` 打不开？**
部分网络 DNS 污染 workers.dev。给 Worker 绑自定义域名（Worker → 设置 → 域名和路由）即可。

**源订阅里含我的 uuid，会泄露吗？**
生成的订阅链接（及 KV 短链的 `k`）本身就是访问凭据，请勿公开分享。

**支持 SSR / WireGuard / Snell 吗？**
源里出现时可以解析保留，但导出为 Clash 时仅覆盖 `vless / vmess / trojan / ss / hysteria2 / tuic / anytls`；暂不支持导出的节点会被跳过并在文件头注释。

---

## 开发

单文件 Worker（`sublink-worker.js`），无构建、无依赖，前端页面也内联在同一文件里。

```sh
node --check sublink-worker.js   # 语法检查
npx wrangler@4 dev               # 本地预览（改代码即时生效，不部署）
```

文件末尾有 `export` 测试钩子（`extractSources` / `parseAllInOneRaw` / `detectCFNodes` / `runSpeedSubPipeline` 等），可用 Node 直接导入做单元测试，不影响 Worker 运行。

---

## 致谢

- [cmliu/WorkerVless2sub](https://github.com/cmliu/WorkerVless2sub) —— 本仓库的起点
- [yegetables/edgetunnel](https://github.com/yegetables/edgetunnel) —— 优选订阅模式与多合一输入框的交互参考
- [subconverter](https://github.com/tindy2013/subconverter) 及其社区分支 —— 按客户端 UA 自适应返回订阅格式的机制参考

## License

GPL-3.0（沿用上游）
