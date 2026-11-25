import type { Store } from './store.ts'

export type Env = {
  Bindings: {
    STORE: DurableObjectNamespace<Store>
  }
}
