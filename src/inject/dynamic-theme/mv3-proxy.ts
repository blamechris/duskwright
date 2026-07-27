import {logInfo} from '../utils/log';

import {injectProxy} from './stylesheet-proxy';

document.currentScript && document.currentScript.remove();

// ADR 0001 item 9: this handshake used to be `document.documentElement.dataset
// .darkreaderProxyInjected = 'true'` — an attribute write on <html>, which is page-owned and
// serializes into the page's own markup.
//
// It exists because this script can run more than once in the MAIN world (the registered
// content script and the dedicated injector race), and two separate script executions share
// no module scope, so the "already injected" flag needs a channel that outlives one
// execution. A Symbol-keyed property on the MAIN-world global is that channel: it is not a
// DOM node, not an attribute, fires no MutationRecord, and cannot be serialized into the
// document — while still being visible to both executions.
const INJECTED_FLAG = Symbol.for('__darkreader__proxyInjected');

function isProxyInjected(): boolean {
    return (globalThis as any)[INJECTED_FLAG] === true;
}

function markProxyInjected(): void {
    Object.defineProperty(globalThis, INJECTED_FLAG, {
        value: true,
        configurable: true,
        enumerable: false,
        writable: false,
    });
}
const EVENT_DONE = '__darkreader__stylesheetProxy__done';
const EVENT_ARG = '__darkreader__stylesheetProxy__arg';

const registeredScriptPath = !document.currentScript;

function injectProxyAndCleanup(args: {enableStyleSheetsProxy: boolean; enableCustomElementRegistryProxy: boolean}) {
    injectProxy(args.enableStyleSheetsProxy, args.enableCustomElementRegistryProxy);
    doneReceiver();
    document.dispatchEvent(new CustomEvent(EVENT_DONE));
}

function regularPath() {
    const argString = document.currentScript!.dataset.arg;
    if (argString !== undefined) {
        markProxyInjected();
        const args: {enableStyleSheetsProxy: boolean; enableCustomElementRegistryProxy: boolean} = JSON.parse(argString);
        logInfo(`MV3 proxy injector: regular path runs injectProxy(${argString}).`);
        injectProxyAndCleanup(args);
    }
}

function dataReceiver(e: any) {
    document.removeEventListener(EVENT_ARG, dataReceiver);
    if (isProxyInjected()) {
        logInfo(`MV3 proxy injector: ${registeredScriptPath ? 'registered' : 'dedicated'} path exits because everything is done.`);
        return;
    }
    markProxyInjected();
    logInfo(`MV3 proxy injector: ${registeredScriptPath ? 'registered' : 'dedicated'} path runs injectProxy(${e.detail}).`);
    injectProxyAndCleanup(e.detail);
}

function doneReceiver() {
    document.removeEventListener(EVENT_ARG, dataReceiver);
    document.removeEventListener(EVENT_DONE, doneReceiver);
}

function dedicatedPath() {
    logInfo(`MV3 proxy injector: ${registeredScriptPath ? 'registered' : 'dedicated'} path setup...`);
    // TODO: use EventListenerOptions class once it is updated
    // Note: make sure capture is not set
    const listenerOptions: any = {
        passive: true,
        once: true,
    };
    document.addEventListener(EVENT_ARG, dataReceiver, listenerOptions);
    document.addEventListener(EVENT_DONE, doneReceiver, listenerOptions);
}

function inject() {
    if (isProxyInjected()) {
        logInfo('MV3 proxy injector: proxy exits because everything is done.');
        return;
    }
    logInfo('MV3 proxy injector: proxy attempts to inject...');
    document.currentScript && regularPath();
    dedicatedPath();
}

inject();
