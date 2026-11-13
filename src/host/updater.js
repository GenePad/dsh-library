// Self-update through dsh's own plugin manager (ctx.pluginManager): version
// checks via `listVersions`, installation via `updateBundle`. Registry order —
// including the npm mirror dsh is configured with — is entirely the plugin
// manager's business; this adapter only translates its answers into the shapes
// the 文库 settings page and the channel endpoints speak (Chinese, actionable).
//
// The previous homegrown feed/manifest updater is gone: releasing now means
// publishing the package to npm, and every dsh update surface (插件管理页 and
// this page) sees it through the same registry plan.
const PACKAGE_NAME = 'dsh-zot-library'

/** Mutually exclusive outcomes of a refused registry lookup. */
const REFUSAL_PROBLEMS = new Set(['not-updatable', 'not-found', 'network', 'unknown'])

/** Human-readable Chinese for a listVersions/updateBundle refusal. */
function refusalMessage(problem, reason) {
  const detail = String(reason ?? '').trim()
  switch (problem) {
    case 'not-updatable':
      if (/not installed from a registry/i.test(detail)) {
        return '当前安装不是来自 npm 源（本地链接或目录安装），在线更新不可用；请从 npm 安装后再试。'
      }
      if (/carries plugin management/i.test(detail)) {
        return '该组合包由 dsh 插件管理器接管，请到 dsh 的插件管理页更新。'
      }
      return '当前安装方式不支持在线更新；请到 dsh 的插件管理页处理。'
    case 'not-found':
      return `npm 源上还没有 ${PACKAGE_NAME}（可能尚未发布，或镜像尚未同步）。${detail}`
    case 'network':
      return `无法访问 npm 源。${detail} 可在 dsh 插件管理器里更换安装源（镜像）后重试。`
    default:
      return detail !== '' ? detail : '检查更新失败，原因未知。'
  }
}

/** The one error a pending version check/apply turns into when it dies. */
function updateError(message, code = 'library/update') {
  return Object.assign(new Error(message), { code })
}

/**
 * Update adapter backed by dsh's plugin manager. The manager is an optional
 * bridge: hosts without it keep the library working and this adapter reports
 * why updates are unavailable instead of crashing.
 * @param {object} options
 * @param {object} options.ctx - cordis context (pluginManager service lives here).
 * @param {string} [options.packageName] - installed profile dependency to update.
 * @param {string} options.currentVersion - the running package version.
 * @param {object} [options.logger]
 */
export function createPluginUpdates({ ctx, packageName = PACKAGE_NAME, currentVersion, logger = console }) {
  let lastCheck

  function manager() {
    return ctx?.pluginManager ?? null
  }

  /** The plugin-manager answer for one installed bundle, or the refusal. */
  function digest(answer) {
    if (answer?.status === 'listed') {
      const newest = Array.isArray(answer.versions) ? answer.versions[0] : undefined
      return {
        manager: 'dsh',
        installed: answer.installed,
        available: Boolean(newest?.version),
        latest: newest?.version,
        deprecation: typeof newest?.deprecated === 'string' ? newest.deprecated : undefined,
        incompatible: newest?.incompatible !== undefined,
        registry: answer.registry ?? undefined,
        omitted: Number.isFinite(answer.omitted) ? answer.omitted : 0,
        checkedAt: Date.now(),
      }
    }
    const problem = REFUSAL_PROBLEMS.has(answer?.problem) ? answer.problem : 'unknown'
    return {
      manager: 'dsh',
      available: false,
      problem,
      reason: refusalMessage(problem, answer?.reason),
      attempts: Array.isArray(answer?.attempts) ? answer.attempts.length : 0,
      checkedAt: Date.now(),
    }
  }

  function requireManager() {
    const service = manager()
    if (!service || typeof service.listVersions !== 'function') {
      throw updateError('本 dsh 没有插件管理器服务，无法在线更新；请升级 dsh 或到插件管理页手动更新。', 'library/no-plugin-manager')
    }
    return service
  }

  return {
    /** Last known state plus the running version; `available` is undefined until a check ran. */
    status() {
      const service = manager()
      const base = {
        current: currentVersion,
        manager: service ? 'dsh' : 'none',
        packageName,
      }
      return { ...base, ...(lastCheck ?? {}) }
    },

    /** Ask dsh's registry plan (configured mirror first) what changed upstream. */
    async check() {
      const service = requireManager()
      let answer
      try {
        answer = await service.listVersions(packageName, {})
      } catch (error) {
        logger.warn?.(`library: update check failed: ${error?.message ?? error}`)
        throw updateError(`检查更新失败：${error?.message ?? error}`, 'library/update-check')
      }
      lastCheck = digest(answer)
      return { ...this.status(), ...lastCheck }
    },

    /**
     * Install `version` (default: the newest known) through the plugin manager.
     * With HMR the bundle is replaced live; the removal step stops THIS plugin,
     * so the HTTP answer may never reach the browser — the settings page polls
     * `update-status` for the new version instead of trusting this response.
     */
    async apply(version) {
      const service = requireManager()
      let target = typeof version === 'string' && version.trim() !== '' ? version.trim() : lastCheck?.latest
      if (!target) {
        const checked = await this.check()
        target = checked.latest
      }
      if (!target) {
        throw updateError(lastCheck?.reason ?? '没有可安装的更新：请先「检查更新」。', 'library/update-none')
      }
      let answer
      try {
        answer = await service.updateBundle(packageName, target, {})
      } catch (error) {
        // The removal step stops this plugin; a transport-level rejection here
        // usually means the update is already underway, not that it failed.
        logger.warn?.(`library: update to ${target} interrupted: ${error?.message ?? error}`)
        throw updateError(`更新已启动但应答中断（插件正在被替换）。请稍候片刻后刷新状态确认。${error?.message ?? error}`, 'library/update-interrupted')
      }
      const result = answer?.result
      const application = result?.application
      if (application === 'failed' || application === 'cancelled') {
        const detail = result?.error?.diagnostic ?? result?.error?.message ?? result?.error?.code
        lastCheck = undefined
        throw updateError(application === 'cancelled'
          ? '更新已取消，安装内容已回滚。'
          : `更新到 ${target} 失败：${detail ?? '原因未知'}。已回滚或保留原版本。`, 'library/update-failed')
      }
      lastCheck = undefined
      return {
        ...this.status(),
        applied: true,
        from: answer?.from ?? undefined,
        to: answer?.to ?? target,
        application: application ?? 'applied',
        restartRequired: application === 'restart-required',
        // HMR replaces the package live; without HMR (or with a pending HMR
        // reason) dsh reports that a restart activates it.
        step: answer?.step,
      }
    },
  }
}
