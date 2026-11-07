import test from 'node:test'
import assert from 'node:assert/strict'
import { skillReasonLabel, hasDamagedSkillReason } from '../../web/skill-reason.ts'

test('TC21 damaged archived reasons get a display warning without changing the saved text', () => {
  const saved = '??HEAD??????????????????????????????'
  assert.equal(hasDamagedSkillReason(saved), true)
  assert.equal(skillReasonLabel(saved), '原记录可能存在编码损坏')
  assert.equal(saved, '??HEAD??????????????????????????????')
  assert.equal(hasDamagedSkillReason('检查\uFFFD\uFFFD异常'), true)
})

test('TC21 valid multilingual reasons, questions and code keep their exact display', () => {
  for (const reason of ['与 HEAD 比较，核对规格和标准。', 'Review the diff against HEAD', '为什么需要它？', 'Why?', 'Review ?? and ?. operators', '测试中文、日本語、🙂']) {
    assert.equal(hasDamagedSkillReason(reason), false, reason)
    assert.equal(skillReasonLabel(reason), reason)
  }
})
