import { readFileSync, promises, existsSync, writeFileSync } from "fs";
import {
  getUserInfo,
  getDir,
  logIntro,
  sleep,
  logWork,
  decrypt,
} from "./utils/index.js";
import consoleStamp from "console-stamp";
import {
  createPublicClient,
  http,
  getContract,
  createWalletClient,
  encodeFunctionData,
  parseGwei,
  decodeFunctionData,
  formatEther,
} from "viem";
import { arbitrum } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import chalk from "chalk";
import pkg from "lodash";
import readlineSync from "readline-sync";
import { couldBeSold, getMaxPrice } from "./strategy/index.js";
import {
  BOT_JUDGED_NONCE,
  couldBeBought,
  isWhitelisted,
  shouldBuy,
  shouldFetchPrice,
  shouldFetchTwitterInfo,
} from "./strategy/buy.js";
import { shouldSell } from "./strategy/index.js";

const { throttle } = pkg;
const wallet = JSON.parse(readFileSync(getDir("wallet.json"), "utf8"));
const bots = JSON.parse(readFileSync(getDir("bots.json"), "utf8"));
const abi = JSON.parse(readFileSync(getDir("abi.json"), "utf-8"));
const contractAddress = "0x87da6930626Fe0c7dB8bc15587ec0e410937e5DC";
const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(),
});
const contract = getContract({
  address: contractAddress,
  abi: abi,
  // @ts-ignore
  publicClient: publicClient,
});
let recentActions = [];

let lastAction;

let bridgedAmountMap = {};

