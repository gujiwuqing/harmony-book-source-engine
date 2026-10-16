import { Context } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import fs from '@ohos.file.fs';
import { QuickJsRegressionIssueCategory, QuickJsRegressionItemResult, QuickJsRegressionReplayCase,
  QuickJsRegressionReport, QuickJsRegressionStatus } from './QuickJsRegressionRunner';

export class QuickJsRegressionFixtureRecord {
  sourceUrl: string = '';
  sourceName: string = '';
  stage: string = '';
  field: string = '';
  fingerprint: string = '';
  expression: string = '';
  routable: boolean = false;
  status: string = QuickJsRegressionStatus.QUICK_FAILURE;
  fixture: string = '';
  errorCategory: string = QuickJsRegressionIssueCategory.RUNTIME;
  legacyPreview: string = '';
  quickPreview: string = '';
  error: string = '';
  occurrences: number = 0;
  resolved: boolean = false;
  firstSeenAt: number = 0;
  lastCheckedAt: number = 0;
}

export class QuickJsRegressionArtifactSnapshot {
  updatedAt: number = 0;
  fixtures: QuickJsRegressionFixtureRecord[] = [];
}

/**
 * App-private compatibility fixtures. Exact expressions never leave this file through the export API; exported
 * diagnostics contain a stable redacted expression plus value hashes and lengths only.
 */
export class QuickJsRegressionArtifactStore {
  private static readonly FILE_NAME: string = 'quickjs_regression_fixtures_v1.json';
  private static readonly MAX_FIXTURES: number = 300;
  private static readonly MAX_FILE_BYTES: number = 4 * 1024 * 1024;
  private static state: QuickJsRegressionArtifactSnapshot = new QuickJsRegressionArtifactSnapshot();
  private static initialized: boolean = false;

  static async initialize(context: Context): Promise<void> {
    if (QuickJsRegressionArtifactStore.initialized) return;
    QuickJsRegressionArtifactStore.initialized = true;
    const path = QuickJsRegressionArtifactStore.path(context);
    try {
      if (!fs.accessSync(path)) return;
      const stat = await fs.stat(path);
      if (stat.size <= 0 || stat.size > QuickJsRegressionArtifactStore.MAX_FILE_BYTES) return;
      const file = await fs.open(path, fs.OpenMode.READ_ONLY);
      try {
        const buffer = new ArrayBuffer(stat.size);
        const read = await fs.read(file.fd, buffer, { offset: 0, length: stat.size });
        if (read > 0) {
          const text = new util.TextDecoder('utf-8').decodeToString(new Uint8Array(buffer, 0, read));
          QuickJsRegressionArtifactStore.state = QuickJsRegressionArtifactStore.parse(text);
        }
      } finally {
        await fs.close(file);
      }
    } catch (_) {
      QuickJsRegressionArtifactStore.state = new QuickJsRegressionArtifactSnapshot();
    }
    QuickJsRegressionArtifactStore.publish();
  }

  static snapshot(): QuickJsRegressionArtifactSnapshot {
    return QuickJsRegressionArtifactStore.parse(JSON.stringify(QuickJsRegressionArtifactStore.state));
  }

  static unresolved(): QuickJsRegressionFixtureRecord[] {
    return QuickJsRegressionArtifactStore.snapshot().fixtures.filter(
      (item: QuickJsRegressionFixtureRecord): boolean => !item.resolved && !!item.expression);
  }

  static replayCases(): QuickJsRegressionReplayCase[] {
    return QuickJsRegressionArtifactStore.unresolved().map((item: QuickJsRegressionFixtureRecord) => {
      const result = new QuickJsRegressionReplayCase();
      result.sourceUrl = item.sourceUrl;
      result.sourceName = item.sourceName;
      result.stage = item.stage;
      result.field = item.field;
      result.expression = item.expression;
      result.fingerprint = item.fingerprint;
      result.routable = item.routable;
      result.fixture = item.fixture;
      return result;
    });
  }

  static categoryCounts(unresolvedOnly: boolean = true): Record<string, number> {
    const result: Record<string, number> = {};
    for (const item of QuickJsRegressionArtifactStore.state.fixtures) {
      if (unresolvedOnly && item.resolved) continue;
      const category = item.errorCategory || QuickJsRegressionIssueCategory.RUNTIME;
      result[category] = (result[category] || 0) + 1;
    }
    return result;
  }

