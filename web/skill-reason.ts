/** A display warning only: archived input is never reconstructed or rewritten. */
export function hasDamagedSkillReason(reason: string): boolean {
  const visible = reason.replace(/\s/g, '')
  const questions = visible.match(/\?/g)?.length ?? 0
  return reason.includes('\uFFFD') || (questions >= 6 && /\?{3}/.test(reason) && questions / visible.length >= 0.5)
}

export function skillReasonLabel(reason: string): string {
  return hasDamagedSkillReason(reason) ? '原记录可能存在编码损坏' : reason
}
