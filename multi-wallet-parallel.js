const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SigningCosmWasmClient, CosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { calculateFee, GasPrice } = require('@cosmjs/stargate');

console.clear();
console.log("\x1b[35m%s\x1b[0m", "============================================");
console.log("\x1b[36m%s\x1b[0m", "   OROSWAP BOT - NHIỀU VÍ ĐA LUỒNG       ");
console.log("\x1b[36m%s\x1b[0m", "               VELHUST                   ");
console.log("\x1b[35m%s\x1b[0m", "============================================\n");

const MAX_RETRIES = 3;
const TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 3000;
const RATE_LIMIT_DELAY_MS = 15000;
const TRANSACTION_DELAY_MS = 600000;

class TimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TimeoutError';
    }
}

const withTimeout = (promise, ms, message) => {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new TimeoutError(message)), ms))
    ]);
};

const log = (message, type = 'info') => {
    const colors = {
        info: '\x1b[36m',
        error: '\x1b[31m',
        warning: '\x1b[33m'
    };
    console.log(`${colors[type] || '\x1b[0m'}${message}\x1b[0m`);
};

const loadFile = (filename) => {
    try {
        const content = fs.readFileSync(path.join(__dirname, filename), "utf8").trim();
        const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        if (lines.length === 0) {
            throw new Error(`File ${filename} rỗng hoặc không chứa dữ liệu hợp lệ`);
        }
        log(`📁 Đã tải ${lines.length} dòng từ file ${filename}`);
        return lines;
    } catch (error) {
        log(`❌ Không thể đọc file ${filename}: ${error.message}`, 'error');
        process.exit(1);
    }
};

const getRandomUserAgent = (userAgents) => {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
};

