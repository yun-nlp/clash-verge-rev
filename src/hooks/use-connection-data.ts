import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { MihomoWebSocket } from 'tauri-plugin-mihomo-api'

const MAX_CLOSED_CONNS_NUM = 500
const CONNECTION_UPDATE_THROTTLE_MS = 500
const CONNECTION_RECONNECT_DELAY_MS = 1_000
const UNKNOWN_HOST = '未知主机'
const UNKNOWN_GROUP = '未知分组'

type ConnectionMetadata = IConnectionsItem['metadata']
type ConnectionListener = () => void

type ConnectionAggregateInput = {
  connection: IConnectionsItem
  previous?: IConnectionsItem
}

const metadataValue = (value?: string) => value || ''
const cleanText = (value?: string) => (value || '').trim()
const normalizeGroup = (value?: string) => cleanText(value) || UNKNOWN_GROUP

const addUniqueText = (target: string[], value?: string) => {
  const nextValue = cleanText(value)
  if (!nextValue || target.includes(nextValue)) return
  target.push(nextValue)
}

export const initConnData: ConnectionMonitorData = {
  uploadTotal: 0,
  downloadTotal: 0,
  activeConnections: [],
  closedConnections: [],
  aggregatedConnections: [],
}

export interface ConnectionAggregateItem {
  id: string
  host: string
  topGroup: string
  groups: string[]
  upload: number
  download: number
  curUpload: number
  curDownload: number
  activeCount: number
  closedCount: number
  connectionCount: number
  chains: string[]
  rules: string[]
  processes: string[]
  firstSeen: number
  lastSeen: number
}

export interface ConnectionMonitorData {
  uploadTotal: number
  downloadTotal: number
  activeConnections: IConnectionsItem[]
  closedConnections: IConnectionsItem[]
  aggregatedConnections: ConnectionAggregateItem[]
}

export interface ConnectionSummaryData {
  activeConnectionCount: number
}

export const initConnSummaryData: ConnectionSummaryData = {
  activeConnectionCount: 0,
}

let connectionData: ConnectionMonitorData = initConnData
let connectionSummary: ConnectionSummaryData = initConnSummaryData
let connectionSocket: MihomoWebSocket | null = null
let connectionStarted = false
let connectionConnecting = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pendingMessageData: string | null = null
let lastFlushAt = 0

const connectionListeners = new Set<ConnectionListener>()
const summaryListeners = new Set<ConnectionListener>()
const AGGREGATE_ENABLED_STORAGE_KEY = 'connection-aggregate-enabled'

