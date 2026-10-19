/**
 * skills.js — 离线校验 skills/ 能否被宿主半注册成会话内可调用的技能
 * 运行：node test/skills.js
 *
 * 不联网、不读凭证：用一个假的 ctx 跑一遍插件的 apply，
 * 只验证 provider 契约（dsh-skill 的 candidate / loaded 校验规则）与 SKILL.md 的 frontmatter。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SKILLS_DIR = path.join(ROOT, 'skills')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log('  PASS', name, extra || '')
  } else {
    fail += 1
    console.log('  FAIL', name, extra || '')
  }
}

// dsh-skill 的校验规则（见 @deepseek-ai/dsh-skill/lib/index.js validateCandidate）
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 与 lib/index.js 的 splitSkillFrontmatter 保持同样的解析语义 */
function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { data: {}, body: text }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line || /^\s/.test(line) || line.trim().startsWith('#')) continue
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    data[kv[1]] = kv[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return { data, body: text.slice(m[0].length) }
}

function makeCtx() {
  const captured = { providers: [], commands: [] }
  const makeSkillCtx = () => ({
    skills: {
      registerProvider(create) {
        captured.providers.push(typeof create === 'function' ? create : () => create)
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
  })
  const makeCommandCtx = () => ({
    commands: {
      register(def) {
        captured.commands.push(def)
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
  })
  const ctx = {
    tools: { register() { return () => {} } },
    on() { return () => {} },
    effect(fn) { fn(); return () => {} },
    inject(services, callback) {
      const wanted = services.filter((s) => s === 'skills' || s === 'commands')
      if (wanted.includes('skills') && !wanted.includes('commands')) callback(makeSkillCtx())
      else if (wanted.includes('commands') && !wanted.includes('skills')) callback(makeCommandCtx())
      else return
    },
  }
  return { ctx, captured }
}

async function main() {
  console.log('skills dir:', SKILLS_DIR)

  // ── 1. 目录与 frontmatter 自检（不依赖插件代码） ──
  let dirs = []
  try {
    dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (e) {
    console.log('FAIL: 读不到 skills/ 目录：' + e.message)
    process.exit(1)
  }
  check('skills/ 下至少有一个技能', dirs.length > 0, `${dirs.length} 个：${dirs.join(', ')}`)

  const expected = ['ima', 'ima-knowledge-base', 'ima-notes']
  for (const name of expected) {
    check('技能目录存在：' + name, dirs.includes(name))
  }

  for (const dir of dirs) {
    const file = path.join(SKILLS_DIR, dir, 'SKILL.md')
    if (!fs.existsSync(file)) {
      check(`${dir}/SKILL.md 存在`, false)
      continue
    }
    const raw = fs.readFileSync(file, 'utf8')
    const { data, body } = parseFrontmatter(raw)
    check(`${dir}: frontmatter 可解析`, Object.keys(data).length > 0)
    check(`${dir}: name 为 kebab-case`, KEBAB.test(String(data.name || '')), String(data.name || '(缺失)'))
    check(`${dir}: name 与目录名一致`, data.name === dir, `${String(data.name || '')} vs ${dir}`)
    check(`${dir}: description 非空单行`, typeof data.description === 'string' && data.description.length > 0 && !data.description.includes('\n'))
    check(`${dir}: description 无 ASCII 冒号+空格`, !String(data.description || '').includes(': '))
    check(`${dir}: whenToUse 非空`, typeof data.whenToUse === 'string' && data.whenToUse.length > 0)
    check(`${dir}: user-invocable=true`, String(data['user-invocable'] || '').toLowerCase() === 'true')
    check(`${dir}: 正文非空`, body.replace(/\s/g, '').length > 200, `${body.split('\n').length} 行`)
    check(`${dir}: 无 TODO 占位符`, !/TODO|FIXME|待补充|占位/.test(raw))
  }

  // ── 2. 跑插件 apply，捕获 provider 与 /ima 命令 ──
  const plugin = require(path.join(ROOT, 'lib', 'index.js'))
  check('插件导出 name', plugin && plugin.name === 'dsh-ima', plugin && plugin.name)
  check('插件声明 inject', Array.isArray(plugin.inject) && plugin.inject.includes('tools'))

  const { ctx, captured } = makeCtx()
  try {
    plugin.apply(ctx)
  } catch (e) {
    check('插件 apply 不抛错', false, e.message)
    process.exit(1)
  }
  check('apply 注册了 skill provider', captured.providers.length === 1, `${captured.providers.length} 个`)
  if (!captured.providers.length) {
    console.log(`\n结果：${pass} 通过，${fail} 失败`)
    process.exit(1)
  }

  const provider = await captured.providers[0]()
  check('provider.name', provider && provider.name === 'dsh-ima', provider && provider.name)
  check('provider 有 list/get', typeof provider.list === 'function' && typeof provider.get === 'function')

  const candidates = await provider.list()
  check('list() 返回候选技能', Array.isArray(candidates) && candidates.length === dirs.length, `${candidates.length} 个`)

  for (const c of candidates || []) {
    check(`候选 ${c.name}: provider 归属`, c.provider === 'dsh-ima', c.provider)
    check(`候选 ${c.name}: source=plugin`, c.source === 'plugin', c.source)
    check(`候选 ${c.name}: rank 为有限数字`, Number.isFinite(c.rank), String(c.rank))
    check(`候选 ${c.name}: invocation 两个布尔`, typeof c.invocation?.modelInvocable === 'boolean' && typeof c.invocation?.userInvocable === 'boolean')
    check(`候选 ${c.name}: description 非空`, typeof c.description === 'string' && c.description.length > 0)
    check(`候选 ${c.name}: path 指向 SKILL.md`, typeof c.path === 'string' && fs.existsSync(c.path), c.path)
    check(`候选 ${c.name}: resourceBase 目录存在`, c.resourceBase?.kind === 'directory' && fs.existsSync(c.resourceBase.path || ''))

    const loaded = await provider.get(c)
    check(`取用 ${c.name}: 返回正文`, loaded && loaded.name === c.name && typeof loaded.content === 'string' && loaded.content.length > 0)
    check(`取用 ${c.name}: 不泄露 locator`, loaded && loaded.locator === undefined)
  }

  check('未知技能名返回 undefined', (await provider.get({ name: 'no-such-skill' })) === undefined)

  // ── 3. /ima 命令 ──
  check('注册了 /ima 命令', captured.commands.length === 1, `${captured.commands.length} 个`)
  const cmd = captured.commands[0]
  check('/ima: name', cmd && cmd.name === 'ima', cmd && cmd.name)
  check('/ima: 有 description', typeof cmd?.description === 'string' && cmd.description.length > 0)
  check('/ima: 有 input.hint', typeof cmd?.input?.hint === 'string', cmd?.input?.hint)
  check('/ima: 有 handler', typeof cmd?.handler === 'function')

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('未捕获错误：', e)
  process.exit(1)
})
