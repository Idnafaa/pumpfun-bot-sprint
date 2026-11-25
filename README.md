# pumpfun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Idnafaa/pumpfun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Idnafaa/pumpfun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Tide Probe is a conservative paper-trading bot for pump.fun bonding curves. It watches each new coin's first trades and buys a small fixed stake only where real buying is already showing — price up a little on net buy volume, never after the coin already ran far — then exits every position on take-profit, stop-loss, a trailing guard, or a time stop. No averaging down, no second buy on a coin, at most five positions at once. The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout, needs no network, no keys and no environment, and is fully deterministic: the same replay always gives the same orders.

## Run it

```sh
node main.ts
```

The grader runs it as `node /bot/main.ts` (Node 22 or later runs the TypeScript as-is). It reads hello/batch/done JSON lines on stdin and writes one reply per batch on stdout.

---

<sub>Entered on [make.fun](https://make.fun/?ref=01tnmm85&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
