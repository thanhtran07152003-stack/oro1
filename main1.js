const fs = require("fs");
const path = require("path");
const { SigningCosmWasmClient, CosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { calculateFee, GasPrice } = require('@cosmjs/stargate');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fetch = require('node-fetch');

console.clear();
console.log("\x1b[35m%s\x1b[0m", "============================================");
console.log("\x1b[36m%s\x1b[0m", "      OROSWAP BOT - VÍ KEPLR/LEAP       ");
console.log("\x1b[36m%s\x1b[0m", "               VELHUST                   ");
console.log("\x1b[35m%s\x1b[0m", "============================================\n");

const CONFIG = {
    rpcEndpoint: "https://testnet-rpc.zigchain.com",
    chainId: "zig-test-2",
    zigDenom: "uzig",
    oroDenom: "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro",
    swapContract: "zig15jqg0hmp9n06q0as7uk3x9xkwr9k3r7yh4ww2uc0hek8zlryrgmsamk4qg",
    gasPrice: GasPrice.fromString("0.025uzig"),
};

function getRandomAmount() {
    return parseFloat((Math.random() * (0.009 - 0.001) + 0.001).toFixed(3));
}

const ZIG_AMOUNT = getRandomAmount();
const ORO_AMOUNT = getRandomAmount();
const LIQ_ORO = getRandomAmount();

const delay = async (ms) => {
    for (let i = ms / 1000; i > 0; i--) {
        process.stdout.write(`\r⏳ Đang chờ ${i} giây... `);
        await new Promise(res => setTimeout(res, 1000));
    }
    process.stdout.write("\r\n");
};

// Đọc danh sách mnemonic, proxy và user agent
const MNEMONICS = fs.readFileSync(path.join(__dirname, "phrase1.txt"), "utf8").trim().split("\n");
const PROXIES = fs.readFileSync(path.join(__dirname, "proxy.txt"), "utf8").trim().split("\n");
const USER_AGENTS = fs.readFileSync(path.join(__dirname, "agent.txt"), "utf8").trim().split("\n");

// Tạo danh sách ví với mnemonic, proxy và user agent
const WALLETS = MNEMONICS.map((mnemonic, index) => ({
    mnemonic: mnemonic.trim(),
    proxy: PROXIES[index % PROXIES.length].trim(),
    userAgent: USER_AGENTS[index % USER_AGENTS.length].trim(),
}));

async function getBalance(mnemonic, denom) {
    let accountAddress = "unknown";
    try {
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
        const [account] = await wallet.getAccounts();
        accountAddress = account.address;
        const client = await CosmWasmClient.connect(CONFIG.rpcEndpoint);
        const balance = await client.getBalance(account.address, denom);
        return { address: account.address, amount: balance.amount, formatted: Number(balance.amount) / 1e6 };
    } catch (e) {
        throw new Error(`Không thể lấy số dư (ví ${accountAddress}): ${e.message}`);
    }
}

async function getBeliefPrice(denom, amount, proxy, userAgent, retries = 2) {
    try {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const client = await CosmWasmClient.connect(CONFIG.rpcEndpoint);
        const sim = await client.queryContractSmart(CONFIG.swapContract, {
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
        if (retries > 0 && e.message.includes("429")) {
            console.log(`⚠️ Lỗi 429 trong getBeliefPrice (proxy ${proxy}), thử lại sau 5s...`);
            await delay(5000);
            return getBeliefPrice(denom, amount, proxy, userAgent, retries - 1);
        }
        throw new Error(`Không thể lấy belief price (proxy ${proxy}): ${e.message}`);
    }
}

async function getPoolRatio(proxy, userAgent, retries = 2) {
    try {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const client = await CosmWasmClient.connect(CONFIG.rpcEndpoint);
        const poolInfo = await client.queryContractSmart(CONFIG.swapContract, { pool: {} });

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
        console.log(`Tỷ lệ pool hiện tại: ${oroReserve} ORO / ${zigReserve} ZIG = ${ratio} ORO/ZIG`);
        return { zigReserve, oroReserve, ratio };
    } catch (e) {
        if (retries > 0 && e.message.includes("429")) {
            console.log(`⚠️ Lỗi 429 trong getPoolRatio (proxy ${proxy}), thử lại sau 5s...`);
            await delay(5000);
            return getPoolRatio(proxy, userAgent, retries - 1);
        }
        console.error(`Không thể lấy thông tin pool (proxy ${proxy}):`, e.message);
        return null;
    }
}

async function swap(mnemonic, amount, fromDenom, toDenom, proxy, userAgent) {
    let accountAddress = "unknown";
    try {
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
        const [account] = await wallet.getAccounts();
        accountAddress = account.address;
        const client = await SigningCosmWasmClient.connectWithSigner(CONFIG.rpcEndpoint, wallet, {
            gasPrice: CONFIG.gasPrice,
            chainId: CONFIG.chainId
        });

        const baseAmount = Math.floor(amount * 1e6).toString();
        const beliefPrice = await getBeliefPrice(fromDenom, baseAmount, proxy, userAgent);
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

        const result = await client.execute(account.address, CONFIG.swapContract, msg, fee, "Swap", [
            { denom: fromDenom, amount: baseAmount }
        ]);

        const fromName = fromDenom === CONFIG.zigDenom ? "ZIG" : "ORO";
        const toName = toDenom === CONFIG.zigDenom ? "ZIG" : "ORO";
        console.log(`\n✅ Swap ${fromName} → ${toName} thành công (ví ${account.address})! TX: ${result.transactionHash}`);
        console.log(`🔍 https://zigscan.org/tx/${result.transactionHash}`);
    } catch (e) {
        console.error(`❌ Swap thất bại (ví ${accountAddress}, proxy ${proxy}):`, e.message);
        throw e;
    }
}

async function addLiquidity(mnemonic, amountUoro, amountUzig, proxy, userAgent) {
    let accountAddress = "unknown";
    try {
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
        const [account] = await wallet.getAccounts();
        accountAddress = account.address;
        const client = await SigningCosmWasmClient.connectWithSigner(CONFIG.rpcEndpoint, wallet, {
            gasPrice: CONFIG.gasPrice,
            chainId: CONFIG.chainId
        });

        const zigBalance = await getBalance(mnemonic, CONFIG.zigDenom);
        const oroBalance = await getBalance(mnemonic, CONFIG.oroDenom);
        if (zigBalance.formatted < amountUzig || oroBalance.formatted < amountUoro) {
            throw new Error(`Số dư không đủ: Cần ${amountUzig} ZIG và ${amountUoro} ORO`);
        }

        const poolInfo = await getPoolRatio(proxy, userAgent);
        if (!poolInfo) {
            throw new Error("Không thể lấy thông tin pool");
        }
        const { ratio } = poolInfo;

        if (isNaN(ratio) || ratio <= 0) {
            throw new Error("Tỷ lệ pool không hợp lệ");
        }

        const adjustedZig = amountUoro * ratio;
        console.log(`Cung cấp thanh khoản: ${amountUoro} ORO và ${adjustedZig.toFixed(6)} ZIG`);

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

        const result = await client.execute(account.address, CONFIG.swapContract, msg, fee, "Swap", funds);

        console.log(`\n✅ Cung cấp thanh khoản cặp ORO/ZIG thành công (ví ${account.address})! TX: ${result.transactionHash}`);
        console.log(`🔍 https://zigscan.org/tx/${result.transactionHash}`);
    } catch (err) {
        console.error(`❌ Thêm thanh khoản thất bại (ví ${accountAddress}, proxy ${proxy}):`, err.message);
        throw err;
    }
}

async function runBotForWallet(wallet, index) {
    console.log(`\n=== Bắt đầu xử lý ví ${index + 1} (${wallet.mnemonic.slice(0, 10)}...) với proxy ${wallet.proxy} ===`);

    // Thêm độ trễ để tránh lỗi 429
    await delay(index * 2000); // Độ trễ 2 giây * số thứ tự ví

    try {
        await DirectSecp256k1HdWallet.fromMnemonic(wallet.mnemonic, { prefix: "zig" });
    } catch (error) {
        console.error("\x1b[31m%s\x1b[0m", `❌ Mnemonic không hợp lệ cho ví ${index + 1}: ${error.message}`);
        return;
    }

    try {
        const zigBalance = await getBalance(wallet.mnemonic, CONFIG.zigDenom);
        const oroBalance = await getBalance(wallet.mnemonic, CONFIG.oroDenom);
        console.log(`💰 Số dư ví ${index + 1}: ${zigBalance.formatted} ZIG, ${oroBalance.formatted} ORO`);

        const totalSwaps = 20 * (1 + 1);
        const totalAddLiquidity = 20 * 1;
        const totalZigRequired = (20 * 1 * ZIG_AMOUNT) + (20 * 1 * LIQ_ORO * 4);
        const totalOroRequired = (20 * 1 * ORO_AMOUNT) + (20 * 1 * LIQ_ORO);
        const totalGasFee = (totalSwaps * 320000 * 0.025 / 1e6) + (totalAddLiquidity * 500000 * 0.025 / 1e6);

        console.log(`\n🔍 Tổng token cần: ${totalZigRequired.toFixed(4)} ZIG, ${totalOroRequired.toFixed(4)} ORO`);
        console.log(`🔍 Ước tính phí gas: ${totalGasFee.toFixed(4)} ZIG`);

        if (zigBalance.formatted < totalZigRequired + totalGasFee || oroBalance.formatted < totalOroRequired) {
            console.log("\x1b[31m%s\x1b[0m", `❌ Số dư ví ${index + 1} không đủ! Cần ít nhất ${totalZigRequired.toFixed(4)} ZIG + ${totalGasFee.toFixed(4)} ZIG (gas) và ${totalOroRequired.toFixed(4)} ORO.`);
            return;
        }
    } catch (error) {
        console.error(`❌ Lỗi khi kiểm tra số dư ví ${index + 1} (có thể do proxy ${wallet.proxy}):`, error.message);
        return;
    }

    for (let liqCount = 0; liqCount < 100; liqCount++) {
        console.log(`\n=== Chu kỳ Swap thứ ${liqCount + 1} cho ví ${index + 1} ===`);
        try {
            for (let i = 0; i < 10; i++) {
                await swap(wallet.mnemonic, ZIG_AMOUNT, CONFIG.zigDenom, CONFIG.oroDenom, wallet.proxy, wallet.userAgent);
                await delay(60000);
            }

            for (let i = 0; i < 10; i++) {
                await swap(wallet.mnemonic, ORO_AMOUNT, CONFIG.oroDenom, CONFIG.zigDenom, wallet.proxy, wallet.userAgent);
                await delay(60000);
            }

            // for (let i = 0; i < 5; i++) {
            //     console.log(`\n💧 Đang thêm thanh khoản cho ví ${index + 1}...`);
            //     const poolInfo = await getPoolRatio(wallet.proxy, wallet.userAgent);
            //     if (poolInfo) {
            //         const { ratio } = poolInfo;
            //         const adjustedZig = LIQ_ORO * ratio;
            //         await addLiquidity(wallet.mnemonic, LIQ_ORO, adjustedZig, wallet.proxy, wallet.userAgent);
            //         await delay(25000);
            //     } else {
            //         console.error(`Không thể thêm thanh khoản do lỗi lấy tỷ lệ pool cho ví ${index + 1}.`);
            //         return;
            //     }
            // }
        } catch (error) {
            console.error(`❌ Lỗi trong chu kỳ swap/thêm thanh khoản cho ví ${index + 1} (có thể do proxy ${wallet.proxy}):`, error.message);
            return;
        }
    }

    console.log(`\n✅ Hoàn thành bot cho ví ${index + 1}!`);
}

async function runBot() {
    console.log(`\n🚀 Bắt đầu chạy ${WALLETS.length} ví đồng thời...`);
    await Promise.all(WALLETS.map((wallet, index) => runBotForWallet(wallet, index)));
    console.log("\n✅ Hoàn thành tất cả các ví!");
}

runBot();