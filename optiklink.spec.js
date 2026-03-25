// tests/optiklink.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs'); // 必须引入 fs 处理图片流

const [panelUser, panelPass] = (process.env.PANEL_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');
// 提取 Token
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// 1. 延长超时时间以适配 GitHub Actions 的网络环境
const TIMEOUT = 120000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

// 辅助函数：转义 HTML 字符，防止 TG 400 错误
function escapeHtml(text) {
    if (!text) return "";
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// --- [核心修改：智能 Cloudflare 穿透函数] ---
async function handleCloudflare(page) {
    const cfFrame = page.frameLocator('iframe[src*="cloudflare"]');
    try {
        const checkbox = cfFrame.locator('input[type="checkbox"]');
        if (await checkbox.isVisible({ timeout: 5000 })) {
            console.log('🛡️ 检测到 Cloudflare 验证码，尝试自动穿透...');
            await checkbox.click().catch(() => {});
            await page.waitForTimeout(5000); 
            return true;
        }
    } catch (e) {}
    return false;
}

// --- [核心修改：UI 风格的 TG 通知函数 - 修复 400 错误版] ---
async function sendUITGReport(page, result, serverName) {
    if (!TG_CHAT_ID || !TG_TOKEN) {
        console.log('⚠️ TG_BOT 未配置，跳过推送');
        return;
    }

    const beijingTime = nowStr();
    const photoPath = `report_${Date.now()}.png`;

    // 1. 截取当前页面截图 (加入状态检查，防止 closed 报错)
    try {
        if (!page.isClosed()) {
            await page.screenshot({ path: photoPath, fullPage: false, timeout: 10000 });
        }
    } catch (e) {
        console.log(`[-] 截图失败: ${e.message}`);
    }

    // 2. 构造符合截图风格的 HTML 文字内容 (进行 HTML 转义)
    const reportContent = [
        `✅ <b>OptikLink 自动化续期报告</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        // 给账户名外层套上 <b> 标签
        `👤 账户：<b><code>${escapeHtml(panelUser)}</code></b>`, 
        `🛰️ 状态：${escapeHtml(result)} ✅`,
        `🖥 服务器：<b>${escapeHtml(serverName)}</b>`,
        // 给北京时间外层套上 <b> 标签
        `🕒 北京时间：<b><code>${escapeHtml(beijingTime)}</code></b>`,
        `━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    // 3. 使用 multipart/form-data 发送图片
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('caption', reportContent);
    form.append('parse_mode', 'HTML');
    
    if (fs.existsSync(photoPath)) {
        form.append('photo', fs.createReadStream(photoPath));
    } else {
        console.log("⚠️ 截图文件不存在，尝试发送纯文字报告");
    }

    return new Promise((resolve) => {
        const options = {
            method: 'POST',
            host: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendPhoto`,
            headers: form.getHeaders(),
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`📨 UI 报告推送成功: ${res.statusCode}`);
                } else {
                    console.log(`📨 UI 报告推送失败: ${res.statusCode}, 响应: ${body}`);
                }
                if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
                resolve();
            });
        });

        req.on('error', (err) => {
            console.log(`⚠️ TG 推送异常: ${err.message}`);
            if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
            resolve();
        });

        form.pipe(req);
    });
}

// 修改后的 Token 注入登录函数 (集成你提供的直达链接并解决 SyntaxError)
async function handleDiscordLoginWithToken(page, token) {
    const DIRECT_AUTH_URL = "https://discord.com/login?redirect_to=%2Foauth2%2Fauthorize%3Fscope%3Dguilds%2Bguilds.join%2Bidentify%2Bemail%26client_id%3D933437142254887052%26redirect_uri%3Dhttps%253A%252F%252Foptiklink.com%252Flogin%26response_type%3Dcode%26prompt%3Dnone";
    
    console.log('[*] 正在通过直达链接执行 Token 强制同步注入...');
    await page.goto(DIRECT_AUTH_URL, { waitUntil: 'domcontentloaded' });
    
    // 登录前潜在验证码检测 (处理进入链接时的拦截)
    await handleCloudflare(page);

    // 坑1：等待页面脚本加载
    await page.waitForTimeout(8000);

    // 修复：使用匿名箭头函数传参注入，避免 'login' 标识符识别错误
    await page.evaluate((t) => {
        const injector = (tokenStr) => {
            const timer = setInterval(() => {
                try {
                    document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage.token = `"${tokenStr}"`;
                } catch(e) {}
            }, 50);
            setTimeout(() => {
                clearInterval(timer);
                location.reload();
            }, 2500);
        };
        injector(t);
    }, token);
    
    // 坑3：注入后刷新，直达链接会自动跳转到授权页
    await page.waitForTimeout(15000);
}

// 处理 Discord OAuth 授权页 (保持原样)
async function handleOAuthPage(page) {
    await page.waitForTimeout(2000);

    for (let i = 0; i < 5; i++) {
        if (!page.url().includes('discord.com')) return;

        try {
            const btn = await page.waitForSelector('button.primary_a22cb0', { timeout: 3000 });
            const text = (await btn.innerText()).trim();

            if (/scroll/i.test(text) || text.includes('滚动')) {
                await page.evaluate(() => {
                    const s = document.querySelector('[class*="scroller"]')
                        || document.querySelector('[class*="scrollerBase"]')
                        || document.querySelector('[class*="content"]');
                    if (s) s.scrollTop = s.scrollHeight;
                    window.scrollTo(0, document.body.scrollHeight);
                });
                await page.waitForTimeout(1500);
                await btn.click();
                await page.waitForTimeout(1500);
            } else if (/authorize/i.test(text) || text.includes('授权')) {
                await btn.click();
                await page.waitForTimeout(3000);
                return;
            } else {
                await page.waitForTimeout(1500);
            }
        } catch {
            try {
                await page.waitForURL(url => !url.toString().includes('discord.com'), { timeout: 10000 });
            } catch { /* 继续等待 */ }
            return;
        }
    }
}

test('OptikLink 保活', async ({ }, testInfo) => {
    // 2. 显式设置此 Test 的超时时间
    test.setTimeout(TIMEOUT);

    const proxyUrl = '';

    if (!DISCORD_TOKEN) {
        throw new Error('❌ 缺少 Token 配置，请设置 DISCORD_TOKEN 环境变量');
    }

    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        proxyConfig = { server: process.env.GOST_PROXY };
        console.log(`🛡️ 使用环境变量代理: ${process.env.GOST_PROXY}`);
    } else if (proxyUrl) {
        proxyConfig = { server: proxyUrl };
        console.log(`🛡️ 使用代理: ${proxyUrl.replace(/:\/\/.*@/, '://***@')}`);
    }

    console.log('🔧 启动浏览器...');
    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    let activePage = page;

    await page.addInitScript(() => {
        if (!location.hostname.includes('optiklink')) return;

        const AD_DOMAINS = [
            'tzegilo.com', 'alwingulla.com', 'auqot.com', 'jmosl.com', '094kk.com',
            'optiklink.com', 'tmll7.com', 'oundhertobeconsist.org',
            'pagead2.googlesyndication.com', 'googlesyndication.com',
            'googletagservices.com', 'doubleclick.net',
            'adsbygoogle', 'popads', 'popcash', 'clickadu', 'tsyndicate',
            'trafficjunky', 'afu.php',
        ];
        const isAd = (url) => url && AD_DOMAINS.some(d => url.includes(d));

        const _createElement = document.createElement.bind(document);
        document.createElement = function (tag) {
            const el = _createElement(tag);
            if (tag.toLowerCase() === 'script') {
                const _desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
                Object.defineProperty(el, 'src', {
                    set(val) { if (!isAd(val)) _desc.set.call(this, val); },
                    get() { return _desc.get.call(this); },
                });
            }
            return el;
        };

        const _write = document.write.bind(document);
        document.write = function (html) { if (!isAd(html)) return _write(html); };

        const _appendChild = Element.prototype.appendChild;
        Element.prototype.appendChild = function (node) {
            if (node?.tagName === 'SCRIPT' && isAd(node.src)) return node;
            return _appendChild.call(this, node);
        };

        const _insertBefore = Element.prototype.insertBefore;
        Element.prototype.insertBefore = function (node, ref) {
            if (node?.tagName === 'SCRIPT' && isAd(node.src)) return node;
            return _insertBefore.call(this, node, ref);
        };

        const _fetch = window.fetch;
        window.fetch = function (url, ...args) {
            if (isAd(typeof url === 'string' ? url : url?.url))
                return Promise.reject(new Error('blocked'));
            return _fetch.call(this, url, ...args);
        };

        const _xhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...args) {
            if (isAd(url)) return;
            return _xhrOpen.call(this, method, url, ...args);
        };

        const _open = window.open.bind(window);
        window.open = function (url, ...args) {
            if (!url) return null;
            if (url.startsWith('/') || url.includes('optiklink')) return _open(url, ...args);
            return null;
        };

        const _addEL = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, fn, opts) {
            if (type === 'click' && (this === window || this === document)) {
                const src = fn?.toString() || '';
                if (/setTimeout\s*\(\s*\w\s*,\s*0\s*\)/.test(src)) return;
                if (/contextmenu.*localStorage|localStorage.*contextmenu/s.test(src)) return;
            }
            return _addEL.call(this, type, fn, opts);
        };

        Object.defineProperty(window, 'adsbygoogle', {
            get: () => ({ loaded: true, push: () => {} }),
            set: () => {},
            configurable: false,
        });
    });

    console.log('🚀 浏览器就绪！');
    console.log('🛡️ OptikLink 广告猎手启动');

    try {
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            const body = await res.text();
            console.log(`✅ 出口 IP 确认：${JSON.parse(body).ip || body}`);
        } catch {
            console.log('⚠️ IP 验证超时，跳过');
        }

        // --- 开始 Token 登录闭环 ---
        await handleDiscordLoginWithToken(page, DISCORD_TOKEN);

        // 处理可能出现的 OAuth 授权页
        console.log('⏳ 等待 OAuth 授权...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 15000 });
            console.log('🔍 进入 OAuth 授权页，处理中...');
            await handleOAuthPage(page);
        } catch (e) {
            console.log('ℹ️ 未检测到授权按钮或已自动重定向');
        }

        console.log('⏳ 确认到达 OptikLink...');
        
        // 登录后潜在验证码检测 (处理截图中的人机验证)
        await page.waitForTimeout(5000);
        await handleCloudflare(page);

        const modalBtnSelector = 'a[data-target="#logintopanel"]';
        
        // 核心修复：如果长时间没看到按钮，强行刷新以破解 Cloudflare 的加载黑洞
        try {
            await page.waitForSelector(modalBtnSelector, { state: 'attached', timeout: 15000 });
        } catch (e) {
            console.log('⚠️ 按钮未渲染，可能是白屏拦截，尝试刷新页面...');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(5000);
            await handleCloudflare(page);
            await page.waitForSelector(modalBtnSelector, { state: 'attached', timeout: 20000 });
        }

        if (!page.url().includes('optiklink.com') && !page.url().includes('optiklink.net')) {
            throw new Error(`❌ 未到达 OptikLink，当前 URL: ${page.url()}`);
        }
        console.log(`✅ 登录成功！当前：${page.url()}`);

        console.log('📤 点击 Login to Panel...');
        await page.waitForLoadState('networkidle');
        
        // 使用 evaluate 强制点击模态框触发器，避开透明广告层
        await page.evaluate((sel) => {
            const btn = document.querySelector(sel);
            if (btn) btn.click();
        }, modalBtnSelector);
        await page.waitForTimeout(3000);

        console.log('📤 点击 Panel Login...');
        // 核心：捕获因为 target="_blank" 而产生的新页面
        const [panelPage] = await Promise.all([
            context.waitForEvent('page'),
            page.evaluate(() => {
                const finalBtn = document.querySelector('a[href*="control.optiklink.net/auth/login"]');
                if (finalBtn) finalBtn.click();
            }),
        ]);

        panelPage.setDefaultTimeout(TIMEOUT);
        activePage = panelPage;
        console.log('⏳ 等待跳转控制台登录页...');
        await panelPage.waitForURL(/control\.optiklink\.net\/auth\/login/, { timeout: TIMEOUT });
        console.log(`✅ 已到达控制台登录页：${panelPage.url()}`);

        console.log('✏️ 填写控制台账号密码...');
        await panelPage.fill('input[name="username"]', panelUser);
        await panelPage.fill('input[name="password"]', panelPass);

        console.log('⏳ 等待 reCAPTCHA 加载...');
        await panelPage.waitForFunction(() => {
            return typeof grecaptcha !== 'undefined' && grecaptcha.getResponse !== undefined;
        }, { timeout: 15000 }).catch(() => console.log('  ℹ️ reCAPTCHA 未检测到，继续...'));
        await panelPage.waitForTimeout(2000);

        console.log('📤 提交控制台登录...');
        await panelPage.click('button[type="submit"]');

        console.log('⏳ 确认到达控制台首页...');
        await panelPage.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: TIMEOUT });
        console.log(`✅ 控制台登录成功！当前：${panelPage.url()}`);

        await panelPage.waitForTimeout(2000);

        console.log('🔍 查找服务器...');
        await panelPage.waitForTimeout(2000);

        const serverInfo = await panelPage.evaluate(() => {
            const card = document.querySelector('a[href*="/server/"]');
            if (!card) return null;
            const href = card.getAttribute('href');
            const id = href.replace('/server/', '').trim();
            const nameEl = card.querySelector('p.sc-1ibsw91-5');
            const name = nameEl ? nameEl.innerText.trim() : '';
            return { id, name };
        });

        if (!serverInfo) throw new Error('❌ 未找到服务器卡片');
        console.log(`✅ 找到服务器：${serverInfo.name} (${serverInfo.id})`);

        await panelPage.goto(`https://control.optiklink.net/server/${serverInfo.id}`, { waitUntil: 'domcontentloaded' });
        console.log(`✅ 已到达服务器页面：${panelPage.url()}`);

        const serverPage = panelPage;

        console.log('🔍 检查服务器状态...');
        await serverPage.waitForTimeout(3000);

        let statusText = '';
        for (let i = 0; i < 12; i++) {
            statusText = await serverPage.locator('p.sc-168cvuh-1').innerText().catch(() => '');
            const s = statusText.toLowerCase();
            if (s.includes('running') || s.includes('offline') || s.includes('stopped')) break;
            console.log(`  🔄 等待状态稳定（${statusText.trim()}）...`);
            await serverPage.waitForTimeout(5000);
        }

        console.log(`💻 服务器状态：${statusText.trim()}`);

        if (statusText.toLowerCase().includes('running')) {
            console.log('🎉 保活成功！');
            await sendUITGReport(serverPage, statusText.trim(), serverInfo.name);
        } else if (statusText.toLowerCase().includes('offline') || statusText.toLowerCase().includes('stopped')) {
            console.log('⚠️ 服务器离线，尝试启动...');
            await serverPage.click('button:has-text("Start")');
            console.log('📤 已点击 Start，持续监控状态...');

            let started = false;
            for (let i = 0; i < 24; i++) {
                await serverPage.waitForTimeout(5000);
                const s = await serverPage.locator('p.sc-168cvuh-1').innerText().catch(() => '');
                console.log(`  🔄 第 ${i + 1} 次检查，状态：${s.trim()}`);
                if (s.toLowerCase().includes('running')) {
                    started = true;
                    break;
                }
            }

            if (started) {
                console.log('✅ 服务器已成功启动！');
                const latestStatus = await serverPage.locator('p.sc-168cvuh-1').innerText().catch(() => 'RUNNING');
                await sendUITGReport(serverPage, latestStatus.trim(), serverInfo.name);
            } else {
                console.log('❌ 等待超时，服务器未能启动');
                await sendUITGReport(serverPage, '启动失败', serverInfo.name);
            }
        } else {
            console.log(`⚠️ 未知状态：${statusText.trim()}`);
            await sendUITGReport(serverPage, `状态异常: ${statusText.trim()}`, serverInfo.name);
        }

    } catch (e) {
        console.log(`❌ 异常: ${e.message}`);
        // 报错也尝试发送带图报告
        try {
            if (activePage && !activePage.isClosed()) {
                await sendUITGReport(activePage, `脚本异常: ${e.message}`, 'ERROR');
            }
        } catch (reportErr) {
            console.log(`[-] 最终错误报告发送失败: ${reportErr.message}`);
        }
        throw e;

    } finally {
        await browser.close();
    }
});