async function checkProxyIP(proxy, userAgents) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const userAgent = getRandomUserAgent(userAgents);
            const response = await withTimeout(
                axios.get('https://api.ipify.org?format=json', {
                    httpsAgent: proxyAgent,
                    headers: { 'User-Agent': userAgent }
                }),
                TIMEOUT_MS,
                `Proxy IP check timed out for ${proxy}`
            );
            if (response.status === 200) {
                log(`User-Agent sử dụng: ${userAgent}`, 'info');
                return response.data.ip;
            }
            throw new Error(`Invalid proxy response. Status code: ${response.status}`);
        } catch (error) {
            log(`Thử lần ${attempt}/${MAX_RETRIES} thất bại khi kiểm tra proxy ${proxy}: ${error.message}`, 'error');
            if ((error instanceof TimeoutError || error.code === 'ECONNABORTED' || error.code === -32008) && attempt < MAX_RETRIES) {
                log(`Lỗi mạng, thử lại sau ${RETRY_DELAY_MS / 1000} giây...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Không thể kiểm tra IP của proxy ${proxy} sau ${MAX_RETRIES} lần thử`);
}

const validProxiesCache = new Map();
const usedProxies = new Set();

async function getValidProxy(proxies, userAgents, walletIndex) {
    const availableProxies = proxies.filter(proxy => !usedProxies.has(proxy));
    if (availableProxies.length === 0) {
        log(`[Ví ${walletIndex}] ❌ Không còn proxy khả dụng`, 'error');
        return null;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const proxyIndex = Math.floor(Math.random() * availableProxies.length);
        const proxy = availableProxies[proxyIndex];

        if (validProxiesCache.has(proxy)) {
            log(`[Ví ${walletIndex}] ✅ Sử dụng proxy từ cache: ${proxy} (IP: ${validProxiesCache.get(proxy)})`);
            usedProxies.add(proxy);
            return proxy;
        }

        try {
            const ip = await checkProxyIP(proxy, userAgents);
            validProxiesCache.set(proxy, ip);
            usedProxies.add(proxy);
            log(`[Ví ${walletIndex}] ✅ Proxy ${proxy} hoạt động (IP: ${ip})`);
            return proxy;
        } catch (error) {
            log(`[Ví ${walletIndex}] ❌ Proxy ${proxy} không hoạt động: ${error.message}`, 'error');
            availableProxies.splice(proxyIndex, 1);
            if (availableProxies.length === 0) {
                log(`[Ví ${walletIndex}] ❌ Hết proxy khả dụng để thử`, 'error');
                return null;
            }
            log(`[Ví ${walletIndex}] 🔄 Thử proxy khác...`, 'warning');
        }
    }
    return null;
}

const CONFIG = {
    rpcEndpoint: "https://testnet-rpc.zigchain.com",
    chainId: "zig-test-2",
    zigDenom: "uzig",
    oroDenom: "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro",
    swapContract: "zig15jqg0hmp9n06q0as7uk3x9xkwr9k3r7yh4ww2uc0hek8zlryrgmsamk4qg",
    gasPrice: GasPrice.fromString("0.025uzig"),
};

const ZIG_AMOUNT = 0.001;
const ORO_AMOUNT = 0.001;
const LIQ_ORO = 0.001;

const delay = async (ms, walletIndex) => {
    for (let i = ms / 1000; i > 0; i--) {
        process.stdout.write(`\r[Ví ${walletIndex}] ⏳ Đang chờ ${i} giây... `);
        await new Promise(res => setTimeout(res, 1000));
    }
    process.stdout.write("\r\n");
};

async function validateMnemonic(mnemonic) {
    try {
        const words = mnemonic.split(/\s+/).filter(word => word.length > 0);
        if (words.length !== 12) {
            log(`Mnemonic không hợp lệ: Phải chứa đúng 12 từ, nhưng có ${words.length} từ`, 'error');
            return false;
        }
        await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
        return true;
    } catch (e) {
        log(`Mnemonic không hợp lệ: ${e.message}`, 'error');
        return false;
    }
}

async function createClientWithProxy(rpcEndpoint, proxyUrl, userAgents, walletIndex, attempt = 1) {
    try {
        if (!proxyUrl) {
            const userAgent = getRandomUserAgent(userAgents);
            const client = axios.create({
                headers: { 'User-Agent': userAgent }
            });
            log(`[Ví ${walletIndex}] Không sử dụng proxy, User-Agent: ${userAgent}`, 'info');
            return { client, httpEndpoint: rpcEndpoint };
        }

        const proxyAgent = new HttpsProxyAgent(proxyUrl);
        const userAgent = getRandomUserAgent(userAgents);
        const client = axios.create({
            httpsAgent: proxyAgent,
            headers: { 'User-Agent': userAgent }
        });
        log(`[Ví ${walletIndex}] User-Agent sử dụng cho proxy ${proxyUrl}: ${userAgent}`, 'info');

        await withTimeout(
            client.get(rpcEndpoint),
            TIMEOUT_MS,
            `Kiểm tra kết nối RPC timed out cho proxy ${proxyUrl}`
        );
        return { client, httpEndpoint: rpcEndpoint };
    } catch (e) {
        if (e.response && e.response.status === 429 && attempt < MAX_RETRIES) {
            log(`[Ví ${walletIndex}] Lỗi 429 (Too Many Requests) cho proxy ${proxyUrl}. Thử lại lần ${attempt + 1}/${MAX_RETRIES} sau ${RATE_LIMIT_DELAY_MS / 1000} giây...`, 'warning');
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
            return createClientWithProxy(rpcEndpoint, proxyUrl, userAgents, walletIndex, attempt + 1);
        }
        throw new Error(`[Ví ${walletIndex}] Không thể tạo client với proxy ${proxyUrl}: ${e.message}`);
    }
}

async function getBalance(mnemonic, denom, proxyUrl, walletIndex, userAgents, proxies) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
            const [account] = await wallet.getAccounts();
            const { client } = await createClientWithProxy(CONFIG.rpcEndpoint, proxyUrl, userAgents, walletIndex);
            const cosmClient = await CosmWasmClient.connect(CONFIG.rpcEndpoint, { httpClient: client });
            const balance = await cosmClient.getBalance(account.address, denom);
            return { address: account.address, amount: balance.amount, formatted: Number(balance.amount) / 1e6 };
        } catch (e) {
            if (e.message.includes('429') && attempt < MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Lỗi 429 khi lấy số dư. Thử lại lần ${attempt + 1}/${MAX_RETRIES} sau ${RATE_LIMIT_DELAY_MS / 1000} giây...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
                continue;
            }
            if (e.message.includes('429') && attempt === MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Hết lần thử với proxy ${proxyUrl}. Thử proxy khác...`, 'warning');
                usedProxies.delete(proxyUrl);
                const newProxy = await getValidProxy(proxies, userAgents, walletIndex);
                if (newProxy) {
                    return await getBalance(mnemonic, denom, newProxy, walletIndex, userAgents, proxies);
                }
                throw new Error(`[Ví ${walletIndex}] Không tìm được proxy hoạt động thay thế`);
            }
            throw new Error(`[Ví ${walletIndex}] Không thể lấy số dư: ${e.message}`);
        }
    }
    throw new Error(`[Ví ${walletIndex}] Không thể lấy số dư sau ${MAX_RETRIES} lần thử`);
}

async function getBeliefPrice(denom, amount, proxyUrl, walletIndex, userAgents, proxies) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { client } = await  createClientWithProxy(CONFIG.rpcEndpoint, proxyUrl, userAgents, walletIndex);
            const cosmClient = await CosmWasmClient.connect(CONFIG.rpcEndpoint, { httpClient: client });
            const sim = await cosmClient.queryContractSmart(CONFIG.swapContract, {
                simulation: {
                    offer_asset: {
                        amount,
                        info: { native_token: { denom: denom } }
                    }
                }
            });
            const beliefPrice = (BigInt(amount) * BigInt(1e6)) / BigInt(sim.return_amount);
            return (Number(beliefPrice) / 1e6).toFixed(18);
        } catch (e) {
            if (e.message.includes('429') && attempt < MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Lỗi 429 khi lấy belief price. Thử lại lần ${attempt + 1}/${MAX_RETRIES} sau ${RATE_LIMIT_DELAY_MS / 1000} giây...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
                continue;
            }
            if (e.message.includes('429') && attempt === MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Hết lần thử với proxy ${proxyUrl}. Thử proxy khác...`, 'warning');
                usedProxies.delete(proxyUrl);
                const newProxy = await getValidProxy(proxies, userAgents, walletIndex);
                if (newProxy) {
                    return await getBeliefPrice(denom, amount, newProxy, walletIndex, userAgents, proxies);
                }
                throw new Error(`[Ví ${walletIndex}] Không tìm được proxy hoạt động thay thế`);
            }
            throw new Error(`[Ví ${walletIndex}] Không thể lấy belief price: ${e.message}`);
        }
    }
    throw new Error(`[Ví ${walletIndex}] Không thể lấy belief price sau ${MAX_RETRIES} lần thử`);
}

