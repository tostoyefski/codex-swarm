import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
const requestTimeoutMs = 30_000

function defaultCommand() {
  return process.env.SWARM_CODEX_BIN || (existsSync(bundledCodex) ? bundledCodex : 'codex')
}

function userInput(text) {
  return [{ type: 'text', text, text_elements: [] }]
}

function threadOptions({ cwd, model, sandbox = 'read-only' } = {}) {
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
    throw new Error(`Unsupported Swarm sandbox: ${sandbox}`)
  }
  return {
    cwd,
    model,
    modelProvider: 'openai',
    approvalPolicy: 'never',
    sandbox,
    runtimeWorkspaceRoots: cwd ? [cwd] : undefined,
    config: {
      sandbox_workspace_write: {
        writable_roots: [],
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    },
  }
}

function recordMessage(active, item) {
  if (item?.type !== 'agentMessage' || typeof item.text !== 'string') return
  if (item.phase === 'commentary') {
    active.messages.delete(item.id)
    return
  }
  active.messages.set(item.id, item.text)
  if (item.phase === 'final_answer') active.finalText = item.text
  if (!item.phase || item.phase === 'partial_answer') active.lastAnswerText = item.text
}

export class Codex {
  #command
  #onEvent
  #onToolCall
  #connection
  #connecting

  constructor({ command = defaultCommand(), onEvent = () => {}, onToolCall } = {}) {
    this.#command = command
    this.#onEvent = onEvent
    this.#onToolCall = onToolCall
  }

