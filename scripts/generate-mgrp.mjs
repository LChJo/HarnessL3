import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, sha256 } from '../server/evidence.mjs'
import { resolveSourceRoot } from '../server/config.mjs'

// Initial bootstrap only. Existing .c4 files are authoritative and never overwritten implicitly.
const repo = fileURLToPath(new URL('../', import.meta.url))
const source = await resolveSourceRoot(repo)
const output = join(repo, 'examples/mgrp')
const modelDir = join(output, 'model')
try { await access(join(modelDir, '01-project.c4')); if (!process.argv.includes('--force')) throw new Error('主模型已存在。请直接编辑 .c4；仅在明确重建样本时使用 --force。') } catch (e) { if (e.code !== 'ENOENT') throw e }
await mkdir(modelDir, { recursive: true })
const q = text => JSON.stringify(text)
const evidence = []
const cache = new Map()
async function proof(id, path, anchor, claim, type = 'source-code') {
  let bytes = cache.get(path)
  if (!bytes) { bytes = await readFile(join(source, path)); cache.set(path, bytes) }
  const lines = bytes.toString('utf8').split(/\r?\n/)
  const index = anchor ? lines.findIndex(line => line.includes(anchor)) : 0
  if (index < 0) throw new Error(`证据锚点不存在：${path} :: ${anchor}`)
  evidence.push({ id, path, startLine: Math.max(1, index - 2), endLine: Math.min(lines.length, index + 10), anchor: anchor ?? '',
    sha256: sha256(bytes), claim, type, verification: type === 'inference' ? 'unverified-inference' : 'source-inspected', runtimeVerified: false })
  return id
}
const defs = [
  ['mgrp', 'system', 'MGRP', '跨平台游戏资源下载与更新 SDK。以当前工作区源码为依据，表达入口、业务编排、任务执行、网络后端与本地持久化。', 'README.md', '跨平台', 'project'],
  ['mgrp.clients', 'module', '平台接入', 'Unity C#、Android JNI、iOS 与 HarmonyOS 的宿主接入。平台封装与核心网络后端是两个不同边界。', 'src/platforms/README.md', '', 'platforms'],
  ['mgrp.clients.unity', 'component', 'Unity C# 接口', 'DownloadInterface 声明原生调用边界；宿主以帧更新分发回调。', 'src/platforms/Unity3D/Downloader/Runtime/Impletion/DownloadInterface.cs', 'DllImport', 'Unity / C#'],
  ['mgrp.clients.android', 'component', 'Android JNI', 'Java 调用到内部 C ABI 的 JNI 适配。', 'src/platforms/Android/mgrp/src/main/cpp/mgrp_android_jni_adapter.cpp', '#include', 'Android / JNI'],
  ['mgrp.clients.ios', 'component', 'iOS Bootstrap', '安装 iOS 平台服务和生命周期支持。', 'src/platforms/iOS/mgrp/MGRPIOSPlatformBootstrap.mm', '#include', 'iOS / Objective-C++'],
  ['mgrp.clients.harmony', 'component', 'HarmonyOS N-API', 'ArkTS 与原生 SDK 的 N-API 边界。', 'src/platforms/Harmony/mgrp/src/main/cpp/mgrp_harmony_napi.cpp', '#include', 'HarmonyOS / N-API'],
  ['mgrp.api', 'module', 'C ABI 导出', '稳定公共接口与平台内部接口。参数、回调与错误码在此跨语言桥接。', 'src/mgrp/export/mgrp_capi.h', 'Stable C ABI', 'C ABI'],
  ['mgrp.api.capi', 'component', 'mgrp_capi', '公共导出入口，连接 DownloadManager、ResourceManager 等业务能力。', 'src/mgrp/export/mgrp_capi.cpp', '#include "mgrp/business/download_manager.h"', 'C / C++'],
  ['mgrp.business', 'module', '业务编排', '决定下载什么、资源差异和批次优先级，维护资源包语义。', 'src/mgrp/business/download_manager.h', 'business-layer authority', 'src/mgrp/business'],
  ['mgrp.business.download', 'component', 'DownloadManager', '下载批次的业务入口。决定下载对象和优先级，委托 TaskManager 执行；候选筛选委托 ResourceManager。', 'src/mgrp/business/download_manager.h', 'business-layer authority', 'C++ / batch lifecycle'],
  ['mgrp.business.resource', 'component', 'ResourceManager', '资源元数据、查询、本地校验及下载候选计算。', 'src/mgrp/business/resource_manager.h', 'class ResourceManager', 'C++ / resource catalog'],
  ['mgrp.business.patch', 'component', 'PatchManager', '差分包应用与路由，参与下载批次的 patch 预处理。', 'src/mgrp/business/patch_manager.h', 'class PatchManager', 'C++ / patch'],
  ['mgrp.execution', 'module', '任务执行', '任务门面、唯一可变调度状态、资源传输协调与持久化发布。旧文档的 DataManager 不再作为当前对象。', 'src/mgrp/impl/task_manager.h', 'sole mutable execution state', 'src/mgrp/impl'],
  ['mgrp.execution.task', 'component', 'TaskManager', '进程级执行门面；DTask 是业务查询投影，TaskScheduler 持有可变执行状态。', 'src/mgrp/impl/task_manager.h', 'Process-wide', 'C++ / execution facade'],
  ['mgrp.execution.scheduler', 'component', 'TaskScheduler', '消费调度事件、执行计划与任务优先级变更。', 'src/mgrp/impl/task_scheduler.h', 'class TaskScheduler {', 'C++ / state machine'],
  ['mgrp.execution.transfer', 'component', 'ResourceTransferCoordinator', '以资源身份、存储域和 generation 协调传输与发布。', 'src/mgrp/impl/resource_transfer_coordinator.h', 'class ResourceTransferCoordinator :', 'C++ / resource identity'],
  ['mgrp.execution.artifact', 'component', 'ResourceArtifactStore', '资源产物与完成证据的持久化接口。', 'src/mgrp/impl/resource_artifact_store.h', 'class ResourceArtifactStore {', 'C++ / durable artifacts'],
  ['mgrp.network', 'module', '网络与平台后端', '网络管理使用统一接口，工厂根据编译平台选择具体后端。', 'src/mgrp/foundation/platform_backend.cpp', 'CreatePlatformBackend()', 'impl + foundation'],
  ['mgrp.network.manager', 'component', 'NetworkManager', '请求生命周期、多来源与网络管理；通过工厂获得 INetworkBackend。', 'src/mgrp/impl/network_manager.cpp', 'INetworkBackend* backend = CreatePlatformBackend()', 'C++ / transport'],
  ['mgrp.network.backend', 'component', 'INetworkBackend', '统一创建、启动、暂停和销毁网络请求的接口，隔离平台差异。', 'src/mgrp/foundation/i_network_backend.h', 'class INetworkBackend', 'C++ / interface'],
  ['mgrp.network.factory', 'component', '平台后端工厂', '编译条件选择 WinHTTP、OkHttp、NSURLSession 或 OHRcp。', 'src/mgrp/foundation/platform_backend.cpp', 'INetworkBackend* CreatePlatformBackend()', 'C++ / factory'],
  ['mgrp.network.winhttp', 'component', 'WinHTTP', 'Windows 网络后端，实现统一接口。', 'src/mgrp/foundation/winhttp_backend.h', 'class WinHttpBackend', 'Windows / WinHTTP'],
  ['mgrp.network.okhttp', 'component', 'OkHttp', 'Android 网络后端，实现统一接口。', 'src/mgrp/foundation/okhttp_backend.h', 'class OkHttpBackend', 'Android / OkHttp'],
  ['mgrp.network.nsurlsession', 'component', 'NSURLSession', 'iOS 前台网络后端，实现统一接口。后台机制另有实现，本原型不展开。', 'src/mgrp/foundation/nsurlsession_backend.h', 'class NSURLSessionBackend', 'iOS / NSURLSession'],
  ['mgrp.network.ohrcp', 'component', 'OHRcp', 'HarmonyOS RCP 网络后端，实现统一接口。', 'src/mgrp/foundation/ohrcp_backend.h', 'class OHRcpBackend', 'HarmonyOS / RCP'],
  ['mgrp.common', 'module', '业务公共支持', '配置、下载进度与观测公共能力。', 'src/mgrp/common/CMakeLists.txt', 'add_library', 'src/mgrp/common'],
  ['mgrp.common.config', 'component', 'ConfigStore', '维护下载设置等本地配置。', 'src/mgrp/common/config_store.h', 'class ConfigStore', 'C++ / settings'],
  ['mgrp.common.progress', 'component', 'FileProgressStore', '维护文件下载进度与恢复相关状态。', 'src/mgrp/common/file_progress_store.h', 'class FileProgressStore', 'C++ / resume'],
  ['mgrp.common.telemetry', 'component', 'TelemetryCenter', '统一收集下载过程统计事件。', 'src/mgrp/common/telemetry_center.h', 'class TelemetryCenter', 'C++ / telemetry'],
  ['mgrp.base', 'module', '公共基础库', '文件 IO、哈希、JSON、日志、内存等基础封装。根 CMake 采用单 SDK target 构建，不等同于此逻辑分层。', 'src/base/CMakeLists.txt', 'add_library(base', 'src/base'],
  ['mgrp.base.fileio', 'component', 'RawFile', '跨平台文件读写接口及错误语义。', 'src/base/raw_file.h', 'class RawFile', 'C++ / file IO'],
  ['mgrp.base.hash', 'component', 'Hash', 'XXH3 等哈希封装。', 'src/base/hash.h', '#pragma once', 'C++ / XXH3'],
  ['mgrp.vendor', 'module', '第三方源码', 'fmt/fmtlog、yyjson、xxhash、HDiffPatch；主要由基础层封装，具体 include 以代码为准。', 'src/vendor/README.md', '第三方源码', 'vendored C / C++'],
  ['mgrp.tooling', 'module', '资源打包工具', 'Python 打包与差分工具。与运行时 SDK 是不同执行入口。', 'tools/mgrp_pack_scripts/README.md', '', 'Python'],
  ['mgrp.tooling.pack', 'component', 'mgrp.py', '离线构建 MGRP 资源包。', 'tools/mgrp_pack_scripts/mgrp.py', '', 'Python / package generation'],
  ['mgrp.tooling.patch', 'component', 'patch.py', '离线 patch / 解包工具。', 'tools/mgrp_pack_scripts/patch.py', '', 'Python / patch tooling'],
  ['mgrp.quality', 'module', '测试与质量', '下载行为、ABI 与架构约束测试的入口；本次未运行 MGRP SDK 测试。', 'tests/unit_test/CMakeLists.txt', '', 'tests/unit_test'],
  ['mgrp.quality.download', 'component', '下载管理测试', 'DownloadManager 单元测试，表达批次行为契约。存在测试不代表本次运行通过。', 'tests/unit_test/test_download_manager.cpp', '#include', 'C++ / unit test'],
  ['mgrp.quality.architecture', 'component', '架构分层检查', '以 Python 规则检查源代码分层边界。', 'tests/unit_test/test_arch_layering.py', '', 'Python / architecture guard'],
  ['mgrp.knowledge', 'document', '项目约定与现状', '项目说明是知识来源之一。AGENTS 的 DataManager 和里程碑描述与源码/状态文件存在偏差，需保留待核验。', 'AGENTS.md', 'Module Ownership', 'documentation']
]
const ids = new Set(defs.map(d => d[0]))
const byId = new Map(defs.map(d => [d[0], d]))
const objectProof = new Map()
for (const [id, , title, , path, anchor] of defs) objectProof.set(id, await proof(`e-${id.replaceAll('.', '-')}`, path, anchor, `${title} 的选取依据`, path.endsWith('.md') ? 'documentation' : 'source-code'))

