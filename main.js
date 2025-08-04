const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { SigningCosmWasmClient, CosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { calculateFee, GasPrice } = require('@cosmjs/stargate');
const http = require('http');

const PORT = process.env.PORT || 3000;
// Lấy URL của app từ Render dashboard
const APP_URL = 'https://oro-32z7.onrender.com';

// Ping mỗi 10 phút để không sleep
setInterval(async () => {
    try {
        const response = await fetch(APP_URL);
        console.log(`🏓 Keep-alive: ${new Date().toLocaleString()}`);
    } catch (error) {
        console.log('❌ Ping failed:', error.message);
    }
}, 10 * 60 * 1000); // 10 phút
// Tạo HTTP server đơn giản
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OROSWAP BOT is running!');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
console.clear();
console.log("\x1b[35m%s\x1b[0m", "============================================");
console.log("\x1b[36m%s\x1b[0m", "      OROSWAP BOT - VÍ KEPLR/LEAP       ");
console.log("\x1b[36m%s\x1b[0m", "               VELHUST                   ");
console.log("\x1b[35m%s\x1b[0m", "============================================\n");

const MNEMONIC = `
wealth option session shy tube chef traffic seed grow word crack almost
`.trim();

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
    process.stdout.write(`\r⏳ Đang chờ ${ms / 1000} giây... `);
    await new Promise(res => setTimeout(res, ms));
    console.log("✅ Hoàn thành chờ");
};


async function getBalance(mnemonic, denom) {
    try {
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
        const [account] = await wallet.getAccounts();
        const client = await CosmWasmClient.connect(CONFIG.rpcEndpoint);
        const balance = await client.getBalance(account.address, denom);
        return { address: account.address, amount: balance.amount, formatted: Number(balance.amount) / 1e6 };
    } catch (e) {
        throw new Error(`Không thể lấy số dư: ${e.message}`);
    }
}

async function getBeliefPrice(denom, amount, retries = 3, delayMs = 90000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const client = await CosmWasmClient.connect(CONFIG.rpcEndpoint);
            const sim = await client.queryContractSmart(CONFIG.swapContract, {
                simulation: {
                    offer_asset: {
                        amount,
                        info: { native_token: { denom: denom } }
                    }
                }
            });

            // Kiểm tra sim.return_amount có hợp lệ không
            if (!sim.return_amount || BigInt(sim.return_amount) <= 0) {
                throw new Error("Giá trị return_amount không hợp lệ hoặc bằng 0");
            }

            const beliefPrice = (BigInt(amount) * BigInt(1e6)) / BigInt(sim.return_amount);
            return (Number(beliefPrice) / 1e6).toFixed(18);
        } catch (e) {
            console.warn(`⚠️ Lỗi lấy belief price (lần ${attempt}/${retries}): ${e.message}`);
            if (attempt < retries) {
                console.log(`⏳ Thử lại sau ${delayMs / 1000} giây...`);
                await new Promise(res => setTimeout(res, delayMs));
                continue;
            } else {
                console.error(`❌ Không thể lấy belief price sau ${retries} lần thử: ${e.message}`);
                return null; // Trả về null thay vì throw để không dừng chương trình
            }
        }
    }
}

async function getPoolRatio() {
    try {
        const client = await CosmWasmClient.connect(CONFIG.rpcEndpoint);
        const poolInfo = await client.queryContractSmart(CONFIG.swapContract, { pool: {} });

        // Tìm tài sản ZIG và ORO
        const zigAsset = poolInfo.assets.find(asset => asset.info.native_token?.denom === CONFIG.zigDenom);
        const oroAsset = poolInfo.assets.find(asset => asset.info.native_token?.denom === CONFIG.oroDenom);

        // Kiểm tra xem tài sản có tồn tại và có amount hợp lệ không
        if (!zigAsset || !oroAsset || !zigAsset.amount || !oroAsset.amount) {
            throw new Error("Không tìm thấy tài sản ZIG hoặc ORO trong pool hoặc amount không hợp lệ");
        }

        const zigReserve = Number(zigAsset.amount) / 1e6;
        const oroReserve = Number(oroAsset.amount) / 1e6;

        // Kiểm tra giá trị hợp lệ
        if (isNaN(zigReserve) || isNaN(oroReserve) || zigReserve <= 0) {
            throw new Error("Giá trị reserve không hợp lệ hoặc bằng 0");
        }

        const ratio = oroReserve / zigReserve; // Tỷ lệ ORO/ZIG
        console.log(`T tỷ lệ pool hiện tại: ${oroReserve} ORO / ${zigReserve} ZIG = ${ratio} ORO/ZIG`);
        return { zigReserve, oroReserve, ratio };
    } catch (e) {
        console.error("Không thể lấy thông tin pool:", e.message);
        return null;
    }
}

