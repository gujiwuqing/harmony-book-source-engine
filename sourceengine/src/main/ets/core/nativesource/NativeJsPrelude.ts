/**
 * 原生书源 JS 函数库与脚本引擎之间的约定：前置脚本、调用代码和结果的编码。
 *
 * 真机用 QuickJS（NativeJsLibrary），Node 回归用 node:vm，两边共用这里生成的代码，行为保持一致。
 * 本文件不依赖系统 API，可直接在 Node 回归脚本中加载。
 */

import type { NativeValue } from './NativeExpr';

export class NativeJsPrelude {
  /** js 字段的长度上限（字符数）。 */
  static readonly MAX_CODE_LENGTH: number = 512 * 1024;

  /**
   * 在书源代码之前执行：用 __host 搭出只读的 native 对象，之后删掉 __host，书源代码只能经 native 调内置函数。
   * 内置函数的参数和返回值都按 JSON 传递。
   */
  static source(builtins: string[]): string {
    return `(function (g) {
  var host = g.__host;
  var names = ${JSON.stringify(builtins)};
  var api = {};
  names.forEach(function (name) {
    api[name] = function () {
      var out = host(name, JSON.stringify(Array.prototype.slice.call(arguments)));
      return out === '' ? null : JSON.parse(out);
    };
  });
  // 写错名字时直接说明，而不是只得到 “not a function”。
  var native = new Proxy(Object.freeze(api), {
    get: function (target, key) {
      if (typeof key !== 'string' || key in target || key === 'toJSON' || key === 'then') return target[key];
      throw new Error('native.' + key + ' 不是可用的内置函数');
    }
  });
  Object.defineProperty(g, 'native', { value: native, enumerable: false });
  Object.defineProperty(g, '__nativeReturn', {
    value: function (value) {
      var text = JSON.stringify(value === undefined ? null : value);
      return text === undefined ? 'null' : text;
    },
    enumerable: false
  });
  delete g.__host;
})(globalThis);`;
  }

  /** JS 保留字不能用作函数名；内置函数里有 default，拼进检查代码会成为语法错误。 */
  private static readonly RESERVED: string[] = ['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
    'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
    'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
    'private', 'protected', 'public', 'await'];

  /** 能否作为 JS 函数名出现在生成的代码里。 */
  static isIdentifier(name: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name || '') && NativeJsPrelude.RESERVED.indexOf(name) < 0;
  }

  /** 求值结果为 "true" 表示脚本里有这个函数（包括顶层 const/let 定义的）。 */
  static hasSource(name: string): string {
    return `typeof ${name} === 'function'`;
  }

  /** 调用脚本函数，结果是 JSON 文本。 */
  static callSource(name: string, args: NativeValue[]): string {
    return `__nativeReturn(${name}.apply(null, ${JSON.stringify(args.map((arg: NativeValue): NativeValue =>
      arg === undefined ? null : arg))}))`;
  }

  /** 列出 names 里被脚本定义成函数的名字，结果是 JSON 数组。 */
  static definedSource(names: string[]): string {
    const checks = names.filter((name: string): boolean => NativeJsPrelude.isIdentifier(name))
      .map((name: string): string => `typeof ${name} === 'function' ? ${JSON.stringify(name)} : ''`);
    return `JSON.stringify([${checks.join(', ')}].filter(Boolean))`;
  }

  /** definedSource 查出的重名给出导入时的错误信息；没有重名时返回空串。 */
  static clashMessage(clashes: string[], builtins: string[]): string {
    if (clashes.length === 0) return '';
    const name = clashes[0];
    return builtins.indexOf(name) >= 0 ? `js 里的函数 “${name}” 与内置函数重名` :
      `js 里的函数 “${name}” 与 lib 里的函数重名`;
  }

  static parseResult(text: string): NativeValue {
    if (text === undefined || text === null || text === '') return null;
    return JSON.parse(text);
  }

  /** 脚本里 native.名称(...) 的宿主端：解出参数，调内置函数，把结果编码回去。 */
  static answerBuiltin(builtin: (name: string, args: NativeValue[]) => NativeValue, name: string,
    payload: string): string {
    const args = payload ? JSON.parse(payload) : [];
    const value: NativeValue = builtin(name, Array.isArray(args) ? args : []);
    const text = JSON.stringify(value === undefined ? null : value);
    return text === undefined ? 'null' : text;
  }

  /** 错误信息只留前几行，避免整段堆栈塞进界面。 */
  static shortError(message: string): string {
    const lines = (message || '').split('\n').map((line: string): string => line.trim()).filter(Boolean);
    return lines.slice(0, 3).join(' ') || '未知错误';
  }
}
