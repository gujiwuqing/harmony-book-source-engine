import taskpool from '@ohos.taskpool';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { QuickJsExpressionResult, QuickJsScriptRuntime } from './QuickJsScriptRuntime';
import { QuickJsAsyncExecutionResult, QuickJsAsyncSubmitter, QuickJsRuntimeStatus,
  QuickJsObservationContext, QuickJsShadowSubmitter } from './QuickJsRuntimeStatus';
import { QuickJsMigrationStore } from './QuickJsMigrationStore';
import { QuickJsValidationEvent, QuickJsValidationStore } from './QuickJsValidationStore';

/** Pure TaskPool entry: no UI, database, network, Cookie or filesystem access is exposed. */
@Concurrent
function executeQuickJsTask(expression: string, variablesJson: string, timeoutMs: number): string {
  let variables: Record<string, Object> = {};
  try {
    const parsed = JSON.parse(variablesJson || '{}') as Record<string, Object>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-bindings');
    variables = parsed;
  } catch (_) {
    const invalid = new QuickJsExpressionResult();
    invalid.error = 'invalid-bindings';
    return JSON.stringify(invalid);
  }
  return JSON.stringify(QuickJsScriptRuntime.evaluateExpression(expression, variables, timeoutMs));
}

export class QuickJsTaskPoolExecutor implements QuickJsAsyncSubmitter {
  execute(expression: string, variablesJson: string,
    timeoutMs: number = 80): Promise<QuickJsAsyncExecutionResult> {
    return QuickJsTaskPoolExecutor.run(expression, variablesJson, timeoutMs);
  }

  static async run(expression: string, variablesJson: string,
    timeoutMs: number = 80): Promise<QuickJsAsyncExecutionResult> {
    try {
      const raw = await taskpool.execute(executeQuickJsTask, expression, variablesJson,
        Math.max(10, Math.min(250, timeoutMs)));
      return QuickJsTaskPoolExecutor.parseResult(String(raw || ''));
    } catch (error) {
      const result = new QuickJsExpressionResult();
      result.error = error instanceof Error ? error.message : String(error || 'taskpool-failed');
      return result;
    }
  }

  static parseResult(raw: string): QuickJsExpressionResult {
    const result = new QuickJsExpressionResult();
    try {
      const parsed = JSON.parse(raw || '{}') as Record<string, Object>;
      result.success = parsed['success'] === true;
      result.value = String(parsed['value'] || '');
      result.error = String(parsed['error'] || '');
      result.timedOut = parsed['timedOut'] === true;
      result.elapsedMs = Number(parsed['elapsedMs'] || 0);
    } catch (_) {
      result.error = 'invalid-task-result';
    }
    return result;
  }
}

export class QuickJsShadowExecutor implements QuickJsShadowSubmitter {
  private static readonly DOMAIN: number = 0x0000;
  private static readonly TAG: string = 'QuickJSShadow';
  private static readonly MAX_IN_FLIGHT: number = 4;
  private inFlight: number = 0;
  private completed: number = 0;
  private matches: number = 0;
  private mismatches: number = 0;
  private failures: number = 0;

  static install(): void {
    QuickJsRuntimeStatus.setShadowSubmitter(new QuickJsShadowExecutor());
    QuickJsRuntimeStatus.setAsyncSubmitter(new QuickJsTaskPoolExecutor());
  }

  submit(expression: string, variablesJson: string, legacyValue: string,
    fingerprint: string, sample: number, observation: QuickJsObservationContext | null): boolean {
    if (this.inFlight >= QuickJsShadowExecutor.MAX_IN_FLIGHT) return false;
    this.inFlight++;
    taskpool.execute(executeQuickJsTask, expression, variablesJson, 80)
      .then((raw: Object): void => {
        const result = QuickJsTaskPoolExecutor.parseResult(String(raw || ''));
        this.record(result, legacyValue, fingerprint, sample, observation);
      })
      .catch((error: Error): void => {
        const result = new QuickJsExpressionResult();
        result.error = error.message || 'taskpool-failed';
        this.record(result, legacyValue, fingerprint, sample, observation);
      })
      .finally((): void => {
        this.inFlight = Math.max(0, this.inFlight - 1);
      });
    return true;
  }

  private record(result: QuickJsExpressionResult, legacyValue: string,
    fingerprint: string, sample: number, observation: QuickJsObservationContext | null): void {
    this.completed++;
    let validationEvent: QuickJsValidationEvent = 'shadow-failure';
    if (!result.success) {
      this.failures++;
      QuickJsMigrationStore.record('shadow-failure', fingerprint, result.elapsedMs);
      hilog.warn(QuickJsShadowExecutor.DOMAIN, QuickJsShadowExecutor.TAG,
        'sample=%{public}d id=%{public}s status=error timeout=%{public}s elapsed=%{public}d',
        sample, fingerprint, `${result.timedOut}`, result.elapsedMs);
    } else if (result.value === legacyValue) {
      validationEvent = 'shadow-match';
      this.matches++;
      QuickJsMigrationStore.record('shadow-match', fingerprint, result.elapsedMs);
      hilog.info(QuickJsShadowExecutor.DOMAIN, QuickJsShadowExecutor.TAG,
        'sample=%{public}d id=%{public}s status=match elapsed=%{public}d',
        sample, fingerprint, result.elapsedMs);
    } else {
      validationEvent = 'shadow-mismatch';
      this.mismatches++;
      QuickJsMigrationStore.record('shadow-mismatch', fingerprint, result.elapsedMs);
      hilog.warn(QuickJsShadowExecutor.DOMAIN, QuickJsShadowExecutor.TAG,
        'sample=%{public}d id=%{public}s status=mismatch legacyLen=%{public}d quickLen=%{public}d',
        sample, fingerprint, legacyValue.length, result.value.length);
    }
    QuickJsValidationStore.record(validationEvent, fingerprint, observation);
    hilog.info(QuickJsShadowExecutor.DOMAIN, QuickJsShadowExecutor.TAG,
      'summary completed=%{public}d matches=%{public}d mismatches=%{public}d failures=%{public}d inFlight=%{public}d',
      this.completed, this.matches, this.mismatches, this.failures, this.inFlight);
  }
}