const relationDefs = [
  ['mgrp.clients.unity', 'mgrp.api', 'wraps', 'P/Invoke 原生 ABI', 'src/platforms/Unity3D/Downloader/Runtime/Impletion/DownloadInterface.cs', 'DllImport'],
  ['mgrp.clients.android', 'mgrp.api', 'wraps', 'JNI → 内部 ABI', 'src/platforms/Android/mgrp/src/main/cpp/mgrp_android_jni_adapter.cpp', 'mgrp_capi'],
  ['mgrp.api.capi', 'mgrp.business.download', 'depends_on', '导出层引用下载业务', 'src/mgrp/export/mgrp_capi.cpp', '#include "mgrp/business/download_manager.h"'],
  ['mgrp.api.capi', 'mgrp.business.resource', 'depends_on', '导出层引用资源管理', 'src/mgrp/export/mgrp_capi.cpp', '#include "mgrp/business/resource_manager.h"'],
  ['mgrp.business.download', 'mgrp.business.resource', 'calls', '查询下载候选', 'src/mgrp/business/download_manager.cpp', 'ResourceManager::Instance().NeedsDownloadForPackage'],
  ['mgrp.business.download', 'mgrp.execution.task', 'depends_on', '委托任务执行', 'src/mgrp/business/download_manager.cpp', '#include "mgrp/impl/task_manager.h"'],
  ['mgrp.business.download', 'mgrp.business.patch', 'depends_on', 'patch 路由与预处理', 'src/mgrp/business/download_manager.cpp', '#include "mgrp/business/patch_manager.h"'],
  ['mgrp.business.download', 'mgrp.execution.transfer', 'depends_on', '资源传输协调', 'src/mgrp/business/download_manager.cpp', '#include "mgrp/impl/resource_transfer_coordinator.h"'],
  ['mgrp.execution.task', 'mgrp.execution.scheduler', 'calls', '持有并驱动调度器', 'src/mgrp/impl/task_manager.cpp', 'scheduler_.Reset()'],
  ['mgrp.execution.task', 'mgrp.network.manager', 'calls', '创建网络请求', 'src/mgrp/impl/task_manager.cpp', 'NetworkManager::Instance().CreateRequest(desc)'],
  ['mgrp.business.resource', 'mgrp.execution.artifact', 'depends_on', '引用资源完成证据', 'src/mgrp/business/resource_manager.cpp', '#include "mgrp/impl/resource_artifact_store.h"'],
  ['mgrp.execution.transfer', 'mgrp.base.fileio', 'inferred', '传输最终落盘（概念路径）', 'src/mgrp/impl/resource_transfer_coordinator.h', 'ResourcePathKey'],
  ['mgrp.network.manager', 'mgrp.network.factory', 'calls', '获得平台后端', 'src/mgrp/impl/network_manager.cpp', 'INetworkBackend* backend = CreatePlatformBackend()'],
  ['mgrp.network.manager', 'mgrp.network.backend', 'depends_on', '统一网络接口', 'src/mgrp/impl/network_manager.h', 'i_network_backend'],
  ['mgrp.network.winhttp', 'mgrp.network.backend', 'implements', '实现接口', 'src/mgrp/foundation/winhttp_backend.h', 'public INetworkBackend'],
  ['mgrp.network.okhttp', 'mgrp.network.backend', 'implements', '实现接口', 'src/mgrp/foundation/okhttp_backend.h', 'public INetworkBackend'],
  ['mgrp.network.nsurlsession', 'mgrp.network.backend', 'implements', '实现接口', 'src/mgrp/foundation/nsurlsession_backend.h', 'public INetworkBackend'],
  ['mgrp.network.ohrcp', 'mgrp.network.backend', 'implements', '实现接口', 'src/mgrp/foundation/ohrcp_backend.h', 'public INetworkBackend'],
  ['mgrp.network.factory', 'mgrp.network.winhttp', 'calls', '_WIN32', 'src/mgrp/foundation/platform_backend.cpp', 'static WinHttpBackend'],
  ['mgrp.network.factory', 'mgrp.network.okhttp', 'calls', '__ANDROID__', 'src/mgrp/foundation/platform_backend.cpp', 'static OkHttpBackend'],
  ['mgrp.network.factory', 'mgrp.network.nsurlsession', 'calls', '__APPLE__', 'src/mgrp/foundation/platform_backend.cpp', 'static NSURLSessionBackend'],
  ['mgrp.network.factory', 'mgrp.network.ohrcp', 'calls', '__OHOS__', 'src/mgrp/foundation/platform_backend.cpp', 'static OHRcpBackend'],
  ['mgrp.business.download', 'mgrp.common.config', 'depends_on', '读取下载配置', 'src/mgrp/business/download_manager.h', '#include "mgrp/common/config_store.h"'],
  ['mgrp.network.manager', 'mgrp.common.telemetry', 'depends_on', '网络观测', 'src/mgrp/impl/network_manager.cpp', '#include "mgrp/common/telemetry_center.h"'],
  ['mgrp.execution.task', 'mgrp.base.fileio', 'depends_on', '文件 IO', 'src/mgrp/impl/task_manager.h', '#include "base/raw_file.h"'],
  ['mgrp.business.resource', 'mgrp.base.hash', 'depends_on', '资源哈希', 'src/mgrp/business/resource_manager.cpp', '#include "base/hash.h"'],
  ['mgrp.common', 'mgrp.base', 'depends_on', '基础封装', 'src/mgrp/common/CMakeLists.txt', 'target_link_libraries(mgrp_common PRIVATE base)'],
  ['mgrp.base', 'mgrp.vendor', 'depends_on', '封装第三方库', 'src/base/CMakeLists.txt', 'vendor_fmtlog'],
  ['mgrp.quality.download', 'mgrp.business.download', 'validates', '验证业务行为（未执行）', 'tests/unit_test/test_download_manager.cpp', 'download_manager'],
  ['mgrp.quality.architecture', 'mgrp.base', 'validates', '检查分层约束（未执行）', 'tests/unit_test/test_arch_layering.py', 'base'],
  ['mgrp.knowledge', 'mgrp.business', 'documents', '历史说明，需对照源码', 'AGENTS.md', 'Module Ownership'],
  ['mgrp.tooling.pack', 'mgrp.business.resource', 'inferred', '资源包格式连接（概念）', 'tools/mgrp_pack_scripts/mgrp.py', '']
]
const relations = []
for (let i = 0; i < relationDefs.length; i++) {
  const [from, to, kind, title, path, anchor] = relationDefs[i]
  const id = `r-${String(i + 1).padStart(2, '0')}`
  const sourceType = kind === 'inferred' ? 'inference' : path.endsWith('.md') ? 'documentation' : 'source-code'
  const ev = await proof(id, path, anchor, title, sourceType)
  relations.push(`  ${from} -[${kind}]-> ${to} ${q(title)} {\n    metadata { evidence ${q(ev)} source ${q(sourceType)} status ${q(kind === 'inferred' ? 'unverified' : 'source-inspected')} stable_id ${q(id)} }\n  }`)
}

