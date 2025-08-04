const fs = require("fs");
const path = require("path");
const { SigningCosmWasmClient, CosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { calculateFee, GasPrice } = require('@cosmjs/stargate');

console.clear();
console.log("\x1b[35m%s\x1b[0m", "============================================");
console.log("\x1b[36m%s\x1b[0m", "   OROSWAP BOT - NHIỀU VÍ TUẦN TỰ        ");
console.log("\x1b[36m%s\x1b[0m", "               VELHUST                   ");
console.log("\x1b[35m%s\x1b[0m", "============================================\n");

// Đọc mnemonic từ file phrase.txt
const loadWallet = () => {
    try {
        const mnemonic = fs.readFileSync(path.join(__dirname, "phrase.txt"), "utf8").trim();
        console.log(`📁 Đã tải ví từ file phrase.txt`);
        return mnemonic;
    } catch (error) {
        console.error("❌ Không thể đọc file phrase.txt.");
        process.exit(1);
    }
};

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

const delay = async (ms) => {
    for (let i = ms / 1000; i > 0; i--) {
        process.stdout.write(`\r⏳ Đang chờ ${i} giây... `);
        await new Promise(res => setTimeout(res, 1000));
    }
    process.stdout.write("\r\n");
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

async function getBeliefPrice(denom, amount) {
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
        const beliefPrice = (BigInt(amount) * BigInt(1e6)) / BigInt(sim.return_amount);
        return (Number(beliefPrice) / 1e6).toFixed(18);
    } catch (e) {
        throw new Error(`Không thể lấy belief price: ${e.message}`);
    }
}

async function getPoolRatio() {
    try {
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
        console.log(`[Ví] Tỷ lệ pool hiện tại: ${oroReserve} ORO / ${zigReserve} ZIG = ${ratio} ORO/ZIG`);
        return { zigReserve, oroReserve, ratio };
    } catch (e) {
        console.error("[Ví] Không thể lấy thông tin pool:", e.message);
        return null;
    }
}

async function swap(mnemonic, amount, fromDenom, toDenom, walletIndex) {
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
        console.log(`\n[Ví ${walletIndex}] ✅ Swap ${fromName} → ${toName} thành công! TX: ${result.transactionHash}`);
        console.log(`[Ví ${walletIndex}] 🔍 https://zigscan.org/tx/${result.transactionHash}`);
    } catch (e) {
        console.error(`[Ví ${walletIndex}] ❌ Swap thất bại:`, e.message);
    }
}

async function addLiquidity(mnemonic, amountUoro, walletIndex) {
    try {
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
        const [account] = await wallet.getAccounts();
        const client = await SigningCosmWasmClient.connectWithSigner(CONFIG.rpcEndpoint, wallet, {
            gasPrice: CONFIG.gasPrice, chainId: CONFIG.chainId
        });

        const zigBalance = await getBalance(mnemonic, CONFIG.zigDenom);
        const oroBalance = await getBalance(mnemonic, CONFIG.oroDenom);
        if (oroBalance.formatted < amountUoro) {
            throw new Error(`Số dư không đủ: Cần ${amountUoro} ORO`);
        }

        const poolInfo = await getPoolRatio();
        if (!poolInfo) {
            throw new Error("Không thể lấy thông tin pool");
        }
        const { ratio } = poolInfo;

        if (isNaN(ratio) || ratio <= 0) {
            throw new Error("Tỷ lệ pool không hợp lệ");
        }

        const adjustedZig = amountUoro * ratio;
        console.log(`[Ví ${walletIndex}] Cung cấp thanh khoản: ${amountUoro} ORO và ${adjustedZig.toFixed(6)} ZIG`);

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

        const result = await client.execute(account.address, CONFIG.swapContract, msg, fee, "Swap", funds);

        console.log(`\n[Ví ${walletIndex}] ✅ Cung cấp thanh khoản cặp ORO/ZIG thành công! TX: ${result.transactionHash}`);
        console.log(`[Ví ${walletIndex}] 🔍 https://zigscan.org/tx/${result.transactionHash}`);
    } catch (err) {
        console.error(`[Ví ${walletIndex}] ❌ Thêm thanh khoản thất bại:`, err.message);
    }
}