async function getPoolRatio(proxyUrl, walletIndex, userAgents, proxies) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { client } = await createClientWithProxy(CONFIG.rpcEndpoint, proxyUrl, userAgents, walletIndex);
            const cosmClient = await CosmWasmClient.connect(CONFIG.rpcEndpoint, { httpClient: client });
            const poolInfo = await cosmClient.queryContractSmart(CONFIG.swapContract, { pool: {} });

            const zigAsset = poolInfo.assets.find(asset => asset.info.native_token?.denom === CONFIG.zigDenom);
            const oroAsset = poolInfo.assets.find(asset => asset.info.native_token?.denom === CONFIG.oroDenom);

            if (!zigAsset || !oroAsset || !zigAsset.amount || !oroAsset.amount) {
                throw new Error("Không tìm thấy tài sản ZIG hoặc ORO trong pool hoặc amount không hợp lệ");
            }

            const zigReserve = Number(zigAsset.amount) / 1e6;
            const oroReserve = Number(oroAsset.amount) / 1e6;

            if (isNaN(zigReserve) || isNaN(oroReserve) || zigReserve <= 0) {
                throw new Error("Giá trị reserve không hợp lệ hoặc bằng 0");
            }

            const ratio = oroReserve / zigReserve;
            log(`[Ví ${walletIndex}] Tỷ lệ pool hiện tại: ${oroReserve} ORO / ${zigReserve} ZIG = ${ratio} ORO/ZIG`);
            return { zigReserve, oroReserve, ratio };
        } catch (e) {
            if (e.message.includes('429') && attempt < MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Lỗi 429 khi lấy thông tin pool. Thử lại lần ${attempt + 1}/${MAX_RETRIES} sau ${RATE_LIMIT_DELAY_MS / 1000} giây...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
                continue;
            }
            if (e.message.includes('429') && attempt === MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Hết lần thử với proxy ${proxyUrl}. Thử proxy khác...`, 'warning');
                usedProxies.delete(proxyUrl);
                const newProxy = await getValidProxy(proxies, userAgents, walletIndex);
                if (newProxy) {
                    return await getPoolRatio(newProxy, walletIndex, userAgents, proxies);
                }
                throw new Error(`[Ví ${walletIndex}] Không tìm được proxy hoạt động thay thế`);
            }
            log(`[Ví ${walletIndex}] Không thể lấy thông tin pool: ${e.message}`, 'error');
            return null;
        }
    }
    return null;
}

async function swap(mnemonic, amount, fromDenom, toDenom, proxyUrl, walletIndex, userAgents, proxies) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
            const [account] = await wallet.getAccounts();
            const { client } = await createClientWithProxy(CONFIG.rpcEndpoint, proxyUrl, userAgents, walletIndex);
            const cosmClient = await SigningCosmWasmClient.connectWithSigner(CONFIG.rpcEndpoint, wallet, {
                gasPrice: CONFIG.gasPrice,
                chainId: CONFIG.chainId,
                httpClient: client
            });

            const baseAmount = Math.floor(amount * 1e6).toString();
            const beliefPrice = await getBeliefPrice(fromDenom, baseAmount, proxyUrl, walletIndex, userAgents, proxies);
            const fee = calculateFee(320000, CONFIG.gasPrice);

            const msg = {
                swap: {
                    belief_price: beliefPrice,
                    max_spread: "0.005",
                    offer_asset: {
                        amount: baseAmount,
                        info: { native_token: { denom: fromDenom } }
                    }
                }
            };

            const result = await cosmClient.execute(account.address, CONFIG.swapContract, msg, fee, "Swap", [
                { denom: fromDenom, amount: baseAmount }
            ]);

            const fromName = fromDenom === CONFIG.zigDenom ? "ZIG" : "ORO";
            const toName = toDenom === CONFIG.zigDenom ? "ZIG" : "ORO";
            log(`\n[Ví ${walletIndex}] ✅ Swap ${fromName} → ${toName} thành công! TX: ${result.transactionHash}`);
            log(`[Ví ${walletIndex}] 🔍 https://zigscan.org/tx/${result.transactionHash}`);
            return true;
        } catch (e) {
            if (e.message.includes('429') && attempt < MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Lỗi 429 khi swap. Thử lại lần ${attempt + 1}/${MAX_RETRIES} sau ${RATE_LIMIT_DELAY_MS / 1000} giây...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
                continue;
            }
            if (e.message.includes('429') && attempt === MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Hết lần thử với proxy ${proxyUrl}. Thử proxy khác...`, 'warning');
                usedProxies.delete(proxyUrl);
                const newProxy = await getValidProxy(proxies, userAgents, walletIndex);
                if (newProxy) {
                    return await swap(mnemonic, amount, fromDenom, toDenom, newProxy, walletIndex, userAgents, proxies);
                }
                log(`[Ví ${walletIndex}] ❌ Swap thất bại: Không tìm được proxy hoạt động thay thế`, 'error');
                return false;
            }
            log(`[Ví ${walletIndex}] ❌ Swap thất bại: ${e.message}`, 'error');
            return false;
        }
    }
    return false;
}

async function addLiquidity(mnemonic, amountUoro, proxyUrl, walletIndex, userAgents, proxies) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
            const [account] = await wallet.getAccounts();
            const { client } = await createClientWithProxy(CONFIG.rpcEndpoint, proxyUrl, userAgents, walletIndex);
            const cosmClient = await SigningCosmWasmClient.connectWithSigner(CONFIG.rpcEndpoint, wallet, {
                gasPrice: CONFIG.gasPrice,
                chainId: CONFIG.chainId,
                httpClient: client
            });

            const zigBalance = await getBalance(mnemonic, CONFIG.zigDenom, proxyUrl, walletIndex, userAgents, proxies);
            const oroBalance = await getBalance(mnemonic, CONFIG.oroDenom, proxyUrl, walletIndex, userAgents, proxies);
            if (oroBalance.formatted < amountUoro) {
                throw new Error(`Số dư không đủ: Cần ${amountUoro} ORO`);
            }

            const poolInfo = await getPoolRatio(proxyUrl, walletIndex, userAgents, proxies);
            if (!poolInfo) {
                throw new Error("Không thể lấy thông tin pool");
            }
            const { ratio } = poolInfo;

            if (isNaN(ratio) || ratio <= 0) {
                throw new Error("Tỷ lệ pool không hợp lệ");
            }

            const adjustedZig = amountUoro * ratio;
            log(`[Ví ${walletIndex}] Cung cấp thanh khoản: ${amountUoro} ORO và ${adjustedZig.toFixed(6)} ZIG`);

            if (zigBalance.formatted < adjustedZig) {
                throw new Error(`Số dư không đủ: Cần ${adjustedZig.toFixed(6)} ZIG`);
            }

            const uoroAmount = Math.floor(amountUoro * 1e6).toString();
            const uzigAmount = Math.floor(adjustedZig * 1e6).toString();

            if (isNaN(uzigAmount) || uzigAmount <= 0) {
                throw new Error("Số lượng ZIG không hợp lệ để cung cấp thanh khoản");
            }

            const msg = {
                provide_liquidity: {
                    assets: [
                        {
                            amount: uoroAmount,
                            info: { native_token: { denom: CONFIG.oroDenom } }
                        },
                        {
                            amount: uzigAmount,
                            info: { native_token: { denom: CONFIG.zigDenom } }
                        }
                    ],
                    slippage_tolerance: "0.5"
                }
            };

            const funds = [
                { denom: CONFIG.oroDenom, amount: uoroAmount },
                { denom: CONFIG.zigDenom, amount: uzigAmount }
            ];

            const fee = calculateFee(500000, CONFIG.gasPrice);

            const result = await cosmClient.execute(account.address, CONFIG.swapContract, msg, fee, "Swap", funds);

            log(`\n[Ví ${walletIndex}] ✅ Cung cấp thanh khoản cặp ORO/ZIG thành công! TX: ${result.transactionHash}`);
            log(`[Ví ${walletIndex}] 🔍 https://zigscan.org/tx/${result.transactionHash}`);
            return true;
        } catch (err) {
            if (err.message.includes('429') && attempt < MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Lỗi 429 khi thêm thanh khoản. Thử lại lần ${attempt + 1}/${MAX_RETRIES} sau ${RATE_LIMIT_DELAY_MS / 1000} giây...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
                continue;
            }
            if (err.message.includes('429') && attempt === MAX_RETRIES) {
                log(`[Ví ${walletIndex}] Hết lần thử với proxy ${proxyUrl}. Thử proxy khác...`, 'warning');
                usedProxies.delete(proxyUrl);
                const newProxy = await getValidProxy(proxies, userAgents, walletIndex);
                if (newProxy) {
                    return await addLiquidity(mnemonic, amountUoro, newProxy, walletIndex, userAgents, proxies);
                }
                log(`[Ví ${walletIndex}] ❌ Thêm thanh khoản thất bại: Không tìm được proxy hoạt động thay thế`, 'error');
                return false;
            }
            log(`[Ví ${walletIndex}] ❌ Thêm thanh khoản thất bại: ${err.message}`, 'error');
            return false;
        }
    }
    return false;
}

