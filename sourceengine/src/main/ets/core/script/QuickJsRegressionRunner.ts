import { BookSource } from '../../model/data/Book';
import { JsRuntime } from '../rule/JsRuntime';
import { QuickJsAsyncSubmitter, QuickJsRuntimeStatus } from './QuickJsRuntimeStatus';
import { QuickJsScriptRuntime, QuickJsShadowComparator } from './QuickJsScriptRuntime';

export class QuickJsRegressionStage {
  static readonly SEARCH: string = 'search';
  static readonly EXPLORE: string = 'explore';
  static readonly BOOK_INFO: string = 'bookInfo';
  static readonly TOC: string = 'toc';
  static readonly CONTENT: string = 'content';

  static all(): string[] {
    return [QuickJsRegressionStage.SEARCH, QuickJsRegressionStage.EXPLORE,
      QuickJsRegressionStage.BOOK_INFO, QuickJsRegressionStage.TOC, QuickJsRegressionStage.CONTENT];
  }

  static label(stage: string): string {
    if (stage === QuickJsRegressionStage.SEARCH) return '搜索';
    if (stage === QuickJsRegressionStage.EXPLORE) return '发现';
    if (stage === QuickJsRegressionStage.BOOK_INFO) return '详情';
    if (stage === QuickJsRegressionStage.TOC) return '目录';
    return '正文';
  }
}

export class QuickJsRegressionStatus {
  static readonly MATCH: string = 'match';
  static readonly MISMATCH: string = 'mismatch';
  static readonly QUICK_FAILURE: string = 'quick-failure';
  static readonly EXCLUDED: string = 'excluded';
}

export class QuickJsRegressionIssueCategory {
  static readonly NONE: string = '';
  static readonly SEMANTIC_MISMATCH: string = 'semantic-mismatch';
  static readonly TIMEOUT: string = 'timeout';
  static readonly UNSUPPORTED: string = 'unsupported';
  static readonly MISSING_BINDING: string = 'missing-binding';
  static readonly SYNTAX: string = 'syntax';
  static readonly RESOURCE_LIMIT: string = 'resource-limit';
  static readonly EXECUTOR: string = 'executor';
  static readonly RUNTIME: string = 'runtime';

  static classify(error: string, timedOut: boolean = false): string {
    const value = (error || '').toLowerCase();
    if (timedOut || value.includes('timeout') || value.includes('timed out')) return this.TIMEOUT;
    if (value.includes('not-pure-expression') || value.includes('unsupported') ||
      value.includes('not supported')) return this.UNSUPPORTED;
    if (value.includes('referenceerror') || value.includes('not defined') ||
      value.includes('binding')) return this.MISSING_BINDING;
    if (value.includes('syntaxerror') || value.includes('syntax error')) return this.SYNTAX;
    if (value.includes('out of memory') || value.includes('stack overflow') ||
      value.includes('memory limit')) return this.RESOURCE_LIMIT;
    if (value.includes('taskpool') || value.includes('executor') || value.includes('invalid-task-result')) {
      return this.EXECUTOR;
    }
    return this.RUNTIME;
  }

  static label(category: string): string {
    if (category === this.SEMANTIC_MISMATCH) return '语义差异';
    if (category === this.TIMEOUT) return '执行超时';
    if (category === this.UNSUPPORTED) return '能力未支持';
    if (category === this.MISSING_BINDING) return '绑定缺失';
    if (category === this.SYNTAX) return '语法差异';
    if (category === this.RESOURCE_LIMIT) return '资源限制';
    if (category === this.EXECUTOR) return '执行器异常';
    if (category === this.RUNTIME) return '运行异常';
    return '无问题';
  }
}

export class QuickJsRegressionCandidate {
  sourceUrl: string = '';
  sourceName: string = '';
  stage: string = '';
  field: string = '';
  expression: string = '';
  fingerprint: string = '';
  routable: boolean = false;
}

