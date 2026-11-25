/*
 * SpeedSub · Cloudflare 优选订阅改写与多源聚合器
 *
 * 核心原则：
 *   1. 仅处理 IP（server/add）、端口（port）与节点名称（name/ps/#），绝不修改 tls、sni、ech-opts 等节点配置选项。
 *   2. 纯汇总模式（未填 CF 优选数据）：多源并发聚合 + 双向格式转换 + 全局去重，不精简不改写原节点。
 *   3. CF 优选模式：三层精准识别 CF 节点，按独立落地归并保留 1 条基准原节点，Append 优选节点严格按 TLS / 非 TLS 端口池对口配对。
 *
 * 路由：
 *   /                   Web 控制台（@ui-sdk/web 零构建单文件）
 *   /re?url=...         临时直连转换（不依赖 KV，不受 ADMIN_PASS 限制）
 *   /s/<id>?k=<key>     KV 配置档固定短链（不受 ADMIN_PASS 限制）
 *   /api/health         运行状态检查
 *   /api/auth           ADMIN_PASS 登录校验（仅在配置 ADMIN_PASS 时启用）
 *   /api/logout         退出管理登录
 *   /api/profile        KV 配置档增删改查
 *   /api/preview        真实拉取、缺类型检测与结果文件预览
 *
 * 环境变量（全部可选）：
 *   SpeedSub_KV         KV namespace binding 名（未绑定自动降级手动模式）
 *   ADMIN_PASS          管理页口令保护（未设置时免登录，/api/profile 直接返回完整短链）
 */

const KV_BINDING = 'SpeedSub_KV';
const PROFILE_PREFIX = 'prof:';
const PROFILE_INDEX_KEY = 'prof:index';
const ADMIN_COOKIE_NAME = 'speedsub_admin';

const SUPPORTED_URI_PROTOCOLS = new Set([
	'vless', 'vmess', 'trojan', 'ss', 'ssr',
	'hysteria', 'hysteria2', 'hy2', 'tuic', 'anytls',
	'wireguard', 'socks', 'snell', 'mieru', 'juicity'
]);

const CF_ELIGIBLE_TYPES = new Set(['vless', 'vmess', 'trojan']);
const CF_CDN_NETWORKS = new Set(['ws', 'grpc', 'xhttp', 'httpupgrade', 'splithttp']);

const TLS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);
const NOTLS_PORTS = new Set([80, 8080, 8880, 2052, 2082, 2086, 2095]);
const ALL_CF_PORTS = new Set([...TLS_PORTS, ...NOTLS_PORTS]);

const INFO_NODE_KEYWORDS = [
	'剩余', '过期', '到期', '还剩', '流量', '重置', '官网', '套餐',
	'网址', '失联', '公告', '通知', '续费', '订阅', '客服', '群组',
	'expire', 'remaining', 'expirein', 'traffic', 'reset', 'official'
];

// Cloudflare 官方 IPv4 / IPv6 CIDR
const CF_IPV4_CIDRS = [
	'173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
	'141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
	'197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
	'104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];

const CF_IPV6_CIDRS = [
	'2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
	'2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
];

const KNOWN_CF_DOMAINS = [
	'workers.dev', 'pages.dev', 'cloudflare.com',
	'visa.com', 'visa.cn', 'visa.com.sg', 'visa.com.hk', 'visa.com.tw', 'visa.co.jp',
	'icook.hk', 'icook.tw', 'shopify.com', 'time.is', 'ip.sb', 'skk.moe',
	'cf.090227.xyz', 'cf.877774.xyz', 'bestcf.top', 'bestproxy.onecf.eu.org',
	'cdn.xn--b6gac.eu.org', 'edgetunnel.anycast.eu.org', 'cloudflare.182682.xyz',
	'www.wto.org', 'www.csgo.com', 'www.shopify.com', 'japan.com', 'singapore.com', 'russia.com'
];

// 拉取源 UA 预设：Clash 固定为 clash.meta（实测可拿到真实 mihomo/clash YAML，避免占位节点）
const PULL_UA_PRESETS = {
	clash: 'clash.meta',
	v2rayng: 'v2rayNG/1.9.16',
	v2rayn: 'v2rayN/7.13.5',
	surge: 'Surge iOS/3374',
	shadowrocket: 'Shadowrocket/2.2.55'
};

const RANDOM_UA_POOL = [
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0'
];

// ---------------- 基础工具 ----------------

function stripBom(text) {
	return String(text || '').replace(/^\uFEFF/, '');
}

function safeDecode(text) {
	try {
		return decodeURIComponent(String(text == null ? '' : text));
	} catch {
		return String(text == null ? '' : text);
	}
}

function base64Decode(text) {
	try {
		let clean = stripBom(text).trim().replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
		if (!clean || !/^[A-Za-z0-9+/=]+$/.test(clean)) return null;
		while (clean.length % 4 !== 0) clean += '=';
		const bin = atob(clean);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new TextDecoder('utf-8').decode(bytes);
	} catch {
		return null;
	}
}

function utf8ToBase64(text) {
	const bytes = new TextEncoder().encode(String(text || ''));
	let bin = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}

function randomId() {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function randomKey() {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function resolvePullUA(pullua, clientUA) {
	const v = String(pullua || 'clash').trim();
	const lower = v.toLowerCase();
	if (lower === 'auto') {
		const ua = String(clientUA || '').toLowerCase();
		if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('stash') || ua.includes('meta')) {
			return PULL_UA_PRESETS.clash;
		}
		if (ua.includes('v2rayng') || ua.includes('v2rayn') || ua.includes('xray') || ua.includes('sing-box')) {
			return PULL_UA_PRESETS.v2rayng;
		}
		if (ua.includes('surge')) return PULL_UA_PRESETS.surge;
		if (ua.includes('shadowrocket')) return PULL_UA_PRESETS.shadowrocket;
		return PULL_UA_PRESETS.clash;
	}
	if (lower === 'clash' || lower === 'mihomo' || lower === 'clash.meta') {
		return PULL_UA_PRESETS.clash;
	}
	return PULL_UA_PRESETS[lower] || PULL_UA_PRESETS.clash;
}

function normalizeGitHubRawUrl(rawUrl) {
	const s = String(rawUrl || '').trim();
	const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/(.+)$/i.exec(s);
	if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
	return s;
}

async function fetchRemote(rawUrl, ua, timeoutMs = 10000) {
	const targetUrl = normalizeGitHubRawUrl(rawUrl);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(targetUrl, {
			headers: {
				'User-Agent': ua || PULL_UA_PRESETS.clash,
				'Accept': '*/*'
			},
			redirect: 'follow',
			signal: controller.signal
		});
		if (!res.ok) throw new Error('HTTP ' + res.status);
		return stripBom(await res.text());
	} finally {
		clearTimeout(timer);
	}
}

function isInfoNode(name) {
	const t = String(name || '').toLowerCase();
	if (!t) return false;
	return INFO_NODE_KEYWORDS.some(k => t.includes(k));
}

function subHeaders(extra) {
	return Object.assign({
		'content-type': 'text/plain; charset=utf-8',
		'Profile-Update-Interval': '6',
		'Cache-Control': 'no-store'
	}, extra || {});
}

function jsonResponse(data, status = 200, extraHeaders) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: Object.assign({
			'content-type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store'
		}, extraHeaders || {})
	});
}

// ---------------- ADMIN_PASS 鉴权 ----------------

function parseCookies(header) {
	const out = {};
	for (const part of String(header || '').split(';')) {
		const idx = part.indexOf('=');
		if (idx < 0) continue;
		const k = part.slice(0, idx).trim();
		const v = part.slice(idx + 1).trim();
		if (k) out[k] = safeDecode(v);
	}
	return out;
}

async function signAdminToken(pass) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw', enc.encode(pass), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode('speedsub-admin-v2'));
	return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualStr(a, b) {
	const sa = String(a || '');
	const sb = String(b || '');
	if (sa.length !== sb.length) return false;
	let diff = 0;
	for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
	return diff === 0;
}

function getAdminPass(env) {
	return env && typeof env.ADMIN_PASS === 'string' ? env.ADMIN_PASS.trim() : '';
}

async function isAdminAuthed(request, env) {
	const pass = getAdminPass(env);
	if (!pass) return true;
	const headerPass = (request.headers.get('X-Admin-Pass') || '').trim();
	if (headerPass && timingSafeEqualStr(headerPass, pass)) return true;
	const cookies = parseCookies(request.headers.get('Cookie') || '');
	const token = cookies[ADMIN_COOKIE_NAME] || '';
	if (!token) return false;
	const expected = await signAdminToken(pass);
	return timingSafeEqualStr(token, expected);
}

// ---------------- IP / CIDR / CF 三层识别 ----------------

function parseIPv4ToInt(ip) {
	const parts = String(ip || '').trim().split('.');
	if (parts.length !== 4) return null;
	let n = 0;
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null;
		const v = Number(p);
		if (v < 0 || v > 255) return null;
		n = ((n << 8) | v) >>> 0;
	}
	return n;
}

function parseIPv6ToBigInt(rawIp) {
	let ip = String(rawIp || '').trim().replace(/^\[|\]$/g, '');
	if (!ip.includes(':')) return null;
	const pct = ip.indexOf('%');
	if (pct >= 0) ip = ip.slice(0, pct);
	// IPv4-mapped IPv6 tail
	if (ip.includes('.')) {
		const lastColon = ip.lastIndexOf(':');
		const v4 = parseIPv4ToInt(ip.slice(lastColon + 1));
		if (v4 === null) return null;
		const hi = ((v4 >>> 16) & 0xffff).toString(16);
		const lo = (v4 & 0xffff).toString(16);
		ip = ip.slice(0, lastColon + 1) + hi + ':' + lo;
	}
	const halves = ip.split('::');
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(':') : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
	if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
	const groups = [...left, ...Array(missing).fill('0'), ...right];
	if (groups.length !== 8) return null;
	let val = 0n;
	for (const g of groups) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
		val = (val << 16n) | BigInt(parseInt(g, 16));
	}
	return val;
}

const COMPILED_CF_V4 = CF_IPV4_CIDRS.map(cidr => {
	const [net, bitsStr] = cidr.split('/');
	const bits = Number(bitsStr);
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return { base: (parseIPv4ToInt(net) & mask) >>> 0, mask };
});

const COMPILED_CF_V6 = CF_IPV6_CIDRS.map(cidr => {
	const [net, bitsStr] = cidr.split('/');
	const bits = BigInt(Number(bitsStr));
	const mask = bits === 0n ? 0n : (((1n << bits) - 1n) << (128n - bits));
	return { base: parseIPv6ToBigInt(net) & mask, mask };
});

function isCloudflareIP(ip) {
	const clean = String(ip || '').trim().replace(/^\[|\]$/g, '');
	if (!clean) return false;
	const v4 = parseIPv4ToInt(clean);
	if (v4 !== null) {
		return COMPILED_CF_V4.some(c => ((v4 & c.mask) >>> 0) === c.base);
	}
	const v6 = parseIPv6ToBigInt(clean);
	if (v6 !== null) {
		return COMPILED_CF_V6.some(c => (v6 & c.mask) === c.base);
	}
	return false;
}

function isIPLiteral(host) {
	const clean = String(host || '').trim().replace(/^\[|\]$/g, '');
	return parseIPv4ToInt(clean) !== null || parseIPv6ToBigInt(clean) !== null;
}

function domainMatchesSuffix(host, suffix) {
	const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
	const s = String(suffix || '').trim().toLowerCase();
	return h === s || h.endsWith('.' + s);
}

