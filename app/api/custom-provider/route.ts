import { withStore } from "@/src/server";
/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel. */
import { customProviderGet, customProviderMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = withStore(customProviderGet);
export const POST = withStore(customProviderMutation);
export const PATCH = withStore(customProviderMutation);
export const DELETE = withStore(customProviderMutation);