export class QuickJsRegressionItemResult {
  sourceUrl: string = '';
  sourceName: string = '';
  stage: string = '';
  field: string = '';
  fingerprint: string = '';
  /** Kept only in the app-private replay fixture; exports use a redacted representation. */
  expression: string = '';
  expressionPreview: string = '';
  routable: boolean = false;
  status: string = QuickJsRegressionStatus.MATCH;
  fixture: string = '';
  legacyPreview: string = '';
  quickPreview: string = '';
  error: string = '';
  errorCategory: string = QuickJsRegressionIssueCategory.NONE;
  elapsedMs: number = 0;
}

export class QuickJsRegressionReplayCase extends QuickJsRegressionCandidate {
  fixture: string = '';
}

export class QuickJsRegressionReport {
  totalCandidates: number = 0;
  completedCandidates: number = 0;
  matchCount: number = 0;
  mismatchCount: number = 0;
  failureCount: number = 0;
  excludedCount: number = 0;
  truncatedCount: number = 0;
  elapsedMs: number = 0;
  cancelled: boolean = false;
  error: string = '';
  items: QuickJsRegressionItemResult[] = [];
}

export class QuickJsRegressionProgress {
  completed: number = 0;
  total: number = 0;
  sourceName: string = '';
  field: string = '';
}

export type QuickJsRegressionProgressCallback = (progress: QuickJsRegressionProgress) => void;

class RegressionField {
  stage: string = '';
  name: string = '';
  rule: string = '';

  constructor(stage: string, name: string, rule: string) {
    this.stage = stage;
    this.name = name;
    this.rule = rule || '';
  }
}

class RegressionFixture {
  name: string = '';
  value: string | number | boolean = '';

  constructor(name: string, value: string | number | boolean) {
    this.name = name;
    this.value = value;
  }
}

class RegressionExpression {
  expression: string = '';
  routable: boolean = false;

  constructor(expression: string, routable: boolean) {
    this.expression = expression;
    this.routable = routable;
  }
}

/** Local-only dual-engine regression runner. It never performs host actions or network requests. */
export class QuickJsRegressionRunner {
  static readonly MAX_CANDIDATES: number = 300;
  private cancelled: boolean = false;

  cancel(): void { this.cancelled = true; }

