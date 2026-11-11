import test from 'node:test'
import assert from 'node:assert/strict'
import { asHarnessError, HarnessError } from '../../build/core/errors.js'
import { descriptor, inspectService } from '../../build/service/controller.js'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rename, rm, realpath } from 'node:fs/promises'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { scanSource } from '../../build/core/source.js'
import { Archive } from '../../build/core/archive.js'
import { randomUUID } from 'node:crypto'

const execFile = promisify(callbackExecFile)
const binary = fileURLToPath(new URL('../../bin/harnessl3.mjs', import.meta.url))
const installer = fileURLToPath(new URL('../../scripts/install-agent-skills.mjs', import.meta.url))

// Modify only this test's owned temporary files, then restore their original ACLs.
async function restrict(restorations, root, target, directory = false) {
  if (process.platform !== 'win32') {
    await chmod(target, directory ? 0o500 : 0)
    let restored = false
    const restore = async () => { if (!restored) { await chmod(target, directory ? 0o700 : 0o600); restored = true } }
    restorations.push(restore)
    return restore
  }
  // GitHub's Windows image exposes PowerShell 7 module roots through PSModulePath.
  // Windows PowerShell 5.1 may then resolve Microsoft.PowerShell.Security from
  // those incompatible binaries, so import the 5.1 module from $PSHOME and pin
  // the module path the child actually sees.
  const modulePath = [
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsPowerShell', 'Modules'),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents', 'WindowsPowerShell', 'Modules') : null,
  ].filter(item => item !== null).join(path.delimiter)
  const script = `
    $ErrorActionPreference = 'Stop'
    Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force
    $root = [IO.Path]::GetFullPath($env:L3_TEST_ROOT)
    $target = [IO.Path]::GetFullPath($env:L3_TEST_PATH)
    if (-not ([IO.Path]::GetFileName($root)).StartsWith('harnessl3-permission-') -or -not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe ACL fixture path' }
    $acl = Get-Acl -LiteralPath $target
    if ($env:L3_TEST_ACL) {
      $acl.SetSecurityDescriptorSddlForm($env:L3_TEST_ACL)
      Set-Acl -LiteralPath $target -AclObject $acl
    } else {
      $before = $acl.Sddl
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $rights = if ($env:L3_TEST_DIRECTORY -eq 'yes') { [Security.AccessControl.FileSystemRights]::CreateDirectories } else { [Security.AccessControl.FileSystemRights]::ReadData }
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, [Security.AccessControl.AccessControlType]::Deny))
      Set-Acl -LiteralPath $target -AclObject $acl
      [Console]::Out.Write($before)
    }
  `
  const invoke = acl => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, env: { ...process.env, PSModulePath: modulePath, L3_TEST_ROOT: root, L3_TEST_PATH: target, L3_TEST_DIRECTORY: directory ? 'yes' : '', L3_TEST_ACL: acl },
  })
  const { stdout } = await invoke('')
  let restored = false
  const restore = async () => { if (!restored) { await invoke(stdout); restored = true } }
  restorations.push(restore)
  return restore
}

for (const code of ['EACCES', 'EPERM']) test(`TC22 ${code} retains the failed path and operation with actionable permission diagnostics`, () => {
  const file = path.join(tmpdir(), 'L3 user data', 'service.json')
  const error = Object.assign(new Error('Access denied'), { code, path: file, syscall: 'open', token: 'must-not-copy', spawnargs: ['private'] })
  const result = asHarnessError(error)
  assert.equal(result.code, 'IO_ERROR')
  assert.equal(result.exitCode, 1)
  assert.equal(result.retryable, false)
  assert.equal(result.details.systemCode, code)
  assert.equal(result.details.reason, 'permission-denied')
  assert.equal(result.details.path, file)
  assert.equal(result.details.syscall, 'open')
  assert.ok(result.details.hint)
  assert.equal(JSON.stringify(result).includes('must-not-copy'), false)
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('TC22 permission diagnostics preserve existing business errors and do not label other IO failures as permissions', () => {
  const business = new HarnessError('IO_ERROR', 'Unknown write result', { outcome: 'unknown' }, true)
  assert.equal(asHarnessError(business), business)
  assert.equal(asHarnessError(Object.assign(new Error('Missing'), { code: 'ENOENT' })).details.reason, undefined)
  assert.equal(asHarnessError(new Error('Unexpected failure')).code, 'INTERNAL_ERROR')
})

test('TC22 permission failures inside source scanning and snapshot reads remain actionable IO errors', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'harnessl3-permission-')))
  const restorations = []
  t.after(async () => {
    for (const restore of restorations.reverse()) await restore()
    if (path.dirname(root) !== await realpath(tmpdir()) || !path.basename(root).startsWith('harnessl3-permission-')) throw new Error('Unsafe permission fixture cleanup')
    await rm(root, { recursive: true, force: true })
  })
  const sourceRoot = path.join(root, 'project'), id = randomUUID()
  await mkdir(path.join(sourceRoot, '.harness'), { recursive: true })
  const config = { schemaVersion: 1, projectId: id, name: 'Denied source', source: { excludePatterns: [] } }
  await writeFile(path.join(sourceRoot, '.harness/project.json'), JSON.stringify(config))
  const source = path.join(sourceRoot, 'code.js')
  await writeFile(source, 'preserved source bytes')
  const restoreSource = await restrict(restorations, root, source)
  const denied = await readFile(source).then(() => false, error => ['EACCES', 'EPERM'].includes(error.code))
  if (!denied) { await restoreSource(); t.skip('Current user can read permission-restricted files'); return }
  await assert.rejects(scanSource({ id: randomUUID(), projectId: id, kind: 'directory', root: sourceRoot, gitCommonDir: null, branch: null, active: true, available: true }, config, path.join(root, 'skills')), error => {
    assert.equal(error.code, 'IO_ERROR')
    assert.equal(error.details.reason, 'permission-denied')
    assert.equal(error.details.path, source)
    return true
  })
  await restoreSource()
  const archive = new Archive(path.join(root, 'archive'))
  const hash = await archive.snapshot('receipt', { preserved: true })
  const snapshot = path.join(root, 'archive', 'snapshots', hash + '.json')
  await restrict(restorations, root, snapshot)
  await assert.rejects(archive.readSnapshot(hash), error => {
    assert.equal(error.code, 'IO_ERROR')
    assert.equal(error.details.reason, 'permission-denied')
    assert.equal(error.details.path, snapshot)
    return true
  })
})