  static async mergeReport(context: Context, report: QuickJsRegressionReport): Promise<void> {
    await QuickJsRegressionArtifactStore.initialize(context);
    const now = Date.now();
    for (const item of report.items) {
      const key = QuickJsRegressionArtifactStore.itemKey(item);
      let existing = QuickJsRegressionArtifactStore.state.fixtures.find(
        (candidate: QuickJsRegressionFixtureRecord): boolean =>
          QuickJsRegressionArtifactStore.recordKey(candidate) === key) || null;
      if (item.status === QuickJsRegressionStatus.MATCH || item.status === QuickJsRegressionStatus.EXCLUDED) {
        if (existing) {
          existing.resolved = true;
          existing.status = item.status;
          existing.lastCheckedAt = now;
        }
        continue;
      }
      if (!existing) {
        existing = new QuickJsRegressionFixtureRecord();
        existing.sourceUrl = item.sourceUrl;
        existing.sourceName = item.sourceName;
        existing.stage = item.stage;
        existing.field = item.field;
        existing.fingerprint = item.fingerprint;
        existing.firstSeenAt = now;
        QuickJsRegressionArtifactStore.state.fixtures.push(existing);
      }
      existing.expression = item.expression;
      existing.routable = item.routable;
      existing.status = item.status;
      existing.fixture = item.fixture;
      existing.errorCategory = item.errorCategory || QuickJsRegressionIssueCategory.RUNTIME;
      existing.legacyPreview = item.legacyPreview;
      existing.quickPreview = item.quickPreview;
      existing.error = item.error;
      existing.occurrences++;
      existing.resolved = false;
      existing.lastCheckedAt = now;
    }
    QuickJsRegressionArtifactStore.state.updatedAt = now;
    QuickJsRegressionArtifactStore.trim();
    QuickJsRegressionArtifactStore.publish();
    await QuickJsRegressionArtifactStore.flush(context);
  }

  static buildExportJson(report: QuickJsRegressionReport): string {
    const categoryCounts = QuickJsRegressionArtifactStore.categoryCounts(true);
    const issues: Object[] = [];
    for (const item of QuickJsRegressionArtifactStore.state.fixtures) {
      if (item.resolved) continue;
      issues.push({
        sourceName: item.sourceName,
        sourceUrl: QuickJsRegressionArtifactStore.safeSourceUrl(item.sourceUrl),
        stage: item.stage,
        field: item.field,
        fingerprint: item.fingerprint,
        status: item.status,
        category: item.errorCategory,
        categoryLabel: QuickJsRegressionIssueCategory.label(item.errorCategory),
        fixture: item.fixture,
        expression: QuickJsRegressionArtifactStore.redactExpression(item.expression),
        legacy: QuickJsRegressionArtifactStore.valueSummary(item.legacyPreview),
        quickJs: QuickJsRegressionArtifactStore.valueSummary(item.quickPreview),
        error: QuickJsRegressionArtifactStore.redactError(item.error),
        occurrences: item.occurrences,
        firstSeenAt: item.firstSeenAt,
        lastCheckedAt: item.lastCheckedAt
      });
    }
    const payload: Object = {
      schemaVersion: 1,
      generatedAt: Date.now(),
      privacy: 'No cookies, runtime bindings, result plaintext or exact source expressions are exported.',
      currentRun: {
        total: report.totalCandidates,
        completed: report.completedCandidates,
        matches: report.matchCount,
        mismatches: report.mismatchCount,
        failures: report.failureCount,
        excluded: report.excludedCount,
        truncated: report.truncatedCount,
        elapsedMs: report.elapsedMs,
        cancelled: report.cancelled,
        error: QuickJsRegressionArtifactStore.redactError(report.error)
      },
      unresolvedCount: issues.length,
      categoryCounts: categoryCounts,
      issues: issues
    };
    return JSON.stringify(payload, null, 2);
  }

  private static itemKey(item: QuickJsRegressionItemResult): string {
    return `${item.sourceUrl}\n${item.stage}\n${item.field}\n${item.fingerprint}`;
  }

