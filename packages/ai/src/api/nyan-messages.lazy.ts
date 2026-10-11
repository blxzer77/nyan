import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const nyanMessagesApi = (): ProviderStreams => lazyApi(() => import("./nyan-messages.ts"));
