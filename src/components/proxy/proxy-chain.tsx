import { ArrowDownward, Delete, Link } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  IconButton,
  Paper,
  Typography,
} from '@mui/material'
import { useState } from 'react'

import { useProfiles } from '@/hooks/use-profiles'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import { showNotice } from '@/services/notice-service'
import { chainName, updateProxySettings } from '@/services/proxy-settings'

export interface ProxyChainItem extends IProxyChainNode {
  id: string
  type?: string
  delay?: number
}

interface Props {
  proxyChain: ProxyChainItem[]
  onUpdateChain: (chain: ProxyChainItem[]) => void
  selectedGroup?: string | null
}

export function ProxyChain({
  proxyChain,
  onUpdateChain,
  selectedGroup,
}: Props) {
  const { current, mutateProfiles } = useProfiles()
  const { refreshProxy } = useAppRefreshers()
  const { proxies } = useProxiesData()
  const savedChain = current?.proxy_chains?.find(
    (chain) => chain.group === selectedGroup,
  )
  const [saving, setSaving] = useState(false)

  const connect = async () => {
    if (!current || !selectedGroup || proxyChain.length < 2) return
    const chain: IProxyChain = {
      group: selectedGroup,
      nodes: proxyChain.map(({ name, provider }) => ({
        name,
        ...(provider ? { provider } : {}),
      })),
    }
    const name = chainName(chain)
    setSaving(true)
    try {
      await updateProxySettings(
        current.uid,
        (profile) => {
          const old = (profile.proxy_chains ?? []).find(
            (entry) => entry.group === selectedGroup,
          )
          const oldName = old ? chainName(old) : null
          return {
            proxy_chains: [
              ...(profile.proxy_chains ?? []).filter(
                (entry) => entry.group !== selectedGroup,
              ),
              chain,
            ],
            group_policies: (profile.group_policies ?? []).map((policy) => {
              if (policy.group !== selectedGroup) return policy
              return {
                ...policy,
                candidates: [
                  ...policy.candidates.filter(
                    (value) => value !== oldName && value !== name,
                  ),
                  name,
                ],
                disabled: policy.disabled.filter(
                  (value) => value !== oldName && value !== name,
                ),
                universe: [
                  ...(policy.universe ?? []).filter(
                    (item) => item.name !== oldName && item.name !== name,
                  ),
                  { name, type: 'Selector' },
                ],
              }
            }),
          }
        },
        { group: selectedGroup, node: name },
      )
      await mutateProfiles()
      await refreshProxy()
      showNotice.success('链式节点已创建并选中')
    } catch (error) {
      await mutateProfiles()
      await refreshProxy()
      showNotice.error(error)
    } finally {
      setSaving(false)
    }
  }

  const removeSaved = async () => {
    if (!current || !selectedGroup || !savedChain) return
    const oldName = chainName(savedChain)
    if (
      proxies?.groups?.find(
        (group: IProxyGroupItem) => group.name === selectedGroup,
      )?.now === oldName
    ) {
      showNotice.error('请先返回普通界面，在该分组选择其他节点，再删除链式节点')
      return
    }
    if (!window.confirm(`删除分组“${selectedGroup}”的链式节点？`)) return
    setSaving(true)
    try {
      await updateProxySettings(current.uid, (profile) => ({
        proxy_chains: (profile.proxy_chains ?? []).filter(
          (chain) => chain.group !== selectedGroup,
        ),
        group_policies: (profile.group_policies ?? []).map((policy) =>
          policy.group !== selectedGroup
            ? policy
            : {
                ...policy,
                candidates: policy.candidates.filter(
                  (value) => value !== oldName,
                ),
                disabled: policy.disabled.filter((value) => value !== oldName),
                universe: (policy.universe ?? []).filter(
                  (value) => value.name !== oldName,
                ),
              },
        ),
      }))
      onUpdateChain([])
      await mutateProfiles()
      await refreshProxy()
      showNotice.success('链式节点已删除')
    } catch (error) {
      await mutateProfiles()
      await refreshProxy()
      showNotice.error(error)
    } finally {
      setSaving(false)
    }
  }

  const move = (index: number, step: number) => {
    const target = index + step
    if (target < 0 || target >= proxyChain.length) return
    const next = [...proxyChain]
    ;[next[index], next[target]] = [next[target], next[index]]
    onUpdateChain(next)
  }

  return (
    <Paper
      elevation={1}
      sx={{
        height: '100%',
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography variant="h6">链式代理</Typography>
        {savedChain && (
          <Button
            color="error"
            size="small"
            disabled={saving}
            onClick={removeSaved}
          >
            删除已保存链
          </Button>
        )}
        <Button
          variant="contained"
          startIcon={<Link />}
          disabled={saving || proxyChain.length < 2 || !selectedGroup}
          onClick={connect}
        >
          {saving ? '应用中…' : '连接'}
        </Button>
      </Box>
      <Alert severity="info">
        选择目标分组后，按入口到出口的顺序点击节点。连接后会在该分组创建并选中独立的链式节点，关闭此界面不会断开。
      </Alert>
      <Box sx={{ overflow: 'auto', flex: 1 }}>
        {proxyChain.map((node, index) => (
          <Box
            key={node.id}
            sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}
          >
            <Typography sx={{ flex: 1, overflowWrap: 'anywhere' }}>
              {index + 1}. {node.name}
            </Typography>
            <Button
              size="small"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              上移
            </Button>
            <IconButton
              size="small"
              disabled={index === proxyChain.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownward fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              onClick={() =>
                onUpdateChain(proxyChain.filter((item) => item.id !== node.id))
              }
            >
              <Delete fontSize="small" />
            </IconButton>
          </Box>
        ))}
        {!proxyChain.length && (
          <Typography color="text.secondary">请从左侧选择节点</Typography>
        )}
      </Box>
    </Paper>
  )
}