  private static recordKey(item: QuickJsRegressionFixtureRecord): string {
    return `${item.sourceUrl}\n${item.stage}\n${item.field}\n${item.fingerprint}`;
  }

  private static path(context: Context): string {
    return `${context.filesDir}/${QuickJsRegressionArtifactStore.FILE_NAME}`;
  }

  private static async flush(context: Context): Promise<void> {
    const text = JSON.stringify(QuickJsRegressionArtifactStore.state);
    const bytes = new util.TextEncoder().encodeInto(text);
    const file = await fs.open(QuickJsRegressionArtifactStore.path(context),
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      await fs.write(file.fd, bytes.buffer, { offset: 0, length: bytes.byteLength });
    } finally {
      await fs.close(file);
    }
  }

  private static trim(): void {
    if (QuickJsRegressionArtifactStore.state.fixtures.length <= QuickJsRegressionArtifactStore.MAX_FIXTURES) return;
    QuickJsRegressionArtifactStore.state.fixtures.sort(
      (a: QuickJsRegressionFixtureRecord, b: QuickJsRegressionFixtureRecord): number => {
        if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
        return b.lastCheckedAt - a.lastCheckedAt;
      });
    QuickJsRegressionArtifactStore.state.fixtures = QuickJsRegressionArtifactStore.state.fixtures.slice(
      0, QuickJsRegressionArtifactStore.MAX_FIXTURES);
  }

  private static parse(raw: string): QuickJsRegressionArtifactSnapshot {
    const result = new QuickJsRegressionArtifactSnapshot();
    try {
      const value = JSON.parse(raw || '{}') as Record<string, Object>;
      result.updatedAt = Number(value['updatedAt'] || 0);
      const fixtures = value['fixtures'];
      if (Array.isArray(fixtures)) {
        for (const rawItem of fixtures as Record<string, Object>[]) {
          const item = new QuickJsRegressionFixtureRecord();
          item.sourceUrl = String(rawItem['sourceUrl'] || '');
          item.sourceName = String(rawItem['sourceName'] || '');
          item.stage = String(rawItem['stage'] || '');
          item.field = String(rawItem['field'] || '');
          item.fingerprint = String(rawItem['fingerprint'] || '');
          item.expression = String(rawItem['expression'] || '');
          item.routable = rawItem['routable'] === true;
          item.status = String(rawItem['status'] || QuickJsRegressionStatus.QUICK_FAILURE);
          item.fixture = String(rawItem['fixture'] || '');
          item.errorCategory = String(rawItem['errorCategory'] || QuickJsRegressionIssueCategory.RUNTIME);
          item.legacyPreview = String(rawItem['legacyPreview'] || '');
          item.quickPreview = String(rawItem['quickPreview'] || '');
          item.error = String(rawItem['error'] || '');
          item.occurrences = Number(rawItem['occurrences'] || 0);
          item.resolved = rawItem['resolved'] === true;
          item.firstSeenAt = Number(rawItem['firstSeenAt'] || 0);
          item.lastCheckedAt = Number(rawItem['lastCheckedAt'] || 0);
          if (item.sourceUrl && item.fingerprint && item.expression) result.fixtures.push(item);
        }
      }
    } catch (_) {}
    return result;
  }

  private static publish(): void {
    AppStorage.setOrCreate('quickJsRegressionArtifactRevision', Date.now());
  }

  private static safeSourceUrl(value: string): string {
    const query = value.indexOf('?');
    const hash = value.indexOf('#');
    let end = value.length;
    if (query >= 0) end = Math.min(end, query);
    if (hash >= 0) end = Math.min(end, hash);
    return value.substring(0, end);
  }

  private static redactExpression(value: string): string {
    return (value || '').replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, (literal: string): string =>
      `'[string:${QuickJsRegressionArtifactStore.hash(literal)}:${literal.length}]'`);
  }

  private static redactError(value: string): string {
    return (value || '').replace(/https?:\/\/[^\s'"<>]+/gi, '<url>')
      .replace(/\b(token|cookie|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
      .substring(0, 240);
  }

  private static valueSummary(value: string): Object {
    return { length: (value || '').length, digest: QuickJsRegressionArtifactStore.hash(value || '') };
  }

  private static hash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}