async function dohQueryCF(domain, cache) {
	const d = String(domain || '').trim().toLowerCase();
	if (!d || isIPLiteral(d)) return isCloudflareIP(d);
	if (cache.has(d)) return cache.get(d);

	const queryType = async (type) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2500);
		try {
			const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=${type}`, {
				headers: { 'Accept': 'application/dns-json' },
				signal: controller.signal
			});
			if (!res.ok) return [];
			const data = await res.json();
			const answers = Array.isArray(data && data.Answer) ? data.Answer : [];
			return answers.filter(a => a && (a.type === 1 || a.type === 28) && a.data).map(a => String(a.data).trim());
		} catch {
			return [];
		} finally {
			clearTimeout(timer);
		}
	};

	const [aList, aaaaList] = await Promise.all([queryType('A'), queryType('AAAA')]);
	const ips = [...aList, ...aaaaList];
	const hit = ips.some(isCloudflareIP);
	cache.set(d, hit);
	return hit;
}

function classifyCFNodeSync(node) {
	if (!node || !node.type) return { status: 'no', reason: 'invalid' };
	if (isInfoNode(node.name)) return { status: 'no', reason: 'info' };
	const type = String(node.type).toLowerCase();
	if (!CF_ELIGIBLE_TYPES.has(type)) return { status: 'no', reason: 'excluded-type' };
	if (node.hasReality) return { status: 'no', reason: 'reality' };

	const server = String(node.server || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
	const port = Number(node.port) || 0;
	const net = String(node.network || 'tcp').toLowerCase();
	const host = String(node.host || '').trim().toLowerCase();
	const sni = String(node.sni || '').trim().toLowerCase();

	// 第 1 层：CF 官方 IPv4 / IPv6 CIDR
	if (isIPLiteral(server)) {
		if (isCloudflareIP(server)) return { status: 'yes', reason: 'cf-cidr' };
		// IP 字面量但不在 CF 段：绝不是 CF 节点
		return { status: 'no', reason: 'non-cf-ip' };
	}

	// 第 2 层：域名或特征命中
	if (domainMatchesSuffix(server, 'workers.dev') || domainMatchesSuffix(server, 'pages.dev') ||
		domainMatchesSuffix(host, 'workers.dev') || domainMatchesSuffix(host, 'pages.dev') ||
		domainMatchesSuffix(sni, 'workers.dev') || domainMatchesSuffix(sni, 'pages.dev')) {
		return { status: 'yes', reason: 'cf-workers-pages' };
	}

	const isCdnTransport = CF_CDN_NETWORKS.has(net);
	const isCfPort = ALL_CF_PORTS.has(port);

	if (isCdnTransport && isCfPort && KNOWN_CF_DOMAINS.some(d => domainMatchesSuffix(server, d))) {
		return { status: 'yes', reason: 'cf-known-domain' };
	}

	const targetDomain = host || sni;
	if (isCdnTransport && isCfPort && targetDomain && server && server !== targetDomain) {
		return { status: 'yes', reason: 'cf-cdn-split-host' };
	}

	// 候选进入第 3 层 DoH（仅限可走 CF CDN 的传输或 13 端口族域名）
	if (server && server.includes('.') && (isCdnTransport || isCfPort)) {
		return { status: 'doh', domain: server };
	}

	return { status: 'no', reason: 'not-cf' };
}

async function detectCFNodes(nodes, dohFn) {
	const resolver = dohFn || dohQueryCF;
	const dohCache = new Map();
	const pendingDomains = new Set();
	const preliminary = nodes.map(node => {
		const res = classifyCFNodeSync(node);
		if (res.status === 'doh' && res.domain) pendingDomains.add(res.domain);
		return res;
	});

	if (pendingDomains.size > 0) {
		await Promise.allSettled(Array.from(pendingDomains).map(d => resolver(d, dohCache)));
	}

	return nodes.map((node, i) => {
		const p = preliminary[i];
		if (p.status === 'yes') return { isCF: true, reason: p.reason };
		if (p.status === 'doh') {
			const hit = !!dohCache.get(p.domain);
			return { isCF: hit, reason: hit ? 'cf-doh' : 'non-cf-doh' };
		}
		return { isCF: false, reason: p.reason };
	});
}

// ---------------- 输入解析：源订阅 & 多合一优选汇聚 ----------------

function extractSources(rawText, legacyLink) {
	const combined = [stripBom(rawText || ''), stripBom(legacyLink || '')].filter(Boolean).join('\n');
	const urls = [];
	const rawNodes = [];
	const seenUrls = new Set();
	const seenNodes = new Set();

	for (const rawLine of combined.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith('//')) continue;

		// 1. 裸代理节点（支持行内带中文注释/空格在 # 后）
		const uriMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/(.+)$/.exec(line);
		if (uriMatch && SUPPORTED_URI_PROTOCOLS.has(uriMatch[1].toLowerCase())) {
			if (!seenNodes.has(line)) {
				seenNodes.add(line);
				rawNodes.push(line);
			}
			continue;
		}

		// 2. 提取行内所有合法 http(s):// 订阅链接（自动忽略周围中文/符号）
		const httpMatches = line.match(/https?:\/\/[^\s"'<>|]+/gi);
		if (httpMatches) {
			for (let u of httpMatches) {
				u = u.replace(/[),;，。！？\]】》]+$/g, '');
				try {
					const parsed = new URL(u);
					if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
						const clean = parsed.toString();
						if (!seenUrls.has(clean)) {
							seenUrls.add(clean);
							urls.push(clean);
						}
					}
				} catch {
					// 忽略非法 URL
				}
			}
		}
	}

	return { urls, rawNodes };
}

function isValidHostname(host) {
	if (!host || host.length > 253) return false;
	if (isIPLiteral(host)) return true;
	if (!host.includes('.')) return false;
	return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(host);
}

function parsePreferredEntry(rawLine) {
	let line = stripBom(rawLine).trim();
	if (!line || line.startsWith('#') || line.startsWith('//')) return null;

	// CloudflareST CSV 兼容：IP,已发送,已接收,丢包率,平均延迟,下载速度...
	if (/^\d{1,3}(\.\d{1,3}){3},/.test(line)) {
		const cols = line.split(',').map(s => s.trim());
		const ip = cols[0];
		if (parseIPv4ToInt(ip) !== null) {
			const speed = cols[5] ? cols[5] + 'MB/s' : '';
			return { host: ip, port: 443, name: speed || (ip + ':443') };
		}
	}

	let name = '';
	const hashIdx = line.indexOf('#');
	if (hashIdx >= 0) {
		name = line.slice(hashIdx + 1).trim();
		line = line.slice(0, hashIdx).trim();
	}
	if (!line) return null;

	let host = '';
	let port = 443; // 省略端口默认 443

	if (line.startsWith('[')) {
		const closeIdx = line.indexOf(']');
		if (closeIdx < 0) return null;
		host = line.slice(1, closeIdx).trim();
		const rest = line.slice(closeIdx + 1).trim();
		if (rest) {
			if (!rest.startsWith(':')) return null;
			const p = parseInt(rest.slice(1), 10);
			if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
			port = p;
		}
	} else {
		const colons = (line.match(/:/g) || []).length;
		const lastColon = line.lastIndexOf(':');
		if (colons === 1) {
			host = line.slice(0, lastColon).trim();
			const pStr = line.slice(lastColon + 1).trim();
			const p = parseInt(pStr, 10);
			if (!/^\d{1,5}$/.test(pStr) || p < 1 || p > 65535) return null;
			port = p;
		} else if (colons >= 8) {
			const pStr = line.slice(lastColon + 1).trim();
			const p = parseInt(pStr, 10);
			if (/^\d{1,5}$/.test(pStr) && p >= 1 && p <= 65535) {
				host = line.slice(0, lastColon).trim();
				port = p;
			} else {
				return null;
			}
		} else {
			host = line;
			port = 443;
		}
	}

	if (!isValidHostname(host)) return null;
	return { host, port, name };
}

function classifyPreferredPools(entries) {
	const tlsPool = [];
	const noTlsPool = [];
	const seen = new Set();

	for (const e of entries) {
		if (!e || !e.host) continue;
		const key = `${e.host.toLowerCase()}:${e.port}`;
		if (seen.has(key)) continue;
		seen.add(key);

		if (TLS_PORTS.has(e.port)) {
			tlsPool.push(e);
		} else if (NOTLS_PORTS.has(e.port)) {
			noTlsPool.push(e);
		}
	}
	return { tlsPool, noTlsPool };
}

// 切分多合一「自定义优选与汇聚」输入
function parseAllInOneRaw(addText, legacyAddApi) {
	const directPreferred = [];
	const remoteUrls = [];
	const directRawNodes = [];
	const seenRemote = new Set();

	const addRemote = (u) => {
		const clean = u.trim();
		if (clean && !seenRemote.has(clean)) {
			seenRemote.add(clean);
			remoteUrls.push(clean);
		}
	};

	if (legacyAddApi) {
		for (const part of stripBom(legacyAddApi).split(/[\r\n,]+/)) {
			const t = part.trim();
			if (/^https?:\/\//i.test(t)) addRemote(t);
		}
	}

	const rawLines = stripBom(addText || '').split(/\r?\n/);
	for (const rawLine of rawLines) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith('//')) continue;

		// 1. 裸代理节点
		const uriMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/(.+)$/.exec(line);
		if (uriMatch) {
			const proto = uriMatch[1].toLowerCase();
			if (SUPPORTED_URI_PROTOCOLS.has(proto)) {
				directRawNodes.push(line);
				continue;
			}
			if (proto === 'sub') {
				addRemote('https://' + uriMatch[2].trim());
				continue;
			}
			if (proto === 'http' || proto === 'https') {
				addRemote(line);
				continue;
			}
		}

		// 2. 兼容旧式逗号拼接的优选列表（例如 ?add=1.2.3.4:443,5.6.7.8:2053）
		const subParts = (!line.includes('://') && line.includes(',') && !/^\d{1,3}(\.\d{1,3}){3},\d+/.test(line))
			? line.split(',')
			: [line];

		for (const p of subParts) {
			const item = p.trim();
			if (!item) continue;
			if (/^https?:\/\//i.test(item)) {
				addRemote(item);
				continue;
			}
			if (/^sub:\/\//i.test(item)) {
				addRemote('https://' + item.slice(6).trim());
				continue;
			}
			const parsed = parsePreferredEntry(item);
			if (parsed) directPreferred.push(parsed);
		}
	}

	return { directPreferred, remoteUrls, directRawNodes };
}

// ---------------- URI 节点解析、改写（仅 IP/端口/名称）与双向转换 ----------------

function findAuthorityEnd(rest) {
	for (let i = 0; i < rest.length; i++) {
		const c = rest[i];
		if (c === '/' || c === '?' || c === '#') return i;
	}
	return rest.length;
}

function splitHostPort(authority) {
	const s = String(authority || '').trim();
	if (s.startsWith('[')) {
		const close = s.indexOf(']');
		const rest = close >= 0 ? s.slice(close + 1) : '';
		return {
			server: close >= 0 ? s.slice(1, close) : s,
			port: rest.startsWith(':') ? (parseInt(rest.slice(1), 10) || 443) : 443
		};
	}
	const colons = (s.match(/:/g) || []).length;
	const idx = s.lastIndexOf(':');
	if (colons === 1 && idx > 0) {
		return { server: s.slice(0, idx), port: parseInt(s.slice(idx + 1), 10) || 443 };
	}
	return { server: s, port: 443 };
}

function parseQueryMap(query) {
	const map = {};
	for (const kv of String(query || '').split('&').filter(Boolean)) {
		const idx = kv.indexOf('=');
		const k = idx < 0 ? kv : kv.slice(0, idx);
		const v = idx < 0 ? '' : kv.slice(idx + 1);
		map[safeDecode(k)] = safeDecode(v);
	}
	return map;
}

function parseShareUri(rawLine) {
	const raw = String(rawLine || '').trim();
	const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/(.+)$/.exec(raw);
	if (!m) return null;
	const proto = m[1].toLowerCase();
	if (!SUPPORTED_URI_PROTOCOLS.has(proto)) return null;

	if (proto === 'vmess') {
		const body = m[2].split('#')[0].trim();
		const decoded = base64Decode(body);
		if (!decoded) return null;
		let j;
		try {
			j = JSON.parse(decoded);
		} catch {
			return null;
		}
		if (!j || typeof j !== 'object' || !j.add) return null;
		const port = parseInt(j.port, 10) || 443;
		const isTls = j.tls === 'tls' || j.tls === true || String(j.tls || '').toLowerCase() === 'true';
		return {
			origin: 'uri',
			rawUri: raw,
			type: 'vmess',
			name: String(j.ps || `${j.add}:${port}`),
			server: String(j.add).trim(),
			port,
			credential: String(j.id || ''),
			network: String(j.net || 'tcp').toLowerCase(),
			isTls,
			sni: String(j.sni || ''),
			host: String(j.host || ''),
			path: String(j.path || ''),
			hasReality: false,
			vmessJson: j
		};
	}

	if (proto === 'ssr') {
		const decoded = base64Decode(m[2].split('#')[0].trim());
		if (!decoded) return null;
		const parts = decoded.split(':');
		if (parts.length < 6) return null;
		let name = `${parts[0]}:${parts[1]}`;
		const qIdx = decoded.indexOf('/?');
		if (qIdx >= 0) {
			const q = parseQueryMap(decoded.slice(qIdx + 2));
			if (q.remarks) name = base64Decode(q.remarks) || name;
		}
		return {
			origin: 'uri',
			rawUri: raw,
			type: 'ssr',
			name,
			server: parts[0],
			port: parseInt(parts[1], 10) || 443,
			credential: parts[5] || '',
			network: 'tcp',
			isTls: false,
			sni: '',
			host: '',
			path: '',
			hasReality: false
		};
	}

	const rest = m[2];
	const authEnd = findAuthorityEnd(rest);
	let authority = rest.slice(0, authEnd);
	let tail = rest.slice(authEnd);

	let fragment = '';
	const hashIdx = tail.indexOf('#');
	if (hashIdx >= 0) {
		fragment = safeDecode(tail.slice(hashIdx + 1));
		tail = tail.slice(0, hashIdx);
	}

	let queryStr = '';
	let urlPath = '';
	const qIdx = tail.indexOf('?');
	if (qIdx >= 0) {
		urlPath = tail.slice(0, qIdx);
		queryStr = tail.slice(qIdx + 1);
	} else {
		urlPath = tail;
	}

	let userinfo = '';
	const atIdx = authority.lastIndexOf('@');
	if (atIdx >= 0) {
		userinfo = authority.slice(0, atIdx);
		authority = authority.slice(atIdx + 1);
	} else if (proto === 'ss') {
		const dec = base64Decode(authority);
		if (dec && dec.includes('@')) {
			const at2 = dec.lastIndexOf('@');
			userinfo = utf8ToBase64(dec.slice(0, at2)).replace(/=+$/, '');
			authority = dec.slice(at2 + 1);
		}
	}

	const hp = splitHostPort(authority);
	const params = parseQueryMap(queryStr);
	const security = String(params.security || '').toLowerCase();
	const hasReality = security === 'reality' || !!params.pbk;
	const normType = proto === 'hy2' ? 'hysteria2' : proto;
	const isTls = normType === 'trojan' || normType === 'hysteria2' || normType === 'hysteria' ||
		normType === 'tuic' || normType === 'anytls' || security === 'tls' || security === 'xtls' || hasReality;
	const network = String(params.type || params.net || 'tcp').toLowerCase();

	return {
		origin: 'uri',
		rawUri: raw,
		type: normType,
		rawProto: proto,
		name: fragment || `${hp.server}:${hp.port}`,
		server: hp.server,
		port: hp.port,
		credential: safeDecode(userinfo),
		network: network === 'websocket' ? 'ws' : network,
		isTls,
		sni: String(params.sni || params.peer || ''),
		host: String(params.host || ''),
		path: String(params.path || params.serviceName || params.servicename || ''),
		hasReality,
		uriParts: { proto, userinfo, urlPath, queryStr, params }
	};
}

// 仅修改 URI 的 IP / 端口 / 名称，绝不触碰 query、TLS、sni、ech 等其他参数
function cloneUriNodeWithAddress(node, newServer, newPort, newName) {
	const targetServer = newServer != null ? newServer : node.server;
	const targetPort = newPort != null ? Number(newPort) : node.port;
	const targetName = newName != null ? newName : node.name;

	if (node.type === 'vmess' && node.vmessJson) {
		const copy = Object.assign({}, node.vmessJson, {
			add: targetServer,
			port: String(targetPort),
			ps: targetName
		});
		const rawUri = 'vmess://' + utf8ToBase64(JSON.stringify(copy));
		return Object.assign({}, node, {
			rawUri,
			server: targetServer,
			port: targetPort,
			name: targetName,
			vmessJson: copy
		});
	}

	if (node.type === 'ssr') {
		const body = node.rawUri.slice('ssr://'.length).split('#')[0].trim();
		const dec = base64Decode(body);
		if (!dec) return Object.assign({}, node, { name: targetName });
		const parts = dec.split(':');
		if (parts.length < 6) return Object.assign({}, node, { name: targetName });
		parts[0] = targetServer;
		parts[1] = String(targetPort);
		let rebuilt = parts.join(':');
		const b64Name = utf8ToBase64(targetName).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		if (/([?&])remarks=[^&]*/.test(rebuilt)) {
			rebuilt = rebuilt.replace(/([?&])remarks=[^&]*/, '$1remarks=' + b64Name);
		} else {
			rebuilt += (rebuilt.includes('/?') ? '&' : '/?') + 'remarks=' + b64Name;
		}
		const rawUri = 'ssr://' + utf8ToBase64(rebuilt).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		return Object.assign({}, node, { rawUri, server: targetServer, port: targetPort, name: targetName });
	}

	// 通用 URI：保持原前缀、userinfo、path、query 完全不变
	const raw = node.rawUri;
	const schemeEnd = raw.indexOf('://');
	const prefix = raw.slice(0, schemeEnd + 3);
	const rest = raw.slice(schemeEnd + 3);
	const authEnd = findAuthorityEnd(rest);
	let authority = rest.slice(0, authEnd);
	let tail = rest.slice(authEnd);

	const hashIdx = tail.indexOf('#');
	if (hashIdx >= 0) tail = tail.slice(0, hashIdx);

	let userinfoPrefix = '';
	const atIdx = authority.lastIndexOf('@');
	if (atIdx >= 0) {
		userinfoPrefix = authority.slice(0, atIdx + 1);
	} else if (node.rawProto === 'ss') {
		const dec = base64Decode(authority);
		if (dec && dec.includes('@')) {
			const at2 = dec.lastIndexOf('@');
			userinfoPrefix = utf8ToBase64(dec.slice(0, at2)).replace(/=+$/, '') + '@';
		}
	}

	const hostPart = targetServer.includes(':') ? `[${targetServer}]` : targetServer;
	const rawUri = `${prefix}${userinfoPrefix}${hostPart}:${targetPort}${tail}#${encodeURIComponent(targetName)}`;
	return Object.assign({}, node, {
		rawUri,
		server: targetServer,
		port: targetPort,
		name: targetName
	});
}

// ---------------- Clash YAML 无损解析与单字段改写 ----------------

function unquoteYamlScalar(val) {
	const s = String(val == null ? '' : val).trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		if (s.startsWith('"')) {
			try { return JSON.parse(s); } catch { return s.slice(1, -1); }
		}
		return s.slice(1, -1).replace(/''/g, "'");
	}
	return s;
}

function yamlScalar(v) {
	if (v === true) return 'true';
	if (v === false) return 'false';
	if (typeof v === 'number') return String(v);
	const s = String(v == null ? '' : v);
	if (s === '') return '""';
	if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return JSON.stringify(s);
	if (/^[+-]?\d+(\.\d+)?$/.test(s)) return JSON.stringify(s);
	if (/^[A-Za-z0-9_./@+\-\u4e00-\u9fa5]+$/.test(s) && !s.startsWith('-')) return s;
	return JSON.stringify(s);
}

