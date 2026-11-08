const ts = require('typescript')
const fs = require('fs'),
  vm = require('vm'),
  assert = require('assert')
const source = fs.readFileSync(
  require('path').join(__dirname, '../src/services/proxy-settings.ts'),
  'utf8',
)
const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
async function testCase(opts = {}) {
  let profile = {
    uid: 'p',
    selected: [{ name: 'Supply', now: 'A' }],
    proxy_chains: [],
    group_policies: [],
  }
  let calls = [],
    reload = 0,
    select = 0,
    runtimeSelection = 'A'
  const clone = (x) => JSON.parse(JSON.stringify(x))
  const commands = {
    getProfiles: async () => ({
      current: opts.switched ? 'other' : 'p',
      items: [clone(profile)],
    }),
    patchProfile: async (id, patch) => {
      calls.push(['patch', clone(patch)])
      profile = { ...profile, ...clone(patch) }
    },
    enhanceProfiles: async () => {
      reload++
      return !(opts.invalid && reload === 1)
    },
  }
  const plugin = {
    getProxies: async () => ({
      proxies: { Supply: { now: runtimeSelection } },
    }),
    selectNodeForGroup: async (g, n) => {
      calls.push(['select', g, n])
      select++
      if (opts.selectError && select === 1) throw Error('select failed')
      if (!opts.notSelected || select > 1) runtimeSelection = n
    },
  }
  let exports = {}
  let ctx = {
    exports,
    require: (m) => (m === './cmds' ? commands : plugin),
    Promise,
    Error,
    console,
  }
  vm.runInNewContext(js, ctx)
  return {
    run: exports.updateProxySettings,
    get: () => clone(profile),
    calls,
    getReload: () => reload,
  }
}
;(async () => {
  let x = await testCase()
  await x.run(
    'p',
    (p) => ({
      proxy_chains: [
        { group: 'Supply', nodes: [{ name: 'A' }, { name: 'B' }] },
      ],
    }),
    { group: 'Supply', node: 'chain' },
  )
  assert.equal(x.get().selected[0].now, 'chain')
  assert.equal(x.get().proxy_chains.length, 1)
  x = await testCase({ invalid: true })
  await assert.rejects(
    x.run('p', () => ({
      proxy_chains: [
        { group: 'Supply', nodes: [{ name: 'A' }, { name: 'B' }] },
      ],
    })),
    /校验/,
  )
  assert.deepEqual(x.get().proxy_chains, [])
  assert.equal(x.getReload(), 2)
  x = await testCase({ selectError: true })
  await assert.rejects(
    x.run(
      'p',
      () => ({
        proxy_chains: [
          { group: 'Supply', nodes: [{ name: 'A' }, { name: 'B' }] },
        ],
      }),
      { group: 'Supply', node: 'chain' },
    ),
    /select failed/,
  )
  assert.deepEqual(x.get().proxy_chains, [])
  assert.deepEqual(
    x.calls.filter((c) => c[0] === 'select'),
    [
      ['select', 'Supply', 'chain'],
      ['select', 'Supply', 'A'],
    ],
  )
  x = await testCase({ notSelected: true })
  await assert.rejects(
    x.run(
      'p',
      () => ({
        proxy_chains: [
          { group: 'Supply', nodes: [{ name: 'A' }, { name: 'B' }] },
        ],
      }),
      { group: 'Supply', node: 'chain' },
    ),
    /未切换/,
  )
  assert.deepEqual(x.get().proxy_chains, [])
  x = await testCase()
  await Promise.all([
    x.run('p', (p) => ({
      proxy_chains: [...p.proxy_chains, { group: 'A', nodes: [] }],
    })),
    x.run('p', (p) => ({
      proxy_chains: [...p.proxy_chains, { group: 'B', nodes: [] }],
    })),
  ])
  assert.deepEqual(
    x.get().proxy_chains.map((x) => x.group),
    ['A', 'B'],
  )
  x = await testCase({ switched: true })
  await assert.rejects(
    x.run('p', () => ({ proxy_chains: [] })),
    /切换/,
  )
  assert.equal(x.calls.length, 0)
  console.log(
    'PASS: success, validation rollback, selection rollback, serialized edits, profile switch',
  )
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
