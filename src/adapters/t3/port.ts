export type T3Rpc = {
  call<T = unknown>(tag: string, payload: unknown): Promise<T>;
  first<T = unknown>(tag: string, payload: unknown): Promise<T>;
  get<T = unknown>(path: string): Promise<T>;
};

export type T3Server = {
  answering(home: string): Promise<boolean>;
  session<T>(home: string, work: (rpc: T3Rpc) => Promise<T>): Promise<T>;
};

export type ModelSelection = { instanceId: string; model: string; options?: Array<{ id: string; value: string | boolean }> };
