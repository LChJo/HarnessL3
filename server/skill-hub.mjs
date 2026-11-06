// Adapted from Matt Pocock's ask-matt, local source 2ab958093e83e0ec752e6c1c5932da465bf23e0c.
// Copyright (c) 2026 Matt Pocock, MIT; full notice in ../skills/LICENSE.
// Only the routing principles are built in. Available skills always come from editable files.
export const ROUTER_VERSION = 'skill-hub/harness-v2'
export const SKILL_HUB = `你是本次任务入口 Skill Hub 的技能路由者：按任务目的、已有依据、问题规模和当前阶段，选择最小且足够的一组技能文件引用。

先判断工作性质：已有明确依据的实现、尚需澄清的想法、难以复现的问题、代码审查、架构维护、研究、学习，或跨会话交接。只有缺少依据时才选澄清或研究；不要强迫已经清楚的任务重新走完整流程。只有确实跨多会话的大任务才选择规划/拆分路径。

技能可以组合；主流程、诊断入口、独立工具和词汇参考各有用途。根据技能的实际 description 判断适用性，必要时一起选择后续执行需要的辅助技能。不为每个技能启动一个模型，不按关键词表替代你的判断，不把所有候选都选上。

唯一可选名单是本次从实际文件派生的技能目录。不得凭记忆假定固定技能存在；增删、改名后，以当前目录为准。Skill Hub 已是入口能力，不再作为普通技能选入。related 只提示当前存在的关联技能，不自动选择；若本任务需要其方法，应一次共同选入。留意 diagnostics 中缺失引用，不虚构缺失能力。

技能是有版本的特殊文件引用，不是必须安装的 slash 命令或自动运行工具。先用简述和文件清单筛选；选择后先返回引用，需要方法正文时批量读取所选 SKILL.md，附件按需读取。不要把全部附件或未选正文塞入模型。脚本是文件，读取不等于执行。

CLI 负责记录、版本校验和提供文件，不负责运行整条技能工作流。后续回到当前 agent 的正常工作方式，遵守用户授权、目标项目 AGENTS.md 和真实工具能力；技能中的提交、外部写入、会话控制等不由路由阶段自动执行。`

export function selectionPrompt({ task, directories, catalog }) {
  return `# HarnessL3 任务入口
任务: ${JSON.stringify(task.title)}
task: ${task.id}
worktree: ${task.worktreeId}
sourceRoot: ${task.sourceRoot ?? '历史来源路径未记录'}
sourceVersion: ${JSON.stringify(task.sourceVersion ?? {})}
modelRevision: ${task.modelRevision}
catalogRevision: ${catalog.revision}
skillLibraryRoot: ${catalog.root ?? '未记录'}
router: ${ROUTER_VERSION}

## 内置 Skill Hub
${SKILL_HUB}

## 上下文筛选
复用你对稳定简述的筛选能力，判断需要哪些项目上下文。可以一次选择多个模块/分支，将 expand 和 read 合在一次选择中；已知 ID 可直达，不要求逐层逐项调用。目录披露与正文不同，父对象正文不等于整个子树，关系/证据引用不等于源文件已读。
先从提供的顶层简述选择；如还需要细层定位，后续用普通 context query 批量追加，保留真实依赖，不额外启动路径规划模型。只取任务相关内容，允许 read/expand 为空；上下文和技能是两种不同资源，分别给出选择。

## 顶层简述
${JSON.stringify(directories, null, 2)}

## 本次技能轻目录（没有加载全部技能正文）
${JSON.stringify(catalog.skills.map(({ id, name, description, group, related, diagnostics, fileCount }) => ({ id, name, description, group, ...(related?.length ? { related } : {}), ...(diagnostics?.length ? { diagnostics } : {}), fileCount })), null, 2)}

## 一次提交选择
将下列结构写入一个 UTF-8 JSON 文件；skills 是一次批量选择，可为空，每项 reason 说明为何本任务需要它。read/expand 使用实际对象 ID，skills.id 使用目录 ID。不要输出执行成功或伪造结果。
\`\`\`json
${JSON.stringify({ catalogRevision: catalog.revision, modelRevision: task.modelRevision, expand: [], read: [], skills: [{ id: '<目录中的技能ID>', reason: '<选择理由>' }] }, null, 2)}
\`\`\`
运行：node scripts/harness.mjs select ${task.id} --file <selection.json>
返回所选上下文包、版本化技能文件引用及交接说明后，按需批量读取所选方法文件，继续标准 agent 的上下文+skill 工作方式。CLI 不增加后续固定执行阶段。`
}

