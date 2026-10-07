/*
 * 实测优选订阅改写器 (SUBLINK)
 *
 * 用途：源订阅（别人生成的、连接信息固定的节点）的全部内容保持不变，
 *       仅把节点的「地址:端口」按位置替换成你自己实测的优选列表，再输出成新订阅。
 *
 * 路由：
 *   /                       页面
 *   /re?url=&add=&addapi=&num=&format=    临时直连改写（不依赖 KV）
 *   /s/<档id>?k=<密钥>      读取 KV 中的配置档后改写
 *   /api/profile...         配置档增删改（需绑定 KV）
 *
 * 环境变量（全部可选）：
 *   SUBLINK_KV   KV namespace binding 名。未绑定时全站降级为「手动模式」，
 *                页面与 /re 一切功能正常，只是没有配置档与短地址。
 */

const KV绑定名 = 'SUBLINK_KV';
const 配置键前缀 = 'prof:';
const 配置索引键 = 'prof:index';

// 可改写地址的 URI 类节点协议
const 支持协议 = [
	'vless', 'trojan', 'ss', 'ssr', 'hysteria', 'hysteria2', 'hy2',
	'tuic', 'anytls', 'wireguard', 'socks', 'snell', 'mieru', 'juicity'
];

// ---------------- 基础工具 ----------------