async function runBotForWallet(mnemonic, walletIndex) {
    console.log(`\n🚀 Bắt đầu chạy bot cho Ví ${walletIndex}`);
    
    try {
        const zigBalance = await getBalance(mnemonic, CONFIG.zigDenom);
        const oroBalance = await getBalance(mnemonic, CONFIG.oroDenom);
        console.log(`💰 Số dư ví: ${zigBalance.formatted} ZIG, ${oroBalance.formatted} ORO`);
        
        const totalSwaps = 20 * (10 + 10);
        const totalAddLiquidity = 20 * 10;
        const totalZigRequired = (20 * 10 * ZIG_AMOUNT) + (20 * 10 * LIQ_ORO * 4);
        const totalOroRequired = (20 * 10 * ORO_AMOUNT) + (20 * 10 * LIQ_ORO);
        const totalGasFee = (totalSwaps * 320000 * 0.025 / 1e6) + (totalAddLiquidity * 500000 * 0.025 / 1e6);
        
        console.log(`\n🔍 Tổng token cần: ${totalZigRequired.toFixed(4)} ZIG, ${totalOroRequired.toFixed(4)} ORO`);
        console.log(`🔍 Ước tính phí gas: ${totalGasFee.toFixed(4)} ZIG`);
        
        if (zigBalance.formatted < totalZigRequired + totalGasFee || oroBalance.formatted < totalOroRequired) {
            console.log("\x1b[31m%s\x1b[0m", `❌ Số dư ví không đủ! Cần ít nhất ${totalZigRequired.toFixed(4)} ZIG + ${totalGasFee.toFixed(4)} ZIG (gas) và ${totalOroRequired.toFixed(4)} ORO.`);
            return;
        }
    } catch (error) {
        console.error(`[Ví ${walletIndex}] ❌ Không thể kiểm tra balance:`, error.message);
        return;
    }

    for (let liqCount = 0; liqCount < 20; liqCount++) {
        console.log(`\n[Ví ${walletIndex}] === Chu kỳ Swap thứ ${liqCount + 1} ===`);
        
        for (let i = 0; i < 10; i++) {
            await swap(mnemonic, ZIG_AMOUNT, CONFIG.zigDenom, CONFIG.oroDenom, walletIndex);
            await delay(10000);
        }

        for (let i = 0; i < 10; i++) {
            await swap(mnemonic, ORO_AMOUNT, CONFIG.oroDenom, CONFIG.zigDenom, walletIndex);
            await delay(10000);
        }

        console.log(`\n[Ví ${walletIndex}] 💧 Đang thêm thanh khoản...`);
        for (let i = 0; i < 10; i++) {
            const poolInfo = await getPoolRatio();
            if (poolInfo) {
                const { ratio } = poolInfo;
                await addLiquidity(mnemonic, LIQ_ORO, walletIndex);
                await delay(10000);
            } else {
                console.error(`[Ví ${walletIndex}] Không thể thêm thanh khoản do lỗi lấy tỷ lệ pool.`);
                return;
            }
        }
    }
    
    console.log(`\n✅ Hoàn thành bot cho Ví ${walletIndex}`);
}

async function runMultiWalletBot() {
    const mnemonic = loadWallet();
    
    if (!mnemonic) {
        console.error("❌ Không có mnemonic được tìm thấy trong file phrase.txt");
        return;
    }

    console.log(`\n🎯 Bắt đầu chạy bot cho 1 ví tuần tự...`);
    
    await runBotForWallet(mnemonic, 1);
    
    console.log(`\n🎉 Hoàn thành!`);
}

runMultiWalletBot();