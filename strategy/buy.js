import { STRATEGY_OPERATORS, STRATEGY_TYPES } from "../constants/index.js";
import chalk from "chalk";
import { readFileSync, promises, existsSync, writeFileSync } from "fs";
import { getDir } from "../utils/getDir.js";

/**
 * 购买策略
 * 涉及价格，金额的单位统一为 ETH
 */
const BuyStrategy = {
  operator: STRATEGY_OPERATORS.OR,
  conditions: [
    {
      operator: STRATEGY_OPERATORS.AND,
      conditions: [
        // 价格
        { type: STRATEGY_TYPES.KEY_PRICE, value: 0.00008 },
        // 推特关注数
        { type: STRATEGY_TYPES.TWITTER_FOLLOWERS, value: 500 },
        // 推特文章数
        { type: STRATEGY_TYPES.TWITTER_POSTS, value: 20 },
      ],
    },
    {
      operator: STRATEGY_OPERATORS.AND,
      conditions: [
        // 价格
        { type: STRATEGY_TYPES.KEY_PRICE, value: 0.0002 },
        // 推特关注数
        { type: STRATEGY_TYPES.TWITTER_FOLLOWERS, value: 1000 },
        // 推特文章数
        { type: STRATEGY_TYPES.TWITTER_POSTS, value: 100 },
      ],
    },
    {
      // 白名单
      type: STRATEGY_TYPES.WHITELIST,
      whitelist: [
        // { username: "zmzimpl", maxPrice: 0.0005, buyAmount: 1 },
        // { username: "elonmusk", maxPrice: 0.05, buyAmount: 2 },
      ],
    },
  ],
  // 如果一个 key 是由 bots 列表内的地址出售的，不考虑买入
  skipSoldByBot: true,
  disabledMultiBuy: true,
};
/** 不自动购买的地址, 可以把一些假号或者买过了知道会亏的放这里面 */
const notBuyList = [];

export const BOT_JUDGED_NONCE = 300;

export const couldBeBought = ({ subject, trader, isBuy }, bots) => {
  const blockList = notBuyList.concat(bots);
  const isInBlockList = blockList.some((address) => {
    const isBlock = address.toLowerCase() === subject.toLowerCase();
    const isSoldByBot =
      BuyStrategy.skipSoldByBot &&
      !isBuy &&
      trader &&
      trader.toLowerCase() === address.toLowerCase();
    if (isBlock) {
      console.log(chalk.yellow(`${subject} in block list, skip...`));
    }
    if (isSoldByBot) {
      console.log(chalk.yellow(`bot ${subject} sold, skip...`));
    }
    return isBlock || isSoldByBot;
  });

  let holdings = [];
  if (existsSync(getDir("holdings.json"))) {
    const rawData = readFileSync(getDir("holdings.json"), "utf-8");
    holdings = JSON.parse(rawData);
  }
  const alreadyBuy =
    BuyStrategy.disabledMultiBuy && holdings.find((f) => f.share === subject);

  console.log("isAlreadyBuy", alreadyBuy);
  return !isInBlockList && !alreadyBuy;
};

const evaluateCondition = (condition, twitterInfo, shareInfo) => {
  switch (condition.type) {
    case STRATEGY_TYPES.TWITTER_FOLLOWERS:
      return twitterInfo.followers >= condition.value;
    case STRATEGY_TYPES.TWITTER_POSTS:
      return twitterInfo.posts >= condition.value;
    case STRATEGY_TYPES.KEY_PRICE:
      return shareInfo.price < condition.value;
    case STRATEGY_TYPES.WHITELIST:
      const user = condition.whitelist.find(
        (u) => u.username === shareInfo.username
      );
      return user && shareInfo.price <= user.maxPrice;
    default:
      throw new Error("Unknown condition type");
  }
};

const evaluateStrategy = (strategy, twitterInfo, shareInfo) => {
  if (strategy.operator) {
    if (strategy.operator === STRATEGY_OPERATORS.AND) {
      return strategy.conditions.every((condition) =>
        evaluateStrategy(condition, twitterInfo, shareInfo)
      );
    } else if (strategy.operator === STRATEGY_OPERATORS.OR) {
      return strategy.conditions.some((condition) =>
        evaluateStrategy(condition, twitterInfo, shareInfo)
      );
    } else {
      throw new Error("Unknown operator");
    }
  } else {
    return evaluateCondition(strategy, twitterInfo, shareInfo);
  }
};

const extractPricesFromStrategy = (strategy) => {
  let prices = [];

  if (strategy.conditions) {
    for (let condition of strategy.conditions) {
      if (condition.type === STRATEGY_TYPES.KEY_PRICE) {
        prices.push(condition.value);
      } else if (condition.type === STRATEGY_TYPES.WHITELIST) {
        for (let user of condition.whitelist) {
          prices.push(user.maxPrice);
        }
      } else if (condition.operator) {
        // AND or OR conditions
        prices = prices.concat(extractPricesFromStrategy(condition));
      }
    }
  }

  return prices;
};

export const isWhitelisted = (shareInfo) => {
  const whitelistedUser = BuyStrategy.conditions.find(
    (condition) => condition.type === STRATEGY_TYPES.WHITELIST
  );
  if (!whitelistedUser) return false;

  const user = whitelistedUser.whitelist.find(
    (u) => u.username === shareInfo.username
  );

  return user;
};

export const shouldFetchPrice = (twitterInfo, shareInfo) => {
  return evaluateStrategy(BuyStrategy, twitterInfo, shareInfo);
};

export const shouldBuy = (twitterInfo, shareInfo) => {
  return evaluateStrategy(BuyStrategy, twitterInfo, shareInfo);
};

export const getMaxPrice = () => {
  const prices = extractPricesFromStrategy(BuyStrategy);
  return Math.max(...prices);
};

const containsTwitterConditions = (strategy) => {
  if (strategy.conditions) {
    for (let condition of strategy.conditions) {
      if (
        condition.type === STRATEGY_TYPES.TWITTER_FOLLOWERS ||
        condition.type === STRATEGY_TYPES.TWITTER_POSTS
      ) {
        return true;
      }
      if (condition.operator && containsTwitterConditions(condition)) {
        // 如果是 AND 或 OR 条件
        return true;
      }
    }
  }
  return false;
};

export const shouldFetchTwitterInfo = (accountInfo, shareInfo) => {
  return containsTwitterConditions(BuyStrategy);
};
