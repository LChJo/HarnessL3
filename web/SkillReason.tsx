import { hasDamagedSkillReason, skillReasonLabel } from './skill-reason'
import './skill-reason.css'

export function SkillReason({ reason }: { reason: string }) {
  return <>
    <p className="skill-reason">选择理由：{skillReasonLabel(reason)}</p>
    {hasDamagedSkillReason(reason) && <details className="skill-reason-raw"><summary>查看理由原文</summary><pre>{reason}</pre></details>}
  </>
}