// 轻量 YAML flow 映射解析（支持嵌套 {} / [] 与带引号字符串）
function parseFlowMap(text) {
	let s = String(text || '').trim();
	if (s.startsWith('-')) s = s.slice(1).trim();
	if (!s.startsWith('{')) return null;

	let i = 0;
	const len = s.length;
	const skipWs = () => { while (i < len && /[\s]/.test(s[i])) i++; };

	const parseValue = () => {
		skipWs();
		if (i >= len) return '';
		const ch = s[i];
		if (ch === '{') return parseObj();
		if (ch === '[') return parseArr();
		if (ch === '"' || ch === "'") return parseQuoted(ch);
		const start = i;
		while (i < len && !/[,}\]]/.test(s[i])) i++;
		const raw = s.slice(start, i).trim();
		if (raw === 'true') return true;
		if (raw === 'false') return false;
		if (raw === 'null' || raw === '~') return null;
		if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
		return raw;
	};

	const parseQuoted = (q) => {
		i++; // skip opening quote
		let out = '';
		while (i < len) {
			const c = s[i];
			if (q === '"' && c === '\\' && i + 1 < len) {
				out += s[i + 1];
				i += 2;
				continue;
			}
			if (q === "'" && c === "'" && s[i + 1] === "'") {
				out += "'";
				i += 2;
				continue;
			}
			if (c === q) { i++; break; }
			out += c;
			i++;
		}
		return out;
	};

	const parseArr = () => {
		i++; // [
		const arr = [];
		skipWs();
		while (i < len && s[i] !== ']') {
			arr.push(parseValue());
			skipWs();
			if (s[i] === ',') { i++; skipWs(); }
		}
		if (s[i] === ']') i++;
		return arr;
	};

	const parseObj = () => {
		i++; // {
		const obj = {};
		skipWs();
		while (i < len && s[i] !== '}') {
			let key = '';
			if (s[i] === '"' || s[i] === "'") {
				key = parseQuoted(s[i]);
			} else {
				const start = i;
				while (i < len && s[i] !== ':' && s[i] !== '}') i++;
				key = s.slice(start, i).trim();
			}
			skipWs();
			if (s[i] === ':') i++;
			const val = parseValue();
			if (key) obj[key] = val;
			skipWs();
			if (s[i] === ',') { i++; skipWs(); }
		}
		if (s[i] === '}') i++;
		return obj;
	};

	try {
		return parseObj();
	} catch {
		return null;
	}
}

// 解析块式 YAML 代理片段为 JS 对象（仅用于提取字段与 YAML→URI 转换；输出 YAML 时仍优先保留 rawLines）
function parseBlockProxyObj(lines) {
	if (!lines || !lines.length) return {};
	const normalized = lines.map((line, idx) => {
		if (idx === 0) return line.replace(/^(\s*)-\s+/, (_, sp) => sp + '  ');
		return line;
	});

	const root = {};
	const stack = [{ indent: -1, obj: root, keyForList: null }];

	for (let li = 0; li < normalized.length; li++) {
		const rawLine = normalized[li];
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const indent = rawLine.match(/^(\s*)/)[1].length;

		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}
		const parent = stack[stack.length - 1];

		if (trimmed.startsWith('- ')) {
			const valRaw = trimmed.slice(2).trim();
			if (parent.keyForList && Array.isArray(parent.obj[parent.keyForList])) {
				parent.obj[parent.keyForList].push(unquoteYamlScalar(valRaw));
			}
			continue;
		}

		const colon = trimmed.indexOf(':');
		if (colon < 0) continue;
		const key = unquoteYamlScalar(trimmed.slice(0, colon).trim());
		let rest = trimmed.slice(colon + 1).trim();

		// 去掉行尾未加引号的注释
		if (rest && !rest.startsWith('"') && !rest.startsWith("'") && !rest.startsWith('{') && !rest.startsWith('[')) {
			const commentIdx = rest.indexOf(' #');
			if (commentIdx >= 0) rest = rest.slice(0, commentIdx).trim();
		}

		if (rest === '') {
			// 看下一条非空行是数组还是对象
			const nextIdx = li + 1;
			let isArr = false;
			for (let j = nextIdx; j < normalized.length; j++) {
				const nt = normalized[j].trim();
				if (!nt || nt.startsWith('#')) continue;
				if (nt.startsWith('- ')) isArr = true;
				break;
			}
			if (isArr) {
				parent.obj[key] = [];
				stack.push({ indent, obj: parent.obj, keyForList: key });
			} else {
				parent.obj[key] = {};
				stack.push({ indent, obj: parent.obj[key], keyForList: null });
			}
		} else if (rest.startsWith('{') && rest.endsWith('}')) {
			parent.obj[key] = parseFlowMap(rest) || rest;
		} else if (rest.startsWith('[') && rest.endsWith(']')) {
			const inner = rest.slice(1, -1).trim();
			parent.obj[key] = inner ? inner.split(',').map(x => unquoteYamlScalar(x)) : [];
		} else if (rest === 'true') {
			parent.obj[key] = true;
		} else if (rest === 'false') {
			parent.obj[key] = false;
		} else if (/^-?\d+(\.\d+)?$/.test(rest)) {
			parent.obj[key] = Number(rest);
		} else {
			parent.obj[key] = unquoteYamlScalar(rest);
		}
	}

	return root;
}

function buildNodeFromYamlObj(obj, rawLines, isFlow) {
	if (!obj || typeof obj !== 'object') return null;
	const type = String(obj.type || '').toLowerCase();
	if (!type || !obj.server) return null;

	const server = String(obj.server).trim();
	const port = parseInt(obj.port, 10) || 443;
	const name = String(obj.name || `${server}:${port}`);
	const network = String(obj.network || 'tcp').toLowerCase();
	const wsOpts = obj['ws-opts'] || {};
	const grpcOpts = obj['grpc-opts'] || {};
	const xhttpOpts = obj['xhttp-opts'] || {};
	const h2Opts = obj['h2-opts'] || {};
	const wsHeaders = wsOpts.headers || {};

	const host = String(
		wsHeaders.Host || wsHeaders.host ||
		xhttpOpts.host ||
		(Array.isArray(h2Opts.host) ? h2Opts.host[0] : (h2Opts.host || '')) ||
		''
	);
	const path = String(
		wsOpts.path ||
		grpcOpts['grpc-service-name'] ||
		xhttpOpts.path ||
		h2Opts.path ||
		''
	);
	const sni = String(obj.servername || obj.sni || '');
	const hasReality = !!(obj['reality-opts'] && typeof obj['reality-opts'] === 'object');

	let isTls;
	if (type === 'trojan' || type === 'hysteria2' || type === 'hysteria' || type === 'tuic' || type === 'anytls') {
		isTls = true;
	} else if (typeof obj.tls === 'boolean') {
		isTls = obj.tls;
	} else if (typeof obj.tls === 'string') {
		isTls = /^(true|yes|1)$/i.test(obj.tls.trim());
	} else {
		isTls = hasReality || TLS_PORTS.has(port);
	}

	const credential = String(obj.uuid || obj.password || '');

	return {
		origin: 'yaml',
		rawLines: rawLines.slice(),
		isFlow: !!isFlow,
		yamlObj: obj,
		type: type === 'hy2' ? 'hysteria2' : type,
		name,
		server,
		port,
		credential,
		network: network === 'websocket' ? 'ws' : network,
		isTls,
		sni,
		host,
		path,
		hasReality
	};
}

