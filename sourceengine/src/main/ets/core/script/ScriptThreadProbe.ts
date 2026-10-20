import { JSScriptEvalResult, JSScriptSession, JSScriptSessionOptions } from '@devzeng/quickjs';
import { HttpClient } from '../http/HttpClient';
import { AnalyzeRule } from '../rule/AnalyzeRule';

export class ScriptProbeResult {
  name: string = '';
  passed: boolean = false;
  detail: string = '';
}

/**
 * 阶段 0 技术验证：QuickJS 跑在后台线程、脚本同步调用宿主（宿主在 ArkTS 线程上异步完成）。
 * 只用于真机上的调试页，不参与书源解析。
 */
export class ScriptThreadProbe {
  static readonly DEFAULT_HTTP_URL: string = 'https://www.baidu.com/';

  static async run(onResult: (result: ScriptProbeResult) => void,
    httpUrl: string = ScriptThreadProbe.DEFAULT_HTTP_URL): Promise<ScriptProbeResult[]> {
    const results: ScriptProbeResult[] = [];
    const cases: [string, () => Promise<ScriptProbeResult>][] = [
      ['基础语法与返回值', () => ScriptThreadProbe.basics()],
      ['全局变量跨次保留', () => ScriptThreadProbe.globalsPersist()],
      ['Promise 与 async', () => ScriptThreadProbe.promises()],
      ['宿主调用往返耗时', () => ScriptThreadProbe.roundTrip()],
      ['大数据与中文往返', () => ScriptThreadProbe.largePayload()],
      ['脚本忙时主线程不卡', () => ScriptThreadProbe.mainThreadResponsive()],
      ['CPU 超时且无法被 catch', () => ScriptThreadProbe.cpuTimeout()],
      ['等待宿主不计 CPU 时间', () => ScriptThreadProbe.hostWaitExcluded()],
      ['取消正在运行的脚本', () => ScriptThreadProbe.cancelBusy()],
      ['取消正在等宿主的脚本', () => ScriptThreadProbe.cancelWaiting()],
      ['内存上限后会话仍可用', () => ScriptThreadProbe.memoryLimit()],
      ['深递归不崩溃', () => ScriptThreadProbe.deepRecursion()],
      ['宿主报错可被脚本 catch', () => ScriptThreadProbe.hostError()],
      ['选择器宿主调用', () => ScriptThreadProbe.selector()],
      ['脚本里连续发真实请求', () => ScriptThreadProbe.realHttp(httpUrl)],
      ['4 个会话并行', () => ScriptThreadProbe.parallelSessions()],
      ['运行中释放会话', () => ScriptThreadProbe.releaseWhileBusy()],
      ['反复创建与释放 30 个会话', () => ScriptThreadProbe.churn()],
    ];
    for (const entry of cases) {
      let result: ScriptProbeResult;
      try {
        result = await entry[1]();
      } catch (error) {
        result = ScriptThreadProbe.result(false, `验证代码异常：${ScriptThreadProbe.message(error)}`);
      }
      result.name = entry[0];
      results.push(result);
      onResult(result);
    }
    return results;
  }

  /** 把结果整理成可以直接复制给开发者的文本。 */
  static report(results: ScriptProbeResult[]): string {
    const passed = results.filter((item: ScriptProbeResult): boolean => item.passed).length;
    const lines: string[] = [`后台脚本线程验证：${passed}/${results.length} 通过`];
    for (const item of results) lines.push(`${item.passed ? '✓' : '✗'} ${item.name}：${item.detail}`);
    return lines.join('\n');
  }

