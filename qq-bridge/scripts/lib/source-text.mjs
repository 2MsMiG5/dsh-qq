// 测试用：读取「桥接的全部运行时代码」。
//
// 背景：HTTP 路由原先内联在 src/bridge.js 里，于是不少审计脚本用
// `readFileSync('src/bridge.js').includes("'/api/voice/send'")` 这种源码文本断言。
// 路由拆到 src/http/routes/ 之后，这类断言会全部失败——但它们失败的**不是行为**，
// 而是「代码住在哪个文件」。
//
// 这里提供一个与文件布局无关的入口：断言只关心「这段能力还在不在代码里」。
// 以后继续拆分（social/ 拆到独立模块）时，测试不需要再改。
import fs from 'node:fs';
import path from 'node:path';

/** 递归收集目录下的 .js 文件 */
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * @param {string} root 项目根目录
 * @returns {string} bridge.js + 所有已拆出的子模块源码拼接
 */
export function readBridgeSource(root) {
  const parts = [];
  const srcDir = path.join(root, 'src');
  const bridge = path.join(srcDir, 'bridge.js');
  try { parts.push(fs.readFileSync(bridge, 'utf8')); } catch {}
  // 每拆出一个子模块就自动纳入，否则源码文本断言会因为「代码搬了家」而假红。
  // 这里直接遍历 src/ 下的**全部** .js：再拆第三、第四个模块时不用再改这个文件。
  for (const file of walk(srcDir)) {
    if (file === bridge) continue;
    try { parts.push(fs.readFileSync(file, 'utf8')); } catch {}
  }
  return parts.join('\n');
}
