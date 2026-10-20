/*
 * Copyright (c) 2026 legado-harmony contributors
 * SPDX-License-Identifier: MIT
 */

import type { ScriptSessionOutcome } from 'libquickjs.so';
import qjs from './NativeQuickJs';

export class JSScriptSessionOptions {
  memoryLimitBytes: number = 32 * 1024 * 1024;
  stackLimitBytes: number = 1024 * 1024;
  /** Longest a single host call may take before the script sees an error. */
  hostTimeoutMs: number = 60000;
}

export class JSScriptEvalResult {
  success: boolean = false;
  value: string = '';
  error: string = '';
  timedOut: boolean = false;
  cancelled: boolean = false;
  cpuMs: number = 0;
  wallMs: number = 0;
  hostWaitMs: number = 0;
  hostCalls: number = 0;
}

/** Answers `__host(name, payload)` from the script thread. May finish asynchronously. */
export type JSScriptHostHandler = (name: string, payload: string) => Promise<string> | string;

/**
 * A QuickJS runtime on its own background thread. Globals persist across evaluate() calls until
 * release(). Scripts call `__host(name, payload)` synchronously; the handler runs on this (the
 * ArkTS) thread and the script thread waits for its answer, so a busy script never blocks the UI.
 */
export class JSScriptSession {
  private id: number = 0;
  private handler: JSScriptHostHandler;

  constructor(handler: JSScriptHostHandler, options?: JSScriptSessionOptions) {
    const config = options || new JSScriptSessionOptions();
    this.handler = handler;
    this.id = qjs.scriptSessionCreate(config.memoryLimitBytes, config.stackLimitBytes, config.hostTimeoutMs,
      (callId: number, name: string, payload: string): void => this.dispatch(callId, name, payload));
  }

  get released(): boolean {
    return this.id === 0;
  }

  /** Runs `code` on the script thread. cpuTimeoutMs excludes time spent waiting for the host. */
  async evaluate(code: string, sourceName: string = 'script.js', cpuTimeoutMs: number = 1000): Promise<JSScriptEvalResult> {
    const result = new JSScriptEvalResult();
    if (this.id === 0) {
      result.cancelled = true;
      result.error = 'script session released';
      return result;
    }
    const outcome: ScriptSessionOutcome = await qjs.scriptSessionEval(this.id, code, sourceName, cpuTimeoutMs);
    result.success = outcome.success;
    result.value = outcome.value;
    result.error = outcome.error;
    result.timedOut = outcome.timedOut;
    result.cancelled = outcome.cancelled;
    result.cpuMs = outcome.cpuMs;
    result.wallMs = outcome.wallMs;
    result.hostWaitMs = outcome.hostWaitMs;
    result.hostCalls = outcome.hostCalls;
    return result;
  }

  /** Aborts the running script and everything queued so far; later evaluate() calls run normally. */
  cancel(): void {
    if (this.id !== 0) qjs.scriptSessionCancel(this.id);
  }

  /** Stops the thread and frees the runtime. Pending evaluations settle as cancelled. */
  release(): void {
    if (this.id === 0) return;
    qjs.scriptSessionRelease(this.id);
    this.id = 0;
  }

  private dispatch(callId: number, name: string, payload: string): void {
    const sessionId = this.id;
    const answer = (ok: boolean, text: string): void => {
      if (sessionId !== 0) qjs.scriptSessionResolve(sessionId, callId, ok, text);
    };
    let reply: Promise<string> | string;
    try {
      reply = this.handler(name, payload);
    } catch (error) {
      answer(false, JSScriptSession.message(error));
      return;
    }
    if (reply instanceof Promise) {
      reply.then((text: string): void => answer(true, text === undefined || text === null ? '' : String(text)))
        .catch((error: Object): void => answer(false, JSScriptSession.message(error)));
    } else {
      answer(true, reply === undefined || reply === null ? '' : String(reply));
    }
  }

  private static message(error: Object): string {
    if (error instanceof Error) return error.message || String(error);
    return String(error);
  }
}