const main = async (wallet) => {
  const client = createWalletClient({
    account: privateKeyToAccount(wallet.pk),
    chain: arbitrum,
    transport: http(),
  });

  const gasLimit = "400000";
  const maxBuyPrice = getMaxPrice();

  let nonce = 56;
  let ETH_USCT_Rate = 1600;
  let unwatch;
  let buying = false;
  let lastActivity;
  let buyIntervalId;
  let sellIntervalId;
  let selling = false;
  let twitterInfoMap = {};

  const buyShare = async (
    value,
    subjectAddress,
    username,
    ethPrice,
    amount = 1
  ) => {
    if (buying) return;
    await refreshNonce();
    buying = true;
    const data = encodeFunctionData({
      abi: abi,
      functionName: "buyShares",
      args: [subjectAddress, amount],
    });
    const txParams = {
      value: value,
      data: data,
      to: contractAddress,
      nonce: nonce++,
    };
    try {
      const hash = await client.sendTransaction(txParams);
      console.log(`Sent tx > ${hash}`);
      const transaction = await publicClient.waitForTransactionReceipt({
        confirmations: 2,
        hash,
      });

      console.log(
        chalk[transaction.status === "success" ? "green" : "red"](
          `Buy ${subjectAddress} ${transaction.status}`
        )
      );
      buying = false;
      if (transaction.status === "success") {
        updateHoldings(subjectAddress, ethPrice, username);
        console.log(chalk.green(`https://twitter.com/${username}`));
      }
    } catch (error) {
      buying = false;
      console.log("error", error.shortMessage);
    }
  };

  const updateHoldings = (subjectAddress, ethPrice, username) => {
    // 读取holdings.json内容
    let holdings = [];
    if (existsSync(getDir("holdings.json"))) {
      const rawData = readFileSync(getDir("holdings.json"), "utf-8");
      holdings = JSON.parse(rawData);
    }

    // 查找是否有对应的share
    const existingShare = holdings.find((h) => h.share === subjectAddress);

    if (existingShare) {
      // 如果存在，更新balance和price
      existingShare.balance += 1;
      existingShare.price += ethPrice;
    } else {
      // 如果不存在，添加新的记录
      const newShare = {
        share: subjectAddress,
        balance: 1,
        price: ethPrice,
        username: username,
        twitterUrl: `https://twitter.com/${username}`,
      };
      holdings.push(newShare);
    }

    // 保存回holdings.json
    writeFileSync(
      getDir("holdings.json"),
      JSON.stringify(holdings, null, 2),
      "utf-8"
    );
  };

  const refreshNonce = async () => {
    twitterInfoMap = {};
    try {
      console.log("refresh nonce...");
      const transactionCount = await publicClient.getTransactionCount({
        address: wallet.address,
      });
      nonce = transactionCount;
    } catch (error) {
      await sleep(2);
      await refreshNonce();
    }
  };

  const getRecentActions = async () => {
    try {
      const res = await axios({
        method: "get",
        url: "https://api.post.tech/wallet-post/wallet/get-recent-action",
        headers: {
          accept: "application/json",
          "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          authorization: wallet.authorization,
          "if-none-match": 'W/"qb4d593gen1u0o"',
          "sec-ch-ua":
            '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        withCredentials: true,
        timeout: 3000,
      });
      const { data } = res.data;
      const sliceData = data.slice(0, 10);
      if (!lastAction) {
        lastAction = sliceData[0];
        recentActions = sliceData;
      } else {
        const previousTopActionIndex = sliceData.findIndex(
          (f) => f.txHash === lastAction.txHash
        );
        if (previousTopActionIndex > -1) {
          recentActions = sliceData.slice(0, previousTopActionIndex);
        } else {
          recentActions = sliceData;
        }
      }
    } catch (error) {
      await sleep(3);
      await getRecentActions();
    }
  };

  const getBuyPrice = async (subjectAddress, amount = 1) => {
    console.log(chalk.gray("get buy price...", subjectAddress));
    try {
      const price = await contract.read.getBuyPriceAfterFee({
        args: [subjectAddress, amount],
      });
      return price > 0 ? price : await getBuyPrice(subjectAddress, amount);
    } catch (error) {
      console.log("get buy price failed", error.message);
      return await getBuyPrice(subjectAddress, amount);
    }
  };

  const checkIfBuy = async () => {
    for (let index = 0; index < recentActions.length; index++) {
      const start = Date.now();
      const action = recentActions[index];
      if (!action.txHash) {
        return;
      }
      const username = action.subject.user_name || action.subject.userName;
      const price = action.value;
      const whitelistedUser = isWhitelisted({
        username: username,
      });
      const twitterInfo = {};
      const shareInfo = {};
      shareInfo.username = username;
      shareInfo.price = price;

      if (!whitelistedUser) {
        const userInfo = await getUserInfo(username);
        twitterInfo.followers = userInfo.followers_count;
        twitterInfo.posts = userInfo.statuses_count;
      }
      const transaction = await publicClient.getTransaction({
        hash: action.txHash,
      });
      const { args } = decodeFunctionData({
        abi: abi,
        data: transaction.input,
      });
      shareInfo.subject = args[0].toString();
      console.log(
        chalk.cyan(
          JSON.stringify({
            ...twitterInfo,
            ...shareInfo,
            duration: `${(Date.now() - start) / 1000}s`,
          })
        )
      );
      const checkFetchPrice = shouldFetchPrice(twitterInfo, shareInfo);
      if (checkFetchPrice) {
        const lastPrice = await getBuyPrice(
          shareInfo.subject,
          whitelistedUser && whitelistedUser?.buyAmount
            ? whitelistedUser?.buyAmount
            : 1
        );
        const lastEthPrice = parseFloat(formatEther(lastPrice));
        shareInfo.price = lastEthPrice;

        if (
          couldBeBought(
            {
              subject: shareInfo.subject,
              trader: transaction.from,
              isBuy: action.action === "buy",
            },
            bots
          ) &&
          shouldBuy(twitterInfo, shareInfo)
        ) {
          logWork({
            walletAddress: wallet.address,
            actionName: "buy",
            subject: `${shareInfo.subject} - ${shareInfo.username}`,
            price: lastEthPrice.toString(),
          });
          await buyShare(
            lastPrice,
            shareInfo.subject,
            shareInfo.username,
            lastEthPrice,
            whitelistedUser && whitelistedUser?.buyAmount
              ? whitelistedUser?.buyAmount
              : 1
          );
        }
      }
    }
  };

  const getSellPrice = async (subjectAddress, amount = 1) => {
    const price = await contract.read.getSellPriceAfterFee({
      args: [subjectAddress, amount],
    });
    return price;
  };

  const checkIfOwn = async (subjectAddress) => {
    try {
      const balance = await contract.read.sharesBalance({
        args: [subjectAddress, wallet.address],
      });
      if (balance > 0n) {
        return balance;
      } else {
        console.log("not own");
        return false;
      }
    } catch (error) {
      await sleep(3);
      return await checkIfOwn(subjectAddress);
    }
  };

  const sellShare = async (subjectAddress, own = 1) => {
    try {
      await refreshNonce();
      const data = encodeFunctionData({
        abi: abi,
        functionName: "sellShares",
        args: [subjectAddress, own],
      });
      const txParams = {
        value: 0,
        data: data,
        to: contractAddress,
        // gasPrice: parseGwei("0.15"),
        // gasLimit,
        nonce: nonce++,
      };
      const hash = await client.sendTransaction(txParams);
      console.log(`Sent tx > ${hash}`);
      const transaction = await publicClient.waitForTransactionReceipt({
        hash,
      });
      console.log(
        chalk[transaction.status === "success" ? "green" : "red"](
          `Sell ${subjectAddress} ${transaction.status}`
        )
      );
      if (transaction.status === "success") {
        return true;
      } else {
        return false;
      }
    } catch (error) {
      console.log(error);
      return false;
    }
  };

  const trySell = async (shareObj, calculator) => {
    try {
      const price = await getSellPrice(shareObj.share, shareObj.balance);
      console.log(JSON.stringify(shareObj));
      const ethPrice = parseFloat(formatEther(price).substring(0, 8)) * 0.9;
      const costEthPrice = shareObj.price;
      const profit =
        parseFloat(((ethPrice - costEthPrice) * ETH_USCT_Rate).toFixed(2)) -
        0.8;
      // 0.8 is gas fee, about 0.8 USD
      console.log(
        chalk[profit > 0 ? "green" : "yellow"](`profit: ${profit} USDT`)
      );
      const own = await checkIfOwn(shareObj.share);
      calculator.sum += profit;
      calculator.total += ethPrice;
      if (profit > 0) {
        calculator.positive += profit;
      } else {
        calculator.negative += profit;
      }
      if (!own) {
        return false;
      }
      if (
        ethPrice > 0 &&
        couldBeSold(wallet.address, shareObj.share) &&
        shouldSell(shareObj.share, profit)
      ) {
        clearBuyInternal();
        console.log("selling", shareObj.share, "price", ethPrice);
        const isSold = await sellShare(shareObj.share, own);
        return isSold;
      } else {
        return false;
      }
    } catch (error) {
      console.log(
        chalk.red(`sell ${shareObj.balance} share failed: ${shareObj.share}`)
      );
    }
  };

  const checkIfSell = async () => {
    // 读取holdings.json内容
    let holdings = [];
    if (existsSync(getDir("holdings.json"))) {
      const rawData = readFileSync(getDir("holdings.json"), "utf-8");
      holdings = JSON.parse(rawData);
    }
    let calculator = { sum: 0, positive: 0, negative: 0, total: 0 };
    for (let index = 0; index < holdings.length; index++) {
      selling = true;
      const shareObj = holdings[index];
      //   const sellPrice = await getSellPrice(shareObj.share, shareObj.balance);

      const isSold = await trySell(shareObj, calculator);
      if (isSold) {
        holdings = holdings.filter((item) => item.share !== shareObj.share);
        index = index - 1;
        writeFileSync(
          getDir("holdings.json"),
          JSON.stringify(holdings, null, 2),
          "utf-8"
        );
      }
    }
    console.log(chalk.cyan(JSON.stringify(calculator)));
    if (!buyIntervalId) {
      await getRecentActions();
      await checkIfBuy();
      intervalBuy();
    }
  };

  const clearBuyInternal = () => {
    if (buyIntervalId) {
      clearInterval(buyIntervalId);
      buyIntervalId = null;
    }
  };

  const clearSellInterval = () => {
    if (sellIntervalId) {
      clearInterval(sellIntervalId);
      sellIntervalId = null;
    }
  };

  const intervalBuy = () => {
    buyIntervalId = setInterval(
      async () => {
        if (buying) {
          return;
        }
        await getRecentActions();
        await checkIfBuy();
      },
      process.env.useTwitterAPI ? 5000 : 25000
    );
  };

  const intervalSell = () => {
    sellIntervalId = setInterval(() => {
      checkIfSell();
    }, 60 * 1000);
  };
  const execute = async () => {
    clearBuyInternal();
    clearSellInterval();
    await refreshNonce();
    await checkIfSell();

    await getRecentActions();
    await checkIfBuy();

    intervalBuy();
    intervalSell();

    setInterval(() => {
      twitterInfoMap = {};
    }, 10 * 60 * 1000);
  };

  execute();
};

logIntro();
consoleStamp(console, {
  format: ":date(yyyy/mm/dd HH:MM:ss)",
});
// const password1 = readlineSync.question("Password1: ", {
//   hideEchoBack: true, // The typed text on screen is hidden by `*` (default).
// });
// const password2 = readlineSync.question("Password2: ", {
//   hideEchoBack: true, // The typed text on screen is hidden by `*` (default).
// });
// process.env.pw1 = password1;
// process.env.pw2 = password2;
process.env.useTwitterAPI = wallet.useTwitterAPI;
main({
  ...wallet,
});