const readAggregateEnabled = () => {
  try {
    return localStorage.getItem(AGGREGATE_ENABLED_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

let aggregateEnabled = readAggregateEnabled()
const aggregateEnabledListeners = new Set<() => void>()

export const isAggregateEnabled = () => aggregateEnabled

export const subscribeAggregateEnabled = (listener: () => void) => {
  aggregateEnabledListeners.add(listener)
  return () => {
    aggregateEnabledListeners.delete(listener)
  }
}

export const setAggregateEnabled = (enabled: boolean) => {
  if (aggregateEnabled === enabled) return
  aggregateEnabled = enabled
  try {
    localStorage.setItem(
      AGGREGATE_ENABLED_STORAGE_KEY,
      enabled ? 'true' : 'false',
    )
  } catch {
    // ignore persistence errors
  }
  aggregateEnabledListeners.forEach((listener) => listener())
}

const aggregateByKey = new Map<string, ConnectionAggregateItem>()
const aggregateActiveKeysById = new Map<string, string>()

const notifyConnectionListeners = () => {
  connectionListeners.forEach((listener) => listener())
}

const notifySummaryListeners = () => {
  summaryListeners.forEach((listener) => listener())
}

const sameMetadata = (left: ConnectionMetadata, right: ConnectionMetadata) =>
  metadataValue(left.network) === metadataValue(right.network) &&
  metadataValue(left.type) === metadataValue(right.type) &&
  metadataValue(left.host) === metadataValue(right.host) &&
  metadataValue(left.sourceIP) === metadataValue(right.sourceIP) &&
  metadataValue(left.sourcePort) === metadataValue(right.sourcePort) &&
  metadataValue(left.destinationPort) ===
    metadataValue(right.destinationPort) &&
  metadataValue(left.destinationIP) === metadataValue(right.destinationIP) &&
  metadataValue(left.remoteDestination) ===
    metadataValue(right.remoteDestination) &&
  metadataValue(left.process) === metadataValue(right.process) &&
  metadataValue(left.processPath) === metadataValue(right.processPath)

const normalizeMetadata = (
  metadata: ConnectionMetadata,
  previous?: ConnectionMetadata,
): ConnectionMetadata => {
  if (previous && sameMetadata(previous, metadata)) return previous

  return {
    network: metadata.network || '',
    type: metadata.type || '',
    host: metadata.host || '',
    sourceIP: metadata.sourceIP || '',
    sourcePort: metadata.sourcePort || '',
    destinationPort: metadata.destinationPort || '',
    destinationIP: metadata.destinationIP || '',
    remoteDestination: metadata.remoteDestination || '',
    process: metadata.process || '',
    processPath: metadata.processPath || '',
  }
}

const sameChains = (left: string[], right: string[]) => {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

const normalizeChains = (chains: string[], previous?: string[]) => {
  if (previous && sameChains(previous, chains)) return previous
  return chains.slice()
}

const normalizeConnection = (
  connection: IConnectionsItem,
  previous?: IConnectionsItem,
): IConnectionsItem => {
  const metadata = normalizeMetadata(connection.metadata, previous?.metadata)
  const chains = normalizeChains(connection.chains || [], previous?.chains)
  const upload = connection.upload ?? 0
  const download = connection.download ?? 0
  const curUpload = previous ? upload - previous.upload : 0
  const curDownload = previous ? download - previous.download : 0
  const rule = connection.rule || ''
  const rulePayload = connection.rulePayload || ''
  const start = connection.start || ''

  if (
    previous &&
    previous.metadata === metadata &&
    previous.chains === chains &&
    previous.upload === upload &&
    previous.download === download &&
    previous.curUpload === curUpload &&
    previous.curDownload === curDownload &&
    previous.rule === rule &&
    previous.rulePayload === rulePayload &&
    previous.start === start
  ) {
    return previous
  }

  return {
    id: connection.id,
    metadata,
    upload,
    download,
    start,
    chains,
    rule,
    rulePayload,
    curUpload,
    curDownload,
  }
}

const getAggregateHost = (connection: IConnectionsItem) => {
  const { metadata } = connection
  const host =
    cleanText(metadata.host) ||
    cleanText(metadata.remoteDestination) ||
    cleanText(metadata.destinationIP) ||
    UNKNOWN_HOST
  const port = cleanText(metadata.destinationPort)
  return port ? `${host}:${port}` : host
}

const getAggregateTopGroup = (chains: string[]) =>
  normalizeGroup(chains.length > 0 ? chains[chains.length - 1] : undefined)

const getAggregateGroups = (chains: string[]) => {
  const groups: string[] = []
  for (let i = chains.length - 1; i >= 0; i--) {
    const group = normalizeGroup(chains[i])
    if (!groups.includes(group)) groups.push(group)
  }
  if (groups.length === 0) groups.push(UNKNOWN_GROUP)
  return groups
}

const getAggregateKey = (connection: IConnectionsItem) => {
  const hostKey = getAggregateHost(connection).toLowerCase()
  const topGroup = getAggregateTopGroup(connection.chains || [])
  return `${hostKey}|${topGroup}`
}

const getConnectionRuleText = (connection: IConnectionsItem) => {
  const rule = cleanText(connection.rule)
  const rulePayload = cleanText(connection.rulePayload)
  if (rule && rulePayload) return `${rule}(${rulePayload})`
  return rule || rulePayload
}

const getConnectionProcessText = (connection: IConnectionsItem) => {
  const { metadata } = connection
  return cleanText(metadata.process) || cleanText(metadata.processPath)
}

const createAggregateItem = (
  key: string,
  connection: IConnectionsItem,
  now: number,
): ConnectionAggregateItem => {
  const chains = connection.chains || []
  const item: ConnectionAggregateItem = {
    id: key,
    host: getAggregateHost(connection),
    topGroup: getAggregateTopGroup(chains),
    groups: getAggregateGroups(chains),
    upload: 0,
    download: 0,
    curUpload: 0,
    curDownload: 0,
    activeCount: 0,
    closedCount: 0,
    connectionCount: 0,
    chains: chains.slice(),
    rules: [],
    processes: [],
    firstSeen: now,
    lastSeen: now,
  }
  addUniqueText(item.rules, getConnectionRuleText(connection))
  addUniqueText(item.processes, getConnectionProcessText(connection))
  return item
}

const ensureAggregateItem = (
  key: string,
  connection: IConnectionsItem,
  now: number,
) => {
  const item = aggregateByKey.get(key)
  if (item) return item

  const nextItem = createAggregateItem(key, connection, now)
  aggregateByKey.set(key, nextItem)
  return nextItem
}

const updateAggregateItemMetadata = (
  item: ConnectionAggregateItem,
  connection: IConnectionsItem,
  now: number,
) => {
  const chains = connection.chains || []
  item.host = getAggregateHost(connection)
  item.topGroup = getAggregateTopGroup(chains)
  getAggregateGroups(chains).forEach((group) =>
    addUniqueText(item.groups, group),
  )
  item.chains = chains.slice()
  addUniqueText(item.rules, getConnectionRuleText(connection))
  addUniqueText(item.processes, getConnectionProcessText(connection))
  item.lastSeen = now
}

const decrementAggregateActiveCount = (key: string) => {
  const item = aggregateByKey.get(key)
  if (!item) return
  item.activeCount = Math.max(0, item.activeCount - 1)
}

const closeAggregateConnection = (connectionId: string, now: number) => {
  const key = aggregateActiveKeysById.get(connectionId)
  if (!key) return

  const item = aggregateByKey.get(key)
  if (item) {
    item.activeCount = Math.max(0, item.activeCount - 1)
    item.closedCount += 1
    item.lastSeen = now
  }
  aggregateActiveKeysById.delete(connectionId)
}

const createAggregateSnapshot = () =>
  Array.from(aggregateByKey.values()).map((item) => ({
    ...item,
    groups: item.groups.slice(),
    chains: item.chains.slice(),
    rules: item.rules.slice(),
    processes: item.processes.slice(),
  }))

const mergeConnectionAggregates = (
  activeInputs: ConnectionAggregateInput[],
  removedConnections: Map<string, IConnectionsItem>,
) => {
  const now = Date.now()

  aggregateByKey.forEach((item) => {
    item.curUpload = 0
    item.curDownload = 0
  })

  for (let i = 0; i < activeInputs.length; i++) {
    const { connection, previous } = activeInputs[i]
    const key = getAggregateKey(connection)
    const item = ensureAggregateItem(key, connection, now)
    const previousKey = aggregateActiveKeysById.get(connection.id)

    if (previousKey !== key) {
      if (previousKey) decrementAggregateActiveCount(previousKey)
      aggregateActiveKeysById.set(connection.id, key)
      item.activeCount += 1
      item.connectionCount += 1
    }

    const upload = connection.upload ?? 0
    const download = connection.download ?? 0
    const deltaUpload = previous
      ? Math.max(0, upload - (previous.upload ?? 0))
      : upload
    const deltaDownload = previous
      ? Math.max(0, download - (previous.download ?? 0))
      : download

    if (deltaUpload > 0 || deltaDownload > 0) {
      item.upload += deltaUpload
      item.download += deltaDownload
      item.curUpload += deltaUpload
      item.curDownload += deltaDownload
    }

    updateAggregateItemMetadata(item, connection, now)
  }

  removedConnections.forEach((connection) => {
    closeAggregateConnection(connection.id, now)
  })

  return createAggregateSnapshot()
}

const mergeConnectionSnapshot = (
  payload: IConnections,
  previous: ConnectionMonitorData = initConnData,
): ConnectionMonitorData => {
  const nextConnections = payload.connections ?? []
  const previousActive = previous.activeConnections ?? []
  const previousClosed = previous.closedConnections ?? []
  const previousActiveById = new Map<string, IConnectionsItem>()

  for (let i = 0; i < previousActive.length; i++) {
    const previousConnection = previousActive[i]
    previousActiveById.set(previousConnection.id, previousConnection)
  }

  const activeConnections: IConnectionsItem[] = []
  const activeAggregateInputs: ConnectionAggregateInput[] = []
  for (let i = 0; i < nextConnections.length; i++) {
    const connection = nextConnections[i]
    const previousConnection = previousActiveById.get(connection.id)
    if (previousConnection) previousActiveById.delete(connection.id)
    const normalizedConnection = normalizeConnection(
      connection,
      previousConnection,
    )
    activeConnections.push(normalizedConnection)
    activeAggregateInputs.push({
      connection: normalizedConnection,
      previous: previousConnection,
    })
  }

  const aggregatedConnections = aggregateEnabled
    ? mergeConnectionAggregates(activeAggregateInputs, previousActiveById)
    : createAggregateSnapshot()

  if (previousActiveById.size === 0) {
    return {
      uploadTotal: payload.uploadTotal ?? 0,
      downloadTotal: payload.downloadTotal ?? 0,
      activeConnections,
      closedConnections: previousClosed,
      aggregatedConnections,
    }
  }

  const removedConnectionCount = previousActiveById.size
  const dropFromClosed = Math.max(
    0,
    previousClosed.length + removedConnectionCount - MAX_CLOSED_CONNS_NUM,
  )
  const closedConnections =
    dropFromClosed >= previousClosed.length
      ? []
      : previousClosed.slice(dropFromClosed)

  const keepFromRemoved = MAX_CLOSED_CONNS_NUM - closedConnections.length
  let skipRemoved = Math.max(0, removedConnectionCount - keepFromRemoved)

  for (let i = 0; i < previousActive.length; i++) {
    const connection = previousActive[i]
    if (!previousActiveById.has(connection.id)) continue
    if (skipRemoved > 0) {
      skipRemoved -= 1
      continue
    }
    closedConnections.push(connection)
  }

  return {
    uploadTotal: payload.uploadTotal ?? 0,
    downloadTotal: payload.downloadTotal ?? 0,
    activeConnections,
    closedConnections,
    aggregatedConnections,
  }
}

const mergeConnectionSummary = (
  payload: IConnections,
): ConnectionSummaryData => ({
  activeConnectionCount: payload.connections?.length ?? 0,
})

const flushPendingMessage = () => {
  flushTimer = null
  const messageData = pendingMessageData
  pendingMessageData = null
  if (!messageData) return

  let payload: IConnections
  try {
    payload = JSON.parse(messageData) as IConnections
  } catch (err) {
    console.error('[Connections] Failed to parse websocket payload', err)
    return
  }

  lastFlushAt = Date.now()
  connectionSummary = mergeConnectionSummary(payload)
  notifySummaryListeners()

  connectionData = mergeConnectionSnapshot(payload, connectionData)
  if (connectionListeners.size > 0) notifyConnectionListeners()
}

const enqueueConnectionMessage = (messageData: string) => {
  pendingMessageData = messageData
  if (flushTimer) return

  const elapsed = Date.now() - lastFlushAt
  if (elapsed >= CONNECTION_UPDATE_THROTTLE_MS) {
    flushPendingMessage()
    return
  }

  flushTimer = window.setTimeout(
    flushPendingMessage,
    CONNECTION_UPDATE_THROTTLE_MS - elapsed,
  )
}

const clearReconnectTimer = () => {
  if (!reconnectTimer) return
  window.clearTimeout(reconnectTimer)
  reconnectTimer = null
}

const closeConnectionSocket = async () => {
  const socket = connectionSocket
  connectionSocket = null
  if (!socket) return

  try {
    await socket.close()
  } catch (err) {
    console.warn('Failed to close connection websocket', err)
  }
}

const scheduleReconnect = () => {
  if (reconnectTimer) return
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    void connectConnectionSocket()
  }, CONNECTION_RECONNECT_DELAY_MS)
}

async function reconnectConnectionSocket() {
  await closeConnectionSocket()
  scheduleReconnect()
}

async function connectConnectionSocket() {
  if (connectionSocket || connectionConnecting) return

  clearReconnectTimer()
  connectionConnecting = true

  try {
    const socket = await MihomoWebSocket.connect_connections()
    connectionSocket = socket
    socket.addListener((message) => {
      if (message.type !== 'Text') return
      if (message.data.startsWith('Websocket error')) {
        void reconnectConnectionSocket()
        return
      }

      enqueueConnectionMessage(message.data)
    })
  } catch {
    scheduleReconnect()
  } finally {
    connectionConnecting = false
  }
}

const startConnectionMonitor = () => {
  if (connectionStarted) return
  connectionStarted = true
  void connectConnectionSocket()
}

const getConnectionSnapshot = () => connectionData
const getConnectionSummarySnapshot = () => connectionSummary

const subscribeConnectionData = (listener: ConnectionListener) => {
  startConnectionMonitor()
  connectionListeners.add(listener)
  return () => {
    connectionListeners.delete(listener)
  }
}

const subscribeConnectionSummary = (listener: ConnectionListener) => {
  startConnectionMonitor()
  summaryListeners.add(listener)
  return () => {
    summaryListeners.delete(listener)
  }
}

const refreshConnectionData = () => {
  pendingMessageData = null
  if (flushTimer) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }

  void reconnectConnectionSocket()
}

const clearClosedConnectionData = () => {
  if (connectionData.closedConnections.length === 0) return
  connectionData = {
    ...connectionData,
    closedConnections: [],
  }
  notifyConnectionListeners()
}

const clearAggregateConnectionData = () => {
  if (aggregateByKey.size === 0 && aggregateActiveKeysById.size === 0) return
  aggregateByKey.clear()
  aggregateActiveKeysById.clear()
  connectionData = {
    ...connectionData,
    aggregatedConnections: [],
  }
  notifyConnectionListeners()
}

const clearAggregateConnectionById = (id: string) => {
  if (!aggregateByKey.has(id)) return
  aggregateByKey.delete(id)
  aggregateActiveKeysById.forEach((key, connectionId) => {
    if (key === id) aggregateActiveKeysById.delete(connectionId)
  })
  connectionData = {
    ...connectionData,
    aggregatedConnections: createAggregateSnapshot(),
  }
  notifyConnectionListeners()
}

const clearAggregateConnectionsByGroups = (groups: string[]) => {
  const groupSet = new Set(
    groups.map((group) => cleanText(group)).filter(Boolean),
  )
  if (groupSet.size === 0) return

  const keysToDelete = new Set<string>()
  aggregateByKey.forEach((item, key) => {
    if (item.groups.some((group) => groupSet.has(group))) keysToDelete.add(key)
  })

  if (keysToDelete.size === 0) return

  keysToDelete.forEach((key) => aggregateByKey.delete(key))
  aggregateActiveKeysById.forEach((key, connectionId) => {
    if (keysToDelete.has(key)) aggregateActiveKeysById.delete(connectionId)
  })
  connectionData = {
    ...connectionData,
    aggregatedConnections: createAggregateSnapshot(),
  }
  notifyConnectionListeners()
}

export const useConnectionData = () => {
  const data = useSyncExternalStore(
    subscribeConnectionData,
    getConnectionSnapshot,
    getConnectionSnapshot,
  )
  const response = useMemo(() => ({ data }), [data])
  const refreshGetClashConnection = useCallback(() => {
    refreshConnectionData()
  }, [])
  const clearClosedConnections = useCallback(() => {
    clearClosedConnectionData()
  }, [])
  const clearAggregatedConnections = useCallback(() => {
    clearAggregateConnectionData()
  }, [])
  const clearAggregatedConnection = useCallback((id: string) => {
    clearAggregateConnectionById(id)
  }, [])
  const clearAggregatedConnectionsByGroups = useCallback((groups: string[]) => {
    clearAggregateConnectionsByGroups(groups)
  }, [])

  return {
    response,
    refreshGetClashConnection,
    clearClosedConnections,
    clearAggregatedConnections,
    clearAggregatedConnection,
    clearAggregatedConnectionsByGroups,
  }
}

export const useConnectionSummaryData = () => {
  const data = useSyncExternalStore(
    subscribeConnectionSummary,
    getConnectionSummarySnapshot,
    getConnectionSummarySnapshot,
  )
  const response = useMemo(() => ({ data }), [data])
  const refreshGetClashConnectionSummary = useCallback(() => {
    refreshConnectionData()
  }, [])

  return {
    response,
    refreshGetClashConnectionSummary,
  }
}
