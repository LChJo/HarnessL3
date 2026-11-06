import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

export async function resolveSourceRoot(projectRoot) {
  let local = {}
  try { local = JSON.parse((await readFile(join(projectRoot, '.harness-local/source.json'), 'utf8')).replace(/^\uFEFF/, '')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`本机来源配置无法解析：${error.message}`) }
  const path = process.env.MGRP_SOURCE_ROOT ?? local.sourceRoot
  if (!path) throw new Error('请设置 MGRP_SOURCE_ROOT，或在 .harness-local/source.json 中配置 sourceRoot。来源工作区路径仅存本机。')
  return resolve(path)
}

export async function resolveSkillRoot(projectRoot) {
  let local = {}
  try { local = JSON.parse((await readFile(join(projectRoot, '.harness-local/skills.json'), 'utf8')).replace(/^\uFEFF/, '')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`本机技能路径配置无法解析：${error.message}`) }
  const path = process.env.HARNESS_SKILLS_ROOT ?? local.root ?? 'skills'
  if (typeof path !== 'string' || !path.trim()) throw new Error('技能路径应为非空目录；使用 HARNESS_SKILLS_ROOT 或 .harness-local/skills.json 的 root 配置。')
  return resolve(projectRoot, path)
}