  async startThread({ cwd, model, sandbox, tools = [], name } = {}) {
    const conn = await this.#getConnection()
    const response = await this.#request(conn, 'thread/start', {
      ...threadOptions({ cwd, model, sandbox }),
      dynamicTools: tools.map(tool => ({ type: 'function', ...tool })),
    })
    if (name) await this.#request(conn, 'thread/name/set', { threadId: response.thread.id, name })
    return response.thread.id
  }

  async resumeThread({ threadId, cwd, model, sandbox }) {
    const conn = await this.#getConnection()
    const response = await this.#request(conn, 'thread/resume', {
      ...threadOptions({ cwd, model, sandbox }),
      threadId,
      excludeTurns: true,
    })
    return response.thread.id
  }

  async forkThread({ threadId, cwd, model, sandbox, lastTurnId, name }) {
    const conn = await this.#getConnection()
    const response = await this.#request(conn, 'thread/fork', {
      ...threadOptions({ cwd, model, sandbox }),
      threadId,
      lastTurnId,
      excludeTurns: true,
    })
    if (name) await this.#request(conn, 'thread/name/set', { threadId: response.thread.id, name })
    return response.thread.id
  }

  async turn({ threadId, prompt, model, outputSchema, parentTurnId, rootTurnId }) {
    const conn = await this.#getConnection()
    if (conn.active.has(threadId)) throw new Error(`Codex thread ${threadId} already has a running turn.`)
    const active = { ...Promise.withResolvers(), messages: new Map() }
    // A child can exit before the RPC finishes. Attach the rejection handler
    // before sending so both the request and its turn can settle safely.
    active.promise.catch(() => {})
    conn.active.set(threadId, active)
    try {
      const { turn } = await this.#request(conn, 'turn/start', {
        threadId,
        model,
        input: userInput(prompt),
        outputSchema,
        parentTurnId,
        rootTurnId,
      })
      active.turnId ??= turn.id
      if (turn.status !== 'inProgress') this.#finishTurn(active, turn)
      return await active.promise
    } finally {
      conn.active.delete(threadId)
    }
  }

  async steer({ threadId, text, expectedTurnId }) {
    const conn = await this.#getConnection()
    const turnId = conn.active.get(threadId)?.turnId
    if (!turnId || (expectedTurnId && expectedTurnId !== turnId)) return false
    await this.#request(conn, 'turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: userInput(text),
    })
    return true
  }

  async interrupt(threadId) {
    const conn = await this.#getConnection()
    const turnId = conn.active.get(threadId)?.turnId
    if (!turnId) return false
    await this.#request(conn, 'turn/interrupt', { threadId, turnId })
    return true
  }

  async close() {
    const conn = this.#connection
    if (!conn) return
    this.#disconnect(conn, new Error('Codex App Server connection closed.'), true)
    conn.child.stdin.end()
    const kill = setTimeout(() => conn.child.kill('SIGKILL'), 2_000)
    kill.unref()
    await conn.done.promise
    clearTimeout(kill)
  }

  #getConnection() {
    if (this.#connecting) return this.#connecting
    if (this.#connection) return Promise.resolve(this.#connection)
    this.#connecting = this.#connect().finally(() => { this.#connecting = undefined })
    return this.#connecting
  }

  async #connect() {
    const child = spawn(this.#command, ['--disable', 'plugins', '--disable', 'apps', 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    const conn = {
      child,
      nextId: 1,
      pending: new Map(),
      active: new Map(),
      done: Promise.withResolvers(),
      dead: false,
    }
    this.#connection = conn
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', line => this.#receive(conn, line))
    child.stderr.resume()
    child.stdin.on('error', error => this.#disconnect(conn, error))
    child.on('error', error => this.#disconnect(conn, error))
    child.on('close', (code, signal) => {
      lines.close()
      conn.done.resolve()
      this.#disconnect(conn, new Error(`Codex App Server stopped (${signal || `exit ${code}`}).`))
    })
    try {
      await this.#request(conn, 'initialize', {
        clientInfo: { name: 'codex-swarm', title: 'Codex Swarm', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      this.#send(conn, { method: 'initialized' })
      return conn
    } catch (error) {
      this.#disconnect(conn, error)
      child.kill()
      throw error
    }
  }

  #disconnect(conn, error, intentional = false) {
    if (conn.dead) return
    conn.dead = true
    if (this.#connection === conn) this.#connection = undefined
    for (const pending of conn.pending.values()) pending.reject(error)
    conn.pending.clear()
    for (const active of conn.active.values()) active.reject(error)
    conn.active.clear()
    if (!intentional) this.#emit('runtime/disconnected', { message: error.message })
  }

  #send(conn, value) {
    if (conn.dead || !conn.child.stdin.writable) throw new Error('Codex App Server is disconnected.')
    conn.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  async #request(conn, method, params) {
    const id = conn.nextId++
    const pending = Promise.withResolvers()
    pending.promise.catch(() => {})
    const timeout = setTimeout(() => {
      pending.reject(new Error(`Codex App Server timed out on ${method}.`))
    }, requestTimeoutMs)
    timeout.unref()
    conn.pending.set(id, pending)
    try {
      this.#send(conn, { id, method, params })
      return await pending.promise
    } finally {
      clearTimeout(timeout)
      conn.pending.delete(id)
    }
  }

  #receive(conn, line) {
    if (conn.dead || !line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.#emit('runtime/protocolWarning', { message: 'Unknown Codex App Server output was ignored.' })
      return
    }
    if (!message || typeof message !== 'object') return
    const { id, method, params, result, error } = message
    if (method && id != null) {
      this.#handleRequest(conn, id, method, params).catch(error => {
        if (!conn.dead) this.#emit('runtime/protocolWarning', { message: error.message })
      })
      return
    }
    if (id != null) {
      const pending = conn.pending.get(id)
      if (!pending) return
      if (error) pending.reject(Object.assign(new Error(error.message), { code: error.code, data: error.data }))
      else pending.resolve(result)
      return
    }
    if (method) this.#notification(conn, method, params)
  }

  #notification(conn, method, params) {
    const active = conn.active.get(params?.threadId)
    const turnId = params?.turnId ?? params?.turn?.id
    if (active && (!active.turnId || active.turnId === turnId)) {
      if (method === 'turn/started') active.turnId = turnId
      if (method === 'item/agentMessage/delta') {
        const { itemId, delta } = params
        active.messages.set(itemId, (active.messages.get(itemId) || '') + delta)
      }
      if (method === 'item/completed') recordMessage(active, params.item)
      if (method === 'error' && !params.willRetry) active.error = params.error
      if (method === 'turn/completed') this.#finishTurn(active, params.turn)
    }
    this.#emit(method, params)
  }

  #finishTurn(active, turn) {
    for (const item of turn.items || []) recordMessage(active, item)
    const text = active.finalText ?? active.lastAnswerText ?? [...active.messages.values()].at(-1) ?? ''
    const error = turn.error ?? active.error
    active.resolve({
      text,
      turnId: turn.id,
      status: turn.status,
      ...(error ? { error } : {}),
      ...(active.approvalDenied ? { approvalDenied: true } : {}),
    })
  }

  async #handleRequest(conn, id, method, params) {
    let result
    switch (method) {
      case 'item/tool/call': {
        let text, success
        try {
          if (!this.#onToolCall) throw new Error(`Tool ${params.tool} is not handled by this client.`)
          const value = await this.#onToolCall(params)
          text = JSON.stringify(value ?? null)
          success = true
        } catch (error) {
          text = JSON.stringify({ error: error.message })
          success = false
        }
        result = { success, contentItems: [{ type: 'inputText', text }] }
        break
      }
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.#recordDenial(conn, method, params)
        result = { decision: 'decline' }
        break
      case 'item/permissions/requestApproval':
        this.#recordDenial(conn, method, params)
        result = { permissions: {}, scope: 'turn' }
        break
      case 'mcpServer/elicitation/request':
        this.#recordDenial(conn, method, params)
        result = { action: 'decline', content: null, _meta: null }
        break
      case 'item/tool/requestUserInput':
        this.#recordDenial(conn, method, params)
        result = { answers: {} }
        break
      case 'execCommandApproval':
      case 'applyPatchApproval':
        this.#recordDenial(conn, method, params)
        result = { decision: { denied: { rejection: 'Swarm cannot grant additional permissions.' } } }
        break
      case 'currentTime/read':
        result = { currentTimeAt: Math.floor(Date.now() / 1000) }
        break
      default:
        this.#send(conn, { id, error: { code: -32601, message: `Swarm does not support ${method}.` } })
        return
    }
    this.#send(conn, { id, result })
  }

  #recordDenial(conn, method, params) {
    const active = conn.active.get(params?.threadId)
    if (active) active.approvalDenied = true
    this.#emit('runtime/approvalDenied', {
      threadId: params?.threadId,
      turnId: params?.turnId,
      method,
      message: 'Codex requested input or permissions outside the configured Swarm sandbox.',
    })
  }

  #emit(method, params) {
    try {
      Promise.resolve(this.#onEvent({ method, params })).catch(() => {})
    } catch {
      // Event observers must not break the transport or stall an active turn.
    }
  }
}