  collect(sources: BookSource[], selectedStages: string[]): QuickJsRegressionCandidate[] {
    const candidates: QuickJsRegressionCandidate[] = [];
    const seen: Set<string> = new Set<string>();
    for (const source of sources) {
      for (const field of this.fields(source)) {
        if (!selectedStages.includes(field.stage) || !field.rule) continue;
        const expressions = this.extractExpressions(field.rule,
          field.name !== 'searchUrl' && field.name !== 'exploreUrl');
        for (const extracted of expressions) {
          const expression = extracted.expression;
          if (!QuickJsScriptRuntime.isPureExpressionCandidate(expression)) continue;
          const fingerprint = QuickJsShadowComparator.fingerprint(expression);
          const key = `${source.bookSourceUrl}\n${field.stage}\n${field.name}\n${fingerprint}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const item = new QuickJsRegressionCandidate();
          item.sourceUrl = source.bookSourceUrl;
          item.sourceName = source.bookSourceName || source.bookSourceUrl;
          item.stage = field.stage;
          item.field = field.name;
          item.expression = expression;
          item.fingerprint = fingerprint;
          item.routable = extracted.routable;
          candidates.push(item);
        }
      }
    }
    return candidates;
  }

  async run(sources: BookSource[], selectedStages: string[],
    onProgress: QuickJsRegressionProgressCallback): Promise<QuickJsRegressionReport> {
    this.cancelled = false;
    const report = new QuickJsRegressionReport();
    const startedAt = Date.now();
    const submitter = QuickJsRuntimeStatus.getAsyncSubmitter();
    if (!QuickJsRuntimeStatus.isHealthy() || !submitter) {
      report.error = 'QuickJS 自检或 TaskPool 运行环境未就绪';
      return report;
    }
    const allCandidates = this.collect(sources, selectedStages);
    report.totalCandidates = Math.min(allCandidates.length, QuickJsRegressionRunner.MAX_CANDIDATES);
    report.truncatedCount = Math.max(0, allCandidates.length - report.totalCandidates);
    const candidates = allCandidates.slice(0, QuickJsRegressionRunner.MAX_CANDIDATES);
    const fixtures = this.defaultFixtures();
    for (let index = 0; index < candidates.length; index++) {
      if (this.cancelled) {
        report.cancelled = true;
        break;
      }
      const candidate = candidates[index];
      const item = await this.compareCandidate(candidate, fixtures, submitter);
      report.items.push(item);
      report.completedCandidates++;
      if (item.status === QuickJsRegressionStatus.MATCH) report.matchCount++;
      else if (item.status === QuickJsRegressionStatus.EXCLUDED) report.excludedCount++;
      else if (item.status === QuickJsRegressionStatus.MISMATCH) report.mismatchCount++;
      else report.failureCount++;
      const progress = new QuickJsRegressionProgress();
      progress.completed = report.completedCandidates;
      progress.total = report.totalCandidates;
      progress.sourceName = candidate.sourceName;
      progress.field = candidate.field;
      onProgress(progress);
      if ((index + 1) % 6 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    report.elapsedMs = Math.max(0, Date.now() - startedAt);
    return report;
  }

  /** Replays app-private issue fixtures after an update without needing to rediscover the source expression. */
  async rerun(cases: QuickJsRegressionReplayCase[],
    onProgress: QuickJsRegressionProgressCallback): Promise<QuickJsRegressionReport> {
    this.cancelled = false;
    const report = new QuickJsRegressionReport();
    const startedAt = Date.now();
    const submitter = QuickJsRuntimeStatus.getAsyncSubmitter();
    if (!QuickJsRuntimeStatus.isHealthy() || !submitter) {
      report.error = 'QuickJS 自检或 TaskPool 运行环境未就绪';
      return report;
    }
    const replayCases: QuickJsRegressionReplayCase[] = [];
    const seen: Set<string> = new Set<string>();
    for (const item of cases.slice(0, QuickJsRegressionRunner.MAX_CANDIDATES)) {
      const key = `${item.sourceUrl}\n${item.stage}\n${item.field}\n${item.fingerprint}`;
      if (!item.expression || seen.has(key)) continue;
      seen.add(key);
      replayCases.push(item);
    }
    report.totalCandidates = replayCases.length;
    report.truncatedCount = Math.max(0, cases.length - replayCases.length);
    for (let index = 0; index < replayCases.length; index++) {
      if (this.cancelled) { report.cancelled = true; break; }
      const replay = replayCases[index];
      const namedFixture = this.fixtureByName(replay.fixture);
      const fixtures = namedFixture ? [namedFixture] : this.defaultFixtures();
      const item = await this.compareCandidate(replay, fixtures, submitter);
      report.items.push(item);
      report.completedCandidates++;
      if (item.status === QuickJsRegressionStatus.MATCH) report.matchCount++;
      else if (item.status === QuickJsRegressionStatus.EXCLUDED) report.excludedCount++;
      else if (item.status === QuickJsRegressionStatus.MISMATCH) report.mismatchCount++;
      else report.failureCount++;
      const progress = new QuickJsRegressionProgress();
      progress.completed = report.completedCandidates;
      progress.total = report.totalCandidates;
      progress.sourceName = replay.sourceName;
      progress.field = replay.field;
      onProgress(progress);
      if ((index + 1) % 6 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    report.elapsedMs = Math.max(0, Date.now() - startedAt);
    return report;
  }

  private async compareCandidate(candidate: QuickJsRegressionCandidate, fixtures: RegressionFixture[],
    submitter: QuickJsAsyncSubmitter): Promise<QuickJsRegressionItemResult> {
    const item = new QuickJsRegressionItemResult();
    item.sourceUrl = candidate.sourceUrl;
    item.sourceName = candidate.sourceName;
    item.stage = candidate.stage;
    item.field = candidate.field;
    item.fingerprint = candidate.fingerprint;
    item.expression = candidate.expression;
    item.expressionPreview = this.preview(candidate.expression);
    item.routable = candidate.routable;
    const startedAt = Date.now();
    if (!QuickJsScriptRuntime.isPureExpressionCandidate(candidate.expression)) {
      item.status = QuickJsRegressionStatus.EXCLUDED;
      item.routable = false;
      item.elapsedMs = Math.max(0, Date.now() - startedAt);
      return item;
    }
    for (const fixture of fixtures) {
      const bindings = this.bindings(candidate.expression, fixture.value);
      const legacy = new JsRuntime();
      for (const key of Object.keys(bindings)) legacy.setVar(key, String(bindings[key]));
      const resultValue = String(bindings['result'] || '');
      const legacyValue = legacy.evaluateWithoutShadow(candidate.expression, resultValue);
      const quick = await submitter.execute(candidate.expression, JSON.stringify(bindings), 120);
      if (!quick.success || quick.timedOut) {
        item.status = QuickJsRegressionStatus.QUICK_FAILURE;
        item.fixture = fixture.name;
        item.legacyPreview = this.preview(legacyValue);
        item.error = quick.error || (quick.timedOut ? 'timeout' : 'QuickJS 执行失败');
        item.errorCategory = QuickJsRegressionIssueCategory.classify(item.error, quick.timedOut);
        item.elapsedMs = Math.max(0, Date.now() - startedAt);
        return item;
      }
      if (quick.value !== legacyValue) {
        item.status = QuickJsRegressionStatus.MISMATCH;
        item.errorCategory = QuickJsRegressionIssueCategory.SEMANTIC_MISMATCH;
        item.fixture = fixture.name;
        item.legacyPreview = this.preview(legacyValue);
        item.quickPreview = this.preview(quick.value);
        item.elapsedMs = Math.max(0, Date.now() - startedAt);
        return item;
      }
    }
    item.status = QuickJsRegressionStatus.MATCH;
    item.elapsedMs = Math.max(0, Date.now() - startedAt);
    return item;
  }

  private defaultFixtures(): RegressionFixture[] {
    // Field `result`/`src` values are strings in the production routing path, including numeric
    // and JSON content. Supplying a number here produced false failures for String methods.
    return [new RegressionFixture('数值', '42'), new RegressionFixture('文本', 'hello world'),
      new RegressionFixture('JSON', '{"id":7,"name":"demo","enabled":true}')];
  }

  private fixtureByName(name: string): RegressionFixture | null {
    return this.defaultFixtures().find((item: RegressionFixture): boolean => item.name === name) || null;
  }

  private bindings(expression: string, fixture: string | number | boolean):
    Record<string, number | string | boolean> {
    const bindings: Record<string, number | string | boolean> = {};
    const value = fixture;
    bindings['result'] = value;
    bindings['src'] = value;
    bindings['baseUrl'] = 'https://example.com/book/1';
    bindings['key'] = 'demo';
    bindings['keyword'] = 'demo';
    bindings['searchKey'] = 'demo';
    bindings['page'] = 2;
    bindings['pageNo'] = 2;
    const code = this.stripStrings(expression);
    const identifiers = code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
    const globals = ['true', 'false', 'null', 'undefined', 'JSON', 'Math', 'String', 'Number', 'Boolean',
      'Array', 'Object', 'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'encodeURI',
      'decodeURIComponent', 'decodeURI', 'Infinity', 'NaN'];
    for (const identifier of identifiers) {
      // The lightweight reference runtime cannot safely substitute identifiers containing '$'.
      // Leave those unbound so QuickJS reports them as unsupported instead of producing a false mismatch.
      if (identifier.includes('$')) continue;
      if (globals.includes(identifier) || Object.prototype.hasOwnProperty.call(bindings, identifier)) continue;
      if (new RegExp(`\\.${identifier}\\b`).test(code)) continue;
      if (new RegExp(`\\b${identifier}\\s*\\(`).test(code)) continue;
      bindings[identifier] = value;
    }
    return bindings;
  }

  private extractExpressions(rule: string, standaloneRoutable: boolean): RegressionExpression[] {
    const results: RegressionExpression[] = [];
    const add = (value: string, routable: boolean): void => {
      const normalized = (value || '').trim().replace(/^return\s+/, '').replace(/;\s*$/, '').trim();
      if (!normalized) return;
      const existing = results.find((item: RegressionExpression): boolean => item.expression === normalized);
      if (existing) { existing.routable = existing.routable || routable; return; }
      results.push(new RegressionExpression(normalized, routable));
    };
    const exactTag = rule.match(/^\s*<js>([\s\S]*?)<\/js>\s*$/i);
    if (exactTag && exactTag[1]) add(exactTag[1], standaloneRoutable);
    const exactPrefix = rule.match(/^\s*@?js:\s*([\s\S]+)$/i);
    if (exactPrefix && exactPrefix[1]) add(exactPrefix[1], standaloneRoutable);
    const template = /\{\{([\s\S]*?)\}\}/g;
    let templateMatch: RegExpExecArray | null = null;
    while ((templateMatch = template.exec(rule)) !== null) {
      if (templateMatch[1]) add(templateMatch[1], false);
    }
    if (!exactPrefix) {
      const suffixIndex = this.findPostProcessor(rule);
      if (suffixIndex >= 0) {
        const suffix = rule.substring(suffixIndex + 4).trim();
        if (suffix && !suffix.includes('##')) add(suffix, false);
      }
    }
    return results;
  }

  private findPostProcessor(rule: string): number {
    let depth = 0;
    for (let index = 0; index < rule.length - 3; index++) {
      if (rule.substring(index, index + 2) === '{{') { depth++; index++; continue; }
      if (rule.substring(index, index + 2) === '}}' && depth > 0) { depth--; index++; continue; }
      if (depth === 0 && rule.substring(index, index + 4).toLowerCase() === '@js:') return index;
    }
    return -1;
  }

  private fields(source: BookSource): RegressionField[] {
    const fields: RegressionField[] = [];
    const searchRules = (source.searchRule || {}) as unknown as Record<string, Object>;
    const exploreRules = (source.exploreRule || {}) as unknown as Record<string, Object>;
    const bookInfoRules = (source.bookInfoRule || {}) as unknown as Record<string, Object>;
    const tocRules = (source.tocRule || {}) as unknown as Record<string, Object>;
    const contentRules = (source.contentRule || {}) as unknown as Record<string, Object>;
    const add = (stage: string, name: string, rule: string): void => {
      fields.push(new RegressionField(stage, name, rule));
    };
    add(QuickJsRegressionStage.SEARCH, 'searchUrl', source.searchUrl);
    add(QuickJsRegressionStage.EXPLORE, 'exploreUrl', source.exploreUrl);
    for (const name of ['bookList', 'name', 'author', 'coverUrl', 'intro', 'kind', 'status',
      'lastChapter', 'bookUrl', 'wordCount']) {
      add(QuickJsRegressionStage.SEARCH, `search.${name}`,
        String(searchRules[name] || ''));
      add(QuickJsRegressionStage.EXPLORE, `explore.${name}`,
        String(exploreRules[name] || ''));
    }
    for (const name of ['init', 'name', 'author', 'coverUrl', 'intro', 'kind', 'lastChapter',
      'wordCount', 'updateTime', 'tocUrl']) {
      add(QuickJsRegressionStage.BOOK_INFO, `bookInfo.${name}`,
        String(bookInfoRules[name] || ''));
    }
    for (const name of ['chapterList', 'chapterName', 'chapterUrl', 'nextTocUrl', 'isVip',
      'isPay', 'updateTime', 'chapterListAddition']) {
      add(QuickJsRegressionStage.TOC, `toc.${name}`,
        String(tocRules[name] || ''));
    }
    for (const name of ['content', 'title', 'images', 'nextContentUrl', 'replaceRegex',
      'imageDecode', 'imageStyle', 'payAction']) {
      add(QuickJsRegressionStage.CONTENT, `content.${name}`,
        String(contentRules[name] || ''));
    }
    return fields;
  }

  private stripStrings(value: string): string {
    return (value || '').replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '');
  }

  private preview(value: string): string {
    const text = String(value || '').replace(/[\r\n]+/g, ' ');
    return text.length > 120 ? `${text.substring(0, 120)}…` : text;
  }
}
