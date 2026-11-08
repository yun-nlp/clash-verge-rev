import { getProxies, selectNodeForGroup } from 'tauri-plugin-mihomo-api'

import { enhanceProfiles, getProfiles, patchProfile } from './cmds'

// Serialize changes in this window so two group edits cannot overwrite each other.
let pending: Promise<unknown> = Promise.resolve()

export function updateProxySettings(
  uid: string,
  change: (profile: IProfileItem) => Partial<IProfileItem>,
  selection?: { group: string; node: string },
): Promise<void> {
  const operation = pending
    .catch(() => undefined)
    .then(async () => {
      const profiles = await getProfiles()
      if (profiles.current !== uid) throw new Error('当前配置已切换，请重试')
      const current = profiles.items?.find((item) => item.uid === uid)
      if (!current) throw new Error('配置不存在')
      const previous = {
        proxy_chains: current.proxy_chains ?? [],
        group_policies: current.group_policies ?? [],
        selected: current.selected ?? [],
      }
      const updates = change(current)
      const oldSelection = selection
        ? (await getProxies()).proxies[selection.group]?.now
        : undefined
      let patched = false
      try {
        await patchProfile(uid, updates)
        patched = true
        if ((await getProfiles()).current !== uid)
          throw new Error('当前配置已切换，请重试')
        if (!(await enhanceProfiles())) throw new Error('配置校验或加载失败')
        if (selection) {
          await selectNodeForGroup(selection.group, selection.node)
          const actual = (await getProxies()).proxies[selection.group]?.now
          if (actual !== selection.node) {
            throw new Error(
              `分组未切换到 ${selection.node}；自动分组可能判定该节点不可用`,
            )
          }
          const selected = (current.selected ?? []).filter(
            (entry) => entry.name !== selection.group,
          )
          selected.push({ name: selection.group, now: selection.node })
          await patchProfile(uid, { selected })
        }
      } catch (error) {
        if (patched) {
          try {
            await patchProfile(uid, previous)
            if ((await getProfiles()).current === uid) {
              if (!(await enhanceProfiles()))
                throw new Error('恢复旧配置失败', { cause: error })
              if (selection && oldSelection)
                await selectNodeForGroup(selection.group, oldSelection)
            }
          } catch (rollbackError) {
            throw new Error(
              `${String(error)}；回滚失败：${String(rollbackError)}`,
              { cause: rollbackError },
            )
          }
        }
        throw error
      }
    })
  pending = operation
  return operation
}

export function chainName(chain: IProxyChain): string {
  return `链式 ${chain.nodes.map((node) => node.name).join(' ⇒ ')} [${chain.group}]`
}