async function runBotForWallet(mnemonic, walletIndex, proxyUrl, userAgents, proxies) {
    log(`\n🚀 Bắt đầu chạy bot cho Ví ${walletIndex} với proxy ${proxyUrl || 'không có proxy'}`);
    
    try {
        const zigBalance = await getBalance(mnemonic, CONFIG.zigDenom, proxyUrl, walletIndex, userAgents, proxies);
        const oroBalance = await getBalance(mnemonic, CONFIG.oroDenom, proxyUrl, walletIndex, userAgents, proxies);
        log(`💰 Số dư ví: ${zigBalance.formatted} ZIG, ${oroBalance.formatted} ORO`);
        
        const totalSwaps = 1 * (10 + 10);
        const totalAddLiquidity = 1 * 5;
        const totalZigRequired = (1 * 10 * ZIG_AMOUNT) + (1 * 10 * LIQ_ORO * 4);
        const totalOroRequired = (1 * 10 * ORO_AMOUNT) + (1 * 10 * LIQ_ORO);
        const totalGasFee = (totalSwaps * 320000 * 0.025 / 1e6) + (totalAddLiquidity * 500000 * 0.025 / 1e6);
        
        log(`\n🔍 Tổng token cần: ${totalZigRequired.toFixed(4)} ZIG, ${totalOroRequired.toFixed(4)} ORO`);
        log(`🔍 Ước tính phí gas: ${totalGasFee.toFixed(4)} ZIG`);
        
        if (zigBalance.formatted < totalZigRequired + totalGasFee || oroBalance.formatted < totalOroRequired) {
            log(`[Ví ${walletIndex}] ❌ Số dư ví không đủ! Cần ít nhất ${totalZigRequired.toFixed(4)} ZIG + ${totalGasFee.toFixed(4)} ZIG (gas) và ${totalOroRequired.toFixed(4)} ORO.`, 'error');
            usedProxies.delete(proxyUrl);
            return;
        }
    } catch (error) {
        log(`[Ví ${walletIndex}] ❌ Không thể kiểm tra balance: ${error.message}`, 'error');
        usedProxies.delete(proxyUrl);
        return;
    }

    for (let liqCount = 0; liqCount < 1; liqCount++) {
        log(`\n[Ví ${walletIndex}] === Chu kỳ Swap thứ ${liqCount + 1} ===`);
        
        for (let i = 0; i < 10; i++) {
            const success = await swap(mnemonic, ZIG_AMOUNT, CONFIG.zigDenom, CONFIG.oroDenom, proxyUrl, walletIndex, userAgents, proxies);
            if (success) {
                await delay(TRANSACTION_DELAY_MS, walletIndex);
            } else {
                log(`[Ví ${walletIndex}] Bỏ qua các giao dịch tiếp theo do swap thất bại`, 'error');
                usedProxies.delete(proxyUrl);
                return;
            }
        }

        for (let i = 0; i < 10; i++) {
            const success = await swap(mnemonic, ORO_AMOUNT, CONFIG.oroDenom, CONFIG.zigDenom, proxyUrl, walletIndex, userAgents, proxies);
            if (success) {
                await delay(TRANSACTION_DELAY_MS, walletIndex);
            } else {
                log(`[Ví ${walletIndex}] Bỏ qua các giao dịch tiếp theo do swap thất bại`, 'error');
                usedProxies.delete(proxyUrl);
                return;
            }
        }

        log(`\n[Ví ${walletIndex}] 💧 Đang thêm thanh khoản...`);
        for (let i = 0; i < 5; i++) {
            const poolInfo = await getPoolRatio(proxyUrl, walletIndex, userAgents, proxies);
            if (poolInfo) {
                const success = await addLiquidity(mnemonic, LIQ_ORO, proxyUrl, walletIndex, userAgents, proxies);
                if (success) {
                    await delay(TRANSACTION_DELAY_MS, walletIndex);
                } else {
                    log(`[Ví ${walletIndex}] Bỏ qua các giao dịch tiếp theo do thêm thanh khoản thất bại`, 'error');
                    usedProxies.delete(proxyUrl);
                    return;
                }
            } else {
                log(`[Ví ${walletIndex}] Không thể thêm thanh khoản do lỗi lấy tỷ lệ pool.`, 'error');
                usedProxies.delete(proxyUrl);
                return;
            }
        }
    }
    
    log(`\n✅ Hoàn thành bot cho Ví ${walletIndex}`);
    usedProxies.delete(proxyUrl);
}