function element(id, indent = '  ', includeChildren = true) {
  const [, kind, title, desc, path, , tech] = byId.get(id)
  const children = defs.filter(d => d[0].startsWith(id + '.') && d[0].slice(id.length + 1).indexOf('.') < 0)
  return `${indent}${id.split('.').at(-1)} = ${kind} ${q(title)} {\n${indent}  description ${q(desc)}\n${indent}  technology ${q(tech)}\n${indent}  metadata {\n${indent}    source ${q(path.endsWith('.md') ? 'documentation' : 'source-code')}\n${indent}    evidence ${q(objectProof.get(id))}\n${indent}    status ${q(path.endsWith('.md') ? 'needs-source-review' : 'source-inspected')}\n${indent}    path ${q(path)}\n${indent}    stable_id ${q(id)}\n${indent}  }\n${includeChildren ? children.map(c => element(c[0], indent + '  ', false)).join('\n') : ''}\n${indent}}`
}

const specification = `// LikeC4 主模型：由实际 mgrp 源码创建；生成后直接维护这些文本。\nspecification {\n  element system { style { color slate } }\n  element module { style { color blue } }\n  element component { style { color gray } }\n  element document { style { color amber shape document } }\n  relationship depends_on\n  relationship calls\n  relationship wraps\n  relationship implements\n  relationship validates { color green line dashed }\n  relationship documents { color amber line dashed }\n  relationship inferred { color amber line dotted }\n}\n`
await writeFile(join(modelDir, '00-specification.c4'), specification)
await writeFile(join(modelDir, '01-project.c4'), `model {\n${element('mgrp')}\n}\n`)
const moduleDefs = defs.filter(d => d[0].split('.').length === 2)
for (let i = 0; i < moduleDefs.length; i++) {
  const id = moduleDefs[i][0]
  const children = defs.filter(d => d[0].startsWith(id + '.') && d[0].split('.').length === 3)
  if (children.length) await writeFile(join(modelDir, `${String(10 + i).padStart(2, '0')}-${id.split('.').at(-1)}.c4`), `// 局部维护入口；与 01-project.c4 共享同一稳定对象身份。\nmodel {\n  extend ${id} {\n${children.map(c => element(c[0], '    ')).join('\n')}\n  }\n}\n`)
}
await writeFile(join(modelDir, '02-relations.c4'), `// calls 是已核对源码调用点；depends_on 仅表示静态引用；inferred 明示推断。\nmodel {\n${relations.join('\n')}\n}\n`)
await writeFile(join(modelDir, '03-views.c4'), `views {\n  view index {\n    title "项目总览"\n    description "MGRP 的逻辑职责分层；边来自细粒度关系聚合，不表示独立部署服务。"\n    include mgrp.*\n    style * { size xs textSize xl }\n    autoLayout LeftRight 30 40\n  }\n  view download {\n    title "下载执行路径"\n    description "从跨语言入口到业务、调度、网络和资源产物。静态源码审查，不是运行时追踪。"\n    include mgrp.clients.unity, mgrp.api.capi, mgrp.business.download, mgrp.business.resource, mgrp.business.patch, mgrp.execution.task, mgrp.execution.scheduler, mgrp.execution.transfer, mgrp.execution.artifact, mgrp.network.manager, mgrp.network.factory, mgrp.network.backend, mgrp.base.fileio\n    style * { size xs textSize xl }\n    autoLayout LeftRight 30 40\n  }\n  view platforms {\n    title "跨平台网络后端"\n    description "平台接入与网络后端分开呈现；统一接口和编译条件工厂连接具体实现。"\n    include mgrp.clients.*, mgrp.api, mgrp.network.*\n    style * { size xs textSize xl }\n    autoLayout TopBottom 30 40\n  }\n  view dependencies {\n    title "核心模块依赖"\n    description "聚合静态 include / 链接依赖；根 CMake 实际构建单 SDK target。"\n    include mgrp.api, mgrp.business, mgrp.execution, mgrp.network, mgrp.common, mgrp.base, mgrp.vendor\n    style * { size xs textSize xl }\n    autoLayout TopBottom 30 40\n  }\n  view quality {\n    title "证据与质量"\n    description "测试和文档与业务对象的关系；不代表本次运行过这些 SDK 测试。"\n    include mgrp.quality.*, mgrp.knowledge, mgrp.business.download, mgrp.base, mgrp.tooling.*\n    style * { size xs textSize xl }\n    autoLayout LeftRight 30 40\n  }\n}\n`)
await proof('e-review-current-milestone', '.claude/progress/session-state.json', '"current_milestone":', '当前状态文件记录 ms10-7，与 AGENTS 的 ms10-5 导航不同。', 'documentation')
await proof('e-review-obsolete-datamanager', 'AGENTS.md', '| impl |', '历史职责说明仍列 DataManager；当前模型未照搬这个缺失对象。', 'documentation')
const files = [...new Set(evidence.map(e => e.path))]
const identity = await fingerprint(source, files)
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
const manifest = { schemaVersion: '0.1', project: { id: 'mgrp', title: 'MGRP', description: '跨平台游戏资源下载更新 SDK' },
  version: { branch: git('branch', '--show-current'), commit: git('rev-parse', 'HEAD'), dirty: !!git('status', '--porcelain'), evidenceDigest: identity.digest, capturedAt: new Date().toISOString(),
    scope: 'selected-files', note: 'SHA-256 识别所引文件的实际内容（含未提交修改）；不代表所有源码已经语义核验。' }, evidence,
  review: { status: 'prototype-source-reviewed', objectCount: ids.size, relationshipCount: relationDefs.length,
    questions: [
      { id: 'Q1', title: '改下载批次行为，应先读哪里？', answer: '业务 DownloadManager → TaskManager / TaskScheduler，再按关联证据核对调用点。', view: 'download', object: 'mgrp.business.download' },
      { id: 'Q2', title: '新增网络后端会影响什么？', answer: 'INetworkBackend 契约、平台工厂和对应平台实现；平台宿主桥接另行核查。', view: 'platforms', object: 'mgrp.network.backend' },
      { id: 'Q3', title: '图上的关系有多可信？', answer: 'depends_on 只证明静态引用，calls 有源码调用点，inferred 是待验证概念连接。点击对象或关系查看证据。', view: 'dependencies', object: 'mgrp.execution.task' },
      { id: 'Q4', title: '现有说明哪里可能误导 agent？', answer: 'AGENTS/CMake 注释仍提到已不存在的 DataManager；AGENTS 的 ms10-5 与实际 session-state 的 ms10-7 不一致。模型采用当前源码。', view: 'quality', object: 'mgrp.knowledge' }
    ], limitations: ['非全量符号索引；仅覆盖所选职责、对象和证据文件。', '调用关系来自静态源码核对，不是运行时执行记录。', 'SDK 的 C++/平台测试本轮未执行。', '对象重命名后的引用迁移仍由人工维护。', 'agent 轨迹仅覆盖明确支持和可识别的日志操作。'] } }
await writeFile(join(output, 'evidence.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ modelDir, objects: ids.size, relations: relationDefs.length, evidence: evidence.length, files: files.length, version: manifest.version }, null, 2))
