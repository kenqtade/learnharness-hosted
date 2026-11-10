import { withStore } from "@/src/server";
import { subscriptionControlsResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withStore(subscriptionControlsResponse);
export const POST = withStore(subscriptionControlsResponse);