function parseClashYamlNodes(yamlText) {
	const lines = stripBom(yamlText).replace(/\r\n/g, '\n').split('\n');
	const nodes = [];
	let inProxies = false;
	let itemIndent = -1;
	let currentLines = null;

	const flushBlock = () => {
		if (!currentLines || !currentLines.length) return;
		// 去掉末尾空行
		while (currentLines.length && currentLines[currentLines.length - 1].trim() === '') {
			currentLines.pop();
		}
		if (!currentLines.length) return;
		const obj = parseBlockProxyObj(currentLines);
		const node = buildNodeFromYamlObj(obj, currentLines, false);
		if (node) nodes.push(node);
		currentLines = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (!inProxies) {
			if (/^proxies\s*:\s*(#.*)?$/.test(line)) {
				inProxies = true;
				continue;
			}
			continue;
		}

		// 遇到下一个顶层键（无缩进且非注释/空行）→ proxies 段结束
		if (trimmed !== '' && !trimmed.startsWith('#') && !/^\s/.test(line) && !trimmed.startsWith('-')) {
			flushBlock();
			break;
		}

		if (trimmed === '' || trimmed.startsWith('#')) {
			if (currentLines) currentLines.push(line);
			continue;
		}

		const mFlow = /^(\s*)-\s*(\{.*\})\s*(#.*)?$/.exec(line);
		if (mFlow && (itemIndent < 0 || mFlow[1].length <= itemIndent)) {
			flushBlock();
			if (itemIndent < 0) itemIndent = mFlow[1].length;
			const obj = parseFlowMap(mFlow[2]);
			const node = buildNodeFromYamlObj(obj, [line], true);
			if (node) nodes.push(node);
			continue;
		}

		const mBlock = /^(\s*)-\s+(.+)$/.exec(line);
		if (mBlock && (itemIndent < 0 || mBlock[1].length === itemIndent)) {
			flushBlock();
			if (itemIndent < 0) itemIndent = mBlock[1].length;
			currentLines = [line];
			continue;
		}

		if (currentLines) {
			currentLines.push(line);
		}
	}

	flushBlock();
	return nodes;
}

// 在 flow 风格单行 YAML 中精确替换顶层键（只替换 name / server / port，不动其他任何键）
function replaceFlowTopLevelKey(line, key, newVal) {
	const formatted = key === 'port' ? String(Number(newVal)) : yamlScalar(newVal);
	const braceStart = line.indexOf('{');
	if (braceStart < 0) return line;

	let i = braceStart + 1;
	const len = line.length;
	let depth = 0;
	let inQuote = null;

	while (i < len) {
		const ch = line[i];
		if (inQuote) {
			if (inQuote === '"' && ch === '\\') { i += 2; continue; }
			if (ch === inQuote) inQuote = null;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") { inQuote = ch; i++; continue; }
		if (ch === '{' || ch === '[') { depth++; i++; continue; }
		if (ch === '}' || ch === ']') {
			if (depth === 0) break;
			depth--;
			i++;
			continue;
		}

		if (depth === 0) {
			// 尝试在当前位置匹配 key:
			const slice = line.slice(i);
			const keyMatch = new RegExp(`^(\\s*)(?:["']?)${key}(?:["']?)(\\s*:\\s*)`).exec(slice);
			if (keyMatch && (i === braceStart + 1 || /[,{\s]/.test(line[i - 1]))) {
				const valStart = i + keyMatch[0].length;
				let j = valStart;
				let vDepth = 0;
				let vQuote = null;
				while (j < len) {
					const c = line[j];
					if (vQuote) {
						if (vQuote === '"' && c === '\\') { j += 2; continue; }
						if (c === vQuote) vQuote = null;
						j++;
						continue;
					}
					if (c === '"' || c === "'") { vQuote = c; j++; continue; }
					if (c === '{' || c === '[') { vDepth++; j++; continue; }
					if (c === '}' || c === ']') {
						if (vDepth === 0) break;
						vDepth--;
						j++;
						continue;
					}
					if (c === ',' && vDepth === 0) break;
					j++;
				}
				return line.slice(0, valStart) + formatted + line.slice(j);
			}
		}
		i++;
	}
	return line;
}

// 在块式 YAML 中精确替换顶层字段（缩进最浅的 key:）
function replaceBlockTopLevelKey(lines, key, newVal) {
	const formatted = key === 'port' ? String(Number(newVal)) : yamlScalar(newVal);
	const out = lines.slice();
	// 节点第一行形如 "  - name: xxx"，后续顶层属性缩进应为 firstIndent + 2
	const firstIndent = (out[0].match(/^(\s*)/) || ['', ''])[1].length;
	const propIndent = firstIndent + 2;

	for (let i = 0; i < out.length; i++) {
		const line = out[i];
		if (i === 0) {
			const m0 = new RegExp(`^(\\s*-\\s+${key}\\s*:\\s*)(.*)$`).exec(line);
			if (m0) {
				out[i] = m0[1] + formatted;
				return out;
			}
		} else {
			const m = new RegExp(`^(\\s{${propIndent}}${key}\\s*:\\s*)(.*)$`).exec(line);
			if (m) {
				out[i] = m[1] + formatted;
				return out;
			}
		}
	}
	return out;
}

// 仅修改 YAML 节点的 server / port / name，绝不触碰 tls、servername、ech-opts、ws-opts 等其他字段
function cloneYamlNodeWithAddress(node, newServer, newPort, newName) {
	const targetServer = newServer != null ? newServer : node.server;
	const targetPort = newPort != null ? Number(newPort) : node.port;
	const targetName = newName != null ? newName : node.name;

	let rawLines = node.rawLines.slice();
	if (node.isFlow) {
		let line = rawLines[0];
		if (targetName !== node.name) line = replaceFlowTopLevelKey(line, 'name', targetName);
		if (targetServer !== node.server) line = replaceFlowTopLevelKey(line, 'server', targetServer);
		if (targetPort !== node.port) line = replaceFlowTopLevelKey(line, 'port', targetPort);
		rawLines = [line];
	} else {
		if (targetName !== node.name) rawLines = replaceBlockTopLevelKey(rawLines, 'name', targetName);
		if (targetServer !== node.server) rawLines = replaceBlockTopLevelKey(rawLines, 'server', targetServer);
		if (targetPort !== node.port) rawLines = replaceBlockTopLevelKey(rawLines, 'port', targetPort);
	}

	const yamlObj = Object.assign({}, node.yamlObj, {
		name: targetName,
		server: targetServer,
		port: targetPort
	});

	return Object.assign({}, node, {
		rawLines,
		yamlObj,
		name: targetName,
		server: targetServer,
		port: targetPort
	});
}

function cloneNodeWithAddress(node, newServer, newPort, newName) {
	if (node.origin === 'yaml') {
		return cloneYamlNodeWithAddress(node, newServer, newPort, newName);
	}
	return cloneUriNodeWithAddress(node, newServer, newPort, newName);
}

// ---------------- 双向格式转换：URI ↔ Clash ----------------

function yamlBlockFromObj(obj, indent = 0) {
	const pad = ' '.repeat(indent);
	let out = '';
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			if (!v.length) continue;
			out += `${pad}${k}:\n`;
			for (const item of v) {
				out += `${pad}  - ${yamlScalar(item)}\n`;
			}
		} else if (typeof v === 'object') {
			const nested = yamlBlockFromObj(v, indent + 2);
			if (nested) out += `${pad}${k}:\n${nested}`;
		} else {
			out += `${pad}${k}: ${yamlScalar(v)}\n`;
		}
	}
	return out;
}

function proxyObjToYamlLines(proxyObj) {
	const lines = yamlBlockFromObj(proxyObj, 0).replace(/\n$/, '').split('\n');
	return lines.map((l, i) => (i === 0 ? '  - ' + l : '    ' + l));
}

function uriNodeToClashObj(node, addRandomUA = false) {
	if (node.origin === 'yaml') return node.yamlObj;
	const randUA = () => RANDOM_UA_POOL[Math.floor(Math.random() * RANDOM_UA_POOL.length)];

	if (node.type === 'vmess' && node.vmessJson) {
		const j = node.vmessJson;
		const proxy = {
			name: node.name,
			type: 'vmess',
			server: node.server,
			port: node.port,
			uuid: j.id,
			alterId: Number(j.aid) || 0,
			cipher: j.scy || 'auto'
		};
		const net = String(j.net || 'tcp').toLowerCase();
		if (net === 'ws' || net === 'websocket') {
			proxy.network = 'ws';
			proxy['ws-opts'] = { path: j.path || '/' };
			const headers = {};
			if (j.host) headers.Host = j.host;
			if (addRandomUA) headers['User-Agent'] = randUA();
			if (Object.keys(headers).length) proxy['ws-opts'].headers = headers;
		} else if (net === 'grpc') {
			proxy.network = 'grpc';
			proxy['grpc-opts'] = { 'grpc-service-name': j.path || '' };
		} else if (net === 'h2') {
			proxy.network = 'h2';
			proxy['h2-opts'] = { path: j.path || '/', host: [j.host || node.server] };
		} else if (net === 'xhttp' || net === 'splithttp') {
			proxy.network = 'xhttp';
			proxy['xhttp-opts'] = { path: j.path || '/' };
			if (j.host) proxy['xhttp-opts'].host = j.host;
		} else {
			proxy.network = 'tcp';
		}
		if (node.isTls) {
			proxy.tls = true;
			if (j.sni || j.host) proxy.servername = j.sni || j.host;
			if (j.alpn) proxy.alpn = String(j.alpn).split(',').map(s => s.trim()).filter(Boolean);
			if (j.fp) proxy['client-fingerprint'] = j.fp;
		} else {
			proxy.tls = false;
		}
		return proxy;
	}

	if (!node.uriParts) return null;
	const p = node.uriParts.params || {};
	const security = String(p.security || '').toLowerCase();
	const type = node.type;
	const proxy = { name: node.name, server: node.server, port: node.port };

	const applyTransport = () => {
		const net = node.network || 'tcp';
		if (net === 'ws') {
			proxy.network = 'ws';
			proxy['ws-opts'] = { path: p.path || '/' };
			const headers = {};
			if (p.host) headers.Host = p.host;
			if (addRandomUA) headers['User-Agent'] = randUA();
			if (Object.keys(headers).length) proxy['ws-opts'].headers = headers;
		} else if (net === 'grpc') {
			proxy.network = 'grpc';
			proxy['grpc-opts'] = { 'grpc-service-name': p.serviceName || p.servicename || p.path || '' };
		} else if (net === 'h2' || net === 'http') {
			proxy.network = 'h2';
			proxy['h2-opts'] = { path: p.path || '/', host: [p.host || node.server] };
		} else if (net === 'xhttp' || net === 'splithttp') {
			proxy.network = 'xhttp';
			proxy['xhttp-opts'] = { path: p.path || '/' };
			if (p.host) proxy['xhttp-opts'].host = p.host;
			if (p.mode) proxy['xhttp-opts'].mode = p.mode;
		} else {
			proxy.network = 'tcp';
		}
	};

	if (type === 'vless' || type === 'trojan') {
		proxy.type = type;
		if (type === 'vless') proxy.uuid = node.credential;
		else proxy.password = node.credential;
		applyTransport();
		if (security === 'reality' || p.pbk) {
			proxy.tls = true;
			proxy['reality-opts'] = { 'public-key': p.pbk || '' };
			if (p.sid) proxy['reality-opts']['short-id'] = p.sid;
			if (p.sni) proxy.servername = p.sni;
			if (p.fp) proxy['client-fingerprint'] = p.fp;
		} else if (type === 'trojan' || security === 'tls') {
			proxy.tls = true;
			const sni = p.sni || p.peer || p.host;
			if (sni) proxy.servername = sni;
			if (p.alpn) proxy.alpn = p.alpn.split(',').map(s => s.trim()).filter(Boolean);
			if (p.fp) proxy['client-fingerprint'] = p.fp;
			if (p.allowInsecure === '1' || p.allowInsecure === 'true' || p.insecure === '1') {
				proxy['skip-cert-verify'] = true;
			}
		} else {
			proxy.tls = false;
		}
		if (type === 'vless' && p.flow) proxy.flow = p.flow;
		return proxy;
	}

	if (type === 'ss') {
		const cred = base64Decode(node.uriParts.userinfo) || node.credential;
		const colon = cred.indexOf(':');
		proxy.type = 'ss';
		proxy.cipher = colon < 0 ? cred : cred.slice(0, colon);
		proxy.password = colon < 0 ? '' : cred.slice(colon + 1);
		if (p.plugin) proxy.plugin = p.plugin;
		return proxy;
	}

	if (type === 'hysteria2') {
		proxy.type = 'hysteria2';
		proxy.password = node.credential;
		if (p.sni) proxy.sni = p.sni;
		if (p.insecure === '1' || p.allowInsecure === '1') proxy['skip-cert-verify'] = true;
		if (p.obfs) proxy.obfs = p.obfs;
		if (p['obfs-password']) proxy['obfs-password'] = p['obfs-password'];
		if (p.mport || p.ports) proxy.ports = p.mport || p.ports;
		return proxy;
	}

	if (type === 'tuic') {
		const colon = node.credential.indexOf(':');
		proxy.type = 'tuic';
		proxy.uuid = colon < 0 ? node.credential : node.credential.slice(0, colon);
		proxy.password = colon < 0 ? '' : node.credential.slice(colon + 1);
		if (p.sni) proxy.sni = p.sni;
		if (p.alpn) proxy.alpn = p.alpn.split(',').map(s => s.trim()).filter(Boolean);
		if (p.congestion_control) proxy['congestion-controller'] = p.congestion_control;
		if (p.udp_relay_mode) proxy['udp-relay-mode'] = p.udp_relay_mode;
		if (p.allow_insecure === '1' || p.allowInsecure === '1') proxy['skip-cert-verify'] = true;
		return proxy;
	}

	if (type === 'anytls') {
		proxy.type = 'anytls';
		proxy.password = node.credential;
		if (p.sni) proxy.sni = p.sni;
		if (p.alpn) proxy.alpn = p.alpn.split(',').map(s => s.trim()).filter(Boolean);
		if (p.fp) proxy['client-fingerprint'] = p.fp;
		if (p.insecure === '1' || p.allowInsecure === '1') proxy['skip-cert-verify'] = true;
		return proxy;
	}

	return null;
}

// Clash YAML 节点 → 标准分享 URI（覆盖 vless / vmess / trojan / ss / hysteria2 / tuic / anytls）
function clashNodeToShareUri(node) {
	if (node.origin === 'uri') return node.rawUri;
	const o = node.yamlObj || {};
	const type = String(node.type || o.type || '').toLowerCase();
	const server = String(node.server || o.server || '');
	const port = Number(node.port || o.port || 443);
	const hostPart = server.includes(':') ? `[${server}]` : server;
	const name = String(node.name || o.name || `${server}:${port}`);
	const frag = '#' + encodeURIComponent(name);

	const buildQuery = (pairs) => {
		const list = pairs.filter(([, v]) => v !== undefined && v !== null && v !== '');
		return list.length ? '?' + list.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
	};

	if (type === 'vmess') {
		const wsOpts = o['ws-opts'] || {};
		const grpcOpts = o['grpc-opts'] || {};
		const h2Opts = o['h2-opts'] || {};
		const xhttpOpts = o['xhttp-opts'] || {};
		const wsHeaders = wsOpts.headers || {};
		const net = String(o.network || 'tcp').toLowerCase();
		const host = wsHeaders.Host || wsHeaders.host || xhttpOpts.host || (Array.isArray(h2Opts.host) ? h2Opts.host[0] : h2Opts.host) || '';
		const path = wsOpts.path || grpcOpts['grpc-service-name'] || xhttpOpts.path || h2Opts.path || '';
		const payload = {
			v: '2',
			ps: name,
			add: server,
			port: String(port),
			id: String(o.uuid || ''),
			aid: String(o.alterId || 0),
			scy: String(o.cipher || 'auto'),
			net,
			type: 'none',
			host: String(host),
			path: String(path),
			tls: node.isTls ? 'tls' : ''
		};
		if (o.servername || o.sni) payload.sni = String(o.servername || o.sni);
		if (Array.isArray(o.alpn) && o.alpn.length) payload.alpn = o.alpn.join(',');
		if (o['client-fingerprint']) payload.fp = String(o['client-fingerprint']);
		return 'vmess://' + utf8ToBase64(JSON.stringify(payload));
	}

	if (type === 'vless' || type === 'trojan') {
		const cred = encodeURIComponent(String(type === 'vless' ? (o.uuid || '') : (o.password || '')));
		const net = String(o.network || 'tcp').toLowerCase();
		const wsOpts = o['ws-opts'] || {};
		const grpcOpts = o['grpc-opts'] || {};
		const xhttpOpts = o['xhttp-opts'] || {};
		const h2Opts = o['h2-opts'] || {};
		const wsHeaders = wsOpts.headers || {};
		const reality = o['reality-opts'] || null;

		const q = [];
		if (type === 'vless') q.push(['encryption', o.encryption || 'none']);
		if (o.flow) q.push(['flow', o.flow]);

		if (reality && typeof reality === 'object') {
			q.push(['security', 'reality']);
			if (reality['public-key']) q.push(['pbk', reality['public-key']]);
			if (reality['short-id']) q.push(['sid', reality['short-id']]);
		} else if (node.isTls) {
			q.push(['security', 'tls']);
		} else {
			q.push(['security', 'none']);
		}

		if (o.servername || o.sni) q.push(['sni', o.servername || o.sni]);
		if (o['client-fingerprint']) q.push(['fp', o['client-fingerprint']]);
		if (Array.isArray(o.alpn) && o.alpn.length) q.push(['alpn', o.alpn.join(',')]);
		if (o['skip-cert-verify'] === true) q.push(['allowInsecure', '1']);

		q.push(['type', net]);
		if (net === 'ws') {
			if (wsOpts.path) q.push(['path', wsOpts.path]);
			if (wsHeaders.Host || wsHeaders.host) q.push(['host', wsHeaders.Host || wsHeaders.host]);
		} else if (net === 'grpc') {
			if (grpcOpts['grpc-service-name']) q.push(['serviceName', grpcOpts['grpc-service-name']]);
		} else if (net === 'xhttp' || net === 'splithttp') {
			if (xhttpOpts.path) q.push(['path', xhttpOpts.path]);
			if (xhttpOpts.host) q.push(['host', xhttpOpts.host]);
			if (xhttpOpts.mode) q.push(['mode', xhttpOpts.mode]);
		} else if (net === 'h2') {
			if (h2Opts.path) q.push(['path', h2Opts.path]);
			const h = Array.isArray(h2Opts.host) ? h2Opts.host[0] : h2Opts.host;
			if (h) q.push(['host', h]);
		}

		return `${type}://${cred}@${hostPart}:${port}${buildQuery(q)}${frag}`;
	}

	if (type === 'ss') {
		const userinfo = utf8ToBase64(`${o.cipher || 'aes-256-gcm'}:${o.password || ''}`).replace(/=+$/, '');
		const q = [];
		if (o.plugin) q.push(['plugin', o.plugin]);
		return `ss://${userinfo}@${hostPart}:${port}${buildQuery(q)}${frag}`;
	}

	if (type === 'hysteria2' || type === 'hy2') {
		const q = [];
		if (o.sni || o.servername) q.push(['sni', o.sni || o.servername]);
		if (o['skip-cert-verify'] === true) q.push(['insecure', '1']);
		if (o.obfs) q.push(['obfs', o.obfs]);
		if (o['obfs-password']) q.push(['obfs-password', o['obfs-password']]);
		if (o.ports) q.push(['mport', o.ports]);
		return `hysteria2://${encodeURIComponent(String(o.password || ''))}@${hostPart}:${port}${buildQuery(q)}${frag}`;
	}

	if (type === 'tuic') {
		const q = [];
		if (o.sni || o.servername) q.push(['sni', o.sni || o.servername]);
		if (Array.isArray(o.alpn) && o.alpn.length) q.push(['alpn', o.alpn.join(',')]);
		if (o['congestion-controller']) q.push(['congestion_control', o['congestion-controller']]);
		if (o['udp-relay-mode']) q.push(['udp_relay_mode', o['udp-relay-mode']]);
		if (o['skip-cert-verify'] === true) q.push(['allow_insecure', '1']);
		const cred = `${encodeURIComponent(String(o.uuid || ''))}:${encodeURIComponent(String(o.password || ''))}`;
		return `tuic://${cred}@${hostPart}:${port}${buildQuery(q)}${frag}`;
	}

	if (type === 'anytls') {
		const q = [];
		if (o.sni || o.servername) q.push(['sni', o.sni || o.servername]);
		if (Array.isArray(o.alpn) && o.alpn.length) q.push(['alpn', o.alpn.join(',')]);
		if (o['client-fingerprint']) q.push(['fp', o['client-fingerprint']]);
		if (o['skip-cert-verify'] === true) q.push(['insecure', '1']);
		return `anytls://${encodeURIComponent(String(o.password || ''))}@${hostPart}:${port}${buildQuery(q)}${frag}`;
	}

	return null;
}

// ---------------- 订阅内容识别与归一 ----------------

function looksLikeUriList(text) {
	const lines = stripBom(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
	if (!lines.length) return false;
	const hit = lines.filter(l => {
		const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//.exec(l);
		return m && SUPPORTED_URI_PROTOCOLS.has(m[1].toLowerCase());
	}).length;
	return hit > 0 && hit >= Math.min(lines.length, 1);
}

function parseSubscriptionContent(rawText) {
	const text = stripBom(rawText).trim();
	if (!text) return { format: 'empty', nodes: [], rawYaml: '' };

	// 1. Clash YAML
	if (/^proxies\s*:/m.test(text)) {
		const nodes = parseClashYamlNodes(text);
		if (nodes.length > 0) {
			return { format: 'yaml', nodes, rawYaml: text };
		}
	}

	// 2. 明文 URI 列表
	if (looksLikeUriList(text)) {
		const nodes = text.split(/\r?\n/).map(parseShareUri).filter(Boolean);
		if (nodes.length > 0) return { format: 'plain', nodes, rawYaml: '' };
	}

	// 3. Base64 URI 列表
	const decoded = base64Decode(text);
	if (decoded && looksLikeUriList(decoded)) {
		const nodes = decoded.split(/\r?\n/).map(parseShareUri).filter(Boolean);
		if (nodes.length > 0) return { format: 'base64', nodes, rawYaml: '' };
	}

	return { format: 'unknown', nodes: [], rawYaml: '' };
}

// ---------------- Clash 配置组装 ----------------

const DEFAULT_CLASH_TEMPLATE = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090
dns:
  enable: true
  ipv6: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
proxies:
proxy-groups:
  - name: 🚀 节点选择
    type: select
    proxies:
      - ⚡ 自动选择
__CF_GROUP_REF__      - DIRECT
__ALL_PROXIES__
  - name: ⚡ 自动选择
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    proxies:
__ALL_PROXIES__
__CF_GROUP_BLOCK__rules:
  - GEOIP,LAN,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,🚀 节点选择
`;

function replaceTopYamlSection(text, key, newSection) {
	const lines = stripBom(text).replace(/\r\n/g, '\n').split('\n');
	const keyRe = new RegExp(`^${key}\\s*:`);
	let start = -1;
	let end = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (keyRe.test(lines[i])) { start = i; break; }
	}
	if (start < 0) return text.replace(/\s*$/, '\n') + newSection + '\n';
	for (let i = start + 1; i < lines.length; i++) {
		const t = lines[i].trim();
		if (t === '' || t.startsWith('#')) continue;
		if (!/^\s/.test(lines[i])) { end = i; break; }
	}
	return [...lines.slice(0, start), ...newSection.split('\n'), ...lines.slice(end)].join('\n');
}

function buildClashOutput(finalNodes, options) {
	const {
		headerComments = [],
		templateText = '',
		addRandomUA = false
	} = options || {};

	const proxyYamlBlocks = [];
	const allNames = [];
	const cfNames = [];
	const skipped = [];

	for (const node of finalNodes) {
		if (node.origin === 'yaml') {
			proxyYamlBlocks.push(node.rawLines.join('\n'));
			allNames.push(node.name);
			if (node._isAppendedCF) cfNames.push(node.name);
		} else {
			const obj = uriNodeToClashObj(node, addRandomUA);
			if (obj) {
				proxyYamlBlocks.push(proxyObjToYamlLines(obj).join('\n'));
				allNames.push(obj.name);
				if (node._isAppendedCF) cfNames.push(obj.name);
			} else {
				skipped.push(node.name);
			}
		}
	}

	const topCommentLines = headerComments.map(c => `# ${c}`);
	if (skipped.length) {
		topCommentLines.push(`# 以下节点暂不支持导出为 Clash：${skipped.slice(0, 10).join(' / ')}`);
	}
	const commentHeader = topCommentLines.length ? topCommentLines.join('\n') + '\n' : '';
	const proxiesSection = 'proxies:\n' + proxyYamlBlocks.join('\n');
	const allNamesYaml = allNames.map(n => `      - ${yamlScalar(n)}`).join('\n');

	if (templateText && templateText.trim()) {
		let out = replaceTopYamlSection(templateText, 'proxies', proxiesSection);
		out = out.replaceAll('__PROXIES_NAMES__', allNamesYaml).replaceAll('__ALL_PROXIES__', allNamesYaml);
		return commentHeader + out;
	}

	const cfGroupRef = cfNames.length ? '      - ☁️ CF优选\n' : '';
	const cfGroupBlock = cfNames.length
		? `  - name: ☁️ CF优选\n    type: url-test\n    url: http://www.gstatic.com/generate_204\n    interval: 300\n    tolerance: 50\n    proxies:\n${cfNames.map(n => `      - ${yamlScalar(n)}`).join('\n')}\n`
		: '';

	let out = DEFAULT_CLASH_TEMPLATE;
	out = replaceTopYamlSection(out, 'proxies', proxiesSection);
	out = out
		.replaceAll('__CF_GROUP_REF__', cfGroupRef)
		.replaceAll('__CF_GROUP_BLOCK__', cfGroupBlock)
		.replaceAll('__ALL_PROXIES__', allNamesYaml);

	return commentHeader + out;
}

// ---------------- 核心流水线：多源聚合 + CF 识别 + 去重基准 + 严对口 Append ----------------

function landingFingerprint(node) {
	return [
		String(node.type || '').toLowerCase(),
		String(node.credential || ''),
		String(node.network || 'tcp').toLowerCase(),
		node.isTls ? 'tls' : 'notls',
		String(node.sni || '').trim().toLowerCase(),
		String(node.host || '').trim().toLowerCase(),
		String(node.path || '').trim()
	].join('|');
}

function deduplicateNodeNames(nodes) {
	const counts = new Map();
	return nodes.map(node => {
		const base = String(node.name || `${node.server}:${node.port}`).trim() || 'node';
		const prev = counts.get(base) || 0;
		counts.set(base, prev + 1);
		if (prev === 0) return node;
		let seq = prev + 1;
		let candidate = `${base}-${seq}`;
		while (counts.has(candidate)) {
			seq++;
			candidate = `${base}-${seq}`;
		}
		counts.set(candidate, 1);
		const renamed = cloneNodeWithAddress(node, node.server, node.port, candidate);
		if (node._isAppendedCF) renamed._isAppendedCF = true;
		if (node._isAggregatedExtra) renamed._isAggregatedExtra = true;
		return renamed;
	});
}

async function runSpeedSubPipeline(config, clientUA, rawClientUA, deps = {}) {
	const fetcher = deps.fetchRemote || fetchRemote;
	const dohResolver = deps.dohQueryCF || dohQueryCF;

	const pullUA = resolvePullUA(config.pullua || 'clash', rawClientUA || clientUA);
	const requestedFormat = String(config.format || 'clash').trim().toLowerCase();
	const { urls: sourceUrls, rawNodes: inlineSourceNodes } = extractSources(config.url || '', config.link || '');
	const allInOne = parseAllInOneRaw(config.add || '', config.addapi || '');

	if (!sourceUrls.length && !inlineSourceNodes.length && !allInOne.remoteUrls.length && !allInOne.directRawNodes.length) {
		return {
			ok: false,
			status: 400,
			error: '缺少源订阅：请至少填写一个源订阅链接或代理节点'
		};
	}

	// 1. 并发拉取所有源订阅（单源失败跳过）
	const sourceFetches = await Promise.allSettled(
		sourceUrls.map(u => fetcher(u, pullUA, 10000).then(text => ({ url: u, text })))
	);

	let sourcesOk = 0;
	const sourcesTotal = sourceUrls.length + (inlineSourceNodes.length ? 1 : 0);
	const sourceErrors = [];
	const inputNodes = [];
	const detectedSourceFormats = [];

	for (let i = 0; i < sourceFetches.length; i++) {
		const r = sourceFetches[i];
		if (r.status === 'fulfilled') {
			const parsed = parseSubscriptionContent(r.value.text);
			if (parsed.nodes.length > 0) {
				sourcesOk++;
				detectedSourceFormats.push(parsed.format);
				inputNodes.push(...parsed.nodes);
			} else {
				sourceErrors.push({ url: sourceUrls[i], error: '未解析到有效节点' });
			}
		} else {
			sourceErrors.push({ url: sourceUrls[i], error: r.reason ? String(r.reason.message || r.reason) : '拉取失败' });
		}
	}

	if (inlineSourceNodes.length) {
		const parsedInline = inlineSourceNodes.map(parseShareUri).filter(Boolean);
		if (parsedInline.length) {
			sourcesOk++;
			detectedSourceFormats.push('plain');
			inputNodes.push(...parsedInline);
		}
	}

	// 2. 并发拉取多合一输入框内的远程地址（优选 IP API / sub:// / 汇聚订阅）
	const preferredEntries = allInOne.directPreferred.slice();
	const extraAggregateNodes = allInOne.directRawNodes.map(parseShareUri).filter(Boolean).map(n => {
		n._isAggregatedExtra = true;
		return n;
	});

	if (allInOne.remoteUrls.length) {
		const extraFetches = await Promise.allSettled(
			allInOne.remoteUrls.map(u => fetcher(u, pullUA, 10000).then(text => ({ url: u, text })))
		);
		for (let i = 0; i < extraFetches.length; i++) {
			const r = extraFetches[i];
			if (r.status !== 'fulfilled') {
				sourceErrors.push({ url: allInOne.remoteUrls[i], error: '优选/汇聚地址拉取失败：' + (r.reason ? (r.reason.message || r.reason) : '未知错误') });
				continue;
			}
			const text = r.value.text;
			// 先判断是否是订阅（Clash YAML / Base64 / 明文节点列表）
			const asSub = parseSubscriptionContent(text);
			if (asSub.nodes.length > 0) {
				for (const n of asSub.nodes) {
					n._isAggregatedExtra = true;
					extraAggregateNodes.push(n);
				}
				continue;
			}
			// 否则按优选 IP / 域名条目解析
			for (const line of stripBom(text).split(/\r?\n/)) {
				const entry = parsePreferredEntry(line);
				if (entry) preferredEntries.push(entry);
			}
		}
	}

	// 兼容旧版 ?num=N 参数
	const limitNum = parseInt(config.num, 10);
	const effectivePreferred = limitNum > 0 ? preferredEntries.slice(0, limitNum) : preferredEntries;
	const { tlsPool, noTlsPool } = classifyPreferredPools(effectivePreferred);

	if (!inputNodes.length && !extraAggregateNodes.length) {
		const errDetail = sourceErrors.length ? '（' + sourceErrors.map(e => `${e.url}: ${e.error}`).join('; ') + '）' : '';
		return {
			ok: false,
			status: 502,
			error: '未获取到任何可用节点' + errDetail,
			sourceErrors
		};
	}

	const warnings = [];
	const hasPreferredPool = tlsPool.length > 0 || noTlsPool.length > 0;
	const mode = hasPreferredPool ? 'cf-optimize' : 'pure-aggregate';

	let keptOriginalNodes = [];
	let appendedCfNodes = [];
	let cfTlsLandings = 0;
	let cfNoTlsLandings = 0;
	let cfTlsNodeCount = 0;
	let cfNoTlsNodeCount = 0;

	if (mode === 'pure-aggregate') {
		// 纯汇总转换模式：不精简、不改写、不弹缺类型警告
		keptOriginalNodes = inputNodes.slice();
	} else {
		// CF 优选模式：三层精准识别 CF 节点
		const cfFlags = await detectCFNodes(inputNodes, dohResolver);
		const seenLandingKeys = new Set();
		const tlsBaselines = [];
		const noTlsBaselines = [];

		for (let i = 0; i < inputNodes.length; i++) {
			const node = inputNodes[i];
			const flag = cfFlags[i];
			if (!flag.isCF) {
				// 非 CF 节点全部原样保留
				keptOriginalNodes.push(node);
				continue;
			}
			if (node.isTls) cfTlsNodeCount++;
			else cfNoTlsNodeCount++;

			const fp = landingFingerprint(node);
			if (!seenLandingKeys.has(fp)) {
				// 每个独立 CF 落地只保留 1 条基准原节点
				seenLandingKeys.add(fp);
				keptOriginalNodes.push(node);
				if (node.isTls) {
					cfTlsLandings++;
					tlsBaselines.push(node);
				} else {
					cfNoTlsLandings++;
					noTlsBaselines.push(node);
				}
			}
		}

		// 严格对口配对 TLS 池与非 TLS 池，绝不跨类型错配，绝不修改 TLS 开关
		if (tlsBaselines.length > 0 && tlsPool.length > 0) {
			const count = Math.max(tlsPool.length, tlsBaselines.length);
			for (let i = 0; i < count; i++) {
				const tpl = tlsBaselines[i % tlsBaselines.length];
				const entry = tlsPool[i % tlsPool.length];
				const tag = entry.name || `${entry.host}:${entry.port}`;
				const newName = `[CF优选] ${tpl.name} · ${tag}`;
				const cloned = cloneNodeWithAddress(tpl, entry.host, entry.port, newName);
				cloned._isAppendedCF = true;
				appendedCfNodes.push(cloned);
			}
		} else if (tlsBaselines.length > 0 && tlsPool.length === 0) {
			warnings.push(`检测到 ${tlsBaselines.length} 个 TLS CF 落地（原 ${cfTlsNodeCount} 条节点），但未提供 TLS 优选 IP（443/2053/2083/2087/2096/8443），已原样保留 TLS 原节点`);
		}

		if (noTlsBaselines.length > 0 && noTlsPool.length > 0) {
			const count = Math.max(noTlsPool.length, noTlsBaselines.length);
			for (let i = 0; i < count; i++) {
				const tpl = noTlsBaselines[i % noTlsBaselines.length];
				const entry = noTlsPool[i % noTlsPool.length];
				const tag = entry.name || `${entry.host}:${entry.port}`;
				const newName = `[CF优选] ${tpl.name} · ${tag}`;
				const cloned = cloneNodeWithAddress(tpl, entry.host, entry.port, newName);
				cloned._isAppendedCF = true;
				appendedCfNodes.push(cloned);
			}
		} else if (noTlsBaselines.length > 0 && noTlsPool.length === 0) {
			warnings.push(`检测到 ${noTlsBaselines.length} 个非 TLS CF 落地（原 ${cfNoTlsNodeCount} 条节点），但未提供非 TLS 优选 IP（80/8080/8880/2052/2082/2086/2095），已原样保留非 TLS 原节点`);
		}
	}

	const combinedNodes = [...keptOriginalNodes, ...appendedCfNodes, ...extraAggregateNodes];
	const finalNodes = deduplicateNodeNames(combinedNodes);

	// 决定输出格式
	let outputFormat = requestedFormat;
	if (!['clash', 'base64', 'plain', 'auto'].includes(outputFormat)) outputFormat = 'clash';
	if (outputFormat === 'auto') {
		const ua = String(clientUA || '').toLowerCase();
		if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('stash') || ua.includes('meta')) {
			outputFormat = 'clash';
		} else if (detectedSourceFormats.length && detectedSourceFormats.every(f => f === 'yaml')) {
			outputFormat = 'clash';
		} else if (detectedSourceFormats.length && detectedSourceFormats.every(f => f === 'plain')) {
			outputFormat = 'plain';
		} else {
			outputFormat = 'base64';
		}
	}

	const sourcesSummary = `${sourcesOk}/${sourcesTotal}`;
	const headerComments = [
		`SpeedSub | 模式: ${mode === 'cf-optimize' ? 'CF优选' : '纯汇总'} | 源成功: ${sourcesSummary} | 输出节点: ${finalNodes.length}`
	];
	if (mode === 'cf-optimize') {
		headerComments.push(`SpeedSub | 独立CF落地: ${cfTlsLandings + cfNoTlsLandings} (TLS:${cfTlsLandings} / 非TLS:${cfNoTlsLandings}) | 保留原节点: ${keptOriginalNodes.length} | Append优选: ${appendedCfNodes.length} | 汇聚节点: ${extraAggregateNodes.length}`);
	}
	for (const w of warnings) headerComments.push(`SpeedSub Warning: ${w}`);

	let resultText = '';
	let contentType = 'text/plain; charset=utf-8';

	if (outputFormat === 'clash') {
		resultText = buildClashOutput(finalNodes, {
			headerComments,
			templateText: config.template || '',
			addRandomUA: config.ua === '1'
		});
		contentType = 'text/yaml; charset=utf-8';
	} else {
		const uris = finalNodes.map(clashNodeToShareUri).filter(Boolean);
		if (!uris.length) {
			return {
				ok: false,
				status: 400,
				error: '当前节点暂不支持导出为分享链接格式'
			};
		}
		const plainText = uris.join('\n');
		resultText = outputFormat === 'base64' ? utf8ToBase64(plainText) : plainText;
		contentType = 'text/plain; charset=utf-8';
	}

	const missingTypes = {
		missingTls: mode === 'cf-optimize' && cfTlsLandings > 0 && tlsPool.length === 0,
		missingNoTls: mode === 'cf-optimize' && cfNoTlsLandings > 0 && noTlsPool.length === 0,
		cfTlsLandings,
		cfNoTlsLandings,
		cfTlsNodeCount,
		cfNoTlsNodeCount
	};

	return {
		ok: true,
		status: 200,
		mode,
		format: outputFormat,
		contentType,
		sourcesSummary,
		warnings,
		missingTypes,
		stats: {
			sourcesTotal,
			sourcesOk,
			sourceErrors,
			totalInputNodes: inputNodes.length,
			cfLandings: cfTlsLandings + cfNoTlsLandings,
			cfTlsLandings,
			cfNoTlsLandings,
			keptOriginalNodes: keptOriginalNodes.length,
			appendedCfNodes: appendedCfNodes.length,
			aggregatedExtraNodes: extraAggregateNodes.length,
			outputTotalNodes: finalNodes.length,
			preferredTlsCount: tlsPool.length,
			preferredNoTlsCount: noTlsPool.length
		},
		result: resultText
	};
}

function makeSubscriptionResponse(pipelineResult, requestUrl) {
	if (!pipelineResult.ok) {
		return new Response(pipelineResult.error || '转换失败', {
			status: pipelineResult.status || 500,
			headers: subHeaders()
		});
	}
	const extra = {
		'content-type': pipelineResult.contentType,
		'X-SpeedSub-Sources': pipelineResult.sourcesSummary,
		'X-SpeedSub-Mode': pipelineResult.mode
	};
	if (pipelineResult.warnings.length) {
		extra['X-SpeedSub-Warning'] = encodeURIComponent(pipelineResult.warnings.join(' | '));
	}
	if (pipelineResult.format === 'clash') {
		extra['Content-Disposition'] = 'inline; filename="speedsub-clash.yaml"';
	}
	return new Response(pipelineResult.result, { status: 200, headers: subHeaders(extra) });
}

// ---------------- KV 配置档 API ----------------

async function readProfileIndex(KV) {
	try {
		const raw = await KV.get(PROFILE_INDEX_KEY);
		const arr = JSON.parse(raw || '[]');
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

function buildShortUrl(request, id, k) {
	const u = new URL(request.url);
	return `${u.origin}/s/${id}?k=${k}`;
}

async function handleProfileApi(request, url, env) {
	if (!(await isAdminAuthed(request, env))) {
		return jsonResponse({ error: '需要管理口令授权', needAuth: true }, 401);
	}
	const KV = env ? env[KV_BINDING] : null;
	if (!KV) return jsonResponse({ error: '未绑定 KV，当前为手动模式', kvUnavailable: true }, 501);

	const action = url.searchParams.get('action') || '';
	const id = url.searchParams.get('id') || '';

	if (request.method === 'GET' && (action === 'list' || !id)) {
		const index = await readProfileIndex(KV);
		const list = [];
		for (const pid of index) {
			const prof = await KV.get(PROFILE_PREFIX + pid, 'json');
			if (prof) {
				list.push({
					id: pid,
					label: prof.label || pid,
					format: prof.format || 'clash',
					pullua: prof.pullua || 'clash',
					updated: prof.updated || '',
					k: prof.k || '',
					shortUrl: buildShortUrl(request, pid, prof.k || '')
				});
			}
		}
		return jsonResponse({ list });
	}

	if (request.method === 'GET') {
		const prof = await KV.get(PROFILE_PREFIX + id, 'json');
		if (!prof) return jsonResponse({ error: '配置档不存在' }, 404);
		return jsonResponse(Object.assign({}, prof, {
			id,
			shortUrl: buildShortUrl(request, id, prof.k || '')
		}));
	}

	if (request.method === 'POST') {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonResponse({ error: '请求体不是合法 JSON' }, 400);
		}
		if (!body.url && !body.link && !body.add && !body.addapi) {
			return jsonResponse({ error: '请至少填写源订阅地址或汇聚节点' }, 400);
		}

		let targetId = id || body.id || '';
		let key = body.k || url.searchParams.get('k') || '';
		const index = await readProfileIndex(KV);

		if (targetId) {
			const existing = await KV.get(PROFILE_PREFIX + targetId, 'json');
			if (existing) {
				if (existing.k && key && existing.k !== key) {
					return jsonResponse({ error: '配置档密钥不匹配' }, 403);
				}
				key = existing.k || key || randomKey();
			} else if (!key) {
				key = randomKey();
			}
		} else {
			targetId = randomId();
			key = key || randomKey();
		}

		const record = {
			url: String(body.url || ''),
			link: String(body.link || ''),
			add: String(body.add || ''),
			addapi: String(body.addapi || ''),
			num: String(body.num || ''),
			format: String(body.format || 'clash'),
			template: String(body.template || ''),
			ua: String(body.ua || '0'),
			pullua: String(body.pullua || 'clash'),
			label: String(body.label || '').trim() || ('配置-' + targetId.slice(0, 4)),
			k: key,
			updated: new Date().toISOString()
		};

		await KV.put(PROFILE_PREFIX + targetId, JSON.stringify(record));
		if (!index.includes(targetId)) {
			index.unshift(targetId);
			await KV.put(PROFILE_INDEX_KEY, JSON.stringify(index));
		}

		const shortUrl = buildShortUrl(request, targetId, key);
		return jsonResponse({
			ok: true,
			id: targetId,
			k: key,
			label: record.label,
			url: shortUrl,
			shortUrl
		});
	}

	if (request.method === 'DELETE') {
		const existing = await KV.get(PROFILE_PREFIX + id, 'json');
		if (!existing) return jsonResponse({ error: '配置档不存在' }, 404);
		const k = url.searchParams.get('k') || '';
		if (existing.k && k && existing.k !== k) {
			return jsonResponse({ error: '配置档密钥不匹配' }, 403);
		}
		await KV.delete(PROFILE_PREFIX + id);
		const index = (await readProfileIndex(KV)).filter(x => x !== id);
		await KV.put(PROFILE_INDEX_KEY, JSON.stringify(index));
		return jsonResponse({ ok: true });
	}

	return jsonResponse({ error: '不支持的方法' }, 405);
}

async function handleProfileSub(request, url, pathname, clientUA, env) {
	const KV = env ? env[KV_BINDING] : null;
	if (!KV) return new Response('未绑定 KV：无法读取配置档', { status: 501, headers: subHeaders() });

	const id = pathname.replace(/^\/s\//, '').replace(/\/+$/, '');
	const prof = await KV.get(PROFILE_PREFIX + id, 'json');
	if (!prof) return new Response('配置档不存在', { status: 404, headers: subHeaders() });

	const k = url.searchParams.get('k') || '';
	if (prof.k && prof.k !== k) return new Response('密钥不正确', { status: 403, headers: subHeaders() });

	const merged = Object.assign({}, prof, {
		format: url.searchParams.get('format') || prof.format || 'clash',
		pullua: url.searchParams.get('pullua') || prof.pullua || 'clash',
		num: url.searchParams.get('num') || prof.num || '',
		template: url.searchParams.get('template') || prof.template || '',
		ua: url.searchParams.get('ua') || prof.ua || '0'
	});

	const res = await runSpeedSubPipeline(merged, clientUA, request.headers.get('User-Agent') || '');
	return makeSubscriptionResponse(res, url);
}

async function handlePreviewApi(request, url, clientUA, env) {
	if (!(await isAdminAuthed(request, env))) {
		return jsonResponse({ error: '需要管理口令授权', needAuth: true }, 401);
	}
	if (request.method !== 'POST') {
		return jsonResponse({ error: '请使用 POST 请求' }, 405);
	}
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: '请求体不是合法 JSON' }, 400);
	}

	let cfg = body || {};
	if (cfg.profileId && !cfg.url && !cfg.add) {
		const KV = env ? env[KV_BINDING] : null;
		if (KV) {
			const prof = await KV.get(PROFILE_PREFIX + cfg.profileId, 'json');
			if (prof) cfg = Object.assign({}, prof, cfg);
		}
	}

	const result = await runSpeedSubPipeline({
		url: cfg.url || '',
		link: cfg.link || '',
		add: cfg.add || '',
		addapi: cfg.addapi || '',
		format: cfg.format || 'clash',
		pullua: cfg.pullua || 'clash',
		num: cfg.num || '',
		template: cfg.template || '',
		ua: cfg.ua || '0'
	}, clientUA, request.headers.get('User-Agent') || '');

	return jsonResponse(result, result.ok ? 200 : (result.status || 400));
}

