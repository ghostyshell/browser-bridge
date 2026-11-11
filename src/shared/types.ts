/** Payloads shared by the CLI, the daemon and the extension. */

export type Result<T> = { ok: true; result: T; ms?: number } | { ok: false; error: BridgeFailure; ms?: number };

export interface BridgeFailure {
  code: string;
  message: string;
}

export interface TabDescriptor {
  tabId: number;
  windowId: number;
  groupId: number;
  url: string;
  title: string;
  active: boolean;
  status: string;
  loading: boolean;
}

export interface SnapshotElement {
  ref: number;
  role: string;
  name: string;
  value: string;
  href: string;
  state: string[];
  inViewport: boolean;
  tag: string;
  bbox: [number, number, number, number];
}

export interface SnapshotResult {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    dpr: number;
    scrollY: number;
    scrollHeight: number;
    scrollPct: number;
  };
  summary: {
    links: number;
    inputs: number;
    forms: number;
    iframes: number;
    images: number;
    truncated: boolean;
  };
  elements: SnapshotElement[];
  lines: string[];
  text: string;
}

/** Returned when the page navigated out from under an action. */
export interface NavigationResult {
  navigated: boolean;
  uncertain?: boolean;
  url: string;
  title: string;
  note: string;
}

export interface StatusResult {
  version: string;
  connected: boolean;
  autoAllow: boolean;
  allowedOrigins: string[];
  pendingOrigin: { origin: string; url: string; tabId: number | null; at: number } | null;
  groups: Array<{ windowId: number; groupId: number }>;
  agentTabs: TabDescriptor[];
  /** Present on popup `state` messages. */
  tabs?: TabDescriptor[];
}

export interface HealthResult {
  ok: true;
  version: string;
  pid: number;
  uptime: number;
  extensionConnected: boolean;
  extensionClients: number;
  extension: ExtensionInfo | null;
  port: number;
}

export interface ExtensionInfo {
  version: string;
  ua: string;
  extensionId: string;
  since: number;
}

export interface Settings {
  allowedOrigins: string[];
  autoAllow: boolean;
  pendingOrigin: StatusResult['pendingOrigin'];
}

/** Things the page agent can be asked to do. */
export type PageAction =
  | 'snapshot'
  | 'click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'hover'
  | 'select'
  | 'wait'
  | 'find'
  | 'text'
  | 'links'
  | 'query'
  | 'viewport'
  | 'ping';

export interface PageParams {
  tabId?: number;
  ref?: string;
  selector?: string;
  /** Search text, or `false` to suppress the text block in a snapshot. */
  text?: string | boolean;
  index?: number;
  values?: string[];
  value?: string;
  keys?: string;
  key?: string;
  direction?: string;
  amount?: number;
  block?: ScrollLogicalPosition;
  timeout?: number;
  gone?: boolean;
  idle?: boolean;
  url?: string;
  query?: string;
  limit?: number;
  attrs?: string[];
  maxElements?: number;
  textLength?: number;
  clear?: boolean;
  submit?: boolean;
  slow?: number;
  waitMs?: number;
}

export interface Envelope<T = unknown> {
  __bb: 1;
  action: PageAction;
  params?: PageParams;
  result?: T;
  ok?: boolean;
  error?: string;
  code?: string;
}
