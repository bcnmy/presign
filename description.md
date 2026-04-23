# Fire and Forget: How Pre-Signed Template Transactions Change the Game

*ERC-8211's runtime resolution unlocks a pattern nobody is talking about yet: sign a transaction before the funds even exist.*

---

There is a feature hiding inside ERC-8211 that is easy to miss if you focus only on the headline primitives — runtime parameter injection, inline constraints, cross-chain orchestration. It is a consequence of how those primitives compose, and it may end up being more impactful than any of them individually.

The pattern is this: **you can pre-sign a complete multi-step transaction, hand it to a relayer, and walk away — before a single token has arrived at the address that will execute it.**

No polling. No second signature. No app open on your phone. The transaction sits with the relayer, dormant, until the on-chain conditions it declares are met. Then it fires.

The ERC-8211 specification calls the enabling mechanism a *predicate entry* — a batch step with `target = address(0)` that resolves a value at runtime and asserts a constraint on it. If the constraint fails, the relayer's simulation via `eth_call` returns false, and it simply waits. When the constraint passes, the relayer submits the batch. The entire flow is gated by on-chain state, not by the user being online.

Combined with an **ephemeral smart account** — a counterfactually deployed address whose code is determined at creation time — this produces a transaction model that feels more like a standing order at a bank than anything Ethereum has offered before.

---

## The Core Pattern

Let's walk through the canonical example step by step.

### Setup

1. **Generate an ephemeral key pair.** The app creates a temporary smart account address (via `CREATE2` or ERC-7702 delegation) that exists only for this flow.

2. **Author the batch.** Using ERC-8211's encoding, the app constructs a `ComposableExecution[]` batch:

```
Entry 0 — Predicate (gate)
  Fetcher:    BALANCE(USDC, ephemeralAddress)
  Constraint: GTE(0)        // "wait until any USDC arrives"
  Target:     address(0)    // pure assertion, no call

Entry 1 — Swap
  Action:     UniswapRouter.exactInputSingle(USDC → WETH)
  Amount:     BALANCE(USDC, ephemeralAddress)   // swap whatever landed

Entry 2 — Assertion
  Fetcher:    BALANCE(WETH, ephemeralAddress)
  Constraint: GTE(minAcceptable)
  Target:     address(0)    // revert if sandwiched

Entry 3 — Supply
  Action:     AavePool.supply(WETH, BALANCE(WETH))
  Amount:     BALANCE(WETH, ephemeralAddress)    // supply the exact swap output

Entry 4 — Transfer receipt token
  Action:     aWETH.transfer(userMainAddress, BALANCE(aWETH))
  Amount:     BALANCE(aWETH, ephemeralAddress)   // send everything to user
```

3. **Sign and submit to relayer.** The user signs the batch once. The relayer receives it and begins polling — simulating the predicate via `eth_call` on every new block.

4. **Fund the address.** At any future point — seconds, hours, days later — USDC arrives at the ephemeral address. The source does not matter: a CEX withdrawal, an onramp, a friend's transfer, a bridge delivery, a payroll disbursement.

5. **Automatic execution.** The relayer's next simulation sees `balanceOf(USDC) > 0`. The predicate passes. The batch executes atomically: swap → assert → supply → transfer. The user's main wallet receives aWETH. The ephemeral address is empty. Done.

The user signed once, before the funds existed. Everything else happened without them.

---

## Why This Was Not Possible Before

Static batching (ERC-4337, EIP-5792) freezes every parameter at signing time. You must know the exact amount before you sign. If you do not know the amount — because the funds have not arrived yet — you cannot construct a valid batch. And even if you could batch calls, there is no standard mechanism to tell a relayer "simulate this and wait until the conditions are met before submitting."

The combination of three ERC-8211 features makes this pattern work:

1. **`BALANCE` fetcher** — resolves the exact token amount at execution time, not at signing time
2. **Predicate entries** — gate the entire batch on a runtime condition without calling any contract
3. **Relayer simulation model** — relayers simulate via `eth_call` and submit only when predicates pass

No new infrastructure. No custom contracts. No keeper network. The standard encoding is sufficient.

---

## Use Cases

The "fire and forget" pattern applies far more broadly than a single swap-and-supply flow. The common thread is: **the user knows what they want to happen with funds, but does not know when — or from where — those funds will arrive.**

### 1. Fiat Onramp → DeFi in One Signature

Today, onramping fiat to a DeFi position requires at least three steps: buy crypto on an onramp, wait for delivery, then manually deposit into a protocol. Users drop off at every step.

With a template transaction:

- User signs a batch: "when USDC lands here, swap to WETH, supply to Aave, send aWETH to my wallet"
- User initiates a bank transfer to a fiat onramp that delivers USDC to the ephemeral address
- The onramp takes 1-3 business days
- When delivery hits, the batch fires automatically

The user goes from bank transfer to earning Aave yield without touching their wallet again. The onramp does not need to know about DeFi. The DeFi protocol does not need to know about the onramp. The template transaction is the bridge between them.