export function skillReferences(task) {
  const plan = task.skillPlan
  if (!plan) throw Object.assign(new Error('尚无已确认的技能选择，不能读取技能文件'), { status: 409 })
  return plan.skills.map(skill => ({ id: skill.id, name: skill.name, reason: skill.reason, path: skill.path, sourcePath: skill.sourcePath, contentHash: skill.contentHash,
    files: skill.files.map(({ content, ...file }) => ({ ...file, ref: `harness-skill://${task.id}/${skill.id}/${file.path.split('/').map(encodeURIComponent).join('/')}#${file.hash}` })) }))
}

// The API entrance is also lightweight in --json mode. Full bytes stay in the local
// archive and are fetched explicitly; browser task/history endpoints retain their archive view.
export function referenceSelection(result) {
  const task = structuredClone(result.task)
  for (const plan of [task.skillPlan, ...task.batches.map(batch => batch.skillPlan)].filter(Boolean)) {
    for (const skill of plan.skills) skill.files = skill.files.map(({ content, ...file }) => file)
  }
  return { ...result, task, references: skillReferences(result.task) }
}

export function handoffText(task) {
  const plan = task.skillPlan
  if (!plan) throw Object.assign(new Error('尚无已确认的技能选择，不能生成已准备好的交接包'), { status: 409 })
  const lines = [
    '# HarnessL3 标准 agent 交接', `任务: ${task.title}`, `task: ${task.id}`, `worktree: ${task.worktreeId}`,
    `来源工作区: ${task.sourceRoot ?? '历史来源路径未记录'}`, `来源版本: ${JSON.stringify(task.sourceVersion ?? {})}`,
    `技能源目录: ${task.skillRouting?.libraryRoot ?? '未记录；按需读取归档文件'}`,
    `模型: ${task.modelRevision}`, `技能目录: ${plan.catalogRevision}`, `路由: ${plan.routerVersion}`,
    '接下来由当前 agent 正常工作。下面提供所选上下文和版本化技能文件引用，不证明模型理解或技能执行。',
    '遵守用户指示和项目 AGENTS.md。技能是特殊文件引用，不要求宿主安装 /命令；只在需要时读取正文/附件，脚本不自动执行。related 不会自动加入方案，未选择的依赖或能力须核实。',
    '\n## 上下文包', JSON.stringify(task.packet, null, 2),
    '\n## 读取失败或未知', JSON.stringify(task.batches.filter(batch => batch.status === 'unknown' || batch.status === 'requested' || batch.result?.errors?.length).map(batch => ({ batchId: batch.id, status: batch.status, errors: batch.result?.errors ?? [], error: batch.error })), null, 2),
    '\n## 技能文件引用', JSON.stringify(skillReferences(task), null, 2),
  ]
  if (!plan.skills.length) lines.push('本次明确不需要额外技能。')
  if (plan.skills.length) {
    const through = task.history?.throughBatchId ?? task.batches.at(-1)?.id
    lines.push('\n## 按需读取', '将实际需要的文件写入 UTF-8 JSON：', JSON.stringify({ files: plan.skills.map(skill => ({ skillId: skill.id, path: 'SKILL.md' })) }, null, 2),
      `node scripts/harness.mjs read ${task.id} --file <files.json>${through ? ' --batch ' + through : ''}`,
      '一次可读多个已选文件；附件可在后续按需追加。读取返回选择时的归档字节及 SHA-256，源文件更新/删除也不会替换历史；查看/读取归档不延长 60 天窗口。',
      '直接文件工具仍可用；使用当前源文件前应核对上面的指纹，当前文件不冒充历史版本。')
  }
  return lines.join('\n')
}
