import { useCallback, useMemo, useRef, useState } from 'react'
import { http, erc20Abi, parseUnits, isAddress } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { base } from 'viem/chains'
import {
  createMeeClient,
  toMultichainNexusAccount,
  getMEEVersion,
  MEEVersion,
  runtimeERC20BalanceOf,
  greaterThanOrEqualTo,
} from '@biconomy/abstractjs'
import './App.css'

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const WETH_BASE = '0x4200000000000000000000000000000000000006' as const
const UNISWAP_V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481' as const
const POOL_FEE = 500
const ONE_HOUR = 60 * 60
const MEE_API_KEY = 'mee_HyAhKoEgRJLxW6QrMasGW'

const swapRouterAbi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

type Stage =
  | 'idle'
  | 'key'
  | 'account'
  | 'built'
  | 'signed'
  | 'fired'
  | 'cleared'

type LogKind = 'info' | 'ok' | 'warn' | 'err'
type LogEntry = { kind: LogKind; msg: string; ts: number }

function short(addr?: string | null, left = 6, right = 4) {
  if (!addr) return '—'
  return `${addr.slice(0, left)}…${addr.slice(-right)}`
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function App() {
  const [recipient, setRecipient] = useState('')
  const [minUsdc, setMinUsdc] = useState('0.01')
  const [stage, setStage] = useState<Stage>('idle')
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [smartAddress, setSmartAddress] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [quoteHash, setQuoteHash] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)

  const busyRef = useRef(false)
  const privKeyRef = useRef<`0x${string}` | null>(null)
  const accountRef = useRef<any>(null)
  const meeClientRef = useRef<any>(null)
  const quoteRef = useRef<any>(null)
  const stageRef = useRef<Stage>('idle')
  stageRef.current = stage

  const recipientValid = useMemo(
    () => recipient.length > 0 && isAddress(recipient),
    [recipient]
  )

  const minOk = useMemo(() => {
    const n = Number(minUsdc)
    return Number.isFinite(n) && n >= 0
  }, [minUsdc])

  const log = useCallback((kind: LogKind, msg: string) => {
    setLogs((l) => [...l, { kind, msg, ts: Date.now() }])
  }, [])

  const wipe = useCallback(() => {
    privKeyRef.current = null
    accountRef.current = null
    meeClientRef.current = null
    quoteRef.current = null
  }, [])

  // ---- work functions (no busy gating; orchestrator handles that) ----

  const doGenerate = useCallback(async () => {
    const pk = generatePrivateKey()
    privKeyRef.current = pk
    const signer = privateKeyToAccount(pk)
    log('info', `Generated ephemeral EOA ${signer.address}`)
    log('info', 'Private key held only in memory (useRef) — never rendered.')
    setStage('key')
  }, [log])

  const doInit = useCallback(async () => {
    if (!privKeyRef.current) throw new Error('no ephemeral key')
    const signer = privateKeyToAccount(privKeyRef.current)
    const account = await toMultichainNexusAccount({
      signer,
      chainConfigurations: [
        {
          chain: base,
          transport: http(),
          version: getMEEVersion(MEEVersion.V2_1_0),
        },
      ],
    })
    accountRef.current = account
    const meeClient = await createMeeClient({ account, apiKey: MEE_API_KEY })
    meeClientRef.current = meeClient
    const smartAddr = account.addressOn(base.id, true)
    setSmartAddress(smartAddr)
    log('ok', `Nexus smart account on Base: ${smartAddr}`)
    log('info', 'Counterfactual — no code deployed yet.')
    setStage('account')
  }, [log])

  const doBuild = useCallback(async () => {
    if (!accountRef.current) throw new Error('no nexus account')
    if (!recipientValid) throw new Error('recipient required')
    const account = accountRef.current
    const smart = account.addressOn(base.id, true)
    const minAmount = parseUnits(minUsdc || '0', 6)

    log('info', 'Building 3-step composable batch…')

    const approve = await account.buildComposable({
      type: 'default',
      data: {
        chainId: base.id,
        to: USDC_BASE,
        abi: erc20Abi,
        functionName: 'approve',
        args: [
          UNISWAP_V3_ROUTER,
          runtimeERC20BalanceOf({
            tokenAddress: USDC_BASE,
            targetAddress: smart,
            constraints: [greaterThanOrEqualTo(minAmount)],
          }),
        ],
      },
    })
    log('ok', '1/3 approve(USDC → Uniswap, runtimeBalance)')

    const swap = await account.buildComposable({
      type: 'default',
      data: {
        chainId: base.id,
        to: UNISWAP_V3_ROUTER,
        abi: swapRouterAbi,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: USDC_BASE,
            tokenOut: WETH_BASE,
            fee: POOL_FEE,
            recipient: smart,
            amountIn: runtimeERC20BalanceOf({
              tokenAddress: USDC_BASE,
              targetAddress: smart,
            }),
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
      },
    })
    log('ok', '2/3 Uniswap.exactInputSingle(USDC → WETH, 0.05%)')

    const sendWeth = await account.buildComposable({
      type: 'default',
      data: {
        chainId: base.id,
        to: WETH_BASE,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [
          recipient as `0x${string}`,
          runtimeERC20BalanceOf({
            tokenAddress: WETH_BASE,
            targetAddress: smart,
          }),
        ],
      },
    })
    log('ok', `3/3 WETH.transfer(${short(recipient)}, runtimeBalance)`)

    const expiry = Math.floor(Date.now() / 1000) + ONE_HOUR
    setExpiresAt(expiry)
    log(
      'ok',
      `Predicate: USDC balance ≥ ${minUsdc}. Expires ${new Date(
        expiry * 1000
      ).toLocaleTimeString()}.`
    )

    quoteRef.current = {
      instructions: [approve, swap, sendWeth],
      upperBoundTimestamp: expiry,
    }
    setStage('built')
  }, [recipient, recipientValid, minUsdc, log])

  const doFire = useCallback(async () => {
    if (!meeClientRef.current || !quoteRef.current)
      throw new Error('not built')
    const meeClient = meeClientRef.current
    try {
      log('info', 'Requesting sponsored quote from MEE node…')
      const quote = await meeClient.getQuote({
        instructions: quoteRef.current.instructions,
        sponsorship: true,
        upperBoundTimestamp: quoteRef.current.upperBoundTimestamp,
      })
      quoteRef.current.quote = quote
      log('ok', 'Gas sponsored — ephemeral account pays nothing.')
      log('ok', 'Signing batch locally with ephemeral key…')
      const { hash } = await meeClient.executeQuote({ quote })
      setQuoteHash(hash)
      log('ok', `Fired. Supertransaction: ${hash}`)
      log(
        'info',
        'Relayer will simulate on every block. The three calls execute atomically once USDC arrives.'
      )
      setStage('fired')
    } catch (e) {
      log('warn', `Relayer rejected: ${(e as Error).message}`)
      log(
        'info',
        'Signed batch is still valid; a funded relayer could submit it.'
      )
      setStage('signed')
    }
  }, [log])

  const doWipe = useCallback(async () => {
    const wasFired = stageRef.current === 'fired'
    wipe()
    log('ok', 'Ephemeral key wiped from memory. Key pair no longer exists.')
    log(
      'info',
      wasFired
        ? 'Signed batch is autonomous — relayer holds it, user walks away.'
        : 'Even without firing, the key is gone. A new session would start from scratch.'
    )
    setStage('cleared')
  }, [wipe, log])

  // ---- orchestrator: run everything end-to-end ----

  const runAll = useCallback(async () => {
    if (busyRef.current) return
    if (!recipientValid || !minOk) {
      log('warn', 'Set a valid recipient and threshold before starting.')
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      await doGenerate()
      await wait(500)
      await doInit()
      await wait(500)
      await doBuild()
      await wait(500)
      await doFire()
      await wait(900)
      await doWipe()
    } catch (e) {
      log('err', (e as Error).message)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [recipientValid, minOk, doGenerate, doInit, doBuild, doFire, doWipe, log])

  const reset = useCallback(() => {
    wipe()
    setSmartAddress(null)
    setQuoteHash(null)
    setExpiresAt(null)
    setCopied(false)
    setLogs([])
    setStage('idle')
  }, [wipe])

  const copySmart = useCallback(async () => {
    if (!smartAddress) return
    try {
      await navigator.clipboard.writeText(smartAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* noop */
    }
  }, [smartAddress])

  const steps: { key: Stage; label: string; hint: string }[] = [
    {
      key: 'key',
      label: '1. Generate ephemeral key',
      hint: 'viem · generatePrivateKey() → memory only',
    },
    {
      key: 'account',
      label: '2. Initialize Nexus account',
      hint: 'toMultichainNexusAccount + createMeeClient',
    },
    {
      key: 'built',
      label: '3. Build composable batch',
      hint: 'approve → swap → transfer, all runtime-resolved',
    },
    {
      key: 'fired',
      label: '4. Sign & send to relayer',
      hint: 'sponsorship: true · upperBoundTimestamp = now + 1h',
    },
    {
      key: 'cleared',
      label: '5. Wipe ephemeral key',
      hint: 'Key destroyed — transaction lives on its own',
    },
  ]

  const stageOrder: Stage[] = [
    'idle',
    'key',
    'account',
    'built',
    'signed',
    'fired',
    'cleared',
  ]
  const currentIdx = stageOrder.indexOf(stage)
  const activeStepKey: Stage | null = busy
    ? (['key', 'account', 'built', 'fired', 'cleared'] as Stage[]).find(
        (k) => stageOrder.indexOf(k) > currentIdx
      ) ?? null
    : null

  const reached = (k: Stage) => stageOrder.indexOf(stage) >= stageOrder.indexOf(k)

  const stageLabels: Record<Stage, string> = {
    idle: 'Configure',
    key: 'Key generated',
    account: 'Account ready',
    built: 'Batch built',
    signed: 'Signed',
    fired: 'Fired · relayer holding',
    cleared: 'Key wiped',
  }

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <div className="logo-dot" />
          <span>presign</span>
          <span className="brand-sub">/ fire &amp; forget</span>
        </div>
        <div className="top-right">
          <div className="status-chip">
            <span className={`status-dot s-${stage}`} />
            <span>{stageLabels[stage]}</span>
          </div>
          <div className="pill mono">Biconomy AbstractJS</div>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <h1>
            A transaction
            <br />
            <span className="accented">that waits for its funds.</span>
          </h1>
          <p className="sub">
            Pre-sign a three-call batch on an ephemeral smart account. Approve
            USDC, swap to WETH on Uniswap, send WETH to a recipient. Every
            amount resolves at execution time from live balances. When USDC
            arrives, the relayer fires it — no keys, no second signature, no
            app open.
          </p>
        </div>
        <div className="hero-stats">
          <div className="stat">
            <div className="stat-k">Chain</div>
            <div className="stat-v">Base</div>
          </div>
          <div className="stat">
            <div className="stat-k">Gas</div>
            <div className="stat-v">Sponsored</div>
          </div>
          <div className="stat">
            <div className="stat-k">Window</div>
            <div className="stat-v">1 hour</div>
          </div>
          <div className="stat">
            <div className="stat-k">Smart account</div>
            <div className="stat-v mono small">
              {short(smartAddress, 8, 6)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-k">Expires</div>
            <div className="stat-v mono small">
              {expiresAt
                ? new Date(expiresAt * 1000).toLocaleTimeString()
                : '—'}
            </div>
          </div>
        </div>
      </section>

      <main className="layout">
        <aside className="side">
          <div className="card form">
            <div className="card-title">Configure</div>
            <div className="field">
              <label>Recipient</label>
              <input
                spellCheck={false}
                className="mono"
                placeholder="0x… receives WETH"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
                disabled={
                  stage !== 'idle' && stage !== 'key' && stage !== 'account'
                }
              />
              {recipient && !recipientValid ? (
                <span className="hint err">Not a valid address</span>
              ) : (
                <span className="hint">Where the swapped WETH lands</span>
              )}
            </div>
            <div className="field">
              <label>Trigger threshold</label>
              <div className="input-suffix">
                <input
                  className="mono"
                  type="number"
                  min={0}
                  step="0.01"
                  value={minUsdc}
                  onChange={(e) => setMinUsdc(e.target.value)}
                  disabled={
                    stage !== 'idle' && stage !== 'key' && stage !== 'account'
                  }
                />
                <span>USDC</span>
              </div>
              <span className="hint">
                Relayer waits until USDC balance ≥ this
              </span>
            </div>
          </div>

          <div className="card steps-card">
            <div className="card-title">Flow</div>
            <div className="steps">
              {steps.map((s, i) => {
                const done = reached(s.key)
                const active = activeStepKey === s.key
                return (
                  <div
                    key={s.key}
                    className={`step ${done ? 'done' : ''} ${
                      active ? 'active' : ''
                    }`}
                  >
                    <div className="step-dot">
                      {done ? '✓' : active ? <span className="spin" /> : i + 1}
                    </div>
                    <div className="step-body">
                      <div className="step-label">{s.label}</div>
                      <div className="step-hint">{s.hint}</div>
                    </div>
                  </div>
                )
              })}
            </div>
            {stage === 'idle' ? (
              <button
                className="primary"
                onClick={runAll}
                disabled={busy || !recipientValid || !minOk}
              >
                {busy ? 'running…' : 'Start the flow'}
              </button>
            ) : stage === 'cleared' ? (
              <button className="reset" onClick={reset}>
                Start a new flow
              </button>
            ) : (
              <div className="running-pill">
                <span className="spin small" />
                <span>
                  {busy ? 'Running end-to-end…' : 'Flow complete'}
                </span>
              </div>
            )}
          </div>
        </aside>

        <div className="main-col">
          {smartAddress && (
            <section className={`deposit ${stage === 'fired' ? 'live' : ''}`}>
              <div className="deposit-label">
                <span className="deposit-dot" />
                {stage === 'fired' || stage === 'cleared'
                  ? 'Listening · send USDC to fire the batch'
                  : 'Send USDC here to fire the batch'}
              </div>
              <div className="deposit-row">
                <span className="deposit-addr mono">{smartAddress}</span>
                <button className="copy" onClick={copySmart}>
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
              <div className="deposit-hint">
                {stage === 'fired' || stage === 'cleared'
                  ? `Batch fires automatically once balance ≥ ${minUsdc || '0'} USDC. Expires in ${
                      expiresAt
                        ? Math.max(
                            0,
                            Math.floor((expiresAt * 1000 - Date.now()) / 60000)
                          )
                        : 60
                    }m.`
                  : 'Nexus smart account on Base · counterfactual until the first call.'}
              </div>
            </section>
          )}

          <section className="card batch">
            <div className="batch-head">
              <div>
                <div className="card-title">The batch</div>
                <div className="card-sub">
                  3 composable calls · every amount resolves at execution
                </div>
              </div>
              <div className="batch-tags">
                <span className="tag-chip">atomic</span>
                <span className="tag-chip accent">runtime-injected</span>
              </div>
            </div>

            <div className="pipeline">
              <div className="call">
                <div className="call-head">
                  <span className="call-n">01</span>
                  <span className="call-kind">predicate · action</span>
                </div>
                <div className="call-title">
                  <span className="contract mono">USDC</span>
                  <span className="fn mono">.approve()</span>
                </div>
                <div className="call-args">
                  <div className="arg">
                    <span className="arg-k">spender</span>
                    <span className="arg-v mono">Uniswap V3 Router</span>
                  </div>
                  <div className="arg">
                    <span className="arg-k">amount</span>
                    <span className="arg-v runtime mono">
                      balanceOf(USDC, this)
                    </span>
                  </div>
                </div>
              </div>

              <div className="pipe-arrow" aria-hidden="true">
                <svg viewBox="0 0 40 14" width="40" height="14">
                  <path
                    d="M0 7 L34 7 M28 2 L34 7 L28 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>

              <div className="call">
                <div className="call-head">
                  <span className="call-n">02</span>
                  <span className="call-kind">swap</span>
                </div>
                <div className="call-title">
                  <span className="contract mono">Uniswap V3</span>
                  <span className="fn mono">.exactInputSingle()</span>
                </div>
                <div className="call-args">
                  <div className="arg">
                    <span className="arg-k">route</span>
                    <span className="arg-v mono">USDC → WETH · 0.05%</span>
                  </div>
                  <div className="arg">
                    <span className="arg-k">amountIn</span>
                    <span className="arg-v runtime mono">
                      balanceOf(USDC, this)
                    </span>
                  </div>
                  <div className="arg">
                    <span className="arg-k">recipient</span>
                    <span className="arg-v mono">this</span>
                  </div>
                </div>
              </div>

              <div className="pipe-arrow" aria-hidden="true">
                <svg viewBox="0 0 40 14" width="40" height="14">
                  <path
                    d="M0 7 L34 7 M28 2 L34 7 L28 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>

              <div className="call">
                <div className="call-head">
                  <span className="call-n">03</span>
                  <span className="call-kind">deliver</span>
                </div>
                <div className="call-title">
                  <span className="contract mono">WETH</span>
                  <span className="fn mono">.transfer()</span>
                </div>
                <div className="call-args">
                  <div className="arg">
                    <span className="arg-k">to</span>
                    <span className="arg-v mono">
                      {recipient && recipientValid
                        ? short(recipient, 8, 6)
                        : 'recipient'}
                    </span>
                  </div>
                  <div className="arg">
                    <span className="arg-k">amount</span>
                    <span className="arg-v runtime mono">
                      balanceOf(WETH, this)
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="batch-foot">
              <span className="dot" />
              <span>
                Batch holds until USDC balance ≥{' '}
                <strong>{minUsdc || '0'}</strong>. After 1 hour, the signed
                quote expires and the relayer drops it.
              </span>
            </div>
          </section>

          <section className="card console">
            <div className="console-head">
              <span className="card-title">Timeline</span>
              {quoteHash && (
                <span className="mono small muted">
                  supertx {short(quoteHash, 10, 6)}
                </span>
              )}
            </div>
            <div className="console-body mono">
              {logs.length === 0 ? (
                <div className="muted">Run a step to see activity.</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className={`line ${l.kind}`}>
                    <span className="ts">
                      {new Date(l.ts).toLocaleTimeString()}
                    </span>
                    <span className={`tag tag-${l.kind}`}>{l.kind}</span>
                    <span className="msg">{l.msg}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="foot">
        <a href="https://www.erc8211.com/" target="_blank" rel="noreferrer">
          erc8211.com
        </a>
      </footer>
    </div>
  )
}

export default App