This is also how you build a **one-click "invest" button** for non-crypto-native users: the app constructs the DeFi strategy, the user provides payment details, and the rest is automatic.

### 2. CEX Withdrawal → Immediate Strategy Execution

Every experienced DeFi user knows the workflow: withdraw from Binance to your wallet, wait 10-30 minutes for confirmations, then scramble to deploy capital before conditions change.

With a template transaction, you pre-sign the strategy *before* initiating the withdrawal. When the CEX withdrawal lands, the strategy executes in the same block the funds confirm. Zero idle time. Zero manual intervention.

This is particularly powerful for time-sensitive opportunities — a new lending market with high early yields, a token launch, or a migration window.

### 3. Cross-Chain Bridge Landing Pads

Bridging tokens is one of the most error-prone workflows in DeFi. You send tokens from Chain A, wait 7 minutes (or 7 days, depending on the bridge), then need to manually do something with them on Chain B. If the destination is a DeFi protocol, you need yet another transaction.

ERC-8211 already supports cross-chain orchestration through predicate-gated batches. The template pattern extends this: you pre-sign the Chain B batch before initiating the bridge on Chain A. The Chain B batch is predicate-gated on the bridged token balance. When it arrives — regardless of which bridge delivered it, how long it took, or what fees were deducted — the batch executes.

The user does not need to know when the bridge completes. The user does not even need to be online.

### 4. AI Agent Authorization Rails

AI agents are increasingly executing on-chain strategies, but a fundamental tension exists: agents need autonomy to act quickly, but users need guarantees that agents stay within bounds.

Template transactions offer a compelling middle ground. A user pre-signs a set of template batches that define the *shape* of what the agent is allowed to do:

- "When USDC balance exceeds 10,000, swap to WETH and supply to Aave"
- "When aWETH health factor drops below 1.5, repay debt to maintain safety"
- "When ETH price (via oracle) drops below $2,000, convert all positions to stablecoins"

The agent's role is reduced to *funding the ephemeral address* at the right time. It cannot change what happens with the funds — that is locked in the pre-signed batch, complete with inline constraints. The user defined the strategy. The agent decides when to activate it. The separation is cryptographically enforced.

This is a fundamentally different trust model than giving an agent a hot wallet. The agent never holds keys to the user's main account. The worst it can do is trigger a pre-approved strategy at a suboptimal time — it cannot deviate from the template.

### 5. OTC and P2P Settlement

Two parties agree on a trade off-chain — say, Alice will send Bob 10,000 USDC in exchange for an NFT. Trust is the perennial problem: who sends first?

With template transactions, Bob pre-signs a batch on an ephemeral address: "when USDC balance ≥ 10,000, transfer NFT #4291 to Alice's address, transfer all USDC to my address." Alice sends USDC to the ephemeral address. The moment it lands, the batch executes atomically — NFT and stablecoins swap sides in a single transaction.

Neither party needs to trust the other. Neither needs to be online simultaneously. No escrow contract. No marketplace. Just a pre-signed template and a transfer.

---

## The Architectural Insight

What makes this pattern work is a subtle but important property of ERC-8211's design: **the encoding separates intent from execution context.**

In a traditional transaction, the "what" and the "when" are fused. You construct the calldata (what) and submit it (when) in a single action. If you want different timing, you need a different mechanism — a keeper, a cron job, a bot.

ERC-8211 decouples them. The batch encoding fully specifies the "what" — including runtime-resolved amounts and safety constraints. The predicate entry specifies the "when" — a condition on chain state. The relayer handles the "how" — simulating and submitting. These three concerns are independent.

This means:

- **The user does not need to be online when funds arrive.** The relayer monitors.
- **The user does not need to know the exact amount.** The `BALANCE` fetcher resolves it.
- **The user does not need to trust the relayer with strategy design.** The batch is signed and immutable.
- **The relayer does not need to be trusted with funds.** It can only submit the pre-signed batch, not modify it.
- **The funding source does not need to know about the strategy.** It just sends tokens to an address.

Every participant in the flow has a minimal trust surface. The user trusts the encoding they signed. The relayer trusts that valid simulations lead to valid executions. The funding source trusts nothing — it just sends tokens.

---

## What This Means

"Fire and forget" transactions do not exist on Ethereum today. Every multi-step flow requires the user to be present at execution time, or delegates execution to a system that holds keys and must be fully trusted.

ERC-8211's combination of runtime resolution, predicate gating, and inline constraints enables a new class of interaction: **sign your strategy, fund it whenever, and it executes itself.** The user becomes a strategist, not an operator.

This is not an incremental improvement to transaction batching. It is a new primitive — and it will change how onramps work, how agents operate, how cross-chain flows feel, how OTC trades settle, and how DeFi reaches users who refuse to babysit wallets.

The transactions of the future are already signed. They are just waiting for their moment.

---

*ERC-8211 is in Draft status. The specification is at [erc8211.com](https://www.erc8211.com/) and the ERC pull request at [ethereum/ERCs #1638](https://github.com/ethereum/ERCs/pull/1638).*