async function runMultiWalletBotParallel() {
    const mnemonics = loadFile("phrase1.txt");
    const proxies = loadFile("proxy.txt");
    const userAgents = loadFile("agent.txt");
    
    if (!mnemonics || mnemonics.length === 0) {
        log("❌ Không có mnemonic được tìm thấy trong file phrase.txt", 'error');
        return;
    }

    if (proxies.length === 0) {
        log("❌ Không có proxy được tìm thấy trong file proxy.txt", 'error');
        return;
    }

    log(`\n🎯 Bắt đầu chạy bot cho ${mnemonics.length} ví với tối đa 5 ví song song...`);
    log(`⚠️ Cảnh báo: Chạy đa luồng có thể gây tải cao cho RPC node!`);

    const MAX_THREADS = Math.min(5, mnemonics.length);
    const queue = mnemonics.map((mnemonic, index) => ({ mnemonic, walletIndex: index + 1 }));
    const activeTasks = new Set();

    async function processQueue() {
        while (queue.length > 0 && activeTasks.size < MAX_THREADS) {
            const { mnemonic, walletIndex } = queue.shift();
            if (await validateMnemonic(mnemonic)) {
                const proxy = await getValidProxy(proxies, userAgents, walletIndex);
                if (proxy) {
                    log(`\n🔄 Xử lý ví ${walletIndex} với proxy ${proxy}...`);
                    const task = runBotForWallet(mnemonic, walletIndex, proxy, userAgents, proxies).finally(() => {
                        activeTasks.delete(task);
                    });
                    activeTasks.add(task);
                } else {
                    log(`[Ví ${walletIndex}] ❌ Bỏ qua vì không tìm được proxy hoạt động`, 'error');
                }
            } else {
                log(`[Ví ${walletIndex}] ❌ Bỏ qua vì mnemonic không hợp lệ`, 'error');
            }
        }
        if (activeTasks.size > 0) {
            await Promise.race([...activeTasks]);
            await processQueue();
        }
    }

    await processQueue();
    await Promise.all([...activeTasks]); // Đợi tất cả các tác vụ đang chạy hoàn thành
    log(`\n🎉 Hoàn thành tất cả các ví!`);
}

const args = process.argv.slice(2);
const mode = args[0] || 'parallel';

if (mode === 'parallel') {
    runMultiWalletBotParallel();
} else {
    runMultiWalletBotParallel();
}