function 切分列表(内容) {
	var 文本 = (内容 || '').replace(/[\t|"'\r\n]+/g, ',').replace(/,+/g, ',');
	if (文本.charAt(0) == ',') 文本 = 文本.slice(1);
	if (文本.charAt(文本.length - 1) == ',') 文本 = 文本.slice(0, -1);
	return 文本.split(',').map(s => s.trim()).filter(s => s !== '');
}

function base64解码(文本) {
	try {
		let 干净 = (文本 || '').trim().replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
		while (干净.length % 4 !== 0) 干净 += '=';
		const 二进制 = atob(干净);
		const 字节 = new Uint8Array(二进制.length);
		for (let i = 0; i < 二进制.length; i++) 字节[i] = 二进制.charCodeAt(i);
		return new TextDecoder('utf-8').decode(字节);
	} catch {
		return null;
	}
}

function utf8ToBase64(文本) {
	return btoa(unescape(encodeURIComponent(文本)));
}

function 随机ID() {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function 随机密钥() {
	const 字节 = new Uint8Array(24);
	crypto.getRandomValues(字节);
	return Array.from(字节, b => b.toString(16).padStart(2, '0')).join('');
}

/*
 * 拉取源订阅时的 User-Agent 预设：
 * 很多自适应订阅按拉取端 UA 区分返回内容（UA 含 clash → 返回 Clash YAML，否则返回 base64 节点列表）。
 * auto = 跟随实际拉取的客户端；也可填任意自定义 UA 字符串。
 */
const 拉取UA预设 = {
	clash: 'clash-verge/v2.0.0',
	mihomo: 'mihomo/1.19.28',
	v2rayng: 'v2rayNG/1.9.16',
	v2rayn: 'v2rayN/7.13.5',
	surge: 'Surge iOS/3374',
	shadowrocket: 'Shadowrocket/2.2.55'
};

function 解析拉取UA(pullua, 客户端UA) {
	const v = (pullua || '').trim();
	if (!v || v === 'auto') return (客户端UA || '').trim() || 'v2rayN/7.13.5';
	return 拉取UA预设[v.toLowerCase()] || v;
}

async function 拉取远程(地址, UA, 超时毫秒) {
	const 控制器 = new AbortController();
	const 定时器 = setTimeout(() => 控制器.abort(), 超时毫秒 || 8000);
	try {
		const 响应 = await fetch(地址, {
			headers: { 'User-Agent': UA || 'v2rayN/7.13.5', Accept: '*/*' },
			signal: 控制器.signal
		});
		if (!响应.ok) throw new Error('HTTP ' + 响应.status);
		return await 响应.text();
	} finally {
		clearTimeout(定时器);
	}
}

// ---------------- 实测列表解析 ----------------

/*
 * 支持写法：
 *   1.2.3.4:443
 *   1.2.3.4:443#香港-01
 *   1.2.3.4
 *   [2001:db8::1]:443#日本
 *   2001:db8::1
 *   cf.example.com:443
 * 返回 { host, port, name }，port 为 null 表示未指定（沿用节点原端口）。
 */
function 解析实测条目(原文) {
	let 内容 = (原文 || '').trim();
	if (!内容) return null;

	let 名称 = '';
	const 井号 = 内容.indexOf('#');
	if (井号 >= 0) {
		名称 = 内容.slice(井号 + 1).trim();
		内容 = 内容.slice(0, 井号).trim();
	}
	if (!内容) return null;

	let host = '', port = null;
	if (内容.startsWith('[')) {
		const 右 = 内容.indexOf(']');
		if (右 < 0) return null;
		host = 内容.slice(1, 右);
		const 余 = 内容.slice(右 + 1);
		if (余.startsWith(':')) port = parseInt(余.slice(1), 10) || null;
	} else {
		const 冒号数 = (内容.match(/:/g) || []).length;
		const 末冒号 = 内容.lastIndexOf(':');
		if (冒号数 === 1) {
			host = 内容.slice(0, 末冒号);
			port = parseInt(内容.slice(末冒号 + 1), 10) || null;
		} else if (冒号数 >= 8 && /^\d{1,5}$/.test(内容.slice(末冒号 + 1)) && Number(内容.slice(末冒号 + 1)) <= 65535) {
			// 裸 IPv6:端口（无方括号）：完整 IPv6 最多 7 个冒号，第 8 个冒号必是端口分隔符
			host = 内容.slice(0, 末冒号);
			port = parseInt(内容.slice(末冒号 + 1), 10);
		} else {
			host = 内容; // 裸 IPv6（≤7 个冒号）或域名
		}
	}
	if (!host) return null;
	return { host: host, port: port, name: 名称 };
}

function 取端口(条目, 原端口) {
	if (条目.port != null) return 条目.port;
	if (原端口 != null && parseInt(原端口)) return parseInt(原端口, 10);
	return 443;
}

// ---------------- 节点解析与改写 ----------------

function 找权威结束位置(剩余) {
	for (let i = 0; i < 剩余.length; i++) {
		const c = 剩余[i];
		if (c === '/' || c === '?' || c === '#') return i;
	}
	return 剩余.length;
}

function 取原端口(权威) {
	if (权威.startsWith('[')) {
		const 右 = 权威.indexOf(']');
		const 余 = 权威.slice(右 + 1);
		return 余.startsWith(':') ? (parseInt(余.slice(1), 10) || null) : null;
	}
	const 冒号数 = (权威.match(/:/g) || []).length;
	const 末冒号 = 权威.lastIndexOf(':');
	if (冒号数 === 1 && 末冒号 > 0) return parseInt(权威.slice(末冒号 + 1), 10) || null;
	return null;
}

/*
 * Cloudflare 的端口族：TLS 端口(443/2053/2083/2087/2096/8443) 必须走 TLS，
 * HTTP 端口(80/8080/8880/2052/2082/2086/2095) 必须明文。
 * 实测列表的端口与源节点的 TLS 属性可能不一致，替换端口时自动对齐，否则必然连不上。
 */
const TLS端口 = ['443', '2053', '2083', '2087', '2096', '8443'];
const HTTP端口 = ['80', '8080', '8880', '2052', '2082', '2086', '2095'];

function 解析查询参数(查询) {
	const 列表 = [];
	(查询 || '').split('&').filter(Boolean).forEach(kv => {
		const i = kv.indexOf('=');
		const k = i < 0 ? kv : kv.slice(0, i);
		const v = i < 0 ? '' : kv.slice(i + 1);
		try { 列表.push([k, decodeURIComponent(v)]); } catch { 列表.push([k, v]); }
	});
	return 列表;
}

function 重建查询参数(列表) {
	return 列表.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

/*
 * 按端口类型修正节点 TLS 属性：
 *   端口是 TLS 端口而节点未启用 TLS → 补 security=tls 并带 sni；
 *   端口是明文端口而节点是 TLS → 去掉 security/sni。
 * reality 节点不触碰（换端口也救不了它，保持原样）。返回修正后的查询串。
 */
function 按端口修正查询TLS(查询, 端口, 条目, 协议) {
	const 参数 = 解析查询参数(查询);
	const 取 = k => { const 项 = 参数.find(([a]) => a === k); return 项 ? 项[1] : ''; };
	const 设 = (k, v) => { const 项 = 参数.find(([a]) => a === k); if (项) 项[1] = v; else 参数.push([k, v]); };
	const 删 = k => { const i = 参数.findIndex(([a]) => a === k); if (i >= 0) 参数.splice(i, 1); };

	const 原安全 = 取('security').toLowerCase();
	if (协议 !== 'trojan' && 原安全 !== 'reality') {
		if (TLS端口.includes(String(端口)) && 原安全 !== 'tls') {
			设('security', 'tls');
			if (!取('sni') && 取('host')) 设('sni', 取('host'));
		} else if (HTTP端口.includes(String(端口)) && 原安全 === 'tls') {
			删('security');
			删('sni');
		}
	}
	return 重建查询参数(参数);
}

function 解析节点(行) {
	const 文本 = (行 || '').trim();
	if (!文本) return null;
	const 匹配 = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/(.+)$/.exec(文本);
	if (!匹配) return null;
	const 协议 = 匹配[1].toLowerCase();
	if (协议 === 'vmess') return { 协议, 类型: 'vmess', 原始: 文本 };
	if (协议 === 'ssr') return { 协议, 类型: 'ssr', 原始: 文本 };
	if (!支持协议.includes(协议)) return null;
	return { 协议, 类型: 'uri', 原始: 文本 };
}

/*
 * URI 类通用改写：只替换 authority 中的 host:port 与 #fragment，
 * userinfo、路径、query 一律保持原样。
 */
function 改写URI(节点, 条目, TLS对齐) {
	const 原始 = 节点.原始;
	const 斜杠 = 原始.indexOf('://');
	const 前缀 = 原始.slice(0, 斜杠 + 3);
	const 剩余 = 原始.slice(斜杠 + 3);

	const 结束 = 找权威结束位置(剩余);
	let 权威 = 剩余.slice(0, 结束);
	let 尾部 = 剩余.slice(结束);

	const 井号 = 尾部.indexOf('#');
	if (井号 >= 0) 尾部 = 尾部.slice(0, 井号);

	let 用户信息 = '';
	const at = 权威.lastIndexOf('@');
	if (at >= 0) {
		用户信息 = 权威.slice(0, at + 1);
		权威 = 权威.slice(at + 1);
	} else {
		// ss:// 旧式整体 base64：method:pass@host:port
		const 解码 = base64解码(权威);
		if (解码 && 解码.includes('@')) {
			const at2 = 解码.lastIndexOf('@');
			用户信息 = utf8ToBase64(解码.slice(0, at2 + 1)).replace(/=+$/, '') + '@';
			权威 = 解码.slice(at2 + 1);
		}
	}

	const 端口 = 取端口(条目, 取原端口(权威));
	const 主机 = 条目.host.includes(':') ? '[' + 条目.host + ']' : 条目.host;
	const 名称 = 条目.name ? 条目.name : 条目.host + ':' + 端口;

	// 按端口类型对齐 TLS 属性
	const 问号 = 尾部.indexOf('?');
	const 路径 = 问号 >= 0 ? 尾部.slice(0, 问号) : 尾部;
	const 修正查询 = TLS对齐 ? 按端口修正查询TLS(问号 >= 0 ? 尾部.slice(问号 + 1) : '', 端口, 条目, 节点.协议) : (问号 >= 0 ? 尾部.slice(问号 + 1) : '');
	const 新尾部 = 路径 + (修正查询 ? '?' + 修正查询 : '');

	return 前缀 + 用户信息 + 主机 + ':' + 端口 + 新尾部 + '#' + encodeURIComponent(名称);
}

/* vmess://base64(JSON)：只改 add / port / ps 三个字段 */
function 改写VMess(节点, 条目, TLS对齐) {
	const 体 = 节点.原始.slice('vmess://'.length).split('#')[0].trim();
	const 解码 = base64解码(体);
	if (!解码) return null;
	let 配置;
	try {
		配置 = JSON.parse(解码);
	} catch {
		return null;
	}
	if (!配置 || typeof 配置 !== 'object') return null;

	const 端口 = 取端口(条目, parseInt(配置.port, 10) || null);
	配置.add = 条目.host;
	配置.port = String(端口);
	配置.ps = 条目.name ? 条目.name : 条目.host + ':' + 端口;

	// 按端口类型对齐 TLS 属性（vmess JSON：tls 字段 + sni）
	const 当前TLS = 配置.tls === 'tls' || 配置.tls === true;
	if (TLS对齐 && TLS端口.includes(String(端口)) && !当前TLS) {
		配置.tls = 'tls';
		if (!配置.sni) 配置.sni = 配置.host || 条目.host;
	} else if (TLS对齐 && HTTP端口.includes(String(端口)) && 当前TLS) {
		配置.tls = '';
		delete 配置.sni;
	}
	return 'vmess://' + utf8ToBase64(JSON.stringify(配置));
}

/* ssr://base64(host:port:protocol:method:obfs:password/?params) */
function 改写SSR(节点, 条目) {
	const 体 = 节点.原始.slice('ssr://'.length).split('#')[0].trim();
	const 解码 = base64解码(体);
	if (!解码) return null;
	const 段 = 解码.split(':');
	if (段.length < 2) return null;
	段[0] = 条目.host;
	段[1] = String(取端口(条目, parseInt(段[1], 10) || null));
	return 'ssr://' + utf8ToBase64(段.join(':'));
}

function 改写节点(节点, 条目, TLS对齐) {
	try {
		if (节点.类型 === 'vmess') return 改写VMess(节点, 条目, TLS对齐);
		if (节点.类型 === 'ssr') return 改写SSR(节点, 条目);
		return 改写URI(节点, 条目, TLS对齐);
	} catch {
		return null;
	}
}

// ---------------- 节点列表（base64 / 明文）改写 ----------------

// 判断文本里是否出现形如 xxx:// 的协议链接
function 像协议链接(文本) {
	return /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//m.test(文本 || '');
}

// 规范化源订阅：返回 { 文本, 格式('yaml'|'base64'|'plain') }
// 关键顺序：先识别明文 YAML / 协议链接，只有「整段都由 base64 字符组成」才尝试解码，
// 避免把节点链接误当作 base64 解码。
function 规范化源(源文本) {
	const 去头 = (源文本 || '').trim();
	if (!去头) return { 文本: '', 格式: 'plain' };

	if (/^\s*proxies\s*:/m.test(去头)) return { 文本: 源文本, 格式: 'yaml' };
	if (像协议链接(去头)) return { 文本: 源文本, 格式: 'plain' };

	if (去头.length > 16 && /^[A-Za-z0-9+/=_\-\r\n\s]+$/.test(去头)) {
		const 解码 = base64解码(去头);
		if (解码) {
			if (/^\s*proxies\s*:/m.test(解码)) return { 文本: 解码, 格式: 'yaml' };
			if (像协议链接(解码)) return { 文本: 解码, 格式: 'base64' };
		}
	}

	return { 文本: 源文本, 格式: 'plain' };
}

function 改写节点列表(明文, 条目列表, TLS对齐) {
	const 行数组 = 明文.split(/\r?\n/).filter(l => l.trim() !== '');
	const 可改写 = [];
	const 透传 = [];

	for (const 行 of 行数组) {
		const 节点 = 解析节点(行);
		if (节点) 可改写.push(节点);
		else 透传.push(行);
	}

	if (!可改写.length) return null;

	const 输出 = [];
	for (let i = 0; i < 条目列表.length; i++) {
		const 节点 = 可改写[i] || 可改写[0]; // 溢出用第一个节点作模板
		const 改写后 = 改写节点(节点, 条目列表[i], TLS对齐);
		if (改写后) 输出.push(改写后);
	}

	return 输出.concat(透传).join('\n');
}

// ---------------- clash YAML 改写（支持块式与流式两种写法） ----------------

function 记录Clash字段(节点, 键, 值, 行号) {
	if (键 === 'name') 节点.name = { 行号, 值 };
	else if (键 === 'server') 节点.server = { 行号, 值 };
	else if (键 === 'port') 节点.port = { 行号, 值 };
	else if (键 === 'tls') 节点.tls = { 行号, 值 };
	else if (键 === 'servername') 节点.servername = { 行号, 值 };
	else if (键 === 'type') 节点.type = { 行号, 值 };
	else if (键 === 'network') 节点.network = { 行号, 值 };
}

/* 流式（inline {a: b, c: d}）字段读写 */
function 读Flow字段(行, 键) {
	const m = new RegExp('\\b' + 键 + '\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\']|\\\\.)*\'|[^,}]+)').exec(行);
	return m ? m[1].trim() : null;
}

function 替换Flow值(行, 键, 新值) {
	const 正则 = new RegExp('(\\b' + 键 + '\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\']|\\\\.)*\'|[^,}]+)');
	if (!正则.test(行)) return 行;
	return 行.replace(正则, (m, 前缀) => 前缀 + yaml标量(新值));
}

function 添加Flow键(行, 键, 新值) {
	return 行.replace(/\}\s*$/, ', ' + 键 + ': ' + yaml标量(新值) + ' }');
}

function 删除Flow键(行, 键) {
	return 行.replace(new RegExp(',?\\s*\\b' + 键 + '\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\']|\\\\.)*\'|[^,}]+)'), '');
}

function 提取FlowHost(行) {
	const m = /\bHost\s*:\s*("[^"]*"|[^,}]+)/.exec(行);
	if (!m) return null;
	let v = m[1].replace(/^["']|["']$/g, '');
	try { v = decodeURIComponent(v); } catch { }
	return v;
}

function 找Clash节点(行数组) {
	let 起始 = -1;
	for (let i = 0; i < 行数组.length; i++) {
		if (/^\s*proxies\s*:/.test(行数组[i])) { 起始 = i + 1; break; }
	}
	if (起始 < 0) return [];

	const 节点 = [];
	let 当前 = null;
	for (let i = 起始; i < 行数组.length; i++) {
		const 行 = 行数组[i];
		if (行.trim() === '' || 行.trim().startsWith('#')) continue;
		if (!/^\s/.test(行)) break; // 顶层键，proxies 段结束
		const 项匹配 = /^(\s*)-(\s)(.*)$/.exec(行);
		if (项匹配) {
			if (当前) 当前.结束行 = i - 1;
			const 流式 = 项匹配[3].trim().startsWith('{');
			当前 = { 起始行: i, 流式: 流式, 行号: i };
			节点.push(当前);
			if (流式) {
				['name', 'server', 'port', 'tls', 'servername', 'type', 'network'].forEach(k => {
					const v = 读Flow字段(项匹配[3], k);
					if (v != null) 记录Clash字段(当前, k, v, i);
				});
			} else {
				const 首键 = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(项匹配[3]);
				if (首键) 记录Clash字段(当前, 首键[1], 首键[2], i);
			}
			continue;
		}
		if (当前 && !当前.流式) {
			const 键 = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(行);
			if (键) 记录Clash字段(当前, 键[1], 键[2], i);
		}
	}
	if (当前) 当前.结束行 = 行数组.length - 1;
	return 节点;
}

function 替换Yaml值(行, 键, 新值) {
	const 正则 = new RegExp('(^\\s*(?:- )?\\s*' + 键 + '\\s*:\\s*)(.*)$');
	return 行.replace(正则, (全部, 前缀, 旧值) => {
		const 引号 = /^(["'])([\s\S]*)\1$/.exec(旧值.trim());
		const 内容 = 引号 ? 引号[1] + 新值 + 引号[1] : 新值;
		return 前缀 + 内容;
	});
}

function 找Clash块内Host(行数组, 起始, 结束) {
	for (let i = 起始; i <= 结束 && i < 行数组.length; i++) {
		const 匹配 = /^\s*Host\s*:\s*(.+?)\s*$/.exec(行数组[i]);
		if (匹配) {
			let 值 = 匹配[1].replace(/^["']|["']$/g, '');
			try { 值 = decodeURIComponent(值); } catch { }
			return 值;
		}
	}
	return null;
}

function 改写Clash配置(文本, 条目列表, TLS对齐) {
	const 行数组 = 文本.split('\n');
	const 节点列表 = 找Clash节点(行数组).filter(n => n.server);
	if (!节点列表.length) return null;

	const 已用名 = new Set();
	const 新旧名 = [];
	const 待插入 = [];
	const 待删除 = [];
	const 保留名 = new Set();

	for (let i = 0; i < 条目列表.length; i++) {
		const 条目 = 条目列表[i];
		const 节点 = 节点列表[i] || 节点列表[0]; // 溢出用第一个节点作模板

		const 原端口 = 节点.port ? parseInt(String(节点.port.值).replace(/["']/g, ''), 10) : null;
		const 端口 = 取端口(条目, 原端口);
		const 名称 = 条目.name ? 条目.name : 条目.host + ':' + 端口;

		let 唯一 = 名称, 序号 = 2;
		while (已用名.has(唯一)) { 唯一 = 名称 + '-' + 序号; 序号++; }
		已用名.add(唯一);
		保留名.add(唯一);

		const 类型 = 节点.type ? String(节点.type.值).replace(/["']/g, '').trim() : '';

		if (节点.流式) {
			let 行文本 = 行数组[节点.行号];
			行文本 = 替换Flow值(行文本, 'name', 唯一);
			行文本 = 替换Flow值(行文本, 'server', 条目.host);
			行文本 = 替换Flow值(行文本, 'port', 端口);
			if (TLS对齐 && /^(vless|vmess)$/i.test(类型)) {
				const 期望TLS = TLS端口.includes(String(端口));
				const 当前声明 = 节点.tls && /^"?true"?$/i.test(String(节点.tls.值).replace(/["']/g, '').trim());
				if (期望TLS && !当前声明) 行文本 = 替换Flow值(行文本, 'tls', true);
				if (!期望TLS && 当前声明) 行文本 = 替换Flow值(行文本, 'tls', false);
				if (!期望TLS) 行文本 = 删除Flow键(行文本, 'servername');
				const 域名 = 提取FlowHost(行文本) || (节点.servername ? String(节点.servername.值).replace(/^["']/g, '') : null);
				if (期望TLS && 域名 && !读Flow字段(行文本, 'servername')) 行文本 = 添加Flow键(行文本, 'servername', 域名);
			}
			行数组[节点.行号] = 行文本;
		} else {
			if (节点.name && 节点.name.行号 >= 0) 行数组[节点.name.行号] = 替换Yaml值(行数组[节点.name.行号], 'name', 唯一);
			行数组[节点.server.行号] = 替换Yaml值(行数组[节点.server.行号], 'server', 条目.host);
			if (节点.port) 行数组[节点.port.行号] = 替换Yaml值(行数组[节点.port.行号], 'port', 端口);
		}

		// TLS 一致性对齐（块式节点）：源节点、实测端口族、最终配置三者必须一致
		if (TLS对齐 && !节点.流式 && 节点.port && /^(vless|vmess)$/i.test(类型)) {
			const 期望TLS = TLS端口.includes(String(端口));
			const 节点声明TLS = 节点.tls && /^(true|yes)$/i.test(String(节点.tls.值).trim());

			if (期望TLS && !节点声明TLS) {
				if (节点.tls) {
					行数组[节点.tls.行号] = 替换Yaml值(行数组[节点.tls.行号], 'tls', true);
				} else {
					const 插入行号 = 节点.port.行号;
					const 缩进 = (/^(\s*)/.exec(行数组[插入行号]) || ['', ''])[1];
					const 文本列表 = [缩进 + 'tls: true'];
					const 域名 = 找Clash块内Host(行数组, 节点.起始行, 节点.结束行);
					if (域名 && !节点.servername) 文本列表.push(缩进 + 'servername: ' + 域名);
					待插入.push({ 行号: 插入行号, 文本: 文本列表 });
				}
			} else if (!期望TLS && 节点声明TLS) {
				行数组[节点.tls.行号] = 替换Yaml值(行数组[节点.tls.行号], 'tls', false);
				if (节点.servername) 待删除.push(节点.servername.行号);
			} else if (!期望TLS && !节点.tls) {
				const 插入行号 = 节点.port.行号;
				const 缩进 = (/^(\s*)/.exec(行数组[插入行号]) || ['', ''])[1];
				待插入.push({ 行号: 插入行号, 文本: [缩进 + 'tls: false'] });
			}
		}

		const 原名 = 节点.name ? String(节点.name.值).replace(/^["']|["']$/g, '') : null;
		if (原名 && 原名 !== 唯一) 新旧名.push([原名, 唯一]);
	}

	// 行级插入/删除从后往前应用，避免行号位移
	const 操作 = [];
	待删除.forEach(行号 => 操作.push({ 行号, 删除: true }));
	待插入.forEach(o => 操作.push({ 行号: o.行号, 文本: o.文本 }));
	操作.sort((a, b) => b.行号 - a.行号);
	for (const op of 操作) {
		if (op.删除) 行数组.splice(op.行号, 1);
		else 行数组.splice(op.行号 + 1, 0, ...op.文本);
	}

	// 同步 proxy-groups 中的旧名称引用
	if (新旧名.length) {
		let 在组段 = false;
		for (let i = 0; i < 行数组.length; i++) {
			if (/^\s*proxy-groups\s*:/.test(行数组[i])) { 在组段 = true; continue; }
			if (在组段) {
				if (行数组[i].trim() === '') continue;
				if (!/^\s/.test(行数组[i])) break;
				for (const [旧, 新] of 新旧名) {
					const 转义 = 旧.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					行数组[i] = 行数组[i].replace(
						new RegExp('^(\\s*-\\s*)(["\']?)(' + 转义 + ')\\2(\\s*,?\\s*)$'),
						(全部, 前缀, 引号, _旧, 后缀) => 前缀 + (引号 || '') + 新 + (引号 || '') + 后缀
					);
				}
			}
		}
	}

	// 保留节点少于源时：从 proxy-groups 成员列表里移除被丢弃节点的引用
	if (节点列表.length > 条目列表.length) {
		const 组名 = new Set();
		let 在组段 = false;
		for (const l of 行数组) {
			if (/^\s*proxy-groups\s*:/.test(l)) { 在组段 = true; continue; }
			if (在组段) {
				if (l.trim() === '') continue;
				if (!/^\s/.test(l)) break;
				const m = /^\s*-\s*name\s*:\s*(.+)$/.exec(l);
				if (m) 组名.add(String(m[1]).replace(/^["']|["']$/g, '').trim());
			}
		}
		const 特殊 = new Set(['DIRECT', 'REJECT', 'GLOBAL', 'PASS']);
		let 在成员列表 = false;
		const 待删成员 = [];
		for (let i = 0; i < 行数组.length; i++) {
			const l = 行数组[i];
			if (/^\s*proxy-groups\s*:/.test(l)) { 在组段 = true; continue; }
			if (!在组段) continue;
			if (l.trim() === '') continue;
			if (!/^\s/.test(l)) break;
			if (/^\s*-\s*(name|type|server|url)\s*:/i.test(l)) { 在成员列表 = /proxies\s*:$/.test(l.trim()); continue; }
			if (/proxies\s*:$/.test(l.trim())) { 在成员列表 = true; continue; }
			if (在成员列表 && /^\s*-\s*/.test(l)) {
				const 成员 = l.replace(/^\s*-\s*/, '').replace(/["',]/g, '').trim();
				if (成员 && !保留名.has(成员) && !特殊.has(成员) && !组名.has(成员)) 待删成员.push(i);
			}
		}
		待删成员.sort((a, b) => b - a).forEach(i => 行数组.splice(i, 1));
	}

	return 行数组.join('\n');
}

// ---------------- 订阅输出 ----------------

function 订阅头(额外) {
	return Object.assign({
		'content-type': 'text/plain; charset=utf-8',
		'Profile-Update-Interval': '6',
		'Cache-Control': 'no-store'
	}, 额外 || {});
}

// ---------------- Clash 导出（节点链接 → Clash 代理对象 → 完整配置） ----------------

function 拆URI(链接) {
	const 斜杠 = 链接.indexOf('://');
	const 剩余 = 链接.slice(斜杠 + 3);
	const 结束 = 找权威结束位置(剩余);
	let 权威 = 剩余.slice(0, 结束);
	let 尾部 = 剩余.slice(结束);

	let 片段 = '';
	const 井号 = 尾部.indexOf('#');
	if (井号 >= 0) { 片段 = 尾部.slice(井号 + 1); 尾部 = 尾部.slice(0, 井号); }

	let 查询 = '', 路径 = '';
	const 问号 = 尾部.indexOf('?');
	if (问号 >= 0) { 查询 = 尾部.slice(问号 + 1); 路径 = 尾部.slice(0, 问号); }
	else 路径 = 尾部;

	let 用户信息 = '';
	const at = 权威.lastIndexOf('@');
	if (at >= 0) { 用户信息 = 权威.slice(0, at); 权威 = 权威.slice(at + 1); }
	if (!用户信息) {
		const 解码 = base64解码(权威);
		if (解码 && 解码.includes('@')) {
			const at2 = 解码.lastIndexOf('@');
			用户信息 = 解码.slice(0, at2);
			权威 = 解码.slice(at2 + 1);
		}
	}

	const 参数 = {};
	查询.split('&').filter(Boolean).forEach(kv => {
		const i = kv.indexOf('=');
		const k = i < 0 ? kv : kv.slice(0, i);
		const v = i < 0 ? '' : kv.slice(i + 1);
		try { 参数[decodeURIComponent(k)] = decodeURIComponent(v); } catch { 参数[k] = v; }
	});

	return { 用户信息, 主机端口: 权威, 路径, 参数, 片段, 协议: 链接.slice(0, 斜杠).toLowerCase() };
}

function 拆主机端口(主机端口) {
	if (主机端口.startsWith('[')) {
		const 右 = 主机端口.indexOf(']');
		const 余 = 主机端口.slice(右 + 1);
		return { server: 主机端口.slice(1, 右), port: 余.startsWith(':') ? (Number(余.slice(1)) || 443) : 443 };
	}
	const 冒号数 = (主机端口.match(/:/g) || []).length;
	const i = 主机端口.lastIndexOf(':');
	if (冒号数 === 1 && i > 0) return { server: 主机端口.slice(0, i), port: Number(主机端口.slice(i + 1)) || 443 };
	return { server: 主机端口, port: 443 };
}

function 安全解码(文本) {
	try { return decodeURIComponent(String(文本 == null ? '' : 文本)); } catch { return String(文本 == null ? '' : 文本); }
}

const UA池 = [
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
	'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36'
];

function 随机UA() {
	return UA池[Math.floor(Math.random() * UA池.length)];
}

function uri转Clash代理(协议, 链接, 名称, 加随机UA) {
	const u = 拆URI(链接);
	const hp = 拆主机端口(u.主机端口);
	const p = u.参数;
	const 传输 = (p.type || p.net || 'tcp').toLowerCase();
	const 安全 = (p.security || '').toLowerCase();
	const 代理 = { name: 名称, server: hp.server, port: hp.port };

	const 加传输 = () => {
		if (传输 === 'ws' || 传输 === 'websocket') {
			代理.network = 'ws';
			代理['ws-opts'] = { path: p.path || '/' };
			代理['ws-opts'].headers = {};
			if (p.host) 代理['ws-opts'].headers.Host = p.host;
			if (加随机UA) 代理['ws-opts'].headers['User-Agent'] = 随机UA();

		} else if (传输 === 'grpc') {
			代理.network = 'grpc';
			代理['grpc-opts'] = { 'grpc-service-name': p.serviceName || p.servicename || '' };
		} else if (传输 === 'h2' || 传输 === 'http') {
			代理.network = 'h2';
			代理['h2-opts'] = { path: p.path || '/', host: [p.host || hp.server] };
		} else {
			代理.network = 'tcp';
		}
	};

	if (协议 === 'vless' || 协议 === 'trojan') {
		代理.type = 协议;
		if (协议 === 'vless') 代理.uuid = 安全解码(u.用户信息);
		else 代理.password = 安全解码(u.用户信息);
		加传输();
		if (安全 === 'reality') {
			代理.tls = true;
			代理['reality-opts'] = { 'public-key': p.pbk || '', 'short-id': p.sid || '' };
			if (p.sni) 代理.servername = p.sni;
			if (p.fp) 代理['client-fingerprint'] = p.fp;
		} else if (协议 === 'trojan' || 安全 === 'tls') {
			代理.tls = true;
			const 域名 = p.sni || p.host;
			if (域名) 代理.servername = 域名;
			if (p.alpn) 代理.alpn = 安全解码(p.alpn).split(',').filter(Boolean);
			if (p.fp) 代理['client-fingerprint'] = p.fp;
			if (p.allowInsecure === '1' || p.allowInsecure === 'true') 代理['skip-cert-verify'] = true;
		} else {
			// 明文节点：显式写 tls: false，与实测端口族保持一致
			代理.tls = false;
		}
		if (协议 === 'vless' && p.flow) 代理.flow = p.flow;
		return 代理;
	}

	if (协议 === 'ss') {
		const 凭据 = base64解码(u.用户信息) || 安全解码(u.用户信息);
		const i = 凭据.indexOf(':');
		代理.type = 'ss';
		代理.cipher = i < 0 ? 凭据 : 凭据.slice(0, i);
		代理.password = i < 0 ? '' : 凭据.slice(i + 1);
		if (p.plugin) {
			代理.plugin = p.plugin;
			if (p['plugin-opts'] || p.obfs) 代理['plugin-opts'] = 安全解码(p['plugin-opts'] || ('obfs=' + p.obfs + (p['obfs-password'] ? ';obfs-password=' + p['obfs-password'] : '')));
		}
		return 代理;
	}

	if (协议 === 'hysteria2' || 协议 === 'hy2') {
		代理.type = 'hysteria2';
		代理.password = 安全解码(u.用户信息);
		代理.tls = true;
		if (p.sni) 代理.sni = p.sni;
		if (p.insecure === '1' || p.allowInsecure === '1') 代理['skip-cert-verify'] = true;
		if (p.obfs) 代理.obfs = p.obfs;
		if (p['obfs-password']) 代理['obfs-password'] = p['obfs-password'];
		return 代理;
	}

	if (协议 === 'tuic') {
		const 凭据 = 安全解码(u.用户信息);
		const i = 凭据.indexOf(':');
		代理.type = 'tuic';
		代理.uuid = i < 0 ? 凭据 : 凭据.slice(0, i);
		代理.password = i < 0 ? '' : 凭据.slice(i + 1);
		if (p.sni) 代理.sni = p.sni;
		if (p.alpn) 代理.alpn = 安全解码(p.alpn).split(',').filter(Boolean);
		if (p.allowInsecure === '1') 代理['skip-cert-verify'] = true;
		return 代理;
	}

	if (协议 === 'anytls') {
		代理.type = 'anytls';
		代理.password = 安全解码(u.用户信息);
		代理.tls = true;
		if (p.sni) 代理.sni = p.sni;
		if (p.allowInsecure === '1') 代理['skip-cert-verify'] = true;
		return 代理;
	}

	return null;
}

function vmess转Clash代理(链接, 名称, 加随机UA) {
	const 解码 = base64解码(链接.slice('vmess://'.length).split('#')[0].trim());
	if (!解码) return null;
	const j = JSON.parse(解码);
	if (!j || !j.add) return null;
	const 代理 = {
		name: 名称, type: 'vmess',
		server: j.add, port: Number(j.port) || 443,
		uuid: j.id, alterId: Number(j.aid) || 0, cipher: j.scy || 'auto'
	};
	const 传输 = String(j.net || 'tcp').toLowerCase();
	if (传输 === 'ws') {
		代理.network = 'ws';
		代理['ws-opts'] = { path: j.path || '/' };
		代理['ws-opts'].headers = {};
		if (j.host) 代理['ws-opts'].headers.Host = j.host;
		if (加随机UA) 代理['ws-opts'].headers['User-Agent'] = 随机UA();

	} else if (传输 === 'grpc') {
		代理.network = 'grpc';
		代理['grpc-opts'] = { 'grpc-service-name': j.path || '' };
	} else if (传输 === 'h2') {
		代理.network = 'h2';
		代理['h2-opts'] = { path: j.path || '/', host: [j.host || j.add] };
	} else {
		代理.network = 'tcp';
	}
	if (j.tls === 'tls' || j.tls === true) {
		代理.tls = true;
		代理.servername = j.sni || j.host || '';
		if (j.alpn) 代理.alpn = String(j.alpn).split(',').filter(Boolean);
	} else {
		// 明文节点：显式写 tls: false，与实测端口族保持一致
		代理.tls = false;
	}
	return 代理;
}

function 取节点名称(行) {
	const t = String(行 || '').trim();
	if (/^vmess:\/\//i.test(t)) {
		const 解码 = base64解码(t.slice('vmess://'.length).split('#')[0].trim());
		if (解码) {
			try {
				const j = JSON.parse(解码);
				if (j && j.ps) return String(j.ps);
			} catch { }
		}
		return t;
	}
	const 井 = t.lastIndexOf('#');
	return 井 >= 0 ? 安全解码(t.slice(井 + 1)) : t;
}

function 链接转Clash代理(链接, 名称, 加随机UA) {
	let 节点;
	try { 节点 = 解析节点(链接); } catch { return null; }
	if (!节点) return null;
	try {
		if (节点.类型 === 'vmess') return vmess转Clash代理(节点.原始, 名称, 加随机UA);
		if (节点.类型 === 'ssr') return null; // ssr 暂不支持导出为 Clash
		return uri转Clash代理(节点.协议, 节点.原始, 名称, 加随机UA);
	} catch {
		return null;
	}
}

// --- 极简 YAML 输出（只用于我们自建的代理对象结构） ---

function yaml标量(v) {
	if (v === true) return 'true';
	if (v === false) return 'false';
	if (typeof v === 'number') return String(v);
	const s = String(v == null ? '' : v);
	if (s === '') return '""';
	if (/^(true|false|null|yes|no|on|off)$/i.test(s)) return '"' + s + '"';
	// 纯数字才需要加引号（避免被解析成数字）；含 “: ” 或首尾易歧义字符的也要加引号
	if (/^[+-]?\d+(\.\d+)?$/.test(s)) return '"' + s + '"';
	if (/^[A-Za-z0-9_./@+\-:\u4e00-\u9fa5]+$/.test(s) && !/:\s/.test(s) && !s.endsWith(':')) return s;
	return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function yaml块(对象, 缩进) {
	const 缩 = ' '.repeat(缩进);
	let 输出 = '';
	for (const [k, v] of Object.entries(对象)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			输出 += 缩 + k + ':\n';
			v.forEach(项 => { 输出 += 缩 + '  - ' + yaml标量(项) + '\n'; });
		} else if (typeof v === 'object') {
			输出 += 缩 + k + ':\n' + yaml块(v, 缩进 + 2);
		} else {
			输出 += 缩 + k + ': ' + yaml标量(v) + '\n';
		}
	}
	return 输出;
}

function 代理转YAML行(代理) {
	const 行 = yaml块(代理, 0).replace(/\n$/, '').split('\n');
	return 行.map((l, i) => i === 0 ? '  - ' + l : '    ' + l).join('\n');
}

const 默认Clash模板 = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090
dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
proxies:
proxy-groups:
  - name: 选择
    type: select
    proxies:
      - 自动
      - DIRECT
  - name: 自动
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    proxies:
__PROXIES_NAMES__
rules:
  - GEOIP,CN,DIRECT
  - MATCH,选择
`;

// 把模板里的顶层 `键:` 段整体换成新内容；模板没有该段则追加（只认行首无缩进的顶层键）
function 替换Clash段(文本, 键, 新段) {
	const 行数组 = 文本.split('\n');
	let 起 = -1, 止 = 行数组.length;
	for (let i = 0; i < 行数组.length; i++) {
		if (new RegExp('^' + 键 + '\\s*:').test(行数组[i])) { 起 = i; break; }
	}
	if (起 < 0) return 文本.replace(/\s*$/, '\n') + 新段 + '\n';
	for (let i = 起 + 1; i < 行数组.length; i++) {
		if (行数组[i].trim() === '' || 行数组[i].trim().startsWith('#')) continue;
		if (!/^\s/.test(行数组[i])) { 止 = i; break; }
	}
	return 行数组.slice(0, 起).concat(新段.split('\n'), 行数组.slice(止)).join('\n');
}

function 生成Clash配置(代理列表, 模板文本, 跳过说明) {
	const 代理YAML = 代理列表.map(代理转YAML行).join('\n');
	const 名称列表 = 代理列表.map(a => '      - ' + yaml标量(a.name)).join('\n');
	const 段 = (跳过说明.length ? '# 以下节点未能转换为 Clash：' + 跳过说明.join(' / ') + '\n' : '') + 'proxies:\n' + 代理YAML;

	let 文本 = 模板文本 && 模板文本.trim() ? 模板文本 : 默认Clash模板;
	文本 = 替换Clash段(文本, 'proxies', 段);
	文本 = 文本.replaceAll('__PROXIES_NAMES__', 名称列表);
	return 文本;
}

async function 改写订阅(配置, 用户代理, 原始UA) {
	const 拉取UA = 解析拉取UA(配置.pullua, 原始UA);
	const 源地址 = 配置.url;
	const 内联链接 = 配置.link || '';

	if (!源地址 && !内联链接) {
		return new Response('缺少源订阅：请提供 url 参数或 link 节点内容', { status: 400, headers: 订阅头() });
	}

	let 源文本 = '';
	try {
		if (内联链接) 源文本 = 内联链接;
		if (源地址) {
			源文本 = await 拉取远程(源地址, 拉取UA, 10000);
		}
	} catch (错误) {
		return new Response('源订阅拉取失败：' + 错误.message, { status: 502, headers: 订阅头() });
	}

	if (!源文本 || !源文本.trim()) {
		return new Response('源订阅内容为空', { status: 502, headers: 订阅头() });
	}

	// 实测列表
	let 实测文本 = 配置.add || '';
	if (!实测文本 && 配置.addapi) {
		try {
			实测文本 = await 拉取远程(配置.addapi, 拉取UA, 10000);
		} catch (错误) {
			return new Response('实测优选列表拉取失败：' + 错误.message, { status: 502, headers: 订阅头() });
		}
	}

	let 条目列表 = 切分列表(实测文本).map(解析实测条目).filter(Boolean);

	const 数量 = parseInt(配置.num, 10);
	if (数量 > 0) 条目列表 = 条目列表.slice(0, 数量);

	const 规范化 = 规范化源(源文本);

	if (!条目列表.length) {
		// 没有实测列表时原样返回，至少不给客户端坏订阅
		return new Response(规范化.格式 === 'base64' ? 源文本.trim() : 规范化.文本, {
			headers: 订阅头({ 'content-type': 规范化.格式 === 'yaml' ? 'text/yaml; charset=utf-8' : 'text/plain; charset=utf-8' })
		});
	}

	if (规范化.格式 === 'yaml') {
		const 改写后 = 改写Clash配置(规范化.文本, 条目列表, 配置.tls !== '0');
		if (改写后) {
			return new Response(改写后, { headers: 订阅头({ 'content-type': 'text/yaml; charset=utf-8' }) });
		}
		// YAML 里没找到可改写的 proxies，退回节点列表处理
	}

	const 改写后 = 改写节点列表(规范化.文本, 条目列表, 配置.tls !== '0');
	if (!改写后) {
		return new Response('源订阅中没有可改写的节点（已识别的协议：' + 支持协议.join(' / ') + ' / vmess / ssr）', { status: 400, headers: 订阅头() });
	}

	let 输出 = 改写后;
	const 格式 = (配置.format || 'auto').toLowerCase();
	const 浏览器 = /mozilla|chrome|safari|firefox|edge/i.test(用户代理 || '');

	if (格式 === 'clash') {
		const 行数组 = 改写后.split('\n').filter(l => /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(l.trim()));
		const 代理列表 = [];
		const 跳过 = [];
		for (const 行 of 行数组) {
			const 名称 = 取节点名称(行);
			const 代理 = 链接转Clash代理(行, 名称, 配置.ua === '1');
			if (代理) 代理列表.push(代理);
			else 跳过.push(名称);
		}
		if (!代理列表.length) {
			return new Response('无法把任何节点转换为 Clash 配置（ssr 等协议暂不支持导出）', { status: 400, headers: 订阅头() });
		}
		const 配置文本 = 生成Clash配置(代理列表, 配置.template || '', 跳过);
		return new Response(配置文本, {
			headers: 订阅头({
				'content-type': 'text/yaml; charset=utf-8',
				'Content-Disposition': "attachment; filename*=utf-8''config.yaml"
			})
		});
	}

	if (格式 === 'base64' || (格式 !== 'plain' && !浏览器 && 规范化.格式 === 'base64')) {
		输出 = btoa(unescape(encodeURIComponent(改写后)));
	}

	return new Response(输出, { headers: 订阅头() });
}

// ---------------- KV 配置档 ----------------

async function 读配置索引(KV) {
	try {
		return JSON.parse((await KV.get(配置索引键)) || '[]');
	} catch {
		return [];
	}
}

function json响应(数据, 状态) {
	return new Response(JSON.stringify(数据, null, 2), {
		status: 状态 || 200,
		headers: { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
	});
}

async function 处理配置档接口(request, url, env) {
	const KV = env ? env[KV绑定名] : null;
	if (!KV) return json响应({ error: '未绑定 KV，当前为手动模式' }, 501);

	const 动作 = url.searchParams.get('action') || '';
	const id = url.searchParams.get('id') || '';

	if (request.method === 'GET' && (动作 === 'list' || !id)) {
		const 索引 = await 读配置索引(KV);
		const 列表 = [];
		for (const 档id of 索引) {
			const 配置 = await KV.get(配置键前缀 + 档id, 'json');
			if (配置) 列表.push({ id: 档id, label: 配置.label || 档id });
		}
		return json响应({ list: 列表 });
	}

	if (request.method === 'GET') {
		const 配置 = await KV.get(配置键前缀 + id, 'json');
		if (!配置) return json响应({ error: '配置档不存在' }, 404);
		delete 配置.k;
		return json响应(配置);
	}

	if (request.method === 'POST') {
		let 提交;
		try {
			提交 = await request.json();
		} catch {
			return json响应({ error: '请求体不是合法 JSON' }, 400);
		}
		if (!提交.url && !提交.link && !提交.add && !提交.addapi) {
			return json响应({ error: '请至少填写源订阅或实测列表' }, 400);
		}

		let 目标id = id || 提交.id || '';
		let 密钥 = 提交.k || url.searchParams.get('k') || '';
		const 索引 = await 读配置索引(KV);

		if (目标id) {
			const 已有 = await KV.get(配置键前缀 + 目标id, 'json');
			if (已有) {
				if (已有.k && 已有.k !== 密钥) return json响应({ error: '密钥不正确' }, 403);
				密钥 = 密钥 || 已有.k;
			} else if (!密钥) {
				密钥 = 随机密钥();
			}
		} else {
			目标id = 随机ID();
			密钥 = 密钥 || 随机密钥();
		}

		const 记录 = {
			url: 提交.url || '',
			link: 提交.link || '',
			add: 提交.add || '',
			addapi: 提交.addapi || '',
			num: 提交.num || '',
			format: 提交.format || 'auto',
			template: 提交.template || '',
			tls: 提交.tls || '1',
			ua: 提交.ua || '0',
			pullua: 提交.pullua || 'auto',
			label: 提交.label || 目标id,
			k: 密钥,
			updated: new Date().toISOString()
		};

		await KV.put(配置键前缀 + 目标id, JSON.stringify(记录));
		if (!索引.includes(目标id)) {
			索引.push(目标id);
			await KV.put(配置索引键, JSON.stringify(索引));
		}

		return json响应({
			ok: true, id: 目标id, k: 密钥,
			url: 'https://' + request.headers.get('host') + '/s/' + 目标id + '?k=' + 密钥
		});
	}

	if (request.method === 'DELETE') {
		const 已有 = await KV.get(配置键前缀 + id, 'json');
		if (!已有) return json响应({ error: '配置档不存在' }, 404);
		const k = url.searchParams.get('k') || '';
		if (已有.k && 已有.k !== k) return json响应({ error: '密钥不正确' }, 403);
		await KV.delete(配置键前缀 + id);
		const 索引 = (await 读配置索引(KV)).filter(x => x !== id);
		await KV.put(配置索引键, JSON.stringify(索引));
		return json响应({ ok: true });
	}

	return json响应({ error: '不支持的方法' }, 405);
}

async function 处理配置档订阅(request, url, 路径, 用户代理, env) {
	const KV = env ? env[KV绑定名] : null;
	if (!KV) return new Response('未绑定 KV：无法读取配置档', { status: 501, headers: 订阅头() });

	const id = 路径.replace(/^\/s\//, '').replace(/\/+$/, '');
	const 配置 = await KV.get(配置键前缀 + id, 'json');
	if (!配置) return new Response('配置档不存在', { status: 404, headers: 订阅头() });

	const k = url.searchParams.get('k') || '';
	if (配置.k && 配置.k !== k) return new Response('密钥不正确', { status: 403, headers: 订阅头() });

	return 改写订阅(Object.assign({}, 配置, { tls: url.searchParams.get('tls') || 配置.tls || '1', ua: url.searchParams.get('ua') || 配置.ua || '0', pullua: url.searchParams.get('pullua') || 配置.pullua || 'auto' }), 用户代理, request.headers.get('User-Agent') || '');
}

// ---------------- 页面 ----------------

function 页面(KV可用) {
	return new Response(HTML模板.replace('__KV_AVAILABLE__', KV可用 ? 'true' : 'false'), {
		headers: { 'content-type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' }
	});
}

const HTML模板 = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>实测优选订阅改写器</title>
	<style>
		:root { --primary-color:#4361ee; --hover-color:#3b4fd3; --bg-color:#f5f6fa; }
		* { box-sizing:border-box; margin:0; padding:0; }
		body {
			background:#f5f6fa;
			font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
			line-height:1.6; color:#333; min-height:100vh;
			display:flex; justify-content:center; align-items:flex-start; padding:32px 16px;
		}
		.container {
			max-width:640px; width:100%; background:#fff;
			padding:2rem; border-radius:16px; box-shadow:0 10px 20px rgba(0,0,0,.06);
		}
		h1 { text-align:center; color:var(--primary-color); margin-bottom:.5rem; font-size:1.6rem; }
		.desc { text-align:center; color:#666; font-size:.9rem; margin-bottom:1.5rem; }
		.input-group { margin-bottom:1.2rem; }
		label { display:block; margin-bottom:.4rem; color:#555; font-weight:600; font-size:.9rem; }
		.hint { font-size:.8rem; color:#888; margin-top:.3rem; }
		input, select, textarea {
			width:100%; padding:10px 12px; border:2px solid rgba(0,0,0,.12);
			border-radius:10px; font-size:1rem; font-family:inherit;
			transition:all .2s ease;
		}
		textarea { resize:vertical; min-height:5em; line-height:1.5; }
		#add { min-height:9em; }
		input:focus, select:focus, textarea:focus {
			outline:none; border-color:var(--primary-color);
			box-shadow:0 0 0 3px rgba(67,97,238,.15);
		}
		.row { display:flex; gap:12px; }
		.row > * { flex:1; }
		button {
			width:100%; padding:12px; background:var(--primary-color); color:#fff;
			border:none; border-radius:10px; font-size:1rem; font-weight:600;
			cursor:pointer; transition:all .2s ease;
		}
		button:hover { background:var(--hover-color); }
		button + button { margin-top:8px; }
		button.ghost { background:#fff; color:var(--primary-color); border:2px solid var(--primary-color); }
		button.ghost:hover { background:#f0f2ff; }
		button.mini { padding:8px; font-size:.85rem; }
		#result { background:#f8f9fa; font-family:monospace; word-break:break-all; }
		#qrcode { display:flex; justify-content:center; margin-top:14px; }
		.section { border-top:1px solid #eee; margin-top:1.6rem; padding-top:1.2rem; }
		.section h2 { font-size:1rem; color:#444; margin-bottom:.8rem; }
		.status { font-size:.85rem; margin-top:.6rem; min-height:1.2em; }
		.ok { color:#1a7f37; } .err { color:#c92a2a; }
		.badge { display:inline-block; font-size:.75rem; padding:2px 8px; border-radius:10px; background:#eee; color:#666; }
		.badge.on { background:#e6f4ea; color:#1a7f37; }
		.badge.off { background:#fff4e5; color:#b06000; }
	</style>
	<script src="https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js"></script>
</head>
<body>
	<div class="container">
		<h1>实测优选订阅改写器</h1>
		<p class="desc">源订阅连接信息原样保留，仅按位置替换「地址:端口」<br>
		<span id="kvBadge" class="badge"></span></p>

		<div class="input-group">
			<label for="url">源订阅地址</label>
			<textarea id="url" placeholder="https://example.com/sub?host=...&#10;（也可直接在这里粘贴节点链接，每行一个）"></textarea>
		</div>

		<div class="input-group">
			<label for="pullua">拉取源订阅的客户端类型（User-Agent）</label>
			<select id="pullua" onchange="切换拉取UA()">
				<option value="auto">自动跟随客户端（默认）</option>
				<option value="clash">Clash（拉取 Clash YAML）</option>
				<option value="v2rayng">v2rayNG（拉取 base64 节点）</option>
				<option value="v2rayn">v2rayN</option>
				<option value="surge">Surge</option>
				<option value="shadowrocket">Shadowrocket</option>
				<option value="custom">自定义…</option>
			</select>
			<input type="text" id="pulluaCustom" placeholder="输入完整 User-Agent 字符串" style="display:none;margin-top:6px">
			<div class="hint">自适应订阅按拉取 UA 返回不同内容：要拿 Clash YAML 就选 Clash（输出格式建议同时选「Clash 配置」）。</div>
		</div>

		<div class="input-group">
			<label for="listSrc">实测优选列表来源</label>
			<select id="listSrc">
				<option value="text">粘贴文本</option>
				<option value="url">远程 URL（ADDAPI）</option>
			</select>
		</div>

		<div class="input-group" id="addBox">
			<label for="add">实测优选列表</label>
			<textarea id="add" placeholder="每行一个：&#10;1.2.3.4:443&#10;5.6.7.8:2053#香港-01&#10;[2001:db8::1]:443#日本"></textarea>
			<div class="hint">支持 <code>ip:端口</code>、<code>ip:端口#名称</code>、<code>[IPv6]:端口</code>；逗号或换行分隔。带 #名称 的按原样作节点名，未带的默认用「ip:端口」作名。</div>
		</div>

		<div class="input-group" id="addapiBox" style="display:none">
			<label for="addapi">实测优选列表 URL</label>
			<input type="text" id="addapi" placeholder="https://你的列表地址/list.txt">
			<div class="hint">内容格式同上；更新列表内容后，客户端刷新订阅即自动生效。</div>
		</div>

		<div class="input-group">
			<label style="display:flex;align-items:center;gap:8px;font-weight:500">
				<input type="checkbox" id="tlsFix" style="width:auto;margin:0" checked>
				按端口自动匹配 TLS（TLS 端口补 tls，明文端口去 tls；不勾选则保持源节点原样）
			</label>
			<label style="display:flex;align-items:center;gap:8px;font-weight:500;margin-top:.4rem">
				<input type="checkbox" id="uaGen" style="width:auto;margin:0">
				生成随机 User-Agent 头（默认不生成）
			</label>
		</div>

		<div class="row">
			<div class="input-group">
				<label for="num">生成数量</label>
				<input type="number" id="num" min="1" placeholder="留空 = 全部">
			</div>
			<div class="input-group">
				<label for="format">输出格式</label>
				<select id="format" onchange="切换模板框()">
					<option value="auto">自动（跟随源）</option>
					<option value="base64">base64</option>
					<option value="plain">明文</option>
					<option value="clash">Clash 配置</option>
				</select>
			</div>
		</div>

		<div class="input-group" id="templateBox" style="display:none">
			<label for="template">Clash 模板（可选）</label>
			<textarea id="template" placeholder="留空 = 使用内置默认模板（含 mixed-port / dns / proxy-groups / rules）&#10;也可粘贴你自己的 config.yaml 覆盖：其中 proxies: 段会被改写后的节点替换，&#10;proxy-groups 里可用 __PROXIES_NAMES__ 占位符插入节点名列表。"></textarea>
			<div class="hint">仅在「输出格式 = Clash 配置」且源为节点链接时生效；源本身是 Clash 配置时会原样改写，不动你的 groups/rules。</div>
		</div>

		<div class="input-group">
			<label for="path">自定义路径（可选）</label>
			<input type="text" id="path" placeholder="留空使用 /re">
		</div>

		<div class="input-group">
			<button onclick="生成()">生成订阅地址</button>
			<div class="status" id="genStatus"></div>
		</div>

		<div class="input-group">
			<label for="result">订阅地址</label>
			<input type="text" id="result" readonly onclick="复制(this)">
			<div id="qrcode"></div>
		</div>

		<div class="section" id="profileSection">
			<h2>配置档（需绑定 KV）</h2>
			<div class="input-group">
				<label for="profileList">已保存的配置档</label>
				<select id="profileList" onchange="载入配置档(this.value)">
					<option value="">— 选择一个配置档 —</option>
				</select>
			</div>
			<div class="input-group">
				<label for="label">名称</label>
				<input type="text" id="label" placeholder="例如：主力线路">
			</div>
			<button class="ghost mini" onclick="保存配置档(false)">保存为新配置档</button>
			<button class="ghost mini" onclick="保存配置档(true)">覆盖当前配置档</button>
			<button class="ghost mini" onclick="删除配置档()">删除当前配置档</button>
			<div class="status" id="profileStatus"></div>
		</div>
	</div>

	<script>
		var KV可用 = __KV_AVAILABLE__;
		var 当前档 = '';

		function 取值(id) { return (document.getElementById(id).value || '').trim(); }
		function 存储(key, val) { try { val === null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch (e) {} }
		function 读档(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }

		function 填表() {
			document.getElementById('url').value = 读档('url');
			document.getElementById('add').value = 读档('add');
			document.getElementById('addapi').value = 读档('addapi');
			document.getElementById('num').value = 读档('num');
			document.getElementById('format').value = 读档('format') || 'auto';
			document.getElementById('template').value = 读档('template');
			document.getElementById('path').value = 读档('path');
			document.getElementById('listSrc').value = 读档('listSrc') || 'text';
			document.getElementById('tlsFix').checked = 读档('tlsFix') !== '0';
			document.getElementById('uaGen').checked = 读档('uaGen') === '1';
			document.getElementById('pullua').value = 读档('pullua') || 'auto';
			document.getElementById('pulluaCustom').value = 读档('pulluaCustom');
			切换列表来源();
			切换模板框();
			切换拉取UA();
		}

		function 存表() {
			['url','add','addapi','num','format','template','path','listSrc','label'].forEach(function (k) { 存储(k, 取值(k)); });
			存储('tlsFix', document.getElementById('tlsFix').checked ? '1' : '0');
			存储('uaGen', document.getElementById('uaGen').checked ? '1' : '0');
			存储('pullua', 取值('pullua'));
			存储('pulluaCustom', 取值('pulluaCustom'));
		}

		function 切换列表来源() {
			var 远程 = document.getElementById('listSrc').value === 'url';
			document.getElementById('addBox').style.display = 远程 ? 'none' : '';
			document.getElementById('addapiBox').style.display = 远程 ? '' : 'none';
		}

		function 切换模板框() {
			document.getElementById('templateBox').style.display = 取值('format') === 'clash' ? '' : 'none';
		}

		function 切换拉取UA() {
			document.getElementById('pulluaCustom').style.display = 取值('pullua') === 'custom' ? '' : 'none';
		}

		function 取拉取UA() {
			var 选择 = 取值('pullua');
			if (!选择 || 选择 === 'auto') return 'auto';
			if (选择 === 'custom') return 取值('pulluaCustom');
			return 选择;
		}

		function 组装查询() {
			var 参数 = [];
			var url = 取值('url');
			var addapi = 取值('addapi');
			var add = 取值('add');
			if (url) 参数.push('url=' + encodeURIComponent(url));
			if (document.getElementById('listSrc').value === 'url') {
				if (addapi) 参数.push('addapi=' + encodeURIComponent(addapi));
			} else if (add) {
				参数.push('add=' + encodeURIComponent(add));
			}
			if (取值('num')) 参数.push('num=' + encodeURIComponent(取值('num')));
			var format = 取值('format');
			if (format && format !== 'auto') 参数.push('format=' + encodeURIComponent(format));
			if (format === 'clash' && 取值('template')) 参数.push('template=' + encodeURIComponent(取值('template')));
			if (!document.getElementById('tlsFix').checked) 参数.push('tls=0');
			if (document.getElementById('uaGen').checked) 参数.push('ua=1');
			var 拉取UA = 取拉取UA();
			if (拉取UA !== 'auto') 参数.push('pullua=' + encodeURIComponent(拉取UA));
			return 参数.join('&');
		}

		function 展示订阅(地址, 状态文本) {
			document.getElementById('result').value = 地址;
			var 二维码 = document.getElementById('qrcode');
			二维码.innerHTML = '';
			new QRCode(二维码, { text: 地址, width: 220, height: 220, colorDark: '#4a60ea', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.L });
			if (状态文本 !== undefined) 提示('genStatus', 状态文本, true);
		}

		function 生成() {
			存表();
			if (!取值('url')) { 提示('genStatus', '请填写源订阅地址（或直接粘贴节点链接）', false); return; }
			var 远程列表 = document.getElementById('listSrc').value === 'url';
			if (远程列表 && !取值('addapi')) { 提示('genStatus', '请填写实测优选列表 URL', false); return; }
			if (!远程列表 && !取值('add')) { 提示('genStatus', '请填写实测优选列表', false); return; }
			var 查询 = 组装查询();
			var 路径 = 取值('path') || '/re';
			if (路径.charAt(0) !== '/') 路径 = '/' + 路径;
			var 地址 = location.origin + 路径 + '?' + 查询;
			展示订阅(地址, '已生成。客户端订阅此地址；之后改配置后重新生成新地址即可。');
		}

		function 复制(el) {
			if (!el.value) return;
			el.select();
			navigator.clipboard.writeText(el.value).then(function () {
				提示('genStatus', '已复制到剪贴板', true);
			}).catch(function () { alert('复制失败，请手动复制'); });
		}

		function 提示(id, 文本, 成功) {
			var el = document.getElementById(id);
			el.textContent = 文本;
			el.className = 'status ' + (成功 ? 'ok' : 'err');
		}

		function 请求(url, 选项) {
			return fetch(url, 选项).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || r.status); return d; }); });
		}

		function 保存配置档(覆盖) {
			if (!KV可用) { 提示('profileStatus', '未绑定 KV，当前为手动模式', false); return; }
			存表();
			var 负载 = {
				url: 取值('url'), link: '', add: 取值('add'), addapi: 取值('addapi'),
				num: 取值('num'), format: 取值('format') || 'auto', template: 取值('template'), label: 取值('label'),
				tls: document.getElementById('tlsFix').checked ? '1' : '0',
				ua: document.getElementById('uaGen').checked ? '1' : '0',
				pullua: 取拉取UA()
			};
			var 地址 = '/api/profile' + (覆盖 && 当前档 ? '?id=' + encodeURIComponent(当前档) + '&k=' + encodeURIComponent(读档('k') || '') : '');
			请求(地址, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(负载) })
				.then(function (d) {
					当前档 = d.id; 存储('k', d.k); 存储('id', d.id);
					存储('短链_' + d.id, d.url);
					展示订阅(d.url, '已保存为新配置档，短链已放入订阅地址框（KV 最终一致，稍等一两秒生效）');
					刷新配置档列表();
				})
				.catch(function (e) { 提示('profileStatus', '保存失败：' + e.message, false); });
		}

		function 载入配置档(id) {
			if (!id) { 当前档 = ''; 存储('id', ''); return; }
			当前档 = id;
			请求('/api/profile?id=' + encodeURIComponent(id))
				.then(function (d) {
					document.getElementById('url').value = d.url || '';
					document.getElementById('add').value = d.add || '';
					document.getElementById('addapi').value = d.addapi || '';
					document.getElementById('num').value = d.num || '';
					document.getElementById('format').value = d.format || 'auto';
					document.getElementById('template').value = d.template || '';
					document.getElementById('tlsFix').checked = d.tls !== '0';
					document.getElementById('uaGen').checked = d.ua === '1';
					document.getElementById('pullua').value = (d.pullua && 拉取UA预设键[d.pullua] !== undefined) ? 拉取UA预设键[d.pullua] : (d.pullua ? 'custom' : 'auto');
					document.getElementById('pulluaCustom').value = (document.getElementById('pullua').value === 'custom') ? (d.pullua || '') : '';
					document.getElementById('label').value = d.label || '';
					document.getElementById('listSrc').value = (d.addapi && !d.add) ? 'url' : 'text';
					切换列表来源(); 切换模板框(); 存表();
					var 已存短链 = 读档('短链_' + id);
					if (已存短链) 展示订阅(已存短链, '已载入配置档「' + (d.label || id) + '」，短链已放入订阅地址框');
					else { document.getElementById('result').value = ''; document.getElementById('qrcode').innerHTML = ''; 提示('profileStatus', '已载入配置档「' + (d.label || id) + '」；本设备未保存该档短链（保存一次即可生成）', true); }
				})
				.catch(function (e) { 提示('profileStatus', '载入失败：' + e.message, false); });
		}

		function 刷新配置档列表() {
			if (!KV可用) return;
			请求('/api/profile?action=list').then(function (d) {
				var sel = document.getElementById('profileList');
				sel.innerHTML = '<option value="">— 选择一个配置档 —</option>';
				(d.list || []).forEach(function (p) {
					var opt = document.createElement('option');
					opt.value = p.id; opt.textContent = p.label + ' (' + p.id + ')';
					sel.appendChild(opt);
				});
				if (当前档) sel.value = 当前档;
			}).catch(function () {});
		}

		function 删除配置档() {
			if (!KV可用) { 提示('profileStatus', '未绑定 KV，当前为手动模式', false); return; }
			if (!当前档) { 提示('profileStatus', '请先选择一个配置档', false); return; }
			if (!confirm('确定删除配置档 ' + 当前档 + ' ？（此操作不可撤销）')) return;
			请求('/api/profile?id=' + encodeURIComponent(当前档) + '&k=' + encodeURIComponent(读档('k') || ''), { method: 'DELETE' })
				.then(function () { 提示('profileStatus', '已删除', true); 当前档 = ''; 存表(); 刷新配置档列表(); })
				.catch(function (e) { 提示('profileStatus', '删除失败：' + e.message, false); });
		}

		var 拉取UA预设键 = { 'clash-verge/v2.0.0': 'clash', 'mihomo/1.19.28': 'mihomo', 'v2rayNG/1.9.16': 'v2rayng', 'v2rayN/7.13.5': 'v2rayn', 'Surge iOS/3374': 'surge', 'Shadowrocket/2.2.55': 'shadowrocket' };

		function 初始化() {
			var badge = document.getElementById('kvBadge');
			if (KV可用) {
				badge.textContent = 'KV 已绑定：支持配置档';
				badge.className = 'badge on';
			} else {
				badge.textContent = '未绑定 KV：手动模式（功能完整，无配置档）';
				badge.className = 'badge off';
			}
			document.getElementById('listSrc').onchange = 切换列表来源;
			document.getElementById('pullua').onchange = 切换拉取UA;
			填表();
			当前档 = 读档('id');
			刷新配置档列表();
		}

		初始化();
	</script>
</body>
</html>`;

// ---------------- 入口 ----------------

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const 路径 = url.pathname.replace(/\/+$/, '') || '/';
		const 用户代理 = (request.headers.get('User-Agent') || '').toLowerCase();

		try {
			if (路径 === '/' || 路径 === '/index.html') {
				return 页面(!!(env && env[KV绑定名]));
			}

			if (路径.startsWith('/api/profile')) {
				return await 处理配置档接口(request, url, env);
			}

			if (路径.startsWith('/s/')) {
				return await 处理配置档订阅(request, url, 路径, 用户代理, env);
			}

			// 其余路径只要带改写相关参数即视为临时直连
			if (url.searchParams.has('url') || url.searchParams.has('link') || url.searchParams.has('add') || url.searchParams.has('addapi')) {
				return await 改写订阅({
					url: url.searchParams.get('url') || '',
					link: url.searchParams.get('link') || '',
					add: url.searchParams.get('add') || '',
					addapi: url.searchParams.get('addapi') || '',
					num: url.searchParams.get('num') || '',
					format: url.searchParams.get('format') || 'auto',
					template: url.searchParams.get('template') || '',
					tls: url.searchParams.get('tls') || '1',
					ua: url.searchParams.get('ua') || '0',
					pullua: url.searchParams.get('pullua') || 'auto'
				}, 用户代理, request.headers.get('User-Agent') || '');
			}

			return new Response('Not Found', { status: 404, headers: 订阅头() });
		} catch (错误) {
			return new Response('Error: ' + (错误 && 错误.message ? 错误.message : String(错误)), {
				status: 500,
				headers: 订阅头()
			});
		}
	}
};
