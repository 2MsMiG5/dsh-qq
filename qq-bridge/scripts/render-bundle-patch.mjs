// render-bundle-patch.mjs — 生成 qq-agent bundle 的装配层（plugins/qq-agent/cordis.patch.yml）。
//
// 为什么单独一个纯函数模块：
//   · setup-dsh.mjs 是「有副作用」的安装脚本，测试不想为了读几条 insert 就把整个安装
//     流程跑一遍（还会碰上 junction / dsh CLI 等平台差异）；
//   · 契约测试（test-qq-mode-plugin.mjs / test-setup-dsh-idempotent.mjs）需要断言
//     「entry id 恰好等于命名空间」「bundle 里不再挂任何 MCP server」这些不变量。
//   所以渲染逻辑放在这里，setup-dsh.mjs 只负责写文件。
//
// 两条 insert：
//   qq-mode            —— 模式设置命名空间（entry id 必须 = 命名空间名 'qq-mode'）
//   snowluma-autostart —— DSH 启动时拉起 SnowLuma + 桥接（用户已装好的副本）
//
// 插件行的 name 用 `./lib/*.js`：bundle patch 的 insert 行会**相对 patch 文件**
// 锚定成 file:// URL（dsh-app-boot 的 anchorInsertedPluginNames），因此仓库搬家、
// 或包被 junction 到别的 profile 都不影响。

/**
 * @param {{repoRoot: string, nodeExecPath?: string, bridgeConfig?: object}} options
 * @returns {string} cordis.patch.yml 的完整文本
 */
export function renderBundlePatch({ repoRoot, nodeExecPath = process.execPath, bridgeConfig = {} } = {}) {
  if (!repoRoot) throw new Error('renderBundlePatch: repoRoot is required');
  void nodeExecPath; // 保留参数以兼容旧调用方；2026-10-28 起装配层不再需要 node 绝对路径
  const yamlSingleQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const consolePort = Number(bridgeConfig.consolePort) || 3100;
  const homeDir = String(bridgeConfig.snowluma?.homeDir
    || (bridgeConfig.snowluma?.launcherPath ? String(bridgeConfig.snowluma.launcherPath).replace(/[\\/][^\\/]+$/, '') : ''));
  const out = [];
  out.push('# 本文件由 scripts/setup-dsh.mjs 生成/维护，请勿手工编辑。');
  out.push('# qq-agent bundle 的装配层：一个包 = 模式设置 + 自启。');
  out.push('# 想改默认值（SnowLuma 目录 / 端口）请改 qq-bridge/config.json 后重跑 setup-dsh.mjs，');
  out.push('# 或在 profile 的 cordis.patch.yml 里按 id 覆盖（qq-mode / snowluma-autostart）。');
  out.push('');
  out.push('- insert:');
  out.push('    - id: qq-mode');
  out.push("      name: './lib/mode.js'");
  out.push('      config: {}');
  out.push('- insert:');
  out.push('    - id: snowluma-autostart');
  out.push("      name: './lib/autostart.js'");
  out.push('      config:');
  // 这三个值必须是绝对路径/显式端口：插件模块虽然也有「按自身位置推导」的兜底，
  // 但 DSH 通过 profile 的 junction 装载插件时，import.meta.url 可能是链接路径而不是
  // 仓库真实路径（Windows junction + ESM 行为不同版本不一致），靠推导会把桥接目录算成
  // <profile>。由 setup 生成绝对值最可靠。
  out.push(`        bridgeDir: ${yamlSingleQuote(repoRoot.replace(/[\\/]+$/, ''))}`);
  if (homeDir) out.push(`        homeDir: ${yamlSingleQuote(homeDir)}`);
  out.push(`        webuiPort: 5099`);
  out.push(`        bridgePort: ${consolePort}`);
  out.push('');
  out.push(`# SnowLuma homeDir=${homeDir || '(未配置：运行时从 config.json 读，读不到则不自动拉起)'}`);
  out.push(`# qq-bridge 控制台端口=${consolePort}`);
  return out.join('\n');
}
