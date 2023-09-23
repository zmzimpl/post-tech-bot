# post-tech-bot

在 `wallet.example.json` 中填入需要的信息，`authorization` 获取见下图，找到 get-recent-action 请求，`authorization` 在右侧下拉
![](https://i.ibb.co/MG6b8R6/20230921190549.png)

推特信息获取服务已开源，国内用户推荐在海外服务器上跑
`useTwitterAPI` 默认使用开启，在编辑器下运行需要你全局代理（如果你的电脑需要VPN才能访问推特的话），可以使用 Clash 的 TUN 模式，海外用户不需要代理。
`useTwitterAPI` 设置为 `false` 也能跑，使用的是本地 puppeteer 环境，会很慢并且卡，慎用

在填好了 `wallet.example.json` 需要的信息之后，将 `wallet.example.json` 改名 `wallet.json`
将 `holdings1.json` 改名 `holdings.json`

## 自定义配置

策略关系到你的盈亏，所以请认真配置，所有的策略都可以在 `strategy/buy` `strategy/sell` 自由组合，策略不是越多越好，策略越多越严检查越费时，会影响买入效率，策略太宽松，会导致频繁买入一些低质量的 key

### 买入策略配置 `strategy/buy`

```js
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
        { username: "zmzimpl", maxPrice: 0.0005, buyAmount: 1 },
        { username: "elonmusk", maxPrice: 0.05, buyAmount: 2 },
      ],
    },
  ],
};
/** 不自动购买的地址, 可以把一些假号或者买过了知道会亏的放这里面 */
const notBuyList = [];
```

### 卖出配置 `strategy/sell`

```js
/**
 * 卖出策略
 * 利润单位为 USD
 */
const sellStrategy = {
  /**
   * 策略解释：
   * 1： 利润 > 100 USD
   * 
   * specifies：当地址 0x07698b9f3db898672fcfd97267f900df10c82706 利润超过 200 USD 才会卖出 0x07698b9f3db898672fcfd97267f900df10c82706
   */
  operator: STRATEGY_OPERATORS.OR,
  conditions: [
    // 利润大于 10 USD 才卖出
    { type: STRATEGY_TYPES.BENEFIT, value: 100 },
  ],
  specifies: [
    {
      addresses: ["0x07698b9f3db898672fcfd97267f900df10c82706"],
      strategy: {
        operator: STRATEGY_OPERATORS.AND,
        // 指定某些地址利润大于 100USD 并且持有时长超过 24 小时才卖出
        conditions: [
          { type: STRATEGY_TYPES.BENEFIT, value: 200 },
        ],
      },
    },
  ],
};

/** 不自动出售的名单 */
const notSellList = [];

```

## 脚本启动

1. 安装 [Nodejs](https://nodejs.org/en/download)
2. 使用 cmd，将路径导航到代码文件夹下，执行 `npm install`

3. 执行 `npm run start`