async function swap(mnemonic, amount, fromDenom, toDenom) {
    try {
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
        const [account] = await wallet.getAccounts();
        const client = await SigningCosmWasmClient.connectWithSigner(CONFIG.rpcEndpoint, wallet, {
            gasPrice: CONFIG.gasPrice, chainId: CONFIG.chainId
        });

        const baseAmount = Math.floor(amount * 1e6).toString();
        const beliefPrice = await getBeliefPrice(fromDenom, baseAmount);
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
        console.log(`\n✅ Swap ${fromName} → ${toName} thành công! TX: ${result.transactionHash}`);
        console.log(`🔍 https://zigscan.org/tx/${result.transactionHash}`);
    } catch (e) {
        console.error(`❌ Swap thất bại:`, e.message);
    }
}

async function addLiquidity(mnemonic, amountUoro, amountUzig) {
    try {
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
        const [account] = await wallet.getAccounts();
        const client = await SigningCosmWasmClient.connectWithSigner(CONFIG.rpcEndpoint, wallet, {
            gasPrice: CONFIG.gasPrice, chainId: CONFIG.chainId
        });

        // Kiểm tra số dư
        const zigBalance = await getBalance(MNEMONIC, CONFIG.zigDenom);
        const oroBalance = await getBalance(MNEMONIC, CONFIG.oroDenom);
        if (zigBalance.formatted < amountUzig || oroBalance.formatted < amountUoro) {
            throw new Error(`Số dư không đủ: Cần ${amountUzig} ZIG và ${amountUoro} ORO`);
        }

        // Lấy tỷ lệ pool mới nhất
        const poolInfo = await getPoolRatio();
        if (!poolInfo) {
            throw new Error("Không thể lấy thông tin pool");
        }
        const { ratio } = poolInfo;

        // Kiểm tra tỷ lệ hợp lệ
        if (isNaN(ratio) || ratio <= 0) {
            throw new Error("Tỷ lệ pool không hợp lệ");
        }

        const adjustedZig = amountUoro * ratio; // Cập nhật lượng ZIG dựa trên tỷ lệ mới nhất
        console.log(`Cung cấp thanh khoản: ${amountUoro} ORO và ${adjustedZig.toFixed(6)} ZIG`);

        // Chuyển đổi sang micro-unit
        const uoroAmount = Math.floor(amountUoro * 1e6).toString();
        const uzigAmount = Math.floor(adjustedZig * 1e6).toString();

        // Kiểm tra uzigAmount hợp lệ
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
                slippage_tolerance: "0.5" // Tăng lên 20% để giảm lỗi trượt giá
            }
        };

        const funds = [
            { denom: CONFIG.oroDenom, amount: uoroAmount },
            { denom: CONFIG.zigDenom, amount: uzigAmount }
        ];

        const fee = calculateFee(500000, CONFIG.gasPrice);

        const result = await client.execute(account.address, CONFIG.swapContract, msg, fee, "Swap", funds);

        console.log(`\n✅ Cung cấp thanh khoản cặp ORO/ZIG thành công! TX: ${result.transactionHash}`);
        console.log(`🔍 https://zigscan.org/tx/${result.transactionHash}`);
    } catch (err) {
        console.error("❌ Thêm thanh khoản thất bại:", err.message);
    }
}

async function runBot() {
    // Kiểm tra mnemonic hợp lệ
    try {
        await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: "zig" });
    } catch (error) {
        console.error("\x1b[31m%s\x1b[0m", "❌ Mnemonic không hợp lệ trong file phrase.txt: ", error.message);
        return;
    }    

    for (let liqCount = 0; liqCount < 1000000; liqCount++) {
        console.log(`\n=== Chu kỳ Swap thứ ${liqCount + 1} ===`);
        // Swap ZIG -> ORO
        for (let i = 0; i < 10; i++) {
            await swap(MNEMONIC, ZIG_AMOUNT, CONFIG.zigDenom, CONFIG.oroDenom);
            await delay(90000);
        }

        // Swap ORO -> ZIG
        for (let i = 0; i < 10; i++) {
            await swap(MNEMONIC, ORO_AMOUNT, CONFIG.oroDenom, CONFIG.zigDenom);
            await delay(90000);
        }

        // // Thêm thanh khoản
        // for (let i = 0; i < 5; i++) {
        //     console.log("\n💧 Đang thêm thanh khoản...");
        //     const poolInfo = await getPoolRatio();
        //     if (poolInfo) {
        //         const { ratio } = poolInfo;
        //         const adjustedZig = LIQ_ORO * ratio; // Tính lượng ZIG cần dựa trên tỷ lệ pool
        //         await addLiquidity(MNEMONIC, LIQ_ORO, adjustedZig);
        //         await delay(25000);
        //     } else {
        //         console.error("Không thể thêm thanh khoản do lỗi lấy tỷ lệ pool.");
        //         return;
        //     }
        // }
    }

    console.log("\n✅ Hoàn thành bot!");
}

runBot();
