import { filesAdapter, type Adapter } from "../reconciler/apply.ts";
import { identityAdapter } from "./identity/adapter.ts";
import { jobsAdapter } from "./jobs/adapter.ts";
import { providerConfigAdapter } from "./provider-config/adapter.ts";

export function engineAdapters(): Adapter[] {
  return [filesAdapter, providerConfigAdapter(), jobsAdapter(), identityAdapter()];
}