  private static async basics(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const code = 'class A { #x = 1; get x() { return this.#x; } }\n' +
        '[new A().x, [1, 2, 3].map(v => v * 2).join(","), "abc".replaceAll("b", "B"),' +
        ' JSON.stringify({ a: (1n).toString() }), /(?<y>\\d{4})/.exec("2026").groups.y, typeof __host].join("|")';
      const run = await session.evaluate(code, 'basics.js');
      const expected = '1|2,4,6|aBc|{"a":"1"}|2026|function';
      return ScriptThreadProbe.result(run.success && run.value === expected,
        run.success ? `返回 ${run.value}，用时 ${ScriptThreadProbe.ms(run.wallMs)}` : run.error);
    });
  }

  private static async globalsPersist(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      await session.evaluate('var counter = 41; function inc() { return ++counter; }', 'define.js');
      const run = await session.evaluate('inc()', 'use.js');
      return ScriptThreadProbe.result(run.success && run.value === '42', run.success ? `返回 ${run.value}` : run.error);
    });
  }

  private static async promises(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const chained = await session.evaluate('Promise.resolve(20).then(x => x + 1)', 'promise.js');
      const asyncFn = await session.evaluate('(async () => { const v = __host("echo", "a"); await null; return v + "b"; })()',
        'async.js');
      const ok = chained.value === '21' && asyncFn.value === 'ab';
      return ScriptThreadProbe.result(ok, `then 得到 ${chained.value || chained.error}，async 得到 ${asyncFn.value || asyncFn.error}`);
    });
  }

  private static async roundTrip(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const count = 2000;
      const run = await session.evaluate(
        `let total = 0; for (let i = 0; i < ${count}; i++) total += __host("echo", String(i)).length; total`,
        'round-trip.js', 5000);
      const expected = ScriptThreadProbe.digitsUpTo(count);
      const perCall = run.wallMs * 1000 / count;
      return ScriptThreadProbe.result(run.success && Number(run.value) === expected && run.hostCalls === count,
        run.success ? `${count} 次共 ${ScriptThreadProbe.ms(run.wallMs)}，平均每次 ${perCall.toFixed(0)} 微秒` : run.error);
    });
  }

  private static async largePayload(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const run = await session.evaluate(
        'const big = "中文😀".repeat(200000); const back = __host("echo", big);' +
          ' [back.length === big.length, back === big, back.slice(0, 4)].join("|")',
        'large.js', 5000);
      return ScriptThreadProbe.result(run.success && run.value === 'true|true|中文😀',
        run.success ? `约 2.4 MB 往返 ${ScriptThreadProbe.ms(run.wallMs)}，结果 ${run.value}` : run.error);
    });
  }

  private static async mainThreadResponsive(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      let last = Date.now();
      let maxGap = 0;
      const timer = setInterval((): void => {
        const now = Date.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
      }, 16);
      const run = await session.evaluate('const end = Date.now() + 1500; let n = 0; while (Date.now() < end) n++; n',
        'busy.js', 3000);
      clearInterval(timer);
      return ScriptThreadProbe.result(run.success && maxGap < 100,
        `脚本忙 ${ScriptThreadProbe.ms(run.cpuMs)}，期间主线程定时器最大间隔 ${maxGap} ms（16 ms 一次）`);
    });
  }

  private static async cpuTimeout(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const run = await session.evaluate('for (;;) { try { while (true) {} } catch (e) {} }', 'timeout.js', 300);
      const after = await session.evaluate('1 + 1', 'after.js');
      return ScriptThreadProbe.result(run.timedOut && run.wallMs < 1500 && after.value === '2',
        `超时=${run.timedOut}，用时 ${ScriptThreadProbe.ms(run.wallMs)}，之后再运行得到 ${after.value || after.error}`);
    });
  }

  private static async hostWaitExcluded(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const run = await session.evaluate('__host("sleep", "800"); "ok"', 'sleep.js', 300);
      return ScriptThreadProbe.result(run.success && run.hostWaitMs >= 700,
        run.success ? `CPU 上限 300 ms，等待宿主 ${ScriptThreadProbe.ms(run.hostWaitMs)}，脚本 CPU ${ScriptThreadProbe.ms(run.cpuMs)}` :
          run.error);
    });
  }

  private static async cancelBusy(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const pending = session.evaluate('for (;;) {}', 'forever.js', 10000);
      setTimeout((): void => session.cancel(), 200);
      const run = await pending;
      const after = await session.evaluate('"still alive"', 'after.js');
      return ScriptThreadProbe.result(run.cancelled && run.wallMs < 1500 && after.value === 'still alive',
        `已取消=${run.cancelled}，用时 ${ScriptThreadProbe.ms(run.wallMs)}，之后再运行：${after.value || after.error}`);
    });
  }

  private static async cancelWaiting(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const pending = session.evaluate('__host("sleep", "5000"); "should not reach"', 'wait.js', 1000);
      setTimeout((): void => session.cancel(), 200);
      const run = await pending;
      return ScriptThreadProbe.result(run.cancelled && run.wallMs < 1500,
        `已取消=${run.cancelled}，用时 ${ScriptThreadProbe.ms(run.wallMs)}（宿主那次 5 秒的等待被放弃）`);
    });
  }

  private static async memoryLimit(): Promise<ScriptProbeResult> {
    const options = new JSScriptSessionOptions();
    options.memoryLimitBytes = 16 * 1024 * 1024;
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const run = await session.evaluate('const a = []; for (;;) a.push(new Array(100000).fill(1));', 'oom.js', 5000);
      const after = await session.evaluate('1 + 1', 'after.js');
      const oom = !run.success && /memory/i.test(run.error);
      return ScriptThreadProbe.result(oom && after.value === '2',
        `报错：${ScriptThreadProbe.firstLine(run.error)}；之后再运行得到 ${after.value || after.error}`);
    }, options);
  }

  private static async deepRecursion(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const run = await session.evaluate('function f(n) { return f(n + 1) + 1; } try { f(0); "no error" } catch (e) { String(e) }',
        'recursion.js', 5000);
      return ScriptThreadProbe.result(run.success && /stack/i.test(run.value), run.success ? run.value : run.error);
    });
  }

  private static async hostError(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const run = await session.evaluate('try { __host("fail", "坏了"); "no error" } catch (e) { "caught:" + e.message }',
        'host-error.js');
      return ScriptThreadProbe.result(run.value === 'caught:坏了', run.success ? run.value : run.error);
    });
  }

  private static async selector(): Promise<ScriptProbeResult> {
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const code = 'const html = "<ul>" + Array.from({ length: 50 }, (_, i) => `<li class=\\"c\\"><a href=\\"/b/${i}\\">书${i}</a></li>`).join("") + "</ul>";\n' +
        'let names = []; for (let i = 0; i < 20; i++) names = JSON.parse(__host("sel", JSON.stringify({ html, rule: "@css:li.c a@text" })));\n' +
        'names.length + ":" + names[49]';
      const run = await session.evaluate(code, 'sel.js', 5000);
      return ScriptThreadProbe.result(run.success && run.value === '50:书49',
        run.success ? `20 次选择器各取 50 项，共 ${ScriptThreadProbe.ms(run.wallMs)}，结果 ${run.value}` : run.error);
    });
  }

  private static async realHttp(url: string): Promise<ScriptProbeResult> {
    const options = new JSScriptSessionOptions();
    options.hostTimeoutMs = 20000;
    return ScriptThreadProbe.withSession(async (session: JSScriptSession): Promise<ScriptProbeResult> => {
      const code = `const out = []; let target = ${JSON.stringify(url)};\n` +
        'for (let i = 0; i < 3; i++) { const r = JSON.parse(__host("http", target)); out.push(r.code + "/" + r.length + "B/" + r.ms + "ms"); ' +
        'if (r.code !== 200) break; }\nout.join(", ")';
      const run = await session.evaluate(code, 'http.js', 2000);
      return ScriptThreadProbe.result(run.success && /^200\//.test(run.value),
        run.success ? `${url} 连续 3 次：${run.value}；脚本 CPU ${ScriptThreadProbe.ms(run.cpuMs)}` : run.error);
    });
  }

  private static async parallelSessions(): Promise<ScriptProbeResult> {
    const sessions: JSScriptSession[] = [];
    for (let i = 0; i < 4; i++) sessions.push(ScriptThreadProbe.newSession());
    const startedAt = Date.now();
    try {
      const runs = await Promise.all(sessions.map((session: JSScriptSession): Promise<JSScriptEvalResult> =>
        session.evaluate('const end = Date.now() + 600; let n = 0; while (Date.now() < end) n++; n', 'busy.js', 2000)));
      const wall = Date.now() - startedAt;
      const ok = runs.every((run: JSScriptEvalResult): boolean => run.success);
      return ScriptThreadProbe.result(ok && wall < 1800,
        `4 个会话各忙 600 ms，总用时 ${wall} ms（串行约 2400 ms）`);
    } finally {
      sessions.forEach((session: JSScriptSession): void => session.release());
    }
  }

  private static async releaseWhileBusy(): Promise<ScriptProbeResult> {
    const session = ScriptThreadProbe.newSession();
    const pending = session.evaluate('for (;;) {}', 'forever.js', 10000);
    const queued = session.evaluate('"queued"', 'queued.js');
    setTimeout((): void => session.release(), 100);
    const run = await pending;
    const second = await queued;
    const after = await session.evaluate('1', 'after-release.js');
    return ScriptThreadProbe.result(run.cancelled && second.cancelled && after.cancelled,
      `运行中的已取消=${run.cancelled}，排队的已取消=${second.cancelled}，释放后再调用：${after.error}`);
  }

  private static async churn(): Promise<ScriptProbeResult> {
    const startedAt = Date.now();
    let ok = 0;
    for (let i = 0; i < 30; i++) {
      const session = ScriptThreadProbe.newSession();
      const run = await session.evaluate(`${i} * 2`, 'churn.js');
      if (run.value === String(i * 2)) ok++;
      session.release();
    }
    return ScriptThreadProbe.result(ok === 30, `${ok}/30 正常，共 ${Date.now() - startedAt} ms`);
  }

  private static newSession(options?: JSScriptSessionOptions): JSScriptSession {
    const http = new HttpClient(15000);
    return new JSScriptSession((name: string, payload: string): Promise<string> | string =>
      ScriptThreadProbe.host(http, name, payload), options);
  }

  private static async withSession(body: (session: JSScriptSession) => Promise<ScriptProbeResult>,
    options?: JSScriptSessionOptions): Promise<ScriptProbeResult> {
    const session = ScriptThreadProbe.newSession(options);
    try {
      return await body(session);
    } finally {
      session.release();
    }
  }

  private static host(http: HttpClient, name: string, payload: string): Promise<string> | string {
    if (name === 'echo') return payload;
    if (name === 'fail') throw new Error(payload);
    if (name === 'sleep') {
      return new Promise<string>((resolve: (value: string) => void): void => {
        setTimeout((): void => resolve(''), Number(payload) || 0);
      });
    }
    if (name === 'sel') {
      const request = JSON.parse(payload) as Record<string, string>;
      return JSON.stringify(new AnalyzeRule(request['html'] || '', '').getStringList(request['rule'] || ''));
    }
    if (name === 'http') {
      const startedAt = Date.now();
      return http.execute({ url: payload, method: 'GET', headers: {} }).then((response): string => JSON.stringify({
        code: response.statusCode,
        length: response.body.length,
        ms: Date.now() - startedAt,
        error: response.error || ''
      }));
    }
    throw new Error(`unknown host call: ${name}`);
  }

  /** 0..count-1 的十进制位数之和。 */
  private static digitsUpTo(count: number): number {
    let total = 0;
    for (let i = 0; i < count; i++) total += String(i).length;
    return total;
  }

  private static result(passed: boolean, detail: string): ScriptProbeResult {
    const result = new ScriptProbeResult();
    result.passed = passed;
    result.detail = detail;
    return result;
  }

  private static ms(value: number): string {
    return `${Math.round(value)} ms`;
  }

  private static firstLine(text: string): string {
    return (text || '').split('\n')[0];
  }

  private static message(error: Object): string {
    if (error instanceof Error) return error.message || String(error);
    return String(error);
  }
}