test('TC22/26 actual denied descriptor and skill writes preserve data and report permission errors', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'harnessl3-permission-')))
  const restorations = []
  const dataRoot = path.join(root, 'data'), skillsRoot = path.join(root, 'skills')
  await mkdir(dataRoot); await mkdir(skillsRoot)
  const file = path.join(dataRoot, 'service.json')
  const lock = path.join(dataRoot, 'service.lock')
  const bytes = '{"keep":"original descriptor"}\n'
  await writeFile(file, bytes)
  t.after(async () => {
    for (const restore of restorations.reverse()) await restore()
    await chmod(file, 0o600).catch(() => {}); await chmod(lock, 0o600).catch(() => {}); await chmod(skillsRoot, 0o700)
    if (path.dirname(root) !== await realpath(tmpdir()) || !path.basename(root).startsWith('harnessl3-permission-')) throw new Error('Unsafe permission fixture cleanup')
    await rm(root, { recursive: true, force: true })
  })
  const restoreFile = await restrict(restorations, root, file)
  const failure = await descriptor(dataRoot).then(() => null, error => error)
  if (process.platform !== 'win32' && !['EACCES', 'EPERM'].includes(failure?.code)) { await restoreFile(); t.skip('Current user can read files without POSIX read permission'); return }
  assert.equal(asHarnessError(failure).details.reason, 'permission-denied')
  assert.equal(asHarnessError(failure).details.path, file)
  const requestId = '5c29e148-bbb5-489b-9637-7167f26802dc'
  const cli = await execFile(process.execPath, [binary, 'project', 'list', '--data-dir', dataRoot, '--request-id', requestId, '--json']).catch(error => error)
  assert.equal(cli.code, 1)
  const envelope = JSON.parse(cli.stdout)
  assert.equal(envelope.ok, false)
  assert.equal(envelope.requestId, requestId)
  assert.equal(envelope.error.code, 'IO_ERROR')
  assert.equal(envelope.error.details.reason, 'permission-denied')
  assert.equal(envelope.error.details.path, file)
  await restoreFile()
  assert.equal(await readFile(file, 'utf8'), bytes)
  await rename(file, path.join(dataRoot, 'preserved-descriptor'))
  await writeFile(lock, '{"keep":"original lock"}\n')
  const restoreLock = await restrict(restorations, root, lock)
  await assert.rejects(inspectService(dataRoot), error => {
    assert.equal(asHarnessError(error).details.reason, 'permission-denied')
    assert.equal(asHarnessError(error).details.path, lock)
    return true
  })
  await restoreLock()
  assert.equal(await readFile(lock, 'utf8'), '{"keep":"original lock"}\n')
  await restrict(restorations, root, skillsRoot, true)
  const copy = await execFile(process.execPath, [installer, '--codex-skills-dir', skillsRoot, '--claude-skills-dir', path.join(root, 'claude')]).catch(error => error)
  assert.equal(copy.code, 1)
  assert.equal(copy.stdout, '')
  const report = JSON.parse(copy.stderr)
  assert.equal(report.code, 'IO_ERROR')
  assert.equal(report.details.reason, 'permission-denied')
  assert.ok(['EACCES', 'EPERM'].includes(report.details.systemCode))
  assert.ok(report.details.path.startsWith(skillsRoot))
  assert.equal(report.current.agent, 'codex')
  assert.deepEqual(report.results, [])
})