async function handleAuthApi(request, url, env) {
	const pass = getAdminPass(env);
	if (!pass) return jsonResponse({ ok: true, adminProtected: false });

	if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405);
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: '无效 JSON' }, 400);
	}
	const submitted = String((body && body.pass) || '').trim();
	if (!timingSafeEqualStr(submitted, pass)) {
		return jsonResponse({ ok: false, error: '管理口令不正确' }, 401);
	}
	const token = await signAdminToken(pass);
	const isHttps = url.protocol === 'https:';
	const cookie = `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isHttps ? '; Secure' : ''}`;
	return jsonResponse({ ok: true, adminProtected: true }, 200, { 'Set-Cookie': cookie });
}

function handleLogoutApi(url) {
	const isHttps = url.protocol === 'https:';
	const cookie = `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? '; Secure' : ''}`;
	return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// ---------------- Web UI 页面 ----------------

async function renderPage(request, env) {
	const kvAvailable = !!(env && env[KV_BINDING]);
	const adminProtected = !!getAdminPass(env);
	const authed = await isAdminAuthed(request, env);
	const boot = JSON.stringify({ kvAvailable, adminProtected, authed });
	return new Response(HTML_TEMPLATE.replace('__SPEEDSUB_BOOT__', boot), {
		headers: {
			'content-type': 'text/html; charset=UTF-8',
			'Cache-Control': 'no-store'
		}
	});
}

const HTML_TEMPLATE = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#4f46e5">
<title>SpeedSub · CF 优选订阅聚合器</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%234f46e5'/%3E%3Cpath d='M18 5 9 18h6l-1 9 9-13h-6l1-9z' fill='white'/%3E%3C/svg%3E">
<style>
:root{
  --bg:#f5f6fb; --bg2:#eef0fa; --card:#ffffff; --card2:#f7f8fd; --fg:#141826;
  --muted:#5f6785; --faint:#8b93ad; --border:#e3e6f0; --border2:#d3d8e8;
  --primary:#4f46e5; --primary-2:#6d5ef6; --primary-fg:#ffffff;
  --ok:#0f9d63; --warn:#b26a00; --err:#d13438; --info:#2563eb;
  --shadow:0 1px 2px rgba(20,24,38,.04),0 12px 32px -18px rgba(20,24,38,.28);
  --radius:16px; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0d1017; --bg2:#0a0c12; --card:#161a24; --card2:#1b2030; --fg:#eef1f8;
    --muted:#a2abc2; --faint:#7b849c; --border:#262c3b; --border2:#333a4d;
    --primary:#7c74ff; --primary-2:#948cff; --primary-fg:#0d1017;
    --ok:#3ddc97; --warn:#f5b455; --err:#ff6b6b; --info:#6ba8ff;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 16px 40px -20px rgba(0,0,0,.7);
  }
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;padding:0}
body{
  font-family:var(--sans); color:var(--fg); line-height:1.55;
  background:radial-gradient(1200px 600px at 15% -10%,rgba(124,116,255,.18),transparent 60%),
             radial-gradient(1000px 500px at 110% 0%,rgba(56,189,248,.12),transparent 55%),
             var(--bg);
  min-height:100vh; -webkit-font-smoothing:antialiased;
}
.wrap{max-width:900px;margin:0 auto;padding:28px 18px 72px}
header{display:flex;align-items:center;gap:14px;margin-bottom:22px;flex-wrap:wrap}
.logo{width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,var(--primary),var(--primary-2));display:grid;place-items:center;box-shadow:0 8px 20px -8px rgba(79,70,229,.7);flex:0 0 auto}
.logo svg{width:24px;height:24px;fill:#fff}
@media (prefers-color-scheme: dark){.logo svg{fill:#0d1017}}
h1{font-size:1.28rem;margin:0;letter-spacing:.2px}
.sub{font-size:.82rem;color:var(--muted);margin:2px 0 0}
.head-right{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.pad{padding:20px}
.stack{display:flex;flex-direction:column;gap:16px}
h2{font-size:.95rem;margin:0 0 2px}
.hint{font-size:.78rem;color:var(--faint);margin:0}
label.field{display:block}
.field-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px;flex-wrap:wrap}
.field-head .lbl{font-size:.88rem;font-weight:600}
.opt{font-size:.74rem;color:var(--faint);font-weight:400;margin-left:6px}
textarea,input[type=text],input[type=password],select{
  width:100%;font-family:var(--sans);font-size:.9rem;color:var(--fg);
  background:var(--card2);border:1px solid var(--border2);border-radius:12px;
  padding:11px 13px;outline:none;transition:border-color .15s,box-shadow .15s;
}
textarea{resize:vertical;min-height:96px;font-family:var(--mono);font-size:.84rem;line-height:1.65}
textarea:focus,input:focus,select:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(124,116,255,.18)}
select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 18px) 52%,calc(100% - 13px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:38px;cursor:pointer}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:620px){.two{grid-template-columns:1fr}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--border2);background:var(--card);color:var(--fg);border-radius:11px;padding:9px 14px;font-size:.86rem;font-weight:600;cursor:pointer;transition:transform .06s,background .15s,border-color .15s;white-space:nowrap}
.btn:hover{border-color:var(--primary)}
.btn:active{transform:translateY(1px)}
.btn.primary{background:linear-gradient(135deg,var(--primary),var(--primary-2));border:none;color:var(--primary-fg);padding:12px 18px;font-size:.95rem;box-shadow:0 10px 24px -12px rgba(79,70,229,.85)}
.btn.primary:hover{filter:brightness(1.06)}
.btn.ghost{background:transparent;border-color:transparent;color:var(--primary);padding:6px 9px;font-size:.8rem}
.btn.ghost:hover{background:rgba(124,116,255,.1);border-color:transparent}
.btn.sm{padding:6px 10px;font-size:.78rem;border-radius:9px}
.btn.danger{color:var(--err);border-color:rgba(209,52,56,.35)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.row{display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.link-card{padding:14px;position:sticky;top:10px;z-index:20;background:linear-gradient(180deg,var(--card),var(--card2));backdrop-filter:blur(8px)}
.link-card .ttl{font-size:.76rem;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:7px}
.link-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.link-row input{font-family:var(--mono);font-size:.82rem;flex:1 1 260px;min-width:0}
#shortLink{filter:blur(4.5px);transition:filter .18s}
#shortLink.show{filter:none}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:.7rem;font-weight:700;padding:3px 8px;border-radius:999px;letter-spacing:.02em}
.badge.ok{background:rgba(15,157,99,.12);color:var(--ok)}
.badge.warn{background:rgba(178,106,0,.14);color:var(--warn)}
.badge.info{background:rgba(37,99,235,.12);color:var(--info)}
.badge.muted{background:rgba(139,147,173,.16);color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}
.gate{position:fixed;inset:0;background:rgba(8,10,16,.6);backdrop-filter:blur(6px);display:grid;place-items:center;padding:18px;z-index:100}
.gate .box{width:100%;max-width:380px;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:26px;box-shadow:0 30px 80px -30px rgba(0,0,0,.6)}
.gate h2{font-size:1.1rem;margin:0 0 4px}
.gate p{font-size:.82rem;color:var(--muted);margin:0 0 16px}
.err-text{color:var(--err);font-size:.8rem;min-height:1.2em;margin-top:8px}
dialog{border:1px solid var(--border);border-radius:18px;background:var(--card);color:var(--fg);padding:0;max-width:min(760px,calc(100vw - 28px));width:100%;box-shadow:0 40px 100px -40px rgba(0,0,0,.6)}
dialog::backdrop{background:rgba(8,10,16,.55);backdrop-filter:blur(4px)}
.dlg-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--border)}
.dlg-head h3{font-size:1rem;margin:0}
.dlg-body{padding:18px 20px;max-height:min(66vh,640px);overflow:auto}
.dlg-foot{padding:14px 20px 18px;border-top:1px solid var(--border);display:flex;gap:9px;justify-content:flex-end;flex-wrap:wrap}
.x{border:none;background:transparent;color:var(--muted);font-size:1.35rem;line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px}
.x:hover{background:var(--card2);color:var(--fg)}
pre{background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:13px;overflow:auto;font-family:var(--mono);font-size:.78rem;line-height:1.55;max-height:44vh;white-space:pre;margin:0}
.doc{font-size:.86rem;line-height:1.7}
.doc h4{margin:16px 0 6px;font-size:.88rem}
.doc p,.doc li{color:var(--muted)}
.doc ul{padding-left:20px;margin:6px 0}
.doc code{font-family:var(--mono);background:var(--card2);border:1px solid var(--border);border-radius:6px;padding:1px 5px;font-size:.8rem;color:var(--fg)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px}
.stat{background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:10px 12px}
.stat .k{font-size:.72rem;color:var(--faint)}
.stat .v{font-size:1.2rem;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}
.stat .v small{font-size:.72rem;font-weight:500;color:var(--muted)}
.callout{border-radius:12px;padding:11px 13px;font-size:.82rem;margin-bottom:12px;border:1px solid transparent}
.callout.warn{background:rgba(178,106,0,.1);border-color:rgba(178,106,0,.25);color:var(--warn)}
.callout.err{background:rgba(209,52,56,.09);border-color:rgba(209,52,56,.25);color:var(--err)}
.callout.info{background:rgba(37,99,235,.08);border-color:rgba(37,99,235,.22);color:var(--info)}
.callout ul{margin:6px 0 0;padding-left:20px}
.profile-item{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--border)}
.profile-item:first-child{border-top:none}
.profile-item .pi-main{flex:1;min-width:0}
.profile-item .pi-name{font-weight:600;font-size:.88rem;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.profile-item .pi-meta{font-size:.74rem;color:var(--faint);margin-top:2px;word-break:break-all}
.profile-item .pi-actions{display:flex;gap:6px;flex-wrap:wrap}
.toast-wrap{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:120;pointer-events:none;width:max-content;max-width:calc(100vw - 32px)}
.toast{pointer-events:auto;background:var(--card);border:1px solid var(--border);border-left:4px solid var(--primary);border-radius:11px;padding:10px 15px;font-size:.83rem;box-shadow:0 18px 40px -18px rgba(0,0,0,.5);animation:slideup .22s ease}
.toast.ok{border-left-color:var(--ok)}
.toast.error{border-left-color:var(--err)}
.toast.warn{border-left-color:var(--warn)}
@keyframes slideup{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
#qrBox{display:grid;place-items:center;padding:8px;background:#fff;border-radius:14px;width:262px;height:262px;margin:0 auto}
#qrBox canvas,#qrBox img{max-width:100%;height:auto}
.spin{width:15px;height:15px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.foot{text-align:center;font-size:.74rem;color:var(--faint);margin-top:26px;line-height:1.9}
.foot a{color:var(--muted);text-decoration:none}
.foot a:hover{color:var(--primary)}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:.76rem;background:var(--card2);border:1px solid var(--border);border-radius:999px;padding:3px 10px;color:var(--muted)}
.chip button{border:none;background:transparent;color:var(--err);cursor:pointer;font-size:.8rem;padding:0 2px}
.seg-hint{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:.75rem;color:var(--faint);flex-wrap:wrap}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo"><svg viewBox="0 0 24 24"><path d="M13 2 4.5 14.5H10L9 22l8.5-12.5H12L13 2z"/></svg></div>
    <div>
      <h1>SpeedSub</h1>
      <p class="sub">多订阅汇总转换 · Cloudflare 优选 IP 加速</p>
    </div>
    <div class="head-right">
      <span class="badge muted" id="kvBadge" hidden></span>
      <span class="badge ok" id="adminBadge" hidden>已登录</span>
      <button class="btn sm" id="logoutBtn" type="button" hidden>退出</button>
    </div>
  </header>

  <div class="stack">

    <!-- 短链卡 -->
    <section class="card link-card" id="linkCard" hidden>
      <div class="ttl">
        <span class="dot" style="color:var(--ok)"></span>
        订阅链接
        <span class="badge muted" id="linkModeBadge">KV 短链</span>
      </div>
      <div class="link-row">
        <input type="text" id="shortLink" readonly spellcheck="false">
        <button class="btn sm" type="button" id="revealBtn" title="显示 / 隐藏">显示</button>
        <button class="btn sm" type="button" id="copyBtn">复制</button>
        <button class="btn sm" type="button" id="previewBtn">预览</button>
        <button class="btn sm" type="button" id="qrBtn">二维码</button>
        <button class="btn sm" type="button" id="openLinkBtn">打开</button>
      </div>
      <p class="hint" id="linkHint" style="margin-top:8px"></p>
    </section>

    <!-- 主表单 -->
    <section class="card pad">
      <form id="form" class="stack" autocomplete="off">
        <div>
          <div class="field-head">
            <span class="lbl">① 源订阅<span class="opt">每行一条，可混写订阅链接与裸节点</span></span>
          </div>
          <textarea id="url" rows="5" placeholder="https://example.com/api/v1/client/subscribe?token=xxx&#10;vless://uuid@1.2.3.4:443?security=tls&sni=a.com#节点&#10;（中文说明、符号、空行会被自动忽略；重复项自动去重）"></textarea>
          <div class="seg-hint">支持 http(s) 链接、base64 订阅、Clash YAML、明文分享链接</div>
        </div>

        <div>
          <div class="field-head">
            <span class="lbl">② 自定义优选与汇聚<span class="opt">可留空</span></span>
            <button class="btn ghost" type="button" id="openHelp">📍 填写说明</button>
          </div>
          <textarea id="add" rows="7" placeholder="104.16.0.1&#10;104.16.0.2:2053&#10;2606:4700::1&#10;cf.090227.xyz&#10;https://api.example.com/cfip-list&#10;sub://你的订阅域名/path&#10;# 备注写在行尾，例如 104.16.0.1:443 #香港"></textarea>
          <div class="seg-hint">
            <span class="chip" id="modeChip">未填 = 纯汇总模式</span>
            <span>留空时只做多源汇总 + 格式转换 + 全局去重，不改写任何节点。</span>
          </div>
        </div>

        <div class="two">
          <label class="field">
            <span class="lbl" style="display:block;margin-bottom:7px">③ 拉取源 UA</span>
            <select id="pullua">
              <option value="clash" selected>Clash（clash.meta）</option>
              <option value="auto">自动（跟随客户端 UA）</option>
              <option value="v2rayng">v2rayNG</option>
              <option value="v2rayn">v2rayN</option>
              <option value="surge">Surge</option>
              <option value="shadowrocket">Shadowrocket</option>
            </select>
          </label>
          <label class="field">
            <span class="lbl" style="display:block;margin-bottom:7px">④ 选择输出格式</span>
            <select id="format">
              <option value="clash" selected>Clash（mihomo YAML）</option>
              <option value="auto">自动</option>
              <option value="base64">Base64（v2ray 通用）</option>
              <option value="plain">明文分享链接</option>
            </select>
          </label>
        </div>

        <div class="row" style="justify-content:space-between">
          <div class="row">
            <span class="chip" id="editingChip" hidden></span>
          </div>
          <div class="row">
            <button class="btn" type="button" id="resetBtn">清空</button>
            <button class="btn primary" type="submit" id="submitBtn">保存并更新</button>
          </div>
        </div>
      </form>
    </section>

    <!-- 配置档 -->
    <section class="card pad" id="profilesCard" hidden>
      <div class="field-head">
        <span class="lbl">我的配置档<span class="opt">绑定 KV 后保存的订阅</span></span>
        <button class="btn ghost" type="button" id="refreshProfiles">刷新</button>
      </div>
      <div id="profilesList"><p class="hint">加载中…</p></div>
    </section>

  </div>

  <p class="foot">
    仅处理 <code>IP</code> / <code>端口</code> / <code>节点名称</code>，绝不修改 tls、sni、ech-opts 等配置选项。<br>
    <a href="https://github.com/yegetables/SpeedSub" target="_blank" rel="noopener">GitHub</a>
  </p>
</div>

<!-- 登录闸门 -->
<div class="gate" id="loginGate" hidden>
  <form class="box" id="loginForm">
    <h2>管理口令</h2>
    <p>此管理页已启用口令保护。<code>/s/</code> 订阅链接不受影响。</p>
    <input type="password" id="loginPass" placeholder="请输入管理口令" autocomplete="current-password">
    <div class="err-text" id="loginErr"></div>
    <button class="btn primary" type="submit" style="width:100%;margin-top:14px" id="loginBtn">进入</button>
  </form>
</div>

<!-- 填写说明 -->
<dialog id="helpDialog">
  <div class="dlg-head">
    <h3>📍 自定义优选与汇聚 · 填写说明</h3>
    <button class="x" type="button" data-close="helpDialog">×</button>
  </div>
  <div class="dlg-body doc">
    <p>一个输入框搞定所有：<b>优选 IP / 域名、IP API、汇聚订阅、现成节点</b>，每行一条，<code>#</code> 后写备注。</p>

    <h4>一、优选 IP / 域名（直接写）</h4>
    <ul>
      <li><code>104.16.0.1</code> → 默认 443（TLS 池）</li>
      <li><code>104.16.0.2:2053</code> → TLS 池</li>
      <li><code>104.16.0.3:80</code> → 非 TLS 池</li>
      <li><code>[2606:4700::1]:8443</code> → IPv6（带方括号）</li>
      <li><code>cf.090227.xyz</code> → 优选域名，默认 443</li>
      <li><code>104.16.0.4:443 #香港</code> → 行尾备注会写进节点名</li>
    </ul>

    <h4>二、优选 IP API（自动拉取列表）</h4>
    <ul>
      <li><code>https://raw.githubusercontent.com/.../ips-v4.txt</code></li>
      <li><code>sub://你的域名/path</code> → 自动补全为 <code>https://</code></li>
      <li><code>https://github.com/user/repo/blob/main/list.txt</code> → 自动转 raw</li>
      <li>也兼容 CloudflareST 导出的 CSV（<code>IP,已发送,已接收,...</code>）</li>
    </ul>

    <h4>三、汇聚订阅 / 现成节点（原样附加）</h4>
    <ul>
      <li><code>https://example.com/api/v1/client/subscribe?token=xxx</code></li>
      <li><code>vless://uuid@host:port?...#节点名</code>（也支持 vmess / trojan / ss / hysteria2 / tuic / anytls）</li>
    </ul>

    <h4>端口池规则</h4>
    <ul>
      <li><b>TLS 池</b>：443 / 2053 / 2083 / 2087 / 2096 / 8443</li>
      <li><b>非 TLS 池</b>：80 / 8080 / 8880 / 2052 / 2082 / 2086 / 2095</li>
      <li>TLS 节点只从 TLS 池取 IP，非 TLS 节点只从非 TLS 池取 IP，<b>绝不跨类型错配</b>。</li>
      <li>某个类型没填优选时，后端保留该类型原节点并给出提示，不会拿另一种类型顶替。</li>
    </ul>

    <h4>工作原理</h4>
    <ul>
      <li>每个独立 CF 落地（按凭据 / 传输 / SNI / Host / path 归并）只保留 <b>1 条基准原节点</b>。</li>
      <li>再把优选 <code>IP:端口</code> 依次追加为新节点并统一改名，原节点配置选项一个字符都不动。</li>
      <li>整框留空 = <b>纯汇总模式</b>：只汇总、转换、去重，不识别 CF、不精简。</li>
    </ul>
  </div>
  <div class="dlg-foot">
    <button class="btn" type="button" data-close="helpDialog">知道了</button>
  </div>
</dialog>

<!-- 缺类型提示 -->
<dialog id="missingDialog">
  <div class="dlg-head">
    <h3>优选类型不完整</h3>
    <button class="x" type="button" id="missingX">×</button>
  </div>
  <div class="dlg-body">
    <div class="callout warn" id="missingText"></div>
    <p class="hint">为安全起见，SpeedSub 不会用 TLS 优选去替换非 TLS 节点（反过来也一样）。你可以补全后再生成，或先按已提供的类型替换。</p>
  </div>
  <div class="dlg-foot">
    <button class="btn" type="button" id="missingSupplement">去补充</button>
    <button class="btn primary" type="button" id="missingProceed">仅替换已提供类型</button>
  </div>
</dialog>

<!-- 二维码 -->
<dialog id="qrDialog">
  <div class="dlg-head">
    <h3>订阅二维码</h3>
    <button class="x" type="button" data-close="qrDialog">×</button>
  </div>
  <div class="dlg-body">
    <div id="qrBox"><span class="hint" id="qrMsg">生成中…</span></div>
    <p class="hint" style="text-align:center;margin-top:12px;word-break:break-all" id="qrUrl"></p>
  </div>
  <div class="dlg-foot">
    <button class="btn" type="button" id="qrCopy">复制链接</button>
    <button class="btn" type="button" data-close="qrDialog">关闭</button>
  </div>
</dialog>

<!-- 预览 -->
<dialog id="previewDialog">
  <div class="dlg-head">
    <h3>结果预览</h3>
    <button class="x" type="button" data-close="previewDialog">×</button>
  </div>
  <div class="dlg-body">
    <div id="previewBody"></div>
  </div>
  <div class="dlg-foot">
    <button class="btn" type="button" id="downloadBtn">下载结果文件</button>
    <button class="btn" type="button" data-close="previewDialog">关闭</button>
  </div>
</dialog>

<div class="toast-wrap" id="toastWrap"></div>

<script>
window.__SPEEDSUB__ = __SPEEDSUB_BOOT__;
(function () {
  'use strict';

  var boot = window.__SPEEDSUB__ || {};
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    link: '',
    editingId: '',
    editingLabel: '',
    previewText: '',
    previewName: '',
    profiles: []
  };

  /* ------------------------------ 工具 ------------------------------ */
  function toast(msg, tone) {
    var el = document.createElement('div');
    el.className = 'toast ' + (tone || '');
    el.textContent = msg;
    $('toastWrap').appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      el.style.transition = 'all .25s';
      setTimeout(function () { el.remove(); }, 260);
    }, 3200);
  }

  function setCookie(name, value, days) {
    document.cookie = name + '=' + encodeURIComponent(value) + '; Path=/; Max-Age=' + (days * 86400) + '; SameSite=Lax';
  }
  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.*+?^$()|[\]\\])/g, '\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function api(method, url, body) {
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined && body !== null) {
      opt.headers['content-type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (res) {
      return res.json().catch(function () {
        return { ok: false, error: 'HTTP ' + res.status };
      }).then(function (data) {
        data = data || {};
        data.__status = res.status;
        if (res.status === 401 && data.needAuth) showLogin();
        return data;
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ------------------------------ 表单存取 ------------------------------ */
  var FORM_KEY = 'ss_form_v1';
  var ADD_COOKIE = 'speedsub_add';

  function gather() {
    return {
      url: $('url').value.trim(),
      add: $('add').value.trim(),
      format: $('format').value,
      pullua: $('pullua').value
    };
  }

  function saveForm() {
    var cfg = gather();
    try { localStorage.setItem(FORM_KEY, JSON.stringify(cfg)); } catch (e) {}
    setCookie(ADD_COOKIE, cfg.add, 365);
    updateModeChip();
  }

  function loadForm() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(FORM_KEY) || 'null'); } catch (e) {}
    if (saved) {
      $('url').value = saved.url || '';
      $('add').value = saved.add || '';
      $('format').value = saved.format || 'clash';
      $('pullua').value = saved.pullua || 'clash';
    }
    var cookieAdd = getCookie(ADD_COOKIE);
    if (cookieAdd && (!saved || !saved.add)) $('add').value = cookieAdd;
    updateModeChip();
  }

  function fillForm(cfg) {
    $('url').value = cfg.url || '';
    $('add').value = cfg.add || '';
    $('format').value = cfg.format || 'clash';
    $('pullua').value = cfg.pullua || 'clash';
    saveForm();
  }

  function updateModeChip() {
    var hasAdd = $('add').value.trim().length > 0;
    var chip = $('modeChip');
    chip.textContent = hasAdd ? 'CF 优选 / 汇聚模式' : '未填 = 纯汇总模式';
    chip.style.color = hasAdd ? 'var(--primary)' : '';
  }

  /* ------------------------------ 短链 ------------------------------ */
  function buildReLink(cfg) {
    var p = new URLSearchParams();
    if (cfg.url) p.set('url', cfg.url);
    if (cfg.add) p.set('add', cfg.add);
    if (cfg.format && cfg.format !== 'clash') p.set('format', cfg.format);
    if (cfg.pullua && cfg.pullua !== 'clash') p.set('pullua', cfg.pullua);
    return location.origin + '/re?' + p.toString();
  }

  function showLink(link, modeLabel, hint) {
    state.link = link;
    $('linkCard').hidden = false;
    $('shortLink').value = link;
    $('shortLink').classList.remove('show');
    $('revealBtn').textContent = '显示';
    $('linkModeBadge').textContent = modeLabel || '订阅链接';
    $('linkHint').textContent = hint || '';
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { toast('已复制', 'ok'); })
        .catch(function () { fallbackCopy(text); });
    }
    fallbackCopy(text);
    return Promise.resolve();
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制', 'ok'); } catch (e) { toast('复制失败，请手动选择', 'error'); }
    ta.remove();
  }

  /* ------------------------------ 缺类型对话框 ------------------------------ */
  var missingResolve = null;
  function askMissing(mt) {
    var parts = [];
    if (mt.missingTls) parts.push('缺少 <b>TLS 优选</b>（443 / 2053 / 2083 / 2087 / 2096 / 8443）：检测到 ' + mt.cfTlsLandings + ' 个 TLS CF 落地，其原节点将保持原样。');
    if (mt.missingNoTls) parts.push('缺少 <b>非 TLS 优选</b>（80 / 8080 / 8880 / 2052 / 2082 / 2086 / 2095）：检测到 ' + mt.cfNoTlsLandings + ' 个非 TLS CF 落地，其原节点将保持原样。');
    $('missingText').innerHTML = parts.join('<br><br>');
    var dlg = $('missingDialog');
    dlg.showModal();
    return new Promise(function (resolve) {
      missingResolve = resolve;
    });
  }
  function finishMissing(val) {
    $('missingDialog').close();
    if (missingResolve) { missingResolve(val); missingResolve = null; }
  }
  $('missingSupplement').addEventListener('click', function () { finishMissing('supplement'); });
  $('missingProceed').addEventListener('click', function () { finishMissing('proceed'); });
  $('missingX').addEventListener('click', function () { finishMissing('supplement'); });

  /* ------------------------------ 预览 ------------------------------ */
  function statCard(k, v, sub) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + (sub ? ' <small>' + esc(sub) + '</small>' : '') + '</div></div>';
  }

  function showPreview(data) {
    var body = $('previewBody');
    if (!data || data.ok === false) {
      body.innerHTML = '<div class="callout err">' + esc((data && data.error) || '预览失败') + '</div>';
      state.previewText = '';
      $('previewDialog').showModal();
      return;
    }
    var s = data.stats || {};
    var html = '';
    html += '<div class="row" style="margin-bottom:12px">' +
      '<span class="badge ' + (data.mode === 'cf-optimize' ? 'info' : 'muted') + '">' + (data.mode === 'cf-optimize' ? 'CF 优选模式' : '纯汇总模式') + '</span>' +
      '<span class="badge muted">输出：' + esc(data.format) + '</span>' +
      '<span class="badge ok">源成功 ' + esc(data.sourcesSummary || (s.sourcesOk + '/' + s.sourcesTotal)) + '</span>' +
      '</div>';

    html += '<div class="stats">';
    html += statCard('输入节点', s.totalInputNodes == null ? '-' : s.totalInputNodes);
    html += statCard('独立 CF 落地', s.cfLandings == null ? 0 : s.cfLandings);
    html += statCard('TLS 落地', (s.cfTlsLandings || 0), '条 ' + (s.cfTlsNodeCount || 0));
    html += statCard('非 TLS 落地', (s.cfNoTlsLandings || 0), '条 ' + (s.cfNoTlsNodeCount || 0));
    html += statCard('保留原节点', s.keptOriginalNodes == null ? '-' : s.keptOriginalNodes);
    html += statCard('Append 优选', s.appendedCfNodes == null ? 0 : s.appendedCfNodes);
    html += statCard('汇聚附加', s.aggregatedExtraNodes == null ? 0 : s.aggregatedExtraNodes);
    html += statCard('输出节点', s.outputTotalNodes == null ? '-' : s.outputTotalNodes);
    html += statCard('TLS 优选池', s.preferredTlsCount == null ? 0 : s.preferredTlsCount);
    html += statCard('非 TLS 优选池', s.preferredNoTlsCount == null ? 0 : s.preferredNoTlsCount);
    html += '</div>';

    if (data.warnings && data.warnings.length) {
      html += '<div class="callout warn"><b>提示</b><ul>' + data.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    }
    if (s.sourceErrors && s.sourceErrors.length) {
      html += '<div class="callout warn"><b>失败的源（已跳过）</b><ul>' + s.sourceErrors.slice(0, 12).map(function (e) {
        return '<li>' + esc(e.url) + '：' + esc(e.error) + '</li>';
      }).join('') + '</ul></div>';
    }

    state.previewText = data.result || '';
    state.previewName = data.format === 'clash' ? 'speedsub-clash.yaml' : 'speedsub-nodes.txt';
    var shown = state.previewText;
    var truncated = false;
    if (shown.length > 60000) { shown = shown.slice(0, 60000); truncated = true; }
    html += '<div class="lbl" style="font-size:.82rem;font-weight:600;margin:4px 0 7px">结果文件' + (truncated ? '（已截断显示，下载可得完整内容）' : '') + '</div>';
    html += '<pre>' + esc(shown) + '</pre>';

    body.innerHTML = html;
    $('previewDialog').showModal();
  }

  $('downloadBtn').addEventListener('click', function () {
    if (!state.previewText) { toast('暂无可下载内容', 'warn'); return; }
    var blob = new Blob([state.previewText], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.previewName || 'speedsub-result.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  /* ------------------------------ 保存流程 ------------------------------ */
  var busy = false;
  function setBusy(v) {
    busy = v;
    var btn = $('submitBtn');
    btn.disabled = v;
    btn.innerHTML = v ? '<span class="spin"></span> 处理中…' : '保存并更新';
  }

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var cfg = gather();
    if (!cfg.url && !cfg.add) { toast('请至少填写源订阅或自定义优选', 'error'); return; }
    saveForm();
    setBusy(true);

    api('POST', '/api/preview', cfg).then(function (prev) {
      if (!prev || prev.ok === false) {
        toast((prev && prev.error) || '生成失败', 'error');
        if (prev && prev.stats) showPreview(prev);
        return;
      }
      var mt = prev.missingTypes || {};
      var needAsk = mt.missingTls || mt.missingNoTls;
      var gate = needAsk ? askMissing(mt) : Promise.resolve('proceed');
      return gate.then(function (choice) {
        if (choice === 'supplement') {
          $('add').scrollIntoView({ behavior: 'smooth', block: 'center' });
          $('add').focus();
          toast('请在「自定义优选与汇聚」中补全缺失类型', 'warn');
          return null;
        }
        var savePromise;
        if (boot.kvAvailable && boot.authed !== false) {
          savePromise = api('POST', '/api/profile' + (state.editingId ? ('?id=' + encodeURIComponent(state.editingId)) : ''), cfg)
            .then(function (saved) {
              if (saved && saved.ok && (saved.shortUrl || saved.url)) {
                return { link: saved.shortUrl || saved.url, mode: 'KV 短链', hint: '订阅链接已保存，节点会随源订阅实时更新。' };
              }
              if (saved && saved.__status === 501) {
                return { link: buildReLink(cfg), mode: '临时直连', hint: '未绑定 KV，已回退为 /re 直连链接。' };
              }
              if (saved && saved.needAuth) throw new Error('需要管理口令');
              throw new Error((saved && saved.error) || '保存失败');
            })
            .catch(function (err) {
              return { link: buildReLink(cfg), mode: '临时直连', hint: '保存失败（' + err.message + '），已回退为 /re 直连链接。' };
            });
        } else {
          savePromise = Promise.resolve({ link: buildReLink(cfg), mode: '临时直连', hint: '未绑定 KV，已生成 /re 直连链接；链接较长时建议绑定 KV。' });
        }
        return savePromise.then(function (r) {
          showLink(r.link, r.mode, r.hint);
          state.previewText = prev.result || '';
          state.previewName = prev.format === 'clash' ? 'speedsub-clash.yaml' : 'speedsub-nodes.txt';
          toast('已生成订阅链接', 'ok');
          if (boot.kvAvailable && state.editingId) loadProfiles();
        });
      });
    }).catch(function (err) {
      toast('网络错误：' + err.message, 'error');
    }).then(function () {
      setBusy(false);
    });
  });

  /* ------------------------------ 预览按钮 ------------------------------ */
  $('previewBtn').addEventListener('click', function () {
    var cfg = gather();
    if (!state.link && !cfg.url && !cfg.add) { toast('请先生成订阅', 'warn'); return; }
    var body = (cfg.url || cfg.add) ? cfg : null;
    if (!body && state.editingId) body = { profileId: state.editingId };
    if (!body) { toast('当前没有可预览的配置', 'warn'); return; }
    toast('正在拉取并计算…', '');
    api('POST', '/api/preview', body).then(function (data) {
      showPreview(data);
    }).catch(function (err) {
      toast('预览失败：' + err.message, 'error');
    });
  });

  /* ------------------------------ 短链按钮 ------------------------------ */
  $('copyBtn').addEventListener('click', function () {
    if (!state.link) return;
    copyText(state.link);
  });
  $('revealBtn').addEventListener('click', function () {
    var i = $('shortLink');
    var shown = i.classList.toggle('show');
    $('revealBtn').textContent = shown ? '隐藏' : '显示';
  });
  $('openLinkBtn').addEventListener('click', function () {
    if (state.link) window.open(state.link, '_blank', 'noopener');
  });
  $('qrCopy').addEventListener('click', function () { if (state.link) copyText(state.link); });
  $('qrBtn').addEventListener('click', function () {
    if (!state.link) return;
    $('qrUrl').textContent = state.link;
    var box = $('qrBox');
    box.innerHTML = '<span class="hint" id="qrMsg">加载二维码组件…</span>';
    $('qrDialog').showModal();
    loadQrLib().then(function () {
      box.innerHTML = '';
      try {
        new QRCode(box, { text: state.link, width: 244, height: 244, correctLevel: QRCode.CorrectLevel.M });
      } catch (e) {
        box.innerHTML = '<span class="hint">二维码生成失败，请直接复制链接</span>';
      }
    }).catch(function () {
      box.innerHTML = '<span class="hint">二维码组件加载失败，请复制链接使用</span>';
    });
  });

  var qrPromise = null;
  function loadQrLib() {
    if (window.QRCode) return Promise.resolve();
    if (qrPromise) return qrPromise;
    qrPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('load failed')); };
      document.head.appendChild(s);
      setTimeout(function () { if (!window.QRCode) reject(new Error('timeout')); }, 8000);
    });
    return qrPromise;
  }

  /* ------------------------------ 配置档 ------------------------------ */
  function loadProfiles() {
    if (!boot.kvAvailable) { $('profilesCard').hidden = true; return; }
    if (boot.adminProtected && !boot.authed) { $('profilesCard').hidden = true; return; }
    $('profilesCard').hidden = false;
    $('profilesList').innerHTML = '<p class="hint">加载中…</p>';
    api('GET', '/api/profile').then(function (data) {
      if (data && data.list) {
        state.profiles = data.list;
        renderProfiles(data.list);
      } else if (data && data.__status === 501) {
        $('profilesList').innerHTML = '<p class="hint">KV 未绑定，使用 /re 直连模式。</p>';
      } else {
        $('profilesList').innerHTML = '<p class="hint">' + esc((data && data.error) || '加载失败') + '</p>';
      }
    }).catch(function (err) {
      $('profilesList').innerHTML = '<p class="hint">加载失败：' + esc(err.message) + '</p>';
    });
  }

  function renderProfiles(list) {
    if (!list.length) {
      $('profilesList').innerHTML = '<p class="hint">还没有保存的配置档。填好上方表单点「保存并更新」即可创建。</p>';
      return;
    }
    $('profilesList').innerHTML = list.map(function (p) {
      return '<div class="profile-item" data-id="' + esc(p.id) + '">' +
        '<div class="pi-main">' +
          '<div class="pi-name">' + esc(p.label || p.id) +
            ' <span class="badge muted">' + esc(p.format || 'clash') + '</span>' +
            ' <span class="badge muted">' + esc(p.pullua || 'clash') + '</span>' +
          '</div>' +
          '<div class="pi-meta">' + esc(p.shortUrl || (location.origin + '/s/' + p.id)) + '</div>' +
          '<div class="pi-meta">更新：' + esc(p.updated || '-') + '</div>' +
        '</div>' +
        '<div class="pi-actions">' +
          '<button class="btn sm" data-act="load">载入</button>' +
          '<button class="btn sm" data-act="preview">预览</button>' +
          '<button class="btn sm" data-act="copy">复制</button>' +
          '<button class="btn sm danger" data-act="delete">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  $('profilesList').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var item = btn.closest('.profile-item');
    var id = item && item.getAttribute('data-id');
    if (!id) return;
    var prof = null;
    for (var i = 0; i < state.profiles.length; i++) { if (state.profiles[i].id === id) { prof = state.profiles[i]; break; } }
    var act = btn.getAttribute('data-act');

    if (act === 'copy' && prof) { copyText(prof.shortUrl); return; }

    if (act === 'preview') {
      toast('正在拉取并计算…', '');
      api('POST', '/api/preview', { profileId: id }).then(showPreview).catch(function (err) { toast('预览失败：' + err.message, 'error'); });
      return;
    }

    if (act === 'delete') {
      if (!confirm('确定删除配置档「' + ((prof && prof.label) || id) + '」？删除后短链立即失效。')) return;
      deleteProfile(id, prof);
      return;
    }

    if (act === 'load') {
      api('GET', '/api/profile?id=' + encodeURIComponent(id)).then(function (data) {
        if (!data || data.error) { toast((data && data.error) || '载入失败', 'error'); return; }
        fillForm(data);
        state.editingId = id;
        state.editingLabel = data.label || id;
        $('editingChip').hidden = false;
        $('editingChip').innerHTML = '正在编辑：' + esc(state.editingLabel) + ' <button type="button" id="cancelEdit">取消</button>';
        var cancel = $('cancelEdit');
        if (cancel) cancel.addEventListener('click', function () {
          state.editingId = ''; state.editingLabel = '';
          $('editingChip').hidden = true;
          toast('已退出编辑，下一次保存将新建配置档', '');
        });
        if (prof && prof.shortUrl) showLink(prof.shortUrl, 'KV 短链', '已载入配置档，可修改后保存更新。');
        toast('已载入配置档', 'ok');
      }).catch(function (err) { toast('载入失败：' + err.message, 'error'); });
    }
  });

  function deleteProfile(id, prof) {
    if (!prof) return;
    api('DELETE', '/api/profile?id=' + encodeURIComponent(id) + '&k=' + encodeURIComponent(prof.k || '')).then(function (data) {
      if (data && data.ok) {
        toast('已删除', 'ok');
        loadProfiles();
        if (state.editingId === id) {
          state.editingId = ''; state.editingLabel = '';
          $('editingChip').hidden = true;
        }
      } else {
        toast((data && data.error) || '删除失败', 'error');
      }
    }).catch(function (err) { toast('删除失败：' + err.message, 'error'); });
  }

  $('refreshProfiles').addEventListener('click', loadProfiles);

  /* ------------------------------ 登录 ------------------------------ */
  function showLogin() {
    $('loginGate').hidden = false;
    setTimeout(function () { try { $('loginPass').focus(); } catch (e) {} }, 60);
  }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pass = $('loginPass').value;
    if (!pass) { $('loginErr').textContent = '请输入口令'; return; }
    $('loginBtn').disabled = true;
    api('POST', '/api/auth', { pass: pass }).then(function (data) {
      if (data && data.ok) { location.reload(); return; }
      $('loginErr').textContent = (data && data.error) || '口令不正确';
    }).catch(function (err) {
      $('loginErr').textContent = '网络错误：' + err.message;
    }).then(function () { $('loginBtn').disabled = false; });
  });

  $('logoutBtn').addEventListener('click', function () {
    api('POST', '/api/logout').then(function () { location.reload(); });
  });

  /* ------------------------------ 其他交互 ------------------------------ */
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (btn) {
    btn.addEventListener('click', function () {
      var d = $(btn.getAttribute('data-close'));
      if (d) d.close();
    });
  });
  $('openHelp').addEventListener('click', function () { $('helpDialog').showModal(); });

  $('resetBtn').addEventListener('click', function () {
    if (!confirm('清空当前表单内容？')) return;
    $('url').value = '';
    $('add').value = '';
    $('format').value = 'clash';
    $('pullua').value = 'clash';
    state.editingId = ''; state.editingLabel = '';
    $('editingChip').hidden = true;
    try { localStorage.removeItem(FORM_KEY); } catch (e) {}
    setCookie(ADD_COOKIE, '', 0);
    updateModeChip();
    toast('已清空', '');
  });

  var saveTimer = null;
  ['url', 'add', 'format', 'pullua'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      updateModeChip();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveForm, 400);
    });
    $(id).addEventListener('change', saveForm);
  });

  /* ------------------------------ 初始化 ------------------------------ */
  loadForm();

  if (boot.adminProtected) {
    $('adminBadge').hidden = !boot.authed;
    $('logoutBtn').hidden = !boot.authed;
    if (!boot.authed) showLogin();
  }

  if (boot.kvAvailable) {
    var kb = $('kvBadge');
    kb.hidden = false;
    kb.textContent = 'KV 已绑定';
  }

  // 页面带参数时自动回填（?url=&add=&format=&pullua=）
  (function () {
    var p = new URLSearchParams(location.search);
    if (p.has('url') || p.has('add')) {
      if (p.has('url')) $('url').value = p.get('url');
      if (p.has('add')) $('add').value = p.get('add');
      if (p.has('format')) $('format').value = p.get('format');
      if (p.has('pullua')) $('pullua').value = p.get('pullua');
      saveForm();
    }
  })();

  if (boot.kvAvailable && (!boot.adminProtected || boot.authed)) loadProfiles();
})();
</script>
</body>
</html>`;

// ---------------- Worker 入口 ----------------

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const pathname = url.pathname.replace(/\/+$/, '') || '/';
		const clientUA = (request.headers.get('User-Agent') || '').toLowerCase();

		try {
			if (pathname === '/' || pathname === '/index.html') {
				return await renderPage(request, env);
			}
			if (pathname === '/api/health') {
				return jsonResponse({
					ok: true,
					kv: !!(env && env[KV_BINDING]),
					adminProtected: !!getAdminPass(env),
					version: '2.0'
				});
			}
			if (pathname === '/api/auth') {
				return await handleAuthApi(request, url, env);
			}
			if (pathname === '/api/logout') {
				return handleLogoutApi(url);
			}
			if (pathname.startsWith('/api/profile')) {
				return await handleProfileApi(request, url, env);
			}
			if (pathname === '/api/preview') {
				return await handlePreviewApi(request, url, clientUA, env);
			}
			if (pathname.startsWith('/s/')) {
				return await handleProfileSub(request, url, pathname, clientUA, env);
			}

			// /re 或任意路径带转换参数 → 临时直连转换
			if (pathname === '/re' || url.searchParams.has('url') || url.searchParams.has('link') || url.searchParams.has('add') || url.searchParams.has('addapi')) {
				const res = await runSpeedSubPipeline({
					url: url.searchParams.get('url') || '',
					link: url.searchParams.get('link') || '',
					add: url.searchParams.get('add') || '',
					addapi: url.searchParams.get('addapi') || '',
					num: url.searchParams.get('num') || '',
					format: url.searchParams.get('format') || 'clash',
					template: url.searchParams.get('template') || '',
					ua: url.searchParams.get('ua') || '0',
					pullua: url.searchParams.get('pullua') || 'clash'
				}, clientUA, request.headers.get('User-Agent') || '');
				return makeSubscriptionResponse(res, url);
			}

			return new Response('Not Found', { status: 404, headers: subHeaders() });
		} catch (err) {
			return new Response('Error: ' + (err && err.message ? err.message : String(err)), {
				status: 500,
				headers: subHeaders()
			});
		}
	}
};

// 供本地 Node 测试按需引用（不影响 Cloudflare Worker 运行）
export {
	extractSources,
	parsePreferredEntry,
	classifyPreferredPools,
	parseAllInOneRaw,
	isCloudflareIP,
	detectCFNodes,
	parseClashYamlNodes,
	parseShareUri,
	cloneNodeWithAddress,
	clashNodeToShareUri,
	uriNodeToClashObj,
	runSpeedSubPipeline,
	buildClashOutput,
	resolvePullUA,
	normalizeGitHubRawUrl
};
