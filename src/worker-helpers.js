'use babel'

import Path from 'path'
import fs from 'fs-plus'
import ChildProcess from 'child_process'
import resolveEnv from 'resolve-env'
import { findCached } from 'atom-linter'
import getPath from 'consistent-path'

const Cache = {
  ESLINT_LOCAL_PATH: Path.normalize(Path.join(__dirname, '..', 'node_modules', 'eslint')),
  NODE_PREFIX_PATH: null,
  LAST_MODULES_PATH: null
}

/**
 * Takes a path and translates `~` to the user's home directory, and replaces
 * all environment variables with their value.
 * @param  {string} path The path to remove "strangeness" from
 * @return {string}      The cleaned path
 */
const cleanPath = path => (path ? resolveEnv(fs.normalize(path)) : '')

export function getNodePrefixPath() {
  if (Cache.NODE_PREFIX_PATH === null) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    try {
      Cache.NODE_PREFIX_PATH = ChildProcess.spawnSync(npmCommand, ['get', 'prefix'], {
        env: Object.assign(Object.assign({}, process.env), { PATH: getPath() })
      }).output[1].toString().trim()
    } catch (e) {
      const errMsg = 'Unable to execute `npm get prefix`. Please make sure '
        + 'Atom is getting $PATH correctly.'
      throw new Error(errMsg)
    }
  }
  return Cache.NODE_PREFIX_PATH
}

function isDirectory(dirPath) {
  let isDir
  try {
    isDir = fs.statSync(dirPath).isDirectory()
  } catch (e) {
    isDir = false
  }
  return isDir
}

export function findGlobalEslintDirectory(config) {
  let eslintDir = null
  const configGlobal = cleanPath(config.global.globalNodePath)
  const prefixPath = configGlobal || getNodePrefixPath()
  // NPM on Windows and Yarn on all platforms
  eslintDir = Path.join(prefixPath, 'node_modules', 'eslint')
  if (!isDirectory(eslintDir)) {
    // NPM on platforms other than Windows
    eslintDir = Path.join(prefixPath, 'lib', 'node_modules', 'eslint')
  }
  return eslintDir
}

export function findESLintDirectory(modulesDir, config, projectPath) {
  let eslintDir = null
  let locationType = null
  if (config.global.useGlobalEslint) {
    locationType = 'global'
    eslintDir = findGlobalEslintDirectory(config)
  } else if (!config.advanced.localNodeModules) {
    locationType = 'local project'
    eslintDir = Path.join(modulesDir || '', 'eslint')
  } else if (Path.isAbsolute(cleanPath(config.advanced.localNodeModules))) {
    locationType = 'advanced specified'
    eslintDir = Path.join(cleanPath(config.advanced.localNodeModules), 'eslint')
  } else {
    locationType = 'advanced specified'
    eslintDir = Path.join(projectPath || '', cleanPath(config.advanced.localNodeModules), 'eslint')
  }

  if (isDirectory(eslintDir)) {
    return {
      path: eslintDir,
      type: locationType,
    }
  }

  if (config.global.useGlobalEslint) {
    throw new Error('ESLint not found, please ensure the global Node path is set correctly.')
  }

  return {
    path: Cache.ESLINT_LOCAL_PATH,
    type: 'bundled fallback',
  }
}

export function getESLintFromDirectory(modulesDir, config, projectPath) {
  const { path: ESLintDirectory } = findESLintDirectory(modulesDir, config, projectPath)
  try {
    // eslint-disable-next-line import/no-dynamic-require
    return require(ESLintDirectory)
  } catch (e) {
    if (config.global.useGlobalEslint && e.code === 'MODULE_NOT_FOUND') {
      throw new Error('ESLint not found, try restarting Atom to clear caches.')
    }
    // eslint-disable-next-line import/no-dynamic-require
    return require(Cache.ESLINT_LOCAL_PATH)
  }
}

export function refreshModulesPath(modulesDir) {
  if (Cache.LAST_MODULES_PATH !== modulesDir) {
    Cache.LAST_MODULES_PATH = modulesDir
    process.env.NODE_PATH = modulesDir || ''
    // eslint-disable-next-line no-underscore-dangle
    require('module').Module._initPaths()
  }
}

