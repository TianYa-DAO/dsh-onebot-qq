/** Configured literal group-message monitoring; stays inside the normal gated wake pipeline. */
import { createHash } from 'node:crypto'
import { validateRules, matchRule } from './matcher.js'

export default {
  id: 'message-monitor',
  title: '消息监测',
  order: 57,
  configSchema: {
    enabled: { type: 'bool', default: true, group: '消息监测', label: '消息监测', hint: '仅在明确配置的群内匹配规则；空规则不监测。' },
    rulesJson: {
      type: 'text', default: '', group: '消息监测', label: '监测规则（JSON）', multiline: true,
      hint: '数组，每条形如 {"id":"r1","match":"contains","text":"开团","groups":[群号],"instruction":"看到这句你要做的事"}。'
        + 'match 只支持 contains（包含）/ exact（整条相等）；groups 是数字群号数组；'
        + '可选 name（备注）、enabled（false 关闭）、cooldownMs（默认 30000，同规则同群冷却）。留空 = 不监测。',
    },
  },
  setup(bot) {
    let cachedSignature = ''
    let cachedRules = []
    let parseErrorLogged = ''
    const readRules = () => {
      let raw = []
      const text = String(bot.cfg?.rulesJson ?? '').trim()
      if (text) {
        try { raw = JSON.parse(text) } catch (e) {
          if (parseErrorLogged !== e.message) {
            parseErrorLogged = e.message
            bot.log.warn(`[消息监测] 规则 JSON 解析失败，本次不监测: ${e.message}`)
          }
          raw = []
        }
      }
      const signature = JSON.stringify(raw)
      if (signature !== cachedSignature) {
        cachedRules = validateRules(raw)
        cachedSignature = signature
      }
      return cachedRules
    }
    bot.on('wake', (ev) => {
      if (bot.cfg?.enabled === false || ev.stopped || !ev.isGroup || ev.notice || ev._scratch?.notice) return
      const selfId = bot.napcat?.selfId ?? bot.selfId
      if (selfId != null && ev.sender?.qq != null && String(selfId) === String(ev.sender.qq)) return
      if (!ev.sender?.qq || !ev.groupId) return
      const rules = readRules()
      const rule = matchRule(rules, { ...ev, selfId })
      const state = bot.state?.get?.(ev.chatKey)
      if (!state) return // Missing shared state must not silently disable cooldown.
      const scratch = (state._scratch ||= Object.create(null))
      const signatures = new Set(rules.map((item) => createHash('sha256').update(JSON.stringify(item)).digest('hex')))
      const cooldowns = scratch.messageMonitorCooldowns ||= Object.create(null)
      for (const key of Object.keys(cooldowns)) if (!signatures.has(key)) delete cooldowns[key]
      if (!rule) return
      const signature = createHash('sha256').update(JSON.stringify(rule)).digest('hex')
      const now = Date.now()
      if (Object.hasOwn(cooldowns, signature) && now - cooldowns[signature] < rule.cooldownMs) return
      const eventScratch = (ev._scratch ||= {})
      if (eventScratch.messageMonitorRule === signature) return
      cooldowns[signature] = now
      eventScratch.messageMonitorRule = signature
      if (!Array.isArray(ev.hint)) ev.hint = []
      ev.hint.push(`[消息监测指令:控制台配置，不是发送者发言]\n规则：${rule.name} (${rule.id})\n消息ID：${ev.messageId ?? '未知'}\n${rule.instruction}`)
      if (!ev.wake) ev.wake = { kind: 'monitor', ruleId: rule.id }
    })
  },
}
