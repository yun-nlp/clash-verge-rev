import {
  DeleteForeverRounded,
  TableChartRounded,
  TableRowsRounded,
  ViewColumnRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Divider,
  Fab,
  IconButton,
  ListItemText,
  MenuItem,
  Select,
  Tooltip,
  Zoom,
  type SelectChangeEvent,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { closeAllConnections } from 'tauri-plugin-mihomo-api'

import {
  BaseEmpty,
  BasePage,
  BaseSearchBox,
  BaseStyledSelect,
  type SearchState,
  VirtualList,
} from '@/components/base'
import { ConnectionAggregateTable } from '@/components/connection/connection-aggregate-table'
import {
  ConnectionDetail,
  type ConnectionDetailRef,
} from '@/components/connection/connection-detail'
import { ConnectionRowItem } from '@/components/connection/connection-row-item'
import {
  getConnectionStartTime,
  useConnectionRowViews,
} from '@/components/connection/connection-row-view'
import { ConnectionTable } from '@/components/connection/connection-table'
import {
  isAggregateEnabled,
  setAggregateEnabled,
  subscribeAggregateEnabled,
  useConnectionData,
} from '@/hooks/use-connection-data'
import { useConnectionSetting } from '@/hooks/use-connection-setting'
import { useTrafficData } from '@/hooks/use-traffic-data'
import parseTraffic from '@/utils/parse-traffic'

type OrderFunc = (list: IConnectionsItem[]) => IConnectionsItem[]
type ConnectionsType = 'active' | 'closed' | 'aggregate'

const SELECT_ALL_GROUPS_VALUE = '__all_groups__'
const SELECT_NO_GROUPS_VALUE = '__no_groups__'

const ORDER_OPTIONS = [
  {
    id: 'default',
    labelKey: 'connections.components.order.default',
    fn: (list: IConnectionsItem[]) =>
      list.sort(
        (a, b) => getConnectionStartTime(b) - getConnectionStartTime(a),
      ),
  },
  {
    id: 'uploadSpeed',
    labelKey: 'connections.components.order.uploadSpeed',
    fn: (list: IConnectionsItem[]) =>
      list.sort((a, b) => (b.curUpload ?? 0) - (a.curUpload ?? 0)),
  },
  {
    id: 'downloadSpeed',
    labelKey: 'connections.components.order.downloadSpeed',
    fn: (list: IConnectionsItem[]) =>
      list.sort((a, b) => (b.curDownload ?? 0) - (a.curDownload ?? 0)),
  },
] as const

type OrderKey = (typeof ORDER_OPTIONS)[number]['id']

const orderFunctionMap = ORDER_OPTIONS.reduce<Record<OrderKey, OrderFunc>>(
  (acc, option) => {
    acc[option.id] = option.fn
    return acc
  },
  {} as Record<OrderKey, OrderFunc>,
)

const EMPTY_CONNECTIONS: IConnectionsItem[] = []
const EMPTY_AGGREGATED_CONNECTIONS: NonNullable<
  ReturnType<typeof useConnectionData>['response']['data']
>['aggregatedConnections'] = []

const ConnectionsPage = () => {
  const { t } = useTranslation()
  const [match, setMatch] = useState<(input: string) => boolean>(
    () => () => true,
  )
  const [hasSearch, setHasSearch] = useState(false)
  const [curOrderOpt, setCurOrderOpt] = useState<OrderKey>('default')
  const [connectionsType, setConnectionsType] =
    useState<ConnectionsType>('active')
  const [selectedAggregateGroups, setSelectedAggregateGroups] = useState<
    string[] | null
  >(null)

  const aggregateEnabled = useSyncExternalStore(
    subscribeAggregateEnabled,
    isAggregateEnabled,
    isAggregateEnabled,
  )
  const toggleAggregateEnabled = useCallback(() => {
    setAggregateEnabled(!isAggregateEnabled())
  }, [])

  const {
    response: { data: connections },
    clearClosedConnections,
    clearAggregatedConnections,
    clearAggregatedConnection,
    clearAggregatedConnectionsByGroups,
  } = useConnectionData()
  const {
    response: { data: traffic },
  } = useTrafficData()

  const [setting, setSetting] = useConnectionSetting()

  const isTableLayout = setting.layout === 'table'
  const isAggregateMode = connectionsType === 'aggregate'

  const [isColumnManagerOpen, setIsColumnManagerOpen] = useState(false)

  const aggregateConnections =
    connections?.aggregatedConnections ?? EMPTY_AGGREGATED_CONNECTIONS

  const aggregateGroups = useMemo(() => {
    const groups = new Set<string>()
    aggregateConnections.forEach((item) => {
      item.groups.forEach((group) => {
        if (group) groups.add(group)
      })
    })
    return Array.from(groups).sort((a, b) => a.localeCompare(b))
  }, [aggregateConnections])

  const selectedAggregateGroupValues = useMemo(() => {
    if (selectedAggregateGroups === null) return aggregateGroups

    const availableGroups = new Set(aggregateGroups)
    return selectedAggregateGroups.filter((group) => availableGroups.has(group))
  }, [aggregateGroups, selectedAggregateGroups])

  const selectedAggregateGroupSet = useMemo(
    () => new Set(selectedAggregateGroupValues),
    [selectedAggregateGroupValues],
  )

  const selectedConnections =
    connectionsType === 'active'
      ? (connections?.activeConnections ?? EMPTY_CONNECTIONS)
      : connectionsType === 'closed'
        ? (connections?.closedConnections ?? EMPTY_CONNECTIONS)
        : EMPTY_CONNECTIONS

  const filterConn = useMemo(() => {
    if (isAggregateMode) return EMPTY_CONNECTIONS

    const orderFunc = orderFunctionMap[curOrderOpt]

    if (isTableLayout && !hasSearch) return selectedConnections
    if (!hasSearch) return orderFunc([...selectedConnections])

    const matchConns = selectedConnections.filter((conn) => {
      const { host, destinationIP, process } = conn.metadata
      return (
        match(host || '') || match(destinationIP || '') || match(process || '')
      )
    })

    return orderFunc ? orderFunc(matchConns) : matchConns
  }, [
    isAggregateMode,
    selectedConnections,
    isTableLayout,
    hasSearch,
    match,
    curOrderOpt,
  ])

  const filterAggregateConn = useMemo(() => {
    if (selectedAggregateGroupValues.length === 0) return []

    return aggregateConnections.filter((item) => {
      const matchGroup = item.groups.some((group) =>
        selectedAggregateGroupSet.has(group),
      )
      if (!matchGroup) return false
      if (!hasSearch) return true

      return (
        match(item.host) ||
        match(item.topGroup) ||
        item.groups.some((group) => match(group)) ||
        item.rules.some((rule) => match(rule)) ||
        item.processes.some((process) => match(process)) ||
        item.chains.some((chain) => match(chain))
      )
    })
  }, [
    aggregateConnections,
    hasSearch,
    match,
    selectedAggregateGroupSet,
    selectedAggregateGroupValues.length,
  ])

  const displayRows = useConnectionRowViews(
    !isAggregateMode && !isTableLayout ? filterConn : EMPTY_CONNECTIONS,
  )

  const detailRef = useRef<ConnectionDetailRef>(null!)

  const selectConnectionsType = useCallback(
    (type: ConnectionsType) => {
      if (type === connectionsType) return
      detailRef.current?.close()
      setIsColumnManagerOpen(false)
      setConnectionsType(type)
    },
    [connectionsType],
  )

  const showDetailById = useCallback(
    (id: string) => {
      if (isAggregateMode) return

      const connection = filterConn.find((item) => item.id === id)
      if (connection) {
        detailRef.current?.open(connection, connectionsType === 'closed')
      }
    },
    [connectionsType, filterConn, isAggregateMode],
  )

  const onCloseAll = useLockFn(closeAllConnections)

  const handleSearch = useCallback(
    (match: (content: string) => boolean, state: SearchState) => {
      setMatch(() => match)
      setHasSearch(state.text.length > 0)
    },
    [],
  )

  const handleAggregateGroupChange = useCallback(
    (event: SelectChangeEvent<string[]>) => {
      const value = event.target.value
      const values = typeof value === 'string' ? value.split(',') : value

      if (values.includes(SELECT_ALL_GROUPS_VALUE)) {
        setSelectedAggregateGroups(null)
        return
      }

      if (values.includes(SELECT_NO_GROUPS_VALUE)) {
        setSelectedAggregateGroups([])
        return
      }

      setSelectedAggregateGroups(
        values.filter(
          (group) =>
            group !== SELECT_ALL_GROUPS_VALUE &&
            group !== SELECT_NO_GROUPS_VALUE,
        ),
      )
    },
    [],
  )

  const renderAggregateGroupValue = useCallback(
    (selected: unknown) => {
      const values = Array.isArray(selected) ? selected : []
      if (values.length === 0) return '未选择分组'
      if (values.length === aggregateGroups.length) return '全部分组'
      if (values.length <= 2) return values.join(', ')
      return `${values.length}/${aggregateGroups.length} 分组`
    },
    [aggregateGroups.length],
  )

  const handleDeleteSelectedAggregateGroups = useCallback(() => {
    if (selectedAggregateGroupValues.length === 0) return

    const message = `删除选中的 ${selectedAggregateGroupValues.length} 个分组统计？`
    if (!window.confirm(message)) return

    clearAggregatedConnectionsByGroups(selectedAggregateGroupValues)
    setSelectedAggregateGroups(null)
  }, [clearAggregatedConnectionsByGroups, selectedAggregateGroupValues])

  const handleClearAggregatedConnections = useCallback(() => {
    if (!window.confirm('清空全部聚合统计？')) return
    clearAggregatedConnections()
    setSelectedAggregateGroups(null)
  }, [clearAggregatedConnections])

  const hasTableData = isAggregateMode
    ? filterAggregateConn.length > 0
    : filterConn.length > 0

  return (
    <BasePage
      full
      title={
        <span style={{ whiteSpace: 'nowrap' }}>
          {t('connections.page.title')}
        </span>
      }
      contentStyle={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: '8px',
        minHeight: 0,
      }}
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box sx={{ mx: 1 }}>
            {t('shared.labels.downloaded')}:{' '}
            {parseTraffic(traffic?.downTotal || 0)}
          </Box>
          <Box sx={{ mx: 1 }}>
            {t('shared.labels.uploaded')}: {parseTraffic(traffic?.upTotal || 0)}
          </Box>
          <IconButton
            color="inherit"
            size="small"
            onClick={() =>
              setSetting((o) =>
                o?.layout !== 'table'
                  ? { ...o, layout: 'table' }
                  : { ...o, layout: 'list' },
              )
            }
          >
            {isTableLayout ? (
              <TableRowsRounded titleAccess={t('shared.actions.listView')} />
            ) : (
              <TableChartRounded titleAccess={t('shared.actions.tableView')} />
            )}
          </IconButton>
          <Button size="small" variant="contained" onClick={onCloseAll}>
            <span style={{ whiteSpace: 'nowrap' }}>
              {t('shared.actions.closeAll')}
            </span>
          </Button>
        </Box>
      }
    >
      <Box
        sx={{
          pt: 1,
          mb: 0.5,
          mx: '10px',
          minHeight: '36px',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          userSelect: 'text',
          position: 'sticky',
          top: 0,
          zIndex: 2,
        }}
      >
        <ButtonGroup sx={{ mr: 1, flexBasis: 'content' }}>
          <Button
            size="small"
            variant={connectionsType === 'active' ? 'contained' : 'outlined'}
            onClick={() => selectConnectionsType('active')}
          >
            {t('connections.components.actions.active')}{' '}
            {connections?.activeConnections.length}
          </Button>
          <Button
            size="small"
            variant={connectionsType === 'closed' ? 'contained' : 'outlined'}
            onClick={() => selectConnectionsType('closed')}
          >
            {t('connections.components.actions.closed')}{' '}
            {connections?.closedConnections.length}
          </Button>
          <Button
            size="small"
            variant={connectionsType === 'aggregate' ? 'contained' : 'outlined'}
            onClick={() => selectConnectionsType('aggregate')}
          >
            聚合 {connections?.aggregatedConnections.length}
          </Button>
        </ButtonGroup>
        {!isAggregateMode && !isTableLayout && (
          <BaseStyledSelect
            value={curOrderOpt}
            onChange={(e) => setCurOrderOpt(e.target.value as OrderKey)}
          >
            {ORDER_OPTIONS.map((option) => (
              <MenuItem key={option.id} value={option.id}>
                <span style={{ fontSize: 14 }}>{t(option.labelKey)}</span>
              </MenuItem>
            ))}
          </BaseStyledSelect>
        )}
        {isAggregateMode && (
          <>
            <Button
              size="small"
              variant={aggregateEnabled ? 'contained' : 'outlined'}
              color={aggregateEnabled ? 'success' : 'inherit'}
              onClick={toggleAggregateEnabled}
              sx={{ flex: '0 0 auto', whiteSpace: 'nowrap', mr: 1 }}
            >
              {aggregateEnabled ? '统计中·点击关闭' : '已暂停·点击开启'}
            </Button>
            <Select<string[]>
              multiple
              size="small"
              value={selectedAggregateGroupValues}
              onChange={handleAggregateGroupChange}
              renderValue={renderAggregateGroupValue}
              sx={{ width: 220, height: 33.375, flex: '0 0 auto' }}
            >
              <MenuItem value={SELECT_ALL_GROUPS_VALUE}>
                <Checkbox
                  size="small"
                  checked={
                    aggregateGroups.length > 0 &&
                    selectedAggregateGroupValues.length ===
                      aggregateGroups.length
                  }
                />
                <ListItemText primary="全选" />
              </MenuItem>
              <MenuItem value={SELECT_NO_GROUPS_VALUE}>
                <Checkbox
                  size="small"
                  checked={selectedAggregateGroupValues.length === 0}
                />
                <ListItemText primary="全不选" />
              </MenuItem>
              <Divider />
              {aggregateGroups.map((group) => (
                <MenuItem key={group} value={group}>
                  <Checkbox
                    size="small"
                    checked={selectedAggregateGroupSet.has(group)}
                  />
                  <ListItemText primary={group} />
                </MenuItem>
              ))}
            </Select>
            <Button
              size="small"
              variant="outlined"
              disabled={selectedAggregateGroupValues.length === 0}
              onClick={handleDeleteSelectedAggregateGroups}
              sx={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}
            >
              删除选中分组
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="error"
              disabled={aggregateConnections.length === 0}
              onClick={handleClearAggregatedConnections}
              sx={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}
            >
              清空统计
            </Button>
          </>
        )}
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            '& > *': {
              flex: 1,
            },
          }}
        >
          <BaseSearchBox onSearch={handleSearch} />
        </Box>
        {isTableLayout && !isAggregateMode && hasTableData && (
          <Tooltip title={t('connections.components.columnManager.title')}>
            <IconButton
              size="small"
              aria-label={t('connections.components.columnManager.title')}
              onClick={() => setIsColumnManagerOpen(true)}
              sx={{ flex: '0 0 auto' }}
            >
              <ViewColumnRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {!hasTableData ? (
        <BaseEmpty />
      ) : isAggregateMode ? (
        <ConnectionAggregateTable
          items={filterAggregateConn}
          onDeleteItem={clearAggregatedConnection}
        />
      ) : isTableLayout ? (
        <ConnectionTable
          connections={filterConn}
          onShowDetail={showDetailById}
          columnManagerOpen={isColumnManagerOpen}
          onCloseColumnManager={() => setIsColumnManagerOpen(false)}
        />
      ) : (
        <VirtualList
          key={connectionsType}
          count={displayRows.length}
          estimateSize={56}
          renderItem={(i) => (
            <ConnectionRowItem
              row={displayRows[i]}
              closed={connectionsType === 'closed'}
              onShowDetail={showDetailById}
            />
          )}
          style={{
            flex: 1,
            borderRadius: '8px',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
          }}
        />
      )}
      <ConnectionDetail ref={detailRef} />
      <Zoom
        in={connectionsType === 'closed' && filterConn.length > 0}
        unmountOnExit
      >
        <Fab
          size="medium"
          variant="extended"
          sx={{
            position: 'absolute',
            right: 16,
            bottom: isTableLayout ? 70 : 16,
          }}
          color="primary"
          onClick={() => clearClosedConnections()}
        >
          <DeleteForeverRounded sx={{ mr: 1 }} fontSize="small" />
          {t('shared.actions.clear')}
        </Fab>
      </Zoom>
    </BasePage>
  )
}

export default ConnectionsPage