export function getESLintInstance(fileDir, config, projectPath) {
  const modulesDir = Path.dirname(findCached(fileDir, 'node_modules/eslint') || '')
  refreshModulesPath(modulesDir)
  return getESLintFromDirectory(modulesDir, config, projectPath)
}

export function getConfigPath(fileDir) {
  const configFile = findCached(fileDir, [
    '.eslintrc.js', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc.json', '.eslintrc', 'package.json'
  ])
  if (configFile) {
    if (Path.basename(configFile) === 'package.json') {
      // eslint-disable-next-line import/no-dynamic-require
      if (require(configFile).eslintConfig) {
        return configFile
      }
      // If we are here, we found a package.json without an eslint config
      // in a dir without any other eslint config files
      // (because 'package.json' is last in the call to findCached)
      // So, keep looking from the parent directory
      return getConfigPath(Path.resolve(Path.dirname(configFile), '..'))
    }
    return configFile
  }
  return null
}

export function getRelativePath(fileDir, filePath, config, projectPath) {
  const ignoreFile = config.advanced.disableEslintIgnore ? null : findCached(fileDir, '.eslintignore')

  // If we can find an .eslintignore file, we can set cwd there
  // (because they are expected to be at the project root)
  if (ignoreFile) {
    const ignoreDir = Path.dirname(ignoreFile)
    process.chdir(ignoreDir)
    return Path.relative(ignoreDir, filePath)
  }
  // Otherwise, we'll set the cwd to the atom project root as long as that exists
  if (projectPath) {
    process.chdir(projectPath)
    return Path.relative(projectPath, filePath)
  }
  // If all else fails, use the file location itself
  process.chdir(fileDir)
  return Path.basename(filePath)
}

export function getCLIEngineOptions(type, config, rules, filePath, fileDir, givenConfigPath) {
  const cliEngineConfig = {
    rules,
    ignore: !config.advanced.disableEslintIgnore,
    fix: type === 'fix'
  }

  const ignoreFile = config.advanced.disableEslintIgnore ? null : findCached(fileDir, '.eslintignore')
  if (ignoreFile) {
    cliEngineConfig.ignorePath = ignoreFile
  }

  cliEngineConfig.rulePaths = config.advanced.eslintRulesDirs.map((path) => {
    const rulesDir = cleanPath(path)
    if (!Path.isAbsolute(rulesDir)) {
      return findCached(fileDir, rulesDir)
    }
    return rulesDir
  }).filter(path => path)

  if (givenConfigPath === null && config.global.eslintrcPath) {
    // If we didn't find a configuration use the fallback from the settings
    cliEngineConfig.configFile = cleanPath(config.global.eslintrcPath)
  }

  return cliEngineConfig
}

/**
 * Gets the list of rules used for a lint job
 * @param  {Object} cliEngine The CLIEngine instance used for the lint job
 * @return {Map}              A Map of the rules used, rule names as keys, rule
 *                            properties as the contents.
 */
export function getRules(cliEngine) {
  // Pull the list of rules used directly from the CLIEngine
  // Added in https://github.com/eslint/eslint/pull/9782
  if (Object.prototype.hasOwnProperty.call(cliEngine, 'getRules')) {
    return cliEngine.getRules()
  }

  // Attempt to use the internal (undocumented) `linter` instance attached to
  // the CLIEngine to get the loaded rules (including plugin rules).
  // Added in ESLint v4
  if (Object.prototype.hasOwnProperty.call(cliEngine, 'linter')) {
    return cliEngine.linter.getRules()
  }

  // Older versions of ESLint don't (easily) support getting a list of rules
  return new Map()
}

/**
 * Given an exiting rule list and a new rule list, determines whether there
 * have been changes.
 * NOTE: This only accounts for presence of the rules, changes to their metadata
 * are not taken into account.
 * @param  {Map} newRules     A Map of the new rules
 * @param  {Map} currentRules A Map of the current rules
 * @return {boolean}             Whether or not there were changes
 */
export function didRulesChange(currentRules, newRules) {
  return !(currentRules.size === newRules.size
    && Array.from(currentRules.keys()).every(ruleId => newRules.has(ruleId)))
}
